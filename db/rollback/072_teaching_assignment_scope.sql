-- Rollback 072. Restores the pre-P9 state, in which tenant-match was the
-- whole test for who may write a school's teaching assignments (B-89).
BEGIN;
DROP POLICY IF EXISTS sst_delete_scope ON section_subject_teachers;
DROP POLICY IF EXISTS sst_update_scope ON section_subject_teachers;
DROP POLICY IF EXISTS sst_insert_scope ON section_subject_teachers;
COMMIT;
