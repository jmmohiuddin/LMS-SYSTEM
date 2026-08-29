-- =====================================================================
-- db/tests/web_push.sql   (R-9 — web push subscriptions, migration 047)
--
-- A push endpoint is unlike anything else this product stores. It is not data
-- ABOUT a person, it is a capability TO REACH one: whoever holds it can put a
-- notification on that phone's lock screen. So the questions this file asks
-- are narrower than the usual tenant-isolation set.
--
--   1. CAN ANOTHER SCHOOL SEE IT?  No. The ordinary boundary.
--
--   2. CAN MY OWN PRINCIPAL SEE IT?  Also no, and that is a deliberate
--      departure from every other table here. Management can see who received
--      a notice, who was absent, who paid. There is no question the office has
--      to answer that requires the address of a parent's phone.
--
--   3. WHAT HAPPENS WHEN TWO SCHOOLS SHARE A DEVICE?  A school office
--      computer, a family phone. The push service issues ONE endpoint per
--      browser, so without care both schools hold a row for it and each pushes
--      its notices to whoever is currently signed in. Migration 047's global
--      unique index plus `app.claim_push_subscription()` is the answer, and
--      §4 below is the test that it works.
--
--   4. CAN THE CLAIM FUNCTION BE TURNED INTO A CROSS-TENANT WRITE?  It is
--      SECURITY DEFINER, so RLS is not protecting it. §5 checks that it takes
--      its tenant and user from the session and cannot be redirected.
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/tests/web_push.sql
-- =====================================================================

\set ON_ERROR_STOP on

GRANT shikhon_app TO CURRENT_USER;

\set A    '''9c900000-0000-4000-8000-00000000000a'''
\set B    '''9c900000-0000-4000-8000-00000000000b'''
\set AHEAD '''9c900000-0000-4000-8000-0000000000a1'''
\set AMUM  '''9c900000-0000-4000-8000-0000000000a2'''
\set BMUM  '''9c900000-0000-4000-8000-0000000000b1'''

-- Pre-clean, per tenant: a single DELETE spanning both would only remove the
-- one whose context it runs in. (R-8 learned this the hard way; the platform
-- role is used here instead, which sees both.)
DELETE FROM push_subscriptions WHERE tenant_id IN (:A, :B);
DELETE FROM tenants WHERE id IN (:A, :B);

INSERT INTO tenants (id, slug, name_bn, name_en, stream, level) VALUES
  (:A, 'r9-alpha', 'আলফা', 'Alpha', 'bangla_medium', 'secondary'),
  (:B, 'r9-beta',  'বিটা',  'Beta',  'bangla_medium', 'secondary');

INSERT INTO users (id, tenant_id, full_name_bn, full_name_en, phone_e164, status) VALUES
  (:AHEAD, :A, 'প্রধান শিক্ষক', 'Head',        '+8801799700001', 'active'),
  (:AMUM,  :A, 'আলফার অভিভাবক', 'Alpha Parent','+8801799700002', 'active'),
  (:BMUM,  :B, 'বিটার অভিভাবক', 'Beta Parent', '+8801799700003', 'active');

INSERT INTO user_roles (tenant_id, user_id, role_code) VALUES
  (:A, :AHEAD, 'principal'),
  (:A, :AMUM,  'guardian'),
  (:B, :BMUM,  'guardian');

-- =====================================================================
-- 1. A PERSON REGISTERS THEIR OWN DEVICE, AND SEES ONLY THEIR OWN.
-- =====================================================================
BEGIN;
SET LOCAL app.tenant_id = '9c900000-0000-4000-8000-00000000000a';
SET LOCAL app.user_id   = '9c900000-0000-4000-8000-0000000000a2';
SET LOCAL app.role      = 'guardian';
SET ROLE shikhon_app;

DO $$
DECLARE v_id uuid; n integer;
BEGIN
  v_id := app.claim_push_subscription(
    'https://fcm.googleapis.com/fcm/send/alpha-parent-phone',
    repeat('A', 87), repeat('B', 22), 'মোবাইল');
  IF v_id IS NULL THEN RAISE EXCEPTION 'FAIL: claim returned no id'; END IF;

  SELECT count(*) INTO n FROM push_subscriptions;
  IF n <> 1 THEN RAISE EXCEPTION 'FAIL: the owner sees % of their own rows, expected 1', n; END IF;
  RAISE NOTICE 'PASS a person registers their own device and can see it';
