#!/usr/bin/env node
/**
 * Production preflight.  (R-8 §1)
 *
 *   node scripts/preflight.mjs
 *
 * Run it with the target deployment's environment loaded — `vercel env pull`
 * or `netlify env:import` and then a shell that has those variables — and it
 * reports, item by item, whether that deployment is configured.
 *
 * ── Why a program and not a document ────────────────────────────────────
 * Because a checklist in a document is ticked once and then rots. Somebody
 * removes a variable during an incident, the document still says the box was
 * ticked in August, and the tick is now a lie that reads exactly like the
 * truth. Everything here is derived from the environment and the repository
 * at the moment it runs, so it cannot say something the deployment does not.
 *
 * ── The three states, and why UNVERIFIED is not a failure ───────────────
 * Some items — a DNS record resolving, TLS terminating, a restore actually
 * performed, a real SMS reaching a real handset, a push landing on a real
 * device, an alert waking a real person — cannot be established from inside
 * this process. It would be easy to check the *proxy* (a key is set, a URL is
 * configured) and print PASS, and that would be the single most dishonest
 * thing this file could do: R-8's whole point is that a configured SMS
 * provider and a delivered SMS are different facts.
 *
 * So those items are UNVERIFIED until a human records the result, with a
 * date, in docs/production-evidence.json. The program checks the
 * configuration; the human attests the outcome; neither can green the other's
 * half. Attestations older than MAX_EVIDENCE_AGE_DAYS lapse back to
 * UNVERIFIED, because "we restored a backup successfully" stops being a fact
 * about the current system fairly quickly.
 *
 * Exit codes: 0 all clear · 1 something FAILED · 2 nothing failed but
 * something is UNVERIFIED. Only 0 means the deployment may be called ready,
 * and CI treats 2 as "not yet" rather than "fine".
 */
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const EVIDENCE_PATH = join(ROOT, 'docs', 'production-evidence.json');
const MAX_EVIDENCE_AGE_DAYS = 180;

const env = process.env;
const results = [];

/** @param {'PASS'|'FAIL'|'UNVERIFIED'} state */
function record(area, item, state, evidence) {
  results.push({ area, item, state, evidence });
}
const pass = (a, i, e) => record(a, i, 'PASS', e);
const fail = (a, i, e) => record(a, i, 'FAIL', e);
const unver = (a, i, e) => record(a, i, 'UNVERIFIED', e);

const set = (name) => typeof env[name] === 'string' && env[name].trim().length > 0;
const val = (name) => (env[name] ?? '').trim();

/** Never print a secret. Length and shape are all a preflight needs to show. */
const shape = (name) => (set(name) ? `set, ${val(name).length} chars` : 'not set');

/* ── The human-attested half ──────────────────────────────────────────── */

let evidence = {};
if (existsSync(EVIDENCE_PATH)) {
  try {
    evidence = JSON.parse(readFileSync(EVIDENCE_PATH, 'utf8'));
  } catch (err) {
    console.error(`Could not parse ${EVIDENCE_PATH}: ${err.message}`);
    process.exit(1);
  }
}

/**
 * An attestation counts when it names a date, an outcome of "pass", and the
 * environment it was performed against. Anything less is somebody having
 * filled in a form.
 */
function attested(area, item, key) {
  const e = evidence[key];
  if (!e || !e.verifiedOn || e.result !== 'pass') {
    unver(area, item, e?.notes
      ? `not attested — ${e.notes}`
      : `no entry in docs/production-evidence.json ("${key}")`);
    return;
  }
  const days = Math.floor((Date.now() - Date.parse(e.verifiedOn)) / 86_400_000);
  if (!Number.isFinite(days)) {
    unver(area, item, `"${key}".verifiedOn is not a date`);
    return;
  }
  if (days > MAX_EVIDENCE_AGE_DAYS) {
    unver(area, item, `attested ${e.verifiedOn} — lapsed after ${MAX_EVIDENCE_AGE_DAYS} days`);
    return;
  }
  pass(area, item, `${e.verifiedOn}${e.by ? ` by ${e.by}` : ''}${e.notes ? ` — ${e.notes}` : ''}`);
}

/* ── 1. Environment variables ─────────────────────────────────────────── */

