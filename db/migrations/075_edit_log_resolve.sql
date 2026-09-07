-- 075 — a scoped re-solve is ONE undoable edit  (P9-6 §18)
--
-- `routine_edit_log.action` was written for the editor's single-slot
-- mutations (074). A scoped re-solve removes several slots and places
-- several more in one atomic operation, and the brief is explicit about what
-- that must look like to a coordinator:
--
--   "If the whole scoped result is one atomic mutation: one Undo should
--    restore the prior state. Do not create dozens of meaningless undo
--    entries for one operation."
--
-- So it is one row, with an inverse naming every slot to restore and every
-- slot to remove. The CHECK is widened to admit it.
--
-- ── Why not simply drop the CHECK ────────────────────────────────────────
-- Because it is the thing that stops an inverse nobody can apply from being
-- written. `api/editor.ts:undo` switches on `inverse.op` and a value outside
-- the set it knows would be a row that fails silently at the moment somebody
-- is trying to recover their work. The constraint is small and it is load-
-- bearing.

ALTER TABLE routine_edit_log
  DROP CONSTRAINT routine_edit_log_action_check;

ALTER TABLE routine_edit_log
  ADD CONSTRAINT routine_edit_log_action_check
  CHECK (action IN ('place','assign','move','remove','lock','unlock','resolve'));

COMMENT ON COLUMN routine_edit_log.action IS
  'The editor action this entry reverses. `resolve` is a whole scoped '
  're-solve — one entry for an operation that touched many slots, because a '
  'coordinator who asked for one recalculation should undo one thing.';
