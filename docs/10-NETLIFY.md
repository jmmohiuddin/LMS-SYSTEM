# Netlify deployment

Live: https://shikhon-lms.netlify.app · project `shikhon-lms` (`e49617ca-d412-47d4-b873-acc009ac98bd`)

Vercel is unchanged and remains the primary target. Both hosts build from
the same sources: `scripts/build.mjs` emits the PWA once, then two sets of
function bundles from the same service handlers. Nothing in `apps/pwa`
knows which host it is running on.

## Deploying

```bash
npm run deploy:netlify
```

That builds, stages, deploys and cleans up. Do not run `netlify deploy`
directly from the repo — see the staging note below.

## Why the deploy stages to a temp directory

The Netlify CLI walks the whole project directory during a deploy and
stats everything it finds. This repo has ten symlinks under
`.claude/skills` (local agent tooling, untracked) and the CLI fails on
them:

```
Error: File …/.claude/skills/review-animations does not exist.
```

It names a different one each run, which is what identifies it as a walk
over the whole set rather than one bad file. The files are fine — `lstat`,
`readlink`, `realpath` and `stat` all succeed, and converting the links
from relative to absolute did not help. `scripts/deploy-netlify.mjs`
copies only what ships into a scratch directory and deploys from there, so
the CLI has nothing else to walk. That is also the correct shape: a deploy
should not be able to see files that are not part of it.

## Why `pg` is bundled here and external on Vercel

Vercel's Node builder installs `node_modules` beside each function, so
`pg` can stay external. The Netlify functions deploy from a staging
directory with no `node_modules` at all, so `pg` has to be *inside* the
bundle. Without that the runtime throws on the first request:

```
502  Cannot find package 'pg' imported from /var/task/academics.mjs
```

`pg-native` is aliased to `netlify/pg-native-stub.mjs`. It is an optional
binding that needs a compiler toolchain, nothing here touches
`Client.native`, and esbuild cannot resolve it otherwise. Bundles are
~345 KB each as a result.

## Environment variables

**Nothing is set yet.** The site currently serves the PWA and answers every
API route with a correct error rather than data: `401 unauthorized` without
a token, `otp_disabled` on login (`LOGIN_DISABLED` is still `true`).
Demo mode — `?demo=1` — is fully functional without any of this.

### The decision to make first

Several of these secrets are **not free to invent** if this deployment
shares a database with Vercel:

| Variable | Why it must match |
|---|---|
| `PII_MASTER_KEY_V1` / `_V2` | Encrypts national identifiers at rest. A different key cannot decrypt existing rows, and new writes become unreadable to the other host. |
| `ACTIVATION_PEPPER` | Activation codes are hashed with it before storage. A different pepper invalidates every outstanding code. |
| `JWT_PRIVATE_KEY` / `JWT_PUBLIC_KEY` | Tokens issued by one host will not verify on the other. |

So there are two coherent options, and mixing them corrupts data:

1. **Netlify gets its own database.** Generate a fresh secret set
   (`node scripts/generate-jwt-keys.mjs`, and random values for the rest)
   and run the migrations against a separate database. Safe to experiment
   with; nothing touches real school data.
2. **Netlify shares the production database.** Copy the values from Vercel
   verbatim. Do not generate new ones.

### The scheduled jobs are OFF by default

`cron-sms` and `cron-maintenance` no-op unless
`NETLIFY_CRONS_ENABLED=true`. This matters: point Netlify at the
production database with the crons on, and the SMS dispatch fires here
*and* on Vercel — every guardian of an absent child gets the message
twice. A duplicate SMS about your child being absent is not a cosmetic
bug, and each send costs money. Only the host that owns the schedule
should set this.

### Setting them

```bash
netlify env:set DATABASE_URL 'postgresql://shikhon_runtime:…@…/shikhon_lms?sslmode=require'
netlify env:set JWT_PRIVATE_KEY '…'
netlify env:set JWT_PUBLIC_KEY '…'
netlify env:set PII_MASTER_KEY_V1 '…'
netlify env:set ACTIVATION_PEPPER '…'
netlify env:set SERVICE_API_KEY '…'
netlify env:set CRON_SECRET '…'
netlify env:set ANS_SIGNING_SECRET '…'
```

Connect as `shikhon_runtime`, never the owner — PostgreSQL exempts
superusers from RLS, and `assertRlsEnforced()` refuses to boot on a
privileged role for exactly that reason.

Deliberately unset: `ANTHROPIC_API_KEY` (SikhokAI/ShikhoAI stay dark at
৳0) and the SMS/MFS credentials.

## Route map

Routes are declared per-function via `export const config = { path }` in
the generated bundles, so `netlify.toml` has no redirect table to drift
out of sync with `scripts/build.mjs`. Paths are byte-identical to Vercel's.

| Path | Function |
|---|---|
| `/api/v1/auth/*` | `auth` |
| `/api/v1/academics/:resource` | `academics` |
| `/api/v1/rms/:action` | `rms` |
| `/api/v1/sync/:action` | `sync` |
| `/api/v1/finance/:resource` | `finance` |
| `/api/v1/finance/webhooks/:provider` | `finance-webhook` |
| `/api/v1/ai/:engine` | `ai` |
| `/api/v1/ans/:action` | `ans` |
| `/api/v1/ops/:action` | `ops` |
| `/api/v1/sms/dispatch` | `sms-dispatch` |

Two traps already hit and fixed, recorded so they are not re-introduced:

- **A scheduled function is internal-only.** Attaching `schedule` to the
  `ops` function made `/api/v1/ops/events` return 403 to the PWA. Schedules
  belong on the dedicated `cron-*` functions.
- **`:path*` is not Netlify syntax.** It is Vercel/Express. Netlify v2 uses
  URLPattern, where it matches nothing and surfaces as a 404 rather than a
  config error. Use `/*`.
