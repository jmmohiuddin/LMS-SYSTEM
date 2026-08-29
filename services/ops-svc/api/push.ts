/**
 * GET    /api/v1/ops/push — is push available, and which of my devices are on?
 * POST   /api/v1/ops/push — register this browser
 * DELETE /api/v1/ops/push — unregister a device
 *
 * R-9. The one thing this endpoint never takes is a user id. A subscription
 * belongs to whoever is holding the session, full stop — there is no workflow
 * in which one person registers a device for another, so accepting a
 * `userId` would be a parameter that only an attacker has a use for.
 *
 * ── The endpoint URL is attacker-controlled, and the SERVER fetches it ──
 * This is the sharp edge of web push and it is worth naming. The browser hands
 * us a URL; later, our server POSTs to that URL. An authenticated user can
 * therefore choose an address our server will make a request to.
 *
 * The payload is encrypted for a key they supplied, so what they could read
 * back is bounded by what they can already read in the app. The real exposure
 * is the request itself — an outbound POST to an address of their choosing,
 * which is the shape of an SSRF. `assertSafePushEndpoint()` below is the
 * boundary: https only, no credentials in the URL, no IP literals, and none of
 * the names that resolve inside a network rather than outside it.
 *
 * What that does NOT stop is a public hostname whose DNS answers with a
 * private address. Defeating that needs resolve-then-connect-to-the-resolved-IP,
 * which `fetch` does not offer. It is recorded here and in 07 rather than
 * papered over; the practical mitigation is that this runs on serverless with
 * no private network worth reaching.
 *
 * ── Why the keys are validated here and not only at send time ──────────
 * A subscription whose p256dh is malformed cannot ever be encrypted for. Left
 * to be discovered by the dispatcher, it becomes a row that fails for every
 * notice forever, and a person who believes they enabled notifications. It is
 * cheaper to refuse it at the door, in front of the person who can fix it by
 * re-subscribing.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';

import { sharedDb } from '../../../packages/server-core/src/db.ts';
import { corsHeaders, readJson, json, HttpError } from '../../../packages/server-core/src/http.ts';
import { authenticate } from '../../../packages/server-core/src/auth.ts';
import { vapidFromEnv, unb64url, endpointFingerprint } from '../../../packages/server-core/src/web-push.ts';

interface SubscribeBody {
  endpoint?: unknown;
  keys?: { p256dh?: unknown; auth?: unknown };
  deviceLabel?: unknown;
}

/**
 * Hostnames that name something inside a network rather than on the internet.
 * A push service is always a public name; none of these can be one.
 */
const PRIVATE_SUFFIXES = ['.local', '.internal', '.localdomain', '.home.arpa'];
const PRIVATE_NAMES = new Set(['localhost', 'metadata.google.internal']);

export function assertSafePushEndpoint(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new HttpError(400, 'endpoint must be a URL', 'bad_endpoint');
  }
  if (url.protocol !== 'https:') {
    throw new HttpError(400, 'endpoint must be https', 'bad_endpoint');
  }
  // Credentials in the URL would be sent by our server on every push, and
  // would sit in the database in plaintext.
  if (url.username || url.password) {
    throw new HttpError(400, 'endpoint must not carry credentials', 'bad_endpoint');
  }
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (PRIVATE_NAMES.has(host) || PRIVATE_SUFFIXES.some((s) => host.endsWith(s))) {
    throw new HttpError(400, 'endpoint host is not routable', 'bad_endpoint');
  }
  // An IP literal is never a real push service, and is how every trivial SSRF
  // attempt is written. Covers IPv4, IPv4-in-IPv6, and bracketed IPv6.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.startsWith('[') || /^\d+$/.test(host)) {
    throw new HttpError(400, 'endpoint host is not routable', 'bad_endpoint');
  }
  if (raw.length > 2048) {
    throw new HttpError(400, 'endpoint is too long', 'bad_endpoint');
  }
  return url;
}

