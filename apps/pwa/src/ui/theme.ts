/**
 * Theme preference — one implementation, three callers. (P1)
 *
 * F-1607's rule, unchanged: 'system' is the default and is stored as the
 * ABSENCE of a key, so a student who never touches this follows their phone
 * forever, including when Android flips it at sunset. Pinning writes the key;
 * returning to system removes it. Storing the literal string 'system' would
 * work right up until someone read it back as a third theme and tried to
 * render it.
 *
 * Extracted in P1 because the profile menu in the shell needs the same
 * control the More screen already had. Two copies of a four-line rule is how
 * a preference ends up applied one way and read another.
 *
 * The boot script in app.html is a deliberate fourth copy: it must run before
 * the stylesheet paints, with no module graph to wait for, or a student who
 * chose dark sees a white flash on every open. `themeTest.ts`-free by
 * design — the duplication is asserted by shell-desktop.test.ts instead, so
 * the two cannot drift.
 */

export type ThemePref = 'light' | 'dark' | null;

const KEY = 'shikhon_theme';

/** The stored preference, or null for 'follow the phone'. */
export function readTheme(): ThemePref {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' ? v : null;
  } catch {
    // Private mode: nothing can be remembered, so the answer is the default.
    return null;
  }
}

/** Store a preference and apply it. Passing null returns to 'follow phone'. */
export function setTheme(pref: ThemePref): void {
  try {
    if (pref === null) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, pref);
  } catch { /* private mode: the choice applies for this session only */ }
  applyTheme(pref);
}

/** Mirrors the boot script in app.html — same rule, applied live. */
export function applyTheme(pref: ThemePref): void {
  const dark = pref === 'dark'
    || (pref !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
}

/** The three choices, in the order they are offered. */
export const THEME_OPTIONS: Array<{ value: ThemePref; labelBn: string }> = [
  { value: null, labelBn: 'ফোন অনুযায়ী' },
  { value: 'light', labelBn: 'উজ্জ্বল' },
  { value: 'dark', labelBn: 'অন্ধকার' },
];
