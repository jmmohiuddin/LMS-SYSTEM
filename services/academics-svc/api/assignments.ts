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

/** What the loser of a grading race is told. See the grade branch below. */
export interface GradeConflictDetail {
  submissionId: string;
  expectedRowVersion: number;
  currentRowVersion: number;
  yours: { marksAwarded: number; feedbackBn: string | null };
  theirs: {
    marksAwarded: string | null;
    feedbackBn: string | null;
    gradedAt: string | null;
    gradedByName: string | null;
  };
}

/**
 * F-103. Carries the full conflict payload, which a plain HttpError cannot
 * — and the payload is the point. A 409 with only a message would leave the
 * teacher no way to see what the other mark was without leaving the screen.
 */
export class GradeConflict extends Error {
  readonly detail: GradeConflictDetail;
  constructor(detail: GradeConflictDetail) {
    super('this submission was graded by someone else while you were working');
    this.detail = detail;
  }
}

interface CreateBody {
  sectionId?: string;
  subjectId?: string;
  academicYearId?: string;
  topicId?: string | null;
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
  /**
   * F-103. The row_version the grader was looking at when they typed the
   * mark. Required — see the grade branch below for why it cannot be
   * optional.
   */
  rowVersion?: number;
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

        // F-103. The optimistic lock. `rowVersion` is what the grader's
        // screen was showing; the UPDATE below only applies if the row is
        // still on that version.
        //
        // It is mandatory, not optional-with-a-default. An optional lock is
        // not a lock: every caller that forgets it — a script, an old build
        // of the PWA, a retry — silently gets last-write-wins back, which is
        // the exact behaviour this requirement exists to remove. A missing
        // rowVersion is a client bug and is rejected as one.
        const rowVersion = Number(body.rowVersion);
        if (!Number.isInteger(rowVersion) || rowVersion < 1) {
          throw new HttpError(
            400,
            'rowVersion is required — re-read the submission and send the version you graded',
            'row_version_required',
          );
        }

        const graded = await db.withTenant(ctx, async (client) => {
          const r = await client.query<{ id: string; row_version: number }>(
            `UPDATE assignment_submissions s
                SET marks_awarded = $2, feedback_bn = $3,
                    graded_by = $4, graded_at = now(),
                    row_version = s.row_version + 1
              FROM assignments a
             WHERE s.id = $1
               AND a.id = s.assignment_id
               AND s.row_version = $5
               AND ($2::numeric <= COALESCE(a.max_marks, $2::numeric))
             RETURNING s.id, s.row_version`,
            [body.submissionId, marks, body.feedbackBn ?? null, claims.sub, rowVersion],
          );
          if (r.rowCount === 0) {
            // Three different failures land here and they need three
            // different answers, so ask the row why. Returning one generic
            // 422 for all of them — what this endpoint did before — tells a
            // teacher whose colleague just graded the same script that their
            // marks were "rejected", and they retype them.
            const cur = await client.query<{
              row_version: number; marks_awarded: string | null; feedback_bn: string | null;
              graded_at: string | null; grader_name: string | null; max_marks: string | null;
            }>(
              `SELECT s.row_version, s.marks_awarded::text, s.feedback_bn,
                      s.graded_at::text, g.full_name_bn AS grader_name,
                      a.max_marks::text
                 FROM assignment_submissions s
                 JOIN assignments a ON a.id = s.assignment_id
                 LEFT JOIN users g ON g.id = s.graded_by
                WHERE s.id = $1`,
              [body.submissionId],
            );
            const row = cur.rows[0];
            if (!row) {
              throw new HttpError(404, 'submission not found', 'submission_not_found');
            }
            if (row.max_marks !== null && marks > Number(row.max_marks)) {
              throw new HttpError(
                422,
                `marksAwarded exceeds the assignment maximum of ${row.max_marks}`,
                'marks_exceed_max',
              );
            }
            // Nothing else can have caused it: the row exists and the marks
            // fit, so somebody else wrote to it first.
            //
            // The server does NOT merge and does NOT pick a winner. It
            // returns both sides and stops. Deciding whose mark stands is a
            // judgement about a child's grade — a person makes it, with the
            // other person's name in front of them.
            throw new GradeConflict({
              submissionId: body.submissionId!,
              expectedRowVersion: rowVersion,
              currentRowVersion: row.row_version,
              yours: { marksAwarded: marks, feedbackBn: body.feedbackBn ?? null },
              theirs: {
                marksAwarded: row.marks_awarded,
                feedbackBn: row.feedback_bn,
                gradedAt: row.graded_at,
                gradedByName: row.grader_name,
              },
            });
          }
          return r.rows[0];
        });
        json(res, 200, {
          ok: true,
          submissionId: graded.id,
          // Echoed so a grader can correct a mark twice in a row without
          // re-reading the list in between.
          rowVersion: graded.row_version,
        }, cors);
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
             (tenant_id, section_id, subject_id, academic_year_id, topic_id,
              title_bn, instructions_bn, max_marks, due_at, allows_late,
              created_by, status)
           VALUES (app.current_tenant(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
           RETURNING id`,
          [
            sectionId, subjectId, academicYearId,
            body.topicId && UUID_RE.test(body.topicId) ? body.topicId : null,
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
          row_version: number; grader_name: string | null;
        }>(
          `SELECT s.id, s.student_id, u.full_name_bn, e.roll_no,
                  s.body_bn, s.submitted_at::text, s.is_late,
                  s.marks_awarded::text, s.feedback_bn, s.graded_at::text,
                  s.row_version, g.full_name_bn AS grader_name
             FROM assignment_submissions s
             JOIN users u ON u.id = s.student_id
             LEFT JOIN users g ON g.id = s.graded_by
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
            gradedByName: s.grader_name,
            // F-103. The grading screen must send this back with the mark;
            // a client that never received it cannot grade at all, which is
            // the intended coupling.
            rowVersion: s.row_version,
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
    if (err instanceof GradeConflict) {
      // 409, not 422: nothing about the request was invalid. The state
      // moved underneath it, and the resolution belongs to a person.
      json(res, 409, { error: 'grade_conflict', message: err.message, conflict: err.detail }, cors);
      return;
    }
    if (err instanceof HttpError) {
      json(res, err.status, { error: err.code ?? 'error', message: err.message }, cors);
      return;
    }
    console.error('[assignments] unexpected error', err);
    json(res, 500, { error: 'internal_error' }, cors);
  }
}
