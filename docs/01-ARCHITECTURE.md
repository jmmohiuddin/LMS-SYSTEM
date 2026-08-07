# 01 — Architecture Overview

---

## 1. System context

```
                          ┌───────────────────────────────────────────┐
   Android Go / 2G        │  Cloudflare Edge (Dhaka + Singapore PoP)  │
   ┌──────────────┐       │  ─ WAF, bot mgmt, Brotli, image resize    │
   │  PWA Shell   │◀─────▶│  ─ Workers: HTML streaming + geo-pin      │
   │  IndexedDB   │       └────────────────┬──────────────────────────┘
   │  SW Outbox   │                        │ mTLS
   └──────────────┘                        ▼
                              ┌────────────────────────┐
                              │  API Gateway (Kong)    │
                              │  JWT verify, tenant    │
                              │  resolution, rate-limit│
                              └───────┬────────────────┘
        ┌──────────────┬──────────────┼───────────────┬───────────────┐
        ▼              ▼              ▼               ▼               ▼
  ┌──────────┐  ┌───────────┐  ┌────────────┐  ┌───────────┐  ┌────────────┐
  │ identity │  │ academics │  │ sync-svc   │  │  rms-svc  │  │ finance-svc│
  │ (NestJS) │  │ (NestJS)  │  │   (Go)     │  │   (Go)    │  │  (NestJS)  │
  └──────────┘  └───────────┘  └────────────┘  └───────────┘  └────────────┘
        ▼              ▼              ▼               ▼               ▼
  ┌────────────────────────────────────────────────────────────────────────┐
  │  PostgreSQL 16 (primary + 2 replicas) — RLS-enforced multi-tenancy     │
  │  pgvector · pg_partman · btree_gist · pgcrypto                          │
  └────────────────────────────────────────────────────────────────────────┘
        ▲              ▲              ▲               ▲
  ┌──────────┐  ┌───────────┐  ┌────────────┐  ┌──────────────┐
  │  Redis   │  │  BullMQ   │  │  MinIO/R2  │  │ ai-gateway   │
  │ cache +  │  │  workers  │  │ answer     │  │ (NestJS)     │
  │ RLS ctx  │  │ sms/mfs   │  │ scripts    │  │ RAG + guard  │
  └──────────┘  └───────────┘  └────────────┘  └──────┬───────┘
                                                       ▼
                                          Claude API (Opus 5 / Haiku 4.5)
                                                       │
                                            ┌──────────▼───────────┐
                    External:               │ bKash · Nagad · Rocket│
                                            │ SSL Wireless / Robi SMS│
                                            │ Alumni Networking Sys │
                                            └───────────────────────┘
```

**Data residency.** Primary Postgres, MinIO object store and all PII-bearing queues run in a
Bangladesh-region VPC (BDIX-peered DC, e.g. Aamra/Bangladesh Data Center Co.). Cloudflare
carries only cached static assets and TLS termination; no PII transits edge KV. AI inference
egresses to the Claude API **after** the guardrail layer strips direct identifiers (§6.3).

---

## 2. PWA offline architecture

### 2.1 The three-tier storage model

| Tier | Technology | Contents | Eviction |
|---|---|---|---|
| **Shell** | Cache Storage, precached by SW | HTML shell, JS/CSS chunks, Bangla WOFF2 subsets, icon sprite | On SW version bump |
| **Working set** | IndexedDB (Dexie 4) | Today's routine, my sections, current-term rosters, unsynced writes, offline item bank | LRU by `lastTouchedAt`, capped at 40 MB |
| **Cold** | Server only | Historical attendance, past exams, ledgers | n/a — fetched on demand, never precached |

Storage is requested persistent via `navigator.storage.persist()` on first successful login so
Android does not evict the outbox under memory pressure. If persistence is denied, the app
degrades to a "sync before you close" banner and blocks large offline downloads.

### 2.2 IndexedDB schema (Dexie)

