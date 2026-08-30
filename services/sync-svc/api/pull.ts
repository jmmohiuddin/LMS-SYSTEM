/**
 * GET /api/v1/sync/pull?scope=sections,enrolments&cursor=0&limit=500
 *
 * Counterpart to POST /api/v1/sync/push. Same auth shape as push — an
 * EdDSA JWT from identity-svc, or the legacy SERVICE_API_KEY + X-Tenant-ID/
 * X-User-ID/X-Role headers — so the two endpoints of one sync protocol
 * don't drift onto different auth mechanisms.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createDb, assertRlsEnforced } from '../src/db.ts';
import { SyncPullHandler } from '../src/pull.ts';
import { verifyAccessToken } from '../../../packages/server-core/src/jwt.ts';
import { corsHeaders } from '../../../packages/server-core/src/http.ts';
import { authenticateServiceKey } from '../../../packages/server-core/src/service-auth.ts';

let _handler: SyncPullHandler | null = null;

async function handler(): Promise<SyncPullHandler> {
  if (_handler) return _handler;
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL env var is not set');
  const db = createDb(url, { max: 5 });
  await assertRlsEnforced(db);
  _handler = new SyncPullHandler(db);
  return _handler;
}

function header(req: IncomingMessage, name: string): string {
  const v = req.headers[name.toLowerCase()];
  return Array.isArray(v) ? v[0] ?? '' : v ?? '';
}

/** R-8 §3, as in push.ts. Wildcard until ALLOWED_ORIGINS says otherwise. */
function cors(req: IncomingMessage): Record<string, string> {
  return corsHeaders([], 'GET, OPTIONS', header(req, 'origin') || undefined);
}

function json(
  res: ServerResponse, code: number, body: unknown, headers: Record<string, string>,
): void {
  const payload = JSON.stringify(body);
  res.writeHead(code, { ...headers, 'Content-Type': 'application/json' });
  res.end(payload);
}

export default async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const CORS = cors(req);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS);
    res.end();
    return;
  }
  if (req.method !== 'GET') {
    json(res, 405, { error: 'Method Not Allowed' }, CORS);
    return;
  }

  const authHeader = header(req, 'authorization');
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  if (!token) {
    json(res, 401, { error: 'Unauthorized' }, CORS);
    return;
  }

  let tenantId: string;
  let userId: string;
  let role: string;

  const svc = authenticateServiceKey(req, token, process.env, 'sync/pull');
  if (svc.kind === 'refused') {
    json(res, svc.status, { error: svc.error, code: svc.code }, CORS);
    return;
  }
  if (svc.kind === 'service') {
    ({ tenantId, userId, role } = svc.context);
  } else {
    // Signed claims only. A guardian's token plus X-Tenant-ID is still that
    // guardian, in that school.
    try {
      const claims = await verifyAccessToken(token);
      tenantId = claims.tid;
      userId = claims.sub;
      role = claims.role;
    } catch {
      json(res, 401, { error: 'Unauthorized' }, CORS);
      return;
    }
  }

  const url = new URL(req.url ?? '/', 'http://internal');
  const scopeParam = url.searchParams.get('scope') ?? '';
  const scopes = scopeParam.split(',').map((s) => s.trim()).filter(Boolean);
  if (scopes.length === 0) {
    json(res, 400, { error: 'scope query param is required (comma-separated)' }, CORS);
    return;
  }
  const cursor = Number(url.searchParams.get('cursor') ?? '0');
  if (!Number.isFinite(cursor) || cursor < 0) {
    json(res, 400, { error: 'cursor must be a non-negative integer' }, CORS);
    return;
  }
  const limitParam = url.searchParams.get('limit');
  const limit = limitParam ? Number(limitParam) : undefined;

  try {
    const h = await handler();
    const result = await h.handle({ scopes, cursor, limit }, { tenantId, userId, role });
    json(res, 200, result, CORS);
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === 'UNKNOWN_SCOPE') {
      json(res, 400, { error: (err as Error).message }, CORS);
      return;
    }
    console.error('[sync/pull]', err);
    const msg = err instanceof Error ? err.message : 'Internal error';
    json(res, 500, { error: msg }, CORS);
  }
}
