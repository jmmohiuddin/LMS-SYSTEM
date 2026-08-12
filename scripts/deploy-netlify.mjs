#!/usr/bin/env node
/**
 * Deploy to Netlify from a clean staging directory.
 *
 *   node scripts/deploy-netlify.mjs [--draft]
 *
 * ── Why staging, rather than deploying from the repo ─────────────────────
 * The Netlify CLI walks the project directory during a deploy and stats
 * everything it finds, including paths that have nothing to do with the
 * build. This repo has ten symlinks under .claude/skills (local agent
 * tooling, untracked) pointing into .agents/, and the CLI fails on them:
 *
 *     Error: File …/.claude/skills/review-animations does not exist.
 *
 * It reports a different one each run, which is what identifies it as a
 * walk over the whole set rather than one bad file. The files are fine —
 * lstat, readlink, realpath and stat all succeed, and making the links
 * absolute did not help, so this is the CLI's walk and not something the
 * repo can fix in place.
 *
 * Rather than move directories aside around every deploy — a workaround
 * that silently leaves the tree broken if it is interrupted — this copies
 * exactly what ships into a scratch directory and deploys from there. The
 * CLI then has nothing else to walk, which is also the correct shape: a
 * deploy should not be able to see files that are not part of it.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, cpSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SITE_ID = process.env.NETLIFY_SITE_ID ?? 'e49617ca-d412-47d4-b873-acc009ac98bd';
const draft = process.argv.includes('--draft');

const run = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { stdio: 'inherit', encoding: 'utf8', ...opts });

console.log('▸ building');
run('node', [join(ROOT, 'scripts', 'build.mjs')], { cwd: ROOT });

const PUBLISH = join(ROOT, 'apps', 'pwa', 'public');
const FUNCTIONS = join(ROOT, 'netlify', 'functions');
for (const [label, path] of [['publish dir', PUBLISH], ['functions', FUNCTIONS]]) {
  if (!existsSync(path)) {
    console.error(`missing ${label}: ${path}\nrun the build first`);
    process.exit(1);
  }
}

const stage = mkdtempSync(join(tmpdir(), 'shikhon-deploy-'));
try {
  console.log(`▸ staging → ${stage}`);
  cpSync(join(ROOT, 'netlify.toml'), join(stage, 'netlify.toml'));
  // dereference: the staged copy must not contain symlinks either, or the
  // CLI walks straight back into the same problem from a new directory.
  cpSync(PUBLISH, join(stage, 'public'), { recursive: true, dereference: true });
  cpSync(FUNCTIONS, join(stage, 'functions'), { recursive: true, dereference: true });

  console.log(`▸ deploying${draft ? ' (draft)' : ' to production'}`);
  run('netlify', [
    'deploy',
    ...(draft ? [] : ['--prod']),
    '--no-build',
    '--site', SITE_ID,
    '--dir', 'public',
    '--functions', 'functions',
  ], { cwd: stage });
} finally {
  rmSync(stage, { recursive: true, force: true });
  console.log('▸ staging cleaned up');
}
