/**
 * A DB suite that touches shared fixtures must take the fixture lock.
 *
 * ── Why this is a test and not a note in a README ───────────────────────
 * `node --test` runs FILES in parallel. Every DB suite here seeds into the
 * same schema, so two running at once interleave: one suite's `DELETE FROM
 * routine_slots` lands in the middle of another's assertions. The harness
 * solves it with a session-scoped advisory lock — `lockFixtures` blocks until
 * whoever holds it lets go.
 *
 * Five suites imported `lockFixtures`, never called it, and called
 * `unlockFixtures()` in `after`. That is silent: `unlockFixtures` returns
 * early when no lock was taken, so the suites passed, most of the time, and
 * the audit could only record the risk (B-43) rather than a failure. It
 * surfaced during P-pilot-hardening as one rms-svc file reporting 57 tests
 * where 62 had been expected, with no individual test named — and then passed
 * three times in a row on its own, which is exactly how a flake earns the
 * right to be ignored.
 *
 * So the rule is checked at source level. A suite that calls `unlockFixtures`
 * without `lockFixtures` is unfenced by construction, and no amount of
 * re-running proves otherwise.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

// fileURLToPath, not URL.pathname: this repo's path contains spaces.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

function suiteFiles(): string[] {
  const out: string[] = [];
  for (const group of ['services', 'packages', 'apps']) {
    const dir = join(ROOT, group);
    if (!existsSync(dir)) continue;
    for (const ws of readdirSync(dir)) {
      const t = join(dir, ws, 'test');
      if (!existsSync(t)) continue;
      for (const f of readdirSync(t)) {
        if (/\.test\.(ts|mjs|js)$/.test(f)) out.push(join(t, f));
      }
    }
  }
  return out;
}

test('every suite that unlocks the fixtures also locks them', () => {
  const unfenced: string[] = [];
  for (const path of suiteFiles()) {
    const src = readFileSync(path, 'utf8');
    // The import alone is not use — that is precisely how this hid.
    const unlocks = /\bunlockFixtures\s*\(/.test(src);
    const locks = /\bawait\s+lockFixtures\s*\(/.test(src);
    if (unlocks && !locks) unfenced.push(relative(ROOT, path).replace(/\\/g, '/'));
  }
  assert.deepEqual(unfenced, [],
    'these suites release a fixture lock they never took, so they run '
    + 'unfenced and can interleave with any other DB suite:\n  '
    + unfenced.join('\n  '));
});

test('the check would catch a suite that stopped locking', () => {
  // The guard above passes on a clean tree, which tells us nothing until we
  // know it can fail. Planted defect, in memory.
  const planted = `
    import { lockFixtures, unlockFixtures } from '../harness.ts';
    before(async () => { db = createDb(URL); });
    after(async () => { await unlockFixtures(); });
  `;
  const unlocks = /\bunlockFixtures\s*\(/.test(planted);
  const locks = /\bawait\s+lockFixtures\s*\(/.test(planted);
  assert.equal(unlocks && !locks, true,
    'the detector must flag a file that imports the lock and never takes it');

  const fixed = planted.replace(
    'before(async () => {', 'before(async () => { await lockFixtures(URL);');
  assert.equal(/\bawait\s+lockFixtures\s*\(/.test(fixed), true,
    'and must go quiet once the lock is actually taken');
});

test('the suite scan actually finds suites', () => {
  // A detector that scans nothing passes everything — the failure mode this
  // whole file exists to prevent, one level up.
  const n = suiteFiles().length;
  assert.ok(n >= 30, `expected the repo's test files, found ${n}`);
});
