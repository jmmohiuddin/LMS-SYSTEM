-- Rollback for 057 — removes `last_active_at` from the console's list.
--
-- `platform_overview` is a RETURNS TABLE, so the column cannot be dropped in
-- place: the function has to go and 053's version has to be re-created.
--
--     psql -f db/rollback/057_platform_activity.sql
--     psql -f db/migrations/053_platform_overview.sql      <-- REQUIRED
--
-- Between those two commands the platform console has no list at all. Run
-- them together, and roll back the P7 console code alongside — the client
-- reads `lastActiveAt` and will show "কখনো ব্যবহার হয়নি" for every school
-- until it is reverted too.
BEGIN;
DROP FUNCTION IF EXISTS app.platform_overview();
COMMIT;
