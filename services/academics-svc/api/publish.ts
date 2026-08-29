/**
 * POST /api/v1/academics/publish
 * Body: { examId }
 *
 * The result-publication flow: turns entered marks into published results in
 * one transaction, using the board-rules functions migration 005 installed:
 *
 *   1. grade every exam_marks row via app.compute_subject_grade()
 *      (component-wise pass rule, absentee handling, band lookup)
 *   2. upsert exam_results per student via app.compute_exam_gpa()
 *      (compulsory-F ⇒ 0.00, optional-subject bonus, 5.00 cap)
 *   3. rank within section
 *   4. lock marking and set the exam published
 *
 * After step 4 the block_published_mark_update trigger makes every mark row
 * immutable — corrections must go through mark_corrections with approval.
 * Publication is deliberately all-or-nothing: any failure rolls the whole
 * transaction back and the exam stays in 'marking'.
 *
 * requireRole mirrors what publication means legally: principal-level.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { sharedDb } from '../../../packages/server-core/src/db.ts';
import { corsHeaders, readJson, json, HttpError } from '../../../packages/server-core/src/http.ts';
import { authenticate, requireRole } from '../../../packages/server-core/src/auth.ts';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PUBLISH_ROLES = ['principal', 'school_owner', 'academic_coordinator'];

interface PublishBody { examId?: string }

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const cors = corsHeaders();
  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors);
    res.end();
    return;
  }
  // R-3, Part H. The screen that calls POST needs to know what is publishable
  // and how complete each exam's marks are, and that read belongs HERE rather
  // than in exams.ts: exams.ts answers "what does this section sit, and what
  // are the component maxima" for the marks-entry form, which is a different
  // question with a different shape (it requires a sectionId). Publication
  // readiness is institution-wide by nature.
  if (req.method === 'GET') {
    try {
      const claims = await authenticate(req);
      requireRole(claims, PUBLISH_ROLES);
      const db = await sharedDb();
      const exams = await db.withTenant(
        { tenantId: claims.tid, userId: claims.sub, role: claims.role },
        async (client) => {
          const r = await client.query<{
            exam_id: string; name_bn: string; status: string;
            starts_on: string | null; ends_on: string | null;
            exam_subject_id: string | null; subject_bn: string | null;
            section_name: string | null; enrolled: number; marked: number;
          }>(
            `SELECT e.id AS exam_id, e.name_bn, e.status::text AS status,
                    e.starts_on::text, e.ends_on::text,
                    es.id AS exam_subject_id, sub.name_bn AS subject_bn,
                    s.name AS section_name,
                    -- Enrolled is the denominator a head teacher checks
                    -- against: how many children should have a mark here.
                    COALESCE(s.student_count, 0)::int AS enrolled,
                    (SELECT count(*)::int FROM exam_marks m
                      WHERE m.exam_subject_id = es.id) AS marked
               FROM exams e
               LEFT JOIN exam_subjects es ON es.exam_id = e.id
               LEFT JOIN subjects sub     ON sub.id = es.subject_id
               LEFT JOIN sections s       ON s.id = es.section_id
              WHERE e.academic_year_id = (
                      SELECT id FROM academic_years
                       ORDER BY is_current DESC, starts_on DESC LIMIT 1)
              ORDER BY e.starts_on DESC NULLS LAST, sub.name_bn`,
          );

          const byExam = new Map<string, {
            examId: string; examNameBn: string; status: string;
            startsOn: string | null; endsOn: string | null;
            subjects: { examSubjectId: string; subjectBn: string;
                        sectionName: string | null; enrolled: number; marked: number }[];
          }>();
          for (const row of r.rows) {
            let exam = byExam.get(row.exam_id);
            if (!exam) {
              exam = {
                examId: row.exam_id, examNameBn: row.name_bn, status: row.status,
                startsOn: row.starts_on, endsOn: row.ends_on, subjects: [],
              };
              byExam.set(row.exam_id, exam);
            }
            // LEFT JOIN: an exam with no subjects yet is a real state and
            // must appear, marked as not ready, rather than vanishing.
            if (row.exam_subject_id) {
              exam.subjects.push({
                examSubjectId: row.exam_subject_id,
                subjectBn: row.subject_bn ?? '',
                sectionName: row.section_name,
                enrolled: row.enrolled,
                marked: row.marked,
              });
            }
          }
          return [...byExam.values()];
        },
      );
      json(res, 200, { exams }, cors);
    } catch (err) {
      if (err instanceof HttpError) {
        json(res, err.status, { error: err.code, message: err.message }, cors);
        return;
      }
      json(res, 500, { error: 'internal_error' }, cors);
    }
    return;
  }

  if (req.method !== 'POST') {
    json(res, 405, { error: 'method_not_allowed' }, cors);
    return;
  }

  try {
    const claims = await authenticate(req);
    requireRole(claims, PUBLISH_ROLES);

    const body = await readJson<PublishBody>(req);
    const examId = body.examId ?? '';
    if (!UUID_RE.test(examId)) throw new HttpError(400, 'examId must be a valid uuid', 'invalid_exam_id');

    const db = await sharedDb();
    const result = await db.withTenant(
      { tenantId: claims.tid, userId: claims.sub, role: claims.role },
      async (client) => {
        const examRes = await client.query<{ status: string; academic_year_id: string }>(
          `SELECT status, academic_year_id FROM exams WHERE id = $1`,
          [examId],
        );
        const exam = examRes.rows[0];
        if (!exam) throw new HttpError(404, 'exam not found', 'exam_not_found');
        if (exam.status === 'published' || exam.status === 'locked') {
          throw new HttpError(409, 'exam is already published', 'already_published');
        }

        // The tenant's current default grading scale (provisioned by
        // app.provision_tenant with the standard BD board bands).
        const scaleRes = await client.query<{ id: string }>(
          `SELECT id FROM grading_scales
            WHERE is_default
              AND effective_from <= CURRENT_DATE
              AND (effective_to IS NULL OR effective_to >= CURRENT_DATE)
            ORDER BY effective_from DESC LIMIT 1`,
        );
        const scaleId = scaleRes.rows[0]?.id;
        if (!scaleId) throw new HttpError(422, 'no default grading scale configured', 'no_grading_scale');

        // 1. Per-subject grades (board rule 1 lives inside the function).
        const graded = await client.query(
          `UPDATE exam_marks m
              SET grade_letter = g.letter,
                  grade_point = g.grade_point,
                  component_failed = g.component_failed,
                  row_version = m.row_version + 1
             FROM exam_subjects es,
                  LATERAL app.compute_subject_grade(
                    app.current_tenant(),
                    m.cq_marks, es.cq_max, es.cq_pass,
                    m.mcq_marks, es.mcq_max, es.mcq_pass,
                    m.practical_marks, m.ca_marks,
                    es.cq_max + es.mcq_max + es.practical_max + es.ca_max,
                    m.is_absent, $2::uuid) g
            WHERE es.id = m.exam_subject_id
              AND es.exam_id = $1`,
          [examId, scaleId],
        );

        // 2. One exam_results row per student (board rules 2-4 inside
        // compute_exam_gpa; overall letter from the standard GPA bands).
        const results = await client.query(
          `INSERT INTO exam_results
             (tenant_id, exam_id, student_id, section_id, academic_year_id,
              total_marks, total_max, percentage, gpa, gpa_without_optional,
              letter_grade, subjects_failed, is_pass, computed_at, published_at)
           SELECT app.current_tenant(), $1, s.student_id, s.section_id, $2,
                  s.total_marks, s.total_max,
                  CASE WHEN s.total_max > 0 THEN round(s.total_marks / s.total_max * 100, 2) ELSE 0 END,
                  g.gpa, g.gpa_no_optional,
                  CASE
                    WHEN NOT g.is_pass THEN 'F'
                    WHEN g.gpa >= 5.00 THEN 'A+'
                    WHEN g.gpa >= 4.00 THEN 'A'
                    WHEN g.gpa >= 3.50 THEN 'A-'
                    WHEN g.gpa >= 3.00 THEN 'B'
                    WHEN g.gpa >= 2.00 THEN 'C'
                    WHEN g.gpa >= 1.00 THEN 'D'
                    ELSE 'F'
                  END,
                  g.failed_count, g.is_pass, now(), now()
             FROM (SELECT m.student_id,
                          MIN(es.section_id::text)::uuid AS section_id,
                          SUM(m.total_marks) AS total_marks,
                          SUM(es.cq_max + es.mcq_max + es.practical_max + es.ca_max) AS total_max
                     FROM exam_marks m
                     JOIN exam_subjects es ON es.id = m.exam_subject_id
                    WHERE es.exam_id = $1
                    GROUP BY m.student_id) s,
                  LATERAL app.compute_exam_gpa(app.current_tenant(), $1, s.student_id) g
           ON CONFLICT (tenant_id, exam_id, student_id) DO UPDATE
             SET total_marks = EXCLUDED.total_marks,
                 total_max = EXCLUDED.total_max,
                 percentage = EXCLUDED.percentage,
                 gpa = EXCLUDED.gpa,
                 gpa_without_optional = EXCLUDED.gpa_without_optional,
                 letter_grade = EXCLUDED.letter_grade,
                 subjects_failed = EXCLUDED.subjects_failed,
                 is_pass = EXCLUDED.is_pass,
                 computed_at = now(),
                 published_at = now()`,
          [examId, exam.academic_year_id],
        );

        // 3. Section ranks (dense: equal GPA+total shares a rank).
        await client.query(
          `UPDATE exam_results r
              SET rank_in_section = s.rk
             FROM (SELECT id,
                          DENSE_RANK() OVER (PARTITION BY section_id
                                             ORDER BY gpa DESC, total_marks DESC) AS rk
                     FROM exam_results
                    WHERE exam_id = $1) s
            WHERE r.id = s.id`,
          [examId],
        );

        // 4. Freeze: marking locked, exam published. From here every mark
        // edit is rejected by block_published_mark_update.
        await client.query(
          `UPDATE exam_subjects SET marking_locked = true WHERE exam_id = $1`,
          [examId],
        );
        await client.query(
          `UPDATE exams
              SET status = 'published', published_at = now(), published_by = $2
            WHERE id = $1`,
          [examId, claims.sub],
        );

        // R-2. A result is the one thing a guardian is waiting for, so it
        // announces itself — to the sections that sat the exam and their
        // guardians, in this same transaction. Idempotent on
        // (tenant, 'result', examId); the endpoint already refuses a second
        // publish, and this would refuse it again if it did not.
        //
        // The notice says results are available; it carries no marks. A grade
        // is not something to put in a notification a sibling might read over
        // a shoulder — the app is where it belongs, behind that student's own
        // login.
        const resultSections = await client.query<{ ids: string[] }>(
          `SELECT COALESCE(array_agg(DISTINCT section_id), '{}') AS ids
             FROM exam_subjects WHERE exam_id = $1`,
          [examId],
        );
        const secIds = resultSections.rows[0]?.ids ?? [];
        let notified = 0;
        if (secIds.length > 0) {
          const emitted = await client.query<{ recipients: number }>(
            `SELECT recipients FROM app.emit_auto_notice(
               'result', $1::uuid, $2, $3, 'exam'::notice_category,
               jsonb_build_object('type','section','ids', to_jsonb($4::uuid[])), false)`,
            [
              examId,
              'পরীক্ষার ফলাফল প্রকাশিত হয়েছে',
              'অ্যাপের ফলাফল অংশে নিজের ফলাফল দেখা যাবে।',
              secIds,
            ],
          );
          notified = emitted.rows[0]?.recipients ?? 0;
        }

        return {
          marksGraded: graded.rowCount ?? 0,
          resultsPublished: results.rowCount ?? 0,
          notified,
        };
      },
    );

    json(res, 200, { ok: true, examId, ...result }, cors);
  } catch (err) {
    if (err instanceof HttpError) {
      json(res, err.status, { error: err.code ?? 'error', message: err.message }, cors);
      return;
    }
    console.error('[publish] unexpected error', err);
    json(res, 500, { error: 'internal_error' }, cors);
  }
}
