# START HERE — the whole project, A → Z (D17 §17)

You are reading this because you have **no chat history**. That is the normal
case and this file is built for it. Every question below is answerable from
the repository; where the honest answer is "not built" or "not observed", it
says so, because a document that rounds those up to "done" is the specific
failure D17 exists to prevent.

Last reconciled **2026-09-01**, at the end of P6.

## Read in this order

1. **This file** — orientation and the twenty-two answers.
2. [`11-MASTER-PLAN.md`](11-MASTER-PLAN.md) — decisions of record (D1–D17),
   the roadmap, **§5a the phase status board**, **§5b architecture drift**.
3. [`07-IMPLEMENTATION-STATUS.md`](07-IMPLEMENTATION-STATUS.md) — what the
   repository contains right now, blueprint vs as-built.
4. [`BACKLOG.md`](BACKLOG.md) — the single list of what is not done, and why.
5. [`PHASE_LOG.md`](PHASE_LOG.md) — append-only history. Read it when you need
   to know *why* something is the way it is. It is long on purpose.

Everything else is reference: [`01-ARCHITECTURE.md`](01-ARCHITECTURE.md),
[`02-RMS-DEEP-DIVE.md`](02-RMS-DEEP-DIVE.md),
[`03-API-SPECIFICATIONS.md`](03-API-SPECIFICATIONS.md),
[`04-UIUX-ACCESSIBILITY.md`](04-UIUX-ACCESSIBILITY.md),
[`05-DELIVERY-ROADMAP.md`](05-DELIVERY-ROADMAP.md),
[`06-DEPLOYMENT.md`](06-DEPLOYMENT.md),
[`08-CREDENTIAL-ROTATION.md`](08-CREDENTIAL-ROTATION.md),
[`09-PRD-AUDIT.md`](09-PRD-AUDIT.md), [`10-NETLIFY.md`](10-NETLIFY.md),
[`12-PRODUCTION-RUNBOOK.md`](12-PRODUCTION-RUNBOOK.md),
[`PILOT-ONBOARDING-RUNBOOK.md`](PILOT-ONBOARDING-RUNBOOK.md),
[`UI-UX-INTEGRATION-PLAN.md`](UI-UX-INTEGRATION-PLAN.md),
[`FINAL-PRODUCT-SURFACE-ARCHITECTURE.md`](FINAL-PRODUCT-SURFACE-ARCHITECTURE.md),
[`FINAL-FULL-PROJECT-AUDIT-PLAN.md`](FINAL-FULL-PROJECT-AUDIT-PLAN.md).

---

## The twenty-two answers

### 1. What is shikhonBD?

A multi-tenant, white-label, **offline-first** School / College / Madrasa
management SaaS for Bangladesh, sold to institutions and used in Bangla.
One deployment serves many schools; each sees only its own data and its own
branding. Full requirement map: `11-MASTER-PLAN.md` §3.

### 2. What architecture is actually deployed?

**As-built, since 2026-08-31:** a Hostinger KVM2 VPS (`voltix-prod`, Ubuntu
24.04) running one Node process (`deploy/server.mjs`) under systemd, behind
**Caddy** which already served five sibling applications, with PostgreSQL in a
dedicated **`pgvector/pgvector:pg16` Docker container** bound to loopback.

**The blueprint says Vercel + Neon.** Both descriptions are in the repository
and both are true of different things. The difference, why it changed, and its
security and availability implications are in **`11-MASTER-PLAN.md` §5b**.
Reconciling the blueprint documents needs an owner decision — `B-27`.

**Code shape** (unchanged by the above): a modular monolith. Ten `services/*`
directories are the sources; `api/v1/*` and `netlify/functions/*` are built
bundles and are **never edited by hand**. The client is a framework-free PWA
with an IndexedDB outbox.

### 3. What is the public website?

`https://sikhon.systems/` — the shikhonBD marketing site, served from
`apps/pwa/public/index.html`.

