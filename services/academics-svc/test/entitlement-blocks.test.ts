/**
 * B-53 — a service that is off must not be served by a sibling endpoint.
 *
 * Most endpoints declare one `service:` key and the gate in `authenticate`
 * refuses the whole request. `/academics/students/history` declares none,
 * because it is not one service: it is the child's enrolments, attendance,
 * results and fees on one page, and those are four separate entitlements.
 *
 * The consequence was reproduced against a running stack before this file
 * existed. A school on the `starter` plan — which does not include finance at
 * all — got 403 from `/finance/invoices` and, from this endpoint, every
 * invoice total, every amount paid, every outstanding balance and every
 * receipt id for any student its principal could see. The commercial gate and
 * the privacy gate were the same gate, and both were bypassed by asking a
 * different URL.
 *
 * ── Why not simply gate the endpoint ───────────────────────────────────────
 * Because a school that never bought finance still legitimately wants a
 * child's attendance record, and returning 403 for the whole page would take
 * away something they DO have. So each block is gated on its own service and
 * an off service yields `null` — the same shape an unauthorised role already
 * produces, which every caller already handles.
 *
 * ── What the tests are actually pinned to ──────────────────────────────────
 * Not "the handler calls tenant_service_state". That would pass if the call
 * were made and its answer ignored. Each test flips the real switch in
 * `tenant_operations`, asks over HTTP with a real token, and asserts on the
 * MONEY: the amount that was visible a moment ago is gone, and the blocks
 * belonging to services that are still on came back in the same response.
 *
 *   DATABASE_URL=postgres://shikhon_app:…  *   PLATFORM_DATABASE_URL=postgres://shikhon_platform:…  *     node --test services/academics-svc/test/entitlement-blocks.test.ts
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { createDb, type Db, type TenantContext } from '../../../packages/server-core/src/db.ts';
import { installTestKeys, call, lockFixtures, unlockFixtures, asBootstrap } from '../../../packages/server-core/test/harness.ts';

const DATABASE_URL = process.env.DATABASE_URL;
/**
 * Switching a service off is a PLATFORM act, and the app role must not be
 * able to do it. Writing `tenant_operations` on the runtime connection is
 * refused by RLS, and changing `plan_code` is refused by the trigger migration
 * 069 added — both correctly. So the switch is thrown on the platform
 * connection, which is the only thing that may, and the suite skips rather
 * than pretends when that connection is not configured.
 */
const PLATFORM_URL = process.env.PLATFORM_DATABASE_URL;
const skip = !DATABASE_URL ? 'DATABASE_URL not set'
  : !PLATFORM_URL ? 'PLATFORM_DATABASE_URL not set' : false;

const T       = '7e530000-0000-4000-8000-0000000000a0';
const HEAD    = '7e530000-0000-4000-8000-0000000000a1';
const STUDENT = '7e530000-0000-4000-8000-0000000000a2';
const YEAR    = '7e530000-0000-4000-8000-0000000000c1';
const KLASS   = '7e530000-0000-4000-8000-0000000000d1';
const SECTION = '7e530000-0000-4000-8000-0000000000e1';
const INVOICE = '7e530000-0000-4000-8000-0000000000f1';

/**
 * A SECOND school, on `starter` — a plan whose `services` has no finance key
 * at all. `not_in_plan` is a different branch of `tenant_service_state` from
 * `disabled`, and it is the branch this bug was found on, so it needs a
 * school that genuinely never bought the service rather than one switched
 * off. It cannot be the same school moved between plans: `tenants` carries
 * one policy, `tenant_self` for `shikhon_app`, so the platform role updates
 * zero rows and the test would have passed while changing nothing.
 */
const T2       = '7e530000-0000-4000-8000-0000000000b0';
const HEAD2    = '7e530000-0000-4000-8000-0000000000b1';
const STUDENT2 = '7e530000-0000-4000-8000-0000000000b2';
const YEAR2    = '7e530000-0000-4000-8000-0000000000c2';
const KLASS2   = '7e530000-0000-4000-8000-0000000000d2';
const SECTION2 = '7e530000-0000-4000-8000-0000000000e2';
const INVOICE2 = '7e530000-0000-4000-8000-0000000000f2';

/** A guardian at the first school, for the guardian-facing surface. */
const GUARDIAN = '7e530000-0000-4000-8000-0000000000a3';

/** The bill the leak exposed. A distinctive figure, so the assertion that it
 *  vanished cannot pass by matching some other tenant's zero. */
const BILLED = '4250.00';

