# 12 — Production runbook

What an operator needs when a real school is on the system: how the
environments are separated, what to do when something breaks, and which of
these procedures have actually been exercised.

Written during R-8. **Read §0 first** — a runbook whose reader believes more
has been tested than has been is worse than no runbook.

---

## 0. What has been exercised, and what has not

This is not a disclaimer. It is the most important section, because every
procedure below reads identically whether it has been rehearsed or merely
written down, and the difference matters at 08:00 on a Sunday.

| Procedure | State |
|---|---|
| Onboarding a school through the console | **Exercised.** Two institutions, end to end, no SQL — R-7 completion pass |
| Five-role login and attendance | **Exercised.** Same pass |
| Cross-tenant refusal | **Exercised.** Reads, writes, header and URL manipulation |
| Student-cap refusal and recovery | **Exercised.** Refused, nothing partial written, cap raised, import completed |
| SMS through a provider adapter | **Exercised against a FAKE aggregator** (localhost). No real aggregator has ever been called |
| Delivery reports | **Exercised against the fake aggregator** |
| Web push | **Exercised against a fake push service**, decrypted end to end. No real push service (FCM/Mozilla/Apple) has ever been called, and no real browser has completed `pushManager.subscribe()` |
| Backup and restore | **NOT exercised.** No production database exists |
| Monitoring and alerting | **NOT built.** See §7 |
| Production deployment | **NOT performed.** No production environment exists |
| A pilot school | **None.** No real institution has used this system |

Everything below marked ⚠ has never been run against production.

---

## 1. Environments

Three, and they are separated by **credentials, not by code**. There is one
codebase and one build; what differs is the environment a deployment is given.

| | Database | Platform console | SMS | Push | Domain |
|---|---|---|---|---|---|
| **Development** | local Docker `pgvector/pgvector:pg16` | `local-acceptance-key` | stub provider (logs) | fake service | `127.0.0.1:4174/4175` |
| **Staging** ⚠ | its own Neon branch | its own key | **allowlist**, see §3 | own VAPID pair | its own hostname |
| **Production** ⚠ | Neon main | its own key | real aggregator | own VAPID pair | `shikhonbd.com` |

### The separation rules

1. **No credential is in the repository.** `scripts/check-secrets.mjs --history`
   walks every commit and fails the build on credential material. It has been
   run on all 134 commits and reports clean.
2. **No secret reaches the browser.** The bundles are checked for every secret
   name; the only hit is the string `PLATFORM_API_KEY` as a *form label* on the
   operator sign-in screen. The operator types the key; it lives in memory for
   the session and is never persisted.
3. **A staging credential cannot reach production** because nothing in the
   repository names either. Both are supplied by the host's environment.
4. **The runtime role is not the owner.** `assertRlsEnforced` refuses to start
   if `DATABASE_URL` connects as a role with `BYPASSRLS`. Verified: neither
   `shikhon_app` nor `shikhon_platform` has `BYPASSRLS` or `SUPERUSER`.

### Preflight, before every deploy

```bash
node scripts/check-secrets.mjs --env
```

Refuses a missing, placeholder or dangerously wrong secret — an owner-role
`DATABASE_URL`, a connection string with no `sslmode`, a `PII_MASTER_KEY_V2`
set without `V1` — and never prints a value.

---

## 2. Domain and tenant access

**What works today:** `/app?tid=<tenant-id>`. This is the address printed on
admission slips and baked into installed PWAs. It is not going away.

**What does not:** `monipur.shikhonbd.com`. R-7 shipped the hostname resolver
and it is unit-tested, but two **deployment** actions remain and neither is
code:

- point `*.shikhonbd.com` at the deployment (wildcard A/CNAME);
- issue a wildcard TLS certificate for it.

Until both are done, set nothing: `WILDCARD_DNS_READY` is unset, the go-live
screen reports subdomains as not ready, and the console shows a school's
subdomain marked **এখনো চালু হয়নি** with the install link presented as the
address to print. Set `WILDCARD_DNS_READY=true` only after a browser has
actually loaded a tenant subdomain over HTTPS.

---

## 3. SMS

### Turning it on, in order

1. Sign the aggregator contract and obtain a sender ID. **Not done.**
2. Set `SMS_PROVIDER=ssl_wireless`, `SMS_ENDPOINT`, `SMS_API_TOKEN`,
   `SMS_SENDER_ID`. Naming a provider without the other three **throws at
   startup** rather than falling back to the stub.
