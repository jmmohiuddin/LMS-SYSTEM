/**
 * R-8 §4 — the composer will not send a large batch by accident.
 *
 * A notice to a whole school cannot be recalled from nine hundred phones. The
 * screen already restated the audience as a sentence, which catches "I meant
 * teachers, not everyone"; what it could not catch was "I did not realise
 * everyone was nine hundred people and four thousand five hundred messages".
 *
 * So above a threshold the send button is not enough, and these are the tests
 * of that gate. They matter more than most UI tests here because the failure
 * they prevent is irreversible and expensive, and because a gate that can be
 * bypassed by a re-render or a changed audience is not a gate.
 */
import { test, describe, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

import { NoticeComposeView } from '../src/notice-compose-view.ts';

let dom: JSDOM;

before(() => {
  dom = new JSDOM('<!doctype html><html><body><main id="root"></main></body></html>',
    { url: 'https://school.example/' });
  (globalThis as Record<string, unknown>).HTMLElement = dom.window.HTMLElement;
});

beforeEach(() => {
  dom.window.document.getElementById('root')!.textContent = '';
});

/** An estimate the server would have returned, without a server. */
function estimateFor(smsRecipients: number, segmentsEach = 1) {
  const segmentsTotal = smsRecipients * segmentsEach;
  return {
    recipients: smsRecipients + 5,
    smsRecipients,
    segmentsEach,
    segmentsTotal,
    confirmThreshold: 200,
    needsConfirmation: segmentsTotal > 200,
  };
}

/**
 * Mount the composer with a stubbed `authedFetch`.
 *
 * The preview endpoint is answered from `next`, so the whole range of send
 * sizes can be posed without a database — including the ones no fixture school
 * is big enough to produce.
 */
async function mount(next: () => unknown) {
  const root = dom.window.document.getElementById('root')!;
  const view = new NoticeComposeView({
    root: root as unknown as HTMLElement,
    doc: dom.window.document,
    auth: {
      // P5 made the composer refuse a role outside AUTHOR_ROLES, so the stub
      // has to say who it is. It already claimed to be one — `canPublishAll`
      // below is a principal's capability — it just never said so.
      role: 'principal',
      authedFetch: async (path: string) => new Response(
        JSON.stringify(path.includes('preview=1') ? next() : { sections: [] }),
        { status: 200, headers: { 'content-type': 'application/json' } }),
    } as never,
    canPublishAll: true,
    onPublished: () => {},
  } as never);
  await new Promise((r) => setTimeout(r, 20));
  return { root, view };
}

/** Type into the composer the way a person does, so the estimate is asked for. */
async function compose(root: HTMLElement, doc: Document, title: string, body: string) {
  // Addressed by `name`. This used to select `input.login-input, textarea`,
  // which put the two controls in DOM order and broke the moment P5 moved
  // them onto the `field()` primitive — the title stopped being set at all
  // and the estimate this whole file is about never ran.
  const set = (sel: string, v: string) => {
    const el = root.querySelector<HTMLInputElement | HTMLTextAreaElement>(sel);
    if (!el) return;
    el.value = v;
    el.dispatchEvent(new doc.defaultView!.Event('input', { bubbles: true }));
  };
  set('[name="title"]', title);
  set('[name="body"]', body);
  const sms = [...root.querySelectorAll('input[type=checkbox]')]
    .find((b) => /এসএমএস/.test(b.parentElement?.textContent ?? ''));
  if (sms) {
    (sms as HTMLInputElement).checked = true;
    sms.dispatchEvent(new doc.defaultView!.Event('change', { bubbles: true }));
  }
  // The estimate is debounced; wait past it.
  await new Promise((r) => setTimeout(r, 600));
}

describe('R-8 §4 — the large-send gate', () => {
  test('THE ONE THAT MATTERS — a big send cannot be sent without acknowledging it', async () => {
    const { root } = await mount(() => estimateFor(900, 5));   // 4,500 messages
    await compose(root as HTMLElement, dom.window.document, 'ছুটি', 'আগামীকাল বন্ধ।');

    const send = root.querySelector<HTMLButtonElement>('[data-send]');
    assert.ok(send, 'no send button');
    assert.equal(send.disabled, true, 'a 4,500-message send was one click away');

    const ack = root.querySelector('[data-big-send] input[type=checkbox]');
    assert.ok(ack, 'a big send must offer an explicit acknowledgement');
  });

  test('acknowledging it enables the send', async () => {
    const { root } = await mount(() => estimateFor(900, 5));
    await compose(root as HTMLElement, dom.window.document, 'ছুটি', 'আগামীকাল বন্ধ।');

    const ack = root.querySelector<HTMLInputElement>('[data-big-send] input[type=checkbox]')!;
    ack.checked = true;
    ack.dispatchEvent(new dom.window.Event('change', { bubbles: true }));

    assert.equal(root.querySelector<HTMLButtonElement>('[data-send]')!.disabled, false);
  });

  test('the acknowledgement states the actual numbers', async () => {
    // "I confirm" with no numbers is a box people tick. The numbers are what
    // make it a decision.
    const { root } = await mount(() => estimateFor(900, 5));
    await compose(root as HTMLElement, dom.window.document, 'ছুটি', 'আগামীকাল বন্ধ।');
    const label = root.querySelector('[data-big-send]')!.textContent ?? '';
    assert.match(label, /৯০০/, 'the recipient count');
    assert.match(label, /৪,?৫০০|৪৫০০/, 'the message count');
  });

  test('a small send is not gated at all', async () => {
    // The common case must not grow a checkbox. A confirmation that appears
    // for every notice is a confirmation nobody reads.
    const { root } = await mount(() => estimateFor(12, 1));
    await compose(root as HTMLElement, dom.window.document, 'ছুটি', 'আগামীকাল বন্ধ।');
    assert.equal(root.querySelector('[data-big-send]'), null);
    assert.equal(root.querySelector<HTMLButtonElement>('[data-send]')!.disabled, false);
  });

  test('THE ONE THAT MATTERS — changing the audience revokes the acknowledgement', async () => {
    // Otherwise: tick the box for a section, switch to "everyone", send. The
    // acknowledgement would carry over to a batch a hundred times larger, and
    // the gate would have made things worse than no gate at all.
    let size = 900;
    const { root } = await mount(() => estimateFor(size, 5));
    await compose(root as HTMLElement, dom.window.document, 'ছুটি', 'আগামীকাল বন্ধ।');

    const ack = root.querySelector<HTMLInputElement>('[data-big-send] input[type=checkbox]')!;
    ack.checked = true;
    ack.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    assert.equal(root.querySelector<HTMLButtonElement>('[data-send]')!.disabled, false);

    // The audience changes underneath — a different, larger send.
    size = 2000;
    const chip = [...root.querySelectorAll('button')]
      .find((b) => /সবাই|সব অভিভাবক/.test(b.textContent ?? ''));
    if (chip) {
      chip.dispatchEvent(new dom.window.Event('click', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 600));
      const send = root.querySelector<HTMLButtonElement>('[data-send]');
      assert.equal(send?.disabled, true,
        'an acknowledgement survived a change of audience');
    }
  });

  test('an offline estimate does not block sending', async () => {
    // The composer works offline by design. A cost estimate that could not be
    // fetched must not become a reason a school cannot tell anybody anything.
    const { root } = await mount(() => { throw new Error('offline'); });
    await compose(root as HTMLElement, dom.window.document, 'ছুটি', 'আগামীকাল বন্ধ।');
    assert.equal(root.querySelector<HTMLButtonElement>('[data-send]')!.disabled, false);
  });
});
