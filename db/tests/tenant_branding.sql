-- =====================================================================
-- db/tests/tenant_branding.sql   (R-1, docs/11-MASTER-PLAN.md)
--
-- White-labelling only means something if a school's identity is HERS.
-- This suite asserts that at the layer where it is actually enforced —
-- the tenant_self policy on `tenants` — rather than in the endpoint that
-- sits in front of it. The endpoint's requireRole() is a courtesy 403;
-- these are the guarantees.
--
--   A reads only A.          A writes only A.
--   B reads only B.          B cannot touch A even by naming A's id.
--   The pre-auth read returns seven fields and never the eighth.
--
-- The pre-auth function is the one place branding is readable without a
-- tenant context, so it gets the most attention: what it CANNOT return
-- matters more than what it can.
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/tests/tenant_branding.sql
-- =====================================================================

\set ON_ERROR_STOP on

GRANT shikhon_app TO CURRENT_USER;
SET ROLE shikhon_app;

\set A '''7bd00000-0000-4000-8000-00000000000a'''
\set B '''7bd00000-0000-4000-8000-00000000000b'''

-- ---------------------------------------------------------------------
-- Seed: two institutions with deliberately unalike identities.
-- ---------------------------------------------------------------------
BEGIN;
SET LOCAL app.tenant_id = '7bd00000-0000-4000-8000-00000000000a';
SET LOCAL app.role      = 'principal';
SET LOCAL app.user_id   = '7bd00000-0000-4000-8000-0000000000a1';

INSERT INTO tenants (id, slug, name_bn, name_en, stream, level, settings)
VALUES (:A, 'r1-brand-a', 'শাহজালাল আদর্শ উচ্চ বিদ্যালয়', 'Shahjalal High',
        'bangla_medium', 'secondary',
        jsonb_build_object('branding', jsonb_build_object(
          'nameBn', 'শাহজালাল আদর্শ উচ্চ বিদ্যালয়',
          'nameEn', 'Shahjalal Adarsha High School',
          'shortName', 'শাহজালাল',
          'primaryColor', '#156a3f',
          'accentColor', '#4e7a94',
          'address', 'জিন্দাবাজার, সিলেট ৩১০০',
          'phone', '+8801711000001',
          'email', 'office@shahjalal.example.edu.bd',
          'headmasterName', 'মোঃ আব্দুল কাদের')));
COMMIT;

BEGIN;
SET LOCAL app.tenant_id = '7bd00000-0000-4000-8000-00000000000b';
SET LOCAL app.role      = 'principal';
SET LOCAL app.user_id   = '7bd00000-0000-4000-8000-0000000000b1';

INSERT INTO tenants (id, slug, name_bn, name_en, stream, level, settings)
VALUES (:B, 'r1-brand-b', 'নর্থ সিটি মহিলা কলেজ', 'North City College',
        'bangla_medium', 'higher_secondary',
        jsonb_build_object('branding', jsonb_build_object(
          'nameBn', 'নর্থ সিটি মহিলা কলেজ',
          'shortName', 'নর্থ সিটি',
          'primaryColor', '#1b3e7a',
          'address', 'উত্তরা সেক্টর ৭, ঢাকা ১২৩০',
          'headmasterName', 'অধ্যাপক সালমা বেগম')));
COMMIT;

-- ---------------------------------------------------------------------
-- 1. A sees exactly one tenant row — its own.
-- ---------------------------------------------------------------------
BEGIN;
SET LOCAL app.tenant_id = '7bd00000-0000-4000-8000-00000000000a';
SET LOCAL app.role      = 'principal';

DO $$
DECLARE n integer; nm text;
BEGIN
  SELECT count(*) INTO n FROM tenants;
  IF n <> 1 THEN
    RAISE EXCEPTION 'FAIL: tenant A can see % tenant rows, expected exactly 1', n;
  END IF;

  SELECT settings->'branding'->>'nameBn' INTO nm FROM tenants;
  IF nm <> 'শাহজালাল আদর্শ উচ্চ বিদ্যালয়' THEN
    RAISE EXCEPTION 'FAIL: tenant A read the wrong branding: %', nm;
  END IF;
  RAISE NOTICE 'PASS A reads only A';
