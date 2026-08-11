/**
 * POST /api/v1/ops/events — product event ingest  (F-1503, TRD §13)
 *
 * Accepts a BATCH, because TRD §13.2 says events "batch and queue offline
 * like any other mutation": a student who studied on the bus sends a day
 * of events in one request when signal returns.
 *
 * Three rules, each the server's to hold rather than the client's to
 * remember:
 *
 * Replay is free. The client-generated event id is the primary key, and a
 * duplicate insert is caught (23505) and counted as a replay rather than
 * an error — so a batch that was sent, timed out and was sent again
 * counts once. NOT ON CONFLICT DO NOTHING, deliberately: the arbiter
 * enforces the SELECT policy against the new row, and writers here
 * intentionally cannot read — the "cheap" idiom is an RLS violation on
 * this table. The response says how many were new and how many were
 * replays, because the client trims its queue only on acknowledgement.
 *
 * PII never lands. Migration 036's trigger refuses any payload carrying a
 * personal key or an identifier-shaped value. That refusal surfaces here
 * as a 400 naming the INDEX of the offending event — never its content,
 * because an error message is a log line and the whole point is that this
 * data never reaches one.
 *
 * Oversized batches are refused loudly (413), never trimmed: a server
 * that silently keeps the first 100 teaches the client its queue is
 * shorter than it is.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { sharedDb } from '../../../packages/server-core/src/db.ts';
import { corsHeaders, readJson, json, HttpError } from '../../../packages/server-core/src/http.ts';
import { authenticate } from '../../../packages/server-core/src/auth.ts';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TYPE_RE = /^(activation|engagement|learning|offline|ai|routine|finance|error)\.[a-z0-9_]{1,64}$/;
const MAX_BATCH = 100;

interface WireEvent {
  id?: string;
  type?: string;
  occurredAt?: string;
  payload?: Record<string, unknown>;
  deviceId?: string;
}

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const cors = corsHeaders();
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }
  if (req.method !== 'POST') { json(res, 405, { error: 'method_not_allowed' }, cors); return; }

  try {
    // Any signed-in role may record what they did. There is no
    // requireRole: a guardian's four visits a year are exactly the
    // activation signal F-1503 exists to measure.
    const claims = await authenticate(req);

    const body = await readJson<{ events?: WireEvent[] }>(req);
    const events = body.events;
    if (!Array.isArray(events) || events.length === 0) {
      throw new HttpError(400, 'events must be a non-empty array', 'invalid_batch');
    }
    if (events.length > MAX_BATCH) {
      throw new HttpError(413, `batch exceeds ${MAX_BATCH} events; split it`, 'batch_too_large');
    }

    for (let i = 0; i < events.length; i++) {
      const e = events[i];
      if (!UUID_RE.test(e.id ?? '')) {
        throw new HttpError(400, `event ${i}: id must be a client-generated uuid`, 'invalid_event_id');
      }
      if (!TYPE_RE.test(e.type ?? '')) {
        throw new HttpError(400, `event ${i}: type must be domain.action`, 'invalid_event_type');
      }
      const t = Date.parse(e.occurredAt ?? '');
      if (Number.isNaN(t)) {
        throw new HttpError(400, `event ${i}: occurredAt must be an ISO timestamp`, 'invalid_occurred_at');
      }
      // The client clock is input, never truth — but a clock claiming to
      // be in the future is lying in the one direction offline cannot
      // explain, and it would poison the day it rolls into.
      if (t > Date.now() + 5 * 60 * 1000) {
        throw new HttpError(400, `event ${i}: occurredAt is in the future`, 'clock_ahead');
      }
    }

    const db = await sharedDb();
    const ctx = { tenantId: claims.tid, userId: claims.sub, role: claims.role };

    const result = await db.withTenant(ctx, async (client) => {
      let accepted = 0;
      let duplicates = 0;
      for (let i = 0; i < events.length; i++) {
        const e = events[i];
        await client.query('SAVEPOINT ev');
        try {
          await client.query(
            `INSERT INTO product_events
               (id, tenant_id, event_type, actor_role, user_id, device_id, occurred_at, payload)
             VALUES ($1, app.current_tenant(), $2, $3, $4, $5, $6, $7)`,
            [e.id, e.type, claims.role, claims.sub, e.deviceId ?? null,
             new Date(Date.parse(e.occurredAt as string)).toISOString(),
             JSON.stringify(e.payload ?? {})],
          );
          await client.query('RELEASE SAVEPOINT ev');
          accepted++;
        } catch (err) {
          await client.query('ROLLBACK TO SAVEPOINT ev');
          const code = (err as { code?: string }).code;
          if (code === '23505') { duplicates++; continue; }   // replay: free
          if (code === '23514') {
            // The PII guard fired. Name the index, never the content.
            throw new HttpError(400,
              `event ${i} was refused: payload carries personal data`, 'payload_rejected');
          }
          throw err;
        }
      }
      return { accepted, duplicates };
    });

    json(res, 200, result, cors);
  } catch (err) {
    if (err instanceof HttpError) {
      json(res, err.status, { error: err.code ?? 'error', message: err.message }, cors);
      return;
    }
    json(res, 500, { error: 'internal_error' }, cors);
  }
}
