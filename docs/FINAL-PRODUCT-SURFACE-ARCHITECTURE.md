# Final product surface & navigation architecture

**Status: SPECIFICATION ONLY. No application code, routing, database, API,
`design.html`, `app.css` or deployment changed by this document.**

This is the settled answer to *"what surfaces does shikhonBD have, who reaches
each one, and what does each look like"*. It sits above
[UI-UX-INTEGRATION-PLAN.md](UI-UX-INTEGRATION-PLAN.md), which is the *how* of
the visual migration; this document is the *what and where*.

**Production domain is `sikhon.systems`** (live since 2026-08-31). See §14 for a
naming inconsistency this audit found and how it is resolved.

---

## 0. Three findings that shaped this document

Established by reading the code, not by assumption:

1. **The subdomain resolver is already domain-agnostic and already safe.**
   `tenantKeyFromHost()` in `apps/pwa/src/branding.ts` works on label count, not
   a hardcoded domain, so `monipur.sikhon.systems → monipur` needs **no code
   change**. It already reserves `www`, `app`, `platform`, `api`, `staging`,
   `localhost` — so **`platform.sikhon.systems` can never be mistaken for a
   tenant**. The preferred architecture in §3 is therefore already defended.

2. **The demo is genuinely isolated, and has no address.** `demo.ts` states and
   the code confirms: *"no request ever leaves the device, and nothing here can
   touch real tenant data."* All seven roles exist as sample data. But there is
   **no `/demo` route** — the marketing CTA points at `/app`, and `/app` falls
   into demo mode **implicitly whenever nobody is logged in**. That conflation
   is an architectural defect, addressed in §2.

3. **The domain name drifted.** `shikhonbd.com` is still written into source
   comments, two operator-facing Bangla strings, the marketing footer's contact
   address, and the default VAPID subject — while production serves
   `sikhon.systems`. No *logic* depends on it; the drift is in prose and
   defaults. Resolution in §14.

---

## 1. Public platform website

| | |
|---|---|
| **Address** | `https://sikhon.systems/` |
| **File** | `apps/pwa/public/index.html` |
| **Brand** | **shikhonBD / eShikhon** — platform-branded (D11) |
| **Visual** | Keeps its existing light, polished marketing design. It is already Ata Ekta-aligned and is **not** part of the P0–P8 migration |
| **Auth** | none — fully public |

### Navigation

| Item | Target |
|---|---|
| হোম / Home | `/` |
| ফিচার / Features | `/#features` |
| প্রতিষ্ঠান / Institutions · Solutions | `/#institutions` |
| মূল্য / Pricing | `/#pricing` |
| যোগাযোগ / About · Contact | `/#contact` |
| **বিনা মূল্যে ডেমো** (primary CTA) | **`/demo`** (§2) — today it points at `/app` |
| **লগইন / Access** | `/app` (tenant door, §5) |

**The Platform Admin console is never a public navigation destination.** No
link, no footer entry, no sitemap presence. An operator reaches it by typing its
address. Publishing it would advertise the existence of a customer list.

---

## 2. Free demo

| | |
|---|---|
| **Address** | **`/demo`** — new, dedicated |
| **Brand** | tenant-style (it demonstrates the tenant app) with a persistent **`ডেমো পরিবেশ` / Demo Environment** marker |
| **Data** | `demo.ts` only — client-side; never leaves the device |
| **Visual** | the **final Ata Ekta tenant UX**, not the current legacy look |

### The defect this fixes

Today `demoMode` is:

```
params.get('demo') === '1'  ||  (!cachedOtpLogin() && !realAuth.isLoggedIn())
```

The second clause means **a real tenant user who is simply logged out lands in
demo mode**, seeing fabricated students under their own school's door. That is
confusing at best and, on a shared staffroom device, misleading.

### Target model

| Route | Behaviour |
|---|---|
| `/demo` | Demo **explicitly**. Sample data, role switcher across all five roles, persistent "Demo Environment" banner |
| `/app` (logged out) | The **login screen** for the resolved tenant — never demo |
| `/app?demo=1` | Retained for development/preview only |

