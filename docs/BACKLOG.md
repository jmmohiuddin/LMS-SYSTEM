# BACKLOG — the single list (D17)

**This is the only backlog.** Before this file existed the same items were
scattered across `PHASE_LOG.md` "classified but not implemented" tables,
`07-IMPLEMENTATION-STATUS.md` limitation bullets, `FINAL-FULL-PROJECT-AUDIT-PLAN.md`
severity rules and four "R-5: object storage · CSV export · …" lines that had
been copy-pasted forward through five phases. Nothing here is new work
invented for the file; every row cites where it came from.

Created **2026-09-01** at commit `95c34bf`, under D17 §10.
Last updated **2026-09-01** after **P5-0** — see
[PHASE_LOG.md](PHASE_LOG.md). Resolved rows keep their ID, their history and
their reason; nothing is deleted.

## How to use it

- **One row, one ID.** IDs are permanent. A resolved item keeps its ID and its
  row; it is never deleted (D10/D17). The historical narrative stays in
  [PHASE_LOG.md](PHASE_LOG.md); this file carries only the current state.
- **Category is about *when*, priority is about *how much*.** An item can be
  EXTERNAL DEPENDENCY and still be a pilot blocker — that is the normal case
  here, and the two columns say so independently.
- **Blocker** means: a pilot school cannot run without it. Not "important".
- When an item is fixed: set status **RESOLVED**, record the commit, and
  append the finding to `PHASE_LOG.md`. Do not remove the row.

## Status vocabulary

`OPEN` · `IN PROGRESS` · `BLOCKED` · `RESOLVED` · `RECLASSIFIED` ·
`SUPERSEDED` · `DEFERRED`

---

## 1. MUST FIX BEFORE PILOT

**Still open: `B-1`, `B-2`, `B-3`, `B-4`, `B-5`.** `B-6` is resolved and keeps
its row — the category says when an item *had* to be fixed, not whether it
still is, and deleting a closed row loses the reason it was ever opened.

| ID | Item | Why it matters | Phase | Priority | Blocker | Depends on | Status | Source |
|---|---|---|---|---|---|---|---|---|
| **B-1** | An SMS aggregator contract, and `OTP_SENDING_ENABLED=true` | Every SMS path in the product is built, suppression-aware and tested against a **fake** aggregator. Nothing has been sent to a real handset. | R-8 | HIGH | **Yes** for SMS login; **No** for a pilot that uses activation codes | Commercial contract (**external**) | **BLOCKED** — see also B-15 | PHASE_LOG R-8 "gates still open" |
| **B-2** | Web push observed on a real device | VAPID keys, subscription storage and the send path are implemented and unit-tested; no notification has ever arrived on a phone. Production now has a valid cert, so the last technical blocker is gone. | R-9 | HIGH | No | A pilot tenant with one real user | **OPEN** — est. 10 minutes once B-5 exists | PHASE_LOG R-8 |
| **B-3** | `ALERT_WEBHOOK_URL` set to something a human reads | `/ops/monitor` runs every 15 minutes on production and evaluates correctly. With no webhook it logs to a file nobody is watching, so an outage is discovered by a school phoning up. | R-8 | HIGH | **Yes** | One env var + a destination | **OPEN** | PHASE_LOG R-8 |
| **B-4** | Cross-tenant isolation probe **on production** | RLS posture was verified on the production database directly (227 policies, 0 tenants visible without context). The *probe* — tenant A's token reaching for tenant B's data through the live API — needs two tenants and production has none. | R-8 | HIGH | **Yes** | B-5 | **BLOCKED** on B-5 | PHASE_LOG R-8 |
| **B-5** | A first pilot institution | 0 institutions exist in production. Four gates below cannot be closed without one. | R-8 | HIGH | **Yes** | Owner / commercial | **OPEN** | PHASE_LOG R-8 |
| **B-6** | Class / section **edit** UI | `structure.ts` had GET and POST only. A section created with a typo could only be corrected with SQL, and the pilot runbook calls that a blocker. **The gap was never in the database** — migration 042 has allowed UPDATE on both tables for four roles since R-3. | Closure pass | HIGH | ~~Yes~~ | — | **RESOLVED** 2026-09-01 · `PATCH /api/v1/ops/structure` + a P2 drawer on the section-detail and per class-group screens. Renaming only: level, stream, group, parent class and year are refused, because they re-base every enrolment beneath them. 12 DB tests, browser-verified including the capacity refusal. | PHASE_LOG R-8 cleanup audit; closure pass |

## 2. SHOULD FIX BEFORE PILOT

**Still open: `B-9`, `B-10`.** `B-7` and `B-8` are resolved — `B-7` in P5,
by migration 050.

