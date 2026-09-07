# UI/UX integration plan — Ata Ekta into the functional `/app`

> **Currency (D17).** This document opened as a plan and is now part plan,
> part delivery record. **P0–P4 are delivered** (§21–§24 below); **P5–P8 are
> not started**. The authoritative status board for every phase is
> [11-MASTER-PLAN.md §5a](11-MASTER-PLAN.md); what is *not* built is
> [BACKLOG.md](BACKLOG.md). Last reconciled 2026-09-02, after P8. The
> "PLAN ONLY" line immediately below was true on the day it was written and is
> kept for that reason — it is not true of the document today.

**Status: PLAN ONLY. No application code has been changed, no screen redesigned,
`/design` untouched, routing/API/schema unchanged.**

**Decision recorded (2026-09-01):** *Ata Ekta is the canonical visual direction
for the functional `/app`. `/design` remains a visual reference and prototype;
it is **not** the production application and will not become it by promotion.*

This document is the implementation-ready roadmap for that decision. It follows
the UI/UX audit entry of 2026-09-01 in [PHASE_LOG.md](PHASE_LOG.md), which
established that three generations of interface exist here and that Decision D7
("new surfaces follow the Ata Ekta design system") was never implemented in
`/app`.

---

## 0. The one-paragraph summary

`/app` is functionally right and visually a generation behind; `/design` is
visually right and functionally empty. The work is to move the **visual system**
(tokens, layout, component vocabulary) from `/design` into `/app` **without
moving any of its data, and without losing** `/app`'s dark mode, its UX states,
its offline model or a single working feature. The surprise in the audit's
favour: **radius, shadow, spacing and touch-target tokens already match the Ata
Ekta values exactly.** Only **colour** and the **type scale** genuinely diverge.
That makes this a large but bounded change, not a rewrite.

---

## 1. Design system audit

### 1.1 What already matches — do NOT touch

Verified by direct comparison of `app.css` against `design/tokens/*.css`:

| Token family | `/app` | `/design` | Verdict |
|---|---|---|---|
| `--radius-sm/md/lg/pill` | 8 / 12 / 16 / 999px | 8 / 12 / 16 / 999px | **identical** |
| `--tap-min` | 48px | 48px | **identical** |
| `--shadow-sm` | `0 1px 2px rgba(15,23,42,.04)` | same | **identical** |
| `--shadow-md` | `0 4px 16px rgba(15,23,42,.07)` | same | **identical** |
| `--shadow-lg` | `0 16px 40px rgba(15,23,42,.10)` | same | **identical** |
| `--space-1..4, 6, 8` | 4/8/12/16/24/32 | same | **identical** |
| Font families | Hind Siliguri + Inter | same | **identical** |

This is the single most important finding for scoping: the geometry and rhythm
of the two systems are already the same system. `app.css` also keeps
`--s-1..6` aliases onto `--space-*`, which stay as-is.

### 1.2 What genuinely diverges

**Colour — the whole palette.** Same variable names, different values, zero
overlap:

| Token | `/app` (Gen-2) | `/design` (Ata Ekta) | Note |
|---|---|---|---|
| `--color-primary` | `#e53935` | `#D23B2E` | design deepened it: `#e53935` is 3.9:1 on white, **fails WCAG AA** |
| `--color-primary-hover` | `#dc2626` | `#B32E22` | |
| `--color-primary-soft` | `#fee2e2` | `#F9E4E0` | |
| `--color-surface` | `#f9fafb` (cool grey) | `#F1EFE6` (**Muslin**, warm) | the largest visual change |
| `--color-bg` | `#ffffff` | `#FFFFFF` | matches |
| `--color-success` | `#22c55e` | `#557C52` | |
| `--color-warning` | `#f59e0b` | `#B08427` | |
| `--color-danger` | `#dc2626` | `#B3392C` | |
| `--color-info` | `#3b82f6` | `#4E7A94` (Chambray) | |
| `--color-accent-2` | `#8b5cf6` (purple) | `#A76A47` (Terracotta) | |
| `--color-text` | `#1f2937` | `#53443D` (Clove) | |
| `--color-border` | grey ladder | `#E2DACB` | |

**Missing in `/app`:** `--space-5` (20), `--space-10` (40), `--space-12` (48),
`--color-surface-muted`, `--color-border-strong`, `--color-text-faint`,
`--color-text-on-primary`, `--color-*-ink` triplets, `--font-bn-num`,
`--transition-fast/base`.

**Type scale — two different models.** `/app` uses a px ladder
(`--text-3xs` 11 → `--text-4xl` 32). `/design` uses a **semantic** scale with
weight and line-height bundled (`--text-h1-size/weight/line`, h2, h3, body,
small, caption). These must be reconciled, not merged blindly.

**`--font-bn-num`** is a real design insight `/app` lacks: Noto Sans Bengali for
**numerals only**, because Hind Siliguri's Bangla digits are ambiguous with
Latin `I`/`l` at table-row sizes — "exactly the wrong ambiguity for a ledger
balance or a mark". This should be adopted.

### 1.3 Canonical patterns from `/design`

These become the reference vocabulary:

| Area | Canonical source | Class vocabulary |
|---|---|---|
| Desktop shell | `s-desktop` / `s-*-desktop` | `.d-shell` `.d-sidebar` `.d-nav-scroll` `.d-nav-group-label` `.dnav` `.d-sidebar-profile*` `.d-main` `.d-topbar` `.d-title` `.d-sub` `.d-actions` `.d-iconbtn` `.d-avatar` `.d-brand` |
| Desktop stats | `dpage-dashboard` | `.d-stats` `.d-stat` `.d-stat-num` `.d-stat-lbl` |
| Desktop tables | `dpage-students` etc. | `.dtable` |
| Mobile shell | `s-*` (phone frames) | `.phone` `.phone-body` `.bottomnav` `.tab` |
| Colour/type/space | `design/tokens/*.css` | as above |

### 1.4 Token migration plan

**Rule: one token system. No duplicate families at the end of the migration.**

| Step | Action | Risk |
|---|---|---|
| T1 | Add the missing scalars to `app.css`: `--space-5/10/12`, `--transition-fast/base`, `--font-bn-num` | none — additive |
| T2 | Replace the **light** `--color-*` values in `app.css` with the Ata Ekta values verbatim | **high visual blast radius**, but ~30 selectors reference them directly; everything else inherits |
| T3 | Introduce the semantic type tokens (`--text-h1-*`…`--text-caption-*`) **alongside** the px ladder; map the ladder onto them (`--text-3xl: var(--text-h1-size)` etc.) | low |
| T4 | Re-point the 373 `--c-*` selectors family-by-family (see §2), *not* file-wide | medium — do per component group |
| T5 | Author a **dark** Ata Ekta palette (see §8) — `/design` has none | medium — new design work |
| T6 | Delete `--c-*` only when its usage count reaches zero | none if T4 is complete |

**Do not** `@import` `/design/styles.css` into `app.css`. The tokens should be
**copied into `app.css`** with attribution comments. Reason: `/design` is a
prototype that may be edited freely; the production app must not inherit a
prototype's edits, and `app.css` must stay a single cacheable file (§11).

---

## 2. Three-generation cleanup plan

Classification of every component group currently in `app.css` / `apps/pwa/src`.
**Nothing is deleted in this plan.** `REMOVE AFTER MIGRATION` means "delete only
once its replacement is live and its usage count is zero".

| Group | Gen | Action | Notes |
|---|---|---|---|
| `--c-*` colour family (373 selectors) | 1 | **REMOVE AFTER MIGRATION** | re-point per group in T4, delete last |
| `--color-*` values (Gen-2, `#e53935`) | 2 | **REPLACE** | swap values to Ata Ekta; names survive |
| `--radius-*`, `--shadow-*`, `--space-*`, `--tap-min` | 1/3 | **KEEP** | already identical |
| `--s-1..6` aliases | 1 | **KEEP** | harmless indirection, widely used |
| px type ladder `--text-*` | 1 | **ADAPT** | map onto semantic scale, keep names |
| `Shell` class (`shell.ts`) | 1 | **ADAPT** | gains a desktop mode; mobile path stays |
| `.shell-topbar` / `.shell-tabbar` / `.shell-tab` | 1 | **ADAPT** | becomes the *mobile* shell only |
| `view-states.ts` (skeleton/empty/error/success/confirm) | 1 | **KEEP + RESTYLE** | 15 views depend on it; the API stays, the CSS changes |
| `icon.ts` (`iconSvg`) | 1 | **KEEP** | inline SVG, no icon-font budget — better than `/design`'s CDN lucide |
| `.btn-primary/.btn-secondary/.btn-success` | 2 | **ADAPT** | already on `--color-*`; values change under them |
| `.card` | 2 | **ADAPT** | same |
| `.hero`, `.home-card`, `.home-*` | 2 | **ADAPT** | dashboard cards; desktop gets `.d-stat` alongside |
| `.login-*` | 2 | **ADAPT** | needs the desktop split-screen from `s-login-desktop` |
| `.notice-*` | 2 | **ADAPT** | |
| `.brand-*` (branding editor) | 2 | **KEEP** | already the only screen with a desktop breakpoint |
| Every other screen's CSS (~340 selectors) | 1 | **REPLACE** | per-screen, in the order of §15 |
| `design/components/*.jsx` | 3 | **DO NOT USE** | React is not a dependency (D1); reference only |
| `design/tokens/*.css` | 3 | **KEEP AS REFERENCE** | source of truth for values; copied, not imported |
| `design.html` | 3 | **KEEP** | remains `/design`, the prototype |

---

## 3. Final app shell

Today there is **one** shell (`shell.ts`: `.shell-topbar` + `.shell-tabbar`)
used at every width. The final product has **two modes of one shell** — chosen
by breakpoint, sharing one route table, one role model, one mount lifecycle.

### 3.1 Desktop shell (≥1024px)

Vocabulary from `/design`'s `s-desktop`:

```
.d-shell  (flex, 100dvh)
├── .d-sidebar            240px fixed, own scroll
│   ├── .d-brand          tenant logo + name        ← D11: tenant identity
│   ├── .d-nav-scroll
│   │   ├── .d-nav-group-label   "প্রশাসন" grouping
│   │   └── .dnav[.active]       one per route, icon + label
│   └── .d-sidebar-profile       avatar, name, role, logout
└── .d-main   (flex:1, overflow-y:auto)
    ├── .d-topbar         .d-title + .d-sub | .d-actions (bell, profile, page actions)
    └── page content      max-width 1200px, centred
```

- **Sidebar**: persistent, never collapses ≥1280px; collapsible to icons-only
  1024–1279px. Groups follow the role's nav (§3.3).
- **Header**: page title + subtitle from the existing route registry
  (`titleBn` / `subtitleBn` already exist in `app.ts` — no new data needed).
- **Breadcrumbs**: only where hierarchy is real (Academic → Class → Section →
  Student; Documents → type). Elsewhere the title is enough; a one-level
  breadcrumb is noise.
- **Contextual actions**: right side of `.d-topbar`, max 2 primary + overflow.
- **Notification bell**: moves from the mobile top bar into `.d-actions`, same
  `bell.onOpen` callback — no new API.

### 3.2 Mobile shell (<1024px)

Keeps today's structure, restyled:

- **Top bar** (`.shell-topbar`): tenant logo + name, bell, role chip, logout.
- **Bottom navigation** (`.shell-tabbar`): **max 5** items — 4 role routes +
  আরও (More). This is already the rule in `shell.ts` (`hidden?: boolean`).
- **Page title/actions**: in-page header, not a second bar — vertical space is
  the scarce resource on a 360px phone.
- **Drawers / bottom sheets**: for filters, role switching, and any picker with
  >6 options. New component (§7), replacing full-page navigations where the
  task is a choice, not a destination.
- **Overflow**: আরও (More) is a full page listing every hidden route — already
  implemented (`more-view.ts`), restyled only.

### 3.3 Navigation per role — from the **existing** permission model

Taken verbatim from `dashboardFor(role)` in `app.ts`. **No new permissions are
assumed or invented.**

