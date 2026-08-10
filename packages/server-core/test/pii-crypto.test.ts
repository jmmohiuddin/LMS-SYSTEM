/**
 * National-identifier encryption (F-101).
 *
 * These assert the properties a breach actually depends on: that a stolen
 * database yields nothing, that one school's key cannot read another's
 * records, that a ciphertext cannot be moved between rows, that rotation
 * does not orphan old data, and — the rule that is easiest to violate by
 * accident — that no error message or return value ever carries the
 * plaintext.
 *
 *   node --test packages/server-core/test/pii-crypto.test.ts
 *
 * No database needed: this layer is pure. The DB guards that back it up
 * (migration 021) are exercised by db/tests/.
 */
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';

import {
  sealIdentifier,
  unsealIdentifier,
  rotateIdentifier,
  blindIndexForLookup,
  blindIndexEquals,
  normalizeIdentifier,
  isPlausibleIdentifier,
  redactIdentifier,
  currentKeyVersion,
  sealedKeyVersion,
  piiCryptoAvailable,
  PiiKeyUnavailable,
  PiiDecryptionFailed,
} from '../src/pii-crypto.ts';

const TENANT_A = '8a000000-0000-4000-8000-00000000000a';
const TENANT_B = '8b000000-0000-4000-8000-00000000000b';
const SUBJECT_1 = '11111111-1111-4111-8111-111111111111';
const SUBJECT_2 = '22222222-2222-4222-8222-222222222222';

// A realistic 10-digit Bangladeshi NID. Fabricated, not a real number.
const NID = '1990123456';
const BRC = '19998765432101234';

const KEY_V1 = randomBytes(32).toString('base64');
const KEY_V2 = randomBytes(32).toString('base64');

let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = { ...process.env } as Record<string, string | undefined>;
  for (let v = 1; v <= 16; v++) delete process.env[`PII_MASTER_KEY_V${v}`];
  process.env.PII_MASTER_KEY_V1 = KEY_V1;
});

afterEach(() => {
  for (let v = 1; v <= 16; v++) delete process.env[`PII_MASTER_KEY_V${v}`];
  for (const [k, val] of Object.entries(savedEnv)) {
    if (k.startsWith('PII_MASTER_KEY_V') && val !== undefined) process.env[k] = val;
  }
});

/* ══════════════════════════════════════════════════════ round trip */

describe('sealing and unsealing', () => {
  test('a sealed identifier decrypts back to itself', () => {
    const sealed = sealIdentifier('nid', NID, TENANT_A, SUBJECT_1);
    assert.equal(unsealIdentifier('nid', sealed.ciphertext, TENANT_A, SUBJECT_1), NID);
  });

  test('the ciphertext does not contain the plaintext', () => {
    // The single most important assertion in this file. A mode misuse that
    // leaves plaintext in the buffer would pass a round-trip test.
    const sealed = sealIdentifier('nid', NID, TENANT_A, SUBJECT_1);
    assert.ok(!sealed.ciphertext.toString('latin1').includes(NID));
    assert.ok(!sealed.ciphertext.toString('utf8').includes(NID));
    assert.ok(!sealed.ciphertext.toString('hex').includes(Buffer.from(NID).toString('hex')));
  });

  test('the same identifier seals to different bytes every time', () => {
    // A fresh IV per seal. Deterministic ciphertext would let anyone with
    // the database tell which two students share a guardian.
    const a = sealIdentifier('nid', NID, TENANT_A, SUBJECT_1);
    const b = sealIdentifier('nid', NID, TENANT_A, SUBJECT_1);
    assert.notEqual(a.ciphertext.toString('hex'), b.ciphertext.toString('hex'));
    assert.equal(unsealIdentifier('nid', a.ciphertext, TENANT_A, SUBJECT_1), NID);
    assert.equal(unsealIdentifier('nid', b.ciphertext, TENANT_A, SUBJECT_1), NID);
  });

  test('birth registration numbers round-trip too', () => {
    const sealed = sealIdentifier('brc', BRC, TENANT_A, SUBJECT_1);
    assert.equal(unsealIdentifier('brc', sealed.ciphertext, TENANT_A, SUBJECT_1), BRC);
  });

  test('the envelope records the key version it was sealed under', () => {
    const sealed = sealIdentifier('nid', NID, TENANT_A, SUBJECT_1);
    assert.equal(sealed.keyVersion, 1);
    assert.equal(sealedKeyVersion(sealed.ciphertext), 1);
  });
});

