/**
 * The typecheck gate — and the reason it reads the CI workflow to find itself.
 *
 * `npx tsc -p . --noEmit` looks like the whole typecheck and is not. The root
 * `tsconfig.json` **excludes `apps/pwa`**, so that command checks the services
 * and the packages and skips the entire application. CI has always run three
 * configs; a person at a terminal ran one, saw it pass, and wrote "TypeScript:
 * 0 errors" in a phase report. P4 and D17 both did exactly that. The
 * application was not typechecked in either pass, and nobody could tell,
 * because the command that was run really did exit 0.
 *
 * So this script does not hold its own list of configs. It PARSES
 * `.github/workflows/security.yml` and runs whatever CI runs. A config added
 * to CI is picked up here on the next run with no edit; a config removed from
 * CI stops being run here. The two cannot disagree, because there is only one
 * list and CI owns it.
 *
 * ── The second thing it does, and why ──────────────────────────────────────
 * Matching CI is necessary and not sufficient: CI's three configs together do
 * not cover every TypeScript file in the repository. 46 test files and the
 * `/design` prototype are checked by nothing at all, which is a real gap
 * (`B-32`) and is NOT closed here — closing it means adding `@types/jsdom` and
 * fixing 73 pre-existing errors in test code, which is its own piece of work.
 *
 * What this script does instead is make that set VISIBLE and FROZEN. It
 * computes the union of `--listFiles` across the CI configs, subtracts it from
 * the repository's tracked `.ts` files, and compares the remainder against
 * `scripts/typecheck-baseline.json`. A NEW unchecked file fails the gate. So
 * the coverage hole cannot quietly grow while every command still exits 0 —
 * which is the exact failure mode this whole script exists because of.
 *
 *   node scripts/typecheck.mjs            run the gate
 *   node scripts/typecheck.mjs --update   re-baseline (deliberate, reviewed)
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// fileURLToPath, not URL.pathname: this repo's path contains spaces.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WORKFLOW = join(ROOT, '.github', 'workflows', 'security.yml');
const BASELINE = join(ROOT, 'scripts', 'typecheck-baseline.json');
/**
 * The compiler itself, not `npx`.
 *
 * CI runs `npx --no-install tsc`, and `--no-install` is there for a documented
 * reason: without it npx silently downloads an unrelated package called `tsc`,
 * which is how that CI step once "passed" without ever running a compiler. So
 * the guarantee CI wants is "the TypeScript in this repo's node_modules, or
 * nothing" — and calling that entry point directly IS that guarantee, with no
 * resolution step to get wrong.
 *
 * It also has to be this way on Windows: Node refuses to `execFileSync` a
 * `.cmd` without a shell (EINVAL), and using a shell would concatenate
 * arguments unescaped through a repository path that contains a space.
 */
const TSC = join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc');

const RED = (s) => `\x1b[31m${s}\x1b[0m`;
const GREEN = (s) => `\x1b[32m${s}\x1b[0m`;
const DIM = (s) => `\x1b[2m${s}\x1b[0m`;

/**
 * Every `tsc -p <config>` CI runs.
 *
 * Deliberately strict about finding at least one: if the workflow is
 * restructured and this regex stops matching, the honest outcome is a loud
 * failure, not a gate that silently checks nothing. That is the same trap the
 * `--no-install` comment in the workflow describes — a step that "passed" by
 * never running the compiler.
 */
function configsFromCi() {
  const yml = readFileSync(WORKFLOW, 'utf8');
  const found = [...yml.matchAll(/tsc\s+-p\s+(\S+)\s+--noEmit/g)].map((m) => m[1]);
  if (found.length === 0) {
    console.error(RED('No `tsc -p … --noEmit` found in .github/workflows/security.yml.'));
    console.error('Either CI stopped typechecking, or its shape changed and this');
    console.error('parser needs updating. Refusing to report a pass either way.');
    process.exit(1);
  }
  return [...new Set(found)];
}

/**
 * Every `.ts` file git considers part of the repo — tracked AND untracked but
 * not ignored.
 *
 * `git ls-files '*.ts'` alone lists only TRACKED files, which means a brand new
 * module outside every tsconfig passes this gate until the moment somebody
 * stages it. That is precisely backwards: the gate is most useful while the
 * file is still being written. `--others --exclude-standard` adds the untracked
 * ones without dragging in `node_modules` or anything else `.gitignore` names.
 */
function repoTsFiles() {
  const out = execFileSync(
    'git', ['ls-files', '--cached', '--others', '--exclude-standard', '*.ts'],
    { cwd: ROOT, encoding: 'utf8' },
  );
  return [...new Set(out.split('\n').map((l) => l.trim()).filter(Boolean))].sort();
}

