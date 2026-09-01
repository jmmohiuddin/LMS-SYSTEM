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
  ['026_lessons_to_topics',           'index',      'ix_topics_chapter'],
  ['027_chapter_prerequisites_junction','table',     'public.chapter_prerequisites'],
  ['028_exam_routine_clash_gate',     'function',   'app.exam_student_clashes'],
  // 029 replaces a function body and creates no object, so it is probed by
  // looking inside the body for the join it adds. Blunt, but the honest
  // alternative — inventing an object purely to be probed — is worse.
  ['029_exam_clash_section_scope',    'function_body', 'app.exam_student_clashes',
                                      'e.section_id = p.section_id'],
  ['030_exam_seat_plan_and_invigilation', 'table',  'public.exam_halls'],
  ['031_bulk_import',                 'table',      'public.import_batches'],
  ['032_cross_shift_availability',    'function',   'app.cross_shift_conflicts'],
  ['033_year_rollover',               'function',   'app.commit_rollover'],
  ['034_parallel_blocks',             'function',   'app.assert_parallel_block_coherent'],
  ['035_double_periods',              'function',   'app.assert_double_period_coherent'],
  ['036_product_events',              'table',      'public.product_event_rollups'],
  ['037_activation_codes',            'table',      'public.activation_codes'],
  // 038 only ALTERs columns, so it is probed by the last CHECK constraint it
  // adds — the 'constraint' kind already existed; nothing needed inventing.
  ['038_submission_media',            'constraint', 'ck_submission_photo_has_no_duration'],
  ['039_tenant_branding',             'function',   'app.public_branding'],
  ['040_notices',                     'table',      'public.notice_receipts'],
  ['041_assignment_history',          'table',      'public.class_teacher_assignments'],
  // 042 adds only RLS policies and one function, so the function is the
  // sentinel — a policy is not something this script has a probe kind for,
  // and inventing one for a single migration would be the wrong trade.
  ['042_structure_write_scope',       'function',   'app.set_guardian_permissions'],
  // 043 adds columns and policies to an existing table; the UNIQUE
  // constraint it swaps in is the one new named object.
  ['043_calendar',                    'constraint', 'uq_calendar_entry'],
  // 044 adds exactly one object: the index that turns one student's
  // multi-year timeline from a scan into a seek.
  ['044_student_history_index',        'index',      'ix_enrolment_student_history'],
  // 045's headline object is the function that is the ONLY way a tenant
  // comes into existence. If it is missing, onboarding is back to SQL.
  ['045_platform_console',             'function',   'app.create_tenant'],
  // 046 adds no table and no column — three functions, of which this is the
  // one an outside party reaches. Absent, delivery reports 500 and the
  // product is back to not knowing whether a parent was ever texted.
  ['046_go_live_unlocks',              'function',   'app.record_sms_delivery'],
  // 047's one new table. Absent, `/ops/push` 500s and the notification
  // pipeline quietly falls back to SMS for everybody — which is safe, and
  // invisible, which is why it is probed.
  ['047_web_push',                     'table',      'public.push_subscriptions'],
  // 048 seeds reference rows and creates no object, so it is probed by the
  // rows themselves. Absent, a College provisions with classes and no
  // subjects — and cannot import a single student.
  ['048_higher_secondary_subjects',    'rows',       "subject_catalogue WHERE min_level_no >= 11"],
  // 049's one function. Absent, /academics/myroutine 500s and the student
  // home loses the card it was built around — the same absence P4 shipped
  // deliberately, which is why it needs probing rather than noticing.
  ['049_student_day',                  'function',   'app.student_day'],
  // 050's function. Absent, a guardian who has been unlinked keeps reading a
  // child's attendance, results and fees — and keeps receiving the absence
  // SMS. The column would be the more direct probe; the function is the one
  // whose absence a school would FEEL.
  ['050_guardianship_revocation',      'function',   'app.revoke_guardianship'],
];

/**
 * A migration whose objects a LATER migration legitimately removes.
 *
 * 022 put the F-104 acyclicity guard on `chapters.prerequisite_chapter_id`;
 * 027 moved that guard to the `chapter_prerequisites` junction and dropped
 * the column, its index and its trigger. So 022 leaves no trace on a
 * fully-migrated database, and probing for its sentinel reports MISSING
 * forever — which would be a permanently red check, and a permanently red
 * check is one nobody reads.
 *
 * A superseded migration counts as applied when its successor is applied.
 * If NEITHER is applied, both are reported missing, which is correct: the
 * guarantee is absent either way.
 */
