# 03 — External Integration & API Specifications

Conventions for every endpoint in this document:

- Base: `https://api.shikhon.bd/v1` · JSON only · UTF-8 · `Asia/Dhaka` for dates, RFC 3339 UTC for timestamps.
- Auth: `Authorization: Bearer <EdDSA JWT>`; the `tenant_id` claim resolves tenancy. Machine-to-machine uses OAuth 2.0 client-credentials.
- Money: **minor units are not used**. Amounts are decimal strings in BDT, e.g. `"1250.00"`. Never floats.
- Idempotency: every mutating endpoint accepts `Idempotency-Key`; replays return the original response with `Idempotency-Replayed: true`.
- Errors: RFC 9457 problem+json.

```jsonc
{
  "type":     "https://api.shikhon.bd/errors/routine-clash",
  "title":    "Teacher already booked",
  "status":   409,
  "detail":   "রহিম স্যার এই সময়ে ৯-খ শ্রেণিতে পদার্থবিজ্ঞান পড়াচ্ছেন",
  "instance": "/v1/rms/routines/rt_018f/slots",
  "traceId":  "01J8XQ…",
  "errors":   [ { "field": "teacherId", "code": "TEACHER_DOUBLE_BOOKED",
                  "conflictingSlotId": "rsl_018e…" } ]
}
```

---

## 1. Sync API (the PWA's lifeline)

### 1.1 `POST /sync/push`

Request bodies are gzip-encoded. Max 25 ops per batch (sized to one 2G MTU window).

```jsonc
{
  "deviceId": "dev_7Kq9…",
  "clientTime": "2026-08-06T03:44:12.881Z",
  "ops": [
    {
      "opId": "018f3a2c-9c11-7c1e-b3aa-2f6d1c0e91aa",
      "seq": 184,
      "entity": "attendance_session",
      "operation": "upsert",
      "occurredAt": "2026-08-06T03:44:12.881Z",
      "baseVersion": 3,
      "payload": {
        "sessionId": "018f3a2c-9c11-7c1e-b3aa-2f6d1c0e91aa",
        "sectionId": "sec_9a", "routineSlotId": "rsl_018f", "subjectId": "sub_phy",
        "takenOn": "2026-08-06", "periodNo": 3, "mode": "period_wise",
        "records": [
          { "studentId": "usr_1001", "status": "present" },
          { "studentId": "usr_1002", "status": "absent" },
          { "studentId": "usr_1003", "status": "late", "minutesLate": 12 }
        ]
      }
    }
  ]
}
```

```jsonc
// 200 — partial success is normal and expected
{
  "serverTime": "2026-08-06T03:44:19.204Z",
  "clockSkewMs": -1840,                      // client should correct future occurredAt values
  "results": [
    { "opId": "018f3a2c-…", "status": "applied",  "rowVersion": 4,
      "sideEffects": { "smsQueued": 1 } },
    { "opId": "018f3a2d-…", "status": "duplicate" },
    { "opId": "018f3a2e-…", "status": "conflict",
      "conflict": { "reason": "published_marks_immutable",
                    "serverValue": { "cqMarks": "48.00" },
                    "clientValue": { "cqMarks": "50.00" },
                    "resolution": "server_wins" } },
    { "opId": "018f3a2f-…", "status": "rejected",
      "error": { "code": "SECTION_NOT_ASSIGNED", "retryable": false } }
  ]
}
```

`status` values and what the client does with each:

| status | Client action |
|---|---|
| `applied` | Delete from outbox, clear the ⏳ chip |
| `duplicate` | Delete from outbox (already recorded server-side) |
| `conflict` | Move to a `conflict` queue, surface the bn/en diff UI |
| `rejected` | Move to `failed`, show reason; `retryable: true` re-queues with backoff |

### 1.2 `GET /sync/pull`

```
GET /sync/pull?cursor=eyJsc24iOiI0Mi8zQjhBMDIwIn0&scopes=routineSlots,enrolments,sections
If-None-Match: "eyJsc24iOiI0Mi8zQjhBMDIwIn0"
```

`304` when nothing changed (the common case — a teacher opening the app four times a day).
`410 Gone` when the cursor predates the 30-day change-log window → client re-seeds that scope only.

---

## 2. MFS payment integration

### 2.1 Design constraints specific to Bangladesh

- **Callbacks are unreliable.** bKash and Nagad both retry on timeout, and both occasionally
  never call back at all when the payer's handset drops off the network mid-flow. Therefore:
  the webhook is an *optimisation*, and a **reconciliation poll is the source of truth**. Every
  transaction in `initiated`/`pending` older than 90 seconds is actively queried.
