-- =====================================================================
-- db/tests/year_rollover.sql   (F-1605)
--
-- One school, classes 1–10, rolling from 2026 into 2027. The fixture puts
-- every outcome in the same run, because a rollover that handles the easy
-- case and mishandles one child is the failure mode — and the child it
-- mishandles is always the unusual one:
--
--   করিম   Class 9 ক, active   → promoted to Class 10 ক
--   সাবিনা  Class 9 ক, detained → REPEATS Class 9
--   জাহিদ  Class 10 ক, active  → graduates (Class 10 is the top class here)
--   রুমা   Class 9 খ, active   → BLOCKED: no খ section exists in Class 10
--
-- Runs in a transaction that is ROLLED BACK; safe against any environment.
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/tests/year_rollover.sql
-- =====================================================================

\set ON_ERROR_STOP on

GRANT shikhon_app TO CURRENT_USER;
SET ROLE shikhon_app;

\set T '''7a500000-0000-4000-8000-00000000000a'''

BEGIN;
SET LOCAL app.tenant_id = '7a500000-0000-4000-8000-00000000000a';
SET LOCAL app.role      = 'school_owner';
SET LOCAL app.user_id   = '7a500000-0000-4000-8000-0000000000ff';

INSERT INTO tenants (id, slug, name_bn, name_en, stream, level)
VALUES (:T, 'rollover', 'রোলওভার বিদ্যালয়', 'Rollover School', 'bangla_medium', 'secondary');

INSERT INTO users (id, tenant_id, full_name_bn, full_name_en, phone_e164, status) VALUES
  ('7a500000-0000-4000-8000-0000000000ff', :T, 'প্রধান শিক্ষক', 'Head',   '+8801795100001', 'active'),
  ('7a500000-0000-4000-8000-0000000000a1', :T, 'করিম',        'Karim',  '+8801795100002', 'active'),
  ('7a500000-0000-4000-8000-0000000000a2', :T, 'সাবিনা',       'Sabina', '+8801795100003', 'active'),
  ('7a500000-0000-4000-8000-0000000000a3', :T, 'জাহিদ',        'Zahid',  '+8801795100004', 'active'),
  ('7a500000-0000-4000-8000-0000000000a4', :T, 'রুমা',         'Ruma',   '+8801795100005', 'active');

INSERT INTO student_profiles (user_id, tenant_id, student_code, admission_date, admission_class) VALUES
  ('7a500000-0000-4000-8000-0000000000a1', :T, 'S-001', '2020-01-01', 1),
  ('7a500000-0000-4000-8000-0000000000a2', :T, 'S-002', '2020-01-01', 1),
  ('7a500000-0000-4000-8000-0000000000a3', :T, 'S-003', '2019-01-01', 1),
  ('7a500000-0000-4000-8000-0000000000a4', :T, 'S-004', '2020-01-01', 1);

INSERT INTO academic_years (id, tenant_id, label, starts_on, ends_on, is_current) VALUES
  ('7a500000-0000-4000-8000-000000000026', :T, '2026', '2026-01-01', '2026-12-31', true),
  ('7a500000-0000-4000-8000-000000000027', :T, '2027', '2027-01-01', '2027-12-31', false);

-- Classes 9 and 10 only. Class 10 is therefore the terminal class, derived
-- rather than configured — a school that opens Class 11 next year needs no
-- setting changed.
INSERT INTO classes (id, tenant_id, level_no, name_bn, name_en, stream) VALUES
  ('7a500000-0000-4000-8000-0000000000c9', :T,  9, 'নবম', 'Nine', 'bangla_medium'),
  ('7a500000-0000-4000-8000-0000000000d0', :T, 10, 'দশম', 'Ten',  'bangla_medium');

