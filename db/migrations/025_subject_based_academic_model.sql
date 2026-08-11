-- ============================================================================
-- 025 — The subject-based academic model
--       (F-303, F-304, F-305, F-307; PRD §5, TRD §5.2–5.5)
--
-- PRD §5 is explicit that this is the conceptual core: "Every requirement
-- downstream depends on it." Nine of the twelve entities it names did not
-- exist. The schema had classes, sections, enrolments and subjects — the
-- nouns — but none of the rules that make Bangladeshi academic structure
-- correct: curriculum-scheme versioning, subject templates, derived subject
-- sets, group selection, paper structure, or a teacher competency register.
--
-- ── Why this belongs in the schema and not in application code ───────────
-- Encoding these as tables makes the product curriculum-correct by
-- construction. Left in application code, each one becomes a rule some
-- future endpoint forgets to apply, and the failure is silent: a student
-- with the wrong subject set does not error, they simply sit the wrong
-- exam.
--
-- ── The two rules generic platforms get wrong ────────────────────────────
-- PRD §5.3 names them, and both live here:
--
--   Religion variants are a ROUTINE constraint, not a content one. Islam,
--   Hindu, Buddhist and Christian moral education are taught in the SAME
--   period to the SAME section, in different rooms, by different teachers.
--   Modelled here as sibling template items sharing a selection_pool, so
--   the routine engine can see them as one parallel block and the report
--   card can render whichever variant the student holds as a single row.
--
--   The optional (4th) subject contributes to GPA only above a threshold
--   and does NOT count toward the divisor. That is a grading rule, and it
--   lives in curriculum_schemes.grade_rule_set so a school switching
--   schemes between years cannot corrupt a prior year's transcript.
--
-- ── Not in this migration, deliberately ──────────────────────────────────
-- The chapter_prerequisites junction (TRD §5.3) and the lessons→topics
-- rename (TRD §5.1 M6) each touch live read paths in /academics/next and
-- /academics/chapters. They are their own migrations so that a failure in
-- either does not roll back the model everything else is waiting on.
-- ============================================================================
BEGIN;

-- ---------------------------------------------------------------------
-- Subject taxonomy (PRD §5.3).
--
-- Four axes, each driving something concrete: the GPA formula, the marks
-- entry form, the transcript row structure, and the room requirement.
-- `is_optional` and `has_cq`/`has_mcq` already existed as loose booleans;
-- they stay for compatibility and are now backed by explicit axes.
-- ---------------------------------------------------------------------
CREATE TYPE assessment_scheme AS ENUM (
  'cq_mcq', 'cq_mcq_practical', 'practical_only', 'continuous_only', 'non_graded');
CREATE TYPE paper_structure AS ENUM ('single', 'two_paper', 'paper_with_practical');
CREATE TYPE delivery_mode AS ENUM ('classroom', 'laboratory', 'field', 'parallel_split');

ALTER TABLE subjects
  ADD COLUMN assessment_scheme assessment_scheme NOT NULL DEFAULT 'cq_mcq',
  ADD COLUMN paper_structure   paper_structure   NOT NULL DEFAULT 'single',
  ADD COLUMN delivery_mode     delivery_mode     NOT NULL DEFAULT 'classroom',
  -- Religion-variant subjects share a family so the routine engine can
  -- group them and the transcript can collapse them to one row.
  ADD COLUMN variant_family    text;

COMMENT ON COLUMN subjects.variant_family IS
  'Set on religion-variant subjects (e.g. ''moral_education''). Siblings in the '
  'same family are taught in one parallel period and collapse to a single '
  'transcript row — PRD §5.3.';

