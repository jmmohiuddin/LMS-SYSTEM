/**
 * The outbox flush loop.
 *
 * Contract (docs/01-ARCHITECTURE.md §2.3):
 *   1. enqueue() returns as soon as the op is durable locally. It never awaits
 *      the network, and it never throws because the network is down.
 *   2. An op is removed ONLY on an explicit server acknowledgement
 *      (applied | duplicate). Everything else keeps it in the store.
 *   3. Flushing is single-flight: two tabs must not send the same batch.
 */
import { assertClientAuthorable, resolveConflict, type ConflictContext } from './conflict.ts';
import type {
  Entity,
  Operation,
  OutboxOp,
  PushResult,
  SyncEngineOptions,
  SyncState,
} from './types.ts';
import { backoffMs, ClockSync, Mutex, uuidv7 } from './util.ts';

export interface EnqueueInput<P = unknown> {
  entity: Entity;
  operation?: Operation;
  payload: P;
  baseVersion?: number;
  /** Supply to make the op id deterministic (e.g. attendance_session id). */
  opId?: string;
}

export class SyncEngine {
  private readonly o: Required<
    Pick<SyncEngineOptions, 'batchSize' | 'maxAttempts' | 'maxBackoffMs'>
  > &
    SyncEngineOptions;
  private readonly clock: ClockSync;
  private readonly mutex = new Mutex();
  private readonly conflictCtx = new Map<string, ConflictContext>();
  private lastSyncAt?: number;
  private lastError?: string;

  constructor(options: SyncEngineOptions) {
    this.o = {
      batchSize: 25,
      maxAttempts: 12,
      maxBackoffMs: 15 * 60 * 1000,
      ...options,
    };
    this.clock = new ClockSync(this.o.now ?? Date.now);
  }

  private get now(): number {
    return (this.o.now ?? Date.now)();
  }
  private get random(): () => number {
    return this.o.random ?? Math.random;
  }

  /** Context the conflict policy needs but the server response doesn't carry. */
  setConflictContext(opId: string, ctx: ConflictContext): void {
    this.conflictCtx.set(opId, ctx);
  }

  /**
   * Append a mutation. Resolves once it is durable locally — typically <5 ms,
   * with no network involved. This is what makes "save attendance" feel
   * instant on a 2 GB phone with no signal.
   */
  async enqueue<P>(input: EnqueueInput<P>): Promise<OutboxOp<P>> {
    assertClientAuthorable(input.entity);

    const op: OutboxOp<P> = {
      opId: input.opId ?? uuidv7(() => this.now, this.random),
      seq: await this.o.store.nextSeq(),
      deviceId: this.o.deviceId,
      tenantId: this.o.tenantId,
      actorId: this.o.actorId,
      entity: input.entity,
      operation: input.operation ?? 'upsert',
      occurredAt: this.clock.nowIso(),
      baseVersion: input.baseVersion,
      payload: input.payload,
      status: 'pending',
      attempts: 0,
      nextAttemptAt: 0,
    };

    await this.o.store.append(op as OutboxOp);
    await this.emit();
    return op;
  }

  /**
   * Drain the outbox. Safe to call at any time and from anywhere — concurrent
   * calls are collapsed by the mutex rather than queued, matching
   * navigator.locks `ifAvailable` semantics.
   *
   * Never throws: a transport failure is a normal condition offline, and a
   * throwing flush would surface as an unhandled rejection in a Background
   * Sync handler.
   */
  async flush(): Promise<{ sent: number; acked: number; rounds: number }> {
    const res = await this.mutex.run(() => this.drain());
    return res ?? { sent: 0, acked: 0, rounds: 0 };
  }

  private async drain(): Promise<{ sent: number; acked: number; rounds: number }> {
    let sent = 0;
    let acked = 0;
    let rounds = 0;

    for (;;) {
      const batch = await this.o.store.claimBatch(this.o.batchSize, this.now);
      if (batch.length === 0) break;
      rounds++;

      for (const op of batch) {
        op.status = 'inflight';
        await this.o.store.update(op);
      }

      let response;
      try {
        response = await this.o.transport.push({
          deviceId: this.o.deviceId,
          clientTime: new Date(this.now).toISOString(),
          ops: batch,
        });
      } catch (err) {
        // Transport failure: every op goes back to pending with backoff.
        // Nothing is dropped — that is the whole point.
        this.lastError = err instanceof Error ? err.message : String(err);
        await this.backoffAll(batch, this.lastError);
        await this.emit();
        return { sent, acked, rounds };
      }

      sent += batch.length;
      this.clock.observe(response.clockSkewMs);
      this.lastSyncAt = this.now;
      this.lastError = undefined;

      const byId = new Map(batch.map((o) => [o.opId, o]));
      const seen = new Set<string>();

      for (const r of response.results) {
        const op = byId.get(r.opId);
        if (!op) continue; // result for an op we didn't send — ignore
        seen.add(r.opId);
        if (await this.applyResult(op, r)) acked++;
      }

      // Any op the server didn't mention is NOT assumed delivered.
      for (const op of batch) {
        if (seen.has(op.opId)) continue;
        await this.backoffOne(op, 'no result returned for op');
      }

      await this.emit();
      if (batch.length < this.o.batchSize) break;
    }

    return { sent, acked, rounds };
  }

