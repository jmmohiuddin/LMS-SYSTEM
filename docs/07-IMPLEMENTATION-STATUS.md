# 07 — Implementation Status: Blueprint vs. As-Built

Documents 01–06 are the design blueprint. This document is the reconciliation: what is
actually deployed today, where the implementation deliberately diverges from the blueprint,
how to operate it, and what remains. Last updated **2026-08-11**, after the Phase 0
security block (§9a).

---

## 1. Current state at a glance

| | |
|---|---|
| Production URL | `https://shikhon-lms.vercel.app` |
| Hosting | Vercel (Hobby plan) — static PWA + 10 Serverless Functions (12-function cap, 2 spare) |
| Database | Neon PostgreSQL 18.4, database **`shikhon_lms`**, Singapore (`ap-southeast-1`) — see [06-DEPLOYMENT.md](06-DEPLOYMENT.md) |
| Repo | `github.com/jmmohiuddin/LMS-SYSTEM`, branch `main` |
| Tests | **415 unit passing** (`node --test`, 0 failures, verified 2026-08-29) across `packages/offline` 46, `packages/server-core` 75, `packages/ui-core` 85, `services/academics-svc` 19, `services/ops-svc` 5, `services/rms-svc` 15, `apps/pwa` 162, `netlify` 8 — plus DB-backed integration suites in `identity-svc`, `ops-svc` and `sync-svc` that self-skip unless `DATABASE_URL` is set, and 17 SQL assertion suites |
| Schema | 39 migrations (38 rollback files), verified by applying the full chain to an empty database in CI, then 17 SQL assertion suites |
| Login | **Temporarily disabled** by a two-sided kill switch (§5) |
| Preview | **`https://shikhon-lms.vercel.app/?demo=1`** — every screen, sample data, no login (§6) |

What a teacher can do today (once login is re-enabled): log in with phone + OTP, see their
day/week routine (substitutions included), pick a section and see its roster, take
attendance fully offline with queued sync, enter exam marks component-wise fully offline
(the নম্বর tab), and keep working through network loss. Coordinators can additionally run
the routine solver and the substitution finder over the API; guardians can read their
wards' invoices and receipts.

---

## 2. Platform: blueprint vs. as-built

The blueprint (01-ARCHITECTURE §1, §3) targets a national-scale platform: Kong gateway,
Kubernetes, NestJS + Go services, Redis/BullMQ, Cloudflare edge. The as-built system is a
deliberate **minimum-infrastructure rendering of the same design** on free-tier primitives —
the domain model, tenancy rules, sync protocol and API shapes are the blueprint's; only the
runtime is substituted.

| Blueprint | As-built | Why |
|---|---|---|
| Kong API gateway, mTLS | Vercel routing + per-function JWT verification (`packages/server-core/src/jwt.ts`, EdDSA as specified) | No gateway to run on Hobby; the JWT contract (§7.2 of 01) is unchanged |
| 6 services (NestJS/Go) on Kubernetes | 6 service *directories* (`services/*-svc`) compiled by esbuild into **12 Vercel functions** | Same ownership boundaries, zero orchestration cost. Hobby caps a deployment at 12 functions — the 3 MFS webhooks were merged into one dynamic route to fit (§3) |
| Next.js 15 SSR shell | Framework-free static PWA (`apps/pwa`, hand-rolled DOM, hash router) | Kills the framework payload entirely; critical-path JS is far under the 180 KB budget of 01 §8 |
| Dexie 4 IndexedDB wrapper | Hand-rolled IndexedDB store (`packages/offline/src/store.ts`) | One less dependency; the outbox schema of 01 §2.2–2.3 is implemented as specified |
| Redis + BullMQ workers | Postgres-table outbox (`sms_outbox`) + Vercel cron | Queue semantics preserved (status/attempts/backoff columns); no Redis to operate |
| PgBouncer transaction pooling | Neon's built-in pooler (also PgBouncer transaction mode) | `SET LOCAL` tenant-context rule verified against the live pooler — see 06 §3 |
| Cloudflare edge, BD data residency | Vercel edge, Singapore DB | Acceptable for dev/staging; **residency must be settled before real student PII lands** (06 §5) |

