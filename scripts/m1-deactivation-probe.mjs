#!/usr/bin/env node
/**
 * M1 live probe — the audit's exact experiment, re-run over real HTTP.
 *
 *   DATABASE_URL=postgres://... node scripts/m1-deactivation-probe.mjs
 *   exit 0 = the hole is closed
 *
 * ── Why this exists next to the unit tests ──────────────────────────────
 * `services/identity-svc/test/deactivation.test.ts` covers the same ground
 * through the in-process `call()` harness. This runs the endpoint the way an
 * attacker would: it boots `deploy/server.mjs` — the actual production glue,
 * not a stand-in — and talks to it with `fetch`. The audit's finding was made
 * this way, so its refutation is made this way too.
 *
 * The experiment, verbatim from the audit:
 *
 *   plant a valid refresh session for a real principal
 *   UPDATE users SET status = 'left'
 *   POST /api/v1/auth/refresh
 *
 * Before M1 that returned 200 and an access token carrying `role: principal`.
 * It now returns 403 `account_not_active`.
 *
 * Note that the session is planted DIRECTLY in the table rather than by
 * deactivating through the ops endpoint. That is deliberate: it bypasses the
 * revocation layer so the probe measures the endpoint's own status check,
 * which is the layer that has to hold when a status changes by any other
 * route — an import, a support fix, a code path not yet written.
 *
 * Both negatives are paired with positives (active refreshes; reactivated
 * refreshes again) so a wholly broken endpoint cannot pass as a secure one.
 */
import { spawn } from 'node:child_process';
import { randomBytes, createHash, generateKeyPairSync } from 'node:crypto';
import { createDb } from '../packages/server-core/src/db.ts';

const DATABASE_URL = process.env.DATABASE_URL;
const PORT = 4188;
const BASE = `http://127.0.0.1:${PORT}`;

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const env = {
  ...process.env,
  PORT: String(PORT), HOST: '127.0.0.1', DATABASE_URL,
  JWT_PRIVATE_KEY: privateKey.export({ type: 'pkcs8', format: 'pem' }),
  JWT_PUBLIC_KEY: publicKey.export({ type: 'spki', format: 'pem' }),
  ACTIVATION_PEPPER: 'live-probe-pepper-0123456789abcdef',
};

const T    = '7af00000-0000-4000-8000-00000000000a';
const HEAD = '7af00000-0000-4000-8000-0000000000ff';

/* The bootstrap context the fixtures need: RLS is FORCEd, so even seeding
 * goes through the same gate the application does. skipGate is the same
 * escape the test harness uses, and nothing else in this file uses it. */
const db = createDb(DATABASE_URL);
const ctx = { tenantId: T, userId: HEAD, role: 'principal' };
const sql = (q, p) => db.withTenant(ctx, (c) => c.query(q, p), { skipGate: true, write: true });

async function seed() {
  await sql('DELETE FROM tenants WHERE id = $1', [T]);
  await sql(`INSERT INTO tenants (id, slug, name_bn, name_en, stream, level)
             VALUES ($1,'m1-live','লাইভ','Live','bangla_medium','secondary')`, [T]);
  await sql(`INSERT INTO users (id, tenant_id, full_name_bn, full_name_en, phone_e164, status)
             VALUES ($1,$2,'প্রধান শিক্ষক','Head','+8801799620001','active')`, [HEAD, T]);
  await sql(`INSERT INTO user_roles (tenant_id, user_id, role_code) VALUES ($1,$2,'principal')`, [T, HEAD]);
}

/** Plant a refresh session exactly as the audit did, and hand back the token. */
async function plantSession() {
  const token = randomBytes(32).toString('base64url');
  const hash = createHash('sha256').update(token).digest();
  await sql(`INSERT INTO user_sessions (tenant_id, user_id, refresh_token_hash, device_id, expires_at)
             VALUES ($1,$2,$3,'live-probe-device', now() + interval '30 days')`, [T, HEAD, hash]);
  return token;
}

const refresh = (refreshToken) =>
  fetch(`${BASE}/api/v1/auth/refresh`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tenantId: T, refreshToken, deviceId: 'live-probe-device' }),
  }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));

const srv = spawn(process.execPath, ['deploy/server.mjs'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
srv.stderr.on('data', (d) => process.stderr.write(`[srv] ${d}`));

async function waitUp() {
  for (let i = 0; i < 60; i++) {
    try { await fetch(`${BASE}/api/v1/ops/health`); return true; } catch { }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

let failed = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`);
};

try {
  if (!(await waitUp())) throw new Error('server did not come up');
  await seed();

  console.log('\nM1 LIVE PROBE — real HTTP against deploy/server.mjs\n');

  // ── POSITIVE: an active principal refreshes ──
  const t1 = await plantSession();
  const a = await refresh(t1);
  check('active principal refreshes', a.status, 200);
  console.log(`        role in new token: ${JSON.parse(Buffer.from(a.body.accessToken.split('.')[1], 'base64url')).role}`);

  // ── NEGATIVE: the audit's experiment, verbatim ──
  const t2 = await plantSession();
  await sql(`UPDATE users SET status = 'left' WHERE id = $1`, [HEAD]);
  const b = await refresh(t2);
  check('deactivated principal is refused', b.status, 403);
  check('  ... and the reason is named', b.body?.error, 'account_not_active');
  check('  ... with the state in the message', b.body?.message, 'account is left');
  check('  ... and no token is issued', b.body?.accessToken, undefined);

  // ── the account is genuinely restorable ──
  await sql(`UPDATE users SET status = 'active' WHERE id = $1`, [HEAD]);
  const t3 = await plantSession();
  const c = await refresh(t3);
  check('reactivated principal refreshes again', c.status, 200);

  console.log(`\n${failed === 0 ? 'LIVE PROBE PASSED' : `LIVE PROBE FAILED (${failed})`}\n`);
} catch (e) {
  console.error(e);
  failed = 1;
} finally {
  await sql('DELETE FROM tenants WHERE id = $1', [T]).catch(() => {});
  await db.end();
  srv.kill();
  process.exit(failed === 0 ? 0 : 1);
}
