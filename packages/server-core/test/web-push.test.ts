/**
 * R-9 — web push crypto, checked against the RFCs' own worked examples.
 *
 * This is the reason the encryption is hand-written rather than pulled from
 * npm: both specifications publish a complete example with fixed keys and a
 * fixed expected output, so the implementation can be asserted against the
 * SPECIFICATION rather than against its own previous output. A snapshot test
 * of my own bytes would pass just as happily if every one of them were wrong.
 *
 * Getting this wrong does not fail loudly. A push service accepts a malformed
 * body with a 201 and the browser silently fails to decrypt it, so the symptom
 * is "some parents never get notifications" — reported weeks later, by
 * somebody who assumed they had turned them off by accident.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  encryptPayload, generateVapidKeys, vapidHeader, vapidFromEnv, sendPush,
  b64url, unb64url, endpointFingerprint, publicKeyFromPrivate,
  MAX_PAYLOAD_BYTES,
} from '../src/web-push.ts';

describe('R-9 — RFC 8291 §5, the specification\'s own example', () => {
  // Every value below is copied from RFC 8291 §5. Nothing here is ours.
  const PLAINTEXT = 'When I grow up, I want to be a watermelon';
  const RECEIVER_PUBLIC = 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4';
  const AUTH_SECRET = 'BTBZMqHH6r4Tts7J_aSIgg';
  const SENDER_PRIVATE = 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw';
  const SALT = 'DGv6ra1nlYgDCS1FRnbzlw';
  const EXPECTED = 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml'
    + 'mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT'
    + 'pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN';

  test('THE ONE THAT MATTERS — the ciphertext matches the RFC byte for byte', () => {
    const out = encryptPayload(
      PLAINTEXT,
      { p256dh: RECEIVER_PUBLIC, auth: AUTH_SECRET },
      { salt: unb64url(SALT), senderPrivateKey: unb64url(SENDER_PRIVATE) },
    );
    assert.equal(b64url(out), EXPECTED);
  });

  test('the sender public key in the header is the RFC\'s', () => {
    // RFC 8291 §5 states the sender's public key; deriving a different one
    // from the given private key would mean the curve or point encoding is
    // wrong, which the vector above would also catch but not explain.
    assert.equal(
      b64url(publicKeyFromPrivate(unb64url(SENDER_PRIVATE))),
      'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
    );
  });

  test('the header is salt(16) ‖ rs(4) ‖ idlen(1) ‖ key(65), per RFC 8188', () => {
    const out = encryptPayload(PLAINTEXT, { p256dh: RECEIVER_PUBLIC, auth: AUTH_SECRET },
      { salt: unb64url(SALT), senderPrivateKey: unb64url(SENDER_PRIVATE) });
    assert.deepEqual(out.subarray(0, 16), unb64url(SALT));
    assert.equal(out.readUInt32BE(16), 4096);
    assert.equal(out.readUInt8(20), 65);
    assert.equal(out.subarray(21, 86)[0], 0x04, 'uncompressed point marker');
    // 86 bytes of header, the plaintext, the 0x02 delimiter, and a 16-byte tag.
    assert.equal(out.length, 86 + PLAINTEXT.length + 1 + 16);
  });
});

describe('R-9 — encryption refuses what it cannot encrypt', () => {
  const OK = { p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4', auth: 'BTBZMqHH6r4Tts7J_aSIgg' };

  test('a p256dh that is not a 65-byte uncompressed point is rejected', () => {
    assert.throws(() => encryptPayload('x', { ...OK, p256dh: b64url(Buffer.alloc(64)) }),
      /65-byte uncompressed/);
    // Right length, wrong first byte — a compressed point, which would produce
    // a shared secret the browser cannot reproduce.
    const compressed = Buffer.alloc(65); compressed[0] = 0x02;
    assert.throws(() => encryptPayload('x', { ...OK, p256dh: b64url(compressed) }),
      /65-byte uncompressed/);
  });

  test('an auth secret that is not 16 bytes is rejected', () => {
    assert.throws(() => encryptPayload('x', { ...OK, auth: b64url(Buffer.alloc(8)) }),
      /16 bytes/);
  });

  test('two encryptions of the same message differ', () => {
    // The salt and sender key default to random. If they did not, two messages
    // to one device would share a keystream, which is the classic way to lose
    // a stream cipher's confidentiality.
    const a = encryptPayload('same', OK);
    const b = encryptPayload('same', OK);
    assert.notEqual(a.toString('hex'), b.toString('hex'));
    assert.notDeepEqual(a.subarray(0, 16), b.subarray(0, 16), 'salts must differ');
  });

  test('Bangla survives the round trip into the ciphertext length', () => {
    // Bangla is 3 bytes per character in UTF-8. A length computed in
    // characters rather than bytes would silently truncate every real message
    // this product sends.
    const bn = 'আগামীকাল বিদ্যালয় বন্ধ থাকবে';
    const out = encryptPayload(bn, OK);
    assert.equal(out.length, 86 + Buffer.byteLength(bn, 'utf8') + 1 + 16);
  });
});

describe('R-9 — RFC 8292 VAPID', () => {
  const keys = generateVapidKeys();

  test('a generated keypair is the right shape', () => {
    assert.equal(unb64url(keys.publicKey).length, 65);
    assert.equal(unb64url(keys.publicKey)[0], 0x04);
    assert.equal(unb64url(keys.privateKey).length, 32);
    // No padding: a browser passed a padded key rejects it.
    assert.doesNotMatch(keys.publicKey, /=/);
    assert.doesNotMatch(keys.publicKey, /[+/]/);
  });

  test('THE ONE THAT MATTERS — aud is the push service ORIGIN, not the endpoint', () => {
    const h = vapidHeader('https://fcm.googleapis.com/fcm/send/abc123?x=1', keys);
    const jwt = /t=([^,]+)/.exec(h)?.[1] ?? '';
    const claims = JSON.parse(unb64url(jwt.split('.')[1]).toString());
    // A token minted for one push service must not be replayable against
    // another, and the endpoint path would also leak a device identifier into
    // a token that is sent in the clear.
    assert.equal(claims.aud, 'https://fcm.googleapis.com');
    assert.doesNotMatch(jwt, /abc123/);
  });

  test('the signature is raw r‖s (64 bytes), not DER', () => {
    // DER is what node produces by default, and every push service rejects it
    // with a 400 that does not say why.
    const h = vapidHeader('https://updates.push.services.mozilla.com/wpush/v2/x', keys);
    const sig = unb64url((/t=([^,]+)/.exec(h)?.[1] ?? '').split('.')[2]);
    assert.equal(sig.length, 64);
  });

  test('the header carries the public key so the service can verify', () => {
    const h = vapidHeader('https://x.example/p', keys);
    assert.match(h, /^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=/);
    assert.ok(h.endsWith(keys.publicKey));
  });

  test('expiry is inside the RFC\'s 24-hour ceiling', () => {
    const now = 1_700_000_000;
    const h = vapidHeader('https://x.example/p', keys, { nowSeconds: now });
    const claims = JSON.parse(unb64url((/t=([^,]+)/.exec(h)?.[1] ?? '').split('.')[1]).toString());
    assert.ok(claims.exp > now, 'must not already be expired');
    assert.ok(claims.exp - now <= 24 * 60 * 60, 'RFC 8292 §2 caps this at 24h');
  });

  test('the contact is the PLATFORM, never a school (D11)', () => {
    const h = vapidHeader('https://x.example/p', keys);
    const claims = JSON.parse(unb64url((/t=([^,]+)/.exec(h)?.[1] ?? '').split('.')[1]).toString());
    // A push service operator with an abuse complaint needs to reach us, not a
    // head teacher who has never heard of RFC 8292.
    assert.match(claims.sub, /^mailto:.+@shikhonbd\.com$/);
  });
});

describe('R-9 — reading VAPID keys from the environment', () => {
  test('absent keys mean push is off, not an error', () => {
    assert.equal(vapidFromEnv({}), null);
    assert.equal(vapidFromEnv({ VAPID_PUBLIC_KEY: 'x' }), null);
  });

  test('THE ONE THAT MATTERS — a malformed key fails at read, not per message', () => {
    // Otherwise every push in the fan-out fails individually, and the log
    // fills with per-device errors for one deployment-wide mistake.
    assert.throws(() => vapidFromEnv({
      VAPID_PUBLIC_KEY: b64url(Buffer.alloc(32)),
      VAPID_PRIVATE_KEY: b64url(Buffer.alloc(32)),
    }), /65-byte/);
    assert.throws(() => vapidFromEnv({
      VAPID_PUBLIC_KEY: b64url(Buffer.alloc(65, 4)),
      VAPID_PRIVATE_KEY: b64url(Buffer.alloc(16)),
    }), /32-byte/);
  });

  test('a well-formed pair is returned, whitespace tolerated', () => {
    const k = generateVapidKeys();
    const got = vapidFromEnv({
      VAPID_PUBLIC_KEY: ` ${k.publicKey} `, VAPID_PRIVATE_KEY: ` ${k.privateKey} `,
    });
    assert.deepEqual(got, k);
  });
});

describe('R-9 — sending, and how failure is reported', () => {
  const keys = generateVapidKeys();
  const target = {
    endpoint: 'https://fcm.googleapis.com/fcm/send/abc',
    p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
    auth: 'BTBZMqHH6r4Tts7J_aSIgg',
  };

  const fakeFetch = (status: number, capture?: { last?: RequestInit & { url?: string } }) =>
    (async (url: string, init: RequestInit) => {
      if (capture) capture.last = { ...init, url };
      return { status, ok: status >= 200 && status < 300 } as Response;
    }) as unknown as typeof fetch;

  test('201 is success', async () => {
    const r = await sendPush(target, 'hi', keys, { fetchImpl: fakeFetch(201) });
    assert.deepEqual(r, { ok: true, status: 201 });
  });

  test('THE ONE THAT MATTERS — 404 and 410 mean the subscription is gone', async () => {
    // This is how a dead subscription gets cleaned up. Treated as a generic
    // failure instead, the row would be retried forever and the table would
    // fill with browsers that no longer exist.
    for (const status of [404, 410]) {
      const r = await sendPush(target, 'hi', keys, { fetchImpl: fakeFetch(status) });
      assert.deepEqual(r, { ok: false, gone: true, status });
    }
  });

  test('other failures are NOT "gone" — the subscription survives an outage', async () => {
    for (const status of [429, 500, 502, 503]) {
      const r = await sendPush(target, 'hi', keys, { fetchImpl: fakeFetch(status) });
      assert.equal(r.ok, false);
      assert.equal((r as { gone: boolean }).gone, false,
        `${status} must not delete a subscription`);
    }
  });

  test('a network throw is an outcome, not an exception', async () => {
    // A fan-out over 400 devices must not be abandoned because one push
    // service is unreachable.
    const boom = (async () => { throw new Error('ECONNRESET'); }) as unknown as typeof fetch;
    const r = await sendPush(target, 'hi', keys, { fetchImpl: boom });
    assert.equal(r.ok, false);
    assert.match((r as { error: string }).error, /ECONNRESET/);
  });

  test('an oversized payload is refused before it is encrypted', async () => {
    let called = false;
    const spy = (async () => { called = true; return { status: 201, ok: true } as Response; }) as unknown as typeof fetch;
    const r = await sendPush(target, 'x'.repeat(MAX_PAYLOAD_BYTES + 1), keys, { fetchImpl: spy });
    assert.equal(r.ok, false);
    assert.match((r as { error: string }).error, /exceeds/);
    assert.equal(called, false, 'must not spend a request on a body that cannot fit');
  });

  test('the request carries the headers a push service requires', async () => {
    const cap: { last?: RequestInit & { url?: string } } = {};
    await sendPush(target, 'hi', keys, { fetchImpl: fakeFetch(201, cap) });
    const h = cap.last?.headers as Record<string, string>;
    assert.equal(h['Content-Encoding'], 'aes128gcm');
    assert.equal(h['Content-Type'], 'application/octet-stream');
    assert.match(h.Authorization, /^vapid t=/);
    assert.ok(Number(h.TTL) > 0);
  });

  test('a broken subscription fails without throwing', async () => {
    const r = await sendPush({ ...target, auth: 'short' }, 'hi', keys,
      { fetchImpl: fakeFetch(201) });
    assert.equal(r.ok, false);
    assert.equal((r as { gone: boolean }).gone, false);
  });
});

describe('R-9 — endpoints stay out of logs', () => {
  test('the fingerprint identifies without disclosing', () => {
    const ep = 'https://fcm.googleapis.com/fcm/send/very-secret-device-token';
    const fp = endpointFingerprint(ep);
    assert.match(fp, /^[0-9a-f]{12}$/);
    // Anyone holding an endpoint can push to that phone, so it is a
    // capability, not an identifier — it does not belong in a log line.
    assert.ok(!fp.includes('secret'));
    assert.equal(endpointFingerprint(ep), fp, 'stable, so logs can be correlated');
    assert.notEqual(endpointFingerprint(`${ep}x`), fp);
  });
});

describe('VAPID key generation is fixed-width (found by the P1 gate)', () => {
  test('THE ONE THAT MATTERS — a generated private key is always 32 bytes', () => {
    // Node's `getPrivateKey()` trims leading zero bytes, so ~1 scalar in 256
    // came back 31 bytes long — measured at 83 of 20,000 before the fix. The
    // PKCS#8 envelope is fixed-length DER declaring 32, so those pairs threw
    // "VAPID private key must be 32 bytes" on every send.
    //
    // Nobody would have seen this as a flake: the pair is minted ONCE per
    // deployment and kept. A school unlucky at setup would have had push
    // silently dead forever. 4,000 draws makes a 1-in-256 miss a certainty
    // rather than a coin toss.
    for (let i = 0; i < 4000; i++) {
      const raw = Buffer.from(generateVapidKeys().privateKey, 'base64url');
      assert.equal(raw.length, 32, `draw ${i} produced a ${raw.length}-byte scalar`);
    }
  });

  test('every generated pair can actually sign a token', () => {
    // The property that matters downstream: not the byte count, but that the
    // key survives being turned into a signing key.
    for (let i = 0; i < 400; i++) {
      const k = generateVapidKeys();
      assert.doesNotThrow(() => vapidHeader('https://fcm.googleapis.com/x', k, 'mailto:a@b.c'),
        `draw ${i} produced a key that cannot sign`);
    }
  });
});
