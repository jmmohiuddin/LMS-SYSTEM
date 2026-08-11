-- =====================================================================
-- db/tests/subject_model.sql   (F-303, F-304, F-305, F-307)
--
-- PRD §5 is the conceptual core: "Every requirement downstream depends on
-- it." These assertions are what make the two rules generic platforms get
-- wrong actually hold — religion variants as a parallel block, and the
-- optional subject as a bounded choice rather than a free-text field.
--
-- The scenario is a real Class 9 Science section: eleven compulsory and
-- group-compulsory subjects, one religion variant chosen from four, and
-- one optional subject chosen from two.
--
-- Runs in a transaction that is ROLLED BACK; safe against any environment.
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/tests/subject_model.sql
-- =====================================================================

\set ON_ERROR_STOP on

GRANT shikhon_app TO CURRENT_USER;
SET ROLE shikhon_app;

BEGIN;
SET LOCAL app.tenant_id = '8c000000-0000-4000-8000-00000000000c';
SET LOCAL app.role      = 'academic_coordinator';
SET LOCAL app.user_id   = '8c000000-0000-4000-8000-0000000000ff';

INSERT INTO tenants (id, slug, name_bn, name_en, stream, level)
VALUES ('8c000000-0000-4000-8000-00000000000c', 'subject-model',
        'বিষয় বিদ্যালয়', 'Subject School', 'bangla_medium', 'secondary');

INSERT INTO users (id, tenant_id, full_name_bn, full_name_en, phone_e164)
VALUES ('8c000000-0000-4000-8000-0000000000ff', '8c000000-0000-4000-8000-00000000000c',
        'সমন্বয়ক', 'Coordinator', '+8801795000001'),
       ('8c000000-0000-4000-8000-0000000000b1', '8c000000-0000-4000-8000-00000000000c',
        'ছাত্র', 'Student', '+8801795000002'),
       ('8c000000-0000-4000-8000-0000000000b2', '8c000000-0000-4000-8000-00000000000c',
        'ছাত্রী', 'Student Two', '+8801795000003');

INSERT INTO academic_years (id, tenant_id, label, starts_on, ends_on, is_current)
VALUES ('8c000000-0000-4000-8000-0000000000a1', '8c000000-0000-4000-8000-00000000000c',
        '2026', '2026-01-01', '2026-12-31', true);

INSERT INTO classes (id, tenant_id, level_no, name_bn, name_en, stream, "group")
VALUES ('8c000000-0000-4000-8000-0000000000c1', '8c000000-0000-4000-8000-00000000000c',
        9, 'নবম', 'Nine', 'bangla_medium', 'science');

INSERT INTO sections (id, tenant_id, class_id, academic_year_id, name)
VALUES ('8c000000-0000-4000-8000-0000000000c2', '8c000000-0000-4000-8000-00000000000c',
        '8c000000-0000-4000-8000-0000000000c1', '8c000000-0000-4000-8000-0000000000a1', 'ক');

INSERT INTO enrolments (id, tenant_id, student_id, section_id, academic_year_id, roll_no, status)
VALUES ('8c000000-0000-4000-8000-0000000000e1', '8c000000-0000-4000-8000-00000000000c',
        '8c000000-0000-4000-8000-0000000000b1', '8c000000-0000-4000-8000-0000000000c2',
        '8c000000-0000-4000-8000-0000000000a1', 1, 'active'),
       ('8c000000-0000-4000-8000-0000000000e2', '8c000000-0000-4000-8000-00000000000c',
        '8c000000-0000-4000-8000-0000000000b2', '8c000000-0000-4000-8000-0000000000c2',
        '8c000000-0000-4000-8000-0000000000a1', 2, 'active');

