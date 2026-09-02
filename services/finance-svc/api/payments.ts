/**
 * POST /api/v1/finance/payments — record a payment taken at the office counter
 * GET  /api/v1/finance/payments?invoiceId=… — what has been paid against it
 *
 * ── Why this exists (P-writers, B-48) ────────────────────────────────────
 * The only `INSERT INTO payment_receipts` in the product was inside the MFS
 * webhook, and `POST /finance/pay` returns 503 until real merchant
 * credentials exist. So a school could issue an invoice and had **no way to
 * record that it had been paid** — not a cash payment at the counter, not a
 * cheque, not a bank transfer, not even a bKash the parent made from their own
 * phone and showed the office. The ledger, the receipts screen, the student's
 * payment history and `mv_fee_collection` all read a table that only an
 * unreachable webhook could fill.
 *
 * This is deliberately NOT the online payment flow. `POST /finance/pay` stays
 * kill-switched: initiating a gateway payment needs credentials this
 * deployment does not have, and faking it would be worse than refusing it.
 * What an office does today is take money by hand and write a receipt, and
 * that needs no gateway at all — `payment_receipts.method` has modelled
 * `cash`, `cheque` and `bank_transfer` since migration 007.
 *
 * ── Partial payments are the normal case ─────────────────────────────────
 * `payment_receipts` has no uniqueness on `invoice_id`, and
 * `app.apply_payment_to_invoice` sets `partly_paid` when the running total is
 * short — a family paying তিন কিস্তিতে gets three receipts against one
 * invoice, which is what Bangladeshi schools actually collect. So this
 * endpoint takes an amount rather than settling the invoice, and refuses only
 * an overpayment, because `invoices.balance_amount` is
 * `GENERATED ALWAYS AS (total_amount - paid_amount)` and would silently go
 * negative.
 *
 * ── One transaction, or nothing ──────────────────────────────────────────
 * Applying the payment, issuing the receipt and posting the two ledger rows
 * happen in one `withTenant({write:true})` transaction. The ledger's
 * `assert_ledger_balanced` constraint trigger fires at COMMIT, so an
 * unbalanced batch takes the whole thing down rather than leaving money
 * recorded against a book that does not add up.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { sharedDb } from '../../../packages/server-core/src/db.ts';
import { corsHeaders, query, json, readJson, HttpError } from '../../../packages/server-core/src/http.ts';
import { authenticate, requireRole } from '../../../packages/server-core/src/auth.ts';
import { writeAudit } from '../../../packages/server-core/src/audit.ts';

const SERVICE = 'finance';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Who may take money. The same three the invoice tables are scoped to
 * (migration 023) and that migration 070 gave `payment_receipts` — an
 * `it_admin` administers accounts, they do not stand at the counter.
 */
const COLLECT_ROLES = ['principal', 'school_owner', 'accountant'];

/**
 * `mfs_provider`, migration 007. The whole enum is offered: a school that
 * receives a bKash transfer to its own merchant number still records it by
 * hand, and refusing that here would push it into "cash" and corrupt the
 * reconciliation.
 */
const METHODS = ['cash', 'cheque', 'bank_transfer', 'bkash', 'nagad', 'rocket', 'upay'];

const METHOD_BN: Record<string, string> = {
  cash: 'নগদ', cheque: 'চেক', bank_transfer: 'ব্যাংক ট্রান্সফার',
  bkash: 'বিকাশ', nagad: 'নগদ (Nagad)', rocket: 'রকেট', upay: 'উপায়',
};

/** The ledger account that receives the money, by how it arrived. */
const ACCOUNT_FOR: Record<string, string> = {
  cash: 'CASH', cheque: 'CASH', bank_transfer: 'CASH',
  bkash: 'MFS-BKASH', nagad: 'MFS-NAGAD', rocket: 'MFS-ROCKET', upay: 'CASH',
};

export default async function handler(
  req: IncomingMessage, res: ServerResponse, cors: Record<string, string>,
): Promise<void> {
  const claims = await authenticate(req);
  const db = await sharedDb();
  const ctx = { tenantId: claims.tid, userId: claims.sub, role: claims.role, service: SERVICE };

  if (req.method === 'GET') {
    requireRole(claims, COLLECT_ROLES);
    json(res, 200, await list(db, ctx, req), cors);
    return;
  }
  if (req.method === 'POST') {
    requireRole(claims, COLLECT_ROLES);
    json(res, 200, await record(db, ctx, req), cors);
    return;
  }
  json(res, 405, { error: 'method_not_allowed' }, cors);
}

type Db = Awaited<ReturnType<typeof sharedDb>>;
type Ctx = { tenantId: string; userId: string; role: string; service: string };

