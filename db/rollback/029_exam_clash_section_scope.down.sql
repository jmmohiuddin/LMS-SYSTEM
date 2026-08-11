-- Rollback for 029 — F-510 section-scope correction.
--
-- Restores 028's definition verbatim, which means restoring its defect:
-- the clash join ignores the paper's section, so every multi-section exam
-- reports each student as clashing with themselves ("রসায়ন and রসায়ন") and
-- cannot be published at all.
--
-- There is almost no reason to run this. It exists so the chain is
-- reversible, not because reversing it is ever the right call.
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
SECURITY INVOKER
SET search_path = public, app
AS $$
  WITH paper AS (
    SELECT es.id, es.subject_id, es.exam_date, es.start_time,
           (es.start_time + make_interval(mins => COALESCE(es.duration_minutes, 0))) AS end_time
      FROM exam_subjects es
     WHERE es.exam_id = p_exam
       AND es.exam_date IS NOT NULL
       AND es.start_time IS NOT NULL
  ),
  sitting AS (
    SELECT p.id AS paper_id, p.subject_id, p.exam_date, p.start_time, p.end_time,
           e.student_id, e.roll_no, sec.name AS section_name
      FROM paper p
      JOIN student_subjects ss ON ss.subject_id = p.subject_id
      JOIN enrolments e  ON e.id = ss.enrolment_id AND e.status = 'active'
      JOIN sections   sec ON sec.id = e.section_id
  )
  SELECT a.student_id, u.full_name_bn, a.roll_no, a.section_name, a.exam_date,
         sa.name_bn, sb.name_bn, a.start_time, b.start_time
    FROM sitting a
    JOIN sitting b
      ON b.student_id = a.student_id
     AND b.exam_date  = a.exam_date
     AND b.paper_id  <> a.paper_id
     AND a.start_time < b.end_time
     AND b.start_time < a.end_time
     AND a.paper_id   < b.paper_id
    JOIN users    u  ON u.id = a.student_id
    JOIN subjects sa ON sa.id = a.subject_id
    JOIN subjects sb ON sb.id = b.subject_id
   ORDER BY a.exam_date, a.start_time, a.section_name, a.roll_no
$$;

COMMIT;
