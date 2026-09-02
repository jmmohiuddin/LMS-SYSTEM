# Final Owner-Level SaaS Operations Audit

**Date:** 2026-09-02 · **Repository state:** migration 064, commit `2ebd5b1`, after M1/M6
**Method:** 30 investigating agents over 22 areas, a runtime entitlement probe against a live
stack, six adversarial verification passes instructed to *refute*, and a completeness critic.
Plus direct verification by the lead auditor of every verdict-changing claim.
**Status vocabulary:** PASS · PARTIAL · MISSING · BLOCKED · NOT OBSERVED

> The question this audit answers: *if 10, 50, 100 and eventually 500 institutions become
> customers, can the platform owner operate the entire business safely without SQL, manual
> database work, or engineering intervention for normal operational tasks?*

---

## 1. Executive summary

**The platform-operations layer is far better than the product layer beneath it.**

The commercial machinery the owner asked about — suspend a school, disable one service,
close one portal, grant grace, record a payment, cap students — **exists, is audited, is
enforced by the database rather than the UI, and was observed refusing live HTTP requests.**
That is a genuine achievement and it is rare. The refusal reason is Bangla at the database
layer (`app.tenant_access(...)` returns `reason_bn`), not bolted on in the front end. No
entitlement anywhere is frontend-only.

**But a freshly provisioned school cannot run a school term**, and that finding outranks
everything else in this report. Four things a Bangladeshi institution must do have **no
writer anywhere in the product**:

| Workflow | Writers in production code | Writers in SQL functions | Rows across 112 tenants |
|---|---|---|---|
| Create an exam | 0 | 0 | 5 (test fixtures) |
| Set a fee amount (`fee_structures`) | 0 | 0 | **0** |
| Create a routine (`routines`) | 0 | 0 | **0** |
| Create a room (`rooms`) | 0 | 0 | **0** |
| Record a payment | 1 (MFS webhook only) | — | 1 receipt |

*Verified directly by the lead auditor: `grep -rn "INSERT INTO <table>" services/ packages/`
excluding tests, and `pg_get_functiondef` across every `app.*` function in the live database.*

A school onboards successfully, imports students, and takes attendance. Then it stops. It
cannot examine, cannot bill, cannot timetable, cannot issue a receipt. The exam→grade→GPA→
rank→publish chain is fully built and tested and is unreachable because no exam can be
created. The monthly invoice run joins `fee_structures` and therefore produces zero invoices
forever.

**Three further findings would each be a serious incident on their own:**

1. **Production schedules nothing.** `deploy/` contains one systemd unit and it is a plain
   web process. The only crons in the repository are in `vercel.json`, and production is a
   VPS. So SMS dispatch, partition maintenance and the alert monitor are not scheduled in
   production by anything in-tree.
2. **Five of the seven alerts cannot fire on a total outage** — they are ratio conditions. A
   deployment where SMS, sync, push and logins all stopped dead evaluates to an empty alert
   list. And `ALERT_WEBHOOK_URL` is unset, so nothing reaches a human anyway.
3. **Three commercial controls report success against a school that does not exist.**
   `POST /opsstate`, `/portal` and `/grace` returned **200 OK** for tenant `1111…`, which has
   zero rows in `tenants` — and wrote three audit entries for operations that never occurred.

**Verdict in one line:** the owner can *operate* the business; the customer cannot yet *use*
the product for a full term. Fix the four missing writers before anything in this report.

---

## 2. Platform admin capability matrix — **PARTIAL**

22 sub-routes on one dispatcher ([index.ts:135-178](services/platform-svc/api/index.ts:135));
the last path segment is the route key, unknown segments 404.

| Operation | See | Filter | Act | Audited | Reversible | Confirm | Tenant feels it | Verdict |
|---|---|---|---|---|---|---|---|---|
| Create | ✅ | ✅ | `POST /tenants` | ✅ | archive | wizard | ✅ | PASS |
| Activate | ✅ | ✅ | `POST /status` | ✅ | ✅ | ❌ none | ✅ | PARTIAL |
| Suspend | ✅ | ✅ | `POST /status` **and** `/opsstate` | ✅ | ✅ | legacy ❌ / ops ✅ | ✅ observed | PARTIAL |
| Reactivate | ✅ | ✅ | both | ✅ | ✅ | partial | ✅ | PARTIAL |
| Maintenance | ✅ | ✅ | `POST /opsstate` | ✅ | ✅ | ✅ | ✅ observed | PASS |
| Limited / read-only | ✅ | ✅ | `POST /opsstate` | ✅ | ✅ | ✅ | ✅ observed | PASS |
| Archive | ✅ | ✅ | `POST /status` (**no button**) | ✅ | ✅ | ❌ | ✅ | PARTIAL |
| Delete / soft-delete | — | — | **none** | — | — | — | — | MISSING *(deliberate)* |
| Rename | ✅ | ✅ | **none** | — | — | — | — | **MISSING** |
| Slug | ✅ | ✅ | **none** | — | — | — | — | **MISSING** |
| Institution type | ✅ | — | **none** | — | — | — | — | **MISSING** |
| Contact / EIIN / district | ✅ | — | **none** | — | — | — | — | **MISSING** |
| Branding | ✅ | — | `POST /branding` | ✅ | ✅ | — | ✅ | PARTIAL *(wizard-only route in)* |
| Academic year | — | — | **none at platform** | — | — | — | — | MISSING *(tenant-side only)* |

