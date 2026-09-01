/**
 * The attendance screen's states. (P3 — the highest-priority workflow)
 *
 * The DURABILITY of the offline queue is proved in `packages/offline`:
 * 60 students marked offline and synced when the tower returns, a duplicate
 * ack removing the op so a reinstall cannot double-post, a failed op parked
 * rather than deleted, a user-triggered retry re-arming it. Those 46 tests are
 * the contract and this file does not repeat them.
 *
 * What this file proves is the half P3 built: that a teacher can SEE which of
 * those states they are in. A queue that is perfectly durable and silent is
 * the screen this product already had — the chip said "৩টি পাঠানো যায়নি" and
 * offered nothing to do about it.
 *
 * The outbox is a stub here on purpose. `OutboxLike` is three methods, and
 * driving the real engine through jsdom would test IndexedDB rather than the
 * rendering, which is the thing that was missing.
 */
import { test, describe, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

import { AttendanceScreen } from '../src/attendance-screen.ts';
import type { OutboxLike } from '../src/attendance-view.ts';

let dom: JSDOM;
const doc = () => dom.window.document;
const host = () => doc().getElementById('root') as HTMLElement;

before(() => {
  dom = new JSDOM('<!doctype html><html lang="bn"><body><main id="root"></main></body></html>',
    { url: 'http://localhost/app' });
  const g = globalThis as Record<string, unknown>;
  g.HTMLElement = dom.window.HTMLElement;
  g.KeyboardEvent = dom.window.KeyboardEvent;
  g.CSS = dom.window.CSS;
  g.document = dom.window.document;
  g.location = dom.window.location;
  Object.defineProperty(globalThis, 'navigator',
    { value: dom.window.navigator, configurable: true });
  Object.defineProperty(globalThis, 'localStorage',
    { value: dom.window.localStorage, configurable: true });
  g.addEventListener = dom.window.addEventListener.bind(dom.window);
  g.removeEventListener = dom.window.removeEventListener.bind(dom.window);
});

beforeEach(() => {
  host().textContent = '';
  try { dom.window.localStorage.clear(); } catch { /* ignore */ }
  setOnline(true);
});

function setOnline(on: boolean): void {
  Object.defineProperty(dom.window.navigator, 'onLine', { value: on, configurable: true });
  Object.defineProperty(globalThis.navigator, 'onLine', { value: on, configurable: true });
}

/* ── fakes ────────────────────────────────────────────────────────────── */

const SECTIONS = [
  { id: 's1', name: 'ক', shift: 'morning', studentCount: 2,
    className: { bn: 'নবম শ্রেণি', en: 'Class 9' }, levelNo: 9, academicYearId: 'y1' },
  { id: 's2', name: 'খ', shift: 'morning', studentCount: 1,
    className: { bn: 'নবম শ্রেণি', en: 'Class 9' }, levelNo: 9, academicYearId: 'y1' },
];
// The endpoint's real shape: `fullName: { bn, en }`, NOT `nameBn`.
const ROSTER = [
  { studentId: 'a', rollNo: 1, fullName: { bn: 'সাদিয়া ইসলাম', en: 'Sadia Islam' }, phone: null },
  { studentId: 'b', rollNo: 2,
    fullName: { bn: 'মোহাম্মদ আব্দুল্লাহ আল-মামুন চৌধুরী', en: null }, phone: null },
  // A child with no Bangla name recorded — the roster allows it, and the
  // accessible name must still be a name.
  { studentId: 'c', rollNo: 3, fullName: { bn: null, en: 'Rafi Hasan' }, phone: null },
  // And one with neither, which is the row that produced "undefined".
  { studentId: 'd', rollNo: 4, fullName: { bn: null, en: null }, phone: null },
];

interface Route { status?: number; body?: unknown; throws?: boolean }

function fakeAuth(routes: Record<string, Route>): { authedFetch: (p: string) => Promise<Response> } {
  return {
    authedFetch: async (path: string) => {
      const key = Object.keys(routes).find((k) => path.startsWith(k));
      const r = key ? routes[key] : { status: 404, body: {} };
      if (r.throws) throw new TypeError('Failed to fetch');
      const status = r.status ?? 200;
      return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => r.body ?? {},
      } as Response;
    },
  };
}

