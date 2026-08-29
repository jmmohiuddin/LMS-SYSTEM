#!/usr/bin/env node
/**
 * Generate the deployment's VAPID keypair.  (R-9)
 *
 *   node scripts/generate-vapid-keys.mjs
 *
 * Web push is the one transport in this product with no vendor: there is no
 * aggregator to contract with and no merchant account to open. This script is
 * the whole of "getting credentials" — run it once, put the two values in the
 * environment, and every browser can subscribe.
 *
 * ── Read this before rotating ──────────────────────────────────────────
 * The public half is baked into every subscription a browser has ever made.
 * Changing it does not invalidate those subscriptions at the push service —
 * they keep working, and our messages to them start being REJECTED, silently,
 * one 403 at a time. The app recovers on its own (push-client.ts notices the
 * key no longer matches and re-subscribes) but only for people who open the
 * app; anyone who does not simply stops receiving notifications.
 *
 * So rotate only for a compromised private key, and expect every device to be
 * re-registered. There is nothing to gain from routine rotation here: the
 * private key signs a 12-hour token addressed to a push service and grants no
 * access to anything of ours.
 */
import { generateVapidKeys } from '../packages/server-core/src/web-push.ts';

const keys = generateVapidKeys();

console.log(`
VAPID keypair generated.

Set both in the deployment environment (Vercel → Settings → Environment
Variables, or .env for local work):

VAPID_PUBLIC_KEY=${keys.publicKey}
VAPID_PRIVATE_KEY=${keys.privateKey}

The PUBLIC key is handed to every browser that subscribes — it is not a
secret and it appears in the /api/v1/ops/push response by design.

The PRIVATE key is a secret. It is what proves to a push service that a
message came from this deployment. Anyone holding it, plus a subscription
endpoint, can put a notification on that person's phone with your school's
name on it.

Neither key is per-school: one pair serves every tenant, exactly like the
JWT signing keys. A school does not need its own and cannot have one — the
browser is subscribing to a deployment, not to a school.

Push stays off until BOTH are set. Nothing else breaks in the meantime:
every message continues to go out by SMS, which is what happens today.
`.trim());
