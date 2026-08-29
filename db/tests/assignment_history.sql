-- =====================================================================
-- db/tests/assignment_history.sql   (R-3, docs/11-MASTER-PLAN.md)
--
-- R-3 lets a school change who teaches what. The promise it makes is that
-- changing something does not erase what was true before, and that one
-- school can neither see nor touch another's structure.
--
--   Assigning a teacher to a free subject opens one row and closes nothing.
--   Replacing a teacher CLOSES the old row and opens a new one — the old
--     row survives, with its dates and its reason.
--   Two open rows for the same subject are impossible.
--   Re-assigning the same person changes nothing (the double-submit case).
--   sections.class_teacher_id always tracks the open class-teacher row.
--   The it_admin role exists and can actually be granted.
--   Tenant B cannot read, assign into, or replace within tenant A.
--   A teacher's own history survives their deactivation.
--   The audit log is tenant-scoped and management-only.
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/tests/assignment_history.sql
-- =====================================================================

\set ON_ERROR_STOP on

GRANT shikhon_app TO CURRENT_USER;
SET ROLE shikhon_app;

\set T   '''7c300000-0000-4000-8000-00000000000a'''
\set T2  '''7c300000-0000-4000-8000-00000000000b'''
\set HEAD    '''7c300000-0000-4000-8000-0000000000f1'''
\set RAHIM   '''7c300000-0000-4000-8000-0000000000f2'''
\set KARIM   '''7c300000-0000-4000-8000-0000000000f3'''
\set ITADMIN '''7c300000-0000-4000-8000-0000000000f4'''
\set STU     '''7c300000-0000-4000-8000-0000000000a1'''
\set SEC_F   '''7c300000-0000-4000-8000-00000000ec0f'''
\set HEAD2   '''7c300000-0000-4000-8000-0000000000e1'''
\set SEC_X   '''7c300000-0000-4000-8000-00000000ec0x'''

-- ---------------------------------------------------------------------
-- Seed: Monipur-shaped. One tenant, class 9, section F, two teachers who
-- will swap, one student. Plus a second tenant that must stay sealed off.
-- ---------------------------------------------------------------------
BEGIN;
SET LOCAL app.tenant_id = '7c300000-0000-4000-8000-00000000000a';
SET LOCAL app.role      = 'principal';
SET LOCAL app.user_id   = '7c300000-0000-4000-8000-0000000000f1';

INSERT INTO tenants (id, slug, name_bn, name_en, stream, level)
VALUES (:T, 'r3-assign', 'মনিপুর বিদ্যালয়', 'Monipur School', 'bangla_medium', 'secondary');

INSERT INTO users (id, tenant_id, full_name_bn, full_name_en, phone_e164, status) VALUES
  (:HEAD,    :T, 'প্রধান শিক্ষক', 'Head',     '+8801799710001', 'active'),
  (:RAHIM,   :T, 'রহিম স্যার',    'Rahim',    '+8801799710002', 'active'),
  (:KARIM,   :T, 'করিম স্যার',    'Karim',    '+8801799710003', 'active'),
  (:ITADMIN, :T, 'আইটি অ্যাডমিন', 'IT Admin', '+8801799710004', 'active'),
  (:STU,     :T, 'ছাত্র ক',       'Student',  '+8801799710005', 'active');

INSERT INTO user_roles (tenant_id, user_id, role_code, scope_type) VALUES
  (:T, :HEAD,  'principal',       'tenant'),
  (:T, :RAHIM, 'subject_teacher', 'tenant'),
  (:T, :KARIM, 'subject_teacher', 'tenant'),
  -- The point of this row: before 041 the FK to roles.code made it
  -- impossible, so every it_admin check in the codebase was decorative.
  (:T, :ITADMIN, 'it_admin',      'tenant');

SELECT app.provision_tenant(:T::uuid, '2026', '2026-01-01'::date, '2026-12-31'::date,
                            9::smallint, 9::smallint);

INSERT INTO sections (id, tenant_id, class_id, academic_year_id, name, shift)
SELECT :SEC_F, :T, c.id, ay.id, 'F', 'morning'
  FROM classes c
  JOIN academic_years ay ON ay.tenant_id = :T AND ay.is_current
 WHERE c.tenant_id = :T LIMIT 1;

INSERT INTO enrolments (tenant_id, student_id, section_id, academic_year_id, roll_no, status)
SELECT :T, :STU, :SEC_F, ay.id, 1, 'active'
  FROM academic_years ay WHERE ay.tenant_id = :T AND ay.is_current;
