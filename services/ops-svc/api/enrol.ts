/**
 * POST /api/v1/ops/enrol  — move students into a section, in bulk
 *
 * R-3 of docs/11-MASTER-PLAN.md, Parts E and F. The screen that stops an IT
 * admin assigning forty children one at a time.
 *
 * ── Preview and commit are the same request, with a flag ────────────────
 * `{ dryRun: true }` returns exactly what `{ dryRun: false }` would do, and
 * changes nothing. One code path, so the preview cannot drift from the commit
 * — which is the entire value of a preview. A separate preview endpoint would
 * be a second implementation of the roll-numbering rules, and the two would
 * disagree on the day it mattered.
 *
 * ── Moving is not overwriting ───────────────────────────────────────────
 * A student already enrolled this year is UPDATEd to the new section — same
 * enrolment row, because it is the same year and `enrolments` is UNIQUE
 * (tenant, year, student). That is the correct shape: their placement changed,
 * they did not acquire a second one. Their placement in a PREVIOUS year is a
 * different row and is never touched. The ten-year history the owner asked for
 * is made of those rows, and nothing in this file can reach them.
 *
 * ── Roll numbers are assigned, not requested ────────────────────────────
 * Rolls continue from the highest in the destination section, in the order the
 * students arrive in the request. The alternative — letting the client send
 * rolls — means the client owns a uniqueness rule the database also owns
 * (`uq_enrolment_roll`), and a collision surfaces as a constraint violation
 * with no useful message. The response says which roll each student got, so
 * the screen can show it before the school commits.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { sharedDb } from '../../../packages/server-core/src/db.ts';
import { corsHeaders, readJson, json, HttpError } from '../../../packages/server-core/src/http.ts';
import { authenticate, requireRole } from '../../../packages/server-core/src/auth.ts';
import { writeAudit } from '../../../packages/server-core/src/audit.ts';

const ENROL_ROLES = ['principal', 'school_owner', 'academic_coordinator', 'it_admin'];

/**
 * One request may move a whole section but not a whole school. Beyond this the
 * honest tool is the import wizard, which streams and reports per row; a
 * 2,000-student transaction on a serverless function is a timeout with half a
 * school in an unknown state.
 */
const MAX_MOVE = 200;