/** Everything the counter needs to take a payment against one invoice. */
async function list(db: Db, ctx: Ctx, req: IncomingMessage): Promise<unknown> {
  const invoiceId = query(req).get('invoiceId') ?? '';
  if (!UUID_RE.test(invoiceId)) {
    throw new HttpError(400, 'কোন বিল তা জানানো হয়নি।', 'invoice_required', { field: 'invoiceId' });
  }
  return db.withTenant(ctx, async (c) => {
    const inv = await c.query<{
      id: string; invoice_no: string; student_id: string; student_bn: string;
      billing_period: string; total_amount: string; paid_amount: string;
      balance_amount: string; status: string; due_on: string | null;
    }>(
      `SELECT i.id, i.invoice_no, i.student_id, u.full_name_bn AS student_bn,
              i.billing_period, i.total_amount, i.paid_amount, i.balance_amount,
              i.status::text AS status, i.due_on
         FROM invoices i
         -- invoices.student_id is a FK to users(id) directly; there is no
         -- separate students table in this schema.
         JOIN users u ON u.id = i.student_id
        WHERE i.id = $1`,
      [invoiceId]);
    if (inv.rowCount === 0) {
      throw new HttpError(404, 'বিলটি পাওয়া যায়নি।', 'invoice_not_found');
    }
    const i = inv.rows[0];

    const receipts = await c.query<{
      id: string; receipt_no: string; amount: string; method: string;
      issued_at: string; issued_by_bn: string | null;
    }>(
      `SELECT r.id, r.receipt_no, r.amount, r.method::text AS method, r.issued_at,
              u.full_name_bn AS issued_by_bn
         FROM payment_receipts r
         LEFT JOIN users u ON u.id = r.issued_by
        WHERE r.invoice_id = $1
        ORDER BY r.issued_at`,
      [invoiceId]);

    return {
      canCollect: COLLECT_ROLES.includes(ctx.role),
      methods: METHODS.map((m) => ({ code: m, labelBn: METHOD_BN[m] ?? m })),
      invoice: {
        id: i.id, invoiceNo: i.invoice_no, studentId: i.student_id,
        studentBn: i.student_bn, billingPeriod: i.billing_period,
        totalAmount: Number(i.total_amount), paidAmount: Number(i.paid_amount),
        balanceAmount: Number(i.balance_amount), status: i.status, dueOn: i.due_on,
      },
      receipts: receipts.rows.map((r) => ({
        id: r.id, receiptNo: r.receipt_no, amount: Number(r.amount),
        method: r.method, methodBn: METHOD_BN[r.method] ?? r.method,
        issuedAt: r.issued_at, issuedByBn: r.issued_by_bn,
      })),
    };
  });
}

interface PayBody {
  invoiceId?: string;
  amount?: number | string;
  method?: string;
  reference?: string;
}

