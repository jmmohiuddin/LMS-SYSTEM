-- =====================================================================
-- db/tests/double_periods.sql   (F-504 — "double periods contiguous")
--
-- The guarantee at the storage layer: a double period is exactly two
-- contiguous slots sharing day, section, subject, teacher and room. A
-- science practical cannot set up, run and pack away in 45 minutes, and a
-- "double" with tiffin in the middle is two singles wearing a label.
--
-- The trigger is DEFERRED (the first half is alone until the second is
-- written), and this suite runs inside a transaction it ROLLS BACK — so
-- each assertion forces the check with SET CONSTRAINTS ... IMMEDIATE
-- rather than waiting for a COMMIT that never comes.
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/tests/double_periods.sql
-- =====================================================================

\set ON_ERROR_STOP on

GRANT shikhon_app TO CURRENT_USER;
SET ROLE shikhon_app;

\set T '''7a900000-0000-4000-8000-00000000000a'''

BEGIN;
SET LOCAL app.tenant_id = '7a900000-0000-4000-8000-00000000000a';
SET LOCAL app.role      = 'academic_coordinator';
SET LOCAL app.user_id   = '7a900000-0000-4000-8000-0000000000ff';

INSERT INTO tenants (id, slug, name_bn, name_en, stream, level)
VALUES (:T, 'doubles', 'দ্বৈত পিরিয়ড', 'Doubles School', 'bangla_medium', 'secondary');

INSERT INTO users (id, tenant_id, full_name_bn, full_name_en, phone_e164) VALUES
  ('7a900000-0000-4000-8000-0000000000ff', :T, 'সমন্বয়ক', 'Coordinator', '+8801799200001'),
  ('7a900000-0000-4000-8000-0000000000a1', :T, 'নাসরিন',  'Nasrin',      '+8801799200002'),
  ('7a900000-0000-4000-8000-0000000000a2', :T, 'রফিক',    'Rafiq',       '+8801799200003');

INSERT INTO academic_years (id, tenant_id, label, starts_on, ends_on, is_current)
VALUES ('7a900000-0000-4000-8000-000000000091', :T, '2026', '2026-01-01', '2026-12-31', true);

INSERT INTO classes (id, tenant_id, level_no, name_bn, name_en, stream)
VALUES ('7a900000-0000-4000-8000-0000000000c9', :T, 9, 'নবম', 'Nine', 'bangla_medium');

INSERT INTO rooms (id, tenant_id, code, name_bn, capacity, capabilities) VALUES
  ('7a900000-0000-4000-8000-0000000000d1', :T, 'LAB-1', 'ল্যাব ১', 40, '{chemistry_lab}'),
  ('7a900000-0000-4000-8000-0000000000d2', :T, '204',   'কক্ষ ২০৪', 60, '{}');

INSERT INTO sections (id, tenant_id, class_id, academic_year_id, name, home_room_id)
VALUES ('7a900000-0000-4000-8000-0000000000b1', :T, '7a900000-0000-4000-8000-0000000000c9',
        '7a900000-0000-4000-8000-000000000091', 'ক', '7a900000-0000-4000-8000-0000000000d2');

INSERT INTO subjects (id, tenant_id, nctb_code, name_bn, name_en, is_practical)
VALUES ('7a900000-0000-4000-8000-000000000137', :T, '137', 'রসায়ন ব্যবহারিক', 'Chem Practical', true);

INSERT INTO period_templates (id, tenant_id, name_bn, shift, effective_from)
VALUES ('7a900000-0000-4000-8000-0000000000e1', :T, 'নিয়মিত', 'single', '2026-01-01');
-- p1 and p2 abut; tiffin separates p2 from p3.
INSERT INTO period_definitions (id, tenant_id, template_id, period_no, label_bn, starts_at, ends_at, kind) VALUES
  ('7a900000-0000-4000-8000-0000000000f1', :T, '7a900000-0000-4000-8000-0000000000e1', 1, '১ম', '09:00', '09:45', 'teaching'),
  ('7a900000-0000-4000-8000-0000000000f2', :T, '7a900000-0000-4000-8000-0000000000e1', 2, '২য়', '09:45', '10:30', 'teaching'),
  ('7a900000-0000-4000-8000-0000000000f3', :T, '7a900000-0000-4000-8000-0000000000e1', 3, '৩য়', '11:00', '11:45', 'teaching');

