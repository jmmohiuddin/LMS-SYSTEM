/**
 * GET  /api/v1/rms/assignments?yearId=…[&classId=…]
 * POST /api/v1/rms/assignments { yearId, changes: [{ sectionId, subjectId, teacherId }] }
 *
 * Who teaches which subject in which section — the one input P9-0 found the
 * routine generator cannot work without and no school could supply.
 *
 * ── Why this endpoint is the whole of P9-1 ───────────────────────────────
 * `solve.ts:loadDemand` reads `section_subject_teachers` and nothing else to
 * decide what the timetable must contain. Every other input it consults is
 * either already writable (sections, rooms) or seeded by `provision_tenant`
 * with usable defaults (subjects, `class_subjects.periods_per_week`, the bell
 * times). This table was empty — 6 rows across 183 schools — and had no
 * writer, so a generation run would have placed nothing and correctly
 * reported everything unplaced.
 *
 * ── The shape is a MATRIX, because that is the paperwork ────────────────
 * A coordinator does not think "assignment 41 of 800". They think "class 9,
 * who is taking maths in each section?" — a subject down the page, sections
 * across it. So the GET returns exactly that grid for one class, already
 * joined to the teachers who could fill each cell, and the POST takes a batch
 * of cell edits. Eighty sections times ten subjects is eight hundred
 * decisions; asking for them one request at a time would be the difference
 * between an afternoon and a week.
 *
 * ── Closing, never deleting ─────────────────────────────────────────────
 * `section_subject_teachers` is a history table — `started_on`, `ended_on`,
 * `end_reason` — and migration 072 refuses DELETE to everybody. Changing a
 * cell therefore closes the open row and opens a new one, so a teacher's
 * record of what they taught in March survives being replaced in April. That
 * is also why `uq_sst_current` is partial on `ended_on IS NULL`: many rows
 * per cell over the years, exactly one of them current.
 *
 * Clearing a cell (`teacherId: null`) closes without reopening. The subject
 * still exists and the class still studies it; nobody is assigned yet, and
 * the generator will report it as unplaced demand rather than silently
 * skipping it — which is the honest answer and the one §8.2 wants.
 *
 * ── What it refuses, and why each refusal is here and not in the UI ─────
 * A teacher from another school (RLS would hide them anyway, so this is a
 * clear 400 rather than a confusing foreign-key error); a subject the class
 * does not study (`class_subjects` decides that, not the operator's typing);
 * a section that belongs to a different year than the one being edited. Each
 * is a mistake a fast typist makes at 3pm and none of them should reach the
 * database as a constraint violation the office cannot read.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type pg from 'pg';
import { sharedDb } from '../../../packages/server-core/src/db.ts';
import { corsHeaders, readJson, json, HttpError } from '../../../packages/server-core/src/http.ts';
import { authenticate, requireRole } from '../../../packages/server-core/src/auth.ts';

type Client = pg.PoolClient;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The same three roles migration 072 admits, and the same three that may
 * write a routine. A teaching assignment IS routine input; letting a role
 * that cannot author a timetable author what the timetable is generated from
 * would be the gate with an extra step.
 */
const ASSIGN_ROLES = ['principal', 'school_owner', 'academic_coordinator'];

/** A batch bigger than this is a mistake or a script, not an afternoon's work. */
const MAX_CHANGES = 500;

/**
 * Bangla digits for a Bangla sentence.
 *
 * `bangla-numerals.test.ts` caught the first version of the refusal below —
 * `${MAX_CHANGES}টি` puts a Latin number in front of a Bangla counter word,
 * which reads as broken to the person it is written for. The guard exists
 * because that mistake is easy and invisible to the writer.
 */
const bn = (n: number): string =>
  String(n).replace(/[0-9]/g, (d) => '০১২৩৪৫৬৭৮৯'[Number(d)]);

interface Change {
  sectionId?: string;
  subjectId?: string;
  /** `null` clears the cell — the subject stays, the teacher goes. */
  teacherId?: string | null;
}

