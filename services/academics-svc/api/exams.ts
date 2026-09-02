/**
 * GET   /api/v1/academics/exams?sectionId=…   — the marks-entry feed
 * GET   /api/v1/academics/exams?yearId=…      — the exam list, for the office
 * POST  /api/v1/academics/exams               — create an exam and its papers
 * PATCH /api/v1/academics/exams               — correct one, while it is still planned
 *
 * ── Why the write half exists (P0) ──────────────────────────────────────
 * Nothing in this product has ever created an exam. `INSERT INTO exams`
 * appeared nowhere outside tests, and no `app.*` function inserted one — so
 * the entire chain below it (marks entry → per-subject grade → GPA → rank →
 * publish → progress report → admit card) was built, tested, and unreachable.
 * A school could enter students and take attendance, and could not examine
 * them.
 *
 * The role scope lives in migration 066, in the same commit. Before it, a
 * subject teacher's session could insert an exam — proved against a live
 * database. `requireRole` here is the clean 403 in front of that.
 *
 * ── An exam is created WITH its papers ──────────────────────────────────
 * An `exams` row on its own is invisible: the marks feed INNER JOINs
 * `exam_subjects`, so an exam with no papers appears nowhere and can never be
 * marked. The two are therefore written in one transaction, and the component
 * maxima are copied from `class_subjects` — which is what migration 005 says
 * to do, in as many words: "Component maxima (copied from class_subjects at
 * creation, then frozen)".
 *
 * GET /api/v1/academics/exams?sectionId=...
 *
 * Feeds the PWA's marks-entry screen: every exam that has an exam_subjects
 * row for the given section, with the component maxima the entry form needs
 * (CQ/MCQ/practical/CA) and whether marking is still open. Writes go the
 * other way — through the offline outbox as `exam_mark` ops into
 * POST /api/v1/sync/push (see services/sync-svc/src/appliers.ts), never
 * through a bespoke marks-write endpoint.
 *
 * RLS on exams/exam_subjects is tenant-wide read for staff; requireStaff
 * mirrors roster.ts/sections.ts.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { sharedDb } from '../../../packages/server-core/src/db.ts';
import { corsHeaders, query, json, readJson, HttpError } from '../../../packages/server-core/src/http.ts';
import { authenticate, requireStaff, requireRole } from '../../../packages/server-core/src/auth.ts';
import { writeAudit } from '../../../packages/server-core/src/audit.ts';

/**
 * The purchasable service this endpoint IS (migration 051 catalogue).
 * The gate in withTenant refuses the request when a school has this one
 * turned off, in maintenance, or absent from its plan.
 */
const SERVICE = 'results';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Who may author an exam. Mirrors `exams_insert_scope` in migration 066 and
 * EXAM_ROLES in services/rms-svc/api/examroutine.ts — the same four roles that
 * already write these tables through the exam-routine screen.
 */
const EXAM_ROLES = ['principal', 'school_owner', 'academic_coordinator', 'dept_head'];

/** exams_exam_type_check, migration 005. Kept in step with the constraint. */
const EXAM_TYPES = ['class_test', 'monthly', 'half_yearly', 'pre_test',
  'test', 'annual', 'model', 'board'];

