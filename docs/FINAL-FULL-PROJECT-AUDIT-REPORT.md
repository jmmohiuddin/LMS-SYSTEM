# Final Full Project Audit — shikhonBD

**Date:** 2026-09-02 · **Audited at commit:** `bf4d009` · **Auditor mode:** report and recommendation only — no code, schema, API, UI or routing changes were made during this audit, and none are made by this document.

This report is written for an engineer who has never seen this project or any
prior conversation. Every load-bearing claim states what was done and what was
observed, per `docs/FINAL-FULL-PROJECT-AUDIT-PLAN.md` §14 ("evidence rule").
Where a claim rests on work performed in an earlier phase, the phase and its
gate evidence are cited from `docs/PHASE_LOG.md`, which is append-only.

---

## 1. Executive Summary

shikhonBD is a multi-tenant, offline-first, white-label school/college/madrasa
management SaaS for Bangladesh: PostgreSQL with row-level security as the
tenant boundary, ten small Node services compiled into one deployable, a PWA
built for 2 GB Android phones on 2G, a platform operations console for the
company's own staff, and a public demo. It is live at `https://sikhon.systems/`
(marketing page + demo); **the current application revision is not deployed and
production has zero tenants.**

**Verdict (§33 in full): the architecture and feature scope are fit to be
declared complete, with six MUST-fix items before a real pilot** — one of them
a live security defect this audit found and proved at runtime (a deactivated
account keeps its session forever, §10/§13), and none of them architectural.
The three new owner requirements assess as follows:

- **Smart Routine Generator (§8):** ~70% of the hard part already exists and
  is tested — a cross-shift, room-aware, explainable solver whose clash-freedom
  is enforced by database exclusion constraints. What is missing is almost
  entirely **input UX**: there is no screen to enter rooms, teacher
  availability, period templates or weekly subject frequencies, and no button
  that calls the solver. A focused phase (proposed as P9) is realistic; the
  "one minute" target is plausible for the computation and the real risk is
  data entry, which the proposed wizard addresses.
- **Student↔Guardian sync (§9):** the model is largely built and the
  phone-visibility policy is already enforced **server-side** (admins see the
  phone; teachers get `phone: null` from the API — not CSS hiding). Missing:
  the `tel:` call button (zero occurrences in the app), a per-institution
  policy knob for class-teacher phone access, and guardian info on the
  teacher-reachable student screens.
- **Identity/login (§10):** the current model — institution-issued one-time
  activation codes + optional phone OTP, **no passwords at all** — is the right
  model for Bangladesh and should be kept. It is missing session revocation on
  deactivation (proved live), a device/session list for users, and a
  documented credential-recovery runbook page for the office.

The biggest non-obvious risks are operational, not architectural: no real SMS
has ever been sent (contract not signed, `B-1`), no alert has ever reached a
human, DNS/TLS for tenant subdomains is not live, and the platform console's
overview endpoint already costs 1.4s at 79 tenants and scales linearly (§19).

---

## 2. Current Architecture

**Blueprint vs. as-built.** The blueprint documents (`01-ARCHITECTURE`,
`06-DEPLOYMENT`) describe Vercel serverless + Neon PostgreSQL. Production is a
Hostinger VPS (`voltix-prod`, Ubuntu 24.04): one Node process under systemd on
`172.16.1.1:4100`, Caddy terminating TLS, PostgreSQL 16 + pgvector in a
dedicated Docker container on loopback. The drift is deliberate, disclosed in
`11-MASTER-PLAN §5b`, and awaiting an owner decision on which is the *target*
(`B-27`). This report treats the VPS as reality.

**Tenancy.** One database; every tenant table carries `tenant_id` and RLS with
`FORCE` (the last two tables missing FORCE were fixed in P8, migration 061).
The runtime role `shikhon_app` is non-superuser, non-BYPASSRLS, and sees zero
rows without `SET LOCAL app.tenant_id` inside a transaction. A separate
`shikhon_platform` role serves the operations console; it also cannot bypass
RLS and reaches cross-tenant data only through named SECURITY DEFINER
functions. Three credentials gate the console: `super_admin` JWT +
`PLATFORM_API_KEY` + the separate DB role.

**The P7 gate.** Every tenant request passes through `withTenant()`, which
reads `app.tenant_access(tenant, role, service?)` on the connection the
transaction already holds: suspended/archived → refused; maintenance/limited →
`SET LOCAL transaction_read_only = on` (PostgreSQL enforces read-only; no
endpoint opts in — zero of ~110 call sites pass `write:true` and writes are
still refused, proven in P7); closed role portals and disabled services
refuse with Bangla reasons. The billing lifecycle
(trial → active → grace → limited) is **derived** from dates and payments by
`app.tenant_billing_state()`, never stored, and since P8 evaluates against
`app.today_dhaka()` rather than the UTC server date.

**Offline.** A client outbox (IndexedDB) with per-op idempotency
(`sync_operations` claim table), device-sequence tracking, clock-skew
estimation, and per-op service gating; conflicts return typed per-op results
inside a 200 (a documented trap). The service worker precaches the app shell
(≤8 entries), serves `/app` offline, and **never** caches `/` (marketing) or
`/platform` (operator console must never be stale).

**Scale of code.** 62 migrations (61 rollbacks + one deliberate exception
documented in-file), 227 RLS policies over 110 RLS-enabled tables, ~330 source
files, 1,582 automated tests across 12 workspaces plus 26 SQL assertion
suites, three CI TypeScript configs plus a coverage-drift guard.

---

## 3. Current Product Surfaces

One deployment, five addresses (D15):

| Address | What | Brand |
|---|---|---|
| `/` | Marketing site — **frozen**, byte-identical since R-1-A (`496199bd`, re-verified this audit, 0 working-tree modifications) | platform |
| `/demo` | Isolated public preview: every screen, sample data, role picker, no login, purge-on-role-switch | white-label samples |
| `/app` (+ `?tid=`, later `<slug>.sikhon.systems`) | The tenant PWA | per-school |
| `/platform` | Platform Operations Center — separate bundle, never cached, two credentials | platform (D11) |
| `/design` | Design-system reference | — |

No school-picker exists anywhere, by decision D12 (it would enumerate the
customer list).

---

## 4. Current Phase Status