interface Body {
  yearId?: string;
  changes?: Change[];
}

/**
 * The grid: every (section × subject the class studies) for one class, with
 * whoever currently holds it.
 *
 * Driven from `class_subjects` rather than from existing assignments, because
 * the empty cells are the point — a coordinator opening this needs to see the
 * eleven subjects nobody is teaching yet, not the two that are done.
 */
async function loadGrid(c: Client, yearId: string, classId: string | null) {
  const { rows: classes } = await c.query<{
    id: string; name_bn: string; level_no: number;
  }>(
    `SELECT DISTINCT cl.id, cl.name_bn, cl.level_no
       FROM classes cl
       JOIN sections s ON s.class_id = cl.id AND s.academic_year_id = $1
      ORDER BY cl.level_no`,
    [yearId],
  );

  const target = classId ?? classes[0]?.id ?? null;
  if (!target) {
    return { classes: [], classId: null, sections: [], subjects: [], teachers: [], cells: [] };
  }

  const { rows: sections } = await c.query<{ id: string; name: string; shift: string }>(
    `SELECT id, name, shift::text AS shift FROM sections
      WHERE class_id = $1 AND academic_year_id = $2 ORDER BY name`,
    [target, yearId],
  );

  const { rows: subjects } = await c.query<{
    id: string; name_bn: string; periods_per_week: number; double_periods_per_week: number;
    requires_capability: string | null;
  }>(
    `SELECT sub.id, sub.name_bn, cs.periods_per_week, cs.double_periods_per_week,
            sub.requires_capability
       FROM class_subjects cs
       JOIN subjects sub ON sub.id = cs.subject_id
      WHERE cs.class_id = $1 AND cs.academic_year_id = $2
      ORDER BY sub.name_bn`,
    [target, yearId],
  );

  // Everyone who could stand in front of a class. Competency is advisory
  // here, not a filter: `teacher_competencies` is empty in every school on
  // this deployment, so filtering by it would offer an empty dropdown and
  // make the screen unusable. It is surfaced as a hint instead.
  const { rows: teachers } = await c.query<{
    id: string; name_bn: string; employee_code: string; subject_ids: string[];
  }>(
    `SELECT u.id, u.full_name_bn AS name_bn, sp.employee_code,
            COALESCE(array_agg(DISTINCT tc.subject_id)
                     FILTER (WHERE tc.subject_id IS NOT NULL), '{}') AS subject_ids
       FROM users u
       JOIN staff_profiles sp ON sp.user_id = u.id
       JOIN user_roles r ON r.user_id = u.id AND r.tenant_id = u.tenant_id
       LEFT JOIN teacher_competencies tc ON tc.teacher_id = u.id
      WHERE u.deleted_at IS NULL AND u.status <> 'left'
        AND r.role_code IN ('subject_teacher','class_teacher','dept_head',
                            'academic_coordinator','principal')
      GROUP BY u.id, u.full_name_bn, sp.employee_code
      ORDER BY u.full_name_bn`,
  );

  const { rows: cells } = await c.query<{
    section_id: string; subject_id: string; teacher_id: string; teacher_bn: string;
  }>(
    `SELECT sst.section_id, sst.subject_id, sst.teacher_id, u.full_name_bn AS teacher_bn
       FROM section_subject_teachers sst
       JOIN sections s ON s.id = sst.section_id
       JOIN users u ON u.id = sst.teacher_id
      WHERE s.class_id = $1 AND sst.academic_year_id = $2 AND sst.ended_on IS NULL`,
    [target, yearId],
  );

  return {
    classes: classes.map((r) => ({ id: r.id, nameBn: r.name_bn, levelNo: r.level_no })),
    classId: target,
    sections: sections.map((r) => ({ id: r.id, name: r.name, shift: r.shift })),
    subjects: subjects.map((r) => ({
      id: r.id,
      nameBn: r.name_bn,
      periodsPerWeek: r.periods_per_week,
      doublePeriodsPerWeek: r.double_periods_per_week,
      requiresCapability: r.requires_capability,
    })),
    teachers: teachers.map((r) => ({
      id: r.id,
      nameBn: r.name_bn,
      employeeCode: r.employee_code,
      teaches: r.subject_ids,
    })),
    cells: cells.map((r) => ({
      sectionId: r.section_id,
      subjectId: r.subject_id,
      teacherId: r.teacher_id,
      teacherBn: r.teacher_bn,
    })),
    // What the wizard's step indicator reads. Computed here rather than in
    // the browser so "you are 340 of 800 done" cannot drift from the truth.
    progress: {
      required: sections.length * subjects.length,
      assigned: cells.length,
    },
  };
}

