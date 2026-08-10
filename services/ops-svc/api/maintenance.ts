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

const STEPS = [
  ['maintain_partitions', 'SELECT app.maintain_partitions()'],
  ['purge_expired_data', 'SELECT app.purge_expired_data()'],
  ['refresh_dashboards', 'SELECT app.refresh_dashboards()'],
  // F-102. Token buckets refill on read, so an idle bucket is indistinguishable
  // from a full one after `capacity / refill` seconds — anything untouched for
  // two days is dead weight. Purely a size control; dropping a row is
  // equivalent to that client's bucket being full, which it would be anyway.
  ['prune_rate_limit_buckets', 'SELECT app.prune_rate_limit_buckets()'],
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

  const authHeader = header(req, 'authorization');
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  const valid = [process.env.CRON_SECRET, process.env.SERVICE_API_KEY].filter(Boolean);
  if (!token || !valid.includes(token)) {
    json(res, 401, { error: 'unauthorized' }, cors);
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
      defaultPartitionLeakage: leak.rows,
    }, cors);
  } catch (err) {
    console.error('[ops/maintenance] connection failed', err);
    json(res, 500, { error: 'maintenance_connection_failed' }, cors);
  } finally {
    await client.end().catch(() => {});
  }
}
