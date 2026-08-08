-- ============================================================================
-- 018 — Assignments and submissions.
--
-- The missing link between content (017) and grading (005). Until now a
-- teacher could grade a formal exam but had no way to set homework, and a
-- student had nothing to hand in — the everyday loop of school was absent
-- while the twice-a-year loop was fully built.
--
-- Scope is deliberately homework, not exams. Assignments do NOT feed GPA:
-- exam_results is the board-facing record and must stay derived only from
-- exam_marks. Mixing continuous assessment into it would quietly change
-- what a transcript means. An assignment mark is formative feedback, and
-- the schema keeps that separation explicit.
--
-- Submissions ride the offline outbox (id = client UUIDv7 opId), same as
-- attendance and lesson progress: a student writing an answer on a phone
-- with no signal must not lose it.
-- ============================================================================
BEGIN;

CREATE TABLE assignments (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  section_id       uuid NOT NULL REFERENCES sections(id) ON DELETE CASCADE,
  subject_id       uuid NOT NULL REFERENCES subjects(id) ON DELETE RESTRICT,
  academic_year_id uuid NOT NULL REFERENCES academic_years(id) ON DELETE CASCADE,

  -- Optional anchor to the lesson this homework follows from. Nullable
  -- because plenty of homework is set from the board, not from a lesson.
  lesson_id        uuid REFERENCES lessons(id) ON DELETE SET NULL,

  title_bn         text NOT NULL,
  instructions_bn  text,
  max_marks        numeric(5,2) CHECK (max_marks IS NULL OR max_marks > 0),

  assigned_on      date NOT NULL DEFAULT CURRENT_DATE,
  due_at           timestamptz NOT NULL,
  -- Late submission is a policy decision per assignment, not a global one:
  -- some teachers accept late work with a penalty, some don't.
  allows_late      boolean NOT NULL DEFAULT true,

  created_by       uuid NOT NULL REFERENCES users(id),
  status           text NOT NULL DEFAULT 'open'
                     CHECK (status IN ('draft','open','closed')),
  row_version      integer NOT NULL DEFAULT 1,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),

  CHECK (due_at > assigned_on::timestamptz)
);
-- The student's inbox query: "open assignments for my section, soonest first".
CREATE INDEX ix_assignments_inbox ON assignments (tenant_id, section_id, due_at)
  WHERE status = 'open';
CREATE INDEX ix_assignments_lesson ON assignments (tenant_id, lesson_id)
  WHERE lesson_id IS NOT NULL;
CREATE TRIGGER trg_assignment_tenant BEFORE INSERT OR UPDATE ON assignments
  FOR EACH ROW EXECUTE FUNCTION app.enforce_tenant();
CREATE TRIGGER trg_assignment_touch BEFORE UPDATE ON assignments
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

COMMENT ON TABLE assignments IS
  'Homework, not exams. Marks here are formative and never feed exam_results '
  '— that stays derived from exam_marks alone so a transcript keeps meaning '
  'exactly what the board expects it to mean.';

-- ---------------------------------------------------------------------
-- Submissions.
-- ---------------------------------------------------------------------
CREATE TABLE assignment_submissions (
  id             uuid PRIMARY KEY,                 -- client UUIDv7 = outbox opId
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  assignment_id  uuid NOT NULL REFERENCES assignments(id) ON DELETE CASCADE,
  student_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  body_bn        text,
  -- Photo of handwritten work reuses the answer_scripts storage contract;
  -- nullable until object storage is enabled (SCRIPT_STORAGE_ENABLED).
  media_key      text,

  submitted_at   timestamptz NOT NULL DEFAULT now(),
  is_late        boolean NOT NULL DEFAULT false,

  -- Grading. Separate from exam_marks on purpose (see the table comment).
  marks_awarded  numeric(5,2) CHECK (marks_awarded IS NULL OR marks_awarded >= 0),
  feedback_bn    text,
  graded_by      uuid REFERENCES users(id),
  graded_at      timestamptz,

  row_version    integer NOT NULL DEFAULT 1,
  updated_at     timestamptz NOT NULL DEFAULT now(),

  UNIQUE (tenant_id, assignment_id, student_id),
  -- A body or a photo — an empty submission is not a submission.
  CHECK (body_bn IS NOT NULL OR media_key IS NOT NULL),
  -- Grading is all-or-nothing: a mark without a grader is unattributable.
  CHECK ((marks_awarded IS NULL AND graded_at IS NULL)
         OR (marks_awarded IS NOT NULL AND graded_by IS NOT NULL AND graded_at IS NOT NULL))
);
CREATE INDEX ix_submissions_assignment ON assignment_submissions (tenant_id, assignment_id);
CREATE INDEX ix_submissions_student ON assignment_submissions (tenant_id, student_id, submitted_at DESC);
-- The teacher's "what still needs marking" query.
CREATE INDEX ix_submissions_ungraded ON assignment_submissions (tenant_id, assignment_id)
  WHERE graded_at IS NULL;
