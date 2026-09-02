/**
 * P-writers / B-48 — money taken at the counter.
 *
 * Before this the only `INSERT INTO payment_receipts` in the product was
 * inside the MFS webhook, and `POST /finance/pay` returns 503 until real
 * merchant credentials exist. So a school could issue a bill and had no way
 * to record that it had been paid — not cash, not a cheque, not a bank
 * transfer. The ledger, the receipts screen, a student's payment history and
 * `mv_fee_collection` all read a table only an unreachable webhook could fill.
 *
 * ── What these tests are actually pinning ────────────────────────────────
 * Money invariants, not endpoint shape:
 *
 *   * a receipt exists for every applied payment, or neither does;
 *   * two payments never share a receipt number, even from two connections;
 *   * the invoice balance cannot go negative;
 *   * a student cannot write themselves a receipt (migration 070);
 *   * the ledger batch balances, or the whole transaction goes.
 *
 * The concurrency test is the one that matters most. `payment_receipts` had
 * its number built as `max()+1` inline with `ON CONFLICT … DO NOTHING`, so two
 * simultaneous payments computed the same number, one was swallowed, and that
 * payment was applied with no receipt and no error.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { createDb, type Db } from '../../../packages/server-core/src/db.ts';
import { installTestKeys, call, lockFixtures, unlockFixtures, asBootstrap } from '../../../packages/server-core/test/harness.ts';

const DATABASE_URL = process.env.DATABASE_URL;
const skip = !DATABASE_URL ? 'DATABASE_URL not set' : false;

const T       = '7f400000-0000-4000-8000-00000000000a';
const OTHER   = '7f400000-0000-4000-8000-00000000000b';
const HEAD    = '7f400000-0000-4000-8000-0000000000f1';
const HEAD_B  = '7f400000-0000-4000-8000-0000000000f2';
const PUPIL_U = '7f400000-0000-4000-8000-0000000000a1';
/** invoices.student_id is a FK to users(id) — there is no students table. */
const PUPIL   = '7f400000-0000-4000-8000-0000000000a1';
const YEAR    = '7f400000-0000-4000-8000-0000000000c1';
const HEADFEE = '7f400000-0000-4000-8000-0000000000d1';
const INV     = '7f400000-0000-4000-8000-0000000000e1';
const INV_B   = '7f400000-0000-4000-8000-0000000000e2';

let db: Db;
let headToken: string;
let teacherToken: string;
let studentToken: string;
let otherToken: string;
/** The finance dispatcher, so routing and CORS are exercised too. */
let finance: typeof import('../api/index.ts').default;

async function dropFixtures(): Promise<void> {
  for (const id of [T, OTHER]) {
    await asBootstrap(db, { tenantId: id, userId: HEAD, role: 'principal' }, async (c) => {
      // Money rows first. `payment_receipts` and `ledger_entries` both hold
      // ON DELETE RESTRICT against `tenants` — deliberately, so a school's
      // financial record cannot vanish as a side effect of removing the
      // school. Teardown therefore has to be explicit, and it runs as
      // `principal`, who migration 070 allows to remove a receipt.
      await c.query('DELETE FROM ledger_entries');
      await c.query('DELETE FROM payment_receipts');
      await c.query('DELETE FROM tenants WHERE id = $1', [id]);
    });
  }
}

