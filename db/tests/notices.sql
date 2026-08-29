-- =====================================================================
-- db/tests/notices.sql   (R-2, docs/11-MASTER-PLAN.md)
--
-- The promise a notice system makes is negative: the people who were NOT
-- addressed do not see it. So most of what follows asserts absence.
--
--   A staff-only notice reaches staff, and no student.
--   A section notice reaches that section's students AND their guardians,
--     and nobody in another section.
--   A guardian with two children gets one receipt per child.
--   Re-publishing is free — no duplicate receipt, no second SMS event.
--   A student cannot read a notice they hold no receipt for, even by id.
--   Tenant B sees none of tenant A's notices.
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/tests/notices.sql
-- =====================================================================

\set ON_ERROR_STOP on

GRANT shikhon_app TO CURRENT_USER;
SET ROLE shikhon_app;

\set T   '''7be00000-0000-4000-8000-00000000000a'''
\set T2  '''7be00000-0000-4000-8000-00000000000b'''
\set HEAD    '''7be00000-0000-4000-8000-0000000000f1'''
\set TEACHER '''7be00000-0000-4000-8000-0000000000f2'''
\set STU_A   '''7be00000-0000-4000-8000-0000000000a1'''
\set STU_B   '''7be00000-0000-4000-8000-0000000000a2'''
\set GUARD   '''7be00000-0000-4000-8000-0000000000c1'''

-- ---------------------------------------------------------------------
-- Seed: one tenant, two sections, two students (siblings — ONE guardian),
-- a head teacher and a class teacher.
-- ---------------------------------------------------------------------
BEGIN;
SET LOCAL app.tenant_id = '7be00000-0000-4000-8000-00000000000a';
SET LOCAL app.role      = 'principal';
SET LOCAL app.user_id   = '7be00000-0000-4000-8000-0000000000f1';

INSERT INTO tenants (id, slug, name_bn, name_en, stream, level)
VALUES (:T, 'r2-notices', 'নোটিশ বিদ্যালয়', 'Notice School', 'bangla_medium', 'secondary');

INSERT INTO users (id, tenant_id, full_name_bn, full_name_en, phone_e164, status) VALUES
  (:HEAD,    :T, 'প্রধান শিক্ষক', 'Head',      '+8801799700001', 'active'),
  (:TEACHER, :T, 'শ্রেণি শিক্ষক', 'Teacher',   '+8801799700002', 'active'),
  (:STU_A,   :T, 'ছাত্র ক',       'Student A', '+8801799700003', 'active'),
  (:STU_B,   :T, 'ছাত্র খ',       'Student B', '+8801799700004', 'active'),
  (:GUARD,   :T, 'অভিভাবক',      'Guardian',  '+8801799700005', 'active');

-- Staff roles. Students and guardians deliberately get none: is_staff on the
-- role is what app.resolve_notice_audience uses to classify them.
INSERT INTO user_roles (tenant_id, user_id, role_id, scope_type)
SELECT :T, :HEAD, id, 'tenant' FROM roles WHERE code = 'principal';
INSERT INTO user_roles (tenant_id, user_id, role_id, scope_type)
SELECT :T, :TEACHER, id, 'tenant' FROM roles WHERE code = 'class_teacher';

SELECT app.provision_tenant(:T::uuid, '2026', '2026-01-01'::date, '2026-12-31'::date,
                            9::smallint, 9::smallint);

-- Two sections of class 9, and the two students split across them.
INSERT INTO sections (id, tenant_id, class_offering_id, academic_year_id, name, shift)
SELECT '7be00000-0000-4000-8000-00000000ec01', :T, co.id, ay.id, 'ক', 'morning'
  FROM class_offerings co
  JOIN academic_years ay ON ay.tenant_id = :T AND ay.is_current
 WHERE co.tenant_id = :T LIMIT 1;
INSERT INTO sections (id, tenant_id, class_offering_id, academic_year_id, name, shift)
SELECT '7be00000-0000-4000-8000-00000000ec02', :T, co.id, ay.id, 'খ', 'morning'
  FROM class_offerings co
  JOIN academic_years ay ON ay.tenant_id = :T AND ay.is_current
 WHERE co.tenant_id = :T LIMIT 1;

