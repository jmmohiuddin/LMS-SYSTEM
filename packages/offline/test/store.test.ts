/**
 * Store contract + primitives.
 *
 * The SAME assertions run against both implementations. MemoryOutboxStore is
 * the reference; IndexedDbOutboxStore is what actually ships to the phone, so
 * it must not be the untested one.
 */
import 'fake-indexeddb/auto';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { MemoryOutboxStore, IndexedDbOutboxStore, openDb } from '../src/store.ts';
import { backoffMs, ClockSync, Mutex, uuidv7 } from '../src/util.ts';
import type { OutboxOp, OutboxStore } from '../src/types.ts';

const mkOp = (seq: number, over: Partial<OutboxOp> = {}): OutboxOp => ({
  opId: `op-${String(seq).padStart(4, '0')}`,
  seq,
  deviceId: 'dev_a',
  tenantId: 'tnt_a',
  actorId: 'usr_a',
  entity: 'attendance_record',
  operation: 'upsert',
  occurredAt: new Date(1_760_000_000_000 + seq).toISOString(),
  payload: { studentId: `stu_${seq}` },
  status: 'pending',
  attempts: 0,
  nextAttemptAt: 0,
  ...over,
});

/* ------------------------------------------------- shared contract suite */

function contract(name: string, make: () => Promise<OutboxStore>) {
  describe(`OutboxStore contract — ${name}`, () => {
    test('nextSeq is strictly monotonic', async () => {
      const s = await make();
      const seqs = [] as number[];
      for (let i = 0; i < 20; i++) seqs.push(await s.nextSeq());
      assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b));
      assert.equal(new Set(seqs).size, 20, 'no repeats');
    });

    test('append is idempotent on opId', async () => {
      const s = await make();
      await s.append(mkOp(1));
      await s.append(mkOp(1, { payload: { studentId: 'OVERWRITTEN' } }));
      const all = await s.all();
      assert.equal(all.length, 1, 'a replayed append must not duplicate');
      assert.deepEqual(all[0].payload, { studentId: 'stu_1' }, 'and must not overwrite');
    });

    test('claimBatch returns oldest-first, respecting the limit', async () => {
      const s = await make();
      for (const n of [5, 1, 4, 2, 3]) await s.append(mkOp(n));
      const batch = await s.claimBatch(3, Date.now());
      assert.deepEqual(batch.map((o) => o.seq), [1, 2, 3], 'author order, capped');
    });

    test('claimBatch excludes ops whose backoff has not elapsed', async () => {
      const s = await make();
      const now = 1_000_000;
      await s.append(mkOp(1, { nextAttemptAt: now - 1 }));
      await s.append(mkOp(2, { nextAttemptAt: now + 60_000 }));
      const batch = await s.claimBatch(10, now);
      assert.deepEqual(batch.map((o) => o.seq), [1]);
    });

    test('claimBatch only returns pending ops', async () => {
      const s = await make();
      await s.append(mkOp(1, { status: 'inflight' }));
      await s.append(mkOp(2, { status: 'failed' }));
      await s.append(mkOp(3, { status: 'conflict' }));
      await s.append(mkOp(4, { status: 'pending' }));
      const batch = await s.claimBatch(10, Date.now());
      assert.deepEqual(batch.map((o) => o.seq), [4]);
    });

    test('update persists, remove deletes, counts reflect reality', async () => {
      const s = await make();
      await s.append(mkOp(1));
      await s.append(mkOp(2));

      const op = (await s.get('op-0001'))!;
      op.status = 'failed';
      op.lastError = 'BOOM';
      await s.update(op);

      assert.equal((await s.get('op-0001'))!.lastError, 'BOOM');
      assert.deepEqual(await s.counts(), { pending: 1, inflight: 0, conflict: 0, failed: 1 });

      await s.remove('op-0001');
      assert.equal(await s.get('op-0001'), undefined);
      assert.equal((await s.all()).length, 1);
    });

    test('mutations returned by claimBatch do not alias stored state', async () => {
      const s = await make();
      await s.append(mkOp(1));
      const [claimed] = await s.claimBatch(1, Date.now());
      claimed.status = 'failed'; // caller mutates its copy without persisting
      assert.equal((await s.get('op-0001'))!.status, 'pending',
        'store must not be mutated by reference');
    });

    test('byStatus filters and stays seq-ordered', async () => {
      const s = await make();
      await s.append(mkOp(3, { status: 'failed' }));
      await s.append(mkOp(1, { status: 'failed' }));
      await s.append(mkOp(2, { status: 'pending' }));
      assert.deepEqual((await s.byStatus('failed')).map((o) => o.seq), [1, 3]);
    });
  });
}

