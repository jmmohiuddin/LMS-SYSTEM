/**
 * The generation-result screen — F-503, F-505, wireframe §8.2.
 *
 * This is the screen where somebody accepts a machine's timetable for
 * 1,200 children. What this suite holds still is that they cannot do it
 * without having been shown what was given up:
 *
 *   • the soft-constraint count is in the header beside the hard count;
 *   • the list of trades renders ABOVE the accept button, not behind a
 *     disclosure;
 *   • a truncated list carries the remaining count, never a bare "···";
 *   • rules that could not be checked are named, so "০ লঙ্ঘন" is never
 *     read as a guarantee it is not.
 */
import { test, describe, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

import { GenerationView } from '../src/generation-view.ts';

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
});

const SLOT = {
  id: 'slot-1', dayOfWeek: 2, periodNo: 3, startsAt: '10:30',
  sectionLabel: 'নবম–ক', subjectBn: 'পদার্থ ব্যবহারিক',
  teacherNameBn: 'নাসরিন আক্তার', roomCode: 'LAB-1',
};

const REPORT = {
  routine: { id: 'r1', nameBn: 'নিয়মিত রুটিন', status: 'draft', objectiveScore: 96 },
  hardViolations: 0,
  soft: [
    { code: 'teacher_weekly_cap',
      detailBn: 'রফিক ইসলাম — সাপ্তাহিক ২৬ পিরিয়ড (লক্ষ্য ২৪)',
      causeBn: 'যোগ্য গণিত শিক্ষক কম (১ জন)' },
    { code: 'subject_consecutive_days', detailBn: 'নবম–খ গণিত সোম ও মঙ্গল পরপর' },
    { code: 'teacher_room_churn', detailBn: 'শিরিন — সোমবার দিনে ৩ বার কক্ষ পরিবর্তন' },
  ],
  unplaced: [{ missing: 2, reason: 'no_free_slot' }],
  notEvaluated: [{ ruleBn: 'কঠিন বিষয় দিনের শুরুতে রাখা',
                   whyBn: 'বিষয়ের কাঠিন্য মাত্রা কোথাও সংরক্ষিত নেই' }],
  shortages: [{
    capability: 'chemistry_lab', demandedPeriods: 12, capableRooms: 1, freePeriods: 8,
    detailBn: '"chemistry_lab" কক্ষে ১২টি পিরিয়ড দরকার; ১টি কক্ষে ৮টি খালি',
  }],
  slots: [SLOT],
};

const EXPLANATION = {
  slotId: 'slot-1', sectionLabel: 'নবম–ক', subjectBn: 'পদার্থ ব্যবহারিক',
  dayOfWeek: 2, periodNo: 3,
  teacherWhyBn: 'নাসরিন আক্তার — এই পিরিয়ডে একমাত্র যোগ্য ও মুক্ত শিক্ষক (৩ জন যোগ্য)',
  roomWhyBn: 'ল্যাব ১ — একমাত্র উপযুক্ত কক্ষ',
};

function stubAuth(report: unknown, sent: Array<Record<string, unknown>> = []) {
  return {
    authedFetch: async (url: string, init?: { body?: string }) => {
      if (init?.body) sent.push(JSON.parse(init.body) as Record<string, unknown>);
      const body = url.includes('slotId=') ? EXPLANATION : report;
      return { ok: true, status: 200, json: async () => body } as unknown as Response;
    },
  } as unknown as ConstructorParameters<typeof GenerationView>[0]['auth'];
}

async function mount(report: unknown, sent?: Array<Record<string, unknown>>) {
  const root = dom.window.document.getElementById('root') as HTMLElement;
  root.textContent = '';
  new GenerationView({
    root, doc: dom.window.document, auth: stubAuth(report, sent),
    routineId: 'r1', onRegenerate: () => {},
  });
  for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0));
  return root;
}

