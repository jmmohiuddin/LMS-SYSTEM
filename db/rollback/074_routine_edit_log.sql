-- Rollback 074. Restores the pre-P9-5 state, in which the routine editor had
-- no undo: a coordinator who moved a class to the wrong hour had to remember
-- what it was and put it back by hand.
--
-- DROPS THE UNDO HISTORY. Every un-undone entry goes with the table, so a
-- coordinator mid-session loses the ability to reverse the edits they have
-- already made. Their edits themselves are untouched — those live in
-- `routine_slots`, and `audit.activity_log` still records who made them.
BEGIN;
DROP POLICY IF EXISTS edit_log_delete_scope ON routine_edit_log;
DROP POLICY IF EXISTS edit_log_update_scope ON routine_edit_log;
DROP POLICY IF EXISTS edit_log_insert_scope ON routine_edit_log;
DROP POLICY IF EXISTS tenant_isolation ON routine_edit_log;
DROP TABLE IF EXISTS routine_edit_log;
COMMIT;
