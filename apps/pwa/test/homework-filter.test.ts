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
