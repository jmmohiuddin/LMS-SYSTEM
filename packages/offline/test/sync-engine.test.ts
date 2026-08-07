/**
 * Offline engine behaviour tests.
 *
 * The scenarios here are the ones that actually happen in a Bangladeshi
 * classroom: no signal at all, signal that dies mid-batch, duplicate
 * submissions from a reinstalled device, and a server that disagrees.
 *
 *   node --test packages/offline/test
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { SyncEngine } from '../src/sync-engine.ts';
import { MemoryOutboxStore } from '../src/store.ts';
import type { OutboxOp, PushRequest, PushResponse, SyncTransport } from '../src/types.ts';

/* ---------------------------------------------------------------- helpers */

let clock = 1_760_000_000_000; // fixed epoch ms; tests advance it explicitly
const now = () => clock;
const advance = (ms: number) => (clock += ms);
const seededRandom = (seed = 42) => {
  let s = seed;
  return () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
};

/** Records every request; replies with whatever the test scripts. */
class ScriptedTransport implements SyncTransport {
  readonly requests: PushRequest[] = [];
  private readonly handler: (req: PushRequest, callNo: number) => PushResponse | Promise<never>;

  constructor(handler: (req: PushRequest, callNo: number) => PushResponse | Promise<never>) {
    this.handler = handler;
  }
  async push(req: PushRequest): Promise<PushResponse> {
    this.requests.push(structuredClone(req));
    return this.handler(req, this.requests.length);
  }
}

const allApplied = (req: PushRequest): PushResponse => ({
  serverTime: new Date(clock).toISOString(),
  results: req.ops.map((o) => ({ opId: o.opId, status: 'applied' as const, rowVersion: 1 })),
});

const offline = (): Promise<never> => Promise.reject(new Error('Failed to fetch'));

function makeEngine(transport: SyncTransport, opts: Partial<Record<string, unknown>> = {}) {
  const store = new MemoryOutboxStore();
  const engine = new SyncEngine({
    deviceId: 'dev_test',
    tenantId: '11111111-1111-4111-8111-111111111111',
    actorId: 'usr_teacher',
    store,
    transport,
    now,
    random: seededRandom(),
    ...opts,
  });
  return { engine, store };
}

const attendance = (studentId: string, status: 'present' | 'absent' = 'absent') => ({
  entity: 'attendance_record' as const,
  payload: { sessionId: 'sess_1', studentId, status },
});

/* ------------------------------------------------------------------ tests */

describe('enqueue — the UI never awaits the network', () => {
  test('enqueue resolves while the network is down and nothing is lost', async () => {
    const { engine, store } = makeEngine(new ScriptedTransport(offline));

    for (let i = 1; i <= 5; i++) await engine.enqueue(attendance(`stu_${i}`));

    assert.equal((await store.counts()).pending, 5, 'all five ops durable locally');

    const res = await engine.flush(); // transport throws
    assert.equal(res.acked, 0);

    const after = await store.counts();
    assert.equal(after.pending + after.failed, 5, 'ZERO op loss on transport failure');
    assert.equal(after.failed, 0, 'a single failure must not park ops');
  });

  test('ops are assigned strictly increasing seq and unique UUIDv7 ids', async () => {
    const { engine, store } = makeEngine(new ScriptedTransport(allApplied));
    for (let i = 0; i < 50; i++) {
      advance(1);
      await engine.enqueue(attendance(`stu_${i}`));
    }
    const ops = await store.all();
    const ids = new Set(ops.map((o) => o.opId));
    assert.equal(ids.size, 50, 'opIds unique');
    for (let i = 1; i < ops.length; i++) {
      assert.ok(ops[i].seq > ops[i - 1].seq, 'seq strictly increasing');
    }
    assert.match(ops[0].opId, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-/,
      'UUIDv7 layout (version 7, variant 10)');
    // v7 is time-ordered, so lexicographic order matches authoring order.
    const sorted = [...ops].sort((a, b) => a.opId.localeCompare(b.opId));
    assert.deepEqual(sorted.map((o) => o.seq), ops.map((o) => o.seq), 'UUIDv7 sorts by time');
  });

  test('server-authoritative entities cannot be authored offline', async () => {
    const { engine } = makeEngine(new ScriptedTransport(allApplied));
    await assert.rejects(
      () => engine.enqueue({ entity: 'routine_slot' as never, payload: {} }),
      /cannot be authored offline/,
    );
  });
});