-- 2026 has ক and খ in Class 9. 2027 has only ক in Class 10 — which is what
-- blocks রুমা, and is the single most likely real-world mistake: the office
-- creates next year's sections and forgets one.
INSERT INTO sections (id, tenant_id, class_id, academic_year_id, name) VALUES
  ('7a500000-0000-4000-8000-0000000000b1', :T, '7a500000-0000-4000-8000-0000000000c9',
   '7a500000-0000-4000-8000-000000000026', 'ক'),
  ('7a500000-0000-4000-8000-0000000000b2', :T, '7a500000-0000-4000-8000-0000000000c9',
   '7a500000-0000-4000-8000-000000000026', 'খ'),
  ('7a500000-0000-4000-8000-0000000000b3', :T, '7a500000-0000-4000-8000-0000000000d0',
   '7a500000-0000-4000-8000-000000000026', 'ক'),
  -- 2027:
  ('7a500000-0000-4000-8000-0000000000b4', :T, '7a500000-0000-4000-8000-0000000000c9',
   '7a500000-0000-4000-8000-000000000027', 'ক'),
  ('7a500000-0000-4000-8000-0000000000b5', :T, '7a500000-0000-4000-8000-0000000000d0',
   '7a500000-0000-4000-8000-000000000027', 'ক');

INSERT INTO subjects (id, tenant_id, nctb_code, name_bn, name_en)
VALUES ('7a500000-0000-4000-8000-000000000101', :T, '101', 'বাংলা', 'Bangla');

-- Templates for BOTH target classes in 2027, or the preview would block on
-- a missing template instead of the missing section, and the test would be
-- asserting the wrong thing.
INSERT INTO curriculum_schemes (id, tenant_id, academic_year_id, stage, assessment_model,
                                grade_rule_set, effective_from)
VALUES ('7a500000-0000-4000-8000-0000000000e1', :T, '7a500000-0000-4000-8000-000000000027',
        'secondary', 'marks_cq_mcq',
        '{"bands":[{"min":80,"grade":"A+","point":5.0},{"min":0,"grade":"F","point":0}],
          "fail_grade":"F"}'::jsonb, '2027-01-01');

INSERT INTO subject_templates (id, tenant_id, curriculum_scheme_id, class_id) VALUES
  ('7a500000-0000-4000-8000-0000000000e2', :T, '7a500000-0000-4000-8000-0000000000e1',
   '7a500000-0000-4000-8000-0000000000c9'),
  ('7a500000-0000-4000-8000-0000000000e3', :T, '7a500000-0000-4000-8000-0000000000e1',
   '7a500000-0000-4000-8000-0000000000d0');

INSERT INTO subject_template_items (tenant_id, template_id, subject_id, requirement_type) VALUES
  (:T, '7a500000-0000-4000-8000-0000000000e2', '7a500000-0000-4000-8000-000000000101', 'compulsory'),
  (:T, '7a500000-0000-4000-8000-0000000000e3', '7a500000-0000-4000-8000-000000000101', 'compulsory');

INSERT INTO enrolments (id, tenant_id, student_id, section_id, academic_year_id, roll_no, status) VALUES
  ('7a500000-0000-4000-8000-00000000f001', :T, '7a500000-0000-4000-8000-0000000000a1',
   '7a500000-0000-4000-8000-0000000000b1', '7a500000-0000-4000-8000-000000000026', 3, 'active'),
  ('7a500000-0000-4000-8000-00000000f002', :T, '7a500000-0000-4000-8000-0000000000a2',
   '7a500000-0000-4000-8000-0000000000b1', '7a500000-0000-4000-8000-000000000026', 1, 'detained'),
  ('7a500000-0000-4000-8000-00000000f003', :T, '7a500000-0000-4000-8000-0000000000a3',
   '7a500000-0000-4000-8000-0000000000b3', '7a500000-0000-4000-8000-000000000026', 5, 'active'),
  ('7a500000-0000-4000-8000-00000000f004', :T, '7a500000-0000-4000-8000-0000000000a4',
   '7a500000-0000-4000-8000-0000000000b2', '7a500000-0000-4000-8000-000000000026', 2, 'active');

