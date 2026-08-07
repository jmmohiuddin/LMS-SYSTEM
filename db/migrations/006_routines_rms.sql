-- =====================================================================
-- 006_routines_rms.sql
-- Routine Management System: bell schedules, routines, routine_slots with
-- database-enforced clash prevention, teacher availability, leave,
-- substitutions, and syllabus progress.
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- A range type over `time` so overlap (&&) is a first-class operation.
-- Using a time range rather than an integer period number is deliberate:
-- morning and day shifts have different bell schedules, and only a real
-- time comparison catches a teacher double-booked ACROSS shifts.
-- ---------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'timerange') THEN
    CREATE TYPE timerange AS RANGE (subtype = time);
  END IF;
END $$;

-- ---------------------------------------------------------------------
-- Bell schedule. Date-effective, so a school swaps to a Ramadan template
-- without rebuilding any routine.
-- ---------------------------------------------------------------------
CREATE TABLE period_templates (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name_bn          text NOT NULL,                     -- 'নিয়মিত সময়সূচি' / 'রমজান সময়সূচি'
  shift            shift_code NOT NULL DEFAULT 'single',
  effective_from   date NOT NULL,
  effective_to     date,
  is_active        boolean NOT NULL DEFAULT true,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name_bn, shift, effective_from)
);
CREATE TRIGGER trg_ptmpl_tenant BEFORE INSERT OR UPDATE ON period_templates
  FOR EACH ROW EXECUTE FUNCTION app.enforce_tenant();

CREATE TYPE period_kind AS ENUM ('teaching','assembly','tiffin','prayer','games','study','break');

CREATE TABLE period_definitions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  template_id   uuid NOT NULL REFERENCES period_templates(id) ON DELETE CASCADE,
  period_no     smallint NOT NULL,                   -- 0 = assembly
  label_bn      text NOT NULL,
  starts_at     time NOT NULL,
  ends_at       time NOT NULL,
  kind          period_kind NOT NULL DEFAULT 'teaching',
  CHECK (ends_at > starts_at),
  UNIQUE (tenant_id, template_id, period_no)
);
CREATE TRIGGER trg_pdef_tenant BEFORE INSERT OR UPDATE ON period_definitions
  FOR EACH ROW EXECUTE FUNCTION app.enforce_tenant();

-- ---------------------------------------------------------------------
-- routines — a versioned, publishable set of slots.
-- Only one ACTIVE routine per (academic_year, shift) at any effective date.
-- ---------------------------------------------------------------------
CREATE TYPE routine_status AS ENUM ('draft','review','active','superseded','archived');

CREATE TABLE routines (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  academic_year_id   uuid NOT NULL REFERENCES academic_years(id) ON DELETE CASCADE,
  term_id            uuid REFERENCES terms(id) ON DELETE SET NULL,
  period_template_id uuid NOT NULL REFERENCES period_templates(id) ON DELETE RESTRICT,
  shift              shift_code NOT NULL DEFAULT 'single',
  name_bn            text NOT NULL,
  version            integer NOT NULL DEFAULT 1,
  status             routine_status NOT NULL DEFAULT 'draft',
  effective_from     date NOT NULL,
  effective_to       date,

  -- Solver provenance and quality reporting
  generated_by       text CHECK (generated_by IN ('solver','manual','imported','copied')),
  solver_run_id      uuid,
  solver_seconds     numeric(6,2),
  objective_score    numeric(10,2),
  soft_violations    jsonb NOT NULL DEFAULT '[]'::jsonb,
  constraint_weights jsonb NOT NULL DEFAULT '{}'::jsonb,

  published_at       timestamptz,
  published_by       uuid REFERENCES users(id),
  supersedes_id      uuid REFERENCES routines(id),
  created_by         uuid REFERENCES users(id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, academic_year_id, shift, version)
);
CREATE UNIQUE INDEX uq_routine_active
  ON routines (tenant_id, academic_year_id, shift) WHERE status = 'active';
CREATE TRIGGER trg_routines_tenant BEFORE INSERT OR UPDATE ON routines
  FOR EACH ROW EXECUTE FUNCTION app.enforce_tenant();
CREATE TRIGGER trg_routines_touch BEFORE UPDATE ON routines
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- ---------------------------------------------------------------------
-- routine_slots — the atomic unit of the timetable.
--
-- day_of_week: 0 = Sunday … 6 = Saturday. The Bangladeshi working week
-- starts Sunday and the weekend is Fri+Sat (Fri only for many Madrasah),
-- driven by tenants.weekend_days.
-- ---------------------------------------------------------------------
CREATE TYPE slot_kind AS ENUM ('teaching','non_teaching','free','exam','reserved');

