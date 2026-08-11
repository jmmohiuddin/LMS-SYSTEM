/**
 * Product event tracker  (F-1503, TRD §13)
 *
 * TRD §13.2: "Events batch and queue offline like any other mutation."
 * A student who studied on the bus reports a day of engagement in one
 * request when signal returns, and the client id on every event is what
 * lets the server count a retried batch once.
 *
 * Three properties, in order of importance:
 *
 * track() can never hurt the app. It writes to a localStorage queue and
 * returns; no await, no network, no exception escapes. Analytics that can
 * break a lesson screen would be removed within a week, correctly.
 *
 * The queue is bounded, and the bound is loud. At 500 events the oldest
 * are dropped and COUNTED, and the count travels with the next flush as
 * an offline.events_dropped event — "no silent truncation" applies to
 * ourselves first.
 *
 * Flushing trims by id, not by count. The server answers a replayed batch
 * with duplicates > 0; trimming "the first N" after a timeout would drop
 * events that never landed.
 */
import type { Auth } from './auth.ts';

export interface QueuedEvent {
  id: string;
  type: string;
  occurredAt: string;
  payload?: Record<string, unknown>;
}

export interface TrackerOptions {
  auth: Auth;
  storage?: Storage;
  now?: () => Date;
  /** Batch ceiling, matching the server's. */
  maxBatch?: number;
  /** Queue ceiling before oldest-first dropping begins. */
  maxQueue?: number;
}

const QUEUE_KEY = 'shikhon_event_queue';
const DROPPED_KEY = 'shikhon_events_dropped';
const ENDPOINT = '/api/v1/ops/events';

export class Tracker {
  private readonly o: Required<Pick<TrackerOptions, 'maxBatch' | 'maxQueue'>> & TrackerOptions;
  private flushing = false;

  constructor(options: TrackerOptions) {
    this.o = { maxBatch: 100, maxQueue: 500, ...options };
  }

  private get storage(): Storage {
    return this.o.storage ?? localStorage;
  }

  private read(): QueuedEvent[] {
    try {
      const raw = this.storage.getItem(QUEUE_KEY);
      const parsed = raw ? (JSON.parse(raw) as QueuedEvent[]) : [];
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  private write(queue: QueuedEvent[]): void {
    try { this.storage.setItem(QUEUE_KEY, JSON.stringify(queue)); } catch { /* quota */ }
  }

  /** Fire-and-forget. Never throws, never awaits the network. */
  track(type: string, payload?: Record<string, unknown>): void {
    try {
      const queue = this.read();
      queue.push({
        id: crypto.randomUUID(),
        type,
        occurredAt: (this.o.now?.() ?? new Date()).toISOString(),
        ...(payload ? { payload } : {}),
      });

      // Bounded, and the bound is counted. The dropped tally rides along
      // on the next successful flush rather than vanishing.
      let dropped = Number(this.storage.getItem(DROPPED_KEY) ?? 0);
      while (queue.length > this.o.maxQueue) {
        queue.shift();
        dropped++;
      }
      if (dropped > 0) {
        try { this.storage.setItem(DROPPED_KEY, String(dropped)); } catch { /* quota */ }
      }
      this.write(queue);
    } catch {
      /* analytics must never hurt the app */
    }
  }

  /**
   * Send what is queued. Safe to call on every app open and after every
   * outbox sync; overlapping calls collapse to one.
   */
  async flush(): Promise<void> {
    if (this.flushing) return;
    this.flushing = true;
    try {
      // Confess any drops first, so the gap in the data explains itself.
      const dropped = Number(this.storage.getItem(DROPPED_KEY) ?? 0);
      if (dropped > 0) {
        this.storage.removeItem(DROPPED_KEY);
        this.track('offline.events_dropped', { count: dropped });
      }

      let queue = this.read();
      while (queue.length > 0) {
        const batch = queue.slice(0, this.o.maxBatch);
        const res = await this.o.auth.authedFetch(ENDPOINT, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ events: batch }),
        });
        if (!res.ok) return;   // keep the queue; offline is normal here

        // Trim by id, never by count: only what the server acknowledged
        // leaves the queue.
        const sent = new Set(batch.map((e) => e.id));
        queue = this.read().filter((e) => !sent.has(e.id));
        this.write(queue);
      }
    } catch {
      /* the queue survives; next flush retries */
    } finally {
      this.flushing = false;
    }
  }

  /** For tests and the status screen. */
  pending(): number {
    return this.read().length;
  }
}
