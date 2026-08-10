-- =====================================================================
-- db/tests/pii_encryption.sql   (F-101)
--
-- The database half of national-identifier encryption. The application
-- half (packages/server-core/src/pii-crypto.ts) is covered by
-- packages/server-core/test/pii-crypto.test.ts; these assert the guards
-- that hold even when the application is wrong — a developer writing raw
-- digits into the bytea column, a half-written row, a key version that
-- disagrees with the bytes, or a decryption that skips its audit trail.
--
-- Everything runs inside transactions that are ROLLED BACK, so the suite
-- leaves no residue and is safe against any environment.
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/tests/pii_encryption.sql
-- =====================================================================

\set ON_ERROR_STOP on

-- MANDATORY, same reason as invariants.sql: migration/superuser roles carry
-- BYPASSRLS, and app.read_sealed_identifier is SECURITY INVOKER — running
-- as an owner would silently prove nothing about what the app can see.
GRANT shikhon_app TO CURRENT_USER;
SET ROLE shikhon_app;

\set tP '''9e000000-0000-4000-8000-00000000000e'''
\set u1 '''9e000000-0000-4000-8000-000000000001'''
\set u2 '''9e000000-0000-4000-8000-000000000002'''

BEGIN;
SET LOCAL app.tenant_id = '9e000000-0000-4000-8000-00000000000e';
SET LOCAL app.role      = 'principal';
SET LOCAL app.user_id   = '9e000000-0000-4000-8000-0000000000ff';

INSERT INTO tenants (id, slug, name_bn, name_en, stream, level)
VALUES (:tP, 'pii-check', 'পিআইআই বিদ্যালয়', 'PII School', 'bangla_medium', 'secondary');

INSERT INTO users (id, tenant_id, full_name_bn, full_name_en, phone_e164)
VALUES (:u1, :tP, 'করিম', 'Karim', '+8801799999901'),
       (:u2, :tP, 'নাসরিন', 'Nasrin', '+8801799999902');

-- A well-formed envelope, byte-for-byte what pii-crypto.ts produces:
--   \x01 format, \x01 key version, 12 IV bytes, 10 ciphertext + 16 tag.
\set sealed_v1 '''\\x0101000102030405060708090a0b''' || '''202122232425262728292a2b2c2d2e2f3031323334353637383940414243444546'''
\set blind32   '''\\xaa00112233445566778899aabbccddeeff00112233445566778899aabbccddee'''

-- ---------------------------------------------------------------------
-- 1. A valid envelope is accepted, and pii_key_version is derived from it.
-- ---------------------------------------------------------------------
DO $$
DECLARE v smallint;
BEGIN
  UPDATE users
     SET nid_ciphertext = decode('0101000102030405060708090a0b202122232425262728292a2b2c2d2e2f303132333435363738394041424344', 'hex'),
         nid_blind_index = decode(repeat('ab', 32), 'hex'),
         pii_key_version = 7          -- deliberately WRONG; the trigger must fix it
   WHERE id = '9e000000-0000-4000-8000-000000000001';

  SELECT pii_key_version INTO v FROM users WHERE id = '9e000000-0000-4000-8000-000000000001';
  IF v <> 1 THEN
    RAISE EXCEPTION 'FAIL 1: pii_key_version is % — the trigger must derive it from the envelope, not trust the caller', v;
  END IF;
  RAISE NOTICE 'PASS 1 — pii_key_version derived from the ciphertext, caller''s value overridden';
END $$;

-- ---------------------------------------------------------------------
-- 2. Raw digits cannot be written into the ciphertext column.
--
-- This is the mistake the whole constraint exists for: someone in a hurry
-- writes the NID straight in "to be encrypted later". It must fail here,
-- not be discovered in a breach notification.
-- ---------------------------------------------------------------------
DO $$
BEGIN
  BEGIN
    UPDATE users
       SET nid_ciphertext = convert_to('1990123456', 'UTF8'),
           nid_blind_index = decode(repeat('ab', 32), 'hex')
     WHERE id = '9e000000-0000-4000-8000-000000000002';
    RAISE EXCEPTION 'FAIL 2: plaintext digits were accepted into nid_ciphertext';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'PASS 2 — plaintext digits rejected by users_nid_is_sealed';
  END;
END $$;

-- ---------------------------------------------------------------------
-- 3. A structurally impossible envelope is rejected (too short, bad
--    format byte, key version out of range).
-- ---------------------------------------------------------------------
DO $$
DECLARE bad bytea;
BEGIN
  FOREACH bad IN ARRAY ARRAY[
    decode('0101ff', 'hex'),                                                       -- too short
    decode('9901000102030405060708090a0b202122232425262728292a2b2c2d2e2f303132333435363738394041424344', 'hex'),  -- format 0x99
    decode('01ff000102030405060708090a0b202122232425262728292a2b2c2d2e2f303132333435363738394041424344', 'hex')   -- key version 255
  ] LOOP
    BEGIN
      UPDATE users SET nid_ciphertext = bad, nid_blind_index = decode(repeat('ab', 32), 'hex')
       WHERE id = '9e000000-0000-4000-8000-000000000002';
      RAISE EXCEPTION 'FAIL 3: malformed envelope % was accepted', encode(bad, 'hex');
    EXCEPTION WHEN check_violation THEN
      NULL;  -- expected
    END;
  END LOOP;
  RAISE NOTICE 'PASS 3 — truncated, wrong-format and out-of-range envelopes all rejected';
