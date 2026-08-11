-- Rollback for 026 — lessons → topics (TRD §5.1 M6).
--
-- A pure rename in both directions, so no data moves and no FK is rebuilt.
-- Note that the application code renamed with it: rolling back the schema
-- alone will break every /academics endpoint until the code is rolled back
-- to the matching commit.
BEGIN;

ALTER TRIGGER trg_topic_touch  ON topics RENAME TO trg_lesson_touch;
ALTER TRIGGER trg_topic_tenant ON topics RENAME TO trg_lesson_tenant;

ALTER TYPE topic_block_kind RENAME TO lesson_block_kind;

ALTER INDEX ix_assignments_topic RENAME TO ix_assignments_lesson;
ALTER INDEX ix_attempts_topic    RENAME TO ix_attempts_lesson;
ALTER INDEX ix_practice_topic    RENAME TO ix_practice_lesson;
ALTER INDEX ix_blocks_topic      RENAME TO ix_blocks_lesson;
ALTER INDEX ix_progress_topic    RENAME TO ix_progress_lesson;
ALTER INDEX ix_topics_chapter    RENAME TO ix_lessons_chapter;
ALTER INDEX practice_questions_tenant_topic_no_key
                                 RENAME TO practice_questions_tenant_id_lesson_id_question_no_key;
ALTER INDEX topic_blocks_tenant_topic_no_key
                                 RENAME TO lesson_blocks_tenant_id_lesson_id_block_no_key;
ALTER INDEX topic_blocks_pkey    RENAME TO lesson_blocks_pkey;
ALTER INDEX topic_progress_tenant_topic_student_key
                                 RENAME TO lesson_progress_tenant_id_lesson_id_student_id_key;
ALTER INDEX topic_progress_pkey  RENAME TO lesson_progress_pkey;
ALTER INDEX topics_tenant_chapter_no_key
                                 RENAME TO lessons_tenant_id_chapter_id_lesson_no_key;
ALTER INDEX topics_pkey          RENAME TO lessons_pkey;

ALTER TABLE practice_attempts   RENAME COLUMN topic_id TO lesson_id;
ALTER TABLE practice_questions  RENAME COLUMN topic_id TO lesson_id;
ALTER TABLE assignments         RENAME COLUMN topic_id TO lesson_id;
ALTER TABLE topic_blocks        RENAME COLUMN topic_id TO lesson_id;
ALTER TABLE topic_progress      RENAME COLUMN topic_id TO lesson_id;
ALTER TABLE topics              RENAME COLUMN topic_no  TO lesson_no;

ALTER TABLE topic_blocks   RENAME TO lesson_blocks;
ALTER TABLE topic_progress RENAME TO lesson_progress;
ALTER TABLE topics         RENAME TO lessons;

COMMIT;
