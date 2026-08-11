-- ============================================================================
-- 034 — Parallel blocks for religion and optional splits  (F-504)
--
-- F-504 requires "religion and optional-subject splits scheduled as
-- coherent parallel blocks". The database forbade them.
--
-- Migration 006 shipped:
--
--     ALTER TABLE routine_slots ADD CONSTRAINT rs_no_section_double_booking
--       EXCLUDE USING gist (tenant_id WITH =, routine_id WITH =,
--                           primary_section_id WITH =, day_of_week WITH =,
--                           time_range WITH &&)
--
-- which is right about the ordinary case and wrong about the one this
-- product was built for. A Class 9 section splitting four ways for religion
-- has FOUR slots at one hour — Islam, Hindu, Buddhist, Christian, four
-- teachers, four rooms — and they are not a double-booking, because no
-- child is in two of them. Under 006 the second one is rejected, so a
-- school either schedules four separate periods (three quarters of the
-- section idle in each) or cannot use the product.
--
-- ── What distinguishes the two ───────────────────────────────────────────
-- The selection pool. subject_template_items.selection_pool already says
-- which subjects are ALTERNATIVES — it is what makes religion variants and
-- optional subjects the same mechanism rather than two special cases
-- (migration 025). A slot carries the pool it was placed as part of, and
-- two slots may share a section and an hour only when they name the same
-- pool.
--
-- Enforced as a trigger rather than by widening the EXCLUDE constraint,
-- because the rule is "may overlap only when EQUAL", and an exclusion
-- constraint can only say "may not overlap when equal". Inverting it needs
-- a <> strategy that btree_gist does not offer for text.
--
-- The exclusion constraint stays for ordinary slots, which are the vast
-- majority, so the common case keeps a constraint rather than a trigger.
-- ============================================================================
BEGIN;

ALTER TABLE routine_slots ADD COLUMN parallel_pool text;

COMMENT ON COLUMN routine_slots.parallel_pool IS
  'F-504. The subject_template_items.selection_pool this slot was placed as '
  'part of. Slots sharing a section, an hour AND this value are a parallel '
  'block — different students, not a double-booking. NULL for an ordinary '
  'class, which is most of them.';

-- The original constraint, now scoped to ordinary slots. Two religion
-- variants no longer collide with each other; two ordinary classes still
-- cannot share a section and an hour.
ALTER TABLE routine_slots DROP CONSTRAINT rs_no_section_double_booking;

ALTER TABLE routine_slots
  ADD CONSTRAINT rs_no_section_double_booking
  EXCLUDE USING gist (
    tenant_id          WITH =,
    routine_id         WITH =,
    primary_section_id WITH =,
    day_of_week        WITH =,
    time_range         WITH &&
  ) WHERE (status = 'active' AND primary_section_id IS NOT NULL
           AND parallel_pool IS NULL);

COMMENT ON CONSTRAINT rs_no_section_double_booking ON routine_slots IS
  'F-504. A section cannot be in two ordinary classes at once. Slots that '
  'name a parallel_pool are exempt and policed by '
  'app.assert_parallel_block_coherent instead, because "may overlap only '
  'when equal" is not something an exclusion constraint can express.';

-- ---------------------------------------------------------------------
-- The half the constraint cannot state.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.assert_parallel_block_coherent()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, app
AS $$
DECLARE v_other text; v_section text;
BEGIN
  IF NEW.status <> 'active' OR NEW.primary_section_id IS NULL THEN RETURN NEW; END IF;

  -- A pooled slot may share its hour only with slots of the SAME pool. A
  -- religion block and a maths class at one hour would put the whole
  -- section in two places, which is the thing the original constraint was
  -- right about.
  SELECT COALESCE(rs.parallel_pool, '(ordinary class)'), sec.name
    INTO v_other, v_section
    FROM routine_slots rs
    JOIN sections sec ON sec.id = rs.primary_section_id
   WHERE rs.id <> NEW.id
     AND rs.tenant_id = NEW.tenant_id
     AND rs.routine_id = NEW.routine_id
     AND rs.primary_section_id = NEW.primary_section_id
     AND rs.day_of_week = NEW.day_of_week
     -- Compared on the TIME COLUMNS, not on time_range: that column is
     -- filled by another BEFORE trigger, and which of the two fires first
     -- depends on trigger name order. Reading it here would silently
     -- compare against NULL and let everything through.
     AND rs.starts_at < NEW.ends_at AND NEW.starts_at < rs.ends_at
     AND rs.status = 'active'
     AND rs.parallel_pool IS DISTINCT FROM NEW.parallel_pool
   LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION
      'section % already has % at this hour; a parallel block may only '
      'overlap slots of the same pool', v_section, v_other
      USING ERRCODE = 'exclusion_violation',
            HINT = 'religion variants and optional subjects share one pool; '
                   'an ordinary class shares none';
  END IF;

  -- Two groups of one block must be different subjects. The same subject
  -- twice in one block is a duplicate, not an alternative.
  IF NEW.parallel_pool IS NOT NULL AND EXISTS (
    SELECT 1 FROM routine_slots rs
     WHERE rs.id <> NEW.id
       AND rs.tenant_id = NEW.tenant_id
       AND rs.routine_id = NEW.routine_id
       AND rs.primary_section_id = NEW.primary_section_id
       AND rs.day_of_week = NEW.day_of_week
       AND rs.starts_at < NEW.ends_at AND NEW.starts_at < rs.ends_at
       AND rs.status = 'active'
       AND rs.parallel_pool = NEW.parallel_pool
       AND rs.subject_id = NEW.subject_id
  ) THEN
    RAISE EXCEPTION 'the same subject appears twice in one parallel block'
      USING ERRCODE = 'unique_violation';
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER trg_routine_slots_parallel
  BEFORE INSERT OR UPDATE OF parallel_pool, starts_at, ends_at, day_of_week, primary_section_id
  ON routine_slots
  FOR EACH ROW EXECUTE FUNCTION app.assert_parallel_block_coherent();

COMMENT ON FUNCTION app.assert_parallel_block_coherent IS
  'F-504. Slots sharing a section and an hour must all name the same '
  'selection pool, and no subject may appear twice within one block.';

CREATE INDEX ix_routine_slots_parallel
  ON routine_slots (tenant_id, routine_id, primary_section_id, day_of_week)
  WHERE status = 'active' AND parallel_pool IS NOT NULL;

COMMIT;
