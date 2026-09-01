/**
 * Database access with mandatory tenant context — the SAME implementation
 * every other service uses, not a copy of it.
 *
 * ── Why this file is now four lines ─────────────────────────────────────
 * It used to hold its own `createDb`, described in its own header as having
 * an "identical contract" to `packages/server-core/src/db.ts`. The contract
 * was identical right up until it wasn't: P7 put the tenant gate in
 * server-core's `withTenant` — suspended, limited, maintenance, closed
 * portals, disabled services — and sync-svc, holding its own copy, enforced
 * none of it.
 *
 * That was the widest hole in the whole scheme. Sync is not a minor path: it
 * is how attendance, exam marks, assignment submissions and lesson progress
 * are actually WRITTEN, from phones, in bulk, hours after the fact. A school
 * suspended for non-payment would have gone on filing a week of rolls
 * through it, and the console would have said the school was stopped.
 *
 * Two copies of a security-critical function is one copy too many. There is
 * now one, and this file is the seam that says so.
 *
 * The original rationale for SET LOCAL over SET under PgBouncer transaction
 * pooling — verified against the live Neon pooler, docs/06-DEPLOYMENT.md §3 —
 * lives with the implementation in server-core.
 */
export {
  createDb,
  assertRlsEnforced,
  sharedDb,
  TenantBlocked,
  type Db,
  type TenantContext,
  type TenantAccess,
} from '../../../packages/server-core/src/db.ts';