INSERT INTO routines (id, tenant_id, academic_year_id, period_template_id, name_bn, status, effective_from)
VALUES ('7a900000-0000-4000-8000-00000000a001', :T, '7a900000-0000-4000-8000-000000000091',
        '7a900000-0000-4000-8000-0000000000e1', 'রুটিন', 'active', '2026-01-01');

-- ---------------------------------------------------------------------
-- 1. A well-formed double is accepted: two contiguous halves, one day,
--    one teacher, one lab.
-- ---------------------------------------------------------------------
DO $$
BEGIN
  INSERT INTO routine_slots
    (tenant_id, routine_id, day_of_week, period_no, period_definition_id,
     starts_at, ends_at, primary_section_id, subject_id, teacher_id, room_id,
     is_double, double_group_id) VALUES
    (app.current_tenant(), '7a900000-0000-4000-8000-00000000a001', 0, 1,
     '7a900000-0000-4000-8000-0000000000f1', '09:00', '09:45',
     '7a900000-0000-4000-8000-0000000000b1', '7a900000-0000-4000-8000-000000000137',
     '7a900000-0000-4000-8000-0000000000a1', '7a900000-0000-4000-8000-0000000000d1',
     true, '7a900000-0000-4000-8000-00000000dd01'),
    (app.current_tenant(), '7a900000-0000-4000-8000-00000000a001', 0, 2,
     '7a900000-0000-4000-8000-0000000000f2', '09:45', '10:30',
     '7a900000-0000-4000-8000-0000000000b1', '7a900000-0000-4000-8000-000000000137',
     '7a900000-0000-4000-8000-0000000000a1', '7a900000-0000-4000-8000-0000000000d1',
     true, '7a900000-0000-4000-8000-00000000dd01');
  SET CONSTRAINTS trg_double_period_coherent IMMEDIATE;
  RAISE NOTICE 'PASS 1 — a contiguous double in one lab with one teacher is accepted';
END $$;

-- ---------------------------------------------------------------------
-- 2. THE ONE THAT MATTERS. Halves separated by tiffin are refused. This
--    is the clause F-504 states by name, and the difference between a
--    practical that happens and one that cannot.
-- ---------------------------------------------------------------------
DO $$
BEGIN
  BEGIN
    INSERT INTO routine_slots
      (tenant_id, routine_id, day_of_week, period_no, period_definition_id,
       starts_at, ends_at, primary_section_id, subject_id, teacher_id, room_id,
       is_double, double_group_id) VALUES
      (app.current_tenant(), '7a900000-0000-4000-8000-00000000a001', 1, 2,
       '7a900000-0000-4000-8000-0000000000f2', '09:45', '10:30',
       '7a900000-0000-4000-8000-0000000000b1', '7a900000-0000-4000-8000-000000000137',
       '7a900000-0000-4000-8000-0000000000a1', '7a900000-0000-4000-8000-0000000000d1',
       true, '7a900000-0000-4000-8000-00000000dd02'),
      (app.current_tenant(), '7a900000-0000-4000-8000-00000000a001', 1, 3,
       '7a900000-0000-4000-8000-0000000000f3', '11:00', '11:45',
       '7a900000-0000-4000-8000-0000000000b1', '7a900000-0000-4000-8000-000000000137',
       '7a900000-0000-4000-8000-0000000000a1', '7a900000-0000-4000-8000-0000000000d1',
       true, '7a900000-0000-4000-8000-00000000dd02');
    SET CONSTRAINTS trg_double_period_coherent IMMEDIATE;
    RAISE EXCEPTION 'FAIL 2: a double across tiffin was accepted';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;
  RAISE NOTICE 'PASS 2 — a double across tiffin is two singles wearing a label, and refused';
END $$;

