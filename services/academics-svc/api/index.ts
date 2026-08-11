/**
 * Dynamic-route dispatcher for /api/v1/academics/{sections,roster,exams,marks}
 * — one Vercel function (api/v1/academics/[resource].js) instead of four.
 * See services/identity-svc/api/index.ts for the Hobby-cap rationale.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { corsHeaders, json } from '../../../packages/server-core/src/http.ts';
import { enforceRateLimit } from '../../../packages/server-core/src/rate-limit.ts';
import sections from './sections.ts';
import roster from './roster.ts';
import exams from './exams.ts';
import marks from './marks.ts';
import publish from './publish.ts';
import scripts from './scripts.ts';
import chapters from './chapters.ts';
import topics from './topics.ts';
import results from './results.ts';
import assignments from './assignments.ts';
import practice from './practice.ts';
import next from './next.ts';
import subjects from './subjects.ts';

type Handler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

const ROUTES: Record<string, Handler> = {
  sections, roster, exams, marks, publish, scripts, chapters, topics, results,
  assignments, practice, next, subjects,
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
