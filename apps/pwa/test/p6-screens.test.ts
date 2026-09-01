/**
 * P6 — the functional screens that had no final design.
 *
 * What these hold is mostly what the inventory found by rendering: a screen
 * with no page header, a screen claiming two contradictory states at once, a
 * primitive that ignored the icon it was given, and Latin digits on the one
 * control that names a class.
 */
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

import { MoreView } from '../src/more-view.ts';
import { RolesView } from '../src/roles-view.ts';
import { SikhokView } from '../src/sikhok-view.ts';
import { SubstituteView } from '../src/substitute-view.ts';
import { ExamRoutineView } from '../src/exam-routine-view.ts';
import { emptyState } from '../src/view-states.ts';
import { levelNameBn } from '../../../packages/ui-core/src/format.ts';

let dom: JSDOM;

before(() => {
  dom = new JSDOM('<!doctype html><html><body><main id="root"></main></body></html>',
                  { url: 'http://localhost/' });
  const g = globalThis as Record<string, unknown>;
  for (const k of ['HTMLElement', 'HTMLInputElement', 'HTMLSelectElement',
                   'HTMLTextAreaElement', 'HTMLButtonElement', 'Node', 'Event'] as const) {
    g[k] = (dom.window as unknown as Record<string, unknown>)[k];
  }
  for (const key of ['localStorage', 'location'] as const) {
    Object.defineProperty(globalThis, key, {
      value: dom.window[key], configurable: true, writable: true,
    });
  }
  Object.defineProperty(globalThis, 'navigator', {
    value: { onLine: true }, configurable: true, writable: true,
  });
});

const root = () => dom.window.document.getElementById('root') as HTMLElement;
const settle = async () => { for (let i = 0; i < 14; i++) await new Promise((r) => setTimeout(r, 0)); };
const text = () => (root().textContent ?? '').replace(/\s+/g, ' ');

function auth(role: string, routes: Record<string, { status: number; body?: unknown }>) {
  return {
    role, tenantId: 't-1', userId: 'u-1',
    authedFetch: async (url: string) => {
      const hit = Object.entries(routes).find(([k]) => url.includes(k))?.[1]
        ?? { status: 200, body: {} };
      return {
        ok: hit.status >= 200 && hit.status < 300,
        status: hit.status,
        json: async () => hit.body ?? {},
      } as unknown as Response;
    },
  } as never;
}

// ═══════════════════════════════════════════════════════════════════════
describe('P6 — every screen has a page header', () => {
  // Three screens had none at all: `more`, `sikhok`, `shikho`. On `more` that
  // is the one screen every role reaches.
  test('আরও is a header and a card grid, not 36 full-width strips', () => {
    root().textContent = '';
    new MoreView({
      root: root(), doc: dom.window.document,
      items: Array.from({ length: 6 }, (_, i) => ({
        path: `p${i}`, glyph: 'star', titleBn: `পাতা ${i}`, subtitleBn: 'বিবরণ',
      })),
    });
    assert.ok(root().querySelector('.page-header'), 'it had none');
    assert.ok(root().querySelector('.ui-card-grid'), 'a grid at desktop, one column on a phone');
    // Every destination is a real card, and the theme control is its own.
    assert.equal(root().querySelectorAll('.ui-card-grid .ui-card').length, 6);
    assert.equal(root().querySelectorAll('.more-item').length, 0);
  });

  test('the theme choice stays, and says where it is stored', () => {
    root().textContent = '';
    new MoreView({ root: root(), doc: dom.window.document, items: [] });
    assert.match(text(), /রঙের ধরন/);
    // It is a device preference, not a school setting — and the difference
    // matters on a shared phone.
    assert.match(text(), /এই যন্ত্রে সংরক্ষিত/);
    assert.equal(root().querySelectorAll('[role="radio"]').length, 3);
  });

  test('শিক্ষক সহায়ক AI has a header and real fields', async () => {
    root().textContent = '';
    new SikhokView({ root: root(), doc: dom.window.document, auth: auth('class_teacher', {}) } as never);
    await settle();
    assert.ok(root().querySelector('.page-header'));
    // Five hand-rolled `.login-input`/`.section-picker` controls with no
    // visible labels became five `field()`s that carry them.
    assert.equal(root().querySelectorAll('.ui-field').length, 5);
    assert.equal(root().querySelectorAll('.login-input, .ai-field').length, 0);
  });
});

