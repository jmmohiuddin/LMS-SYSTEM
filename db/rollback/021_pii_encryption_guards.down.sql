-- Rollback for 021 — national-identifier encryption guards (F-101).
--
-- Note what this does NOT do: it does not decrypt anything. Dropping the
-- guards leaves every sealed value sealed and every blind index intact, so
-- rolling back is safe but does not make the data readable without the key.
-- That is the correct behaviour — a rollback is an operational retreat, not
-- a decryption event.
BEGIN;

-- Deliberately NOT revoked: the sequence grants below repair a defect in
-- migration 010 (INSERT on the audit tables without USAGE on their
-- sequences). Revoking them would re-break the audit trail, which is not
-- something a rollback of F-101 should do.
--   audit.pii_access_id_seq, audit.activity_log_id_seq

DROP INDEX IF EXISTS ix_users_pii_key_version;

DROP FUNCTION IF EXISTS app.read_sealed_identifier(uuid, text, text, text, text, inet);

DROP TRIGGER IF EXISTS trg_users_pii_key_version ON users;
DROP FUNCTION IF EXISTS app.enforce_pii_key_version();

ALTER TABLE users
  DROP CONSTRAINT IF EXISTS users_nid_is_sealed,
  DROP CONSTRAINT IF EXISTS users_brc_is_sealed,
  DROP CONSTRAINT IF EXISTS users_nid_blind_len,
  DROP CONSTRAINT IF EXISTS users_brc_blind_len,
  DROP CONSTRAINT IF EXISTS users_nid_paired,
  DROP CONSTRAINT IF EXISTS users_brc_paired;

DROP FUNCTION IF EXISTS app.is_sealed_identifier(bytea);

COMMIT;
