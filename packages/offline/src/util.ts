/**
 * Primitives for the offline engine: UUIDv7, backoff, clock-skew correction.
 * All take injectable now()/random() so tests are deterministic.
 */

/**
 * UUIDv7 — time-ordered (RFC 9562).
 *
 * Chosen over v4 deliberately: op ids are also primary keys on
 * attendance_sessions / answer_scripts / class_delivery_log, and a
 * time-ordered key gives sequential B-tree inserts instead of scattering
 * writes across the index. On a 150M-row partitioned table that is the
 * difference between an append and constant page splits.
 *
 * Layout: 48-bit big-endian timestamp | ver(4) | 12 bits rand_a
 *         | var(2) | 62 bits rand_b
 */
export function uuidv7(now: () => number = Date.now, random: () => number = Math.random): string {
  const ts = Math.floor(now());
  const bytes = new Uint8Array(16);

  // 48-bit timestamp, big-endian
  bytes[0] = (ts / 2 ** 40) & 0xff;
  bytes[1] = (ts / 2 ** 32) & 0xff;
  bytes[2] = (ts / 2 ** 24) & 0xff;
  bytes[3] = (ts / 2 ** 16) & 0xff;
  bytes[4] = (ts / 2 ** 8) & 0xff;
  bytes[5] = ts & 0xff;

  for (let i = 6; i < 16; i++) bytes[i] = Math.floor(random() * 256) & 0xff;

  bytes[6] = (bytes[6] & 0x0f) | 0x70; // version 7
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 10

  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Exponential backoff with FULL jitter: delay = rand(0, min(cap, base * 2^n)).
 *
 * Full jitter rather than equal/decorrelated jitter because the failure mode we
 * care about is a whole school's devices coming back onto a flaky tower at the
 * same moment. Without jitter they retry in lockstep and re-collapse the link.
 */
export function backoffMs(
  attempts: number,
  opts: { baseMs?: number; maxMs?: number; random?: () => number } = {},
): number {
  const base = opts.baseMs ?? 1000;
  const cap = opts.maxMs ?? 15 * 60 * 1000;
  const random = opts.random ?? Math.random;
  const exp = Math.min(cap, base * 2 ** Math.max(0, attempts));
  return Math.floor(random() * exp);
}

/**
 * Clock-skew correction. Cheap Android devices routinely drift by minutes, and
 * conflict resolution compares client timestamps — so every occurredAt is
 * corrected by the server's observed offset before it is written.
 */
export class ClockSync {
  private skewMs = 0;
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  /** Record the offset the server reported (client − server, in ms). */
  observe(skewMs: number | undefined): void {
    if (typeof skewMs === 'number' && Number.isFinite(skewMs)) this.skewMs = skewMs;
  }

  get offsetMs(): number {
    return this.skewMs;
  }

  /** Server-aligned wall clock. */
  nowCorrected(): number {
    return this.now() - this.skewMs;
  }

  nowIso(): string {
    return new Date(this.nowCorrected()).toISOString();
  }
}

/**
 * Single-flight guard. Two tabs (or a tab and the service worker) must never
 * flush the outbox concurrently — that would send the same op twice and, worse,
 * interleave seq order. In the browser this is backed by navigator.locks; the
 * in-process mutex below is the fallback and what tests exercise.
 */
export class Mutex {
  private held = false;
  private readonly queue: Array<() => void> = [];

  async run<T>(fn: () => Promise<T>): Promise<T | undefined> {
    if (this.held) return undefined; // ifAvailable semantics: skip, don't queue
    this.held = true;
    try {
      return await fn();
    } finally {
      this.held = false;
      this.queue.shift()?.();
    }
  }

  get isHeld(): boolean {
    return this.held;
  }
}
