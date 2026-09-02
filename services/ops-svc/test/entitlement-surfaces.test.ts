/**
 * B-53, on the two ops surfaces it was found on.
 *
 * The defect is one sentence: an endpoint that composes several services
 * declares none of them, so `tenant_guard` never asks
 * `app.tenant_service_state`, and the handler serves a module the school may
 * not have bought. `services/academics-svc/test/entitlement-blocks.test.ts`
 * holds the academics half. This file holds the two here, which are worse in
 * different ways.
 *
 * ── The dashboard ──────────────────────────────────────────────────────────
 * The finance tile was governed by ROLE alone. A principal is in
 * FINANCE_ROLES, so a principal at a `starter` school — a plan with no
 * finance key at all — was served `{"invoiced":"1300.00","collected":
 * "1300.00","outstanding":"0.00"}` on the front page, while
 * `/finance/invoices` refused the same session. Reproduced against a running
 * stack before this file existed.
 *
 * ── The documents ──────────────────────────────────────────────────────────
 * `/ops/document` declares `service: 'documents'`, which is right for the
 * printing machinery and wrong for the content. A fee receipt is the finance
 * module's data; a report card and an admit card are the results module's; an
 * attendance sheet is the attendance module's. With each of those switched
 * off the endpoint still returned a complete, branded, printable page.
 *
 * That is the one that mattered most. These are not API responses — they are
 * documents a school hands to a parent or files with a board. A fee receipt
 * printed by a school with no finance module is a piece of paper nobody in
 * that office can reconcile against anything.
 *
 *   DATABASE_URL=postgres://shikhon_app:… \
 *   PLATFORM_DATABASE_URL=postgres://shikhon_platform:… \
 *     node --test services/ops-svc/test/entitlement-surfaces.test.ts
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { createDb, type Db, type TenantContext } from '../../../packages/server-core/src/db.ts';
import { installTestKeys, call, lockFixtures, unlockFixtures, asBootstrap } from '../../../packages/server-core/test/harness.ts';

const DATABASE_URL = process.env.DATABASE_URL;
/** Switching a service off is a platform act; the app role must not manage it. */
const PLATFORM_URL = process.env.PLATFORM_DATABASE_URL;
const skip = !DATABASE_URL ? 'DATABASE_URL not set'
  : !PLATFORM_URL ? 'PLATFORM_DATABASE_URL not set' : false;

const T       = '7e531000-0000-4000-8000-0000000000a0';
const HEAD    = '7e531000-0000-4000-8000-0000000000a1';
const STUDENT = '7e531000-0000-4000-8000-0000000000a2';
const YEAR    = '7e531000-0000-4000-8000-0000000000c1';
const KLASS   = '7e531000-0000-4000-8000-0000000000d1';
const SECTION = '7e531000-0000-4000-8000-0000000000e1';
const INVOICE = '7e531000-0000-4000-8000-0000000000f1';

/** Distinctive, so "the number vanished" cannot pass by matching a zero. */
const BILLED = '7825.00';

let db: Db;
let plat: Db;
let token = '';
let dashboard: typeof import('../api/dashboard.ts').default;
let document_: typeof import('../api/document.ts').default;

const head: TenantContext = { tenantId: T, userId: HEAD, role: 'principal' };

const setServices = (json: string) => plat.pool.query(
  `INSERT INTO tenant_operations (tenant_id, ops_state, services)
   VALUES ($1, 'active', $2::jsonb)
   ON CONFLICT (tenant_id) DO UPDATE SET ops_state='active', services = $2::jsonb`,
  [T, json]);

