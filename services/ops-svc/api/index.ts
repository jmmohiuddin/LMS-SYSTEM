/**
 * Dynamic-route dispatcher for /api/v1/ops/{maintenance,events} — one
 * Vercel function (api/v1/ops/[action].js) instead of two. See
 * services/identity-svc/api/index.ts for the Hobby-cap rationale.
 *
 * The vercel.json cron still hits /api/v1/ops/maintenance; the dynamic
 * segment matches it unchanged.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { corsHeaders, json } from '../../../packages/server-core/src/http.ts';
import { enforceRateLimit } from '../../../packages/server-core/src/rate-limit.ts';
import maintenance from './maintenance.ts';
import events from './events.ts';

type Handler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

const ROUTES: Record<string, Handler> = { maintenance, events };

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const path = new URL(req.url ?? '/', 'http://internal').pathname;
  const sub = path.split('/').filter(Boolean).pop() ?? '';
  const route = ROUTES[sub];
  if (!route) {
    json(res, 404, { error: 'not_found' }, corsHeaders());
    return;
  }
  // F-102. maintenance carries its own service-class limiter; events is a
  // mutation from ordinary users and gets the mutation bucket.
  if (sub === 'events' && req.method !== 'OPTIONS') {
    if (!(await enforceRateLimit(req, res, corsHeaders(), 'mutation'))) return;
  }
  return route(req, res);
}
