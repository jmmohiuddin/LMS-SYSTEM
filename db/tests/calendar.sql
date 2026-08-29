-- =====================================================================
-- db/tests/calendar.sql   (R-4, docs/11-MASTER-PLAN.md)
--
-- `calendar_days` was already load-bearing before it had a screen: sms-svc
-- reads it to suppress attendance and notice SMS on holidays. So the first
-- thing this file asserts is the one that was missing — who may write it.
--
--   A student cannot declare a holiday. Before migration 043 they could,
--     and one row would have silenced the school's SMS for that day.
--   A teacher cannot either, but everyone can READ the calendar.
--   Two events can share a date. Before 043 the second one was rejected.
--   Each tenant sees only its own calendar, and its own weekend.
--   Tenant B cannot read, edit or delete tenant A's entry by id.
--   A calendar notice goes through R-2's emit_auto_notice, idempotently.
--   The SMS holiday suppression still reads the same rows.
--   Exams are NOT copied into calendar_days.
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/tests/calendar.sql
-- =====================================================================

\set ON_ERROR_STOP on

GRANT shikhon_app TO CURRENT_USER;
SET ROLE shikhon_app;

\set T   '''7c800000-0000-4000-8000-00000000000a'''
\set T2  '''7c800000-0000-4000-8000-00000000000b'''
\set HEAD    '''7c800000-0000-4000-8000-0000000000f1'''
\set TEACHER '''7c800000-0000-4000-8000-0000000000f2'''
\set STU     '''7c800000-0000-4000-8000-0000000000a1'''
\set GUARD   '''7c800000-0000-4000-8000-0000000000c1'''
\set HEAD2   '''7c800000-0000-4000-8000-0000000000e1'''
\set SEC     '''7c800000-0000-4000-8000-00000000ec01'''
\set HOLIDAY '''7c800000-0000-4000-8000-00000000cd01'''

-- ---------------------------------------------------------------------
-- Seed. Monipur runs Fri+Sat; the other school is a Madrasah on Friday
-- only — the case that makes "do not hardcode Friday/Saturday" concrete.
-- ---------------------------------------------------------------------
BEGIN;
SET LOCAL app.tenant_id = '7c800000-0000-4000-8000-00000000000a';
SET LOCAL app.role      = 'principal';
SET LOCAL app.user_id   = '7c800000-0000-4000-8000-0000000000f1';

INSERT INTO tenants (id, slug, name_bn, name_en, stream, level, weekend_days)
VALUES (:T, 'r4-monipur', 'মনিপুর বিদ্যালয়', 'Monipur School',
        'bangla_medium', 'secondary', '{5,6}');

INSERT INTO users (id, tenant_id, full_name_bn, full_name_en, phone_e164, status) VALUES
  (:HEAD,    :T, 'প্রধান',   'Head',     '+8801799780001', 'active'),
  (:TEACHER, :T, 'শিক্ষক',   'Teacher',  '+8801799780002', 'active'),
  (:STU,     :T, 'ছাত্র',    'Student',  '+8801799780003', 'active'),
  (:GUARD,   :T, 'অভিভাবক', 'Guardian', '+8801799780004', 'active');

INSERT INTO user_roles (tenant_id, user_id, role_code, scope_type) VALUES
  (:T, :HEAD,    'principal',       'tenant'),
  (:T, :TEACHER, 'subject_teacher', 'tenant'),
  (:T, :STU,     'student',         'tenant'),
  (:T, :GUARD,   'guardian',        'tenant');

SELECT app.provision_tenant(:T::uuid, '2026', '2026-01-01'::date, '2026-12-31'::date,
                            9::smallint, 9::smallint);

INSERT INTO sections (id, tenant_id, class_id, academic_year_id, name, shift)
SELECT :SEC, :T, c.id, ay.id, 'ক', 'morning'
  FROM classes c JOIN academic_years ay ON ay.tenant_id = :T AND ay.is_current
 WHERE c.tenant_id = :T LIMIT 1;

INSERT INTO enrolments (tenant_id, student_id, section_id, academic_year_id, roll_no, status)
SELECT :T, :STU, :SEC, ay.id, 1, 'active'
  FROM academic_years ay WHERE ay.tenant_id = :T AND ay.is_current;

