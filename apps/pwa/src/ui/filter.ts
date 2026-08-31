/**
 * Tabs and filters. (P2)
 *
 * §20: a filter bar on desktop, a filter BUTTON on a phone that opens a sheet.
 * Not the same controls at a smaller size — a row of four selects at 360px is
 * either four lines tall or four unusable 60px dropdowns, and either way it
 * pushes the data it filters off the screen entirely.
 *
 * The other half of §20 matters more and is usually missed: **active filters
 * must be visible, and clearable in one tap.** A person who filtered a roster
 * to one section last week and comes back to an empty-looking screen does not
 * think "I have a filter on"; they think the students are gone.
 */
import { el, icon, append, uid, type Child } from './dom.ts';
import { openDrawer } from './overlay.ts';
import { announce } from './feedback.ts';

export interface TabItem {
  id: string;
  label: string;
  /** A count beside the label — "অনুপস্থিত ৪". */
  count?: number;
}

/**
 * Tabs.
 *
 * The full ARIA tab pattern, including the keyboard behaviour people actually
 * expect: arrow keys move between tabs, Home/End jump to the ends, and only
 * the selected tab is in the tab order — so Tab moves *out* of the tab strip
 * into the panel rather than through six tabs one at a time.
 */
export function tabs(doc: Document, o: {
  items: TabItem[];
  active: string;
  onSelect: (id: string) => void;
  label: string;
  className?: string;
}): HTMLElement {
  const strip = el(doc, 'div', {
    className: ['ui-tabs', o.className ?? ''].filter(Boolean).join(' '),
    attrs: { role: 'tablist', 'aria-label': o.label },
  });
  const buttons: HTMLButtonElement[] = [];

  o.items.forEach((item) => {
    const selected = item.id === o.active;
    const b = el(doc, 'button', {
      className: 'ui-tab',
      attrs: {
        type: 'button', role: 'tab',
        'aria-selected': String(selected),
        // Roving tabindex: one stop for the whole strip.
        tabindex: selected ? '0' : '-1',
        id: `tab-${item.id}`,
      },
      data: { id: item.id },
    }, el(doc, 'span', { text: item.label }));
    if (item.count !== undefined) {
      append(b, el(doc, 'span', { className: 'ui-tab-count', text: bn(item.count) }));
    }
    b.addEventListener('click', () => o.onSelect(item.id));
    buttons.push(b);
    append(strip, b);
  });

  strip.addEventListener('keydown', (e) => {
    const key = (e as KeyboardEvent).key;
    const i = buttons.findIndex((b) => b === doc.activeElement);
    if (i < 0) return;
    let next = -1;
    if (key === 'ArrowRight') next = (i + 1) % buttons.length;
    else if (key === 'ArrowLeft') next = (i - 1 + buttons.length) % buttons.length;
    else if (key === 'Home') next = 0;
    else if (key === 'End') next = buttons.length - 1;
    if (next < 0) return;
    e.preventDefault();
    buttons[next].focus();
    o.onSelect(buttons[next].dataset.id!);
  });

  return strip;
}

export interface FilterDef {
  id: string;
  label: string;
  options: Array<{ value: string; label: string }>;
  value: string;
  /** The value that means "no filter". Defaults to ''. */
  anyValue?: string;
}

/**
 * A filter bar on desktop; a button and a sheet on a phone.
 *
 * Both renderings are in the DOM and CSS picks one, as everywhere else in this
 * system — the state lives in the caller's `values`, so the two cannot
 * disagree about what is filtered.
 */
export function filterBar(doc: Document, o: {
  filters: FilterDef[];
  onChange: (id: string, value: string) => void;
  onClearAll: () => void;
  /** Rendered at the end of the bar on desktop — a search box, a date picker. */
  extra?: Child;
  label?: string;
}): HTMLElement {
  const active = o.filters.filter((f) => f.value !== (f.anyValue ?? ''));
  const wrap = el(doc, 'div', {
    className: 'ui-filters', attrs: { 'aria-label': o.label ?? 'ছাঁকনি' },
  });

  // ── desktop: inline selects ──────────────────────────────────────────
  const inline = el(doc, 'div', { className: 'ui-filters-inline' });
  for (const f of o.filters) append(inline, selectControl(doc, f, o.onChange));
  if (o.extra) append(inline, el(doc, 'div', { className: 'ui-filters-extra' }, o.extra));

  // ── mobile: one button that opens the sheet ──────────────────────────
  const openBtn = el(doc, 'button', {
    className: 'ui-filters-open',
    attrs: {
      type: 'button',
      'aria-label': active.length
        ? `ছাঁকনি — ${bn(active.length)}টি চালু`
        : 'ছাঁকনি',
    },
  }, icon(doc, 'layers'), el(doc, 'span', { text: 'ছাঁকনি' }),
     active.length
       ? el(doc, 'span', { className: 'ui-count', text: bn(active.length) })
       : null);
  openBtn.addEventListener('click', () => {
    const body = el(doc, 'div', { className: 'ui-filter-sheet' });
    for (const f of o.filters) {
      append(body, selectControl(doc, f, (id, v) => { o.onChange(id, v); }, true));
    }
    openDrawer(doc, { title: 'ছাঁকনি', body });
  });

  append(wrap, inline, openBtn);

  // ── active filters, always visible, one tap to clear ─────────────────
  if (active.length) {
    const chips = el(doc, 'div', {
      className: 'ui-filter-active', attrs: { 'aria-label': 'চালু ছাঁকনি' },
    });
    for (const f of active) {
      const shown = f.options.find((x) => x.value === f.value)?.label ?? f.value;
      const chip = el(doc, 'button', {
        className: 'ui-filter-chip',
        attrs: { type: 'button', 'aria-label': `${f.label}: ${shown} — সরান` },
      }, el(doc, 'span', { text: `${f.label}: ${shown}` }), icon(doc, 'x'));
      chip.addEventListener('click', () => {
        o.onChange(f.id, f.anyValue ?? '');
        announce(doc, `${f.label} ছাঁকনি সরানো হয়েছে`);
      });
      append(chips, chip);
    }
    const clear = el(doc, 'button', {
      className: 'ui-filter-clear', text: 'সব সরান', attrs: { type: 'button' },
    });
    clear.addEventListener('click', () => {
      o.onClearAll();
      announce(doc, 'সব ছাঁকনি সরানো হয়েছে');
    });
    append(chips, clear);
    append(wrap, chips);
  }

  return wrap;
}

function selectControl(
  doc: Document,
  f: FilterDef,
  onChange: (id: string, value: string) => void,
  stacked = false,
): HTMLElement {
  const id = uid('flt');
  const wrap = el(doc, 'div', {
    className: stacked ? 'ui-filter-field is-stacked' : 'ui-filter-field',
  });
  append(wrap, el(doc, 'label', {
    className: stacked ? 'ui-field-label' : 'ui-sr-only',
    text: f.label, attrs: { for: id },
  }));
  const sel = el(doc, 'select', {
    className: 'ui-input ui-select', attrs: { id, name: f.id },
  });
  for (const opt of f.options) {
    const node = el(doc, 'option', { text: opt.label, attrs: { value: opt.value } });
    if (opt.value === f.value) node.selected = true;
    append(sel, node);
  }
  sel.addEventListener('change', () => onChange(f.id, sel.value));
  append(wrap, sel);
  return wrap;
}

function bn(n: number): string {
  return String(n).replace(/\d/g, (d) => '০১২৩৪৫৬৭৮৯'[Number(d)]);
}
