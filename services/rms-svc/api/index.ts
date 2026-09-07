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
// P0. The room register — nothing in the product could write `rooms` until now.
import rooms from './rooms.ts';
import assignments from './assignments.ts';
import setup from './setup.ts';
import generate from './generate.ts';
import resolve from './resolve.ts';
import publish from './publish.ts';
import timetable from './timetable.ts';

type Handler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

const ROUTES: Record<string, Handler> = {
  routine, solve, substitute, examroutine, generation, editor, rooms,
  // P9-1. The one solver input no school could supply.
  assignments,
  // P9-2. The wizard's readiness check and the three writers that stop
  // bell times, subject demand and teacher availability being SQL-only.
  setup,
  // P9-3. READY -> GENERATE -> RESULT, orchestrating the existing solver.
  generate,
  // P9-6. Recalculate one teacher, section, room or day — the same solver,
  // told to fill only the gaps a scoped removal just made.
  resolve,
  // P9-7. The review surface and the DRAFT -> REVIEW -> PUBLISHED lifecycle.
  publish,
  // P9-8. Every audience's view of the ONE published routine. Scope is a
  // WHERE clause, not a second dataset.
  timetable,
};

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
