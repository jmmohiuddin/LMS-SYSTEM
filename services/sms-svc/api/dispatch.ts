/**
 * POST/GET /api/v1/sms/dispatch[?tenantId=<uuid>]
 *
 * Internal/cron-only — never called by the PWA. Auth accepts either
 * SERVICE_API_KEY (manual/ops calls, same convention as sync/push+pull) or
 * CRON_SECRET (what Vercel Cron sends automatically when configured).
 *
 * Runs SmsDispatchWorker for one tenant if `tenantId` is given, otherwise
 * loops over every id in SMS_WORKER_TENANT_IDS (comma-separated) — see
 * services/sms-svc/src/dispatch.ts for why there is no way to discover
 * tenants automatically under the runtime DB role.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { sharedDb } from '../../../packages/server-core/src/db.ts';
import { corsHeaders, query, json, header } from '../../../packages/server-core/src/http.ts';
import { enforceRateLimit } from '../../../packages/server-core/src/rate-limit.ts';
import { SmsDispatchWorker, type DispatchResult } from '../src/dispatch.ts';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const cors = corsHeaders([], 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors);
    res.end();
    return;
  }
  if (req.method !== 'GET' && req.method !== 'POST') {
    json(res, 405, { error: 'method_not_allowed' }, cors);
    return;
  }

  // F-102. Cron/ops only, already key-gated — a backstop against a stuck
  // scheduler re-firing the worker, which would send SMS twice.
  if (!(await enforceRateLimit(req, res, cors, 'service'))) return;

  const authHeader = header(req, 'authorization');
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  const validTokens = [process.env.SERVICE_API_KEY, process.env.CRON_SECRET].filter(Boolean);
  if (validTokens.length === 0 || !validTokens.includes(token)) {
    json(res, 401, { error: 'unauthorized' }, cors);
    return;
  }

  const requestedTenantId = query(req).get('tenantId') ?? '';
  let tenantIds: string[];
  if (requestedTenantId) {
    if (!UUID_RE.test(requestedTenantId)) {
      json(res, 400, { error: 'invalid_tenant_id' }, cors);
      return;
    }
    tenantIds = [requestedTenantId];
  } else {
    tenantIds = (process.env.SMS_WORKER_TENANT_IDS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (tenantIds.length === 0) {
      json(res, 200, { ok: true, results: [], note: 'no tenantId given and SMS_WORKER_TENANT_IDS is empty' }, cors);
      return;
    }
  }

  try {
    const db = await sharedDb();
    const worker = new SmsDispatchWorker(db);
    const results: (DispatchResult | { tenantId: string; error: string })[] = [];
    for (const tenantId of tenantIds) {
      try {
        results.push(await worker.run(tenantId));
      } catch (err) {
        console.error(`[sms-dispatch] tenant ${tenantId} failed`, err);
        results.push({ tenantId, error: err instanceof Error ? err.message : 'unknown_error' });
      }
    }
    json(res, 200, { ok: true, results }, cors);
  } catch (err) {
    console.error('[sms-dispatch] unexpected error', err);
    json(res, 500, { error: 'internal_error' }, cors);
  }
}
