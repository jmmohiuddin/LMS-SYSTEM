-- Rollback for 034 — parallel blocks (F-504).
--
-- Restores migration 006's section constraint, which cannot tell a
-- religion split from a double-booking and rejects both. After this, a
-- section that splits four ways for religion cannot be scheduled at all.
--
-- This will FAIL if any parallel block has already been placed: the
-- restored constraint refuses the very rows 034 exists to allow. That is
-- correct — drop the blocks deliberately first, or do not roll back.
BEGIN;

DROP TRIGGER IF EXISTS trg_routine_slots_parallel ON routine_slots;
DROP FUNCTION IF EXISTS app.assert_parallel_block_coherent();
DROP INDEX IF EXISTS ix_routine_slots_parallel;

ALTER TABLE routine_slots DROP CONSTRAINT rs_no_section_double_booking;
ALTER TABLE routine_slots DROP COLUMN parallel_pool;

ALTER TABLE routine_slots
  ADD CONSTRAINT rs_no_section_double_booking
  EXCLUDE USING gist (
    tenant_id          WITH =,
    routine_id         WITH =,
    primary_section_id WITH =,
    day_of_week        WITH =,
    time_range         WITH &&
  ) WHERE (status = 'active' AND primary_section_id IS NOT NULL);

COMMIT;
