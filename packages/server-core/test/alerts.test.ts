/**
 * R-8 §7 — the conditions that wake somebody up.
 *
 * Every threshold in alerts.ts is a judgement call, and the only thing that
 * makes a judgement call trustworthy is being able to see it fire and not
 * fire on either side of its boundary. That is most of this file.
 *
 * The second thing these tests hold is the property that makes an alerting
 * system usable at all: a quiet system stays quiet. An alert that fires on an
 * ordinary Tuesday is an alert that gets muted, and a muted alert is worse
 * than none — it is a dashboard nobody looks at, with extra steps.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  evaluateAlerts, alertWebhookUrl, alertText, THRESHOLDS,
  JOB_SILENCE_LIMIT_MINUTES,
  type MonitorSignals, type JobHeartbeat,
} from '../src/alerts.ts';

/**
 * Jobs that ran a few minutes ago.
 *
 * Every fixture here needs one, and the reason is the distinction P-ops
 * exists to draw: zero BUSINESS activity is a quiet school and must stay
 * silent, while zero JOB activity is a deployment whose schedules were never
 * installed and must page. The two used to be the same "empty" state.
 */
const jobsRunning = (): JobHeartbeat[] =>
  Object.keys(JOB_SILENCE_LIMIT_MINUTES).map((name) => ({
    name, minutesSinceSuccess: 5, consecutiveFailures: 0, lastError: null,
  }));

/** A healthy, busy deployment: several schools, messages flowing, nothing wrong. */
function healthy(over: Partial<MonitorSignals> = {}): MonitorSignals {
  return {
    databaseReachable: true,
    smsQueuedNow: 40, smsQueuedOldestMinutes: 12,
    smsFailedRecent: 3, smsSentRecent: 900,
    partitionMonthsAhead: 3,
    pushDevices: 60, pushFailingDevices: 2,
    syncRejectedRecent: 1, syncAppliedRecent: 800,
    otpIssuedRecent: 120, otpExhaustedRecent: 4, otpExhaustedPhones: 4,
    jobs: jobsRunning(),
    ...over,
  };
}

const ids = (s: MonitorSignals): string[] => evaluateAlerts(s).map((a) => a.id);

describe('R-8 §7 — silence when there is nothing to say', () => {
  test('THE ONE THAT MATTERS — a busy healthy day fires nothing', () => {
    assert.deepEqual(evaluateAlerts(healthy()), []);
  });

  test('an empty deployment fires nothing either', () => {
    // Before the first pilot every count is zero, and zeroes must not be
    // mistaken for failure — otherwise the alerting is broken on day one and
    // gets switched off before it has ever been useful.
    assert.deepEqual(evaluateAlerts({
      databaseReachable: true,
      smsQueuedNow: 0, smsQueuedOldestMinutes: null,
      smsFailedRecent: 0, smsSentRecent: 0,
      partitionMonthsAhead: 3,
      // The schedules ARE running — this test is about a school with nothing
      // to do, not a deployment with nothing watching it.
      jobs: jobsRunning(),
      pushDevices: 0, pushFailingDevices: 0,
      syncRejectedRecent: 0, syncAppliedRecent: 0,
      otpIssuedRecent: 0, otpExhaustedRecent: 0, otpExhaustedPhones: 0,
    }), []);
  });

  test('a brand-new database with no partitions yet is not an alert', () => {
    // partitionMonthsAhead is null when the catalogue query finds nothing —
    // a fresh schema, or a test database. Null is "unknown", not "zero".
    assert.deepEqual(ids(healthy({ partitionMonthsAhead: null })), []);
  });
});

describe('R-8 §7 — the database being gone', () => {
  test('it is the only alert sent, since nothing else is knowable', () => {
    const alerts = evaluateAlerts(healthy({ databaseReachable: false }));
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0].id, 'database_unavailable');
    assert.equal(alerts[0].severity, 'critical');
  });

  test('its recovery text tells the operator what to say to schools', () => {
    // The genuinely useful fact during an outage is that attendance keeps
    // working offline and nothing is lost. An engineer at 9pm should not have
    // to remember that.
    const a = evaluateAlerts(healthy({ databaseReachable: false }))[0];
    assert.match(a.recover, /offline/);
  });
});

