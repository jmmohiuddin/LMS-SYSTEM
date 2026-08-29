/**
 * Two-stage guardian-SMS worker, consuming the outbox pipeline defined in
 * db/migrations/004_attendance.sql:
 *
 *   Stage 1 (enqueue): attendance writes already insert an
 *   `event_outbox` row (event_type='attendance.marked.v1') at commit time —
 *   see app.queue_absence_sms(). This stage turns each unpublished event into
 *   zero or more `sms_outbox` rows, applying the suppression rules the
 *   schema's own comments call out as "the worker's job": a grace window (so
 *   a same-session correction can retract an absence before a parent is
 *   texted), holiday/weekend, the tenant's daily cap, and guardian consent
 *   (`receives_sms`).
 *
 *   Stage 2 (dispatch): drains `sms_outbox` rows in `queued` state. Real
 *   aggregator integration (SSL Wireless / Robi / Banglalink) is out of scope
 *   for this pass — no credentials exist yet — so the send is stubbed: it
 *   logs the message and marks it `sent` with provider='stub'. Swapping in a
 *   real provider later only touches `sendStub` below.
 *
 * IMPORTANT — this class processes ONE tenant per call. RLS on `tenants`
 * (policy `tenant_self`, db/migrations/010_rls_policies.sql) only ever
 * exposes the caller's own current-tenant row, and there is no cross-tenant
 * enumeration path available to the shikhon_app/shikhon_runtime role (by
 * design — see that migration's comments). A BYPASSRLS platform role could
 * list every tenant, but this deployment only holds the pooled runtime
 * role's credentials. Until a SECURITY DEFINER "list active tenants"
 * function is added by someone holding migration-owner credentials, the
 * caller (cron config or an ops script) supplies the tenant id explicitly —
 * see services/sms-svc/api/dispatch.ts.
 */
import type pg from 'pg';
import type { Db, TenantContext } from '../../../packages/server-core/src/db.ts';
import { randomOpaqueToken } from '../../../packages/server-core/src/crypto.ts';

interface AttendanceMarkedPayload {
  studentId: string;
  sectionId: string;
  takenOn: string;
  status: 'absent' | 'late' | string;
  sessionId: string;
}

export interface DispatchOptions {
  graceMinutes?: number;
  enqueueBatchSize?: number;
  dispatchBatchSize?: number;
  now?: () => number;
}

/** One run's SMS budget and identity, shared by both stage-1 senders. */
interface TenantSmsBudget {
  weekendDays: Set<number>;
  dailyCap: number;
  /** Mutated as each sender spends it, so one run cannot double-spend. */
  capUsed: number;
  /** The name the school signs its messages with — never the platform's. */
  orgName: string;
}

export interface DispatchResult {
  tenantId: string;
  eventsConsidered: number;
  smsQueued: number;
  suppressed: Record<string, number>;
  dispatched: number;
}

/**
 * Message bodies. The signature carries the INSTITUTION's name, not the
 * platform's.
 *
 * These templates used to end "— ShikhonBD". That is a D11 violation of the
 * plainest kind: an SMS to a guardian is a tenant operational surface, and the
 * name at the end of it should be the school the child attends. A parent who
 * gets "your child was absent — ShikhonBD" has been told by a company they
 * have never heard of. R-1's CI guard did not catch this because it only reads
 * apps/pwa; R-2 found it while adding the second sender.
 */
const TEMPLATES: Record<string, (studentName: string, takenOn: string, org: string) => string> = {
  'attendance.absent.v2': (name, day, org) =>
    `আপনার সন্তান ${name} আজ (${day}) বিদ্যালয়ে অনুপস্থিত ছিল। — ${org}`,
  'attendance.late.v1': (name, day, org) =>
    `আপনার সন্তান ${name} আজ (${day}) বিদ্যালয়ে দেরিতে উপস্থিত হয়েছে। — ${org}`,
};

