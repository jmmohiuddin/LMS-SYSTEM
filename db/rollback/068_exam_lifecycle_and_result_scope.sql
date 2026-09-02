-- Rollback for 068 — the exam tables go back to tenant isolation, and
-- publishing a routine goes back to ending the exam.
--
-- Read what this restores before running it. It is a real widening and a real
-- reintroduced defect, not a no-op:
--
--   * Any role in the school regains UPDATE and DELETE on `exam_marks` and
--     every write on `exam_results` — including `dept_head`, who cannot enter
--     a mark and could then delete a PUBLISHED one, the number on a
--     certificate. Proved live before 068 was written.
--   * `subjects` and `academic_years` become directly deletable again, each
--     cascading into the exam papers and marks that `exam_subjects_delete_scope`
--     is there to protect.
--   * The two routine guards go back to firing on `status`, and
--     `examroutine.ts` must be reverted with this file or routine publication
--     will run neither the clash check nor the invigilator check.
--
-- DATA: `routine_published_at` is dropped, so the record of which timetables
-- were announced is destroyed. This does NOT restore the exams that 068
-- repaired back to `status = 'published'` — deliberately, because that state
-- was the bug: those exams could never be marked or have results published.
-- Reverting the repair would re-brick them.

BEGIN;

DROP POLICY IF EXISTS academic_years_delete_scope ON academic_years;
DROP POLICY IF EXISTS subjects_delete_scope ON subjects;

DROP POLICY IF EXISTS results_delete_scope ON exam_results;
DROP POLICY IF EXISTS results_update_scope ON exam_results;
DROP POLICY IF EXISTS results_insert_scope ON exam_results;

DROP POLICY IF EXISTS marks_delete_scope ON exam_marks;
DROP POLICY IF EXISTS marks_update_scope ON exam_marks;

-- The guards go back onto `status`, verbatim as 005/0xx had them.
CREATE OR REPLACE FUNCTION app.assert_exam_routine_clash_free()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE n integer; sample record;
BEGIN
  IF NEW.status <> 'published' OR OLD.status = 'published' THEN
    RETURN NEW;
  END IF;

  SELECT count(*) INTO n FROM app.exam_student_clashes(NEW.id);
  IF n > 0 THEN
    SELECT * INTO sample FROM app.exam_student_clashes(NEW.id) LIMIT 1;
    RAISE EXCEPTION
      'exam routine has % per-student clash(es); e.g. % (roll %) sits % and % both on %',
      n, sample.student_name_bn, sample.roll_no,
      sample.subject_a_bn, sample.subject_b_bn, sample.exam_date
      USING ERRCODE = 'check_violation',
            HINT = 'call app.exam_student_clashes(exam_id) for the full list, one row per affected student';
  END IF;
  RETURN NEW;
END $function$;

CREATE OR REPLACE FUNCTION app.assert_exam_halls_staffed()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE v_room text; v_date date;
BEGIN
  IF NEW.status <> 'published' OR OLD.status = 'published' THEN
    RETURN NEW;
  END IF;

  SELECT r.code, h.exam_date INTO v_room, v_date
    FROM exam_halls h
    JOIN rooms r ON r.id = h.room_id
   WHERE h.exam_id = NEW.id
     AND NOT EXISTS (SELECT 1 FROM exam_invigilations ei WHERE ei.hall_id = h.id)
   ORDER BY h.exam_date, h.start_time, r.code
   LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION 'hall % on % has no invigilator', v_room, v_date
      USING ERRCODE = 'check_violation',
            HINT = 'assign duty for every hall before publishing the routine';
  END IF;
  RETURN NEW;
END $function$;

DROP TRIGGER IF EXISTS trg_exams_clash_free ON exams;
CREATE TRIGGER trg_exams_clash_free
  BEFORE UPDATE OF status ON exams
  FOR EACH ROW EXECUTE FUNCTION app.assert_exam_routine_clash_free();

DROP TRIGGER IF EXISTS trg_exams_halls_staffed ON exams;
CREATE TRIGGER trg_exams_halls_staffed
  BEFORE UPDATE OF status ON exams
  FOR EACH ROW EXECUTE FUNCTION app.assert_exam_halls_staffed();

COMMENT ON COLUMN exams.routine_published_at IS NULL;
ALTER TABLE exams DROP COLUMN IF EXISTS routine_published_at;

COMMIT;