Everything in **db/** is the blueprint exactly: the migrations in [`db/migrations/`](../db/migrations/)
*are* the DDL that 01 §5 and 02 §4 specify, deployed and assertion-tested (06 §4).

---

## 3. Deployed API surface (10 functions, 2 spare)

Built by [`scripts/build.mjs`](../scripts/build.mjs): each entry is esbuild-bundled (whole
`services/` + `packages/` graph inlined, only `pg` external) into `api/`, which Vercel's
file-based routing serves. **The Hobby plan hard-caps a deployment at 12 Serverless
Functions**; each service is therefore **one dynamic-route function** (an `index.ts`
dispatcher routing to unchanged per-endpoint handler files), leaving 3 slots of headroom.
Two routing quirks learned in production: a multi-segment `[...path]` catch-all does not
match on prebuilt functions (auth is a plain `auth.js` + a `vercel.json` rewrite passing
the subpath as `?path=`), and `build.mjs` clears `api/` before writing so removed entries
can never linger as extra functions.

| Function | Routes | Auth | Notes |
|---|---|---|---|
| `auth.js` | `POST /api/v1/auth/{otp/request, otp/verify, refresh, logout}` | public / refresh token | OTP request **503 `otp_disabled` while the kill switch is on** (§5); verify issues EdDSA access (15 min) + rotating refresh (30 d) with reuse detection |
| `sync/[action].js` | `POST /api/v1/sync/push`, `GET /api/v1/sync/pull` | JWT | Outbox op batches, idempotent on `opId`; entities: `attendance_session`, **`exam_mark`** (component marks with optimistic concurrency), `class_delivery_log`; cursor-based delta pull |
| `academics/[resource].js` | `GET .../sections`, `GET .../roster`, `GET .../exams`, `GET .../marks`, `POST .../publish` | JWT (staff; publish: principal-level) | `exams` lists exam-subjects + component maxima per section; `marks` returns roster⋈existing marks + `rowVersion`. Mark **writes** go through sync/push, offline-first. `publish` runs the full result flow in one transaction: `compute_subject_grade` per mark → `compute_exam_gpa` → `exam_results` upsert → section ranks → marking locked + exam published (immutable after) |
| `rms/[action].js` | `GET .../routine`, `POST .../solve`, `POST .../substitute` | JWT / coordinator roles | `substitute`: free-period + subject-expertise candidate ranking per 02 §5 (find mode) and `routine_substitutions` insert (assign mode); the `check_substitute_free` DB trigger stays the hard guarantee |
| `sms/dispatch.js` | `GET/POST /api/v1/sms/dispatch` | `CRON_SECRET` / `SERVICE_API_KEY` | Outbox drain; **send is a stub** — no aggregator credentials. Cron: daily `0 18 * * *` UTC = 00:00 BST |
| `finance/webhooks/[provider].js` | `POST .../webhooks/{bkash,nagad,rocket}` | webhook signature | Shared processor per 03 §2.4; unknown provider → 404 |
| `finance/[resource].js` | `GET .../invoices`, `POST .../pay`, `GET .../receipts`, `POST .../generate` | JWT (RLS-scoped; generate: accountant-level) | Invoices + lines, money as decimal strings; digital receipts JSON; **`pay` is kill-switched → 503 `mfs_disabled`** pending real merchant credentials (§5). `generate` runs the monthly invoice batch from `fee_structures` (class-specific beats class-wide, best `fee_waiver` per line, idempotent per student+period) |
| `ai/[engine].js` | `POST /api/v1/ai/sikhok`, `POST /api/v1/ai/shikho` | JWT (sikhok: staff) | SikhokAI (CQ/MCQ/rubric/lesson-plan, Claude Opus) + ShikhoAI (Socratic tutor, Claude Haiku) via the Anthropic SDK. **503 `ai_disabled` until `ANTHROPIC_API_KEY` is set** (§5). NCTB-scope-bounded prompts, PII redaction before egress, `ai_sessions`/`ai_turns` audit. RAG runs lexical-only until the NCTB corpus is ingested (responses carry `grounded: false`) |
| `ans/[action].js` | `GET /api/v1/ans/students`, `POST .../dispatch`, `POST .../inbound` | `SERVICE_API_KEY` (+`CRON_SECRET` for dispatch) | Batch pull with `globalPersonId` merge keys and consent-gated contact fields; HMAC-SHA256-signed outbound webhook dispatcher over `alumni_export_logs` (backoff, dead-letter, stable `delivery_id`); inbound staged into `ans_inbound_events`, applied only after review |
| `ops/maintenance.js` | `GET/POST /api/v1/ops/maintenance` | `CRON_SECRET` / `SERVICE_API_KEY` | Second daily cron (01:00 BST): `app.maintain_partitions()` / `purge_expired_data()` / `refresh_dashboards()` over `DATABASE_MAINTENANCE_URL` (owner role, direct endpoint — the DDL these need), plus a default-partition-leakage report. **503 `maintenance_unconfigured` until that env var is set** |
| `ops/[action].js` | `GET/PUT /api/v1/ops/branding` | JWT (PUT: principal / school_owner / it_admin / academic_coordinator) | R-1. Full tenant branding, read by any signed-in member (documents need the letterhead) and written by the four roles that own structural settings. No tenant id in URL or body — the only tenant a caller can name is the one they authenticated as; `tenant_self` RLS is the boundary |
| `ops/[action].js` | `GET /api/v1/ops/brand?slug=\|tid=` | **public** | R-1. Pre-auth login-screen identity: seven signboard fields only, fixed by an explicit key allowlist in `app.public_branding()`. Exact-key lookup, so it cannot enumerate; an unknown key returns neutral defaults with 200 rather than a 404 existence oracle |
| `ops/[action].js` | `GET /api/v1/ops/manifest?slug=\|tid=` | **public** | R-1. Per-tenant `application/manifest+json`, so installing tenant A's PWA yields A's name, icon and theme colour. `start_url` carries `?tid=` |

Conventions that differ from 03: base URL is `https://shikhon-lms.vercel.app/api/v1` (not
`api.shikhon.bd/v1`), and errors are plain `{ error, message }` JSON rather than RFC 9457
problem+json. Everything else (idempotency, webhook processing order, money-as-string) is
implemented as specified.

---

## 4. PWA as-built

`apps/pwa` — framework-free TypeScript, Bangla-first, sized for the 360×640 / 2 GB /
2G reference device of 04.

| Piece | File | Notes |
|---|---|---|
| Entry + boot | `src/app.ts` | Resolves tenant from `?tid=`/localStorage; Auth-gates the shell; `?demo=1` bypass (§6) |
| Auth/session | `src/auth.ts` | Tokens in localStorage; silent refresh 60 s ahead of expiry; `authedFetch()` used by every view |
| Login | `src/login-view.ts` | Phone → OTP → verify; **currently short-circuits to a disabled notice** (§5) |
| Shell | `src/shell.ts` | Hash router + bottom tab bar (হাজিরা / রুটিন / শিক্ষার্থী), logout in the top bar |
| Attendance | `src/attendance-view.ts` | The 30-second grid of 04 §4.1; writes go to the outbox, never await the network |
| Roster | `src/roster-view.ts` | Section picker + list; localStorage cache with offline banner; feeds the attendance grid its real roster |
| Routine | `src/routine-view.ts` | Day/week toggle; substitution and attendance-taken chips; localStorage cache |
| Marks entry | `src/marks-view.ts` | নম্বর tab: exam-subject picker → component-wise entry (CQ/MCQ/practical/CA), absent toggle, offline cache; each changed row becomes one `exam_mark` outbox op with `rowVersion` optimistic concurrency; published/locked exams render read-only |
| More menu | `src/more-view.ts` | আরও tab — the five-tab bar stays fixed; additional feature pages are hidden-but-routable (`ShellRoute.hidden`) behind this menu and deep-linkable by hash |
| Fees | `src/fees-view.ts` | Invoice list (status/balance, Bangla-numeral taka), expandable lines with waivers, lazily-fetched receipts; visibility follows RLS `invoice_scope` |
| Substitution finder | `src/substitute-view.ts` | Date → own teaching slots → ranked free/subject-matched candidates → one-tap assign; `substitute_conflict` re-runs the search; 403 surfaced plainly for non-coordinators |
| SikhokAI | `src/sikhok-view.ts` | CQ/MCQ/rubric/lesson-plan form over `/ai/sikhok`; friendly `ai_disabled` state; ungrounded output carries a verify-before-use notice |
| ShikhoAI | `src/shikho-view.ts` | Socratic tutor chat over `/ai/shikho` (Bangla/English/Banglish), class-level selector, `ai_disabled` banner |
| Branding editor | `src/branding-view.ts` | R-1 প্রতিষ্ঠানের পরিচয়: name / logo / favicon / watermark / signature / colours / contact, with a live preview whose letterhead panel calls ui-core's `brandedLetterhead()` — the same function the documents will — so the preview cannot drift from the paper. Images are downscaled on-device to the byte cap rather than refused. A 403 renders it read-only |
| Branding runtime | `src/branding.ts` | Applies the tenant's identity to the document: colour tokens (light + dark), title, favicon, theme colour, manifest link. Cache-first then revalidate, keyed per tenant, re-validated on read because localStorage is writable by anything on the origin |
| Sync | `packages/offline/` | Outbox engine per 01 §2.3: UUIDv7-keyed ops, monotonic `seq`, exponential backoff with jitter, conflict surfacing |
| Service worker | `src/sw.ts` + `src/sw-router.ts` | Route policy of 01 §2.4 (network-only for auth/sync, SWR for reference data, cache-first for hashed assets, app-shell fallback for navigations) |
| Data saver | (policy module, tested) | 2G/`saveData` drops avatars, lengthens sync interval; WASM cropper skipped on ≤2 GB devices — 04 §6 |

TypeScript is checked as **two programs** — `apps/pwa/tsconfig.json` (DOM lib) and
`apps/pwa/tsconfig.sw.json` (WebWorker lib) — because the DOM and WebWorker global typings
are incompatible in one program. CI-equivalent local gate:

```bash
npx tsc --noEmit && npx tsc --noEmit -p apps/pwa/tsconfig.json && npx tsc --noEmit -p apps/pwa/tsconfig.sw.json
```

---

## 5. Kill switches (what is deliberately off, and how to turn it on)

Three features are dark behind explicit switches, all following the same pattern: fail
closed with a specific error code, before any side effect.

| Feature | Where | Off because | To enable |
|---|---|---|---|
| OTP login | `OTP_SENDING_ENABLED` in `services/identity-svc/api/otp-request.ts` + `LOGIN_DISABLED` in `apps/pwa/src/login-view.ts` (two-sided, flip together) | No SMS aggregator | Flip both constants, rebuild, redeploy |
| MFS payment initiation | `MFS_PAYMENTS_ENABLED` in `services/finance-svc/api/index.ts` | No live merchant credentials | Wire gateway calls + credentials, flip the constant |
| AI engines | Presence of `ANTHROPIC_API_KEY` env var (`services/ai-svc/api/index.ts`) | No API key configured | Set the key in Vercel env, redeploy |

The login switch specifically (disabled 2026-08-07):

| Side | File | Constant | Effect while off |
|---|---|---|---|
| Backend | `services/identity-svc/api/otp-request.ts` | `OTP_SENDING_ENABLED = false` | `POST /auth/otp/request` returns `503 { error: "otp_disabled" }` before any DB write or log |
| Frontend | `apps/pwa/src/login-view.ts` | `LOGIN_DISABLED = true` | Login screen renders "লগইন সাময়িকভাবে বন্ধ আছে" instead of the phone form — no wasted round-trip |

Everything else is untouched: verify/refresh/logout still work, so **already-logged-in
sessions keep working** for their refresh-token lifetime; all data endpoints are unaffected.

**To re-enable:** set `OTP_SENDING_ENABLED = true` and `LOGIN_DISABLED = false`, then
`node scripts/build.mjs`, commit, `vercel --prod`. Note that even when enabled, no real SMS
is sent — the OTP code is written to the function log (`vercel logs`) and, when the caller
presents `SERVICE_API_KEY` via the `X-Debug-Otp` header, echoed in the response. Real
delivery awaits an aggregator contract (03 §3).

---

## 6. Demo mode

`https://shikhon-lms.vercel.app/?demo=1` previews every screen with sample data while login
is off. `apps/pwa/src/demo.ts` provides `DemoAuth`, a drop-in `Auth` substitute whose
`authedFetch()` answers sections/roster/routine/sync-push **locally** — no session exists,
no request leaves the device, and it cannot touch real tenant data. The top bar shows
"ডেমো (নমুনা তথ্য)" so it is never mistaken for a real session. A normal (non-demo) boot
purges any demo leftovers from the shared localStorage caches, so a later real login never
sees sample data.

---

## 7. RMS: deep-dive vs. as-built

02-RMS-DEEP-DIVE specifies CP-SAT-class solving. The as-built solver
(`services/rms-svc/src/solve.ts`) is a **greedy heuristic with weighted soft-constraint
scoring** — most-constrained-assignment-first ordering over the hard-constraint-feasible
domain, then hill-climbing on the soft objective of 02 §3.3.

What holds regardless of solver quality: **clash-freedom is enforced by the database**, not
the solver. The three `btree_gist` exclusion constraints of 02 §4.1 (teacher, section, room
per timeslot) make a double-booking structurally impossible to commit — a worse solver can
produce a lower-scoring routine, never an invalid one. The read path
(`GET /api/v1/rms/routine` → `app.teacher_day()`) and the substitution merge are as
specified in 02 §2.2. Upgrading the solver to OR-Tools CP-SAT is a drop-in replacement
behind the same `/rms/solve` contract (Phase 3 in 05).

---

## 8. Operations runbook

**Deploy** (also runs on `git push` via Vercel Git integration):
```bash
node scripts/build.mjs        # typecheck is separate — see §4 gate
vercel --prod --yes
```

**Migrations** — owner role, direct (non-pooled) endpoint only:
```bash
DATABASE_MIGRATION_URL='postgresql://neondb_owner:…@ep-late-fog-azjd29xn.c-3.ap-southeast-1.aws.neon.tech/shikhon_lms?sslmode=require' \
  ./scripts/migrate.sh --with-tests
```
`migrate.sh` refuses to run against a non-empty schema (the migrations are not idempotent);
`--force` is the deliberate override. Rollback files in `db/rollback/` are re-runnable.

**JWT keys:** `node scripts/generate-jwt-keys.mjs` → paste into `JWT_PRIVATE_KEY` /
`JWT_PUBLIC_KEY` Vercel env vars. Re-running rotates the pair and invalidates all live
access tokens.

**Env vars (Vercel, Production):** `DATABASE_URL` (must be `shikhon_runtime` on the
**pooled** endpoint — never the owner role; see 06 §2), `JWT_PRIVATE_KEY`, `JWT_PUBLIC_KEY`,
`CRON_SECRET`, `SERVICE_API_KEY`. Optional feature enables: `ANTHROPIC_API_KEY` (turns the
AI gateway on; `AI_MODEL_SIKHOK`/`AI_MODEL_SHIKHO` override the models), `ANS_SIGNING_SECRET`
(outbound ANS webhook signing until KMS-managed per-endpoint keys exist),
`DATABASE_MAINTENANCE_URL` (owner role on the direct endpoint — turns the nightly DB
maintenance cron live).

**Cron:** two Hobby-safe daily jobs in `vercel.json` — `/api/v1/sms/dispatch` at 00:00 BST
and `/api/v1/ops/maintenance` at 01:00 BST. The maintenance job stays a 503 no-op until
`DATABASE_MAINTENANCE_URL` is set (owner role, direct endpoint — the value
`scripts/migrate.sh` uses); every run reports default-partition leakage so the docs/06
canary is checked automatically.

**Smoke test:** on some local networks `*.vercel.app` DNS resolution fails; pin the edge IP:
```bash
curl --resolve shikhon-lms.vercel.app:443:216.198.79.3 https://shikhon-lms.vercel.app/
```

---

## 9. Security posture — open items

Carried forward from 06 §6, updated after Phase 0:

- [ ] **Rotate the exposed `neondb_owner` password** (`npg_…` — was shared in plaintext).
      Until rotated, treat the owner credential as compromised. It must never be the app's
      `DATABASE_URL` in any case (BYPASSRLS voids all tenant isolation). Ledger row is open
      in [08-CREDENTIAL-ROTATION.md](08-CREDENTIAL-ROTATION.md) §3.
- [ ] **Revoke the exposed MongoDB credential** (from an earlier experiment; unused by this
      system but still live — an unused live credential is pure liability).
- [x] App connects as `shikhon_runtime` (non-BYPASSRLS) on the pooled endpoint.
- [x] Runtime password exists only in Vercel's `DATABASE_URL`; no local copies remain.
- [x] EdDSA JWTs, 15-min access / 30-day rotating refresh with reuse detection, as 01 §7.2.
- [x] **No credential has ever been committed to this repository** — verified across every
      commit on every branch, and re-verified by CI on every push
      (`scripts/check-secrets.mjs --history`).
- [x] Deploy preflight refuses a missing, placeholder or dangerously wrong secret
      (`scripts/check-secrets.mjs --env`).
- [x] **Rate limiting on every endpoint (F-102)** — token buckets in Postgres, per-IP sized
      for a school behind one NAT gateway and per-identity carrying the real abuse control.
      This was the hard gate on re-enabling login.
- [x] **Field-level encryption for NID/BRC (F-101)** — AES-256-GCM with per-tenant HKDF
      derivation, versioned keys, and database guards that refuse plaintext independently of
      the application. Ships dark until `PII_MASTER_KEY_V1` is set, which is the correct
      failure: it is never possible to store an identifier in the clear because a key was
      missing.
- [ ] Set `PII_MASTER_KEY_V1` in Vercel — board registration and MPO filing cannot work
      until it exists. See [08-CREDENTIAL-ROTATION.md](08-CREDENTIAL-ROTATION.md) §5 **before**
      touching it; rotation is additive and replacing V1 in place destroys data silently.
- [ ] Wire DB maintenance functions to a scheduler (§8).
- [ ] Production data-residency decision (Singapore → Bangladesh) before real PII lands.
- [ ] Curriculum-specialist verification of NCTB subject codes (06 §6).

---

## 9a. Phase 0 — closed

Six requirements, one commit each, tests in the same commit.

| ID | What | Where |
|---|---|---|
| F-102 | Rate limiting on every endpoint | migration 020, `packages/server-core/src/rate-limit.ts` |
| F-101 | Field-level encryption for NID / birth registration | migration 021, `packages/server-core/src/pii-crypto.ts` |
| F-103 | Row-version optimistic lock on assignment grading | `services/academics-svc/api/assignments.ts` |
| F-104 | Prerequisite cycle prevention (recursive-CTE trigger) | migration 022 |
| F-105 | Credential rotation confirmed and recorded | `scripts/check-secrets.mjs`, [08](08-CREDENTIAL-ROTATION.md) |
| F-106 | Backfill tests: assignments, practice, next, results, ledger | `services/academics-svc/test/api.test.ts`, `db/tests/ledger.sql` |

### Two defects the work uncovered

**Every student-facing read was blocked by RLS** (migration 023). Six tables paired a
`FOR SELECT` read policy with a `FOR ALL` write policy, both RESTRICTIVE. Since RESTRICTIVE
policies AND together and `FOR ALL` includes SELECT, the read policy was cancelled out — so
students and guardians could not read a chapter, a lesson, a content block, a practice
question, a homework assignment or an invoice. Homework submission failed too, on a NOT NULL
violation from the lateness trigger. Only staff ever exercised these paths, so nothing failed
loudly; this is very likely why the app only ever looked right in demo mode. Found by the
F-106 tests, which were the first thing to query these tables as a student.

**The audit trail was never writable** (repaired in migration 021). Migration 010 granted
`shikhon_app` INSERT on `audit.pii_access` and `audit.activity_log`, but granted sequence
USAGE only in schema `public` — both tables are `bigserial` in schema `audit`. Every audit
write would have failed on "permission denied for sequence". Nothing had been written yet,
so nothing was lost.

### Knowing what production actually runs

The open question through all of Phase 0 was whether migrations 016–019
were ever applied — and there was no way to answer it, because the
migrations are not idempotent and nothing records what has run.

`scripts/migration-status.mjs` answers it by probing, not by trusting a
ledger that does not exist. Read-only, no owner credential:

```bash
DATABASE_URL='postgresql://…' node scripts/migration-status.mjs --plan
```

Each migration is probed for an object created at the *end* of its file, so
a migration that died half-way reads MISSING rather than applied. It refuses
to hand out a simple apply plan when the chain is out of order, and CI fails
if a migration is ever added without a matching probe.

**Until this is run against production, treat every Phase 0 guarantee in
§9 as code-complete but not in force.** Migration 023 in particular is what
unbreaks the student-facing product.

### Two status corrections to the PRD

Both were recorded as "Built" and are not:

- **F-502 (manual routine editor)** → should read **Partial**. `routine-view.ts` is 227
  lines and read-only: no drag-and-drop, no live constraint feedback.
- **F-1304 (mandatory human review of AI content)** → was recorded **Built**, was actually
  **New**, and is now **enforced in the database** (migration 024). The `reviewed_by`,
  `is_approved` and `ai_session_id` columns had existed since migration 005 and appeared in
  zero lines of application code — the same shape as F-101's encryption columns and F-103's
  `row_version`.

  The gate went in *before* the code path that would violate it: nothing today writes
  generated content to the item bank, so this is the cheapest this will ever be. Approval
  requires a named reviewer, `reviewed_at` is stamped by the database rather than accepted
  from the caller, AI-generated items must keep the `ai_session_id` that produced them, and
  — the one that matters in practice — **editing an approved item revokes its approval**,
  including a change to an MCQ option or a CQ part. Review does not usually get skipped;
  review goes stale.

  Paper generation must select from the `student_ready_question_items` view, never from
  `question_items` directly. A filter you have to remember is a filter someone will forget.

---

## 9b. R-1 — white-label & branding foundation (closed)

The first phase of [11-MASTER-PLAN.md](11-MASTER-PLAN.md). Tenancy was already
enforced everywhere it mattered for data; what was missing was the visible half —
every school saw **ShikhonBD** on its own login screen.

### What was implemented

| Piece | Where |
|---|---|
| Branding contract — schema, validation, colour derivation, WCAG contrast | `packages/ui-core/src/branding.ts` |
| Print foundation — letterhead, watermark, signature, standalone A4 document | `packages/ui-core/src/branded-doc.ts` |
| Seed + pre-auth read function + shape guard | `db/migrations/039_tenant_branding.sql` |
| `GET/PUT /ops/branding`, `GET /ops/brand`, `GET /ops/manifest` | `services/ops-svc/api/`, shared lookup in `services/ops-svc/src/public-branding.ts` |
| Runtime application + per-tenant cache | `apps/pwa/src/branding.ts` |
| Editor with live preview | `apps/pwa/src/branding-view.ts` |
| Institution plate in the shell; institution mark on login | `apps/pwa/src/shell.ts`, `src/login-view.ts` |
| Two demo institutions for side-by-side verification | `apps/pwa/src/demo.ts` |

### Where branding lives, and why

`tenants.settings->'branding'` — a column, not a table. It is exactly one row per
tenant, always read whole, never joined, never queried by any of its fields. It
inherits the `tenant_self` RLS policy from 010 and the `app.enforce_tenant()`
immutability guarantee by being part of the tenant row. Assets are inline data
URLs under per-field byte caps (logo 64 KB, favicon 32 KB, watermark 96 KB,
signature 48 KB; 320 KB total), so R-1 needed no object storage — that decision
arrives with R-5's stored PDFs and student photos.

### What actually enforces isolation

Not the handlers. `tenant_self` (`id = app.current_tenant()`, FORCE'd) is the
boundary, and every statement runs inside `withTenant()`. The endpoints carry no
tenant id in URL or body, so the only tenant a caller can name is the one they
authenticated as; `requireRole()` is a clean 403 in front of the policy, not the
policy. `db/tests/tenant_branding.sql` asserts this directly — with tenant A's
session context, an `UPDATE … WHERE id = <B>` matches **zero rows**.

The one deliberate exception is `app.public_branding()`, `SECURITY DEFINER` with a
pinned `search_path`: the login screen and the manifest are fetched before any
session exists. It answers by exact key only (slug *or* tenant id — the install
link carries the id), returns seven signboard fields fixed by an allowlist **in
SQL**, and returns nothing for an unknown key. Contact details, head teacher,
watermark and signature stay behind authentication.

### Tests

61 new, all passing: `packages/ui-core/test/branding.test.ts` (24 — validation,
refusals, colour derivation), `branded-doc.test.ts` (13 — escaping, two-tenant
document isolation), `apps/pwa/test/branding-ui.test.ts` (19 — apply, cache,
login, shell), `services/ops-svc/test/branding.test.ts` (5 pure + a DB-backed
suite), and `db/tests/tenant_branding.sql` wired into `database.yml`. A CI guard
in `frontend.yml` fails the build if platform branding reappears in tenant-facing
UI (`landing.html` is exempt — that page is the platform talking about itself).

### Acceptance test

`?demo=1&tenant=a` and `?demo=1&tenant=b` on one deployment: different name, logo,
colour, address, head teacher; different browser title, theme colour, favicon and
manifest URL; different printed letterhead; and no value of one appearing anywhere
in the other's DOM or cache. Verified in a browser, not only asserted.

### Known limitations

- **The DB-backed half of `services/ops-svc/test/branding.test.ts` and
  `db/tests/tenant_branding.sql` have not been executed** — no PostgreSQL was
  reachable on the machine R-1 was built on. They are written to the conventions of
  the suites around them and are wired into `database.yml`, so the first CI run is
  their first execution. Until that run is green, R-1's isolation guarantee is
  code-complete and CI-pending, exactly as §9a says of Phase 0.
- **Two front doors.** `apps/pwa/public/index.html` — what `/` actually serves — is
  the Ata Ekta design mock-up: 66 static screens, no API calls, no `app.js`. The
  functional TypeScript PWA is `index.legacy.html`. Both are branded (the mock-up by
  an inline bootstrap using the same cache key and endpoint), but which one is the
  product is an open question this phase did not resolve.
- **A branding change does not reach an already-open tab** on another device until
  it reloads; there is no push. The service worker serves `/ops/brand` stale-
  while-revalidate, so the next launch is correct.
- **`app.js` is cache-first in the service worker and is not content-hashed**, so a
  deploy does not reach a returning device until `CACHE_SHELL`'s version string
  changes. Pre-existing, and it made local verification of R-1 misleading twice
  before it was noticed; worth a version bump policy before the pilot.
- Migration **038 still has no probe** in `scripts/migration-status.mjs` — it only
  alters columns, which the current probe kinds cannot express. 039's probe is
  present.
- Colour customisation is deliberately bounded to primary + accent. Status colours
  (absent, overdue, paid) and the destructive `--c-accent` are not tenant-controlled.

---

## 10. Gap list → what's next

Mapped to the phasing of [05-DELIVERY-ROADMAP.md](05-DELIVERY-ROADMAP.md). The
2026-08-07 feature build closed the API-surface gaps for exams/marks, fees, AI, ANS and
substitution — what remains is mostly credentials, content, and follow-on UI:

| Gap | Blueprint ref | Phase |
|---|---|---|
| Real SMS aggregator credentials (send + DLR webhook); then re-enable login | 03 §3 | 1 |
| Guardian absence-notification flow end-to-end (enqueue exists; send is stubbed) | 01 §3 events | 1 |
| Attendance correction flow + absence-SMS grace window | 01 §2.6 | 1 |
| MFS merchant credentials + per-provider initiation calls + signature verification (endpoints + webhooks exist; `pay` kill-switched) | 03 §2 | 2 |
| Report-card rendering (PDF/print view — the `exam_results` data it reads from now ships via `POST /academics/publish`) | 05 Phase 2 | 2 |
| Set `DATABASE_MAINTENANCE_URL` in Vercel so the nightly maintenance cron goes live | 06 §5 | now |
| CP-SAT solver upgrade; coordinator routine-editing UI (substitution finder ships now) | 02 §3 | 3 |
| `ANTHROPIC_API_KEY` + NCTB corpus ingestion + embedding service → upgrades AI from disabled/lexical to grounded hybrid RAG (gateway ships now) | 01 §6 | 3 |
| ANS: register real endpoints (`ans_endpoints`), KMS for per-endpoint signing secrets (batch pull, dispatcher, inbound staging ship now) | 03 §4 | 4 |
| Answer-script photo pipeline | 01 §2.7 | 2–3 |
| AI per-tenant token budgets (`ai_budget_periods` enforcement) and answer-leak detector (needs embeddings) | 01 §6.3 | 3 |
