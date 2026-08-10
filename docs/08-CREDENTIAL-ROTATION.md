# 08 — Credential rotation

**Requirement:** F-105 — confirm and record credential rotation.

This document is the record. It exists because "we rotated the keys" is
the kind of claim that is always believed and rarely true, and because six
months from now nobody will remember which credential was replaced or when.

Two things are automated so they stop depending on memory:

```bash
node scripts/check-secrets.mjs --env       # before every deploy
node scripts/check-secrets.mjs --history   # every push, in CI
```

The first refuses a deploy with a missing, placeholder, or dangerously
wrong secret. The second proves no credential has ever been committed.
Neither ever prints a secret value — not masked, not truncated. A CI log
is forever, and it is usually easier to read than the deploy dashboard.

---

## 1. What this system holds

| Credential | Required | If it leaks, the attacker gets |
|---|---|---|
| `DATABASE_URL` | yes | every tenant's data, read and write, as the runtime role |
| `DATABASE_MAINTENANCE_URL` | no | DDL on the whole database as the **owner** role — the worst one to lose |
| `SERVICE_API_KEY` | yes | the machine-to-machine surface: ANS export, SMS dispatch, maintenance |
| `CRON_SECRET` | yes | can fire the SMS worker and the maintenance run at will |
| `ANTHROPIC_API_KEY` | no | billable AI spend |
| `ANS_SIGNING_SECRET` | no | can forge alumni webhooks the ANS will trust |
| `PII_MASTER_KEY_V<n>` | no | **every stored national ID and birth-registration number** |

The last row is the one that matters most and rotates least like the
others. See §4.

Nothing else is a secret. The JWT signing keys are EdDSA and live in the
same secret store; `SMS_WORKER_TENANT_IDS`, `AI_MODEL_*` and `NODE_ENV`
are configuration, not credentials.

---

## 2. Current state

Two separate questions, and they have different answers.

### Has a credential ever been committed to this repository? No.

Verified **2026-08-11** by `scripts/check-secrets.mjs --history` across every
commit on every branch. The connection strings in
[06-DEPLOYMENT.md](06-DEPLOYMENT.md) §3 carry `<owner-password>` /
`<runtime-password>` placeholders, and `.gitignore` has covered `.env`,
`.env.*` and `*.env` since the first commit. CI re-checks this on every push.

### Has a credential been exposed some other way? Yes — two, still unrotated.

[07-IMPLEMENTATION-STATUS.md](07-IMPLEMENTATION-STATUS.md) §9 records both,
and they are the reason this document exists rather than a routine cadence:

| Credential | How it was exposed | Status |
|---|---|---|
| `neondb_owner` password (`npg_…`) | shared in plaintext outside the repository | **compromised — rotate** |
| MongoDB credential (earlier experiment) | shared in plaintext; unused by this system but still live | **compromised — revoke** |

A git-history scan cannot see either of these, which is exactly why the
scan alone is not the answer to "are we clean". **Treat the owner
credential as compromised until §3 records it rotated.**

The `neondb_owner` role carries `BYPASSRLS`. Anyone holding that password
can read and write every tenant's data with no isolation whatsoever — it is
the single most damaging credential in the system, and it is the one that
leaked. It must also never be the application's `DATABASE_URL`;
`assertRlsEnforced()` in `packages/server-core/src/db.ts` refuses to boot on
it and `check-secrets.mjs --env` fails on it, but neither helps if someone
uses it directly.

The MongoDB credential belongs to nothing in this system. Revoke rather than
rotate — an unused live credential is pure liability.

Nothing else is known to be exposed. The runtime password exists only in
Vercel's `DATABASE_URL` with no local copies.

---

## 3. Rotation ledger

Fill a row in **before** rotating, and complete it after. An empty ledger
with live credentials is the situation F-105 exists to end.

| Date | Credential | Reason | Rotated by | Verified by | Old credential revoked |
|---|---|---|---|---|---|
| **_(URGENT, pending)_** | **`neondb_owner` password** | **known plaintext exposure — BYPASSRLS, every tenant** | | | |
| **_(URGENT, pending)_** | **MongoDB credential** | **known plaintext exposure; unused — revoke, do not rotate** | | | |
| _(pending)_ | `DATABASE_URL` (`shikhon_runtime`) | baseline rotation | | | |
| _(pending)_ | `SERVICE_API_KEY` | baseline rotation | | | |
| _(pending)_ | `CRON_SECRET` | baseline rotation | | | |
| _(pending)_ | `ANTHROPIC_API_KEY` | baseline rotation | | | |

