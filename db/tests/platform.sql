-- =====================================================================
-- db/tests/platform.sql   (R-7 — tenant onboarding & the platform console)
--
-- R-7 is the phase that adds the ability to create a school. Everything
-- worth asserting here is about what that ability must NOT become.
--
-- The product's entire isolation story rests on one fact: the runtime role
-- `shikhon_app` is confined by `tenant_self` to the single tenant it is
-- already inside, so it cannot create a school and cannot list one. R-7 adds
-- SECURITY DEFINER functions that CAN do both — and the whole point of this
-- file is that they are granted to `shikhon_platform` and to nobody else.
--
-- Five things it holds:
--
--   1. THE RUNTIME ROLE STILL CANNOT. Not create, not enumerate, not
--      suspend. A school compromised end to end reaches no other school.
--
--   2. THE PLATFORM ROLE IS NOT ABOVE RLS. Migration 045 takes BYPASSRLS
--      off it deliberately, so a bug in the wizard cannot write into the
--      wrong school. Asserted directly, because it is one ALTER ROLE away
--      from being silently undone.
--
--   3. AUDIT CANNOT BE FORGED. The platform role may READ its own trail and
--      may not INSERT into it: entries come only from the DEFINER functions,
--      which stamp the actor from an argument rather than the session.
--
--   4. student_cap IS REAL. It was declared in migration 001 and enforced
--      NOWHERE until R-7. The refusal states both numbers.
--
--   5. A PROVISIONED SCHOOL CAN ACTUALLY TAKE STUDENTS. `provision_tenant`
--      seeded everything except the subject templates the student import
--      requires, so a freshly onboarded school rejected every row of its
--      first import. `provision_curriculum` closes that, and this asserts
--      the two together.
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/tests/platform.sql
-- =====================================================================

\set ON_ERROR_STOP on

GRANT shikhon_app TO CURRENT_USER;

\set T '''7c800000-0000-4000-8000-00000000000a'''
\set OP '''7c800000-0000-4000-8000-0000000000aa'''

-- Pre-clean. Money rows are ON DELETE RESTRICT by design, so they go first.
DELETE FROM payment_receipts WHERE tenant_id = :T;
DELETE FROM ledger_entries   WHERE tenant_id = :T;
DELETE FROM mfs_transactions WHERE tenant_id = :T;
DELETE FROM tenants WHERE id = :T OR slug IN ('r7-db-alpha', 'r7-db-beta');

-- =====================================================================
-- 1. THE RUNTIME ROLE CANNOT CREATE, LIST OR SUSPEND A SCHOOL.
--
--    This is the property the whole product rests on. If any of these
--    three starts succeeding, tenant isolation is over.
-- =====================================================================
SET ROLE shikhon_app;
DO $$
BEGIN
  BEGIN
    PERFORM app.create_tenant('7c800000-0000-4000-8000-0000000000aa'::uuid,
      'r7-db-evil', 'ইভিল', 'Evil', 'bangla_medium', 'secondary');
    RAISE EXCEPTION 'FAIL: the runtime role created a tenant';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'PASS shikhon_app cannot create a tenant';
  END;

  BEGIN
    PERFORM * FROM app.platform_tenants(NULL);
    RAISE EXCEPTION 'FAIL: the runtime role enumerated tenants';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'PASS shikhon_app cannot enumerate tenants';
  END;

  BEGIN
    PERFORM app.set_tenant_status('7c800000-0000-4000-8000-0000000000aa'::uuid,
      '7c800000-0000-4000-8000-00000000000a'::uuid, 'suspended');
    RAISE EXCEPTION 'FAIL: the runtime role suspended a tenant';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'PASS shikhon_app cannot change a tenant''s status';
  END;

  BEGIN
    PERFORM app.log_platform_action('7c800000-0000-4000-8000-0000000000aa'::uuid,
      NULL, 'forged', 'forged');
    RAISE EXCEPTION 'FAIL: the runtime role wrote a platform audit row';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'PASS shikhon_app cannot write the platform audit trail';
  END;
END $$;
RESET ROLE;