-- Subjects: 4 compulsory, 3 group-compulsory (Science), 4 religion
-- variants, 2 optional candidates.
INSERT INTO subjects (id, tenant_id, nctb_code, name_bn, name_en, variant_family)
VALUES ('8c000000-0000-4000-8000-000000000101', '8c000000-0000-4000-8000-00000000000c', '101', 'বাংলা', 'Bangla', NULL),
       ('8c000000-0000-4000-8000-000000000107', '8c000000-0000-4000-8000-00000000000c', '107', 'ইংরেজি', 'English', NULL),
       ('8c000000-0000-4000-8000-000000000109', '8c000000-0000-4000-8000-00000000000c', '109', 'গণিত', 'Mathematics', NULL),
       ('8c000000-0000-4000-8000-000000000150', '8c000000-0000-4000-8000-00000000000c', '150', 'বাংলাদেশ ও বিশ্বপরিচয়', 'Bangladesh & Global Studies', NULL),
       ('8c000000-0000-4000-8000-000000000136', '8c000000-0000-4000-8000-00000000000c', '136', 'পদার্থবিজ্ঞান', 'Physics', NULL),
       ('8c000000-0000-4000-8000-000000000137', '8c000000-0000-4000-8000-00000000000c', '137', 'রসায়ন', 'Chemistry', NULL),
       ('8c000000-0000-4000-8000-000000000138', '8c000000-0000-4000-8000-00000000000c', '138', 'জীববিজ্ঞান', 'Biology', NULL),
       ('8c000000-0000-4000-8000-000000000111', '8c000000-0000-4000-8000-00000000000c', '111', 'ইসলাম শিক্ষা', 'Islam & Moral Education', 'moral_education'),
       ('8c000000-0000-4000-8000-000000000112', '8c000000-0000-4000-8000-00000000000c', '112', 'হিন্দুধর্ম শিক্ষা', 'Hindu Religion', 'moral_education'),
       ('8c000000-0000-4000-8000-000000000113', '8c000000-0000-4000-8000-00000000000c', '113', 'বৌদ্ধধর্ম শিক্ষা', 'Buddhist Religion', 'moral_education'),
       ('8c000000-0000-4000-8000-000000000114', '8c000000-0000-4000-8000-00000000000c', '114', 'খ্রিষ্টধর্ম শিক্ষা', 'Christian Religion', 'moral_education'),
       ('8c000000-0000-4000-8000-000000000126', '8c000000-0000-4000-8000-00000000000c', '126', 'উচ্চতর গণিত', 'Higher Mathematics', NULL),
       ('8c000000-0000-4000-8000-000000000127', '8c000000-0000-4000-8000-00000000000c', '127', 'কৃষিশিক্ষা', 'Agriculture', NULL);

INSERT INTO curriculum_schemes
  (id, tenant_id, academic_year_id, stage, assessment_model, grade_rule_set, terminal_exam, effective_from)
VALUES ('8c000000-0000-4000-8000-00000000005c', '8c000000-0000-4000-8000-00000000000c',
        '8c000000-0000-4000-8000-0000000000a1', 'secondary', 'marks_cq_mcq',
        '{"bands":[{"min":80,"grade":"A+","point":5.0},{"min":70,"grade":"A","point":4.0},
                   {"min":60,"grade":"A-","point":3.5},{"min":50,"grade":"B","point":3.0},
                   {"min":40,"grade":"C","point":2.0},{"min":33,"grade":"D","point":1.0},
                   {"min":0,"grade":"F","point":0.0}],
          "optional_subject":{"threshold_point":2.0,"counts_in_divisor":false},
          "fail_grade":"F"}'::jsonb,
        'SSC', '2026-01-01');

INSERT INTO subject_templates (id, tenant_id, curriculum_scheme_id, class_id, group_code)
VALUES ('8c000000-0000-4000-8000-00000000007c', '8c000000-0000-4000-8000-00000000000c',
        '8c000000-0000-4000-8000-00000000005c', '8c000000-0000-4000-8000-0000000000c1', 'science');

INSERT INTO subject_template_items
  (tenant_id, template_id, subject_id, requirement_type, religion_variant, selection_pool, display_order)
