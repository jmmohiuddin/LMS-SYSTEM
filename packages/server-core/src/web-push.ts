/**
 * Web push: VAPID (RFC 8292) and message encryption (RFC 8291).  (R-9)
 *
 * The master plan wants push because it "cuts SMS cost — the biggest infra
 * line". What makes that possible is that web push has **no vendor**: unlike
 * every other transport in this product, there is no aggregator to contract
 * with, no merchant account, no per-message fee. The browser tells us where to
 * deliver, we sign a JWT with a keypair we generated ourselves, and the push
 * service carries it for free.
 *
 * ── Why this is hand-written and not a dependency ──────────────────────
 * `web-push` on npm would do this in three lines. It is also ~15 transitive
 * dependencies in the path of a message sent to a child's parent, in a
 * codebase that has deliberately stayed framework-free and currently depends
 * on `pg` and `jose` and nothing else on the server.
 *
 * The whole of what is needed — P-256 ECDH, HKDF-SHA256, AES-128-GCM, and an
 * ES256 signature — is in `node:crypto`. It comes to about 120 lines, and both
 * RFCs publish worked examples with fixed keys, so it can be asserted against
 * the specification itself rather than against my own output. That is a better
 * test than any dependency would have given us: see `web-push.test.ts`, which
 * checks RFC 8291 §5's vector byte for byte.
 *
 * ── What is encrypted, and from whom ───────────────────────────────────
 * RFC 8291 is end-to-end: the push service (Google, Mozilla, Apple) routes an
 * opaque blob it cannot read. Only the subscribed browser holds the private
 * key. So the notice title and body pass through infrastructure we do not own
 * without being readable by it — which is a stronger guarantee than SMS, where
 * the aggregator reads every message in plaintext.
 */
import {
  createECDH, createCipheriv, hkdfSync, randomBytes, createHash,
  createPrivateKey, createPublicKey, sign as signSync, type KeyObject,
} from 'node:crypto';

/** base64url with no padding — what both RFCs and the browser use throughout. */
export function b64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function unb64url(s: string): Buffer {
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

/** What the browser hands us in `PushSubscription.toJSON()`. */
export interface PushKeys {
  /** The browser's P-256 public key, uncompressed (65 bytes), base64url. */
  p256dh: string;
  /** The browser's 16-byte auth secret, base64url. */
  auth: string;
}

// ─────────────────────────────────────────────── RFC 8291: encryption

/**
 * Encrypt `payload` for a subscription, producing an `aes128gcm` body.
 *
 * The wire format is RFC 8188's single-record form:
 *
 *     salt(16) ‖ rs(4) ‖ idlen(1) ‖ senderPublicKey(65) ‖ ciphertext
 *
 * `salt` and the sender keypair are fresh per message — that is what stops two
 * messages to the same device sharing a keystream. They are parameters here
 * ONLY so the RFC's worked example can be reproduced; every real caller lets
 * them default to random.
 */
export function encryptPayload(
  payload: string | Buffer,
  keys: PushKeys,
  opts: { salt?: Buffer; senderPrivateKey?: Buffer } = {},
): Buffer {
  const plaintext = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, 'utf8');
  const clientPublic = unb64url(keys.p256dh);
  const authSecret = unb64url(keys.auth);

  if (clientPublic.length !== 65 || clientPublic[0] !== 0x04) {
    throw new Error('p256dh must be a 65-byte uncompressed P-256 point');
  }
  if (authSecret.length !== 16) {
    throw new Error('auth secret must be 16 bytes');
  }

  const salt = opts.salt ?? randomBytes(16);
  const ecdh = createECDH('prime256v1');
  if (opts.senderPrivateKey) ecdh.setPrivateKey(opts.senderPrivateKey);
  else ecdh.generateKeys();
  const senderPublic = ecdh.getPublicKey();

  // RFC 8291 §3.3. The shared secret is stretched with a context that names
  // BOTH public keys, so a message encrypted for one device cannot be replayed
  // to another even if the salt repeated.
  const sharedSecret = ecdh.computeSecret(clientPublic);
  const prkInfo = Buffer.concat([
    Buffer.from('WebPush: info\0', 'utf8'), clientPublic, senderPublic,
  ]);
  const ikm = Buffer.from(hkdfSync('sha256', sharedSecret, authSecret, prkInfo, 32));

  // RFC 8188 §2.1 — the content-encryption key and nonce.
  const cek = Buffer.from(hkdfSync(
    'sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0', 'utf8'), 16));
  const nonce = Buffer.from(hkdfSync(
    'sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0', 'utf8'), 12));

  // RFC 8188 §2: a single record is padded with 0x02 as the final-record
  // delimiter. (0x01 marks a non-final record; we never emit more than one.)
  const padded = Buffer.concat([plaintext, Buffer.from([0x02])]);

  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  const ciphertext = Buffer.concat([cipher.update(padded), cipher.final(), cipher.getAuthTag()]);

  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  // Record size. Anything at least as large as the record works; 4096 is the
  // conventional value and the one the RFC's example uses.
  header.writeUInt32BE(4096, 16);
  header.writeUInt8(senderPublic.length, 20);

  return Buffer.concat([header, senderPublic, ciphertext]);
}

