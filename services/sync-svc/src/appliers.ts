/**
 * Per-entity appliers.
 *
 * Each takes one op and either applies it, reports a conflict, or rejects it.
 * They run inside a transaction that already has the tenant context set, so
 * RLS is doing the isolation work — an applier never filters by tenant itself.
 */
import type pg from 'pg';
import type { OutboxOp, PushResult } from '../../../packages/offline/src/types.ts';

export type Applier = (c: pg.PoolClient, op: OutboxOp) => Promise<PushResult>;

const applied = (opId: string, rowVersion?: number, sideEffects?: Record<string, number>): PushResult => ({
  opId,
  status: 'applied',
  rowVersion,
  ...(sideEffects ? { sideEffects } : {}),
});

const conflict = (opId: string, reason: string, serverValue: unknown, clientValue: unknown): PushResult => ({
  opId,
  status: 'conflict',
  conflict: { reason, serverValue, clientValue },
});

const rejected = (opId: string, code: string, retryable = false, message?: string): PushResult => ({
  opId,
  status: 'rejected',
  error: { code, retryable, message },
});

/* ---------------------------------------------------------------- attendance */

interface AttendancePayload {
  sessionId: string;
  sectionId: string;
  academicYearId: string;
  routineSlotId?: string | null;
  subjectId?: string | null;
  takenOn: string;
  periodNo?: number | null;
  mode?: 'section_daily' | 'period_wise';
  records: Array<{
    studentId: string;
    status: 'present' | 'absent' | 'late' | 'excused' | 'half_day';
    minutesLate?: number;
    remark?: string;
  }>;
}

/**
 * A whole attendance session arrives as ONE op — session header plus every
 * student row. That is deliberate: attendance is atomic from the teacher's
 * point of view, and 60 separate ops would mean 60 chances for a partial sync
 * to leave a half-marked register.
 */
export const applyAttendanceSession: Applier = async (c, op) => {
  const p = op.payload as AttendancePayload;

  if (!p?.sessionId || !p.sectionId || !p.takenOn || !Array.isArray(p.records)) {
    return rejected(op.opId, 'MALFORMED_PAYLOAD');
  }

  // The section must be visible under this tenant+role. RLS already scoped it;
  // an empty result means the actor has no business writing here.
  const sec = await c.query(`SELECT id FROM sections WHERE id = $1`, [p.sectionId]);
  if (sec.rowCount === 0) return rejected(op.opId, 'SECTION_NOT_ASSIGNED');

  const mode = p.mode ?? 'section_daily';

  // uq_attendance_session is UNIQUE NULLS NOT DISTINCT (tenant, section,
  // taken_on, period_no, mode), so a resubmitted session merges instead of
  // duplicating — including the section_daily case where period_no is NULL.
  const session = await c.query<{ id: string; is_locked: boolean; row_version: number }>(
    `INSERT INTO attendance_sessions
       (id, tenant_id, section_id, academic_year_id, routine_slot_id, subject_id,
        taken_on, period_no, mode, taken_by, taken_at, device_id)
     VALUES ($1, app.current_tenant(), $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     ON CONFLICT (tenant_id, section_id, taken_on, period_no, mode) DO UPDATE
       SET taken_by = EXCLUDED.taken_by,
           taken_at = EXCLUDED.taken_at,
           row_version = attendance_sessions.row_version + 1
     RETURNING id, is_locked, row_version`,
    [
      p.sessionId, p.sectionId, p.academicYearId, p.routineSlotId ?? null, p.subjectId ?? null,
      p.takenOn, p.periodNo ?? null, mode, op.actorId, op.occurredAt, op.deviceId,
    ],
  );

  const s = session.rows[0];

  if (s.is_locked) {
    // The absence SMS batch has already fired for this session. Re-marking it
    // wholesale would rewrite what parents were told; corrections must go
    // through attendance_corrections with an approver.
    return conflict(op.opId, 'session_locked', { sessionId: s.id, isLocked: true }, p);
  }

  let present = 0;
  let absent = 0;
  let late = 0;

  for (const r of p.records) {
    if (r.status === 'present') present++;
    else if (r.status === 'absent') absent++;
    else if (r.status === 'late') late++;

    await c.query(
      `INSERT INTO attendance_records
         (tenant_id, session_id, student_id, section_id, taken_on, status,
          minutes_late, remark, marked_by, marked_at, op_id, device_id, sms_state)
       VALUES (app.current_tenant(), $1, $2, $3, $4, $5::attendance_status, $6, $7, $8, $9, $10, $11,
               -- $5 is referenced twice: once as the enum column and once in a
               -- text CASE. Without the casts Postgres deduces two different
               -- types for the same parameter and fails with 42P08.
               CASE WHEN $5::attendance_status IN ('absent','late')
                    THEN 'queued' ELSE 'not_applicable' END)
       ON CONFLICT (tenant_id, taken_on, session_id, student_id) DO UPDATE
         SET status = EXCLUDED.status,
             minutes_late = EXCLUDED.minutes_late,
             remark = EXCLUDED.remark,
             marked_at = EXCLUDED.marked_at,
             row_version = attendance_records.row_version + 1`,
      [
        s.id, r.studentId, p.sectionId, p.takenOn, r.status,
        r.minutesLate ?? null, r.remark ?? null, op.actorId, op.occurredAt, op.opId, op.deviceId,
      ],
    );
  }

  await c.query(
    `UPDATE attendance_sessions
        SET present_count = $2, absent_count = $3, late_count = $4
      WHERE id = $1`,
    [s.id, present, absent, late],
  );

  return applied(op.opId, s.row_version, { records: p.records.length, smsQueued: absent + late });
};

