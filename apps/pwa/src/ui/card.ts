/**
 * Cards, stats and avatars. (P2)
 *
 * §11 of the brief: "one canonical card system … do not create 20 visually
 * different card styles". The count today is closer to twenty than to one —
 * `.card`, `.home-card`, `.notice-card`, `.lesson-card`, `.next-card`,
 * `.quick`, `.brand-card`, `.assign-card` — each with its own padding and
 * radius, because each was written next to the screen that needed it.
 *
 * This is one card with **variants that mean something**, not variants that
 * look different:
 *
 *   `plain`        a container. Padding, hairline border, no shadow.
 *   `interactive`  the whole card navigates. Renders a <button>, gets hover,
 *                  focus and a chevron, and is keyboard-operable — which the
 *                  `<div onclick>` cards in this app are not.
 *   `accent`       one card on a screen may carry the brand tint. More than
 *                  one and the tint stops meaning "this one".
 *
 * A card is never *just* a rounded box here: if it has no title, no action and
 * no border to draw, the honest markup is a section, and the brief's "avoid
 * excessive cards" is that rule stated from the outside.
 */
import { el, icon, append, uid, type Child } from './dom.ts';

export type CardVariant = 'plain' | 'interactive' | 'accent';

export interface CardOptions {
  variant?: CardVariant;
  /** Rendered as an <h2>/<h3> — pass `headingLevel` when nesting under one. */
  title?: string;
  subtitle?: string;
  /** Icon name shown in a tinted square beside the title. */
  glyph?: string;
  /** Right-aligned control in the header row (a link, a menu, a small button). */
  action?: Child;
  /** Makes the whole card activate. Implies `variant: 'interactive'`. */
  onClick?: () => void;
  headingLevel?: 2 | 3;
  className?: string;
  /** Applied to the tinted glyph square: 'primary' | 'info' | 'success' | 'warn' | 'accent2'. */
  tone?: CardTone;
}

export type CardTone = 'primary' | 'info' | 'success' | 'warn' | 'accent2';

export function card(doc: Document, o: CardOptions, ...body: Child[]): HTMLElement {
  const interactive = Boolean(o.onClick) || o.variant === 'interactive';
  const cls = ['ui-card',
    o.variant === 'accent' ? 'ui-card-accent' : '',
    interactive ? 'ui-card-interactive' : '',
    o.className ?? ''].filter(Boolean).join(' ');

  // A card you can activate is a button, not a div with a click handler. The
  // div version is invisible to the keyboard and to every screen reader, and
  // this app has eight of them today.
  const root = interactive
    ? el(doc, 'button', { className: cls, attrs: { type: 'button' } })
    : el(doc, 'section', { className: cls });
  if (o.onClick) root.addEventListener('click', o.onClick);

  if (o.title || o.glyph || o.action) {
    const head = el(doc, 'div', { className: 'ui-card-head' });
    if (o.glyph) {
      append(head, el(doc, 'span', {
        className: 'ui-card-glyph', data: { tone: o.tone ?? 'primary' },
      }, icon(doc, o.glyph)));
    }
    if (o.title) {
      const text = el(doc, 'div', { className: 'ui-card-titles' });
      const id = uid('card');
      append(text, el(doc, o.headingLevel === 3 ? 'h3' : 'h2', {
        className: 'ui-card-title', text: o.title, attrs: { id },
      }));
      if (o.subtitle) {
        append(text, el(doc, 'p', { className: 'ui-card-sub', text: o.subtitle }));
      }
      append(head, text);
      // The card names itself for a reader; without this an interactive card
      // announces its entire body as its label.
      root.setAttribute('aria-labelledby', id);
    }
    if (o.action) append(head, el(doc, 'div', { className: 'ui-card-action' }, o.action));
    if (interactive) {
      append(head, el(doc, 'span', {
        className: 'ui-card-chevron', attrs: { 'aria-hidden': 'true' },
      }, icon(doc, 'chevron-right')));
    }
    root.append(head);
  }

  if (body.length) root.append(el(doc, 'div', { className: 'ui-card-body' }, ...body));
  return root;
}

