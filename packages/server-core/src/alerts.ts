/**
 * Operational alerting.  (R-8 §7)
 *
 * The R-8 report's most uncomfortable line was that a stopped cron would
 * silence a school with nobody noticing. The console gained a health panel,
 * but a panel is a thing somebody has to look at, and at 9pm on a Thursday
 * nobody is looking. This module is the other half: conditions that are
 * evaluated on a schedule and pushed OUT to a human.
 *
 * ── Why the evaluation is pure ──────────────────────────────────────────
 * Every threshold here is a judgement call — "how many failed sends is too
 * many" has no correct answer, only a defensible one — and judgement calls
 * that live inside a database query are judgement calls nobody can test. So
 * the endpoint gathers plain numbers and this function decides. Every
 * threshold below can be exercised at its boundary by a test that needs no
 * database at all, which is the only reason to trust them.
 *
 * ── Silence is the failure mode ─────────────────────────────────────────
 * Note what most of these conditions are watching for: not errors, but the
 * ABSENCE of expected work. A queue that stops draining, a partition that
 * stops being pre-created, attendance that stops landing. Loud failures look
 * after themselves — somebody rings. The dangerous ones are the quiet ones,
 * where every screen is green and the messages simply stopped, and those are
 * invisible to anything that only counts errors.
 *
 * ── What this cannot see ────────────────────────────────────────────────
 * API failure rate. There is no table of HTTP responses and inventing one
 * would duplicate what the host already records for every invocation. That
 * alert belongs in the host's own metric alerting, wired as documented in
 * docs/12-PRODUCTION-RUNBOOK.md §7; this module reports what the DATABASE can
 * see and does not pretend otherwise. Claiming coverage we do not have would
 * be worse than the gap.
 */

export type Severity = 'critical' | 'warning';

export interface Alert {
  /** Stable id — an alerting sink deduplicates on this. */
  id: string;
  severity: Severity;
  /** One line a woken engineer reads first. */
  title: string;
  /** The numbers that fired it. */
  detail: string;
  /** Where to look. */
  investigate: string;
  /** What to do about it. */
  recover: string;
}

/**
 * Everything the conditions below are allowed to know. Gathered by
 * services/ops-svc/api/monitor.ts; `now` is injected so tests are
 * deterministic and so a clock skew cannot make an alert un-reproducible.
 */
export interface MonitorSignals {
  databaseReachable: boolean;

  /** sms_outbox: the queue, and how long its oldest member has waited. */
  smsQueuedNow: number;
  smsQueuedOldestMinutes: number | null;
  smsFailedRecent: number;
  smsSentRecent: number;

  /**
   * How many months of partitions exist beyond the current one. The nightly
   * maintenance job pre-creates them, so this falling to zero is the clearest
   * possible statement that the job has stopped — and it is a hard deadline,
   * not a warning: when the month turns, every attendance write fails.
   */
  partitionMonthsAhead: number | null;

  pushDevices: number;
  pushFailingDevices: number;

  /** sync_operations over the recent window. */
  syncRejectedRecent: number;
  syncAppliedRecent: number;

  /** Identity: challenges issued vs. those that burned all their attempts. */
  otpIssuedRecent: number;
  otpExhaustedRecent: number;
  /** Distinct phones that exhausted attempts — one number, many tries. */
  otpExhaustedPhones: number;
}

/** The window the *_Recent counts cover. Stated once so the text can cite it. */
export const WINDOW_HOURS = 24;

/* ── Thresholds ───────────────────────────────────────────────────────────
 * Named, exported and commented rather than buried as literals, because the
 * first real pilot will move some of them and whoever moves them deserves to
 * see what the number was for.
 */
export const THRESHOLDS = {
  /** Two hours of a message sitting unsent. The dispatcher runs daily, so a
   *  queue is normal; a queue whose OLDEST member predates the last run is
   *  not. Two hours is short enough to catch a failed run the same evening. */
  smsQueueStalledMinutes: 120,
  /** Below ten sends the ratio is noise — one failure out of two is 50%. */
  smsFailureFloor: 10,
  smsFailureWarnRatio: 0.25,
  smsFailureCriticalRatio: 0.5,
  /** Push is best-effort and falls through to SMS, so it warns, never pages. */
  pushDeviceFloor: 5,
  pushFailureRatio: 0.5,
  /** A rejected sync op is attendance a teacher believes they saved. */
  syncRejectedFloor: 10,
  syncRejectedRatio: 0.1,
  /** Credential stuffing looks like many exhausted challenges across few
   *  phones; a school's ordinary Monday looks like a few across many. */
  otpExhaustedFloor: 20,
  otpExhaustedRatio: 0.3,
} as const;

function ratio(part: number, whole: number): number {
  return whole > 0 ? part / whole : 0;
}

