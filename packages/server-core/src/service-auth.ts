/**
 * SERVICE_API_KEY — the widest credential in the product.  (R-8 §2)
 *
 * The R-8 security review named this key the largest single risk and it is
 * worth stating plainly what it does: presented as a bearer token to
 * /sync/push or /sync/pull, together with `X-Tenant-ID`, it makes the caller
 * any user of any school. It is not scoped to a tenant, it does not expire,
 * and no RLS policy constrains it, because the whole point of it is to choose
 * the tenant context that RLS will then enforce.
 *
 * ── Why it is not simply deleted ─────────────────────────────────────────
 * Because "harden it" and "remove it" are different instructions, and removal
 * would be the reckless choice here. The key is how an engineer replays a
 * school's stuck sync batch at 11pm when its principal is on the phone, and
 * how the smoke tests reach a real deployment before any human account exists
 * on it. Taking that away in the name of security would not make the product
 * safer; it would make the first production incident unrecoverable.
 *
 * So the shape of the fix is not removal but *narrowing, noise and rotation*:
 *
 *   1. Off in production unless switched on.  Tenant switching is refused when
 *      NODE_ENV=production and SERVICE_KEY_TENANT_SWITCH is not explicitly
 *      'on'. Dev, CI and staging are unchanged — a control that breaks the
 *      places people actually run is a control that gets turned off again.
 *   2. Never from a browser.  A server-to-server caller sends no `Origin`, no
 *      `Sec-Fetch-*` and no `Cookie`. If one of those is present the key is
 *      being presented *from a page*, which means it has leaked into
 *      client-side code — the exact scenario "no platform secret in browser
 *      code" exists to prevent. Refusing that request converts a silent leak
 *      into a loud, dated log line.
 *   3. Loud on every use.  Each acceptance and each refusal emits a single
 *      structured line carrying the key's fingerprint, never the key. In
 *      production a legitimate use is rare, so these lines are an alerting
 *      signal (§7) rather than routine chatter.
 *   4. Rotatable without downtime.  `SERVICE_API_KEY_NEXT` is accepted
 *      alongside the current key, so a rotation is: publish NEXT → move
 *      callers → promote NEXT to SERVICE_API_KEY → clear NEXT. Without a
 *      second slot, rotating means a window where either the old key still
 *      works or the ops scripts are broken, and in practice that means the key
 *      is never rotated at all.
 *   5. Compared in constant time.  A byte-by-byte `===` on a secret leaks its
 *      prefix to a patient attacker. Cheap to fix, so fixed.
 *
 * ── The blast radius, stated honestly ────────────────────────────────────
 * With this key and nothing else, a holder can read and write every record of
 * every school on the deployment: rosters, attendance, marks, fees, guardians'
 * phone numbers. It is equivalent to the database password for the application
 * role. It belongs only in the host's encrypted environment store, never in
 * the repository, never in a browser bundle, and never in a support ticket.
 * If it is ever pasted into a chat, treat it as burned and rotate.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

/** Which slot a presented token matched. Reported in logs, never derived from. */
export type ServiceKeyLabel = 'current' | 'next' | 'cron';

/**
 * The first eight hex of the key's SHA-256. Enough to tell "the key I rotated
 * out is still in use" from "someone is guessing", and useless to an attacker.
 */
export function keyFingerprint(key: string): string {
  return createHash('sha256').update(key, 'utf8').digest('hex').slice(0, 8);
}

/** Constant-time equality that tolerates unequal lengths (by hashing first). */
function sameSecret(a: string, b: string): boolean {
  if (!a || !b) return false;
  const ha = createHash('sha256').update(a, 'utf8').digest();
  const hb = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(ha, hb);
}

/**
 * Does `token` match a configured service credential?
 *
 * `allowCron` mirrors the existing convention on the cron-triggered endpoints
 * (sms/dispatch, ops/maintenance, ans), which accept CRON_SECRET as well. Those
 * endpoints do not switch tenants, so the cron secret is genuinely narrower.
 */
export function matchServiceKey(
  token: string,
  env: NodeJS.ProcessEnv = process.env,
  opts: { allowCron?: boolean } = {},
): ServiceKeyLabel | null {
  if (!token) return null;
  if (env.SERVICE_API_KEY && sameSecret(token, env.SERVICE_API_KEY)) return 'current';
  if (env.SERVICE_API_KEY_NEXT && sameSecret(token, env.SERVICE_API_KEY_NEXT)) return 'next';
  if (opts.allowCron && env.CRON_SECRET && sameSecret(token, env.CRON_SECRET)) return 'cron';
  return null;
}

