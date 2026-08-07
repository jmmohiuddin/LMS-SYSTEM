/**
 * Dynamic-route dispatcher for the fee engine: /api/v1/finance/{resource}.
 * One Vercel function (api/v1/finance/[resource].js) — see
 * services/identity-svc/api/index.ts for the Hobby-cap rationale. The MFS
 * webhooks stay in their own function (webhooks/[provider].ts): they carry
 * system-ingest auth, not user JWTs, and their URL is registered with the
 * gateways.
 *
 * Routes:
 *   GET  /api/v1/finance/invoices?studentId=...   invoices + lines. Staff see
 *        any student's; guardians/students are scoped by RLS invoice_scope
 *        (app.can_see_student), so authenticate() alone is the right gate.
 *   POST /api/v1/finance/pay                      { invoiceId, provider } —
 *        payment initiation. KILL-SWITCHED (MFS_PAYMENTS_ENABLED below):
 *        there are no live merchant credentials yet, so this returns 503
 *        mfs_disabled before any side effect, mirroring the OTP switch in
 *        services/identity-svc/api/otp-request.ts. The record-then-redirect
 *        flow it will run when enabled is documented inline.
 *   GET  /api/v1/finance/receipts?invoiceId=...   digital receipts for an
 *        invoice (payment_receipts rows as JSON; the PDF object key rides
 *        along when the PDF worker lands).
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { sharedDb } from '../../../packages/server-core/src/db.ts';
import { corsHeaders, query, readJson, json, HttpError } from '../../../packages/server-core/src/http.ts';
import { authenticate } from '../../../packages/server-core/src/auth.ts';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Kill switch: flip to `true` once real bKash/Nagad/Rocket merchant
// credentials exist in env and the initiation calls below are wired to the
// live gateways. While `false`, no mfs_transactions row is created.
const MFS_PAYMENTS_ENABLED = false;

async function invoices(req: IncomingMessage, res: ServerResponse, cors: Record<string, string>): Promise<void> {
  if (req.method !== 'GET') {
    json(res, 405, { error: 'method_not_allowed' }, cors);
    return;
  }
  const claims = await authenticate(req);
  const studentId = query(req).get('studentId') ?? '';
  if (studentId && !UUID_RE.test(studentId)) {
    throw new HttpError(400, 'studentId must be a valid uuid', 'invalid_student_id');
  }

  const db = await sharedDb();
  const rows = await db.withTenant(
    { tenantId: claims.tid, userId: claims.sub, role: claims.role },
    async (client) => {
      const r = await client.query<{
        id: string; invoice_no: string; student_id: string; billing_period: string | null;
        issued_on: string; due_on: string; subtotal: string; waiver_total: string;
        late_fee: string; total_amount: string; paid_amount: string; balance_amount: string;
        status: string; currency: string;
        lines: unknown;
      }>(
        `SELECT i.id, i.invoice_no, i.student_id, i.billing_period, i.issued_on, i.due_on,
                i.subtotal, i.waiver_total, i.late_fee, i.total_amount, i.paid_amount,
                i.balance_amount, i.status, i.currency,
                COALESCE(
                  (SELECT jsonb_agg(jsonb_build_object(
                     'descriptionBn', l.description_bn,
                     'amount', l.amount::text,
                     'waiverAmount', l.waiver_amount::text,
                     'netAmount', l.net_amount::text))
                     FROM invoice_lines l WHERE l.invoice_id = i.id),
                  '[]'::jsonb) AS lines
           FROM invoices i
          WHERE ($1::uuid IS NULL OR i.student_id = $1)
            AND i.status <> 'draft'
          ORDER BY i.issued_on DESC, i.invoice_no DESC
          LIMIT 100`,
        [studentId || null],
      );
      return r.rows;
    },
  );

  json(res, 200, {
    invoices: rows.map((r) => ({
      id: r.id,
      invoiceNo: r.invoice_no,
      studentId: r.student_id,
      billingPeriod: r.billing_period,
      issuedOn: r.issued_on,
      dueOn: r.due_on,
      // Money as decimal strings, per docs/03 conventions — never floats.
      subtotal: r.subtotal,
      waiverTotal: r.waiver_total,
      lateFee: r.late_fee,
      totalAmount: r.total_amount,
      paidAmount: r.paid_amount,
      balanceAmount: r.balance_amount,
      status: r.status,
      currency: r.currency,
      lines: r.lines,
    })),
  }, cors);
}

interface PayBody { invoiceId?: string; provider?: string }
const PAY_PROVIDERS = new Set(['bkash', 'nagad', 'rocket']);

async function pay(req: IncomingMessage, res: ServerResponse, cors: Record<string, string>): Promise<void> {
  if (req.method !== 'POST') {
    json(res, 405, { error: 'method_not_allowed' }, cors);
    return;
  }
  const claims = await authenticate(req);
  const body = await readJson<PayBody>(req);
  const invoiceId = body.invoiceId ?? '';
  const provider = body.provider ?? '';
  if (!UUID_RE.test(invoiceId)) throw new HttpError(400, 'invoiceId must be a valid uuid', 'invalid_invoice_id');
  if (!PAY_PROVIDERS.has(provider)) {
    throw new HttpError(400, `provider must be one of ${[...PAY_PROVIDERS].join(', ')}`, 'invalid_provider');
  }
  void claims;

  if (!MFS_PAYMENTS_ENABLED) {
    json(res, 503, {
      error: 'mfs_disabled',
      message: 'online fee payment is not yet available — pay at the school office',
    }, cors);
    return;
  }

  // When enabled, the flow is (docs/03 §2.2): INSERT an mfs_transactions row
  // (status 'initiated', merchant_order_id = our idempotency spine), call the
  // provider's create-payment API with that order id, store request/response
  // payloads on the row, and return the gateway redirect URL. Settlement then
  // arrives on /api/v1/finance/webhooks/{provider} — never trusted from here.
  json(res, 501, { error: 'not_implemented' }, cors);
}

async function receipts(req: IncomingMessage, res: ServerResponse, cors: Record<string, string>): Promise<void> {
  if (req.method !== 'GET') {
    json(res, 405, { error: 'method_not_allowed' }, cors);
    return;
  }
  const claims = await authenticate(req);
  const invoiceId = query(req).get('invoiceId') ?? '';
  if (!UUID_RE.test(invoiceId)) throw new HttpError(400, 'invoiceId must be a valid uuid', 'invalid_invoice_id');

  const db = await sharedDb();
  const rows = await db.withTenant(
    { tenantId: claims.tid, userId: claims.sub, role: claims.role },
    async (client) => {
      const r = await client.query<{
        id: string; receipt_no: string; amount: string; method: string;
        issued_at: string; gateway_trx_id: string | null; pdf_object_key: string | null;
      }>(
        `SELECT pr.id, pr.receipt_no, pr.amount, pr.method, pr.issued_at,
                mt.gateway_trx_id, pr.pdf_object_key
           FROM payment_receipts pr
           LEFT JOIN mfs_transactions mt ON mt.id = pr.mfs_transaction_id
          WHERE pr.invoice_id = $1
          ORDER BY pr.issued_at DESC`,
        [invoiceId],
      );
      return r.rows;
    },
  );

  json(res, 200, {
    receipts: rows.map((r) => ({
      id: r.id,
      receiptNo: r.receipt_no,
      amount: r.amount,
      method: r.method,
      issuedAt: r.issued_at,
      gatewayTrxId: r.gateway_trx_id,
      pdfObjectKey: r.pdf_object_key,
    })),
  }, cors);
}

const ROUTES: Record<string, (req: IncomingMessage, res: ServerResponse, cors: Record<string, string>) => Promise<void>> = {
  invoices,
  pay,
  receipts,
};

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const cors = corsHeaders();
  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors);
    res.end();
    return;
  }
  const path = new URL(req.url ?? '/', 'http://internal').pathname;
  const sub = path.split('/').filter(Boolean).pop() ?? '';
  const route = ROUTES[sub];
  if (!route) {
    json(res, 404, { error: 'not_found' }, cors);
    return;
  }
  try {
    await route(req, res, cors);
  } catch (err) {
    if (err instanceof HttpError) {
      json(res, err.status, { error: err.code ?? 'error', message: err.message }, cors);
      return;
    }
    console.error(`[finance/${sub}] unexpected error`, err);
    json(res, 500, { error: 'internal_error' }, cors);
  }
}
