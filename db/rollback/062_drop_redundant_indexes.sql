-- Rollback for 062 — recreates two indexes that duplicate a UNIQUE index.
--
-- They cost a write on every INSERT and UPDATE of two bulk-written tables and
-- answer no query the UNIQUE index beside them cannot. Recreate only to get
-- back to a known state during a bisect.
BEGIN;
CREATE INDEX IF NOT EXISTS ix_practice_options
  ON practice_options (tenant_id, question_id, option_no);
CREATE INDEX IF NOT EXISTS ix_blocks_topic
  ON topic_blocks (tenant_id, topic_id, block_no);
COMMIT;
