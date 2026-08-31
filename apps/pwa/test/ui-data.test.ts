/**
 * The component system: tables, overlays, filters, feedback. (P2)
 *
 * The overlay tests carry the most weight. A focus trap is the one component
 * where "it looks right" and "it works" are unrelated: a dialog that traps
 * focus but never returns it, or that leaves the page behind it readable to a
 * screen reader, looks perfect and is unusable.
 */
import { test, describe, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

import { el } from '../src/ui/dom.ts';
import { dataTable, listItem, list, pagination, timeline, type Column } from '../src/ui/table.ts';
import { openOverlay, confirmOverlay, openDrawer } from '../src/ui/overlay.ts';
import { tabs, filterBar } from '../src/ui/filter.ts';
import { humanError, permissionState, toast, announce, progress, listSkeleton } from '../src/ui/feedback.ts';
import { statusBadge } from '../src/ui/badge.ts';

let dom: JSDOM;
const doc = () => dom.window.document;
const host = () => doc().getElementById('root') as HTMLElement;

before(() => {
  dom = new JSDOM('<!doctype html><html lang="bn"><body><main id="root"></main></body></html>',
    { url: 'http://localhost/app' });
  const g = globalThis as Record<string, unknown>;
  g.HTMLElement = dom.window.HTMLElement;
  g.KeyboardEvent = dom.window.KeyboardEvent;
  g.document = dom.window.document;
});

beforeEach(() => {
  host().textContent = '';
  for (const s of doc().querySelectorAll('.ui-scrim, .ui-toast-host')) s.remove();
});

interface Student { id: string; roll: number; name: string; cls: string; phone: string; due: number }
const STUDENTS: Student[] = [
  { id: 'a', roll: 1, name: 'সাদিয়া ইসলাম', cls: '৮ম', phone: '01712345678', due: 1500 },
  { id: 'b', roll: 2, name: 'আরিফ রহমান', cls: '৮ম', phone: '01812345678', due: 0 },
];
const COLS: Array<Column<Student>> = [
  { key: 'name', header: 'নাম', cell: (r) => r.name, mobile: 'title' },
  { key: 'roll', header: 'রোল', cell: (r) => String(r.roll), numeric: true, mobile: 'meta' },
  { key: 'cls', header: 'শ্রেণি', cell: (r) => r.cls, mobile: 'subtitle' },
  { key: 'phone', header: 'অভিভাবকের ফোন', cell: (r) => r.phone, mobile: 'meta' },
  {
    key: 'due', header: 'বকেয়া', numeric: true, mobile: 'status',
    cell: (r) => statusBadge(doc(), {
      state: r.due > 0 ? 'overdue' : 'paid',
      label: r.due > 0 ? 'বকেয়া' : 'পরিশোধিত',
    }),
  },
];

describe('P2 — one declaration, two renderings', () => {
  test('THE ONE THAT MATTERS — a table and a list, from the same columns', () => {
    // §7. Not a table with the borders removed: the same record with a
    // different thing in charge of it. One declaration is the only way both
    // stay correct.
    const t = dataTable(doc(), {
      columns: COLS, rows: STUDENTS, rowKey: (r) => r.id, caption: 'শিক্ষার্থী তালিকা',
    });
    assert.ok(t.querySelector('table.ui-table'), 'desktop table missing');
    assert.ok(t.querySelector('ul.ui-list'), 'mobile list missing');
    assert.equal(t.querySelectorAll('tbody tr').length, 2);
    assert.equal(t.querySelectorAll('.ui-list-item').length, 2);
  });

  test('THE ONE THAT MATTERS — a phone carries the column header with the value', () => {
    // On a list there is no header row. "০১৭xxxxxxxx" read without
    // "অভিভাবকের ফোন" is a number from nowhere.
    const t = dataTable(doc(), {
      columns: COLS, rows: STUDENTS, rowKey: (r) => r.id, caption: 'শিক্ষার্থী',
    });
    const firstMeta = t.querySelector('.ui-list-meta')!;
    assert.match(firstMeta.textContent ?? '', /অভিভাবকের ফোন:/);
    assert.match(firstMeta.textContent ?? '', /01712345678/);
    // …and it is hidden from the eye, which already has the layout.
    assert.ok(firstMeta.querySelector('.ui-sr-only'));
  });

  test('the first column is a row header, so a reader has an anchor', () => {
    const t = dataTable(doc(), {
      columns: COLS, rows: STUDENTS, rowKey: (r) => r.id, caption: 'শিক্ষার্থী',
    });
    const firstCell = t.querySelector('tbody tr > *')!;
    assert.equal(firstCell.tagName, 'TH');
    assert.equal(firstCell.getAttribute('scope'), 'row');
  });

  test('every table has a caption — an unnamed table is a maze', () => {
    const t = dataTable(doc(), {
      columns: COLS, rows: STUDENTS, rowKey: (r) => r.id, caption: 'শিক্ষার্থী তালিকা',
    });
    assert.equal(t.querySelector('caption')?.textContent, 'শিক্ষার্থী তালিকা');
    assert.equal(t.querySelector('.ui-list')?.getAttribute('aria-label'), 'শিক্ষার্থী তালিকা');
  });

  test('numeric columns are marked in both renderings', () => {
    const t = dataTable(doc(), {
      columns: COLS, rows: STUDENTS, rowKey: (r) => r.id, caption: 'x',
    });
    assert.ok(t.querySelector('th[data-col="roll"][data-numeric="true"]'));
  });

  test('an activatable row is a real control in both shapes', () => {
    const t = dataTable(doc(), {
      columns: COLS, rows: STUDENTS, rowKey: (r) => r.id, caption: 'x',
      onRowClick: () => {},
    });
    assert.equal(t.querySelector('.ui-row-open')?.tagName, 'BUTTON');
    assert.equal(t.querySelector('.ui-list-hit')?.tagName, 'BUTTON');
  });

  test('a non-activatable list row is not a button', () => {
    // A control that does nothing is worse than no control: it takes a tab
    // stop and promises something.
    const t = dataTable(doc(), {
      columns: COLS, rows: STUDENTS, rowKey: (r) => r.id, caption: 'x',
    });
    assert.equal(t.querySelector('.ui-list-hit')?.tagName, 'DIV');
  });

  test('THE ONE THAT MATTERS — empty says what is missing and what would fill it', () => {
    // "No data" leaves a person looking at a wall on their first day, when
    // everything is empty and nothing has gone wrong.
    const t = dataTable(doc(), {
      columns: COLS, rows: [], rowKey: (r: Student) => r.id, caption: 'শিক্ষার্থী',
      empty: { message: 'এখনো কোনো শিক্ষার্থী ভর্তি হয়নি। প্রথমে একটি সেকশন তৈরি করুন।' },
    });
    assert.equal(t.querySelector('table'), null, 'no empty table shell');
    assert.match(t.textContent ?? '', /সেকশন তৈরি করুন/);
  });

  test('a standalone list row carries its own semantics', () => {
    const li = listItem(doc(), { title: 'নোটিশ', subtitle: 'আগামীকাল ছুটি', onClick: () => {} });
    assert.equal(li.tagName, 'LI');
    assert.equal(li.querySelector('.ui-list-hit')?.tagName, 'BUTTON');
    const ul = list(doc(), 'নোটিশসমূহ', li);
    assert.equal(ul.getAttribute('aria-label'), 'নোটিশসমূহ');
  });
});

describe('P2 — pagination and timeline', () => {
  test('one page renders no pagination at all', () => {
    assert.equal(pagination(doc(), { page: 1, pageCount: 1, onGo: () => {} }), null);
  });

  test('the ends are disabled rather than absent, so the control does not move', () => {
    const p = pagination(doc(), { page: 1, pageCount: 5, onGo: () => {} })!;
    const btns = [...p.querySelectorAll('button')];
    assert.equal(btns[0].disabled, true, 'prev on page 1');
    assert.equal(btns[1].disabled, false);
  });

  test('the position is announced when it changes', () => {
    const p = pagination(doc(), { page: 3, pageCount: 12, onGo: () => {} })!;
    const pos = p.querySelector('.ui-page-pos')!;
    assert.equal(pos.getAttribute('aria-live'), 'polite');
    assert.equal(pos.textContent, '৩ / ১২');
  });

  test('a timeline is an ordered list; the dots are decoration', () => {
    const t = timeline(doc(), {
      label: 'কার্যবিবরণী',
      entries: [{ when: 'আজ', title: 'ফলাফল প্রকাশিত', tone: 'success' }],
    });
    assert.equal(t.tagName, 'OL');
    assert.equal(t.querySelector('.ui-timeline-mark')?.getAttribute('aria-hidden'), 'true');
  });
});

describe('P2 — the focus trap', () => {
  test('THE ONE THAT MATTERS — focus goes in, cycles, and comes back', () => {
    const opener = el(doc(), 'button', { text: 'খুলুন' });
    host().append(opener);
    opener.focus();
    assert.equal(doc().activeElement, opener);

    const h = openOverlay(doc(), {
      title: 'সেকশন তৈরি',
      body: el(doc(), 'input', { attrs: { type: 'text' } }),
      mount: host(),
    });
    // In: the first control, not the dialog, not the body.
    assert.equal(doc().activeElement?.tagName, 'BUTTON', 'the close button is first');
    assert.ok(h.el.contains(doc().activeElement));

    h.close();
    // Back: a phone user who dismisses a sheet and lands at the top of the
    // document has lost their place in a sixty-row register.
    assert.equal(doc().activeElement, opener);
  });

  test('THE ONE THAT MATTERS — the page behind is hidden from a screen reader', () => {
    // Otherwise a reader wanders out of the dialog into the page behind it and
    // there is no indication it has left.
    const page = el(doc(), 'div', { text: 'পেছনের পাতা' });
    host().append(page);
    const h = openOverlay(doc(), { title: 'x', body: 'y', mount: host() });
    assert.equal(page.getAttribute('aria-hidden'), 'true');
    assert.equal(h.el.closest('.ui-scrim')?.getAttribute('aria-hidden'), null,
      'the dialog itself must not be hidden');
    h.close();
    assert.equal(page.hasAttribute('aria-hidden'), false, 'restored on close');
  });

  test('an aria-hidden that was already there is restored, not cleared', () => {
    const page = el(doc(), 'div', { attrs: { 'aria-hidden': 'true' } });
    host().append(page);
    const h = openOverlay(doc(), { title: 'x', body: 'y', mount: host() });
    h.close();
    assert.equal(page.getAttribute('aria-hidden'), 'true');
  });

  test('Escape closes a dismissible overlay', () => {
    let closed = false;
    openOverlay(doc(), {
      title: 'x', body: 'y', mount: host(), onClose: () => { closed = true; },
    });
    doc().dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    assert.equal(closed, true);
    assert.equal(host().querySelector('.ui-scrim'), null);
  });

  test('Escape does NOT close a decision that must be made', () => {
    // A confirm is not dismissible: escaping it is indistinguishable from
    // cancelling, and for an irreversible action those must be one deliberate
    // act, not a keypress.
    let confirmed = false;
    confirmOverlay(doc(), {
      title: 'ফলাফল প্রকাশ', body: '১৬৮ জনের ফলাফল প্রকাশ হবে।',
      confirmLabel: 'প্রকাশ করুন', danger: true, mount: host(),
      onConfirm: () => { confirmed = true; },
    });
    doc().dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    assert.ok(host().querySelector('.ui-scrim'), 'the confirm closed on Escape');
    assert.equal(confirmed, false);
  });

  test('THE ONE THAT MATTERS — a confirm focuses Cancel, never the destructive button', () => {
    // A person who opened this by mistake, or who hits Enter out of habit,
    // must not destroy anything.
    confirmOverlay(doc(), {
      title: 'মুছে ফেলুন', body: '৩টি সেকশন মুছে যাবে।',
      confirmLabel: 'মুছুন', danger: true, mount: host(), onConfirm: () => {},
    });
    const focused = doc().activeElement as HTMLElement;
    assert.match(focused.textContent ?? '', /বাতিল/);
    assert.match(focused.className, /btn-secondary/);
  });

  test('the destructive button is danger-styled, not the primary', () => {
    confirmOverlay(doc(), {
      title: 'x', body: 'y', confirmLabel: 'মুছুন', danger: true,
      mount: host(), onConfirm: () => {},
    });
    const confirm = [...host().querySelectorAll('button')]
      .find((b) => b.textContent?.includes('মুছুন'))!;
    assert.match(confirm.className, /btn-danger/);
  });

  test('a dialog names itself', () => {
    const h = openOverlay(doc(), { title: 'সেকশন তৈরি', body: 'x', mount: host() });
    const id = h.el.getAttribute('aria-labelledby')!;
    assert.equal(h.el.querySelector(`#${id}`)?.textContent, 'সেকশন তৈরি');
    assert.equal(h.el.getAttribute('aria-modal'), 'true');
    assert.equal(h.el.getAttribute('role'), 'dialog');
  });

  test('a confirm is an alertdialog, which is announced more insistently', () => {
    const h = confirmOverlay(doc(), {
      title: 'x', body: 'y', confirmLabel: 'ok', mount: host(), onConfirm: () => {},
    });
    assert.equal(h.el.getAttribute('role'), 'alertdialog');
  });

  test('closing twice is harmless', () => {
    const h = openOverlay(doc(), { title: 'x', body: 'y', mount: host() });
    h.close();
    h.close();
    assert.equal(host().querySelectorAll('.ui-scrim').length, 0);
  });

  test('a drawer is the same dialog with a different presentation', () => {
    const h = openDrawer(doc(), { title: 'ছাঁকনি', body: 'x', mount: host() });
    assert.equal(h.el.closest('.ui-scrim')?.dataset.kind, 'drawer');
    assert.equal(h.el.getAttribute('aria-modal'), 'true');
  });
});

describe('P2 — tabs', () => {
  test('THE ONE THAT MATTERS — one tab stop for the whole strip', () => {
    // Roving tabindex. Without it, Tab walks through six tabs one at a time
    // instead of moving into the panel.
    const t = tabs(doc(), {
      items: [{ id: 'a', label: 'সব' }, { id: 'b', label: 'অনুপস্থিত', count: 4 }],
      active: 'a', onSelect: () => {}, label: 'ছাঁকনি',
    });
    const btns = [...t.querySelectorAll('button')];
    assert.equal(btns[0].getAttribute('tabindex'), '0');
    assert.equal(btns[1].getAttribute('tabindex'), '-1');
  });

  test('arrow keys move between tabs and select', () => {
    let picked = '';
    const t = tabs(doc(), {
      items: [{ id: 'a', label: 'সব' }, { id: 'b', label: 'অনুপস্থিত' }],
      active: 'a', onSelect: (id) => { picked = id; }, label: 'ছাঁকনি',
    });
    host().append(t);
    (t.querySelector('button') as HTMLElement).focus();
    t.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    assert.equal(picked, 'b');
  });

  test('the strip is a labelled tablist', () => {
    const t = tabs(doc(), { items: [{ id: 'a', label: 'সব' }], active: 'a',
      onSelect: () => {}, label: 'হাজিরা ছাঁকনি' });
    assert.equal(t.getAttribute('role'), 'tablist');
    assert.equal(t.getAttribute('aria-label'), 'হাজিরা ছাঁকনি');
    assert.equal(t.querySelector('button')?.getAttribute('role'), 'tab');
  });
});

describe('P2 — filters', () => {
  const FILTERS = [
    { id: 'cls', label: 'শ্রেণি', value: '9',
      options: [{ value: '', label: 'সব' }, { value: '9', label: 'নবম' }] },
    { id: 'sec', label: 'সেকশন', value: '',
      options: [{ value: '', label: 'সব' }, { value: 'a', label: 'ক' }] },
  ];

  test('THE ONE THAT MATTERS — an active filter is visible and clearable in one tap', () => {
    // A person who filtered a roster last week and returns to an empty-looking
    // screen does not think "I have a filter on". They think the students are
    // gone.
    const f = filterBar(doc(), { filters: FILTERS, onChange: () => {}, onClearAll: () => {} });
    const chips = [...f.querySelectorAll('.ui-filter-chip')];
    assert.equal(chips.length, 1, 'only the non-default filter is shown as active');
    assert.match(chips[0].textContent ?? '', /শ্রেণি: নবম/);
    assert.ok(f.querySelector('.ui-filter-clear'));
  });

  test('clearing a chip resets that filter to its "any" value', () => {
    let got: [string, string] | null = null;
    const f = filterBar(doc(), {
      filters: FILTERS, onChange: (id, v) => { got = [id, v]; }, onClearAll: () => {},
    });
    host().append(f);
    (f.querySelector('.ui-filter-chip') as HTMLButtonElement).click();
    assert.deepEqual(got, ['cls', '']);
  });

  test('both renderings exist: a bar for desktop, a button for the phone', () => {
    const f = filterBar(doc(), { filters: FILTERS, onChange: () => {}, onClearAll: () => {} });
    assert.ok(f.querySelector('.ui-filters-inline select'));
    assert.ok(f.querySelector('.ui-filters-open'));
  });

  test('the filter button counts what is active in its accessible name', () => {
    const f = filterBar(doc(), { filters: FILTERS, onChange: () => {}, onClearAll: () => {} });
    assert.match(f.querySelector('.ui-filters-open')?.getAttribute('aria-label') ?? '',
      /১টি চালু/);
  });

  test('with nothing active there are no chips and no count', () => {
    const none = FILTERS.map((f) => ({ ...f, value: '' }));
    const f = filterBar(doc(), { filters: none, onChange: () => {}, onClearAll: () => {} });
    assert.equal(f.querySelector('.ui-filter-chip'), null);
    assert.equal(f.querySelector('.ui-filters-open')?.getAttribute('aria-label'), 'ছাঁকনি');
  });
});

describe('P2 — errors a person can read', () => {
  test('THE ONE THAT MATTERS — no raw backend text ever reaches a screen', () => {
    // §15 forbids SQL, PostgreSQL errors, UUIDs, stack traces and backend
    // codes. Anything unrecognised is exactly the case most likely to be one
    // of those.
    const raw = 'duplicate key value violates unique constraint "students_tenant_id_roll_key"';
    const shown = humanError(raw, 500);
    assert.doesNotMatch(shown, /constraint|duplicate key|students_tenant/);
    assert.match(shown, /সমস্যা/);
  });

  test('a UUID never survives into the message', () => {
    const shown = humanError('tenant 6f1c2e1a-9d3b-4a77-9c1e-2b8f0a5d7e42 not provisioned');
    assert.doesNotMatch(shown, /[0-9a-f]{8}-[0-9a-f]{4}/);
  });

  test('the codes that have a human answer get one', () => {
    assert.match(humanError('offline'), /সংযোগ/);
    assert.match(humanError('forbidden'), /অনুমতি/);
    assert.match(humanError(null, 401), /লগইন/);
    assert.match(humanError(null, 404), /পাওয়া যায়নি/);
  });

  test('a permission state offers no retry — retrying a 403 is futile', () => {
    const p = permissionState(doc(), { contact: 'প্রধান শিক্ষক' });
    assert.equal(p.querySelector('button'), null);
    assert.match(p.textContent ?? '', /অনুমতি/);
    assert.match(p.textContent ?? '', /প্রধান শিক্ষক/);
  });
});

describe('P2 — feedback', () => {
  test('THE ONE THAT MATTERS — the live region exists before its content does', () => {
    // A live region added to the DOM at the same moment as its text is not
    // announced at all: the reader has to be watching it beforehand.
    toast(doc(), { message: 'হাজিরা জমা হয়েছে', tone: 'success' });
    const region = doc().querySelector('.ui-toast-host')!;
    assert.equal(region.getAttribute('aria-live'), 'polite');
    assert.equal(region.getAttribute('role'), 'status');
  });

  test('a second toast replaces the first rather than stacking', () => {
    // Three notifications is a thing to dismiss, not a thing to read.
    toast(doc(), { message: 'এক' });
    toast(doc(), { message: 'দুই' });
    assert.equal(doc().querySelectorAll('.ui-toast').length, 1);
    assert.match(doc().querySelector('.ui-toast')?.textContent ?? '', /দুই/);
  });

  test('an error toast stays until dismissed', () => {
    // On this network the one message a person needs is "saved offline, will
    // sync" — auto-hiding it is how a teacher ends the day not knowing.
    toast(doc(), { message: 'জমা হয়নি', tone: 'error' });
    const t = doc().querySelector('.ui-toast')!;
    assert.equal(t.getAttribute('data-tone'), 'error');
    assert.ok(t.querySelector('.ui-toast-close'), 'and can be dismissed');
  });

  test('announce leaves nothing behind on screen', () => {
    announce(doc(), '১২টি ফলাফল');
    const sr = doc().querySelector('.ui-toast-host .ui-sr-only')!;
    assert.match(sr.className, /ui-sr-only/);
    assert.equal(sr.getAttribute('aria-live'), 'polite');
  });

  test('progress reports position to a reader, not just a percentage bar', () => {
    const p = progress(doc(), { value: 340, max: 1000, label: '৩৪০ / ১০০০ সারি' });
    const bar = p.querySelector('[role="progressbar"]')!;
    assert.equal(bar.getAttribute('aria-valuenow'), '340');
    assert.equal(bar.getAttribute('aria-valuemax'), '1000');
    assert.equal(bar.getAttribute('aria-valuetext'), '৩৪০ / ১০০০ সারি');
  });

  test('a list skeleton is shaped like the list it precedes', () => {
    // A skeleton says "this is what is coming and roughly how much". One that
    // looks like a paragraph fails at exactly that.
    const s = listSkeleton(doc(), 4);
    assert.equal(s.querySelectorAll('.ui-skel-row').length, 4);
    assert.equal(s.getAttribute('aria-busy'), 'true');
    assert.ok(s.querySelector('.skel-avatar'));
  });
});
