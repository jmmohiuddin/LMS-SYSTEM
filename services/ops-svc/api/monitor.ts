/**
 * GET|POST /api/v1/ops/monitor — the thing that wakes somebody up.  (R-8 §7)
 *
 * The R-8 report said, of monitoring: "a stopped cron silences a school with
 * no alert". This is the answer to that sentence. It runs on a schedule,
 * evaluates the conditions in server-core/alerts.ts against the whole
 * deployment, and POSTs anything firing to ALERT_WEBHOOK_URL.
 *
 * GET evaluates and returns; POST evaluates and DELIVERS. The split means an
 * operator (or this file's own test) can ask "what would fire right now?"
 * without paging anybody, and the cron gets delivery without a second
 * endpoint. Both need the service credential.
 *
 * ── Why it does not alert on itself ─────────────────────────────────────
 * A monitor that fails silently is worse than none, because it converts "we
 * are not watching" into "we believe we are watching". Nothing inside this
 * process can catch that — a dead function does not report its own death. The
 * host's own scheduled-function failure notification is what covers it, and
 * §7 of the runbook says to turn that on and treat it as part of the monitor
 * rather than as hosting trivia.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { corsHeaders, json, header } from '../../../packages/server-core/src/http.ts';
import { enforceRateLimit } from '../../../packages/server-core/src/rate-limit.ts';
import {
  matchServiceKey, looksLikeBrowser, keyFingerprint, logServiceKeyEvent,
} from '../../../packages/server-core/src/service-auth.ts';
import {
  evaluateAlerts, alertWebhookUrl, alertText, type Alert,
} from '../../../packages/server-core/src/alerts.ts';
import { gatherSignals } from '../../../packages/server-core/src/monitor-signals.ts';

/** Which deployment the alert came from. Two alerts that look identical from
 *  staging and production, with nothing to tell them apart, teach an operator
 *  to ignore both. */
function environmentName(): string {
  return process.env.APP_ENV
    ?? process.env.VERCEL_ENV
    ?? process.env.CONTEXT
    ?? process.env.NODE_ENV
    ?? 'unknown';
}

async function deliver(alerts: Alert[], env: string): Promise<
  { delivered: boolean; reason?: string }
> {
  const url = alertWebhookUrl();
  if (!url) return { delivered: false, reason: 'ALERT_WEBHOOK_URL is not set (https required)' };
  if (alerts.length === 0) return { delivered: false, reason: 'nothing firing' };

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // `text` is what Slack, Discord and Teams render; the array is for
      // anything that parses. Sending both costs nothing and means the sink
      // can be swapped without touching this file.
      body: JSON.stringify({ text: alertText(alerts, env), environment: env, alerts }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return { delivered: false, reason: `webhook returned ${res.status}` };
    return { delivered: true };
  } catch (err) {
    // Never throw: a failing webhook must not also take out the endpoint that
    // would have told us what was wrong.
    return { delivered: false, reason: err instanceof Error ? err.message : 'webhook failed' };
  }
}

export default async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const cors = corsHeaders([], 'GET, POST, OPTIONS', header(req, 'origin') || undefined);
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }
  if (req.method !== 'GET' && req.method !== 'POST') {
    json(res, 405, { error: 'method_not_allowed' }, cors);
    return;
  }

  // F-102, as on maintenance: a service-class limiter of its own, since the
  // dispatcher's generic buckets key on a session this caller does not have.
  if (!(await enforceRateLimit(req, res, cors, 'service'))) return;

  const authHeader = header(req, 'authorization');
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  const keyLabel = matchServiceKey(token, process.env, { allowCron: true });
  if (!keyLabel) { json(res, 401, { error: 'unauthorized' }, cors); return; }
  const browserHeader = looksLikeBrowser(req);
  if (browserHeader) {
    logServiceKeyEvent({
      event: 'service_key_from_browser', endpoint: 'ops/monitor',
      fingerprint: keyFingerprint(token), keyLabel, detail: browserHeader,
    });
    json(res, 403, { error: 'service_key_from_browser' }, cors);
    return;
  }

  const url = process.env.DATABASE_MAINTENANCE_URL;
  if (!url) {
    // 503 rather than a silent all-clear. An unconfigured monitor that returns
    // 200 is the single most dangerous response this endpoint could give.
    json(res, 503, {
      error: 'monitor_unconfigured',
      message: 'DATABASE_MAINTENANCE_URL (owner role, direct endpoint) is not set',
    }, cors);
    return;
  }

  const env = environmentName();
  const { signals, topErrors } = await gatherSignals(url);
  const alerts = evaluateAlerts(signals);

  // Logged whether or not a webhook is configured, so the host's log drain is
  // a working fallback sink from the first deploy.
  for (const a of alerts) {
    console.error(JSON.stringify({ at: 'monitor', environment: env, ...a }));
  }

  const delivery = req.method === 'POST'
    ? await deliver(alerts, env)
    : { delivered: false, reason: 'GET does not deliver' };

  json(res, 200, {
    environment: env,
    checkedAt: new Date().toISOString(),
    alerts,
    delivery,
    signals,
    topErrors,
  }, cors);
}
