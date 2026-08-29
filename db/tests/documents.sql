-- =====================================================================
-- db/tests/documents.sql   (R-5 — branded print / document engine)
--
-- The document engine renders HTML, and HTML is easy to test in Node. What
-- Node cannot test is the half that matters most: WHICH ROWS a session can
-- reach. `packages/ui-core/test/documents.test.ts` proves that two brandings
-- never mix in the markup. This file proves the database never hands the
-- markup the wrong data in the first place.
--
-- Four things it holds:
--
--   1. THE TENANT IS NOT A PARAMETER. The endpoint's branding query is
--      `SELECT settings->'branding' FROM tenants` with no WHERE clause. That
--      is only safe if a session sees exactly one tenants row. Asserted
--      literally, with the endpoint's own SQL.
--
--   2. INVISIBLE AND ABSENT ARE THE SAME ANSWER. A receipt id from another
--      school must return nothing, so a 404 cannot be used to discover that
--      the id exists somewhere.
--
--   3. WHY `app.can_see_student` IS IN loadStudents. `users_scope` ends with
--      `OR app.is_staff()`, because the staff directory is visible to staff.
--      That means a subject teacher CAN read a foreign student's name, date
--      of birth and parents' names. Reading a name in a directory and
--      printing a letterheaded admit card for a child you do not teach are
--      different acts, so the document endpoint is deliberately tighter than
--      the directory. Test 5 proves the hole is real and test 6 proves the
--      guard closes it — if someone later deletes that line as redundant,
--      test 5 tells them why it is not.
--
--   4. BULK CANNOT CROSS A SECTION OR A TENANT. "Generate for the whole
--      section" resolves the roster server-side; the roster of a section
--      that is not yours is empty.
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/tests/documents.sql
-- =====================================================================

\set ON_ERROR_STOP on

GRANT shikhon_app TO CURRENT_USER;

\set A    '''7c500000-0000-4000-8000-00000000000a'''
\set B    '''7c500000-0000-4000-8000-00000000000b'''
\set HEAD    '''7c500000-0000-4000-8000-0000000000f1'''
\set MINE    '''7c500000-0000-4000-8000-0000000000f2'''
\set THEIRS  '''7c500000-0000-4000-8000-0000000000f3'''
\set STU1    '''7c500000-0000-4000-8000-0000000000a1'''
\set STU2    '''7c500000-0000-4000-8000-0000000000a2'''
\set DAD     '''7c500000-0000-4000-8000-0000000000c1'''
\set SEC1    '''7c500000-0000-4000-8000-00000000ec01'''
\set SEC2    '''7c500000-0000-4000-8000-00000000ec02'''
\set INV     '''7c500000-0000-4000-8000-00000000d001'''
\set HEADB   '''7c500000-0000-4000-8000-0000000000e1'''
\set STUB    '''7c500000-0000-4000-8000-0000000000b1'''

-- Pre-clean, not just teardown. A run that fails an assertion stops before
-- its teardown, and the next run then dies on a duplicate key with an error
-- that says nothing about the real failure. Clearing first means the second
-- run reports the actual problem.
-- Money rows hold the tenant row down: ledger_entries, mfs_transactions and
-- payment_receipts are ON DELETE RESTRICT, deliberately, so a school's
-- financial history cannot be erased by deleting the school. A fixture has to
-- clear them by hand, and a teardown that forgets fails loudly rather than
-- leaving a half-deleted tenant behind.
DELETE FROM payment_receipts WHERE tenant_id IN (:A, :B);
DELETE FROM ledger_entries   WHERE tenant_id IN (:A, :B);
DELETE FROM mfs_transactions WHERE tenant_id IN (:A, :B);
DELETE FROM audit.activity_log WHERE tenant_id IN (:A, :B);
DELETE FROM tenants WHERE id IN (:A, :B);

SET ROLE shikhon_app;

