-- =====================================================================
-- db/tests/grading_lock.sql   (F-103)
--
-- The optimistic lock on assignment grading, asserted at the level where
-- it actually has to hold: the UPDATE statement. The endpoint's error
-- handling is separately covered, but no amount of application code helps
-- if the predicate itself is wrong, and the predicate is the whole
-- requirement.
--
-- The scenario, which happens in a real staffroom: two teachers open the
-- same unmarked script — a class teacher and a subject teacher, or one
-- teacher on a phone and the same teacher on a laptop. Both read
-- row_version = 1. Both type a mark. Without the lock the second write
-- silently replaces the first and no one ever knows. With it, the second
-- write applies to zero rows and a person is asked.
--
-- Runs in a transaction that is ROLLED BACK; safe against any environment.
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/tests/grading_lock.sql
-- =====================================================================

\set ON_ERROR_STOP on

GRANT shikhon_app TO CURRENT_USER;
SET ROLE shikhon_app;

BEGIN;
SET LOCAL app.tenant_id = '9f000000-0000-4000-8000-00000000000f';
SET LOCAL app.role      = 'principal';
SET LOCAL app.user_id   = '9f000000-0000-4000-8000-00000000a0a1';

INSERT INTO tenants (id, slug, name_bn, name_en, stream, level)
VALUES ('9f000000-0000-4000-8000-00000000000f', 'grade-lock',
        'নম্বর বিদ্যালয়', 'Grade School', 'bangla_medium', 'secondary');

INSERT INTO users (id, tenant_id, full_name_bn, full_name_en, phone_e164)
VALUES ('9f000000-0000-4000-8000-00000000a0a1', '9f000000-0000-4000-8000-00000000000f',
        'শিক্ষক ক', 'Teacher A', '+8801798888801'),
       ('9f000000-0000-4000-8000-00000000a0a2', '9f000000-0000-4000-8000-00000000000f',
        'শিক্ষক খ', 'Teacher B', '+8801798888802'),
       ('9f000000-0000-4000-8000-00000000b0b1', '9f000000-0000-4000-8000-00000000000f',
        'ছাত্র', 'Student', '+8801798888803');

INSERT INTO academic_years (id, tenant_id, label, starts_on, ends_on, is_current)
VALUES ('9f000000-0000-4000-8000-00000000000a', '9f000000-0000-4000-8000-00000000000f',
        '2026', '2026-01-01', '2026-12-31', true);

INSERT INTO classes (id, tenant_id, level_no, name_bn, name_en, stream)
VALUES ('9f000000-0000-4000-8000-00000000000b', '9f000000-0000-4000-8000-00000000000f',
        9, 'নবম', 'Nine', 'bangla_medium');

INSERT INTO sections (id, tenant_id, class_id, academic_year_id, name)
VALUES ('9f000000-0000-4000-8000-00000000000c', '9f000000-0000-4000-8000-00000000000f',
        '9f000000-0000-4000-8000-00000000000b', '9f000000-0000-4000-8000-00000000000a', 'ক');

INSERT INTO subjects (id, tenant_id, nctb_code, name_bn, name_en)
VALUES ('9f000000-0000-4000-8000-00000000000d', '9f000000-0000-4000-8000-00000000000f',
        '101', 'বাংলা', 'Bangla');

INSERT INTO assignments
  (id, tenant_id, section_id, subject_id, academic_year_id, title_bn,
   max_marks, due_at, created_by, status)
VALUES ('9f000000-0000-4000-8000-0000000000a1', '9f000000-0000-4000-8000-00000000000f',
        '9f000000-0000-4000-8000-00000000000c', '9f000000-0000-4000-8000-00000000000d',
        '9f000000-0000-4000-8000-00000000000a', 'রচনা', 20,
        now() + interval '7 days', '9f000000-0000-4000-8000-00000000a0a1', 'open');