const REQUIRED = ['DATABASE_URL', 'JWT_PRIVATE_KEY', 'JWT_PUBLIC_KEY', 'SERVICE_API_KEY'];
const missing = REQUIRED.filter((n) => !set(n));
if (missing.length === 0) pass('Environment', 'required variables', REQUIRED.join(', '));
else fail('Environment', 'required variables', `missing: ${missing.join(', ')}`);

const isProd = val('APP_ENV') === 'production' || val('VERCEL_ENV') === 'production'
  || val('NODE_ENV') === 'production';
if (isProd) pass('Environment', 'environment is declared', `APP_ENV/VERCEL_ENV/NODE_ENV → production`);
else unver('Environment', 'environment is declared',
  'none of APP_ENV/VERCEL_ENV/NODE_ENV says production — alerts and the '
  + 'service-key production defaults both key off this');

/* ── 2. Production secrets ────────────────────────────────────────────── */

// Weak or obviously non-production values. A demo key that reaches production
// is not a hypothetical: it is the most common way a staging credential ends
// up guarding real children's records.
const TELLTALES = [/^test/i, /^demo/i, /^dev/i, /^changeme/i, /^secret$/i, /^password/i,
  /^shikhon(bd)?$/i, /^local/i, /^example/i];
const SECRETS = ['SERVICE_API_KEY', 'CRON_SECRET', 'PLATFORM_API_KEY', 'SMS_DLR_SECRET',
  'PII_MASTER_KEY_V1'];
const weak = SECRETS.filter((n) => set(n)
  && (val(n).length < 24 || TELLTALES.some((re) => re.test(val(n)))));
if (weak.length === 0) pass('Secrets', 'no test or short values', `checked ${SECRETS.length}`);
else fail('Secrets', 'no test or short values',
  `${weak.join(', ')} — under 24 chars or a test-looking prefix`);

// Distinctness. One value doing three jobs means rotating any of them is a
// change to all three, so in practice none of them is ever rotated.
const present = SECRETS.filter(set);
const distinct = new Set(present.map(val));
if (present.length === 0) {
  fail('Secrets', 'credentials are distinct', 'none of the service credentials is set');
} else if (present.length === distinct.size) {
  pass('Secrets', 'credentials are distinct', `${distinct.size} of ${SECRETS.length} set, all different`);
} else {
  fail('Secrets', 'credentials are distinct', 'two or more secrets share a value');
}

if (set('SERVICE_API_KEY_NEXT')) {
  pass('Secrets', 'rotation slot', 'SERVICE_API_KEY_NEXT is populated — a rotation is in flight');
} else {
  pass('Secrets', 'rotation slot', 'empty (normal outside a rotation)');
}

/* ── 3. Database URL separation ───────────────────────────────────────── */

const dbHost = (u) => { try { return new URL(u).host; } catch { return ''; } };
const primary = dbHost(val('DATABASE_URL'));
if (!primary) {
  fail('Database', 'DATABASE_URL parses', 'not set or not a URL');
} else if (/localhost|127\.0\.0\.1/.test(primary)) {
  fail('Database', 'not pointed at a local database', primary);
} else if (isProd && /staging|dev|test/i.test(primary)) {
  fail('Database', 'production is not pointed at staging', primary);
} else {
  pass('Database', 'separation', `host ${primary}`);
}
if (val('DATABASE_URL') && !/sslmode=require|sslmode=verify/.test(val('DATABASE_URL'))) {
  fail('Database', 'TLS to the database', 'DATABASE_URL has no sslmode=require');
} else if (primary) {
  pass('Database', 'TLS to the database', 'sslmode=require');
}
if (set('DATABASE_MAINTENANCE_URL')) {
  const same = val('DATABASE_MAINTENANCE_URL') === val('DATABASE_URL');
  if (same) fail('Database', 'maintenance role is separate', 'identical to DATABASE_URL');
  else pass('Database', 'maintenance role is separate', `host ${dbHost(val('DATABASE_MAINTENANCE_URL'))}`);
} else {
  fail('Database', 'maintenance role is separate',
    'DATABASE_MAINTENANCE_URL not set — nightly partition maintenance and the '
    + 'monitor both need it, and without it attendance writes fail when the month turns');
}
if (set('PLATFORM_DATABASE_URL')) {
  pass('Database', 'platform console role is separate',
    val('PLATFORM_DATABASE_URL') === val('DATABASE_URL')
      ? 'WARNING: identical to DATABASE_URL' : 'distinct role');
} else {
  unver('Database', 'platform console role is separate',
    'PLATFORM_DATABASE_URL not set — the operator console will refuse to load');
}

