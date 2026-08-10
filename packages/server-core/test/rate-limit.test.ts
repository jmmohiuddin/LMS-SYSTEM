/**
 * Rate limiting (F-102).
 *
 * Two layers, deliberately:
 *
 *   Unit — the policy table, key construction, client-IP extraction and the
 *   429 response shape. These run with no database and are the ones that
 *   catch a bad edit to the numbers.
 *
 *   Integration — the token bucket itself, against a REAL PostgreSQL. The
 *   behaviour that matters (refill arithmetic, two-pass atomicity, the app
 *   role being unable to read the table) lives entirely in the database, so
 *   a mock would only assert that the mock works. Skipped without
 *   DATABASE_URL, same convention as services/sync-svc/test/push.test.ts.
 *
 *   DATABASE_URL=postgres://… node --test packages/server-core/test/rate-limit.test.ts
 *
 * The integration suite keys every bucket under a unique per-run prefix and
 * deletes nothing it did not create, so it is safe against any environment.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { IncomingMessage, ServerResponse } from 'node:http';

import {
  RATE_LIMITS,
  buildBuckets,
  clientIp,
  enforceIdentityRateLimit,
  type RateLimitClass,
} from '../src/rate-limit.ts';
import { createDb, type Db } from '../src/db.ts';

/* ═══════════════════════════════════════════════════════ unit: policy table */

describe('RATE_LIMITS policy table', () => {
  const classes = Object.keys(RATE_LIMITS) as RateLimitClass[];

  test('every class has an IP bucket with a positive capacity and refill', () => {
    for (const cls of classes) {
      const p = RATE_LIMITS[cls];
      assert.ok(p.ip.capacity > 0, `${cls}: ip.capacity must be positive`);
      assert.ok(p.ip.refill > 0, `${cls}: ip.refill must be positive`);
    }
  });

  test('the identity bucket is always stricter than the IP bucket', () => {
    // This is the whole design: a school of 800 behind one NAT gateway must
    // not be throttled as if it were one person, so abuse control has to sit
    // on the identity axis. An identity limit looser than the IP limit would
    // silently make the identity dimension dead weight.
    for (const cls of classes) {
      const p = RATE_LIMITS[cls];
      if (!p.identity) continue;
      assert.ok(
        p.identity.capacity < p.ip.capacity,
        `${cls}: identity capacity (${p.identity.capacity}) must be below ip (${p.ip.capacity})`,
      );
      assert.ok(
        p.identity.refill < p.ip.refill,
        `${cls}: identity refill must be below ip refill`,
      );
    }
  });

  test('the classes that gate unauthenticated auth traffic carry an identity bucket', () => {
    // Without these, F-102 would not actually stop the attack it names:
    // hammering one phone number with OTP requests.
    assert.ok(RATE_LIMITS.otp_request.identity, 'otp_request needs an identity bucket');
    assert.ok(RATE_LIMITS.otp_verify.identity, 'otp_verify needs an identity bucket');
    assert.ok(RATE_LIMITS.ai.identity, 'ai needs an identity bucket (spend control)');
  });

  test('otp_request allows 3 per phone per hour', () => {
    const id = RATE_LIMITS.otp_request.identity!;
    assert.equal(id.capacity, 3);
    // refill is tokens/second; 3/hour.
    assert.ok(Math.abs(id.refill * 3600 - 3) < 1e-9, 'refill must be 3 tokens per hour');
  });

  test('a whole school can work through one gateway on the read/mutation classes', () => {
    // 800 students, a burst at first period. Sustained rate matters more than
    // burst here, so assert both: the burst clears a full school opening the
    // app, and the sustained rate clears steady use.
    assert.ok(RATE_LIMITS.read.ip.capacity >= 800, 'read burst must clear a full school');
    assert.ok(RATE_LIMITS.mutation.ip.capacity >= 800, 'mutation burst must clear a full school');
    assert.ok(RATE_LIMITS.read.ip.refill >= 10, 'read must sustain >= 10 req/s per school');
  });
});

/* ═══════════════════════════════════════════════════════ unit: bucket keys */

