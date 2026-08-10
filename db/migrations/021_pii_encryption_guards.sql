-- ============================================================================
-- 021 — National-identifier encryption guards  (F-101, TRD §7.1)
--
-- Migration 002 declared users.nid_ciphertext / brc_ciphertext, their blind
-- indexes and pii_key_version, and nothing has ever written them. This
-- migration does not add columns — it adds the guarantees that make those
-- columns trustworthy, now that packages/server-core/src/pii-crypto.ts
-- actually seals values into them.
--
-- The rule being enforced: a national ID or birth-registration number can
-- only ever reach this database as a well-formed AES-256-GCM envelope. The
-- application is where sealing happens, but the application is also where
-- bugs happen, so the database refuses malformed input independently. A
-- developer who writes digits straight into the bytea column — the exact
-- mistake this rule exists to prevent — gets a constraint violation, not a
-- silent plaintext leak discovered in a breach two years later.
-- ============================================================================
BEGIN;

-- ---------------------------------------------------------------------
-- Envelope shape (pii-crypto.ts):
--   byte 0     format version, currently 1
--   byte 1     key version, 1..16
--   bytes 2-13 GCM IV (12 bytes)
--   bytes 14+  ciphertext || 16-byte tag
--
-- A 10-digit NID seals to 2 + 12 + 10 + 16 = 40 bytes. The minimum below
-- (2 + 12 + 1 + 16 = 31) is the shortest structurally possible envelope, so
-- the constraint rejects garbage without encoding a policy about identifier
-- length — that belongs in the application, where it can produce a message
-- a school clerk can act on.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.is_sealed_identifier(p bytea)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT p IS NULL
      OR (octet_length(p) >= 31
          AND get_byte(p, 0) = 1
          AND get_byte(p, 1) BETWEEN 1 AND 16)
$$;

COMMENT ON FUNCTION app.is_sealed_identifier IS
  'True when the value is NULL or a structurally valid pii-crypto envelope. '
  'Deliberately cheap and shape-only: authenticity is proven by GCM at '
  'decryption time, and a constraint cannot hold a key.';

ALTER TABLE users
  ADD CONSTRAINT users_nid_is_sealed CHECK (app.is_sealed_identifier(nid_ciphertext)),
  ADD CONSTRAINT users_brc_is_sealed CHECK (app.is_sealed_identifier(brc_ciphertext));

-- Blind indexes are HMAC-SHA256 — always exactly 32 bytes. A short value
-- means someone stored a truncated hash or, worse, raw text.
ALTER TABLE users
  ADD CONSTRAINT users_nid_blind_len CHECK (nid_blind_index IS NULL OR octet_length(nid_blind_index) = 32),
  ADD CONSTRAINT users_brc_blind_len CHECK (brc_blind_index IS NULL OR octet_length(brc_blind_index) = 32);

-- A ciphertext without its blind index is a record that can never be found
-- again by duplicate detection; a blind index without its ciphertext is a
-- searchable token for data we no longer hold. Both are bugs, so the two
-- columns must move together.
ALTER TABLE users
  ADD CONSTRAINT users_nid_paired
    CHECK ((nid_ciphertext IS NULL) = (nid_blind_index IS NULL)),
  ADD CONSTRAINT users_brc_paired
    CHECK ((brc_ciphertext IS NULL) = (brc_blind_index IS NULL));

-- ---------------------------------------------------------------------
-- pii_key_version must agree with the bytes.
--
-- Rotation reads this column to find rows still on an old key. If it ever
-- disagrees with the envelope header, the rotation job skips rows it should
-- have moved and the old key can never be safely retired. The envelope is
-- authoritative (it is what decryption actually reads); this trigger keeps
-- the column honest so it stays a usable index for the sweep.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.enforce_pii_key_version()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE v smallint;
BEGIN
  v := NULL;
  IF NEW.nid_ciphertext IS NOT NULL THEN
    v := get_byte(NEW.nid_ciphertext, 1);
  END IF;
  IF NEW.brc_ciphertext IS NOT NULL THEN
    IF v IS NOT NULL AND get_byte(NEW.brc_ciphertext, 1) <> v THEN
      -- Both identifiers on one row must share a key version, or the
      -- rotation sweep would have to re-encrypt the row twice and could
      -- leave it half-moved.
      RAISE EXCEPTION 'nid and brc on user % were sealed under different key versions', NEW.id
        USING ERRCODE = 'check_violation';
    END IF;
    v := get_byte(NEW.brc_ciphertext, 1);
  END IF;

  IF v IS NOT NULL THEN
    NEW.pii_key_version := v;
  END IF;
  RETURN NEW;
END $$;

COMMENT ON FUNCTION app.enforce_pii_key_version IS
  'Derives users.pii_key_version from the ciphertext envelope rather than '
  'trusting the caller. The column exists so rotation can find stale rows; '
  'if it could drift from the bytes it would be worse than absent.';

