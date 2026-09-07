/**
 * P9-8 — the published routine, as each persona meets it.
 *
 * The API suite pins what the server will and will not answer. These are the
 * things about the SCREEN:
 *
 *   1. THE PICKER IS THE SERVER'S LIST. A menu assembled here from
 *      `auth.role` would be a second opinion about permission, and the first
 *      time it disagreed a person would be offered a view that 403s.
 *
 *   2. ONE READER, ONE CHOICE. A student has exactly one thing to look at, so
 *      they get no picker at all — a select with one option is a control that
 *      does nothing.
 *
 *   3. THE GRID IS ONE PER SHIFT. Morning period 8 and day period 1 are
 *      different hours with the same number; one table keyed on period number
 *      would put them in the same row.
 *
 *   4. A CELL CARRIES ITS OWN NAME. A screen reader moving through a table
 *      cell by cell has no other way to know which day and hour it is in.
 *
 *   5. NOTHING PUBLISHED IS A STATE, NOT A FAILURE. A school in its first
 *      week meets it, and it must say what happens next.
 */
import { test, describe, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

import { TimetableView, type TimetablePayload } from '../src/timetable-view.ts';

let dom: JSDOM;

before(() => {
  dom = new JSDOM('<!doctype html><html><body><main id="root"></main></body></html>',
                  { url: 'http://localhost/' });
  const g = globalThis as Record<string, unknown>;
  g.HTMLElement = dom.window.HTMLElement;
  g.CSS = dom.window.CSS;
  for (const key of ['localStorage', 'location'] as const) {
    Object.defineProperty(globalThis, key, {
      value: dom.window[key], configurable: true, writable: true,
    });
  }
});

const doc = () => dom.window.document;
const root = () => doc().getElementById('root') as HTMLElement;
const settle = async () => {
  for (let i = 0; i < 14; i++) await new Promise((r) => setTimeout(r, 0));
};
const text = () => root().textContent ?? '';
const selects = () => [...root().querySelectorAll('select')];
const optionsOf = (i: number) => [...(selects()[i]?.options ?? [])].map((o) => o.textContent);

const period = (n: number) => ({
  routineId: 'r1', periodNo: n, labelBn: `${n} নম্বর`,
  startsAt: `${String(8 + n).padStart(2, '0')}:00`,
  endsAt: `${String(8 + n).padStart(2, '0')}:45`,
});
const lesson = (dow: number, p: number, over: Partial<TimetablePayload['lessons'][number]> = {}) => ({
  routineId: 'r1', dayOfWeek: dow, periodNo: p,
  startsAt: `${String(8 + p).padStart(2, '0')}:00`,
  endsAt: `${String(8 + p).padStart(2, '0')}:45`,
  subjectBn: 'গণিত', teacherBn: 'রফিক স্যার', roomBn: '১০১ নম্বর কক্ষ',
  sectionLabel: 'ক', classBn: 'নবম শ্রেণি', isParallel: false, ...over,
});

const BASE: TimetablePayload = {
  ok: true, scope: 'section', published: true,
  titleBn: 'নবম শ্রেণি — ক', subtitleBn: 'শাখার সাপ্তাহিক রুটিন',
  counts: { sections: 1, teachers: 3, rooms: 2, classes: 1 },
  routines: [{ id: 'r1', version: 2, shift: 'single', shiftBn: 'একক',
               nameBn: 'বার্ষিক রুটিন', publishedAt: '2026-03-02T05:30:00.000Z',
               yearLabel: '২০২৬' }],
  periods: [period(1), period(2)],
  lessons: [lesson(0, 1), lesson(0, 2, { subjectBn: 'বাংলা' }), lesson(1, 1)],
  days: [{ dow: 0, bn: 'রবি' }, { dow: 1, bn: 'সোম' }],
  offered: [
    { scope: 'section', labelBn: 'আমার শাখা',
      options: [{ id: 'sec-a', labelBn: 'নবম শ্রেণি — ক' }] },
    { scope: 'teacher', labelBn: 'আমার রুটিন',
      options: [{ id: 'self', labelBn: 'আমার সাপ্তাহিক ক্লাস' }] },
  ],
};

let payload: TimetablePayload;
let reply: { ok: boolean; status: number; body: unknown } | null = null;
let asked: string[] = [];
let navigated: string[] = [];

function auth() {
  return {
    role: 'class_teacher',
    authedFetch: async (url: string) => {
      asked.push(url);
      if (reply) {
        return { ok: reply.ok, status: reply.status,
                 json: async () => reply.body } as unknown as Response;
      }
      return { ok: true, status: 200,
               json: async () => structuredClone(payload) } as unknown as Response;
    },
  } as never;
}

const mount = async (over: Record<string, unknown> = {}) => {
  root().textContent = '';
  new TimetableView({
    root: root(), doc: doc(), auth: auth(),
    onNavigate: (p) => navigated.push(p), ...over,
  });
  await settle();
};

describe('P9-8 — the published routine on screen', () => {
  beforeEach(() => {
    payload = structuredClone(BASE);
    reply = null;
    asked = [];
    navigated = [];
  });

  /* ─────────────────────────── the picker ─────────────────────────────── */

  test('THE ONE THAT MATTERS — the picker is the server’s list, verbatim', async () => {
    await mount();
    // Two scopes offered, so two selects: which kind, and which one.
    assert.deepEqual(optionsOf(0), ['আমার শাখা', 'আমার রুটিন']);
    assert.deepEqual(optionsOf(1), ['নবম শ্রেণি — ক']);
    // Nothing the screen invented: every option came from `offered`.
    for (const label of optionsOf(0)) {
      assert.ok(payload.offered.some((o) => o.labelBn === label), label);
    }
  });

  test('§2 — one reader with one thing to look at gets no picker', async () => {
    payload.scope = 'student';
    payload.offered = [{ scope: 'student', labelBn: 'আমার রুটিন',
                         options: [{ id: 'self', labelBn: 'আমার সাপ্তাহিক ক্লাস' }] }];
    await mount();
    assert.equal(selects().length, 0,
      'a select with one option is a control that does nothing');
    assert.match(text(), /মোট ক্লাস/, 'and the timetable is still there');
  });

  test('changing the scope asks the server again, for that scope', async () => {
    await mount();
    const before = asked.length;
    const sel = selects()[0];
    sel.value = 'teacher';
    sel.dispatchEvent(new dom.window.Event('change'));
    await settle();
    assert.ok(asked.length > before, 'it re-reads rather than filtering locally');
    assert.match(asked.at(-1) ?? '', /scope=teacher/);
    assert.match(asked.at(-1) ?? '', /id=self/);
  });

  test('the first read names no scope — the server answers from the reader’s menu', async () => {
    await mount();
    assert.equal(asked[0], '/api/v1/rms/timetable',
      'guessing a scope here would be a second opinion about permission');
  });

  /* ──────────────────────────── the grid ──────────────────────────────── */

  test('§3 — one grid per shift, never one table keyed on period number', async () => {
    payload.routines.push({ id: 'r2', version: 2, shift: 'day', shiftBn: 'দিবা',
                            nameBn: 'দিবা রুটিন', publishedAt: null, yearLabel: '২০২৬' });
    payload.periods.push({ routineId: 'r2', periodNo: 1, labelBn: '১ নম্বর',
                           startsAt: '13:00', endsAt: '13:45' });
    payload.lessons.push({ ...lesson(0, 1), routineId: 'r2', subjectBn: 'ইংরেজি',
                           startsAt: '13:00', endsAt: '13:45' });
    await mount();
    assert.equal(root().querySelectorAll('.routine-grid').length, 2);
    assert.match(text(), /একক শিফট/);
    assert.match(text(), /দিবা শিফট/);
  });

  test('§4 — every cell names its own day and hour for a screen reader', async () => {
    await mount();
    const cell = root().querySelector('.routine-slot') as HTMLElement;
    assert.ok(cell);
    const name = cell.getAttribute('aria-label') ?? '';
    assert.match(name, /রবিবার/, 'the day');
    assert.match(name, /১ নম্বর পিরিয়ড/, 'the hour');
    assert.match(name, /০৯:০০ থেকে ০৯:৪৫/, 'the clock time');
    assert.match(name, /গণিত/, 'and what happens in it');
  });

  test('an empty hour is a dash, not a missing cell', async () => {
    await mount();
    // Two periods x two days = four cells; three lessons, so one is empty.
    assert.equal(root().querySelectorAll('.routine-cell').length, 4);
    assert.match(text(), /—/);
  });

  test('a crowded cell shows a few and counts the rest', async () => {
    payload.scope = 'institution';
    payload.lessons = [0, 1, 2, 3, 4].map((k) =>
      lesson(0, 1, { sectionLabel: String.fromCharCode(0x995 + k) }));
    await mount();
    assert.match(text(), /আরও ২টি/,
      'the institution’s cell holds sixteen; a grid that printed them all is a list');
  });

  test('the section is named only when more than one is on screen', async () => {
    await mount();                       // scope=section
    const secCell = root().querySelector('.routine-slot')?.textContent ?? '';
    assert.doesNotMatch(secCell, /নবম শ্রেণি-ক/,
      'repeating the section in every cell of its own grid is noise');

    payload.scope = 'institution';
    await mount();
    assert.match(root().querySelector('.routine-slot')?.textContent ?? '', /নবম শ্রেণি-ক/);
  });

  test('a teacher’s own grid does not repeat the teacher in every cell', async () => {
    payload.scope = 'teacher';
    await mount();
    assert.doesNotMatch(root().querySelector('.routine-slot')?.textContent ?? '',
      /রফিক স্যার/);
    assert.match(text(), /১০১ নম্বর কক্ষ/, 'but the room still matters to them');
  });

  test('a split hour says so', async () => {
    payload.lessons = [lesson(0, 1, { isParallel: true })];
    await mount();
    assert.match(text(), /বিভাজিত ক্লাস/);
  });

  /* ──────────────────────────── the numbers ───────────────────────────── */

  test('every count is the server’s, in Bangla, with the word that names it', async () => {
    payload.counts = { sections: 20, teachers: 23, rooms: 22, classes: 5 };
    await mount();
    assert.match(text(), /মোট ক্লাস/);
    assert.match(text(), /২০টি/, 'sections — counted on ids by the server');
    assert.match(text(), /২৩ জন/);
    assert.match(text(), /২২টি/);
    assert.match(text(), /সংস্করণ ২/);
    // No Latin digit anywhere a person reads.
    assert.doesNotMatch(text().replace(/[০-৯]/g, ''), /[0-9]/);
  });

  test('nothing undefined, and no identifier on screen', async () => {
    payload.scope = 'institution';
    await mount();
    assert.doesNotMatch(text(), /undefined|NaN|\[object/);
    assert.doesNotMatch(text(), /[0-9a-f]{8}-[0-9a-f]{4}/, 'no uuid');
    assert.doesNotMatch(text(), /\br1\b|routineId/);
  });

  /* ─────────────────────────── the states ─────────────────────────────── */

  test('§5 — nothing published is a state that says what happens next', async () => {
    payload.published = false;
    payload.routines = [];
    payload.periods = [];
    payload.lessons = [];
    await mount();
    assert.match(text(), /এখনো কোনো রুটিন প্রকাশ করা হয়নি/);
    assert.equal(root().querySelectorAll('.routine-grid').length, 0);
    const go = [...root().querySelectorAll('button')]
      .find((b) => (b.textContent ?? '').includes('রুটিন তৈরি ও প্রকাশ'));
    assert.ok(go, 'and offers the way there');
    go.click();
    assert.deepEqual(navigated, ['routinepublish']);
  });

  test('a refusal shows who to ask, not a retry', async () => {
    reply = { ok: false, status: 403, body: { error: 'forbidden_scope' } };
    await mount();
    assert.ok(text().length > 0, 'never blank');
    assert.equal([...root().querySelectorAll('button')]
      .find((b) => (b.textContent ?? '').includes('আবার চেষ্টা')), undefined);
  });

  test('a failed read offers a retry and keeps the page', async () => {
    reply = { ok: false, status: 500, body: { error: 'internal_error' } };
    await mount();
    assert.ok(text().length > 0);
    assert.match(text(), /আবার চেষ্টা করুন/);
  });

  test('a deep link opens on the scope it names', async () => {
    await mount({ scope: 'room', id: 'room-7' });
    assert.match(asked[0], /scope=room/);
    assert.match(asked[0], /id=room-7/);
  });
});
