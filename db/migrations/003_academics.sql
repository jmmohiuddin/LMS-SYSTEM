-- =====================================================================
-- 003_academics.sql
-- Academic calendar, class/section structure, subjects, rooms, enrolment.
-- =====================================================================

BEGIN;

CREATE TABLE academic_years (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  label          text NOT NULL,                    -- '২০২৬'
  starts_on      date NOT NULL,
  ends_on        date NOT NULL,
  is_current     boolean NOT NULL DEFAULT false,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_on > starts_on),
  UNIQUE (tenant_id, label)
);
CREATE UNIQUE INDEX uq_current_academic_year ON academic_years (tenant_id) WHERE is_current;
CREATE TRIGGER trg_acadyear_tenant BEFORE INSERT OR UPDATE ON academic_years
  FOR EACH ROW EXECUTE FUNCTION app.enforce_tenant();

CREATE TABLE terms (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  academic_year_id uuid NOT NULL REFERENCES academic_years(id) ON DELETE CASCADE,
  code             text NOT NULL,                  -- 'half_yearly', 'annual', 'test'
  name_bn          text NOT NULL,
  starts_on        date NOT NULL,
  ends_on          date NOT NULL,
  sequence_no      smallint NOT NULL,
  UNIQUE (tenant_id, academic_year_id, code)
);
CREATE TRIGGER trg_terms_tenant BEFORE INSERT OR UPDATE ON terms
  FOR EACH ROW EXECUTE FUNCTION app.enforce_tenant();

-- Holidays + special days; consumed by attendance (no SMS on a holiday) and RMS.
CREATE TABLE calendar_days (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  academic_year_id uuid NOT NULL REFERENCES academic_years(id) ON DELETE CASCADE,
  day              date NOT NULL,
  kind             text NOT NULL CHECK (kind IN ('holiday','exam','event','ramadan_schedule','working_weekend')),
  title_bn         text NOT NULL,
  applies_to_shifts shift_code[],
  UNIQUE (tenant_id, academic_year_id, day, kind)
);
CREATE INDEX ix_calendar_day ON calendar_days (tenant_id, day);
CREATE TRIGGER trg_caldays_tenant BEFORE INSERT OR UPDATE ON calendar_days
  FOR EACH ROW EXECUTE FUNCTION app.enforce_tenant();

CREATE TABLE departments (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name_bn    text NOT NULL,
  name_en    text NOT NULL,
  head_id    uuid REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE (tenant_id, name_en)
);
CREATE TRIGGER trg_dept_tenant BEFORE INSERT OR UPDATE ON departments
  FOR EACH ROW EXECUTE FUNCTION app.enforce_tenant();

ALTER TABLE staff_profiles
  ADD CONSTRAINT fk_staff_department FOREIGN KEY (department_id) REFERENCES departments(id) ON DELETE SET NULL;

-- ---------------------------------------------------------------------
-- Classes and sections
-- 'group' captures the Class 9+ split: science / humanities / business studies,
-- and the Madrasah general/vocational split.
-- ---------------------------------------------------------------------
CREATE TYPE academic_group AS ENUM ('none','science','humanities','business_studies','vocational','general');

CREATE TABLE classes (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  level_no     smallint NOT NULL CHECK (level_no BETWEEN 1 AND 12),
  name_bn      text NOT NULL,                    -- 'নবম শ্রেণি'
  name_en      text NOT NULL,                    -- 'Class Nine'
  stream       institution_stream NOT NULL,
  "group"      academic_group NOT NULL DEFAULT 'none',
  display_order smallint NOT NULL DEFAULT 0,
  UNIQUE (tenant_id, level_no, stream, "group")
);
CREATE TRIGGER trg_classes_tenant BEFORE INSERT OR UPDATE ON classes
  FOR EACH ROW EXECUTE FUNCTION app.enforce_tenant();

CREATE TABLE sections (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  class_id          uuid NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  academic_year_id  uuid NOT NULL REFERENCES academic_years(id) ON DELETE CASCADE,
  name              text NOT NULL,                -- 'ক' / 'A'
  shift             shift_code NOT NULL DEFAULT 'single',
  capacity          smallint NOT NULL DEFAULT 60 CHECK (capacity > 0),
  class_teacher_id  uuid REFERENCES users(id) ON DELETE SET NULL,
  home_room_id      uuid,
  student_count     smallint NOT NULL DEFAULT 0,  -- denormalised, trigger-maintained
  row_version       integer NOT NULL DEFAULT 1,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, academic_year_id, class_id, name, shift)
);
CREATE INDEX ix_sections_teacher ON sections (tenant_id, class_teacher_id);
CREATE TRIGGER trg_sections_tenant BEFORE INSERT OR UPDATE ON sections
  FOR EACH ROW EXECUTE FUNCTION app.enforce_tenant();
