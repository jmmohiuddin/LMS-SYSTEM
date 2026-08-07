/**
 * ANS (Alumni Networking System) data hooks: /api/v1/ans/{action} — one
 * Vercel function (api/v1/ans/[action].js). Implements the integration
 * surface of docs/03-API-SPECIFICATIONS.md §4 over the migration-009 tables.
 *
 *   GET  /api/v1/ans/students?tenantId=&since=&graduationYear=
 *        Batch pull (03 §4.4): the ANS fetches alumni lifecycle records.
 *        Machine-to-machine — Bearer SERVICE_API_KEY, per-tenant. Contact
 *        fields are included ONLY where contact_shared consent is true, and
 *        are resolved at export time from users (never stored in
 *        alumni_records — see the migration's comment).
 *   POST /api/v1/ans/dispatch
 *        Outbound webhook worker: drains pending/failed alumni_export_logs
 *        rows and POSTs each payload to its registered ans_endpoint, signed
 *        HMAC-SHA256 (03 §5). Bearer SERVICE_API_KEY or CRON_SECRET, same
 *        convention as sms/dispatch. delivery_id is the idempotency key the
 *        ANS dedupes on — stable across retries by design.
 *   POST /api/v1/ans/inbound
 *        The ANS pushes profile enrichment back. Staged into
 *        ans_inbound_events (raw body first, tenant resolution later) and
 *        applied only after review — never a blind write.
 *
 * Key-management honesty: ans_endpoints stores signing secrets as
 * *_ciphertext columns awaiting the KMS envelope scheme (docs/01 §7.1),
 * which does not exist yet. Until it does, the dispatcher signs with the
 * ANS_SIGNING_SECRET env var (one shared outbound key, key id from
 * signing_key_id); rows are parked as 'failed' with error_code
 * 'signing_key_unavailable' when neither is configured. No endpoint rows
 * exist yet either, so today this worker is a safe no-op — the machinery is
 * what's being delivered.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHmac, createHash } from 'node:crypto';
import { sharedDb } from '../../../packages/server-core/src/db.ts';
import { corsHeaders, query, readBody, json, header, HttpError } from '../../../packages/server-core/src/http.ts';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function requireServiceAuth(req: IncomingMessage, allowCron: boolean): void {
  const authHeader = header(req, 'authorization');
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  const valid = [process.env.SERVICE_API_KEY, allowCron ? process.env.CRON_SECRET : undefined].filter(Boolean);
  if (!token || !valid.includes(token)) {
    throw new HttpError(401, 'service credentials required', 'unauthorized');
  }
}

/* ------------------------------------------------------------ students */

async function students(req: IncomingMessage, res: ServerResponse, cors: Record<string, string>): Promise<void> {
  if (req.method !== 'GET') {
    json(res, 405, { error: 'method_not_allowed' }, cors);
    return;
  }
  requireServiceAuth(req, false);

  const q = query(req);
  const tenantId = q.get('tenantId') ?? '';
  if (!UUID_RE.test(tenantId)) throw new HttpError(400, 'tenantId must be a valid uuid', 'invalid_tenant_id');
  const since = q.get('since');
  const gradYear = q.get('graduationYear');

  const db = await sharedDb();
  // The export actor role: alumni reads are permissioned like alumni export
  // (010_rls_policies.sql alumni_export_scope) — coordinator level.
  const records = await db.withTenant(
    { tenantId, userId: '', role: 'academic_coordinator' },
    async (client) => {
      const r = await client.query<{
        global_person_id: string; student_id: string; institution_eiin: string | null;
        lifecycle_event: string; graduation_year: number | null; final_class_level: number | null;
        final_exam_name: string | null; final_gpa: string | null; final_letter_grade: string | null;
        achievements: unknown; co_curricular: unknown; subjects_studied: unknown;
        schema_version: string; record_version: number; effective_at: string;
        contact_shared: boolean;
        full_name_bn: string | null; full_name_en: string | null; phone_e164: string | null;
      }>(
        `SELECT a.global_person_id, a.student_id, a.institution_eiin,
                a.lifecycle_event, a.graduation_year, a.final_class_level,
                a.final_exam_name, a.final_gpa, a.final_letter_grade,
                a.achievements, a.co_curricular, a.subjects_studied,
                a.schema_version, a.record_version, a.effective_at,
                a.contact_shared,
                u.full_name_bn, u.full_name_en,
                CASE WHEN a.contact_shared THEN u.phone_e164 ELSE NULL END AS phone_e164
           FROM alumni_records a
           JOIN users u ON u.id = a.student_id
          WHERE ($1::timestamptz IS NULL OR a.updated_at > $1)
            AND ($2::smallint IS NULL OR a.graduation_year = $2)
          ORDER BY a.updated_at
          LIMIT 500`,
        [since || null, gradYear || null],
      );
      return r.rows;
    },
  );

  json(res, 200, {
    tenantId,
    count: records.length,
    records: records.map((r) => ({
      globalPersonId: r.global_person_id,      // THE merge key (unified identifier)
      institutionId: tenantId,
      institutionEiin: r.institution_eiin,
      lifecycleEvent: r.lifecycle_event,
      graduationYear: r.graduation_year,
      finalClassLevel: r.final_class_level,
      finalExamName: r.final_exam_name,
      finalGpa: r.final_gpa,
      finalLetterGrade: r.final_letter_grade,
      achievements: r.achievements,
      coCurricular: r.co_curricular,
      subjectsStudied: r.subjects_studied,
      schemaVersion: r.schema_version,
      recordVersion: r.record_version,
      effectiveAt: r.effective_at,
      // Consent-gated (PDPA 2026): null unless the alum opted in.
      fullName: r.contact_shared ? { bn: r.full_name_bn, en: r.full_name_en } : null,
      phone: r.phone_e164,
    })),
  }, cors);
}

