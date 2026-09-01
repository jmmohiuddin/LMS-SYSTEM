# PHASE LOG — canonical implementation history

**This file is the project's memory.** Decision D10 of
[11-MASTER-PLAN.md](11-MASTER-PLAN.md) makes it the one document a person or an
agent can read, start to finish, and understand everything that has happened
here — without any chat history, without asking anyone.

## How to maintain it

- **Append, never rewrite.** An entry, once written, is history.
- A phase is **not complete until its entry is written.** The entry comes before
  the "done" claim, not after.
- Also log: bug fixes, architecture decisions, migrations, test milestones,
  deployment changes, and important discoveries — not only numbered phases.
- **A decision that reverses an earlier one gets a NEW entry** stating what
  changed, why, and what replaced it. The superseded entry stays exactly as it
  was, with a pointer added to its Status line. Deleting the reasoning behind an
  abandoned approach destroys the thing a future reader needs most.
- Record unresolved problems. An honest known-limitations list is the difference
  between a log and a press release.
- Entries are chronological, newest at the bottom.

---

## CURRENT PROJECT STATUS

```text
Current Phase:        none in progress — R-7 complete, R-8 not started
Last Completed Phase: R-7 — Tenant onboarding & the platform console (no SQL to add a school)
Last Doc Phase:       R-7-DOC — the specification R-7 was built from. R-7 itself
                      is now IMPLEMENTED; the runbook stays as the manual fallback.
Surfaces:             /  marketing (shikhonBD)  ·  /app  the application
                      /design  the Ata Ekta prototype
Last Commit:          HEAD of main — `git log -1`. Notable earlier commits:
                      R-0   a2a26942fe7a503b57344ff67a827ad2a2814189
                      R-1   5265ea3e561c4d9b86649d234eca9b3f90363e30
                      RULES 96639be51ac8851e44e27592cdf3d300f5ca33e9
                      D12   4ea1541b816745db580ed1b02154338a6f695f74
Tests:                890 passing, 0 failing (node --test, verified 2026-08-29)
                      offline 46 · server-core 92 · ui-core 153 · academics-svc 111
                      identity-svc 10 · ops-svc 26 · platform-svc 25 · rms-svc 62 · sms-svc 22
                      sync-svc 23 · pwa 312 · netlify 8
                      + 24 SQL suites — EXECUTED against PostgreSQL 16, all green
                      + up → down → up clean, 0 objects left, lint 0 advisories
                      NOTE: on Windows the runner silently ran ZERO tests until R-5
                      fixed it — see the R-5 entry, "The tooling was lying".
Build:                npm run build ok · tsc ×3 exit 0 · app.js 95 KB gz / 180 KB budget
Migrations:           45 applied, 45/45 probed by scripts/migration-status.mjs
                      (R-7 added 045: the DEFINER functions that are the ONLY way
                      a tenant comes into existence, plus the student_cap trigger.
                      No new table.)
Known Blockers:       none open. No capability is "Backend complete — UI pending".
                      CLOSED in R-7: onboarding a school without SQL — plus THREE gaps
                      it exposed: nothing had ever written student_profiles (so R-6's
                      search had nothing to find), provision_tenant left no subject
                      template (so a new school could not import ONE student), and
                      student_cap had never been enforced anywhere.
                      CLOSED in R-6: global student search and the multi-year student
                      record — an old permanent ID now returns a graduated child and
                      every year they were enrolled, read from `enrolments` rather
                      than copied into a history table.
                      CLOSED in R-5: branded documents — plus the leak it exposed,
                      where a subject teacher could print a letterheaded admit card
                      or ID card for any child in the school, not just their own
                      sections, because `users_scope` ends with `OR app.is_staff()`.
                      CLOSED in R-4: the academic calendar — plus the write-scope gap
                      it exposed on calendar_days (043), where any student could have
                      declared a holiday and silenced the day's attendance SMS.

Open design question   Money prints in Latin digits (৳ 1,300.00) beside Bangla rolls
(R-5, needs a call):   and marks, because `formatBdt` is shared with SMS and invoices.
                       Consistent product-wide; still a real question. Not answered
                       silently by R-5.

Carried backlog       Recorded, not blocking, from earlier phases:
(R-3, not lost):      · class/section EDIT UI (042 permits the UPDATE; no screen)
                      · guardian unlink workflow (delete is USING(false) by design)
                      · audit viewer: export, and entity-id → name resolution
                      · POST /rms/solve stays API-only by an explicit decision
                      CLOSED in R-2-FINAL:
                        · DB-backed suites never executed — run, and they found 5 real bugs
                        · migration 038 had no probe — probed; 40/40, none unprobed
                        · auto-notice emitters not built — all three built and verified
                        · publish_at was a column nothing polled — now a real status
                          swept by the existing ops cron
                      CLOSED earlier:
                        · two front doors — R-1-A
                        · service-worker deploy staleness — R-1-A
Deferred, not blocking:
                      · SMS send is stubbed until an aggregator contract (R-8)
                      · no real-time push; the bell refreshes on navigation
                      · scripts/test-all.mjs cannot run on Windows (pre-existing)
Next Step:            R-5 — Branded print & document engine (docs/11-MASTER-PLAN.md).
                      Not started.
```

---

# 2026-08-29 · R-0 · Hygiene

| | |
|---|---|
| **Date** | 2026-08-29 |
| **Phase ID** | R-0 |
| **Phase name** | Hygiene |
| **Status** | ✅ Complete · approved by owner |
| **Migration number** | none |
| **Rollback status** | n/a — no schema change |
| **Git commit** | `a2a26942fe7a503b57344ff67a827ad2a2814189` |

### Objective

Make every later diff readable. Remove the permanent phantom-dirty state in the
working tree and correct stale counts in the status document, so that from R-1
onward a dirty file means something.

### What was already existing

- 38 migrations, ~100 tables, RLS-enforced multi-tenancy, 9 service directories,
  a framework-free PWA — the audited baseline described in
  [11-MASTER-PLAN.md](11-MASTER-PLAN.md) §2.
- `git status` reported 10 modified files under `api/v1/` **on every checkout**,
  while `git diff` showed no content change.
- No `.gitattributes` anywhere in the repository.

### What was implemented

Diagnosis first: the ten files were **byte-identical** to `HEAD` — 0 CR, 2015 LF,
71 505 bytes on both sides. `scripts/build.mjs` writes them with LF (esbuild
always emits LF); with the developer's global `core.autocrlf=true` and no rule
pinning them, Git wanted them to be CRLF in the working tree and flagged the
difference it would itself introduce.

1. **`.gitattributes`** — `* text=auto` baseline; `api/**/*.js` pinned to
   `eol=lf`; `*.sh` and `*.sql` pinned to `eol=lf`; images marked `binary`.
2. `git add --renormalize .` — staged **nothing**, confirming every committed
   text blob was already LF and no history was rewritten.
3. **`tsconfig.json`** — excluded `_design_import`.
4. **`docs/07-IMPLEMENTATION-STATUS.md`** — corrected stale counts.

### Important architectural decisions

- **Pin generated bundles to LF rather than change the developer's global Git
  config.** The repository states its own requirements; a machine-level setting
  cannot be relied on across contributors or CI.
- `*.sh` and `*.sql` were pinned for correctness, not tidiness: a CRLF shebang
  makes the kernel look for an interpreter literally named `/usr/bin/env bash\r`,
  and `psql` carries a stray CR into dollar-quoted function bodies. Both files
  run against production.

### Database changes

None.

### API changes

None.

### UI changes

None.

### Files created

- `.gitattributes`
- `docs/11-MASTER-PLAN.md` (the audited roadmap this phase opened)

### Files modified

- `tsconfig.json` — added `_design_import` to `exclude`
- `docs/07-IMPLEMENTATION-STATUS.md` — migrations 23→38, SQL suites 7→16, test line
  rewritten to what was actually measured

### Files removed

None.

### Tests added

None — this phase changed no product behaviour.

### Tests executed

Full suite as a regression baseline, run directly per workspace (see Known
limitations for why not through the usual runner).

### Test results

**354 unit tests, 0 failures** — offline 46, server-core 75, ui-core 48,
academics-svc 19, rms-svc 15, pwa 143, netlify 8. DB-backed suites in
identity-svc / ops-svc / sync-svc self-skipped (no `DATABASE_URL`).

### Build / typecheck results

- `npm run build` ok.
- The documented three-program gate (`tsc --noEmit` ×3) went from **red to green**
  — see the `_design_import` decision above.
- **The phase's own success criterion:** after a full `npm run build`,
  `git status` reports **0 dirty files**, and CI's `git diff --exit-code -- api/`
  passes.

### Security validation

`node scripts/check-secrets.mjs --history` — 114 commits, no credential material.

### Tenant-isolation validation

Not applicable — no data path was touched.

### Known limitations

- **`scripts/test-all.mjs` cannot run on Windows.** `execFileSync('npm', …)`
  raises ENOENT (needs `npm.cmd`), and the quoted glob `'test/*.test.ts'` is not
  expanded by `cmd.exe`, so workspaces report "0 tests". The first run reported
  all 10 workspaces FAILED — a false alarm. CI on ubuntu is unaffected. **Not
  fixed** (outside R-0's stated scope).
- Running `npm install` per workspace generates `package-lock.json` files that are
  not gitignored — untracked noise. The ones this phase created were removed.

### Unresolved bugs / issues

None introduced.

### Decisions that require owner input

None.

### Next recommended step

R-1 — White-label & branding foundation.

---

# 2026-08-29 · R-1 · White-label & branding foundation

| | |
|---|---|
| **Date** | 2026-08-29 |
| **Phase ID** | R-1 |
| **Phase name** | White-label & branding foundation |
| **Status** | ✅ Complete — with unexecuted DB tests, see Known limitations |
| **Migration number** | **039** — `db/migrations/039_tenant_branding.sql` |
| **Rollback status** | ✅ `db/rollback/039_tenant_branding.down.sql` — drops the function and the CHECK, **deliberately leaves `settings->'branding'` in place** so up → down → up is lossless |
| **Git commit** | `5265ea3e561c4d9b86649d234eca9b3f90363e30` |

### Objective

One deployment, many institutions, each seeing only itself — on screen, in the
browser tab, in the installed app, and on printed paper. The owner's stated
priority #1.

### What was already existing

Tenancy was enforced everywhere it mattered **for data**: `tenant_id` on ~95
tables, a generated RLS policy on every one, `FORCE ROW LEVEL SECURITY`, a
`tenant_self` policy on `tenants` itself, and a boot guard refusing to start on a
BYPASSRLS role. The `tenants` row already carried `name_bn`, `name_en`,
`address_bn`, `eiin` and an unused `settings jsonb`.

**The visible half was enforced nowhere.** `login-view.ts:98` hard-coded
`'ShikhonBD'`; `manifest.webmanifest` hard-coded one name and theme colour for
every school; `tenants.settings` was read by no code at all.

### What was implemented

- **Branding contract** (`packages/ui-core/src/branding.ts`) — 15 fields, field
  validation, colour normalisation and derivation, WCAG contrast helpers.
- **Print foundation** (`packages/ui-core/src/branded-doc.ts`) — letterhead,
  watermark layer, signature block, standalone A4 document. Foundation only;
  receipts and report cards are R-5.
- **Migration 039** — seeds branding from the tenant's own name columns, adds a
  jsonb-shape CHECK, creates `app.public_branding()`.
- **Three endpoints** — `GET/PUT /ops/branding` (authenticated),
  `GET /ops/brand` and `GET /ops/manifest` (both public, rate-limited).
- **PWA runtime** (`apps/pwa/src/branding.ts`) — applies colour tokens, title,
  favicon, theme colour and manifest link; per-tenant cache, revalidated on read.
- **Branding editor** (`apps/pwa/src/branding-view.ts`) — name, logo, favicon,
  watermark, signature, colours, contact; live preview; save / cancel; on-device
  image downscaling; read-only on 403.
- **Shell + login** — institution plate in the top bar; the school's logo (or the
  first letter of its own name) replaces the platform mark on login.
- **Two demo institutions** in `demo.ts` for side-by-side verification.

### Important architectural decisions

1. **Branding is a column, not a table.** `tenants.settings->'branding'` — exactly
   one row per tenant, always read whole, never joined, never queried by any of
   its fields. It inherits `tenant_self` and `enforce_tenant()` by being part of
   the tenant row. A separate table would have needed its own policy, grants, FK
   and a join on every read, to hold one row.
2. **Assets are inline data URLs** under per-field byte caps (logo 64 KB, favicon
   32 KB, watermark 96 KB, signature 48 KB; 320 KB total). R-1 therefore needed
   no object storage — that decision arrives with R-5's stored PDFs.
3. **One schema, two validators, no drift.** The rules live once in ui-core and
   both the editor and the API import them. The server stays the authority: it
   re-runs `parseBranding()` on every write.
4. **Colours are an allowlist, not a sanitiser** — `primaryColor` lands in a CSS
   custom property, where `red; background:url(//evil/?c=` closes the declaration
   and opens another. Uploaded assets are **raster only**: an SVG is a document
   that can carry `<script>`.
5. **The pre-auth read is bounded in SQL, not in application code.**
   `app.public_branding()` fixes seven returnable keys with an explicit allowlist,
   so a field added to the branding object later is private by default.
6. **An unknown key returns neutral defaults with 200, never 404** — a 404 would
   make the endpoint a tenant-existence oracle for anyone with a wordlist.
7. **Two colour blocks, not one.** `app.css` writes every rule against
   `--c-primary` (not `--color-primary`), and its dark block re-points
   `--c-primary-text/-ink/-link` at lighter steps. Tenant colours are emitted as
   `:root` **and** `:root[data-theme='dark']` at matching specificity.
8. **Tenants are keyed by slug *or* id** — a deviation from the master plan's
   slug-only sketch. The install link the app already uses carries `?tid=`, and a
   v4 uuid is 122 bits of entropy, strictly harder to guess than a memorable slug.

### Database changes

- Migration **039**: `CHECK (settings->'branding' is null or object)`; a seed
  `UPDATE` (re-runnable, never clobbers existing branding); new
  `app.public_branding(text)` — `STABLE`, `SECURITY DEFINER`, pinned
  `search_path`, `GRANT EXECUTE TO shikhon_app`.
- No new tables, no new columns, no data migration.
- Authenticated read/write needed **no new grant**: migration 010 already grants
  `SELECT/UPDATE` on every table in `public`, and `tenant_self` is what confines
  both to the caller's own row.

### API changes

| Route | Auth | Notes |
|---|---|---|
| `GET /api/v1/ops/branding` | JWT, any signed-in role | Full branding; every role needs the letterhead for documents |
| `PUT /api/v1/ops/branding` | JWT + `principal` / `school_owner` / `it_admin` / `academic_coordinator` | Merges over saved values, so a partial write cannot blank the rest |
| `GET /api/v1/ops/brand?slug=\|tid=` | **public**, read-bucket rate limit | Seven signboard fields |
| `GET /api/v1/ops/manifest?slug=\|tid=` | **public**, read-bucket rate limit | Per-tenant `application/manifest+json` |

No tenant id is accepted in any URL path or request body for the authenticated
routes — the only tenant a caller can name is the one they authenticated as.

### UI changes

- Login screen: institution name and logo replace the platform mark; tagline made
  generic.
- Shell: institution plate (logo + name) leads the top bar on every screen.
- New route `#/branding` — the editor. Registered for every role and hidden from
  the tab bar; the server decides who may write.
- Dashboard card for `principal` / `school_owner` (replacing the system card) and
  a More-menu entry for everyone.
- Document title, favicon, theme colour and manifest link become tenant-specific.
- `index.html` (the served design mock-up) got an inline branding bootstrap; its
  22 static brand plates were made neutral and are upgraded at runtime.
- Two marketing CTAs linking to `/landing.html` were **removed from inside the
  application** — a platform marketing link in a school's app is precisely the
  leftover platform branding this phase exists to remove. *(The landing page
  itself is untouched — see D11 and the 2026-08-29 rules entry below.)*

### Files created

```text
packages/ui-core/src/branding.ts
packages/ui-core/src/branded-doc.ts
packages/ui-core/test/branding.test.ts
packages/ui-core/test/branded-doc.test.ts
db/migrations/039_tenant_branding.sql
db/rollback/039_tenant_branding.down.sql
db/tests/tenant_branding.sql
services/ops-svc/api/branding.ts
services/ops-svc/api/brand.ts
services/ops-svc/api/manifest.ts
services/ops-svc/src/public-branding.ts
services/ops-svc/test/branding.test.ts
apps/pwa/src/branding.ts
apps/pwa/src/branding-view.ts
apps/pwa/test/branding-ui.test.ts
```

### Files modified

```text
apps/pwa/src/app.ts                   branding boot, #/branding route, dashboard card
apps/pwa/src/shell.ts                 institution plate + setInstitution()
apps/pwa/src/login-view.ts            institution identity replaces the platform mark
apps/pwa/src/demo.ts                  two demo institutions
apps/pwa/src/sw-router.ts             branding endpoints → stale-while-revalidate
apps/pwa/public/app.css               R-1 surfaces (125 lines)
apps/pwa/public/index.html            neutral defaults + inline branding bootstrap
apps/pwa/public/index.legacy.html     neutral <title>
apps/pwa/public/manifest.webmanifest  neutral fallback identity
apps/pwa/public/offline.html          neutral <title>
services/ops-svc/api/index.ts         three new routes + per-route rate buckets
packages/ui-core/src/index.ts         re-exports
packages/server-core/test/harness.ts  allow PUT in CallOptions
scripts/migration-status.mjs          probe + reason for 039
.github/workflows/frontend.yml        brand guard
.github/workflows/database.yml        tenant_branding.sql wired in
docs/07-IMPLEMENTATION-STATUS.md      §9b + counts
docs/11-MASTER-PLAN.md                R-1 marked done
api/v1/ops/[action].js                regenerated bundle (committed artifact)
```

### Files removed

None.

### Tests added

**61 new.**

- `packages/ui-core/test/branding.test.ts` — 24. Validation and, more importantly,
  refusals: CSS-injection colour strings, `javascript:` and `data:text/html` asset
  URLs, SVG, oversize assets, control characters, missing names. Plus the
  assertion that `brandingCssVars` never repaints the destructive or status
  colours.
- `packages/ui-core/test/branded-doc.test.ts` — 13. Escaping of tenant text,
  two-tenant document isolation, hostile asset URLs dropped rather than thrown on.
- `apps/pwa/test/branding-ui.test.ts` — 19. Apply, per-tenant cache, cache
  re-validation (localStorage is writable by anything on the origin), login and
  shell for two tenants.
- `services/ops-svc/test/branding.test.ts` — 5 pure (manifest identity) **plus a
  DB-backed suite**: A reads only A, B cannot overwrite A even naming A's id, a
  direct cross-tenant `UPDATE` affects zero rows, teacher read-but-not-write, the
  public endpoint's field bound.
- `db/tests/tenant_branding.sql` — SQL assertion suite, wired into
  `database.yml` (both the first pass and the idempotency re-run).

### Tests executed

Full suite per workspace; browser acceptance test driven manually.

### Test results

**415 unit tests, 0 failures** (354 before → +61):
offline 46 · server-core 75 · ui-core 85 · academics-svc 19 · **ops-svc 5** ·
rms-svc 15 · pwa 162 · netlify 8.

**Acceptance test — passed.** `?demo=1&tenant=a` and `?demo=1&tenant=b` on one
deployment, verified in a browser:

| | Tenant A | Tenant B |
|---|---|---|
| Name | শাহজালাল আদর্শ উচ্চ বিদ্যালয় | নর্থ সিটি মহিলা কলেজ |
| Primary colour | `#156a3f` | `#1b3e7a` |
| Logo | green disc | blue disc |
| Title / theme-color / favicon / manifest URL | A's | B's |
| Letterhead (address, phone, head teacher) | A's | B's |
| Any value of the other in DOM or cache | none | none |

### Build / typecheck results

`tsc --noEmit` ×3 → exit 0 · `npm run build` ok · `app.js` **74 449 bytes gz**
against the 184 320 budget · post-commit rebuild leaves **0 dirty files**.

### Security validation

- `check-secrets.mjs --history` — clean across 114 commits.
- Colour and asset validation are allowlists; every refusal case has a test.
- The public endpoint's exposure is bounded **in SQL**, not by application code
  remembering to strip fields.
- `applyBranding` writes only validated hex into the stylesheet; a test asserts
  every emitted value matches `/^#[0-9a-f]{6}$/`.
- Cached branding is re-validated on read.
- New CI guard prevents platform branding returning to tenant surfaces.

### Tenant-isolation validation

**Designed and asserted; not yet executed against a database.**

