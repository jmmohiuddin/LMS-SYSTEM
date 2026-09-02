-- Rollback for 061 — takes FORCE ROW LEVEL SECURITY back off.
--
-- WARNING: after this, the table OWNER bypasses RLS on `tenant_operations`
-- and `tenant_payments` — every school's operational state and every payment
-- ever recorded. `db/tests/schema_lint.sql` fails again with L2 on both, which
-- is the intended alarm.
--
-- The exempt-list entries for `plans` and `service_catalogue` live in
-- db/tests/schema_lint.sql and are a declaration, not schema; revert that file
-- with git if you are undoing the whole change.
BEGIN;
ALTER TABLE tenant_operations NO FORCE ROW LEVEL SECURITY;
ALTER TABLE tenant_payments   NO FORCE ROW LEVEL SECURITY;
COMMIT;
