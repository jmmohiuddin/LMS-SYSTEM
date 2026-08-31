/**
 * Inline SVG icon set — the app's one icon system.
 *
 * Why inline SVG and not an icon font or emoji:
 *   • Emoji rendered the dashboard in the device colour-emoji font — a
 *     different weight and baseline per platform, childish beside a warm
 *     one-ink product, and uncolourable (they ignore `currentColor`, so an
 *     active tab could not tint its own glyph). "No emoji" is the rule.
 *   • An icon FONT is a self-hosted webfont, which N-01/TRD §3 forbid: a
 *     404'd font once broke the service-worker install outright.
 *   • Inline SVG costs no request, precaches with the bundle, scales to the
 *     container's font-size (width/height:1em), and inherits `currentColor`,
 *     so one glyph tints itself on the active tab and the primary card.
 *
 * The paths are the Feather set (MIT licensed), redrawn here rather than
 * pulled from npm so nothing is added to the offline precache but the ~2KB
 * of markup a school actually uses. One stroke weight (1.75) and round caps
 * across every icon — the consistency the mixed glyph set never had.
 *
 * Functional status marks that live INSIDE copy — the ✓/✗ in an attendance
 * cell, an answer verdict — are deliberately NOT icons here: they are text
 * that flows with Bangla and takes the ink colour already, and drawing them
 * as SVG would break that flow. This module is the navigation/action icon
 * system, not every glyph in the product.
 */

const PATHS: Record<string, string> = {
  // Navigation / chrome
  home: '<path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M9 22V12h6v10"/>',
  'more-horizontal':
    '<circle cx="5" cy="12" r="1.6" fill="currentColor" stroke="none"/>' +
    '<circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none"/>' +
    '<circle cx="19" cy="12" r="1.6" fill="currentColor" stroke="none"/>',
  'arrow-left': '<line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/>',
  'arrow-right': '<line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/>',
  bell: '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/>',
  'wifi-off':
    '<line x1="1" y1="1" x2="23" y2="23"/><path d="M16.72 11.06A11 11 0 0 1 19 12.55"/>' +
    '<path d="M5 12.55a11 11 0 0 1 5.17-2.39"/><path d="M10.71 5.05A16 16 0 0 1 22.58 9"/>' +
    '<path d="M1.42 9a16 16 0 0 1 4.7-2.88"/><path d="M8.53 16.11a6 6 0 0 1 6.95 0"/>' +
    '<line x1="12" y1="20" x2="12.01" y2="20"/>',

  // Learner surface
  'book-open':
    '<path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/>' +
    '<path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/>',
  layers: '<path d="M12 2 2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/>',
  percent: '<line x1="19" y1="5" x2="5" y2="19"/><circle cx="6.5" cy="6.5" r="2.5"/><circle cx="17.5" cy="17.5" r="2.5"/>',
  award: '<circle cx="12" cy="8" r="6"/><path d="M15.5 13.5 17 22l-5-3-5 3 1.5-8.5"/>',
  clipboard:
    '<path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/>' +
    '<rect x="8" y="2" width="8" height="4" rx="1"/>',
  message: '<path d="M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.4 8.4 0 0 1 3.8-.9h.5a8.5 8.5 0 0 1 8 8z"/>',
  clock: '<circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15 14"/>',
  // R-4. Feather's `calendar`, same 1.75 stroke and round caps as the rest.
  calendar:
    '<rect x="3" y="5" width="18" height="16" rx="2"/>' +
    '<line x1="16" y1="3" x2="16" y2="7"/><line x1="8" y1="3" x2="8" y2="7"/>' +
    '<line x1="3" y1="11" x2="21" y2="11"/>',
  wallet:
    '<path d="M20 12V7H5a2 2 0 0 1 0-4h14v4"/><path d="M3 5v14a2 2 0 0 0 2 2h16v-5"/>' +
    '<path d="M18 12a2 2 0 0 0 0 4h4v-4z"/>',
  refresh: '<polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>',
  star: '<polygon points="12 2 15.1 8.6 22 9.3 16.8 14 18.3 21 12 17.3 5.7 21 7.2 14 2 9.3 8.9 8.6"/>',

  // Teacher / coordinator surface
  'check-square':
    '<polyline points="9 11 12 14 20 6"/>' +
    '<path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>',
  users:
    '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/>' +
    '<path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z"/>',
  camera:
    '<path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/>' +
    '<circle cx="12" cy="13" r="4"/>',
  repeat:
    '<polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/>' +
    '<polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/>',
  lock: '<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  book:
    '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/>' +
    '<path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>',
  settings:
    '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',

  // Admin
  upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>',
  'alert-triangle':
    '<path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>' +
    '<line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>',
  'trending-up':
    '<polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/>',

  // Shell chrome (P1). `search` is the first of these that was already being
  // ASKED for: CARD.students has carried glyph:'search' since R-6 and has
  // been rendering the neutral fallback dot ever since — a nav row whose
  // icon means nothing. The fallback is deliberately silent, so nothing
  // reported it; the sidebar is what made it visible, because a rail of
  // icons with one dot in it cannot be misread as intentional.
  search: '<circle cx="11" cy="11" r="7"/><line x1="20" y1="20" x2="16.5" y2="16.5"/>',
  x: '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
  menu: '<line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/>',
  'chevron-down': '<polyline points="6 9 12 15 18 9"/>',
  'chevron-right': '<polyline points="9 6 15 12 9 18"/>',
  'log-out':
    '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/>' +
    '<polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/>',
  user: '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
  // The rail toggle. A left-hand panel glyph, not a hamburger: the hamburger
  // means "open a menu that is not there", and this sidebar never leaves.
  'panel-left':
    '<rect x="3" y="4" width="18" height="16" rx="2"/><line x1="9" y1="4" x2="9" y2="20"/>',
};

/** A stable fallback so an unknown name renders a neutral dot, never blank. */
const FALLBACK = '<circle cx="12" cy="12" r="3" fill="currentColor" stroke="none"/>';

/**
 * Returns the inline SVG markup for a named icon. Sized in `em`, so the
 * caller's font-size (the existing .home-glyph / .shell-tab-glyph rules)
 * still controls how big it is; coloured by `currentColor`, so it tints
 * with its container. aria-hidden because every caller labels the control
 * in text beside it.
 */
export function iconSvg(name: string): string {
  const inner = PATHS[name] ?? FALLBACK;
  return (
    `<svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" ` +
    `stroke="currentColor" stroke-width="1.75" stroke-linecap="round" ` +
    `stroke-linejoin="round" aria-hidden="true" focusable="false">${inner}</svg>`
  );
}

/** True when a name has a real icon (not the fallback dot). */
export function hasIcon(name: string): boolean {
  return name in PATHS;
}