R-1…R-9 built the product (identity, notices, principal tools, calendar,
documents, student record, onboarding console, go-live hardening, push).
P0–P4 rebuilt the UI on the "Ata Ekta" design system (tokens → shell →
components → teacher → student/guardian). P5 principal + IT admin. P6 the
fourteen screens with no design reference. **P7** the Platform Operations
Center and the entire commercial model (D16) — whose central finding was that
suspension, portals and service switches were all *inert* until then. **P8**
final cleanup — which found seven live defects, chiefly that a calendar day
was read as UTC at three of four layers (fixed; migrations 059–062).

Every phase's gate evidence (test counts run twice, TS configs, migration
counts, browser matrices) is in `PHASE_LOG.md` under the phase that produced
it. Nothing after migration 048 is deployed.

---

## 5. Complete Capability Matrix

Legend: ✔ built & verified (phase cited) · ◐ partial (gap stated) · ✘ absent.
"Verified" means at minimum: endpoint + screen + a test that fails when broken,
per D13.

### Platform (operator)

| Capability | Status | Evidence / gap |
|---|---|---|
| Institution creation, provisioning, first admin, imports | ✔ | R-7 wizard; 40 platform-svc tests incl. end-to-end head-teacher login |
| Institution list, search, filters, command centre | ✔ | P7; drawer with 6 tabs |
| Monitoring: last-active, dormant, attention queue | ✔ | P7/P8; measured from `user_sessions` + `product_events`, never invented |
| Services (13), portals (5), suspend/limited/maintenance/reactivate | ✔ | P7; each proven to actually bite (gate tests + live API) |
| Plans CRUD, plan assignment, student cap, payments, grace | ✔ | P7; plan catalogue was the last SQL-only control, closed in P7 |
| Billing lifecycle incl. boundary dates in Dhaka time | ✔ | P8 §8: four boundary cases pinned by 8 tests; explicit grace now authoritative (060) |
| Usage/health per tenant | ✔ | `GET /platform/health?id=` — SMS counts, error codes, devices |
| Alerts to a human | ◐ | `ops/monitor` evaluates + POSTs to `ALERT_WEBHOOK_URL`; **no alert has ever reached a human** (evidence: `production-evidence.json` `alert_delivered: null`) |
| Audit trail (per-tenant + cross-tenant feed) | ✔ | P7; append-only, reason mandatory on every mutation; **cannot name WHO** (B-39: operator ids have no directory) |
| Support mode / impersonation | ✘ deferred | B-38, blocker named: 18 RLS policies key on `current_user_id()` |
| Bulk operations | ✘ deferred | B-40, trigger ~50 institutions |

### Institution roles

All five roles have complete, design-system surfaces (P3–P6): Principal
(home, academic drill-down, users, students, imports, attendance, publish,
results, documents, fees/invoices/ledger, inbox/compose, branding, settings,
rollover, audit), IT Admin (structure, imports, users, settings, health),
Teacher (day/week routine with substitutions, roster, offline attendance,
offline marks, scripts, assignments), Student (routine, learn, assignments,
results, my-attendance, subjects), Guardian (ward panel, results, fees,
notices, documents). Seven student/guardian views deliberately keep pre-P2
markup (B-19, recorded).

### Academic

Years/terms, class → group/stream → section hierarchy with counts, subjects
incl. higher-secondary electives + 4th subject (048), class-teacher and
subject-teacher assignment **with replacement history** (B-6), bulk moves,
promotion/rollover with blocked-student refusal and per-child subject
re-derivation, multi-year student history, alumni **hook only** (graduation
event outbox — no alumni UI, by design D9). Student permanent ID: see §10.

### Attendance / Routine / Exams

Offline-first attendance (grid, queue, retry, reconnect, idempotent server
apply), monthly calculations, working weekends (calendar `working_weekend`
kind), holidays, Ramadan schedule kind. Routine per shift/year with GiST
exclusion constraints; teacher day/week; student day (049); substitution
finder + assignment. Exams: routine with per-student clash gate (029), seat
plan + invigilation (030), component marks (CQ/MCQ/practical/CA), NCTB
grading incl. component-fail and 4th-subject rules, publish with rowVersion
concurrency, results per student/section.

### Communication / Finance / Documents

Notices with audience resolution (`resolve_notice_audience`), in-app inbox,
SMS pipeline (budget caps, dedupe, DLR ingest, allowlist, **stub aggregator —
no real SMS ever sent, B-1**), web push (real VAPID, delivery blocked on a
real-device test), per-guardian `receives_sms`. Finance: fee structures,
invoices, receipts, ledger, outstanding, MFS webhook ingest (credentials
absent). Documents: receipt, report card, admit card, ID card, transfer
certificate, attendance sheet — one branded renderer, print-first, no stored
PDF (B-17, object storage).

### Demo

Isolated surface, role picker with purge-on-switch (P4), gate test derives
the protected-endpoint list from source so new endpoints cannot silently be
open, sample data only. Re-verified in P8 (§17 of its brief).

---

## 6. Feature Gaps — "what did we miss?" (Bangladesh workflows)

Method: each institution type was walked through a school year's operational
calendar, and each expectation checked against the codebase (grep + schema +
screens), not against documentation.

