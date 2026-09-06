/**
 * P-ops §3 — the deadman, through the database rather than around it.
 *
 * `alerts.test.ts` pins `evaluateAlerts` as a pure function: given a
 * `JobHeartbeat[]`, which alerts fire. That is the right shape for the rules
 * and it proves nothing about the loop the rules sit in. Between the rule and
 * the operator there are three more links — `app.record_job_run` writing what
 * happened, `app.job_run_status()` reading it back, and `gatherSignals`
 * turning that into the array the rules consume — and a break in any of them
 * produces exactly the failure this whole section exists to prevent: a
 * deployment that is not running and an alert list that is empty.
 *
 * So this file writes real rows as the real jobs do, reads them back the way
 * the monitor does, and asserts on the alerts that come out the far end.
 *
 * ── Business silence is not job silence ────────────────────────────────────
 * The distinction the section turns on, and the one that made five of seven
 * alerts unable to fire on a total outage (B-51).
 *
 *   BUSINESS SILENCE — a school sent no SMS today, no attendance was taken,
 *   nobody logged in. Legitimate. It is a holiday, or a small school, or a
 *   quiet week. The correct number of alerts is ZERO, and every ratio-shaped
 *   condition correctly says nothing.
 *
 *   JOB SILENCE — the dispatcher did not run. The monitor did not run. The
 *   maintenance job did not run. NOT legitimate, and indistinguishable from
 *   business silence by any ratio, because the producer of the rows a ratio
 *   would read is the very thing that stopped. `sms_queue_stalled` needs
 *   `smsQueuedNow > 0`, and the only writer of those rows is the worker that
 *   is dead.
 *
 * Job silence is therefore measured against the CLOCK and against each job's
 * own schedule, never against volume. That is what these tests hold.
 *
 *   DATABASE_MAINTENANCE_URL=postgres://shikhon_owner:… \
 *     node --test packages/server-core/test/deadman.test.ts
 */
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';

import { evaluateAlerts, JOB_SILENCE_LIMIT_MINUTES, type MonitorSignals } from '../src/alerts.ts';
import { recordJobRun, type JobName } from '../src/job-runs.ts';

/**
 * The owner connection. `ops_job_runs` is REVOKEd from `shikhon_app` and
 * `shikhon_readonly` (migration 071), and that revocation is part of what is
 * under test below — a suite that could reach the table as the runtime role
 * would be proving the opposite of what it claims.
 */
const OWNER_URL = process.env.DATABASE_MAINTENANCE_URL;
const APP_URL = process.env.DATABASE_URL;
const skip = !OWNER_URL ? 'DATABASE_MAINTENANCE_URL not set' : false;

let owner: pg.Client;

/**
 * The three jobs `app.record_job_run` will accept. Anything else raises.
 *
 * Derived from the limits table rather than written out again, so a fourth
 * job added there is covered here without anyone remembering to add it.
 */
const JOBS = Object.keys(JOB_SILENCE_LIMIT_MINUTES) as JobName[];

/** Signals with nothing happening anywhere — total business silence. */
const idle = (jobs: MonitorSignals['jobs']): MonitorSignals => ({
  databaseReachable: true,
  smsQueuedNow: 0, smsQueuedOldestMinutes: null,
  smsFailedRecent: 0, smsSentRecent: 0,
  partitionMonthsAhead: 3,
  pushDevices: 0, pushFailingDevices: 0,
  syncRejectedRecent: 0, syncAppliedRecent: 0,
  otpIssuedRecent: 0, otpExhaustedRecent: 0, otpExhaustedPhones: 0,
  jobs,
});

/** Read the heartbeat exactly as `gatherSignals` does. */
async function readJobs(): Promise<MonitorSignals['jobs']> {
  const { rows } = await owner.query<{
    job_name: string; minutes_since_success: string | null;
    consecutive_failures: number; last_error: string | null;
  }>('SELECT * FROM app.job_run_status()');
  const seen = new Map(rows.map((r) => [r.job_name, r]));
  return JOBS.map((name) => {
    const r = seen.get(name);
    return {
      name,
      minutesSinceSuccess: r?.minutes_since_success == null ? null
        : Number(r.minutes_since_success),
      consecutiveFailures: r?.consecutive_failures ?? 0,
      lastError: r?.last_error ?? null,
    };
  });
}

/** Backdate a job's last success, to age it without waiting. */
const ageSuccess = (job: string, minutes: number) => owner.query(
  `UPDATE ops_job_runs SET last_succeeded_at = now() - ($2 || ' minutes')::interval
    WHERE job_name = $1`, [job, String(minutes)]);