```ts
// packages/offline-db/src/schema.ts
export const db = new Dexie('shikhon');

db.version(1).stores({
  // ── Reference data: server-authoritative, read-only on client ──────────
  meta:            '&key',                       // tenantId, userId, cursors, schemaVersion
  sections:        '&id, classId, updatedAt',
  students:        '&id, sectionId, roll, [sectionId+roll]',
  subjects:        '&id, classId',
  routineSlots:    '&id, [teacherId+dayOfWeek], [sectionId+dayOfWeek], roomId',
  itemBank:        '&id, [subjectId+chapter], type',

  // ── Local mutable state ───────────────────────────────────────────────
  attendanceDraft: '&[sessionId+studentId], sessionId, dirty',
  markEntryDraft:  '&[examSubjectId+studentId], examSubjectId, dirty',

  // ── The outbox: every write the user makes while offline ──────────────
  outbox:          '++seq, opId, status, entity, [status+seq], nextAttemptAt',

  // ── Binary payloads kept out of the outbox row for size ───────────────
  blobs:           '&opId',                      // compressed answer-script JPEGs
});
```

### 2.3 The outbox pattern (write path)

Every mutation the user performs — offline **or** online — is written to the outbox first. The
UI never awaits the network. This single rule removes the entire class of "did my attendance
save?" bugs.

```
User taps "Save attendance"
        │
        ├─► 1. Write rows to attendanceDraft (dirty = 1)      [~4 ms]
        ├─► 2. Append ONE outbox op (opId = UUIDv7)           [~2 ms]
        ├─► 3. Optimistically update UI, show ⏳ chip         [~0 ms]
        └─► 4. registration.sync.register('outbox-flush')
                    │
                    ├─ online  → fires immediately
                    └─ offline → OS fires it when connectivity returns
                                 (Background Sync; falls back to a
                                  visibilitychange + online listener on
                                  browsers without the API)
```

**Outbox operation envelope**

```jsonc
{
  "opId":       "018f3a2c-...-7c1e",   // UUIDv7 — client-generated, is the idempotency key
  "seq":        184,                    // monotonic per-device, guarantees ordering
  "deviceId":   "dev_7Kq…",
  "tenantId":   "tnt_dhanmondi_ideal",
  "actorId":    "usr_9812",
  "entity":     "attendance_session",
  "operation":  "upsert",
  "occurredAt": "2026-08-06T03:44:12.881Z",  // client clock
  "baseVersion": 3,                     // row version last seen — enables conflict detect
  "payload":    { "sessionId": "...", "records": [ { "studentId": "...", "status": "A" } ] },
  "status":     "pending",              // pending | inflight | acked | conflict | failed
  "attempts":   0,
  "nextAttemptAt": 0
}
```

**Flush loop (in the Service Worker, so it survives tab close):**

```ts
// apps/pwa/src/sw/outbox-flush.ts
const BATCH = 25;                       // sized so a batch fits one 2G MTU window (~28 KB)

async function flush() {
  const lock = await navigator.locks.request('outbox', { ifAvailable: true }, async (l) => {
    if (!l) return;                                        // another tab is already flushing
    for (;;) {
      const ops = await db.outbox
        .where('[status+seq]').between(['pending', 0], ['pending', Infinity])
        .filter(o => o.nextAttemptAt <= Date.now())
        .limit(BATCH).toArray();
      if (!ops.length) return;

      await db.outbox.bulkUpdate(ops.map(o => ({ key: o.seq, changes: { status: 'inflight' } })));

      const res = await fetch('/api/v1/sync/push', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' },
        body: await gzip(JSON.stringify({ ops })),         // CompressionStream — ~7× on JSON
      });

      if (res.status === 409) { await handleConflicts(await res.json()); continue; }
      if (!res.ok) { await backoff(ops); return; }          // 1s→2s→4s…→15m, full jitter

      const { results } = await res.json();
      await applyAcks(results);                            // acked → delete; conflict → surface
    }
  });
  return lock;
}
```