interface EnrolBody {
  sectionId?: string;
  studentIds?: string[];
  dryRun?: boolean;
}

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const cors = corsHeaders([], 'POST, OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }
  if (req.method !== 'POST') { json(res, 405, { error: 'method_not_allowed' }, cors); return; }

  try {
    const claims = await authenticate(req);
    requireRole(claims, ENROL_ROLES);

    const body = await readJson<EnrolBody>(req);
    const sectionId = body.sectionId?.trim();
    const studentIds = [...new Set((body.studentIds ?? []).map((s) => String(s).trim()).filter(Boolean))];
    const dryRun = body.dryRun !== false;   // preview unless explicitly told otherwise

    if (!sectionId) throw new HttpError(400, 'সেকশন বেছে নিন', 'bad_request', { field: 'sectionId' });
    if (studentIds.length === 0) {
      throw new HttpError(400, 'কোনো শিক্ষার্থী বেছে নেওয়া হয়নি', 'bad_request', { field: 'studentIds' });
    }
    if (studentIds.length > MAX_MOVE) {
      throw new HttpError(400,
        `একবারে সর্বোচ্চ ${MAX_MOVE} জন — বেশি হলে আমদানি ব্যবহার করুন`,
        'too_many', { field: 'studentIds' });
    }

    const db = await sharedDb();
    const ctx = { tenantId: claims.tid, userId: claims.sub, role: claims.role };

    const result = await db.withTenant(ctx, async (c) => {
      const { rows: sec } = await c.query<{
        id: string; name: string; capacity: number; student_count: number;
        year_id: string; year_label: string; class_bn: string; group: string;
      }>(
        `SELECT s.id, s.name, s.capacity, s.student_count,
                ay.id AS year_id, ay.label AS year_label,
                cl.name_bn AS class_bn, cl."group"::text AS "group"
           FROM sections s
           JOIN academic_years ay ON ay.id = s.academic_year_id
           JOIN classes cl        ON cl.id = s.class_id
          WHERE s.id = $1`,
        [sectionId],
      );
      if (sec.length === 0) throw new HttpError(404, 'সেকশন পাওয়া যায়নি', 'not_found');
      const section = sec[0];

      // What each student's situation is right now. RLS makes another
      // school's student simply not appear here, which is what makes the
      // "not found" count below a real answer rather than a leak.
      const { rows: current } = await c.query<{
        student_id: string; name_bn: string; enrolment_id: string | null;
        from_section_id: string | null; from_section: string | null;
        from_class_bn: string | null; roll_no: number | null;
      }>(
        `SELECT u.id AS student_id, u.full_name_bn AS name_bn,
                e.id AS enrolment_id, e.section_id AS from_section_id,
                s.name AS from_section, cl.name_bn AS from_class_bn, e.roll_no
           FROM users u
           LEFT JOIN enrolments e
                  ON e.student_id = u.id AND e.academic_year_id = $2
                 AND e.status = 'active'
           LEFT JOIN sections s ON s.id = e.section_id
           LEFT JOIN classes cl ON cl.id = s.class_id
          WHERE u.id = ANY($1::uuid[]) AND u.status = 'active'`,
        [studentIds, section.year_id],
      );

      const found = new Set(current.map((r) => r.student_id));
      const missing = studentIds.filter((id) => !found.has(id));

      const alreadyHere = current.filter((r) => r.from_section_id === sectionId);
      const moving = current.filter((r) => r.from_section_id !== sectionId);

      const { rows: maxRoll } = await c.query<{ next: number }>(
        `SELECT COALESCE(max(roll_no), 0) + 1 AS next
           FROM enrolments WHERE section_id = $1 AND status = 'active'`,
        [sectionId],
      );

      let roll = maxRoll[0]?.next ?? 1;
      const plan = moving.map((r) => ({
        studentId: r.student_id,
        nameBn: r.name_bn,
        from: r.from_section_id
          ? { sectionId: r.from_section_id, section: r.from_section, classBn: r.from_class_bn, rollNo: r.roll_no }
          : null,
        toRollNo: roll++,
        isNewEnrolment: r.enrolment_id === null,
      }));

      const willBe = section.student_count + plan.length;
      const overCapacity = willBe > section.capacity;

      const preview = {
        section: {
          id: section.id,
          name: section.name,
          classBn: section.class_bn,
          group: section.group,
          yearLabel: section.year_label,
          capacity: section.capacity,
          currentCount: section.student_count,
          countAfter: willBe,
        },
        moving: plan,
        alreadyInSection: alreadyHere.map((r) => ({ studentId: r.student_id, nameBn: r.name_bn })),
        notFound: missing,
        // Capacity is a warning, not a refusal. Bangladeshi sections run over
        // their nominal capacity constantly, and a system that blocks the
        // move is a system the school stops using in week two. The screen
        // shows it; the person decides.
        overCapacity,
        committed: false,
      };

      if (dryRun) return preview;

      for (const p of plan) {
        if (p.isNewEnrolment) {
          await c.query(
            `INSERT INTO enrolments
               (tenant_id, student_id, section_id, academic_year_id, roll_no, status)
             VALUES ($1, $2, $3, $4, $5, 'active')`,
            [ctx.tenantId, p.studentId, sectionId, section.year_id, p.toRollNo],
          );
        } else {
          // Same row, same year: their placement changed. Previous years are
          // separate rows and are not reachable from here.
          await c.query(
            `UPDATE enrolments
                SET section_id = $1, roll_no = $2, row_version = row_version + 1
              WHERE student_id = $3 AND academic_year_id = $4 AND status = 'active'`,
            [sectionId, p.toRollNo, p.studentId, section.year_id],
          );
        }
      }

      await writeAudit(c, ctx, {
        action: 'academic.enrolment.move',
        entityType: 'section',
        entityId: sectionId,
        before: { count: section.student_count },
        after: {
          count: willBe,
          moved: plan.length,
          // Ids only, no names: the audit log is management-readable and does
          // not need to be a second copy of the roster.
          studentIds: plan.map((p) => p.studentId),
        },
      });

      return { ...preview, committed: true };
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
