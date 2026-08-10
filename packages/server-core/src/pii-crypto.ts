/**
 * Field-level encryption for national identifiers  (F-101, TRD §7.1)
 *
 * Covers users.nid_ciphertext / brc_ciphertext and their blind indexes,
 * which migration 002 declared and nothing has ever written. A NID or a
 * birth-registration number is the single most dangerous field in this
 * system: in Bangladesh it is the key to a bank account, a SIM registration
 * and a land record, and a school database is a soft target holding
 * thousands of them, most belonging to children.
 *
 * ── Why app-layer AES-256-GCM and not pgcrypto ──────────────────────────
 * pgcrypto would put the key in a SQL parameter, which means the key lands
 * in pg_stat_statements, in the slow-query log, and in any query the
 * platform captures. Encrypting in the application keeps the key material
 * in one process's memory and sends only ciphertext to the database. It
 * also means a compromised database — the realistic breach, via a leaked
 * connection string or a stolen backup — yields nothing.
 *
 * ── Key management, stated honestly ─────────────────────────────────────
 * TRD §7.1 specifies a KMS envelope scheme. There is no KMS in this stack:
 * it is Neon plus Vercel, and no managed key service is provisioned. So
 * this implements the envelope shape with the master key held in an
 * environment variable, structured so that swapping in a real KMS later
 * changes exactly one function (`masterKey`) and no stored data:
 *
 *   PII_MASTER_KEY_V1=<base64, 32 bytes>   ← required to use this module
 *   PII_MASTER_KEY_V2=<base64, 32 bytes>   ← add to rotate
 *
 * users.pii_key_version records which master version sealed each row, so
 * rotation is additive: new writes use the highest configured version,
 * old rows keep decrypting under theirs, and re-encryption is a background
 * job rather than a migration outage. Removing a version's env var makes
 * exactly the rows still on it undecryptable — which is the correct and
 * loud failure, not silent data loss.
 *
 * Ships dark. With no PII_MASTER_KEY_V1 configured, every call throws
 * PiiKeyUnavailable and the caller returns a clean error — the same
 * ships-dark discipline as the AI gateway and the MFS switch. It is never
 * possible to write an identifier in plaintext because the key is missing.
 *
 * ── Per-tenant derivation ───────────────────────────────────────────────
 * The master key is never used directly. Each tenant gets its own data key
 * and its own blind-index pepper via HKDF-SHA256, so a key recovered from
 * one tenant's context cannot read another school's records, and two
 * schools holding the same guardian's NID produce different blind indexes
 * (which also stops cross-tenant correlation through the index itself).
 *
 * ── Binding ─────────────────────────────────────────────────────────────
 * GCM additional authenticated data binds each ciphertext to its tenant,
 * its subject row and its field name. A ciphertext copied from a guardian's
 * brc column into a student's nid column fails to authenticate rather than
 * decrypting into the wrong person's record.
 *
 * ── Plaintext discipline ────────────────────────────────────────────────
 * Nothing in this module puts an identifier into an Error message, a log
 * line or a return value that is not the caller's explicit decryption
 * request. `redactIdentifier()` is provided for the places that must show
 * something to a human.
 */
import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';

/** Fields this module seals. Matches audit.pii_access.field (migration 001). */
export type PiiField = 'nid' | 'brc';

/** Thrown when no usable master key is configured. Never carries plaintext. */
export class PiiKeyUnavailable extends Error {
  readonly code = 'pii_key_unavailable';
  constructor(message: string) {
    super(message);
  }
}

/** Thrown when a ciphertext fails to authenticate. Never carries plaintext. */
export class PiiDecryptionFailed extends Error {
  readonly code = 'pii_decryption_failed';
  constructor(message: string) {
    super(message);
  }
}

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;    // GCM standard; 96-bit nonces are what the mode is built for
const TAG_BYTES = 16;
const KEY_BYTES = 32;
const MAX_KEY_VERSION = 16;

/**
 * Envelope layout, one bytea column:
 *
 *   [0]      format version (currently 1)
 *   [1]      key version   (mirrors users.pii_key_version)
 *   [2..13]  IV            (12 bytes)
 *   [14..]   ciphertext || GCM tag (16 bytes)
 *
 * Self-describing on purpose: a row can be decrypted from the bytes alone,
 * so a future re-encryption job does not have to join anything to know how
 * a given row was sealed.
 */
const FORMAT_VERSION = 1;
const HEADER_BYTES = 2;