| Role | Bottom tabs (mobile, ≤5) | Sidebar (desktop, grouped) |
|---|---|---|
| **Principal** / `school_owner` | হোম · প্রতিষ্ঠান · একাডেমিক · শিক্ষার্থী · আরও | **শিক্ষা**: প্রতিষ্ঠান, একাডেমিক, ফলাফল প্রকাশ, শিক্ষাপঞ্জি · **মানুষ**: শিক্ষার্থী · **নথি**: নথি ও ছাপা · **প্রশাসন**: কার্যবিবরণী |
| **IT Admin** | হোম · একাডেমিক · ব্যবহারকারী · শিক্ষার্থী · আরও | **কাঠামো**: একাডেমিক, প্রতিষ্ঠান · **মানুষ**: ব্যবহারকারী, শিক্ষার্থী · **প্রশাসন**: সেটিংস, পরিচয়, কার্যবিবরণী |
| **Teacher** (default) | হোম · হাজিরা · রুটিন · শিক্ষার্থী · আরও | **আজ**: হাজিরা, রুটিন · **শ্রেণি**: রোস্টার, নম্বর, উত্তরপত্র, বাড়ির কাজ · **সহায়ক**: SikhokAI, বদলি শিক্ষক |
| **Student** | হোম · পড়াশোনা · রুটিন · ফলাফল · আরও | **পড়াশোনা**: বিষয়, অধ্যায়, বাড়ির কাজ, শিখো টিউটর · **আমার**: হাজিরা, ফলাফল, ফি, নথি |
| **Guardian** | হোম · সন্তান · ফলাফল · নোটিশ · আরও | **সন্তান**: হাজিরা, ফলাফল, ফি · **স্কুল**: নোটিশ, শিক্ষাপঞ্জি, নথি |
| `accountant` | হোম · ফি · লেজার · শিক্ষার্থী · আরও | **অর্থ**: ফি, লেজার, ইনভয়েস · **মানুষ**: শিক্ষার্থী |
| `academic_coordinator` | হোম · একাডেমিক · রুটিন · শিক্ষার্থী · আরও | as principal minus finance/audit |

Guardian multi-child switching stays in `guardian-panel.ts` — on desktop it
becomes a sidebar sub-list; on mobile, a bottom sheet.

---

## 4. Screen-by-screen migration matrix

`Gen` = current generation. `Ref` = `/design` screen that exists as reference.
`Risk`: **L**ow / **M**edium / **H**igh.

| # | Screen | `/app` today | `/design` ref | Desktop needed | Mobile needed | Data / API | Reuse | To create | Risk |
|---|---|---|---|---|---|---|---|---|---|
| 1 | **Login** | `login-view.ts` (485 ln), Gen-2 | `s-login` + `s-login-desktop` ✅ | split-screen: brand panel + form | single card, keyboard-safe | `identity-svc` OTP + activation | tokens, Card, FormField | AuthLayout | **M** — activation door + cooldown must survive |
| 2 | **Principal dashboard** | `principal-view.ts` (385), Gen-1 | `dpage-dashboard` (desktop only) | `.d-stats` row + attention lists | stat cards stacked | `ops/dashboard` | StatCard, Card | mobile design | M |
| 3 | **IT Admin dashboard** | `home-view.ts` cards, Gen-2 | `dpage-settings` partial | admin landing + quick actions | card grid | `ops/dashboard` | StatCard | both | M |
| 4 | **Teacher dashboard** | `home-view.ts`, Gen-2 | `s-teacher-home` + desktop ✅ | greeting + today + shortcuts | hero + card grid | local + `ops/dashboard` | hero, home-card | — | **L** |
| 5 | **Student dashboard** | `home-view.ts`, Gen-1/2 | `s-student-home` + desktop ✅ | today + due work | compact cards | `academics/*` | home-card | — | L |
| 6 | **Guardian dashboard** | `guardian-view.ts` (397), Gen-1 | `s-guardian` + desktop ✅ | child switcher + 3 panels | ward card + tabs | `academics/ward` | Timeline, meters | child switcher (sheet) | M |
| 7 | **Academic hierarchy** | `academic-view.ts` (1008), Gen-1 | `dpage-academic` (desktop only) | tree + detail split | drill-down list | 8 endpoints | DataTable, Tabs | **mobile design**, Breadcrumb | **H** — largest view |
| 8 | **Attendance** | `attendance-view.ts` (334), Gen-1 | `s-attendance` + desktop ✅ | roster table, keyboard entry | tap grid, sticky save | **offline outbox** | roster rows | — | **H** — offline path must not regress |
| 9 | **Students** | `students-view.ts` (725), Gen-1 | `s-students` + desktop ✅ | DataTable + filters | MobileList + search | `academics/search` | SearchBar | FilterBar | M |
| 10 | **Student history** | in `students-view` | ❌ none | timeline + year tabs | vertical timeline | `academics/studenthistory` | Timeline | **both** | M |
| 11 | **Teachers** | `users-view.ts` (472), Gen-1 | `dpage-teachers` (desktop) | DataTable + assign | list + sheet | `ops/users` | DataTable | mobile design | M |
| 12 | **Notices** | `inbox-view` + `notice-compose-view` (646), Gen-2 | ❌ none | list + composer split | list + full-screen composer | `ops/notices` | Card, FormField | **both** — incl. the ≥200 send gate | **H** — irreversible action |
| 13 | **Notifications** | `notifications-view.ts` (262), Gen-1 | ❌ none | dropdown panel from bell | full page | `ops/inbox`, push | EmptyState | **both** | M |
| 14 | **Calendar** | `calendar-view.ts` (879), Gen-1 | ❌ none | month grid + side detail | agenda list + sheet | `ops/calendar` | — | **both**, CalendarCell | **H** — dense, weekend rules |
| 15 | **Results** | `results-view` + `publish-view` | `s-results` + desktop ✅ | marks table + publish gate | card list | `academics/results` | meters, GPA trend | publish confirm | M |
| 16 | **Finance** | `fees-view`, `invoice-view`, `ledger-view` | `s-finance-home`, `s-ledger` + desktops ✅ | ledger table + chart | txn list | `finance/*` | chart, txn rows | — | M |
| 17 | **Documents** | `documents-view.ts` (640), Gen-1 | ❌ none | type grid + preview | list + preview sheet | `ops/document` (6 calls) | — | **both**, DocumentPreview | M |
| 18 | **Settings** | `admin-settings-view.ts` (334), Gen-1 | `dpage-settings` partial | two-column form | sectioned form | `ops/settings` | FormField | mobile design | M |
| 19 | **Branding** | `branding-view.ts` (672), Gen-2 | ❌ none | **already 2-col at 900px** | stacked + preview | `ops/branding` | FileUpload | mobile design | M |
| 20 | **User management** | `users-view.ts`, Gen-1 | ❌ none | DataTable + role editor | list + sheet | `ops/users` | DataTable | **both** | M |
| 21 | **Onboarding** | `platform.ts` wizard (9 screens) | ❌ none | stepper + form | full-screen steps | `platform-svc` | Stepper | **both** | M |
| 22 | **Platform console** | `platform.ts` + `platform.css` (4 KB) | ❌ none | own shell, **platform-branded** | responsive | `platform-svc` | — | **both** | M — **D11: stays shikhonBD** |
| 23 | Publish workflow | `publish-view.ts` (263) | partial in `s-results` | verify → publish | steps | `academics/publish` | ConfirmationDialog | desktop | M |
| 24 | Invoice workflow | `invoice-view.ts` (237) | `s-finance-home` partial | generate + preview | steps | `finance/*` | — | both | M |
| 25 | Rollover | `rollover-view.ts` (462) | ❌ none | preview + commit | steps | `ops/rollover` | ConfirmationDialog | **both** | **H** — touches every student |
| 26 | Audit viewer | `audit-view.ts` (396) | ❌ none | DataTable + filters | list | `ops/audit` | DataTable, FilterBar | **both** | L |
| 27 | Import | `import-view.ts` (378) | `s-import` + desktop ✅ | dropzone + error table | steps + error list | `platform/import` | FileUpload | — | M |
| 28 | Routine / editor | `routine-view`, `routine-editor-view` | `s-routine-editor` + desktop ✅ | grid editor | day list | `rms-svc` | grid | — | M |
| 28a | Routine — screen grid | `timetable-view.ts` | ✅ | grid + print drawer | day list | `rms/timetable` | grid, drawer | — | M |
| 28b | Routine — PRINTED sheet | `documents.ts` `buildRoutineSheet` | n/a — paper | A4 landscape grid | A4 portrait | `ops/document?type=routine_sheet` | letterhead, chips, tints | — | M |
| 29 | Marks entry | `marks-view.ts` (469) | `s-marks` (**no desktop pair**) | **desktop design needed** | keypad grid | offline outbox | — | desktop design | **H** — offline |
| 30 | Class performance | `class-perf-view.ts` | `s-class-perf` + desktop ✅ | charts | compact charts | `academics/classperf` | chart | — | L |
| 31 | Learn / Practice / Shikho / Sikhok | 4 views | all 4 have pairs ✅ | as design | as design | `ai-svc` | chat | — | L |
| 32 | System status | `system-view.ts` | `s-system` + desktop ✅ | status table | list | probes | StatusBadge | — | L |
| 33 | Roles reference | `roles-view.ts` (99) | `s-roles` + desktop ✅ | table | list | static | DataTable | — | L |

**Every row inherits the same non-negotiables** (§14, D13): loading, empty,
error, success, permission-denied and offline states; tenant branding; the
existing API; the existing permission model.

---

## 5. `/design` is a visual reference only

**Binding rule for every screen above.** No prototype data may reach production.

- ❌ Never copy the hardcoded arrays out of `design.html`.
- ❌ Never copy its single `fetch` pattern.
- ✅ Copy: layout structure, class vocabulary, spacing rhythm, colour usage,
  component composition, the desktop/mobile split.
- ✅ Data continues to come from: the existing REST API, the existing RLS/tenant
  context, the existing offline outbox, the existing notification and document
  models.

A migrated screen is done when it **looks like** `/design` and **behaves like**
today's `/app` — never the reverse.

---

## 6. Screens `/design` never covered

Twelve screen families need **new** design work in the Ata Ekta language before
implementation. They are not ports.

| Screen | Why it is new | Design deliverable |
|---|---|---|
| Student history | multi-year record, no analogue | Timeline + year tabs, desktop & mobile |
| Notices (compose) | the ≥200-recipient confirmation gate is safety-critical | composer + audience preview + gate, both widths |
| Notifications | bell panel vs full page | dropdown (desktop), page (mobile) |
| Calendar | densest screen; weekend/holiday rules | month grid + agenda, CalendarCell states |
| Documents | 6 document types, print preview | type grid + preview, both widths |
| User management | role assignment + activation codes | table + role editor sheet |
| Onboarding wizard | 9 steps, operator-facing | stepper, both widths |
| Platform console | **platform-branded**, not tenant | own shell in Ata Ekta, shikhonBD brand |
| Publish workflow | irreversible; needs a gate | verify → confirm |
| Invoice workflow | generation + preview | steps + preview |
| Rollover | touches every student; irreversible | preview → confirm → result |
| Audit viewer | long filterable log | DataTable + FilterBar |

**Rule:** design each against the token set and the shell defined here, not
against `design.html`'s existing screens, so they do not inherit prototype
habits (no states, no real data).

---

## 7. Component architecture

Framework-free TypeScript, matching the existing idiom (`view-states.ts`,
`icon.ts`). **No React, no build-step components** (D1, §11).

`✅ exists` = already in the repo; do not duplicate.