END $$;
RESET ROLE;
COMMIT;

-- =====================================================================
-- 2. THE PRINCIPAL OF THE SAME SCHOOL CANNOT SEE IT.
--
--    Deliberate, and the one place this product withholds something from
--    management. An endpoint is a capability to reach a parent's phone, and
--    no question the office answers needs it.
-- =====================================================================
BEGIN;
SET LOCAL app.tenant_id = '9c900000-0000-4000-8000-00000000000a';
SET LOCAL app.user_id   = '9c900000-0000-4000-8000-0000000000a1';
SET LOCAL app.role      = 'principal';
SET ROLE shikhon_app;

DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM push_subscriptions;
  IF n <> 0 THEN
    RAISE EXCEPTION 'FAIL: the principal can see % push subscription(s) belonging to a parent', n;
  END IF;

  -- Nor can they delete what they cannot see.
  DELETE FROM push_subscriptions WHERE true;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 0 THEN RAISE EXCEPTION 'FAIL: the principal deleted % parent subscription(s)', n; END IF;

  RAISE NOTICE 'PASS even the principal cannot read or delete a parent''s device';
END $$;
RESET ROLE;
COMMIT;

-- =====================================================================
-- 3. THE OTHER SCHOOL: READ, WRITE, UPDATE, DELETE — ALL REFUSED.
-- =====================================================================
BEGIN;
SET LOCAL app.tenant_id = '9c900000-0000-4000-8000-00000000000b';
SET LOCAL app.user_id   = '9c900000-0000-4000-8000-0000000000b1';
SET LOCAL app.role      = 'guardian';
SET ROLE shikhon_app;

DO $$
DECLARE n integer;
BEGIN
  -- READ
  SELECT count(*) INTO n FROM push_subscriptions;
  IF n <> 0 THEN RAISE EXCEPTION 'FAIL: beta reads % of alpha''s subscriptions', n; END IF;

  -- UPDATE
  UPDATE push_subscriptions SET device_label = 'stolen';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 0 THEN RAISE EXCEPTION 'FAIL: beta updated % of alpha''s rows', n; END IF;

  -- DELETE
  DELETE FROM push_subscriptions;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 0 THEN RAISE EXCEPTION 'FAIL: beta deleted % of alpha''s rows', n; END IF;

  -- WRITE into the other tenant, naming it explicitly.
  BEGIN
    INSERT INTO push_subscriptions (tenant_id, user_id, endpoint, p256dh, auth)
    VALUES ('9c900000-0000-4000-8000-00000000000a',
            '9c900000-0000-4000-8000-0000000000a2',
            'https://fcm.googleapis.com/fcm/send/forged', repeat('A', 87), repeat('B', 22));
    RAISE EXCEPTION 'FAIL: beta inserted a row into alpha';
  EXCEPTION WHEN insufficient_privilege OR check_violation THEN
    NULL;  -- expected: tenant_guard / enforce_tenant
  END;

  -- WRITE inside their OWN tenant but for somebody else's user id.
  BEGIN
    INSERT INTO push_subscriptions (tenant_id, user_id, endpoint, p256dh, auth)
    VALUES ('9c900000-0000-4000-8000-00000000000b',
            '9c900000-0000-4000-8000-0000000000a2',
            'https://fcm.googleapis.com/fcm/send/forged2', repeat('A', 87), repeat('B', 22));
    RAISE EXCEPTION 'FAIL: a guardian registered a device for another person';
  EXCEPTION WHEN insufficient_privilege OR foreign_key_violation THEN
    NULL;  -- expected: push_insert_scope
  END;

  RAISE NOTICE 'PASS the other school cannot read, update, delete or write';
END $$;
RESET ROLE;
COMMIT;

