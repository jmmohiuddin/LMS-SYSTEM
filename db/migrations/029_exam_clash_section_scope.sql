-- ============================================================================
-- 029 — F-510 correction: a clash is scoped to the student's own section
--
-- Migration 028 shipped app.exam_student_clashes with a join that is right
-- about subjects and silent about sections:
--
--     FROM paper p
--     JOIN student_subjects ss ON ss.subject_id = p.subject_id
--     JOIN enrolments       e  ON e.id = ss.enrolment_id
--
-- exam_subjects is keyed on (exam, SECTION, subject) — one row per section
-- sitting the paper. Nothing above ties a student's enrolment to the
-- section the paper was scheduled for, so a student "sits" every row for
-- their subject across the whole school.
--
-- ── What that does to a completely ordinary routine ──────────────────────
-- Chemistry, Class 9, sections ক and খ, both at 10:00 on the same morning —
-- which is how every school with more than one section runs an exam. Each
-- section gets its own exam_subjects row. Under the 028 join every Class 9
-- student matches BOTH rows, the overlap test compares the paper with
-- itself in the other section, and the gate reports the student as
-- clashing with themselves:
--
--     exam routine has 12 per-student clash(es); e.g. শিক্ষার্থী 1 (roll 1)
--     sits রসায়ন and রসায়ন both on 2026-12-14
--
-- "রসায়ন and রসায়ন" is the tell. The result is a publication gate that
-- refuses every multi-section exam in the product — a false positive on
-- the common case, which is worse than the missing check it replaced,
-- because a coordinator who cannot publish a correct routine learns to
-- distrust the gate.
--
-- 028's own test suite could not see this: its fixture has one section.
-- The two-section case is now assertion 9 in db/tests/exam_clash.sql.
--
-- ── The fix ──────────────────────────────────────────────────────────────
-- Carry section_id through the paper CTE and require the enrolment to be
-- in it. A student sits the paper scheduled for THEIR section and no other.
-- Same shape as the guard in app.generate_seat_plan (030), for the same
-- reason.
--
-- Function body only; no schema change, and 028's trigger picks the new
-- definition up on its next call.
-- ============================================================================
BEGIN;

CREATE OR REPLACE FUNCTION app.exam_student_clashes(p_exam uuid)
RETURNS TABLE (
  student_id      uuid,
  student_name_bn text,
  roll_no         smallint,
  section_name    text,
  exam_date       date,
  subject_a_bn    text,
  subject_b_bn    text,
  start_a         time,
  start_b         time
)
LANGUAGE sql
STABLE
SECURITY INVOKER          -- RLS still decides which students are visible
SET search_path = public, app
AS $$
  WITH paper AS (
    SELECT es.id, es.subject_id, es.section_id, es.exam_date, es.start_time,
           (es.start_time + make_interval(mins => COALESCE(es.duration_minutes, 0))) AS end_time
      FROM exam_subjects es
     WHERE es.exam_id = p_exam
       AND es.exam_date IS NOT NULL
       AND es.start_time IS NOT NULL
  ),
  -- Who actually sits each paper: the student's OWN subject set, in the
  -- section the paper was scheduled for. Both halves are load-bearing —
  -- the subject set is what distinguishes two students in one room
  -- (F-510's reason for existing), and the section is what stops one
  -- student matching the same paper in every other room.
  sitting AS (
    SELECT p.id AS paper_id, p.subject_id, p.exam_date, p.start_time, p.end_time,
           e.student_id, e.roll_no, sec.name AS section_name
      FROM paper p
      JOIN student_subjects ss ON ss.subject_id = p.subject_id
      JOIN enrolments e  ON e.id = ss.enrolment_id
                        AND e.section_id = p.section_id
                        AND e.status = 'active'
      JOIN sections   sec ON sec.id = e.section_id
  )
  SELECT a.student_id, u.full_name_bn, a.roll_no, a.section_name, a.exam_date,
         sa.name_bn, sb.name_bn, a.start_time, b.start_time
    FROM sitting a
    JOIN sitting b
      ON b.student_id = a.student_id
     AND b.exam_date  = a.exam_date
     AND b.paper_id  <> a.paper_id
     -- Half-open overlap, and a.paper < b.paper so each pair is reported once.
     AND a.start_time < b.end_time
     AND b.start_time < a.end_time
     AND a.paper_id   < b.paper_id
    JOIN users    u  ON u.id = a.student_id
    JOIN subjects sa ON sa.id = a.subject_id
    JOIN subjects sb ON sb.id = b.subject_id
   ORDER BY a.exam_date, a.start_time, a.section_name, a.roll_no
$$;

COMMENT ON FUNCTION app.exam_student_clashes IS
  'F-510 / TRD §6.6, corrected in 029. Per-STUDENT exam clash detection '
  'against student_subjects, scoped to the section the paper was scheduled '
  'for. Two students in one section hold different optional subjects, so a '
  'clash can exist for one and not the other; and a student sits the paper '
  'for THEIR section, not every section''s copy of it.';

COMMIT;
