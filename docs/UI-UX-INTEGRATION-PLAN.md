# UI/UX integration plan — Ata Ekta into the functional `/app`

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
| **P7** | **Platform console** (`/platform`), platform-branded | tag `ui-p7` |
| **P8** | Cleanup: delete `--c-*` at zero usage, retire dead CSS, re-measure budget | tag `ui-p8` |

**Rollback:** every phase is its own commit range behind a tag; `git revert` of
a phase restores the previous UI without touching data, API or schema —
guaranteed because none of those change.

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

## 21. P1 — delivered (2026-09-01)

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
