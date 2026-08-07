/**
 * POST /sync/push — the batch handler.
 *
 * Two properties matter more than anything else here:
 *
 * 1. IDEMPOTENCY. `sync_operations` has a PK on op_id and a UNIQUE on
 *    (tenant_id, device_id, device_seq). A client on 2G will resend a batch it
 *    already delivered; the insert is what detects that, not application logic.
 *
 * 2. PER-OP ISOLATION. Each op gets its own transaction. One malformed op in a
 *    batch of 25 must not roll back the other 24 — otherwise a single bad
 *    record could wedge a teacher's outbox permanently, and the retry would
 *    fail identically forever.
 */
import type pg from 'pg';
import type { Db, TenantContext } from './db.ts';
import { APPLIERS } from './appliers.ts';
import type {
  OutboxOp,
  PushRequest,
  PushResponse,
  PushResult,
} from '../../../packages/offline/src/types.ts';

export interface PushOptions {
  /** Guards against an unbounded batch from a hostile or buggy client. */
  maxOps?: number;
  now?: () => number;
}

export class SyncPushHandler {
  private readonly db: Db;
  private readonly maxOps: number;
  private readonly now: () => number;

  constructor(db: Db, opts: PushOptions = {}) {
    this.db = db;
    this.maxOps = opts.maxOps ?? 100;
    this.now = opts.now ?? Date.now;
  }

  async handle(req: PushRequest, ctx: TenantContext): Promise<PushResponse> {
    const serverNow = this.now();
    const results: PushResult[] = [];

    const ops = (req.ops ?? []).slice(0, this.maxOps);
    // Author order is the only correct application order: a mark entry can
    // depend on the session that preceded it.
    ops.sort((a, b) => a.seq - b.seq);

    for (const op of ops) {
      results.push(await this.applyOne(op, ctx, req.deviceId));
    }

    return {
      serverTime: new Date(serverNow).toISOString(),
      clockSkewMs: this.estimateSkew(req.clientTime, serverNow),
      results,
    };
  }

  /**
   * Client clock minus server clock. Cheap Android devices drift by minutes and
   * attendance conflict resolution compares client timestamps, so the client
   * re-stamps subsequent ops using this offset.
   */
  private estimateSkew(clientTime: string | undefined, serverNow: number): number | undefined {
    if (!clientTime) return undefined;
    const t = Date.parse(clientTime);
    return Number.isFinite(t) ? t - serverNow : undefined;
  }

  private async applyOne(op: OutboxOp, ctx: TenantContext, deviceId: string): Promise<PushResult> {
    // An op claiming a different tenant than the authenticated session is not a
    // conflict — it is an attack or a serious client bug. Never apply it.
    if (op.tenantId && op.tenantId !== ctx.tenantId) {
      return {
        opId: op.opId,
        status: 'rejected',
        error: { code: 'TENANT_MISMATCH', retryable: false },
      };
    }

    const applier = APPLIERS[op.entity];
    if (!applier) {
      return {
        opId: op.opId,
        status: 'rejected',
        error: { code: 'UNSUPPORTED_ENTITY', retryable: false, message: op.entity },
      };
    }

    try {
      return await this.db.withTenant(ctx, async (c) => {
        // ── Idempotency gate ──────────────────────────────────────────────
        // Claim the op id first. If the insert affects no rows we have seen it
        // before, and we return the recorded outcome without re-applying.
        const claim = await c.query(
          `INSERT INTO sync_operations
             (op_id, tenant_id, device_id, actor_id, device_seq, entity, operation,
              occurred_at, result)
           VALUES ($1, app.current_tenant(), $2, $3, $4, $5, $6, $7, 'applied')
           ON CONFLICT (op_id) DO NOTHING
           RETURNING op_id`,
          [op.opId, deviceId, ctx.userId, op.seq, op.entity, op.operation, op.occurredAt],
        );

        if (claim.rowCount === 0) {
          const prior = await c.query<{ result: string; conflict_detail: unknown }>(
            `SELECT result, conflict_detail FROM sync_operations WHERE op_id = $1`,
            [op.opId],
          );
          const r = prior.rows[0];
          if (r?.result === 'conflict') {
            return {
              opId: op.opId,
              status: 'conflict' as const,
              conflict: (r.conflict_detail ?? {
                reason: 'previously_conflicted',
                serverValue: null,
                clientValue: op.payload,
              }) as PushResult['conflict'],
            };
          }
          return { opId: op.opId, status: 'duplicate' as const };
        }

        // ── Apply ─────────────────────────────────────────────────────────
        const result = await applier(c, op);

        // Record the real outcome so a replay returns the same answer.
        await c.query(
          `UPDATE sync_operations
              SET result = $2, conflict_detail = $3
            WHERE op_id = $1`,
          [
            op.opId,
            result.status === 'applied' ? 'applied'
              : result.status === 'conflict' ? 'conflict'
              : 'rejected',
            result.conflict ? JSON.stringify(result.conflict) : null,
          ],
        );

        // A conflict or rejection must not leave partial writes behind, but the
        // sync_operations row has to survive so the replay is answered
        // consistently. Throwing here would roll both back, so instead the
        // applier is written to make no writes on those paths.
        return result;
      });
    } catch (err) {
      const e = err as { code?: string; message?: string };

      // 23P01 exclusion_violation — a routine clash reached us somehow.
      // 23505 unique_violation, 23503 FK violation: the client sent something
      // that cannot be applied as-is.
      if (e.code === '23P01' || e.code === '23505') {
        return {
          opId: op.opId,
          status: 'conflict',
          conflict: { reason: e.code === '23P01' ? 'clash' : 'duplicate_key', serverValue: null, clientValue: op.payload },
        };
      }
      if (e.code === '23503' || e.code === '23514' || e.code === '22P02') {
        return {
          opId: op.opId,
          status: 'rejected',
          error: { code: 'INVALID_REFERENCE', retryable: false, message: e.message },
        };
      }
      if (e.code === '42501') {
        return {
          opId: op.opId,
          status: 'rejected',
          error: { code: 'FORBIDDEN', retryable: false, message: e.message },
        };
      }

      // Anything else (connection dropped, deadlock, timeout) is transient by
      // assumption: retryable, so the client keeps the op rather than losing it.
      return {
        opId: op.opId,
        status: 'rejected',
        error: { code: e.code ?? 'INTERNAL', retryable: true, message: e.message },
      };
    }
  }
}
