-- Rollback for 054 — the portal gate.
--
-- After this the console's portal switches go back to being decorative: the
-- rows still record who was locked out, and nobody is. Roll back the P7
-- console alongside it, or operators will be told a lie by a screen.
BEGIN;
DROP FUNCTION IF EXISTS app.tenant_access(uuid, text);
COMMIT;