CREATE TABLE routine_slots (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  routine_id          uuid NOT NULL REFERENCES routines(id) ON DELETE CASCADE,

  day_of_week         smallint NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
  period_no           smallint NOT NULL,
  period_definition_id uuid NOT NULL REFERENCES period_definitions(id) ON DELETE RESTRICT,
  starts_at           time NOT NULL,
  ends_at             time NOT NULL,
  -- Maintained by trigger from starts_at/ends_at; the exclusion constraints key on it.
  time_range          timerange NOT NULL,

  slot_kind           slot_kind NOT NULL DEFAULT 'teaching',
  primary_section_id  uuid REFERENCES sections(id) ON DELETE CASCADE,
  subject_id          uuid REFERENCES subjects(id) ON DELETE RESTRICT,
  teacher_id          uuid REFERENCES users(id) ON DELETE RESTRICT,
  room_id             uuid REFERENCES rooms(id) ON DELETE SET NULL,

  is_double           boolean NOT NULL DEFAULT false,
  double_group_id     uuid,                            -- links the two halves of a double period
  is_pinned           boolean NOT NULL DEFAULT false,   -- solver may not move it
  notes               text,

  status              text NOT NULL DEFAULT 'active'
                        CHECK (status IN ('active','removed')),
  row_version         integer NOT NULL DEFAULT 1,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),

  CHECK (ends_at > starts_at),
  -- A teaching slot must name a section, subject and teacher.
  CHECK (slot_kind <> 'teaching'
         OR (primary_section_id IS NOT NULL AND subject_id IS NOT NULL AND teacher_id IS NOT NULL))
);

-- Keep time_range in sync with the time columns.
CREATE OR REPLACE FUNCTION app.sync_slot_time_range() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.time_range := timerange(NEW.starts_at, NEW.ends_at, '[)');
  RETURN NEW;
END $$;

CREATE TRIGGER trg_slot_time_range BEFORE INSERT OR UPDATE OF starts_at, ends_at
  ON routine_slots FOR EACH ROW EXECUTE FUNCTION app.sync_slot_time_range();
CREATE TRIGGER trg_slots_tenant BEFORE INSERT OR UPDATE ON routine_slots
  FOR EACH ROW EXECUTE FUNCTION app.enforce_tenant();
CREATE TRIGGER trg_slots_touch BEFORE UPDATE ON routine_slots
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
CREATE TRIGGER trg_slots_sync AFTER INSERT OR UPDATE OR DELETE ON routine_slots
  FOR EACH ROW EXECUTE FUNCTION app.log_sync_change('routineSlots');

-- =====================================================================
-- CLASH PREVENTION — the core invariant of the RMS.
--
-- These three GiST exclusion constraints make double-booking structurally
-- impossible: no service bug, no manual SQL, no concurrent transaction and
-- no solver defect can produce a conflicting pair. A violation surfaces as
-- SQLSTATE 23P01, which rms-svc maps to a structured 409 naming the
-- conflicting slot.
--
-- Scoped to a single routine_id so a DRAFT routine can legitimately overlap
-- the ACTIVE one it will replace.
-- =====================================================================

ALTER TABLE routine_slots
  ADD CONSTRAINT rs_no_teacher_double_booking
  EXCLUDE USING gist (
    tenant_id  WITH =,
    routine_id WITH =,
    teacher_id WITH =,
    day_of_week WITH =,
    time_range WITH &&
  ) WHERE (status = 'active' AND teacher_id IS NOT NULL AND slot_kind IN ('teaching','exam'));

ALTER TABLE routine_slots
  ADD CONSTRAINT rs_no_room_double_booking
  EXCLUDE USING gist (
    tenant_id  WITH =,
    routine_id WITH =,
    room_id    WITH =,
    day_of_week WITH =,
    time_range WITH &&
  ) WHERE (status = 'active' AND room_id IS NOT NULL AND slot_kind IN ('teaching','exam'));

ALTER TABLE routine_slots
  ADD CONSTRAINT rs_no_section_double_booking
  EXCLUDE USING gist (
    tenant_id  WITH =,
    routine_id WITH =,
    primary_section_id WITH =,
    day_of_week WITH =,
    time_range WITH &&
  ) WHERE (status = 'active' AND primary_section_id IS NOT NULL);

COMMENT ON CONSTRAINT rs_no_teacher_double_booking ON routine_slots IS
  'Teacher cannot be in two places at once — enforced on overlapping TIME, not period '
  'number, so cross-shift collisions (morning p8 vs day p1) are caught.';

