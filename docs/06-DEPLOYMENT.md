# 06 — Deployment: Neon Postgres

The schema is deployed and verified on **Neon (PostgreSQL 18.4)**, region `ap-southeast-1`
(Singapore), project endpoint `ep-late-fog-azjd29xn`.

---

## 1. Where it lives, and why

The connection originally supplied pointed at the **`neondb`** database, which already contained
a complete (empty) schema for a **different product** — a field-service / job-dispatch SaaS
(`technicians`, `jobs`, `job_visits`, `quotes`, `contracts`, `properties`; defaults of
`country_code 'AE'`, `AED`, `Asia/Dubai`), with RLS on 38 of its 40 tables.

Four of its table names collide head-on with the LMS: **`tenants`, `users`, `invoices`,
`invoice_lines`**.

The LMS was therefore installed into a **separate database, `shikhon_lms`**, in the same Neon
project. `neondb` was left completely untouched.

| | Database | Contents |
|---|---|---|
| Untouched | `neondb` | Field-service SaaS schema, 40 tables, 0 rows |
| **LMS** | **`shikhon_lms`** | 88 tables, 103 RLS policies, 31 `app.*` functions, 3 exclusion constraints, 4 materialised views, 15 migrations |

---

## 2. Roles — and the one thing that must not be got wrong

`neondb_owner` has **`BYPASSRLS = true`**.

> **If the application connects as `neondb_owner`, every tenant-isolation guarantee in this
> system is silently void.** RLS is not enforced for a BYPASSRLS role — no error, no warning,
> just cross-tenant reads returning rows.

A dedicated login role was therefore created:

| Role | Login | BYPASSRLS | Purpose |
|---|---|---|---|
| `neondb_owner` | yes | **yes** | Migrations / DDL **only**. Never the application. |
| **`shikhon_runtime`** | **yes** | **no** | **The application connects as this.** Member of `shikhon_app`, inherits its grants and RLS policies. |
| `shikhon_app` | no | no | Privilege + policy holder. Not directly loginable. |
| `shikhon_platform` | no | yes | Super-admin break-glass. Audited to `audit.platform_access`. |
| `shikhon_readonly` | no | no | Reporting / BI. Still RLS-filtered. |

Verified empirically over a real TLS connection as `shikhon_runtime`:

```
current_user = shikhon_runtime, bypassrls = false
no tenant context            → 0 rows   (fail-closed)
correct tenant context       → 1 row
foreign tenant context       → 0 rows
```

---

## 3. Connection strings

Use the **direct** (non-pooled) endpoint for migrations, and the **pooled** endpoint for the
application.

```bash
# Migrations / DDL — direct endpoint, owner role
DATABASE_MIGRATION_URL="postgresql://neondb_owner:<owner-password>@ep-late-fog-azjd29xn.c-3.ap-southeast-1.aws.neon.tech/shikhon_lms?sslmode=require&channel_binding=require"

# Application runtime — pooled endpoint, non-BYPASSRLS role
DATABASE_URL="postgresql://shikhon_runtime:<runtime-password>@ep-late-fog-azjd29xn-pooler.c-3.ap-southeast-1.aws.neon.tech/shikhon_lms?sslmode=require"
```

The runtime password is **not stored in this repository**. Put it in your secret manager.
Rotation, the ledger, and the blast radius of every credential are in
[08-CREDENTIAL-ROTATION.md](08-CREDENTIAL-ROTATION.md). The short version:

```sql
ALTER ROLE shikhon_runtime PASSWORD '<new-password>';
```

Before any deploy, run the preflight — it refuses a missing, placeholder or
dangerously wrong secret (an owner-role `DATABASE_URL`, a connection string with
no `sslmode`, a `PII_MASTER_KEY_V2` set without `V1`) and never prints a value:

```bash
node scripts/check-secrets.mjs --env
```

### PII_MASTER_KEY_V1

