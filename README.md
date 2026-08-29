# ShikhonBD — Multi-Tenant, Offline-First LMS for Bangladeshi Institutions

Production blueprint for an AI-native, offline-first Learning Management System targeting
Primary, Secondary, Higher Secondary and Madrasah streams in Bangladesh.

**Design envelope (non-negotiable constraints driving every decision below):**

| Constraint | Target | Consequence |
|---|---|---|
| Device floor | Android Go, 2 GB RAM, Chrome 90+ | JS budget ≤ 180 KB gz on critical path; no client-side PDF/heavy charting |
| Network floor | 2G/EDGE, 40–200 kbps, 800 ms RTT, 30 %+ packet loss | Offline-first is the *default* path, not a fallback |
| First contentful paint | ≤ 2.5 s on 3G, ≤ 1.2 s warm (SW cache) | App shell precached, data streamed |
| Attendance completion | < 30 s for a 60-student section | Single-screen touch grid, zero network in the hot path |
| Tenant isolation | Hard, DB-enforced | PostgreSQL Row-Level Security on every tenant table |
| Regulatory | PDPA 2026, Cybersecurity Act 2023 | AES-256-GCM envelope encryption for NID/BRC, in-country data residency |

---

## Document map

| # | Document | Covers |
|---|---|---|
| 1 | [docs/01-ARCHITECTURE.md](docs/01-ARCHITECTURE.md) | PWA offline caching (IndexedDB + Service Worker outbox), microservice topology, sync protocol, AI engine architecture, security & compliance |
| 2 | [docs/02-RMS-DEEP-DIVE.md](docs/02-RMS-DEEP-DIVE.md) | Routine Management System — generation algorithm, clash detection, substitution engine, teacher dashboard UX |
| 3 | [docs/03-API-SPECIFICATIONS.md](docs/03-API-SPECIFICATIONS.md) | bKash / Nagad / Rocket webhook contracts, SMS aggregator contracts, bi-directional Alumni Networking System (ANS) API |
| 4 | [docs/04-UIUX-ACCESSIBILITY.md](docs/04-UIUX-ACCESSIBILITY.md) | Mobile-first wireframes, Bangla typography, accessibility, low-bandwidth asset policy |
| 5 | [docs/05-DELIVERY-ROADMAP.md](docs/05-DELIVERY-ROADMAP.md) | Phasing, team shape, SLOs, cost model, risk register |
| 6 | [docs/06-DEPLOYMENT.md](docs/06-DEPLOYMENT.md) | Live Neon deployment: database choice, roles, connection strings, pooler safety, maintenance scheduling |
| 7 | [docs/07-IMPLEMENTATION-STATUS.md](docs/07-IMPLEMENTATION-STATUS.md) | **Blueprint vs. as-built**: what is deployed on Vercel today, the 12-function API inventory, PWA screens, the login kill switch and demo mode, ops runbook, gap list |
| 8 | [docs/08-CREDENTIAL-ROTATION.md](docs/08-CREDENTIAL-ROTATION.md) | Credential rotation ledger and the automated secret checks |
| 9 | [docs/09-PRD-AUDIT.md](docs/09-PRD-AUDIT.md) | Coverage of the PRD's 128 prioritised requirements, audited against the repository |
| 10 | [docs/10-NETLIFY.md](docs/10-NETLIFY.md) | Netlify as a second deployment target sharing every handler |
| 11 | [docs/11-MASTER-PLAN.md](docs/11-MASTER-PLAN.md) | **The plan of record**: decisions D1–D12, the R-0…R-9 roadmap, and what not to do |
| — | [docs/PHASE_LOG.md](docs/PHASE_LOG.md) | **Start here.** Chronological history of everything that has been built, why, and what is still open |

---

## Surfaces

One deployment, three addresses (R-1-A; master plan §1a):

| Address | File | What it is | Brand |
|---|---|---|---|
| `/` | `apps/pwa/public/index.html` | The shikhonBD / eShikhon marketing site | **platform** |
| `/app` | `apps/pwa/public/app.html` | The tenant management PWA — the actual product | white-labelled per institution |
| `/design` | `apps/pwa/public/design.html` | The Ata Ekta design prototype, kept as a reference | — |

A school reaches its own application through its own link, `/app?tid=<tenant-id>`,
and later through its own subdomain (R-7). There is no school-picker, by decision
D12: it would enumerate the customer list to anyone who loads the page.

