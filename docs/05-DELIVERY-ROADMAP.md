# 05 — Delivery Roadmap, SLOs, Cost & Risk

---

## 1. Phasing

Sequenced so that each phase is independently deployable and produces something a school will
actually use. The ordering rule: **ship the daily-habit features before the quarterly ones.**
Attendance is used 200 times a year per teacher; report cards, twice.

### Phase 0 — Foundation (weeks 1–6)

- Migrations 001–003, 010 applied; CI tenancy suite green (cross-tenant read/write returns zero rows).
- `identity-svc`: phone+OTP auth, RBAC, tenant provisioning, envelope encryption with a real KMS.
- PWA shell: service worker, IndexedDB schema, outbox flush loop, sync push/pull skeleton.
- Cloudflare + Kong + Postgres HA in a BD-region VPC.

**Exit criterion:** a teacher can log in on a 2 GB Android phone over throttled 2G, see a cached
shell in under 2.5 s, and the tenancy suite proves isolation.

### Phase 1 — Attendance + RMS read (weeks 7–14) — *the wedge*

- Migrations 004, 006. Class/section/enrolment admin import (Excel/CSV — every school has one).
- Attendance grid, offline-first, with the full outbox path.
- SMS worker: absence alerts with the grace window, dedupe, holiday suppression, tenant cap.
- RMS **read**: routine import (Excel), teacher day view, week grid, clash detection API.

**Exit criterion:** 3 pilot schools take attendance daily for 4 consecutive weeks with
≥ 90 % of sections marked before period 2, and zero duplicate SMS complaints.

### Phase 2 — Assessment + Fees (weeks 15–24)

- Migrations 005, 007. NCTB CQ/MCQ item bank, exam setup, offline mark entry, GPA engine.
- Answer-script photo capture with the compression pipeline.
- Report cards (server-rendered PDF, ≤ 200 KB).
- Fee heads, invoicing, bKash + Nagad live integration, reconciliation job, receipts.

**Exit criterion:** one full term-end cycle — marks entered offline, results published, report
cards issued — plus one full monthly fee cycle reconciled to zero variance.

### Phase 3 — RMS generation + AI (weeks 25–36)

- CP-SAT solver, draft/publish/version/diff, drag-drop editor with live clash shading.
- Substitution engine with ranked candidates and justifications; coverage board.
- Migration 008. NCTB corpus ingestion; SikhokAI (CQ/MCQ/lesson plans); ShikhoAI tutor with
  guardrails, citations and the offline explanation pack.

**Exit criterion:** a coordinator generates a full-school routine from scratch in under 30 minutes
and publishes it without manual conflict fixing; SikhokAI CQ acceptance rate ≥ 70 % without edits.

### Phase 4 — ANS hooks + scale (weeks 37–44)

- Migration 009. Graduation event pipeline, outbound webhooks with retry/DLQ, batch pull API,
  GraphQL surface, inbound enrichment staging.
- Partition automation, dashboard materialised views, read-replica routing.
- Load test at 10× pilot volume; PDPA data-subject-access and erasure endpoints.

**Exit criterion:** a full graduating cohort exports to a stub ANS with zero duplicates across a
forced-retry chaos test, and p99 `/sync/push` stays under 400 ms at 500 rps.

---

## 2. Team shape

| Role | Count | Focus |
|---|---|---|
| Tech lead / architect | 1 | Schema, tenancy, sync protocol, review gate |
| Frontend (PWA) | 2 | Offline engine, attendance/routine/mark-entry surfaces |
| Backend (NestJS) | 2 | identity, academics, finance, ai-gateway |
| Backend (Go) | 1 | sync-svc, rms-svc, solver integration |
| Product designer | 1 | Bangla-first UI, field research in pilot schools |
| QA / SDET | 1 | Tenancy suite, offline/network-chaos harness, device lab |
| DevOps / SRE | 1 (0.5 FTE from Phase 2) | Cluster, Postgres HA, observability, on-call |
| Curriculum specialist | 0.5 | NCTB corpus, CQ rubric validation, board-rule correctness |

The curriculum specialist is not optional. NCTB component-pass rules and the optional-subject GPA
formula are the kind of thing that looks fine in code review and is discovered to be wrong by an
angry parent in week 30.

---

## 3. Service level objectives

| SLO | Target | Window | Error budget |
|---|---|---|---|
| Availability (school hours 07:00–17:00 BST) | 99.9 % | 30 d | 43 min |
| Availability (all hours) | 99.5 % | 30 d | 3.6 h |
| `/sync/push` p99 latency | ≤ 400 ms | 7 d | — |
| `/sync/pull` payload (teacher daily) | ≤ 20 KB gz | — | — |
| Attendance save → SMS delivered | p95 ≤ 90 s | 7 d | — |
| Offline op loss rate | 0 | absolute | — |
| Payment webhook → invoice credited | p99 ≤ 5 s | 7 d | — |
| MFS reconciliation variance | ৳0 | monthly | — |
| ANS delivery success (within 48 h) | ≥ 99.9 % | 30 d | — |
| First contentful paint, 3G, cold | ≤ 2.5 s | p75 | — |