- **The payer is often not the account holder.** A guardian pays from an uncle's bKash. Never
  match on MSISDN; match on `merchantInvoiceNumber`.
- **Double-tap is the norm** on 2G. `uq_mfs_gateway_trx` and `Idempotency-Key` both apply.

### 2.2 Payment initiation

```http
POST /v1/finance/payments
Idempotency-Key: 018f3b7a-…
Content-Type: application/json

{
  "invoiceId": "inv_018f2c…",
  "provider": "bkash",
  "amount": "1250.00",
  "payerMsisdn": "+8801712345678",
  "returnUrl": "https://app.shikhon.bd/pay/callback",
  "locale": "bn"
}
```

```jsonc
// 201
{
  "transactionId": "mfs_018f3b7c…",
  "merchantOrderId": "SHK-DHI-2026-0000184",
  "provider": "bkash",
  "gatewayPaymentId": "TR0011ABC1234567890",
  "status": "initiated",
  "redirectUrl": "https://checkout.sandbox.bka.sh/…",
  "expiresAt": "2026-08-06T04:14:00Z",
  "amount": "1250.00",
  "currency": "BDT"
}
```

### 2.3 bKash webhook — `POST /v1/webhooks/bkash`

bKash Tokenized Checkout (Merchant API v1.2.0-beta). Headers:

```
X-BKASH-Signature: t=1754451852,v1=6f3a…      HMAC-SHA256 over "{t}.{rawBody}"
X-BKASH-Event-Id:  evt_9f21c…
Content-Type: application/json
```

```jsonc
{
  "eventId":   "evt_9f21c…",
  "eventType": "payment.execute.success",
  "createdAt": "2026-08-06T03:44:12.000Z",
  "data": {
    "paymentID":             "TR0011ABC1234567890",
    "trxID":                 "BGZ7K2M9QP",
    "merchantInvoiceNumber": "SHK-DHI-2026-0000184",
    "amount":                "1250.00",
    "currency":              "BDT",
    "intent":                "sale",
    "paymentExecuteTime":    "2026-08-06T09:44:12:000 GMT+0600",
    "transactionStatus":     "Completed",
    "customerMsisdn":        "01712345678",
    "payerReference":        "guardian_9812"
  }
}
```

Response is always `200 {"received": true}` once the body is persisted — even for a signature
failure — so bKash stops retrying while we investigate. The rejection is recorded in
`mfs_webhook_events.processing_state = 'rejected'` and alerts.

### 2.4 Webhook processing algorithm (identical for all three providers)

```
1. Persist raw body + headers to mfs_webhook_events         ← BEFORE anything else
      ON CONFLICT (provider, provider_event_id) DO NOTHING
      → 0 rows affected ⇒ duplicate ⇒ return 200, stop
2. Verify signature (HMAC-SHA256 / RSA per provider).
      Reject if the timestamp is more than 300 s old (replay window).
      Fail ⇒ state='rejected', alert, return 200.
3. Verify source IP against the provider's published allowlist.
4. Resolve merchantInvoiceNumber → mfs_transactions row.
      Unknown ⇒ state='deferred', retry in 60 s (initiation may still be in flight).
5. ▶ AMOUNT CHECK — gateway amount must EXACTLY equal our recorded amount.
      Mismatch ⇒ state='rejected', do NOT credit, page the accountant.
6. ▶ STATE CHECK — if the transaction is already 'completed', return 200 and stop.
7. In ONE transaction:
      a. UPDATE mfs_transactions SET status='completed', gateway_trx_id=…, completed_at=…
         (the UNIQUE index on (provider, gateway_trx_id) is the final backstop)
      b. SELECT app.apply_payment_to_invoice(tenant, invoice, amount)
      c. INSERT balanced ledger_entries (Dr Cash/MFS-Receivable, Cr Fee Income)
      d. INSERT event_outbox 'payment.settled.v1'
8. Return 200. Receipt PDF + guardian SMS happen asynchronously off the event.
```

Step 5 is the one that matters most: a webhook that reports a different amount than the one we
initiated is either a misconfigured gateway or an attack, and in both cases crediting the student
is wrong.

### 2.5 Nagad webhook — `POST /v1/webhooks/nagad`

Nagad signs with RSA-SHA256 using the merchant's issued public key and encrypts the sensitive
block; `sensitiveData` is Base64 of an RSA-encrypted JSON object.