INSERT INTO year_rollovers (id, tenant_id, from_year_id, to_year_id,
                            considered, to_promote, to_repeat, to_graduate, blocked, planned_by)
VALUES ('7a500000-0000-4000-8000-00000000aa01', :T,
        '7a500000-0000-4000-8000-000000000026', '7a500000-0000-4000-8000-000000000027',
        4, 1, 1, 1, 1, '7a500000-0000-4000-8000-0000000000ff');

-- ---------------------------------------------------------------------
-- 1. The preview names every student and what happens to them.
-- ---------------------------------------------------------------------
DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM app.rollover_preview(
    '7a500000-0000-4000-8000-000000000026', '7a500000-0000-4000-8000-000000000027');
  IF n <> 4 THEN RAISE EXCEPTION 'FAIL 1: preview returned % rows, expected 4', n; END IF;
  RAISE NOTICE 'PASS 1 — ৪ students previewed, one row each';
END $$;

-- ---------------------------------------------------------------------
-- 2. Each of the four outcomes lands on the right student.
-- ---------------------------------------------------------------------
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT * FROM app.rollover_preview(
      '7a500000-0000-4000-8000-000000000026', '7a500000-0000-4000-8000-000000000027') LOOP
    IF r.student_name_bn = 'করিম' AND (r.action <> 'promote' OR r.to_class_level <> 10) THEN
      RAISE EXCEPTION 'FAIL 2: করিম got % to class %', r.action, r.to_class_level;
    END IF;
    IF r.student_name_bn = 'সাবিনা' AND (r.action <> 'repeat' OR r.to_class_level <> 9) THEN
      RAISE EXCEPTION 'FAIL 2: সাবিনা got % to class %', r.action, r.to_class_level;
    END IF;
    IF r.student_name_bn = 'জাহিদ' AND r.action <> 'graduate' THEN
      RAISE EXCEPTION 'FAIL 2: জাহিদ got %', r.action;
    END IF;
    IF r.student_name_bn = 'রুমা' AND r.action <> 'blocked' THEN
      RAISE EXCEPTION 'FAIL 2: রুমা got %', r.action;
    END IF;
  END LOOP;
  RAISE NOTICE 'PASS 2 — promote, repeat, graduate and blocked each land on the right child';
END $$;

-- ---------------------------------------------------------------------
-- 3. The blocker says what to fix, in the words of the person fixing it.
-- ---------------------------------------------------------------------
DO $$
DECLARE msg text;
BEGIN
  SELECT blocker_bn INTO msg FROM app.rollover_preview(
    '7a500000-0000-4000-8000-000000000026', '7a500000-0000-4000-8000-000000000027')
   WHERE action = 'blocked';
  IF msg NOT LIKE '%খ%' OR msg NOT LIKE '%10%' THEN
    RAISE EXCEPTION 'FAIL 3: the blocker does not name the missing section: %', msg;
  END IF;
  RAISE NOTICE 'PASS 3 — the blocker names it: %', msg;
END $$;

-- ---------------------------------------------------------------------
-- 4. THE ONE THAT MATTERS. The preview WROTE NOTHING. This is the
--    reversible half of "reversible-until-committed", and if it is not
--    true then nothing else in this feature matters.
-- ---------------------------------------------------------------------
DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM enrolments
   WHERE academic_year_id = '7a500000-0000-4000-8000-000000000027';
  IF n <> 0 THEN RAISE EXCEPTION 'FAIL 4: the preview created % enrolment(s)', n; END IF;

  SELECT count(*) INTO n FROM enrolments WHERE status = 'promoted';
  IF n <> 0 THEN RAISE EXCEPTION 'FAIL 4: the preview closed % enrolment(s)', n; END IF;

  SELECT count(*) INTO n FROM student_profiles WHERE lifecycle_status = 'graduated';
  IF n <> 0 THEN RAISE EXCEPTION 'FAIL 4: the preview graduated % student(s)', n; END IF;
  RAISE NOTICE 'PASS 4 — the preview wrote nothing at all';
