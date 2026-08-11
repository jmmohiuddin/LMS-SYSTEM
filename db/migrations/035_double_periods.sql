-- ============================================================================
-- 035 — Contiguous double periods  (F-504, the last unbuilt clause)
--
-- F-504: "double periods contiguous" is a HARD constraint — never violable.
--
-- The columns have existed since migration 006 (routine_slots.is_double,
-- double_group_id) and 003 (class_subjects.double_periods_per_week), and
-- nothing has ever read or policed them. A "double period" could be two
-- slots on different days, taught by different people, in different rooms
-- — the schema would accept all of it, and the word "double" on the screen
-- would be a decoration.
--
-- Why doubles matter enough to be a hard constraint: a science practical
-- cannot set up, run and pack away an experiment in 45 minutes. A double
-- that is not contiguous is not a double — it is two singles wearing a
-- label, and the practical it was created for cannot actually happen.
--
-- ── What "one double" must mean, made checkable ──────────────────────────
--   • exactly TWO slots share a double_group_id;
--   • same day, same section, same subject, same teacher, same room;
--   • the first ends exactly when the second begins — a tiffin break
--     between the halves makes them two singles, whatever the label says;
--   • both halves say is_double, and no slot says is_double without a
--     group to belong to.
--
-- Enforced as a CONSTRAINT trigger, DEFERRED to commit: the first half is
-- necessarily alone until the second is written, so an immediate check
-- could never pass. Same reasoning as the reachability trigger in 031.
-- ============================================================================
BEGIN;

-- A slot cannot claim to be half of a double without naming which double.
ALTER TABLE routine_slots
  ADD CONSTRAINT rs_double_needs_group
  CHECK (NOT is_double OR double_group_id IS NOT NULL);

CREATE OR REPLACE FUNCTION app.assert_double_period_coherent()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, app
AS $$
DECLARE
  v_count integer;
  a record; b record;
BEGIN
  IF NEW.double_group_id IS NULL OR NEW.status <> 'active' THEN RETURN NULL; END IF;

  SELECT count(*) INTO v_count FROM routine_slots
   WHERE double_group_id = NEW.double_group_id AND status = 'active';

  IF v_count <> 2 THEN
    RAISE EXCEPTION 'double period % has % half(s); a double is exactly two slots',
      NEW.double_group_id, v_count
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT * INTO a FROM routine_slots
   WHERE double_group_id = NEW.double_group_id AND status = 'active'
   ORDER BY starts_at LIMIT 1;
  SELECT * INTO b FROM routine_slots
   WHERE double_group_id = NEW.double_group_id AND status = 'active'
   ORDER BY starts_at DESC LIMIT 1;

  IF a.day_of_week <> b.day_of_week
     OR a.primary_section_id IS DISTINCT FROM b.primary_section_id
     OR a.subject_id IS DISTINCT FROM b.subject_id
     OR a.teacher_id IS DISTINCT FROM b.teacher_id
     OR a.room_id    IS DISTINCT FROM b.room_id THEN
    RAISE EXCEPTION
      'the two halves of a double period must share day, section, subject, teacher and room'
      USING ERRCODE = 'check_violation';
  END IF;

  -- The clause F-504 states by name. A break between the halves makes
  -- them two singles wearing a label, and the practical the double was
  -- created for cannot happen in either of them.
  IF a.ends_at <> b.starts_at THEN
    RAISE EXCEPTION
      'double period halves are not contiguous: first ends % and second begins %',
      a.ends_at, b.starts_at
      USING ERRCODE = 'check_violation',
            HINT = 'the second half must begin exactly when the first ends';
  END IF;

  IF NOT a.is_double OR NOT b.is_double THEN
    RAISE EXCEPTION 'both halves of a double period must be marked is_double'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NULL;
END $$;

-- DEFERRED: the first half is alone until the second is written in the
-- same transaction, so an immediate check could never pass.
CREATE CONSTRAINT TRIGGER trg_double_period_coherent
  AFTER INSERT OR UPDATE OF double_group_id, starts_at, ends_at, day_of_week,
                            teacher_id, room_id, subject_id, status
  ON routine_slots
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION app.assert_double_period_coherent();

COMMENT ON FUNCTION app.assert_double_period_coherent IS
  'F-504. A double period is exactly two contiguous slots sharing day, '
  'section, subject, teacher and room. Deferred to COMMIT because the '
  'first half is necessarily alone until the second is written.';

CREATE INDEX ix_routine_slots_double_group
  ON routine_slots (double_group_id) WHERE double_group_id IS NOT NULL;

COMMIT;