-- ---------------------------------------------------------------------
-- Two-paper subjects (TRD §5.3).
--
-- HSC and several SSC subjects have a 1st and 2nd paper that are examined
-- separately and aggregated for the transcript. Without this the marks
-- model cannot express "Physics 1st Paper 75, 2nd Paper 68".
-- ---------------------------------------------------------------------
CREATE TABLE subject_papers (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  subject_id     uuid NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
  paper_number   smallint NOT NULL CHECK (paper_number BETWEEN 1 AND 2),
  name_bn        text,
  full_marks     smallint NOT NULL CHECK (full_marks > 0),
  pass_marks     smallint CHECK (pass_marks IS NULL OR pass_marks >= 0),
  has_practical  boolean NOT NULL DEFAULT false,
  practical_marks smallint CHECK (practical_marks IS NULL OR practical_marks >= 0),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, subject_id, paper_number),
  -- A practical mark on a paper that has no practical is a data error that
  -- would quietly inflate a total.
  CHECK (has_practical OR practical_marks IS NULL)
);

-- ---------------------------------------------------------------------
-- Versioned curriculum scheme (F-303).
--
-- National policy on terminal examinations and on the assessment model
-- itself has changed more than once in recent years. A school running
-- marks-based CQ/MCQ and a school running competency-based continuous
-- assessment must both be expressible without a code change, and a school
-- that SWITCHES must not corrupt prior years. That is why this is keyed by
-- (year, stage) rather than being a tenant-level setting.
--
-- grade_rule_set carries the boundaries, the grade points, and the
-- optional-subject rule as data. A transcript printed in 2027 for the 2026
-- year must use the 2026 rules even if the school has since switched.
-- ---------------------------------------------------------------------
CREATE TABLE curriculum_schemes (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  academic_year_id  uuid NOT NULL REFERENCES academic_years(id) ON DELETE CASCADE,
  stage             text NOT NULL CHECK (stage IN
                      ('primary','junior_secondary','secondary','higher_secondary')),
  assessment_model  text NOT NULL CHECK (assessment_model IN
                      ('marks_cq_mcq','continuous_competency','hybrid')),
  -- {"bands":[{"min":80,"grade":"A+","point":5.0}, …],
  --  "optional_subject":{"threshold_point":2.0,"counts_in_divisor":false},
  --  "fail_grade":"F"}
  grade_rule_set    jsonb NOT NULL,
  terminal_exam     text,          -- NULL when no terminal exam is in force
  effective_from    date NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, academic_year_id, stage),
  -- A scheme with no bands would silently grade everything as NULL.
  CHECK (jsonb_typeof(grade_rule_set -> 'bands') = 'array'
         AND jsonb_array_length(grade_rule_set -> 'bands') > 0)
);

COMMENT ON TABLE curriculum_schemes IS
  'F-303. The assessment regime is per (year, stage) DATA, not a constant. '
  'Switching schemes between years must not alter historical records, which '
  'is why grade_rule_set is stored rather than referenced.';

-- ---------------------------------------------------------------------
-- Subject templates (F-304).
--
-- PRD §5.5: "This derive-then-override pattern is the difference between
-- onboarding a school of 800 students in an afternoon and onboarding it
-- over three weeks."
-- ---------------------------------------------------------------------
CREATE TABLE subject_templates (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  curriculum_scheme_id uuid NOT NULL REFERENCES curriculum_schemes(id) ON DELETE CASCADE,
  class_id             uuid NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  -- NULL below Class 9, where no group applies.
  group_code           academic_group,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, curriculum_scheme_id, class_id, group_code)
);

CREATE TABLE subject_template_items (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  template_id      uuid NOT NULL REFERENCES subject_templates(id) ON DELETE CASCADE,
  subject_id       uuid NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
  requirement_type text NOT NULL CHECK (requirement_type IN
                     ('compulsory','group_compulsory','optional','religion_variant',
                      'co_curricular')),
  religion_variant text,
  -- Items sharing a pool are alternatives: the student takes exactly one.
  -- This is what makes religion variants and optional subjects the same
  -- mechanism rather than two special cases.
  selection_pool   text,
  display_order    smallint NOT NULL DEFAULT 0,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, template_id, subject_id),
  CHECK ((requirement_type = 'religion_variant') = (religion_variant IS NOT NULL)),
  -- Anything the student chooses between must say which pool it belongs to,
  -- or derivation cannot tell alternatives from additions.
  CHECK (requirement_type NOT IN ('optional','religion_variant')
         OR selection_pool IS NOT NULL)
);

