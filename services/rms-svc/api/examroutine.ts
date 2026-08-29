/**
 * GET  /api/v1/rms/examroutine?examId=…   → the routine, per-paper clash flags,
 *                                           and the affected students by name
 * GET  /api/v1/rms/examroutine            → the exam list for the selector
 * POST /api/v1/rms/examroutine { examId, publish: true }
 *                                         → publishes, or 409 with the list
 * POST /api/v1/rms/examroutine { examId, reschedule: {examSubjectId, examDate, startTime} }
 *                                         → moves one paper (draft only)
 *
 * Wireframe §8.3, the screen the spec calls "the screen that proves the
 * subject-based model": two legitimate Class 11 Science subjects in one
 * slot, invisible at class level, a clash for four named students once
 * checked against each student's own resolved subject set.
 *
 * Two decisions worth stating.
 *
 * The clash list is computed by app.exam_student_clashes (migration 028,
 * corrected in 029), not re-derived here. Re-implementing that join in
 * TypeScript would give the screen and the publication gate two separate
 * definitions of "clash", and the screen's would be the one nobody tests
 * against a real roster.
 *
 * Publication is attempted, not pre-checked. The endpoint does not ask
 * "are there clashes?" and then publish if not — that is a race, and the
 * gate is a trigger precisely so the answer cannot go stale between the
 * question and the write. It issues the UPDATE and translates the
 * trigger's error into a 409 carrying the list.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { sharedDb } from '../../../packages/server-core/src/db.ts';
import { corsHeaders, readJson, json, HttpError } from '../../../packages/server-core/src/http.ts';
import { authenticate, requireRole } from '../../../packages/server-core/src/auth.ts';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const EXAM_ROLES = ['principal', 'school_owner', 'academic_coordinator', 'dept_head'];

interface Reschedule {
  examSubjectId?: string;
  examDate?: string;
  startTime?: string;
}

interface PostBody {
  examId?: string;
  publish?: boolean;
  reschedule?: Reschedule | null;
}

interface PaperRow {
  exam_subject_id: string;
  section_name: string;
  subject_bn: string;
  exam_date: string | null;
  start_time: string | null;
  duration_minutes: number | null;
}

interface ClashRow {
  student_name_bn: string;
  roll_no: number;
  section_name: string;
  exam_date: string;
  subject_a_bn: string;
  subject_b_bn: string;
  start_a: string;
  start_b: string;
}

interface ExamRow {
  id: string;
  name_bn: string;
  exam_type: string;
  starts_on: string;
  ends_on: string;
  status: string;
}

/** "10:00:00" + 180 → "13:00". Times come back from pg as HH:MM:SS. */
function endTime(start: string | null, minutes: number | null): string | null {
  if (!start) return null;
  const [h, m] = start.split(':').map(Number);
  const total = h * 60 + m + (minutes ?? 0);
  const hh = Math.floor(total / 60) % 24;
  return `${String(hh).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

function hhmm(t: string | null): string | null {
  return t ? t.slice(0, 5) : null;
}

/**
 * A `date` column comes back from pg as a JS Date, and String(date) gives
 * "Thu Dec 17 2026 00:00:00 GMT+0600" — so the obvious .slice(0, 10)
 * yields "Thu Dec 17".
 *
 * toISOString() is not the fix either: pg parses a bare date at local
 * midnight, and Dhaka is UTC+6, so the ISO form is the PREVIOUS day. An
 * exam routine off by one day is worse than one formatted oddly. Read the
 * local Y-M-D fields, which are the ones pg actually put there.
 */
function isoDate(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) {
    return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}`
         + `-${String(v.getDate()).padStart(2, '0')}`;
  }
  return String(v).slice(0, 10);
}

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const cors = corsHeaders();
  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors);
    res.end();
    return;
  }

  try {
    const claims = await authenticate(req);
    requireRole(claims, EXAM_ROLES);

    const url = new URL(req.url ?? '/', 'http://internal');
    let examId = url.searchParams.get('examId') ?? '';
    let publish = false;
    let reschedule: Reschedule | null = null;

    if (req.method === 'POST') {
      const body = await readJson<PostBody>(req);
      examId = body.examId ?? examId;
      publish = body.publish === true;
      reschedule = body.reschedule ?? null;
      if (reschedule) {
        if (!UUID_RE.test(reschedule.examSubjectId ?? '')) {
          throw new HttpError(400, 'examSubjectId must be a valid uuid', 'invalid_exam_subject_id');
        }
        if (!DATE_RE.test(reschedule.examDate ?? '')) {
          throw new HttpError(400, 'examDate must be YYYY-MM-DD', 'invalid_exam_date');
        }
        if (!TIME_RE.test(reschedule.startTime ?? '')) {
          throw new HttpError(400, 'startTime must be HH:MM', 'invalid_start_time');
        }
      }
    } else if (req.method !== 'GET') {
      json(res, 405, { error: 'method_not_allowed' }, cors);
      return;
    }

    const db = await sharedDb();
    const ctx = { tenantId: claims.tid, userId: claims.sub, role: claims.role };

    // No examId on a GET means "which exams are there?". The screen needs
    // that list to put a selector above the routine, and giving it its own
    // endpoint would mean a second route and a second Vercel function for
    // one query. An explicitly malformed id is still a 400 — only an
    // absent one means the list.
    if (req.method === 'GET' && examId === '') {
      const exams = await db.withTenant(ctx, async (client) => {
        const r = await client.query<ExamRow>(
          `SELECT e.id, e.name_bn, e.exam_type, e.starts_on, e.ends_on, e.status
             FROM exams e
             JOIN academic_years y ON y.id = e.academic_year_id
            WHERE y.is_current
            ORDER BY e.starts_on DESC`,
        );
        return r.rows.map((e) => ({
          id: e.id,
          nameBn: e.name_bn,
          examType: e.exam_type,
          startsOn: isoDate(e.starts_on),
          endsOn: isoDate(e.ends_on),
          status: e.status,
        }));
      });
      json(res, 200, { exams }, cors);
      return;
    }

    if (!UUID_RE.test(examId)) {
      throw new HttpError(400, 'examId must be a valid uuid', 'invalid_exam_id');
    }

    const payload = await db.withTenant(ctx, async (client) => {
      const exam = await client.query<ExamRow>(
        `SELECT id, name_bn, exam_type, starts_on, ends_on, status FROM exams WHERE id = $1`,
        [examId],
      );
      if (!exam.rows[0]) throw new HttpError(404, 'exam not found', 'exam_not_found');

      // §8.3's [ সময় পরিবর্তন করুন ]. Moving a paper is the only action
      // that closes the loop the screen exists for — see the clash, move
      // one of the two, re-check. Allowed on a draft only: a published
      // routine is what the school has already told parents, and changing
      // it silently underneath them is a different feature with different
      // consequences.
      if (reschedule) {
        if (exam.rows[0].status === 'published') {
          throw new HttpError(
            409, 'a published exam routine cannot be rescheduled here', 'exam_published');
        }
        const moved = await client.query(
          `UPDATE exam_subjects SET exam_date = $2, start_time = $3
            WHERE id = $1 AND exam_id = $4`,
          [reschedule.examSubjectId, reschedule.examDate, reschedule.startTime, examId],
        );
        if (moved.rowCount === 0) {
          throw new HttpError(404, 'paper not found in this exam', 'paper_not_found');
        }
      }

      if (publish) {
        try {
          await client.query(`UPDATE exams SET status = 'published' WHERE id = $1`, [examId]);
          exam.rows[0].status = 'published';

          // R-2. Tell the students sitting it, and their guardians — in this
          // same transaction, so a routine that fails to publish announces
          // nothing. Idempotent on (tenant, 'exam_routine', examId), which is
          // what makes a corrected-and-republished routine safe.
          //
          // The audience is the sections that actually have a paper in this
          // exam, not the whole school: a Class 9 exam is not news in Class 6.
          const sections = await client.query<{ ids: string[] }>(
            `SELECT COALESCE(array_agg(DISTINCT section_id), '{}') AS ids
               FROM exam_subjects WHERE exam_id = $1`,
            [examId],
          );
          const sectionIds = sections.rows[0]?.ids ?? [];
          if (sectionIds.length > 0) {
            await client.query(
              `SELECT * FROM app.emit_auto_notice(
                 'exam_routine', $1::uuid, $2, $3, 'exam'::notice_category,
                 jsonb_build_object('type','section','ids', to_jsonb($4::uuid[])), false)`,
              [
                examId,
                `${exam.rows[0].name_bn} — পরীক্ষার সূচি প্রকাশিত`,
                'পরীক্ষার সময়সূচি অ্যাপে দেখা যাচ্ছে। তারিখ ও সময় মিলিয়ে নিন।',
                sectionIds,
              ],
            );
          }
        } catch (err) {
          // The trigger raises check_violation. Anything else is a real
          // failure and must not be dressed up as a routine conflict.
          const code = (err as { code?: string }).code;
          if (code !== '23514') throw err;
          throw new HttpError(
            409,
            (err as Error).message,
            'exam_routine_clash',
          );
        }
      }

      const papers = await client.query<PaperRow>(
        `SELECT es.id            AS exam_subject_id,
                sec.name         AS section_name,
                sub.name_bn      AS subject_bn,
                es.exam_date, es.start_time, es.duration_minutes
           FROM exam_subjects es
           JOIN sections sec ON sec.id = es.section_id
           JOIN subjects sub ON sub.id = es.subject_id
          WHERE es.exam_id = $1
          ORDER BY es.exam_date NULLS LAST, es.start_time NULLS LAST, sub.name_bn, sec.name`,
        [examId],
      );

      const clashes = await client.query<ClashRow>(
        `SELECT student_name_bn, roll_no, section_name, exam_date,
                subject_a_bn, subject_b_bn, start_a, start_b
           FROM app.exam_student_clashes($1)`,
        [examId],
      );

      // Which rows in the list carry the ⚠. A paper is implicated when it
      // appears on either side of a clash on its own date — matching §8.3,
      // where both offending papers are marked, not just the later one.
      const flagged = new Set<string>();
      for (const c of clashes.rows) {
        const d = isoDate(c.exam_date) as string;
        flagged.add(`${d}|${c.subject_a_bn}`);
        flagged.add(`${d}|${c.subject_b_bn}`);
      }

      return {
        exam: {
          id: exam.rows[0].id,
          nameBn: exam.rows[0].name_bn,
          examType: exam.rows[0].exam_type,
          startsOn: isoDate(exam.rows[0].starts_on),
          endsOn: isoDate(exam.rows[0].ends_on),
          status: exam.rows[0].status,
        },
        papers: papers.rows.map((p) => {
          const date = isoDate(p.exam_date);
          return {
            examSubjectId: p.exam_subject_id,
            sectionName: p.section_name,
            subjectBn: p.subject_bn,
            examDate: date,
            startTime: hhmm(p.start_time),
            endTime: endTime(p.start_time, p.duration_minutes),
            durationMinutes: p.duration_minutes,
            hasClash: date !== null && flagged.has(`${date}|${p.subject_bn}`),
          };
        }),
        clashes: clashes.rows.map((c) => ({
          studentNameBn: c.student_name_bn,
          rollNo: c.roll_no,
          sectionName: c.section_name,
          examDate: isoDate(c.exam_date),
          subjectABn: c.subject_a_bn,
          subjectBBn: c.subject_b_bn,
          startA: hhmm(c.start_a),
          startB: hhmm(c.start_b),
        })),
        // §8.3 counts STUDENTS ("৪ জন শিক্ষার্থীর"), not clash rows. One
        // student with three overlapping papers is one affected child.
        affectedStudents: new Set(
          clashes.rows.map((c) => `${c.section_name}|${c.roll_no}`),
        ).size,
        canPublish: clashes.rows.length === 0,
      };
    });

    json(res, 200, payload, cors);
  } catch (err) {
    if (err instanceof HttpError) {
      json(res, err.status, { error: err.code ?? 'error', message: err.message }, cors);
      return;
    }
    json(res, 500, { error: 'internal_error' }, cors);
  }
}