-- ---------------------------------------------------------------------
-- Seed — two schools, because one school cannot demonstrate isolation.
--
-- School A: a head, two teachers, two students in two sections, one father.
--   MINE teaches section 1. THEIRS teaches section 2. STU1 is in section 1
--   and is DAD's child. STU2 is in section 2 and is not.
-- School B: a head and a student, and a fee receipt of its own.
-- ---------------------------------------------------------------------
BEGIN;
SET LOCAL app.tenant_id = '7c500000-0000-4000-8000-00000000000a';
SET LOCAL app.role      = 'principal';
SET LOCAL app.user_id   = '7c500000-0000-4000-8000-0000000000f1';

-- Two brandings that could not be confused for one another.
INSERT INTO tenants (id, slug, name_bn, name_en, stream, level, settings)
VALUES (:A, 'r5-alpha', 'আলফা উচ্চ বিদ্যালয়', 'Alpha High School',
        'bangla_medium', 'secondary',
        jsonb_build_object('branding', jsonb_build_object(
          'nameBn', 'আলফা উচ্চ বিদ্যালয়',
          'primaryColor', '#1B5E20',
          'headmasterName', 'আলফা প্রধান শিক্ষক')));

INSERT INTO users (id, tenant_id, full_name_bn, full_name_en, phone_e164, status) VALUES
  (:HEAD,   :A, 'প্রধান',       'Head',        '+8801799850001', 'active'),
  (:MINE,   :A, 'আমার শিক্ষক',  'My Teacher',  '+8801799850002', 'active'),
  (:THEIRS, :A, 'অন্য শিক্ষক',  'Other Teach', '+8801799850003', 'active'),
  (:STU1,   :A, 'প্রথম ছাত্র',  'Student One', '+8801799850004', 'active'),
  (:STU2,   :A, 'দ্বিতীয় ছাত্র','Student Two', '+8801799850005', 'active'),
  (:DAD,    :A, 'বাবা',         'Father',      '+8801799850006', 'active');

INSERT INTO user_roles (tenant_id, user_id, role_code, scope_type) VALUES
  (:A, :HEAD,   'principal',       'tenant'),
  (:A, :MINE,   'subject_teacher', 'tenant'),
  (:A, :THEIRS, 'subject_teacher', 'tenant'),
  (:A, :STU1,   'student',         'tenant'),
  (:A, :STU2,   'student',         'tenant'),
  (:A, :DAD,    'guardian',        'tenant');

SELECT app.provision_tenant(:A::uuid, '2026', '2026-01-01'::date, '2026-12-31'::date,
                            9::smallint, 9::smallint);

INSERT INTO sections (id, tenant_id, class_id, academic_year_id, name, shift)
SELECT :SEC1, :A, c.id, ay.id, 'ক', 'morning'
  FROM classes c JOIN academic_years ay ON ay.tenant_id = :A AND ay.is_current
 WHERE c.tenant_id = :A LIMIT 1;

INSERT INTO sections (id, tenant_id, class_id, academic_year_id, name, shift)
SELECT :SEC2, :A, c.id, ay.id, 'খ', 'morning'
  FROM classes c JOIN academic_years ay ON ay.tenant_id = :A AND ay.is_current
 WHERE c.tenant_id = :A LIMIT 1;

INSERT INTO enrolments (tenant_id, student_id, section_id, academic_year_id, roll_no, status)
SELECT :A, :STU1, :SEC1, ay.id, 1, 'active'
  FROM academic_years ay WHERE ay.tenant_id = :A AND ay.is_current;
INSERT INTO enrolments (tenant_id, student_id, section_id, academic_year_id, roll_no, status)
SELECT :A, :STU2, :SEC2, ay.id, 1, 'active'
  FROM academic_years ay WHERE ay.tenant_id = :A AND ay.is_current;

-- MINE teaches section 1 only; THEIRS teaches section 2 only.
INSERT INTO section_subject_teachers
  (tenant_id, section_id, subject_id, teacher_id, academic_year_id)
SELECT :A, :SEC1, sub.id, :MINE, ay.id
  FROM subjects sub, academic_years ay
 WHERE sub.tenant_id = :A AND ay.tenant_id = :A AND ay.is_current LIMIT 1;
INSERT INTO section_subject_teachers
  (tenant_id, section_id, subject_id, teacher_id, academic_year_id)