/* ══════════════════════════════════════════════════════════ binding */

describe('a ciphertext is bound to exactly one row and column', () => {
  test('it will not decrypt for a different tenant', () => {
    // The breach scenario this prevents: a route-handler bug hands tenant B
    // a ciphertext belonging to tenant A. Even with B's key, it must fail.
    const sealed = sealIdentifier('nid', NID, TENANT_A, SUBJECT_1);
    assert.throws(
      () => unsealIdentifier('nid', sealed.ciphertext, TENANT_B, SUBJECT_1),
      PiiDecryptionFailed,
    );
  });

  test('it will not decrypt for a different subject', () => {
    const sealed = sealIdentifier('nid', NID, TENANT_A, SUBJECT_1);
    assert.throws(
      () => unsealIdentifier('nid', sealed.ciphertext, TENANT_A, SUBJECT_2),
      PiiDecryptionFailed,
    );
  });

  test('a NID ciphertext will not decrypt as a BRC', () => {
    // Prevents a column swap turning one identifier into another silently.
    const sealed = sealIdentifier('nid', NID, TENANT_A, SUBJECT_1);
    assert.throws(
      () => unsealIdentifier('brc', sealed.ciphertext, TENANT_A, SUBJECT_1),
      PiiDecryptionFailed,
    );
  });

  test('a single flipped bit is detected', () => {
    const sealed = sealIdentifier('nid', NID, TENANT_A, SUBJECT_1);
    const tampered = Buffer.from(sealed.ciphertext);
    tampered[tampered.length - 1] ^= 0x01;
    assert.throws(() => unsealIdentifier('nid', tampered, TENANT_A, SUBJECT_1), PiiDecryptionFailed);
  });

  test('a truncated ciphertext is rejected, not read past', () => {
    const sealed = sealIdentifier('nid', NID, TENANT_A, SUBJECT_1);
    assert.throws(
      () => unsealIdentifier('nid', sealed.ciphertext.subarray(0, 10), TENANT_A, SUBJECT_1),
      PiiDecryptionFailed,
    );
  });

  test('an unknown format version is refused rather than guessed at', () => {
    const sealed = sealIdentifier('nid', NID, TENANT_A, SUBJECT_1);
    const future = Buffer.from(sealed.ciphertext);
    future[0] = 99;
    assert.throws(() => unsealIdentifier('nid', future, TENANT_A, SUBJECT_1), PiiDecryptionFailed);
  });
});

/* ══════════════════════════════════════════════════════ blind index */

describe('blind index', () => {
  test('is stable for the same identifier, so duplicates are detectable', () => {
    const sealed = sealIdentifier('nid', NID, TENANT_A, SUBJECT_1);
    const lookup = blindIndexForLookup('nid', NID, TENANT_A);
    assert.ok(blindIndexEquals(sealed.blindIndex, lookup));
  });

  test('is stable across subjects — two students may share a guardian NID', () => {
    const a = sealIdentifier('nid', NID, TENANT_A, SUBJECT_1);
    const b = sealIdentifier('nid', NID, TENANT_A, SUBJECT_2);
    assert.ok(blindIndexEquals(a.blindIndex, b.blindIndex),
      'the index must not be subject-bound or duplicate detection cannot work');
  });

  test('differs between tenants for the same identifier', () => {
    // Otherwise the index itself becomes a cross-school correlation key:
    // anyone with the database could tell that the same person appears at
    // two schools without decrypting anything.
    const a = sealIdentifier('nid', NID, TENANT_A, SUBJECT_1);
    const b = sealIdentifier('nid', NID, TENANT_B, SUBJECT_1);
    assert.ok(!blindIndexEquals(a.blindIndex, b.blindIndex));
  });

  test('differs between nid and brc for the same digits', () => {
    const nid = sealIdentifier('nid', BRC, TENANT_A, SUBJECT_1);
    const brc = sealIdentifier('brc', BRC, TENANT_A, SUBJECT_1);
    assert.ok(!blindIndexEquals(nid.blindIndex, brc.blindIndex));
  });

  test('is exactly 32 bytes — what migration 021 constrains', () => {
    assert.equal(sealIdentifier('nid', NID, TENANT_A, SUBJECT_1).blindIndex.length, 32);
  });

  test('is not a bare hash of the digits', () => {
    // A plain SHA-256 of a 10-digit number is brute-forceable in seconds.
    // The per-tenant pepper is the whole defence, so prove it is applied.
    const bare = createHash('sha256').update(NID, 'utf8').digest();
    assert.ok(!blindIndexEquals(sealIdentifier('nid', NID, TENANT_A, SUBJECT_1).blindIndex, bare));
  });
});

