/**
 * GET  /api/v1/ops/assign?sectionId=…  — who could be assigned here
 * POST /api/v1/ops/assign              — assign or replace a teacher
 *
 * R-3 of docs/11-MASTER-PLAN.md, Part D. The screen where a school decides who
 * teaches whom, and the one where it records that somebody stopped.
 *
 * ── Assignment and replacement are the same operation ───────────────────
 * There is no separate "replace" endpoint, because there is no moment when the
 * school knows in advance which one it is doing. A section either has a
 * teacher for this subject or it does not; POSTing a teacher makes them the
 * current one either way, and app.assign_subject_teacher() closes whatever was
 * open first. Two endpoints would mean a client that guessed wrong either
 * silently created a second open assignment or refused a legitimate change.
 *
 * ── The history is the product, not a side effect ───────────────────────
 * Nothing here deletes or overwrites an assignment. Migration 041 gave both
 * assignment tables a validity period precisely so that "who was teaching
 * Physics to 9-F in March" survives the replacement — that question is asked
 * in November, after a bad result, by a parent who deserves an answer better
 * than somebody's recollection.
 *
 * The endpoint therefore REQUIRES a reason when it is closing an existing
 * assignment. A history of changes with no reasons is a list of dates.
 *
 * ── Why the atomic part lives in SQL ────────────────────────────────────
 * Closing the old row and opening the new one must not be two statements from
 * here: a failure between them leaves either a subject with no teacher of
 * record, or — worse — two open rows, which the partial unique index turns
 * into an error at some unrelated later moment for somebody else. The function
 * is SECURITY INVOKER, so RLS still decides whether this caller may write.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { sharedDb } from '../../../packages/server-core/src/db.ts';
import { corsHeaders, readJson, json, query, HttpError } from '../../../packages/server-core/src/http.ts';
import { authenticate, requireRole } from '../../../packages/server-core/src/auth.ts';
import { writeAudit } from '../../../packages/server-core/src/audit.ts';

/**
 * Who may change who teaches. Mirrors cta_write_scope in migration 041 — the
 * RLS policy is the boundary, this is the clean 403 in front of it.
 *
 * A class teacher is deliberately absent. Deciding who teaches a section is
 * not something the person currently teaching it should be able to do.
 */
const ASSIGN_ROLES = ['principal', 'school_owner', 'academic_coordinator', 'it_admin'];

const MAX_REASON = 200;

interface AssignBody {
  sectionId?: string;
  subjectId?: string | null;   // absent/null → the class teacher
  teacherId?: string;
  effectiveDate?: string;      // ISO date; defaults to today
  reason?: string;
}