SELECT :A, :SEC2, sub.id, :THEIRS, ay.id
  FROM subjects sub, academic_years ay
 WHERE sub.tenant_id = :A AND ay.tenant_id = :A AND ay.is_current LIMIT 1;

-- DAD is STU1's father and nobody else's.
SELECT app.set_guardian_permissions(:STU1, :DAD, 'father', true, true, true);

-- One invoice and one receipt, for STU1. `provision_tenant` already seeds
-- the fee heads, so the line points at one of those rather than inventing a
-- second 'TUITION' the unique constraint would reject.
INSERT INTO invoices (id, tenant_id, invoice_no, student_id, academic_year_id,
                      section_id, billing_period, issued_on, due_on,
                      subtotal, total_amount, paid_amount, status)
SELECT :INV, :A, 'INV-2026-05-00001', :STU1, ay.id, :SEC1, '2026-05',
       '2026-05-01', '2026-05-10', 1300, 1300, 1300, 'paid'
  FROM academic_years ay WHERE ay.tenant_id = :A AND ay.is_current;

INSERT INTO invoice_lines (tenant_id, invoice_id, fee_head_id, description_bn,
                           amount, waiver_amount)
SELECT :A, :INV, fh.id, 'মাসিক বেতন', 1300, 0
  FROM fee_heads fh WHERE fh.tenant_id = :A ORDER BY fh.code LIMIT 1;

INSERT INTO payment_receipts (tenant_id, receipt_no, invoice_id, student_id,
                              amount, method, issued_at, issued_by)
VALUES (:A, 'RCP-2026-00001', :INV, :STU1, 1300, 'bkash',
        '2026-05-12T09:15:00Z', :HEAD);
COMMIT;

BEGIN;
SET LOCAL app.tenant_id = '7c500000-0000-4000-8000-00000000000b';
SET LOCAL app.role      = 'principal';
SET LOCAL app.user_id   = '7c500000-0000-4000-8000-0000000000e1';

INSERT INTO tenants (id, slug, name_bn, name_en, stream, level, settings)
VALUES (:B, 'r5-beta', 'বিটা মাদ্রাসা', 'Beta Madrasa', 'madrasah', 'secondary',
        jsonb_build_object('branding', jsonb_build_object(
          'nameBn', 'বিটা মাদ্রাসা',
          'primaryColor', '#0D47A1',
          'headmasterName', 'বিটা প্রধান শিক্ষক')));

INSERT INTO users (id, tenant_id, full_name_bn, full_name_en, phone_e164, status) VALUES
  (:HEADB, :B, 'বিটা প্রধান', 'Beta Head', '+8801799860001', 'active'),
  (:STUB,  :B, 'বিটা ছাত্র',  'Beta Stu',  '+8801799860002', 'active');
INSERT INTO user_roles (tenant_id, user_id, role_code, scope_type) VALUES
  (:B, :HEADB, 'principal', 'tenant'),
  (:B, :STUB,  'student',   'tenant');

SELECT app.provision_tenant(:B::uuid, '2026', '2026-01-01'::date, '2026-12-31'::date,
                            9::smallint, 9::smallint);

INSERT INTO invoices (tenant_id, invoice_no, student_id, academic_year_id,
                      billing_period, issued_on, due_on,
                      subtotal, total_amount, paid_amount, status)
SELECT :B, 'INV-2026-05-B0001', :STUB, ay.id, '2026-05',
       '2026-05-01', '2026-05-10', 900, 900, 900, 'paid'
  FROM academic_years ay WHERE ay.tenant_id = :B AND ay.is_current;

INSERT INTO payment_receipts (tenant_id, receipt_no, invoice_id, student_id,
                              amount, method, issued_at, issued_by)
SELECT :B, 'RCP-2026-B0001', i.id, :STUB, 900, 'cash',
       '2026-05-12T10:00:00Z', :HEADB
  FROM invoices i WHERE i.tenant_id = :B AND i.invoice_no = 'INV-2026-05-B0001';

