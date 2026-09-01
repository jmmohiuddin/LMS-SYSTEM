/**
 * Database access with mandatory tenant context — shared by every service.
 *
 * Identical contract to services/sync-svc/src/db.ts (see that file for the
 * full rationale on SET LOCAL vs SET under PgBouncer transaction pooling).
 * Kept as one copy here so identity/academics/sms/rms/finance don't drift.
 */
import pg from 'pg';
import { TenantBlocked, type TenantAccess } from './http.ts';

export { TenantBlocked, type TenantAccess };

/**
 * A calendar date is a calendar date, not an instant.
 *
 * `pg` parses a DATE column into a JS `Date` at the HOST's local midnight.
 * On a Dhaka machine `2025-07-28` becomes `2025-07-27T18:00:00Z`, and every
 * consumer that does `.toISOString().slice(0, 10)` — or ships the row as JSON
 * — then shows the day BEFORE. P7 found it on a billing due date, which is
 * precisely the kind of number a school will argue about.
 *
 * Nothing in this product ever wants a `Date` for a birthday, an exam day, an
 * attendance day or a due date; it wants the 'YYYY-MM-DD' the wire already
 * carries. So hand it back untouched. This is the same reason `time.ts`
 * exists — see `todayDhaka`.
 *
 * OID 1082 = DATE. Timestamps (1114/1184) keep their normal parsing: those
 * really are instants.
 */
pg.types.setTypeParser(1082, (v) => v);

export interface TenantContext {
  tenantId: string;
  userId: string;
  role: string;
  /**
   * Which purchasable service this request belongs to, if any.
   *
   * One of the codes in `service_catalogue` (migration 051). Set it on the
   * endpoints whose whole purpose IS that service, and the gate refuses the
   * request when a school has turned it off, never bought it, or has it in
   * maintenance — see migration 055.
   *
   * Deliberately absent from the school's own machinery: login, its branding,
   * its people, its class structure and its calendar of record are not
   * add-ons, and a service switch must never be able to lock a school out of
   * its own identity.
   */
  service?: string;
}

export interface Db {
  /**
   * Run inside one school's context, with the P7 gate applied.
   *
   * Pass `write: true` for anything that mutates — a read-only school is
   * refused, a suspended one is refused either way. `skipGate` exists for the
   * two callers that legitimately must run against a school the gate would
   * stop: the platform console (which has to inspect a suspended school in
   * order to un-suspend it) and the nightly maintenance cron.
   */
  withTenant<T>(
    ctx: TenantContext,
    fn: (c: pg.PoolClient) => Promise<T>,
    opts?: { write?: boolean; skipGate?: boolean },
  ): Promise<T>;
  /** What this school may do right now, without opening a transaction. */
  tenantAccess(tenantId: string): Promise<TenantAccess>;
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
    setup: (c: pg.PoolClient) => Promise<{ blocked?: TenantAccess } | void>,
    fn: (c: pg.PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await pool.connect();
    let readOnlyFor: TenantAccess | undefined;
    let released = false;
    try {
      await client.query('BEGIN');
      readOnlyFor = (await setup(client))?.blocked;
      const out = await fn(client);
      await client.query('COMMIT');
      return out;
    } catch (err) {
      // 25006 — `cannot execute INSERT in a read-only transaction`. The school
      // is limited, suspended or in maintenance and something tried to write.
      // Translate it here so the school reads a sentence about their account
      // rather than a PostgreSQL error class.
      if (readOnlyFor && (err as { code?: string })?.code === '25006') {
        try { await client.query('ROLLBACK'); } catch { /* already broken */ }
        client.release();
        released = true;
        throw new TenantBlocked(readOnlyFor);
      }
      try {
        await client.query('ROLLBACK');
      } catch {
        /* connection already broken; pool will discard it */
      }
      throw err;
    } finally {
      // `released` guards the 25006 branch above, which releases early so it
      // can throw a translated error rather than the driver's.
      if (!released) client.release();
    }
  }

