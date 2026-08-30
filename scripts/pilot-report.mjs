#!/usr/bin/env node
/**
 * The pilot record.  (R-8 §11)
 *
 *   PILOT_DB_URL=postgres://… node scripts/pilot-report.mjs
 *
 * One row per institution, with every field R-8 §11 asks for that a database
 * can answer, and explicit blanks for the ones only a person can.
 *
 * ── Why a script and not a spreadsheet ──────────────────────────────────
 * Half the fields — onboarding duration, first login, first attendance, first
 * notice, first invoice — are timestamps nobody can reconstruct afterwards.
 * A spreadsheet filled in on the Friday of pilot week is a spreadsheet of
 * recollections. This reads what actually happened, and it can be re-run on
 * any day of the pilot to see what changed.
 *
 * ── What it deliberately will not do ────────────────────────────────────
 * It does not compute an average onboarding time across the fixtures on a
 * development database and call that a measurement. Tenants created by a
 * seeding script in forty milliseconds are marked `synthetic` and excluded
 * from the summary, because an average that includes them would be a number
 * no human could reproduce — and the master plan's "under an hour" claim is
 * about a person's afternoon, not about how fast a script can POST.
 *
 * The columns a database cannot know — operator assistance needed, errors
 * misread, support contacts — are printed as empty and belong in the runbook's
 * per-school table, filled in as it happens. They are the ones that turn out
 * to matter most, and this file exists partly to make their absence visible.
 */
import pg from 'pg';
import { onboardingMetrics, looksSynthetic } from '../packages/server-core/src/onboarding-metrics.ts';

const URL_ = process.env.PILOT_DB_URL;
if (!URL_) {
  console.error('PILOT_DB_URL is required (a role that can read every tenant).');
  process.exit(2);
}

const db = new pg.Client({ connectionString: URL_ });
await db.connect();

/**
 * Which schools are PILOTS — and nothing is one unless somebody says so.
 *
 * The first version of this script summarised every tenant it found, marking
 * only the sub-minute ones as synthetic. Run against this repository's
 * development database it duly reported "measured onboardings: 2, median 61
 * min" — and both of those were the author's own browser walks through the
 * wizard, one of them automated. Neither is a human onboarding a school, and
 * a median computed from them is precisely the unmeasured claim R-8 §11
 * forbids, wearing a decimal point.
 *
 * So the summary counts only what PILOT_TENANT_IDS names. Everything else is
 * printed as context and excluded. Designating a pilot is a deliberate act,
 * which is what makes the resulting number mean anything.
 */
const pilotIds = new Set((process.env.PILOT_TENANT_IDS ?? '')
  .split(',').map((s) => s.trim()).filter(Boolean));
const only = [...pilotIds];

const { rows: tenants } = await db.query(`
  SELECT t.id::text, t.name_bn, t.stream, t.level, t.status, t.student_cap,
         to_char(t.created_at, 'YYYY-MM-DD') AS created_on
    FROM tenants t
   ORDER BY t.created_at`);

const INSTITUTION_TYPE = (stream, level) => {
  if (stream === 'madrasah') return 'madrasa';
  if (level === 'higher_secondary') return 'college';
  if (level === 'combined') return 'school_college';
  return 'school';
};

const rows = [];
for (const t of tenants) {
  const m = await onboardingMetrics(db, t.id);
  const { rows: counts } = await db.query(`
    SELECT (SELECT count(*) FROM student_profiles s WHERE s.tenant_id = $1)::int AS students,
           (SELECT count(*) FROM staff_profiles  f WHERE f.tenant_id = $1)::int  AS teachers,
           (SELECT count(DISTINCT g.guardian_id) FROM guardianships g
             WHERE g.tenant_id = $1)::int                                        AS guardians,
           (SELECT to_char(min(n.published_at), 'YYYY-MM-DD') FROM notices n
             WHERE n.tenant_id = $1 AND n.published_at IS NOT NULL)              AS first_notice,
           (SELECT to_char(min(o.sent_at), 'YYYY-MM-DD') FROM sms_outbox o
             WHERE o.tenant_id = $1 AND o.sent_at IS NOT NULL)                   AS first_sms,
           (SELECT count(*) FROM sms_outbox o WHERE o.tenant_id = $1)::int       AS sms_total,
           (SELECT to_char(min(c.day), 'YYYY-MM-DD') FROM calendar_days c
             WHERE c.tenant_id = $1)                                             AS first_calendar,
           (SELECT to_char(min(e.published_at), 'YYYY-MM-DD') FROM exams e
             WHERE e.tenant_id = $1 AND e.published_at IS NOT NULL)              AS first_result,
           (SELECT to_char(min(i.created_at), 'YYYY-MM-DD') FROM invoices i
             WHERE i.tenant_id = $1)                                             AS first_invoice,
           (SELECT to_char(min(r.issued_at), 'YYYY-MM-DD') FROM payment_receipts r
             WHERE r.tenant_id = $1)                                             AS first_receipt,
           (SELECT count(*) FROM sync_operations o
             WHERE o.tenant_id = $1 AND o.result = 'applied')::int               AS sync_applied,
           (SELECT count(*) FROM sync_operations o
             WHERE o.tenant_id = $1 AND o.result = 'rejected')::int              AS sync_rejected`,
    [t.id]);
  rows.push({
    ...t, ...counts[0], ...m,
    type: INSTITUTION_TYPE(t.stream, t.level),
    synthetic: looksSynthetic(m),
    isPilot: pilotIds.has(t.id),
  });
}
await db.end();

