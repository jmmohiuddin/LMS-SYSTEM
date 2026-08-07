/**
 * Dynamic-route dispatcher for /api/v1/rms/{routine,solve,substitute} — one
 * Vercel function (api/v1/rms/[action].js) instead of three. See
 * services/identity-svc/api/index.ts for the Hobby-cap rationale.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { corsHeaders, json } from '../../../packages/server-core/src/http.ts';
import routine from './routine.ts';
import solve from './solve.ts';
import substitute from './substitute.ts';

type Handler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

const ROUTES: Record<string, Handler> = { routine, solve, substitute };

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const path = new URL(req.url ?? '/', 'http://internal').pathname;
  const sub = path.split('/').filter(Boolean).pop() ?? '';
  const route = ROUTES[sub];
  if (!route) {
    json(res, 404, { error: 'not_found' }, corsHeaders());
    return;
  }
  return route(req, res);
}
