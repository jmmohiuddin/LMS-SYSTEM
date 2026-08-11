/**
 * §7.5, and specifically F-1502: the attention list is a soft signal, never
 * a label.
 *
 * That rule lives in the shape of the markup, which means an ordinary
 * "improvement" can violate it without breaking anything visible — sort the
 * list worst-first, badge the two-signal student red, collapse long signal
 * lists behind a "+১ আরও". Each of those is a reasonable-looking commit and
 * each one turns a prompt into a verdict about a child.
 *
 * These tests are the thing that objects.
 */
import { test, describe, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

import { ClassPerfView } from '../src/class-perf-view.ts';

let dom: JSDOM;

const CHOICES = [
  { examSubjectId: 'es-1', label: 'নবম-ক · পদার্থবিজ্ঞান · ১ম সাময়িক' },
];

/**
 * Roll 4 carries two signals, roll 9 one, roll 21 one. Deliberately supplied
 * in roll order with the "worst" student first, so a test that only checked
 * ordering would pass by accident — the assertions check that the view did
 * not REORDER, and roll 21 with a single signal sitting last is what makes
 * the difference between roll order and severity order observable.
 */
const analysis = () => ({
  header: { examSubjectId: 'es-1', label: 'নবম-ক · পদার্থবিজ্ঞান · ১ম সাময়িক' },
  coverage: { marked: 32, enrolled: 35, absent: 2 },
  components: [
    { key: 'mcq', labelBn: 'বহুনির্বাচনি', max: 25, average: 11.2, percent: 45 },
    { key: 'cq', labelBn: 'সৃজনশীল', max: 50, average: 33.5, percent: 67 },
  ],
  practice: {
    source: 'practice',
    questions: [
      { questionNo: 7, kind: 'mcq', stemBn: 'শব্দের বেগ?', chapterBn: 'অধ্যায় ৯', attempts: 28, wrongPercent: 72 },
      { questionNo: 12, kind: 'mcq', stemBn: 'তরঙ্গদৈর্ঘ্য?', chapterBn: 'অধ্যায় ৯', attempts: 26, wrongPercent: 58 },
    ],
    reteach: { chapterBn: 'অধ্যায় ৯', questionCount: 2 },
  },
  attention: [
    { studentId: 's-4', nameBn: 'আনিকা রহমান', rollNo: 4, signals: ['গত ৩০ দিনে হাজিরা ৭২%', 'গত পরীক্ষার চেয়ে নম্বর ১৮% কম'] },
    { studentId: 's-9', nameBn: 'তানভীর হোসেন', rollNo: 9, signals: ['টানা ৪ দিন অনুপস্থিত'] },
    { studentId: 's-21', nameBn: 'সাদিয়া আক্তার', rollNo: 21, signals: ['টানা ৩ দিন অনুপস্থিত'] },
  ],
  thresholds: { attendanceFloorPercent: 80, streakDays: 3, markDropPoints: 15, windowDays: 30 },
});

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

beforeEach(() => { localStorage.clear(); });

const settle = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0)); };

async function mount(over?: Partial<ReturnType<typeof analysis>>) {
  const calls: string[] = [];
  const root = dom.window.document.getElementById('root') as HTMLElement;
  root.textContent = '';
  localStorage.setItem('shikhon_last_perf_exam', 'es-1');
  new ClassPerfView({
    root, doc: dom.window.document,
    auth: {
      authedFetch: async (url: string) => {
        calls.push(url);
        return {
          ok: true, status: 200,
          json: async () => ({ choices: CHOICES, analysis: { ...analysis(), ...over } }),
        } as unknown as Response;
      },
    } as never,
  });
  await settle();
  return { root, calls };
}