F-101 seals every national ID and birth-registration number with this key.
Generate it with `openssl rand -base64 32`. Without it the identifier paths
ship dark (they refuse rather than storing anything in the clear), which is
safe — but board registration and MPO filing cannot work until it is set.

**Never replace `V1` in place.** Rotation is additive: add `V2`, sweep, and
retire `V1` only when no row reports `pii_key_version = 1`. Replacing it makes
every stored identifier permanently undecryptable, silently, until someone
tries to read one. Full procedure in
[08-CREDENTIAL-ROTATION.md §5](08-CREDENTIAL-ROTATION.md).

### Why the pooled endpoint is safe here

Neon's pooler runs PgBouncer in **transaction pooling** mode, where session-scoped GUCs leak
between clients. The tenant-context design ([01-ARCHITECTURE §4.1](01-ARCHITECTURE.md)) mandates
`SET LOCAL` precisely for this. That was tested against the live pooler:

```sql
BEGIN;
  SET LOCAL app.tenant_id = '…';   -- scoped to the transaction
  SELECT count(*) FROM users;       -- → 1
COMMIT;
SELECT count(*) FROM users;         -- → 0   context released
SELECT current_setting('app.tenant_id', true);   -- → empty
```

By contrast, plain `SET` (no `LOCAL`) **persists on the pooled session** and was confirmed to
keep returning rows after the transaction ended. That is the leak this design forbids.

> **Rule for every service:** open a transaction, `SET LOCAL app.tenant_id / app.user_id /
> app.role`, do the work, commit. Never `SET` without `LOCAL`. Never run a query outside a
> transaction that touches tenant data.

---

## 4. Applying migrations

**First, find out what is actually applied.** These migrations are not
idempotent and nothing records what has run, so "is production on 023?" is a
question that has to be answered by looking:

```bash
DATABASE_URL='postgresql://…' node scripts/migration-status.mjs --plan
```

Read-only, and the pooled runtime URL is enough — it needs no owner
credential. It probes each migration for a distinctive object created at the
*end* of that file, so a migration that died half-way reports MISSING rather
than applied. `--plan` prints the exact commands for whatever is pending.

It also refuses to give simple advice when the chain is out of order (a later
migration applied while an earlier one is not): the files are not idempotent,
so "just run the missing ones" can fail against a schema that has already
moved past them.

```bash
for f in db/migrations/*.sql; do
  psql "$DATABASE_MIGRATION_URL" -v ON_ERROR_STOP=1 -f "$f"
done
psql "$DATABASE_MIGRATION_URL" -v ON_ERROR_STOP=1 -f db/tests/schema_lint.sql
psql "$DATABASE_MIGRATION_URL" -v ON_ERROR_STOP=1 -f db/tests/invariants.sql
psql "$DATABASE_MIGRATION_URL" -v ON_ERROR_STOP=1 -f db/tests/e2e_academic_cycle.sql
```

All 15 migrations apply to an empty database with **zero errors and zero warnings**.

All three suites are **idempotent and self-cleaning** — they seed fixtures, assert, then tear
everything down and verify no fixture rows survive. Run twice back-to-back against `shikhon_lms`
they gave identical results and left `tenants = 0, users = 0, mfs_webhook_events = 0`, so they
are safe against any environment.

### Integrity migrations 013–015

Three defects were found by the `sync-svc` integration suite — all of which would have been
**silent** in production. They are worth understanding before operating this schema:

