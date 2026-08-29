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
এবং টেস্টেড (২২৩+ টেস্ট)। **নতুন করে ভিত্তি বানানোর দরকার নেই।**

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

**Current state — unresolved.** `/` serves `apps/pwa/public/index.html`, which is
the Ata Ekta design mock-up, not the functional application; the real PWA is
`index.legacy.html` and is linked from nowhere. Investigated and documented in
[PHASE_LOG.md](PHASE_LOG.md) under `R-1-A`. Resolving it is a prerequisite for
the pilot (R-8) and is the one open item this plan does not yet assign to a phase.

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
| ক্লাস → গ্রুপ → সেকশন → ছাত্র ড্রিল-ডাউন (প্রধান শিক্ষক) | Data model exists; **UI missing** | R-3 |
| সেকশনে শিক্ষক অ্যাসাইন / বছরে বছরে নতুন অ্যাসাইন | Model + rollover exist; **UI missing** | R-3 |
| শিক্ষক চলে গেলে রিপ্লেসমেন্ট, হিস্টরি অক্ষত | Model supports; **UI missing** | R-3 |
| আইটি প্রোফাইল — পুরো স্কুল ম্যানেজ করবে | Partial (import, roles-view) | R-3 |
| এক সার্ভার থেকে প্রতিটি স্কুল সম্পূর্ণ আলাদা — লগইন, ডেটা, রুলস, লোকজন | **Exists** (tenant-scoped identity + 4-layer isolation, per-tenant crypto keys) — mechanism written up in **§1b** | R-7 adds per-school subdomains |
| ছাত্রের আপডেট গার্ডিয়ান+শিক্ষক+প্রধান শিক্ষক সবাই দেখবে (sync) | **Exists** (one DB + RLS + sync pull) | — |
| গার্ডিয়ান শুধু নিজের সন্তান দেখবে | **Exists** (RLS `guardianships` scoping) | — |
| ছাত্র শুধু নিজেরটা দেখবে | **Exists** (RLS self-scoping) | — |
| নোটিশ বোর্ড + টার্গেটেড নোটিশ (শিক্ষক/ছাত্র/গার্ডিয়ান আলাদা) | **Missing** | **R-2** |
| নোটিফিকেশন বেল — সবার ড্যাশবোর্ডে পৌঁছাবে | **Missing** | **R-2** |
| গার্ডিয়ানের ফোনে সরাসরি SMS | Pipeline built, provider stubbed | R-2 (wire-up) + R-8 (credentials) |
| এক্সাম রুটিন আপডেট | **Exists** | — (R-2 adds its notifications) |
| ক্যালেন্ডার — ছুটি/ইভেন্ট, স্কুল-অনুযায়ী | Table exists; **API+UI missing** | R-4 |
| অফলাইনেও অ্যাটেনডেন্স, নেট এলে সিংক | **Exists** | — |
| ১০ বছর পরে আইডি দিয়ে ছাত্র খুঁজে পাওয়া | Modeled + indexed; **endpoint+UI missing** | R-6 |
| প্রতি বছর সহজে নতুন অ্যাসাইন (promotion) | **Exists** (rollover preview/commit) | R-3 surfaces it in UI |
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
- **Auto-notices (same machinery, no new UI):** exam routine published → students+
  guardians of affected sections; results published → same; invoice generated → guardians
  with `can_pay_fees`. These are 3 small emitters at existing publish points.
- **Tests:** audience-resolution unit tests (the matrix: all/staff/class/section/
  student→their guardians); RLS test that a student never sees a teachers-only notice;
  fan-out idempotency (re-publish doesn't duplicate receipts or SMS).

**Exit:** principal publishes "শুধু শিক্ষকদের জন্য" notice → every teacher's bell rings,
no student sees it; absence + notice SMS rows queue correctly (send still stubbed until R-8).

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

- **Platform service (new, small):** `platform-svc` — the SaaS operator's surface.
  Uses a `SECURITY DEFINER` tenant-enumeration function (the runtime role deliberately
  cannot list tenants; the SMS worker's env-var workaround gets retired here).
  Endpoints: create/suspend/activate tenant, list tenants with usage (students, SMS
  spend from `sms_outbox.cost_bdt`, AI tokens), manage `plan_code`/`student_cap`/
  `trial_ends_on`. Gated by a platform role + service key; every access audited
  (`audit.platform_access` exists).
- **Per-tenant subdomains (D12, §1b):** `monipur.shikhonbd.com` — tenant resolved
  from the hostname (the slug already exists and is unique), wildcard DNS + cert at
  the edge, `?tid=` links unchanged and still honoured. Custom domains
  (`portal.school.edu.bd`) become a paid option later, not part of this phase's
  exit criteria.
- **Setup wizard UI** over `app.provision_tenant()`: institution type
  (school/college/madrasa — maps to existing `stream`/`level`/`weekend_days`), branding
  (R-1 editor reused), academic year, classes/groups/sections, then straight into the
  existing teacher/student CSV import wizard. The §68 flow of the PRD, on top of SQL
  that already exists.
- **Plan enforcement (light):** `student_cap` checked at import/enrolment; `status=
  suspended` blocks login with a clear message; `trial_ends_on` banner. Billing/invoicing
  the schools themselves = out of scope (manual for now).
- **Tests:** provisioning end-to-end (new tenant → login → take attendance in <1 hour of
  wall-clock steps); suspension actually locks out; cap enforcement.

**Exit:** operator onboards a brand-new madrasa — different weekend, own branding —
without touching SQL.

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

| Phase | What | Relative size | Depends on |
|---|---|---|---|
| R-0 | Hygiene | XS | — |
| R-1 | White-label branding | M | — |
| R-2 | Notices + notifications | M–L | R-1 (branded shell) |
| R-3 | Principal + IT portals | L | R-2 (dashboard cards) |
| R-4 | Calendar UI | S | R-2 (notify hooks) |
| R-5 | Branded print engine | M | R-1 |
| R-6 | Search + history | S–M | — |
| R-7 | Onboarding + platform console | M | R-1 |
| R-8 | Go-live unlocks | external-blocked | any |
| R-9 | Add-ons | — | pilot |

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
