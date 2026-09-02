-- 068 — the exam schedule is not the exam result, and 066 stopped one table short
--
-- Two findings from the A1 inspection, both proved against a live database
-- before this file was written.
--
-- ── PART 1. Publishing a routine ended the exam ─────────────────────────────
--
-- `exams.status` is the RESULTS lifecycle. `published` means a parent has been
-- shown a grade, which is why three separate places treat it as final:
--
--   academics-svc/api/exams.ts    PATCH refuses it — "ফলাফল প্রকাশিত পরীক্ষা"
--   academics-svc/api/publish.ts  refuses to publish results twice
--   sync-svc/src/appliers.ts      refuses every mark, published_marks_immutable
--
-- `POST /api/v1/rms/examroutine {publish:true}` publishes the SCHEDULE — a
-- different fact, told to parents weeks before anyone sits a paper — and wrote
-- that same `status = 'published'`. Driven through the real HTTP API in the
-- order a school works:
--
--   1. create the exam                    → planned, 12 papers
--   2. publish the exam routine           → status becomes published
--   3. correct a typo in the exam name    → 409, already published
--   4. a teacher enters a mark            → conflict, published_marks_immutable
--   5. the office publishes the results   → 409, already published
--
-- A school that announces its exam timetable — the ordinary thing to do —
-- permanently bricked that exam. Nothing anywhere moves `status` backwards, so
-- there was no recovery inside the product, and everything below the exam
-- (marks → grade → GPA → rank → publish → progress report) became unreachable.
--
-- The reason the routine wrote `status` at all is that both routine guards
-- hang off it. They are guards about the TIMETABLE — `assert_exam_halls_staffed`
-- says so in its own HINT, "assign duty for every hall before publishing the
-- routine" — so they move to the new column with the fact they were guarding.
-- Their bodies below are `pg_get_functiondef` output with only the guard line
-- changed; migration 059 exists because a body was once retyped from memory.
--
-- ── PART 2. 066 protected the exam and the paper, and stopped there ─────────
--
-- Migration 066 gave `exams` and `exam_subjects` per-command write scopes. It
-- left `exam_marks` with a restrictive policy on INSERT and SELECT only, and
-- `exam_results` — the computed record behind every certificate — with a
-- restrictive policy on SELECT only. Everything else fell through to the
-- PERMISSIVE `tenant_isolation`, which asks only "same school?".
--
-- Proved live as `shikhon_app` with `app.role = 'dept_head'`, a role
-- `marks_write_scope` deliberately excludes from entering a mark at all:
--
--   DELETE FROM exam_marks   … → 1 row, on an exam whose results were PUBLISHED
--   DELETE FROM exam_results … → 1 row
--   DELETE FROM exams        … → 0 rows   (066 holds — this is the control)
--
-- The `trg_marks_immutable` trigger does not save it: it is
-- `BEFORE UPDATE OF cq_marks, mcq_marks, practical_marks, ca_marks` and never
-- fires on DELETE at all. So a role that cannot enter a mark could delete a
-- published one — the number printed on a certificate.
--
-- Two more of the same shape, also proved live. `classes` and `sections` carry
-- `*_delete_scope USING (false)`; `subjects` and `academic_years` were missed,
-- and both cascade into the exam tables. As `subject_teacher`:
--
--   DELETE FROM exam_subjects … → 0 rows   (the paper policy holds)
--   DELETE FROM subjects      … → 1 row, and the paper and its marks went too
--
-- Cascades are executed by the constraint owner and are not filtered by the
-- child's DELETE policy, so `USING (false)` here closes the direct route
-- without breaking `DELETE FROM tenants`, which every test fixture relies on.
--
-- Rollback: db/rollback/068_exam_lifecycle_and_result_scope.sql. Rolling this
-- back re-opens both holes and restores the trap; it does not restore a safe
-- state.

BEGIN;

-- ───────────────────────────────────────────────────────────────────────────
-- PART 1 — separate the schedule announcement from the results publication
-- ───────────────────────────────────────────────────────────────────────────

ALTER TABLE exams ADD COLUMN IF NOT EXISTS routine_published_at timestamptz;

COMMENT ON COLUMN exams.routine_published_at IS
  'When the exam TIMETABLE was announced. Distinct from published_at, which is '
  'when the RESULTS were published. Conflating the two bricked the exam: see '
  'migration 068 and services/rms-svc/test/exam-routine-lifecycle.test.ts.';

-- Both guards move to the fact they were actually guarding. Bodies are
-- pg_get_functiondef output; only the first IF has changed.
CREATE OR REPLACE FUNCTION app.assert_exam_routine_clash_free()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE n integer; sample record;
BEGIN
  IF NEW.routine_published_at IS NULL OR OLD.routine_published_at IS NOT NULL THEN
    RETURN NEW;
  END IF;

  SELECT count(*) INTO n FROM app.exam_student_clashes(NEW.id);
  IF n > 0 THEN
    SELECT * INTO sample FROM app.exam_student_clashes(NEW.id) LIMIT 1;
    -- Names one real student. "3 clashes" sends a coordinator hunting;
    -- a name, a roll number and two subjects can be acted on immediately.
    RAISE EXCEPTION
      'exam routine has % per-student clash(es); e.g. % (roll %) sits % and % both on %',
      n, sample.student_name_bn, sample.roll_no,
      sample.subject_a_bn, sample.subject_b_bn, sample.exam_date
      USING ERRCODE = 'check_violation',
            HINT = 'call app.exam_student_clashes(exam_id) for the full list, one row per affected student';
  END IF;
  RETURN NEW;