| ID | Item | Why it matters | Phase | Priority | Blocker | Depends on | Status | Source |
|---|---|---|---|---|---|---|---|---|
| **B-7** | Guardian **unlink** | `guardians.ts` has no DELETE, and migration 042 denies it at the database (`guardianship_delete_scope … USING (false)`) **deliberately** — its own comment says a family relationship should not have a delete button. **Audited in the closure pass; the constraint is exact:** `guardianships` has no `ended_on`/`revoked_at` column, so the model cannot express "this link ended". A soft-end column is the right answer and is not small — `guardianships` is read at **21 sites across 11 files**, including `sms-svc/dispatch.ts` and `ops-svc/api/notices.ts`, so a revoke that misses one keeps sending a stranger the child's absence texts; and both unique constraints plus `app.my_ward_ids()` / `app.can_see_student()` (read by RLS across the schema) must change with it. | P5 | HIGH | No | — | **RESOLVED** 2026-09-01 · migration 050. `revoked_at`/`revoked_by`/`revoked_reason`, all three or none; **nothing deleted**. Eleven of the twelve read paths closed by ONE restrictive SELECT policy rather than eleven edits — including `sms-svc/dispatch.ts`, whose query was not changed at all — and the three the policy cannot reach (two SECURITY DEFINER, one other DB role) rewritten explicitly. Refuses to remove the last contactable guardian of a student with no phone. 16 DB tests, twice; browser-verified. | PHASE_LOG R-8 cleanup audit; closure pass; P5 |
| **B-8** | ~~What `doLogout` does about the read-through caches~~ **RESOLVED 2026-09-01** | Every screen caches its last answer in a `shikhon_*` localStorage key. On a shared device the next person to sign in can be painted the previous user's data from cache before the network answers. P4 fixed this for the **demo role picker**, which is the surface a stranger can reach; a real logout still leaves the caches. Deliberately not fixed in P4: the sync outbox lives alongside them and may hold a teacher's unsent attendance, and losing that is worse than a stale screen. | Closure pass | HIGH | No | — | **RESOLVED** · `apps/pwa/src/local-data.ts` classifies local state in four tiers; logout clears session + screen caches + the Cache API and **never** touches the IndexedDB outbox. The question that made P4 defer it — what happens to a teacher's unsent attendance — is answered by the sync engine instead: a session flushes only ops matching its own `tenantId`/`actorId`, so another person's work is preserved rather than posted under the wrong token. A cache-rewrite race found in the browser is closed by a synchronous final sweep. 14 tests + three browser transitions. | PHASE_LOG P4, closure pass |
| **B-9** | AI soft-limit notification | `soft_limit_notified_at` is stamped at 80%; nothing is wired to R-2's notification system, so a principal learns of the limit by being refused. | P5/P6 | MEDIUM | No | — | **OPEN** | 07 §9j |
| **B-10** | Operator SSO for the Platform Console | Console sign-in is two pasted secrets. Expected at R-7, not built. | P7 | MEDIUM | No | — | **OPEN** | 07 §9j |

## 3. NICE TO HAVE

**Still open: `B-11`, `B-12`, `B-13`, `B-14`, `B-16`.** `B-15` is resolved.
`B-30` and `B-31` (below, opened by the closure pass) are resolved by P5-0.

| ID | Item | Why it matters | Phase | Priority | Blocker | Depends on | Status | Source |
|---|---|---|---|---|---|---|---|---|
| **B-11** | Audit export / actor-name resolution | The audit viewer exists and is reachable (`audit-view.ts`, in the nav for principal and IT admin). Export and human-readable actor names do not. | P5 | LOW | No | — | **OPEN** | PHASE_LOG R-8 cleanup audit |
| **B-12** | CSV export endpoints | `toCsv()` exists in the codebase and nothing calls it. Listed under R-5 for five phases without being built. | R-5 / P6 | LOW | No | — | **OPEN** | PHASE_LOG R-5 → R-8 |
| **B-13** | Multi-card ID layout | One ID card per sheet today. Cosmetic; a school prints more paper. | R-5 | LOW | No | — | **OPEN** | PHASE_LOG R-5 |
| **B-14** | Attendance date-range filter, and search type-ahead | Both are conveniences over working screens. | R-6 / P6 | LOW | No | — | **OPEN** | PHASE_LOG R-6 |
| **B-15** | A student-facing routine card | §4 lists "today's classes" first and the product could not answer it: `GET /rms/routine` wraps `app.teacher_day(claims.sub)`, so a student got their own empty teaching day. P4 left the card out rather than fabricate a timetable. | Closure pass | MEDIUM | No | — | **RESOLVED** 2026-09-01 · migration 049 `app.student_day` + `GET /academics/myroutine`. Section-scoped, parallel-block filtered through `student_subjects`, substitutions resolved to the covering teacher, gated by `app.can_see_student` so a guardian reads their own child and nobody reads a classmate. 18 DB/API tests + 10 UI tests. | PHASE_LOG P4, closure pass |
| **B-16** | Money formatting | Carried in the R-5 deferral line since R-5 and never closed. | R-5 | LOW | No | — | **OPEN** | PHASE_LOG R-5 → R-8 |

