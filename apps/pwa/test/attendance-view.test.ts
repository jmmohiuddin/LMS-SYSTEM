/**
 * The attendance screen, rendered into a real DOM (jsdom).
 *
 * These assert the things a user actually experiences: that a tap changes the
 * tile, that saving does not await the network, that the screen still works
 * with the network down, and that a screen-reader user gets a correct label.
 */
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

import { AttendanceView, type OutboxLike } from '../src/attendance-view.ts';
import { route, stalecaches, dataSaverPolicy, PRECACHE, CACHE_SHELL } from '../src/sw-router.ts';
import type { Student } from '../../../packages/ui-core/src/attendance-grid.ts';

let dom: JSDOM;
let doc: Document;

before(() => {
  dom = new JSDOM('<!doctype html><html><body><main id="root"></main></body></html>');
  doc = dom.window.document;
  // jsdom's KeyboardEvent etc. must be reachable from the module under test.
  (globalThis as Record<string, unknown>).HTMLElement = dom.window.HTMLElement;
  (globalThis as Record<string, unknown>).KeyboardEvent = dom.window.KeyboardEvent;
});

const students = (n: number): Student[] =>
  Array.from({ length: n }, (_, i) => ({
    studentId: `stu_${i + 1}`,
    rollNo: i + 1,
    nameBn: `শিক্ষার্থী ${i + 1}`,
    nameEn: `Student ${i + 1}`,
  }));

/** Records what the view asked the outbox to do; can pretend to be offline. */
class FakeOutbox implements OutboxLike {
  online = true;
  enqueued: Array<{ opId: string; payload: unknown }> = [];
  flushes = 0;
  pending = 0;
  failed = 0;

  async enqueue(input: { opId?: string; payload: unknown }) {
    const opId = input.opId ?? `op_${this.enqueued.length + 1}`;
    this.enqueued.push({ opId, payload: input.payload });
    this.pending++;
    return { opId };
  }
  async flush() {
    this.flushes++;
    if (!this.online) throw new Error('Failed to fetch');
    this.pending = 0;
    return undefined;
  }
  async state() {
    return { pending: this.pending, failed: this.failed, conflicts: 0 };
  }
}

function mount(n = 60, outbox = new FakeOutbox()) {
  const root = doc.getElementById('root')!;
  let idc = 0;
  const view = new AttendanceView({
    root,
    doc,
    students: students(n),
    section: { id: 'sec_9a', labelBn: '৯-ক', academicYearId: 'yr_2026' },
    takenOn: '2026-08-06',
    subjectBn: 'পদার্থবিজ্ঞান',
    outbox,
    newId: () => `sess_${++idc}`,
    now: () => 1_760_000_000_000,
  });
  return { view, root, outbox };
}

const tile = (root: HTMLElement, roll: number) =>
  root.querySelector<HTMLButtonElement>(`.tile[data-student-id="stu_${roll}"]`)!;

/* -------------------------------------------------------------------- */

describe('rendering', () => {
  test('renders one tile per student, in roll order, all present', () => {
    const { root } = mount(60);
    const tiles = root.querySelectorAll('.tile');
    assert.equal(tiles.length, 60);
    assert.equal(tiles[0].getAttribute('data-student-id'), 'stu_1');
    assert.equal(tiles[59].getAttribute('data-student-id'), 'stu_60');
    assert.equal(root.querySelectorAll('.tile[data-status="present"]').length, 60);
  });

  test('tiles show roll numbers in Bangla, not names', () => {
    const { root } = mount(3);
    assert.equal(tile(root, 1).querySelector('.tile-roll')!.textContent, '১');
    assert.equal(tile(root, 3).querySelector('.tile-roll')!.textContent, '৩');
    assert.equal(
      root.textContent!.includes('শিক্ষার্থী 1'), false,
      'names are not rendered in the grid — they are 3x wider in Bangla',
    );
  });

  test('header carries section, subject and a localised date', () => {
    const { root } = mount(2);
    const sub = root.querySelector('.att-sub')!.textContent!;
    assert.ok(sub.includes('৯-ক'));
    assert.ok(sub.includes('পদার্থবিজ্ঞান'));
    assert.ok(sub.includes('৬ আগস্ট'), `date missing from "${sub}"`);
  });

  test('counters start at all-present and are announced politely', () => {
    const { root } = mount(10);
    const counts = root.querySelector('.att-counts')!;
    assert.equal(counts.getAttribute('aria-live'), 'polite');
    assert.ok(counts.textContent!.includes('উপস্থিত ১০'));
  });

  test('root carries lang so screen readers pick Bangla phonemes', () => {
    const { root } = mount(1);
    assert.equal(root.getAttribute('lang'), 'bn');
  });
});