**Backoff schedule:** `min(15 min, 2^attempts × 1s) × jitter(0.5–1.5)`. After 12 failed
attempts an op moves to `failed` and raises an in-app "N changes could not sync" affordance
with a one-tap retry and an export-to-file escape hatch.

### 2.4 Read path & cache strategies

| Route class | Strategy | Rationale |
|---|---|---|
| App shell (`/_next/static/*`, fonts, icons) | **Cache-first**, immutable, 1 y | Content-hashed; zero revalidation on 2G |
| Navigation requests | **App-shell fallback** (`/offline` → hydrate from IDB) | Page loads with no network at all |
| `GET /sync/pull` | **Network-only**, delta-cursor | Never stale-serve authoritative data |
| Reference reads (routine, roster) | **Stale-while-revalidate** from IndexedDB | Instant render, silent refresh |
| Student media (answer scripts) | **Cache-first with 7-day TTL**, range requests | Large, rarely re-read |
| AI chat (`/ai/*`) | **Network-only** + explicit "offline" state | Never fake a tutor response |

### 2.5 Delta sync protocol (read path)

Pull is cursor-based, not timestamp-based, to survive clock skew on cheap Android devices.

```
GET /api/v1/sync/pull?cursor=<opaque>&scopes=routine,roster,itembank
→ 200
{
  "cursor": "eyJsc24iOiI0Mi8zQjhBMDIwIn0",   // Postgres LSN + per-scope watermark
  "hasMore": false,
  "changes": {
    "routineSlots": { "upsert": [ … ], "delete": ["slot_18f…"] },
    "students":     { "upsert": [ … ], "delete": [] }
  },
  "serverTime": "2026-08-06T03:45:02Z"
}
```

- Payloads are **field-diffed** server-side against the client's cursor; a typical daily pull for
  a class teacher is **6–14 KB gzipped**.
- `serverTime` drives a client clock-offset estimate stored in `meta`; all `occurredAt` values are
  corrected by this offset before conflict resolution.
- On `410 Gone` (cursor older than the 30-day change-log retention) the client does a scoped
  full re-seed of only the affected scope.

### 2.6 Conflict resolution

| Entity | Policy | Reason |
|---|---|---|
| Attendance record | **Last-writer-wins on `(occurredAt, deviceId)`**, but a *present→absent* flip after the SMS has fired creates a `correction` row rather than mutating | Absence SMS is irreversible; the audit trail must show it |
| Exam marks | **Server-wins if already published**; otherwise LWW with a diff prompt to the teacher | Published results are legally significant |
| Routine slots | **Server-wins, always** — the client cannot author routines offline | Clash-freedom is a global invariant |
| Fee payment | **No client authorship**; MFS callback is the only source of truth | Money |
| AI chat history | Append-only CRDT (grow-only set keyed by `opId`) | Merges trivially |

Conflicts return `409` with both versions; the UI shows a two-column Bangla/English diff and a
single "রাখুন / Keep mine" vs "সার্ভারেরটি নিন / Take server's" choice.

### 2.7 Answer-script photo pipeline

The single largest bandwidth risk. Handled entirely client-side before the outbox:

1. `<input capture="environment">` → `createImageBitmap` with `resizeWidth: 1280`.
2. Auto-crop via a 12 KB WASM edge-detector (page-boundary quadrilateral) — optional, skipped on
   devices reporting `deviceMemory <= 2`.
3. Grayscale + adaptive threshold → **JPEG q=0.55** (WebP where `createImageBitmap` reports support).
   A typical A4 handwritten script: **3.1 MB → 88 KB**, still OCR/legible-grade.
4. Stored in `blobs`; the outbox op carries only `{ opId, sha256, bytes }`.
5. Upload uses **resumable chunked PUT** to a presigned MinIO URL, 64 KB chunks, `Content-Range`
   resume — survives a 2G dropout mid-file without restarting.

---

## 3. Microservice topology