-- =====================================================================
-- 2. THE PLATFORM ROLE IS NOT ABOVE RLS.
--
--    Migration 001 gave `shikhon_platform` BYPASSRLS back when nothing
--    could use it. 045 takes it off, so the one service that touches every
--    school still lives under the same policies as everybody else — and
--    `assertRlsEnforced` in packages/server-core refuses to start
--    otherwise. One ALTER ROLE would undo it silently.
-- =====================================================================
DO $$
DECLARE v_bypass boolean; v_login boolean;
BEGIN
  SELECT rolbypassrls, rolcanlogin INTO v_bypass, v_login
    FROM pg_roles WHERE rolname = 'shikhon_platform';
  IF v_bypass THEN
    RAISE EXCEPTION 'FAIL: shikhon_platform has BYPASSRLS — the platform service '
                    'would run with row-level security disabled';
  END IF;
  IF NOT v_login THEN
    RAISE EXCEPTION 'FAIL: shikhon_platform cannot log in, so platform-svc has no identity';
  END IF;
  RAISE NOTICE 'PASS the platform role can log in and is still bound by RLS';
END $$;

-- =====================================================================
-- 3. THE PLATFORM ROLE CREATES A SCHOOL, AND THE AUDIT ROW IS PART OF IT.
-- =====================================================================
SET ROLE shikhon_platform;
DO $$
DECLARE v_id uuid; v_audit integer;
BEGIN
  SELECT id INTO v_id FROM app.create_tenant(
    '7c800000-0000-4000-8000-0000000000aa'::uuid,
    'r7-db-alpha', 'আলফা', 'Alpha', 'bangla_medium', 'secondary',
    NULL, NULL, NULL, 'ঢাকা', NULL, NULL,
    ARRAY[5,6]::smallint[], ARRAY['single']::shift_code[],
    'Asia/Dhaka', 'bn', 'pilot', 2, NULL, 'trial', 'R-7 db test');

  IF v_id IS NULL THEN RAISE EXCEPTION 'FAIL: create_tenant returned nothing'; END IF;

  SELECT count(*) INTO v_audit FROM audit.platform_access
   WHERE tenant_id = v_id AND admin_id = '7c800000-0000-4000-8000-0000000000aa';
  IF v_audit <> 1 THEN
    RAISE EXCEPTION 'FAIL: % audit rows for a tenant creation, expected 1', v_audit;
  END IF;
  RAISE NOTICE 'PASS the platform role creates a school and the audit row lands with it';
END $$;

-- The audit trail is readable by the operator and NOT writable by them:
-- an audit log its own subject can write is not an audit log.
DO $$
BEGIN
  PERFORM count(*) FROM audit.platform_access;
  BEGIN
    INSERT INTO audit.platform_access (admin_id, tenant_id, reason)
    VALUES ('7c800000-0000-4000-8000-0000000000aa', NULL, 'forged');
    RAISE EXCEPTION 'FAIL: the platform role forged an audit row directly';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'PASS the platform role reads the audit trail and cannot write it directly';
  END;
END $$;
RESET ROLE;

-- =====================================================================
-- 4. A CREATED SCHOOL IS INVISIBLE TO EVERY OTHER SCHOOL.
-- =====================================================================
SET ROLE shikhon_platform;
DO $$
BEGIN
  PERFORM app.create_tenant(
    '7c800000-0000-4000-8000-0000000000aa'::uuid,
    'r7-db-beta', 'বিটা', 'Beta', 'madrasah', 'secondary',
    NULL, NULL, NULL, NULL, NULL, NULL,
    ARRAY[5]::smallint[], ARRAY['single']::shift_code[],
    'Asia/Dhaka', 'bn', 'pilot', 50, NULL, 'trial', 'R-7 db test');
END $$;
RESET ROLE;

SET ROLE shikhon_app;
DO $$
DECLARE a uuid; b uuid; n integer;
BEGIN
  RESET ROLE;
  SELECT id INTO a FROM tenants WHERE slug = 'r7-db-alpha';
  SELECT id INTO b FROM tenants WHERE slug = 'r7-db-beta';
  SET ROLE shikhon_app;
  PERFORM set_config('app.tenant_id', a::text, true);
  PERFORM set_config('app.role', 'principal', true);

  SELECT count(*) INTO n FROM tenants;
  IF n <> 1 THEN RAISE EXCEPTION 'FAIL: inside Alpha, % tenants are visible', n; END IF;

  SELECT count(*) INTO n FROM tenants WHERE id = b;
  IF n <> 0 THEN RAISE EXCEPTION 'FAIL: Alpha can see Beta by naming its id'; END IF;
  RAISE NOTICE 'PASS a school sees itself and no other, even by id';
END $$;
RESET ROLE;

