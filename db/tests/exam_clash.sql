-- =====================================================================
-- db/tests/exam_clash.sql   (F-510, TRD §6.6)
--
-- The scenario that a class-template check cannot see, and the reason
-- this could not be built before the subject model (migration 025):
--
--   One Class 9 Science section. Two students, identical except for their
--   optional subject — Anika takes Higher Maths, Bijoy takes Agriculture.
--   The coordinator schedules Higher Maths at the same hour as Chemistry.
--
--   Anika now sits two papers at 10:00 on the same morning. Bijoy does
--   not. The section's template holds BOTH optionals, so a template-level
--   check either flags a clash for a student who has none, or misses
--   Anika's entirely. Only student_subjects can tell them apart.
--
-- Runs in a transaction that is ROLLED BACK; safe against any environment.
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/tests/exam_clash.sql
-- =====================================================================

\set ON_ERROR_STOP on

GRANT shikhon_app TO CURRENT_USER;
SET ROLE shikhon_app;

\set T '''7d000000-0000-4000-8000-00000000000d'''

BEGIN;
SET LOCAL app.tenant_id = '7d000000-0000-4000-8000-00000000000d';
SET LOCAL app.role      = 'academic_coordinator';
SET LOCAL app.user_id   = '7d000000-0000-4000-8000-0000000000ff';

INSERT INTO tenants (id, slug, name_bn, name_en, stream, level)
VALUES (:T, 'exam-clash', 'পরীক্ষা বিদ্যালয়', 'Exam School', 'bangla_medium', 'secondary');

INSERT INTO users (id, tenant_id, full_name_bn, full_name_en, phone_e164) VALUES
  ('7d000000-0000-4000-8000-0000000000ff', :T, 'সমন্বয়ক', 'Coordinator', '+8801794000001'),
  ('7d000000-0000-4000-8000-0000000000a1', :T, 'আনিকা',   'Anika',       '+8801794000002'),
  ('7d000000-0000-4000-8000-0000000000a2', :T, 'বিজয়',    'Bijoy',       '+8801794000003');

INSERT INTO academic_years (id, tenant_id, label, starts_on, ends_on, is_current)
VALUES ('7d000000-0000-4000-8000-000000000091', :T, '2026', '2026-01-01', '2026-12-31', true);

INSERT INTO classes (id, tenant_id, level_no, name_bn, name_en, stream, "group")
VALUES ('7d000000-0000-4000-8000-0000000000c1', :T, 9, 'নবম', 'Nine', 'bangla_medium', 'science');

INSERT INTO sections (id, tenant_id, class_id, academic_year_id, name)
VALUES ('7d000000-0000-4000-8000-0000000000c2', :T,
        '7d000000-0000-4000-8000-0000000000c1', '7d000000-0000-4000-8000-000000000091', 'ক');

INSERT INTO enrolments (id, tenant_id, student_id, section_id, academic_year_id, roll_no, status) VALUES
  ('7d000000-0000-4000-8000-0000000000e1', :T, '7d000000-0000-4000-8000-0000000000a1',
   '7d000000-0000-4000-8000-0000000000c2', '7d000000-0000-4000-8000-000000000091', 7, 'active'),
  ('7d000000-0000-4000-8000-0000000000e2', :T, '7d000000-0000-4000-8000-0000000000a2',
   '7d000000-0000-4000-8000-0000000000c2', '7d000000-0000-4000-8000-000000000091', 8, 'active');

INSERT INTO subjects (id, tenant_id, nctb_code, name_bn, name_en) VALUES
  ('7d000000-0000-4000-8000-000000000137', :T, '137', 'রসায়ন',        'Chemistry'),
  ('7d000000-0000-4000-8000-000000000136', :T, '136', 'পদার্থবিজ্ঞান',  'Physics'),
  ('7d000000-0000-4000-8000-000000000126', :T, '126', 'উচ্চতর গণিত',   'Higher Mathematics'),
  ('7d000000-0000-4000-8000-000000000127', :T, '127', 'কৃষিশিক্ষা',     'Agriculture');

-- Identical except for the optional subject. This is the whole fixture.
INSERT INTO student_subjects (tenant_id, enrolment_id, subject_id, requirement_type, source) VALUES
  (:T, '7d000000-0000-4000-8000-0000000000e1', '7d000000-0000-4000-8000-000000000137', 'group_compulsory', 'template'),
  (:T, '7d000000-0000-4000-8000-0000000000e1', '7d000000-0000-4000-8000-000000000136', 'group_compulsory', 'template'),
  (:T, '7d000000-0000-4000-8000-0000000000e1', '7d000000-0000-4000-8000-000000000126', 'optional',         'template'),
  (:T, '7d000000-0000-4000-8000-0000000000e2', '7d000000-0000-4000-8000-000000000137', 'group_compulsory', 'template'),
  (:T, '7d000000-0000-4000-8000-0000000000e2', '7d000000-0000-4000-8000-000000000136', 'group_compulsory', 'template'),
  (:T, '7d000000-0000-4000-8000-0000000000e2', '7d000000-0000-4000-8000-000000000127', 'optional',         'template');