/**
 * A notice SMS is the notice's own title and body, signed by the school.
 *
 * Not the full body: a 4000-character notice is 58 SMS segments per guardian,
 * and at ~৳0.40 a segment one long notice to 900 guardians is over ৳20,000.
 * The SMS carries the headline and points at the app, which is where the whole
 * text already is. docs/05 §5 makes this the single most expensive decision in
 * the product; it is not left to whoever writes the notice.
 */
export const NOTICE_SMS_MAX_BODY = 180;

export function noticeSmsBody(title: string, body: string, org: string): string {
  const head = title.trim();
  const rest = body.trim().replace(/\s+/g, ' ');
  const room = NOTICE_SMS_MAX_BODY - head.length - org.length - 6;
  const tail = room > 20 && rest.length > 0
    ? (rest.length <= room ? rest : `${rest.slice(0, room - 1)}…`)
    : '';
  return tail ? `${head}: ${tail} — ${org}` : `${head} — ${org}`;
}

export class SmsDispatchWorker {
  private readonly db: Db;
  private readonly graceMinutes: number;
  private readonly enqueueBatchSize: number;
  private readonly dispatchBatchSize: number;
  private readonly now: () => number;

  constructor(db: Db, opts: DispatchOptions = {}) {
    this.db = db;
    this.graceMinutes = opts.graceMinutes ?? 20;
    this.enqueueBatchSize = opts.enqueueBatchSize ?? 200;
    this.dispatchBatchSize = opts.dispatchBatchSize ?? 200;
    this.now = opts.now ?? Date.now;
  }

  async run(tenantId: string): Promise<DispatchResult> {
    const ctx: TenantContext = { tenantId, userId: '', role: 'system_ingest' };
    return this.db.withTenant(ctx, async (client) => {
      // One shared budget for the whole run. Attendance and notices are two
      // senders drawing on ONE daily cap — reading it twice would let a busy
      // notice day and a busy absence day each spend the whole allowance.
      const budget = await this.loadTenantBudget(client, tenantId);

      const attendance = await this.enqueue(client, tenantId, budget);
      const notices = await this.enqueueNotices(client, tenantId, budget);

      const suppressed = { ...attendance.suppressed };
      for (const [k, v] of Object.entries(notices.suppressed)) {
        suppressed[k] = (suppressed[k] ?? 0) + v;
      }

      const dispatched = await this.dispatch(client, tenantId);
      return {
        tenantId,
        eventsConsidered: attendance.eventsConsidered + notices.eventsConsidered,
        smsQueued: attendance.smsQueued + notices.smsQueued,
        suppressed,
        dispatched,
      };
    });
  }

  /**
   * Weekend, cap, cap already spent today, and the name the school signs its
   * messages with. Read once per run and shared by both senders.
   */
  private async loadTenantBudget(
    client: pg.PoolClient,
    tenantId: string,
  ): Promise<TenantSmsBudget> {
    const res = await client.query<{
      weekend_days: number[];
      sms_daily_cap: number;
      org_name: string | null;
    }>(
      `SELECT weekend_days, sms_daily_cap,
              COALESCE(NULLIF(settings->'branding'->>'shortName', ''),
                       NULLIF(settings->'branding'->>'nameBn', ''),
                       name_bn) AS org_name
         FROM tenants WHERE id = $1`,
      [tenantId],
    );
    const row = res.rows[0];

    const used = await client.query<{ count: string }>(
      `SELECT count(*) FROM sms_outbox
        WHERE tenant_id = $1 AND created_on = CURRENT_DATE AND status <> 'suppressed'`,
      [tenantId],
    );

    return {
      weekendDays: new Set(row?.weekend_days ?? [5, 6]),
      dailyCap: row?.sms_daily_cap ?? 2000,
      capUsed: Number(used.rows[0].count),
      // Falls back to a neutral word, never to the platform's name.
      orgName: row?.org_name ?? 'বিদ্যালয়',
    };
  }