---

## Working conventions

Two standing rules. Both are decisions of record in
[docs/11-MASTER-PLAN.md](docs/11-MASTER-PLAN.md) and both are enforced, not
merely encouraged.

### D10 — the phase log is the project's memory

[`docs/PHASE_LOG.md`](docs/PHASE_LOG.md) is the canonical chronological history.
Update it after every meaningful change — a phase, a bug fix, an architectural
decision, a migration, a test milestone, a deployment change, an important
discovery. **A phase is not complete until its entry is written.**

It is **append-only**. A decision that supersedes an earlier one gets a new entry
saying what changed, why, and what replaced it; the superseded entry stays as it
was. Deleting the reasoning behind an abandoned approach destroys the thing a
future reader needs most.

The test it has to pass: *a new contributor, or a new agent with no chat history,
reads that one file and knows where this project stands.*

### D11 — the platform is branded, the tenant application is white-labelled

**`shikhonBD` is the permanent platform and marketing brand.** It stays on the
landing page, the marketing site, public documentation and any future platform
Super Admin console.

**White-labelling applies only to a tenant's operational application** — a
school's login, shell, PWA identity, notices, receipts and reports carry that
school's name, logo, colours and watermark.

The rule is *not* "remove ShikhonBD". The `Brand boundary (D11)` job in
`.github/workflows/frontend.yml` enforces both halves: it fails the build if the
platform brand appears on a tenant surface, **and** if it disappears from the
marketing site.

---

## Database

`db/migrations/` contains executable PostgreSQL 16 DDL, applied in order:

```
001_extensions_and_tenancy.sql   extensions, tenants, RLS helper functions, audit spine
002_identity_and_rbac.sql        users, roles, permissions, guardianship, encrypted PII
003_academics.sql                academic years, classes, sections, subjects, enrolment
004_attendance.sql               partitioned attendance + SMS outbox
005_assessment_nctb.sql          CQ/MCQ item bank, exams, marks, GPA computation
006_routines_rms.sql             routines, routine_slots, clash-prevention constraints, substitutions
007_finance_mfs.sql              fee heads, invoices, MFS transactions, ledger
008_ai_and_vectors.sql           NCTB vector store, AI session logs, guardrail audit
009_alumni_hooks.sql             alumni_export_logs, ANS webhooks, unified identifiers
010_rls_policies.sql             all RLS policies, GRANTs, role definitions
011_indexes_and_partitions.sql   index strategy, partition automation, materialized views
012_provisioning_and_reference.sql  NCTB subject catalogue, bell-schedule defaults,
                                    app.provision_tenant()
013_tenant_fk_integrity.sql      FKs to tenants on the partitioned tables (PDPA erasure)
014_sync_log_delete_guard.sql    lets tenant deletion cascade without tripping 013
015_sync_operations_seq_reset.sql  drops the device_seq UNIQUE that poisoned reinstalls
```

`db/rollback/` holds one `*.down.sql` per migration, applied in **descending** order.
The up → down → up cycle is exercised in CI.

Apply with:

```bash
for f in db/migrations/*.sql; do psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$f"; done
```

## Provisioning a tenant

A deployed schema is not yet a working institution — without grading bands,
`app.compute_subject_grade` has no scale to resolve against. One call fixes that:

```sql
BEGIN;
SET LOCAL app.tenant_id = '<tenant uuid>';
SET LOCAL app.role      = 'principal';
SELECT app.provision_tenant('<tenant uuid>'::uuid, '2026',
                            '2026-01-01'::date, '2026-12-31'::date, 1::smallint, 10::smallint);
COMMIT;
```

Creates the academic year and terms, the Bangladesh board grading scale (7 bands), a bell
schedule per shift, classes, subjects with NCTB mark distributions, fee heads and a chart of
accounts. Idempotent.

> ⚠ The NCTB subject codes in `012` are **indicative** and must be verified against the current
> board circular before production — they are printed on board registration and MPO forms.

## Verification

