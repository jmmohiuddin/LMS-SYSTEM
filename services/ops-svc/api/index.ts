/**
 * Dynamic-route dispatcher for
 * /api/v1/ops/{maintenance,events,branding,brand,manifest,notices,inbox,
 *              dashboard,assign,enrol,rollover,settings,users,
 *              structure,guardians,audit,calendar}
 * — one Vercel function (api/v1/ops/[action].js) instead of sixteen. See
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
import notices from './notices.ts';
import inbox from './inbox.ts';
// R-3 — the principal and IT admin control centre.
import dashboard from './dashboard.ts';
import assign from './assign.ts';
import enrol from './enrol.ts';
import rollover from './rollover.ts';
import settings from './settings.ts';
import users from './users.ts';
// R-3 completion pass — the three gaps R-3's own report named.
import structure from './structure.ts';
import guardians from './guardians.ts';
import audit from './audit.ts';
// R-4 — the academic calendar.
import calendar from './calendar.ts';

type Handler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

const ROUTES: Record<string, Handler> = {
  maintenance, events, branding, brand, manifest, notices, inbox,
  dashboard, assign, enrol, rollover, settings, users,
  structure, guardians, audit, calendar,
};

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
    // Publishing a notice fans out to hundreds of receipt rows and can queue
    // SMS, so it is the heaviest mutation on this dispatcher. Marking one read
    // is a mutation too — cheap, but a write.
    const isWrite = req.method === 'POST' || req.method === 'PUT'
      || req.method === 'PATCH' || req.method === 'DELETE';
    // R-3's writes are the heaviest on this dispatcher: a bulk move touches
    // 200 enrolment rows and a rollover commit touches every student in the
    // school. They belong in the mutation bucket without exception.
    const WRITE_ROUTES = new Set(['events', 'notices', 'inbox', 'branding',
      'assign', 'enrol', 'rollover', 'settings', 'users',
      'structure', 'guardians', 'calendar']);
    const bucket = WRITE_ROUTES.has(sub) && isWrite ? 'mutation' : 'read';
    if (!(await enforceRateLimit(req, res, corsHeaders(), bucket))) return;
  }
  return route(req, res);
}
