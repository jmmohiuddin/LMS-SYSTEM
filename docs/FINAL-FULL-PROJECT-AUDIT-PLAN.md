# Final full-project audit — preparation and specification

**This document is not the audit.** It is the permanent specification for the
independent final audit of shikhonBD, written so that an auditor who has never
seen this project and has no access to any prior conversation can read this one
file and know exactly what to do.

**Do not begin the audit until all four are true:**

1. R-8 is closed — every external gate in
   [12-PRODUCTION-RUNBOOK.md](12-PRODUCTION-RUNBOOK.md) §0a is ticked from
   observation.
2. Production is real — a deployment serving real traffic.
3. The pilot is complete — 3–5 real institutions have used the system.
4. Pilot blockers are resolved.

Auditing before then produces a report about a system that does not yet exist.

---

## 0. What this product is, in one page

A multi-tenant, white-label, offline-first school management SaaS for
Bangladesh. One codebase, one database, many schools. Bangla-first.

**Six human roles** and one platform role. The database knows twelve role codes
(`academic_coordinator`, `accountant`, `class_teacher`, `dept_head`, `guardian`,
`it_admin`, `librarian`, `principal`, `school_owner`, `student`,
`subject_teacher`, `super_admin`), of which the six the product actually drives
are Principal, IT Admin, Teacher, Student, Guardian, and the platform's own
Super Admin.

**Ten services** under `services/`: `academics-svc`, `ai-svc`, `ans-svc`,
`finance-svc`, `identity-svc`, `ops-svc`, `platform-svc`, `rms-svc`, `sms-svc`,
`sync-svc`. They are bundled by `scripts/build.mjs` into a small number of
serverless functions under `api/v1/` (a hosting function-count cap forced the
dispatcher pattern — one function serving many sub-routes).

**Four database roles**: `shikhon_owner` (migrations and maintenance),
`shikhon_app` (the runtime — RLS-bound), `shikhon_platform` (the operator
console — also RLS-bound), `shikhon_readonly`.

**Tenant isolation is PostgreSQL RLS**, not application filtering. A permissive
`tenant_isolation` policy plus restrictive per-role scopes, driven by session
GUCs (`app.tenant_id`, `app.user_id`, `app.role`) that `withTenant()` sets with
`SET LOCAL`.

**The PWA** (`apps/pwa`) is framework-free: hand-rolled DOM, a hash router, an
IndexedDB outbox, a service worker. Attendance is offline-first.

---

## 1. Audit philosophy

These are not preamble. Each one exists because its opposite has already
produced a wrong answer in this project.

### 1.1 Do not trust documentation blindly

Every document in `docs/` was written by the same agent that wrote the code,
and at least one has been materially wrong. The `README.md` claimed **"Built
and deployed"** about seven services while nothing was deployed. Treat every
document as a *claim to be checked*, and when code and documentation disagree,
**the code is the truth and the documentation is a bug**.

### 1.2 Do not trust existing tests blindly

There are ~1160 automated tests and they pass. That is not the same as being
correct. This project has produced, at least twice, a test that passed for the
wrong reason:

- `db/tests/product_events.sql` reached its "the rollup crosses tenants"
  assertion **with a tenant GUC still set**, so with one tenant's data it never
  took the path it claimed to test. It passed for months.
- The whole suite ran green for **six commits** while `npx tsc --noEmit` was
  failing, because `node --test` **strips** types rather than checking them.
  Ten type errors, three of them real user-visible defects.

**Sample the tests adversarially.** Pick the ten most important assertions,
break the production code on purpose, and confirm each test actually fails. A
check that cannot fail is not a check.

### 1.3 Verify code against behaviour

Read the handler, then call the endpoint, then look in the database. All three.
A comment describing a safety property is a hypothesis.

### 1.4 Attack tenant isolation

Do not confirm it — try to break it. §5 is the matrix; §3 is the attack list.
Two real tenants with real data, and every probe run in both directions
(A→B and B→A), because a policy can be asymmetric.

### 1.5 Test real browser workflows

The product is a PWA used on cheap Android phones on poor connections. Assert
what a person sees on a screen, not what an endpoint returns. A feature whose
backend exists and whose screen does not is **not implemented** (see D13, §6).

### 1.6 Inspect the real database and its RLS

Connect as `shikhon_app`, set the GUCs, and try to read another school's rows.
Read `pg_policies` directly. Do not infer isolation from the absence of a leak
in an API response.

### 1.7 Verify production evidence