  return {
    pool,

    async tenantAccess(tenantId) {
      return readAccess(pool, tenantId);
    },

    withTenant(ctx, fn, opts) {
      if (!ctx.tenantId) throw new Error('tenant context required');
      return inTx(async (c) => {
        let blocked: TenantAccess | undefined;
        await c.query(
          `SELECT set_config('app.tenant_id', $1, true),
                  set_config('app.user_id',   $2, true),
                  set_config('app.role',      $3, true)`,
          [ctx.tenantId, ctx.userId, ctx.role],
        );

        // The gate, on the connection this transaction already holds.
        //
        // Skipped only for the platform console and the maintenance cron —
        // see the interface. Every other caller is a school acting on itself,
        // and a suspended school acting on itself is the thing 052 exists to
        // stop.
        if (opts?.skipGate) return;
        const access = await readAccess(c, ctx.tenantId, ctx.role, ctx.service);
        if (access.access === 'none') throw new TenantBlocked(access);
        if (access.access === 'read_only') {
          // POSTGRES enforces it, not a flag every endpoint has to remember.
          // After this, any INSERT/UPDATE/DELETE in this transaction fails
          // with SQLSTATE 25006, which `inTx` turns back into this same
          // refusal — including writes nobody remembered were on a GET path.
          await c.query('SET LOCAL transaction_read_only = on');
          blocked = access;
          // The explicit flag still refuses EARLY, before the handler does
          // work it will have to throw away. It is an optimisation, not the
          // guarantee.
          if (opts?.write) throw new TenantBlocked(access);
        }
        return { blocked };
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
 * Ask the gate. One row, from the function 052 installed.
 *
 * Fails CLOSED: if the query errors — the migration has not run, the grant is
 * missing, the connection died — the answer is `none`. A gate that opens when
 * it cannot answer is not a gate, and the failure mode it would create is the
 * one P7-1 found: a suspended school that keeps working.
 */
async function readAccess(
  q: { query(sql: string, args?: unknown[]): Promise<{ rows: unknown[] }> },
  tenantId: string,
  role?: string,
  service?: string,
): Promise<TenantAccess> {
  try {
    // Two shapes of the same question. With a role, the answer also honours
    // the school's portal switches (migration 054) — a closed teacher portal
    // is 'none' for a teacher and untouched for the principal who has to
    // reopen it. Without one, it is the school-wide answer, which is what
    // the platform console and every cross-tenant report actually asks.
    const { rows } = role && service
      ? await q.query(
        `SELECT access, ops_state, billing_state, reason_bn, until
           FROM app.tenant_access($1, $2, $3)`,
        [tenantId, role, service],
      )
      : role
      ? await q.query(
        `SELECT access, ops_state, billing_state, reason_bn, until
           FROM app.tenant_access($1, $2)`,
        [tenantId, role],
      )
      : await q.query(
        `SELECT access, ops_state, billing_state, reason_bn, until
           FROM app.tenant_access($1)`,
        [tenantId],
      );
    const r = rows[0] as {
      access?: string; ops_state?: string; billing_state?: string;
      reason_bn?: string | null; until?: string | null;
    } | undefined;
    if (!r?.access) {
      return {
        access: 'none', opsState: 'unknown', billingState: 'unknown',
        reasonBn: 'এই প্রতিষ্ঠানটি খুঁজে পাওয়া যায়নি।', until: null,
      };
    }
    return {
      access: r.access as TenantAccess['access'],
      opsState: r.ops_state ?? 'unknown',
      billingState: r.billing_state ?? 'unknown',
      reasonBn: r.reason_bn ?? null,
      until: r.until ? String(r.until).slice(0, 10) : null,
    };
  } catch {
    return {
      access: 'none', opsState: 'unknown', billingState: 'unknown',
      reasonBn: 'প্রতিষ্ঠানের অবস্থা যাচাই করা যায়নি। একটু পরে আবার চেষ্টা করুন।',
      until: null,
    };
  }
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
