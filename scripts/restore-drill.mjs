#!/usr/bin/env node
/**
 * The restore drill.  (R-8 §5)
 *
 *   DRILL_SOURCE_URL=… DRILL_ADMIN_URL=… DRILL_TARGET_DB=shikhon_restore_drill \
 *     node scripts/restore-drill.mjs
 *
 * Takes a backup, restores it into an isolated database, and then — the part
 * that makes it a drill rather than a ceremony — **compares the restored copy
 * against the original, table by table and tenant by tenant**, and refuses to
 * report success on any mismatch.
 *
 * ── Why the comparison is the whole thing ───────────────────────────────
 * "The restore completed" is not evidence. `pg_restore` exits 0 having
 * skipped objects it could not create; a dump taken with the wrong flags
 * restores a schema with no rows in it; a partitioned table can come back
 * with its parent and none of its children. Every one of those produces a
 * successful-looking restore and a database that has lost a school's
 * attendance. So this script counts what went in, counts what came out, and
 * treats any difference as a failure — including a difference of zero rows in
 * a table that was empty to begin with, which is why the per-table list is
 * printed rather than summarised.
 *
 * ── What it measures, and what it cannot ────────────────────────────────
 * RTO is a measurement and this makes it: wall-clock from "decide to restore"
 * to "verified copy". RPO is NOT measurable here — it is a property of the
 * backup SCHEDULE, not of any restore, and a drill that claimed to measure it
 * would be measuring nothing. The script prints the RTO it observed and says
 * plainly that RPO comes from the backup configuration.
 *
 * ── Honesty about environment ───────────────────────────────────────────
 * The evidence block this prints carries the environment it actually ran in.
 * Run against a local Docker Postgres it says `local-docker`, and that is NOT
 * a production restore: production is Neon, restores are branch-based, and the
 * failure modes of a managed point-in-time restore are different ones. What a
 * local drill does prove is that the procedure, the verification queries and
 * the pass/fail criteria all work — so the production drill is a repeat of a
 * rehearsed thing rather than a first attempt during an incident.
 */
import { spawnSync } from 'node:child_process';
import pg from 'pg';

const SOURCE = process.env.DRILL_SOURCE_URL;
const ADMIN = process.env.DRILL_ADMIN_URL;
const TARGET_DB = process.env.DRILL_TARGET_DB ?? 'shikhon_restore_drill';
/** Run pg_dump/pg_restore inside this Docker container instead of on PATH. */
const DOCKER = process.env.DRILL_DOCKER ?? '';
const ENVIRONMENT = process.env.DRILL_ENVIRONMENT ?? (DOCKER ? 'local-docker' : 'unknown');

if (!SOURCE || !ADMIN) {
  console.error(
    'DRILL_SOURCE_URL and DRILL_ADMIN_URL are required.\n'
    + '  DRILL_SOURCE_URL  the database to back up\n'
    + '  DRILL_ADMIN_URL   a connection able to CREATE/DROP DATABASE\n'
    + '  DRILL_TARGET_DB   the isolated database to restore INTO (default shikhon_restore_drill)\n'
    + '  DRILL_DOCKER      optional container name to run pg_dump/pg_restore inside\n'
    + '  DRILL_ENVIRONMENT what to record in the evidence block');
  process.exit(2);
}

/* ── The comparison ───────────────────────────────────────────────────────
 * Named per the checklist R-8 §5 asks for, and expressed as counts because a
 * count is the one thing that cannot be right for the wrong reason.
 */
