/**
 * P7 — the gate. Where a suspended school stops being a column.
 *
 * P7-1's inventory found that `app.set_tenant_status` wrote `tenants.status`,
 * the console showed a button for it, the audit log recorded it — and NOT ONE
 * LINE of application code read that column. A school could be "suspended"
 * and keep working normally.
 *
 * These tests drive the real `withTenant` against a real PostgreSQL with
 * migrations 051/052 applied. Nothing here is stubbed: if the gate stops
 * biting, these fail.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { createDb, TenantBlocked, type Db } from '../src/db.ts';
import { lockFixtures, unlockFixtures } from './harness.ts';

const DATABASE_URL = process.env.DATABASE_URL;
/** Seeding a school is a PLATFORM act — see the module header. */
const PLATFORM_URL = process.env.PLATFORM_DATABASE_URL;
const skip = !DATABASE_URL ? 'DATABASE_URL not set'
  : !PLATFORM_URL ? 'PLATFORM_DATABASE_URL not set' : false;

/**
 * Assigned by `app.create_tenant`, not hard-coded.
 *
 * The function generates its own uuid — which is what caught the bug this
 * suite exists around — and per-run ids make this suite immune to the
 * fixed-fixture collision recorded as B-35.
 */
let T = '';
let T_B = '';
const USER = '7c07a000-0000-4000-8000-0000000000a1';

/** The runtime connection: what a school's own requests use, gate and all. */
let db: Db;
/** The platform connection: the only one that may create or edit a school. */
let plat: Db;

const ctx = () => ({ tenantId: T, userId: USER, role: 'principal' });

async function seed(): Promise<void> {
  const made: string[] = [];
  for (const slug of [`p7-gate-${Date.now() % 100000}-a`, `p7-gate-${Date.now() % 100000}-b`]) {
    // Through `app.create_tenant`, exactly as the console does. Seeding by a
    // direct INSERT would not have found that the function does not write
    // `tenant_operations` — the bug that made every new school unreachable.
    const { rows } = await plat.pool.query<{ id: string }>(
      `SELECT * FROM app.create_tenant(
         p_actor => $1, p_slug => $2, p_name_bn => 'গেট পরীক্ষা',
         p_name_en => 'Gate Test', p_stream => 'bangla_medium',
         p_level => 'secondary', p_plan_code => 'starter',
         p_status => 'active', p_reason => 'P7 gate suite')`,
      [USER, slug]);
    made.push(rows[0].id);
  }
  [T, T_B] = made;
}

/** Put the school in one state, for one test. */
const setOps = (fields: Record<string, unknown>, id = T) =>
  plat.pool.query(
    `UPDATE tenant_operations SET ${Object.keys(fields)
      .map((k, i) => `${k} = $${i + 2}`).join(', ')} WHERE tenant_id = $1`,
    [id, ...Object.values(fields)]);

/**
 * Through `app.set_tenant_status`, because `tenants` is not directly writable
 * by the platform role — `tenant_self` denies it, which is exactly why that
 * function is SECURITY DEFINER. Driving the table would test a path the
 * console does not have.
 */
const setStatus = (status: string, id = T) =>
  plat.pool.query(
    `SELECT app.set_tenant_status($1, $2, $3::tenant_status, 'P7 gate suite')`,
    [USER, id, status]);

/**
 * `tenants.trial_ends_on` has no definer function of its own, so this goes
 * through the OWNER-side path the platform service uses for provisioning:
 * inside `withTenant`, where `tenant_self` is satisfied by the GUC.
 */
const setTrial = (on: string | null, id = T) =>
  plat.withTenant({ tenantId: id, userId: USER, role: 'principal' },
    (c) => c.query(`UPDATE tenants SET trial_ends_on = $1 WHERE id = app.current_tenant()`, [on]),
    { skipGate: true });

let ready: Promise<void> | null = null;
const ensure = (): Promise<void> => (ready ??= (async () => {
  await lockFixtures(DATABASE_URL as string);
  db = createDb(DATABASE_URL as string);
  plat = createDb(PLATFORM_URL as string, { max: 3 });
  await seed();
})());

