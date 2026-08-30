/**
 * POST /api/v1/sync/push — Vercel serverless function.
 *
 * Wraps SyncPushHandler with:
 *   - Auth: an EdDSA JWT from identity-svc (the PWA's normal path — see
 *     apps/pwa/src/auth.ts), OR the raw SERVICE_API_KEY plus X-Tenant-ID/
 *     X-User-ID/X-Role headers (kept for admin scripts and smoke tests that
 *     predate login; see docs/06-DEPLOYMENT.md). R-8 §2 narrowed that second
 *     path — off in production unless switched on, never from a browser, and
 *     logged every time; the rules live in server-core/service-auth.ts so this
 *     file and pull.ts cannot drift apart.
 *   - CORS for cross-origin calls from the PWA shell
 *   - Singleton DB pool reused across warm invocations
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createDb, assertRlsEnforced } from '../src/db.ts';
import { SyncPushHandler } from '../src/push.ts';
import type { PushRequest } from '../../../packages/offline/src/types.ts';
import { verifyAccessToken } from '../../../packages/server-core/src/jwt.ts';
import { corsHeaders } from '../../../packages/server-core/src/http.ts';
import { authenticateServiceKey } from '../../../packages/server-core/src/service-auth.ts';

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

/**
 * R-8 §3. Per-request, because the allowlist echoes the caller's own origin.
 * With ALLOWED_ORIGINS unset this is byte-for-byte the wildcard it always was.
 */
function cors(req: IncomingMessage): Record<string, string> {
  return corsHeaders([], 'POST, OPTIONS', header(req, 'origin') || undefined);
}

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

function json(
  res: ServerResponse, code: number, body: unknown, headers: Record<string, string>,
): void {
  const payload = JSON.stringify(body);
  res.writeHead(code, { ...headers, 'Content-Type': 'application/json' });
  res.end(payload);
}

/* ── Handler ────────────────────────────────────────────────────────────── */

export default async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const CORS = cors(req);

  // Preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS);
    res.end();
    return;
  }

  if (req.method !== 'POST') {
    json(res, 405, { error: 'Method Not Allowed' }, CORS);
    return;
  }

  // ── Auth ──────────────────────────────────────────────────────────────────
  const authHeader = header(req, 'authorization');
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  if (!token) {
    json(res, 401, { error: 'Unauthorized' }, CORS);
    return;
  }

  let tenantId: string;
  let userId: string;
  let role: string;

  const svc = authenticateServiceKey(req, token, process.env, 'sync/push');
  if (svc.kind === 'refused') {
    json(res, svc.status, { error: svc.error, code: svc.code }, CORS);
    return;
  }
  if (svc.kind === 'service') {
    ({ tenantId, userId, role } = svc.context);
  } else {
    // The normal path, and the only one a real user takes. Tenant, user and
    // role come from the signed token — X-Tenant-ID is not consulted here, so
    // a logged-in teacher cannot reach another school by adding a header.
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

  // ── Body ──────────────────────────────────────────────────────────────────
  let body: PushRequest;
  try {
    const raw = await readBody(req);
    body = JSON.parse(raw) as PushRequest;
  } catch {
    json(res, 400, { error: 'Invalid JSON body' }, CORS);
    return;
  }

  // ── Handle ────────────────────────────────────────────────────────────────
  try {
    const h = await handler();
    const result = await h.handle(body, { tenantId, userId, role });
    json(res, 200, result, CORS);
  } catch (err) {
    console.error('[sync/push]', err);
    const msg = err instanceof Error ? err.message : 'Internal error';
    json(res, 500, { error: msg }, CORS);
  }
}