  private async enqueue(
    client: pg.PoolClient,
    tenantId: string,
    budget: TenantSmsBudget,
  ): Promise<{ eventsConsidered: number; smsQueued: number; suppressed: Record<string, number> }> {
    const suppressed: Record<string, number> = {};
    let smsQueued = 0;

    const { weekendDays, dailyCap } = budget;
    let capUsed = budget.capUsed;

    const events = await client.query<{ id: string; payload: AttendanceMarkedPayload; occurred_at: string }>(
      `SELECT id, payload, occurred_at FROM event_outbox
        WHERE tenant_id = $1 AND event_type = 'attendance.marked.v1' AND published_at IS NULL
          AND occurred_at <= now() - ($2 || ' minutes')::interval
        ORDER BY id ASC LIMIT $3`,
      [tenantId, this.graceMinutes, this.enqueueBatchSize],
    );

    for (const ev of events.rows) {
      const payload = ev.payload;
      const reason = await this.suppressionReason(client, tenantId, payload, weekendDays, capUsed, dailyCap);
      if (reason) {
        suppressed[reason] = (suppressed[reason] ?? 0) + 1;
        await this.markAttendanceSmsState(client, tenantId, payload, 'suppressed');
        await this.markPublished(client, ev.id);
        continue;
      }

      const guardians = await client.query<{ guardian_id: string; phone_e164: string | null }>(
        `SELECT g.guardian_id, u.phone_e164 FROM guardianships g
           JOIN users u ON u.id = g.guardian_id
          WHERE g.tenant_id = $1 AND g.student_id = $2 AND g.receives_sms = true`,
        [tenantId, payload.studentId],
      );

      if (guardians.rows.length === 0) {
        suppressed.no_guardian = (suppressed.no_guardian ?? 0) + 1;
        await this.markAttendanceSmsState(client, tenantId, payload, 'suppressed');
        await this.markPublished(client, ev.id);
        continue;
      }

      const studentRes = await client.query<{ full_name_bn: string | null; full_name_en: string | null }>(
        `SELECT full_name_bn, full_name_en FROM users WHERE id = $1`,
        [payload.studentId],
      );
      const studentName = studentRes.rows[0]?.full_name_bn ?? studentRes.rows[0]?.full_name_en ?? 'শিক্ষার্থী';
      const templateCode = payload.status === 'late' ? 'attendance.late.v1' : 'attendance.absent.v2';
      const body = TEMPLATES[templateCode](studentName, payload.takenOn, budget.orgName);
      const segments = Math.max(1, Math.ceil(body.length / 70));

      let anyQueued = false;
      for (const g of guardians.rows) {
        if (!g.phone_e164 || capUsed >= dailyCap) continue;
        const dedupeKey = `${payload.status}:${payload.takenOn}:${payload.studentId}:${g.guardian_id}`;
        const inserted = await client.query(
          `INSERT INTO sms_outbox
             (tenant_id, recipient_id, msisdn, template_code, locale, body, encoding, segments, dedupe_key, context)
           VALUES ($1, $2, $3, $4, 'bn', $5, 'unicode', $6, $7, $8)
           ON CONFLICT (tenant_id, created_on, dedupe_key) DO NOTHING
           RETURNING id`,
          [
            tenantId,
            g.guardian_id,
            g.phone_e164,
            templateCode,
            body,
            segments,
            dedupeKey,
            JSON.stringify({ studentId: payload.studentId, sectionId: payload.sectionId, sessionId: payload.sessionId }),
          ],
        );
        if (inserted.rowCount && inserted.rowCount > 0) {
          smsQueued++;
          capUsed++;
          anyQueued = true;
        }
      }

      await this.markAttendanceSmsState(client, tenantId, payload, anyQueued ? 'queued' : 'suppressed');
      if (!anyQueued) suppressed.daily_cap_exceeded = (suppressed.daily_cap_exceeded ?? 0) + 1;
      await this.markPublished(client, ev.id);
    }

    // Hand the spend back so the notice sender starts where this one stopped.
    budget.capUsed = capUsed;
    return { eventsConsidered: events.rows.length, smsQueued, suppressed };
  }

