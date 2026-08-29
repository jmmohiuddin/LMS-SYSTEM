# 11 — Master Plan: Multi-School White-Label SaaS Roadmap

**Status:** Approved plan of record — implement phase by phase, in order.
**Date:** 2026-08-29
**Supersedes:** the four "PHASE-0" documents in `~/Downloads` (46-table ERD, migration
plan, API/security spec, master summary). Those were written without auditing this
repository and describe migrating a legacy system to a new "v2" schema. **No such
migration is needed** — the live schema (38 migrations, ~100 tables, RLS-enforced
multi-tenancy) is already ahead of that ERD in every dimension. Their useful ideas
(security sign-off checklist, notification targeting matrix, print-document field list)
are folded into the phases below.

---

## সারসংক্ষেপ (বাংলা)

এই সিস্টেম **ইতিমধ্যে মাল্টি-টেন্যান্ট** — এক কোডবেস, অনেক স্কুল, ডাটাবেস-লেভেলে
(RLS) আইসোলেশন। ক্লাস → গ্রুপ → সেকশন → শিফট হায়ারার্কি, বছরভিত্তিক এনরোলমেন্ট
হিস্টরি, স্থায়ী স্টুডেন্ট আইডি, শিক্ষক অ্যাসাইনমেন্ট, প্রমোশন/রোলওভার, অফলাইন
অ্যাটেনডেন্স + সিংক, পরীক্ষার রুটিন, মার্কস → রেজাল্ট → GPA, ফি/ইনভয়েস — সব বানানো
এবং টেস্টেড (**৭০৯ টেস্ট পাস, ০ ফেইল** — ২০২৬-০৮-২৯ যাচাইকৃত, R-3 শেষে; এর সাথে
১৯টি SQL সুইট যা সত্যিকারের PostgreSQL-এ চালিয়ে দেখা হয়েছে)। **নতুন করে ভিত্তি
বানানোর দরকার নেই।**

যা নেই, সেটাই এই প্ল্যান — অগ্রাধিকার অনুযায়ী:

1. **হোয়াইট-লেবেল ব্র্যান্ডিং** — প্রতিটা স্কুল তার নিজের নাম, লোগো, রঙ, ওয়াটারমার্ক দেখবে (আপনার ১ নম্বর দাবি)
2. **নোটিশ ও নোটিফিকেশন** — সবাই / শুধু শিক্ষক / শুধু ছাত্র / শুধু অভিভাবক / ক্লাস / সেকশন টার্গেটিং + ইন-অ্যাপ নোটিফিকেশন বেল
3. **প্রধান শিক্ষক ও আইটি পোর্টাল সম্পূর্ণ করা** — ক্লাস ৯ → সায়েন্স → F সেকশন → ৪০ ছাত্র ড্রিল-ডাউন, শিক্ষক অ্যাসাইন/রিপ্লেস UI, ইউজার ম্যানেজমেন্ট
4. **ক্যালেন্ডার UI** — ছুটি, ইভেন্ট, পরীক্ষা
5. **ব্র্যান্ডেড প্রিন্ট** — রসিদ, রিপোর্ট কার্ড, এডমিট কার্ড — স্কুলের লোগো/ওয়াটারমার্ক সহ
6. **স্টুডেন্ট সার্চ ও হিস্টরি** — ১০ বছর পরেও আইডি দিয়ে খুঁজে পাওয়া
7. **অনবোর্ডিং ও প্ল্যাটফর্ম কনসোল** — নতুন স্কুল যোগ করার উইজার্ড
8. **গো-লাইভ আনলক** — SMS এগ্রিগেটর, OTP লগইন চালু, MFS

**সফটওয়্যার নাকি ওয়েব?** — সিদ্ধান্ত: **ওয়েব + PWA** (ইতিমধ্যে বানানো)। স্কুলের পিসি/ফোনে
ইনস্টল করা যায়, নেট গেলে অফলাইনে কাজ চলে, নেট এলে সিংক হয়। আলাদা ডেস্কটপ সফটওয়্যার
বানানো হবে না — এক কোডবেস, আপডেট এক জায়গায়।

**সেকশন চ্যাট** — ইচ্ছাকৃতভাবে পরে (মডারেশন/সেফটি জটিলতা); Phase R-9-এ ঐচ্ছিক।

---

## 1. Decisions of record

| # | Decision | Rationale |
|---|---|---|
| D1 | **Keep the existing architecture.** Modular monolith (9 service dirs → serverless functions), Neon Postgres + RLS tenancy, framework-free PWA, IndexedDB outbox. | It works, it's tested, and it already satisfies the hardest requirements (tenancy, offline, history). Rewriting is the only way to lose. |
| D2 | **Discard the Downloads "Phase-0 / Architecture v2" migration plan.** | It assumes a legacy schema that doesn't exist. The live schema is stronger than its 46-table ERD (partitioning, RLS, envelope PII crypto, GiST clash constraints, board-rule SQL functions). |
| D3 | **Web + PWA, not desktop software.** | Already built and offline-capable. One codebase, zero install friction, instant updates. |
| D4 | **White-label via configuration, never per-school code.** Branding lives in `tenants.settings` (jsonb) + a `tenant_branding` read path; the codebase stays identical for every school. | Matches repo rule and PRD §10: no `schoolA.css`. |
| D5 | **Roles stay code-gated for now (`requireRole`/`requireStaff` + RLS).** Permission-level RBAC (`role_permissions` is seeded but unread) is deferred until a real need appears. | RLS is the actual enforcement; wiring 22 permissions now adds surface without adding safety. |
| D6 | **Notifications: in-app first, SMS as a channel of the same system.** One `notices` model fans out to in-app inbox rows + `sms_outbox` rows through the existing outbox/cron pipeline. | Reuses the built, suppression-aware SMS pipeline; SMS is ~80% of infra cost, so push/in-app first. |
| D7 | **New agent surfaces follow the Ata Ekta design system** (tokens in `apps/pwa/public/design/tokens/`). | Consistency; dark mode already tokenised. |
| D8 | **Every new table gets: `tenant_id` + `app.enforce_tenant()` trigger + RLS policy + rollback file + probe in `migration-status.mjs`.** This is the existing schema-lint rule; it stays absolute. | Tenant isolation is the product. |
| D9 | Section chat, native apps, biometrics, library/transport/hostel/payroll = **post-roadmap add-ons**. | PRD "What NOT to do": don't build social features before core management is stable. |
| D10 | **[`docs/PHASE_LOG.md`](PHASE_LOG.md) is the canonical chronological implementation history.** It is updated *before* a phase may be marked complete, and after every meaningful change: a phase, a bug fix, an architectural decision, a migration, a test milestone, a deployment change, an important discovery. History is append-only — a decision that supersedes an earlier one gets a NEW entry saying what changed, why, and what replaced it; the old entry stays. | A new agent (or a new engineer) must be able to read one file and know what has happened here from the beginning, without any chat history. Chat context is lost; a file in the repository is not. Silently editing away an old decision destroys the reasoning that a future reader needs most — the reason something was tried and abandoned. |
| D11 | **`shikhonBD` is the permanent platform and marketing brand. White-labelling applies ONLY to a tenant's operational application and the documents it produces.** The public marketing site, platform documentation, and any future platform Super Admin console stay branded shikhonBD / eShikhon. A school's login, shell, PWA identity, notices, receipts and reports carry the school's identity. Enforced in both directions by the `Brand boundary (D11)` job in `.github/workflows/frontend.yml`. | R-1 removed the platform brand from tenant screens, which was correct — and created the opposite risk, because "remove ShikhonBD" reads like a rule that applies everywhere. It does not. The landing page is *our* shopfront; un-branding it would be a marketing loss nothing else would catch. The one-line statement of the rule is: **the platform is branded, the tenant application is white-labelled.** |
| D12 | **Tenant resolution: each institution gets its own entry link — never a school-picker.** Today that is the install link (`/?tid=<tenant-id>`, or the slug typed once on the login screen); the device remembers it, the PWA install bakes it into `start_url`, and the login screen renders that school's identity before anyone signs in. At R-7 each tenant additionally gets a subdomain (`monipur.shikhonbd.com`) resolved from the hostname, with custom domains as a later option. A "choose your school" dropdown is forbidden at every stage. See §1b for the full mechanism. | One deployment must serve many institutions without ever showing one school's users another school's door. A picker would enumerate our customer list to anyone who loads the login page — the same reason `app.public_branding()` answers only exact keys and returns 200-with-defaults for unknown ones. The link a school hands out is the same channel it already uses for everything else it tells its guardians. |
| D13 | **A feature is not implemented until a person can use it.** Every phase is verified across all 18 layers of §1c — database, service, API, authorization, UI, workflow, and the loading / empty / error / success states that make a screen usable, plus responsive, offline, real-time, notification, audit, test, browser-acceptance and PHASE_LOG coverage where each applies. Any Master Plan requirement describing something a principal, teacher, student, guardian or IT admin is expected to *use* must have a usable UI unless it is explicitly marked backend-only. Where a capability exists but its screen does not, it is reported as **"Backend complete — UI pending"** — never as complete. | The failure this prevents is specific and had already happened here: R-2 finalisation made the notice-SMS cap tenant-configurable, tested it, documented it — and left no way to configure it except writing SQL by hand. A setting only a developer can reach is a setting a school does not have. The same shape recurs whenever a phase is judged by its migration and its test count, because those are the parts that are easy to count. A school does not experience a table or an endpoint; it experiences a screen, and a screen that has no empty state is broken on its first day, when everything is empty. |