`docs/production-evidence.json` holds one entry per external gate, with
`status` (`null` | `blocked` | `rehearsed` | `pass`), `date`, `environment`,
`evidence`, `result`. **Check that each `pass` is real** — re-perform the
observation, or at minimum confirm the environment field names the production
deployment and not a laptop.

### 1.8 Distinguish observed evidence from assumption

Every finding in your report carries what you *did* and what you *saw*. "Tenant
isolation is enforced" is an assumption. "As `shikhon_app` with
`app.tenant_id` = A, `SELECT count(*) FROM users WHERE tenant_id = B` returned
0, and the same query with A returned 2061" is evidence.

---

## 2. Full system scope

Everything below is in scope. For each, the audit answers: **does it work, for
the right people only, with the right data, visibly, and under failure?**

| # | Area | Where it lives | Notes for the auditor |
|---|---|---|---|
| 1 | Platform Super Admin | `services/platform-svc`, `apps/pwa/src/platform.ts`, `/platform` | Three credentials: a `super_admin` JWT, `PLATFORM_API_KEY`, and a separate `PLATFORM_DATABASE_URL` role. A tenant role must never reach it |
| 2 | Tenant onboarding | platform-svc + the nine-screen wizard | Must complete end to end **without SQL**. Four institution types: school, college, madrasa, school & college |
| 3 | Principal | `ops-svc/api/dashboard.ts`, `assign`, `rollover`, `structure` | Tenant-wide authority inside one school |
| 4 | IT Admin | `ops-svc/api/users.ts`, `enrol`, `branding`, `settings`, imports | Administrative, not academic |
| 5 | Teacher | `academics-svc` roster/attendance/marks | **Assigned sections only** — the most commonly wrong boundary |
| 6 | Student | `academics-svc` own record, results, documents | Own data only |
| 7 | Guardian | `academics-svc/api/ward.ts` | Linked children only; multi-child switcher |
| 8 | Authentication | `identity-svc` — OTP, activation codes, EdDSA JWT, refresh rotation | Activation codes are single-use, 72h, HMAC-stored under `ACTIVATION_PEPPER` |
| 9 | Authorization | `packages/server-core/src/auth.ts`, `role_permissions`, RLS | Two layers: application role checks AND database policies |
| 10 | Multi-tenancy | RLS across ~110 tables | §5 |
| 11 | Academic structure | classes, sections, subjects, `subject_catalogue`, curriculum | HSC (11–12) codes are **ours**, `H-` prefixed, not board codes |
| 12 | Enrolment & history | `enrolments`, `year_rollovers`, `student_profiles` | Multi-year history must survive rollover |
| 13 | Attendance | `attendance_sessions`, partitioned `attendance_records` | Partitions are pre-created by a cron; see §10 |
| 14 | Offline sync | `packages/offline`, `sync-svc` | §7 |
| 15 | Notices | `ops-svc/api/notices.ts`, `notice_receipts` | Audience resolution + a ≥200-message confirmation gate |
| 16 | Notifications | in-app inbox | |
| 17 | SMS | `sms-svc`, `sms_outbox` (partitioned), DLR | Bangla forces UCS-2: 70 chars/segment. ~80% of infrastructure cost |
| 18 | Web push | `packages/server-core/src/web-push.ts` (RFC 8291/8292), `push_subscriptions` | Endpoint is globally UNIQUE across tenants — deliberate |
| 19 | Calendar | `ops-svc/api/calendar.ts`, `calendar_days` | Weekends differ: madrasas commonly Friday-only |
| 20 | Exams & results | `exams`, `exam_marks`, `exam_results`, `grading_bands` | Publication is a gate; grading bands must exist or grades are NULL |
| 21 | Finance | `invoices`, `payment_receipts`, `ledger_entries`, MFS webhooks | Double-entry ledger |
| 22 | Documents & printing | `packages/ui-core/src/documents.ts` | Tenant-branded; a school's name, never the platform's |
| 23 | Search & history | `academics-svc/api/search.ts`, `studenthistory.ts` | |
| 24 | PWA | `apps/pwa` | Framework-free; check the bundle budget (180 KB gzipped) |
| 25 | Service worker | `apps/pwa/src/sw.ts` → `public/sw.js` | §7 |
| 26 | Monitoring | `ops-svc/api/monitor.ts`, `server-core/src/alerts.ts` | 7 conditions, webhook delivery |
| 27 | Backups | `scripts/restore-drill.mjs` | §10 |
| 28 | Deployment | `scripts/build.mjs`, `vercel.json`, `netlify.toml` | Committed `api/` bundles must match a fresh build |
| 29 | DNS/TLS | wildcard `*.shikhonbd.com` + `/app?tid=` fallback | Both must work |
| 30 | External integrations | SMS aggregator, MFS (bKash/Nagad/Rocket), push services, Anthropic API | Each behind a feature switch |