/** Reads a master key from the environment. The one seam a real KMS replaces. */
function masterKey(version: number): Buffer {
  const raw = process.env[`PII_MASTER_KEY_V${version}`];
  if (!raw) {
    throw new PiiKeyUnavailable(
      `PII master key version ${version} is not configured (PII_MASTER_KEY_V${version})`,
    );
  }
  const key = Buffer.from(raw, 'base64');
  if (key.length !== KEY_BYTES) {
    throw new PiiKeyUnavailable(
      `PII_MASTER_KEY_V${version} must decode to ${KEY_BYTES} bytes, got ${key.length}`,
    );
  }
  return key;
}

/**
 * Highest configured version — what new writes are sealed with. Computed on
 * every call rather than cached: a Vercel function can stay warm for hours
 * and a rotation should take effect on the next request, not the next
 * cold start.
 */
export function currentKeyVersion(): number {
  for (let v = MAX_KEY_VERSION; v >= 1; v--) {
    if (process.env[`PII_MASTER_KEY_V${v}`]) return v;
  }
  throw new PiiKeyUnavailable('no PII master key is configured (PII_MASTER_KEY_V1)');
}

/** True when the module can operate. Lets callers ship a clean 503. */
export function piiCryptoAvailable(): boolean {
  try {
    currentKeyVersion();
    return true;
  } catch {
    return false;
  }
}

/**
 * Per-tenant derivation. `info` separates the two derivations so the data
 * key and the blind-index pepper can never collide, and tenant_id as salt
 * keeps schools cryptographically apart.
 */
function derive(version: number, tenantId: string, info: string): Buffer {
  return Buffer.from(
    hkdfSync('sha256', masterKey(version), Buffer.from(tenantId, 'utf8'), Buffer.from(info, 'utf8'), KEY_BYTES),
  );
}

/**
 * Identifiers are transcribed by humans from paper, so the same number
 * arrives with spaces, dashes and Bangla numerals. Normalising before both
 * sealing and indexing is what makes duplicate detection actually work —
 * without it, "1234 5678 90" and "1234567890" are two different students.
 */
export function normalizeIdentifier(raw: string): string {
  const BENGALI_ZERO = 0x09e6;
  let out = '';
  for (const ch of raw) {
    const code = ch.codePointAt(0)!;
    if (ch >= '0' && ch <= '9') out += ch;
    else if (code >= BENGALI_ZERO && code <= BENGALI_ZERO + 9) out += String(code - BENGALI_ZERO);
  }
  return out;
}

/** Shape checks. Bangladeshi NID is 10/13/17 digits; BRC is 17. */
export function isPlausibleIdentifier(field: PiiField, normalized: string): boolean {
  if (field === 'brc') return normalized.length === 17;
  return normalized.length === 10 || normalized.length === 13 || normalized.length === 17;
}

/** AAD binds a ciphertext to exactly one row and column. */
function aad(tenantId: string, subjectId: string, field: PiiField): Buffer {
  return Buffer.from(`${tenantId}|${subjectId}|${field}`, 'utf8');
}

export interface SealedIdentifier {
  /** users.<field>_ciphertext */
  ciphertext: Buffer;
  /** users.<field>_blind_index — HMAC, for duplicate detection */
  blindIndex: Buffer;
  /** users.pii_key_version */
  keyVersion: number;
}

/**
 * Encrypt an identifier and compute its blind index. The caller writes all
 * three returned values to the row in one statement; they must never be
 * written apart, or a rotation will find a ciphertext whose recorded key
 * version is wrong.
 */