| Component | Status | Desktop | Mobile | A11y | Variants |
|---|---|---|---|---|---|
| `AppShell` | ADAPT `shell.ts` | `.d-shell` sidebar + main | topbar + bottomnav | landmark roles, skip-link | desktop / mobile |
| `Sidebar` | **new** | 240px, groups, collapsible <1280 | n/a | `nav`, `aria-current` | full / icons-only |
| `MobileNav` | ADAPT `.shell-tabbar` | n/a | ≤5 tabs, 48px targets | `aria-current` | 4+More |
| `TopBar` | ADAPT `.shell-topbar` | `.d-topbar` actions | logo, bell, role | — | — |
| `PageHeader` | **new** | title + sub + actions | title + overflow | `h1` | with/without actions |
| `Breadcrumb` | **new** | hierarchy only | collapsed to "back" | `nav[aria-label]` | — |
| `Card` | ✅ `.card` — restyle | padded surface | full-bleed edges | — | plain / interactive / stat |
| `StatCard` | **new** | `.d-stat` in `.d-stats` grid | 2-up compact | number + label assoc. | trend up/down/flat |
| `DataTable` | **new** | `.dtable`, sortable, sticky head | **transforms to MobileList** | `th[scope]`, caption | selectable / plain |
| `MobileList` | **new** | n/a | row = card, chevron | list semantics | 1/2/3-line |
| `Drawer` | **new** | right panel | n/a | focus trap, Esc | sm/md/lg |
| `BottomSheet` | **new** | n/a | drag handle, snap | focus trap, Esc | filters/pickers |
| `Modal` | ADAPT `confirmDialog` ✅ | centred | full-screen | focus trap, labelled | — |
| `ConfirmationDialog` | ✅ `confirmDialog` | — | — | — | **destructive variant** |
| `Tabs` | **new** | underline | scrollable chips | `role=tablist` | — |
| `FilterBar` | **new** | inline row | opens BottomSheet | labelled controls | — |
| `SearchBar` | ADAPT | inline | full-width sticky | `role=search` | with/without filters |
| `StatusBadge` | ADAPT `.badge` | pill | pill | not colour-alone (+icon/text) | success/warn/danger/info/neutral |
| `EmptyState` | ✅ `emptyState` — restyle | centred + action | compact | heading + action | with/without CTA |
| `ErrorState` | ✅ `errorState` — restyle | centred + retry | compact | `role=alert` | retry / fatal |
| `LoadingSkeleton` | ✅ `skeleton` — restyle | shaped | shaped | `aria-busy` | text/card/table/list |
| `Toast` | ADAPT `successNote` | bottom-right | above bottom nav | `role=status` | success/error/info |
| `FormField` | **new** | label + input + hint + error | 48px min | label `for`, `aria-describedby` | text/select/textarea/date |
| `FileUpload` | ADAPT branding/import | dropzone | tap + camera | keyboard reachable | single/multi/image |
| `Timeline` | **new** | vertical, dated | condensed | ordered list | — |
| `CalendarCell` | **new** | month grid cell | agenda row | date + state in name | holiday/exam/event/weekend |
| `DocumentPreview` | **new** | side preview | full sheet | — | receipt/report/admit/ID |
| `Icon` | ✅ `iconSvg` | inline SVG | inline SVG | `aria-hidden` + text | — |

**`DataTable` → `MobileList` is the single most important transform** and the
main defence against the "stretched desktop table" failure the brief forbids.

---

## 8. Dark mode — recommendation: **C (keep, as an explicit user preference)**

Not an aesthetic call. The evidence:

| Consideration | Finding |
|---|---|
| Existing behaviour | `/app` ships a **122-line** dark palette under `:root[data-theme='dark']` (F-1607), applied before first paint from `localStorage`/OS |
| `/design` | has **no** dark handling at all — 0 rules |
| Accessibility | dark mode is an accessibility feature for light-sensitivity and low-light use; a Bangladeshi teacher marking attendance at 6am in a dim staffroom is a real case |
| Tenant branding | tenant colour must stay legible on **both** grounds; `branding-view` already warns on poor contrast — that check must extend to dark |
| Maintenance | one extra palette block, ~120 lines. The component CSS is token-driven, so components cost nothing extra |
| Consistency | already consistent across mobile/desktop because it is token-level |

**Removing it would be a regression of shipped, tested behaviour** with no
benefit beyond matching a prototype that simply never addressed the question.

**Therefore:** keep dark mode, and author a **dark Ata Ekta palette** as part of
T5 — Muslin inverts to a warm dark ground (not pure black), primary lightens to
hold ≥4.5:1 on that ground. Toggle stays explicit (`data-theme`), defaulting to
OS preference. `/design` may remain light-only; it is a reference, not the
product.

---

## 9. Accessibility

Must **preserve or improve** — never trade for polish:

- **Contrast**: adopting Ata Ekta is itself an improvement (primary moves from
  3.9:1 to AA-passing). Every token pair re-verified on both grounds; the
  `-ink` variants exist precisely for text on `-soft` fills.
- **Touch targets**: `--tap-min: 48px` already exists and is used 41 times —
  extend to every new control; never below 48px on mobile.
- **Keyboard**: full traversal of sidebar, tabs, tables, drawers, sheets. Focus
  trap in Modal/Drawer/BottomSheet, Esc closes, focus returns to opener.
- **Visible focus**: a single token-driven focus ring; never `outline: none`
  without a replacement.
- **Semantics**: real `nav`/`main`/`h1`, `th[scope]`, `aria-current` on active
  nav, `role=alert` on errors, `aria-busy` on skeletons.
- **Screen-reader names**: Bangla labels are the accessible names — icon-only
  buttons need `aria-label` (already the pattern in `platform.ts`).
- **Colour never alone**: status carries icon or text as well as hue.
- **Reduced motion**: `app.css` already honours `prefers-reduced-motion`; all
  new transitions must sit behind it.

---

## 10. Responsive strategy

The existing 900px assumption is **not** carried forward — a real sidebar needs
~240px plus ≥720px of content, so the honest switch point is 1024.

| Name | Range | Shell | Grid | Tables |
|---|---|---|---|---|
| **Mobile** | `< 640px` | bottom nav | 1 col | MobileList |
| **Tablet** | `640–1023px` | **bottom nav** (held in hand) | 2 col | MobileList, 2-up |
| **Desktop** | `1024–1439px` | **sidebar** (icons-only <1280) | 3 col | DataTable |
| **Large** | `≥ 1440px` | sidebar full | 4 col, content max 1200px | DataTable + side detail |

```css
--bp-tablet:  640px;
--bp-desktop: 1024px;
--bp-large:   1440px;
```

Transforms per component: `AppShell` swaps mode at 1024 · `DataTable`→
`MobileList` below 1024 · `Drawer`→`BottomSheet` below 1024 · `FilterBar`
inline→sheet below 1024 · `StatCard` 4-up→2-up→1 · sidebar collapses 1024–1279.

**Existing breakpoints (480/700/900) are absorbed**, not stacked on top.
`prefers-reduced-motion` and `print` blocks stay untouched.

---

## 11. Performance

Budget: **the critical path must not exceed today's 180 KB gzipped** (docs/01 §8).

| Rule | Why |
|---|---|
| One CSS file (`app.css`), tokens **copied** not `@import`ed | an `@import` chain costs a round trip on 2G |
| No React, no framework, no runtime CSS-in-JS | D1; the app is deliberately framework-free |
| Reuse `iconSvg` inline SVG; **do not** adopt `/design`'s CDN lucide | removes a third-party request and a supply-chain surface |
| Components are functions returning `HTMLElement`, matching `view-states.ts` | zero new abstraction cost |
| Lazy-load heavy views (calendar 879 ln, academic 1008 ln, branding 672 ln) via dynamic `import()` | keeps first paint flat |
| CSS grows by tokens + shell + components; **retire `--c-*` rules as they are replaced** so net growth stays near zero | prevents a two-system permanent tax |
| Service-worker precache list unchanged in size | offline cache budget preserved |

Measure before/after: `app.js` bytes, `app.css` bytes, precache total, and
first-paint on a throttled profile. A phase that increases the bundle
materially does not ship.

---

## 12. Tenant / white-label (D11)

No regression permitted:

- `/` marketing → **shikhonBD/eShikhon branded**.
- `/app` → **tenant branded**: logo and name in `.d-brand` (desktop sidebar) and
  `.shell-topbar` (mobile); tenant colour drives `--color-primary` at runtime
  via the existing `branding.ts` bootstrap; favicon, manifest, watermark and
  every generated document keep the school's identity.
- `/platform` → **shikhonBD branded** (operator console).
- The three-way CI brand guard in `.github/workflows/frontend.yml` must stay
  green at every checkpoint; tenant-surface files must not gain the string
  `ShikhonBD`, and platform surfaces must not lose it.
- Tenant colour override must be re-validated against **both** light and dark
  grounds (§8) — `branding-view`'s contrast warning extends accordingly.

---

## 13. Functionality preservation

A visual migration may not silently remove behaviour. Each of these is a
checklist item on every affected screen: authentication (OTP + activation
codes), all roles, tenant isolation, attendance, **offline attendance and the
outbox**, notices, the notification bell, SMS, push, calendar, results, fees,
documents, search/history, onboarding.

**Highest-risk:** attendance and marks entry, because both write through the
offline outbox. Their DOM structure is coupled to sync behaviour — restyle
without restructuring the save path, and re-run the offline acceptance before
each is called done.

---

## 14. D13 per screen

A migrated screen is complete only across: **Backend · API · UI · UX states
(loading/empty/error/success/permission) · Authorization · Security · Tests ·
Browser acceptance.** The prototype does not count as UI. Any screen whose
visual migration lands without its states is reported *"restyled — states
pending"*, never complete.

---

## 15. Migration strategy — **B: shell-first, then screens by role**

Chosen to minimise regression:

- **A (screen-by-screen)** would leave two shells alive at once — every screen
  needing both layouts before any of it is coherent.
- **C (role-by-role)** cannot start without a shell either.
- **B** front-loads the one change everything depends on, then proceeds
  role-by-role so each phase ends with a **complete, testable persona**.

### Order and checkpoints

| Phase | Content | Checkpoint / rollback |
|---|---|---|
| **P0** | Tokens (T1–T3), dark palette (T5), no visual change beyond colour | tag `ui-p0`; revert = restore `app.css` |
| **P1** | `AppShell` desktop + mobile modes, Sidebar, MobileNav, TopBar, PageHeader | tag `ui-p1`; feature-flag `?shell=new` until accepted |
| **P2** | Core components (§7) — Card, StatCard, DataTable/MobileList, Drawer, BottomSheet, FormField, states restyle | tag `ui-p2`; components additive, old CSS still present |
| **P3** | **Teacher** role: dashboard, attendance, roster, marks, routine | tag `ui-p3`; **offline acceptance mandatory** |
| **P4** | **Student + Guardian**: dashboards, results, fees, ward panel, my-attendance | tag `ui-p4` |
| **P5** | **Principal + IT Admin**: institution, academic, users, publish, rollover, audit, settings, branding | tag `ui-p5`; rollover/publish gates re-tested |
| **P6** | **New designs** (§6): notices, notifications, calendar, documents, student history | tag `ui-p6` |
| **P7** | **Platform Operations Center** (`/platform`), platform-branded | **COMPLETE 2026-09-02.** Not a restyle — see the note below the rollback line |
| **P8** | Cleanup: retire dead CSS, re-measure budget | **COMPLETE 2026-09-02.** 491 lines of dead CSS removed (3,926 → 3,850 lines; 53.0 → 51.2 KB gzipped). `--c-*` is **retained**: it is an alias layer over `--color-*`, not a second system — 721 live usages, zero of them at zero usage. See PHASE_LOG P8 |

**Rollback:** every phase is its own commit range behind a tag; `git revert` of
a phase restores the previous UI without touching data, API or schema —
guaranteed because none of those change.

> **P7 is the exception, and it is worth saying why rather than quietly
> amending the guarantee.** P7 was planned as a restyle of the platform
> console. Its inventory found that the console's three headline controls —
> suspension, role portals, per-service switches — wrote their rows, recorded
> their audit entries, returned their success messages, and were read by no
> application code at all. Restyling them would have made a better-looking
> screen tell the same untruth.
>
> So P7 carries **schema and API changes** (migrations 051–056, a gate inside
> `withTenant`, `service` on the tenant context) and its rollback is **not**
> `git revert` alone: the rollback files in `db/rollback/` must go with it,
> and 056 must not be rolled back while 054 stands — the header on
> `db/rollback/056_portal_of_system.sql` says why. Every other phase's
> guarantee is unaffected.

