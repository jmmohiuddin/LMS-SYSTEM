/**
 * Activation codes — generation, hashing, and the expiry window.  (R-7)
 *
 * These three lived inside `api/activate.ts` while it was the only issuer.
 * R-7's onboarding wizard is a second one: the platform operator creates a
 * school's first principal, and that account has to be able to log in before
 * the school has anybody who could issue them a code.
 *
 * They move here rather than being copied, because all three have to agree
 * exactly. A second alphabet would mint codes the redeemer's normaliser
 * mangles; a second HMAC would mint codes that hash to something the lookup
 * never finds. Both failures look like "the code does not work" to a head
 * teacher holding a printed slip, with nothing in the logs.
 */
import { createHmac, randomBytes } from 'node:crypto';

/** No 0/O, no 1/I/L — a code read aloud across a classroom must survive it. */
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ2345678';
/** Exported: the redeem path length-checks a typed code against it. */
export const CODE_LEN = 8;

/** R-7.9: single-use, 72-hour expiry. The column default is the authority; this mirrors it. */
export const CODE_TTL_HOURS = 72;

export function generateCode(): string {
  const bytes = randomBytes(CODE_LEN);
  let out = '';
  for (let i = 0; i < CODE_LEN; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}

/**
 * The code is never stored. Only this HMAC is.
 *
 * Online guessing dies against F-102's per-IP caps; an offline brute of a
 * leaked table dies against the pepper. Without the pepper configured the
 * caller must ship dark (503) — a security feature misconfigured has to fail
 * closed, loudly.
 */
export function codeHash(code: string): Buffer {
  const pepper = process.env.ACTIVATION_PEPPER as string;
  // Normalised so a code typed with the lookalikes or a stray dash still
  // matches: the person typing it is ten years old.
  const norm = code.toUpperCase().replace(/[^A-Z2-9]/g, '')
    .replace(/0/g, 'O').replace(/O/g, 'Q').replace(/[1IL]/g, 'J');
  return createHmac('sha256', pepper).update(norm).digest();
}

/** True when codes can be issued or redeemed at all. */
export function activationConfigured(): boolean {
  const p = process.env.ACTIVATION_PEPPER;
  return !!p && p.length >= 16;
}
