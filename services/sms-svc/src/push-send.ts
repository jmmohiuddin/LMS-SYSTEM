/**
 * The push stage of the notification pipeline.  (R-9)
 *
 * Web push is a second TRANSPORT on the existing pipeline, not a second
 * pipeline. Everything upstream is unchanged: an event still becomes a row in
 * `sms_outbox` through R-2's audience resolution, still respects the grace
 * window, the weekend rules, guardian consent, the daily cap and the dedupe
 * key. This stage sits between enqueueing and sending, and asks one question of
 * each queued message: *could this have gone to a browser instead?*
 *
 * ── The ordering is the whole safety argument ──────────────────────────
 * Push is attempted FIRST and the SMS is cancelled only once a push service
 * has accepted the message. The other order — cancel the SMS, then try to
 * push — loses the message entirely whenever push fails, and it fails for
 * ordinary reasons: a revoked permission, an uninstalled browser, an outage.
 *
 * A failed push therefore costs nothing but a few milliseconds; the row stays
 * `queued` and the dispatcher sends it as SMS a moment later. The school is
 * never worse off than before R-9, only cheaper when push works.
 *
 * ── Why suppression is a per-school setting, default OFF ───────────────
 * Replacing an SMS with a push is a judgement about a school's parents, not a
 * technical fact. A push notification can be dismissed, muted at the OS level,
 * or landed on a phone the parent has handed to the child; an SMS is harder to
 * miss. So the saving is opt-in at `settings.push.replacesSms`, and until a
 * school opts in, push is purely additive — parents get both, and the school
 * can watch `suppressed.would_have_been_push` climb to see what it would save.
 *
 * ── Two things are never suppressed ────────────────────────────────────
 *   • An emergency notice. "School is closed today" should arrive by every
 *     route available; this is the one message worth paying twice for.
 *   • Anything from `auth.*`. A login code must reach the phone, and a person
 *     requesting one may well be doing so *because* they have lost access to
 *     the app that would have received the push.
 */
import type pg from 'pg';

import {
  sendPush, endpointFingerprint,
  type VapidKeys, type PushTarget,
} from '../../../packages/server-core/src/web-push.ts';

export interface PushStageResult {
  /** Queued messages whose recipient had at least one live subscription. */
  attempted: number;
  /** Devices a push service accepted the message for. */
  accepted: number;
  /** Messages that will NOT be sent as SMS because push carried them. */
  smsSuppressed: number;
  /** Subscriptions deleted because the push service reported them gone. */
  pruned: number;
  /**
   * Messages push COULD have carried but did not suppress, because the school
   * has not opted in. This is the number that makes the saving arguable.
   */
  couldHaveSuppressed: number;
}

export const EMPTY_PUSH_RESULT: PushStageResult = {
  attempted: 0, accepted: 0, smsSuppressed: 0, pruned: 0, couldHaveSuppressed: 0,
};

/**
 * Read the school's opt-in.
 *
 * Same shape and same home as R-3's `sms.noticeMaxChars`: one key inside
 * `tenants.settings`, written by the settings screen, read here. Anything
 * other than a literal `true` is off — a setting that costs a school its SMS
 * safety net should not be switchable by a truthy string.
 */
export function pushReplacesSms(settings: unknown): boolean {
  if (!settings || typeof settings !== 'object') return false;
  const push = (settings as { push?: unknown }).push;
  if (!push || typeof push !== 'object') return false;
  return (push as { replacesSms?: unknown }).replacesSms === true;
}

/**
 * The notification a person actually sees.
 *
 * The SMS body already ends "— <school>", which is right for SMS because
 * there is nowhere else to put the sender. A push notification has a title, so
 * the school's name goes there and the signature comes off the body rather
 * than being shown twice.
 */
export function pushPayloadFor(
  smsBody: string, orgName: string, url: string, tag: string,
): string {
  const signature = ` — ${orgName}`;
  const body = smsBody.endsWith(signature)
    ? smsBody.slice(0, -signature.length)
    : smsBody;
  return JSON.stringify({ title: orgName, body, url, tag });
}

interface QueuedRow {
  id: string;
  created_on: string;
  recipient_id: string;
  body: string;
  dedupe_key: string;
  template_code: string;
  category: string | null;
  notice_id: string | null;
}

interface DeviceRow {
  id: string;
  user_id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
}

export interface PushSenderOptions {
  fetchImpl?: typeof fetch;
  /** Cap on devices contacted per run, so one cron tick stays bounded. */
  maxDevices?: number;
}

export class PushSender {
  private readonly vapid: VapidKeys;
  private readonly fetchImpl?: typeof fetch;
  private readonly maxDevices: number;

  constructor(vapid: VapidKeys, opts: PushSenderOptions = {}) {
    this.vapid = vapid;
    this.fetchImpl = opts.fetchImpl;
    this.maxDevices = opts.maxDevices ?? 500;
  }