describe('P7 — a suspended school is actually suspended', { skip }, () => {
  before(ensure);

  test('an active school works, so the gate is not just failing everything', async () => {
    await setOps({ ops_state: 'active' });
    const n = await db.withTenant(ctx(), async (c) => {
      const r = await c.query<{ n: string }>(`SELECT count(*) n FROM tenants`);
      return r.rows[0].n;
    });
    assert.equal(typeof n, 'string');
  });

  test('THE ONE THAT MATTERS — suspended refuses even a READ', async () => {
    await setOps({ ops_state: 'suspended', state_reason: 'পরীক্ষার জন্য' });
    await assert.rejects(
      () => db.withTenant(ctx(), async (c) => c.query('SELECT 1')),
      (err: unknown) => {
        assert.ok(err instanceof TenantBlocked, 'a typed refusal, not a raw error');
        assert.equal(err.status, 403);
        assert.equal(err.code, 'tenant_blocked');
        // The operator's own reason reaches the school, so nobody is left
        // guessing why the building stopped working.
        assert.match(err.reasonBn, /পরীক্ষার জন্য/);
        return true;
      });
  });

  test('the LEGACY console button works too — `tenants.status` is honoured', async () => {
    // R-7 shipped `app.set_tenant_status`, which writes this column, and the
    // console has had a button for it since. Before 052 nothing read it.
    // Leaving it inert would have meant two suspension mechanisms that
    // disagree, and an operator pressing the one that does nothing.
    await setOps({ ops_state: 'active' });
    await setStatus('suspended');
    await assert.rejects(
      () => db.withTenant(ctx(), async (c) => c.query('SELECT 1')),
      (err: unknown) => err instanceof TenantBlocked);
    await setStatus('active');
  });

  test('an archived school is gone, and says so differently', async () => {
    await setStatus('archived');
    await assert.rejects(
      () => db.withTenant(ctx(), async (c) => c.query('SELECT 1')),
      (err: unknown) => {
        assert.ok(err instanceof TenantBlocked);
        assert.match((err as TenantBlocked).reasonBn, /বন্ধ করা হয়েছে/);
        return true;
      });
    await setStatus('active');
  });
});

describe('P7 — read-only is enforced by PostgreSQL, not by a flag', { skip }, () => {
  before(ensure);

  test('maintenance still READS', async () => {
    await setOps({ ops_state: 'maintenance', state_reason: null });
    const ok = await db.withTenant(ctx(), async (c) => {
      await c.query('SELECT 1');
      return true;
    });
    assert.equal(ok, true, 'read-only means read, and a school must still read');
  });

  test('THE ONE THAT MATTERS — a WRITE fails even though no caller passed a flag', async () => {
    // The whole point. 109 `withTenant` call sites across 58 files, and not
    // one of them was edited: the transaction itself is read-only, so a write
    // nobody remembered was there still cannot land.
    await setOps({ ops_state: 'maintenance', state_reason: null });
    await assert.rejects(
      () => db.withTenant(ctx(), async (c) => {
        await c.query(
          `INSERT INTO academic_years (tenant_id, label, starts_on, ends_on)
           VALUES (app.current_tenant(), 'P7', '2026-01-01', '2026-12-31')`);
      }),
      (err: unknown) => {
        assert.ok(err instanceof TenantBlocked,
          'the raw SQLSTATE 25006 must not reach a school');
        assert.match((err as TenantBlocked).reasonBn, /রক্ষণাবেক্ষণ/);
        return true;
      });
  });

  test('the explicit write flag refuses EARLY, before the handler runs', async () => {
    await setOps({ ops_state: 'limited', state_reason: null });
    let ran = false;
    await assert.rejects(
      () => db.withTenant(ctx(), async () => { ran = true; }, { write: true }),
      (err: unknown) => err instanceof TenantBlocked);
    assert.equal(ran, false, 'no work is done that will only be thrown away');
  });

  test('limited explains itself as a bill, not as a fault', async () => {
    await setOps({ ops_state: 'limited', state_reason: null });
    const a = await db.tenantAccess(T);
    assert.equal(a.access, 'read_only');
    assert.match(a.reasonBn ?? '', /বকেয়া/);
    assert.match(a.reasonBn ?? '', /সব তথ্য অক্ষত/,
      'a school in arrears must be told its data is safe');
  });
});