Three suites, all **idempotent and self-cleaning** — they seed fixtures, assert, then tear down
and verify no residue. Safe to run against any environment.

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/tests/schema_lint.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/tests/invariants.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/tests/e2e_academic_cycle.sql
```

| Suite | Asserts |
|---|---|
| **schema_lint** (L1–L8) | Every table carries `tenant_id` or is an explicit exemption; RLS **enabled and forced** with ≥1 policy on all of them; `tenant_id` NOT NULL unless declared pre-tenant; every partitioned table has a DEFAULT partition; every tenant table has an FK to `tenants` so deletion cannot orphan rows; advisory check that lookup indexes lead with `tenant_id` |
| **invariants** (16) | **Tenant isolation** — cross-tenant SELECT/UPDATE/DELETE affect zero rows, cross-tenant INSERT raises, no-context reads fail closed, unattributed payment webhooks reach the ingest worker and nobody else. **Clash prevention** — teacher/room/section double-booking rejected on *overlapping time* (incl. partial overlaps a period-number check would miss), adjacent and different-weekday slots accepted. **NCTB grading** — component-pass rule, absentee handling, band boundaries |
| **e2e_academic_cycle** (6) | Provision → enrol → examine → grade → GPA on nothing but `provision_tenant()` output: optional-subject bonus capping at 5.00, the 4th-subject rule (4.00 → 4.50), a component failure zeroing the GPA, and the same-day duplicate-attendance guard |

CI ([`.github/workflows/database.yml`](.github/workflows/database.yml)) runs all three plus a
full **up → down → up** rollback cycle, an idempotency re-run, a residue guard and an RLS-coverage
guard. Migrations must apply with **zero output** — a warning fails the build.

**Executed against two engines:**

| Engine | Result |
|---|---|
| PostgreSQL 16.14 (local) | 11/11 migrations, 15/15 assertions — pgvector shimmed out (unavailable locally) |
| **Neon PostgreSQL 18.4** (`shikhon_lms`, ap-southeast-1) | **15/15 migrations with zero output · 23/23 SQL assertions · rollback → rollback → up cycle clean · run twice, zero residue · pgvector 0.8.1 real, both HNSW indexes built** |

## Application code

| Component | Status |
|---|---|
| [`packages/offline`](packages/offline) | **Built and tested** — outbox + sync engine, 46 assertions, zero runtime deps. The store contract runs against both the in-memory reference and the `IndexedDbOutboxStore` that ships. |
| [`packages/ui-core`](packages/ui-core) | **Built and tested** — attendance state machine, Bangla/Latin numerals, SMS cost model. 36 assertions, zero runtime deps. |
| [`apps/pwa`](apps/pwa) | **Built and tested** — login (phone + OTP), navigation shell, attendance grid, roster view, routine day/week view, **offline marks entry (নম্বর tab)**, service-worker policy, `?demo=1` preview mode. 27 assertions in jsdom. |
| [`services/sync-svc`](services/sync-svc) | **Built and tested** — `POST /sync/push` + `GET /sync/pull` (entities incl. `exam_mark` with optimistic concurrency), 23 assertions against a real database, including the full DOM→database vertical slice. |
| [`services/identity-svc`](services/identity-svc) | **Built and deployed** — OTP request/verify (EdDSA JWT, rotating refresh with reuse detection), logout. OTP issuance currently behind a kill switch — [docs/07 §5](docs/07-IMPLEMENTATION-STATUS.md). |
| [`services/academics-svc`](services/academics-svc) | **Built and deployed** — sections, roster, **exams and marks** read endpoints (mark writes ride the offline outbox). |
| [`services/rms-svc`](services/rms-svc) | **Built and deployed** — greedy-heuristic routine solver, teacher day/week routine endpoint, **substitution finder** (free-period + subject-expertise ranking; DB exclusion constraints guarantee clash-freedom regardless). |
| [`services/sms-svc`](services/sms-svc) | **Built and deployed** — outbox enqueue + cron-driven dispatch worker; **send is stubbed** pending an aggregator contract. |
| [`services/finance-svc`](services/finance-svc) | **Built and deployed** — MFS webhooks (bKash/Nagad/Rocket), **invoice + receipt reads, payment initiation** (kill-switched pending merchant credentials). |
| [`services/ai-svc`](services/ai-svc) | **Built and deployed** — SikhokAI (NCTB-compliant CQ/MCQ/rubric/lesson-plan generation) + ShikhoAI (multilingual Socratic tutor) via the Claude API; PII redaction, session audit, NCTB-scoped retrieval. **Disabled until `ANTHROPIC_API_KEY` is set**; RAG lexical-only until the NCTB corpus is ingested. |
| [`services/ans-svc`](services/ans-svc) | **Built and deployed** — alumni batch pull (`globalPersonId` unified identifiers, consent-gated contact), HMAC-signed outbound webhook dispatcher, inbound enrichment staging. |
| Guardian/principal UI surfaces, result publication & report cards, invoice generation | Follow-on work — gap list with phasing in [docs/07 §10](docs/07-IMPLEMENTATION-STATUS.md) |

```bash
for d in packages/offline packages/ui-core apps/pwa; do (cd $d && npm install && npm test); done
cd services/sync-svc && npm install && DATABASE_URL=… npm test
```

Every layer imports the same protocol types from `packages/offline/src/types.ts`,
so client and server cannot drift apart.

### The vertical slice

[`services/sync-svc/test/vertical-slice.test.ts`](services/sync-svc/test/vertical-slice.test.ts)
runs the whole chain with nothing mocked but the HTTP hop and the browser:

```
DOM tap (jsdom) → AttendanceGrid → SyncEngine outbox → SyncPushHandler
                → RLS-scoped PostgreSQL on Neon → absence SMS queued
