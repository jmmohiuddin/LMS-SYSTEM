/**
 * GET  /api/v1/academics/subjectchoice?studentId=  → one student's resolved
 *                                                    subject set + what they
 *                                                    may choose between
 * POST /api/v1/academics/subjectchoice             → apply a choice
 *
 * F-305 / F-304, wireframe §10.3.
 *
 * ── Derived, not typed ───────────────────────────────────────────────────
 * §10.3: "Compulsory subjects are derived and shown read-only — the
 * coordinator never types them. Only the bounded override set is
 * selectable: group, religion variant, optional subject."
 *
 * That bound is enforced here rather than trusted to the screen. A POST
 * carries at most a religion variant and an optional subject, and each is
 * checked against the student's own template's selection pools before it is
 * accepted. A choice outside those pools is a client bug, not a preference,
 * and is refused — the same posture app.derive_student_subjects takes.
 *
 * The derivation itself is not reimplemented. app.derive_student_subjects
 * (migration 025) already resolves the template, adds the unconditional
 * items, adds the chosen alternatives, and — the subtle half — WITHDRAWS the
 * pooled alternative that is no longer chosen, so a student correcting their
 * religion variant cannot end up holding two religion papers timetabled into
 * the same period. This endpoint's job is to validate the choice, persist
 * it, and call that function.
 *
 * ── What is deliberately NOT settable here ───────────────────────────────
 * The group. §10.3 draws it as a third selector, but in this schema the
 * group is a property of the CLASS, not the enrolment — classes are unique
 * on (tenant, level_no, stream, group), so "Class 9 Science" and "Class 9
 * Humanities" are different rows. Changing a student's group means moving
 * them to a section of a different class: a re-enrolment, with a new roll
 * number and a routine that has to be re-cut. Offering it as a dropdown
 * here would either lie about what it does or hide a re-enrolment behind a
 * one-tap control. The screen reports the group and says where it is set.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { sharedDb } from '../../../packages/server-core/src/db.ts';
import { corsHeaders, readJson, json, HttpError } from '../../../packages/server-core/src/http.ts';
import { authenticate, requireRole } from '../../../packages/server-core/src/auth.ts';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Who sets a child's subjects. Not a subject teacher; not the student. */
const CHOICE_ROLES = ['principal', 'school_owner', 'academic_coordinator'];

type Client = { query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }> };

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const cors = corsHeaders();
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }

  try {
    const claims = await authenticate(req);
    requireRole(claims, CHOICE_ROLES);
    const db = await sharedDb();
    const ctx = { tenantId: claims.tid, userId: claims.sub, role: claims.role };

    if (req.method === 'GET') {
      const studentId = new URL(req.url ?? '/', 'http://internal').searchParams.get('studentId') ?? '';
      if (!UUID_RE.test(studentId)) {
        throw new HttpError(400, 'studentId must be a valid uuid', 'invalid_student_id');
      }
      json(res, 200, await db.withTenant(ctx, (c) => load(c as Client, studentId)), cors);
      return;
    }

    if (req.method === 'POST') {
      const body = await readJson<{ studentId?: string; religionVariant?: string | null; optionalSubjectId?: string | null }>(req);
      json(res, 200, await db.withTenant(ctx, (c) => apply(c as Client, body)), cors);
      return;
    }

    json(res, 405, { error: 'method_not_allowed' }, cors);
  } catch (err) {
    if (err instanceof HttpError) {
      json(res, err.status, { error: err.code ?? 'error', message: err.message, ...(err.detail ?? {}) }, cors);
      return;
    }
    json(res, 500, { error: 'internal_error' }, cors);
  }
}

/** The enrolment, its template, and the pools that template offers. */
async function context(c: Client, studentId: string) {
  const r = await c.query<{
    enrolment_id: string; student_name: string; roll_no: number;
    class_bn: string; group_code: string; section_name: string;
    template_id: string | null; optional_subject_id: string | null;
  }>(
    `SELECT e.id AS enrolment_id, u.full_name_bn AS student_name, e.roll_no,
            cl.name_bn AS class_bn, cl."group"::text AS group_code, sec.name AS section_name,
            st.id AS template_id, e.optional_subject_id
       FROM enrolments e
       JOIN users u        ON u.id = e.student_id AND u.deleted_at IS NULL
       JOIN sections sec   ON sec.id = e.section_id
       JOIN classes cl     ON cl.id = sec.class_id
       JOIN academic_years y ON y.id = e.academic_year_id AND y.is_current
       LEFT JOIN curriculum_schemes cs ON cs.academic_year_id = y.id
       LEFT JOIN subject_templates st  ON st.curriculum_scheme_id = cs.id
                                      AND st.class_id = cl.id
      WHERE e.student_id = $1 AND e.status = 'active'
      LIMIT 1`,
    [studentId]);
  const row = r.rows[0];
  if (!row) throw new HttpError(404, 'student not enrolled this year', 'not_enrolled');
  return row;
}

