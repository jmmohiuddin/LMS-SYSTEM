/**
 * Marks entry — the one rule that must not bend: F-709.
 *
 * A mark over the paper's ceiling is rejected inline and persisted NOWHERE.
 * The screen this replaced silently clamped 75 to 70, so a teacher who typed
 * 75 saved 70 and never knew — a wrong result that looks right forever. These
 * hold that door shut, plus the completeness counter that answers "am I done?"
 */
import { test, describe, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

import { MarksView } from '../src/marks-view.ts';

let dom: JSDOM;

const EXAM = {
  id: 'ex-1', nameBn: '১ম সাময়িক', status: 'draft', academicYearId: 'yr-1',
  subjects: [{
    examSubjectId: 'es-1', subject: { bn: 'পদার্থবিজ্ঞান', en: 'Physics' },
    cqMax: 70, mcqMax: 0, practicalMax: 0, caMax: 0, markingLocked: false,
  }],
};
const sheet = () => ({
  academicYearId: 'yr-1', examStatus: 'draft', markingLocked: false,
  maxima: { cq: 70, mcq: 0, practical: 0, ca: 0 },
  marks: [
    { rollNo: 1, studentId: 's-1', fullName: { bn: 'আনিকা', en: 'Anika' },
      cqMarks: null, mcqMarks: null, practicalMarks: null, caMarks: null,
      isAbsent: false, rowVersion: 1 },
    { rollNo: 2, studentId: 's-2', fullName: { bn: 'বিজয়', en: 'Bijoy' },
      cqMarks: null, mcqMarks: null, practicalMarks: null, caMarks: null,
      isAbsent: false, rowVersion: 1 },
  ],
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

beforeEach(() => { localStorage.clear(); localStorage.setItem('shikhon_last_section', 'sec-1'); });

const settle = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0)); };

async function mount() {
  const ops: Array<Record<string, unknown>> = [];
  const root = dom.window.document.getElementById('root') as HTMLElement;
  root.textContent = '';
  new MarksView({
    root, doc: dom.window.document,
    auth: {
      authedFetch: async (url: string) => {
        if (url.includes('/exams')) {
          return { ok: true, status: 200, json: async () => ({ exams: [EXAM] }) } as unknown as Response;
        }
        return { ok: true, status: 200, json: async () => sheet() } as unknown as Response;
      },
    } as never,
    outbox: {
      enqueue: async (i: Record<string, unknown>) => { ops.push(i); return { opId: `op-${ops.length}` }; },
      flush: async () => {},
    } as never,
  });
  await settle();
  // choose the one exam-subject so the sheet loads
  // P6 moved this onto `field()`, which gives the control a visible label.
  // Addressed by `name`, which is what it is actually called.
  const picker = root.querySelector('[name="examSubject"]') as HTMLSelectElement;
  picker.value = 'es-1';
  picker.dispatchEvent(new dom.window.Event('change'));
  await settle();
  return { root, ops };
}

const type = (input: HTMLInputElement, value: string) => {
  input.value = value;
  input.dispatchEvent(new dom.window.Event('input'));
};
const saveButton = (root: HTMLElement) =>
  [...root.querySelectorAll('button')].find((b) => b.textContent === 'সংরক্ষণ করুন') as HTMLButtonElement;

describe('marks entry (F-709)', () => {
  test('THE ONE THAT MATTERS — an over-max mark is flagged and saved nowhere', async () => {
    const { root, ops } = await mount();
    const input = root.querySelector('.marks-input') as HTMLInputElement; // roll 1, CQ (max 70)
    assert.ok(input, 'the CQ field renders');

    type(input, '75');
    // Flagged inline...
    assert.equal(input.getAttribute('aria-invalid'), 'true');
    const err = input.parentElement?.querySelector('.marks-error');
    assert.ok(err, 'an inline error appears');
    assert.match(err!.textContent ?? '', /সর্বোচ্চ/);
    assert.match(err!.textContent ?? '', /সংরক্ষণ হয়নি/);
    // ...and nothing is queued: the save is disabled because there is no
    // valid change to persist.
    assert.equal(saveButton(root).disabled, true);
  });

  test('correcting the value clears the flag and lets it save', async () => {
    const { root, ops } = await mount();
    const input = root.querySelector('.marks-input') as HTMLInputElement;

    type(input, '75');
    assert.equal(input.getAttribute('aria-invalid'), 'true');

    type(input, '65');
    assert.equal(input.getAttribute('aria-invalid'), null, 'the flag clears');
    assert.equal(input.parentElement?.querySelector('.marks-error'), null);

    saveButton(root).click();
    await settle();
    assert.equal(ops.length, 1, 'exactly the corrected mark is queued');
    assert.equal((ops[0].payload as { cqMarks: number }).cqMarks, 65);
  });

  test('the completeness counter answers "am I done?" and moves as you type', async () => {
    const { root } = await mount();
    const complete = root.querySelector('.marks-complete') as HTMLElement;
    assert.ok(complete, 'the counter renders');
    assert.match(complete.textContent ?? '', /০ \/ ২/, 'nobody marked yet, of two');

    const input = root.querySelector('.marks-input') as HTMLInputElement;
    type(input, '65');
    assert.match(complete.textContent ?? '', /১ \/ ২/, 'one accounted for after a valid mark');

    // An over-max value does NOT count as done — it was rejected.
    type(input, '99');
    assert.match(complete.textContent ?? '', /০ \/ ২/, 'the rejected mark is not counted');
  });
});