INSERT INTO exams (id, tenant_id, academic_year_id, name_bn, name_en, exam_type, starts_on, ends_on, status)
VALUES ('7d000000-0000-4000-8000-000000000092', :T, '7d000000-0000-4000-8000-000000000091',
        'বার্ষিক পরীক্ষা', 'Annual Exam', 'annual', '2026-12-10', '2026-12-20', 'planned');

-- Chemistry 10:00–13:00, Physics 10:00–13:00 the NEXT day (no clash),
-- Higher Maths 10:00–13:00 the SAME day as Chemistry (clash for Anika only).
INSERT INTO exam_subjects
  (tenant_id, exam_id, section_id, subject_id, exam_date, start_time, duration_minutes, cq_max, mcq_max)
VALUES
  (:T, '7d000000-0000-4000-8000-000000000092', '7d000000-0000-4000-8000-0000000000c2',
   '7d000000-0000-4000-8000-000000000137', '2026-12-14', '10:00', 180, 50, 25),
  (:T, '7d000000-0000-4000-8000-000000000092', '7d000000-0000-4000-8000-0000000000c2',
   '7d000000-0000-4000-8000-000000000136', '2026-12-15', '10:00', 180, 50, 25),
  (:T, '7d000000-0000-4000-8000-000000000092', '7d000000-0000-4000-8000-0000000000c2',
   '7d000000-0000-4000-8000-000000000126', '2026-12-14', '10:00', 180, 50, 25);

-- ---------------------------------------------------------------------
-- 1. THE ONE THAT MATTERS. The clash is found, and only for Anika.
-- ---------------------------------------------------------------------
DO $$
DECLARE n integer; who text; roll smallint;
BEGIN
  SELECT count(*) INTO n FROM app.exam_student_clashes('7d000000-0000-4000-8000-000000000092');
  IF n <> 1 THEN
    RAISE EXCEPTION 'FAIL 1: expected exactly 1 clash (Anika only), got %', n;
  END IF;

  SELECT student_name_bn, roll_no INTO who, roll
    FROM app.exam_student_clashes('7d000000-0000-4000-8000-000000000092');
  IF who <> 'আনিকা' THEN
    RAISE EXCEPTION 'FAIL 1: the clash is attributed to % rather than Anika', who;
  END IF;
  IF roll <> 7 THEN RAISE EXCEPTION 'FAIL 1: roll number is %, expected 7', roll; END IF;
  RAISE NOTICE 'PASS 1 — clash found for Anika (roll ৭) only; Bijoy sits the same section and has none';
END $$;

-- ---------------------------------------------------------------------
-- 2. The report names the two subjects and the date, per TRD §6.6's
--    "surfaced per affected student rather than as a count".
-- ---------------------------------------------------------------------
DO $$
DECLARE a text; b text; d date;
BEGIN
  SELECT subject_a_bn, subject_b_bn, exam_date INTO a, b, d
    FROM app.exam_student_clashes('7d000000-0000-4000-8000-000000000092');
  IF NOT ((a = 'রসায়ন' AND b = 'উচ্চতর গণিত') OR (a = 'উচ্চতর গণিত' AND b = 'রসায়ন')) THEN
    RAISE EXCEPTION 'FAIL 2: the clashing pair is reported as % / %', a, b;
  END IF;
  IF d <> '2026-12-14' THEN RAISE EXCEPTION 'FAIL 2: wrong date %', d; END IF;
  RAISE NOTICE 'PASS 2 — the row names both subjects and the date: % / % on %', a, b, d;
END $$;

-- ---------------------------------------------------------------------
-- 3. Publication is BLOCKED while the clash stands, and the error names a
--    real student rather than a count.
-- ---------------------------------------------------------------------
DO $$
DECLARE msg text;
BEGIN
  BEGIN
    UPDATE exams SET status = 'published' WHERE id = '7d000000-0000-4000-8000-000000000092';
    RAISE EXCEPTION 'FAIL 3: an exam routine with a per-student clash was published';
  EXCEPTION WHEN check_violation THEN
    GET STACKED DIAGNOSTICS msg = MESSAGE_TEXT;
  END;
  IF msg NOT LIKE '%আনিকা%' THEN
    RAISE EXCEPTION 'FAIL 3: the error does not name the affected student: %', msg;
  END IF;
  RAISE NOTICE 'PASS 3 — publication blocked, and the error names the student: %', msg;
END $$;

