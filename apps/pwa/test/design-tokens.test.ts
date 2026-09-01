/**
 * The Ata Ekta token foundation.  (UI integration plan, P0)
 *
 * P0 swapped the palette underneath 424 `var(--c-*)` usages by re-pointing a
 * 29-token alias layer, without touching a single view module. That is only
 * safe while three properties hold, and each of these tests exists because
 * breaking one would be invisible in a screenshot until a specific screen in
 * a specific theme was opened by a specific role.
 *
 *   1. Every alias resolves. A `var(--c-thing)` with no definition inherits
 *      its colour silently — text simply takes its parent's colour and looks
 *      *plausible*. Nine rules were doing exactly that before `--c-ink-1` was
 *      given a definition; nobody noticed for weeks.
 *   2. Both themes define the same token set. Dark mode's first failure here
 *      was an inverted neutral ramp with four hand-set status tints left
 *      pale: light-on-light, 1.02:1 on the routine screen — invisible rather
 *      than merely poor. A ramp only carries the tokens that alias it.
 *   3. Contrast obligations are met by the tokens that carry text. The
 *      canonical palette is not automatically accessible: `--color-text-faint`
 *      is 3.03:1 on the Muslin ground and would fail AA the moment any text
 *      token aliased it, which is the same defect `--c-ink-3` was created to
 *      fix in the previous palette.
 *
 * These read the shipped CSS rather than a copy, so they cannot drift from it.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// fileURLToPath, not URL.pathname: this repo's path contains spaces.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
import { LIGHT_SURFACE, DARK_SURFACE }
  from '../../../packages/ui-core/src/branding.ts';
const CSS_RAW = readFileSync(join(ROOT, 'public', 'app.css'), 'utf8');
/**
 * Comments stripped before any token scan. This file's comments deliberately
 * NAME tokens that do not exist — "was var(--c-bg), not a defined token" is a
 * record of a fixed bug — and a scanner that reads them reports the very bug
 * the comment says was fixed. Found by this test's own first run.
 */
const CSS = CSS_RAW.replace(/\/\*[\s\S]*?\*\//g, '');

/** The `:root { … }` light block. */
function lightBlock(): string {
  const i = CSS.indexOf(':root {');
  return CSS.slice(i, CSS.indexOf('\n}', i));
}
/** The `:root[data-theme='dark'] { … }` block. */
function darkBlock(): string {
  const i = CSS.indexOf(":root[data-theme='dark'] {");
  return CSS.slice(i, CSS.indexOf('\n}', i));
}
/**
 * Tokens are declared several-per-line in the ramps
 * (`--color-neutral-100: #F7F5EE;  --color-neutral-200: #EFEBE0;`), so an
 * anchored `^\s*--x:` match sees only the first on each line and reports the
 * rest as undefined. Also caught by this test's own first run.
 */
function definedIn(block: string): Set<string> {
  return new Set([...block.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]));
}

/* ── contrast ─────────────────────────────────────────────────────────── */