describe('generation result screen (§8.2)', () => {
  let root: HTMLElement;
  beforeEach(async () => { root = await mount(REPORT); });

  test('both counters are in the header, and they say different things', () => {
    // P6 made these stat cards: three figures a coordinator DECIDES on —
    // whether to accept this routine and what it cost — and a decision is
    // made from a comparison, not from three sentences.
    const cards = [...root.querySelectorAll('.ui-stat')].map((c) => c.textContent ?? '');
    assert.ok(cards.some((c) => c.includes('কঠিন শর্ত লঙ্ঘন') && c.includes('০')), cards.join(' | '));
    assert.ok(cards.some((c) => c.includes('নরম শর্তে ছাড়') && c.includes('৩')), cards.join(' | '));
    // Zero hard violations because the database's exclusion constraints make
    // one unstorable — the card says WHY, so nobody reads it as luck.
    assert.ok(cards.some((c) => c.includes('ডাটাবেসেই অসম্ভব')));
  });

  test('THE ONE THAT MATTERS — trades render before the accept button', () => {
    // "Nothing is silently accepted" is a layout requirement as much as a
    // data one. If the list sat below the button, or behind a disclosure,
    // the screen would satisfy F-505 on paper and fail it in use.
    const nodes = [...root.querySelectorAll('.gen-trades:not(.gen-unchecked-list):not(.gen-shortage-list), .action-row')];
    assert.ok(nodes.length >= 2);
    assert.ok(nodes[0].classList.contains('gen-trades'),
              'the trade list comes first in document order');
    const accept = [...root.querySelectorAll('button')]
      .find((b) => b.textContent === 'গ্রহণ করুন');
    assert.ok(accept, 'and the accept button exists at all');
    assert.equal(
      root.querySelector('.gen-trades:not(.gen-unchecked-list):not(.gen-shortage-list)')!.compareDocumentPosition(accept!)
        & dom.window.Node.DOCUMENT_POSITION_FOLLOWING,
      dom.window.Node.DOCUMENT_POSITION_FOLLOWING,
      'accept follows the list, never precedes it');
  });

  test('the binding shortage is stated in resource terms, above the trades', () => {
    // §8.2: infeasibility "reports the binding shortage in resource terms
    // the coordinator can act on — not 'no solution found'". And above
    // the trade list, because it is the REASON periods are missing.
    const box = root.querySelector('.gen-shortage');
    assert.ok(box);
    assert.match(box!.textContent ?? '', /১২টি পিরিয়ড দরকার/);
    assert.match(box!.textContent ?? '', /৮টি খালি/);

    const trades = root.querySelector('.gen-trades:not(.gen-unchecked-list):not(.gen-shortage-list)');
    assert.ok(trades);
    assert.equal(
      box!.compareDocumentPosition(trades!) & dom.window.Node.DOCUMENT_POSITION_FOLLOWING,
      dom.window.Node.DOCUMENT_POSITION_FOLLOWING,
      'the shortage comes before the trades it explains');
  });

  test('a routine that fits shows no shortage block', async () => {
    const r = await mount({ ...REPORT, shortages: [] });
    assert.equal(r.querySelector('.gen-shortage'), null,
                 'a school with a spare lab does not need to be told about it');
  });

  test('a trade shows its cause when there is one', () => {
    const first = root.querySelector('.gen-trades:not(.gen-shortage-list) li');
    assert.match(first?.textContent ?? '', /রফিক ইসলাম — সাপ্তাহিক ২৬ পিরিয়ড/);
    assert.match(first?.textContent ?? '', /যোগ্য গণিত শিক্ষক কম/);
  });

  test('a trade without a cause does not invent one', () => {
    const items = [...root.querySelectorAll('.gen-trades:not(.gen-shortage-list) li')];
    const churn = items.find((li) => li.textContent?.includes('কক্ষ পরিবর্তন'));
    assert.ok(churn);
    assert.equal(churn!.querySelector('.gen-trade-why'), null);
  });

  test('unplaced periods are stated apart from soft trades', () => {
    // A period nobody could place is a class that does not happen, not a
    // preference given up. Folding them together would hide that.
    assert.match(root.textContent ?? '', /২টি পিরিয়ড বসানো যায়নি/);
  });

  test('rules that were not checked are named, so ০ is not read as a guarantee', () => {
    const box = root.querySelector('.gen-unchecked');
    assert.ok(box);
    assert.match(box!.textContent ?? '', /কঠিন বিষয় দিনের শুরুতে রাখা/);
    assert.match(box!.textContent ?? '', /সংরক্ষিত নেই/);
  });

  test('a long list truncates with the remaining count, not a bare ellipsis', async () => {
    const many = {
      ...REPORT,
      soft: Array.from({ length: 12 }, (_, i) => ({ code: 'x', detailBn: `ছাড় ${i}` })),
    };
    const r = await mount(many);
    const more = [...r.querySelectorAll('button')]
      .find((b) => b.textContent?.includes('আরও'));
    assert.match(more?.textContent ?? '', /আরও ৪টি দেখুন/);
    more!.click();
    assert.equal(r.querySelectorAll('.gen-trades:not(.gen-unchecked-list):not(.gen-shortage-list) li').length, 12);
  });
});