-- ---------------------------------------------------------------------
-- 4. Move Higher Maths to a free day and publication succeeds. A gate you
--    cannot get through is a wall.
-- ---------------------------------------------------------------------
DO $$
DECLARE n integer; st text;
BEGIN
  UPDATE exam_subjects SET exam_date = '2026-12-16'
   WHERE exam_id = '7d000000-0000-4000-8000-000000000092'
     AND subject_id = '7d000000-0000-4000-8000-000000000126';

  SELECT count(*) INTO n FROM app.exam_student_clashes('7d000000-0000-4000-8000-000000000092');
  IF n <> 0 THEN RAISE EXCEPTION 'FAIL 4: % clash(es) remain after rescheduling', n; END IF;

  UPDATE exams SET status = 'published' WHERE id = '7d000000-0000-4000-8000-000000000092';
  SELECT status::text INTO st FROM exams WHERE id = '7d000000-0000-4000-8000-000000000092';
  IF st <> 'published' THEN RAISE EXCEPTION 'FAIL 4: status is % after a clean publish', st; END IF;
  RAISE NOTICE 'PASS 4 — rescheduling clears the clash and publication succeeds';
END $$;

-- ---------------------------------------------------------------------
-- 5. Back-to-back papers are NOT a clash. A paper ending at 13:00 and one
--    starting at 13:00 do not overlap — treating that as a conflict would
--    make the schedule every school actually runs impossible to express.
-- ---------------------------------------------------------------------
DO $$
DECLARE n integer;
BEGIN
  UPDATE exams SET status = 'planned' WHERE id = '7d000000-0000-4000-8000-000000000092';
  UPDATE exam_subjects SET exam_date = '2026-12-14', start_time = '13:00'
   WHERE exam_id = '7d000000-0000-4000-8000-000000000092'
     AND subject_id = '7d000000-0000-4000-8000-000000000126';

  SELECT count(*) INTO n FROM app.exam_student_clashes('7d000000-0000-4000-8000-000000000092');
  IF n <> 0 THEN
    RAISE EXCEPTION 'FAIL 5: back-to-back papers (13:00 after a 10:00+180m) reported as a clash';
  END IF;
  RAISE NOTICE 'PASS 5 — a paper starting exactly when another ends is not a clash';
END $$;

-- ---------------------------------------------------------------------
-- 6. A one-minute overlap IS a clash. The boundary is exact, not fuzzy.
-- ---------------------------------------------------------------------
DO $$
DECLARE n integer;
BEGIN
  UPDATE exam_subjects SET start_time = '12:59'
   WHERE exam_id = '7d000000-0000-4000-8000-000000000092'
     AND subject_id = '7d000000-0000-4000-8000-000000000126';
  SELECT count(*) INTO n FROM app.exam_student_clashes('7d000000-0000-4000-8000-000000000092');
  IF n <> 1 THEN RAISE EXCEPTION 'FAIL 6: a one-minute overlap was not caught (% found)', n; END IF;
  RAISE NOTICE 'PASS 6 — a one-minute overlap is caught';
END $$;

-- ---------------------------------------------------------------------
-- 7. An unscheduled paper (no date or time yet) is not a clash. A routine
--    under construction must be inspectable without erroring.
-- ---------------------------------------------------------------------
DO $$
DECLARE n integer;
BEGIN
  UPDATE exam_subjects SET exam_date = NULL, start_time = NULL
   WHERE exam_id = '7d000000-0000-4000-8000-000000000092'
     AND subject_id = '7d000000-0000-4000-8000-000000000126';
  SELECT count(*) INTO n FROM app.exam_student_clashes('7d000000-0000-4000-8000-000000000092');
  IF n <> 0 THEN RAISE EXCEPTION 'FAIL 7: an unscheduled paper produced % clash(es)', n; END IF;
  RAISE NOTICE 'PASS 7 — a paper with no slot yet is ignored, not an error';
END $$;

-- ---------------------------------------------------------------------
-- 8. A student who holds NEITHER subject is unaffected — the check is
--    per subject set, not per section.
-- ---------------------------------------------------------------------
DO $$
DECLARE n integer;
BEGIN
  DELETE FROM student_subjects
   WHERE enrolment_id = '7d000000-0000-4000-8000-0000000000e1'
     AND subject_id = '7d000000-0000-4000-8000-000000000137';
  UPDATE exam_subjects SET exam_date = '2026-12-14', start_time = '10:00'
   WHERE exam_id = '7d000000-0000-4000-8000-000000000092'
     AND subject_id = '7d000000-0000-4000-8000-000000000126';

  SELECT count(*) INTO n FROM app.exam_student_clashes('7d000000-0000-4000-8000-000000000092');
  IF n <> 0 THEN
    RAISE EXCEPTION 'FAIL 8: dropping Chemistry from her set left % clash(es)', n;
  END IF;
  RAISE NOTICE 'PASS 8 — a student who no longer holds the subject has no clash';
END $$;

ROLLBACK;

RESET ROLE;

DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM tenants WHERE id = '7d000000-0000-4000-8000-00000000000d';
  IF n <> 0 THEN RAISE EXCEPTION 'FAIL teardown: the fixture tenant survived'; END IF;
  RAISE NOTICE 'PASS teardown — no fixture rows remain';
END $$;

\echo ''
\echo '================================================'
\echo ' F-510 exam routine clash detection passed.'
\echo '================================================'
