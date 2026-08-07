-- =====================================================================
-- db/tests/invariants.sql
-- Asserts the three guarantees the schema is supposed to provide.
-- Any RAISE EXCEPTION here is a release blocker.
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/tests/invariants.sql
-- =====================================================================

\set ON_ERROR_STOP on

GRANT shikhon_app TO CURRENT_USER;

-- Fixed UUIDs so the assertions are readable.
\set tA  '''11111111-1111-4111-8111-111111111111'''
\set tB  '''22222222-2222-4222-8222-222222222222'''

-- ---------------------------------------------------------------------
-- Seed two tenants, each with a teacher, room, section and period.
-- ---------------------------------------------------------------------
SET ROLE shikhon_app;

BEGIN;
SET LOCAL app.tenant_id = '11111111-1111-4111-8111-111111111111';
SET LOCAL app.role      = 'principal';

INSERT INTO tenants (id, slug, name_bn, name_en, stream, level)
VALUES (:tA, 'tenant-a', 'ক প্রতিষ্ঠান', 'Tenant A', 'bangla_medium', 'secondary');

INSERT INTO users (id, tenant_id, full_name_bn, full_name_en, phone_e164)
VALUES ('aaaaaaaa-0000-4000-8000-000000000001', :tA, 'রহিম', 'Rahim', '+8801711111111'),
       ('aaaaaaaa-0000-4000-8000-000000000002', :tA, 'সালমা', 'Salma', '+8801711111112');

INSERT INTO academic_years (id, tenant_id, label, starts_on, ends_on, is_current)
VALUES ('aaaaaaaa-0000-4000-8000-00000000000a', :tA, '2026', '2026-01-01', '2026-12-31', true);

INSERT INTO classes (id, tenant_id, level_no, name_bn, name_en, stream)
VALUES ('aaaaaaaa-0000-4000-8000-00000000000b', :tA, 9, 'নবম', 'Nine', 'bangla_medium');

INSERT INTO sections (id, tenant_id, class_id, academic_year_id, name)
VALUES ('aaaaaaaa-0000-4000-8000-00000000000c', :tA,
        'aaaaaaaa-0000-4000-8000-00000000000b', 'aaaaaaaa-0000-4000-8000-00000000000a', 'ক'),
       ('aaaaaaaa-0000-4000-8000-00000000000d', :tA,
        'aaaaaaaa-0000-4000-8000-00000000000b', 'aaaaaaaa-0000-4000-8000-00000000000a', 'খ');

INSERT INTO rooms (id, tenant_id, code, capacity)
VALUES ('aaaaaaaa-0000-4000-8000-00000000000e', :tA, '204', 60);

INSERT INTO subjects (id, tenant_id, nctb_code, name_bn, name_en)
VALUES ('aaaaaaaa-0000-4000-8000-00000000000f', :tA, '136', 'পদার্থবিজ্ঞান', 'Physics'),
       ('aaaaaaaa-0000-4000-8000-000000000010', :tA, '101', 'বাংলা', 'Bangla');

INSERT INTO period_templates (id, tenant_id, name_bn, effective_from)
VALUES ('aaaaaaaa-0000-4000-8000-000000000011', :tA, 'নিয়মিত', '2026-01-01');

INSERT INTO period_definitions (id, tenant_id, template_id, period_no, label_bn, starts_at, ends_at)
VALUES ('aaaaaaaa-0000-4000-8000-000000000012', :tA, 'aaaaaaaa-0000-4000-8000-000000000011',
        3, '৩য়', '10:20', '11:00');

INSERT INTO routines (id, tenant_id, academic_year_id, period_template_id, name_bn,
                      status, effective_from)
VALUES ('aaaaaaaa-0000-4000-8000-000000000013', :tA, 'aaaaaaaa-0000-4000-8000-00000000000a',
        'aaaaaaaa-0000-4000-8000-000000000011', 'রুটিন ২০২৬', 'active', '2026-01-01');
COMMIT;