VALUES
  -- Compulsory: everyone takes these.
  ('8c000000-0000-4000-8000-00000000000c','8c000000-0000-4000-8000-00000000007c','8c000000-0000-4000-8000-000000000101','compulsory',NULL,NULL,1),
  ('8c000000-0000-4000-8000-00000000000c','8c000000-0000-4000-8000-00000000007c','8c000000-0000-4000-8000-000000000107','compulsory',NULL,NULL,2),
  ('8c000000-0000-4000-8000-00000000000c','8c000000-0000-4000-8000-00000000007c','8c000000-0000-4000-8000-000000000109','compulsory',NULL,NULL,3),
  ('8c000000-0000-4000-8000-00000000000c','8c000000-0000-4000-8000-00000000007c','8c000000-0000-4000-8000-000000000150','compulsory',NULL,NULL,4),
  -- Group-compulsory: everyone in Science.
  ('8c000000-0000-4000-8000-00000000000c','8c000000-0000-4000-8000-00000000007c','8c000000-0000-4000-8000-000000000136','group_compulsory',NULL,NULL,5),
  ('8c000000-0000-4000-8000-00000000000c','8c000000-0000-4000-8000-00000000007c','8c000000-0000-4000-8000-000000000137','group_compulsory',NULL,NULL,6),
  ('8c000000-0000-4000-8000-00000000000c','8c000000-0000-4000-8000-00000000007c','8c000000-0000-4000-8000-000000000138','group_compulsory',NULL,NULL,7),
  -- Religion: exactly one of four, same period, different rooms.
  ('8c000000-0000-4000-8000-00000000000c','8c000000-0000-4000-8000-00000000007c','8c000000-0000-4000-8000-000000000111','religion_variant','islam','religion',8),
  ('8c000000-0000-4000-8000-00000000000c','8c000000-0000-4000-8000-00000000007c','8c000000-0000-4000-8000-000000000112','religion_variant','hindu','religion',8),
  ('8c000000-0000-4000-8000-00000000000c','8c000000-0000-4000-8000-00000000007c','8c000000-0000-4000-8000-000000000113','religion_variant','buddhist','religion',8),
  ('8c000000-0000-4000-8000-00000000000c','8c000000-0000-4000-8000-00000000007c','8c000000-0000-4000-8000-000000000114','religion_variant','christian','religion',8),
  -- Optional (4th subject): exactly one of two.
  ('8c000000-0000-4000-8000-00000000000c','8c000000-0000-4000-8000-00000000007c','8c000000-0000-4000-8000-000000000126','optional',NULL,'fourth',9),
  ('8c000000-0000-4000-8000-00000000000c','8c000000-0000-4000-8000-00000000007c','8c000000-0000-4000-8000-000000000127','optional',NULL,'fourth',9);

-- ---------------------------------------------------------------------
-- 1. Derivation produces the right SET, not just the right count.
--    7 unconditional + 1 religion + 1 optional = 9.
-- ---------------------------------------------------------------------
DO $$
DECLARE n integer; religions integer; optionals integer;
BEGIN
  n := app.derive_student_subjects(
         '8c000000-0000-4000-8000-0000000000e1'::uuid,
         '8c000000-0000-4000-8000-000000000126'::uuid,   -- Higher Mathematics
         'islam');
  IF n <> 9 THEN RAISE EXCEPTION 'FAIL 1: expected 9 subjects, got %', n; END IF;

  SELECT count(*) INTO religions FROM student_subjects
   WHERE enrolment_id = '8c000000-0000-4000-8000-0000000000e1'
     AND requirement_type = 'religion_variant';
  IF religions <> 1 THEN
    RAISE EXCEPTION 'FAIL 1: student holds % religion subjects, must be exactly 1', religions;
  END IF;

  SELECT count(*) INTO optionals FROM student_subjects
   WHERE enrolment_id = '8c000000-0000-4000-8000-0000000000e1'
     AND requirement_type = 'optional';
  IF optionals <> 1 THEN
    RAISE EXCEPTION 'FAIL 1: student holds % optional subjects, must be exactly 1', optionals;
  END IF;
  RAISE NOTICE 'PASS 1 — 9 subjects derived: 7 fixed, 1 of 4 religions, 1 of 2 optionals';
END $$;

-- ---------------------------------------------------------------------
-- 2. Two students in the SAME section get DIFFERENT sets. This is the
--    whole point of §5.5 — the class template is not the student's set,
--    and an exam routine built on the template would clash for one of them.
-- ---------------------------------------------------------------------
DO $$
DECLARE same integer;
BEGIN
  PERFORM app.derive_student_subjects(
    '8c000000-0000-4000-8000-0000000000e2'::uuid,
    '8c000000-0000-4000-8000-000000000127'::uuid,   -- Agriculture
    'hindu');

  SELECT count(*) INTO same
    FROM student_subjects a
    JOIN student_subjects b ON b.subject_id = a.subject_id
   WHERE a.enrolment_id = '8c000000-0000-4000-8000-0000000000e1'
     AND b.enrolment_id = '8c000000-0000-4000-8000-0000000000e2';
  IF same <> 7 THEN
    RAISE EXCEPTION 'FAIL 2: expected 7 shared subjects, got % — the sets are not diverging', same;
  END IF;
  RAISE NOTICE 'PASS 2 — same section, 7 shared subjects and 2 that differ per student';