/** Refuse now what could never be encrypted later. */
function assertUsableKeys(p256dh: string, auth: string): void {
  let pub: Buffer;
  let secret: Buffer;
  try {
    pub = unb64url(p256dh);
    secret = unb64url(auth);
  } catch {
    throw new HttpError(400, 'keys must be base64url', 'bad_keys');
  }
  if (pub.length !== 65 || pub[0] !== 0x04) {
    throw new HttpError(400, 'p256dh must be a 65-byte uncompressed P-256 point', 'bad_keys');
  }
  if (secret.length !== 16) {
    throw new HttpError(400, 'auth must be a 16-byte secret', 'bad_keys');
  }
}

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const cors = corsHeaders([], 'GET, POST, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }

  try {
    const claims = await authenticate(req);
    const db = await sharedDb();
    const ctx = { tenantId: claims.tid, userId: claims.sub, role: claims.role };
    const vapid = vapidFromEnv();

    // ── GET: what this person's browser needs to decide what to show ──
    if (req.method === 'GET') {
      const devices = await db.withTenant(ctx, async (c) => {
        const { rows } = await c.query<{
          id: string; device_label: string | null; created_at: string;
          last_success_at: string | null; endpoint: string;
        }>(
          `SELECT id, device_label, created_at, last_success_at, endpoint
             FROM push_subscriptions
            WHERE user_id = $1
            ORDER BY created_at DESC`,
          [claims.sub],
        );
        return rows;
      });
      json(res, 200, {
        // Absent VAPID keys mean the deployment has not enabled push. The UI
        // says so rather than offering a button that cannot work.
        enabled: vapid !== null,
        publicKey: vapid?.publicKey ?? null,
        devices: devices.map((d) => ({
          id: d.id,
          label: d.device_label,
          createdAt: d.created_at,
          lastSuccessAt: d.last_success_at,
          // The endpoint itself is never returned — it is a capability, and
          // the UI only ever needs to identify a row to delete it.
          fingerprint: endpointFingerprint(d.endpoint),
        })),
      }, cors);
      return;
    }

    // ── POST: claim this browser ──────────────────────────────────────
    if (req.method === 'POST') {
      if (!vapid) {
        throw new HttpError(503,
          'push notifications are not enabled on this deployment (VAPID_PUBLIC_KEY)',
          'push_not_configured');
      }
      const body = await readJson<SubscribeBody>(req);
      const endpoint = str(body.endpoint);
      const p256dh = str(body.keys?.p256dh);
      const auth = str(body.keys?.auth);
      if (!endpoint || !p256dh || !auth) {
        throw new HttpError(400, 'endpoint and keys are required', 'missing_fields');
      }
      assertSafePushEndpoint(endpoint);
      assertUsableKeys(p256dh, auth);

      const label = str(body.deviceLabel).slice(0, 80);

      const id = await db.withTenant(ctx, async (c) => {
        // Tenant and user come from the session inside the function; nothing
        // this request body contains can redirect the row to another person.
        const { rows } = await c.query<{ claim_push_subscription: string }>(
          `SELECT app.claim_push_subscription($1, $2, $3, $4)`,
          [endpoint, p256dh, auth, label || null],
        );
        return rows[0]?.claim_push_subscription ?? null;
      });

      json(res, 200, { ok: true, id, fingerprint: endpointFingerprint(endpoint) }, cors);
      return;
    }

    // ── DELETE: give up a device ──────────────────────────────────────
    if (req.method === 'DELETE') {
      const body = await readJson<{ endpoint?: unknown; id?: unknown }>(req);
      const endpoint = str(body.endpoint);
      const id = str(body.id);
      if (!endpoint && !id) {
        throw new HttpError(400, 'endpoint or id is required', 'missing_fields');
      }

      const removed = await db.withTenant(ctx, async (c) => {
        // `user_id = $1` is belt and braces: `push_delete_scope` already
        // confines this to the caller's own rows. Stating it in the query too
        // means a policy edit cannot silently widen a DELETE.
        const { rowCount } = endpoint
          ? await c.query(
              `DELETE FROM push_subscriptions WHERE user_id = $1 AND endpoint = $2`,
              [claims.sub, endpoint])
          : await c.query(
              `DELETE FROM push_subscriptions WHERE user_id = $1 AND id = $2`,
              [claims.sub, id]);
        return rowCount ?? 0;
      });

      // Not 404 when nothing matched. Unsubscribing is idempotent by nature —
      // a browser that already dropped its subscription is in exactly the
      // state the caller asked for, and an error would make the UI show a
      // failure for a success.
      json(res, 200, { ok: true, removed }, cors);
      return;
    }

    json(res, 405, { error: 'method_not_allowed' }, cors);
  } catch (err) {
    if (err instanceof HttpError) {
      json(res, err.status, { error: err.code, message: err.message }, cors);
      return;
    }
    console.error('[ops/push]', err);
    json(res, 500, { error: 'internal_error' }, cors);
  }
}
