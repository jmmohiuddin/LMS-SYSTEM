/**
 * Run `db/tests/*.sql` against a real PostgreSQL, without psql on PATH.
 *
 * ── Why this exists ────────────────────────────────────────────────────────
 * These 26 suites are the only tests that exercise RLS, the RESTRICTIVE write
 * scopes, the EXCLUDE constraints and the SECURITY DEFINER functions as
 * PostgreSQL actually enforces them — a Node test can only ever check what a
 * handler did with the rows it got back. They need psql, because they use
 * `\set` and `:variables`, and they had been reporting
 *
 *     db/tests (sql)   0 of 26 — NOTHING RAN (psql is not on PATH)
 *
 * on every developer machine without a local PostgreSQL client install. Which
 * is honest, and is also 26 suites nobody was running.
 *
 * The database this project develops against is a Docker container, and that
 * container has psql inside it. So the client is present; it was only ever the
 * PATH that was missing. This runner pipes each file into the container's own
 * psql over stdin, which works because none of the 26 use `\i` or `\copy` —
 * checked, and asserted below so a future file that does cannot fail silently.
 *
 * ── What it deliberately does NOT do ───────────────────────────────────────
 * It does not shim a fake `psql` onto PATH, and it does not lower
 * ON_ERROR_STOP. A suite that raises fails, and its psql output is printed. The
 * point is to run them, not to make the line go green.
 *
 *   node scripts/sql-tests.mjs                  # all 26
 *   node scripts/sql-tests.mjs invariants       # one, by name fragment
 *   SQL_TEST_REPEAT=2 node scripts/sql-tests.mjs   # each suite twice
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync, execSync } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SQL_DIR = join(ROOT, 'db', 'tests');

/** The container and role are overridable; the defaults match `docs/13`. */
const CONTAINER = process.env.PG_CONTAINER ?? 'shikhon-r5';
const PGUSER = process.env.PG_OWNER_USER ?? 'shikhon_owner';
const PGDATABASE = process.env.PG_DATABASE ?? 'shikhon_ci';
const PGPASSWORD = process.env.PG_OWNER_PASSWORD ?? 'ci';
const REPEAT = Math.max(1, Number(process.env.SQL_TEST_REPEAT ?? 1));

function containerHasPsql() {
  const r = spawnSync('docker', ['exec', CONTAINER, 'psql', '--version'],
    { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
}

/**
 * Runs one file by piping it in. `-f -` rather than a path, because the file
 * lives on the host and psql lives in the container.
 */
function runSuite(file) {
  const sql = readFileSync(join(SQL_DIR, file), 'utf8');
  // `\i` and `\copy` resolve paths relative to the psql process, which is
  // inside the container and cannot see this repo. None of the 26 use them;
  // this refuses rather than running such a file with a silently wrong path.
  const bad = sql.match(/^\s*\\(i|ir|copy|include)\b/m);
  if (bad) {
    return { ok: false, out: `uses ${bad[0].trim()}, which cannot resolve a host path from inside the container` };
  }
  const r = spawnSync('docker', [
    'exec', '-i', '-e', `PGPASSWORD=${PGPASSWORD}`, CONTAINER,
    'psql', '-U', PGUSER, '-d', PGDATABASE, '-v', 'ON_ERROR_STOP=1', '-q', '-f', '-',
  ], { input: sql, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim();
  return { ok: r.status === 0, out };
}

if (!existsSync(SQL_DIR)) {
  console.error(`no ${SQL_DIR}`);
  process.exit(1);
}

const version = containerHasPsql();
if (!version) {
  console.error(
    `docker container "${CONTAINER}" is not running, or has no psql.\n` +
    `Start it (docker start ${CONTAINER}) or set PG_CONTAINER.`);
  process.exit(1);
}

const filter = process.argv[2];
const files = readdirSync(SQL_DIR)
  .filter((f) => f.endsWith('.sql'))
  .filter((f) => !filter || f.includes(filter))
  .sort();

console.log(`${version} (in ${CONTAINER})`);
console.log(`${files.length} suite(s)${REPEAT > 1 ? ` x${REPEAT}` : ''}\n`);

let pass = 0;
const failures = [];
for (let round = 1; round <= REPEAT; round++) {
  if (REPEAT > 1) console.log(`── round ${round} ──`);
  for (const f of files) {
    const { ok, out } = runSuite(f);
    if (ok) { pass++; console.log(`  ok    ${f}`); }
    else {
      failures.push({ f, round, out });
      console.log(`  FAIL  ${f}`);
    }
  }
}

if (failures.length) {
  console.log(`\n${failures.length} failure(s):\n`);
  for (const { f, round, out } of failures) {
    console.log(`── ${f}${REPEAT > 1 ? ` (round ${round})` : ''} ──`);
    console.log(out.split('\n').slice(-25).join('\n'));
    console.log();
  }
}

console.log(`\n${pass}/${files.length * REPEAT} SQL suite(s) passed`);
process.exit(failures.length ? 1 : 0);
