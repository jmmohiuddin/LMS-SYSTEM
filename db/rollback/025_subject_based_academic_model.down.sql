-- Rollback for 025 — the subject-based academic model.
--
-- This drops the tables that hold every student's resolved subject set.
-- That set is derivable again from the templates, but the templates go with
-- it, and any human-approved override — a medical exemption, a documented
-- religion change — is NOT derivable and is lost. Read that sentence again
-- before running this against anything with real enrolments.
--
-- The taxonomy columns on `subjects` are dropped too; `is_optional`,
-- `has_cq` and `has_mcq` predate this migration and survive.
BEGIN;

DROP FUNCTION IF EXISTS app.derive_student_subjects(uuid, uuid, text);

DROP TABLE IF EXISTS group_selection_events;
DROP TABLE IF EXISTS student_subjects;
DROP TABLE IF EXISTS subject_template_items;
DROP TABLE IF EXISTS subject_templates;
DROP TABLE IF EXISTS curriculum_schemes;
DROP TABLE IF EXISTS teacher_competencies;
DROP TABLE IF EXISTS subject_papers;

ALTER TABLE subjects
  DROP COLUMN IF EXISTS assessment_scheme,
  DROP COLUMN IF EXISTS paper_structure,
  DROP COLUMN IF EXISTS delivery_mode,
  DROP COLUMN IF EXISTS variant_family;

DROP TYPE IF EXISTS assessment_scheme;
DROP TYPE IF EXISTS paper_structure;
DROP TYPE IF EXISTS delivery_mode;

COMMIT;