**It is permanently frozen** by owner decision: no redesign, recolour,
restructure, rewrite, replacement or visual modification without explicit
approval. Every phase since verifies its SHA is unchanged (P4 checked it at
five commits and the working tree: `496199bd`). It loads only
`/design/tokens/*.css` and has never loaded `app.css`, so application styling
work cannot reach it.

### 4. What is the demo?

`/demo` — its own address since P1. Entirely client-side: `demo.ts` answers
every request locally, **no request leaves the device**, and nothing can touch
real tenant data. Sample data for all roles; a role picker and a tenant picker
(A/B) so both brandings and every persona are previewable.

Before P1, `/app` fell into demo mode implicitly whenever nobody was logged in
— so a logged-out real teacher saw fabricated students under their own
school's door. That is fixed: `/app` logged-out goes to login.

### 5. What is the Platform Admin?

The **Platform Console** — `platform.sikhon.systems` preferred,
`/platform` kept as the compatibility door. shikhonBD-branded, **never**
white-labelled, Super Admin only. It creates institutions through a nine-step
wizard so onboarding needs no SQL. It authenticates with a Super Admin JWT
**plus** `X-Platform-Key` **plus** its own database role; `shikhon_app` is
explicitly revoked EXECUTE on the DEFINER functions behind it. Unset
`PLATFORM_DATABASE_URL` answers 503 rather than falling back.

**D16** additionally assigns it the commercial relationship — plan, price,
student cap, manually recorded payments, and an access state re-evaluated from
that record. **Not built. It belongs to P7.**

### 6. What is the tenant app?

`<slug>.sikhon.systems` preferred, `/app?tid=<tenant-id>` kept as the
backward-compatible door. **White-labelled**: the school's name, logo, colours
and letterhead. One application with role-scoped navigation, never five sites.

### 7. How does tenant resolution work?

Each institution gets **its own entry link — never a school-picker** (D12).
`tenantKeyFromHost()` works on label count rather than a hardcoded domain, and
reserves `www`, `app`, `platform`, `api`, `staging`, `localhost`, so
`platform.sikhon.systems` can never be read as a tenant. The device remembers
the tenant; a PWA install bakes it into `start_url`; the login screen renders
that school's identity before anyone signs in. `app.public_branding()` answers
only exact keys and returns 200-with-defaults for unknown ones, so the login
page cannot be used to enumerate customers. Mechanism: `11-MASTER-PLAN.md` §1b.

### 8. What roles exist?

Eleven tenant roles: `school_owner`, `principal`, `academic_coordinator`,
`dept_head`, `accountant`, `class_teacher`, `subject_teacher`, `librarian`,
`it_admin`, `student`, `guardian` (canonical list and Bangla labels:
`apps/pwa/src/ui/roles.ts`). Plus `super_admin`, which is **platform-side
only** and exists in no tenant.

Roles are code-gated (`requireRole` / `requireStaff`) *on top of* RLS. The
seeded `role_permissions` table is deliberately unread — D5.

### 9. How is tenant isolation enforced?

At the database, by **row-level security**, not by the application: 227 RLS
policies over 110 RLS-enabled tables, 108 of which carry `tenant_id`.
`withTenant()` sets `app.tenant_id` / `user_id` / `role` with `SET LOCAL`
inside a transaction. The runtime roles (`shikhon_app`, `shikhon_platform`)
are asserted at boot to hold neither SUPERUSER nor BYPASSRLS — PostgreSQL
exempts such roles from RLS, which would void the whole model silently.

D8 makes it absolute: every new table gets `tenant_id`, the
`app.enforce_tenant()` trigger, an RLS policy, a rollback file and a probe.

Two facts worth knowing before you write a test: **RLS scopes `DELETE` too**
(a cleanup under tenant A cannot delete tenant B's rows — this cost P4 an
afternoon), and the frontend is *never* the enforcement layer.

