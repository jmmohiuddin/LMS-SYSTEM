-- ---------------------------------------------------------------------------
-- 061 — the two tables P7 left outside the RLS invariant.
--
-- ── How this was found ───────────────────────────────────────────────────
-- By running `db/tests/schema_lint.sql`, which P7 never did. It had been
-- failing since migration 051 with four problems, all of them P7's:
--
--   L1 plans:              no tenant_id column and not in the exempt list
--   L1 service_catalogue:  no tenant_id column and not in the exempt list
--   L2 tenant_operations:  RLS enabled=t forced=f (both must be true)
--   L2 tenant_payments:    RLS enabled=t forced=f (both must be true)
--
-- Two are a declaration this migration makes (the lint file's exempt list),
-- and two are a real gap this migration closes.
--
-- ── L2 is the one that matters ───────────────────────────────────────────
-- `ENABLE ROW LEVEL SECURITY` does not apply to the table's OWNER. Every
-- other tenant-scoped table in this schema also carries `FORCE`, precisely so
-- that no role — not even `shikhon_owner`, which migrations and maintenance
-- run as — can read across schools by accident.
--
-- `tenant_operations` holds every school's operational state and
-- `tenant_payments` holds every payment ever recorded. They are the two
-- newest tenant-scoped tables in the product and the only two without FORCE.
-- The application cannot exploit it — `shikhon_app` and `shikhon_platform`
-- own nothing — but the invariant exists so that "is this table safe" is
-- never a question anyone has to answer per-table, and P7 quietly made it one
-- twice.
--
-- ── L1 is a declaration, not a fix ───────────────────────────────────────
-- `plans` is the price list and `service_catalogue` is the list of thirteen
-- sellable services. Both are platform-global reference data, like
-- `subject_catalogue` and `roles` beside them — there is no per-school price
-- list. They belong in the lint's exempt list, and the lint is right to have
-- demanded the statement: a table with no `tenant_id` is either deliberate or
-- a serious mistake, and the only way to tell is for somebody to say which.
-- That edit is in `db/tests/schema_lint.sql`, beside the other exemptions and
-- their reasons.
-- ---------------------------------------------------------------------------

BEGIN;

ALTER TABLE tenant_operations FORCE ROW LEVEL SECURITY;
ALTER TABLE tenant_payments   FORCE ROW LEVEL SECURITY;

-- Prove it, rather than trusting that the two statements above did what they
-- read like. A migration that silently no-ops is how the gap appeared.
DO $$
DECLARE bad text;
BEGIN
  SELECT string_agg(c.relname, ', ') INTO bad
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public'
     AND c.relname IN ('tenant_operations', 'tenant_payments')
     AND NOT (c.relrowsecurity AND c.relforcerowsecurity);
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'RLS is still not forced on: %', bad;
  END IF;
END $$;

COMMIT;
