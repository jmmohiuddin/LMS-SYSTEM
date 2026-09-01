/**
 * The child selector. (UI integration plan, P4 — §3 "CRITICAL")
 *
 * §9.1 of the wireframe calls this "the single most-used control here", and
 * the brief's rule is blunter: **never make a parent wonder which child they
 * are viewing.** Everything below follows from that one sentence.
 *
 * ── Why this is a component and not a `<select>` ───────────────────────────
 * A guardian is the persona with the lowest technical comfort in the product
 * and may open the app four times a year. A dropdown collapsed to a single
 * line answers "which child" only after you tap it — which is exactly the
 * moment the answer stops mattering. With two or three children the names sit
 * side by side, permanently, and the question never gets asked.
 *
 * Beyond three, side-by-side stops fitting a 360px screen and the control
 * becomes a button that opens a sheet — the same information, one tap away,
 * with the current child still named on the button itself. The threshold is
 * about width, not about taste.
 *
 * ── One child is not a choice ──────────────────────────────────────────────
 * With a single child there is no selector at all, only the identity block. A
 * control with one option is a control that teaches people their tap did
 * nothing.
 *
 * ── What it must show ──────────────────────────────────────────────────────
 * Name, class-and-section, and roll. The roll is what a guardian reads down
 * the phone to the school office, so it stays in Latin digits like every other
 * identifier in this product (`formatIdentifier`) — "রোল ০১" cannot be
 * cross-checked against a paper register.
 */
import { el, append, icon, uid, type Child } from './dom.ts';
import { avatar } from './card.ts';
import { openDrawer } from './overlay.ts';
import { announce } from './feedback.ts';
import { formatIdentifier } from '../../../../packages/ui-core/src/format.ts';

export interface ChildOption {
  studentId: string;
  nameBn: string;
  /** "নবম–ক". Already composed by the caller from the server's answer. */
  sectionLabel: string;
  rollNo: number;
  /** "মা", "বাবা" — shown only in the sheet, where there is room. */
  relationBn?: string;
}

export interface ChildSelectorOptions {
  children: ChildOption[];
  selectedId: string | null;
  onSelect: (studentId: string) => void;
  /** Above this many, the inline strip becomes a button and a sheet. */
  inlineMax?: number;
}

const DEFAULT_INLINE_MAX = 3;

/**
 * The selector, or nothing when there is nothing to select.
 *
 * Returns `null` for zero or one child so a caller can `append(root, sel)`
 * without a conditional — `append` skips nulls.
 */
export function childSelector(
  doc: Document,
  o: ChildSelectorOptions,
): HTMLElement | null {
  if (o.children.length < 2) return null;
  return o.children.length <= (o.inlineMax ?? DEFAULT_INLINE_MAX)
    ? inlineStrip(doc, o)
    : sheetButton(doc, o);
}

/** Two or three children: the names are simply both on screen. */
function inlineStrip(doc: Document, o: ChildSelectorOptions): HTMLElement {
  const strip = el(doc, 'div', {
    className: 'ui-child-strip',
    attrs: { role: 'tablist', 'aria-label': 'সন্তান নির্বাচন' },
  });
  o.children.forEach((c) => {
    const selected = c.studentId === o.selectedId;
    const b = el(doc, 'button', {
      className: 'ui-child-opt',
      attrs: {
        type: 'button', role: 'tab',
        'aria-selected': String(selected),
        // Roving tabindex: the strip is one stop, so Tab leaves it for the
        // content rather than walking through every child.
        tabindex: selected ? '0' : '-1',
        // The accessible name carries the class too. "আনিকা" and "আনিকা" are
        // two different children in more Bangladeshi families than not.
        'aria-label': `${c.nameBn} — ${c.sectionLabel}`,
      },
      data: { id: c.studentId },
    },
      avatar(doc, { name: c.nameBn, size: 'sm' }),
      el(doc, 'span', { className: 'ui-child-opt-text' },
        el(doc, 'span', { className: 'ui-child-opt-name', text: c.nameBn }),
        el(doc, 'span', { className: 'ui-child-opt-meta', text: c.sectionLabel })));
    b.addEventListener('click', () => pick(doc, o, c));
    append(strip, b);
  });

  strip.addEventListener('keydown', (e) => {
    const key = (e as KeyboardEvent).key;
    const btns = [...strip.querySelectorAll<HTMLButtonElement>('.ui-child-opt')];
    const i = btns.findIndex((b) => b === doc.activeElement);
    if (i < 0) return;
    let next = -1;
    if (key === 'ArrowRight') next = (i + 1) % btns.length;
    else if (key === 'ArrowLeft') next = (i - 1 + btns.length) % btns.length;
    else if (key === 'Home') next = 0;
    else if (key === 'End') next = btns.length - 1;
    if (next < 0) return;
    e.preventDefault();
    btns[next].focus();
    btns[next].click();
  });
  return strip;
}

