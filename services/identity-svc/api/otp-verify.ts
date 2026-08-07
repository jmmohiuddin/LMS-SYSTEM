/**
 * POST /api/v1/auth/otp/verify
 * Body: { tenantId, phone, purpose, code, deviceId, deviceLabel }
 *
 * Consumes the OTP challenge created by otp-request, resolves the user by
 * phone (system_ingest role satisfies the users_scope RLS policy via
 * app.is_staff()'s blocklist — see db/migrations/010_rls_policies.sql), and
 * issues an access token + a rotating opaque refresh token.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { sharedDb } from '../../../packages/server-core/src/db.ts';
import { corsHeaders, readJson, json, HttpError } from '../../../packages/server-core/src/http.ts';
import { sha256Buf, randomOpaqueToken, constantTimeEqualHex } from '../../../packages/server-core/src/crypto.ts';
import { signAccessToken } from '../../../packages/server-core/src/jwt.ts';
import { loadRoles } from '../src/roles.ts';

const PHONE_RE = /^\+8801[3-9][0-9]{8}$/;
const REFRESH_TTL_DAYS = 30;
const ACCESS_TTL = '15m';

interface OtpVerifyBody {
  tenantId?: string;
  phone?: string;
  purpose?: string;
  code?: string;
  deviceId?: string;
  deviceLabel?: string;
}

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const cors = corsHeaders();
  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors);
    res.end();
    return;
  }
  if (req.method !== 'POST') {
    json(res, 405, { error: 'method_not_allowed' }, cors);
    return;
  }

  try {
    const body = await readJson<OtpVerifyBody>(req);
    const tenantId = body.tenantId ?? '';
    const phone = body.phone ?? '';
    const purpose = body.purpose ?? 'login';
    const code = body.code ?? '';
    const deviceId = body.deviceId ?? '';
    const deviceLabel = body.deviceLabel ?? null;

    if (!tenantId) throw new HttpError(400, 'tenantId is required', 'tenant_required');
    if (!PHONE_RE.test(phone)) throw new HttpError(400, 'phone must be a valid +8801XXXXXXXXX number', 'invalid_phone');
    if (!/^[0-9]{4,8}$/.test(code)) throw new HttpError(400, 'code is required', 'invalid_code_format');
    if (!deviceId) throw new HttpError(400, 'deviceId is required', 'device_required');

    const db = await sharedDb();
    const result = await db.withTenant({ tenantId, userId: '', role: 'system_ingest' }, async (client) => {
      const challenge = await client.query<{ id: string; code_hash: Buffer; attempts: number; max_attempts: number }>(
        `SELECT id, code_hash, attempts, max_attempts FROM otp_challenges
          WHERE tenant_id = $1 AND phone_e164 = $2 AND purpose = $3
            AND consumed_at IS NULL AND expires_at > now()
          ORDER BY created_at DESC LIMIT 1
          FOR UPDATE`,
        [tenantId, phone, purpose],
      );
      const row = challenge.rows[0];
      if (!row) throw new HttpError(400, 'no active OTP challenge found — request a new code', 'challenge_not_found');
      if (row.attempts >= row.max_attempts) {
        throw new HttpError(429, 'too many attempts — request a new code', 'too_many_attempts');
      }

      const candidateHash = sha256Buf(code).toString('hex');
      const storedHash = Buffer.from(row.code_hash).toString('hex');
      if (!constantTimeEqualHex(candidateHash, storedHash)) {
        await client.query(`UPDATE otp_challenges SET attempts = attempts + 1 WHERE id = $1`, [row.id]);
        throw new HttpError(400, 'incorrect code', 'invalid_code');
      }
      await client.query(`UPDATE otp_challenges SET consumed_at = now() WHERE id = $1`, [row.id]);

      const userRes = await client.query<{
        id: string;
        full_name_en: string | null;
        full_name_bn: string | null;
        status: string;
      }>(
        `SELECT id, full_name_en, full_name_bn, status FROM users
          WHERE tenant_id = $1 AND phone_e164 = $2 AND deleted_at IS NULL`,
        [tenantId, phone],
      );
      const user = userRes.rows[0];
      if (!user) throw new HttpError(404, 'no account found for this phone number', 'user_not_found');
      if (user.status !== 'active' && user.status !== 'invited') {
        throw new HttpError(403, `account is ${user.status}`, 'account_not_active');
      }

      const { primaryRole, roles } = await loadRoles(client, tenantId, user.id);
      if (!primaryRole) throw new HttpError(403, 'account has no active role assigned', 'no_active_role');

      const refreshToken = randomOpaqueToken(32);
      const refreshHash = sha256Buf(refreshToken);
      await client.query(
        `INSERT INTO user_sessions (tenant_id, user_id, refresh_token_hash, device_id, device_label, expires_at)
         VALUES ($1, $2, $3, $4, $5, now() + ($6 || ' days')::interval)`,
        [tenantId, user.id, refreshHash, deviceId, deviceLabel, REFRESH_TTL_DAYS],
      );

      const accessToken = await signAccessToken({ sub: user.id, tid: tenantId, role: primaryRole, roles }, ACCESS_TTL);

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
  } catch (err) {
    if (err instanceof HttpError) {
      json(res, err.status, { error: err.code ?? 'error', message: err.message }, cors);
      return;
    }
    console.error('[otp-verify] unexpected error', err);
    json(res, 500, { error: 'internal_error' }, cors);
  }
}
