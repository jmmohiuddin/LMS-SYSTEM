/**
 * R-9 — /api/v1/ops/push.
 *
 * Two things make this endpoint different from every other one in ops-svc, and
 * both are what this suite is mostly about.
 *
 *   1. It accepts a URL that the SERVER will later make requests to. That is
 *      the shape of an SSRF, and the caller is an ordinary authenticated user
 *      — a parent, a student — so "authenticated" is not a defence.
 *
 *   2. What it stores is a capability, not a record. Anyone holding a push
 *      endpoint can put a notification on that person's phone. So the response
 *      never returns one, and no role — including the principal — can read
 *      another person's.
 *
 * The database-level half of (2) is `db/tests/web_push.sql`. This is the HTTP
 * contract, and the validation that stops a bad subscription being stored at
 * all.
 *
 *   DATABASE_URL=postgresql://… node --test services/ops-svc/test/push.test.ts
 */
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { createDb, type Db, type TenantContext } from '../../../packages/server-core/src/db.ts';
import { installTestKeys, call, lockFixtures, unlockFixtures} from '../../../packages/server-core/test/harness.ts';
import { generateVapidKeys } from '../../../packages/server-core/src/web-push.ts';
import { assertSafePushEndpoint } from '../api/push.ts';
import { HttpError } from '../../../packages/server-core/src/http.ts';

const DATABASE_URL = process.env.DATABASE_URL;
const skip = !DATABASE_URL ? 'DATABASE_URL not set' : false;

const A     = '9ca00000-0000-4000-8000-00000000000a';
const B     = '9ca00000-0000-4000-8000-00000000000b';
const HEAD  = '9ca00000-0000-4000-8000-0000000000a1';
const MUM   = '9ca00000-0000-4000-8000-0000000000a2';
const BMUM  = '9ca00000-0000-4000-8000-0000000000b1';

/** A real-shaped subscription: 65-byte point, 16-byte secret, both base64url. */
const KEYS = {
  p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  auth: 'BTBZMqHH6r4Tts7J_aSIgg',
};
const EP = (s: string) => `https://fcm.googleapis.com/fcm/send/${s}`;

let db: Db;
let push: typeof import('../api/push.ts').default;
let mumToken = '';
let headToken = '';
let bmumToken = '';
const asA: TenantContext = { tenantId: A, userId: HEAD, role: 'principal' };

/**
 * Cleanup runs as `system_ingest`, not as the principal.
 *
 * `push_delete_scope` admits the row's OWNER and the sender, and nobody else —
 * which is the policy this suite exists to prove, so a fixture that tidied up
 * as the principal deleted nothing and left every test after it looking at the
 * previous test's rows. The policy is right; the fixture was wrong.
 */
async function clearSubscriptions(): Promise<void> {
  for (const tenantId of [A, B]) {
    await db.withTenant({ tenantId, userId: '', role: 'system_ingest' }, async (c) => {
      await c.query('DELETE FROM push_subscriptions WHERE tenant_id = $1', [tenantId]);
    });
  }
}

async function dropFixtures(): Promise<void> {
  await clearSubscriptions().catch(() => undefined);
  for (const tenantId of [A, B]) {
    await db.withTenant({ tenantId, userId: HEAD, role: 'principal' }, async (c) => {
      await c.query('DELETE FROM tenants WHERE id = $1', [tenantId]);
    });
  }
}