let db: Db;
/** The operator's connection. Only used to flip the switches under test. */
let plat: Db;
let token = '';
let token2 = '';
let history: typeof import('../api/studenthistory.ts').default;
let ward: typeof import('../api/ward.ts').default;
let hierarchy: typeof import('../api/hierarchy.ts').default;
let classperf: typeof import('../api/classperf.ts').default;
let guardianToken = '';

const head: TenantContext = { tenantId: T, userId: HEAD, role: 'principal' };
const head2: TenantContext = { tenantId: T2, userId: HEAD2, role: 'principal' };

/** What is switched ON. The plan decides what was BOUGHT; these are different
 *  sentences and both must be able to hide a block. */
const setServices = (json: string) => plat.pool.query(
  `INSERT INTO tenant_operations (tenant_id, ops_state, services)
   VALUES ($1, 'active', $2::jsonb)
   ON CONFLICT (tenant_id) DO UPDATE SET services = $2::jsonb`, [T, json]);

const setOpsState = (state: string) => plat.pool.query(
  'UPDATE tenant_operations SET ops_state = $2 WHERE tenant_id = $1', [T, state]);

/** Switch every service on for a school, so a block that is missing is
 *  missing for the reason the test is about and not for a leftover one. */
const openAll = (tenant: string) => plat.pool.query(
  `INSERT INTO tenant_operations (tenant_id, ops_state, services)
   VALUES ($1, 'active', '{}'::jsonb)
   ON CONFLICT (tenant_id) DO UPDATE SET ops_state='active', services='{}'::jsonb`,
  [tenant]);

type History = {
  fees: unknown; attendance: unknown; results: unknown; enrolments: unknown;
  services: { attendance: boolean; results: boolean; finance: boolean };
};

async function ask(student = STUDENT, tok = token): Promise<{ status: number; body: History }> {
  const res = await call(history, { url: `/?studentId=${student}`, token: tok });
  return { status: res.status, body: res.body as History };
}

