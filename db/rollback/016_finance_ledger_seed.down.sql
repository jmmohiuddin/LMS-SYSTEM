-- Rollback for 016 — finance ledger seed.
--
-- This file was missing. Every other migration has a paired .down.sql, and
-- .github/workflows/database.yml runs the whole rollback set in descending
-- order and asserts the public schema ends up empty. 016 creates only two
-- functions in the `app` schema, so its absence never failed that gate —
-- which is exactly why it went unnoticed for so long.
--
-- Note what this does NOT do: it does not delete any ledger_accounts rows
-- that app.seed_chart_of_accounts() has already created for a tenant. Those
-- are that school's chart of accounts, with ledger entries posted against
-- them. Dropping the seeding function is reversible; deleting a school's
-- books is not, and a rollback must never do the second while claiming to
-- do the first.
BEGIN;

DROP FUNCTION IF EXISTS app.provision_chart_step(uuid);
DROP FUNCTION IF EXISTS app.seed_chart_of_accounts(uuid);

COMMIT;