describe('tapping', () => {
  test('a tap cycles the tile and updates glyph, aria and counters', () => {
    const { root } = mount(5);
    const t = tile(root, 2);

    t.dispatchEvent(new dom.window.Event('click'));
    assert.equal(t.dataset.status, 'absent');
    assert.equal(t.getAttribute('aria-checked'), 'false');
    assert.equal(t.querySelector('.tile-glyph')!.textContent, '✗');
    assert.equal(t.getAttribute('aria-label'), 'রোল 2, শিক্ষার্থী 2, অনুপস্থিত');
    assert.ok(root.querySelector('.att-counts')!.textContent!.includes('অনুপস্থিত ১'));

    t.dispatchEvent(new dom.window.Event('click'));
    assert.equal(t.dataset.status, 'late');
    t.dispatchEvent(new dom.window.Event('click'));
    assert.equal(t.dataset.status, 'present');
  });

  test('the aria-label always states the status in words, not just colour', () => {
    const { root } = mount(3);
    const t = tile(root, 1);
    assert.ok(t.getAttribute('aria-label')!.endsWith('উপস্থিত'));
    t.dispatchEvent(new dom.window.Event('click'));
    assert.ok(t.getAttribute('aria-label')!.endsWith('অনুপস্থিত'),
      'colour is never the only signal');
  });

  test('"all present" resets every tile', () => {
    const { root } = mount(6);
    tile(root, 1).dispatchEvent(new dom.window.Event('click'));
    tile(root, 4).dispatchEvent(new dom.window.Event('click'));
    assert.equal(root.querySelectorAll('.tile[data-status="absent"]').length, 2);

    const btn = [...root.querySelectorAll('button')].find((b) => b.textContent === 'সবাই উপস্থিত')!;
    btn.dispatchEvent(new dom.window.Event('click'));
    assert.equal(root.querySelectorAll('.tile[data-status="present"]').length, 6);
  });
});

describe('keyboard accessibility', () => {
  test('tiles are checkbox-role buttons inside a labelled group', () => {
    const { root } = mount(4);
    assert.equal(tile(root, 1).getAttribute('role'), 'checkbox');
    const group = root.querySelector('.att-grid')!;
    assert.equal(group.getAttribute('role'), 'group');
    assert.ok(group.getAttribute('aria-label'));
  });

  test('space toggles without scrolling the page', () => {
    const { root } = mount(3);
    const t = tile(root, 2);
    const ev = new dom.window.KeyboardEvent('keydown', { key: ' ', cancelable: true });
    t.dispatchEvent(ev);
    assert.equal(t.dataset.status, 'absent');
    assert.equal(ev.defaultPrevented, true, 'space must not scroll');
  });

  test('arrow keys move focus across the 5-column grid', () => {
    const { root } = mount(12);
    tile(root, 1).focus();
    tile(root, 1).dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowDown', cancelable: true }));
    assert.equal(doc.activeElement?.getAttribute('data-student-id'), 'stu_6', 'down = +5');
    tile(root, 6).dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowRight', cancelable: true }));
    assert.equal(doc.activeElement?.getAttribute('data-student-id'), 'stu_7');
  });

  test('focus movement stops at the edges instead of wrapping', () => {
    const { root } = mount(4);
    tile(root, 1).focus();
    tile(root, 1).dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowLeft', cancelable: true }));
    assert.equal(doc.activeElement?.getAttribute('data-student-id'), 'stu_1', 'no wrap-around');
  });
});

describe('saving — the UI never awaits the network', () => {
  test('save enqueues one op containing every student', async () => {
    const { view, outbox } = mount(60);
    const res = await view.save();

    assert.equal(outbox.enqueued.length, 1, 'one op per register, not 60');
    assert.equal(res.queued, true);
    const payload = outbox.enqueued[0].payload as { records: unknown[]; sessionId: string; mode: string };
    assert.equal(payload.records.length, 60);
    assert.equal(payload.mode, 'section_daily');
    assert.equal(payload.sessionId, res.opId, 'op id IS the session id');
  });

  test('save succeeds with the network down and shows queued state', async () => {
    const outbox = new FakeOutbox();
    outbox.online = false;
    const { view, root } = mount(30, outbox);

    tile(root, 5).dispatchEvent(new dom.window.Event('click'));
    const res = await view.save();          // must not throw

    assert.equal(res.queued, true);
    assert.equal(outbox.enqueued.length, 1, 'work is durable locally');
    const chip = root.querySelector('.sync-chip')!;
    assert.equal(chip.getAttribute('data-state'), 'queued');
    assert.ok(chip.textContent!.includes('অপেক্ষমাণ'));
  });

  test('a flush rejection never surfaces as an unhandled rejection', async () => {
    const outbox = new FakeOutbox();
    outbox.online = false;
    const { view } = mount(5, outbox);
    let unhandled: unknown = null;
    const onUnhandled = (e: unknown) => { unhandled = e; };
    process.on('unhandledRejection', onUnhandled);
    await view.save();
    await new Promise((r) => setTimeout(r, 20));
    process.off('unhandledRejection', onUnhandled);
    assert.equal(unhandled, null, 'offline is a normal state, not an error');
  });

  test('the chip reports failures distinctly from queued work', async () => {
    const outbox = new FakeOutbox();
    const { view, root } = mount(5, outbox);
    outbox.failed = 2;
    await view.paintChip();
    const chip = root.querySelector('.sync-chip')!;
    assert.equal(chip.getAttribute('data-state'), 'failed');
    assert.ok(chip.textContent!.includes('পাঠানো যায়নি'));
  });

  test('saving marks the grid clean and offers undo', async () => {
    const { view, root } = mount(5);
    tile(root, 2).dispatchEvent(new dom.window.Event('click'));
    assert.equal(view.state.dirty, true);
    await view.save();
    assert.equal(view.state.dirty, false);
    assert.equal(root.querySelector('.snackbar')!.hasAttribute('hidden'), false,
      'undo, not a confirmation dialog');
  });
});

