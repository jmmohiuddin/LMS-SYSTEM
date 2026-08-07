/**
 * POST /api/v1/auth/logout
 * Body: { tenantId, refreshToken }
 *
 * Always responds 200 { ok: true } regardless of whether the token matched
 * an active session, so the response can't be used to probe token validity.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { sharedDb } from '../../../packages/server-core/src/db.ts';
import { corsHeaders, readJson, json, HttpError } from '../../../packages/server-core/src/http.ts';
import { sha256Buf } from '../../../packages/server-core/src/crypto.ts';

interface LogoutBody {
  tenantId?: string;
  refreshToken?: string;
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
    const body = await readJson<LogoutBody>(req);
    const tenantId = body.tenantId ?? '';
    const refreshToken = body.refreshToken ?? '';

    if (!tenantId) throw new HttpError(400, 'tenantId is required', 'tenant_required');
    if (!refreshToken) throw new HttpError(400, 'refreshToken is required', 'refresh_token_required');

    const db = await sharedDb();
    await db.withTenant({ tenantId, userId: '', role: 'system_ingest' }, async (client) => {
      await client.query(
        `UPDATE user_sessions SET revoked_at = now(), revoked_reason = 'logout'
          WHERE tenant_id = $1 AND refresh_token_hash = $2 AND revoked_at IS NULL`,
        [tenantId, sha256Buf(refreshToken)],
      );
    });

    json(res, 200, { ok: true }, cors);
  } catch (err) {
    if (err instanceof HttpError) {
      json(res, err.status, { error: err.code ?? 'error', message: err.message }, cors);
      return;
    }
    console.error('[logout] unexpected error', err);
    json(res, 500, { error: 'internal_error' }, cors);
  }
}
