/**
 * P9-5 — lock and undo, as a coordinator meets them.
 *
 * The API suite proves the server enforces both. These are the four things
 * about the SCREEN that decide whether a school can use them:
 *
 *   1. A locked lesson can still be SELECTED. The first version refused the
 *      selection, which meant its action bar never opened — so the only
 *      control that could unlock it was unreachable, and a lock was a
 *      one-way door.
 *
 *   2. The lock is a WORD, not a padlock. A glyph says nothing to a screen
 *      reader, and the consequence — a later solver run leaves this alone —
 *      is the part that matters and cannot be drawn.
 *
 *   3. Undo names what it will reverse. "ফিরিয়ে নিন" alone asks a
 *      coordinator to remember what they last did, which is exactly what
 *      they are pressing it because they cannot.
 *
 *   4. Every mutation carries the version it was drawn from, so two people
 *      in one office cannot silently overwrite each other.
 */
import { test, describe, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

import { RoutineEditorView } from '../src/routine-editor-view.ts';

let dom: JSDOM;

before(() => {
  dom = new JSDOM('<!doctype html><html><body><main id="root"></main></body></html>',
                  { url: 'http://localhost/' });
  const g = globalThis as Record<string, unknown>;
  g.HTMLElement = dom.window.HTMLElement;
  g.CSS = dom.window.CSS;
  for (const key of ['localStorage', 'location'] as const) {
    Object.defineProperty(globalThis, key, {
      value: dom.window[key], configurable: true, writable: true,
    });
  }
});

const doc = () => dom.window.document;
const root = () => doc().getElementById('root') as HTMLElement;
const settle = async () => {
  for (let i = 0; i < 16; i++) await new Promise((r) => setTimeout(r, 0));
};

const SECTION = 'cccccccc-0000-4000-8000-00000000000a';
const ROUTINE = 'dddddddd-0000-4000-8000-00000000000b';
const SLOT = 'eeeeeeee-0000-4000-8000-00000000000c';

const baseGrid = (over: Record<string, unknown> = {}) => ({
  sectionId: SECTION,
  routine: {
    id: ROUTINE, nameBn: 'খসড়া', shift: 'single', status: 'draft', version: 1,
    publishedAt: null, editable: true, sectionLabel: 'নবম-ক',
  },
  days: [{ dow: 0, bn: 'রবি' }, { dow: 1, bn: 'সোম' }],
  periods: [
    { periodNo: 1, labelBn: '১ম', startsAt: '09:00', endsAt: '09:45', kind: 'teaching' },
    { periodNo: 2, labelBn: '২য়', startsAt: '09:45', endsAt: '10:30', kind: 'teaching' },
  ],
  slots: [{
    id: SLOT, dayOfWeek: 0, periodNo: 1, subjectBn: 'গণিত',
    teacherName: 'রফিক স্যার', roomName: 'কক্ষ ১',
    isDouble: false, doubleGroupId: null, parallelPool: null,
    isPinned: false, rowVersion: 7,
  }],
  undo: [],
  subjects: [], teachers: [], rooms: [],
  ...over,
});

let grid: Record<string, unknown> = baseGrid();
let sent: Array<Record<string, unknown>> = [];
let postReply: { ok: boolean; body: unknown } = { ok: true, body: { ok: true } };

function auth() {
  return {
    role: 'principal',
    authedFetch: async (url: string, init?: { method?: string; body?: string }) => {
      if (init?.method === 'POST') {
        sent.push(JSON.parse(init.body as string));
        return { ok: postReply.ok, status: postReply.ok ? 200 : 409,
                 json: async () => postReply.body } as unknown as Response;
      }
      if (url.includes('/academics/sections')) {
        return { ok: true, status: 200, json: async () => ({
          sections: [{ id: SECTION, name: 'ক', className: { bn: 'নবম' } }],
        }) } as unknown as Response;
      }
      return { ok: true, status: 200,
               json: async () => JSON.parse(JSON.stringify(grid)) } as unknown as Response;
    },
  } as unknown as ConstructorParameters<typeof RoutineEditorView>[0]['auth'];
}

const mount = async (opts: Record<string, unknown> = {}) => {
  root().textContent = '';
  const v = new RoutineEditorView({
    root: root(), doc: doc(), auth: auth(), ...opts,
  } as ConstructorParameters<typeof RoutineEditorView>[0]);
  await settle();
  return v;
};

const buttonNamed = (text: string) =>
  [...root().querySelectorAll('button')].find((b) => (b.textContent ?? '').includes(text));
const cell = () => root().querySelector('.routine-slot[data-filled="true"]') as HTMLElement;

describe('P9-5 — the editor’s lock and undo', () => {
  beforeEach(() => {
    grid = baseGrid();
    sent = [];
    postReply = { ok: true, body: { ok: true } };
    try { localStorage.clear(); } catch { /* jsdom */ }
  });

  test('THE ONE THAT MATTERS — a locked lesson can be selected and unlocked', async () => {
    // The first version refused the selection, which left the unlock control
    // unreachable: a lock was a door that only opened one way.
    grid = baseGrid({
      slots: [{ ...(baseGrid().slots as Record<string, unknown>[])[0], isPinned: true }],
    });
    await mount();
    cell().click();
    await settle();

    // Named 'পিন খুলুন', not 'পিন সরান': the row already has a 'সরান'
    // button that deletes the lesson, and two controls a scanning eye reads
    // as the same word is how a coordinator deletes a class they meant to
    // unlock.
    const unlock = buttonNamed('পিন খুলুন');
    assert.ok(unlock, 'a locked lesson must offer the control that unlocks it');
    unlock.click();
    await settle();
    assert.equal(sent.at(-1)?.action, 'unlock');
    assert.equal(sent.at(-1)?.slotId, SLOT);
  });

  test('a locked lesson cannot be moved or removed, and says why', async () => {
    grid = baseGrid({
      slots: [{ ...(baseGrid().slots as Record<string, unknown>[])[0], isPinned: true }],
    });
    await mount();
    cell().click();
    await settle();

    const text = root().textContent ?? '';
    assert.match(text, /পিন করা/);
    assert.match(text, /আবার রুটিন তৈরি করলেও এটি বদলাবে না/,
      'the consequence is what a coordinator needs, and it cannot be drawn');
    assert.equal(buttonNamed('সরান')?.disabled, true, 'remove is refused');

    // And placing it elsewhere is refused locally, without a round trip.
    const empty = root().querySelector('.routine-slot[data-filled="false"]') as HTMLElement;
    empty.click();
    await settle();
    assert.ok(!sent.some((x) => x.action === 'move'), 'no doomed request was sent');
    assert.match(root().textContent ?? '', /আগে পিন সরান/);
  });

  test('the lock is a WORD in the accessible name, not only a padlock', async () => {
    grid = baseGrid({
      slots: [{ ...(baseGrid().slots as Record<string, unknown>[])[0], isPinned: true }],
    });
    await mount();
    const label = cell().getAttribute('aria-label') ?? '';
    assert.match(label, /পিন করা/, 'a screen reader is told the state');
    assert.match(label, /বদলাবে না/, 'and the consequence');
    assert.equal(cell().dataset.pinned, 'true', 'the visual cue is a reinforcement');
  });

  test('locking sends the row version it was drawn from', async () => {
    await mount();
    cell().click();
    await settle();
    buttonNamed('পিন করুন')?.click();
    await settle();
    assert.equal(sent.at(-1)?.action, 'lock');
    assert.equal(sent.at(-1)?.rowVersion, 7,
      'two coordinators in one office is the ordinary case, not the exception');
  });

  test('THE ONE THAT MATTERS — undo names what it will reverse', async () => {
    grid = baseGrid({
      undo: [{ id: 'u1', action: 'move', labelBn: 'নবম-ক · গণিত · রবি ১ নম্বর পিরিয়ড',
               createdAt: '2026-09-07' }],
    });
    await mount();
    const undo = buttonNamed('ফিরিয়ে নিন');
    assert.ok(undo, 'the control is present when there is something to undo');
    assert.match(undo.textContent ?? '', /নবম-ক · গণিত · রবি ১ নম্বর পিরিয়ড/,
      '"undo" alone asks them to remember the thing they cannot');

    undo.click();
    await settle();
    assert.equal(sent.at(-1)?.action, 'undo');
    assert.equal(sent.at(-1)?.routineId, ROUTINE);
  });

  test('a deeper stack says how much further back it goes', async () => {
    grid = baseGrid({
      undo: [
        { id: 'u1', action: 'move', labelBn: 'ক · গণিত · রবি ১ নম্বর পিরিয়ড', createdAt: 'x' },
        { id: 'u2', action: 'lock', labelBn: 'ক · বাংলা · সোম ২ নম্বর পিরিয়ড', createdAt: 'x' },
        { id: 'u3', action: 'remove', labelBn: 'ক · ইংরেজি · রবি ২ নম্বর পিরিয়ড', createdAt: 'x' },
      ],
    });
    await mount();
    assert.match(root().textContent ?? '', /আরও ২টি ধাপ ফিরিয়ে নেওয়া যাবে/);
  });

  test('an empty stack shows the control disabled, not missing', async () => {
    // A control that appears only sometimes is one a person hunts for, and
    // its absence reads as a bug rather than as "nothing to undo".
    await mount();
    const b = buttonNamed('ফিরিয়ে নেওয়ার কিছু নেই');
    assert.ok(b);
    assert.equal(b.disabled, true);
  });

  test('a refused undo shows the server’s sentence and changes nothing', async () => {
    grid = baseGrid({
      undo: [{ id: 'u1', action: 'move', labelBn: 'নবম-ক · গণিত · রবি ১ নম্বর পিরিয়ড',
               createdAt: 'x' }],
    });
    postReply = { ok: false, body: {
      error: 'undo_blocked',
      message: '"নবম-ক · গণিত · রবি ১ নম্বর পিরিয়ড" আগের জায়গায় ফেরানো যাচ্ছে না '
             + '— সেই সময়টি এখন অন্য ক্লাসে ব্যবহৃত হচ্ছে।',
    } };
    await mount();
    buttonNamed('ফিরিয়ে নিন')?.click();
    await settle();
    assert.match(root().textContent ?? '', /সেই সময়টি এখন অন্য ক্লাসে ব্যবহৃত হচ্ছে/,
      'never "undo failed" — the sentence names what is in the way');
  });

  test('a stale move shows the server’s refusal rather than losing the change', async () => {
    postReply = { ok: false, body: {
      error: 'stale_slot',
      message: 'এই ক্লাসটি আপনার পর্দায় দেখানোর পর অন্য কেউ বদলে ফেলেছেন। '
             + 'নতুন অবস্থা দেখে আবার চেষ্টা করুন।',
    } };
    await mount();
    cell().click();
    await settle();
    (root().querySelector('.routine-slot[data-filled="false"]') as HTMLElement).click();
    await settle();
    assert.match(root().textContent ?? '', /অন্য কেউ বদলে ফেলেছেন/);
    assert.equal(sent.at(-1)?.rowVersion, 7, 'and it had sent the version it drew');
  });

  test('the editor opens on the section it was given, not the remembered one', async () => {
    // §16. Arriving from a generation result means the coordinator has a
    // section in mind, and this device's last choice is not it.
    try { localStorage.setItem('shikhon_last_section', 'some-other-section'); } catch { /* jsdom */ }
    const v = await mount({ sectionId: SECTION });
    void v;
    assert.match(root().textContent ?? '', /নবম-ক/);
  });

  test('§17 — an open lesson form counts as unsaved work', async () => {
    const v = await mount();
    assert.equal(v.hasUnsavedChanges(), false, 'a saved grid has nothing to lose');

    cell().click();
    await settle();
    buttonNamed('সম্পাদনা')?.click();
    await settle();
    assert.equal(v.hasUnsavedChanges(), true,
      'P9-2 recorded this gap in the setup wizard; this is the answer for both');
  });

  test('a published routine offers neither undo nor lock', async () => {
    grid = baseGrid({
      routine: { ...(baseGrid().routine as Record<string, unknown>), status: 'active',
                 editable: false },
      undo: [{ id: 'u1', action: 'move', labelBn: 'ক · গণিত', createdAt: 'x' }],
    });
    await mount();
    assert.equal(buttonNamed('ফিরিয়ে নিন'), undefined,
      'draft and published are different things and the editor works on one');
  });

  test('no raw uuid reaches the screen', async () => {
    grid = baseGrid({
      undo: [{ id: 'u1', action: 'move', labelBn: 'নবম-ক · গণিত · রবি ১ নম্বর পিরিয়ড',
               createdAt: 'x' }],
      slots: [{ ...(baseGrid().slots as Record<string, unknown>[])[0], isPinned: true }],
    });
    await mount();
    cell().click();
    await settle();
    const text = root().textContent ?? '';
    assert.doesNotMatch(text, /[0-9a-f]{8}-[0-9a-f]{4}/);
    assert.doesNotMatch(text, /undefined|NaN/);
    assert.doesNotMatch(text, /[0-9]+\s*টি/, 'Bangla numerals before a counter word');
  });
});