END $$;

-- 2. A cannot read B's branding by naming B's id.
DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM tenants WHERE id = '7bd00000-0000-4000-8000-00000000000b';
  IF n <> 0 THEN
    RAISE EXCEPTION 'FAIL: tenant A read tenant B by id — RLS is not confining SELECT';
  END IF;
  RAISE NOTICE 'PASS A cannot read B by id';
END $$;

-- 3. A cannot WRITE B's branding, even with an explicit WHERE on B.
--    This is the confused-deputy case the endpoint's shape avoids and the
--    policy forbids regardless.
DO $$
DECLARE affected integer;
BEGIN
  UPDATE tenants
     SET settings = settings || '{"branding":{"nameBn":"দখল করা নাম"}}'::jsonb
   WHERE id = '7bd00000-0000-4000-8000-00000000000b';
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected <> 0 THEN
    RAISE EXCEPTION 'FAIL: tenant A updated % row(s) of tenant B', affected;
  END IF;
  RAISE NOTICE 'PASS A cannot write B';
END $$;
COMMIT;

-- ---------------------------------------------------------------------
-- 4. B is intact, and reads only itself.
-- ---------------------------------------------------------------------
BEGIN;
SET LOCAL app.tenant_id = '7bd00000-0000-4000-8000-00000000000b';
SET LOCAL app.role      = 'principal';

DO $$
DECLARE b jsonb;
BEGIN
  SELECT settings->'branding' INTO b FROM tenants;
  IF b->>'nameBn' <> 'নর্থ সিটি মহিলা কলেজ' THEN
    RAISE EXCEPTION 'FAIL: tenant B branding was altered: %', b->>'nameBn';
  END IF;
  IF b->>'primaryColor' <> '#1b3e7a' THEN
    RAISE EXCEPTION 'FAIL: tenant B lost its colour: %', b->>'primaryColor';
  END IF;
  -- Nothing of A's may be reachable from B's session.
  IF b::text LIKE '%শাহজালাল%' OR b::text LIKE '%156a3f%' THEN
    RAISE EXCEPTION 'FAIL: tenant A identity leaked into tenant B';
  END IF;
  RAISE NOTICE 'PASS B reads only B, unaltered';
END $$;
COMMIT;

-- ---------------------------------------------------------------------
-- 5. No tenant context at all → no branding. Fail-closed.
-- ---------------------------------------------------------------------
BEGIN;
SET LOCAL app.role = 'anonymous';
DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM tenants;
  IF n <> 0 THEN
    RAISE EXCEPTION 'FAIL: a session with no tenant context saw % tenant row(s)', n;
  END IF;
  RAISE NOTICE 'PASS no context, no rows';
END $$;
COMMIT;

-- ---------------------------------------------------------------------
-- 6. app.public_branding() — the deliberate pre-auth hole.
--    It must answer WITHOUT a tenant context (that is its purpose) and
--    must not widen beyond the seven signboard fields (that is its bound).
-- ---------------------------------------------------------------------
BEGIN;
SET LOCAL app.role = 'anonymous';