BEGIN;
SET LOCAL app.tenant_id = '22222222-2222-4222-8222-222222222222';
SET LOCAL app.role      = 'principal';
INSERT INTO tenants (id, slug, name_bn, name_en, stream, level)
VALUES (:tB, 'tenant-b', 'খ প্রতিষ্ঠান', 'Tenant B', 'madrasah', 'secondary');
INSERT INTO users (id, tenant_id, full_name_bn, full_name_en, phone_e164)
VALUES ('bbbbbbbb-0000-4000-8000-000000000001', :tB, 'করিম', 'Karim', '+8801722222221');
COMMIT;

-- =====================================================================
-- INVARIANT 1 — Tenant isolation
-- =====================================================================
BEGIN;
SET LOCAL app.tenant_id = '11111111-1111-4111-8111-111111111111';
SET LOCAL app.role      = 'principal';

DO $$
DECLARE n integer;
BEGIN
  -- 1a. Tenant A cannot see Tenant B's users.
  SELECT count(*) INTO n FROM users
   WHERE tenant_id = '22222222-2222-4222-8222-222222222222';
  IF n <> 0 THEN RAISE EXCEPTION 'FAIL 1a: cross-tenant SELECT returned % rows', n; END IF;

  -- 1b. Tenant A sees exactly its own users.
  SELECT count(*) INTO n FROM users;
  IF n <> 2 THEN RAISE EXCEPTION 'FAIL 1b: expected 2 own users, got %', n; END IF;

  -- 1c. Cross-tenant UPDATE affects nothing.
  UPDATE users SET full_name_en = 'HACKED'
   WHERE tenant_id = '22222222-2222-4222-8222-222222222222';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 0 THEN RAISE EXCEPTION 'FAIL 1c: cross-tenant UPDATE affected % rows', n; END IF;

  -- 1d. Cross-tenant DELETE affects nothing.
  DELETE FROM users WHERE tenant_id = '22222222-2222-4222-8222-222222222222';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 0 THEN RAISE EXCEPTION 'FAIL 1d: cross-tenant DELETE affected % rows', n; END IF;

  -- 1e. tenants table itself is scoped to self.
  SELECT count(*) INTO n FROM tenants;
  IF n <> 1 THEN RAISE EXCEPTION 'FAIL 1e: expected 1 visible tenant, got %', n; END IF;

  RAISE NOTICE 'PASS 1 — tenant isolation (a-e)';
END $$;

-- 1f. Explicitly writing another tenant's id is blocked by the trigger.
DO $$
BEGIN
  INSERT INTO users (tenant_id, full_name_bn, full_name_en, phone_e164)
  VALUES ('22222222-2222-4222-8222-222222222222', 'x', 'x', '+8801799999999');
  RAISE EXCEPTION 'FAIL 1f: cross-tenant INSERT was allowed';
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'PASS 1f — cross-tenant INSERT blocked';
END $$;
COMMIT;

-- 1g. Fail-closed: no tenant context ⇒ no rows, not all rows.
BEGIN;
DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM users;
  IF n <> 0 THEN RAISE EXCEPTION 'FAIL 1g: no-context read returned % rows (must fail closed)', n; END IF;
  RAISE NOTICE 'PASS 1g — fail-closed with no tenant context';
END $$;
COMMIT;

-- 1h. Pre-tenant ingest: a webhook arriving before its tenant is known must
--     be writable and readable by the ingest worker, and by nobody else.
BEGIN;
SET LOCAL app.role = 'system_ingest';
INSERT INTO mfs_webhook_events (provider, provider_event_id, raw_body, event_type)
VALUES ('bkash', 'evt_test_0001', '{"amount":"1250.00"}', 'payment.execute.success');
DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM mfs_webhook_events WHERE provider_event_id = 'evt_test_0001';
  IF n <> 1 THEN RAISE EXCEPTION 'FAIL 1h: ingest worker cannot read its own webhook row'; END IF;
  RAISE NOTICE 'PASS 1h — unattributed webhook row visible to system_ingest';
END $$;
COMMIT;

BEGIN;
SET LOCAL app.tenant_id = '11111111-1111-4111-8111-111111111111';
SET LOCAL app.role      = 'principal';
DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM mfs_webhook_events WHERE provider_event_id = 'evt_test_0001';
  IF n <> 0 THEN RAISE EXCEPTION 'FAIL 1i: unattributed webhook leaked to a tenant session'; END IF;
  RAISE NOTICE 'PASS 1i — unattributed webhook NOT visible to a tenant session';
