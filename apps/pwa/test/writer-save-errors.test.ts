/**
 * P0 — a refused save must SAY it was refused.
 *
 * Found by using the fee screen, not by reading it. Creating a second
 * "মাসিক বেতন — পুরো প্রতিষ্ঠান" for the same year is refused by
 * `uq_fee_structure_scope` and the API answers 409 with a Bangla message
 * naming the conflict. The screen closed the drawer, threw away everything
 * the clerk had typed, re-read the list, and showed nothing at all. The
 * office sees a form vanish and a list that did not change, and the only
 * available reading is "saved".
 *
 * Two independent faults produced it, and either one alone is enough:
 *
 *   1. `handle.close()` ran BEFORE the request was sent, so the drawer
 *      closed no matter what came back.
 *   2. `send()` set `this.error`, then its own `finally` called `load()`,
 *      whose first statement is `this.error = ''`. The message was erased
 *      microseconds after being written, every time.
 *
 * `rooms-view.ts` was written from the same template and had both faults
 * too, so a duplicate room code failed just as quietly. It is tested here
 * beside the fee screen because the next writer will be copied from one of
 * them, and this file is what will object.
 *
 * The assertions deliberately check the SERVER's message reaches the eye —
 * not merely that "an error was displayed". A generic
 * "সংরক্ষণ করা যায়নি" would satisfy a weaker test and would still leave the
 * clerk unable to tell a duplicate from a lost connection.
 */
