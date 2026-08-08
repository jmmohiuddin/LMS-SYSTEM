-- Rollback for 017_course_content.sql.
--
-- Order matters: lesson_blocks and lesson_progress reference lessons,
-- lessons references chapters, chapters self-references. Dropping the
-- tables cascades their policies, triggers and indexes; the enum has to
-- go after the table that uses it.
BEGIN;

DROP TABLE IF EXISTS lesson_progress;
DROP TABLE IF EXISTS lesson_blocks;
DROP TABLE IF EXISTS lessons;
DROP TABLE IF EXISTS chapters;

DROP TYPE IF EXISTS lesson_block_kind;

COMMIT;