The first two rows are not cadence. They are outstanding remediation for a
credential that is known to have been shared in plaintext, and they should
be done before anything else in this document.

**Cadence:** every 90 days, and immediately on any of — a laptop lost, a
contractor offboarded, a credential pasted into a chat or ticket, or a
`--history` finding.

"Revoked" is a separate column from "rotated" on purpose. A rotation that
leaves the old credential valid has changed nothing.

---

## 4. Procedures

### `DATABASE_URL` (runtime role)

```sql
ALTER ROLE shikhon_runtime PASSWORD '<new>';
```

Then update the Vercel env var and redeploy. There is a window between the
two where in-flight functions hold the old password — a few seconds of
`password authentication failed`. Do it outside school hours (BST daytime).

Never point this at `neondb_owner`. That role carries `BYPASSRLS`, so every
tenant boundary in the system disappears silently. `check-secrets.mjs`
fails on it, and `assertRlsEnforced()` in `packages/server-core/src/db.ts`
refuses to boot on it.

### `DATABASE_MAINTENANCE_URL` (owner role)

Same `ALTER ROLE` against `neondb_owner`. Used by `/api/v1/ops/maintenance`
and `scripts/migrate.sh` only. If in doubt, rotate this one first — it is
the credential with no ceiling on what it can do.

### `SERVICE_API_KEY` / `CRON_SECRET` / `ANS_SIGNING_SECRET`

```bash
openssl rand -base64 32
```

Update the Vercel env var. `SERVICE_API_KEY` also has to reach every
external caller that holds it; `ANS_SIGNING_SECRET` needs a coordinated
cutover with the ANS operator, or in-flight webhooks fail signature
verification and park as `failed`.

### `ANTHROPIC_API_KEY`

Issue a new key in the Anthropic console, update Vercel, then **revoke the
old one**. The gateway ships dark without a key (503 `ai_disabled`), so a
gap degrades one feature rather than breaking the app.

---

## 5. The PII master key rotates differently — read this before touching it

`PII_MASTER_KEY_V<n>` protects every national ID and birth-registration
number in the database (F-101). It is **versioned and additive**. Replacing
`V1` in place does not rotate anything; it makes every existing identifier
permanently undecryptable, and no error appears until someone tries to read
one during a board registration.

The correct sequence:

1. Generate `openssl rand -base64 32` and set it as **`PII_MASTER_KEY_V2`**.
   Leave `V1` in place. New writes immediately use V2
   (`currentKeyVersion()` picks the highest configured version on every
   call, so this takes effect on the next request, not the next cold start).
2. Run the re-encryption sweep. `rotateIdentifier()` in
   `packages/server-core/src/pii-crypto.ts` re-seals a row without the
   plaintext ever leaving that function's stack frame.
3. Watch it drain:
   ```sql
   SELECT pii_key_version, count(*)
     FROM users
    WHERE nid_ciphertext IS NOT NULL OR brc_ciphertext IS NOT NULL
    GROUP BY 1 ORDER BY 1;
   ```
   (`ix_users_pii_key_version`, migration 021, exists for this query.)
4. **Only when version 1 reports zero rows**, remove `PII_MASTER_KEY_V1`.

`check-secrets.mjs` fails if `V2` is set without `V1`, which is the
mistake this section exists to prevent.

If the key is lost with rows still sealed under it, that data is gone.
There is no recovery, by design — that is what "encrypted at rest" means.
Back the key up in the secret manager's own escrow, never in this
repository and never in a ticket.

---

## 6. What must never happen

- A credential in a commit, a comment, a ticket, a chat message, or a log
  line. If one gets there: **rotate first**, then rewrite history. Removing
  a commit does not un-leak anything that was ever pushed.
- `DATABASE_URL` pointing at an owner or superuser role.
- A connection string without `sslmode=require`.
- `PII_MASTER_KEY_V1` replaced rather than superseded.
- A rotation recorded in §3 without the old credential revoked.
