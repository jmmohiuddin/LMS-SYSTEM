# Bringing production from migration 048 to 064

**Status: written and rehearsed locally. NOT YET RUN against production.**

This is M2 of P-pilot-hardening. Production has been serving from migration
048 since 2026-08-31 while the repository moved to 064 — sixteen migrations,
covering P5's guardianship revocation, all of P7's platform operations, P8's
calendar and lint repairs, and this phase's staff register.

Read [§0](#0-the-hazard) before scheduling anything.

---

## 0. The hazard

**Migrations 049–063 must not be left applied without 064.**

Migration 050 replaced the `guardianships` unique constraint with a partial
index (`WHERE revoked_at IS NULL`) and did not update
`app.set_guardian_permissions`, which upserts through it with a bare column
list. PostgreSQL will not infer a partial index that way, so from 050 until
064 every guardian-link write raises:

```
ERROR: there is no unique or exclusion constraint matching the
       ON CONFLICT specification
```

That is the whole guardian path — adding a guardian to a student, changing a
relation, moving `is_primary`, and setting the `receives_sms` / `can_pay_fees`
flags that decide who receives the absence SMS and who may pay a fee.

Production is on 048 and therefore still **works today**. It would break the
moment a catch-up stopped anywhere between 050 and 063. Three CI suites caught
this on the first run and had been failing since 050; nothing local ran them,
because `npm test` did not include `db/tests/*.sql` until this phase.

**Consequence for this procedure:** the range 049–064 is one unit of work. If
it cannot be completed, roll back to 048. Do not leave production part-way.

---

## 1. What is being applied

| # | Migration | What it changes | Data risk |
|---|---|---|---|
| 049 | `student_day` | student-facing day view | none — read paths |
| 050 | `guardianship_revocation` | `revoked_at`; both unique constraints become partial | **see §0** |
| 051 | `platform_operations` | platform operation + payment ledgers | new tables |
| 052 | `platform_enforcement` | billing lifecycle derived, suspension gate | changes access decisions |
| 053 | `platform_overview` | SECURITY DEFINER console reads | none |
| 054 | `portal_gate` | per-role portal closure | changes access decisions |
| 055 | `service_gate` | per-service enablement | changes access decisions |
| 056 | `portal_of_system` | `system_ingest` is not a teacher | **fixes** a lockout in 054 |
| 057 | `platform_activity` | last-actually-used, from sessions | none |
| 058 | `service_dependency_integrity` | catalogue FK | none |
| 059 | `dhaka_calendar_dates` | `app.today_dhaka()`; 14 date comparisons | **changes recorded dates** |
| 060 | `explicit_grace_is_authoritative` | operator grace beats plan default | changes access decisions |
| 061 | `p7_schema_lint_repairs` | FORCE RLS on two P7 tables | tightens |
| 062 | `drop_redundant_indexes` | drops two duplicate indexes | none |
| 063 | `teacher_attendance` | staff register + `app.teacher_absent_on()` | new table |
| 064 | `guardian_link_conflict_target` | repairs 050 | **see §0** |

054, 055, 060 and 052 all change what the gate answers. A school that is
suspended, past due, or has a portal closed will notice immediately. Check
`tenant_operations` and the plan state for every live tenant **before**
applying, so nothing is switched off by a default.

059 is the one that changes data semantics rather than structure: dates
recorded after it are Dhaka dates. Rows written before it, on a UTC server
between midnight and 06:00, may name the previous day. It does not rewrite
history, and it should not — see the migration header.

---

## 2. Preflight (the day before)

```bash
node scripts/preflight.mjs
```

Then, by hand:

- [ ] `git log -1` on the host matches the revision you intend to serve.
      **The revision serving traffic, not the one you pushed.**
- [ ] `docs/production-evidence.json` has a `backup_configured` entry that has
      not lapsed (180 days), and the last nightly dump exists and is non-trivial:
      `ls -lh /var/backups/shikhon | tail -3`
- [ ] `DATABASE_MIGRATION_URL` is the **owner** role on the **direct**
      endpoint. The runtime role has no DDL rights, and a pooler's transaction
      pooling breaks session-scoped DDL.
- [ ] A maintenance window agreed with any school already using the system.
      Attendance keeps working offline and queues, so a short window is not a
      data-loss event — say so.
- [ ] The rollback files for 049–064 are present: `ls db/rollback/0[5-6]*.sql`
      should list 16 files.

Rehearsed locally on 2026-09-02: all 64 migrations apply to an empty database
silently; all 26 SQL suites pass; up → down → up over all 63 rollback files
leaves zero objects in `public` and re-applies clean.

---

## 3. Back up, and prove the backup

A backup you have not restored is a hope.

```bash
# on the host
sudo -u postgres pg_dump -Fc shikhon_lms > /var/backups/shikhon/pre-064-$(date +%F-%H%M).dump
ls -lh /var/backups/shikhon/pre-064-*.dump
```

Then restore it **into a scratch database on the same host** and compare — do
not skip this because the nightly job exists:

```bash
DRILL_SOURCE_URL="$DATABASE_MIGRATION_URL" \
DRILL_ADMIN_URL="$DATABASE_MIGRATION_URL" \
DRILL_ENVIRONMENT=production \
  node scripts/restore-drill.mjs
```

- [ ] Restore drill passed, with the per-tenant row counts identical.
- [ ] The dump file's size is recorded here: ______________

---

## 4. Apply

In order, stopping on the first error. Nothing here is idempotent — every
`CREATE TABLE` and `CREATE TYPE` is unguarded — so a partial run must be
rolled back, not retried.

```bash
set -euo pipefail
for f in db/migrations/{049,050,051,052,053,054,055,056,057,058,059,060,061,062,063,064}_*.sql; do
  echo "--- $(basename "$f")"
  psql "$DATABASE_MIGRATION_URL" -v ON_ERROR_STOP=1 -q -f "$f"
done
```

If any file fails: go to §7 immediately. Do not attempt the next file, and do
not stop at 063 — see §0.

---

## 5. Verify the schema, before verifying the app

```bash
DATABASE_URL="$DATABASE_APP_URL" node scripts/migration-status.mjs
psql "$DATABASE_MIGRATION_URL" -v ON_ERROR_STOP=1 -q -f db/tests/schema_lint.sql
```

- [ ] `migration-status` reports **64/64 applied**.
- [ ] Schema lint prints `PASS schema lint`.
- [ ] Every table carrying `tenant_id` has RLS enabled **and forced**:

```sql
SELECT count(*) FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'tenant_id'
                     AND NOT a.attisdropped
 WHERE n.nspname = 'public' AND c.relkind IN ('r','p')
   AND (NOT c.relrowsecurity OR NOT c.relforcerowsecurity);
-- must be 0
```

- [ ] The 064 repair is actually in place:

```sql
SELECT pg_get_functiondef(oid) LIKE '%WHERE revoked_at IS NULL DO UPDATE%'
  FROM pg_proc WHERE proname = 'set_guardian_permissions';
-- must be t
```

Do **not** run `db/tests/*.sql` against production. They seed and delete
tenants.

---

## 6. Verify the application

Against the live host, in this order — each answers a different question.

```bash
BASE=https://sikhon.systems node scripts/security-probe.mjs      # 29 checks
```

- [ ] Security probe: 29/29.
- [ ] `curl -s https://sikhon.systems/ | git hash-object --stdin` is
      `496199bde2d10ace3e659e7fe9933962646d9e1f` — the landing page is frozen
      and must be byte-identical. *(Verified 2026-09-02: it is.)*
- [ ] `curl -sS https://sikhon.systems/api/v1/ops/brand?slug=does-not-exist`
      returns the generic signboard, `tenantId: null`, no school list.
- [ ] `curl -o /dev/null -w '%{http_code}' https://sikhon.systems/api/v1/ops/staff-attendance`
      returns **401**, not 404. A 404 means 063's endpoint is not deployed —
      the migrations went out without the code.
- [ ] Sign in as a real principal and open: home, the student roll, the staff
      register, and one school's branding. Nothing shows a raw UUID,
      `undefined`, or an English error.
- [ ] Tenant isolation, live: two tenants, one session each, and A cannot see
      B. `prod_cross_tenant` in `production-evidence.json` records where this
      was last observed and in which environment.
- [ ] The platform console lists the schools, and a suspension takes effect —
      052/054/055 changed what the gate answers, and this is the check that
      catches a school switched off by a default.
- [ ] Guardian linking works. This is the one 064 exists for, and it is the
      one nothing else in this list would notice:
      link a guardian to a test student through the UI, change the relation,
      and move `is_primary`.

---

## 7. Rollback

Descending, and past 050 — see §0. Rolling back to 049 leaves guardian
linking broken.

```bash
set -euo pipefail
for f in $(ls -r db/rollback/{049,050,051,052,053,054,055,056,057,058,059,060,061,062,063,064}_*.sql); do
  echo "--- $(basename "$f")"
  psql "$DATABASE_MIGRATION_URL" -v ON_ERROR_STOP=1 -q -f "$f"
done
```

`db/rollback/063_teacher_attendance.sql` **drops the staff register**, and
`050`'s rollback drops `revoked_at`. Both destroy data recorded since the
deploy. That is why §3's dump is taken first and why the window is short.

If the rollback itself fails, restore §3's dump into a scratch database,
verify it, and only then swap. Never restore over the live database.

Rehearsed 2026-09-02: the full descending chain over all 63 rollback files
runs clean and leaves zero objects in `public`. It has never been run against
production.

---

## 8. After

- [ ] Record the deployed revision and `64/64` in
      [12-PRODUCTION-RUNBOOK.md](12-PRODUCTION-RUNBOOK.md).
- [ ] Re-drill restore **after** the catch-up, not only before:
      `docs/production-evidence.json → restore_drill` becomes a fact about a
      64-migration schema, and the entry before it was about a 48-migration one.
- [ ] Fire the monitor once and confirm it reaches a person:
      `curl -X POST -H "Authorization: Bearer $SERVICE_API_KEY" https://sikhon.systems/api/v1/ops/monitor`
      then record `alert_delivered` with the handset observation.
      `scripts/alert-rehearsal.mjs` proves the pipeline locally; it closes no
      production gate.
- [ ] Watch the log drain for `[refresh] account_not_active` — M1 now refuses
      deactivated accounts, and a spike means somebody's account state is
      wrong, not that the check is.

---

## What this document is not

It has not been run. Every checkbox above is unticked for production, and the
rehearsal lines say exactly where each was rehearsed instead. The value of
writing it before the window is that the production run becomes a repeat of
something already done, rather than a first attempt under pressure — which is
the same argument `production-evidence.json` makes about the difference
between `rehearsed` and `verified`.