describe('R-8 §7 — a queue that stopped draining', () => {
  test('a queue with a recent head is normal; the dispatcher runs daily', () => {
    assert.deepEqual(ids(healthy({ smsQueuedNow: 400, smsQueuedOldestMinutes: 30 })), []);
  });

  test('boundary — it fires at the threshold, not before', () => {
    const at = THRESHOLDS.smsQueueStalledMinutes;
    assert.deepEqual(ids(healthy({ smsQueuedNow: 5, smsQueuedOldestMinutes: at - 1 })), []);
    assert.deepEqual(ids(healthy({ smsQueuedNow: 5, smsQueuedOldestMinutes: at })),
      ['sms_queue_stalled']);
  });

  test('an empty queue cannot be stalled however old the reading', () => {
    assert.deepEqual(ids(healthy({ smsQueuedNow: 0, smsQueuedOldestMinutes: 9999 })), []);
  });
});

describe('R-8 §7 — sending that is failing', () => {
  test('a handful of failures among many sends is not a signal', () => {
    assert.deepEqual(ids(healthy({ smsFailedRecent: 9, smsSentRecent: 20 })), []);
  });

  test('boundary — the floor keeps small numbers from producing big ratios', () => {
    // 1 failure of 2 is 50%, and alerting on it would page somebody for a
    // wrong phone number. The floor is what makes the ratio meaningful.
    assert.deepEqual(ids(healthy({ smsFailedRecent: 1, smsSentRecent: 1 })), []);
    assert.deepEqual(ids(healthy({
      smsFailedRecent: THRESHOLDS.smsFailureFloor, smsSentRecent: 10,
    })), ['sms_failure_rate']);
  });

  test('it escalates from warning to critical as the ratio grows', () => {
    const warn = evaluateAlerts(healthy({ smsFailedRecent: 40, smsSentRecent: 100 }));
    assert.equal(warn[0].severity, 'warning');
    const crit = evaluateAlerts(healthy({ smsFailedRecent: 80, smsSentRecent: 20 }));
    assert.equal(crit[0].severity, 'critical');
  });

  test('the title carries the number, so a phone notification is enough', () => {
    const a = evaluateAlerts(healthy({ smsFailedRecent: 50, smsSentRecent: 50 }))[0];
    assert.match(a.title, /50%/);
  });
});

describe('R-8 §7 — the deadline nobody sees coming', () => {
  test('boundary — one month ahead is fine, zero is critical', () => {
    assert.deepEqual(ids(healthy({ partitionMonthsAhead: 1 })), []);
    const a = evaluateAlerts(healthy({ partitionMonthsAhead: 0 }));
    assert.equal(a[0].id, 'maintenance_cron_stopped');
    assert.equal(a[0].severity, 'critical');
  });

  test('a negative reading — already overdue — also fires', () => {
    assert.ok(ids(healthy({ partitionMonthsAhead: -1 })).includes('maintenance_cron_stopped'));
  });

  test('the recovery text says why it cannot wait until morning', () => {
    const a = evaluateAlerts(healthy({ partitionMonthsAhead: 0 }))[0];
    assert.match(a.recover, /every attendance and SMS write fails/);
  });
});

describe('R-8 §7 — push, which is allowed to fail', () => {
  test('it warns rather than pages, because SMS is underneath it', () => {
    const a = evaluateAlerts(healthy({ pushDevices: 40, pushFailingDevices: 30 }));
    assert.equal(a[0].id, 'push_failure_rate');
    assert.equal(a[0].severity, 'warning');
  });

  test('boundary — a small fleet is not judged by ratio', () => {
    assert.deepEqual(ids(healthy({
      pushDevices: THRESHOLDS.pushDeviceFloor - 1, pushFailingDevices: 4,
    })), []);
  });

  test('it names the cause that actually produces near-total failure', () => {
    const a = evaluateAlerts(healthy({ pushDevices: 50, pushFailingDevices: 49 }))[0];
    assert.match(a.investigate, /VAPID/);
  });
});