**The identity half is SQL-only.** No code anywhere writes `tenants.name_bn`, `slug`, `eiin`,
`district`, `upazila`, `address_bn`, `stream`, `level` or `deleted_at` after creation
(`grep -rn "UPDATE tenants"` returns only settings/branding/plan/status writes). A school that
registers with a typo in its name is stuck with it until an engineer opens psql. At 100
schools this will happen; it is not an edge case.

**Two independent suspension mechanisms exist and reversing one does not reverse the other.**
`tenants.status='suspended'` (detail screen) and `tenant_operations.ops_state='suspended'`
(Operations drawer) both yield `access='none'` ([052:135-136](db/migrations/052_platform_enforcement.sql:135)),
but `/opsstate` never touches `tenants.status`. The console detects the disagreement and
*warns* rather than resolving it ([platform-ops.ts:1054](apps/pwa/src/platform-ops.ts:1054)).

**Success on a school that does not exist — verified by the lead auditor.**

```
POST /api/v1/platform/opsstate {tenantId: 1111…}  -> 200
POST /api/v1/platform/portal   {tenantId: 1111…}  -> 200
POST /api/v1/platform/grace    {tenantId: 1111…}  -> 200
POST /api/v1/platform/service  {tenantId: 1111…}  -> 400   (saved by input validation, not by design)

SELECT count(*) FROM tenants          WHERE id='1111…' -> 0
SELECT count(*) FROM tenant_operations WHERE tenant_id='1111…' -> 0
```

and the audit trail now permanently holds:

```
ops_state=suspended    | tenant=1111… | reason=audit probe non-existent tenant
portal teacher=closed  | tenant=1111… | reason=audit probe
grace_until=2026-12-31 | tenant=1111… | reason=audit probe
```

The endpoints `UPDATE … WHERE tenant_id = $1` on the platform pool with **no `rowCount`
check** ([index.ts:1287](services/platform-svc/api/index.ts:1287) and three siblings;
`grep -n rowCount` on that file returns nothing). The fix shape is already in this codebase:
migration 053 gave `app.set_student_cap` `IF NOT FOUND THEN RAISE EXCEPTION 'no such tenant'`
for precisely this reason, and its own header describes the bug. It was applied to one
endpoint and not to these three.

---

## 3. Billing, service and portal controls — **PARTIAL**

### The model

Two axes, not one lifecycle:

- `tenant_ops_state` = `active | maintenance | limited | suspended` — operator-set.
- `tenant_status` = `trial | active | suspended | archived` — legacy, still honoured.
- `billing_state` = `trial | active | grace_period | limited` — **derived** by
  `app.tenant_billing_state()` from `trial_ends_on`, `next_due_on`, `grace_until`,
  `plans.grace_days`.

`app.tenant_access(tenant, role, service)` composes them and returns
`(access, ops_state, billing_state, reason_bn, until)`. The Bangla refusal lives in the
database. `withTenant` calls it on **every request** and fails closed.

### Runtime entitlement matrix

Probed with real HTTP against a live stack across five states. `R` = representative read,
`W` = representative write.

| Surface | active | grace | limited (unpaid) | suspended | maintenance |
|---|---|---|---|---|---|
| Student portal | 200 | 200 | R 200 / W 403 | 403 | 403 |
| Guardian portal | 200 | 200 | R 200 / W 403 | 403 | 403 |
| Teacher portal | 200 | 200 | R 200 / W 403 | 403 | 403 |
| Principal portal | 200 | 200 | R 200 / W 403 | 403 | 403 |
| IT portal | 200 | 200 | R 200 / W 403 | 403 | 403 |
| Attendance | 200 | 200 | R 200 / W 403 | 403 | 403 |
| Routine | 200 | 200 | R 200 / W 403 | 403 | 403 |
| Results | 200 | 200 | R 200 / W 403 | 403 | 403 |
| Finance | 200 | 200 | **R 200 — see below** | 403 | **R 200 — see below** |
| SMS | 200 | 200 | W 403 | 403 | 403 |
| Notifications | 200 | 200 | R 200 / W 403 | 403 | 403 |
| Documents | 200 | 200 | R 200 / W 403 | 403 | 403 |
| Imports | 200 | 200 | W 403 | 403 | 403 |