-- Beta's ids, stashed while a Beta session can still see them. Later tests
-- run as Alpha and must NAME these ids to prove they are unreachable —
-- an attacker who has an id is the whole threat model, and a test that
-- cannot obtain one proves nothing. A temp table is outside RLS by nature.
CREATE TEMP TABLE r5_beta_ids AS
SELECT (SELECT id FROM payment_receipts WHERE receipt_no = 'RCP-2026-B0001') AS receipt_id,
       (SELECT id FROM sections ORDER BY name LIMIT 1)                        AS section_id;
COMMIT;

DO $$
BEGIN
  IF (SELECT receipt_id FROM r5_beta_ids) IS NULL THEN
    RAISE EXCEPTION 'FAIL: fixture did not capture Beta''s receipt id';
  END IF;
END $$;

-- ---------------------------------------------------------------------
-- 1. The branding query has no WHERE clause, and does not need one.
--
--    This is the endpoint's literal SQL. If a session could ever see two
--    tenants rows, the document engine would letterhead a receipt with
--    whichever row the planner happened to return first.
-- ---------------------------------------------------------------------
BEGIN;
SET LOCAL app.tenant_id = '7c500000-0000-4000-8000-00000000000a';
SET LOCAL app.role      = 'principal';
SET LOCAL app.user_id   = '7c500000-0000-4000-8000-0000000000f1';

DO $$
DECLARE n integer; brand jsonb;
BEGIN
  SELECT count(*) INTO n FROM tenants;
  IF n <> 1 THEN
    RAISE EXCEPTION 'FAIL: a session sees % tenants rows, so branding is ambiguous', n;
  END IF;

  SELECT COALESCE(settings->'branding', '{}'::jsonb) INTO brand FROM tenants;
  IF brand->>'nameBn' <> 'আলফা উচ্চ বিদ্যালয়' THEN
    RAISE EXCEPTION 'FAIL: wrong institution on the letterhead: %', brand->>'nameBn';
  END IF;
  IF brand->>'primaryColor' <> '#1B5E20' THEN
    RAISE EXCEPTION 'FAIL: wrong brand colour: %', brand->>'primaryColor';
  END IF;
  RAISE NOTICE 'PASS branding resolves to exactly one tenant, from the session';
END $$;
ROLLBACK;

-- ---------------------------------------------------------------------
-- 2. The neighbour's letterhead is not merely unselected — it is unreachable.
-- ---------------------------------------------------------------------
BEGIN;
SET LOCAL app.tenant_id = '7c500000-0000-4000-8000-00000000000a';
SET LOCAL app.role      = 'principal';
SET LOCAL app.user_id   = '7c500000-0000-4000-8000-0000000000f1';

DO $$
DECLARE n integer;
BEGIN
  -- Naming the other tenant explicitly, which is what a hostile caller would
  -- do if the endpoint ever took a tenantId. It does not, and this is why.
  SELECT count(*) INTO n FROM tenants
   WHERE id = '7c500000-0000-4000-8000-00000000000b';
  IF n <> 0 THEN
    RAISE EXCEPTION 'FAIL: Alpha reached Beta''s branding row';
  END IF;
  RAISE NOTICE 'PASS naming another tenant explicitly still returns nothing';
END $$;
ROLLBACK;

-- ---------------------------------------------------------------------
-- 3. A receipt id from another school is indistinguishable from a typo.
--
--    The endpoint's own receipt query, run with Beta's receipt id in an
--    Alpha session. Zero rows means the handler raises the same 404 it
--    raises for nonsense, which is the point: a different error would turn
--    the endpoint into an oracle for which ids exist.
-- ---------------------------------------------------------------------
BEGIN;
SET LOCAL app.tenant_id = '7c500000-0000-4000-8000-00000000000a';
SET LOCAL app.role      = 'accountant';
SET LOCAL app.user_id   = '7c500000-0000-4000-8000-0000000000f1';

DO $$
DECLARE v_beta uuid; n integer;
BEGIN
  -- The id an attacker is assumed to already have.
  SELECT receipt_id INTO v_beta FROM r5_beta_ids;

  SELECT count(*) INTO n
    FROM payment_receipts pr JOIN invoices i ON i.id = pr.invoice_id
   WHERE pr.id = v_beta;
  IF n <> 0 THEN
    RAISE EXCEPTION 'FAIL: Alpha rendered a receipt belonging to Beta';
  END IF;
  RAISE NOTICE 'PASS a receipt id from another school returns nothing';