INSERT INTO guardianships (tenant_id, guardian_id, student_id, relation, is_primary, receives_sms)
VALUES (:T, :GUARD, :STU, 'father', true, true);

-- An exam, so the "not copied" assertion has something to be about.
INSERT INTO exams (tenant_id, academic_year_id, term_id, name_bn, name_en,
                   exam_type, starts_on, ends_on, status)
SELECT :T, ay.id, t.id, 'অর্ধবার্ষিক পরীক্ষা', 'Half Yearly', 'half_yearly',
       '2026-06-10'::date, '2026-06-20'::date, 'planned'
  FROM academic_years ay JOIN terms t ON t.academic_year_id = ay.id
 WHERE ay.tenant_id = :T AND ay.is_current LIMIT 1;
COMMIT;

-- The Madrasah, on a Friday-only weekend.
BEGIN;
SET LOCAL app.tenant_id = '7c800000-0000-4000-8000-00000000000b';
SET LOCAL app.role      = 'principal';
SET LOCAL app.user_id   = '7c800000-0000-4000-8000-0000000000e1';
INSERT INTO tenants (id, slug, name_bn, name_en, stream, level, weekend_days)
VALUES (:T2, 'r4-mohammadpur', 'মোহাম্মদপুর মাদ্রাসা', 'Mohammadpur Madrasah',
        'madrasah', 'secondary', '{5}');
INSERT INTO users (id, tenant_id, full_name_bn, full_name_en, phone_e164, status)
VALUES (:HEAD2, :T2, 'অন্য প্রধান', 'Other Head', '+8801799790001', 'active');
INSERT INTO user_roles (tenant_id, user_id, role_code, scope_type)
VALUES (:T2, :HEAD2, 'principal', 'tenant');
SELECT app.provision_tenant(:T2::uuid, '2026', '2026-01-01'::date, '2026-12-31'::date,
                            9::smallint, 9::smallint);
COMMIT;

-- ---------------------------------------------------------------------
-- 1. THE ONE THAT MATTERS — a student cannot declare a holiday.
--
-- One row with kind='holiday' suppresses the whole school's attendance SMS
-- for that day. Before 043 this INSERT succeeded.
-- ---------------------------------------------------------------------
BEGIN;
SET LOCAL app.tenant_id = '7c800000-0000-4000-8000-00000000000a';
SET LOCAL app.role      = 'student';
SET LOCAL app.user_id   = '7c800000-0000-4000-8000-0000000000a1';

DO $$
DECLARE v_year uuid;
BEGIN
  SELECT id INTO v_year FROM academic_years WHERE is_current LIMIT 1;
  BEGIN
    INSERT INTO calendar_days (tenant_id, academic_year_id, day, kind, title_bn)
    VALUES ('7c800000-0000-4000-8000-00000000000a', v_year,
            '2026-09-01', 'holiday', 'আজ ছুটি');
    RAISE EXCEPTION 'FAIL: a student declared a school holiday';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'PASS a student cannot declare a holiday';
  END;
END $$;
ROLLBACK;

-- ---------------------------------------------------------------------
-- 2. Nor can a subject teacher — but everyone READS it.
-- ---------------------------------------------------------------------
BEGIN;
SET LOCAL app.tenant_id = '7c800000-0000-4000-8000-00000000000a';
SET LOCAL app.role      = 'principal';
SET LOCAL app.user_id   = '7c800000-0000-4000-8000-0000000000f1';
INSERT INTO calendar_days (id, tenant_id, academic_year_id, day, kind, title_bn,
                           description_bn, created_by)
SELECT :HOLIDAY, :T, ay.id, '2026-10-10', 'holiday', 'বিদ্যালয় ছুটি',
       'দুর্গাপূজা উপলক্ষে', :HEAD
  FROM academic_years ay WHERE ay.tenant_id = :T AND ay.is_current;
COMMIT;

BEGIN;
SET LOCAL app.tenant_id = '7c800000-0000-4000-8000-00000000000a';
SET LOCAL app.role      = 'subject_teacher';
SET LOCAL app.user_id   = '7c800000-0000-4000-8000-0000000000f2';

DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM calendar_days
   WHERE id = '7c800000-0000-4000-8000-00000000cd01';
  IF n <> 1 THEN RAISE EXCEPTION 'FAIL: a teacher cannot read the calendar'; END IF;

  UPDATE calendar_days SET title_bn = 'আমার ছুটি'
   WHERE id = '7c800000-0000-4000-8000-00000000cd01';
  IF FOUND THEN RAISE EXCEPTION 'FAIL: a subject teacher edited a calendar entry'; END IF;

  DELETE FROM calendar_days WHERE id = '7c800000-0000-4000-8000-00000000cd01';
  IF FOUND THEN RAISE EXCEPTION 'FAIL: a subject teacher deleted a calendar entry'; END IF;

  RAISE NOTICE 'PASS a teacher reads the calendar and cannot change it';
END $$;
ROLLBACK;

-- A guardian and a student read it too — a calendar guardians cannot see is
-- not a school calendar.
BEGIN;
SET LOCAL app.tenant_id = '7c800000-0000-4000-8000-00000000000a';
SET LOCAL app.role      = 'guardian';
SET LOCAL app.user_id   = '7c800000-0000-4000-8000-0000000000c1';
DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM calendar_days;
  IF n < 1 THEN RAISE EXCEPTION 'FAIL: a guardian cannot see the school calendar'; END IF;
  RAISE NOTICE 'PASS a guardian can read the school calendar';
END $$;
COMMIT;

-- ---------------------------------------------------------------------
-- 3. Two events on one day. Impossible before 043's constraint change.
-- ---------------------------------------------------------------------
BEGIN;
SET LOCAL app.tenant_id = '7c800000-0000-4000-8000-00000000000a';
SET LOCAL app.role      = 'academic_coordinator';
SET LOCAL app.user_id   = '7c800000-0000-4000-8000-0000000000f1';

INSERT INTO calendar_days (tenant_id, academic_year_id, day, kind, title_bn, created_by)
SELECT :T, ay.id, '2026-11-05', 'event', 'ক্রীড়া দিবস', :HEAD
  FROM academic_years ay WHERE ay.tenant_id = :T AND ay.is_current;
INSERT INTO calendar_days (tenant_id, academic_year_id, day, kind, title_bn, created_by)
SELECT :T, ay.id, '2026-11-05', 'event', 'অভিভাবক সভা', :HEAD
  FROM academic_years ay WHERE ay.tenant_id = :T AND ay.is_current;

DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM calendar_days WHERE day = '2026-11-05' AND kind = 'event';
  IF n <> 2 THEN RAISE EXCEPTION 'FAIL: expected 2 events on one day, got %', n; END IF;
  RAISE NOTICE 'PASS a school can hold two events on the same day';
END $$;

-- But the same title twice on one day is still a duplicate.
DO $$
BEGIN
  BEGIN
    INSERT INTO calendar_days (tenant_id, academic_year_id, day, kind, title_bn)
    SELECT '7c800000-0000-4000-8000-00000000000a', ay.id, '2026-11-05', 'event', 'ক্রীড়া দিবস'
      FROM academic_years ay WHERE ay.is_current;
    RAISE EXCEPTION 'FAIL: the same event was recorded twice';
  EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE 'PASS the same entry cannot be recorded twice on one day';
  END;
END $$;
COMMIT;

-- ---------------------------------------------------------------------
-- 4. Each tenant has its OWN weekend. Nothing hardcodes Friday/Saturday.
-- ---------------------------------------------------------------------
DO $$
DECLARE a smallint[]; b smallint[];
BEGIN
  SELECT weekend_days INTO a FROM tenants WHERE slug = 'r4-monipur';
  SELECT weekend_days INTO b FROM tenants WHERE slug = 'r4-mohammadpur';
  IF a <> '{5,6}'::smallint[] THEN RAISE EXCEPTION 'FAIL: Monipur weekend is %', a; END IF;
  IF b <> '{5}'::smallint[]   THEN RAISE EXCEPTION 'FAIL: the Madrasah weekend is %', b; END IF;
  RAISE NOTICE 'PASS two tenants, two different weekends';
END $$;

-- ---------------------------------------------------------------------
-- 5. TENANT ISOLATION — the calendar does not cross.
-- ---------------------------------------------------------------------
BEGIN;
SET LOCAL app.tenant_id = '7c800000-0000-4000-8000-00000000000b';
SET LOCAL app.role      = 'principal';
SET LOCAL app.user_id   = '7c800000-0000-4000-8000-0000000000e1';

DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM calendar_days;
  IF n <> 0 THEN RAISE EXCEPTION 'FAIL: tenant B sees % of A''s calendar entries', n; END IF;

  -- Naming A's entry id directly.
  SELECT count(*) INTO n FROM calendar_days
   WHERE id = '7c800000-0000-4000-8000-00000000cd01';
  IF n <> 0 THEN RAISE EXCEPTION 'FAIL: tenant B read A''s entry by id'; END IF;

  RAISE NOTICE 'PASS tenant B sees none of tenant A''s calendar';
END $$;
COMMIT;

-- ---------------------------------------------------------------------
-- 6. And cannot edit or delete A's entry by id — the shared-id case.
-- ---------------------------------------------------------------------
BEGIN;
SET LOCAL app.tenant_id = '7c800000-0000-4000-8000-00000000000b';
SET LOCAL app.role      = 'principal';
SET LOCAL app.user_id   = '7c800000-0000-4000-8000-0000000000e1';

DO $$
BEGIN
  UPDATE calendar_days SET title_bn = 'ছিনতাই'
   WHERE id = '7c800000-0000-4000-8000-00000000cd01';
  IF FOUND THEN RAISE EXCEPTION 'FAIL: tenant B edited tenant A''s calendar entry'; END IF;

  DELETE FROM calendar_days WHERE id = '7c800000-0000-4000-8000-00000000cd01';
  IF FOUND THEN RAISE EXCEPTION 'FAIL: tenant B deleted tenant A''s calendar entry'; END IF;

  RAISE NOTICE 'PASS tenant B cannot edit or delete tenant A''s entry by id';
END $$;
COMMIT;

-- Confirm from A's own context that the entry is intact.
BEGIN;
SET LOCAL app.tenant_id = '7c800000-0000-4000-8000-00000000000a';
SET LOCAL app.role      = 'principal';
SET LOCAL app.user_id   = '7c800000-0000-4000-8000-0000000000f1';
DO $$
DECLARE v text;
BEGIN
  SELECT title_bn INTO v FROM calendar_days
   WHERE id = '7c800000-0000-4000-8000-00000000cd01';
  IF v IS DISTINCT FROM 'বিদ্যালয় ছুটি' THEN
    RAISE EXCEPTION 'FAIL: tenant A''s entry was changed (%)', v;
  END IF;
  RAISE NOTICE 'PASS tenant A''s calendar entry is unchanged';
END $$;
COMMIT;

-- ---------------------------------------------------------------------
-- 7. THE INTEGRATION — a calendar notice goes through R-2, idempotently.
-- ---------------------------------------------------------------------
BEGIN;
SET LOCAL app.tenant_id = '7c800000-0000-4000-8000-00000000000a';
SET LOCAL app.role      = 'principal';
SET LOCAL app.user_id   = '7c800000-0000-4000-8000-0000000000f1';

DO $$
DECLARE r1 record; r2 record; n integer;
BEGIN
  SELECT * INTO r1 FROM app.emit_auto_notice(
    'calendar', '7c800000-0000-4000-8000-00000000cd01'::uuid,
    'বিদ্যালয় ছুটি', 'দুর্গাপূজা উপলক্ষে', 'general'::notice_category,
    '{"type":"all"}'::jsonb, false);

  IF r1.already_sent THEN RAISE EXCEPTION 'FAIL: the first notice reported as already sent'; END IF;
  IF r1.recipients < 1 THEN
    RAISE EXCEPTION 'FAIL: the holiday notice reached nobody (%)', r1.recipients;
  END IF;

  -- Second call, same entry: no second notice, no second SMS.
  SELECT * INTO r2 FROM app.emit_auto_notice(
    'calendar', '7c800000-0000-4000-8000-00000000cd01'::uuid,
    'বিদ্যালয় ছুটি', 'আবার', 'general'::notice_category,
    '{"type":"all"}'::jsonb, false);
  IF NOT r2.already_sent THEN
    RAISE EXCEPTION 'FAIL: announcing the same calendar entry twice created a second notice';
  END IF;

  SELECT count(*) INTO n FROM notices
   WHERE source_kind = 'calendar'
     AND source_ref = '7c800000-0000-4000-8000-00000000cd01';
  IF n <> 1 THEN RAISE EXCEPTION 'FAIL: % notices for one calendar entry', n; END IF;

  RAISE NOTICE 'PASS a calendar notice uses R-2 and cannot be sent twice';