describe('P7 — the billing lifecycle is derived, never stored', { skip }, () => {
  before(ensure);

  test('no due date is not a debt', async () => {
    await setOps({ ops_state: 'active', next_due_on: null });
    assert.equal((await db.tenantAccess(T)).billingState, 'active');
  });

  test('past due but inside the plan’s own grace window keeps working', async () => {
    // `starter` carries 14 grace days. A school does not lose service because
    // an operator forgot to press a button.
    await setOps({ ops_state: 'active', next_due_on: daysFromNow(-5), grace_until: null });
    const a = await db.tenantAccess(T);
    assert.equal(a.billingState, 'grace_period');
    assert.equal(a.access, 'full', 'grace means grace');
  });

  test('past grace becomes limited, and limited is read-only', async () => {
    await setOps({ ops_state: 'active', next_due_on: daysFromNow(-400), grace_until: null });
    const a = await db.tenantAccess(T);
    assert.equal(a.billingState, 'limited');
    assert.equal(a.access, 'read_only');
  });

  test('an explicitly granted grace overrides the plan’s window', async () => {
    await setOps({
      ops_state: 'active', next_due_on: daysFromNow(-400), grace_until: daysFromNow(10),
    });
    const a = await db.tenantAccess(T);
    assert.equal(a.billingState, 'grace_period');
    assert.equal(a.access, 'full');
  });

  test('a trial outranks a due date set optimistically', async () => {
    await setTrial(daysFromNow(30));
    await setOps({ next_due_on: daysFromNow(-400), grace_until: null });
    assert.equal((await db.tenantAccess(T)).billingState, 'trial');
    await setTrial(null);
  });

  test('suspension is not a consequence of a date', async () => {
    // A bank holiday must never suspend a school. The derived state tops out
    // at `limited`; only an operator produces `suspended`.
    await setOps({ ops_state: 'active', next_due_on: daysFromNow(-4000), grace_until: null });
    const a = await db.tenantAccess(T);
    assert.equal(a.billingState, 'limited');
    assert.notEqual(a.access, 'none');
  });
});

describe('P7 — tenant isolation of the gate itself', { skip }, () => {
  before(ensure);

  test('THE ONE THAT MATTERS — suspending A does not touch B', async () => {
    await setOps({ ops_state: 'suspended', state_reason: 'A only' }, T);
    await setOps({ ops_state: 'active' }, T_B);
    assert.equal((await db.tenantAccess(T)).access, 'none');
    assert.equal((await db.tenantAccess(T_B)).access, 'full');
  });

  test('and B keeps working while A is blocked', async () => {
    const ok = await db.withTenant(
      { tenantId: T_B, userId: USER, role: 'principal' },
      async (c) => { await c.query('SELECT 1'); return true; });
    assert.equal(ok, true);
    await assert.rejects(
      () => db.withTenant(ctx(), async (c) => c.query('SELECT 1')),
      (err: unknown) => err instanceof TenantBlocked);
  });

  test('a tenant that does not exist FAILS CLOSED', async () => {
    // Not "a school with no entitlements" — a question we cannot answer, and
    // the safe answer to "may this happen" is no.
    const a = await db.tenantAccess('7c07a000-0000-4000-8000-0000000dead0');
    assert.equal(a.access, 'none');
  });
});

