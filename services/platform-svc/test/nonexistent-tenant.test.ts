/**
 * An operations endpoint must not succeed against a school that is not there.
 *
 * ── The defect ──────────────────────────────────────────────────────────
 * `POST /platform/opsstate`, `/portal`, `/service` and `/grace` each ran
 *
 *     UPDATE tenant_operations SET … WHERE tenant_id = $1
 *
 * with no rowCount check, then wrote an audit row, then returned 200. Handed a
 * mistyped uuid the operator saw a green success, `audit.platform_access`
 * recorded an act that never occurred, and nothing changed. Observed before the
 * fix, against a uuid with zero rows in `tenants`:
 *
 *     POST /opsstate -> 200   audit: ops_state=suspended
 *     POST /portal   -> 200   audit: portal teacher=closed
 *     POST /grace    -> 200   audit: grace_until=2026-12-31
 *
 * `/status` was better and still wrong: `app.set_tenant_status` raises P0002,
 * but only SQLSTATE 02000 was mapped, so it answered 500 — "we are broken"
 * where the truth was "that school is not here".
 *
 * This is the same defect migration 053 fixed for `app.set_student_cap`. Its
 * header says it plainly: "`UPDATE tenants SET student_cap` as the platform
 * role matched no row, reported success, and changed nothing." One endpoint got
 * that fix; five did not.
 *
 * ── What is asserted ────────────────────────────────────────────────────
 * Every refusal is paired with the same call against a REAL school, because an
 * endpoint that 404s at everything would pass a one-sided test. And the audit
 * trail is counted before and after: a refusal that still logs is half the bug.
 *
 *   PLATFORM_DATABASE_URL=… DATABASE_URL=… \
 *     node --test services/platform-svc/test/nonexistent-tenant.test.ts
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { createDb, type Db } from '../../../packages/server-core/src/db.ts';
import { installTestKeys, call, lockFixtures, unlockFixtures } from '../../../packages/server-core/test/harness.ts';

const PLATFORM_URL = process.env.PLATFORM_DATABASE_URL;
const DATABASE_URL = process.env.DATABASE_URL;
const skip = !PLATFORM_URL || !DATABASE_URL ? 'PLATFORM_DATABASE_URL / DATABASE_URL not set' : false;

const KEY = 'test-platform-key-nx';
const OPERATOR = '7a900000-0000-4000-8000-0000000000aa';
const SLUG = 'p0-nx-school';
/** A bystander. Every mutation below is aimed at the first school; this one
 *  exists only to be checked afterwards for damage. */
const SLUG_B = 'p0-nx-bystander';

/** A syntactically perfect uuid that is not, and never was, a school. */
const GHOST = '11111111-1111-4111-8111-111111111111';

let db: Db;
let platform: typeof import('../api/index.ts').default;
let opToken = '';
let realTenant = '';
let bystander = '';

const asOperator = (url: string, body?: unknown) =>
  call(platform, {
    url, token: opToken,
    ...(body === undefined ? {} : { method: 'POST', body }),
    headers: { 'x-platform-key': KEY },
  } as Parameters<typeof call>[1]);