/* ═══════════════════════════════════════════ normalisation of input */

describe('normalisation', () => {
  test('strips the punctuation clerks type when copying off paper', () => {
    assert.equal(normalizeIdentifier('1990 123 456'), NID);
    assert.equal(normalizeIdentifier('1990-123-456'), NID);
    assert.equal(normalizeIdentifier(' 1990123456 '), NID);
  });

  test('accepts Bangla numerals, which is how the number appears on the card', () => {
    assert.equal(normalizeIdentifier('১৯৯০১২৩৪৫৬'), NID);
  });

  test('a formatted and an unformatted entry are the SAME student', () => {
    // Without this, duplicate detection silently fails and one child ends up
    // with two records — the bug that makes a board registration bounce.
    const a = sealIdentifier('nid', '1990-123-456', TENANT_A, SUBJECT_1);
    const b = sealIdentifier('nid', '১৯৯০১২৩৪৫৬', TENANT_A, SUBJECT_2);
    assert.ok(blindIndexEquals(a.blindIndex, b.blindIndex));
  });

  test('what comes back out is the normalised form, not the typed form', () => {
    const sealed = sealIdentifier('nid', '1990 123 456', TENANT_A, SUBJECT_1);
    assert.equal(unsealIdentifier('nid', sealed.ciphertext, TENANT_A, SUBJECT_1), NID);
  });

  test('an entry with no digits is refused', () => {
    assert.throws(() => sealIdentifier('nid', 'not a number', TENANT_A, SUBJECT_1), PiiDecryptionFailed);
  });

  test('shape checks match the Bangladeshi formats', () => {
    assert.ok(isPlausibleIdentifier('nid', '1990123456'));       // 10-digit
    assert.ok(isPlausibleIdentifier('nid', '1990123456789'));    // 13-digit
    assert.ok(isPlausibleIdentifier('nid', '19901234567890123'));// 17-digit smart card
    assert.ok(!isPlausibleIdentifier('nid', '123'));
    assert.ok(isPlausibleIdentifier('brc', BRC));
    assert.ok(!isPlausibleIdentifier('brc', '1990123456'));      // BRC is always 17
  });
});

/* ═════════════════════════════════════════════════════════ rotation */

describe('key rotation', () => {
  test('new writes use the highest configured version', () => {
    process.env.PII_MASTER_KEY_V2 = KEY_V2;
    assert.equal(currentKeyVersion(), 2);
    assert.equal(sealIdentifier('nid', NID, TENANT_A, SUBJECT_1).keyVersion, 2);
  });

  test('rows sealed under an older key still decrypt after rotation', () => {
    // The property that makes rotation additive instead of an outage.
    const old = sealIdentifier('nid', NID, TENANT_A, SUBJECT_1);
    process.env.PII_MASTER_KEY_V2 = KEY_V2;
    assert.equal(unsealIdentifier('nid', old.ciphertext, TENANT_A, SUBJECT_1), NID);
  });

  test('rotateIdentifier moves a row to the current key without exposing plaintext', () => {
    const old = sealIdentifier('nid', NID, TENANT_A, SUBJECT_1);
    process.env.PII_MASTER_KEY_V2 = KEY_V2;

    const fresh = rotateIdentifier('nid', old.ciphertext, TENANT_A, SUBJECT_1);
    assert.equal(fresh.keyVersion, 2);
    assert.equal(sealedKeyVersion(fresh.ciphertext), 2);
    assert.equal(unsealIdentifier('nid', fresh.ciphertext, TENANT_A, SUBJECT_1), NID);
    // The returned object exposes only ciphertext, index and version.
    assert.deepEqual(Object.keys(fresh).sort(), ['blindIndex', 'ciphertext', 'keyVersion']);
  });

  test('rotation also re-peppers the blind index', () => {
    const old = sealIdentifier('nid', NID, TENANT_A, SUBJECT_1);
    process.env.PII_MASTER_KEY_V2 = KEY_V2;
    const fresh = rotateIdentifier('nid', old.ciphertext, TENANT_A, SUBJECT_1);
    assert.ok(!blindIndexEquals(old.blindIndex, fresh.blindIndex));
    assert.ok(blindIndexEquals(fresh.blindIndex, blindIndexForLookup('nid', NID, TENANT_A)));
  });

  test('retiring a key makes exactly its rows fail loudly, not silently', () => {
    const old = sealIdentifier('nid', NID, TENANT_A, SUBJECT_1);
    process.env.PII_MASTER_KEY_V2 = KEY_V2;
    delete process.env.PII_MASTER_KEY_V1;
    assert.throws(() => unsealIdentifier('nid', old.ciphertext, TENANT_A, SUBJECT_1), PiiKeyUnavailable);
  });
});

