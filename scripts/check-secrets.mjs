#!/usr/bin/env node
/**
 * Secret preflight  (F-105)
 *
 * Two jobs, both of which used to depend on somebody remembering:
 *
 *   --env      every secret the deployed services need is present and
 *              strong enough. Run before a deploy; a missing key is much
 *              cheaper to find here than as a 500 at 08:00 on a Sunday.
 *   --history  no credential has ever been committed to this repository.
 *              Runs in CI on every push, so "we checked once" becomes
 *              "it cannot happen".
 *
 * It never prints a secret value. Not truncated, not masked, not "the
 * first four characters" — a log line is forever and CI logs are often
 * more readable than the deploy dashboard. Findings identify the variable
 * or the file and commit, never the material.
 *
 *   node scripts/check-secrets.mjs --env
 *   node scripts/check-secrets.mjs --history
 *   node scripts/check-secrets.mjs            (both)
 *
 * Exit 0 clean, 1 on any finding.
 */
import { execFileSync } from 'node:child_process';

/* ───────────────────────────────────────────────── the inventory */

/**
 * Every secret the platform holds, why it matters, and what an attacker
 * gets if it leaks. `minEntropyBits` is a floor, not a target: it exists
 * to catch a placeholder that was never replaced ("changeme", "test"),
 * which is the realistic failure, not a weak-but-plausible key.
 */
const SECRETS = [
  {
    name: 'DATABASE_URL',
    required: true,
    kind: 'connection-string',
    blastRadius: 'every tenant\'s data, read and write, as the runtime role',
    rotate: "ALTER ROLE shikhon_runtime PASSWORD '<new>'; then update Vercel env and redeploy",
  },
  {
    name: 'DATABASE_MAINTENANCE_URL',
    required: false,
    kind: 'connection-string',
    blastRadius: 'DDL on the whole database as the owner role — the worst one to lose',
    rotate: "ALTER ROLE neondb_owner PASSWORD '<new>'; update Vercel env",
  },
  {
    name: 'SERVICE_API_KEY',
    required: true,
    kind: 'bearer',
    minEntropyBits: 128,
    blastRadius: 'the machine-to-machine surface: ANS export, SMS dispatch, maintenance',
    rotate: 'generate 32 random bytes, update Vercel env and every caller that holds it',
  },
  {
    name: 'CRON_SECRET',
    required: true,
    kind: 'bearer',
    minEntropyBits: 128,
    blastRadius: 'can trigger the SMS worker and the maintenance run at will',
    rotate: 'generate 32 random bytes, update Vercel env (Vercel Cron re-reads it)',
  },
  {
    name: 'ANTHROPIC_API_KEY',
    required: false,
    kind: 'bearer',
    minEntropyBits: 128,
    blastRadius: 'billable AI spend; the gateway ships dark without it',
    rotate: 'revoke in the Anthropic console, issue a new key, update Vercel env',
  },
  {
    name: 'ANS_SIGNING_SECRET',
    required: false,
    kind: 'bearer',
    minEntropyBits: 128,
    blastRadius: 'lets an attacker forge alumni webhooks the ANS will trust',
    rotate: 'generate 32 random bytes, coordinate the cutover with the ANS operator',
  },
  {
    name: 'PII_MASTER_KEY_V1',
    required: false,          // ships dark; see packages/server-core/src/pii-crypto.ts
    kind: 'base64-32',
    blastRadius: 'every stored national ID and birth-registration number',
    rotate: 'add PII_MASTER_KEY_V2 and run the re-encryption sweep — NEVER replace V1 in place',
  },
  {
    name: 'PII_MASTER_KEY_V2',
    required: false,
    kind: 'base64-32',
    blastRadius: 'every stored national ID and birth-registration number',
    rotate: 'add the next version; retire an old one only after the sweep reports zero rows on it',
  },
];

/* ─────────────────────────────────────────────────────── helpers */

/**
 * Shannon entropy over the observed character distribution, times length.
 * A crude estimate on purpose — it is meant to separate 32 random bytes
 * from "changeme123", not to grade a cipher.
 */
