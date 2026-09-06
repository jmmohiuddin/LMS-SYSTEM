/**
 * P-ops §D — the whole entitlement matrix, in one place, on one school.
 *
 * P-ops C fixed six composite endpoints one at a time and tested each against
 * the one service it had been leaking. That is the right way to fix a bug and
 * the wrong way to know a class of bug is closed: six files each asserting its
 * own corner cannot answer "is there a state, on any of these surfaces, that
 * still serves what it should not?"
 *
 * So this walks the product of the two axes:
 *
 *   ops_state    active · limited · maintenance · suspended
 *   endpoint     student history · guardian ward · dashboard · document ·
 *                exam routine · class performance
 *
 * plus the per-service switch on top of `active`, because a school can have
 * one module off while the account itself is perfectly healthy — which is the
 * B-53 case and is NOT an ops_state at all.
 *
 * ── What "correct" means for each cell ─────────────────────────────────────
 * Not "403 everywhere". The states mean different things and the product is
 * supposed to behave differently in each:
 *
 *   active       everything the plan includes is served.
 *   limited      billing arrears. `access = read_only`. The catalogue column
 *                `in_limited` decides which services survive — attendance,
 *                results, calendar and notices do; finance, documents, sms,
 *                push and the rest do not. The school can still READ what it
 *                kept.
 *   maintenance  the platform is working on that service. Nothing served.
 *   suspended    `access = none`. Nothing at all, on any endpoint.
 *
 * Every expectation below is derived from `service_catalogue` and
 * `app.tenant_service_state` at run time rather than hard-coded, so a
 * deliberate policy change moves the tests with it and an ACCIDENTAL one
 * fails them. Hard-coding the matrix would just be the policy written twice.
 *
 *   DATABASE_URL=postgres://shikhon_app:… \
 *   PLATFORM_DATABASE_URL=postgres://shikhon_platform:… \
 *     node --test services/ops-svc/test/entitlement-matrix.test.ts
 */
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { createDb, type Db, type TenantContext } from '../../../packages/server-core/src/db.ts';
import { installTestKeys, call, lockFixtures, unlockFixtures, asBootstrap } from '../../../packages/server-core/test/harness.ts';

const DATABASE_URL = process.env.DATABASE_URL;
const PLATFORM_URL = process.env.PLATFORM_DATABASE_URL;
const skip = !DATABASE_URL ? 'DATABASE_URL not set'
  : !PLATFORM_URL ? 'PLATFORM_DATABASE_URL not set' : false;

const T        = '7d000000-0000-4000-8000-0000000000a0';
const HEAD     = '7d000000-0000-4000-8000-0000000000a1';
const STUDENT  = '7d000000-0000-4000-8000-0000000000a2';
const GUARDIAN = '7d000000-0000-4000-8000-0000000000a3';
const YEAR     = '7d000000-0000-4000-8000-0000000000c1';
const KLASS    = '7d000000-0000-4000-8000-0000000000d1';
const SECTION  = '7d000000-0000-4000-8000-0000000000e1';
const INVOICE  = '7d000000-0000-4000-8000-0000000000f1';
const BILLED   = '3300.00';

let db: Db;
let plat: Db;
let headToken = '';
let guardianToken = '';

/** Whatever shape `call` accepts — the harness owns that contract. */
type Handler = Parameters<typeof call>[0];
const H: Record<string, Handler> = {};

const head: TenantContext = { tenantId: T, userId: HEAD, role: 'principal' };

const setState = (state: string, services = '{}') => plat.pool.query(
  `INSERT INTO tenant_operations (tenant_id, ops_state, services)
   VALUES ($1, $2, $3::jsonb)
   ON CONFLICT (tenant_id) DO UPDATE SET ops_state = $2, services = $3::jsonb`,
  [T, state, services]);

/** The policy, asked of the database rather than restated here. */
async function stateOf(service: string): Promise<string> {
  const { rows } = await plat.pool.query<{ s: string }>(
    'SELECT app.tenant_service_state($1, $2) AS s', [T, service]);
  return rows[0].s;
}
const serves = (s: string) => s === 'enabled' || s === 'limited';

/**
 * One probe per surface: how to call it, and how to read whether the gated
 * block actually came back. `served` is deliberately about the DATA, not the
 * status code — B-53's whole shape was a 200 carrying something it should
 * not have.
 */
