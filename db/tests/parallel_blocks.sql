-- =====================================================================
-- db/tests/parallel_blocks.sql   (F-504)
--
-- The guarantee, not the solver's care about it. A section may hold
-- several slots at one hour ONLY when they are alternatives from the same
-- selection pool — religion variants, or optional subjects. Anything else
-- at that hour puts the whole section in two places.
--
-- Migration 006's exclusion constraint could not tell the two apart and
-- rejected both, which is why a four-way religion split was unschedulable.
--
-- Runs in a transaction that is ROLLED BACK; safe against any environment.
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/tests/parallel_blocks.sql
-- =====================================================================

\set ON_ERROR_STOP on

GRANT shikhon_app TO CURRENT_USER;
SET ROLE shikhon_app;

\set T '''7a800000-0000-4000-8000-00000000000a'''

BEGIN;
SET LOCAL app.tenant_id = '7a800000-0000-4000-8000-00000000000a';
SET LOCAL app.role      = 'academic_coordinator';
SET LOCAL app.user_id   = '7a800000-0000-4000-8000-0000000000ff';

INSERT INTO tenants (id, slug, name_bn, name_en, stream, level)
VALUES (:T, 'parallel', 'সমান্তরাল বিদ্যালয়', 'Parallel School', 'bangla_medium', 'secondary');

INSERT INTO users (id, tenant_id, full_name_bn, full_name_en, phone_e164) VALUES
  ('7a800000-0000-4000-8000-0000000000ff', :T, 'সমন্বয়ক', 'Coordinator', '+8801798100001'),
  ('7a800000-0000-4000-8000-0000000000a1', :T, 'শিক্ষক ১', 'T1', '+8801798100002'),
  ('7a800000-0000-4000-8000-0000000000a2', :T, 'শিক্ষক ২', 'T2', '+8801798100003'),
  ('7a800000-0000-4000-8000-0000000000a3', :T, 'শিক্ষক ৩', 'T3', '+8801798100004');

INSERT INTO academic_years (id, tenant_id, label, starts_on, ends_on, is_current)
VALUES ('7a800000-0000-4000-8000-000000000091', :T, '2026', '2026-01-01', '2026-12-31', true);

INSERT INTO classes (id, tenant_id, level_no, name_bn, name_en, stream)
VALUES ('7a800000-0000-4000-8000-0000000000c9', :T, 9, 'নবম', 'Nine', 'bangla_medium');

INSERT INTO rooms (id, tenant_id, code, name_bn, capacity) VALUES
  ('7a800000-0000-4000-8000-0000000000d1', :T, '201', 'কক্ষ ২০১', 60),
  ('7a800000-0000-4000-8000-0000000000d2', :T, '202', 'কক্ষ ২০২', 60),
  ('7a800000-0000-4000-8000-0000000000d3', :T, '203', 'কক্ষ ২০৩', 60);

INSERT INTO sections (id, tenant_id, class_id, academic_year_id, name, home_room_id)
VALUES ('7a800000-0000-4000-8000-0000000000b1', :T, '7a800000-0000-4000-8000-0000000000c9',
        '7a800000-0000-4000-8000-000000000091', 'ক', '7a800000-0000-4000-8000-0000000000d1');

INSERT INTO subjects (id, tenant_id, nctb_code, name_bn, name_en) VALUES
  ('7a800000-0000-4000-8000-000000000111', :T, '111', 'ইসলাম শিক্ষা', 'Islamic Studies'),
  ('7a800000-0000-4000-8000-000000000112', :T, '112', 'হিন্দুধর্ম',    'Hindu Studies'),
  ('7a800000-0000-4000-8000-000000000101', :T, '101', 'বাংলা',        'Bangla');

INSERT INTO period_templates (id, tenant_id, name_bn, shift, effective_from)
VALUES ('7a800000-0000-4000-8000-0000000000e1', :T, 'নিয়মিত', 'single', '2026-01-01');
INSERT INTO period_definitions (id, tenant_id, template_id, period_no, label_bn, starts_at, ends_at, kind)
VALUES ('7a800000-0000-4000-8000-0000000000f1', :T, '7a800000-0000-4000-8000-0000000000e1',
        1, '১ম', '09:00', '09:45', 'teaching');

-- ACTIVE, deliberately. Migration 032 exempts draft routines from the
-- teacher and room constraints so a coordinator can build next term's
-- timetable beside the one being taught — which means assertion 5 below
-- would pass vacuously against a draft.
INSERT INTO routines (id, tenant_id, academic_year_id, period_template_id, name_bn, status, effective_from)
VALUES ('7a800000-0000-4000-8000-00000000a001', :T, '7a800000-0000-4000-8000-000000000091',
        '7a800000-0000-4000-8000-0000000000e1', 'রুটিন', 'active', '2026-01-01');

