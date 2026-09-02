/**
 * P0/A2 — the price list, and the invoice it finally produces.
 *
 * ── What was wrong ──────────────────────────────────────────────────────
 * `fee_structures` had **zero rows across 126 institutions** and no writer
 * anywhere. The monthly invoice run joins it, so
 * `POST /api/v1/finance/generate` produced zero invoices for every school,
 * every month, and returned success while doing it. A school could enrol
 * students and take attendance and could not charge a single taka.
 *
 * And the table was writable by anybody: `fee_heads`, `fee_structures` and
 * `fee_waivers` carried `tenant_isolation` and no role scope, so a session
 * holding `app.role = 'student'` could set its own tuition to zero. Proved
 * against a live database before migration 067, and proved refused after.
 *
 * ── The test that matters ───────────────────────────────────────────────
 * Not "a row was inserted". The last test writes a price through the endpoint
 * and then runs the REAL invoice engine, and asserts a real invoice comes out
 * with the right amount on it. A price list nothing bills is the defect this
 * phase exists to close, one level up.
 *
 *   DATABASE_URL=postgres://… node --test services/finance-svc/test/fee-structures.test.ts
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { createDb, type Db, type TenantContext } from '../../../packages/server-core/src/db.ts';
import { installTestKeys, call, lockFixtures, unlockFixtures, asBootstrap } from '../../../packages/server-core/test/harness.ts';

const DATABASE_URL = process.env.DATABASE_URL;
const skip = !DATABASE_URL ? 'DATABASE_URL not set' : false;

const T       = '7f300000-0000-4000-8000-00000000000a';
const OTHER   = '7f300000-0000-4000-8000-00000000000b';
const HEAD    = '7f300000-0000-4000-8000-0000000000f1';
const TEACHER = '7f300000-0000-4000-8000-0000000000a1';
const HEAD_B  = '7f300000-0000-4000-8000-0000000000f2';
const YEAR    = '7f300000-0000-4000-8000-0000000000c1';
const YEAR_B  = '7f300000-0000-4000-8000-0000000000c2';
const CLASS9  = '7f300000-0000-4000-8000-0000000000d1';
const SEC_KA  = '7f300000-0000-4000-8000-0000000000e1';
const STU     = '7f300000-0000-4000-8000-00000000aa01';
const GUARD   = '7f300000-0000-4000-8000-00000000bb01';
/** A monthly head and a one-time head, so the honesty flag has both cases. */
const HEAD_TUITION   = '7f300000-0000-4000-8000-00000000cc01';
const HEAD_ADMISSION = '7f300000-0000-4000-8000-00000000cc02';
const HEAD_B_TUITION = '7f300000-0000-4000-8000-00000000cc03';

/** The billing period the invoice run is asked for — inside the fixture year. */
const PERIOD = '2026-03';

let db: Db;
let finance: typeof import('../api/index.ts').default;
let headToken = '';
let teacherToken = '';
let headBToken = '';

const asHead: TenantContext = { tenantId: T, userId: HEAD, role: 'principal' };
const asHeadB: TenantContext = { tenantId: OTHER, userId: HEAD_B, role: 'principal' };

async function drop(): Promise<void> {
  for (const ctx of [asHead, asHeadB]) {
    await asBootstrap(db, ctx, (c) => c.query('DELETE FROM tenants WHERE id = $1', [ctx.tenantId]));
  }
}

