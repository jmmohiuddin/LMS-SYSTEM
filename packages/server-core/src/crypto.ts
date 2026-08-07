/**
 * OTP codes, opaque session tokens, and their at-rest hashes.
 * Codes/tokens are never stored in plaintext — only their SHA-256 digest,
 * matching users.password_hash-style discipline elsewhere in the schema.
 */
import { randomBytes, randomInt, createHash, timingSafeEqual } from 'node:crypto';

export function randomOpaqueToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/** Uniform 6-digit code, zero-padded — randomInt avoids modulo bias. */
export function randomOtpCode(digits = 6): string {
  const max = 10 ** digits;
  return String(randomInt(0, max)).padStart(digits, '0');
}

export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

export function sha256Buf(input: string): Buffer {
  return createHash('sha256').update(input, 'utf8').digest();
}

export function constantTimeEqualHex(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'hex');
  const bufB = Buffer.from(b, 'hex');
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}