---

## 1a. Surfaces — which brand belongs where (D11)

Three distinct surfaces, and confusing them is the failure mode D11 exists to
prevent:

```text
PUBLIC PLATFORM                          TENANT APPLICATION
  shikhonBD / eShikhon                     school-a.<platform>
  ├── landing / marketing site             college-b.<platform>
  ├── pricing, public docs, SEO            ├── login          ─┐
  ├── platform Super Admin console         ├── shell / PWA     │ the
  └── company communications               ├── notices         │ school's
       → BRANDED shikhonBD                 ├── receipts        │ identity
                                           └── reports        ─┘
                                                → WHITE-LABELLED
```

The marketing site sells the platform; the application runs a school. A school's
staff, students and guardians spend their year inside the right-hand column and
should see their own institution there. Anyone evaluating the product is in the
left-hand column and should see ours.

Platform attribution inside a tenant application is not forbidden, but it is a
deliberate design decision (a discreet footer, say) — not something that arrives
by a string nobody removed.

**Current state — resolved (R-1-A, 2026-08-29).** The three surfaces now live at
three addresses, Option B of the three set out in [PHASE_LOG.md](PHASE_LOG.md):

| Address | File | Surface | Brand |
|---|---|---|---|
| `/` | `apps/pwa/public/index.html` | shikhonBD marketing site | **platform** |
| `/app` | `apps/pwa/public/app.html` | the tenant application | white-labelled |
| `/design` | `apps/pwa/public/design.html` | the Ata Ekta prototype | white-labelled |

Routed identically on both hosts (`vercel.json` rewrites, `netlify.toml`
redirects declared before the catch-all). The service worker treats only
`/app*` navigations as the application, so it never answers the marketing site
with the app's HTML; `PRECACHE` and the offline fallback point at `/app`; the
web manifest installs with `start_url` and `scope` of `/app`.

---

## 1b. One deployment, many institutions — how a school reaches ITS door, and why it can never open another's (D12)

The owner's question, stated plainly: *there is one server and one login page —
so how do Monipur High School's people log into Monipur, Mohammadpur's into
Mohammadpur, with each school's admins, teachers, students, guardians, data and
rules completely separate?* Everything below is **already built and tested**;
this section exists so the mechanism is written down rather than implied.

### How a user reaches their own school's login

```text
The school hands out ITS link            The device from then on
──────────────────────────────           ───────────────────────────
shikhonbd…/?tid=<monipur-id>      →      remembers the tenant (localStorage),
  (printed on the admission slip,        shows MONIPUR's name/logo/colours on
   sent in the school's SMS, QR          the login screen BEFORE sign-in (R-1),
   on the office wall)                   installs the PWA as "Monipur High"
                                         (start_url carries ?tid=)
```

- **No link?** The login screen asks once for the school ID (slug) — a fallback,
  not the main road.
- **R-7 adds subdomains**: `monipur.shikhonbd.com`, tenant resolved from the
  hostname; optional custom domains later. The `?tid=` link keeps working.
- **Never a school-picker dropdown** (D12): it would enumerate the customer
  list, and `app.public_branding()` is deliberately built so that enumeration is
  impossible — exact key in, one school out, nothing for an unknown key.

### Why crossing tenants is impossible, not just forbidden

Four layers, each independent of the one above it; the bottom one is the actual
guarantee:

```text
L1  IDENTITY   users are tenant-scoped rows. A Monipur teacher's account IS a
               Monipur row; phone+OTP verifies within that tenant; the JWT
               carries tid, EdDSA-signed — unforgeable, 15-minute life.
L2  API        no endpoint accepts a tenant id in URL or body. The only tenant
               a request can name is the one in its verified token. There is
               no parameter to tamper with.
L3  SESSION    every DB transaction starts with SET LOCAL app.tenant_id from
               the token (packages/server-core withTenant()).
L4  DATABASE   Row-Level Security on every tenant table (~95), FORCE'd, fail-
               closed: Mohammadpur's rows are invisible to a Monipur session
               at the database layer. A bug in L1–L3 yields zero rows, not
               another school's data. No context at all → zero rows.
```

Beneath even L4: the app's runtime DB role cannot BYPASSRLS (boot guard refuses
to start), and each tenant's PII is encrypted under **its own key**
(`tenants.dek_wrapped`) — school A's identifiers cannot be decrypted with school
B's key even if rows somehow leaked. Per-tenant SMS caps, AI budgets and rate
limits keep one school's usage from affecting another's.

**Inside** a school, the same L4 narrows further by role (the RESTRICTIVE
policies of migration 010): a student reads only their own records, a guardian
only their linked children (`guardianships`), a teacher only their assigned
sections, the principal the whole institution — *their* institution.

### The people, concretely

- Monipur's admin, headmaster, teachers, students, guardians are all rows with
  Monipur's `tenant_id`; their roles (`user_roles`) are tenant-scoped too. The
  headmaster of Monipur holds `principal` **in Monipur** — the word grants
  nothing anywhere else.
- One person serving two institutions (an examiner, a guardian with children in
  two schools) has **two accounts**, one per school, joined internally by the
  permanent `global_person_id`; they enter each school through that school's own
  link. No screen ever merges two schools' data.
- Every school's own rules — weekend days, shifts, grading bands, fee
  structures, calendar, subject sets, branding — are that school's rows,
  isolated the same way as its people.

### Proof, not promise

CI's tenancy suite (and R-1's `db/tests/tenant_branding.sql`) asserts it
directly: with school A's session context, `SELECT`/`UPDATE`/`DELETE` against
school B match **zero rows**, and a session with no tenant context sees nothing
at all. Every new table is required to join this regime (D8) and the schema-lint
test fails CI if one ships without RLS.

---

## 1c. Definition of done, layer by layer (D13)

A phase is complete when every applicable layer below is done **and verified**, not
when the migration applies and the tests are green. Layers that genuinely do not
apply are marked *n/a with a reason* — "n/a" alone is not an answer.

