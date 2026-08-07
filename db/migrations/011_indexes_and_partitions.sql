-- =====================================================================
-- 011_indexes_and_partitions.sql
-- Index strategy notes, partition automation, retention, and the
-- materialised views behind the dashboards.
--
-- Index principles applied throughout this schema:
--   1. Every index on a tenant table LEADS with tenant_id. RLS injects
--      `tenant_id = …` into every plan; a leading-column match turns a
--      filter into a seek.
--   2. Covering (INCLUDE) indexes on the three hot reads — the attendance
--      grid, the teacher day view, the guardian dashboard — so they serve
--      from index-only scans and never touch the heap.
--   3. Partial indexes for queue-shaped tables (`WHERE status='queued'`).
--      sms_outbox reaches 30M rows; its dispatch index stays in kilobytes.
--   4. BRIN on append-only time columns of partitioned tables (~200x
--      smaller than B-tree, and correlation is near-perfect by construction).
--   5. GiST exclusion constraints (006) instead of application-level clash
--      checks, so double-booking is structurally impossible.
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- Additional composite indexes for known hot paths
-- ---------------------------------------------------------------------

-- Teacher day view (app.teacher_day) — the PWA's most frequent read.
CREATE INDEX IF NOT EXISTS ix_slots_teacher_day ON routine_slots
  (tenant_id, teacher_id, day_of_week, starts_at)
  INCLUDE (primary_section_id, subject_id, room_id, period_no, slot_kind)
  WHERE status = 'active';

-- Section day view (student/guardian "today's classes").
CREATE INDEX IF NOT EXISTS ix_slots_section_day ON routine_slots
  (tenant_id, primary_section_id, day_of_week, starts_at)
  INCLUDE (subject_id, teacher_id, room_id, period_no)
  WHERE status = 'active';

-- Room utilisation report.
CREATE INDEX IF NOT EXISTS ix_slots_room_day ON routine_slots
  (tenant_id, room_id, day_of_week, starts_at) WHERE status = 'active' AND room_id IS NOT NULL;

-- Coverage board: "which periods need cover today".
CREATE INDEX IF NOT EXISTS ix_subs_open ON routine_substitutions
  (tenant_id, substitution_date, status) WHERE status IN ('proposed','assigned');

-- Guardian dashboard: fee balance across all wards, one seek per ward.
CREATE INDEX IF NOT EXISTS ix_invoice_balance ON invoices
  (tenant_id, student_id) INCLUDE (total_amount, paid_amount, due_on, status)
  WHERE status IN ('issued','partly_paid','overdue');

-- Item-bank picker for SikhokAI paper assembly.
CREATE INDEX IF NOT EXISTS ix_items_vector ON question_items
  USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64);

-- Bangla/English fuzzy student search from the admin console.
CREATE INDEX IF NOT EXISTS ix_users_name_en_trgm ON users USING gin (full_name_en gin_trgm_ops);

-- ---------------------------------------------------------------------
-- Partition automation
--
-- Creates next month's partitions for every RANGE-partitioned table and
-- detaches partitions past their retention horizon. Scheduled nightly via
-- pg_cron (or an external cron calling this function).
-- ---------------------------------------------------------------------
CREATE TABLE partition_config (
  parent_table    text PRIMARY KEY,
  retention_months smallint NOT NULL,
  premake_months   smallint NOT NULL DEFAULT 3,
  archive_action   text NOT NULL DEFAULT 'detach'
                     CHECK (archive_action IN ('detach','drop','compress')),
  -- Storage parameters cannot be set on a partitioned parent; they are applied
  -- to each leaf partition at creation time by app.maintain_partitions().
  storage_params   text
);

INSERT INTO partition_config
  (parent_table, retention_months, premake_months, archive_action, storage_params) VALUES
  ('attendance_records', 24, 3, 'detach', NULL),   -- 5-year statutory; 24m hot, rest archived
  ('sms_outbox',          3, 2, 'drop',
     'autovacuum_vacuum_scale_factor = 0.02, autovacuum_analyze_scale_factor = 0.01'),
  ('ai_sessions',        12, 2, 'drop', NULL),     -- PDPA minimisation
  ('ai_turns',           12, 2, 'drop', NULL)
ON CONFLICT (parent_table) DO NOTHING;

CREATE OR REPLACE FUNCTION app.maintain_partitions(p_today date DEFAULT CURRENT_DATE)
RETURNS TABLE (action text, partition_name text)
LANGUAGE plpgsql AS $$
DECLARE
  cfg     RECORD;
  i       integer;
  p_start date;
  p_end   date;
  p_name  text;
  cutoff  date;
  part    RECORD;