---

## 3. Security attack matrix

Run every row. Record the request, the response, and what the database
contained afterwards. **A refusal is only proved by also showing the same
request succeeding for the legitimate caller** — otherwise a broken endpoint
looks identical to a secure one.

`scripts/security-probe.mjs` already automates 29 of these against a running
deployment; it discovers its own fixtures, so it runs anywhere. **Start there,
then go beyond it** — it is a floor, not a ceiling, and it was written by the
same agent that wrote the code.

| # | Attack | Method | Expected |
|---|---|---|---|
| 1 | Tenant switching via header | Valid JWT for A + `X-Tenant-ID: B` | Header ignored; A's data only |
| 2 | Tenant switching via body | `tenantId: B` in a POST/PUT body | Ignored or refused; nothing written to B |
| 3 | Tenant switching via query | `?tenantId=B` | Ignored |
| 4 | `tenant_id` manipulation in sync payload | `POST /sync/push` with B's ids | Not applied |
| 5 | URL manipulation | A's token requesting B's resource by uuid | 403/404, never B's data |
| 6 | IDOR — student | A's principal reads B's `studentId` | Denied |
| 7 | IDOR — invoice, result, notice, document | Same, each resource | Denied |
| 8 | Privilege escalation — role claim | Forge `role: principal` in an unsigned/altered JWT | Signature check refuses |
| 9 | Privilege escalation — self-grant | Teacher calls the role-assignment endpoint | Denied |
| 10 | Role boundary — teacher → unassigned section | Teacher reads a section they do not teach | Denied |
| 11 | Role boundary — teacher → school-wide action | Teacher creates a class/section | Denied (covered by `db/tests/guardian_links.sql`) |
| 12 | RLS bypass — no GUC | Connect as `shikhon_app`, set nothing, `SELECT * FROM users` | 0 rows |
| 13 | RLS bypass — role privilege | `SELECT rolsuper, rolbypassrls FROM pg_roles` for all `shikhon_*` | All false |
| 14 | RLS bypass — FORCE | Tables with `tenant_id` but `relrowsecurity = false` | None (two documented exceptions — verify the reasoning still holds) |
| 15 | Service-key abuse — from a browser | Valid `SERVICE_API_KEY` + `Origin`/`Cookie`/`Sec-Fetch-Site` | 403 `service_key_from_browser` |
| 16 | Service-key abuse — in production | Tenant switching with `NODE_ENV=production` and the flag off | 403 `service_tenant_switch_disabled` |
| 17 | Service-key abuse — as a user | Ordinary user token on `/ops/monitor`, `/ops/maintenance` | 401 |
| 18 | JWT abuse — expired | Expired access token | 401 |
| 19 | JWT abuse — refresh reuse | Replay a used refresh token | Whole family revoked |
| 20 | JWT abuse — algorithm | `alg: none`, or HS256 signed with the public key | Refused |
| 21 | Sensitive-response leakage | Diff every response against what the role should see | No phone numbers, NID/birth-registration, or marks outside scope |
| 22 | Document leakage | Guardian prints another family's receipt / report card | Denied (`db/tests/documents.sql`) |
| 23 | Guardian privacy | Guardian opens an unlinked child | Denied (3 existing assertions — verify they fail when broken) |
| 24 | Student privacy | Student reads another student | Denied |
| 25 | SSRF — push endpoint | `POST /ops/push` with `http://`, loopback, `169.254.169.254`, private ranges, userinfo, `.internal`, `.local` | All refused |
| 26 | SSRF — webhook config | Any other client-supplied URL that the server fetches | Same guard |
| 27 | XSS — stored | School name, notice body, student name, device label with `<script>`/`<img onerror>` | Escaped on render; check the print templates too |
| 28 | XSS — reflected | Query params echoed into the DOM | Escaped |
| 29 | CSRF | Cookie-based auth? | **N/A today** — bearer tokens only, no ambient credential. If cookies are ever added, this becomes CRITICAL |
| 30 | Rate-limit bypass | Vary IP, phone, token; check per-identity buckets | `otp_request` is 3/hour per phone |
| 31 | Notification leakage | Push/inbox delivered to a non-recipient | Denied |
| 32 | SMS recipient leakage | Notice audience resolution returns numbers outside the audience | Denied; also verify `SMS_TEST_RECIPIENTS` suppression |
| 33 | Secret exposure | Grep `app.js`, `platform.js`, `sw.js` for every live secret value and for `postgres://` | None |
| 34 | CORS | Unlisted origin; credentialed request | Not echoed; `Allow-Credentials` never set |
| 35 | Error leakage | Malformed input on every endpoint | No connection strings, stack traces, or credentials |