---

## 16. Visual regression

Evidence, not opinion. For each phase capture browser screenshots across the
matrix:

| Axis | Values |
|---|---|
| Width | 360 (phone), 768 (tablet), 1280 (desktop), 1600 (large) |
| Theme | light, dark |
| Role | principal, IT admin, teacher, student, guardian |
| Tenant | A and B (different name, logo, colour) — proves branding still drives |
| State | loading, empty, error, populated |

Plus, per phase: no horizontal overflow at any width; keyboard traversal;
contrast spot-checks on changed tokens; and the existing suites
(`node scripts/test-all.mjs`, DB suites, `tsc` ×3, D11 guard, security probe)
green before the tag.

Store evidence under the phase's PHASE_LOG entry.

---

## 17. Final acceptance criteria

```
Desktop            → genuinely desktop (sidebar, tables, desktop hierarchy)
Mobile             → genuinely mobile (bottom nav, lists, sheets, no overflow)
/design            → still the visual reference/prototype, untouched
/app               → the real production implementation
All functionality  → preserved (§13)
All roles          → preserved (§3.3, existing permissions only)
Tenant branding    → preserved (D11, both themes)
Offline            → preserved (attendance + marks outbox)
Dark mode          → preserved as a user preference
Accessibility      → preserved or improved (AA, 48px, keyboard, focus)
Performance        → critical path ≤ today's budget
D13                → all green per screen
```

---

## 18. Risks and mitigations

| Risk | Severity | Mitigation |
|---|---|---|
| Offline attendance/marks regress during restyle | **Critical** | restyle CSS only; never restructure the save path; offline acceptance is a gate on P3 |
| Colour swap breaks contrast somewhere unnoticed | High | P0 is colour-only and separately reviewable; contrast spot-checks in regression |
| Two shells alive at once confuses routing | High | shell behind `?shell=new` during P1; single switch at acceptance |
| Dark palette not authored → dark mode breaks on new tokens | High | T5 is *inside* P0, not deferred |
| `--c-*`/`--color-*` coexist permanently, doubling CSS | Medium | P8 deletes at zero usage; budget re-measured |
| Bundle growth from new components | Medium | lazy-load heavy views; measure per phase |
| D11 brand guard trips on new shell markup | Medium | guard runs in CI every phase |
| `/design` mistaken for production during migration | Medium | `surfaces.test.ts` already asserts the split; keep it green |
| 12 screens need new design before implementation | Medium | P6 is scheduled after the system exists, so they are designed *in* the language |
| Scope creep into features | Medium | this is a **visual** migration; no new capability without its own phase |

---

## 19. Files likely to change

**Heavily:**
- `apps/pwa/public/app.css` (tokens, shell, components, all screen CSS)
- `apps/pwa/src/shell.ts` (dual-mode shell)
- `apps/pwa/src/view-states.ts` (restyle; API unchanged)
- `apps/pwa/src/app.ts` (nav grouping for sidebar; **route table unchanged**)

**New:**
- `apps/pwa/src/components/*.ts` (Sidebar, DataTable, MobileList, Drawer,
  BottomSheet, FormField, StatCard, PageHeader, Tabs, FilterBar, Timeline,
  CalendarCell, DocumentPreview)

**Per screen (restyle only, logic preserved):** the ~30 view modules in the §4
matrix.

**Also:** `apps/pwa/public/platform.css` + `apps/pwa/src/platform.ts` (P7),
`apps/pwa/test/*` (component + regression tests), `docs/PHASE_LOG.md` per phase.

**Explicitly NOT changed:** `services/**`, `db/**`, `api/**`, `vercel.json`,
`netlify.toml`, `deploy/**`, `apps/pwa/public/design.html`,
`apps/pwa/public/design/**`, `apps/pwa/public/index.html`.

---

## 20. Estimated phases

| Phase | Scope | Relative size |
|---|---|---|
| P0 tokens + dark palette | 1 file, high care | S |
| P1 shell | shell + 4 components | M |
| P2 core components | ~14 components | **L** |
| P3 teacher | 5 screens, offline gate | M |
| P4 student + guardian | 6 screens | M |
| P5 principal + IT admin | 9 screens | **L** |
| P6 new designs | 12 screen families (design + build) | **L** |
| P7 platform console | own shell | M |
| P8 cleanup | delete legacy, measure | S |

Sequential by dependency: P0 → P1 → P2 → (P3 → P4 → P5) → P6 → P7 → P8.

---

## 21. P0 — DELIVERED (2026-09-01)

**Status: complete. P1 has not begun.**

One file changed: `apps/pwa/public/app.css`. No TypeScript, no API, no schema,
no routing, no `design.html`, no marketing page. Rollback is
`git checkout apps/pwa/public/app.css`.

### What made it a one-file change

`--c-*` turned out to be a pure **semantic alias layer** — 29 tokens that every
one of the 424 `var(--c-*)` usages resolves through. Its own comment promised
this: *"the palette can be re-pointed at a different design system by editing
this block alone rather than 800 lines of rules."* That promise held. The
palette was migrated by re-pointing the aliases at new primitives; **not one
view module or component rule was touched.**

### Token decisions

| Decision | Reasoning |
|---|---|
| Tokens **copied**, not `@import`ed | `/design` is a prototype that may be edited freely; production must not inherit its edits, nor pay for a second stylesheet request on 2G |
| Spacing, radius, shadows, `--tap-min`, fonts **untouched** | already byte-identical to the canonical set before P0 |
| Added `--space-5/10/12`, `--transition-fast/base`, `--font-bn-num` | canonical, and absent here |
| Muslin (`#F1EFE6`) becomes the **page**; white stays the **card** | the single most recognisable Ata Ekta trait; `body` now resolves to `--color-surface` in both themes |
| `-text` steps introduced (`--color-primary-text` etc.) | five canonical hues fail AA **as text on Muslin**. Hue kept, step moved — the discipline the previous palette already used |
| Type scale: canonical **names**, existing **sizes** | see below |

### Colour migration, by role

Every value was measured before adoption. Ratios are on white / Muslin.

| Role | Value | Evidence |
|---|---|---|
| Brand fill | `#D23B2E` | 4.77:1 under white. Replaces `#e53935` which was **4.23:1 and failed AA** — the correction the design system exists for |
| Brand as text | `#B32E22` | 4.14:1 was the raw hue on Muslin; this is 5.47:1 |
| Text / muted / tertiary | `#53443D` / `#756256` / `#756256` | 9.28 / 5.77 / 5.77 on white; 8.06 / 5.01 / 5.01 on Muslin |
| Status as text | success `#4A6E47`, warning `#7C5C1B`, info `#436A81`, danger `#B3392C` | all ≥5.0:1 on Muslin; the raw canonical hues were 4.15 / **2.95** / 4.02 / 5.15 |
| Badge ink on soft | canonical `-ink` on `-soft` | 6.05–8.01:1 |
| `--color-text-faint` | `#97867B`, **decorative only** | 3.49 / 3.03 — no text token aliases it, guarded by a test |

### Typography mapping

Canonical Ata Ekta body is **14px**; this ladder's is **16px**, with a 13px
chip floor. That gap is deliberate — Bangla conjuncts lose legibility before
Latin does at the same optical size (Override 3 in the file header, F-812's
accessibility floor). **Adopting the canonical sizes would have shrunk every
screen and regressed the one thing this product cannot regress.** So the
canonical *names* were adopted and mapped onto the existing ladder; only
weight and line-height came across:

`--text-h1` → 24px/700/1.25 · `--text-h2` → 20px/600/1.3 ·
`--text-h3` → 18px/500/1.4 · `--text-body` → 16px/400/1.55 ·
`--text-body-small` → 15px · `--text-label` → 14px · `--text-caption` → 13px/1.4

### Dark mode — kept, and re-cut warm

Per §8 the decision was **C (optional user preference)**, and P0 authored the
palette rather than deferring it: light is the default, `data-theme` still
drives the toggle, and the grounds are a warm Clove family (`#1B1714` page,
`#241E1A` card) — **not** the cool near-black it replaced and not the legacy
green. Brand fills keep the light step so a primary button is identical at
midnight and noon; brand and status **text** move up the ramp, the mirror of
how they move down in light. Every dark text step measured ≥4.8:1 on all three
grounds.

### Two defects found and fixed

1. **`.system-row` had no background.** It is a `<button>`, so it inherited the
   *user-agent button face* — invisible in light, `#6B6B6B` under
   `color-scheme: dark`, where `--c-ink-2` on it is **2.59:1**. Pre-dates P0 in
   both palettes; found by the contrast sweep, not by looking.
2. **The new test's own first three runs were wrong** — it read tokens named
   inside comments, missed tokens declared several-per-line, and conflated
   `var(--x, fallback)` (safe, deliberate) with `var(--x)` (silent
   inheritance). Each was fixed before the test was trusted.

### Verification

| Gate | Result |
|---|---|
| Contrast sweep, rendered | **956 element-checks**, 12 routes × 2 themes → **0 failures** |
| Overflow | none at 1440 / 1024 / 390 / 375, both themes |
| Touch targets | 0 interactive elements under 44px |
| Tenant branding | Tenant A (`#156a3f`) and Tenant B (`#1b3e7a`) both render; grounds and status stay canonical, only brand hue changes |
| Tests | **1172** with a database (1160 before; +12 new token tests) |
| TypeScript ×3 | 0 / 0 / 0 |
| DB suites · D11 · secrets | 26/26 · pass · clean |
| Security probe | **29/29** across 12 areas |
| Size | `app.css` +7.2 KB raw, **+2.6 KB gzipped** (32.3 → 34.9 KB). `app.js` unchanged |

### Legacy tokens

29 `--c-*` definitions and 424 usages — **unchanged by design**. They now all
resolve to Ata Ekta primitives. They are retired in **P8**, when their usage
reaches zero, exactly as the plan states. Nothing was deleted.

### What P0 deliberately did not do

No shell. `/app` is still mobile-first at every width — its only desktop
breakpoint still styles the branding editor. That is **P1**, and keeping it out
of P0 is what makes this phase a one-file rollback.

---

**P0 complete. P1 has not begun.**


---

## 21a. P1 — delivered (2026-09-01)

The shell, and only the shell. Commits `0466861` (A–D), `2c4d68d` (E–F).

### Acceptance

| Area | Desktop | Mobile | Light | Dark | Tenant A | Tenant B | Tests |
|---|---|---|---|---|---|---|---|
| Shell layout | ✅ 1024–1600 | ✅ 375–768 | ✅ | ✅ | ✅ | ✅ | ✅ 28 |
| Sidebar + groups | ✅ 5 role maps | n/a | ✅ | ✅ | ✅ | ✅ | ✅ |
| Icon rail 1024–1279 | ✅ 68px | n/a | ✅ | ✅ | ✅ | ✅ | ✅ |
| Topbar + breadcrumb | ✅ | ✅ compact | ✅ | ✅ | ✅ | ✅ | ✅ |
| Profile menu | ✅ Esc · outside · focus | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ 6 |
| Bottom bar (role) | hidden | ✅ 5 tabs | ✅ | ✅ | ✅ | ✅ | ✅ 18 |
| Contrast | ✅ 0 fail | ✅ 0 fail | ✅ | ✅ | ✅ 246 | ✅ 246 | ✅ |
| Overflow / targets | ✅ none | ✅ none | ✅ | ✅ | ✅ | ✅ | ✅ |
| `/demo` vs `/app` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |

### Component inventory — built

`AppShell` · `DesktopSidebar` (grouped, rail, tooltips) · `MobileNav` ·
`TopBar` · `Breadcrumb` · `ProfileMenu` · `ThemeControl` · `DemoBanner` ·
`SkipLink` · `OfflineBanner` (kept) · `BellBadge` (kept) · `navFor(role)` ·
`crumbFor(role, path)` · `roleLabel(code)` · 9 new icons.