const ENTITY_COUNTS = {
  tenants: 'SELECT count(*)::int FROM tenants',
  users: 'SELECT count(*)::int FROM users',
  students: 'SELECT count(*)::int FROM student_profiles',
  teachers: 'SELECT count(*)::int FROM staff_profiles',
  guardians: 'SELECT count(*)::int FROM guardianships',
  enrolments: 'SELECT count(*)::int FROM enrolments',
  classes: 'SELECT count(*)::int FROM classes',
  sections: 'SELECT count(*)::int FROM sections',
  subjects: 'SELECT count(*)::int FROM subjects',
  attendance_sessions: 'SELECT count(*)::int FROM attendance_sessions',
  attendance_records: 'SELECT count(*)::int FROM attendance_records',
  exams: 'SELECT count(*)::int FROM exams',
  exam_marks: 'SELECT count(*)::int FROM exam_marks',
  exam_results: 'SELECT count(*)::int FROM exam_results',
  invoices: 'SELECT count(*)::int FROM invoices',
  invoice_lines: 'SELECT count(*)::int FROM invoice_lines',
  payment_receipts: 'SELECT count(*)::int FROM payment_receipts',
  ledger_entries: 'SELECT count(*)::int FROM ledger_entries',
  notices: 'SELECT count(*)::int FROM notices',
  notice_receipts: 'SELECT count(*)::int FROM notice_receipts',
  sms_outbox: 'SELECT count(*)::int FROM sms_outbox',
  push_subscriptions: 'SELECT count(*)::int FROM push_subscriptions',
  documents_meta: 'SELECT count(*)::int FROM nctb_documents',
  activation_codes: 'SELECT count(*)::int FROM activation_codes',
  audit_activity: 'SELECT count(*)::int FROM audit.activity_log',
  audit_platform: 'SELECT count(*)::int FROM audit.platform_access',
  sync_operations: 'SELECT count(*)::int FROM sync_operations',
  // There is deliberately no migrations table: migration state is derived
  // from sentinel objects in the catalogue (scripts/migration-status.mjs).
  // The schema counts above are what stands in for it here.
};

/** Structure, not data. A restore that loses a policy loses tenant isolation. */
const SCHEMA_COUNTS = {
  tables: `SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE c.relkind IN ('r','p') AND n.nspname IN ('public','audit')`,
  indexes: `SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE c.relkind = 'i' AND n.nspname IN ('public','audit')`,
  rls_enabled_tables: `SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                       WHERE c.relrowsecurity AND n.nspname IN ('public','audit')`,
  rls_policies: `SELECT count(*)::int FROM pg_policies WHERE schemaname IN ('public','audit')`,
  functions: `SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
              WHERE n.nspname IN ('app','audit')`,
  triggers: `SELECT count(*)::int FROM pg_trigger WHERE NOT tgisinternal`,
  attendance_partitions: `SELECT count(*)::int FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
                          JOIN pg_class p ON p.oid = i.inhparent WHERE p.relname = 'attendance_records'`,
};

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024, ...opts });
  if (r.error) throw r.error;
  return r;
}

/** pg_dump/pg_restore, on PATH or inside a container. */
function pgTool(tool, args) {
  return DOCKER
    ? run('docker', ['exec', '-i', DOCKER, tool, ...args])
    : run(tool, args);
}

async function counts(url, queries) {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  const out = {};
  for (const [name, sql] of Object.entries(queries)) {
    try {
      const r = await c.query(sql);
      out[name] = Number(Object.values(r.rows[0])[0]);
    } catch (err) {
      out[name] = `ERROR: ${err.message.split('\n')[0]}`;
    }
  }
  await c.end();
  return out;
}

/** Per-tenant, because a global total can hide one school restored empty. */
async function perTenant(url) {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  // Keyed by id, never by name. Two of the tenants on this very database are
  // both called মোহাম্মদপুর কলেজ, and matching on the display name silently
  // compared one of them against itself and reported a phantom mismatch. Two
  // real schools sharing a name is ordinary in Bangladesh, not a corner case.
  const { rows } = await c.query(`
    SELECT t.id::text AS id, t.name_bn,
           (SELECT count(*) FROM student_profiles s WHERE s.tenant_id = t.id)::int  AS students,
           (SELECT count(*) FROM staff_profiles  f WHERE f.tenant_id = t.id)::int   AS teachers,
           (SELECT count(*) FROM guardianships   g WHERE g.tenant_id = t.id)::int   AS guardians,
           (SELECT count(*) FROM attendance_records a WHERE a.tenant_id = t.id)::int AS attendance,
           (SELECT count(*) FROM exam_marks      m WHERE m.tenant_id = t.id)::int   AS marks,
           (SELECT count(*) FROM invoices        i WHERE i.tenant_id = t.id)::int   AS invoices
      FROM tenants t ORDER BY t.id`);
  await c.end();
  return rows;
}