BEGIN
  FOR cfg IN SELECT * FROM partition_config LOOP

    -- ── create forward partitions ────────────────────────────────────
    FOR i IN 0..cfg.premake_months LOOP
      p_start := date_trunc('month', p_today)::date + (i || ' months')::interval;
      p_end   := (p_start + interval '1 month')::date;
      p_name  := format('%s_%s', cfg.parent_table, to_char(p_start, 'YYYY_MM'));

      IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = p_name) THEN
        EXECUTE format(
          'CREATE TABLE %I PARTITION OF %I FOR VALUES FROM (%L) TO (%L)',
          p_name, cfg.parent_table, p_start, p_end);
        IF cfg.storage_params IS NOT NULL THEN
          EXECUTE format('ALTER TABLE %I SET (%s)', p_name, cfg.storage_params);
        END IF;
        action := 'created'; partition_name := p_name; RETURN NEXT;
      END IF;
    END LOOP;

    -- ── retire old partitions ────────────────────────────────────────
    cutoff := (date_trunc('month', p_today) - (cfg.retention_months || ' months')::interval)::date;

    FOR part IN
      SELECT c.relname
      FROM pg_class c
      JOIN pg_inherits inh ON inh.inhrelid = c.oid
      JOIN pg_class p ON p.oid = inh.inhparent
      WHERE p.relname = cfg.parent_table
        AND c.relname ~ '_\d{4}_\d{2}$'
        AND to_date(right(c.relname, 7), 'YYYY_MM') < cutoff
    LOOP
      IF cfg.archive_action = 'drop' THEN
        EXECUTE format('DROP TABLE %I', part.relname);
        action := 'dropped';
      ELSE
        EXECUTE format('ALTER TABLE %I DETACH PARTITION %I', cfg.parent_table, part.relname);
        EXECUTE format('ALTER TABLE %I SET SCHEMA archive', part.relname);
        action := 'archived';
      END IF;
      partition_name := part.relname; RETURN NEXT;
    END LOOP;

  END LOOP;
END $$;

COMMENT ON FUNCTION app.maintain_partitions IS
  'Run nightly. Pre-creates 3 months ahead so an insert never lands in the DEFAULT '
  'partition (which would silently degrade every pruned query plan).';

-- Alert if anything ever lands in a DEFAULT partition — that means the
-- maintenance job stopped running.
CREATE OR REPLACE VIEW v_default_partition_leakage AS
SELECT 'attendance_records' AS parent, count(*) FROM attendance_records_default
UNION ALL SELECT 'sms_outbox',   count(*) FROM sms_outbox_default
UNION ALL SELECT 'ai_sessions',  count(*) FROM ai_sessions_default
UNION ALL SELECT 'ai_turns',     count(*) FROM ai_turns_default;

-- ---------------------------------------------------------------------
-- Retention / erasure
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.purge_expired_data(p_today date DEFAULT CURRENT_DATE)
RETURNS TABLE (target text, rows_removed bigint)
LANGUAGE plpgsql AS $$
DECLARE n bigint;
BEGIN
  DELETE FROM sync_change_log WHERE changed_at < p_today - interval '30 days';
  GET DIAGNOSTICS n = ROW_COUNT; target := 'sync_change_log'; rows_removed := n; RETURN NEXT;

  DELETE FROM otp_challenges WHERE created_at < p_today - interval '7 days';
  GET DIAGNOSTICS n = ROW_COUNT; target := 'otp_challenges'; rows_removed := n; RETURN NEXT;

  DELETE FROM user_sessions WHERE expires_at < p_today - interval '30 days';
  GET DIAGNOSTICS n = ROW_COUNT; target := 'user_sessions'; rows_removed := n; RETURN NEXT;

  DELETE FROM event_outbox WHERE published_at < p_today - interval '14 days';
  GET DIAGNOSTICS n = ROW_COUNT; target := 'event_outbox'; rows_removed := n; RETURN NEXT;

  DELETE FROM sync_operations WHERE received_at < p_today - interval '90 days';
  GET DIAGNOSTICS n = ROW_COUNT; target := 'sync_operations'; rows_removed := n; RETURN NEXT;
END $$;

-- ---------------------------------------------------------------------
-- Dashboard materialised views. Refreshed CONCURRENTLY off-peak so the
-- Principal's morning dashboard is a single index scan, not a 40-way join.
-- ---------------------------------------------------------------------

-- Daily attendance rate per section.
CREATE MATERIALIZED VIEW mv_attendance_daily AS
SELECT
  ar.tenant_id,
  ar.section_id,
  ar.taken_on,
  count(*)                                             AS total,
  count(*) FILTER (WHERE ar.status = 'present')        AS present,
  count(*) FILTER (WHERE ar.status = 'absent')         AS absent,
  count(*) FILTER (WHERE ar.status = 'late')           AS late,
  round(100.0 * count(*) FILTER (WHERE ar.status IN ('present','late')) / NULLIF(count(*),0), 2)
                                                       AS attendance_rate
FROM attendance_records ar
WHERE ar.taken_on >= CURRENT_DATE - interval '180 days'
GROUP BY ar.tenant_id, ar.section_id, ar.taken_on;

CREATE UNIQUE INDEX uq_mv_att_daily ON mv_attendance_daily (tenant_id, section_id, taken_on);

