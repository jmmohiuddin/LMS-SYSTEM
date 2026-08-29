/**
 * POST /api/v1/auth/activate — the F-202 fallback first-login path
 *
 *   { action:'issue',  userId }                → { code, expiresAt }  (staff)
 *   { action:'redeem', tenantId, code, … }     → the same session pair
 *                                                otp-verify would mint
 *
 * F-201's OTP login is dark behind an aggregator negotiation the school
 * cannot influence. This path removes the hostage situation: a teacher
 * hands a student an eight-character code face to face, the student types
 * it once, and from then on the rotating 30-day refresh token IS the
 * credential — which fits the target device, a shared family phone that
 * stays signed in. Losing the device means asking the teacher for a new
 * code, which is exactly how that school already handles a lost exam slip.
 *
 * The forced-password variant of F-202 is deliberately NOT built: a
 * password born from a first-login form on a shared phone is a weaker
 * secret than a session token the user never sees, and building both
 * halves would double the untested surface of the one path a pilot
 * depends on.
 *
 * ── The code ─────────────────────────────────────────────────────────────
 * Eight characters from a 30-letter alphabet with the lookalikes removed
 * (no 0/O, 1/I/L) — ~39 bits. Generated server-side, returned exactly
 * once, stored only as HMAC-SHA256 under ACTIVATION_PEPPER. Online
 * guessing dies against F-102's per-IP caps; offline brute of a leaked
 * table dies against the pepper. Without the pepper configured the
 * endpoint ships dark (503), the same posture as the PII key and the AI
 * gateway: a security feature misconfigured must fail closed, loudly.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';

import { sharedDb } from '../../../packages/server-core/src/db.ts';
import { corsHeaders, readJson, json, HttpError } from '../../../packages/server-core/src/http.ts';
import { sha256Buf, randomOpaqueToken } from '../../../packages/server-core/src/crypto.ts';
import { signAccessToken } from '../../../packages/server-core/src/jwt.ts';
import { authenticate, requireRole } from '../../../packages/server-core/src/auth.ts';
import { loadRoles } from '../src/roles.ts';
import { enforceIdentityRateLimit } from '../../../packages/server-core/src/rate-limit.ts';
// R-7 moved these to src/activation.ts so the onboarding wizard can issue a
// code for a school's FIRST principal — before that school has anybody who
// could issue one. Three definitions that must agree exactly; one copy.
import { generateCode, codeHash, CODE_LEN } from '../src/activation.ts';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISSUER_ROLES = ['principal', 'school_owner', 'academic_coordinator', 'class_teacher'];

const REFRESH_TTL_DAYS = 30;
const ACCESS_TTL = '15m';

interface ActivateBody {
  action?: string;
  tenantId?: string;
  userId?: string;
  code?: string;
  deviceId?: string;
  deviceLabel?: string;
}

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const cors = corsHeaders();
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }
  if (req.method !== 'POST') { json(res, 405, { error: 'method_not_allowed' }, cors); return; }

  try {
    if (!process.env.ACTIVATION_PEPPER || process.env.ACTIVATION_PEPPER.length < 16) {
      // Fail closed, loudly. A 39-bit code space without its pepper is a
      // table a GPU walks through over a weekend.
      throw new HttpError(503, 'activation is not configured on this deployment',
        'activation_unconfigured');
    }

    const body = await readJson<ActivateBody>(req);
    if (body.action === 'issue') { await issue(req, res, cors, body); return; }
    if (body.action === 'redeem') { await redeem(res, cors, body); return; }
    throw new HttpError(400, "action must be 'issue' or 'redeem'", 'invalid_action');
  } catch (err) {
    if (err instanceof HttpError) {
      json(res, err.status, { error: err.code ?? 'error', message: err.message }, cors);
      return;
    }
    json(res, 500, { error: 'internal_error' }, cors);
  }
}

/**
 * A staff member issues a code for one person.
 *
 * WHO may issue for WHOM is the RLS policy's decision, not this file's:
 * activation_issue_scope admits management for anyone and a class teacher
 * for exactly their own sections' students. A 42501 here means the issuer
 * overreached, and it surfaces as a 403 that says so.
 */
async function issue(
  req: IncomingMessage, res: ServerResponse,
  cors: Record<string, string>, body: ActivateBody,
): Promise<void> {
  const claims = await authenticate(req);
  requireRole(claims, ISSUER_ROLES);

  const userId = body.userId ?? '';
  if (!UUID_RE.test(userId)) {
    throw new HttpError(400, 'userId must be a valid uuid', 'invalid_user_id');
  }

  const code = generateCode();
  const db = await sharedDb();
  const ctx = { tenantId: claims.tid, userId: claims.sub, role: claims.role };

  const expiresAt = await db.withTenant(ctx, async (client) => {
    // One live code per person: issuing again revokes what is still out
    // there, so a code slip lost on Monday is dead the moment Tuesday's
    // replacement is printed.
    await client.query(
      `UPDATE activation_codes SET revoked_at = now()
        WHERE user_id = $1 AND used_at IS NULL AND revoked_at IS NULL`,
      [userId]);

    try {
      const r = await client.query<{ expires_at: string }>(
        `INSERT INTO activation_codes (tenant_id, user_id, code_hash, issued_by)
         VALUES (app.current_tenant(), $1, $2, $3)
         RETURNING expires_at`,
        [userId, codeHash(code), claims.sub]);
      return r.rows[0].expires_at;
    } catch (err) {
      if ((err as { code?: string }).code === '42501') {
        // The RLS policy refused: a class teacher reaching for somebody
        // outside their sections, or a role with no issuing right at all.
        throw new HttpError(403,
          'you may only issue activation codes for students of your own sections',
          'not_your_student');
      }
      if ((err as { code?: string }).code === '23503') {
        throw new HttpError(404, 'user not found', 'user_not_found');
      }
      throw err;
    }
  });

  // The one and only time the code exists outside someone's pocket.
  json(res, 200, { code, expiresAt }, cors);
}