```jsonc
{
  "merchantId":     "683002007104225",
  "orderId":        "SHK-DHI-2026-0000184",
  "paymentRefId":   "MTIzND…",
  "status":         "Success",
  "statusCode":     "000",
  "issuerPaymentRefNo": "MFSNAGAD00000123",
  "amount":         "1250.00",
  "clientMobileNo": "01712345678",
  "merchantMobileNo": "01730000000",
  "orderDateTime":  "20260806094412",
  "issuerPaymentDateTime": "20260806094418",
  "signature":      "V1sT…",
  "sensitiveData":  "eyJtZXJjaGFudElkIjoi…"
}
```

Verification: decrypt `sensitiveData` with our private key, RSA-verify `signature` over the
canonical concatenation, then assert the decrypted `orderId` and `amount` match the outer fields
**and** our stored transaction. A mismatch between outer and inner values is treated as tampering.

### 2.6 Rocket (DBBL) webhook — `POST /v1/webhooks/rocket`

```jsonc
{
  "txnId":        "RKT2608061044231",
  "billNumber":   "SHK-DHI-2026-0000184",
  "amount":       "1250.00",
  "txnDateTime":  "2026-08-06 09:44:23",
  "payerAccount": "017123456781",
  "status":       "SUCCESS",
  "checksum":     "a91c…"                    // SHA-256 of billNumber|amount|txnId|secret
}
```

### 2.7 Reconciliation

- **Poll**: every 90 s, `POST /queryPayment` for each transaction in `initiated`/`pending`
  older than 90 s and younger than 24 h. This is what closes the "callback never arrived" gap.
- **Nightly settlement file**: providers publish a CSV of settled transactions. `finance-svc`
  matches on `gateway_trx_id`, sets `reconciled_at` and `gateway_fee`, and raises an exception
  report for: in-file-not-in-DB, in-DB-not-in-file, and amount mismatches.
- **Alert**: any transaction `completed` for more than 48 h without `reconciled_at`.

### 2.8 Refunds

Refunds require accountant TOTP step-up and Principal approval above ৳5,000. `POST /v1/finance/refunds`
creates a reversing ledger batch and a provider refund call; the original transaction is never
mutated — its reversal is a separate row with `status = 'reversed'`.

---

## 3. SMS aggregator integration

Provider-agnostic adapter over SSL Wireless, Robi and Banglalink. Failover is per-message:
if the primary returns a 5xx or a delivery report fails, the message re-queues to the secondary.

### 3.1 Send

```http
POST https://smsplus.sslwireless.com/api/v3/send-sms
{
  "api_token": "…", "sid": "SHIKHONBD",
  "msisdn": "8801712345678",
  "sms": "প্রিয় অভিভাবক, আপনার সন্তান রহিম (রোল ১২) আজ ০৬/০৮/২০২৬ তারিখে বিদ্যালয়ে অনুপস্থিত ছিল। — ধানমন্ডি আইডিয়াল স্কুল",
  "csms_id": "018f3a2c9c117c1eb3aa2f6d1c0e91aa"      // our dedupe key, echoed in the DLR
}
```

**Cost control is a first-class concern.** Bangla SMS is UCS-2: **70 characters per segment**
versus 160 for GSM-7. The message above is 3 segments. The template library therefore:

- ships a 70-char and a 140-char variant of every template and picks the shortest that carries
  the required information;
- uses the short date form `০৬/০৮` rather than a spelled month;
- omits the school name when the sender ID already carries it;
- is validated in CI — a template exceeding its declared segment count fails the build.

### 3.2 Delivery report — `POST /v1/webhooks/sms/dlr`

```jsonc
{ "csms_id": "018f3a2c…", "sms_status": "DELIVERED",
  "status_code": "200", "delivered_at": "2026-08-06T03:45:31Z", "cost": "0.4500" }
```

### 3.3 Suppression rules (applied by the worker, not the caller)

A queued absence SMS is suppressed when any of these hold: the day is a `calendar_days` holiday;
the guardian has `receives_sms = false` or withdrew consent; the tenant's `sms_daily_cap` is
exhausted; an SMS with the same `dedupe_key` already went out today; or the attendance record was
corrected to `present` within the 15-minute grace window.

**The grace window matters.** Teachers fix mis-taps within seconds. Sending the SMS immediately
would mean a stream of "sorry, ignore that" corrections to parents.

---

## 4. Alumni Networking System (ANS) integration