/**
 * Apply a batch of cell edits, all inside the caller's transaction.
 *
 * One transaction on purpose: a coordinator who fills a column and loses
 * their connection halfway should find the column empty and do it again, not
 * find half of it done and have to work out which half.
 */
async function applyChanges(
  c: Client, ctx: { userId: string; tenantId: string }, yearId: string, changes: Change[],
) {
  let opened = 0;
  let closed = 0;
  let unchanged = 0;

  for (const raw of changes) {
    const sectionId = String(raw.sectionId ?? '');
    const subjectId = String(raw.subjectId ?? '');
    const teacherId = raw.teacherId == null ? null : String(raw.teacherId);

    if (!UUID_RE.test(sectionId)) {
      throw new HttpError(400, 'সেকশন সঠিক নয়', 'invalid_section', { field: 'sectionId' });
    }
    if (!UUID_RE.test(subjectId)) {
      throw new HttpError(400, 'বিষয় সঠিক নয়', 'invalid_subject', { field: 'subjectId' });
    }
    if (teacherId !== null && !UUID_RE.test(teacherId)) {
      throw new HttpError(400, 'শিক্ষক সঠিক নয়', 'invalid_teacher', { field: 'teacherId' });
    }

    // The section must belong to the year being edited. Otherwise a stale
    // browser tab from last year writes into this year's timetable.
    const { rows: sec } = await c.query<{ class_id: string }>(
      `SELECT class_id FROM sections WHERE id = $1 AND academic_year_id = $2`,
      [sectionId, yearId],
    );
    if (!sec[0]) {
      throw new HttpError(404, 'এই শিক্ষাবর্ষে সেকশনটি পাওয়া যায়নি', 'section_not_in_year');
    }

    // And the class must actually study the subject. `class_subjects` is the
    // curriculum; assigning a teacher to a subject the class does not take
    // would create demand the generator then tries to place.
    const { rows: studies } = await c.query(
      `SELECT 1 FROM class_subjects
        WHERE class_id = $1 AND subject_id = $2 AND academic_year_id = $3`,
      [sec[0].class_id, subjectId, yearId],
    );
    if (!studies[0]) {
      throw new HttpError(409, 'এই শ্রেণিতে বিষয়টি পড়ানো হয় না', 'subject_not_in_class',
        { field: 'subjectId' });
    }

    if (teacherId !== null) {
      // A teacher from another school is invisible under RLS, so this reads
      // as "not found" rather than surfacing a foreign-key error nobody in
      // an office can act on.
      const { rows: t } = await c.query(
        `SELECT 1 FROM users u JOIN staff_profiles sp ON sp.user_id = u.id
          WHERE u.id = $1 AND u.deleted_at IS NULL`, [teacherId]);
      if (!t[0]) {
        throw new HttpError(404, 'শিক্ষক পাওয়া যায়নি', 'teacher_not_found',
          { field: 'teacherId' });
      }
    }

    const { rows: current } = await c.query<{ id: string; teacher_id: string }>(
      `SELECT id, teacher_id FROM section_subject_teachers
        WHERE section_id = $1 AND subject_id = $2 AND academic_year_id = $3
          AND ended_on IS NULL
        FOR UPDATE`,
      [sectionId, subjectId, yearId],
    );

    // Setting a cell to what it already says is not an edit. Without this,
    // re-saving an unchanged grid would close and reopen every row and fill
    // the history with churn that means nothing.
    if (current[0] && current[0].teacher_id === teacherId) { unchanged += 1; continue; }

    if (current[0]) {
      // `ended_on = app.today_dhaka()` and not CURRENT_DATE: they differ for
      // six hours every evening (B-79), and a school working late must not
      // record a change as having happened tomorrow.
      await c.query(
        `UPDATE section_subject_teachers
            SET ended_on = GREATEST(started_on, app.today_dhaka()),
                end_reason = 'reassigned'
          WHERE id = $1`,
        [current[0].id],
      );
      closed += 1;
    }

    if (teacherId !== null) {
      await c.query(
        `INSERT INTO section_subject_teachers
           (tenant_id, section_id, subject_id, teacher_id, academic_year_id,
            started_on, assigned_by)
         VALUES (app.current_tenant(), $1, $2, $3, $4, app.today_dhaka(), $5)`,
        [sectionId, subjectId, teacherId, yearId, ctx.userId],
      );
      opened += 1;
    }
  }

  return { opened, closed, unchanged };
}

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const cors = corsHeaders([], 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }

  try {
    const claims = await authenticate(req);
    requireRole(claims, ASSIGN_ROLES);
    const db = await sharedDb();
    // No `service:` key, for the same reason `editor.ts` has none: the
    // catalogue (migration 051) has no routine/timetable service, so there is
    // nothing for the entitlement gate to consult. An absence, not a bypass.
    const ctx = { tenantId: claims.tid, userId: claims.sub, role: claims.role };

    const url = new URL(req.url ?? '/', 'http://internal');

    if (req.method === 'GET') {
      const yearId = url.searchParams.get('yearId') ?? '';
      if (!UUID_RE.test(yearId)) {
        throw new HttpError(400, 'শিক্ষাবর্ষ বেছে নিন', 'invalid_year', { field: 'yearId' });
      }
      const classId = url.searchParams.get('classId');
      if (classId && !UUID_RE.test(classId)) {
        throw new HttpError(400, 'শ্রেণি সঠিক নয়', 'invalid_class', { field: 'classId' });
      }
      json(res, 200,
        await db.withTenant(ctx, (c) => loadGrid(c as Client, yearId, classId)), cors);
      return;
    }

    if (req.method === 'POST') {
      const body = await readJson<Body>(req);
      const yearId = String(body.yearId ?? '');
      if (!UUID_RE.test(yearId)) {
        throw new HttpError(400, 'শিক্ষাবর্ষ বেছে নিন', 'invalid_year', { field: 'yearId' });
      }
      const changes = Array.isArray(body.changes) ? body.changes : [];
      if (changes.length === 0) {
        throw new HttpError(400, 'কোনো পরিবর্তন পাঠানো হয়নি', 'no_changes');
      }
      if (changes.length > MAX_CHANGES) {
        throw new HttpError(400, `একবারে সর্বোচ্চ ${bn(MAX_CHANGES)}টি পরিবর্তন পাঠানো যায়`,
          'too_many_changes');
      }

      const result = await db.withTenant(
        ctx, (c) => applyChanges(c as Client, ctx, yearId, changes), { write: true });
      json(res, 200, result, cors);
      return;
    }

    json(res, 405, { error: 'method_not_allowed' }, cors);
  } catch (err) {
    if (err instanceof HttpError) {
      json(res, err.status, { error: err.code, message: err.message, ...(err.detail ?? {}) }, cors);
      return;
    }
    // A 500 with no trace is only diagnosable by reproducing it (B-86).
    console.error('[rms/assignments]', err);
    json(res, 500, { error: 'internal_error', message: 'সংরক্ষণ করা যায়নি' }, cors);
  }
}