END $$;

-- ---------------------------------------------------------------------
-- 4. Ciphertext and blind index must move together.
--
-- A ciphertext with no index can never be found by duplicate detection; an
-- index with no ciphertext is a searchable token for data we no longer
-- hold. Both are bugs and both must be impossible.
-- ---------------------------------------------------------------------
DO $$
BEGIN
  BEGIN
    UPDATE users SET nid_ciphertext = decode('0101000102030405060708090a0b202122232425262728292a2b2c2d2e2f303132333435363738394041424344', 'hex'),
                     nid_blind_index = NULL
     WHERE id = '9e000000-0000-4000-8000-000000000002';
    RAISE EXCEPTION 'FAIL 4a: ciphertext without a blind index was accepted';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'PASS 4a — ciphertext without its blind index rejected';
  END;

  BEGIN
    UPDATE users SET nid_ciphertext = NULL, nid_blind_index = decode(repeat('cd', 32), 'hex')
     WHERE id = '9e000000-0000-4000-8000-000000000002';
    RAISE EXCEPTION 'FAIL 4b: a blind index with no ciphertext was accepted';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'PASS 4b — orphaned blind index rejected';
  END;
END $$;

-- ---------------------------------------------------------------------
-- 5. A blind index must be a full HMAC-SHA256 — 32 bytes, never truncated.
-- ---------------------------------------------------------------------
DO $$
BEGIN
  BEGIN
    UPDATE users SET nid_ciphertext = decode('0101000102030405060708090a0b202122232425262728292a2b2c2d2e2f303132333435363738394041424344', 'hex'),
                     nid_blind_index = decode(repeat('ab', 16), 'hex')
     WHERE id = '9e000000-0000-4000-8000-000000000002';
    RAISE EXCEPTION 'FAIL 5: a 16-byte blind index was accepted';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'PASS 5 — short blind index rejected';
  END;
END $$;

-- ---------------------------------------------------------------------
-- 6. Duplicate detection still works — the point of having an index at all.
-- ---------------------------------------------------------------------
DO $$
BEGIN
  BEGIN
    -- u1 already carries repeat('ab',32) from assertion 1.
    UPDATE users SET nid_ciphertext = decode('0101000102030405060708090a0b202122232425262728292a2b2c2d2e2f303132333435363738394041424344', 'hex'),
                     nid_blind_index = decode(repeat('ab', 32), 'hex')
     WHERE id = '9e000000-0000-4000-8000-000000000002';
    RAISE EXCEPTION 'FAIL 6: two students in one tenant were allowed the same NID';
  EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE 'PASS 6 — uq_users_nid_blind still catches a duplicate NID without plaintext';
  END;
END $$;

-- ---------------------------------------------------------------------
-- 7. nid and brc on one row cannot sit on different key versions, or the
--    rotation sweep could leave the row half-moved.
-- ---------------------------------------------------------------------
DO $$
BEGIN
  BEGIN
    UPDATE users
       SET brc_ciphertext = decode('0102000102030405060708090a0b202122232425262728292a2b2c2d2e2f303132333435363738394041424344', 'hex'),
           brc_blind_index = decode(repeat('ef', 32), 'hex')
     WHERE id = '9e000000-0000-4000-8000-000000000001';   -- already has a v1 nid
    RAISE EXCEPTION 'FAIL 7: mixed key versions on one row were accepted';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'PASS 7 — nid and brc forced onto the same key version';
  END;
END $$;

-- ---------------------------------------------------------------------
-- 8. The audit trail is append-only from the application's side.
--
-- Migration 010 grants shikhon_app INSERT on audit.pii_access and nothing
-- else. That is what makes the trail trustworthy: the role that reads
-- national identifiers cannot read, edit or erase the record of having
-- done so. Asserted first, because assertions 9-11 have to work around it.
-- ---------------------------------------------------------------------
DO $$
DECLARE n integer;
BEGIN
  BEGIN
    SELECT count(*) INTO n FROM audit.pii_access;
    RAISE EXCEPTION 'FAIL 8: shikhon_app can read its own PII access log';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'PASS 8 — audit.pii_access is append-only to the application role';
  END;
END $$;