describe('buildBuckets', () => {
  test('keys are namespaced by class so limits never bleed across endpoints', () => {
    const a = buildBuckets('otp_request', '1.2.3.4');
    const b = buildBuckets('read', '1.2.3.4');
    assert.notEqual(a[0].key, b[0].key);
    assert.ok(a[0].key.startsWith('otp_request:ip:'));
    assert.ok(b[0].key.startsWith('read:ip:'));
  });

  test('an IP bucket and an identity bucket never collide', () => {
    const buckets = buildBuckets('otp_request', '1.2.3.4', 'tenant:+8801712345678');
    assert.equal(buckets.length, 2);
    assert.ok(buckets[0].key.includes(':ip:'));
    assert.ok(buckets[1].key.includes(':id:'));
    assert.notEqual(buckets[0].key, buckets[1].key);
  });

  test('an identity is ignored for a class with no identity policy', () => {
    // `auth` (refresh/logout) has no identity bucket. Passing one must not
    // silently invent a bucket with the IP policy's numbers.
    const buckets = buildBuckets('auth', '1.2.3.4', 'someone');
    assert.equal(buckets.length, 1);
    assert.ok(buckets[0].key.includes(':ip:'));
  });

  test('a null IP yields identity-only — the split-charge case', () => {
    // enforceIdentityRateLimit passes ip=null because the dispatcher already
    // charged the IP bucket. Charging it twice would halve every allowance.
    const buckets = buildBuckets('otp_request', null, 'tenant:+8801712345678');
    assert.equal(buckets.length, 1);
    assert.ok(buckets[0].key.includes(':id:'));
  });

  test('bucket capacity and refill come from the class policy', () => {
    const [ip, id] = buildBuckets('otp_request', '9.9.9.9', 'x');
    assert.equal(ip.capacity, RATE_LIMITS.otp_request.ip.capacity);
    assert.equal(id.capacity, RATE_LIMITS.otp_request.identity!.capacity);
  });
});

/* ══════════════════════════════════════════════════════════ unit: clientIp */

describe('clientIp', () => {
  const req = (headers: Record<string, string | string[]>, remote?: string): IncomingMessage =>
    ({ headers, socket: { remoteAddress: remote } } as unknown as IncomingMessage);

  test('takes the left-most x-forwarded-for entry', () => {
    // On Vercel the platform appends, so the left-most entry is the client
    // and everything to its right is proxy chain.
    assert.equal(clientIp(req({ 'x-forwarded-for': '203.0.113.9, 10.0.0.1, 10.0.0.2' })), '203.0.113.9');
  });

  test('handles x-forwarded-for arriving as an array', () => {
    assert.equal(clientIp(req({ 'x-forwarded-for': ['203.0.113.9', '10.0.0.1'] })), '203.0.113.9');
  });

  test('falls back to x-real-ip, then the socket, then "unknown"', () => {
    assert.equal(clientIp(req({ 'x-real-ip': '198.51.100.7' })), '198.51.100.7');
    assert.equal(clientIp(req({}, '192.0.2.5')), '192.0.2.5');
    assert.equal(clientIp(req({})), 'unknown');
  });

  test('a hostile header cannot grow the key unboundedly', () => {
    // x-forwarded-for is attacker-controlled behind a non-Vercel proxy. It
    // must not be usable to write 100KB primary keys into the bucket table.
    const long = 'a'.repeat(5000);
    assert.equal(clientIp(req({ 'x-forwarded-for': long })).length, 64);
  });
});

/* ═════════════════════════════════════════ integration: the token bucket */

const DATABASE_URL = process.env.DATABASE_URL;
const skip = !DATABASE_URL ? 'DATABASE_URL not set' : false;

let db: Db;
// Unique per run: a second run must not inherit a drained bucket.
const RUN = `test:${crypto.randomUUID()}`;

interface Verdict { allowed: boolean; retry_after_sec: number; blocked_key: string | null }

async function consume(buckets: { key: string; capacity: number; refill: number }[]): Promise<Verdict> {
  const { rows } = await db.pool.query<Verdict>(
    'SELECT * FROM app.rate_limit_consume($1::jsonb)',
    [JSON.stringify(buckets)],
  );
  return rows[0];
}

const bucket = (name: string, capacity: number, refill: number) =>
  ({ key: `${RUN}:${name}`, capacity, refill });