COMMENT ON COLUMN subject_template_items.selection_pool IS
  'Alternatives, not additions: the student takes exactly one item per pool. '
  'Religion variants and optional subjects use the same mechanism.';

-- ---------------------------------------------------------------------
-- The student's resolved subject set (F-304, F-305).
--
-- Derived, not typed. row_version because a group change and a manual
-- override can race, and losing an override silently would put a child in
-- the wrong exam hall.
-- ---------------------------------------------------------------------
CREATE TABLE student_subjects (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  enrolment_id     uuid NOT NULL REFERENCES enrolments(id) ON DELETE CASCADE,
  subject_id       uuid NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
  requirement_type text NOT NULL CHECK (requirement_type IN
                     ('compulsory','group_compulsory','optional','religion_variant',
                      'co_curricular')),
  source           text NOT NULL CHECK (source IN ('template','override')),
  override_reason  text,
  approved_by      uuid REFERENCES users(id),
  derived_at       timestamptz NOT NULL DEFAULT now(),
  row_version      integer NOT NULL DEFAULT 1,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, enrolment_id, subject_id),
  -- An override with no reason is indistinguishable from a bug.
  CHECK ((source = 'override') = (override_reason IS NOT NULL)),
  -- And an override nobody approved is an audit gap.
  CHECK (source <> 'override' OR approved_by IS NOT NULL)
);

CREATE INDEX ix_student_subjects_enrolment ON student_subjects (tenant_id, enrolment_id);
CREATE INDEX ix_student_subjects_subject   ON student_subjects (tenant_id, subject_id);

-- ---------------------------------------------------------------------
-- Group selection (F-305).
--
-- An auditable EVENT, not a field edit. Entering Class 9 or 11 with a group
-- regenerates the subject set and invalidates anything assigned under the
-- previous group. Recording it as an event is what lets that invalidation
-- be explained to a parent six months later.
-- ---------------------------------------------------------------------
CREATE TABLE group_selection_events (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  enrolment_id    uuid NOT NULL REFERENCES enrolments(id) ON DELETE CASCADE,
  previous_group  academic_group,
  selected_group  academic_group NOT NULL,
  reason          text,
  selected_by     uuid NOT NULL REFERENCES users(id),
  subjects_before integer NOT NULL DEFAULT 0,
  subjects_after  integer NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (previous_group IS DISTINCT FROM selected_group)
);

CREATE INDEX ix_group_selection_enrolment
  ON group_selection_events (tenant_id, enrolment_id, created_at DESC);

-- ---------------------------------------------------------------------
-- Teacher competency register (F-307).
--
-- PRD: "This is the input the routine generator and the substitution
-- ranker both depend on; without it both degrade to guesswork." The
-- substitution ranker already ships and is currently guessing.
-- ---------------------------------------------------------------------
CREATE TABLE teacher_competencies (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  teacher_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  subject_id     uuid NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
  -- Inclusive class range this teacher may take the subject for. A physics
  -- teacher qualified for Class 9–10 must not be auto-assigned Class 12.
  min_class_level smallint NOT NULL CHECK (min_class_level BETWEEN 1 AND 12),
  max_class_level smallint NOT NULL CHECK (max_class_level BETWEEN 1 AND 12),
  proficiency    text NOT NULL DEFAULT 'primary'
                   CHECK (proficiency IN ('primary','secondary','emergency_only')),
  is_active      boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, teacher_id, subject_id),
  CHECK (max_class_level >= min_class_level)
);

COMMENT ON COLUMN teacher_competencies.proficiency IS
  'primary = first choice; secondary = can cover; emergency_only = substitution '
  'only, never routine generation. The substitution ranker (F-508) reads this.';

CREATE INDEX ix_competency_subject ON teacher_competencies (tenant_id, subject_id)
  WHERE is_active;

