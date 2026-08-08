-- Rollback for 019_practice.sql.
BEGIN;

DROP TABLE IF EXISTS practice_attempts;
DROP TABLE IF EXISTS practice_options;
DROP TABLE IF EXISTS practice_questions;
DROP TYPE IF EXISTS practice_kind;

COMMIT;
