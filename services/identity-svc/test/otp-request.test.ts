/**
 * POST /api/v1/auth/otp/request — R-8.
 *
 * Before R-8 this endpoint wrote the code to `console.log` under a comment
 * saying the aggregator was a follow-up. That was survivable while the switch
 * was a hardcoded `false`. It stopped being survivable the moment the switch
 * became an environment variable: an operator could set OTP_SENDING_ENABLED,
 * see the readiness screen go green, and hand a school a login that silently
 * delivers nothing.
 *
 * So what this suite holds still is mostly about the MESSAGE:
 *
 *   • it is queued at all, in the same transaction as the challenge;
 *   • it is signed with the SCHOOL's name and never the platform's — a
 *     parent must not read their software vendor's brand on a message from
 *     their child's school (D11);
 *   • a resend is not swallowed by the daily dedupe index, which would lock
 *     out for a whole day the one person who did not receive the first code;
 *   • the code never appears anywhere except the message body and the
 *     service-key-gated debug echo.
 *
 *   DATABASE_URL=postgresql://… node --test services/identity-svc/test/otp-request.test.ts
 */
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { createDb, type Db, type TenantContext } from '../../../packages/server-core/src/db.ts';
import { installTestKeys, call } from '../../../packages/server-core/test/harness.ts';

const DATABASE_URL = process.env.DATABASE_URL;
const skip = !DATABASE_URL ? 'DATABASE_URL not set' : false;

const T      = '7ae00000-0000-4000-8000-00000000000a';
const OTHER  = '7ae00000-0000-4000-8000-00000000000b';
const HEAD   = '7ae00000-0000-4000-8000-0000000000ff';
/**
 * A fresh number per test.
 *
 * F-102 caps OTP requests at 3/hour PER PHONE, which is the policy doing
 * exactly what it should — hammering one number is the attack it exists to
 * stop. A suite that reused one number would be testing the limiter instead
 * of the endpoint, and would fail in an order-dependent way. So each test
 * gets its own identity, which is also how real requests arrive.
 *
 * Fresh per RUN as well as per test. The limiter's buckets live in the
 * database and outlive the process, so a fixed number would pass once and
 * then report `rate_limited` for the next twenty minutes — a suite that only
 * works the first time is worse than no suite.
 */
const PHONE_RUN = String(1000 + Math.floor(Math.random() * 9000));
let phoneSeq = 0;
const nextPhone = (): string =>
  `+88017${PHONE_RUN}${String(1000 + (phoneSeq += 1)).slice(-4)}`;

let db: Db;
let otpRequest: typeof import('../api/otp-request.ts').default;
const asHead: TenantContext = { tenantId: T, userId: HEAD, role: 'principal' };

/**
 * Cleanup runs once PER TENANT, in that tenant's own context.
 *
 * A single pass with `WHERE id = ANY([T, OTHER])` looks like it removes both
 * and removes only the one whose context it runs in: RLS makes the other row
 * invisible, the DELETE matches nothing, and the next run fails on a
 * duplicate key from a fixture it believes it deleted.
 */
async function dropFixtures(): Promise<void> {
  for (const tenantId of [T, OTHER]) {
    await db.withTenant({ tenantId, userId: HEAD, role: 'principal' }, async (c) => {
      await c.query('DELETE FROM sms_outbox WHERE tenant_id = $1', [tenantId]);
      await c.query('DELETE FROM otp_challenges WHERE tenant_id = $1', [tenantId]);
      await c.query('DELETE FROM tenants WHERE id = $1', [tenantId]);
    });
  }
}

/** Every row this endpoint queued for one tenant, newest first. */
async function outbox(tenantId: string): Promise<Array<Record<string, unknown>>> {
  return db.withTenant({ tenantId, userId: HEAD, role: 'principal' }, async (c) => {
    const { rows } = await c.query(
      `SELECT template_code, msisdn, body, encoding, segments, priority,
              dedupe_key, status, locale, context
         FROM sms_outbox WHERE tenant_id = $1 ORDER BY queued_at DESC`,
      [tenantId],
    );
    return rows as Array<Record<string, unknown>>;
  });
}