---

## 4. Role matrix

Fill this in **from observation**, not from `role_permissions`. The database
table is a claim; the audit checks behaviour.

Classifications: **allow** · **deny** · **conditional** (state the condition) ·
**own-data only** · **assigned-section only** · **tenant-wide**

| Capability | Platform Admin | IT Admin | Principal | Teacher | Guardian | Student |
|---|---|---|---|---|---|---|
| Create a tenant | allow | deny | deny | deny | deny | deny |
| Suspend/activate a tenant | allow | deny | deny | deny | deny | deny |
| View tenant health | allow | deny | deny | deny | deny | deny |
| Provision academic structure | allow | | | deny | deny | deny |
| Set branding | allow | | | deny | deny | deny |
| Create/edit users | | | | deny | deny | deny |
| Assign roles | | | | deny | deny | deny |
| Issue activation codes | allow | | | deny | deny | deny |
| Import teachers | | | | deny | deny | deny |
| Import students | | | | deny | deny | deny |
| Create class / section | deny¹ | | | deny | deny | deny |
| Assign class teacher | deny¹ | | | deny | deny | deny |
| Assign subject teacher | deny¹ | | | deny | deny | deny |
| View roster | deny¹ | tenant-wide | tenant-wide | assigned-section only | own children | own only |
| Take attendance | deny¹ | | | assigned-section only | deny | deny |
| Correct past attendance | deny¹ | | | conditional | deny | deny |
| View attendance | deny¹ | tenant-wide | tenant-wide | assigned-section only | own children | own only |
| Enter marks | deny¹ | deny | | assigned-section only | deny | deny |
| Publish results | deny¹ | deny | | deny | deny | deny |
| View results | deny¹ | tenant-wide | tenant-wide | assigned-section only | own children | own only, published only |
| Create/publish a notice | deny¹ | | | conditional | deny | deny |
| Read a notice | deny¹ | | | | audience only | audience only |
| Edit the calendar | deny¹ | | | deny | deny | deny |
| Create invoices | deny¹ | | | deny | deny | deny |
| Record a payment | deny¹ | | | deny | deny | deny |
| View fees | deny¹ | tenant-wide | tenant-wide | deny | own children | own only |
| Print a receipt | deny¹ | | | deny | own children | own only |
| Print report card / admit card / ID | deny¹ | | | conditional | own children | own only |
| Global student search | deny¹ | tenant-wide | tenant-wide | assigned-section only | deny | deny |
| View student history | deny¹ | tenant-wide | tenant-wide | conditional | own children | own only |
| Year rollover | deny¹ | | | | deny | deny |
| Change school settings | deny¹ | | | deny | deny | deny |
| Register a push device | deny¹ | own only | own only | own only | own only | own only |
| Read the audit log | allow² | | | deny | deny | deny |
| Run maintenance / monitor | service key only | deny | deny | deny | deny | deny |

¹ The platform operator deliberately does **not** get tenant data access. The
console shows counts and timestamps, never people. Verify this: an operator
browsing pupil records is exactly what tenant isolation exists to prevent.

