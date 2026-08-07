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
import { authenticate, requireRole } from '../../../packages/server-core/src/auth.ts';

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

/* ------------------------------------------------------------ generate */

interface GenerateBody { billingPeriod?: string }
const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const BILLING_ROLES = ['principal', 'school_owner', 'accountant'];

/**
 * POST /api/v1/finance/generate — { billingPeriod: 'YYYY-MM' }
 *
 * Monthly invoice run: one invoice per actively-enrolled student, lines from
 * the monthly fee_structures matching the student's class (class-specific
 * beats class-wide), best applicable fee_waiver applied per line. Idempotent
 * per (student, billingPeriod): students already invoiced for the period are
 * skipped, so re-running after a partial failure only fills the gap. One
 * transaction; invoice_no is INV-<period>-<seq> within the tenant.
 */
async function generate(req: IncomingMessage, res: ServerResponse, cors: Record<string, string>): Promise<void> {
  if (req.method !== 'POST') {
    json(res, 405, { error: 'method_not_allowed' }, cors);
    return;
  }
  const claims = await authenticate(req);
  requireRole(claims, BILLING_ROLES);
  const body = await readJson<GenerateBody>(req);
  const period = body.billingPeriod ?? '';
  if (!PERIOD_RE.test(period)) {
    throw new HttpError(400, 'billingPeriod must be YYYY-MM', 'invalid_billing_period');
  }
  const periodStart = `${period}-01`;

  const db = await sharedDb();
  const result = await db.withTenant(
    { tenantId: claims.tid, userId: claims.sub, role: claims.role },
    async (client) => {
      const yearRes = await client.query<{ id: string }>(
        `SELECT id FROM academic_years
          WHERE $1::date BETWEEN starts_on AND ends_on
          ORDER BY starts_on DESC LIMIT 1`,
        [periodStart],
      );
      const yearId = yearRes.rows[0]?.id;
      if (!yearId) throw new HttpError(422, 'no academic year covers that billing period', 'no_academic_year');

      const lines = await client.query<{ invoice_id: string }>(
        `WITH eligible AS (
           SELECT en.student_id, en.section_id, s.class_id
             FROM enrolments en
             JOIN sections s ON s.id = en.section_id
            WHERE en.academic_year_id = $1
              AND en.status = 'active'
              AND NOT EXISTS (SELECT 1 FROM invoices i
                               WHERE i.student_id = en.student_id
                                 AND i.billing_period = $2)
         ),
         fee_lines AS (
           -- class-specific structure wins over the class-wide (NULL) one
           SELECT DISTINCT ON (e.student_id, fs.fee_head_id)
                  e.student_id, e.section_id, fs.fee_head_id, fh.name_bn,
                  fs.amount, fs.due_day_of_month
             FROM eligible e
             JOIN fee_structures fs
               ON fs.academic_year_id = $1
              AND (fs.class_id = e.class_id OR fs.class_id IS NULL)
              AND fs.quota_category IS NULL
             JOIN fee_heads fh
               ON fh.id = fs.fee_head_id AND fh.is_active AND fh.frequency = 'monthly'
            ORDER BY e.student_id, fs.fee_head_id, fs.class_id NULLS LAST
         ),
         waived AS (
           SELECT fl.*, LEAST(fl.amount, COALESCE(w.best, 0)) AS waiver_amount
             FROM fee_lines fl
             LEFT JOIN LATERAL (
               SELECT MAX(LEAST(fl.amount,
                                COALESCE(fw.flat_off, 0)
                                + fl.amount * COALESCE(fw.percent_off, 0) / 100)) AS best
                 FROM fee_waivers fw
                WHERE fw.student_id = fl.student_id
                  AND fw.academic_year_id = $1
                  AND (fw.fee_head_id = fl.fee_head_id OR fw.fee_head_id IS NULL)
                  AND fw.valid_from <= $3::date
                  AND (fw.valid_to IS NULL OR fw.valid_to >= $3::date)
             ) w ON true
         ),
         agg AS (
           SELECT student_id,
                  MIN(section_id::text)::uuid AS section_id,
                  SUM(amount) AS subtotal,
                  SUM(waiver_amount) AS waiver_total,
                  MIN(COALESCE(due_day_of_month, 10)) AS due_day
             FROM waived
            GROUP BY student_id
         ),
         numbered AS (
           SELECT a.*,
                  row_number() OVER (ORDER BY a.student_id) AS rn,
                  (SELECT count(*) FROM invoices i WHERE i.billing_period = $2) AS base
             FROM agg a
         ),
         new_inv AS (
           INSERT INTO invoices
             (tenant_id, invoice_no, student_id, academic_year_id, section_id,
              billing_period, issued_on, due_on, subtotal, waiver_total,
              total_amount, status)
           SELECT app.current_tenant(),
                  'INV-' || $2 || '-' || lpad((n.base + n.rn)::text, 5, '0'),
                  n.student_id, $1, n.section_id, $2,
                  CURRENT_DATE,
                  $3::date + (n.due_day - 1),
                  n.subtotal, n.waiver_total, n.subtotal - n.waiver_total, 'issued'
             FROM numbered n
           RETURNING id, student_id
         )
         INSERT INTO invoice_lines
           (tenant_id, invoice_id, fee_head_id, description_bn, amount, waiver_amount)
         SELECT app.current_tenant(), ni.id, w.fee_head_id, w.name_bn, w.amount, w.waiver_amount
           FROM waived w
           JOIN new_inv ni ON ni.student_id = w.student_id
         RETURNING invoice_id`,
        [yearId, period, periodStart],
      );

      const invoiceCount = new Set(lines.rows.map((r) => r.invoice_id)).size;
      return { invoicesCreated: invoiceCount, linesCreated: lines.rowCount ?? 0 };
    },
  );

  json(res, 200, { ok: true, billingPeriod: period, ...result }, cors);
}

const ROUTES: Record<string, (req: IncomingMessage, res: ServerResponse, cors: Record<string, string>) => Promise<void>> = {
  invoices,
  pay,
  receipts,
  generate,
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
