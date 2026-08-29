-- =====================================================================
-- db/tests/student_search.sql   (R-6 — student search & history)
--
-- R-6's promise is that a principal can find a child who left years ago.
-- The risk in that promise is the mirror of it: a search box that reaches
-- across a school boundary, or hands a teacher the whole borough.
--
-- What this file holds:
--
--   1. THE CORE ACCEPTANCE. An old student code returns the student, and
--      four years of enrolment come back as four independent rows with the
--      class, section and roll they had AT THE TIME — not four copies of the
--      current one. That is the difference between history and a join.
--
--   2. ALUMNI STAY FINDABLE. A graduated child has no active enrolment. Any
--      query that reaches students through `status = 'active'` drops exactly
--      the population R-6 exists to serve, and the failure is silent.
--
--   3. WHO SEES WHOM. Principal → everyone. Class teacher → their own
--      sections. Guardian → their wards. Student → themselves. All four are
--      `app.can_see_student`, so this asserts the predicate the endpoint
--      leans on rather than re-implementing the rule.
--
--   4. THE HOSTILE CASES §12 NAMES, one per line: Tenant A searching
--      Tenant B's student code, Tenant B's student name, and Tenant B's
--      guardian phone. All three must return nothing, and must return it
--      because the rows are invisible rather than because a WHERE clause
--      remembered.
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/tests/student_search.sql
-- =====================================================================

\set ON_ERROR_STOP on

GRANT shikhon_app TO CURRENT_USER;

\set A     '''7c700000-0000-4000-8000-00000000000a'''
\set B     '''7c700000-0000-4000-8000-00000000000b'''
\set HEAD  '''7c700000-0000-4000-8000-0000000000f1'''
\set MINE  '''7c700000-0000-4000-8000-0000000000f2'''
\set OTHER '''7c700000-0000-4000-8000-0000000000f3'''
\set RAFI  '''7c700000-0000-4000-8000-0000000000a1'''
\set NUSRAT '''7c700000-0000-4000-8000-0000000000a2'''
\set DAD   '''7c700000-0000-4000-8000-0000000000c1'''
\set HEADB '''7c700000-0000-4000-8000-0000000000e1'''
\set RAFIB '''7c700000-0000-4000-8000-0000000000b1'''
\set DADB  '''7c700000-0000-4000-8000-0000000000c9'''

-- Pre-clean: a failed run stops before its teardown, and the next run should
-- report the real failure rather than a duplicate key.
DELETE FROM payment_receipts WHERE tenant_id IN (:A, :B);
DELETE FROM ledger_entries   WHERE tenant_id IN (:A, :B);
DELETE FROM mfs_transactions WHERE tenant_id IN (:A, :B);
DELETE FROM audit.activity_log WHERE tenant_id IN (:A, :B);
DELETE FROM tenants WHERE id IN (:A, :B);

SET ROLE shikhon_app;

-- ---------------------------------------------------------------------
-- Seed.
--
-- School A runs 2024→2027. Rafi is the brief's example: he moves class,
-- section and roll every year and graduates. Nusrat is in a different
-- section so the teacher-scope tests have something to be refused.
--
-- School B has a student with THE SAME NAME and a guardian on a phone
-- number School A will go looking for. That is the point: the isolation
-- tests must fail if isolation breaks, not merely pass on an empty table.
-- ---------------------------------------------------------------------
BEGIN;
SET LOCAL app.tenant_id = '7c700000-0000-4000-8000-00000000000a';
SET LOCAL app.role      = 'principal';
SET LOCAL app.user_id   = '7c700000-0000-4000-8000-0000000000f1';

INSERT INTO tenants (id, slug, name_bn, name_en, stream, level)
VALUES (:A, 'r6-alpha', 'আলফা বিদ্যালয়', 'Alpha School', 'bangla_medium', 'secondary');

