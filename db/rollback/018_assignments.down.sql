-- Rollback for 018_assignments.sql.
BEGIN;

DROP TABLE IF EXISTS assignment_submissions;
DROP TABLE IF EXISTS assignments;
DROP FUNCTION IF EXISTS app.mark_submission_lateness();

COMMIT;