END $$;

-- ---------------------------------------------------------------------
-- 5. The commit REFUSES while anybody is blocked. Skipping thirty
--    children silently is discovered in March by a teacher whose
--    register is short.
-- ---------------------------------------------------------------------
DO $$
DECLARE msg text;
BEGIN
  BEGIN
    PERFORM app.commit_rollover('7a500000-0000-4000-8000-00000000aa01');
    RAISE EXCEPTION 'FAIL 5: the rollover committed with a blocked student';
  EXCEPTION WHEN check_violation THEN
    GET STACKED DIAGNOSTICS msg = MESSAGE_TEXT;
  END;
  IF msg NOT LIKE '%1 blocked%' THEN
    RAISE EXCEPTION 'FAIL 5: the refusal does not state the count: %', msg;
  END IF;
  RAISE NOTICE 'PASS 5 — refused while ১ student was blocked';
END $$;

-- ---------------------------------------------------------------------
-- 6. Create the missing section and it commits, moving everybody.
-- ---------------------------------------------------------------------
DO $$
DECLARE r record;
BEGIN
  INSERT INTO sections (id, tenant_id, class_id, academic_year_id, name)
  VALUES ('7a500000-0000-4000-8000-0000000000b6', app.current_tenant(),
          '7a500000-0000-4000-8000-0000000000d0', '7a500000-0000-4000-8000-000000000027', 'খ');

  SELECT * INTO r FROM app.commit_rollover('7a500000-0000-4000-8000-00000000aa01');
  IF r.promoted <> 2 OR r.repeated <> 1 OR r.graduated <> 1 THEN
    RAISE EXCEPTION 'FAIL 6: promoted %, repeated %, graduated %',
      r.promoted, r.repeated, r.graduated;
  END IF;
  RAISE NOTICE 'PASS 6 — ২ promoted, ১ repeated, ১ graduated';
END $$;

-- ---------------------------------------------------------------------
-- 7. The new enrolments are real, in the right classes, and the old ones
--    are closed rather than left active.
-- ---------------------------------------------------------------------
DO $$
DECLARE n integer; lvl smallint;
BEGIN
  SELECT count(*) INTO n FROM enrolments
   WHERE academic_year_id = '7a500000-0000-4000-8000-000000000027' AND status = 'active';
  IF n <> 3 THEN RAISE EXCEPTION 'FAIL 7: % new active enrolments, expected 3', n; END IF;

  SELECT c.level_no INTO lvl
    FROM enrolments e JOIN sections s ON s.id = e.section_id JOIN classes c ON c.id = s.class_id
   WHERE e.student_id = '7a500000-0000-4000-8000-0000000000a1'
     AND e.academic_year_id = '7a500000-0000-4000-8000-000000000027';
  IF lvl <> 10 THEN RAISE EXCEPTION 'FAIL 7: করিম landed in class %', lvl; END IF;

  SELECT c.level_no INTO lvl
    FROM enrolments e JOIN sections s ON s.id = e.section_id JOIN classes c ON c.id = s.class_id
   WHERE e.student_id = '7a500000-0000-4000-8000-0000000000a2'
     AND e.academic_year_id = '7a500000-0000-4000-8000-000000000027';
  IF lvl <> 9 THEN RAISE EXCEPTION 'FAIL 7: সাবিনা repeated into class %', lvl; END IF;

  SELECT count(*) INTO n FROM enrolments
   WHERE academic_year_id = '7a500000-0000-4000-8000-000000000026' AND status = 'active';
  IF n <> 0 THEN RAISE EXCEPTION 'FAIL 7: % old enrolments left active', n; END IF;
  RAISE NOTICE 'PASS 7 — করিম is in class ১০, সাবিনা repeated class ৯, last year is closed';
END $$;

