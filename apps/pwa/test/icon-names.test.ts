/**
 * Every glyph name in the app must be a glyph that exists.
 *
 * `icon()` treats an unknown name as a bug — it warns and draws a neutral
 * dot — but a `console.warn` in a browser is not a thing anyone reads. The
 * comment in `ui/dom.ts` records the cost: `CARD.students` carried a `search`
 * glyph that did not exist from R-6 all the way to P1, and the screen looked
 * merely a bit plain the whole time.
 *
 * P7 reproduced it immediately (`plus-circle`, `alert-circle` — neither is in
 * the set), which is enough evidence that "remember to check the list" is not
 * a working control. This reads the names out of the source instead.
 *
 * Source-level, deliberately: the alternative is mounting every screen in
 * jsdom and watching for warnings, which would test a fraction of the call
 * sites and be silent about the rest.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// fileURLToPath, not URL.pathname: this repo's path contains spaces.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'src');

/** The keys of the icon table in `src/icon.ts`. */
function knownIcons(): Set<string> {
  const src = readFileSync(join(SRC, 'icon.ts'), 'utf8');
  const names = [...src.matchAll(/^ {2}'?([a-z0-9-]+)'?:/gm)].map((m) => m[1]);
  assert.ok(names.length > 20, `only found ${names.length} icons — the parser has drifted`);
  return new Set(names);
}

/** Every `.ts` under src/, recursively. */
function sources(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...sources(p));
    else if (e.name.endsWith('.ts')) out.push(p);
  }
  return out;
}

/**
 * The two ways a glyph is named in this codebase: the `glyph:` option that
 * every primitive takes, and a direct `icon(doc, 'name')` call.
 *
 * Both are matched on a string LITERAL only. A computed name — `glyph: g` or
 * `icon(d, s.code)` — cannot be checked here and is not the failure mode this
 * guards; the ones that shipped were all literals.
 */
const PATTERNS = [
  /\bglyph:\s*'([a-z0-9-]+)'/g,
  /\bicon\(\s*[A-Za-z_$][\w.$]*\s*,\s*'([a-z0-9-]+)'/g,
];

describe('icon names', () => {
  test('every glyph named in source exists in the icon set', () => {
    const icons = knownIcons();
    const missing: string[] = [];

    for (const file of sources(SRC)) {
      // The table itself, and the fallback the table hands back.
      if (file.endsWith(`${join('src', 'icon.ts')}`)) continue;
      const src = readFileSync(file, 'utf8');
      for (const re of PATTERNS) {
        for (const m of src.matchAll(re)) {
          if (!icons.has(m[1])) {
            missing.push(`${file.slice(SRC.length + 1)}: "${m[1]}"`);
          }
        }
      }
    }

    assert.deepEqual(missing, [],
      `these glyph names do not exist and would render a blank dot:\n  ${missing.join('\n  ')}`);
  });

  test('the icon set itself is reachable and named the way the parser expects', () => {
    const icons = knownIcons();
    // A handful that the shell and the tables depend on. If the table is ever
    // restructured, this fails here rather than silently emptying the guard
    // above into a test that can never fail.
    for (const n of ['home', 'chevron-right', 'users', 'wallet', 'settings']) {
      assert.ok(icons.has(n), `the icon set lost "${n}"`);
    }
  });
});