- Demo must never call a tenant API, never accept a real login, never write.
- Demo roles offered: **Principal, IT Admin, Teacher, Student, Guardian**
  (`demo.ts` already carries all seven, including `school_owner` and
  `accountant`).
- Demo is a **P3–P5 beneficiary**: it renders the same components as the real
  app, so it becomes polished automatically as roles migrate. It needs no
  separate design.

---

## 3. Platform Admin console

| | |
|---|---|
| **Preferred address** | **`https://platform.sikhon.systems/`** |
| **Compatibility address** | `https://sikhon.systems/platform` — retained |
| **File** | `apps/pwa/public/platform.html` + `platform.js` + `platform.css` |
| **Brand** | **shikhonBD / eShikhon — never white-labelled** (D11) |
| **Access** | Platform Super Admin only |

### Why the subdomain is safe today

`platform` is already in `NOT_A_TENANT`, so `platform.sikhon.systems` resolves
to no tenant. Moving the console to its own subdomain requires **DNS + a Caddy
block only** — no application change. It is independent of the wildcard tenant
DNS in §5 and can ship first.

### Three credentials, all required (unchanged)

1. A **`super_admin` JWT** — tenant roles (`principal`, `it_admin`,
   `school_owner`) are rejected even though they are the most powerful roles a
   *school* has.
2. **`PLATFORM_API_KEY`** — a second factor from the environment, timing-safe
   compared, typed into the operator's own session, never persisted.
3. **`PLATFORM_DATABASE_URL`** — a *different database role* from the tenant
   runtime. Unset ⇒ the service answers 503 rather than falling back.

A wrong key and a wrong token return the **same** answer, so an attacker learns
nothing about which failed.

---

## 4. Platform Admin responsibilities

Per the R-7 onboarding specification, through the console UI with **no SQL**:

| Group | Capabilities |
|---|---|
| **Create** | create institution · select institution type (School / College / Madrasa / School & College) · provision tenant |
| **Commercial** | configure plan · student cap · trial end |
| **Identity** | configure institution branding (name, logo, colour) |
| **Academic** | academic year · classes · groups/streams · sections · subjects |
| **People** | import teachers · import students · link guardians · create Principal · create IT Admin · issue activation codes |
| **Lifecycle** | activate · suspend · reactivate institution |
| **Observe** | inspect provisioning state · institution health · student count · usage |
| **Future** | manage tenant domains (§5) |

Two safety behaviours that must survive the P7 redesign:

- **Existing-account confirmation** — entering a number that already belongs to
  someone names the person, their current role, and the role change, and
  requires an explicit confirm (R-8 §9A).
- **Cap refusal** — an import that would exceed the student cap is refused
  whole, in localised Bangla, with nothing partially written.

The console shows **counts and timestamps, never student-level PII**. A platform
operator browsing pupil records is precisely what tenant isolation exists to
prevent.

---

## 5. Tenant application & URL strategy

| | |
|---|---|
| **Compatibility door** | `https://sikhon.systems/app?tid=<tenant-id>` — **works today, stays** |
| **Preferred door** | `https://<tenant-slug>.sikhon.systems/` |
| **Examples** | `monipur.sikhon.systems` · `mohammadpur.sikhon.systems` |
| **Brand** | the **institution's** identity (D11) |

### Resolution order (already implemented)

1. **`?tid=`** — highest priority. It is printed on admission slips and baked
   into installed PWAs' `start_url`; a subdomain that overrode it would break
   every device already in a school's hands.
2. **Subdomain label** — `tenantKeyFromHost()`, reserved labels excluded.
3. **Slug typed once** on the login screen; the device remembers it.

**No school-picker, at any stage (D12).** A dropdown would enumerate the
customer list to anyone loading the login page.

### What subdomains still need

Not code — **deployment**: a wildcard `*.sikhon.systems` A record, a wildcard
TLS certificate, and a Caddy block. `WILDCARD_DNS_READY` stays **off** until a
browser has actually loaded a tenant subdomain over HTTPS; while off, the
console shows the subdomain as *এখনো চালু হয়নি* and presents the `?tid=` install
link as the address to print. That honesty mechanism stays.

---