3. **Set `SMS_TEST_RECIPIENTS` first.** A comma-separated allowlist of E.164
   numbers belonging to your own team. While it is set, the dispatcher sends
   only to those numbers and marks every other queued row `suppressed` with
   `error_code = 'not_in_test_allowlist'`. The rows are still written and still
   visible, so a pilot can read exactly what *would* have gone out.
4. Run one real school day with the allowlist on. Read the console's চলমান
   অবস্থা panel and the suppressed rows.
5. Remove `SMS_TEST_RECIPIENTS` only when the messages, the sender ID and the
   audiences are all right.

### Safety already in the product

- The composer shows the **audience size and total message count** before
  sending, computed from the same resolver the publish path uses.
- Above **200 messages** the send button is disabled until the operator ticks
  a box that states the numbers.
- Changing the audience revokes that acknowledgement.
- Emergency notices and login codes are never suppressed by push.
- Per-tenant daily cap (`tenants.sms_daily_cap`, default 2000).
- Dedupe: one SMS per person per notice, per day, forever.
- Weekend and holiday suppression, with the R-4.1 working-weekend override.

### When SMS stops

| Symptom | Look at | Likely cause |
|---|---|---|
| Nothing sends at all | go-live screen → এসএমএস অ্যাগ্রিগেটর | `SMS_PROVIDER` unset — the stub is logging |
| Some recipients only | চলমান অবস্থা → ব্যর্থ / আটকানো | `SMS_TEST_RECIPIENTS` still set |
| Queue growing | চলমান অবস্থা → এসএমএস সারিতে | the cron is not running; check the host's scheduler |
| Individual failures | চলমান অবস্থা → সাম্প্রতিক কারণ | per-code; `INVALID_NUMBER` is data, `HTTP 4xx` is the contract |
| Sent but not delivered | `sms_outbox.delivered_at` | no DLR configured (`SMS_DLR_SECRET`), or the aggregator is not calling it |
| A school says it was texted twice | `sms_outbox.dedupe_key` | should be impossible; a genuine bug — capture the two row ids |

Five attempts, then the row is marked `failed`. There is **no exponential
backoff** — a known limitation.

---

## 4. Web push

`node scripts/generate-vapid-keys.mjs` once per deployment; set
`VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_KEY`. There is no vendor and no contract.

**Rotating the pair invalidates every existing subscription.** Devices recover
only when their owner next opens the app. Rotate on compromise, not on
schedule: the private key signs a 12-hour token addressed to a push service and
grants no access to anything of ours.

⚠ **Not verified against a real push service.** The RFC 8291 encryption is
checked against the specification's own published test vector, and the full
path has been driven end to end against a local push service that decrypted the
result — but FCM, Mozilla and Apple have never seen a message from this code,
and no real browser has completed a subscription handshake. The first contact
is most likely to fail on the `applicationServerKey` encoding.

---

## 5. Backups ⚠ NOT EXERCISED

No production database exists, so none of this has been run.

**What Neon provides:** point-in-time restore within the retention window of
the plan, plus branch-based copies. Neither is configured, because there is no
project to configure.

**Before a pilot school's data lands, all of these must be true and none is
yet:**

- [ ] Automated backup confirmed enabled on the production Neon project, with
      the retention window written down here.
- [ ] **RPO and RTO decided and recorded.** A school's attendance register is
      the most time-sensitive: losing a day of it is losing a day of a legal
      record. A defensible starting point is RPO ≤ 1 hour, RTO ≤ 4 hours.
- [ ] A restore **performed**, into a staging branch, from a backup taken at
      least a day earlier.
- [ ] The restored copy verified by running `db/tests/invariants.sql` and
      `db/tests/schema_lint.sql` against it, and by opening one school in the
      console and confirming its counts.
- [ ] The wall-clock time of that restore recorded, because RTO is a
      measurement, not an intention.

**Restore procedure (untested, written from Neon's documented behaviour):**

1. Create a branch from the target timestamp in the Neon console.
2. Point a **staging** deployment at the branch. Never restore over production.
3. Run the two SQL suites above against it.
4. Compare one school's student and enrolment counts with what the school says.
5. Only then decide whether to promote the branch or copy specific rows.

---

## 6. Monitoring ⚠ NOT BUILT

There is no alerting. This is the largest gap between this system and a
production one, and it is stated plainly rather than described as if it existed.

**What exists:** the console's চলমান অবস্থা panel per school (queue depth,
failures, last login, last attendance, push devices), the go-live readiness
screen, and `audit.activity_log` / `audit.platform_access`. All are **pull** —
somebody has to look.

