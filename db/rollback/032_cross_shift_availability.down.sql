-- Rollback for 032 — cross-shift availability (F-506).
--
-- Restores migration 006's per-routine scoping, which means restoring the
-- gap: a teacher and a room can be booked twice across the two shifts, and
-- nothing notices until somebody stands in a corridor.
--
-- Note this can FAIL, and that is correct. Re-adding the per-routine
-- constraint over data written while the year-wide one was in force is
-- fine; but a routine published under 032 may have been rejected, so the
-- routine you expect to exist may not. Check before assuming.
BEGIN;

DROP TRIGGER IF EXISTS trg_routines_cross_shift ON routines;
DROP TRIGGER IF EXISTS trg_routines_propagate_status ON routines;
DROP TRIGGER IF EXISTS trg_routine_slots_facts ON routine_slots;

DROP FUNCTION IF EXISTS app.assert_routine_cross_shift_clear();
DROP FUNCTION IF EXISTS app.cross_shift_conflicts(uuid);
DROP FUNCTION IF EXISTS app.propagate_routine_status();
DROP FUNCTION IF EXISTS app.sync_slot_routine_facts();

DROP INDEX IF EXISTS ix_routine_slots_year_teacher;

ALTER TABLE routine_slots DROP CONSTRAINT rs_no_teacher_double_booking;
ALTER TABLE routine_slots DROP CONSTRAINT rs_no_room_double_booking;

ALTER TABLE routine_slots
  ADD CONSTRAINT rs_no_teacher_double_booking
  EXCLUDE USING gist (
    tenant_id  WITH =,
    routine_id WITH =,
    teacher_id WITH =,
    day_of_week WITH =,
    time_range WITH &&
  ) WHERE (status = 'active' AND teacher_id IS NOT NULL AND slot_kind IN ('teaching','exam'));

ALTER TABLE routine_slots
  ADD CONSTRAINT rs_no_room_double_booking
  EXCLUDE USING gist (
    tenant_id  WITH =,
    routine_id WITH =,
    room_id    WITH =,
    day_of_week WITH =,
    time_range WITH &&
  ) WHERE (status = 'active' AND room_id IS NOT NULL AND slot_kind IN ('teaching','exam'));

ALTER TABLE routine_slots
  DROP COLUMN routine_status,
  DROP COLUMN academic_year_id;

COMMIT;