**The gate is real and fired on every surface probed.** Read-only mode genuinely refuses
writes (`SET LOCAL transaction_read_only = on` → SQLSTATE 25006, turned back into a Bangla
refusal). No entitlement is frontend-only.

**Three corrections the adversarial pass forced, and they matter:**

1. **A disabled service's data is still served through un-gated siblings.** Disabling
   `attendance` refuses the gated endpoint but `GET /academics/students/history` returned the
   identical attendance record the gate had just refused. Same for finance: a principal reads
   the whole ledger from `/ops/dashboard` and a guardian reads the balance from
   `/academics/ward` under both *limited* and *maintenance*. **Service disable is not
   airtight.** Status: **PARTIAL**, and this is the most important correction in the report.
2. **Every "read_only = 200" cell above was reachable only because the prober minted its own
   JWTs.** A real user of a limited or maintenance school **cannot log in, refresh, or log
   out** — the auth endpoints are themselves gated. So "read-only" in practice means "nobody
   can get in, and whoever is already in keeps working for up to 15 minutes." That is not
   what the console tells the operator it means.
3. **Turning off the `push` service does not stop push.** Only the subscribe/list/delete
   endpoint is gated; the sending path has no service check.

**The commercial model behind the gate is largely inert.** `plans.is_active`,
`plans.trial_days` and `plans.billing_cycle` are written by `POST /plans`, echoed to the
console, audited — and **read by no runtime code at all**. Editing a plan propagates
inconsistently: `services` is live-joined (instant fleet-wide effect), `student_cap` is a
copy that never propagates, `is_active` propagates nowhere. There is **no invoice, no
renewal, no reminder and no dunning for the company's own fee** — and nothing anywhere
computes what a school *owes*. The console can total what was collected only.

**Offline outbox:** an entitlement refusal during sync parks the op as permanently `failed`,
discards the Bangla reason, and no PWA code re-arms it. A teacher who marked attendance while
the school was suspended loses that work silently.

---

## 4. Institution monitoring — **PARTIAL** (13 of 27 metrics)

`app.platform_overview()` returns 28 columns in one query, which is a strong foundation.

**AVAILABLE (13)** — observed returning real values on a live endpoint, thirteen seen
rendered in a browser: total students · total teachers · total guardians · active users ·
last activity · dormant institution · SMS usage · current plan · billing state · enabled
services · enabled portals · onboarding completion · unpaid *(as collected-total only)*.

**PARTIAL (5)** — data exists, not surfaced or incomplete: last successful login · attendance
activity · result publication status · SMS failures · pending work.

**MISSING (6)** — nothing computes it: total staff · inactive users · failed imports ·
storage usage · device count · per-school error rate.

**NOT MEASURABLE (3)** — not recorded at all: sync backlog · last backup indicator ·
notification failures. The last is the sharpest: the monitor reads
`push_subscriptions.last_failure_at` and `failure_count`, **two columns no code in the
repository ever writes**, so `push_failure_rate` is structurally unfireable.

---

## 5. Tenant command center — **PARTIAL**

One institution is split across two surfaces that never compose. The ops drawer answers
*can they work / are they full / are they paid* in about ten seconds and knows nothing about
whether the school is set up or being used; the setup and health facts sit on a separate
provisioning page reached by **closing the drawer and leaving the view**.

| Section | State |
|---|---|
| Overview · Billing · Services · Portals | BACKED |
| People | AVAILABLE-NOT-SURFACED (counts exist in overview) |
| Health | AVAILABLE-NOT-SURFACED — `/platform/health` exists; **the ops console never calls it** |
| Academic · Usage | AVAILABLE-NOT-SURFACED |
| Activity | PARTIAL (`last_active_at` only) |
| Audit | BACKED (per-tenant feed) |
| Support | **NO DATA** — no support path exists at all |

**Recommendation:** do not build eleven tabs. Compose the two existing surfaces into one
drawer and call `/platform/health` from it. That is the whole gap.

---

## 6. Operator security — **PARTIAL, with one CRITICAL**

**What is genuinely strong**, verified by the lead auditor against the live server:

```
x-platform-key only, no JWT   -> 401
JWT only, no key              -> 403
wrong key + valid JWT         -> 403
valid key + valid super_admin -> 200
```

Two independent factors are required. The DB role split (`shikhon_platform` vs
`shikhon_app`) is real. `looksLikeBrowser` refuses a service key presented from a browser.
CORS is closed. `check-secrets` finds nothing.

**CRITICAL — there is no operator account behind the credentials.** A `super_admin` token
minted for `sub=00000000-…dead` and `tid=00000000-…ffff0`, **neither of which exists anywhere
in the database**, returned **111 tenants**.