  /** @returns true if the op left the outbox. */
  private async applyResult(op: OutboxOp, r: PushResult): Promise<boolean> {
    switch (r.status) {
      case 'applied':
      case 'duplicate':
        await this.o.store.remove(op.opId);
        this.conflictCtx.delete(op.opId);
        return true;

      case 'conflict': {
        const resolution = resolveConflict(op, r, this.conflictCtx.get(op.opId) ?? {});
        // server_wins / merge are settled: the server already holds the truth,
        // so the local op has nothing left to do.
        if (resolution === 'server_wins' || resolution === 'merge') {
          await this.o.store.remove(op.opId);
          this.conflictCtx.delete(op.opId);
          return true;
        }
        // client_wins / append_correction / ask_user all need another action,
        // so the op is parked where the UI can find it.
        op.status = 'conflict';
        op.conflict = {
          reason: r.conflict?.reason ?? 'version_conflict',
          serverValue: r.conflict?.serverValue,
          clientValue: r.conflict?.clientValue ?? op.payload,
          resolution,
        };
        await this.o.store.update(op);
        this.o.onConflict?.(op);
        return false;
      }

      case 'rejected': {
        if (r.error?.retryable) {
          await this.backoffOne(op, r.error.code);
          return false;
        }
        op.status = 'failed';
        op.lastError = r.error?.code ?? 'rejected';
        await this.o.store.update(op);
        this.o.onFailed?.(op);
        return false;
      }
    }
  }

  private async backoffAll(ops: OutboxOp[], reason: string): Promise<void> {
    for (const op of ops) await this.backoffOne(op, reason);
  }

  private async backoffOne(op: OutboxOp, reason: string): Promise<void> {
    op.attempts += 1;
    op.lastError = reason;

    if (op.attempts >= this.o.maxAttempts) {
      // Parked, NOT deleted. The UI offers retry and export-to-file; an
      // attendance record that vanishes is a parent who was never told.
      op.status = 'failed';
      await this.o.store.update(op);
      this.o.onFailed?.(op);
      return;
    }

    op.status = 'pending';
    op.nextAttemptAt =
      this.now + backoffMs(op.attempts, { maxMs: this.o.maxBackoffMs, random: this.random });
    await this.o.store.update(op);
  }

  /** Re-arm ops the user chose to retry (or resolved a conflict on). */
  async retry(opIds: string[]): Promise<number> {
    let n = 0;
    for (const id of opIds) {
      const op = await this.o.store.get(id);
      if (!op || (op.status !== 'failed' && op.status !== 'conflict')) continue;
      op.status = 'pending';
      op.attempts = 0;
      op.nextAttemptAt = 0;
      op.conflict = undefined;
      op.lastError = undefined;
      await this.o.store.update(op);
      n++;
    }
    await this.emit();
    return n;
  }

  /** Explicit user action: discard a conflicted/failed op ("take server's"). */
  async discard(opId: string): Promise<void> {
    const op = await this.o.store.get(opId);
    if (!op || op.status === 'pending' || op.status === 'inflight') return;
    await this.o.store.remove(opId);
    this.conflictCtx.delete(opId);
    await this.emit();
  }

  async state(): Promise<SyncState> {
    const c = await this.o.store.counts();
    return {
      pending: c.pending,
      inflight: c.inflight,
      conflicts: c.conflict,
      failed: c.failed,
      lastSyncAt: this.lastSyncAt,
      lastError: this.lastError,
    };
  }

  get clockOffsetMs(): number {
    return this.clock.offsetMs;
  }

  private async emit(): Promise<void> {
    if (this.o.onProgress) this.o.onProgress(await this.state());
  }
}
