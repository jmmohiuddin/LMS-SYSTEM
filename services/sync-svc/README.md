# @shikhon/sync-svc

Server side of the offline sync protocol: `POST /sync/push`.
Pairs with [`@shikhon/offline`](../../packages/offline) — both import the same
protocol types, so the two halves cannot drift.

## The two properties that matter

**Idempotency.** A client on 2G resends batches it already delivered. The
`sync_operations` primary key on `op_id` (a client-generated UUIDv7) is what
detects that — not application logic. A replay returns the *original* outcome,
including if it was a conflict.

**Per-op isolation.** Each op runs in its own transaction. One malformed op in a
batch of 25 must not roll back the other 24 — otherwise a single bad record
wedges a teacher's outbox permanently, and every retry fails identically.

## Tenant context

Every statement runs inside `withTenant()`, which issues `SET LOCAL` (never
`SET`) inside an explicit transaction. Neon and PgBouncer use **transaction**
pooling, where a session-scoped GUC leaks to whichever request gets the
connection next. Verified against the live pooler — see
[docs/06-DEPLOYMENT.md](../../docs/06-DEPLOYMENT.md) §3.

`assertRlsEnforced()` is a boot guard: it refuses to start if the service is
connected as a BYPASSRLS or superuser role, because RLS would then be silently
unenforced — no error, just cross-tenant rows.

## Tests

```bash
DATABASE_URL=postgres://…  node --test test/push.test.ts test/e2e-client-server.test.ts
```

21 assertions against a **real** database — the properties under test
(idempotency, RLS isolation, `ON CONFLICT` merge semantics, published-mark
immutability) all live in PostgreSQL, so a mock would only assert that the mock
works. `test/e2e-client-server.test.ts` wires the real client `SyncEngine` to
the real handler with nothing stubbed but the HTTP hop.

The suite provisions its own tenant and deletes it in teardown, so it is safe
against any environment.

### Bugs these tests found

| Fix | Symptom it would have caused in production |
|---|---|
| [013](../../db/migrations/013_tenant_fk_integrity.sql) | Six tenant tables had no FK to `tenants`. Deleting a tenant orphaned 196 attendance records and 613 change-log rows — PDPA erasure would silently leave data behind. |
| [014](../../db/migrations/014_sync_log_delete_guard.sql) | With those FKs added, tenant deletion then *failed* outright: the sync-change trigger logged a row referencing the tenant being deleted. Erasure impossible. |
| [015](../../db/migrations/015_sync_operations_seq_reset.sql) | `UNIQUE (tenant_id, device_id, device_seq)` meant any device whose local counter reset — app reinstall, storage eviction on a 2 GB phone — collided forever and silently stopped syncing. |
