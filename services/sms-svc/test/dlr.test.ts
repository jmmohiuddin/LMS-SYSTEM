/**
 * R-8 — POST /api/v1/sms/dlr, the aggregator's delivery report.
 *
 * This is the only endpoint in the product an OUTSIDE party calls with a
 * secret of its own, so the authentication tests below matter more than the
 * happy path. A vendor holding this secret must be able to do exactly one
 * thing — say what happened to a message it was given — and nothing else:
 * not name a tenant, not read a message body, not reach any other service.
 *
 * The database side (`app.record_sms_delivery` touching only the four
 * delivery columns, refusing rows that were never sent) is asserted in
 * `db/tests/go_live.sql` against real PostgreSQL. What is asserted here is
 * the HTTP contract, which needs no database.
 */
import { test, describe, beforeEach, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';

import { call } from '../../../packages/server-core/test/harness.ts';
import { sharedDb } from '../../../packages/server-core/src/db.ts';
import dlr from '../api/dlr.ts';

const SECRET = 'dlr-shared-secret-value';

/**
 * Every test below stops before the database. That is deliberate: reaching
 * `sharedDb()` would need a live PostgreSQL, and each of these outcomes is
 * decided by the handler alone. The one test that DOES reach the query is
 * marked and skipped without a DATABASE_URL.
 */
let savedSecret: string | undefined;
beforeEach(() => { savedSecret = process.env.SMS_DLR_SECRET; });
afterEach(() => {
  if (savedSecret === undefined) delete process.env.SMS_DLR_SECRET;
  else process.env.SMS_DLR_SECRET = savedSecret;
});

const post = (body: unknown, headers: Record<string, string> = {}) =>
  call(dlr, { method: 'POST', url: '/api/v1/sms/dlr', body, headers });

// Every test here stops before the handler's own query — but F-102's rate
// limiter runs FIRST, and with a DATABASE_URL present it really connects.
// That leaves the shared singleton pool open, the process never exits, and
// the runner reports the whole file as failed with no assertion to point at.
after(async () => {
  if (process.env.DATABASE_URL) {
    await (await sharedDb()).end();
  }
});

describe('R-8 — DLR authentication', () => {
  test('THE ONE THAT MATTERS — no secret configured answers 503, not 401', async () => {
    delete process.env.SMS_DLR_SECRET;
    const r = await post({ csms_id: 'x', status: 'delivered' });
    // 401 would send an operator to the vendor asking about a password when
    // the actual problem is a variable they never set. The two situations
    // need different actions, so they get different codes.
    assert.equal(r.status, 503);
    assert.equal(r.body.error, 'dlr_not_configured');
    assert.match(String(r.body.message), /SMS_DLR_SECRET/);
  });

  test('configured but unauthenticated is 401, and says nothing more', async () => {
    process.env.SMS_DLR_SECRET = SECRET;
    const r = await post({ csms_id: 'x', status: 'delivered' });
    assert.equal(r.status, 401);
    assert.equal(r.body.error, 'unauthorized');
    // No hint about length, prefix or format. An error that helps you guess
    // the secret is a slower brute force, not a failed one.
    assert.equal(Object.keys(r.body).length, 1);
  });

  test('a wrong secret is 401 — including one that is a prefix of the real one', async () => {
    process.env.SMS_DLR_SECRET = SECRET;
    for (const wrong of [SECRET.slice(0, -1), `${SECRET}x`, SECRET.toUpperCase(), 'x']) {
      const r = await post({ csms_id: 'x', status: 'delivered' },
        { authorization: `Bearer ${wrong}` });
      assert.equal(r.status, 401, `"${wrong}" must not authenticate`);
    }
  });

  test('the SERVICE key does NOT open this door', async () => {
    // The point of a separate secret: a vendor holding the DLR secret must
    // not reach anything else, and our own service key must not be what we
    // hand a vendor. Neither substitutes for the other.
    process.env.SMS_DLR_SECRET = SECRET;
    process.env.SERVICE_API_KEY = 'service-key-value';
    try {
      const r = await post({ csms_id: 'x', status: 'delivered' },
        { authorization: 'Bearer service-key-value' });
      assert.equal(r.status, 401);
    } finally {
      delete process.env.SERVICE_API_KEY;
    }
  });

  test('either header carries it — vendors differ on which they send', async () => {
    process.env.SMS_DLR_SECRET = SECRET;
    // Both must get PAST authentication. They stop at the body check below,
    // which proves the secret was accepted without needing a database.
    for (const headers of [
      { authorization: `Bearer ${SECRET}` },
      { 'x-dlr-secret': SECRET },
    ]) {
      const r = await call(dlr, {
        method: 'POST', url: '/api/v1/sms/dlr', body: { status: 'delivered' }, headers,
      });
      assert.equal(r.status, 400);
      assert.equal(r.body.error, 'missing_message_id');
    }
  });
});

describe('R-8 — what the DLR accepts', () => {
  beforeEach(() => { process.env.SMS_DLR_SECRET = SECRET; });
  const auth = { authorization: `Bearer ${SECRET}` };

  test('only POST', async () => {
    for (const method of ['GET', 'PUT'] as const) {
      const r = await call(dlr, { method, url: '/api/v1/sms/dlr', headers: auth });
      assert.equal(r.status, 405);
    }
    const pre = await call(dlr, { method: 'OPTIONS', url: '/api/v1/sms/dlr' });
    assert.equal(pre.status, 204);
  });

  test('a report with no message id is refused', async () => {
    const r = await post({ status: 'delivered' }, auth);
    assert.equal(r.status, 400);
    assert.equal(r.body.error, 'missing_message_id');
    // Whitespace is not an id either.
    assert.equal((await post({ csms_id: '   ', status: 'delivered' }, auth)).body.error,
      'missing_message_id');
  });

  test('THE ONE THAT MATTERS — an unrecognised status is NOT guessed at', async () => {
    // Reaching the database is not needed: an unknown status is answered
    // before the query. Recording "delivered" for a status word we do not
    // know would tell a school a parent was reached when nobody knows that.
    for (const status of ['pending', 'queued', 'accepted', 'weird_vendor_word']) {
      const r = await post({ csms_id: 'm1', sms_status: status }, auth);
      assert.equal(r.status, 200);
      assert.equal(r.body.ignored, true);
      // Echoed back, so an unmapped-but-real status can be added to the map
      // instead of being silently discarded.
      assert.equal(r.body.status, status);
    }
  });

  test('an empty status is ignored rather than treated as failure', async () => {
    const r = await post({ csms_id: 'm1', status: '' }, auth);
    assert.equal(r.status, 200);
    assert.equal(r.body.ignored, true);
    assert.equal(r.body.status, null);
  });

  test('unparseable JSON is 400, not a crash', async () => {
    const r = await call(dlr, {
      method: 'POST', url: '/api/v1/sms/dlr',
      headers: { ...auth, 'content-type': 'application/json' },
    });
    // No body at all: readJson rejects, and the handler answers rather than
    // throwing a 500 into the aggregator's retry queue.
    assert.equal(r.status, 400);
    assert.equal(r.body.error, 'invalid_body');
  });

  test('the caller cannot name a tenant, because nothing reads one', async () => {
    // Not a behavioural assertion so much as a structural one: the request
    // shape has no tenant field, and the handler passes only the message id,
    // state, error code and cost to the database function. If a future edit
    // adds a tenant parameter, this reading of the source fails.
    const src = await import('node:fs/promises')
      .then((fs) => fs.readFile(new URL('../api/dlr.ts', import.meta.url), 'utf8'));
    assert.doesNotMatch(src, /body\.tenant/i);
    assert.doesNotMatch(src, /x-tenant/i);
    assert.match(src, /record_sms_delivery\(\$1, \$2, \$3, \$4\)/);
  });
});