// ═══════════════════════════════════════════════════════════════════════
describe('P6 — Bangla, on the control that names a class', () => {
  test('THE ONE THAT MATTERS — no Latin digits in the class picker', async () => {
    // These read "শ্রেণি 6 … শ্রেণি 12" — Latin digits in a Bangla product.
    root().textContent = '';
    new SikhokView({ root: root(), doc: dom.window.document, auth: auth('class_teacher', {}) } as never);
    await settle();
    const sel = root().querySelector('[name="classLevel"]') as HTMLSelectElement;
    const labels = [...sel.options].map((o) => o.textContent ?? '');
    assert.equal(labels.length, 7);
    for (const l of labels) assert.doesNotMatch(l, /[0-9]/, l);
  });

  test('the ordinals are the ones a school says, not a numeral plus ম', () => {
    // `${bn(11)}ম` gives "১১ম" where a Bangladeshi school says একাদশ. P4
    // shipped exactly this mistake once, as "২ম পিরিয়ড".
    assert.equal(levelNameBn(6), 'ষষ্ঠ');
    assert.equal(levelNameBn(9), 'নবম');
    assert.equal(levelNameBn(11), 'একাদশ');
    assert.equal(levelNameBn(12), 'দ্বাদশ');
    // Out of range degrades to the number rather than to `undefined`.
    assert.equal(levelNameBn(99), '99');
  });
});

// ═══════════════════════════════════════════════════════════════════════
describe('P6 — an error and an empty state are different claims', () => {
  test('THE ONE THAT MATTERS — a failed load does not also say "nothing here"', async () => {
    // পরীক্ষার রুটিন rendered "পরীক্ষার তালিকা লোড হয়নি।" AND then "এই
    // শিক্ষাবর্ষে কোনো পরীক্ষার সময়সূচি তৈরি হয়নি।" — two claims at once, and
    // the second is not knowable when the first is true.
    root().textContent = '';
    new ExamRoutineView({
      root: root(), doc: dom.window.document,
      auth: auth('principal', { '/rms/examroutine': { status: 500 } }),
    } as never);
    await settle();
    assert.match(text(), /লোড হয়নি/);
    assert.doesNotMatch(text(), /তৈরি হয়নি/,
      'a failed load does not know whether the school has exams');
    assert.match(text(), /আবার চেষ্টা/, 'and a failure IS retryable');
  });
});

// ═══════════════════════════════════════════════════════════════════════
describe('P6 — emptyState draws the icon it is given', () => {
  test('THE ONE THAT MATTERS — a glyph name becomes an icon, not a dot', () => {
    // It rendered a literal `·` whatever the caller asked for, and said the
    // reason was an import cycle with `icon.ts` — which imports nothing.
    // Five screens worked around it with a stray U+20DD ring.
    const box = emptyState(dom.window.document, {
      glyph: 'check-square', message: 'কিছু নেই',
    });
    const g = box.querySelector('.empty-glyph');
    assert.ok(g, 'the glyph node exists');
    assert.ok(g!.querySelector('svg'), 'and it is a drawn icon');
    assert.notEqual(g!.textContent, '·');
  });

  test('an unknown name degrades to the dot rather than to an empty box', () => {
    const box = emptyState(dom.window.document, {
      glyph: 'not-a-real-icon', message: 'কিছু নেই',
    });
    assert.equal(box.querySelector('.empty-glyph')?.textContent, '·');
  });

  test('no glyph asked for means no glyph node', () => {
    const box = emptyState(dom.window.document, { message: 'কিছু নেই' });
    assert.equal(box.querySelector('.empty-glyph'), null);
  });
});

