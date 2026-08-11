-- =====================================================================
-- db/tests/seat_plan.sql   (F-511, F-512, TRD §6.7)
--
-- One Class 9 exam session, one hall, two sections of unequal size:
-- ক has 3 students, খ has 9. That inequality is deliberate. An interleave
-- across two equal rosters is easy and proves nothing; the moment one
-- section runs out, the tail of the hall is unavoidably same-section, and
-- §6.7's "explicit report when the rule cannot be fully satisfied" is the
-- whole point of the exercise. This fixture forces that report to be
-- produced and checks the number is right rather than merely non-zero.
--
-- Runs in a transaction that is ROLLED BACK; safe against any environment.
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/tests/seat_plan.sql
-- =====================================================================

\set ON_ERROR_STOP on

GRANT shikhon_app TO CURRENT_USER;
SET ROLE shikhon_app;

\set T '''7e000000-0000-4000-8000-00000000000e'''
\set EXAM '''7e000000-0000-4000-8000-000000000092'''

BEGIN;
SET LOCAL app.tenant_id = '7e000000-0000-4000-8000-00000000000e';
SET LOCAL app.role      = 'academic_coordinator';
SET LOCAL app.user_id   = '7e000000-0000-4000-8000-0000000000ff';

INSERT INTO tenants (id, slug, name_bn, name_en, stream, level)
VALUES (:T, 'seat-plan', 'আসন বিদ্যালয়', 'Seat School', 'bangla_medium', 'secondary');

INSERT INTO users (id, tenant_id, full_name_bn, full_name_en, phone_e164, status) VALUES
  ('7e000000-0000-4000-8000-0000000000ff', :T, 'সমন্বয়ক',      'Coordinator', '+8801795000001', 'active'),
  -- Three teachers. One owns the subject being examined, one is busy in the
  -- routine at that hour, one is genuinely free.
  ('7e000000-0000-4000-8000-00000000a1a1', :T, 'রসায়ন শিক্ষক', 'Chem Teacher', '+8801795000011', 'active'),
  ('7e000000-0000-4000-8000-00000000a2a2', :T, 'ব্যস্ত শিক্ষক',  'Busy Teacher', '+8801795000012', 'active'),
  ('7e000000-0000-4000-8000-00000000a3a3', :T, 'মুক্ত শিক্ষক',   'Free Teacher', '+8801795000013', 'active');

INSERT INTO user_roles (tenant_id, user_id, role_code, scope_type) VALUES
  (:T, '7e000000-0000-4000-8000-00000000a1a1', 'subject_teacher', 'tenant'),
  (:T, '7e000000-0000-4000-8000-00000000a2a2', 'subject_teacher', 'tenant'),
  (:T, '7e000000-0000-4000-8000-00000000a3a3', 'subject_teacher', 'tenant');

INSERT INTO academic_years (id, tenant_id, label, starts_on, ends_on, is_current)
VALUES ('7e000000-0000-4000-8000-000000000091', :T, '2026', '2026-01-01', '2026-12-31', true);

INSERT INTO classes (id, tenant_id, level_no, name_bn, name_en, stream, "group")
VALUES ('7e000000-0000-4000-8000-0000000000c1', :T, 9, 'নবম', 'Nine', 'bangla_medium', 'science');

INSERT INTO sections (id, tenant_id, class_id, academic_year_id, name) VALUES
  ('7e000000-0000-4000-8000-00000000b1b1', :T, '7e000000-0000-4000-8000-0000000000c1',
   '7e000000-0000-4000-8000-000000000091', 'ক'),
  ('7e000000-0000-4000-8000-00000000b2b2', :T, '7e000000-0000-4000-8000-0000000000c1',
   '7e000000-0000-4000-8000-000000000091', 'খ');

INSERT INTO subjects (id, tenant_id, nctb_code, name_bn, name_en)
VALUES ('7e000000-0000-4000-8000-000000000137', :T, '137', 'রসায়ন', 'Chemistry');

