-- Rollback for 052 — the enforcement gate.
--
-- Drops the four functions the application layer asks before every tenant
-- request. After this, `tenants.status = 'suspended'` goes back to meaning
-- NOTHING — which is the state P7-1 found and 052 exists to end.
--
-- Run this only together with reverting the application code that calls
-- `app.tenant_access`; on its own it turns every tenant request into an
-- error, because the gate fails closed by design.
BEGIN;

DROP POLICY IF EXISTS tenant_payments_platform ON tenant_payments;
DROP POLICY IF EXISTS tenant_ops_self ON tenant_operations;

DROP FUNCTION IF EXISTS app.tenant_portal_open(uuid, text);
DROP FUNCTION IF EXISTS app.tenant_service_state(uuid, text);
DROP FUNCTION IF EXISTS app.tenant_access(uuid);
DROP FUNCTION IF EXISTS app.tenant_billing_state(uuid);
DROP FUNCTION IF EXISTS app.portal_of(text);

COMMIT;
