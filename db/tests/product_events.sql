-- =====================================================================
-- db/tests/product_events.sql   (F-1503, TRD §13)
--
-- The two properties that make first-party analytics safe to run in a
-- school full of minors:
--
--   PII cannot land — refused at insert, by construction, not scrubbed.
--   Nothing can be edited — an analytics row that can be updated is a
--   metric that can be negotiated.
--
-- Plus the rollup, which must cross tenants as the OWNER — the reason
-- these two tables are ENABLE-only rather than FORCE.
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/tests/product_events.sql
-- =====================================================================

\set ON_ERROR_STOP on

GRANT shikhon_app TO CURRENT_USER;
SET ROLE shikhon_app;

\set T '''7ab00000-0000-4000-8000-00000000000a'''

BEGIN;
SET LOCAL app.tenant_id = '7ab00000-0000-4000-8000-00000000000a';
SET LOCAL app.role      = 'student';
SET LOCAL app.user_id   = '7ab00000-0000-4000-8000-0000000000a1';

-- Students may not create tenants/users; seed as principal first.
SET LOCAL app.role = 'principal';
INSERT INTO tenants (id, slug, name_bn, name_en, stream, level)
VALUES (:T, 'events', 'ইভেন্ট বিদ্যালয়', 'Events School', 'bangla_medium', 'secondary');
INSERT INTO users (id, tenant_id, full_name_bn, full_name_en, phone_e164, status) VALUES
  ('7ab00000-0000-4000-8000-0000000000a1', :T, 'ছাত্র', 'Student', '+8801799400001', 'active'),
  ('7ab00000-0000-4000-8000-0000000000ff', :T, 'অধ্যক্ষ', 'Head',   '+8801799400002', 'active');
SET LOCAL app.role = 'student';

-- ---------------------------------------------------------------------
-- 1. A student records what they did. Clean payload, accepted.
-- ---------------------------------------------------------------------
DO $$
BEGIN
  INSERT INTO product_events (id, tenant_id, event_type, actor_role, user_id, occurred_at, payload)
  VALUES ('7ab00000-0000-4000-8000-00000000e001', app.current_tenant(),
          'engagement.chapter_opened', 'student',
          '7ab00000-0000-4000-8000-0000000000a1', now() - interval '2 hours',
          '{"chapterId":"c1","seq":3}');
  RAISE NOTICE 'PASS 1 — a clean event is accepted from a student';
END $$;

-- ---------------------------------------------------------------------
-- 2. THE ONE THAT MATTERS. PII is refused at ANY depth — a name under a
--    nested key, a phone number under an innocent key, an
--    identifier-shaped number. Refused, never cleaned: a scrubber that
--    repairs events teaches callers to keep sending PII.
-- ---------------------------------------------------------------------
DO $$
DECLARE bad jsonb;
BEGIN
  FOR bad IN
    SELECT * FROM (VALUES
      ('{"meta":{"studentName":"আনিকা"}}'::jsonb),
      ('{"msg":"call +8801712345678"}'::jsonb),
      ('{"note":"brn 1999887766554"}'::jsonb),
      ('{"list":[{"guardianPhone":"x"}]}'::jsonb)
    ) v(j)
  LOOP
    BEGIN
      INSERT INTO product_events (id, tenant_id, event_type, occurred_at, payload)
      VALUES (gen_random_uuid(), app.current_tenant(), 'error.client', now(), bad);
      RAISE EXCEPTION 'FAIL 2: payload % was accepted', bad;
    EXCEPTION WHEN check_violation THEN
      NULL;
    END;
  END LOOP;
  RAISE NOTICE 'PASS 2 — PII is refused at every depth, by construction';
END $$;

-- ---------------------------------------------------------------------
-- 3. An event outside the TRD §13.1 taxonomy is refused. A domain nobody
--    agreed to is a metric nobody will read.
-- ---------------------------------------------------------------------
DO $$
BEGIN
  BEGIN
    INSERT INTO product_events (id, tenant_id, event_type, occurred_at)
    VALUES (gen_random_uuid(), app.current_tenant(), 'marketing.campaign_click', now());
    RAISE EXCEPTION 'FAIL 3: an unknown event domain was accepted';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;
  RAISE NOTICE 'PASS 3 — only the eight agreed domains exist';
END $$;