```

A teacher marks 60 students at 07:12 with the network down (3 absent, 1 late —
**four taps**), saves, and the register is delivered intact when the link returns:
60 rows, 3 absent, 1 late, 4 SMS queued, 4 `attendance.marked.v1` events, and the
absences land on exactly rolls 7, 23 and 44. Re-marking the same day merges
rather than duplicating.

## Deployment

Live at **`https://shikhon-lms.vercel.app`** (Vercel: static PWA + 12 serverless functions)
on Neon Postgres. See [docs/07-IMPLEMENTATION-STATUS.md](docs/07-IMPLEMENTATION-STATUS.md)
for the ops runbook and [docs/06-DEPLOYMENT.md](docs/06-DEPLOYMENT.md) for connection
strings, roles and maintenance scheduling. Preview every screen without logging in at
`https://shikhon-lms.vercel.app/?demo=1`.

⚠️ **`neondb_owner` has `BYPASSRLS`.** If the application connects as it, every tenant-isolation
guarantee is silently void. The app must connect as **`shikhon_runtime`** (created, `BYPASSRLS =
false`, verified over the wire) via the **pooled** endpoint, and must use `SET LOCAL` — never
plain `SET` — for tenant context.

## Status

**Complete and deployed:** the system blueprint (7 documents); the database layer
(15 migrations, 88 tables, 103 RLS policies) deployed and verified on Neon; tenant
provisioning; three SQL test suites; rollback migrations; the offline sync engine; the PWA
(login, shell, attendance, roster, routine, offline marks entry, demo mode); all eight
service directories compiled into 9 Vercel functions (exams/marks, fee engine, AI gateway,
ANS hooks, substitution finder included); and CI.

**Currently disabled by design** (kill switches, [docs/07 §5](docs/07-IMPLEMENTATION-STATUS.md)):
OTP login (no SMS aggregator), MFS payment initiation (no merchant credentials), the AI
engines (no `ANTHROPIC_API_KEY` set). Use `?demo=1` to preview the UI meanwhile.

**Follow-on work:** result publication & report cards, invoice generation,
guardian/principal UI surfaces, NCTB corpus ingestion for grounded RAG — gap list with
phasing in [docs/07 §10](docs/07-IMPLEMENTATION-STATUS.md).

**Verified totals:** 23 SQL assertions + **109 TypeScript tests** (`node --test`), all green
against Neon PostgreSQL 18.4 on a from-scratch rebuild.

**Defects the integration tests caught before they could ship** — each would have been silent in
production:

| # | Defect | Consequence |
|---|---|---|
| 004 | `UNIQUE (…, period_no, …)` treated NULLs as distinct | Daily attendance could be double-submitted → **every guardian gets a second absence SMS** |
| 013 | Six tenant tables had no FK to `tenants` | Tenant deletion orphaned 196 attendance records + 613 change-log rows → **PDPA erasure silently incomplete** |
| 014 | The 013 FKs made the sync-change trigger fire against a deleted tenant | **Tenant erasure failed outright** |
| 015 | `UNIQUE (tenant_id, device_id, device_seq)` on `sync_operations` | A phone whose local counter reset (reinstall, storage eviction) **stopped syncing forever, silently** |