END $$;
ROLLBACK;

-- ---------------------------------------------------------------------
-- 4. A guardian reaches their own child's receipt and no other.
--
--    `payment_receipts` has NO role scope of its own — only tenant
--    isolation. What restricts a guardian is the JOIN to `invoices`, which
--    does. Both halves are asserted, because the day someone rewrites this
--    query without the join is the day a parent can print a neighbour's
--    fee history.
-- ---------------------------------------------------------------------
BEGIN;
SET LOCAL app.tenant_id = '7c500000-0000-4000-8000-00000000000a';
SET LOCAL app.role      = 'guardian';
SET LOCAL app.user_id   = '7c500000-0000-4000-8000-0000000000c1';

DO $$
DECLARE n integer; bare integer;
BEGIN
  SELECT count(*) INTO n
    FROM payment_receipts pr JOIN invoices i ON i.id = pr.invoice_id
   WHERE pr.student_id = '7c500000-0000-4000-8000-0000000000a1';
  IF n <> 1 THEN
    RAISE EXCEPTION 'FAIL: a father cannot print his own child''s receipt (% rows)', n;
  END IF;

  -- The other child in the same school.
  SELECT count(*) INTO n
    FROM payment_receipts pr JOIN invoices i ON i.id = pr.invoice_id
   WHERE pr.student_id = '7c500000-0000-4000-8000-0000000000a2';
  IF n <> 0 THEN
    RAISE EXCEPTION 'FAIL: a father reached another family''s receipt';
  END IF;

  -- And the reason: the join, not the receipts table.
  SELECT count(*) INTO bare FROM payment_receipts;
  IF bare = 0 THEN
    RAISE EXCEPTION
      'FAIL: payment_receipts now has its own scope — delete this assertion, '
      'but re-check every query that reads it without joining invoices';
  END IF;
  RAISE NOTICE 'PASS a guardian reaches only their ward''s receipt, via the invoice join';
END $$;
ROLLBACK;

-- ---------------------------------------------------------------------
-- 5. The staff-directory hole is real.
--
--    `users_scope` ends with `OR app.is_staff()`. A subject teacher can
--    therefore read the name, date of birth and parents' names of a child
--    they do not teach. That is a deliberate directory decision from
--    migration 010 and this test does not argue with it — it records it, so
--    that test 6's guard is not mistaken for belt-and-braces later.
-- ---------------------------------------------------------------------
BEGIN;
SET LOCAL app.tenant_id = '7c500000-0000-4000-8000-00000000000a';
SET LOCAL app.role      = 'subject_teacher';
SET LOCAL app.user_id   = '7c500000-0000-4000-8000-0000000000f2';   -- teaches SEC1

DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM users
   WHERE id = '7c500000-0000-4000-8000-0000000000a2';               -- a SEC2 child
  IF n <> 1 THEN
    RAISE NOTICE 'NOTE users_scope has been tightened since R-5 — the guard in '
                 'loadStudents is now redundant rather than load-bearing';
  ELSE
    RAISE NOTICE 'PASS the directory hole is real: a teacher can read a foreign '
                 'student''s row, so the document guard is load-bearing';
  END IF;
END $$;
ROLLBACK;

-- ---------------------------------------------------------------------
-- 6. …and the document guard closes it.
--
--    `app.can_see_student` is the predicate loadStudents adds. A teacher
--    gets their own sections' children and nobody else's, so an id smuggled
--    into `studentIds=` simply produces no page.
-- ---------------------------------------------------------------------
BEGIN;
SET LOCAL app.tenant_id = '7c500000-0000-4000-8000-00000000000a';
SET LOCAL app.role      = 'subject_teacher';
SET LOCAL app.user_id   = '7c500000-0000-4000-8000-0000000000f2';   -- teaches SEC1