contract('memory', async () => new MemoryOutboxStore());

let dbCounter = 0;
contract('indexeddb', async () => {
  // A fresh database name per case. Deleting and reopening one shared database
  // blocks while earlier connections are still open, and deadlocks the run.
  const { indexedDB } = globalThis as unknown as { indexedDB: IDBFactory };
  return new IndexedDbOutboxStore(await openDb(indexedDB, `shikhon_test_${++dbCounter}`));
});

/* ------------------------------------------------------------ primitives */

describe('uuidv7', () => {
  test('is well-formed, unique, and time-ordered', () => {
    let t = 1_700_000_000_000;
    const ids = Array.from({ length: 500 }, () => uuidv7(() => (t += 1)));
    assert.equal(new Set(ids).size, 500, 'unique');
    for (const id of ids) {
      assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    }
    assert.deepEqual([...ids].sort(), ids, 'lexicographic order == chronological order');
  });

  test('encodes the timestamp in the leading 48 bits', () => {
    const ts = 1_760_000_000_000;
    const id = uuidv7(() => ts, () => 0);
    const encoded = parseInt(id.slice(0, 8) + id.slice(9, 13), 16);
    assert.equal(encoded, ts);
  });
});

describe('backoffMs', () => {
  test('never exceeds the cap and never goes negative', () => {
    for (let a = 0; a < 30; a++) {
      for (const r of [0, 0.5, 0.999999]) {
        const d = backoffMs(a, { maxMs: 900_000, random: () => r });
        assert.ok(d >= 0 && d <= 900_000, `attempt ${a} r=${r} → ${d}`);
      }
    }
  });

  test('the ceiling grows exponentially until it saturates', () => {
    const max = (a: number) => backoffMs(a, { maxMs: 900_000, random: () => 0.999999 });
    assert.ok(max(1) < max(3), 'grows');
    assert.ok(max(3) < max(6), 'keeps growing');
    assert.equal(Math.round(max(25) / 1000), Math.round(max(30) / 1000), 'saturates at the cap');
  });

  test('is jittered, so a whole school does not retry in lockstep', () => {
    const samples = new Set(Array.from({ length: 50 }, () => backoffMs(5)));
    assert.ok(samples.size > 10, 'wide spread of delays');
  });
});

describe('ClockSync', () => {
  test('corrects wall time by the observed skew', () => {
    let t = 2_000_000;
    const c = new ClockSync(() => t);
    assert.equal(c.nowCorrected(), 2_000_000);
    c.observe(120_000); // device is 2 minutes fast
    assert.equal(c.nowCorrected(), 1_880_000);
    assert.equal(c.nowIso(), new Date(1_880_000).toISOString());
  });

  test('ignores absent or non-finite skew rather than corrupting the clock', () => {
    const c = new ClockSync(() => 1000);
    c.observe(500);
    c.observe(undefined);
    c.observe(NaN);
    c.observe(Infinity);
    assert.equal(c.offsetMs, 500);
  });
});

describe('Mutex', () => {
  test('collapses a concurrent caller instead of queueing it', async () => {
    const m = new Mutex();
    let ran = 0;
    const slow = () => m.run(async () => {
      ran++;
      await new Promise((r) => setTimeout(r, 10));
      return 'done';
    });
    const [a, b] = await Promise.all([slow(), slow()]);
    assert.equal(ran, 1, 'second call skipped, matching navigator.locks ifAvailable');
    assert.equal(a, 'done');
    assert.equal(b, undefined);
    assert.equal(m.isHeld, false, 'released');
  });

  test('releases the lock even when the body throws', async () => {
    const m = new Mutex();
    await assert.rejects(() => m.run(async () => { throw new Error('boom'); }));
    assert.equal(m.isHeld, false);
    assert.equal(await m.run(async () => 'ok'), 'ok');
  });
});
