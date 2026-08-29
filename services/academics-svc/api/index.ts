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
import attendance from './attendance.ts';
import importStudents from './import.ts';
import ward from './ward.ts';
import subjectchoice from './subjectchoice.ts';
import classperf from './classperf.ts';
// R-3 — the class -> group -> section -> student drill-down.
import hierarchy from './hierarchy.ts';
import search from './search.ts';
import studenthistory from './studenthistory.ts';

type Handler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

const ROUTES: Record<string, Handler> = {
  sections, roster, exams, marks, publish, scripts, chapters, topics, results,
  assignments, practice, next, subjects, attendance,
  import: importStudents,
  ward, subjectchoice, classperf, hierarchy,
  // R-6. The master plan writes these as /academics/students/search and
  // /academics/students/history — two segments, where both hosts route a
  // single ':resource'. The dispatcher below keys off the LAST segment, so
  // the handlers answer either shape; the platform rewrites that make the
  // documented two-segment URL work live in vercel.json and in the Netlify
  // path list in scripts/build.mjs.
  search, history: studenthistory,
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