describe('কেন এই বরাদ্দ?', () => {
  test('nothing is explained until a slot is chosen', async () => {
    const root = await mount(REPORT);
    assert.equal(root.querySelector('.gen-explain'), null,
                 '300 unrequested justifications is how a screen becomes unreadable');
  });

  test('choosing a slot shows why this teacher and this room', async () => {
    const root = await mount(REPORT);
    const select = root.querySelector('.gen-slot-select') as HTMLSelectElement;
    select.value = 'slot-1';
    select.dispatchEvent(new dom.window.Event('change'));
    for (let i = 0; i < 3; i++) await new Promise((r) => setTimeout(r, 0));

    const panel = root.querySelector('.gen-explain');
    assert.ok(panel);
    assert.match(panel!.textContent ?? '', /একমাত্র যোগ্য ও মুক্ত শিক্ষক/);
    assert.match(panel!.textContent ?? '', /একমাত্র উপযুক্ত কক্ষ/);
    assert.match(panel!.textContent ?? '', /পিরিয়ড ৩ · নবম–ক/);
  });
});

describe('accepting and discarding', () => {
  test('accept posts the action the server expects', async () => {
    const sent: Array<Record<string, unknown>> = [];
    const root = await mount(REPORT, sent);
    ([...root.querySelectorAll('button')]
      .find((b) => b.textContent === 'গ্রহণ করুন') as HTMLButtonElement).click();
    for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0));
    assert.deepEqual(sent[0], { routineId: 'r1', action: 'accept' });
  });

  test('a published routine offers no accept, discard or regenerate', async () => {
    const root = await mount({ ...REPORT, routine: { ...REPORT.routine, status: 'active' } });
    const labels = [...root.querySelectorAll('button')].map((b) => b.textContent);
    assert.ok(!labels.includes('গ্রহণ করুন'));
    assert.ok(!labels.includes('বাতিল'));
    assert.match(root.querySelector('.action-row .status-chip')?.textContent ?? '', /প্রকাশিত/);
  });

  test('a clean routine says so rather than showing an empty list', async () => {
    const clean = { ...REPORT, soft: [], unplaced: [], shortages: [] };
    const root = await mount(clean);
    assert.match(root.textContent ?? '', /কিছু ছাড় দিতে হয়নি/);
    assert.equal(root.querySelector('.gen-trades:not(.gen-unchecked-list):not(.gen-shortage-list)'), null);
    // But the un-run rules are STILL shown: a clean report that hides what
    // it did not check is the failure F-505 is about.
    assert.ok(root.querySelector('.gen-unchecked'));
  });
});