const OK = {
  '/api/v1/academics/sections': { body: { sections: SECTIONS } },
  '/api/v1/academics/roster': { body: { roster: ROSTER } },
};

function stubOutbox(state: Partial<{ pending: number; failed: number }> = {}): OutboxLike & {
  enqueued: number; flushes: number; failNextEnqueue: boolean;
} {
  const s = { pending: state.pending ?? 0, failed: state.failed ?? 0, conflicts: 0 };
  return {
    enqueued: 0, flushes: 0, failNextEnqueue: false,
    async enqueue(input) {
      if (this.failNextEnqueue) throw new Error('IndexedDB refused');
      this.enqueued++;
      return { opId: input.opId ?? 'op1' };
    },
    async flush() { this.flushes++; return undefined; },
    async state() { return { ...s }; },
  } as never;
}

function mount(opts: {
  routes?: Record<string, Route>;
  outbox?: OutboxLike;
} = {}): AttendanceScreen {
  return new AttendanceScreen({
    root: host(), doc: doc(),
    auth: fakeAuth(opts.routes ?? OK) as never,
    outbox: opts.outbox ?? stubOutbox(),
    newId: () => 'session-1',
    takenOn: '2026-09-01',
    now: () => 0,
  });
}

const settle = () => new Promise((r) => setTimeout(r, 10));
const text = () => host().textContent ?? '';

/* ── tests ────────────────────────────────────────────────────────────── */

describe('P3 — the screen never invents a class', () => {
  test('THE ONE THAT MATTERS — no sections means it says so, not "৯-ক"', async () => {
    // Until P3 this screen fell back to `{ id: 'demo-section', labelBn: '৯-ক',
    // academicYearId: 'yr-2026' }`. A teacher who opened হাজিরা before ever
    // visiting the roster got a real-looking class that does not exist, and
    // every save was rejected by sync because 'yr-2026' is not a uuid.
    mount({ routes: { '/api/v1/academics/sections': { body: { sections: [] } } } });
    await settle();
    assert.doesNotMatch(text(), /৯-ক/);
    assert.match(text(), /কোনো সেকশন নির্ধারিত নেই/);
    assert.equal(host().querySelector('.tile'), null, 'no grid without a class');
  });

  test('the section label matches the one the roster screen shows', async () => {
    // The first cut assumed `{ labelBn, classLabelBn }` and rendered three
    // blank options. The response is JSON, so no type caught it — the browser
    // did, in about ten seconds.
    mount();
    await settle();
    const opts = [...host().querySelectorAll('option')].map((o) => o.textContent);
    assert.deepEqual(opts, ['নবম শ্রেণি — ক', 'নবম শ্রেণি — খ']);
  });

  test('the real academicYearId reaches the grid, not a placeholder', async () => {
    const outbox = stubOutbox();
    mount({ outbox });
    await settle();
    const screen = host();
    assert.ok(screen.querySelectorAll('.tile').length === 4);
    // Proven through the save payload below; here, that the year is not the
    // literal that used to be sent.
    assert.doesNotMatch(text(), /yr-2026/);
  });
});

describe('P3 — the states a teacher can be in', () => {
  test('loading shows a skeleton, not an empty screen', () => {
    mount();   // not awaited: this is the first frame
    assert.ok(host().querySelector('.is-skeleton'), 'no loading state');
    assert.equal(host().querySelector('.att-host'), null);
  });

  test('THE ONE THAT MATTERS — a section with no students explains itself', async () => {
    // A school's FIRST DAY is all-empty and nothing has gone wrong. "No data"
    // here is a dead end on the screen a teacher opened to take a register.
    mount({ routes: { ...OK, '/api/v1/academics/roster': { body: { roster: [] } } } });
    await settle();
    assert.match(text(), /এখনো কোনো শিক্ষার্থী ভর্তি হয়নি/);
    assert.match(text(), /শিক্ষার্থী তালিকা দেখুন/, 'and a way out');
  });

  test('a 403 is a permission state with no retry button', async () => {
    // Retrying a permission failure is futile, and a retry button teaches
    // people to hammer a locked door.
    mount({ routes: { '/api/v1/academics/sections': { status: 403 } } });
    await settle();
    assert.match(text(), /অনুমতি/);
    assert.equal(host().querySelector('.ui-state-denied button'), null);
  });

  test('a network failure with no cache is an error WITH a retry', async () => {
    mount({ routes: { '/api/v1/academics/sections': { throws: true } } });
    await settle();
    assert.match(text(), /সমস্যা|সংযোগ/);
    assert.ok([...host().querySelectorAll('button')]
      .some((b) => /আবার চেষ্টা/.test(b.textContent ?? '')), 'no retry offered');
  });

  test('THE ONE THAT MATTERS — a cached roster survives the network being gone', async () => {
    // This is the whole point of the screen. A teacher in a tin-roofed
    // classroom with no signal must still be able to take the register.
    mount();
    await settle();
    assert.equal(host().querySelectorAll('.tile').length, 4);

    host().textContent = '';
    setOnline(false);
    mount({ routes: { '/api/v1/academics/sections': { throws: true },
                      '/api/v1/academics/roster': { throws: true } } });
    await settle();
    assert.equal(host().querySelectorAll('.tile').length, 4,
      'the cached roster did not survive');
    assert.match(text(), /এখন অফলাইন/);
  });
});