export function sealIdentifier(
  field: PiiField,
  plaintext: string,
  tenantId: string,
  subjectId: string,
): SealedIdentifier {
  const normalized = normalizeIdentifier(plaintext);
  if (!normalized) {
    // Deliberately does not echo the input — an error message is a log line.
    throw new PiiDecryptionFailed(`${field} contained no digits`);
  }
  const version = currentKeyVersion();
  const dataKey = derive(version, tenantId, `pii:${field}:data`);
  const iv = randomBytes(IV_BYTES);

  const cipher = createCipheriv(ALGORITHM, dataKey, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(aad(tenantId, subjectId, field));
  const body = Buffer.concat([cipher.update(normalized, 'utf8'), cipher.final(), cipher.getAuthTag()]);

  const header = Buffer.from([FORMAT_VERSION, version]);
  return {
    ciphertext: Buffer.concat([header, iv, body]),
    blindIndex: blindIndexFor(field, normalized, tenantId, version),
    keyVersion: version,
  };
}

/**
 * The blind index. HMAC rather than a plain hash because a bare SHA-256 of
 * a 10-digit number is brute-forceable in seconds — the whole keyspace is
 * ten billion. The per-tenant pepper is what makes the index useless to
 * anyone who has the database but not the key.
 */
function blindIndexFor(field: PiiField, normalized: string, tenantId: string, version: number): Buffer {
  const pepper = derive(version, tenantId, `pii:${field}:index`);
  return createHmac('sha256', pepper).update(normalized, 'utf8').digest();
}

/**
 * Blind index for a lookup — "does this tenant already hold this NID?"
 * Separate entry point from sealIdentifier because a duplicate check must
 * not produce a ciphertext it would then discard.
 *
 * Note this indexes under the CURRENT key version only. A tenant mid-
 * rotation has rows under two peppers, so a lookup can miss until the
 * re-encryption job has swept. That is the honest trade for not keeping a
 * single global pepper forever; the unique index still prevents a
 * duplicate from being committed.
 */
export function blindIndexForLookup(field: PiiField, plaintext: string, tenantId: string): Buffer {
  const normalized = normalizeIdentifier(plaintext);
  if (!normalized) throw new PiiDecryptionFailed(`${field} contained no digits`);
  return blindIndexFor(field, normalized, tenantId, currentKeyVersion());
}

/**
 * Decrypt. The key version is read from the envelope, not from the caller,
 * so a row whose pii_key_version drifted from its bytes still decrypts.
 *
 * Every successful call is a PDPA-reportable event — callers must write the
 * audit.pii_access row. See openIdentifier() in the identity service for
 * the wrapper that enforces it.
 */
export function unsealIdentifier(
  field: PiiField,
  sealed: Buffer,
  tenantId: string,
  subjectId: string,
): string {
  if (sealed.length < HEADER_BYTES + IV_BYTES + TAG_BYTES) {
    throw new PiiDecryptionFailed(`${field} ciphertext is truncated`);
  }
  const format = sealed[0];
  if (format !== FORMAT_VERSION) {
    throw new PiiDecryptionFailed(`${field} ciphertext has unknown format version ${format}`);
  }
  const version = sealed[1];
  const iv = sealed.subarray(HEADER_BYTES, HEADER_BYTES + IV_BYTES);
  const body = sealed.subarray(HEADER_BYTES + IV_BYTES);
  const tag = body.subarray(body.length - TAG_BYTES);
  const ciphertext = body.subarray(0, body.length - TAG_BYTES);

  const dataKey = derive(version, tenantId, `pii:${field}:data`);
  const decipher = createDecipheriv(ALGORITHM, dataKey, iv, { authTagLength: TAG_BYTES });
  decipher.setAAD(aad(tenantId, subjectId, field));
  decipher.setAuthTag(tag);
  try {
    return decipher.update(ciphertext, undefined, 'utf8') + decipher.final('utf8');
  } catch {
    // The underlying error is swallowed rather than wrapped: OpenSSL's
    // message is safe today, but re-throwing something we did not compose
    // is how plaintext ends up in a log two refactors from now.
    throw new PiiDecryptionFailed(
      `${field} failed authentication — wrong key, wrong row, or tampered ciphertext`,
    );
  }
}

/**
 * Re-seal a row under the current key version without ever returning the
 * plaintext to the caller. This is what the rotation job runs: it can move
 * every row to a new key while the plaintext exists only inside this
 * function's stack frame.
 */
export function rotateIdentifier(
  field: PiiField,
  sealed: Buffer,
  tenantId: string,
  subjectId: string,
): SealedIdentifier {
  const plaintext = unsealIdentifier(field, sealed, tenantId, subjectId);
  return sealIdentifier(field, plaintext, tenantId, subjectId);
}

/** The key version a sealed value was written under, without decrypting it. */
export function sealedKeyVersion(sealed: Buffer): number {
  if (sealed.length < HEADER_BYTES) throw new PiiDecryptionFailed('ciphertext is truncated');
  return sealed[1];
}

/**
 * What a human is allowed to see on screen when confirming they have the
 * right record: the last four digits only. Everything else is masked.
 * Never use this to build a log line — the last four of a NID plus a name
 * is still identifying.
 */
export function redactIdentifier(plaintext: string): string {
  const digits = normalizeIdentifier(plaintext);
  if (digits.length <= 4) return '•'.repeat(digits.length);
  return '•'.repeat(digits.length - 4) + digits.slice(-4);
}

/** Constant-time blind-index comparison, for lookups done in application code. */
export function blindIndexEquals(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}