END $$;
COMMIT;

-- =====================================================================
-- INVARIANT 2 — Routine clash prevention (GiST exclusion constraints)
-- =====================================================================
BEGIN;
SET LOCAL app.tenant_id = '11111111-1111-4111-8111-111111111111';
SET LOCAL app.role      = 'academic_coordinator';

-- Baseline slot: Rahim teaches Physics to 9-ক in room 204, Sunday period 3.
INSERT INTO routine_slots
  (id, tenant_id, routine_id, day_of_week, period_no, period_definition_id,
   starts_at, ends_at, slot_kind, primary_section_id, subject_id, teacher_id, room_id)
VALUES ('aaaaaaaa-0000-4000-8000-000000000020', :tA, 'aaaaaaaa-0000-4000-8000-000000000013',
        0, 3, 'aaaaaaaa-0000-4000-8000-000000000012', '10:20', '11:00', 'teaching',
        'aaaaaaaa-0000-4000-8000-00000000000c', 'aaaaaaaa-0000-4000-8000-00000000000f',
        'aaaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-00000000000e');

-- 2a. Same teacher, overlapping time, different section ⇒ must be rejected.
DO $$
BEGIN
  INSERT INTO routine_slots
    (tenant_id, routine_id, day_of_week, period_no, period_definition_id,
     starts_at, ends_at, slot_kind, primary_section_id, subject_id, teacher_id)
  VALUES ('11111111-1111-4111-8111-111111111111', 'aaaaaaaa-0000-4000-8000-000000000013',
          0, 3, 'aaaaaaaa-0000-4000-8000-000000000012', '10:40', '11:20', 'teaching',
          'aaaaaaaa-0000-4000-8000-00000000000d', 'aaaaaaaa-0000-4000-8000-000000000010',
          'aaaaaaaa-0000-4000-8000-000000000001');
  RAISE EXCEPTION 'FAIL 2a: teacher double-booking was allowed';
EXCEPTION WHEN exclusion_violation THEN
  RAISE NOTICE 'PASS 2a — teacher double-booking rejected (partial time overlap)';
END $$;

-- 2b. Same room, overlapping time, different teacher ⇒ must be rejected.
DO $$
BEGIN
  INSERT INTO routine_slots
    (tenant_id, routine_id, day_of_week, period_no, period_definition_id,
     starts_at, ends_at, slot_kind, primary_section_id, subject_id, teacher_id, room_id)
  VALUES ('11111111-1111-4111-8111-111111111111', 'aaaaaaaa-0000-4000-8000-000000000013',
          0, 3, 'aaaaaaaa-0000-4000-8000-000000000012', '10:50', '11:30', 'teaching',
          'aaaaaaaa-0000-4000-8000-00000000000d', 'aaaaaaaa-0000-4000-8000-000000000010',
          'aaaaaaaa-0000-4000-8000-000000000002', 'aaaaaaaa-0000-4000-8000-00000000000e');
  RAISE EXCEPTION 'FAIL 2b: room double-booking was allowed';
EXCEPTION WHEN exclusion_violation THEN
  RAISE NOTICE 'PASS 2b — room double-booking rejected';
END $$;

-- 2c. Same section, overlapping time ⇒ must be rejected.
DO $$
BEGIN
  INSERT INTO routine_slots
    (tenant_id, routine_id, day_of_week, period_no, period_definition_id,
     starts_at, ends_at, slot_kind, primary_section_id, subject_id, teacher_id)
  VALUES ('11111111-1111-4111-8111-111111111111', 'aaaaaaaa-0000-4000-8000-000000000013',
          0, 3, 'aaaaaaaa-0000-4000-8000-000000000012', '10:20', '11:00', 'teaching',
          'aaaaaaaa-0000-4000-8000-00000000000c', 'aaaaaaaa-0000-4000-8000-000000000010',
          'aaaaaaaa-0000-4000-8000-000000000002');
  RAISE EXCEPTION 'FAIL 2c: section double-booking was allowed';
