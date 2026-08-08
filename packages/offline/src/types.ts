/**
 * Offline-first sync types.
 *
 * Implements the outbox envelope and sync protocol specified in
 * docs/01-ARCHITECTURE.md §2.3–2.6 and docs/03-API-SPECIFICATIONS.md §1.
 *
 * The governing rule: the UI never awaits the network. Every mutation is
 * appended to the outbox and acknowledged locally; the network is a
 * background concern. An op is only ever removed once the server has
 * acknowledged it — "zero offline op loss" is an absolute SLO, not a target.
 */

/** Entities the client is allowed to author offline. */
export type Entity =
  | 'attendance_session'
  | 'attendance_record'
  | 'exam_mark'
  | 'answer_script'
  | 'class_delivery_log'
  | 'lesson_progress'
  | 'assignment_submission'
  | 'ai_chat_turn';

export type Operation = 'upsert' | 'delete';

export type OpStatus =
  | 'pending'   // waiting to be sent
  | 'inflight'  // sent, awaiting a response
  | 'conflict'  // server rejected on a version clash; needs user resolution
  | 'failed';   // permanently rejected, or retry budget exhausted

/**
 * One user mutation. `opId` is a client-generated UUIDv7 and doubles as the
 * server-side idempotency key: replaying the same op is a no-op, which is what
 * makes retrying over a flaky 2G link safe.
 */
export interface OutboxOp<P = unknown> {
  opId: string;
  /** Monotonic per device. Guarantees the server applies ops in author order. */
  seq: number;
  deviceId: string;
  tenantId: string;
  actorId: string;
  entity: Entity;
  operation: Operation;
  /** Client clock at authoring time, corrected by the last known skew. */
  occurredAt: string;
  /** Row version the client last saw; enables server-side conflict detection. */
  baseVersion?: number;
  payload: P;

  status: OpStatus;
  attempts: number;
  /** Epoch ms; the op is not eligible for sending before this. */
  nextAttemptAt: number;
  lastError?: string;
  conflict?: ConflictDetail;
}

export interface ConflictDetail {
  reason: string;
  serverValue: unknown;
  clientValue: unknown;
  /** How the policy resolved it — see conflict.ts. */
  resolution: ConflictResolution;
}

export type ConflictResolution =
  | 'server_wins'
  | 'client_wins'
  | 'ask_user'
  | 'append_correction'
  | 'merge';

/** Per-op outcome returned by POST /sync/push. */
export type PushResultStatus = 'applied' | 'duplicate' | 'conflict' | 'rejected';

export interface PushResult {
  opId: string;
  status: PushResultStatus;
  rowVersion?: number;
  sideEffects?: Record<string, number>;
  conflict?: Omit<ConflictDetail, 'resolution'> & { resolution?: ConflictResolution };
  error?: { code: string; retryable: boolean; message?: string };
}

export interface PushResponse {
  serverTime: string;
  /** Server's estimate of (client - server) in ms. Applied to future occurredAt. */
  clockSkewMs?: number;
  results: PushResult[];
}

export interface PushRequest {
  deviceId: string;
  clientTime: string;
  ops: OutboxOp[];
}

/** Transport is injected so the engine is testable without a network. */
export interface SyncTransport {
  push(req: PushRequest): Promise<PushResponse>;
}

export interface SyncEngineOptions {
  deviceId: string;
  tenantId: string;
  actorId: string;
  store: OutboxStore;
  transport: SyncTransport;
  /** Ops per batch. Default 25 — sized to one 2G MTU window (~28 KB gzipped). */
  batchSize?: number;
  /** Retry budget before an op is parked as `failed`. Default 12. */
  maxAttempts?: number;
  /** Backoff ceiling in ms. Default 15 min. */
  maxBackoffMs?: number;
  /** Injectable for deterministic tests. */
  now?: () => number;
  random?: () => number;
  onConflict?: (op: OutboxOp) => void;
  onFailed?: (op: OutboxOp) => void;
  onProgress?: (state: SyncState) => void;
}

export interface SyncState {
  pending: number;
  inflight: number;
  conflicts: number;
  failed: number;
  lastSyncAt?: number;
  lastError?: string;
}

/**
 * Storage abstraction. Deliberately not coupled to IndexedDB so the outbox
 * logic can be unit-tested headlessly and reused server-side if needed.
 */
export interface OutboxStore {
  append(op: OutboxOp): Promise<void>;
  /** Next monotonic seq for this device. */
  nextSeq(): Promise<number>;
  /** Oldest-first pending ops whose nextAttemptAt has elapsed. */
  claimBatch(limit: number, now: number): Promise<OutboxOp[]>;
  update(op: OutboxOp): Promise<void>;
  remove(opId: string): Promise<void>;
  byStatus(status: OpStatus): Promise<OutboxOp[]>;
  get(opId: string): Promise<OutboxOp | undefined>;
  all(): Promise<OutboxOp[]>;
  counts(): Promise<Record<OpStatus, number>>;
}
