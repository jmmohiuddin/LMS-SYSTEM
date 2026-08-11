-- =====================================================================
-- db/tests/cross_shift.sql   (F-506)
--
-- The PRD calls cross-shift teacher availability "the most common source
-- of real-world routine failure". The fixture is that failure, minimally:
--
--   One school, two shifts. রফিক ইসলাম teaches in both — which is normal;
--   a school with 45 teachers and 1,200 students across two shifts shares
--   staff by design.
--
--   The morning shift's last period runs 12:00–12:45. The day shift's
--   first period runs 12:30–13:15. They overlap by fifteen minutes, and
--   both routines want রফিক in them.
--
-- Migration 006's constraint could not see this: it was scoped to one
-- routine_id, and the two shifts are two routines. Its COMMENT claimed
-- the opposite — "so cross-shift collisions (morning p8 vs day p1) are
-- caught" — which is the case it uniquely missed.
--
-- Runs in a transaction that is ROLLED BACK; safe against any environment.
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/tests/cross_shift.sql
-- =====================================================================

\set ON_ERROR_STOP on

GRANT shikhon_app TO CURRENT_USER;
SET ROLE shikhon_app;

\set T '''7a100000-0000-4000-8000-00000000000a'''

BEGIN;
SET LOCAL app.tenant_id = '7a100000-0000-4000-8000-00000000000a';
SET LOCAL app.role      = 'academic_coordinator';
SET LOCAL app.user_id   = '7a100000-0000-4000-8000-0000000000ff';

INSERT INTO tenants (id, slug, name_bn, name_en, stream, level)
VALUES (:T, 'cross-shift', 'দ্বৈত শিফট বিদ্যালয়', 'Two Shift School', 'bangla_medium', 'secondary');

INSERT INTO users (id, tenant_id, full_name_bn, full_name_en, phone_e164) VALUES
  ('7a100000-0000-4000-8000-0000000000ff', :T, 'সমন্বয়ক',    'Coordinator', '+8801791000001'),
  ('7a100000-0000-4000-8000-0000000000a1', :T, 'রফিক ইসলাম', 'Rafiq Islam', '+8801791000002'),
  ('7a100000-0000-4000-8000-0000000000a2', :T, 'সালমা খাতুন','Salma Khatun','+8801791000003');

INSERT INTO academic_years (id, tenant_id, label, starts_on, ends_on, is_current)
VALUES ('7a100000-0000-4000-8000-000000000091', :T, '2026', '2026-01-01', '2026-12-31', true);

INSERT INTO classes (id, tenant_id, level_no, name_bn, name_en, stream) VALUES
  ('7a100000-0000-4000-8000-0000000000c9', :T, 9, 'নবম', 'Nine', 'bangla_medium'),
  ('7a100000-0000-4000-8000-0000000000c6', :T, 6, 'ষষ্ঠ', 'Six',  'bangla_medium');

-- One section per shift. A section belongs to exactly one shift; a
-- TEACHER is what spans them, and that is the whole problem.
INSERT INTO sections (id, tenant_id, class_id, academic_year_id, name, shift) VALUES
  ('7a100000-0000-4000-8000-0000000000b1', :T, '7a100000-0000-4000-8000-0000000000c9',
   '7a100000-0000-4000-8000-000000000091', 'ক', 'morning'),
  ('7a100000-0000-4000-8000-0000000000b2', :T, '7a100000-0000-4000-8000-0000000000c6',
   '7a100000-0000-4000-8000-000000000091', 'খ', 'day');

INSERT INTO subjects (id, tenant_id, nctb_code, name_bn, name_en) VALUES
  ('7a100000-0000-4000-8000-000000000109', :T, '109', 'বাংলা', 'Bangla'),
  ('7a100000-0000-4000-8000-000000000107', :T, '107', 'গণিত',  'Mathematics');

-- Two rooms. The shifts share the building but not the same door at the
-- same minute — which is the room half of F-506, tested separately below.
INSERT INTO rooms (id, tenant_id, code, name_bn, capacity) VALUES
  ('7a100000-0000-4000-8000-0000000000d1', :T, '204', 'কক্ষ ২০৪', 60),
  ('7a100000-0000-4000-8000-0000000000d2', :T, '205', 'কক্ষ ২০৫', 60);

-- Two period templates. The morning's last period and the day's first
-- overlap by fifteen minutes, which is exactly how a real two-shift
-- timetable is built — the shifts hand over, they do not abut cleanly.
INSERT INTO period_templates (id, tenant_id, name_bn, shift, effective_from) VALUES
  ('7a100000-0000-4000-8000-0000000000e1', :T, 'প্রভাতি', 'morning', '2026-01-01'),
  ('7a100000-0000-4000-8000-0000000000e2', :T, 'দিবা',    'day',     '2026-01-01');

INSERT INTO period_definitions (id, tenant_id, template_id, period_no, label_bn, starts_at, ends_at, kind) VALUES
  ('7a100000-0000-4000-8000-0000000000f1', :T, '7a100000-0000-4000-8000-0000000000e1',
   8, '৮ম', '12:00', '12:45', 'teaching'),
  ('7a100000-0000-4000-8000-0000000000f2', :T, '7a100000-0000-4000-8000-0000000000e2',
   1, '১ম', '12:30', '13:15', 'teaching');

