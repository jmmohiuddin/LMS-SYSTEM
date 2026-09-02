/**
 * M1 — a deactivated account loses access, and can be given it back.
 *
 * ── The defect this exists to prevent ───────────────────────────────────
 * The final full-project audit proved, against a running stack, that a
 * deactivated user kept full access indefinitely:
 *
 *     plant a valid refresh session for a real principal
 *     UPDATE users SET status = 'left'
 *     POST /api/v1/auth/refresh   →  200, fresh access token, principal role
 *
 * Two things combined to make it permanent. `refresh` was the only one of
 * the three auth doors that did not check `users.status` — `activate` and
 * `otp-verify` both did. And because refresh ROTATES the refresh token, the
 * session never aged out: a dismissed teacher with the app still installed
 * kept working access for as long as they opened it.
 *
 * ── What is asserted here ───────────────────────────────────────────────
 * Every negative is paired with the positive that proves the negative is not
 * simply everything being broken — the audit plan's §14 evidence rule. So:
 * refresh WORKS while active, STOPS on deactivation, and WORKS AGAIN after
 * reactivation and a fresh sign-in.
 *
 * The three layers are asserted independently, because each protects
 * against a different mistake:
 *
 *   1. the session is revoked        — deactivation ends what already exists
 *   2. refresh refuses by status     — and says WHICH status, for the office
 *   3. loadRoles refuses by status   — the shared door, so a future fourth
 *                                      auth endpoint cannot forget
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { createDb, type Db, type TenantContext } from '../../../packages/server-core/src/db.ts';
import {
  installTestKeys, call, lockFixtures, unlockFixtures, asBootstrap,
} from '../../../packages/server-core/test/harness.ts';
import { loadRoles } from '../src/roles.ts';

const DATABASE_URL = process.env.DATABASE_URL;
const skip = !DATABASE_URL ? 'DATABASE_URL not set' : false;

const T       = '7ae00000-0000-4000-8000-00000000000a';
const HEAD    = '7ae00000-0000-4000-8000-0000000000ff';
const TEACHER = '7ae00000-0000-4000-8000-0000000000a1';

let db: Db;
let headToken: string;
let activate: typeof import('../api/activate.ts').default;
let refresh: typeof import('../api/refresh.ts').default;
let users: typeof import('../../ops-svc/api/users.ts').default;

const asHead: TenantContext = { tenantId: T, userId: HEAD, role: 'principal' };

async function dropFixtures(): Promise<void> {
  await asBootstrap(db, asHead, async (c) => {
    await c.query('DELETE FROM tenants WHERE id = $1', [T]);
  });
}

/** Whatever the database currently thinks, read outside any handler. */
async function statusOf(userId: string): Promise<string> {
  return asBootstrap(db, asHead, async (c) => {
    const { rows } = await c.query<{ s: string }>(
      `SELECT status::text AS s FROM users WHERE id = $1`, [userId]);
    return rows[0]?.s ?? '(gone)';
  });
}

/** Test setup only: start a case from a known session state. */
async function clearSessions(userId: string): Promise<void> {
  await asBootstrap(db, asHead, (c) =>
    c.query(
      `UPDATE user_sessions SET revoked_at = now(), revoked_reason = 'test_reset'
        WHERE user_id = $1 AND revoked_at IS NULL`, [userId]));
}