DO $$
DECLARE n integer;
BEGIN
  IF NOT app.can_see_student('7c500000-0000-4000-8000-0000000000a1') THEN
    RAISE EXCEPTION 'FAIL: a teacher cannot print for their own section';
  END IF;
  IF app.can_see_student('7c500000-0000-4000-8000-0000000000a2') THEN
    RAISE EXCEPTION 'FAIL: a teacher can print a document for another section''s child';
  END IF;

  -- loadStudents' actual WHERE clause, with both ids named at once — the
  -- bulk case, where one forbidden id must not poison or leak through a
  -- batch of legitimate ones.
  SELECT count(*) INTO n FROM users u
   WHERE u.id = ANY(ARRAY['7c500000-0000-4000-8000-0000000000a1',
                          '7c500000-0000-4000-8000-0000000000a2']::uuid[])
     AND app.can_see_student(u.id);
  IF n <> 1 THEN
    RAISE EXCEPTION 'FAIL: a mixed batch returned % students, expected 1', n;
  END IF;
  RAISE NOTICE 'PASS the document guard drops ids a teacher may look up but not print';
END $$;
ROLLBACK;

-- ---------------------------------------------------------------------
-- 7. The same guard, from a parent's side.
-- ---------------------------------------------------------------------
BEGIN;
SET LOCAL app.tenant_id = '7c500000-0000-4000-8000-00000000000a';
SET LOCAL app.role      = 'guardian';
SET LOCAL app.user_id   = '7c500000-0000-4000-8000-0000000000c1';

DO $$
BEGIN
  IF NOT app.can_see_student('7c500000-0000-4000-8000-0000000000a1') THEN
    RAISE EXCEPTION 'FAIL: a father cannot print his own child''s report card';
  END IF;
  IF app.can_see_student('7c500000-0000-4000-8000-0000000000a2') THEN
    RAISE EXCEPTION 'FAIL: a father can print another family''s child''s report card';
  END IF;
  RAISE NOTICE 'PASS a guardian prints for their wards only';
END $$;
ROLLBACK;

-- ---------------------------------------------------------------------
-- 8. A principal prints for the whole school. The guard must not
--    accidentally lock management out of their own documents.
-- ---------------------------------------------------------------------
BEGIN;
SET LOCAL app.tenant_id = '7c500000-0000-4000-8000-00000000000a';
SET LOCAL app.role      = 'principal';
SET LOCAL app.user_id   = '7c500000-0000-4000-8000-0000000000f1';

DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM users u
   WHERE u.id = ANY(ARRAY['7c500000-0000-4000-8000-0000000000a1',
                          '7c500000-0000-4000-8000-0000000000a2']::uuid[])
     AND app.can_see_student(u.id);
  IF n <> 2 THEN
    RAISE EXCEPTION 'FAIL: a principal reached % of 2 students', n;
  END IF;
  RAISE NOTICE 'PASS a principal prints for every child in their school';
END $$;
ROLLBACK;

-- ---------------------------------------------------------------------
-- 9. Bulk resolves a section server-side, and stops at the tenant line.
--
--    This is `studentIdsFor`'s roster query. "Generate for the whole
--    section" is safe precisely because the browser sends a section id and
--    the server decides who is in it.
-- ---------------------------------------------------------------------
BEGIN;
SET LOCAL app.tenant_id = '7c500000-0000-4000-8000-00000000000a';
SET LOCAL app.role      = 'principal';
SET LOCAL app.user_id   = '7c500000-0000-4000-8000-0000000000f1';

DO $$
DECLARE n integer; foreign_sec uuid;
BEGIN
  SELECT count(*) INTO n FROM enrolments e
   WHERE e.section_id = '7c500000-0000-4000-8000-00000000ec01' AND e.status = 'active';
  IF n <> 1 THEN RAISE EXCEPTION 'FAIL: section roster returned % rows', n; END IF;

  SELECT section_id INTO foreign_sec FROM r5_beta_ids;

  IF foreign_sec IS NOT NULL THEN
    SELECT count(*) INTO n FROM enrolments e
     WHERE e.section_id = foreign_sec AND e.status = 'active';
    IF n <> 0 THEN
      RAISE EXCEPTION 'FAIL: Alpha resolved a roster inside Beta';
    END IF;
  END IF;
  RAISE NOTICE 'PASS a section resolves to its own roster and no other tenant''s';
