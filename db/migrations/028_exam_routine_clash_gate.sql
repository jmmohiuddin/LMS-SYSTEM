-- ============================================================================
-- 028 — Exam routine: per-student clash detection  (F-510, TRD §6.6)
--
-- exam_subjects already carried exam_date, start_time and duration_minutes.
-- Nothing checked them against each other, and nothing could have checked
-- them correctly, because the only available notion of "who sits this
-- paper" was the class template.
--
-- ── Why the class template is the wrong check ────────────────────────────
-- TRD §6.6: "two Class 11 students in the same section can hold different
-- optional subjects, so a slot clash may exist for one student and not
-- another."
--
-- Concretely: a Science section sits Physics and Chemistry together, but
-- one student's optional is Higher Maths and another's is Agriculture. Put
-- Higher Maths and Chemistry in the same slot and you have created a clash
-- for exactly one child in the room. A template-level check sees nothing
-- wrong — the template holds both optionals, so it "knows" the section has
-- a conflict either way, or none. Only student_subjects (F-304) can answer
-- it, which is why this could not be built before migration 025.
--
-- The same logic covers religion variants, which is the other case: four
-- variants in one pool, each held by a different subset of the section.
--
-- ── Reported per student, never as a count ───────────────────────────────
-- TRD §6.6 again: "its result is surfaced per affected student rather than
-- as a count." A coordinator told "3 clashes" has to go find them. A
-- coordinator told "Anika (roll 7) sits Higher Maths and Chemistry both at
-- 10:00 on 14 December" can fix it.
-- ============================================================================
BEGIN;

-- ---------------------------------------------------------------------
-- A paper occupies [start, start + duration). Two papers clash for a
-- student when both are on their subject set, on the same date, and their
-- intervals overlap.
--
-- Half-open on purpose: a paper ending at 12:00 and one starting at 12:00
-- do not overlap. Treating that as a clash would make back-to-back
-- scheduling — which every school does — permanently impossible.
-- ---------------------------------------------------------------------
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
    SELECT es.id, es.subject_id, es.exam_date, es.start_time,
           (es.start_time + make_interval(mins => COALESCE(es.duration_minutes, 0))) AS end_time
      FROM exam_subjects es
     WHERE es.exam_id = p_exam
       AND es.exam_date IS NOT NULL
       AND es.start_time IS NOT NULL
  ),
  -- Who actually sits each paper: the student's OWN subject set, not the
  -- section's template.
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
  'F-510 / TRD §6.6. Per-STUDENT exam clash detection, against '
  'student_subjects rather than the class template — two students in one '
  'section hold different optional subjects, so a clash can exist for one '
  'and not the other. Reported per student, never as a count.';

REVOKE ALL ON FUNCTION app.exam_student_clashes(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.exam_student_clashes(uuid) TO shikhon_app;

-- ---------------------------------------------------------------------
-- The publication gate.
--
-- TRD §6.6: this "runs as a validation gate before an exam routine can
-- move from draft to published". A trigger rather than an application
-- check, because an exam routine published with a clash puts a child in
-- two rooms at once and nobody discovers it until the morning of the
-- paper.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.assert_exam_routine_clash_free()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE n integer; sample record;
BEGIN
  IF NEW.status <> 'published' OR OLD.status = 'published' THEN
    RETURN NEW;
  END IF;

  SELECT count(*) INTO n FROM app.exam_student_clashes(NEW.id);
  IF n > 0 THEN
    SELECT * INTO sample FROM app.exam_student_clashes(NEW.id) LIMIT 1;
    -- Names one real student. "3 clashes" sends a coordinator hunting;
    -- a name, a roll number and two subjects can be acted on immediately.
    RAISE EXCEPTION
      'exam routine has % per-student clash(es); e.g. % (roll %) sits % and % both on %',
      n, sample.student_name_bn, sample.roll_no,
      sample.subject_a_bn, sample.subject_b_bn, sample.exam_date
      USING ERRCODE = 'check_violation',
            HINT = 'call app.exam_student_clashes(exam_id) for the full list, one row per affected student';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_exams_clash_free
  BEFORE UPDATE OF status ON exams
  FOR EACH ROW EXECUTE FUNCTION app.assert_exam_routine_clash_free();

COMMENT ON FUNCTION app.assert_exam_routine_clash_free IS
  'F-510. Blocks draft → published while any student would sit two papers '
  'at once. In the database because the cost of missing it is a child in '
  'two rooms on the morning of the exam.';

-- Supports both the clash join and the coordinator''s day view.
CREATE INDEX ix_exam_subjects_slot
  ON exam_subjects (tenant_id, exam_id, exam_date, start_time)
  WHERE exam_date IS NOT NULL;

COMMIT;
