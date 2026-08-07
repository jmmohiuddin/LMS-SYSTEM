/**
 * Database access with mandatory tenant context.
 *
 * The single most important function in the service is `withTenant`. Every
 * statement that touches tenant data must run inside it, because:
 *
 *   * RLS is only enforced if `app.tenant_id` is set — and it fails CLOSED,
 *     so a missing context yields zero rows rather than everything.
 *   * PgBouncer/Neon run TRANSACTION pooling. `SET` (session-scoped) leaks the
 *     context to whichever request gets the connection next; `SET LOCAL` is
 *     released at COMMIT. This was verified against the live Neon pooler —
 *     see docs/06-DEPLOYMENT.md §3.
 *
 * Hence: SET LOCAL, always, inside an explicit transaction.
 */
import pg from 'pg';

export interface TenantContext {
  tenantId: string;
  userId: string;
  role: string;
}

export interface Db {
  withTenant<T>(ctx: TenantContext, fn: (c: pg.PoolClient) => Promise<T>): Promise<T>;
  /** For system-ingest paths (webhooks, OTP) that have no tenant yet. */
  withSystemRole<T>(role: string, fn: (c: pg.PoolClient) => Promise<T>): Promise<T>;
  end(): Promise<void>;
  readonly pool: pg.Pool;
}

export function createDb(connectionString: string, opts: pg.PoolConfig = {}): Db {
  const pool = new pg.Pool({
    connectionString,
    max: 10,
    idleTimeoutMillis: 30_000,
    // A 2G client can hang a request; do not let it hold a pooled connection.
    statement_timeout: 15_000,
    ...opts,
  });

  async function inTx<T>(
    setup: (c: pg.PoolClient) => Promise<void>,
    fn: (c: pg.PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await setup(client);
      const out = await fn(client);
      await client.query('COMMIT');
      return out;
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch {
        /* connection already broken; pool will discard it */
      }
      throw err;
    } finally {
      client.release();
    }
  }

  return {
    pool,

    withTenant(ctx, fn) {
      if (!ctx.tenantId) throw new Error('tenant context required');
      return inTx(async (c) => {
        // set_config(..., true) === SET LOCAL, but parameterised so a tenant id
        // can never be string-interpolated into DDL-ish SQL.
        await c.query(
          `SELECT set_config('app.tenant_id', $1, true),
                  set_config('app.user_id',   $2, true),
                  set_config('app.role',      $3, true)`,
          [ctx.tenantId, ctx.userId, ctx.role],
        );
      }, fn);
    },

    withSystemRole(role, fn) {
      return inTx(async (c) => {
        await c.query(`SELECT set_config('app.role', $1, true)`, [role]);
      }, fn);
    },

    end: () => pool.end(),
  };
}

/**
 * Boot guard. If the service ever connects as a BYPASSRLS role, every
 * tenant-isolation guarantee is silently void — no error, no warning, just
 * cross-tenant rows. Refuse to start instead.
 */
export async function assertRlsEnforced(db: Db): Promise<void> {
  const { rows } = await db.pool.query<{ rolname: string; rolbypassrls: boolean; rolsuper: boolean }>(
    `SELECT rolname, rolbypassrls, rolsuper FROM pg_roles WHERE rolname = current_user`,
  );
  const me = rows[0];
  if (!me) throw new Error('cannot resolve current_user');
  if (me.rolbypassrls || me.rolsuper) {
    throw new Error(
      `refusing to start: connected as "${me.rolname}" which has ` +
        `${me.rolsuper ? 'SUPERUSER' : 'BYPASSRLS'} — RLS would not be enforced. ` +
        `Connect as the non-privileged runtime role instead.`,
    );
  }
}