/** ISO date, and a real one — `new Date('2026-02-30')` is not. */
function parseEffective(raw: string | undefined): string {
  if (!raw) return new Date().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    throw new HttpError(400, 'তারিখটি বুঝতে পারিনি', 'bad_date', { field: 'effectiveDate' });
  }
  const d = new Date(`${raw}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== raw) {
    throw new HttpError(400, 'এই তারিখটি নেই', 'bad_date', { field: 'effectiveDate' });
  }
  return raw;
}

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const cors = corsHeaders([], 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }

  try {
    const claims = await authenticate(req);
    const db = await sharedDb();
    const ctx = { tenantId: claims.tid, userId: claims.sub, role: claims.role };

    if (req.method === 'GET') {
      requireRole(claims, ASSIGN_ROLES);
      const sectionId = query(req).get('sectionId');
      if (!sectionId) throw new HttpError(400, 'sectionId is required', 'bad_request');
      json(res, 200, await candidates(db, ctx, sectionId), cors);
      return;
    }

    if (req.method !== 'POST') { json(res, 405, { error: 'method_not_allowed' }, cors); return; }

    requireRole(claims, ASSIGN_ROLES);
    const body = await readJson<AssignBody>(req);

    const sectionId = body.sectionId?.trim();
    const teacherId = body.teacherId?.trim();
    const subjectId = body.subjectId?.trim() || null;
    if (!sectionId) throw new HttpError(400, 'সেকশন বেছে নিন', 'bad_request', { field: 'sectionId' });
    if (!teacherId) throw new HttpError(400, 'শিক্ষক বেছে নিন', 'bad_request', { field: 'teacherId' });

    const effective = parseEffective(body.effectiveDate);
    const reason = (body.reason ?? '').trim().slice(0, MAX_REASON) || null;

    const result = await db.withTenant(ctx, async (c) => {
      // Who holds it now, read before the change so the audit row and the
      // response can both say what actually happened rather than only what
      // was asked for.
      const { rows: before } = subjectId
        ? await c.query<{ teacher_id: string; teacher_bn: string }>(
            `SELECT sst.teacher_id, u.full_name_bn AS teacher_bn
               FROM section_subject_teachers sst
               JOIN users u ON u.id = sst.teacher_id
              WHERE sst.section_id = $1 AND sst.subject_id = $2
                AND sst.ended_on IS NULL`,
            [sectionId, subjectId],
          )
        : await c.query<{ teacher_id: string; teacher_bn: string }>(
            `SELECT cta.teacher_id, u.full_name_bn AS teacher_bn
               FROM class_teacher_assignments cta
               JOIN users u ON u.id = cta.teacher_id
              WHERE cta.section_id = $1 AND cta.ended_on IS NULL`,
            [sectionId],
          );

      const outgoing = before[0] ?? null;

      // Replacing somebody without saying why produces a history of dates.
      // A first assignment needs no reason: nobody stopped.
      if (outgoing && outgoing.teacher_id !== teacherId && !reason) {
        throw new HttpError(400,
          'পরিবর্তনের কারণ লিখুন — কে কখন দায়িত্বে ছিলেন, তা পরে জানতে হতে পারে',
          'reason_required', { field: 'reason' });
      }

      // The teacher must be a staff member of THIS school. RLS already makes
      // another school's user invisible, so this check catches the ordinary
      // mistake (a student id pasted into the teacher field) and not the
      // adversarial one, which is already impossible.
      const { rows: teacher } = await c.query<{ full_name_bn: string; is_staff: boolean }>(
        `SELECT u.full_name_bn,
                EXISTS (SELECT 1 FROM user_roles ur
                          JOIN roles r ON r.code = ur.role_code
                         WHERE ur.user_id = u.id AND r.is_staff) AS is_staff
           FROM users u
          WHERE u.id = $1 AND u.status = 'active'`,
        [teacherId],
      );
      if (teacher.length === 0) {
        throw new HttpError(404, 'শিক্ষক পাওয়া যায়নি', 'teacher_not_found', { field: 'teacherId' });
      }
      if (!teacher[0].is_staff) {
        throw new HttpError(400, 'ইনি শিক্ষক নন', 'not_staff', { field: 'teacherId' });
      }

      const { rows } = subjectId
        ? await c.query<{ id: string }>(
            `SELECT app.assign_subject_teacher($1, $2, $3, $4::date, $5) AS id`,
            [sectionId, subjectId, teacherId, effective, reason],
          )
        : await c.query<{ id: string }>(
            `SELECT app.assign_class_teacher($1, $2, $3::date, $4) AS id`,
            [sectionId, teacherId, effective, reason],
          );

      const unchanged = outgoing?.teacher_id === teacherId;
      if (!unchanged) {
        await writeAudit(c, ctx, {
          action: subjectId ? 'academic.subject_teacher.assign' : 'academic.class_teacher.assign',
          entityType: 'section',
          entityId: sectionId,
          before: outgoing ? { teacherId: outgoing.teacher_id, nameBn: outgoing.teacher_bn } : null,
          after: { teacherId, nameBn: teacher[0].full_name_bn, subjectId, effective, reason },
        });
      }

      return {
        assignmentId: rows[0]?.id ?? null,
        replaced: outgoing && !unchanged
          ? { teacherId: outgoing.teacher_id, nameBn: outgoing.teacher_bn }
          : null,
        // An honest answer for the double-submitted form: nothing happened,
        // and saying "assigned" would be a small lie the history contradicts.
        unchanged,
        teacher: { id: teacherId, nameBn: teacher[0].full_name_bn },
        effectiveDate: effective,
      };
    });

    json(res, 200, result, cors);
  } catch (err) {
    if (err instanceof HttpError) {
      json(res, err.status, { error: err.code, message: err.message, field: err.detail?.field }, cors);
      return;
    }
    json(res, 500, { error: 'internal_error' }, cors);
  }
}

type Db = Awaited<ReturnType<typeof sharedDb>>;
type Ctx = { tenantId: string; userId: string; role: string };

/**
 * The staff this section could be assigned, and the subjects it needs taught.
 * Expertise is surfaced but not enforced: a small school routinely has the
 * maths teacher taking a physics period, and a system that refuses that is a
 * system the school works around.
 */
async function candidates(db: Db, ctx: Ctx, sectionId: string) {
  return db.withTenant(ctx, async (c) => {
    const { rows: sec } = await c.query<{ class_id: string; year_id: string }>(
      `SELECT class_id, academic_year_id AS year_id FROM sections WHERE id = $1`,
      [sectionId],
    );
    if (sec.length === 0) throw new HttpError(404, 'section not found', 'not_found');

    const { rows: subjects } = await c.query<{
      id: string; name_bn: string; assigned_teacher: string | null; assigned_name: string | null;
    }>(
      `SELECT sub.id, sub.name_bn,
              sst.teacher_id AS assigned_teacher,
              u.full_name_bn AS assigned_name
         FROM class_subjects cs
         JOIN subjects sub ON sub.id = cs.subject_id
         LEFT JOIN section_subject_teachers sst
                ON sst.section_id = $1 AND sst.subject_id = sub.id
               AND sst.ended_on IS NULL
         LEFT JOIN users u ON u.id = sst.teacher_id
        WHERE cs.class_id = $2 AND cs.academic_year_id = $3
        ORDER BY sub.name_bn`,
      [sectionId, sec[0].class_id, sec[0].year_id],
    );

    const { rows: teachers } = await c.query<{
      id: string; name_bn: string; employee_code: string | null;
      subject_ids: string[]; load: number;
    }>(
      `SELECT u.id, u.full_name_bn AS name_bn, sp.employee_code,
              COALESCE(array_agg(DISTINCT tse.subject_id::text)
                       FILTER (WHERE tse.subject_id IS NOT NULL), '{}') AS subject_ids,
              (SELECT count(*)::int FROM section_subject_teachers x
                WHERE x.teacher_id = u.id AND x.ended_on IS NULL) AS load
         FROM users u
         JOIN user_roles ur ON ur.user_id = u.id
         JOIN roles r       ON r.code = ur.role_code AND r.is_staff
         LEFT JOIN staff_profiles sp            ON sp.user_id = u.id
         LEFT JOIN teacher_subject_expertise tse ON tse.teacher_id = u.id
        WHERE u.status = 'active'
        GROUP BY u.id, u.full_name_bn, sp.employee_code
        ORDER BY u.full_name_bn`,
    );

    return {
      subjects: subjects.map((s) => ({
        id: s.id,
        nameBn: s.name_bn,
        assigned: s.assigned_teacher
          ? { id: s.assigned_teacher, nameBn: s.assigned_name ?? '' }
          : null,
      })),
      teachers: teachers.map((t) => ({
        id: t.id,
        nameBn: t.name_bn,
        employeeCode: t.employee_code,
        // Current open assignments. A principal handing a sixth section to
        // somebody already carrying five should be able to see that before
        // they do it, not after the timetable fails to solve.
        currentLoad: t.load,
        expertiseSubjectIds: t.subject_ids,
      })),
    };
  });
}