### 10. What has been completed?

Functional roadmap R-0 … R-7 complete (R-5 and R-6 **PARTIAL** — see the
board). UI/UX roadmap **P0 … P6 complete**, plus a **Pre-P5 Product Closure
Pass** that closed `B-6` (class/section rename), `B-8` (logout and cache
privacy) and `B-15` (the student routine, migration 049). P5 closed `B-7`
(guardian unlink, migration 050) and `B-34` (every Principal and IT Admin
screen on the design system). P6 took the nineteen functional screens that
had no design reference and found fourteen defects doing it — including two
that offered a student a staff job, and a `emptyState` primitive that ignored
the icon it was given. Full table with the exact qualifications:
`11-MASTER-PLAN.md` **§5a**.

### 11. What is currently being built?

Nothing is in progress. P6 closed on 2026-09-01; the next approved phase is
**P7**, not started. R-8 remains open in external-dependency mode.

### 12. What is not built?

[`BACKLOG.md`](BACKLOG.md), in full, with IDs. The short version: real SMS,
push observed on a device, an alert webhook, a production cross-tenant probe,
a pilot school, guardian **unlink**, object storage, CSV export, operator SSO,
section chat. (Class/section **edit** was closed by the closure pass, and
guardian **unlink** by P5 — migration 050.)

### 13. Why is it not built?

Three different reasons, and they are not interchangeable:

- **External dependency** — no aggregator contract, no storage provider, no
  pilot institution. Code cannot close these (`BACKLOG.md` §5).
- **Deliberately deferred with a stated trigger** — the board-registration
  index is a confirmed seq scan that is genuinely fine at 3–5 schools and
  costs write throughput on the largest write in the product; the pilot
  produces the numbers that should decide it.
- **A feature needing owner approval** — class/section edit and guardian
  unlink were both of these; both are now built (the closure pass and P5).
  What remains in this category is listed in `BACKLOG.md`.

### 14. What is the next phase?

**P7 (+D16 commercial controls, which no earlier phase may implement).**

P6 is complete: the nineteen functional screens that had no design reference
are on the canonical system, with `marks`' entry grid, `exam-routine`'s inline
reschedule row and two CSS bar charts recorded as deliberate exceptions. Its
audit found fourteen defects — two security (the teacher's AI generator and
the answer-script upload were offered to a student), two screens claiming an
error and an empty state at the same time, and an `emptyState` primitive that
ignored the icon it was handed, which five screens had worked around with a
stray combining character. It also reproduced, diagnosed and fenced P5's one
non-reproducible test failure: DB fixtures live at fixed uuids, so two runs of
one suite delete each other's rows. All described in PHASE_LOG under "P6".

**One thing P6 recorded rather than decided:** `home` and `institution` are two
principal dashboards over one endpoint. P6 gave them different questions so
they no longer read as two versions of one screen, but whether a school wants
two at all is an owner decision (`BACKLOG.md`).

After P7: P8, production hardening, the final audit.

### 15. What production blockers exist?

`B-3` alert webhook · `B-4` cross-tenant probe on production · `B-5` a pilot
institution. (`B-6`, class/section edit, was a blocker and is closed.) `B-1`
(real SMS) blocks SMS login but **not** a pilot, because login uses activation
codes.

### 16. What decisions were made?

**D1–D17**, in `11-MASTER-PLAN.md` §1. The ones you will trip over if you do
not know them: **D4** white-label by configuration, never per-school code ·
**D8** the schema rule · **D10** PHASE_LOG is append-only · **D11** shikhonBD
is the permanent *platform* brand and only the *tenant application* is
white-labelled · **D12** no school-picker, ever · **D13** a feature is not
implemented until a person can use it · **D14** Ata Ekta is the canonical
visual direction for `/app` · **D15** five surfaces · **D16** the console owns
the commercial relationship · **D17** this documentation rule.

### 17. What decisions were superseded?