| Missing feature | Institution | User | Why important | Existing partial support | Priority |
|---|---|---|---|---|---|
| **Teacher/staff attendance** | all | Principal, IT Admin | The register the headmaster signs every morning; MPO inspections ask for it; substitution decisions depend on who is absent TODAY | none (0 hits for staff attendance; `teacher_leaves` table exists but **nothing writes it** — 0 INSERT sites) | **MUST BEFORE PILOT** (minimal: mark teacher absent today → feeds substitute finder) |
| **Teacher leave workflow** | all | Teacher, Principal | `teacher_leaves` feeds the substitute finder and the solver, and there is no way to create a row without SQL — an inert input | table + readers exist (006, substitute.ts) | **SHOULD BEFORE PILOT** (one form + approval) |
| **Class tests (শ্রেণি অভীক্ষা) as lightweight exams** | school, madrasa | Teacher | Weekly/monthly class tests are the majority of marks entered in reality; the current exam model carries full component structure and publication ceremony | exam types exist; no lightweight path | SHOULD BEFORE PILOT |
| **Merit position / tabulation sheet** | all | Principal, office | Bangladeshi report cards carry মেধাক্রম; the tabulation sheet is what the office prints for the year book | results + report card exist; a `tabulation` mention in results-view only | SHOULD BEFORE PILOT |
| **উপবৃত্তি (stipend) eligibility report** | school, madrasa | office | PMEAT/secondary stipends require attendance-% and pass lists per cycle; schools compile these by hand today — high-value, cheap (a report over data we already have) | attendance % + results exist; no report | POST-PILOT (first report cycle) |
| **Board exam ফরম পূরণ (form fill-up) tracking** | school, college | office | SSC/HSC form fill-up season is the office's biggest annual list-management job (eligibility, fees, board registration numbers) | `board_registration_no` field exists (unindexed, B-18); no workflow | POST-PILOT |
| **Online/managed admission (ভর্তি)** | college esp. | office | Jan/Jul intake: applicant list → admission test → merit → enrolment | bulk import covers post-decision entry | POST-PILOT |
| **Hifz progress tracking** | madrasa | Teacher, Guardian | The distinguishing madrasa workflow (para/juz progress, revision cycle) | subject model can hold hifz as a subject; no progress-specific tracking | POST-PILOT (madrasa pilot trigger) |
| **Money receipts numbering per Bangladeshi convention** | all | office | Receipt books are serial-numbered per year and auditors check continuity | receipts exist with ids | SHOULD BEFORE PILOT (serial per tenant-year) |
| **Guardian-visible fee payment via MFS** | all | Guardian | bKash is how parents actually pay | MFS webhook ingest built; initiation off; D16 explicitly excludes gateway | POST-PILOT (separately approved, per D16) |
| Library / inventory / hostel / transport / payroll | varies | — | Frequently requested but not core to the pilot promise | none | NOT RECOMMENDED now (explicitly excluded by P8 §24 list; revisit post-pilot on demand) |

The first row is the audit's strongest "missed feature" claim: every physical
Bangladeshi school keeps a teacher attendance register, the product's own
substitute finder is built to consume exactly that data, and the table for it
exists with zero writers.

---

## 7. Dashboard Deep Audit

Method: read each dashboard's data source end-to-end (endpoint SQL → view) and
compare against the checklist; classify additions only where a person would act
on them (the brief forbids decoration).

### Principal (`ops/dashboard` + `principal-home-view`)
Serves today: attendance marked/present per section, sections-without-class-
teacher, subjects-without-teacher, students-without-section, exams awaiting
publication, invoiced/collected/outstanding, teachers/students/classes/
sections counts, absentee list (dataTable + "আরও N জন"), notices, calendar.
- **Present and useful:** today's attendance, finance summary, outstanding,
  publication queue, structural warnings ("sections without a class teacher"
  is exactly an academic warning), notices, upcoming events.
- **MISSING (act-on-able):** *teacher activity/absence today* (blocked on §6
  row 1); *absent trend* (a 2-week sparkline from data that exists — cheap and
  genuinely used by heads); *fee collection vs. this month's due* exists as
  numbers but no trend.
- **MISLEADING:** none found; P7/P8 removed the "field ≠ truth" cases.
- **REDUNDANT:** none — P7-0 already collapsed the duplicate dashboard.

### IT Admin
Setup status, imports with error tables, structure, users incl. activation
issues, settings, system health vocabulary (P5). **MISSING:** a single
"onboarding checklist" card (the platform console has exactly this via
`tenant_onboarding_state` — the same function could serve the school's own IT
admin; currently platform-only). **UNNECESSARY:** nothing found.

### Teacher (`teacher-home-view`)
Today's classes with substitutions, next class, hall-duty/urgent block,
attendance-pending per section, marks-entry links, notices. **MISSING:**
*pending work* rollup exists implicitly (per-section chips) — adequate;
nothing material missing. This is the strongest dashboard.

### Student (`student-home-view`)
Today's routine (049 — section-scoped, parallel-block filtered), next class,
attendance %, assignments due, results, notices, exam schedule. **MISSING:**
fees due (guardian-facing by design — acceptable; document the decision).

### Guardian (`guardian-view` + ward panel)
Child selector, per-ward attendance/results/fees/notices/documents.
**MISSING:** *today's status* one-liner ("উপস্থিত/অনুপস্থিত today") — the
single thing a parent opens the app for; attendance history exists but
today's flag is not surfaced first. SHOULD BEFORE PILOT (one card).

---

## 8. Smart Routine Generator Assessment  (Owner requirement #2)

### What exists today — verified in code and schema, not assumed