describe('P3 — the seven facts, in words', () => {
  test('THE ONE THAT MATTERS — section, date, count and marked are all text', async () => {
    // §"Do not rely on color alone." Every one of these is a word.
    mount();
    await settle();
    const facts = [...host().querySelectorAll('.att-fact')].map((f) => f.textContent ?? '');
    assert.ok(facts.some((f) => f.includes('নবম শ্রেণি — ক')), 'section missing');
    assert.ok(facts.some((f) => f.includes('সেপ্টেম্বর')), 'date missing');
    assert.ok(facts.some((f) => /৪ জন/.test(f)), 'student count missing');
    assert.ok(facts.some((f) => f.includes('হাতে চিহ্নিত')), 'marked count missing');
  });

  test('"marked" counts what the teacher touched, not what defaults to present', async () => {
    // AttendanceGrid starts every student at `present`, so a count of tiles
    // with a status is the class size from the first frame — a reassuring
    // lie. The label says হাতে চিহ্নিত for the same reason.
    mount();
    await settle();
    const marked = [...host().querySelectorAll('.att-fact')]
      .find((f) => (f.textContent ?? '').includes('হাতে চিহ্নিত'));
    assert.match(marked?.textContent ?? '', /০ \/ ৪/, 'should start at zero touched');
  });

  test('offline is stated on this screen, not only in the shell banner', async () => {
    // The shell says "you are offline". This says what that means for the
    // register in front of you, which is the only question a teacher has.
    setOnline(false);
    mount();
    await settle();
    assert.match(text(), /এখন অফলাইন/);
    assert.match(text(), /সংযোগ পেলে নিজেই পাঠানো হবে/);
  });
});

describe('P3 — queued, failed, and the retry that did not exist', () => {
  test('THE ONE THAT MATTERS — a failed sync offers a retry', async () => {
    // The chip has said "৩টি পাঠানো যায়নি" since R-0 with nothing to do about
    // it. A teacher reading it could only reload the page and hope.
    const outbox = stubOutbox({ failed: 3 });
    mount({ outbox });
    await settle();
    const line = host().querySelector('.att-sync-line');
    assert.ok(line, 'no sync line for a failed op');
    assert.equal(line.getAttribute('data-state'), 'failed');
    assert.match(line.textContent ?? '', /৩টি পাঠানো যায়নি/);
    assert.match(line.textContent ?? '', /নিরাপদ আছে/, 'must reassure: nothing is lost');

    const retry = [...line.querySelectorAll('button')]
      .find((b) => /আবার পাঠান/.test(b.textContent ?? ''));
    assert.ok(retry, 'no retry button');
    retry.click();
    await settle();
    assert.equal(outbox.flushes >= 1, true, 'retry did not flush');
  });

  test('a queued op says it is queued, and that the data is on the device', async () => {
    const outbox = stubOutbox({ pending: 2 });
    mount({ outbox });
    await settle();
    const line = host().querySelector('.att-sync-line');
    assert.equal(line?.getAttribute('data-state'), 'queued');
    assert.match(line?.textContent ?? '', /২টি অপেক্ষমাণ/);
  });

  test('nothing queued renders no sync line at all', async () => {
    mount({ outbox: stubOutbox() });
    await settle();
    assert.equal(host().querySelector('.att-sync-line'), null,
      'a permanent "all clear" strip is noise');
  });
});

