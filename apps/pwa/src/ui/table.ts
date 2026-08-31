/**
 * Tabular data, in two shapes. (P2)
 *
 * §7 of the brief: desktop gets a table, mobile gets a list, and horizontal
 * scrolling is a last resort rather than a layout. The failure this prevents is
 * the one every admin template ships with — a six-column table squeezed into
 * 360px, where a guardian reads a student's name two characters at a time.
 *
 * **One column description, two renderings.** The caller declares the columns
 * once and says what each one *is* on a phone: the title, a piece of meta, the
 * status, or not shown at all. A list is not a table with the borders removed;
 * it is the same record with a different thing in charge of it, and the only
 * way both stay correct is for one declaration to produce both.
 *
 * ── Why both are in the DOM at once ────────────────────────────────────────
 * Same decision as the shell (P1): render both, let a media query hide one.
 * `display:none` takes a subtree out of the accessibility tree too, so a
 * screen reader meets exactly one of them. The alternative is a `matchMedia`
 * listener that re-renders on a breakpoint cross, which costs a listener per
 * table, a lifecycle these views do not have, and a rebuild that drops focus
 * mid-interaction.
 *
 * The cost is roughly 5 extra nodes per row, which is why `page` exists below:
 * lists here are bounded at 50 rows by default. On the reference device — a
 * 2 GB Android on 2 G — an unbounded 500-row render is the thing to avoid,
 * and it was already the thing to avoid before this module existed.
 *
 * ── Empty is not an error ──────────────────────────────────────────────────
 * A table with no rows renders its empty state INSIDE itself, keeping the
 * header, because "no students match this filter" and "this school has no
 * students" look identical once the header is gone.
 */
import { el, append, uid, type Child } from './dom.ts';
import { emptyState, type EmptyOptions } from '../view-states.ts';
import { icon } from './dom.ts';

/** Where a column goes on a phone. */
export type MobileRole = 'title' | 'subtitle' | 'meta' | 'status' | 'hidden';

export interface Column<T> {
  /** Stable key. Used for the cell's `data-col`, which the CSS labels from. */
  key: string;
  header: string;
  cell: (row: T) => Child;
  /** Default `meta` — shown in the list's detail line. */
  mobile?: MobileRole;
  /** Right-aligns and applies tabular numerals. Amounts, marks, counts. */
  numeric?: boolean;
  /** Desktop width hint, e.g. '96px' or 'minmax(0, 2fr)'. */
  width?: string;
}

export interface TableOptions<T> {
  columns: Array<Column<T>>;
  rows: T[];
  /** Stable identity for a row — used for keys and the row action target. */
  rowKey: (row: T) => string;
  /** Makes each row activate. Renders a real control in both shapes. */
  onRowClick?: (row: T) => void;
  /** Accessible name for the table. Required: an unnamed table is a maze. */
  caption: string;
  /** Shown in place of the body when `rows` is empty. */
  empty?: EmptyOptions;
  className?: string;
}

/**
 * A table and its list, from one declaration.
 *
 * `<caption>` rather than `aria-label`: it is announced, it is the standard,
 * and on a narrow desktop it is the one thing that tells a reader which table
 * they have landed in.
 */
export function dataTable<T>(doc: Document, o: TableOptions<T>): HTMLElement {
  const wrap = el(doc, 'div', {
    className: ['ui-data', o.className ?? ''].filter(Boolean).join(' '),
  });

  if (!o.rows.length) {
    append(wrap, el(doc, 'p', { className: 'ui-sr-only', text: o.caption }),
      emptyState(doc, o.empty ?? { message: 'কোনো তথ্য নেই।' }));
    return wrap;
  }

  append(wrap, desktopTable(doc, o), mobileList(doc, o));
  return wrap;
}