| # | Layer | What "done" means |
|---|---|---|
| 1 | Database / migration | Forward + rollback, RLS, `tenant_id`, probe in `migration-status.mjs` (D8) |
| 2 | Backend / service logic | The rule lives in one place, not copied per caller |
| 3 | API | Routed, role-gated, shaped for the screen that consumes it |
| 4 | Authorization / tenant isolation | Enforced server-side and by RLS — never by hiding a button |
| 5 | **Frontend UI** | A real screen a real person reaches by navigating, not by typing a URL |
| 6 | User workflow / UX | The whole path end to end, including how someone backs out of it |
| 7 | Loading state | What the screen shows on a 2G connection before the data lands |
| 8 | Empty state | **What it shows on day one, when the school has no data at all** |
| 9 | Error state | What it shows when the request fails, in Bangla, saying what to do |
| 10 | Success state | Visible confirmation that the thing happened |
| 11 | Responsive behaviour | Usable on the ৳8,000 Android phone most teachers actually carry |
| 12 | Offline behaviour | Where promised: works offline, queues, and *says* it queued |
| 13 | Real-time behaviour | Where promised — and where not promised, the UI must not imply it |
| 14 | Notifications | Where the workflow should tell somebody something happened |
| 15 | Audit / history | Where a school may later need to prove what was done, by whom |
| 16 | Tests | Backend **and** UI, in the same commit as the feature |
| 17 | Browser acceptance test | For every important workflow, driven through the real UI |
| 18 | Documentation / PHASE_LOG | Written *before* the phase is called complete (D10) |

### The UI-first rule

If the Master Plan describes something a school administrator, principal, teacher,
student or guardian is expected to use, it needs a usable screen. Not an endpoint
plus an intention.

| Requirement | The screen it owes |
|---|---|
| Teacher assignment | assignment UI |
| Teacher replacement | replacement UI |
| Student promotion | promotion workflow UI |
| Notice targeting | audience picker UI |
| Notification | bell / inbox UI |
| SMS settings | admin settings UI, wherever configuration is expected |
| Branding | branding editor |
| Calendar | calendar UI |
| Search / history | search + student history UI |
| School onboarding | complete setup wizard |
| Reports | report UI with an export / print workflow |
| Fees | fee, payment and receipt UI |

The only exception is a requirement explicitly marked **backend-only** or
**infrastructure-only** in this plan. Marking one that way is a decision that gets
written down with its reason, not a default.

### No backend-only claim

Where the capability exists and the workflow does not, the phase report says:

> **Backend complete — UI pending.**

It does not say complete, done, or shipped. This is not pessimism about the work;
it is an accurate statement of what a school can currently do with it.

### Acceptance criteria

Every major feature is exercised end to end, through the interface a person uses:

```text
User → UI → API → Authorization → Database → Result → UI feedback
```

Multi-tenant features are additionally proven from both sides of the wall:

```text
Tenant A                    → correct UI and data
Tenant B                    → different UI and data
Tenant A reaching for B     → blocked
```

Offline-capable features are proven through the whole cycle, including what the
screen tells the user at each stage:

```text
Online      → action
Offline     → the action still works where we promised it would
Reconnect   → it syncs
UI          → shows the correct sync status throughout
```

### Phase reporting format

Every phase report separates the layers, so that a gap is visible rather than
averaged away by the ones that went well:

```text
Backend implemented        …
API implemented            …
UI implemented             …
UX tested                  …
Security tested            …
Tenant isolation tested    …
Offline tested             …
Real-time tested           …
Browser acceptance tested  …
```

If any applicable layer is missing, the phase is not described as fully complete.

---

## 2. What already exists (do NOT rebuild)

Verified against the repo 2026-08-29 (full audit in §6 of the audit report; summary here so
no phase accidentally re-implements these):

- **Multi-tenancy** — `tenants` root, `tenant_id` on ~95 tables, `app.enforce_tenant()`,
  generated RLS on every table, `FORCE ROW LEVEL SECURITY`, boot-time `assertRlsEnforced()`.
- **Academic hierarchy** — `classes` (level 1–12, `stream`, academic `group`
  science/humanities/business), `sections` (class × year × name × shift, capacity,
  `class_teacher_id`), `subjects`/`subject_papers`/`class_subjects` (NCTB mark split),
  per-student resolved subject sets (`student_subjects`, `app.derive_student_subjects()`).
- **Permanent identity & history** — `users.global_person_id` (immutable, lifetime),
  `student_profiles.student_code`, one `enrolments` row per student per year
  (roll, status, dates) — the "10 years later" requirement is already modeled.
- **Year lifecycle** — `academic_years.is_current`, `year_rollovers`,
  `app.rollover_preview()` / `app.commit_rollover()` (promote/detain/graduate with
  per-student Bangla blockers).
- **Teacher assignment** — `section_subject_teachers` (section × subject × teacher × year),
  `sections.class_teacher_id`, competencies/expertise tables. (Replacement **UI** is a gap — Phase R-3.)
- **Guardians** — `guardianships` M:N (`is_primary`, `receives_sms`, `can_pay_fees`),
  `/academics/ward` single-response guardian home, guardian dashboard view.
- **Attendance + offline** — partitioned `attendance_records`, corrections (append-only),
  30-second grid UX, IndexedDB outbox with zero-loss contract, Background Sync,
  per-entity conflict policy. Offline login persistence via 30-day refresh tokens.
- **Exams** — component-wise marks (CQ/MCQ/practical/CA), publish = grade→GPA→rank→lock
  in one transaction, immutable after publish, `mark_corrections` with approval,
  exam routine with student-clash gate, seat plan, invigilation.
- **Timetable/RMS** — versioned routines, GiST exclusion constraints (double-booking
  structurally impossible), solver, editor UI, substitution finder with ranked candidates.
- **Finance** — fee heads/structures/waivers, invoice generation (idempotent per
  student+period), MFS webhook skeleton, double-entry ledger with balance assertion,
  digital receipts (JSON; print/PDF is the gap — Phase R-5).
- **Import** — CSV wizard with dry-run → digest → commit (`/academics/import`,
  `import-view.ts`). Export is the gap.
- **Provisioning** — `app.provision_tenant()` seeds year/terms/grading/classes/sections/
  subjects/bell-schedule/fee-heads/chart-of-accounts in one call. UI is the gap — Phase R-7.
- **Security** — EdDSA JWT (15 min) + rotating refresh (30 d, reuse detection), argon2id,
  Postgres token-bucket rate limiting on every endpoint, AES-256-GCM envelope PII
  encryption + blind indexes, PDPA-grade `audit.pii_access`.
- **AI** — SikhokAI (teacher co-pilot) + ShikhoAI (Socratic tutor), PII redaction,
  session audit, budget tables. Dark until `ANTHROPIC_API_KEY`.
- **SMS pipeline** — event → suppression (grace window, holidays, caps, consent) →
  `sms_outbox` (dedupe, segments, cost) → cron drain. **Send is a stub** — Phase R-8.

---

## 3. Requirement → status map (from the owner's brief)

