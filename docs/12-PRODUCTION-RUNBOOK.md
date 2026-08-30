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
| Alert evaluation and delivery | **Exercised locally.** Every condition unit-tested at its boundary; the gather run against a real schema; a firing alert POSTed to a stand-in sink. **No alert has ever reached a human** |
| Service-key hardening | **Exercised.** Browser refusal, rotation slot, production default and the JWT fall-through, probed against the live endpoint |
| CORS origin allowlist | **Exercised in a browser.** Listed origin served, unlisted origin blocked by Chrome |
| The preflight itself | **Exercised.** `node scripts/preflight.mjs` runs and refuses to call this deployment ready |
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
node scripts/preflight.mjs
```

`check-secrets --env` refuses a missing, placeholder or dangerously wrong
secret — an owner-role `DATABASE_URL`, a connection string with no `sslmode`, a
`PII_MASTER_KEY_V2` set without `V1` — and never prints a value.

`preflight.mjs` is the wider checklist: environment variables, secret strength
and distinctness, database separation and TLS, the maintenance and platform
roles, service-key posture, origins, bundles, the manifest and service worker,
cron ownership, SMS credentials and allowlist, VAPID keys, and every external
item. It prints one line per check with its evidence and exits

| code | meaning |
|---|---|
| 0 | everything passes **and** every external item is attested |
| 1 | something FAILED — do not deploy |
| 2 | configuration is complete but something has never been demonstrated |

**Exit 2 is not success.** It is the state this deployment is in today, and it
stays that way until somebody records an outcome in
`docs/production-evidence.json` — with a date, an environment and a result.
That file is the human half of the preflight; the program checks whether the
configuration exists, and a person attests whether the thing actually happened.
Attestations lapse after 180 days, because "we restored a backup successfully"
stops being a fact about the current system fairly quickly.

Do not fill it in from intent. A null there is worth more than a confident
guess, and the whole reason this file exists is that R-8's first report could
have claimed SMS was ready on the strength of a configured provider.

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

## 5. Backups — NOT EXERCISED

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

## 6. Monitoring and alerting

A health dashboard is not monitoring. The console's চলমান অবস্থা panel is a
**pull** surface — somebody has to open it — and at 9pm on a Thursday nobody
does. So R-8 added a **push** half: `/api/v1/ops/monitor`, evaluated on a
schedule, delivering anything firing to `ALERT_WEBHOOK_URL`.

```
*/15 * * * *  ->  POST /api/v1/ops/monitor
                  -> gather platform-wide counts (owner role, counts only)
                  -> evaluate the conditions below
                  -> POST anything firing to ALERT_WEBHOOK_URL
                  -> and log it regardless, so the host's log drain is a
                     working fallback sink from the first deploy
