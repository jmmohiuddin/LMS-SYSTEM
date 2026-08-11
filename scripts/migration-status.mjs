#!/usr/bin/env node
/**
 * Which migrations are actually applied?
 *
 * This repository's migrations are not idempotent and nothing has ever
 * recorded what has run — scripts/migrate.sh says so in its own header.
 * That is survivable while there is one environment and one person, and it
 * stops being survivable the moment you have to ask "does production have
 * 016 through 019?" and nobody can answer.
 *
 * So this answers it by looking, not by trusting a ledger that does not
 * exist. Each migration is probed for a distinctive object it creates —
 * the last one, so a half-applied file reads as MISSING rather than
 * present. Read-only: it creates nothing and changes nothing.
 *
 *   DATABASE_URL='postgresql://…' node scripts/migration-status.mjs
 *   DATABASE_URL='postgresql://…' node scripts/migration-status.mjs --plan
 *
 * --plan additionally prints the exact psql commands to apply what is
 * missing, in order. It does not run them: applying DDL to a live database
 * holding children's records is a decision a person makes, and the owner
 * credential it needs is one this script deliberately never asks for.
 *
 * Exit codes: 0 fully migrated, 1 pending migrations, 2 could not connect.
 */
import pg from 'pg';
import { readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * One sentinel per migration: an object it creates, chosen from the END of
 * the file so a migration that died half-way is reported missing rather
 * than applied. `kind` maps to a catalogue lookup below.
 */
const SENTINELS = [
  ['001_extensions_and_tenancy',      'table',      'audit.platform_access'],
  ['002_identity_and_rbac',           'index',      'ix_otp_lookup'],
  ['003_academics',                   'function',   'app.refresh_section_count'],
  ['004_attendance',                  'function',   'app.queue_absence_sms'],
  ['005_assessment_nctb',             'function',   'app.compute_exam_gpa'],
  ['006_routines_rms',                'function',   'app.teacher_day'],
  ['007_finance_mfs',                 'function',   'app.apply_payment_to_invoice'],
  ['008_ai_and_vectors',              'function',   'app.nctb_retrieve'],
  ['009_alumni_hooks',                'function',   'app.emit_graduation_event'],
  ['010_rls_policies',                'policy',     'pre_tenant_ingest'],
  ['011_indexes_and_partitions',      'function',   'app.refresh_dashboards'],
  ['012_provisioning_and_reference',  'function',   'app.provision_tenant'],
  ['013_tenant_fk_integrity',         'constraint', 'mfs_webhook_events_tenant_fk'],
  ['014_sync_log_delete_guard',       'function',   'app.log_sync_change'],
  ['015_sync_operations_seq_reset',   'index',      'ix_sync_operations_device_seq'],
  ['016_finance_ledger_seed',         'function',   'app.provision_chart_step'],
  ['017_course_content',              'policy',     'progress_write_scope'],
  ['018_assignments',                 'policy',     'submission_update_scope'],
  ['019_practice',                    'policy',     'attempt_write_scope'],
  ['020_rate_limiting',               'function',   'app.prune_rate_limit_buckets'],
  ['021_pii_encryption_guards',       'index',      'ix_users_pii_key_version'],
  ['022_prerequisite_acyclicity',     'index',      'ix_chapters_prerequisite'],
  ['023_restrictive_write_scope_fix', 'policy',     'po_read_scope'],
  ['024_ai_content_human_review',     'index',      'ix_items_awaiting_review'],
  ['025_subject_based_academic_model','function',   'app.derive_student_subjects'],
];

/** What each migration unlocks, for the report. Blank where it is plumbing. */
const MEANING = {
  '016_finance_ledger_seed':         'chart of accounts — the fee engine has nothing to post to without it',
  '017_course_content':              'chapters, lessons, content blocks — the entire Learn tab',
  '018_assignments':                 'homework: assignments and submissions',
  '019_practice':                    'practice questions and attempts',
  '020_rate_limiting':               'F-102 — the gate on re-enabling login',
  '021_pii_encryption_guards':       'F-101 — national identifiers cannot be stored in plaintext',
  '022_prerequisite_acyclicity':     'F-104 — a prerequisite cannot close a loop',
  '023_restrictive_write_scope_fix': 'unbreaks EVERY student-facing read (chapters, practice, homework, fees)',
  '024_ai_content_human_review':     'F-1304 — AI content cannot reach a student unreviewed',
  '025_subject_based_academic_model':'PRD §5 — subject templates, curriculum schemes, derived subject sets',
};

const QUERIES = {
  table: `SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = split_part($1,'.',1) AND c.relname = split_part($1,'.',2)
             AND c.relkind IN ('r','p')`,
  index: `SELECT 1 FROM pg_class WHERE relname = $1 AND relkind = 'i'`,
  function: `SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
              WHERE n.nspname = split_part($1,'.',1) AND p.proname = split_part($1,'.',2)`,
  policy: `SELECT 1 FROM pg_policy WHERE polname = $1`,
  constraint: `SELECT 1 FROM pg_constraint WHERE conname = $1`,
};

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('DATABASE_URL is not set.\n'
    + 'Use a role that can read the catalogues — the pooled runtime URL is enough,\n'
    + 'and is preferable to the owner credential for a read-only check.');
  process.exit(2);
}

