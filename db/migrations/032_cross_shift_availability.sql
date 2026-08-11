-- ============================================================================
-- 032 — Cross-shift teacher and room availability  (F-506)
--
-- The PRD calls F-506 "the most common source of real-world routine
-- failure", and it is a P0. This migration is what makes it true that the
-- database catches it.
--
-- ── The constraint said one thing and did another ────────────────────────
-- Migration 006 shipped:
--
--     ALTER TABLE routine_slots ADD CONSTRAINT rs_no_teacher_double_booking
--       EXCLUDE USING gist (tenant_id WITH =, routine_id WITH =,
--                           teacher_id WITH =, day_of_week WITH =,
--                           time_range WITH &&) …
--
--     COMMENT: 'Teacher cannot be in two places at once — enforced on
--               overlapping TIME, not period number, so cross-shift
--               collisions (morning p8 vs day p1) are caught.'
--
-- The comment describes the behaviour we want. The constraint does not
-- have it. `routines` is UNIQUE on (tenant, year, shift, version), so the
-- morning routine and the day routine are DIFFERENT routine_id values —
-- and a constraint scoped to one routine_id cannot see across them. The
-- one case the comment names is the one case it misses.
--
-- Same for rooms, which matters just as much: a two-shift school shares
-- its rooms, and morning period 8 running into day period 1 is how two
-- classes end up at one door.
--
-- ── Why routine_id was there, and what replaces it ───────────────────────
-- The scoping was not careless. 006's own note: "Scoped to a single
-- routine_id so a DRAFT routine can legitimately overlap the ACTIVE one it
-- will replace." That is a real requirement — a coordinator builds next
-- term's routine beside the one being taught today.
--
-- So the axis is wrong, not the idea. What must be separated is DRAFT from
-- ACTIVE, not shift from shift. Both live on `routines`, one table away
-- from where an EXCLUDE constraint can read, so the academic year and the
-- routine's status are denormalised onto routine_slots and maintained by
-- trigger.
--
-- The new scope is (tenant, academic_year, teacher, day, time) restricted
-- to slots whose routine is ACTIVE. Drafts overlap anything, including
-- each other. Two active routines — which is exactly the two shifts —
-- cannot put one teacher in two rooms at one time.
--
-- ── Where the failure now surfaces ───────────────────────────────────────
-- On publication. Promoting a draft to active rewrites its slots'
-- routine_status, and that is when the constraint is checked — so a
-- coordinator finds out when they publish the second shift, which is the
-- moment they can still do something about it.
-- ============================================================================
BEGIN;

-- ---------------------------------------------------------------------
-- The two facts an EXCLUDE constraint needs and cannot reach.
-- ---------------------------------------------------------------------
ALTER TABLE routine_slots
  ADD COLUMN academic_year_id uuid REFERENCES academic_years(id) ON DELETE CASCADE,
  ADD COLUMN routine_status   routine_status;

COMMENT ON COLUMN routine_slots.academic_year_id IS
  'F-506. Denormalised from routines. An EXCLUDE constraint reads only its '
  'own table, and the year is what unites the two shifts that must not '
  'collide.';
COMMENT ON COLUMN routine_slots.routine_status IS
  'F-506. Denormalised from routines, and the axis that replaces routine_id '
  'in the exclusion constraints: DRAFT may overlap anything, ACTIVE may not '
  'overlap ACTIVE.';

UPDATE routine_slots rs
   SET academic_year_id = r.academic_year_id,
       routine_status   = r.status
  FROM routines r
 WHERE r.id = rs.routine_id;

ALTER TABLE routine_slots
  ALTER COLUMN academic_year_id SET NOT NULL,
  ALTER COLUMN routine_status   SET NOT NULL;

-- Filled from the parent on write; never set by hand. A caller who passes
-- one is overridden rather than trusted, because a slot claiming to belong
-- to a different year than its routine would silently escape the
-- constraint below.
CREATE OR REPLACE FUNCTION app.sync_slot_routine_facts()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  SELECT r.academic_year_id, r.status
    INTO NEW.academic_year_id, NEW.routine_status
    FROM routines r WHERE r.id = NEW.routine_id;
  IF NEW.academic_year_id IS NULL THEN
    RAISE EXCEPTION 'slot references routine % which does not exist', NEW.routine_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_routine_slots_facts
  BEFORE INSERT OR UPDATE OF routine_id ON routine_slots
  FOR EACH ROW EXECUTE FUNCTION app.sync_slot_routine_facts();

-- Publication is the moment the clash is discovered, so the propagation
-- has to happen inside the same statement that publishes.
CREATE OR REPLACE FUNCTION app.propagate_routine_status()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE routine_slots SET routine_status = NEW.status WHERE routine_id = NEW.id;
  RETURN NULL;
END $$;

CREATE TRIGGER trg_routines_propagate_status
  AFTER UPDATE OF status ON routines
  FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION app.propagate_routine_status();

-- ---------------------------------------------------------------------
-- The constraints, re-scoped.
-- ---------------------------------------------------------------------
ALTER TABLE routine_slots DROP CONSTRAINT rs_no_teacher_double_booking;
ALTER TABLE routine_slots DROP CONSTRAINT rs_no_room_double_booking;

