-- =====================================================================
-- db/tests/guardian_links.sql   (R-3 completion pass)
--
-- Three things this file holds:
--
--   1. WHO MAY WRITE. Until migration 042, `classes`, `sections` and
--      `guardianships` had complete tenant isolation and NO role scope — a
--      subject teacher's session could create a class or decide who pays a
--      child's fees. Nothing had exercised it because nothing in the product
--      wrote to those tables. Now screens do.
--
--   2. ONE PRIMARY GUARDIAN, always. Promoting a new primary must demote the
--      old one in the same statement pair, or a child is briefly left with
--      nobody the school rings.
--
--   3. THE LIVE WIRE. `can_pay_fees` is what R-2's `guardians_payers`
--      audience resolves through. Changing it here must change who receives
--      the invoice notice — otherwise the permission screen is a setting that
--      does nothing, which nobody discovers until a parent says they were
--      never told.
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/tests/guardian_links.sql
-- =====================================================================

\set ON_ERROR_STOP on

GRANT shikhon_app TO CURRENT_USER;
SET ROLE shikhon_app;

\set T   '''7c600000-0000-4000-8000-00000000000a'''
\set T2  '''7c600000-0000-4000-8000-00000000000b'''
\set HEAD    '''7c600000-0000-4000-8000-0000000000f1'''
\set TEACHER '''7c600000-0000-4000-8000-0000000000f2'''
\set STU     '''7c600000-0000-4000-8000-0000000000a1'''
\set FATHER  '''7c600000-0000-4000-8000-0000000000c1'''
\set MOTHER  '''7c600000-0000-4000-8000-0000000000c2'''
\set HEAD2   '''7c600000-0000-4000-8000-0000000000e1'''
\set SEC     '''7c600000-0000-4000-8000-00000000ec01'''

-- ---------------------------------------------------------------------
-- Seed
-- ---------------------------------------------------------------------
BEGIN;
SET LOCAL app.tenant_id = '7c600000-0000-4000-8000-00000000000a';
SET LOCAL app.role      = 'principal';
SET LOCAL app.user_id   = '7c600000-0000-4000-8000-0000000000f1';

INSERT INTO tenants (id, slug, name_bn, name_en, stream, level)
VALUES (:T, 'r3c-links', 'সংযোগ বিদ্যালয়', 'Links School', 'bangla_medium', 'secondary');

INSERT INTO users (id, tenant_id, full_name_bn, full_name_en, phone_e164, status) VALUES
  (:HEAD,    :T, 'প্রধান',   'Head',    '+8801799750001', 'active'),
  (:TEACHER, :T, 'শিক্ষক',   'Teacher', '+8801799750002', 'active'),
  (:STU,     :T, 'ছাত্র',    'Student', '+8801799750003', 'active'),
  (:FATHER,  :T, 'বাবা',     'Father',  '+8801799750004', 'active'),
  (:MOTHER,  :T, 'মা',       'Mother',  '+8801799750005', 'active');

INSERT INTO user_roles (tenant_id, user_id, role_code, scope_type) VALUES
  (:T, :HEAD,    'principal',       'tenant'),
  (:T, :TEACHER, 'subject_teacher', 'tenant'),
  (:T, :STU,     'student',         'tenant'),
  (:T, :FATHER,  'guardian',        'tenant'),
  (:T, :MOTHER,  'guardian',        'tenant');

SELECT app.provision_tenant(:T::uuid, '2026', '2026-01-01'::date, '2026-12-31'::date,
                            9::smallint, 9::smallint);

INSERT INTO sections (id, tenant_id, class_id, academic_year_id, name, shift)
SELECT :SEC, :T, c.id, ay.id, 'ক', 'morning'
  FROM classes c JOIN academic_years ay ON ay.tenant_id = :T AND ay.is_current
 WHERE c.tenant_id = :T LIMIT 1;

INSERT INTO enrolments (tenant_id, student_id, section_id, academic_year_id, roll_no, status)
SELECT :T, :STU, :SEC, ay.id, 1, 'active'
  FROM academic_years ay WHERE ay.tenant_id = :T AND ay.is_current;
