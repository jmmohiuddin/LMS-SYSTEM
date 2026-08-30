/**
 * Gathering what the alert conditions need.  (R-8 §7)
 *
 * Separate from alerts.ts so the thresholds stay pure and testable, and
 * separate from both callers so the scheduled monitor and the operator
 * console's alert panel read the SAME numbers. Two queries that drift apart
 * would produce the worst possible outcome: a console that says all clear
 * while the pager is going off, or the reverse.
 *
 * ── Which connection, and why ───────────────────────────────────────────
 * DATABASE_MAINTENANCE_URL — the owner role on the direct endpoint, already
 * used by ops/maintenance for the same reason. These are platform-wide
 * counts spanning every tenant, and RLS exists precisely to make that
 * impossible from the application role. Reusing the maintenance credential
 * rather than minting a third one keeps the number of things that can see
 * every school at two, which is two more than ideal and one fewer than the
 * alternative.
 *
 * ── Counts only ─────────────────────────────────────────────────────────
 * Not one query here selects a name, a phone number, a message body or a
 * mark. An alert reaches a chat channel and possibly a phone lock screen;
 * whatever goes into it should be safe to read over somebody's shoulder on a
 * bus. Error CODES are included because they are the diagnosis; error
 * messages are not, because an SMS body is a school's words to a parent.
 */
import pg from 'pg';
import type { MonitorSignals } from './alerts.ts';
import { WINDOW_HOURS } from './alerts.ts';

export interface GatherResult {
  signals: MonitorSignals;
  /** Top failure reasons, codes only. Context for the alert, not a condition. */
  topErrors: Array<{ code: string; count: number }>;
}

const UNREACHABLE: MonitorSignals = {
  databaseReachable: false,
  smsQueuedNow: 0, smsQueuedOldestMinutes: null,
  smsFailedRecent: 0, smsSentRecent: 0,
  partitionMonthsAhead: null,
  pushDevices: 0, pushFailingDevices: 0,
  syncRejectedRecent: 0, syncAppliedRecent: 0,
  otpIssuedRecent: 0, otpExhaustedRecent: 0, otpExhaustedPhones: 0,
};