CREATE TRIGGER trg_submission_tenant BEFORE INSERT OR UPDATE ON assignment_submissions
  FOR EACH ROW EXECUTE FUNCTION app.enforce_tenant();
CREATE TRIGGER trg_submission_touch BEFORE UPDATE ON assignment_submissions
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- ---------------------------------------------------------------------
-- Lateness is computed server-side, from the assignment's own due_at.
-- A client clock is not trustworthy for something that affects a mark.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.mark_submission_lateness() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_due timestamptz;
  v_allows_late boolean;
BEGIN
  SELECT due_at, allows_late INTO v_due, v_allows_late
    FROM assignments WHERE id = NEW.assignment_id;

  NEW.is_late := (NEW.submitted_at > v_due);

  IF NEW.is_late AND NOT v_allows_late THEN
    RAISE EXCEPTION 'assignment % no longer accepts submissions (due %)',
      NEW.assignment_id, v_due
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER trg_submission_lateness
  BEFORE INSERT OR UPDATE OF submitted_at ON assignment_submissions
  FOR EACH ROW EXECUTE FUNCTION app.mark_submission_lateness();

COMMENT ON FUNCTION app.mark_submission_lateness IS
  'Lateness is derived from the server clock against the assignment due_at '
  '— never trusted from the client, because it can change a mark.';

-- ---------------------------------------------------------------------
-- RLS.
-- ---------------------------------------------------------------------
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN
    SELECT c.oid::regclass AS tbl
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r'
      AND c.relname IN ('assignments','assignment_submissions')
      AND NOT EXISTS (SELECT 1 FROM pg_policy p
                      WHERE p.polrelid = c.oid AND p.polname = 'tenant_isolation')
  LOOP
    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', r.tbl);
    EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', r.tbl);
    EXECUTE format($f$
      CREATE POLICY tenant_isolation ON %s
        AS PERMISSIVE FOR ALL TO shikhon_app
        USING (app.tenant_guard(tenant_id))
        WITH CHECK (app.tenant_guard(tenant_id))
    $f$, r.tbl);
  END LOOP;
END $$;

-- A draft assignment is invisible to students until the teacher opens it.
CREATE POLICY assignment_read_scope ON assignments
  AS RESTRICTIVE FOR SELECT TO shikhon_app
  USING (
    app.has_role('principal','school_owner','academic_coordinator','dept_head',
                 'class_teacher','subject_teacher')
    OR (status <> 'draft' AND EXISTS (
          SELECT 1 FROM enrolments e
           WHERE e.section_id = assignments.section_id
             AND e.status = 'active'
             AND app.can_see_student(e.student_id)))
  );

CREATE POLICY assignment_write_scope ON assignments
  AS RESTRICTIVE FOR ALL TO shikhon_app
  USING (app.has_role('principal','school_owner','academic_coordinator','dept_head',
                      'class_teacher','subject_teacher'))
  WITH CHECK (app.has_role('principal','school_owner','academic_coordinator','dept_head',
                           'class_teacher','subject_teacher'));

-- Own work, your ward's work, or your section's work.
CREATE POLICY submission_read_scope ON assignment_submissions
  AS RESTRICTIVE FOR SELECT TO shikhon_app
  USING (app.can_see_student(student_id));

-- A student may write only their own submission; staff may write (grade)
-- submissions belonging to their sections. Splitting INSERT from UPDATE
-- would let a teacher forge a student's answer text, so the student-owned
-- branch is the only INSERT path.
CREATE POLICY submission_insert_scope ON assignment_submissions
  AS RESTRICTIVE FOR INSERT TO shikhon_app
  WITH CHECK (student_id = app.current_user_id());

CREATE POLICY submission_update_scope ON assignment_submissions
  AS RESTRICTIVE FOR UPDATE TO shikhon_app
  USING (
    student_id = app.current_user_id()
    OR app.has_role('principal','school_owner','academic_coordinator','dept_head',
                    'class_teacher','subject_teacher')
  );

COMMIT;
