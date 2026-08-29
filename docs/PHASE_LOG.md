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
Current Phase:        none in progress — R-2 closed, R-3 not started
Last Completed Phase: R-2 — Notices & in-app notification system
Last Doc Phase:       R-7-DOC — tenant onboarding specified + pilot runbook
                      (documentation only; R-7 itself is NOT implemented)
Surfaces:             /  marketing (shikhonBD)  ·  /app  the application
                      /design  the Ata Ekta prototype
Last Commit:          HEAD of main — `git log -1`. Notable earlier commits:
                      R-0   a2a26942fe7a503b57344ff67a827ad2a2814189
                      R-1   5265ea3e561c4d9b86649d234eca9b3f90363e30
                      RULES 96639be51ac8851e44e27592cdf3d300f5ca33e9
                      D12   4ea1541b816745db580ed1b02154338a6f695f74
Tests:                477 unit passing, 0 failing (node --test, verified 2026-08-29)
                      + DB-backed suites that self-skip without DATABASE_URL — NOT YET RUN
Build:                npm run build ok · tsc ×3 exit 0 · app.js 74 KB gz / 180 KB budget
Known Blockers:       1. DB-backed suites for R-1 AND R-2 never executed — CI is their first run
                         (oldest open item in this log, and now spanning two phases)
                      2. Migration 038 has no probe in migration-status.mjs
                      3. R-2 auto-notice emitters not built (exam/result/invoice)
                      RESOLVED since the last update:
                        · two front doors — closed by R-1-A
                        · service-worker deploy staleness — closed by R-1-A
Next Step:            R-3 — Principal & IT admin portals (docs/11-MASTER-PLAN.md)
                      Owner input wanted on the 180-char notice-SMS cap (see R-2).
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
| **Status** | ✅ Complete — DB-backed suites written and wired into CI, not yet executed locally (see Known limitations) |
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