COMMIT;

-- The second school, sealed off.
BEGIN;
SET LOCAL app.tenant_id = '7c300000-0000-4000-8000-00000000000b';
SET LOCAL app.role      = 'principal';
SET LOCAL app.user_id   = '7c300000-0000-4000-8000-0000000000e1';

INSERT INTO tenants (id, slug, name_bn, name_en, stream, level)
VALUES (:T2, 'r3-other', 'মোহাম্মদপুর বিদ্যালয়', 'Mohammadpur School', 'bangla_medium', 'secondary');
INSERT INTO users (id, tenant_id, full_name_bn, full_name_en, phone_e164, status)
VALUES (:HEAD2, :T2, 'অন্য প্রধান', 'Other Head', '+8801799720001', 'active');
INSERT INTO user_roles (tenant_id, user_id, role_code, scope_type)
VALUES (:T2, :HEAD2, 'principal', 'tenant');
SELECT app.provision_tenant(:T2::uuid, '2026', '2026-01-01'::date, '2026-12-31'::date,
                            9::smallint, 9::smallint);
COMMIT;

-- ---------------------------------------------------------------------
-- 1. it_admin is a role a real user can hold.
-- ---------------------------------------------------------------------
-- user_roles is tenant-scoped, so this needs a tenant context to see
-- anything at all — the same fail-closed behaviour every other table has.
BEGIN;
SET LOCAL app.tenant_id = '7c300000-0000-4000-8000-00000000000a';
SET LOCAL app.role      = 'principal';
SET LOCAL app.user_id   = '7c300000-0000-4000-8000-0000000000f1';

DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM roles WHERE code = 'it_admin' AND is_staff;
  IF n <> 1 THEN RAISE EXCEPTION 'FAIL: it_admin is not a staff role (% rows)', n; END IF;

  SELECT count(*) INTO n FROM user_roles
   WHERE user_id = '7c300000-0000-4000-8000-0000000000f4' AND role_code = 'it_admin';
  IF n <> 1 THEN RAISE EXCEPTION 'FAIL: it_admin could not be granted'; END IF;
  RAISE NOTICE 'PASS it_admin exists and can be granted';
END $$;
COMMIT;

-- ---------------------------------------------------------------------
-- 2. First assignment opens one row and closes nothing.
-- ---------------------------------------------------------------------
BEGIN;
SET LOCAL app.tenant_id = '7c300000-0000-4000-8000-00000000000a';
SET LOCAL app.role      = 'principal';
SET LOCAL app.user_id   = '7c300000-0000-4000-8000-0000000000f1';

SELECT app.assign_subject_teacher(
  :SEC_F,
  (SELECT id FROM subjects WHERE tenant_id = :T ORDER BY name_bn LIMIT 1),
  :RAHIM, '2026-01-05'::date, NULL);

DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM section_subject_teachers
   WHERE section_id = '7c300000-0000-4000-8000-00000000ec0f' AND ended_on IS NULL;
  IF n <> 1 THEN RAISE EXCEPTION 'FAIL: expected 1 open assignment, got %', n; END IF;

  SELECT count(*) INTO n FROM section_subject_teachers
   WHERE section_id = '7c300000-0000-4000-8000-00000000ec0f' AND ended_on IS NOT NULL;
  IF n <> 0 THEN RAISE EXCEPTION 'FAIL: a first assignment closed % row(s)', n; END IF;
  RAISE NOTICE 'PASS first assignment opens one row, closes none';
END $$;
COMMIT;

-- ---------------------------------------------------------------------
-- 3. THE ONE THAT MATTERS — replacement preserves the first teacher.
--
-- This is the whole reason 041 exists. Before it, the UNIQUE constraint
-- forced an UPDATE and March disappeared.
-- ---------------------------------------------------------------------
BEGIN;
SET LOCAL app.tenant_id = '7c300000-0000-4000-8000-00000000000a';
SET LOCAL app.role      = 'principal';
SET LOCAL app.user_id   = '7c300000-0000-4000-8000-0000000000f1';

SELECT app.assign_subject_teacher(
  :SEC_F,
  (SELECT id FROM subjects WHERE tenant_id = :T ORDER BY name_bn LIMIT 1),
  :KARIM, '2026-03-15'::date, 'বদলি হয়েছেন');