**Solver** (`services/rms-svc/src/solve.ts`, 1,046 lines, 6 test suites):
greedy deterministic single pass, highest-demand-first; idempotent top-up
(re-running fills gaps, never duplicates); **cross-shift aware** — teachers
and rooms are booked against the whole academic year across every active
routine, compared as *time intervals* so morning P8 vs day P1 clash correctly
(F-506, migration 032 enforces the same at the DB); **room-capability
matching** (chemistry practical → a room whose `capabilities[]` includes it);
unplaceable demand reported *in resource terms* ("রসায়নের ১২টি ল্যাব পিরিয়ড
দরকার; ল্যাব ১-এ ৮টি খালি"), which is precisely the §"Routine Quality"
requirement, already implemented.

**Hard constraints:** teacher/section/room double-booking are **unstorable** —
three GiST exclusion constraints in migration 006, so the "hard violations: 0"
counter is a database guarantee, not solver bookkeeping. Teacher availability
(`teacher_availability`, effective-dated), working days (weekend config +
`working_weekend` overrides), period templates with breaks, per-class-subject
`periods_per_week` — all modelled.

**Soft constraints** (`soft-constraints.ts`, pure, tested): weekly/daily
teacher caps with *cause attribution* ("যোগ্য গণিত শিক্ষক কম" — computed from
the competency register, not narrated), consecutive-class detection, room-
change churn. Violations name a person or section, never a rule code.

**Explainability + lifecycle** (`generation.ts` + P6's `generation-view`,
`routine-editor-view`): per-slot "why this teacher, this room" computed
against the register; accept/discard; draft→active→published with
`published_at/by`; slot editor with pinning; substitute finder for
day-of-week disruptions. Editor is server-authoritative — no drag-drop
dependency (mobile-friendly lists).

**Already-synchronized outputs:** slots are ONE table; teacher view, section
view, student day (049) and exam clash checks all read the same rows. There
are no disconnected copies to drift. Moving a slot recomputes conflicts via
the exclusion constraints (a bad move is *rejected*, 23P01 → typed error).

### What is missing — the honest gap list

1. **Input UX is nearly absent.** Verified by grep across `apps/pwa/src`:
   **no screen** manages rooms, teacher availability, period templates, or
   `periods_per_week` per class-subject; **no UI calls `/rms/solve`** (the
   endpoint is API-only by a recorded decision, docs/07). Today these inputs
   arrive via provisioning defaults, imports, or SQL. This, not the solver,
   is why a school cannot self-serve a routine.
2. **Double periods** are modelled (`double_periods_per_week`) but the solver
   places singles only (documented in its header as deliberate MVP scope).
3. **Teacher date-leaves** feed the substitute finder but not the weekly
   template (correct — but the leave table has no writer, §6).
4. **No repair mode** ("regenerate affected area"): re-run tops up globally;
   a scoped re-solve (one section / one teacher) would serve the editor.
5. **Group/stream-level views** derive trivially from section slots but no
   dedicated print view exists for "class-wise" and "whole institution on one
   sheet" (the office wall chart).
6. **Performance at scale is unmeasured.** Fixture-scale solves complete in
   ~1.2s including setup (test timing observed this audit); `routines.
   solver_seconds` exists but no realistic-size run has ever been recorded
   (0 routine rows in the dev DB). The algorithm is O(demands × slots) greedy
   — for a large school (60 sections × 10 subjects ≈ 600 demands × ~48 slots)
   this is comfortably sub-minute *by construction*, but must be measured in
   the phase, and the report generator (soft-constraint pass) with it.

### Recommendation

The requirement is **technically realistic and mostly built**. The correct
phase (proposed as **P9**, §30) is: an input wizard over existing tables →
one "generate" action → the existing report/editor → publish, plus double-
period placement and scoped re-solve. **No new solver technology is needed**;
do not adopt an ILP/CP dependency for the pilot — the greedy+DB-constraint
design already guarantees the property schools actually care about (no
clashes ever stored) and degrades transparently (unplaced list) instead of
failing opaquely. Revisit a real optimizer only if pilot schools reject the
soft-constraint quality, and record that as the trigger.

---

## 9. Student ↔ Guardian Sync Assessment  (Owner requirement #3)

### What exists — verified

Model: `guardianships(student_id, guardian_id, relation, is_primary,
receives_sms, can_pay_fees, revoked_at/by/reason)` — end-dated, never
deleted (B-7/migration 050); one guardian ↔ many wards and the reverse;
`other_wards` surfaced so the office sees siblings. SMS targeting respects
`receives_sms`; fee visibility respects `can_pay_fees`.

**Visibility policy is server-side** (`ops/guardians.ts`): GET for a student
returns name/relation/flags to any staff (`requireStaff`), but `phone: mayEdit
? r.phone : null` where `mayEdit` = principal/school_owner/it_admin. A
teacher's client never receives the number — this satisfies "no browser-side-
only hiding" as built. Mutations (link/unlink/permissions/create) are
GUARDIAN_ADMIN-only. Revocation is immediate (`WHERE revoked_at IS NULL`
indexes and `app.my_ward_ids()` respect it; b7 tests assert a former guardian
stops reading the child while history remains). Who may open a student at all
is `app.can_see_student()`: student=self, guardian=own wards, class/subject
teacher=own sections only, office roles=school-wide — read directly from
`pg_proc` this audit.

Sync behaviour: guardian and student read the same rows (no copies); the P4
purge design covers cache on role switch/logout; documents/fees/attendance
all resolve guardianship at read time. No stale-derived-data path found.

### Gaps

1. **No `tel:` anywhere** — 0 occurrences in `apps/pwa/src`. The requested
   tap-to-call does not exist even for the principal, who already receives
   the number.
2. **The guardian block renders only inside the academic drill-down**
   (`academic-view` mounts `GuardianPanel`); the roster/student screens a
   class teacher actually uses don't show guardian name/relation, although
   the API would serve it to them.
3. **No policy knob.** The owner asks "class teacher sees phone *if
   institution policy allows*" — today the rule is hardcoded (admins yes,
   all teachers no). There is no per-institution setting.
4. Student's own view shows nothing about their guardian (arguably correct;
   decide and document).

### Recommended per-role policy (for the owner to ratify)

| Role | Sees | Rationale |
|---|---|---|
| Principal / school_owner | full guardian info + phone + call | already API-served; add UI + `tel:` |
| IT Admin | full (operational: fix numbers, relink) | already API-served |
| **Class teacher** | name + relation always; **phone only if the institution enables it** (new per-tenant setting, default OFF) | the common real-world need is "call the guardian of my own student"; default-off respects privacy until a school opts in |
| Subject teacher | name + relation only; phone never (escalate via office) | least privilege; matches current server rule |
| Student | primary guardian name + relation (no phone) | transparency without exposing a parent's number to a shared device |
| Guardian | own wards' full academic/fee/attendance view (as today) | already correct |

All enforcement stays server-side (extend `mayEdit`/a new `mayCallGuardian`
computed from the tenant setting); audit each phone disclosure to the
existing `writeAudit` path. **⚑ OWNER DECISION:** the class-teacher default
(OFF recommended) and whether phone disclosures should be per-view audited.

---

## 10. Identity / Login Assessment  (Owner requirement #1)

### The system as built — no passwords, and that is deliberate

Login = **activation codes + optional OTP**. `users.password_hash` exists in
schema and has **zero readers or writers** (verified by grep: only two comment
mentions). `activate.ts` documents the decision: a password born on a shared
phone is weaker than a one-time code the office hands over in person. OTP
purposes enum includes `reset_password` — **unused**, a vestige.

Answers to the owner's questions, as the code stands:

| Question | Answer today | Evidence |
|---|---|---|
| Who creates accounts? | Platform wizard (first admin) + tenant admins (`ops/users` POST, roles: principal/owner/IT) + imports | users.ts:64-66 |
| Who activates? | The user, by redeeming a printed one-time code (8-char, peppered hash, single-use, 72h TTL, rate-limited as `otp_verify`) | activate.ts; platform tests |
| Password reset / change / visibility? | **N/A — no passwords exist.** Staff can never see a credential; recovery = issue a new activation code, which invalidates nothing already held (codes are single-use) | users-view "সক্রিয়ন কোড তৈরি করুন" → `/auth/activate` issue |
| Can IT Admin reset teacher/student/guardian credential? | Yes — re-issue code (tenant-side, audited) | users-view + activate issue path |
| Can Principal reset an IT Admin? | Yes (same GUARDIAN_ADMIN class) | users.ts roles |
| Disable an account? | Yes: `PATCH ops/users` sets status `left`/`active`, self-lockout refused, audited | users.ts setStatus |