INSERT INTO enrolments (tenant_id, student_id, section_id, academic_year_id, roll_no, status)
SELECT :T, :STU_A, '7be00000-0000-4000-8000-00000000ec01', ay.id, 1, 'active'
  FROM academic_years ay WHERE ay.tenant_id = :T AND ay.is_current;
INSERT INTO enrolments (tenant_id, student_id, section_id, academic_year_id, roll_no, status)
SELECT :T, :STU_B, '7be00000-0000-4000-8000-00000000ec02', ay.id, 1, 'active'
  FROM academic_years ay WHERE ay.tenant_id = :T AND ay.is_current;

-- ONE guardian, TWO children — the sibling case that produces duplicate SMS
-- when a system gets it wrong.
INSERT INTO guardianships (tenant_id, guardian_id, student_id, relation, is_primary, receives_sms)
VALUES (:T, :GUARD, :STU_A, 'father', true,  true),
       (:T, :GUARD, :STU_B, 'father', false, true);
COMMIT;

-- ---------------------------------------------------------------------
-- 1. A staff-only notice reaches staff and NOBODY else.
-- ---------------------------------------------------------------------
BEGIN;
SET LOCAL app.tenant_id = '7be00000-0000-4000-8000-00000000000a';
SET LOCAL app.role      = 'principal';
SET LOCAL app.user_id   = '7be00000-0000-4000-8000-0000000000f1';

INSERT INTO notices (id, tenant_id, title, body, category, audience, created_by)
VALUES ('7be00000-0000-4000-8000-00000000ff01', :T,
        'শিক্ষক সভা', 'বৃহস্পতিবার ৩টায়।', 'teacher',
        '{"type":"staff"}'::jsonb, :HEAD);

SELECT app.publish_notice('7be00000-0000-4000-8000-00000000ff01');

DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM notice_receipts
   WHERE notice_id = '7be00000-0000-4000-8000-00000000ff01'
     AND user_id = '7be00000-0000-4000-8000-0000000000f2';   -- the class teacher
  IF n <> 1 THEN RAISE EXCEPTION 'FAIL: staff notice did not reach the teacher (% receipts)', n; END IF;

  SELECT count(*) INTO n FROM notice_receipts
   WHERE notice_id = '7be00000-0000-4000-8000-00000000ff01'
     AND user_id IN ('7be00000-0000-4000-8000-0000000000a1',
                     '7be00000-0000-4000-8000-0000000000a2',
                     '7be00000-0000-4000-8000-0000000000c1');
  IF n <> 0 THEN
    RAISE EXCEPTION 'FAIL: a staff-only notice reached % student/guardian(s)', n;
  END IF;
  RAISE NOTICE 'PASS staff notice reaches staff only';
END $$;
COMMIT;

-- ---------------------------------------------------------------------
-- 2. A section notice reaches that section's student AND their guardian,
--    once per child, and nobody in the other section.
-- ---------------------------------------------------------------------
BEGIN;
SET LOCAL app.tenant_id = '7be00000-0000-4000-8000-00000000000a';
SET LOCAL app.role      = 'principal';
SET LOCAL app.user_id   = '7be00000-0000-4000-8000-0000000000f1';

INSERT INTO notices (id, tenant_id, title, body, category, audience, created_by)
VALUES ('7be00000-0000-4000-8000-00000000ff02', :T,
        'শাখা ক-এর পরীক্ষা', 'রবিবার।', 'section',
        '{"type":"section","ids":["7be00000-0000-4000-8000-00000000ec01"]}'::jsonb, :HEAD);

SELECT app.publish_notice('7be00000-0000-4000-8000-00000000ff02');

DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM notice_receipts
   WHERE notice_id = '7be00000-0000-4000-8000-00000000ff02'
     AND user_id = '7be00000-0000-4000-8000-0000000000a1';
  IF n <> 1 THEN RAISE EXCEPTION 'FAIL: section student got % receipts, expected 1', n; END IF;

  -- The guardian gets ONE receipt, about the child in that section — not two,
  -- and not one with a NULL child.
  SELECT count(*) INTO n FROM notice_receipts
   WHERE notice_id = '7be00000-0000-4000-8000-00000000ff02'
     AND user_id = '7be00000-0000-4000-8000-0000000000c1'
     AND about_student_id = '7be00000-0000-4000-8000-0000000000a1';
  IF n <> 1 THEN RAISE EXCEPTION 'FAIL: guardian receipt for the right child = %', n; END IF;

  SELECT count(*) INTO n FROM notice_receipts
   WHERE notice_id = '7be00000-0000-4000-8000-00000000ff02'
     AND user_id = '7be00000-0000-4000-8000-0000000000c1';
  IF n <> 1 THEN
    RAISE EXCEPTION 'FAIL: guardian got % receipts for a one-section notice', n;
  END IF;

  -- The sibling in the other section is not addressed.
  SELECT count(*) INTO n FROM notice_receipts
   WHERE notice_id = '7be00000-0000-4000-8000-00000000ff02'
     AND user_id = '7be00000-0000-4000-8000-0000000000a2';
  IF n <> 0 THEN RAISE EXCEPTION 'FAIL: a notice leaked into another section'; END IF;
  RAISE NOTICE 'PASS section notice reaches the section and its guardians only';
END $$;
COMMIT;

-- ---------------------------------------------------------------------
-- 3. A school-wide notice gives the sibling guardian ONE receipt PER CHILD.
--    Two children, two pieces of news — but never four, and never one.
-- ---------------------------------------------------------------------
BEGIN;
SET LOCAL app.tenant_id = '7be00000-0000-4000-8000-00000000000a';
SET LOCAL app.role      = 'principal';
SET LOCAL app.user_id   = '7be00000-0000-4000-8000-0000000000f1';

INSERT INTO notices (id, tenant_id, title, body, category, audience, created_by)
VALUES ('7be00000-0000-4000-8000-00000000ff03', :T,
        'সবার জন্য', 'ছুটির নোটিশ।', 'general', '{"type":"all"}'::jsonb, :HEAD);
SELECT app.publish_notice('7be00000-0000-4000-8000-00000000ff03');

DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM notice_receipts
   WHERE notice_id = '7be00000-0000-4000-8000-00000000ff03'
     AND user_id = '7be00000-0000-4000-8000-0000000000c1';
  IF n <> 2 THEN
    RAISE EXCEPTION 'FAIL: guardian of two children got % receipts, expected 2', n;
  END IF;
  RAISE NOTICE 'PASS a guardian is told once per child';
END $$;
COMMIT;

-- ---------------------------------------------------------------------
-- 4. Re-publishing is free. THE idempotency guarantee: a retried publish
--    must not buzz a parent's phone twice or double the bill.
-- ---------------------------------------------------------------------
BEGIN;
SET LOCAL app.tenant_id = '7be00000-0000-4000-8000-00000000000a';
SET LOCAL app.role      = 'principal';
SET LOCAL app.user_id   = '7be00000-0000-4000-8000-0000000000f1';

DO $$
DECLARE before_n integer; after_n integer; added integer;
BEGIN
  SELECT count(*) INTO before_n FROM notice_receipts
   WHERE notice_id = '7be00000-0000-4000-8000-00000000ff03';

  SELECT recipients INTO added
    FROM app.publish_notice('7be00000-0000-4000-8000-00000000ff03');

  SELECT count(*) INTO after_n FROM notice_receipts
   WHERE notice_id = '7be00000-0000-4000-8000-00000000ff03';

  IF after_n <> before_n THEN
    RAISE EXCEPTION 'FAIL: re-publish created % duplicate receipt(s)', after_n - before_n;
  END IF;
  IF added <> 0 THEN
    RAISE EXCEPTION 'FAIL: re-publish reported % new recipients', added;
  END IF;
  RAISE NOTICE 'PASS re-publish is free';
END $$;
COMMIT;

-- ---------------------------------------------------------------------
-- 5. A student cannot read a notice they hold no receipt for — even by id.
--    This is the guarantee, and it is RLS's, not the endpoint's.
-- ---------------------------------------------------------------------
BEGIN;
SET LOCAL app.tenant_id = '7be00000-0000-4000-8000-00000000000a';
SET LOCAL app.role      = 'student';
SET LOCAL app.user_id   = '7be00000-0000-4000-8000-0000000000a1';

DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM notices
   WHERE id = '7be00000-0000-4000-8000-00000000ff01';    -- the staff notice
  IF n <> 0 THEN
    RAISE EXCEPTION 'FAIL: a student read a staff-only notice by id';
  END IF;

  -- What they SHOULD see: the two they were sent.
  SELECT count(*) INTO n FROM notices;
  IF n <> 2 THEN
    RAISE EXCEPTION 'FAIL: student sees % notices, expected 2 (section + all)', n;
  END IF;

  -- And no receipts but their own.
  SELECT count(*) INTO n FROM notice_receipts
   WHERE user_id <> '7be00000-0000-4000-8000-0000000000a1';
  IF n <> 0 THEN
    RAISE EXCEPTION 'FAIL: a student can see % other people''s receipts', n;
  END IF;
  RAISE NOTICE 'PASS a student sees only what they were sent';
END $$;
COMMIT;

-- ---------------------------------------------------------------------
-- 6. Cross-tenant: tenant B sees none of tenant A's notices.
-- ---------------------------------------------------------------------
BEGIN;
SET LOCAL app.tenant_id = '7be00000-0000-4000-8000-00000000000b';
SET LOCAL app.role      = 'principal';
INSERT INTO tenants (id, slug, name_bn, name_en, stream, level)
VALUES (:T2, 'r2-other', 'অন্য বিদ্যালয়', 'Other School', 'bangla_medium', 'secondary');
COMMIT;

BEGIN;
SET LOCAL app.tenant_id = '7be00000-0000-4000-8000-00000000000b';
SET LOCAL app.role      = 'principal';
DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM notices;
  IF n <> 0 THEN RAISE EXCEPTION 'FAIL: tenant B sees % of tenant A''s notices', n; END IF;
  SELECT count(*) INTO n FROM notice_receipts;
  IF n <> 0 THEN RAISE EXCEPTION 'FAIL: tenant B sees % of tenant A''s receipts', n; END IF;
  RAISE NOTICE 'PASS notices do not cross tenants';
END $$;
COMMIT;

-- ---------------------------------------------------------------------
-- 7. The audience resolver refuses to run outside its tenant's context.
-- ---------------------------------------------------------------------
BEGIN;
SET LOCAL app.tenant_id = '7be00000-0000-4000-8000-00000000000b';
SET LOCAL app.role      = 'principal';
DO $$
BEGIN
  BEGIN
    PERFORM * FROM app.resolve_notice_audience(
      '7be00000-0000-4000-8000-00000000000a'::uuid, '{"type":"all"}'::jsonb);
    RAISE EXCEPTION 'FAIL: resolved another tenant''s audience';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'PASS the resolver refuses a foreign tenant';
  END;
END $$;
COMMIT;

-- ---------------------------------------------------------------------
-- Teardown — re-runnable, leaves nothing.
-- ---------------------------------------------------------------------
BEGIN;
SET LOCAL app.tenant_id = '7be00000-0000-4000-8000-00000000000a';
SET LOCAL app.role      = 'principal';
DELETE FROM tenants WHERE id = '7be00000-0000-4000-8000-00000000000a';
COMMIT;

BEGIN;
SET LOCAL app.tenant_id = '7be00000-0000-4000-8000-00000000000b';
SET LOCAL app.role      = 'principal';
DELETE FROM tenants WHERE id = '7be00000-0000-4000-8000-00000000000b';
COMMIT;

BEGIN;
SET LOCAL app.tenant_id = '7be00000-0000-4000-8000-00000000000a';
SET LOCAL app.role      = 'principal';
DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM tenants;
  IF n <> 0 THEN RAISE EXCEPTION 'FAIL teardown: fixture tenant survived'; END IF;
  RAISE NOTICE 'PASS teardown — no fixture rows remain';
END $$;
COMMIT;

\echo ''
\echo '================================================'
\echo ' R-2 notices: audience, isolation and idempotency passed.'
\echo '================================================'