/* --------------------------------------------------------------- exam marks */

interface MarkPayload {
  examSubjectId: string;
  studentId: string;
  academicYearId: string;
  cqMarks?: number | null;
  mcqMarks?: number | null;
  practicalMarks?: number | null;
  caMarks?: number | null;
  isAbsent?: boolean;
}

export const applyExamMark: Applier = async (c, op) => {
  const p = op.payload as MarkPayload;
  if (!p?.examSubjectId || !p.studentId) return rejected(op.opId, 'MALFORMED_PAYLOAD');

  const es = await c.query<{ id: string; marking_locked: boolean; exam_status: string }>(
    `SELECT es.id, es.marking_locked, e.status AS exam_status
       FROM exam_subjects es JOIN exams e ON e.id = es.exam_id
      WHERE es.id = $1`,
    [p.examSubjectId],
  );
  if (es.rowCount === 0) return rejected(op.opId, 'EXAM_SUBJECT_NOT_FOUND');

  const row = es.rows[0];

  // A published result is a legal document. The server always wins; the client
  // is told so explicitly rather than having its write silently dropped.
  if (row.exam_status === 'published' || row.exam_status === 'locked' || row.marking_locked) {
    const cur = await c.query(
      `SELECT cq_marks, mcq_marks, practical_marks, ca_marks, total_marks, grade_letter
         FROM exam_marks WHERE exam_subject_id = $1 AND student_id = $2`,
      [p.examSubjectId, p.studentId],
    );
    return conflict(op.opId, 'published_marks_immutable', cur.rows[0] ?? null, p);
  }

  // Optimistic concurrency: if the client edited version N and the server has
  // moved on, surface it rather than clobbering another teacher's entry.
  if (typeof op.baseVersion === 'number') {
    const cur = await c.query<{ row_version: number }>(
      `SELECT row_version FROM exam_marks WHERE exam_subject_id = $1 AND student_id = $2`,
      [p.examSubjectId, p.studentId],
    );
    if (cur.rowCount && cur.rows[0].row_version !== op.baseVersion) {
      const full = await c.query(
        `SELECT cq_marks, mcq_marks, practical_marks, ca_marks, row_version
           FROM exam_marks WHERE exam_subject_id = $1 AND student_id = $2`,
        [p.examSubjectId, p.studentId],
      );
      return conflict(op.opId, 'version_conflict', full.rows[0], p);
    }
  }

  const res = await c.query<{ row_version: number }>(
    `INSERT INTO exam_marks
       (tenant_id, exam_subject_id, student_id, academic_year_id,
        cq_marks, mcq_marks, practical_marks, ca_marks, is_absent, entered_by, op_id)
     VALUES (app.current_tenant(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (tenant_id, exam_subject_id, student_id) DO UPDATE
       SET cq_marks = EXCLUDED.cq_marks,
           mcq_marks = EXCLUDED.mcq_marks,
           practical_marks = EXCLUDED.practical_marks,
           ca_marks = EXCLUDED.ca_marks,
           is_absent = EXCLUDED.is_absent,
           entered_at = now(),
           row_version = exam_marks.row_version + 1
     RETURNING row_version`,
    [
      p.examSubjectId, p.studentId, p.academicYearId,
      p.cqMarks ?? null, p.mcqMarks ?? null, p.practicalMarks ?? null, p.caMarks ?? null,
      p.isAbsent ?? false, op.actorId, op.opId,
    ],
  );

  return applied(op.opId, res.rows[0].row_version);
};

/* ------------------------------------------------------- class delivery log */

interface DeliveryPayload {
  slotId: string;
  deliveredOn: string;
  wasHeld: boolean;
  notHeldReason?: string;
  chapterNo?: number;
  topicCovered?: string;
  homeworkBn?: string;
}

export const applyClassDeliveryLog: Applier = async (c, op) => {
  const p = op.payload as DeliveryPayload;
  if (!p?.slotId || !p.deliveredOn) return rejected(op.opId, 'MALFORMED_PAYLOAD');

  const slot = await c.query(`SELECT id FROM routine_slots WHERE id = $1`, [p.slotId]);
  if (slot.rowCount === 0) return rejected(op.opId, 'ROUTINE_SLOT_NOT_FOUND');

  await c.query(
    `INSERT INTO class_delivery_log
       (id, tenant_id, slot_id, delivered_on, teacher_id, was_held, not_held_reason,
        chapter_no, topic_covered, homework_bn, logged_at, op_id)
     VALUES ($1, app.current_tenant(), $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     ON CONFLICT (tenant_id, slot_id, delivered_on) DO UPDATE
       SET was_held = EXCLUDED.was_held,
           not_held_reason = EXCLUDED.not_held_reason,
           chapter_no = EXCLUDED.chapter_no,
           topic_covered = EXCLUDED.topic_covered,
           homework_bn = EXCLUDED.homework_bn,
           logged_at = EXCLUDED.logged_at`,
    [
      op.opId, p.slotId, p.deliveredOn, op.actorId, p.wasHeld, p.notHeldReason ?? null,
      p.chapterNo ?? null, p.topicCovered ?? null, p.homeworkBn ?? null, op.occurredAt, op.opId,
    ],
  );

  return applied(op.opId);
};

/* ------------------------------------------------------------------ registry */

export const APPLIERS: Record<string, Applier> = {
  attendance_session: applyAttendanceSession,
  exam_mark: applyExamMark,
  class_delivery_log: applyClassDeliveryLog,
};