| Migration | Defect | What it would have cost |
|---|---|---|
| [013](../db/migrations/013_tenant_fk_integrity.sql) | Six tenant tables carried `tenant_id` with **no FK to `tenants`** | Deleting a tenant orphaned 196 `attendance_records` and 613 `sync_change_log` rows on the live database. RLS hides them forever, but they stay on disk — a **PDPA 2026 erasure request would have been quietly incomplete**. |
| [014](../db/migrations/014_sync_log_delete_guard.sql) | With those FKs in place, the sync-change trigger logged a row referencing the tenant being deleted | Tenant deletion then failed with `23503`. **Erasure became impossible** — the fix for 013 broke it the other way. |
| [015](../db/migrations/015_sync_operations_seq_reset.sql) | `UNIQUE (tenant_id, device_id, device_seq)` on `sync_operations` | `device_seq` lives in the device's own IndexedDB and restarts at 1 after a reinstall or storage eviction (routine on a 2 GB Android Go phone). Every op from that phone then collided forever and **attendance silently stopped uploading**, with no error the teacher could see. |

Lint rule **L8** in `db/tests/schema_lint.sql` now fails the build if any tenant table is added
without an FK to `tenants`, so 013 cannot regress.

### Rollback

```bash
for f in $(ls -r db/rollback/*.down.sql); do
  psql "$DATABASE_MIGRATION_URL" -v ON_ERROR_STOP=1 -f "$f"
done
```

Every down-file is **re-runnable**: a rollback interrupted partway can simply be run again.
That is not cosmetic — an interrupted rollback during this session left the database half-torn-down,
and the first versions of the 013–015 down-files failed against it. They are now guarded on the
catalog (`to_regclass`, `pg_constraint`, `pg_namespace`) rather than assuming a clean starting state.

The full **rollback → rollback → up** cycle was executed against `shikhon_lms`: the second rollback
pass is a no-op, `public` ends completely empty, and re-applying all 15 migrations afterwards passes
every suite again. CI repeats this on every change to `db/`.

---

## 5. Neon-specific notes

| Item | Status |
|---|---|
| `pgcrypto`, `citext`, `btree_gist`, `pg_trgm` | Installed |
| `vector` (pgvector **0.8.1**) | Installed — HNSW indexes on `nctb_chunks` and `question_items` built successfully |
| `pg_stat_statements` | Installed into a dedicated **`extensions`** schema, not `public` |
| `pg_cron` | Available (1.6) but **not enabled** — see scheduling below |
| `pg_partman` | Available (5.1.0) but not required; `app.maintain_partitions()` covers it |

**`pg_stat_statements` placement.** On managed Postgres the extension's *views* are owned by the
platform, so the blanket `GRANT … ON ALL TABLES IN SCHEMA public` in migration 010 emitted
`WARNING: no privileges were granted for "pg_stat_statements"`. Migration 001 now creates it in a
separate `extensions` schema, which removes the warning and keeps `public` to application objects
only.

**Scheduling.** Neon does not run background workers on a suspended compute, so `pg_cron` is
unreliable on autosuspending branches. Drive the three maintenance functions from an external
scheduler (GitHub Actions, Cloudflare Cron Triggers, or the `worker` service):

```sql
-- daily 01:00 BST
SELECT app.maintain_partitions();
-- daily 02:00 BST
SELECT app.purge_expired_data();
-- every 15 min
SELECT app.refresh_dashboards();
```

`app.maintain_partitions()` pre-creates three months ahead. Monitor
`v_default_partition_leakage` — any non-zero count means the job has stopped and inserts are
landing in the DEFAULT partition, which silently degrades every pruned query plan.

**Data residency caveat.** This deployment is in **Singapore (`ap-southeast-1`)**, not Bangladesh.
[01-ARCHITECTURE §1](01-ARCHITECTURE.md) specifies an in-country VPC for primary Postgres and all
PII-bearing storage, on PDPA 2026 grounds. Singapore is fine for development and staging; a
production rollout carrying real student NID/BRC data needs the residency question settled
before go-live.

---

## 6. Post-deploy checklist before real data lands

- [ ] Rotate the `neondb_owner` password — it was shared in plaintext over chat.
- [ ] Move both connection strings into a secret manager; nothing in the repo.
- [ ] Point the application at `shikhon_runtime` + the **pooled** endpoint; assert at boot that
      `SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user` returns `false` and refuse
      to start otherwise.