describe('P7 — the portal switch actually closes a door', { skip }, () => {
  before(ensure);

  const portals = (v: Record<string, boolean>, id = T) =>
    plat.pool.query(
      `UPDATE tenant_operations SET portals = $2::jsonb WHERE tenant_id = $1`,
      [id, JSON.stringify(v)]);

  test('THE ONE THAT MATTERS — a closed teacher portal refuses a teacher', async () => {
    // 052 shipped `tenant_portal_open` and NOTHING called it: the console
    // could close a portal, report success, and every teacher kept working.
    // Exactly the defect P7-1 found in `tenants.status`, in the feature
    // built to replace it.
    await setOps({ ops_state: 'active' }, T);
    await portals({ teacher: false });
    await assert.rejects(
      () => db.withTenant({ tenantId: T, userId: USER, role: 'class_teacher' },
        async (c) => c.query('SELECT 1')),
      (err: unknown) => err instanceof TenantBlocked);
  });

  test('and says WHICH door, so nobody walks to the office to ask', async () => {
    await portals({ teacher: false });
    await assert.rejects(
      () => db.withTenant({ tenantId: T, userId: USER, role: 'subject_teacher' },
        async (c) => c.query('SELECT 1')),
      (err: unknown) => err instanceof TenantBlocked
        && /শিক্ষক/.test(err.reasonBn)
        && /যোগাযোগ/.test(err.reasonBn));
  });

  test('the principal is untouched — otherwise nobody could reopen it', async () => {
    await portals({ teacher: false });
    const ok = await db.withTenant({ tenantId: T, userId: USER, role: 'principal' },
      async (c) => { await c.query('SELECT 1'); return true; });
    assert.equal(ok, true);
  });

  test('every staff role that is not named maps to the teacher portal', async () => {
    // `portal_of` folds coordinators, dept heads and accountants into
    // "teacher". If that ever changes, a school closing the teacher portal
    // would silently leave the accountant inside.
    await portals({ teacher: false });
    for (const role of ['class_teacher', 'subject_teacher', 'accountant', 'coordinator']) {
      await assert.rejects(
        () => db.withTenant({ tenantId: T, userId: USER, role },
          async (c) => c.query('SELECT 1')),
        (err: unknown) => err instanceof TenantBlocked, role);
    }
  });

  test('an absent switch means open — a school with no row is not locked out', async () => {
    await portals({});
    for (const role of ['class_teacher', 'principal', 'student', 'guardian']) {
      const ok = await db.withTenant({ tenantId: T, userId: USER, role },
        async (c) => { await c.query('SELECT 1'); return true; });
      assert.equal(ok, true, role);
    }
  });

  test('closing a portal on A leaves the same portal open on B', async () => {
    await portals({ teacher: false }, T);
    await portals({}, T_B);
    const ok = await db.withTenant({ tenantId: T_B, userId: USER, role: 'class_teacher' },
      async (c) => { await c.query('SELECT 1'); return true; });
    assert.equal(ok, true);
    await portals({}, T);
  });
});