DO $$
DECLARE r record; n integer;
BEGIN
  SELECT count(*) INTO n FROM section_subject_teachers
   WHERE section_id = '7c300000-0000-4000-8000-00000000ec0f';
  IF n <> 2 THEN RAISE EXCEPTION 'FAIL: expected 2 rows after replacement, got %', n; END IF;

  -- The outgoing teacher, with dates and a reason.
  SELECT * INTO r FROM section_subject_teachers
   WHERE section_id = '7c300000-0000-4000-8000-00000000ec0f'
     AND teacher_id = '7c300000-0000-4000-8000-0000000000f2';
  IF r.ended_on IS NULL THEN
    RAISE EXCEPTION 'FAIL: the replaced teacher''s row is still open';
  END IF;
  IF r.ended_on <> '2026-03-15'::date THEN
    RAISE EXCEPTION 'FAIL: wrong end date %', r.ended_on;
  END IF;
  IF r.end_reason IS DISTINCT FROM 'বদলি হয়েছেন' THEN
    RAISE EXCEPTION 'FAIL: the reason was not kept (%)', r.end_reason;
  END IF;
  IF r.started_on <> '2026-01-05'::date THEN
    RAISE EXCEPTION 'FAIL: the original start date was lost (%)', r.started_on;
  END IF;

  -- And exactly one open row, held by the new teacher.
  SELECT count(*) INTO n FROM section_subject_teachers
   WHERE section_id = '7c300000-0000-4000-8000-00000000ec0f'
     AND ended_on IS NULL AND teacher_id = '7c300000-0000-4000-8000-0000000000f3';
  IF n <> 1 THEN RAISE EXCEPTION 'FAIL: the incoming teacher has % open rows', n; END IF;

  RAISE NOTICE 'PASS replacement keeps the outgoing teacher, dates and reason';
END $$;
COMMIT;

-- ---------------------------------------------------------------------
-- 4. Two open rows for one subject are impossible.
-- ---------------------------------------------------------------------
BEGIN;
SET LOCAL app.tenant_id = '7c300000-0000-4000-8000-00000000000a';
SET LOCAL app.role      = 'principal';
SET LOCAL app.user_id   = '7c300000-0000-4000-8000-0000000000f1';

DO $$
DECLARE v_sub uuid;
BEGIN
  SELECT id INTO v_sub FROM subjects
   WHERE tenant_id = '7c300000-0000-4000-8000-00000000000a' ORDER BY name_bn LIMIT 1;
  BEGIN
    INSERT INTO section_subject_teachers
      (tenant_id, section_id, subject_id, teacher_id, academic_year_id, started_on)
    SELECT '7c300000-0000-4000-8000-00000000000a',
           '7c300000-0000-4000-8000-00000000ec0f', v_sub,
           '7c300000-0000-4000-8000-0000000000f2', ay.id, CURRENT_DATE
      FROM academic_years ay
     WHERE ay.tenant_id = '7c300000-0000-4000-8000-00000000000a' AND ay.is_current;
    RAISE EXCEPTION 'FAIL: a second open assignment was accepted';
  EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE 'PASS a subject cannot have two teachers at once';
  END;
END $$;
ROLLBACK;

-- ---------------------------------------------------------------------
-- 5. Re-assigning the same person is a no-op, not a zero-length stint.
--    (The double-submitted form.)
-- ---------------------------------------------------------------------
BEGIN;
SET LOCAL app.tenant_id = '7c300000-0000-4000-8000-00000000000a';
SET LOCAL app.role      = 'principal';
SET LOCAL app.user_id   = '7c300000-0000-4000-8000-0000000000f1';

SELECT app.assign_subject_teacher(
  :SEC_F,
  (SELECT id FROM subjects WHERE tenant_id = :T ORDER BY name_bn LIMIT 1),
  :KARIM, '2026-04-01'::date, 'ভুল করে আবার');

DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM section_subject_teachers
   WHERE section_id = '7c300000-0000-4000-8000-00000000ec0f';
  IF n <> 2 THEN
    RAISE EXCEPTION 'FAIL: re-assigning the same teacher wrote a row (% total)', n;
  END IF;
  RAISE NOTICE 'PASS re-assigning the same teacher changes nothing';
END $$;
COMMIT;

-- ---------------------------------------------------------------------
-- 6. sections.class_teacher_id follows the open class-teacher row.
-- ---------------------------------------------------------------------
BEGIN;
SET LOCAL app.tenant_id = '7c300000-0000-4000-8000-00000000000a';
SET LOCAL app.role      = 'principal';
SET LOCAL app.user_id   = '7c300000-0000-4000-8000-0000000000f1';

SELECT app.assign_class_teacher(:SEC_F, :RAHIM, '2026-01-05'::date, NULL);