**Not built, deliberately:** Card, StatCard, Button, Input, Select, Table,
MobileList, Modal, Drawer, BottomSheet, Tabs, Badge, Toast, ConfirmDialog,
EmptyState, ErrorState, Skeleton, Timeline, FilterBar, SearchField, PageHeader.
These are **P2**. A component invented before the screen that needs it is a
guess, and §39 says to create one only when the abstraction is genuinely
reusable.

### Files changed

`apps/pwa/src/shell.ts` (rewritten) · `src/ui/nav.ts`, `ui/theme.ts`,
`ui/roles.ts` (new) · `src/icon.ts`, `src/app.ts`, `src/more-view.ts`,
`src/users-view.ts`, `src/audit-view.ts`, `src/demo.ts` ·
`public/app.css` · `packages/ui-core/src/branding.ts` ·
`packages/server-core/src/web-push.ts` · 4 test files ·
`vercel.json`, `netlify.toml`, `deploy/server.mjs` (the `/demo` route).

**No** database, API, RLS, auth, tenant-resolution, attendance, notification,
SMS, calendar, finance, result, document or onboarding change.

### Duplication removed rather than added

Three role-label maps became one (the audit log's was a seven-role subset, so
`dept_head` rendered as `dept_head` to a head teacher reading who changed
what); two theme implementations became one.

### Known limitations

- **Security probe unrun** — needs a seeded two-tenant deployment.
- `.btn-small` is 44px and `.cal-day` is 45px wide at 390px. Both pre-date P1,
  both clear 44 and WCAG 2.2 AA's 24px; they are component work for **P2**.
- The rail toggle is 32px with a fine pointer (48px under `pointer: coarse`).
- Dashboards are reflowed, not redesigned. Tables are still tables at every
  width. `.page-header` is still per-view. All **P2–P6**.


---

## 22. P2 — delivered (2026-09-01)

The component system. Commit `6145592`.

### Components created

`el` `append` `icon` `lang` `clear` `uid` · `button` `iconButton` `buttonRow`
`setBusy` `onClickBusy` · `card` `statCard` `statRow` `avatar` · `pageHeader`
`breadcrumb` `backLink` `sectionHeading` · `badge` `statusBadge` `countBadge` ·
`field` `searchField` `setFieldError` `clearFieldError` `reportErrors` ·
`fileUpload` · `dataTable` `listItem` `list` `pagination` `timeline` ·
`openOverlay` `openDrawer` `confirmOverlay` `setOverlayBody` · `tabs`
`filterBar` · `toast` `announce` `inlineLoader` `progress` `tooltip`
`listSkeleton` `permissionState` `humanError`.

### Components reused rather than rewritten

`skeleton` `emptyState` `errorState` `successNote` from `view-states.ts`,
which 20+ modules already use. Re-exported through `ui/index.ts` so there is
one import surface and one implementation.

### Token usage

Every rule resolves to a `--c-*` or `--color-*` token; no literal colour
appears in the component CSS. Two token corrections were needed and are
recorded above: `--c-on-primary` (P1) and the four status tints (P2).

### Acceptance

| Area | 360 | 375 | 390 | 1024 | 1280 | 1440 | Light | Dark |
|---|---|---|---|---|---|---|---|---|
| Contrast | ✅ 0 | ✅ 0 | ✅ 0 | ✅ 0 | ✅ 0 | ✅ 0 | ✅ | ✅ |
| Overflow | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Nameless controls | ✅ 0 | ✅ 0 | ✅ 0 | ✅ 0 | ✅ 0 | ✅ 0 | ✅ | ✅ |
| Table → list swap | list | list | list | table | table | table | ✅ | ✅ |
| Overlay presentation | sheet | sheet | sheet | modal | modal | modal | ✅ | ✅ |

### Known limitations

- Breadcrumb links are 24px (WCAG 2.2 AA minimum; inline-exempt) and filter
  chips 34px with a fine pointer, 48px under `pointer: coarse`.
- The legacy `.btn-*`, `.card`, `.field` and `.chip` families still exist and
  are still used by every unmigrated screen. They retire in **P8**, at zero
  usage, exactly as this plan states — not before.
- Only `pageHeader` is adopted. The rest of the system ships nothing until a
  screen imports it, which is why `app.js` grew 0.4 KB.


---

## 23. P3 — delivered (2026-09-01)

The teacher role. Commits `5959975` and the documentation commit after it.

### Screens

| Screen | State | Notes |
|---|---|---|
| Dashboard | **new** | Derived from `/rms/routine?scope=day`; one dominant action |
| Attendance | **rebuilt around the grid** | 13 states; save path untouched |
| Roster | **migrated** | shared DataTable → MobileList |
| Routine | **migrated** | tab strip; substitutions explain themselves |
| Marks | **hardened** | double-submit guard; read-only explained |
| Scripts | **made usable** | named pickers replace UUID text boxes |

### Acceptance

| Area | 360 | 375 | 390 | 1024 | 1280 | 1440 | Light | Dark | Tenant A | Tenant B |
|---|---|---|---|---|---|---|---|---|---|---|
| Contrast | ✅ 0 | ✅ 0 | ✅ 0 | ✅ 0 | ✅ 0 | ✅ 0 | ✅ | ✅ | ✅ | ✅ |
| Overflow | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Nameless controls | ✅ 0 | ✅ 0 | ✅ 0 | ✅ 0 | ✅ 0 | ✅ 0 | ✅ | ✅ | ✅ | ✅ |
| Attendance layout | list | list | list | grid | grid | grid | ✅ | ✅ | ✅ | ✅ |
| Roster layout | cards | cards | cards | table | table | table | ✅ | ✅ | ✅ | ✅ |

### Known teacher limitations

- The full offline round trip to a real server is unproven — demo mode answers
  locally and the CI database has no tenant. Steps 7–11 of the offline
  acceptance need a seeded school.
- `assignments`, `substitute` and `classperf` keep legacy markup: reached from
  More, not from the teaching day.
- The teacher dashboard shows an unread count but not the notices themselves —
  the inbox is one tap away and P6 designs the notice surface.
- Attendance is one section and one date at a time. Backdating and
  period-wise entry exist in the API and have no picker yet.

## 24. P4 — delivered (2026-09-01)

Student and guardian. Details, evidence and every defect in `PHASE_LOG.md`
under "P4 — Student + Guardian final production UI/UX".

### Screens

| Screen | Role | State | Notes |
|---|---|---|---|
| Home | student | **new** | `student-home-view.ts`; four independent fetches, each repainting as it lands |
| আমার সন্তান | guardian | **migrated** | render moved to P2 components; cache-first paint kept |
| Child selector | guardian | **new component** | `ui/child-selector.ts` — the §3 CRITICAL piece |
| Subjects · Learn · Assignments · Results · My attendance · Fees · Documents | student | **legacy markup, verified** | accessible, responsive, green in every sweep; not yet on the shared components |
| Results · Fees · Inbox · Calendar · Documents | guardian | **legacy markup, verified** | same |

### The child selector

| Children | Renders | Rule |
|---|---|---|
| 0–1 | nothing | a control with one option teaches people their tap did nothing |
| 2–3 | inline strip, both names always visible | the question is never asked because it is already answered |
| 4+ | button naming the current child + sheet | side-by-side stops fitting 360 px |

Accessible name carries name **and** class. Roving tabindex; arrow/Home/End.
Every change announced. Roll numbers stay in Latin digits.

### Acceptance

48 configurations — 2 personas × 2 tenants × 6 widths × 2 themes — with CSS
transitions frozen so the probe cannot read a mid-flip blend.

| Area | 360 | 375 | 390 | 1024 | 1280 | 1440 | Light | Dark | Tenant A | Tenant B |
|---|---|---|---|---|---|---|---|---|---|---|
| Contrast | ✅ 0 | ✅ 0 | ✅ 0 | ✅ 0 | ✅ 0 | ✅ 0 | ✅ | ✅ | ✅ | ✅ |
| Overflow | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Nameless controls | ✅ 0 | ✅ 0 | ✅ 0 | ✅ 0 | ✅ 0 | ✅ 0 | ✅ | ✅ | ✅ | ✅ |
| `undefined` / UUID in a11y text | ✅ 0 | ✅ 0 | ✅ 0 | ✅ 0 | ✅ 0 | ✅ 0 | ✅ | ✅ | ✅ | ✅ |
| Child selector | strip | strip | strip | strip | strip | strip | ✅ | ✅ | ✅ | ✅ |

~15,900 element-checks, 0 failures. Long-content stress at 360 (43-char name,
62-char institution, sentence-length title): no page overflow; only
`.shell-org-name` clips, by design.

### Known student / guardian limitations

- **No student routine card.** `GET /rms/routine` wraps
  `app.teacher_day(claims.sub)`; a student gets their own empty teaching day.
  There is no section-scoped routine endpoint. **P5.**
- **Seven student/guardian screens keep legacy markup** — listed above.
  Migrating a working, accessible screen carries risk and no user-visible
  benefit, so it is a P5 decision rather than a P4 action.
- **`doLogout` does not purge the read-through caches.** P4 fixed the demo's
  role picker, which is the surface a stranger can reach; a real session
  ending on a shared device is a bigger question because the sync outbox may
  hold unsent attendance. **First item on P5.**
- The guardian's roster/marks refusal reads as "could not fetch", not "you do
  not have permission". The attendance screen says the permission sentence
  properly; the other two say the generic one.

## 25. Pre-P5 Product Closure Pass — delivered (2026-09-01)

Not a phase: the four user-facing gaps P3 and P4 left, closed before P5 opens.
Full detail, including everything the browser found, is in `PHASE_LOG.md` under
"Pre-P5 Product Closure Pass".

### Screens changed

| Screen | Role | Change |
|---|---|---|
| Home — "আজকের ক্লাস" | student | **new card** (B-15). Today's periods, the one running NOW marked, subject · time · room · teacher, substitutions named |
| Academic structure | principal · owner · coordinator · IT admin | **new rename drawer** (B-6), from the section detail and per class-group |
| Roster · Marks · আমার সন্তান | all | a refusal now says the permission sentence, not "could not fetch" |

### The routine card

| State | What it says |
|---|---|
| loading | three-row skeleton, in place |
| classes today | one row per period; `এখন চলছে` on the current one (also `is-urgent`), `পরবর্তী` on the next when nothing is running |
| substituted | the covering teacher's name with `(বদলি)` — in the meta line, so it survives alongside the timing badge |
| no classes | `আজ কোনো ক্লাস নেই।` — the heading stays; a vanished block reads as a failed load |
| missing subject / teacher | `বিষয় নির্ধারিত হয়নি` / `বদলি শিক্ষক`. Never the word `undefined` |
| the routine alone failed | its block empties; the rest of the screen renders |

Bangla ordinals are per-number (`১ম ২য় ৩য় ৪র্থ ৫ম ৬ষ্ঠ`) — the first draft
suffixed `ম` to every digit, which is right for period one and wrong for two,
three, four and six.

### The rename drawer

P2 components throughout (`field`, `button`, `buttonRow`, `openDrawer`). Current
name pre-filled and in the drawer title, so the before and the after are in one
glance. Server refusals are shown in the drawer's `role="alert"` line **and**
announced, because focus is on the button just pressed. Counts in Bangla digits
on both sides of the wire — the first version said "40 জন" in the helper above a
refusal that said "42 জন", from two different constants.

### Acceptance

| Area | 360 | 390 | 1440 | Light | Dark | Tenant B |
|---|---|---|---|---|---|---|
| Contrast | ✅ 0 | ✅ 0 | ✅ 0 | ✅ | ✅ | ✅ |
| Overflow | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Unnamed controls | ✅ 0 | ✅ 0 | ✅ 0 | ✅ | ✅ | ✅ |
| `undefined` in a11y text | ✅ 0 | ✅ 0 | ✅ 0 | ✅ | ✅ | ✅ |

**759 element-checks, 0 failures.** The rename drawer separately: `role=dialog`,
`aria-modal`, labelled, focus contained, 0 contrast failures and no sub-44px
control, in both themes.