The boundary is `tenant_self` (`id = app.current_tenant()`, FORCE'd), not the
handlers. Assertions written in `db/tests/tenant_branding.sql` and
`services/ops-svc/test/branding.test.ts`: A sees exactly one tenant row; A cannot
read or write B by naming B's id; a session with no tenant context sees zero rows;
`app.public_branding()` returns no private field.

Executed locally: **none of the above** — no PostgreSQL was reachable (`psql` not
installed, Docker daemon not running). The pure/browser half ran and passed.

### Known limitations

1. **The DB-backed suites have never been run.** First CI run is their first
   execution. Until it is green, R-1's isolation guarantee is *code-complete and
   CI-pending* — the same status §9a records for Phase 0.
2. **Two front doors** — see entry `R-1-A` below.
3. **`app.js` is cache-first in the service worker and not content-hashed.** A
   deploy does not reach a returning device until `CACHE_SHELL`'s version string
   changes. Pre-existing; it made local verification misleading twice during R-1
   before it was diagnosed. `netlify.toml` sends `max-age=0, must-revalidate` for
   `/app.js`, which helps at the edge but does not override the worker's own
   cache-first decision.
4. **Migration 038 has no probe** in `scripts/migration-status.mjs` — it only
   alters columns, which the existing probe kinds cannot express, so a new
   `column` kind would be needed. 039's probe is present.
5. Colour customisation is bounded to primary + accent by design. Status colours
   and the destructive colour are not tenant-controlled.
6. A branding change does not reach an already-open tab on another device until
   it reloads; there is no push.

### Unresolved bugs / issues

None open. **Two were found by the browser acceptance test and fixed in the same
commit** — both would have shipped had verification stopped at the unit tests:

- The shell's institution plate was captured once at construction and never
  updated when the branding fetch landed, so a device's **first ever launch**
  showed the neutral placeholder. Fixed with `Shell.setInstitution()`.
- Typing in the editor repainted the preview but did not re-evaluate Save/Cancel
  or the contrast warning — a user could rename their school and watch Save stay
  greyed out. Fixed with `syncControls()`.

### Decisions that require owner input

- **R-1-A (below): which file is the real production entry point.** Blocking for
  the pilot.

### Next recommended step

R-2 — Notices & notification system.

---

# 2026-08-29 · R-1-A · Discovery: two front doors

| | |
|---|---|
| **Date** | 2026-08-29 |
| **Phase ID** | R-1-A |
| **Phase name** | Discovery — `index.html` vs `index.legacy.html` |
| **Status** | 🔴 Open at the time of writing — **superseded 2026-08-29** by the R-1-A completion entry at the end of this log, which implemented Option B. Left exactly as written (D10): this is the record of how the situation arose and what the alternatives were. |
| **Git commit** | investigated during `5265ea3`; recorded in the commit that added this file — `git log --diff-filter=A --format=%H -- docs/PHASE_LOG.md` |

### Objective

Determine which file is the true production application entry point, and record
the finding rather than "fixing" it unasked. Neither file was deleted or moved.

### Why both exist

`git log --follow` settles it. Until commit `c93bddc` (2026-08-23,
*"Add the ShikhonBD marketing landing page and rebuild the app on the Ata Ekta
design system"*), `apps/pwa/public/index.html` was the real 69-line PWA shell,
present since the initial commit.

That commit **overwrote `index.html`** with a 4 341-line design surface built on
the imported Ata Ekta system, and **copied the original shell to
`index.legacy.html`** (Git records it as an addition, not a rename, because
`index.html` continued to exist with entirely different content).

The name is misleading: `index.legacy.html` is not legacy. It is the current,
functional, tested application.

### Which one is currently served

`index.html` — the design surface.

- Vercel: `outputDirectory: apps/pwa/public`, so `/` resolves to `index.html`.
- Netlify: `netlify.toml` redirects `/*` → `/index.html` (status 200), so **every
  deep link** lands there too.
- The service worker's `app-shell` strategy falls back to the cached `'/'`, which
  is also that file.

### Which one is the real PWA

`index.legacy.html`.

| | `index.html` (served at `/`) | `index.legacy.html` |
|---|---|---|
| Lines | 4 341 | 78 |
| Loads `app.js` | **no** | yes |
| Has `<div id="root">` | **no** | yes |
| API calls | **zero** | all of them |
| Auth / session | none | full |
| Data | hard-coded samples | live, via `authedFetch` |
| Covered by the 162 PWA tests | no | yes |
| Linked from anywhere | it is the site root | **nothing links to it** |

### Is the other only a design/mock-up surface?

Yes. `index.html` contains 66 `.screen` divs of static markup with sample
students and sample marks, an inline script that swaps `.active` between them,
and no network code of any kind. It is a clickable design prototype that was
promoted to the site root.

### Consequence, stated plainly

**In production today, the functional application is reachable only by typing
`/index.legacy.html` directly.** `/` serves a prototype with fabricated data;
`/landing.html`'s call-to-action links point to `/`, i.e. to that prototype.

R-1 branded both surfaces, so neither shows the platform brand to a school — but
branding a prototype does not make it the product.

### What the intended final architecture should be

Per D11 and §1a of the master plan:

```text
/                     → marketing site (shikhonBD-branded)      ← today: mock-up
/app  or  subdomain   → tenant application (white-labelled)     ← today: /index.legacy.html
/design or removed    → the Ata Ekta prototype, if kept at all
```

Three options, for the owner to choose between:

| Option | Change | Cost | Risk |
|---|---|---|---|
| **A** | Promote the real PWA back to `/`; move the prototype to `/design.html`; point `landing.html`'s CTAs at the app | smallest — a rename and two hrefs | prototype screens stop being the first thing a visitor sees |
| **B** | Serve `landing.html` at `/` and the app at `/app`; keep the prototype at `/design.html` | medium — routing in both hosts, SW `app-shell` target, `PRECACHE` | matches D11's separation most closely |
| **C** | Rebuild the real PWA's shell to use the Ata Ekta markup, retiring `index.legacy.html` | largest — a UI rewrite | the master plan forbids rewriting the PWA architecture; would be its own phase |

**Recommendation: B**, taken as a small phase before the pilot (R-8) — it is the
only option that ends with the marketing site and the application at distinct,
correct addresses. **A** is a reasonable stopgap if a demo is needed sooner.

### Known limitations

Nothing was changed. The situation persists exactly as described.

### Decisions that require owner input

**Which option (A / B / C), and when.** Blocking for the pilot: a school cannot be
onboarded onto a URL that serves a prototype.

### Next recommended step

Owner picks an option. Until then, R-2 proceeds against `index.legacy.html`,
which is where the tested application lives.

---

# 2026-08-29 · RULES · Phase log and brand boundary made permanent

| | |
|---|---|
| **Date** | 2026-08-29 |
| **Phase ID** | RULES |
| **Phase name** | Permanent project rules — D10, D11 |
| **Status** | ✅ Complete |
| **Migration number** | none |
| **Rollback status** | n/a |
| **Git commit** | the commit that added this file. A log entry cannot quote its own hash, so it is resolved instead: `git log --diff-filter=A --format=%H -- docs/PHASE_LOG.md` |

### Objective

Turn two owner instructions into permanent, enforced project rules rather than
conventions someone has to remember.

### What was already existing

- `docs/11-MASTER-PLAN.md` carried decisions D1–D9.
- R-1 had added a CI guard that removed the platform brand from tenant surfaces —
  correct, but one-directional and undocumented as to *why* `landing.html` was
  exempt.
- No chronological project history existed anywhere. Everything about R-0 and R-1
  lived in chat transcripts and in prose scattered through `docs/07`.

### What was implemented

1. **`docs/PHASE_LOG.md`** — this file. Current-status block, maintenance rules,
   and full entries for R-0, R-1, the R-1-A discovery, and this one.
2. **D10** in the master plan — the phase log is canonical, append-only, and a
   phase is not complete until its entry is written.
3. **D11** in the master plan — `shikhonBD` is the permanent platform and
   marketing brand; white-labelling applies to tenant operational surfaces only.
4. **§1a "Surfaces"** in the master plan — a diagram of which brand belongs where,
   and a pointer to R-1-A as the open question.
5. **The CI guard was rescoped and made bidirectional** (`Brand boundary (D11)`).

### Important architectural decisions

- **The brand guard runs in both directions.** R-1's guard stopped the platform
  brand leaking into tenant screens. The likelier mistake *now* is the opposite:
  "remove ShikhonBD" reads like a rule that applies everywhere, and a future
  white-label sweep could silently un-brand the company's own website with
  nothing to catch it. The guard therefore also **fails the build if
  `landing.html` stops mentioning the platform brand.** Verified by mutation: a
  copy of the file with the brand stripped does trip it.
- **Never state the rule as "ShikhonBD must disappear."** The correct statement,
  recorded in D11: *the platform is branded, the tenant application is
  white-labelled.*

### Database changes

None.

### API changes

None.

### UI changes

None. `landing.html` was deliberately **not** touched — it keeps all 13 platform
brand references, and the new guard now protects them.

### Files created

- `docs/PHASE_LOG.md`

### Files modified

- `docs/11-MASTER-PLAN.md` — D10, D11, §1a
- `.github/workflows/frontend.yml` — `Brand boundary (D11)`, bidirectional

### Files removed

None.

### Tests added

No unit tests. The guard is a CI job and was exercised locally in both
directions, including a negative test.

### Tests executed / results

Guard: tenant surfaces clean ✅ · `landing.html` branded ✅ · mutation test (brand
stripped) correctly fails ✅. Full suite re-run to confirm no regression:
**415 passing, 0 failing.**

### Build / typecheck results

`tsc --noEmit` ×3 exit 0 · `npm run build` ok · working tree clean after rebuild.

### Security validation

Not applicable — documentation and a CI check.

### Tenant-isolation validation

Unchanged from R-1; nothing in the data path was touched.

### Known limitations

- The platform-surface allowlist currently names one file (`landing.html`).
  Future platform surfaces — the Super Admin console (R-7), public documentation,
  a pricing page — must be **added to that list when they are created**, or they
  will be branded with nothing enforcing it.
- The guard matches the literal string `ShikhonBD`. A future rename of the
  platform brand has to update it.

### Unresolved bugs / issues

None.

### Decisions that require owner input

Still open from R-1-A: which file becomes the production entry point.

### Next recommended step

**R-2 — Notices & notification system**, per the master plan. Its phase-log entry
must be written before it is marked complete.

---

# 2026-08-29 · D12 · Tenant resolution & the isolation stack, written down

| | |
|---|---|
| **Date** | 2026-08-29 |
| **Phase ID** | D12 (decision entry — no code phase) |
| **Phase name** | One deployment, many institutions: how a school reaches its door |
| **Status** | ✅ Complete (documentation + decision; mechanism itself was already built) |
| **Migration number** | none |
| **Rollback status** | n/a |
| **Git commit** | the commit that touched only docs in this entry — `git log -1 --format=%H -- docs/11-MASTER-PLAN.md docs/PHASE_LOG.md` at this entry's date |

### Objective

The owner asked how one server and one login page can serve Monipur and
Mohammadpur completely separately — different admins, teachers, students,
guardians, data, rules — and observed, correctly, that the master plan never
spelled this out. Answer the question in the plan itself, permanently.

### What was already existing

The entire mechanism. Tenant-scoped user rows, `tid` inside the signed JWT,
`withTenant()` → `SET LOCAL`, fail-closed RLS on ~95 tables, per-tenant
encryption keys, per-tenant caps, the `?tid=` install-link resolution with the
one-time slug fallback, R-1's pre-auth branded login. What did not exist was any
document a reader could point to — the design lived in migration comments,
`docs/01`, and code.

### What was implemented

Documentation only:

- **§1b in 11-MASTER-PLAN.md** — the full write-up: how a school's own link (and
  later its subdomain) routes its people to *its* login; the four isolation
  layers L1 identity → L2 API → L3 session → L4 RLS, with the per-tenant crypto
  key beneath them; how roles stay tenant-scoped; how one person in two schools
  gets two accounts joined by `global_person_id`; and the CI proof.
- **Decision D12** — tenant resolution is per-institution entry links now,
  per-tenant subdomains at R-7, custom domains later; **a school-picker dropdown
  is forbidden at every stage** because it would enumerate the customer list
  (the same reasoning that shaped `app.public_branding()`).
- **R-7 scope** — gains an explicit subdomain-resolution bullet (hostname →
  slug, wildcard DNS/cert, `?tid=` links still honoured).
- The §3 requirement map gains the row the owner's question corresponds to.

### Important architectural decisions

D12 itself (above). One nuance made explicit: the slug fallback field on the
login screen is a fallback, not the main road — the school's handed-out link is
the primary channel because it is the channel schools already use for everything
they tell guardians.

### Database changes / API changes / UI changes

None / none / none.

### Files created

None.

### Files modified

- `docs/11-MASTER-PLAN.md` — §1b, D12, R-7 bullet, §3 row
- `docs/PHASE_LOG.md` — this entry; status block now lists notable commit hashes
  explicitly (the RULES hash became knowable after its commit landed)

### Files removed

None.

### Tests added / executed / results

None added — no behaviour changed. Existing suite last verified at 415 passing,
0 failing (see R-1 and RULES entries).

### Build / typecheck results

Docs-only change; `npm run build` re-verified clean at commit time.

### Security validation

No change to any enforcement. The entry *describes* enforcement that exists and
is CI-tested.

### Tenant-isolation validation

Unchanged — §1b now cites where it is proven (CI tenancy suite,
`db/tests/tenant_branding.sql`).

### Known limitations

- Subdomain resolution is a **plan** (R-7), not a built feature. Until then the
  `?tid=` link and the slug fallback are the only doors.
- §1b documents `guardianships`-based guardian scoping and section-based teacher
  scoping as built; both predate this log — their own test coverage lives with
  migrations 002/010, not in an entry here.

### Unresolved bugs / issues

None new. R-1-A (two front doors) remains the open blocker it was.

### Decisions that require owner input

None new from this entry. (R-1-A's option A/B/C choice still pending.)

### Next recommended step

R-2 — Notices & notification system.

---

# 2026-08-29 · R-1-A · Three surfaces, three addresses (Option B implemented)

| | |
|---|---|
| **Date** | 2026-08-29 |
| **Phase ID** | R-1-A |
| **Phase name** | Production surface architecture — Option B |
| **Status** | ✅ **Complete.** Supersedes the 🔴 open R-1-A discovery entry above, which stays as written: it is the record of how the situation arose and what the alternatives were. |
| **Migration number** | none |
| **Rollback status** | n/a — no schema change. Reverting is a `git revert` of the file moves and two routing files. |
| **Git commit** | `git log -1 --format=%H -- apps/pwa/public/app.html` |

### Objective

Give the three surfaces three distinct addresses, so the marketing site, the
tenant application and the design prototype stop competing for `/`. The owner
chose **Option B** from the discovery entry above.

### What was already existing

The situation set out in the R-1-A discovery entry: `/` served a 4,341-line
prototype with zero API calls; the functional, tested PWA sat at
`index.legacy.html` linked from nowhere; `netlify.toml` sent every deep link to
the prototype; the service worker precached `/` as its offline app shell.

### What was implemented

Three `git mv`s (history preserved) and the routing to match:

| Was | Is | Serves |
|---|---|---|
| `landing.html` | `index.html` | `/` — shikhonBD marketing |
| `index.legacy.html` | `app.html` | `/app` — the tenant application |
| `index.html` | `design.html` | `/design` — the Ata Ekta prototype |

- **Marketing links repaired**: 13 CTAs pointed at `/` back when `/` was the
  application, and would have become links to themselves — now `/app`. The 5
  brand-mark links point home.
- **Routing** on both hosts (see below).
- **Service worker** — app-shell scoping, precache target, offline fallback,
  wake-up URL, unhashed-asset policy, cache version. See its own section.
- **PWA manifests** — generated and static both move to `/app`.
- **D11 guard rescoped** to the new filenames: `index.html` is now the
  platform-branded surface; `app.html` and `design.html` are tenant-branded.

### Important architectural decisions

1. **`/` is a real file, not a rewrite.** Making the marketing page literally
   `index.html` means the site root resolves through the static filesystem on
   both hosts, with no config to drift. Only `/app` and `/design` need rewrites.
2. **The service worker keeps scope `/` but narrows what it *treats* as the
   app.** It is registered from `/app.html` and must control `/app.js`, so its
   scope cannot shrink. Instead `isAppPath()` decides: only `/app*` navigations
   get the offline app-shell. Answering `/` with the app's HTML would have
   silently re-created the problem this phase closed.
3. **Unhashed entry assets get stale-while-revalidate, not cache-first.**
   `/app.js`, `/app.css` and `/manifest.webmanifest` matched the IMMUTABLE
   extension test and were pinned to whatever a device downloaded first. SWR
   keeps offline working (cached copy answers instantly) while making the next
   load current. This is §9b known-limitation 3, now fixed.
4. **`CACHE_SHELL` bumped to v2.** `stalecaches()` deletes any `shikhon-*` cache
   outside the keep set, so returning devices drop the v1 cache that held `/` as
   the app shell and a never-revalidated `app.js`. No migration code needed.
5. **The prototype was kept, not deleted** — the owner asked for it to be
   preserved if useful, and deleting a design reference is not reversible by
   reading a diff.

### Database changes

None.

### API changes

`buildManifest()` now emits `start_url: /app?tid=…` and `scope: /app` (was `/`).
No endpoint, auth, or tenant-resolution behaviour changed.

### UI changes

No screen changed. The application's markup, views, styles and behaviour are
byte-identical to R-1 apart from one stale comment reference in the prototype.
Marketing CTAs now open the application instead of reloading the marketing page.

### Files created

```text
apps/pwa/test/surfaces.test.ts
```

### Files modified

```text
apps/pwa/public/index.html         (renamed from landing.html; CTAs -> /app)
apps/pwa/public/app.html           (renamed from index.legacy.html; content unchanged)
apps/pwa/public/design.html        (renamed from index.html; one stale comment fixed)
apps/pwa/public/manifest.webmanifest   start_url + scope -> /app
apps/pwa/src/sw-router.ts          APP_SHELL_URL, isAppPath, SWR for unhashed assets, cache v2
apps/pwa/src/sw.ts                 app-shell fallback + wake-up URL -> /app
services/ops-svc/api/manifest.ts   start_url + scope -> /app
vercel.json                        /app, /app/:path*, /design rewrites
netlify.toml                       same three redirects before the catch-all; cache headers
.github/workflows/frontend.yml     D11 guard rescoped to the new filenames
apps/pwa/test/attendance-view.test.ts   two SW-policy tests updated to the new contract
services/ops-svc/test/branding.test.ts  start_url expectation updated
.claude/static-server.mjs          local preview mirrors production routing (gitignored)
docs/07-IMPLEMENTATION-STATUS.md   §9c, surfaces row, test count
docs/11-MASTER-PLAN.md             §1a resolved, test count corrected
README.md                          Surfaces section, D1-D12
docs/PHASE_LOG.md                  this entry
api/v1/ops/[action].js             regenerated bundle
```

### Files removed

None. All three HTML surfaces still exist, under new names.

### Tests added

**17**, in `apps/pwa/test/surfaces.test.ts`:

- The three surfaces identified **by content, not by filename** — a rename that
  swapped two of them would keep the names plausible and break everything, which
  is precisely how this situation arose.
- Both hosts' routing tables, including the ordering assertion that `/app` is
  declared before Netlify's catch-all (first match wins).
- App-shell scoping, including `isAppPath('/application')` being false.
- The unhashed-asset policy and the cache-version bump.
- Manifest `start_url`/`scope`, generated and static, and that the two agree.

### Tests executed

Full suite, plus a browser acceptance test with the origin server stopped.

### Test results

**432 unit tests, 0 failures** (415 → +17):
offline 46 · server-core 75 · ui-core 85 · academics-svc 19 · ops-svc 5 ·
rms-svc 15 · **pwa 179** · netlify 8.

Three pre-existing tests encoded the old `/`-based contract and were updated
with the reason recorded inline — the app-shell navigation test, the
stale-cache-pruning test (v1 is now stale too), and the manifest `start_url`
test. They were genuine regressions caught by the suite, not noise.

### Build / typecheck results

`tsc --noEmit` ×3 → exit 0 · `npm run build` ok · working tree clean after
rebuild.

### Security validation

No change to authentication, authorisation or tenant scoping. The D11 brand
guard passes in both directions against the new filenames. One security-adjacent
improvement: the marketing site is no longer served from the service worker's
app-shell cache, so it cannot be pinned to a stale copy on a device.

### Tenant-isolation validation

Unchanged and re-verified in the browser: `/app?tenant=a` and `/app?tenant=b`
render two different institutions with no value of either appearing in the
other's DOM or cache. Tenant resolution still `?tid=`; no second mechanism, no
school-picker (D12).

### Acceptance test — passed

| Step | Result |
|---|---|
| `/` | shikhonBD marketing site; platform brand present; does not boot the app; CTAs → `/app` |
| `/app?tenant=a` | Application mounted, SW registered, শাহজালাল আদর্শ উচ্চ বিদ্যালয়, `#156a3f`, manifest `?tid=demo-tenant-a` |
| `/app?tenant=b` | Application mounted, নর্থ সিটি মহিলা কলেজ, `#1b3e7a`; **no trace of tenant A** |
| `/design` | 66-screen prototype; no app boot; no platform brand |
| SW active, fetch `/` | Returns **marketing**, not the app shell |
| Shell cache | `shikhon-shell-v2` only; `/app` cached, `/` **not** cached as a shell |
| **Origin server stopped**, load `/app` | Full application boots from cache with Tenant A's identity, tab bar and offline banner |

### Known limitations

- The prototype at `/design` is static sample data and has no behavioural test
  coverage. It is a design reference; whether it earns its place is a later call.
- Per-tenant **subdomains** remain R-7. Today a school's door is its `?tid=` link.
- The local preview server (`.claude/static-server.mjs`, gitignored) mirrors the
  production routing by hand. If the hosts' routing changes, that file must be
  updated too or local verification will diverge from what ships.
- Carried forward unchanged from R-1: the DB-backed branding suites have still
  never executed, and migration 038 still has no probe.

### Unresolved bugs / issues

None. §9b known-limitation 3 (service-worker deploy staleness) is closed by this
entry.

### Decisions that require owner input

None outstanding.

### Next recommended step

**R-2 — Notices & notification system.**

---

# 2026-08-29 · R-7-DOC · Tenant onboarding specified, and a manual runbook for the pilot

| | |
|---|---|
| **Date** | 2026-08-29 |
| **Phase ID** | R-7-DOC (documentation/architecture decision — **not** an implementation phase) |
| **Phase name** | Tenant onboarding & provisioning specification + pilot runbook |
| **Status** | ✅ Complete. **R-7 itself remains unimplemented and unscheduled**; R-2 is the current implementation phase. |
| **Migration number** | none |
| **Rollback status** | n/a — documentation only |
| **Git commit** | `git log -1 --format=%H -- docs/PILOT-ONBOARDING-RUNBOOK.md` |

### Objective

The owner asked how a new school or college is entered into the system, and
whether the master plan covered it. It did not, adequately: R-7 existed as five
bullet points naming what would be built, with no answer to *who is allowed to
create a tenant*, *in what order the steps run*, *what happens when a step fails*,
or *how the first pilot schools get in before the wizard exists at all*.

Two gaps, one documentation task: specify R-7 properly, and write down the manual
procedure that has to work until R-7 ships.

### What was already existing

Most of the machinery, none of the procedure:

- `app.provision_tenant()` (migration 012) — seeds academic year, terms, grading
  scale and bands, bell schedules, classes, subjects with NCTB mark
  distributions, fee heads and chart of accounts. Idempotent. Refuses to run
  outside the tenant's own context (`42501`).
- Student CSV import with the dry-run → sha256 digest → commit contract (F-1601),
  creating guardians and `guardianships` from `guardian_phone`.
- Activation codes (F-202, migration 037) — HMAC-stored, single-use, 72-hour.
- R-1's branding editor, and migration 039's seed so an unconfigured school still
  shows its own name.
- `tenants.plan_code`, `student_cap`, `trial_ends_on`, `status` columns — present
  since migration 001, enforced by nothing.
- `audit.platform_access` — present, unused.

What did not exist: a document tying them into an order, and any statement of the
authorization chain for creating a tenant.

### What was implemented

Documentation only. No code, no schema, no configuration changed.

1. **`docs/11-MASTER-PLAN.md` §R-7 rewritten** from five bullets into fifteen
   subsections: R-7.1 authorization chain · R-7.2 institution information ·
   R-7.3 id and slug generation · R-7.4 branding · R-7.5 academic setup ·
   R-7.6 teacher import · R-7.7 student import · R-7.8 guardian linking ·
   R-7.9 principal/IT admin creation · R-7.10 plan, cap, trial ·
   R-7.11 suspension · R-7.12 login URL and subdomains · R-7.13 security controls ·
   R-7.14 rollback and failure handling · R-7.15 a nine-screen wizard
   specification, each screen giving fields, validation, dependencies, success
   state and error state.
2. **`docs/PILOT-ONBOARDING-RUNBOOK.md` created** — the manual procedure for the
   first 3–5 institutions, with the real SQL, the real CSV headers, the real
   error messages and what each one means, a verification checklist, and a
   recovery table.
3. **README** document map gains the runbook.

### Important architectural decisions

1. **Tenant creation is never self-service.** There is no public create endpoint
   and R-7 does not add one. A tenant is created by the platform operator after a
   signed agreement, full stop.
2. **Two credentials for tenant creation, not one.** A platform JWT alone is
   insufficient; `PLATFORM_API_KEY` is also required. Creating a tenant is the
   highest-blast-radius operation in the product, and a leaked session token
   should not be enough to perform it.
3. **The authorization chain is written down.** The runtime role cannot create or
   even *enumerate* tenants — `tenant_self` confines it to the one tenant it is
   already inside. Tenant creation therefore needs a `SECURITY DEFINER` function
   with a pinned `search_path`, granted to a platform role only, mirroring
   `app.public_branding()` from migration 039. This also retires the SMS worker's
   `SMS_WORKER_TENANT_IDS` env-var workaround, which exists today *only* because
   nothing could legitimately list tenants.
4. **Audit before the act, in the same transaction.** An action that rolls back
   leaves no misleading audit row; an audit row that exists means the action
   committed.
5. **Suspension is commercial, not destructive.** Login is refused with a specific
   message naming who to contact; data is untouched; SMS and AI stop so a
   suspended tenant cannot accrue cost; reactivation is one status change. A
   suspension that loses data is a suspension nobody dares use.
6. **The slug is effectively permanent once printed**, because it becomes the
   subdomain. Collisions resolve with a district suffix, never a number:
   `monipur-high-2` is not a URL anyone will print on an admission slip. The
   wizard must say this at the point of choosing, not in a help page.
7. **Skipping branding is a first-class outcome.** Migration 039's seed means a
   school that skips it still shows its own name. Blocking activation on a logo
   the office has not found yet is how onboarding stalls for a week.
8. **Only two things block activation**: no academic year, and no grading bands.
   Everything else is a warning. Grading bands are singled out because without
   them `app.compute_subject_grade()` returns NULL and the first result
   publication of the year fails — months after onboarding, with no obvious cause.
   It is the one failure that hides.
9. **Guardians come from the student import, keyed by phone.** Two students
   sharing a phone become one guardian with two children. Getting this wrong
   produces duplicate SMS and a parent who cannot see one of their children.
10. **The runbook exists to inform R-7, not merely to survive until it.** Its
    closing section asks the operator to record which fields the office could not
    supply, which errors were misread, and which steps were done out of order.
    That list is R-7's real requirements document.

### Database changes / API changes / UI changes

None / none / none.

### Files created

```text
docs/PILOT-ONBOARDING-RUNBOOK.md
```

### Files modified

```text
docs/11-MASTER-PLAN.md    §R-7 replaced with the full specification (R-7.1 … R-7.15)
README.md                 document map gains the runbook
docs/PHASE_LOG.md         this entry
```

### Files removed

None.

### Tests added / executed / results

None added — nothing executable changed. The suite was re-run to confirm the
documentation commit is inert: **432 passing, 0 failing.**

### Build / typecheck results

`npm run build` ok · `tsc --noEmit` ×3 exit 0 · working tree clean after rebuild.

### Security validation

No enforcement changed. The entry *specifies* controls that do not exist yet
(platform role, `PLATFORM_API_KEY`, `app.create_tenant`) — they are R-7's work and
are recorded here as design, not as fact. The D11 brand guard still passes in both
directions.

### Tenant-isolation validation

Unchanged. §R-7.13 documents the existing controls it will build on; it introduces
no new data path.

### Known limitations

- **This is a specification, not an implementation.** `platform-svc`,
  `app.create_tenant`, the wizard and subdomain provisioning do not exist. Any
  reader must not mistake R-7.1–R-7.15 for a description of running code.
- **Steps 2 and 4 of the runbook need an owner-role connection.** Until
  `platform-svc` exists there is no non-SQL way to create a tenant or the first
  user, which is precisely why R-7 is scheduled.
- **Teacher→section assignment has no UI** (R-3). The runbook works around it with
  a direct `UPDATE sections SET class_teacher_id`, which is enough for a pilot
  school to take attendance but is not the assignment model the product will use.
- The runbook's SQL has **not been executed end to end** against a live database —
  no PostgreSQL was reachable while writing it. It is derived from the migrations
  and handlers, and the first pilot onboarding is its first real test. Expect to
  correct it then, and record what changed.
- Carried forward: DB-backed branding suites still unexecuted; migration 038 still
  has no probe.

### Unresolved bugs / issues

None.

### Decisions that require owner input

None now. Two arrive with R-7: the plan/pricing model behind `plan_code`, and
whether custom domains (`portal.school.edu.bd`) are offered at all.

### Next recommended step

**R-2 — Notices & notification system.** R-7 stays unscheduled; this entry
changed only what is written down about it.

---

# 2026-08-29 · R-2 · Notices & in-app notification system

| | |
|---|---|
| **Date** | 2026-08-29 |
| **Phase ID** | R-2 |
| **Phase name** | Notices & notification system (owner priority #2) |
| **Status** | ✅ Complete — **finalised by the R-2-FINAL entry at the end of this file** (2026-08-29): the DB-backed suites were executed for the first time, the three auto-notice emitters were built, and `publish_at` became a real scheduled status. The limitations listed below are superseded there; this entry is left exactly as it was written. |
| **Migration number** | **040** — `db/migrations/040_notices.sql` |
| **Rollback status** | ✅ `db/rollback/040_notices.down.sql`. **Unlike 039's, this one destroys data** — notices live only in these tables. Correct for pre-production; once schools are publishing, rolling back means losing the record of what a school told its guardians, and would need an export first. Stated in the file. |
| **Git commit** | `git log -1 --format=%H -- db/migrations/040_notices.sql` |

### Objective

প্রধান শিক্ষক একটা নোটিশ দিলে টার্গেট অনুযায়ী সবার নোটিফিকেশন বেলে পৌঁছাবে — এবং
চাইলে গার্ডিয়ানের ফোনে SMS। The owner's stated priority #2.

### What was already existing

- The SMS pipeline, complete and suppression-aware: `event_outbox` →
  `sms-svc` stage 1 (grace window, weekend, holiday, tenant daily cap,
  guardian consent) → `sms_outbox` with dedupe/segments/cost → stage 2 drain.
  Send stubbed pending an aggregator.
- `guardianships` (M:N, `receives_sms`), `enrolments`, `user_roles` with
  `roles.is_staff` — everything an audience resolver needs.
- **No notices anywhere.** `academics-svc/api/ward.ts` refused to stub §9.1's
  notices card, saying in a comment that the schema has no notices table.

### What was implemented

- **Migration 040** — `notices`, `notice_receipts`, two enums,
  `app.resolve_notice_audience()`, `app.publish_notice()`, RLS for both tables.
- **`packages/ui-core/src/notice.ts`** — the shared contract: categories,
  audience types, validation, Bangla labels, SMS segment maths.
- **`services/ops-svc/api/notices.ts`** — create + publish, role-gated, class
  teachers narrowed to their own sections.
- **`services/ops-svc/api/inbox.ts`** — the bell's data and marking read.
- **`services/sms-svc/src/dispatch.ts`** — a second stage-1 consumer for
  `notice.published.v1`, sharing the existing cap and suppression.
- **PWA** — bell + badge in `shell.ts`, `inbox-view.ts`, `notice-compose-view.ts`,
  routes and dashboard cards for all five roles, service-worker caching.

### Important architectural decisions

1. **Receipts are materialised at publish, not resolved at read.** A notice's
   audience is a question about the past — who was in Class 9 Science F on the
   day it went out. A live query answers it about the present: a student who
   transfers in next week would retroactively acquire last week's notices, and
   one who leaves would lose the record that they were told. Resolving once
   makes the receipt a fact rather than a re-derivation. It also makes the read
   path one indexed lookup and the RLS policy `user_id = current_user` instead
   of a re-implementation of the targeting rules in SQL.
2. **Intent is stored separately from consequence.** `notices.audience` keeps
   what the author wrote; `notice_receipts` keeps what was delivered. Both are
   needed — intent is what an author edits, consequence is what was sent.
3. **The client sends intent, never a recipient list.** A client-supplied
   roster is the confused-deputy shape R-1 removed from branding, and worse
   here: the wrong roster does not show a school the wrong logo, it tells 900
   guardians something meant for the staff.
4. **Category is not audience.** They are separate fields and separate ideas.
   A fee notice addressed to `all` reaches teachers too, and should — a teacher
   with a child at the school is a guardian. If category silently narrowed the
   audience, that parent would never be told their own child's fees were due
   and nothing would report it.
5. **A guardian gets one receipt per child in scope.** Two children, two pieces
   of news. This is what lets the ward view file a notice under the child it
   concerns, and it is why `uq_notice_receipt` uses `NULLS NOT DISTINCT` — the
   default NULL-distinct behaviour would let a re-publish duplicate every staff
   receipt.
6. **SMS reuses the attendance pipeline entirely.** One daily cap, one weekend
   and holiday suppression, one dedupe index, one drain. SMS is ~80% of the
   infrastructure bill (docs/05 §5) and a second path is a second place for it
   to double. The two senders share a mutable budget object so one run cannot
   double-spend the cap.
7. **Emergencies bypass weekend and holiday suppression.** "School is closed
   today" is precisely the message a parent needs on a day the school is closed.
8. **Notice SMS is capped at 180 characters.** A 4000-character notice is 58
   UCS-2 segments per guardian; to 900 guardians that is over ৳20,000 for one
   message. The SMS carries the headline and points at the app, where the whole
   text already is. Not left to whoever writes the notice.
9. **Class teachers are narrowed in the endpoint, not the policy.** Expressing
   "every id in this jsonb is a section you teach" as an RLS predicate would be
   a second implementation of `app.my_section_ids()`, and the two would
   eventually disagree in whichever direction is more permissive.
10. **The composer restates the audience in words above the send button.** Not
    as a form value set six fields ago, but as a sentence read at the moment of
    committing. A section audience says "শিক্ষার্থী ও অভিভাবক" explicitly,
    because "শাখা ৯-ক" reads like students only and it is not.

### Database changes

Migration **040**: two enums (`notice_category`, `notice_status`), two tables
with `enforce_tenant()` triggers and RLS (PERMISSIVE tenant isolation +
RESTRICTIVE read/write scopes), `app.resolve_notice_audience()` (SECURITY
DEFINER, pinned search_path, tenant assertion), `app.publish_notice()`
(SECURITY INVOKER — the caller's RLS decides whether they may publish).

### API changes

| Route | Auth |
|---|---|
| `GET /api/v1/ops/notices` | JWT; RLS decides visibility |
| `POST /api/v1/ops/notices` | JWT + principal / school_owner / academic_coordinator / class_teacher |
| `GET /api/v1/ops/inbox` | JWT, **every role** |
| `POST /api/v1/ops/inbox` | JWT, every role — marks own receipts read |

### UI changes

- Bell with unread badge in every role's top bar (`Shell.setUnread()`); badge
  hides at zero, caps at ৯+, and announces the count to screen readers.
- Inbox: unread carries a left rule and a heavier title, not only a tint —
  a pale background difference is the first thing to vanish in daylight on the
  2 GB reference phone. Opening a notice marks it read; "সব পড়া হয়েছে" exists
  for a backlog.
- Composer: category, audience chips, per-section checkboxes, SMS toggle with a
  live segment count, and the restated audience above Send.
- Notice cards on all five role dashboards; a compose card for principals.

### Files created

```text
db/migrations/040_notices.sql
db/rollback/040_notices.down.sql
db/tests/notices.sql
packages/ui-core/src/notice.ts
packages/ui-core/test/notice.test.ts
services/ops-svc/api/notices.ts
services/ops-svc/api/inbox.ts
apps/pwa/src/inbox-view.ts
apps/pwa/src/notice-compose-view.ts
apps/pwa/test/notices-ui.test.ts
```

### Files modified

```text
services/sms-svc/src/dispatch.ts     second stage-1 consumer; shared budget; tenant-signed templates
services/ops-svc/api/index.ts        two routes + mutation rate-limit buckets
packages/ui-core/src/index.ts        re-export
apps/pwa/src/shell.ts                bell, badge, setUnread()
apps/pwa/src/app.ts                  routes, dashboard cards, More entries, refreshUnread()
apps/pwa/src/sw-router.ts            notices/inbox → stale-while-revalidate
apps/pwa/src/demo.ts                 role-filtered demo inbox
apps/pwa/public/app.css              bell, inbox, composer
scripts/migration-status.mjs         probe for 040
.github/workflows/database.yml       notices.sql, first pass + idempotency re-run
docs/07-IMPLEMENTATION-STATUS.md     §9d, counts, API rows
docs/PHASE_LOG.md                    this entry
api/v1/ops/[action].js               regenerated bundle
```

### Files removed

None.

### Tests added

**45.**

- `packages/ui-core/test/notice.test.ts` — 23. Mostly refusals: a broadcast
  audience that also names ids (the composer left checkboxes ticked), targeted
  types with no selection, non-uuid ids, and the assertion that Bangla costs 70
  characters per segment while ASCII gets 160 — and that one Bangla word in an
  English notice doubles the cost.
- `apps/pwa/test/notices-ui.test.ts` — 22. Badge truthfulness and the ৯+ cap,
  opening-is-reading, a guardian seeing which child a notice is about, the body
  inserted as text rather than markup, a class teacher offered sections only,
  and the restated audience following the chips.
- `db/tests/notices.sql` — the audience matrix and isolation: a staff notice
  reaching no student, a section notice reaching that section's guardians and
  nobody else's, a sibling guardian getting one receipt per child, re-publish
  being free, a student unable to read a staff notice by id, and tenant B
  seeing none of tenant A's notices.

### Tests executed

Full suite, plus a browser walkthrough across four roles with the origin server
stopped for the offline check.

### Test results

**477 unit tests, 0 failures** (432 → +45):
offline 46 · server-core 75 · **ui-core 108** · academics-svc 19 · ops-svc 5 ·
rms-svc 15 · **pwa 201** · netlify 8.

Browser walkthrough, one tenant, four roles:

| Role | Inbox | Notes |
|---|---|---|
| class_teacher | 3 notices, badge ৩ | sees "শিক্ষক সভা" |
| student | 2 notices, badge ২ | **does not** see "শিক্ষক সভা" |
| guardian | 3 notices | fee notice labelled "রাফির হাসান" |
| principal | badge ৪, composer | 5 audience chips; teacher sees 1 |

Composer: emergency turns SMS on by default; 150 Bangla characters reported as
"প্রতি জনে ৩টি এসএমএস"; narrowing to staff updated the restated line; publish
reported "৪২ জনের কাছে পৌঁছেছে" and cleared the form.

**Offline:** with the origin server stopped, the guardian's inbox rendered all
three notices from the service-worker cache.

### Build / typecheck results

`tsc --noEmit` ×3 exit 0 · `npm run build` ok · bundle within the 180 KB gz
budget · working tree clean after rebuild.

### Security validation

- The read path interprets no audience: it selects the caller's own receipts,
  confined by `receipt_read_scope`.
- `notice_read_scope` (RESTRICTIVE) is what stops a student reading a
  teachers-only notice — not the category, not the UI.
- `app.resolve_notice_audience()` asserts the session tenant, so definer rights
  cannot cross tenants (asserted in `db/tests/notices.sql` §7).
- Notice bodies are rendered with `textContent`, never `innerHTML`; tested with
  an `<img onerror>` payload.
- Audience ids must be uuids, so a SQL fragment is refused as malformed input
  before it reaches the database.
- **D11 fix:** attendance SMS templates no longer sign "— ShikhonBD"; they now
  carry the institution's own name.

### Tenant-isolation validation

Designed and asserted; **the SQL suite has not been executed** — still no
PostgreSQL reachable on this machine. `db/tests/notices.sql` is wired into
`database.yml` (both the first pass and the idempotency re-run), so the first
CI run is its first execution.

### Known limitations

1. **The DB-backed suites for R-1 and R-2 have still never run.** Two phases now
   depend on CI for their first execution. This is the oldest open item in this
   log and it is growing: R-2's isolation guarantee is code-complete and
   CI-pending, exactly as R-1's was.
2. **Scheduling is a column, not a feature.** `publish_at` exists; nothing polls
   it.
3. **No real-time delivery.** The badge refreshes on boot and after publishing.
   A polling timer on 2G would cost more than the freshness is worth.
4. **Auto-notices are not built** — exam-routine-published, result-published and
   invoice-generated do not yet emit notices. Three small emitters at existing
   publish points; deferred so the surface shipped first.
5. **No editing of a published notice**, and no UI for re-publishing after
   widening an audience (the function supports it).
6. **SMS send is still stubbed** (R-8). Notice SMS queues into `sms_outbox` and
   nothing leaves the building.
7. Migration 038 still has no probe.

### Unresolved bugs / issues

None open. One pre-existing defect was found and fixed: the attendance SMS
templates carried the platform brand into a tenant surface (D11).

### Decisions that require owner input

- **Notice SMS length.** 180 characters is a cost decision, not a technical
  limit. If the school wants full notices by SMS, the bill scales with the body
  and the cap should be raised deliberately, per tenant.

### Next recommended step

**R-3 — Principal & IT admin portals**, per the master plan: the hierarchy
drill-down, teacher assignment and replacement UI, user management, and the
rollover screen. R-2's auto-notice emitters are a natural half-day inside it,
since R-3 touches the publish points they hook into.


---

# 2026-08-29 · R-2-FINAL · The DB suites were actually run, and four gaps closed

| | |
|---|---|
| **Date** | 2026-08-29 |
| **Phase ID** | R-2-FINAL |
| **Phase name** | R-2 finalisation — real database verification, auto-notices, scheduling, SMS policy |
| **Status** | ✅ Complete. R-2 is now final. |
| **Migration number** | **040 amended** — `db/migrations/040_notices.sql` (never applied to any production database, so amending in place is honest; see "Important architectural decisions" #1) |
| **Rollback status** | ✅ `db/rollback/040_notices.down.sql` — corrected. It previously left `app.emit_auto_notice()` and `app.publish_due_notices()` behind, so `DROP TYPE notice_category` was refused and up → down → up failed. Now verified end to end: descending rollback leaves **zero objects** in `public`. |
| **Git commit** | `git log -1 --format=%H -- docs/PHASE_LOG.md` |

### Objective

R-2 was reported complete with four gaps named in its own entry. Close them
before starting R-3, and above all **stop claiming a database is correct on the
strength of SQL nobody has run.**

### What was already existing

- R-2's full surface: migration 040, the audience resolver, notices/inbox APIs,
  the bell, the composer, the SMS stage-1 consumer.
- 18 SQL assertion suites and a rollback chain, all written, all wired into
  `.github/workflows/database.yml`, **none of which had ever executed** — the
  oldest open item in this log, by then spanning two phases.
- `services/sms-svc` with no test workspace at all.

### What was implemented

**1 · The DB-backed suites were executed.** A `pgvector/pgvector:pg16` container
on port 55432, configured like CI, ran the whole chain: 40 migrations applied
silently, `schema_lint.sql`, `invariants.sql`, `tenant_branding.sql` (10/10),
`notices.sql` (13/13), an idempotency re-run leaving zero rows behind, a
descending rollback, and a clean re-apply.

**2 · Three auto-notice emitters**, all through one `app.emit_auto_notice()`:

| Event | Where | Audience | Idempotency key |
|---|---|---|---|
| Exam routine published | `services/rms-svc/api/examroutine.ts` | students + guardians of the sections with a paper in it | `('exam_routine', examId)` |
| Results published | `services/academics-svc/api/publish.ts` | the same people; **no marks in the body** | `('result', examId)` |
| Invoices generated | `services/finance-svc/api/index.ts` | `guardians_payers` — a new audience type honouring `can_pay_fees` | `('invoice', md5('invoice:' \|\| period))` |

**3 · `publish_at` made real.** `notice_status` gained `'scheduled'`;
`app.publish_due_notices(tenant, limit)` is swept by the **existing**
ops/maintenance cron.

**4 · SMS length made a policy, not a constant.** `NOTICE_SMS_DEFAULT_MAX = 180`,
`NOTICE_SMS_HARD_CEILING = 480`, tenant override at
`tenants.settings->'sms'->>'noticeMaxChars'`, clamped to [70, 480].

### Important architectural decisions

1. **Migration 040 was amended in place rather than superseded by a 041.** It has
   never been applied to any live database — the only copies are in this repo and
   in throwaway CI containers. A 041 that patches a 040 nobody ever ran would be
   a permanent piece of archaeology explaining a mistake with no victims. Once a
   school's data is behind these tables this option disappears, and every later
   change is additive. The distinction worth keeping is between *unreleased* and
   *deployed*, not between *written* and *not written*.

2. **One emitter function, not three.** Three copies of "insert a notice, resolve
   its audience, publish it" would be three places to get the idempotency subtly
   wrong, and the third would be written months after the first by someone who
   had not read the first two.

3. **Idempotency is a database constraint, not application logic.** A partial
   unique index on `(tenant_id, source_kind, source_ref)` plus
   `ON CONFLICT … DO NOTHING`. A teacher correcting a routine and re-publishing
   it must not send 900 guardians a second SMS, and the guarantee should not
   depend on every future caller remembering to check first.

4. **The emitters run inside the transaction of the event they announce.** A
   result publish that rolls back takes its notice with it. The alternative —
   announcing results that were then not published — is the kind of error a
   school cannot retract.

5. **`guardians_payers` is a distinct audience, not a filter on `guardians`.**
   `guardianships.can_pay_fees` already records who is authorised to pay. A fee
   reminder to a guardian with no such authority is noise that costs money to
   send, and in a family where one parent handles school money and the other does
   not, it is also a small breach of an arrangement the family chose.

6. **The result notice carries no marks.** It says results are available. A grade
   is not something to put in a notification that a sibling, a classmate, or
   anyone holding the phone may read over a shoulder — and an SMS is stored in
   plaintext on a device the student often shares.

7. **`scheduled` is a status, not a draft with a date.** A draft is unfinished; a
   scheduled notice is finished and waiting. The sweeper must publish the second
   and never the first, and encoding that in a status makes it impossible to
   confuse — a nullable timestamp on a draft cannot.

8. **The scheduler is the cron we already have.** `publish_due_notices()` is a
   query with `FOR UPDATE SKIP LOCKED`, run by the existing ops/maintenance
   route. No queue, no worker, no new process to monitor. The cost is honest:
   granularity is the cron's, so the composer says *"নির্ধারিত সময়ের পর পরবর্তী
   রক্ষণাবেক্ষণ চক্রে পাঠানো হবে"* rather than implying a precision it does not
   have. A UI that promises 09:00 and delivers at midnight is worse than one that
   promises less.

9. **180 characters is a default, not a limit.** Bangla forces UCS-2, so a segment
   is 70 characters, and SMS is around 80% of the infrastructure bill. But that is
   a *cost* fact, and a cost decision belongs to the school paying it — hence the
   per-tenant override, with a live per-recipient segment count shown in the
   composer before publishing. The 480 hard ceiling stays because past ~7 segments
   the message has stopped being an alert, and the honest fix is a shorter notice
   rather than a bigger bill. The full notice always remains in the app.

### Database changes

- `notice_status` enum: `+ 'scheduled'`.
- `notices`: `+ source_kind`, `+ source_ref`, `CHECK notices_source_is_paired`
  (both or neither), `CHECK notices_scheduled_has_a_time`.
- `CREATE UNIQUE INDEX uq_notice_source ON notices (tenant_id, source_kind, source_ref) WHERE source_kind IS NOT NULL`.
- `notice_receipts.uq_notice_receipt` reordered to lead with `tenant_id`
  (schema-lint L7: a tenant-scoped index must be usable by the tenant predicate).
- `app.resolve_notice_audience()`: `+ guardians_payers` branch.
- `app.emit_auto_notice(...)` and `app.publish_due_notices(...)` added.
- Rollback drops both new functions **before** the types they depend on.

### API changes

- `POST /api/v1/rms/examroutine` (publish) → emits `exam_routine` notice.
- `POST /api/v1/academics/publish` → emits `result` notice; response gains
  `notified`.
- `POST /api/v1/finance/generate` → emits `invoice` notice, skipped entirely when
  the batch produced no invoices.
- `POST /api/v1/ops/notices` accepts `status: 'scheduled'` with `publishAt`.

### UI changes

- Composer: scheduling control with the honest granularity hint; live
  per-recipient SMS segment count; the policy line *"এসএমএসে সংক্ষিপ্ত বার্তা
  যাবে; পুরো নোটিশ অ্যাপে থাকবে"*.

### Files created

- `services/sms-svc/package.json`, `services/sms-svc/test/notice-sms.test.ts`

### Files modified

- `db/migrations/040_notices.sql`, `db/rollback/040_notices.down.sql`,
  `db/tests/notices.sql`, `db/tests/tenant_branding.sql`
- `packages/ui-core/src/notice.ts`
- `services/sms-svc/src/dispatch.ts`, `services/rms-svc/api/examroutine.ts`,
  `services/academics-svc/api/publish.ts`, `services/finance-svc/api/index.ts`,
  `services/ops-svc/api/notices.ts`
- `apps/pwa/src/notice-compose-view.ts`
- `scripts/migration-status.mjs` (probe for 038)
- `.github/workflows/frontend.yml` (sms-svc step)
- `docs/07-IMPLEMENTATION-STATUS.md`, `docs/11-MASTER-PLAN.md`, this file
- `api/v1/*.js` (rebuilt bundles)

### Files removed

None.

### Tests added

- `services/sms-svc/test/notice-sms.test.ts` — **13 tests**, the first this
  service has ever had. Covers the tenant-configurable cap, its clamps, junk in
  the settings blob, truncation being visible, and the one that matters: an SMS
  is signed by the school, never by the platform.
- `db/tests/notices.sql` grew to **13 assertions**, including the four new ones:
  auto-notice emission is idempotent; `guardians_payers` respects
  `can_pay_fees`; the sweeper publishes what is due and never a draft; a second
  sweep is a no-op.

### Tests executed

Everything, against a real database — the point of the phase.

```
node --test  (11 workspaces)              661 passing, 0 failing
db/tests/schema_lint.sql                  PASS · 0 advisories
db/tests/invariants.sql                   PASS
db/tests/tenant_branding.sql              10/10 PASS
db/tests/notices.sql                      14/14 PASS (13 assertions + teardown)
db/tests/e2e_academic_cycle.sql           PASS
the 4 re-runnable suites, second pass      0 errors, 0 rows left behind
  (the migrations themselves are NOT re-runnable and never claimed to be —
   migrate.sh refuses a non-empty schema; CI re-runs the suites, not the DDL)
rollback, descending                      0 objects left in schema public
up → down → up                            clean
RLS coverage guard                        0 violations
scripts/migration-status.mjs              40/40 applied, 0 unprobed
tsc --noEmit ×3                           exit 0
npm run build                             ok · app.js 78 KB gz / 180 KB
```

Auto-emitters, verified end to end against the same database:

```
PASS  exam routine  → student + guardian (2 recipients)
PASS  results       → student + guardian, no marks in the body (2)
PASS  invoice       → the authorised guardian only
```

### Test results

**661 passing, 0 failing.** offline 46 · server-core 86 · ui-core 108 ·
academics-svc 78 · identity-svc 10 · ops-svc 26 · rms-svc 62 · **sms-svc 13** ·
sync-svc 23 · pwa 201 · netlify 8.

Running the SQL suites for the first time found **five real defects in committed
code**, which is the entire argument for having done it:

1. `db/tests/tenant_branding.sql` (R-1) used `'college'`, which is not a value
   of `institution_level`. R-1's suite would have failed on its first CI run.
2. Migration 040 joined `user_roles.role_id`. The column is `role_code` — a
   text FK to `roles.code`.
3. Migration 040's resolver used `sections.class_offering_id` and a
   `class_offerings` table. Neither exists; sections hang off `classes` via
   `class_id`. **The audience resolver could not have run at all.**
4. `ON CONFLICT ON CONSTRAINT uq_notice_source` is invalid against a *partial*
   unique index; PostgreSQL needs the column list and the predicate. Every
   auto-notice would have raised instead of silently doing nothing — inside the
   transaction publishing exam results.
5. The rollback left two functions behind, so `DROP TYPE notice_category` was
   refused and up → down → up failed.

Plus four found by the new sms-svc tests and the lint: `Number([]) === 0` and
`Number(true) === 1` are both finite, so junk in a tenant's settings blob would
have clamped every alert to one segment rather than falling back to the default;
and `uq_notice_receipt` did not lead with `tenant_id`.

### Build / typecheck results

`npm run build` ok; `tsc --noEmit` clean in all three configurations;
`app.js` 78 KB gzipped against the 180 KB budget; `git status` clean after a
rebuild, so the committed `api/` bundles match their sources.

### Security validation

- Both new functions are `SECURITY DEFINER` with a pinned `search_path` and an
  explicit assertion that the tenant they were handed is
  `app.current_tenant()` — a definer function without that assertion is a
  cross-tenant read waiting to be called with someone else's UUID.
- `db/tests/notices.sql` asserts the resolver **refuses** a foreign tenant id
  rather than returning an empty set, so a bug can never look like an empty
  audience.
- The result notice contains no marks; the invoice notice contains no amount.

### Tenant-isolation validation

Executed, not asserted on paper: cross-tenant reads return zero rows; the
resolver raises on a foreign tenant; the RLS coverage guard reports 0 tables
without a policy; `schema_lint.sql` reports 0 advisories. Every SMS built by
`noticeSmsBody()` carries the institution's own name — the D11 regression that
R-2 fixed now has a test that fails if it returns.

### Known limitations

1. **SMS send is still stubbed** (R-8, external). Notice SMS queues into
   `sms_outbox`; nothing leaves the building.
2. **No real-time delivery.** The bell refreshes on boot and on navigation.
3. **Scheduling granularity is the maintenance cron's**, not the minute. Stated
   in the UI rather than hidden.
4. **No editing of a published notice**, and no UI for re-publishing after
   widening an audience (the function supports it).
5. The emitters are covered by the SQL suite and a scripted end-to-end check
   against a real database, **not** by an HTTP-level integration test.
6. `scripts/test-all.mjs` still cannot run on Windows (pre-existing:
   `execFileSync('npm')` and an unexpanded quoted glob). Workspaces were run
   individually.

### Unresolved bugs / issues

None open.

### Decisions that require owner input

None outstanding. The notice-SMS cap that R-2 raised is now a per-tenant
setting, so it is an operational choice at onboarding rather than a decision the
codebase has to make on a school's behalf.

### Next recommended step

**R-3 — Principal & IT admin portals.** Not started.


---

# 2026-08-29 · D13 · A feature is not implemented until a person can use it

| | |
|---|---|
| **Date** | 2026-08-29 |
| **Phase ID** | D13 |
| **Phase name** | UI/UX completeness made a permanent condition of "done" |
| **Status** | ✅ Recorded and applied retroactively to R-1 and R-2 |
| **Migration number** | none — a process decision |
| **Rollback status** | n/a |
| **Git commit** | `git log -1 --format=%H -- docs/11-MASTER-PLAN.md` |

### Objective

The owner set a permanent rule: no phase may be called complete on the strength of
its database, service and API alone. Every applicable layer — through the screen a
person actually touches, and the loading, empty, error and success states that make
that screen usable — must be done and verified, or the phase is reported as
**"Backend complete — UI pending."**

Recorded as **D13** in [11-MASTER-PLAN.md](11-MASTER-PLAN.md) §1 with the full
18-layer checklist, the UI-first requirement table, the three acceptance-test
templates (end-to-end, two-tenant, offline cycle) and the phase reporting format in
the new **§1c**. The roadmap's definition of done now names it alongside D10 and
D11.

### Why this rule earned its place

It is not a general principle borrowed from somewhere; it names a failure that had
just happened in this repository. R-2 finalisation made the notice-SMS cap
tenant-configurable, wrote six tests for it, and documented it in three files —
and left no way to set it except writing SQL by hand against production. A setting
only a developer can reach is a setting the school does not have.

That shape recurs whenever a phase is judged by its migration count and its test
count, because those are the parts that are easy to count. A school does not
experience a table or an endpoint. It experiences a screen — and a screen with no
empty state is broken on its first day, which is precisely the day every table is
empty.

### Audit of the completed phases against D13

Applied the rule to R-1 and R-2 rather than only to future work, since a rule that
starts tomorrow exempts exactly the work that motivated it.

**Passing all applicable layers:**

| Feature | Where |
|---|---|
| Branding editor (R-1) | `branding-view.ts` — live preview, per-field errors, contrast warning, save/cancel, two-tenant browser acceptance test |
| Notice inbox + bell (R-2) | `inbox-view.ts`, `shell.ts` — loading, empty, error states; offline-cached; browser-verified with the origin stopped |
| Notice composer (R-2) | `notice-compose-view.ts` — audience picker, scheduling control, live SMS segment count, field errors |

**Backend complete — UI pending (4 found):**

| Capability | Backend | UI | Consequence |
|---|---|---|---|
| **Notice SMS cap** `settings->'sms'->>'noticeMaxChars'` | ✅ read, clamped, 6 tests | ❌ no API write path, no screen | Only settable by hand-written SQL. Introduced yesterday by R-2 finalisation — the case that produced this rule |
| **Publish results** `POST /api/v1/academics/publish` | ✅ full result flow, RLS-gated | ❌ no caller in the PWA | `results-view.ts` reads published results; nothing in the app publishes them. **The results auto-notice emitter cannot fire from the UI**, because nothing in the UI reaches the endpoint it hangs off |
| **Generate invoices** `POST /api/v1/finance/generate` | ✅ monthly batch, idempotent per student+period | ❌ no caller in the PWA | Same shape: `fees-view.ts` reads invoices; nothing creates them. The invoice auto-notice has the same problem |
| **Routine solver** `POST /api/v1/rms/solve` | ✅ | ❌ `generation-view.ts` calls `/rms/generation`, a different endpoint | The solver is reachable only over the API |

One further observation, recorded rather than classified: **`GET /api/v1/sync/pull`
has no client caller anywhere.** `packages/offline/src/sync-engine.ts` only pushes.
The delta-pull half of the sync protocol is implemented, tested and documented on
the server, and unused by the app. Whether that is a deferral or an oversight needs
a decision, not an assumption, so it is written down here and left open.

### What this changes about R-2's status

R-2 remains complete **in its own scope** — the notice system it set out to build
is usable end to end by all five roles. But two of its three auto-notice emitters
hang off endpoints the UI cannot reach, so in practice they fire only from an API
client. The R-2-FINAL entry above tested them at the database level and by script,
and both passes were honest about being scripted rather than driven through a
screen. Under D13 that distinction is now load-bearing, so it is stated plainly
here rather than left as an implication.

This does **not** retract the R-2-FINAL entry. It adds the layer that entry did not
examine, which is the point of the rule.

### Files modified

- `docs/11-MASTER-PLAN.md` — D13 row, new §1c, definition-of-done bullet
- `docs/PHASE_LOG.md` — this entry, and the status block

### Known limitations

The four gaps above are open. Three of them (publish results, generate invoices,
SMS settings) are principal- and IT-admin-facing, which is exactly R-3's scope, so
they are folded into R-3 rather than logged and forgotten. The routine solver's
screen belongs with the RMS work.

### Next recommended step

**R-3 — Principal & IT admin portals**, now carrying the three admin-facing D13
gaps as part of its scope. Not started.


---

# 2026-08-29 · R-3 · Principal & IT admin portals

| | |
|---|---|
| **Date** | 2026-08-29 |
| **Phase ID** | R-3 |
| **Phase name** | Principal & IT admin portals (owner priority #3) |
| **Status** | ✅ Complete. The first phase built under D13, and the first whose report separates the layers. |
| **Migration number** | **041** — `db/migrations/041_assignment_history.sql` |
| **Rollback status** | ✅ `db/rollback/041_assignment_history.down.sql`. **Destroys history**: every closed assignment row exists only in these columns, and restoring the old UNIQUE constraint is impossible while they exist, so they are deleted first. Correct pre-production; once a school has replaced a teacher mid-year this needs an export. Verified up → down → up with 0 objects left. |
| **Git commit** | `git log -1 --format=%H -- db/migrations/041_assignment_history.sql` |

### Objective

স্কুল নিজে নিজের সব কাঠামো চালাতে পারে — ডেভেলপার ছাড়া। A principal and an IT
admin must be able to run the institution's academic and system structure from
screens, without SQL: the class → group → section → student drill-down,
teacher assignment and replacement, bulk student moves, the yearly promotion,
user accounts, and the three D13 gaps that had backends and no callers.

### What was already existing

- The whole domain model: `classes` (with `group` as a column), `sections`,
  `enrolments` with per-year rows, `section_subject_teachers`,
  `guardianships`, `year_rollovers` with `app.rollover_preview()` and
  `app.commit_rollover()`, and `audit.activity_log`.
- `POST /api/v1/academics/publish` and `POST /api/v1/finance/generate`,
  complete and unreachable from the app (D13's audit).
- The Ata Ekta component set: `.empty-state`, `.skel`, `.stepper`,
  `.data-table`, `.status-chip[data-state]`, `.inline-notice`. **No new
  visual language was introduced** — every R-3 screen is built from these.

### Three things the schema could not do, and one it lied about

1. **Replacing a teacher destroyed the record of the last one.**
   `section_subject_teachers` was UNIQUE (tenant, section, subject, year) with
   no validity period, so a replacement was an UPDATE and March disappeared.
   The master plan's R-3 required "end old row, insert new — never delete";
   that was a schema capability the schema did not have.
2. **The class teacher had no history at all** — `sections.class_teacher_id` is
   a single nullable column.
3. **`it_admin` was a role no user could hold.** ops-svc/branding.ts has
   admitted it to BRANDING_WRITERS since R-1 and docs/07 documents it, but it
   is not in the `roles` table and `user_roles.role_code` has an FK to
   `roles.code`. `app.has_role('it_admin')` could never be true. The allowlist
   entry had been decorative for two phases — R-3 is the phase that builds the
   IT admin's screens, so the role had to become real first.
4. **The audit log could be written and never read**: 010 grants INSERT and
   revokes UPDATE/DELETE, correctly, but granted no SELECT.

Migration 041 fixes exactly those four and nothing else.

### What was implemented

**Database (041):** validity columns on `section_subject_teachers` with a
PARTIAL unique index over the open rows; `class_teacher_assignments` plus a
trigger that is the only writer of `sections.class_teacher_id`;
`app.assign_class_teacher()` and `app.assign_subject_teacher()`; the
`it_admin` role; RLS + SELECT on `audit.activity_log` for management.

**`packages/server-core/src/audit.ts`** — the first writer `activity_log` has
ever had. Deliberately swallows its own failures: losing a log line is bad, a
logging error that stops a school promoting its students is much worse, and
the domain tables still hold the fact.

**API** — 7 new routes on the two existing dynamic functions (no new Vercel
functions):

| Route | Purpose |
|---|---|
| `GET /academics/hierarchy` | the tree, one section, or one student |
| `GET /academics/publish` | publication readiness per exam-subject (new GET on an existing route) |
| `GET/POST /ops/assign` | candidates; assign **or replace** |
| `GET /ops/dashboard` | the principal's morning screen, one round-trip |
| `POST /ops/enrol` | bulk move, preview and commit on one code path |
| `GET/POST /ops/rollover` | preview → plan → commit |
| `GET/PUT /ops/settings` | the notice-SMS cap |
| `GET/POST/PATCH /ops/users` | search, create, deactivate |

**UI** — 7 new screens and a shared `view-states.ts`: principal dashboard,
academic drill-down (with assignment, replacement, bulk move and the student
drawer inside it), result publishing, invoice generation, SMS settings,
rollover, users.

### Important architectural decisions

1. **`group` stays a column, not a level.** The owner's brief draws Class 9 →
   Science → F as three levels; the schema has two, because `classes` is
   UNIQUE (tenant, level_no, stream, group). The API folds class rows by
   `level_no` and presents the groups beneath, so the school sees its own
   three-level tree over a schema that already existed. Adding a real group
   table would have been a second way to say the same thing.

2. **Assignment and replacement are one endpoint.** There is no moment when
   the school knows in advance which it is doing. Two endpoints would mean a
   client that guessed wrong either created a second open assignment or
   refused a legitimate change.

3. **A reason is required to close an assignment, and only to close one.**
   Enforced by a CHECK (`(ended_on IS NULL) = (end_reason IS NULL)`) and by
   the endpoint. A history of changes with no reasons is a list of dates.

4. **The atomic part lives in SQL.** Closing the old row and opening the new
   one cannot be two statements from the API: a failure between them leaves
   either a subject with no teacher of record or two open rows, and the
   partial unique index turns the second into an error at some unrelated later
   moment for somebody else.

5. **Re-assigning the same person is a no-op.** Otherwise a double-submitted
   form writes a zero-length stint into the history a parent will one day read.

6. **Preview and commit are one code path** (`dryRun`), so the preview cannot
   drift from the commit — which is the entire value of a preview.

7. **Capacity is a warning, not a refusal.** Bangladeshi sections run over
   their nominal capacity constantly; a system that blocks the move is one the
   school works around in week two.

8. **The dashboard's attendance denominator is the MARKED students, not the
   enrolled ones.** At 8:40am most sections have not been taken yet, and
   dividing by the whole school shows 4% and starts a panic. `percent: null`
   means "nobody has taken attendance yet" and the screen renders that as a
   sentence, never as 0%.

9. **The fee block is absent from the response, not hidden by CSS.** A
   coordinator's `finance` is `null` server-side. Hiding a card whose numbers
   are still in the body is the frontend-filtering pattern D13 rules out.

10. **No delete anywhere in R-3.** Users deactivate to `status = 'left'`;
    enrolments close; assignments close. `section_subject_teachers.teacher_id`
    is ON DELETE RESTRICT, so the database already held this opinion.

11. **Management reads are network-only in the service worker**, and that is
    the one considered exception in the strategy table. They are read
    IMMEDIATELY BEFORE a mutation, so a stale read means deciding against a
    school that is no longer there. The academic tree stays cached — it is
    navigation, it changes a few times a year, and drilling into it on a dead
    link is the corridor case offline exists for.

12. **Confirmation dialogues state the consequence in numbers.** Five
    irreversible actions (replace, bulk move, promote, publish, generate) each
    name what will happen — including the part that is wrong, like the three
    subjects still unmarked — rather than asking "are you sure?". Focus
    defaults to Cancel.

### Database changes

See 041 above. `schema_lint.sql` passes with **0 advisories**, including the
L7 index-prefix rule on both new indexes.

### API changes

8 routes, listed above. No new Vercel functions: both dispatchers already
exist, so the Hobby 12-function cap is untouched (still 10 of 12).

### UI changes

7 screens, 1 shared states module, dashboards for three more roles
(`it_admin`, `academic_coordinator`, and a rebuilt principal), 7 More-menu
entries, and a service-worker rule.

### Files created

- `db/migrations/041_assignment_history.sql`, `db/rollback/041_assignment_history.down.sql`
- `db/tests/assignment_history.sql`
- `packages/server-core/src/audit.ts`, `packages/server-core/test/audit.test.ts`
- `services/academics-svc/api/hierarchy.ts`
- `services/ops-svc/api/{dashboard,assign,enrol,rollover,settings,users}.ts`
- `apps/pwa/src/view-states.ts`
- `apps/pwa/src/{principal,academic,publish,invoice,admin-settings,rollover,users}-view.ts`
- `apps/pwa/test/admin-ui.test.ts`

### Files modified

- `services/academics-svc/api/publish.ts` (GET branch), `.../index.ts`
- `services/ops-svc/api/index.ts`, `services/sms-svc/src/dispatch.ts` (exported `NOTICE_SMS_MIN`)
- `apps/pwa/src/{app,demo,sw-router}.ts`
- `scripts/migration-status.mjs`, `.github/workflows/database.yml`
- `docs/{07-IMPLEMENTATION-STATUS,11-MASTER-PLAN,PHASE_LOG}.md`
- `api/v1/*.js` (rebuilt)

### Files removed

None.

### Tests added

- **`apps/pwa/test/admin-ui.test.ts` — 42 tests.** D13's four states are
  tested as behaviour, and the empty state gets the most attention because it
  is what a school sees on day one when every table is legitimately empty.
- **`db/tests/assignment_history.sql` — 13 assertions**, re-runnable, leaving
  no rows. The one that matters is #3: a replacement keeps the outgoing
  teacher's row, dates and reason.
- **`packages/server-core/test/audit.test.ts` — 6 tests**, the first of which
  asserts that a failing audit write does NOT throw.

### Tests executed

```
node --test  (11 workspaces)              709 passing, 0 failing
db/tests/assignment_history.sql           13/13 PASS · re-runnable
db/tests/schema_lint.sql                  PASS · 0 advisories
19 SQL suites                             all green
every R-3 endpoint query vs real schema   executed, 0 errors
rollback, descending                      0 objects left, app schema gone
up → down → up                            clean
scripts/migration-status.mjs              41/41 applied, 0 unprobed
tsc --noEmit ×3                           exit 0
npm run build                             ok · app.js 95 KB gz / 180 KB
D11 brand boundary                        green both directions
```

### Test results

**709 passing, 0 failing.** offline 46 · server-core 92 · ui-core 108 ·
academics-svc 78 · identity-svc 10 · ops-svc 26 · rms-svc 62 · sms-svc 13 ·
sync-svc 23 · **pwa 243** · netlify 8.

Running the endpoints' SQL against the real schema found **one real defect**,
the same way R-2's five were found: `users.full_name_en` is NOT NULL, and
`POST /ops/users` inserted `null` when no English name was given. It
typechecked, and it would have failed on the first teacher a Bangla-medium
school's office added — which is most of them. It now falls back to the Bangla
name rather than demanding a transliteration before the form will submit.

### Build / typecheck results

`npm run build` ok; `tsc --noEmit` clean in all three configurations; app.js
95 KB gzipped against the 180 KB budget (up from 78 KB — seven screens);
`git status` clean after a rebuild.

### Security validation

- Every new endpoint is role-gated with an allowlist that mirrors an RLS
  policy; RLS remains the enforcement and `requireRole` is the clean 403 in
  front of it.
- The two new SQL functions are **SECURITY INVOKER**, deliberately: a definer
  function here would be a way to assign teachers in a school you do not
  belong to. `db/tests/assignment_history.sql` #9 proves tenant B cannot
  assign into tenant A even naming real ids.
- No endpoint accepts a tenant parameter. There is nothing to get wrong.
- Phone search is EXACT; a prefix search over a PII column is a contact-list
  enumerator. The student drawer shows guardian name and relationship and
  **no phone number** — that screen is opened on every teacher's device.
- User creation never touches `password_hash` and returns no credential;
  first login stays on F-202's activation codes.
- Audit reads are management-only (`activity_read_scope`), tenant-scoped, and
  UPDATE/DELETE stay revoked. The suite asserts a subject teacher reads zero
  rows, and that the teardown DELETE is refused to the app role.

### Tenant-isolation validation

Executed, not asserted on paper. `db/tests/assignment_history.sql` covers
cross-tenant reads of sections, teachers, enrolments, assignments and the
audit log — all zero — and a cross-tenant WRITE, which raises. Schema lint 0
advisories; RLS coverage guard 0 gaps.

### Browser acceptance

Run against the real UI at `/app?demo=1`, per Part U, for **principal**, **IT
admin** and **student**. It found four things the tests did not:

1. **ISO dates among Bangla numerals** — the section screen printed
   `2026-01-05` beside `৪০ জন`. On the assignment-history rows the dates are
   the whole point of the record. Added `bnDate()`; now `৫ জানুয়ারি, ২০২৬`.
2. **The demo showed a student the entire institution's structure** — every
   section and every teacher's posting. The server refuses this
   (`requireStaff`); the demo skipped the gate. The demo was lying in the more
   dangerous direction: it is what a person is shown while deciding whether
   the product is safe. All R-3 demo endpoints now reproduce their server
   allowlists.
3. **The invoice screen drew a billing form for someone who could not
   submit it** — the invoice LIST is legitimately readable by a guardian for
   their own child, so the screen loaded. Added `canGenerate`, mirroring
   `BILLING_ROLES`.
4. **A permission error rendered ABOVE an empty state** — "you may not see
   this" followed by "there is nothing here", which are different claims and
   only one was true.

Verified working end to end: Class 9 → বিজ্ঞান → সেকশন F → ৪০ জন with 1 class
teacher, 5 subject teachers and the replacement record; the replacement flow
(confirmation naming both teachers, focus on Cancel, success stating the old
record survives); the SMS cap (৩ → ৬ segments, cost warning at ২.০ গুণ,
out-of-range refused); rollover (blocked students named, commit disabled);
publishing readiness; and the IT admin's dashboard with no finance block and
a read-only rollover.

### Known limitations

1. **The routine-solver discrepancy is documented, not "fixed"** (Part K).
   `POST /rms/solve` and `POST /rms/generation` are **not duplicates**:
   `generation` is the read the UI uses to show a produced routine and its
   trade-offs, and `solve` is the write that produces one. The generation
   screen is reached with `?routineId=`, i.e. it assumes a routine already
   exists. So `solve` remains **backend-only, reachable over the API**, and no
   screen triggers a solve. Nothing was removed or rewritten. It belongs with
   the RMS work, not here — building a second entry point into timetable
   generation from the admin portal is exactly the duplicate system Part K
   warns against.
2. **Section and class creation are not in the UI.** R-3 assigns people to
   existing sections; `app.provision_tenant()` creates the classes and the
   pilot runbook creates sections by hand. A school adding a seventh section
   mid-year still needs the runbook. This is the largest honest gap.
3. **Guardian management is read-only** (Part B). The student drawer shows
   guardians and their fee authority; linking a new guardian or changing
   `can_pay_fees` has no screen.
4. **No audit VIEWER.** 041 makes the log readable and the mutations write to
   it; F-1603's screen is not built. **Backend complete — UI pending.**
5. **The bulk move is capped at 200 students** per request. Beyond that the
   honest tool is the import wizard.
6. **Invoice generation has no dry run**, because the endpoint has none, and a
   client-side estimate would be a second implementation of fee structures and
   waivers that disagreed on exactly the students whose fees are unusual.
7. `scripts/test-all.mjs` still cannot run on Windows (pre-existing).

### Unresolved bugs / issues

None open. Two pre-existing defects were found and fixed: the phantom
`it_admin` role (R-1), and `users.full_name_en` NOT NULL (found by running
R-3's own SQL).

### Decisions that require owner input

- **Section creation** (limitation 2). It is the one remaining routine act a
  school cannot do without the runbook, and it is small — a form over
  `sections` — but it was not in R-3's brief. Worth folding into R-4 or
  taking as a short R-3.1.

### Next recommended step

**R-4 — Calendar & schedule surfacing.** Not started.


---

# 2026-08-29 · R-3-COMPLETION · The three gaps R-3 named in its own report

| | |
|---|---|
| **Date** | 2026-08-29 |
| **Phase ID** | R-3-COMPLETION |
| **Phase name** | Class/section creation, guardian linking, `can_pay_fees`, audit viewer |
| **Status** | ✅ Complete. R-3 is now fully closed; no capability is "Backend complete — UI pending". |
| **Migration number** | **042** — `db/migrations/042_structure_write_scope.sql` |
| **Rollback status** | ✅ `db/rollback/042_structure_write_scope.down.sql`. Loses SAFETY, not data: dropping these policies returns three tables to tenant-isolated-but-not-role-scoped. Safe only if the matching endpoints go with it, which a code deploy does and a database-only rollback does not. Stated in the file. Verified up → down → up with 0 objects left. |
| **Git commit** | `git log -1 --format=%H -- db/migrations/042_structure_write_scope.sql` |

### Objective

R-3's report named three things it had not delivered. This pass delivers
them, under the same D13 bar: class and section creation, guardian linking
with `can_pay_fees`, and the audit viewer.

### What was already existing

- The whole schema. `classes`, `sections`, `guardianships` and
  `audit.activity_log` all predate R-3; `uq_guardianship_primary` already
  enforced one primary guardian per student.
- 041's `activity_read_scope`, which made the audit log readable and which
  nothing displayed.
- R-2's `guardians_payers` audience, resolving through `can_pay_fees` — the
  column this pass gives a screen.

### The gap the screens exposed

Building them found something R-3 had not looked for.

`classes`, `sections` and `guardianships` carried **only** the PERMISSIVE
`tenant_isolation` policy that migration 010 applies in a loop to every table
with a `tenant_id`, plus the blanket
`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public`.

That is complete tenant isolation and **no role scope**. Any authenticated
session in a school — a subject teacher's, a student's — could have inserted a
class, renamed a section, or set `can_pay_fees` on somebody else's guardian.

It had been harmless only because nothing in the product wrote to those
tables: sections came from the pilot runbook and `guardianships` from the CSV
importer. The moment there is a screen there is a request, and this codebase's
rule is that RLS is the enforcement and `requireRole` is the clean 403 in
front of it. A screen whose only gate is the endpoint is the frontend-hiding
pattern D13 forbids, one layer down.

Migration 042 adds the RESTRICTIVE write scopes, and `db/tests/guardian_links.sql`
asserts them. The measure of how unexercised that write path was: of twenty
SQL suites, exactly **one** noticed — `ai_human_review.sql` had seeded a class
while `app.role` happened to be `subject_teacher`. The fixture was corrected,
not the policy; a test does not get to set the security model.

### What was implemented

**Database (042):** RESTRICTIVE INSERT/UPDATE/DELETE policies on `classes`,
`sections` and `guardianships`. SELECT is deliberately untouched —
`guardianships` is read by `app.can_see_student()`, `app.my_ward_ids()` and
the notice resolver on every guardian request, and narrowing it would break
R-2's fan-out and the guardian's own ward view. DELETE is `USING (false)` for
everybody: a class or section carries enrolment history, and a cascade would
take it. Plus `app.set_guardian_permissions()`, which demotes the old primary
and promotes the new one in one transaction.

**API:** `GET/POST /ops/structure` (year, class, section),
`GET/POST/PATCH /ops/guardians`, `GET /ops/audit`.

**UI:** `structure-forms.ts` (three forms, rendered inside the drill-down),
`guardian-panel.ts` (replacing R-3's read-only list), `audit-view.ts`.

### Important architectural decisions

1. **The class form does not offer an academic year, and says why.** The brief
   asked for one; `classes` does not have the column, and that is right — a
   class is a rung on a ladder ("নবম শ্রেণি, বিজ্ঞান") and the YEAR belongs to
   the section. A school does not create Class 9 again every January. Drawing
   a field for a value nothing stores is worse than its absence: it tells the
   office they set something. So the year is on the section form, where the
   column exists, and the class form carries a sentence explaining the split.

2. **No `is_active` on a class either**, for the same reason: the column does
   not exist. A class a school stops using simply stops having sections
   created for the new year.

3. **Search before create, on both sides.** The panel opens on a search box,
   and the server independently links an existing person when a "new"
   guardian's phone is already in the school. The default failure here is
   three rows for one father, one per child: three SMS for every notice on the
   channel that is 80% of the bill, and three logins each seeing one child.

4. **The phone number is withheld server-side, not hidden in the UI.** R-3
   established that a number on a screen every teacher can open is a number on
   every teacher's device, and has a test asserting it. This panel feeds that
   same drawer, so the endpoint returns `phone: null` to anyone outside the
   three roles that may edit it. Returning it and hiding it would leave it in
   the response body, one devtools tab away. The full-text SEARCH is
   restricted outright — it is how you enumerate a contact list.

5. **`can_pay_fees` states its consequence in words**, on the toggle and again
   in the success message ("ফি ও ইনভয়েসের বার্তা পাবেন না"). A permission whose
   effect is invisible is one nobody trusts and everybody works around.
   `db/tests/guardian_links.sql` #6 asserts the wire itself: revoking it drops
   the `guardians_payers` audience from 1 to 0 and restoring it brings it
   back. Without that assertion the screen could be a light switch wired to
   nothing, and nobody would find out until a parent said they were never told.

6. **The last primary guardian cannot be demoted into nobody.** The endpoint
   refuses when no other guardian exists. The primary is who the school rings.

7. **The audit viewer's diff shows only what CHANGED.** Twelve identical
   values with one difference buried among them is how a reader misses the
   difference.

8. **Redaction happens on the way out, not on the way in.** The log keeps what
   happened; the screen shows what a reader may see. A phone is masked to its
   last two digits rather than removed, because "changed to a number ending
   47" is what makes the entry useful.

### Database changes

Policies and one function; no new tables, no new columns. `schema_lint.sql`
passes with 0 advisories.

### API changes

3 new routes on the existing `ops` dispatcher. Still 10 of 12 Vercel
functions.

### UI changes

3 new modules, the guardian block of the student drawer replaced, an
`audit` route, a card and a More entry for the IT admin.

### Files created

- `db/migrations/042_structure_write_scope.sql`, `db/rollback/042_structure_write_scope.down.sql`
- `db/tests/guardian_links.sql`
- `services/ops-svc/api/{structure,guardians,audit}.ts`
- `apps/pwa/src/{structure-forms,guardian-panel,audit-view}.ts`
- `apps/pwa/test/completion-ui.test.ts`

### Files modified

- `packages/server-core/src/audit.ts` (5 new actions)
- `services/ops-svc/api/index.ts`
- `apps/pwa/src/{academic-view,app,demo,sw-router}.ts`
- `apps/pwa/test/admin-ui.test.ts` (the drawer's guardian block moved endpoint)
- `db/tests/ai_human_review.sql` (fixture seeded as principal — see above)
- `scripts/migration-status.mjs`, `.github/workflows/database.yml`
- `docs/{07-IMPLEMENTATION-STATUS,11-MASTER-PLAN,PHASE_LOG}.md`
- `api/v1/*.js` (rebuilt)

### Files removed

None.

### Tests added

- **`apps/pwa/test/completion-ui.test.ts` — 29 tests.**
- **`db/tests/guardian_links.sql` — 12 assertions**, re-runnable, leaving no
  rows. Three of them are the write-scope gap: a subject teacher can create
  neither a class nor a section, and cannot change a fee permission — while
  still being able to READ the guardianship, because the notice resolver
  depends on it.

### Tests executed

```
node --test  (11 workspaces)              738 passing, 0 failing
db/tests/guardian_links.sql               12/12 PASS · re-runnable
20 SQL suites, run twice                  all green both passes
every completion-pass query vs real schema executed, 0 errors
rollback, descending                      0 objects left, app schema gone
up → down → up                            clean
scripts/migration-status.mjs              42/42 applied, 0 unprobed
schema lint                               0 advisories
tsc --noEmit ×3                           exit 0
npm run build                             ok
```

### Test results

**738 passing, 0 failing**, up from 709. pwa 243 → **272**.

Running the endpoints' SQL against the real schema found **one real defect**,
as it did in both previous passes: the audit list's actor filter was
`($3 = '' OR a.actor_id = $3::uuid)`, and PostgreSQL evaluates the constant
cast at plan time, so an empty filter threw *invalid input syntax for type
uuid*. The no-filter case is the DEFAULT view of that screen — **every first
load would have been a 500**. It typechecked, and reading it did not reveal
it; running it did. Filters now pass NULL.

The full regression also caught a genuine conflict rather than a broken test:
the new guardian panel showed phone numbers in a drawer any staff member can
open, contradicting R-3's own privacy assertion. Fixed at the server, not in
the UI.

### Security validation

- 042's policies are asserted from a subject teacher's session, not reasoned
  about: three separate attempts, all refused, with the READ still working.
- `app.set_guardian_permissions()` is SECURITY INVOKER; the suite proves
  tenant B cannot write a link into tenant A while naming real ids.
- The audit endpoint is GET-only, over a table where UPDATE and DELETE stay
  revoked; the UI test asserts no control offers to write.
- Redaction is by key name, not by sniffing values — a sniffer misses a phone
  stored as a number and mangles a roll number that looks like one.
- Guardian phone numbers: withheld server-side outside three roles; the
  candidate SEARCH is restricted outright.

### Tenant-isolation validation

Executed. `db/tests/guardian_links.sql` #7 and #8: tenant B reads zero of
tenant A's guardian links, classes, sections (by id) and audit rows, cannot
write a link into A, and A's records are then verified unchanged from A's own
context.

### Browser acceptance

Run at `/app?demo=1` for it_admin, academic_coordinator, class_teacher and
student.

Verified working: creating a class (the Bangla name follows the level chosen,
and stops once typed over) → creating a section → both appearing in the
hierarchy; the guardian panel with its duplicate warning; revoking
`can_pay_fees` and getting *"মোঃ আব্দুল করিম এখন থেকে ফি ও ইনভয়েসের বার্তা
পাবেন না"*; the audit viewer with three data-built filters, a date range, a
diff showing only the changed field, and a masked `•••47`.

Authorization, in the browser: a class teacher gets no create bar, a refused
audit page naming who may read it, guardian names but **no phone and no
toggles**; a coordinator may create structure but the guardian panel is
read-only for them — exactly matching 042.

### Known limitations

1. **Editing an existing class or section is not in the UI.** 042 permits the
   UPDATE and no screen uses it: renaming a section, or changing its capacity
   after creation, still needs SQL. Creation was the gap R-3 named; editing is
   a smaller, adjacent one and is now the largest remaining.
2. **Unlinking a guardian is impossible by design** (`USING (false)`). A
   genuine data-entry error needs a support request. Correcting the
   permissions and the primary flag covers the real cases.
3. **The audit viewer has no export.** A school asked for a change history by
   a board inspector reads it on screen.
4. **The audit entity id is shown raw**, not resolved to a name — "section
   9e52…" rather than "সেকশন F". Resolving would mean a join per entity type.
5. `scripts/test-all.mjs` still cannot run on Windows (pre-existing).

### Unresolved bugs / issues

None open. Two pre-existing defects fixed: the missing write scope on three
tables, and the audit filter's uuid cast.

### Decisions that require owner input

None outstanding.

### Next recommended step

**R-4 — Calendar & schedule surfacing.** Not started.


---

# 2026-08-29 · R-4 · The academic calendar

| | |
|---|---|
| **Date** | 2026-08-29 |
| **Phase ID** | R-4 |
| **Phase name** | Calendar & schedule surfacing |
| **Status** | ✅ Complete. No applicable D13 cell is incomplete. |
| **Migration number** | **043** — `db/migrations/043_calendar.sql` |
| **Rollback status** | ✅ `db/rollback/043_calendar.down.sql`. Loses `description_bn` and `created_by` on every entry, collapses any day holding two entries of one kind (oldest kept, deterministically), and — the dangerous part — returns `calendar_days` to tenant-isolated-but-not-role-scoped. Safe only if ops-svc/api/calendar.ts is rolled back with it. Stated in the file. Verified up → down → up, 0 objects left. |
| **Git commit** | `git log -1 --format=%H -- db/migrations/043_calendar.sql` |

### Objective

প্রতিটি প্রতিষ্ঠান তার নিজের শিক্ষাপঞ্জি চালাবে — ছুটি, অনুষ্ঠান, পরীক্ষা — এবং সব
ভূমিকা সেটা দেখবে। One deployment, and Monipur's Friday-Saturday weekend
alongside a Madrasah's Friday-only one.

### What was already existing

- **`calendar_days`**, since migration 003: tenant, academic year, day, kind
  (holiday / exam / event / ramadan_schedule / working_weekend), `title_bn`,
  `applies_to_shifts`. **Never had a screen.**
- It was already load-bearing. `services/sms-svc/src/dispatch.ts` reads it
  **twice** to suppress attendance and notice SMS on holidays. A row in this
  table already stops messages reaching nine hundred guardians.
- **`tenants.weekend_days smallint[]`** (0=Sun … 6=Sat, default {5,6}), with a
  comment noting many Madrasah run {5}. The per-tenant weekend the brief asks
  to reuse, and it already existed.
- `exams.starts_on/ends_on` and `exam_subjects.exam_date` — the authoritative
  exam dates.
- R-2's `app.emit_auto_notice()`, idempotent on (tenant, source_kind,
  source_ref).

So: **no new table**, and the feature is mostly a read path over things that
were already true.

### The gap the screen exposed

The same shape R-3 found on `classes` and R-3's completion pass found on
`guardianships`: `calendar_days` carried only the PERMISSIVE
`tenant_isolation` policy that 010 applies in a loop, plus the blanket GRANT.
Complete tenant isolation, **no role scope**.

Here it is worse than it was for classes. **A student could have inserted one
row with kind='holiday' and silently suppressed the whole school's attendance
SMS for that day** — the suppression query does not care who wrote the row.
Nothing had exercised it because nothing in the product wrote to the table.

That is now three phases in a row where adding a screen revealed a table with
no write scope. The pattern is worth naming: migration 010's loop gives every
tenant table isolation, and role scope is added per-table by whoever builds
the feature — so any table the product only ever READ has been sitting
unscoped. R-5 should assume the same is true of whatever it touches first.

### What was implemented

**Migration 043:** `description_bn`, `created_by`, `created_at/updated_at`;
the UNIQUE constraint gains `title_bn` so two events can share a day;
RESTRICTIVE INSERT/UPDATE/DELETE scopes; `notices_source_kind_check` widened
by one value.

**`services/ops-svc/api/calendar.ts`:** GET (range + filter), POST, PATCH,
DELETE. Reads open to every role; writes to the four structural roles.

**`apps/pwa/src/calendar-view.ts`:** month grid, day panel, upcoming list,
kind filter, create/edit form, delete confirmation.

### Important architectural decisions

1. **Exams are read, never copied.** The response merges `calendar_days` with
   `exams` and `exam_subjects` at read time, flagged `editable: false`. A
   calendar row per exam would be a second source of truth that goes stale the
   first time a coordinator moves a paper. `db/tests/calendar.sql` #9 asserts
   that `calendar_days` holds **zero** rows of kind 'exam' while an exam
   exists.

2. **No start/end time columns, deliberately.** The brief asks for them "where
   supported". Every consumer of this table is date-grained: the SMS
   suppression asks "is this day a holiday", attendance asks the same, the
   grid draws a day cell. A `start_time` nothing reads would be a field the
   office fills in and no part of the product honours — worse than its
   absence, because they would plan around it.

3. **No audience column either.** `applies_to_shifts` already exists and is
   the audience this schema has; a morning-shift-only holiday is a real
   Bangladeshi case. Addressing a subset of PEOPLE is what notices are for,
   and R-2 already does it properly.

4. **The academic year is derived from the date, not trusted from the
   client.** A misfiled holiday is a day the school thinks is a holiday and
   the system does not. A date outside every year is refused with "create the
   year first" rather than guessed at.

5. **DELETE is permitted here and forbidden on classes/sections (042).** A
   calendar entry is a PLAN: nothing references it, no history hangs off it,
   and a holiday on the wrong date must be withdrawable without a support
   request. The audit log keeps who removed it.

6. **Notifying goes through `app.emit_auto_notice`** — the same function the
   exam-routine, results and invoice emitters use, idempotent on
   (kind, ref), so a double-submitted form announces nothing twice. Not a
   second pipeline. `notices.source_kind` gained 'calendar' as one deliberate
   value; the allowlist stays an allowlist, and it caught this very insert
   during development when the value was unrecognised.

7. **Deleting a holiday warns that the day's SMS resumes.** The screen names a
   consequence nobody would guess from "delete".

### Offline

**Reads are offline-readable; writes are online-only, deliberately.**

The service worker caches `/api/v1/ops/calendar` stale-while-revalidate,
exactly like the inbox and the routine — a teacher opening the calendar on a
dead link sees the month they last loaded.

Writes are NOT queued through the IndexedDB outbox. That outbox exists for
attendance and marks, which a teacher genuinely takes in a room with no
signal. An IT admin declaring next month's holiday from a corridor with no
bars, to be applied whenever the phone reconnects, is not a workflow — and a
queued holiday is one that silently suppresses SMS on a day nobody has agreed
to yet. Documented rather than claimed either way.

### Real-time

**Not implemented, and there is no infrastructure to reuse.** The brief says
"use the existing event/WebSocket infrastructure where practical"; there is
none — R-2's own entry records that the notice bell refreshes on navigation
for the same reason (a polling timer on 2G costs more than the freshness is
worth). A calendar entry created while a guardian has the app open appears on
their next navigation. Consistent with the rest of the product rather than a
one-screen exception.

### Database changes

Columns, one constraint swap, three policies, one CHECK widened. No new table.
`schema_lint.sql` passes with 0 advisories.

### API changes

One new route on the existing `ops` dispatcher — still 10 of 12 Vercel
functions. DELETE was added to the dispatcher's write-bucket rate limiting.

### UI changes

One new view, one route registered for **every** role, a dashboard card on all
five dashboards, a More entry, a `calendar` glyph added to `icon.ts`, and the
`.cal-*` block in app.css.

### Files created

- `db/migrations/043_calendar.sql`, `db/rollback/043_calendar.down.sql`
- `db/tests/calendar.sql`
- `services/ops-svc/api/calendar.ts`
- `apps/pwa/src/calendar-view.ts`, `apps/pwa/test/calendar-ui.test.ts`

### Files modified

- `packages/server-core/src/audit.ts` (3 actions)
- `services/ops-svc/api/index.ts`
- `apps/pwa/src/{app,demo,sw-router,icon}.ts`, `apps/pwa/public/app.css`
- `scripts/migration-status.mjs`, `.github/workflows/database.yml`
- `docs/{07-IMPLEMENTATION-STATUS,11-MASTER-PLAN,PHASE_LOG}.md`
- `api/v1/*.js` (rebuilt)

### Files removed

None.

### Tests added

- **`apps/pwa/test/calendar-ui.test.ts` — 30 tests**, passing on the first
  run. The weekend group is the multi-tenant property: Fri+Sat for one school
  and Friday only for a Madrasah, from the same code.
- **`db/tests/calendar.sql` — 14 assertions**, re-runnable. #1 is the one
  that matters: a student cannot declare a holiday.

### Tests executed

```
node --test  (11 workspaces)              768 passing, 0 failing
db/tests/calendar.sql                     14/14 PASS · re-runnable
21 SQL suites, run twice                  all green both passes
every R-4 endpoint query vs real schema   executed, 0 errors
rollback, descending                      0 objects left, app schema gone
up → down → up                            clean
scripts/migration-status.mjs              43/43 applied, 0 unprobed
schema lint                               0 advisories
tsc --noEmit ×3                           exit 0
npm run build                             ok · app.js 107 KB gz / 180 KB
D11 brand boundary                        green both directions
```

### Test results

**768 passing, 0 failing**, up from 738. pwa 272 → **302**.

Running the endpoint's SQL against the real schema found **two defects**, as
every pass since R-2 has:

1. `exam_status` has no value 'scheduled' (it is planned / ongoing / marking /
   moderation / published / locked) — in the test fixture.
2. **`notices.source_kind` rejected 'calendar'.** R-2 constrained it to three
   values, so the entire notify feature would have thrown at runtime. The
   constraint doing its job, and the argument for keeping it an allowlist.

The build's own View-tree-shake guard caught a third: the route wiring did not
land (a CRLF mismatch in a scripted edit), so `CalendarView` was absent from
the bundle. That guard exists because exactly this shipped once before — see
the `guardian` route comment in app.ts.

### Security validation

- 043's write scopes are asserted from a student's and a teacher's session,
  not reasoned about: the student's INSERT raises, the teacher's UPDATE and
  DELETE match zero rows, and both can still READ.
- Reads are deliberately open to every role including guardians; there is no
  `requireStaff` on the GET, and that is a decision, not an omission.
- The description is rendered with `textContent`, never `innerHTML`.
- The range is bounded at 400 days so one request cannot scan a decade.

### Tenant isolation

Executed. `db/tests/calendar.sql` #5 and #6: tenant B reads zero of tenant A's
entries, cannot read A's entry **by id**, and its UPDATE and DELETE against
that id both match zero rows — then A's entry is verified unchanged from A's
own context. Two tenants also hold two different weekends (#4).

### Browser acceptance

Run at `/app?demo=1` with two demo tenants.

- **Tenant A (Fri+Sat):** grid shades শুক্র and শনি; holiday ১০ অক্টোবর with a
  rule and an amber dot; **two events on ১৫** both listed; exams merged in
  from the exam tables.
- **Tenant B (Friday only):** shades **শুক্র only**, shows its own ঈদে
  মিলাদুন্নবী, and **none of tenant A's entries**.
- An exam entry has no edit/delete control and says "পরীক্ষার রুটিনে যান".
- Create form: no time field, shift checkboxes (two-shift school), SMS
  disabled until notify is ticked, validation in place, notify confirmation
  focused on Cancel.
- class_teacher, student and guardian: can read, no create button, no edit
  controls.
- Mobile 375×812: no horizontal scroll, 48px tap targets, 31 cells.

Looking at it found one real defect the tests did not: the holiday marker was
an inset box-shadow, which follows the border-radius and rendered as a curved
"U" rather than a rule — decoration where a marker was intended. Now a
square-cornered `border-bottom`.

### Known limitations

1. **No real-time push** — see above; there is no infrastructure to reuse and
   R-2 made the same call.
2. **Calendar writes are online-only**, by the reasoning above.
3. **No recurring events.** ঈদ moves every year and a school enters it once a
   year anyway; a recurrence rule would be a lot of machinery for a table
   whose rows are typically entered in one sitting each January.
4. **`working_weekend` is storable and not yet honoured** by the attendance
   or SMS readers, which only ask about `kind = 'holiday'`. The kind predates
   R-4 and R-4 did not add the reader. It appears in the form because it is a
   real thing a school records; it does not yet change behaviour. **Backend
   partial — reader pending**, and worth an R-5 or R-6 item.
5. **No import of national holidays.** Every school types its own ঈদ dates.
6. **The month view fetches one month at a time**, so a year overview is
   twelve requests. Fine on the SWR cache, wasteful on a first load.

### Carried backlog from R-3 (recorded, not blocking)

- class/section **edit** UI — 042 permits the UPDATE, no screen uses it
- guardian **unlink** workflow — DELETE is `USING (false)` by design
- audit viewer: **export**, and entity-id → name resolution
- `POST /rms/solve` stays API-only by the explicit R-3 decision

### Unresolved bugs / issues

None open.

### Decisions that require owner input

- **`working_weekend`** (limitation 4): should a "working weekend" row make
  attendance and SMS treat that Friday as a school day? It is a small reader
  change and a real Bangladeshi case (make-up days after floods), but it
  changes when SMS goes out, so it is the owner's call.

### Next recommended step

**R-5 — Branded print & document engine.** Not started.


---

# 2026-08-29 · R-4.1 · Working weekends stop being decoration

| | |
|---|---|
| **Date** | 2026-08-29 |
| **Phase ID** | R-4.1 |
| **Phase name** | Working-weekend integration (R-4 completion pass) |
| **Status** | ✅ Complete. R-4's one open owner decision is resolved. |
| **Migration number** | **none — deliberately.** See below. |
| **Rollback status** | n/a — no schema change. |
| **Git commit** | `git log -1 --format=%H -- services/sms-svc/src/dispatch.ts` |

### Objective

R-4 shipped with one honest gap, recorded as needing an owner decision:
`calendar_days.kind = 'working_weekend'` was **storable and honoured by
nothing**. The owner has decided it should behave as a real override, so this
pass makes it one.

### Why no migration

The `kind` CHECK has admitted `working_weekend` since migration 003; 043 gave
the table its RESTRICTIVE write scope, which covers this kind exactly as it
covers holidays; the read scope is already open to every role; and
`ix_calendar_day (tenant_id, day)` already serves the lookup. There was
nothing left to add. The whole change is one rule and one widened `IN` list —
which is what "reuse the existing source-of-truth tables" should look like
when the schema was right the first time.

### What was found first

The suppression logic existed **twice**, in `services/sms-svc/src/dispatch.ts`:
once in `suppressionReason()` for attendance SMS, once inline in the notice
sender. Both did the same two things in the same order — weekend, then
holiday — as two independent copies.

That is exactly how they would have drifted the moment one of them learned
about working weekends, so the first move was to collapse them into one
exported function before teaching it anything new.

**And a second finding, which is the more useful one: nothing has ever
blocked ATTENDANCE.** There is no calendar check on the attendance path,
online or offline; a teacher could always take a register on any date. So
"attendance remains operational on a working weekend" was already true and
R-4.1 changes nothing about it. What was broken was narrower and worse: the
register taken on that Saturday produced an `attendance.marked.v1` event, and
the sender then threw it away as 'weekend'. The school worked, the children
were marked absent, and no guardian was told.

The suite asserts this rather than assuming it — a teacher takes a register on
the make-up Saturday and the outbox event is verified present.

### The rule

`nonWorkingReasonFor(isoDay, weekendDays, overrides)`, pure and exported so
the decision is testable without a database:

```
holiday                     → closed, whatever else the date says
weekend + working_weekend   → OPEN
weekend                     → closed
otherwise                   → open
```

**Holiday beats working weekend**, deliberately. The schema permits a date to
carry both, because they are different rows; that is a data-entry
contradiction, and the conservative resolution is the right one —
suppressing a message that should have gone is a smaller harm than sending
nine hundred SMS on a day the school is shut, and a declared holiday is the
more specific statement about that date.

### What it does NOT touch

**The timetable.** `rms-svc/solve.ts` derives teaching days from
`tenants.weekend_days` to build a WEEKLY template. A working weekend is one
date, not a change to the week, and a solver that rebuilt the routine because
of a single make-up Saturday would be answering a question nobody asked.

**Attendance.** As above: nothing blocked it, and nothing now does.

### Files changed

- `services/sms-svc/src/dispatch.ts` — two duplicated checks collapsed into
  `nonWorkingReasonFor()` + `calendarOverrides()`; the holiday lookup widened
  its `IN` list, so the new rule costs **no extra round trip**.
- `services/sms-svc/test/notice-sms.test.ts` — +9 tests on the pure rule.
- `apps/pwa/src/calendar-view.ts` — `dayState()` returning one of four
  states; `data-state` on each cell; a legend; the effect written on the
  entry card; a delete warning that is the mirror of a holiday's.
- `apps/pwa/public/app.css` — `.cal-working` (which must actively UNDO the
  weekend shading) and `.cal-legend`.
- `apps/pwa/test/calendar-ui.test.ts` — +10 tests.
- `db/tests/calendar.sql` — +8 assertions (14 → 22).
- `apps/pwa/src/demo.ts` — a make-up Saturday in the fixture.
- `docs/{07,11,PHASE_LOG}`.

### Tests executed

```
node --test  (11 workspaces)   787 passing, 0 failing
db/tests/calendar.sql          22/22 PASS · run twice, 0 rows left
21 SQL suites, twice           all green both passes
schema lint                    0 advisories
migration-status               43/43, unchanged (no migration)
tsc --noEmit ×3                exit 0
npm run build                  ok · app.js 107 KB gz / 180 KB
D11 brand boundary             green both directions
```

**787 passing**, up from 768. sms-svc 13 → 22, pwa 302 → 312.

Writing the SQL assertions surfaced three fixture defects, all of the kind
only running finds: `attendance_mode` is `section_daily`/`period_wise` (not
'daily'), `attendance_sessions.id` has **no default** because a session is
created offline on the device and carries a client-generated uuid through the
outbox, and `taken_at`/`marked_at` are NOT NULL without defaults for the same
reason. A fourth was mine: `String.replace` treats `$$` in the REPLACEMENT as
an escaped `$`, so the scripted splice silently ate every dollar-quote in the
appended SQL.

### Security and tenant isolation

- A student cannot declare a working weekend — asserted, and the stakes are
  the mirror of a holiday's: it would make the school text nine hundred
  guardians on a Saturday nobody worked.
- A teacher reads it and cannot change it — asserted.
- The override applies to **exactly one date**: the adjacent Friday and the
  following Saturday are verified unaffected.
- **Cross-tenant**: tenant B's sender, running the sender's own query for the
  same date, sees nothing — and naming tenant A's `tenant_id` in the
  predicate still returns zero rows, because RLS is the boundary and not the
  WHERE clause. The specific harm avoided: Monipur's make-up Saturday must
  not start the Madrasah next door texting on its quiet day.

### Browser verification

Tenant A, October 2026. The make-up Saturday (১৭) renders **unshaded with a
green top rule and a bold numeral** inside the shaded শনি column, while the
plain Saturday (২৪) stays shaded, unruled and normal weight — three signals,
not colour alone. Measured: `rgb(35,33,32)` vs `rgb(44,42,41)`, 2.67px vs
0.67px top border, weight 700 vs 400.

The accessible name says "সাপ্তাহিক ছুটির দিনে খোলা" and does **not** also
announce the weekly holiday. The legend lists only the states present in the
month. The card explains that the day counts as a normal working day and the
SMS will go out; deleting it warns that the day goes quiet again. A read-only
role sees all of it and can change none of it. Mobile 375×812: no sideways
scroll.

### Known limitations

1. **`ramadan_schedule` remains descriptive.** Like `working_weekend` before
   this pass, it is storable and honoured by nothing — it would need to shift
   period times, which is a routine concern, not a suppression one. Recorded
   so it is not rediscovered as a surprise.
2. **The routine is untouched** on a working weekend: the timetable has no
   Saturday column for a Fri+Sat school, so a make-up day runs on a
   schedule the school arranges outside the app. Making the solver
   date-aware is a much larger change and belongs with RMS.
3. **Holiday-beats-working-weekend is not enforced at write time.** The UI
   does not stop an office adding both to one date; the sender and the
   calendar simply agree on which wins. A CHECK could forbid it, but the
   two are separate rows and a partial exclusion constraint for one
   data-entry mistake is more machinery than the mistake deserves.

### Carried backlog (unchanged, from R-3)

class/section edit UI · guardian unlink workflow · audit export and
entity-name resolution · `POST /rms/solve` API-only by decision.

### Unresolved bugs / issues

None open. R-4 has no remaining owner decisions.

### Next recommended step

**R-5 — Branded print & document engine.** Not started.

---

# 2026-08-29 · R-5 · Branded print & the document engine

**Status: complete.** Six documents, one renderer, one endpoint, one screen.
Every document a school hands a family now comes out on that school's
letterhead, and the same code produces a different school's.

## What was asked, and what "one renderer" bought

The brief's first constraint was the load-bearing one: *one reusable
renderer, not a separate PDF implementation per document type*. R-1 had
already built the letterhead (`brandedLetterhead`, `brandedSignature`,
`brandedDocumentCss`) and a single-page `brandedDocument`. R-5 extracted the
page shell into `docSection()` and added `brandedDocumentSet()`, so one page
and forty pages travel the same path; `brandedDocument` is now a one-section
call to the set. R-1's thirteen tests still pass unchanged, which is the
check that the refactor did not quietly become a rewrite.

The six builders in `packages/ui-core/src/documents.ts` are pure functions
returning `{title, meta, bodyHtml}`. They do not know about tenants, HTTP or
the database. That is what makes 45 unit tests able to assert the thing that
actually matters — that two institutions' documents never mix — without a
server.

## Print-first, and no bucket

`GET /api/v1/ops/document` returns **HTML**, not PDF. The master plan says
print-first — `window.print()` plus print CSS — with server-side PDF "only
where a stored artifact is required". Nothing requires one:
`payment_receipts.pdf_object_key` exists and stays NULL because the object
storage behind it is stubbed pending an R2/S3 credential, the same stub as
OTP and MFS.

This is a scope line, not an omission, and it satisfies the brief's "do not
put large PDFs in PostgreSQL" by having no PDF to put anywhere. The browser's
own Save-as-PDF produces the file a school needs from the same markup. When
the credential lands, this endpoint's output is what gets rendered
server-side; the markup does not change.

## The tenant is not a parameter

The brief: *never accept an arbitrary `tenant_id` from the browser as the
authority for document branding.*

Branding is read inside `withTenant()` with

    SELECT COALESCE(settings->'branding','{}'::jsonb) FROM tenants

— no WHERE clause, because a session sees exactly one `tenants` row. There is
no tenantId in the query string, the body or a header, so a Tenant A user
cannot render on Tenant B's letterhead: not because a check rejects it, but
because the request cannot express it. `db/tests/documents.sql` asserts both
halves — the query returns one row and the right one, and naming the other
tenant's id explicitly still returns nothing.

No second branding table was created. `tenants.settings->'branding'` from R-1
remains the single source, per the brief.

## The bug this phase found: printing is not reading

`users_scope` in migration 010 ends with `OR app.is_staff()` — the staff
directory is visible to staff, which is correct for a directory. Every
document builder is fed by `loadStudents`, which selects from `users`. So as
first written, a **subject teacher could print a letterheaded admit card,
report card or ID card for any child in the school**, including that child's
roll, parents' names and blood group — for a section they do not teach. The
marks would have been blank (`exam_results` is section-scoped) but the
document, the identity and the seat would not.

Reading a colleague's name in a list and printing an official document about
a child are different acts. The printed surface is now deliberately tighter
than the directory: `loadStudents` adds `AND app.can_see_student(u.id)`, the
predicate that already existed for exactly this question — `true` for
principal, owner, coordinator, dept head, accountant and IT admin; narrowed
to own wards, own record or own sections for guardians, students and
teachers. An id a caller may look up but not print for simply produces no
page, and a request for nothing but such ids 404s.

The attendance sheet is the one document that is a *section* rather than a
set of students, so it cannot lean on that filter. It asks the same question
directly and returns **403 rather than an empty grid** — a branded but blank
register would have looked like a working feature.

Tests 5 and 6 of `db/tests/documents.sql` are a pair on purpose: test 5
proves the directory hole is real, so that the guard in test 6 is not deleted
later as belt-and-braces.

## The other defects, all found by running or looking

1. **The receipt printed `2026-05` as the billing month**, and dated itself
   with `formatShortDate` — which is documented as the *SMS* short form,
   where every character costs money, and drops the year. §18 of the brief
   forbids raw ISO dates in official documents. Fixed with local `date()`
   and `monthLabel()` helpers, giving `১২ মে ২০২৬` and `মে ২০২৬`. Caught by a
   test that sweeps whole documents for date-shaped text.
2. **`exam_halls` has no `name_bn`.** It points at a `rooms` row, which is
   where the code a candidate reads on the door lives. Found by running the
   admit-card query against the real schema rather than reading it.
3. **Three of my own tests were over-broad**, matching class names inside the
   inlined stylesheet rather than elements — `doc-sign-img` appears as a CSS
   rule whether or not an `<img>` does. They now assert on elements. A test
   that fails on correct output is worse than no test.
4. **The ID-card doc comment claimed the card skips the A4 letterhead.** The
   render showed it plainly does not. The comment was wrong, not the code;
   see Known limitations.

## The tooling was lying, and had been for some time

Running the quality gate on Windows produced eleven identical `FAIL` lines
with no output. Two faults, one hiding the other:

1. `execFileSync('npm', …)` cannot spawn `npm.cmd` (ENOENT, then EINVAL once
   given the extension — Node ≥20 refuses `.cmd` without a shell). Now
   `execSync('npm test --silent')`.
2. Worse and quieter: every workspace's script was
   `node --test 'test/*.test.ts'`. A POSIX shell strips those quotes; **cmd
   passes them through literally, nothing matches, and node exits 0 having
   run zero tests.** On Windows the whole suite reported success while
   running nothing — precisely the invisible-tests failure `test-all.mjs`
   exists to prevent, in that script's own tooling. All eleven are now
   double-quoted, which both shells strip and node globs for itself.

The runner now prints `0 tests — NOTHING RAN` instead of a tick, because
"ok 0 tests" and "ok 153 tests" looked identical. It is not a hard error:
zero is legitimate for the DB-backed suites when `DATABASE_URL` is unset.
Linux CI never saw either fault.

## Authorization

`ACCESS` in `services/ops-svc/api/document.ts` is a per-type allowlist —
money documents follow finance-svc's `BILLING_ROLES`, result documents follow
the publish gate plus class teachers, and the **transfer certificate is
principal-only**, deliberately narrower than the rest, because it is a legal
statement about a child's record. The list decides who may *ask* for a type;
RLS plus `can_see_student` decides *which children* they get.

`apps/pwa/src/app.ts` mirrors the list in `DOCS_FOR`, so the picker offers a
student exactly three documents and a principal six. The demo layer
reproduces the 403 rather than skipping it — a demo that let a guardian print
a transfer certificate would teach the wrong thing about the product.

No arbitrary document URLs exist: the response is `no-store, private`,
`nosniff`, `SAMEORIGIN`, and the preview is an **iframe `srcdoc`, not a
`src`**. A URL would have needed a cookie or a token in the query string,
which §15 forbids; `srcdoc` means the bytes arrive with the caller's bearer
token and never become an address. The iframe's sandbox is
`allow-same-origin allow-modals` — `allow-scripts` is deliberately absent, so
a hostile string that survived escaping still cannot run.

No CSS or HTML injection is offered to tenant admins. Branding is a fixed set
of typed fields from R-1; every interpolation goes through `escapeHtml`,
including the ones that obviously cannot contain markup, because that
judgement is what rots. Two tests attack it — a hostile institution name and
a hostile student name.

## Tests

- **45 new unit tests** (`packages/ui-core/test/documents.test.ts`), two
  fixture tenants plus a bare one: neither leaks into the other, no ISO date
  or raw billing period reaches a document, a missing logo, watermark or
  signature degrades rather than breaking, markup injection is escaped, and
  forty report cards are forty fully-branded pages.
- **12 new SQL assertions** (`db/tests/documents.sql`), wired into
  `.github/workflows/database.yml` including the idempotency re-run. It
  pre-cleans as well as tears down, so a failed run reports the real failure
  instead of a duplicate key. Verified re-runnable, twice, leaving nothing.
- Full gate: **832 tests across 11 workspaces, all passing**, against a real
  PostgreSQL 16. All nine SQL suites green. `tsc` clean, `npm run build` ok,
  D11 guard green in both directions.

`packages/ui-core/src` was added to the D11 tenant-facing list: it is where
every document template now lives, and a printed transfer certificate is the
most tenant-facing surface the product has.

## Browser verification — two tenants, four documents each

Rendered through the real builders and the real `brandedDocumentSet`, and
looked at.

- **Report card, side by side.** Same student, same marks, same code.
  Shahjalal: green `#156a3f`, Sylhet address, মোঃ আব্দুল কাদের. North City:
  navy `#1b3e7a`, Uttara address, অধ্যাপক সালমা বেগম. Zero trace of either
  in the other; no `shikhon` anywhere in the markup.
- **Bulk**: a 38-student section produced 38 `<main class="doc">`, 38
  letterheads and 38 signature blocks in **one** request and one document.
- **Degradation**: both demo tenants have no watermark and no signature
  image. No `<img src="">` was emitted; the signature became a gap plus a
  rule, so the head signs by hand. The ID-card photo is a labelled frame
  reading ছবি, not a broken-image box.
- **Localisation**: marks, rolls, percentages and dates in Bangla digits;
  the absent subject reads অনুপস্থিত, not a zero. Latin digits appear only
  in phone numbers, email addresses and the student code — all of which are
  Latin on purpose.
- **The transfer certificate** reads as a formal Bangla certificate
  (এই মর্মে প্রত্যয়ন করা যাইতেছে যে…) with every date spelled out.
- **Print**: `@page {size:A4}`, `.doc+.doc{page-break-before:always}`,
  `thead{display:table-header-group}` so a long table repeats its header,
  `page-break-inside:avoid` on rows and the signature block, and
  `@media print { body > .shell { display:none } }` so the app chrome does
  not print. All five verified in the live document, not in the source file.
- **Role gate**: as `student`, the picker offers ফি রসিদ, প্রগতি পত্র and
  প্রবেশপত্র — and nothing else. As `principal`, all six.

## Known limitations

1. **One ID card per A4 sheet.** A section of 38 is 38 sheets to cut up.
   Laying several to a page needs a second page geometry the renderer does
   not have, and inventing one would mean a second print path to keep
   correct. A decision, not an oversight — and the doc comment that wrongly
   claimed ID cards skip the letterhead has been corrected to say so.
2. **Money is printed in Latin digits** (`৳ 1,300.00`) while rolls and marks
   are Bangla, because `formatBdt` is the product-wide money formatter shared
   with SMS and invoices. Making documents differ would mean a receipt and
   the SMS about the same payment disagreeing on how to write the amount.
   Consistent, but it is a real design question and R-5 should not answer it
   silently — flagged for a decision.
3. **No server-side PDF and no stored artifact**, per the section above.
   Nothing in the product needs one yet.
4. **`DOC_ACCESS` in `apps/pwa/src/demo.ts` duplicates the server's
   `ACCESS`** rather than importing it, because the server's copy must not
   reach the browser bundle. If they drift, the browser acceptance is what
   catches it.

## Carried backlog (unchanged, from R-3)

class/section edit UI · guardian unlink workflow · audit export and
entity-name resolution · `POST /rms/solve` API-only by decision.

## Unresolved bugs / issues

One disclosure, not a code issue: the design hook flags
`packages/ui-core/test/documents.test.ts` line 175 as `broken-image`. It is a
false positive — the line is `assert.doesNotMatch(html, /<img[^>]*src=""/)`,
an assertion that the product **never** emits a broken image. An attempt to
persist the narrowest ignore was blocked, so the finding is left standing
rather than suppressed quietly.

## Next recommended step

**R-6.** Not started. R-5 stopped here as instructed.

---

# 2026-08-29 · R-6 · Student history & global search

**Status: complete.** A principal types `STU-8F39A271` and gets রাফি হাসান,
উত্তীর্ণ, with four years of enrolment — each year holding the class, section
and roll he actually had that year.

## The history already existed; it had never been readable

`enrolments` has carried one row per student per academic year since
migration 003 — section, roll, status, the dates it opened and closed. That
IS the multi-year history the master plan asks for, and R-6 reads it rather
than denormalising a copy. §4 of the brief said not to build a history table
unless truly necessary; it was not necessary, and a second copy of the truth
would be a second thing to get wrong during a rollover, which already writes
these rows.

So R-6 added **no table, no column and no policy**. One migration, and it
contains one index.

## Migration 044 — one index, and the measurement that earned it

`enrolments` had three indexes and all three answer "who is in this
section/year". None answered "where has this child been": `student_id` is the
LAST column of the only index that mentions it, so a per-student lookup walks
every entry for the tenant and filters.

Measured against a seeded school of 2,000 students × 4 years = 8,000 enrolment
rows (PostgreSQL 16, EXPLAIN ANALYZE, warm):

| plan | time |
|---|---|
| seq scan (what the planner chose) | 1.255 ms, 7,997 rows discarded |
| forced index scan on the (tenant, year, student) unique index — a walk, not a seek | 0.712 ms |
| `ix_enrolment_student_history` (tenant, student, year) | **0.089 ms**, 4 rows read |

Fourteen times faster matters less than the shape: the scan is linear in the
whole school's history, so a ten-year-old school pays 200,000 rows for one
child's four, while the seek stays flat. The years are exactly what makes the
old plan worse, and the years are the feature.

The index carries `academic_year_id` third so it also supplies the timeline's
ordering. `IF NOT EXISTS`, and the rollback drops it and loses nothing —
verified down → up on a live database.

## Search is indexed because the query is classified first

The obvious endpoint is one `WHERE` with six `OR`s across code, two name
columns, phone and two board numbers. It reads well and cannot use an index.

So `classify()` decides what was typed and each shape gets the predicate its
own index answers — `STU-…` → the unique code index, `01712…` → the phone
index, Bangla or English text → the trigram indexes, `BR-…` → a scan, and
said so. **No Elasticsearch**: §15 asked not to add one unless PostgreSQL
could not do the job, and PostgreSQL does every shape in under 12 ms
end-to-end.

Two findings from measuring rather than assuming:

1. **`uq_users_tenant_phone` is a PARTIAL index** — `WHERE phone_e164 IS NOT
   NULL AND deleted_at IS NULL` — and PostgreSQL will not use a partial index
   unless the query implies its predicate. Without `deleted_at IS NULL` the
   phone lookup seq-scans: 0.292 ms against 0.026 ms. It is in the WHERE for
   that reason as well as the obvious one.
2. **`app.can_see_student` costs a call per row**, because it takes a row
   argument. On a name search matching 166 students that dominated the query
   at 10.7 ms. `app.has_role(...)` takes no row argument, so it evaluates once
   and short-circuits the OR for management: **2.8 ms, identical 166 rows**.
   Every role in the short-circuit list is one whose `can_see_student` falls
   through to `ELSE true`, so this is a cheaper way to ask the same question
   rather than a looser one — and `users_scope` in migration 010 is written
   the same way for the same reason.

## Authorization reuses `app.can_see_student`, and supersedes one plan line

§13 said not to create a new authorization model, and none was created. Every
row both endpoints return passes the predicate the RLS policies already use,
so the role rules fall out instead of being enforced:

- principal / owner / coordinator / dept head / accountant / IT admin → the
  whole school, alumni included
- class teacher / subject teacher → the children in their own sections
- guardian → their own wards · student → themselves

**This supersedes, and does not erase, the master plan's R-6 line** that said
"staff-gated" and "RLS keeps student/guardian out of the search endpoint".
R-6's brief asks in §13 and §18 for guardian and student access, scoped.
Routing them through `can_see_student` satisfies both readings at once: they
may call it, and it can only ever return themselves or their children — which
the tests assert directly.

A teacher does **not** get global search, per §13.

## Privacy: tighter than RLS in one place, again

The R-5 pattern repeats. `invoice_scope` (migration 010) reads
`has_role(principal, owner, accountant) OR can_see_student(student_id)`, so
RLS alone shows a **class teacher the fee balance of every child in their
section**. A class teacher has no reason to know which families are behind on
fees. `MAY_SEE_FEES` in the endpoint is narrower, and the fees tab is not
rendered disabled for them — it is not rendered at all, because a greyed-out
tab announces that a balance exists and they are not trusted with it.

`db/tests/student_search.sql` test 9 records BOTH facts, so if someone later
tightens the policy the test says the application gate became redundant
rather than wrong.

Contact details follow R-3's line: withheld at the SERVER, never sent, and
the screen says `যোগাযোগ ও ব্যক্তিগত তথ্য দেখার অনুমতি আপনার নেই।` rather than
silently omitting fields. Verified in the browser as a subject teacher: no
phone, no parents' names, no blood group, no board registration in the
payload at all.

The result list carries only what tells two children with the same name
apart — code, class, group, section, roll, status. Asserted by sweeping the
serialised response for a phone number, a blood group and a parent's name.

## The defects this phase found

1. **A Latin digit inside a Bangla sentence.** The too-short message
   interpolated `MIN_QUERY` and produced `অনুসন্ধানের জন্য অন্তত 2টি অক্ষর
   লিখুন।` §17 specifies `২`. Caught by a test asserting the brief's own
   wording — the same class of almost-Bangla R-5 refused in documents.
2. **`Promise.all` over one pg client.** The history endpoint ran its four
   loads "in parallel" on a single client inside a transaction. node-pg
   serialises them anyway and warns; pg 9 removes the behaviour. The
   parallelism was imaginary — the timings are unchanged after making it
   sequential. Found by reading a deprecation warning during the performance
   run, not by a failing test.
3. **A demo fixture that matched the whole school on any Bangla query.**
   `'সুমাইয়া'.replace(/[^\d]/g,'')` is `''`, and `String.includes('')` is
   true for every string, so the phone branch matched everyone. Worth
   recording because the real endpoint **cannot** have this bug: it
   classifies the query and runs exactly one branch, which is the reason it
   does that. The demo had OR'd everything — the naive design, demonstrating
   its own failure mode.
4. **A note flush against the screen edge.** `.page-sub` gets its horizontal
   padding from `.page-header`; used standalone it hugged the edge while the
   list beside it was indented. Visible at 375px, invisible on a wide screen.

## The brief's status list is not the column's

§1 listed *Active, Transferred, Withdrawn, Graduated, Archived, Alumni*. The
`lifecycle_status` CHECK permits *enrolled, promoted, transferred_out,
dropped_out, graduated, alumni*. The brief also says to reuse the existing
model, so the filter offers the column's six, in Bangla:

`অধ্যয়নরত · উন্নীত · ছাড়পত্র নিয়েছে · ঝরে পড়েছে · উত্তীর্ণ · প্রাক্তন শিক্ষার্থী`

"Withdrawn" maps to `dropped_out`; **"Archived" has no equivalent and was not
invented**; `promoted` has no name in the brief's list at all. A DB test
asserts that every status the endpoint offers is one the column permits, so
the two cannot drift.

## Tabs, and the two §4 asked for that do not exist as data

§4 listed eight tabs. Six are built: পরিচিতি · ভর্তির ইতিহাস · হাজিরা ·
ফলাফল · ফি · নথি.

**Transfers** and **Certificates** were not built as separate tabs, because
neither is a separate thing in this schema. A transfer IS an enrolment row
whose status is `transferred` plus a `lifecycle_status` of `transferred_out`
— it already appears in the timeline, in the year it happened, which is where
someone looks for it. A certificate is generated on demand by R-5 and never
stored, so a Certificates tab would list one item that the নথি tab already
lists. Inventing two empty tabs to match a list would have been worse than
saying this.

The নথি tab lists what this viewer may **print**, and hands out no URLs — R-5
generates on demand, there is no object store, so §10's rule is satisfied by
there being nothing to leak. Asserted by sweeping the payload for `http`.

## Tests

- **33 endpoint tests** (`services/academics-svc/test/student-search.test.ts`)
  against a real PostgreSQL: the classifier and phone normaliser as pure
  functions, every search field, the lifecycle filter, alumni, pagination
  arithmetic across three pages, the four role scopes with signed tokens,
  privacy sweeps, and 404-not-403 for an id that exists but is invisible —
  with the assertion that a real-but-hidden id and a nonexistent one give the
  *same* answer.
- **13 SQL assertions** (`db/tests/student_search.sql`), wired into
  `.github/workflows/database.yml` including the idempotency re-run.
  Pre-cleans as well as tears down. The three hostile cases §12 names are one
  test each — Tenant B's code, a name that matches a Tenant B student, and
  Tenant B's guardian phone — plus the id named directly. The fixture gives
  **both schools a child called রাফি হাসান**, so a leak changes a count from
  1 to 2 and the test fails rather than passing on an empty table.
- Full gate: **865 tests across 11 workspaces, all passing** against a real
  PostgreSQL 16. All ten SQL suites green. `tsc` clean, `npm run build` ok,
  migration 044 verified down → up, 44/44 probed.

## Performance — measured, on 2,000 students

A seeded school: 2,000 students, 8,000 enrolments, 8,000 results, 15,240
attendance records, four academic years, 200 graduates.

End-to-end through the real handlers (p50 / p95 over 20 calls, warm):

| operation | p50 | p95 |
|---|---|---|
| search by student code | 4.6 ms | 6.3 ms |
| search by name (broad) | 11.9 ms | 13.1 ms |
| alumni filter, page 1 of 200 | 10.1 ms | 10.9 ms |
| alumni filter, page 8 (offset 175) | 10.5 ms | 12.4 ms |
| open one student, full history | 10.6 ms | 12.7 ms |

Pagination stays flat from page 1 to page 8. The master plan's exit criterion
is "under a second"; this is two orders under it.

**The honest caveat**: these are localhost against a local PostgreSQL. They
measure the database and the handler and nothing else. A school in Bangladesh
adds the round trip to Neon Singapore and a 2G/3G link, which will dominate
completely — the ~10 ms of work here is not what a person will wait for. What
the numbers do establish is that the queries are indexed and that adding
years and students does not degrade them.

## Browser verification

Demo preview, both the search and the record, at desktop and 375×812.

- **The brief's example, exactly**: `STU-8F39A271` → ১ জন পাওয়া গেছে → রাফি
  হাসান, উত্তীর্ণ → four years, ২০২৪ সপ্তম ক, ২০২৫ অষ্টম ঘ, ২০২৬ নবম ক, ২০২৭
  দশম খ, each with its own roll.
- **§6 current vs historical**: a currently-enrolled child renders under two
  headings — **বর্তমান ভর্তি** and **পূর্ববর্তী বছরসমূহ** — with the current
  year carrying a leading rule and bold weight. Three signals, never colour
  alone. A graduate correctly gets NO current section, because the flag comes
  from `enrolments.status` rather than from being last in the array.
- **All six tabs** render real content: profile, timeline, per-year attendance
  with percentages, per-year results, per-year fees plus receipts, and the
  printable-document list.
- **Role scope**, same broad query each time: principal → all matches,
  class teacher → 3 (their section), guardian → 1 (their child), student → 1
  (themselves).
- **Privacy**: as a subject teacher, no fees tab at all, and the profile ends
  with the sentence explaining the withheld fields.
- **States**: empty `কোনো শিক্ষার্থী পাওয়া যায়নি।`, too-short
  `অনুসন্ধানের জন্য অন্তত ২টি অক্ষর লিখুন।`, skeleton while loading, and a
  count line `N জন পাওয়া গেছে` with `aria-live`.
- **375×812**: zero horizontal page overflow; the six-tab strip scrolls
  sideways inside itself rather than wrapping to two lines.

## Known limitations

1. **Board numbers are not indexed.** `board_registration_no` and
   `board_roll_no` have no index, so that shape is a scan of one school's
   student table. Sub-millisecond at 2,000 students; a one-line migration if
   a school leans on it. Not added speculatively.
2. **The trigram indexes exist but the planner does not use them at this
   size.** Verified usable with `enable_seqscan = off` (bitmap index scan on
   `ix_users_name_trgm`); at 2,000 rows a seq scan is genuinely cheaper and
   the planner is right. They start winning as the table grows.
3. **Attendance history all lives in the DEFAULT partition.**
   `attendance_records` is range-partitioned by month with partitions only for
   2026-08…2026-10, so every earlier year falls into
   `attendance_records_default`. The per-student query is an index-only scan
   there and is fine; it is worth knowing before someone adds partitions.
4. **No date-range filter on the attendance tab.** §7 said "where practical";
   per-academic-year totals are what a person reading a history wants, and an
   arbitrary range picker on a summary view is a control without a question.
5. **No type-ahead suggestions.** §2 said "as the user types where
   appropriate". Search is submit-driven: on 2G, a request per keystroke is a
   cost the product's own SMS-frugality argument says not to pay. The request
   sequencing is already in place (`seq`) if this changes.
6. **The student-search tile is a fifth secondary card** on five staff
   dashboards, where the comment budgets "~6 tiles". Hiding R-6's main screen
   behind More would have failed D13's spirit and §18's own walk, which
   starts on it.

## Carried backlog — preserved per §22, none of it closed by R-6

class/section edit UI · guardian unlink workflow · audit export and
entity-name resolution · `POST /rms/solve` API-only by decision ·
**R-5: object storage** (no stored PDFs or student photos) ·
**R-5: CSV export** (`toCsv()` still unused) ·
**R-5: multi-card ID-card layout** (one card per A4 sheet) ·
**R-5: money formatting decision** (`৳ 1,300.00` in Latin digits beside
Bangla rolls — still open, still needs a call).

## Unresolved bugs / issues

None open.

## Next recommended step

**R-7 — Onboarding & platform console.** Not started. R-6 stopped here as
instructed.

---

# 2026-08-29 · R-7 · Tenant onboarding & the platform console

**Status: complete.** A shikhonBD operator creates an institution through a
nine-step wizard and activates it, and the school's head teacher signs in with
a printed code. Measured end to end: **~250 ms of server work**, and no SQL
after the initial platform setup.

Two institutions were onboarded this way — মনিপুর উচ্চ বিদ্যালয় (school) and
মোহাম্মদপুর কলেজ (madrasah) — against a real PostgreSQL, through the real
endpoints.

## What already existed, and the one thing that did not

`tenants` has carried `plan_code`, `student_cap`, `trial_ends_on`, `status`,
`eiin`, `weekend_days`, `dek_wrapped` and `blind_index_pepper` since migration
001. `app.provision_tenant()` has seeded a school's academic spine since 012.
`audit.platform_access` has been waiting since 001. The activation-code login
has worked since 037.

What was missing was any way to **insert a tenant at all** — by design.
`tenant_self` is `USING (id = app.current_tenant())` and, with no separate
`WITH CHECK`, that expression governs INSERT too. So `shikhon_app` can only
write a tenant row whose id equals the tenant it is already inside: it cannot
create a school and cannot list one. That property is what the product's whole
isolation story rests on, and R-7 had to add the ability without spending it.

## The authorization chain, and three separate credentials

Migration 045 adds `app.create_tenant`, `app.platform_tenants`,
`app.set_tenant_status` and `app.log_platform_action` as SECURITY DEFINER with
a pinned `search_path`, granted to `shikhon_platform` and **explicitly revoked
from `shikhon_app`** — the same shape as `app.public_branding()` in 039.

platform-svc then needs three things a school does not have:

1. a **`super_admin` JWT** — a `principal` token is refused, and the DB suite
   asserts it;
2. **`PLATFORM_API_KEY`**, checked with a timing-safe compare, never in the
   browser bundle;
3. **`PLATFORM_DATABASE_URL`**, a different database role. Unset, the service
   answers 503 rather than falling back — a fallback to the runtime role is
   how a platform endpoint quietly becomes a tenant endpoint.

A wrong key and a missing key return the same code, so an attacker holding one
half learns nothing about the other.

### BYPASSRLS comes OFF, and that was a decision

Migration 001 created `shikhon_platform` with BYPASSRLS, back when it was a
role nothing could use. Giving it a login and leaving that on would have made
the one service that touches every school the one service where row-level
security does not apply — and `assertRlsEnforced` in server-core would have
refused to start against it, which is the boot guard doing its job.

It does not need it. The cross-tenant functions are DEFINER and run as the
owner; everything else the wizard does is work inside ONE school, and for that
it sets `app.tenant_id` and lives under the same policies as everybody else.
So a bug in the wizard cannot write into the wrong school.

That decision then produced three bugs, all of the same shape and all found by
running the thing: **a bare pool query sees nothing.** The tenant-detail
endpoint returned an empty branding object for a school that was branded; the
test's verification queries read every count as zero; and the fixture cleanup
deleted nothing and then failed on a duplicate slug. Each is now explicit
about the context it runs in, and each has a comment saying why.

## What the console is, and is not

A separate page, a separate bundle, a separate service, a separate database
role and a separate credential. `/platform`, `platform.js`, platform-svc,
`shikhon_platform`, `PLATFORM_API_KEY`. A school's device never downloads the
console's code.

It is also the one surface that **keeps** the shikhonBD brand (D11). The CI
guard now runs three ways: tenant surfaces must not carry the platform brand,
`index.html` must, and so must `platform.html` and `platform.ts`. One bundle
could not honestly be both white-labelled and shikhonBD-branded, which is the
strongest argument for it being a separate bundle.

Operator sign-in is two pasted secrets held in `sessionStorage` — not
`localStorage`, so a console left open on a shared laptop does not survive the
tab closing. Real operator SSO belongs with R-8's credential work; two pasted
secrets is an honest posture for a tool used by people who already hold the
deployment's environment.

## The state the operator sees is DERIVED, never stored

§23 asks the operator to see how far a half-finished school got. The obvious
implementation is a stage column the wizard updates, and it is the wrong one:
a stored stage is exactly what goes stale when provisioning dies between the
act and the bookkeeping — which is the failure §22 is about.

`app.tenant_onboarding_state()` counts the real rows instead: years, grading
bands, classes, sections, subjects, fee heads, teachers, students, guardians,
admins. It cannot disagree with the database because it IS the database, and
after a crash it reports what landed rather than what someone meant to land.

The console renders it as a checklist where every line carries a tick or a
warning **and** the count **and** the note — never colour alone (F-812). Three
lines are labelled `সক্রিয় করতে আবশ্যক`, and the grading-scale line says why:
*না থাকলে প্রথম ফলাফল প্রকাশ ব্যর্থ হবে.*

## The gaps this phase found

Four of them, and two would have stopped a pilot.

### 1. Nothing had ever written `student_profiles`

R-6 built search-by-permanent-ID against `student_profiles.student_code`, and
it turned out **no code in the product had ever inserted a row into that
table** — not the student import, not enrolment, not any endpoint. It has held
the permanent identifier since migration 001 and only test fixtures had put
anything in it. So R-6's search worked and had nothing to find.

The import is where a student first exists, so that is where the profile and
the code are now created: `STU-` plus eight hex from the user's own uuid,
derived so it is stable and needs no counter.

### 2. A provisioned school could not import a single student

`provision_tenant` seeds the year, terms, grading bands, bell schedule,
classes, `class_subjects`, fee heads and the chart of accounts — everything
except the `subject_templates` that F-304's `app.derive_student_subjects()`
requires. Nothing in the product had ever created a `curriculum_schemes` or
`subject_templates` row either.

So a freshly onboarded school rejected **every row** of its first student
import with `৯ শ্রেণির বিষয় তালিকা (টেমপ্লেট) তৈরি হয়নি`. The pilot runbook's
step 6 would have hit the same wall.

`app.provision_curriculum()` closes it, deriving the templates from the
`class_subjects` `provision_tenant` already populated — it adds no curriculum
knowledge of its own, it reshapes what is there. It is a separate function
rather than an edit to `provision_tenant` because that function is exercised
by six phases of tests and this one can be re-run against a school provisioned
before R-7.

### 3. `student_cap` was decoration

Declared in migration 001 with a CHECK that it is positive, and enforced
nowhere: not on enrolment, not on import, not at all. A school on a
500-student plan could import 5,000.

It is now a statement-level trigger on `enrolments` — statement-level because
an 800-row import is one INSERT and a row trigger would count the school 800
times. It is on `enrolments` rather than `student_profiles` because, per (1),
nothing wrote the latter. The refusal states both numbers: *capped at 2
students and this would make 3*.

### 4. My own regression, caught by the browser walk

Extracting the activation-code alphabet, length and HMAC into a shared module
so the wizard could issue a school's first code left `CODE_LEN` undefined in
the redeem path — a ReferenceError surfacing as a **500 on the one login a
brand-new school has**. identity-svc's ten tests all passed through it,
because none of them redeems a code. There is now a test that does, and it
asserts the round trip and the single-use property.

Two smaller ones: `parseBranding` fills DEFAULTS for absent fields, so saving
`{nameBn, primaryColor}` would have written `nameEn: "Institution"` over every
school's real English name — only supplied keys are persisted now. And
`app.provision_curriculum` was not idempotent on its first pass: the unique
index on `subject_templates` includes a nullable `group_code`, and PostgreSQL
treats NULLs as DISTINCT unless the index says `NULLS NOT DISTINCT`, so
`ON CONFLICT` matched nothing and a re-run doubled every ungrouped template
(3 → 6). It uses `NOT EXISTS … IS NOT DISTINCT FROM` now, and the DB suite
asserts a re-run changes nothing.

## Reuse, not reimplementation

Three things the wizard needed already existed inside an endpoint that
required a tenant session the operator does not have. All three were
**extracted**, not copied:

- `services/academics-svc/src/import-run.ts` — the import orchestration.
  `api/import.ts` is now a thin handler over it and gained `kind:'teacher'`.
  The alternative was minting the operator an impersonation token, or a second
  importer that would eventually disagree with the first about what a phone
  number looks like.
- `services/identity-svc/src/activation.ts` — the code alphabet, length and
  HMAC. Three definitions that must agree exactly; one copy.
- The R-1 branding parser is the validator for the console's branding step, so
  it cannot accept something the school's own editor would reject.

Teacher import is new (`teacher-import.ts`), deliberately the same shape as
the student importer, and deliberately **does not assign anybody to a section
or subject** — R-7.6: a teacher exists first and is assigned second, and the
assignment is a dated record R-3's screen can end and replace.

## Two doors, and the second one is the hostname

`app.public_branding()` has accepted a slug OR a tenant id since migration
039, precisely so a vanity URL could work later without a third identifier.
`tenantKeyFromHost()` reads the subdomain label and uses it as that key:

    monipur-high-school.shikhonbd.com  →  monipur-high-school

`?tid=` keeps working and keeps **priority** — it is printed on admission slips
and baked into installed PWAs, and a subdomain that overrode it would break
every device already in a school's hands. The label is not cached, because the
hostname supplies it on every visit and caching it would leave the wrong
school's key on a device that later opened a different subdomain. Labels that
are never a school (`www`, `app`, `platform`, `api`) are excluded.

**Wildcard DNS and TLS are a deployment step, not a code one.** The resolver
ships; `*.shikhonbd.com` and its certificate are recorded in the deployment
doc as the remaining action. Nothing in the product depends on them — the
`?tid=` door is unchanged.

## Slugs

Generated from the English name, lowercased, non-alphanumeric runs collapsed
to one hyphen: `Monipur High School` → `monipur-high-school`. On collision the
console offers a **district suffix, never a number** — this becomes the
school's web address and `monipur-high-2` is not a URL anyone prints on an
admission slip. The field carries a permanent quiet warning that it cannot be
changed once printed.

## Tests

- **25 endpoint tests** (`services/platform-svc/test/platform.test.ts`) against
  a real PostgreSQL: a principal refused, each credential alone refused, both
  refusals indistinguishable, validation before any write, slug collision
  without naming the other school, activation blocked on the two silent
  failures, provisioning idempotent, branding not overwritten with
  placeholders, the same phone granted rather than duplicated, a platform role
  never grantable to a school, dry-run writing nothing, digest mismatch
  refused, siblings collapsed to one guardian, the cap refusing with both
  numbers, the derived state, suspend/restore losing nothing, the audit trail,
  and the activation round trip.
- **15 SQL assertions** (`db/tests/platform.sql`), wired into CI including the
  idempotency re-run: the runtime role cannot create, enumerate, suspend or
  forge an audit row; the platform role can log in and is still bound by RLS;
  the audit trail is readable and not directly writable; a school sees no
  other even by id; provisioning is idempotent; the cap states both numbers;
  suspension is reversible and lossless.
- **`scripts/r7-acceptance.mjs`** — the §28 walk as a repeatable script.
- Full gate: **890 tests across 12 workspaces, all passing** against a real
  PostgreSQL 16. All eleven SQL suites green (134 assertions). `tsc` clean,
  `npm run build` ok, migration 045 verified down → up, 45/45 probed, D11
  guard green in all three directions.

## Browser verification

`/platform` in a real browser, against the real API and the real database.

- **Sign-in** with the two pasted credentials; the institution list renders
  §18's columns — institution, type, slug, status, plan, students/cap, trial
  end, created — and **no student-level PII**.
- **The nine-step wizard**, clicked through: the rail marks done steps with a
  tick and the current one with `aria-current`; the slug auto-filled as
  `monipur-high-school`; the tenant was written at step 3 (`প্রতিষ্ঠান তৈরি
  হয়েছে`); provisioning showed its counts verbatim, including
  `(grading_bands,7)`, which is how an operator knows the scale exists.
- **Both institutions onboarded end to end** — 249 ms and 208 ms of server
  work. The madrasah defaulted to a **Friday-only weekend** `{5}` against the
  school's `{5,6}`, and got a different curriculum (34 subject mappings
  against 48): institution type behaving as configuration, visibly.
- **Isolation**: inside each school, exactly one tenant row is visible, its
  own four students, and zero of the other's — including when the other's id
  is named directly.
- **The head teacher logs in.** The activation code from step 7 redeemed
  through `/auth/activate` and returned a session with role `principal`. This
  is R-7's exit criterion and it is the one thing a wizard cannot fake.
- **The console's own states**: skeletons while loading, an error state with a
  retry that recovered from an expired operator token, an empty state on the
  list, and per-field validation messages in Bangla.

The first screenshot of the console was **unreadable** — dark text on black.
`--c-bg` is not a defined token anywhere in the design system, and this
stylesheet is the third place to use it; `app.css` already carries a comment
about the same bug in `.chat-form`. Both remaining uses are fixed, and the
console now sets `data-theme` from the operator's own machine, because dark
mode here is an explicit attribute rather than a media query.

## Known limitations

1. **Wildcard DNS and TLS are not provisioned.** The hostname→slug resolver
   ships and is unit-testable; pointing `*.shikhonbd.com` at the deployment
   and issuing the certificate is a deployment action, recorded in
   06-DEPLOYMENT.md. `?tid=` is unaffected.
2. **Operator sign-in is two pasted secrets.** No SSO, no operator account
   management, no key rotation UI. Deliberate: R-8 owns credentials.
3. **`plan_code` is a label.** No feature gating — `tenants.features` exists
   for that later. `student_cap` and `trial_ends_on` are enforced and shown;
   billing the school stays manual, per R-7.10.
4. **Trial expiry is not automatic.** `trial_ends_on` is stored, shown in the
   console, and moves nothing on its own. The master plan says expiry moves a
   tenant to `suspended`; scheduling that belongs with the maintenance cron
   and is not built.
5. **The wizard's branding step is a subset** — colour, head teacher, phone.
   Logo, favicon, watermark and signature upload remain the school's own R-1
   editor, which is where they were always going to be done and where the
   school has the files.
6. **Groups are not configurable per class in the wizard.** `provision_tenant`
   derives a class's group from the NCTB template; a school wanting Science
   and Humanities sections of class 9 creates them in R-3's structure screen.
   §11's tree is therefore read from what provisioning made, not authored in
   the wizard.
7. **The activation code's `issued_by` points at the account itself.** That
   column FKs to `users` — a person inside the school — and for a school's
   first account there is nobody inside the school yet. The truthful record of
   which operator issued it is the `audit.platform_access` row. Same division
   for `import_batches.started_by`.
8. **platform-svc is the 11th of the Hobby plan's 12 functions.** One spare.

## Carried backlog — preserved per §33, none of it closed by R-7

**R-3:** class/section edit UI · guardian unlink workflow · audit export and
entity-name resolution · `POST /rms/solve` API-only by decision.

**R-5:** object storage (no stored PDFs or student photos) · CSV export
(`toCsv()` still unused) · multi-card ID-card layout (one card per A4 sheet) ·
**money-formatting decision** (`৳ 1,300.00` in Latin digits beside Bangla
rolls — still open, still needs a call).

**R-6:** an index on the board registration/roll columns if a school leans on
that search shape · an attendance date-range filter · type-ahead suggestions.

## Unresolved bugs / issues

None open.

## Next recommended step

**R-8 — go-live unlocks (credentials & production posture).** Not started.
R-7 stopped here as instructed. R-8 is where the SMS aggregator, the object
storage credential, operator SSO and the wildcard certificate land — and where
`LOGIN_DISABLED` is finally flipped, which R-7 deliberately did not touch.

---

# 2026-08-29 · R-8 · Go-live unlocks

**Status: complete, with an honest boundary.** Four capabilities the master
plan lists under R-8 are now real code, tested and walked in a browser: a
**live SMS provider** behind an adapter with delivery reports, **environment
switches** replacing three hardcoded `const`s, **AI budget enforcement**, and a
**readiness screen** that reports the deployment's actual state.

The rest of the master plan's R-8 list is not code and could not be closed by
writing any: an aggregator contract, an MFS merchant agreement, a
data-residency decision, and pilot schools. Those are named on the readiness
screen itself, under a heading saying that screen cannot tick them — see
"What R-8 could not close" below. Reporting them done because a switch exists
for them is precisely the failure this phase was supposed to prevent.

The first real OTP login in the product's history happened during this phase's
browser acceptance: a principal signed in with a code that travelled through
`sms_outbox`, an SSL Wireless adapter, an aggregator, and back as a delivery
report.

## What was actually dark, and it was worse than "unconfigured"

The master plan describes R-8 as "contracts, credentials, and switches —
everything here is built and dark". That is true of the schema. It was not true
of the code, and the gap ran in the dangerous direction: **three things the
plan assumed were built and waiting for a credential did not exist at all.**

### 1. There was no provider to configure

`sms_outbox` has carried `provider`, `provider_msg_id`, `delivered_at`,
`error_code` and `cost_bdt` since migration 004. The dispatcher had a
`sendStub` that logged. There was no seam — no interface, no adapter, nothing a
credential could have been plugged into. "Add the aggregator's token to the
environment" would have changed nothing at all.

`services/sms-svc/src/provider.ts` is that seam: an `SmsProvider` interface, a
`StubProvider` that stays the default, and an `SslWirelessProvider`.
`resolveProvider()` **throws** when a provider is named without credentials
rather than falling back to the stub — a school that believes its messages are
going out is worse off than one that knows they are not.

### 2. Nothing had ever received a delivery report

`delivered_at` had never been written by anything, in any deployment, ever. The
product knew only that it had HANDED a message to a provider, which is not what
a school is asking when it rings to ask whether the SMS went out.

`POST /api/v1/sms/dlr` closes that. It has **its own secret**,
`SMS_DLR_SECRET`, not `SERVICE_API_KEY`: this endpoint is called by a vendor,
and handing a vendor the service key would make every internal endpoint
reachable by them. Unset, it answers **503, not 401** — an unconfigured webhook
and a wrong password send an operator to two different places.

It takes **no tenant from the caller**. A DLR carries a provider message id and
nothing else we can trust; the row is found by that id and the tenant comes
from the row. That needs a cross-tenant read the runtime role rightly cannot
do, so `app.record_sms_delivery()` (migration 046) is `SECURITY DEFINER` for
exactly that, and updates **only the four delivery columns**. A provider cannot
change a message's body, its recipient, or which school it belongs to.
`db/tests/go_live.sql` asserts that by comparing every other column before and
after.

### 3. The OTP switch turned on a login that delivered nothing

This is the one that would have hurt. `services/identity-svc/api/otp-request.ts`
wrote the code to `console.log` under a comment reading *"Stub SMS send — real
aggregator integration is a follow-up."*

Survivable while the switch was a hardcoded `false`. Not survivable once the
switch became an environment variable: an operator could set
`OTP_SENDING_ENABLED=true`, watch the readiness screen go green on both OTP and
SMS, hand a school a login — and **no code would reach anybody**. The screen
would have been lying in the exact way this phase exists to prevent.

The code now goes into `sms_outbox` in the **same transaction as the
challenge**, so there is never a code the product believes it sent. It is
queued at `priority = 1`, because a login code behind a queue of attendance
notices is a login code that arrives after it has expired.

Two details are tested because both would otherwise be discovered one school at
a time:

- **The dedupe key is the challenge, not the phone and the day.**
  `uq_sms_dedupe` is `UNIQUE (tenant_id, created_on, dedupe_key)`. Keyed on
  phone+day, the person who did not receive the first code could not be sent
  another until tomorrow — the exact person who needs one.
- **The message is signed with the SCHOOL's name** (D11), falling back to the
  neutral `বিদ্যালয়` and never to the platform's. A guardian must not read
  their software vendor's brand on a message from their child's school.

## The switches

`packages/server-core/src/go-live.ts` is the single source. Three hardcoded
constants became environment reads:

| was | now |
|---|---|
| `login-view.ts`: `export const LOGIN_DISABLED = true` | `isLoginDisabled()` ← the server's `otpLogin` |
| `otp-request.ts`: `const OTP_SENDING_ENABLED = false` | `otpSendingEnabled()` |
| `finance-svc`: `const MFS_PAYMENTS_ENABLED = false` | `mfsPaymentsEnabled()` |

Only the word `true` enables anything — case-insensitively, because `TRUE` is
unambiguously somebody deciding, while `1`, `yes`, `on` and `enabled` all
resolve **off**. That is the safe direction to be wrong in: a switch that
stayed off gets reported by an operator; a switch that turned itself on gets
reported by a parent who received a text at midnight.

The client no longer carries its own copy of the OTP flag.
`GET /api/v1/ops/brand` — the call the login screen already makes before anyone
types anything — now carries `otpLogin` on **both** branches, and `branding.ts`
caches it. What used to be "edit a server file, edit a browser file, rebuild,
redeploy, in that order, without forgetting either" is now one environment
variable.

## AI budget: a table nobody read

`ai_budget_periods` has existed since migration 008 with `token_budget`,
`tokens_used`, `soft_limit_notified_at` and `hard_limit_hit_at`, and
`tenants.ai_monthly_token_budget` since 001. **Nothing in ai-svc referenced
either.** It recorded `input_tokens`/`output_tokens` on `ai_turns` and never
looked at what a school was allowed to spend — the same shape as `student_cap`
before R-7: a limit only the price list knew about.

`app.consume_ai_budget()` **reserves before the call** and
`app.settle_ai_budget()` corrects it after. Reserving first is the point: a
check-then-record would let a school overshoot by however many requests are in
flight, and an AI bill is the one cost in this product that can run away
between two cron ticks. Both are `SECURITY INVOKER` — a school's own budget is
not a cross-tenant concern, and making them DEFINER would have handed one
school a lever on another's counter.

Refusal is **402, not 403**. The school has not done anything wrong and the fix
is commercial.

Verified by hand against real PostgreSQL before any UI existed, then pinned in
`db/tests/go_live.sql`: 8,500 of 10,000 allowed and the soft limit stamped; the
next call refused, the hard limit stamped, and `tokens_used` still 8,500 —
**a refused call is not charged.**

## The readiness screen

`GET /api/v1/platform/readiness` computes eight checks from the environment;
`apps/pwa/src/platform.ts` renders them under আবশ্যক / ঐচ্ছিক. Same binary, two
environments, verified in a browser:

- default deployment → **৪ টি আবশ্যক সেটিং বাকি আছে** (`blockingRemaining: 4`)
- switches set → **সব আবশ্যক সেটিং প্রস্তুত** (`blockingRemaining: 0`)

No rebuild between them. It reports **presence, never values** — a test asserts
that no secret's value appears anywhere in the response; the sender id and
provider name do appear, because they are not secret.

It distinguishes *broken* from *off*: a provider named with incomplete
credentials reads `ক্রেডেনশিয়াল অসম্পূর্ণ`, which is a mistake, not a decision.

## What R-8 could not close

The screen carries a card headed **এই পর্দা যা জানে না** naming what no
environment variable can answer:

1. **The aggregator contract.** A masking sender id and a rate need a signed
   agreement with SSL Wireless or a competitor. The adapter is written and
   tested against a fake aggregator; the contract is a commercial act.
2. **The MFS merchant agreement.** bKash/Nagad merchant onboarding. The switch
   exists; no gateway was invented, per the phase's own constraint.
3. **The data-residency decision.** Where a Bangladeshi school's student data
   physically sits is a policy decision with legal weight, not a config value.
4. **Pilot schools.** Real institutions with real children.

These are reported as **not done**. A tick beside any of them would be the lie
this phase was written to prevent.

## Migration 046

Three functions, no tables, no columns. Rollback
`db/rollback/046_go_live_unlocks.down.sql` loses no data — a message reported
delivered keeps its `delivered_at` and its `cost_bdt`. Full cycle exercised:
**up → 12 assertions pass → down → the suite correctly fails (functions gone) →
up → 12 assertions pass.** Suite re-run twice for idempotency, and wired into
`.github/workflows/database.yml` in both the main and re-run passes.

`scripts/migration-status.mjs` probes `app.record_sms_delivery` for 046.

## Secrets

`scripts/check-secrets.mjs` did not know `PLATFORM_API_KEY` (R-7) or R-8's
`SMS_API_TOKEN` and `SMS_DLR_SECRET`. Registering the secrets a go-live needs
is this phase's own job, so all three were added with blast radius and rotation
notes. `SMS_API_TOKEN`'s entropy floor is 64 bits rather than 128: it is set by
the aggregator, and demanding more of somebody else's key would fail every real
deployment.

## Tests

**932 across 12 workspaces with a database attached, 693 without, all passing.**
New in R-8:

| suite | what it holds |
|---|---|
| `services/sms-svc/test/provider.test.ts` (9) | the stub stays the default; a named provider without credentials **throws**; HTTP 200 with a failure body is a failure |
| `services/sms-svc/test/dlr.test.ts` (11) | 503-vs-401; the service key does **not** open this door; an unknown status is not guessed at |
| `packages/server-core/test/go-live.test.ts` (12) | only `true` enables; no secret **value** in the readiness report |
| `services/identity-svc/test/otp-request.test.ts` (10) | the code is queued, not logged; signed with the school; a resend is not swallowed |
| `db/tests/go_live.sql` (12) | a report changes only the four delivery columns; a refused AI call is not charged |

Three fixture defects were fixed rather than worked around, and two are lessons
earlier phases already learned:

- **RLS ate a cleanup again.** `DELETE FROM tenants WHERE id = ANY([T, OTHER])`
  under tenant T's context deletes only T — the other row is invisible, the
  DELETE matches nothing, and the next run fails on a duplicate key from a
  fixture it believes it deleted. Third time this pattern has bitten (twice in
  R-7).
- **F-102 is real in tests.** OTP requests are capped at 3/hour per phone and
  the buckets live in the database, outliving the process. The suite now uses a
  fresh number per test and a fresh series per run — the policy was not
  weakened to accommodate it.
- **An open pool failed a whole file.** `dlr.test.ts` stops before its own
  query, but the rate limiter runs first and really connects when
  `DATABASE_URL` is set; the singleton pool kept the process alive and the
  runner reported the file as failed with no assertion to point at.

## Browser verification

Two deployments of the same binary, one database, verified in a real browser:

1. **Readiness, switches off** — 4 blocking items, each with a reason.
2. **Readiness, switches on** — all blocking items green, `ssl_wireless` and
   sender id `SHIKHON` shown, token not.
3. **Mobile (375×812)** — both columns wrap, `scrollWidth === clientWidth`, no
   horizontal overflow.
4. **App, switches off** — demo mode, exactly as before R-8.
5. **App, switches on, cold device** — the real OTP login screen.
6. **A full login** — phone → code → dispatched through a fake aggregator →
   `প্রধান` signed into নথি বিদ্যালয় with the school's own branding.
7. **The refusal path** — a number with no account gets
   `এই নম্বরে কোনো অ্যাকাউন্ট পাওয়া যায়নি` at verification, while the
   *request* step deliberately does not reveal whether a number is registered.
8. **A delivery report** — `{"ok":true,"matched":true}`, row `delivered`,
   `cost_bdt = 0.3500`.

### Two defects the browser found that the tests did not

Both were mine, and both were invisible to unit tests:

1. **`fetchPublicBranding` returned early when the URL named no tenant**, so
   `otpLogin` was never learned on a bare domain and the app stayed in demo
   mode however the server was configured. The switch is a property of the
   DEPLOYMENT, not of a school, so it is now fetched on both paths.
2. **A cold device could not know the answer in time.** The demo-mode gate
   reads a cache a first-ever visitor has never filled. Reading "unknown" as
   "off" is safe on the login screen — it offers the activation-code path — and
   is *not* safe at that gate, where it drops a real visitor into a sample
   school. `otpLoginAnswered()` distinguishes "cached false" from "never
   asked", and a cold device now asks once before deciding. Every later boot is
   synchronous, which is what keeps the 2G start immediate.

A third, smaller: `isLoginDisabled()` was a module-level `const`, captured
before the cold fetch resolved — it froze a newly live school on "OTP login is
temporarily off" until someone reloaded. Now read per call.

And a fourth, the same bug R-6 shipped, one funnel-step earlier: `5 মিনিটের` —
a Latin digit in Bangla prose. The duration is now `৫`. The **code** stays in
Latin digits deliberately: it is not prose, it is a literal to be typed back,
and a person reading `৯৯৫৯৪৭` off an SMS has to transliterate it first.

## Offline classification

Deliberate and recorded: **none of R-8's four capabilities is offline-capable,
and none should be.**

- The **readiness screen** reports a live server environment. A cached answer
  would be a stale claim about production posture, which is worse than no
  answer.
- The **DLR** is inbound from a vendor to the server; a browser is not
  involved.
- **OTP request/verify** require the network by definition — the code travels
  over a network the device must also be on.
- The **AI budget** must be reserved server-side before the call. A
  client-side reservation is not a reservation.

The activation-code path remains the offline-tolerant way into the product, and
is untouched by this phase.

## Known limitations

1. **No aggregator contract**, so `SMS_PROVIDER` is unset on every real
   deployment and the stub is what runs. Verified end to end against a fake
   aggregator on localhost, which proves the adapter and not the vendor.
2. **`SslWirelessProvider` is written to one vendor's documented shape and has
   never met the real endpoint.** The `csms_id`/`reference_id` mapping and the
   status vocabulary are the two things most likely to need a correction on
   first contact; both are isolated to `provider.ts` and the DLR's status map.
3. **Cost is recorded only when the DLR reports it.** The send response does
   not carry a per-message cost and none is invented, so `cost_bdt` stays NULL
   on a deployment whose aggregator does not send delivery reports.
4. **No SMS retry backoff.** A failed send stays `queued` with an `error_code`
   and is retried on the next dispatcher tick, up to 5 attempts, then `failed`.
   The tick is the interval; there is no exponential backoff.
5. **The AI soft limit stamps a timestamp and notifies nobody.**
   `soft_limit_notified_at` is set at 80%; wiring it to R-2's notification
   infrastructure is not built. A principal learns of it by being refused.
6. **Trial expiry still moves nothing** (carried from R-7.4).
7. **Operator sign-in is still two pasted secrets** (carried from R-7.2). R-8
   was expected to own operator SSO; it does not, and that is stated here
   rather than quietly dropped.
8. **Wildcard DNS and TLS remain unprovisioned** (carried from R-7.1).

## Carried backlog — preserved, none of it closed by R-8

**R-3:** class/section edit UI · guardian unlink workflow · audit export and
entity-name resolution · `POST /rms/solve` API-only by decision.

**R-5:** object storage (no stored PDFs or student photos) · CSV export
(`toCsv()` still unused) · multi-card ID-card layout (one card per A4 sheet) ·
**money-formatting decision** (`৳ 1,300.00` in Latin digits beside Bangla
rolls — still open, still needs a call).

**R-6:** an index on the board registration/roll columns if a school leans on
that search shape · an attendance date-range filter · type-ahead suggestions.

**R-7:** operator SSO and key rotation · trial expiry automation · per-class
group configuration in the wizard · logo/favicon/watermark upload in the
wizard.

**R-8 (new):** SMS retry backoff · soft-limit notification wired to R-2 ·
per-message cost when an aggregator reports it on send rather than on delivery.

## Unresolved bugs / issues

**1. `GET /api/v1/sync/pull` is built, mounted, tested — and no client ever
calls it.**

Flagged for the record, and deliberately **not** pulled into R-8: R-8 touches
nothing in the sync path, and the master plan does not name this as an R-8
dependency.

The state, precisely: `services/sync-svc/api/pull.ts` implements the
delta-cursor protocol, `index.ts` mounts it, and sync-svc's suites cover it.
The only mention anywhere in the client is a service-worker **routing rule**
declaring the caching strategy (`network-only`) for a URL nothing requests,
plus that rule's test. `transport.ts` calls `/api/v1/sync/push` and nothing
else.

So the outbox pushes, and the client never pulls. Every read the app performs
comes from ordinary REST endpoints with their own caching, which is why nothing
is visibly broken — the delta protocol is simply unused. Two honest resolutions
exist and this phase chose neither: wire the client to it, or delete the
endpoint and its documentation. Leaving it is a third option and the worst one,
because `docs/01-ARCHITECTURE.md` and `docs/03-API-SPECIFICATIONS.md` both
describe it as the product's sync mechanism.

## Next recommended step

**R-9.** Not started. R-8 stopped here as instructed.

The two things that would most change the product's readiness are not R-9 work
and are not code: the aggregator contract, which makes every SMS path in this
phase real rather than rehearsed, and a pilot school.

---

# 2026-08-29 · R-9 · Web push notifications

**Status: complete for one of R-9's seven items, and explicit about the other
six.** A parent, teacher or student can turn on notifications for their own
device; a school notice reaches them over the internet instead of by SMS; and a
school that opts in stops paying for the SMS that push carried.

Verified end to end against a real HTTP push service: the notice was encrypted
per RFC 8291, sent with a real VAPID header, received, and **decrypted back to
the school's own name in Bangla** — with the SMS row marked `suppressed` and no
other tenant able to see any of it.

## What the Master Plan defines as R-9, and what was actually there

> Section chat (moderated, section-scoped, teacher present), web push
> notifications (cuts SMS cost — the biggest infra line), content authoring
> workspace (F-403) + NCTB corpus ingestion (F-1301) to light up grounded AI,
> photo/voice submissions (F-902), report trend charts (F-1505), native app
> wrappers, library/transport/hostel/payroll.

Seven items, audited against the repository rather than against the roadmap's
own words:

| Item | State in the repo | Blocked by |
|---|---|---|
| Section chat | Nothing. No table, endpoint or view. | The plan itself calls it **optional**; moderation/safety design |
| **Web push** | Nothing. No table, no VAPID, no `pushManager`, no SW `push` handler. | **nothing** |
| Content authoring (F-403) | Not built. `topics`/`topic_blocks` reachable only by direct INSERT; every *consumer* exists. | — (large, code-only) |
| NCTB corpus (F-1301) | Half. Retrieval path exists, no corpus ingested. | **External**: the corpus, an embedding key |
| Photo/voice (F-902) | Half. `038_submission_media` has the metadata and the presign *contract*; **no object-storage client exists anywhere**. | **External**: R2/S3 credential (open R-5 backlog) |
| Trend charts (F-1505) | Not built. `class-perf-view` answers a different question. | — |
| Native wrappers | Nothing. | **External**: store accounts |
| Library/transport/hostel/payroll | Nothing. | — (four new product areas) |

### The discrepancy, recorded before deciding

**R-9's stated dependency is a pilot, and there is no pilot.** The sequence
table reads `| R-9 | Add-ons | — | pilot | — |`, and R-8 closed with pilot
schools explicitly open and externally blocked. Read literally, R-9 cannot
start. Read usefully: the items that do not depend on pilot feedback can be
built, and the ones that are genuinely pilot-shaped — native wrappers, four new
product modules — should not be guessed at in their absence.

Also found: **`docs/09-PRD-AUDIT.md` is stale** (2026-08-12, pre-R-1…R-8). It
still says dark mode is unbuilt, that F-1310 has no cost ceiling (R-8 built the
AI budget), and that `LOGIN_DISABLED` is a constant (R-8 made it an env switch).
Not rewritten wholesale — out of scope — but noted so it is not read as current.

## Why web push, and not the rest

- It is the **only** item the plan gives a business reason for — "cuts SMS cost,
  the biggest infra line" — and R-8 is what made that cost real: there is now an
  actual provider, an actual per-message cost, and a delivery report recording
  it. The saving is measurable against R-8's own work rather than asserted.
- It is the **only** item with **no external dependency**. VAPID keys are
  self-issued by a script in this repository. There is no vendor, no contract,
  no merchant account, no corpus, no store listing.
- It **reuses** R-2's audience resolution and R-8's dispatcher wholesale.

Items 3, 6 and 8 are code-only and deliberately not attempted: doing push
properly — crypto, service worker, permission UX, cost suppression, isolation —
is the phase. They are recorded as open, not as done.

## The crypto is hand-written, and that is the point

`web-push` on npm would have done this in three lines. It is also ~15
transitive dependencies in the path of a message sent to a child's parent, in a
codebase whose server depends on `pg` and `jose` and nothing else.

Everything needed — P-256 ECDH, HKDF-SHA256, AES-128-GCM, an ES256 signature —
is in `node:crypto`. It came to about 120 lines. The decisive argument was not
size: **both RFCs publish worked examples with fixed keys and a fixed expected
output**, so the implementation is asserted against the *specification* rather
than against its own previous output. A snapshot of my own bytes would pass
just as happily if every one of them were wrong.

`db/tests/…` cannot check this, so `web-push.test.ts` does: RFC 8291 §5's vector
matches byte for byte. It passed on the first run, which is the only reassuring
thing about writing your own crypto.

Getting it wrong would not have failed loudly. A push service accepts a
malformed body with a 201 and the browser silently fails to decrypt, so the
symptom is "some parents never get notifications" — reported weeks later by
somebody who assumed they had turned them off by accident.

## The endpoint is globally unique, and that is a security property

`push_subscriptions.endpoint` is `UNIQUE` across every tenant. Not tidiness:

A push endpoint identifies a **browser**, not a person. Two users at two
different schools sharing one device and one origin — a school office computer,
a shared family phone — receive the SAME endpoint from the push service. If both
rows were allowed to exist, school A would go on pushing to a browser now used
by school B's parent, and B's parent would read A's notices on their lock
screen. No amount of RLS prevents it, because both rows are individually
legitimate inside their own tenant.

So: one row per endpoint, and whoever most recently proved they are signed in on
that device owns it. Claiming it deletes the previous owner's row, which
necessarily crosses tenants — hence `app.claim_push_subscription()`, SECURITY
DEFINER for exactly that one DELETE. It takes **no tenant and no user
argument**: both come from the session, so there is nothing a caller could
supply to redirect the row, and it re-checks active membership because DEFINER
means RLS is not doing it. `db/tests/web_push.sql` §4 is the test.

## Not even the principal

Layer 2 on this table is **owner-only**, a deliberate departure from every other
table in the product. Management can see who received a notice, who was absent,
who paid. A push endpoint is different in kind: it is a **capability** — whoever
holds it can put a notification on that person's phone — and no question the
office has to answer requires it. The API never returns one either; the screen
gets a 12-character fingerprint, enough to identify a row for deletion.

`app.is_system_ingest()` is admitted for the sender, the same narrow admission
migration 010 makes for the outbound-delivery worker on `sms_outbox`.

## The saving, and the order that makes it safe

Push is a second **transport** on the existing pipeline, not a second pipeline.
It sits between enqueueing and sending and asks one question of each queued
message: *could this have gone to a browser instead?*

**Push is attempted first, and the SMS is cancelled only once a push service has
accepted the message.** The other order — cancel, then try — loses the message
whenever push fails, and it fails for ordinary reasons: a revoked permission, an
uninstalled browser, an outage. A failed push therefore costs a few
milliseconds; the row stays `queued` and goes out as SMS a moment later. A
school is never worse off than before R-9, only cheaper when push works.

No new table: `sms_outbox.status` already had `'suppressed'`, so a cancelled SMS
stays an honest record of what the school did not pay for, with
`error_code = 'delivered_by_push'`.

**Two things are never suppressed.** An emergency notice — "school is closed
today" should arrive by every route available, and it is the one message worth
paying twice for. And anything `auth.*`: a person requesting a login code may
well be doing so *because* they have lost access to the app that would have
received the push.

**Suppression is opt-in per school, default off.** Replacing an SMS with a push
is a judgement about a school's parents, not a technical fact: a notification
can be muted at the OS level or land on a phone the parent has handed to the
child. Until a school opts in, push is purely additive, and the dispatcher
reports `couldHaveSuppressed` — what opting in would have saved, which is the
number that makes the case for it.

## Two defects, one of them older than this phase

### 1. A screen that loaded forever

`navigator.serviceWorker.ready` resolves when there is an ACTIVE worker, and
when registration has failed it does not resolve **at all**. Not slowly: never.
It has no rejection path.

So on any browser where the service worker fails to register — a corporate
policy, some private-window modes, a failed update — the notification screen sat
on its loading skeleton permanently, with no error and no way out.

Found in a real browser within a minute. The unit tests could not see it: they
inject a client rather than touching `navigator`. Fixed with `getRegistration()`
on the read path, which settles either way, and a bounded race on the subscribe
path, which genuinely needs `.ready`. The regression test hands the client a
promise that never resolves.

### 2. A setting that had never saved (pre-existing, R-3)

The settings endpoint wrote with
`jsonb_set(settings, '{sms,noticeMaxChars}', …, true)`, and `create_missing`
creates the **last** element of a path, never the object that would contain it:

```
jsonb_set('{}', '{sms,noticeMaxChars}', '180', true)  →  {}
```

On any school whose `settings` had never held an `sms` object — every freshly
provisioned one — the PUT returned 200, the screen said সংরক্ষিত, and **nothing
was written**. The next visit showed the default, which reads like somebody
changing their mind rather than like a defect.

It survived from R-3 because **there was no test file for that endpoint at
all**. R-9 hit it on the first save, because `push` is a key that never
pre-exists. Fixed with a `||` merge at both levels; both keys now persist, and
neither clobbers the other or the branding stored beside them. A 13-test suite
now exists, and it asserts against the **column** rather than the response —
the response was right all along.

### 3. My own harness, not the product

The acceptance script reported a cross-tenant leak. It connects as
`shikhon_owner`, a SUPERUSER in the local container, and superusers bypass RLS
unconditionally. `db/tests/web_push.sql` had it right with `SET ROLE
shikhon_app`; the harness did not. The product was never wrong, and the fix was
one line in the harness.

## Migration 047

One table, one function. The rollback is the first in this product that **loses
data**, and says so: dropping `push_subscriptions` discards every registered
device. Nothing about a person, a child, a mark or a payment is in it, and the
browser can re-issue everything — but the consequence is silence, not an error,
because from the browser's side the subscription still exists.

Full cycle exercised: **up → 12 assertions pass → down → the suite correctly
fails (table gone) → up → 12 assertions pass**, 47/47 applied. Wired into CI in
both the main and re-run passes; `schema_lint` and the RLS-coverage gate both
pass on the new table.

## Tests

**1037 with a database attached, 755 without, all passing.** 13 DB suites green.
New in R-9:

| suite | what it holds |
|---|---|
| `packages/server-core/test/web-push.test.ts` (24) | RFC 8291 §5's vector byte for byte; `aud` is the push service ORIGIN; the signature is raw r‖s, not DER |
| `db/tests/web_push.sql` (12) | the shared device evicts the previous school; not even the principal can read an endpoint; the DEFINER function cannot be redirected |
| `services/ops-svc/test/push.test.ts` (23) | no response ever contains an endpoint; nothing inside a network survives the SSRF guard |
| `services/sms-svc/test/push-send.test.ts` (18) | a FAILED push never cancels an SMS; an emergency and a login code are never suppressed |
| `services/ops-svc/test/settings.test.ts` (13) | the endpoint's first test file, written for the bug above |
| `apps/pwa/test/push-ui.test.ts` (25) | every state renders something; the click target can only be an in-app route; `serviceWorker.ready` cannot hang the screen |

## Browser verification

- **`denied`** — the automation browser blocks notifications by policy, which
  made it the right browser to verify the hardest state in: no button, and an
  explanation of where the block actually is. A button there would call
  `requestPermission()`, get `denied` back without showing anything, and look
  like a broken app.
- **`unconfigured`** — the same screen on the deployment with no VAPID keys,
  proving the precedence: an unconfigured server outranks a denied browser, so
  nobody is sent to fix their browser for a feature the school has not enabled.
- **Mobile 375×812** — `scrollWidth === clientWidth`, no horizontal overflow.
- **The school-wide toggle** — saved as principal, **refreshed**, and both it
  and the SMS length survived. This is what caught defect 2.
- **End to end** — notice → dispatcher → VAPID header → real HTTP push service →
  decrypted to `{"title":"নথি বিদ্যালয়","body":"আগামীকাল বিদ্যালয় বন্ধ থাকবে।"}`,
  SMS row `suppressed`/`delivered_by_push`, other tenant sees 0 subscriptions.

**What could NOT be verified in a browser:** a real `pushManager.subscribe()`.
This automation browser denies notification permission by policy and blocks
service-worker registration, so the browser's own half of the handshake was
stood in for by a script that generates the same P-256 keypair, registers
through the same database function, and decrypts with the private key. That
proves our end of the contract completely and does not prove that Chrome and
Firefox accept our `applicationServerKey` — which is a first-contact risk,
recorded below rather than claimed.

## Offline classification

**Online-acceptable, deliberately.**

- **Subscribing** requires the network by definition: the browser is asking a
  push service for an endpoint.
- **The notification screen** is configuration, not a workflow a teacher must
  complete during a power cut.
- **Receiving** a push is the opposite of an offline concern — it is what
  happens when the device *has* connectivity, and it arrives whether or not the
  app is open, which is the whole point.

Nothing here touches the outbox or the sync engine, and no second offline
mechanism was created.

## Known limitations

1. **Never handshaken with a real push service.** Verified against the RFC
   vectors and a fake service; FCM, Mozilla and Apple have not seen a message
   from this code. The likeliest first-contact corrections are the
   `applicationServerKey` encoding and a 400 whose body explains nothing.
2. **A real `pushManager.subscribe()` was not exercised** — see above.
3. **No retry for a push that failed transiently.** A 500 or 503 leaves the row
   `queued` and the SMS goes out, which is the safe outcome and also means a
   momentary push outage costs the school an SMS. `failure_count` is stored and
   nothing reads it yet.
4. **`last_success_at` means a push service accepted it**, not that a person saw
   it. The same distinction R-8 drew for SMS, drawn here in the column name.
5. **No per-notice channel choice.** A school opts in for everything or nothing;
   there is no "always SMS for absences, push for the rest".
6. **iOS needs the app added to the Home Screen** before Safari will allow web
   push at all. The screen reports `unsupported` there, which is accurate, but
   it does not explain the Home Screen step.
7. **DNS rebinding is not defended against.** The SSRF guard refuses IP
   literals, non-https, credentials in the URL and internal-looking names, but a
   public hostname whose DNS answers with a private address would still be
   fetched. Defeating that needs resolve-then-connect-to-the-resolved-IP, which
   `fetch` does not offer.

## Carried backlog — preserved, none of it closed by R-9

**R-3:** class/section edit UI · guardian unlink workflow · audit export and
entity-name resolution · `POST /rms/solve` API-only by decision.

**R-5:** object storage (no stored PDFs or student photos) · CSV export
(`toCsv()` still unused) · multi-card ID-card layout · **money-formatting
decision** (still open, still needs a call).

**R-6:** an index on the board registration/roll columns · an attendance
date-range filter · type-ahead suggestions.

**R-7:** operator SSO and key rotation · trial expiry automation · per-class
group configuration in the wizard · logo/favicon/watermark upload in the wizard
· wildcard DNS/TLS · platform audit UI · plan feature gating.

**R-8:** SMS retry backoff · AI soft-limit notification wired to R-2 ·
per-message cost on send · the aggregator contract, the MFS merchant agreement,
the data-residency decision and pilot schools (all external).

**R-9 (new):** push retry/backoff · per-notice channel choice · the iOS
Home-Screen explanation · a first-contact test against a real push service.

**R-9 items NOT built, and still open:** section chat (optional per the plan) ·
content authoring workspace (F-403) · NCTB corpus ingestion (F-1301, external) ·
photo/voice submissions (F-902, external — object storage) · report trend charts
(F-1505) · native app wrappers (external) · library/transport/hostel/payroll.

## Unresolved bugs / issues

**1. `GET /api/v1/sync/pull` is built, mounted, tested — and no client ever
calls it.** Carried forward from R-8, unchanged and **not** closed: R-9 touches
nothing in the sync path. The only client-side mention remains a service-worker
routing rule declaring a caching strategy for a URL nothing requests;
`transport.ts` calls `/sync/push` and nothing else. Two honest resolutions
exist — wire the client to it, or delete it and its documentation — and R-9
chose neither.

**2. `docs/09-PRD-AUDIT.md` is stale**, as described above. Its P0 rows for
F-403, F-406, F-902 and F-1301 remain accurate; several of its P1/P2 rows have
since been closed by R-1…R-8 and it has not been updated in place.

## Next recommended step

**R-10 is not defined.** The master plan ends at R-9, whose remaining items are
either externally blocked or genuinely want a pilot school to aim at. The
highest-value code-only work left on the R-9 list is the **content authoring
workspace (F-403)**: it is the last open P0, and the reason it matters is stated
best by the audit itself — the product can teach a syllabus it has not been
given. Every consumer of content is built; the producer is not.

---

# 2026-08-29 · R-7 completion pass · Onboarding that actually reaches attendance

**Status: complete.** A shikhonBD operator onboards a **School** and a
**College** through the console, and each institution then runs its own core
workflow — five roles signing in and a teacher taking attendance — without a
line of SQL after the wizard starts.

R-7 was marked DONE in the entry above. It was not: the wizard built a school
correctly and the school could not then be used. This pass walked the whole
path the master plan describes, found seven defects, and closed them. Three of
the seven had been shipping since before R-7.

## What the audit found before any code was written

The R-7 entry above records two institutions onboarded through the console. One
of them, **মোহাম্মদপুর কলেজ, was stored as `stream=madrasah, level=combined`
and listed on the console as মাদ্রাসা** — a college displayed as a madrasa, on
the operator's own screen, for the whole phase.

That was not a typo. Screen 1 labelled the **stream** field "প্রতিষ্ঠানের ধরন"
— institution type — and the tenant list printed the stream in its ধরন column.
A stream is a teaching MEDIUM. So an operator asked for a type was shown a list
of mediums, and the four types the product supports — School, College, Madrasa,
School & College — could not be chosen at all. An operator had to know that
"College" is spelled `level=higher_secondary`.

It survived because **`apps/pwa/src/platform.ts` had no test file**. R-7 tested
the endpoints beneath the wizard thoroughly and the nine screens driving them
not at all.

## The seven defects

### 1. Institution type was not expressible (R-7)

The four types are already implied by `stream` + `level`, so they are **derived,
not stored** — a third column would be a second source of truth for a fact the
first two carry, and they would disagree the first time somebody changed a
level. `apps/pwa/src/institution-type.ts` holds the derivation; screen 1 now
asks for the type and constrains the medium and level to what that type can be,
so a School can no longer be built out of a madrasah medium and read back as a
madrasa. 21 tests, including a round trip over every (type, stream, level) the
wizard can produce.

### 2. One administrator, then the door closed (R-7)

Screen 7 created exactly one account and advanced. R-7.9 says an `it_admin` is
"created the same way", and a school needing both a principal and an IT admin
could not be finished — the second account required SQL.

The screen now creates accounts one at a time, suggests the role not yet made,
and lists what it has created. **The first version of that fix was itself
wrong**: the primary button created the account, set the activation code and
navigated away from the only screen that renders it, so the second code was
destroyed before anyone read it. A code is shown once and stored nowhere.
Creating now always stays, and each code sits beside the name it belongs to.

### 3. The wizard was not resumable (R-7)

R-7.15 promised it — "an operator can stop after step 4 and finish tomorrow" —
and every step does commit, so nothing was ever lost. What was missing was the
way back **in**: the wizard could only be entered by "+ নতুন প্রতিষ্ঠান", which
clears `tenantId` and starts a different school. An operator who stopped after
the academic setup had no route to the imports.

`resumeStepFor()` derives the step from the same counts the readiness checklist
shows, so the button names what is actually missing: *সেটআপ চালিয়ে যান — শিক্ষক
আমদানি*.

### 4. The import lost the file between validating and importing (R-7)

Dry run, then Import — and Import answered **"একটি CSV ফাইল বেছে নিন"**, one
click after validating that very file. `render()` rebuilds the file input, so
the commit re-read an input that no longer held anything. The validated text is
now kept, which is also what `digest` was always for: the bytes imported are
provably the bytes that were checked.

### 5. The importer rejected the columns its own screen asks for (R-7)

The student-import hint reads *"কলাম: রোল, নাম, শ্রেণি, শাখা, অভিভাবকের
মোবাইল"*. A CSV written by following that instruction was rejected with
**"ফাইলে আবশ্যক কলাম নেই: guardian_phone"** — naming a column the instruction
never mentioned. `অভিভাবকের মোবাইল` is now an accepted spelling, along with
`অভিভাবকের ফোন` and `অভিভাবকের নাম`.

### 6. A College could not take a single student (pre-existing, migration 012)

The NCTB catalogue covered **classes 1–10 and nothing above**. A college
provisioned cleanly — 2 classes, 2 sections, 7 grading bands, 6 fee heads — and
`class_subject_mappings: 0`. Since a fourth subject is required from class 9
upwards and there were no class-11/12 subjects to name, **every row of its first
student import was rejected**.

Two of the four supported types are affected: College, and the upper half of
School & College. Migration 048 seeds the higher-secondary set — the compulsory
subjects and the three groups, plus an আলিম core for madrasahs running to that
stage. It is reference data only: `provision_tenant` already selects from this
table by stream, level and group, so a college now provisions correctly with no
code change.

The codes are `H`-prefixed identifiers of ours, not claimed NCTB paper numbers.
Two reasons, and the second would have caused a bug: the subject set and group
structure are stable and stateable, the exact paper codes are not — and the
existing codes in that table are SSC papers, so a `combined` institution
provisioning classes 1–12 would receive `101 / Bangla 1st Paper` twice and
`ON CONFLICT DO NOTHING` would silently drop one.

### 7. No real user could save attendance (pre-existing)

The last step of the acceptance, and the worst of the seven. The attendance
route was mounted with a **hardcoded `academicYearId: 'yr-2026'`**, left over
from before there was a roster to ask. It is not a uuid, so every save a real
teacher made was rejected by sync with `invalid input syntax for type uuid` —
and `/sync/push` answers **200** with the rejection in the body, so the screen
could only render "১টি পাঠানো যায়নি" with no way to learn why.

Nobody had taken attendance as a real user in a real school until this walk.
`/academics/sections` now returns `academicYearId`, the roster caches the whole
section descriptor, and the attendance screen uses it — which also replaced the
hardcoded "৯-ক" header with the section's real name.

### And two things that were not defects

**A teacher taking attendance for a section they do not teach was refused** by
`attendance_sessions_scope`. That is the security model working: the wizard's
teacher import says section assignment happens later from the school's own
screens, and once the principal assigned the class teacher through
`#/academic`, the same save applied — `records: 2, smsQueued: 1`.

**The plan editor's refusal blanked the detail screen.** The detail view took
over the whole screen on any error, which is right for a failed LOAD and wrong
for a failed SAVE: the data is still there and the operator needs the form back.
An error now renders inline when there is content behind it.

## What else this pass added

- **Plan, cap and trial end are editable** (`POST /platform/plan`). They were
  writable exactly once, at creation, so a school that outgrew its cap needed
  SQL — and the refusal an operator sees on an over-cap import named a limit
  nothing in the console could raise. A cap below the current enrolment is
  refused, naming both numbers, because migration 045's trigger would otherwise
  leave the school permanently unable to enrol anyone with nothing on screen to
  explain it. No migration: the platform role writes inside the target tenant's
  own context, exactly as `setBranding` does.
- **Activation codes for staff.** `activation_issue_scope` has always let a
  principal issue a code for anyone in their school, and only the student roster
  offered it. So a teacher or IT admin — including the one the console had just
  created — could not be given a code through any UI. **Backend complete, UI
  absent**, and it was the account a new school needs first. The users screen
  now offers it with the roster's reveal-once card.
- **The activation door is always available.** It appeared only when OTP was
  switched off, as a fallback for the missing aggregator. But an activation code
  is how every newly onboarded school gets in, and with OTP enabled the door
  vanished — so a principal holding the code the console had just printed had no
  way to use it. That is R-7's own exit criterion, failing on any deployment
  where OTP works.
- **`platform.ts` boots only in a browser.** It called `matchMedia` and
  `getElementById` at module scope, which is why the nine screens had no tests.

## Browser acceptance — two institutions, five roles, one attendance

Both created through the console UI, both activated, no SQL after the wizard
started.

| | মনিপুর স্কুল | মোহাম্মদপুর কলেজ |
|---|---|---|
| Type | **বিদ্যালয়** (school) | **কলেজ** (college) |
| Level / medium | secondary · bangla_medium | higher_secondary · bangla_medium |
| Colour | `#1b5e20` | `#7b1fa2` |
| Head teacher | মোছাঃ রোকসানা বেগম | অধ্যক্ষ ড. শাহাদাত হোসেন |
| Classes · sections | 5 · 10 | 2 · 2 |
| Subjects | 36 | 13 |
| Students | 10 | 3 |

Five logins in মনিপুর স্কুল, each with an activation code issued through a UI:

1. **Principal** — `NSCUPSHX` from the wizard, then `PNN47VEV` reissued through
   the console's reuse path (`reused: true`, no duplicate account).
2. **IT admin** — created on screen 7 alongside the principal.
3. **Teacher** — code issued from the users screen, the surface this pass added.
4. **Student** — code issued from the roster by the principal.
5. **Guardian** — and the ward view shows **both children**, রাফিয়া and
   সাদিয়া, who shared one phone number in the CSV. The M:N guardian model
   works end to end from a spreadsheet column.

**Attendance:** the teacher marked রোল ১১ absent in নবম শ্রেণি — ক and saved.
`status: "applied"`, `records: 2`, `smsQueued: 1`. One session and two records
in মনিপুর স্কুল; **zero** in মোহাম্মদপুর কলেজ.

### Failure and recovery, walked

Student cap set to 10 deliberately. Importing 5 more students over 7 was refused
with **"student cap reached: this institution is capped at 10 students and this
would make 11"** — and **nothing partial was written**, still 7. Lowering the
cap to 3 was refused with *"সীমা 3 করা যাবে না — এই প্রতিষ্ঠানে এখনই 7 জন
শিক্ষার্থী আছে"*. Raising it to 300 succeeded and the blocked import then
completed. A bad row (class 99) was rejected with its line, roll, field and
reason while the other 7 imported — partial import, loudly.

### Cross-tenant, attempted rather than assumed

With a live Tenant A teacher session:

| Attempt | Result |
|---|---|
| `GET /platform/tenants` | 403 |
| the same **with** `PLATFORM_API_KEY` | 403 — both factors required |
| B's section by id | 404, not 403: no existence disclosure |
| B's student history by id | 404 |
| search for B's student by name | 0 results |
| `x-tenant-id: <B>` header | ignored; A's own sections returned |
| `?tid=<B>` on the app URL | session stays in A — title, classes, everything |
| sync push naming B's tenant and section | `TENANT_MISMATCH` |

## Performance

Measured, not claimed. Server work per step, from the console against a real
PostgreSQL: tenant creation ~1 s, academic provisioning **6.3 s** for a
5-class/10-section school (48 subject mappings, grading bands, fee heads,
14 ledger accounts) and ~1 s for a 2-class college, teacher import of 3 rows
~1 s, student import of 8 rows ~2 s.

**Wall-clock for a full onboarding is not honestly measurable from this run** —
it included applying a migration mid-flight and re-provisioning — so no
end-to-end figure is claimed. The step timings above are real; the master plan's
"hours, not days" is comfortably met by them, and a clean single-operator run
should be well under fifteen minutes.

## Tests

**1059 across 12 workspaces**, all passing. New: `apps/pwa/test/platform-console.test.ts`
(21 — the wizard's first test file), plus a Bangla-header regression in
`student-import.test.ts`. Eight DB suites re-run green; D11 three-way guard,
parameter-property guard and `schema_lint` all pass. Migration 048 exercised
up → down (33 → 0) → up (33), 48/48 applied.

## Known limitations

1. **The higher-secondary catalogue is a starting set, not the full NCTB
   syllabus.** Compulsory subjects and the three group cores; a school adds what
   else it teaches from its own subjects screen. The আলিম set is deliberately
   smaller still, because that group structure varies by board.
2. **`nctb_code` for those rows is ours, not the board's** — see defect 6.
3. **The student cap refusal is in English**, surfaced raw from the database
   trigger. Clear, and inconsistent with the rest of the console.
4. **The console's admin endpoint will grant a role to an existing phone
   number** and reports `reused: true`. That is the documented behaviour and it
   is how a code is reissued — but it also means typing an existing teacher's
   number while "principal" is selected quietly makes them a principal. It
   should name the person and ask.
5. **Teacher subject assignment is still per-section, by hand.** The wizard
   imports teachers and says so; a school with 40 teachers and 50 sections has a
   lot of clicking.
6. **`app.tenant_onboarding_state`'s `has_branding` measures `logoUrl`**, which
   the wizard cannot set. The checklist row is now labelled লোগো so it says what
   it measures, and resume no longer gates on it.
7. **Wildcard DNS and TLS remain unprovisioned** (carried from R-7).

## Carried backlog — preserved, none of it closed here

**R-3:** class/section edit UI · guardian unlink workflow · audit export and
entity-name resolution · `POST /rms/solve` API-only by decision.

**R-5:** object storage · CSV export (`toCsv()` still unused) · multi-card
ID-card layout · **money-formatting decision** (still open).

**R-6:** an index on the board registration/roll columns · an attendance
date-range filter · type-ahead suggestions.

**R-7 (remaining):** operator SSO and key rotation · trial expiry automation ·
per-class group configuration in the wizard · logo/favicon/watermark upload in
the wizard · wildcard DNS/TLS · platform audit UI · plan feature gating.

**R-8:** SMS retry backoff · AI soft-limit notification wired to R-2 ·
per-message cost on send · the aggregator contract, the MFS merchant agreement,
the data-residency decision and pilot schools (all external).

**R-9:** push retry/backoff · per-notice channel choice · the iOS Home-Screen
explanation · a first-contact test against a real push service.

## R-9's pilot gate — recorded, and not satisfied

**Web push was implemented on 2026-08-29, before any pilot**, and is recorded as
an **independently implemented R-9 capability**: it needs no pilot feedback to
design correctly, because it carries a message a school already sends over a
cheaper channel, with no change to who receives it or what it says.

**The R-9 pilot gate stands for the other six items** — section chat, content
authoring (F-403), NCTB corpus (F-1301), photo/voice (F-902), trend charts
(F-1505), native wrappers, and library/transport/hostel/payroll. Several are
exactly the questions a pilot answers: whether section chat is wanted and how it
must be moderated, which reports a principal actually opens, whether photo
submission earns its storage bill. Nothing in this pass changes that, and web
push remains deployed dark until an operator generates VAPID keys.

## Unresolved bugs / issues

**1. `GET /api/v1/sync/pull` is built, mounted, tested — and no client ever
calls it.** Carried unchanged from R-8 and R-9, and not closed here: this pass
touched `/sync/push` only to diagnose the attendance rejection. `transport.ts`
still calls push and nothing else.

**2. `docs/09-PRD-AUDIT.md` remains stale** (2026-08-12, pre-R-1…R-9).

## Next recommended step

**A pilot.** Every remaining R-9 item is behind that gate, R-8's open items are
contracts, and this pass has now walked the full operator path end to end
against a real database. The product's next real information comes from a
school, not from another phase.

---

# 2026-08-30 · R-8 production-readiness pass · Everything that is code

**Status: the code half is complete. The pilot half has not started, and R-8
cannot be called complete without it.**

R-8 as specified is production readiness *and* a pilot: real environments, a
real SMS aggregator, real backups, real monitoring, and three to five real
institutions with real teachers and real children. A large part of that is not
code and could not be done from this repository:

| Asked for | Why it did not happen |
|---|---|
| Production/staging environments configured | No deployment, no host credentials. Nothing in this environment can reach a Vercel, Netlify or Neon project |
| Real Bangladesh SMS provider | No aggregator contract and no credentials. Unchanged since the first R-8 pass |
| Real push delivery test | No real push service credentials and no device; the automation browser denies notifications by policy and blocks service-worker registration |
| Backup and restore, with a restore test | No production database to back up or restore |
| Monitoring and alerting | No production infrastructure to monitor |
| 3–5 pilot institutions, real users, offline pilot | Real schools, real teachers and real children cannot be recruited from a repository |

**Reporting any of those as done would be the exact failure the previous R-8
pass was written to prevent** — a readiness screen going green while nothing is
actually going out. So they are recorded as not done, and this entry covers
what genuinely was.

## What was built

### §4 — SMS safety, which is the part that mattered most

The single most valuable thing buildable here, because it guards the step
nobody has taken yet: pointing a real aggregator at a real school.

**The composer now says how big a send is.** It already restated the audience
as a sentence and showed the segments per person. What it could never say was
how many people "সব অভিভাবক" IS — so choosing between "this section" and "all
guardians" was choosing between two phrases, one of which costs a hundred times
more, with nothing on screen saying so. `POST /ops/notices?preview=1` counts
from `app.resolve_notice_audience`, the same STABLE resolver the publish path
uses, so the estimate and the send cannot disagree. No migration.

Two numbers, and the second is the surprise: on the acceptance school, "সবাই"
is **22 people and 4 SMS** — the rest have no phone on file or have not
consented. The bill is made of the smaller number.

The segment count is computed from `noticeSmsBody(...)` — the message the
sender actually transmits, trimmed to the tenant's cap and signed with the
school — not from the raw notice body, which is wrong in both directions at
once. The composer's per-person line now uses the server's figure too, because
two numbers disagreeing on one screen is worse than one arriving a moment late.

**Above 200 messages the send button is disabled** until a box stating the
actual numbers is ticked, and changing the audience revokes that
acknowledgement. Without the revoke, ticking for a section and then switching
to "everyone" would carry consent to a batch a hundred times larger — a gate
that made things worse than no gate.

▶ **The gate's first version was a dead end**, and a test caught it. The
estimate arrives asynchronously; `syncLive()` disabled the send button but only
`render()` draws the checkbox, so an operator saw a permanently disabled button
with nothing to enable it. The gate now forces a full render when it flips.

**`SMS_TEST_RECIPIENTS` is an allowlist**, checked immediately before the
provider call rather than at enqueue. The row is still written, still counted,
still visible — only the send is withheld, recorded as `suppressed` /
`not_in_test_allowlist`. A pilot can therefore run the real pipeline against
real school data and read exactly what would have gone out. Withholding does
not consume a retry attempt, so lifting the allowlist leaves the message
sendable.

### §9 — the four R-7 sharp edges

**A. An existing teacher was silently promoted.** Reusing an account rather
than creating a second one for a human is right and stays; doing it silently
was not. An operator who mistyped a digit onto an existing teacher's number,
with "principal" selected, promoted that teacher — and saw only `reused: true`
in a response the console never surfaced. It happened to me during R-7's
acceptance walk, which is how it was found. The endpoint now answers **409
`user_exists`** naming who the number belongs to and what they already are, and
the console asks. `confirmExisting: true` is the second act.

**B. The cap refusal reached operators in English**, straight from migration
045's trigger. The trigger is the invariant and is unchanged — it must fire
under concurrency and its message is right for a database log. The API stops
passing it through and answers with the numbers in Bangla, plus the fact an
operator most needs and a constraint message never gives: **nothing was
imported**.

▶ **The first version of that fix returned 500.** The trigger aborts the
transaction, so the catch block's re-read query failed too with `25P02`. The
numbers are now read *before* the import, and not parsed out of the message —
a message format is not an interface.

**C. HSC subject codes.** Migration 048's `H`-prefixed identifiers are ours,
not board paper numbers, and 048's header says so — which is a fact living in a
file nobody reads while the column goes on being called `nctb_code`.
`subject_catalogue.verified_against` has existed since migration 012 and is
**NULL on all 73 rows**: nothing has ever been checked against a circular. The
subjects API now reports `codeVerified` per subject from that column, so the
provenance travels with the data.

Finding, stated plainly: **no user-facing surface renders a subject code at
all** — not the subjects screen, not any printed document. The risk §9C names
is latent rather than live, and the field is there for when a surface does show
one.

**D. Subdomains were presented as working.** The console listed a school's
subdomain beside the install link under "both lead to the same institution",
and `*.shikhonbd.com` has never had DNS or a certificate. An operator could
reasonably have printed that on an admission slip. `WILDCARD_DNS_READY` is a
switch set only after provisioning; unset, the install link comes first and the
subdomain is marked **এখনো চালু হয়নি**. There is no way to detect this from
the product — a DNS lookup in a serverless function proves nothing about a
visitor's resolver — so an explicit switch that fails closed is the honest
mechanism.

### §10 — operational admin

`GET /platform/health` and a চলমান অবস্থা panel: SMS queue depth and the age of
the oldest queued message, sent/delivered/failed/suppressed, segments this
month, cost, the top failure codes, push devices and last push, **last login,
active users in 7 days, last attendance**. All counts and timestamps.

Deliberately **no names, no phone numbers, no student rows**. An operator
supporting a school needs to know whether its messages are going out and
whether anybody has logged in; the school's own staff have the screens that
show people. A platform operator browsing pupil records is what tenant
isolation exists to prevent, and rebuilding it here for convenience would be
perverse.

### §1/§8 — CORS

`Access-Control-Allow-Origin: *` was never a CSRF hole — this API authenticates
by bearer token and never by cookie, so a browser sends no ambient credential
and a hostile page has nothing to ride on. What it cost was defence in depth.
`ALLOWED_ORIGINS` narrows it, echoing the request origin with `Vary: Origin`;
**unset, behaviour is exactly what it was**, because a production control that
breaks an unconfigured deployment is one nobody turns on.

## §8 — the security review, and what it found

Run against the real database rather than read off the source.

| Check | Result |
|---|---|
| RLS on every tenant-scoped table | **Pass.** 12 tables lack FORCE; 10 are platform-global reference data with no `tenant_id` |
| `product_events` / `product_event_rollups` | Tenant-scoped and not FORCEd — **verified safe**. RLS is *enabled*, so the runtime role is bound; FORCE is off only so the maintenance cron's owner can aggregate. Probed directly: owner sees both tenants, `shikhon_app` sees exactly one |
| Service roles | **Pass.** Neither `shikhon_app` nor `shikhon_platform` has `BYPASSRLS` or `SUPERUSER` |
| Secrets in browser bundles | **Pass.** One hit is the string `PLATFORM_API_KEY` as a form *label*; the operator types the key and it lives in memory for the session |
| Secrets in git history | **Pass.** All 134 commits clean |
| XSS | **Pass.** `innerHTML` is used for icons from literal maps, and for the letterhead, which applies `escapeHtml()` to every interpolated value |
| CSRF | **Structurally absent.** No cookie authentication anywhere; nothing to ride on |
| SSRF | **Pass.** The push-subscription endpoint refuses non-https, URL credentials, IP literals and internal names. DNS rebinding remains undefended and is documented |
| Rate limiting | **Pass.** All 10 service dispatchers |
| Cross-tenant | **Pass.** Re-verified in R-7's acceptance: 404 not 403 for another school's rows, `x-tenant-id` ignored, `?tid=` ignored, sync push answered `TENANT_MISMATCH` |
| Platform authorization | **Pass.** A tenant token is refused 403 even when presented *with* `PLATFORM_API_KEY` — both factors required |

**Finding, recorded rather than fixed:** `SERVICE_API_KEY` is a full
cross-tenant impersonation credential on `/sync/push` and `/sync/pull` — it
permits `X-Tenant-ID` / `X-User-ID` / `X-Role` headers to be trusted. That is
the documented machine-to-machine design and the key is never in a browser, but
it is the widest tenant-scoped credential in the product and its rotation
matters more than its blast-radius note currently conveys.

## A test that was passing for the wrong reason

`db/tests/product_events.sql` claims to prove the rollup crosses tenants. It
arrived at that assertion with `app.tenant_id` still set from an earlier
fixture block — so with only one tenant's events in the window, every rollup
row matched the set tenant and **the cross-tenant path was never taken**.

It surfaced the moment a second tenant had events in the last seven days, which
is the state of any database that has been used: the R-7 acceptance logins put
telemetry in for two schools, and the suite failed with `cross-tenant insert
blocked`.

The production path was verified to be correct — the maintenance cron runs as
the owner with no tenant context, `shikhon_owner` is a member of
`shikhon_platform`, and `app.enforce_tenant` permits exactly that — so this was
a fixture fault. The context is now cleared explicitly before the rollup, and
the test exercises the production path rather than a single-tenant shadow of it.

## Tests

**1090 across 12 workspaces, all passing. 26 DB suites green.** New:

| suite | what it holds |
|---|---|
| `services/sms-svc/test/allowlist.test.ts` (7) | an unset allowlist means unrestricted, not "send to nobody"; a withheld row is recorded, not hidden; withholding costs no retry attempt |
| `services/ops-svc/test/notice-preview.test.ts` (8) | it counts who would be TEXTED, not who is in the audience; segments come from the sent message; preview **writes nothing**; a student cannot size the school's guardian list |
| `apps/pwa/test/notice-safety.test.ts` (6) | a big send cannot go without acknowledgement; the acknowledgement states the numbers; **changing the audience revokes it**; an offline estimate does not block sending |
| `packages/server-core/test/http.test.ts` (9) | unset `ALLOWED_ORIGINS` behaves exactly as before; an unlisted origin gets neither an echo nor a wildcard; credentials are never allowed |

Updated: the platform suite's reuse test now asserts the 409-then-confirm
contract, and its cap test asserts Bangla numerals and the absence of the
trigger's English.

## Browser verification

- **§9A** — the console refuses an existing number and names the person.
- **§9B** — an over-cap import answers 409 with "সীমা ১১ জন, এখন ভর্তি আছে ১০
  জন। কিছুই আমদানি হয়নি।" and the roll is unchanged at 10.
- **§9D** — the tenant detail lists the install link first and the subdomain as
  **এখনো চালু হয়নি**, with the note telling the operator which to print.
- **§4** — the composer shows "২২ জন পাবে · ৪ জনকে এসএমএস · আনুমানিক ৮টি
  এসএমএস" live as the audience and body change.
- **§10** — the চলমান অবস্থা panel shows last login ৩০ আগস্ট, 5 active users in
  7 days, last attendance ২৯ আগস্ট.

## Documentation

`docs/12-PRODUCTION-RUNBOOK.md` is new, and its **first section is a table of
what has and has not been exercised**, because every procedure in a runbook
reads identically whether it has been rehearsed or merely written down, and the
difference matters at 08:00 on a Sunday. It carries environment separation, the
domain position, the order in which to turn SMS on (allowlist first), SMS
troubleshooting, the untested backup/restore procedure with the RPO/RTO
decision still open, the absence of monitoring, a support matrix, and a pilot
checklist.

## What R-8 still needs, in the order it blocks a pilot

1. **An SMS aggregator contract.** Everything downstream of it is built and
   tested against a fake.
2. **A production deployment**, its environment variables, and its Neon
   project.
3. **A backup restored, and timed.** RPO and RTO are undecided.
4. **Cron-failure alerting.** If the dispatcher stops, no parent is told
   anything and nothing says so.
5. **Wildcard DNS and TLS**, or the acceptance that `?tid=` is the address.
6. **Three to five schools.**

## R-9's pilot gate

**Still not satisfied, and nothing in this pass changes that.** Web push
remains recorded as an independently implemented pre-pilot capability. Section
chat, content authoring, photo/voice, trend charts, native wrappers and
library/transport/hostel/payroll stay gated, and none was touched.

## Carried backlog — preserved

**R-3:** class/section edit UI · guardian unlink · audit export and entity-name
resolution · `POST /rms/solve` API-only.

**R-5:** object storage · CSV export · multi-card ID layout · **money
formatting** (still open).

**R-6:** board-registration index · attendance date-range filter · type-ahead.

**R-7:** operator SSO and key rotation · trial-expiry automation · per-class
group configuration in the wizard · logo/watermark upload in the wizard ·
platform audit UI · plan feature gating · teacher→subject assignment is still
per-section by hand.

**R-8 (new):** SMS retry backoff · monitoring and alerting · backup/restore
verification · RPO/RTO decision · `SERVICE_API_KEY` blast-radius review · a
curriculum specialist to fill `verified_against`.

**R-9:** push retry/backoff · per-notice channel choice · the iOS Home-Screen
explanation · a first-contact test against a real push service.

## Unresolved bugs / issues

**1. `GET /api/v1/sync/pull` is built, mounted, tested — and no client ever
calls it.** Carried unchanged from R-8, R-9 and the R-7 completion pass.

**2. `docs/09-PRD-AUDIT.md` remains stale** (2026-08-12).

## Next recommended step

**Sign an SMS aggregator contract and stand up one production deployment.**
Every remaining item on this list is behind one of those two, and the code that
waits on them has been built and tested as far as a fake can take it.

---

# 2026-08-30 · R-8 activation & hardening pass · The gap between configured and demonstrated

**Status: R-8 remains IN PROGRESS.** This pass closed the last of the code-side
work and built the machinery that will *record* the external work. It did not
do the external work, because none of it can be done from a repository: there
is no production deployment to configure, no aggregator contract to exercise,
no production database to restore, no device to push to, and no school to pilot
with.

What changed is that those gaps are now enforced rather than described. Before
this pass, "SMS is ready" and "an SMS reached a handset" were two claims that
looked the same in a report. Now the first is checked by a program and the
second requires a dated attestation from a person, and the preflight refuses to
call a deployment ready without both.

## The preflight (§1)

`scripts/preflight.mjs` — 32 checks over environment variables, secret strength
and distinctness, database separation and TLS, the maintenance and platform
roles, service-key posture, origins, committed bundles, the manifest and
service worker, cron ownership, SMS credentials and allowlist, VAPID keys, and
eleven external items. One line per check, with its evidence, never a value.

Three states, and the third is the point. PASS and FAIL are what a program can
decide. **UNVERIFIED** is for the things it cannot: DNS resolving, TLS
terminating, a restore performed, an SMS reaching a handset, a push landing on
a device, an alert waking a person. Those read from
`docs/production-evidence.json`, where a human records an outcome with a date,
and they lapse after 180 days.

It would have been easy to check the proxy — a key is set, a URL is configured
— and print PASS. That is the single most dishonest thing this file could have
done, and it is precisely the mistake the previous R-8 report was written to
avoid making twice.

Exit 0 all clear · 1 failed · **2 configured but never demonstrated**. This
deployment exits 1 today (6 fail, 16 unverified) and every one of those lines
is true.

## SERVICE_API_KEY (§2)

The previous report named this the widest credential in the product and left it
there. Removal was never the instruction and would have been the reckless
choice: this key is how an engineer replays a school's stuck sync batch at
11pm. So it was narrowed instead, in one place —
`packages/server-core/src/service-auth.ts` — because `/sync/push` and
`/sync/pull` held two copies of the logic and a change to one would silently
have left the other open.

1. **Off in production** unless `SERVICE_KEY_TENANT_SWITCH=on`. Dev, CI and
   staging unchanged; a control that breaks the places people actually run is a
   control that gets turned off again.
2. **Refused from a browser** — a valid key arriving with `Origin`, `Cookie` or
   `Sec-Fetch-Site` means the key has leaked into page code, and the refusal
   turns a silent leak into a dated log line. The check fires only *after* the
   token matches, so the PWA's unauthenticated system-screen probes still get
   their 401.
3. **Audited** — one structured line per acceptance and refusal, carrying an
   8-hex fingerprint, never the key.
4. **Rotatable** — `SERVICE_API_KEY_NEXT` is accepted alongside the current
   key, and the log's `keyLabel` says which slot each request matched, so a
   rotation can be finished on evidence rather than hope.
5. **Constant-time comparison.**

The same switch now gates the OTP debug echo, because echoing a live login code
is an account-takeover primitive and belongs behind the same door.

### The bug this found in its own first version

`Sec-Fetch-Mode` was in the browser-marker list. **Node's own `fetch` sends
`Sec-Fetch-Mode: cors` on every request** — and undici is what the Netlify cron
wrapper and every ops script use. Shipped, it would have refused the scheduled
SMS dispatch and the nightly maintenance job, silently, on the first production
run: the exact "a stopped cron silences a school" failure the monitoring work
in this same pass exists to catch.

It was found by running an acceptance probe against the live endpoint, not by
reading the code, and it is the strongest argument in this pass for probing
over reasoning. `Sec-Fetch-Site` covers the same browsers and undici sends
neither. There is now a test built from the exact header set undici produces.

## Monitoring (§7)

The previous report's most uncomfortable line was that a stopped cron would
silence a school with nobody noticing. `/api/v1/ops/monitor` is the answer:
scheduled every fifteen minutes, evaluating seven conditions across the whole
deployment, POSTing anything firing to `ALERT_WEBHOOK_URL`, and logging it
regardless so the host's log drain works as a sink from the first deploy.

The evaluation is **pure** (`packages/server-core/src/alerts.ts`) and the
gather is separate (`monitor-signals.ts`). Every threshold is a judgement call,
and judgement calls inside a database query are judgement calls nobody can
test; each is now exercised at its boundary without a database.

Note what most of the conditions watch for: not errors, but the **absence of
expected work**. A queue that stops draining. A partition that stops being
pre-created — which is a hard deadline, not a warning, because when the month
turns without one, every attendance write fails at once. Attendance that stops
landing. Loud failures look after themselves; somebody rings. The quiet ones
are invisible to anything that only counts errors.

Each alert carries its own investigation path and recovery procedure, so a
woken engineer reads what to do rather than remembering it. `sync_rejection_rate`
names the R-7 defect it exists to catch, because the lesson of that bug — the
client was sending something the server would not take, and the only symptom a
teacher saw was "১টি পাঠানো যায়নি" — is worth more than the threshold.

**What it cannot see:** API failure rate. There is no table of HTTP responses
and inventing one would duplicate what the host already records per invocation;
that alert belongs in the host's metric alerting, wired as the runbook
describes. And its own death — a dead function does not report it, so the
host's scheduled-function failure notification is part of the monitor.

### A second bug caught by reading it back

The gather bounded the SMS queue query to the last two partitions, for
performance. That would have excluded a message stuck since last week —
precisely the case `sms_queue_stalled` exists to raise — while leaving the
check looking like it worked. Split into two queries: recent activity stays
bounded, the queue is not bounded at all.

## The last two R-7 sharp edges

**§9A** already refused an existing phone number and named the person and their
current role. What it never named was the **consequence**, and "are you sure?"
without a stated outcome is how an operator clicks through. It now says, in
words: নিশ্চিত করলে এই অ্যাকাউন্টের ভূমিকা প্রধান শিক্ষক করা হবে। Not shown when
the account already holds the role, because a screen that cries wolf on the
harmless case is not read on the dangerous one.

**§11** The HSC catalogue is shikhonBD's own reference set with codes we
assigned — the `H-` prefix exists so they cannot be mistaken for board numbers
and cannot collide with SSC codes in a combined institution. The console now
says so at the moment classes 11–12 are seeded, before a registrar assumes the
list was checked against a circular and builds a year on it.

Both verified in a real browser, and both now held by DOM tests — which
required exporting the console class. That file's own header records that it
had no test file at all until R-7's completion pass, which is how a college
spent a phase being listed as a madrasa.

## CORS (§3)

`/sync/push` and `/sync/pull` still carried hardcoded `Access-Control-Allow-Origin: *`
after the previous pass routed everything else through the allowlist. Both now
use it. **Verified in Chrome:** with `ALLOWED_ORIGINS` set, a listed origin
receives the response and an unlisted one is blocked by the browser;
credentialed requests are refused; `Vary: Origin` is present so a shared cache
cannot serve one origin's response to another.

## Verification

- **1108 tests** with a database attached (1090 before this pass), **838**
  without. All passing.
- The monitor's gather **run against the real schema** — every column, the
  partition catalogue query, and the alert it produced from real rows.
- Alert delivery **proven end to end**: `GET` delivers nothing, `POST` produces
  exactly one webhook call with the right URL, method and content type,
  carrying the alert text, the environment and the recovery guidance and no
  secrets. A dead sink returns 200 with the reason, rather than taking the
  endpoint down with it.
- **Cross-tenant probes against the live sync endpoints**: a real teacher's
  token plus forged `X-Tenant-ID` / `X-User-ID` / `X-Role` returns that
  teacher's own school, byte for byte, with no row of the other tenant present.
  Headers without a token: 401. Garbage bearer with headers: 401.
- Browser acceptance of §9A, §11 and the CORS allowlist.

## What is still not done, and cannot be from here

Real SMS delivery · real push to a device · backups and a timed restore ·
an alert reaching a human · wildcard DNS and TLS · 3–5 pilot institutions ·
real users · a real offline test · cross-tenant tests against production.

Every one of these now has a named slot in `docs/production-evidence.json` that
is **null**, a preflight line that reports it as unverified, and a procedure in
the runbook. None of them is claimed anywhere.

## R-9's pilot gate

**Still not satisfied, and deliberately so.** No pilot has occurred. The web
push implementation recorded on 2026-08-29 remains an independently implemented
R-9 capability that did not require pilot feedback; the gate on the remaining
R-9 optional capabilities is untouched by this pass and stays shut.


## Carried backlog — preserved

**R-3:** class/section edit UI · guardian unlink · audit export and entity-name
resolution · `POST /rms/solve` API-only.

**R-5:** object storage · CSV export · multi-card ID layout · **money
formatting** (still open).

**R-6:** board-registration index · attendance date-range filter · type-ahead.

**R-7:** operator SSO and key rotation · trial-expiry automation · per-class
group configuration in the wizard · logo/watermark upload in the wizard ·
platform audit UI · plan feature gating · teacher→subject assignment is still
per-section by hand.

**R-8:** SMS retry backoff · backup/restore verification · RPO/RTO decision ·
a curriculum specialist to fill `verified_against` · per-institution subject
configuration for colleges beyond add and remove · API failure-rate alerting
in the host's own metrics · the host's scheduled-function failure notification.

*Closed by this pass: monitoring and alerting is built, scheduled and tested —
what remains is delivering one alert to a human, which is an attestation rather
than code. The `SERVICE_API_KEY` blast-radius review is done, and the key is
narrowed, audited and rotatable.*

**R-9:** push retry/backoff · per-notice channel choice · the iOS Home-Screen
explanation · a first-contact test against a real push service.

## Unresolved bugs / issues

**1. `GET /api/v1/sync/pull` is built, mounted, tested — and no client ever
calls it.** Carried unchanged from R-8, R-9, the R-7 completion pass and the
R-8 production-readiness pass.

**2. `docs/09-PRD-AUDIT.md` remains stale** (2026-08-12).

## Next recommended step

**Sign an SMS aggregator contract and stand up one production deployment**, in
that order. Everything left on this list is behind one of those two, and the
first thing to do on the deployment is run `node scripts/preflight.mjs` and
work the failures down — it is written to be the first command of that day.

---

# 2026-08-30 · R-8 production closure pass · Evidence that cannot be faked

**Status: R-8 remains OPEN.** Every external gate is still shut, and this entry
exists to record what was built to close them and what was actually observed —
not to move the status.

The instruction for this pass listed fifteen sections. Ten of them require a
production deployment, an aggregator contract, a domain, a real device or a
real school, and none of those exists. Rather than write ten paragraphs saying
so, the pass did the five that are real work and built the mechanism that makes
the other ten impossible to fake.

## The mechanism (§1, §13)

`scripts/preflight.mjs` checks configuration. `docs/production-evidence.json`
records observation. Neither can green the other's half.

The load-bearing part is the **environment field**. An attestation now names
the deployment it was made against, and the preflight compares that to the
deployment being checked. So this pass's restore drill — genuinely executed,
genuinely passing — reports as:

```
[ ?? ] a restore was performed and verified
       attested 2026-08-30 against "local-docker", NOT "production"
       — a rehearsal elsewhere, not evidence for this deployment
```

That line is the whole design. A rehearsal is real work and worth recording,
and it is not a production restore, and an evidence file that could not tell
those apart would let the first close the second.

## The restore drill (§5, marked highest priority)

`scripts/restore-drill.mjs`: back up, restore into an **isolated** database
(refusing outright if the target is the source), then compare the copy against
the original — every schema object count, every table count, and every tenant's
students, teachers, guardians, attendance, marks and invoices. Any difference
fails, and it names which.

The comparison is the point. "The restore completed" is not evidence:
`pg_restore` exits 0 having skipped objects it could not create, a dump taken
with the wrong flags restores a schema with no rows in it, and a partitioned
table can come back with its parent and none of its children. Every one of
those looks like success and has lost a school's attendance.

**Observed, local Docker, Postgres 16.15:** 2.6 MB dumped in 0.6s, restored in
3.0s. 121 tables, 355 indexes, 110 RLS-enabled tables, 227 policies, 86
functions, 162 triggers, 4 attendance partitions, 27 table counts and 8 tenants
— all identical. **RTO 4.0s**, on 2.6 MB, which is not a school year.

**RPO is not measured**, here or anywhere. It is a property of the backup
SCHEDULE, and a drill claiming to measure it would be measuring nothing.

### The drill caught a defect in its own comparison

It matched tenants **by display name**, and two schools on this database are
both called মোহাম্মদপুর কলেজ — so one was compared against itself and a phantom
mismatch reported. Two real schools sharing a name is ordinary in Bangladesh,
not a corner case. Keyed by id now.

## The live security probe (§12)

`scripts/security-probe.mjs` — committed rather than thrown away, because the
point of it is to be re-run: on staging, on production, after a policy change,
before a pilot. It discovers its own fixtures from whatever database it is
given, so the identical battery runs anywhere.

**29 checks over 12 areas, positive and negative, all passing.** Positive cases
are not filler: every negative here would also pass on a deployment where the
database is unreachable and everything 500s, and a report that cannot tell
"tenant B did not leak" from "nothing works" is worthless.

Covered: forged `X-Tenant-ID`/`X-User-ID`/`X-Role` ignored in favour of signed
claims; headers-without-token and garbage-bearer both 401; cross-tenant reads
of section, student and attendance by id refused; **a cross-tenant WRITE
through a payload `tenantId` not applied**; no runtime role holds SUPERUSER or
BYPASSRLS; tenant A's database context cannot see tenant B's rows by primary
key **while still seeing its own**; no tenant context means nothing visible;
every table carrying `tenant_id` has RLS enabled; a service credential from a
browser refused; a user token is not a service credential and cannot run
maintenance; 7 SSRF vectors (http, loopback, 169.254.169.254, private range,
userinfo, `.internal`, `.local`) all refused; cross-tenant notice and document
access refused; the platform health endpoint unreachable with a tenant token;
the console refuses both a tenant user and an anonymous caller; no live secret
or connection string in any bundle; error bodies carry no credential; an
unlisted CORS origin is not echoed and credentials are never allowed;
per-phone OTP requests are rate-limited.

**A third state had to be added.** The OTP check first reported FAIL, and the
cause was the fixture: OTP is disabled on that deployment and the feature gate
answers before the limiter, so the check could not run. Reporting that as PASS
would have been the exact dishonesty this pass exists to stamp out; reporting
it as FAIL trains a reader to ignore failures. It is SKIP, it says why, and the
summary counts it separately. Re-run against a deployment with
`OTP_SENDING_ENABLED` set: **29/29, nothing skipped.**

## Onboarding, measured rather than asserted (§11)

The master plan carries an "onboarded in under one hour" target and R-8 forbids
claiming it unmeasured. `audit.platform_access` already timestamps every
console action, so the duration is **derived** — no new column, and nothing for
an operator to remember to set. A crashed halfway onboarding leaves the audit
rows exactly right where a `finished_at` column would be wrong forever.

Surfaced two ways, per D13: on the school's own page in the console
(সেটআপে লেগেছে ১ ঘণ্টা ১ মিনিট · সেটআপের ধাপ ৭টি) and aggregated by
`scripts/pilot-report.mjs`.

### Three ways it could have flattered itself, all closed

1. The report summarised **every** tenant and duly announced "measured
   onboardings: 2, median 61 min" — both of them the author's own walks through
   the wizard, one automated. Nothing counts now unless it is named in
   `PILOT_TENANT_IDS`. Designating a pilot is a deliberate act, and that is
   what makes the number mean anything.
2. A seeded tenant rendered as **"০ মিনিট"** — the prettiest lie available on
   that screen, and precisely the number somebody would later quote as evidence
   for the target. The server computes `synthetic` and the console says
   স্বয়ংক্রিয়ভাবে তৈরি — সময় গণনার যোগ্য নয়.
3. A single-step onboarding reports **null**, not zero. Zero averages
   beautifully and means nothing.

### And one plain bug

A principal who signs in while the operator is still importing students
produces a negative interval — which is normal, and a good sign. The console
printed **"-১৭ মিনিট পরে"**. Found by opening the one school that was onboarded
by hand. It says সেটআপ চলাকালীনই now, and the signedness is documented at the
source rather than clamped away.

## Settings (§8, fourth edge)

Written, re-read through a fresh request, confirmed directly in the database,
and tenant B left untouched by A's write through **body `tenantId`, an
`X-Tenant-ID` header and a `?tenantId=` query** — all three answered 200 for A's
own school and touched nothing of B's.

## Host metrics (§7)

Deliberately not rebuilt inside the product: the host already records every
invocation, and a table of HTTP responses here would duplicate a source of
truth and be wrong in a different way from it. §6 of the runbook now names
where each metric lives, its threshold, who is told, and how to investigate —
with two rules: the destination must be the same one `ALERT_WEBHOOK_URL` points
at, and the scheduled-function failure notification must be on before the first
pilot, because it is the only thing that can report the monitor's own death.

## Verification

- **1160 tests** with a database attached, **890** without. All passing.
- 26 DB suites green, 48/48 migrations applied.
- `check-secrets --history` clean across every commit.
- D11 three-way brand guard and the parameter-property guard passing.
- Browser: the onboarding row on the console health panel, both the real
  61-minute run and the synthetic case.

### One process mistake, recorded

The pilot runbook already existed — 371 lines of manual SQL fallback from R-7 —
and the first version of this pass **overwrote it**, deleting 313 lines to
write a fresh one. That is precisely the erasure the phase instructions forbid,
and it was caught by reading `git diff --stat` before the commit rather than by
any guard. Restored, and the new material (§13–18: pilot selection, the
evidence tables, the HSC conversation, the offline test, blockers) is appended.
The diff is now 140 insertions and no deletions.

## The gates, and none of them moved

| Gate | State |
|---|---|
| Production deployment | **shut** — none exists |
| DNS / TLS | **shut** — no domain control |
| Real SMS | **shut** — no aggregator contract |
| Real push | **shut** — no device has ever been called |
| Backup restore | **rehearsed on local-docker**, production shut |
| Monitoring human alert | **shut** — no sink configured |
| Security final pass | **rehearsed on local-docker**, 29/29 |
| R-7 onboarding in production | **shut** |
| 3–5 pilot institutions | **shut** — zero |
| Real user core workflows | **shut** |
| Offline real-world test | **shut** |

## R-9's pilot gate

**Unsatisfied.** No pilot has occurred. The web push implementation recorded on
2026-08-29 remains an independently implemented R-9 capability that did not
require pilot feedback; the gate on the remaining six R-9 items is untouched by
this pass and stays shut. No R-9 optional feature was implemented.

## Carried backlog — preserved

**R-3:** class/section edit UI · guardian unlink · audit export and entity-name
resolution · `POST /rms/solve` API-only.

**R-5:** object storage · CSV export · multi-card ID layout · **money
formatting** (still open).

**R-6:** board-registration index · attendance date-range filter · type-ahead.

**R-7:** operator SSO and key rotation · trial-expiry automation · per-class
group configuration in the wizard · logo/watermark upload in the wizard ·
platform audit UI · plan feature gating · teacher→subject assignment is still
per-section by hand.

**R-8:** SMS retry backoff · RPO/RTO **decision** (the drill measures RTO; the
numbers are still a policy call) · a curriculum specialist to fill
`verified_against` · per-institution subject configuration for colleges beyond
add and remove · API failure-rate alerting in the host's own metrics · the
host's scheduled-function failure notification · a production restore drill.

*Closed by this pass: the restore drill itself, the live security probe, the
production preflight, and onboarding measurement.*

**R-9:** push retry/backoff · per-notice channel choice · the iOS Home-Screen
explanation · a first-contact test against a real push service.

## Unresolved bugs / issues

**1. `GET /api/v1/sync/pull` is built, mounted, tested — and no client ever
calls it.** Carried unchanged since R-8's first pass.

**2. `docs/09-PRD-AUDIT.md` remains stale** (2026-08-12).

## Next recommended step

Unchanged and now unambiguous: **sign an SMS aggregator contract and stand up
one production deployment.** On the day the deployment exists, the first three
commands are `node scripts/preflight.mjs`, then `scripts/restore-drill.mjs` and
`scripts/security-probe.mjs` against it — all three written during this pass
precisely so that day is a repeat of something rehearsed rather than a first
attempt.

---

# 2026-08-30 · R-8 external readiness pass · Eight gates, one attempted, none closed

**Status: R-8 remains OPEN.** Nothing in this entry moves a gate. It records
what was attempted, what was learned, and — for the one gate that was
genuinely reachable — exactly what stopped it.

The eight priorities in this pass are all *external*. Seven of them need a
credential, a contract, a domain or an institution that does not exist and
cannot be brought into existence from a repository. Writing seven paragraphs
saying "blocked" would be padding, so the pass did the only useful thing
available: it **attempted the one gate that might have been reachable**, and
turned an assumption into a dated finding.

## Real web push (§5) — attempted, blocked, and now evidenced

Previous entries said push was unverified. That was an assumption about the
environment rather than an observation, and it was worth testing rather than
repeating.

**What worked, and it is more than expected:**

- Real VAPID keys generated — P-256, 87-character public key.
- **Network egress to real push services confirmed.** `fcm.googleapis.com`
  answered HTTP 400 and `updates.push.services.mozilla.com` answered 406 —
  real HTTP responses from the real services, not connection failures. The
  path from this machine to Google's and Mozilla's push infrastructure is
  open.
- The app served over a secure context (127.0.0.1 counts), with
  `PushManager`, `ServiceWorker` and `Notification` all present.

**What blocked it, in the automated browser available here:**

1. `Notification.permission` was already `"denied"`, and
   `requestPermission()` returned `"denied"` **without prompting**. No user
   gesture can lift that from JavaScript, and
   `pushManager.subscribe({userVisibleOnly: true})` cannot be reached without
   it.
2. `navigator.serviceWorker.register('/sw.js')` fails with *"An unknown error
   occurred when fetching the script"* — while the page itself fetches that
   exact URL with **HTTP 200, `content-type: text/javascript`, 5551 bytes, and
   it parses as valid JavaScript**. That distinction matters and is why it was
   checked: the failure is the browser profile disabling service workers, and
   **not a defect in the product**.
3. `list_connected_browsers` returned empty — no real Chrome is reachable, so
   no real device could be substituted.

**Conclusion.** Everything on our side of the boundary is in place: keys,
encryption, subscription endpoint, sender, fallback. Only the device is
missing. Closing this gate needs an ordinary Chrome, Edge or Firefox on a real
machine, where a person can click Allow, pointed at a deployment carrying the
VAPID keys. It is a ten-minute task for someone with a browser and impossible
for someone without one.

## Real offline connectivity (§6) — blocked by the same finding

The instruction was explicit: do not use "server stopped" as the final proof.
The better test — a real connectivity loss with the service worker serving the
shell — depends on the service worker registering, which is exactly what fails
above. So no improvement over the existing evidence was possible, and none is
claimed. The procedure remains written out in
[12-PRODUCTION-RUNBOOK.md](12-PRODUCTION-RUNBOOK.md) §8a.

## The other six gates

Deployment, real SMS, a human alert destination, production backup and restore,
pilot institutions and pilot stabilisation. Each needs something this
environment does not contain and cannot create — host credentials, a signed
aggregator contract, an alerting workspace, a production database, and schools.
No work was invented to look busy against them, and per §13 no new architecture
was introduced.

## One schema addition, and its reasoning

`docs/production-evidence.json` gains a third status, `"blocked"`: attempted,
could not be completed, obstacle recorded, **`result` stays null** so it closes
nothing. The preflight reports it as unverified and prints the obstacle.

A bare null says "unknown". After this pass, real push is not unknown — we know
precisely what stopped it, and that is worth more to whoever picks this up than
an empty field. It also stops the same dead end being walked into twice.

## Verification

No product code changed in this pass. The suite stands where the closure pass
left it: **1158 tests** with a database, **862** without, 26 DB suites, 48/48
migrations. `node scripts/preflight.mjs` against a `production` environment
reports **10 pass · 7 fail · 15 unverified**, and refuses.

## The gates, unchanged

| Gate | State |
|---|---|
| Production deployed | **shut** — no host credentials exist |
| DNS / TLS verified | **shut** — no domain control |
| Real SMS delivered | **shut** — no aggregator contract |
| Human monitoring alert received | **shut** — no sink configured |
| Backup restore verified | **shut** in production; rehearsed on local-docker |
| Real push delivered | **shut — attempted 2026-08-30**, blocked by the browser profile; evidence recorded |
| Real offline connectivity tested | **shut** — depends on the same service worker |
| 3–5 real pilot institutions | **shut** — zero |
| Real users completed core flows | **shut** |
| Critical pilot bugs fixed | **n/a** — no pilot |
| Security re-test passed | **shut** in production; 29/29 on local-docker |
| Production evidence recorded | **partial** — 2 rehearsed, 1 blocked, 8 null |

## Known issues, carried and NOT removed  (§12)

1. **DNS/TLS not live.**
2. **Real SMS not tested.**
3. **Real push not tested** — now with a recorded reason rather than a null.
4. **Human monitoring alert not tested.**
5. **Production backup/restore not tested.**
6. **Real offline connectivity test not done.**
7. **Pilot count = 0.**
8. **`GET /api/v1/sync/pull` is built, mounted, tested — and no client ever
   calls it.** Carried since R-8's first pass.
9. `docs/09-PRD-AUDIT.md` remains stale (2026-08-12).

## R-9's pilot gate

**Closed.** No pilot has occurred and none can be arranged from here. No R-9
optional feature was implemented in this pass.

## Next recommended step

Unchanged, and now with the cheapest item first:

1. **Open the app in an ordinary browser on any real machine** with the VAPID
   keys set, click Allow, and publish a notice. That closes the push gate in
   ten minutes and needs nothing bought or signed.
2. **Sign an SMS aggregator contract.**
3. **Stand up one production deployment.** On that day, in order:
   `scripts/preflight.mjs`, `scripts/restore-drill.mjs`,
   `scripts/security-probe.mjs`.

---

# 2026-08-30 · R-8 enters external-dependency mode · No code, one checklist

**Status: R-8 remains OPEN**, and from this entry onward that is a *correct*
state rather than an unfinished one.

The repository-side work is accepted and closed. Everything that remains needs
something from outside the repository: a hosting account, a domain, a signed
aggregator contract, an alerting destination, a production database, a browser
with a person in front of it, and three to five schools. None of those can be
manufactured here, and the explicit rule for this mode is that **no substitute
may be built to make a gate green**.

So this pass wrote no code. It added one thing.

## The external readiness checklist (12-PRODUCTION-RUNBOOK.md §0a)

Eight groups — Production, DNS/TLS, SMS, Push, Backup, Monitoring, Offline,
Pilot — with every box unticked, and against each: what the box actually means,
which key in `docs/production-evidence.json` records it, and what would make it
tickable.

Three properties it was written to have:

1. **A box is ticked from direct observation only.** Not from configuration. A
   configured provider is not a delivered message, and that gap is the entire
   reason the evidence file exists.
2. **Every box names its evidence key**, so ticking one and forgetting to
   record it is visibly incomplete rather than silently lost.
3. **It says which gate is cheapest.** Push needs no contract, no purchase and
   no deployment — one ordinary browser and one click. Everything else waits on
   a signature or a host.

The checklist ends with the rule that governs it: a fake aggregator, a stub
push service and a local restore are all useful for exercising code, and not
one of them is evidence. R-8 may stay OPEN for as long as the prerequisites are
genuinely unavailable.

## Evidence file — unchanged, deliberately

`real_push_delivery` keeps its dated `blocked` entry from earlier today. It is
not upgraded, not softened, and not re-attempted: nothing about this
environment changed, so re-running it would produce the same result and a
second identical record. It moves to `pass` when a real browser on a real
machine completes the sequence in §4, and not before.

Current state of the eleven external items: **2 rehearsed** (restore drill,
security probe — both `local-docker`, neither closing a production gate),
**1 blocked** (real push), **8 null**.

## Known issues — carried, none removed

1. DNS/TLS not live.
2. Real SMS not tested.
3. Real push not tested — dated `blocked` evidence, reason recorded.
4. Human monitoring alert not tested.
5. Production backup/restore not tested.
6. Real offline connectivity test not done.
7. Pilot count = 0.
8. `GET /api/v1/sync/pull` is built, mounted, tested — and no client ever calls
   it. Carried since R-8's first pass.
9. `docs/09-PRD-AUDIT.md` remains stale (2026-08-12).

## R-9

**Not started. Its pilot gate stays closed.** No remaining R-9 optional
capability was implemented, and none will be until pilot stability is
demonstrated.

## What happens next, and it is not code

Nothing in this repository is waiting on this repository. The next commit
should be triggered by an external dependency arriving — an aggregator
credential, a deployment, a device — and should be the concrete integration fix
that dependency requires, verified against the real environment, followed by an
evidence-file update.

In order of cost:

1. **One browser, one click** — closes the push gate. §4 has the sequence.
2. **An SMS aggregator contract.**
3. **One production deployment.** On that day: `scripts/preflight.mjs`, then
   `scripts/restore-drill.mjs`, then `scripts/security-probe.mjs`, against it.

---

# 2026-08-30 · R-8 repository-only cleanup audit · A gate that had been red for six commits

**Status: R-8 remains OPEN.** No external gate moved and none was touched. This
was an audit of what can be fixed without leaving the repository, and it found
more than expected.

## The finding that matters: `tsc` had been failing since R-9

The test suite runs under `node --test`, which **strips** TypeScript rather than
checking it. So `node scripts/test-all.mjs` went green while
`npx tsc --noEmit` — the gate `.github/workflows/security.yml` actually runs —
had been failing since the R-9 web push commit. Six commits, three of them R-8
passes that each ended with a confident quality report.

Traced by checking out HEAD~6, ~8, ~10: **0 errors at R-3, 2 from R-9 onward**,
and 8 more added by my own closure pass. Ten in total across three tsconfigs.

This is the second time in R-8 that a green suite has concealed something —
the first was `product_events.sql` passing for the wrong reason. The lesson is
the same one and it is worth writing down: **a check that cannot fail is not a
check**, and the way to find out which kind you have is to break it on purpose
or, failing that, to run the one nobody has run lately.

### Three of the ten were real defects, not type noise

1. **`login-view.ts` — a stale error message on the activation screen.** The
   handler did `this.error = ''`, and `LoginView` has no `error` field; it
   clears messages by hiding `errorEl`. So a person who mistyped their phone
   number, gave up and clicked "সক্রিয়ন কোড দিয়ে প্রবেশ করুন" carried the
   phone-number error onto the code screen, where it was both wrong and
   alarming. Introduced by R-7's completion pass, which added that button.

2. **`demo.ts` — three sections with no `academicYearId`.** Required since R-7
   fixed the real version of this bug, where a hardcoded non-uuid year meant
   every attendance save was rejected and a teacher saw only "১টি পাঠানো যায়নি".
   The demo carried the same shape of defect, so a `?demo=1` visitor taking
   attendance would have hit the same wall.

3. **`harness.ts` — `CallOptions.method` had no `DELETE`.** R-9's `/ops/push`
   supports it (a person giving up a device) and the harness type was never
   widened, so `push.test.ts` could not compile even though it ran.

The other seven were `push-client.ts` reaching `Notification` through an
injected `Window` (the DOM lib declares it globally but not on the interface),
`sw.ts` setting `renotify: false` (a real platform option the lib does not
declare — now omitted, since `false` IS the default, with a note that setting
it `true` without a `tag` is a spec TypeError that would throw invisibly inside
the service worker), and my own over-tight `Queryable` type in
`onboarding-metrics.ts`, which demanded pg's entire overload set when all it
needs is *send text and values, get rows back*.

**All three tsconfigs are now at zero for the first time since R-9.**

## An unpinned third-party script on the platform's own origin

`apps/pwa/public/index.html` and `design.html` loaded
`https://unpkg.com/lucide@latest` — **unpinned**, so whatever that path serves
executes on shikhonBD's own domain, and its contents can change without any
commit here.

It never touched a school's application, so no student data was ever exposed to
it. What it did expose is the platform's shopfront, which is a credible
phishing surface. Now pinned to `lucide@1.37.0` with a SHA-384 integrity hash
and `crossorigin`/`referrerpolicy`: if unpkg ever serves different bytes the
browser refuses to run them and the icons simply do not draw, which is the
correct failure for a decorative dependency. Verified in a browser — 92 icons
render, no placeholders left.

## The README said "Built and deployed" seven times

It is not deployed. There is no production environment, and every R-8 report
has said so — while the most-read file in the repository claimed the opposite
about seven services.

**And checking that claim turned up something nobody had recorded: a public
deployment exists at `shikhon-lms.vercel.app` and answers 200.** It is a
**stale revision** — `/` serves a build predating R-1-A's three surfaces,
`/app` and `/platform` both 404, and of the API only a couple of functions
exist (`/api/v1/ops/*` is not among them). It is not the current system.

Corrected in the README with a note above the table. **The deployment itself
was not touched**: taking down or redeploying a live public site is an
outward-facing act and needs the owner's decision, not mine. It is recorded
here and in the known-issues list as something to resolve deliberately.

## Money: three formatters, one decision, three answers

Carried as "money formatting (still open)" since R-5. What was actually open:

- `packages/ui-core/src/format.ts` → `formatBdt()` — **Latin** digits,
  `en-US` grouping, used by the printed receipts and report cards.
- `apps/pwa/src/fees-view.ts` → a private `money()` — **Bangla** digits.
- `apps/pwa/src/ledger-view.ts` → a private `taka()` — **Bangla** digits, on
  the double-entry ledger an accounts clerk reconciles against a bank
  statement.

Plus three call sites rendering `৳ ${bnNum(...)}` by hand. So a parent read
**৳ ১,২৫০** on the fees screen and **৳ 1,250.00** on the receipt printed for
the same invoice.

`formatBdt`'s own comment already contained the decision — *"a fee amount in
Bangla digits is a support ticket"* — it simply was not being followed. Now
there is one formatter, and two choices are stated where it lives:

- **Latin digits**, because money must be checkable against a bank slip, an MFS
  statement and a paper ledger, none of which are in Bangla digits.
- **`en-IN` grouping**, changed from `en-US`. Bangladesh reads in lakh and
  crore: ১,২৫,০০০, not 125,000. Below a lakh the two are identical, which is
  why every existing expectation still held and why the new test for the lakh
  case is the only one that could have caught it.

Browser-verified on the fees screen: `৳ 1,250.00`, matching the receipt.

## Classified but NOT implemented

Every remaining backlog item is a **new product feature**, which this pass was
explicitly forbidden to add:

| Item | Class | Why not now |
|---|---|---|
| Class/section edit UI (R-3) | SHOULD FIX BEFORE PILOT | `structure.ts` has GET and POST only. A typo'd section name needs SQL to fix, and the pilot runbook calls that a blocker. But it is backend + API + UI + tests — a feature, needing approval |
| Guardian unlink (R-3) | SHOULD FIX BEFORE PILOT | `guardians.ts` has no DELETE. Same reasoning |
| Audit export / name resolution (R-3) | NICE TO HAVE | Feature |
| Object storage (R-5) | DEFER UNTIL AFTER PILOT | Documents render and print without it |
| CSV export (R-5) | NICE TO HAVE | Feature |
| Multi-card ID layout (R-5) | NICE TO HAVE | Cosmetic |
| Attendance date-range filter (R-6) | NICE TO HAVE | Feature |
| Board-registration index (R-6) | DEFER UNTIL AFTER PILOT | Confirmed a **seq scan** today. At pilot size (3–5 schools) that is genuinely fine, and every index costs write throughput on the student import — the biggest write in the product. The pilot produces the numbers that should decide it |
| `GET /sync/pull` unused | **NOT A BUG — reclassified** | Built, mounted, tested and working; no client calls it. That is an unused capability, not a defect. Deleting it discards working tested code; wiring it up is a feature. It stays, and it stops being listed as a bug |

## Verification

| Gate | Result |
|---|---|
| Tests (with database) | **1160**, all passing (1158 before) |
| Tests (no database) | 862 → 864 |
| DB/RLS suites | 26/26 |
| TypeScript ×3 | **0 / 0 / 0** — was 10 / 6 / 1 |
| Migrations | 48/48 |
| D11 three-way brand guard | pass |
| Parameter-property guard | pass |
| `check-secrets --history` | clean, 136 commits |
| Security probe | **29/29**, 12 areas, positive and negative |
| Browser | pinned CDN renders 92 icons; fees screen shows `৳ 1,250.00` |

## Security re-audit

Re-run against the running deployment after every change above: tenant
isolation by header, id, query and body; a cross-tenant **write** refused; RLS
verified at the database with no runtime role holding SUPERUSER or BYPASSRLS;
role boundaries and guardian/student scoping already covered by
`guardian_links.sql`, `ward.test.ts`, `student-search.test.ts` and
`documents.sql` (three independent assertions that a guardian cannot open
another family's child); 7 SSRF vectors refused; no secret in any bundle; CORS;
per-phone OTP limiting. **No new vulnerabilities.** The one genuine security
improvement this pass is the pinned CDN script.

## Known issues — carried, plus one new

1. DNS/TLS not live.
2. Real SMS not tested.
3. Real push not tested — dated `blocked` evidence.
4. Human monitoring alert not tested.
5. Production backup/restore not tested.
6. Real offline connectivity test not done.
7. Pilot count = 0.
8. **NEW — a stale public deployment at `shikhon-lms.vercel.app`** serving a
   pre-R-1-A revision. Not touched; needs an owner decision to redeploy or
   remove.
9. `docs/09-PRD-AUDIT.md` remains stale (2026-08-12).

*Removed from this list:* `GET /sync/pull`, which was never a bug — see the
classification table above.

## R-9

**Not started. Pilot gate closed.** No R-9 optional capability implemented.

## Next external dependency required

Unchanged and unaffected by this pass: **one ordinary browser on a real machine
to close the push gate**, then an SMS aggregator contract, then a production
deployment.

---

# 2026-08-30 · Final audit preparation · The specification, not the audit

**Status: R-8 remains OPEN**, external-dependency mode unchanged. No code was
touched, no configuration changed, no evidence generated.

One deliverable: [FINAL-FULL-PROJECT-AUDIT-PLAN.md](FINAL-FULL-PROJECT-AUDIT-PLAN.md),
the permanent specification for the independent final audit that happens only
after R-8 closes, production is real, and the pilot is complete and stable.

## What it is for

An auditor who has never seen this project, with no access to any prior
conversation, should be able to read that one file and audit shikhonBD end to
end. That constraint drove every choice in it: no phrase like "as discussed",
no reliance on memory, and real names throughout — actual table names, actual
role codes read from the database, actual script paths, actual endpoint
families.

## What is in it

The fifteen sections asked for: audit philosophy · full system scope (30 areas)
· a 35-row security attack matrix · a role matrix across six roles · a tenant
isolation matrix over fourteen resources in both directions · a D13 UI/UX pass
· offline · data integrity · performance · production readiness · documentation
contradiction hunting · severity definitions · the four-pass process · the
evidence rule · the release decision with a checklist and sign-off.

Plus two appendices that are the part I would most want if I were the auditor.

## Appendix A — the traps

Twelve things that have already produced a wrong answer in this project,
written down so the next person does not rediscover them at their own cost:
`SET LOCAL` discarded outside a transaction; a bare pool query seeing nothing
under RLS; **superusers bypassing RLS**, which produced a false cross-tenant
leak in an early harness; `node --test` stripping types rather than checking
them; `jsonb_set` as a silent no-op; `ON CONFLICT` and NULL distinctness; a
trigger aborting the transaction its catch block then queries; `/sync/push`
returning 200 with the rejection inside the body; Node's `fetch` sending
`Sec-Fetch-Mode`; the rate limiter outliving the process; Bangla forcing UCS-2
at 70 characters a segment; and two real schools sharing a display name.

Each of those cost real time here. An auditor who reads them first starts a day
ahead.

## Appendix B — the known-open list

So a pre-existing gap is not reported as a regression: every shut external
gate, the stale public deployment at `shikhon-lms.vercel.app`, the unused
`GET /sync/pull`, the unindexed board-registration column, the stale PRD audit,
and the seven backlog features deliberately not built. With an instruction to
**verify each is still true rather than assume it**.

## Three things the document insists on

1. **Do not trust the tests.** There are ~1160 and they pass, and this project
   has produced a test that passed for the wrong reason twice — once a suite
   reaching its cross-tenant assertion with a tenant still set, once a type
   gate red for six commits behind a green suite. The plan requires the auditor
   to **break ten important tests on purpose and confirm each one fails**.

2. **Do not trust the documentation** — including everything I have written.
   `README.md` claimed "Built and deployed" about seven services while nothing
   was deployed. Where code and documentation disagree, the code is the truth
   and the document is a bug.

3. **A refusal is only proved alongside a success.** Every isolation test needs
   the legitimate caller to succeed on the same route, because a broken
   endpoint and a secure one look identical from outside.

## What was deliberately NOT done

The audit itself. No application behaviour changed, no production configuration
touched, no gate turned green, and no evidence written to
`docs/production-evidence.json` — which still stands at 2 rehearsed, 1 blocked,
8 null. R-9 not started; its pilot gate stays closed.

## Next external dependency

Unchanged: one ordinary browser on a real machine to close the push gate, then
an SMS aggregator contract, then a production deployment.

---

# 2026-08-31 · R-8 external milestone · The product is deployed and public

**A real host and a real domain arrived, so the production-deployment gate —
open since R-8 began — is now closed.** ShikhonBD is live at
**https://sikhon.systems**. This entry records what was done, because it is the
first time any of this system has run somewhere a school could reach it.

## The provenance decision, made on evidence

The owner named `github.com/jmmohiuddin/LMS-SYSTEM` as the "main" repo. Before
deploying a system that will hold children's data, I compared it against the
verified local tree and surfaced what I found rather than deploying blind:
jmmohiuddin is an **Aug-23 snapshot** — 38 migrations, no onboarding console,
none of the R-8 hardening (**221 files / +72k lines behind**). The current,
audited product was never on either GitHub repo; it lives in the local working
tree at `0b6df00`. The owner chose to deploy that. So the deploy ships the
exact verified commit via `git archive`, not a GitHub clone.

## Coexistence, not takeover

The VPS (`voltix-prod`, Hostinger KVM2, Ubuntu 24.04) is **not a blank box** —
it already runs Voltix, Nexus, Meridian SATS, Meraki PMS and the owner's Nimikh
FOS API, with **Caddy owning 80/443**. So ShikhonBD was added **additively**:

- A **dedicated `pgvector/pgvector:pg16` container** (`shikhon-postgres`, port
  127.0.0.1:5433) — the same isolation pattern the sibling apps already use, so
  a new PG superuser was never created on the shared cluster that holds the
  other apps' data. pgvector 0.8.6, migrations run exactly as in CI.
- A **systemd service** (`shikhon-web`, unprivileged user, `ProtectSystem=full`)
  running `deploy/server.mjs` on `172.16.1.1:4100` — the same host-service
  pattern Caddy already uses for `accounting.phoyev.com`.
- **One added Caddy block** for `sikhon.systems`, appended after backing up the
  shared Caddyfile and validating before a graceful reload. The five sibling
  sites stayed up throughout (`accounting.phoyev.com` verified 200 after).

## The one piece of new code

`deploy/server.mjs` — a production HTTP server that reproduces what Vercel did:
serve the three static surfaces and route `/api/v1/<svc>` to the same
dispatcher the edge would have called. It is a hardened promotion of the
`.claude/static-server.mjs` that sat behind every R-7/R-8 browser acceptance,
so the routing is unchanged. Node 22.23's type-stripping runs the TypeScript
dispatchers directly (verified on the box). Committed as `52d1609`.

## Verified, on production

| Check | Result |
|---|---|
| HTTPS | Valid Let's Encrypt cert, CN=sikhon.systems, through 2026-11-29 |
| Marketing / app / console | `/`, `/app`, `/platform` all 200 in a real browser, **zero console errors**, `shikhonBD` brand intact on the console (D11) |
| API auth | unauth 401, public 200, service-key 200 |
| DB posture | 48 migrations, 227 RLS policies, `shikhon_app`/`platform` non-super non-bypassrls, **0 tenants visible with no context** |
| **Restore drill (production)** | `restore-drill.mjs` on the production DB: every schema + table count identical, **RTO 1.5s**. Real production evidence, not a rehearsal |
| **Backups** | daily `pg_dump -Fc`, 14-day retention, first backup (913K) confirmed |
| Maintenance cron | ran once: partitions pre-created, dashboards refreshed |
| **Monitoring** | `/ops/monitor` every 15 min, evaluated against production, **all-clear** |
| Reboot survival | service enabled, container `unless-stopped`, cron in `/etc/cron.d` |
| Siblings | unaffected — no collateral damage to the shared box |

## Gates closed, and still open

**Closed with production evidence:** production deployment · apex DNS + TLS ·
backup configured · restore drill (production) · monitoring running.

**Still open — genuinely, not for lack of trying:**
- **Real SMS** — no aggregator contract. `OTP_SENDING_ENABLED` is off; login
  uses activation codes, so no SMS is needed to run a pilot.
- **Real push to a device** — the last blocker (no real HTTPS origin) is now
  gone: production has a valid cert and real VAPID keys. It is a ~10-minute
  test from any ordinary browser once a pilot tenant exists. Still `blocked`
  until observed on a device.
- **Alert to a human** — `ALERT_WEBHOOK_URL` unset; the monitor logs but pages
  nobody. One env var away.
- **Cross-tenant probe on production** — the probe needs ≥2 tenants and the DB
  has none yet. The DB-level RLS posture WAS verified on production directly.
- **Pilot** — 0 institutions. The wildcard-subdomain feature stays off;
  `/app?tid=` is the tenant door.

## R-8 status

**Still IN PROGRESS**, but materially advanced: the largest gate (a real
production deployment) is closed, and backup/restore now have production
evidence. What remains is an aggregator contract, an alert webhook, and a real
pilot — none of which is code.

## What the deploy did NOT do

No pilot school was onboarded (the ask was to host the site). The stale
`shikhon-lms.vercel.app` was left untouched. Nothing was pushed to GitHub — the
local tree remains the source of truth, and pushing it (to make a repo current)
is a separate decision the owner has not yet made.

---

# 2026-09-01 · UI/UX audit · Three generations of interface, and a decision that was never implemented

**Audit only. No redesign, no code changed, no file deleted.** This entry
records what the repository actually contains, because the owner reported that
`/app` looks materially different from the polished design they expected — and
the evidence says they are right, for a reason that is documented here for the
first time.

## The finding

There are **three** generations of interface in this repository, not two:

| Gen | Where | Palette | Scope |
|---|---|---|---|
| 1 | `app.css` `--c-*` family | original app colours | **373 selectors** — nearly all of `/app` |
| 2 | `app.css` `--color-*` family | `#e53935`, `#f9fafb`, `#8b5cf6` (Material/Tailwind-ish) | **~30 selectors** — login, home/hero, buttons, `.card`, branding, notices |
| 3 | `design/tokens/*.css` — the real Ata Ekta system | `#D23B2E`, `#F1EFE6` Muslin, `#A76A47` Terracotta | **`/design` only** (and the UI kit) |

Generations 2 and 3 **share variable names and disagree on every value**.
`--color-primary` is `#e53935` in `/app` and `#D23B2E` in `/design`. Not one of
the six Ata Ekta colours appears anywhere in `app.css`.

The token file states its own reason: the red was deepened because `#e53935`
"sits at 3.9:1" and fails WCAG AA on white. **The Ata Ekta palette was written
as a correction to the palette `/app` still uses.**

## How it happened

Commit `c93bddc` (2026-08-23) is titled *"Add the ShikhonBD marketing landing
page and rebuild the app on the Ata Ekta design system"*. It did the first half.
It did **not** rebuild the app:

- it added `design/` (tokens + `.jsx` components) as a reference kit;
- it rewrote `index.html` into the marketing site (+4 274 lines);
- it added a *parallel* `--color-*` block to `app.css` whose values are **not**
  the Ata Ekta tokens;
- of **59** view modules under `apps/pwa/src/`, it changed exactly **one**
  (`login-view.ts`, 23 lines).

R-1-A later renamed that design surface to `design.html` (`/design`) and the
real shell to `app.html` (`/app`). The R-1-A discovery entry above already
recorded the file movement; what it did not record — and what this audit adds —
is that **the design system itself was never applied to the application.**

## Decision D7 has never been implemented

The Master Plan says, and has said since it was written:

> **D7 — New agent surfaces follow the Ata Ekta design system** (tokens in
> `apps/pwa/public/design/tokens/`).

`app.css` does not import those tokens and does not contain their values. Every
phase from R-1 to R-8 added UI to `app.css` in the older idiom. D7 is a
standing decision that the codebase has silently not followed — this is the
mismatch between product intent and implementation the audit was asked to find.

## What `/design` actually is

- **66 screens**, of which **32 are mobile/desktop PAIRS** (`s-attendance` +
  `s-attendance-desktop`, and so on) — the intentionally different desktop and
  mobile layouts the owner remembered.
- A **desktop shell** (`.dnav` sidebar, 9 `dpage-*` pages: dashboard, academic,
  attendance, students, teachers, results, finance, reports, settings).
- A **mobile shell** (`.phone` frame, `.bottomnav`).
- A hard **899/900px** split — genuinely separate layouts, not one fluid grid.

And it is **a mockup**: 1 `fetch` in the whole file (tenant branding), 0
imports, hardcoded arrays. The repository's own `surfaces.test.ts` asserts it —
*"/design is the prototype: many static screens, no API, no app boot"*. The
answer to "was the design ever connected to real functionality" is **no**.

## What `/app` actually is

Mobile-first and it stays that way. Its only `min-width: 900px` rule styles the
**branding editor's** two-column grid — nothing else. There is no sidebar, no
desktop navigation, no responsive table strategy; the `shell-tabbar` bottom nav
is what a desktop user gets too. That is why `/app` reads as a stretched phone
layout on a laptop.

Against that, `/app` holds everything `/design` does not: real API wiring across
26+ views, loading/empty/error states, the offline outbox, and a **122-line
dark palette** (F-1607) that `/design` has **no equivalent for at all**.

## Nothing was lost

`git log --diff-filter=D` over `design/` returns nothing. The hero assets are
referenced by `index.html`. Both HTML files were **moved and renamed**, never
deleted. Whatever else this is, it is not asset loss.

## Recommendation recorded

**Option B — `/design` is the intended visual system and should be integrated
into `/app`** — on the evidence of D7, of the tokens being an explicit WCAG
correction to `/app`'s palette, and of `/design` holding the desktop layouts
`/app` has never had.

With three constraints that the integration must respect, or it will regress
the product:

1. `/design` has **no dark mode**. `/app`'s 122-line dark palette must survive.
2. `/design` has **no loading, empty or error states**. D13 forbids trading
   those for visual polish.
3. `/design` covers roughly **33 of ~37** app routes. Notices/inbox, calendar,
   documents, user management, publish, invoices, rollover, audit, student
   history and the whole `/platform` console have **no design counterpart** and
   need new design work in the Ata Ekta idiom rather than a port.

The `.jsx` components under `design/components/` are **not** directly reusable:
React is not a dependency of this project and the app is deliberately
framework-free (D1). What is reusable is the token CSS and the plain HTML/CSS
patterns inside `design.html`.

**No redesign has been performed.** This entry exists so the decision is made
against evidence rather than memory.

---

# 2026-09-01 · UI integration plan · Ata Ekta becomes the app's visual direction

**Planning only. No application code changed, no screen redesigned, `/design`
untouched, routing/API/schema unchanged.**

Following the UI/UX audit entry above, the owner accepted **Option B**:
integrate the Ata Ekta design system from `/design` into the functional `/app`.
This entry records the decision and the roadmap; the plan itself lives in
[UI-UX-INTEGRATION-PLAN.md](UI-UX-INTEGRATION-PLAN.md) and is written to be
implementation-ready without chat history.

## The decision

**D14 (new, recorded in the Master Plan):** Ata Ekta is the canonical visual
direction for the functional `/app`. `/design` remains a visual reference and
prototype — it is not the production application and will not be promoted into
one.

## The finding that changed the estimate

Comparing `app.css` against `design/tokens/*.css` in detail produced a genuinely
good surprise: **radius, shadows, spacing and `--tap-min` already match the Ata
Ekta values exactly** — 8/12/16/999px, `0 1px 2px rgba(15,23,42,.04)` and the
rest, 4/8/12/16/24/32, 48px. Both surfaces already use Hind Siliguri and Inter.

So the two systems share their geometry and rhythm already. What actually
diverges is **colour** (every value) and the **type scale** (`/app` uses a px
ladder, `/design` a semantic h1…caption scale with weight and line-height
bundled). That reframes the work from "rewrite the design system" to "swap the
palette, reconcile the type scale, and build the desktop half that was never
built".

`/design` also carries one idea `/app` lacks and should adopt: `--font-bn-num`,
Noto Sans Bengali for **numerals only**, because Hind Siliguri's Bangla digits
are ambiguous with Latin `I`/`l` at table-row sizes — the wrong ambiguity for a
ledger balance or a mark.

## What the plan contains

Twenty sections: a token audit and migration (T1–T6, one token system at the
end, no permanent two-family tax); a three-generation cleanup classifying every
component group as KEEP / ADAPT / REPLACE / REMOVE AFTER MIGRATION with nothing
deleted yet; the final dual-mode shell (desktop `.d-shell` sidebar, mobile
bottom nav) with per-role navigation taken **verbatim from the existing
`dashboardFor(role)`** — no invented permissions; a 33-row screen-by-screen
matrix; a 26-component library specified for desktop, mobile, accessibility and
variants, marking what already exists so nothing is duplicated; and phases P0–P8
with tags and revert points.

## Three judgements worth recording

**Dark mode: keep it, as an explicit user preference.** `/app` ships a 122-line
dark palette (F-1607) applied before first paint; `/design` has none. Removing
shipped, tested behaviour to match a prototype that never addressed the question
would be a regression, and dark mode is an accessibility feature for low-light
use — a teacher marking attendance at 6am in a dim staffroom is a real case. So
a **dark Ata Ekta palette must be authored** as part of the token phase rather
than deferred, or the first phase would break dark mode.

**Breakpoints: 640 / 1024 / 1440, not the existing 900.** A real sidebar needs
~240px plus ≥720px of content, so 1024 is the honest switch point. Tablets
(640–1023) keep the bottom nav — a 768px tablet is held in hand. The existing
480/700/900 rules are absorbed, not stacked on top.

**Migration order: shell-first, then role-by-role.** Screen-by-screen would
leave two shells alive at once; role-by-role cannot start without a shell.
Shell-first front-loads the dependency, then each subsequent phase ends with a
complete, testable persona.

## Constraints carried into every phase

The plan states them as gates, not aspirations: `/design`'s hardcoded data may
never reach production (visual language only); the offline outbox path for
attendance and marks is restyled but never restructured, with offline
acceptance a gate on its phase; D11's three-way brand guard stays green;
D13's states are required per screen, and a screen that lands without them is
reported *"restyled — states pending"*, never complete; and the critical path
must not exceed today's 180 KB gzipped budget, with no framework introduced.

## Twelve screen families need new design

`/design` covers roughly 33 of ~37 routes. Student history, notices,
notifications, calendar, documents, user management, onboarding, the platform
console, publish, invoice, rollover and audit have **no** prototype counterpart.
They are scheduled after the component system exists (P6), so they are designed
*in* the Ata Ekta language rather than ported from screens that have no states
and no data.

## Status

**Nothing implemented. Awaiting approval to begin P0 (tokens + dark palette).**
The UI is not claimed complete; `/app` remains functionally strong and visually
a generation behind, which is exactly what the audit found.

---

# 2026-09-01 · Product surface architecture · Five surfaces, written down at last

**Specification only. No application code, routing, database, API, `design.html`,
`app.css` or deployment changed. P0 has not begun.**

The UI integration plan settled *how* the visual migration happens. This entry
settles *what surfaces exist and who reaches each one* — recorded as **D15** in
the Master Plan, specified in
[FINAL-PRODUCT-SURFACE-ARCHITECTURE.md](FINAL-PRODUCT-SURFACE-ARCHITECTURE.md).

## The five surfaces

| Address | Surface | Brand | Audience |
|---|---|---|---|
| `sikhon.systems/` | public marketing | **shikhonBD** | anyone |
| `/demo` (**new**) | isolated demo | tenant-style + marker | prospects |
| `<slug>.sikhon.systems` · `/app?tid=` | tenant application | **school** | a school's people |
| `platform.sikhon.systems` · `/platform` | Platform Console | **shikhonBD** | Super Admin only |
| `/design` | visual reference | tenant-style | developers only |

## Three findings from reading the code

**The subdomain plan is already built.** `tenantKeyFromHost()` in `branding.ts`
resolves by label count, not against a hardcoded domain, so
`monipur.sikhon.systems → monipur` needs **no code change** — and it already
reserves `www`, `app`, `platform`, `api`, `staging`, `localhost`. That last
point matters more than it looks: **`platform.sikhon.systems` can never be
mistaken for a tenant**, so moving the console to its own door is DNS and a
Caddy block, nothing more. The architecture asked for was already defended.

**The demo is isolated but homeless — and the fallback is a defect.** `demo.ts`
is entirely client-side ("no request ever leaves the device"), with all seven
roles as sample data. But there is no `/demo` route: the marketing CTA points at
`/app`, and `/app` enters demo mode implicitly whenever nobody is logged in:

```
demoMode = params.get('demo') === '1' || (!cachedOtpLogin() && !realAuth.isLoggedIn())
```

That second clause means **a real teacher who is simply logged out sees
fabricated students under their own school's door** — confusing on a personal
phone, misleading on a shared staffroom device. The specification gives the demo
its own route and its own banner, and makes a logged-out `/app` show the login
screen. Small change, real correctness fix.

**The domain drifted.** `shikhonbd.com` is still written into source comments,
two operator-facing Bangla strings, the marketing footer's contact address and
the default VAPID subject, while production serves `sikhon.systems`. **No logic
depends on it** — the resolver is domain-agnostic — so this is prose, not a
fault. Scheduled as housekeeping inside P7 rather than an urgent fix, and listed
so no future reader is misled by a stale string. `shikhonbd` remains the brand;
`sikhon.systems` is the address; D11 governs the brand, not the domain.

## What the specification fixes by construction

Naming the surfaces resolves two things that were true but unwritten: the
operator console shared an origin with the marketing site — the one surface that
should be hardest to find — and the demo had no identity of its own. Both are
now addressed by where things live, not by a rule somebody has to remember.

The console is **never** a public navigation destination: no link, no footer
entry, no sitemap presence. Publishing it would advertise the existence of a
customer list.

## What did not change

The tenant application remains **one** application with role-scoped navigation
(not five sites), driven by the **existing** `dashboardFor(role)` plus
`requireRole`/`requireStaff` and RLS — no permission is invented here. `?tid=`
keeps priority over the subdomain forever, because it is printed on admission
slips and baked into installed PWAs. No school-picker at any stage (D12).
`WILDCARD_DNS_READY` stays off until a browser has actually loaded a tenant
subdomain over HTTPS.

## Additions to the migration plan

Two items fold into P1 and P7 without changing the P0–P8 order: `/demo` as a
real route with the implicit-demo fallback removed (P1), and
`platform.sikhon.systems` as the preferred console door plus the domain-string
housekeeping (P7).

## Status

**Nothing implemented.** This document is the target; the integration plan is
the route. Awaiting approval to begin P0.

---

# 2026-09-01 · UI P0 · The palette moved, and the app did not notice

**Delivered. P1 has not begun.** One file changed: `apps/pwa/public/app.css`.
No TypeScript, no API, no schema, no routing, no `design.html`, no marketing
page. Rollback is a single `git checkout`.

## The discovery that set the scope

The plan budgeted P0 as "re-point the 373 `--c-*` selectors family by family".
Reading the file first showed that was unnecessary: `--c-*` is a **semantic
alias layer** of 29 tokens, and its own comment had promised exactly this —
*"the palette can be re-pointed at a different design system by editing this
block alone rather than 800 lines of rules."*

The promise held. The palette moved by editing the primitives and the aliases.
**424 usages and every one of the 59 view modules were untouched.** A phase
estimated in screens became a phase in one file, which is also why its rollback
is trivial.

## Colour, decided by measurement

Every value was run through a WCAG calculator against both grounds before
adoption, because the canonical palette is **not** automatically accessible:

- The brand red is the correction the design system exists for — `#e53935` was
  **4.23:1 on white and failed AA**; `#D23B2E` is 4.77:1.
- But five canonical hues fail **as text on the Muslin ground**: warning at
  **2.95:1**, accent-2 3.80, info 4.02, success 4.15, primary 4.14. Each got a
  `-text` step one shade darker — hue kept, step moved, which is the discipline
  the previous palette already used for the same reason.
- `--color-text-faint` (#97867B) is 3.03:1 on Muslin. It is kept because it is
  canonical, but **no text token aliases it** and a test now enforces that —
  it is precisely the defect `--c-ink-3` was created to fix, which had already
  shipped once across five screens.

## Typography — the canonical sizes were rejected, deliberately

Ata Ekta's body is 14px. This ladder's is 16px with a 13px chip floor, because
Bangla conjuncts lose legibility before Latin does at the same optical size
(Override 3, F-812). Adopting the canonical **sizes** would have shrunk every
screen and regressed the one thing this product cannot regress.

So the canonical **names** were adopted — h1/h2/h3/body/body-small/label/
caption — mapped onto the Bangla-tuned ladder, carrying weight and line-height
across but not size. Same vocabulary, same readability.

## Dark mode — kept and re-cut, not deferred

The plan's §8 decision was to keep dark mode as a user preference; P0 authored
the palette rather than leaving it for later, because a token phase that broke
dark mode would have been a regression shipped on purpose. The grounds are warm
Clove (`#1B1714` page, `#241E1A` card) — not the cool near-black they replace,
not the legacy green. Brand fills keep the light step so a primary button is
identical at midnight and noon; brand and status text move UP the ramp, the
mirror of how they move down in light. Every dark text step measures ≥4.8:1.

## Two defects, and how each was found

**`.system-row` had no background.** It is a `<button>`, so it inherited the
*user-agent button face* — harmless-looking in light, `#6B6B6B` under
`color-scheme: dark`, where the description text on it measures **2.59:1**. It
pre-dates P0 in both palettes and was invisible to every screenshot ever taken
of that screen. The rendered contrast sweep found it; looking would not have.

**The new test was wrong three times before it was right.** Its first run
reported tokens that exist only inside comments (this file's comments name
tokens deliberately, as records of fixed bugs). Its second missed tokens
declared several-per-line in the ramps. Its third flagged
`var(--c-danger, var(--c-primary))` — a deliberate fallback — as an undefined
token. Each was a false positive that would have taught a future reader to
ignore the test. A check that cries wolf is worse than no check, so each was
fixed before the test was trusted.

## Verification

| Gate | Result |
|---|---|
| Rendered contrast sweep | **956 element-checks**, 12 routes × 2 themes → **0 failures** |
| Horizontal overflow | none at 1440 / 1024 / 390 / 375, both themes |
| Touch targets | 0 interactive elements under 44px |
| Tenant branding | A `#156a3f` and B `#1b3e7a` both render; grounds and status stay canonical |
| Tests | **1172** with a database (1160 before) |
| TypeScript ×3 | 0 / 0 / 0 |
| DB suites | 26/26 |
| D11 brand guard | pass, both directions |
| Security probe | **29/29** across 12 areas — tenant isolation unaffected |
| Secrets | clean across history |
| Size | `app.css` +2.6 KB gzipped (32.3 → 34.9). `app.js` unchanged — no TS touched |

## Legacy tokens: 29 definitions, 424 usages, unchanged

Deliberately. They all resolve to Ata Ekta primitives now. They are retired in
**P8**, when usage reaches zero, exactly as the plan says. Nothing deleted.

## What P0 did not do

No shell. `/app` remains mobile-first at every width, and its only desktop
breakpoint still styles the branding editor — so on a laptop it is still a
stretched phone layout with the correct colours. That is **P1**, and keeping it
out of P0 is what made this a one-file rollback.

**P1 has not begun.**


---

# P1 — Application shell: desktop and mobile   (2026-09-01)

**Commits:** `0466861` (A/B/C/D), `2c4d68d` (E/F), `HEAD` (G + docs).
**Scope:** the shell. Not the screens inside it — those are P2–P6.

## What the app was

A mobile shell a desktop browser could open. **One** `@media (min-width: …)`
rule existed in 2,542 lines of `app.css`, and it styled the branding editor;
every list, table and form was the phone layout stretched to the window. The
bottom bar was built from **route order**, which knows nothing about who is
holding the device, so a fourteen-year-old's phone offered "হাজিরা নিন" and a
section roster.

## What it is now

One DOM, two layouts, chosen by CSS. `display:none` removes a subtree from the
accessibility tree as well as the page, so a screen reader only ever meets the
navigation that is on screen. The alternative — re-rendering on resize — drops
focus, remounts the current route, and would lose a half-entered attendance
register when a phone is rotated.

| | ≥1024px | <1024px |
|---|---|---|
| Navigation | persistent grouped sidebar, 240px | bottom bar, 5 role-chosen tabs |
| 1024–1279 | 68px icon rail (forced) | — |
| Chrome | breadcrumb · search · bell · profile menu | identity · bell · profile |
| Content | centred column, max 1200px | full width |

`ui/nav.ts` **invents no permissions**. Every path it lists is already
registered and already reachable by every role through the unfiltered More
menu, which still closes every sidebar. Narrowing a sidebar changes what a
person is *offered*, never what they may do — the server decides that, and a
403 is the answer for anyone who should not.

## Defects found by rendering it

Five, none of which reading the code would have surfaced.

1. **The offline banner had been on screen for 58 commits.** `.offline-banner`
   sets `display:flex`, which beats the UA sheet's `[hidden]{display:none}` at
   equal specificity. `banner.hidden = navigator.onLine` was correct the whole
   time and did nothing: every user, every screen, online, has been reading
   "অফলাইন — কাজ চালিয়ে যান" since 2026-08-11. Fixed globally with
   `[hidden]{display:none !important}`, which also stops the next component
   that sets `display` on something it hides.
2. **The school's name rendered twice on desktop.** `.shell-org{display:flex}`
   was declared 1,700 lines below the rule hiding the mobile plate and won on
   source order. Both halves of the fix landed: the identity rules moved up
   beside the shell, and the responsive block now goes **last in the file**.
   That placement is load-bearing and is written into the stylesheet as a rule
   for every later phase.
3. **The icon rail never engaged.** It listened to `(max-width: 1279px)`;
   resizing 768 → 1024 does not change that query, so the band the rail exists
   for showed a 240px sidebar taking a quarter of a 1024px screen.
4. **My own demo chip was 1.85:1 in dark.** `--color-warning-ink` is the dark
   step in light mode and the *lifted* step in dark — its job is to be readable
   against its own ground, never to be a fill. Fill and label now come from the
   same pair and invert together: 6.0:1 light, 7.9:1 dark.
5. **`CARD.students` has asked for a `search` icon since R-6.** There isn't
   one, and `iconSvg`'s fallback is a silent neutral dot. A rail of icons with
   one meaningless dot in it is what made it visible.

## The one that was never P1's

A school may choose a pale brand — a yellow crest, a light teal. `app.css` put
white on the brand fill in **seventeen** places: the primary button, the
notification badge, the avatar, the calendar's selected day, the audience
chips. On `#E5B300` that is **1.95:1**. Worse, `--c-primary-text` on
`--c-primary-soft` measured **3.38:1**, and that pair paints the **active
sidebar row** — a school with a yellow crest could not read which page it was
on.

The branding editor has warned about this since R-1 ("advice, not a refusal" —
a school may have a light brand and we do not get to veto it). Nothing acted on
the warning, so choosing a pale colour quietly degraded every screen at once.

`brandingCssVars` now derives `--c-on-primary` and steps the text colour until
it clears AA, **in the school's own hue** rather than a neutral — black on a
yellow button reads as a different palette leaking in. The fill stays exactly
the colour the school chose; only the label moves. Verified across yellow,
teal, near-white, white, black and grey, in both themes, and **byte-identical**
for every brand that never needed help.

## And one the stability gate stumbled into

`generateVapidKeys` returned a **31-byte private key 0.41% of the time** (83 in
20,000 measured). Node's `getPrivateKey()` trims leading zero bytes; the PKCS#8
envelope is fixed-width DER declaring 32, so those pairs throw on every send.

Not a test flake. The pair is minted **once per deployment and kept**: a school
unlucky at setup would have had push silently dead for its whole life — with
R-8's "push verified on a real device" gate still open to explain it away.
Left-padding restores what SEC 1 §2.3.7 already says a P-256 scalar is.

## Verification

| Gate | Result |
|---|---|
| Rendered sweep | **3,000+ element-checks** — 8 widths × 2 themes × 5 roles × 12 routes |
| Contrast | **0 failures** at 375 / 390 / 640 / 768 / 1024 / 1280 / 1440 / 1600, both themes |
| Horizontal overflow | **none** at any width |
| Touch targets | 0 under 44px; `pointer: coarse` restores 48px on the sidebar |
| Accessible names | 0 nameless controls, menu open and closed |
| Keyboard | skip link is the first stop; focus order skip → rail → sidebar → content |
| Offline | banner hidden online, **shown offline** — working for the first time |
| Tenant A / B | `#156a3f`, `#1b3e7a` — 246 checks each, 0 failures |
| Hostile brands | yellow · teal · near-white · white · black · grey all clear AA |
| Tests | **1,224** with a database (1,172 before) — 52 new |
| TypeScript ×3 | 0 / 0 / 0 |
| Migrations | 48/48 applied, schema untouched |
| D11 brand guard | pass, both directions |
| Secrets | clean across 150 commits |
| `app.css` | 34.0 → **39.3 KB gzipped** (+5.3) |
| `app.js` | 132.7 → **132.9 KB gzipped** (+0.2) |

**Security probe: not run.** It needs a seeded two-tenant deployment and this
machine's CI database has none. P1 changed no RLS, auth, API or tenant
resolution, so there is nothing in it for the probe to see — but that is an
argument, not evidence, and it is recorded as unrun rather than as a pass.

## What P1 did not do

The screens inside the shell. Dashboards are still card grids (reflowed to four
columns on desktop, not redesigned); tables are still tables at every width;
`.page-header` is still whatever each of 26 views renders. Those are **P2–P6**,
and keeping them out is what makes P1 reviewable.

**P2 has not begun.**


---

# D16 — the Platform Console owns the commercial relationship   (2026-09-01)

Recorded before P2 begins, because the owner raised it as a requirement and a
requirement that is not written down gets invented ad hoc inside whichever
phase first trips over it.

## What was already true

`tenants` has carried the commercial columns since **migration 001**:
`plan_code`, `student_cap`, `trial_ends_on`, `status`
(`trial | active | suspended | archived`), and a `features jsonb` that nothing
has ever read. Migration **045** gave the platform `app.create_tenant()`,
`app.set_tenant_status()`, `app.platform_tenants()`, `app.log_platform_action()`
and `app.enforce_student_cap()`, all `SECURITY DEFINER`, granted to
`shikhon_platform` and to nobody else — `shikhon_app` cannot execute one of
them, so a fully compromised school application still cannot suspend a school.

So an operator can already suspend a tenant. What they cannot do is say **why**,
record that a school **paid**, or tell a school two days late from one three
months gone.

## What R-7 said, and what it got wrong

> "Billing the schools is **out of scope** for R-7 — invoicing is manual, and a
> payments integration for our own subscriptions is a separate decision."

Right about the gateway. Wrong about the model. Those are different things: a
gateway is an integration; the commercial state is a *fact about a school* that
the product already half-stores. Without a payment record the lifecycle has no
input, so suspension becomes a judgement someone makes in a spreadsheet and
applies by hand — which is precisely the state in which a paying school gets
locked out and an unpaying one does not.

The R-7 sentence is **kept verbatim** in the Master Plan (D10) with a
supersession note beside it.

## What D16 requires

| Area | Requirement |
|---|---|
| Institution | profile · tenant id · type · slug · status |
| Subscription | plan · billing cycle · price · student cap · enabled modules · start date · next due date · trial · grace period |
| Payment | amount · date · method · reference · note · history · outstanding balance |
| Lifecycle | `active → payment_due → grace_period → limited → suspended`, **derived from the payment record**, never typed in |
| Reactivation | payment recorded → re-evaluate → reactivate, one platform action |
| Audit | every commercial act writes `audit.platform_access` **in the same transaction as the act** (the 045 rule, unchanged) |
| Isolation | no tenant role reaches any of it — principal, IT admin, teacher, student, guardian alike |
| Data | **suspension is an access state, never a data operation.** No deletion, no anonymisation, no export block (R-7.11, unchanged and now load-bearing) |

Explicitly **not** authorised: an online payment gateway. Manual recording is
the whole of the requirement at this business stage. A gateway is a separate
phase requiring its own approval.

## Schema this will need (P7, not now)

- `tenant_status` gains `payment_due`, `grace_period`, `limited` — an enum
  extension, so forward and rollback both need writing carefully.
- A `subscription` and a `payment` table, both under D8: `tenant_id`,
  `app.enforce_tenant()`, RLS, rollback file, probe in `migration-status.mjs`.
- `features jsonb` finally gets a reader — the module entitlement set.

Nothing is built now. **Implementation is P7.** P2–P6 are UI phases.

## "100% customisable", bounded

The operator configures *supported settings* without editing code: identity,
branding, academic structure, subjects, users, student cap, plans, enabled
modules, notification policy, calendar, fee configuration, subscription state.

It does **not** mean arbitrary code, HTML, SQL or runtime scripting from an
admin screen. That is not customisation, it is a remote-execution feature with
a friendly name, and D4 already forbids its cousin (per-school code).


---

# P2 — the shared component system   (2026-09-01)

**Commit:** `6145592`. Eleven modules under `apps/pwa/src/ui/`, one import for
every screen built from P3 onward.

## Built against the duplication that is actually there

Measured before writing anything:

| Pattern | Files | Uses |
|---|---|---|
| Hand-built `.page-header` (the same 7 lines) | 29 | 37 |
| Hand-typed button class strings | 44 | 130 |
| `createElement('table')` | 9 | 9 |
| Field constructions | 24 | 268 |

None of the 268 fields associated its label, helper and error with its input;
none of the 9 tables had a mobile form; none of the 130 buttons guaranteed
`type="button"` or guarded a double submit.

## The piece that mattered most

§7 wants a table on desktop and a list on a phone. The only way both stay
correct is **one column declaration producing both** — a list is not a table
with the borders removed, it is the same record with a different thing in
charge of it. Each column declares what it is on a phone (`title` /
`subtitle` / `meta` / `status` / `hidden`), and the list carries each value's
column header as visually-hidden text, because on a list there is no header row
and "০১৭xxxxxxxx" read without "অভিভাবকের ফোন" is a number from nowhere.

Both renderings live in the DOM and a media query hides one — the shell's
decision from P1, for the same reason: `display:none` removes a subtree from
the accessibility tree as well as the page, so a screen reader meets exactly
one. `pagination()` exists so row counts stay bounded, since the cost is about
five extra nodes per row.

## What rendering it caught that no unit test could

The gallery renders every component with every state on one page. Five defects,
all found by looking, none findable by asserting:

1. **`.btn-primary` has been `width: 100%` since the app was phone-only.**
   There has never been an intrinsic-width primary button, so a "save" in a
   table row or a page header stretched the whole column. Fixed behind a
   `ui-btn` marker so the 130 legacy call sites keep the full-width bar they
   were written for.
2. **`.btn-primary` computes to `display: block`**, so a glyph, a label and a
   spinner inside it laid out as inline flow — the busy spinner rendered as a
   4×30 vertical bar. Legacy buttons contain one text node and never noticed.
3. **The stacked action order did the opposite of its own comment.**
   `column-reverse` put the primary on top; the comment said "under the thumb".
   One rule now: DOM order is priority order, least important first.
4. **Breadcrumb links measured 23px** — one pixel under WCAG 2.2 AA's target
   minimum.
5. **The four light-theme status tints were still the pre-Ata-Ekta palette.**
   P0 moved the grounds, the ink ramp, the brand and the DARK equivalents of
   these same four. These survived because they were hand-set hex rather than
   aliases, so re-pointing the alias layer never reached them — and `#e8eef7`,
   a cool blue-grey on a warm Muslin ground, still cleared 4.98:1, so no
   contrast test failed. `--c-danger-soft` was the worst: it aliased
   `--color-accent-100`, the BRAND ramp's palest step, so "absent" and
   "primary" had been drawing from one token by coincidence rather than by
   intent. All four are canonical now; ratios measured at 4.74 / 5.20 / 4.90 /
   4.93.

One further note, recorded because it is the kind of thing that becomes a
false memory: a dark-theme sweep reported two contrast failures on
`.btn-danger`. They were an artifact of flipping `data-theme` mid-batch and
measuring a half-updated tree — the direct measurement is 6.6:1, and a clean
reload shows zero. Chasing it is what found defect 5, so the bad measurement
earned its keep, but it was not a defect.

## Adoption

`pageHeader()` adopted in the 18 views that build its exact DOM: **90 lines in,
144 out**, byte-identical output, zero visual change. The other 11 deviate —
a conditional subtitle, an extra child — and are left for the phase that
redesigns them, which is where they were going to be touched anyway.

## The gallery is not deployable, structurally

Source in `apps/pwa/dev/`, built on demand by `scripts/build-gallery.mjs`, both
outputs gitignored. Everything under `public/` is deployed, and a component
gallery served from a school's own domain is a platform page on a tenant
surface (D11). It is also the only caller that exercises every component
signature at once, so `tsconfig.json` now includes `dev/` — a type error there
is a real API break.

## Verification

| Gate | Result |
|---|---|
| Contrast | **0 failures** at 360 / 375 / 390 / 1024 / 1280 / 1440, light and dark |
| Element checks | ~150 per configuration, 12 configurations |
| Horizontal overflow | none at any width, including 360 |
| Accessible names | 0 nameless controls |
| Focus trap | measured live: focus in → Cancel, siblings `aria-hidden`, survives Escape when non-dismissible, focus returns to opener, `aria-hidden` restored |
| Tests | **1,315** with a database (1,224 before) — 91 new component tests |
| TypeScript ×3 | 0 / 0 / 0 (now including the gallery) |
| Migrations | 48/48, schema untouched |
| D11 brand guard | pass |
| Secrets | clean |
| `app.css` | 39.1 → **45.7 KB gzipped** (+6.6) |
| `app.js` | 132.9 → **133.3 KB gzipped** (+0.4) — the modules tree-shake, so nothing but `pageHeader` ships until P3 uses it |

Remaining below the 44px iOS guideline and deliberately so: breadcrumb links
(24px, WCAG 2.2 AA's minimum, and inline-exempt) and filter chips (34px with a
fine pointer, 48px under `pointer: coarse`).

## What P2 deliberately did not build

**A DatePicker.** `field({ kind: 'date' })` is `<input type="date">`, which
opens the OS picker, is localised by the phone, works offline and costs
nothing. A hand-built calendar popover would be kilobytes on the critical path
(04-UIUX §6) to reproduce something the platform does better.

**A charting primitive.** 04-UIUX §6: charts are server-rendered inline SVG and
no charting library ships to the client. Nothing here draws a chart, so nothing
here can become the reason one gets installed.

**A style or colour prop on anything.** Every visual decision resolves to a
token. A component that accepts a colour will be given one outside the palette.

**The screens.** P2 is the system; P3–P6 are the screens.


---

# P3 — the teacher experience   (2026-09-01)

**Commits:** `5959975` (A/B), and the commit this entry lands with.
**Scope:** the six teacher screens, on the P0–P2 foundation.

## Step 0, first: the work was on one machine

The audit that preceded this phase found the ten commits carrying D14, D15,
P0, P1, D16 and P2 existed **only in this working tree** — `origin/main` was
still at `e7df9c2`. They were pushed before any P3 code was written:
fast-forward, no history rewritten, `origin/main` now at the same commit as
HEAD. That risk is closed and is recorded here because it was the largest one
the audit found and it had nothing to do with code quality.

## The dashboard

Every role landed on the same grid of feature tiles — a screen that answers
*what CAN I do* for a person who arrived asking *what do I do NOW*. A teacher
opening the app at 8:20 wants the class about to start and whether its register
is in.

Built entirely from `GET /rms/routine?scope=day`, which already returned every
field needed: period, time, subject, section, room, `isSubstitution`,
`coveringForBn`, `studentCount` and — decisively — **`attendanceTaken`**. It
wraps `app.teacher_day()`, so substitutions are already merged and the
authorization is the routine screen's. No endpoint, no migration, no
permission.

The urgent card is **derived on every render** — the period happening now whose
register is missing, else the next — never stored. A stored "next action" goes
stale the moment a register is taken on another device, and a shared staffroom
phone is the normal case.

**Exactly one dominant action**, and when every register is in there is none at
all: the card is replaced by a sentence saying so. A dashboard that always has
a big button teaches people to ignore it.

## Attendance

`AttendanceView` and its save path are untouched — that path is the product's
one durable write. What P3 added is the eleven moments around it, and the
removal of a fabrication.

The route used to build the screen from a cache written by a **different**
screen, falling back to:

    section: { id: 'demo-section', labelBn: '৯-ক', academicYearId: 'yr-2026' }

A teacher who opened হাজিরা before ever visiting the roster saw a real-looking
class that does not exist, and any save was rejected by sync because
`yr-2026` is not a uuid — the screen could only say "১টি পাঠানো যায়নি". The
screen asks the server now. With the fallback gone, **60 fabricated placeholder
students** and two loader helpers became dead code and were deleted.

Three states that did not exist:

- **Empty** — a section with no students, named, with a way out. A school's
  first day is all-empty and nothing has gone wrong.
- **Loading** — a list skeleton instead of a blank grid.
- **Retry** — the chip has said "৩টি পাঠানো যায়নি" since R-0 with nothing to do
  about it. There is now a line saying the data is safe on the device and a
  button that flushes.

Plus a double-submit guard (three taps enqueued three registers), a busy save
button, and seven facts in words: section · date · subject · period · students
· hand-marked · sync state.

**"Marked" counts `touched`, not tiles with a status.** `AttendanceGrid` starts
every student at `present`, so the naive count is the class size from the first
frame — a reassuring lie. The label reads "হাতে চিহ্নিত" for the same reason,
and the authoritative tally stays the grid's own present/absent/late counters.

## Roster, routine, marks, scripts

- **Roster** moved onto the shared `dataTable`: a table on a laptop, cards on a
  phone, one column declaration. The activation-code path is untouched.
- **Routine** got a real tab strip (roving tabindex, arrow keys) and a
  substitution that **explains itself** — the old tag said "পরিবর্তী ক্লাস",
  which names the fact and answers none of the question a teacher standing in
  an unfamiliar corridor is asking. Non-teaching slots also stopped rendering
  the raw enum: a break used to print the literal string `break` on a Bangla
  screen.
- **Marks** gained the guard it lacked. `dirty.size === 0` was the only one and
  it is cleared *after* the enqueue loop, so two taps on a slow phone enqueued
  the same marks twice with two different op ids and no de-duplication. A
  failed enqueue now keeps the typed numbers on screen. Published marks were
  already read-only; nothing said **why**, so a teacher fixing a typo met a
  form that silently refused keystrokes.
- **Scripts** stopped asking a teacher to type UUIDs. Two free-text boxes
  labelled `exam_subject uuid` and `student uuid` — §15's rule broken, and a
  screen nobody could use, because there is nowhere in the product to see a
  uuid. Three named pickers now, from the same three endpoints the marks and
  roster screens already call. The compression and upload architecture is
  unchanged.

## Verification

| Gate | Result |
|---|---|
| Rendered sweep | **3,010 element-checks** — 6 widths × light/dark × 2 tenants × 6 screens |
| Contrast | **0 failures** at 360 / 375 / 390 / 1024 / 1280 / 1440, both themes |
| Horizontal overflow | **none**, including 360 |
| Accessible names | 0 nameless controls |
| Tenant A / B | `#156a3f` and `#1b3e7a` — 0 failures each |
| Teacher scoping | 70 DB tests, incl. "a class teacher searches their own section, not the school" and "a teacher naming another section's student by code still gets nothing" |
| Tests | **1,038** without a database (1,019 before) — 19 new |
| TypeScript ×3 | 0 / 0 / 0 |
| `index.html` | byte-identical — verified by diff |

## Offline: what is proven, and what is not

The **durability** of the queue is proved in `packages/offline` — 46 tests
including *60 students marked offline and synced when the tower comes back*, *a
duplicate ack removes the op so a reinstall cannot double-post*, *exhausting
the retry budget parks the op rather than deleting it*, and *a user-triggered
retry re-arms a failed op*. P3 did not touch that path and does not repeat
those tests.

The **UI for those states** is what P3 built, and it is proved by 19 new tests
driving `AttendanceScreen` with a controllable outbox: queued renders, failed
renders with a working retry, offline says the data is on the device rather
than sent, a cached roster survives the network being gone, three taps enqueue
one register.

**Not proven: the full browser → server → database round trip.** Demo mode
answers locally, so its queue drains and cannot exercise the offline path; the
CI database has 0 tenants, so there is no seeded school to sync against. This
is recorded as unproven rather than claimed — the steps §"OFFLINE ACCEPTANCE"
lists as 7–11 (reconnect, sync, verify server result, retry a failed sync,
verify no duplicate records) need a seeded tenant and are the same gate the
pilot closes.

## What P3 did not do

Student, guardian, principal and IT-admin screens (P4/P5). The teacher's
`assignments`, `substitute` and `classperf` screens keep their legacy markup —
they are reached from More, not from the teaching day, and they belong to the
phase that redesigns their role's surface.
