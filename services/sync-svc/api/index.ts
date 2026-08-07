/**
 * Dynamic-route dispatcher for /api/v1/sync/{push,pull} — one Vercel
 * function (api/v1/sync/[action].js) instead of two, to stay under the
 * Hobby plan's 12-function cap. See services/identity-svc/api/index.ts for
 * the full rationale; push.ts/pull.ts are unchanged and still what the
 * sync-svc test suites import directly.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { corsHeaders, json } from '../../../packages/server-core/src/http.ts';
import push from './push.ts';
import pull from './pull.ts';

type Handler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

const ROUTES: Record<string, Handler> = { push, pull };

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
