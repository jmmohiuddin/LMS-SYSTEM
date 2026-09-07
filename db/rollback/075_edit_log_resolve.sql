-- Rollback 075. Narrows the undo log back to the editor's single-slot
-- actions.
--
-- REFUSES if any `resolve` entry exists: narrowing the CHECK under one would
-- leave a row the constraint forbids and `undo` cannot apply, which is a
-- coordinator pressing undo and getting nothing. Mark them undone first, or
-- accept that their scoped re-solves are no longer reversible.
BEGIN;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM routine_edit_log WHERE action = 'resolve') THEN
    RAISE EXCEPTION 'routine_edit_log still holds % scoped re-solve entries; '
      'narrowing the CHECK would strand them',
      (SELECT count(*) FROM routine_edit_log WHERE action = 'resolve');
  END IF;
END $$;
ALTER TABLE routine_edit_log DROP CONSTRAINT routine_edit_log_action_check;
ALTER TABLE routine_edit_log
  ADD CONSTRAINT routine_edit_log_action_check
  CHECK (action IN ('place','assign','move','remove','lock','unlock'));
COMMIT;
