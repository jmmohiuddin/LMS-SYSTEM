/**
 * Dynamic-route dispatcher for /api/v1/rms/{routine,solve,substitute,
 * examroutine,generation,editor} — one Vercel function (api/v1/rms/[action].js)
 * instead of six. See services/identity-svc/api/index.ts for the
 * Hobby-cap rationale.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { corsHeaders, json } from '../../../packages/server-core/src/http.ts';
import { enforceRateLimit } from '../../../packages/server-core/src/rate-limit.ts';
import routine from './routine.ts';
import solve from './solve.ts';
import substitute from './substitute.ts';
import examroutine from './examroutine.ts';
import generation from './generation.ts';
import editor from './editor.ts';

type Handler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

const ROUTES: Record<string, Handler> = { routine, solve, substitute, examroutine, generation, editor };

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const path = new URL(req.url ?? '/', 'http://internal').pathname;
  const sub = path.split('/').filter(Boolean).pop() ?? '';
  const route = ROUTES[sub];
  if (!route) {
    json(res, 404, { error: 'not_found' }, corsHeaders());
    return;
  }
  // F-102. Charged per source IP before the handler runs. Reads get a
  // looser bucket than writes; both are sized for a whole school behind one
  // NAT gateway rather than for one person (see rate-limit.ts).
  if (req.method !== 'OPTIONS') {
    const cls = req.method === 'GET' ? 'read' : 'mutation';
    if (!(await enforceRateLimit(req, res, corsHeaders(), cls))) return;
  }
  return route(req, res);
}
