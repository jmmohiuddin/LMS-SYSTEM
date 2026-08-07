/**
 * POST /api/v1/sync/push — Vercel serverless function.
 *
 * Wraps SyncPushHandler with:
 *   - API-key auth (SERVICE_API_KEY env var; required)
 *   - Tenant context from request headers (X-Tenant-ID, X-User-ID, X-Role)
 *   - CORS for cross-origin calls from the PWA shell
 *   - Singleton DB pool reused across warm invocations
 *
 * Auth will be upgraded to EdDSA JWT when the identity service ships (Phase 1).
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createDb, assertRlsEnforced } from '../../../services/sync-svc/src/db.ts';
import { SyncPushHandler } from '../../../services/sync-svc/src/push.ts';
import type { PushRequest } from '../../../packages/offline/src/types.ts';

/* ── Singletons ─────────────────────────────────────────────────────────── */

let _handler: SyncPushHandler | null = null;

async function handler(): Promise<SyncPushHandler> {
  if (_handler) return _handler;
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL env var is not set');
  // max:5 — each serverless instance handles one request at a time; a small
  // pool lets a single warm instance absorb minor burst without creating N
  // connections to the Neon pooler per request.
  const db = createDb(url, { max: 5 });
  await assertRlsEnforced(db);
  _handler = new SyncPushHandler(db);
  return _handler;
}

/* ── Helpers ────────────────────────────────────────────────────────────── */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': [
    'Content-Type',
    'Authorization',
    'X-Tenant-ID',
    'X-User-ID',
    'X-Role',
  ].join(', '),
};

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function header(req: IncomingMessage, name: string): string {
  const v = req.headers[name.toLowerCase()];
  return Array.isArray(v) ? v[0] ?? '' : v ?? '';
}

function json(res: ServerResponse, code: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(code, { ...CORS, 'Content-Type': 'application/json' });
  res.end(payload);
}

/* ── Handler ────────────────────────────────────────────────────────────── */

export default async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
  // Preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS);
    res.end();
    return;
  }

  if (req.method !== 'POST') {
    json(res, 405, { error: 'Method Not Allowed' });
    return;
  }

  // ── Auth ──────────────────────────────────────────────────────────────────
  const SERVICE_API_KEY = process.env.SERVICE_API_KEY;
  if (!SERVICE_API_KEY) {
    console.error('[sync/push] SERVICE_API_KEY is not configured');
    json(res, 503, { error: 'Service not configured' });
    return;
  }
  const authHeader = header(req, 'authorization');
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  if (token !== SERVICE_API_KEY) {
    json(res, 401, { error: 'Unauthorized' });
    return;
  }

  // ── Tenant context ────────────────────────────────────────────────────────
  const tenantId = header(req, 'x-tenant-id');
  const userId   = header(req, 'x-user-id');
  const role     = header(req, 'x-role') || 'teacher';

  if (!tenantId || !userId) {
    json(res, 400, { error: 'X-Tenant-ID and X-User-ID headers are required' });
    return;
  }

  // ── Body ──────────────────────────────────────────────────────────────────
  let body: PushRequest;
  try {
    const raw = await readBody(req);
    body = JSON.parse(raw) as PushRequest;
  } catch {
    json(res, 400, { error: 'Invalid JSON body' });
    return;
  }

  // ── Handle ────────────────────────────────────────────────────────────────
  try {
    const h = await handler();
    const result = await h.handle(body, { tenantId, userId, role });
    json(res, 200, result);
  } catch (err) {
    console.error('[sync/push]', err);
    const msg = err instanceof Error ? err.message : 'Internal error';
    json(res, 500, { error: msg });
  }
}