The contract that lets the LMS and the ANS merge into one platform later without an identity
reconciliation project.

### 4.1 The merge contract

| Rule | Mechanism |
|---|---|
| One person, one identifier, forever | `users.global_person_id` (UUID) is minted at enrolment, never reused, never regenerated, and is the ANS's own primary person key |
| One institution, one identifier | `tenants.id` is used verbatim as the ANS institution key — no mapping table |
| Replay-safe delivery | `deliveryId` is stable across our retries; the ANS dedupes on it |
| Schema evolution | Every payload carries `schemaVersion`; additive changes bump minor, breaking changes mint a new event type (`student.graduated.v2`) |
| Ordering | `recordVersion` increases monotonically per `(globalPersonId, eventType)`; the ANS discards anything older than what it holds |

### 4.2 Outbound webhook — LMS → ANS

```http
POST {ans_base_url}/webhooks/lms
Content-Type: application/json
X-Shikhon-Event:      student.graduated.v1
X-Shikhon-Delivery:   018f4a91-2c33-7d0e-91bb-4e2f8a1c33d0
X-Shikhon-Key-Id:     k_2026_01
X-Shikhon-Signature:  t=1754451852,v1=9c2f…      HMAC-SHA256 over "{t}.{rawBody}"
```

```jsonc
{
  "schemaVersion": "1.0",
  "eventType": "student.graduated.v1",
  "deliveryId": "018f4a91-2c33-7d0e-91bb-4e2f8a1c33d0",
  "occurredAt": "2026-08-06T03:44:12Z",
  "recordVersion": 1,

  "person": {
    "globalPersonId": "9f2c1a44-7b31-4c8e-a0d2-1e5b7c9a3f21",   // ← the merge key
    "fullNameEn": "Rahim Uddin Ahmed",
    "fullNameBn": "রহিম উদ্দিন আহমেদ",
    "dateOfBirth": "2008-04-11",
    "gender": "male",
    "photoUrl": null                        // presigned, 24 h TTL, only when consented
  },

  "institution": {
    "institutionId": "tnt_018e7c…",         // ← = tenants.id, no mapping needed
    "eiin": "108234",
    "nameEn": "Dhanmondi Ideal School & College",
    "nameBn": "ধানমন্ডি আইডিয়াল স্কুল অ্যান্ড কলেজ",
    "district": "Dhaka", "boardCode": "dhaka"
  },

  "academic": {
    "lifecycleEvent": "graduated",
    "graduationYear": 2026,
    "finalClassLevel": 10,
    "stream": "bangla_medium",
    "group": "science",
    "finalExamName": "SSC 2026",
    "boardRollNo": "104523",
    "boardRegistrationNo": "1912345678",
    "finalGpa": "5.00",
    "finalLetterGrade": "A+",
    "subjectsStudied": [
      { "code": "101", "nameEn": "Bangla 1st Paper", "gradeLetter": "A+", "gradePoint": "5.00" },
      { "code": "136", "nameEn": "Physics",          "gradeLetter": "A+", "gradePoint": "5.00" }
    ],
    "attendancePercent": "94.20"
  },

  "achievements": [
    { "type": "olympiad", "titleEn": "Bangladesh Physics Olympiad",
      "titleBn": "বাংলাদেশ পদার্থবিজ্ঞান অলিম্পিয়াড",
      "year": 2025, "level": "national", "position": 3 },
    { "type": "co_curricular", "titleEn": "Debate Club Captain", "year": 2025 }
  ],

  "contact": {
    "shared": true,                          // false ⇒ the fields below are absent, not null
    "consentVersion": "2026-01-pdpa",
    "consentAt": "2026-03-02T10:14:00Z",
    "phoneE164": "+8801712345678",
    "email": "rahim@example.com"
  }
}
```

**Consent is enforced in the database view** (`v_ans_alumni_export`, migration 009), not in the
API layer — a bug in the serializer cannot leak an unconsented phone number, because the column
arrives NULL.

Expected ANS response:

```jsonc
// 200 / 202
{ "received": true, "ansRecordId": "ans_prs_88213", "action": "created" }   // or "updated" | "duplicate"
```

**Retry policy:** 8 attempts, exponential backoff with full jitter — 30 s, 2 m, 10 m, 45 m, 3 h,
12 h, 24 h, 48 h — then `dead_lettered` with an alert. `deliveryId` is unchanged across all
attempts, so eight retries can never create eight alumni.

### 4.3 Event catalogue (LMS → ANS)