DO $$
DECLARE v uuid;
BEGIN
  SELECT class_teacher_id INTO v FROM sections
   WHERE id = '7c300000-0000-4000-8000-00000000ec0f';
  IF v IS DISTINCT FROM '7c300000-0000-4000-8000-0000000000f2'::uuid THEN
    RAISE EXCEPTION 'FAIL: the section pointer did not follow the assignment (%)', v;
  END IF;
END $$;

SELECT app.assign_class_teacher(:SEC_F, :KARIM, '2026-06-01'::date, 'ছুটিতে');

DO $$
DECLARE v uuid; n integer;
BEGIN
  SELECT class_teacher_id INTO v FROM sections
   WHERE id = '7c300000-0000-4000-8000-00000000ec0f';
  IF v IS DISTINCT FROM '7c300000-0000-4000-8000-0000000000f3'::uuid THEN
    RAISE EXCEPTION 'FAIL: the pointer did not follow the replacement (%)', v;
  END IF;

  SELECT count(*) INTO n FROM class_teacher_assignments
   WHERE section_id = '7c300000-0000-4000-8000-00000000ec0f';
  IF n <> 2 THEN RAISE EXCEPTION 'FAIL: class-teacher history has % rows, expected 2', n; END IF;

  SELECT count(*) INTO n FROM class_teacher_assignments
   WHERE section_id = '7c300000-0000-4000-8000-00000000ec0f' AND ended_on IS NULL;
  IF n <> 1 THEN RAISE EXCEPTION 'FAIL: % open class-teacher rows', n; END IF;

  RAISE NOTICE 'PASS the section pointer tracks the open class-teacher row';
END $$;
COMMIT;

-- ---------------------------------------------------------------------
-- 7. A deactivated teacher's history survives them.
--    This is why deactivation is a status change and not a delete.
-- ---------------------------------------------------------------------
BEGIN;
SET LOCAL app.tenant_id = '7c300000-0000-4000-8000-00000000000a';
SET LOCAL app.role      = 'principal';
SET LOCAL app.user_id   = '7c300000-0000-4000-8000-0000000000f1';

UPDATE users SET status = 'left' WHERE id = :RAHIM;

DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM section_subject_teachers sst
    JOIN users u ON u.id = sst.teacher_id
   WHERE sst.teacher_id = '7c300000-0000-4000-8000-0000000000f2';
  IF n < 1 THEN
    RAISE EXCEPTION 'FAIL: deactivating a teacher lost their assignment history';
  END IF;
  RAISE NOTICE 'PASS a departed teacher remains attributable';
END $$;
ROLLBACK;

-- ---------------------------------------------------------------------
-- 8. TENANT ISOLATION — the other school sees none of this structure.
-- ---------------------------------------------------------------------
BEGIN;
SET LOCAL app.tenant_id = '7c300000-0000-4000-8000-00000000000b';
SET LOCAL app.role      = 'principal';
SET LOCAL app.user_id   = '7c300000-0000-4000-8000-0000000000e1';

DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM section_subject_teachers
   WHERE section_id = '7c300000-0000-4000-8000-00000000ec0f';
  IF n <> 0 THEN RAISE EXCEPTION 'FAIL: tenant B sees % of A''s assignments', n; END IF;

  SELECT count(*) INTO n FROM class_teacher_assignments;
  IF n <> 0 THEN RAISE EXCEPTION 'FAIL: tenant B sees % of A''s class-teacher rows', n; END IF;

  -- Even naming A's section id directly.
  SELECT count(*) INTO n FROM sections
   WHERE id = '7c300000-0000-4000-8000-00000000ec0f';
  IF n <> 0 THEN RAISE EXCEPTION 'FAIL: tenant B can see A''s section by id'; END IF;

  SELECT count(*) INTO n FROM users
   WHERE id = '7c300000-0000-4000-8000-0000000000f2';
  IF n <> 0 THEN RAISE EXCEPTION 'FAIL: tenant B can see A''s teacher by id'; END IF;

  SELECT count(*) INTO n FROM enrolments
   WHERE student_id = '7c300000-0000-4000-8000-0000000000a1';
  IF n <> 0 THEN RAISE EXCEPTION 'FAIL: tenant B can see A''s student enrolment'; END IF;

  RAISE NOTICE 'PASS tenant B sees none of tenant A''s structure';
END $$;
COMMIT;