**What does not exist:** anything that pushes. No error tracking, no latency
metrics, no alert when the SMS queue stops draining, no page when the cron
fails.

**The minimum before a pilot**, in the order it matters:

1. **Cron failure alerting.** If `/api/v1/sms/dispatch` stops running, no
   parent is told anything and nothing anywhere says so. The host's own cron
   monitoring is enough to start.
2. **Uncaught error reporting** from the serverless functions.
3. **A daily glance** at the console's health panel for each pilot school —
   which is a person, not a system, and is honest about being so.

---

## 7. Support and recovery

| Situation | What to do |
|---|---|
| **Somebody cannot log in** | Issue a fresh activation code. Console → the school → সেটআপ চালিয়ে যান for an administrator; inside the school, ব্যবহারকারী → কোড for staff, or শিক্ষার্থী তালিকা → কোড for a student. Codes are single-use, 72 hours, and shown once |
| **Wrong person given a role** | The console refuses an existing phone number until the operator confirms, naming who they are and what they already are. If a role was granted in error, remove it from the school's own ব্যবহারকারী screen |
| **Account locked / too many attempts** | F-102 rate limiting is per phone and per IP, and it expires on its own. OTP is 3/hour per phone. Wait it out; there is no unlock button by design |
| **Import rejected every row** | Read the downloadable error CSV — line, roll, field, reason. The commonest causes are a missing fourth subject from class 9 up, and a class the school has not created |
| **Import refused for the cap** | The message names the cap and the current roll and says nothing was written. Console → প্ল্যান ও সীমা → raise it. The cap cannot be set below the current enrolment |
| **Provisioning stopped half-way** | Nothing is lost: every wizard step commits. Console → the school → সেটআপ চালিয়ে যান, which names the step that is actually missing. The readiness checklist counts real rows, not a stage column |
| **A school must be suspended** | Console → স্থগিত করুন. Reversible; data untouched; login refused |
| **A school is leaving** | Suspend, then archive. **Never hard-delete a tenant with student rows** except through the PDPA erasure path — historical records are the product |
| **Guardian says they got no SMS** | Check `sms_outbox` status for that recipient. `suppressed` + `not_in_test_allowlist` means the allowlist is on; `suppressed` + `delivered_by_push` means push carried it; `failed` carries the provider's code |
| **A notice went to the wrong audience** | It cannot be recalled from phones. The in-app receipts can be removed; the SMS cannot. This is why the composer states the audience and the count |

---

## 8. Pilot checklist

Per school, before the first day:

- [ ] Onboarded through the console; no SQL used
- [ ] Institution type correct on the tenant list (বিদ্যালয় / কলেজ / মাদ্রাসা / স্কুল ও কলেজ)
- [ ] Classes 11–12 have subjects, if it is a college or combined (migration 048)
- [ ] Academic year, grading bands and at least one administrator — the three
      activation gates
- [ ] Principal and IT admin created, codes handed over in person
- [ ] Teachers imported; class teachers assigned to sections
- [ ] Students imported; guardian phone numbers checked
- [ ] Student cap above the actual roll, with headroom
- [ ] Branding: name, colour, head teacher's name
- [ ] `SMS_TEST_RECIPIENTS` still set, containing only your team
- [ ] Install link tested on a real phone on a real mobile connection
- [ ] Attendance taken by a real teacher, and it synced

And record, per school: onboarding start and end time, every step that needed
help, every error message that was misread, the import sizes, and the time to
first attendance. That list is what the R-9 pilot gate is actually waiting for.

---

## 9. Deployment

See [06-DEPLOYMENT.md](06-DEPLOYMENT.md) for the database. For the application:

```bash
node scripts/build.mjs      # PWA + 11 API bundles, committed
npm test                    # 1090 tests
node scripts/check-secrets.mjs --env
```

Vercel and Netlify build from the same sources; `scripts/build.mjs` emits both
sets of function bundles. The Hobby plan caps a deployment at 12 serverless
functions and 11 are in use — one spare.

**Cron:** `vercel.json` schedules `/api/v1/sms/dispatch` and
`/api/v1/ops/maintenance` daily. Both are opt-in on the host and neither runs
in development.