### Still legacy

The seven student/guardian screens listed in §24 are unchanged. `B-30` records
that four of them were **not** audited for the permission message, because they
403 only in situations not yet reproduced and changing them unverified would be
worse than leaving them.

## 26. P5-0 — stabilization gate (2026-09-01)

No screen was redesigned. Two quality items, both closed; detail in
`PHASE_LOG.md` under "P5-0".

**B-30 — one permission pattern.** Nine student-facing views turned a 403 into
"আনা যায়নি" and kept the refused data on screen from cache. There were five
wordings for one condition. Now one function, `permissionMessage(subject?)`,
which `humanError` and the P2 `permissionState` both route through — the
subject is kept because it tells a person *what* they cannot see; the shape and
the ending are what got unified. Every affected screen drops its cache on a
refusal, says nothing about being offline, and offers no retry.

On six of the nine a 403 is not currently reachable: those endpoints are
RLS-scoped and answer with an empty payload rather than a refusal, so the
handling is defensive. Stated rather than claimed as a live fix.

**B-31 — the typecheck gate.** `npm run typecheck` now runs exactly what CI
runs, by parsing the workflow for its config list, and fails when a new `.ts`
file appears outside every config.

**States touched:** the *permission* state is now reachable on nine screens
that previously had only loading / empty / error / offline. `permissionState()`
existed since P2 and no student screen could reach it.

## 27. P5 — Principal + IT Admin (2026-09-01) · **PARTIAL**

Two pieces delivered; the IT Admin surface is not started. Full detail in
`PHASE_LOG.md` under "P5 — Principal + IT Admin".

### Delivered

| Screen | Role | State |
|---|---|---|
| Home / প্রতিষ্ঠান | principal · school_owner | **rebuilt** on P2 (`principal-home-view.ts`) |
| Guardian panel — end a relationship | principal · owner · IT admin | **new flow** (B-7) |

### The dashboard's order, and why