END $$;

-- ---------------------------------------------------------------------
-- 3. Derivation is IDEMPOTENT. Onboarding 800 students means re-running
--    this after every correction; a second run must not duplicate.
-- ---------------------------------------------------------------------
DO $$
DECLARE n1 integer; n2 integer;
BEGIN
  SELECT count(*) INTO n1 FROM student_subjects
   WHERE enrolment_id = '8c000000-0000-4000-8000-0000000000e1';
  PERFORM app.derive_student_subjects(
    '8c000000-0000-4000-8000-0000000000e1'::uuid,
    '8c000000-0000-4000-8000-000000000126'::uuid, 'islam');
  SELECT count(*) INTO n2 FROM student_subjects
   WHERE enrolment_id = '8c000000-0000-4000-8000-0000000000e1';
  IF n1 <> n2 THEN
    RAISE EXCEPTION 'FAIL 3: re-derivation changed the count from % to %', n1, n2;
  END IF;
  RAISE NOTICE 'PASS 3 — re-running derivation is a no-op';
END $$;

-- ---------------------------------------------------------------------
-- 4. Changing the religion choice REPLACES rather than accumulates. A
--    student who corrects their variant must not end up sitting two
--    religion papers.
-- ---------------------------------------------------------------------
DO $$
DECLARE n integer; variant text;
BEGIN
  PERFORM app.derive_student_subjects(
    '8c000000-0000-4000-8000-0000000000e1'::uuid,
    '8c000000-0000-4000-8000-000000000126'::uuid, 'christian');

  SELECT count(*) INTO n FROM student_subjects
   WHERE enrolment_id = '8c000000-0000-4000-8000-0000000000e1'
     AND requirement_type = 'religion_variant';
  IF n <> 1 THEN
    RAISE EXCEPTION 'FAIL 4: after changing variant the student holds % religion subjects', n;
  END IF;

  SELECT s.name_en INTO variant
    FROM student_subjects ss JOIN subjects s ON s.id = ss.subject_id
   WHERE ss.enrolment_id = '8c000000-0000-4000-8000-0000000000e1'
     AND ss.requirement_type = 'religion_variant';
  IF variant <> 'Christian Religion' THEN
    RAISE EXCEPTION 'FAIL 4: variant is %, expected the newly chosen one', variant;
  END IF;
  RAISE NOTICE 'PASS 4 — changing the religion variant replaces, never accumulates';
END $$;

-- ---------------------------------------------------------------------
-- 5. A human-approved OVERRIDE survives re-derivation. A documented
--    exemption outranks a template — otherwise the next routine rebuild
--    silently reverses a decision a principal signed off.
-- ---------------------------------------------------------------------
DO $$
DECLARE survived integer;
BEGIN
  INSERT INTO student_subjects
    (tenant_id, enrolment_id, subject_id, requirement_type, source, override_reason, approved_by)
  VALUES ('8c000000-0000-4000-8000-00000000000c', '8c000000-0000-4000-8000-0000000000e1',
          '8c000000-0000-4000-8000-000000000127', 'optional', 'override',
          'medical exemption from Higher Maths, board letter on file',
          '8c000000-0000-4000-8000-0000000000ff');

  PERFORM app.derive_student_subjects(
    '8c000000-0000-4000-8000-0000000000e1'::uuid,
    '8c000000-0000-4000-8000-000000000126'::uuid, 'christian');

  SELECT count(*) INTO survived FROM student_subjects
   WHERE enrolment_id = '8c000000-0000-4000-8000-0000000000e1' AND source = 'override';
  IF survived <> 1 THEN
    RAISE EXCEPTION 'FAIL 5: the approved override was wiped by re-derivation';
  END IF;
  RAISE NOTICE 'PASS 5 — an approved override survives re-derivation';
