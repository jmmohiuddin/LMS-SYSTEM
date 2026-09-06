-- Rollback 073. Restores the pre-P9-2 state, in which tenant-match was the
-- whole test for who may rewrite a school's curriculum demand and its
-- teachers' availability, and a bell schedule could contain overlapping
-- periods.
BEGIN;
ALTER TABLE period_definitions DROP CONSTRAINT IF EXISTS pd_no_overlap_within_template;
DROP POLICY IF EXISTS teacher_availability_delete_scope ON teacher_availability;
DROP POLICY IF EXISTS teacher_availability_update_scope ON teacher_availability;
DROP POLICY IF EXISTS teacher_availability_insert_scope ON teacher_availability;
DROP POLICY IF EXISTS class_subjects_delete_scope ON class_subjects;
DROP POLICY IF EXISTS class_subjects_update_scope ON class_subjects;
DROP POLICY IF EXISTS class_subjects_insert_scope ON class_subjects;
COMMIT;