async function load(c: Client, studentId: string) {
  const ctxRow = await context(c, studentId);

  // What this template offers as alternatives. Pools are what make religion
  // and the optional subject one mechanism instead of two special cases.
  const pools = ctxRow.template_id
    ? (await c.query<{
        subject_id: string; name_bn: string; requirement_type: string;
        religion_variant: string | null; selection_pool: string;
      }>(
        `SELECT i.subject_id, s.name_bn, i.requirement_type, i.religion_variant, i.selection_pool
           FROM subject_template_items i
           JOIN subjects s ON s.id = i.subject_id
          WHERE i.template_id = $1 AND i.selection_pool IS NOT NULL
          ORDER BY i.selection_pool, i.display_order, s.name_bn`,
        [ctxRow.template_id])).rows
    : [];

  // What the student actually holds right now.
  const held = await c.query<{
    subject_id: string; name_bn: string; requirement_type: string; source: string;
  }>(
    `SELECT ss.subject_id, s.name_bn, ss.requirement_type, ss.source
       FROM student_subjects ss
       JOIN subjects s ON s.id = ss.subject_id
      WHERE ss.enrolment_id = $1
      ORDER BY ss.requirement_type, s.name_bn`,
    [ctxRow.enrolment_id]);

  const currentReligion = held.rows.find((h) => h.requirement_type === 'religion_variant');
  const religionVariant = currentReligion
    ? pools.find((p) => p.subject_id === currentReligion.subject_id)?.religion_variant ?? null
    : null;

  return {
    student: {
      id: studentId, nameBn: ctxRow.student_name, rollNo: ctxRow.roll_no,
      classBn: ctxRow.class_bn, sectionName: ctxRow.section_name,
      groupCode: ctxRow.group_code,
    },
    hasTemplate: Boolean(ctxRow.template_id),
    // Read-only: what the template gives every student on it (§10.3).
    derived: held.rows
      .filter((h) => h.requirement_type === 'compulsory' || h.requirement_type === 'group_compulsory')
      .map((h) => ({ subjectId: h.subject_id, nameBn: h.name_bn, requirementType: h.requirement_type })),
    religionOptions: pools
      .filter((p) => p.requirement_type === 'religion_variant')
      .map((p) => ({ subjectId: p.subject_id, nameBn: p.name_bn, variant: p.religion_variant })),
    optionalOptions: pools
      .filter((p) => p.requirement_type === 'optional')
      .map((p) => ({ subjectId: p.subject_id, nameBn: p.name_bn })),
    current: {
      religionVariant,
      religionSubjectId: currentReligion?.subject_id ?? null,
      optionalSubjectId: ctxRow.optional_subject_id,
    },
  };
}

async function apply(
  c: Client,
  body: { studentId?: string; religionVariant?: string | null; optionalSubjectId?: string | null },
) {
  const studentId = body.studentId ?? '';
  if (!UUID_RE.test(studentId)) throw new HttpError(400, 'studentId must be a valid uuid', 'invalid_student_id');
  const ctxRow = await context(c, studentId);
  if (!ctxRow.template_id) {
    throw new HttpError(409,
      'এই শ্রেণির জন্য বিষয়-টেমপ্লেট নেই — আগে টেমপ্লেট তৈরি করুন।', 'no_template');
  }

  const optionalId = body.optionalSubjectId ?? null;
  const religion = body.religionVariant ?? null;

  // The bound, enforced. Each choice must be an item in THIS template's
  // pools; anything else is refused rather than quietly dropped by the
  // derivation, so a bad client learns it is wrong.
  if (optionalId !== null) {
    if (!UUID_RE.test(optionalId)) {
      throw new HttpError(400, 'optionalSubjectId must be a valid uuid', 'invalid_optional');
    }
    const ok = await c.query<{ one: number }>(
      `SELECT 1 AS one FROM subject_template_items
        WHERE template_id = $1 AND subject_id = $2 AND requirement_type = 'optional'`,
      [ctxRow.template_id, optionalId]);
    if (ok.rows.length === 0) {
      throw new HttpError(400,
        'এই শ্রেণিতে ওই চতুর্থ বিষয় নেওয়া যায় না।', 'optional_not_offered');
    }
  }
  if (religion !== null) {
    const ok = await c.query<{ one: number }>(
      `SELECT 1 AS one FROM subject_template_items
        WHERE template_id = $1 AND religion_variant = $2 AND requirement_type = 'religion_variant'`,
      [ctxRow.template_id, religion]);
    if (ok.rows.length === 0) {
      throw new HttpError(400, 'এই ধর্ম শিক্ষার বিকল্প এই শ্রেণিতে নেই।', 'religion_not_offered');
    }
  }

  // The choice lives on the enrolment; the resolved set is rebuilt from it.
  await c.query(
    `UPDATE enrolments
        SET optional_subject_id = $2, row_version = row_version + 1, updated_at = now()
      WHERE id = $1`,
    [ctxRow.enrolment_id, optionalId]);

  // Re-derive. Idempotent, and it withdraws the alternative that is no
  // longer chosen — the reason this is a function call and not an INSERT.
  const derived = await c.query<{ derive_student_subjects: number }>(
    `SELECT app.derive_student_subjects($1, $2, $3)`,
    [ctxRow.enrolment_id, optionalId, religion]);

  return {
    ok: true,
    subjectCount: Number(derived.rows[0]?.derive_student_subjects ?? 0),
    // §10.3: downstream assignments are "explicitly invalidated, never
    // silently left stale". The routine and content that referenced the old
    // subject set are now out of date; the screen says so in words rather
    // than leaving the coordinator to discover it.
    invalidated: ['routine', 'content'],
  };
}