function luminance(hexColour: string): number {
  let h = hexColour.replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const [r, g, b] = [0, 2, 4]
    .map((i) => parseInt(h.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
/** Resolve a token to its literal hex within one block, following aliases. */
function resolve(token: string, block: string, depth = 0): string | null {
  if (depth > 6) return null;
  const m = new RegExp(`^\\s*${token}\\s*:\\s*([^;]+);`, 'm').exec(block);
  if (!m) return null;
  const v = m[1].trim();
  if (v.startsWith('#')) return v;
  const alias = /^var\((--[a-z0-9-]+)\)$/.exec(v);
  return alias ? resolve(alias[1], block, depth + 1) : null;
}


/**
 * Tokens used with NO fallback and never defined.
 *
 * `var(--x, var(--y))` is safe and deliberate — the fallback is the whole
 * point, and app.css uses it. `var(--x)` alone is the dangerous form: an
 * undefined property drops the declaration and the element silently inherits
 * its parent's colour, which usually looks plausible. Only the second is a
 * bug, and an earlier version of this test conflated them.
 */
function undefinedWithoutFallback(prefix: string): string[] {
  const defined = definedIn(CSS_RAW);
  const re = new RegExp('var\\(\\s*(' + prefix + '[a-z0-9-]*)\\s*([,)])', 'g');
  const bad = new Set<string>();
  for (const m of CSS.matchAll(re)) {
    if (m[2] === ')' && !defined.has(m[1])) bad.add(m[1]);   // no fallback given
  }
  return [...bad];
}

describe('P0 — every alias resolves to a real value', () => {
  test('THE ONE THAT MATTERS — no --c-* token is used but never defined', () => {
    // An undefined custom property does not error; the declaration is simply
    // dropped and the element inherits. That is why this is a test and not a
    // thing anyone would notice by looking.
    const missing = undefinedWithoutFallback('--c-');
    assert.deepEqual(missing, [], `used but never defined: ${missing.join(', ')}`);
  });

  test('no --color-* token is used but never defined', () => {
    const missing = undefinedWithoutFallback('--color-');
    assert.deepEqual(missing, [], `used but never defined: ${missing.join(', ')}`);
  });

  test('the canonical Ata Ekta palette is present, not the pre-P0 one', () => {
    const light = lightBlock();
    assert.match(light, /--color-primary:\s*#D23B2E/i, 'the WCAG-corrected red');
    assert.match(light, /--color-surface:\s*#F1EFE6/i, 'the Muslin page ground');
    assert.match(light, /--color-text:\s*#53443D/i, 'Clove text');
    // The palette it replaced, which failed AA at 4.23:1 on white.
    assert.doesNotMatch(light, /--color-primary:\s*#e53935/i);
  });
});

describe('P0 — both themes carry the same token set', () => {
  test('THE ONE THAT MATTERS — dark redefines every status tint it needs', () => {
    // The original dark-mode failure: the neutral ramp inverted so text went
    // light, while the hand-set status tints stayed pale — every chip and
    // notice became light-on-light. Inverting a ramp only carries the tokens
    // that ALIAS it.
    const dark = darkBlock();
    for (const t of ['--c-primary-soft', '--c-danger-soft', '--c-warn-soft',
      '--c-success-soft', '--c-info-soft']) {
      assert.ok(dark.includes(`${t}:`), `dark theme must redefine ${t}`);
    }
  });

  test('dark redefines the grounds, the text ramp and the neutral ramp', () => {
    const dark = definedIn(darkBlock());
    for (const t of ['--color-bg', '--color-surface', '--color-surface-muted',
      '--color-text', '--color-text-muted', '--color-border',
      '--color-neutral-100', '--color-neutral-700', '--color-neutral-900']) {
      assert.ok(dark.has(t), `dark theme must redefine ${t}`);
    }
  });

  test('dark is warm, not the legacy cool near-black', () => {
    // A warm ground is the whole visual point of the Ata Ekta dark palette:
    // R = G = B would be neutral grey, and the pre-P0 dark was #1a1817.
    const bg = resolve('--color-surface', darkBlock());
    assert.ok(bg, 'dark --color-surface must resolve');
    let h = bg.replace('#', '');
    const [r, , b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
    assert.ok(r > b, `dark ground should be warm (R>B), got ${bg}`);
  });
});

describe('P0 — contrast obligations of the text tokens', () => {
  const light = lightBlock();
  const WHITE = '#FFFFFF';

  test('THE ONE THAT MATTERS — no text token aliases --color-text-faint', () => {
    // 3.49:1 on white and 3.03:1 on Muslin: it fails AA as body text. It is
    // canonical and kept for non-text ornament, but a text role must never
    // resolve to it — that is precisely the bug --c-ink-3 exists to prevent,
    // and it shipped once already on five screens.
    for (const t of ['--c-ink', '--c-ink-1', '--c-ink-2', '--c-ink-3']) {
      const v = resolve(t, light);
      assert.notEqual(v?.toUpperCase(), '#97867B', `${t} must not be text-faint`);
    }
  });

  test('the ink ramp clears AA on BOTH grounds', () => {
    const muslin = resolve('--color-surface', light);
    assert.ok(muslin);
    for (const t of ['--c-ink', '--c-ink-1', '--c-ink-2', '--c-ink-3']) {
      const v = resolve(t, light);
      assert.ok(v, `${t} must resolve to a literal`);
      for (const [name, ground] of [['white', WHITE], ['Muslin', muslin]] as const) {
        const r = contrast(v, ground);
        assert.ok(r >= 4.5, `${t} (${v}) on ${name} is ${r.toFixed(2)}:1, needs 4.5`);
      }
    }
  });

  test('status text colours clear AA on the Muslin ground they sit on', () => {
    const muslin = resolve('--color-surface', light);
    assert.ok(muslin);
    for (const t of ['--c-warn', '--c-success', '--c-info', '--c-primary-text', '--c-link']) {
      const v = resolve(t, light);
      assert.ok(v, `${t} must resolve`);
      const r = contrast(v, muslin);
      assert.ok(r >= 4.5, `${t} (${v}) on Muslin is ${r.toFixed(2)}:1, needs 4.5`);
    }
  });

  test('brand text clears AA on the RECESSED ground as well (P4)', () => {
    // --color-surface is the page. --color-surface-muted is what cards, chips
    // and the mobile bottom bar are painted with, and --c-primary-text lands
    // on it every time a bottom-bar tab is active — which is every mobile
    // screen in the product. That ground was never asserted here, which is
    // how tenant B's active tab reached 4.42:1 in dark mode and stayed there
    // until P4's browser sweep measured it. Both themes: the failure was
    // dark-only, and a light-only check would have said PASS.
    // The dark block redefines the RAW palette only; the --c-* aliases are
    // declared once, in :root. Concatenating dark first and light after gives
    // `resolve` (first match wins) exactly the cascade the browser applies.
    const DARK = [darkBlock(), lightBlock()].join(String.fromCharCode(10));
    for (const [theme, block] of [['light', lightBlock()], ['dark', DARK]] as const) {
      const muted = resolve('--c-surface', block);
      assert.ok(muted, theme + ': --c-surface must resolve');
      for (const t of ['--c-primary-text', '--c-link', '--c-ink-3']) {
        const v = resolve(t, block);
        assert.ok(v, theme + ': ' + t + ' must resolve');
        const r = contrast(v, muted);
        assert.ok(r >= 4.5,
          theme + ': ' + t + ' (' + v + ') on ' + muted + ' is ' + r.toFixed(2) + ':1');
      }
    }
  });

  test("branding.ts's surface literals still match this stylesheet (P4)", () => {
    // brandingCssVars derives a TENANT's brand text against these two hexes,
    // so a school with a pale crest gets a readable active tab. That module is
    // framework-free and cannot read app.css, so the two copies are compared
    // here rather than trusted to stay in step.
    for (const [theme, block, literal] of [
      ['light', lightBlock(), LIGHT_SURFACE],
      ['dark', [darkBlock(), lightBlock()].join(String.fromCharCode(10)), DARK_SURFACE],
    ] as const) {
      const muted = resolve('--c-surface', block);
      assert.ok(muted, theme + ': --c-surface must resolve');
      assert.equal(muted.toLowerCase(), literal.toLowerCase(),
        theme + ': branding.ts says ' + literal + ', app.css says ' + muted);
    }
  });

  test('the brand fill carries white label text at AA', () => {
    const primary = resolve('--c-primary', light);
    assert.ok(primary);
    const r = contrast(WHITE, primary);
    assert.ok(r >= 4.5, `white on --c-primary (${primary}) is ${r.toFixed(2)}:1`);
    // The correction that motivated the whole palette: the previous red was
    // 4.23:1 here and shipped anyway.
    assert.ok(r > 4.23, 'must beat the pre-P0 red it replaced');
  });
});

describe('P0 — the geometry that was already canonical stays untouched', () => {
  test('radius, tap target and spacing keep the values Ata Ekta already shared', () => {
    const light = lightBlock();
    assert.match(light, /--radius-sm:\s*8px/);
    assert.match(light, /--radius-md:\s*12px/);
    assert.match(light, /--radius-lg:\s*16px/);
    assert.match(light, /--tap-min:\s*48px/);
    assert.match(light, /--space-4:\s*16px/);
  });

  test('the Bangla type floor survived the semantic mapping', () => {
    // Ata Ekta's canonical body is 14px. This ladder's is 16px, deliberately:
    // Bangla conjuncts lose legibility before Latin does at the same optical
    // size. Adopting the canonical SIZES would have shrunk every screen.
    const light = lightBlock();
    assert.match(light, /--text-base:\s*16px/, 'Bangla body floor');
    assert.match(light, /--text-2xs:\s*13px/, 'Bangla-safe caption floor');
    assert.match(light, /--text-body:\s*var\(--text-base\)/, 'semantic name maps onto it');
  });
});