-- ---------------------------------------------------------------------
-- Merged / combined sections (Class 9A + 9B share a physics practical).
-- The exclusion constraint above covers primary_section_id; secondary
-- sections are validated by this trigger.
-- ---------------------------------------------------------------------
CREATE TABLE routine_slot_sections (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  slot_id     uuid NOT NULL REFERENCES routine_slots(id) ON DELETE CASCADE,
  section_id  uuid NOT NULL REFERENCES sections(id) ON DELETE CASCADE,
  UNIQUE (tenant_id, slot_id, section_id)
);
CREATE INDEX ix_slot_sections ON routine_slot_sections (tenant_id, section_id);
CREATE TRIGGER trg_slotsec_tenant BEFORE INSERT OR UPDATE ON routine_slot_sections
  FOR EACH ROW EXECUTE FUNCTION app.enforce_tenant();

CREATE OR REPLACE FUNCTION app.check_merged_section_clash() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE conflict_id uuid;
BEGIN
  SELECT rs2.id INTO conflict_id
  FROM routine_slots rs1
  JOIN routine_slots rs2
    ON rs2.tenant_id = rs1.tenant_id
   AND rs2.routine_id = rs1.routine_id
   AND rs2.day_of_week = rs1.day_of_week
   AND rs2.time_range && rs1.time_range
   AND rs2.id <> rs1.id
   AND rs2.status = 'active'
  WHERE rs1.id = NEW.slot_id
    AND (rs2.primary_section_id = NEW.section_id
         OR EXISTS (SELECT 1 FROM routine_slot_sections x
                    WHERE x.slot_id = rs2.id AND x.section_id = NEW.section_id))
  LIMIT 1;

  IF conflict_id IS NOT NULL THEN
    RAISE EXCEPTION 'section already booked in overlapping slot %', conflict_id
      USING ERRCODE = '23P01';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_merged_section_clash BEFORE INSERT OR UPDATE ON routine_slot_sections
  FOR EACH ROW EXECUTE FUNCTION app.check_merged_section_clash();

-- ---------------------------------------------------------------------
-- Teacher availability: recurring unavailability + dated leave.
-- Both feed the solver (H6) and the substitution candidate filter.
-- ---------------------------------------------------------------------
CREATE TABLE teacher_availability (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  teacher_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day_of_week   smallint NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
  starts_at     time NOT NULL,
  ends_at       time NOT NULL,
  time_range    timerange NOT NULL,
  kind          text NOT NULL DEFAULT 'unavailable'
                  CHECK (kind IN ('unavailable','preferred','admin_duty')),
  reason        text,
  effective_from date NOT NULL DEFAULT CURRENT_DATE,
  effective_to   date,
  CHECK (ends_at > starts_at)
);
CREATE INDEX ix_availability ON teacher_availability (tenant_id, teacher_id, day_of_week);
CREATE TRIGGER trg_avail_range BEFORE INSERT OR UPDATE OF starts_at, ends_at
  ON teacher_availability FOR EACH ROW EXECUTE FUNCTION app.sync_slot_time_range();
CREATE TRIGGER trg_avail_tenant BEFORE INSERT OR UPDATE ON teacher_availability
  FOR EACH ROW EXECUTE FUNCTION app.enforce_tenant();

CREATE TYPE leave_status AS ENUM ('requested','approved','rejected','cancelled','taken');

CREATE TABLE teacher_leaves (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  teacher_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  leave_type    text NOT NULL CHECK (leave_type IN
                  ('casual','sick','earned','maternity','study','unpaid','official_duty')),
  starts_on     date NOT NULL,
  ends_on       date NOT NULL,
  half_day      boolean NOT NULL DEFAULT false,
  reason        text,
  status        leave_status NOT NULL DEFAULT 'requested',
  approved_by   uuid REFERENCES users(id),
  approved_at   timestamptz,
  cover_resolved boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_on >= starts_on)
);
CREATE INDEX ix_leaves_range ON teacher_leaves (tenant_id, teacher_id, starts_on, ends_on)
  WHERE status IN ('approved','taken');
CREATE INDEX ix_leaves_uncovered ON teacher_leaves (tenant_id, starts_on)
  WHERE status = 'approved' AND NOT cover_resolved;
CREATE TRIGGER trg_leaves_tenant BEFORE INSERT OR UPDATE ON teacher_leaves
  FOR EACH ROW EXECUTE FUNCTION app.enforce_tenant();

-- ---------------------------------------------------------------------
-- Substitutions — a dated override of exactly one routine_slot.
-- ---------------------------------------------------------------------
CREATE TYPE substitution_action AS ENUM ('assign','cancel_class','merge_section','self_study');