  /**
   * Stage 1, second consumer: notice.published.v1 (R-2).
   *
   * Deliberately the SAME stage as attendance rather than a second pipeline.
   * SMS is roughly 80% of the infrastructure bill (docs/05 §5), and a second
   * path would be a second place for the daily cap to be miscounted, the
   * weekend to be forgotten, and a parent to be texted twice.
   *
   * What differs from attendance: there is no grace window (a notice is
   * published deliberately, not accumulated), and the recipients come from
   * notice_receipts — already resolved and frozen at publish time — rather
   * than from a live guardianship lookup.
   */
  private async enqueueNotices(
    client: pg.PoolClient,
    tenantId: string,
    budget: TenantSmsBudget,
  ): Promise<{ eventsConsidered: number; smsQueued: number; suppressed: Record<string, number> }> {
    const suppressed: Record<string, number> = {};
    let smsQueued = 0;
    let capUsed = budget.capUsed;

    const events = await client.query<{ id: string; payload: { noticeId: string } }>(
      `SELECT id, payload FROM event_outbox
        WHERE tenant_id = $1 AND event_type = 'notice.published.v1' AND published_at IS NULL
        ORDER BY id ASC LIMIT $2`,
      [tenantId, this.enqueueBatchSize],
    );

    for (const ev of events.rows) {
      const noticeId = ev.payload?.noticeId;
      if (!noticeId) { await this.markPublished(client, ev.id); continue; }

      const noticeRes = await client.query<{
        title: string; body: string; category: string; send_sms: boolean;
      }>(
        `SELECT title, body, category, send_sms FROM notices WHERE id = $1`,
        [noticeId],
      );
      const notice = noticeRes.rows[0];
      if (!notice || !notice.send_sms) {
        await this.markPublished(client, ev.id);
        continue;
      }

      // Weekend and holiday suppression applies to ordinary notices but NOT
      // to an emergency: "school is closed today" is precisely the message a
      // parent needs on a day the school is closed.
      if (notice.category !== 'emergency') {
        const today = new Date(this.now()).toISOString().slice(0, 10);
        const dow = new Date(`${today}T00:00:00Z`).getUTCDay();
        if (budget.weekendDays.has(dow)) {
          suppressed.weekend = (suppressed.weekend ?? 0) + 1;
          await this.markPublished(client, ev.id);
          continue;
        }
        const holiday = await client.query(
          `SELECT 1 FROM calendar_days WHERE tenant_id = $1 AND day = $2 AND kind = 'holiday' LIMIT 1`,
          [tenantId, today],
        );
        if ((holiday.rowCount ?? 0) > 0) {
          suppressed.holiday = (suppressed.holiday ?? 0) + 1;
          await this.markPublished(client, ev.id);
          continue;
        }
      }

      // Only recipients who can actually receive an SMS: a phone on file, and
      // — for guardians — consent. Staff and students with a phone are
      // included; the audience already decided who belongs here.
      const recipients = await client.query<{ user_id: string; phone_e164: string | null }>(
        `SELECT DISTINCT r.user_id, u.phone_e164
           FROM notice_receipts r
           JOIN users u ON u.id = r.user_id
          WHERE r.tenant_id = $1 AND r.notice_id = $2
            AND u.status = 'active' AND u.phone_e164 IS NOT NULL
            AND (NOT EXISTS (SELECT 1 FROM guardianships g
                              WHERE g.tenant_id = $1 AND g.guardian_id = u.id)
                 OR EXISTS (SELECT 1 FROM guardianships g
                             WHERE g.tenant_id = $1 AND g.guardian_id = u.id
                               AND g.receives_sms = true))`,
        [tenantId, noticeId],
      );

      const body = noticeSmsBody(notice.title, notice.body, budget.orgName);
      const segments = Math.max(1, Math.ceil(body.length / 70));

      for (const r of recipients.rows) {
        if (!r.phone_e164) continue;
        if (capUsed >= budget.dailyCap) {
          suppressed.daily_cap_exceeded = (suppressed.daily_cap_exceeded ?? 0) + 1;
          continue;
        }
        // One SMS per person per notice, forever — the unique index makes a
        // re-published notice free rather than a second charge and a second
        // buzz on a parent's phone.
        const inserted = await client.query(
          `INSERT INTO sms_outbox
             (tenant_id, recipient_id, msisdn, template_code, locale, body, encoding, segments, dedupe_key, context)
           VALUES ($1, $2, $3, 'notice.published.v1', 'bn', $4, 'unicode', $5, $6, $7)
           ON CONFLICT (tenant_id, created_on, dedupe_key) DO NOTHING
           RETURNING id`,
          [
            tenantId, r.user_id, r.phone_e164, body, segments,
            `notice:${noticeId}:${r.user_id}`,
            JSON.stringify({ noticeId, category: notice.category }),
          ],
        );
        if (inserted.rowCount && inserted.rowCount > 0) { smsQueued++; capUsed++; }
      }

      await this.markPublished(client, ev.id);
    }

    budget.capUsed = capUsed;
    return { eventsConsidered: events.rows.length, smsQueued, suppressed };
  }