**Zero offline op loss is an absolute, not a percentage.** An attendance record that vanishes is a
parent who was not told their child was absent. The outbox never deletes an op that has not been
acked, and `failed` ops retain an export-to-file escape hatch.

---

## 4. Observability

- **RED metrics** per service, **USE** per node, all in Prometheus; Grafana dashboards per service.
- **The four alerts that matter most** (everything else is a dashboard, not a page):
  1. `sms_outbox` queued depth > 500 for 10 min — parents are not being told.
  2. `mfs_transactions` completed-but-unreconciled > 48 h — money is unaccounted for.
  3. `v_default_partition_leakage` non-zero — the partition maintenance job has stopped.
  4. `audit.pii_access` > 50 decrypts/hour/actor — possible insider exfiltration.
- **Distributed tracing** (OpenTelemetry) with `traceId` propagated from the PWA outbox op through
  to the SMS provider call, so "why didn't this parent get the SMS?" is one query.
- **Client telemetry**: sync success rate, outbox depth distribution, time-to-attendance-save, and
  effective connection type — bucketed by device model, because the 2 GB Android Go cohort behaves
  nothing like the reviewer's phone.

---

## 5. Indicative infrastructure cost (per month, at 1 000 institutions / ~700 k students)

| Item | Estimate |
|---|---|
| Kubernetes (3–6 nodes, in-country DC) | $600–1 100 |
| PostgreSQL HA (primary + 2 replicas, 8 vCPU / 32 GB, 2 TB) | $700–1 200 |
| Redis (HA, 8 GB) | $120 |
| Object storage (answer scripts, ~4 TB/yr + egress) | $180 |
| Cloudflare (Business + Workers + Images) | $250 |
| **SMS** (~4 M messages/mo @ ৳0.35–0.45, 2–3 segments) | **$14 000–20 000** |
| AI inference (Haiku-weighted mix, per-tenant budgets) | $1 500–4 000 |
| Monitoring, backups, KMS | $300 |

**SMS dominates by an order of magnitude.** Three consequences drive product decisions:
per-tenant daily caps are enforced in the DB; the template library is CI-validated against
segment counts; and push notification is always attempted first, with SMS as the fallback for
guardians without a smartphone. Moving 40 % of guardians to push is worth more than every other
infrastructure optimisation combined.

---

## 6. Risk register

| # | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| R1 | SMS cost overruns the subscription price | High | High | Per-tenant caps, segment-validated templates, push-first delivery, cost dashboard exposed to the Principal |
| R2 | Offline sync conflicts erode trust in attendance data | Medium | High | Per-entity conflict policy (01-ARCH §2.6), visible diff UI, correction audit trail, zero-loss outbox |
| R3 | NCTB grading rules implemented wrong (component pass, 4th-subject GPA) | Medium | Critical | Curriculum specialist on staff; rules encoded in DB functions with a golden-dataset test suite from real board results |
| R4 | Routine solver infeasible or too slow for large schools | Medium | Medium | 60 s cap with best-known-feasible return; minimal-conflicting-subset explanation; manual editor always available |
| R5 | Cross-tenant data leak | Low | Critical | RLS + FORCE RLS + `SET LOCAL` + CI tenancy suite + namespaced cache/storage + quarterly pen test |
| R6 | MFS gateway sandbox differs from production | High | Medium | Reconciliation poll as source of truth; amount check before credit; staged rollout with one school |
| R7 | PDPA 2026 guidance shifts after launch | Medium | Medium | Data minimisation by default, in-country residency, retention config as data not code, DPO review each release |
| R8 | Teachers reject the app and revert to paper | Medium | Critical | Attendance-first wedge, < 30 s task, works with no signal, field research every sprint in pilot schools |
| R9 | AI generates out-of-syllabus or wrong CQs | Medium | High | Hard metadata pre-filter, mandatory citation validation, teacher approval before an item enters the bank |
| R10 | Device storage eviction destroys queued work | Low | High | `navigator.storage.persist()`, outbox size cap with warning, export-to-file escape hatch |
| R11 | Key personnel loss (single Go/solver engineer) | Medium | Medium | Solver isolated behind a gRPC contract; a documented greedy fallback keeps RMS shippable |
| R12 | ANS partner slips or changes contract | Medium | Low | Hooks are one-way-safe: `alumni_records` is materialised regardless, so a late ANS just replays a backfill |

---

## 7. Definition of done (every phase)

- [ ] Migrations applied forward **and** rolled back cleanly in CI.
- [ ] CI tenancy suite green — cross-tenant SELECT/UPDATE/DELETE all zero, and no-context reads zero.
- [ ] Offline harness green: airplane-mode authoring → 8 h delay → sync, with zero op loss and correct conflict handling.
- [ ] Bundle-size gate green (≤ 180 KB gz critical path).
- [ ] Lighthouse on a throttled Moto G Power profile: performance ≥ 85, accessibility = 100.
- [ ] Every new string present in both `bn` and `en`, and rendered at +35 % length without clipping.
- [ ] Every new table has RLS enabled, forced, and a policy — asserted by a schema lint test.
- [ ] Runbook entry for every new alert.