EXCEPTION WHEN exclusion_violation THEN
  RAISE NOTICE 'PASS 2c — section double-booking rejected';
END $$;

-- 2d. Non-overlapping time for the same teacher ⇒ must be ACCEPTED.
DO $$
BEGIN
  INSERT INTO routine_slots
    (tenant_id, routine_id, day_of_week, period_no, period_definition_id,
     starts_at, ends_at, slot_kind, primary_section_id, subject_id, teacher_id)
  VALUES ('11111111-1111-4111-8111-111111111111', 'aaaaaaaa-0000-4000-8000-000000000013',
          0, 4, 'aaaaaaaa-0000-4000-8000-000000000012', '11:00', '11:40', 'teaching',
          'aaaaaaaa-0000-4000-8000-00000000000d', 'aaaaaaaa-0000-4000-8000-000000000010',
          'aaaaaaaa-0000-4000-8000-000000000001');
  RAISE NOTICE 'PASS 2d — adjacent (non-overlapping) slot accepted';
END $$;

-- 2e. Same teacher, same time, DIFFERENT day ⇒ must be ACCEPTED.
DO $$
BEGIN
  INSERT INTO routine_slots
    (tenant_id, routine_id, day_of_week, period_no, period_definition_id,
     starts_at, ends_at, slot_kind, primary_section_id, subject_id, teacher_id)
  VALUES ('11111111-1111-4111-8111-111111111111', 'aaaaaaaa-0000-4000-8000-000000000013',
          1, 3, 'aaaaaaaa-0000-4000-8000-000000000012', '10:20', '11:00', 'teaching',
          'aaaaaaaa-0000-4000-8000-00000000000c', 'aaaaaaaa-0000-4000-8000-00000000000f',
          'aaaaaaaa-0000-4000-8000-000000000001');
  RAISE NOTICE 'PASS 2e — same time on a different weekday accepted';
END $$;
ROLLBACK;

-- =====================================================================
-- INVARIANT 3 — NCTB grading rules
-- =====================================================================
BEGIN;
SET LOCAL app.tenant_id = '11111111-1111-4111-8111-111111111111';
SET LOCAL app.role      = 'principal';

INSERT INTO grading_scales (id, tenant_id, name, effective_from, is_default)
VALUES ('aaaaaaaa-0000-4000-8000-000000000030', :tA, 'BD Board', '2026-01-01', true);

INSERT INTO grading_bands (tenant_id, scale_id, min_percent, max_percent, letter, grade_point) VALUES
  (:tA,'aaaaaaaa-0000-4000-8000-000000000030', 80,100,'A+',5.00),
  (:tA,'aaaaaaaa-0000-4000-8000-000000000030', 70, 79.99,'A' ,4.00),
  (:tA,'aaaaaaaa-0000-4000-8000-000000000030', 60, 69.99,'A-',3.50),
  (:tA,'aaaaaaaa-0000-4000-8000-000000000030', 50, 59.99,'B' ,3.00),
  (:tA,'aaaaaaaa-0000-4000-8000-000000000030', 40, 49.99,'C' ,2.00),
  (:tA,'aaaaaaaa-0000-4000-8000-000000000030', 33, 39.99,'D' ,1.00),
  (:tA,'aaaaaaaa-0000-4000-8000-000000000030',  0, 32.99,'F' ,0.00);

