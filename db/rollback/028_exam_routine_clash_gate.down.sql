-- Rollback for 028 — per-student exam clash detection (F-510).
--
-- Removes the gate. After this, an exam routine can be published while a
-- student is scheduled to sit two papers at once, and nobody finds out
-- until that morning. Roll back only if 028 itself is the problem.
BEGIN;
DROP INDEX IF EXISTS ix_exam_subjects_slot;
DROP TRIGGER IF EXISTS trg_exams_clash_free ON exams;
DROP FUNCTION IF EXISTS app.assert_exam_routine_clash_free();
DROP FUNCTION IF EXISTS app.exam_student_clashes(uuid);
COMMIT;