/* ------------------------------------------------------------ dispatch */

const MAX_BATCH = 25;

async function dispatch(req: IncomingMessage, res: ServerResponse, cors: Record<string, string>): Promise<void> {
  if (req.method !== 'POST' && req.method !== 'GET') {
    json(res, 405, { error: 'method_not_allowed' }, cors);
    return;
  }
  requireServiceAuth(req, true);

  const db = await sharedDb();
  const signingSecret = process.env.ANS_SIGNING_SECRET ?? '';

  // The retry worker's only query (see ix_ans_retry). system_ingest reaches
  // ans_endpoints; the log rows themselves are tenant-scoped, so claim them
  // via the export actor role per tenant.
  const pending = await db.withSystemRole('system_ingest', async (client) => {
    const r = await client.query<{
      id: string; tenant_id: string; endpoint_id: string; delivery_id: string;
      event_type: string; payload: unknown; attempts: number; max_attempts: number;
      base_url: string; signing_key_id: string; is_active: boolean;
    }>(
      `SELECT l.id, l.tenant_id, l.endpoint_id, l.delivery_id, l.event_type,
              l.payload, l.attempts, l.max_attempts,
              e.base_url, e.signing_key_id, e.is_active
         FROM alumni_export_logs l
         JOIN ans_endpoints e ON e.id = l.endpoint_id
        WHERE l.status IN ('pending','failed')
          AND (l.next_attempt_at IS NULL OR l.next_attempt_at <= now())
        ORDER BY l.created_at
        LIMIT ${MAX_BATCH}`,
    );
    return r.rows;
  }).catch(() => [] as never[]);

  let delivered = 0;
  let failed = 0;
  let parked = 0;

  for (const row of pending) {
    const ctx = { tenantId: row.tenant_id, userId: '', role: 'academic_coordinator' };
    const body = JSON.stringify(row.payload ?? {});

    if (!row.is_active || !signingSecret) {
      parked += 1;
      await db.withTenant(ctx, (c) =>
        c.query(
          `UPDATE alumni_export_logs
              SET status = 'failed', attempts = attempts + 1,
                  error_code = $2,
                  next_attempt_at = now() + interval '6 hours'
            WHERE id = $1`,
          [row.id, row.is_active ? 'signing_key_unavailable' : 'endpoint_inactive'],
        ),
      );
      continue;
    }

    const signature = createHmac('sha256', signingSecret).update(body).digest('hex');
    try {
      const resp = await fetch(`${row.base_url.replace(/\/$/, '')}/v1/webhooks/lms`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Shikhon-Delivery-Id': row.delivery_id,
          'X-Shikhon-Event': row.event_type,
          'X-Shikhon-Key-Id': row.signing_key_id,
          'X-Shikhon-Signature': `sha256=${signature}`,
        },
        body,
        signal: AbortSignal.timeout(10_000),
      });
      const ok = resp.status >= 200 && resp.status < 300;
      await db.withTenant(ctx, (c) =>
        c.query(
          ok
            ? `UPDATE alumni_export_logs
                  SET status = 'delivered', attempts = attempts + 1, http_status = $2,
                      first_attempt_at = COALESCE(first_attempt_at, now()), completed_at = now()
                WHERE id = $1`
            : `UPDATE alumni_export_logs
                  SET status = CASE WHEN attempts + 1 >= max_attempts THEN 'dead_lettered'::ans_delivery_status
                                    ELSE 'failed'::ans_delivery_status END,
                      attempts = attempts + 1, http_status = $2,
                      first_attempt_at = COALESCE(first_attempt_at, now()),
                      next_attempt_at = now() + (interval '1 minute' * power(2, LEAST(attempts, 8)))
                WHERE id = $1`,
          [row.id, resp.status],
        ),
      );
      if (ok) delivered += 1; else failed += 1;
    } catch (err) {
      failed += 1;
      await db.withTenant(ctx, (c) =>
        c.query(
          `UPDATE alumni_export_logs
              SET status = CASE WHEN attempts + 1 >= max_attempts THEN 'dead_lettered'::ans_delivery_status
                                ELSE 'failed'::ans_delivery_status END,
                  attempts = attempts + 1, error_code = 'network_error', error_detail = $2,
                  first_attempt_at = COALESCE(first_attempt_at, now()),
                  next_attempt_at = now() + (interval '1 minute' * power(2, LEAST(attempts, 8)))
            WHERE id = $1`,
          [row.id, String((err as Error).message ?? err).slice(0, 500)],
        ),
      );
    }
  }

  json(res, 200, { ok: true, claimed: pending.length, delivered, failed, parked }, cors);
}

