#!/usr/bin/env node
/**
 * M5 rehearsal — does an alert actually leave the building?
 *
 *   node scripts/alert-rehearsal.mjs
 *   exit 0 = a real HTTP POST carrying a real alert reached a real listener
 *
 * ── What this proves, and what it does not ──────────────────────────────
 * The runbook's §7 claim is that a stopped cron will wake somebody. Nothing
 * had ever tested the delivery half, and `docs/production-evidence.json` has
 * carried `alert_delivered: null` since it was written.
 *
 * This closes the machinery end. It boots the real ops-svc monitor endpoint,
 * puts the deployment into a condition that genuinely fires — DATABASE_URL
 * pointed at a closed port, so `database_unavailable` is EVALUATED rather than
 * injected — and receives the webhook POST on a real HTTPS listener, printing
 * the exact bytes that arrived and the moment they arrived.
 *
 * It does NOT close the production gate, and must never be recorded as
 * anything but `rehearsed`. Two links remain, and only the owner can supply
 * them:
 *
 *   1. ALERT_WEBHOOK_URL pointing somewhere a PERSON reads — a Slack or
 *      Discord incoming webhook, or an SMS/paging bridge.
 *   2. The observation that the message actually arrived on a handset, and
 *      when.
 *
 * The listener uses a self-signed certificate, so this harness sets
 * NODE_TLS_REJECT_UNAUTHORIZED=0 for the SERVER CHILD PROCESS ONLY. That is a
 * rehearsal artifact and one more reason it cannot stand in for the real run:
 * production must reach a webhook whose certificate verifies on its own.
 */
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:https';
import { randomBytes } from 'node:crypto';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = 4191;
const HOOK = 4192;
const SERVICE_KEY = 'rehearsal-service-key-' + randomBytes(8).toString('hex');

// A self-signed certificate for localhost. The point is only that the listener
// speaks TLS at all, because the product refuses a plain-http webhook.
const dir = mkdtempSync(join(tmpdir(), 'alert-rehearsal-'));
const keyPath = join(dir, 'k.pem');
const certPath = join(dir, 'c.pem');
try {
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', keyPath, '-out', certPath, '-days', '1',
    '-subj', '/CN=localhost',
    '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1',
  ], { stdio: 'ignore' });
} catch {
  console.error('openssl is required here: the product refuses a plain-http webhook,');
  console.error('so the rehearsal listener has to present a certificate.');
  process.exit(2);
}

const received = [];
const listener = createServer(
  { key: readFileSync(keyPath), cert: readFileSync(certPath) },
  (req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      received.push({
        at: new Date().toISOString(),
        method: req.method,
        url: req.url,
        contentType: req.headers['content-type'] ?? '',
        body,
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
    });
  },
);
await new Promise((r) => listener.listen(HOOK, '127.0.0.1', r));

const env = {
  ...process.env,
  PORT: String(PORT),
  HOST: '127.0.0.1',
  // A port nothing is listening on. The database really is unreachable, so the
  // alert really does fire. Nothing here injects an alert.
  //
  // MAINTENANCE, not DATABASE: the monitor reads the owner-role direct
  // endpoint, and without it answers 503 rather than a silent all-clear —
  // which is the right refusal and the first thing this rehearsal ran into.
  DATABASE_URL: 'postgres://nobody:nobody@127.0.0.1:59999/nothing',
  DATABASE_MAINTENANCE_URL: 'postgres://nobody:nobody@127.0.0.1:59999/nothing',
  ALERT_WEBHOOK_URL: 'https://127.0.0.1:' + HOOK + '/alert',
  SERVICE_API_KEY: SERVICE_KEY,
  APP_ENV: 'alert-rehearsal',
  NODE_TLS_REJECT_UNAUTHORIZED: '0',
};

const srv = spawn(process.execPath, ['deploy/server.mjs'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
const log = [];
srv.stdout.on('data', (d) => log.push(String(d)));
srv.stderr.on('data', (d) => log.push(String(d)));

const base = 'http://127.0.0.1:' + PORT;
async function waitUp() {
  for (let i = 0; i < 60; i++) {
    try { await fetch(base + '/api/v1/ops/brand?slug=x'); return true; } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

let failed = 0;
const check = (label, ok, extra) => {
  if (!ok) failed++;
  console.log('  ' + (ok ? 'PASS' : 'FAIL') + '  ' + label + (extra ? '\n        ' + extra : ''));
};

try {
  if (!(await waitUp())) throw new Error('server did not come up');
  console.log('\nM5 ALERT REHEARSAL — monitor -> webhook -> listener\n');

  // GET evaluates without delivering, which proves the condition is real
  // before anything is sent.
  const g = await fetch(base + '/api/v1/ops/monitor', {
    headers: { authorization: 'Bearer ' + SERVICE_KEY },
  });
  const gb = await g.json();
  check('the monitor accepts the service credential', g.status === 200, 'status ' + g.status);
  const firing = (gb.alerts ?? []).map((a) => a.id);
  check('a real condition is firing', firing.includes('database_unavailable'),
    'firing: ' + JSON.stringify(firing));
  check('GET did not deliver — asking must not page anybody', received.length === 0,
    received.length + ' webhook call(s) after GET');

  // POST evaluates AND delivers.
  const askedAt = new Date().toISOString();
  const p = await fetch(base + '/api/v1/ops/monitor', {
    method: 'POST', headers: { authorization: 'Bearer ' + SERVICE_KEY },
  });
  const pb = await p.json();
  check('POST reports the alert as delivered', pb.delivery?.delivered === true,
    JSON.stringify(pb.delivery ?? null));
  check('the listener actually received a POST', received.length === 1,
    received.length + ' call(s)');

  const r = received[0];
  if (r) {
    check('it carries the firing condition', r.body.includes('database_unavailable'));
    check('it names the environment it came from', r.body.includes('alert-rehearsal'));
    console.log('\n── what arrived ─────────────────────────────────────────');
    console.log('   asked at     : ' + askedAt);
    console.log('   received at  : ' + r.at);
    console.log('   destination  : https://127.0.0.1:' + HOOK + r.url + '  (' + r.method + ')');
    console.log('   content-type : ' + r.contentType);
    console.log('   body         :');
    console.log(String(r.body).split('\n').map((l) => '     ' + l).join('\n'));
    console.log('─────────────────────────────────────────────────────────');
  }

  if (failed === 0) {
    console.log('\nREHEARSAL PASSED — the pipeline delivers.');
    console.log('This is NOT a production gate. Point ALERT_WEBHOOK_URL at somewhere a');
    console.log('person reads, fire it, and record the handset observation under');
    console.log('alert_delivered in docs/production-evidence.json.\n');
  } else {
    console.log('\nREHEARSAL FAILED (' + failed + ')\n');
  }
} catch (e) {
  console.error(e);
  console.error(log.join(''));
  failed = 1;
} finally {
  // Set the code and let the loop drain, rather than process.exit() with a
  // TLS handle still open — on Windows that trips a libuv assertion and
  // prints a crash line under a passing run, which is a good way to have a
  // green result read as a failure.
  process.exitCode = failed === 0 ? 0 : 1;
  srv.kill();
  listener.closeAllConnections?.();
  listener.close();
}