-- Islamic Studies, Sunday period 1, as part of the religion pool.
INSERT INTO routine_slots
  (id, tenant_id, routine_id, day_of_week, period_no, period_definition_id,
   starts_at, ends_at, primary_section_id, subject_id, teacher_id, room_id, parallel_pool)
VALUES ('7a800000-0000-4000-8000-00000000c001', :T, '7a800000-0000-4000-8000-00000000a001',
        0, 1, '7a800000-0000-4000-8000-0000000000f1', '09:00', '09:45',
        '7a800000-0000-4000-8000-0000000000b1', '7a800000-0000-4000-8000-000000000111',
        '7a800000-0000-4000-8000-0000000000a1', '7a800000-0000-4000-8000-0000000000d1',
        'religion');

-- ---------------------------------------------------------------------
-- 1. THE ONE THAT MATTERS. A second religion variant at the same hour is
--    ACCEPTED. Under migration 006 this insert was rejected, which is why
--    a four-way split could not be scheduled at all.
-- ---------------------------------------------------------------------
DO $$
BEGIN
  INSERT INTO routine_slots
    (id, tenant_id, routine_id, day_of_week, period_no, period_definition_id,
     starts_at, ends_at, primary_section_id, subject_id, teacher_id, room_id, parallel_pool)
  VALUES ('7a800000-0000-4000-8000-00000000c002', app.current_tenant(),
          '7a800000-0000-4000-8000-00000000a001', 0, 1,
          '7a800000-0000-4000-8000-0000000000f1', '09:00', '09:45',
          '7a800000-0000-4000-8000-0000000000b1', '7a800000-0000-4000-8000-000000000112',
          '7a800000-0000-4000-8000-0000000000a2', '7a800000-0000-4000-8000-0000000000d2',
          'religion');
  RAISE NOTICE 'PASS 1 — two religion variants share one hour, as F-504 requires';
END $$;

-- ---------------------------------------------------------------------
-- 2. An ORDINARY class at that hour is still refused. The whole section
--    would be in two places, which is what 006 was right about.
-- ---------------------------------------------------------------------
DO $$
DECLARE msg text;
BEGIN
  BEGIN
    INSERT INTO routine_slots
      (tenant_id, routine_id, day_of_week, period_no, period_definition_id,
       starts_at, ends_at, primary_section_id, subject_id, teacher_id, room_id)
    VALUES (app.current_tenant(), '7a800000-0000-4000-8000-00000000a001', 0, 1,
            '7a800000-0000-4000-8000-0000000000f1', '09:00', '09:45',
            '7a800000-0000-4000-8000-0000000000b1', '7a800000-0000-4000-8000-000000000101',
            '7a800000-0000-4000-8000-0000000000a3', '7a800000-0000-4000-8000-0000000000d3');
    RAISE EXCEPTION 'FAIL 2: an ordinary class was scheduled over a parallel block';
  EXCEPTION WHEN exclusion_violation THEN
    GET STACKED DIAGNOSTICS msg = MESSAGE_TEXT;
  END;
  IF msg NOT LIKE '%ক%' THEN
    RAISE EXCEPTION 'FAIL 2: the error does not name the section: %', msg;
  END IF;
  RAISE NOTICE 'PASS 2 — an ordinary class cannot share the hour, and the error names শাখা ক';
END $$;

-- ---------------------------------------------------------------------
-- 3. A DIFFERENT pool at that hour is refused too. Religion and the
--    optional-subject split are both blocks, and running them together
--    would need every student in two rooms.
-- ---------------------------------------------------------------------
DO $$
BEGIN
  BEGIN
    INSERT INTO routine_slots
      (tenant_id, routine_id, day_of_week, period_no, period_definition_id,
       starts_at, ends_at, primary_section_id, subject_id, teacher_id, room_id, parallel_pool)
    VALUES (app.current_tenant(), '7a800000-0000-4000-8000-00000000a001', 0, 1,
            '7a800000-0000-4000-8000-0000000000f1', '09:00', '09:45',
            '7a800000-0000-4000-8000-0000000000b1', '7a800000-0000-4000-8000-000000000101',
            '7a800000-0000-4000-8000-0000000000a3', '7a800000-0000-4000-8000-0000000000d3',
            'fourth_subject');
    RAISE EXCEPTION 'FAIL 3: two different pools were scheduled at one hour';
  EXCEPTION WHEN exclusion_violation THEN
    NULL;
  END;
  RAISE NOTICE 'PASS 3 — two different pools cannot share an hour';