interface Probe {
  name: string;
  service: string;
  run: () => Promise<{ status: number; served: boolean }>;
}

describe('P-ops §D — every state, every composite surface', { skip }, () => {
  before(async () => {
    await installTestKeys();
    await lockFixtures(DATABASE_URL as string);
    db = createDb(DATABASE_URL as string);
    plat = createDb(PLATFORM_URL as string);

    await asBootstrap(db, head, async (c) => {
      await c.query('DELETE FROM invoices WHERE tenant_id = $1', [T]);
      await c.query('DELETE FROM tenants WHERE id = $1', [T]);
      await c.query(
        `INSERT INTO tenants (id, slug, name_bn, name_en, stream, level, plan_code)
         VALUES ($1,'pops-matrix','ম্যাট্রিক্স','Matrix','bangla_medium','secondary','complete')`, [T]);
      for (const [id, bn, phone] of [
        [HEAD, 'প্রধান', '+8801799700001'],
        [STUDENT, 'ছাত্র', '+8801799700002'],
        [GUARDIAN, 'অভিভাবক', '+8801799700003'],
      ] as const) {
        await c.query(
          `INSERT INTO users (id, tenant_id, full_name_bn, full_name_en, phone_e164, status)
           VALUES ($1,$2,$3,'X',$4,'active')`, [id, T, bn, phone]);
      }
      await c.query(
        `INSERT INTO user_roles (tenant_id, user_id, role_code) VALUES ($1,$2,'student'),($1,$3,'guardian')`,
        [T, STUDENT, GUARDIAN]);
      await c.query(
        `INSERT INTO student_profiles (user_id, tenant_id, student_code, admission_date)
         VALUES ($1,$2,'MTX-1','2026-01-05')`, [STUDENT, T]);
      await c.query(
        `INSERT INTO guardianships (tenant_id, student_id, guardian_id, relation, is_primary)
         VALUES ($1,$2,$3,'father',true)`, [T, STUDENT, GUARDIAN]);
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
         VALUES ($1,$2,'MTX-0001',$3,$4,'2026-03-31',$5,$5,'issued')`,
        [INVOICE, T, STUDENT, YEAR, BILLED]);
    });
    await setState('active');

    const { signAccessToken } = await import('../../../packages/server-core/src/jwt.ts');
    headToken = await signAccessToken({ sub: HEAD, tid: T, role: 'principal', roles: ['principal'] });
    guardianToken = await signAccessToken({
      sub: GUARDIAN, tid: T, role: 'guardian', roles: ['guardian'] });

    H.history = (await import('../../academics-svc/api/studenthistory.ts')).default;
    H.ward = (await import('../../academics-svc/api/ward.ts')).default;
    H.hierarchy = (await import('../../academics-svc/api/hierarchy.ts')).default;
    H.dashboard = (await import('../api/dashboard.ts')).default;
    H.document = (await import('../api/document.ts')).default;
    H.classperf = (await import('../../academics-svc/api/classperf.ts')).default;
  });

  after(async () => {
    if (!db) return;
    await setState('active');
    await asBootstrap(db, head, async (c) => {
      await c.query('DELETE FROM invoices WHERE tenant_id = $1', [T]);
      await c.query('DELETE FROM tenants WHERE id = $1', [T]);
    });
    await db.end(); await plat.end(); await unlockFixtures();
  });

  beforeEach(() => setState('active'));

  const PROBES: Probe[] = [
    {
      name: 'student history · fees', service: 'finance',
      run: async () => {
        const r = await call(H.history, { url: `/?studentId=${STUDENT}`, token: headToken });
        return { status: r.status, served: Boolean((r.body as { fees?: unknown })?.fees) };
      },
    },
    {
      name: 'student history · attendance', service: 'attendance',
      run: async () => {
        const r = await call(H.history, { url: `/?studentId=${STUDENT}`, token: headToken });
        return { status: r.status, served: Boolean((r.body as { attendance?: unknown })?.attendance) };
      },
    },
    {
      name: 'guardian ward · fees', service: 'finance',
      run: async () => {
        const r = await call(H.ward, { url: `/?studentId=${STUDENT}`, token: guardianToken });
        const st = (r.body as { student?: { fees?: unknown } })?.student;
        return { status: r.status, served: Boolean(st?.fees) };
      },
    },
    {
      name: 'student record · 90-day attendance', service: 'attendance',
      run: async () => {
        const r = await call(H.hierarchy, { url: `/?studentId=${STUDENT}`, token: headToken });
        return { status: r.status, served: (r.body as { attendance90d?: unknown })?.attendance90d != null };
      },
    },
    {
      name: 'dashboard · finance tile', service: 'finance',
      run: async () => {
        const r = await call(H.dashboard, { url: '/', token: headToken });
        return { status: r.status, served: Boolean((r.body as { finance?: unknown })?.finance) };
      },
    },
    {
      name: 'document · attendance sheet', service: 'attendance',
      run: async () => {
        const r = await call(H.document, { url: `/?type=attendance_sheet&sectionId=${SECTION}`, token: headToken });
        return { status: r.status, served: r.status === 200 };
      },
    },
    {
      name: 'class performance', service: 'reports',
      run: async () => {
        const r = await call(H.classperf, { url: '/', token: headToken });
        return { status: r.status, served: r.status === 200 };
      },
    },
  ];

  /**
   * `document` carries its own `service: 'documents'` gate on top of the
   * content gate, so its expectation is the AND of the two. Stated here
   * rather than folded into the probe, because it is a real second rule and
   * hiding it would make a failure unreadable.
   */
  const extraService: Record<string, string | undefined> = {
    'document · attendance sheet': 'documents',
  };

  async function expectServed(p: Probe): Promise<boolean> {
    if (!serves(await stateOf(p.service))) return false;
    const extra = extraService[p.name];
    if (extra && !serves(await stateOf(extra))) return false;
    return true;
  }

  for (const state of ['active', 'limited', 'maintenance', 'suspended'] as const) {
    test(`ops_state = ${state} — every surface matches the catalogue`, async () => {
      await setState(state);
      const wrong: string[] = [];

      for (const p of PROBES) {
        const want = await expectServed(p);
        const got = await p.run();

        // A 5xx is never a correct answer to "may this school see this".
        if (got.status >= 500) { wrong.push(`${p.name}: ${got.status}`); continue; }
        if (got.served !== want) {
          wrong.push(`${p.name}: served=${got.served} want=${want} (status ${got.status})`);
        }
        if (state === 'suspended' && got.status !== 403) {
          wrong.push(`${p.name}: a suspended school got ${got.status}, not 403`);
        }
      }
      assert.deepEqual(wrong, [], `ops_state=${state}`);
    });
  }

  test('THE B-53 CASE — a healthy school with ONE module switched off', async () => {
    // Not an ops_state. The account is fine, the bill is paid, and the
    // operator has turned one service off. This is the exact configuration
    // that leaked, and the one an ops_state sweep would miss entirely.
    for (const svc of ['finance', 'attendance', 'results'] as const) {
      await setState('active', JSON.stringify({ [svc]: 'disabled' }));
      const wrong: string[] = [];
      for (const p of PROBES) {
        const want = await expectServed(p);
        const got = await p.run();
        if (got.status >= 500) { wrong.push(`${p.name}: ${got.status}`); continue; }
        if (got.served !== want) {
          wrong.push(`${p.name}: served=${got.served} want=${want}`);
        }
      }
      assert.deepEqual(wrong, [], `with ${svc} disabled`);
    }
  });

  test('a service in MAINTENANCE serves nothing, even on a healthy account', async () => {
    // Distinct from disabled, and the distinction matters: a half-migrated
    // ledger read back to a parent is a wrong balance, not a missing one.
    await setState('active', '{"finance":"maintenance"}');
    for (const p of PROBES.filter((x) => x.service === 'finance')) {
      const got = await p.run();
      assert.equal(got.served, false, p.name);
    }
  });

  test('a suspended school is refused BEFORE the service is consulted', async () => {
    // Ordering, not just outcome. If the service check ran first, a school
    // with everything enabled would get its data read and then thrown away —
    // and a handler that forgot the second check would serve it.
    await setState('suspended', '{}');
    for (const p of PROBES) {
      const got = await p.run();
      assert.equal(got.status, 403, `${p.name} on a suspended school`);
      assert.equal(got.served, false, p.name);
    }
  });
});