Deliberately **modest**: six deployables, not twenty. Every extra service is a new failure mode
for an ops team that will be two people in Dhaka.

| Service | Runtime | Owns | Why this runtime |
|---|---|---|---|
| `web` | **Next.js 15** (App Router, RSC) on Cloudflare-fronted Node | PWA, SSR shell, service worker | Streaming SSR gets first paint out in one RTT on 2G |
| `identity-svc` | **NestJS** | Users, sessions, RBAC, tenant provisioning, OTP | Rich guard/decorator model fits RBAC well |
| `academics-svc` | **NestJS** | Classes, subjects, enrolment, attendance, NCTB assessment, GPA | Business-rule heavy, benefits from DI + class-validator |
| `sync-svc` | **Go 1.23** | `/sync/push`, `/sync/pull`, change-log tailing, conflict arbitration | Highest RPS, tiny allocations, p99 matters most here |
| `rms-svc` | **Go 1.23** | Routine generation (CP-SAT), clash detection, substitution search | CPU-bound constraint solving; goroutine fan-out |
| `finance-svc` | **NestJS** | Fee heads, invoices, MFS orchestration, ledger, receipts | Transactional, integrates 3 SDK-less REST gateways |
| `ai-gateway` | **NestJS** | SikhokAI + ShikhoAI, RAG retrieval, guardrails, cost metering | Streaming SSE proxy with per-tenant budget enforcement |
| `worker` | **BullMQ (Node)** + **Go workers** | SMS fan-out, receipt PDF, ANS webhooks, report cards, nightly GPA | Queue-native retry semantics |

**Communication.** Synchronous calls are HTTP/JSON through the gateway only for user-facing
paths. Everything else is asynchronous over Redis Streams (BullMQ) with the **transactional
outbox pattern** — services write domain events to a `public.event_outbox` table in the same
transaction as the state change, and a relay pushes them to Redis. This is what makes
"attendance saved ⇒ SMS eventually sent" a guarantee rather than a hope.

**Event catalogue (excerpt)**

| Event | Emitter | Consumers |
|---|---|---|
| `attendance.marked.v1` | academics-svc | sms-worker, guardian-notify, analytics |
| `attendance.absence_confirmed.v1` | sms-worker (after grace window) | sms-dispatch |
| `exam.result_published.v1` | academics-svc | report-card-worker, ans-webhook, guardian-notify |
| `student.graduated.v1` | academics-svc | **ans-webhook**, alumni-export |
| `payment.settled.v1` | finance-svc | receipt-worker, ledger-poster, guardian-notify |
| `routine.published.v1` | rms-svc | sync-svc (invalidates cursors), guardian-notify |
| `routine.substitution_assigned.v1` | rms-svc | sms-worker, teacher-notify |

**Deployment.** Single Kubernetes cluster (3 nodes to start), one namespace per environment.
Postgres is managed (or Patroni-on-VM in-country if no managed BD option), 1 primary + 1 sync
replica + 1 async replica for reporting. No service mesh — mTLS terminates at the gateway, and
intra-cluster traffic uses NetworkPolicies.

---

## 4. Multi-tenancy

**Model: shared database, shared schema, RLS-enforced.** Chosen over schema-per-tenant because
a national rollout means 5 000–20 000 institutions; 20 000 schemas breaks `pg_dump`, migrations
and the catalog. Chosen over database-per-tenant on cost.

### 4.1 The tenant context chain

```
JWT (tenant_id claim, signed EdDSA, 15-min TTL)
  → Kong plugin verifies + injects X-Tenant-Id
    → service middleware opens a pooled connection and runs, in a transaction:
          SET LOCAL app.tenant_id  = '<uuid>';
          SET LOCAL app.user_id    = '<uuid>';
          SET LOCAL app.role       = 'class_teacher';
      → every query is now automatically filtered by RLS
```

Three rules make this airtight:

1. **`SET LOCAL`, never `SET`.** Transaction-scoped, so a pooled connection cannot leak context
   to the next request. PgBouncer runs in **transaction pooling** mode; `SET LOCAL` is the only
   form that is safe there.
2. **The application role is `NOINHERIT` and never `BYPASSRLS`.** Migrations run as a separate
   owner role.
3. **A `FORCE ROW LEVEL SECURITY` on every tenant table**, so even the table owner is filtered.

Escape hatch for Super Admin: a distinct DB role `shikhon_platform` with `BYPASSRLS`, reachable
only from the admin service, every statement logged to `audit.platform_access`.

### 4.2 Defence in depth

RLS is the enforcement layer, but not the only one:

- Every repository method takes `tenantId` explicitly and asserts it matches `app.tenant_id`.
- A CI test suite (`test/tenancy/`) enumerates every table and asserts cross-tenant `SELECT`,
  `UPDATE` and `DELETE` all return zero rows / zero affected under a foreign tenant context.
- Redis keys are namespaced `t:{tenantId}:…`; a lint rule forbids un-namespaced keys.
- Object storage paths are `s3://scripts/{tenantId}/{academicYear}/…` with per-tenant IAM
  path conditions on presigned URLs.

---

## 5. Data layer

### 5.1 Sizing assumptions (per 1 000 institutions, 700 students avg)

| Table | Rows/year | Strategy |
|---|---|---|
| `attendance_records` | ~150 M | **Range-partitioned by month**, `pg_partman`, 24-month hot retention, then compressed archive |
| `exam_marks` | ~40 M | Partitioned by `academic_year_id` |
| `routine_slots` | ~2 M | Unpartitioned, heavily indexed |
| `sms_outbox` | ~30 M | Partitioned by month, 90-day retention |
| `mfs_transactions` | ~8 M | Unpartitioned, never deleted (7-year statutory) |
| `ai_sessions` | ~20 M | Partitioned by month, 12-month retention (PDPA minimisation) |

### 5.2 Indexing principles

1. **Every index on a tenant table leads with `tenant_id`.** RLS adds `tenant_id = …` to every
   plan; a leading-column match turns a filter into a seek.
2. **Covering indexes for the hot reads.** The attendance grid, the teacher's day view and the
   guardian dashboard each get one `INCLUDE`-covering index sized to serve from index-only scans.
3. **BRIN, not B-tree, for append-only time columns** on partitioned tables — 200× smaller.
4. **Partial indexes for queue-shaped tables** (`WHERE status = 'pending'`) — the `sms_outbox`
   index stays kilobytes even as the table reaches 30 M rows.
5. **GiST + `btree_gist` exclusion constraints** to make teacher/room double-booking
   *structurally impossible* — see [02-RMS-DEEP-DIVE.md](02-RMS-DEEP-DIVE.md) §4.

Full DDL: [`db/migrations/`](../db/migrations/), index strategy in `011_indexes_and_partitions.sql`.

---

## 6. AI architecture

### 6.1 Two engines, one gateway

| | **SikhokAI** (শিক্ষক — teacher co-pilot) | **ShikhoAI** (শিখো — student tutor) |
|---|---|---|
| Model | Claude Opus 5 for generation, Haiku 4.5 for classification/routing | Haiku 4.5 default, Opus 5 escalation on `hard` intent |
| Job | NCTB-compliant CQ generation (উদ্দীপক + ক/খ/গ/ঘ), MCQ set randomisation, rubrics, lesson plans, script pre-grading assist | Socratic tutoring in বাংলা / English / Banglish, never gives the final answer |
| Grounding | RAG over NCTB textbook + board question corpus, hard-bounded | Same corpus, scoped to the student's class & subject only |
| Output | Structured JSON validated against a schema, then rendered | Streamed SSE tokens |
| Guardrail | Curriculum-boundary check + duplicate-detection against the school's item bank | Answer-leak detector, age-appropriateness, self-harm/abuse escalation |

### 6.2 RAG pipeline

