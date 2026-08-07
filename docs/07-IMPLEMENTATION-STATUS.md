# 07 — Implementation Status: Blueprint vs. As-Built

Documents 01–06 are the design blueprint. This document is the reconciliation: what is
actually deployed today, where the implementation deliberately diverges from the blueprint,
how to operate it, and what remains. Last updated **2026-08-07**; current production commit
`5b117f4`.

---

## 1. Current state at a glance

| | |
|---|---|
| Production URL | `https://shikhon-lms.vercel.app` |
| Hosting | Vercel (Hobby plan) — static PWA + 12 Serverless Functions |
| Database | Neon PostgreSQL 18.4, database **`shikhon_lms`**, Singapore (`ap-southeast-1`) — see [06-DEPLOYMENT.md](06-DEPLOYMENT.md) |
| Repo | `github.com/jmmohiuddin/LMS-SYSTEM`, branch `main` |
| Tests | **109/109 passing** (`node --test`, zero dependencies beyond `pg`/`jose`/`esbuild`) |
| Schema | 15 migrations, 88 tables, 103 RLS policies, verified via 3 SQL assertion suites |
| Login | **Temporarily disabled** by a two-sided kill switch (§5) |
| Preview | **`https://shikhon-lms.vercel.app/?demo=1`** — every screen, sample data, no login (§6) |

What a teacher can do today (once login is re-enabled): log in with phone + OTP, see their
day/week routine (substitutions included), pick a section and see its roster, take
attendance fully offline with queued sync, and keep working through network loss.

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

## 3. Deployed API surface (the 12 functions)

Built by [`scripts/build.mjs`](../scripts/build.mjs): each entry is esbuild-bundled (whole
`services/` + `packages/` graph inlined, only `pg` external) into `api/`, which Vercel's
file-based routing serves. **The Hobby plan hard-caps a deployment at 12 Serverless
Functions** — this table is at that cap; adding a 13th endpoint requires merging routes
(as was done for the MFS webhooks) or upgrading the plan.

| Route | Source | Auth | Notes |
|---|---|---|---|
| `POST /api/v1/auth/otp/request` | `services/identity-svc/api/otp-request.ts` | public | **503 `otp_disabled` while the kill switch is on** (§5) |
| `POST /api/v1/auth/otp/verify` | `services/identity-svc/api/otp-verify.ts` | public | Issues EdDSA access (15 min) + rotating refresh (30 d) |
| `POST /api/v1/auth/refresh` | `services/identity-svc/api/refresh.ts` | refresh token | Rotation with reuse detection |
| `POST /api/v1/auth/logout` | `services/identity-svc/api/logout.ts` | refresh token | Best-effort revoke |
| `POST /api/v1/sync/push` | `services/sync-svc/api/push.ts` | JWT | Outbox op batches; idempotent on `opId`; per-op applied/duplicate/conflict/rejected results (03 §1.1) |
| `GET /api/v1/sync/pull` | `services/sync-svc/api/pull.ts` | JWT | Cursor-based delta pull (03 §1.2) |
| `GET /api/v1/academics/sections` | `services/academics-svc/api/sections.ts` | JWT | Section picker feed |
| `GET /api/v1/academics/roster` | `services/academics-svc/api/roster.ts` | JWT | Roster by `sectionId` |
| `GET /api/v1/rms/routine` | `services/rms-svc/api/routine.ts` | JWT | Teacher day/week view; wraps `app.teacher_day()`, substitutions merged in |
| `POST /api/v1/rms/solve` | `services/rms-svc/api/solve.ts` | JWT (coordinator) | Routine generation (§7) |
| `GET/POST /api/v1/sms/dispatch` | `services/sms-svc/api/dispatch.ts` | `CRON_SECRET` | Outbox drain; **send is a stub** — no aggregator credentials yet. Cron: daily `0 18 * * *` UTC = 00:00 BST (Hobby allows only daily crons) |
| `POST /api/v1/finance/webhooks/{bkash,nagad,rocket}` | `services/finance-svc/api/webhooks/[provider].ts` | webhook signature | One dynamic-route function for all three providers; unknown provider → 404. Shared logic in `services/finance-svc/src/webhook.ts` per 03 §2.4 |

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

## 5. Login is currently disabled — the kill switch

Login was intentionally disabled (2026-08-07) while SMS sending is unresolved. It is a
**two-sided, code-level switch**; the two constants are cross-referenced in comments and
must be flipped together:

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
`CRON_SECRET`, `SERVICE_API_KEY`.

**Cron:** one Hobby-safe daily job in `vercel.json` — `/api/v1/sms/dispatch` at 00:00 BST.
The three DB maintenance functions of 06 §5 (`app.maintain_partitions()` etc.) still need an
external scheduler — currently **not wired**; watch `v_default_partition_leakage`.

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

Mapped to the phasing of [05-DELIVERY-ROADMAP.md](05-DELIVERY-ROADMAP.md):

| Gap | Blueprint ref | Phase |
|---|---|---|
| Real SMS aggregator (send + DLR webhook); then re-enable login | 03 §3 | 1 |
| Guardian absence-notification flow end-to-end (enqueue exists; send is stubbed) | 01 §3 events | 1 |
| Attendance correction flow + absence-SMS grace window | 01 §2.6 | 1 |
| MFS gateways with real merchant credentials + signature verification per provider | 03 §2 | 2 |
| Exam marks entry, GPA, report cards | 05 Phase 2 | 2 |
| Fee invoices, ledger, receipts | 05 Phase 2 | 2 |
| CP-SAT solver upgrade; coordinator routine-editing UI | 02 §3 | 3 |
| SikhokAI / ShikhoAI + RAG over NCTB corpus (pgvector is installed and indexed, unused) | 01 §6 | 3 |
| ANS alumni integration | 03 §4 | 4 |
| Answer-script photo pipeline | 01 §2.7 | 2–3 |
| Function-count headroom: upgrade plan or merge routes before adding endpoints | — | any |