/* ---------------------------------------------------- service worker */

describe('service-worker routing policy', () => {
  test('mutations and authoritative reads are never cached', () => {
    assert.equal(route({ url: 'https://a.bd/api/v1/sync/push', method: 'POST' }).strategy, 'network-only');
    assert.equal(route({ url: 'https://a.bd/api/v1/sync/pull', method: 'GET' }).strategy, 'network-only');
    assert.equal(route({ url: 'https://a.bd/api/v1/ai/chat', method: 'GET' }).strategy, 'network-only');
    assert.equal(route({ url: 'https://a.bd/api/v1/finance/payments', method: 'GET' }).strategy, 'network-only');
  });

  test('navigations fall back to the app shell so a cold offline start works', () => {
    const r = route({ url: 'https://a.bd/attendance/sec_9a', method: 'GET', mode: 'navigate' });
    assert.equal(r.strategy, 'app-shell');
    assert.equal(r.cache, CACHE_SHELL);
  });

  test('content-hashed assets are cache-first; reference data is SWR', () => {
    assert.equal(route({ url: 'https://a.bd/_next/static/x.js', method: 'GET' }).strategy, 'cache-first');
    assert.equal(route({ url: 'https://a.bd/fonts/noto-bengali-subset.woff2', method: 'GET' }).strategy, 'cache-first');
    assert.equal(route({ url: 'https://a.bd/api/v1/rms/teachers/1/day', method: 'GET' }).strategy, 'stale-while-revalidate');
  });

  test('media is cache-first with a 7-day TTL', () => {
    const r = route({ url: 'https://a.bd/media/script.jpg', method: 'GET' });
    assert.equal(r.strategy, 'cache-first-ttl');
    assert.equal(r.ttlSeconds, 7 * 24 * 3600);
  });

  test('precache stays small — it decides cold first paint on 2G', () => {
    assert.ok(PRECACHE.length <= 8, `precache has ${PRECACHE.length} entries`);
    assert.ok(PRECACHE.includes('/offline'));
    // Every precache entry must be a file that actually ships — a 404 here
    // used to abort SW install entirely (the once-listed .woff2 subset was
    // never built; Bangla renders from the device's system font instead).
    assert.ok(!PRECACHE.some((p) => p.includes('woff2')), 'no phantom font files in precache');
    assert.ok(PRECACHE.includes('/icons/icon.svg'), 'the app icon is precached');
  });

  test('old deploy caches are pruned, foreign caches are left alone', () => {
    const stale = stalecaches(['shikhon-shell-v0', 'shikhon-shell-v1', 'shikhon-media-v1', 'other-app-v3']);
    assert.deepEqual(stale, ['shikhon-shell-v0']);
  });
});

describe('data-saver policy', () => {
  test('2G or saveData drops avatars, lowers quality and lengthens the sync interval', () => {
    const p = dataSaverPolicy({ effectiveType: '2g' });
    assert.equal(p.lite, true);
    assert.equal(p.loadAvatars, false);
    assert.equal(p.imageQuality, 0.45);
    assert.equal(p.syncIntervalMs, 300_000);
  });

  test('a good link keeps full behaviour', () => {
    const p = dataSaverPolicy({ effectiveType: '4g' }, 4);
    assert.equal(p.lite, false);
    assert.equal(p.loadAvatars, true);
    assert.equal(p.autoCropWasm, true);
  });

  test('the WASM auto-cropper is skipped on 2 GB devices regardless of link', () => {
    assert.equal(dataSaverPolicy({ effectiveType: '4g' }, 2).autoCropWasm, false);
  });

  test('an absent Network Information API is treated as a good link', () => {
    assert.equal(dataSaverPolicy(undefined).lite, false);
  });
});