END $$;
COMMIT;

-- ---------------------------------------------------------------------
-- 8. The SMS suppression this table has always driven still works.
-- ---------------------------------------------------------------------
BEGIN;
SET LOCAL app.tenant_id = '7c800000-0000-4000-8000-00000000000a';
SET LOCAL app.role      = 'principal';
SET LOCAL app.user_id   = '7c800000-0000-4000-8000-0000000000f1';

DO $$
DECLARE n integer;
BEGIN
  -- The exact query in services/sms-svc/src/dispatch.ts, twice over.
  SELECT count(*) INTO n FROM calendar_days
   WHERE tenant_id = '7c800000-0000-4000-8000-00000000000a'
     AND day = '2026-10-10' AND kind = 'holiday';
  IF n <> 1 THEN RAISE EXCEPTION 'FAIL: the holiday suppression lookup broke (%)', n; END IF;

  -- An 'event' is not a holiday and must not suppress anything.
  SELECT count(*) INTO n FROM calendar_days
   WHERE tenant_id = '7c800000-0000-4000-8000-00000000000a'
     AND day = '2026-11-05' AND kind = 'holiday';
  IF n <> 0 THEN RAISE EXCEPTION 'FAIL: an event is suppressing SMS as if it were a holiday'; END IF;

  RAISE NOTICE 'PASS holiday SMS suppression still reads these rows';
END $$;
COMMIT;

-- ---------------------------------------------------------------------
-- 9. Exams are NOT copied into calendar_days.
--
-- The calendar merges `exams` and `exam_subjects` at READ time. A row here
-- per exam would be a second source of truth that goes stale the first time
-- a coordinator moves a paper.
-- ---------------------------------------------------------------------
BEGIN;
SET LOCAL app.tenant_id = '7c800000-0000-4000-8000-00000000000a';
SET LOCAL app.role      = 'principal';
SET LOCAL app.user_id   = '7c800000-0000-4000-8000-0000000000f1';

DO $$
DECLARE n integer; e integer;
BEGIN
  SELECT count(*) INTO e FROM exams;
  IF e < 1 THEN RAISE EXCEPTION 'FAIL: the fixture has no exam to check against'; END IF;

  SELECT count(*) INTO n FROM calendar_days WHERE kind = 'exam';
  IF n <> 0 THEN
    RAISE EXCEPTION 'FAIL: % exam row(s) were copied into calendar_days', n;
  END IF;
  RAISE NOTICE 'PASS exams are read from their own tables, not duplicated';
END $$;
COMMIT;

-- ---------------------------------------------------------------------
-- 10. An entry belongs to the year that CONTAINS its date.
-- ---------------------------------------------------------------------
BEGIN;
SET LOCAL app.tenant_id = '7c800000-0000-4000-8000-00000000000a';
SET LOCAL app.role      = 'principal';
SET LOCAL app.user_id   = '7c800000-0000-4000-8000-0000000000f1';

DO $$
DECLARE v_label text;
BEGIN
  SELECT ay.label INTO v_label
    FROM calendar_days cd JOIN academic_years ay ON ay.id = cd.academic_year_id
   WHERE cd.id = '7c800000-0000-4000-8000-00000000cd01';
  IF v_label <> '2026' THEN
    RAISE EXCEPTION 'FAIL: a 2026 entry is filed under %', v_label;
  END IF;

  -- And a date outside every year resolves to nothing, which is what makes
  -- the endpoint refuse rather than guess.
  IF EXISTS (SELECT 1 FROM academic_years
              WHERE '2031-03-01'::date BETWEEN starts_on AND ends_on) THEN
    RAISE EXCEPTION 'FAIL: the fixture unexpectedly covers 2031';
  END IF;
  RAISE NOTICE 'PASS an entry belongs to the year containing its date';
END $$;
COMMIT;