CREATE TRIGGER trg_sections_touch BEFORE UPDATE ON sections
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
CREATE TRIGGER trg_sections_sync AFTER INSERT OR UPDATE OR DELETE ON sections
  FOR EACH ROW EXECUTE FUNCTION app.log_sync_change('sections');

-- ---------------------------------------------------------------------
-- Rooms
-- ---------------------------------------------------------------------
CREATE TABLE rooms (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  code          text NOT NULL,                    -- '204', 'LAB-1'
  name_bn       text,
  building      text,
  floor_no      smallint,
  capacity      smallint NOT NULL DEFAULT 60,
  -- capabilities the RMS solver matches against subject requirements
  capabilities  text[] NOT NULL DEFAULT '{}',     -- {physics_lab, computer, projector, prayer_hall}
  is_bookable   boolean NOT NULL DEFAULT true,
  UNIQUE (tenant_id, code)
);
CREATE INDEX ix_rooms_caps ON rooms USING gin (capabilities);
CREATE TRIGGER trg_rooms_tenant BEFORE INSERT OR UPDATE ON rooms
  FOR EACH ROW EXECUTE FUNCTION app.enforce_tenant();

ALTER TABLE sections
  ADD CONSTRAINT fk_sections_home_room FOREIGN KEY (home_room_id) REFERENCES rooms(id) ON DELETE SET NULL;

-- ---------------------------------------------------------------------
-- Subjects
-- NCTB subject codes matter: they appear on board forms and drive grading rules.
-- ---------------------------------------------------------------------
CREATE TABLE subjects (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  nctb_code         varchar(8),                   -- e.g. '101' Bangla 1st paper
  name_bn           text NOT NULL,
  name_en           text NOT NULL,
  short_name        text,
  is_optional       boolean NOT NULL DEFAULT false,   -- 4th subject: GPA rules differ
  is_practical      boolean NOT NULL DEFAULT false,
  has_cq            boolean NOT NULL DEFAULT true,
  has_mcq           boolean NOT NULL DEFAULT true,
  requires_capability text,                       -- matched against rooms.capabilities
  UNIQUE (tenant_id, nctb_code, name_en)
);
CREATE TRIGGER trg_subjects_tenant BEFORE INSERT OR UPDATE ON subjects
  FOR EACH ROW EXECUTE FUNCTION app.enforce_tenant();

-- What each class studies, and how many periods a week the routine must allocate.
CREATE TABLE class_subjects (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  class_id              uuid NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  subject_id            uuid NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
  academic_year_id      uuid NOT NULL REFERENCES academic_years(id) ON DELETE CASCADE,
  periods_per_week      smallint NOT NULL DEFAULT 4 CHECK (periods_per_week BETWEEN 0 AND 20),
  double_periods_per_week smallint NOT NULL DEFAULT 0,
  -- NCTB mark distribution
  total_marks           smallint NOT NULL DEFAULT 100,
  cq_marks              smallint NOT NULL DEFAULT 70,
  mcq_marks             smallint NOT NULL DEFAULT 30,
  practical_marks       smallint NOT NULL DEFAULT 0,
  ca_marks              smallint NOT NULL DEFAULT 0,     -- continuous assessment
  cq_pass_marks         smallint NOT NULL DEFAULT 23,
  mcq_pass_marks        smallint NOT NULL DEFAULT 10,
  UNIQUE (tenant_id, class_id, subject_id, academic_year_id),
  CHECK (cq_marks + mcq_marks + practical_marks + ca_marks = total_marks)
);
CREATE TRIGGER trg_classsubj_tenant BEFORE INSERT OR UPDATE ON class_subjects
  FOR EACH ROW EXECUTE FUNCTION app.enforce_tenant();