/** The holder proves possession and becomes a session. */
async function redeem(
  res: ServerResponse, cors: Record<string, string>, body: ActivateBody,
): Promise<void> {
  const code = body.code ?? '';
  const deviceId = body.deviceId ?? '';
  const tenantId = body.tenantId ?? '';
  // The same contract as otp-verify: the login screen already knows which
  // school it is signing into, and scoping the lookup to that tenant is
  // what lets redemption run under ordinary tenant isolation instead of a
  // cross-tenant ingest bypass.
  if (!UUID_RE.test(tenantId)) {
    throw new HttpError(400, 'tenantId is required', 'tenant_required');
  }
  if (code.replace(/[^A-Za-z0-9]/g, '').length < CODE_LEN) {
    throw new HttpError(400, 'code is too short', 'invalid_code_format');
  }
  if (!deviceId) throw new HttpError(400, 'deviceId is required', 'device_required');

  // F-102, identity dimension: the outer loop on guessing one device's
  // way in. The per-IP cap is charged by the dispatcher before this runs.
  if (!(await enforceIdentityRateLimit(res, cors, 'otp_verify', `activate:${deviceId}`))) return;

  const hash = codeHash(code);
  const db = await sharedDb();

  // Pre-authentication posture, same as otp-verify: the tenant is known,
  // the user is not until the code says so.
  const result = await db.withTenant(
    { tenantId, userId: '', role: 'system_ingest' }, async (client) => {
    const found = await client.query<{
      id: string; tenant_id: string; user_id: string;
      used_at: string | null; revoked_at: string | null; expired: boolean;
    }>(
      `SELECT id, tenant_id, user_id, used_at, revoked_at,
              (expires_at <= now()) AS expired
         FROM activation_codes WHERE code_hash = $1 AND tenant_id = $2`,
      [hash, tenantId]);
    const row = found.rows[0];
    // One error for every failure mode. "expired" tells a guesser they
    // found a real code; "incorrect" tells them nothing.
    if (!row || row.used_at || row.revoked_at || row.expired) {
      throw new HttpError(400, 'incorrect or expired code — ask your teacher for a new one',
        'invalid_code');
    }

    // The code is the proof. From here the transaction acts AS the person
    // it just authenticated, which is what lets the self-scoped RLS
    // policies (users_write_scope's `id = current_user_id()`) apply.
    await client.query(`SELECT set_config('app.user_id', $1, true)`, [row.user_id]);

    await client.query(
      `UPDATE activation_codes SET used_at = now() WHERE id = $1`, [row.id]);

    const userRes = await client.query<{
      id: string; full_name_en: string | null; full_name_bn: string | null; status: string;
    }>(
      `SELECT id, full_name_en, full_name_bn, status FROM users
        WHERE id = $1 AND deleted_at IS NULL`,
      [row.user_id]);
    const user = userRes.rows[0];
    if (!user) throw new HttpError(404, 'account no longer exists', 'user_not_found');
    if (user.status !== 'active' && user.status !== 'invited') {
      throw new HttpError(403, `account is ${user.status}`, 'account_not_active');
    }

    // Activation is the moment 'invited' becomes real.
    if (user.status === 'invited') {
      await client.query(
        `UPDATE users SET status = 'active' WHERE id = $1`, [row.user_id]);
    }

    const { primaryRole, roles } = await loadRoles(client, row.tenant_id, user.id);
    if (!primaryRole) throw new HttpError(403, 'account has no active role assigned', 'no_active_role');

    // From here, byte-for-byte the otp-verify session shape — one session
    // model, whichever door was used.
    const refreshToken = randomOpaqueToken(32);
    await client.query(
      `INSERT INTO user_sessions (tenant_id, user_id, refresh_token_hash, device_id, device_label, expires_at)
       VALUES ($1, $2, $3, $4, $5, now() + ($6 || ' days')::interval)`,
      [row.tenant_id, user.id, sha256Buf(refreshToken), deviceId,
       body.deviceLabel ?? null, REFRESH_TTL_DAYS]);

    const accessToken = await signAccessToken(
      { sub: user.id, tid: row.tenant_id, role: primaryRole, roles }, ACCESS_TTL);

    return {
      accessToken,
      refreshToken,
      expiresIn: 900,
      user: {
        id: user.id,
        fullNameEn: user.full_name_en,
        fullNameBn: user.full_name_bn,
        role: primaryRole,
        roles,
      },
    };
  });

  json(res, 200, result, cors);
}
