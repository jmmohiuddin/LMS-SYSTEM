/**
 * Dynamic-route dispatcher for
 * /api/v1/ops/{maintenance,events,branding,brand,manifest} — one Vercel
 * function (api/v1/ops/[action].js) instead of five. See
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
import branding from './branding.ts';
import brand from './brand.ts';
import manifest from './manifest.ts';

type Handler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

const ROUTES: Record<string, Handler> = { maintenance, events, branding, brand, manifest };

/**
 * Routes reachable without a session (R-1). Both answer only the seven
 * signboard fields of app.public_branding(), and both exist because a
 * login screen and a web-app manifest are fetched before anyone has signed
 * in. Being unauthenticated, they are exactly the ones that most need a
 * limiter in front of them.
 */
const PUBLIC = new Set(['brand', 'manifest']);

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const path = new URL(req.url ?? '/', 'http://internal').pathname;
  const sub = path.split('/').filter(Boolean).pop() ?? '';
  const route = ROUTES[sub];
  if (!route) {
    json(res, 404, { error: 'not_found' }, corsHeaders());
    return;
  }
  // F-102. maintenance carries its own service-class limiter. Everything
  // else is bucketed by what it costs: a branding write is a mutation, a
  // pre-auth identity read is a read, and events is a mutation from
  // ordinary users.
  if (req.method !== 'OPTIONS' && sub !== 'maintenance') {
    const bucket = sub === 'events' || (sub === 'branding' && req.method === 'PUT')
      ? 'mutation'
      : 'read';
    if (!(await enforceRateLimit(req, res, corsHeaders(), bucket))) return;
  }
  return route(req, res);
}