## 4. POST-PILOT

| ID | Item | Why it matters | Phase | Priority | Blocker | Depends on | Status | Source |
|---|---|---|---|---|---|---|---|---|
| **B-17** | Object storage | Documents render and print correctly without it; what is missing is a stored PDF. Also blocks photo/voice homework submission (F-902). | R-5 / post-pilot | MEDIUM | No | Storage provider (**external**) | **DEFERRED** | PHASE_LOG R-5, R-8 |
| **B-18** | Board-registration index | Confirmed a sequential scan today. At 3–5 schools that is genuinely fine, and every index costs write throughput on the student import — the largest write in the product. The pilot produces the numbers that should decide it. | post-pilot | LOW | No | B-5 (real data volumes) | **DEFERRED** — deliberately, with a stated trigger | PHASE_LOG R-8 |
| **B-19** | The seven legacy student/guardian views | `my-attendance`, `results`, `assignments`, `fees`, `documents`, `learn`, `subjects` render themselves rather than using the P2 components. All are accessible, responsive and green across 48 browser configurations. Migrating a working screen is risk with no user-visible benefit. | P5/P8 | LOW | No | — | **OPEN** — listed rather than done, on purpose | PHASE_LOG P4 |
| **B-20** | Section chat | R-9's remaining item. Moderation and child-safety design is not started and is gated on pilot stability (D9). | R-9 | LOW | No | B-5 | **NOT STARTED** | Master Plan D9, R-9 |

## 5. EXTERNAL DEPENDENCY

These cannot be closed by writing code. Listed separately so a reader never
mistakes "not done" for "not attempted".

| ID | Item | What is blocked | Owner action needed | Status |
|---|---|---|---|---|
| **B-1** | SMS aggregator contract | Real SMS delivery, SMS-based OTP login | Sign an aggregator | **BLOCKED** |
| **B-5** | A pilot institution | B-2, B-4, B-18, and the "under one hour onboarding" measurement | Commercial | **OPEN** |
| **B-17** | Object storage provider | Stored PDFs, photo/voice submissions | Choose a provider | **DEFERRED** |
| **B-21** | Data residency decision, PII master-key custody, MFS credentials | Reported as not-done on the readiness screen; none can be closed from the repository | Owner | **OPEN** (source: 07 §9j) |

## 6. OBSOLETE / SUPERSEDED

Kept, never deleted, so a reader who finds the old claim elsewhere can see how
it ended.

| ID | Item | Outcome | Date | Reference |
|---|---|---|---|---|
| **B-22** | "`GET /sync/pull` is unused — bug" | **RECLASSIFIED, not a bug.** Built, mounted, tested, working; no client calls it. That is an unused capability. Deleting it discards working tested code; wiring it up is a feature. It stays and stops being listed as a defect. | 2026-08-31 | PHASE_LOG R-8 cleanup audit |
| **B-23** | R-7.10 "Billing the schools is out of scope" | **SUPERSEDED by D16** from R-7 onward. Stands as written for R-7 itself. Implementation belongs to **P7**; P2–P6 must not build it. | 2026-09-01 | Master Plan D16 |
| **B-24** | "No audit viewer — backend complete, UI pending" | **RESOLVED** in R-3's completion pass. `audit-view.ts` exists and `audit` is in the navigation for principal and IT admin. The stale bullet survived in `07-IMPLEMENTATION-STATUS.md` §9e until D17's reconciliation found it contradicting §1 of the same file. | 2026-08-29, found 2026-09-01 | 07 §9e, corrected |
| **B-25** | "Guardian management is read-only" | **RESOLVED** in R-3's completion pass. `guardian-panel.ts` posts a new link and patches `canPayFees`. Same stale bullet as B-24. Unlinking is still missing and is tracked separately as **B-7**. | 2026-08-29, found 2026-09-01 | 07 §9e, corrected |
| **B-26** | Neon + Vercel as the deployed architecture | **SUPERSEDED in practice** by the VPS + Caddy + Docker-PostgreSQL deployment of 2026-08-31. The blueprint documents have **not** been rewritten, on purpose — see B-27. | 2026-08-31 | Master Plan §5b |

### Opened by the closure pass