function normalise(abs) {
  return relative(ROOT, abs).split(sep).join('/');
}

function main() {
  if (!existsSync(TSC)) {
    console.error(RED('TypeScript is not installed in this repository.'));
    console.error(`Expected ${normalise(TSC)} — run \`npm install\`.`);
    console.error('Refusing to report a pass without a compiler; that is the');
    console.error('failure the workflow\'s `--no-install` flag exists to prevent.');
    process.exit(1);
  }
  const update = process.argv.includes('--update');
  const configs = configsFromCi();

  console.log(DIM(`typecheck scope, read from ${normalise(WORKFLOW)}:`));
  for (const c of configs) console.log(DIM(`  ${c}`));
  console.log();

  const checked = new Set();
  let failed = 0;

  for (const cfg of configs) {
    process.stdout.write(`${cfg.padEnd(30)}`);
    let listed = '';
    try {
      // --listFiles alongside the real check, so coverage is measured from the
      // same compilation that produced the verdict rather than a second one
      // that might resolve differently.
      // The platform's own binary rather than `shell: true`: passing args
      // through a shell concatenates them unescaped (Node's DEP0190), and this
      // repo's path contains a space.
      listed = execFileSync(
        process.execPath, [TSC, '-p', cfg, '--noEmit', '--listFiles'],
        { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
      );
      console.log(GREEN('0 errors'));
    } catch (err) {
      failed++;
      listed = err.stdout ?? '';
      const errors = (listed.match(/error TS\d+/g) ?? []).length;
      console.log(RED(`${errors || 'FAILED'} error${errors === 1 ? '' : 's'}`));
      const lines = listed.split('\n').filter((l) => /error TS\d+/.test(l));
      for (const l of lines.slice(0, 25)) console.log(`  ${l}`);
      if (lines.length > 25) console.log(DIM(`  … and ${lines.length - 25} more`));
    }
    for (const line of listed.split('\n')) {
      const f = line.trim();
      if (!f || f.includes('node_modules') || !f.endsWith('.ts')) continue;
      checked.add(normalise(f));
    }
  }

  // ── coverage ─────────────────────────────────────────────────────────────
  const all = repoTsFiles();
  const unchecked = all.filter((f) => !checked.has(f));

  if (update) {
    writeFileSync(BASELINE, `${JSON.stringify({
      note: 'Repo .ts files (tracked or not, excluding .gitignore) that NO CI tsconfig '
        + 'checks. See scripts/typecheck.mjs. '
        + 'Shrinking this list is progress; growing it needs a reason and a review.',
      unchecked,
    }, null, 2)}\n`);
    console.log(`\n${GREEN('baseline updated')} — ${unchecked.length} unchecked files recorded`);
    process.exit(failed ? 1 : 0);
  }

  let baseline;
  try {
    baseline = JSON.parse(readFileSync(BASELINE, 'utf8')).unchecked ?? [];
  } catch {
    console.error(RED(`\nMissing or unreadable ${normalise(BASELINE)}.`));
    console.error('Run `node scripts/typecheck.mjs --update` and review the result.');
    process.exit(1);
  }

  const known = new Set(baseline);
  const newlyUnchecked = unchecked.filter((f) => !known.has(f));
  const nowChecked = baseline.filter((f) => !unchecked.includes(f));

  console.log(`\n${DIM('coverage:')} ${all.length - unchecked.length}/${all.length} repo `
    + `.ts files checked · ${unchecked.length} unchecked (baseline ${baseline.length})`);

  if (nowChecked.length) {
    console.log(GREEN(`  ${nowChecked.length} file(s) newly covered — `
      + 'run with --update to record the improvement'));
    for (const f of nowChecked.slice(0, 10)) console.log(DIM(`    ${f}`));
  }

  if (newlyUnchecked.length) {
    failed++;
    console.log(RED(`\n${newlyUnchecked.length} NEW file(s) that no tsconfig checks:`));
    for (const f of newlyUnchecked) console.log(RED(`    ${f}`));
    console.log('\nA TypeScript file outside every config is a file where a type error');
    console.log('cannot fail any gate. Either put it in a config, or re-baseline');
    console.log('deliberately with `node scripts/typecheck.mjs --update`.');
  }

  if (failed) { console.log(RED('\ntypecheck FAILED')); process.exit(1); }
  console.log(GREEN('\ntypecheck passed — local scope == CI scope'));
}

main();