async function record(db: Db, ctx: Ctx, req: IncomingMessage): Promise<unknown> {
  const b = await readJson<PayBody>(req);
  const invoiceId = (b.invoiceId ?? '').trim();
  if (!UUID_RE.test(invoiceId)) {
    throw new HttpError(400, 'কোন বিল তা জানানো হয়নি।', 'invoice_required', { field: 'invoiceId' });
  }
  const method = (b.method ?? '').trim();
  if (!METHODS.includes(method)) {
    throw new HttpError(400, 'কীভাবে টাকা এসেছে তা বেছে নিন।', 'bad_method', { field: 'method' });
  }
  const amount = Number(b.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new HttpError(400, 'টাকার অঙ্ক শূন্যের বেশি হতে হবে।', 'bad_amount', { field: 'amount' });
  }
  // Two decimal places, as the column stores. Rounding here rather than
  // letting PostgreSQL do it keeps the receipt and the audit entry identical.
  const paid = Math.round(amount * 100) / 100;
  const reference = (b.reference ?? '').trim().slice(0, 120);

  return db.withTenant(ctx, async (c) => {
    const inv = await c.query<{
      student_id: string; invoice_no: string; balance_amount: string; status: string;
    }>(
      `SELECT student_id, invoice_no, balance_amount, status::text AS status
         FROM invoices WHERE id = $1`,
      [invoiceId]);
    if (inv.rowCount === 0) {
      throw new HttpError(404, 'বিলটি পাওয়া যায়নি।', 'invoice_not_found');
    }
    const invoice = inv.rows[0];

    if (invoice.status === 'cancelled') {
      throw new HttpError(409, 'বাতিল করা বিলে টাকা নেওয়া যায় না।', 'invoice_cancelled');
    }
    if (invoice.status === 'draft') {
      throw new HttpError(409, 'খসড়া বিলে টাকা নেওয়া যায় না — আগে বিলটি জারি করুন।', 'invoice_draft');
    }

    const balance = Number(invoice.balance_amount);
    if (balance <= 0) {
      throw new HttpError(409, 'এই বিলের সব টাকা ইতিমধ্যে পরিশোধিত।', 'already_settled');
    }
    if (paid > balance) {
      // `invoices.balance_amount` is a generated column over
      // (total_amount - paid_amount), so an overpayment would silently store
      // a negative balance rather than fail. Refusing names both numbers so
      // the clerk can see which one to correct.
      // Money is written with the ৳ prefix, never as a figure in front of a
      // Bangla counter word: R-8 settled that money and identifiers stay in
      // Latin digits while counts are Bangla, and apps/pwa/test/
      // bangla-numerals.test.ts enforces the boundary. It caught this line.
      throw new HttpError(409,
        `বকেয়া ৳${balance.toFixed(2)} — এর বেশি নেওয়া যাবে না।`,
        'over_payment', { field: 'amount', balance });
    }

    const applied = await c.query<{ status: string }>(
      `SELECT app.apply_payment_to_invoice(app.current_tenant(), $1, $2)::text AS status`,
      [invoiceId, paid]);
    const invoiceStatus = applied.rows[0].status;

    // No ON CONFLICT. The number comes from app.next_receipt_no(), which holds
    // an advisory lock on (tenant, month) while it allocates, so a collision
    // now means something is genuinely wrong — and a genuine collision must
    // fail the transaction rather than apply the money and issue nothing,
    // which is exactly what the webhook's `ON CONFLICT … DO NOTHING` did.
    const receipt = await c.query<{ id: string; receipt_no: string }>(
      `INSERT INTO payment_receipts
         (tenant_id, receipt_no, invoice_id, student_id, amount, method, issued_by)
       VALUES (app.current_tenant(), app.next_receipt_no(), $1, $2, $3, $4::mfs_provider, $5)
       RETURNING id, receipt_no`,
      [invoiceId, invoice.student_id, paid, method, ctx.userId]);
    const issued = receipt.rows[0];

    // Double entry: DEBIT where the money landed, CREDIT fee income. The
    // constraint trigger asserts the batch balances at COMMIT.
    //
    // Posting is skipped — not failed — when the chart of accounts has not
    // been seeded for this tenant, which mirrors what the MFS webhook already
    // does. A school without a chart still gets its receipt; the books are a
    // separate setup step, and refusing the payment over them would stop the
    // office collecting money for a bookkeeping reason.
    const code = ACCOUNT_FOR[method] ?? 'CASH';
    const accounts = await c.query<{ code: string; id: string }>(
      `SELECT code, id FROM ledger_accounts WHERE code IN ($1, 'FEE-INCOME')`, [code]);
    const bank = accounts.rows.find((r) => r.code === code)?.id;
    const income = accounts.rows.find((r) => r.code === 'FEE-INCOME')?.id;
    let ledgerBatchId: string | null = null;
    if (bank && income) {
      const memo = `${METHOD_BN[method] ?? method} — ${invoice.invoice_no}`
        + (reference ? ` (${reference})` : '');
      const batch = await c.query<{ id: string }>(
        `INSERT INTO ledger_entries
           (tenant_id, batch_id, account_id, entry_date, debit, credit,
            reference_type, reference_id, memo)
         VALUES (app.current_tenant(), gen_random_uuid(), $1, app.today_dhaka(),
                 $2, 0, 'payment_receipt', $3, $4)
         RETURNING batch_id AS id`,
        [bank, paid, issued.id, memo]);
      ledgerBatchId = batch.rows[0].id;
      await c.query(
        `INSERT INTO ledger_entries
           (tenant_id, batch_id, account_id, entry_date, debit, credit,
            reference_type, reference_id, memo)
         VALUES (app.current_tenant(), $1, $2, app.today_dhaka(), 0, $3,
                 'payment_receipt', $4, $5)`,
        [ledgerBatchId, income, paid, issued.id, memo]);
    }

    await writeAudit(c, ctx, {
      action: 'finance.payment.record',
      entityType: 'payment_receipt',
      entityId: issued.id,
      after: {
        receiptNo: issued.receipt_no, invoiceNo: invoice.invoice_no,
        amount: paid, method, reference: reference || null,
        invoiceStatus, ledgerPosted: ledgerBatchId !== null,
      },
    });

    return {
      ok: true,
      receiptId: issued.id,
      receiptNo: issued.receipt_no,
      amount: paid,
      method,
      methodBn: METHOD_BN[method] ?? method,
      invoiceStatus,
      // Honest about the books: a school whose chart was never seeded gets a
      // valid receipt and no ledger row, and the screen says so rather than
      // letting the accountant discover it at reconciliation.
      ledgerPosted: ledgerBatchId !== null,
    };
  }, { write: true });
}