## 6. Login strategy

**One login component, three contexts.** The tenant is established *before* the
form is shown.

| Surface | Tenant context from | Screen |
|---|---|---|
| `<slug>.sikhon.systems` | hostname label | tenant-branded login; school's name and colour before anyone signs in |
| `/app?tid=<uuid>` | query parameter | identical |
| `/app` with a remembered device | `localStorage` | identical |
| `/app` with nothing | — | ask for the **slug once**, then remember. Never a picker |
| `platform.sikhon.systems` | n/a | **separate** operator sign-in: `super_admin` JWT + `PLATFORM_API_KEY` |

- The marketing site (`/`) is **never** confused with the console: no link, no
  shared route, a different brand, a different credential set.
- Tenant login methods: **activation code** (works today) and **OTP** (gated on
  `OTP_SENDING_ENABLED`, awaiting an SMS aggregator). The activation door is
  always offered on the phone step.
- A tenant Principal or IT Admin **cannot reach or enumerate** platform tenants
  — enforced by role check, by `PLATFORM_API_KEY`, and by a separate database
  role (§13).

---

## 7. Role architecture

**One tenant application, role-scoped. Not five websites.** Navigation is
derived from the **existing** server-side permission model
(`dashboardFor(role)` in `app.ts` + `requireRole`/`requireStaff` + RLS). No new
permissions are assumed here.

| Role | Reaches |
|---|---|
| **Principal** / `school_owner` | institution overview · student & teacher statistics · attendance · academic structure · notices · calendar · results · finance · reports · documents · settings |
| **IT Admin** | users · teachers · students · guardians · academic structure · imports · assignments · branding · settings · audit |
| **Teacher** | assigned sections · attendance · class information · assignments & results where authorised · notices · calendar · notifications |
| **Student** | own profile · classes · attendance · assignments · results · notices · notifications · documents |
| **Guardian** | linked children · attendance · results · fees · notices · notifications · documents |
| `accountant` | fees · ledger · invoices · students · documents |
| `academic_coordinator` | academic structure · routine · students · calendar |

**Rule:** the UI never offers a destination the server would refuse. A teacher
sees no "create class"; an IT admin sees no "take attendance" — an IT admin has
no class, so the card would be an invitation to a 403.

---

## 8. Desktop architecture (≥1024px)

Persistent sidebar, real content width, real tables.

```
.d-shell
├── .d-sidebar (240px, own scroll)
│   ├── .d-brand            tenant logo + name        ← tenant identity
│   ├── .d-nav-scroll       grouped nav (.d-nav-group-label + .dnav)
│   └── .d-sidebar-profile  avatar · name · role · logout
└── .d-main (scrolls)
    ├── .d-topbar   .d-title + .d-sub | .d-actions (bell, actions, profile)
    ├── breadcrumbs where hierarchy is real
    └── content     max-width 1200px, centred
```

- Sidebar persistent ≥1280px; **icons-only** 1024–1279px.
- Page title/subtitle come from the **existing** route registry (`titleBn` /
  `subtitleBn`) — no new data.
- Tables (`.dtable`) where rows are compared; cards where items are entered.
- Contextual actions: ≤2 primary plus overflow.

## 9. Mobile architecture (<1024px)

**Deliberate mobile, not a shrunk desktop.**

- **Top header**: tenant logo + name, notification bell, role, logout.
- **Bottom navigation**: max 5 — 4 role routes + আরও (More), already the rule
  in `shell.ts` via `hidden?: boolean`.
- **Drawers / bottom sheets** for filters, pickers and the guardian's child
  switcher — anything that is a *choice*, not a destination.
- **Mobile lists replace wide tables** (`DataTable → MobileList` below 1024).
- Touch targets **≥48px** (`--tap-min`, already defined and used 41 times).
- Compact cards, simplified actions, **no horizontal overflow at any width**.
- Tablets (640–1023) keep the bottom nav — a 768px tablet is held in hand.

Breakpoints: **mobile <640 · tablet 640–1023 · desktop 1024–1439 · large ≥1440**
(from the integration plan; unchanged — no new evidence requires a change).

---

## 10. Platform vs tenant brand (D11)