// One pool for every integration suite below. Opened and closed at file
// scope because node:test runs describes in order against a shared module —
// a per-suite after() would end the pool the next suite still needs.
before(() => { if (!skip) db = createDb(DATABASE_URL!); });
after(async () => { await db?.end(); });

describe('app.rate_limit_consume', { skip }, () => {

  test('a fresh bucket starts full and spends down to empty', async () => {
    const b = bucket('spend', 3, 0.0001);
    for (let i = 0; i < 3; i++) {
      const v = await consume([b]);
      assert.equal(v.allowed, true, `request ${i + 1} of 3 should be allowed`);
    }
    const refused = await consume([b]);
    assert.equal(refused.allowed, false, 'the 4th request must be refused');
    assert.equal(refused.blocked_key, b.key);
  });

  test('a refusal reports a retry delay of at least one second', async () => {
    const b = bucket('retry', 1, 0.01); // 1 token per 100s — slow on purpose
    assert.equal((await consume([b])).allowed, true);
    const v = await consume([b]);
    assert.equal(v.allowed, false);
    // (1 - 0) / 0.01 = 100s, ceilinged.
    assert.ok(v.retry_after_sec >= 100, `expected >= 100s, got ${v.retry_after_sec}`);
  });

  test('retry_after_sec is never zero on a refusal', async () => {
    // A very fast refill could round to 0 and produce Retry-After: 0, which
    // invites an immediate retry storm. GREATEST(1, …) is what prevents it.
    const b = bucket('fastrefill', 1, 1000);
    await consume([b]);
    const v = await consume([b]);
    if (!v.allowed) assert.ok(v.retry_after_sec >= 1, 'Retry-After must be >= 1s');
  });

  test('tokens refill over elapsed time', async () => {
    const b = bucket('refill', 1, 5); // 5 tokens/sec → refilled in 200ms
    assert.equal((await consume([b])).allowed, true);
    assert.equal((await consume([b])).allowed, false, 'immediately empty');
    await new Promise((r) => setTimeout(r, 400));
    assert.equal((await consume([b])).allowed, true, 'should have refilled after 400ms');
  });

  test('refill is capped at capacity — an idle bucket does not bank credit', async () => {
    // Without LEAST(capacity, …) an idle bucket accumulates unbounded tokens
    // and the burst limit means nothing. Capacity 2, refill 2/sec: drain it,
    // idle 3 seconds (which would bank 6 tokens uncapped), then count how
    // many consecutive requests pass. The refill rate is deliberately slow
    // relative to a round trip, so what is measured is the stored balance
    // and not the refill.
    const b = bucket('cap', 2, 2);
    await consume([b]);
    await consume([b]);                                // drained
    await new Promise((r) => setTimeout(r, 3000));     // 6 tokens if uncapped

    let burst = 0;
    while (burst < 10 && (await consume([b])).allowed) burst++;
    assert.ok(burst >= 2, `capacity 2 must be fully restored, got ${burst}`);
    assert.ok(burst <= 3, `3s idle at 2/sec must not bank 6 tokens — got ${burst}`);
  });

  test('a request blocked on one bucket does not spend the other', async () => {
    // The two-pass design. A student behind a NAT gateway that someone else
    // has saturated must not also lose their own per-identity quota.
    const ip = bucket('twopass-ip', 1, 0.0001);
    const id = bucket('twopass-id', 5, 0.0001);

    assert.equal((await consume([ip, id])).allowed, true);   // ip: 0, id: 4
    const blocked = await consume([ip, id]);
    assert.equal(blocked.allowed, false);
    assert.equal(blocked.blocked_key, ip.key, 'the IP bucket is the one that refused');

    // The identity bucket should still have 4 tokens, not 3. Spend them
    // alone and confirm exactly four succeed.
    let ok = 0;
    for (let i = 0; i < 6; i++) if ((await consume([id])).allowed) ok++;
    assert.equal(ok, 4, `identity bucket should have had 4 tokens left, spent ${ok}`);
  });

  test('the slowest-refilling blocked bucket sets the retry delay', async () => {
    const fast = bucket('worst-fast', 1, 1);     // 1s to recover
    const slow = bucket('worst-slow', 1, 0.01);  // 100s to recover
    await consume([fast, slow]);
    const v = await consume([fast, slow]);
    assert.equal(v.allowed, false);
    assert.equal(v.blocked_key, slow.key, 'the worst wait must win');
    assert.ok(v.retry_after_sec >= 100);
  });

  test('an empty bucket list is allowed — the limiter never blocks by omission', async () => {
    const v = await consume([]);
    assert.equal(v.allowed, true);
  });
});