function desktopTable<T>(doc: Document, o: TableOptions<T>): HTMLElement {
  const scroll = el(doc, 'div', { className: 'ui-table-scroll' });
  const table = el(doc, 'table', { className: 'ui-table' });
  append(table, el(doc, 'caption', { className: 'ui-sr-only', text: o.caption }));

  const thead = el(doc, 'thead');
  const hrow = el(doc, 'tr');
  for (const c of o.columns) {
    append(hrow, el(doc, 'th', {
      text: c.header,
      attrs: { scope: 'col' },
      data: { col: c.key, numeric: c.numeric ? 'true' : undefined },
      style: c.width ? { width: c.width } : undefined,
    }));
  }
  if (o.onRowClick) append(hrow, el(doc, 'th', { className: 'ui-sr-only', text: 'ক্রিয়া', attrs: { scope: 'col' } }));
  append(thead, hrow);
  append(table, thead);

  const tbody = el(doc, 'tbody');
  for (const row of o.rows) {
    const tr = el(doc, 'tr', { data: { key: o.rowKey(row) } });
    o.columns.forEach((c, i) => {
      // The FIRST column is a row header, not a cell: it is what identifies
      // the record, and `scope="row"` is what lets a reader say "সাদিয়া
      // ইসলাম, শ্রেণি, ৮ম" instead of reading bare values with no anchor.
      const cell = el(doc, i === 0 ? 'th' : 'td', {
        attrs: i === 0 ? { scope: 'row' } : {},
        data: { col: c.key, numeric: c.numeric ? 'true' : undefined },
      });
      append(cell, c.cell(row));
      append(tr, cell);
    });
    if (o.onRowClick) {
      const td = el(doc, 'td', { className: 'ui-table-action' });
      const btn = el(doc, 'button', {
        className: 'ui-row-open',
        attrs: { type: 'button', 'aria-label': `${o.columns[0].header}: খুলুন` },
      }, icon(doc, 'chevron-right'));
      btn.addEventListener('click', () => o.onRowClick!(row));
      append(td, btn);
      append(tr, td);
    }
    append(tbody, tr);
  }
  append(table, tbody);
  append(scroll, table);
  return scroll;
}

function mobileList<T>(doc: Document, o: TableOptions<T>): HTMLElement {
  const list = el(doc, 'ul', {
    className: 'ui-list', attrs: { 'aria-label': o.caption },
  });
  const byRole = (r: MobileRole) => o.columns.filter((c) => (c.mobile ?? 'meta') === r);
  const titles = byRole('title').length ? byRole('title') : [o.columns[0]];
  const subs = byRole('subtitle');
  const metas = byRole('meta').filter((c) => !titles.includes(c));
  const stats = byRole('status');

  for (const row of o.rows) {
    const li = el(doc, 'li', { className: 'ui-list-item', data: { key: o.rowKey(row) } });
    const inner = o.onRowClick
      ? el(doc, 'button', { className: 'ui-list-hit', attrs: { type: 'button' } })
      : el(doc, 'div', { className: 'ui-list-hit is-static' });
    if (o.onRowClick) inner.addEventListener('click', () => o.onRowClick!(row));

    const main = el(doc, 'div', { className: 'ui-list-main' });
    for (const c of titles) {
      append(main, el(doc, 'span', { className: 'ui-list-title' }, c.cell(row)));
    }
    for (const c of subs) {
      append(main, el(doc, 'span', { className: 'ui-list-sub' }, c.cell(row)));
    }
    if (metas.length) {
      const meta = el(doc, 'span', { className: 'ui-list-meta' });
      metas.forEach((c, i) => {
        if (i > 0) {
          append(meta, el(doc, 'span', {
            className: 'ui-list-dot', text: '·', attrs: { 'aria-hidden': 'true' },
          }));
        }
        // The column header goes in as a visually-hidden prefix. On a phone
        // the value stands alone with no header row to explain it, and
        // "০১৭xxxxxxxx" read without "অভিভাবকের ফোন" is a number from nowhere.
        append(meta, el(doc, 'span', { className: 'ui-list-cell' },
          el(doc, 'span', { className: 'ui-sr-only', text: `${c.header}: ` }),
          c.cell(row)));
      });
      append(main, meta);
    }
    append(inner, main);
    for (const c of stats) {
      append(inner, el(doc, 'span', { className: 'ui-list-status' }, c.cell(row)));
    }
    if (o.onRowClick) {
      append(inner, el(doc, 'span', {
        className: 'ui-list-chevron', attrs: { 'aria-hidden': 'true' },
      }, icon(doc, 'chevron-right')));
    }
    append(li, inner);
    append(list, li);
  }
  return list;
}

/**
 * A standalone list row, for the many places that are a list but not a table:
 * notices, documents, the More menu, a class's sections.
 */
