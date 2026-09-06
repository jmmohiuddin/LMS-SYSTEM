-- =====================================================================
-- 072 — who may say which teacher takes which subject in which section
--
-- Found by P9-0's inventory, before a single line of the routine wizard was
-- written, and it is the reason the wizard could not have been written first.
--
-- ── The defect (B-89) ────────────────────────────────────────────────
-- `section_subject_teachers` carried ONE policy: `tenant_isolation`,
-- PERMISSIVE, FOR ALL. Tenant-match was the whole test. Proved live as
-- `app.role = 'student'` against a real school:
--
--     INSERT … teacher_id = <the student's own id>   -> INSERT 0 1
--     DELETE FROM section_subject_teachers …          -> DELETE 1
--
-- A student could name themselves the teacher of any section, and could
-- delete the school's real assignments. That is bad on its own and worse in
-- context: `solve.ts:loadDemand` reads this table and nothing else to decide
-- what the timetable must contain, so whoever writes it writes the school's
-- entire teaching load.
--
-- It is exactly the shape B-77 found on `payment_receipts` and
-- `invoice_lines` — a table sitting next to well-scoped neighbours, inheriting
-- only the isolation every table gets. `class_teacher_assignments` (the
-- neighbouring "who is the class teacher" table) got per-command scopes in
-- migration 010 line 269; this one was missed.
--
-- ── The roles ────────────────────────────────────────────────────────
-- The same three that may write a routine (`routine_write_scope`, 010): a
-- teaching assignment IS routine input, and a role that cannot write the
-- timetable must not be able to write what the timetable is generated from —
-- that would be the gate with an extra step.
--
-- `dept_head` is deliberately NOT here, though 010 line 269 admits them to
-- `class_teacher_assignments`. A department head assigning teachers across
-- their own department is reasonable and this table has no department column
-- to scope it by, so admitting them would admit them to every subject in the
-- school. Recorded rather than guessed at: if a school wants it, the scope
-- needs a department predicate first.
--
-- ── Why DELETE is refused outright ───────────────────────────────────
-- `started_on` / `ended_on` / `end_reason` make this a HISTORY table, like
-- `enrolments`. Reassigning a subject is closing one row and opening another,
-- so a teacher's record of what they taught last term survives. A DELETE is
-- therefore never the right operation: it erases the fact that somebody
-- taught a class, which is exactly what a school needs when a parent asks who
-- was teaching in March. The writer in `rms-svc` closes rows; nothing deletes
-- them.
--
-- Note the shape of the hole this closes: a RESTRICTIVE `FOR ALL` with
-- `USING (true)` would gate INSERT and UPDATE through WITH CHECK and leave
-- DELETE wide open, because USING is what DELETE consults. That is the
-- recurring mistake in this codebase (069's header records it), so the four
-- commands are written out separately.
-- =====================================================================

BEGIN;

-- INSERT — only the three roles that may author a routine.
DROP POLICY IF EXISTS sst_insert_scope ON section_subject_teachers;
CREATE POLICY sst_insert_scope ON section_subject_teachers
  AS RESTRICTIVE FOR INSERT TO shikhon_app
  WITH CHECK (app.has_role('principal', 'school_owner', 'academic_coordinator'));

-- UPDATE — the same, and the only legitimate update is closing a row.
DROP POLICY IF EXISTS sst_update_scope ON section_subject_teachers;
CREATE POLICY sst_update_scope ON section_subject_teachers
  AS RESTRICTIVE FOR UPDATE TO shikhon_app
  USING (app.has_role('principal', 'school_owner', 'academic_coordinator'))
  WITH CHECK (app.has_role('principal', 'school_owner', 'academic_coordinator'));

-- DELETE — nobody. See the header: this is a history table.
DROP POLICY IF EXISTS sst_delete_scope ON section_subject_teachers;
CREATE POLICY sst_delete_scope ON section_subject_teachers
  AS RESTRICTIVE FOR DELETE TO shikhon_app
  USING (false);

-- SELECT stays open to the tenant. A student seeing who teaches their subject
-- is the timetable they are already shown, and a teacher needs to see their
-- own load. Nothing here is private within a school.

-- ── A duplicate guard that already existed ───────────────────────────
--
-- This migration originally added a partial unique index on
-- (tenant_id, section_id, subject_id) WHERE ended_on IS NULL, to stop two
-- ACTIVE rows for one (section, subject) — which would make `loadDemand`
-- read the demand twice and place double the periods a class actually has.
--
-- `uq_sst_current` already does that, and does it BETTER: it includes
-- `academic_year_id`. Mine omitted it, so it would have refused the same
-- (section, subject) being current in two different academic years — which is
-- legitimate during a rollover, when next year's assignments are entered
-- while this year is still running. A guard that forbids a correct state is
-- worse than no guard.
--
-- Left as a comment rather than deleted from history: the check was worth
-- making, and the reason for NOT adding it is the useful part. Found by
-- reading `pg_indexes` after `pg_constraint` showed nothing — a partial
-- unique INDEX is not a constraint and does not appear there.

COMMIT;