describe('rate_limit_buckets is unreadable by the application role', { skip }, () => {
  test('the app can spend a token but cannot enumerate buckets', async () => {
    // The invariant migration 020 exists to hold. Note that migration 010's
    // ALTER DEFAULT PRIVILEGES grants shikhon_app SELECT on every table
    // created after it — including this one — so the table grant alone is NOT
    // the defence in production. RLS enabled with no policy is.
    const b = bucket('rls', 5, 0.0001);
    await consume([b]);   // the row now definitely exists

    const priv = await db.pool.query<{ is_privileged: boolean }>(
      `SELECT (r.rolsuper OR r.rolbypassrls OR c.relowner = r.oid) AS is_privileged
         FROM pg_class c, pg_roles r
        WHERE c.relname = 'rate_limit_buckets' AND r.rolname = current_user`,
    );
    if (priv.rows[0]?.is_privileged) {
      // Connected as the owner or a superuser — a developer shell, not the
      // runtime role. RLS is enabled but deliberately not FORCED (the
      // SECURITY DEFINER function needs the owner to bypass it), so the owner
      // legitimately sees rows and asserting otherwise would test nothing.
      return;
    }

    let rows: number | null = null;
    try {
      rows = (await db.pool.query('SELECT bucket_key FROM rate_limit_buckets')).rowCount;
    } catch (err) {
      // Also acceptable, and stronger: the role has no SELECT grant at all.
      assert.equal((err as { code?: string }).code, '42501',
        `expected permission denied, got ${(err as Error).message}`);
      return;
    }
    assert.equal(rows, 0, 'shikhon_app must not be able to read any bucket');
  });
});

/* ══════════════════════════════════════════ integration: the 429 response */

interface FakeRes { status: number; headers: Record<string, string>; body: unknown }

function fakeResponse(): { res: ServerResponse; captured: FakeRes } {
  const captured: FakeRes = { status: 0, headers: {}, body: undefined };
  const res = {
    writeHead(status: number, headers: Record<string, string>) {
      captured.status = status;
      captured.headers = headers;
      return this;
    },
    end(chunk?: string) {
      if (chunk) captured.body = JSON.parse(chunk);
    },
  } as unknown as ServerResponse;
  return { res, captured };
}

describe('the 429 a refused caller actually receives', { skip }, () => {
  test('carries Retry-After, retryAfterSec, and CORS — but never the bucket key', async () => {
    const identity = `${RUN}:429-shape`;
    const cors = { 'Access-Control-Allow-Origin': '*' };

    // otp_request allows 3 per identity. Drain it.
    for (let i = 0; i < 3; i++) {
      const { res } = fakeResponse();
      assert.equal(await enforceIdentityRateLimit(res, cors, 'otp_request', identity), true);
    }

    const { res, captured } = fakeResponse();
    const proceed = await enforceIdentityRateLimit(res, cors, 'otp_request', identity);

    assert.equal(proceed, false, 'the 4th OTP request for one phone must be refused');
    assert.equal(captured.status, 429);
    assert.ok(captured.headers['Retry-After'], 'Retry-After header is required');
    assert.ok(Number(captured.headers['Retry-After']) >= 1);
    assert.equal(captured.headers['Access-Control-Allow-Origin'], '*', 'CORS must survive the refusal');

    const body = captured.body as Record<string, unknown>;
    assert.equal(body.error, 'rate_limited');
    assert.ok(typeof body.retryAfterSec === 'number' && body.retryAfterSec >= 1);

    // Which bucket refused would tell an attacker whether a phone number is
    // registered. It is logged server-side and must never be in the payload.
    const serialized = JSON.stringify(captured.body);
    assert.ok(!serialized.includes(identity), 'the identity must not leak into the response');
    assert.ok(!serialized.includes('blocked_key'), 'the blocked bucket must not be disclosed');
  });
});