async function liveSessions(userId: string): Promise<number> {
  return asBootstrap(db, asHead, async (c) => {
    const { rows } = await c.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM user_sessions
        WHERE user_id = $1 AND revoked_at IS NULL`, [userId]);
    return Number(rows[0].n);
  });
}

describe('M1 — deactivation ends access', { skip }, () => {
  before(async () => {
    await installTestKeys();
    process.env.ACTIVATION_PEPPER = 'test-pepper-32-bytes-of-entropy!';
    await lockFixtures(DATABASE_URL as string);
    db = createDb(DATABASE_URL as string);
    await dropFixtures();

    await asBootstrap(db, asHead, async (c) => {
      await c.query(
        `INSERT INTO tenants (id, slug, name_bn, name_en, stream, level)
         VALUES ($1,'m1-deact','নিষ্ক্রিয়','Deactivation','bangla_medium','secondary')`, [T]);
      await c.query(
        `INSERT INTO users (id, tenant_id, full_name_bn, full_name_en, phone_e164, status) VALUES
           ($1,$3,'প্রধান শিক্ষক','Head','+8801799610001','active'),
           ($2,$3,'রফিক স্যার','Rafiq','+8801799610002','active')`,
        [HEAD, TEACHER, T]);
      await c.query(
        `INSERT INTO user_roles (tenant_id, user_id, role_code) VALUES
           ($1,$2,'principal'), ($1,$3,'subject_teacher')`, [T, HEAD, TEACHER]);
    });

    const { signAccessToken } = await import('../../../packages/server-core/src/jwt.ts');
    headToken = await signAccessToken({
      sub: HEAD, tid: T, role: 'principal', roles: ['principal'] });

    activate = (await import('../api/activate.ts')).default;
    refresh = (await import('../api/refresh.ts')).default;
    users = (await import('../../ops-svc/api/users.ts')).default;
  });

  after(async () => { if (db) { await dropFixtures(); await db.end(); await unlockFixtures(); } });

  /** Sign the teacher in for real: issue a code, redeem it, keep the tokens. */
  async function signIn(): Promise<{ refreshToken: string; deviceId: string }> {
    const issued = await call(activate, {
      method: 'POST', url: '/api/v1/auth/activate', token: headToken,
      body: { action: 'issue', userId: TEACHER },
    } as Parameters<typeof call>[1]);
    assert.equal(issued.status, 200, JSON.stringify(issued.body));
    const code = (issued.body as { code: string }).code;

    const deviceId = randomUUID();
    const redeemed = await call(activate, {
      method: 'POST', url: '/api/v1/auth/activate',
      body: { action: 'redeem', tenantId: T, code, deviceId },
    } as Parameters<typeof call>[1]);
    assert.equal(redeemed.status, 200, JSON.stringify(redeemed.body));
    return {
      refreshToken: (redeemed.body as { refreshToken: string }).refreshToken,
      deviceId,
    };
  }

  const doRefresh = (refreshToken: string, deviceId: string) =>
    call(refresh, {
      method: 'POST', url: '/api/v1/auth/refresh',
      body: { tenantId: T, refreshToken, deviceId },
    } as Parameters<typeof call>[1]);

  const setActive = (active: boolean) =>
    call(users, {
      method: 'PATCH', url: '/api/v1/ops/users', token: headToken,
      body: { userId: TEACHER, active },
    } as Parameters<typeof call>[1]);

  test('THE ONE THAT MATTERS — active refreshes, deactivated does not', async () => {
    // ── POSITIVE ──
    const { refreshToken, deviceId } = await signIn();
    assert.equal(await liveSessions(TEACHER), 1, 'signing in did not create a session');

    const ok = await doRefresh(refreshToken, deviceId);
    assert.equal(ok.status, 200, `an active teacher must refresh: ${JSON.stringify(ok.body)}`);
    const rotated = (ok.body as { refreshToken: string }).refreshToken;
    assert.ok(rotated && rotated !== refreshToken, 'refresh must rotate the token');

    // ── the act ──
    const off = await setActive(false);
    assert.equal(off.status, 200, JSON.stringify(off.body));
    assert.equal(await statusOf(TEACHER), 'left');

    // ── NEGATIVE: the rotated token, which is the one the phone now holds ──
    const denied = await doRefresh(rotated, deviceId);
    assert.equal(denied.status, 401,
      `a deactivated teacher must not refresh: ${JSON.stringify(denied.body)}`);
    // 401, not 403, and that is the first layer working rather than the
    // second: deactivation REVOKED the session, so the lookup finds nothing
    // before status is ever consulted. The token in their hand is dead, not
    // merely refused. Layer two is proved on its own below, against the
    // exact shape the audit found — a live session whose account was
    // switched off without going through this endpoint.
    assert.equal((denied.body as { error: string }).error, 'invalid_refresh_token');
  });

  test('THE ONE THAT MATTERS — a live session whose account was switched off', async () => {
    // This is the audit's finding reproduced exactly: status changes WITHOUT
    // the revocation (a direct database change, a bulk import, a future code
    // path that forgets). Before M1 this returned 200 with a fresh principal
    // token. It is the reason the check exists in `refresh` as well as in
    // `setStatus`.
    await setActive(true);
    const { refreshToken, deviceId } = await signIn();
    assert.equal(await liveSessions(TEACHER), 1);

    await asBootstrap(db, asHead, (c) =>
      c.query(`UPDATE users SET status = 'left' WHERE id = $1`, [TEACHER]));
    assert.equal(await liveSessions(TEACHER), 1, 'the session is deliberately still live');

    const r = await doRefresh(refreshToken, deviceId);
    assert.equal(r.status, 403, `the account is off: ${JSON.stringify(r.body)}`);
    assert.equal((r.body as { error: string }).error, 'account_not_active');
    // The message names the state, so the office is not sent hunting through
    // role assignments for a problem that is not there.
    assert.match((r.body as { message: string }).message, /left/);

    // And the session was NOT silently consumed by the failed attempt — a
    // refusal must not also destroy the evidence of what was signed in.
    assert.equal(await liveSessions(TEACHER), 1);
  });

  test('deactivation revokes the sessions that already exist', async () => {
    await setActive(true);
    await clearSessions(TEACHER);   // the previous case leaves one live on purpose
    await signIn();
    await signIn();
    assert.equal(await liveSessions(TEACHER), 2, 'two devices, two sessions');

    const off = await setActive(false);
    assert.equal((off.body as { sessionsRevoked: number }).sessionsRevoked, 2);
    assert.equal(await liveSessions(TEACHER), 0,
      'blocking the next refresh is not the same as signing somebody out');
  });

  test('the ORIGINAL token fails too, not just the rotated one', async () => {
    // Rotation marks the old token `superseded`; deactivation must not
    // accidentally resurrect it.
    await setActive(true);
    const { refreshToken, deviceId } = await signIn();
    await doRefresh(refreshToken, deviceId);          // rotate once
    await setActive(false);

    const r = await doRefresh(refreshToken, deviceId);
    assert.equal(r.status, 401, 'a superseded token must stay dead');
  });

  test('loadRoles itself refuses a deactivated account — the shared door', async () => {
    // Asserted directly, because this is the layer that protects the auth
    // endpoint nobody has written yet.
    await setActive(false);
    const snap = await asBootstrap(db, asHead, (c) => loadRoles(c, T, TEACHER));
    assert.deepEqual(snap, { primaryRole: '', roles: [] },
      'a deactivated user must resolve to no roles at all');

    await setActive(true);
    const back = await asBootstrap(db, asHead, (c) => loadRoles(c, T, TEACHER));
    assert.equal(back.primaryRole, 'subject_teacher',
      'and a reactivated user must get their role back');
  });

  test('a deactivated account cannot be activated with a fresh code', async () => {
    // The recovery path must not be a way back in for an account somebody
    // deliberately switched off.
    await setActive(true);
    const issued = await call(activate, {
      method: 'POST', url: '/api/v1/auth/activate', token: headToken,
      body: { action: 'issue', userId: TEACHER },
    } as Parameters<typeof call>[1]);
    const code = (issued.body as { code: string }).code;

    await setActive(false);

    const r = await call(activate, {
      method: 'POST', url: '/api/v1/auth/activate',
      body: { action: 'redeem', tenantId: T, code, deviceId: randomUUID() },
    } as Parameters<typeof call>[1]);
    assert.equal(r.status, 403, JSON.stringify(r.body));
    assert.equal((r.body as { error: string }).error, 'account_not_active');
  });

  test('reactivation restores the account, and recovery still works', async () => {
    // The positive that proves none of the above is just "everything is
    // broken now": the whole loop has to come back.
    const on = await setActive(true);
    assert.equal(on.status, 200);
    assert.equal(await statusOf(TEACHER), 'active');
    // Reactivating revokes nothing — there is nothing left to revoke, and a
    // reactivated teacher signs in again like anyone else.
    assert.equal((on.body as { sessionsRevoked: number }).sessionsRevoked, 0);

    const { refreshToken, deviceId } = await signIn();
    const r = await doRefresh(refreshToken, deviceId);
    assert.equal(r.status, 200, `reactivated teacher must work again: ${JSON.stringify(r.body)}`);
  });
});