| Event | Fired when |
|---|---|
| `student.graduated.v1` | `student_profiles.lifecycle_status` → `graduated` |
| `student.transferred_out.v1` | Student leaves for another institution (TC issued) |
| `student.achievement_added.v1` | An achievement is recorded post-graduation |
| `student.profile_updated.v1` | Name/DOB/photo corrected on an alumni record |
| `student.consent_changed.v1` | Contact-sharing consent granted or **withdrawn** — the ANS must honour withdrawal |
| `institution.updated.v1` | Institution name, EIIN or address changes |

### 4.4 Batch pull — ANS → LMS

For backfill and for reconciling missed webhooks.

```http
GET /v1/ans/alumni?since=2026-01-01T00:00:00Z&institutionId=tnt_018e7c…&limit=500&cursor=…
Authorization: Bearer <OAuth2 client-credentials token, scope=ans.alumni.read>
```

```jsonc
{
  "data": [ /* same person/institution/academic/achievements/contact shape as §4.2 */ ],
  "pagination": { "nextCursor": "eyJvIjoxNTAwfQ", "hasMore": true, "limit": 500 },
  "meta": { "schemaVersion": "1.0", "generatedAt": "2026-08-06T04:00:00Z", "totalEstimate": 2840 }
}
```

Also available as GraphQL for clients that want to select fields:

```graphql
query Alumni($since: DateTime!, $institutionId: ID!, $after: String) {
  alumni(since: $since, institutionId: $institutionId, first: 500, after: $after) {
    pageInfo { hasNextPage endCursor }
    nodes {
      globalPersonId
      person { fullNameEn fullNameBn dateOfBirth }
      academic { graduationYear finalExamName finalGpa group }
      achievements { type titleEn year level position }
      contact { shared phoneE164 email }
    }
  }
}
```

### 4.5 Inbound — ANS → LMS

The ANS enriches alumni profiles with what happens after school.

```http
POST /v1/ans/inbound
X-ANS-Signature: t=…,v1=…
X-ANS-Event-Id:  ans_evt_7712
```

```jsonc
{
  "schemaVersion": "1.0",
  "eventType": "alumni.profile_updated.v1",
  "globalPersonId": "9f2c1a44-7b31-4c8e-a0d2-1e5b7c9a3f21",
  "occurredAt": "2027-02-14T08:00:00Z",
  "enrichment": {
    "currentInstitution": "Bangladesh University of Engineering & Technology",
    "higherEducation": [
      { "institution": "BUET", "degree": "BSc EEE", "startYear": 2027, "status": "ongoing" }
    ],
    "currentEmployer": null,
    "linkedinUrl": "https://linkedin.com/in/…",
    "isMentorAvailable": true
  }
}
```

Inbound events land in `ans_inbound_events` and are applied to `alumni_profile_enrichment` —
deliberately a **separate table** from LMS-authoritative data. The LMS never lets an external
system overwrite a board result or a GPA.

### 4.6 Merge readiness checklist

The following are true today so that consolidation is a data-plane migration, not a project:

- [x] `global_person_id` is on every person record and exported verbatim.
- [x] `tenants.id` is the institution key on both sides.
- [x] Every export is versioned (`schemaVersion`, `recordVersion`) and content-hashed.
- [x] Every delivery attempt is logged with its exact payload (`alumni_export_logs.payload`).
- [x] Consent state is a first-class exported field with its own change event.
- [x] Enrichment from the ANS is stored separately from LMS-authoritative records.
- [x] A full backfill can be replayed at any time from `alumni_records` without recomputation.

---

## 5. Webhook security — applies to every inbound endpoint

| Control | Detail |
|---|---|
| Signature | HMAC-SHA256 (bKash, Rocket, ANS) or RSA-SHA256 (Nagad) over `"{timestamp}.{rawBody}"`, compared with a constant-time equality |
| Replay window | Reject timestamps older than 300 s |
| Idempotency | `UNIQUE (provider, provider_event_id)` — the insert itself is the dedupe |
| IP allowlist | Provider-published ranges, enforced at Kong |
| Raw-body persistence | Stored **before** parsing, so a dispute is reconstructible byte-for-byte |
| Rate limit | 100 req/s per provider, 429 with `Retry-After` beyond |
| Body cap | 256 KB; larger is rejected without buffering |
| Response | Always `200` once persisted — never make a provider retry-storm us over our own bug |
| Key rotation | `keyId` in every signature header; two keys valid during a 30-day overlap |
