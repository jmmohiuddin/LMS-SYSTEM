/**
 * GET /sync/pull — the change-feed handler, counterpart to SyncPushHandler.
 *
 * sync_change_log.id is one bigserial sequence shared across every scope, so
 * a single numeric cursor (not one per scope) is sufficient and correct: the
 * client just remembers the highest id it has consumed and asks for more.
 *
 * Each 'U' entry is resolved against the live table (SELECT *) rather than
 * trusting any snapshot in sync_change_log itself — the change log only
 * records that a row changed and its id, not its content. RLS on the
 * underlying table still applies, so a row a caller can no longer see (e.g.
 * transferred out of a section a subject teacher no longer teaches) is
 * silently dropped from the batch — same fail-closed behaviour as every
 * other read path in this system.
 */
import type pg from 'pg';
import type { Db, TenantContext } from './db.ts';

/** Whitelist only — scope strings are never interpolated directly into SQL. */
export const SCOPE_TABLES: Record<string, string> = {
  sections: 'sections',
  enrolments: 'enrolments',
  routineSlots: 'routine_slots',
};

export interface PullChange {
  scope: string;
  entityId: string;
  op: 'U' | 'D';
  data?: Record<string, unknown>;
}

export interface PullResponse {
  serverTime: string;
  changes: PullChange[];
  nextCursor: number;
  hasMore: boolean;
}

export interface PullOptions {
  limit?: number;
  now?: () => number;
}

export class SyncPullHandler {
  private readonly db: Db;
  private readonly defaultLimit: number;
  private readonly now: () => number;

  constructor(db: Db, opts: PullOptions = {}) {
    this.db = db;
    this.defaultLimit = opts.limit ?? 500;
    this.now = opts.now ?? Date.now;
  }

  async handle(
    params: { scopes: string[]; cursor: number; limit?: number },
    ctx: TenantContext,
  ): Promise<PullResponse> {
    const scopes = params.scopes;
    for (const scope of scopes) {
      if (!SCOPE_TABLES[scope]) {
        throw Object.assign(new Error(`unknown scope: ${scope}`), { code: 'UNKNOWN_SCOPE' });
      }
    }
    const limit = Math.min(params.limit ?? this.defaultLimit, 2000);
    const serverNow = this.now();

    const changes = await this.db.withTenant(ctx, async (c) => {
      const logRows = await c.query<{ id: string; scope: string; entity_id: string; op: 'U' | 'D' }>(
        `SELECT id, scope, entity_id, op FROM sync_change_log
          WHERE tenant_id = app.current_tenant() AND scope = ANY($1) AND id > $2
          ORDER BY id ASC LIMIT $3`,
        [scopes, params.cursor, limit],
      );

      const byScope = new Map<string, Set<string>>();
      for (const row of logRows.rows) {
        if (row.op !== 'U') continue;
        if (!byScope.has(row.scope)) byScope.set(row.scope, new Set());
        byScope.get(row.scope)!.add(row.entity_id);
      }

      const dataByScopeAndId = new Map<string, Map<string, Record<string, unknown>>>();
      for (const [scope, ids] of byScope) {
        const table = SCOPE_TABLES[scope];
        const rows = await this.fetchRows(c, table, [...ids]);
        const m = new Map<string, Record<string, unknown>>();
        for (const row of rows) m.set(String((row as { id: unknown }).id), row);
        dataByScopeAndId.set(scope, m);
      }

      const out: PullChange[] = [];
      for (const row of logRows.rows) {
        if (row.op === 'D') {
          out.push({ scope: row.scope, entityId: row.entity_id, op: 'D' });
          continue;
        }
        const data = dataByScopeAndId.get(row.scope)?.get(row.entity_id);
        // Row no longer visible under RLS (or since deleted) — nothing to ship.
        if (!data) continue;
        out.push({ scope: row.scope, entityId: row.entity_id, op: 'U', data });
      }

      const nextCursor = logRows.rows.length > 0 ? Number(logRows.rows[logRows.rows.length - 1].id) : params.cursor;
      return { out, nextCursor, hitLimit: logRows.rows.length === limit };
    });

    return {
      serverTime: new Date(serverNow).toISOString(),
      changes: changes.out,
      nextCursor: changes.nextCursor,
      hasMore: changes.hitLimit,
    };
  }

  private async fetchRows(c: pg.PoolClient, table: string, ids: string[]): Promise<Record<string, unknown>[]> {
    if (ids.length === 0) return [];
    // `table` only ever comes from the SCOPE_TABLES whitelist above.
    const { rows } = await c.query(`SELECT * FROM ${table} WHERE id = ANY($1)`, [ids]);
    return rows;
  }
}