-- ---------------------------------------------------------------------
-- 9. Tenant B cannot ASSIGN into tenant A, even naming real ids.
--    Reading nothing is necessary; writing nothing is the point.
-- ---------------------------------------------------------------------
BEGIN;
SET LOCAL app.tenant_id = '7c300000-0000-4000-8000-00000000000b';
SET LOCAL app.role      = 'principal';
SET LOCAL app.user_id   = '7c300000-0000-4000-8000-0000000000e1';

DO $$
BEGIN
  BEGIN
    PERFORM app.assign_class_teacher(
      '7c300000-0000-4000-8000-00000000ec0f'::uuid,
      '7c300000-0000-4000-8000-0000000000f3'::uuid,
      CURRENT_DATE, 'takeover');
    RAISE EXCEPTION 'FAIL: tenant B assigned a teacher inside tenant A';
  EXCEPTION
    WHEN no_data_found THEN
      -- The section is invisible, so it does not exist. Exactly right:
      -- indistinguishable from a typo, which is what it should look like.
      RAISE NOTICE 'PASS tenant B cannot assign into tenant A';
    WHEN insufficient_privilege OR check_violation THEN
      RAISE NOTICE 'PASS tenant B cannot assign into tenant A (refused)';
  END;
END $$;
ROLLBACK;

-- ---------------------------------------------------------------------
-- 10. The audit log is tenant-scoped and management-only.
-- ---------------------------------------------------------------------
BEGIN;
SET LOCAL app.tenant_id = '7c300000-0000-4000-8000-00000000000a';
SET LOCAL app.role      = 'principal';
SET LOCAL app.user_id   = '7c300000-0000-4000-8000-0000000000f1';

INSERT INTO audit.activity_log
  (tenant_id, actor_id, actor_role, action, entity_type, entity_id)
VALUES (:T, :HEAD, 'principal', 'academic.class_teacher.assign', 'section', :SEC_F);

DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM audit.activity_log
   WHERE action = 'academic.class_teacher.assign';
  IF n < 1 THEN RAISE EXCEPTION 'FAIL: the principal cannot read the audit log'; END IF;
  RAISE NOTICE 'PASS management reads its own audit trail';
END $$;
COMMIT;

BEGIN;
SET LOCAL app.tenant_id = '7c300000-0000-4000-8000-00000000000a';
SET LOCAL app.role      = 'subject_teacher';
SET LOCAL app.user_id   = '7c300000-0000-4000-8000-0000000000f3';

DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM audit.activity_log;
  IF n <> 0 THEN
    RAISE EXCEPTION 'FAIL: a subject teacher read % audit row(s)', n;
  END IF;
  RAISE NOTICE 'PASS a teacher cannot read the institution''s audit trail';
END $$;
COMMIT;

BEGIN;
SET LOCAL app.tenant_id = '7c300000-0000-4000-8000-00000000000b';
SET LOCAL app.role      = 'principal';
SET LOCAL app.user_id   = '7c300000-0000-4000-8000-0000000000e1';

DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM audit.activity_log;
  IF n <> 0 THEN
    RAISE EXCEPTION 'FAIL: tenant B read % of tenant A''s audit rows', n;
  END IF;
  RAISE NOTICE 'PASS the audit trail does not cross tenants';
END $$;
COMMIT;

-- ---------------------------------------------------------------------
-- Teardown. The suite must be re-runnable and leave nothing behind, or CI
-- cannot run it twice.
-- ---------------------------------------------------------------------
-- The application role cannot DELETE from the audit log — 010 revokes it and
-- 041 deliberately does not restore it, because a trail its subject can edit
-- is decoration. So the fixture's audit rows are cleared as the owner, which
-- is also an assertion in its own right: had `SET ROLE shikhon_app` been able
-- to run this, the revoke would be broken.
RESET ROLE;
DELETE FROM audit.activity_log WHERE tenant_id IN
  ('7c300000-0000-4000-8000-00000000000a', '7c300000-0000-4000-8000-00000000000b');
-- activity_log.tenant_id carries no FK (an audit row must outlive its
-- subject), so it would not have been cleaned up by the cascade below.
DELETE FROM tenants WHERE id IN
  ('7c300000-0000-4000-8000-00000000000a', '7c300000-0000-4000-8000-00000000000b');

DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM tenants WHERE slug IN ('r3-assign', 'r3-other');
  IF n <> 0 THEN RAISE EXCEPTION 'FAIL: teardown left % tenant row(s)', n; END IF;
  RAISE NOTICE 'PASS teardown — no fixture rows remain';
END $$;

SELECT 'R-3 assignment history, isolation and audit passed.' AS result;