describe('R-8 — an OTP that actually goes somewhere', { skip }, () => {
  before(async () => {
    await installTestKeys();
    process.env.OTP_SENDING_ENABLED = 'true';
    process.env.SERVICE_API_KEY = 'otp-suite-service-key';
    db = createDb(DATABASE_URL as string);
    await dropFixtures();
    await db.withTenant(asHead, async (c) => {
      await c.query(
        `INSERT INTO tenants (id, slug, name_bn, name_en, stream, level) VALUES
           ($1,'r8-otp','মিরপুর বালিকা বিদ্যালয়','Mirpur Girls','bangla_medium','secondary')`,
        [T]);
    });
    await db.withTenant({ tenantId: OTHER, userId: HEAD, role: 'principal' }, async (c) => {
      await c.query(
        `INSERT INTO tenants (id, slug, name_bn, name_en, stream, level) VALUES
           ($1,'r8-otp-b','অন্য বিদ্যালয়','Other','bangla_medium','secondary')`,
        [OTHER]);
    });
    otpRequest = (await import('../api/otp-request.ts')).default;
  });

  after(async () => {
    if (db) { await dropFixtures(); await db.end(); }
    delete process.env.OTP_SENDING_ENABLED;
    delete process.env.SERVICE_API_KEY;
  });

  beforeEach(async () => {
    // Each test starts with an empty queue and no live challenge, so the
    // 45-second resend floor never decides a test's outcome.
    for (const tenantId of [T, OTHER]) {
      await db.withTenant({ tenantId, userId: HEAD, role: 'principal' }, async (c) => {
        await c.query('DELETE FROM sms_outbox WHERE tenant_id = $1', [tenantId]);
        await c.query('DELETE FROM otp_challenges WHERE tenant_id = $1', [tenantId]);
      });
    }
  });

  const request = (body: Record<string, unknown>, headers: Record<string, string> = {}) =>
    call(otpRequest, {
      method: 'POST', url: '/api/v1/auth/otp/request', body, headers,
    });

  test('THE ONE THAT MATTERS — the code is queued, not just logged', async () => {
    const phone = nextPhone();
    const r = await request({ tenantId: T, phone });
    assert.equal(r.status, 200, JSON.stringify(r.body));

    const rows = await outbox(T);
    assert.equal(rows.length, 1, 'exactly one message per request');
    assert.equal(rows[0].template_code, 'auth.otp.v1');
    assert.equal(rows[0].msisdn, phone);
    assert.equal(rows[0].status, 'queued');
    // Time-critical: a login code behind a queue of attendance notices is a
    // login code that arrives after it has expired.
    assert.equal(rows[0].priority, 1);
  });

  test('the message is signed with the SCHOOL, never the platform (D11)', async () => {
    await request({ tenantId: T, phone: nextPhone() });
    const body = String((await outbox(T))[0].body);

    assert.match(body, /মিরপুর বালিকা বিদ্যালয়/);
    // The rule this exists to enforce, stated as the test that would have
    // caught it: a guardian must never read our brand on their school's SMS.
    assert.doesNotMatch(body, /ShikhonBD/i);
    assert.doesNotMatch(body, /শিখন/);
  });

  test('a different school signs with its own name', async () => {
    // Not a duplicate of the test above: it would pass with a hardcoded
    // string. This one fails unless the name is actually read per tenant.
    await request({ tenantId: OTHER, phone: nextPhone() });
    const body = String((await outbox(OTHER))[0].body);
    assert.match(body, /অন্য বিদ্যালয়/);
    assert.doesNotMatch(body, /মিরপুর/);
  });

  test('the body is Bangla prose with Bangla numerals, and a Latin code', async () => {
    await request({ tenantId: T, phone: nextPhone() });
    const body = String((await outbox(T))[0].body);

    // The duration is prose and takes Bangla digits, like every other number
    // shown to a parent. R-6 shipped a Latin "2" into a Bangla sentence and
    // this is the same defect one message earlier in the funnel.
    assert.match(body, /৫ মিনিট/);
    assert.doesNotMatch(body, /5 মিনিট/);

    // The code is NOT prose — it is a literal to be typed back — so it stays
    // in Latin digits. Six of them, exactly.
    const code = body.match(/কোড (\d{6})।/);
    assert.ok(code, `no six-digit code found in: ${body}`);

    // Bangla forces UCS-2, and the segment count must reflect that or the
    // cost estimate is wrong by more than half.
    const row = (await outbox(T))[0];
    assert.equal(row.encoding, 'unicode');
    assert.equal(row.locale, 'bn');
    assert.equal(row.segments, Math.max(1, Math.ceil(body.length / 70)));
  });

  test('THE ONE THAT MATTERS — a resend is not swallowed by the daily dedupe', async () => {
    // `uq_sms_dedupe` is UNIQUE (tenant_id, created_on, dedupe_key). A key of
    // phone+day would mean the person who did not receive the first code
    // could not be sent another one until tomorrow — the exact person who
    // needs one. Keyed on the challenge instead.
    // Two sends to the SAME number, which is the situation under test, and
    // within F-102's 3/hour allowance for it.
    const phone = nextPhone();
    await request({ tenantId: T, phone });
    // Clear the challenge but NOT the queue, so only the dedupe key is under
    // test rather than the 45-second resend floor.
    await db.withTenant(asHead, async (c) => {
      await c.query('DELETE FROM otp_challenges WHERE tenant_id = $1', [T]);
    });
    const second = await request({ tenantId: T, phone });
    assert.equal(second.status, 200, JSON.stringify(second.body));

    const rows = await outbox(T);
    assert.equal(rows.length, 2, 'the second code must also be queued');
    assert.notEqual(rows[0].dedupe_key, rows[1].dedupe_key);
    assert.notEqual(rows[0].body, rows[1].body, 'two sends must not carry the same code');
  });

  test('the code appears in the body and in nothing else', async () => {
    const r = await request({ tenantId: T, phone: nextPhone() },
      { 'x-debug-otp': 'otp-suite-service-key' });
    const code = String((r.body as { debugCode?: string }).debugCode ?? '');
    assert.match(code, /^\d{6}$/);

    const row = (await outbox(T))[0];
    assert.match(String(row.body), new RegExp(code));
    // `context` is read by support and by the dispatcher's logs. A code there
    // would be a password sitting in an operational read.
    assert.doesNotMatch(JSON.stringify(row.context), new RegExp(code));

    const challenge = await db.withTenant(asHead, async (c) => {
      const { rows } = await c.query(
        `SELECT * FROM otp_challenges WHERE tenant_id = $1`, [T]);
      return rows[0] as Record<string, unknown>;
    });
    // Stored as a hash, exactly as before R-8. Queueing the message must not
    // have introduced a plaintext copy anywhere.
    assert.doesNotMatch(JSON.stringify(challenge), new RegExp(code));
  });

  test('without the service key there is no debug echo', async () => {
    const r = await request({ tenantId: T, phone: nextPhone() });
    assert.equal((r.body as { debugCode?: string }).debugCode, undefined);
    const wrong = await request({ tenantId: T, phone: nextPhone() },
      { 'x-debug-otp': 'not-the-key' });
    assert.equal((wrong.body as { debugCode?: string }).debugCode, undefined);
  });

  test('the switch still fails closed, and queues nothing when off', async () => {
    delete process.env.OTP_SENDING_ENABLED;
    try {
      const r = await request({ tenantId: T, phone: nextPhone() });
      assert.equal(r.status, 503);
      assert.equal(r.body.error, 'otp_disabled');
      // Not merely refused — nothing was written. A challenge with no message
      // is a code nobody can receive, which is worse than a clean refusal.
      assert.equal((await outbox(T)).length, 0);
      const challenges = await db.withTenant(asHead, async (c) => {
        const { rows } = await c.query(
          'SELECT count(*)::int AS n FROM otp_challenges WHERE tenant_id = $1', [T]);
        return (rows[0] as { n: number }).n;
      });
      assert.equal(challenges, 0);
    } finally {
      process.env.OTP_SENDING_ENABLED = 'true';
    }
  });

  test('validation refuses before anything is written', async () => {
    const phone = nextPhone();
    for (const body of [
      {},                                              // no tenant
      { tenantId: T },                                 // no phone
      { tenantId: T, phone: '01799610001' },           // not E.164
      { tenantId: T, phone: '+8801299610001' },        // not a BD mobile prefix
      { tenantId: T, phone, purpose: 'admin' },        // not a known purpose
    ]) {
      const r = await request(body);
      assert.equal(r.status, 400, `${JSON.stringify(body)} → ${r.status}`);
    }
    assert.equal((await outbox(T)).length, 0);
  });

  test('the queued message belongs to the tenant that asked, and to no other', async () => {
    await request({ tenantId: T, phone: nextPhone() });
    // §24: the tenant is taken from the request here because this endpoint is
    // pre-authentication and there IS no session to read it from — which is
    // exactly why the row must land in that tenant and be invisible from the
    // other one, under ordinary RLS rather than on trust.
    assert.equal((await outbox(T)).length, 1);
    assert.equal((await outbox(OTHER)).length, 0);
  });
});