/* ── Per institution ──────────────────────────────────────────────────── */
for (const r of rows) {
  console.log(`\n${r.name_bn}   ${r.id}`);
  console.log(`  type                  ${r.type} (${r.stream} / ${r.level}) · ${r.status}`);
  console.log(`  onboarding started    ${r.startedAt ?? '—'}`);
  console.log(`  onboarding finished   ${r.finishedAt ?? '—'}`);
  console.log(`  onboarding duration   ${r.minutes === null ? '— (single step)'
    : `${r.minutes} min over ${r.steps} step(s), ${r.operators} operator(s)`}`
    + (r.synthetic ? '   ← SYNTHETIC, excluded'
      : r.isPilot ? '   ← pilot, counted' : '   ← not a designated pilot, excluded'));
  console.log(`  students / teachers   ${r.students} / ${r.teachers}`);
  console.log(`  guardians             ${r.guardians}`);
  console.log(`  first login           ${r.firstLoginAt ?? 'nobody has signed in'}`
    + (r.minutesToFirstLogin !== null ? `  (${r.minutesToFirstLogin} min after setup)` : ''));
  console.log(`  first attendance      ${r.firstAttendanceOn ?? '—'}`);
  console.log(`  first calendar entry  ${r.first_calendar ?? '—'}`);
  console.log(`  first notice          ${r.first_notice ?? '—'}`);
  console.log(`  first SMS sent        ${r.first_sms ?? '—'}   (${r.sms_total} queued in total)`);
  console.log(`  first result          ${r.first_result ?? '—'}`);
  console.log(`  first invoice         ${r.first_invoice ?? '—'}`);
  console.log(`  first receipt         ${r.first_receipt ?? '—'}`);
  console.log(`  sync applied/rejected ${r.sync_applied} / ${r.sync_rejected}`
    + (r.sync_rejected > 0 ? '   ← investigate: rejected ops are attendance a teacher believes they saved'
      : ''));
  console.log('  offline test          [ ] see docs/12-PRODUCTION-RUNBOOK.md §8a');
  console.log('  operator help needed  [ ]');
  console.log('  errors misread        [ ]');
  console.log('  support contacts      [ ]');
}

/* ── Summary ──────────────────────────────────────────────────────────── */
const real = rows.filter((r) => r.isPilot && !r.synthetic && r.minutes !== null);
console.log(`\n${'─'.repeat(72)}`);
console.log(`${rows.length} institution(s) on this database; `
  + `${rows.filter((r) => r.isPilot).length} designated as pilots; `
  + `${rows.filter((r) => r.synthetic).length} synthetic`);

const byType = {};
for (const r of rows) byType[r.type] = (byType[r.type] ?? 0) + 1;
console.log(`types: ${Object.entries(byType).map(([k, v]) => `${k}×${v}`).join(', ') || '—'}`);

if (real.length === 0) {
  console.log('\nNo institution has been designated a pilot, so nothing above is a');
  console.log('measurement of onboarding. Set PILOT_TENANT_IDS to the schools that');
  console.log('are actually piloting — a deliberate act, which is what makes the');
  console.log('resulting number mean anything.');
  console.log('\nThe master plan\'s "under one hour" target therefore remains');
  console.log('UNMEASURED and must not be claimed. Populate pilot_onboarding in');
  console.log('docs/production-evidence.json only from real institutions.');
} else {
  const mins = real.map((r) => r.minutes).sort((a, b) => a - b);
  const median = mins[Math.floor(mins.length / 2)];
  const underAnHour = real.filter((r) => r.minutes < 60).length;
  console.log(`\nmeasured onboardings: ${real.length}`);
  console.log(`  fastest ${mins[0]} min · median ${median} min · slowest ${mins[mins.length - 1]} min`);
  console.log(`  under one hour: ${underAnHour}/${real.length}`);
  if (real.length < 3) {
    console.log('\nFewer than three real institutions. R-8 asks for 3–5 before the');
    console.log('pilot gate may be considered, so this is not yet a pilot.');
  }
}
console.log(
  '\nThe four bracketed fields above are not in any database. They belong in'
  + '\nthe per-school table in docs/PILOT-ONBOARDING-RUNBOOK.md, written down as'
  + '\nit happens — and they are usually the ones that turn out to matter.');
