/**
 * sms-svc dispatcher — one Vercel function, two routes.  (R-8)
 *
 *   POST/GET /api/v1/sms/dispatch  → drain the outbox (cron / ops)
 *   POST     /api/v1/sms/dlr       → the aggregator's delivery report
 *
 * This service was a single function file (`api/dispatch.ts` → `sms/dispatch.js`)
 * because it had exactly one route. R-8 adds the delivery-report webhook, and
 * the Hobby plan has one function slot left — so sms-svc becomes a dispatcher
 * like every other service rather than spending the last slot on one endpoint.
 * The cron path is unchanged, which is what matters: `/api/v1/sms/dispatch`
 * still resolves, and Vercel's scheduler does not know anything moved.
 *
 * The two routes have DIFFERENT credentials on purpose. Dispatch is ours and
 * takes `SERVICE_API_KEY`/`CRON_SECRET`; the DLR is called by the aggregator
 * and takes its own `SMS_DLR_SECRET`, because handing a vendor the service key
 * would make every internal endpoint reachable by them.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { corsHeaders, json } from '../../../packages/server-core/src/http.ts';
import dispatch from './dispatch.ts';
import dlr from './dlr.ts';

type Handler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

const ROUTES: Record<string, Handler> = { dispatch, dlr };

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