describe('P-ops §5 — an entitlement holds on every endpoint, not just its own', { skip }, () => {
  /** One school, complete enough for this endpoint to answer about it. */
  async function seedSchool(
    ctx: TenantContext, tenant: string, headId: string, studentId: string,
    year: string, klass: string, section: string, invoice: string,
    plan: string, slug: string, phoneBase: number,
    guardianId?: string,
  ): Promise<void> {
    await asBootstrap(db, ctx, async (c) => {
      await c.query('DELETE FROM invoices WHERE tenant_id = $1', [tenant]);
      await c.query('DELETE FROM tenants WHERE id = $1', [tenant]);
      await c.query(
        `INSERT INTO tenants (id, slug, name_bn, name_en, stream, level, plan_code)
         VALUES ($1,$2,'বি৫৩','B53','bangla_medium','secondary',$3)`, [tenant, slug, plan]);
      await c.query(
        `INSERT INTO users (id, tenant_id, full_name_bn, full_name_en, phone_e164, status)
         VALUES ($1,$2,'প্রধান','Head',$3,'active')`,
        [headId, tenant, `+88017553${String(phoneBase).padStart(5, '0')}`]);
      await c.query(
        `INSERT INTO users (id, tenant_id, full_name_bn, full_name_en, phone_e164, status)
         VALUES ($1,$2,'রুমি','Rumi',$3,'active')`,
        [studentId, tenant, `+88017553${String(phoneBase + 1).padStart(5, '0')}`]);
      await c.query(
        `INSERT INTO user_roles (tenant_id, user_id, role_code) VALUES ($1,$2,'student')`,
        [tenant, studentId]);
      // `loadProfile` joins student_profiles, so a user row carrying the
      // student ROLE is not yet a student to this endpoint — it answers 404.
      // That is correct, and it is why the fixture carries the profile row
      // rather than the endpoint tolerating its absence.
      await c.query(
        `INSERT INTO student_profiles (user_id, tenant_id, student_code, admission_date)
         VALUES ($1,$2,$3,'2026-01-05')`, [studentId, tenant, `${slug}-STU-1`]);
      await c.query(
        `INSERT INTO academic_years (id, tenant_id, label, starts_on, ends_on, is_current)
         VALUES ($1,$2,'2026','2026-01-01','2026-12-31',true)`, [year, tenant]);
      await c.query(
        `INSERT INTO classes (id, tenant_id, level_no, name_bn, name_en, stream)
         VALUES ($1,$2,9,'নবম','Nine','bangla_medium')`, [klass, tenant]);
      await c.query(
        `INSERT INTO sections (id, tenant_id, class_id, academic_year_id, name, student_count)
         VALUES ($1,$2,$3,$4,'ক',1)`, [section, tenant, klass, year]);
      await c.query(
        `INSERT INTO enrolments (tenant_id, student_id, section_id, academic_year_id, roll_no, status)
         VALUES ($1,$2,$3,$4,1,'active')`, [tenant, studentId, section, year]);
      await c.query(
        `INSERT INTO invoices (id, tenant_id, invoice_no, student_id, academic_year_id,
                               due_on, subtotal, total_amount, status)
         VALUES ($1,$2,$3,$4,$5,'2026-03-31',$6,$6,'issued')`,
        [invoice, tenant, `${slug}-0001`, studentId, year, BILLED]);
      if (guardianId) {
        await c.query(
          `INSERT INTO users (id, tenant_id, full_name_bn, full_name_en, phone_e164, status)
           VALUES ($1,$2,'অভিভাবক','Guardian',$3,'active')`,
          [guardianId, tenant, `+88017553${String(phoneBase + 2).padStart(5, '0')}`]);
        await c.query(
          `INSERT INTO user_roles (tenant_id, user_id, role_code) VALUES ($1,$2,'guardian')`,
          [tenant, guardianId]);
        await c.query(
          `INSERT INTO guardianships (tenant_id, student_id, guardian_id, relation, is_primary)
           VALUES ($1,$2,$3,'father',true)`, [tenant, studentId, guardianId]);
      }
    });
  }

  before(async () => {
    await installTestKeys();
    await lockFixtures(DATABASE_URL as string);
    db = createDb(DATABASE_URL as string);
    plat = createDb(PLATFORM_URL as string);

    // `complete` includes finance, so the baseline is a school that genuinely
    // has the service — otherwise every assertion below would pass for the
    // wrong reason. `starter` does not include it at all.
    await seedSchool(head, T, HEAD, STUDENT, YEAR, KLASS, SECTION, INVOICE,
      'complete', 'b53-entitle', 1, GUARDIAN);
    await seedSchool(head2, T2, HEAD2, STUDENT2, YEAR2, KLASS2, SECTION2, INVOICE2,
      'starter', 'b53-starter', 11);
    // Both schools fully open at the operations level. Anything that is off
    // below is off because of the plan, or because a test switched it off.
    await openAll(T);
    await openAll(T2);

    const { signAccessToken } = await import('../../../packages/server-core/src/jwt.ts');
    token = await signAccessToken({ sub: HEAD, tid: T, role: 'principal', roles: ['principal'] });
    token2 = await signAccessToken({ sub: HEAD2, tid: T2, role: 'principal', roles: ['principal'] });
    guardianToken = await signAccessToken(
      { sub: GUARDIAN, tid: T, role: 'guardian', roles: ['guardian'] });
    history = (await import('../api/studenthistory.ts')).default;
    ward = (await import('../api/ward.ts')).default;
    hierarchy = (await import('../api/hierarchy.ts')).default;
    classperf = (await import('../api/classperf.ts')).default;
  });

  after(async () => {
    if (!db) return;
    for (const [ctx, tenant] of [[head, T], [head2, T2]] as const) {
      await asBootstrap(db, ctx, async (c) => {
        // invoices → tenants is ON DELETE RESTRICT, as money should be.
        await c.query('DELETE FROM invoices WHERE tenant_id = $1', [tenant]);
        await c.query('DELETE FROM tenants WHERE id = $1', [tenant]);
      });
    }
    await db.end();
    await plat.end();
    await unlockFixtures();
  });

  test('baseline — a school that HAS finance sees the bill', async () => {
    await setServices('{}');
    const { status, body } = await ask();
    assert.equal(status, 200);
    const fees = body.fees as { years: Array<{ billed: string }> };
    assert.ok(fees, 'fees must be present, or the tests below prove nothing');
    assert.equal(fees.years[0].billed, BILLED);
    assert.deepEqual(body.services, { attendance: true, results: true, finance: true });
  });

  test('THE LEAK — finance switched off takes the money out of this response too', async () => {
    await setServices('{"finance":"disabled"}');
    const { status, body } = await ask();

    assert.equal(status, 200, 'the page still loads — only the money block is gone');
    assert.equal(body.fees, null,
      `৳${BILLED} was still served by an endpoint that declares no finance service`);
    assert.equal(body.services.finance, false);
  });

  test('…and the blocks the school still has come back in the same response', async () => {
    await setServices('{"finance":"disabled"}');
    const { body } = await ask();
    // The wrong fix for this bug is a 403 for the whole page. This is the
    // assertion that would catch it.
    assert.ok(body.enrolments, 'a school without finance still has a student roll');
    assert.ok(body.attendance, 'attendance is a different purchase and is still on');
    assert.ok(body.results, 'results likewise');
    assert.equal(body.services.attendance, true);
  });

  test('never bought is as closed as switched off', async () => {
    // The second school is on `starter`, whose plan has no finance key at
    // all, so the state is `not_in_plan` rather than `disabled`. A gate that
    // only tested for the string 'disabled' would leak here — and that is
    // precisely the school this bug was first reproduced against.
    const { status, body } = await ask(STUDENT2, token2);
    assert.equal(status, 200);
    assert.equal(body.fees, null, 'a plan that never included finance still returned it');
    assert.equal(body.services.finance, false);
    assert.ok(body.attendance, 'attendance IS in the starter plan and must still arrive');
  });

  test('attendance and results gate independently of each other', async () => {
    await setServices('{"attendance":"disabled"}');
    const { body } = await ask();
    assert.equal(body.attendance, null);
    assert.ok(body.results, 'switching one service off must not take the others with it');
    assert.deepEqual(body.services, { attendance: false, results: true, finance: true });
  });

  test('maintenance is closed too — a service mid-migration serves nothing', async () => {
    await setServices('{"finance":"maintenance"}');
    const { body } = await ask();
    assert.equal(body.fees, null,
      'reading a half-migrated ledger is how a parent is quoted a wrong balance');
  });

  test('a school in arrears keeps the services the catalogue says survive', async () => {
    // ops_state `limited` yields access `read_only` — the state a school in
    // billing arrears reaches. Which services survive it is not this
    // endpoint's opinion: `service_catalogue.in_limited` decides, and it
    // currently says attendance and results survive while finance does not.
    // That is a deliberate commercial policy — a school being chased for fees
    // loses the fee module and keeps the things children depend on — and this
    // test pins the endpoint to the policy rather than to a guess.
    await setServices('{}');
    await setOpsState('limited');
    const { status, body } = await ask();

    assert.equal(status, 200, 'a read-only school can still read');
    assert.ok(body.attendance, 'in_limited = true for attendance');
    assert.ok(body.results, 'in_limited = true for results');
    assert.equal(body.fees, null, 'in_limited = false for finance');

    await setOpsState('active');
  });

  /*
   * The same bug, on the other four surfaces it was found on. Each of these
   * endpoints composes several services and declared none, so each served a
   * module the school might not have. They are asserted here rather than in
   * four files because it is one defect with four sites, and a reader
   * looking at any one of them should see the others.
   */

  test('the guardian home hides the cards the school does not have', async () => {
    await setServices('{"finance":"disabled"}');
    const res = await call(ward, { url: `/?studentId=${STUDENT}`, token: guardianToken });
    assert.equal(res.status, 200);
    const body = res.body as { student: { fees: unknown; attendance: unknown; result: unknown } };

    assert.equal(body.student.fees, null,
      'every guardian at this school was being sent an outstanding balance');
    assert.ok(body.student.attendance,
      'attendance is a different purchase and the card must stay');
  });

  test('the student record hides its attendance summary when attendance is off', async () => {
    await setServices('{"attendance":"disabled"}');
    const res = await call(hierarchy, { url: `/?studentId=${STUDENT}`, token });
    assert.equal(res.status, 200);
    const body = res.body as { attendance90d: unknown; current: unknown };

    // null rather than a zeroed object: "this school does not run attendance"
    // and "nobody has taken a register in 90 days" are different facts, and
    // 0/0 renders as the second.
    assert.equal(body.attendance90d, null);
    assert.ok(body.current, 'the enrolment itself is not the attendance module');
  });

  test('classperf answers at all — its SELECT named a column sections does not have', async () => {
    // `s.name_bn` against `sections`, whose column is `name`. Every request to
    // this endpoint was a 500 from the day it was written; the screen behind
    // it had never once rendered. A smoke test is enough to hold that,
    // because the failure was at parse time and needed no data to reproduce.
    await setServices('{}');
    const res = await call(classperf, { url: '/', token });
    assert.equal(res.status, 200, 'class performance analysis 500s on every call');
    assert.ok(Array.isArray((res.body as { choices: unknown[] }).choices));
  });

  test('a service that is off is off for the guardian too, not only for staff', async () => {
    // The gate is per-request, not per-role: switching finance off must take
    // the money away from everyone, and the guardian surface is the one where
    // a stale balance turns into a phone call to the office.
    await setServices('{"finance":"disabled"}');
    const staff = await ask();
    const res = await call(ward, { url: `/?studentId=${STUDENT}`, token: guardianToken });
    const body = res.body as { student: { fees: unknown } };

    assert.equal(staff.body.fees, null);
    assert.equal(body.student.fees, null);
  });
});
