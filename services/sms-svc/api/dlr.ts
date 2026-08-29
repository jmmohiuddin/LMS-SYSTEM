/**
 * POST /api/v1/sms/dlr — the aggregator tells us what actually happened.  (R-8)
 *
 * `sms_outbox` has carried `delivered_at`, `error_code` and `cost_bdt` since
 * migration 001 and nothing has ever written them, because nothing has ever
 * received a delivery report. Until now the product knew only that it had
 * HANDED a message to a provider — which is not the same as a parent
 * receiving it, and the difference is the whole reason schools ask us whether
 * the SMS went out.
 *
 * ── Authentication, and why it is not the service key ───────────────────
 * This endpoint is called by the AGGREGATOR, not by us, so it cannot present
 * `SERVICE_API_KEY` — that key lives in our environment and handing it to a
 * vendor would make every internal endpoint reachable by them. It gets its
 * own shared secret, `SMS_DLR_SECRET`, compared in constant time.
 *
 * With the secret unset the endpoint answers **503, not 401**. An unconfigured
 * webhook and a wrong password are different situations and an operator
 * chasing "why are reports not arriving" should be told which one they have.
 *
 * ── Why it does not need a tenant ───────────────────────────────────────
 * A DLR carries the provider's message id and nothing else we can trust. The
 * row is found by `provider_msg_id`, and the tenant comes FROM that row — the
 * caller never names a tenant, so there is nothing for it to name wrongly.
 * That is the same stance as the MFS webhooks in finance-svc.
 *
 * Finding the row needs a cross-tenant read, which the runtime role cannot
 * do; `app.record_sms_delivery()` (migration 046) is SECURITY DEFINER for
 * exactly that, and updates only the four delivery columns. A provider
 * cannot change a message's body, its recipient, or which school it belongs
 * to.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';

import { sharedDb } from '../../../packages/server-core/src/db.ts';
import { corsHeaders, readJson, json, header } from '../../../packages/server-core/src/http.ts';
import { enforceRateLimit } from '../../../packages/server-core/src/rate-limit.ts';

/** What the four aggregators call the same three outcomes. */
const DELIVERED = new Set(['delivered', 'delivered_to_handset', 'success', 'dlvrd', 'ok']);
const FAILED = new Set(['failed', 'undelivered', 'rejected', 'expired', 'undeliv', 'error']);

interface DlrBody {
  /** Our `csms_id` echoed back, or the provider's own reference. Either finds the row. */
  csms_id?: string;
  reference_id?: string;
  messageId?: string;
  status?: string;
  sms_status?: string;
  error_code?: string;
  cost?: number | string;
}

function secretMatches(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const cors = corsHeaders([], 'POST, OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }
  if (req.method !== 'POST') { json(res, 405, { error: 'method_not_allowed' }, cors); return; }

  const expected = process.env.SMS_DLR_SECRET;
  if (!expected) {
    // Not configured is not the same as not authorised, and saying so is the
    // difference between an operator checking the env and an operator
    // emailing the vendor about a password.
    json(res, 503, {
      error: 'dlr_not_configured',
      message: 'delivery reports are not enabled on this deployment (SMS_DLR_SECRET)',
    }, cors);
    return;
  }

  // Charged before the secret check: an unauthenticated caller must not be
  // able to probe this endpoint at line rate.
  if (!(await enforceRateLimit(req, res, cors, 'service'))) return;

  const auth = header(req, 'authorization');
  const given = auth.startsWith('Bearer ') ? auth.slice(7) : String(req.headers['x-dlr-secret'] ?? '');
  if (!given || !secretMatches(given, expected)) {
    json(res, 401, { error: 'unauthorized' }, cors);
    return;
  }

  let body: DlrBody;
  try {
    body = await readJson<DlrBody>(req);
  } catch {
    json(res, 400, { error: 'invalid_body' }, cors);
    return;
  }

  const msgId = (body.csms_id ?? body.reference_id ?? body.messageId ?? '').trim();
  if (!msgId) {
    json(res, 400, { error: 'missing_message_id' }, cors);
    return;
  }

  const raw = (body.sms_status ?? body.status ?? '').trim().toLowerCase();
  const state = DELIVERED.has(raw) ? 'delivered'
    : FAILED.has(raw) ? 'failed'
    : null;
  if (!state) {
    // An unknown status is not an error on our side, and guessing would
    // record a delivery that may not have happened. Accepted and ignored,
    // with the value echoed so it can be added to the map if it is real.
    json(res, 200, { ok: true, ignored: true, status: raw || null }, cors);
    return;
  }

  const cost = body.cost === undefined || body.cost === null || body.cost === ''
    ? null : Number(body.cost);

  const db = await sharedDb();
  const { rows } = await db.pool.query<{ record_sms_delivery: boolean }>(
    `SELECT app.record_sms_delivery($1, $2, $3, $4)`,
    [msgId, state, body.error_code ?? null,
     cost !== null && Number.isFinite(cost) ? cost : null],
  );

  // A message id we do not recognise is answered 200. Retrying a DLR for a
  // row we purged is not a failure the aggregator can fix, and a 4xx would
  // put us in their retry queue forever.
  json(res, 200, { ok: true, matched: rows[0]?.record_sms_delivery === true }, cors);
}