-- ---------------------------------------------------------------------
-- 11. WORKING WEEKEND (R-4.1) — the override, and who may set it.
--
-- `working_weekend` has been storable since migration 003 and was honoured
-- by nothing: both SMS suppression sites asked only about kind='holiday', so
-- a school working a make-up Saturday after a flood took its register and no
-- guardian heard about it.
--
-- The DECISION is a pure function in sms-svc (nonWorkingReasonFor) and is
-- tested there without a database. What belongs here is the DATA the
-- function is fed: the exact query the sender runs, and who may write the
-- row it finds.
-- ---------------------------------------------------------------------
BEGIN;
SET LOCAL app.tenant_id = '7c800000-0000-4000-8000-00000000000a';
SET LOCAL app.role      = 'principal';
SET LOCAL app.user_id   = '7c800000-0000-4000-8000-0000000000f1';

-- 2026-10-17 is a Saturday: weekend for Monipur {5,6}, a working day for the
-- Madrasah {5}. Declaring it a make-up day for Monipur.
INSERT INTO calendar_days (tenant_id, academic_year_id, day, kind, title_bn,
                           description_bn, created_by)
SELECT :T, ay.id, '2026-10-17', 'working_weekend', 'বন্যার ক্ষতি পুষিয়ে নিতে ক্লাস',
       'শনিবার স্বাভাবিক রুটিনে ক্লাস হবে।', :HEAD
  FROM academic_years ay WHERE ay.tenant_id = :T AND ay.is_current;

DO $$
DECLARE kinds text[];
BEGIN
  -- The EXACT query services/sms-svc/src/dispatch.ts::calendarOverrides runs.
  SELECT array_agg(DISTINCT kind ORDER BY kind) INTO kinds
    FROM calendar_days
   WHERE tenant_id = '7c800000-0000-4000-8000-00000000000a'
     AND day = '2026-10-17'
     AND kind IN ('holiday', 'working_weekend');

  IF kinds IS DISTINCT FROM ARRAY['working_weekend']::text[] THEN
    RAISE EXCEPTION 'FAIL: the suppression lookup returned % for the make-up Saturday', kinds;
  END IF;
  RAISE NOTICE 'PASS the sender sees the working-weekend override for that date';
END $$;

DO $$
DECLARE kinds text[];
BEGIN
  -- And says nothing about the Friday beside it, or any other Saturday.
  SELECT array_agg(kind) INTO kinds FROM calendar_days
   WHERE tenant_id = '7c800000-0000-4000-8000-00000000000a'
     AND day = '2026-10-16'
     AND kind IN ('holiday', 'working_weekend');
  IF kinds IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL: the override leaked onto the adjacent Friday (%)', kinds;
  END IF;

  SELECT array_agg(kind) INTO kinds FROM calendar_days
   WHERE tenant_id = '7c800000-0000-4000-8000-00000000000a'
     AND day = '2026-10-24'
     AND kind IN ('holiday', 'working_weekend');
  IF kinds IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL: the override leaked onto the following Saturday (%)', kinds;
  END IF;
  RAISE NOTICE 'PASS the override applies to exactly one date';
END $$;

-- The holiday from step 2 is still on 2026-10-10, unaffected.
DO $$
DECLARE kinds text[];
BEGIN
  SELECT array_agg(kind) INTO kinds FROM calendar_days
   WHERE tenant_id = '7c800000-0000-4000-8000-00000000000a'
     AND day = '2026-10-10'
     AND kind IN ('holiday', 'working_weekend');
  IF kinds IS DISTINCT FROM ARRAY['holiday']::text[] THEN
    RAISE EXCEPTION 'FAIL: the existing holiday changed (%)', kinds;
  END IF;
  RAISE NOTICE 'PASS existing holiday suppression is untouched';
END $$;

-- A date carrying BOTH. The schema permits it (different kinds are different
-- rows); the sender resolves holiday-wins. Asserted here so a future change
-- to the constraint cannot make the contradiction unrepresentable without
-- somebody noticing this test.
INSERT INTO calendar_days (tenant_id, academic_year_id, day, kind, title_bn, created_by)
SELECT :T, ay.id, '2026-10-31', 'holiday', 'ছুটি', :HEAD
  FROM academic_years ay WHERE ay.tenant_id = :T AND ay.is_current;