-- =====================================================================
-- 5. A PROVISIONED SCHOOL CAN ACTUALLY ACCEPT STUDENTS.
--
--    provision_tenant seeds the year, terms, grading bands, classes and
--    class_subjects. It does NOT seed `subject_templates`, which
--    app.derive_student_subjects requires — so before R-7 a freshly
--    onboarded school rejected every row of its first student import with
--    "বিষয় তালিকা (টেমপ্লেট) তৈরি হয়নি". Both halves are asserted.
-- =====================================================================
BEGIN;
SET LOCAL app.tenant_id = '7c800000-0000-4000-8000-00000000000a';
SET LOCAL app.role = 'principal';
SET LOCAL app.user_id = '7c800000-0000-4000-8000-0000000000aa';
ROLLBACK;

DO $$
DECLARE a uuid;
BEGIN
  SELECT id INTO a FROM tenants WHERE slug = 'r7-db-alpha';
  EXECUTE format('SET app.tenant_id = %L', a);
  PERFORM set_config('app.role', 'principal', false);
END $$;

SET ROLE shikhon_app;
DO $$
DECLARE a uuid; v_bands integer; v_templates integer; v_items integer;
BEGIN
  a := current_setting('app.tenant_id')::uuid;

  PERFORM app.provision_tenant(a, '2027', '2027-01-01'::date, '2027-12-31'::date,
                               6::smallint, 8::smallint);

  SELECT count(*) INTO v_bands FROM grading_bands;
  IF v_bands = 0 THEN
    RAISE EXCEPTION 'FAIL: no grading bands — the first result publication would fail silently';
  END IF;

  -- Before provision_curriculum there is no template, which is exactly the
  -- gap R-7 found. Recorded so nobody removes the call as redundant.
  SELECT count(*) INTO v_templates FROM subject_templates;
  IF v_templates <> 0 THEN
    RAISE NOTICE 'NOTE provision_tenant now seeds subject templates itself — '
                 'app.provision_curriculum may have become redundant';
  ELSE
    RAISE NOTICE 'PASS provision_tenant alone leaves no subject template — the gap is real';
  END IF;

  PERFORM app.provision_curriculum(a, NULL);

  SELECT count(*) INTO v_templates FROM subject_templates;
  SELECT count(*) INTO v_items FROM subject_template_items;
  IF v_templates = 0 OR v_items = 0 THEN
    RAISE EXCEPTION 'FAIL: provision_curriculum seeded % templates and % items',
      v_templates, v_items;
  END IF;
  RAISE NOTICE 'PASS a provisioned school has grading bands AND subject templates';
END $$;

-- Idempotent, like provision_tenant: a retry after a failure is always safe.
DO $$
DECLARE a uuid; before_t integer; after_t integer;
BEGIN
  a := current_setting('app.tenant_id')::uuid;
  SELECT count(*) INTO before_t FROM subject_templates;
  PERFORM app.provision_curriculum(a, NULL);
  PERFORM app.provision_tenant(a, '2027', '2027-01-01'::date, '2027-12-31'::date,
                               6::smallint, 8::smallint);
  SELECT count(*) INTO after_t FROM subject_templates;
  IF after_t <> before_t THEN
    RAISE EXCEPTION 'FAIL: re-running provisioning changed templates from % to %',
      before_t, after_t;
  END IF;
  RAISE NOTICE 'PASS provisioning is idempotent — a retry is always safe';
END $$;

