# 07 — Implementation Status: Blueprint vs. As-Built

Documents 01–06 are the design blueprint. This document is the reconciliation: what is
actually deployed today, where the implementation deliberately diverges from the blueprint,
how to operate it, and what remains. Last updated **2026-08-07**; current production commit
`80f352e`.

---

## 1. Current state at a glance

| | |
|---|---|
| Production URL | `https://shikhon-lms.vercel.app` |
| Hosting | Vercel (Hobby plan) — static PWA + 10 Serverless Functions (12-function cap, 2 spare) |
| Database | Neon PostgreSQL 18.4, database **`shikhon_lms`**, Singapore (`ap-southeast-1`) — see [06-DEPLOYMENT.md](06-DEPLOYMENT.md) |
| Repo | `github.com/jmmohiuddin/LMS-SYSTEM`, branch `main` |
| Tests | **109/109 passing** (`node --test`, zero dependencies beyond `pg`/`jose`/`esbuild`) |
| Schema | 15 migrations, 88 tables, 103 RLS policies, verified via 3 SQL assertion suites |
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

Carried forward from 06 §6, updated:

- [ ] **Rotate the exposed `neondb_owner` password** (`npg_…` — was shared in plaintext).
      Until rotated, treat the owner credential as compromised. It must never be the app's
      `DATABASE_URL` in any case (BYPASSRLS voids all tenant isolation).
- [ ] **Rotate the exposed MongoDB credential** (from an earlier experiment; unused by this
      system but still live).
- [x] App connects as `shikhon_runtime` (non-BYPASSRLS) on the pooled endpoint.
- [x] Runtime password exists only in Vercel's `DATABASE_URL`; no local copies remain.
- [x] EdDSA JWTs, 15-min access / 30-day rotating refresh with reuse detection, as 01 §7.2.
- [ ] Wire DB maintenance functions to a scheduler (§8).
- [ ] KMS + field-level encryption for NID/BRC (01 §7.1) — columns must stay NULL until then.
- [ ] Production data-residency decision (Singapore → Bangladesh) before real PII lands.
- [ ] Curriculum-specialist verification of NCTB subject codes (06 §6).

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
