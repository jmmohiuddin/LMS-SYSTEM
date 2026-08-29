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
import { enforceRateLimit } from '../../../packages/server-core/src/rate-limit.ts';

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

      // R-2. Tell the guardians who can actually pay — 'guardians_payers',
      // not 'guardians': a payment reminder to someone with no authority to
      // pay is noise that costs an SMS.
      //
      // Idempotent on (tenant, 'invoice', md5(period)). The batch is
      // explicitly re-runnable (it is idempotent per student+period), so the
      // announcement has to be too, or a second run buzzes every parent
      // again. A uuid derived from the billing period is the natural key: one
      // announcement per month, whatever happens to the batch.
      //
      // Nothing is announced when the batch created no invoices — "your fees
      // are ready" about nothing is worse than silence.
      let notified = 0;
      if (invoiceCount > 0) {
        const emitted = await client.query<{ recipients: number }>(
          `SELECT recipients FROM app.emit_auto_notice(
             'invoice', md5('invoice:' || $1::text)::uuid, $2, $3,
             'fee'::notice_category, '{"type":"guardians_payers"}'::jsonb, false)`,
          [
            period,
            `${period} মাসের বেতন ও ফি প্রস্তুত`,
            'অ্যাপের বেতন ও ফি অংশে ইনভয়েস ও পরিশোধের শেষ তারিখ দেখা যাবে।',
          ],
        );
        notified = emitted.rows[0]?.recipients ?? 0;
      }

      return { invoicesCreated: invoiceCount, linesCreated: lines.rowCount ?? 0, notified };
    },
  );

  json(res, 200, { ok: true, billingPeriod: period, ...result }, cors);
}

/* ------------------------------------------------------------- ledger */

const LEDGER_ROLES = ['principal', 'school_owner', 'accountant'];

/**
 * GET /api/v1/finance/ledger — the read side that feeds the Ledger page.
 *
 * Returns everything the UI needs to render in one round trip:
 *   - accounts[] — chart of accounts with running balances (income accounts
 *     naturally net credit, so we show CR - DR for display)
 *   - batches[] — the ~50 most recent posting batches, one entry per line
 *   - reconciliation[] — posted amount per MFS provider vs. what has been
 *     marked reconciled_at (parked at now() by the webhook on completion,
 *     so posted == reconciled for straight-through payments)
 *
 * Principal / owner / accountant only, matching ledger_scope in
 * db/migrations/010_rls_policies.sql — RLS is the real gate, requireRole
 * turns it into a clean 403.
 */
async function ledger(req: IncomingMessage, res: ServerResponse, cors: Record<string, string>): Promise<void> {
  if (req.method !== 'GET') {
    json(res, 405, { error: 'method_not_allowed' }, cors);
    return;
  }
  const claims = await authenticate(req);
  requireRole(claims, LEDGER_ROLES);

  const db = await sharedDb();
  const payload = await db.withTenant(
    { tenantId: claims.tid, userId: claims.sub, role: claims.role },
    async (client) => {
      const accountsRes = await client.query<{
        code: string; name_bn: string; type: string; balance: string;
      }>(
        `SELECT a.code, a.name_bn, a.type,
                CASE WHEN a.type IN ('income','liability','equity')
                     THEN COALESCE(SUM(e.credit - e.debit), 0)
                     ELSE COALESCE(SUM(e.debit - e.credit), 0)
                END::text AS balance
           FROM ledger_accounts a
           LEFT JOIN ledger_entries e ON e.account_id = a.id
          GROUP BY a.id, a.code, a.name_bn, a.type
          ORDER BY a.type, a.code`,
      );

      const batchesRes = await client.query<{
        batch_id: string; entry_date: string; memo: string;
        account_code: string; debit: string; credit: string;
      }>(
        `WITH recent AS (
           SELECT DISTINCT batch_id, MAX(created_at) AS created_at
             FROM ledger_entries
            GROUP BY batch_id
            ORDER BY MAX(created_at) DESC
            LIMIT 50
         )
         SELECT e.batch_id::text,
                e.entry_date::text,
                COALESCE(e.memo, '') AS memo,
                a.code AS account_code,
                e.debit::text,
                e.credit::text
           FROM ledger_entries e
           JOIN recent r ON r.batch_id = e.batch_id
           JOIN ledger_accounts a ON a.id = e.account_id
          ORDER BY r.created_at DESC, e.created_at`,
      );

      const reconRes = await client.query<{ provider: string; posted: string; reconciled: string }>(
        `SELECT provider::text,
                COALESCE(SUM(amount), 0)::text AS posted,
                COALESCE(SUM(amount) FILTER (WHERE reconciled_at IS NOT NULL), 0)::text AS reconciled
           FROM mfs_transactions
          WHERE status = 'completed'
          GROUP BY provider
          ORDER BY provider`,
      );

      // Group batch rows into {batchId, entryDate, memo, lines[]}.
      type Line = { accountCode: string; debit: string; credit: string };
      type Batch = { batchId: string; entryDate: string; memo: string; lines: Line[] };
      const byBatch = new Map<string, Batch>();
      for (const row of batchesRes.rows) {
        let b = byBatch.get(row.batch_id);
        if (!b) {
          b = { batchId: row.batch_id, entryDate: row.entry_date, memo: row.memo, lines: [] };
          byBatch.set(row.batch_id, b);
        }
        b.lines.push({ accountCode: row.account_code, debit: row.debit, credit: row.credit });
      }

      const PROVIDER_LABEL: Record<string, string> = {
        bkash: 'bKash', nagad: 'Nagad', rocket: 'Rocket', upay: 'Upay',
        bank_transfer: 'Bank', cash: 'Cash', cheque: 'Cheque',
      };

      return {
        accounts: accountsRes.rows.map((a) => ({
          code: a.code,
          nameBn: a.name_bn,
          type: a.type as 'asset' | 'liability' | 'equity' | 'income' | 'expense',
          balance: a.balance,
        })),
        batches: [...byBatch.values()],
        reconciliation: reconRes.rows.map((r) => ({
          provider: PROVIDER_LABEL[r.provider] ?? r.provider,
          posted: r.posted,
          reconciled: r.reconciled,
        })),
      };
    },
  );

  json(res, 200, payload, cors);
}

const ROUTES: Record<string, (req: IncomingMessage, res: ServerResponse, cors: Record<string, string>) => Promise<void>> = {
  invoices,
  pay,
  receipts,
  generate,
  ledger,
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
  // F-102, IP dimension. Charged before authenticate() so an unauthenticated
  // flood costs one bucket update rather than a JWT verification plus a
  // connection. `generate` is a whole-school invoice run, but it is already
  // role-gated and idempotent per period, so it needs no class of its own.
  {
    const cls = req.method === 'GET' ? 'read' : 'mutation';
    if (!(await enforceRateLimit(req, res, cors, cls))) return;
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
