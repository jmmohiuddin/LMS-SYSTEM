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

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': [
    'Content-Type',
    'Authorization',
    'X-Tenant-ID',
    'X-User-ID',
    'X-Role',
  ].join(', '),
};

function header(req: IncomingMessage, name: string): string {
  const v = req.headers[name.toLowerCase()];
  return Array.isArray(v) ? v[0] ?? '' : v ?? '';
}

function json(res: ServerResponse, code: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(code, { ...CORS, 'Content-Type': 'application/json' });
  res.end(payload);
}

export default async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS);
    res.end();
    return;
  }
  if (req.method !== 'GET') {
    json(res, 405, { error: 'Method Not Allowed' });
    return;
  }

  const authHeader = header(req, 'authorization');
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  if (!token) {
    json(res, 401, { error: 'Unauthorized' });
    return;
  }

  let tenantId: string;
  let userId: string;
  let role: string;

  const SERVICE_API_KEY = process.env.SERVICE_API_KEY;
  if (SERVICE_API_KEY && token === SERVICE_API_KEY) {
    tenantId = header(req, 'x-tenant-id');
    userId   = header(req, 'x-user-id');
    role     = header(req, 'x-role') || 'teacher';
    if (!tenantId || !userId) {
      json(res, 400, { error: 'X-Tenant-ID and X-User-ID headers are required' });
      return;
    }
  } else {
    try {
      const claims = await verifyAccessToken(token);
      tenantId = claims.tid;
      userId = claims.sub;
      role = claims.role;
    } catch {
      json(res, 401, { error: 'Unauthorized' });
      return;
    }
  }

  const url = new URL(req.url ?? '/', 'http://internal');
  const scopeParam = url.searchParams.get('scope') ?? '';
  const scopes = scopeParam.split(',').map((s) => s.trim()).filter(Boolean);
  if (scopes.length === 0) {
    json(res, 400, { error: 'scope query param is required (comma-separated)' });
    return;
  }
  const cursor = Number(url.searchParams.get('cursor') ?? '0');
  if (!Number.isFinite(cursor) || cursor < 0) {
    json(res, 400, { error: 'cursor must be a non-negative integer' });
    return;
  }
  const limitParam = url.searchParams.get('limit');
  const limit = limitParam ? Number(limitParam) : undefined;

  try {
    const h = await handler();
    const result = await h.handle({ scopes, cursor, limit }, { tenantId, userId, role });
    json(res, 200, result);
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === 'UNKNOWN_SCOPE') {
      json(res, 400, { error: (err as Error).message });
      return;
    }
    console.error('[sync/pull]', err);
    const msg = err instanceof Error ? err.message : 'Internal error';
    json(res, 500, { error: msg });
  }
}