- **R-7.10 "billing the schools is out of scope"** → superseded by **D16**
  from R-7 onward; it stands as written for R-7 itself.
- **D7** ("new agent surfaces follow Ata Ekta") was *never implemented* and is
  carried with that warning in place rather than quietly corrected; **D14**
  is the decision that actually made it happen.
- **Neon + Vercel as the deployed architecture** → superseded in practice by
  the VPS deployment, **but the blueprint documents are deliberately not
  rewritten** (`B-26`, `B-27`).

Nothing is ever deleted to make the record look cleaner (D10, D17).

### 18. What security evidence exists?

**Observed on production** (2026-08-31): 48 migrations, 227 RLS policies,
runtime roles non-super and non-bypassrls, **0 tenants visible with no tenant
context**, valid TLS, unauthenticated 401 / public 200 / service-key 200, and
a restore drill on the production database with identical schema and table
counts at **RTO 1.5 s**.

**Tested locally:** a 29/29 security probe over 12 areas with positive and
negative cases; cross-tenant isolation by header, id, query and body; a
cross-tenant *write* refused; `check-secrets --history` clean over 136
commits; and P4's 11-case privacy matrix across two tenants proving student
self-scope, guardian child-scope and cross-tenant refusal.

### 19. What evidence is only local?

Everything in the second paragraph above. Specifically, and stated in D17's
vocabulary: the SMS pipeline passed against a **fake aggregator** (REHEARSED,
not delivery); the cross-tenant API probe is **local only**, because
production has no second tenant (`B-4`); backup **restore** has production
evidence but full disaster recovery has not been rehearsed end to end; web
push is **UNTESTED on a real device** (`B-2`); "onboarded in under one hour"
is **UNMEASURED** (`B-29`). A rehearsal never becomes a pass.

### 20. What is required before pilot?

`B-3`, `B-4`, `B-5`, `B-6` — and `B-7` (guardian unlink) is the
highest-consequence non-blocker, because a guardian linked to the wrong child
is a privacy incident that currently needs SQL to end. Procedure:
[`PILOT-ONBOARDING-RUNBOOK.md`](PILOT-ONBOARDING-RUNBOOK.md).

### 21. What is required before final release?

The pilot gates above, plus: R-8 closed with real evidence rather than
rehearsals; P5–P8 complete so every role's screens are on the canonical design
system; D16's commercial controls built in P7; the architecture drift decided
and reconciled (`B-27`); and the final audit run to its own plan.

### 22. How should the final audit be performed?

Exactly as written in
[`FINAL-FULL-PROJECT-AUDIT-PLAN.md`](FINAL-FULL-PROJECT-AUDIT-PLAN.md), which
was authored to be executable with **no chat history** — the same constraint
this file serves. It carries its own severity ladder, and it treats a red or
un-runnable quality gate as HIGH, because this project shipped six commits
with a failing type-check that nobody had run.

---

## Before you change anything

- **Never edit** `api/v1/*.js` or `netlify/functions/*` — they are build
  outputs; sources are in `services/`.
- **Never modify** `apps/pwa/public/index.html` (question 3).
- **Never weaken a test** to make a gate green.
- **Run the gates and read the result.** `npm test` skips the DB suites
  silently unless `DATABASE_URL` is set — it prints "NOTHING RAN" when that
  happens, and that line is the difference between ~1,090 and **1,407** tests.
- **`tsc -p .` does not typecheck `apps/pwa`** — the root config excludes it.
  CI runs three configs and so must you: `tsconfig.json`,
  `apps/pwa/tsconfig.json`, `apps/pwa/tsconfig.sw.json` (`B-31`).
- **Append to `PHASE_LOG.md` before calling anything complete** (D10, D17).
- Node runs this repository's TypeScript in **strip-only** mode: `tsc` is a
  separate gate, and `constructor(public readonly x)` is valid TypeScript that
  the runtime rejects.