The brief asks the top of the screen to answer three questions, so the blocks
are in that order: **what needs attention** (the pending queue, non-zero rows
only), **what changed** (today's attendance and absences — the only figures
that differ from yesterday's), **what can I act on** (exams, notices, fees).
Standing counts last. No charts: 04-UIUX prohibits client-side charting on the
device floor, and nothing here is a trend.

| State | What it shows |
|---|---|
| loading | five-row skeleton |
| nothing pending | one calm line, `সব কিছু নির্ধারিত আছে` — not four ০s |
| attendance not yet taken | `এখনো নেওয়া হয়নি` and the denominator. **Never ০%** |
| no academic year | what to do, with a route — not a screen of zeroes |
| no `finance` in the response | the fee block does not exist. Not hidden (D13) |
| 403 | the canonical permission sentence, no retry |
| network failure | the error state, with a retry |

### Desktop vs mobile

`.ph-cols` stacks on a phone, 2 columns at 1024, 3 at 1440+. The responsive
rules sit at the **end** of `app.css`, where source order lets them win.

### Two component-level fixes this screen forced

- **`.ui-stat-row` was `repeat(4, 1fr)` at desktop** — right for four cards and
  wrong for two. The guardian home has carried two since P4 and was rendering
  them at a quarter width each on a wide screen. Now `auto-fit`.
- The permission and error states are now distinct on this screen, per B-30.

### Acceptance

| Area | 360 | 390 | 1024 | 1440 | 1600 | Light | Dark | Tenant A | Tenant B |
|---|---|---|---|---|---|---|---|---|---|
| Contrast | ✅ 0 | ✅ 0 | ✅ 0 | ✅ 0 | ✅ 0 | ✅ | ✅ | ✅ | ✅ |
| Overflow | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Unnamed controls | ✅ 0 | ✅ 0 | ✅ 0 | ✅ 0 | ✅ 0 | ✅ | ✅ | ✅ | ✅ |
| `undefined` in a11y text | ✅ 0 | ✅ 0 | ✅ 0 | ✅ 0 | ✅ 0 | ✅ | ✅ | ✅ | ✅ |
| Layout | stacked | stacked | 2-col | 3-col | 3-col | ✅ | ✅ | ✅ | ✅ |

### NOT delivered — `B-34`

Every IT Admin screen (academic structure, users, teachers, students,
guardians, imports, branding, settings, audit, system health) and every other
Principal screen keep their pre-P2 markup. The audit viewer's UX — actor names,
filters, changed fields, permission-aware redaction — is still what R-3
shipped. P5 continues from here.

## 28. P5 / B-34 — IT Admin + Principal surfaces (2026-09-01) · **PARTIAL**

Detail in `PHASE_LOG.md` under "P5 / B-34". The short version: the audit
changed the plan, because the LOOK was already canonical (P0 converged `.card`
and `.ui-card`) and the gap was SHAPE — at 1440 the list screens were phone
layouts stretched across a 1142px column.

### Migrated

| Screen | Change |
|---|---|
| `users` | P2 `dataTable` — real table at desktop, MobileList on a phone |
| `students` | same |
| `audit` | raw uuid removed · canonical refusal naming who CAN read it · desktop column rhythm (`au-rows`) |
| `branding` | read-only derived from ROLE, not from a 403 on a public GET |

**`audit` was deliberately not made a `dataTable`** — the value of the row is
its before/after diff and a table cell cannot hold one. Recorded as an
exception with a reason, not an omission.

### Defects fixed

- a raw uuid on every expanded audit entry (§14)
- `--c-info` was the raw tenant accent used as TYPE — 4.38:1 on tenant B's
  ledger. The generalisation of P4's `--c-primary-text` fix that P4 did not make
- branding gave a class teacher twelve live fields and a permanently dead save

### Acceptance

| Persona | Widths | Routes | Checks | Failures |
|---|---|---|---|---|
| IT Admin, tenant A | 375 · 1024 · 1440 | 10 | 1,223 | 0 |
| Principal, tenant B | 360 · 768 · 1440 · 1600 | 17 / 7 | 2,738 | 0 |

Both themes throughout. 0 contrast · 0 overflow · 0 unnamed controls ·
0 `undefined` · **0 uuids on screen**.

### Still legacy after this pass

Academic structure, imports, settings hierarchy, dedicated teacher/guardian
list screens, publish · calendar · documents · fees · invoices · ledger ·
compose · inbox, and system health's state vocabulary. All render and sweep
clean; none is on P2 primitives. **P5 remains PARTIAL.**

## 29. P5 close — the remaining IT Admin + Principal screens (2026-09-01) · **COMPLETE**

Detail in `PHASE_LOG.md`. The measurement first, because it set the scope:
every one of these screens rendered **0 `.ui-card`, 0 `.ui-btn`,
0 `.ui-field`**, and at 1440 each list was full-width strips down a 1110px
column — the phone shape stretched, which §4 forbids.

### Migrated

| Screen | Shape now |
|---|---|
| academic | four depths, four tables · real crumbs · both forms on `field()` |
| import | rebuilt — role-chosen kind, resolved year, `fileUpload`, error table |
| settings | two groups: what this endpoint owns, and what lives elsewhere |
| system | table + a legend defining all four states |
| fees | table; the invoice's lines and receipts in a drawer |
| invoices · ledger · documents · publish · calendar · compose · inbox | see the log |

**Exceptions, recorded with reasons rather than left as omissions.**
`results` keeps its own `<table>` — `dataTable` cannot express the `colSpan`
cell reading **অনুপস্থিত** across the marks of a child who did not sit, and
migrating would have deleted it. `inbox` stays a disclosure list: a notice is
a title that opens into a paragraph.

### Primitives that grew

`Crumb.onClick` (depth the router does not hold) · `FieldKind: 'month'` ·
`serverMessage()` · `.ui-facts` · `.ui-card-lead/-note` · `.ui-card-grid` ·
`.ui-check` · `.ui-fieldset`.

### Eleven defects

Five security or privacy — a ledger that **fabricated a school's accounts
under a 403**; three finance endpoints ungated in the public demo; a live
search bar under a refusal; the notice composer offered to a student; a
"একসাথে সবার" badge promising a child a bulk capability they do not have.
Six correctness or truth — student import that could never work, a teacher
importer with no UI, `requireRole`'s English role codes reaching a Bangla
screen through fifteen views, `isDenied(res)` silently always false, `2026-08`
printed at a parent, and `fileUpload`'s hidden input scrolling the page
sideways at 1280.

### Acceptance

| Persona | Widths | Routes | Checks |
|---|---|---|---|
| IT Admin, tenant A | 360 · 375 · 390 · 1024 · **1280** · 1440 · 1600 | 10 | 6,226 |
| Principal, tenant B | same seven | 17 | 13,586 |

**0 failures.** 0 contrast · 0 overflow · 0 unnamed controls · 0 `undefined` ·
0 uuids · 0 ISO dates as values. 1280 is where the `fileUpload` overflow was
found; B-34 never drove it.

## 30. P6 — the functional screens with no design reference (2026-09-01) · **COMPLETE**

Detail in `PHASE_LOG.md`. Nineteen screens, four families, fourteen defects.

### The inventory came first, and changed two answers

All 41 routes rendered as five roles at 1440 and measured. Two of the results
were not what the old P6 list assumed:

- **`institution` is a near-duplicate of the P5 dashboard**, not a missing
  design — same endpoint, same figures, older markup. Whether a school wants
  two is an **owner decision, recorded not taken**. P6 gave them different
  questions instead: `home` = what needs me now, `institution` = what this
  school is.
- **`roles` is an explainer**, not an operational screen, and is classified so.

### Migrated

| Family | Screens |
|---|---|
| A — teacher satellites | assignments · marks · scripts · classperf · routine · sikhok |
| B — coordinator planning | substitute · examroutine · routineeditor · generation · subjectchoice |
| C — student learning | subjects · learn · shikho · my-attendance |
| D — cross-role shell | more · notifications · roles · institution |

**`routine`'s week view is the one screen that earned a genuinely different
desktop shape** — a real period×day grid with `<th scope>` on both axes, where
it had been the day list stacked seven times at 1120px. Mobile keeps the list:
a 7×8 grid at 360 is unusable.

### Exceptions, each with a reason

`marks`' entry grid (per-cell dirty state and offline queueing) · exam-routine's
table (inline `colSpan` reschedule row) · routineeditor's grid (already correct)
· class-perf and my-attendance bars (CSS width on a token, not a library).

### Defects worth carrying forward

- **`emptyState` ignored its `glyph`** and drew a literal `·`, blaming an
  import cycle that does not exist. Five screens had worked around it with a
  stray `⃝`. Fixed at the primitive; all five workarounds removed.
- **`.ui-card` used `width: 100%`**, so any horizontal margin overflowed the
  container. Now `width: auto`.
- **Two screens offered a student a staff job** — the AI generator and the
  answer-script upload. Both now mirror `requireStaff`.
- **Two screens rendered an error AND an empty state together**, which are
  contradictory claims.
- **`levelNameBn` moved to `ui-core`** after a second screen nearly grew its
  own — and my first draft of that copy was wrong ("১১ম" for একাদশ), which is
  P4's "২ম পিরিয়ড" bug a second time.

### Acceptance

| Persona | Widths | Routes | Checks |
|---|---|---|---|
| Teacher, tenant A | 360 · 375 · 390 · 1024 · **1280** · 1440 · 1600 | 14 | 9,340 |
| Student, tenant B | same seven | 12 | 8,196 |
| Coordinator, tenant A | 360 · 1024 · 1440 · 1600 | 17 | 6,618 |
| P5 regression, Principal tenant B | 360 · 1024 · 1440 | 17 | 5,788 |

**0 failures.** The P5 sweep was re-run in full because the `.ui-card` change
touches every card in the product.

---

## P9-2 — routine setup (2026-09-06)

Two new screens, both on the canonical components (`pageHeader`, `card`,
`statusBadge`, `field`, `button`, `emptyState`, `errorState`,
`permissionState`, `listSkeleton`, `toast`, `announce`). No new design
language, no new primitives.

**`routine-setup-view.ts` — the checklist.** One card per input, a status
badge, one sentence of detail, and one action. Deliberately not a linear
wizard: a school's data does not arrive in step order, so marching a
coordinator through five correct screens to reach the sixth would be worse
than a list they can scan. Three states — সম্পূর্ণ / ঐচ্ছিক / প্রয়োজন — with
the middle one carrying real weight, because a wizard that called an optional
gap "incomplete" would send a school off to do an afternoon of unnecessary
data entry.

Three steps open an editor inline (bell times, subject demand, teacher
availability — the ones with no screen before P9-2). The rest link out to the
screens that already own them.

**`teaching-assignments-view.ts` — the matrix.** Subjects down, sections
across, one class at a time: the sheet already pinned up in the office. Both
layouts render and CSS chooses, so each cell exists twice — the change handler
moves both, which a browser found and a test now pins.

**Responsive**: verified at 360, 375, 390, 640, 768, 1024, 1280, 1440 and
1600, no horizontal scroll at any width. The matrix collapses to one card per
subject below the table breakpoint; the checklist is cards at every width and
needs no collapse.

**Dark**: `data-theme="dark"` (this design system's explicit attribute, not
`prefers-color-scheme`). Card text 13.36:1; the প্রয়োজন and ঐচ্ছিক badges at
6.11:1 and 6.41:1.

**Accessibility**: every grid cell and every time box carries an explicit
`aria-label` naming its subject and section — a screen reader landing in a
grid cell announces neither its column nor its row header. No raw uuid reaches
any accessible name, asserted by test.

## P9-3 — routine generation (2026-09-06)

One new screen, `routine-generate-view.ts`, on the canonical components
(`pageHeader`, `card`, `statCard`/`statRow`, `statusBadge`, `button`,
`buttonRow`, `inlineLoader`, `permissionState`, `listSkeleton`, `announce`).
No new design language, no new primitives, no charting.

**Nine states, and the two that are usually skipped.** ready · not-ready ·
generating · generated · generated-with-warnings · partially-generated ·
validation-failure · server-error · permission-denied. The two that matter:

*not-ready* keeps the button visible and disabled, because its state IS the
message — hiding it would leave a coordinator wondering where the feature
went — and lists the blocked steps with the counts that will clear them.

*partially-generated* is not an error. A routine with 19 unplaced demands is a
usable routine with work left, and it is presented as a to-do list: class,
subject, teacher, how many periods are missing, and the reason in a sentence.
"Generation failed." never appears anywhere, alone or otherwise.

**The wait is honest.** `POST /rms/generate` is one blocking request with no
stream and no job id, so there is nothing true to put in a progress bar. The
screen shows a spinner, an elapsed second count, and a sentence saying the
server is doing the whole job at once. `ui/feedback.ts:progress` is
deliberately not imported; a test asserts no `role="progressbar"` renders.

**The verdict is the server's sentence**, rendered verbatim and never
recomposed in the browser. A hard conflict outranks it: a routine that
publish would refuse must not be announced as "all 2,360 periods placed".

**Responsive**: verified at 360, 375, 390, 768, 1024, 1280, 1440 and 1600 —
no horizontal overflow at any width, and no tap target under 44px. The stat
row wraps from two columns to auto-fit; every card is a card at every width.

**Dark**: `data-theme="dark"`. Body `#1B1714`, card `#241E1A`, card text
`#EDE7DA`, the quiet `.ui-card-note` at `#BFB3A4` — about 8:1 for the
quietest pair on the screen.

**Accessibility**: the wait is a live `role="status"` and the result is
announced with the verdict sentence, so a screen-reader user is told the
answer rather than left to hunt for it. Heading order H1 → H2 → H3 → H2, no
level skipped. No raw uuid reaches the page, asserted by test.

**CSS repaired, not added to.** `.ui-stack`, `.ui-cell-line`, `.ui-cell-meta`
and `.setup-period-row` had been used as layout hooks since P9-1 and P9-2 with
no rule behind them; on a 360px phone the bell-times editor was five
full-width inputs touching each other. They are now defined in `app.css`
beside `.ui-card-lead`, with a phone-first two-column grid for the period row.

**Navigation.** The academic coordinator's second dashboard tile is now
"রুটিন তৈরি করুন" in place of "আজকের রুটিন" — the same slot, the same shape,
but this is the role that builds the timetable. Reading today's routine is a
teacher's need and remains a tab and a More entry. Every other role reaches
the screen from More.

## P9-4 — routine explainability (2026-09-07)

No new screen. `routine-generate-view.ts` gained one card and one drawer, on
the canonical components (`card`, `statusBadge`, `sectionHeading`,
`successNote`, `openDrawer`). No new primitives, no charting.

**One list, not four.** Unplaced rows, room shortages, soft trades and
optional setup gaps were four sections saying related things with no order
between them; a coordinator had to read all four to learn what to do first.
"কী পাওয়া গেল" is one list, ordered by severity and, within errors, by how
many periods are missing.

**Severity is a word before it is a colour.** "ঠিক করা দরকার" / "সতর্কতা" /
"তথ্য" appear in the accessible name of every row; the left rail reinforces
them. §14 forbids conveying a warning by colour alone, and a red rail is
invisible to a screen reader and to anyone who cannot separate it from the
amber one. The three rails resolve to real tokens in both themes —
`#B3392C`/`#E88C80`, `#7C5C1B`/`#D0A64B`, `#38586B`/`#98B2C1`.

**A warning does not read as a failure.** A school whose only findings are
optional gaps is told "কোনোটিই রুটিন ব্যবহারে বাধা দেয় না" — because §4's
whole point is that an optional gap must not send a school off to do an
afternoon of data entry before it has seen anything work.

**A calm success state, that still admits what it did not check.** Nothing
wrong gives a success note; the `info` rows stay, because "০ সমস্যা" means
"০ of the rules we ran" and naming the unrun ones is what makes the clean
report believable.

**The drawer is the component's, not a copy.** `openDrawer` owns the dialog
role, the focus trap and the return of focus to the row that opened it.
Sections in fixed order: কারণ → বর্তমান অবস্থা → প্রভাব → সম্ভাব্য সমাধান.
Where nothing can honestly be suggested it says so rather than rendering an
empty heading. Every sentence in it is the server's — a browser-side rewrite
is how a claim drifts away from the evidence that justified it.

**The whole row is the control**, so it is one tap target on a phone and one
tab stop for a keyboard, rather than a line of text with a small link at the
end of it.

**Responsive**: list and open drawer verified at 360, 375, 390, 640, 768,
1024, 1280, 1440 and 1600 — no horizontal overflow at any width, no tap
target under 44px, no uuid, no snake_case, no `undefined`, and no Latin
numeral before a Bangla counter.

**Volume**: an over-subscribed 80-section school produced 1,516 findings.
Grouping is server-side; the view keeps a 25-per-severity cap as a backstop
against a category nobody has grouped yet, with the remainder named as a
count rather than dropped.

## P9-5 — routine editor: lock and undo (2026-09-07)

No new screen. `routine-editor-view.ts` gained a lock control, an undo bar and
a leave guard, on the canonical components (`button`, `buttonRow`,
`confirmOverlay`, `openDrawer`, `announce`).

**A locked lesson is selectable.** The first version refused the selection —
reasonable, since a pinned lesson cannot be moved — which meant its action bar
never opened and the only control that could unlock it was unreachable. A lock
must not be a one-way door.

**The lock is a WORD.** The cell carries "🔒 পিন করা", the accessible name
carries "পিন করা — আবার রুটিন তৈরি করলে এটি বদলাবে না", and the action bar
explains the consequence in full. The padlock and the background tint are
reinforcements: a glyph says nothing to a screen reader, and the consequence —
a later solver run leaves this alone — is the part that matters and cannot be
drawn. Verified distinct in both themes (light `#FFFFFF` vs `#E9E3D4`, dark
`#241E1A` vs `#302821`).

**"পিন খুলুন", not "পিন সরান".** The action row already had a "সরান" that
deletes the lesson. Two controls a scanning eye reads as the same word is how
a coordinator deletes a class they meant to unlock.

**Undo names what it will reverse** — "ফিরিয়ে নিন — ষষ্ঠ-ক · বাংলা · রবি ১
নম্বর পিরিয়ড" — because "undo" alone asks a coordinator to remember the thing
they are pressing it because they cannot. A deeper stack says how much further
back it goes. An empty stack shows the control DISABLED rather than absent: a
control that appears only sometimes is one people hunt for, and its absence
reads as a bug.

**Leaving with an open lesson form asks first.** `ShellRoute.guardLeave` is the
hook; blocking puts the address bar back, because the hash changes before the
shell hears about it.

**Responsive**: verified at 360, 375, 390, 640, 768, 1024, 1280, 1440 and 1600
with a lesson selected, so the action bar and lock control are on screen — no
horizontal overflow at any width (the grid scrolls inside its own
`table-scroll`, as §11 intends), no tap target under 44px.

**Localisation**: the period column rendered raw `HH:MM` from the API, putting
Latin clock times in the one always-visible column of a Bangla timetable. It
uses `formatTime(…, 'bn')`, which is the project's convention and was simply
not being called here.

## P9-6 — scoped re-solve from the editor (2026-09-07)

No new screen. `routine-editor-view.ts` gained one control and one drawer, on
the canonical components (`openDrawer`, `field`, `button`, `setBusy`,
`sectionHeading`, `announce`).

**"আবার হিসাব করুন" sits beside undo**, and is available whenever the routine
is editable — recalculating a part is not a recovery action, it is the
ordinary response to a change in the school, and hiding it behind having
edited first would be the wrong mental model.

**The scopes offered follow what is on screen.** This section always; the
selected lesson's teacher and day when one is held. "Any teacher in the
school" would be a picker for a question nobody asks from this screen.

**Apply is disabled until a preview has been read.** §17's shape exactly:
changing a school's timetable takes a deliberate second act. The preview says
"এখনো কিছুই বদলানো হয়নি" in the same panel as the before/after list, so the
two facts cannot be separated.

**Every count carries the word that says what it counts** — "প্রভাবিত ক্লাস:
২৯টি", "পিন করা — অক্ষত: ১টি". "৭ / ২৯ / ২" makes a coordinator guess.

**আগে and পরে, per moved lesson**, as full sentences: "নবম-ক · গণিত · রফিক
স্যার · রবি ১ নম্বর পিরিয়ড" → "… সোম ২ নম্বর পিরিয়ড". Capped at twelve with
the remainder counted, because a scoped re-solve that moved forty lessons is
one nobody reads line by line.

**The moved cells are marked afterwards** with an inset outline AND
", এইমাত্র সরানো হয়েছে" in the accessible name — §22 forbids state that is
only a colour. The mark clears on the coordinator's next action rather than
on a timer: a highlight that vanishes while somebody is still reading is
worse than none.

**Responsive**: verified at 360, 375, 390, 640, 768, 1024, 1280, 1440 and
1600, and separately at a REAL 375px viewport where the drawer is exactly
375 wide with no overflow and no horizontal body scroll. The earlier
forced-`body.width` reading showed the dialog as over-wide, which was an
artifact of a fixed-position element sizing itself to the real viewport —
worth recording, because the same artifact will mislead the next person who
measures a dialog that way.

**Both themes**: dialog `#FFFFFF` / `#241E1A`, body text `#53443D` /
`#EDE7DA`.


## P9-7 — routine review and publish (2026-09-07)

`#/routinepublish` — `apps/pwa/src/routine-publish-view.ts`. One card per
shift, newest version first.

**The screen reports; the server decides.** `canPublish`, the blockers, the
warnings, the card's one-line verdict and the confirmation's paragraph are
all composed by `services/rms-svc` and rendered here. That follows the rule
P9-3's generate screen states about its own verdict — a browser that
assembles a sentence from the counters printed beside it drifts from them the
first time either changes — and it matters most on the only irreversible
button in the workstream. The publish button is still disabled when there are
blockers, but as a courtesy: §3 says the UI is not authoritative.

**The confirmation names the consequence, not the action.** "আপনি কি
নিশ্চিত?" carries no information and teaches people to click through. This
one says how many lessons, who will see them ("শিক্ষক, শিক্ষার্থী ও অভিভাবক
সবাই"), which live version it replaces, every warning being accepted
("মেনে নেওয়া হচ্ছে: …"), and that it cannot be edited afterwards. It is
`role="alertdialog"`, not dismissible by clicking away, danger-styled, and
**focus starts on বাতিল**.

**Two decisions kept apart.** "পর্যালোচনার জন্য পাঠান" hands the draft to the
head; "প্রকাশ করুন" makes it real. Neither is required — in most Bangladeshi
schools one person does both — but a school where the coordinator builds and
the head signs off now has somewhere to do it.

**Every count carries the word that says what it counts.** "৫৬০ / ২০ / ২৩"
makes a reader guess. Hard conflicts are shown even at zero: a head who reads
"০টি" has been told, whereas an absent row leaves them to assume.

**A live routine is not described as broken.** Found in the browser against
the real API: immediately after publishing, the card showed
"যা ঠিক করতে হবে — এই রুটিন আগেই প্রকাশিত।" That blocker exists so the
endpoint refuses a *second* publish. Blockers are no longer drawn for a
published routine; the warnings stay, because what it carries is still worth
reading after it goes live.

**Offline is explained, not hidden.** Publishing cannot be queued, so the
action is disabled with the reason in a sentence — a coordinator who cannot
find the button concludes the feature is broken.

**Dates use the product's own formatters.** `Intl.DateTimeFormat('bn-BD')`
produced "৭ সেপ্টেম্বর, ২০২৬ এ ১০:৩৮ AM" — a Latin meridiem inside a Bangla
sentence. `formatDayMonth` + `formatTime` write the 24-hour clock Bangla
uses. The API also had to start emitting real ISO 8601: Postgres renders a
timestamptz with a two-digit offset (`+00`), which Chrome's `new Date()`
refuses, so every timestamp had been printing as an em-dash.

**Responsive**: no horizontal overflow at a real 375px viewport, where the
confirmation is exactly 375 wide.

**Both themes**: card `#FFFFFF` / `#241E1A`, body text `#53443D` / `#EDE7DA`.

## B-108 — replacing a live routine, and the numerals (2026-09-07)

### The generate screen says what will NOT change

When a routine is live, `#/routinegenerate` leads with **বর্তমানে চালু রুটিন**
— the shift, the version, the period count, and "শিক্ষক ও শিক্ষার্থীরা এটিই
দেখছেন" — followed by "নতুন খসড়া তৈরি করলে এই রুটিনটি বদলাবে না। নতুনটি প্রকাশ
করার পরেই কেবল এটি বাতিল হবে।"

It sits ABOVE the button, because the misunderstanding it prevents happens at
the moment of pressing. A coordinator who believes Generate rewrites the live
timetable will not press it at all; one who believes it does not, when it
does, has already broken three thousand people's week.

The button relabels to **নতুন খসড়া তৈরি করুন**, and the idempotency note below
it changes with the situation — "আবার চাপলে নতুন রুটিন তৈরি হবে না" is true of
a draft and false once something is live, where a press really does make a new
version.

### One choice, in the school's own words

**কোথা থেকে শুরু** offers the two baselines as sentences rather than jargon:
"চালু রুটিনটি নকল করে — তারপর যেটুকু দরকার বদলাব" (default) and "একদম নতুন করে
— এখনকার শিক্ষক ও বিষয়ের তালিকা থেকে", each with what happens to pinned
lessons stated before the button, not after.

The result then says where the lessons came from: "সংস্করণ ১ থেকে ৫৬০টি ক্লাস
কপি করা হয়েছে — পিন করা ক্লাসসহ। চালু রুটিনটি অপরিবর্তিত আছে।" Without it a
coordinator opens a draft they have never edited and finds five hundred
placements in it.

### A retired version is history, not work

B-108 made `superseded` reachable, and the review screen's guards had been
written when only draft and active existed. A superseded routine was offered
**প্রকাশ করুন** and **সম্পাদনা করুন** — one would 409, the other opens an editor
that refuses every write — and carried "যা ঠিক করতে হবে — এই রুটিন আগেই
প্রকাশিত", which is the defect P9-7 fixed for the published card in the state
that did not exist yet. Actions are now gated on *editable*; findings are
shown for a draft, warnings only for the live routine, and neither for a
retired one. Superseded versions are excluded from the publish screen
altogether.

### The numerals

Bangla digits no longer render in Hind Siliguri, where **১ is close enough to
৮** that "১০টি" reads as "৮০টি". A `unicode-range` face over U+09E6–U+09EF
moves the ten digits to the device's own Bangla face and leaves every letter
on Hind Siliguri — verified by measurement (digits 186.76 → 218.41 px, letters
101.67 → 101.67 px) rather than by eye alone.

Read on screen across all nine cases: single digit `৫টি`; two digits `২৩ জন ·
১০টি · ৬০টি · ২০টি`; three digits `৫৬০টি · ২০৬টি · ১২৯টি`; every digit `০ ১ ২
৩ ৪ ৫ ৬ ৭ ৮ ৯`; time `সকাল ১০:৪৫ — দুপুর ১২:৩০`; date `৭ সেপ্টেম্বর ২০২৬`;
money `৳ ১২,৫০০.৭৫`; percentage `৯২.৫%`; and inside a sentence, `১০টি বিষয়ের
কিছু পিরিয়ড বসানো যায়নি।` The counter words (টি, জন, বিষয়ের) beside them are
still Hind Siliguri.

**Accessibility**: the digits are real text nodes — not CSS `content`, not
images — so they are selectable, copyable and announced; every stat pairs a
label with its value in reading order ("মোট ক্লাস ৫৬০টি"); and every finding
row carries words, so nothing depends on colour. The face is presentational
and cannot change an accessible name, because the characters are identical.

## P9-8 — the published routine, for whoever is reading it (2026-09-07)

`#/timetable` — `apps/pwa/src/timetable-view.ts`. One screen and one grid for
all eight audiences, because there is one routine.

**The picker is the server's list.** `offered` comes back with the scopes this
caller may ask for, built from the same helpers the filters are gated by. A
menu assembled in the browser from `auth.role` would be a second opinion about
permission, and the first time the two disagreed a person would be handed a
view that 403s. A test walks every offered scope and asserts the server
answers it.

**One reader with one thing to look at gets no picker.** A student has exactly
one timetable, so the select is not drawn — a control with one option does
nothing.

**One grid per shift.** Morning period 8 and day period 1 are different hours
with the same number, so a single table keyed on period number would put them
in one row. A two-shift school gets two grids, each with its own bell times.

**Density instead of a second component.** A section's cell holds one lesson;
the institution's holds twenty. Every cell holds a LIST, prints the first
three and counts the rest ("আরও ১৭টি"), so the same grid reads sensibly
whether it is one child's Tuesday or a whole school's.

**Each cell says only what the reader does not already know.** A teacher's own
grid does not repeat the teacher in every cell; a section's does not repeat the
section. The accessible name carries all of it plus the day and clock time,
because a screen reader moving cell by cell has no other way to know where it
is: "রবিবার, ১ নম্বর পিরিয়ড, ০৯:০০ থেকে ০৯:৪৫, গণিত, রফিক স্যার, ১০১ নম্বর
কক্ষ".

**Reflow, not a squeeze.** The grid scrolls inside `.table-scroll` — the same
container the P9-5 editor uses — so at 360px the page itself never scrolls
sideways. Verified at 360 · 375 · 390 · 640 · 768 · 1024 · 1280 · 1440 · 1600:
`document.body.scrollWidth` never exceeds the viewport.

**Nothing published is a state, not a failure.** A school in its first week
meets it, and it offers the way to `#/routinepublish` rather than looking
broken.

**Numerals.** `--font-bn-num` on the two elements whose whole content is a
figure — the period number and the clock time. The clock time got its own
class rather than reusing `.routine-slot-meta`, which also carries teacher and
room NAMES: the token names Noto first for the whole element, so on a mixed
element it would move the letters too. Everything else is covered by B-108's
`unicode-range` face, which reaches digits inside sentences that no selector
can.

**Both themes**: card `#FFFFFF` / `#241E1A`, cell `#E9E3D4` / `#302821`, text
`#53443D` / `#EDE7DA`.

## P9-9 — printing the routine (2026-09-07)

The action lives with the routine it prints. A coordinator looking at ষষ্ঠ-ক's
week and wanting it on the noticeboard should not have to go and find it again
on a documents screen, so **ছাপুন** sits under the summary on `#/timetable`.

    রুটিন দেখুন → ছাপুন → পূর্বরূপ → ছাপুন

**The preview IS the print.** The document is fetched with `authedFetch` (so
it travels with the caller's token — an iframe pointed at the endpoint URL
would send no Authorization header) and rendered into a sandboxed `srcdoc`
iframe. `contentWindow.print()` then prints exactly what is on screen, so the
preview cannot drift from the output. Same mechanism as নথি ও ছাপা,
deliberately: a second print path is a second one to get wrong.

`sandbox="allow-same-origin allow-modals"` — **`allow-scripts` is absent**.
The document is server-generated markup in which every interpolated value is
escaped, and with no script permission nothing in it can execute even if that
escaping were ever wrong. `allow-same-origin` is granted because the parent
calls `print()` on the frame and an opaque origin would block it.

**The published-only rule is stated, not implied**: "শুধু প্রকাশিত রুটিন ছাপা
যায় — খসড়া বা পর্যালোচনায় থাকা রুটিন নয়।" Otherwise a coordinator who has
just edited a draft wonders why it is not on the sheet.

**Print is unreachable until there is something to print** — the button is
disabled while the sheet is being built, because a print button that fires on
an empty frame opens a blank-page dialogue.

**When the app itself is printed** (someone pressing Ctrl+P on the screen
rather than the preview's button) `@media print { body > .shell { display:
none } }` prints nothing: the shell, the tab bar and a scaled-down iframe are
not a document. That rule predates P9-9 and is what §12 asks for.

**Responsive**: verified at 360 · 375 · 390 · 640 · 768 · 1024 · 1280 · 1440 ·
1600 with the drawer open — no page overflow, the drawer fits, and the print
button is reachable at 360.

**Accessibility**: `role="dialog"`, `aria-labelledby`, focus moves into the
drawer on open, every control labelled in words, and the failure path is a
sentence with `role="status"` rather than a colour.


## The printed routine — design decisions (P9-9, 2026-09-07)

The sheet is a DOCUMENT, not a screenshot of the screen, and the two are kept
apart on purpose. What the screen shares with it are the two things that are
about correctness rather than paper: the period ordinal counts TAUGHT hours
(not `period_no`, which is a position in the day that tiffin also occupies),
and the clock is 12-hour with the part of the day — `দুপুর ১:৩০–২:১৫` — because
`১৩:৩০` printed directly under a period ordinal is read as a period number.

**Reading order, by weight.** Class (the title) → section chip → subject →
teacher → clock. Five steps, five weights, so a reader lands on the level they
want without reading the ones above it.

**Sections.** Each gets a bordered chip of fixed width, so the keys align into
a column the eye runs down, plus one of eight near-neutral tints. Tint is the
FOURTH signal — after the chip, its border and the dotted rule between lines —
because tint is what a photocopier loses first. A page whose section labels are
all short uses them as keys; one long label keys the whole page by numeral and
prints a legend above the grid with every name in full. Nothing is ever
truncated: there is no `text-overflow` and no `line-clamp` in this CSS.

**Breaks.** A band across the full width of the grid, ruled top and bottom.
`period_kind` has seven values and a school's তিফিন, সমাবেশ and জোহর are rows
of the day, not gaps in it.

**Paper.** Landscape A4 for institution/class/group/stream (a cell carries one
line per section), portrait for section/teacher/room/student (one lesson a
cell, which has room for a second line). `board=1` is the notice-board sheet:
the same grid, larger type, and a page cap that knows a 22% larger face costs
45% more page. Verified by rasterisation, not by computed style — one document
page is one sheet of A4 on all 24 sheets measured.