describe('P-ops §3 — a schedule that stopped, end to end', { skip }, () => {
  before(async () => {
    owner = new pg.Client({ connectionString: OWNER_URL });
    await owner.connect();
  });

  after(async () => {
    if (!owner) return;
    // Leave the table as found: empty is the honest state for a dev database
    // whose jobs are not scheduled, and it is what `job_never_ran` reports.
    await owner.query('DELETE FROM ops_job_runs');
    await owner.end();
  });

  beforeEach(() => owner.query('DELETE FROM ops_job_runs'));

  test('THE ONE THAT MATTERS — nothing has ever run, and the deployment says so', async () => {
    // No rows at all. This is a freshly deployed host whose timers were never
    // installed, which is precisely the state B-50 found in production.
    const fired = evaluateAlerts(idle(await readJobs()));

    assert.equal(fired.length, JOBS.length, 'one per job that has never run');
    assert.ok(fired.every((a) => a.id === 'job_never_ran'));
    assert.ok(fired.every((a) => a.severity === 'critical'));
  });

  test('business silence with the schedules alive is NOT an alert', async () => {
    // Identical signals to the test above in every business dimension —
    // zero SMS, zero syncs, zero logins, zero devices. The ONLY difference
    // is that the jobs ran. A holiday must not page anyone.
    for (const job of JOBS) await recordJobRun(OWNER_URL as string, job, true);

    assert.deepEqual(evaluateAlerts(idle(await readJobs())), [],
      'a quiet school is not a broken deployment');
  });

  test('a stale heartbeat is caught against the job’s OWN interval', async () => {
    for (const job of JOBS) await recordJobRun(OWNER_URL as string, job, true);
    // Two hours: past the monitor's 90-minute limit, nowhere near the daily
    // jobs' 26 hours. One global threshold would either page on a healthy
    // dispatcher every night or miss a dead monitor for a day.
    await ageSuccess('monitor', 120);

    const fired = evaluateAlerts(idle(await readJobs()));
    assert.deepEqual(fired.map((a) => a.id), ['job_silent']);
    assert.match(fired[0].title, /monitor/);
  });

  test('a job that runs and FAILS is visible, and says why', async () => {
    for (const job of JOBS) await recordJobRun(OWNER_URL as string, job, true);
    for (let i = 0; i < 3; i++) {
      await recordJobRun(OWNER_URL as string, 'sms_dispatch', false, 'aggregator refused: balance');
    }

    const fired = evaluateAlerts(idle(await readJobs()));
    assert.deepEqual(fired.map((a) => a.id), ['job_failing']);
    assert.match(fired[0].detail, /balance/,
      'the recorded error is the first thing an operator reads');
  });

  test('…and RECOVERY clears it — the counter resets on the next success', async () => {
    // The half that is easy to leave untested and that decides whether an
    // operator trusts the alert at all. An alert that never clears is one
    // people learn to ignore, and then the real one is ignored too.
    for (const job of JOBS) await recordJobRun(OWNER_URL as string, job, true);
    for (let i = 0; i < 4; i++) {
      await recordJobRun(OWNER_URL as string, 'sms_dispatch', false, 'timeout');
    }
    assert.equal(evaluateAlerts(idle(await readJobs())).length, 1, 'it must fire first');

    await recordJobRun(OWNER_URL as string, 'sms_dispatch', true);

    const after = evaluateAlerts(idle(await readJobs()));
    assert.deepEqual(after, [], 'a fixed job must stop paging without anyone editing a row');
    const { rows } = await owner.query<{ consecutive_failures: number; last_error: string | null }>(
      `SELECT consecutive_failures, last_error FROM ops_job_runs WHERE job_name = 'sms_dispatch'`);
    assert.equal(rows[0].consecutive_failures, 0);
    assert.equal(rows[0].last_error, null, 'a stale error message outlives its problem');
  });

  test('one dead job does not hide behind two healthy ones', async () => {
    for (const job of JOBS) await recordJobRun(OWNER_URL as string, job, true);
    await ageSuccess('sms_dispatch', 27 * 60);

    const fired = evaluateAlerts(idle(await readJobs()));
    assert.equal(fired.length, 1);
    assert.match(fired[0].title, /sms_dispatch/);
  });

  test('recording is never allowed to take down the job it is recording', async () => {
    // `recordJobRun` swallows everything by design: a heartbeat that throws
    // would turn a bookkeeping failure into a failed dispatch run, which is
    // the opposite of the point. An unknown name raises inside the function
    // (check_violation) and must not surface here.
    await recordJobRun(OWNER_URL as string, 'not_a_real_job' as JobName, true);
    await recordJobRun('postgres://nobody@127.0.0.1:1/nothing', 'monitor', true);

    const { rows } = await owner.query('SELECT count(*)::int AS n FROM ops_job_runs');
    assert.equal(rows[0].n, 0, 'a rejected name must not leave a row either');
  });

  test('the runtime role cannot forge a heartbeat', { skip: !APP_URL }, async () => {
    // The alert's credibility rests on this. If `shikhon_app` could write
    // `ops_job_runs`, any tenant-facing request path could silence the
    // deadman — and migration 010's blanket GRANT plus default privileges
    // would have handed it exactly that if 071 had not REVOKEd by name.
    const app = new pg.Client({ connectionString: APP_URL as string });
    await app.connect();
    try {
      await assert.rejects(
        () => app.query(`INSERT INTO ops_job_runs (job_name) VALUES ('monitor')`),
        /permission denied/i);
      await assert.rejects(
        () => app.query('SELECT * FROM ops_job_runs'),
        /permission denied/i);
    } finally {
      await app.end();
    }
  });

  test('the monitor cannot report its own death — and that is stated, not hidden', async () => {
    // The structural limit of every in-process deadman, asserted so it cannot
    // be quietly forgotten: `job_silent` for the monitor is only ever
    // EVALUATED by the monitor. If the monitor is the thing that stopped,
    // nothing runs this code, and the alert that would name it is never
    // computed.
    //
    // What it does buy: the gap is recorded and fires the moment the monitor
    // comes back, so an outage is never silently swallowed after the fact.
    await recordJobRun(OWNER_URL as string, 'monitor', true);
    for (const job of JOBS.filter((j) => j !== 'monitor')) {
      await recordJobRun(OWNER_URL as string, job, true);
    }
    await ageSuccess('monitor', 48 * 60);

    const onReturn = evaluateAlerts(idle(await readJobs()));
    assert.deepEqual(onReturn.map((a) => a.id), ['job_silent']);
    assert.match(onReturn[0].title, /monitor/,
      'a monitor that was away for two days must say so on its first run back');

    // The part no code here can do: catching it DURING the outage needs a
    // check outside this process. `deploy/shikhon-cron.md` §"What still is
    // not covered" and the runbook both say so, and this test exists to keep
    // that sentence true rather than to simulate a satisfied one.
  });
});
