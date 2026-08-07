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

export interface DispatchResult {
  tenantId: string;
  eventsConsidered: number;
  smsQueued: number;
  suppressed: Record<string, number>;
  dispatched: number;
}

const TEMPLATES: Record<string, (studentName: string, takenOn: string) => string> = {
  'attendance.absent.v2': (name, day) => `আপনার সন্তান ${name} আজ (${day}) বিদ্যালয়ে অনুপস্থিত ছিল। — ShikhonBD`,
  'attendance.late.v1': (name, day) => `আপনার সন্তান ${name} আজ (${day}) বিদ্যালয়ে দেরিতে উপস্থিত হয়েছে। — ShikhonBD`,
};

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
      const enqueueResult = await this.enqueue(client, tenantId);
      const dispatched = await this.dispatch(client, tenantId);
      return { tenantId, ...enqueueResult, dispatched };
    });
  }

  private async enqueue(
    client: pg.PoolClient,
    tenantId: string,
  ): Promise<{ eventsConsidered: number; smsQueued: number; suppressed: Record<string, number> }> {
    const suppressed: Record<string, number> = {};
    let smsQueued = 0;

    const tenantRes = await client.query<{ weekend_days: number[]; sms_daily_cap: number }>(
      `SELECT weekend_days, sms_daily_cap FROM tenants WHERE id = $1`,
      [tenantId],
    );
    const tenant = tenantRes.rows[0];
    const weekendDays = new Set(tenant?.weekend_days ?? [5, 6]);
    const dailyCap = tenant?.sms_daily_cap ?? 2000;

    const capUsedRes = await client.query<{ count: string }>(
      `SELECT count(*) FROM sms_outbox WHERE tenant_id = $1 AND created_on = CURRENT_DATE AND status <> 'suppressed'`,
      [tenantId],
    );
    let capUsed = Number(capUsedRes.rows[0].count);

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
      const body = TEMPLATES[templateCode](studentName, payload.takenOn);
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