END $$;
ROLLBACK;

-- ---------------------------------------------------------------------
-- 10. An attendance sheet for someone else's section is refused, not
--     silently emptied.
--
--     The endpoint asks this exact question and 403s if any answer is false.
--     A branded but blank register would look like a working feature.
-- ---------------------------------------------------------------------
BEGIN;
SET LOCAL app.tenant_id = '7c500000-0000-4000-8000-00000000000a';
SET LOCAL app.role      = 'subject_teacher';
SET LOCAL app.user_id   = '7c500000-0000-4000-8000-0000000000f2';   -- teaches SEC1

DO $$
DECLARE hidden integer;
BEGIN
  SELECT count(*) INTO hidden
    FROM enrolments e JOIN users u ON u.id = e.student_id
   WHERE e.section_id = '7c500000-0000-4000-8000-00000000ec02'
     AND e.status = 'active' AND NOT app.can_see_student(u.id);
  IF hidden = 0 THEN
    RAISE EXCEPTION 'FAIL: a teacher could print another section''s register';
  END IF;

  SELECT count(*) INTO hidden
    FROM enrolments e JOIN users u ON u.id = e.student_id
   WHERE e.section_id = '7c500000-0000-4000-8000-00000000ec01'
     AND e.status = 'active' AND NOT app.can_see_student(u.id);
  IF hidden <> 0 THEN
    RAISE EXCEPTION 'FAIL: a teacher is refused their OWN section''s register';
  END IF;
  RAISE NOTICE 'PASS the attendance sheet is refused for a foreign section, allowed for one''s own';
END $$;
ROLLBACK;

-- ---------------------------------------------------------------------
-- 11. A tenant that has uploaded no branding gets an empty object, never a
--     neighbour's identity. The renderer falls back to the school's name;
--     what it must never do is fall back to another school.
-- ---------------------------------------------------------------------
BEGIN;
SET LOCAL app.tenant_id = '7c500000-0000-4000-8000-00000000000b';
SET LOCAL app.role      = 'principal';
SET LOCAL app.user_id   = '7c500000-0000-4000-8000-0000000000e1';

DO $$
DECLARE brand jsonb;
BEGIN
  UPDATE tenants SET settings = settings - 'branding';
  SELECT COALESCE(settings->'branding', '{}'::jsonb) INTO brand FROM tenants;
  IF brand <> '{}'::jsonb THEN
    RAISE EXCEPTION 'FAIL: a bare tenant resolved branding: %', brand;
  END IF;
  RAISE NOTICE 'PASS a school with no branding gets nothing, not somebody else''s';
END $$;
ROLLBACK;

-- ---------------------------------------------------------------------
-- Teardown — re-runnable, leaving nothing.
-- ---------------------------------------------------------------------
RESET ROLE;
-- Money rows hold the tenant row down: ledger_entries, mfs_transactions and
-- payment_receipts are ON DELETE RESTRICT, deliberately, so a school's
-- financial history cannot be erased by deleting the school. A fixture has to
-- clear them by hand, and a teardown that forgets fails loudly rather than
-- leaving a half-deleted tenant behind.
DELETE FROM payment_receipts WHERE tenant_id IN (:A, :B);
DELETE FROM ledger_entries   WHERE tenant_id IN (:A, :B);
DELETE FROM mfs_transactions WHERE tenant_id IN (:A, :B);
DELETE FROM audit.activity_log WHERE tenant_id IN (:A, :B);
DELETE FROM tenants WHERE id IN (:A, :B);

DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM tenants WHERE slug IN ('r5-alpha', 'r5-beta');
  IF n <> 0 THEN RAISE EXCEPTION 'FAIL: teardown left % tenant row(s)', n; END IF;
  RAISE NOTICE 'PASS teardown — no fixture rows remain';
END $$;

SELECT 'R-5: branded documents resolve one tenant, one family, one section.' AS result;
