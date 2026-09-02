-- ---------------------------------------------------------------------------
-- 066 — the exam tables get the write scope they never had, on the day an
--       exam can first be created.
--
-- ── What was found ──────────────────────────────────────────────────────
-- Nothing in the product has ever created an exam. `INSERT INTO exams` appears
-- nowhere under `services/` or `packages/` outside tests, and no `app.*`
-- function inserts one. The whole downstream chain — marks entry, per-subject
-- grades, GPA, rank, publish, the progress report, the admit card — is built,
-- tested and unreachable, because it all hangs off a row no code could write.
--
-- And like `rooms` in migration 065, the tables were writable by anybody.
-- `exams` and `exam_subjects` have carried `tenant_isolation` and no role
-- scope since migration 005. Verified against a live database inside a
-- rolled-back transaction: a session with `app.role = 'subject_teacher'`
-- inserted an exam successfully. The only thing that had ever stopped them was
-- the absence of an endpoint.
--
-- ── Per-command, never FOR ALL ──────────────────────────────────────────
-- A RESTRICTIVE `FOR ALL` applies its USING to SELECT, which would hide exams
-- from students, guardians, the progress report and the marks screen. Same
-- shape and same reasoning as migration 042.
--
-- The four roles mirror `EXAM_ROLES` in services/rms-svc/api/examroutine.ts —
-- the same four that already write these tables through the exam-routine
-- screen, and the same four `exam_marks.marks_scope` grants unconditional
-- mark-reading to. No new role set is invented here.
--
-- ── An exam is never deleted; a paper sometimes is ──────────────────────
-- Deleting an exam cascades to `exam_subjects`, `exam_marks` and
-- `exam_results` — the legal record behind every certificate the school has
-- issued from it. Nobody gets that.
--
-- A PAPER is different: a coordinator who ticked the wrong class must be able
-- to untick it. But only while it holds nothing. Once a mark exists the row is
-- evidence, and the guard lives here rather than only in the handler because a
-- schedule row that quietly takes marks with it is precisely the loss a role
-- check in TypeScript cannot promise.
-- ---------------------------------------------------------------------------

BEGIN;

-- ── 1. Write scope ──────────────────────────────────────────────────────

CREATE POLICY exams_insert_scope ON exams
  AS RESTRICTIVE FOR INSERT TO shikhon_app
  WITH CHECK (app.has_role('principal', 'school_owner', 'academic_coordinator', 'dept_head'));

CREATE POLICY exams_update_scope ON exams
  AS RESTRICTIVE FOR UPDATE TO shikhon_app
  USING      (app.has_role('principal', 'school_owner', 'academic_coordinator', 'dept_head'))
  WITH CHECK (app.has_role('principal', 'school_owner', 'academic_coordinator', 'dept_head'));

CREATE POLICY exams_delete_scope ON exams
  AS RESTRICTIVE FOR DELETE TO shikhon_app
  USING (false);

CREATE POLICY exam_subjects_insert_scope ON exam_subjects
  AS RESTRICTIVE FOR INSERT TO shikhon_app
  WITH CHECK (app.has_role('principal', 'school_owner', 'academic_coordinator', 'dept_head'));

CREATE POLICY exam_subjects_update_scope ON exam_subjects
  AS RESTRICTIVE FOR UPDATE TO shikhon_app
  USING      (app.has_role('principal', 'school_owner', 'academic_coordinator', 'dept_head'))
  WITH CHECK (app.has_role('principal', 'school_owner', 'academic_coordinator', 'dept_head'));

-- Safe against the marks_scope read policy: all four roles below already read
-- every `exam_marks` row unconditionally, so the EXISTS cannot come back
-- falsely empty for them and let a paper with marks be deleted.
CREATE POLICY exam_subjects_delete_scope ON exam_subjects
  AS RESTRICTIVE FOR DELETE TO shikhon_app
  USING (
    app.has_role('principal', 'school_owner', 'academic_coordinator', 'dept_head')
    AND NOT marking_locked
    AND NOT EXISTS (SELECT 1 FROM exam_marks m WHERE m.exam_subject_id = exam_subjects.id)
  );

-- ── 2. Two rules the write path needs, in the database ──────────────────
-- Both checked against every live row first: zero violations.

ALTER TABLE exams ADD CONSTRAINT exams_date_order
  CHECK (starts_on IS NULL OR ends_on IS NULL OR ends_on >= starts_on);

-- Two exams called "বার্ষিক পরীক্ষা" in one year is not a naming preference —
-- it is a marks-entry screen offering the teacher two identical rows and no way
-- to tell which is which. The same name in the NEXT year is normal and stays
-- legal, so the key carries the year.
CREATE UNIQUE INDEX uq_exam_name_year ON exams (tenant_id, academic_year_id, name_bn);

COMMIT;