describe('R-8 §7 — attendance a teacher believes they saved', () => {
  test('boundary — it fires above floor and ratio together', () => {
    assert.deepEqual(ids(healthy({ syncRejectedRecent: 9, syncAppliedRecent: 10 })), []);
    assert.ok(ids(healthy({ syncRejectedRecent: 30, syncAppliedRecent: 100 }))
      .includes('sync_rejection_rate'));
  });

  test('it is critical, and it names the R-7 bug it exists to catch', () => {
    const a = evaluateAlerts(healthy({ syncRejectedRecent: 50, syncAppliedRecent: 10 }))[0];
    assert.equal(a.severity, 'critical');
    assert.match(a.investigate, /academic year id/);
    // The outbox holds the operations, so a server-side fix recovers them —
    // the difference between an evening's work and forty registers re-entered.
    assert.match(a.recover, /outbox/);
  });
});

describe('R-8 §7 — login codes being burned', () => {
  test('an ordinary Monday of mistyped codes is not an alert', () => {
    assert.deepEqual(ids(healthy({ otpIssuedRecent: 300, otpExhaustedRecent: 25,
      otpExhaustedPhones: 25 })), []);
  });

  test('THE ONE THAT MATTERS — it reports phones separately from challenges', () => {
    // Many exhausted challenges across few phones is somebody guessing;
    // across many phones it is an SMS delivery failure. Same count, opposite
    // response — so the alert must carry both numbers, not just the total.
    const a = evaluateAlerts(healthy({
      otpIssuedRecent: 100, otpExhaustedRecent: 60, otpExhaustedPhones: 2,
    }))[0];
    assert.equal(a.id, 'auth_anomaly');
    assert.match(a.detail, /60 challenges/);
    assert.match(a.detail, /2 phone/);
    assert.match(a.investigate, /FEW phones/);
  });
});

describe('R-8 §7 — ordering and delivery', () => {
  test('critical alerts sort ahead of warnings', () => {
    const a = evaluateAlerts(healthy({
      partitionMonthsAhead: 0,                                   // critical
      pushDevices: 50, pushFailingDevices: 49,                   // warning
      smsQueuedNow: 10, smsQueuedOldestMinutes: 600,             // critical
    }));
    const severities = a.map((x) => x.severity);
    assert.deepEqual(severities, [...severities].sort());
    assert.equal(a[a.length - 1].severity, 'warning');
  });

  test('the webhook must be https, or it is treated as unset', () => {
    assert.equal(alertWebhookUrl({} as NodeJS.ProcessEnv), null);
    assert.equal(alertWebhookUrl({ ALERT_WEBHOOK_URL: '  ' } as NodeJS.ProcessEnv), null);
    // An alert body names schools and counts. Posting it in the clear is a
    // needless disclosure, so a http:// URL is refused rather than downgraded.
    assert.equal(alertWebhookUrl({ ALERT_WEBHOOK_URL: 'http://hooks.example/x' } as NodeJS.ProcessEnv), null);
    assert.equal(alertWebhookUrl({ ALERT_WEBHOOK_URL: 'https://hooks.example/x' } as NodeJS.ProcessEnv),
      'https://hooks.example/x');
  });

  test('the text names the environment, so staging cannot be mistaken for live', () => {
    const a = evaluateAlerts(healthy({ partitionMonthsAhead: 0 }));
    assert.match(alertText(a, 'production'), /shikhonBD production/);
    assert.match(alertText([], 'staging'), /staging: all clear/);
  });

  test('D11 — the platform brand appears on the platform surface', () => {
    assert.match(alertText([], 'production'), /shikhonBD/);
  });
});

