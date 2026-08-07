/**
 * MFS (bKash / Nagad / Rocket) webhook processor — shared by the three thin
 * handlers under services/finance-svc/api/webhooks/. See
 * db/migrations/007_finance_mfs.sql for the schema this writes to, and its
 * "Pre-tenant tables" section in db/migrations/010_rls_policies.sql for why
 * mfs_webhook_events can be written with tenant_id NULL at all.
 *
 * Tenant resolution problem: a webhook arrives with only whatever fields the
 * gateway echoes back (an order id, a status, a trx id) — no tenant header,
 * and (per the RLS design) no DB role available to this deployment can list
 * tenants to search across them. The same constraint the SMS dispatch worker
 * documents at length (services/sms-svc/src/dispatch.ts) applies here.
 *
 * Resolution: WE choose what string is sent to the gateway as
 * merchantInvoiceNumber/orderId when a payment is initiated (the "create
 * payment" endpoint itself isn't built yet — no aggregator credentials exist
 * to actually call bKash/Nagad's initiate API — but the callback shape is
 * fixed by them, so the convention can be decided now). Adopted format:
 *
 *   {tenantId}.{invoiceId}.{opaqueSuffix}
 *
 * Both ids are real UUIDs already in our own schema, so the callback can
 * resolve tenant AND invoice with zero cross-tenant lookups — the same trick
 * as encoding the tenant in the SMS worker's caller-supplied argument,
 * applied to gateway-echoed data instead of an env var.
 *
 * Role for the resolved-tenant phase is 'accountant', not 'system_ingest':
 * invoices/mfs_transactions/ledger writes are RESTRICTIVE-gated to
 * principal/school_owner/accountant (db/migrations/010_rls_policies.sql).
 * Like every other server-trusted role string in this codebase (see
 * otp-request.ts's use of 'system_ingest'), this is the backend asserting
 * "I am the automated finance pipeline," not a claim checked against a real
 * logged-in user — nothing user-supplied ever reaches TenantContext.role
 * here.
 *
 * Explicitly NOT done in this pass (skeleton, not a finished integration):
 *   - Signature verification. Real HMAC/certificate verification is
 *     provider-specific and needs credentials we don't have yet.
 *     signature_valid/signature_algo are left NULL, not faked as true.
 *   - Ledger postings (double-entry). ledger_entries needs a tenant's chart
 *     of accounts (ledger_accounts) to already be seeded with the right
 *     codes — none is. apply_payment_to_invoice() updates the invoice only;
 *     ledger posting is a documented follow-up once accounts are seeded.
 *   - Field names below are best-effort guesses at each provider's real
 *     callback shape (no API docs available in this environment) — expect
 *     to adjust PROVIDER_FIELD_MAPS once real sandbox credentials arrive.
 *
 * Never surfaces a processing-logic failure (unresolvable order id, unknown
 * invoice, malformed amount) as a non-2xx — gateways retry aggressively on
 * non-2xx, and a business-logic rejection retrying won't fix itself. Those
 * cases are persisted as 'deferred'/'rejected' for manual reconciliation
 * (see ix_webhook_unprocessed / ix_webhook_rejected) and still answered 200.
 * Only a genuine server/DB fault reaches the handler as a thrown error.
 */
import type { Db, TenantContext } from '../../../packages/server-core/src/db.ts';
import { sha256Hex } from '../../../packages/server-core/src/crypto.ts';

export type MfsProvider = 'bkash' | 'nagad' | 'rocket';

interface FieldMap {
  orderIdFields: string[];
  gatewayPaymentIdFields: string[];
  gatewayTrxIdFields: string[];
  msisdnFields: string[];
  amountFields: string[];
  statusFields: string[];
  eventIdFields: string[];
}