INSERT INTO calendar_days (tenant_id, academic_year_id, day, kind, title_bn, created_by)
SELECT :T, ay.id, '2026-10-31', 'working_weekend', 'ভুল করে খোলা', :HEAD
  FROM academic_years ay WHERE ay.tenant_id = :T AND ay.is_current;

DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM calendar_days
   WHERE day = '2026-10-31' AND kind IN ('holiday', 'working_weekend');
  IF n <> 2 THEN
    RAISE EXCEPTION 'FAIL: expected the contradiction to be storable, got % row(s)', n;
  END IF;
  RAISE NOTICE 'PASS a contradictory day is storable; the sender resolves it holiday-first';
END $$;
COMMIT;

-- ---------------------------------------------------------------------
-- 12. Only management may declare a working weekend.
--
-- The same stakes as a holiday, in the opposite direction: a student who
-- could add this row would make the school text nine hundred guardians on a
-- Saturday nobody worked.
-- ---------------------------------------------------------------------
BEGIN;
SET LOCAL app.tenant_id = '7c800000-0000-4000-8000-00000000000a';
SET LOCAL app.role      = 'student';
SET LOCAL app.user_id   = '7c800000-0000-4000-8000-0000000000a1';

DO $$
DECLARE v_year uuid;
BEGIN
  SELECT id INTO v_year FROM academic_years WHERE is_current LIMIT 1;
  BEGIN
    INSERT INTO calendar_days (tenant_id, academic_year_id, day, kind, title_bn)
    VALUES ('7c800000-0000-4000-8000-00000000000a', v_year,
            '2026-11-21', 'working_weekend', 'আজ ক্লাস হোক');
    RAISE EXCEPTION 'FAIL: a student declared a working weekend';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'PASS a student cannot declare a working weekend';
  END;
END $$;
ROLLBACK;

BEGIN;
SET LOCAL app.tenant_id = '7c800000-0000-4000-8000-00000000000a';
SET LOCAL app.role      = 'subject_teacher';
SET LOCAL app.user_id   = '7c800000-0000-4000-8000-0000000000f2';

DO $$
DECLARE n integer;
BEGIN
  -- A teacher READS it — they need to know Saturday is a school day.
  SELECT count(*) INTO n FROM calendar_days
   WHERE day = '2026-10-17' AND kind = 'working_weekend';
  IF n <> 1 THEN RAISE EXCEPTION 'FAIL: a teacher cannot see the working weekend'; END IF;

  UPDATE calendar_days SET kind = 'holiday' WHERE day = '2026-10-17';
  IF FOUND THEN RAISE EXCEPTION 'FAIL: a teacher turned a working weekend into a holiday'; END IF;

  DELETE FROM calendar_days WHERE day = '2026-10-17';
  IF FOUND THEN RAISE EXCEPTION 'FAIL: a teacher deleted a working weekend'; END IF;

  RAISE NOTICE 'PASS a teacher sees the working weekend and cannot change it';
END $$;
ROLLBACK;

-- ---------------------------------------------------------------------
-- 13. TENANT ISOLATION — one school's make-up day is not another's.
--
-- The specific harm: Monipur declares its Saturday a working day; if that
-- leaked, the Madrasah next door would start texting on ITS quiet day.
-- ---------------------------------------------------------------------
BEGIN;
SET LOCAL app.tenant_id = '7c800000-0000-4000-8000-00000000000b';
SET LOCAL app.role      = 'principal';
SET LOCAL app.user_id   = '7c800000-0000-4000-8000-0000000000e1';

DO $$
DECLARE kinds text[]; n integer;
BEGIN
  -- The sender's own query, run as the OTHER tenant, for the same date.
  SELECT array_agg(kind) INTO kinds FROM calendar_days
   WHERE tenant_id = '7c800000-0000-4000-8000-00000000000b'
     AND day = '2026-10-17'
     AND kind IN ('holiday', 'working_weekend');
  IF kinds IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL: tenant B sees tenant A''s working weekend (%)', kinds;
  END IF;

  -- Not even by naming A's tenant_id in the predicate: RLS is the boundary,
  -- not the WHERE clause.
  SELECT count(*) INTO n FROM calendar_days
   WHERE tenant_id = '7c800000-0000-4000-8000-00000000000a'
     AND day = '2026-10-17';
  IF n <> 0 THEN
    RAISE EXCEPTION 'FAIL: naming A''s tenant_id returned % row(s) to B', n;
  END IF;

  RAISE NOTICE 'PASS a working weekend does not cross tenants';