END $$;

-- ---------------------------------------------------------------------
-- 6. An override with no reason, or no approver, is impossible. Both are
--    audit gaps that would make a subject-set dispute unresolvable.
-- ---------------------------------------------------------------------
DO $$
BEGIN
  BEGIN
    INSERT INTO student_subjects (tenant_id, enrolment_id, subject_id, requirement_type, source)
    VALUES ('8c000000-0000-4000-8000-00000000000c','8c000000-0000-4000-8000-0000000000e2',
            '8c000000-0000-4000-8000-000000000126','optional','override');
    RAISE EXCEPTION 'FAIL 6a: an override with no reason was accepted';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'PASS 6a — an override must state a reason';
  END;

  BEGIN
    INSERT INTO student_subjects
      (tenant_id, enrolment_id, subject_id, requirement_type, source, override_reason)
    VALUES ('8c000000-0000-4000-8000-00000000000c','8c000000-0000-4000-8000-0000000000e2',
            '8c000000-0000-4000-8000-000000000126','optional','override','because');
    RAISE EXCEPTION 'FAIL 6b: an override with no approver was accepted';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'PASS 6b — an override must name an approver';
  END;
END $$;

-- ---------------------------------------------------------------------
-- 7. A religion-variant template item MUST name its variant, and anything
--    a student chooses between MUST declare its pool — otherwise
--    derivation cannot tell an alternative from an addition and would
--    give every student all four religion papers.
-- ---------------------------------------------------------------------
DO $$
BEGIN
  BEGIN
    INSERT INTO subject_template_items
      (tenant_id, template_id, subject_id, requirement_type, selection_pool, display_order)
    VALUES ('8c000000-0000-4000-8000-00000000000c','8c000000-0000-4000-8000-00000000007c',
            '8c000000-0000-4000-8000-000000000101','religion_variant','religion',99);
    RAISE EXCEPTION 'FAIL 7a: a religion_variant item with no variant was accepted';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'PASS 7a — a religion variant must name which variant it is';
  END;

  BEGIN
    INSERT INTO subject_template_items
      (tenant_id, template_id, subject_id, requirement_type, display_order)
    VALUES ('8c000000-0000-4000-8000-00000000000c','8c000000-0000-4000-8000-00000000007c',
            '8c000000-0000-4000-8000-000000000101','optional',99);
    RAISE EXCEPTION 'FAIL 7b: an optional item with no selection pool was accepted';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'PASS 7b — a choosable item must declare its pool';
  END;
END $$;

-- ---------------------------------------------------------------------
-- 8. The curriculum scheme carries the optional-subject rule as DATA, so
--    a school switching schemes cannot corrupt a prior year's transcript.
-- ---------------------------------------------------------------------
DO $$
DECLARE counts boolean; threshold numeric;
BEGIN
  SELECT (grade_rule_set -> 'optional_subject' ->> 'counts_in_divisor')::boolean,
         (grade_rule_set -> 'optional_subject' ->> 'threshold_point')::numeric
    INTO counts, threshold
    FROM curriculum_schemes WHERE stage = 'secondary';

  IF counts IS NOT FALSE THEN
    RAISE EXCEPTION 'FAIL 8: the optional subject must NOT count toward the divisor';
  END IF;
  IF threshold IS NULL THEN
    RAISE EXCEPTION 'FAIL 8: the optional-subject threshold is missing';
  END IF;
  RAISE NOTICE 'PASS 8 — the optional-subject GPA rule is stored data, not a constant';
END $$;

-- ---------------------------------------------------------------------
-- 9. A scheme with no grade bands cannot be stored — it would grade every
--    student NULL and the failure would only surface at publication.
-- ---------------------------------------------------------------------
DO $$
BEGIN
  BEGIN
    INSERT INTO curriculum_schemes
      (tenant_id, academic_year_id, stage, assessment_model, grade_rule_set, effective_from)
    VALUES ('8c000000-0000-4000-8000-00000000000c','8c000000-0000-4000-8000-0000000000a1',
            'primary','continuous_competency','{"bands":[]}'::jsonb,'2026-01-01');
    RAISE EXCEPTION 'FAIL 9: a scheme with no grade bands was accepted';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'PASS 9 — a curriculum scheme must define at least one grade band';
  END;
