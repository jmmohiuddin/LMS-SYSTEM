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
Current Phase:        none in progress — R-1 closed, R-2 not started
Last Completed Phase: R-1 — White-label & branding foundation
Last Commit:          R-1  5265ea3e561c4d9b86649d234eca9b3f90363e30
                      R-0  a2a26942fe7a503b57344ff67a827ad2a2814189
                      Rules/D10/D11 commit: git log -1 --format=%H -- docs/PHASE_LOG.md
Tests:                415 unit passing, 0 failing (node --test, verified 2026-08-29)
                      + DB-backed suites that self-skip without DATABASE_URL — NOT YET RUN
Build:                npm run build ok · tsc ×3 exit 0 · app.js 74 KB gz / 180 KB budget
Known Blockers:       1. Two front doors: "/" serves the design mock-up, not the app (R-1-A)
                      2. DB-backed branding tests never executed — first CI run is their first run
                      3. Service-worker cache-first on unhashed app.js: deploys may not reach devices
                      4. Migration 038 has no probe in migration-status.mjs
Next Step:            R-2 — Notices & notification system (docs/11-MASTER-PLAN.md)
                      Owner decision needed first on R-1-A (see that entry)
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
| **Status** | 🔴 **Open — owner decision required.** Documented, not acted on. |
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