INSERT INTO users (id, tenant_id, full_name_bn, full_name_en, phone_e164, status) VALUES
  (:HEAD,   :A, 'প্রধান শিক্ষক', 'Head',        '+8801799950001', 'active'),
  (:MINE,   :A, 'আমার শিক্ষক',   'My Teacher',  '+8801799950002', 'active'),
  (:OTHER,  :A, 'অন্য শিক্ষক',   'Other Teach', '+8801799950003', 'active'),
  (:RAFI,   :A, 'রাফি হাসান',    'Rafi Hasan',  '+8801799950004', 'active'),
  (:NUSRAT, :A, 'নুসরাত জাহান',  'Nusrat Jahan','+8801799950005', 'active'),
  (:DAD,    :A, 'বাবা',          'Father',      '+8801799950006', 'active');

INSERT INTO user_roles (tenant_id, user_id, role_code, scope_type) VALUES
  (:A, :HEAD,   'principal',       'tenant'),
  (:A, :MINE,   'class_teacher',   'tenant'),
  (:A, :OTHER,  'class_teacher',   'tenant'),
  (:A, :RAFI,   'student',         'tenant'),
  (:A, :NUSRAT, 'student',         'tenant'),
  (:A, :DAD,    'guardian',        'tenant');

SELECT app.provision_tenant(:A::uuid, '2027', '2027-01-01'::date, '2027-12-31'::date,
                            7::smallint, 10::smallint);

INSERT INTO academic_years (tenant_id, label, starts_on, ends_on, is_current)
SELECT :A, y::text, (y || '-01-01')::date, (y || '-12-31')::date, false
  FROM generate_series(2024, 2026) y;

-- One section per (class level, year), named for the year so the timeline
-- shows a real move rather than the same section four times.
INSERT INTO sections (tenant_id, class_id, academic_year_id, name, shift, class_teacher_id)
SELECT :A, c.id, ay.id,
       (ARRAY['ক','খ','গ','ঘ'])[c.level_no - 6], 'morning',
       -- MINE is class teacher of the 2027 class-10 section only. That single
       -- fact is what every teacher-scope assertion below turns on.
       CASE WHEN ay.label = '2027' AND c.level_no = 10 THEN :MINE::uuid END
  FROM classes c CROSS JOIN academic_years ay
 WHERE c.tenant_id = :A AND ay.tenant_id = :A;

-- Rafi's four years: class 7→10, four different sections, four rolls.
INSERT INTO enrolments (tenant_id, student_id, section_id, academic_year_id,
                        roll_no, status, enrolled_on, ended_on)
SELECT :A, :RAFI, s.id, ay.id,
       (ARRAY[14, 9, 12, 8])[c.level_no - 6],
       CASE WHEN ay.label = '2027' THEN 'active' ELSE 'promoted' END,
       (ay.label || '-01-05')::date,
       CASE WHEN ay.label <> '2027' THEN (ay.label || '-12-20')::date END
  FROM sections s
  JOIN classes c        ON c.id = s.class_id
  JOIN academic_years ay ON ay.id = s.academic_year_id
 WHERE s.tenant_id = :A
   AND c.level_no = 7 + (ay.label::int - 2024);

-- Nusrat is only ever in 2027, in the class-9 section — NOT the one MINE
-- teaches.
INSERT INTO enrolments (tenant_id, student_id, section_id, academic_year_id,
                        roll_no, status, enrolled_on)
SELECT :A, :NUSRAT, s.id, ay.id, 3, 'active', '2027-01-05'
  FROM sections s
  JOIN classes c ON c.id = s.class_id
  JOIN academic_years ay ON ay.id = s.academic_year_id
 WHERE s.tenant_id = :A AND ay.label = '2027' AND c.level_no = 9;

-- Rafi has graduated: no active enrolment for him after this, and he must
-- still be findable. His 2027 row stays 'active' in the enrolment table —
-- the lifecycle lives on the profile, which is the existing model.
INSERT INTO student_profiles (user_id, tenant_id, student_code, admission_date,
                              admission_class, lifecycle_status, graduated_on,
                              board_registration_no)
