-- ============================================================================
-- 023 — RESTRICTIVE write policies were also blocking reads
--
-- Found by the F-106 backfill tests, which were the first thing ever to
-- query these tables as a student rather than as staff.
--
-- ── The bug ──────────────────────────────────────────────────────────────
-- Six tables carry a pair of RESTRICTIVE policies:
--
--     <table>_read_scope    FOR SELECT   — students may read published rows
--     <table>_write_scope   FOR ALL      — only staff may write
--
-- RESTRICTIVE policies AND together, and `FOR ALL` includes SELECT. So the
-- effective read rule was
--
--     read_scope AND has_role(staff…)
--
-- which is `has_role(staff…)`. Every read policy written to let a student
-- see published content was cancelled out by the write policy sitting next
-- to it. Two more tables — practice_questions and practice_options — had
-- only the FOR ALL write policy and no read policy at all, so students
-- could not read a practice question either.
--
-- ── What this actually broke ─────────────────────────────────────────────
-- Everything a student or guardian was supposed to be able to read:
--
--     chapters, lessons, lesson_blocks   the entire Learn tab — no chapter
--                                        list, no lesson, no content block
--     practice_questions/_options        every practice question
--     assignments                        homework was invisible; worse, the
--                                        BEFORE-INSERT lateness trigger
--                                        looks the assignment up under the
--                                        submitter's own RLS, found nothing,
--                                        left is_late NULL, and the insert
--                                        died on a NOT NULL violation — so
--                                        submitting was impossible too, with
--                                        an error naming a column the
--                                        student has never heard of
--     invoices                           guardians could not see fees
--
-- The endpoints, the queries and the UI were all correct. Only staff ever
-- exercised them, so nothing failed loudly.
--
-- ── The fix ──────────────────────────────────────────────────────────────
-- PostgreSQL has no `FOR WRITE`, so each `FOR ALL` write policy is replaced
-- by three — INSERT, UPDATE, DELETE — with identical predicates. SELECT is
-- then governed solely by the read policy, which is what was intended.
-- The write side is not loosened by one role: same predicates, narrower
-- command set.
--
-- practice_questions and practice_options get the read policy they never
-- had, matching lessons: published content is readable, unpublished is
-- staff-only.
-- ============================================================================
BEGIN;

-- ---------------------------------------------------------------------
-- Replaces one FOR ALL restrictive policy with per-command equivalents.
-- Written as a helper because getting this wrong on one of six tables
-- would silently leave that table broken, and a copy-pasted block is
-- exactly how that happens.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION pg_temp.split_write_policy(p_table text, p_policy text)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  v_using text;
  v_check text;
  v_cmd   "char";
BEGIN
  SELECT pg_get_expr(polqual, polrelid), pg_get_expr(polwithcheck, polrelid), polcmd
    INTO v_using, v_check, v_cmd
    FROM pg_policy
   WHERE polrelid = p_table::regclass AND polname = p_policy AND NOT polpermissive;

  IF v_using IS NULL THEN
    RAISE EXCEPTION 'policy %.% not found (or is permissive)', p_table, p_policy;
  END IF;
  IF v_cmd <> '*' THEN
    RAISE NOTICE 'policy %.% is already command-scoped; leaving it alone', p_table, p_policy;
    RETURN;
  END IF;

  EXECUTE format('DROP POLICY %I ON %I', p_policy, p_table);

  -- INSERT policies take only WITH CHECK; UPDATE takes both; DELETE only
  -- USING. Carrying the original expressions through verbatim keeps the
  -- write rules byte-identical to what was reviewed.
  EXECUTE format(
    'CREATE POLICY %I ON %I AS RESTRICTIVE FOR INSERT TO shikhon_app WITH CHECK (%s)',
    p_policy || '_ins', p_table, COALESCE(v_check, v_using));
  EXECUTE format(
    'CREATE POLICY %I ON %I AS RESTRICTIVE FOR UPDATE TO shikhon_app USING (%s) WITH CHECK (%s)',
    p_policy || '_upd', p_table, v_using, COALESCE(v_check, v_using));
  EXECUTE format(
    'CREATE POLICY %I ON %I AS RESTRICTIVE FOR DELETE TO shikhon_app USING (%s)',
    p_policy || '_del', p_table, v_using);
END $$;

