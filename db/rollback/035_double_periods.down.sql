-- Rollback for 035 — contiguous double periods (F-504).
--
-- Removes the coherence guarantee. After this a "double period" can be two
-- slots on different days taught by different people, and the label means
-- nothing again. Existing well-formed doubles are left in place — they
-- satisfy the old world trivially.
BEGIN;

DROP TRIGGER IF EXISTS trg_double_period_coherent ON routine_slots;
DROP FUNCTION IF EXISTS app.assert_double_period_coherent();
DROP INDEX IF EXISTS ix_routine_slots_double_group;
ALTER TABLE routine_slots DROP CONSTRAINT rs_double_needs_group;

COMMIT;