To be precise and not alarmist: this is *not* "anyone can forge a token" — the private
signing key is still required. It is that the JWT `sub` is never resolved against any table.
Consequences:

- **No individual operator can be disabled.** You cannot deactivate a row that does not exist.
- Revocation is all-or-nothing: rotating the keypair or the API key locks out every operator
  simultaneously. There is no `jti`, no `kid`, no audience claim, no session row.
- MFA is impossible without new work — operators have no `users` row to hang it off.
- **No least privilege.** One role, one check; suspend, price and cap all run on it.
- **Every write is audited; no read is.** An operator can enumerate all schools and open any
  school's SMS spend, guardian data and login history leaving no audit row.

B-10 ("two pasted secrets") is confirmed exactly as written — both shared, both typed into
password fields, both held in `sessionStorage`.

---

## 7. Audit and accountability — **PARTIAL**

Two separate trails. `audit.activity_log` for tenant actions; `audit.platform_access` for
operator actions. Platform actions do **not** appear in `activity_log` (0 rows matching
`platform.%`).

| | Tenant trail | Platform trail |
|---|---|---|
| actor | ✅ `actor_id` + `actor_role` | ⚠️ `admin_id`, **backed by nothing** |
| tenant / action / target | ✅ | ✅ |
| before / after state | ✅ | partial (`statement` free text) |
| **reason (WHY)** | ❌ **no field** | ✅ **required, real values** |
| timestamp | ✅ | ✅ |
| correlation / IP / user-agent | columns exist, **never written** | ❌ |

**B-39 is still true, now with numbers** (lead auditor): `audit.platform_access` holds
**1,959 rows across 6 distinct `admin_id`s**; there is **no platform-operator table anywhere**
(`information_schema` match = 0); `admin_id` has **no foreign key**; and the sampled uuid
resolves to **0 rows in `users`**.

**The key test — can the audit viewer distinguish two operators? No.** The adversarial pass
reproduced it: two distinct super_admin tokens produced **md5-identical 17,461-byte
responses**. The API strips the actor before the payload leaves the server.

Worse, the verifier found that **an operator can forge another operator's actor id** through
`app.log_platform_action`. And read-time redaction covers phone/email/credential key names
but **not personal names** — real audit rows store a student's and a guardian's name in
plaintext.

---

## 8. Onboarding — **PARTIAL**, steps 15–16 impossible

Steps 1–14 and 17–19 are genuinely self-service. Machine time for steps 1–8 was measured at
**0.59 s**; the human time is dominated by typing and by waiting for people to redeem
activation codes.

| Step | Classification |
|---|---|
| 1–4 create · branding · year · hierarchy | SELF-SERVICE |
| 5–6 import students / teachers | SELF-SERVICE ⚠️ *(rows carrying a birth-registration number are rejected outright when the PII key is absent)* |
| 7–8 principal · IT admin | SELF-SERVICE |
| 9–11 services · portals · billing | OPERATOR-ONLY (correct) |
| 12 activate users | PARTIAL — **no UI moves `invited` → `active`**; only self-redemption does |
| 13–14 guardians · calendar | SELF-SERVICE |
| **15 routine inputs** | **MISSING** — no UI for rooms, competencies, per-week period counts, period definitions; and the teacher picker is empty because imported teachers are `invited`, not `active` |
| **16 generate first routine** | **ENGINEER-ONLY** — nothing anywhere creates a `routines` row |
| 17–19 publish · notice · dashboards | SELF-SERVICE *(publish unreachable without 16)* |

`scripts/r7-acceptance.mjs`, the documented end-to-end walk, **fails at the activate stage**
against the current API and has done since P7.

**Honest estimate:** ~45–75 minutes to a school that can take attendance. **Unbounded** to a
school that can run a term, because four workflows have no writer at all (§18).

---

## 9. Offboarding — **PARTIAL**

Stopping access is real and enforced per request. Everything else is missing.

- **No offboarding process is documented anywhere.**
- **Tenant suspension never revokes a session row.** M1 added revocation for *user*
  deactivation; tenant suspension did not get it. So restoring a school silently re-arms
  every 30-day refresh token, and months-old queued SMS flush to parents.
- No billing closure. No archive control in the console (the status exists; no button emits
  it). No retention policy. No export (§10).
- A school returning after six months comes back to whatever state it left, plus a queue.

Data preservation itself is sound and deliberate — `archived`, never deleted.

---

## 10. Data export — **MISSING** (unqualified)

There is **no export feature anywhere in shikhonBD.** Not one CSV endpoint, not one download
button, no platform-operator tenant export, no offboarding step that returns data. Six
candidate sub-routes were probed against all nine tenant dispatchers and the platform
dispatcher: all 404 from the route table.