-- =====================================================================
-- 6. student_cap IS ENFORCED, AND SAYS BOTH NUMBERS.
--
--    Declared in migration 001, enforced nowhere until R-7. Alpha's cap is
--    2, so the third enrolment must be refused.
-- =====================================================================
DO $$
DECLARE a uuid; v_year uuid; v_sec uuid; i integer; v_u uuid; msg text;
BEGIN
  a := current_setting('app.tenant_id')::uuid;
  SELECT id INTO v_year FROM academic_years WHERE is_current LIMIT 1;

  INSERT INTO sections (tenant_id, class_id, academic_year_id, name, shift)
  SELECT a, c.id, v_year, 'ক', 'single' FROM classes c LIMIT 1
  ON CONFLICT DO NOTHING;
  SELECT id INTO v_sec FROM sections LIMIT 1;

  FOR i IN 1..2 LOOP
    INSERT INTO users (tenant_id, full_name_bn, full_name_en, phone_e164, status)
    VALUES (a, 'ছাত্র ' || i, 'Student ' || i, '+880179992000' || i, 'active')
    RETURNING id INTO v_u;
    INSERT INTO enrolments (tenant_id, student_id, section_id, academic_year_id, roll_no, status)
    VALUES (a, v_u, v_sec, v_year, i, 'active');
  END LOOP;
  RAISE NOTICE 'PASS two students fit under a cap of two';

  INSERT INTO users (tenant_id, full_name_bn, full_name_en, phone_e164, status)
  VALUES (a, 'তৃতীয়', 'Third', '+8801799920003', 'active') RETURNING id INTO v_u;
  BEGIN
    INSERT INTO enrolments (tenant_id, student_id, section_id, academic_year_id, roll_no, status)
    VALUES (a, v_u, v_sec, v_year, 3, 'active');
    RAISE EXCEPTION 'FAIL: the cap did not stop the third student';
  EXCEPTION WHEN check_violation THEN
    GET STACKED DIAGNOSTICS msg = MESSAGE_TEXT;
    -- "cap exceeded" tells an operator nothing. Both numbers tell them
    -- whether to trim the file or raise the plan.
    IF msg NOT LIKE '%2%' OR msg NOT LIKE '%3%' THEN
      RAISE EXCEPTION 'FAIL: the refusal did not state both numbers: %', msg;
    END IF;
    RAISE NOTICE 'PASS %', msg;
  END;
END $$;

-- =====================================================================
-- 7. SUSPENSION KEEPS EVERY ROW.
-- =====================================================================
RESET ROLE;
SET ROLE shikhon_platform;
DO $$
DECLARE a uuid; before_n integer; after_n integer; v_old tenant_status;
BEGIN
  SELECT id INTO a FROM app.platform_tenants('r7-db-alpha');
  SELECT student_count INTO before_n FROM app.platform_tenants('r7-db-alpha');

  SELECT app.set_tenant_status('7c800000-0000-4000-8000-0000000000aa'::uuid,
                               a, 'suspended', 'db test') INTO v_old;

  SELECT student_count INTO after_n FROM app.platform_tenants('r7-db-alpha');
  IF after_n <> before_n THEN
    RAISE EXCEPTION 'FAIL: suspension changed the student count from % to %', before_n, after_n;
  END IF;
  IF (SELECT status FROM app.platform_tenants('r7-db-alpha')) <> 'suspended' THEN
    RAISE EXCEPTION 'FAIL: the tenant is not suspended';
  END IF;

  -- Reversible in one statement, with no re-provisioning.
  PERFORM app.set_tenant_status('7c800000-0000-4000-8000-0000000000aa'::uuid, a, 'active', 'db test');
  IF (SELECT status FROM app.platform_tenants('r7-db-alpha')) <> 'active' THEN
    RAISE EXCEPTION 'FAIL: the tenant did not come back';
  END IF;
  RAISE NOTICE 'PASS suspension is reversible and loses nothing';
END $$;
RESET ROLE;

-- ---------------------------------------------------------------------
-- Teardown — re-runnable, leaving nothing.
-- ---------------------------------------------------------------------
RESET ROLE;
DELETE FROM payment_receipts WHERE tenant_id IN
  (SELECT id FROM tenants WHERE slug IN ('r7-db-alpha', 'r7-db-beta'));
DELETE FROM ledger_entries WHERE tenant_id IN
  (SELECT id FROM tenants WHERE slug IN ('r7-db-alpha', 'r7-db-beta'));
DELETE FROM mfs_transactions WHERE tenant_id IN
  (SELECT id FROM tenants WHERE slug IN ('r7-db-alpha', 'r7-db-beta'));
-- The platform audit trail is append-only and has no FK to tenants. It is
-- cleared here only because this suite must leave the database as it found
-- it; nothing in the product deletes these rows.
DELETE FROM audit.platform_access WHERE reason LIKE 'R-7 db test%' OR reason = 'db test';
DELETE FROM tenants WHERE slug IN ('r7-db-alpha', 'r7-db-beta');

DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM tenants WHERE slug IN ('r7-db-alpha', 'r7-db-beta');
  IF n <> 0 THEN RAISE EXCEPTION 'FAIL: teardown left % tenant row(s)', n; END IF;
  RAISE NOTICE 'PASS teardown — no fixture rows remain';
END $$;

SELECT 'R-7: only the platform creates a school, and it is still bound by RLS.' AS result;
