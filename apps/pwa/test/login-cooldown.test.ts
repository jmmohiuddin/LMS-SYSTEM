/**
 * The client half of F-102.
 *
 * Wireframe §5.1 requires a rate-limit rejection to render as a countdown,
 * not an error. That is a product decision with a real consequence: an error
 * line tells a teacher the app is broken and to try something else; a
 * countdown tells them the truth, which is that they need to wait N seconds.
 * These tests pin the wording, the minute/second boundary, and the parsing
 * that carries retryAfterSec from the 429 body to the screen.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { cooldownMessage } from '../src/login-view.ts';
import { AuthError, retryAfterSeconds } from '../src/auth.ts';

describe('cooldownMessage', () => {
  test('renders seconds below a minute', () => {
    const m = cooldownMessage(45);
    assert.ok(m.includes('45'), m);
    assert.ok(m.includes('সেকেন্ড'), 'must say seconds in Bangla');
  });

  test('renders minutes at and above a minute', () => {
    const m = cooldownMessage(120);
    assert.ok(m.includes('2'), m);
    assert.ok(m.includes('মিনিট'), 'must say minutes in Bangla');
  });

  test('rounds up, so the timer never says "0" while still blocked', () => {
    // Showing "0 সেকেন্ড" while the submit button is still disabled reads as
    // a bug. Ceiling keeps the number and the button state consistent.
    assert.ok(cooldownMessage(0.4).includes('1'));
    assert.ok(cooldownMessage(59.1).includes('60') || cooldownMessage(59.1).includes('1'));
  });

  test('never emits a negative number', () => {
    assert.ok(cooldownMessage(-5).includes('0'));
  });

  test('is never the generic connection error', () => {
    // The regression this guards: routing 429 through friendlyError()'s
    // default branch, which is what the screen did before F-102.
    assert.ok(!cooldownMessage(30).includes('সংযোগে সমস্যা'));
  });
});

describe('AuthError carries the retry delay', () => {
  test('defaults to zero for a non-429 failure', () => {
    const e = new AuthError('invalid_code', 'nope');
    assert.equal(e.retryAfterSec, 0);
  });

  test('preserves the delay so the view can start a countdown', () => {
    const e = new AuthError('rate_limited', 'too many', 90);
    assert.equal(e.code, 'rate_limited');
    assert.equal(e.retryAfterSec, 90);
    assert.ok(cooldownMessage(e.retryAfterSec).includes('মিনিট'));
  });
});

describe('retryAfterSeconds', () => {
  test('reads the delay from our own 429 body', () => {
    assert.equal(retryAfterSeconds(429, { error: 'rate_limited', retryAfterSec: 42 }, null), 42);
  });

  test('falls back to the Retry-After header when there is no body of ours', () => {
    // A 429 from a platform edge never carries our JSON shape.
    assert.equal(retryAfterSeconds(429, {}, '30'), 30);
  });

  test('prefers the body over the header when both are present', () => {
    assert.equal(retryAfterSeconds(429, { retryAfterSec: 42 }, '30'), 42);
  });

  test('is zero for every non-429 status', () => {
    assert.equal(retryAfterSeconds(400, { retryAfterSec: 42 }, '30'), 0);
    assert.equal(retryAfterSeconds(503, {}, '30'), 0);
  });

  test('survives junk without producing NaN', () => {
    // NaN would reach cooldownMessage and render "NaN সেকেন্ড".
    assert.equal(retryAfterSeconds(429, { retryAfterSec: 'soon' }, null), 0);
    assert.equal(retryAfterSeconds(429, {}, 'Wed, 21 Oct 2015 07:28:00 GMT'), 0);
    assert.equal(retryAfterSeconds(429, null, null), 0);
    assert.equal(retryAfterSeconds(429, { retryAfterSec: -5 }, null), 0);
  });
});
