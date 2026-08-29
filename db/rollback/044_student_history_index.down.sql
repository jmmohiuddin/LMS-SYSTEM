-- Rollback for 044 — the enrolment timeline index (R-6).
--
-- Loses nothing. An index is not data: dropping it leaves every enrolment row
-- exactly as it was, and every query that used it still returns the same
-- answer. What comes back is the cost — one student's timeline goes from a
-- 0.089 ms seek to a scan of the whole school's enrolment history, which was
-- 1.255 ms over 8,000 rows on the fixture and grows with every year the
-- school stays open.
--
-- So this is safe to run and slow to live with. If it is being run to undo
-- R-6, the student-history page will still work.

DROP INDEX IF EXISTS ix_enrolment_student_history;
