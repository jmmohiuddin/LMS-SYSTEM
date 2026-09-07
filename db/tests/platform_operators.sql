-- =====================================================================
-- db/tests/platform_operators.sql   (P10-5, B-39)
--
-- The operator directory exists so `audit.platform_access.admin_id` resolves
-- to a person. It is the one table in this schema that is NOT tenant-scoped
-- and NOT reachable from a school, and it is deliberately append-and-amend:
-- a revoked operator is kept, because the audit rows they wrote must stay
-- resolvable for as long as those rows do.
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/tests/platform_operators.sql
-- =====================================================================

\set ON_ERROR_STOP on

GRANT shikhon_platform TO CURRENT_USER;
SET ROLE shikhon_platform;

\set A '''7c9c0000-0000-4000-8000-0000000000a1'''
\set B '''7c9c0000-0000-4000-8000-0000000000b1'''

DO $$
DECLARE
  v_n      bigint;
  v_status text;
BEGIN
  -- ================================================================
  -- 1. Naming a credential, and naming it again, are the same act.
  -- ================================================================
  PERFORM app.upsert_platform_operator(
    '7c9c0000-0000-4000-8000-0000000000a1'::uuid,
    '7c9c0000-0000-4000-8000-0000000000b1'::uuid, 'পরীক্ষা অপারেটর');
  PERFORM app.upsert_platform_operator(
    '7c9c0000-0000-4000-8000-0000000000a1'::uuid,
    '7c9c0000-0000-4000-8000-0000000000b1'::uuid, 'পরীক্ষা অপারেটর (সংশোধিত)');

  SELECT count(*) INTO v_n FROM platform_operators
   WHERE id = '7c9c0000-0000-4000-8000-0000000000b1'::uuid;
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'FAIL 1: naming a credential twice made % rows', v_n;
  END IF;
  RAISE NOTICE 'PASS 1 — naming a credential is idempotent';

  -- ================================================================
  -- 2. THE ONE THAT MATTERS. Revocation is a state the gate can read.
  --
  -- A directory that greys out a row but leaves the credential working is
  -- not revocation. `app.operator_is_revoked` is what `authorize()` asks on
  -- every console request.
  -- ================================================================
  IF app.operator_is_revoked('7c9c0000-0000-4000-8000-0000000000b1'::uuid) THEN
    RAISE EXCEPTION 'FAIL 2: an active operator reads as revoked';
  END IF;

  PERFORM app.upsert_platform_operator(
    '7c9c0000-0000-4000-8000-0000000000a1'::uuid,
    '7c9c0000-0000-4000-8000-0000000000b1'::uuid, 'পরীক্ষা অপারেটর',
    NULL, NULL, 'revoked');

  IF NOT app.operator_is_revoked('7c9c0000-0000-4000-8000-0000000000b1'::uuid) THEN
    RAISE EXCEPTION 'FAIL 2: a revoked operator does not read as revoked';
  END IF;
  RAISE NOTICE 'PASS 2 — the gate can see a revocation';

  -- A credential nobody has named is NOT revoked. This table names
  -- credentials; it does not issue them, and treating unknown as revoked
  -- would have locked out whoever held the only one when it shipped.
  IF app.operator_is_revoked('7c9c0000-0000-4000-8000-00000000ffff'::uuid) THEN
    RAISE EXCEPTION 'FAIL 2b: an unnamed credential reads as revoked';
  END IF;
  RAISE NOTICE 'PASS 2b — an unnamed credential is not a revoked one';

  -- ================================================================
  -- 3. A revoked operator is KEPT, and can be restored.
  -- ================================================================
  SELECT count(*) INTO v_n FROM platform_operators
   WHERE id = '7c9c0000-0000-4000-8000-0000000000b1'::uuid;
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'FAIL 3: revoking deleted the row — old audit entries just lost their actor';
  END IF;

  PERFORM app.upsert_platform_operator(
    '7c9c0000-0000-4000-8000-0000000000a1'::uuid,
    '7c9c0000-0000-4000-8000-0000000000b1'::uuid, 'পরীক্ষা অপারেটর',
    NULL, NULL, 'active');
  SELECT status INTO v_status FROM platform_operators
   WHERE id = '7c9c0000-0000-4000-8000-0000000000b1'::uuid;
  IF v_status <> 'active' THEN
    RAISE EXCEPTION 'FAIL 3: an operator revoked by mistake cannot be restored';
  END IF;
  RAISE NOTICE 'PASS 3 — revoked rows are kept, and restorable';

  -- ================================================================
  -- 4. Nobody revokes themselves.
  --
  -- It would lock the console for the person holding it, mid-action.
  -- ================================================================
  BEGIN
    PERFORM app.upsert_platform_operator(
      '7c9c0000-0000-4000-8000-0000000000b1'::uuid,
      '7c9c0000-0000-4000-8000-0000000000b1'::uuid, 'পরীক্ষা অপারেটর',
      NULL, NULL, 'revoked');
    RAISE EXCEPTION 'FAIL 4: an operator revoked their own credential';
  EXCEPTION WHEN sqlstate '22023' THEN
    RAISE NOTICE 'PASS 4 — self-revocation is refused';
  END;

  -- ================================================================
  -- 5. The action count comes from the audit trail, not a counter.
  --
  -- The actor above has been WRITING audit rows all through this suite but
  -- was never itself named, so it does not appear in the directory at all —
  -- which is the whole point of the LEFT JOIN in `readAudit`. Name it, and
  -- its history is already there waiting.
  -- ================================================================
  PERFORM app.upsert_platform_operator(
    '7c9c0000-0000-4000-8000-0000000000b1'::uuid,
    '7c9c0000-0000-4000-8000-0000000000a1'::uuid, 'যিনি কাজগুলো করেছেন');

  SELECT actions INTO v_n FROM app.platform_operators()
   WHERE id = '7c9c0000-0000-4000-8000-0000000000a1'::uuid;
  IF COALESCE(v_n, 0) = 0 THEN
    RAISE EXCEPTION 'FAIL 5: the actor of every upsert above shows no actions';
  END IF;
  RAISE NOTICE 'PASS 5 — actions are counted from the audit trail (%)', v_n;

  -- ================================================================
  -- 6. The directory holds no secret.
  -- ================================================================
  SELECT count(*) INTO v_n
    FROM information_schema.columns
   WHERE table_name = 'platform_operators'
     AND column_name ~* 'password|hash|secret|token|key';
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'FAIL 6: the operator directory grew a credential column';
  END IF;
  RAISE NOTICE 'PASS 6 — the directory stores no credential material';