INSERT INTO routines (id, tenant_id, academic_year_id, period_template_id, shift,
                      name_bn, status, effective_from) VALUES
  ('7a100000-0000-4000-8000-00000000a001', :T, '7a100000-0000-4000-8000-000000000091',
   '7a100000-0000-4000-8000-0000000000e1', 'morning', 'প্রভাতি রুটিন', 'active', '2026-01-01'),
  ('7a100000-0000-4000-8000-00000000a002', :T, '7a100000-0000-4000-8000-000000000091',
   '7a100000-0000-4000-8000-0000000000e2', 'day',     'দিবা রুটিন',   'draft',  '2026-01-01');

-- Morning shift, already published: রফিক teaches ৯-ক at 12:00–12:45 on Monday.
INSERT INTO routine_slots
  (tenant_id, routine_id, day_of_week, period_no, period_definition_id,
   starts_at, ends_at, primary_section_id, subject_id, teacher_id, room_id)
VALUES
  (:T, '7a100000-0000-4000-8000-00000000a001', 1, 8, '7a100000-0000-4000-8000-0000000000f1',
   '12:00', '12:45', '7a100000-0000-4000-8000-0000000000b1',
   '7a100000-0000-4000-8000-000000000109', '7a100000-0000-4000-8000-0000000000a1',
   '7a100000-0000-4000-8000-0000000000d1');

-- ---------------------------------------------------------------------
-- 1. The denormalised facts are filled from the parent routine, not by
--    the caller. The constraints below are worth nothing if they are not.
-- ---------------------------------------------------------------------
DO $$
DECLARE yr uuid; st routine_status;
BEGIN
  SELECT academic_year_id, routine_status INTO yr, st
    FROM routine_slots WHERE routine_id = '7a100000-0000-4000-8000-00000000a001';
  IF yr <> '7a100000-0000-4000-8000-000000000091' THEN
    RAISE EXCEPTION 'FAIL 1: academic_year_id was not synced, got %', yr;
  END IF;
  IF st <> 'active' THEN RAISE EXCEPTION 'FAIL 1: routine_status is %', st; END IF;
  RAISE NOTICE 'PASS 1 — the slot carries its routine''s year and status';
END $$;

-- ---------------------------------------------------------------------
-- 2. A DRAFT may still overlap the active routine. This is the
--    requirement 006 scoped to routine_id to protect, and it must survive.
-- ---------------------------------------------------------------------
DO $$
BEGIN
  INSERT INTO routine_slots
    (tenant_id, routine_id, day_of_week, period_no, period_definition_id,
     starts_at, ends_at, primary_section_id, subject_id, teacher_id, room_id)
  VALUES
    (app.current_tenant(), '7a100000-0000-4000-8000-00000000a002', 1, 1,
     '7a100000-0000-4000-8000-0000000000f2', '12:30', '13:15',
     '7a100000-0000-4000-8000-0000000000b2', '7a100000-0000-4000-8000-000000000107',
     '7a100000-0000-4000-8000-0000000000a1', '7a100000-0000-4000-8000-0000000000d2');
  RAISE NOTICE 'PASS 2 — a draft routine may overlap the active one it will replace';
END $$;

-- ---------------------------------------------------------------------
-- 3. THE ONE THAT MATTERS. Publishing the day shift is refused, because
--    রফিক would be teaching ৯-ক and ৬-খ at the same fifteen minutes.
--    Under migration 006 this UPDATE succeeded.
-- ---------------------------------------------------------------------
DO $$
DECLARE msg text;
BEGIN
  BEGIN
    UPDATE routines SET status = 'active'
     WHERE id = '7a100000-0000-4000-8000-00000000a002';
    RAISE EXCEPTION 'FAIL 3: the day shift was published over the morning shift';
  EXCEPTION WHEN check_violation THEN
    GET STACKED DIAGNOSTICS msg = MESSAGE_TEXT;
  END;
  IF msg NOT LIKE '%রফিক ইসলাম%' THEN
    RAISE EXCEPTION 'FAIL 3: the error does not name the teacher: %', msg;
  END IF;
  RAISE NOTICE 'PASS 3 — publication blocked, and the error names রফিক ইসলাম';
END $$;

-- ---------------------------------------------------------------------
-- 4. The report names both sections and the time, per slot, so a
--    coordinator can act rather than hunt.
-- ---------------------------------------------------------------------
DO $$
DECLARE r record;
BEGIN
  SELECT * INTO r FROM app.cross_shift_conflicts('7a100000-0000-4000-8000-00000000a002');
  IF r.teacher_name_bn <> 'রফিক ইসলাম' THEN
    RAISE EXCEPTION 'FAIL 4: conflict attributed to %', r.teacher_name_bn;
  END IF;
  IF r.this_section <> 'খ' OR r.other_section <> 'ক' THEN
    RAISE EXCEPTION 'FAIL 4: sections reported as % / %', r.this_section, r.other_section;
  END IF;
  IF r.other_shift <> 'morning' THEN
    RAISE EXCEPTION 'FAIL 4: the other shift is reported as %', r.other_shift;
  END IF;
  RAISE NOTICE 'PASS 4 — reported as % teaching % against % in the % shift at %',
    r.teacher_name_bn, r.this_section, r.other_section, r.other_shift, r.starts_at;