DO $$
DECLARE r record; keys text[];
BEGIN
  SELECT * INTO r FROM app.public_branding('r1-brand-a');
  IF r.tenant_id IS NULL THEN
    RAISE EXCEPTION 'FAIL: public_branding returned nothing for a real slug';
  END IF;
  IF r.branding->>'nameBn' <> 'শাহজালাল আদর্শ উচ্চ বিদ্যালয়' THEN
    RAISE EXCEPTION 'FAIL: public_branding returned the wrong school';
  END IF;

  SELECT array_agg(k ORDER BY k) INTO keys FROM jsonb_object_keys(r.branding) AS k;

  -- The fixture set address, phone, email and headmasterName. None of them
  -- may cross this function, whose SQL fixes the returnable keys with an
  -- explicit allowlist. Asserting the ABSENCE is the whole point: a
  -- future field added to the branding object must stay private until
  -- someone deliberately widens the allowlist.
  IF keys && ARRAY['address','phone','email','headmasterName',
                   'watermarkUrl','signatureUrl'] THEN
    RAISE EXCEPTION
      'FAIL: public_branding leaked a private field to an unauthenticated caller: %', keys;
  END IF;

  -- And the signboard fields it DOES hold must have arrived.
  IF NOT (keys @> ARRAY['nameBn','shortName','primaryColor']) THEN
    RAISE EXCEPTION 'FAIL: public_branding dropped a signboard field: %', keys;
  END IF;
  RAISE NOTICE 'PASS public_branding exposes only signboard fields: %', keys;
END $$;

-- Keyed by id as well as slug — the install link carries the id.
DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n
    FROM app.public_branding('7bd00000-0000-4000-8000-00000000000a');
  IF n <> 1 THEN RAISE EXCEPTION 'FAIL: public_branding did not resolve by tenant id'; END IF;
  RAISE NOTICE 'PASS public_branding resolves by id';
END $$;

-- It cannot enumerate: no key, no row. And a junk key must not raise —
-- an error here would be both a broken login screen and an oracle.
DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM app.public_branding('no-such-school');
  IF n <> 0 THEN RAISE EXCEPTION 'FAIL: public_branding answered for an unknown key'; END IF;
  SELECT count(*) INTO n FROM app.public_branding('not-a-uuid-or-slug!!');
  IF n <> 0 THEN RAISE EXCEPTION 'FAIL: public_branding answered for a malformed key'; END IF;
  RAISE NOTICE 'PASS public_branding cannot enumerate';
END $$;
COMMIT;

-- ---------------------------------------------------------------------
-- 7. The shape guard: branding is an object or it is absent.
-- ---------------------------------------------------------------------
BEGIN;
SET LOCAL app.tenant_id = '7bd00000-0000-4000-8000-00000000000a';
SET LOCAL app.role      = 'principal';
DO $$
BEGIN
  BEGIN
    UPDATE tenants SET settings = '{"branding":"not an object"}'::jsonb
     WHERE id = '7bd00000-0000-4000-8000-00000000000a';
    RAISE EXCEPTION 'FAIL: a non-object branding was accepted';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'PASS branding must be an object';
  END;
END $$;
ROLLBACK;

-- ---------------------------------------------------------------------
-- Teardown. The suite must be re-runnable and leave nothing behind —
-- database.yml re-runs every suite and counts the rows that survive.
-- ---------------------------------------------------------------------
BEGIN;
SET LOCAL app.tenant_id = '7bd00000-0000-4000-8000-00000000000a';
SET LOCAL app.role      = 'principal';
DELETE FROM tenants WHERE id = '7bd00000-0000-4000-8000-00000000000a';
COMMIT;

BEGIN;
SET LOCAL app.tenant_id = '7bd00000-0000-4000-8000-00000000000b';
SET LOCAL app.role      = 'principal';
DELETE FROM tenants WHERE id = '7bd00000-0000-4000-8000-00000000000b';
COMMIT;

BEGIN;
SET LOCAL app.role = 'anonymous';
DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM app.public_branding('r1-brand-a');
  IF n <> 0 THEN RAISE EXCEPTION 'FAIL teardown: fixture tenant A survived'; END IF;
  SELECT count(*) INTO n FROM app.public_branding('r1-brand-b');
  IF n <> 0 THEN RAISE EXCEPTION 'FAIL teardown: fixture tenant B survived'; END IF;
  RAISE NOTICE 'PASS teardown — no fixture rows remain';
END $$;
COMMIT;

\echo ''
\echo '================================================'
\echo ' R-1 tenant branding isolation passed.'
\echo '================================================'