describe('R-9 — the push endpoint', { skip }, () => {
  before(async () => {
    await installTestKeys();
    const vapid = generateVapidKeys();
    process.env.VAPID_PUBLIC_KEY = vapid.publicKey;
    process.env.VAPID_PRIVATE_KEY = vapid.privateKey;

    // Serialised against other runs of this same suite — the fixtures below

    // live at fixed uuids and two processes would delete each other's.

    await lockFixtures(DATABASE_URL as string);

    db = createDb(DATABASE_URL as string);
    await dropFixtures();
    await db.withTenant(asA, async (c) => {
      await c.query(
        `INSERT INTO tenants (id, slug, name_bn, name_en, stream, level)
         VALUES ($1,'r9-api-a','আলফা','Alpha','bangla_medium','secondary')`, [A]);
      await c.query(
        `INSERT INTO users (id, tenant_id, full_name_bn, full_name_en, phone_e164, status) VALUES
           ($1,$3,'প্রধান','Head','+8801799710001','active'),
           ($2,$3,'অভিভাবক','Parent','+8801799710002','active')`, [HEAD, MUM, A]);
      await c.query(
        `INSERT INTO user_roles (tenant_id, user_id, role_code) VALUES
           ($1,$2,'principal'), ($1,$3,'guardian')`, [A, HEAD, MUM]);
    });
    await db.withTenant({ tenantId: B, userId: BMUM, role: 'guardian' }, async (c) => {
      await c.query(
        `INSERT INTO tenants (id, slug, name_bn, name_en, stream, level)
         VALUES ($1,'r9-api-b','বিটা','Beta','bangla_medium','secondary')`, [B]);
      await c.query(
        `INSERT INTO users (id, tenant_id, full_name_bn, full_name_en, phone_e164, status)
         VALUES ($1,$2,'অন্য অভিভাবক','Other','+8801799710003','active')`, [BMUM, B]);
      await c.query(
        `INSERT INTO user_roles (tenant_id, user_id, role_code) VALUES ($1,$2,'guardian')`,
        [B, BMUM]);
    });

    const { signAccessToken } = await import('../../../packages/server-core/src/jwt.ts');
    mumToken  = await signAccessToken({ sub: MUM,  tid: A, role: 'guardian',  roles: ['guardian'] });
    headToken = await signAccessToken({ sub: HEAD, tid: A, role: 'principal', roles: ['principal'] });
    bmumToken = await signAccessToken({ sub: BMUM, tid: B, role: 'guardian',  roles: ['guardian'] });
    push = (await import('../api/push.ts')).default;
  });

  after(async () => {
    if (db) { await dropFixtures(); await db.end(); await unlockFixtures(); }
    delete process.env.VAPID_PUBLIC_KEY;
    delete process.env.VAPID_PRIVATE_KEY;
  });

  beforeEach(clearSubscriptions);

  const get = (token: string) =>
    call(push, { method: 'GET', url: '/api/v1/ops/push', token });
  const post = (token: string, body: unknown) =>
    call(push, { method: 'POST', url: '/api/v1/ops/push', token, body });
  const del = (token: string, body: unknown) =>
    call(push, { method: 'DELETE', url: '/api/v1/ops/push', token, body });

  describe('happy path and persistence', () => {
    test('THE ONE THAT MATTERS — subscribe, then see it on a fresh read', async () => {
      const r = await post(mumToken, { endpoint: EP('phone'), keys: KEYS, deviceLabel: 'মোবাইল' });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.ok, true);

      // A separate request, so this is persistence rather than an echo.
      const after = await get(mumToken);
      assert.equal(after.status, 200);
      const devices = after.body.devices as Array<Record<string, unknown>>;
      assert.equal(devices.length, 1);
      assert.equal(devices[0].label, 'মোবাইল');
      assert.equal(after.body.enabled, true);
      assert.ok(String(after.body.publicKey).length > 80);
    });

    test('re-subscribing the same browser does not create a second device', async () => {
      await post(mumToken, { endpoint: EP('phone'), keys: KEYS });
      await post(mumToken, { endpoint: EP('phone'), keys: KEYS });
      const after = await get(mumToken);
      assert.equal((after.body.devices as unknown[]).length, 1);
    });

    test('two browsers are two devices', async () => {
      await post(mumToken, { endpoint: EP('phone'), keys: KEYS, deviceLabel: 'মোবাইল' });
      await post(mumToken, { endpoint: EP('desk'), keys: KEYS, deviceLabel: 'কম্পিউটার' });
      const after = await get(mumToken);
      assert.equal((after.body.devices as unknown[]).length, 2);
    });

    test('unsubscribing is idempotent, not an error', async () => {
      await post(mumToken, { endpoint: EP('phone'), keys: KEYS });
      const first = await del(mumToken, { endpoint: EP('phone') });
      assert.equal(first.status, 200);
      assert.equal(first.body.removed, 1);
      // A browser that already dropped its subscription is in exactly the
      // state the caller asked for. A 404 would show a failure for a success.
      const second = await del(mumToken, { endpoint: EP('phone') });
      assert.equal(second.status, 200);
      assert.equal(second.body.removed, 0);
    });
  });

  describe('the endpoint is a capability, so it never comes back', () => {
    test('THE ONE THAT MATTERS — no response ever contains an endpoint', async () => {
      await post(mumToken, { endpoint: EP('very-secret-device-token'), keys: KEYS });
      const r = await get(mumToken);
      // Anyone holding it can push to that phone. A fingerprint identifies the
      // row for deletion without handing the capability back out.
      assert.doesNotMatch(r.raw, /very-secret-device-token/);
      assert.doesNotMatch(r.raw, /fcm\.googleapis/);
      const devices = r.body.devices as Array<Record<string, unknown>>;
      assert.match(String(devices[0].fingerprint), /^[0-9a-f]{12}$/);
    });

    test('the browser keys are not returned either', async () => {
      await post(mumToken, { endpoint: EP('phone'), keys: KEYS });
      const r = await get(mumToken);
      assert.doesNotMatch(r.raw, /BCVxsr7N/);
      assert.doesNotMatch(r.raw, /BTBZMqHH/);
    });
  });

  describe('authorization', () => {
    test('no token, no subscription', async () => {
      const r = await call(push, { method: 'GET', url: '/api/v1/ops/push' });
      assert.equal(r.status, 401);
    });

    test('THE ONE THAT MATTERS — the principal cannot see a parent\'s devices', async () => {
      await post(mumToken, { endpoint: EP('parent-phone'), keys: KEYS });
      const r = await get(headToken);
      assert.equal(r.status, 200);
      // Deliberate, and the one thing this product withholds from management.
      assert.equal((r.body.devices as unknown[]).length, 0);
    });

    test('another school sees nothing', async () => {
      await post(mumToken, { endpoint: EP('parent-phone'), keys: KEYS });
      const r = await get(bmumToken);
      assert.equal((r.body.devices as unknown[]).length, 0);
    });

    test('a user id in the body is ignored — the session decides', async () => {
      // There is no workflow in which one person registers a device for
      // another, so a userId parameter would only ever be useful to an
      // attacker. It is not read; the row lands on the caller.
      await post(mumToken, {
        endpoint: EP('phone'), keys: KEYS,
        userId: HEAD, user_id: HEAD, tenantId: B, tenant_id: B,
      });
      assert.equal(((await get(headToken)).body.devices as unknown[]).length, 0);
      assert.equal(((await get(mumToken)).body.devices as unknown[]).length, 1);
      assert.equal(((await get(bmumToken)).body.devices as unknown[]).length, 0);
    });

    test('one person cannot delete another\'s device by id', async () => {
      await post(mumToken, { endpoint: EP('parent-phone'), keys: KEYS });
      const id = ((await get(mumToken)).body.devices as Array<{ id: string }>)[0].id;

      for (const token of [headToken, bmumToken]) {
        const r = await del(token, { id });
        assert.equal(r.status, 200);
        assert.equal(r.body.removed, 0, 'nothing of somebody else\'s may be removed');
      }
      assert.equal(((await get(mumToken)).body.devices as unknown[]).length, 1);
    });
  });

  describe('the shared device, over HTTP', () => {
    test('THE ONE THAT MATTERS — a second school claiming a browser evicts the first', async () => {
      // A school office computer. Alpha's parent used it; beta's parent signs
      // in next. The push service issues ONE endpoint per browser, so without
      // eviction alpha would go on pushing to a device beta now holds.
      const shared = EP('shared-office-computer');
      await post(mumToken, { endpoint: shared, keys: KEYS });
      assert.equal(((await get(mumToken)).body.devices as unknown[]).length, 1);

      await post(bmumToken, { endpoint: shared, keys: KEYS });

      assert.equal(((await get(bmumToken)).body.devices as unknown[]).length, 1);
      assert.equal(((await get(mumToken)).body.devices as unknown[]).length, 0,
        'alpha must no longer hold the shared browser');
    });
  });

  describe('validation — nothing unusable is ever stored', () => {
    test('missing fields are refused', async () => {
      for (const body of [
        {},
        { endpoint: EP('x') },
        { endpoint: EP('x'), keys: { p256dh: KEYS.p256dh } },
        { keys: KEYS },
      ]) {
        const r = await post(mumToken, body);
        assert.equal(r.status, 400, JSON.stringify(body));
      }
    });

    test('keys that could never be encrypted for are refused at the door', async () => {
      // Left to the dispatcher to discover, such a row fails for every message
      // forever, and its owner believes notifications are on.
      const bad = [
        { p256dh: 'AAAA', auth: KEYS.auth },
        { p256dh: KEYS.p256dh, auth: 'AA' },
        { p256dh: 'not base64url!!', auth: KEYS.auth },
      ];
      for (const keys of bad) {
        const r = await post(mumToken, { endpoint: EP('x'), keys });
        assert.equal(r.status, 400, JSON.stringify(keys));
        assert.equal(r.body.error, 'bad_keys');
      }
      assert.equal(((await get(mumToken)).body.devices as unknown[]).length, 0);
    });

    test('a device label is truncated rather than rejected', async () => {
      await post(mumToken, { endpoint: EP('x'), keys: KEYS, deviceLabel: 'ক'.repeat(400) });
      const devices = (await get(mumToken)).body.devices as Array<{ label: string }>;
      assert.ok(devices[0].label.length <= 80);
    });

    test('only GET, POST and DELETE', async () => {
      const r = await call(push, { method: 'PUT', url: '/api/v1/ops/push', token: mumToken });
      assert.equal(r.status, 405);
      const pre = await call(push, { method: 'OPTIONS', url: '/api/v1/ops/push' });
      assert.equal(pre.status, 204);
    });
  });

  describe('the deployment switch', () => {
    test('with no VAPID keys, GET says so and POST refuses', async () => {
      const pub = process.env.VAPID_PUBLIC_KEY;
      const priv = process.env.VAPID_PRIVATE_KEY;
      delete process.env.VAPID_PUBLIC_KEY;
      delete process.env.VAPID_PRIVATE_KEY;
      try {
        const r = await get(mumToken);
        assert.equal(r.status, 200);
        assert.equal(r.body.enabled, false);
        assert.equal(r.body.publicKey, null);

        // 503, not 400: nothing is wrong with the request.
        const p = await post(mumToken, { endpoint: EP('x'), keys: KEYS });
        assert.equal(p.status, 503);
        assert.equal(p.body.error, 'push_not_configured');
      } finally {
        process.env.VAPID_PUBLIC_KEY = pub;
        process.env.VAPID_PRIVATE_KEY = priv;
      }
    });
  });
});