ALTER TABLE routine_slots
  ADD CONSTRAINT rs_no_teacher_double_booking
  EXCLUDE USING gist (
    tenant_id        WITH =,
    academic_year_id WITH =,
    teacher_id       WITH =,
    day_of_week      WITH =,
    time_range       WITH &&
  ) WHERE (status = 'active' AND routine_status = 'active'
           AND teacher_id IS NOT NULL AND slot_kind IN ('teaching','exam'));

ALTER TABLE routine_slots
  ADD CONSTRAINT rs_no_room_double_booking
  EXCLUDE USING gist (
    tenant_id        WITH =,
    academic_year_id WITH =,
    room_id          WITH =,
    day_of_week      WITH =,
    time_range       WITH &&
  ) WHERE (status = 'active' AND routine_status = 'active'
           AND room_id IS NOT NULL AND slot_kind IN ('teaching','exam'));

COMMENT ON CONSTRAINT rs_no_teacher_double_booking ON routine_slots IS
  'F-506. A teacher cannot be in two places at once, ACROSS SHIFTS — scoped '
  'to the academic year rather than one routine, and matched on overlapping '
  'TIME rather than period number, so morning p8 against day p1 is caught. '
  'Only ACTIVE routines participate, so a draft may still overlap the '
  'routine it will replace.';

COMMENT ON CONSTRAINT rs_no_room_double_booking ON routine_slots IS
  'F-506. A two-shift school shares its rooms. Same scoping as the teacher '
  'constraint, and the same reason.';

-- A section belongs to exactly one shift, so it cannot collide with
-- itself across them; that constraint keeps its original per-routine
-- scope, which is still correct.

-- Supports the constraint lookups and the report below.
CREATE INDEX ix_routine_slots_year_teacher
  ON routine_slots (tenant_id, academic_year_id, teacher_id, day_of_week)
  WHERE status = 'active' AND routine_status = 'active';

-- ---------------------------------------------------------------------
-- The report, so publication fails with a name rather than a constraint.
--
-- Same reasoning as the F-510 exam gate: a coordinator told
-- "rs_no_teacher_double_booking" has to go and find the problem; one told
-- "রফিক ইসলাম teaches ৯-ক at 12:40 in the morning shift and ৬-খ at 12:40
-- in the day shift" can fix it.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.cross_shift_conflicts(p_routine uuid)
RETURNS TABLE (
  teacher_id     uuid,
  teacher_name_bn text,
  day_of_week    smallint,
  starts_at      time,
  this_section   text,
  other_shift    shift_code,
  other_section  text,
  other_starts   time
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public, app
AS $$
  WITH mine AS (
    SELECT rs.*, r.academic_year_id AS yr, r.shift
      FROM routine_slots rs
      JOIN routines r ON r.id = rs.routine_id
     WHERE rs.routine_id = p_routine
       AND rs.status = 'active'
       AND rs.teacher_id IS NOT NULL
       AND rs.slot_kind IN ('teaching','exam')
  )
  SELECT m.teacher_id, u.full_name_bn, m.day_of_week, m.starts_at,
         ms.name, r2.shift, os.name, o.starts_at
    FROM mine m
    JOIN routine_slots o ON o.tenant_id = m.tenant_id
                        AND o.teacher_id = m.teacher_id
                        AND o.day_of_week = m.day_of_week
                        AND o.time_range && m.time_range
                        AND o.routine_id <> m.routine_id
                        AND o.status = 'active'
                        AND o.routine_status = 'active'
                        AND o.slot_kind IN ('teaching','exam')
    JOIN routines r2 ON r2.id = o.routine_id AND r2.academic_year_id = m.yr
    JOIN users    u  ON u.id = m.teacher_id
    LEFT JOIN sections ms ON ms.id = m.primary_section_id
    LEFT JOIN sections os ON os.id = o.primary_section_id
   ORDER BY m.day_of_week, m.starts_at, u.full_name_bn
$$;

COMMENT ON FUNCTION app.cross_shift_conflicts IS
  'F-506. Which teachers this routine would double-book against the OTHER '
  'shift''s active routine, by name. Run before publishing.';

REVOKE ALL ON FUNCTION app.cross_shift_conflicts(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.cross_shift_conflicts(uuid) TO shikhon_app;

CREATE OR REPLACE FUNCTION app.assert_routine_cross_shift_clear()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE n integer; sample record;
BEGIN
  IF NEW.status <> 'active' OR OLD.status = 'active' THEN RETURN NEW; END IF;

  SELECT count(*) INTO n FROM app.cross_shift_conflicts(NEW.id);
  IF n > 0 THEN
    SELECT * INTO sample FROM app.cross_shift_conflicts(NEW.id) LIMIT 1;
    RAISE EXCEPTION
      'routine clashes with the other shift in % place(s); e.g. % teaches % and % at % on day %',
      n, sample.teacher_name_bn, COALESCE(sample.this_section, '?'),
      COALESCE(sample.other_section, '?'), sample.starts_at, sample.day_of_week
      USING ERRCODE = 'check_violation',
            HINT = 'call app.cross_shift_conflicts(routine_id) for the full list';
  END IF;
  RETURN NEW;
END $$;

-- BEFORE the status write, so the friendly error wins the race against the
-- exclusion constraint that would otherwise report a raw conflict.
CREATE TRIGGER trg_routines_cross_shift
  BEFORE UPDATE OF status ON routines
  FOR EACH ROW EXECUTE FUNCTION app.assert_routine_cross_shift_clear();

COMMIT;