### The defect this audit found and proved at runtime

**Deactivation does not end access.** `loadRoles()` (the refresh path) checks
`user_roles.valid_until` but **not `users.status`**, and `setStatus` does not
revoke `user_sessions`. Proof performed this audit, live against the running
stack: planted a valid refresh session for a real principal, set
`status='left'`, called `POST /api/v1/auth/refresh` → **200 with a fresh
access token carrying the principal role**. Because refresh *rotates* the
token, the session never expires: a dismissed teacher with the app installed
keeps full access indefinitely. `users.status` IS checked at activation and
OTP login — only the refresh path is open. (Probe session revoked and status
restored immediately after; nothing left behind.)

**Fix (one of two, both small):** revoke the user's sessions inside
`setStatus`'s transaction, **and** add `AND u.status = 'active'` to the
refresh path's user check (defence in depth — belt and braces, matching this
project's style). **MUST BEFORE PILOT.**

### Recommended ID model (owner's A/B/C/D)

**Keep the current model = D (hybrid of B+C):** institution assigns identity
and prints an activation code (works with zero phones, shared devices, 2G);
phone-OTP login exists for those with phones and is rate-limited (3/hour per
phone — verified by the security probe, 29/29). Model A (temporary passwords)
is strictly worse in this population and adds a credential class the product
has happily avoided. What to add is not passwords but: session list +
"sign out other devices" for users (data already exists in `user_sessions`
with device labels; no UI), and the deactivation fix above.

### Account states

Current enum: `invited, active, suspended, left, deleted` + activation-code
issued/used/expired — semantically covers the requested
Pending/Invited/Active/Locked/Disabled/Archived (Locked ≈ rate-limiter,
Disabled ≈ `left`, Archived ≈ `deleted` soft state). Tenant service state is
fully separate (`tenant_operations`, P7) — the separation the brief demands
already holds. Gap: the mapping above is not written anywhere — document it;
no schema change needed.

### Student permanent ID

`student_profiles` carries a permanent student id used by search and history
across years/sections/promotion (R-6: "find a child including one who left").
It is institution-scoped, immutable in practice, searchable forever, survives
rollover (verified by rollover tests + studenthistory). **Keep
institution-scoped** — a platform-global ID is a privacy liability with no
pilot benefit; `global_person_id` already exists on `users` for the future
cross-institution question. Recommendation: state the format contract in docs
(it is currently convention, not contract).

### Security audit of the identity surface