```
NCTB PDF (class 6–12, all streams, Bangla + English version)
   │ ingest (offline, one-time per curriculum revision)
   ├─ layout-aware extraction (chapter → section → paragraph, tables preserved)
   ├─ chunk: 700 tokens, 120 overlap, never crossing a chapter boundary
   ├─ embed: multilingual-e5-large (handles Bangla natively) → 1024-dim
   └─ store: pgvector, HNSW index, metadata { class, subject, chapter, board, stream, lang }

Query time (SikhokAI CQ generation):
   1. Hard metadata filter FIRST  (class=9, subject=physics, chapter=5)   ← non-negotiable
   2. Hybrid retrieve: HNSW cosine top-40  ∪  tsvector BM25 top-40 (Bangla config)
   3. Reciprocal-rank fusion → top-12
   4. Cross-encoder rerank → top-6, ~4 200 tokens of context
   5. Generate with schema-constrained output
   6. Post-validate: does every generated part cite a retrieved chunk id? If not → regenerate once → else fail closed
```

**Why the metadata filter comes first:** a Class 9 physics CQ that quietly pulls from the Class
11 chapter is worse than no CQ at all — it destroys teacher trust in one shot. The vector search
never sees out-of-scope chunks.

### 6.3 Guardrails & privacy

- **PII redaction before egress.** A deterministic redactor replaces student names, roll numbers,
  NIDs, phone numbers and addresses with stable pseudonyms (`STUDENT_A`) before any prompt leaves
  the BD VPC; the response is re-hydrated on the way back. NID/BRC values are *never* eligible for
  inclusion in a prompt at all — enforced by a field-level allowlist, not a denylist.
- **Answer-leak guard (ShikhoAI).** When the student's question matches an active exam item in the
  tenant's item bank (embedding similarity > 0.86), the tutor refuses and offers concept help.
- **Escalation path.** Self-harm, abuse-disclosure or exam-cheating signals raise a
  `ai.safeguarding_flag.v1` event routed to the Principal's queue, never auto-messaged to guardians.
- **Cost metering.** Per-tenant monthly token budget enforced in the gateway with a Redis
  token-bucket; at 80 % the Principal gets a notice, at 100 % SikhokAI degrades to
  template-only generation and ShikhoAI to a cached-FAQ mode. No surprise invoices.
- **Full prompt/response audit** in `ai_sessions` with a 12-month TTL, exportable per-subject
  for the PDPA data-subject-access right.

### 6.4 Offline AI behaviour

There is no on-device model. Instead:

- SikhokAI **pre-generates** — a teacher queues "make me a 50-mark Class 9 Physics CQ paper"
  while on wi-fi at school; the result lands in IndexedDB and is fully usable offline.
- ShikhoAI ships an offline **cached-explanation pack** per chapter (~40 KB of pre-written
  Bangla explanations for the 20 most-asked concepts), and clearly states it is in offline mode.

---

## 7. Security & compliance

### 7.1 Field-level encryption (PDPA 2026 / CA 2023)

NID, Birth Registration Certificate number, guardian NID and bank account numbers use
**application-side envelope encryption**, not `pgcrypto` in-query (which leaks plaintext into
`pg_stat_statements` and WAL).

```
KMS (in-country HSM-backed) holds the Key Encryption Key (KEK), rotated annually
  └─ per-tenant Data Encryption Key (DEK), AES-256-GCM, rotated on demand
       └─ ciphertext stored as:  bytea = nonce(12) || ciphertext || tag(16)
          alongside:  key_version smallint,  blind_index bytea
```

`blind_index = HMAC-SHA256(tenant_pepper, normalize(plaintext))` — gives exact-match lookup
("is this NID already registered?") without decryptability. Indexed; the plaintext column
never exists.

Decryption is a privileged operation: only `identity-svc` holds DEK-unwrap permission, every
unwrap writes to `audit.pii_access` with actor, purpose code and legal basis.