| Data | Status |
|---|---|
| Students · teachers · guardians · structure · attendance · results · fees · notices · audit | **MISSING** |
| Documents | PARTIAL — printable HTML/PDF, per record |

Two details sharpen it: `toCsv()` exists and has exactly **one** caller — the *error* list
for a failed import, the only file the product ever hands a school. And the
`attendance_sheet` document contains **no attendance data**; it is a blank grid for a teacher
to fill in by hand.

**Erasure is engineered and tested; portability is not.** For a SaaS selling to institutions
that will one day leave, this is the clearest customer-trust gap in the product.

---

## 11. Backup, restore, disaster recovery — **PARTIAL**

Genuine production evidence exists for both backup configuration and one restore drill —
correctly recorded in `production-evidence.json` as `verified`.

| | State |
|---|---|
| Frequency / retention | daily `pg_dump -Fc` 02:30, 14 days — PASS |
| **Encryption** | **MISSING** — unencrypted, and written to the same host that runs the database |
| Restore procedure | PASS (written, executed once) |
| Restore verification | PARTIAL — compares **counts**, not RLS **behaviour** |
| RPO / RTO | ~24 h RPO (runbook's own target is ≤1 h); RTO 4.0 s on 2.6 MB |
| **Post-restore tenant isolation** | **NOT OBSERVED** — never behaviourally tested |
| **Schema-version gate** | **MISSING** — a 048 dump under 064 code fails silently at deploy and loudly at request time |
| **Backup monitoring** | **MISSING** — if the 02:30 cron stopped, nothing would notice |

The backup script itself is **not in the repository** — it exists only on the VPS.

---

## 12. Background jobs — **PARTIAL, with CRITICAL gaps**

| Job | Scheduled where | Would we know if it stopped? |
|---|---|---|
| SMS dispatch | `vercel.json` only | **NO** |
| Partition maintenance | `vercel.json` only | Only after ~3 months |
| Alert monitor | Netlify bundle only, gated off by default | **NO** |
| ANS dispatcher | **nowhere** | **NO** |
| Backup | VPS crontab, not in repo | **NO** |

**Production runs none of these schedulers.** `deploy/` holds one systemd unit
(`shikhon-web.service`) and it is a plain `Type=simple` web process — no timer, no
`OnCalendar` (lead-auditor verified).

- **No heartbeat exists.** Nothing records when any job last ran; every stoppage must be
  inferred from a side effect.
- **A stopped SMS worker is invisible.** `sms_queue_stalled` requires `smsQueuedNow > 0`, but
  the only producer of those rows is the worker that has stopped.
- **A single poison event silently kills a tenant's whole SMS run, every night, forever**, and
  the endpoint still answers `200 ok:true`.
- SMS dispatch enumerates tenants from a hand-maintained comma-separated env var. A newly
  onboarded school gets no SMS, ever, until someone edits it — and the variable is
  undocumented in the production env template.
- No manual replay path and no dead-letter surface for terminally `failed` SMS rows.

---

## 13. Alerting — **PARTIAL**

Seven conditions exist and evaluate correctly. The delivery mechanism works
(`scripts/alert-rehearsal.mjs`, 7/7). Neither fact helps in production.

**Five of the seven are ratio or floor conditions that a total outage cannot trip.** A
deployment with zero sends, zero syncs, zero logins and a 4,000-device push fleet over 24 h
evaluates to **an empty alert list**. There is no heartbeat and no all-clear, so a silent
sink and a healthy deployment are indistinguishable.

| Proposed alert | Feasibility |
|---|---|
| Database unavailable | **EXISTS** |
| SMS pipeline stopped · queue stuck | POSSIBLE WITH A NEW SIGNAL (watch `event_outbox`, add a heartbeat) |
| Notification pipeline stopped | POSSIBLE WITH A NEW SIGNAL (nothing writes the failure columns today) |
| Backup failure | POSSIBLE WITH A NEW SIGNAL (needs a heartbeat row) |
| Migration failure | POSSIBLE WITH A NEW SIGNAL (needs a ledger) |
| **Repeated tenant isolation failure** | **NOT MEASURABLE** — no refusal is persisted anywhere |
| High SMS failure rate · payment overdue · dormant institution | EXISTS or trivially derivable |
| High sync backlog · repeated import failures | POSSIBLE WITH A NEW SIGNAL |

The tenant gate fails closed with a bare `catch` and **no logging**, so a broken gate would
block every school with zero signal for any alert to read.

---

## 14. Scale — **PARTIAL**

The prior audit's *1.36 s at 79 tenants* no longer reproduces: it is **0.45 s at 111** today.
But its linear model was wrong in a way that matters.

| Bottleneck | Evidence | Trigger threshold |
|---|---|---|
| `app.platform_overview` seq-scans the whole `users` table **once per tenant** | EXPLAIN loop counts | **~50 real tenants** |
| `user_sessions` scan, same defect, worse — a row is INSERTed on every 15-min refresh | no covering index on `tenant_id` | **~60 days of real sessions** |
| `app.tenant_access` is **2.3× the users scan** today — the dominant cost | verifier's plan analysis | ~50 tenants |
| ~380 ms JIT tax per overview call | 1000-row default estimate on the SECURITY DEFINER LATERAL | **already firing at 5 tenants** |
| No pagination on any cross-tenant surface | server *and* client | ~100 tenants |
| Pools of 5 (runtime) and 3 (platform) on one Node process | p50 35 ms → 771 ms from 1 → 100 concurrent; plateau ~95 req/s | ~100 concurrent users |
| SMS dispatch: serial, inside one HTTP request, env-var tenant list | — | **~10 tenants** |

The overview is **quadratic in tenants**, not linear. The verifier also found the survey
overstated its proposed remediation by ~4× by dropping the LATERAL from the comparison — so
treat the fix sizing as unmeasured.

---

## 15. Role dashboard gaps — **PARTIAL**

| Role | Dashboard | Biggest gap |
|---|---|---|
| Platform | real | TECHNICAL ISSUE not derivable; no support view |
| Teacher | real | — |
| Student | real | — |
| **Principal** | real | **teacher absence absent** — the school's own API reports `away: 1` today while `/ops/dashboard` has no such field |
| **IT Admin** | **none** | lands on a static six-tile grid **although `/ops/dashboard` already serves this role** |
| **Guardian** | **none** | the one dynamic block is student-shaped and empty by construction |
| Accountant, Coordinator | **none** | static grid |

M6 shipped the teacher register but did not surface it on the principal's dashboard; on a
phone it is two taps behind the আরও menu. **No tenant role has any operational-alert
surface** — SMS queue depth and delivery failures are visible only to the platform operator.

---

## 16. Guardian / contact model — **PARTIAL**

**The critical check passes.** The guardian phone is nulled **server-side** at
[guardians.ts:283](services/ops-svc/api/guardians.ts:283) and was observed absent from live
HTTP bodies for `class_teacher`, `subject_teacher` and `dept_head`. Never frontend hiding.
Migration 050's single RESTRICTIVE policy still closes the revoked-guardianship read paths.

Three defects, one introduced by 064's own repair:

1. **`PATCH /ops/guardians` can now resurrect a revoked guardianship.** 064 fixed the
   conflict target; it did not exclude revoked rows from the update path.
2. **The office cannot tell a revoked link from a live one** — `revoked_at` is not in the
   payload.
3. **`/academics/roster` hands every staff role the student's own phone** with no contact
   gate at all.

**Current class-teacher policy as implemented:** admins see the phone, all teachers get
`null`. Hardcoded; no per-institution setting. The prior audit recommends a knob defaulting
**OFF**. This remains an owner decision.

---

## 17. Smart Routine (P9) prerequisites — **PARTIAL / BLOCKED**

Good news first: **double-period placement IS implemented** (F-504, commit `f820faf`) — the
prior audit was wrong about that.

| Capability | State |
|---|---|
| School · college · madrasa · sections · groups · streams · shifts | SUPPORTED |
| Practical subjects · breaks · substitutions | SUPPORTED |
| Double periods | **SUPPORTED** (correcting the prior audit) |
| Teacher availability | SCHEMA-ONLY until M6; still no writer for recurring unavailability (B-45) |
| Teacher absence | SUPPORTED for substitution; the **solver builds a weekly template**, so date-specific absence does not reach it |
| Working weekends | SCHEMA-ONLY |
| **Rooms** | **MISSING** — no write path anywhere; **0 rooms across 112 tenants** |
| **Routine / period-template creation** | **MISSING** — no API creates a `routines` row |
| **Ramadan schedule** | **BLOCKED** — the swap `uq_routine_active` structurally forbids |
| Routine editor | **BROKEN** — selects `rm.name`, a column `rooms` does not have (proven ERROR) |

**P9 cannot start on four concrete blockers.** They are prerequisites, not P9 scope.

---

## 18. Bangladesh feature gaps — **the headline finding**

| Workflow | State | Class |
|---|---|---|
| Teacher attendance | **BUILT** (M6) | — |
| Academic year rollover · promotion | BUILT | — |
| Exam results (grade→GPA→rank→publish) | BUILT, **unreachable** | — |
| SMS · guardian communication | BUILT, blocked on aggregator | MUST PILOT |
| **Create an exam** | **no writer** | **MUST PILOT** |
| **Set fee amounts** | **no writer** — invoice run yields zero invoices | **MUST PILOT** |
| **Create a routine** | **no writer** | **MUST PILOT** |
| **Record a payment / issue receipt** | MFS webhook only; `POST /finance/pay` → 503 | **MUST PILOT** |
| Receipt numbering | on collision the webhook applies the payment and **silently issues no receipt** | MUST PILOT |
| Class tests | depends on exam creation | SHOULD PILOT |
| Merit / tabulation | depends on exam creation | SHOULD PILOT |
| Transfer certificate | prints; **no register, and the enrolment stays `active`** | SHOULD PILOT |
| Promotion: hold a student back | `detained` is never set by any code path | SHOULD PILOT |
| Student permanent ID | BUILT | — |
| Stipend · board form fill-up · admission | absent | POST PILOT |

**None of the four blocking gaps appears anywhere in `docs/BACKLOG.md`** — the file its own
header calls "the only backlog".

---

## 19. Production readiness — **PARTIAL / NOT OBSERVED**

| Item | Repository | Production | State |
|---|---|---|---|
| Landing page | `496199bd` | `496199bd` | **PASS — byte-identical** |
| Routes | 21 ops routes | 20 deployed | only `ops/staff-attendance` missing |
| Commit | `2ebd5b1` | bounded to a 2.5-day window around `52d1609` | PARTIAL |
| Migration | 064 | **NOT OBSERVED** (048 is a stale record + one corroborating 404) | NOT OBSERVED |
| DNS / TLS | — | apex + `www` valid; `*.sikhon.systems` **NXDOMAIN** | BLOCKED |
| Cron | Vercel/Netlify only | **none in repo for this host** | **MISSING** |
| Backup | — | verified 2026-08-31 | PASS |
| Alerting | wired | `ALERT_WEBHOOK_URL` unset | BLOCKED |
| SMS | stub | no aggregator | BLOCKED |
| Push | keys present | never delivered | BLOCKED |

Two additional findings: **`scripts/preflight.mjs` is structurally unable to pass** against
the deployed architecture (it rejects any `127.0.0.1` DATABASE_URL and any URL without
`sslmode=require`, while `deploy/env.example` — the production template — specifies exactly
that). And **repository HEAD is 12 commits ahead of the only git remote**, so none of the five
push-triggered CI workflows has run on the current tree, including the credential scan.

---

## 20. Documentation consistency — **PARTIAL**

The append-only discipline is real and **no rehearsal is passed off as production evidence** —
that mechanism works. But the two documents an operator or a new engineer would actually
reach for each carry statements that are false in the dangerous direction:

- `12-PRODUCTION-RUNBOOK.md` §0 states **"no production database exists to restore."** False
  since 2026-08-31. Its incident table sends the operator to Neon, Vercel and Netlify consoles
  that do not exist for this deployment.
- `FINAL-FULL-PROJECT-AUDIT-REPORT.md` still presents **M1 and M6 as open, including as risk
  #1**, with no addendum, while the plan, backlog and master plan all record them closed.
- **B-27 is wholly unreconciled**: `06-DEPLOYMENT.md` describes Neon + Vercel with no banner.
- `09-PRD-AUDIT.md` stale since 2026-08-12.

**Minimum changes** (no history rewritten): a reconciliation banner at the top of
`06-DEPLOYMENT.md`; a dated addendum on the audit report pointing to the P-pilot-hardening
entry; correct the runbook's §0 sentence and its incident table; add the four missing writers
to BACKLOG.

---

## 21. MUST / SHOULD / POST-PILOT

### MUST — a pilot cannot run without these

| | Item | Why |
|---|---|---|
| **B1** | Exam creation writer | no exam ⇒ no class test, no merit list, no results |
| **B2** | `fee_structures` writer | no fee ⇒ zero invoices forever |
| **B3** | Payment + receipt writer | a school cannot take money |
| **B4** | Routine creation writer | no timetable; also blocks P9 |
| **B5** | Schedule the crons on the production host | SMS, partitions and alerts are unscheduled |
| **B6** | `ALERT_WEBHOOK_URL` + a non-ratio heartbeat alert | a stopped job is currently invisible |
| **B7** | `rowCount` guard on `/opsstate`, `/portal`, `/grace` | success on a school that does not exist |
| **B8** | Un-gate audit: close the service-disable sibling bypass | disabling a service does not stop the data |
| **B9** | Tenant suspension must revoke sessions | restoring re-arms every token and flushes old SMS |
| **B10** | SMS aggregator contract | external |

### SHOULD — before the pilot grows past ~10 schools

Rename/slug/contact editing · an `invited → active` control · principal dashboard teacher
absence · IT-admin and guardian dashboards · reconcile the two suspension mechanisms ·
confirmation on the legacy suspend path · the unreachable payments confirmation · export
(students, attendance, results, fees) · backup encryption + off-host copy + a heartbeat ·
`/platform/health` in the ops drawer.

### POST-PILOT — with trigger thresholds

Overview quadratic fix and pagination (**~50 tenants**) · session-table index (**~60 days**) ·
connection pooling (**~100 concurrent**) · SMS dispatch parallelism and tenant discovery
(**~10 tenants**) · operator directory and per-operator revocation (**operator #2**) ·
support mode · stipend, form fill-up, admission.

---

## 22. Owner decisions required

1. **The four missing writers.** Confirm they are in scope before a pilot. This audit's view
   is that a pilot without them is a demonstration, not a trial.
2. **M3 tenant URL** — `?tid=` (works today) or subdomains (needs a wildcard record and a
   DNS-01 certificate). Recommendation: `?tid=` for the pilot.
3. **Class-teacher phone policy** — ratify the current hardcoded rule, or approve a
   per-institution knob defaulting OFF.
4. **Operator identity** — accept anonymous operators for now, or build the directory before
   the second operator exists.
5. **B-27** — which architecture is the target: VPS or Neon/Vercel? The docs cannot be
   corrected until this is answered.
6. **Data export** — is portability a pilot commitment or a post-pilot one? It affects what
   you can promise a school in writing.
7. **Backup RPO** — 24 h today; the runbook proposes ≤1 h. Real student data changes this.
8. **PII custody / data residency** (B-21) — still open, still regulatory.

---

## 23. Final recommendation

**Do not start P9.** Not because P9 is wrong, but because four of its prerequisites do not
exist (rooms, routine creation, the Ramadan constraint, a broken editor query), and because a
routine is the fourth-most-important missing writer, not the first.

**Do not start a pilot yet either.** The platform can be operated; the product cannot yet run
a term.

**The order that follows from the evidence:**

1. The four writers (**B1–B4**). Nothing else changes what a school can do.
2. The operational blind spots (**B5–B6**). A stopped job you cannot see is the failure that
   ends a pilot badly.
3. The three integrity defects (**B7–B9**). Each is small and each is the "returns success,
   does nothing" pattern this project keeps meeting.
4. Then P9, whose prerequisites B4 partly delivers.

---

## Final owner verdict

**1. Can one operator safely run 100 schools?**
**Not yet — but closer than expected.** The controls exist and are enforced. Blocking: no
pagination or sort on a 100-row list, an attention queue that flags 103 of 110 institutions,
a quadratic overview, no per-operator identity or revocation, and three controls that report
success against schools that do not exist. Safety is good; *scale ergonomics* are not.

**2. Can one operator understand every school's health?**
**PARTIAL.** 13 of 27 metrics are on a screen. The operator cannot see technical health at
all — `/platform/health` exists and the ops console never calls it.

**3. Can we turn individual services on/off per school?**
**Yes, with one important caveat.** The toggle is real, audited and was observed refusing
live requests. But a disabled service's data is still readable through un-gated sibling
endpoints, and disabling `push` does not stop push. **PARTIAL.**

**4. Can we suspend a school safely for non-payment?**
**Yes.** Suspension is enforced database-side on every request, with a Bangla reason. Two
caveats: it does not revoke existing sessions, and two independent suspension mechanisms
exist that do not reverse each other.

**5. Can we recover a school after accidental suspension?**
**Yes** — reversible, audited, immediate. But if the wrong mechanism is reversed the school
stays blocked, and the console warns rather than resolving it.

**6. Can a school operate without engineering help?**
**No.** It can onboard, import and take attendance. It cannot create an exam, set a fee,
produce a routine, or record a payment. This is the finding that matters most in this report.

**7. Can a school generate its first routine easily after P9?**
**Not on the current model.** P9 has four unmet prerequisites, and one of them — routine
creation — is itself a MUST-fix.

**8. Can staff/student/guardian access be revoked immediately?**
**Yes for a user** (M1, verified: 403 `account_not_active`, sessions revoked).
**No for a whole school** — tenant suspension blocks new requests but leaves session rows
live.

**9. Can we know when SMS/alerts/jobs silently stop?**
**No.** This is the most dangerous gap after §18. Nothing schedules the jobs on the
production host, no heartbeat exists, five of seven alerts cannot fire on a total outage, and
no alert has ever reached a human.

**10. What are the ONLY things still blocking the first real pilot?**

1. Exam creation, fee amounts, payment/receipt, routine creation — the four writers.
2. Cron scheduling on the production host.
3. An alert that reaches a human, plus one non-ratio heartbeat condition.
4. The SMS aggregator contract *(external)*.
5. The migration 049–064 catch-up, whose procedure is written and rehearsed but not run.

Everything else in this report can meet the pilot on the way.

---

*Report only. No schema, API, UI or landing-page changes were made. `index.html` verified at
`496199bd` before and after. Three audit rows in the local CI database carry `reason='audit
probe'` from the §2 no-op verification; they are labelled and were left in place because an
audit trail is append-only.*
