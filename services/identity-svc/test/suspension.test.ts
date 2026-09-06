/**
 * P-ops §9 — suspending a SCHOOL, and what happens to the sessions it issued.
 *
 * `deactivation.test.ts` covers the same question for one USER, and its
 * defect is worth restating because this is the same shape one level up: a
 * dismissed teacher kept working access indefinitely, because `refresh`
 * rotated the token and never re-checked `users.status`.
 *
 * B-54 says tenant suspension never got that treatment: "Restoring a school
 * silently re-arms every 30-day refresh token." So the questions here are the
 * four the section names, and each is asked against a live session rather
 * than a fresh one — a gate that only stops NEW logins is not a gate.
 *
 *   1. an access token issued before the suspension stops working
 *   2. the refresh door is shut too, so the session cannot renew itself
 *   3. reactivation restores service, and a new sign-in works
 *   4. none of it touches a second school
 *
 * ── Where the answer turns out to be structural rather than bolted on ──────
 * There is no revocation sweep here, and there does not need to be. Every
 * request opens its transaction through `withTenant`, which asks
 * `app.tenant_access` on the connection it already holds, and a suspended
 * school answers `none`. So the token is never "revoked" — it stops being
 * honoured, on every request, from the moment the operator flips the switch.
 * That is a stronger property than a revocation list, which can be stale.
 *
 * The cost is the one B-54's second sentence names, and §9's fourth
 * requirement is exactly the check that it is bounded: this must be true of
 * the suspended school and of nobody else.
 *
 *   DATABASE_URL=postgres://shikhon_app:… \
 *   PLATFORM_DATABASE_URL=postgres://shikhon_platform:… \
 *     node --test services/identity-svc/test/suspension.test.ts
 */
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { createDb, type Db, type TenantContext } from '../../../packages/server-core/src/db.ts';
import {
  installTestKeys, call, lockFixtures, unlockFixtures, asBootstrap,
} from '../../../packages/server-core/test/harness.ts';

const DATABASE_URL = process.env.DATABASE_URL;
/** Suspension is a platform act; the school cannot suspend or restore itself. */
const PLATFORM_URL = process.env.PLATFORM_DATABASE_URL;
const skip = !DATABASE_URL ? 'DATABASE_URL not set'
  : !PLATFORM_URL ? 'PLATFORM_DATABASE_URL not set' : false;

const T       = '7a540000-0000-4000-8000-00000000000a';
const HEAD    = '7a540000-0000-4000-8000-0000000000ff';
const TEACHER = '7a540000-0000-4000-8000-0000000000a1';
/** The bystander. §9's fourth requirement lives entirely on this school. */
const T_B     = '7a540000-0000-4000-8000-00000000000b';
const HEAD_B  = '7a540000-0000-4000-8000-0000000000fe';

let db: Db;
let plat: Db;
let headToken = '';
let headBToken = '';
let activate: typeof import('../api/activate.ts').default;
let refresh: typeof import('../api/refresh.ts').default;
let hierarchy: typeof import('../../academics-svc/api/hierarchy.ts').default;

const asHead: TenantContext = { tenantId: T, userId: HEAD, role: 'principal' };
const asHeadB: TenantContext = { tenantId: T_B, userId: HEAD_B, role: 'principal' };

/** The operator's switch, on the only connection allowed to throw it. */
const setOpsState = (tenant: string, state: string) => plat.pool.query(
  `INSERT INTO tenant_operations (tenant_id, ops_state, services)
   VALUES ($1, $2, '{}'::jsonb)
   ON CONFLICT (tenant_id) DO UPDATE SET ops_state = $2, state_changed_at = now()`,
  [tenant, state]);

async function dropFixtures(): Promise<void> {
  for (const ctx of [asHead, asHeadB]) {
    await asBootstrap(db, ctx, (c) =>
      c.query('DELETE FROM tenants WHERE id = $1', [ctx.tenantId]));
  }
}

