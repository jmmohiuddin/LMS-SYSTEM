/**
 * R-8 — the SMS provider seam and the delivery-report webhook.
 *
 * Two things worth asserting, and they pull in opposite directions.
 *
 * The first is that the stub stays the default. Every deployment is on it
 * until an aggregator contract lands, and a change that quietly started
 * sending real messages — or quietly stopped — would be discovered by a
 * school, not by us.
 *
 * The second is that a MISCONFIGURED provider fails loudly. `SMS_PROVIDER`
 * set with no credentials must throw at resolution rather than fall back to
 * the stub: an operator who set that variable believes messages are going
 * out, and silently logging them instead is the worst of the three outcomes.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveProvider, StubProvider, SslWirelessProvider,
} from '../src/provider.ts';

describe('R-8 — which provider a deployment gets', () => {
  test('THE ONE THAT MATTERS — no configuration means the stub, not a failure', () => {
    const p = resolveProvider({});
    assert.ok(p instanceof StubProvider);
    assert.equal(p.name, 'stub');
    // The readiness screen reports this, so "SMS is not really sending"
    // appears on a screen rather than being inferred from a log line.
    assert.equal(p.live, false);
  });

  test('an explicit stub is the same as no configuration', () => {
    assert.ok(resolveProvider({ SMS_PROVIDER: 'stub' }) instanceof StubProvider);
    assert.ok(resolveProvider({ SMS_PROVIDER: 'STUB' }) instanceof StubProvider);
  });

  test('a named provider WITHOUT credentials throws — it does not fall back', () => {
    // The dangerous outcome this prevents: an operator sets SMS_PROVIDER,
    // forgets the token, and the product goes on logging messages while
    // everyone believes parents are being texted.
    assert.throws(
      () => resolveProvider({ SMS_PROVIDER: 'ssl_wireless' }),
      /SMS_ENDPOINT.*SMS_API_TOKEN.*SMS_SENDER_ID/s,
    );
    // And it names exactly which one is missing, not just "misconfigured".
    assert.throws(
      () => resolveProvider({
        SMS_PROVIDER: 'ssl_wireless',
        SMS_ENDPOINT: 'https://x', SMS_API_TOKEN: 't',
      }),
      /SMS_SENDER_ID is not set/,
    );
  });

  test('an unknown provider name is refused rather than guessed at', () => {
    assert.throws(() => resolveProvider({ SMS_PROVIDER: 'grameenphone' }),
      /unknown SMS_PROVIDER/);
  });

  test('fully configured, the real adapter is returned and reports itself live', () => {
    const p = resolveProvider({
      SMS_PROVIDER: 'ssl_wireless',
      SMS_ENDPOINT: 'https://smsplus.example/api/v3/send-sms',
      SMS_API_TOKEN: 'token', SMS_SENDER_ID: 'SHIKHON',
    });
    assert.ok(p instanceof SslWirelessProvider);
    assert.equal(p.live, true);
  });
});

describe('R-8 — the SSL Wireless adapter', () => {
  /** A fetch that records what it was asked and answers what we tell it. */
  function fakeFetch(reply: unknown, status = 200) {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const impl = async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init.body)) });
      return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => reply,
      } as unknown as Response;
    };
    return { impl, calls };
  }

  const make = () => new SslWirelessProvider({
    endpoint: 'https://smsplus.example/send', token: 'tok', sid: 'SHIKHON',
  });

  test('sends the shape the aggregator expects, with OUR id as the idempotency key', async () => {
    const f = fakeFetch({ status: 'SUCCESS', smsinfo: [{ reference_id: 'ref_1' }] });
    const original = globalThis.fetch;
    globalThis.fetch = f.impl as unknown as typeof fetch;
    try {
      const r = await make().send('+8801711000001', 'পরীক্ষা', 'outbox-row-id');
      assert.equal(r.provider, 'ssl_wireless');
      assert.equal(r.providerMsgId, 'ref_1');

      const sent = f.calls[0].body;
      // The leading + is stripped: the aggregator wants 88017…, and sending
      // it +88017… is a rejection per message, discovered one school at a time.
      assert.equal(sent.msisdn, '8801711000001');
      assert.equal(sent.sid, 'SHIKHON');
      // The outbox row id, so a cron that fires twice cannot double-send.
      assert.equal(sent.csms_id, 'outbox-row-id');
      assert.equal(sent.sms, 'পরীক্ষা');
    } finally {
      globalThis.fetch = original;
    }
  });

  test('THE ONE THAT MATTERS — HTTP 200 with a failure body is a failure', async () => {
    // This class of API answers 200 and puts the outcome in the payload.
    // Treating the status code as success would mark undelivered messages
    // 'sent' and lose them silently.
    const f = fakeFetch({ status: 'FAILED', error_message: 'invalid number' });
    const original = globalThis.fetch;
    globalThis.fetch = f.impl as unknown as typeof fetch;
    try {
      await assert.rejects(
        make().send('+8801711000001', 'x', 'id'),
        /ssl_wireless FAILED: invalid number/);
    } finally {
      globalThis.fetch = original;
    }
  });

  test('a non-2xx response is a failure', async () => {
    const f = fakeFetch({}, 502);
    const original = globalThis.fetch;
    globalThis.fetch = f.impl as unknown as typeof fetch;
    try {
      await assert.rejects(make().send('+8801711000001', 'x', 'id'), /HTTP 502/);
    } finally {
      globalThis.fetch = original;
    }
  });

  test('with no reference returned, our own id is kept so a DLR can still match', async () => {
    const f = fakeFetch({ status: 'SUCCESS' });
    const original = globalThis.fetch;
    globalThis.fetch = f.impl as unknown as typeof fetch;
    try {
      const r = await make().send('+8801711000001', 'x', 'our-id');
      assert.equal(r.providerMsgId, 'our-id');
      // Not guessed at: this API does not report per-message cost, and a
      // made-up number would end up in a school's bill reconciliation.
      assert.equal(r.costBdt, null);
    } finally {
      globalThis.fetch = original;
    }
  });
});