END $$;

-- Leave the fixture rows behind rather than deleting them: there is no DELETE
-- grant on this table, and that is the point. They are two fixed ids, so
-- re-running this suite rewrites them instead of accumulating.
RESET ROLE;

-- =====================================================================
-- 7. A school's role cannot see who operates the platform.
--
-- `shikhon_app` serves every tenant request. The list of people who can
-- suspend any school in the country is not something it should be able to
-- read, and this table is not protected by RLS — it is protected by not
-- being granted at all.
-- =====================================================================
SET ROLE shikhon_app;
DO $$
BEGIN
  BEGIN
    PERFORM * FROM platform_operators LIMIT 1;
    RAISE EXCEPTION 'FAIL 7: shikhon_app read the operator directory';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'PASS 7a — shikhon_app cannot read platform_operators';
  END;
  BEGIN
    PERFORM * FROM app.platform_operators();
    RAISE EXCEPTION 'FAIL 7: shikhon_app called app.platform_operators()';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'PASS 7b — shikhon_app cannot call the directory function';
  END;
  BEGIN
    PERFORM app.upsert_platform_operator(
      '7c9c0000-0000-4000-8000-0000000000a1'::uuid,
      '7c9c0000-0000-4000-8000-0000000000c1'::uuid, 'অনুপ্রবেশ');
    RAISE EXCEPTION 'FAIL 7: shikhon_app added an operator';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'PASS 7c — shikhon_app cannot add an operator';
  END;
END $$;
RESET ROLE;

\echo 'platform_operators.sql — all assertions passed'
