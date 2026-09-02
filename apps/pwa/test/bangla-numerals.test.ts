/**
 * A number inside a Bangla sentence must be written in Bangla digits.
 *
 * This is not a style preference; it is the same defect three times:
 *
 *   R-6  `services/academics-svc/api/search.ts` — "অন্তত 2টি অক্ষর", a Latin
 *        digit inside a Bangla sentence, fixed and commented at the site.
 *   P5   several screens shipped Latin counts and were converted to
 *        `formatCount(n, 'bn')`.
 *   P8   `shell.ts` drew the unread badge as "৩" and named it, to a screen
 *        reader, as "নোটিশ — 3টি পড়া হয়নি". A sighted user read Bangla and a
 *        blind user heard Latin, from the same control. `practice-view.ts`
 *        said "কঠিনতা 3 / ৫" — the child's score in one script and the
 *        maximum in the other, in one phrase.
 *
 * Each was found by looking. This looks instead.
 *
 * ── The rule it encodes (R-8) ───────────────────────────────────────────
 * COUNTS are Bangla: ৩টি, ১০ জন. MONEY and IDENTIFIERS are Latin: ৳ 60,000.00,
 * roll 07, an EIIN. So "a Latin digit immediately before a Bangla counter
 * word" is unambiguous — no legitimate string does that — while a bare Latin
 * digit somewhere near Bangla is not, and is deliberately NOT flagged.
 *
 * ── Why interpolation and not literals ──────────────────────────────────
 * A literal "3টি" is easy to see in review and does not survive one. The form
 * that ships is `${n}টি`, which looks correct until you notice `n` is a
 * number and nothing formatted it.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// fileURLToPath, not URL.pathname: this repo's path contains spaces.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/**
 * Bangla counter words. A digit directly before one of these is a count.
 * Longest first, so "জনের" is not consumed as "জন".
 */
const COUNTERS = 'জনের|টার|টির|টি|জন|টা';

/**
 * Anything that turns a number into Bangla digits, plus the naming
 * convention for a value that is ALREADY Bangla text: a `_BN` / `Bn` suffix,
 * as in `const MIN_QUERY_BN = '২'`.
 */
const FORMATTERS = /formatCount|toBanglaDigits|bnNum|toBn|bn\(|_BN\b|Bn\b/;

/**
 * `${expr}টি` — an interpolation feeding a Bangla counter.
 *
 * No trailing `\b`. JavaScript's `\w` is `[A-Za-z0-9_]`, so there is never a
 * word boundary after a Bangla character and the pattern matched nothing at
 * all — which the self-check below caught on this test's very first run.
 * A guard that silently matches nothing is worse than no guard.
 */
const INTERPOLATED = new RegExp(String.raw`\$\{([^}]*)\}\s*(?:${COUNTERS})`, 'g');

/** A bare Latin digit feeding one, e.g. "অন্তত 2টি অক্ষর". */
const LITERAL = new RegExp(String.raw`[0-9]\s*(?:${COUNTERS})`);

function sources(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'dist') continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) sources(p, out);
    else if (e.name.endsWith('.ts')) out.push(p);
  }
  return out;
}

const SCANNED = [
  join(ROOT, 'apps', 'pwa', 'src'),
  join(ROOT, 'packages'),
  join(ROOT, 'services'),
];

function offences(): string[] {
  const bad: string[] = [];
  for (const dir of SCANNED) {
    for (const file of sources(dir)) {
      const rel = file.slice(ROOT.length + 1);
      readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
        // Only lines that are actually Bangla, and never a comment — the two
        // existing "Latin digit" mentions in this repository are comments
        // describing the bug, which is exactly the right thing for them to be.
        //
        // `\r` is stripped FIRST. This repo checks out CRLF on Windows, and
        // JavaScript's `.` excludes `\r` as a line terminator, so `.*$` never
        // reached the end of a line and the comment stripper matched nothing.
        // Both comments were reported as defects until this line existed.
        const code = line.replace(/\r$/, '').replace(/^\s*(\/\/|\*|\/\*).*$/, '');
        if (!/[ঀ-৿]/.test(code)) return;

        for (const m of code.matchAll(INTERPOLATED)) {
          if (!FORMATTERS.test(m[1])) {
            bad.push(`${rel}:${i + 1}  \${${m[1].trim()}} feeds a Bangla counter unformatted`);
          }
        }
        if (LITERAL.test(code)) {
          bad.push(`${rel}:${i + 1}  a Latin digit sits directly before a Bangla counter`);
        }
      });
    }
  }
  return bad;
}

describe('Bangla numerals', () => {
  test('THE ONE THAT MATTERS — no Latin digit feeds a Bangla counter', () => {
    const bad = offences();
    assert.deepEqual(bad, [],
      `a number in a Bangla sentence must be in Bangla digits:\n  ${bad.join('\n  ')}`);
  });

  test('the detector actually detects — it cannot rot into a no-op', () => {
    // The two real strings this test was written for, before they were fixed.
    const shell = 'const label = `নোটিশ — ${n}টি পড়া হয়নি`;';
    const search = 'throw new Error("অন্তত 2টি অক্ষর দিন");';
    const fixed = "const label = `নোটিশ — ${formatCount(n, 'bn')}টি পড়া হয়নি`;";

    const hits = (s: string): boolean =>
      [...s.matchAll(INTERPOLATED)].some((m) => !FORMATTERS.test(m[1])) || LITERAL.test(s);

    assert.equal(hits(shell), true, 'the interpolated form is not detected');
    assert.equal(hits(search), true, 'the literal form is not detected');
    assert.equal(hits(fixed), false, 'a correctly formatted count is flagged');
  });

  test('money and identifiers are left alone — R-8 decided they are Latin', () => {
    const hits = (s: string): boolean =>
      [...s.matchAll(INTERPOLATED)].some((m) => !FORMATTERS.test(m[1])) || LITERAL.test(s);

    // Money: Latin on purpose. A school reads its accounts in Latin figures.
    assert.equal(hits('`মোট আদায় ৳ ${formatBdt(total)}`'), false);
    // A roll number is an identifier, not a count.
    assert.equal(hits('`রোল ${formatIdentifier(roll)}`'), false);
    // A bare Latin digit that is NOT feeding a counter is not this bug.
    assert.equal(hits('`ক্লাস 9-A`'), false);
  });
});