```

`GET` evaluates and returns without delivering — use it to ask "what would
fire right now?" without paging anybody. Both require the service credential
and both refuse a browser.

### What it watches, and what to do

Most of these conditions detect an **absence**, not an error. Loud failures
look after themselves — somebody rings. The dangerous ones are the quiet ones,
where every screen is green and the messages simply stopped.

| Condition | Alert | Investigation path | Recovery |
|---|---|---|---|
| No connection to the database | `database_unavailable` · **critical** | Neon console → the production project → Operations, for a compute suspend or a storage incident; then the host log for the failing query | Suspended compute wakes on the next connection — retry before escalating. If the endpoint moved, update `DATABASE_URL` and redeploy. **Tell schools that ring: attendance keeps working offline and queues; nothing is lost** |
| SMS queued > 0 and the oldest has waited ≥ 2h | `sms_queue_stalled` · **critical** | Did the dispatch cron run? Netlify → Functions → `cron-sms`, or the Vercel cron log. Then `GET /api/v1/ops/health` for per-tenant counts. A stalled head with no failures means the job never fired, not that sending broke | `POST /api/v1/sms/dispatch` by hand with the service key — idempotent per row. If the cron is dead, check `NETLIFY_CRONS_ENABLED` on the host that owns the schedule |
| ≥ 10 failures and > 25% of attempts (critical above 50%) | `sms_failure_rate` · warning → critical | `GET /api/v1/ops/health` lists the top error codes. One repeated code is the aggregator (credentials, balance, sender identity unapproved); a spread of codes is more likely bad numbers in one school's import | Aggregator: fix the credential or top up, then let the next dispatch retry the failed rows. Data: the numbers are wrong and the school must correct them — do not retry into a wall |
| Fewer than 1 month of attendance partitions ahead | `maintenance_cron_stopped` · **critical** | Netlify → Functions → `cron-maintenance`, or the Vercel cron log. `DATABASE_MAINTENANCE_URL` must be the **owner** role on the **direct** endpoint; a pooler URL fails here | `POST /api/v1/ops/maintenance` by hand, **today**. This cannot wait for the morning: when the month turns without a partition, every attendance and SMS write fails at once, for every school |
| > 50% of ≥ 5 push devices failing | `push_failure_rate` · warning | Almost always the VAPID keypair — a changed key invalidates every subscription at once, which is what a jump to near 100% means. Check `VAPID_PUBLIC_KEY` against what the PWA was built with | Nobody misses a message over this: an unaccepted push falls through to SMS, which is why it warns rather than pages. If the keypair changed, browsers resubscribe on their next visit once the key matches |
| ≥ 10 rejected sync ops and > 10% of the batch | `sync_rejection_rate` · **critical** | `sync_operations.conflict_detail` names the reason. R-7 shipped a version where every attendance push was rejected for a malformed academic-year id, and the only symptom a teacher saw was a small "১টি পাঠানো যায়নি" — assume the client is sending something the server will not take, not that teachers are wrong | The operations are still in each device's outbox and will be retried, so a server-side fix recovers them without anybody re-entering a register. Ship the fix, then **confirm the count falls** rather than assuming |
| ≥ 20 exhausted login codes and > 30% of those issued | `auth_anomaly` · warning | Compare the two numbers the alert carries. Many exhausted challenges across **few** phones is one person guessing at one account; across **many** phones it is an SMS delivery problem — people are not receiving the code they are typing. The second is far more common and needs the opposite response | Guessing: the per-phone limiter already refuses further attempts; watch. Delivery: check `sms_outbox` for the `auth.*` messages — this is the SMS alert wearing a different hat |

Thresholds live in `THRESHOLDS` in `packages/server-core/src/alerts.ts`, named
and commented rather than buried as literals, and each is tested at its
boundary. The first real pilot will move some of them.

### What this cannot see

**API failure rate.** There is no table of HTTP responses, and inventing one
would duplicate what the host already records for every invocation. That alert
belongs in the host's own metric alerting — Vercel Observability or Netlify
Analytics, on 5xx rate and function duration — and the monitor reports what
the database can see rather than pretending otherwise.

**Its own death.** A dead function does not report it. The host's
scheduled-function failure notification is what covers that, and it is part of
the monitor rather than hosting trivia: turn it on.

### NEVER DEMONSTRATED

No alert has reached a human. The sink is unconfigured, and until
`ALERT_WEBHOOK_URL` is set and one alert is deliberately provoked and
received, `alert_delivered` in `docs/production-evidence.json` stays null and
the preflight reports monitoring as unverified.

---

## 6a. SERVICE_API_KEY — the widest credential

Presented as a bearer token to `/sync/push` or `/sync/pull` with an
`X-Tenant-ID`, this key makes the caller **any user of any school**. It is not
scoped to a tenant, does not expire, and no RLS policy constrains it — the
point of it is to choose the tenant context that RLS then enforces.

**Blast radius.** With this key alone, a holder can read and write every record
of every school on the deployment: rosters, attendance, marks, fees, guardians'
phone numbers. It is equivalent to the database password for the application
role. It belongs only in the host's encrypted environment store — never in the
repository, never in a browser bundle, never in a support ticket. **If it is
ever pasted into a chat, treat it as burned and rotate.**

**Why it still exists.** It is how an engineer replays a school's stuck sync
batch at 11pm, and how smoke tests reach a deployment before any human account
exists on it. Removing it would not make the product safer; it would make the
first production incident unrecoverable.

**What narrows it** (`packages/server-core/src/service-auth.ts`):

1. **Off in production.** Tenant switching is refused when `NODE_ENV=production`
   unless `SERVICE_KEY_TENANT_SWITCH=on`. Turn it on for the incident; turn it
   off after.
2. **Never from a browser.** A valid key arriving with `Origin`, `Cookie` or
   `Sec-Fetch-Site` is refused with `service_key_from_browser` and logged. That
   combination means the key has leaked into page code, and the refusal turns a
   silent leak into a dated log line. The check fires **only after the token
   matches**, so unauthenticated probes still get their 401.
   *`Sec-Fetch-Mode` is deliberately not a marker: Node's own `fetch` sends it,
   so treating it as one refused the scheduled SMS dispatch. Found by probing
   the endpoint, not by reading the code.*
3. **Loud.** Every acceptance and refusal emits one structured line carrying an
   8-hex fingerprint of the key, never the key. In production a legitimate use
   is rare, so these are an alerting signal.
4. **Constant-time comparison**, so a patient attacker learns nothing from
   timing.

**What it is not.** None of this touches an ordinary user. A logged-in
teacher's token is compared against the key, does not match, and the request
falls through to the JWT path — where tenant, user and role come from the
signature and `X-Tenant-ID` is never read. Verified against the live endpoint:
a teacher's token plus a forged tenant header returns that teacher's own
school, byte for byte.

### Rotation, without downtime

```
1. Generate a new key.
2. Set SERVICE_API_KEY_NEXT to it.        <- both keys now work
3. Move every caller to the new key.
4. Watch the logs: `keyLabel` says which slot each request matched.
   When nothing has matched "current" for a week, nothing uses the old key.
