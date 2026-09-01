/**
 * Student home — "today's classes" (B-15) and the states around it.
 *
 * The card P4 shipped without, because `/rms/routine` is teacher-scoped and
 * inventing a timetable on the client is fabricated curriculum data. What is
 * asserted here is mostly about the two things the browser caught and no
 * earlier test would have:
 *
 *   * Bangla ordinals are per-number, not a suffix. The first draft rendered
 *     "২ম পিরিয়ড" — right for period 1, wrong for 2, 3, 4 and 6, and
 *     invisible in a screenshot of the top of the list.
 *   * A period that is BOTH running now and covered by a substitute must say
 *     both. Badge precedence dropped the substitution at exactly the moment a
 *     student needs it, because the badge column holds one thing.
 *
 * The clock is injected, so "which period is now" is a fact of the test and
 * not of the hour the suite happens to run — the shape of bug P3.1 spent an
 * afternoon on.
 */
import { test, describe, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

import { StudentHomeView, periodBn, bnTime } from '../src/student-home-view.ts';

let dom: JSDOM;

before(() => {
  dom = new JSDOM('<!doctype html><html><body><main id="root"></main></body></html>',
                  { url: 'http://localhost/' });
  (globalThis as Record<string, unknown>).HTMLElement = dom.window.HTMLElement;
  for (const key of ['localStorage', 'location'] as const) {
    Object.defineProperty(globalThis, key, {
      value: dom.window[key], configurable: true, writable: true,
    });
  }
  Object.defineProperty(globalThis, 'navigator', {
    value: { onLine: true }, configurable: true, writable: true,
  });
});

const SLOTS = [
  { slotId: 'a', periodNo: 1, startsAt: '08:00', endsAt: '08:45',
    subjectBn: 'বাংলা', roomCode: '১০১', teacherNameBn: 'নাজমা', isSubstitution: false },
  { slotId: 'b', periodNo: 2, startsAt: '08:50', endsAt: '09:35',
    subjectBn: 'গণিত', roomCode: '১০২', teacherNameBn: 'রফিক', isSubstitution: false },
  { slotId: 'c', periodNo: 4, startsAt: '11:00', endsAt: '11:45',
    subjectBn: 'পদার্থবিজ্ঞান', roomCode: 'ল্যাব-১',
    teacherNameBn: 'শাহনাজ', isSubstitution: true },
];

/** Every endpoint the screen calls, answerable per-test. */
function stubAuth(over: Record<string, unknown> = {}, seen: string[] = []) {
  const bodies: Record<string, unknown> = {
    myroutine: { slots: SLOTS },
    next: { suggestions: [] },
    attendance: { totals: { present: 18, late: 0, absent: 1, excused: 0, halfDay: 0,
                            counted: 19, attendedPercent: 95 } },
    results: { results: [] },
    inbox: { notices: [], unread: 0 },
    ...over,
  };
  return {
    authedFetch: async (url: string) => {
      seen.push(url);
      const key = Object.keys(bodies).find((k) => url.includes(k));
      const body = key ? bodies[key] : {};
      if (body === null) return { ok: false, status: 500 } as unknown as Response;
      return { ok: true, status: 200, json: async () => body } as unknown as Response;
    },
  } as unknown as ConstructorParameters<typeof StudentHomeView>[0]['auth'];
}

/** 11:15 on a Tuesday — inside period 4, which is also the covered one. */
const AT_1115 = () => new Date('2026-09-01T11:15:00');
/** 09:40 — after period 2, before period 4: nothing current, one next. */
const AT_0940 = () => new Date('2026-09-01T09:40:00');

async function mount(
  over: Record<string, unknown> = {}, now = AT_1115, seen: string[] = [],
): Promise<HTMLElement> {
  const root = dom.window.document.getElementById('root') as HTMLElement;
  root.textContent = '';
  new StudentHomeView({
    root, doc: dom.window.document, auth: stubAuth(over, seen),
    displayName: 'রাফি', go: () => {}, now,
  });
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
  return root;
}

function todayRows(root: HTMLElement): HTMLElement[] {
  const section = [...root.querySelectorAll('section')]
    .find((s) => s.textContent?.includes('আজকের ক্লাস'));
  assert.ok(section, 'the today section must exist');
  return [...section.querySelectorAll('.ui-list-item')] as HTMLElement[];
}

describe('B-15 — today’s classes', () => {
  let root: HTMLElement;
  beforeEach(async () => { root = await mount(); });

  test('every period is listed, in order, with subject, room and teacher', () => {
    const rows = todayRows(root);
    assert.equal(rows.length, 3);
    assert.deepEqual(
      rows.map((r) => r.querySelector('.ui-list-title')?.textContent),
      ['বাংলা', 'গণিত', 'পদার্থবিজ্ঞান']);
    assert.match(rows[0].textContent ?? '', /রুম ১০১/);
    assert.match(rows[0].textContent ?? '', /নাজমা/);
  });

  test('Bangla ordinals are per-number, not digit + ম', () => {
    const subs = todayRows(root).map((r) => r.querySelector('.ui-list-sub')?.textContent ?? '');
    assert.match(subs[0], /^১ম পিরিয়ড/);
    assert.match(subs[1], /^২য় পিরিয়ড/, '"২ম" is not a Bangla ordinal');
    assert.match(subs[2], /^৪র্থ পিরিয়ড/);
    // The unit, directly: this is the function the screen depends on.
    assert.deepEqual([1, 2, 3, 4, 5, 6].map(periodBn),
      ['১ম', '২য়', '৩য়', '৪র্থ', '৫ম', '৬ষ্ঠ']);
    // Past the table it must not invent a suffix.
    assert.equal(periodBn(20), '২০');
  });

  test('times are Bangla digits, both ends', () => {
    assert.equal(bnTime('08:00'), '৮:০০');
    assert.equal(bnTime('11:45'), '১১:৪৫');
    assert.match(todayRows(root)[0].textContent ?? '', /৮:০০–৮:৪৫/);
  });

  test('the period happening NOW is marked, and only that one', () => {
    const rows = todayRows(root);
    const marked = rows.filter((r) => r.textContent?.includes('এখন চলছে'));
    assert.equal(marked.length, 1);
    assert.match(marked[0].textContent ?? '', /পদার্থবিজ্ঞান/);
    assert.ok(marked[0].classList.contains('is-urgent'));
  });

  test('a covered period says so even while it is the current one', () => {
    // The defect this replaced: badge precedence put "এখন চলছে" in the only
    // slot available and the substitution vanished — at the exact moment the
    // student is walking to that room expecting a different teacher.
    const now = todayRows(root).find((r) => r.textContent?.includes('এখন চলছে'));
    assert.ok(now);
    assert.match(now.textContent ?? '', /এখন চলছে/);
    assert.match(now.textContent ?? '', /শাহনাজ \(বদলি\)/,
      'the substitution must survive alongside the timing');
  });

  test('with nothing running, the next period is the one marked', async () => {
    const r = await mount({}, AT_0940);
    const rows = todayRows(r);
    assert.equal(rows.filter((x) => x.textContent?.includes('এখন চলছে')).length, 0);
    const next = rows.filter((x) => x.textContent?.includes('পরবর্তী'));
    assert.equal(next.length, 1);
    assert.match(next[0].textContent ?? '', /পদার্থবিজ্ঞান/);
  });

  test('no classes today says so, rather than disappearing', async () => {
    const r = await mount({ myroutine: { slots: [] } });
    const section = [...r.querySelectorAll('section')]
      .find((s) => s.textContent?.includes('আজকের ক্লাস'));
    assert.ok(section, 'the heading stays — a missing block reads as a failed load');
    assert.match(section.textContent ?? '', /আজ কোনো ক্লাস নেই/);
  });

  test('a period with no subject or teacher never renders the word undefined', async () => {
    const r = await mount({
      myroutine: { slots: [{
        slotId: 'x', periodNo: 3, startsAt: '09:40', endsAt: '10:25',
        subjectBn: null, roomCode: null, teacherNameBn: null, isSubstitution: true,
      }] },
    });
    const rows = todayRows(r);
    assert.equal(rows.length, 1);
    const text = rows[0].textContent ?? '';
    assert.doesNotMatch(text, /undefined|null/);
    assert.match(text, /বিষয় নির্ধারিত হয়নি/);
    // With no name at all, the substitution still has to be sayable.
    assert.match(text, /বদলি শিক্ষক/);
  });

  test('the routine is its own request and does not wait for the others', async () => {
    const seen: string[] = [];
    await mount({}, AT_1115, seen);
    assert.ok(seen.some((u) => u.includes('/academics/myroutine')));
    // Five independent GETs, not one bundle: a slow inbox must not hold up
    // "which room next".
    assert.equal(new Set(seen).size, 5);
  });

  test('one failed block does not take the screen down', async () => {
    const r = await mount({ myroutine: null });
    // The routine failed; attendance, results and the inbox did not, so the
    // screen renders and only the one block shows its own empty state.
    assert.ok(r.textContent?.includes('এ মাসে হাজিরা'));
    assert.ok(!r.textContent?.includes('আবার চেষ্টা করুন'),
      'a single failure is not a whole-screen error');
  });
});