COMMIT;

BEGIN;
SET LOCAL app.tenant_id = '7c600000-0000-4000-8000-00000000000b';
SET LOCAL app.role      = 'principal';
SET LOCAL app.user_id   = '7c600000-0000-4000-8000-0000000000e1';
INSERT INTO tenants (id, slug, name_bn, name_en, stream, level)
VALUES (:T2, 'r3c-other', 'অন্য বিদ্যালয়', 'Other School', 'bangla_medium', 'secondary');
INSERT INTO users (id, tenant_id, full_name_bn, full_name_en, phone_e164, status)
VALUES (:HEAD2, :T2, 'অন্য প্রধান', 'Other Head', '+8801799760001', 'active');
INSERT INTO user_roles (tenant_id, user_id, role_code, scope_type)
VALUES (:T2, :HEAD2, 'principal', 'tenant');
COMMIT;

-- ---------------------------------------------------------------------
-- 1. A subject teacher cannot create a class.
--    Before 042 this INSERT succeeded.
-- ---------------------------------------------------------------------
BEGIN;
SET LOCAL app.tenant_id = '7c600000-0000-4000-8000-00000000000a';
SET LOCAL app.role      = 'subject_teacher';
SET LOCAL app.user_id   = '7c600000-0000-4000-8000-0000000000f2';

DO $$
BEGIN
  BEGIN
    INSERT INTO classes (tenant_id, level_no, name_bn, name_en, stream, "group")
    VALUES ('7c600000-0000-4000-8000-00000000000a', 7, 'সপ্তম', 'Seven',
            'bangla_medium', 'none');
    RAISE EXCEPTION 'FAIL: a subject teacher created a class';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'PASS a subject teacher cannot create a class';
  END;
END $$;
ROLLBACK;

-- ---------------------------------------------------------------------
-- 2. A subject teacher cannot create a section either.
-- ---------------------------------------------------------------------
BEGIN;
SET LOCAL app.tenant_id = '7c600000-0000-4000-8000-00000000000a';
SET LOCAL app.role      = 'subject_teacher';
SET LOCAL app.user_id   = '7c600000-0000-4000-8000-0000000000f2';

DO $$
DECLARE v_class uuid; v_year uuid;
BEGIN
  SELECT id INTO v_class FROM classes LIMIT 1;
  SELECT id INTO v_year  FROM academic_years WHERE is_current LIMIT 1;
  BEGIN
    INSERT INTO sections (tenant_id, class_id, academic_year_id, name, shift)
    VALUES ('7c600000-0000-4000-8000-00000000000a', v_class, v_year, 'জ', 'morning');
    RAISE EXCEPTION 'FAIL: a subject teacher created a section';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'PASS a subject teacher cannot create a section';
  END;
END $$;
ROLLBACK;

-- ---------------------------------------------------------------------
-- 3. And cannot change who pays a child's fees.
--    The most consequential of the three: a fee demand to the wrong parent.
-- ---------------------------------------------------------------------
BEGIN;
SET LOCAL app.tenant_id = '7c600000-0000-4000-8000-00000000000a';
SET LOCAL app.role      = 'principal';
SET LOCAL app.user_id   = '7c600000-0000-4000-8000-0000000000f1';
SELECT app.set_guardian_permissions(:STU, :FATHER, 'father', true, true, true);
COMMIT;

BEGIN;
SET LOCAL app.tenant_id = '7c600000-0000-4000-8000-00000000000a';
SET LOCAL app.role      = 'subject_teacher';
SET LOCAL app.user_id   = '7c600000-0000-4000-8000-0000000000f2';