-- Which teacher is qualified to teach what — the substitution ranker's input.
CREATE TABLE teacher_subject_expertise (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  teacher_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  subject_id    uuid NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
  min_level_no  smallint NOT NULL DEFAULT 1,
  max_level_no  smallint NOT NULL DEFAULT 12,
  proficiency   smallint NOT NULL DEFAULT 3 CHECK (proficiency BETWEEN 1 AND 5),
  is_primary    boolean NOT NULL DEFAULT false,
  UNIQUE (tenant_id, teacher_id, subject_id),
  CHECK (max_level_no >= min_level_no)
);
CREATE INDEX ix_expertise_by_subject ON teacher_subject_expertise (tenant_id, subject_id, proficiency DESC);
CREATE TRIGGER trg_expertise_tenant BEFORE INSERT OR UPDATE ON teacher_subject_expertise
  FOR EACH ROW EXECUTE FUNCTION app.enforce_tenant();

-- Which teacher actually teaches which subject to which section this year.
CREATE TABLE section_subject_teachers (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  section_id       uuid NOT NULL REFERENCES sections(id) ON DELETE CASCADE,
  subject_id       uuid NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
  teacher_id       uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  academic_year_id uuid NOT NULL REFERENCES academic_years(id) ON DELETE CASCADE,
  UNIQUE (tenant_id, section_id, subject_id, academic_year_id)
);
CREATE INDEX ix_sst_teacher ON section_subject_teachers (tenant_id, teacher_id, academic_year_id);
CREATE TRIGGER trg_sst_tenant BEFORE INSERT OR UPDATE ON section_subject_teachers
  FOR EACH ROW EXECUTE FUNCTION app.enforce_tenant();

-- ---------------------------------------------------------------------
-- Enrolment — a student's placement in a section for a year.
-- Roll number is unique within a section, which is how BD schools index students.
-- ---------------------------------------------------------------------
CREATE TABLE enrolments (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  student_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  section_id        uuid NOT NULL REFERENCES sections(id) ON DELETE RESTRICT,
  academic_year_id  uuid NOT NULL REFERENCES academic_years(id) ON DELETE CASCADE,
  roll_no           smallint NOT NULL CHECK (roll_no > 0),
  optional_subject_id uuid REFERENCES subjects(id),
  status            text NOT NULL DEFAULT 'active'
                      CHECK (status IN ('active','transferred','left','promoted','detained')),
  enrolled_on       date NOT NULL DEFAULT CURRENT_DATE,
  ended_on          date,
  row_version       integer NOT NULL DEFAULT 1,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, academic_year_id, student_id)
);
CREATE UNIQUE INDEX uq_enrolment_roll ON enrolments (tenant_id, section_id, roll_no)
  WHERE status = 'active';
-- The single hottest read in the product: "give me the roster for this section".
CREATE INDEX ix_enrolment_roster ON enrolments (tenant_id, section_id, roll_no)
  INCLUDE (student_id, status) WHERE status = 'active';
CREATE TRIGGER trg_enrolments_tenant BEFORE INSERT OR UPDATE ON enrolments
  FOR EACH ROW EXECUTE FUNCTION app.enforce_tenant();
CREATE TRIGGER trg_enrolments_touch BEFORE UPDATE ON enrolments
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
CREATE TRIGGER trg_enrolments_sync AFTER INSERT OR UPDATE OR DELETE ON enrolments
  FOR EACH ROW EXECUTE FUNCTION app.log_sync_change('enrolments');

-- Keep sections.student_count honest without a COUNT(*) on every roster read.
CREATE OR REPLACE FUNCTION app.refresh_section_count() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP IN ('INSERT','UPDATE') THEN
    UPDATE sections s SET student_count = (
      SELECT count(*) FROM enrolments e
      WHERE e.section_id = NEW.section_id AND e.status = 'active')
    WHERE s.id = NEW.section_id;
  END IF;
  IF TG_OP IN ('UPDATE','DELETE') THEN
    UPDATE sections s SET student_count = (
      SELECT count(*) FROM enrolments e
      WHERE e.section_id = OLD.section_id AND e.status = 'active')
    WHERE s.id = OLD.section_id;
  END IF;
  RETURN NULL;
END $$;

CREATE TRIGGER trg_enrolment_section_count
  AFTER INSERT OR UPDATE OF section_id, status OR DELETE ON enrolments
  FOR EACH ROW EXECUTE FUNCTION app.refresh_section_count();

COMMIT;
