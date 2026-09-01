-- ---------------------------------------------------------------------------
-- 058 — a catalogue must not be able to describe a service that isn't there.
--
-- 051 shipped `documents` declaring a dependency on `documents_source`, a code
-- that does not exist, and then cleared it two statements later with the
-- comment "the sort of thing a catalogue should not be able to say". It fixed
-- the one instance and left the next one possible.
--
-- It matters because of what reads the column. `setService` refuses to switch
-- a service off while something that depends on it is still on:
--
--     SELECT c.code FROM service_catalogue c WHERE $2 = ANY(c.depends_on) ...
--
-- A dangling code in `depends_on` never matches, so it does not raise an
-- error — it silently makes the refusal not fire. That is the same failure
-- shape as everything else this phase found: no error, no rows, and a control
-- that quietly does nothing.
--
-- ── Also: no self-dependency, and no cycles of length two ───────────────
-- A service depending on itself would make it permanently undisableable, and
-- two services depending on each other would make neither one disableable.
-- Both are catalogue mistakes rather than attacks, and both are cheap to
-- refuse at the point they are written. Longer cycles are not checked: they
-- need a graph walk on every write of a thirteen-row table nobody edits at
-- runtime, and the trigger would cost more than the mistake.
-- ---------------------------------------------------------------------------

BEGIN;

CREATE OR REPLACE FUNCTION app.check_service_dependencies()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_missing text[];
  v_cycle   text;
BEGIN
  IF NEW.depends_on IS NULL OR array_length(NEW.depends_on, 1) IS NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.code = ANY (NEW.depends_on) THEN
    RAISE EXCEPTION 'service "%" cannot depend on itself', NEW.code
      USING ERRCODE = '23514';
  END IF;

  SELECT array_agg(d) INTO v_missing
    FROM unnest(NEW.depends_on) AS d
   WHERE NOT EXISTS (SELECT 1 FROM service_catalogue c WHERE c.code = d);

  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'service "%" depends on unknown service(s): %',
      NEW.code, array_to_string(v_missing, ', ')
      USING ERRCODE = '23503';
  END IF;

  SELECT c.code INTO v_cycle
    FROM service_catalogue c
   WHERE c.code = ANY (NEW.depends_on)
     AND NEW.code = ANY (c.depends_on)
   LIMIT 1;

  IF v_cycle IS NOT NULL THEN
    RAISE EXCEPTION 'services "%" and "%" cannot depend on each other',
      NEW.code, v_cycle
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS service_dependencies_valid ON service_catalogue;
CREATE TRIGGER service_dependencies_valid
  BEFORE INSERT OR UPDATE OF depends_on, code ON service_catalogue
  FOR EACH ROW EXECUTE FUNCTION app.check_service_dependencies();

-- Prove it against what is already there: if 051's cleanup was ever skipped,
-- or a later edit reintroduced a dangling code, this fails the migration
-- rather than installing a guard that only applies to future rows.
DO $$
DECLARE bad text;
BEGIN
  SELECT c.code || ' -> ' || d INTO bad
    FROM service_catalogue c, unnest(c.depends_on) AS d
   WHERE NOT EXISTS (SELECT 1 FROM service_catalogue x WHERE x.code = d)
   LIMIT 1;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'existing catalogue already has a dangling dependency: %', bad;
  END IF;
END $$;

COMMIT;