function pct(part: number, whole: number): string {
  return `${Math.round(ratio(part, whole) * 100)}%`;
}

/**
 * The whole decision. Critical first, then warnings — a paging sink reads the
 * head of the list and a chat sink prints all of it.
 */
export function evaluateAlerts(s: MonitorSignals): Alert[] {
  const out: Alert[] = [];

  if (!s.databaseReachable) {
    // Everything else is unknowable, so this is the only alert worth sending.
    return [{
      id: 'database_unavailable',
      severity: 'critical',
      title: 'Database unreachable',
      detail: 'The monitor could not open a connection.',
      investigate:
        'Neon console → the production project → Operations, for a compute '
        + 'suspend or a storage incident. Then the host log for the failing '
        + 'query text.',
      recover:
        'If the compute is suspended it wakes on the next connection; retry '
        + 'before escalating. If the endpoint moved, DATABASE_URL must be '
        + 'updated in the host environment and the functions redeployed. '
        + 'While it is down the PWA keeps working offline and queues writes, '
        + 'so no attendance is lost — say so to the schools that ring.',
    }];
  }

  // ── The quiet one: a queue that stopped draining ────────────────────────
  const stalled = s.smsQueuedOldestMinutes;
  if (s.smsQueuedNow > 0 && stalled !== null
      && stalled >= THRESHOLDS.smsQueueStalledMinutes) {
    out.push({
      id: 'sms_queue_stalled',
      severity: 'critical',
      title: 'SMS queue is not draining',
      detail: `${s.smsQueuedNow} queued; the oldest has waited `
        + `${Math.round(stalled / 60)}h (limit `
        + `${THRESHOLDS.smsQueueStalledMinutes / 60}h).`,
      investigate:
        'Did the dispatch cron run? Netlify → Functions → cron-sms, or the '
        + 'Vercel cron log. Then GET /api/v1/ops/health for the same counts '
        + 'per tenant. A queue with a stalled head and no failures usually '
        + 'means the job never fired, not that sending broke.',
      recover:
        'Invoke POST /api/v1/sms/dispatch by hand with the service key. It is '
        + 'idempotent per row — a message already sent is not sent twice. If '
        + 'the cron itself is dead, check NETLIFY_CRONS_ENABLED on the host '
        + 'that owns the schedule (it defaults to off, deliberately).',
    });
  }

  // ── Sending is happening and failing ────────────────────────────────────
  const smsTotal = s.smsFailedRecent + s.smsSentRecent;
  const smsRatio = ratio(s.smsFailedRecent, smsTotal);
  if (s.smsFailedRecent >= THRESHOLDS.smsFailureFloor
      && smsRatio > THRESHOLDS.smsFailureWarnRatio) {
    const critical = smsRatio > THRESHOLDS.smsFailureCriticalRatio;
    out.push({
      id: 'sms_failure_rate',
      severity: critical ? 'critical' : 'warning',
      title: `SMS failing at ${pct(s.smsFailedRecent, smsTotal)}`,
      detail: `${s.smsFailedRecent} failed of ${smsTotal} attempted in the `
        + `last ${WINDOW_HOURS}h.`,
      investigate:
        'GET /api/v1/ops/health shows the top error codes. A single repeated '
        + 'code is the aggregator (credentials, balance, sender identity '
        + 'unapproved); a spread of codes is more likely bad numbers in one '
        + "school's import.",
      recover:
        'Aggregator-side: fix the credential or top up, then re-queue the '
        + 'failed rows — they keep their attempt count and are retried by the '
        + 'next dispatch. Data-side: the numbers are wrong and the school '
        + 'must correct them; do not retry into a wall.',
    });
  }

  // ── The deadline nobody sees coming ─────────────────────────────────────
  if (s.partitionMonthsAhead !== null && s.partitionMonthsAhead < 1) {
    out.push({
      id: 'maintenance_cron_stopped',
      severity: 'critical',
      title: 'No future partitions — the maintenance job has stopped',
      detail: `${s.partitionMonthsAhead} month(s) of partitions exist beyond `
        + 'the current one.',
      investigate:
        'Netlify → Functions → cron-maintenance, or the Vercel cron log. '
        + 'DATABASE_MAINTENANCE_URL must be set to the OWNER role on the '
        + 'direct (non-pooled) endpoint; a pooler URL fails here.',
      recover:
        'POST /api/v1/ops/maintenance by hand with the service key, today. '
        + 'This is not a warning that can wait for the morning: when the month '
        + 'turns without a partition, every attendance and SMS write fails at '
        + 'once, for every school.',
    });
  }

  // ── Push: best-effort, so it never pages ────────────────────────────────
  if (s.pushDevices >= THRESHOLDS.pushDeviceFloor
      && ratio(s.pushFailingDevices, s.pushDevices) > THRESHOLDS.pushFailureRatio) {
    out.push({
      id: 'push_failure_rate',
      severity: 'warning',
      title: `Push failing on ${pct(s.pushFailingDevices, s.pushDevices)} of devices`,
      detail: `${s.pushFailingDevices} of ${s.pushDevices} subscriptions have `
        + 'a recent failure.',
      investigate:
        'Almost always the VAPID keypair: a changed key invalidates every '
        + 'existing subscription at once, which is what a sudden jump to near '
        + '100% means. Check VAPID_PUBLIC_KEY against the value the PWA was '
        + 'built with.',
      recover:
        'Nobody misses a message over this — a push that is not accepted '
        + 'falls through to SMS, which is why this warns rather than pages. '
        + 'If the keypair did change, subscriptions must be re-created: the '
        + 'browser resubscribes on next visit once the key matches.',
    });
  }

  // ── Attendance a teacher believes they saved ────────────────────────────
  const syncTotal = s.syncRejectedRecent + s.syncAppliedRecent;
  if (s.syncRejectedRecent >= THRESHOLDS.syncRejectedFloor
      && ratio(s.syncRejectedRecent, syncTotal) > THRESHOLDS.syncRejectedRatio) {
    out.push({
      id: 'sync_rejection_rate',
      severity: 'critical',
      title: `Sync rejecting ${pct(s.syncRejectedRecent, syncTotal)} of operations`,
      detail: `${s.syncRejectedRecent} rejected of ${syncTotal} in the last `
        + `${WINDOW_HOURS}h.`,
      investigate:
        "SELECT entity, conflict_detail FROM sync_operations WHERE result = "
        + "'rejected' ORDER BY received_at DESC — the detail names the reason. "
        + 'R-7 shipped a version where every attendance push was rejected for '
        + 'a malformed academic year id and the only symptom a teacher saw '
        + 'was a small "1 could not be sent"; assume the client is sending '
        + 'something the server will not take, not that teachers are wrong.',
      recover:
        'The operations are still in each device\'s outbox and will be '
        + 'retried, so fixing the server side recovers them without anybody '
        + 're-entering a register. Ship the fix, then confirm the rejection '
        + 'count falls rather than assuming it did.',
    });
  }

  // ── Somebody working through a list of numbers ──────────────────────────
  if (s.otpExhaustedRecent >= THRESHOLDS.otpExhaustedFloor
      && ratio(s.otpExhaustedRecent, s.otpIssuedRecent) > THRESHOLDS.otpExhaustedRatio) {
    out.push({
      id: 'auth_anomaly',
      severity: 'warning',
      title: 'Unusual rate of exhausted login codes',
      detail: `${s.otpExhaustedRecent} challenges burned all attempts across `
        + `${s.otpExhaustedPhones} phone number(s), of ${s.otpIssuedRecent} `
        + `issued in the last ${WINDOW_HOURS}h.`,
      investigate:
        'Compare the two counts. Many exhausted challenges across FEW phones '
        + 'is one person guessing at one account; across many phones it is '
        + 'more likely an SMS delivery problem — people are not receiving the '
        + 'code they are typing. The second is far more common and needs the '
        + 'opposite response.',
      recover:
        'Guessing: the per-phone limiter already refuses further attempts and '
        + 'no action is required beyond watching. Delivery: check '
        + 'sms_outbox for the auth.* messages — if they are queued or failed, '
        + 'this is the SMS alert wearing a different hat.',
    });
  }

  const rank = (a: Alert): number => (a.severity === 'critical' ? 0 : 1);
  return out.sort((a, b) => rank(a) - rank(b));
}

/**
 * Where an alert goes.
 *
 * A webhook rather than an integration: every sink a small team actually
 * uses — Slack, Discord, Teams, an SMS bridge, a PagerDuty Events endpoint —
 * accepts a POST, and picking one of them here would be picking it for
 * somebody else. `text` is included alongside the structured body because the
 * two most likely sinks render exactly that field.
 *
 * Unset means alerts are logged and not delivered, and the preflight reports
 * monitoring as unconfigured rather than green. That is the honest state for
 * a deployment nobody has wired up yet.
 */
export function alertWebhookUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = (env.ALERT_WEBHOOK_URL ?? '').trim();
  if (!raw) return null;
  // https only: an alert body names schools and counts, and a plaintext POST
  // of it across the internet is a needless disclosure.
  if (!raw.startsWith('https://')) return null;
  return raw;
}

export function alertText(alerts: Alert[], environment: string): string {
  if (alerts.length === 0) return `shikhonBD ${environment}: all clear`;
  return [`shikhonBD ${environment} — ${alerts.length} alert(s)`]
    .concat(alerts.map((a) => `[${a.severity.toUpperCase()}] ${a.title} — ${a.detail}`))
    .join('\n');
}
