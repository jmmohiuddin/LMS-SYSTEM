/**
 * POST /api/v1/finance/webhooks/rocket — see ../../src/webhook.ts for the
 * shared processing logic and the tenant-resolution design this depends on.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { sharedDb } from '../../../../packages/server-core/src/db.ts';
import { readBody, json } from '../../../../packages/server-core/src/http.ts';
import { MfsWebhookProcessor } from '../../src/webhook.ts';

let _processor: MfsWebhookProcessor | null = null;
async function processor(): Promise<MfsWebhookProcessor> {
  if (_processor) return _processor;
  _processor = new MfsWebhookProcessor(await sharedDb());
  return _processor;
}

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS);
    res.end();
    return;
  }
  if (req.method !== 'POST') {
    json(res, 405, { error: 'method_not_allowed' }, CORS);
    return;
  }

  try {
    const rawBody = await readBody(req);
    const headers = Object.fromEntries(
      Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(', ') : v ?? '']),
    );
    const sourceIp = (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim() ?? null;

    const p = await processor();
    const result = await p.process('rocket', rawBody, headers, sourceIp);
    json(res, result.status, result.body, CORS);
  } catch (err) {
    console.error('[finance/webhooks/rocket] unexpected error', err);
    json(res, 500, { error: 'internal_error' }, CORS);
  }
}