5. Promote - SERVICE_API_KEY = the new value; clear SERVICE_API_KEY_NEXT.
```

Without the second slot, rotating means a window where either the old key still
works or the ops scripts are broken — which in practice means it is never
rotated at all.

The same switch also gates the OTP debug echo (`X-Debug-Otp`), because echoing
a live login code is an account-takeover primitive and belongs behind exactly
the same door.

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

### Subdomain activation, in order

Do not tick these from a DNS dashboard; tick them from a browser.

1. Wildcard A/CNAME for `*.shikhonbd.com` points at the deployment.
2. A wildcard TLS certificate covers it, and a browser shows no warning.
3. `https://monipur.shikhonbd.com` **loads the application**, not a 404 and not
   the marketing page.
4. The slug resolves to the right tenant — the school's own name and colour are
   on the login screen, not another school's and not the platform's.
5. A user of that school can log in there.
6. A user of *another* school cannot see anything of this one from that host.
7. `/app?tid=<tenant-id>` still works, because it is printed on admission slips
   and baked into installed PWAs. **It is not replaced by subdomains; it is
   joined by them.**

Only after 1–7 in a real browser: set `WILDCARD_DNS_READY=true` and record
`wildcard_dns`, `wildcard_tls` and `subdomain_routing` in
`docs/production-evidence.json`. The preflight refuses the flag without the
attestation, precisely so the console cannot promise an operator a subdomain
that does not resolve.

### What to record, per pilot school

Not a summary at the end — a row per school, written as it happens. Half of
these are numbers nobody can reconstruct afterwards.

| Field | Why |
|---|---|
| Onboarding start → end (wall clock) | The only honest source for "how long does onboarding take". R-7's figures were demo tenants and do not count |
| Operator assistance needed, per step | Names the screens that do not explain themselves |
| Every error message that was misread | A message that is technically correct and read wrongly is a defect |
| Import: rows offered, accepted, rejected, and why | Rejection reasons are the import format's real specification |
| First login — who, when, how long after handover | An activation code handed over and never used is the commonest silent failure |
| First attendance — who, when, and whether it synced | The product's actual job |
| Offline attendance — see §8a | The claim most at risk of being untrue |
| First notice, first SMS — audience, count, delivered | Cost and trust, together |
| First result, first invoice, first receipt | The three documents a school judges the product by |
| Search and history use, unprompted | What people reach for when nobody is watching |
| Every support contact, verbatim | The support log is the roadmap |

That list is what the R-9 pilot gate is actually waiting for.

---

## 8a. The offline test, exactly

At least one real institution must do this, on a real phone, on real mobile
data — not a throttled dev tools profile:

```
online -> open a section -> turn the connection OFF
       -> take the full register
       -> reload the page, and continue
       -> turn the connection ON
       -> wait for the sync indicator to settle
       -> a second person checks the server data from another device
```

Verify: every child's mark present, none duplicated, none silently dropped,
and the totals match what the teacher entered. **A rejected operation is not a
sync failure the teacher will see** — R-7 shipped a version where the whole
batch was rejected and the only symptom was a small "১টি পাঠানো যায়নি". So
check the server, not the phone.

Until this has happened at a real school, offline production-readiness is not
claimed anywhere: `pilot_offline` stays null and the preflight says so.

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