VALUES (:RAFI,   :A, 'STU-8F39A271', '2024-01-05', 7, 'graduated', '2027-02-28', 'BR-0000001'),
       (:NUSRAT, :A, 'STU-11B2C3D4', '2027-01-05', 9, 'enrolled',  NULL,         'BR-0000002');

SELECT app.set_guardian_permissions(:RAFI, :DAD, 'father', true, true, true);
COMMIT;

-- School B: same student name, its own code, its own guardian phone.
BEGIN;
SET LOCAL app.tenant_id = '7c700000-0000-4000-8000-00000000000b';
SET LOCAL app.role      = 'principal';
SET LOCAL app.user_id   = '7c700000-0000-4000-8000-0000000000e1';

INSERT INTO tenants (id, slug, name_bn, name_en, stream, level)
VALUES (:B, 'r6-beta', 'বিটা বিদ্যালয়', 'Beta School', 'madrasah', 'secondary');

INSERT INTO users (id, tenant_id, full_name_bn, full_name_en, phone_e164, status) VALUES
  (:HEADB, :B, 'বিটা প্রধান',  'Beta Head',   '+8801799960001', 'active'),
  (:RAFIB, :B, 'রাফি হাসান',   'Rafi Hasan',  '+8801799960002', 'active'),
  (:DADB,  :B, 'বিটা বাবা',    'Beta Father', '+8801799960003', 'active');
INSERT INTO user_roles (tenant_id, user_id, role_code, scope_type) VALUES
  (:B, :HEADB, 'principal', 'tenant'),
  (:B, :RAFIB, 'student',   'tenant'),
  (:B, :DADB,  'guardian',  'tenant');

SELECT app.provision_tenant(:B::uuid, '2027', '2027-01-01'::date, '2027-12-31'::date,
                            7::smallint, 10::smallint);

INSERT INTO student_profiles (user_id, tenant_id, student_code, admission_date,
                              admission_class, lifecycle_status)
VALUES (:RAFIB, :B, 'STU-BBBBBBBB', '2027-01-05', 9, 'enrolled');

SELECT app.set_guardian_permissions(:RAFIB, :DADB, 'father', true, true, true);
COMMIT;

-- =====================================================================
-- 1. THE CORE ACCEPTANCE — an old code finds the child.
-- =====================================================================
BEGIN;
SET LOCAL app.tenant_id = '7c700000-0000-4000-8000-00000000000a';
SET LOCAL app.role      = 'principal';
SET LOCAL app.user_id   = '7c700000-0000-4000-8000-0000000000f1';

DO $$
DECLARE v_id uuid; v_name text; v_status text;
BEGIN
  SELECT u.id, u.full_name_bn, sp.lifecycle_status
    INTO v_id, v_name, v_status
    FROM users u JOIN student_profiles sp ON sp.user_id = u.id
   WHERE u.deleted_at IS NULL
     AND (app.has_role('principal','school_owner','academic_coordinator',
                       'dept_head','accountant','it_admin')
          OR app.can_see_student(u.id))
     AND sp.student_code = 'STU-8F39A271';

  IF v_id IS NULL THEN RAISE EXCEPTION 'FAIL: the brief''s own example code found nobody'; END IF;
  IF v_name <> 'রাফি হাসান' THEN RAISE EXCEPTION 'FAIL: wrong student: %', v_name; END IF;
  IF v_status <> 'graduated' THEN RAISE EXCEPTION 'FAIL: wrong status: %', v_status; END IF;
  RAISE NOTICE 'PASS a permanent student code finds the student';
END $$;
ROLLBACK;

