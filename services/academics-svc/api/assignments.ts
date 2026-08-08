/**
 * GET  /api/v1/academics/assignments?sectionId=       — list (inbox / teacher view)
 * GET  /api/v1/academics/assignments?assignmentId=    — one, with submissions
 * POST /api/v1/academics/assignments                  — create (staff)
 * PATCH-ish via POST with {submissionId, marksAwarded, feedbackBn} — grade
 *
 * Student *submissions* do not come through here — they ride the offline
 * outbox as `assignment_submission` ops into POST /api/v1/sync/push, so a
 * student writing an answer with no signal doesn't lose it. This endpoint
 * is the read side plus the two staff-authored writes (create, grade).
 *
 * Section scoping: a student's list is filtered by RLS
 * (assignment_read_scope joins enrolments through app.can_see_student), so
 * omitting sectionId returns exactly the assignments that student can see.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { sharedDb } from '../../../packages/server-core/src/db.ts';
import { corsHeaders, query, readJson, json, HttpError } from '../../../packages/server-core/src/http.ts';
import { authenticate, requireStaff } from '../../../packages/server-core/src/auth.ts';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface CreateBody {
  sectionId?: string;
  subjectId?: string;
  academicYearId?: string;
  lessonId?: string | null;
  titleBn?: string;
  instructionsBn?: string;
  maxMarks?: number | null;
  dueAt?: string;
  allowsLate?: boolean;
  status?: 'draft' | 'open';
}

interface GradeBody {
  submissionId?: string;
  marksAwarded?: number;
  feedbackBn?: string;
}

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const cors = corsHeaders();
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }

  try {
    const claims = await authenticate(req);
    const db = await sharedDb();
    const ctx = { tenantId: claims.tid, userId: claims.sub, role: claims.role };

    /* ------------------------------------------------------------- create/grade */
    if (req.method === 'POST') {
      requireStaff(claims);
      const body = await readJson<CreateBody & GradeBody>(req);

      // Grading is a POST with a submissionId — keeps the endpoint count
      // down under the Hobby function cap without a separate route.
      if (body.submissionId) {
        if (!UUID_RE.test(body.submissionId)) {
          throw new HttpError(400, 'submissionId must be a valid uuid', 'invalid_submission_id');
        }
        const marks = Number(body.marksAwarded);
        if (!Number.isFinite(marks) || marks < 0) {
          throw new HttpError(400, 'marksAwarded must be a non-negative number', 'invalid_marks');
        }
        const graded = await db.withTenant(ctx, async (client) => {
          const r = await client.query<{ id: string }>(
            `UPDATE assignment_submissions s
                SET marks_awarded = $2, feedback_bn = $3,
                    graded_by = $4, graded_at = now(),
                    row_version = s.row_version + 1
              FROM assignments a
             WHERE s.id = $1
               AND a.id = s.assignment_id
               AND ($2::numeric <= COALESCE(a.max_marks, $2::numeric))
             RETURNING s.id`,
            [body.submissionId, marks, body.feedbackBn ?? null, claims.sub],
          );
          if (r.rowCount === 0) {
            throw new HttpError(422, 'submission not found or marks exceed the maximum', 'grade_rejected');
          }
          return r.rows[0].id;
        });
        json(res, 200, { ok: true, submissionId: graded }, cors);
        return;
      }

      // Otherwise: create an assignment.
      const sectionId = body.sectionId ?? '';
      const subjectId = body.subjectId ?? '';
      const academicYearId = body.academicYearId ?? '';
      const titleBn = (body.titleBn ?? '').trim();
      const dueAt = body.dueAt ?? '';

      if (!UUID_RE.test(sectionId)) throw new HttpError(400, 'sectionId must be a valid uuid', 'invalid_section_id');
      if (!UUID_RE.test(subjectId)) throw new HttpError(400, 'subjectId must be a valid uuid', 'invalid_subject_id');
      if (!UUID_RE.test(academicYearId)) throw new HttpError(400, 'academicYearId must be a valid uuid', 'invalid_year_id');
      if (!titleBn) throw new HttpError(400, 'titleBn is required', 'title_required');
      if (!Number.isFinite(Date.parse(dueAt))) throw new HttpError(400, 'dueAt must be ISO 8601', 'invalid_due_at');
      if (Date.parse(dueAt) <= Date.now()) {
        throw new HttpError(400, 'dueAt must be in the future', 'due_in_past');
      }

      const created = await db.withTenant(ctx, async (client) => {
        const r = await client.query<{ id: string }>(
          `INSERT INTO assignments
             (tenant_id, section_id, subject_id, academic_year_id, lesson_id,
              title_bn, instructions_bn, max_marks, due_at, allows_late,
              created_by, status)
           VALUES (app.current_tenant(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
           RETURNING id`,
          [
            sectionId, subjectId, academicYearId,
            body.lessonId && UUID_RE.test(body.lessonId) ? body.lessonId : null,
            titleBn, body.instructionsBn ?? null,
            body.maxMarks ?? null, dueAt, body.allowsLate ?? true,
            claims.sub, body.status === 'draft' ? 'draft' : 'open',
          ],
        );
        return r.rows[0].id;
      });
      json(res, 200, { ok: true, assignmentId: created }, cors);
      return;
    }

    if (req.method !== 'GET') { json(res, 405, { error: 'method_not_allowed' }, cors); return; }

    /* -------------------------------------------------- one assignment + subs */
    const assignmentId = query(req).get('assignmentId') ?? '';
    if (assignmentId) {
      if (!UUID_RE.test(assignmentId)) {
        throw new HttpError(400, 'assignmentId must be a valid uuid', 'invalid_assignment_id');
      }
      const detail = await db.withTenant(ctx, async (client) => {
        const a = await client.query<{
          id: string; title_bn: string; instructions_bn: string | null;
          max_marks: string | null; due_at: string; allows_late: boolean;
          status: string; subject_bn: string; section_name: string;
        }>(
          `SELECT a.id, a.title_bn, a.instructions_bn, a.max_marks::text,
                  a.due_at::text, a.allows_late, a.status,
                  sub.name_bn AS subject_bn, sec.name AS section_name
             FROM assignments a
             JOIN subjects sub ON sub.id = a.subject_id
             JOIN sections sec ON sec.id = a.section_id
            WHERE a.id = $1`,
          [assignmentId],
        );
        if (a.rowCount === 0) throw new HttpError(404, 'assignment not found', 'assignment_not_found');

        // RLS filters this to own/ward/section rows automatically.
        const subs = await client.query<{
          id: string; student_id: string; full_name_bn: string | null; roll_no: number | null;
          body_bn: string | null; submitted_at: string; is_late: boolean;
          marks_awarded: string | null; feedback_bn: string | null; graded_at: string | null;
        }>(
          `SELECT s.id, s.student_id, u.full_name_bn, e.roll_no,
                  s.body_bn, s.submitted_at::text, s.is_late,
                  s.marks_awarded::text, s.feedback_bn, s.graded_at::text
             FROM assignment_submissions s
             JOIN users u ON u.id = s.student_id
             LEFT JOIN enrolments e
               ON e.student_id = s.student_id AND e.status = 'active'
            WHERE s.assignment_id = $1
            ORDER BY e.roll_no NULLS LAST, s.submitted_at`,
          [assignmentId],
        );

        const row = a.rows[0];
        return {
          assignment: {
            id: row.id,
            titleBn: row.title_bn,
            instructionsBn: row.instructions_bn,
            maxMarks: row.max_marks,
            dueAt: row.due_at,
            allowsLate: row.allows_late,
            status: row.status,
            subjectBn: row.subject_bn,
            sectionName: row.section_name,
          },
          submissions: subs.rows.map((s) => ({
            id: s.id,
            studentId: s.student_id,
            fullNameBn: s.full_name_bn,
            rollNo: s.roll_no,
            bodyBn: s.body_bn,
            submittedAt: s.submitted_at,
            isLate: s.is_late,
            marksAwarded: s.marks_awarded,
            feedbackBn: s.feedback_bn,
            gradedAt: s.graded_at,
          })),
        };
      });
      json(res, 200, detail, cors);
      return;
    }

    /* ------------------------------------------------------------------ list */
    const sectionId = query(req).get('sectionId') ?? '';
    if (sectionId && !UUID_RE.test(sectionId)) {
      throw new HttpError(400, 'sectionId must be a valid uuid', 'invalid_section_id');
    }

    const list = await db.withTenant(ctx, async (client) => {
      const r = await client.query<{
        id: string; title_bn: string; due_at: string; status: string;
        max_marks: string | null; subject_bn: string; section_name: string;
        submission_count: number; ungraded_count: number;
        my_submitted_at: string | null; my_marks: string | null; my_graded_at: string | null;
      }>(
        `SELECT a.id, a.title_bn, a.due_at::text, a.status, a.max_marks::text,
                sub.name_bn AS subject_bn, sec.name AS section_name,
                (SELECT count(*)::int FROM assignment_submissions s
                  WHERE s.assignment_id = a.id) AS submission_count,
                (SELECT count(*)::int FROM assignment_submissions s
                  WHERE s.assignment_id = a.id AND s.graded_at IS NULL) AS ungraded_count,
                mine.submitted_at::text AS my_submitted_at,
                mine.marks_awarded::text AS my_marks,
                mine.graded_at::text AS my_graded_at
           FROM assignments a
           JOIN subjects sub ON sub.id = a.subject_id
           JOIN sections sec ON sec.id = a.section_id
           LEFT JOIN assignment_submissions mine
             ON mine.assignment_id = a.id AND mine.student_id = $2
          WHERE ($1::uuid IS NULL OR a.section_id = $1)
          ORDER BY a.due_at DESC
          LIMIT 100`,
        [sectionId || null, claims.sub],
      );
      return r.rows;
    });

    json(res, 200, {
      assignments: list.map((a) => ({
        id: a.id,
        titleBn: a.title_bn,
        dueAt: a.due_at,
        status: a.status,
        maxMarks: a.max_marks,
        subjectBn: a.subject_bn,
        sectionName: a.section_name,
        submissionCount: a.submission_count,
        ungradedCount: a.ungraded_count,
        mySubmission: a.my_submitted_at
          ? { submittedAt: a.my_submitted_at, marksAwarded: a.my_marks, gradedAt: a.my_graded_at }
          : null,
      })),
    }, cors);
  } catch (err) {
    if (err instanceof HttpError) {
      json(res, err.status, { error: err.code ?? 'error', message: err.message }, cors);
      return;
    }
    console.error('[assignments] unexpected error', err);
    json(res, 500, { error: 'internal_error' }, cors);
  }
}
