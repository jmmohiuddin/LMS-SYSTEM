-- Rollback for 071 — the deployment stops being able to say whether its
-- scheduled jobs are running.
--
-- Read what this restores. It destroys the run history (a small table of
-- timestamps, no tenant data) and, more importantly, it removes the only
-- alert condition that does not depend on activity. After this, a deployment
-- whose crons have stopped — no sends, no syncs, no logins — evaluates to an
-- empty alert list and reports itself healthy, which is the B-51 state.
--
-- Callers must be reverted with it: services/sms-svc/api/dispatch.ts,
-- services/ops-svc/api/maintenance.ts and services/ops-svc/api/monitor.ts all
-- call app.record_job_run(), and packages/server-core/src/monitor-signals.ts
-- reads app.job_run_status(). recordJobRun swallows its own errors, so the
-- endpoints will keep working — they will simply stop reporting.

BEGIN;

DROP FUNCTION IF EXISTS app.job_run_status();
DROP FUNCTION IF EXISTS app.record_job_run(text, boolean, text);
DROP TABLE IF EXISTS ops_job_runs;

COMMIT;