describe('P-ops §5 — the ops surfaces that compose several services', { skip }, () => {
  before(async () => {
    await installTestKeys();
    await lockFixtures(DATABASE_URL as string);
    db = createDb(DATABASE_URL as string);
    plat = createDb(PLATFORM_URL as string);

    await asBootstrap(db, head, async (c) => {
      await c.query('DELETE FROM invoices WHERE tenant_id = $1', [T]);
      await c.query('DELETE FROM tenants WHERE id = $1', [T]);
      // `complete` carries finance, so a block that is missing below is
      // missing because a test switched it off, not because of the plan.
      await c.query(
        `INSERT INTO tenants (id, slug, name_bn, name_en, stream, level, plan_code)
         VALUES ($1,'b53-ops','বি৫৩ অপস','B53 Ops','bangla_medium','secondary','complete')`, [T]);
      await c.query(
        `INSERT INTO users (id, tenant_id, full_name_bn, full_name_en, phone_e164, status)
         VALUES ($1,$2,'প্রধান','Head','+8801755310001','active')`, [HEAD, T]);
      await c.query(
        `INSERT INTO users (id, tenant_id, full_name_bn, full_name_en, phone_e164, status)
         VALUES ($1,$2,'সুমি','Sumi','+8801755310002','active')`, [STUDENT, T]);
      await c.query(
        `INSERT INTO user_roles (tenant_id, user_id, role_code) VALUES ($1,$2,'student')`,
        [T, STUDENT]);
      await c.query(
        `INSERT INTO student_profiles (user_id, tenant_id, student_code, admission_date)
         VALUES ($1,$2,'B53-OPS-1','2026-01-05')`, [STUDENT, T]);
      await c.query(
        `INSERT INTO academic_years (id, tenant_id, label, starts_on, ends_on, is_current)
         VALUES ($1,$2,'2026','2026-01-01','2026-12-31',true)`, [YEAR, T]);
      await c.query(
        `INSERT INTO classes (id, tenant_id, level_no, name_bn, name_en, stream)
         VALUES ($1,$2,9,'নবম','Nine','bangla_medium')`, [KLASS, T]);
      await c.query(
        `INSERT INTO sections (id, tenant_id, class_id, academic_year_id, name, student_count)
         VALUES ($1,$2,$3,$4,'ক',1)`, [SECTION, T, KLASS, YEAR]);
      await c.query(
        `INSERT INTO enrolments (tenant_id, student_id, section_id, academic_year_id, roll_no, status)
         VALUES ($1,$2,$3,$4,1,'active')`, [T, STUDENT, SECTION, YEAR]);
      await c.query(
        `INSERT INTO invoices (id, tenant_id, invoice_no, student_id, academic_year_id,
                               due_on, subtotal, total_amount, status)
         VALUES ($1,$2,'B53-OPS-0001',$3,$4,'2026-03-31',$5,$5,'issued')`,
        [INVOICE, T, STUDENT, YEAR, BILLED]);
    });

    await setServices('{}');
    const { signAccessToken } = await import('../../../packages/server-core/src/jwt.ts');
    token = await signAccessToken({ sub: HEAD, tid: T, role: 'principal', roles: ['principal'] });
    dashboard = (await import('../api/dashboard.ts')).default;
    document_ = (await import('../api/document.ts')).default;
  });

  after(async () => {
    if (!db) return;
    await asBootstrap(db, head, async (c) => {
      await c.query('DELETE FROM invoices WHERE tenant_id = $1', [T]);
      await c.query('DELETE FROM tenants WHERE id = $1', [T]);
    });
    await db.end();
    await plat.end();
    await unlockFixtures();
  });

  type Dash = { finance: { outstanding: string } | null; financeAvailable: boolean; counts: unknown };

  test('baseline — the dashboard shows the money to a principal who has finance', async () => {
    await setServices('{}');
    const res = await call(dashboard, { url: '/', token });
    assert.equal(res.status, 200);
    const body = res.body as Dash;
    assert.ok(body.finance, 'without this the next test proves nothing');
    assert.equal(body.finance.outstanding, BILLED);
    assert.equal(body.financeAvailable, true);
  });

  test('THE LEAK — role alone was the gate on the finance tile', async () => {
    await setServices('{"finance":"disabled"}');
    const res = await call(dashboard, { url: '/', token });
    const body = res.body as Dash;

    assert.equal(res.status, 200, 'the rest of the dashboard still loads');
    assert.equal(body.finance, null,
      `৳${BILLED} was on the front page of a school with no finance module`);
    assert.equal(body.financeAvailable, false,
      'the card needs to say WHY it is gone — no module, not no permission');
    assert.ok(body.counts, 'the roll is not the finance module and must stay');
  });

  /**
   * Each document, with its own service off. The status is 403 rather than an
   * empty page on purpose: a blank sheet reads as "this child has no record",
   * which is a different and more alarming claim than "this school does not
   * run that module".
   */
  for (const [type, service, extra] of [
    ['report_card', 'results', `&studentId=${STUDENT}`],
    ['admit_card', 'results', `&studentId=${STUDENT}`],
    ['attendance_sheet', 'attendance', `&sectionId=${SECTION}`],
  ] as const) {
    test(`a ${type} is refused when ${service} is off`, async () => {
      await setServices(`{"${service}":"disabled"}`);
      const res = await call(document_, { url: `/?type=${type}${extra}`, token });

      assert.equal(res.status, 403,
        `a branded, printable ${type} was issued by a school without ${service}`);
      assert.equal((res.body as { error: string }).error, 'service_unavailable');
    });
  }

  test('an id card still prints — it is the roster, not a module', async () => {
    // The counterpart assertion, and the one that would catch an
    // over-correction. A school that switches finance off has not stopped
    // having students, and gating every document on something would make the
    // office unable to issue the one document that never depended on a
    // module.
    await setServices('{"finance":"disabled","results":"disabled","attendance":"disabled"}');
    const res = await call(document_, { url: `/?type=id_card&studentId=${STUDENT}`, token });
    assert.notEqual(res.status, 403, 'an id card needs no service beyond documents');
  });

  test('in arrears, the refusal comes from the documents gate and not the new one', async () => {
    // `limited` is the arrears state, and `service_catalogue.in_limited` is
    // false for `documents` — so this endpoint was already closed to a school
    // in arrears, long before B-53, by its own declared `service: documents`.
    //
    // The assertion worth making is therefore not "it still prints". It is
    // that the refusal still comes from the ENDPOINT's gate, which returns
    // `blocked`, and not from the content gate added for B-53, which returns
    // `service_unavailable`. If that ever flips, the content gate has started
    // deciding something that was never its decision, and the message a
    // school sees would change from "your account is limited" to "you do not
    // have results" — which is false and would send them to the wrong
    // remedy.
    await setServices('{}');
    await plat.pool.query(
      `UPDATE tenant_operations SET ops_state='limited' WHERE tenant_id=$1`, [T]);
    const res = await call(document_, { url: `/?type=report_card&studentId=${STUDENT}`, token });

    assert.equal(res.status, 403);
    assert.notEqual((res.body as { error: string }).error, 'service_unavailable',
      'the content gate must not be the thing that answers an arrears refusal');

    await plat.pool.query(
      `UPDATE tenant_operations SET ops_state='active' WHERE tenant_id=$1`, [T]);
  });
});
