/**
 * R-8 §2 — the widest credential in the product.
 *
 * SERVICE_API_KEY plus `X-Tenant-ID` makes the caller any user of any school.
 * These tests hold the four properties that narrow it, and — the point of the
 * whole file — the property that an ordinary logged-in user cannot reach any
 * of it. A teacher with a valid token and a forged tenant header is still that
 * teacher, in that school, and the reason is structural: the JWT path never
 * looks at the header at all.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { IncomingMessage } from 'node:http';

import {
  matchServiceKey, looksLikeBrowser, tenantSwitchAllowed,
  authenticateServiceKey, keyFingerprint,
} from '../src/service-auth.ts';

const KEY = 'svc-key-aaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const NEXT = 'svc-key-bbbbbbbbbbbbbbbbbbbbbbbbbbbb';

function req(headers: Record<string, string> = {}): IncomingMessage {
  return { headers } as unknown as IncomingMessage;
}

/** Silence the deliberate console.warn audit lines while asserting. */
function quiet<T>(fn: () => T): T {
  const original = console.warn;
  console.warn = () => {};
  try { return fn(); } finally { console.warn = original; }
}

describe('R-8 §2 — matching the key', () => {
  test('the current key matches; a near-miss does not', () => {
    const env = { SERVICE_API_KEY: KEY } as NodeJS.ProcessEnv;
    assert.equal(matchServiceKey(KEY, env), 'current');
    assert.equal(matchServiceKey(KEY + 'x', env), null);
    assert.equal(matchServiceKey(KEY.slice(0, -1), env), null);
  });

  test('an empty or absent token never matches, even against an empty env', () => {
    // The bug this guards: `[undefined].includes(undefined)` was true in an
    // earlier shape of this check, so an unconfigured deployment accepted a
    // request with no Authorization header at all.
    assert.equal(matchServiceKey('', {} as NodeJS.ProcessEnv), null);
    assert.equal(matchServiceKey('', { SERVICE_API_KEY: '' } as NodeJS.ProcessEnv), null);
    assert.equal(matchServiceKey('anything', {} as NodeJS.ProcessEnv), null);
  });

  test('rotation — both slots are honoured at once', () => {
    const env = { SERVICE_API_KEY: KEY, SERVICE_API_KEY_NEXT: NEXT } as NodeJS.ProcessEnv;
    assert.equal(matchServiceKey(KEY, env), 'current');
    assert.equal(matchServiceKey(NEXT, env), 'next');
    // Which slot matched is reported so a rotation can be finished with
    // evidence — "nothing has used the old key for a week" — rather than hope.
  });

  test('the cron secret is only accepted where cron is expected', () => {
    const env = { CRON_SECRET: 'cron-secret-value' } as NodeJS.ProcessEnv;
    assert.equal(matchServiceKey('cron-secret-value', env), null);
    assert.equal(matchServiceKey('cron-secret-value', env, { allowCron: true }), 'cron');
  });

  test('the fingerprint identifies the key without revealing it', () => {
    const fp = keyFingerprint(KEY);
    assert.equal(fp.length, 8);
    assert.equal(fp, keyFingerprint(KEY));
    assert.notEqual(fp, keyFingerprint(NEXT));
    assert.ok(!KEY.includes(fp));
  });
});

describe('R-8 §2 — a key presented from a browser', () => {
  test('the three browser markers are each caught', () => {
    assert.equal(looksLikeBrowser(req({ origin: 'https://x.example' })), 'origin');
    assert.equal(looksLikeBrowser(req({ cookie: 'a=1' })), 'cookie');
    assert.equal(looksLikeBrowser(req({ 'sec-fetch-site': 'same-origin' })), 'sec-fetch-site');
  });

  test('THE ONE THAT MATTERS — Node\'s own fetch is not a browser', () => {
    // These are the exact headers undici attaches to `fetch(url)` on Node 24,
    // captured from a live request. The Netlify cron wrapper and every ops
    // script go through undici, so an implementation that reads
    // `sec-fetch-mode: cors` as "a browser" refuses the scheduled SMS
    // dispatch and the nightly maintenance job — silently, on the first
    // production run. The first version of this file did exactly that.
    assert.equal(looksLikeBrowser(req({
      host: '127.0.0.1:60837',
      connection: 'keep-alive',
      authorization: 'Bearer k',
      accept: '*/*',
      'accept-language': '*',
      'sec-fetch-mode': 'cors',
      'user-agent': 'node',
      'accept-encoding': 'gzip, deflate',
    })), null);
  });

  test('other ordinary server-to-server requests are not mistaken either', () => {
    // Referer is deliberately not listed: a false positive locks an engineer
    // out of the recovery path in the middle of an incident.
    assert.equal(looksLikeBrowser(req({ authorization: 'Bearer x', 'user-agent': 'curl/8' })), null);
    assert.equal(looksLikeBrowser(req({ referer: 'https://x.example' })), null);
    assert.equal(looksLikeBrowser(req({ origin: '' })), null);
  });

  test('THE ONE THAT MATTERS — a valid key from a page is refused', () => {
    const env = { SERVICE_API_KEY: KEY, SERVICE_KEY_TENANT_SWITCH: 'on' } as NodeJS.ProcessEnv;
    const r = quiet(() => authenticateServiceKey(
      req({ origin: 'https://app.shikhonbd.com', 'x-tenant-id': 't', 'x-user-id': 'u' }),
      KEY, env, 'sync/push'));
    assert.equal(r.kind, 'refused');
    assert.equal(r.kind === 'refused' && r.code, 'service_key_from_browser');
    assert.equal(r.kind === 'refused' && r.status, 403);
  });

  test('the check fires only after the token matches', () => {
    // Otherwise the unauthenticated probes in the PWA's system screen would
    // start getting 403 instead of the 401 they read as "endpoint alive".
    const env = { SERVICE_API_KEY: KEY } as NodeJS.ProcessEnv;
    const r = authenticateServiceKey(req({ origin: 'https://x.example' }), 'not-the-key', env);
    assert.equal(r.kind, 'not_service');
  });
});