/* ══════════════════════════════════════════════ ships-dark behaviour */

describe('with no key configured', () => {
  test('the module reports itself unavailable', () => {
    delete process.env.PII_MASTER_KEY_V1;
    assert.equal(piiCryptoAvailable(), false);
  });

  test('sealing throws rather than storing anything', () => {
    // The failure mode that must never exist: no key, so write it in the
    // clear "for now".
    delete process.env.PII_MASTER_KEY_V1;
    assert.throws(() => sealIdentifier('nid', NID, TENANT_A, SUBJECT_1), PiiKeyUnavailable);
  });

  test('a malformed key is refused, not padded or truncated to fit', () => {
    process.env.PII_MASTER_KEY_V1 = Buffer.from('short').toString('base64');
    assert.throws(() => sealIdentifier('nid', NID, TENANT_A, SUBJECT_1), PiiKeyUnavailable);
  });

  test('is available once a valid key is present', () => {
    assert.equal(piiCryptoAvailable(), true);
  });
});

/* ═════════════════════════════════ plaintext must never leak outward */

describe('no error or display value carries the identifier', () => {
  const containsNid = (s: string) => s.includes(NID) || s.includes('1990') || s.includes('123456');

  test('a decryption failure message does not echo the value', () => {
    const sealed = sealIdentifier('nid', NID, TENANT_A, SUBJECT_1);
    try {
      unsealIdentifier('nid', sealed.ciphertext, TENANT_B, SUBJECT_1);
      assert.fail('should have thrown');
    } catch (err) {
      const e = err as Error;
      assert.ok(!containsNid(e.message), `message leaked: ${e.message}`);
      assert.ok(!containsNid(String(e.stack ?? '')), 'stack leaked the identifier');
    }
  });

  test('a rejected malformed entry does not echo what was typed', () => {
    // The naive implementation writes `invalid nid: ${input}` and puts a
    // real number into the error log on every typo.
    try {
      sealIdentifier('nid', 'abc-1990123456-xyz'.replace(/[0-9]/g, ''), TENANT_A, SUBJECT_1);
      assert.fail('should have thrown');
    } catch (err) {
      assert.ok(!containsNid((err as Error).message));
    }
  });

  test('a key error does not echo the key material', () => {
    process.env.PII_MASTER_KEY_V1 = Buffer.from('short').toString('base64');
    try {
      sealIdentifier('nid', NID, TENANT_A, SUBJECT_1);
      assert.fail('should have thrown');
    } catch (err) {
      const msg = (err as Error).message;
      assert.ok(!msg.includes(process.env.PII_MASTER_KEY_V1!), 'key material in the message');
      assert.ok(!containsNid(msg));
    }
  });

  test('redactIdentifier shows only the last four digits', () => {
    assert.equal(redactIdentifier(NID), '••••••3456');
    assert.equal(redactIdentifier('1990 123 456'), '••••••3456');
    assert.equal(redactIdentifier('12'), '••');
  });

  test('the redacted form is not enough to reconstruct the number', () => {
    const shown = redactIdentifier(NID);
    assert.ok(!shown.includes('1990'));
    assert.equal(shown.replace(/[^0-9]/g, '').length, 4);
  });
});