-- ---------------------------------------------------------------------
-- 8. F-304 ran: every promoted student has a subject set for the NEW
--    class. Carrying last year's forward would be quietly wrong.
-- ---------------------------------------------------------------------
DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n
    FROM student_subjects ss
    JOIN enrolments e ON e.id = ss.enrolment_id
   WHERE e.academic_year_id = '7a500000-0000-4000-8000-000000000027';
  IF n <> 3 THEN RAISE EXCEPTION 'FAIL 8: % derived subject rows, expected 3', n; END IF;
  RAISE NOTICE 'PASS 8 — subject sets derived from the NEW year''s template';
END $$;

-- ---------------------------------------------------------------------
-- 9. The graduate is graduated, and the alumni network was told. The
--    outbox row is the whole point of the lifecycle field.
-- ---------------------------------------------------------------------
DO $$
DECLARE st text; n integer;
BEGIN
  SELECT lifecycle_status INTO st FROM student_profiles
   WHERE user_id = '7a500000-0000-4000-8000-0000000000a3';
  IF st <> 'graduated' THEN RAISE EXCEPTION 'FAIL 9: জাহিদ is %', st; END IF;

  SELECT count(*) INTO n FROM event_outbox
   WHERE event_type = 'student.graduated.v1'
     AND aggregate_id = '7a500000-0000-4000-8000-0000000000a3';
  IF n <> 1 THEN RAISE EXCEPTION 'FAIL 9: % graduation events emitted', n; END IF;

  SELECT count(*) INTO n FROM enrolments
   WHERE student_id = '7a500000-0000-4000-8000-0000000000a3'
     AND academic_year_id = '7a500000-0000-4000-8000-000000000027';
  IF n <> 0 THEN RAISE EXCEPTION 'FAIL 9: the graduate was also enrolled into next year'; END IF;
  RAISE NOTICE 'PASS 9 — জাহিদ graduated, the ANS was told, and he was not re-enrolled';
END $$;

-- ---------------------------------------------------------------------
-- 10. Running it twice would enrol every child a second time, so the
--     second run is refused.
-- ---------------------------------------------------------------------
DO $$
BEGIN
  BEGIN
    PERFORM app.commit_rollover('7a500000-0000-4000-8000-00000000aa01');
    RAISE EXCEPTION 'FAIL 10: the rollover committed twice';
  EXCEPTION WHEN invalid_parameter_value THEN
    NULL;
  END;
  RAISE NOTICE 'PASS 10 — a committed rollover cannot be run again';
END $$;

-- ---------------------------------------------------------------------
-- 11. The batch row records what actually happened, and the arithmetic
--     has to add up — a rollover that moved fewer children than it
--     promised is visible afterwards, not only while it ran.
-- ---------------------------------------------------------------------
DO $$
DECLARE r record;
BEGIN
  SELECT * INTO r FROM year_rollovers WHERE id = '7a500000-0000-4000-8000-00000000aa01';
  IF r.status <> 'committed' THEN RAISE EXCEPTION 'FAIL 11: status is %', r.status; END IF;
  IF r.promoted + r.repeated + r.graduated <> 4 THEN
    RAISE EXCEPTION 'FAIL 11: actuals sum to %, expected 4',
      r.promoted + r.repeated + r.graduated;
  END IF;
  IF r.committed_at IS NULL THEN RAISE EXCEPTION 'FAIL 11: committed_at is null'; END IF;
  RAISE NOTICE 'PASS 11 — the batch records ২ promoted, ১ repeated, ১ graduated';
END $$;

ROLLBACK;

RESET ROLE;

DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM tenants WHERE id = '7a500000-0000-4000-8000-00000000000a';
  IF n <> 0 THEN RAISE EXCEPTION 'FAIL teardown: the fixture tenant survived'; END IF;
  RAISE NOTICE 'PASS teardown — no fixture rows remain';
END $$;

\echo ''
\echo '================================================'
\echo ' F-1605 academic year rollover passed.'
\echo '================================================'