describe('R-8 §2 — tenant switching is off in production by default', () => {
  test('unset: allowed outside production, refused inside it', () => {
    assert.equal(tenantSwitchAllowed({ NODE_ENV: 'development' } as NodeJS.ProcessEnv), true);
    assert.equal(tenantSwitchAllowed({ NODE_ENV: 'test' } as NodeJS.ProcessEnv), true);
    assert.equal(tenantSwitchAllowed({} as NodeJS.ProcessEnv), true);
    assert.equal(tenantSwitchAllowed({ NODE_ENV: 'production' } as NodeJS.ProcessEnv), false);
  });

  test('production can opt back in, deliberately and greppably', () => {
    const on = { NODE_ENV: 'production', SERVICE_KEY_TENANT_SWITCH: 'on' } as NodeJS.ProcessEnv;
    assert.equal(tenantSwitchAllowed(on), true);
    // Removal was never the instruction: an engineer replaying a school's
    // stuck sync batch at 11pm is why this path exists at all.
  });

  test('it can also be forced off outside production', () => {
    assert.equal(tenantSwitchAllowed(
      { NODE_ENV: 'development', SERVICE_KEY_TENANT_SWITCH: 'off' } as NodeJS.ProcessEnv), false);
  });

  test('THE ONE THAT MATTERS — production refuses the switch, and says so', () => {
    const env = { SERVICE_API_KEY: KEY, NODE_ENV: 'production' } as NodeJS.ProcessEnv;
    const r = quiet(() => authenticateServiceKey(
      req({ 'x-tenant-id': 'other-school', 'x-user-id': 'u' }), KEY, env, 'sync/pull'));
    assert.equal(r.kind, 'refused');
    assert.equal(r.kind === 'refused' && r.code, 'service_tenant_switch_disabled');
  });
});

describe('R-8 §2 — an ordinary tenant user cannot reach any of this', () => {
  test('THE ONE THAT MATTERS — a user token is never a service credential', () => {
    // A signed access token is a long opaque string, exactly like the key. The
    // property is that it is compared against the key and does not match, so
    // the endpoint falls through to the JWT path, where tenant, user and role
    // come from the signature and the headers are never read.
    const env = { SERVICE_API_KEY: KEY } as NodeJS.ProcessEnv;
    const teacherToken = 'eyJhbGciOiJFZERTQSJ9.eyJ0aWQiOiJzY2hvb2wtYSJ9.sig';
    const r = authenticateServiceKey(
      req({ 'x-tenant-id': 'school-b', 'x-user-id': 'principal-of-b', 'x-role': 'principal' }),
      teacherToken, env, 'sync/push');
    assert.equal(r.kind, 'not_service');
    // 'not_service' is the whole assertion: the forged headers are simply
    // never consulted, so there is nothing for the teacher to exploit.
  });

  test('an unconfigured deployment cannot be tenant-switched at all', () => {
    // With no SERVICE_API_KEY set, no token whatsoever reaches the service
    // path — including the empty string, which is what an attacker sending
    // `Authorization: Bearer ` supplies.
    for (const token of ['', 'undefined', 'null', KEY]) {
      assert.equal(authenticateServiceKey(
        req({ 'x-tenant-id': 'b', 'x-user-id': 'u' }), token, {} as NodeJS.ProcessEnv).kind,
        'not_service');
    }
  });

  test('a service key still has to say which tenant and user it is acting as', () => {
    const env = { SERVICE_API_KEY: KEY } as NodeJS.ProcessEnv;
    const r = quiet(() => authenticateServiceKey(req({ 'x-tenant-id': 'a' }), KEY, env));
    assert.equal(r.kind, 'refused');
    assert.equal(r.kind === 'refused' && r.code, 'missing_service_context');
  });

  test('the accepted path carries the context through, role defaulting to teacher', () => {
    const env = { SERVICE_API_KEY: KEY } as NodeJS.ProcessEnv;
    const r = quiet(() => authenticateServiceKey(
      req({ 'x-tenant-id': 'school-a', 'x-user-id': 'u-1' }), KEY, env));
    assert.equal(r.kind, 'service');
    assert.deepEqual(r.kind === 'service' && r.context,
      { tenantId: 'school-a', userId: 'u-1', role: 'teacher', keyLabel: 'current' });
  });

  test('every acceptance and refusal leaves exactly one audit line', () => {
    const env = { SERVICE_API_KEY: KEY } as NodeJS.ProcessEnv;
    const lines: string[] = [];
    const original = console.warn;
    console.warn = (l: string) => lines.push(l);
    try {
      authenticateServiceKey(req({ 'x-tenant-id': 'a', 'x-user-id': 'u' }), KEY, env, 'sync/push');
      authenticateServiceKey(req({ origin: 'https://x.example' }), KEY, env, 'sync/push');
    } finally { console.warn = original; }

    assert.equal(lines.length, 2);
    const used = JSON.parse(lines[0]);
    assert.equal(used.event, 'service_key_used');
    assert.equal(used.endpoint, 'sync/push');
    assert.equal(used.fingerprint, keyFingerprint(KEY));
    // The key itself must never appear in a log line, which is the whole
    // reason the fingerprint exists.
    assert.ok(!lines.join('').includes(KEY));
    assert.equal(JSON.parse(lines[1]).event, 'service_key_from_browser');
  });
});
