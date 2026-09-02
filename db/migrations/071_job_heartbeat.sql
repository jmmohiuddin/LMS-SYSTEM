-- 071 — the deployment can now say whether its scheduled jobs are running
--
-- ── The gap this closes (B-50, B-51) ────────────────────────────────────
--
-- Seven alert conditions exist and five of them are ratios or floors:
-- `sms_failure_rate` needs at least ten attempts, `sms_queue_stalled` needs
-- `smsQueuedNow > 0`, `push_failure_rate` needs five devices,
-- `sync_rejection_rate` needs ten ops, `auth_anomaly` needs exhausted
-- challenges. Every one of them measures a PROPORTION OF ACTIVITY, so a
-- deployment where nothing is happening — the crons dead, no sends, no
-- syncs, no logins — evaluates to an empty alert list and reports itself
-- healthy.
--
-- Of the two that are not ratios, `database_unavailable` fires only when the
-- database is actually down, and `maintenance_cron_stopped` reads
-- `partitionMonthsAhead < 1` — a real signal, but one that degrades over
-- MONTHS. A dispatcher that stopped on Tuesday is invisible until the
-- partition runway runs out.
--
-- Nothing anywhere recorded that a scheduled job had run. `grep` for a job,
-- run, cron or heartbeat table returns nothing, and `ops/maintenance` writes
-- no record of its own execution. So "did the cron fire last night?" was not
-- a question the system could answer about itself.
--
-- This table is that answer, and it makes the missing alert possible: one
-- whose condition is ABSENCE rather than a proportion. A job that has not
-- reported success within its own expected interval fires, and it fires
-- harder the longer the silence — no floor to clear, no ratio to exceed, and
-- nothing to do with how busy the deployment is.
--
-- ── Why a function rather than a table grant ────────────────────────────
--
-- The row is deployment-wide and carries no tenant, so `tenant_isolation`
-- cannot scope it and RLS has nothing to key on. Granting `shikhon_app`
-- direct INSERT would let any signed-in user of any school write a false
-- success and silence the heartbeat — which is a worse hole than the one
-- being closed.
--
-- So the table is owner-only and the two functions below are SECURITY
-- DEFINER, the same device `app.platform_tenants()` uses for exactly this
-- reason (migration 053's header says so). `record_job_run` accepts only a
-- job name from a fixed list and cannot be used to write anything else;
-- `job_run_status` is read-only.
--
-- Rollback: db/rollback/071_job_heartbeat.sql.

BEGIN;

CREATE TABLE IF NOT EXISTS ops_job_runs (
  job_name              text PRIMARY KEY,
  last_started_at       timestamptz,
  last_succeeded_at     timestamptz,
  last_failed_at        timestamptz,
  last_error            text,
  consecutive_failures  integer NOT NULL DEFAULT 0,
  run_count             bigint  NOT NULL DEFAULT 0,
  updated_at            timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE ops_job_runs IS
  'One row per scheduled job, deployment-wide. Written only through '
  'app.record_job_run(); the heartbeat alert reads the gap between now and '
  'last_succeeded_at. Deliberately has no tenant_id — a cron serves the whole '
  'deployment, and a per-tenant row could not answer "did the job run".';

-- The jobs this deployment expects to see. A name outside this list is
-- refused rather than silently creating a row nobody watches — an alert that
-- can be disabled by a typo in a caller is not an alert.
CREATE OR REPLACE FUNCTION app.record_job_run(
  p_job text, p_ok boolean, p_error text DEFAULT NULL
) RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = public, app, pg_temp
AS $function$
BEGIN
  IF p_job NOT IN ('sms_dispatch', 'maintenance', 'monitor') THEN
    RAISE EXCEPTION 'unknown job %', p_job USING ERRCODE = 'check_violation';
  END IF;

  INSERT INTO ops_job_runs AS j (job_name, last_started_at, last_succeeded_at,
                                 last_failed_at, last_error,
                                 consecutive_failures, run_count, updated_at)
  VALUES (p_job, now(),
          CASE WHEN p_ok THEN now() END,
          CASE WHEN p_ok THEN NULL ELSE now() END,
          CASE WHEN p_ok THEN NULL ELSE left(p_error, 500) END,
          CASE WHEN p_ok THEN 0 ELSE 1 END,
          1, now())
  ON CONFLICT (job_name) DO UPDATE SET
    last_started_at      = now(),
    last_succeeded_at    = CASE WHEN p_ok THEN now() ELSE j.last_succeeded_at END,
    last_failed_at       = CASE WHEN p_ok THEN j.last_failed_at ELSE now() END,
    last_error           = CASE WHEN p_ok THEN NULL ELSE left(p_error, 500) END,
    -- Reset on success, climb on failure. Two conditions read this: a job
    -- that is failing repeatedly is a different problem from one that is
    -- silent, and an operator needs to tell them apart.
    consecutive_failures = CASE WHEN p_ok THEN 0 ELSE j.consecutive_failures + 1 END,
    run_count            = j.run_count + 1,
    updated_at           = now();
END $function$;

COMMENT ON FUNCTION app.record_job_run(text, boolean, text) IS
  'Records one scheduled-job execution. SECURITY DEFINER because ops_job_runs '
  'is owner-only: a direct grant would let any signed-in user write a false '
  'success and silence the heartbeat.';

CREATE OR REPLACE FUNCTION app.job_run_status()
 RETURNS TABLE (
   job_name text,
   minutes_since_success numeric,
   consecutive_failures integer,
   last_error text,
   run_count bigint
 )
 LANGUAGE sql
 STABLE
 SECURITY DEFINER
 SET search_path = public, app, pg_temp
AS $function$
  SELECT j.job_name,
         CASE WHEN j.last_succeeded_at IS NULL THEN NULL
              ELSE round(EXTRACT(epoch FROM (now() - j.last_succeeded_at)) / 60.0, 1)
         END,
         j.consecutive_failures,
         j.last_error,
         j.run_count
    FROM ops_job_runs j
   ORDER BY j.job_name;
$function$;

COMMENT ON FUNCTION app.job_run_status() IS
  'What the monitor reads. A job with no row at all is as much a finding as '
  'one that is late — the caller treats an absent job as never having run.';

-- REVOKE from the role BY NAME, not just PUBLIC. Migration 010 issues
-- `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO
-- shikhon_app`, and the default privileges carry that to every table created
-- afterwards — so a new table arrives writable by every signed-in user and
-- `REVOKE ... FROM PUBLIC` does not touch it. Every other table in this schema
-- is saved by RLS; this one has no tenant to key a policy on, so the grant
-- itself has to go. Verified: before this line a direct INSERT as shikhon_app
-- succeeded.
REVOKE ALL ON ops_job_runs FROM PUBLIC;
REVOKE ALL ON ops_job_runs FROM shikhon_app;
REVOKE ALL ON ops_job_runs FROM shikhon_readonly;
GRANT EXECUTE ON FUNCTION app.record_job_run(text, boolean, text)
  TO shikhon_app, shikhon_platform;
GRANT EXECUTE ON FUNCTION app.job_run_status()
  TO shikhon_app, shikhon_platform;

COMMIT;