describe('P-ops §9 — a suspended school, and the sessions it already issued', { skip }, () => {
  before(async () => {
    await installTestKeys();
    process.env.ACTIVATION_PEPPER ??= 'test-pepper-32-bytes-of-entropy!';
    await lockFixtures(DATABASE_URL as string);
    db = createDb(DATABASE_URL as string);
    plat = createDb(PLATFORM_URL as string);
    await dropFixtures();

    await asBootstrap(db, asHead, async (c) => {
      await c.query(
        `INSERT INTO tenants (id, slug, name_bn, name_en, stream, level)
         VALUES ($1,'pops-susp','স্থগিত','Suspended','bangla_medium','secondary')`, [T]);
      await c.query(
        `INSERT INTO users (id, tenant_id, full_name_bn, full_name_en, phone_e164, status) VALUES
           ($1,$3,'প্রধান শিক্ষক','Head','+8801799540001','active'),
           ($2,$3,'রফিক স্যার','Rafiq','+8801799540002','active')`, [HEAD, TEACHER, T]);
      await c.query(
        `INSERT INTO user_roles (tenant_id, user_id, role_code) VALUES
           ($1,$2,'principal'), ($1,$3,'subject_teacher')`, [T, HEAD, TEACHER]);
    });
    await asBootstrap(db, asHeadB, async (c) => {
      await c.query(
        `INSERT INTO tenants (id, slug, name_bn, name_en, stream, level)
         VALUES ($1,'pops-susp-b','পাশের','Bystander','bangla_medium','secondary')`, [T_B]);
      await c.query(
        `INSERT INTO users (id, tenant_id, full_name_bn, full_name_en, phone_e164, status)
         VALUES ($1,$2,'অন্য প্রধান','Head B','+8801799540003','active')`, [HEAD_B, T_B]);
      await c.query(
        `INSERT INTO user_roles (tenant_id, user_id, role_code) VALUES ($1,$2,'principal')`,
        [T_B, HEAD_B]);
    });

    const { signAccessToken } = await import('../../../packages/server-core/src/jwt.ts');
    headToken = await signAccessToken({ sub: HEAD, tid: T, role: 'principal', roles: ['principal'] });
    headBToken = await signAccessToken({
      sub: HEAD_B, tid: T_B, role: 'principal', roles: ['principal'] });

    activate = (await import('../api/activate.ts')).default;
    refresh = (await import('../api/refresh.ts')).default;
    hierarchy = (await import('../../academics-svc/api/hierarchy.ts')).default;
  });

  after(async () => {
    if (!db) return;
    await setOpsState(T, 'active');
    await dropFixtures();
    await db.end(); await plat.end(); await unlockFixtures();
  });

  // Reset here, not at the end of each test: a test that fails its assertion
  // never reaches its own restore, and the next one then sees a school still
  // suspended and reports a second, unrelated failure.
  beforeEach(async () => {
    await setOpsState(T, 'active');
    await setOpsState(T_B, 'active');
  });

  /** A real sign-in: issue a code as the head, redeem it as the teacher. */
  async function signIn(): Promise<{ refreshToken: string; deviceId: string }> {
    const issued = await call(activate, {
      method: 'POST', url: '/api/v1/auth/activate', token: headToken,
      body: { action: 'issue', userId: TEACHER },
    } as Parameters<typeof call>[1]);
    assert.equal(issued.status, 200, JSON.stringify(issued.body));

    const deviceId = randomUUID();
    const redeemed = await call(activate, {
      method: 'POST', url: '/api/v1/auth/activate',
      body: { action: 'redeem', tenantId: T, code: (issued.body as { code: string }).code, deviceId },
    } as Parameters<typeof call>[1]);
    assert.equal(redeemed.status, 200, JSON.stringify(redeemed.body));
    return {
      refreshToken: (redeemed.body as { refreshToken: string }).refreshToken,
      deviceId,
    };
  }

  const doRefresh = (refreshToken: string, deviceId: string, tenantId = T) =>
    call(refresh, {
      method: 'POST', url: '/api/v1/auth/refresh',
      body: { tenantId, refreshToken, deviceId },
    } as Parameters<typeof call>[1]);

  /** An ordinary read, with a token minted before anything was suspended. */
  const readSomething = (token: string, student = TEACHER) =>
    call(hierarchy, { url: `/?studentId=${student}`, token });

  test('THE ONE THAT MATTERS — a LIVE session stops the moment the school is suspended', async () => {
    // The token is minted first and never re-issued. A gate that only stopped
    // new logins would let this same request keep working all month.
    const before = await readSomething(headToken);
    assert.ok(before.status < 500, `baseline: ${before.status}`);
    assert.notEqual(before.status, 403, 'the session must work before suspension');

    await setOpsState(T, 'suspended');

    const after = await readSomething(headToken);
    assert.equal(after.status, 403, 'a suspended school kept serving an old token');
    assert.equal((after.body as { error: string }).error, 'tenant_blocked',
      'and it must say WHICH refusal — a payment, not a different person');
  });

  test('the refresh door is shut too — the session cannot renew itself', async () => {
    // B-54's real sting. Refresh ROTATES, so a door left open here is not a
    // 15-minute window; it is a session that renews itself forever.
    const { refreshToken, deviceId } = await signIn();
    const ok = await doRefresh(refreshToken, deviceId);
    assert.equal(ok.status, 200, `baseline refresh: ${JSON.stringify(ok.body)}`);
    const rotated = (ok.body as { refreshToken: string }).refreshToken;

    await setOpsState(T, 'suspended');

    const denied = await doRefresh(rotated, deviceId);
    assert.equal(denied.status, 403,
      'a suspended school renewed a session, which makes the suspension cosmetic');
  });

  test('reactivation restores service, and a NEW sign-in works', async () => {
    // The half that decides whether an operator dares use the switch at all.
    await setOpsState(T, 'suspended');
    assert.equal((await readSomething(headToken)).status, 403);

    await setOpsState(T, 'active');

    const back = await readSomething(headToken);
    assert.notEqual(back.status, 403, 'restoring the school must restore its sessions');

    const { refreshToken, deviceId } = await signIn();
    const fresh = await doRefresh(refreshToken, deviceId);
    assert.equal(fresh.status, 200, 'and a brand-new sign-in must work after restoration');
  });

  test('§9.4 — none of it touches the school next door', async () => {
    // The bound on everything above. `app.tenant_access` takes a tenant id,
    // so this ought to be structural — and "ought to be" is exactly the
    // assumption a suspension bug is made of.
    await setOpsState(T, 'suspended');

    const neighbour = await readSomething(headBToken, HEAD_B);
    assert.notEqual(neighbour.status, 403,
      'suspending one school refused another school’s session');

    const { rows } = await plat.pool.query<{ ops_state: string }>(
      'SELECT ops_state FROM tenant_operations WHERE tenant_id = $1', [T_B]);
    assert.equal(rows[0]?.ops_state, 'active',
      'and it must not have moved the neighbour’s switch either');
  });

  test('B-54’s second claim — can a school in ARREARS still log in?', async () => {
    // The row says: "read-only mode in practice locks everyone out, because
    // the auth endpoints are themselves gated — nobody can log in, refresh or
    // log out."
    //
    // If true it is serious and not cosmetic: `limited` exists so a school
    // behind on fees can still READ its own records. A session that cannot
    // refresh ends at the access token's expiry, so every user is signed out
    // within minutes and cannot get back in — which is suspension wearing a
    // gentler name, and would make the arrears state useless.
    //
    // Refresh ROTATES the token, so it is a WRITE inside a transaction the
    // gate has set `transaction_read_only = on` for. That is the mechanism
    // the claim rests on, and this is the test that says which way it goes.
    const { refreshToken, deviceId } = await signIn();
    await setOpsState(T, 'limited');

    const renewed = await doRefresh(refreshToken, deviceId);
    const canRead = await readSomething(headToken);

    assert.notEqual(canRead.status, 403,
      'a read-only school must still be able to READ — that is the whole state');
    assert.equal(renewed.status, 200,
      'a school in arrears cannot renew a session, so everyone is locked out '
      + 'within one access-token lifetime — read-only becomes suspension');
  });

  test('a suspended school’s own operator console is still reachable', async () => {
    // Otherwise suspension is a one-way door: the console reaches INTO a
    // blocked school with `skipGate`, and that is how it gets reopened. If
    // this ever regresses, every suspension becomes permanent.
    await setOpsState(T, 'suspended');
    // `platform_operations` returns the school's commercial and operational
    // state, not its id — the id is the argument. One row means found.
    const { rows } = await plat.pool.query<{ ops_state: string; access: string }>(
      'SELECT ops_state, access FROM app.platform_operations($1)', [T]);
    assert.equal(rows.length, 1, 'a suspended school must stay visible to the console');
    assert.equal(rows[0].ops_state, 'suspended');
    assert.equal(rows[0].access, 'none', 'and the console must see WHY it is blocked');

    await setOpsState(T, 'active');
    assert.notEqual((await readSomething(headToken)).status, 403);
  });
});