CREATE TABLE routine_substitutions (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  slot_id            uuid NOT NULL REFERENCES routine_slots(id) ON DELETE CASCADE,
  substitution_date  date NOT NULL,
  action             substitution_action NOT NULL DEFAULT 'assign',

  original_teacher_id uuid NOT NULL REFERENCES users(id),
  substitute_teacher_id uuid REFERENCES users(id),
  merged_into_section_id uuid REFERENCES sections(id),
  room_override_id   uuid REFERENCES rooms(id),

  leave_id           uuid REFERENCES teacher_leaves(id) ON DELETE SET NULL,
  reason             text,

  -- Ranking transparency: what the engine scored and why (see 02-RMS §5.2)
  match_score        numeric(6,2),
  match_reasons      text[],
  assignment_mode    text NOT NULL DEFAULT 'manual'
                       CHECK (assignment_mode IN ('manual','auto','fallback')),

  status             text NOT NULL DEFAULT 'assigned'
                       CHECK (status IN ('proposed','assigned','declined','completed','cancelled')),
  assigned_by        uuid REFERENCES users(id),
  assigned_at        timestamptz NOT NULL DEFAULT now(),
  notified_at        timestamptz,
  acknowledged_at    timestamptz,

  UNIQUE (tenant_id, slot_id, substitution_date)
);
CREATE INDEX ix_subs_for_teacher ON routine_substitutions
  (tenant_id, substitute_teacher_id, substitution_date)
  WHERE status IN ('assigned','proposed');
CREATE INDEX ix_subs_by_date ON routine_substitutions (tenant_id, substitution_date);
CREATE TRIGGER trg_subs_tenant BEFORE INSERT OR UPDATE ON routine_substitutions
  FOR EACH ROW EXECUTE FUNCTION app.enforce_tenant();

-- A substitute must not already be teaching (or substituting) in an
-- overlapping period on that date. The exclusion constraints above cover
-- the routine; this trigger covers the dated override layer.
CREATE OR REPLACE FUNCTION app.check_substitute_free() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_dow   smallint;
  v_range timerange;
  v_rid   uuid;
  v_conflict uuid;
BEGIN
  IF NEW.substitute_teacher_id IS NULL OR NEW.status NOT IN ('proposed','assigned') THEN
    RETURN NEW;
  END IF;

  SELECT rs.day_of_week, rs.time_range, rs.routine_id
    INTO v_dow, v_range, v_rid
  FROM routine_slots rs WHERE rs.id = NEW.slot_id;

  IF EXTRACT(DOW FROM NEW.substitution_date)::smallint <> v_dow THEN
    RAISE EXCEPTION 'substitution_date % is not on the slot''s weekday', NEW.substitution_date
      USING ERRCODE = '23514';
  END IF;

  -- (a) already teaching their own class in an overlapping period
  SELECT rs.id INTO v_conflict
  FROM routine_slots rs
  WHERE rs.tenant_id = NEW.tenant_id
    AND rs.routine_id = v_rid
    AND rs.teacher_id = NEW.substitute_teacher_id
    AND rs.day_of_week = v_dow
    AND rs.time_range && v_range
    AND rs.status = 'active'
    AND NOT EXISTS (            -- unless they are themselves covered that day
      SELECT 1 FROM routine_substitutions s2
      WHERE s2.slot_id = rs.id AND s2.substitution_date = NEW.substitution_date
        AND s2.status IN ('assigned','completed'))
  LIMIT 1;

  IF v_conflict IS NOT NULL THEN
    RAISE EXCEPTION 'substitute is already teaching in overlapping slot %', v_conflict
      USING ERRCODE = '23P01';
  END IF;

  -- (b) already assigned another substitution in an overlapping period
  SELECT s.id INTO v_conflict
  FROM routine_substitutions s
  JOIN routine_slots rs ON rs.id = s.slot_id
  WHERE s.tenant_id = NEW.tenant_id
    AND s.substitute_teacher_id = NEW.substitute_teacher_id
    AND s.substitution_date = NEW.substitution_date
    AND s.status IN ('proposed','assigned')
    AND s.id <> COALESCE(NEW.id, '00000000-0000-0000-0000-000000000000'::uuid)
    AND rs.day_of_week = v_dow
    AND rs.time_range && v_range
  LIMIT 1;

  IF v_conflict IS NOT NULL THEN
    RAISE EXCEPTION 'substitute already covering overlapping substitution %', v_conflict
      USING ERRCODE = '23P01';
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER trg_substitute_free BEFORE INSERT OR UPDATE ON routine_substitutions
  FOR EACH ROW EXECUTE FUNCTION app.check_substitute_free();