const NAME_MAX = 120;

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  // Widened from GET-only when the write half landed: a browser preflight for
  // POST/PATCH is refused unless the method is advertised here.
  const cors = corsHeaders([], 'GET, POST, PATCH, OPTIONS');
  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors);
    res.end();
    return;
  }
  try {
    const claims = await authenticate(req);
    const db0 = await sharedDb();
    const wctx = { tenantId: claims.tid, userId: claims.sub, role: claims.role, service: SERVICE };

    if (req.method === 'POST') {
      requireRole(claims, EXAM_ROLES);
      json(res, 200, await createExam(db0, wctx, req), cors);
      return;
    }
    if (req.method === 'PATCH') {
      requireRole(claims, EXAM_ROLES);
      json(res, 200, await updateExam(db0, wctx, req), cors);
      return;
    }
    if (req.method !== 'GET') {
      json(res, 405, { error: 'method_not_allowed' }, cors);
      return;
    }

    requireStaff(claims);

    // The office's list view: every exam in a year, with how many papers it
    // carries. Distinct from the marks feed below, which is per section.
    const yearId = query(req).get('yearId') ?? '';
    if (yearId) {
      if (!UUID_RE.test(yearId)) throw new HttpError(400, 'শিক্ষাবর্ষ সঠিক নয়।', 'invalid_year_id');
      json(res, 200, await listByYear(db0, wctx, yearId, claims.role), cors);
      return;
    }

    const sectionId = query(req).get('sectionId') ?? '';
    if (!UUID_RE.test(sectionId)) throw new HttpError(400, 'sectionId must be a valid uuid', 'invalid_section_id');

    const db = await sharedDb();
    const exams = await db.withTenant(
      { tenantId: claims.tid, userId: claims.sub, role: claims.role, service: SERVICE },
      async (client) => {
        const r = await client.query<{
          exam_id: string;
          name_bn: string;
          name_en: string;
          exam_type: string;
          status: string;
          starts_on: string | null;
          ends_on: string | null;
          academic_year_id: string;
          exam_subject_id: string;
          subject_id: string;
          subject_bn: string;
          subject_en: string;
          exam_date: string | null;
          cq_max: string;
          mcq_max: string;
          practical_max: string;
          ca_max: string;
          cq_pass: string;
          mcq_pass: string;
          marking_locked: boolean;
        }>(
          `SELECT e.id AS exam_id, e.name_bn, e.name_en, e.exam_type, e.status,
                  e.starts_on, e.ends_on, e.academic_year_id,
                  es.id AS exam_subject_id, es.subject_id,
                  sub.name_bn AS subject_bn, sub.name_en AS subject_en,
                  es.exam_date, es.cq_max, es.mcq_max, es.practical_max, es.ca_max,
                  es.cq_pass, es.mcq_pass, es.marking_locked
             FROM exams e
             JOIN exam_subjects es ON es.exam_id = e.id
             JOIN subjects sub     ON sub.id = es.subject_id
            WHERE es.section_id = $1
            ORDER BY e.starts_on DESC NULLS LAST, e.created_at DESC, sub.name_bn`,
          [sectionId],
        );

        // Group rows into exam → subjects, preserving order.
        const byExam = new Map<string, {
          id: string; nameBn: string; nameEn: string; examType: string; status: string;
          startsOn: string | null; endsOn: string | null; academicYearId: string;
          subjects: unknown[];
        }>();
        for (const row of r.rows) {
          let exam = byExam.get(row.exam_id);
          if (!exam) {
            exam = {
              id: row.exam_id,
              nameBn: row.name_bn,
              nameEn: row.name_en,
              examType: row.exam_type,
              status: row.status,
              startsOn: row.starts_on,
              endsOn: row.ends_on,
              academicYearId: row.academic_year_id,
              subjects: [],
            };
            byExam.set(row.exam_id, exam);
          }
          exam.subjects.push({
            examSubjectId: row.exam_subject_id,
            subjectId: row.subject_id,
            subject: { bn: row.subject_bn, en: row.subject_en },
            examDate: row.exam_date,
            cqMax: Number(row.cq_max),
            mcqMax: Number(row.mcq_max),
            practicalMax: Number(row.practical_max),
            caMax: Number(row.ca_max),
            cqPass: Number(row.cq_pass),
            mcqPass: Number(row.mcq_pass),
            markingLocked: row.marking_locked,
          });
        }
        return [...byExam.values()];
      },
    );

    json(res, 200, { exams }, cors);
  } catch (err) {
    if (err instanceof HttpError) {
      // `detail` carries `{ field }`, which is what lets the form put the
      // error against the box that caused it instead of at the top.
      json(res, err.status,
        { error: err.code ?? 'error', message: err.message, ...(err.detail ?? {}) }, cors);
      return;
    }
    const e = err as { code?: string; constraint?: string };
    // Two exams sharing a name inside one year is a typo the office can fix,
    // not a 500. The index is uq_exam_name_year, migration 066.
    if (e.code === '23505' && e.constraint === 'uq_exam_name_year') {
      json(res, 409, {
        error: 'duplicate_name',
        message: 'এই শিক্ষাবর্ষে এই নামে একটি পরীক্ষা ইতিমধ্যে আছে।',
        field: 'nameBn',
      }, cors);
      return;
    }
    console.error('[exams] unexpected error', err);
    json(res, 500, { error: 'internal_error' }, cors);
  }
}