END $$;
COMMIT;

-- ---------------------------------------------------------------------
-- 14. ATTENDANCE remains operational — and always was.
--
-- Nothing in this system has ever refused a register on a holiday or a
-- weekend: there is no calendar check on the attendance path, offline or
-- online. R-4.1 added none. This asserts the property rather than assuming
-- it, because "attendance still works on a working weekend" is a claim the
-- brief asks to verify.
-- ---------------------------------------------------------------------
BEGIN;
SET LOCAL app.tenant_id = '7c800000-0000-4000-8000-00000000000a';
-- As principal: attendance_sessions_scope admits management or a teacher
-- of that section, and the fixture teacher is not assigned to it. WHO may
-- take a register is asserted elsewhere; this is about the CALENDAR not
-- blocking one.
SET LOCAL app.role      = 'principal';
SET LOCAL app.user_id   = '7c800000-0000-4000-8000-0000000000f1';

DO $$
DECLARE v_session uuid; v_year uuid; n integer;
BEGIN
  SELECT id INTO v_year FROM academic_years WHERE is_current LIMIT 1;

  -- A register taken on the make-up Saturday.
  -- attendance_sessions.id has NO default: a session is created offline on
  -- the device and carries a client-generated uuid through the outbox. So
  -- the test supplies one, exactly as the sync applier does.
  v_session := gen_random_uuid();
  INSERT INTO attendance_sessions
    (id, tenant_id, section_id, academic_year_id, taken_on, period_no, mode,
     taken_by, taken_at)
  VALUES (v_session, '7c800000-0000-4000-8000-00000000000a',
          '7c800000-0000-4000-8000-00000000ec01', v_year,
          '2026-10-17', 1, 'section_daily', '7c800000-0000-4000-8000-0000000000f1', now());

  INSERT INTO attendance_records
    (tenant_id, session_id, student_id, section_id, taken_on, status,
     marked_by, marked_at)
  VALUES ('7c800000-0000-4000-8000-00000000000a', v_session,
          '7c800000-0000-4000-8000-0000000000a1',
          '7c800000-0000-4000-8000-00000000ec01', '2026-10-17', 'absent',
          '7c800000-0000-4000-8000-0000000000f1', now());

  SELECT count(*) INTO n FROM attendance_records
   WHERE taken_on = '2026-10-17';
  IF n <> 1 THEN RAISE EXCEPTION 'FAIL: attendance on a working weekend was refused'; END IF;

  -- And the absence raised its event, which is what the SMS sender consumes.
  -- Before R-4.1 the event was raised too — and then suppressed as 'weekend'.
  SELECT count(*) INTO n FROM event_outbox
   WHERE event_type = 'attendance.marked.v1'
     AND payload->>'takenOn' = '2026-10-17';
  IF n <> 1 THEN
    RAISE EXCEPTION 'FAIL: the absence raised % outbox event(s)', n;
  END IF;

  RAISE NOTICE 'PASS attendance works on a working weekend and queues its event';
END $$;
ROLLBACK;

-- ---------------------------------------------------------------------
-- Teardown — re-runnable, leaving nothing.
-- ---------------------------------------------------------------------
RESET ROLE;
DELETE FROM audit.activity_log WHERE tenant_id IN
  ('7c800000-0000-4000-8000-00000000000a', '7c800000-0000-4000-8000-00000000000b');
DELETE FROM tenants WHERE id IN
  ('7c800000-0000-4000-8000-00000000000a', '7c800000-0000-4000-8000-00000000000b');

DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM tenants WHERE slug IN ('r4-monipur', 'r4-mohammadpur');
  IF n <> 0 THEN RAISE EXCEPTION 'FAIL: teardown left % tenant row(s)', n; END IF;
  RAISE NOTICE 'PASS teardown — no fixture rows remain';
END $$;

SELECT 'R-4 calendar: write scope, isolation, weekend config and notice reuse passed.' AS result;
