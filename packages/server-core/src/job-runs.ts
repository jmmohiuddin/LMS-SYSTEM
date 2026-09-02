/**
 * Record that a scheduled job ran.  (P-ops, migration 071)
 *
 * Nothing in this deployment used to record that a cron had fired, so "did
 * the dispatcher run last night?" was a question the system could not answer
 * about itself — and every alert condition was a proportion of activity, so a
 * deployment whose schedules had simply stopped reported itself healthy.
 *
 * Writes go through `app.record_job_run`, a SECURITY DEFINER function, because
 * `ops_job_runs` is owner-only: migration 010 grants shikhon_app every table
 * in the schema, and a table with no tenant column cannot be saved by RLS, so
 * a direct grant would let any signed-in user write a false success and
 * silence the heartbeat.
 *
 * It never throws. A job whose work succeeded must not be reported as failed
 * because the bookkeeping did — the alert exists to describe the job, not to
 * become a new way for it to fail.
 */
import pg from 'pg';

export type JobName = 'sms_dispatch' | 'maintenance' | 'monitor';

export async function recordJobRun(
  connectionString: string | undefined,
  job: JobName,
  ok: boolean,
  error?: unknown,
): Promise<void> {
  if (!connectionString) return;
  const client = new pg.Client({ connectionString, statement_timeout: 5_000 });
  try {
    await client.connect();
    await client.query('SELECT app.record_job_run($1, $2, $3)', [
      job, ok, error === undefined ? null : String(
        (error as { message?: string })?.message ?? error).slice(0, 500),
    ]);
  } catch (err) {
    console.error('[ops] could not record job run', job, err);
  } finally {
    await client.end().catch(() => {});
  }
}