-- HARD FILTER 1 fodder: t1 is competent in the subject being examined.
INSERT INTO teacher_competencies (tenant_id, teacher_id, subject_id, min_class_level, max_class_level)
VALUES (:T, '7e000000-0000-4000-8000-00000000a1a1',
        '7e000000-0000-4000-8000-000000000137', 9, 10);

INSERT INTO rooms (id, tenant_id, code, name_bn, capacity) VALUES
  ('7e000000-0000-4000-8000-00000000a0a0', :T, 'HALL-1', 'হলরুম ১', 60),
  -- A second room, so test 6 can try to seat one student in two halls of
  -- the same session. One room cannot host two halls at once, which the
  -- UNIQUE on exam_halls already refuses.
  ('7e000000-0000-4000-8000-00000000a0a1', :T, 'HALL-2', 'হলরুম ২', 60);

-- 3 students in ক, 9 in খ.
DO $$
DECLARE i int;
BEGIN
  FOR i IN 1..12 LOOP
    INSERT INTO users (id, tenant_id, full_name_bn, full_name_en, phone_e164, status)
    VALUES (('7e000000-0000-4000-8000-0000000005' || lpad(i::text, 2, '0'))::uuid,
            '7e000000-0000-4000-8000-00000000000e'::uuid,
            'শিক্ষার্থী ' || i, 'Student ' || i,
            '+88017952' || lpad(i::text, 5, '0'), 'active');

    INSERT INTO enrolments (id, tenant_id, student_id, section_id, academic_year_id, roll_no, status)
    VALUES (('7e000000-0000-4000-8000-00000000060' || to_hex(i))::uuid,
            '7e000000-0000-4000-8000-00000000000e'::uuid,
            ('7e000000-0000-4000-8000-0000000005' || lpad(i::text, 2, '0'))::uuid,
            CASE WHEN i <= 3 THEN '7e000000-0000-4000-8000-00000000b1b1'::uuid
                             ELSE '7e000000-0000-4000-8000-00000000b2b2'::uuid END,
            '7e000000-0000-4000-8000-000000000091'::uuid,
            CASE WHEN i <= 3 THEN i ELSE i - 3 END, 'active');

    INSERT INTO student_subjects (tenant_id, enrolment_id, subject_id, requirement_type, source)
    VALUES ('7e000000-0000-4000-8000-00000000000e'::uuid,
            ('7e000000-0000-4000-8000-00000000060' || to_hex(i))::uuid,
            '7e000000-0000-4000-8000-000000000137'::uuid, 'group_compulsory', 'template');
  END LOOP;
END $$;

INSERT INTO exams (id, tenant_id, academic_year_id, name_bn, name_en, exam_type, starts_on, ends_on, status)
VALUES (:EXAM, :T, '7e000000-0000-4000-8000-000000000091',
        'বার্ষিক পরীক্ষা', 'Annual Exam', 'annual', '2026-12-10', '2026-12-20', 'planned');

-- One paper per section, same subject, same hour: one session, two sections.
INSERT INTO exam_subjects
  (tenant_id, exam_id, section_id, subject_id, exam_date, start_time, duration_minutes, cq_max, mcq_max)
VALUES
  (:T, :EXAM, '7e000000-0000-4000-8000-00000000b1b1',
   '7e000000-0000-4000-8000-000000000137', '2026-12-14', '10:00', 180, 50, 25),
  (:T, :EXAM, '7e000000-0000-4000-8000-00000000b2b2',
   '7e000000-0000-4000-8000-000000000137', '2026-12-14', '10:00', 180, 50, 25);

-- One hall, 3 rows x 4 columns = 12 seats. The EVEN column count is chosen
-- on purpose: a naive left-to-right fill alternates along each row and
-- matches down every column, which is the bug the serpentine fill exists
-- to prevent. If that regresses, test 2's count jumps well past 6.
INSERT INTO exam_halls (id, tenant_id, exam_id, exam_date, start_time, room_id, rows_count, cols_count)
VALUES ('7e000000-0000-4000-8000-00000000d1d1', :T, :EXAM, '2026-12-14', '10:00',
        '7e000000-0000-4000-8000-00000000a0a0', 3, 4);