// ═══════════════════════════════════════════════════════════════════════
describe('P6 — বদলি শিক্ষক', () => {
  const DAY = {
    '/rms/routine': { status: 200, body: { slots: [
      { slotId: 's1', periodNo: 1, startsAt: '10:00:00', endsAt: '10:45:00',
        slotKind: 'teaching', subjectBn: 'বাংলা', sectionLabel: '৯-ক', roomCode: '101',
        isSubstitution: false, coveringForBn: null, studentCount: 40, attendanceTaken: false,
        deliveryLogged: false },
    ] } },
  };

  test('it has a header and a LABELLED date field', async () => {
    // It had neither. The date input was bare — no label, not even an
    // `aria-label` — on the screen whose whole question is which day.
    root().textContent = '';
    new SubstituteView({
      root: root(), doc: dom.window.document, auth: auth('academic_coordinator', DAY),
    } as never);
    await settle();
    assert.ok(root().querySelector('.page-header'));
    const day = root().querySelector('[name="day"]');
    assert.ok(day, 'the date control');
    assert.ok(day!.closest('.ui-field')?.querySelector('.ui-field-label'),
      'and it carries a visible label');
  });

  test('the day is a table, and the date reads as a date', async () => {
    root().textContent = '';
    new SubstituteView({
      root: root(), doc: dom.window.document, auth: auth('academic_coordinator', DAY),
    } as never);
    await settle();
    const heads = [...root().querySelectorAll('thead th')].map((h) => h.textContent);
    assert.deepEqual(heads.slice(0, 4), ['সময়', 'বিষয়', 'শাখা', 'অবস্থা']);
    // The caption used to print the raw ISO date.
    assert.doesNotMatch(text(), /\d{4}-\d{2}-\d{2}/);
  });

  test('an empty day says what to do rather than nothing', async () => {
    root().textContent = '';
    new SubstituteView({
      root: root(), doc: dom.window.document,
      auth: auth('academic_coordinator', { '/rms/routine': { status: 200, body: { slots: [] } } }),
    } as never);
    await settle();
    assert.match(text(), /কোনো ক্লাস নেই/);
    assert.match(text(), /অন্য তারিখ/);
  });
});

// ═══════════════════════════════════════════════════════════════════════
describe('P6 — ভূমিকা ও অ্যাক্সেস is a matrix, so it is a table', () => {
  test('ten roles compared on the same three questions', () => {
    root().textContent = '';
    new RolesView({ root: root(), doc: dom.window.document });
    // Grouped by tier, each tier its own table — it was 11 full-width
    // `.role-card` strips at 1110px, where comparing two roles meant holding
    // one in your head.
    assert.ok(root().querySelectorAll('table.ui-table').length >= 4);
    const heads = [...root().querySelectorAll('thead th')].map((h) => h.textContent);
    assert.ok(heads.includes('ভূমিকা'));
    assert.ok(heads.includes('কী করতে পারেন'));
    assert.ok(heads.includes('পরিসর'));
    assert.equal(root().querySelectorAll('.role-card').length, 0);
  });

  test('the scope is a word, not a database key', () => {
    root().textContent = '';
    new RolesView({ root: root(), doc: dom.window.document });
    assert.match(text(), /পুরো প্ল্যাটফর্ম/);
    assert.match(text(), /নিজের প্রতিষ্ঠান/);
    // `platform` and `tenant` are the values; neither belongs on screen.
    assert.doesNotMatch(text(), /\bplatform\b|\btenant\b/);
  });

  test('the isolation guarantee says it cannot be switched off', () => {
    root().textContent = '';
    new RolesView({ root: root(), doc: dom.window.document });
    assert.match(text(), /বন্ধ করার উপায় নেই/);
  });
});