-- Only a student may create their own submission (submission_insert_scope,
-- migration 018) — so become the student for exactly this statement. That
-- the fixture has to do this is itself a small proof the policy works.
SET LOCAL app.user_id = '9f000000-0000-4000-8000-00000000b0b1';
INSERT INTO assignment_submissions
  (id, tenant_id, assignment_id, student_id, body_bn, submitted_at)
VALUES ('9f000000-0000-4000-8000-0000000000b1', '9f000000-0000-4000-8000-00000000000f',
        '9f000000-0000-4000-8000-0000000000a1', '9f000000-0000-4000-8000-00000000b0b1',
        'আমার রচনা', now());
SET LOCAL app.user_id = '9f000000-0000-4000-8000-00000000a0a1';

-- The exact statement services/academics-svc/api/assignments.ts runs.
CREATE OR REPLACE FUNCTION pg_temp.try_grade(
  p_submission uuid, p_marks numeric, p_grader uuid, p_expected integer
) RETURNS integer LANGUAGE plpgsql AS $$
DECLARE n integer;
BEGIN
  UPDATE assignment_submissions s
     SET marks_awarded = p_marks, feedback_bn = NULL,
         graded_by = p_grader, graded_at = now(),
         row_version = s.row_version + 1
    FROM assignments a
   WHERE s.id = p_submission
     AND a.id = s.assignment_id
     AND s.row_version = p_expected
     AND (p_marks <= COALESCE(a.max_marks, p_marks));
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;

-- ---------------------------------------------------------------------
-- 1. A fresh submission starts at row_version 1.
-- ---------------------------------------------------------------------
DO $$
DECLARE v integer;
BEGIN
  SELECT row_version INTO v FROM assignment_submissions
   WHERE id = '9f000000-0000-4000-8000-0000000000b1';
  IF v <> 1 THEN RAISE EXCEPTION 'FAIL 1: expected row_version 1, got %', v; END IF;
  RAISE NOTICE 'PASS 1 — a new submission starts at row_version 1';
END $$;

-- ---------------------------------------------------------------------
-- 2. THE RACE. Both teachers read version 1; only the first write lands.
-- ---------------------------------------------------------------------
DO $$
DECLARE first_n integer; second_n integer; final_marks numeric; final_by uuid; v integer;
BEGIN
  -- Teacher A grades 15 against version 1.
  first_n := pg_temp.try_grade('9f000000-0000-4000-8000-0000000000b1', 15,
                               '9f000000-0000-4000-8000-00000000a0a1', 1);
  IF first_n <> 1 THEN RAISE EXCEPTION 'FAIL 2a: the first grade did not apply'; END IF;

  -- Teacher B grades 8 against the SAME version 1 they read earlier.
  second_n := pg_temp.try_grade('9f000000-0000-4000-8000-0000000000b1', 8,
                                '9f000000-0000-4000-8000-00000000a0a2', 1);
  IF second_n <> 0 THEN
    RAISE EXCEPTION 'FAIL 2b: the stale write applied — last-write-wins is back';
  END IF;

  SELECT marks_awarded, graded_by, row_version
    INTO final_marks, final_by, v
    FROM assignment_submissions WHERE id = '9f000000-0000-4000-8000-0000000000b1';

  IF final_marks <> 15 THEN
    RAISE EXCEPTION 'FAIL 2c: the mark is % — the stale write overwrote it', final_marks;
  END IF;
  IF final_by <> '9f000000-0000-4000-8000-00000000a0a1' THEN
    RAISE EXCEPTION 'FAIL 2d: graded_by was overwritten by the losing writer';
  END IF;
  IF v <> 2 THEN RAISE EXCEPTION 'FAIL 2e: row_version is %, expected 2', v; END IF;

  RAISE NOTICE 'PASS 2 — the stale write applied to 0 rows; the first mark and its author survived';
END $$;