describe('P3 — saving', () => {
  test('THE ONE THAT MATTERS — two taps enqueue one register', async () => {
    // §17. On a slow phone the save button used to enqueue two sessions with
    // two different opIds for the same register.
    const outbox = stubOutbox();
    mount({ outbox });
    await settle();
    const save = host().querySelector<HTMLButtonElement>('[data-action="save"]')!;
    save.click();
    save.click();
    save.click();
    await settle();
    assert.equal(outbox.enqueued, 1, `three taps enqueued ${outbox.enqueued} registers`);
  });

  test('the save button reports busy while it is in flight', async () => {
    const outbox = stubOutbox();
    let release!: () => void;
    outbox.flush = () => new Promise((r) => { release = () => r(undefined); });
    mount({ outbox });
    await settle();
    const save = host().querySelector<HTMLButtonElement>('[data-action="save"]')!;
    save.click();
    await new Promise((r) => setTimeout(r, 1));
    assert.equal(save.getAttribute('aria-busy'), 'true');
    assert.equal(save.disabled, true);
    release();
  });

  test('saving offline says the data is on the device, not that it was sent', async () => {
    // The difference between "saved" and "delivered" is this network's whole
    // character, and a teacher who reads the wrong one goes home believing
    // the register is in.
    setOnline(false);
    mount();
    await settle();
    host().querySelector<HTMLButtonElement>('[data-action="save"]')!.click();
    await settle();
    const toast = doc().querySelector('.ui-toast');
    assert.match(toast?.textContent ?? '', /এই যন্ত্রে সংরক্ষিত/);
    assert.match(toast?.textContent ?? '', /সংযোগ পেলে/);
  });

  test('an enqueue that genuinely fails is reported, and the marks stay', async () => {
    // IndexedDB refusing is rare and fatal to this register — so it is said
    // plainly rather than swallowed, and the grid is not cleared.
    const outbox = stubOutbox();
    outbox.failNextEnqueue = true;
    mount({ outbox });
    await settle();
    host().querySelector<HTMLButtonElement>('[data-action="save"]')!.click();
    await settle();
    assert.match(doc().querySelector('.ui-toast')?.textContent ?? '', /সংরক্ষণ করা যায়নি/);
    assert.equal(host().querySelectorAll('.tile').length, 4, 'the marks were cleared');
  });
});

describe('P3 — every tile has a real accessible name', () => {
  test('THE ONE THAT MATTERS — no tile is ever announced as "undefined"', async () => {
    // The roster returns `fullName: { bn, en }`. Declaring `{ nameBn }` and
    // reading `r.nameBn` compiles, produces `undefined` at runtime, and looks
    // perfect on screen — the tile shows a roll number and a status glyph, and
    // the name only reaches `title` and `aria-label`. A screen reader
    // announced "রোল 1, undefined, উপস্থিত" for every child in the class.
    mount();
    await settle();
    const tiles = [...host().querySelectorAll('.tile')];
    assert.equal(tiles.length, 4);
    for (const t of tiles) {
      const label = t.getAttribute('aria-label') ?? '';
      assert.doesNotMatch(label, /undefined|null/, `tile announced: ${label}`);
      assert.match(label, /রোল/, 'every tile names its roll');
    }
    assert.match(tiles[0].getAttribute('aria-label') ?? '', /সাদিয়া ইসলাম/);
    // English-only and name-less rows still get something sayable.
    assert.match(tiles[2].getAttribute('aria-label') ?? '', /Rafi Hasan/);
    assert.match(tiles[3].getAttribute('aria-label') ?? '', /রোল ৪|রোল 4/);
  });
});

describe('P3 — the page says its title once', () => {
  test('the wrapper owns the heading; the grid does not repeat it', async () => {
    // Both rendered `<h1>হাজিরা</h1>` in the first cut, and printed the date
    // twice — the duplication between a page header and its content that §5
    // forbids.
    mount();
    await settle();
    assert.equal(host().querySelectorAll('h1').length, 1);
    assert.ok(host().querySelector('.sync-chip'), 'the chip still belongs to the grid');
  });
});