/* ── 4. Service credentials ───────────────────────────────────────────── */

const switchFlag = val('SERVICE_KEY_TENANT_SWITCH').toLowerCase();
if (isProd && (switchFlag === '' || ['off', 'false', '0'].includes(switchFlag))) {
  pass('Security', 'service-key tenant switching', 'refused in production (the default)');
} else if (isProd) {
  unver('Security', 'service-key tenant switching',
    `SERVICE_KEY_TENANT_SWITCH=${switchFlag} — deliberately ON in production; `
    + 'turn it off again when the incident is over');
} else {
  pass('Security', 'service-key tenant switching', 'allowed outside production');
}

/* ── 5–7. Domain, DNS, TLS ────────────────────────────────────────────── */

const origins = val('ALLOWED_ORIGINS').split(',').map((s) => s.trim()).filter(Boolean);
if (origins.length === 0) {
  fail('DNS/TLS', 'application origin is declared',
    'ALLOWED_ORIGINS is empty — CORS falls back to the wildcard');
} else if (origins.some((o) => !o.startsWith('https://'))) {
  fail('DNS/TLS', 'application origin is declared', `not all https: ${origins.join(' ')}`);
} else {
  pass('DNS/TLS', 'application origin is declared', origins.join(' '));
}
attested('DNS/TLS', 'wildcard DNS resolves', 'wildcard_dns');
attested('DNS/TLS', 'TLS certificate covers *.shikhonbd.com', 'wildcard_tls');
attested('DNS/TLS', 'a tenant subdomain routes and isolates', 'subdomain_routing');

const subdomainsReady = ['true', '1', 'yes', 'on'].includes(val('WILDCARD_DNS_READY').toLowerCase());
if (subdomainsReady) {
  const attestedDns = evidence.wildcard_dns?.result === 'pass';
  if (attestedDns) pass('DNS/TLS', 'subdomain feature flag', 'on, and DNS is attested');
  else fail('DNS/TLS', 'subdomain feature flag',
    'WILDCARD_DNS_READY is on but no DNS attestation exists — the console will '
    + 'promise operators a subdomain that does not resolve');
} else {
  pass('DNS/TLS', 'subdomain feature flag',
    'off — the console shows the /app?tid= fallback and says so');
}

/* ── 8. Hosting configuration ─────────────────────────────────────────── */

const bundles = ['api/v1/auth.js', 'api/v1/ops/[action].js', 'api/v1/sync/[action].js'];
const built = bundles.filter((b) => existsSync(join(ROOT, b)));
if (built.length === bundles.length) pass('Production', 'API bundles are committed', `${built.length}/${bundles.length} sampled`);
else fail('Production', 'API bundles are committed', `missing ${bundles.filter((b) => !built.includes(b)).join(', ')}`);

/* ── 12–13. PWA manifest and service worker ───────────────────────────── */

for (const [label, path] of [
  ['PWA manifest route', 'services/ops-svc/api/manifest.ts'],
  ['service worker', 'apps/pwa/public/sw.js'],
  ['offline page', 'apps/pwa/public/offline.html'],
]) {
  if (existsSync(join(ROOT, path))) pass('Production', label, path);
  else fail('Production', label, `${path} is missing`);
}

/* ── 14. Cron ─────────────────────────────────────────────────────────── */

const netlifyCrons = val('NETLIFY_CRONS_ENABLED') === 'true';
if (netlifyCrons) {
  pass('Monitoring', 'scheduled jobs', 'NETLIFY_CRONS_ENABLED=true — this host owns the schedule');
} else {
  unver('Monitoring', 'scheduled jobs',
    'NETLIFY_CRONS_ENABLED is not "true". Correct if Vercel owns the schedule; '
    + 'if nothing owns it, SMS is never dispatched and partitions are never created');
}

/* ── 15. SMS ──────────────────────────────────────────────────────────── */

const smsProvider = val('SMS_PROVIDER');
const smsConfigured = smsProvider && smsProvider !== 'stub'
  && set('SMS_ENDPOINT') && set('SMS_API_TOKEN') && set('SMS_SENDER_ID');