- [ ] Wire the three maintenance functions to an external scheduler.
- [x] ~~Seed per-tenant grading scales~~ — done by `app.provision_tenant()` (migration 012).
- [ ] Have a curriculum specialist verify the NCTB subject codes in migration 012 against the
      current board circular, then record the reference in `subject_catalogue.verified_against`.
- [ ] Provision KMS and populate `tenants.dek_wrapped` + `blind_index_pepper`; until then the
      NID/BRC columns must stay NULL.
- [ ] Decide the production data-residency region.

---

## 7. How this deploys, and the trap in it

**The API was returning 404 on every route in production, and had been since the
last hand-run `vercel --prod`.** Worth understanding before changing anything here.

`scripts/build.mjs` bundles each service into `api/v1/…​.js`, because Vercel's Node
builder only transpiles a function's own file and will not follow imports out into
`services/` or `packages/`. Those bundles were `.gitignore`d as generated output,
which is normally correct.

It is not correct here. **Vercel's Git-integration build decides which Serverless
Functions exist by looking at the cloned repository, before the build command
runs.** With `api/` ignored, the clone had no `api/` directory, Vercel created zero
functions, and the ten bundles written moments later were never part of the
deployment. The build log is the tell:

```
> node scripts/build.mjs
build complete — app.js + sw.js + 10 API bundles written
Build Completed in /vercel/output [3s]        ← 40ms later, no function phase
```

A working build has a second `Installing dependencies…` phase after that line —
`@vercel/node` compiling the functions it found. Confirm with
`vercel inspect <url>`: it lists `λ api/v1/…` per function, or nothing at all.

The site kept working because the PWA is static and served from
`outputDirectory`. Only the API vanished, and only on Git deploys — a hand-run
`vercel --prod` uploads the local `api/*.js` files and therefore works, which is
why the fault survived so long.

### What is in place now (stopgap)

The `api/` bundles are committed. Run `npm run build` and commit the result
whenever a service changes; CI fails if they drift
(`.github/workflows/frontend.yml`). `esbuild` is pinned to an exact version so
the bundles are byte-reproducible and that check stays meaningful.

The cost is ~0.9 MB of generated output per change in git history, most of it the
Anthropic SDK inside `api/v1/ai/[engine].js`.

### The replacement

Build and deploy from CI, so nothing generated is committed and nothing depends
on Vercel's file detection. Needs a `VERCEL_TOKEN` repository secret (Vercel →
Account Settings → Tokens); `VERCEL_ORG_ID` and `VERCEL_PROJECT_ID` are already in
`.vercel/project.json`. Then turn off Vercel's Git auto-deploy so the two do not
race, and add:

```yaml
name: deploy
on:
  push:
    branches: [main]
jobs:
  production:
    runs-on: ubuntu-latest
    env:
      VERCEL_ORG_ID: ${{ secrets.VERCEL_ORG_ID }}
      VERCEL_PROJECT_ID: ${{ secrets.VERCEL_PROJECT_ID }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '22' }
      - run: npm install --no-audit --no-fund
      - run: npx vercel pull --yes --environment=production --token=${{ secrets.VERCEL_TOKEN }}
      - run: npx vercel build --prod --token=${{ secrets.VERCEL_TOKEN }}
      - run: npx vercel deploy --prebuilt --prod --token=${{ secrets.VERCEL_TOKEN }}
```

`vercel build` runs on a checkout where `build.mjs` has already produced `api/`,
so the functions are found the same way they are when you deploy by hand. Once
this is live, re-ignore `api/` and delete the committed bundles.

**Whichever path you are on, check after deploying:**

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://shikhon-lms.vercel.app/api/v1/academics/next
```

`401` is healthy — the endpoint exists and is refusing an unauthenticated caller.
`404` means the functions did not deploy again.
