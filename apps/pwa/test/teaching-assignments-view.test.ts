/**
 * P9-1 — the teaching-assignment grid, as a coordinator drives it.
 *
 * The API has its own suite; this is about the screen's three properties that
 * a server test cannot see, each of which was a real defect in this codebase
 * before it was a test here.
 *
 *   1. BOTH LAYOUTS EXIST AT ONCE. A matrix does not survive 360px, so a
 *      wide table and a narrow card stack are both rendered and CSS picks
 *      one. That means every cell has TWO controls, and editing one used to
 *      leave its twin showing the old teacher — invisible on a phone or a
 *      desktop, and wrong the moment a tablet crossed the breakpoint. Found
 *      in a browser, not in review.
 *
 *   2. A REFUSED SAVE MUST NOT ERASE THE WORK. `writer-save-errors.test.ts`
 *      records the shape: a `finally { load() }` wipes the message and the
 *      typing microseconds after they appear. This screen holds a whole
 *      afternoon of assignments, so the same mistake costs more here than
 *      anywhere else in the product.
 *
 *   3. RE-PICKING THE SAME NAME IS NOT AN EDIT. Otherwise a coordinator who
 *      opens a dropdown, looks, and closes it is warned about unsaved work
 *      that does not exist — and learns to ignore the warning.
 */
