/**
 * GET /api/v1/academics/marks?examSubjectId=...
 *
 * The read side of marks entry: the section's active roster LEFT JOINed with
 * whatever exam_marks rows already exist for that exam subject, so the entry
 * screen can render every student with their current values and rowVersion
 * (the optimistic-concurrency token the exam_mark applier checks — see
 * services/sync-svc/src/appliers.ts). Also returns the context the outbox
 * op payload needs (academicYearId) and the component maxima for input
 * validation.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { sharedDb } from '../../../packages/server-core/src/db.ts';
import { corsHeaders, query, json, HttpError } from '../../../packages/server-core/src/http.ts';
import { authenticate, requireStaff } from '../../../packages/server-core/src/auth.ts';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const cors = corsHeaders();
  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors);
    res.end();
    return;
  }
  if (req.method !== 'GET') {
    json(res, 405, { error: 'method_not_allowed' }, cors);
    return;
  }

  try {
    const claims = await authenticate(req);
    requireStaff(claims);

    const examSubjectId = query(req).get('examSubjectId') ?? '';
    if (!UUID_RE.test(examSubjectId)) {
      throw new HttpError(400, 'examSubjectId must be a valid uuid', 'invalid_exam_subject_id');
    }

    const db = await sharedDb();
    const result = await db.withTenant(
      { tenantId: claims.tid, userId: claims.sub, role: claims.role },
      async (client) => {
        const esRes = await client.query<{
          section_id: string;
          exam_id: string;
          academic_year_id: string;
          exam_status: string;
          marking_locked: boolean;
          cq_max: string; mcq_max: string; practical_max: string; ca_max: string;
        }>(
          `SELECT es.section_id, es.exam_id, e.academic_year_id, e.status AS exam_status,
                  es.marking_locked, es.cq_max, es.mcq_max, es.practical_max, es.ca_max
             FROM exam_subjects es JOIN exams e ON e.id = es.exam_id
            WHERE es.id = $1`,
          [examSubjectId],
        );
        const es = esRes.rows[0];
        if (!es) throw new HttpError(404, 'exam subject not found', 'exam_subject_not_found');

        const rows = await client.query<{
          roll_no: number;
          student_id: string;
          full_name_bn: string | null;
          full_name_en: string | null;
          cq_marks: string | null;
          mcq_marks: string | null;
          practical_marks: string | null;
          ca_marks: string | null;
          total_marks: string | null;
          is_absent: boolean | null;
          grade_letter: string | null;
          row_version: number | null;
        }>(
          `SELECT en.roll_no, en.student_id, u.full_name_bn, u.full_name_en,
                  m.cq_marks, m.mcq_marks, m.practical_marks, m.ca_marks,
                  m.total_marks, m.is_absent, m.grade_letter, m.row_version
             FROM enrolments en
             JOIN users u ON u.id = en.student_id
             LEFT JOIN exam_marks m
               ON m.exam_subject_id = $1 AND m.student_id = en.student_id
            WHERE en.section_id = $2 AND en.status = 'active'
            ORDER BY en.roll_no`,
          [examSubjectId, es.section_id],
        );

        return {
          examSubjectId,
          examId: es.exam_id,
          sectionId: es.section_id,
          academicYearId: es.academic_year_id,
          examStatus: es.exam_status,
          markingLocked: es.marking_locked,
          maxima: {
            cq: Number(es.cq_max),
            mcq: Number(es.mcq_max),
            practical: Number(es.practical_max),
            ca: Number(es.ca_max),
          },
          marks: rows.rows.map((r) => ({
            rollNo: r.roll_no,
            studentId: r.student_id,
            fullName: { bn: r.full_name_bn, en: r.full_name_en },
            cqMarks: r.cq_marks === null ? null : Number(r.cq_marks),
            mcqMarks: r.mcq_marks === null ? null : Number(r.mcq_marks),
            practicalMarks: r.practical_marks === null ? null : Number(r.practical_marks),
            caMarks: r.ca_marks === null ? null : Number(r.ca_marks),
            totalMarks: r.total_marks === null ? null : Number(r.total_marks),
            isAbsent: r.is_absent ?? false,
            gradeLetter: r.grade_letter,
            rowVersion: r.row_version,
          })),
        };
      },
    );

    json(res, 200, result, cors);
  } catch (err) {
    if (err instanceof HttpError) {
      json(res, err.status, { error: err.code ?? 'error', message: err.message }, cors);
      return;
    }
    console.error('[marks] unexpected error', err);
    json(res, 500, { error: 'internal_error' }, cors);
  }
}