export interface StatOptions {
  label: string;
  /** Pre-formatted. Bangla numerals and money formatting are the caller's job. */
  value: string;
  glyph?: string;
  tone?: CardTone;
  /** A short qualifier under the number — "এ মাসে ৯২%", "২৫ আগস্ট শেষ তারিখ". */
  note?: string;
  onClick?: () => void;
}

/**
 * One number and what it means.
 *
 * The label comes FIRST in the DOM and reads first to a screen reader, because
 * "২৮৬" alone is not information. Visually the number dominates; the order in
 * the markup is the order that makes sense read aloud, and CSS handles the
 * rest.
 */
export function statCard(doc: Document, o: StatOptions): HTMLElement {
  const interactive = Boolean(o.onClick);
  const root = interactive
    ? el(doc, 'button', { className: 'ui-stat ui-card-interactive', attrs: { type: 'button' } })
    : el(doc, 'div', { className: 'ui-stat' });
  if (o.onClick) root.addEventListener('click', o.onClick);

  if (o.glyph) {
    root.append(el(doc, 'span', {
      className: 'ui-stat-glyph', data: { tone: o.tone ?? 'primary' },
    }, icon(doc, o.glyph)));
  }
  const text = el(doc, 'div', { className: 'ui-stat-text' },
    el(doc, 'span', { className: 'ui-stat-label', text: o.label }),
    el(doc, 'span', { className: 'ui-stat-value', text: o.value }),
    o.note ? el(doc, 'span', { className: 'ui-stat-note', text: o.note }) : null);
  root.append(text);
  return root;
}

/** A responsive row of stat cards. Wraps rather than scrolls. */
export function statRow(doc: Document, ...cards: Child[]): HTMLElement {
  return el(doc, 'div', { className: 'ui-stat-row' }, ...cards);
}

/**
 * A person, as initials on their own colour — or a photo where one exists.
 *
 * 04-UIUX §6 makes initials the DEFAULT and photos opt-in: a 96px WebP is 4 KB
 * a school on 2G pays for every row of a roster, and a class of sixty is a
 * quarter of a megabyte to render a list of names.
 *
 * The colour is derived from the name so the same person is the same colour
 * everywhere, which makes a roster scannable without photos at all. It is a
 * hash, not a hue-of-the-day: stability is the whole point.
 */
export function avatar(doc: Document, o: {
  name: string;
  photoUrl?: string;
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}): HTMLElement {
  const cls = ['ui-avatar', `is-${o.size ?? 'md'}`, o.className ?? '']
    .filter(Boolean).join(' ');
  if (o.photoUrl) {
    return el(doc, 'img', {
      className: cls,
      attrs: { src: o.photoUrl, alt: '', loading: 'lazy', decoding: 'async' },
    });
  }
  return el(doc, 'span', {
    className: cls,
    // aria-hidden: the name is always rendered beside this. An avatar that
    // announces "র" adds nothing and interrupts the name that follows.
    attrs: { 'aria-hidden': 'true' },
    data: { tint: String(tintOf(o.name)) },
    text: initial(o.name),
  });
}

/**
 * The first grapheme of a name.
 *
 * Bangla is why this is not `name[0]`: `'ক্ষুদ্র'[0]` is `'ক'` with the
 * conjunct's other half orphaned into the next slot, so a roster of sixty
 * would show sixty broken clusters.
 */
export function initial(name: string): string {
  const t = name.trim();
  if (!t) return '•';
  try {
    const seg = new Intl.Segmenter('bn', { granularity: 'grapheme' });
    for (const g of seg.segment(t)) return g.segment;
  } catch { /* no Segmenter */ }
  return [...t][0] ?? '•';
}

/** Stable 0–5 tint index for a name. Same person, same colour, every screen. */
export function tintOf(name: string): number {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.codePointAt(0)!) % 100003;
  return h % 6;
}
