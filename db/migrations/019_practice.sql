-- ============================================================================
-- 019 — Practice questions and attempts.
--
-- Two purposes, and the second one matters more long-term:
--
--   1. A student can check understanding right after reading a lesson,
--      instead of self-declaring "পাঠ সম্পন্ন" — which is a weak signal.
--   2. Every attempt records accuracy AND response time. Strategy §14 is
--      explicit that these are the two signals that make mastery scores,
--      spaced repetition and adaptive difficulty possible later. Building
--      those without real data would be guessing at intervals and
--      thresholds; this migration starts collecting the evidence now so
--      V3 can be tuned against reality.
--
-- Practice is FORMATIVE. Attempts never feed exam_results or assignment
-- marks — same separation as 018. A student retrying a question until it
-- clicks is the desired behaviour, not something to penalise.
-- ============================================================================
BEGIN;

CREATE TYPE practice_kind AS ENUM ('mcq', 'true_false', 'numeric', 'short_answer');

CREATE TABLE practice_questions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  lesson_id      uuid NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,

  question_no    smallint NOT NULL,
  kind           practice_kind NOT NULL DEFAULT 'mcq',
  stem_bn        text NOT NULL,
  -- Shown AFTER an answer, never before. This is the part that turns a
  -- wrong answer into learning rather than just a red mark.
  explanation_bn text,

  -- 1 easy … 5 hard. Hand-set for now; V3 can recalibrate from observed
  -- accuracy, which is exactly what practice_attempts makes possible.
  difficulty     smallint NOT NULL DEFAULT 2 CHECK (difficulty BETWEEN 1 AND 5),

  -- Correct answer for the non-MCQ kinds. MCQ correctness lives on
  -- practice_options instead.
  numeric_answer numeric(12,4),
  numeric_tolerance numeric(12,4) NOT NULL DEFAULT 0,
  text_answer_bn text,

  is_published   boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),

  UNIQUE (tenant_id, lesson_id, question_no),
  -- A numeric question without an answer can never be marked.
  CHECK (kind <> 'numeric' OR numeric_answer IS NOT NULL)
);
CREATE INDEX ix_practice_lesson ON practice_questions (tenant_id, lesson_id, question_no)
  WHERE is_published;
CREATE TRIGGER trg_pq_tenant BEFORE INSERT OR UPDATE ON practice_questions
  FOR EACH ROW EXECUTE FUNCTION app.enforce_tenant();
CREATE TRIGGER trg_pq_touch BEFORE UPDATE ON practice_questions
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

CREATE TABLE practice_options (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  question_id  uuid NOT NULL REFERENCES practice_questions(id) ON DELETE CASCADE,
  option_no    smallint NOT NULL,
  text_bn      text NOT NULL,
  is_correct   boolean NOT NULL DEFAULT false,
  UNIQUE (tenant_id, question_id, option_no)
);
CREATE INDEX ix_practice_options ON practice_options (tenant_id, question_id, option_no);
CREATE TRIGGER trg_po_tenant BEFORE INSERT OR UPDATE ON practice_options
  FOR EACH ROW EXECUTE FUNCTION app.enforce_tenant();

-- Exactly one correct option per MCQ. Enforced with a partial unique index
-- rather than a trigger so it holds under concurrent inserts too.
CREATE UNIQUE INDEX uq_practice_one_correct
  ON practice_options (tenant_id, question_id)
  WHERE is_correct;

-- ---------------------------------------------------------------------
-- Attempts — the evidence layer for V3.
--
-- One row per (student, question, attempt_no) rather than one per
-- question: the *sequence* of attempts is the interesting signal. A
-- student who gets it right on try 3 has learned something a student who
-- got it right on try 1 already knew, and collapsing that loses the
-- distinction mastery scoring needs.
-- ---------------------------------------------------------------------
CREATE TABLE practice_attempts (
  id             uuid PRIMARY KEY,                 -- client UUIDv7 = outbox opId
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  question_id    uuid NOT NULL REFERENCES practice_questions(id) ON DELETE CASCADE,
  student_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  lesson_id      uuid NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,

  attempt_no     smallint NOT NULL DEFAULT 1 CHECK (attempt_no > 0),
  selected_option_id uuid REFERENCES practice_options(id) ON DELETE SET NULL,
  answer_text    text,
  answer_numeric numeric(12,4),

  -- Marked server-side in the applier, never trusted from the client.
  is_correct     boolean NOT NULL,

  -- The second half of the V3 signal. Capped at 10 minutes: beyond that
  -- the student walked away, and recording it would poison the average
  -- that spaced-repetition intervals get tuned against.
  response_ms    integer NOT NULL DEFAULT 0
                   CHECK (response_ms >= 0 AND response_ms <= 600000),

  attempted_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, question_id, student_id, attempt_no)
);
CREATE INDEX ix_attempts_student ON practice_attempts (tenant_id, student_id, attempted_at DESC);
CREATE INDEX ix_attempts_lesson ON practice_attempts (tenant_id, lesson_id, student_id);
-- The query V3's mastery model will run: accuracy per question, per cohort.
CREATE INDEX ix_attempts_question ON practice_attempts (tenant_id, question_id, is_correct);
CREATE TRIGGER trg_pa_tenant BEFORE INSERT OR UPDATE ON practice_attempts
  FOR EACH ROW EXECUTE FUNCTION app.enforce_tenant();

COMMENT ON TABLE practice_attempts IS
  'Formative only — never feeds exam_results or assignment marks. Exists to '
  'record accuracy and response time, the two signals strategy section 14 '
  'identifies as prerequisites for mastery scoring and spaced repetition.';

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
      AND c.relname IN ('practice_questions','practice_options','practice_attempts')
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

CREATE POLICY pq_write_scope ON practice_questions
  AS RESTRICTIVE FOR ALL TO shikhon_app
  USING (app.has_role('principal','school_owner','academic_coordinator','dept_head','subject_teacher'))
  WITH CHECK (app.has_role('principal','school_owner','academic_coordinator','dept_head','subject_teacher'));

CREATE POLICY po_write_scope ON practice_options
  AS RESTRICTIVE FOR ALL TO shikhon_app
  USING (app.has_role('principal','school_owner','academic_coordinator','dept_head','subject_teacher'))
  WITH CHECK (app.has_role('principal','school_owner','academic_coordinator','dept_head','subject_teacher'));

-- Own attempts, your ward's, or your section's — same rule as every other
-- per-student record in this schema.
CREATE POLICY attempt_read_scope ON practice_attempts
  AS RESTRICTIVE FOR SELECT TO shikhon_app
  USING (app.can_see_student(student_id));

-- Only the student may record their own practice. A teacher writing
-- attempts on a student's behalf would corrupt the exact signal this
-- table exists to collect.
CREATE POLICY attempt_write_scope ON practice_attempts
  AS RESTRICTIVE FOR ALL TO shikhon_app
  USING (student_id = app.current_user_id())
  WITH CHECK (student_id = app.current_user_id());

COMMIT;
