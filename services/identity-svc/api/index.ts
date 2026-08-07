/**
 * Dynamic-route dispatcher for every /api/v1/auth/* endpoint.
 *
 * Built as ONE Vercel function (api/v1/auth/[...path].js — see
 * scripts/build.mjs) instead of four, because the Hobby plan caps a
 * deployment at 12 Serverless Functions and the exams/fees/AI/ANS work
 * needed the slots back. Same pattern as
 * services/finance-svc/api/webhooks/[provider].ts: the per-endpoint handler
 * files below are unchanged — this file only routes to them, so their
 * external URLs and behavior are identical to when they were separate
 * functions.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { corsHeaders, json } from '../../../packages/server-core/src/http.ts';
import otpRequest from './otp-request.ts';
import otpVerify from './otp-verify.ts';
import refresh from './refresh.ts';
import logout from './logout.ts';

type Handler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

const ROUTES: Record<string, Handler> = {
  'otp/request': otpRequest,
  'otp/verify': otpVerify,
  'refresh': refresh,
  'logout': logout,
};

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  // Deployed as api/v1/auth.js with a vercel.json rewrite carrying the
  // subpath as ?path= (multi-segment [...path] catch-alls do not match on
  // prebuilt functions — verified against the live platform). The URL-path
  // fallback keeps direct invocation and local testing working.
  const url = new URL(req.url ?? '/', 'http://internal');
  const sub = (url.searchParams.get('path')
    ?? url.pathname.replace(/^\/api\/v1\/auth\/?/, '')).replace(/\/+$/, '');
  const route = ROUTES[sub];
  if (!route) {
    json(res, 404, { error: 'not_found' }, corsHeaders());
    return;
  }
  return route(req, res);
}
