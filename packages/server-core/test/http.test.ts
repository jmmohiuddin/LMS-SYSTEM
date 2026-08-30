/**
 * R-8 §1/§8 — which origins may read an authenticated response.
 *
 * `Access-Control-Allow-Origin: *` has been correct-but-broad since the
 * beginning, and it is worth being precise about why it was never a hole: this
 * API authenticates by bearer token and never by cookie, so a browser sends no
 * ambient credential and a hostile page has nothing to ride on. There is no
 * CSRF here to fix.
 *
 * What `*` costs is defence in depth — any origin may call the API, so a token
 * that leaked into one could be used from it. `ALLOWED_ORIGINS` narrows that
 * for production, and the property these tests exist to hold is that turning
 * it OFF changes nothing: a control that breaks an unconfigured deployment is
 * a control nobody ever turns on.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { corsOriginFor, corsHeaders } from '../src/http.ts';

describe('R-8 — the CORS origin allowlist', () => {
  test('THE ONE THAT MATTERS — unset behaves exactly as before', () => {
    assert.deepEqual(corsOriginFor('https://anything.example', {}),
      { origin: '*', vary: false });
    assert.deepEqual(corsOriginFor(undefined, { ALLOWED_ORIGINS: '' }),
      { origin: '*', vary: false });
    assert.deepEqual(corsOriginFor(undefined, { ALLOWED_ORIGINS: '  , ,  ' }),
      { origin: '*', vary: false });
  });

  test('a listed origin is echoed, and the response varies on it', () => {
    const env = {
      ALLOWED_ORIGINS: 'https://app.shikhonbd.com,https://platform.shikhonbd.com',
    };
    assert.deepEqual(corsOriginFor('https://platform.shikhonbd.com', env),
      { origin: 'https://platform.shikhonbd.com', vary: true });
    // Vary matters: a shared cache must not hand one origin's allowed
    // response to another.
    assert.equal(corsOriginFor('https://app.shikhonbd.com', env).vary, true);
  });

  test('an unlisted origin is neither echoed nor given a wildcard', () => {
    const env = { ALLOWED_ORIGINS: 'https://app.shikhonbd.com' };
    const got = corsOriginFor('https://evil.example', env);
    assert.notEqual(got.origin, 'https://evil.example');
    assert.notEqual(got.origin, '*');
  });

  test('a request with no Origin is not handed a wildcard either', () => {
    // Otherwise the list is defeated by the one caller most able to omit the
    // header — and a request without an Origin is not a browser cross-origin
    // request in the first place.
    const env = { ALLOWED_ORIGINS: 'https://app.shikhonbd.com' };
    assert.notEqual(corsOriginFor(undefined, env).origin, '*');
  });

  test('whitespace and blanks in the list are ignored', () => {
    const env = { ALLOWED_ORIGINS: ' https://a.example , , https://b.example ' };
    assert.equal(corsOriginFor('https://b.example', env).origin, 'https://b.example');
  });
});

describe('R-8 — the headers themselves', () => {
  test('no Vary is emitted when nothing varies', () => {
    const h = corsHeaders();
    assert.equal(h['Access-Control-Allow-Origin'], '*');
    assert.equal(h.Vary, undefined);
  });

  test('THE ONE THAT MATTERS — credentials are never allowed', () => {
    // `*` and `Allow-Credentials: true` together would be the actual hole, and
    // browsers refuse the combination — but the reason it is safe here is that
    // this API has no cookie to send. Asserted so a future change that adds
    // cookie auth has to come past this test.
    const h = corsHeaders([], 'GET, POST, OPTIONS', 'https://x.example');
    assert.equal(h['Access-Control-Allow-Credentials'], undefined);
  });

  test('the auth header is allowed, since that is how callers authenticate', () => {
    const h = corsHeaders();
    assert.match(h['Access-Control-Allow-Headers'], /Authorization/);
  });

  test('extra headers are added, not substituted', () => {
    const h = corsHeaders(['X-Debug-Otp']);
    assert.match(h['Access-Control-Allow-Headers'], /Authorization/);
    assert.match(h['Access-Control-Allow-Headers'], /X-Debug-Otp/);
  });
});