| Owner requirement | Status today | Phase |
|---|---|---|
| স্কুলের নিজস্ব লোগো/নাম/তথ্য সর্বত্র (white-label) | **Missing** | **R-1** |
| প্রিন্টে স্কুলের ওয়াটারমার্ক/লোগো (রসিদ ইত্যাদি) | Missing | R-1 (foundation) + R-5 (documents) |
| ক্লাস → গ্রুপ → সেকশন → ছাত্র ড্রিল-ডাউন (প্রধান শিক্ষক) | **Done (R-3)** | — |
| সেকশনে শিক্ষক অ্যাসাইন / বছরে বছরে নতুন অ্যাসাইন | **Done (R-3)** | — |
| শিক্ষক চলে গেলে রিপ্লেসমেন্ট, হিস্টরি অক্ষত | **Done (R-3)** — মাইগ্রেশন ০৪১ ছাড়া স্কিমা এটা পারত না | — |
| আইটি প্রোফাইল — পুরো স্কুল ম্যানেজ করবে | **Mostly done (R-3)** — শ্রেণি/সেকশন তৈরি ও অভিভাবক সম্পাদনা বাকি | R-4+ |
| এক সার্ভার থেকে প্রতিটি স্কুল সম্পূর্ণ আলাদা — লগইন, ডেটা, রুলস, লোকজন | **Exists** (tenant-scoped identity + 4-layer isolation, per-tenant crypto keys) — mechanism written up in **§1b** | R-7 adds per-school subdomains |
| ছাত্রের আপডেট গার্ডিয়ান+শিক্ষক+প্রধান শিক্ষক সবাই দেখবে (sync) | **Exists** (one DB + RLS + sync pull) | — |
| গার্ডিয়ান শুধু নিজের সন্তান দেখবে | **Exists** (RLS `guardianships` scoping) | — |
| ছাত্র শুধু নিজেরটা দেখবে | **Exists** (RLS self-scoping) | — |
| নোটিশ বোর্ড + টার্গেটেড নোটিশ (শিক্ষক/ছাত্র/গার্ডিয়ান আলাদা) | **Done (R-2)** | — |
| নোটিফিকেশন বেল — সবার ড্যাশবোর্ডে পৌঁছাবে | **Done (R-2)** | — |
| গার্ডিয়ানের ফোনে সরাসরি SMS | Pipeline built, provider stubbed | R-2 (wire-up) + R-8 (credentials) |
| এক্সাম রুটিন আপডেট | **Exists** | — (R-2 adds its notifications) |
| ক্যালেন্ডার — ছুটি/ইভেন্ট, স্কুল-অনুযায়ী | Table exists; **API+UI missing** | R-4 |
| অফলাইনেও অ্যাটেনডেন্স, নেট এলে সিংক | **Exists** | — |
| ১০ বছর পরে আইডি দিয়ে ছাত্র খুঁজে পাওয়া | Modeled + indexed; **endpoint+UI missing** | R-6 |
| প্রতি বছর সহজে নতুন অ্যাসাইন (promotion) | **Done (R-3)** — পূর্বরূপ → পরিকল্পনা → নিশ্চিতকরণ | — |
| সফটওয়্যার নাকি ওয়েব | **Decided: Web+PWA** (D3) | — |
| সেকশন-ভিত্তিক কমন চ্যাট (ঐচ্ছিক) | Missing, deliberately | R-9 (optional) |
| নতুন স্কুলকে দ্রুত সার্ভিস দেওয়া (onboarding) | `provision_tenant()` SQL only | R-7 |

---

## 4. The roadmap

Phases are numbered **R-1 … R-9** (R = rollout, to avoid colliding with the old PRD's
Phase 0–4). Each phase is independently shippable, ordered by (a) owner priority,
(b) dependency, (c) daily-habit-before-quarterly. **Definition of done for every phase**
is `05-DELIVERY-ROADMAP.md` §7 — migrations forward+rollback in CI, tenancy suite green,
RLS on every new table, tests in the same commit, `bn`+`en` strings, bundle gate, and a
docs/07 status update — plus two additions that are not optional:

- **A [PHASE_LOG.md](PHASE_LOG.md) entry, written before the phase is called complete**
  (D10). Not after, and not "when there's time": the entry is part of the work.
- **The `Brand boundary (D11)` CI job green in both directions** — no platform brand on
  tenant surfaces, and the platform brand still present on the marketing site.
- **Every applicable layer of §1c green (D13)** — including the UI, its empty state, and
  a browser acceptance test for each important workflow. A phase with a working endpoint
  and no screen is reported as *Backend complete — UI pending*, not as done.

### R-0 — Hygiene (½ day, do first)

- Add `.gitattributes` (`api/v1/**/*.js text eol=lf`, sensibly cover `netlify/`), run
  `git add --renormalize .` — kills the permanent 10-file phantom dirty state on Windows.
- Update stale counts in `docs/07` (38 migrations, not 23).
- Decide nothing else here; this phase exists so every later diff is clean.

### R-1 — White-label & branding foundation *(owner priority #1)* — **DONE**

> Shipped 2026-08-29. What was built, where it lives, and its known limitations
> are recorded in [07-IMPLEMENTATION-STATUS.md](07-IMPLEMENTATION-STATUS.md) §9b.
> Two deviations from the plan below, both deliberate: branding is keyed by slug
> **or tenant id** (the install link carries the id), and the served `index.html`
> mock-up got its own inline branding bootstrap rather than being restructured.

**Goal:** a school sees only its own identity — app shell, login, PWA install, and a
reusable branded print header — with zero per-school code.

- **DB (migration 039):** define the canonical branding keys inside `tenants.settings`
  jsonb (no new table needed): `branding.name_bn/name_en/short_name, logo_url,
  favicon_url, primary_color, accent_color, address, phone, email, website,
  watermark_url, headmaster_name, headmaster_signature_url, established_year, motto_bn`.
  A `CHECK`-free jsonb contract documented + validated in code (zod-style validator in
  `server-core`). Seed sensible defaults from existing tenant columns (`name_bn`, `eiin`).
- **API:** `GET /api/v1/ops/branding` (authenticated, returns the tenant's branding —
  cacheable, also served pre-auth by tenant slug for the login screen) and
  `PUT /api/v1/ops/branding` (IT-admin/principal only, audited).
- **Asset storage:** logo/watermark/signature upload — small images, stored as data-URLs
  in settings initially (≤64 KB each, validated); object storage comes later with answer
  scripts. This avoids standing up a bucket for Phase R-1.
- **PWA:** `app.ts` boot loads branding by tenant (`?tid=`/localStorage slug) → sets
  document title, header name, logo, and CSS custom properties (`--color-primary` etc. —
  the Ata Ekta tokens are already custom properties, so theming is a style-attribute
  write). Login screen shows the school's name+logo instead of hardcoded `ShikhonBD`.
  Dynamic manifest: a tiny function serving `manifest.webmanifest` per tenant
  (name, theme_color, icons) so "install the app" installs *their school's* app.
- **Print foundation:** one shared `branded-doc.ts` in `ui-core` — school header
  (logo, name, address, EIIN), footer, watermark layer, signature block — consumed by
  every later printed document. Print stylesheet (`@media print`) added to `app.css`.
- **IT screen:** branding editor page (preview live).
- **Tests:** branding validator unit tests; branding API integration test proving tenant
  A can never read/write tenant B's branding (RLS suite extension); PWA boot test that
  hardcoded brand strings are gone (grep-gate in CI like `check-secrets.mjs`).

**Exit:** two demo tenants side by side show different names, logos, colors on login,
shell, and a sample printed page — same deployment, same code.

### R-2 — Notices & notification system *(owner priority #2)*

**Goal:** প্রধান শিক্ষক একটা নোটিশ দিলে টার্গেট অনুযায়ী সবার নোটিফিকেশন বেলে পৌঁছাবে —
এবং চাইলে গার্ডিয়ানের ফোনে SMS।

- **DB (migration 040):** `notices` (tenant, title, body, category
  general/teacher/student/guardian/class/section/exam/fee/emergency, audience jsonb
  {type: all|staff|students|guardians|class|section|users, ids[]}, channels
  {inapp, sms}, publish_at, published_by, status draft/published/archived) +
  `notice_receipts` (notice × user, delivered_at, read_at — the in-app inbox row,
  partitioned if volume demands later; start unpartitioned). RLS: recipients see only
  their receipts; authors principal/IT (+ teacher for own-section notices, flag-gated).
- **Fan-out:** on publish, resolve the audience server-side (staff roster / enrolments /
  guardianships) → bulk-insert receipts → emit `notice.published.v1` into the existing
  `event_outbox`. The SMS stage of `sms-svc` picks it up exactly like absence events
  (template, dedupe, caps, consent, holiday suppression) — **no new SMS pipeline.**
- **API:** `POST/GET /api/v1/ops/notices` (author side, role-gated),
  `GET /api/v1/ops/inbox` (+ unread count), `POST .../inbox/read`.
- **Sync:** add `notice_receipt` to the pull whitelist so the bell works offline-cached.
- **PWA:** notification bell + unread badge in the top bar of *every* role's shell;
  inbox view; notice composer for principal/IT (audience picker: everyone / teachers /
  students / guardians / class → group → section drill-down); notice card on the
  guardian ward view (the card `ward.ts` explicitly notes as "not built").
- **Auto-notices (same machinery, no new UI) — BUILT:** all three go through one
  `app.emit_auto_notice()`, idempotent on a partial unique index over
  `(tenant_id, source_kind, source_ref)`, in the same transaction as the event they
  announce. Exam routine published → students + guardians of the sections with a paper
  in it (`exam_routine`/examId); results published → the same people, **no marks in the
  notice** (`result`/examId); invoices generated → the new `guardians_payers` audience,
  which honours `can_pay_fees` (`invoice`/md5(period)).
