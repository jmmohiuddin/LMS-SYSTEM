-- ============================================================================
-- 044 — The enrolment timeline gets an index  (R-6, docs/11-MASTER-PLAN.md)
--
-- R-6's core requirement is that a principal types an old student code and
-- sees that child's whole multi-year history. The history itself needs no new
-- table: `enrolments` has carried one row per student per year since
-- migration 003, with the section, the roll and the status, and R-6
-- deliberately reads it rather than denormalising a copy. One year per row is
-- already the source of truth.
--
-- What it lacked was a way to find one student's rows without reading
-- everybody's.
--
-- ── Why the existing indexes cannot serve it ───────────────────────────
-- `enrolments` had three:
--
--   enrolments_pkey                             (id)
--   enrolments_tenant_id_academic_year_id_..._key (tenant, YEAR, student)
--   ix_enrolment_roster                         (tenant, section, roll)
--
-- All three answer "who is in this section/year". None answers "where has
-- this child been", because `student_id` is the LAST column of the only
-- index that mentions it: a lookup by (tenant, student) has to walk every
-- entry for the tenant and filter. That is the shape that looks fine on a
-- new school and gets slower every January.
--
-- ── Measured, not assumed ──────────────────────────────────────────────
-- Against a seeded school of 2,000 students × 4 years = 8,000 enrolment rows
-- (PostgreSQL 16, EXPLAIN ANALYZE, warm):
--
--   seq scan (what the planner actually chose)        1.255 ms, 7,997 rows discarded
--   forced index scan on the (tenant, year, student)
--     unique index — a full walk, not a seek          0.712 ms
--   THIS index                                        0.089 ms, 4 rows read
--
-- Fourteen times faster is worth having; the shape of the win matters more.
-- The scan is linear in the size of the whole school's history, so a
-- ten-year-old school with 20,000 students pays 200,000 rows for one child's
-- four. The seek stays flat. R-6's exit criterion is "the history appears
-- quickly" for a student who left years ago, and the years are exactly what
-- makes the scan worse.
--
-- ── Why (tenant, student, year) and not (tenant, student) ──────────────
-- The timeline is always ordered by academic year, so carrying the year as
-- the third column lets the index supply the order and skips a sort. It also
-- serves the "was this child enrolled in 2025" question without a heap fetch
-- for the common case.
--
-- No new table, no new column, no policy change: `enrolments` already has
-- tenant isolation from 010's loop, and an index does not widen what anyone
-- can read. Rollback drops the index and nothing else.
-- ============================================================================

CREATE INDEX IF NOT EXISTS ix_enrolment_student_history
  ON enrolments (tenant_id, student_id, academic_year_id);

COMMENT ON INDEX ix_enrolment_student_history IS
  'R-6: one student''s multi-year enrolment timeline as a seek, not a scan of '
  'the whole school''s history. See db/migrations/044 for the measurements.';