DO $$
DECLARE r RECORD;
BEGIN
  -- 3a. Comfortable A+: CQ 60/70, MCQ 25/30 → 85% → A+
  SELECT * INTO r FROM app.compute_subject_grade(
    '11111111-1111-4111-8111-111111111111',
    60, 70, 23, 25, 30, 10, 0, 0, 100, false,
    'aaaaaaaa-0000-4000-8000-000000000030');
  IF r.letter <> 'A+' OR r.grade_point <> 5.00 THEN
    RAISE EXCEPTION 'FAIL 3a: expected A+/5.00, got %/%', r.letter, r.grade_point;
  END IF;
  RAISE NOTICE 'PASS 3a — 85%% ⇒ A+ (5.00)';

  -- 3b. THE RULE MOST SYSTEMS GET WRONG:
  --     total 62/100 (would be A-) but CQ 22 < pass 23 ⇒ F.
  SELECT * INTO r FROM app.compute_subject_grade(
    '11111111-1111-4111-8111-111111111111',
    22, 70, 23, 40, 30, 10, 0, 0, 100, false,
    'aaaaaaaa-0000-4000-8000-000000000030');
  IF r.letter <> 'F' OR NOT r.component_failed THEN
    RAISE EXCEPTION 'FAIL 3b: component-fail not honoured, got %/%', r.letter, r.grade_point;
  END IF;
  RAISE NOTICE 'PASS 3b — CQ below component pass ⇒ F despite a 62%% total';

  -- 3c. MCQ component failure, same rule.
  SELECT * INTO r FROM app.compute_subject_grade(
    '11111111-1111-4111-8111-111111111111',
    65, 70, 23, 9, 30, 10, 0, 0, 100, false,
    'aaaaaaaa-0000-4000-8000-000000000030');
  IF r.letter <> 'F' THEN
    RAISE EXCEPTION 'FAIL 3c: MCQ component-fail not honoured, got %', r.letter;
  END IF;
  RAISE NOTICE 'PASS 3c — MCQ below component pass ⇒ F';

  -- 3d. Absent ⇒ F, no band lookup.
  SELECT * INTO r FROM app.compute_subject_grade(
    '11111111-1111-4111-8111-111111111111',
    NULL, 70, 23, NULL, 30, 10, 0, 0, 100, true,
    'aaaaaaaa-0000-4000-8000-000000000030');
  IF r.letter <> 'F' THEN RAISE EXCEPTION 'FAIL 3d: absent not graded F'; END IF;
  RAISE NOTICE 'PASS 3d — absent ⇒ F';

  -- 3e. Boundary: exactly 33% ⇒ D, exactly 80% ⇒ A+.
  SELECT * INTO r FROM app.compute_subject_grade(
    '11111111-1111-4111-8111-111111111111',
    23, 70, 23, 10, 30, 10, 0, 0, 100, false,
    'aaaaaaaa-0000-4000-8000-000000000030');
  IF r.letter <> 'D' THEN RAISE EXCEPTION 'FAIL 3e: 33%% should be D, got %', r.letter; END IF;
  RAISE NOTICE 'PASS 3e — 33%% boundary ⇒ D';
END $$;
ROLLBACK;

-- =====================================================================
-- TEARDOWN — the suite must leave the database exactly as it found it, so
-- it is safe to run against staging (and, in a pinch, production).
-- Tenant FKs cascade, so deleting the two fixture tenants removes every
-- row seeded above.
-- =====================================================================
BEGIN;
SET LOCAL app.tenant_id = '11111111-1111-4111-8111-111111111111';
SET LOCAL app.role      = 'principal';
DELETE FROM tenants WHERE id = :tA;
COMMIT;

BEGIN;
SET LOCAL app.tenant_id = '22222222-2222-4222-8222-222222222222';
SET LOCAL app.role      = 'principal';
DELETE FROM tenants WHERE id = :tB;
COMMIT;

BEGIN;
SET LOCAL app.role = 'system_ingest';
DELETE FROM mfs_webhook_events WHERE provider_event_id = 'evt_test_0001';
COMMIT;

-- Assert we actually cleaned up.
BEGIN;
SET LOCAL app.role = 'system_ingest';
DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM mfs_webhook_events WHERE provider_event_id = 'evt_test_0001';
  IF n <> 0 THEN RAISE EXCEPTION 'FAIL teardown: webhook fixture row survived'; END IF;
END $$;
COMMIT;

RESET ROLE;

DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM tenants
   WHERE id IN ('11111111-1111-4111-8111-111111111111',
                '22222222-2222-4222-8222-222222222222');
  IF n <> 0 THEN RAISE EXCEPTION 'FAIL teardown: % fixture tenant(s) survived', n; END IF;
  RAISE NOTICE 'PASS teardown — no fixture rows remain';
END $$;

\echo ''
\echo '================================================'
\echo ' All invariants passed.'
\echo '================================================'