  private async suppressionReason(
    client: pg.PoolClient,
    tenantId: string,
    payload: AttendanceMarkedPayload,
    weekendDays: Set<number>,
    capUsed: number,
    dailyCap: number,
  ): Promise<string | null> {
    if (capUsed >= dailyCap) return 'daily_cap_exceeded';

    const dow = new Date(`${payload.takenOn}T00:00:00Z`).getUTCDay();
    if (weekendDays.has(dow)) return 'weekend';

    const holiday = await client.query(
      `SELECT 1 FROM calendar_days WHERE tenant_id = $1 AND day = $2 AND kind = 'holiday' LIMIT 1`,
      [tenantId, payload.takenOn],
    );
    if ((holiday.rowCount ?? 0) > 0) return 'holiday';

    return null;
  }

  private async markAttendanceSmsState(
    client: pg.PoolClient,
    tenantId: string,
    payload: AttendanceMarkedPayload,
    state: 'queued' | 'suppressed',
  ): Promise<void> {
    await client.query(
      `UPDATE attendance_records SET sms_state = $5
        WHERE tenant_id = $1 AND taken_on = $2 AND session_id = $3 AND student_id = $4`,
      [tenantId, payload.takenOn, payload.sessionId, payload.studentId, state],
    );
  }

  private async markPublished(client: pg.PoolClient, eventId: string): Promise<void> {
    await client.query(`UPDATE event_outbox SET published_at = now() WHERE id = $1`, [eventId]);
  }

  private async dispatch(client: pg.PoolClient, tenantId: string): Promise<number> {
    const queued = await client.query<{ id: string; created_on: string; msisdn: string; body: string }>(
      `SELECT id, created_on, msisdn, body FROM sms_outbox
        WHERE tenant_id = $1 AND status = 'queued'
        ORDER BY priority, queued_at LIMIT $2`,
      [tenantId, this.dispatchBatchSize],
    );

    let dispatched = 0;
    for (const row of queued.rows) {
      const providerMsgId = await this.sendStub(row.msisdn, row.body);
      await client.query(
        `UPDATE sms_outbox
            SET status = 'sent', sent_at = now(), provider = 'stub',
                provider_msg_id = $4, attempts = attempts + 1
          WHERE tenant_id = $1 AND created_on = $2 AND id = $3`,
        [tenantId, row.created_on, row.id, providerMsgId],
      );
      dispatched++;
    }
    return dispatched;
  }

  /** Stand-in for a real SMS aggregator call — no credentials exist yet. */
  private async sendStub(msisdn: string, body: string): Promise<string> {
    const providerMsgId = `stub_${randomOpaqueToken(8)}`;
    console.log(`[sms-dispatch] STUB SEND to=${msisdn} id=${providerMsgId} body=${JSON.stringify(body)}`);
    return providerMsgId;
  }
}