-- ---------------------------------------------------------------------
-- 4. Insert-only, for EVERYONE including the principal. A metric that can
--    be edited is a metric that can be negotiated.
-- ---------------------------------------------------------------------
DO $$
DECLARE n integer;
BEGIN
  SET LOCAL app.role = 'principal';
  UPDATE product_events SET event_type = 'engagement.topic_completed'
   WHERE id = '7ab00000-0000-4000-8000-00000000e001';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 0 THEN RAISE EXCEPTION 'FAIL 4: an event row was updated'; END IF;

  DELETE FROM product_events WHERE id = '7ab00000-0000-4000-8000-00000000e001';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 0 THEN RAISE EXCEPTION 'FAIL 4: an event row was deleted'; END IF;
  SET LOCAL app.role = 'student';
  RAISE NOTICE 'PASS 4 — not even the principal can edit or delete an event';
END $$;

-- ---------------------------------------------------------------------
-- 5. A student writes events but cannot READ the analytics; leadership
--    can. Recording what you did is not the same as browsing what
--    everyone did.
-- ---------------------------------------------------------------------
DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM product_events;
  IF n <> 0 THEN RAISE EXCEPTION 'FAIL 5: a student can read % event(s)', n; END IF;

  SET LOCAL app.role = 'principal';
  SELECT count(*) INTO n FROM product_events;
  IF n < 1 THEN RAISE EXCEPTION 'FAIL 5: the principal sees nothing'; END IF;
  SET LOCAL app.role = 'student';
  RAISE NOTICE 'PASS 5 — writers cannot read; leadership can';
END $$;

-- ---------------------------------------------------------------------
-- 6. The rollup. Runs as the OWNER (the maintenance cron's credential),
--    crosses tenants, lands late offline events in the day they OCCURRED,
--    and prunes raw rows past 90 days — the reason these tables are
--    ENABLE-only: under FORCE the owner would aggregate zero rows and
--    report success, in production, forever.
-- ---------------------------------------------------------------------
DO $$
BEGIN
  -- An event that happened two days ago but only arrived now (offline),
  -- and one so old the rollup should prune it.
  INSERT INTO product_events (id, tenant_id, event_type, user_id, occurred_at, payload) VALUES
    (gen_random_uuid(), app.current_tenant(), 'engagement.practice_attempted',
     '7ab00000-0000-4000-8000-0000000000a1', now() - interval '2 days', '{}'),
    (gen_random_uuid(), app.current_tenant(), 'engagement.practice_attempted',
     '7ab00000-0000-4000-8000-0000000000a1', now() - interval '120 days', '{}');
END $$;

RESET ROLE;

-- The rollup runs as the MAINTENANCE CRON does: as the owner, with NO tenant
-- in context. That is not a detail — `app.enforce_tenant` permits a
-- cross-tenant insert only when `app.current_tenant()` is NULL and the caller
-- is a member of `shikhon_platform`, which is exactly the cron's position.
--
-- The suite used to arrive here with `app.tenant_id` still set from the fixture
-- block above, and passed anyway: with only ONE tenant's events in the window
-- every rollup row matched the set tenant, so the cross-tenant path this test
-- claims to cover was never taken. It surfaced the moment a second tenant had
-- events in the last seven days — the real state of any database that has been
-- used — and failed with 'cross-tenant insert blocked'.
--
-- Cleared explicitly, so the test exercises the production path rather than a
-- single-tenant shadow of it.
SELECT set_config('app.tenant_id', '', false);
SELECT set_config('app.user_id', '', false);
SELECT set_config('app.role', '', false);

DO $$
DECLARE r record; v_n integer;
BEGIN
  SELECT * INTO r FROM app.rollup_product_events();
  IF r.days_recomputed < 2 THEN
    RAISE EXCEPTION 'FAIL 6: rollup recomputed % day-rows, expected >= 2 — '
                    'if this is 0 the owner is being blocked by RLS', r.days_recomputed;
  END IF;
  IF r.raw_pruned < 1 THEN
    RAISE EXCEPTION 'FAIL 6: the 120-day-old raw event was not pruned';
  END IF;

  SELECT per.n INTO STRICT v_n FROM product_event_rollups per
   WHERE per.tenant_id = '7ab00000-0000-4000-8000-00000000000a'
     AND per.event_type = 'engagement.practice_attempted'
     AND per.day = (now() - interval '2 days')::date;
  IF v_n <> 1 THEN RAISE EXCEPTION 'FAIL 6: the late event landed in the wrong day'; END IF;
  RAISE NOTICE 'PASS 6 — the rollup crosses tenants, files late events by occurrence, and prunes';
END $$;

SET ROLE shikhon_app;

ROLLBACK;

RESET ROLE;

DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM tenants WHERE id = '7ab00000-0000-4000-8000-00000000000a';
  IF n <> 0 THEN RAISE EXCEPTION 'FAIL teardown: the fixture tenant survived'; END IF;
  RAISE NOTICE 'PASS teardown — no fixture rows remain';
END $$;

\echo ''
\echo '================================================'
\echo ' F-1503 product events passed.'
\echo '================================================'