-- =====================================================================
-- 4. THE SHARED DEVICE.
--
--    The scenario migration 047's global unique index exists for: one
--    browser, two schools. Beta's parent signs in on the same office computer
--    alpha's parent used. The endpoint is the same because the push service
--    issues one per browser.
--
--    Correct outcome: beta now owns it, ALPHA'S ROW IS GONE, and alpha's
--    school stops pushing to a device it no longer reaches.
-- =====================================================================
BEGIN;
SET LOCAL app.tenant_id = '9c900000-0000-4000-8000-00000000000b';
SET LOCAL app.user_id   = '9c900000-0000-4000-8000-0000000000b1';
SET LOCAL app.role      = 'guardian';
SET ROLE shikhon_app;

DO $$
DECLARE n integer;
BEGIN
  PERFORM app.claim_push_subscription(
    'https://fcm.googleapis.com/fcm/send/alpha-parent-phone',
    repeat('C', 87), repeat('D', 22), 'অফিসের কম্পিউটার');

  SELECT count(*) INTO n FROM push_subscriptions;
  IF n <> 1 THEN RAISE EXCEPTION 'FAIL: beta holds % rows for the shared device', n; END IF;
  RAISE NOTICE 'PASS the new signer-in owns the shared device';
END $$;
RESET ROLE;
COMMIT;

-- Alpha's row is gone — checked from OUTSIDE any tenant context, because
-- checking it from inside alpha is exactly what RLS would hide.
DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM push_subscriptions
   WHERE endpoint = 'https://fcm.googleapis.com/fcm/send/alpha-parent-phone';
  IF n <> 1 THEN
    RAISE EXCEPTION 'FAIL: % rows exist for one browser — two schools would both push to it', n;
  END IF;

  SELECT count(*) INTO n FROM push_subscriptions
   WHERE tenant_id = '9c900000-0000-4000-8000-00000000000a';
  IF n <> 0 THEN
    RAISE EXCEPTION 'FAIL: alpha still holds a row for a device beta now owns — '
                    'alpha''s notices would land on beta''s parent''s lock screen';
  END IF;
  RAISE NOTICE 'PASS one browser, one row — the previous school''s row is gone';
END $$;

-- =====================================================================
-- 5. THE DEFINER FUNCTION CANNOT BE REDIRECTED.
--
--    It is SECURITY DEFINER, so RLS is not the thing protecting it. It takes
--    no tenant and no user argument at all, and it re-checks membership —
--    because a session variable is the only thing it has to go on.
-- =====================================================================
DO $$
DECLARE n integer; sig text;
BEGIN
  -- There is literally no argument to redirect it with. Asserted structurally:
  -- if a future edit adds a tenant or user parameter, this fails.
  SELECT pg_get_function_arguments(p.oid) INTO sig
    FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'app' AND p.proname = 'claim_push_subscription';
  IF sig ~* '(tenant|user)' THEN
    RAISE EXCEPTION 'FAIL: claim_push_subscription takes a caller-supplied identity: %', sig;
  END IF;
  RAISE NOTICE 'PASS the claim function takes no identity from its caller (%)', sig;
END $$;

-- With no session identity it refuses outright.
BEGIN;
SET LOCAL app.tenant_id = '';
SET LOCAL app.user_id   = '';
SET LOCAL app.role      = 'guardian';
SET ROLE shikhon_app;
DO $$
BEGIN
  BEGIN
    PERFORM app.claim_push_subscription('https://fcm.googleapis.com/fcm/send/x',
      repeat('A', 87), repeat('B', 22), NULL);
    RAISE EXCEPTION 'FAIL: a subscription was claimed with no session';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'PASS no session, no subscription';
  END;
END $$;
RESET ROLE;
COMMIT;

-- A session naming a user who does not belong to the named tenant is refused,
-- even though DEFINER means RLS would not have stopped it.
BEGIN;
SET LOCAL app.tenant_id = '9c900000-0000-4000-8000-00000000000b';
SET LOCAL app.user_id   = '9c900000-0000-4000-8000-0000000000a2';  -- alpha's parent
SET LOCAL app.role      = 'guardian';
SET ROLE shikhon_app;
DO $$
BEGIN
  BEGIN
    PERFORM app.claim_push_subscription('https://fcm.googleapis.com/fcm/send/mismatch',
      repeat('A', 87), repeat('B', 22), NULL);
    RAISE EXCEPTION 'FAIL: a user from one school registered a device inside another';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'PASS the DEFINER function re-checks that the user is in the tenant';
  END;