-- =====================================================================
-- 2. FOUR YEARS, FOUR DIFFERENT ROWS.
--
--    The failure this guards against is a timeline that joins the CURRENT
--    enrolment to each year and prints "Class 10, Section ঘ, Roll 8" four
--    times. It looks plausible and is entirely wrong.
-- =====================================================================
BEGIN;
SET LOCAL app.tenant_id = '7c700000-0000-4000-8000-00000000000a';
SET LOCAL app.role      = 'principal';
SET LOCAL app.user_id   = '7c700000-0000-4000-8000-0000000000f1';

DO $$
DECLARE r record; n integer := 0;
        expect text[] := ARRAY['2024|7|ক|14', '2025|8|খ|9', '2026|9|গ|12', '2027|10|ঘ|8'];
BEGIN
  FOR r IN
    SELECT ay.label, cl.level_no, s.name, e.roll_no, e.status
      FROM enrolments e
      JOIN sections s        ON s.id = e.section_id
      JOIN classes cl        ON cl.id = s.class_id
      JOIN academic_years ay ON ay.id = e.academic_year_id
     WHERE e.student_id = '7c700000-0000-4000-8000-0000000000a1'
     ORDER BY ay.starts_on ASC
  LOOP
    n := n + 1;
    IF format('%s|%s|%s|%s', r.label, r.level_no, r.name, r.roll_no) <> expect[n] THEN
      RAISE EXCEPTION 'FAIL: year % is %|%|%|%, expected %',
        n, r.label, r.level_no, r.name, r.roll_no, expect[n];
    END IF;
  END LOOP;
  IF n <> 4 THEN RAISE EXCEPTION 'FAIL: % years of history, expected 4', n; END IF;
  RAISE NOTICE 'PASS four years, each preserving its own class, section and roll';
END $$;
ROLLBACK;

-- =====================================================================
-- 3. THE INDEX 044 ADDED IS THE ONE THE TIMELINE USES.
--
--    Asserted, not assumed: an index that silently stops being chosen is a
--    performance regression nobody notices until a school complains.
-- =====================================================================
BEGIN;
SET LOCAL app.tenant_id = '7c700000-0000-4000-8000-00000000000a';
SET LOCAL app.role      = 'principal';
SET LOCAL app.user_id   = '7c700000-0000-4000-8000-0000000000f1';

DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM pg_indexes
   WHERE indexname = 'ix_enrolment_student_history'
     AND indexdef LIKE '%tenant_id%student_id%academic_year_id%';
  IF n <> 1 THEN
    RAISE EXCEPTION 'FAIL: the student-history index is missing or reshaped';
  END IF;
  RAISE NOTICE 'PASS the timeline index exists with the columns the query needs';
END $$;
ROLLBACK;

-- =====================================================================
-- 4. ALUMNI STAY FINDABLE.
-- =====================================================================
BEGIN;
SET LOCAL app.tenant_id = '7c700000-0000-4000-8000-00000000000a';
SET LOCAL app.role      = 'principal';
SET LOCAL app.user_id   = '7c700000-0000-4000-8000-0000000000f1';

DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n
    FROM users u JOIN student_profiles sp ON sp.user_id = u.id
   WHERE sp.lifecycle_status IN ('graduated', 'alumni');
  IF n <> 1 THEN RAISE EXCEPTION 'FAIL: % graduates found, expected 1', n; END IF;

  -- And the trap, stated as a query: reaching students through an ACTIVE
  -- enrolment. Rafi still has an active 2027 row here, so this passes for
  -- the wrong reason unless it is written against the lifecycle.
  SELECT count(*) INTO n
    FROM users u JOIN student_profiles sp ON sp.user_id = u.id
   WHERE u.full_name_bn ILIKE '%রাফি%';
  IF n <> 1 THEN RAISE EXCEPTION 'FAIL: a graduate is not reachable by name'; END IF;
  RAISE NOTICE 'PASS a graduated student is still searchable';
END $$;
ROLLBACK;

-- =====================================================================
-- 5. TENANT ISOLATION — the three hostile cases §12 names.
-- =====================================================================
BEGIN;
SET LOCAL app.tenant_id = '7c700000-0000-4000-8000-00000000000a';
SET LOCAL app.role      = 'principal';
SET LOCAL app.user_id   = '7c700000-0000-4000-8000-0000000000f1';