END $function$;

CREATE OR REPLACE FUNCTION app.assert_exam_halls_staffed()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE v_room text; v_date date;
BEGIN
  IF NEW.routine_published_at IS NULL OR OLD.routine_published_at IS NOT NULL THEN
    RETURN NEW;
  END IF;

  SELECT r.code, h.exam_date INTO v_room, v_date
    FROM exam_halls h
    JOIN rooms r ON r.id = h.room_id
   WHERE h.exam_id = NEW.id
     AND NOT EXISTS (SELECT 1 FROM exam_invigilations ei WHERE ei.hall_id = h.id)
   ORDER BY h.exam_date, h.start_time, r.code
   LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION 'hall % on % has no invigilator', v_room, v_date
      USING ERRCODE = 'check_violation',
            HINT = 'assign duty for every hall before publishing the routine';
  END IF;
  RETURN NEW;
END $function$;

DROP TRIGGER IF EXISTS trg_exams_clash_free ON exams;
CREATE TRIGGER trg_exams_clash_free
  BEFORE UPDATE OF routine_published_at ON exams
  FOR EACH ROW EXECUTE FUNCTION app.assert_exam_routine_clash_free();

DROP TRIGGER IF EXISTS trg_exams_halls_staffed ON exams;
CREATE TRIGGER trg_exams_halls_staffed
  BEFORE UPDATE OF routine_published_at ON exams
  FOR EACH ROW EXECUTE FUNCTION app.assert_exam_halls_staffed();

-- Repair what the conflation already did. `publish.ts` always writes
-- `published_at` alongside `status`; `examroutine.ts` never did. So
-- "published with no published_at" is exactly a routine announcement wearing
-- the results status, and nothing else produces that pair.
UPDATE exams
   SET routine_published_at = COALESCE(routine_published_at, now()),
       status = 'planned'
 WHERE status = 'published'
   AND published_at IS NULL;

-- ───────────────────────────────────────────────────────────────────────────
-- PART 2 — the write scopes 066 stopped short of
-- ───────────────────────────────────────────────────────────────────────────

-- Per-command, never FOR ALL: a RESTRICTIVE FOR ALL applies its USING to
-- SELECT, which would hide marks from the very people allowed to read them.
-- That is 066's own reasoning and it holds here.

-- Entering a mark is `marks_write_scope` (principal, academic_coordinator, or
-- a teacher of the section). CHANGING one has to admit school_owner as well,
-- because publish.ts runs as PUBLISH_ROLES — principal, school_owner,
-- academic_coordinator — and writes grade_letter and grade_point onto every
-- mark in the exam. Without school_owner here, an owner publishing results
-- would be refused halfway through.
CREATE POLICY marks_update_scope ON exam_marks
  AS RESTRICTIVE FOR UPDATE TO shikhon_app
  USING (
    app.has_role('principal', 'school_owner', 'academic_coordinator')
    OR EXISTS (SELECT 1 FROM exam_subjects es
                WHERE es.id = exam_marks.exam_subject_id
                  AND es.section_id = ANY (app.my_section_ids()))
  )
  WITH CHECK (
    app.has_role('principal', 'school_owner', 'academic_coordinator')
    OR EXISTS (SELECT 1 FROM exam_subjects es
                WHERE es.id = exam_marks.exam_subject_id
                  AND es.section_id = ANY (app.my_section_ids()))
  );

-- A mark is academic history. Nothing in the product deletes one — the
-- designed route for a wrong mark is a `mark_corrections` row, which is what
-- trg_marks_immutable's own message tells the user to file.
CREATE POLICY marks_delete_scope ON exam_marks
  AS RESTRICTIVE FOR DELETE TO shikhon_app
  USING (false);

-- exam_results is written by exactly one thing: publish.ts, as PUBLISH_ROLES.
CREATE POLICY results_insert_scope ON exam_results
  AS RESTRICTIVE FOR INSERT TO shikhon_app
  WITH CHECK (app.has_role('principal', 'school_owner', 'academic_coordinator'));

CREATE POLICY results_update_scope ON exam_results
  AS RESTRICTIVE FOR UPDATE TO shikhon_app
  USING (app.has_role('principal', 'school_owner', 'academic_coordinator'))
  WITH CHECK (app.has_role('principal', 'school_owner', 'academic_coordinator'));

-- The certificate-bearing record. Same answer as exams, classes and sections.
CREATE POLICY results_delete_scope ON exam_results
  AS RESTRICTIVE FOR DELETE TO shikhon_app
  USING (false);

-- Closing the two ways around exam_subjects_delete_scope. Both cascade into
-- the exam tables; classes and sections were already closed this way.
CREATE POLICY subjects_delete_scope ON subjects
  AS RESTRICTIVE FOR DELETE TO shikhon_app
  USING (false);

CREATE POLICY academic_years_delete_scope ON academic_years
  AS RESTRICTIVE FOR DELETE TO shikhon_app
  USING (false);

COMMIT;
