-- Rollback for 023 — restrictive write policies also blocking reads.
--
-- Restores the FOR ALL write policies exactly as migrations 007/017/018/019
-- created them, and drops the two read policies practice never had.
--
-- Be clear about what rolling this back means: it re-breaks every
-- student-facing read — the Learn tab, practice, homework and fee
-- visibility all go dark again, and assignment submission starts failing on
-- a NOT NULL violation. Roll back only if 023 itself caused a regression,
-- never as routine tidying.
BEGIN;

DROP POLICY IF EXISTS pq_read_scope ON practice_questions;
DROP POLICY IF EXISTS po_read_scope ON practice_options;

CREATE OR REPLACE FUNCTION pg_temp.restore_write_policy(p_table text, p_policy text)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE v_using text; v_check text;
BEGIN
  SELECT pg_get_expr(polqual, polrelid) INTO v_using
    FROM pg_policy WHERE polrelid = p_table::regclass AND polname = p_policy || '_upd';
  SELECT pg_get_expr(polwithcheck, polrelid) INTO v_check
    FROM pg_policy WHERE polrelid = p_table::regclass AND polname = p_policy || '_ins';
  IF v_using IS NULL THEN
    RAISE NOTICE 'nothing to restore on %.%', p_table, p_policy;
    RETURN;
  END IF;

  EXECUTE format('DROP POLICY IF EXISTS %I ON %I', p_policy || '_ins', p_table);
  EXECUTE format('DROP POLICY IF EXISTS %I ON %I', p_policy || '_upd', p_table);
  EXECUTE format('DROP POLICY IF EXISTS %I ON %I', p_policy || '_del', p_table);
  EXECUTE format(
    'CREATE POLICY %I ON %I AS RESTRICTIVE FOR ALL TO shikhon_app USING (%s) WITH CHECK (%s)',
    p_policy, p_table, v_using, COALESCE(v_check, v_using));
END $$;

SELECT pg_temp.restore_write_policy('assignments',        'assignment_write_scope');
SELECT pg_temp.restore_write_policy('chapters',           'chapter_write_scope');
SELECT pg_temp.restore_write_policy('lessons',            'lesson_write_scope');
SELECT pg_temp.restore_write_policy('lesson_blocks',      'block_write_scope');
SELECT pg_temp.restore_write_policy('invoices',           'invoice_write_scope');
SELECT pg_temp.restore_write_policy('practice_questions', 'pq_write_scope');
SELECT pg_temp.restore_write_policy('practice_options',   'po_write_scope');

COMMIT;