| Surface | Brand |
|---|---|
| `/` marketing | **shikhonBD / eShikhon** |
| `/demo` | tenant-style + "Demo Environment" marker |
| `platform.sikhon.systems`, `/platform` | **shikhonBD / eShikhon** |
| `<slug>.sikhon.systems`, `/app` | **the institution's identity** |
| `/design` | tenant-style (it prototypes tenant screens) |

Tenant-generated artefacts — receipts, reports, certificates, notices,
notifications, push payloads, PWA identity, favicon, watermark — all carry the
**school's** identity. Never the platform's.

Enforced in **both directions** by the existing three-way brand guard in
`.github/workflows/frontend.yml`: tenant surfaces must not gain `ShikhonBD`,
platform surfaces must not lose it.

---

## 11. Canonical design rule (permanent)

> **`/design` is the visual reference and prototype. `/app` is the real
> production implementation.** The visual language is canonical: no newly
> created page may invent an unrelated style.

Every new screen — tenant, demo, or platform console — reuses the canonical
tokens, typography, colours, spacing, radius, shadows, buttons, inputs, cards,
navigation, status states, desktop shell and mobile shell.

**The dark/green legacy look is not the target.** The final tenant application
is **light-first**, on the warm Ata Ekta ground (`--color-surface: #F1EFE6`),
with the WCAG-corrected primary (`#D23B2E`, replacing the `#e53935` that sits at
3.9:1). If dark mode is retained it is an **optional Ata Ekta-compatible dark
palette** — never the legacy palette (see the integration plan §8, which
recommends keeping dark mode as an explicit user preference and authoring a
proper dark palette in P0).

---

## 12. Surface routing model

| Route | Serves | Brand | Auth |
|---|---|---|---|
| `/` | public marketing website | platform | none |
| `/demo` | safe demo environment (**new**) | tenant-style + marker | none |
| `/app` | tenant application (compatibility door) | tenant | tenant login |
| `/app?tid=<uuid>` | tenant application, explicit tenant | tenant | tenant login |
| `<slug>.sikhon.systems` | **preferred** tenant door | tenant | tenant login |
| `/platform` | platform console (compatibility) | platform | super_admin + key |
| `platform.sikhon.systems` | **preferred** platform door | platform | super_admin + key |
| `/design` | design reference — **development only** | tenant-style | none |
| `/offline` | offline fallback | tenant | none |
| `/api/v1/**` | the API | — | per endpoint |

`/design` is **not** exposed as a customer product: not linked from marketing,
not in the manifest, not in the service worker's app scope, and asserted as a
static prototype by `surfaces.test.ts`.

---

## 13. Security boundaries

| Boundary | Enforcement |
|---|---|
| Tenant ↔ tenant | PostgreSQL RLS (227 policies); `shikhon_app` is non-superuser, non-BYPASSRLS; with no tenant context set it sees **0 rows** |
| Tenant → platform | `super_admin`-only role check **+** `PLATFORM_API_KEY` **+** a separate `PLATFORM_DATABASE_URL` role. A tenant token gets the same refusal as a bad key |
| Platform → student PII | the console reads **counts and timestamps only** |
| Demo → production | demo is client-side; no request leaves the device |
| Marketing → app | no shared session, no shared credential |
| Service key | off in production unless switched on; refused from a browser; fingerprint-audited; rotatable |
| Cross-surface | CORS allowlist (`ALLOWED_ORIGINS`), `Vary: Origin`, credentials never allowed |
| Enumeration | no school-picker; `app.public_branding()` answers only exact keys and returns defaults for unknown ones |

Verified live by `scripts/security-probe.mjs` — 29 checks across 12 areas.
Re-run it after any surface change.

---

## 14. Domain naming — resolution

`shikhonbd.com` remains written in source comments, two operator-facing Bangla
strings in `platform.ts` and `go-live.ts`, the marketing footer's contact
address, and the default VAPID subject — while production serves
`sikhon.systems`.

**No logic depends on it.** `tenantKeyFromHost()` is label-based and works on
any domain unchanged.

