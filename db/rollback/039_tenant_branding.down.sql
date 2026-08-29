-- Rollback for 039 — tenant branding (R-1).
--
-- Drops the pre-auth read function and the shape guard. After this, the
-- login screen falls back to the neutral ui-core defaults for every tenant,
-- because app.public_branding() is what serves it before a session exists.
--
-- settings->'branding' is deliberately LEFT IN PLACE. It is data a school
-- typed — its name, its logo, its colours — and rolling back a function
-- definition is no reason to destroy it. Re-applying 039 finds it already
-- present and its seed UPDATE skips those rows, so up → down → up is
-- lossless and idempotent, which is exactly what the CI cycle asserts.
BEGIN;

DROP FUNCTION IF EXISTS app.public_branding(text);

ALTER TABLE tenants
  DROP CONSTRAINT IF EXISTS tenants_branding_is_object;

COMMIT;