async function seed(): Promise<void> {
  await drop();

  await asBootstrap(db, asHead, async (c) => {
    await c.query(
      // The finance service is only in the standard and complete plans — the
      // default pilot plan does not carry it, and withTenant refuses the whole
      // endpoint with tenant_blocked. A school that wants fee management buys
      // a plan that has it, so the fixture is created holding one.
      //
      // Set in the INSERT rather than a following UPDATE: migration 069 made
      // plan_code platform-owned, so `UPDATE tenants SET plan_code` from the
      // application role is refused — which is the point of it. A school
      // cannot upgrade its own plan, and neither can a fixture pretending to
      // be one.
      `INSERT INTO tenants (id, slug, name_bn, name_en, stream, level, plan_code)
       VALUES ($1,'p0-fee-a','ফি বিদ্যালয়','Fee School','bangla_medium','secondary','standard')`, [T]);
    await c.query(
      `INSERT INTO users (id, tenant_id, full_name_bn, full_name_en, phone_e164, status) VALUES
         ($1,$3,'প্রধান শিক্ষক','Head','+8801799680001','active'),
         ($2,$3,'রফিক স্যার','Rafiq','+8801799680002','active')`, [HEAD, TEACHER, T]);
    await c.query(
      `INSERT INTO user_roles (tenant_id, user_id, role_code) VALUES
         ($1,$2,'principal'), ($1,$3,'subject_teacher')`, [T, HEAD, TEACHER]);

    await c.query(
      `INSERT INTO academic_years (id, tenant_id, label, starts_on, ends_on, is_current)
       VALUES ($1,$2,'২০২৬','2026-01-01','2026-12-31',true)`, [YEAR, T]);
    await c.query(
      `INSERT INTO classes (id, tenant_id, level_no, name_bn, name_en, stream)
       VALUES ($1,$2,9,'নবম','Nine','bangla_medium')`, [CLASS9, T]);
    await c.query(
      `INSERT INTO sections (id, tenant_id, class_id, academic_year_id, name, capacity)
       VALUES ($1,$2,$3,$4,'ক',40)`, [SEC_KA, T, CLASS9, YEAR]);

    // One monthly head and one one-time head. Only the monthly one is billed
    // by the monthly run, and the endpoint has to say so rather than hide it.
    await c.query(
      `INSERT INTO fee_heads (id, tenant_id, code, name_bn, name_en, frequency, is_active) VALUES
         ($1,$3,'TUITION','মাসিক বেতন','Tuition','monthly',true),
         ($2,$3,'ADMISSION','ভর্তি ফি','Admission','one_time',true)`,
      [HEAD_TUITION, HEAD_ADMISSION, T]);

    // One student with a contactable guardian (migration 031).
    await c.query(
      `INSERT INTO users (id, tenant_id, full_name_bn, full_name_en, status)
       VALUES ($1,$2,'আনিকা','Anika','active')`, [STU, T]);
    await c.query(`INSERT INTO user_roles (tenant_id, user_id, role_code) VALUES ($1,$2,'student')`, [T, STU]);
    await c.query(
      `INSERT INTO users (id, tenant_id, full_name_bn, full_name_en, phone_e164, status)
       VALUES ($1,$2,'আনিকার বাবা','Father','+8801799680003','active')`, [GUARD, T]);
    await c.query(`INSERT INTO user_roles (tenant_id, user_id, role_code) VALUES ($1,$2,'guardian')`, [T, GUARD]);
    await c.query(
      `INSERT INTO guardianships (tenant_id, student_id, guardian_id, relation, is_primary)
       VALUES ($1,$2,$3,'father',true)`, [T, STU, GUARD]);
    await c.query(
      `INSERT INTO enrolments (tenant_id, student_id, section_id, academic_year_id, roll_no, status)
       VALUES ($1,$2,$3,$4,1,'active')`, [T, STU, SEC_KA, YEAR]);
  });

  await asBootstrap(db, asHeadB, async (c) => {
    await c.query(
      `INSERT INTO tenants (id, slug, name_bn, name_en, stream, level, plan_code)
       VALUES ($1,'p0-fee-b','অন্য বিদ্যালয়','Other','bangla_medium','secondary','standard')`, [OTHER]);
    await c.query(
      `INSERT INTO users (id, tenant_id, full_name_bn, full_name_en, phone_e164, status)
       VALUES ($1,$2,'প্রধান খ','Head B','+8801799680004','active')`, [HEAD_B, OTHER]);
    await c.query(`INSERT INTO user_roles (tenant_id, user_id, role_code) VALUES ($1,$2,'principal')`,
      [OTHER, HEAD_B]);
    await c.query(
      `INSERT INTO academic_years (id, tenant_id, label, starts_on, ends_on, is_current)
       VALUES ($1,$2,'২০২৬','2026-01-01','2026-12-31',true)`, [YEAR_B, OTHER]);
    await c.query(
      `INSERT INTO fee_heads (id, tenant_id, code, name_bn, name_en, frequency, is_active)
       VALUES ($1,$2,'TUITION','মাসিক বেতন','Tuition','monthly',true)`, [HEAD_B_TUITION, OTHER]);
  });
}

