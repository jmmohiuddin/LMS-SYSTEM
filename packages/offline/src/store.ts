/**
 * Outbox storage.
 *
 * MemoryOutboxStore     — reference implementation; used by tests and SSR.
 * IndexedDbOutboxStore  — browser implementation, object store `outbox`.
 *
 * Both uphold the same contract, and the contract is what the SLO rests on:
 *  * append is atomic and ordered by seq
 *  * claimBatch returns oldest-first, only ops whose backoff has elapsed
 *  * remove() is the ONLY way an op leaves the store, and the engine calls it
 *    exclusively on a server acknowledgement
 */
import type { OpStatus, OutboxOp, OutboxStore } from './types.ts';

export class MemoryOutboxStore implements OutboxStore {
  private readonly ops = new Map<string, OutboxOp>();
  private seq = 0;

  async nextSeq(): Promise<number> {
    return ++this.seq;
  }

  async append(op: OutboxOp): Promise<void> {
    if (this.ops.has(op.opId)) return; // idempotent append
    this.ops.set(op.opId, { ...op });
    if (op.seq > this.seq) this.seq = op.seq;
  }

  async claimBatch(limit: number, now: number): Promise<OutboxOp[]> {
    return [...this.ops.values()]
      .filter((o) => o.status === 'pending' && o.nextAttemptAt <= now)
      .sort((a, b) => a.seq - b.seq)
      .slice(0, limit)
      .map((o) => ({ ...o }));
  }

  async update(op: OutboxOp): Promise<void> {
    if (!this.ops.has(op.opId)) return;
    this.ops.set(op.opId, { ...op });
  }

  async remove(opId: string): Promise<void> {
    this.ops.delete(opId);
  }

  async get(opId: string): Promise<OutboxOp | undefined> {
    const o = this.ops.get(opId);
    return o ? { ...o } : undefined;
  }

  async byStatus(status: OpStatus): Promise<OutboxOp[]> {
    return [...this.ops.values()].filter((o) => o.status === status).sort((a, b) => a.seq - b.seq);
  }

  async all(): Promise<OutboxOp[]> {
    return [...this.ops.values()].sort((a, b) => a.seq - b.seq);
  }

  async counts(): Promise<Record<OpStatus, number>> {
    const c: Record<OpStatus, number> = { pending: 0, inflight: 0, conflict: 0, failed: 0 };
    for (const o of this.ops.values()) c[o.status]++;
    return c;
  }
}

/* ------------------------------------------------------------------------ */
/* IndexedDB                                                                 */
/* ------------------------------------------------------------------------ */

const DB_NAME = 'shikhon';
const DB_VERSION = 1;
const OUTBOX = 'outbox';
const META = 'meta';

/**
 * `name` is parameterised so tests can use an isolated database per case.
 * Deleting and reopening the same database blocks while other connections are
 * still open, which deadlocks a test run.
 */
export function openDb(indexedDB: IDBFactory, name: string = DB_NAME): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(name, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(OUTBOX)) {
        const s = db.createObjectStore(OUTBOX, { keyPath: 'opId' });
        // [status+seq] serves claimBatch directly: a range scan, no filtering.
        s.createIndex('status_seq', ['status', 'seq']);
        s.createIndex('seq', 'seq');
      }
      if (!db.objectStoreNames.contains(META)) db.createObjectStore(META, { keyPath: 'key' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

const promisify = <T>(req: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

export class IndexedDbOutboxStore implements OutboxStore {
  private readonly db: IDBDatabase;

  constructor(db: IDBDatabase) {
    this.db = db;
  }

  private tx(mode: IDBTransactionMode, store = OUTBOX): IDBObjectStore {
    return this.db.transaction(store, mode).objectStore(store);
  }

  async nextSeq(): Promise<number> {
    const store = this.tx('readwrite', META);
    const cur = (await promisify(store.get('seq'))) as { key: string; value: number } | undefined;
    const next = (cur?.value ?? 0) + 1;
    await promisify(store.put({ key: 'seq', value: next }));
    return next;
  }

  async append(op: OutboxOp): Promise<void> {
    // `add` (not `put`) so a duplicate opId cannot silently overwrite a
    // half-sent op. ConstraintError means we already have it: that is fine.
    try {
      await promisify(this.tx('readwrite').add(op));
    } catch (e) {
      if ((e as DOMException)?.name !== 'ConstraintError') throw e;
    }
  }

  async claimBatch(limit: number, now: number): Promise<OutboxOp[]> {
    const idx = this.tx('readonly').index('status_seq');
    const range = IDBKeyRange.bound(['pending', -Infinity], ['pending', Infinity]);
    const out: OutboxOp[] = [];
    await new Promise<void>((resolve, reject) => {
      const req = idx.openCursor(range);
      req.onsuccess = () => {
        const cur = req.result;
        if (!cur || out.length >= limit) return resolve();
        const op = cur.value as OutboxOp;
        if (op.nextAttemptAt <= now) out.push(op);
        cur.continue();
      };
      req.onerror = () => reject(req.error);
    });
    return out;
  }

  async update(op: OutboxOp): Promise<void> {
    await promisify(this.tx('readwrite').put(op));
  }

  async remove(opId: string): Promise<void> {
    await promisify(this.tx('readwrite').delete(opId));
  }

  async get(opId: string): Promise<OutboxOp | undefined> {
    return (await promisify(this.tx('readonly').get(opId))) as OutboxOp | undefined;
  }

  async byStatus(status: OpStatus): Promise<OutboxOp[]> {
    const all = await this.all();
    return all.filter((o) => o.status === status);
  }

  async all(): Promise<OutboxOp[]> {
    const all = (await promisify(this.tx('readonly').getAll())) as OutboxOp[];
    return all.sort((a, b) => a.seq - b.seq);
  }

  async counts(): Promise<Record<OpStatus, number>> {
    const c: Record<OpStatus, number> = { pending: 0, inflight: 0, conflict: 0, failed: 0 };
    for (const o of await this.all()) c[o.status]++;
    return c;
  }
}