/**
 * The SSRF boundary, which needs no database: the server will POST to whatever
 * survives this function, so it is the whole defence.
 */
describe('R-9 — an endpoint the server will fetch', () => {
  const ok = (u: string) => assert.doesNotThrow(() => assertSafePushEndpoint(u), u);
  const no = (u: string) => assert.throws(() => assertSafePushEndpoint(u),
    (e: unknown) => e instanceof HttpError && e.status === 400, u);

  test('real push services pass', () => {
    ok('https://fcm.googleapis.com/fcm/send/abc');
    ok('https://updates.push.services.mozilla.com/wpush/v2/gAAA');
    ok('https://web.push.apple.com/QAAA');
    ok('https://par02p.notify.windows.com/w/?token=x');
  });

  test('THE ONE THAT MATTERS — nothing inside a network', () => {
    for (const u of [
      'https://localhost/push',
      'https://127.0.0.1/push',
      'https://10.0.0.1/push',
      'https://192.168.1.1/push',
      'https://169.254.169.254/latest/meta-data/',   // cloud metadata
      'https://metadata.google.internal/x',
      'https://[::1]/push',
      'https://db.internal/push',
      'https://printer.local/push',
    ]) no(u);
  });

  test('http is refused — the payload and the VAPID token are in that request', () => {
    no('http://fcm.googleapis.com/fcm/send/abc');
    no('ftp://fcm.googleapis.com/x');
    no('file:///etc/passwd');
  });

  test('credentials in the URL are refused', () => {
    // They would be sent by our server on every push and stored in plaintext.
    no('https://user:pass@fcm.googleapis.com/fcm/send/abc');
    no('https://user@fcm.googleapis.com/fcm/send/abc');
  });

  test('a trailing-dot hostname does not sneak past the name checks', () => {
    no('https://localhost./push');
  });

  test('nonsense is refused rather than half-parsed', () => {
    no('not a url');
    no('');
    no(`https://fcm.googleapis.com/${'x'.repeat(3000)}`);
  });
});
