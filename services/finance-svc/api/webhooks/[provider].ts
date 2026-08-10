/**
 * POST /api/v1/finance/webhooks/{bkash,nagad,rocket} — a single dynamic-route
 * function for all three MFS providers.
 *
 * Originally three separate files (bkash.ts/nagad.ts/rocket.ts), each
 * identical apart from the provider literal passed to
 * MfsWebhookProcessor.process(). Merged into one Vercel Serverless Function
 * because the Hobby plan caps a deployment at 12 functions, and the PWA
 * login/nav/roster/routine work (this commit) pushed the total to 14 — see
 * ../../../../scripts/build.mjs's API_ENTRIES comment. The provider segment
 * is read straight from the URL path rather than relying on Vercel's
 * `[provider]` → req.query injection, so this doesn't depend on which
 * request object shape (raw IncomingMessage vs VercelRequest) is in play.
 *
 * See ../../src/webhook.ts for the shared processing logic and the
 * tenant-resolution design this depends on.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { sharedDb } from '../../../../packages/server-core/src/db.ts';
import { readBody, json } from '../../../../packages/server-core/src/http.ts';
import { enforceRateLimit } from '../../../../packages/server-core/src/rate-limit.ts';
import { MfsWebhookProcessor, type MfsProvider } from '../../src/webhook.ts';

let _processor: MfsWebhookProcessor | null = null;
async function processor(): Promise<MfsWebhookProcessor> {
  if (_processor) return _processor;
  _processor = new MfsWebhookProcessor(await sharedDb());
  return _processor;
}

const KNOWN_PROVIDERS = new Set(['bkash', 'nagad', 'rocket']);

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };

function providerFromUrl(url: string | undefined): string {
  const path = new URL(url ?? '/', 'http://internal').pathname;
  const segment = path.split('/').filter(Boolean).pop() ?? '';
  return segment.toLowerCase();
}

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

  const provider = providerFromUrl(req.url);
  if (!KNOWN_PROVIDERS.has(provider)) {
    json(res, 404, { error: 'unknown_provider' }, CORS);
    return;
  }

  // F-102. Deliberately the loosest class in the table: a refused webhook is
  // a settlement notification we did not record, and the gateways retry on
  // non-2xx, so this must only ever catch a runaway loop. Signature
  // verification inside the processor remains the actual trust boundary.
  if (!(await enforceRateLimit(req, res, CORS, 'service'))) return;

  try {
    const rawBody = await readBody(req);
    const headers = Object.fromEntries(
      Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(', ') : v ?? '']),
    );
    const sourceIp = (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim() ?? null;

    const p = await processor();
    const result = await p.process(provider as MfsProvider, rawBody, headers, sourceIp);
    json(res, result.status, result.body, CORS);
  } catch (err) {
    console.error(`[finance/webhooks/${provider}] unexpected error`, err);
    json(res, 500, { error: 'internal_error' }, CORS);
  }
}