-- ---------------------------------------------------------------------
-- Class delivery log — "was this class actually held?"
-- Feeds the coverage report and syllabus-completion tracking.
-- ---------------------------------------------------------------------
CREATE TABLE class_delivery_log (
  id              uuid PRIMARY KEY,                  -- client UUIDv7 (offline-authored)
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  slot_id         uuid NOT NULL REFERENCES routine_slots(id) ON DELETE CASCADE,
  delivered_on    date NOT NULL,
  teacher_id      uuid NOT NULL REFERENCES users(id),
  was_held        boolean NOT NULL,
  not_held_reason text,
  chapter_no      smallint,
  topic_covered   text,
  homework_bn     text,
  logged_at       timestamptz NOT NULL,
  op_id           uuid,
  UNIQUE (tenant_id, slot_id, delivered_on)
);
CREATE INDEX ix_delivery_by_date ON class_delivery_log (tenant_id, delivered_on DESC);
CREATE INDEX ix_delivery_teacher ON class_delivery_log (tenant_id, teacher_id, delivered_on DESC);
CREATE TRIGGER trg_delivery_tenant BEFORE INSERT OR UPDATE ON class_delivery_log
  FOR EACH ROW EXECUTE FUNCTION app.enforce_tenant();

-- Now that routine_slots exists, wire the attendance FK.
ALTER TABLE attendance_sessions
  ADD CONSTRAINT fk_att_session_slot
  FOREIGN KEY (routine_slot_id) REFERENCES routine_slots(id) ON DELETE SET NULL;

-- ---------------------------------------------------------------------
-- The PWA's single most-requested read: a teacher's day, with substitutions
-- already resolved. Both directions — periods they teach, and periods they
-- are covering for someone else.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.teacher_day(p_teacher uuid, p_date date)
RETURNS TABLE (
  slot_id uuid, period_no smallint, starts_at time, ends_at time,
  slot_kind slot_kind, subject_bn text, section_label text, room_code text,
  is_substitution boolean, covering_for text, student_count smallint,
  attendance_taken boolean, delivery_logged boolean
)
LANGUAGE sql STABLE AS $$
  WITH dow AS (SELECT EXTRACT(DOW FROM p_date)::smallint AS d),
  active_routine AS (
    SELECT r.id FROM routines r
    WHERE r.tenant_id = app.current_tenant()
      AND r.status = 'active'
      AND r.effective_from <= p_date
      AND (r.effective_to IS NULL OR r.effective_to >= p_date)
  ),
  own AS (
    SELECT rs.*, false AS is_sub, NULL::uuid AS orig_teacher
    FROM routine_slots rs, dow
    WHERE rs.tenant_id = app.current_tenant()
      AND rs.routine_id IN (SELECT id FROM active_routine)
      AND rs.teacher_id = p_teacher
      AND rs.day_of_week = dow.d
      AND rs.status = 'active'
      -- exclude periods where someone else is covering for me today
      AND NOT EXISTS (
        SELECT 1 FROM routine_substitutions s
        WHERE s.slot_id = rs.id AND s.substitution_date = p_date
          AND s.status IN ('assigned','completed'))
  ),
  covering AS (
    SELECT rs.*, true AS is_sub, s.original_teacher_id AS orig_teacher
    FROM routine_substitutions s
    JOIN routine_slots rs ON rs.id = s.slot_id
    WHERE s.tenant_id = app.current_tenant()
      AND s.substitute_teacher_id = p_teacher
      AND s.substitution_date = p_date
      AND s.status IN ('assigned','completed')
      AND s.action = 'assign'
  ),
  merged AS (SELECT * FROM own UNION ALL SELECT * FROM covering)
  SELECT
    m.id, m.period_no, m.starts_at, m.ends_at, m.slot_kind,
    sub.name_bn,
    c.name_bn || ' — ' || sec.name,
    rm.code,
    m.is_sub,
    orig.full_name_bn,
    sec.student_count,
    EXISTS (SELECT 1 FROM attendance_sessions a
            WHERE a.routine_slot_id = m.id AND a.taken_on = p_date),
    EXISTS (SELECT 1 FROM class_delivery_log d
            WHERE d.slot_id = m.id AND d.delivered_on = p_date)
  FROM merged m
  LEFT JOIN subjects sub ON sub.id = m.subject_id
  LEFT JOIN sections sec ON sec.id = m.primary_section_id
  LEFT JOIN classes  c   ON c.id  = sec.class_id
  LEFT JOIN rooms    rm  ON rm.id = m.room_id
  LEFT JOIN users    orig ON orig.id = m.orig_teacher
  ORDER BY m.starts_at;
$$;

COMMIT;