export function listItem(doc: Document, o: {
  title: string;
  subtitle?: string;
  meta?: string;
  glyph?: string;
  status?: Child;
  onClick?: () => void;
  className?: string;
}): HTMLElement {
  const li = el(doc, 'li', {
    className: ['ui-list-item', o.className ?? ''].filter(Boolean).join(' '),
  });
  const inner = o.onClick
    ? el(doc, 'button', { className: 'ui-list-hit', attrs: { type: 'button' } })
    : el(doc, 'div', { className: 'ui-list-hit is-static' });
  if (o.onClick) inner.addEventListener('click', o.onClick);
  if (o.glyph) append(inner, el(doc, 'span', { className: 'ui-list-glyph' }, icon(doc, o.glyph)));
  const main = el(doc, 'div', { className: 'ui-list-main' },
    el(doc, 'span', { className: 'ui-list-title', text: o.title }),
    o.subtitle ? el(doc, 'span', { className: 'ui-list-sub', text: o.subtitle }) : null,
    o.meta ? el(doc, 'span', { className: 'ui-list-meta', text: o.meta }) : null);
  append(inner, main);
  if (o.status) append(inner, el(doc, 'span', { className: 'ui-list-status' }, o.status));
  if (o.onClick) {
    append(inner, el(doc, 'span', {
      className: 'ui-list-chevron', attrs: { 'aria-hidden': 'true' },
    }, icon(doc, 'chevron-right')));
  }
  append(li, inner);
  return li;
}

/** A `<ul>` for `listItem`s. */
export function list(doc: Document, label: string, ...items: Child[]): HTMLElement {
  return el(doc, 'ul', { className: 'ui-list', attrs: { 'aria-label': label } }, ...items);
}

/**
 * Pagination.
 *
 * Numbered pages, not infinite scroll: a teacher looking for one student in
 * six hundred needs to be able to go back to where they were, and on 2 G an
 * infinite list is an unbounded download nobody asked for. Prev/next plus a
 * live position — "৩ / ১২" — is enough, and the live region announces the
 * move for anyone who cannot see the page change.
 */
export function pagination(doc: Document, o: {
  page: number;          // 1-based
  pageCount: number;
  onGo: (page: number) => void;
  /** e.g. "৬০০ জনের মধ্যে ৫১–১০০" */
  summary?: string;
}): HTMLElement | null {
  if (o.pageCount <= 1) return null;
  const nav = el(doc, 'nav', {
    className: 'ui-pagination', attrs: { 'aria-label': 'পাতা' },
  });
  const mk = (label: string, glyph: string, to: number, disabled: boolean) => {
    const b = el(doc, 'button', {
      className: 'ui-page-btn',
      attrs: { type: 'button', 'aria-label': label, disabled: disabled || null },
    }, icon(doc, glyph));
    if (!disabled) b.addEventListener('click', () => o.onGo(to));
    return b;
  };
  append(nav,
    mk('আগের পাতা', 'arrow-left', o.page - 1, o.page <= 1),
    el(doc, 'span', {
      className: 'ui-page-pos',
      text: o.summary ?? `${bn(o.page)} / ${bn(o.pageCount)}`,
      attrs: { 'aria-live': 'polite' },
    }),
    mk('পরের পাতা', 'arrow-right', o.page + 1, o.page >= o.pageCount));
  return nav;
}

/**
 * A vertical timeline — an audit trail, a student's history, a fee ledger.
 *
 * An ordered list, because the order is the meaning. The rail and dots are
 * `::before` decoration in CSS, not nodes, so a reader hears the entries and
 * not a column of bullets.
 */
export function timeline(doc: Document, o: {
  label: string;
  entries: Array<{ when: string; title: string; detail?: string; tone?: string; glyph?: string }>;
}): HTMLElement {
  const ol = el(doc, 'ol', { className: 'ui-timeline', attrs: { 'aria-label': o.label } });
  for (const e of o.entries) {
    append(ol, el(doc, 'li', {
      className: 'ui-timeline-item', data: { tone: e.tone ?? 'neutral' },
    },
      el(doc, 'span', { className: 'ui-timeline-mark', attrs: { 'aria-hidden': 'true' } },
        e.glyph ? icon(doc, e.glyph) : null),
      el(doc, 'div', { className: 'ui-timeline-body' },
        el(doc, 'p', { className: 'ui-timeline-when', text: e.when }),
        el(doc, 'p', { className: 'ui-timeline-title', text: e.title }),
        e.detail ? el(doc, 'p', { className: 'ui-timeline-detail', text: e.detail }) : null)));
  }
  return ol;
}

function bn(n: number): string {
  return String(n).replace(/\d/g, (d) => '০১২৩৪৫৬৭৮৯'[Number(d)]);
}

/** Convenience id for a table's caption when one is generated. */
export const tableId = uid;