### 7.2 Authentication

| Actor | Primary factor | Second factor | Session |
|---|---|---|---|
| Student | Roll + PIN, or school-issued QR badge | — | 30 d refresh, device-bound |
| Teacher | Phone + OTP (SMS) or password | TOTP optional, mandatory for Coordinator+ | 12 h access, 30 d refresh |
| Guardian | Phone + OTP | — | 30 d, one active device (SIM-swap-aware) |
| Principal / Owner | Password + TOTP **mandatory** | — | 8 h, IP-pinned session option |
| Accountant | Password + TOTP mandatory | Step-up TOTP for any disbursement | 4 h |
| Super Admin | SSO + hardware key (WebAuthn) | — | 2 h, break-glass audited |

Access tokens are EdDSA-signed JWTs, 15-minute TTL, with refresh rotation and reuse detection.
Because guardians are often on shared or borrowed phones, guardian sessions are additionally
bound to a device fingerprint and can be revoked from the school's admin panel in one tap.

### 7.3 Threat model highlights

| Threat | Control |
|---|---|
| Cross-tenant data access | RLS + `FORCE RLS` + CI tenancy suite + namespaced cache/storage |
| Stolen teacher phone → mark tampering | Published results are immutable; corrections create signed `mark_corrections` rows requiring Coordinator approval |
| MFS callback forgery | Signature verification + amount/order reconciliation against our own record + idempotency on `gateway_txn_id` (see [03-API](03-API-SPECIFICATIONS.md) §2.4) |
| SMS-flood cost attack | Per-tenant daily SMS cap, per-guardian rate limit, absence-SMS deduped per student per day |
| Prompt injection via student input | ShikhoAI runs with a hardened system prompt, no tool access, and output-side leak detection |
| Insider PII export | `audit.pii_access` + volumetric alerting (>50 decrypts/hour/actor pages the DPO) |
| Ransomware | PITR WAL archiving to a separate account, 35-day window, monthly restore drill |

### 7.4 Compliance posture

- **Data minimisation:** NID collected only where a board/MPO process legally requires it;
  optional at enrolment for classes 1–5.
- **Retention:** student academic records 10 years (board requirement); attendance 5 years;
  AI logs 12 months; SMS logs 90 days; auth logs 24 months.
- **Data-subject rights:** export (JSON + PDF) and erasure endpoints per student/guardian, with
  a legal-hold flag that blocks erasure of board-mandated records and returns a documented reason.
- **Breach notification:** automated 72-hour clock started by any `security.incident.v1` event,
  with a pre-drafted DPO notification template.
- **Consent:** guardian consent for SMS and for AI-tutor usage captured at enrolment, versioned,
  withdrawable in-app.

---

## 8. Performance & resilience budgets

| Metric | Target | Enforcement |
|---|---|---|
| Critical-path JS | ≤ 180 KB gz | CI bundle-size gate, fails the build |
| Bangla font payload | ≤ 42 KB (subset: Bengali + Latin + digits, WOFF2) | `unicode-range` split, preloaded |
| Attendance save (offline) | ≤ 60 ms perceived | Outbox write only; no network |
| `/sync/push` p99 | ≤ 400 ms @ 500 rps | Go service, single INSERT…ON CONFLICT batch |
| `/sync/pull` payload | ≤ 20 KB gz for a daily teacher pull | Field-diff + cursor |
| SMS dispatch latency | p95 ≤ 90 s from attendance save | BullMQ priority queue |
| Availability | 99.5 % monthly (school hours 07:00–17:00 BST: 99.9 %) | Multi-AZ, read-replica failover |
| RPO / RTO | 5 min / 30 min | Streaming replica + PITR |

**Graceful degradation ladder** — when the backend is unreachable the app does not show an error
page; it drops through: live data → IndexedDB working set → cached shell + "offline, N changes
queued" banner. Attendance, grading, routine viewing and lesson-plan reading all remain fully
functional at the bottom rung.
