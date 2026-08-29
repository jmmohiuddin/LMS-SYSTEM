/**
 * R-8 — the go-live switches.
 *
 * These decide whether a school's parents get texted, whether money moves,
 * and whether a national identifier can be stored. Every one of them was a
 * hardcoded `const` before R-8, so the property that matters most is not that
 * they can be turned ON — it is that they cannot be turned on BY ACCIDENT.
 *
 * Hence the emphasis below on everything that is not exactly `"true"`.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  enabled, otpSendingEnabled, mfsPaymentsEnabled, aiEnabled,
  smsProviderConfigured, goLiveChecks,
} from '../src/go-live.ts';

describe('R-8 — a switch must not turn on by accident', () => {
  test('THE ONE THAT MATTERS — nothing but the word "true" is on', () => {
    // Case is forgiven, because TRUE is unambiguously somebody deciding.
    for (const v of ['true', 'TRUE', 'True', ' true ']) {
      assert.equal(enabled('X', { X: v }), true, `"${v}" should be on`);
    }
    // Nothing else is. Each of these reads as "on" to a human, and each one
    // resolves OFF — which is the safe direction to be wrong in: a switch
    // that stayed off gets reported by an operator, a switch that turned
    // itself on gets reported by a parent who received a text at midnight.
    for (const v of ['1', 'yes', 'on', 'enabled', 'y', 't', 'false', 'no', '0']) {
      assert.equal(enabled('X', { X: v }), false, `"${v}" must not enable`);
    }
  });

  test('unset, empty and whitespace are off', () => {
    assert.equal(enabled('X', {}), false);
    assert.equal(enabled('X', { X: '' }), false);
    assert.equal(enabled('X', { X: '   ' }), false);
  });

  test('each named switch reads its own variable and nothing else', () => {
    assert.equal(otpSendingEnabled({ OTP_SENDING_ENABLED: 'true' }), true);
    assert.equal(otpSendingEnabled({ MFS_PAYMENTS_ENABLED: 'true' }), false);
    assert.equal(mfsPaymentsEnabled({ MFS_PAYMENTS_ENABLED: 'true' }), true);
    assert.equal(mfsPaymentsEnabled({}), false);
  });

  test('the AI is enabled by the PRESENCE of a key, not a flag', () => {
    assert.equal(aiEnabled({}), false);
    assert.equal(aiEnabled({ ANTHROPIC_API_KEY: 'sk-x' }), true);
    // No flag can turn it on without a key, because there would be nothing
    // to call.
    assert.equal(aiEnabled({ AI_ENABLED: 'true' }), false);
  });
});

describe('R-8 — "configured" means usable, not merely named', () => {
  const full = {
    SMS_PROVIDER: 'ssl_wireless',
    SMS_ENDPOINT: 'https://x', SMS_API_TOKEN: 't', SMS_SENDER_ID: 'S',
  };

  test('a provider named without credentials is NOT configured', () => {
    assert.equal(smsProviderConfigured({ SMS_PROVIDER: 'ssl_wireless' }), false);
    for (const missing of ['SMS_ENDPOINT', 'SMS_API_TOKEN', 'SMS_SENDER_ID']) {
      const env: Record<string, string> = { ...full };
      delete env[missing];
      assert.equal(smsProviderConfigured(env), false, `missing ${missing} should not be ready`);
    }
    assert.equal(smsProviderConfigured(full), true);
  });

  test('the stub is never "configured"', () => {
    assert.equal(smsProviderConfigured({}), false);
    assert.equal(smsProviderConfigured({ SMS_PROVIDER: 'stub' }), false);
  });
});

describe('R-8 — the readiness report', () => {
  test('an empty environment is not ready, and says which items block', () => {
    const r = goLiveChecks({});
    assert.ok(r.length >= 6);
    const blocking = r.filter((c) => c.severity === 'blocking');
    assert.ok(blocking.length >= 3);
    assert.ok(blocking.every((c) => !c.ready), 'nothing should be ready on an empty env');
    // Every line explains itself. A tick or a cross with no reason leaves an
    // operator guessing which variable to set.
    assert.ok(r.every((c) => c.detailBn.length > 0));
  });

  test('a provider named but unconfigured reports BROKEN, not merely off', () => {
    const c = goLiveChecks({ SMS_PROVIDER: 'ssl_wireless' })
      .find((x) => x.key === 'sms_provider');
    assert.ok(c);
    assert.equal(c.ready, false);
    // The difference matters: "no aggregator" is a decision, "credentials
    // incomplete" is a mistake, and they need different actions.
    assert.match(c.detailBn, /ক্রেডেনশিয়াল অসম্পূর্ণ/);
  });

  test('OTP on without an aggregator is flagged, not silently blessed', () => {
    const c = goLiveChecks({ OTP_SENDING_ENABLED: 'true' })
      .find((x) => x.key === 'otp_login');
    assert.ok(c);
    assert.equal(c.ready, true);
    // Ready, but the detail warns that codes will not arrive — the exact
    // half-configured state that produces "login is broken" tickets.
    assert.match(c.detailBn, /অ্যাগ্রিগেটর ছাড়া/);
  });

  test('a fully configured deployment has no blocking item left', () => {
    const r = goLiveChecks({
      SMS_PROVIDER: 'ssl_wireless', SMS_ENDPOINT: 'https://x',
      SMS_API_TOKEN: 't', SMS_SENDER_ID: 'S', SMS_DLR_SECRET: 'd',
      OTP_SENDING_ENABLED: 'true', PII_MASTER_KEY_V1: 'k',
      DATABASE_MAINTENANCE_URL: 'postgres://x',
      PLATFORM_API_KEY: 'p', PLATFORM_DATABASE_URL: 'postgres://y',
    });
    assert.equal(r.filter((c) => c.severity === 'blocking' && !c.ready).length, 0);
  });

  test('no secret VALUE ever appears in the report', () => {
    const secret = 'sk-super-secret-value-9999';
    const r = goLiveChecks({
      ANTHROPIC_API_KEY: secret, PII_MASTER_KEY_V1: secret,
      PLATFORM_API_KEY: secret, SMS_API_TOKEN: secret, SMS_DLR_SECRET: secret,
      DATABASE_MAINTENANCE_URL: `postgres://user:${secret}@host/db`,
    });
    // §24: no platform secret in browser code — and none in a browser
    // RESPONSE either. The screen reports presence, never the value.
    assert.doesNotMatch(JSON.stringify(r), new RegExp(secret));
  });

  test('the sender id and provider name ARE shown, because they are not secret', () => {
    const c = goLiveChecks({
      SMS_PROVIDER: 'ssl_wireless', SMS_ENDPOINT: 'https://x',
      SMS_API_TOKEN: 'tok', SMS_SENDER_ID: 'SHIKHON',
    }).find((x) => x.key === 'sms_provider');
    assert.match(c?.detailBn ?? '', /SHIKHON/);
    // The token is not.
    assert.doesNotMatch(c?.detailBn ?? '', /tok/);
  });
});