const client = new pg.Client({ connectionString: DATABASE_URL, statement_timeout: 15_000 });
try {
  await client.connect();
} catch (err) {
  console.error(`could not connect: ${err.message}`);
  process.exit(2);
}

// Files on disk are the source of truth for what SHOULD exist; a sentinel
// missing from this map means someone added a migration without adding its
// probe, and that must be loud rather than silently reported as applied.
const onDisk = readdirSync(join(ROOT, 'db', 'migrations'))
  .filter((f) => f.endsWith('.sql'))
  .map((f) => f.replace(/\.sql$/, ''))
  .sort();

const known = new Set(SENTINELS.map(([name]) => name));
const unprobed = onDisk.filter((m) => !known.has(m));

const results = [];
for (const [name, kind, object] of SENTINELS) {
  if (!onDisk.includes(name)) continue;   // sentinel for a deleted migration
  const { rowCount } = await client.query(QUERIES[kind], [object]);
  results.push({ name, applied: rowCount > 0, kind, object });
}
await client.end();

const applied = results.filter((r) => r.applied);
const pending = results.filter((r) => !r.applied);

// A gap — an applied migration AFTER a missing one — is the dangerous shape.
// It means the chain was not run in order, so "just run the pending ones"
// is not safe advice and the report must not give it.
const firstPendingIdx = results.findIndex((r) => !r.applied);
const outOfOrder = firstPendingIdx !== -1
  && results.slice(firstPendingIdx).some((r) => r.applied);

console.log('\n  migration                          state    unlocks');
console.log('  ' + '─'.repeat(76));
for (const r of results) {
  const mark = r.applied ? '[32mapplied[0m' : '[33mMISSING[0m';
  console.log(`  ${r.name.padEnd(34)} ${mark}  ${MEANING[r.name] ?? ''}`);
}

console.log(`\n  ${applied.length}/${results.length} applied.`);

if (unprobed.length) {
  console.log(`\n  [33m${unprobed.length} migration(s) have no sentinel and were NOT checked:[0m`);
  for (const m of unprobed) console.log(`    ${m}`);
  console.log('  Add them to SENTINELS in this script — an unchecked migration');
  console.log('  reports as neither applied nor pending, which is the worst answer.');
}

if (outOfOrder) {
  console.log('\n  [31mWARNING: a later migration is applied while an earlier one is not.[0m');
  console.log('  The chain was not applied in order. Do NOT simply run the missing');
  console.log('  files — they are not idempotent and may fail against a schema that');
  console.log('  has already moved past them. Investigate before touching anything.');
}

if (pending.length === 0) {
  console.log('  [32mFully migrated.[0m\n');
  process.exit(0);
}

if (process.argv.includes('--plan')) {
  console.log('\n  To apply, with the OWNER role on the DIRECT (non-pooled) endpoint:\n');
  console.log('    export DATABASE_MIGRATION_URL=\'postgresql://…\'   # not DATABASE_URL');
  for (const r of pending) {
    console.log(`    psql "$DATABASE_MIGRATION_URL" -v ON_ERROR_STOP=1 -f db/migrations/${r.name}.sql`);
  }
  console.log('\n  Then re-run the assertion suites against it:\n');
  for (const t of ['schema_lint', 'invariants', 'pii_encryption', 'grading_lock',
                   'prerequisite_cycles', 'ledger']) {
    console.log(`    psql "$DATABASE_MIGRATION_URL" -v ON_ERROR_STOP=1 -f db/tests/${t}.sql`);
  }
  console.log('\n  Each file is one transaction, so a failure leaves that migration');
  console.log('  unapplied rather than half-applied — re-run this script to confirm.\n');
} else {
  console.log('  Re-run with --plan for the exact commands.\n');
}

process.exit(1);
