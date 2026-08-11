/**
 * ShikhoAI tutor — F-809 / F-1302 / F-1311, wireframe §6.7.
 *
 * This is the screen where a machine talks to a child, so the rule it must
 * never break is not a layout rule: EVERY answer says where it came from.
 * A grounded reply names its NCTB sections; an ungrounded one admits it is
 * not quoting the textbook; a refusal and an offline turn are honest states
 * of their own, never a hang and never a confident-looking answer.
 */
import { test, describe, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

import { ShikhoView } from '../src/shikho-view.ts';

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
  // navigator.onLine drives the offline branch; default it to online.
  Object.defineProperty(globalThis, 'navigator', {
    value: { onLine: true }, configurable: true, writable: true,
  });
});

beforeEach(() => {
  localStorage.clear();
  (globalThis.navigator as { onLine: boolean }).onLine = true;
});

const settle = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0)); };

/** Mounts the tutor with a stubbed gateway reply. */
function mount(reply: Record<string, unknown>, ok = true) {
  const root = dom.window.document.getElementById('root') as HTMLElement;
  root.textContent = '';
  const auth = {
    authedFetch: async () => ({ ok, status: ok ? 200 : 500, json: async () => reply }),
  } as never;
  new ShikhoView({ root, doc: dom.window.document, auth });
  return root;
}

async function ask(root: HTMLElement, question = 'শব্দ কেন শূন্যে চলে না?') {
  const input = root.querySelector('.chat-input') as HTMLInputElement;
  input.value = question;
  (root.querySelector('.chat-form') as HTMLFormElement)
    .dispatchEvent(new dom.window.Event('submit', { cancelable: true }));
  await settle();
}

describe('ShikhoAI answer states (F-1302, §6.7)', () => {
  test('THE ONE THAT MATTERS — a grounded reply names its NCTB source', async () => {
    const root = mount({
      ok: true, reply: 'ভাবো, শব্দ কীভাবে যায়?',
      grounded: true, sources: ['পদার্থবিজ্ঞান ৯ম-১০ম / অধ্যায় ৯'],
    });
    await ask(root);

    const answer = root.querySelector('.chat-answer') as HTMLElement;
    assert.ok(answer, 'the assistant turn renders');
    assert.equal(answer.dataset.kind, 'grounded');
    const src = answer.querySelector('.chat-source')!.textContent ?? '';
    assert.match(src, /NCTB/, 'the source line names NCTB');
    assert.match(src, /অধ্যায় ৯/, 'and the actual section it used');
  });

  test('an ungrounded reply admits it is not the textbook', async () => {
    const root = mount({ ok: true, reply: 'সাধারণভাবে…', grounded: false, sources: [] });
    await ask(root);

    const answer = root.querySelector('.chat-answer') as HTMLElement;
    assert.equal(answer.dataset.kind, 'ungrounded');
    // The distinction has to be legible, not merely encoded in a data
    // attribute: an ungrounded answer must not read as a textbook answer.
    const src = answer.querySelector('.chat-source')!.textContent ?? '';
    assert.doesNotMatch(src, /✓ NCTB/, 'it does not claim a textbook source');
    assert.match(src, /পাওয়া যায়নি/, 'it says the passage was not found');
  });

  test('a refusal is its own honest state, not a confident answer', async () => {
    const root = mount({ ok: true, error: 'ai_refused' });
    await ask(root, 'আমার হোমওয়ার্কের উত্তর বলে দাও');

    const answer = root.querySelector('.chat-answer') as HTMLElement;
    assert.equal(answer.dataset.kind, 'refused');
    assert.match(answer.textContent ?? '', /শিক্ষককে/, 'and it points somewhere real');
  });

  test('F-1311 — offline answers immediately and offers cached study', async () => {
    // Something is cached, so the dead end has a way out.
    localStorage.setItem('shikhon_practice_tp-1', '[]');
    (globalThis.navigator as { onLine: boolean }).onLine = false;
    // The fetch would hang/throw; the view must never reach it.
    const root = mount({ ok: true, reply: 'should not be used', grounded: true });
    await ask(root);

    const answer = root.querySelector('.chat-answer') as HTMLElement;
    assert.equal(answer.dataset.kind, 'unavailable');
    assert.doesNotMatch(answer.textContent ?? '', /should not be used/, 'no network reply is shown');
    const cta = answer.querySelector('.chat-offline-cta');
    assert.ok(cta, 'cached lessons are offered instead of a dead end');
  });

  test('offline with nothing cached does not promise study that is not there', async () => {
    (globalThis.navigator as { onLine: boolean }).onLine = false;
    const root = mount({ ok: true, reply: 'x' });
    await ask(root);
    assert.equal(root.querySelector('.chat-offline-cta'), null);
  });

  test('the pinned scope is visible in the header', async () => {
    const root = mount({ ok: true, reply: 'x', grounded: true });
    await settle();
    assert.match(root.querySelector('.att-sub')?.textContent ?? '', /শ্রেণির পাঠ্যসূচি/);
  });
});