import { test, describe, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

import { FeeStructuresView } from '../src/fee-structures-view.ts';
import { RoomsView } from '../src/rooms-view.ts';

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

// Overlays mount on <body>, not on the view's root, so clearing the root
// between tests leaves them behind. A leftover drawer would then be the FIRST
// match for every button lookup here and the next test would drive a dead view.
beforeEach(() => {
  for (const s of [...doc().querySelectorAll('.ui-scrim')]) s.remove();
});

const settle = async () => { for (let i = 0; i < 12; i++) await new Promise((r) => setTimeout(r, 0)); };

const doc = () => dom.window.document;
const root = () => doc().getElementById('root') as HTMLElement;
/** Overlays mount on <body>, not inside the view's root. */
const drawer = () => doc().querySelector('.ui-dialog');
const byLabel = (label: string) =>
  [...doc().querySelectorAll('button')].find((b) => b.textContent?.trim() === label);

/** The exact refusal `feestructures.ts` returns for 23505. */
const FEE_409 = {
  status: 409,
  body: {
    error: 'duplicate_structure',
    message: 'এই শিক্ষাবর্ষে এই ফি-এর জন্য একই শ্রেণিতে আগে থেকেই একটি নির্ধারণ আছে।',
  },
};
const ROOM_409 = {
  status: 409,
  body: {
    error: 'duplicate_code',
    message: 'এই কোডে আগে থেকেই একটি কক্ষ আছে।',
  },
};

const FEE_LIST = {
  canManage: true,
  academicYearId: 'y-1',
  years: [{ id: 'y-1', label: '২০২৬', isCurrent: true }],
  classes: [{ id: 'c-1', nameBn: 'নবম' }],
  heads: [{ id: 'h-1', code: 'TUITION', nameBn: 'মাসিক বেতন', frequency: 'monthly', isActive: true }],
  structures: [],
};
const ROOM_LIST = { canManage: true, rooms: [], capabilities: [] };

/**
 * Answers the list GET normally and refuses the write, recording both. The
 * refusal is returned as a real non-ok Response shape so the view takes the
 * same branch it takes in the browser.
 */
function stub(list: unknown, refusal: { status: number; body: unknown }) {
  const writes: string[] = [];
  const auth = {
    authedFetch: async (url: string, init?: { method?: string }) => {
      const method = init?.method ?? 'GET';
      if (method === 'GET') {
        return { ok: true, status: 200, json: async () => list } as unknown as Response;
      }
      writes.push(method);
      return {
        ok: false, status: refusal.status, json: async () => refusal.body,
      } as unknown as Response;
    },
  } as never;
  return { auth, writes };
}

const setInput = (name: string, value: string) => {
  const i = doc().querySelector<HTMLInputElement>(`input[name="${name}"]`);
  assert.ok(i, `input ${name} not rendered`);
  i.value = value;
};
const setSelect = (name: string, value: string) => {
  const s = doc().querySelector<HTMLSelectElement>(`select[name="${name}"]`);
  assert.ok(s, `select ${name} not rendered`);
  s.value = value;
};

describe('a refused save is visible, and the typed values survive it', () => {
  test('THE ONE THAT MATTERS — fee: the 409 message reaches the screen', async () => {
    root().textContent = '';
    const { auth, writes } = stub(FEE_LIST, FEE_409);
    new FeeStructuresView({ root: root(), doc: doc(), auth });
    await settle();

    byLabel('নতুন ফি নির্ধারণ')?.click();
    await settle();
    setSelect('feeHeadId', 'h-1');
    setInput('amount', '1500');

    byLabel('নির্ধারণ করুন')?.click();
    await settle();

    assert.equal(writes.length, 1, 'the POST must actually have been attempted');
    const shown = doc().body.textContent ?? '';
    assert.ok(shown.includes(FEE_409.body.message),
      'the server said WHY and the clerk was not told:\n' + shown.slice(0, 400));
  });

  test('fee: the drawer stays open so the typed amount is not thrown away', async () => {
    root().textContent = '';
    const { auth } = stub(FEE_LIST, FEE_409);
    new FeeStructuresView({ root: root(), doc: doc(), auth });
    await settle();

    byLabel('নতুন ফি নির্ধারণ')?.click();
    await settle();
    setSelect('feeHeadId', 'h-1');
    setInput('amount', '1500');
    byLabel('নির্ধারণ করুন')?.click();
    await settle();

    assert.ok(drawer(), 'the drawer closed on a refusal — the form was discarded');
    const amount = doc().querySelector<HTMLInputElement>('input[name="amount"]');
    assert.equal(amount?.value, '1500', 'the clerk must not have to retype it');
  });

  test('rooms: the same refusal is just as visible (same template, same bug)', async () => {
    root().textContent = '';
    const { auth, writes } = stub(ROOM_LIST, ROOM_409);
    new RoomsView({ root: root(), doc: doc(), auth });
    await settle();

    byLabel('নতুন কক্ষ')?.click();
    await settle();
    setInput('code', '204');
    setInput('nameBn', 'কক্ষ ২০৪');
    setInput('capacity', '40');
    byLabel('যোগ করুন')?.click();
    await settle();

    assert.equal(writes.length, 1, 'the POST must actually have been attempted');
    assert.ok((doc().body.textContent ?? '').includes(ROOM_409.body.message),
      'a duplicate room code failed silently');
    assert.ok(drawer(), 'the drawer closed on a refusal — the form was discarded');
  });

  test('a save that SUCCEEDS still closes the drawer and confirms', async () => {
    // Without this, "never close the drawer" would pass every test above.
    root().textContent = '';
    const saved: string[] = [];
    const auth = {
      authedFetch: async (url: string, init?: { method?: string }) => {
        const method = init?.method ?? 'GET';
        if (method === 'GET') {
          return { ok: true, status: 200, json: async () => FEE_LIST } as unknown as Response;
        }
        saved.push(method);
        return {
          ok: true, status: 200, json: async () => ({ headBn: 'মাসিক বেতন' }),
        } as unknown as Response;
      },
    } as never;
    new FeeStructuresView({ root: root(), doc: doc(), auth });
    await settle();

    byLabel('নতুন ফি নির্ধারণ')?.click();
    await settle();
    setSelect('feeHeadId', 'h-1');
    setInput('amount', '1500');
    byLabel('নির্ধারণ করুন')?.click();
    await settle();

    assert.deepEqual(saved, ['POST']);
    assert.equal(drawer(), null, 'a successful save must close the drawer');
    assert.ok((doc().body.textContent ?? '').includes('নির্ধারণ করা হয়েছে'),
      'a successful save must confirm');
  });
});
