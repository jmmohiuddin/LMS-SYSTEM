/**
 * The homework inbox filter — F-808, wireframe §6.6.
 *
 * A student with twenty assignments across a term opens this screen to
 * answer one question: "what do I still owe?" The three buckets are what
 * answer it, and the bucketing rule is easy to get subtly wrong — a
 * submitted-but-ungraded assignment is neither pending nor graded, and
 * putting it in either place is a lie the student acts on.
 */
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

import { AssignmentsView } from '../src/assignments-view.ts';

let dom: JSDOM;

before(() => {
  // A url is required: without one jsdom has an opaque origin and
  // localStorage throws, which the view uses for its offline cache.
  dom = new JSDOM('<!doctype html><html><body><main id="root"></main></body></html>',
                  { url: 'http://localhost/' });
  (globalThis as Record<string, unknown>).HTMLElement = dom.window.HTMLElement;
  (globalThis as Record<string, unknown>).KeyboardEvent = dom.window.KeyboardEvent;
  // localStorage and location are getter-only on globalThis in newer Node,
  // so plain assignment throws and takes the whole hook with it.
  for (const key of ['localStorage', 'location'] as const) {
    Object.defineProperty(globalThis, key, {
      value: dom.window[key], configurable: true, writable: true,
    });
  }
});

const soon = () => new Date(Date.now() + 2 * 864e5).toISOString();

const assignment = (id: string, sub: null | { gradedAt: string | null }) => ({
  id, titleBn: id, dueAt: soon(), status: 'open', maxMarks: '20',
  subjectBn: 'গণিত', sectionName: 'ক', submissionCount: sub ? 1 : 0,
  ungradedCount: sub && !sub.gradedAt ? 1 : 0,
  mySubmission: sub ? { submittedAt: soon(), marksAwarded: null, gradedAt: sub.gradedAt } : null,
});

/** Mounts the view with a stubbed auth that returns a fixed list. */
function mount(list: unknown[]) {
  const root = dom.window.document.getElementById('root')!;
  root.textContent = '';
  const auth = {
    role: 'student',
    authedFetch: async () => ({
      ok: true, status: 200, json: async () => ({ assignments: list }),
    }),
  } as never;
  return { root, view: new AssignmentsView({ root, doc: dom.window.document, auth, outbox: null as never }) };
}

const settle = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0)); };

/** Mounts a student view whose auth answers both the list and one detail. */
function mountWithDetail(id: string) {
  const root = dom.window.document.getElementById('root')!;
  root.textContent = '';
  const ops: Array<Record<string, unknown>> = [];
  const auth = {
    role: 'student', userId: 's-1',
    authedFetch: async (url: string) => ({
      ok: true, status: 200,
      json: async () =>
        url.includes('assignmentId=')
          ? {
              assignment: {
                id, titleBn: 'গণিত ৪.২', instructionsBn: 'করো', maxMarks: '20',
                dueAt: soon(), allowsLate: true, status: 'open',
                subjectBn: 'গণিত', sectionName: 'ক',
              },
              submissions: [],
            }
          : { assignments: [assignment(id, null)] },
    }),
  } as never;
  const outbox = {
    enqueue: async (i: Record<string, unknown>) => { ops.push(i); return { opId: `op-${ops.length}` }; },
    flush: async () => {},
  } as never;
  return { root, ops, view: new AssignmentsView({ root, doc: dom.window.document, auth, outbox }) };
}

