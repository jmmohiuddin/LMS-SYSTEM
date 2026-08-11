# PRD v2.0 Audit — coverage against the 128 prioritised requirements

Audited 2026-08-12 against `Shikhon PRD v2.0 — Subject-Based Learning
Platform.md` (143 requirement rows, 128 carrying a real P0–P3 priority).

Method: every requirement ID was extracted from the PRD tables, then
verified against the repository — migrations, endpoints, views, and tests —
rather than against the PRD's own Status column, which reflects the state
when the PRD was written and is now stale in both directions. Where the
code cites an F-number in a comment that is corroborating evidence, not
proof; several requirements are implemented without citing their ID, and a
citation alone was never accepted as implementation.

## Headline

**All 61 P0 requirements are closed or deliberately dark, except four.**

The four genuinely open P0s are content-side, not platform-side:

| ID | Requirement | State | Why it is open |
|---|---|---|---|
| F-403 | Content authoring workspace | **Not built** | No authoring surface exists in this repo. Content reaches `topics` / `topic_blocks` only by direct insert. |
| F-406 | Offline content packs | **Not built** | No pack format, no download path. The service worker caches the shell, not curriculum. |
| F-1301 | NCTB corpus ingestion and grounded retrieval | **Half** | `008_ai_and_vectors` and the retrieval path exist; no corpus has been ingested, so retrieval has nothing to ground against. |
| F-902 | Multi-format submission (photo + voice) | **Half** | Text submission works. Photo and voice capture were scoped out and never returned to. |

These four share one root: the product can *teach* a syllabus it has not
been *given*. Every consumer of content is built — reader, practice loop,
suggestion engine, assignment inbox — and the producer is not.

## The gate that has quietly opened

`LOGIN_DISABLED = true` in `apps/pwa/src/login-view.ts:40`, held there by
the standing rule: *never enable login before F-102 rate limiting is live.*

**F-102 is now live.** All six service dispatchers call `enforceRateLimit`
before any handler runs, with read and mutation buckets sized for a whole
school behind one NAT gateway; `020_rate_limiting` backs it and
`rate-limit.test.ts` covers it.

The condition that disabled login has been satisfied. Enabling it is a
product decision, not an engineering one, and is left to the owner —
recorded here so it is not forgotten rather than actioned unasked.

## Dark by design — built, working, costing ৳0

These are complete and switched off. Each is off because it bills per use
or needs a vendor account, not because it is unfinished.

| ID | Requirement | Switch |
|---|---|---|
| F-201 | Mobile + OTP authentication | `LOGIN_DISABLED` (see above) |
| F-604 | Guardian notification on unexcused absence | no SMS credentials |
| F-1102 | SMS transport | no SMS credentials |
| F-1203 | MFS collection | no bKash/Nagad merchant account |
| F-1307 | ShikhoAI Socratic tutoring | no `ANTHROPIC_API_KEY` |

F-1307's kill switch is by absence: with no key the gateway returns a
refusal rather than failing open. Estimated cost if enabled is
৳700–4,000/month/school depending on model tier, tunable by `AI_MODEL_SIKHOK`.

## Closed at P0 — verified

Platform and security: F-101 (identifier sealing wired through
`sealIdentifier` in `import.ts`; the only path that collects an identifier),
F-102, F-103 / F-905 (row-version optimistic lock in `assignments.ts`),
F-104 (`022_prerequisite_acyclicity`), F-105, F-106.

Identity and structure: F-202 (activation codes, `037` + `activate.ts`),
F-203, F-302, F-303, F-304, F-305, F-307, F-308, F-401, F-402.

Routines: F-501, F-502, F-504 (GiST exclusion constraints as final
arbiter), F-506 (`032`), F-510 (`028`/`029`/`030`), F-513 (publication at
`editor.ts:327`).

Assessment and learning: F-701, F-702, F-710, F-801, F-802, F-803, F-804,
F-805, F-807, F-808, F-809, F-810, F-812, F-901, F-903, F-904.

Guardian, AI, ops: F-1001–F-1005, F-1101, F-1302 (grounding enforcement,
four answer states), F-1303, F-1304 (`024`), F-1310 (kill switch; no cost
ceiling — see below), F-1503 (`036` + `ops-svc/events`), F-1601 (`031`),
F-1605 (`033`).

## Known gaps below P0, carried forward honestly

- **No `audit_log` table exists.** F-1603 (audit log viewer, P1) has nothing
  to view, and §10.3's "the change is audited" currently rests on the
  provenance columns (`source`, `override_reason`, `approved_by`,
  `derived_at`, `row_version`) rather than an event log. Flagged in the
  §10.3 commit rather than faked.
- **F-1310 has no cost ceiling.** The kill switch is binary — key present or
  absent. F-1108 (notification cost ceiling, P1) is likewise unbuilt. Both
  matter the day a vendor account is connected, not before.
- **F-1607 dark mode (P2)** — `app.css` contains zero
  `prefers-color-scheme` rules. Not started.
- **Three wireframe screens remain unbuilt:** §5.2 first-run onboarding
  (F-206, P1), §10.1 institution health dashboard (F-1504, P1), and the
  trend charts behind F-1505 (P1).

## What this audit does not claim

Coverage here means the capability exists and is exercised by tests or by a
verified walkthrough. It does not mean every requirement is polished, and it
does not mean the system has been run against real school data — it has not.
The PRD's own Status column was not trusted and has not been updated in
place; this document supersedes it as of the date above.