SELECT pg_temp.split_write_policy('assignments',        'assignment_write_scope');
SELECT pg_temp.split_write_policy('chapters',           'chapter_write_scope');
SELECT pg_temp.split_write_policy('lessons',            'lesson_write_scope');
SELECT pg_temp.split_write_policy('lesson_blocks',      'block_write_scope');
SELECT pg_temp.split_write_policy('invoices',           'invoice_write_scope');
SELECT pg_temp.split_write_policy('practice_questions', 'pq_write_scope');
SELECT pg_temp.split_write_policy('practice_options',   'po_write_scope');

-- Deliberately NOT split: attendance_sessions_scope, ledger_scope,
-- safeguarding_scope, alumni_export_scope, ans_endpoint_scope. Those are
-- staff-only by design — no student or guardian should read a ledger entry
-- or a safeguarding flag, so `FOR ALL` covering SELECT is correct there and
-- narrowing it would open reads that are supposed to be shut.

-- ---------------------------------------------------------------------
-- The read policies practice never had.
--
-- Mirrors lesson_read_scope: published content is readable by anyone in
-- the tenant, unpublished is staff-only. Options follow their question, so
-- an unpublished question cannot leak its answer key through the options
-- table.
-- ---------------------------------------------------------------------
CREATE POLICY pq_read_scope ON practice_questions
  AS RESTRICTIVE FOR SELECT TO shikhon_app
  USING (
    is_published
    OR app.has_role('principal','school_owner','academic_coordinator','dept_head',
                    'class_teacher','subject_teacher')
  );

CREATE POLICY po_read_scope ON practice_options
  AS RESTRICTIVE FOR SELECT TO shikhon_app
  USING (
    EXISTS (SELECT 1 FROM practice_questions q
             WHERE q.id = practice_options.question_id AND q.is_published)
    OR app.has_role('principal','school_owner','academic_coordinator','dept_head',
                    'class_teacher','subject_teacher')
  );

-- ---------------------------------------------------------------------
-- Prove the repair, in the migration itself.
--
-- A student must be able to see a published chapter. If this assertion
-- fails the migration rolls back, because deploying a "fix" that did not
-- fix it is worse than leaving the bug visible.
-- ---------------------------------------------------------------------
DO $$
DECLARE
  v_tenant  uuid := 'a0230000-0000-4000-8000-000000000023';
  v_student uuid := 'a0230000-0000-4000-8000-0000000000b1';
  v_class   uuid := 'a0230000-0000-4000-8000-0000000000c1';
  v_subject uuid := 'a0230000-0000-4000-8000-0000000000c2';
  v_chapter uuid := 'a0230000-0000-4000-8000-0000000000d1';
  n integer;
BEGIN
  PERFORM set_config('app.tenant_id', v_tenant::text, true);
  PERFORM set_config('app.role', 'principal', true);
  PERFORM set_config('app.user_id', v_student::text, true);

  INSERT INTO tenants (id, slug, name_bn, name_en, stream, level)
  VALUES (v_tenant, 'rls-023-check', 'যাচাই', 'Check', 'bangla_medium', 'secondary');
  INSERT INTO users (id, tenant_id, full_name_bn, full_name_en, phone_e164)
  VALUES (v_student, v_tenant, 'যাচাই ছাত্র', 'Check Student', '+8801790230023');
  INSERT INTO classes (id, tenant_id, level_no, name_bn, name_en, stream)
  VALUES (v_class, v_tenant, 9, 'নবম', 'Nine', 'bangla_medium');
  INSERT INTO subjects (id, tenant_id, nctb_code, name_bn, name_en)
  VALUES (v_subject, v_tenant, '127', 'পদার্থ', 'Physics');
  INSERT INTO chapters (id, tenant_id, subject_id, class_id, chapter_no, name_bn, is_published)
  VALUES (v_chapter, v_tenant, v_subject, v_class, 1, 'অধ্যায় ১', true);

  PERFORM set_config('app.role', 'student', true);
  SELECT count(*) INTO n FROM chapters WHERE id = v_chapter;

  PERFORM set_config('app.role', 'principal', true);
  DELETE FROM tenants WHERE id = v_tenant;

  IF n <> 1 THEN
    RAISE EXCEPTION
      'the repair did not take: a student still cannot read a published chapter';
  END IF;
  RAISE NOTICE 'verified — a student can now read published content';
END $$;

COMMIT;