/**
 * P-ops — the alert that fires when nothing is happening.
 *
 * Every condition above this block measures a proportion of activity, so the
 * deployment B-51 describes — crons dead, no sends, no syncs, no logins —
 * evaluated to an empty list and reported itself healthy. These are the
 * conditions whose trigger is ABSENCE, and the distinction they have to hold
 * is between a quiet school (silence is correct) and an unwatched deployment
 * (silence is the bug).
 */
describe('P-ops §2 — a job that stopped is louder than a school that is quiet', () => {
  const withJobs = (jobs: JobHeartbeat[]): MonitorSignals => ({
    databaseReachable: true,
    smsQueuedNow: 0, smsQueuedOldestMinutes: null,
    smsFailedRecent: 0, smsSentRecent: 0,
    partitionMonthsAhead: 3,
    pushDevices: 0, pushFailingDevices: 0,
    syncRejectedRecent: 0, syncAppliedRecent: 0,
    otpIssuedRecent: 0, otpExhaustedRecent: 0, otpExhaustedPhones: 0,
    jobs,
  });

  test('THE ONE THAT MATTERS — a totally idle deployment with dead crons alerts', () => {
    // Zero of everything. Before P-ops this returned [].
    const fired = evaluateAlerts(withJobs(
      Object.keys(JOB_SILENCE_LIMIT_MINUTES).map((name) => ({
        name, minutesSinceSuccess: null, consecutiveFailures: 0, lastError: null,
      }))));
    assert.equal(fired.length, 3, 'one per job that has never run');
    assert.ok(fired.every((a) => a.id === 'job_never_ran'));
    assert.ok(fired.every((a) => a.severity === 'critical'));
  });

  test('and the same deployment with its schedules running is silent', () => {
    // The distinction that matters: nothing to do is not the same as nothing
    // watching. This is the case the older "an empty deployment" test pins.
    assert.deepEqual(evaluateAlerts(withJobs(
      Object.keys(JOB_SILENCE_LIMIT_MINUTES).map((name) => ({
        name, minutesSinceSuccess: 5, consecutiveFailures: 0, lastError: null,
      })))), []);
  });

  test('a job late past its OWN interval fires, and one inside it does not', () => {
    // Per-job limits, not one global number: the dispatcher runs daily and
    // the monitor every fifteen minutes, so a single threshold would either
    // page on a healthy dispatcher or miss a dead monitor for a day.
    const late = evaluateAlerts(withJobs([
      { name: 'monitor', minutesSinceSuccess: 120, consecutiveFailures: 0, lastError: null },
      { name: 'sms_dispatch', minutesSinceSuccess: 120, consecutiveFailures: 0, lastError: null },
    ]));
    assert.deepEqual(late.map((a) => a.id), ['job_silent']);
    assert.match(late[0].title, /monitor/, 'the monitor is late at 2h; the dispatcher is not');
  });

  test('a job that runs and fails is a different alert from one that is silent', () => {
    const failing = evaluateAlerts(withJobs([
      { name: 'sms_dispatch', minutesSinceSuccess: 10, consecutiveFailures: 4,
        lastError: 'aggregator refused: balance' },
    ]));
    assert.deepEqual(failing.map((a) => a.id), ['job_failing']);
    assert.match(failing[0].detail, /balance/, 'the recorded error must reach the operator');
  });

  test('two consecutive failures are not yet an alert — a retry is normal', () => {
    assert.deepEqual(evaluateAlerts(withJobs([
      { name: 'sms_dispatch', minutesSinceSuccess: 10, consecutiveFailures: 2, lastError: 'timeout' },
    ])), []);
  });

  test('an unknown job name is ignored rather than alerting on itself', () => {
    // A name outside the expected set has no interval to be late against, and
    // inventing one would page an operator about a job nobody scheduled.
    assert.deepEqual(evaluateAlerts(withJobs([
      { name: 'something_else', minutesSinceSuccess: null, consecutiveFailures: 9, lastError: null },
    ])), []);
  });
});
