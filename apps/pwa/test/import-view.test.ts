/**
 * The bulk import screen — F-1601, wireframe §10.2.
 *
 * The thing this suite exists to hold still is the one §10.2 is most
 * explicit about: "Partial import is permitted but the skipped count is
 * stated explicitly and logged (no silent truncation)."
 *
 * A screen that imports 768 of 784 rows and says "done" is the failure
 * mode. So the count of skipped students is on the button the operator
 * presses, and still on screen after the work is finished.
 */
import { test, describe, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

import { ImportView } from '../src/import-view.ts';

let dom: JSDOM;

before(() => {
  dom = new JSDOM('<!doctype html><html><body><main id="root"></main></body></html>',
                  { url: 'http://localhost/' });
  for (const key of ['HTMLElement', 'Blob', 'FileReader', 'File'] as const) {
    (globalThis as Record<string, unknown>)[key] = dom.window[key];
  }
  for (const key of ['localStorage', 'location'] as const) {
    Object.defineProperty(globalThis, key, {
      value: dom.window[key], configurable: true, writable: true,
    });
  }
});

/** 784 rows read, 16 bad — §10.2's own numbers. */
const DIRTY = {
  digest: 'a'.repeat(64),
  rowsRead: 784, rowsValid: 768, rowsRejected: 16, rowsImported: 0, batchId: null,
  errors: Array.from({ length: 16 }, (_, i) => ({
    lineNo: 42 + i, rollNo: String(100 + i), field: 'section',
    messageBn: `শাখা "ঘ" নেই — নবম শ্রেণিতে ক,খ,গ`,
  })),
  errorCsv: '﻿line,roll,field,reason\r\n42,100,section,x\r\n',
};

const CLEAN = {
  ...DIRTY, rowsRead: 784, rowsValid: 784, rowsRejected: 0, errors: [], errorCsv: null,
};

function stubAuth(reply: unknown, sent: Array<Record<string, unknown>> = []) {
  return {
    authedFetch: async (_url: string, init?: { body?: string }) => {
      if (init?.body) sent.push(JSON.parse(init.body) as Record<string, unknown>);
      const b = sent[sent.length - 1];
      // Step 4 echoes the same shape with the rows actually written.
      const body = b?.commit
        ? { ...(reply as Record<string, unknown>), rowsImported: (reply as { rowsValid: number }).rowsValid }
        : reply;
      return { ok: true, status: 200, json: async () => body } as unknown as Response;
    },
  } as unknown as ConstructorParameters<typeof ImportView>[0]['auth'];
}

/** Drive the view to step 3 by handing it a file, as the operator does. */
async function toReview(reply: unknown, sent: Array<Record<string, unknown>> = []) {
  const root = dom.window.document.getElementById('root') as HTMLElement;
  root.textContent = '';
  const view = new ImportView({
    root, doc: dom.window.document, auth: stubAuth(reply, sent),
    academicYearId: '7f000000-0000-4000-8000-000000000091',
  });
  const input = root.querySelector('input[type=file]') as HTMLInputElement;
  const file = new dom.window.File(['roll_no,name_bn\n7,আনিকা\n'], 'students.csv',
                                  { type: 'text/csv' });
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  input.dispatchEvent(new dom.window.Event('change'));
  // FileReader is async, then the fetch, then the render.
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
  return { root, view };
}

describe('bulk import screen (§10.2)', () => {
  let root: HTMLElement;

  test('starts at step 1 with a file picker and no way to import', async () => {
    const r = dom.window.document.getElementById('root') as HTMLElement;
    r.textContent = '';
    new ImportView({ root: r, doc: dom.window.document, auth: stubAuth(CLEAN) });
    assert.ok(r.querySelector('input[type=file]'));
    // "Nothing is written until step 4" — there is no button that could.
    const labels = [...r.querySelectorAll('button')].map((b) => b.textContent ?? '');
    assert.ok(!labels.some((l) => l.includes('আমদানি করুন')));
    assert.match(r.querySelector('.page-sub')?.textContent ?? '', /ধাপ ১/);
  });

  describe('with 16 bad rows out of 784', () => {
    beforeEach(async () => { ({ root } = await toReview(DIRTY)); });

    test('THE ONE THAT MATTERS — the button states what is being skipped', () => {
      const go = root.querySelector('.import-go') as HTMLButtonElement;
      // §10.2 verbatim: "৭৬৮টি ঠিক সারি আমদানি করুন, ১৬টি বাদ". Both
      // numbers, on the control itself. A screen that says only "import"
      // is how 16 children go missing quietly.
      assert.match(go.textContent ?? '', /৭৬৮টি ঠিক সারি আমদানি করুন/);
      assert.match(go.textContent ?? '', /১৬টি বাদ/);
    });

    test('counts both totals in Bangla numerals', () => {
      const text = root.textContent ?? '';
      assert.match(text, /৭৮৪টি সারি পড়া হয়েছে/);
      assert.match(text, /১৬টি সারিতে সমস্যা/);
    });

    test('errors are listed per row with a reason, not as a count', () => {
      const items = root.querySelectorAll('.import-errors li');
      assert.ok(items.length > 0);
      assert.match(items[0].textContent ?? '', /সারি ৪২/);
      assert.match(items[0].textContent ?? '', /শাখা "ঘ" নেই/);
    });

    test('a long list is truncated with the REMAINING COUNT, never a bare ellipsis', () => {
      // "···" alone tells the operator nothing about whether to keep
      // scrolling or go and fix the spreadsheet.
      const more = root.querySelector('.import-more');
      assert.match(more?.textContent ?? '', /আরও ৪টি/);
    });

    test('the error list is downloadable, as §10.2 requires', () => {
      const dl = [...root.querySelectorAll('button')]
        .find((b) => b.textContent?.includes('সমস্যার তালিকা'));
      assert.ok(dl, 'the download button exists');
    });

    test('the skipped count is still stated AFTER the import finishes', async () => {
      const sent: Array<Record<string, unknown>> = [];
      const { root: r2 } = await toReview(DIRTY, sent);
      (r2.querySelector('.import-go') as HTMLButtonElement).click();
      for (let i = 0; i < 4; i++) await new Promise((res) => setTimeout(res, 0));

      assert.match(r2.textContent ?? '', /৭৬৮টি শিক্ষার্থী আমদানি হয়েছে/);
      // No silent truncation: the 16 are on screen once the work is done,
      // not only before it.
      assert.match(r2.textContent ?? '', /১৬টি সারি বাদ দেওয়া হয়েছে/);
    });
  });

  describe('the request the screen makes', () => {
    test('step 2 never sends commit, and step 4 sends back the digest', async () => {
      const sent: Array<Record<string, unknown>> = [];
      const { root: r } = await toReview(DIRTY, sent);
      assert.equal(sent.length, 1);
      assert.equal(sent[0].commit, undefined, 'the dry run must not ask to write');
      assert.equal(sent[0].kind, 'student');

      (r.querySelector('.import-go') as HTMLButtonElement).click();
      for (let i = 0; i < 4; i++) await new Promise((res) => setTimeout(res, 0));

      assert.equal(sent.length, 2);
      assert.equal(sent[1].commit, true);
      // The digest is what stops a validated file being swapped for another.
      assert.equal(sent[1].digest, DIRTY.digest);
    });
  });

  describe('with a clean file', () => {
    beforeEach(async () => { ({ root } = await toReview(CLEAN)); });

    test('no error list and no skipped count to distract from the action', () => {
      assert.equal(root.querySelector('.import-errors'), null);
      assert.match((root.querySelector('.import-go') as HTMLElement).textContent ?? '',
                   /^৭৮৪টি সারি আমদানি করুন$/);
    });
  });

  describe('when nothing is importable', () => {
    test('the button is disabled and the screen says what to do', async () => {
      const dead = { ...DIRTY, rowsValid: 0, rowsRejected: 784 };
      const { root: r } = await toReview(dead);
      assert.equal((r.querySelector('.import-go') as HTMLButtonElement).disabled, true);
      assert.match(r.textContent ?? '', /ফাইলটি ঠিক করে আবার চেষ্টা করুন/);
    });
  });

  describe('the step indicator', () => {
    test('marks finished steps with a tick, not with colour alone', async () => {
      const { root: r } = await toReview(CLEAN);
      const done = [...r.querySelectorAll('.stepper-step[data-state=done] .stepper-num')];
      assert.ok(done.length >= 1);
      assert.ok(done.every((n) => n.textContent === '✓'));
      const current = r.querySelector('.stepper-step[data-state=current]');
      assert.equal(current?.getAttribute('aria-current'), 'step');
    });
  });
});