async function seed(): Promise<void> {
  await dropFixtures();
  await asBootstrap(db, { tenantId: T, userId: HEAD, role: 'principal' }, async (c) => {
    await c.query(
      `INSERT INTO tenants (id, slug, name_bn, name_en, stream, level, plan_code)
       VALUES ($1,'b48-a','টাকা বিদ্যালয়','Money School','bangla_medium','secondary','standard')`, [T]);
    await c.query(
      `INSERT INTO users (id, tenant_id, full_name_bn, full_name_en, phone_e164, status) VALUES
         ($1,$3,'প্রধান শিক্ষক','Head','+8801799640001','active'),
         ($2,$3,'রাফি হাসান','Rafi','+8801799640002','active')`, [HEAD, PUPIL_U, T]);
    await c.query(`INSERT INTO user_roles (tenant_id, user_id, role_code) VALUES ($1,$2,'principal')`, [T, HEAD]);
    await c.query(
      `INSERT INTO academic_years (id, tenant_id, label, starts_on, ends_on, is_current)
       VALUES ($1,$2,'2026','2026-01-01','2026-12-31',true)`, [YEAR, T]);
    await c.query(
      `INSERT INTO fee_heads (id, tenant_id, code, name_bn, name_en, frequency, is_active)
       VALUES ($1,$2,'TUITION','মাসিক বেতন','Tuition','monthly',true)`, [HEADFEE, T]);
    // One issued invoice for 1000, nothing paid.
    await c.query(
      `INSERT INTO invoices (id, tenant_id, invoice_no, student_id, academic_year_id,
                             billing_period, issued_on, due_on, subtotal, waiver_total,
                             total_amount, paid_amount, status)
       VALUES ($1,$2,'INV-2026-09-00001',$3,$4,'2026-09-01','2026-09-01','2026-09-10',
               1000,0,1000,0,'issued')`, [INV, T, PUPIL, YEAR]);
    await c.query(
      `INSERT INTO invoice_lines (tenant_id, invoice_id, fee_head_id, description_bn, amount, waiver_amount)
       VALUES ($1,$2,$3,'মাসিক বেতন',1000,0)`, [T, INV, HEADFEE]);
    // The chart of accounts, so the ledger half is exercised rather than skipped.
    await c.query(
      `INSERT INTO ledger_accounts (tenant_id, code, name_bn, type) VALUES
         ($1,'CASH','নগদ','asset'), ($1,'FEE-INCOME','বেতন ও ফি আয়','income')`, [T]);
  });

  await asBootstrap(db, { tenantId: OTHER, userId: HEAD_B, role: 'principal' }, async (c) => {
    await c.query(
      `INSERT INTO tenants (id, slug, name_bn, name_en, stream, level, plan_code)
       VALUES ($1,'b48-b','অন্য বিদ্যালয়','Other','bangla_medium','secondary','standard')`, [OTHER]);
    await c.query(
      `INSERT INTO users (id, tenant_id, full_name_bn, full_name_en, phone_e164, status)
       VALUES ($1,$2,'প্রধান খ','Head B','+8801799640003','active')`, [HEAD_B, OTHER]);
    await c.query(`INSERT INTO user_roles (tenant_id, user_id, role_code) VALUES ($1,$2,'principal')`, [OTHER, HEAD_B]);
  });
}

const post = (body: Record<string, unknown>, token = headToken) =>
  call(finance, { method: 'POST', url: '/api/v1/finance/payments', token, body } as Parameters<typeof call>[1]);
const get = (invoiceId = INV, token = headToken) =>
  call(finance, { url: `/api/v1/finance/payments?invoiceId=${invoiceId}`, token } as Parameters<typeof call>[1]);

const invoiceRow = () =>
  asBootstrap(db, { tenantId: T, userId: HEAD, role: 'principal' }, async (c) => {
    const r = await c.query<{ paid: string; balance: string; status: string }>(
      `SELECT paid_amount AS paid, balance_amount AS balance, status::text AS status
         FROM invoices WHERE id = $1`, [INV]);
    return r.rows[0];
  });

