/**
 * GET /api/v1/academics/results?studentId=
 *
 * Published exam results for one student. Omit `studentId` and it returns
 * the caller's own — which is the student case, and means a student needs
 * to know nothing but their own token to see their report card.
 *
 * This is the read side of POST /academics/publish: that endpoint computes
 * grades, GPA and section rank into `exam_results` in one transaction, and
 * until now nothing surfaced them. A published result is the single most
 * important thing a student and guardian want from this product, and it
 * was write-only.
 *
 * Visibility is entirely `results_scope` (010_rls_policies.sql): staff see
 * their sections, a student sees their own, a guardian sees their wards' —
 * and crucially the policy adds `published_at IS NOT NULL` for the
 * student/guardian branch, so an unpublished result is invisible to the
 * family while a teacher is still moderating it. authenticate() alone is
 * therefore the correct gate; adding requireStaff here would break the
 * student case the endpoint exists for.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { sharedDb } from '../../../packages/server-core/src/db.ts';
import { corsHeaders, query, json, HttpError } from '../../../packages/server-core/src/http.ts';
import { authenticate } from '../../../packages/server-core/src/auth.ts';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const cors = corsHeaders();
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }
  if (req.method !== 'GET') { json(res, 405, { error: 'method_not_allowed' }, cors); return; }

  try {
    const claims = await authenticate(req);
    const requested = query(req).get('studentId') ?? '';
    if (requested && !UUID_RE.test(requested)) {
      throw new HttpError(400, 'studentId must be a valid uuid', 'invalid_student_id');
    }
    const studentId = requested || claims.sub;

    const db = await sharedDb();
    const rows = await db.withTenant(
      { tenantId: claims.tid, userId: claims.sub, role: claims.role },
      async (client) => {
        const r = await client.query<{
          exam_id: string; exam_name_bn: string; exam_type: string;
          total_marks: string | null; total_max: string | null;
          percentage: string | null; gpa: string | null; letter_grade: string | null;
          subjects_failed: number; is_pass: boolean;
          rank_in_section: number | null; published_at: string | null;
          subjects: unknown;
        }>(
          `SELECT r.exam_id, e.name_bn AS exam_name_bn, e.exam_type::text,
                  r.total_marks::text, r.total_max::text, r.percentage::text,
                  r.gpa::text, r.letter_grade, r.subjects_failed, r.is_pass,
                  r.rank_in_section, r.published_at::text,
                  COALESCE((
                    SELECT jsonb_agg(jsonb_build_object(
                             'subjectBn', sub.name_bn,
                             -- Wireframe §6.5: the component breakdown is
                             -- always visible. It is the board's own
                             -- structure, and collapsing it to a total
                             -- hides which half of the paper went wrong.
                             'cqMarks', m.cq_marks::text,
                             'mcqMarks', m.mcq_marks::text,
                             'practicalMarks', m.practical_marks::text,
                             'caMarks', m.ca_marks::text,
                             'totalMarks', m.total_marks::text,
                             'gradeLetter', m.grade_letter,
                             'gradePoint', m.grade_point::text,
                             'isAbsent', m.is_absent,
                             'componentFailed', m.component_failed,
                             -- Drives the mandatory optional-subject
                             -- footnote (F-709, wireframe §6.5). Read from
                             -- the student's OWN derived set where it
                             -- exists, falling back to the subject flag for
                             -- schools not yet on subject templates.
                             'requirementType',
                               COALESCE(ss.requirement_type,
                                        CASE WHEN sub.is_optional THEN 'optional' END))
                           ORDER BY sub.name_bn)
                      FROM exam_marks m
                      JOIN exam_subjects es ON es.id = m.exam_subject_id
                      JOIN subjects sub ON sub.id = es.subject_id
                      LEFT JOIN enrolments en
                        ON en.student_id = m.student_id AND en.status = 'active'
                      LEFT JOIN student_subjects ss
                        ON ss.enrolment_id = en.id AND ss.subject_id = sub.id
                     WHERE es.exam_id = r.exam_id AND m.student_id = r.student_id
                  ), '[]'::jsonb) AS subjects
             FROM exam_results r
             JOIN exams e ON e.id = r.exam_id
            WHERE r.student_id = $1
            ORDER BY r.published_at DESC NULLS LAST, e.starts_on DESC`,
          [studentId],
        );
        return r.rows;
      },
    );

    json(res, 200, {
      studentId,
      results: rows.map((r) => ({
        examId: r.exam_id,
        examNameBn: r.exam_name_bn,
        examType: r.exam_type,
        totalMarks: r.total_marks,
        totalMax: r.total_max,
        percentage: r.percentage,
        gpa: r.gpa,
        letterGrade: r.letter_grade,
        subjectsFailed: r.subjects_failed,
        isPass: r.is_pass,
        rankInSection: r.rank_in_section,
        publishedAt: r.published_at,
        subjects: r.subjects,
      })),
    }, cors);
  } catch (err) {
    if (err instanceof HttpError) {
      json(res, err.status, { error: err.code ?? 'error', message: err.message }, cors);
      return;
    }
    console.error('[results] unexpected error', err);
    json(res, 500, { error: 'internal_error' }, cors);
  }
}