// ─────────────────────────────────────────────── RFC 8292: VAPID

export interface VapidKeys {
  /** base64url, 65-byte uncompressed P-256 point — also sent to the browser. */
  publicKey: string;
  /** base64url, the 32-byte P-256 scalar. */
  privateKey: string;
}

/**
 * Generate a VAPID keypair.
 *
 * Run once per deployment; the public half is handed to every browser at
 * subscribe time and the private half signs. Rotating it invalidates every
 * existing subscription, which is why `scripts/generate-vapid-keys.mjs` says so
 * loudly rather than printing a key and leaving it to be discovered.
 */
export function generateVapidKeys(): VapidKeys {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return {
    publicKey: b64url(ecdh.getPublicKey()),
    privateKey: b64url(ecdh.getPrivateKey()),
  };
}

/**
 * A raw 32-byte P-256 scalar is not a key format `node:crypto` will sign with,
 * so it is wrapped in the minimal PKCS#8 envelope. The prefix below is the
 * fixed DER for "PrivateKeyInfo, id-ecPublicKey, prime256v1, 32-byte key" —
 * constant for every P-256 key, which is why it can be a literal.
 */
function privateKeyObject(rawPrivate: Buffer): KeyObject {
  if (rawPrivate.length !== 32) throw new Error('VAPID private key must be 32 bytes');
  const pkcs8 = Buffer.concat([
    Buffer.from('308141020100301306072a8648ce3d020106082a8648ce3d030107042730250201010420', 'hex'),
    rawPrivate,
  ]);
  return createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' });
}

/**
 * The `Authorization: vapid t=<jwt>, k=<publicKey>` header for one push
 * service.
 *
 * `aud` is the push service's ORIGIN, not the endpoint — a token minted for
 * one push service must not be replayable against another, and the origin is
 * the boundary the RFC draws.
 */