const t0 = Date.now();
const stamp = () => ((Date.now() - t0) / 1000).toFixed(1);
const phase = [];

console.log(`restore drill · environment ${ENVIRONMENT} · target ${TARGET_DB}\n`);

/* ── 1. What is in the source ────────────────────────────────────────── */
console.log('[1] reading the source');
const srcSchema = await counts(SOURCE, SCHEMA_COUNTS);
const srcData = await counts(SOURCE, ENTITY_COUNTS);
const srcTenants = await perTenant(SOURCE);
console.log(`    ${srcData.tenants} tenants, ${srcData.students} students, `
  + `${srcData.attendance_records} attendance rows, ${srcSchema.rls_policies} RLS policies`);
phase.push(['read source', stamp()]);

/* ── 2. Back up ──────────────────────────────────────────────────────── */
console.log('[2] taking the backup');
const dumpStarted = Date.now();
const dumpPath = `/tmp/shikhon-drill-${Date.now()}.dump`;
const srcUrl = new URL(SOURCE);
const srcDbName = srcUrl.pathname.replace(/^\//, '');
const dumpArgs = ['-Fc', '-f', dumpPath, '--no-owner', '--no-privileges',
  '-d', DOCKER ? srcDbName : SOURCE];
if (DOCKER) dumpArgs.push('-U', decodeURIComponent(srcUrl.username));
const dump = pgTool('pg_dump', dumpArgs);
if (dump.status !== 0) {
  console.error('    BACKUP FAILED\n' + dump.stderr);
  process.exit(1);
}
const dumpSeconds = ((Date.now() - dumpStarted) / 1000).toFixed(1);
const size = DOCKER
  ? run('docker', ['exec', DOCKER, 'stat', '-c', '%s', dumpPath]).stdout.trim()
  : run('stat', ['-c', '%s', dumpPath]).stdout.trim();
console.log(`    ${(Number(size) / 1048576).toFixed(1)} MB in ${dumpSeconds}s`);
phase.push(['backup', stamp()]);

/* ── 3. Restore into an isolated database ────────────────────────────── */
console.log(`[3] restoring into ${TARGET_DB} (isolated, never over the source)`);
const restoreStarted = Date.now();
const admin = new pg.Client({ connectionString: ADMIN });
await admin.connect();
// Refuse to restore over the source. The single most expensive mistake
// available during a real incident is restoring onto the live database.
if (srcDbName === TARGET_DB) {
  console.error('    REFUSED: the target is the source database');
  process.exit(1);
}
await admin.query(`DROP DATABASE IF EXISTS ${TARGET_DB} WITH (FORCE)`);
await admin.query(`CREATE DATABASE ${TARGET_DB}`);
await admin.end();

const targetUrl = new URL(ADMIN);
targetUrl.pathname = `/${TARGET_DB}`;
const restoreArgs = ['--no-owner', '--no-privileges', '-d',
  DOCKER ? TARGET_DB : targetUrl.toString(), dumpPath];
if (DOCKER) restoreArgs.push('-U', decodeURIComponent(new URL(ADMIN).username));
const restore = pgTool('pg_restore', restoreArgs);
const restoreSeconds = ((Date.now() - restoreStarted) / 1000).toFixed(1);
// pg_restore exits 1 on warnings it recovered from; the comparison below is
// what decides, not the exit code — which is exactly the point of the drill.
console.log(`    pg_restore exit ${restore.status} in ${restoreSeconds}s`
  + (restore.status !== 0 ? ' (warnings below are judged by the comparison)' : ''));
if (restore.status !== 0) {
  const lines = restore.stderr.split('\n').filter(Boolean);
  console.log(`    ${lines.length} stderr line(s); first three:`);
  for (const l of lines.slice(0, 3)) console.log(`      ${l}`);
}
phase.push(['restore', stamp()]);

/* ── 4. Compare ──────────────────────────────────────────────────────── */
console.log('[4] verifying the restored copy against the source');
const dstSchema = await counts(targetUrl.toString(), SCHEMA_COUNTS);
const dstData = await counts(targetUrl.toString(), ENTITY_COUNTS);
const dstTenants = await perTenant(targetUrl.toString());

const mismatches = [];
const report = (label, src, dst) => {
  for (const k of Object.keys(src)) {
    const ok = String(src[k]) === String(dst[k]);
    if (!ok) mismatches.push(`${label}.${k}: source ${src[k]} → restored ${dst[k]}`);
    console.log(`    ${ok ? 'ok  ' : 'DIFF'} ${k.padEnd(24)} ${String(src[k]).padStart(8)}`
      + (ok ? '' : ` → ${dst[k]}`));
  }
};
console.log('  schema');
report('schema', srcSchema, dstSchema);
console.log('  data');
report('data', srcData, dstData);

console.log('  per tenant');
for (const s of srcTenants) {
  const d = dstTenants.find((x) => x.id === s.id);
  if (!d) {
    mismatches.push(`tenant missing after restore: ${s.name_bn} (${s.id})`);
    continue;
  }
  const same = ['students', 'teachers', 'guardians', 'attendance', 'marks', 'invoices']
    .every((k) => s[k] === d[k]);
  if (!same) {
    mismatches.push(`tenant ${s.name_bn} (${s.id}): `
      + `${JSON.stringify(s)} → ${JSON.stringify(d)}`);
  }
  console.log(`    ${same ? 'ok  ' : 'DIFF'} ${(`${s.name_bn} ${s.id.slice(0, 8)}`).padEnd(37)} `
    + `students ${String(s.students).padStart(4)} · teachers ${String(s.teachers).padStart(3)} · `
    + `guardians ${String(s.guardians).padStart(4)} · attendance ${String(s.attendance).padStart(5)} · `
    + `marks ${String(s.marks).padStart(4)} · invoices ${String(s.invoices).padStart(3)}`);
}
phase.push(['verify', stamp()]);

/* ── 5. Verdict ──────────────────────────────────────────────────────── */
const rto = stamp();
console.log(`\ntimings (cumulative seconds)`);
for (const [name, at] of phase) console.log(`  ${name.padEnd(14)} ${at}s`);
console.log(`\nRTO observed: ${rto}s from decision to verified copy.`);
console.log('RPO is NOT measured here — it is a property of the backup SCHEDULE,');
console.log('not of any restore, and this drill would be measuring nothing.');

if (mismatches.length > 0) {
  console.log(`\nFAILED — ${mismatches.length} mismatch(es):`);
  for (const m of mismatches) console.log(`  ${m}`);
  console.log('\nDo NOT record this as a passing drill.');
  process.exit(1);
}

console.log('\nPASSED — every schema object, every table and every tenant matched.');
console.log('\nEvidence block for docs/production-evidence.json:\n');
console.log(JSON.stringify({
  restore_drill: {
    status: 'verified',
    date: new Date().toISOString().slice(0, 10),
    environment: ENVIRONMENT,
    result: 'pass',
    evidence:
      `pg_dump -Fc (${(Number(size) / 1048576).toFixed(1)} MB, ${dumpSeconds}s) → `
      + `restore into isolated ${TARGET_DB} (${restoreSeconds}s) → `
      + `${Object.keys(SCHEMA_COUNTS).length} schema counts and `
      + `${Object.keys(ENTITY_COUNTS).length} table counts identical, `
      + `${srcTenants.length} tenants identical per entity. RTO ${rto}s.`,
  },
}, null, 2));
console.log(
  `\nNOTE: environment is "${ENVIRONMENT}". If that is not the production`
  + '\nhost, this does not close the production restore gate — it rehearses it.');
