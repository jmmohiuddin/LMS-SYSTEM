/**
 * GET/POST /api/v1/ops/maintenance — the external scheduler docs/06 §5 calls
 * for. Neon parks background workers on suspended computes, so pg_cron can't
 * be trusted; Vercel Cron hits this daily (vercel.json, 19:00 UTC = 01:00
 * BST) and it runs, in order:
 *
 *   app.maintain_partitions()   pre-creates 3 months of partitions — if this
 *                               stops, inserts silently land in the DEFAULT
 *                               partition and every pruned plan degrades
 *   app.purge_expired_data()    retention windows (AI logs, SMS logs, OTP…)
 *   app.refresh_dashboards()    materialised views
 *
 * Auth: CRON_SECRET / SERVICE_API_KEY bearer, same as sms/dispatch.
 *
 * Connection: DATABASE_MAINTENANCE_URL — the OWNER role on the DIRECT
 * endpoint (same credential class as scripts/migrate.sh), because
 * maintain_partitions does DDL that shikhon_runtime deliberately cannot.
 * This is the one endpoint allowed to hold that connection, and it runs
 * ONLY these three catalog-driven calls — never a query that touches tenant
 * data, which is why bypassing the BYPASSRLS boot guard is safe here.
 * Without the env var it returns 503 maintenance_unconfigured (ships dark,
 * like the AI gateway without its key).
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import pg from 'pg';
import { corsHeaders, json, header } from '../../../packages/server-core/src/http.ts';
import { enforceRateLimit } from '../../../packages/server-core/src/rate-limit.ts';
import {
  matchServiceKey, looksLikeBrowser, keyFingerprint, logServiceKeyEvent,
} from '../../../packages/server-core/src/service-auth.ts';

const STEPS = [
  ['maintain_partitions', 'SELECT app.maintain_partitions()'],
  ['purge_expired_data', 'SELECT app.purge_expired_data()'],
  ['refresh_dashboards', 'SELECT app.refresh_dashboards()'],
  // F-102. Token buckets refill on read, so an idle bucket is indistinguishable
  // from a full one after `capacity / refill` seconds — anything untouched for
  // two days is dead weight. Purely a size control; dropping a row is
  // equivalent to that client's bucket being full, which it would be anyway.
  ['prune_rate_limit_buckets', 'SELECT app.prune_rate_limit_buckets()'],
  // F-1503. Recomputes a 7-day rollup window (late offline events land in
  // the day they OCCURRED) and prunes raw events past 90 days. Runs here,
  // as the owner, because shikhon_app deliberately cannot delete an
  // analytics row — an editable metric is a negotiable one.
  ['rollup_product_events', 'SELECT * FROM app.rollup_product_events()'],
] as const;

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const cors = corsHeaders();
  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors);
    res.end();
    return;
  }
  if (req.method !== 'GET' && req.method !== 'POST') {
    json(res, 405, { error: 'method_not_allowed' }, cors);
    return;
  }

  // F-102. Cron-only, but this is the one endpoint holding an owner-role
  // connection, so a loop here is the most expensive one to leave unbounded.
  if (!(await enforceRateLimit(req, res, cors, 'service'))) return;

  // R-8 §2. This is the one endpoint holding an owner-role connection, so it
  // is the one where a leaked key costs the most.
  const authHeader = header(req, 'authorization');
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  const keyLabel = matchServiceKey(token, process.env, { allowCron: true });
  if (!keyLabel) {
    json(res, 401, { error: 'unauthorized' }, cors);
    return;
  }
  const browserHeader = looksLikeBrowser(req);
  if (browserHeader) {
    logServiceKeyEvent({
      event: 'service_key_from_browser', endpoint: 'ops/maintenance',
      fingerprint: keyFingerprint(token), keyLabel, detail: browserHeader,
    });
    json(res, 403, { error: 'service_key_from_browser' }, cors);
    return;
  }

  const url = process.env.DATABASE_MAINTENANCE_URL;
  if (!url) {
    json(res, 503, {
      error: 'maintenance_unconfigured',
      message: 'DATABASE_MAINTENANCE_URL (owner role, direct endpoint) is not set',
    }, cors);
    return;
  }

  // One short-lived connection per run — this fires once a day; pooling
  // would only keep an owner-credential connection alive for no reason.
  const client = new pg.Client({ connectionString: url, statement_timeout: 120_000 });
  const results: Record<string, { ok: boolean; ms: number; error?: string }> = {};
  try {
    await client.connect();
    for (const [name, sql] of STEPS) {
      const started = Date.now();
      try {
        await client.query(sql);
        results[name] = { ok: true, ms: Date.now() - started };
      } catch (err) {
        results[name] = { ok: false, ms: Date.now() - started, error: String((err as Error).message).slice(0, 300) };
      }
    }
    // ── R-2: publish notices whose scheduled time has passed ──────────
    //
    // This is the whole scheduler. No new process, no queue, no
    // minute-resolution timer — the constraint was to use what already runs,
    // and a nightly job is what already runs. The cost is granularity, and the
    // composer says so where the time is chosen rather than implying
    // precision this cannot deliver.
    //
    // Per tenant, because publish_due_notices() is confined to one tenant by
    // design (the same assertion app.resolve_notice_audience uses). The owner
    // connection can enumerate tenants; the runtime role deliberately cannot,
    // which is the gap R-7's platform service closes.
    const scheduled: { tenantId: string; published: number }[] = [];
    try {
      const tenants = await client.query<{ id: string }>(
        `SELECT id FROM tenants WHERE status IN ('trial','active') AND deleted_at IS NULL`,
      );
      for (const t of tenants.rows) {
        // One transaction per tenant: a failure in one school's notices must
        // not roll back another's, and SET LOCAL needs a transaction anyway.
        try {
          await client.query('BEGIN');
          await client.query(
            `SELECT set_config('app.tenant_id', $1, true),
                    set_config('app.role', 'system_ingest', true)`,
            [t.id],
          );
          const due = await client.query<{ notice_id: string }>(
            `SELECT notice_id FROM app.publish_due_notices($1::uuid, 100)`,
            [t.id],
          );
          await client.query('COMMIT');
          if (due.rowCount) scheduled.push({ tenantId: t.id, published: due.rowCount });
        } catch (err) {
          await client.query('ROLLBACK').catch(() => {});
          console.error('[ops/maintenance] scheduled notices failed for', t.id, err);
        }
      }
      results.publish_due_notices = { ok: true, ms: 0 };
    } catch (err) {
      results.publish_due_notices = {
        ok: false, ms: 0, error: String((err as Error).message).slice(0, 300),
      };
    }

    // The canary docs/06 tells operators to watch — surfaced on every run.
    const leak = await client.query<{ relname: string; n: string }>(
      `SELECT relname, n_live_tup::text AS n
         FROM pg_stat_user_tables
        WHERE relname LIKE '%_default' AND n_live_tup > 0`,
    ).catch(() => ({ rows: [] as { relname: string; n: string }[] }));
    const allOk = Object.values(results).every((r) => r.ok);
    json(res, allOk ? 200 : 500, {
      ok: allOk,
      results,
      scheduledNoticesPublished: scheduled,
      defaultPartitionLeakage: leak.rows,
    }, cors);
  } catch (err) {
    console.error('[ops/maintenance] connection failed', err);
    json(res, 500, { error: 'maintenance_connection_failed' }, cors);
  } finally {
    await client.end().catch(() => {});
  }
}