-- Teacher weekly load — feeds the coordinator's heatmap and the solver's
-- fairness term.
CREATE MATERIALIZED VIEW mv_teacher_load AS
SELECT
  rs.tenant_id,
  rs.routine_id,
  rs.teacher_id,
  count(*)                                              AS periods_per_week,
  count(DISTINCT rs.day_of_week)                        AS teaching_days,
  count(DISTINCT rs.primary_section_id)                 AS sections,
  count(DISTINCT rs.subject_id)                         AS subjects,
  max(daily.cnt)                                        AS max_periods_in_a_day
FROM routine_slots rs
JOIN LATERAL (
  SELECT count(*) AS cnt FROM routine_slots x
  WHERE x.tenant_id = rs.tenant_id AND x.routine_id = rs.routine_id
    AND x.teacher_id = rs.teacher_id AND x.day_of_week = rs.day_of_week
    AND x.status = 'active'
) daily ON true
WHERE rs.status = 'active' AND rs.slot_kind = 'teaching' AND rs.teacher_id IS NOT NULL
GROUP BY rs.tenant_id, rs.routine_id, rs.teacher_id;

CREATE UNIQUE INDEX uq_mv_teacher_load ON mv_teacher_load (tenant_id, routine_id, teacher_id);

-- Fee collection summary — the Accountant's landing page.
CREATE MATERIALIZED VIEW mv_fee_collection AS
SELECT
  i.tenant_id,
  i.academic_year_id,
  i.billing_period,
  count(*)                                              AS invoice_count,
  sum(i.total_amount)                                   AS billed,
  sum(i.paid_amount)                                    AS collected,
  sum(i.total_amount - i.paid_amount)                   AS outstanding,
  count(*) FILTER (WHERE i.status = 'paid')             AS paid_count,
  count(*) FILTER (WHERE i.status = 'overdue')          AS overdue_count
FROM invoices i
WHERE i.status <> 'cancelled'
GROUP BY i.tenant_id, i.academic_year_id, i.billing_period;

CREATE UNIQUE INDEX uq_mv_fee_collection
  ON mv_fee_collection (tenant_id, academic_year_id, billing_period);

-- Syllabus completion — Principal's early-warning signal.
CREATE MATERIALIZED VIEW mv_syllabus_progress AS
SELECT
  d.tenant_id,
  rs.primary_section_id AS section_id,
  rs.subject_id,
  count(*) FILTER (WHERE d.was_held)                    AS classes_held,
  count(*)                                              AS classes_scheduled,
  count(DISTINCT d.chapter_no) FILTER (WHERE d.chapter_no IS NOT NULL) AS chapters_covered,
  max(d.delivered_on)                                   AS last_class_on
FROM class_delivery_log d
JOIN routine_slots rs ON rs.id = d.slot_id
GROUP BY d.tenant_id, rs.primary_section_id, rs.subject_id;

CREATE UNIQUE INDEX uq_mv_syllabus
  ON mv_syllabus_progress (tenant_id, section_id, subject_id);

CREATE OR REPLACE FUNCTION app.refresh_dashboards() RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  REFRESH MATERIALIZED VIEW CONCURRENTLY mv_attendance_daily;
  REFRESH MATERIALIZED VIEW CONCURRENTLY mv_teacher_load;
  REFRESH MATERIALIZED VIEW CONCURRENTLY mv_fee_collection;
  REFRESH MATERIALIZED VIEW CONCURRENTLY mv_syllabus_progress;
END $$;

-- ---------------------------------------------------------------------
-- Autovacuum tuning for the churn-heavy queue tables.
-- Defaults (20% of table) are far too lax when a table is 30M rows and
-- 99% of it is already-sent messages.
-- ---------------------------------------------------------------------
-- sms_outbox is partitioned, so its parameters live in partition_config above
-- and are applied per leaf partition. Existing partitions get them here.
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN
    SELECT c.relname
    FROM pg_class c
    JOIN pg_inherits i ON i.inhrelid = c.oid
    JOIN pg_class p ON p.oid = i.inhparent
    WHERE p.relname = 'sms_outbox' AND c.relkind = 'r'
  LOOP
    EXECUTE format('ALTER TABLE %I SET (autovacuum_vacuum_scale_factor = 0.02, '
                   'autovacuum_analyze_scale_factor = 0.01)', r.relname);
  END LOOP;
END $$;

ALTER TABLE event_outbox    SET (autovacuum_vacuum_scale_factor = 0.01,
                                 autovacuum_vacuum_cost_delay = 0);
ALTER TABLE sync_change_log SET (autovacuum_vacuum_scale_factor = 0.02);
ALTER TABLE routine_slots   SET (fillfactor = 85);   -- drag-drop editing does many HOT updates
ALTER TABLE invoices        SET (fillfactor = 90);

COMMIT;

-- =====================================================================
-- Scheduling (pg_cron, or external):
--   0 1 * * *  SELECT app.maintain_partitions();
--   0 2 * * *  SELECT app.purge_expired_data();
--   */15 * * * *  SELECT app.refresh_dashboards();
-- =====================================================================
