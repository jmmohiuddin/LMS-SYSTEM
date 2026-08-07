/**
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

    const sectionId = query(req).get('sectionId') ?? '';
    if (!UUID_RE.test(sectionId)) throw new HttpError(400, 'sectionId must be a valid uuid', 'invalid_section_id');

    const db = await sharedDb();
    const exams = await db.withTenant(
      { tenantId: claims.tid, userId: claims.sub, role: claims.role },
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
      json(res, err.status, { error: err.code ?? 'error', message: err.message }, cors);
      return;
    }
    console.error('[exams] unexpected error', err);
    json(res, 500, { error: 'internal_error' }, cors);
  }
}
