/**
 * The client event tracker — F-1503, TRD §13.2.
 *
 * "Events batch and queue offline like any other mutation." What the
 * suite holds still: track() can never hurt the app, the queue trims by
 * acknowledged id and never by count, and the bounded queue confesses its
 * drops instead of hiding them.
 */
import { test, describe, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

import { Tracker } from '../src/track.ts';

let dom: JSDOM;

before(() => {
  dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
  for (const key of ['localStorage'] as const) {
    Object.defineProperty(globalThis, key, {
      value: dom.window[key], configurable: true, writable: true,
    });
  }
});

beforeEach(() => { localStorage.clear(); });

type Sent = { events: Array<{ id: string; type: string }> };

function okAuth(sent: Sent[] = []) {
  return {
    authedFetch: async (_url: string, init?: { body?: string }) => {
      const body = JSON.parse(init?.body ?? '{}') as Sent;
      sent.push(body);
      return {
        ok: true, status: 200,
        json: async () => ({ accepted: body.events.length, duplicates: 0 }),
      } as unknown as Response;
    },
  } as unknown as ConstructorParameters<typeof Tracker>[0]['auth'];
}

function downAuth() {
  return {
    authedFetch: async () => { throw new Error('offline'); },
  } as unknown as ConstructorParameters<typeof Tracker>[0]['auth'];
}

describe('tracker (F-1503)', () => {
  test('track queues without touching the network', () => {
    const sent: Sent[] = [];
    const t = new Tracker({ auth: okAuth(sent) });
    t.track('engagement.chapter_opened', { chapterId: 'c1' });
    t.track('engagement.topic_completed');
    assert.equal(t.pending(), 2);
    assert.equal(sent.length, 0, 'no request until flush');
  });

  test('flush sends the queue and trims exactly what was acknowledged', async () => {
    const sent: Sent[] = [];
    const t = new Tracker({ auth: okAuth(sent) });
    t.track('engagement.chapter_opened');
    t.track('learning.practice_attempted');
    await t.flush();
    assert.equal(sent.length, 1);
    assert.equal(sent[0].events.length, 2);
    assert.equal(t.pending(), 0);
  });

  test('THE ONE THAT MATTERS — a failed flush keeps the queue whole', async () => {
    // Offline is the normal case in this product, not the error case. A
    // tracker that lost its queue on a failed send would quietly erase the
    // exact offline story F-1503 exists to measure.
    const t = new Tracker({ auth: downAuth() });
    t.track('offline.sync_failed', { reason: 'timeout' });
    t.track('engagement.chapter_opened');
    await t.flush();
    assert.equal(t.pending(), 2, 'nothing trimmed without acknowledgement');
  });

  test('events queued while offline survive into the next session', async () => {
    // Same storage, new Tracker — an app restart.
    const t1 = new Tracker({ auth: downAuth() });
    t1.track('engagement.chapter_opened');
    await t1.flush();

    const sent: Sent[] = [];
    const t2 = new Tracker({ auth: okAuth(sent) });
    await t2.flush();
    assert.equal(sent[0].events.length, 1);
    assert.equal(t2.pending(), 0);
  });

  test('a large queue flushes in server-sized batches', async () => {
    const sent: Sent[] = [];
    const t = new Tracker({ auth: okAuth(sent), maxBatch: 100 });
    for (let i = 0; i < 250; i++) t.track('learning.practice_attempted', { seq: i });
    await t.flush();
    assert.deepEqual(sent.map((s) => s.events.length), [100, 100, 50]);
    assert.equal(t.pending(), 0);
  });

  test('the bounded queue drops oldest and CONFESSES the drop', async () => {
    const t = new Tracker({ auth: downAuth(), maxQueue: 5 });
    for (let i = 0; i < 8; i++) t.track('engagement.chapter_opened', { seq: i });
    assert.equal(t.pending(), 5, 'bounded');

    // Signal returns: the next flush leads with the confession, so the
    // gap in the data explains itself — no silent truncation, applied to
    // ourselves first.
    const sent: Sent[] = [];
    const t2 = new Tracker({ auth: okAuth(sent), maxQueue: 5 });
    await t2.flush();
    const types = sent.flatMap((s) => s.events.map((e) => e.type));
    assert.ok(types.includes('offline.events_dropped'));
  });

  test('track never throws, even with storage broken', () => {
    const broken = {
      getItem: () => { throw new Error('quota'); },
      setItem: () => { throw new Error('quota'); },
      removeItem: () => { throw new Error('quota'); },
    } as unknown as Storage;
    const t = new Tracker({ auth: okAuth(), storage: broken });
    // Analytics that can break a lesson screen would be removed within a
    // week, correctly.
    assert.doesNotThrow(() => { t.track('error.client', { code: 'x' }); });
  });

  test('overlapping flushes collapse to one', async () => {
    const sent: Sent[] = [];
    const t = new Tracker({ auth: okAuth(sent) });
    t.track('engagement.chapter_opened');
    await Promise.all([t.flush(), t.flush(), t.flush()]);
    assert.equal(sent.length, 1, 'one request, not three replays');
  });
});