-- ---------------------------------------------------------------------
-- 1. Everyone is seated exactly once, and the report accounts for all of them.
-- ---------------------------------------------------------------------
DO $$
DECLARE r record;
BEGIN
  SELECT * INTO r FROM app.generate_seat_plan(
    '7e000000-0000-4000-8000-000000000092', '2026-12-14', '10:00');

  IF r.students_to_seat <> 12 THEN
    RAISE EXCEPTION 'FAIL 1: expected 12 students to seat, got %', r.students_to_seat;
  END IF;
  IF r.seats_available <> 12 THEN
    RAISE EXCEPTION 'FAIL 1: expected 12 seats, got %', r.seats_available;
  END IF;
  IF r.students_seated <> 12 OR r.students_unseated <> 0 THEN
    RAISE EXCEPTION 'FAIL 1: seated %, unseated %', r.students_seated, r.students_unseated;
  END IF;
  IF r.halls_used <> 1 THEN RAISE EXCEPTION 'FAIL 1: halls_used %', r.halls_used; END IF;
  RAISE NOTICE 'PASS 1 — all ১২ students seated in ১ hall, none left standing';
END $$;

-- ---------------------------------------------------------------------
-- 2. THE ONE THAT MATTERS. The rule cannot be fully satisfied here, and
--    the function says so with the exact number rather than claiming
--    success or refusing to produce a plan.
--
--    ক runs out after 3 students, so the order is
--      ক1 খ1 ক2 খ2 ক3 খ3 | খ4 খ5 খ6 খ7 খ8 খ9
--    and the six-student খ tail is what cannot be mixed. Serpentine into
--    the 3x4 grid gives exactly:
--      row 1  →   ক1 খ1 ক2 খ2
--      row 2  ←   খ5 খ4 খ3 ক3
--      row 3  →   খ6 খ7 খ8 খ9
--    Five same-section pairs along rows (খ5-খ4, খ4-খ3, খ6-খ7, খ7-খ8,
--    খ8-খ9) and four down columns (খ5-খ6, খ1-খ4, খ4-খ7, খ3-খ8): nine.
--
--    Nine is not optimal — a solver could reach eight by placing the three
--    ক students on the highest-degree seats. This is an interleave with an
--    honest report, which is what §6.7 asks for, not an optimiser. What
--    the number guards is regression: a left-to-right fill scores 11 here.
-- ---------------------------------------------------------------------
DO $$
DECLARE v int; tail int;
BEGIN
  v := app.seat_plan_adjacency_violations(
         '7e000000-0000-4000-8000-000000000092', '2026-12-14', '10:00');
  IF v <> 9 THEN
    RAISE EXCEPTION 'FAIL 2: expected exactly 9 residual adjacency violations, got %. '
                    '11 means the serpentine fill regressed to left-to-right; anything '
                    'else means the interleave is not producing the documented order.', v;
  END IF;

  -- And they are all in the খ tail: the first row, where both sections
  -- still have students, is perfectly mixed.
  SELECT count(*) INTO tail
    FROM exam_seats a JOIN enrolments ea ON ea.id = a.enrolment_id
    JOIN exam_seats b ON b.hall_id = a.hall_id AND b.seat_row = a.seat_row
                     AND b.seat_col = a.seat_col + 1
    JOIN enrolments eb ON eb.id = b.enrolment_id
   WHERE a.seat_row = 1 AND ea.section_id = eb.section_id;
  IF tail <> 0 THEN
    RAISE EXCEPTION 'FAIL 2: row 1 has % same-section neighbours; it should be perfectly mixed', tail;
  END IF;
  RAISE NOTICE 'PASS 2 — ৯ unavoidable violations reported, none of them in row ১';
END $$;