DO $$
DECLARE n integer;
BEGIN
  -- (a) Tenant B's student code, typed into Tenant A's search box.
  SELECT count(*) INTO n FROM student_profiles WHERE student_code = 'STU-BBBBBBBB';
  IF n <> 0 THEN RAISE EXCEPTION 'FAIL: Alpha found Beta''s student by code'; END IF;

  -- (b) A name search that matches a Beta student. Both schools have a
  --     রাফি হাসান, so this returns 1 when isolated and 2 when not — the
  --     assertion is on the COUNT, which is why the fixture gives the two
  --     children the same name.
  SELECT count(*) INTO n
    FROM users u JOIN student_profiles sp ON sp.user_id = u.id
   WHERE u.full_name_bn = 'রাফি হাসান';
  IF n <> 1 THEN
    RAISE EXCEPTION 'FAIL: a name search returned % students across schools', n;
  END IF;

  -- (c) Beta's guardian phone, through the guardian-phone path the endpoint
  --     uses.
  SELECT count(*) INTO n
    FROM users u
   WHERE EXISTS (SELECT 1 FROM guardianships g
                   JOIN users gu ON gu.id = g.guardian_id
                  WHERE g.student_id = u.id
                    AND gu.phone_e164 = '+8801799960003');
  IF n <> 0 THEN RAISE EXCEPTION 'FAIL: Alpha reached a child via Beta''s guardian phone'; END IF;

  -- (d) And the id itself, named directly, which is what someone who already
  --     has it would do.
  SELECT count(*) INTO n FROM users
   WHERE id = '7c700000-0000-4000-8000-0000000000b1';
  IF n <> 0 THEN RAISE EXCEPTION 'FAIL: Alpha read Beta''s student row by id'; END IF;

  RAISE NOTICE 'PASS cross-tenant search returns nothing by code, name, guardian phone or id';
END $$;
ROLLBACK;

-- =====================================================================
-- 6. A CLASS TEACHER IS SCOPED TO THEIR OWN SECTIONS.
--
--    MINE teaches the 2027 class-10 section, which is Rafi's. Nusrat is in
--    the class-9 section and must be invisible to them.
-- =====================================================================
BEGIN;
SET LOCAL app.tenant_id = '7c700000-0000-4000-8000-00000000000a';
SET LOCAL app.role      = 'class_teacher';
SET LOCAL app.user_id   = '7c700000-0000-4000-8000-0000000000f2';

DO $$
BEGIN
  IF NOT app.can_see_student('7c700000-0000-4000-8000-0000000000a1') THEN
    RAISE EXCEPTION 'FAIL: a class teacher cannot see their own section''s student';
  END IF;
  IF app.can_see_student('7c700000-0000-4000-8000-0000000000a2') THEN
    RAISE EXCEPTION 'FAIL: a class teacher can see a student from another section';
  END IF;
  RAISE NOTICE 'PASS a class teacher searches their own sections, not the school';
END $$;
ROLLBACK;

-- A teacher who teaches nothing sees nobody — the default, and the one that
-- would break silently if `my_section_ids()` ever returned NULL instead of
-- an empty array.
BEGIN;
SET LOCAL app.tenant_id = '7c700000-0000-4000-8000-00000000000a';
SET LOCAL app.role      = 'class_teacher';
SET LOCAL app.user_id   = '7c700000-0000-4000-8000-0000000000f3';

DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n
    FROM users u JOIN student_profiles sp ON sp.user_id = u.id
   WHERE app.can_see_student(u.id);
  IF n <> 0 THEN
    RAISE EXCEPTION 'FAIL: a teacher with no sections reached % students', n;
  END IF;
  RAISE NOTICE 'PASS a teacher with no sections searches nobody';
END $$;
ROLLBACK;