| ID | Item | Why it matters | Phase | Priority | Blocker | Status | Source |
|---|---|---|---|---|---|---|---|
| **B-30** | The permission message on the remaining student screens | The closure pass fixed roster, marks and the guardian home. Auditing every student-accessible view in P5-0 found the same shape in **nine**, and **five different wordings** for one condition. Worse than the wording: a 403 left the refused data on screen, out of a cache. | P5-0 | LOW→HIGH once measured | No | **RESOLVED** 2026-09-01 · one `permissionMessage(subject?)` that `humanError` and `permissionState` both route through; `http-status.ts` carries the status through the throw; every screen drops its cache on a refusal and offers no retry. 23 tests. **Note:** on six of the nine a 403 is not currently reachable — those endpoints are RLS-scoped and answer with an empty payload, so the handling is defensive and is documented as such. | closure pass, P5-0 |
| **B-31** | `tsc -p .` does not cover `apps/pwa` | The root `tsconfig.json` **excludes** it. CI runs three configs; anyone running one locally typechecks the services and not the app. P4's, D17's and the closure pass's gate tables all recorded "TypeScript ×3" meaning three runs of one config. | P5-0 | MEDIUM | No | **RESOLVED** 2026-09-01 · `npm run typecheck` → `scripts/typecheck.mjs`, which **parses the CI workflow** for its config list so the two cannot drift, and fails when any new `.ts` appears outside every config. Verified in all three directions, including by catching its own author's new test file. | closure pass, P5-0 |

### Opened by P5-0

| ID | Item | Why it matters | Phase | Priority | Blocker | Status | Source |
|---|---|---|---|---|---|---|---|
| **B-32** | **46 test files are typechecked by nothing** | 34 `apps/pwa/test`, 7 `packages/ui-core/test`, 3 `services/sync-svc/test`, 2 `packages/offline/test`. The 592 tests guarding the application are themselves unchecked, so a test can be quietly wrong about a type and still pass. Measured cost of closing it: `@types/jsdom` plus **73 pre-existing errors** in test code. (The other 14 unchecked files are the `/design` prototype, outside the product by D14.) Frozen at 61 by `scripts/typecheck-baseline.json`, so it cannot grow. | P6 | MEDIUM | No | **OPEN** | P5-0 |
| **B-33** | `demo-gate.test.ts` skips `index.ts` | The derivation assumes `index.ts` is a dispatcher; `finance-svc` and `identity-svc` put real handlers in theirs, so a role gate added there would be invisible. **Verified by hand in P5-0: no gap today.** Automating it needs the `ROUTES` table parsed to map handler names to path segments. | P6 | LOW | No | **OPEN**, noted in the test | P5-0 |

### Opened by P5

| ID | Item | Why it matters | Phase | Priority | Blocker | Status | Source |
|---|---|---|---|---|---|---|---|
| **B-34** | The Principal's other screens and **all** IT Admin screens keep pre-P2 markup | P5 delivered B-7 and the Principal dashboard. `academic`, `students`, `publish`, `calendar`, `documents`, `audit`, settings, users, imports and branding are unchanged, and the audit viewer's UX (actor names, filters, changed fields, permission-aware redaction) is still what R-3 shipped. | **P5, continuing** | HIGH | No | **OPEN** | P5 |

## 7. DOCUMENTATION DEBT

| ID | Item | Why it matters | Phase | Priority | Blocker | Status |
|---|---|---|---|---|---|---|
| **B-27** | Decide which architecture is the target, then reconcile `D1`, `06-DEPLOYMENT.md` and `12-PRODUCTION-RUNBOOK.md` | Production runs a VPS with a Docker PostgreSQL; those three documents describe Neon + Vercel. Both are currently true of different things and the drift is disclosed in Master Plan §5b. It must not be silently rewritten to match production — a reader must not be told the blueprint was always the VPS. The correction needs an owner decision about which is the *target*. | — | MEDIUM | No | **OPEN — needs an owner decision** |
| **B-28** | `shikhonbd.com` still appears in source comments, two operator-facing Bangla strings, the marketing footer's contact address and the default VAPID subject, while production serves `sikhon.systems` | No logic depends on it; the drift is in prose and defaults. | P6/P8 | LOW | No | **OPEN** (source: FINAL-PRODUCT-SURFACE-ARCHITECTURE §14) |
| **B-29** | "Onboarded in under one hour" is **UNMEASURED** | The measurement machinery exists (`audit.platform_access` timestamps, `scripts/pilot-report.mjs`), and counts nothing that has not been designated a pilot. The only onboardings on record are seeded fixtures and the author's own walkthroughs. The target must not be claimed until B-5. | R-7/R-8 | — | No | **OPEN**, dependent on B-5 |