const SUPERSEDED_BY = {
  '022_prerequisite_acyclicity': '027_chapter_prerequisites_junction',
};

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
  '026_lessons_to_topics':           'TRD §5.1 M6 — the content spine is chapter → topic, not lesson',
  '027_chapter_prerequisites_junction':'F-1404 — a chapter may need more than one predecessor',
  '028_exam_routine_clash_gate':     'F-510 — no student can be scheduled into two papers at once',
  '029_exam_clash_section_scope':    'unbreaks publication of EVERY multi-section exam routine',
  '030_exam_seat_plan_and_invigilation':'F-511/F-512 — seat plan and invigilation duty roster',
  '031_bulk_import':                 'F-1601 — bulk import; a child is reachable through their guardian',
  '032_cross_shift_availability':    'F-506 — a teacher cannot be booked in both shifts at once',
  '033_year_rollover':               'F-1605 — moving every child up a class, previewed before it lands',
  '034_parallel_blocks':             'F-504 — a religion split is four classes at one hour, not a clash',
  '035_double_periods':              'F-504 — a double period is two CONTIGUOUS halves, or it is a lie',
  '036_product_events':              'F-1503 — the pilot produces data; PII cannot enter it',
  '037_activation_codes':            'F-202 — first login without the SMS aggregator',
  '038_submission_media':            'F-902 — a photo or voice answer, with the guard that a photo has no duration',
  '039_tenant_branding':             'R-1 — a school sees its own name on its own login screen',
  '040_notices':                     'R-2 — the school can finally tell anybody anything',
  '041_assignment_history':          'R-3 — replacing a teacher stops erasing the last one',
  '042_structure_write_scope':       'R-3 — a teacher can no longer create a class or move a fee permission',
  '043_calendar':                    'R-4 — the school calendar becomes editable, and only by the right people',
  '044_student_history_index':       'R-6 — a student enrolment timeline becomes a seek, not a scan',
  '045_platform_console':            'R-7 — the platform can create a school, and only the platform can',
  '046_go_live_unlocks':             'R-8 — a delivery report can be recorded, and the AI budget is spent before it is billed',
  '047_web_push':                    'R-9 — a notice can reach a parent over the internet instead of over SMS',
  '048_higher_secondary_subjects':   'R-7 — a College and the upper half of a School & College get subjects at all',
  '049_student_day':                 'B-15 — a student can be told what class is next, section-scoped and parallel-block filtered',
  '050_guardianship_revocation':     'B-7 — a guardianship can end without being deleted, and a former guardian stops reading the child',
};

const QUERIES = {
  table: `SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = split_part($1,'.',1) AND c.relname = split_part($1,'.',2)
             AND c.relkind IN ('r','p')`,
  index: `SELECT 1 FROM pg_class WHERE relname = $1 AND relkind = 'i'`,
  function: `SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
              WHERE n.nspname = split_part($1,'.',1) AND p.proname = split_part($1,'.',2)`,
  // For migrations that only CREATE OR REPLACE: does the live body contain
  // the text the migration introduces?
  function_body: `SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                   WHERE n.nspname = split_part($1,'.',1) AND p.proname = split_part($1,'.',2)
                     AND p.prosrc LIKE '%' || $2 || '%'`,
  policy: `SELECT 1 FROM pg_policy WHERE polname = $1`,
  constraint: `SELECT 1 FROM pg_constraint WHERE conname = $1`,
  // For a migration that seeds REFERENCE DATA and creates no object. The
  // sentinel is a table name plus a WHERE clause; it is interpolated rather
  // than bound because a predicate cannot be a parameter, so the sentinels
  // above are the only source and none of them comes from outside this file.
  rows: null,
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
for (const [name, kind, object, pattern] of SENTINELS) {
  if (!onDisk.includes(name)) continue;   // sentinel for a deleted migration
  // `rows` probes seeded reference data, where the sentinel is a table plus a
  // predicate. A predicate cannot be a bound parameter, so it is interpolated
  // — safe here because SENTINELS is a literal in this file and nothing from
  // outside it ever reaches this string.
  const { rowCount } = kind === 'rows'
    ? await client.query(`SELECT 1 FROM ${object} LIMIT 1`)
    : await client.query(QUERIES[kind],
        kind === 'function_body' ? [object, pattern] : [object]);
  results.push({ name, applied: rowCount > 0, kind, object });
}
await client.end();

// Resolve supersession before anything reads the results, so the report,
// the exit code and the --plan all agree.
for (const r of results) {
  const successor = SUPERSEDED_BY[r.name];
  if (!r.applied && successor && results.find((x) => x.name === successor)?.applied) {
    r.applied = true;
    r.supersededBy = successor;
  }
}

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