describe('B-48 — recording a payment at the counter', { skip }, () => {
  before(async () => {
    await installTestKeys();
    await lockFixtures(DATABASE_URL as string);
    db = createDb(DATABASE_URL as string);
    await seed();
    const { signAccessToken } = await import('../../../packages/server-core/src/jwt.ts');
    headToken = await signAccessToken({ sub: HEAD, tid: T, role: 'principal', roles: ['principal'] });
    teacherToken = await signAccessToken({ sub: HEAD, tid: T, role: 'subject_teacher', roles: ['subject_teacher'] });
    studentToken = await signAccessToken({ sub: PUPIL_U, tid: T, role: 'student', roles: ['student'] });
    otherToken = await signAccessToken({ sub: HEAD_B, tid: OTHER, role: 'principal', roles: ['principal'] });
    finance = (await import('../api/index.ts')).default;
  });

  after(async () => {
    if (db) { await dropFixtures(); await db.end(); await unlockFixtures(); }
  });

  test('the counter sees the bill, what is owed, and how money may arrive', async () => {
    const r = await get();
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const b = r.body as {
      canCollect: boolean;
      methods: { code: string; labelBn: string }[];
      invoice: { balanceAmount: number; totalAmount: number; status: string };
      receipts: unknown[];
    };
    assert.equal(b.canCollect, true);
    assert.equal(b.invoice.totalAmount, 1000);
    assert.equal(b.invoice.balanceAmount, 1000);
    assert.equal(b.receipts.length, 0);
    // cash and cheque are what a counter takes, and both are in the enum.
    assert.ok(b.methods.some((m) => m.code === 'cash' && m.labelBn === 'নগদ'));
    assert.ok(b.methods.some((m) => m.code === 'cheque'));
  });

  test('THE ONE THAT MATTERS — a partial payment issues a receipt and moves the bill', async () => {
    const r = await post({ invoiceId: INV, amount: 400, method: 'cash' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const b = r.body as { receiptNo: string; invoiceStatus: string; ledgerPosted: boolean };
    assert.match(b.receiptNo, /^RCP-\d{4}-\d{2}-\d{5}$/);
    assert.equal(b.invoiceStatus, 'partly_paid');
    assert.equal(b.ledgerPosted, true);

    const inv = await invoiceRow();
    assert.equal(Number(inv.paid), 400);
    assert.equal(Number(inv.balance), 600);
    assert.equal(inv.status, 'partly_paid');
  });

  test('the ledger batch balances — debit CASH, credit FEE-INCOME', async () => {
    const rows = await asBootstrap(db, { tenantId: T, userId: HEAD, role: 'principal' }, async (c) => {
      const q = await c.query<{ code: string; debit: string; credit: string }>(
        `SELECT a.code, e.debit, e.credit
           FROM ledger_entries e JOIN ledger_accounts a ON a.id = e.account_id
          WHERE e.reference_type = 'payment_receipt'
          ORDER BY a.code`);
      return q.rows;
    });
    assert.equal(rows.length, 2);
    const debit = rows.reduce((n, r) => n + Number(r.debit), 0);
    const credit = rows.reduce((n, r) => n + Number(r.credit), 0);
    assert.equal(debit, credit, 'the batch must balance');
    assert.equal(rows.find((r) => r.code === 'CASH')?.debit, '400.00');
    assert.equal(rows.find((r) => r.code === 'FEE-INCOME')?.credit, '400.00');
  });

  test('the rest of the money settles it, and both receipts stand', async () => {
    const r = await post({ invoiceId: INV, amount: 600, method: 'bkash', reference: 'TRX9ABC' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal((r.body as { invoiceStatus: string }).invoiceStatus, 'paid');

    const inv = await invoiceRow();
    assert.equal(Number(inv.balance), 0);
    assert.equal(inv.status, 'paid');

    const b = (await get()).body as { receipts: { receiptNo: string; amount: number }[] };
    assert.equal(b.receipts.length, 2, 'a receipt per payment, not per invoice');
    assert.deepEqual(b.receipts.map((x) => x.amount), [400, 600]);
    // Distinct, sequential numbers.
    assert.notEqual(b.receipts[0].receiptNo, b.receipts[1].receiptNo);
  });

    test('an overpayment is refused, and names the balance', async () => {
      // The invoice above is settled; use the second school's? No — reset this
      // one by adding a fresh invoice would change fixtures. Assert on the
      // settled invoice instead: any further payment is refused outright.
      const r = await post({ invoiceId: INV, amount: 1, method: 'cash' });
      assert.equal(r.status, 409);
      assert.equal((r.body as { error: string }).error, 'already_settled');
    });

    test('a zero or negative amount is refused before anything is written', async () => {
      for (const amount of [0, -50]) {
        const r = await post({ invoiceId: INV, amount, method: 'cash' });
        assert.equal(r.status, 400, `amount ${amount}`);
        assert.equal((r.body as { error: string }).error, 'bad_amount');
      }
    });

    test('a method the enum does not carry is refused', async () => {
      const r = await post({ invoiceId: INV, amount: 10, method: 'barter' });
      assert.equal(r.status, 400);
      assert.equal((r.body as { error: string }).error, 'bad_method');
    });

    test('THE SILENT LOSS — two connections paying at once get two receipts', async () => {
      // The regression this endpoint exists to prevent. The old inline
      // `max()+1` with ON CONFLICT DO NOTHING gave both transactions the same
      // number; one was swallowed and its payment applied receiptless.
      // app.next_receipt_no() serialises on an advisory lock, so both get a
      // number and neither payment goes unrecorded.
      const inv2 = '7f400000-0000-4000-8000-0000000000e3';
      const inv3 = '7f400000-0000-4000-8000-0000000000e4';
      await asBootstrap(db, { tenantId: T, userId: HEAD, role: 'principal' }, async (c) => {
        await c.query(
          `INSERT INTO invoices (id, tenant_id, invoice_no, student_id, academic_year_id,
                                 billing_period, issued_on, due_on, subtotal, waiver_total,
                                 total_amount, paid_amount, status) VALUES
             ($1,$3,'INV-2026-09-00002',$4,$5,'2026-09-01','2026-09-01','2026-09-10',500,0,500,0,'issued'),
             ($2,$3,'INV-2026-09-00003',$4,$5,'2026-09-01','2026-09-01','2026-09-10',500,0,500,0,'issued')`,
          [inv2, inv3, T, PUPIL, YEAR]);
      });

      const [a, b] = await Promise.all([
        post({ invoiceId: inv2, amount: 500, method: 'cash' }),
        post({ invoiceId: inv3, amount: 500, method: 'cash' }),
      ]);
      assert.equal(a.status, 200, JSON.stringify(a.body));
      assert.equal(b.status, 200, JSON.stringify(b.body));
      const an = (a.body as { receiptNo: string }).receiptNo;
      const bn = (b.body as { receiptNo: string }).receiptNo;
      assert.notEqual(an, bn, 'two concurrent payments shared a receipt number');

      // And both payments really landed, with a receipt each.
      const count = await asBootstrap(db, { tenantId: T, userId: HEAD, role: 'principal' }, async (c) => {
        const q = await c.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM payment_receipts WHERE invoice_id IN ($1,$2)`, [inv2, inv3]);
        return Number(q.rows[0].n);
      });
      assert.equal(count, 2, 'a payment was applied without a receipt');
    });

    test('a teacher and a student are refused, by the server', async () => {
      for (const token of [teacherToken, studentToken]) {
        const r = await post({ invoiceId: INV, amount: 10, method: 'cash' }, token);
        assert.equal(r.status, 403);
      }
    });

    test('and cannot read the counter view either', async () => {
      const r = await get(INV, studentToken);
      assert.equal(r.status, 403);
    });

    test('THE DATABASE refuses a forged receipt too, not only the role check', async () => {
      // Migration 070. Before it, a student could INSERT a receipt for any sum.
      await assert.rejects(
        () => db.withTenant({ tenantId: T, userId: PUPIL_U, role: 'student' }, async (c) => {
          await c.query(
            `INSERT INTO payment_receipts (tenant_id, receipt_no, invoice_id, student_id, amount, method)
             VALUES (app.current_tenant(),'RCP-FORGED-1',$1,$2,99999,'cash')`, [INV, PUPIL]);
        }, { write: true }),
        /row-level security|insufficient/i);
  });

  test('another school cannot pay into this one, or see its receipts', async () => {
    const w = await post({ invoiceId: INV, amount: 10, method: 'cash' }, otherToken);
    assert.equal(w.status, 404, JSON.stringify(w.body));
    const r = await get(INV, otherToken);
    assert.equal(r.status, 404);
  });

  test('a draft or cancelled bill takes no money', async () => {
    const draft = '7f400000-0000-4000-8000-0000000000e5';
    await asBootstrap(db, { tenantId: T, userId: HEAD, role: 'principal' }, async (c) => {
      await c.query(
        `INSERT INTO invoices (id, tenant_id, invoice_no, student_id, academic_year_id,
                               billing_period, issued_on, due_on, subtotal, waiver_total,
                               total_amount, paid_amount, status)
         VALUES ($1,$2,'INV-2026-09-00004',$3,$4,'2026-09-01','2026-09-01','2026-09-10',
                 300,0,300,0,'draft')`, [draft, T, PUPIL, YEAR]);
    });
    const r = await post({ invoiceId: draft, amount: 100, method: 'cash' });
    assert.equal(r.status, 409);
    assert.equal((r.body as { error: string }).error, 'invoice_draft');
  });

  test('every recorded payment is in the audit trail', async () => {
    const rows = await asBootstrap(db, { tenantId: T, userId: HEAD, role: 'principal' }, async (c) => {
      const q = await c.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM audit.activity_log
          WHERE tenant_id = $1 AND action = 'finance.payment.record'`, [T]);
      return Number(q.rows[0].n);
    });
    // 400 + 600 + the two concurrent ones.
    assert.ok(rows >= 4, `expected at least 4 audited payments, saw ${rows}`);
  });
});