export function vapidHeader(
  endpoint: string,
  keys: VapidKeys,
  opts: { subject?: string; nowSeconds?: number; ttlSeconds?: number } = {},
): string {
  const aud = new URL(endpoint).origin;
  const now = opts.nowSeconds ?? Math.floor(Date.now() / 1000);
  // RFC 8292 §2 caps this at 24 hours. 12 keeps a clock-skewed server well
  // inside the limit rather than at its edge.
  const exp = now + (opts.ttlSeconds ?? 12 * 60 * 60);

  const header = b64url(Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  // `sub` must be a contact a push service operator can reach if our traffic
  // misbehaves. It is the PLATFORM's address, not a school's: the operator of
  // shikhonbd.com is who they would need, and putting a school's address here
  // would send someone else's abuse report to a head teacher.
  const claims = { aud, exp, sub: opts.subject ?? 'mailto:ops@shikhonbd.com' };
  const body = b64url(Buffer.from(JSON.stringify(claims)));
  const signingInput = `${header}.${body}`;

  // `ieee-p1363` is the raw r‖s form JWS requires. The default DER encoding
  // produces a signature every push service rejects, and the rejection message
  // does not say why.
  const signature = signSync('sha256', Buffer.from(signingInput, 'utf8'), {
    key: privateKeyObject(unb64url(keys.privateKey)),
    dsaEncoding: 'ieee-p1363',
  });

  return `vapid t=${signingInput}.${b64url(signature)}, k=${keys.publicKey}`;
}

/** Read the deployment's VAPID keys, or null when push is not configured. */
export function vapidFromEnv(env: NodeJS.ProcessEnv = process.env): VapidKeys | null {
  const publicKey = (env.VAPID_PUBLIC_KEY ?? '').trim();
  const privateKey = (env.VAPID_PRIVATE_KEY ?? '').trim();
  if (!publicKey || !privateKey) return null;
  // A malformed key must fail here, at startup or first use, rather than as a
  // 400 from a push service for every message.
  if (unb64url(publicKey).length !== 65) {
    throw new Error('VAPID_PUBLIC_KEY must be a 65-byte uncompressed P-256 point');
  }
  if (unb64url(privateKey).length !== 32) {
    throw new Error('VAPID_PRIVATE_KEY must be a 32-byte P-256 scalar');
  }
  return { publicKey, privateKey };
}

// ─────────────────────────────────────────────── sending

export interface PushTarget {
  endpoint: string;
  p256dh: string;
  auth: string;
}

export type PushOutcome =
  /** The push service accepted it. NOT "a person read it". */
  | { ok: true; status: number }
  /** The subscription is dead (404/410). The caller must delete the row. */
  | { ok: false; gone: true; status: number }
  /** Anything else — rate limit, payload too large, service outage. */
  | { ok: false; gone: false; status: number; error: string };

/** RFC 8291 §4: the encrypted body must not exceed 4096 octets. */
export const MAX_PAYLOAD_BYTES = 3800;

/**
 * Deliver one message.
 *
 * Never throws for a push-service response: a dead subscription and a service
 * outage are both ordinary outcomes of a fan-out over hundreds of devices, and
 * a throw would abandon the rest of the batch.
 */
export async function sendPush(
  target: PushTarget,
  payload: string,
  keys: VapidKeys,
  opts: { ttlSeconds?: number; urgency?: 'very-low' | 'low' | 'normal' | 'high';
          fetchImpl?: typeof fetch; subject?: string } = {},
): Promise<PushOutcome> {
  const bytes = Buffer.byteLength(payload, 'utf8');
  if (bytes > MAX_PAYLOAD_BYTES) {
    return { ok: false, gone: false, status: 0,
      error: `payload ${bytes}B exceeds ${MAX_PAYLOAD_BYTES}B` };
  }

  let body: Buffer;
  try {
    body = encryptPayload(payload, target);
  } catch (err) {
    // A malformed key is the subscription's problem, not a transient one, but
    // it is not the push service saying "gone" either — so it is reported as a
    // failure and left for the caller's failure counter to age out.
    return { ok: false, gone: false, status: 0, error: (err as Error).message };
  }

  const doFetch = opts.fetchImpl ?? fetch;
  try {
    const res = await doFetch(target.endpoint, {
      method: 'POST',
      headers: {
        'Authorization': vapidHeader(target.endpoint, keys, { subject: opts.subject }),
        'Content-Encoding': 'aes128gcm',
        'Content-Type': 'application/octet-stream',
        // A notice is worth delivering late; 12 hours lets a phone that is off
        // overnight still get it. Longer would deliver yesterday's news.
        'TTL': String(opts.ttlSeconds ?? 12 * 60 * 60),
        'Urgency': opts.urgency ?? 'normal',
      },
      body: body as unknown as BodyInit,
    });

    if (res.status === 404 || res.status === 410) {
      return { ok: false, gone: true, status: res.status };
    }
    if (res.status >= 200 && res.status < 300) {
      return { ok: true, status: res.status };
    }
    return { ok: false, gone: false, status: res.status,
      error: `push service returned ${res.status}` };
  } catch (err) {
    return { ok: false, gone: false, status: 0, error: (err as Error).message };
  }
}

/**
 * A stable short identifier for an endpoint, for logs.
 *
 * The endpoint itself is a device identifier and a capability: anyone holding
 * it can push to that phone. It does not belong in a log line, so logs carry
 * this instead.
 */
export function endpointFingerprint(endpoint: string): string {
  return createHash('sha256').update(endpoint).digest('hex').slice(0, 12);
}

/** Exported for the RFC-vector test, which needs to check the public half. */
export function publicKeyFromPrivate(rawPrivate: Buffer): Buffer {
  const ecdh = createECDH('prime256v1');
  ecdh.setPrivateKey(rawPrivate);
  return ecdh.getPublicKey();
}

export { createPublicKey };