/* ------------------------------------------------------------- inbound */

async function inbound(req: IncomingMessage, res: ServerResponse, cors: Record<string, string>): Promise<void> {
  if (req.method !== 'POST') {
    json(res, 405, { error: 'method_not_allowed' }, cors);
    return;
  }

  const raw = await readBody(req);
  if (!raw || raw.length > 256 * 1024) {
    throw new HttpError(400, 'body required (max 256 KB)', 'invalid_body');
  }
  let parsed: { eventType?: string; eventId?: string; globalPersonId?: string } = {};
  try {
    parsed = JSON.parse(raw) as typeof parsed;
  } catch {
    throw new HttpError(400, 'body must be JSON', 'invalid_json');
  }
  const eventType = parsed.eventType ?? 'unknown';
  const eventId = parsed.eventId ?? createHash('sha256').update(raw).digest('hex').slice(0, 32);

  // Signature recorded, verified at apply time once per-endpoint inbound
  // secrets exist; rows only ever reach 'applied' after review.
  const sig = header(req, 'x-ans-signature');
  const sourceIp = (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim() ?? null;

  const db = await sharedDb();
  await db.withSystemRole('system_ingest', (client) =>
    client.query(
      `INSERT INTO ans_inbound_events
         (tenant_id, global_person_id, event_type, ans_event_id, raw_body, signature_valid, source_ip)
       VALUES (NULL, $1, $2, $3, $4, $5, $6)
       ON CONFLICT (endpoint_id, ans_event_id) DO NOTHING`,
      [
        UUID_RE.test(parsed.globalPersonId ?? '') ? parsed.globalPersonId : null,
        eventType,
        eventId,
        raw,
        sig ? null : false,
        sourceIp,
      ],
    ),
  );

  json(res, 202, { ok: true, staged: true }, cors);
}

/* ------------------------------------------------------------ dispatcher */

const ROUTES: Record<string, (req: IncomingMessage, res: ServerResponse, cors: Record<string, string>) => Promise<void>> = {
  students,
  dispatch,
  inbound,
};

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const cors = corsHeaders();
  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors);
    res.end();
    return;
  }
  const path = new URL(req.url ?? '/', 'http://internal').pathname;
  const sub = path.split('/').filter(Boolean).pop() ?? '';
  const route = ROUTES[sub];
  if (!route) {
    json(res, 404, { error: 'not_found' }, cors);
    return;
  }
  try {
    await route(req, res, cors);
  } catch (err) {
    if (err instanceof HttpError) {
      json(res, err.status, { error: err.code ?? 'error', message: err.message }, cors);
      return;
    }
    console.error(`[ans/${sub}] unexpected error`, err);
    json(res, 500, { error: 'internal_error' }, cors);
  }
}