Brute force: OTP request 3/h/phone + IP buckets; verify 10/h; activation
redemption rate-limited (proved painfully by P7's own test tripping it);
credential enumeration: wrong-key and wrong-token responses are
indistinguishable (platform tests assert this); user enumeration on OTP:
otp-request responds uniformly (allowlist tests). Sessions: rotation with
`superseded_by`, revocation on logout, 30-day TTL. Gaps: the refresh/status
hole above; **no user-facing device list**; refresh tokens are long-lived
with rotation but no absolute cap per user (accept for pilot; note it).

---

## 11. Platform Admin Assessment  (Sections 10–11)

Everything in the §10 checklist is visible today except: per-institution
**teacher/guardian counts** on the overview (students + users are there;
teachers/guardians need the detail drawer), and **WHO acted** in the audit
feed (B-39 — operator ids resolve to nobody; needs an operator directory,
even a two-column table). Both are small; B-39 matters for accountability the
moment there are two operators.

**Scale (§11), measured not imagined:** `platform/overview` at 79 tenants =
**1.36s end-to-end, 433ms in SQL** (EXPLAIN ANALYZE this audit). The function
runs three correlated subqueries + a LATERAL gate call + two MAX scans per
tenant — linear in tenants. Extrapolated: ~5s at 300, ~17s at 1,000. The
console also renders all tenants client-side with no pagination. Neither
matters at 10 schools; both matter at 100. Fix shape (post-pilot, before
~100 tenants): one grouped query (JOIN + GROUP BY replaces per-row
subqueries), server-side attention-queue computation, and list pagination.
Billing, audit and service controls are per-tenant writes and scale fine;
alerting scales only once it reaches a human at all (§21).

## 12. Institution Operations Assessment  (Section 9)

Can a school run WITHOUT calling shikhonBD? Checked operation-by-operation:
users ✔ (create/search/deactivate/re-issue codes) · academic structure ✔
(create/rename/assign/replace incl. B-6) · branding ✔ (own editor, merge-safe)
· student+teacher imports ✔ (dry-run, error tables, cap enforcement) ·
activation ✔ · credential recovery ✔ (re-issue; no passwords to reset) ·
guardians ✔ (link/unlink/permissions/create) · notices ✔ · calendar ✔ ·
results ✔ · fees/invoices/receipts/ledger ✔ · **routine ✘** — the one gap:
inputs and solve need SQL/API today (§8), the editor UI exists but a school
cannot get to a first generated routine self-serve. Everything else that once
required SQL was closed by P7 ("nothing commercial is SQL-only") and this
audit found no regression.

## 13. Security Audit  (Section 12 — the plan's §3 matrix)

Fresh evidence this audit: `scripts/security-probe.mjs` → **29/29 pass, 0
skipped** (run against the live local stack during P8's close, hours before
this report; includes forged tenant headers ignored, cross-tenant reads/writes
refused, 7 hostile push endpoints refused, service-key browser refusal, CORS,
OTP limits, no secrets in bundles). Gate behaviour: 41 tenant-gate tests
(suspension/read-only/portals/services/isolation/fail-closed). Session/OTP:
§10. Documents/finance: money rows are `ON DELETE RESTRICT`; document access
goes through `can_see_student`. Notification leakage: audience resolution is
SQL-side; SMS respects `receives_sms`; push subscriptions are per-user.
Cache-after-logout: P4/P8 purge design, verified in-browser (P8 §5/§11).
Audit integrity: append-only, no deletes anywhere in console paths.

**Open security items, honestly:** (1) the refresh/deactivation hole — MUST
(§10); (2) no session revocation UI; (3) B-39 operator anonymity in the
platform audit trail; (4) `check-secrets.mjs` watches a Neon-era pattern only
(B-42 — widen before real credentials exist); (5) PII envelope encryption
(NID/BRC) has a live write path but key custody is an owner-level open item
(07 §9j / B-21). For every negative test above the paired positive exists in
the same suites (the probe's design).

## 14. Tenant Isolation Audit

Both directions, real data, this audit cycle: 11 platform mutations on school
A left school B **byte-identical** (P8 §7 re-run: plan/cap/state/services/
portals/grace/payments compared before/after). DB level: as `shikhon_app`
with tenant A's GUC, B's rows are invisible; with no GUC, zero rows
(probe checks + `invariants.sql` PASS 1g "fail-closed with no tenant
context"). 110 RLS tables, all FORCE after migration 061; runtime roles
non-BYPASSRLS (asserted at boot by `assertRlsEnforced`, which refuses to
start otherwise). The known residual: RLS reads via `app.my_section_ids()` /
`current_user_id()` are correct but are also the exact thing blocking support
mode (B-38) — a design consequence, not a leak.

**Client-side isolation, added 2026-09-07 (B-104).** The audit above covers
the server, and the server was never breached. The BROWSER was: the service
worker's data cache matched on URL alone, so on one device serving two
schools — the `/app?tid=<uuid>` addressing production uses today — one
school's cached answer first-painted for the other. Found by P9-4's own
browser acceptance, not by this matrix, which had no client-cache dimension
until now.

Closed with tenant-aware cache keys plus a purge on switch, and proved in a
real browser: A's warm cache answers `null` to all of B's identical reads,
both directions, across ten endpoints; the switch clears the session and
screen caches while keeping the device id; and with the server stopped, A
still reads its own data offline while B's identical request fails rather
than receiving A's. 14 tests in
`apps/pwa/test/tenant-cache-isolation.test.ts`. The offline outbox needed no
change — `ownedBy()` has scoped it by `{tenantId, actorId}` since it was
written.

This adds a dimension the isolation matrix should keep: **first paint, on a
shared device, is the correct tenant** — not merely eventually correct.

## 15. UI/UX Audit  ·  16. Accessibility Audit

Risk-based matrix executed in P8 and spot-re-verified this audit: 9 widths ×
2 themes on the tenant app, 25 routes × 3 roles, console at 3 widths × 2
themes, demo — **zero horizontal overflow, zero sub-24px targets, zero
unnamed controls, zero forbidden strings (`undefined`/`NaN`/raw UUID/
`[object Object]`/Latin-digit-in-Bangla-counter) in visible text AND
accessible names**. Worst contrast: 4.51:1 light (passes AA by 0.01 —
recorded as a hair-trigger for the next token change), 5.01 dark; console
4.77 (documented brand-red-on-white). Known accepted exceptions: two desktop
pointer-fine targets from P5, B-19's seven legacy-markup views. Bangla
typography: counts in Bangla digits enforced by a source guard; money/IDs
Latin by rule R-8; dates via `bnDate`/`weekdayDateBn`; long-name truncation
verified in P5/P6 sweeps. Screen-reader parity defect class (badge says ৩,
announces 3) was found and guarded in P8.

## 17. Offline Audit

Verified with the server actually stopped (P8): `/app` boots from the SW; `/`
and `/platform` correctly fail rather than serving a stale/wrong shell.
Attendance path online→offline→queue→retry→reconnect→sync is covered by the
sync e2e suites (client↔server, no mocks; mid-flight failure loses nothing;
idempotent re-push) — **local simulation only; no real-network field test has
ever been run** (production-evidence `pilot_offline: null`). Marks entry is
offline; scripts upload queues. Candidates that would genuinely benefit next:
notices inbox read-cache (already SWR for reference data) and the student
routine (already cacheable) — no new offline WRITE paths are recommended
before the pilot; every new outbox entity is a new conflict surface.

## 18. Date / Localization Audit

State after P8: **0** `CURRENT_DATE` in production TS (31 sites → `app.
today_dhaka()`), **0** UTC-today in JS (6 sites → `todayLocalIso()`/
`dhakaToday()`), 6 SQL functions + 19 column defaults migrated (059/060/062),
four boundary billing dates pinned in Dhaka terms, and **two source guards
that fail the build on reintroduction** (`calendar-dates.test.ts`,
`bangla-numerals.test.ts` — each proved to fail on a planted defect).
`timestamptz` instants deliberately untouched. Residual risk: raw SQL written
in *future* migrations isn't covered by the TS-side guard — the review
checklist in the runbook should name it (one line, doc-only).

## 19. Performance Audit

Measured this audit on the live stack (times are end-to-end via HTTP):

| Surface | Scale | Result |
|---|---|---|
| `ops/dashboard` | tenant with **8,000 enrolments** | **73ms** |
| student search (Bangla prefix) | same | 24ms |
| section roster | same | 12ms |
| `academics/hierarchy` | same | 21ms |
| `platform/overview` | 79 tenants | **1.36s** (433ms SQL) — the scale bottleneck, §11 |
| `app.js` | — | 161 KB gz (budget 180) |
| `app.css` | — | 51.2 KB gz (−1.8 KB in P8) |
| platform bundle | — | ~33 KB gz, never cached |
| solver | fixture scale only | ~1.2s incl. setup; **unmeasured at school scale** (§8 gap 6) |

10k+ students: untested end-to-end, but the hot paths above are index-backed
and the 8k tenant leaves 10× headroom on evidence; B-18 (board-reg index)
stays deferred with its stated trigger.

## 20. Test Infrastructure Audit  (Section 19)

1,582 tests × 12 workspaces, run twice back-to-back with identical results at
P8 close; the two historical "flakes" were diagnosed to root cause (a wedged
lock-holder process; a suite that exhausted a real rate limiter) rather than
retried away. Re-evaluated as instructed, **not** marked resolved:
- **B-35** (fixed-uuid fixtures): FENCED — advisory lock + `unref()` +
  `asBootstrap()`. Keep the lock; the stronger fix (per-run ids) remains
  unjustified while the lock holds. Still OPEN, correctly.
- **B-43**: four suites (academics `api.test.ts`, three rms solver suites)
  remain OUTSIDE the fence — confirmed still true by import inspection. Risk
  is interleaving-only; recommend fixing in the routine phase since those are
  the suites it will touch anyway.
- **B-41** (two table/card systems): both halves still live; still a
  conversion backlog, not a deletion.
- Test files sit outside every tsconfig by design with a frozen baseline
  (68 files) and a drift guard that fails on additions — adequate.
- Misleading tests: P8 found and fixed **three** tests asserting a defect
  (Latin-digit pins) and one pinning a stale domain. The adversarial refuter
  pass (16 of 56 removal claims refuted) is the pattern to keep for future
  audits.

## 21. Production Reality  (never mixed)

From `docs/production-evidence.json`, re-read this audit; the environment
field is load-bearing and the preflight treats mismatches as unverified.

- **OBSERVED IN PRODUCTION:** deployment live (sikhon.systems, systemd+Caddy);
  DB posture (roles non-BYPASSRLS, 0 tenants visible without context);
  backups configured; **restore drill performed**; TLS on the apex.
- **REHEARSED LOCALLY:** the 29-check security probe (needs 2 tenants;
  production has 0); the whole application test matrix; offline.
- **NOT OBSERVED:** wildcard DNS/TLS + subdomain routing; real SMS to a
  handset; an alert reaching a human; pilot onboarding; field offline.
- **BLOCKED:** real push delivery (documented obstacle).

Also real: production runs migration **48**; everything from 049 up —
including the entire commercial model and every P7/P8 fix — is undeployed. A
deploy + migration run is itself a MUST-BEFORE-PILOT step and its rollback
files exist through 062.

## 22. Business / Commercial Readiness

D16 is fully operable (plans, manual payments, derived lifecycle, per-service
entitlements, caps, grace — all screen-driven, all audited, boundary dates in
Dhaka time). Genuinely commercial blockers are external: SMS aggregator
contract (B-1), MFS credentials, a first pilot agreement (B-5), and the
"under one hour onboarding" metric which stays honestly UNMEASURED (B-29)
until B-5. Receipt-serial convention (§6) is the one product-side finance gap
worth closing pre-pilot.

---

## 23. Top 20 Risks (ranked)

1. **Deactivated accounts keep access forever** via refresh (proved live, §10).
2. **No alert has ever reached a human** — a stopped SMS cron would currently be discovered by a school, not by us.
3. **No real SMS ever sent** — the pipeline's last mile is untested against a real aggregator (B-1).
4. **Production is 14 migrations behind** the repository; nothing from P7/P8 exists there.
5. Teacher absence is invisible to the product (no staff attendance/leave writer) while substitution assumes it.
6. Wildcard DNS/TLS unverified — the per-school URL promise is untested.
7. `platform/overview` linear cost: console degrades from ~100 institutions.
8. Operator anonymity in the platform audit trail (B-39) once operator #2 exists.
9. PII key custody / data-residency undecided (B-21) — a regulatory, not code, risk.
10. Real push never delivered (blocked) — guardian notification promise rests on SMS that also hasn't been sent.
11. Solver performance at real scale unmeasured (bounded risk; algorithmically fine).
12. Restore drill has run once; no schedule for re-drilling post-migration-catch-up.
13. B-43's four unfenced DB suites can interleave — a future "flake" already predicted.
14. Light-theme worst contrast passes AA by 0.01 — one token nudge from a violation.
15. Support mode absent (B-38): fine at pilot scale, painful at 50 schools; blocker is documented.
16. No user-visible session/device management (revocation is admin/DB-side only).
17. `check-secrets` pattern stale (B-42) — silent until the day it matters.
18. Two design systems for tables/cards (B-41) — consistency debt that compounds per new screen.
19. "One hour onboarding" claim unmeasured (B-29) — a sales promise without evidence.
20. Documentation drift risk: audit-plan Appendix B itself is stale (names as open several items since resolved) — the audit plan should be corrected after this report lands.

## 24. Top 20 Recommended Improvements

(1) Fix refresh/status + revoke-on-deactivate. (2) Teacher attendance
minimal loop. (3) `teacher_leaves` write path + approval. (4) Routine input
wizard + generate button (P9 core). (5) Double-period placement. (6) Scoped
re-solve for the editor. (7) Guardian block + `tel:` on principal/IT student
views. (8) Class-teacher phone policy knob (default OFF). (9) Guardian
"today's status" card. (10) Absent-trend sparkline on principal home.
(11) Receipt serials per tenant-year. (12) Merit/tabulation print view.
(13) Session list + sign-out-others. (14) Operator directory (kills B-39).
(15) Grouped overview query + console pagination. (16) Onboarding checklist
card for tenant IT admin (reuse `tenant_onboarding_state`). (17) Class-test
lightweight exam path. (18) Widen `check-secrets`. (19) Fence B-43's four
suites. (20) Stipend eligibility report (first report cycle).

## 25. MUST BEFORE PILOT

| # | Item | Why | Size |
|---|---|---|---|
| M1 | Refresh checks `users.status` + deactivation revokes sessions | proved live privilege-retention hole | XS |
| M2 | Deploy current revision + run migrations 049–062 on production; re-drill restore after | pilot cannot run on migration 48 | S (ops) |
| M3 | Wildcard DNS/TLS + subdomain routing verified, or pilot explicitly on `?tid=` links (owner call) | the URL a school is given must work | S (ops) ⚑ |
| M4 | SMS aggregator contract + one real delivered message + DLR observed | attendance SMS is the pilot's headline promise | external (B-1) |
| M5 | One alert delivered to a human (webhook → phone) and the runbook step verified | silent-failure discovery must not be a school | XS |
| M6 | Teacher attendance minimal loop (mark absent today → substitute finder) | §6's strongest gap; the register every school keeps | S–M |

## 26. SHOULD BEFORE PILOT

Guardian today-status card · guardian block+`tel:` for admin roles ·
teacher-leave form · receipt serials · absent-trend sparkline · class-test
path · merit list print · session list UI · operator directory ·
`check-secrets` widening · pilot-onboarding runbook dry run against a fresh
tenant (measures B-29 honestly).

## 27. POST-PILOT

P9 Smart Routine (full) if not started earlier · overview scaling + console
pagination (trigger ~100 tenants) · bulk operations (B-40, trigger ~50) ·
support mode (B-38, design cost stated) · stipend report · form fill-up ·
online admission · hifz tracking · MFS payment initiation (separate approval
per D16) · object storage/stored PDFs (B-17) · alumni surface (D9) · B-41
table/card convergence · B-19 seven legacy views · CSV/audit export
(B-11/B-12).

## 28. NOT RECOMMENDED

Passwords for any role (weaker than the current model here) · platform-global
student ID (privacy cost, no pilot benefit) · ILP/CP solver dependency now ·
library/hostel/transport/payroll modules · client-side PDF or chart libraries
(device floor) · a school-picker on any public surface (D12) · building
impersonation before B-38's policy work · real-time chat (B-20 stands, gated
on moderation design).

## 29. Proposed Final Roadmap

- **P-pilot-hardening (1 short phase):** M1–M6 + the SHOULD list's XS/S items.
  Exit: pilot school onboarded, SMS observed, alert observed, B-29 measured.
- **P9 — Smart Routine Generator** (§30). Can start in parallel with pilot
  hardening; ships behind the existing draft/publish lifecycle.
- **P10 — Identity & Guardian polish** (§31+§32 merged: session UI, guardian
  visibility knob + call UX, student-facing guardian card). Small.
- **P11 — Scale pass** when triggers fire (overview query, pagination,
  operator directory if not already done, B-43 fencing).
- **P12 — Post-pilot feature wave** from §27, ordered by pilot feedback.
- Standing: after this report, update FINAL-FULL-PROJECT-AUDIT-PLAN Appendix B
  (it predates R-7-completion and names resolved items as open).

## 30. Proposed Smart Routine Phase (P9)

**Scope:** (a) Setup wizard — 5 steps over existing tables: ① school day &
period template (+breaks) ② confirm classes/sections (already exist) ③
per-class subject frequencies (`class_subjects.periods_per_week`, double
periods) ④ teacher assignment/load (exists) + availability grid ⑤ rooms &
capabilities. (b) Generate = existing `/rms/solve` behind a button with the
existing §8.2 report. (c) Editor upgrades: scoped re-solve, per-slot lock
(pinning exists), publish (exists). (d) Outputs: teacher/section/student
views exist; ADD class-wise and whole-institution print sheets (one renderer,
reuse branded-doc). (e) Double-period placement in the solver. (f) Perf:
record `solver_seconds` on realistic fixtures (10/40/80-section synthetic
tenants); accept ≤60s at 80 sections, else document bounds honestly.
**Explicitly not in P9:** ILP, drag-drop, per-teacher preference weighting
beyond the existing caps. **DB implications:** none structural — the schema
already carries every input. **API:** wizard reads/writes existing tables;
one new scoped-solve parameter. **Security:** RMS_ROLES already gate
generate/edit/publish; read views already role-scoped (student day is 049).

## 31. Proposed Identity/Login Phase (P10a)

M1 (if not already shipped in hardening) + session/device list with revoke
("এই ডিভাইস ছাড়া সব থেকে সাইন আউট") + document the account-state mapping and
the office recovery runbook (re-issue codes; nobody can ever see a
credential) + delete the unused `reset_password` OTP purpose and the unused
`password_hash` column note (documented decision, not silent removal).
**Keep the no-password model** — this is a recommendation to ratify, ⚑.

## 32. Proposed Guardian/Student Sync Phase (P10b)

Guardian block on the admin student views with `tel:` links (server already
returns the phone to exactly these roles) · per-tenant class-teacher-phone
setting, default OFF, enforced in `mayEdit`-style server code, disclosure
audited · roster shows guardian name/relation to the class teacher · student
sees primary-guardian name/relation · demo gets the same states. All UI +
one settings key; zero schema change beyond the setting.

## 33. Release Readiness Verdict

**Architecture and feature scope: COMPLETE — ready to be frozen as the
product definition.** Nothing found in this audit requires re-architecture;
the three new owner requirements all land inside the existing design.
**Pilot readiness: NOT YET — six MUST items (§25), one of them a proved
security defect, four of them operational/external.** The honest sequence is
the two-to-three weeks of §29's hardening phase, not more feature work. The
product's strongest property, consistently re-verified, is that its safety
claims are enforced by the database and proved by paired positive/negative
tests rather than asserted; the audit's material findings were, fittingly,
in the two places nothing was looking (refresh path, teacher register).

---

## Final Owner Questions — direct answers

1. **Forgot anything important?** Yes: teacher/staff attendance (§6 — the
   register every school keeps; our own substitute finder waits for data
   nothing can write). Everything else missing is post-pilot by evidence.
2. **Dashboards missing something?** Guardian: today's-status card. Principal:
   teacher absence + absent trend. Teacher/student/IT: materially complete.
3. **Is the login architecture right?** Yes — keep codes+OTP, no passwords
   (§10). It has one proved hole (deactivation ≠ revocation): M1.
4. **Can a school self-operate?** Yes for everything except producing a first
   routine (§12). P9 closes the last self-service gap.
5. **Can an operator manage 100+ institutions safely?** Safely yes (isolation,
   audit, per-tenant controls), efficiently no: overview cost is linear
   (1.36s @ 79) and unpaginated; fix shape is known (§11/§19).
6. **Tenant isolation strong enough?** Yes, with evidence in both directions
   (§14): DB-enforced, FORCE everywhere, fail-closed, probed 29/29, A↔B
   byte-identical under 11 mutations.
7. **Guardian/student sync complete?** Model and enforcement yes; UX no —
   no call button, no policy knob, guardian block only in the drill-down
   (§9). P10b closes it.
8. **Smart Routine Generator realistic?** Yes — ~70% exists and is tested;
   the missing 30% is input UX and two solver features, not new technology
   (§8, §30). One-minute target: plausible, must be measured.
9. **What would make the product significantly better?** In order: teacher
   attendance loop, routine self-service (P9), guardian call UX, the
   stipend/merit/receipt trio that makes the office love it, and an alert
   that actually reaches a human.
10. **What MUST we do before a real pilot?** §25's six items: fix
    deactivation, deploy + migrate + re-drill restore, prove the school URL,
    send one real SMS, page one real human, and give schools the teacher
    register. Everything else can meet the pilot on the way.

**⚑ Owner decisions required:** M3 subdomain-vs-`?tid=` for the pilot ·
class-teacher phone default (§9) · ratify no-passwords (§31) · approve P9
scope (§30) · B-27 target architecture (long-standing) · B-21 PII custody.

*End of report. No code, schema, API, UI, routing or landing-page changes
were made. `index.html` verified byte-identical at `496199bd` before and
after the audit.*