type Db = Awaited<ReturnType<typeof sharedDb>>;
type Ctx = { tenantId: string; userId: string; role: string; service: string };

interface ExamBody {
  id?: string;
  academicYearId?: string;
  termId?: string | null;
  nameBn?: string;
  nameEn?: string;
  examType?: string;
  weightPercent?: number;
  startsOn?: string | null;
  endsOn?: string | null;
  isGpaBearing?: boolean;
  /** Which sections sit this exam. Papers are derived from their class subjects. */
  sectionIds?: string[];
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** The office's list: exams in a year, with paper and mark counts. */
async function listByYear(db: Db, ctx: Ctx, yearId: string, role: string): Promise<unknown> {
  return db.withTenant(ctx, async (c) => {
    const { rows } = await c.query<{
      id: string; name_bn: string; name_en: string; exam_type: string;
      status: string; starts_on: string | null; ends_on: string | null;
      weight_percent: string; is_gpa_bearing: boolean;
      paper_count: string; section_count: string; mark_count: string;
    }>(
      `SELECT e.id, e.name_bn, e.name_en, e.exam_type, e.status,
              e.starts_on, e.ends_on, e.weight_percent, e.is_gpa_bearing,
              (SELECT count(*) FROM exam_subjects es WHERE es.exam_id = e.id)  AS paper_count,
              (SELECT count(DISTINCT es.section_id) FROM exam_subjects es
                WHERE es.exam_id = e.id)                                       AS section_count,
              (SELECT count(*) FROM exam_marks m
                 JOIN exam_subjects es ON es.id = m.exam_subject_id
                WHERE es.exam_id = e.id)                                       AS mark_count
         FROM exams e
        WHERE e.academic_year_id = $1
        ORDER BY e.starts_on NULLS LAST, e.name_bn`,
      [yearId]);

    return {
      canManage: EXAM_ROLES.includes(role),
      examTypes: EXAM_TYPES,
      exams: rows.map((r) => ({
        id: r.id, nameBn: r.name_bn, nameEn: r.name_en, examType: r.exam_type,
        status: r.status, startsOn: r.starts_on, endsOn: r.ends_on,
        weightPercent: Number(r.weight_percent), isGpaBearing: r.is_gpa_bearing,
        paperCount: Number(r.paper_count), sectionCount: Number(r.section_count),
        markCount: Number(r.mark_count),
      })),
    };
  });
}

/** Shared validation. Dates are compared as strings — they are Dhaka days. */
function validate(b: ExamBody, opts: { requireYear: boolean }): {
  nameBn: string; nameEn: string; examType: string; weight: number;
  startsOn: string | null; endsOn: string | null;
} {
  const nameBn = (b.nameBn ?? '').trim();
  if (!nameBn) throw new HttpError(400, 'পরীক্ষার নাম লিখুন।', 'bad_name', { field: 'nameBn' });
  if (nameBn.length > NAME_MAX) {
    throw new HttpError(400, `নাম ${NAME_MAX} অক্ষরের মধ্যে দিন।`, 'bad_name', { field: 'nameBn' });
  }
  // name_en is NOT NULL in the schema. A school that types only Bangla should
  // not be blocked by a column it will never look at, so it falls back.
  const nameEn = (b.nameEn ?? '').trim() || nameBn;

  const examType = (b.examType ?? '').trim();
  if (!EXAM_TYPES.includes(examType)) {
    throw new HttpError(400, 'পরীক্ষার ধরন সঠিক নয়।', 'bad_exam_type', { field: 'examType' });
  }

  const weight = b.weightPercent === undefined ? 100 : Number(b.weightPercent);
  if (!Number.isFinite(weight) || weight < 0 || weight > 100) {
    throw new HttpError(400, 'ওজন ০ থেকে ১০০-এর মধ্যে দিন।', 'bad_weight', { field: 'weightPercent' });
  }

  const startsOn = b.startsOn ? String(b.startsOn) : null;
  const endsOn = b.endsOn ? String(b.endsOn) : null;
  for (const [v, f] of [[startsOn, 'startsOn'], [endsOn, 'endsOn']] as const) {
    if (v !== null && !DATE_RE.test(v)) {
      throw new HttpError(400, 'তারিখ সঠিক নয়।', 'bad_date', { field: f });
    }
  }
  if (startsOn && endsOn && endsOn < startsOn) {
    throw new HttpError(400, 'শেষ তারিখ শুরুর আগে হতে পারে না।', 'bad_date_order', { field: 'endsOn' });
  }
  if (opts.requireYear && !UUID_RE.test(b.academicYearId ?? '')) {
    throw new HttpError(400, 'শিক্ষাবর্ষ বেছে নিন।', 'bad_year', { field: 'academicYearId' });
  }
  return { nameBn, nameEn, examType, weight, startsOn, endsOn };
}

/** An exam has to sit inside the year it belongs to. */
async function assertInYear(
  c: { query: <T>(t: string, v?: unknown[]) => Promise<{ rowCount: number | null; rows: T[] }> },
  yearId: string,
  startsOn: string | null,
  endsOn: string | null,
): Promise<void> {
  const yr = await c.query<{ starts_on: string; ends_on: string; label: string }>(
    `SELECT starts_on, ends_on, label FROM academic_years WHERE id = $1`, [yearId]);
  if (!yr.rowCount) throw new HttpError(404, 'শিক্ষাবর্ষটি পাওয়া যায়নি।', 'year_not_found');
  const year = yr.rows[0];
  for (const [d, f] of [[startsOn, 'startsOn'], [endsOn, 'endsOn']] as const) {
    if (d && (d < year.starts_on || d > year.ends_on)) {
      throw new HttpError(400,
        `তারিখটি ${year.label} শিক্ষাবর্ষের ভেতরে হতে হবে।`, 'date_outside_year', { field: f });
    }
  }
}

async function createExam(db: Db, ctx: Ctx, req: IncomingMessage): Promise<unknown> {
  const body = await readJson<ExamBody>(req);
  const v = validate(body, { requireYear: true });
  const yearId = String(body.academicYearId);
  const sectionIds = Array.isArray(body.sectionIds) ? body.sectionIds.map(String) : [];
  if (sectionIds.length === 0) {
    // Without a section there are no papers, and an exam with no papers is
    // invisible: the marks feed INNER JOINs exam_subjects, so it would appear
    // nowhere and could never be marked. A clear refusal beats a ghost.
    throw new HttpError(400, 'অন্তত একটি সেকশন বেছে নিন।', 'no_sections', { field: 'sectionIds' });
  }
  for (const s of sectionIds) {
    if (!UUID_RE.test(s)) {
      throw new HttpError(400, 'সেকশন সঠিক নয়।', 'bad_section', { field: 'sectionIds' });
    }
  }

  return db.withTenant(ctx, async (c) => {
    await assertInYear(c, yearId, v.startsOn, v.endsOn);

    // Every named section must belong to this year — one from last year would
    // produce papers nobody sits. RLS already scopes the lookup, so another
    // school's section simply is not found.
    const secs = await c.query(
      `SELECT id FROM sections WHERE id = ANY($1::uuid[]) AND academic_year_id = $2`,
      [sectionIds, yearId]);
    if (secs.rowCount !== sectionIds.length) {
      throw new HttpError(400,
        'একটি বা একাধিক সেকশন এই শিক্ষাবর্ষের নয়।', 'section_not_in_year', { field: 'sectionIds' });
    }

    const ins = await c.query<{ id: string }>(
      `INSERT INTO exams (tenant_id, academic_year_id, term_id, name_bn, name_en,
                          exam_type, weight_percent, starts_on, ends_on, is_gpa_bearing)
       VALUES (app.current_tenant(), $1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id`,
      [yearId, body.termId ?? null, v.nameBn, v.nameEn, v.examType, v.weight,
        v.startsOn, v.endsOn, body.isGpaBearing !== false]);
    const examId = ins.rows[0].id;

    // Papers: one per (section x subject the class actually teaches), with the
    // component maxima copied from class_subjects and then frozen. That is
    // migration 005's own instruction, and it is why an exam is never created
    // bare.
    const papers = await c.query<{ n: string }>(
      `WITH made AS (
         INSERT INTO exam_subjects
           (tenant_id, exam_id, section_id, subject_id,
            cq_max, mcq_max, practical_max, ca_max, cq_pass, mcq_pass)
         SELECT app.current_tenant(), $1, s.id, cs.subject_id,
                cs.cq_marks, cs.mcq_marks, cs.practical_marks, cs.ca_marks,
                cs.cq_pass_marks, cs.mcq_pass_marks
           FROM sections s
           JOIN class_subjects cs
             ON cs.class_id = s.class_id AND cs.academic_year_id = s.academic_year_id
          WHERE s.id = ANY($2::uuid[])
         RETURNING 1
       )
       SELECT count(*)::text AS n FROM made`,
      [examId, sectionIds]);

    const paperCount = Number(papers.rows[0].n);
    if (paperCount === 0) {
      // The sections exist but their classes have no subjects configured, so
      // there is nothing to examine. Throwing rolls the exam back: an exam
      // nobody can mark is worse than a refusal that says what to fix.
      throw new HttpError(409,
        'এই সেকশনগুলোর শ্রেণিতে কোনো বিষয় নির্ধারণ করা নেই — আগে বিষয় যোগ করুন।',
        'no_class_subjects');
    }

    await writeAudit(c, ctx, {
      action: 'academic.exam.create',
      entityType: 'exam',
      entityId: examId,
      after: {
        nameBn: v.nameBn, examType: v.examType, startsOn: v.startsOn,
        endsOn: v.endsOn, sections: sectionIds.length, papers: paperCount,
      },
    });

    return { id: examId, nameBn: v.nameBn, paperCount, sectionCount: sectionIds.length };
  }, { write: true });
}

async function updateExam(db: Db, ctx: Ctx, req: IncomingMessage): Promise<unknown> {
  const body = await readJson<ExamBody>(req);
  const id = (body.id ?? '').trim();
  if (!UUID_RE.test(id)) {
    throw new HttpError(400, 'কোন পরীক্ষা তা জানানো হয়নি।', 'exam_required', { field: 'id' });
  }

  return db.withTenant(ctx, async (c) => {
    const cur = await c.query<{
      status: string; name_bn: string; name_en: string; exam_type: string;
      weight_percent: string; starts_on: string | null; ends_on: string | null;
      academic_year_id: string; is_gpa_bearing: boolean;
    }>(
      `SELECT status, name_bn, name_en, exam_type, weight_percent, starts_on, ends_on,
              academic_year_id, is_gpa_bearing
         FROM exams WHERE id = $1`, [id]);
    if (cur.rowCount === 0) throw new HttpError(404, 'পরীক্ষাটি পাওয়া যায়নি।', 'exam_not_found');
    const was = cur.rows[0];

    // Once results are out the exam is the record behind every certificate
    // issued from it. Editing the name or the dates then would rewrite what a
    // parent has already been told.
    if (was.status === 'published' || was.status === 'locked') {
      throw new HttpError(409, 'ফলাফল প্রকাশিত পরীক্ষা আর সম্পাদনা করা যায় না।', 'exam_published');
    }

    // PATCH means "change what I named": everything else is carried across, or
    // an omitted field silently reverts to a create-time default.
    const v = validate({
      nameBn: body.nameBn ?? was.name_bn,
      nameEn: body.nameEn ?? was.name_en,
      examType: body.examType ?? was.exam_type,
      weightPercent: body.weightPercent ?? Number(was.weight_percent),
      startsOn: body.startsOn !== undefined ? body.startsOn : was.starts_on,
      endsOn: body.endsOn !== undefined ? body.endsOn : was.ends_on,
    }, { requireYear: false });

    await assertInYear(c, was.academic_year_id, v.startsOn, v.endsOn);

    await c.query(
      `UPDATE exams
          SET name_bn = $2, name_en = $3, exam_type = $4, weight_percent = $5,
              starts_on = $6, ends_on = $7, is_gpa_bearing = $8
        WHERE id = $1`,
      [id, v.nameBn, v.nameEn, v.examType, v.weight, v.startsOn, v.endsOn,
        body.isGpaBearing === undefined ? was.is_gpa_bearing : body.isGpaBearing]);

    await writeAudit(c, ctx, {
      action: 'academic.exam.update',
      entityType: 'exam',
      entityId: id,
      before: {
        nameBn: was.name_bn, examType: was.exam_type,
        startsOn: was.starts_on, endsOn: was.ends_on,
      },
      after: {
        nameBn: v.nameBn, examType: v.examType,
        startsOn: v.startsOn, endsOn: v.endsOn,
      },
    });

    return { id, nameBn: v.nameBn };
  }, { write: true });
}