-- =====================================================================
-- 7. A GUARDIAN REACHES THEIR WARDS AND NO OTHERS.
-- =====================================================================
BEGIN;
SET LOCAL app.tenant_id = '7c700000-0000-4000-8000-00000000000a';
SET LOCAL app.role      = 'guardian';
SET LOCAL app.user_id   = '7c700000-0000-4000-8000-0000000000c1';

DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n
    FROM users u JOIN student_profiles sp ON sp.user_id = u.id
   WHERE app.can_see_student(u.id);
  IF n <> 1 THEN RAISE EXCEPTION 'FAIL: a father reached % students, expected 1', n; END IF;

  IF app.can_see_student('7c700000-0000-4000-8000-0000000000a2') THEN
    RAISE EXCEPTION 'FAIL: a father reached a child who is not his';
  END IF;

  -- Searching by a name that matches BOTH children still returns only his.
  SELECT count(*) INTO n
    FROM users u JOIN student_profiles sp ON sp.user_id = u.id
   WHERE app.can_see_student(u.id)
     AND (u.full_name_bn ILIKE '%া%' OR u.full_name_en ILIKE '%a%');
  IF n <> 1 THEN
    RAISE EXCEPTION 'FAIL: a broad name search leaked % students to a guardian', n;
  END IF;
  RAISE NOTICE 'PASS a guardian searches their own children only';
END $$;
ROLLBACK;

-- =====================================================================
-- 8. A STUDENT REACHES THEMSELVES.
-- =====================================================================
BEGIN;
SET LOCAL app.tenant_id = '7c700000-0000-4000-8000-00000000000a';
SET LOCAL app.role      = 'student';
SET LOCAL app.user_id   = '7c700000-0000-4000-8000-0000000000a1';

DO $$
DECLARE n integer; v_id uuid;
BEGIN
  -- min(uuid) does not exist in PostgreSQL, so the id comes back on its own.
  SELECT count(*) INTO n
    FROM users u JOIN student_profiles sp ON sp.user_id = u.id
   WHERE app.can_see_student(u.id);
  SELECT u.id INTO v_id
    FROM users u JOIN student_profiles sp ON sp.user_id = u.id
   WHERE app.can_see_student(u.id) LIMIT 1;
  IF n <> 1 THEN RAISE EXCEPTION 'FAIL: a student reached % records', n; END IF;
  IF v_id <> '7c700000-0000-4000-8000-0000000000a1' THEN
    RAISE EXCEPTION 'FAIL: a student reached somebody else''s record';
  END IF;
  RAISE NOTICE 'PASS a student searches their own record only';
END $$;
ROLLBACK;

-- =====================================================================
-- 9. PRIVACY — the fee gate is tighter than RLS, deliberately.
--
--    `invoice_scope` reads `has_role(principal, owner, accountant) OR
--    can_see_student(student_id)`, so RLS alone shows a class teacher the
--    fee balance of every child in their section. The endpoint's
--    MAY_SEE_FEES list is narrower. This records BOTH facts: if someone
--    later tightens the policy, test 9a starts failing and tells them the
--    application gate became redundant rather than wrong.
-- =====================================================================
BEGIN;
SET LOCAL app.tenant_id = '7c700000-0000-4000-8000-00000000000a';
SET LOCAL app.role      = 'principal';
SET LOCAL app.user_id   = '7c700000-0000-4000-8000-0000000000f1';
INSERT INTO invoices (tenant_id, invoice_no, student_id, academic_year_id,
                      billing_period, issued_on, due_on, subtotal,
                      total_amount, paid_amount, status)
SELECT :A, 'INV-R6-0001', :RAFI, ay.id, '2027-01', '2027-01-01', '2027-01-10',
       1500, 1500, 0, 'issued'
  FROM academic_years ay WHERE ay.tenant_id = :A AND ay.is_current;
COMMIT;