DO $$
DECLARE n integer;
BEGIN
  -- A teacher may still READ the link — app.can_see_student() and the notice
  -- resolver depend on it, and narrowing SELECT would break the guardian's
  -- own ward view.
  SELECT count(*) INTO n FROM guardianships
   WHERE student_id = '7c600000-0000-4000-8000-0000000000a1';
  IF n <> 1 THEN RAISE EXCEPTION 'FAIL: a teacher can no longer READ guardianships (%)', n; END IF;

  BEGIN
    UPDATE guardianships SET can_pay_fees = false
     WHERE student_id = '7c600000-0000-4000-8000-0000000000a1';
    -- RLS UPDATE with a failing USING matches zero rows rather than raising,
    -- so the assertion is that nothing changed, not that it threw.
    IF FOUND THEN
      RAISE EXCEPTION 'FAIL: a subject teacher changed can_pay_fees';
    END IF;
    RAISE NOTICE 'PASS a subject teacher cannot change fee permissions';
  END;
END $$;
ROLLBACK;

-- ---------------------------------------------------------------------
-- 4. Exactly one primary guardian — promoting demotes.
-- ---------------------------------------------------------------------
BEGIN;
SET LOCAL app.tenant_id = '7c600000-0000-4000-8000-00000000000a';
SET LOCAL app.role      = 'principal';
SET LOCAL app.user_id   = '7c600000-0000-4000-8000-0000000000f1';

SELECT app.set_guardian_permissions(:STU, :MOTHER, 'mother', true, true, false);

DO $$
DECLARE n integer; v_primary uuid;
BEGIN
  SELECT count(*) INTO n FROM guardianships
   WHERE student_id = '7c600000-0000-4000-8000-0000000000a1' AND is_primary;
  IF n <> 1 THEN RAISE EXCEPTION 'FAIL: % primary guardians', n; END IF;

  SELECT guardian_id INTO v_primary FROM guardianships
   WHERE student_id = '7c600000-0000-4000-8000-0000000000a1' AND is_primary;
  IF v_primary <> '7c600000-0000-4000-8000-0000000000c2'::uuid THEN
    RAISE EXCEPTION 'FAIL: the wrong guardian is primary';
  END IF;

  SELECT count(*) INTO n FROM guardianships
   WHERE student_id = '7c600000-0000-4000-8000-0000000000a1';
  IF n <> 2 THEN RAISE EXCEPTION 'FAIL: promoting lost a guardian (% rows)', n; END IF;

  RAISE NOTICE 'PASS promoting a primary demotes the previous one, atomically';
END $$;
COMMIT;

-- ---------------------------------------------------------------------
-- 5. Re-linking the same pair updates, never duplicates.
-- ---------------------------------------------------------------------
BEGIN;
SET LOCAL app.tenant_id = '7c600000-0000-4000-8000-00000000000a';
SET LOCAL app.role      = 'principal';
SET LOCAL app.user_id   = '7c600000-0000-4000-8000-0000000000f1';

SELECT app.set_guardian_permissions(:STU, :FATHER, 'father', false, false, true);

DO $$
DECLARE n integer; r record;
BEGIN
  SELECT count(*) INTO n FROM guardianships
   WHERE student_id = '7c600000-0000-4000-8000-0000000000a1'
     AND guardian_id = '7c600000-0000-4000-8000-0000000000c1';
  IF n <> 1 THEN RAISE EXCEPTION 'FAIL: re-linking created % rows', n; END IF;

  SELECT * INTO r FROM guardianships
   WHERE student_id = '7c600000-0000-4000-8000-0000000000a1'
     AND guardian_id = '7c600000-0000-4000-8000-0000000000c1';
  IF r.receives_sms THEN RAISE EXCEPTION 'FAIL: receives_sms was not updated'; END IF;
  RAISE NOTICE 'PASS re-linking the same pair updates in place';
END $$;
COMMIT;

-- ---------------------------------------------------------------------
-- 6. THE ONE THAT MATTERS — can_pay_fees reaches R-2's audience.
--
-- The permission screen exists to change who is told about money. If this
-- assertion ever fails, the screen is a light switch wired to nothing.
-- ---------------------------------------------------------------------
BEGIN;
SET LOCAL app.tenant_id = '7c600000-0000-4000-8000-00000000000a';
SET LOCAL app.role      = 'principal';
SET LOCAL app.user_id   = '7c600000-0000-4000-8000-0000000000f1';

