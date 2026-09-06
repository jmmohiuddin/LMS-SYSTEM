-- =====================================================================
-- 073 — who may set what a class studies, and when a teacher is free
--
-- P9-2 needs writers for `class_subjects` and `teacher_availability`. Both
-- turned out to be carrying `tenant_isolation` and nothing else — the third
-- and fourth instances of B-89's shape, on two more solver inputs.
--
-- ── Proved live, as `app.role = 'student'` ───────────────────────────
--
--     UPDATE class_subjects SET periods_per_week = 20   ->  UPDATE 12
--     INSERT INTO teacher_availability … 'unavailable'  ->  INSERT 0 1
--
-- Twelve rows of a real school's curriculum, rewritten by a student. And a
-- student could mark any teacher unavailable for a whole day.
--
-- Neither is cosmetic, because of what reads them. `solve.ts` computes the
-- week from `class_subjects.periods_per_week` and refuses to place anything
-- in a slot `teacher_availability` calls blocked, so between them these two
-- tables decide how big the timetable is and where it may not go. A student
-- who set every subject to 20 periods a week would make the school's
-- timetable unsolvable and the failure would look like the solver's fault.
--
-- ── Why this keeps happening, and what is different here ─────────────
-- The pattern is now four for four: a table gets `tenant_isolation` when it
-- is created, and per-command scopes only when someone builds a writer for
-- it. Tables nobody could write were never examined, so the ones that most
-- needed scoping were exactly the ones that did not get it. B-89, B-53 and
-- B-77 are the same sentence about different tables.
--
-- The BACKLOG now carries B-91 to sweep the remainder rather than wait for
-- the next phase to trip over one.
--
-- ── The roles ────────────────────────────────────────────────────────
-- `class_subjects` is the CURRICULUM — what a class studies and how often.
-- The same three that may author a routine, since the two decisions are one
-- conversation in a school office.
--
-- `teacher_availability` adds `dept_head`, and that is deliberate rather
-- than generous: a head of department is the person who actually knows that
-- a teacher has a Thursday clinic, and every row here is scoped to one named
-- teacher, so there is no "every subject in the school" blast radius of the
-- kind that kept dept_head out of migration 072.
--
-- ── DELETE, and why these two differ from 072 ────────────────────────
-- `section_subject_teachers` refuses DELETE because it is teaching HISTORY —
-- a closed row is the record that somebody taught a class.
--
-- These are not history. `class_subjects` is a statement about the current
-- curriculum; removing a subject from a class is a real thing a school does
-- in August, and the row should go rather than linger as noise the solver
-- must filter. `teacher_availability` is dated (`effective_from` /
-- `effective_to`) and a mistaken block should be removable the moment it is
-- noticed — leaving it and adding a correction would give the solver two
-- contradictory rows for one afternoon.
--
-- So DELETE is allowed to the same roles that may INSERT, and no wider.
-- =====================================================================

BEGIN;

-- ── class_subjects — the curriculum ──────────────────────────────────
DROP POLICY IF EXISTS class_subjects_insert_scope ON class_subjects;
CREATE POLICY class_subjects_insert_scope ON class_subjects
  AS RESTRICTIVE FOR INSERT TO shikhon_app
  WITH CHECK (app.has_role('principal', 'school_owner', 'academic_coordinator'));

DROP POLICY IF EXISTS class_subjects_update_scope ON class_subjects;
CREATE POLICY class_subjects_update_scope ON class_subjects
  AS RESTRICTIVE FOR UPDATE TO shikhon_app
  USING (app.has_role('principal', 'school_owner', 'academic_coordinator'))
  WITH CHECK (app.has_role('principal', 'school_owner', 'academic_coordinator'));

DROP POLICY IF EXISTS class_subjects_delete_scope ON class_subjects;
CREATE POLICY class_subjects_delete_scope ON class_subjects
  AS RESTRICTIVE FOR DELETE TO shikhon_app
  USING (app.has_role('principal', 'school_owner', 'academic_coordinator'));

-- ── teacher_availability — when a teacher cannot teach ───────────────
DROP POLICY IF EXISTS teacher_availability_insert_scope ON teacher_availability;
CREATE POLICY teacher_availability_insert_scope ON teacher_availability
  AS RESTRICTIVE FOR INSERT TO shikhon_app
  WITH CHECK (app.has_role('principal', 'school_owner', 'academic_coordinator', 'dept_head'));

DROP POLICY IF EXISTS teacher_availability_update_scope ON teacher_availability;
CREATE POLICY teacher_availability_update_scope ON teacher_availability
  AS RESTRICTIVE FOR UPDATE TO shikhon_app
  USING (app.has_role('principal', 'school_owner', 'academic_coordinator', 'dept_head'))
  WITH CHECK (app.has_role('principal', 'school_owner', 'academic_coordinator', 'dept_head'));

DROP POLICY IF EXISTS teacher_availability_delete_scope ON teacher_availability;
CREATE POLICY teacher_availability_delete_scope ON teacher_availability
  AS RESTRICTIVE FOR DELETE TO shikhon_app
  USING (app.has_role('principal', 'school_owner', 'academic_coordinator', 'dept_head'));

-- SELECT stays open to the tenant on both. A teacher seeing when they are
-- marked unavailable, and a student seeing how many periods of maths their
-- class has, are both ordinary reads of the timetable they already live in.

-- ── The overlap `period_definitions` never forbade ───────────────────
--
-- `period_definitions` has UNIQUE (tenant, template, period_no) and
-- CHECK (ends_at > starts_at), and NOTHING stopping period 3 from running
-- 10:00–11:00 while period 4 runs 10:30–11:30. The solver books teachers and
-- rooms by TIME INTERVAL (F-506, cross-shift), so overlapping definitions
-- would make two periods in the same template mutually exclusive for every
-- teacher — a timetable that cannot be filled, from a bell schedule that
-- looked fine.
--
-- An EXCLUDE constraint, matching the three that already protect
-- `routine_slots`. `WITH &&` on the time range, partitioned by template, so
-- two different templates (a morning shift and a day shift) may legitimately
-- overlap each other — which is the whole reason cross-shift booking exists.
ALTER TABLE period_definitions
  DROP CONSTRAINT IF EXISTS pd_no_overlap_within_template;
ALTER TABLE period_definitions
  ADD CONSTRAINT pd_no_overlap_within_template
  EXCLUDE USING gist (
    tenant_id WITH =,
    template_id WITH =,
    timerange(starts_at, ends_at) WITH &&
  );

COMMIT;