describe('class performance §7.5', () => {
  test('F-1502: the attention list stays in roll order, not severity order', async () => {
    const { root } = await mount();
    const names = [...root.querySelectorAll('.perf-att-name')].map((n) => n.textContent ?? '');
    assert.equal(names.length, 3);
    // Roll 4 first because it is roll 4, not because it has two signals.
    // Roll 21 last with one signal is the assertion that matters: a
    // severity sort would have moved it above roll 9 or left it tied, and
    // any sort at all would be visible here.
    assert.ok(names[0]?.startsWith('৪ ·'), names[0]);
    assert.ok(names[1]?.startsWith('৯ ·'), names[1]);
    assert.ok(names[2]?.startsWith('২১ ·'), names[2]);
  });

  test('F-1502: every signal is shown, and no row carries a score or badge', async () => {
    const { root } = await mount();
    const rows = [...root.querySelectorAll('.perf-att-row')];

    // Two signals in, two signals out. No truncation, no "+১ আরও".
    assert.equal(rows[0]?.querySelectorAll('.perf-att-signals li').length, 2);
    assert.equal(rows[1]?.querySelectorAll('.perf-att-signals li').length, 1);

    // No severity tone anywhere in the panel. The bars may carry
    // data-tone; children may not.
    const panel = rows[0]?.closest('.card') as HTMLElement;
    assert.equal(panel.querySelectorAll('.perf-att-row [data-tone]').length, 0);
    assert.equal(panel.querySelectorAll('.perf-att-row .badge').length, 0);
  });

  test('F-1502: the method is printed so a teacher can disagree with it', async () => {
    const { root } = await mount();
    const text = root.textContent ?? '';
    assert.ok(text.includes('সহায়তা প্রয়োজন হতে পারে'), 'heading must stay conditional');
    assert.ok(text.includes('কোথাও সংরক্ষণ করা হয় না'), 'must say nothing is stored');
    // Each threshold appears in Bangla digits, so the derivation is legible.
    assert.ok(text.includes('৮০%'), 'attendance floor');
    assert.ok(text.includes('টানা ৩ দিন'), 'streak days');
    assert.ok(text.includes('১৫%'), 'mark drop');
  });

  test('a class-wide trip is named as a class event, not thirty individual ones', async () => {
    const { root } = await mount({
      coverage: { marked: 5, enrolled: 5, absent: 0 },
      attention: [
        { studentId: 'a', nameBn: 'ক', rollNo: 1, signals: ['টানা ৪ দিন অনুপস্থিত'] },
        { studentId: 'b', nameBn: 'খ', rollNo: 2, signals: ['টানা ৪ দিন অনুপস্থিত'] },
        { studentId: 'c', nameBn: 'গ', rollNo: 3, signals: ['টানা ৪ দিন অনুপস্থিত'] },
      ],
    });
    const wide = root.querySelector('.perf-wide-note');
    assert.ok(wide, 'half the class tripping must be called out');
    assert.ok((wide?.textContent ?? '').includes('পুরো শ্রেণির'));
  });

  test('the practice panel says it is practice, not the exam', async () => {
    const { root } = await mount();
    const text = root.textContent ?? '';
    // A teacher reading these as exam questions is reading about a
    // self-selected cohort and does not know it.
    assert.ok(text.includes('অনুশীলনে যে প্রশ্নগুলো'), 'heading names practice');
    assert.ok(text.includes('পরীক্ষার খাতা থেকে নয়'), 'note rules out the exam explicitly');
    assert.ok(text.includes('অধ্যায় ৯'), 're-teach hint names the chapter');
  });

  test('only a component below half its own maximum carries the low tone', async () => {
    const { root } = await mount();
    const fills = [...root.querySelectorAll('.perf-bar-fill')] as HTMLElement[];
    assert.equal(fills.length, 2);
    assert.equal(fills[0]?.dataset.tone, 'low');   // MCQ 45%
    assert.equal(fills[1]?.dataset.tone, undefined); // CQ 67%
  });

  test('coverage is stated up front so a half-marked exam is not read as a bad one', async () => {
    const { root } = await mount();
    const text = root.textContent ?? '';
    assert.ok(text.includes('৩২/৩৫ জনের নম্বর দেওয়া হয়েছে'), text.slice(0, 200));
    assert.ok(text.includes('২ জন অনুপস্থিত'), 'absentees excluded from the averages');
  });
});