END $$;

-- ---------------------------------------------------------------------
-- 4. The same subject twice in one block is a duplicate, not an
--    alternative.
-- ---------------------------------------------------------------------
DO $$
BEGIN
  BEGIN
    INSERT INTO routine_slots
      (tenant_id, routine_id, day_of_week, period_no, period_definition_id,
       starts_at, ends_at, primary_section_id, subject_id, teacher_id, room_id, parallel_pool)
    VALUES (app.current_tenant(), '7a800000-0000-4000-8000-00000000a001', 0, 1,
            '7a800000-0000-4000-8000-0000000000f1', '09:00', '09:45',
            '7a800000-0000-4000-8000-0000000000b1', '7a800000-0000-4000-8000-000000000111',
            '7a800000-0000-4000-8000-0000000000a3', '7a800000-0000-4000-8000-0000000000d3',
            'religion');
    RAISE EXCEPTION 'FAIL 4: the same subject appeared twice in one block';
  EXCEPTION WHEN unique_violation THEN
    NULL;
  END;
  RAISE NOTICE 'PASS 4 — the same subject cannot appear twice in one block';
END $$;

-- ---------------------------------------------------------------------
-- 5. The teacher and room constraints are untouched: two members of a
--    block still cannot share a teacher or a room. The block exemption is
--    about the SECTION only — a section splits into groups, a teacher
--    does not.
-- ---------------------------------------------------------------------
DO $$
BEGIN
  BEGIN
    INSERT INTO routine_slots
      (tenant_id, routine_id, day_of_week, period_no, period_definition_id,
       starts_at, ends_at, primary_section_id, subject_id, teacher_id, room_id, parallel_pool)
    VALUES (app.current_tenant(), '7a800000-0000-4000-8000-00000000a001', 0, 1,
            '7a800000-0000-4000-8000-0000000000f1', '09:00', '09:45',
            '7a800000-0000-4000-8000-0000000000b1', '7a800000-0000-4000-8000-000000000101',
            '7a800000-0000-4000-8000-0000000000a1',   -- already teaching Islamic Studies
            '7a800000-0000-4000-8000-0000000000d3', 'religion');
    RAISE EXCEPTION 'FAIL 5: one teacher was placed in two groups of a block';
  EXCEPTION WHEN exclusion_violation THEN
    NULL;
  END;
  RAISE NOTICE 'PASS 5 — a block member still cannot share a teacher';
END $$;

-- ---------------------------------------------------------------------
-- 6. Two ORDINARY classes still collide. The common case keeps its
--    constraint rather than depending on the trigger.
-- ---------------------------------------------------------------------
DO $$
BEGIN
  INSERT INTO routine_slots
    (tenant_id, routine_id, day_of_week, period_no, period_definition_id,
     starts_at, ends_at, primary_section_id, subject_id, teacher_id, room_id)
  VALUES (app.current_tenant(), '7a800000-0000-4000-8000-00000000a001', 2, 1,
          '7a800000-0000-4000-8000-0000000000f1', '09:00', '09:45',
          '7a800000-0000-4000-8000-0000000000b1', '7a800000-0000-4000-8000-000000000101',
          '7a800000-0000-4000-8000-0000000000a1', '7a800000-0000-4000-8000-0000000000d1');
  BEGIN
    INSERT INTO routine_slots
      (tenant_id, routine_id, day_of_week, period_no, period_definition_id,
       starts_at, ends_at, primary_section_id, subject_id, teacher_id, room_id)
    VALUES (app.current_tenant(), '7a800000-0000-4000-8000-00000000a001', 2, 1,
            '7a800000-0000-4000-8000-0000000000f1', '09:00', '09:45',
            '7a800000-0000-4000-8000-0000000000b1', '7a800000-0000-4000-8000-000000000111',
            '7a800000-0000-4000-8000-0000000000a2', '7a800000-0000-4000-8000-0000000000d2');
    RAISE EXCEPTION 'FAIL 6: a section was double-booked with two ordinary classes';
  EXCEPTION WHEN exclusion_violation THEN
    NULL;
  END;
  RAISE NOTICE 'PASS 6 — two ordinary classes still cannot share a section and an hour';
END $$;

ROLLBACK;

RESET ROLE;

DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM tenants WHERE id = '7a800000-0000-4000-8000-00000000000a';
  IF n <> 0 THEN RAISE EXCEPTION 'FAIL teardown: the fixture tenant survived'; END IF;
  RAISE NOTICE 'PASS teardown — no fixture rows remain';
END $$;

\echo ''
\echo '================================================'
\echo ' F-504 parallel blocks passed.'
\echo '================================================'