END $$;
RESET ROLE;
COMMIT;

-- =====================================================================
-- 6. THE SENDER CAN READ AND PRUNE; IT STILL CANNOT CROSS A TENANT.
-- =====================================================================
BEGIN;
SET LOCAL app.tenant_id = '9c900000-0000-4000-8000-00000000000b';
SET LOCAL app.user_id   = '';
SET LOCAL app.role      = 'system_ingest';
SET ROLE shikhon_app;

DO $$
DECLARE n integer;
BEGIN
  -- It must see beta's device: this is the query the dispatcher runs.
  SELECT count(*) INTO n FROM push_subscriptions;
  IF n <> 1 THEN RAISE EXCEPTION 'FAIL: the sender sees % devices, expected 1', n; END IF;

  -- And stamp delivery health.
  UPDATE push_subscriptions SET last_success_at = now();
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN RAISE EXCEPTION 'FAIL: the sender could not record a delivery'; END IF;

  RAISE NOTICE 'PASS the sender reads devices and records what happened';
END $$;
RESET ROLE;
COMMIT;

-- Beta's sender, pointed at alpha, sees nothing: system_ingest widens the
-- ROLE scope, never the tenant one.
BEGIN;
SET LOCAL app.tenant_id = '9c900000-0000-4000-8000-00000000000a';
SET LOCAL app.user_id   = '';
SET LOCAL app.role      = 'system_ingest';
SET ROLE shikhon_app;
DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM push_subscriptions;
  IF n <> 0 THEN
    RAISE EXCEPTION 'FAIL: a sender in alpha sees % of beta''s devices', n;
  END IF;
  RAISE NOTICE 'PASS system_ingest widens the role scope, never the tenant one';
END $$;
RESET ROLE;
COMMIT;

-- =====================================================================
-- 7. THE COLUMN CONSTRAINTS REFUSE A SUBSCRIPTION THAT COULD NEVER WORK.
-- =====================================================================
BEGIN;
SET LOCAL app.tenant_id = '9c900000-0000-4000-8000-00000000000b';
SET LOCAL app.user_id   = '9c900000-0000-4000-8000-0000000000b1';
SET LOCAL app.role      = 'guardian';
SET ROLE shikhon_app;

DO $$
BEGIN
  BEGIN
    INSERT INTO push_subscriptions (tenant_id, user_id, endpoint, p256dh, auth)
    VALUES ('9c900000-0000-4000-8000-00000000000b',
            '9c900000-0000-4000-8000-0000000000b1', 'x', repeat('A', 87), repeat('B', 22));
    RAISE EXCEPTION 'FAIL: a one-character endpoint was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  BEGIN
    INSERT INTO push_subscriptions (tenant_id, user_id, endpoint, p256dh, auth)
    VALUES ('9c900000-0000-4000-8000-00000000000b',
            '9c900000-0000-4000-8000-0000000000b1',
            'https://fcm.googleapis.com/fcm/send/short-keys', 'AA', 'BB');
    RAISE EXCEPTION 'FAIL: keys too short to be a P-256 point were accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  RAISE NOTICE 'PASS a subscription that could never be encrypted for is refused';
END $$;
RESET ROLE;
COMMIT;

-- ---------------------------------------------------------------------
-- Teardown — re-runnable, leaving nothing.
-- ---------------------------------------------------------------------
DELETE FROM push_subscriptions WHERE tenant_id IN (:A, :B);
DELETE FROM user_roles WHERE tenant_id IN (:A, :B);
DELETE FROM users   WHERE tenant_id IN (:A, :B);
DELETE FROM tenants WHERE id IN (:A, :B);

DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM tenants WHERE slug IN ('r9-alpha', 'r9-beta');
  IF n <> 0 THEN RAISE EXCEPTION 'FAIL: teardown left % tenant row(s)', n; END IF;
  RAISE NOTICE 'PASS teardown — no fixture rows remain';
END $$;

SELECT 'R-9: a push endpoint reaches one person, and only the person it belongs to.' AS result;