-- ---------------------------------------------------------------------
-- 3. After re-reading, the same teacher can deliberately overwrite.
--    A lock that cannot be resolved is a deadlock, not a lock.
-- ---------------------------------------------------------------------
DO $$
DECLARE n integer; m numeric;
BEGIN
  n := pg_temp.try_grade('9f000000-0000-4000-8000-0000000000b1', 8,
                         '9f000000-0000-4000-8000-00000000a0a2', 2);
  IF n <> 1 THEN RAISE EXCEPTION 'FAIL 3: a write against the current version was refused'; END IF;
  SELECT marks_awarded INTO m FROM assignment_submissions
   WHERE id = '9f000000-0000-4000-8000-0000000000b1';
  IF m <> 8 THEN RAISE EXCEPTION 'FAIL 3: expected the deliberate overwrite to stand, got %', m; END IF;
  RAISE NOTICE 'PASS 3 — re-reading and re-submitting resolves the conflict';
END $$;

-- ---------------------------------------------------------------------
-- 4. row_version advances on every accepted write, so a version can never
--    be reused and a replayed request cannot land twice.
-- ---------------------------------------------------------------------
DO $$
DECLARE v integer; n integer;
BEGIN
  SELECT row_version INTO v FROM assignment_submissions
   WHERE id = '9f000000-0000-4000-8000-0000000000b1';
  IF v <> 3 THEN RAISE EXCEPTION 'FAIL 4: expected row_version 3, got %', v; END IF;

  -- Replay the write that just succeeded, byte for byte.
  n := pg_temp.try_grade('9f000000-0000-4000-8000-0000000000b1', 8,
                         '9f000000-0000-4000-8000-00000000a0a2', 2);
  IF n <> 0 THEN RAISE EXCEPTION 'FAIL 4: a replayed grade applied a second time'; END IF;
  RAISE NOTICE 'PASS 4 — versions are never reused; a replayed grade is a no-op';
END $$;

-- ---------------------------------------------------------------------
-- 5. The max-marks guard still holds alongside the version predicate —
--    adding the lock must not have made the ceiling reachable.
-- ---------------------------------------------------------------------
DO $$
DECLARE n integer; m numeric;
BEGIN
  n := pg_temp.try_grade('9f000000-0000-4000-8000-0000000000b1', 999,
                         '9f000000-0000-4000-8000-00000000a0a1', 3);
  IF n <> 0 THEN RAISE EXCEPTION 'FAIL 5: 999 marks were accepted on a 20-mark assignment'; END IF;
  SELECT marks_awarded INTO m FROM assignment_submissions
   WHERE id = '9f000000-0000-4000-8000-0000000000b1';
  IF m <> 8 THEN RAISE EXCEPTION 'FAIL 5: the rejected write still changed the mark'; END IF;
  RAISE NOTICE 'PASS 5 — marks above the maximum are still refused, and change nothing';
END $$;

-- ---------------------------------------------------------------------
-- 6. A version that never existed is refused, not treated as "close enough".
-- ---------------------------------------------------------------------
DO $$
DECLARE n integer;
BEGIN
  n := pg_temp.try_grade('9f000000-0000-4000-8000-0000000000b1', 12,
                         '9f000000-0000-4000-8000-00000000a0a1', 99);
  IF n <> 0 THEN RAISE EXCEPTION 'FAIL 6: a write against a nonexistent version applied'; END IF;
  RAISE NOTICE 'PASS 6 — a future/absent version is refused';
END $$;

ROLLBACK;

RESET ROLE;

DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM tenants WHERE id = '9f000000-0000-4000-8000-00000000000f';
  IF n <> 0 THEN RAISE EXCEPTION 'FAIL teardown: the fixture tenant survived'; END IF;
  RAISE NOTICE 'PASS teardown — no fixture rows remain';
END $$;

\echo ''
\echo '================================================'
\echo ' F-103 grading lock passed.'
\echo '================================================'