describe('flush — batching, ordering, idempotency', () => {
  test('sends in seq order, capped at batchSize per request', async () => {
    const t = new ScriptedTransport(allApplied);
    const { engine, store } = makeEngine(t, { batchSize: 10 });

    for (let i = 0; i < 25; i++) await engine.enqueue(attendance(`stu_${i}`));
    const result = await engine.flush();

    assert.equal(result.acked, 25);
    assert.equal(t.requests.length, 3, '25 ops / batch 10 → 3 requests');
    assert.equal(t.requests[0].ops.length, 10);
    assert.equal(t.requests[2].ops.length, 5);

    const sent = t.requests.flatMap((r) => r.ops.map((o) => o.seq));
    assert.deepEqual(sent, [...sent].sort((a, b) => a - b), 'author order preserved');
    assert.equal((await store.all()).length, 0, 'outbox drained');
  });

  test('a duplicate ack removes the op — replay after a reinstall is safe', async () => {
    const t = new ScriptedTransport((req) => ({
      serverTime: new Date(clock).toISOString(),
      results: req.ops.map((o) => ({ opId: o.opId, status: 'duplicate' as const })),
    }));
    const { engine, store } = makeEngine(t);
    await engine.enqueue(attendance('stu_1'));
    await engine.flush();
    assert.equal((await store.all()).length, 0, 'duplicate is an acknowledgement');
  });

  test('an op the server silently omits is retried, never dropped', async () => {
    const t = new ScriptedTransport((req) => ({
      serverTime: new Date(clock).toISOString(),
      // acknowledge only the first op; say nothing about the rest
      results: [{ opId: req.ops[0].opId, status: 'applied' as const }],
    }));
    const { engine, store } = makeEngine(t);
    for (let i = 0; i < 3; i++) await engine.enqueue(attendance(`stu_${i}`));
    await engine.flush();

    const left = await store.all();
    assert.equal(left.length, 2, 'unacknowledged ops survive');
    assert.ok(left.every((o) => o.status === 'pending'), 'and are re-armed for retry');
  });

  test('concurrent flushes are collapsed, not interleaved', async () => {
    let inFlight = 0;
    let maxConcurrent = 0;
    const t = new ScriptedTransport(async (req) => {
      inFlight++;
      maxConcurrent = Math.max(maxConcurrent, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return allApplied(req);
    });
    const { engine } = makeEngine(t);
    for (let i = 0; i < 5; i++) await engine.enqueue(attendance(`stu_${i}`));

    await Promise.all([engine.flush(), engine.flush(), engine.flush()]);
    assert.equal(maxConcurrent, 1, 'single-flight: two tabs must not both send');
  });
});

describe('backoff and the retry budget', () => {
  test('backoff grows, stays under the cap, and is jittered', async () => {
    const t = new ScriptedTransport(offline);
    const { engine, store } = makeEngine(t, { maxBackoffMs: 60_000 });
    await engine.enqueue(attendance('stu_1'));

    const delays: number[] = [];
    for (let i = 0; i < 8; i++) {
      const before = now();
      await engine.flush();
      const op = (await store.all())[0];
      if (!op || op.status === 'failed') break;
      delays.push(op.nextAttemptAt - before);
      advance(op.nextAttemptAt - before + 1);
    }

    assert.ok(delays.length >= 6, 'several retries observed');
    assert.ok(delays.every((d) => d >= 0 && d <= 60_000), 'never exceeds the cap');
    assert.ok(new Set(delays).size > 1, 'jittered, not a fixed ladder');
  });

  test('an op is not sent before its backoff has elapsed', async () => {
    const t = new ScriptedTransport(offline);
    const { engine, store } = makeEngine(t);
    await engine.enqueue(attendance('stu_1'));

    await engine.flush();
    const op = (await store.all())[0];
    assert.ok(op.nextAttemptAt > now(), 'scheduled into the future');

    const before = t.requests.length;
    await engine.flush(); // too early
    assert.equal(t.requests.length, before, 'no request issued before the deadline');
  });

  test('exhausting the retry budget parks the op as failed — it is never deleted', async () => {
    const t = new ScriptedTransport(offline);
    const { engine, store } = makeEngine(t, { maxAttempts: 3, maxBackoffMs: 1000 });
    await engine.enqueue(attendance('stu_1'));

    for (let i = 0; i < 5; i++) {
      await engine.flush();
      advance(2000);
    }

    const ops = await store.all();
    assert.equal(ops.length, 1, 'still present — an absence record must not vanish');
    assert.equal(ops[0].status, 'failed');
    assert.equal((await engine.state()).failed, 1);
  });

  test('user-triggered retry re-arms a failed op', async () => {
    let fail = true;
    const t = new ScriptedTransport((req) => (fail ? offline() : allApplied(req)));
    const { engine, store } = makeEngine(t, { maxAttempts: 2, maxBackoffMs: 100 });

    const op = await engine.enqueue(attendance('stu_1'));
    for (let i = 0; i < 3; i++) {
      await engine.flush();
      advance(500);
    }
    assert.equal((await store.get(op.opId))!.status, 'failed');

    fail = false;
    assert.equal(await engine.retry([op.opId]), 1);
    await engine.flush();
    assert.equal(await store.get(op.opId), undefined, 'delivered after retry');
  });
});

describe('conflicts follow the per-entity policy', () => {
  const conflictOn = (reason: string, serverValue: unknown = {}) =>
    new ScriptedTransport((req) => ({
      serverTime: new Date(clock).toISOString(),
      results: req.ops.map((o) => ({
        opId: o.opId,
        status: 'conflict' as const,
        conflict: { reason, serverValue, clientValue: o.payload },
      })),
    }));

  test('published marks: server wins and the local op is dropped', async () => {
    const { engine, store } = makeEngine(conflictOn('published_marks_immutable'));
    await engine.enqueue({ entity: 'exam_mark', payload: { cqMarks: 50 } });
    await engine.flush();
    assert.equal((await store.all()).length, 0, 'a published result is authoritative');
  });

  test('unpublished marks: parked for the teacher to resolve', async () => {
    const seen: OutboxOp[] = [];
    const { engine, store } = makeEngine(conflictOn('version_conflict'), {
      onConflict: (op: OutboxOp) => seen.push(op),
    });
    await engine.enqueue({ entity: 'exam_mark', payload: { cqMarks: 50 }, baseVersion: 2 });
    await engine.flush();

    const ops = await store.all();
    assert.equal(ops.length, 1);
    assert.equal(ops[0].status, 'conflict');
    assert.equal(ops[0].conflict?.resolution, 'ask_user');
    assert.equal(seen.length, 1, 'UI notified');
  });

  test('attendance after the SMS fired becomes a correction, not a mutation', async () => {
    const { engine, store } = makeEngine(conflictOn('already_notified'));
    const op = await engine.enqueue(attendance('stu_1', 'present'));
    engine.setConflictContext(op.opId, { smsAlreadySent: true });
    await engine.flush();

    const ops = await store.all();
    assert.equal(ops[0].conflict?.resolution, 'append_correction',
      'the parent was already told; history must show the correction');
  });

  test('attendance conflict resolves by newest write when no SMS has gone out', async () => {
    const older = new Date(clock - 60_000).toISOString();
    const { engine, store } = makeEngine(conflictOn('version_conflict', { deviceId: 'dev_other' }));
    const op = await engine.enqueue(attendance('stu_1'));
    engine.setConflictContext(op.opId, { smsAlreadySent: false, serverOccurredAt: older });
    await engine.flush();
    assert.equal((await store.all())[0].conflict?.resolution, 'client_wins');
  });

  test('discarding a conflict removes it ("take server\'s")', async () => {
    const { engine, store } = makeEngine(conflictOn('version_conflict'));
    const op = await engine.enqueue({ entity: 'exam_mark', payload: { cqMarks: 1 } });
    await engine.flush();
    await engine.discard(op.opId);
    assert.equal((await store.all()).length, 0);
  });

  test('a pending op cannot be discarded — only a settled one', async () => {
    const { engine, store } = makeEngine(new ScriptedTransport(offline));
    const op = await engine.enqueue(attendance('stu_1'));
    await engine.discard(op.opId);
    assert.equal((await store.all()).length, 1, 'unsent work is not discardable');
  });
});

describe('rejections', () => {
  const reject = (code: string, retryable: boolean) =>
    new ScriptedTransport((req) => ({
      serverTime: new Date(clock).toISOString(),
      results: req.ops.map((o) => ({
        opId: o.opId,
        status: 'rejected' as const,
        error: { code, retryable },
      })),
    }));

  test('non-retryable rejection parks the op with its reason', async () => {
    const { engine, store } = makeEngine(reject('SECTION_NOT_ASSIGNED', false));
    await engine.enqueue(attendance('stu_1'));
    await engine.flush();
    const op = (await store.all())[0];
    assert.equal(op.status, 'failed');
    assert.equal(op.lastError, 'SECTION_NOT_ASSIGNED');
  });

  test('retryable rejection is re-armed with backoff', async () => {
    const { engine, store } = makeEngine(reject('TENANT_LOCKED', true));
    await engine.enqueue(attendance('stu_1'));
    await engine.flush();
    const op = (await store.all())[0];
    assert.equal(op.status, 'pending');
    assert.ok(op.nextAttemptAt > now());
  });
});

describe('clock skew', () => {
  test('server-reported skew is applied to subsequent occurredAt values', async () => {
    const skewMs = 90_000; // device is 90 s fast
    const t = new ScriptedTransport((req) => ({ ...allApplied(req), clockSkewMs: skewMs }));
    const { engine } = makeEngine(t);

    await engine.enqueue(attendance('stu_1'));
    await engine.flush();
    assert.equal(engine.clockOffsetMs, skewMs);

    const corrected = await engine.enqueue(attendance('stu_2'));
    assert.equal(
      Date.parse(corrected.occurredAt),
      now() - skewMs,
      'later ops are stamped on the server-aligned clock',
    );
  });
});

describe('end-to-end: a teacher takes attendance with no signal', () => {
  test('60 students marked offline, synced when the tower comes back', async () => {
    let online = false;
    const t = new ScriptedTransport((req) => (online ? allApplied(req) : offline()));
    const { engine, store } = makeEngine(t, { batchSize: 25 });

    // 07:10, no signal — the whole section is marked.
    for (let roll = 1; roll <= 60; roll++) {
      await engine.enqueue(attendance(`stu_${roll}`, roll % 20 === 0 ? 'absent' : 'present'));
    }
    await engine.flush();
    assert.equal((await engine.state()).pending, 60, 'all work retained offline');
    assert.equal(t.requests.length, 1, 'one failed attempt, then it backed off');

    // 11:40, back on 2G.
    online = true;
    advance(4 * 60 * 60 * 1000);
    const res = await engine.flush();

    assert.equal(res.acked, 60, 'every record delivered');
    assert.equal((await store.all()).length, 0, 'outbox empty');
    assert.equal((await engine.state()).failed, 0);

    const delivered = t.requests.slice(1).flatMap((r) => r.ops.map((o) => o.payload));
    assert.equal(delivered.length, 60);
    assert.equal(new Set(delivered.map((p: never) => (p as { studentId: string }).studentId)).size, 60,
      'no duplicates, no omissions');
  });
});