import { test, describe, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

import { TeachingAssignmentsView } from '../src/teaching-assignments-view.ts';

let dom: JSDOM;

before(() => {
  dom = new JSDOM('<!doctype html><html><body><main id="root"></main></body></html>',
                  { url: 'http://localhost/' });
  const g = globalThis as Record<string, unknown>;
  g.HTMLElement = dom.window.HTMLElement;
  // `CSS.escape` is used to find a cell's twin. jsdom has it; node does not.
  g.CSS = dom.window.CSS;
  g.confirm = () => true;
  for (const key of ['localStorage', 'location'] as const) {
    Object.defineProperty(globalThis, key, {
      value: dom.window[key], configurable: true, writable: true,
    });
  }
});

const doc = () => dom.window.document;
const root = () => doc().getElementById('root') as HTMLElement;
const settle = async () => { for (let i = 0; i < 12; i++) await new Promise((r) => setTimeout(r, 0)); };

const SEC_A = 'aaaaaaaa-0000-4000-8000-00000000000a';
const SEC_B = 'aaaaaaaa-0000-4000-8000-00000000000b';
const MATHS = 'bbbbbbbb-0000-4000-8000-00000000000a';
const BANGLA = 'bbbbbbbb-0000-4000-8000-00000000000b';
const RAFIQ = 'cccccccc-0000-4000-8000-00000000000a';
const KARIM = 'cccccccc-0000-4000-8000-00000000000b';

const GRID = {
  classes: [{ id: 'dddddddd-0000-4000-8000-00000000000a', nameBn: 'নবম শ্রেণি', levelNo: 9 }],
  classId: 'dddddddd-0000-4000-8000-00000000000a',
  sections: [
    { id: SEC_A, name: 'ক', shift: 'single' },
    { id: SEC_B, name: 'খ', shift: 'single' },
  ],
  subjects: [
    { id: MATHS, nameBn: 'গণিত', periodsPerWeek: 6, doublePeriodsPerWeek: 0, requiresCapability: null },
    { id: BANGLA, nameBn: 'বাংলা', periodsPerWeek: 5, doublePeriodsPerWeek: 0, requiresCapability: null },
  ],
  teachers: [
    { id: RAFIQ, nameBn: 'রফিক স্যার', employeeCode: 'EMP-1', teaches: [MATHS] },
    { id: KARIM, nameBn: 'করিম স্যার', employeeCode: 'EMP-2', teaches: [] },
  ],
  cells: [{ sectionId: SEC_A, subjectId: MATHS, teacherId: RAFIQ, teacherBn: 'রফিক স্যার' }],
  progress: { required: 4, assigned: 1 },
};

/** The requests the view made, so a test can assert what was SENT. */
let sent: Array<{ url: string; body: unknown }> = [];
let postReply: { ok: boolean; status: number; body: unknown } =
  { ok: true, status: 200, body: { opened: 1, closed: 0, unchanged: 0 } };

function auth() {
  return {
    role: 'principal',
    authedFetch: async (url: string, init?: { method?: string; body?: string }) => {
      if (init?.method === 'POST') {
        sent.push({ url, body: JSON.parse(init.body as string) });
        return {
          ok: postReply.ok, status: postReply.status,
          json: async () => postReply.body,
        } as unknown as Response;
      }
      return {
        ok: true, status: 200,
        json: async () => JSON.parse(JSON.stringify(GRID)),
      } as unknown as Response;
    },
  } as unknown as ConstructorParameters<typeof TeachingAssignmentsView>[0]['auth'];
}

const mount = async () => {
  root().textContent = '';
  const v = new TeachingAssignmentsView({
    root: root(), doc: doc(), auth: auth(), yearId: 'eeeeeeee-0000-4000-8000-00000000000a',
  });
  await settle();
  return v;
};

const cells = (scope: string) =>
  [...doc().querySelectorAll<HTMLSelectElement>(`${scope} select.assign-cell`)];
const cellFor = (scope: string, sectionId: string, subjectId: string) =>
  cells(scope).find((s) => s.dataset.cellKey === `${sectionId}|${subjectId}`) as HTMLSelectElement;
const saveBtn = () =>
  [...doc().querySelectorAll('button')].find((b) => b.textContent?.includes('সংরক্ষণ'));
const barText = () => doc().getElementById('assign-bar')?.textContent ?? '';

describe('P9-1 — the teaching-assignment grid', () => {
  beforeEach(() => {
    sent = [];
    postReply = { ok: true, status: 200, body: { opened: 1, closed: 0, unchanged: 0 } };
  });

  test('renders both layouts — the matrix and the card stack', async () => {
    await mount();
    assert.equal(cells('.assign-matrix').length, 4, '2 sections × 2 subjects');
    assert.equal(cells('.assign-stack').length, 4, 'the same cells, read down');
  });

  test('THE ONE THAT MATTERS — editing a cell moves its twin', async () => {
    await mount();
    const wide = cellFor('.assign-matrix', SEC_B, BANGLA);
    wide.value = KARIM;
    wide.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    await settle();

    const narrow = cellFor('.assign-stack', SEC_B, BANGLA);
    assert.equal(narrow.value, KARIM,
      'a tablet crossing the breakpoint would have shown the old teacher');
    assert.equal(narrow.dataset.dirty, 'true', 'and the twin must look unsaved too');
  });

  test('the saved teacher is preselected, not blank', async () => {
    await mount();
    assert.equal(cellFor('.assign-matrix', SEC_A, MATHS).value, RAFIQ);
    assert.equal(cellFor('.assign-stack', SEC_A, MATHS).value, RAFIQ);
  });

  test('progress is shown before anyone reaches Generate', async () => {
    await mount();
    assert.match(barText(), /১ \/ ৪/, 'Bangla digits, and the denominator is the whole job');
  });

  test('re-picking the same name is not an edit', async () => {
    await mount();
    const c = cellFor('.assign-matrix', SEC_A, MATHS);
    c.value = KARIM;
    c.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    await settle();
    assert.match(barText(), /১টি পরিবর্তন/);

    c.value = RAFIQ;                       // back to what the server has
    c.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    await settle();
    assert.doesNotMatch(barText(), /পরিবর্তন সংরক্ষণ করা হয়নি/,
      'a coordinator who looked at a dropdown and closed it has changed nothing');
    assert.ok(saveBtn()?.hasAttribute('disabled'), 'and Save must go quiet again');
  });

  test('only the CHANGED cells are sent', async () => {
    await mount();
    const c = cellFor('.assign-matrix', SEC_B, MATHS);
    c.value = KARIM;
    c.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    await settle();
    saveBtn()?.click();
    await settle();

    assert.equal(sent.length, 1);
    const body = sent[0].body as { changes: Array<{ sectionId: string; teacherId: string }> };
    assert.equal(body.changes.length, 1, 'not all four cells — one');
    assert.equal(body.changes[0].sectionId, SEC_B);
    assert.equal(body.changes[0].teacherId, KARIM);
  });

  test('clearing a cell sends null, not an empty string', async () => {
    // The API reads `null` as "close without reopening". An empty string
    // would fail its uuid check and refuse the whole batch.
    await mount();
    const c = cellFor('.assign-matrix', SEC_A, MATHS);
    c.value = '';
    c.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    await settle();
    saveBtn()?.click();
    await settle();

    const body = sent[0].body as { changes: Array<{ teacherId: string | null }> };
    assert.equal(body.changes[0].teacherId, null);
  });

  test('A REFUSED SAVE keeps the work on screen and says why', async () => {
    postReply = {
      ok: false, status: 409,
      body: { error: 'subject_not_in_class', message: 'এই শ্রেণিতে বিষয়টি পড়ানো হয় না' },
    };
    await mount();
    const c = cellFor('.assign-matrix', SEC_B, BANGLA);
    c.value = KARIM;
    c.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    await settle();
    saveBtn()?.click();
    await settle();

    assert.match(root().textContent ?? '', /এই শ্রেণিতে বিষয়টি পড়ানো হয় না/,
      'the server’s own sentence must reach the eye');
    // And the afternoon's work is still there, with the offending choice
    // still selected, so it can be corrected rather than retyped.
    assert.equal(cellFor('.assign-matrix', SEC_B, BANGLA).value, KARIM);
    assert.match(barText(), /পরিবর্তন সংরক্ষণ করা হয়নি/);
  });

  test('a competency is a hint, never a filter', async () => {
    // `teacher_competencies` is empty in every school on this deployment, so
    // filtering by it would offer an empty dropdown. The teacher known to
    // take the subject is marked; the rest stay choosable.
    await mount();
    const c = cellFor('.assign-matrix', SEC_A, MATHS);
    const labels = [...c.options].map((o) => o.textContent ?? '');
    assert.equal(c.options.length, 3, 'nobody, plus both teachers');
    assert.ok(labels.some((l) => l.includes('রফিক স্যার ✓')), 'the known one is marked');
    assert.ok(labels.some((l) => l.trim() === 'করিম স্যার'), 'the other is still offered');
  });

  test('every cell is named for a screen reader', async () => {
    // A grid cell announces neither its column header nor its row header, so
    // an unnamed select is "combo box" repeated eighty times.
    await mount();
    for (const c of cells('.assign-matrix')) {
      const name = c.getAttribute('aria-label') ?? '';
      assert.match(name, /শাখার শিক্ষক$/, 'names the subject AND the section');
      assert.doesNotMatch(name, /[0-9a-f]{8}-/, 'never a raw uuid');
    }
  });
});