/** Audit rows for one tenant id. The count is the point, not the content. */
async function auditRows(tenantId: string): Promise<number> {
  const { rows } = await db.pool.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM audit.platform_access WHERE tenant_id = $1`,
    [tenantId]);
  return Number(rows[0].n);
}

async function dropFixture(): Promise<void> {
  const { rows } = await db.pool.query<{ id: string }>(
    `SELECT id FROM app.platform_tenants() WHERE slug = ANY($1)`, [[SLUG, SLUG_B]]);
  for (const r of rows) {
    // From inside the tenant's own context: migration 045 took BYPASSRLS off
    // the platform role, so a bare DELETE matches nothing at all — silently.
    await db.withTenant({ tenantId: r.id, userId: '', role: 'system_ingest' },
      (c) => c.query('DELETE FROM tenants WHERE id = $1', [r.id]),
      { skipGate: true });
  }
}

describe('an operations endpoint refuses a school that does not exist', { skip }, () => {
  before(async () => {
    await installTestKeys();
    process.env.PLATFORM_API_KEY = KEY;
    // `/admin` mints an activation code and refuses without this, so the
    // cross-tenant test below would never reach the write it is checking.
    process.env.ACTIVATION_PEPPER ??= 'test-pepper-32-bytes-of-entropy!';
    await lockFixtures(DATABASE_URL as string);
    db = createDb(PLATFORM_URL as string);
    platform = (await import('../api/index.ts')).default;

    const { signAccessToken } = await import('../../../packages/server-core/src/jwt.ts');
    opToken = await signAccessToken({
      sub: OPERATOR, tid: OPERATOR, role: 'super_admin', roles: ['super_admin'] });

    await dropFixture();
    const made = await asOperator('/api/v1/platform/tenants', {
      slug: SLUG, nameBn: 'পি-শূন্য বিদ্যালয়', nameEn: 'P0 School',
      stream: 'bangla_medium', level: 'secondary',
    });
    assert.equal(made.status, 200, JSON.stringify(made.body));
    realTenant = (made.body as { tenant: { id: string } }).tenant.id;

    const other = await asOperator('/api/v1/platform/tenants', {
      slug: SLUG_B, nameBn: 'পাশের বিদ্যালয়', nameEn: 'Bystander School',
      stream: 'bangla_medium', level: 'secondary',
    });
    assert.equal(other.status, 200, JSON.stringify(other.body));
    bystander = (other.body as { tenant: { id: string } }).tenant.id;
  });

  after(async () => { if (db) { await dropFixture(); await db.end(); await unlockFixtures(); } });

  /** The five endpoints, each with a body that is valid apart from the tenant. */
  const CALLS: Array<[string, (id: string) => Record<string, unknown>]> = [
    ['opsstate', (id) => ({ tenantId: id, state: 'maintenance', reason: 'regression test' })],
    ['portal', (id) => ({ tenantId: id, portal: 'teacher', open: false, reason: 'regression test' })],
    // `state`, not `enabled` — the service switch is four-valued
    // (enabled | disabled | limited | maintenance), not a boolean.
    ['service', (id) => ({ tenantId: id, service: 'attendance', state: 'disabled', reason: 'regression test' })],
    ['grace', (id) => ({ tenantId: id, until: '2026-12-31', reason: 'regression test' })],
    ['status', (id) => ({ tenantId: id, status: 'suspended', reason: 'regression test' })],
  ];

  /**
   * P-ops §4. The five above are the ones B-52 named. They are not the only
   * mutations this console offers, and "the four we know about are guarded"
   * is exactly the shape of assurance that produced B-52 in the first place —
   * `/status` had the fix and five siblings did not.
   *
   * So this is EVERY remaining POST that takes a `tenantId`, derived from the
   * dispatcher's own case list rather than from memory. `plans` is absent
   * because it edits the platform-wide price list and names no school;
   * `provision` and `tenants` are absent because they CREATE, and an id that
   * is not there yet is their normal input rather than an error.
   */
  const MORE_CALLS: Array<[string, (id: string) => Record<string, unknown>]> = [
    ['plan', (id) => ({ tenantId: id, planCode: 'starter', reason: 'regression test' })],
    ['cap', (id) => ({ tenantId: id, studentCap: 500, reason: 'regression test' })],
    ['branding', (id) => ({ tenantId: id, branding: { primaryColor: '#D23B2E' }, reason: 'regression test' })],
    // `nameBn` / `roleCode`, the names the handler actually reads. Getting
    // these wrong made the call 400 on body validation before the tenant was
    // ever looked at — which still counts as a refusal, and proves nothing
    // about the guard.
    ['admin', (id) => ({ tenantId: id, nameBn: 'পরীক্ষা', phone: '+8801799440001',
                        roleCode: 'principal', reason: 'regression test' })],
    ['payment', (id) => ({ tenantId: id, amountBdt: 1000, method: 'bkash',
                           paidOn: '2026-09-03', reference: 'RT-1',
                           reason: 'regression test' })],
  ];

  test('THE ONE THAT MATTERS — every endpoint 404s, and writes nothing', async () => {
    const before = await auditRows(GHOST);

    for (const [route, body] of CALLS) {
      const r = await asOperator(`/api/v1/platform/${route}`, body(GHOST));
      assert.equal(r.status, 404,
        `${route} must refuse a nonexistent school, got ${r.status}: ${JSON.stringify(r.body)}`);
      assert.equal((r.body as { error: string }).error, 'not_found', route);
    }

    // The half that matters most: a refusal that still logs would leave the
    // trail asserting five things that never happened.
    assert.equal(await auditRows(GHOST), before,
      'a refused operation must not write an audit row');
  });

  test('P-ops §4 — the OTHER mutations refuse a ghost too, and write nothing', async () => {
    // The generalisation of B-52. Each of these takes a tenantId and, if
    // unguarded, would report success for a school that does not exist.
    const before = await auditRows(GHOST);
    const wrong: string[] = [];

    for (const [route, body] of MORE_CALLS) {
      const r = await asOperator(`/api/v1/platform/${route}`, body(GHOST));
      // 404 is the right answer; any 4xx that names the tenant is defensible.
      // A 2xx is not, and neither is a 500 — "we are broken" where the truth
      // is "that school is not here" is the exact mistake `/status` made.
      if (r.status < 400 || r.status >= 500) {
        wrong.push(`${route} -> ${r.status} ${JSON.stringify(r.body)}`);
      }
    }
    assert.deepEqual(wrong, [], 'a mutation reported success (or 500) for a ghost school');

    assert.equal(await auditRows(GHOST), before,
      'a refused operation must not leave a trail saying it happened');
  });

  test('the same calls still work on a real school', async () => {
    // Without this the test above would pass on an endpoint that 404s at
    // everything, which is a different outage wearing the same status code.
    for (const [route, body] of CALLS) {
      if (route === 'status') continue;             // asserted separately below
      const r = await asOperator(`/api/v1/platform/${route}`, body(realTenant));
      assert.equal(r.status, 200,
        `${route} must still work: ${JSON.stringify(r.body)}`);
    }
    assert.ok(await auditRows(realTenant) >= 4, 'real operations must be audited');
  });

  test('P-ops §4 — a mutation aimed at one school does not reach another', async () => {
    // The third case the section asks for, after valid and nonexistent.
    //
    // For a TENANT-facing endpoint this is RLS's job and 227 policies do it.
    // The platform console is the one surface deliberately allowed across
    // schools, so nothing structural stops a missing or mistyped WHERE from
    // writing every row — `app.set_student_cap`'s header records exactly that
    // class of mistake. The only way to know is to keep a bystander and look
    // at it afterwards.
    const snapshot = async (id: string) => {
      const r = await asOperator(`/api/v1/platform/tenant?id=${id}`);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      return JSON.stringify(r.body);
    };
    const beforeB = await snapshot(bystander);
    const auditBeforeB = await auditRows(bystander);

    for (const [route, body] of [...CALLS, ...MORE_CALLS]) {
      if (route === 'status') continue;      // it suspends, and is asserted below
      const r = await asOperator(`/api/v1/platform/${route}`, body(realTenant));
      assert.ok(r.status < 400, `${route} on a real school: ${JSON.stringify(r.body)}`);
    }

    assert.equal(await snapshot(bystander), beforeB,
      'a mutation aimed at one school changed another');
    assert.equal(await auditRows(bystander), auditBeforeB,
      'and it must not have been written into the bystander’s trail either');
  });

  test('a suspended school is FOUND, not refused', async () => {
    const off = await asOperator('/api/v1/platform/status',
      { tenantId: realTenant, status: 'suspended', reason: 'regression test' });
    assert.equal(off.status, 200, JSON.stringify(off.body));

    // Bringing it back is refused here for an unrelated and correct reason:
    // this fixture school has no academic year, no grading scale and no
    // admin, and P7's activation gate blocks 'active' until it does. What
    // matters for THIS test is which refusal it is — 409 activation_blocked
    // means the school was found and judged; 404 would mean suspending it had
    // made it invisible, and it could never be brought back at all.
    const on = await asOperator('/api/v1/platform/status',
      { tenantId: realTenant, status: 'active', reason: 'regression test restore' });
    assert.notEqual(on.status, 404, 'a suspended school must still be found');
    assert.equal(on.status, 409, JSON.stringify(on.body));
    assert.equal((on.body as { error: string }).error, 'activation_blocked');

    // opsstate is not gated on activation readiness, so the school really is
    // operable while suspended.
    const ops = await asOperator('/api/v1/platform/opsstate',
      { tenantId: realTenant, state: 'active', reason: 'regression test restore' });
    assert.equal(ops.status, 200, JSON.stringify(ops.body));
  });

  test('an archived school is found too', async () => {
    const arch = await asOperator('/api/v1/platform/status',
      { tenantId: realTenant, status: 'archived', reason: 'regression test' });
    assert.equal(arch.status, 200, JSON.stringify(arch.body));

    const back = await asOperator('/api/v1/platform/opsstate',
      { tenantId: realTenant, state: 'active', reason: 'regression test restore' });
    assert.equal(back.status, 200,
      'archived is how a school leaves; it must still be operable');

    // Left archived deliberately: returning it to 'active' hits the same
    // activation gate as above, and this test is about being FOUND.
  });

  test('a malformed tenant id is a 400, not a 404', async () => {
    // Different fault, different answer: "you sent nonsense" is not "that
    // school is not here", and an operator debugging a script needs to know
    // which one it was.
    for (const bad of ['not-a-uuid', '', '11111111-1111-4111-8111', '../../etc/passwd']) {
      const r = await asOperator('/api/v1/platform/opsstate',
        { tenantId: bad, state: 'maintenance', reason: 'regression test' });
      assert.equal(r.status, 400, `${JSON.stringify(bad)} -> ${r.status}`);
    }
  });

  test('an unauthorized caller is refused before the tenant is ever looked up', async () => {
    // The existence check must not become an oracle: a caller without the
    // service key must not learn whether a uuid is a school.
    const noKey = await call(platform, {
      url: '/api/v1/platform/opsstate', token: opToken, method: 'POST',
      body: { tenantId: realTenant, state: 'maintenance', reason: 'regression test' },
    } as Parameters<typeof call>[1]);
    assert.ok(noKey.status === 401 || noKey.status === 403, `got ${noKey.status}`);

    const ghostNoKey = await call(platform, {
      url: '/api/v1/platform/opsstate', token: opToken, method: 'POST',
      body: { tenantId: GHOST, state: 'maintenance', reason: 'regression test' },
    } as Parameters<typeof call>[1]);
    assert.equal(ghostNoKey.status, noKey.status,
      'a real and a fake tenant must be indistinguishable to an unauthorized caller');
  });
});
