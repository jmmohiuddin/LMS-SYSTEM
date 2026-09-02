-- Rollback for 066 — the exam tables go back to tenant isolation and nothing else.
--
-- Read what this restores: any staff session in the school regains the ability
-- to create and edit exams, including a subject teacher. It destroys no data,
-- and it re-opens the hole 066 closed. It also drops the rule that stopped two
-- exams sharing one name inside a year, which the marks-entry screen relies on
-- to tell them apart.

BEGIN;

DROP INDEX IF EXISTS uq_exam_name_year;
ALTER TABLE exams DROP CONSTRAINT IF EXISTS exams_date_order;

DROP POLICY IF EXISTS exam_subjects_delete_scope ON exam_subjects;
DROP POLICY IF EXISTS exam_subjects_update_scope ON exam_subjects;
DROP POLICY IF EXISTS exam_subjects_insert_scope ON exam_subjects;
DROP POLICY IF EXISTS exams_delete_scope ON exams;
DROP POLICY IF EXISTS exams_update_scope ON exams;
DROP POLICY IF EXISTS exams_insert_scope ON exams;

COMMIT;