-- ---------------------------------------------------------------------
-- 9. Reading an identifier writes its audit row in the SAME transaction.
--    Counted from the owner role, since assertion 8 just proved the app
--    cannot count it itself.
-- ---------------------------------------------------------------------
DO $$
DECLARE c bytea;
BEGIN
  c := app.read_sealed_identifier(
         '9e000000-0000-4000-8000-000000000001'::uuid, 'nid',
         'board_registration', 'PDPA 2026 s.7(b) legal obligation', 'student');
  IF c IS NULL THEN RAISE EXCEPTION 'FAIL 9: the ciphertext came back NULL'; END IF;
END $$;

RESET ROLE;
DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM audit.pii_access
   WHERE subject_id = '9e000000-0000-4000-8000-000000000001'
     AND field = 'nid' AND purpose_code = 'board_registration';
  IF n <> 1 THEN RAISE EXCEPTION 'FAIL 9: expected exactly 1 audit row, found %', n; END IF;
  RAISE NOTICE 'PASS 9 — reading a national identifier wrote its audit.pii_access row';
END $$;
SET ROLE shikhon_app;

-- ---------------------------------------------------------------------
-- 10. No purpose, no read. PDPA requires a stated basis; making it
--     optional in code is how it becomes optional in practice.
-- ---------------------------------------------------------------------
DO $$
BEGIN
  BEGIN
    PERFORM app.read_sealed_identifier(
      '9e000000-0000-4000-8000-000000000001'::uuid, 'nid', '', 'PDPA 2026 s.7(b)');
    RAISE EXCEPTION 'FAIL 10a: a read with no purpose_code was allowed';
  EXCEPTION WHEN invalid_parameter_value THEN
    RAISE NOTICE 'PASS 10a — read refused without a purpose code';
  END;

  BEGIN
    PERFORM app.read_sealed_identifier(
      '9e000000-0000-4000-8000-000000000001'::uuid, 'nid', 'board_registration', '');
    RAISE EXCEPTION 'FAIL 10b: a read with no legal basis was allowed';
  EXCEPTION WHEN invalid_parameter_value THEN
    RAISE NOTICE 'PASS 10b — read refused without a legal basis';
  END;

  BEGIN
    PERFORM app.read_sealed_identifier(
      '9e000000-0000-4000-8000-000000000001'::uuid, 'passport', 'x', 'y');
    RAISE EXCEPTION 'FAIL 10c: an unknown field name was accepted';
  EXCEPTION WHEN invalid_parameter_value THEN
    RAISE NOTICE 'PASS 10c — unknown field name refused';
  END;
END $$;

-- ---------------------------------------------------------------------
-- 11. A subject with nothing stored returns NULL and writes NO audit row.
--     Logging a read of data we do not hold would poison the volumetric
--     alerting that audit.pii_access exists to feed.
-- ---------------------------------------------------------------------
DO $$
DECLARE c bytea;
BEGIN
  c := app.read_sealed_identifier(
         '9e000000-0000-4000-8000-000000000002'::uuid, 'nid',
         'dsar', 'PDPA 2026 s.12 subject access');
  IF c IS NOT NULL THEN RAISE EXCEPTION 'FAIL 11: expected NULL for a subject with no NID'; END IF;
END $$;

RESET ROLE;
DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM audit.pii_access
   WHERE subject_id = '9e000000-0000-4000-8000-000000000002';
  IF n <> 0 THEN RAISE EXCEPTION 'FAIL 11: an audit row was written for data we do not hold'; END IF;
  RAISE NOTICE 'PASS 11 — absent identifier returns NULL and logs nothing';
END $$;
SET ROLE shikhon_app;

-- ---------------------------------------------------------------------
-- 12. RLS still governs the read. read_sealed_identifier is SECURITY
--     INVOKER precisely so it cannot become a tenant-isolation bypass.
-- ---------------------------------------------------------------------
DO $$
BEGIN
  PERFORM set_config('app.tenant_id', '9e000000-0000-4000-8000-0000000000bb', true);
  BEGIN
    PERFORM app.read_sealed_identifier(
      '9e000000-0000-4000-8000-000000000001'::uuid, 'nid', 'board_registration', 'PDPA 2026 s.7(b)');
    RAISE EXCEPTION 'FAIL 12: another tenant read a national identifier';
  EXCEPTION WHEN no_data_found THEN
    RAISE NOTICE 'PASS 12 — RLS hid the subject from another tenant, no ciphertext returned';
  END;
  PERFORM set_config('app.tenant_id', '9e000000-0000-4000-8000-00000000000e', true);
END $$;

ROLLBACK;

RESET ROLE;

DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM tenants WHERE id = '9e000000-0000-4000-8000-00000000000e';
  IF n <> 0 THEN RAISE EXCEPTION 'FAIL teardown: the fixture tenant survived'; END IF;
  RAISE NOTICE 'PASS teardown — no fixture rows remain';
END $$;

\echo ''
\echo '================================================'
\echo ' F-101 database guards passed.'
\echo '================================================'