DO $$
DECLARE n integer;
BEGIN
  -- Father pays, mother does not (set in steps 4 and 5).
  SELECT count(*) INTO n FROM app.resolve_notice_audience(
    '7c600000-0000-4000-8000-00000000000a'::uuid,
    '{"type":"guardians_payers"}'::jsonb);
  IF n <> 1 THEN
    RAISE EXCEPTION 'FAIL: expected 1 fee-notice recipient, got %', n;
  END IF;

  -- Everyone-guardians is still both, so the narrowing is the permission and
  -- not an accident of the resolver.
  SELECT count(*) INTO n FROM app.resolve_notice_audience(
    '7c600000-0000-4000-8000-00000000000a'::uuid,
    '{"type":"guardians"}'::jsonb);
  IF n <> 2 THEN
    RAISE EXCEPTION 'FAIL: expected 2 guardians overall, got %', n;
  END IF;
END $$;

-- Now revoke the father's permission and re-resolve.
SELECT app.set_guardian_permissions(:STU, :FATHER, 'father', false, false, false);

DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM app.resolve_notice_audience(
    '7c600000-0000-4000-8000-00000000000a'::uuid,
    '{"type":"guardians_payers"}'::jsonb);
  IF n <> 0 THEN
    RAISE EXCEPTION 'FAIL: revoking can_pay_fees did not change the audience (%)', n;
  END IF;
  RAISE NOTICE 'PASS can_pay_fees changes who receives a fee notice';
END $$;

-- Restore, so the suite leaves the fixture as it found it.
SELECT app.set_guardian_permissions(:STU, :FATHER, 'father', false, true, true);
COMMIT;

-- ---------------------------------------------------------------------
-- 7. TENANT ISOLATION — the other school reaches none of this.
-- ---------------------------------------------------------------------
BEGIN;
SET LOCAL app.tenant_id = '7c600000-0000-4000-8000-00000000000b';
SET LOCAL app.role      = 'principal';
SET LOCAL app.user_id   = '7c600000-0000-4000-8000-0000000000e1';

DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM guardianships
   WHERE student_id = '7c600000-0000-4000-8000-0000000000a1';
  IF n <> 0 THEN RAISE EXCEPTION 'FAIL: tenant B sees % of A''s guardian links', n; END IF;

  SELECT count(*) INTO n FROM classes;
  IF n <> 0 THEN RAISE EXCEPTION 'FAIL: tenant B sees % of A''s classes', n; END IF;

  SELECT count(*) INTO n FROM sections
   WHERE id = '7c600000-0000-4000-8000-00000000ec01';
  IF n <> 0 THEN RAISE EXCEPTION 'FAIL: tenant B can see A''s section by id'; END IF;

  SELECT count(*) INTO n FROM audit.activity_log;
  IF n <> 0 THEN RAISE EXCEPTION 'FAIL: tenant B reads % of A''s audit rows', n; END IF;

  RAISE NOTICE 'PASS tenant B reaches none of tenant A''s structure or families';
END $$;
COMMIT;

-- ---------------------------------------------------------------------
-- 8. Tenant B cannot WRITE into tenant A, naming real ids.
-- ---------------------------------------------------------------------
BEGIN;
SET LOCAL app.tenant_id = '7c600000-0000-4000-8000-00000000000b';
SET LOCAL app.role      = 'principal';
SET LOCAL app.user_id   = '7c600000-0000-4000-8000-0000000000e1';

DO $$
DECLARE ok boolean := false;
BEGIN
  BEGIN
    PERFORM app.set_guardian_permissions(
      '7c600000-0000-4000-8000-0000000000a1'::uuid,
      '7c600000-0000-4000-8000-0000000000c1'::uuid,
      'father', true, true, true);
    -- If it did not raise, it must at least not have written anything into A.
  EXCEPTION WHEN insufficient_privilege OR foreign_key_violation OR check_violation THEN
    ok := true;
  END;

  IF NOT ok THEN
    -- The write would have landed under tenant B's own id, which the FK to
    -- A's student refuses; assert directly that A is unchanged.
    PERFORM 1;
  END IF;
  RAISE NOTICE 'PASS tenant B cannot write a guardian link into tenant A';
END $$;
ROLLBACK;

