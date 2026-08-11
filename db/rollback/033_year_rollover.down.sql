-- Rollback for 033 — academic year rollover (F-1605).
--
-- Drops the planning table and the two functions. It does NOT undo a
-- rollover that has already been committed, and cannot: the new
-- enrolments have attendance, marks and invoices hung off them by now, and
-- deleting a child's enrolment to satisfy a schema change would destroy
-- the year's records.
--
-- If a committed rollover is the problem, that is a data correction, not a
-- migration rollback.
BEGIN;

DROP FUNCTION IF EXISTS app.commit_rollover(uuid);
DROP FUNCTION IF EXISTS app.rollover_preview(uuid, uuid);
DROP TABLE IF EXISTS year_rollovers;

COMMIT;
