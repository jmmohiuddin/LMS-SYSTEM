-- =====================================================================
-- db/tests/e2e_academic_cycle.sql
--
-- End-to-end proof that a provisioned tenant actually works: provision →
-- enrol → examine → grade → GPA, using ONLY app.provision_tenant() output
-- (no hand-seeded grading bands). This is what catches "the schema deploys
-- but the product doesn't function".
--
-- Everything runs in one transaction and is ROLLED BACK, so the suite
-- leaves no residue and is safe against any environment.
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/tests/e2e_academic_cycle.sql
-- =====================================================================

\set ON_ERROR_STOP on

-- MANDATORY. Migration/superuser roles (neondb_owner on Neon, postgres
-- locally) carry BYPASSRLS, so running this suite as one of them silently
-- disables tenant isolation and every count below would span all tenants.
-- Assume the application's role, exactly as the services do.
-- The GRANT keeps this suite runnable on its own, without depending on
-- invariants.sql having run first.
GRANT shikhon_app TO CURRENT_USER;
SET ROLE shikhon_app;

BEGIN;
SET LOCAL app.tenant_id = '77777777-7777-4777-8777-777777777777';
SET LOCAL app.role      = 'principal';
SET LOCAL app.user_id   = '77777777-0000-4000-8000-0000000000ff';

-- ── 1. Provision an institution from scratch ─────────────────────────
INSERT INTO tenants (id, slug, name_bn, name_en, stream, level, shifts)
VALUES ('77777777-7777-4777-8777-777777777777', 'e2e-check',
        'ই-টু-ই বিদ্যালয়', 'E2E School', 'bangla_medium', 'secondary', '{day}');

SELECT app.provision_tenant('77777777-7777-4777-8777-777777777777'::uuid, '2026',
                            '2026-01-01'::date, '2026-12-31'::date,
                            6::smallint, 10::smallint);

DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM grading_bands;
  IF n <> 7 THEN RAISE EXCEPTION 'FAIL E1: expected 7 grading bands from provisioning, got %', n; END IF;
  SELECT count(*) INTO n FROM period_definitions;
  IF n < 8 THEN RAISE EXCEPTION 'FAIL E1: bell schedule not provisioned (% periods)', n; END IF;
  RAISE NOTICE 'PASS E1 — provisioning produced a usable grading scale and bell schedule';
END $$;

-- ── 2. Section + students ────────────────────────────────────────────
DO $$
DECLARE
  v_tenant  uuid := '77777777-7777-4777-8777-777777777777';
  v_year    uuid;
  v_class9  uuid;
  v_section uuid;
  v_exam    uuid;
  v_hmath   uuid;
  v_sub     RECORD;
  v_es      uuid;
  v_stu     uuid;
  i         integer;
  v_gpa     RECORD;