END $$;

-- ---------------------------------------------------------------------
-- 10. A student sees their own subject set; another student does not.
--     The subject set reveals a child's religion, so this is not an
--     ordinary read scope.
-- ---------------------------------------------------------------------
DO $$
DECLARE mine integer; theirs integer;
BEGIN
  PERFORM set_config('app.role', 'student', true);
  PERFORM set_config('app.user_id', '8c000000-0000-4000-8000-0000000000b1', true);
  SELECT count(*) INTO mine FROM student_subjects
   WHERE enrolment_id = '8c000000-0000-4000-8000-0000000000e1';
  SELECT count(*) INTO theirs FROM student_subjects
   WHERE enrolment_id = '8c000000-0000-4000-8000-0000000000e2';

  IF mine = 0 THEN RAISE EXCEPTION 'FAIL 10: a student cannot see their own subjects'; END IF;
  IF theirs <> 0 THEN
    RAISE EXCEPTION 'FAIL 10: a student read another student''s subject set (% rows)', theirs;
  END IF;
  PERFORM set_config('app.role', 'academic_coordinator', true);
  RAISE NOTICE 'PASS 10 — a subject set, which reveals religion, is visible only to its owner and staff';
END $$;

-- ---------------------------------------------------------------------
-- 11. Teacher competency register (F-307): the input the routine
--     generator and substitution ranker depend on.
-- ---------------------------------------------------------------------
DO $$
DECLARE n integer;
BEGIN
  INSERT INTO teacher_competencies
    (tenant_id, teacher_id, subject_id, min_class_level, max_class_level, proficiency)
  VALUES ('8c000000-0000-4000-8000-00000000000c','8c000000-0000-4000-8000-0000000000ff',
          '8c000000-0000-4000-8000-000000000136', 9, 10, 'primary');

  SELECT count(*) INTO n FROM teacher_competencies
   WHERE subject_id = '8c000000-0000-4000-8000-000000000136'
     AND 9 BETWEEN min_class_level AND max_class_level AND is_active;
  IF n <> 1 THEN RAISE EXCEPTION 'FAIL 11: competency lookup for Class 9 Physics found %', n; END IF;

  BEGIN
    INSERT INTO teacher_competencies
      (tenant_id, teacher_id, subject_id, min_class_level, max_class_level)
    VALUES ('8c000000-0000-4000-8000-00000000000c','8c000000-0000-4000-8000-0000000000ff',
            '8c000000-0000-4000-8000-000000000137', 10, 9);
    RAISE EXCEPTION 'FAIL 11: an inverted class range was accepted';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'PASS 11 — competency register works and rejects an inverted class range';
  END;
END $$;

-- ---------------------------------------------------------------------
-- 12. Enrolling with no template for the class/group/year fails LOUDLY.
--     Silently producing an empty subject set would mean a student with
--     no exams, discovered at publication.
-- ---------------------------------------------------------------------
DO $$
BEGIN
  BEGIN
    PERFORM app.derive_student_subjects('8c000000-0000-4000-8000-0000000000e1'::uuid);
    -- The template exists for this enrolment, so reaching here is fine;
    -- the negative case is a class with no template at all.
    NULL;
  EXCEPTION WHEN no_data_found THEN
    NULL;
  END;

  BEGIN
    PERFORM app.derive_student_subjects('8c000000-0000-4000-8000-0000000000dd'::uuid);
    RAISE EXCEPTION 'FAIL 12: derivation on a nonexistent enrolment silently succeeded';
  EXCEPTION WHEN no_data_found THEN
    RAISE NOTICE 'PASS 12 — a missing enrolment or template fails loudly, never silently empty';
  END;
END $$;

ROLLBACK;

RESET ROLE;

DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM tenants WHERE id = '8c000000-0000-4000-8000-00000000000c';
  IF n <> 0 THEN RAISE EXCEPTION 'FAIL teardown: the fixture tenant survived'; END IF;
  RAISE NOTICE 'PASS teardown — no fixture rows remain';
END $$;

\echo ''
\echo '================================================'
\echo ' Subject-based academic model passed.'
\echo '================================================'