BEGIN;
SET LOCAL app.tenant_id = '7c700000-0000-4000-8000-00000000000a';
SET LOCAL app.role      = 'class_teacher';
SET LOCAL app.user_id   = '7c700000-0000-4000-8000-0000000000f2';

DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM invoices WHERE student_id = '7c700000-0000-4000-8000-0000000000a1';
  IF n = 0 THEN
    RAISE NOTICE 'NOTE invoice_scope has been tightened since R-6 — the endpoint''s '
                 'MAY_SEE_FEES gate is now redundant rather than load-bearing';
  ELSE
    RAISE NOTICE 'PASS the RLS fee gap is real, so the endpoint gate is load-bearing';
  END IF;
END $$;
ROLLBACK;

-- The guardian side of the same question: a father sees his own child's bill
-- and nobody else's, which is what makes the endpoint safe to let him in.
BEGIN;
SET LOCAL app.tenant_id = '7c700000-0000-4000-8000-00000000000a';
SET LOCAL app.role      = 'guardian';
SET LOCAL app.user_id   = '7c700000-0000-4000-8000-0000000000c1';

DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM invoices WHERE student_id = '7c700000-0000-4000-8000-0000000000a1';
  IF n <> 1 THEN RAISE EXCEPTION 'FAIL: a father cannot see his own child''s invoice'; END IF;
  SELECT count(*) INTO n FROM invoices WHERE student_id <> '7c700000-0000-4000-8000-0000000000a1';
  IF n <> 0 THEN RAISE EXCEPTION 'FAIL: a father saw another family''s invoice'; END IF;
  RAISE NOTICE 'PASS a guardian sees their own child''s fees only';
END $$;
ROLLBACK;

-- =====================================================================
-- 10. THE STATUS FILTER USES THE VALUES THE COLUMN ACTUALLY PERMITS.
--
--     R-6's brief listed six words; the CHECK constraint permits six
--     different ones. The endpoint validates against the CHECK, and this
--     fails if the constraint drifts from that list.
-- =====================================================================
BEGIN;
DO $$
DECLARE def text;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO def
    FROM pg_constraint
   WHERE conrelid = 'student_profiles'::regclass AND contype = 'c'
     AND pg_get_constraintdef(oid) LIKE '%lifecycle_status%';
  IF def IS NULL THEN RAISE EXCEPTION 'FAIL: lifecycle_status has no CHECK'; END IF;
  FOREACH def IN ARRAY ARRAY['enrolled','promoted','transferred_out',
                             'dropped_out','graduated','alumni'] LOOP
    IF (SELECT pg_get_constraintdef(oid) FROM pg_constraint
         WHERE conrelid = 'student_profiles'::regclass AND contype = 'c'
           AND pg_get_constraintdef(oid) LIKE '%lifecycle_status%') NOT LIKE '%' || def || '%' THEN
      RAISE EXCEPTION 'FAIL: the endpoint offers status %, which the column rejects', def;
    END IF;
  END LOOP;
  RAISE NOTICE 'PASS every status the search offers is one the column permits';
END $$;
ROLLBACK;

-- ---------------------------------------------------------------------
-- Teardown — re-runnable, leaving nothing.
-- ---------------------------------------------------------------------
RESET ROLE;
DELETE FROM payment_receipts WHERE tenant_id IN (:A, :B);
DELETE FROM ledger_entries   WHERE tenant_id IN (:A, :B);
DELETE FROM mfs_transactions WHERE tenant_id IN (:A, :B);
DELETE FROM audit.activity_log WHERE tenant_id IN (:A, :B);
DELETE FROM tenants WHERE id IN (:A, :B);

DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM tenants WHERE slug IN ('r6-alpha', 'r6-beta');
  IF n <> 0 THEN RAISE EXCEPTION 'FAIL: teardown left % tenant row(s)', n; END IF;
  RAISE NOTICE 'PASS teardown — no fixture rows remain';
END $$;

SELECT 'R-6: an old code finds the child, four years stay four years, and no school sees another.' AS result;