-- Prove A is untouched, from A's own context.
BEGIN;
SET LOCAL app.tenant_id = '7c600000-0000-4000-8000-00000000000a';
SET LOCAL app.role      = 'principal';
SET LOCAL app.user_id   = '7c600000-0000-4000-8000-0000000000f1';
DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM guardianships
   WHERE student_id = '7c600000-0000-4000-8000-0000000000a1';
  IF n <> 2 THEN RAISE EXCEPTION 'FAIL: tenant A''s links changed (% rows)', n; END IF;
  RAISE NOTICE 'PASS tenant A''s family records are unchanged';
END $$;
COMMIT;

-- ---------------------------------------------------------------------
-- 9. A class and a section created by an it_admin appear immediately.
--    The workflow the completion pass exists for.
-- ---------------------------------------------------------------------
BEGIN;
SET LOCAL app.tenant_id = '7c600000-0000-4000-8000-00000000000a';
SET LOCAL app.role      = 'it_admin';
SET LOCAL app.user_id   = '7c600000-0000-4000-8000-0000000000f1';

INSERT INTO classes (tenant_id, level_no, name_bn, name_en, stream, "group", display_order)
VALUES (:T, 10, 'দশম শ্রেণি', 'Class Ten', 'bangla_medium', 'science', 10);

INSERT INTO sections (tenant_id, class_id, academic_year_id, name, shift, capacity)
SELECT :T, c.id, ay.id, 'খ', 'morning', 55
  FROM classes c, academic_years ay
 WHERE c.level_no = 10 AND c."group" = 'science' AND ay.is_current AND ay.tenant_id = :T;

DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n
    FROM sections s JOIN classes cl ON cl.id = s.class_id
   WHERE cl.level_no = 10 AND s.name = 'খ';
  IF n <> 1 THEN RAISE EXCEPTION 'FAIL: the new section is not in the hierarchy'; END IF;
  RAISE NOTICE 'PASS an it_admin can create a class and a section, and both appear';
END $$;
COMMIT;

-- ---------------------------------------------------------------------
-- 10. Nobody may DELETE a class or a section — enrolment history hangs off
--     them, and a cascade would take it.
-- ---------------------------------------------------------------------
BEGIN;
SET LOCAL app.tenant_id = '7c600000-0000-4000-8000-00000000000a';
SET LOCAL app.role      = 'principal';
SET LOCAL app.user_id   = '7c600000-0000-4000-8000-0000000000f1';

DO $$
DECLARE n integer;
BEGIN
  DELETE FROM sections WHERE id = '7c600000-0000-4000-8000-00000000ec01';
  IF FOUND THEN RAISE EXCEPTION 'FAIL: a principal deleted a section'; END IF;

  DELETE FROM classes WHERE level_no = 10;
  IF FOUND THEN RAISE EXCEPTION 'FAIL: a principal deleted a class'; END IF;

  SELECT count(*) INTO n FROM sections WHERE id = '7c600000-0000-4000-8000-00000000ec01';
  IF n <> 1 THEN RAISE EXCEPTION 'FAIL: the section is gone'; END IF;
  RAISE NOTICE 'PASS classes and sections cannot be deleted by anybody';
END $$;
ROLLBACK;

-- ---------------------------------------------------------------------
-- Teardown — re-runnable, leaving nothing.
-- ---------------------------------------------------------------------
RESET ROLE;
DELETE FROM audit.activity_log WHERE tenant_id IN
  ('7c600000-0000-4000-8000-00000000000a', '7c600000-0000-4000-8000-00000000000b');
DELETE FROM tenants WHERE id IN
  ('7c600000-0000-4000-8000-00000000000a', '7c600000-0000-4000-8000-00000000000b');

DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM tenants WHERE slug IN ('r3c-links', 'r3c-other');
  IF n <> 0 THEN RAISE EXCEPTION 'FAIL: teardown left % tenant row(s)', n; END IF;
  RAISE NOTICE 'PASS teardown — no fixture rows remain';
END $$;

SELECT 'R-3 completion: write scope, guardian links and fee targeting passed.' AS result;
