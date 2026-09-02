/**
 * A calendar day is a day in Bangladesh, never a day in UTC.
 *
 * `new Date().toISOString().slice(0, 10)` reads the HOST's clock in UTC.
 * Bangladesh is UTC+6 with no daylight saving, so from midnight to 6am local
 * that expression names YESTERDAY — and those are real hours: a teacher
 * checking tomorrow's routine before bed, an IT admin importing a roster the
 * night before term, a receipt printed at half past midnight.
 *
 * ── Why this is a test and not a review note ────────────────────────────
 * The same expression has been written, found and fixed SIX times:
 *
 *   pre-R-8  an endpoint defaulted "today" this way; `packages/server-core/
 *            src/time.ts` was created to hold `dhakaToday()` and its header
 *            says "the same trap is reachable from every service that
 *            defaults a date, and two of them had already reached it"
 *   P7       a payment form defaulted its date this way in the BROWSER;
 *            `todayLocalIso()` was added to ui-core
 *   P8       `routine-view.ts` and `substitute-view.ts` — a teacher opening
 *            the routine before 6am saw yesterday's day
 *   P8       `myroutine.ts`, `assign.ts` and `document.ts` on the server,
 *            the last of which stamped `issuedOn` on a printed document
 *   P8       migration 059 — the DATABASE, where `CURRENT_DATE` is the
 *            server's date and nineteen column defaults used it
 *
 * Two helpers were written to stop it and the expression kept reappearing,
 * because nothing looked. This looks.
 *
 * ── The two correct forms ───────────────────────────────────────────────
 *   browser  `todayLocalIso()`   packages/ui-core/src/format.ts
 *   server   `dhakaToday()`      packages/server-core/src/time.ts
 *   database `app.today_dhaka()` migration 059
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// fileURLToPath, not URL.pathname: this repo's path contains spaces.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** `.toISOString().slice(0, 10)` / `.substring(0, 10)` on a fresh clock. */
const UTC_TODAY = /new Date\(\s*\)\s*\.toISOString\(\)\s*\.(?:slice|substring)\(\s*0\s*,\s*10\s*\)/;

/**
 * The two files that legitimately contain the expression: the helpers whose
 * whole purpose is to replace it, and which quote it in their headers.
 */
const ALLOWED = new Set([
  join('packages', 'ui-core', 'src', 'format.ts'),
  join('packages', 'server-core', 'src', 'time.ts'),
]);

function sources(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'dist') continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) sources(p, out);
    else if (e.name.endsWith('.ts')) out.push(p);
  }
  return out;
}

describe('calendar dates', () => {
  test('THE ONE THAT MATTERS — no UTC date is used as a calendar day', () => {
    const bad: string[] = [];
    for (const dir of ['apps/pwa/src', 'packages', 'services'].map((d) => join(ROOT, d))) {
      for (const file of sources(dir)) {
        const rel = file.slice(ROOT.length + 1);
        if (ALLOWED.has(rel)) continue;
        readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
          // Strip CRLF first: `.` excludes `\r`, so `.*$` never anchors and a
          // comment stripper matches nothing on a Windows checkout.
          const code = line.replace(/\r$/, '').replace(/^\s*(\/\/|\*|\/\*).*$/, '');
          if (UTC_TODAY.test(code)) {
            bad.push(`${rel}:${i + 1}`);
          }
        });
      }
    }
    assert.deepEqual(bad, [],
      'use todayLocalIso() in the browser or dhakaToday() on the server:\n  '
      + bad.join('\n  '));
  });

  test('no embedded SQL asks the SERVER what day it is', () => {
    // The third layer, and the one migration 059 could not reach: SQL written
    // inside TypeScript template literals. `CURRENT_DATE` there is the
    // database session's date, and the database runs UTC — so `date_trunc(
    // 'month', CURRENT_DATE)` put a parent's attendance in the wrong month
    // for six hours on the first of every month, and `effective_from <=
    // CURRENT_DATE` picked yesterday's grading scale.
    //
    // 31 occurrences across 15 files when this was written. `app.today_dhaka()`
    // is granted to PUBLIC precisely so embedded SQL can call it.
    //
    // Test files are exempt: a fixture that wants the server's own date to
    // set up a boundary is doing something legitimate and deliberate.
    const bad: string[] = [];
    for (const dir of ['packages', 'services'].map((d) => join(ROOT, d))) {
      for (const file of sources(dir)) {
        if (/[\\/]test[\\/]|\.test\.ts$/.test(file)) continue;
        const rel = file.slice(ROOT.length + 1);
        readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
          const code = line.replace(/\r$/, '').replace(/^\s*(\/\/|\*|\/\*).*$/, '');
          if (/\bCURRENT_DATE\b/.test(code)) bad.push(`${rel}:${i + 1}`);
        });
      }
    }
    assert.deepEqual(bad, [],
      'use app.today_dhaka() in embedded SQL — CURRENT_DATE is the server\'s '
      + 'date and the server runs UTC:\n  ' + bad.join('\n  '));
  });

  test('the detector actually detects — it cannot rot into a no-op', () => {
    assert.equal(UTC_TODAY.test("const d = new Date().toISOString().slice(0, 10);"), true);
    assert.equal(UTC_TODAY.test("new Date().toISOString().substring(0,10)"), true);
    // A specific instant IS legitimate — only "now" read as a calendar day
    // is the bug, because only "now" can straddle midnight.
    assert.equal(UTC_TODAY.test("new Date(t).toISOString().slice(0, 10)"), false);
    // And a full timestamp is an instant, which has no timezone problem.
    assert.equal(UTC_TODAY.test("new Date().toISOString()"), false);
  });

  test('both replacement helpers exist and are exported', () => {
    const fmt = readFileSync(join(ROOT, 'packages/ui-core/src/format.ts'), 'utf8');
    const time = readFileSync(join(ROOT, 'packages/server-core/src/time.ts'), 'utf8');
    assert.match(fmt, /export function todayLocalIso\b/);
    assert.match(time, /export function dhakaToday\b/);
  });
});