- **Tests:** audience-resolution unit tests (the matrix: all/staff/class/section/
  student→their guardians); RLS test that a student never sees a teachers-only notice;
  fan-out idempotency (re-publish doesn't duplicate receipts or SMS).

- **Scheduling:** `scheduled` is a real `notice_status`, not a draft with a date.
  `app.publish_due_notices()` is swept by the **existing** ops/maintenance cron —
  no scheduler, no queue, no new process — with `FOR UPDATE SKIP LOCKED` so two
  overlapping runs cannot double-emit the SMS event. The granularity is the cron's,
  and the composer says so instead of implying a precision it does not have.
- **SMS length:** 180 characters is the default and the recommendation, **not** a
  technical limit. A tenant may set `settings->'sms'->>'noticeMaxChars'` between 70
  (one Bangla segment) and a 480 hard ceiling; the composer shows the live
  per-recipient segment count before publishing. SMS stays a short alert — the full
  notice lives in the app — and every message is signed with the institution's name,
  never the platform's (D11).

**Exit:** principal publishes "শুধু শিক্ষকদের জন্য" notice → every teacher's bell rings,
no student sees it; absence + notice SMS rows queue correctly (send still stubbed until R-8).

**Status: DONE** (2026-08-29). 661 tests, 0 failing; `db/tests/notices.sql` 13/13 and
every other SQL suite executed against a real PostgreSQL 16. See `docs/PHASE_LOG.md`
entries R-2 and R-2-FINAL.

### R-3 — Principal & IT admin portals completed

**Goal:** স্কুল নিজে নিজের সব কাঠামো চালাতে পারে — ডেভেলপার ছাড়া।

- **Principal dashboard (F-1504):** institution overview — students/teachers/sections
  counts, today's attendance %, absent list, pending items (unpublished marks, unassigned
  sections), recent notices. Single aggregate endpoint (one query round-trip, like `ward`).
- **Hierarchy drill-down:** ক্লাস ৯ → [Science/Arts/Commerce] → sections → section page
  (class teacher, subject teachers, roster of 40, attendance summary). Read endpoints
  mostly exist (`sections`, `roster`); add the class/group grouping endpoint + views.
- **Teacher assignment UI:** the §32-style screen — pick year/class/group/section →
  assign class teacher + per-subject teachers (writes `section_subject_teachers` /
  `sections.class_teacher_id`); **replacement flow** = end old row (`ended_on`), insert
  new — never delete; assignment history visible per teacher and per section.
- **User management (IT):** create staff/student/guardian accounts, link guardianships,
  reset via activation codes (F-202 exists), deactivate; student→section assignment +
  roll generation screen (bulk, building on the import wizard).
- **Rollover UI:** surface `rollover_preview()` / `commit_rollover()` — the yearly
  promotion screen with per-student promote/detain/blocker list (SQL is done; this is
  a form + two endpoints).
- **Audit-log writes:** start writing `audit.activity_log` from the mutating endpoints
  touched in this phase (assignment changes, user creation, rollover commit) via one
  `server-core` helper; a minimal audit viewer under the IT menu (F-1603).
- **Tests:** assignment-history invariant (replacement never deletes), role-gate tests
  (teacher cannot open assignment editor), rollover UI end-to-end against the SQL
  functions' existing suites.

**Exit:** a school IT person, alone, can: create a teacher, assign them to Class 9
Science F for the year, replace them mid-year with history intact, promote the whole
school at year end — all from the UI.

**Status: DONE** (2026-08-29), the first phase under D13. Migration **041** gave
subject-teacher assignments a validity period and class teachers a history table, so
replacement closes a row instead of overwriting one; it also created the `it_admin`
role, which the codebase had checked for since R-1 without it existing in the roles
table. 8 API routes and 7 screens, no new Vercel functions and no new UI framework.
All four of D13's "Backend complete — UI pending" capabilities are closed — result
publishing, invoice generation and the notice-SMS cap now have callers, and the
routine-solver discrepancy was investigated and documented rather than changed
(`/rms/generation` reads a produced routine, `/rms/solve` produces one; they are
not duplicates, and `solve` stays API-only rather than gaining a second entry
point). 709 tests, 0 failing; `db/tests/assignment_history.sql` 13/13.

**What R-3 did NOT deliver, and should be scheduled:** creating classes and sections
from the UI (a school opening a seventh section mid-year still needs the pilot
runbook), guardian linking and `can_pay_fees` editing, and the audit VIEWER — the
log is now written and readable, but F-1603's screen is not built. See
`docs/PHASE_LOG.md` R-3 for the full list.

### R-4 — Calendar & schedule surfacing

- **API:** `GET/POST /api/v1/academics/calendar` over the existing `calendar_days`
  (holidays, events, exams, ramadan schedule; IT/principal write, everyone reads).
- **PWA:** month-view calendar (Bangla-first) available to every role; upcoming
  holidays/exams cards on the dashboards; exam routine already renders — link it in.
- Calendar changes emit notices (R-2 machinery) when flagged "notify".
- Attendance/SMS suppression already reads `calendar_days` — now the same data is
  what users see, one source of truth.

**Exit:** each school maintains its own calendar; ছুটি/ইভেন্ট সব পোর্টালে দেখা যায়।

### R-5 — Branded print & document engine *(completes owner priority #1)*

**Goal:** every printed/PDF output carries the institution's identity via the R-1
`branded-doc` foundation. Print-first (browser `window.print()` + print CSS) —
server-side PDF only where a stored artifact is required (receipts already have
`pdf_object_key` waiting).

Documents, in order of daily-habit frequency:
1. **Fee receipt** (print view over existing `payment_receipts`; number, lines, waiver,
   signature, watermark)
