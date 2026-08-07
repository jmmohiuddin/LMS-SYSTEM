/**
 * POST /api/v1/auth/refresh
 * Body: { tenantId, refreshToken, deviceId }
 *
 * Rotates the refresh token on every use (old session marked revoked +
 * superseded_by the new one) and reissues an access token with a fresh
 * role snapshot, so a role change takes effect on next refresh at latest.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { sharedDb } from '../../../packages/server-core/src/db.ts';
import { corsHeaders, readJson, json, HttpError } from '../../../packages/server-core/src/http.ts';
import { sha256Buf, randomOpaqueToken } from '../../../packages/server-core/src/crypto.ts';
import { signAccessToken } from '../../../packages/server-core/src/jwt.ts';
import { loadRoles } from '../src/roles.ts';

const REFRESH_TTL_DAYS = 30;
const ACCESS_TTL = '15m';

interface RefreshBody {
  tenantId?: string;
  refreshToken?: string;
  deviceId?: string;
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
    const body = await readJson<RefreshBody>(req);
    const tenantId = body.tenantId ?? '';
    const oldRefreshToken = body.refreshToken ?? '';
    const deviceId = body.deviceId ?? '';

    if (!tenantId) throw new HttpError(400, 'tenantId is required', 'tenant_required');
    if (!oldRefreshToken) throw new HttpError(400, 'refreshToken is required', 'refresh_token_required');

    const db = await sharedDb();
    const result = await db.withTenant({ tenantId, userId: '', role: 'system_ingest' }, async (client) => {
      const oldHash = sha256Buf(oldRefreshToken);
      const sessionRes = await client.query<{ id: string; user_id: string; device_label: string | null }>(
        `SELECT id, user_id, device_label FROM user_sessions
          WHERE tenant_id = $1 AND refresh_token_hash = $2
            AND revoked_at IS NULL AND expires_at > now()
          FOR UPDATE`,
        [tenantId, oldHash],
      );
      const session = sessionRes.rows[0];
      if (!session) throw new HttpError(401, 'refresh token is invalid or expired', 'invalid_refresh_token');

      const { primaryRole, roles } = await loadRoles(client, tenantId, session.user_id);
      if (!primaryRole) throw new HttpError(403, 'account has no active role assigned', 'no_active_role');

      const newRefreshToken = randomOpaqueToken(32);
      const newHash = sha256Buf(newRefreshToken);
      const newSessionRes = await client.query<{ id: string }>(
        `INSERT INTO user_sessions (tenant_id, user_id, refresh_token_hash, device_id, device_label, expires_at)
         VALUES ($1, $2, $3, $4, $5, now() + ($6 || ' days')::interval)
         RETURNING id`,
        [tenantId, session.user_id, newHash, deviceId || null, session.device_label, REFRESH_TTL_DAYS],
      );
      await client.query(
        `UPDATE user_sessions SET revoked_at = now(), revoked_reason = 'rotated', superseded_by = $2
          WHERE id = $1`,
        [session.id, newSessionRes.rows[0].id],
      );

      const accessToken = await signAccessToken(
        { sub: session.user_id, tid: tenantId, role: primaryRole, roles },
        ACCESS_TTL,
      );

      return { accessToken, refreshToken: newRefreshToken, expiresIn: 900 };
    });

    json(res, 200, result, cors);
  } catch (err) {
    if (err instanceof HttpError) {
      json(res, err.status, { error: err.code ?? 'error', message: err.message }, cors);
      return;
    }
    console.error('[refresh] unexpected error', err);
    json(res, 500, { error: 'internal_error' }, cors);
  }
}