-- ---------------------------------------------------------------------
-- 2b. The serpentine, proved. Balance the two sections at 6 and 6 — the
--     case where the rule CAN be fully satisfied — and the count must be
--     zero on this deliberately even-column grid.
--
--     A left-to-right fill scores 8 here: it alternates along every row
--     and then stacks ক above ক down every column. That is the entire
--     reason the fill reverses on alternate rows, and this is the
--     assertion that would catch its removal.
-- ---------------------------------------------------------------------
DO $$
DECLARE v int;
BEGIN
  UPDATE enrolments SET section_id = '7e000000-0000-4000-8000-00000000b1b1', roll_no = roll_no + 3
   WHERE section_id = '7e000000-0000-4000-8000-00000000b2b2' AND roll_no <= 3;

  PERFORM app.generate_seat_plan(
    '7e000000-0000-4000-8000-000000000092', '2026-12-14', '10:00');
  v := app.seat_plan_adjacency_violations(
         '7e000000-0000-4000-8000-000000000092', '2026-12-14', '10:00');
  IF v <> 0 THEN
    RAISE EXCEPTION 'FAIL 2b: two equal sections in a 3x4 hall should mix perfectly, got % violations. '
                    '8 means the fill no longer reverses on alternate rows.', v;
  END IF;
  RAISE NOTICE 'PASS 2b — equal sections mix perfectly (০ violations) on an even-column grid';

  -- Put the fixture back so the tests below see the documented plan.
  UPDATE enrolments SET section_id = '7e000000-0000-4000-8000-00000000b2b2', roll_no = roll_no - 3
   WHERE section_id = '7e000000-0000-4000-8000-00000000b1b1' AND roll_no > 3;
  PERFORM app.generate_seat_plan(
    '7e000000-0000-4000-8000-000000000092', '2026-12-14', '10:00');
END $$;

-- ---------------------------------------------------------------------
-- 3. Deterministic. Regenerating without changing anything reproduces the
--    same plan seat for seat — §6.4's determinism requirement, which is
--    what makes "regenerate after one correction" a safe habit.
-- ---------------------------------------------------------------------
DO $$
DECLARE moved int;
BEGIN
  CREATE TEMP TABLE before_plan AS
    SELECT enrolment_id, hall_id, seat_row, seat_col FROM exam_seats;

  PERFORM app.generate_seat_plan(
    '7e000000-0000-4000-8000-000000000092', '2026-12-14', '10:00');

  SELECT count(*) INTO moved
    FROM before_plan b JOIN exam_seats s ON s.enrolment_id = b.enrolment_id
   WHERE (s.hall_id, s.seat_row, s.seat_col) IS DISTINCT FROM (b.hall_id, b.seat_row, b.seat_col);
  IF moved <> 0 THEN
    RAISE EXCEPTION 'FAIL 3: % students moved on an identical regeneration', moved;
  END IF;
  RAISE NOTICE 'PASS 3 — regeneration is seat-for-seat identical; nobody moved';
END $$;

-- ---------------------------------------------------------------------
-- 4. Capacity is the binding constraint, and a shortfall is REPORTED, not
--    raised. A coordinator with 12 students and 6 benches needs the number
--    and a partial plan, not a failed transaction.
-- ---------------------------------------------------------------------
DO $$
DECLARE r record;
BEGIN
  UPDATE exam_halls SET rows_count = 2, cols_count = 3
   WHERE id = '7e000000-0000-4000-8000-00000000d1d1';

  SELECT * INTO r FROM app.generate_seat_plan(
    '7e000000-0000-4000-8000-000000000092', '2026-12-14', '10:00');

  IF r.seats_available <> 6 OR r.students_seated <> 6 OR r.students_unseated <> 6 THEN
    RAISE EXCEPTION 'FAIL 4: seats %, seated %, unseated %',
      r.seats_available, r.students_seated, r.students_unseated;
  END IF;
  RAISE NOTICE 'PASS 4 — ৬ of ১২ seated, ৬ unseated: a report, not an exception';

  UPDATE exam_halls SET rows_count = 3, cols_count = 4
   WHERE id = '7e000000-0000-4000-8000-00000000d1d1';
  PERFORM app.generate_seat_plan(
    '7e000000-0000-4000-8000-000000000092', '2026-12-14', '10:00');