describe('P0/A2 — the price list', { skip }, () => {
  before(async () => {
    await installTestKeys();
    await lockFixtures(DATABASE_URL as string);
    db = createDb(DATABASE_URL as string);
    await seed();

    const { signAccessToken } = await import('../../../packages/server-core/src/jwt.ts');
    headToken = await signAccessToken({ sub: HEAD, tid: T, role: 'principal', roles: ['principal'] });
    teacherToken = await signAccessToken({ sub: TEACHER, tid: T, role: 'subject_teacher', roles: ['subject_teacher'] });
    headBToken = await signAccessToken({ sub: HEAD_B, tid: OTHER, role: 'principal', roles: ['principal'] });

    finance = (await import('../api/index.ts')).default;
  });

  after(async () => { if (db) { await drop(); await db.end(); await unlockFixtures(); } });

  const list = (token: string, yearId?: string) =>
    call(finance, {
      method: 'GET',
      url: `/api/v1/finance/feestructures${yearId ? `?yearId=${yearId}` : ''}`,
      token,
    } as Parameters<typeof call>[1]);
  const post = (token: string, body: unknown) =>
    call(finance, { method: 'POST', url: '/api/v1/finance/feestructures', token, body } as Parameters<typeof call>[1]);
  const patch = (token: string, body: unknown) =>
    call(finance, { method: 'PATCH', url: '/api/v1/finance/feestructures', token, body } as Parameters<typeof call>[1]);
  const del = (token: string, id: string) =>
    call(finance, { method: 'DELETE', url: `/api/v1/finance/feestructures?id=${id}`, token } as Parameters<typeof call>[1]);
  const generate = (token: string) =>
    call(finance, {
      method: 'POST', url: '/api/v1/finance/generate', token, body: { billingPeriod: PERIOD },
    } as Parameters<typeof call>[1]);

  let structureId = '';

  test('THE ONE THAT MATTERS — a school with no price list can set one', async () => {
    const empty = await list(headToken);
    assert.equal(empty.status, 200, JSON.stringify(empty.body));
    const b0 = empty.body as {
      structures: unknown[]; canManage: boolean;
      heads: Array<{ id: string; frequency: string }>; academicYearId: string;
    };
    assert.deepEqual(b0.structures, [], 'this school has never priced anything');
    assert.equal(b0.canManage, true);
    assert.equal(b0.academicYearId, YEAR, 'the current year is chosen without being asked for');
    assert.ok(b0.heads.length >= 2, 'the seeded fee heads are offered');

    const made = await post(headToken, {
      feeHeadId: HEAD_TUITION, academicYearId: YEAR, classId: CLASS9,
      amount: 1200, dueDayOfMonth: 10, lateFeePerDay: 5, lateFeeCap: 100,
    });
    assert.equal(made.status, 200, JSON.stringify(made.body));
    structureId = (made.body as { id: string }).id;

    const after = await list(headToken);
    const rows = (after.body as { structures: Array<Record<string, unknown>> }).structures;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].amount, 1200);
    assert.equal(rows[0].dueDayOfMonth, 10);
    assert.equal(rows[0].classBn, 'নবম', 'the class is named, not shown as a uuid');
    assert.equal(rows[0].billedByMonthlyRun, true);
  });

  test('a price on a non-monthly head says it will not be billed monthly', async () => {
    // The engine joins `fh.frequency = 'monthly'`. A price against a one-time
    // head is stored and never invoiced by the monthly run, and the row has to
    // say so — otherwise it is a control that silently does nothing.
    const made = await post(headToken, {
      feeHeadId: HEAD_ADMISSION, academicYearId: YEAR, amount: 5000,
    });
    assert.equal(made.status, 200, JSON.stringify(made.body));

    const rows = ((await list(headToken)).body as { structures: Array<Record<string, unknown>> }).structures;
    const admission = rows.find((r) => r.headCode === 'ADMISSION');
    assert.equal(admission?.billedByMonthlyRun, false,
      'a one-time head must not claim it is billed monthly');
    const tuition = rows.find((r) => r.headCode === 'TUITION');
    assert.equal(tuition?.billedByMonthlyRun, true);
  });

  test('the same fee cannot be priced twice for one class in one year', async () => {
    const dup = await post(headToken, {
      feeHeadId: HEAD_TUITION, academicYearId: YEAR, classId: CLASS9, amount: 999,
    });
    assert.equal(dup.status, 409, JSON.stringify(dup.body));
    assert.equal((dup.body as { error: string }).error, 'duplicate_structure');
    assert.match((dup.body as { message: string }).message, /[ঀ-৿]/);
  });

  test('a school-wide price and a class price coexist — the class one wins', async () => {
    // NULL class_id is the school-wide default; the engine orders
    // `class_id NULLS LAST`, so a class row overrides it. Both must be storable.
    const wide = await post(headToken, {
      feeHeadId: HEAD_TUITION, academicYearId: YEAR, classId: null, amount: 900, dueDayOfMonth: 10,
    });
    assert.equal(wide.status, 200, JSON.stringify(wide.body));

    const rows = ((await list(headToken)).body as { structures: Array<Record<string, unknown>> }).structures;
    const tuitions = rows.filter((r) => r.headCode === 'TUITION');
    assert.equal(tuitions.length, 2);
    assert.ok(tuitions.some((r) => r.classId === null && r.amount === 900));
    assert.ok(tuitions.some((r) => r.classId === CLASS9 && r.amount === 1200));
  });

  test('bad input is refused in Bangla, names the field, and writes nothing', async () => {
    const before = ((await list(headToken)).body as { structures: unknown[] }).structures.length;

    for (const [body, code, field] of [
      [{ academicYearId: YEAR, amount: 100 }, 'bad_head', 'feeHeadId'],
      [{ feeHeadId: HEAD_TUITION, amount: 100 }, 'bad_year', 'academicYearId'],
      [{ feeHeadId: HEAD_TUITION, academicYearId: YEAR }, 'bad_amount', 'amount'],
      [{ feeHeadId: HEAD_TUITION, academicYearId: YEAR, amount: -5 }, 'bad_amount', 'amount'],
      [{ feeHeadId: HEAD_TUITION, academicYearId: YEAR, amount: 99999999 }, 'bad_amount', 'amount'],
      [{ feeHeadId: HEAD_TUITION, academicYearId: YEAR, amount: 100, dueDayOfMonth: 31 }, 'bad_due_day', 'dueDayOfMonth'],
      [{ feeHeadId: HEAD_TUITION, academicYearId: YEAR, amount: 100, dueDayOfMonth: 0 }, 'bad_due_day', 'dueDayOfMonth'],
      [{ feeHeadId: HEAD_TUITION, academicYearId: YEAR, amount: 100, classId: 'not-a-uuid' }, 'bad_class', 'classId'],
    ] as const) {
      const r = await post(headToken, body);
      assert.equal(r.status, 400, `${JSON.stringify(body)} -> ${JSON.stringify(r.body)}`);
      const out = r.body as { error: string; message: string; field?: string };
      assert.equal(out.error, code, JSON.stringify(body));
      assert.equal(out.field, field, 'the form must be able to mark the offending box');
      assert.match(out.message, /[ঀ-৿]/, `not Bangla: ${out.message}`);
      assert.ok(!/violates|constraint|SQLSTATE|invalid input syntax/i.test(out.message), out.message);
    }

    assert.equal(((await list(headToken)).body as { structures: unknown[] }).structures.length, before,
      'a refused create must leave nothing behind');
  });

  test('editing carries the unnamed fields across', async () => {
    // The room writer shipped with the opposite bug and its own test caught
    // it: omitted fields fell through to create-time defaults, so changing one
    // thing silently reset another.
    const r = await patch(headToken, { id: structureId, amount: 1500 });
    assert.equal(r.status, 200, JSON.stringify(r.body));

    const row = ((await list(headToken)).body as { structures: Array<Record<string, unknown>> })
      .structures.find((x) => x.id === structureId);
    assert.equal(row?.amount, 1500);
    assert.equal(row?.dueDayOfMonth, 10, 'the due day must survive an amount-only edit');
    assert.equal(row?.lateFeePerDay, 5, 'and so must the late fee');
  });

  test('a teacher may READ the price list but not write it', async () => {
    const read = await list(teacherToken);
    assert.equal(read.status, 200, 'a class teacher fielding a fee question needs it');
    assert.equal((read.body as { canManage: boolean }).canManage, false,
      'and the screen must be told, rather than discovering it on submit');

    for (const r of [
      await post(teacherToken, { feeHeadId: HEAD_TUITION, academicYearId: YEAR, amount: 1 }),
      await patch(teacherToken, { id: structureId, amount: 1 }),
      await del(teacherToken, structureId),
    ]) {
      assert.equal(r.status, 403, JSON.stringify(r.body));
    }
  });

  test('THE DATABASE refuses the write too, not only the role check', async () => {
    // Migration 067. Before it a student could set their own tuition to zero.
    const asStudent: TenantContext = { tenantId: T, userId: STU, role: 'student' };
    await assert.rejects(
      () => db.withTenant(asStudent, (c) => c.query(
        `INSERT INTO fee_structures (tenant_id, fee_head_id, academic_year_id, amount)
         VALUES (app.current_tenant(), $1, $2, 0)`, [HEAD_TUITION, YEAR])),
      /fee_structures_insert_scope|row-level security/i);

    // And a student must still be able to READ the heads behind their invoice.
    const heads = await db.withTenant(asStudent, async (c) => {
      const { rows } = await c.query<{ n: string }>(`SELECT count(*)::text AS n FROM fee_heads`);
      return Number(rows[0].n);
    });
    assert.ok(heads >= 2, 'the per-command policy must not have hidden fee heads from students');
  });

  test('another school cannot see or touch this price list', async () => {
    const theirs = await list(headBToken);
    assert.equal(theirs.status, 200);
    assert.deepEqual((theirs.body as { structures: unknown[] }).structures, [],
      'RLS returns no rows, rather than another school’s prices');

    // Forged ids: school A's head and year named by school B.
    const forged = await post(headBToken, {
      feeHeadId: HEAD_TUITION, academicYearId: YEAR, amount: 1,
    });
    assert.equal(forged.status, 404, JSON.stringify(forged.body));

    assert.equal((await patch(headBToken, { id: structureId, amount: 1 })).status, 404);
    assert.equal((await del(headBToken, structureId)).status, 404);

    // School A's price is untouched.
    const mine = ((await list(headToken)).body as { structures: Array<Record<string, unknown>> })
      .structures.find((x) => x.id === structureId);
    assert.equal(mine?.amount, 1500);
  });

  test('THE POINT OF ALL THIS — a price set here produces a real invoice', async () => {
    // Not "a row was inserted". The existing invoice engine, unchanged, run
    // over the price this endpoint wrote. Before A2 it returned success and
    // billed nothing, because the table it joins was empty.
    const before = await asBootstrap(db, asHead, async (c) => {
      const { rows } = await c.query<{ n: string }>(`SELECT count(*)::text AS n FROM invoices`);
      return Number(rows[0].n);
    });
    assert.equal(before, 0, 'this school has never issued an invoice');

    const run = await generate(headToken);
    assert.equal(run.status, 200, JSON.stringify(run.body));

    const out = await asBootstrap(db, asHead, async (c) => {
      const inv = await c.query<{
        invoice_no: string; total_amount: string; due_on: string; student_id: string;
      }>(`SELECT invoice_no, total_amount, due_on, student_id FROM invoices`);
      const lines = await c.query<{ description_bn: string; amount: string }>(
        `SELECT description_bn, amount FROM invoice_lines`);
      return { inv: inv.rows, lines: lines.rows };
    });

    assert.equal(out.inv.length, 1, 'one actively-enrolled student, one invoice');
    assert.equal(out.inv[0].student_id, STU);
    // 1500 from the class-specific tuition — NOT 900, the school-wide row, and
    // NOT 5000, the one-time admission head the monthly run must ignore.
    assert.equal(Number(out.inv[0].total_amount), 1500,
      'the class price beats the school-wide one, and a one-time head is not billed');
    assert.match(out.inv[0].invoice_no, /^INV-2026-03-\d{5}$/);
    assert.equal(out.inv[0].due_on, '2026-03-10', 'due_day_of_month reached the invoice');

    assert.equal(out.lines.length, 1, 'only the monthly head produced a line');
    assert.equal(out.lines[0].description_bn, 'মাসিক বেতন');
  });

  test('removing a price does not touch an invoice already issued', async () => {
    // invoice_lines stores its own amounts and does not reference
    // fee_structures, so this is safe — and it is the question an accountant
    // will ask before pressing the button.
    const r = await del(headToken, structureId);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal((r.body as { issuedInvoicesUnaffected: boolean }).issuedInvoicesUnaffected, true);

    const still = await asBootstrap(db, asHead, async (c) => {
      const { rows } = await c.query<{ n: string; total: string }>(
        `SELECT count(*)::text AS n, COALESCE(sum(total_amount),0)::text AS total FROM invoices`);
      return rows[0];
    });
    assert.equal(Number(still.n), 1, 'the invoice survives');
    assert.equal(Number(still.total), 1500, 'and still says what it said');

    const gone = ((await list(headToken)).body as { structures: Array<{ id: string }> })
      .structures.find((x) => x.id === structureId);
    assert.equal(gone, undefined, 'the price itself is gone');
  });

  test('every action is audited with what changed', async () => {
    const acts = await asBootstrap(db, asHead, async (c) => {
      const { rows } = await c.query<{ action: string }>(
        `SELECT action FROM audit.activity_log
          WHERE entity_type = 'fee_structure' ORDER BY created_at`);
      return rows.map((r) => r.action);
    });
    assert.ok(acts.includes('finance.fee_structure.create'));
    assert.ok(acts.includes('finance.fee_structure.update'));
    assert.ok(acts.includes('finance.fee_structure.delete'));

    const entry = await asBootstrap(db, asHead, async (c) => {
      const { rows } = await c.query<{ before: Record<string, unknown>; after: Record<string, unknown> }>(
        `SELECT before_state AS before, after_state AS after FROM audit.activity_log
          WHERE action = 'finance.fee_structure.update' ORDER BY created_at DESC LIMIT 1`);
      return rows[0];
    });
    assert.equal(entry.before.amount, 1200);
    assert.equal(entry.after.amount, 1500);
  });
});