**Resolution:** treat `sikhon.systems` as the production domain of record.
Update the prose and defaults as a **housekeeping task inside P7** (the platform
console phase), where the operator-facing strings live — not as an urgent fix,
and not silently: the change is listed so a reader is not misled by a stale
string. `shikhonbd` remains the **brand**; `sikhon.systems` is the **address**.
The two are not required to match, and D11 governs the brand, not the domain.

---

## 15. Final navigation maps

### Public

```
sikhon.systems/
├── Home · Features · Institutions · Pricing · Contact
├── [বিনা মূল্যে ডেমো]  → /demo
└── [লগইন]             → /app
```

### Demo

```
/demo   "ডেমো পরিবেশ" banner, role switcher
├── Principal · IT Admin · Teacher · Student · Guardian
└── sample data only — no API, no writes, no real tenant
```

### Platform console

```
platform.sikhon.systems/   (shikhonBD-branded)
├── Institutions (list · health · usage)
├── Create institution → 9-step wizard
├── Plan · cap · trial
├── Branding
├── Imports (teachers · students · guardians)
├── Administrators & activation codes
├── Lifecycle (activate · suspend · reactivate)
└── Readiness / go-live
```

### Tenant application

```
<slug>.sikhon.systems/   or   /app?tid=<uuid>     (school-branded)
│
├── DESKTOP: sidebar + topbar + content
└── MOBILE:  top header + bottom nav (≤5) + sheets
│
├── Principal    home · institution · academic · students · publish ·
│                calendar · finance · documents · notices · settings · audit
├── IT Admin     home · academic · users · students · imports · branding ·
│                settings · audit
├── Teacher      home · attendance · routine · roster · marks · scripts ·
│                assignments · notices · calendar
├── Student      home · subjects · learn · assignments · results ·
│                my-attendance · fees · documents · notices
└── Guardian     home · children · attendance · results · fees ·
                 notices · calendar · documents
```

---

## 16. Relationship to the UI migration plan

This document defines **surfaces**;
[UI-UX-INTEGRATION-PLAN.md](UI-UX-INTEGRATION-PLAN.md) defines **how the visual
migration happens**. They meet as follows:

| Phase | Surface work this document adds |
|---|---|
| **P0** tokens/palette/type | none — tokens are surface-independent |
| **P1** shell | the desktop (§8) and mobile (§9) shells specified here |
| **P2** components | shared by tenant app, demo and console |
| **P3** Teacher | demo's teacher role improves for free |
| **P4** Student + Guardian | same |
| **P5** Principal + IT Admin | same |
| **P6** new screen designs | the 12 families with no prototype |
| **P7** Platform console | `platform.sikhon.systems` door · console redesign · domain-string housekeeping (§14) |
| **P8** cleanup | legacy CSS removal, budget re-measure |

**Two additions this document makes to the plan's scope**, to be folded in when
P1 begins:

1. **`/demo` as a real route** with an explicit banner, and removal of the
   implicit "logged out ⇒ demo" fallback (§2). Small, but it is a correctness
   fix, not cosmetics.
2. **`platform.sikhon.systems` as the preferred console door** — DNS + Caddy
   only; no application change, and safe today because `platform` is already a
   reserved label.

Neither changes the P0–P8 order.

---

## 17. Acceptance

Per major screen, at **1440 · 1024 · 390 · 375**, in light (and dark if
retained), for **Tenant A and Tenant B**, in **loading · empty · error ·
success** states, across all five roles — with screenshot evidence stored in the
phase's PHASE_LOG entry.

```
Public marketing   → shikhonBD-branded, light, polished, unchanged
Demo               → own route, marked, final tenant UX, isolated
Platform console   → own door, shikhonBD-branded, super_admin only
Tenant app         → school-branded, light-first Ata Ekta
Desktop            → genuinely desktop (sidebar, tables, hierarchy)
Mobile             → genuinely mobile (bottom nav, lists, sheets, no overflow)
/design            → reference only, never a customer destination
Roles              → server permission model, nothing invented
Offline            → preserved
D11                → platform and tenant brands never mixed
D13                → all states green per screen
```

---

**No implementation. This document is the target; the integration plan is the
route. P0 has not begun.**
