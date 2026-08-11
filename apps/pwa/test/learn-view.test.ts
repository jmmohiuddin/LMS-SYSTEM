/**
 * Chapter reader — F-803, wireframe §6.3.
 *
 * Two things this locks:
 *   • the reading article carries the class the stylesheet actually styles
 *     (a rename once left it '.topic-reader' while the CSS styled
 *     '.lesson-reader', so the 68ch measure and reader type size silently
 *     never applied);
 *   • the text-size control is persistent and remembered (§6.3) — a student
 *     reads for an hour, and the size that suits their eyes must survive the
 *     screen being closed.
 */
import { test, describe, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

import { LearnView } from '../src/learn-view.ts';

let dom: JSDOM;

const CHAPTER = {
  id: 'ch-1', chapterNo: 1, name: { bn: 'অধ্যায় ৯', en: null }, summaryBn: null,
  estMinutes: 20, isPublished: true, subject: { id: 'sub-1', bn: 'পদার্থবিজ্ঞান', en: 'Physics' },
  prerequisite: null, topicCount: 1, completedCount: 0,
};
const TOPIC = {
  id: 'tp-1', topicNo: 1, title: { bn: 'তরঙ্গ', en: null }, estMinutes: 5,
  isPublished: true, progress: null,
};
const DETAIL = {
  topic: { title: { bn: 'তরঙ্গ' } },
  blocks: [{ id: 'b1', blockNo: 1, kind: 'text', bodyBn: 'তরঙ্গ হলো একটি আন্দোলন।', mediaKey: null, altTextBn: null, captionBn: null }],
};

before(() => {
  dom = new JSDOM('<!doctype html><html><body><main id="root"></main></body></html>',
                  { url: 'http://localhost/' });
  (globalThis as Record<string, unknown>).HTMLElement = dom.window.HTMLElement;
  (globalThis as Record<string, unknown>).KeyboardEvent = dom.window.KeyboardEvent;
  for (const key of ['localStorage', 'location'] as const) {
    Object.defineProperty(globalThis, key, {
      value: dom.window[key], configurable: true, writable: true,
    });
  }
});

beforeEach(() => { localStorage.clear(); });

const settle = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0)); };

function mount() {
  const root = dom.window.document.getElementById('root') as HTMLElement;
  root.textContent = '';
  const auth = {
    role: 'student', userId: 's-1',
    authedFetch: async (url: string) => ({
      ok: true, status: 200,
      json: async () =>
        url.includes('/chapters') ? { chapters: [CHAPTER] }
        : url.includes('/practice') ? { questions: [] }   // also carries topicId=, so check first
        : url.includes('topicId=') ? DETAIL
        : url.includes('chapterId=') ? { topics: [TOPIC] }
        : { questions: [] },
    }),
  } as never;
  const outbox = { enqueue: async () => ({ opId: 'op' }), flush: async () => {} } as never;
  new LearnView({ root, doc: dom.window.document, auth, outbox, classId: 'cls-1' });
  return { root };
}

/** list → chapter → topic → reader */
async function openReader(root: HTMLElement) {
  await settle();
  (root.querySelector('.chapter-card') as HTMLElement).click();
  await settle();
  (root.querySelector('.topic-card') as HTMLElement).click();
  await settle();
}

describe('chapter reader (F-803)', () => {
  test('the reading article uses the class the stylesheet styles', async () => {
    const { root } = mount();
    await openReader(root);
    assert.ok(root.querySelector('.lesson-reader'), 'article is .lesson-reader, not the unstyled .topic-reader');
    assert.ok(root.querySelector('.lesson-reader .block-text'), 'the blocks render inside it');
  });

  test('THE ONE THAT MATTERS — text size is remembered across a reload', async () => {
    const { root } = mount();
    await openReader(root);
    const article = root.querySelector('.lesson-reader') as HTMLElement;
    assert.equal(article.style.fontSize, '18px', 'default reader size');

    const bigger = root.querySelector('.reader-size-lg') as HTMLButtonElement;
    bigger.click();
    assert.equal(article.style.fontSize, '21px', 'the text grows');
    assert.equal(localStorage.getItem('shikhon_reader_textsize'), '2', 'and the choice is stored');

    // A fresh view instance is a reload: the remembered size must apply.
    const second = mount();
    await openReader(second.root);
    assert.equal((second.root.querySelector('.lesson-reader') as HTMLElement).style.fontSize, '21px',
      'the remembered size is applied on reopen');
  });

  test('the control bottoms and tops out, never past the legibility floor', async () => {
    const { root } = mount();
    await openReader(root);
    const smaller = root.querySelector('.reader-size') as HTMLButtonElement;
    const bigger = root.querySelector('.reader-size-lg') as HTMLButtonElement;
    const article = root.querySelector('.lesson-reader') as HTMLElement;

    smaller.click(); // 18 -> 16 (the floor)
    assert.equal(article.style.fontSize, '16px');
    assert.equal(smaller.disabled, true, 'cannot go below the 16px Bangla floor');

    bigger.click(); bigger.click(); bigger.click(); // 16 -> 18 -> 21 -> 25 (cap)
    assert.equal(article.style.fontSize, '25px');
    assert.equal(bigger.disabled, true, 'cannot grow past the top step');
  });
});