export async function gatherSignals(connectionString: string): Promise<GatherResult> {
  // A short-lived client, as in maintenance.ts: this runs on a schedule and
  // pooling would keep an owner-credential connection alive between runs for
  // no benefit. The timeout is low on purpose — a monitor that hangs is a
  // monitor that has stopped monitoring, and the alert we most need to send
  // is the one about the database being unreachable.
  const client = new pg.Client({ connectionString, statement_timeout: 15_000 });
  try {
    await client.connect();
  } catch {
    return { signals: UNREACHABLE, topErrors: [] };
  }

  try {
    const num = (v: unknown): number => Number(v ?? 0);

    // Two queries, and the split is the whole point of the stall check.
    //
    // The recent-activity counts are bounded to the last two partitions,
    // because scanning every month ever sent to count yesterday's failures is
    // waste. The QUEUE is not bounded at all: a message stuck since last week
    // is precisely the alert this exists to raise, and a date bound would
    // filter out the worst case while leaving the check looking like it
    // worked. (Written bounded first; caught reading it back.)
    const queue = await client.query<Record<string, string | null>>(
      `SELECT count(*)::text AS queued_now,
              (EXTRACT(EPOCH FROM (now() - min(queued_at))) / 60)::bigint::text
                AS oldest_queued_minutes
         FROM sms_outbox WHERE status = 'queued'`);

    const sms = await client.query<Record<string, string | null>>(
      `SELECT
         count(*) FILTER (WHERE status = 'failed'
                            AND COALESCE(sent_at, queued_at) > now() - $1::interval)::text
                                                      AS failed_recent,
         count(*) FILTER (WHERE status IN ('sent','delivered')
                            AND sent_at > now() - $1::interval)::text AS sent_recent
       -- created_on is the partition key: this bound keeps the scan on the
       -- current and previous partitions instead of every month ever sent.
       FROM sms_outbox WHERE created_on >= CURRENT_DATE - 2`,
      [`${WINDOW_HOURS} hours`],
    );

    const errs = await client.query<{ error_code: string; n: string }>(
      `SELECT error_code, count(*)::text AS n
         FROM sms_outbox
        WHERE status IN ('failed','suppressed')
          AND error_code IS NOT NULL
          AND created_on >= CURRENT_DATE - 2
          AND COALESCE(sent_at, queued_at) > now() - $1::interval
        GROUP BY 1 ORDER BY count(*) DESC LIMIT 5`,
      [`${WINDOW_HOURS} hours`],
    );

    // How many whole months of attendance partitions exist beyond this one.
    // Reading the catalogue rather than a bookkeeping table means this cannot
    // be right-according-to-our-records and wrong in fact.
    const part = await client.query<{ months_ahead: string | null }>(
      `SELECT max(
                (EXTRACT(YEAR  FROM to_date(right(c.relname, 7), 'YYYY_MM'))
                 - EXTRACT(YEAR  FROM CURRENT_DATE)) * 12
              + (EXTRACT(MONTH FROM to_date(right(c.relname, 7), 'YYYY_MM'))
                 - EXTRACT(MONTH FROM CURRENT_DATE))
              )::int::text AS months_ahead
         FROM pg_inherits i
         JOIN pg_class c ON c.oid = i.inhrelid
         JOIN pg_class p ON p.oid = i.inhparent
        WHERE p.relname = 'attendance_records'
          AND c.relname ~ '_[0-9]{4}_[0-9]{2}$'`);

    const push = await client.query<Record<string, string>>(
      `SELECT count(*)::text AS devices,
              count(*) FILTER (
                WHERE last_failure_at IS NOT NULL
                  AND (last_success_at IS NULL OR last_failure_at > last_success_at)
              )::text AS failing
         FROM push_subscriptions`);

    const sync = await client.query<Record<string, string>>(
      `SELECT count(*) FILTER (WHERE result = 'rejected')::text AS rejected,
              count(*) FILTER (WHERE result = 'applied')::text  AS applied
         FROM sync_operations
        WHERE received_at > now() - $1::interval`,
      [`${WINDOW_HOURS} hours`],
    );

    // "Exhausted" is a challenge that burned every attempt and was never
    // consumed. Counting the distinct PHONES separately is what separates one
    // person guessing at one account from a school-wide delivery failure —
    // the two need opposite responses, so the alert must not conflate them.
    const otp = await client.query<Record<string, string>>(
      `SELECT count(*)::text AS issued,
              count(*) FILTER (WHERE attempts >= max_attempts
                                 AND consumed_at IS NULL)::text AS exhausted,
              count(DISTINCT phone_e164) FILTER (
                WHERE attempts >= max_attempts AND consumed_at IS NULL
              )::text AS exhausted_phones
         FROM otp_challenges
        WHERE created_at > now() - $1::interval`,
      [`${WINDOW_HOURS} hours`],
    );

    return {
      signals: {
        databaseReachable: true,
        smsQueuedNow: num(queue.rows[0].queued_now),
        smsQueuedOldestMinutes: queue.rows[0].oldest_queued_minutes === null
          ? null : num(queue.rows[0].oldest_queued_minutes),
        smsFailedRecent: num(sms.rows[0].failed_recent),
        smsSentRecent: num(sms.rows[0].sent_recent),
        partitionMonthsAhead: part.rows[0]?.months_ahead == null
          ? null : num(part.rows[0].months_ahead),
        pushDevices: num(push.rows[0].devices),
        pushFailingDevices: num(push.rows[0].failing),
        syncRejectedRecent: num(sync.rows[0].rejected),
        syncAppliedRecent: num(sync.rows[0].applied),
        otpIssuedRecent: num(otp.rows[0].issued),
        otpExhaustedRecent: num(otp.rows[0].exhausted),
        otpExhaustedPhones: num(otp.rows[0].exhausted_phones),
      },
      topErrors: errs.rows.map((r) => ({ code: r.error_code, count: num(r.n) })),
    };
  } catch (err) {
    // A query that fails is not the same as a database that is down, but from
    // the monitor's seat it is just as blind, and the alert it produces sends
    // an engineer to the right place either way.
    console.error('[monitor] gather failed', err);
    return { signals: UNREACHABLE, topErrors: [] };
  } finally {
    await client.end().catch(() => {});
  }
}
