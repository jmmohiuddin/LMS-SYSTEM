/**
 * Bearer-token authentication shared by every service that sits behind
 * identity-svc's access tokens (academics, sms, rms, finance, ...).
 */
import type { IncomingMessage } from 'node:http';
import { verifyAccessToken, type AccessTokenClaims } from './jwt.ts';
import { header, HttpError } from './http.ts';

export async function authenticate(req: IncomingMessage): Promise<AccessTokenClaims> {
  const authHeader = header(req, 'authorization');
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  if (!token) throw new HttpError(401, 'missing bearer token', 'unauthorized');
  try {
    return await verifyAccessToken(token);
  } catch {
    throw new HttpError(401, 'invalid or expired access token', 'unauthorized');
  }
}

const STAFF_BLOCKLIST = new Set(['student', 'guardian']);

/** Mirrors app.is_staff()'s blocklist semantics at the application layer. */
export function requireStaff(claims: AccessTokenClaims): void {
  if (STAFF_BLOCKLIST.has(claims.role)) {
    throw new HttpError(403, 'this endpoint is restricted to staff', 'forbidden');
  }
}

/**
 * Allowlist check for endpoints narrower than "any staff" — e.g. RMS writes,
 * which app.has_role() also restricts at the RLS layer (see
 * db/migrations/010_rls_policies.sql). Checked against claims.role (the
 * PRIMARY role), not claims.roles, because app.has_role() only ever sees
 * whatever single role withTenant's ctx.role sets as app.role for the
 * session — matching that exactly avoids a confusing pass-here-fail-at-DB
 * gap. This just turns the DB's rejection into a clean 403 up front; RLS
 * remains the real enforcement either way.
 */
export function requireRole(claims: AccessTokenClaims, allowed: string[]): void {
  if (!allowed.includes(claims.role)) {
    throw new HttpError(403, `this endpoint requires one of: ${allowed.join(', ')}`, 'forbidden');
  }
}