END $$;

-- ---------------------------------------------------------------------
-- 5. Give the day-shift period to a different teacher and publication
--    succeeds. A gate nobody can get through is a wall.
-- ---------------------------------------------------------------------
DO $$
DECLARE n integer;
BEGIN
  UPDATE routine_slots SET teacher_id = '7a100000-0000-4000-8000-0000000000a2'
   WHERE routine_id = '7a100000-0000-4000-8000-00000000a002';

  SELECT count(*) INTO n FROM app.cross_shift_conflicts('7a100000-0000-4000-8000-00000000a002');
  IF n <> 0 THEN RAISE EXCEPTION 'FAIL 5: % conflict(s) remain', n; END IF;

  UPDATE routines SET status = 'active' WHERE id = '7a100000-0000-4000-8000-00000000a002';
  RAISE NOTICE 'PASS 5 — reassigning the period clears the clash and publication succeeds';
END $$;

-- ---------------------------------------------------------------------
-- 6. Now that BOTH routines are active, the exclusion constraint itself
--    refuses the double-booking — not just the friendly trigger. The
--    trigger is the explanation; the constraint is the guarantee.
-- ---------------------------------------------------------------------
DO $$
BEGIN
  BEGIN
    UPDATE routine_slots SET teacher_id = '7a100000-0000-4000-8000-0000000000a1'
     WHERE routine_id = '7a100000-0000-4000-8000-00000000a002';
    RAISE EXCEPTION 'FAIL 6: a teacher was double-booked across two active shifts';
  EXCEPTION WHEN exclusion_violation THEN
    NULL;
  END;
  RAISE NOTICE 'PASS 6 — the exclusion constraint refuses it independently of the trigger';
END $$;

-- ---------------------------------------------------------------------
-- 7. Rooms too. A two-shift school shares its rooms, and 12:30 in room
--    204 is one door.
-- ---------------------------------------------------------------------
DO $$
BEGIN
  BEGIN
    -- The day shift moves into 204, which the morning shift still holds at
    -- 12:00-12:45. Different routines, different teachers, one door.
    UPDATE routine_slots SET room_id = '7a100000-0000-4000-8000-0000000000d1'
     WHERE routine_id = '7a100000-0000-4000-8000-00000000a002';
    RAISE EXCEPTION 'FAIL 7: room 204 was booked twice at 12:30 across the shifts';
  EXCEPTION WHEN exclusion_violation THEN
    NULL;
  END;
  RAISE NOTICE 'PASS 7 — a shared room cannot be double-booked across shifts either';
END $$;

-- ---------------------------------------------------------------------
-- 8. Times that merely touch are not a clash. The morning shift ending at
--    12:30 and the day shift starting at 12:30 is a school that got its
--    handover right, and must stay legal.
-- ---------------------------------------------------------------------
DO $$
BEGIN
  UPDATE routine_slots SET starts_at = '11:45', ends_at = '12:30'
   WHERE routine_id = '7a100000-0000-4000-8000-00000000a001';
  UPDATE routine_slots SET teacher_id = '7a100000-0000-4000-8000-0000000000a1'
   WHERE routine_id = '7a100000-0000-4000-8000-00000000a002';
  RAISE NOTICE 'PASS 8 — a clean handover at 12:30 is not an overlap';
END $$;

-- ---------------------------------------------------------------------
-- 9. A superseded routine stops constraining anything. Last term's
--    timetable must not block this term's.
-- ---------------------------------------------------------------------
DO $$
DECLARE n integer;
BEGIN
  UPDATE routines SET status = 'superseded'
   WHERE id = '7a100000-0000-4000-8000-00000000a001';

  SELECT count(*) INTO n FROM routine_slots
   WHERE routine_id = '7a100000-0000-4000-8000-00000000a001' AND routine_status = 'superseded';
  IF n = 0 THEN
    RAISE EXCEPTION 'FAIL 9: superseding the routine did not propagate to its slots';
  END IF;

  -- And with the morning routine retired, the overlap is legal again.
  UPDATE routine_slots SET starts_at = '12:00', ends_at = '12:45'
   WHERE routine_id = '7a100000-0000-4000-8000-00000000a001';
  RAISE NOTICE 'PASS 9 — a superseded routine constrains nothing, and status propagates';
END $$;

ROLLBACK;

RESET ROLE;

DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM tenants WHERE id = '7a100000-0000-4000-8000-00000000000a';
  IF n <> 0 THEN RAISE EXCEPTION 'FAIL teardown: the fixture tenant survived'; END IF;
  RAISE NOTICE 'PASS teardown — no fixture rows remain';
END $$;

\echo ''
\echo '================================================'
\echo ' F-506 cross-shift availability passed.'
\echo '================================================'
