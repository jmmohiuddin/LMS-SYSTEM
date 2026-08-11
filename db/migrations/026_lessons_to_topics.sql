-- ============================================================================
-- 026 — lessons → topics  (TRD §5.1, migration step M6)
--
-- Migration 017 named this layer `lessons`, carried over from the
-- course-shaped model v2 replaces. TRD §5.1 is explicit:
--
--   "In v2 that layer is `topics`, sitting between chapter and content
--    block, and `lesson_progress` becomes `topic_progress`. … until it
--    lands, treat the two names as the same entity and do not add new
--    references to the `lesson` naming."
--
-- This lands it. The rename is not cosmetic — `lesson` implies a scheduled
-- teaching event, which in this product is a routine slot. A topic is a
-- teachable unit of a chapter. Leaving both words in the schema means every
-- future reader has to work out which one a given `lesson_id` means.
--
-- ── Doing it as RENAME, not create-copy-drop ─────────────────────────────
-- ALTER TABLE ... RENAME preserves every foreign key pointing at these
-- tables, every index, and the data. Migrations 018 and 019 both added FKs
-- to `lessons` after 017, so a create-and-copy would have to rebuild those
-- by hand — exactly the kind of manual step that drops one.
--
-- ── The offline outbox ───────────────────────────────────────────────────
-- A student can have a queued `lesson_progress` operation on their phone,
-- written before this deploy, that syncs after it. The sync applier
-- therefore accepts BOTH entity names for one release; see
-- services/sync-svc/src/appliers.ts. The schema can rename today because
-- the applier translates. Removing the alias is a later, separate decision
-- that needs evidence no old client is still queueing.
-- ============================================================================
BEGIN;

ALTER TABLE lessons          RENAME TO topics;
ALTER TABLE lesson_progress  RENAME TO topic_progress;
ALTER TABLE lesson_blocks    RENAME TO topic_blocks;

-- Columns that named the old entity.
ALTER TABLE topics          RENAME COLUMN lesson_no TO topic_no;
ALTER TABLE topic_progress  RENAME COLUMN lesson_id TO topic_id;
ALTER TABLE topic_blocks    RENAME COLUMN lesson_id TO topic_id;

-- Foreign keys pointing INTO the renamed table from elsewhere.
ALTER TABLE assignments         RENAME COLUMN lesson_id TO topic_id;
ALTER TABLE practice_questions  RENAME COLUMN lesson_id TO topic_id;
ALTER TABLE practice_attempts   RENAME COLUMN lesson_id TO topic_id;

-- Indexes and constraints keep working under their old names, but a
-- `ix_lessons_chapter` on a table called `topics` is a trap for the next
-- reader. Renaming them is free.
ALTER INDEX  lessons_pkey                                   RENAME TO topics_pkey;
ALTER INDEX  lessons_tenant_id_chapter_id_lesson_no_key     RENAME TO topics_tenant_chapter_no_key;
ALTER INDEX  lesson_progress_pkey                           RENAME TO topic_progress_pkey;
ALTER INDEX  lesson_progress_tenant_id_lesson_id_student_id_key
                                                            RENAME TO topic_progress_tenant_topic_student_key;
ALTER INDEX  lesson_blocks_pkey                             RENAME TO topic_blocks_pkey;
ALTER INDEX  lesson_blocks_tenant_id_lesson_id_block_no_key RENAME TO topic_blocks_tenant_topic_no_key;
ALTER INDEX  practice_questions_tenant_id_lesson_id_question_no_key
                                                            RENAME TO practice_questions_tenant_topic_no_key;
ALTER INDEX  ix_lessons_chapter    RENAME TO ix_topics_chapter;
ALTER INDEX  ix_progress_lesson    RENAME TO ix_progress_topic;
ALTER INDEX  ix_blocks_lesson      RENAME TO ix_blocks_topic;
ALTER INDEX  ix_practice_lesson    RENAME TO ix_practice_topic;
ALTER INDEX  ix_attempts_lesson    RENAME TO ix_attempts_topic;
ALTER INDEX  ix_assignments_lesson RENAME TO ix_assignments_topic;

-- The enum backing content blocks carries the old name in its type, not its
-- values, so only the type is renamed.
ALTER TYPE lesson_block_kind RENAME TO topic_block_kind;

-- Triggers created by 017's programmatic loop are named after the old table.
ALTER TRIGGER trg_lesson_tenant   ON topics RENAME TO trg_topic_tenant;
ALTER TRIGGER trg_lesson_touch    ON topics RENAME TO trg_topic_touch;

COMMENT ON TABLE topics IS
  'A teachable unit within a chapter (TRD §5.2). Named `lessons` in migration '
  '017, carried over from the course-shaped model v2 replaces; renamed in M6. '
  'Not a scheduled teaching event — that is a routine slot.';

COMMENT ON TABLE topic_progress IS
  'Per-student engagement with a topic. Monotonic: a completed topic never '
  'reverts, and reading time accumulates.';

COMMIT;
