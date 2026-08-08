/**
 * Dynamic-route dispatcher for /api/v1/academics/{sections,roster,exams,marks}
 * — one Vercel function (api/v1/academics/[resource].js) instead of four.
 * See services/identity-svc/api/index.ts for the Hobby-cap rationale.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { corsHeaders, json } from '../../../packages/server-core/src/http.ts';
import sections from './sections.ts';
import roster from './roster.ts';
import exams from './exams.ts';
import marks from './marks.ts';
import publish from './publish.ts';
import scripts from './scripts.ts';
import chapters from './chapters.ts';
import lessons from './lessons.ts';
import results from './results.ts';
import assignments from './assignments.ts';
import practice from './practice.ts';

type Handler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

const ROUTES: Record<string, Handler> = {
  sections, roster, exams, marks, publish, scripts, chapters, lessons, results,
  assignments, practice,
};

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
