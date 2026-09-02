-- ---------------------------------------------------------------------------
-- 062 — two indexes that duplicate the unique index beside them.
--
-- ── What was found ──────────────────────────────────────────────────────
--   practice_options  ix_practice_options   (tenant_id, question_id, option_no)
--                     practice_options_tenant_id_question_id_option_no_key  UNIQUE, same columns
--
--   topic_blocks      ix_blocks_topic       (tenant_id, topic_id, block_no)
--                     topic_blocks_tenant_topic_no_key                      UNIQUE, same columns
--
-- Identical column lists, same order, neither partial. A UNIQUE btree serves
-- every lookup and every ordering a non-unique btree on the same columns
-- serves, so the second index answers no query the first cannot. What it does
-- do is cost a write on every INSERT and UPDATE of two tables that are
-- written in bulk: `practice_options` four rows at a time per question, and
-- `topic_blocks` once per block of published content.
--
-- Found by comparing every index in the schema against every other on the
-- same table, not by reading migrations — which is why it took until P8.
-- Both were correct when written: `ix_blocks_topic` was created as
-- `ix_blocks_lesson` in 017 and renamed by 026's lessons→topics rework, and
-- the UNIQUE constraint that made it redundant arrived separately.
--
-- ── What is NOT done here ───────────────────────────────────────────────
-- The CREATE INDEX statements in migrations 017 and 019 are left exactly as
-- they are. A migration is a record of what happened, not a description of
-- the current schema; editing one so a replay skips a step is how a fresh
-- database stops matching a migrated one. The index is created there and
-- dropped here, in order, and both files stay true.
-- ---------------------------------------------------------------------------

BEGIN;

-- CHECKED FIRST. Dropping a redundant index is only safe while the thing that
-- made it redundant exists; a migration that assumes that without looking is
-- a migration that can silently remove the only index on a hot column. The
-- transaction would roll the drops back either way, but a guard that runs
-- after the thing it guards is a guard nobody can read.
DO $$
DECLARE missing text;
BEGIN
  SELECT string_agg(want, ', ') INTO missing
    FROM (VALUES
      ('practice_options_tenant_id_question_id_option_no_key'),
      ('topic_blocks_tenant_topic_no_key')
    ) AS t(want)
   WHERE NOT EXISTS (
     SELECT 1 FROM pg_indexes
      WHERE schemaname = 'public' AND indexname = t.want);
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'refusing to drop: the covering unique index is gone: %', missing;
  END IF;
END $$;

DROP INDEX IF EXISTS ix_practice_options;
DROP INDEX IF EXISTS ix_blocks_topic;

COMMIT;
