-- Rollback for 051 — the platform operations model.
--
-- Drops the commercial and control tables and returns `plan_code` to being
-- free text. Run 052's rollback FIRST: its functions read these tables.
--
-- ── What running this destroys ───────────────────────────────────────────
-- Every recorded payment. `tenant_payments` is the only record shikhonBD has
-- that a school paid — there is no gateway behind it to re-read. Run
--
--   SELECT count(*), sum(amount_bdt) FROM tenant_payments;
--
-- as the owner first. A non-zero answer is a decision, not a migration step.
--
-- Also lost: every per-service and per-portal override. A school that was
-- deliberately limited becomes fully active again the moment this runs.
BEGIN;

ALTER TABLE tenants DROP CONSTRAINT IF EXISTS tenants_plan_fk;

DROP TABLE IF EXISTS tenant_payments;
DROP TABLE IF EXISTS tenant_operations;
DROP TABLE IF EXISTS service_catalogue;
DROP TABLE IF EXISTS plans;

DROP TYPE IF EXISTS tenant_ops_state;

COMMIT;