/** Four or more: a button naming the current child, and a sheet. */
function sheetButton(doc: Document, o: ChildSelectorOptions): HTMLElement {
  const current = o.children.find((c) => c.studentId === o.selectedId) ?? o.children[0];
  const btn = el(doc, 'button', {
    className: 'ui-child-button',
    attrs: {
      type: 'button',
      'aria-haspopup': 'dialog',
      'aria-label': `${current.nameBn} — ${current.sectionLabel}. অন্য সন্তান বেছে নিন`,
    },
  },
    avatar(doc, { name: current.nameBn, size: 'md' }),
    el(doc, 'span', { className: 'ui-child-opt-text' },
      el(doc, 'span', { className: 'ui-child-opt-name', text: current.nameBn }),
      el(doc, 'span', { className: 'ui-child-opt-meta', text: current.sectionLabel })),
    icon(doc, 'chevron-down', 'ui-child-caret'));

  btn.addEventListener('click', () => {
    const list = el(doc, 'ul', {
      className: 'ui-child-list', attrs: { 'aria-label': 'সন্তান' },
    });
    const handle = openDrawer(doc, { title: 'কোন সন্তান?', body: list });
    for (const c of o.children) {
      const selected = c.studentId === o.selectedId;
      const row = el(doc, 'button', {
        className: 'ui-child-row',
        attrs: {
          type: 'button',
          // aria-current, not aria-selected: these are list items, not tabs.
          'aria-current': selected ? 'true' : 'false',
        },
      },
        avatar(doc, { name: c.nameBn, size: 'md' }),
        el(doc, 'span', { className: 'ui-child-opt-text' },
          el(doc, 'span', { className: 'ui-child-opt-name', text: c.nameBn }),
          el(doc, 'span', { className: 'ui-child-opt-meta',
            text: [c.sectionLabel, `রোল ${formatIdentifier(c.rollNo)}`,
                   c.relationBn].filter(Boolean).join(' · ') })),
        // A word, not only a tint: this row IS the answer to "which child",
        // and a highlight nobody remembers the meaning of is not an answer.
        selected
          ? el(doc, 'span', { className: 'ui-child-current', text: 'দেখছেন' })
          : null);
      row.addEventListener('click', () => { handle.close(); pick(doc, o, c); });
      append(list, el(doc, 'li', {}, row));
    }
  });
  return btn;
}

function pick(doc: Document, o: ChildSelectorOptions, c: ChildOption): void {
  if (c.studentId === o.selectedId) return;
  // Announced because the whole page is about to change underneath a person
  // who may not see it change.
  announce(doc, `${c.nameBn} — ${c.sectionLabel} দেখানো হচ্ছে`);
  o.onSelect(c.studentId);
}

/**
 * The identity block: whose screen this is.
 *
 * Rendered on every guardian screen that shows one child's data, directly
 * above the content, so the answer to "which child am I looking at" is never
 * more than a glance away — including after a back-navigation, a reload, or a
 * week away from the app.
 */
export function childIdentity(doc: Document, c: ChildOption, extra?: Child): HTMLElement {
  const box = el(doc, 'div', { className: 'ui-child-identity' });
  append(box,
    avatar(doc, { name: c.nameBn, size: 'lg' }),
    el(doc, 'div', { className: 'ui-child-identity-text' },
      el(doc, 'p', { className: 'ui-child-identity-name', text: c.nameBn }),
      el(doc, 'p', { className: 'ui-child-identity-meta',
        // Latin roll: it is an identifier, and it is what a guardian reads
        // down the phone to the office.
        text: `${c.sectionLabel} · রোল ${formatIdentifier(c.rollNo)}` })),
    extra);
  return box;
}

/** Stable id helper for callers that need to label a region by the child. */
export const childRegionId = uid;
