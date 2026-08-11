-- Rollback for 031 — bulk import (F-1601).
--
-- Restores users_contactable, which means restoring the state where a
-- child with no phone of their own cannot be recorded at all and two
-- siblings cannot share a guardian's mobile. Any student row imported
-- under 031 will have a NULL phone and will BLOCK this rollback until
-- those rows are given a contact or removed — deliberately. Silently
-- deleting children to satisfy a constraint is not a rollback.
BEGIN;

DROP TRIGGER IF EXISTS trg_users_reachable ON users;
DROP FUNCTION IF EXISTS app.assert_user_reachable();

DROP TABLE IF EXISTS import_batches;
DROP TYPE IF EXISTS import_kind;

-- NOT VALID would let this succeed against rows it does not hold for, and
-- then fail confusingly at the next write. Better to fail here, loudly,
-- while the operator is looking at it.
ALTER TABLE users
  ADD CONSTRAINT users_contactable
  CHECK (phone_e164 IS NOT NULL OR email IS NOT NULL);

COMMIT;