  async run(
    client: pg.PoolClient,
    tenantId: string,
    opts: { replacesSms: boolean; orgName: string },
  ): Promise<PushStageResult> {
    const result: PushStageResult = { ...EMPTY_PUSH_RESULT };

    // Queued messages whose recipient is a known person. `recipient_id IS NOT
    // NULL` excludes bulk sends with no addressee; the template filter is the
    // one that matters and is stated rather than inferred — see the header.
    const { rows: queued } = await client.query<QueuedRow>(
      `SELECT o.id, o.created_on, o.recipient_id, o.body, o.dedupe_key,
              o.template_code,
              o.context->>'category'  AS category,
              o.context->>'noticeId'  AS notice_id
         FROM sms_outbox o
        WHERE o.tenant_id = $1
          AND o.status = 'queued'
          AND o.recipient_id IS NOT NULL
          AND o.template_code NOT LIKE 'auth.%'
          AND EXISTS (SELECT 1 FROM push_subscriptions s
                       WHERE s.tenant_id = o.tenant_id
                         AND s.user_id = o.recipient_id)
        ORDER BY o.priority, o.queued_at
        LIMIT $2`,
      [tenantId, this.maxDevices],
    );
    if (queued.length === 0) return result;

    // One query for every device involved, rather than one per message: a
    // notice to 400 guardians would otherwise be 400 round trips before a
    // single notification was sent.
    const recipientIds = [...new Set(queued.map((q) => q.recipient_id))];
    const { rows: devices } = await client.query<DeviceRow>(
      `SELECT id, user_id, endpoint, p256dh, auth
         FROM push_subscriptions
        WHERE tenant_id = $1 AND user_id = ANY($2::uuid[])`,
      [tenantId, recipientIds],
    );
    const byUser = new Map<string, DeviceRow[]>();
    for (const d of devices) {
      const list = byUser.get(d.user_id);
      if (list) list.push(d); else byUser.set(d.user_id, [d]);
    }

    const gone: string[] = [];
    const succeeded: string[] = [];

    for (const msg of queued) {
      const targets = byUser.get(msg.recipient_id) ?? [];
      if (targets.length === 0) continue;
      result.attempted += 1;

      const url = msg.notice_id ? '#/inbox' : '#/home';
      const payload = pushPayloadFor(msg.body, opts.orgName, url, msg.dedupe_key);

      // Every device the person has. A parent with a phone and an office
      // computer should see it wherever they are.
      let anyAccepted = false;
      for (const t of targets) {
        const target: PushTarget = {
          endpoint: t.endpoint, p256dh: t.p256dh, auth: t.auth,
        };
        const outcome = await sendPush(target, payload, this.vapid, {
          fetchImpl: this.fetchImpl,
          // An absence notice matters this morning, not this evening, but it
          // is still worth delivering to a phone that was off for an hour.
          urgency: msg.category === 'emergency' ? 'high' : 'normal',
        });

        if (outcome.ok) {
          anyAccepted = true;
          result.accepted += 1;
          succeeded.push(t.id);
        } else if (outcome.gone) {
          // The browser is gone for good. Keeping the row would mean retrying
          // a dead address for every message, forever.
          gone.push(t.id);
        } else {
          console.warn('[push] %s failed: %s',
            endpointFingerprint(t.endpoint), outcome.error);
        }
      }

      if (!anyAccepted) continue;

      // An emergency goes by both routes whatever the setting says.
      const suppressible = msg.category !== 'emergency';
      if (!suppressible) continue;

      if (!opts.replacesSms) {
        result.couldHaveSuppressed += 1;
        continue;
      }

      // Only now, with a push service holding the message, is the SMS
      // cancelled. `status` and `error_code` say why, so the row remains an
      // honest record of what the school did and did not pay for.
      const { rowCount } = await client.query(
        `UPDATE sms_outbox
            SET status = 'suppressed', error_code = 'delivered_by_push'
          WHERE tenant_id = $1 AND created_on = $2 AND id = $3
            AND status = 'queued'`,
        [tenantId, msg.created_on, msg.id],
      );
      if (rowCount) result.smsSuppressed += 1;
    }

    if (succeeded.length > 0) {
      await client.query(
        `UPDATE push_subscriptions
            SET last_success_at = now(), failure_count = 0
          WHERE tenant_id = $1 AND id = ANY($2::uuid[])`,
        [tenantId, succeeded]);
    }
    if (gone.length > 0) {
      const { rowCount } = await client.query(
        `DELETE FROM push_subscriptions WHERE tenant_id = $1 AND id = ANY($2::uuid[])`,
        [tenantId, gone]);
      result.pruned = rowCount ?? 0;
    }

    return result;
  }
}