END $$;

-- ---------------------------------------------------------------------
-- 5. A grid larger than the room is refused. Twelve benches in a room
--    recorded as holding eight is a plan that fails on the morning.
-- ---------------------------------------------------------------------
DO $$
BEGIN
  UPDATE rooms SET capacity = 8 WHERE id = '7e000000-0000-4000-8000-00000000a0a0';
  BEGIN
    UPDATE exam_halls SET rows_count = 3, cols_count = 4
     WHERE id = '7e000000-0000-4000-8000-00000000d1d1';
    RAISE EXCEPTION 'FAIL 5: a 12-seat grid was accepted in an 8-seat room';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;
  UPDATE rooms SET capacity = 60 WHERE id = '7e000000-0000-4000-8000-00000000a0a0';
  RAISE NOTICE 'PASS 5 — a grid that overflows the room is refused';
END $$;

-- ---------------------------------------------------------------------
-- 6. Nobody is seated in two halls at once — the seat-level echo of F-510.
-- ---------------------------------------------------------------------
DO $$
DECLARE v_enrol uuid; v_subj uuid;
BEGIN
  INSERT INTO exam_halls (id, tenant_id, exam_id, exam_date, start_time, room_id, rows_count, cols_count)
  VALUES ('7e000000-0000-4000-8000-00000000d2d2', app.current_tenant(),
          '7e000000-0000-4000-8000-000000000092', '2026-12-14', '10:00',
          '7e000000-0000-4000-8000-00000000a0a1', 2, 2);

  SELECT enrolment_id, exam_subject_id INTO v_enrol, v_subj FROM exam_seats LIMIT 1;
  BEGIN
    INSERT INTO exam_seats (tenant_id, hall_id, seat_row, seat_col, enrolment_id,
                            exam_subject_id, exam_id, exam_date, start_time)
    VALUES (app.current_tenant(), '7e000000-0000-4000-8000-00000000d2d2', 1, 1,
            v_enrol, v_subj, '7e000000-0000-4000-8000-000000000092', '2026-12-14', '10:00');
    RAISE EXCEPTION 'FAIL 6: a student was seated in two halls in one session';
  EXCEPTION WHEN unique_violation THEN
    NULL;
  END;
  DELETE FROM exam_halls WHERE id = '7e000000-0000-4000-8000-00000000d2d2';
  RAISE NOTICE 'PASS 6 — a second seat for the same student in the same session is rejected';
END $$;

-- ---------------------------------------------------------------------
-- 7. F-512 HARD FILTER 1: the subject's own teacher is not offered.
--    The inversion of the substitution scorer, where subject competency is
--    the strongest POSITIVE.
-- ---------------------------------------------------------------------
DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM app.rank_invigilators('7e000000-0000-4000-8000-00000000d1d1')
   WHERE teacher_id = '7e000000-0000-4000-8000-00000000a1a1';
  IF n <> 0 THEN
    RAISE EXCEPTION 'FAIL 7: the Chemistry teacher was offered for the Chemistry paper';
  END IF;
  RAISE NOTICE 'PASS 7 — the subject''s own teacher is excluded, not merely down-ranked';
END $$;