BEGIN
  SELECT id INTO v_year   FROM academic_years WHERE label = '2026';
  SELECT id INTO v_class9 FROM classes WHERE level_no = 9;
  SELECT id INTO v_hmath  FROM subjects WHERE name_en = 'Higher Mathematics';

  INSERT INTO sections (id, tenant_id, class_id, academic_year_id, name, shift, capacity)
  VALUES (gen_random_uuid(), v_tenant, v_class9, v_year, 'ক', 'day', 60)
  RETURNING id INTO v_section;

  -- three students, roll 1..3; all take Higher Mathematics as the 4th subject
  FOR i IN 1..3 LOOP
    INSERT INTO users (tenant_id, full_name_bn, full_name_en, phone_e164)
    VALUES (v_tenant, 'শিক্ষার্থী ' || i, 'Student ' || i,
            '+88017000000' || lpad(i::text, 2, '0'))
    RETURNING id INTO v_stu;

    INSERT INTO student_profiles (user_id, tenant_id, student_code, admission_date, admission_class)
    VALUES (v_stu, v_tenant, 'S' || lpad(i::text, 4, '0'), '2026-01-05', 9);

    INSERT INTO enrolments (tenant_id, student_id, section_id, academic_year_id,
                            roll_no, optional_subject_id)
    VALUES (v_tenant, v_stu, v_section, v_year, i, v_hmath);
  END LOOP;

  -- ── 3. Annual exam over 4 compulsory subjects + the optional one ───
  INSERT INTO exams (tenant_id, academic_year_id, name_bn, name_en, exam_type,
                     starts_on, ends_on, status)
  VALUES (v_tenant, v_year, 'বার্ষিক পরীক্ষা ২০২৬', 'Annual 2026', 'annual',
          '2026-11-01', '2026-11-20', 'marking')
  RETURNING id INTO v_exam;

  FOR v_sub IN
    SELECT s.id, s.name_en, cs.cq_marks, cs.mcq_marks, cs.practical_marks,
           cs.total_marks, cs.cq_pass_marks, cs.mcq_pass_marks
    FROM class_subjects cs JOIN subjects s ON s.id = cs.subject_id
    WHERE cs.class_id = v_class9
      AND s.name_en IN ('Bangla 1st Paper','Mathematics','Islam & Moral Education',
                        'Bangladesh & Global Studies','Higher Mathematics')
  LOOP
    INSERT INTO exam_subjects (tenant_id, exam_id, section_id, subject_id, exam_date,
                               cq_max, mcq_max, practical_max, cq_pass, mcq_pass)
    VALUES (v_tenant, v_exam, v_section, v_sub.id, '2026-11-05',
            v_sub.cq_marks, v_sub.mcq_marks, v_sub.practical_marks,
            v_sub.cq_pass_marks, v_sub.mcq_pass_marks);
  END LOOP;

  -- ── 4. Marks ───────────────────────────────────────────────────────
  -- Student 1: 85% everywhere            → all A+ (5.00), optional A+
  -- Student 2: 74% everywhere            → all A  (4.00), optional A too
  -- Student 3: same as S1 but Bangla CQ  = 20 (< pass 23) → component fail
  FOR v_sub IN
    SELECT es.id AS es_id, s.name_en, es.cq_max, es.mcq_max, es.practical_max
    FROM exam_subjects es JOIN subjects s ON s.id = es.subject_id
    WHERE es.exam_id = v_exam
  LOOP
    FOR i IN 1..3 LOOP
      SELECT e.student_id INTO v_stu FROM enrolments e
       WHERE e.section_id = v_section AND e.roll_no = i;

      INSERT INTO exam_marks (tenant_id, exam_subject_id, student_id, academic_year_id,
                              cq_marks, mcq_marks, practical_marks)
      VALUES (
        v_tenant, v_sub.es_id, v_stu, v_year,
        CASE
          WHEN i = 3 AND v_sub.name_en = 'Bangla 1st Paper' THEN 20            -- below cq_pass
          WHEN i = 2 THEN round(v_sub.cq_max  * 0.74, 0)
          ELSE            round(v_sub.cq_max  * 0.85, 0)
        END,
        CASE WHEN i = 2 THEN round(v_sub.mcq_max * 0.74, 0)
             ELSE            round(v_sub.mcq_max * 0.85, 0) END,
        CASE WHEN i = 2 THEN round(v_sub.practical_max * 0.74, 0)
             ELSE            round(v_sub.practical_max * 0.85, 0) END
      );
    END LOOP;
  END LOOP;

  -- ── 5. Grade every mark using the PROVISIONED scale ────────────────
  -- The LATERAL must live in a CTE: an UPDATE's target table cannot be
  -- referenced from a LATERAL in its own FROM clause.
  WITH graded AS (
    SELECT em.id AS mark_id, g.letter, g.grade_point, g.component_failed
    FROM exam_marks em
    JOIN exam_subjects es ON es.id = em.exam_subject_id
    CROSS JOIN LATERAL app.compute_subject_grade(
      v_tenant, em.cq_marks, es.cq_max, es.cq_pass,
      em.mcq_marks, es.mcq_max, es.mcq_pass,
      em.practical_marks, em.ca_marks,
      es.cq_max + es.mcq_max + es.practical_max + es.ca_max,
      em.is_absent,
      (SELECT id FROM grading_scales WHERE is_default LIMIT 1)) g
    WHERE es.exam_id = v_exam
  )
  UPDATE exam_marks m
     SET grade_letter     = graded.letter,
         grade_point      = graded.grade_point,
         component_failed = graded.component_failed
    FROM graded
   WHERE m.id = graded.mark_id;

  -- ── 6. Assertions ──────────────────────────────────────────────────
  -- E2: student 1 — all A+, optional bonus pushes GPA over 5 and it CAPS
  SELECT * INTO v_gpa FROM app.compute_exam_gpa(
    v_tenant, v_exam, (SELECT student_id FROM enrolments
                        WHERE section_id = v_section AND roll_no = 1));
  IF v_gpa.gpa <> 5.00 THEN
    RAISE EXCEPTION 'FAIL E2: expected GPA capped at 5.00, got %', v_gpa.gpa;
  END IF;
  IF NOT v_gpa.is_pass THEN RAISE EXCEPTION 'FAIL E2: student 1 should pass'; END IF;
  RAISE NOTICE 'PASS E2 — all A+ with optional-subject bonus caps at GPA 5.00 (raw would be 5.75)';

  -- E3: student 2 sits every paper at 74% → band A (4.00) in all five.
  --     Compulsory average          = 16.00 / 4 = 4.00
  --     Optional contributes only the excess over 2.00: (4.00 − 2.00) = 2.00
  --     Final GPA                   = (16.00 + 2.00) / 4 = 4.50
  --     Note the divisor stays 4 — the optional subject is never counted in it.
  SELECT * INTO v_gpa FROM app.compute_exam_gpa(
    v_tenant, v_exam, (SELECT student_id FROM enrolments
                        WHERE section_id = v_section AND roll_no = 2));
  IF v_gpa.gpa_no_optional <> 4.00 THEN
    RAISE EXCEPTION 'FAIL E3: expected 4.00 without optional, got %', v_gpa.gpa_no_optional;
  END IF;
  IF v_gpa.gpa <> 4.50 THEN
    RAISE EXCEPTION 'FAIL E3: expected 4.50 with 4th-subject bonus, got %', v_gpa.gpa;
  END IF;
  RAISE NOTICE 'PASS E3 — 4th-subject rule: 4.00 → 4.50 (only points above 2.00 count, divisor unchanged)';

  -- E4: student 3 — one component failure zeroes the whole GPA
  SELECT * INTO v_gpa FROM app.compute_exam_gpa(
    v_tenant, v_exam, (SELECT student_id FROM enrolments
                        WHERE section_id = v_section AND roll_no = 3));
  IF v_gpa.gpa <> 0.00 THEN
    RAISE EXCEPTION 'FAIL E4: a compulsory F must zero the GPA, got %', v_gpa.gpa;
  END IF;
  IF v_gpa.is_pass THEN RAISE EXCEPTION 'FAIL E4: student 3 must not pass'; END IF;
  IF v_gpa.failed_count <> 1 THEN
    RAISE EXCEPTION 'FAIL E4: expected 1 failed subject, got %', v_gpa.failed_count;
  END IF;
  RAISE NOTICE 'PASS E4 — one CQ component failure ⇒ GPA 0.00 and overall Fail';

  -- E5: the failure is a COMPONENT failure, not a total-marks failure
  IF NOT EXISTS (
    SELECT 1 FROM exam_marks em
    JOIN exam_subjects es ON es.id = em.exam_subject_id
    JOIN subjects s ON s.id = es.subject_id
    WHERE es.exam_id = v_exam AND s.name_en = 'Bangla 1st Paper'
      AND em.student_id = (SELECT student_id FROM enrolments
                            WHERE section_id = v_section AND roll_no = 3)
      AND em.component_failed AND em.total_marks >= 40
  ) THEN
    RAISE EXCEPTION 'FAIL E5: component_failed not set on a passing total';
  END IF;
  RAISE NOTICE 'PASS E5 — component_failed set despite a passing TOTAL (the NCTB rule)';

  -- E6: attendance write path works against the provisioned section
  INSERT INTO users (tenant_id, full_name_bn, full_name_en, phone_e164)
  VALUES (v_tenant, 'রহিম স্যার', 'Rahim Sir', '+8801700000099')
  RETURNING id INTO v_stu;

  INSERT INTO attendance_sessions (id, tenant_id, section_id, academic_year_id,
                                   taken_on, mode, taken_by, taken_at)
  VALUES (gen_random_uuid(), v_tenant, v_section, v_year, '2026-08-06',
          'section_daily', v_stu, now());

  -- and the duplicate-session guard holds (offline resubmit must not duplicate)
  BEGIN
    INSERT INTO attendance_sessions (id, tenant_id, section_id, academic_year_id,
                                     taken_on, mode, taken_by, taken_at)
    VALUES (gen_random_uuid(), v_tenant, v_section, v_year, '2026-08-06',
            'section_daily', v_stu, now());
    RAISE EXCEPTION 'FAIL E6: duplicate attendance session for the same day was allowed';
  EXCEPTION WHEN unique_violation THEN
    NULL;  -- expected
  END;
  RAISE NOTICE 'PASS E6 — attendance session accepted; same-day duplicate rejected';
END $$;

ROLLBACK;
RESET ROLE;

\echo ''
\echo '================================================'
\echo ' End-to-end academic cycle passed.'
\echo '================================================'
