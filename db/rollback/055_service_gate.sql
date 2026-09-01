-- Rollback for 055 — the service gate.
--
-- After this the console's thirteen service switches go back to changing a
-- row and nothing else. Roll back the P7 console with it.
BEGIN;
DROP FUNCTION IF EXISTS app.tenant_access(uuid, text, text);
COMMIT;
