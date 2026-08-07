/**
 * Database access with mandatory tenant context — shared by every service.
 *
 * Identical contract to services/sync-svc/src/db.ts (see that file for the
 * full rationale on SET LOCAL vs SET under PgBouncer transaction pooling).
 * Kept as one copy here so identity/academics/sms/rms/finance don't drift.
 */
import pg from 'pg';

export interface TenantContext {
  tenantId: string;
  userId: string;
  role: string;
}

export interface Db {
  withTenant<T>(ctx: TenantContext, fn: (c: pg.PoolClient) => Promise<T>): Promise<T>;
  /** For system-ingest paths (webhooks, OTP, login lookup) with no tenant yet. */
  withSystemRole<T>(role: string, fn: (c: pg.PoolClient) => Promise<T>): Promise<T>;
  end(): Promise<void>;
  readonly pool: pg.Pool;
}

export function createDb(connectionString: string, opts: pg.PoolConfig = {}): Db {
  const pool = new pg.Pool({
    connectionString,
    max: 10,
    idleTimeoutMillis: 30_000,
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

let _db: Db | null = null;

/** Singleton pool reused across warm Vercel invocations. */
export async function sharedDb(): Promise<Db> {
  if (_db) return _db;
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL env var is not set');
  const db = createDb(url, { max: 5 });
  await assertRlsEnforced(db);
  _db = db;
  return db;
}