describe('P7 — the service switches actually switch something', { skip }, () => {
  before(ensure);

  const services = (v: Record<string, string>, id = T) =>
    plat.pool.query(
      `UPDATE tenant_operations SET services = $2::jsonb WHERE tenant_id = $1`,
      [id, JSON.stringify(v)]);

  const run = (service: string, role = 'principal') =>
    db.withTenant({ tenantId: T, userId: USER, role, service },
      async (c) => { await c.query('SELECT 1'); return true; });

  test('THE ONE THAT MATTERS — a disabled service refuses its own endpoints', async () => {
    // 051 built the catalogue, 052 built `tenant_service_state`, and its only
    // two callers were in the console: one to draw the list, one to check
    // dependencies. Turning off SMS changed a row and the messages kept going.
    await setOps({ ops_state: 'active' }, T);
    await services({ notices: 'disabled' });
    await assert.rejects(() => run('notices'),
      (err: unknown) => err instanceof TenantBlocked);
  });

  test('and names the service, in the language the school reads', async () => {
    await services({ notices: 'disabled' });
    await assert.rejects(() => run('notices'),
      (err: unknown) => err instanceof TenantBlocked && /নোটিশ/.test(err.reasonBn));
  });

  test('a service the plan never included is refused, and says so', async () => {
    // `starter` has no finance. Refusing is right; refusing WITHOUT saying
    // it is a plan question sends the school to support to be told to buy it.
    await services({});
    await assert.rejects(() => run('finance'),
      (err: unknown) => err instanceof TenantBlocked && /প্ল্যানে নেই/.test(err.reasonBn));
  });

  test('the services the plan DID include still work', async () => {
    await services({});
    for (const svc of ['attendance', 'results', 'notices', 'calendar']) {
      assert.equal(await run(svc), true, svc);
    }
  });

  test('a limited service reads but does not write', async () => {
    await services({ notices: 'limited' });
    assert.equal(await run('notices'), true, 'reading is the point of limited');
    await assert.rejects(
      () => db.withTenant(
        { tenantId: T, userId: USER, role: 'principal', service: 'notices' },
        async (c) => c.query('SELECT 1'), { write: true }),
      (err: unknown) => err instanceof TenantBlocked);
  });

  test('a service answer can only ever RESTRICT, never widen', async () => {
    // A suspended school does not become reachable because one of its
    // services is on. This is the composition rule 055 is built around.
    await setOps({ ops_state: 'suspended', state_reason: 'পরীক্ষা' }, T);
    await services({});
    await assert.rejects(() => run('attendance'),
      (err: unknown) => err instanceof TenantBlocked);
    await setOps({ ops_state: 'active', state_reason: null }, T);
  });

  test('an ungated request is untouched by any of it', async () => {
    // Login, branding, the school's own people: no `service`, no service
    // gate. A switch must never be able to lock a school out of itself.
    await services({ notices: 'disabled', attendance: 'disabled' });
    const ok = await db.withTenant({ tenantId: T, userId: USER, role: 'principal' },
      async (c) => { await c.query('SELECT 1'); return true; });
    assert.equal(ok, true);
    await services({});
  });

  test('login is never behind a portal — it is not a person', async () => {
    // identity-svc runs as `system_ingest`. Before 056 that mapped to the
    // teacher portal, so closing it would have stopped every login in the
    // school, including the principal who had to undo it.
    await plat.pool.query(
      `UPDATE tenant_operations SET portals = $2::jsonb WHERE tenant_id = $1`,
      [T, JSON.stringify({ teacher: false, student: false, guardian: false })]);
    const ok = await db.withTenant(
      { tenantId: T, userId: USER, role: 'system_ingest' },
      async (c) => { await c.query('SELECT 1'); return true; });
    assert.equal(ok, true, 'closing every portal must not stop the school signing in');
    await plat.pool.query(
      `UPDATE tenant_operations SET portals = '{}'::jsonb WHERE tenant_id = $1`, [T]);
  });
});

describe('P7 — the console may reach past the gate, and only the console', { skip }, () => {
  before(ensure);

  test('skipGate opens a suspended school, which is how one gets reopened', async () => {
    await setOps({ ops_state: 'suspended' }, T);
    const ok = await db.withTenant(ctx(), async (c) => {
      await c.query('SELECT 1');
      return true;
    }, { skipGate: true });
    assert.equal(ok, true, 'a console that cannot open a suspended school can never reopen one');
  });

  test('and without it the same call is refused', async () => {
    await setOps({ ops_state: 'suspended' }, T);
    await assert.rejects(
      () => db.withTenant(ctx(), async (c) => c.query('SELECT 1')),
      (err: unknown) => err instanceof TenantBlocked);
    await setOps({ ops_state: 'active' }, T);
  });
});

/**
 * ONE teardown, at module level.
 *
 * It was attached to the first `describe`, which node runs to completion
 * before the next one starts — so the pools were closed while four more
 * suites still needed them, and every one of them failed in under a
 * millisecond. A teardown that runs in the middle is worse than none.
 */
after(async () => {
  if (!plat) return;
  await plat.pool.query(`DELETE FROM tenants WHERE id IN ($1, $2)`, [T, T_B]);
  await db.end();
  await plat.end();
  await unlockFixtures();
});

function daysFromNow(n: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