-- ---------------------------------------------------------------------
-- 8. F-512 HARD FILTER 2: a routine obligation in the same slot excludes.
--    2026-12-14 is a Monday (dow 1).
-- ---------------------------------------------------------------------
DO $$
DECLARE n int; free_n int;
BEGIN
  INSERT INTO period_templates (id, tenant_id, name_bn, shift, effective_from)
  VALUES ('7e000000-0000-4000-8000-00000000e0e0', app.current_tenant(), 'সাধারণ', 'single', '2026-01-01');
  INSERT INTO period_definitions (id, tenant_id, template_id, period_no, label_bn, starts_at, ends_at, kind)
  VALUES ('7e000000-0000-4000-8000-00000000e1e1', app.current_tenant(),
          '7e000000-0000-4000-8000-00000000e0e0', 1, '১ম', '10:00', '11:00', 'teaching');
  INSERT INTO routines (id, tenant_id, academic_year_id, period_template_id, name_bn, status, effective_from)
  VALUES ('7e000000-0000-4000-8000-00000000f0f0', app.current_tenant(),
          '7e000000-0000-4000-8000-000000000091', '7e000000-0000-4000-8000-00000000e0e0',
          'রুটিন', 'active', '2026-01-01');
  -- t2 teaches something else, but at exactly the exam hour on that weekday.
  INSERT INTO subjects (id, tenant_id, nctb_code, name_bn, name_en)
  VALUES ('7e000000-0000-4000-8000-000000000109', app.current_tenant(), '109', 'বাংলা', 'Bangla');
  INSERT INTO routine_slots (tenant_id, routine_id, day_of_week, period_no, period_definition_id,
                             starts_at, ends_at, primary_section_id, subject_id, teacher_id)
  VALUES (app.current_tenant(), '7e000000-0000-4000-8000-00000000f0f0', 1, 1,
          '7e000000-0000-4000-8000-00000000e1e1', '10:00', '11:00',
          '7e000000-0000-4000-8000-00000000b1b1', '7e000000-0000-4000-8000-000000000109',
          '7e000000-0000-4000-8000-00000000a2a2');

  SELECT count(*) INTO n FROM app.rank_invigilators('7e000000-0000-4000-8000-00000000d1d1')
   WHERE teacher_id = '7e000000-0000-4000-8000-00000000a2a2';
  IF n <> 0 THEN
    RAISE EXCEPTION 'FAIL 8: a teacher timetabled into the exam hour was offered for duty';
  END IF;

  -- And the free teacher IS offered — an exclusion list that excludes
  -- everybody is not a filter, it is a bug.
  SELECT count(*) INTO free_n FROM app.rank_invigilators('7e000000-0000-4000-8000-00000000d1d1')
   WHERE teacher_id = '7e000000-0000-4000-8000-00000000a3a3';
  IF free_n <> 1 THEN
    RAISE EXCEPTION 'FAIL 8: the free teacher was not offered (got % rows)', free_n;
  END IF;
  RAISE NOTICE 'PASS 8 — the busy teacher is excluded and the free one is offered';
END $$;

-- ---------------------------------------------------------------------
-- 9. The ranker only suggests. The trigger refuses, because a candidate
--    list goes stale between loading it and pressing assign.
-- ---------------------------------------------------------------------
DO $$
DECLARE msg text;
BEGIN
  BEGIN
    INSERT INTO exam_invigilations (tenant_id, hall_id, teacher_id)
    VALUES (app.current_tenant(), '7e000000-0000-4000-8000-00000000d1d1',
            '7e000000-0000-4000-8000-00000000a1a1');
    RAISE EXCEPTION 'FAIL 9: the subject teacher was assigned to their own paper';
  EXCEPTION WHEN check_violation THEN
    GET STACKED DIAGNOSTICS msg = MESSAGE_TEXT;
  END;
  IF msg NOT LIKE '%রসায়ন%' THEN
    RAISE EXCEPTION 'FAIL 9: the error does not name the subject: %', msg;
  END IF;

  BEGIN
    INSERT INTO exam_invigilations (tenant_id, hall_id, teacher_id)
    VALUES (app.current_tenant(), '7e000000-0000-4000-8000-00000000d1d1',
            '7e000000-0000-4000-8000-00000000a2a2');
    RAISE EXCEPTION 'FAIL 9: a teacher with a routine obligation was assigned';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;
  RAISE NOTICE 'PASS 9 — both hard filters re-checked at write time, and the error names রসায়ন';
END $$;