-- ---------------------------------------------------------------------
-- Derivation (TRD §5.5, F-304).
--
-- Resolves a template into a student's actual subject set. Idempotent: it
-- can be re-run after a group change or a template correction without
-- duplicating rows, and it NEVER removes an override — a manual exemption
-- approved by a human outranks a template every time.
--
-- Returns the number of subjects the student ends up with, so the caller
-- can record it on the group-selection event.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.derive_student_subjects(
  p_enrolment    uuid,
  p_optional     uuid DEFAULT NULL,   -- chosen optional subject
  p_religion     text DEFAULT NULL    -- chosen religion variant
) RETURNS integer
LANGUAGE plpgsql
SECURITY INVOKER            -- RLS still governs which enrolments are visible
SET search_path = public, app
AS $$
DECLARE
  v_tenant   uuid;
  v_class    uuid;
  v_group    academic_group;
  v_year     uuid;
  v_template uuid;
  v_count    integer;
BEGIN
  SELECT e.tenant_id, s.class_id, c.group, e.academic_year_id
    INTO v_tenant, v_class, v_group, v_year
    FROM enrolments e
    JOIN sections s ON s.id = e.section_id
    JOIN classes  c ON c.id = s.class_id
   WHERE e.id = p_enrolment;

  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'enrolment % not found or not visible', p_enrolment
      USING ERRCODE = 'no_data_found';
  END IF;

  SELECT st.id INTO v_template
    FROM subject_templates st
    JOIN curriculum_schemes cs ON cs.id = st.curriculum_scheme_id
   WHERE st.class_id = v_class
     AND cs.academic_year_id = v_year
     AND st.group_code IS NOT DISTINCT FROM
         (CASE WHEN v_group = 'none' THEN NULL ELSE v_group END);

  IF v_template IS NULL THEN
    RAISE EXCEPTION
      'no subject template for this class/group/year — configure one before enrolling'
      USING ERRCODE = 'no_data_found',
            HINT = 'F-304: the template is what makes onboarding an afternoon rather than three weeks';
  END IF;

  -- Everything that is not a choice: taken by every student on the template.
  INSERT INTO student_subjects
    (tenant_id, enrolment_id, subject_id, requirement_type, source)
  SELECT v_tenant, p_enrolment, i.subject_id, i.requirement_type, 'template'
    FROM subject_template_items i
   WHERE i.template_id = v_template
     AND i.selection_pool IS NULL
  ON CONFLICT (tenant_id, enrolment_id, subject_id) DO NOTHING;

  -- The chosen optional subject, if it is genuinely on this template's
  -- allowed list. A choice outside the list is a client bug, not a
  -- preference to honour.
  IF p_optional IS NOT NULL THEN
    INSERT INTO student_subjects
      (tenant_id, enrolment_id, subject_id, requirement_type, source)
    SELECT v_tenant, p_enrolment, i.subject_id, i.requirement_type, 'template'
      FROM subject_template_items i
     WHERE i.template_id = v_template
       AND i.requirement_type = 'optional'
       AND i.subject_id = p_optional
    ON CONFLICT (tenant_id, enrolment_id, subject_id) DO NOTHING;
  END IF;

  -- The chosen religion variant. Same mechanism as the optional subject —
  -- one item from a pool — which is why they share selection_pool.
  IF p_religion IS NOT NULL THEN
    INSERT INTO student_subjects
      (tenant_id, enrolment_id, subject_id, requirement_type, source)
    SELECT v_tenant, p_enrolment, i.subject_id, i.requirement_type, 'template'
      FROM subject_template_items i
     WHERE i.template_id = v_template
       AND i.requirement_type = 'religion_variant'
       AND i.religion_variant = p_religion
    ON CONFLICT (tenant_id, enrolment_id, subject_id) DO NOTHING;
  END IF;

  -- Withdraw template-derived subjects the student should no longer hold.
  --
  -- Two cases, and missing the second is the subtle one: a subject dropped
  -- from the template entirely (the group changed, or the template was
  -- corrected), AND a pooled alternative that is no longer the choice. A
  -- student who corrects their religion variant from Islam to Christian
  -- must not end up holding both — they would be timetabled into two
  -- religion papers in the same period.
  --
  -- A template row survives only if its template item is unconditional, or
  -- is the chosen optional, or is the chosen religion variant. Overrides
  -- are untouched: a human approved those.
  DELETE FROM student_subjects ss
   WHERE ss.enrolment_id = p_enrolment
     AND ss.source = 'template'
     AND NOT EXISTS (
       SELECT 1 FROM subject_template_items i
        WHERE i.template_id = v_template
          AND i.subject_id  = ss.subject_id
          AND (i.selection_pool IS NULL
               OR (i.requirement_type = 'optional'         AND i.subject_id = p_optional)
               OR (i.requirement_type = 'religion_variant' AND i.religion_variant = p_religion)));

  SELECT count(*) INTO v_count FROM student_subjects WHERE enrolment_id = p_enrolment;
  RETURN v_count;
