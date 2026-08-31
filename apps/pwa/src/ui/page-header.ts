/**
 * The page header, and the badges that sit in one. (P2)
 *
 * 29 view modules build this by hand today — the same seven lines each time:
 * a `<header class="page-header">`, an `<h1>`, a `<p class="page-sub">`,
 * `append`. That is ~200 lines of identical DOM construction, and it is why no
 * screen has a description, a breadcrumb or a primary action in its header:
 * adding one meant editing 29 places, so nobody did.
 *
 * §8 of the brief asks for:
 *
 *     Breadcrumb
 *     Page Title
 *     Short explanation
 *     Primary action
 *     Secondary actions
 *
 * The DOM this produces for `{ title, subtitle }` alone is byte-identical to
 * what the 29 views already build, so adopting it is a no-op visually and the
 * extra slots simply become available.
 *
 * ── Why the breadcrumb is optional here ────────────────────────────────────
 * The shell's topbar already renders one on desktop (P1), and repeating it in
 * the content is exactly the duplication §5 forbids. This slot exists for the
 * case the shell cannot serve: a screen reached *inside* another screen — a
 * section under a class, a student under a section — where the trail is data,
 * not navigation, and only the view knows it.
 */
import { el, icon, append, type Child } from './dom.ts';

export interface Crumb {
  label: string;
  /** Hash path without `#/`. Omit for the current (last) crumb. */
  path?: string;
}

export interface PageHeaderOptions {
  title: string;
  /** One sentence on what this screen is for. Not a status line. */
  subtitle?: string;
  /** In-content trail, for hierarchy the shell cannot know. */
  crumbs?: Crumb[];
  /** The one action this screen exists for. */
  primary?: Child;
  /** Everything else — export, filter, settings. Rendered before the primary. */
  actions?: Child[];
  /** A status chip beside the title (e.g. "খসড়া", "প্রকাশিত"). */
  badge?: Child;
  className?: string;
}

/**
 * `<header class="page-header">` with the same `<h1>` and `.page-sub` the
 * hand-built ones produce, plus the slots they never had.
 */
export function pageHeader(doc: Document, o: PageHeaderOptions): HTMLElement {
  const head = el(doc, 'header', {
    className: ['page-header', o.className ?? ''].filter(Boolean).join(' '),
  });

  if (o.crumbs?.length) head.append(breadcrumb(doc, o.crumbs));

  const row = el(doc, 'div', { className: 'page-header-main' });
  const titles = el(doc, 'div', { className: 'page-header-text' });

  const h1 = el(doc, 'h1', { text: o.title });
  if (o.badge) {
    append(titles, el(doc, 'div', { className: 'page-title-row' }, h1, o.badge));
  } else {
    append(titles, h1);
  }
  if (o.subtitle) {
    append(titles, el(doc, 'p', { className: 'page-sub', text: o.subtitle }));
  }
  row.append(titles);

  if (o.actions?.length || o.primary) {
    // Secondary first, primary last — priority order. On desktop the row is
    // right-aligned and the eye finishes on the primary; on a phone the same
    // order stacks with the primary bottom-most, under the thumb.
    const acts = el(doc, 'div', { className: 'page-header-actions' });
    append(acts, ...(o.actions ?? []), o.primary);
    row.append(acts);
  }

  head.append(row);
  return head;
}

/**
 * A trail. The last crumb is the current page and is not a link.
 *
 * `<nav aria-label>` + `<ol>`: a breadcrumb is an ordered list of ancestors,
 * and a reader that knows the pattern announces "list, 3 items" instead of
 * three unexplained links. The separator is a decorative `aria-hidden` span,
 * never a character inside a link's text.
 */
export function breadcrumb(doc: Document, crumbs: Crumb[]): HTMLElement {
  const nav = el(doc, 'nav', {
    className: 'ui-crumb', attrs: { 'aria-label': 'অবস্থান' },
  });
  const list = el(doc, 'ol', { className: 'ui-crumb-list' });
  crumbs.forEach((c, i) => {
    const last = i === crumbs.length - 1;
    const li = el(doc, 'li', { className: 'ui-crumb-item' });
    if (i > 0) {
      append(li, el(doc, 'span', {
        className: 'ui-crumb-sep', text: '›', attrs: { 'aria-hidden': 'true' },
      }));
    }
    if (c.path && !last) {
      append(li, el(doc, 'a', { className: 'ui-crumb-link', text: c.label,
        attrs: { href: `#/${c.path}` } }));
    } else {
      append(li, el(doc, 'span', { className: 'ui-crumb-current', text: c.label,
        attrs: last ? { 'aria-current': 'page' } : {} }));
    }
    list.append(li);
  });
  nav.append(list);
  return nav;
}

/**
 * A "back to X" control for a drill-down.
 *
 * A `<button>` calling the view's own handler rather than `history.back()`:
 * the view knows what it was showing, the history does not, and going back
 * from a section to its class must not depend on how the person arrived.
 */
export function backLink(doc: Document, label: string, onBack: () => void): HTMLElement {
  const btn = el(doc, 'button', {
    className: 'ui-back', attrs: { type: 'button' },
  }, icon(doc, 'arrow-left'), el(doc, 'span', { text: label }));
  btn.addEventListener('click', onBack);
  return btn;
}

/**
 * A section heading inside a page — the level below the page title.
 *
 * `<h2>` by default so the document outline is title → section → card, which
 * is what a screen reader's heading navigation walks. The optional action is
 * for "সব দেখুন" links, which today are `<a>` tags floated by six different
 * rules.
 */
export function sectionHeading(doc: Document, o: {
  title: string;
  action?: Child;
  level?: 2 | 3;
  className?: string;
}): HTMLElement {
  const wrap = el(doc, 'div', {
    className: ['ui-section-head', o.className ?? ''].filter(Boolean).join(' '),
  });
  append(wrap, el(doc, o.level === 3 ? 'h3' : 'h2', {
    className: 'ui-section-title', text: o.title,
  }));
  if (o.action) append(wrap, el(doc, 'div', { className: 'ui-section-action' }, o.action));
  return wrap;
}