-- ---------------------------------------------------------------------
-- 10. An unstaffed hall blocks publication, and staffing it unblocks.
--     Same reasoning as F-510: discovered on the morning is too late.
-- ---------------------------------------------------------------------
DO $$
DECLARE msg text;
BEGIN
  BEGIN
    UPDATE exams SET status = 'published' WHERE id = '7e000000-0000-4000-8000-000000000092';
    RAISE EXCEPTION 'FAIL 10: an exam with an unstaffed hall was published';
  EXCEPTION WHEN check_violation THEN
    GET STACKED DIAGNOSTICS msg = MESSAGE_TEXT;
  END;
  IF msg NOT LIKE '%HALL-1%' THEN
    RAISE EXCEPTION 'FAIL 10: the error does not name the hall: %', msg;
  END IF;

  INSERT INTO exam_invigilations (tenant_id, hall_id, teacher_id, duty, assigned_mode)
  VALUES (app.current_tenant(), '7e000000-0000-4000-8000-00000000d1d1',
          '7e000000-0000-4000-8000-00000000a3a3', 'chief', 'ranked');

  UPDATE exams SET status = 'published' WHERE id = '7e000000-0000-4000-8000-000000000092';
  RAISE NOTICE 'PASS 10 — publication blocked while HALL-1 was unstaffed, and succeeds once staffed';
END $$;

-- ---------------------------------------------------------------------
-- 11. Fairness: a teacher already holding duty this exam ranks below one
--     who holds none. The only weight left after the hard filters.
-- ---------------------------------------------------------------------
DO $$
DECLARE s3 numeric; s4 numeric;
BEGIN
  INSERT INTO users (id, tenant_id, full_name_bn, full_name_en, phone_e164, status)
  VALUES ('7e000000-0000-4000-8000-00000000a4a4', app.current_tenant(),
          'নতুন শিক্ষক', 'Fresh Teacher', '+8801795000014', 'active');
  INSERT INTO user_roles (tenant_id, user_id, role_code, scope_type)
  VALUES (app.current_tenant(), '7e000000-0000-4000-8000-00000000a4a4', 'subject_teacher', 'tenant');

  -- A second hall in a LATER session, so t3's existing duty counts toward
  -- the exam total without the same-session filter excluding them.
  INSERT INTO exam_halls (id, tenant_id, exam_id, exam_date, start_time, room_id, rows_count, cols_count)
  VALUES ('7e000000-0000-4000-8000-00000000d3d3', app.current_tenant(),
          '7e000000-0000-4000-8000-000000000092', '2026-12-16', '10:00',
          '7e000000-0000-4000-8000-00000000a0a0', 2, 2);

  SELECT score INTO s3 FROM app.rank_invigilators('7e000000-0000-4000-8000-00000000d3d3')
   WHERE teacher_id = '7e000000-0000-4000-8000-00000000a3a3';
  SELECT score INTO s4 FROM app.rank_invigilators('7e000000-0000-4000-8000-00000000d3d3')
   WHERE teacher_id = '7e000000-0000-4000-8000-00000000a4a4';

  IF s3 IS NULL OR s4 IS NULL THEN
    RAISE EXCEPTION 'FAIL 11: expected both teachers to be eligible (t3=%, t4=%)', s3, s4;
  END IF;
  IF NOT (s4 > s3) THEN
    RAISE EXCEPTION 'FAIL 11: the teacher with no duty (%) does not outrank the one with one (%)', s4, s3;
  END IF;
  RAISE NOTICE 'PASS 11 — duty is spread: the unburdened teacher ranks above (% > %)', s4, s3;
END $$;

-- ---------------------------------------------------------------------
-- 12. Tenant isolation. Another tenant sees none of this.
-- ---------------------------------------------------------------------
SET LOCAL app.tenant_id = '7e000000-0000-4000-8000-00000000000f';
DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM exam_seats;
  IF n <> 0 THEN RAISE EXCEPTION 'FAIL 12: another tenant sees % seats', n; END IF;
  SELECT count(*) INTO n FROM exam_invigilations;
  IF n <> 0 THEN RAISE EXCEPTION 'FAIL 12: another tenant sees % duties', n; END IF;
  RAISE NOTICE 'PASS 12 — a foreign tenant sees no seats and no duty roster';
END $$;

ROLLBACK;