const PROVIDER_FIELD_MAPS: Record<MfsProvider, FieldMap> = {
  bkash: {
    orderIdFields: ['merchantInvoiceNumber', 'merchantInvoiceNo', 'orderID'],
    gatewayPaymentIdFields: ['paymentID'],
    gatewayTrxIdFields: ['trxID'],
    msisdnFields: ['customerMsisdn', 'payerAccount'],
    amountFields: ['amount'],
    statusFields: ['transactionStatus', 'status'],
    eventIdFields: ['trxID', 'paymentID'],
  },
  nagad: {
    orderIdFields: ['merchantOrderId', 'orderId'],
    gatewayPaymentIdFields: ['paymentRefId'],
    gatewayTrxIdFields: ['issuerPaymentRefNo', 'paymentRefId'],
    msisdnFields: ['clientMobileNo', 'customerMsisdn'],
    amountFields: ['amount'],
    statusFields: ['status'],
    eventIdFields: ['paymentRefId', 'issuerPaymentRefNo'],
  },
  rocket: {
    orderIdFields: ['merchantOrderId', 'orderId'],
    gatewayPaymentIdFields: ['paymentId'],
    gatewayTrxIdFields: ['transactionId', 'trxId'],
    msisdnFields: ['msisdn', 'customerMsisdn'],
    amountFields: ['amount'],
    statusFields: ['status'],
    eventIdFields: ['transactionId', 'trxId'],
  },
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type PaymentStatus =
  | 'initiated'
  | 'pending'
  | 'authorised'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'refunded'
  | 'reversed';

function mapStatus(raw: string | undefined): PaymentStatus {
  const s = (raw ?? '').toLowerCase();
  if (['completed', 'success', 'successful', 'paid'].includes(s)) return 'completed';
  if (['failed', 'failure', 'error'].includes(s)) return 'failed';
  if (['cancelled', 'canceled'].includes(s)) return 'cancelled';
  if (['authorised', 'authorized'].includes(s)) return 'authorised';
  if (['reversed'].includes(s)) return 'reversed';
  if (['refunded'].includes(s)) return 'refunded';
  return 'pending';
}

function firstString(payload: Record<string, unknown>, fields: string[]): string | undefined {
  for (const f of fields) {
    const v = payload[f];
    if (typeof v === 'string' && v) return v;
    if (typeof v === 'number') return String(v);
  }
  return undefined;
}

function parseOrderId(orderId: string): { tenantId: string; invoiceId: string } | null {
  const [tenantId, invoiceId] = orderId.split('.');
  if (!tenantId || !invoiceId || !UUID_RE.test(tenantId) || !UUID_RE.test(invoiceId)) return null;
  return { tenantId, invoiceId };
}

export interface WebhookOutcome {
  status: number;
  body: Record<string, unknown>;
}

export class MfsWebhookProcessor {
  constructor(private readonly db: Db) {}

  async process(
    provider: MfsProvider,
    rawBody: string,
    headers: Record<string, string>,
    sourceIp: string | null,
  ): Promise<WebhookOutcome> {
    let payload: Record<string, unknown> = {};
    try {
      const parsed: unknown = JSON.parse(rawBody);
      if (parsed && typeof parsed === 'object') payload = parsed as Record<string, unknown>;
    } catch {
      // Non-JSON body — kept verbatim in raw_body; payload fields stay empty.
    }

    const map = PROVIDER_FIELD_MAPS[provider];
    const providerEventId = firstString(payload, map.eventIdFields) ?? sha256Hex(rawBody);
    const rawStatus = firstString(payload, map.statusFields);

    const webhookRow = await this.db.withSystemRole('system_ingest', async (client) => {
      const { rows } = await client.query<{ id: string; processing_state: string }>(
        `INSERT INTO mfs_webhook_events
           (tenant_id, provider, event_type, provider_event_id, raw_body, headers, source_ip, processing_state)
         VALUES (NULL, $1, $2, $3, $4, $5::jsonb, $6, 'received')
         ON CONFLICT (provider, provider_event_id)
         DO UPDATE SET attempts = mfs_webhook_events.attempts + 1
         RETURNING id, processing_state`,
        [provider, rawStatus ?? null, providerEventId, rawBody, JSON.stringify(headers), sourceIp],
      );
      return rows[0];
    });

    if (webhookRow.processing_state === 'processed' || webhookRow.processing_state === 'duplicate') {
      return { status: 200, body: { ok: true, note: 'already processed' } };
    }

    const orderId = firstString(payload, map.orderIdFields);
    const parsedOrderId = orderId ? parseOrderId(orderId) : null;

    if (!parsedOrderId) {
      await this.db.withSystemRole('system_ingest', (client) =>
        client.query(
          `UPDATE mfs_webhook_events SET processing_state = 'deferred', reject_reason = $2
            WHERE id = $1 AND tenant_id IS NULL`,
          [
            webhookRow.id,
            orderId
              ? 'order id does not match the tenantId.invoiceId.suffix convention'
              : 'no recognizable order id field in payload',
          ],
        ),
      );
      return { status: 200, body: { ok: true, note: 'deferred: could not resolve tenant from order id' } };
    }

    const { tenantId, invoiceId } = parsedOrderId;
    const status = mapStatus(rawStatus);
    const amountRaw = firstString(payload, map.amountFields);
    const amount = amountRaw ? Number(amountRaw) : null;
    const gatewayPaymentId = firstString(payload, map.gatewayPaymentIdFields) ?? null;
    const gatewayTrxId = firstString(payload, map.gatewayTrxIdFields) ?? null;
    const msisdn = firstString(payload, map.msisdnFields) ?? null;

    const ctx: TenantContext = { tenantId, userId: '', role: 'accountant' };
    const result = await this.db.withTenant(ctx, async (client) => {
      const invoiceRes = await client.query<{ id: string; student_id: string }>(
        `SELECT id, student_id FROM invoices WHERE id = $1`,
        [invoiceId],
      );
      const invoice = invoiceRes.rows[0];

      if (!invoice) {
        await client.query(
          `UPDATE mfs_webhook_events
              SET tenant_id = $2, processing_state = 'rejected', reject_reason = $3
            WHERE id = $1 AND tenant_id IS NULL`,
          [webhookRow.id, tenantId, 'invoice not found in resolved tenant'],
        );
        return { outcome: 'rejected' as const, reason: 'invoice not found in resolved tenant' };
      }

      if (amount === null || !Number.isFinite(amount) || amount <= 0) {
        await client.query(
          `UPDATE mfs_webhook_events
              SET tenant_id = $2, processing_state = 'rejected', reject_reason = $3
            WHERE id = $1 AND tenant_id IS NULL`,
          [webhookRow.id, tenantId, 'missing or non-positive amount in payload'],
        );
        return { outcome: 'rejected' as const, reason: 'missing or non-positive amount in payload' };
      }

      const existing = await client.query<{ id: string; status: PaymentStatus }>(
        `SELECT id, status FROM mfs_transactions WHERE tenant_id = $1 AND merchant_order_id = $2`,
        [tenantId, orderId],
      );

      let txId: string;
      const alreadyCompleted = existing.rows[0]?.status === 'completed';

      if (existing.rows[0]) {
        txId = existing.rows[0].id;
        await client.query(
          `UPDATE mfs_transactions
              SET status = $2,
                  gateway_payment_id = COALESCE($3, gateway_payment_id),
                  gateway_trx_id = COALESCE($4, gateway_trx_id),
                  payer_msisdn = COALESCE($5, payer_msisdn),
                  response_payload = $6::jsonb,
                  completed_at = CASE WHEN $2 = 'completed' AND completed_at IS NULL THEN now() ELSE completed_at END
            WHERE id = $1`,
          [txId, status, gatewayPaymentId, gatewayTrxId, msisdn, JSON.stringify(payload)],
        );
      } else {
        const inserted = await client.query<{ id: string }>(
          `INSERT INTO mfs_transactions
             (tenant_id, invoice_id, student_id, provider, merchant_order_id, gateway_payment_id, gateway_trx_id,
              payer_msisdn, amount, status, response_payload, idempotency_key, completed_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12,
                   CASE WHEN $10 = 'completed' THEN now() ELSE NULL END)
           ON CONFLICT (tenant_id, merchant_order_id) DO UPDATE SET status = EXCLUDED.status
           RETURNING id`,
          [
            tenantId,
            invoiceId,
            invoice.student_id,
            provider,
            orderId,
            gatewayPaymentId,
            gatewayTrxId,
            msisdn,
            amount,
            status,
            JSON.stringify(payload),
            providerEventId,
          ],
        );
        txId = inserted.rows[0].id;
      }

      let invoiceStatus: string | null = null;
      if (status === 'completed' && !alreadyCompleted) {
        const applied = await client.query<{ status: string }>(
          `SELECT app.apply_payment_to_invoice($1, $2, $3) AS status`,
          [tenantId, invoiceId, amount],
        );
        invoiceStatus = applied.rows[0]?.status ?? null;
      }

      await client.query(
        `UPDATE mfs_webhook_events
            SET tenant_id = $2, mfs_transaction_id = $3, processing_state = 'processed', processed_at = now()
          WHERE id = $1`,
        [webhookRow.id, tenantId, txId],
      );

      return { outcome: 'processed' as const, txId, status, invoiceStatus };
    });

    if (result.outcome === 'rejected') {
      return { status: 200, body: { ok: true, note: result.reason } };
    }
    return {
      status: 200,
      body: { ok: true, transactionId: result.txId, status: result.status, invoiceStatus: result.invoiceStatus },
    };
  }
}