² `audit.platform_access` (platform actions) vs `audit.activity_log` (a
school's own history, readable by its management). Different logs, different
audiences — verify neither leaks into the other.

**Blank cells are the audit's job.** Do not fill them from this document.

---

## 5. Tenant isolation matrix

**Use at least two real tenants with real data.** Name them A and B and record
their uuids in the report. Run every cell **in both directions**.

For each resource, three observations:

1. **A → A's own resource** → allowed (proves the endpoint works at all)
2. **A → B's resource, by uuid** → denied, and B's data absent from the body
3. **A → B's resource, by every manipulation route** → denied

The manipulation routes, applied to every row: URL/path uuid · `?tenantId=`
query · `tenantId` in the request body · `X-Tenant-ID` header · `X-User-ID`
header · `X-Role` header · a sync payload naming B's ids.

| Resource | A → A | A → B | Where to verify in the DB |
|---|---|---|---|
| Student | | | `student_profiles`, `users` |
| Teacher | | | `staff_profiles`, `user_roles` |
| Guardian | | | `guardianships` |
| Class | | | `classes` |
| Section | | | `sections` |
| Attendance | | | `attendance_sessions`, `attendance_records` |
| Result | | | `exam_marks`, `exam_results` |
| Invoice | | | `invoices`, `invoice_lines`, `payment_receipts` |
| Notice | | | `notices`, `notice_receipts` |
| Notification | | | inbox endpoints |
| Calendar | | | `calendar_days` |
| Document | | | generated output + `nctb_documents` |
| Branding | | | `tenants.settings`, `/ops/brand` |
| Push subscription | | | `push_subscriptions` — endpoint is globally unique; a shared device must not cross-leak |

**Also verify at the database, not only through the API:** connect as
`shikhon_app`, `SET LOCAL app.tenant_id` to A, and attempt to read each of B's
rows by primary key. Expect 0 every time, and expect A's own rows to be
visible in the same session — a policy that returns nothing for everyone is
broken, not secure.

---

## 6. UI/UX audit — D13 applies to everything

**D13 is a standing project rule:** a feature is complete only across
**Backend → API → UI → Loading → Empty → Error → Success → Permission → Tenant
isolation → Tests → Browser acceptance.** A feature whose database and endpoint
exist but whose screen does not is reported as *"Backend complete — UI
pending"*, never as implemented.

For every screen in the product:

| Check | What a failure looks like |
|---|---|
| Loading | A spinner that never resolves; a screen that renders empty before data arrives and never repaints |
| Empty | "0 results" where the real message is "you have no classes yet, here is how to add one" |
| Error | A raw 500 body, an English stack trace, or silence |
| Success | A write that appears to work and did not — verify in the database |
| Validation | Client-side only; server accepts what the form rejected |
| Permission denied | A button visible to someone who cannot use it, or a 403 rendered as a crash |
| Responsive | Test at 360×640 (the common cheap Android), 768, and desktop |
| Mobile | Touch targets; the attendance grid used one-handed |
| Bangla | Untranslated English; Latin digits where Bangla belongs — **and Bangla digits where Latin belongs** (money and identifiers are ALWAYS Latin) |
| Accessibility | Missing labels, no focus states, colour-only status, `aria-live` on things that change |
| Dead buttons | A control with no handler, or one whose handler cannot succeed |
| Misleading states | A green tick for something unverified — the whole R-8 lesson |
| Wrong counts | A badge that does not match the list beneath it |
| Stale UI | A value that does not refresh after a write |
| Backend-only features | Endpoints with no screen. Enumerate them |
| Broken navigation | A hash route that 404s; a back button that loses state |
| Incorrect role menus | A teacher seeing a principal's menu item |

**Known trap:** re-rendering. This project has shipped a gate whose checkbox
was drawn by `render()` while the enabling code path only called a partial
update — the control existed and could never be reached. When you find a
conditional control, exercise the *transition into* the condition, not just the
state.

---

## 7. Offline audit

The product's central claim is that a teacher can take attendance with no
network. Test it on a **real device on real mobile data**, not a throttled
dev-tools profile.

| # | Test | Expected |
|---|---|---|
| 1 | Cached app | Second visit loads with the network off |
| 2 | Offline login | Define and verify the intended behaviour — a session already held should survive; a cold login cannot |
| 3 | Attendance offline | Full register recorded, visibly saved |
| 4 | Sync queue | Rows in the IndexedDB outbox; the UI says how many are pending |
| 5 | Reload while offline | The register survives a page reload |
| 6 | Reconnect | Sync starts without the user asking |
| 7 | Duplicates | Re-syncing the same batch changes nothing (`op_id` is the idempotency key) |
| 8 | Conflicts | Two devices, same section, same day — the resolution is deterministic and the loser is told |
| 9 | Stale cache | After a deploy, the old bundle is not served indefinitely |
| 10 | Service-worker upgrade | New SW activates; no half-old/half-new state |
| 11 | Old bundle invalidation | Hard-refresh not required for a user to get the fix |

**Verify from the server, not the phone.** R-7 shipped a version where every
attendance push was rejected for a malformed academic-year id, and the only
symptom a teacher saw was a small *"১টি পাঠানো যায়নি"*. `/sync/push` returns
**200 with the rejection inside the body**. Check `sync_operations.result` and
`conflict_detail`, and have a second person confirm the register from another
device.

---

## 8. Data integrity

| # | Check | How |
|---|---|---|
| 1 | Historical enrolment | A student who moved sections retains both years |
| 2 | Yearly rollover | `year_rollovers` — promotion preserves history; nothing overwritten |
| 3 | Teacher replacement | `class_teacher_assignments` keeps the previous holder with dates |
| 4 | Attendance history | Partitions across months are all readable; no gap at a month boundary |
| 5 | Results | Published results immutable; corrections tracked in `mark_corrections` |
| 6 | Financial records | `ledger_entries` balance; a receipt always has an invoice |
| 7 | Documents | Regenerating a document reproduces the same figures |
| 8 | Guardian relationships | Exactly one primary guardian per student; re-linking updates, never duplicates |
| 9 | No destructive overwrites | No endpoint replaces a history row. **Classes and sections must not be DELETE-able** — enrolment history hangs off them |
| 10 | Foreign keys | Every FK present and enforced; run after a restore too |
| 11 | Uniqueness | Tenant slug, EIIN, student code per tenant, push endpoint globally |
| 12 | Orphan records | Rows whose parent is gone — query each FK for orphans |

**Trap:** `ON CONFLICT` treats NULLs as DISTINCT unless `NULLS NOT DISTINCT`.
Any "idempotent" upsert with a nullable column in its conflict target may be
silently inserting duplicates. Check each one.

**Trap:** `jsonb_set(x, '{a,b}', v, true)` is a **silent no-op** when the parent
key `a` is absent. This shipped once: settings returned 200, the screen said
সংরক্ষিত, and nothing was written. Grep for `jsonb_set` and verify each against
a row that lacks the parent object.

---

## 9. Performance

**Measure. Never claim a number that was not observed.** Record the dataset
size alongside every measurement — a figure without its input is not a
measurement.

Build a realistic dataset first: at least one school of ~1500 students with a
full year of attendance, results and invoices.

| Workload | Measure | Record |
|---|---|---|
| Student search | p50/p95 latency | dataset size, index used (`EXPLAIN`) |
| Student history | p95 | number of years |
| Dashboard | p95 | school size |
| Attendance load + save | p95 | section size |
| Notification/notice fan-out | wall clock | audience size, rows written |
| Bulk import | wall clock, rows/sec | row count, rejection count |
| Document generation | wall clock | single vs batch |
| Onboarding | wall clock, **real operator** | `scripts/pilot-report.mjs` measures this from `audit.platform_access`; it counts only tenants named in `PILOT_TENANT_IDS`, deliberately, so an engineer's walkthrough cannot be averaged in |
| DB-heavy queries | `EXPLAIN (ANALYZE, BUFFERS)` | seq scans on hot paths |

**Known open:** `student_profiles.board_registration_no` has **no index** —
confirmed a sequential scan. Fine at pilot size; measure it at production size
and decide, weighing the write cost on the student import.

---

## 10. Production readiness

Work [12-PRODUCTION-RUNBOOK.md](12-PRODUCTION-RUNBOOK.md) §0a, and verify each
tick independently rather than trusting the checkbox.

| # | Check | How |
|---|---|---|
| 1 | Deployed commit | The revision **serving traffic**, not the one pushed. Compare against `git rev-parse HEAD` |
| 2 | Committed bundles match | `npm run build` then `git diff --exit-code api/` |
| 3 | DNS | `shikhonbd.com` and a tenant subdomain both resolve |
| 4 | TLS | Valid, covers the wildcard, no browser warning, sane expiry |
| 5 | Environment separation | Production `DATABASE_URL` is not staging; `DATABASE_MAINTENANCE_URL` and `PLATFORM_DATABASE_URL` are distinct roles |
| 6 | Secrets | `node scripts/check-secrets.mjs --history` clean; no secret in any browser bundle; every credential distinct and rotatable |
| 7 | SMS | Real delivery to an allowlisted number, with the provider's message id and a returned DLR |
| 8 | Push | Real delivery to a real device, correct **school** branding, click-through, unsubscribe |
| 9 | Monitoring | `GET /api/v1/ops/monitor` returns 200; conditions evaluate |
| 10 | Alert delivery | **A real alert received by a human.** Provoke one deliberately |
| 11 | Backups | Configured, retention written down |
| 12 | Restore | `scripts/restore-drill.mjs` against production into an **isolated** target. It compares every schema object, table and per-tenant count and fails on any difference. Record RTO; RPO comes from the backup schedule, not from any drill |
| 13 | Cron | SMS dispatch and nightly maintenance both firing. **Partitions pre-created** — if `attendance_records` has < 1 month ahead, every write fails when the month turns |
| 14 | Rollback | Redeploy the previous revision and confirm the app works |
| 15 | Incident recovery | Walk §7 of the runbook: stuck queue, stopped cron, database unreachable |

**Do not accept a rehearsal as production evidence.** `production-evidence.json`
records the environment for exactly this reason, and `scripts/preflight.mjs`
already refuses an attestation whose environment does not match the deployment
being checked. Verify that refusal still works — it is the mechanism the whole
evidence discipline rests on.

---

## 11. Documentation audit

Compare, and report every contradiction as a finding:

| Source | Against |
|---|---|
| `docs/11-MASTER-PLAN.md` | The code that exists |
| `docs/PHASE_LOG.md` | The commits |
| `docs/07-IMPLEMENTATION-STATUS.md` | The endpoints and screens |
| `docs/12-PRODUCTION-RUNBOOK.md` | The deployment |
| `docs/PILOT-ONBOARDING-RUNBOOK.md` | What the pilot actually did |
| `docs/production-evidence.json` | Re-performed observations |
| `README.md` | All of the above |
| Every schema claim in the docs | `db/migrations/` and the live catalogue |

Specifically hunt for:

- Features described as done that have no screen (**D13 violations**).
- Anything called "deployed", "verified" or "complete" without evidence.
- Documented endpoints that do not exist, and endpoints no document mentions.
- Migration numbering vs. what is applied (`node scripts/migration-status.mjs`).
- Comments describing behaviour the code no longer has.

`docs/09-PRD-AUDIT.md` is known stale (2026-08-12). Confirm and re-date it.

---

## 12. Severity

| Severity | Definition | Release impact |
|---|---|---|
| **CRITICAL** | Data of one school reachable by another; data loss; auth bypass; a credential exposed; attendance or marks silently lost | **Blocks release** |
| **HIGH** | A core workflow unusable for a role; a wrong figure on money or attendance; a privacy leak within a tenant; irreversible action without confirmation | **Blocks release** |
| **MEDIUM** | A workflow that works but misleads; a missing UX state; a wrong count; performance that will not hold at production size | Fix before wide rollout |
| **LOW** | Cosmetic inconsistency; a rough edge with a workaround | Backlog |
| **COSMETIC** | Spacing, wording, iconography | Backlog |
| **TECH DEBT** | Duplication, dead code, missing test coverage, an un-run gate | Backlog, but a **red or un-runnable quality gate is HIGH** — this project shipped six commits with a failing type-check because nobody ran it |

Every finding carries: severity, area, reproduction steps, observed behaviour,
expected behaviour, evidence, and suggested fix.

---

## 13. Audit process

Four passes, in order. **Do not compress them.**

### Pass 1 — find problems only

Change nothing. Not one line, however tempting. Fixing while auditing loses the
count, hides the pattern, and makes the second pass unrepeatable. Produce the
complete findings list with severities.

### Pass 2 — after owner approval, fix CRITICAL and HIGH only

Approval is per-finding, not blanket. MEDIUM and below go to the backlog unless
the owner says otherwise. Each fix is its own commit referencing its finding id.

### Pass 3 — full regression

Everything, not the changed area:

```bash
node scripts/test-all.mjs                       # no database: fast suites
DATABASE_URL=… PLATFORM_DATABASE_URL=… node scripts/test-all.mjs
for f in db/tests/*.sql; do psql -v ON_ERROR_STOP=1 -f "$f"; done
npx --no-install tsc -p tsconfig.json --noEmit
npx --no-install tsc -p apps/pwa/tsconfig.json --noEmit
npx --no-install tsc -p apps/pwa/tsconfig.sw.json --noEmit
node scripts/migration-status.mjs
node scripts/check-secrets.mjs --history
npm run build && git diff --exit-code api/     # committed bundles match
node scripts/preflight.mjs
node scripts/security-probe.mjs
```

Plus the D11 brand guard and the parameter-property guard from
`.github/workflows/frontend.yml`, and browser acceptance of every changed
screen.

### Pass 4 — independent re-audit of every fix

**Someone who did not write the fix** re-tests each one, and re-runs the
original reproduction. A fix that cannot be shown to change the reproduction's
outcome is not a fix.

---

## 14. Evidence rule

**Every claim carries its evidence, inline.** No exceptions, including for
things that obviously work.

| Claim type | Required evidence |
|---|---|
| A test passes | The command and its output, with counts |
| A screen behaves | What was clicked, what appeared; a screenshot for visual claims |
| The database holds X | The query and its result |
| Production does X | The request, the response, the timestamp, the deployed commit |
| A migration applied | `migration-status.mjs` output |
| Performance | The number, the dataset size, and how it was measured |
| An external gate | The `production-evidence.json` entry, with `environment` |

**Never mark something green because it should work.** This project's entire
R-8 evidence discipline exists because "configured" and "delivered" are
different facts that look identical in a report. `status: "blocked"` — attempted
and prevented, with the obstacle recorded — is a legitimate and useful outcome.
`null` is better than an optimistic guess.

---

## 15. Final release decision

Exactly one of:

```text
RELEASE READY
    No CRITICAL. No HIGH. Every external gate observed in production.
    Pilot complete and stable. All evidence recorded.

RELEASE READY WITH ACCEPTED LOW RISKS
    No CRITICAL. No HIGH. Named MEDIUM/LOW findings explicitly accepted
    by the owner, each with its reasoning and an owner.

NOT READY
    Any CRITICAL or HIGH open, OR any external gate unverified,
    OR the pilot incomplete.
```

### Final checklist

- [ ] Every §3 attack run, both directions, results recorded
- [ ] §4 role matrix complete from observation
- [ ] §5 isolation matrix complete for two real tenants
- [ ] §6 D13 pass over every screen
- [ ] §7 offline tested on a real device on real mobile data
- [ ] §8 data integrity verified, including after a restore
- [ ] §9 performance measured with dataset sizes recorded
- [ ] §10 production readiness verified independently of the checkboxes
- [ ] §11 documentation contradictions listed
- [ ] Ten important tests broken on purpose and confirmed to fail
- [ ] Pass 3 regression green, with output
- [ ] Pass 4 independent re-audit of every fix
- [ ] Every CRITICAL and HIGH closed or explicitly accepted
- [ ] `production-evidence.json` re-verified, no `pass` from a rehearsal
- [ ] R-9 pilot gate decided on evidence

### Sign-off

| Field | Value |
|---|---|
| Auditor | |
| Date | |
| Commit audited | |
| Production revision | |
| Environment | |
| Findings: CRITICAL / HIGH / MEDIUM / LOW | |
| Decision | |
| Accepted risks (if any) | |
| Owner approval | |

---

## Appendix A — traps that have already cost this project time

Read this before starting. Each one produced a wrong answer here at least once.

1. **`SET LOCAL` outside a transaction is discarded.** The pooler is
   transaction-pooling. A psql suite that does not `BEGIN` sets nothing, and
   RLS then returns zero rows for everything.
2. **A bare `db.pool.query` sees nothing under RLS.** Use `withTenant()`.
3. **Superusers bypass RLS unconditionally.** A harness connecting as
   `shikhon_owner` will report a cross-tenant "leak" that does not exist.
   `SET ROLE shikhon_app` first. This produced a false security finding here.
4. **`node --test` strips types; it does not check them.** Run `tsc` separately
   or the type gate rots silently. It was red for six commits.
5. **`jsonb_set` with an absent parent key is a silent no-op.**
6. **`ON CONFLICT` treats NULLs as DISTINCT** unless `NULLS NOT DISTINCT`.
7. **A trigger raising inside a transaction aborts it**, so a catch-block query
   then fails with `25P02`. Read what you need *before* the operation that may
   raise.
8. **`/sync/push` returns 200 with rejections in the body.** A failed write
   looks like success to anything checking the status code.
9. **Node's own `fetch` sends `Sec-Fetch-Mode: cors`.** It is not a browser
   marker; treating it as one refuses the cron.
10. **The DB-backed rate limiter outlives the process.** Tests need a fresh
    phone number per run.
11. **Bangla forces UCS-2 SMS**: 70 characters per segment, not 160. Cost
    models that assume GSM-7 are wrong by more than double.
12. **Two real schools can share a display name.** Key by uuid, never by name —
    a comparison keyed on name produced a phantom mismatch here.

## Appendix B — known-open items at the time of writing

So the auditor can tell a pre-existing gap from a regression. **Verify each is
still true rather than assuming.**

- DNS/TLS not live; wildcard subdomains unverified.
- Real SMS never sent through a real aggregator.
- Real push never delivered to a real device (recorded as `blocked`, with the
  obstacle documented).
- No monitoring alert has ever reached a human.
- No production backup or restore.
- No real offline connectivity test.
- Pilot count: 0.
- A **stale public deployment** at `shikhon-lms.vercel.app` serving a
  pre-R-1-A revision. Not the current system; awaiting an owner decision.
- `GET /api/v1/sync/pull` is built, tested and working, and no client calls it.
  Classified as an unused capability, not a defect.
- `docs/09-PRD-AUDIT.md` stale since 2026-08-12.
- `student_profiles.board_registration_no` unindexed (sequential scan).
- Backlog features not built: class/section edit UI, guardian unlink, audit
  export, object storage, CSV export, multi-card ID layout, attendance
  date-range filter.
