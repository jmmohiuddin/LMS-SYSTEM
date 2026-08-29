#!/usr/bin/env node
/**
 * Run every workspace's suite, and fail loudly if a workspace has tests that
 * nothing runs.
 *
 * This script exists because that failure kept happening silently. Test
 * scripts here enumerated their files by hand, so a new `test/*.test.ts` was
 * simply never executed — that is how the §10.3 screen shipped untested, and
 * how 13 server test files across four services sat un-run because those
 * services had no package.json at all. Every one of them passed the moment
 * they were wired up, which is the point: they were not failing, they were
 * invisible, and invisible is worse.
 *
 *   node scripts/test-all.mjs
 *   DATABASE_URL=postgres://… node scripts/test-all.mjs   # includes DB suites
 *
 * Without DATABASE_URL the DB-backed suites skip themselves and say so.
 *
 * ── Connect as the runtime role, not the owner ───────────────────────────
 * RLS is the security boundary in this system, and PostgreSQL exempts
 * superusers from it — FORCE ROW LEVEL SECURITY does not change that. Run
 * these as a superuser and the tenant-isolation tests fail with "tenant B's
 * session cannot reach tenant A's section", which reads as a catastrophic
 * product bug and is in fact a wrong connection string. The preflight below
 * refuses to run rather than let anyone spend an afternoon on that.
 */
import { readdirSync, existsSync, readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// fileURLToPath, not URL.pathname: this repo's path contains spaces, and
// pathname returns them percent-encoded, so every workspace lookup missed.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const GROUPS = ['packages', 'services', 'apps'];
// netlify/ is a workspace too — it holds the edge adapter every endpoint
// on that host sits behind, and its tests must not be invisible either.
const EXTRA = ['netlify'];

// Preflight. packages/server-core's assertRlsEnforced already refuses to
// start the app on a privileged role, but the DB suites call createDb
// directly and never reach it — which is why a superuser connection surfaces
// as a failing tenant-isolation test instead of a clear message. Catch it
// here, before anything runs.
if (process.env.DATABASE_URL) {
  const { default: pg } = await import('pg');
  const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
  try {
    await c.connect();
    const { rows } = await c.query(
      'SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user');
    const me = rows[0];
    if (me?.rolsuper || me?.rolbypassrls) {
      console.error(
        `\nERROR: DATABASE_URL connects as "${me.rolname}", which has ` +
        `${me.rolsuper ? 'SUPERUSER' : 'BYPASSRLS'}.\n` +
        'PostgreSQL exempts such roles from row-level security, so the\n' +
        'tenant-isolation tests would fail and look like a product bug.\n' +
        'Connect as the runtime role (see docs/06-DEPLOYMENT.md §3).');
      process.exit(1);
    }
  } finally { await c.end().catch(() => {}); }
}

// ── Two Windows faults this script was itself blind to ──────────────────
//
// 1. `npm` is npm.cmd there, and execFileSync does not use a shell, so
//    spawning "npm" fails with ENOENT (and Node ≥20 refuses .cmd without a
//    shell outright, EINVAL). Every workspace reported FAIL with no output:
//    eleven identical failures and not one error message, which reads as
//    "the repo is broken" rather than "the runner cannot find npm".
//
// 2. Worse, and quieter. The workspace scripts said
//    `node --test 'test/*.test.ts'`. A POSIX shell strips those quotes; cmd
//    passes them through literally, no file matches, and node exits 0 having
//    run nothing. On Windows the entire suite reported success while running
//    zero tests — precisely the invisible-tests failure this file exists to
//    prevent, in this file's own tooling. They are now double-quoted, which
//    both shells strip and node globs for itself.
//
// The second fault hid for so long because "ok" and "ok" look the same: a
// workspace that ran 153 tests and one that ran none both printed a tick.
// The reporting below now says "0 tests — NOTHING RAN" instead, which is
// legitimate for the DB-backed suites when DATABASE_URL is unset and is a
// bug in every other case. It is not a hard error precisely because of that
// first case; it is simply impossible to mistake for a pass.
const npmTest = (cwd) =>
  execSync('npm test --silent', { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

let failed = 0;
let orphaned = [];
const results = [];

for (const group of [...GROUPS, ...EXTRA]) {
  const dir = join(ROOT, group);
  if (!existsSync(dir)) continue;
  const isLeaf = EXTRA.includes(group);
  for (const name of (isLeaf ? [''] : readdirSync(dir).sort())) {
    const ws = isLeaf ? dir : join(dir, name);
    const hasTests = existsSync(join(ws, 'test'))
      // .mjs as well as .ts: the Netlify adapter is plain ESM, and a
      // detector that only knew about .test.ts would have made it invisible
      // in exactly the way this script exists to prevent.
      && readdirSync(join(ws, 'test')).some((f) => /\.test\.(ts|mjs|js)$/.test(f));
    const pkgPath = join(ws, 'package.json');
    const pkg = existsSync(pkgPath) ? JSON.parse(readFileSync(pkgPath, 'utf8')) : null;
    const script = pkg?.scripts?.test;

    // A workspace with test files and no way to run them is the exact
    // failure this script exists to prevent. It is an error, not a skip.
    if (hasTests && !script) { orphaned.push(`${group}/${name}`); continue; }
    if (!hasTests || !script) continue;

    process.stdout.write(`${(isLeaf ? group : group + '/' + name).padEnd(28)} `);
    try {
      const out = npmTest(ws);
      const pass = /^. tests (\d+)/m.exec(out)?.[1] ?? '?';
      const skip = /^. skipped (\d+)/m.exec(out)?.[1] ?? '0';
      const suites = /^. suites (\d+)/m.exec(out)?.[1] ?? '0';
      if (pass === '0') {
        console.log(`0 tests — NOTHING RAN${Number(suites) > 0
          ? ` (${suites} suite(s) skipped; set DATABASE_URL if they are DB-backed)`
          : ' (no test file matched)'}`);
      } else {
        console.log(`ok  ${pass} tests${skip !== '0' ? `, ${skip} skipped` : ''}`);
      }
      results.push(Number(pass) || 0);
    } catch (err) {
      failed++;
      console.log('FAIL');
      process.stdout.write(String(err.stdout ?? '').split('\n').slice(-40).join('\n'));
    }
  }
}

if (orphaned.length) {
  console.error(`\nERROR: workspaces with test files and no "test" script:\n  ${orphaned.join('\n  ')}`);
  console.error('Add: "test": "node --test \'test/*.test.ts\'"');
}

const total = results.reduce((a, b) => a + b, 0);
console.log(`\n${total} tests across ${results.length} workspaces` + (failed ? `, ${failed} workspace(s) FAILED` : ', all passing'));
process.exit(failed || orphaned.length ? 1 : 0);