-- ---------------------------------------------------------------------
-- 3. Halves with different teachers are refused. One practical, one
--    person responsible for the apparatus.
-- ---------------------------------------------------------------------
DO $$
BEGIN
  BEGIN
    INSERT INTO routine_slots
      (tenant_id, routine_id, day_of_week, period_no, period_definition_id,
       starts_at, ends_at, primary_section_id, subject_id, teacher_id, room_id,
       is_double, double_group_id) VALUES
      (app.current_tenant(), '7a900000-0000-4000-8000-00000000a001', 2, 1,
       '7a900000-0000-4000-8000-0000000000f1', '09:00', '09:45',
       '7a900000-0000-4000-8000-0000000000b1', '7a900000-0000-4000-8000-000000000137',
       '7a900000-0000-4000-8000-0000000000a1', '7a900000-0000-4000-8000-0000000000d1',
       true, '7a900000-0000-4000-8000-00000000dd03'),
      (app.current_tenant(), '7a900000-0000-4000-8000-00000000a001', 2, 2,
       '7a900000-0000-4000-8000-0000000000f2', '09:45', '10:30',
       '7a900000-0000-4000-8000-0000000000b1', '7a900000-0000-4000-8000-000000000137',
       '7a900000-0000-4000-8000-0000000000a2', '7a900000-0000-4000-8000-0000000000d1',
       true, '7a900000-0000-4000-8000-00000000dd03');
    SET CONSTRAINTS trg_double_period_coherent IMMEDIATE;
    RAISE EXCEPTION 'FAIL 3: a double with two different teachers was accepted';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;
  RAISE NOTICE 'PASS 3 — the two halves must share a teacher';
END $$;

-- ---------------------------------------------------------------------
-- 4. A lone half is refused. Half a practical is not a practical.
-- ---------------------------------------------------------------------
DO $$
BEGIN
  BEGIN
    INSERT INTO routine_slots
      (tenant_id, routine_id, day_of_week, period_no, period_definition_id,
       starts_at, ends_at, primary_section_id, subject_id, teacher_id, room_id,
       is_double, double_group_id) VALUES
      (app.current_tenant(), '7a900000-0000-4000-8000-00000000a001', 3, 1,
       '7a900000-0000-4000-8000-0000000000f1', '09:00', '09:45',
       '7a900000-0000-4000-8000-0000000000b1', '7a900000-0000-4000-8000-000000000137',
       '7a900000-0000-4000-8000-0000000000a1', '7a900000-0000-4000-8000-0000000000d1',
       true, '7a900000-0000-4000-8000-00000000dd04');
    SET CONSTRAINTS trg_double_period_coherent IMMEDIATE;
    RAISE EXCEPTION 'FAIL 4: a one-half double was accepted';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;
  RAISE NOTICE 'PASS 4 — a double is exactly two halves, never one';
END $$;

-- ---------------------------------------------------------------------
-- 5. is_double with no group is refused outright — a label with nothing
--    behind it.
-- ---------------------------------------------------------------------
DO $$
BEGIN
  BEGIN
    INSERT INTO routine_slots
      (tenant_id, routine_id, day_of_week, period_no, period_definition_id,
       starts_at, ends_at, primary_section_id, subject_id, teacher_id, room_id, is_double)
    VALUES
      (app.current_tenant(), '7a900000-0000-4000-8000-00000000a001', 4, 1,
       '7a900000-0000-4000-8000-0000000000f1', '09:00', '09:45',
       '7a900000-0000-4000-8000-0000000000b1', '7a900000-0000-4000-8000-000000000137',
       '7a900000-0000-4000-8000-0000000000a1', '7a900000-0000-4000-8000-0000000000d1',
       true);
    RAISE EXCEPTION 'FAIL 5: is_double with no group was accepted';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;
  RAISE NOTICE 'PASS 5 — is_double must name which double it belongs to';
END $$;

ROLLBACK;

RESET ROLE;

DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM tenants WHERE id = '7a900000-0000-4000-8000-00000000000a';
  IF n <> 0 THEN RAISE EXCEPTION 'FAIL teardown: the fixture tenant survived'; END IF;
  RAISE NOTICE 'PASS teardown — no fixture rows remain';
END $$;

\echo ''
\echo '================================================'
\echo ' F-504 double periods passed.'
\echo '================================================'