describe('homework draft autosave (F-902, §6.6)', () => {
  test('THE ONE THAT MATTERS — a typed answer survives a reload', async () => {
    localStorage.clear();
    const first = mountWithDetail('hw-1');
    await settle();
    (first.root.querySelector('.assign-card') as HTMLElement).click();
    await settle();

    const ta = first.root.querySelector('.assign-answer') as HTMLTextAreaElement;
    ta.value = 'আমার উত্তর ১';
    ta.dispatchEvent(new dom.window.Event('input'));

    assert.equal(localStorage.getItem('shikhon_assign_draft_hw-1'), 'আমার উত্তর ১',
      'the draft is persisted on every keystroke');
    assert.match(first.root.querySelector('.assign-draft-status')?.textContent ?? '', /সংরক্ষিত/);

    // A brand-new view instance is a page reload: the answer must come back.
    const again = mountWithDetail('hw-1');
    await settle();
    (again.root.querySelector('.assign-card') as HTMLElement).click();
    await settle();
    assert.equal((again.root.querySelector('.assign-answer') as HTMLTextAreaElement).value,
      'আমার উত্তর ১', 'the draft is restored after reload');
  });

  test('submitting clears the draft so a stale copy cannot resurrect', async () => {
    localStorage.clear();
    const { root, ops } = mountWithDetail('hw-2');
    await settle();
    (root.querySelector('.assign-card') as HTMLElement).click();
    await settle();
    const ta = root.querySelector('.assign-answer') as HTMLTextAreaElement;
    ta.value = 'জমা দেওয়ার উত্তর';
    ta.dispatchEvent(new dom.window.Event('input'));
    assert.ok(localStorage.getItem('shikhon_assign_draft_hw-2'));

    ([...root.querySelectorAll('button')].find((b) => b.textContent === 'জমা দাও') as HTMLButtonElement).click();
    await settle();
    assert.equal(ops.length, 1, 'the answer is queued to the outbox');
    assert.equal(localStorage.getItem('shikhon_assign_draft_hw-2'), null, 'and the draft is cleared');
  });

  test('emptying the field clears the saved draft, so a blank is not "restored"', async () => {
    localStorage.clear();
    const { root } = mountWithDetail('hw-3');
    await settle();
    (root.querySelector('.assign-card') as HTMLElement).click();
    await settle();
    const ta = root.querySelector('.assign-answer') as HTMLTextAreaElement;
    ta.value = 'কিছু';
    ta.dispatchEvent(new dom.window.Event('input'));
    assert.ok(localStorage.getItem('shikhon_assign_draft_hw-3'));
    ta.value = '';
    ta.dispatchEvent(new dom.window.Event('input'));
    assert.equal(localStorage.getItem('shikhon_assign_draft_hw-3'), null);
  });
});

describe('homework inbox filter', () => {
  test('the three buckets are mutually exclusive and cover every assignment', async () => {
    // Never-submitted, submitted-awaiting-marks, and graded. The middle one
    // is the case that gets miscounted.
    const list = [
      assignment('pending-1', null),
      assignment('pending-2', null),
      assignment('awaiting', { gradedAt: null }),
      assignment('graded', { gradedAt: new Date().toISOString() }),
    ];
    const { root } = mount(list);
    await new Promise((r) => setTimeout(r, 0));

    const counts = [...root.querySelectorAll('.seg-opt')]
      .map((b) => b.getAttribute('aria-label') ?? '');
    assert.equal(counts.length, 3, 'three buckets, always visible');

    const nums = counts.map((c) => (c.match(/[০-৯]+/)?.[0] ?? ''));
    const toLatin = (s: string) => s.replace(/[০-৯]/g, (d) => String('০১২৩৪৫৬৭৮৯'.indexOf(d)));
    const [pending, submitted, graded] = nums.map((n) => Number(toLatin(n)));
    assert.equal(pending, 2, 'two never submitted');
    assert.equal(submitted, 1, 'one submitted and awaiting marks');
    assert.equal(graded, 1, 'one graded');
    assert.equal(pending + submitted + graded, list.length, 'buckets cover everything exactly once');
  });

  test('pending is the default — the question the screen exists to answer', async () => {
    const { root } = mount([assignment('a', null)]);
    await new Promise((r) => setTimeout(r, 0));
    const active = root.querySelector('.seg-opt[data-active="true"]');
    assert.ok(active, 'one bucket is selected on open');
    assert.ok(active!.getAttribute('aria-label')!.startsWith('বাকি'), 'and it is the pending one');
  });

  test('selection is announced, not just coloured', async () => {
    const { root } = mount([assignment('a', null)]);
    await new Promise((r) => setTimeout(r, 0));
    const opts = [...root.querySelectorAll('.seg-opt')];
    assert.equal(opts.filter((o) => o.getAttribute('aria-selected') === 'true').length, 1);
    assert.equal(root.querySelector('.seg-bar')!.getAttribute('role'), 'tablist');
  });

  test('an empty pending bucket reads as good news, not as an error', async () => {
    // "Nothing due" is the best possible state and must not show a warning
    // glyph — the empty-state glyph is the only signal a hurried reader gets.
    const { root } = mount([assignment('graded', { gradedAt: new Date().toISOString() })]);
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(root.querySelector('.empty-glyph')?.textContent, '✓');
    assert.match(root.querySelector('.empty-state p')?.textContent ?? '', /বাকি নেই/);
  });
});