END $$;

COMMENT ON FUNCTION app.derive_student_subjects IS
  'F-304 / TRD §5.5. Derive-then-override. Idempotent, and never removes an '
  'override — a human-approved exemption outranks a template.';

REVOKE ALL ON FUNCTION app.derive_student_subjects(uuid, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.derive_student_subjects(uuid, uuid, text) TO shikhon_app;

-- ---------------------------------------------------------------------
-- Tenancy and RLS, via the same programmatic loop migration 010 uses.
-- Every table above is tenant-scoped; none is platform infrastructure.
-- ---------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'subject_papers', 'curriculum_schemes', 'subject_templates',
    'subject_template_items', 'student_subjects', 'group_selection_events',
    'teacher_competencies'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($f$
      CREATE POLICY tenant_isolation ON %I
        AS PERMISSIVE FOR ALL TO shikhon_app
        USING (app.tenant_guard(tenant_id))
        WITH CHECK (app.tenant_guard(tenant_id))
    $f$, t);
    EXECUTE format('CREATE TRIGGER trg_%s_tenant BEFORE INSERT OR UPDATE ON %I
                    FOR EACH ROW EXECUTE FUNCTION app.enforce_tenant()',
                   left(t, 20), t);
    EXECUTE format('CREATE TRIGGER trg_%s_touch BEFORE UPDATE ON %I
                    FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at()',
                   left(t, 20), t);
  END LOOP;
END $$;

-- group_selection_events and subject_template_items are append-only records
-- with no updated_at, so the loop's touch trigger would fail on any UPDATE.
-- Names come from left(table_name, 20), hence the truncation.
DROP TRIGGER IF EXISTS trg_group_selection_even_touch ON group_selection_events;
DROP TRIGGER IF EXISTS trg_subject_template_ite_touch ON subject_template_items;

-- ---------------------------------------------------------------------
-- Read scopes.
--
-- A student may see their OWN subject set; staff see their scope. Written
-- as a RESTRICTIVE SELECT policy only — migration 023 exists because a
-- FOR ALL write policy silently cancels a read policy sitting beside it.
-- ---------------------------------------------------------------------
CREATE POLICY student_subject_read_scope ON student_subjects
  AS RESTRICTIVE FOR SELECT TO shikhon_app
  USING (
    app.has_role('principal','school_owner','academic_coordinator','dept_head',
                 'class_teacher','subject_teacher')
    OR EXISTS (SELECT 1 FROM enrolments e
                WHERE e.id = student_subjects.enrolment_id
                  AND app.can_see_student(e.student_id))
  );

CREATE POLICY student_subject_write_scope ON student_subjects
  AS RESTRICTIVE FOR INSERT TO shikhon_app
  WITH CHECK (app.has_role('principal','school_owner','academic_coordinator','dept_head'));

CREATE POLICY student_subject_update_scope ON student_subjects
  AS RESTRICTIVE FOR UPDATE TO shikhon_app
  USING (app.has_role('principal','school_owner','academic_coordinator','dept_head'))
  WITH CHECK (app.has_role('principal','school_owner','academic_coordinator','dept_head'));

CREATE POLICY student_subject_delete_scope ON student_subjects
  AS RESTRICTIVE FOR DELETE TO shikhon_app
  USING (app.has_role('principal','school_owner','academic_coordinator','dept_head'));

COMMIT;