function entropyBits(s) {
  const counts = new Map();
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let h = 0;
  for (const n of counts.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h * s.length;
}

const PLACEHOLDERS = [
  'changeme', 'change-me', 'placeholder', 'yourkeyhere', 'todo', 'xxx',
  'secret', 'password', 'test', 'example', 'dummy', 'replaceme',
];

function looksLikePlaceholder(value) {
  const v = value.toLowerCase();
  return PLACEHOLDERS.some((p) => v.includes(p)) || /^<.*>$/.test(value.trim());
}

/* ──────────────────────────────────────────────────── --env pass */

function checkEnv() {
  const findings = [];
  const present = [];

  for (const s of SECRETS) {
    const raw = process.env[s.name];
    if (!raw || raw.trim() === '') {
      if (s.required) {
        findings.push(`${s.name} is not set. Blast radius if wrong: ${s.blastRadius}`);
      }
      continue;
    }
    present.push(s.name);

    if (looksLikePlaceholder(raw)) {
      findings.push(`${s.name} still looks like a placeholder, not a real credential`);
      continue;
    }

    if (s.kind === 'connection-string') {
      let url;
      try {
        url = new URL(raw);
      } catch {
        findings.push(`${s.name} is not a parseable URL`);
        continue;
      }
      if (!url.password) {
        findings.push(`${s.name} carries no password`);
      } else if (entropyBits(url.password) < 60) {
        findings.push(`${s.name} has a weak password (below the placeholder floor)`);
      }
      if (!/sslmode=require|sslmode=verify/.test(url.search)) {
        // Neon terminates TLS, but a connection string without sslmode is
        // one copy-paste away from a plaintext link to a database holding
        // children's national IDs.
        findings.push(`${s.name} does not demand TLS (add sslmode=require)`);
      }
      if (s.name === 'DATABASE_URL' && /neondb_owner|postgres@|superuser/.test(raw)) {
        // The single most damaging misconfiguration in this system: the
        // owner role carries BYPASSRLS, so every tenant boundary vanishes.
        findings.push(`${s.name} appears to use an owner/superuser role — RLS would not be enforced`);
      }
    }

    if (s.kind === 'base64-32') {
      const buf = Buffer.from(raw, 'base64');
      if (buf.length !== 32) {
        findings.push(`${s.name} must decode to 32 bytes (got ${buf.length})`);
      } else if (entropyBits(raw) < 128) {
        findings.push(`${s.name} does not look randomly generated`);
      }
    }

    if (s.kind === 'bearer' && s.minEntropyBits) {
      if (entropyBits(raw) < s.minEntropyBits) {
        findings.push(`${s.name} is below the ${s.minEntropyBits}-bit floor — regenerate it randomly`);
      }
    }
  }

  // Rotating the PII key is additive by design: V1 must stay readable
  // until the sweep has moved every row off it. Replacing it in place
  // makes every existing national ID permanently undecryptable.
  if (process.env.PII_MASTER_KEY_V2 && !process.env.PII_MASTER_KEY_V1) {
    findings.push(
      'PII_MASTER_KEY_V2 is set but V1 is not. Any row still sealed under V1 is now '
      + 'undecryptable. Restore V1, run the re-encryption sweep, and retire it only when '
      + 'no row reports pii_key_version = 1.',
    );
  }

  return { findings, present };
}

/* ──────────────────────────────────────────────── --history pass */

/**
 * Patterns for material that must never be committed. Deliberately keyed
 * on shapes that cannot occur innocently — a documented `<placeholder>` in
 * a connection string is fine and must not trip this, or the check gets
 * switched off within a week.
 */
const HISTORY_PATTERNS = [
  ['private key block', 'BEGIN [A-Z ]*PRIVATE KEY'],
  ['Anthropic API key', 'sk-ant-api[0-9]{2}-[A-Za-z0-9_-]{20,}'],
  ['Neon password', 'npg_[A-Za-z0-9]{16,}'],
  ['populated connection string', String.raw`postgres(ql)?://[A-Za-z0-9_]+:[A-Za-z0-9!$%^&*_+-]{12,}@`],
  ['AWS access key id', 'AKIA[0-9A-Z]{16}'],
  ['Slack token', 'xox[baprs]-[0-9A-Za-z-]{10,}'],
  ['generic bearer literal', String.raw`Bearer [A-Za-z0-9_\-\.]{24,}`],
];

function checkHistory() {
  const findings = [];
  let revs;
  try {
    revs = execFileSync('git', ['rev-list', '--all'], { encoding: 'utf8' }).trim();
  } catch {
    return { findings: ['not a git repository — history check skipped'], scanned: 0 };
  }
  if (!revs) return { findings, scanned: 0 };
  const revList = revs.split('\n');

  for (const [label, pattern] of HISTORY_PATTERNS) {
    let out = '';
    try {
      // -I skips binaries; -l reports files, never the matching line, so a
      // secret can never reach this process's stdout.
      out = execFileSync(
        'git',
        ['grep', '-I', '-l', '-E', pattern, ...revList],
        { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
      );
    } catch (err) {
      // git grep exits 1 when there are no matches. Anything else is real.
      if (err.status !== 1) {
        findings.push(`history scan for ${label} failed: ${err.message}`);
      }
      continue;
    }
    const hits = out.trim().split('\n').filter(Boolean);
    if (hits.length) {
      // Location only — the finding is "this file at this commit", never
      // the value. Rotation is the fix regardless; printing it again is not.
      findings.push(
        `${label} found in ${hits.length} committed blob(s):\n    `
        + hits.slice(0, 10).join('\n    ')
        + '\n    → rotate the credential FIRST, then rewrite history. Removing the commit '
        + 'does not un-leak anything that was ever pushed.',
      );
    }
  }
  return { findings, scanned: revList.length };
}

/* ─────────────────────────────────────────────────────────── main */

const args = process.argv.slice(2);
const runEnv = args.length === 0 || args.includes('--env');
const runHistory = args.length === 0 || args.includes('--history');
let failed = false;

if (runEnv) {
  const { findings, present } = checkEnv();
  console.log(`\n── environment ─────────────────────────────────────────`);
  console.log(`configured: ${present.length ? present.join(', ') : '(none)'}`);
  if (findings.length) {
    failed = true;
    for (const f of findings) console.error(`  ✗ ${f}`);
  } else {
    console.log('  ✓ every required secret is present and passes its shape check');
  }
}

if (runHistory) {
  const { findings, scanned } = checkHistory();
  console.log(`\n── committed history (${scanned} commit${scanned === 1 ? '' : 's'}) ──────────────────`);
  if (findings.length) {
    failed = true;
    for (const f of findings) console.error(`  ✗ ${f}`);
  } else {
    console.log('  ✓ no credential material found in any commit');
  }
}

console.log('');
process.exit(failed ? 1 : 0);