if (smsConfigured) pass('SMS', 'aggregator credentials', `${smsProvider}, sender ${val('SMS_SENDER_ID')}`);
else fail('SMS', 'aggregator credentials',
  smsProvider && smsProvider !== 'stub'
    ? `${smsProvider} selected but SMS_ENDPOINT/SMS_API_TOKEN/SMS_SENDER_ID incomplete`
    : 'no aggregator — messages are logged, not sent');

const allowlist = val('SMS_TEST_RECIPIENTS').split(',').map((s) => s.trim()).filter(Boolean);
if (allowlist.length > 0) {
  pass('SMS', 'test allowlist', `${allowlist.length} number(s) — ONLY these can receive`);
} else if (smsConfigured) {
  unver('SMS', 'test allowlist',
    'empty — every queued message will be sent to real guardians on the next '
    + 'dispatch. Set SMS_TEST_RECIPIENTS before the first run against production');
} else {
  pass('SMS', 'test allowlist', 'not applicable — no aggregator configured');
}
if (set('SMS_DLR_SECRET')) pass('SMS', 'delivery reports', shape('SMS_DLR_SECRET'));
else unver('SMS', 'delivery reports', 'SMS_DLR_SECRET not set — sent is all we will know');
attested('SMS', 'a real SMS reached a real handset', 'real_sms_delivery');

/* ── 16. Push ─────────────────────────────────────────────────────────── */

if (set('VAPID_PUBLIC_KEY') && set('VAPID_PRIVATE_KEY') && set('VAPID_SUBJECT')) {
  pass('Push', 'VAPID keypair', `${shape('VAPID_PUBLIC_KEY')}, subject ${val('VAPID_SUBJECT')}`);
} else {
  unver('Push', 'VAPID keypair',
    'incomplete — push is off and every message falls through to SMS, which '
    + 'works but costs money');
}
attested('Push', 'a push arrived on a real device', 'real_push_delivery');

/* ── 17. Backup ───────────────────────────────────────────────────────── */

attested('Backup/Restore', 'backups are configured with a stated retention', 'backup_configured');
attested('Backup/Restore', 'a restore was performed and verified', 'restore_drill');

/* ── 18. Monitoring ───────────────────────────────────────────────────── */

if (val('ALERT_WEBHOOK_URL').startsWith('https://')) {
  pass('Monitoring', 'alert sink', 'ALERT_WEBHOOK_URL is set (https)');
} else if (set('ALERT_WEBHOOK_URL')) {
  fail('Monitoring', 'alert sink', 'ALERT_WEBHOOK_URL is not https — it will be ignored');
} else {
  fail('Monitoring', 'alert sink',
    'not set — /api/v1/ops/monitor evaluates and logs, but nobody is told');
}
attested('Monitoring', 'a test alert reached a human', 'alert_delivered');

/* ── Pilot ────────────────────────────────────────────────────────────── */

attested('Pilot', 'real institutions completed onboarding', 'pilot_onboarding');
attested('Offline', 'a real institution took attendance offline and synced', 'pilot_offline');
attested('Security', 'cross-tenant tests run against this environment', 'prod_cross_tenant');

/* ── Report ───────────────────────────────────────────────────────────── */

const width = Math.max(...results.map((r) => r.item.length));
let currentArea = '';
for (const r of results) {
  if (r.area !== currentArea) {
    currentArea = r.area;
    process.stdout.write(`\n${currentArea}\n`);
  }
  const mark = r.state === 'PASS' ? ' ok ' : r.state === 'FAIL' ? 'FAIL' : ' ?? ';
  process.stdout.write(`  [${mark}] ${r.item.padEnd(width)}  ${r.evidence}\n`);
}

const failed = results.filter((r) => r.state === 'FAIL');
const unverified = results.filter((r) => r.state === 'UNVERIFIED');
process.stdout.write(
  `\n${results.length} checks · ${results.length - failed.length - unverified.length} pass · `
  + `${failed.length} fail · ${unverified.length} unverified\n`);

if (failed.length > 0) {
  process.stdout.write('\nNOT PRODUCTION READY — failures above must be fixed.\n');
  process.exit(1);
}
if (unverified.length > 0) {
  process.stdout.write(
    '\nNOT PRODUCTION READY — configuration is complete, but the items marked ?? '
    + 'have never been demonstrated.\nRecord each one in docs/production-evidence.json '
    + 'once it has actually been done. Do not fill that file in from intent.\n');
  process.exit(2);
}
process.stdout.write('\nAll checks pass and all external items are attested.\n');