2. **Report card / mark sheet** (over `exam_results` — the roadmap's Phase-2 leftover)
3. **Admit card** (exam × student, seat/room from `exam_seats`)
4. **Student ID card** (photo, `student_code`, class/section, validity)
5. **Testimonial / Transfer Certificate** (templated letter over enrolment history)
6. **Section roster / attendance sheet** (blank grid for paper fallback)

- Object storage decision lands here (needed for stored receipt PDFs + student photos):
  S3-compatible bucket, metadata in DB per `01-ARCHITECTURE`.
- **Export:** CSV export endpoints (students, attendance range, marks, dues) — `toCsv()`
  exists; respect RLS + role gates.
- **Tests:** golden-file tests for document HTML (per-tenant branding injected);
  receipt-number uniqueness already DB-enforced.

**Exit:** a guardian pays; the office prints a receipt with the school's logo,
watermark and signature. Term ends; report cards print for a whole section in one go.

### R-6 — Student history & global search

- **API:** `GET /api/v1/academics/students/search` — by `student_code`, name (Bangla
  trigram index exists), phone, roll+section, guardian phone; includes
  `lifecycle_status` filter (alumni included). Staff-gated.
- **Student profile page:** tabs — profile / enrolment history (year→class→section→roll
  timeline from `enrolments`) / attendance summary / results history / fees / documents.
  This is the "STU-… ten years later" requirement made visible.
- Soft-delete stance confirmed: statuses only (`lifecycle_status`), hard delete remains
  a platform-level, PDPA-governed operation.
- **Tests:** search respects tenant isolation; alumni searchable; RLS keeps
  student/guardian out of the search endpoint.

**Exit:** principal types an old ID or a name; the student's full multi-year history
appears in under a second.

### R-7 — Onboarding & platform console

**Goal:** নতুন স্কুল যোগ করা = ঘণ্টার কাজ, দিনের না।

> **Full specification below.** Until R-7 ships, the first pilot institutions are
> onboarded by hand using the same steps in the same order — see
> [PILOT-ONBOARDING-RUNBOOK.md](PILOT-ONBOARDING-RUNBOOK.md). The runbook is the
> manual rehearsal of this wizard; if a step is awkward there, it will be awkward
> here, and that is the point of doing it manually first.

#### R-7.1 Who creates a tenant, and the authorization chain

A tenant is created by the **platform operator** (us), never by a school and never
by a self-service signup form. There is no "create your school" button, and R-7
does not add one.

```text
Signed commercial agreement
        │
        ▼
Platform operator  ──authenticated as──▶  platform role (`super_admin`)
        │                                  + PLATFORM_API_KEY (second factor)
        ▼
platform-svc  ──SECURITY DEFINER──▶  app.create_tenant(...)
        │                             (the runtime role CANNOT do this,
        │                              and cannot even list tenants)
        ▼
audit.platform_access  ← every call, before and after, with the actor
```

Four properties this chain has to keep:

1. **The runtime role cannot create or enumerate tenants.** `shikhon_app` is
   confined by `tenant_self` (`id = app.current_tenant()`), so it can only ever see
   the one tenant it is already inside. Tenant creation therefore needs a
   `SECURITY DEFINER` function with a pinned `search_path`, granted to a platform
   role only — the same shape as `app.public_branding()` in migration 039.
2. **Two credentials, not one.** A platform JWT alone is not enough; the endpoint
   also requires `PLATFORM_API_KEY` from the environment. Creating a tenant is the
   single highest-blast-radius operation in the product, and a leaked session
   token should not be sufficient to perform it.
3. **Every call is audited before it acts.** `audit.platform_access` already
   exists (migration 001) for exactly this. The write goes in the same transaction,
   so an action that rolls back leaves no misleading audit row, and an audit row
   that exists means the action committed.
4. **Nobody inside a school can reach it.** `principal`, `school_owner` and
   `it_admin` are tenant-scoped roles; the platform console is a different service
   with a different role and a different key. A school compromised end to end still
   cannot create, read, or suspend another school.

This also retires the SMS worker's `SMS_WORKER_TENANT_IDS` env-var workaround,
which exists today only because no component could legitimately list tenants.

#### R-7.2 Institution information collected

| Field | Column | Required | Notes |
|---|---|---|---|
| Bangla name | `tenants.name_bn` | ✅ | Primary name everywhere in the UI |
| English name | `tenants.name_en` | ✅ | Printed documents, `en` locale |
| Slug | `tenants.slug` | ✅ | Generated, see R-7.3 |
| Institution type | `tenants.stream` | ✅ | `bangla_medium` · `english_version` · `english_medium` · `madrasah` · `technical` |
| Level | `tenants.level` | ✅ | `primary` · `junior_secondary` · `secondary` · `higher_secondary` · `combined` |
| EIIN | `tenants.eiin` | ○ | 8 chars, **globally unique** — a typo here collides with a real school |
| MPO code | `tenants.mpo_code` | ○ | |
| Board | `tenants.board_code` | ○ | dhaka / rajshahi / madrasah / technical … |
| District, upazila | `tenants.district`, `.upazila` | ○ | |
| Address (Bangla) | `tenants.address_bn` | ○ | Seeds the branding letterhead |
| Weekend days | `tenants.weekend_days` | ✅ | Default `{5,6}` (Fri+Sat); **madrasahs are commonly `{5}`** |
| Shifts | `tenants.shifts` | ✅ | `{single}` default; `{morning,day}` etc. |
| Timezone / locale | `.timezone`, `.default_locale` | ✅ | Defaults `Asia/Dhaka`, `bn` |
| Plan, cap, trial end | `.plan_code`, `.student_cap`, `.trial_ends_on` | ✅ | See R-7.10 |

Institution type is **configuration, not a code path** (D4/D9): it selects
defaults for terminology, the academic template and the weekend, and nothing
branches on it.

#### R-7.3 Tenant id and slug generation

- **Tenant id** — `gen_random_uuid()`, database-assigned, never chosen by a human.
  It is the key the install link carries (`/app?tid=…`) and it is permanent.
- **Slug** — proposed by the wizard from the English name, then confirmed by the
  operator. Must satisfy the existing CHECK: `^[a-z0-9][a-z0-9-]{2,62}$`, and is
  `citext UNIQUE`.
  - Transliterate/lowercase, replace runs of non-alphanumerics with `-`, trim.
  - `Monipur High School` → `monipur-high-school`.
  - On collision, the wizard suggests a district suffix (`monipur-high-dhaka`)
    rather than a number: a school's slug becomes its subdomain (R-7.12), and
    `monipur-high-2` is a URL nobody will print on an admission slip.
  - **The slug is effectively permanent once printed.** Changing it later breaks
    every install link and QR code in circulation. The wizard says so at the point
    of choosing, not in a help page.

#### R-7.4 Branding setup

Reuses the **R-1 branding editor** unchanged (`#/branding`, `PUT /ops/branding`).
The wizard embeds it as a step rather than re-implementing it.

- Migration 039 already seeds `settings->'branding'` from `name_bn`, `name_en` and
  `address_bn`, so a school that skips this step still shows its own name, never
  the platform's.
- Uploading a logo is **optional** at onboarding and can be done later by the
  school's own IT admin — blocking activation on an asset the office has not found
  yet is how onboarding stalls for a week.
- The contrast warning from R-1 applies here too: a brand colour that cannot carry
  white text degrades every primary button at once.

#### R-7.5 Academic setup

One call, already built: `app.provision_tenant(tenant, year_label, year_start,
year_end, min_level, max_level)` (migration 012). It **must run inside the
tenant's own context** — it raises `42501` otherwise, which is the guard that
stops a mis-scoped session provisioning the wrong school.

It seeds, idempotently: academic year (marked current) → terms → **grading scale
and bands** → bell schedule per shift → classes for the level range → subjects and
`class_subjects` from the NCTB catalogue with mark distributions → fee heads →
chart of accounts.

> **The grading scale is not optional.** Without its bands,
> `app.compute_subject_grade` returns NULL and the first result publication of the
> year fails — months after onboarding, with no obvious cause. This is why
> academic setup is a wizard step and not a "you can do this later" link.

Sections are created after this step (the wizard offers "N sections per class",
or they arrive implicitly through the student import, which resolves a section by
name).

#### R-7.6 Teacher import

- CSV, same dry-run → digest → commit contract as students (R-7.7).
- Creates `users` rows (tenant-scoped) + `staff_profiles` with `employee_code`.
- Assigns the `subject_teacher` or `class_teacher` role.
- **Section and subject assignment is R-3's screen**, not the import: a teacher
  exists first, is assigned second, and the assignment is a dated record that can
  be ended and replaced without deleting history (master plan §2).
- A teacher with no phone number can still be imported; they activate by code
  (R-7.9).

#### R-7.7 Student import

Built and tested (F-1601): `POST /api/v1/academics/import`, roles
`principal` · `school_owner` · `academic_coordinator`.

**Contract:** validate → the server returns a `sha256` digest of the parsed rows →
commit re-sends the same file with that digest. A different file on the second
call is refused with `digest_mismatch`. Validation is stateless; there is no
staging table holding student PII between the two calls.

**Required columns** (aliases accepted, Bangla headers included):

| Field | Accepted headers |
|---|---|
| Roll | `roll_no` · `roll` · `রোল` |
| Name (Bangla) | `name_bn` · `name` · `নাম` |
| Class | `class` · `class_level` · `শ্রেণি` |
| Section | `section` · `শাখা` |
| Guardian phone | `guardian_phone` · `phone` · `মোবাইল` |

**Optional:** `name_en`, `gender`, `dob`, `birth_reg_no`, `religion`,
`optional_subject` (fourth subject), `guardian_name`, `relation`.

Partial import is permitted but the skipped count is stated on the button itself
("৭৬৮টি ঠিক সারি আমদানি করুন, ১৬টি বাদ") and recorded in `import_batches` — never
silent truncation.

#### R-7.8 Guardian linking

Guardians are created **from the student import**, not separately:

- `guardian_phone` is the identity. Two students sharing a phone become **one
  guardian with two children** — a `guardianships` row each. That is the common
  case (siblings) and getting it wrong produces duplicate SMS and a parent who
  cannot see one of their children.
- `is_primary` is set on the first link; `receives_sms` and `can_pay_fees` default
  on and are editable later.
- A guardian account is dormant until first login (OTP or activation code); the
  link exists from import.

#### R-7.9 Principal / IT admin creation

The **first account is the one the wizard must create**, because everything else
in the school is created by it.

- The operator supplies the head teacher's name and phone; the wizard creates the
  `users` row and grants `principal`.
- Login on day one is by **activation code**, not OTP: `POST /auth/activate`
  `{action:'issue'}`, issuable by `principal` · `school_owner` ·
  `academic_coordinator` · `class_teacher`. Single-use, 72-hour expiry, revocable,
  and the code itself is never stored — only an HMAC under `ACTIVATION_PEPPER`.
- This is what makes onboarding independent of the SMS aggregator contract (R-8).
  The school itself is the identity authority, face to face, which is the one
  thing a school is genuinely better at than a gateway.
- An `it_admin` account is optional and created the same way; in a small school
  the principal is both.

#### R-7.10 Plan, student cap, trial

| Column | Behaviour |
|---|---|
| `plan_code` | Label only in R-7. No feature gating — `features jsonb` exists for that later. |
| `student_cap` | Checked at **enrolment and import**. Over-cap import is refused with the numbers stated ("cap 500, this file would make 540"), never truncated. |
| `trial_ends_on` | Banner in the app from 14 days out. Expiry does **not** delete or hide data; it moves the tenant to `suspended`. |
| `status` | `trial` → `active` → `suspended` → `archived` |

Billing the schools is **out of scope** for R-7 — invoicing is manual, and a
payments integration for our own subscriptions is a separate decision from the
MFS integration schools use for tuition.

#### R-7.11 Suspension behaviour

Suspension is a commercial state, not a data operation. It must be reversible with
no loss, or it will not be used when it should be.

- **Login is refused** with a specific, non-alarming message naming the office to
  contact — never a generic auth error, which sends teachers to reset passwords
  that are not broken.
- **Data is untouched.** No deletion, no anonymisation, no export restriction.
- **Background work stops**: SMS dispatch and AI calls skip suspended tenants, so a
  suspended school cannot accrue cost.
- **`app.public_branding()` already excludes `archived`** — a school that has left
  stops appearing on any login screen. Suspended tenants still resolve, because
  they are expected to return.
- **Reactivation is a single status change** and needs no re-provisioning.

#### R-7.12 Tenant login URL and future subdomain provisioning

**Today (and after R-7):** the school's door is `/app?tid=<tenant-id>` — printed on
admission slips, sent in the school's own SMS, a QR on the office wall. The device
remembers it; the PWA install bakes it into `start_url`. The wizard's final screen
produces this link, a QR image, and a short Bangla instruction sheet the office can
print.

**Subdomain provisioning (R-7 scope):**

```text
monipur-high-school.shikhonbd.com
        │
        ├── wildcard DNS  *.shikhonbd.com
        ├── wildcard TLS certificate
        └── edge resolves hostname → slug → tenant
              (the slug is already unique; no new identifier)
```

`?tid=` links keep working unchanged — the two resolvers agree because they resolve
to the same tenant, and D12 forbids adding a third mechanism. Custom domains
(`portal.school.edu.bd`) are a later paid option, explicitly **not** an R-7 exit
criterion.

#### R-7.13 Security controls

| Control | Where |
|---|---|
| Tenant creation needs platform role **+** `PLATFORM_API_KEY` | platform-svc |
| `SECURITY DEFINER` with pinned `search_path` | `app.create_tenant`, mirroring migration 039 |
| Runtime role cannot list or create tenants | `tenant_self` policy, unchanged |
| Every platform action audited in the same transaction | `audit.platform_access` |
| Per-tenant PII key generated at creation | `tenants.dek_wrapped`, `blind_index_pepper` |
| Rate limiting on the console | existing `enforceRateLimit`, `service` class |
| Slug/EIIN uniqueness enforced by the database | `citext UNIQUE`, `varchar(8) UNIQUE` |
| Activation codes: HMAC-stored, single-use, 72 h | migration 037 |
| No self-service signup | by design — there is no public create endpoint |

#### R-7.14 Rollback and failure handling

Onboarding is a sequence of steps against a live database, so each step states
what happens when it fails:

| Step | Fails how | Recovery |
|---|---|---|
| Create tenant | Slug/EIIN collision | Wizard suggests an alternative; nothing was written (single transaction) |
| `provision_tenant` | Raises `42501` (wrong context) or partial | **Idempotent** — fix the context and re-run; `ON CONFLICT DO NOTHING` throughout |
| Branding | Validation error | Field-level message; the tenant is already usable unbranded |
| Teacher/student import | Row errors | Dry-run lists them with line numbers; downloadable error CSV; nothing written |
| Import commits wrong file | `digest_mismatch` | Refused before any write |
| Over cap | Refused with counts | Raise the cap or trim the file |
| Principal account | Phone already used in this tenant | Wizard offers to grant the role to the existing user instead of creating a duplicate |
| **Abandoned mid-way** | Tenant exists, half-configured | Set `status='archived'` — it disappears from login screens and can be deleted later under retention policy. **Never hard-delete a tenant with student rows** except through the PDPA erasure path |

A tenant created and abandoned is **not** an error state that needs cleanup
urgency: it is invisible to everyone but the operator.

#### R-7.15 Wizard specification, screen by screen

Nine screens. Each one states its fields, validation, what it depends on, and both
outcomes. The wizard is **resumable** — every step commits, so an operator can
stop after step 4 and finish tomorrow, and a browser crash loses nothing.

---

**Screen 1 — Institution identity**

| | |
|---|---|
| **Fields** | Bangla name*, English name*, institution type*, level*, EIIN, MPO code, board, district, upazila, address |
| **Validation** | Names non-empty, ≤120 chars. EIIN exactly 8 chars and globally unique — checked live, because the collision message must arrive before the operator moves on. Type and level from the enums. |
| **Depends on** | Nothing. First screen. |
| **Success** | Draft held client-side; nothing written yet. → Screen 2 |
| **Error** | Field-level messages. EIIN collision names the conflict as "already registered" **without naming the other school** — that would leak one customer to another. |

---

**Screen 2 — Slug and access**

| | |
|---|---|
| **Fields** | Slug (pre-filled from the English name, editable), weekend days*, shifts*, timezone, locale |
| **Validation** | Slug matches `^[a-z0-9][a-z0-9-]{2,62}$` and is free — live check. Weekend is a subset of 0–6; **the madrasah default is `{5}`, not `{5,6}`**, and the wizard pre-selects by institution type. At least one shift. |
| **Depends on** | Screen 1 (name seeds the slug; type seeds the weekend). |
| **Success** | → Screen 3 |
| **Error** | Taken slug offers a district-suffixed alternative, never a numeric one. A permanent, quiet warning sits under the field: *this becomes the school's web address and cannot be changed once printed.* |

---

**Screen 3 — Plan**

| | |
|---|---|
| **Fields** | `plan_code`, `student_cap`, `trial_ends_on`, initial `status` (`trial` \| `active`) |
| **Validation** | Cap > 0. Trial end in the future if status is `trial`. |
| **Depends on** | Screen 1–2. |
| **Success** | **The tenant row is written here** — one transaction, with the per-tenant PII key and blind-index pepper generated, and an `audit.platform_access` row. Everything after this point is resumable. → Screen 4 |
| **Error** | Any collision missed by the live checks surfaces here as a clean refusal; nothing partial is left. |

---

**Screen 4 — Branding** *(skippable)*

| | |
|---|---|
| **Fields** | The R-1 editor, unchanged: names, short name, logo, favicon, colours, address, phone, email, website, head teacher, signature, watermark |
| **Validation** | R-1's `parseBranding` — hex colours only, raster assets only, per-field byte caps. Contrast warning when white button text would fail AA. |
| **Depends on** | Screen 3 (a tenant must exist to own branding). |
| **Success** | Saved; live preview shows the shell and the printed letterhead. → Screen 5 |
| **Error** | Field-level. **Skipping is a first-class outcome**: migration 039's seed means the school already shows its own name. |

---

**Screen 5 — Academic year and structure**

| | |
|---|---|
| **Fields** | Year label (default: current year), start date*, end date*, lowest class*, highest class*, sections per class |
| **Validation** | End after start. Class range 1–12 and coherent with the level chosen on screen 1 — a `primary` institution asking for class 10 is queried, not silently accepted. |
| **Depends on** | Screen 3. |
| **Success** | Runs `app.provision_tenant()` **inside the tenant's context** and shows its returned table verbatim — *academic_year 1, terms 3, grading_bands 7, period_templates 2, classes 6, class_subject_mappings 54, fee_heads 5*. Seeing the counts is how an operator knows the grading scale exists. → Screen 6 |
| **Error** | `42501` means the session context was wrong — a bug, reported as such, not as user error. The function is idempotent, so retry is always safe. |

---

**Screen 6 — Head teacher account**

| | |
|---|---|
| **Fields** | Name (Bangla)*, name (English), phone (`+8801…`)*, email, role (`principal` default, `school_owner` optional) |
| **Validation** | BD phone format. Unique within this tenant — the same phone may legitimately exist in another school. |
| **Depends on** | Screen 3. |
| **Success** | User created, role granted, **an activation code issued and displayed once** with its 72-hour expiry. → Screen 7 |
| **Error** | Phone already in this tenant → offer to grant the role to the existing user rather than create a duplicate person. |

---

**Screen 7 — Teacher import** *(skippable)*

| | |
|---|---|
| **Fields** | CSV upload |
| **Validation** | Dry-run: required columns, phone format, duplicate employee codes. |
| **Depends on** | Screen 5 (classes must exist). |
| **Success** | Row counts, digest, commit. Section/subject assignment is deferred to R-3's screen and the wizard says so. → Screen 8 |
| **Error** | Per-row errors with line numbers; downloadable error CSV; the school fixes its spreadsheet and re-uploads. Nothing is written until commit. |

---

**Screen 8 — Student import** *(skippable)*

| | |
|---|---|
| **Fields** | CSV upload, target academic year (pre-filled) |
| **Validation** | The F-1601 contract: required columns present, roll unique per section, class/section resolvable, guardian phone valid. **Student cap checked against the whole file, not row by row.** |
| **Depends on** | Screen 5 (classes and sections must exist). |
| **Success** | Preview states imported and skipped counts on the button itself; guardians created and linked, siblings collapsed onto one guardian. → Screen 9 |
| **Error** | Per-row list + error CSV. `digest_mismatch` if a different file is committed. Over-cap refusal states both numbers. |

---

**Screen 9 — Review and activate**

| | |
|---|---|
| **Fields** | Read-only summary: institution, slug, plan, counts (classes, sections, teachers, students, guardians), branding preview, head teacher + activation code. Action: **Activate** (`status` → `active`). |
| **Validation** | Blocks activation only on the two things that break silently later: **no academic year** and **no grading bands**. Everything else (no logo, no students yet) is a warning, not a gate. |
| **Depends on** | All previous. |
| **Success** | Status `active`; produces the **login link** `/app?tid=…`, a QR code, and a printable Bangla instruction sheet for the office. Audited. |
| **Error** | A blocked gate links back to the screen that fixes it. The tenant stays `trial` and is fully usable by the operator meanwhile. |

---

**Tests (R-7):** provisioning end to end (new tenant → activation code → login →
take attendance, timed); suspension actually refuses login and stops SMS/AI;
`student_cap` refuses an over-cap import with both numbers; slug and EIIN
collisions refuse without leaking the other tenant; `provision_tenant` re-run is a
no-op; a tenant created and abandoned is invisible to every other tenant.

**Exit:** operator onboards a brand-new madrasa — different weekend, own branding —
without touching SQL, and the school's head teacher logs in from a printed code.

### R-8 — Go-live unlocks (credentials & production posture)

Everything here is built and dark; this phase is contracts, credentials, and switches —
run it in parallel with R-5…R-7 as vendor agreements land.

- [ ] SMS aggregator contract (SSL Wireless / ADN / Robi) → implement the real provider
      adapter behind the existing interface + DLR webhook; flip `sendStub`.
- [ ] Re-enable login: `OTP_SENDING_ENABLED=true`, `LOGIN_DISABLED=false` (gate already
      satisfied — F-102 rate limiting is live).
- [ ] Set `PII_MASTER_KEY_V1` (read `08-CREDENTIAL-ROTATION.md` §5 first — additive only).
- [ ] Rotate the exposed `neondb_owner` password; revoke the stray MongoDB credential.
- [ ] `DATABASE_MAINTENANCE_URL` in Vercel env → nightly partition/purge cron goes live.
- [ ] Run `migration-status.mjs` against production; apply the tail; **migration 023 is
      what unbreaks student-facing reads** — verify it is in force.
- [ ] MFS merchant credentials → per-provider initiation + signature verification, flip
      `MFS_PAYMENTS_ENABLED`.
- [ ] `ANTHROPIC_API_KEY` (+ per-tenant budget enforcement before enabling broadly).
- [ ] Data-residency decision (Singapore → BD) **before real student PII lands**.
- [ ] Pilot: 3–5 institutions of different shapes (with/without groups, school+college,
      madrasah weekend config) per `05` Phase-1 exit criteria.

### R-9 — Post-roadmap add-ons (only after pilot stability)

Section chat (moderated, section-scoped, teacher present), web push notifications
(cuts SMS cost — the biggest infra line), content authoring workspace (F-403) + NCTB
corpus ingestion (F-1301) to light up grounded AI, photo/voice submissions (F-902),
report trend charts (F-1505), native app wrappers, library/transport/hostel/payroll.

---

## 5. Sequence & effort at a glance

| Phase | What | Relative size | Depends on | Status |
|---|---|---|---|---|
| R-0 | Hygiene | XS | — | **done** |
| R-1 | White-label branding | M | — | **done** (+ R-1-A surfaces) |
| R-2 | Notices + notifications | M–L | R-1 (branded shell) | **done 2026-08-29** |
| R-3 | Principal + IT portals | L | R-2 (dashboard cards) | **done 2026-08-29** |
| R-4 | Calendar UI | S | R-2 (notify hooks) | next |
| R-5 | Branded print engine | M | R-1 | planned |
| R-6 | Search + history | S–M | — | planned |
| R-7 | Onboarding + platform console | M | R-1 | spec written (R-7-DOC) |
| R-8 | Go-live unlocks | external-blocked | any | blocked externally |
| R-9 | Add-ons | — | pilot | — |

Recommended execution order: **R-0 → R-1 → R-2 → R-3 → R-4 → R-5 → R-6 → R-7**, with
R-8 items flipped as credentials arrive. Each phase ends with a commit-tested,
deployable system and an update to `docs/07-IMPLEMENTATION-STATUS.md`.

## 6. What NOT to do (binding, inherited + new)

- No per-school code paths, CSS files, or branches — configuration only (D4).
- **Never state or implement the branding rule as "ShikhonBD must disappear."** It is
  the permanent platform brand (D11). Strip it from a tenant's operational screens;
  leave it on the marketing site, the public docs and the platform console. A
  white-label sweep that reaches `landing.html` is a bug, and the CI guard treats it
  as one.
- Never close a phase without its [PHASE_LOG.md](PHASE_LOG.md) entry, and never edit an
  old entry to match a newer decision — supersede it with a new one (D10).
- No new framework, no rewrite of the PWA shell, no microservices split.
- Never delete assignment/enrolment/attendance history — end-date and supersede.
- Never trust frontend visibility as security — RLS is the enforcement layer.
- No social/chat features before R-9.
- No Elasticsearch/Redis/queues until Postgres measurably fails at the job.
- Don't edit `api/v1/*.js` or `netlify/functions/*` bundles — sources live in `services/`.
- Don't touch `PII_MASTER_KEY_V1` rotation without `08` §5.