CREATE TRIGGER trg_users_pii_key_version
  BEFORE INSERT OR UPDATE OF nid_ciphertext, brc_ciphertext ON users
  FOR EACH ROW EXECUTE FUNCTION app.enforce_pii_key_version();

-- ---------------------------------------------------------------------
-- Audited decryption.
--
-- PDPA 2026 makes every read of a national identifier a reportable
-- processing event, and audit.pii_access (migration 001) is where it lands.
-- The application role can INSERT there and cannot UPDATE or DELETE (see
-- migration 010's grant), so the trail is append-only from the app's side.
--
-- This function exists so a caller cannot fetch a ciphertext without the
-- audit row being written in the SAME transaction: if the audit insert
-- fails, the read fails with it. An endpoint that queried the column
-- directly and then wrote an audit row separately would lose the trail on
-- any error between the two.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.read_sealed_identifier(
  p_subject_id   uuid,
  p_field        text,
  p_purpose_code text,
  p_legal_basis  text,
  p_subject_type text DEFAULT 'student',
  p_ip           inet DEFAULT NULL
)
RETURNS bytea
LANGUAGE plpgsql
SECURITY INVOKER          -- RLS on users still applies; this is not a bypass
SET search_path = public, app, audit
AS $$
DECLARE v_cipher bytea;
BEGIN
  IF p_field NOT IN ('nid', 'brc') THEN
    RAISE EXCEPTION 'unknown pii field %', p_field USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF coalesce(p_purpose_code, '') = '' OR coalesce(p_legal_basis, '') = '' THEN
    -- No purpose, no read. PDPA requires a stated basis, and a nullable
    -- audit column would make it optional in practice.
    RAISE EXCEPTION 'purpose_code and legal_basis are required to read a national identifier'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT CASE p_field WHEN 'nid' THEN u.nid_ciphertext ELSE u.brc_ciphertext END
    INTO v_cipher
    FROM users u
   WHERE u.id = p_subject_id;     -- RLS decides whether this row is visible

  IF NOT FOUND THEN
    RAISE EXCEPTION 'subject not found' USING ERRCODE = 'no_data_found';
  END IF;
  IF v_cipher IS NULL THEN
    RETURN NULL;                  -- nothing held; nothing to report
  END IF;

  INSERT INTO audit.pii_access
    (tenant_id, actor_id, subject_type, subject_id, field, purpose_code, legal_basis, ip_address)
  VALUES
    (app.current_tenant(), app.current_user_id(), p_subject_type, p_subject_id,
     p_field, p_purpose_code, p_legal_basis, p_ip);

  RETURN v_cipher;
END $$;

COMMENT ON FUNCTION app.read_sealed_identifier IS
  'The only sanctioned path to a national-identifier ciphertext. Writes the '
  'audit.pii_access row in the same transaction as the read, so the trail '
  'cannot be lost between the two. SECURITY INVOKER — RLS still governs '
  'which subjects the caller can see.';

REVOKE ALL ON FUNCTION app.read_sealed_identifier(uuid, text, text, text, text, inet) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.read_sealed_identifier(uuid, text, text, text, text, inet) TO shikhon_app;

-- ---------------------------------------------------------------------
-- Repairs a latent hole in migration 010.
--
-- 010 grants shikhon_app INSERT on audit.activity_log and audit.pii_access,
-- but its companion sequence grant is `ALL SEQUENCES IN SCHEMA public` —
-- and both tables are bigserial in schema `audit`. So the application role
-- had INSERT on the audit tables and no USAGE on the sequences backing
-- their primary keys, which means every audit write would have failed with
-- "permission denied for sequence". The audit trail has never been
-- writable.
--
-- Nothing has written to them yet, so nothing was lost — but F-101 makes
-- the pii_access write mandatory (app.read_sealed_identifier fails if the
-- audit insert fails), so this must be fixed here or reading any national
-- identifier is impossible. activity_log is granted alongside it because
-- it has exactly the same defect and leaving one half broken would be
-- arbitrary.
--
-- platform_access is deliberately NOT granted: it records break-glass use
-- of the BYPASSRLS role, and the application role has no business writing
-- to it.
-- ---------------------------------------------------------------------
GRANT USAGE, SELECT ON SEQUENCE audit.pii_access_id_seq, audit.activity_log_id_seq TO shikhon_app;

-- ---------------------------------------------------------------------
-- Rotation support: which rows are still on an old key.
-- ---------------------------------------------------------------------
CREATE INDEX ix_users_pii_key_version ON users (tenant_id, pii_key_version)
  WHERE nid_ciphertext IS NOT NULL OR brc_ciphertext IS NOT NULL;

COMMIT;