/**
 * Headers a browser attaches and a server-to-server client does not.
 *
 * Returns the offending header name so the log line can say which one, because
 * "your key is in a web page" is a claim that should come with its evidence.
 *
 * Two headers are deliberately NOT in this list, and both omissions were
 * earned rather than assumed:
 *
 *   `sec-fetch-mode` — Node's own `fetch` sends `Sec-Fetch-Mode: cors` on
 *   every request. Undici is what the Netlify cron wrapper and every ops
 *   script use, so treating it as a browser marker refused the scheduled
 *   dispatch and the maintenance job: the SMS cron would have stopped on the
 *   first production run, silently, which is the exact failure §7 exists to
 *   catch. Found by running the acceptance probe rather than by reading the
 *   code. Nothing is lost by dropping it — browsers that send Sec-Fetch-Mode
 *   send Sec-Fetch-Site alongside it, and undici sends neither.
 *
 *   `referer` — some proxies and CLI tools set it, and a false positive here
 *   locks an engineer out of the recovery path mid-incident.
 */
export function looksLikeBrowser(req: Pick<IncomingMessage, 'headers'>): string | null {
  for (const name of ['origin', 'cookie', 'sec-fetch-site']) {
    const v = req.headers[name];
    if (typeof v === 'string' ? v.length > 0 : Array.isArray(v) && v.length > 0) return name;
  }
  return null;
}

/**
 * May a service key choose its own tenant on this deployment?
 *
 * Unset outside production → yes, exactly as before. Production → no, unless
 * SERVICE_KEY_TENANT_SWITCH is explicitly 'on'. The default is the safe one
 * and the override is a deliberate, greppable act.
 */
export function tenantSwitchAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  const flag = (env.SERVICE_KEY_TENANT_SWITCH ?? '').trim().toLowerCase();
  if (flag === 'on' || flag === 'true' || flag === '1') return true;
  if (flag === 'off' || flag === 'false' || flag === '0') return false;
  return env.NODE_ENV !== 'production';
}

export interface ServiceContext {
  tenantId: string;
  userId: string;
  role: string;
  keyLabel: ServiceKeyLabel;
}

export type ServiceAuthResult =
  /** No service credential presented — the caller's JWT path should run. */
  | { kind: 'not_service' }
  /** A service credential was presented and must not be honoured. */
  | { kind: 'refused'; status: number; error: string; code: string }
  | { kind: 'service'; context: ServiceContext };

/**
 * The whole service-key decision for a tenant-switching endpoint, in one place
 * so /sync/push and /sync/pull cannot drift apart — they had two copies of
 * this logic and a change to one would silently have left the other open.
 */
export function authenticateServiceKey(
  req: IncomingMessage,
  token: string,
  env: NodeJS.ProcessEnv = process.env,
  endpoint = 'unknown',
): ServiceAuthResult {
  const label = matchServiceKey(token, env);
  if (!label) return { kind: 'not_service' };

  const fingerprint = keyFingerprint(token);

  const browserHeader = looksLikeBrowser(req);
  if (browserHeader) {
    logServiceKeyEvent({
      event: 'service_key_from_browser', endpoint, fingerprint, keyLabel: label,
      detail: browserHeader,
    });
    return {
      kind: 'refused', status: 403,
      error: 'Service credentials may not be used from a browser',
      code: 'service_key_from_browser',
    };
  }

  if (!tenantSwitchAllowed(env)) {
    logServiceKeyEvent({
      event: 'service_key_switch_disabled', endpoint, fingerprint, keyLabel: label,
    });
    return {
      kind: 'refused', status: 403,
      error: 'Service-key tenant switching is disabled on this deployment',
      code: 'service_tenant_switch_disabled',
    };
  }

  const h = (name: string): string => {
    const v = req.headers[name];
    return (Array.isArray(v) ? v[0] : v) ?? '';
  };
  const tenantId = h('x-tenant-id').trim();
  const userId = h('x-user-id').trim();
  const role = h('x-role').trim() || 'teacher';
  if (!tenantId || !userId) {
    return {
      kind: 'refused', status: 400,
      error: 'X-Tenant-ID and X-User-ID headers are required',
      code: 'missing_service_context',
    };
  }

  logServiceKeyEvent({
    event: 'service_key_used', endpoint, fingerprint, keyLabel: label,
    tenantId, userId, role,
  });
  return { kind: 'service', context: { tenantId, userId, role, keyLabel: label } };
}

/**
 * One structured line per service-key event, on stderr.
 *
 * Deliberately not the `audit.activity_log` table. That log is a *school's*
 * history of what its staff did, readable by its management, and writing
 * platform-engineering events into it would both mislead a principal reading
 * it and require a tenant context the refusal paths do not have. The host's
 * log drain is where operational events belong, and §7's alerting reads them
 * from there.
 */
export function logServiceKeyEvent(fields: Record<string, unknown>): void {
  console.warn(JSON.stringify({ at: 'service-auth', ...fields }));
}
