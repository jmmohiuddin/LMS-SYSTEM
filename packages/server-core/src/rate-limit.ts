/**
 * Rate limiting  (F-102, TRD §11.2)
 *
 * Token-bucket throughput limiting, backed by Postgres (migration 020). No
 * new stateful service — TRD §3.2 excluded Redis from this stack and adding
 * it back for one feature would be a poor trade.
 *
 * ── The policy numbers, and the school-behind-one-NAT problem ────────────
 * Per-IP limits are the obvious control and, in this market, the dangerous
 * one. A Bangladeshi school of 800 students commonly sits behind a single
 * NAT gateway, so every request from that school shares one source IP. A
 * per-IP limit tuned as if one IP meant one person would lock out an entire
 * school on the morning of rollout — the precise moment the product cannot
 * afford to fail.
 *
 * So the two dimensions carry deliberately different jobs:
 *
 *   per-identity  strict. This is the real abuse control — hammering one
 *                 phone number with OTP requests, or one account draining
 *                 the AI budget.
 *   per-IP        generous. Sized so a whole school can work through one
 *                 gateway, tight enough to stop a single scripted host.
 *
 * The numbers below are a starting position, not a measured one — there is
 * no production traffic to tune against yet. They are deliberately loose on
 * the IP axis; tightening after the first pilot is safe, and locking out a
 * pilot school on day one is not.
 *
 * ── Failure behaviour ───────────────────────────────────────────────────
 * If the limiter's own query fails, requests are ALLOWED through and the
 * error is logged. A rate limiter that converts a database hiccup into a
 * total outage is worse than the abuse it prevents — and every endpoint
 * here needs the same database anyway, so a genuinely dead database fails
 * the request one step later regardless.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { sharedDb } from './db.ts';
import { json } from './http.ts';

/** Endpoint classes. Stricter classes are the ones F-102 names explicitly. */
export type RateLimitClass =
  | 'otp_request'
  | 'otp_verify'
  | 'auth'
  | 'ai'
  | 'mutation'
  | 'read'
  | 'service';

interface Bucket { capacity: number; refill: number }   // refill = tokens/second
interface Policy { ip: Bucket; identity?: Bucket }

const perHour = (n: number): number => n / 3600;

/**
 * Capacity is the burst allowance; refill is the sustained rate. A bucket
 * starts full, so `capacity` is also what a cold client may spend at once.
 */
export const RATE_LIMITS: Record<RateLimitClass, Policy> = {
  // Hammering one phone with OTPs is the attack; 3/hour per phone stops it
  // dead. The IP allowance has to clear a whole school activating at once.
  otp_request: { ip: { capacity: 240, refill: perHour(240) }, identity: { capacity: 3, refill: perHour(3) } },

  // Verification is a guessing attack against a 6-digit code. identity-svc
  // already caps attempts per challenge; this bounds the outer loop of
  // requesting a fresh challenge and guessing again.
  otp_verify: { ip: { capacity: 600, refill: perHour(600) }, identity: { capacity: 10, refill: perHour(10) } },

  // Refresh and logout — authenticated, cheap, but part of the auth surface.
  auth: { ip: { capacity: 600, refill: perHour(600) } },

  // The only endpoint class with real per-request cost. Per-identity is the
  // spend control until F-1310's proper token metering lands.
  ai: { ip: { capacity: 600, refill: perHour(600) }, identity: { capacity: 30, refill: perHour(30) } },

  // Ordinary authenticated traffic. Sized for a school, not a person: a
  // sync/push after a day offline is one request, not many.
  mutation: { ip: { capacity: 900, refill: 15 } },
  read: { ip: { capacity: 1800, refill: 30 } },

  // Machine-to-machine: MFS webhooks, cron workers, ANS dispatch. Already
  // gated by signature or service key; this is a backstop against a loop.
  service: { ip: { capacity: 3000, refill: 50 } },
};

/**
 * Client IP. On Vercel the platform sets x-forwarded-for and the left-most
 * entry is the real client. Behind a different proxy this header is
 * attacker-controlled, so it must not be trusted as an identity — which is
 * exactly why the per-identity bucket exists and carries the strict limit.
 */
export function clientIp(req: IncomingMessage): string {
  const xff = req.headers['x-forwarded-for'];
  const first = Array.isArray(xff) ? xff[0] : xff;
  const ip = first?.split(',')[0]?.trim()
    || (req.headers['x-real-ip'] as string | undefined)?.trim()
    || req.socket?.remoteAddress
    || 'unknown';
  return ip.slice(0, 64);
}

export interface BucketSpec { key: string; capacity: number; refill: number }

/**
 * Buckets are keyed by class so limits never bleed across endpoint types.
 * Exported for the test suite — key construction is the part where a wrong
 * edit is silent (two classes sharing a key looks fine until a school is
 * locked out of reads by its own OTP traffic).
 */
export function buildBuckets(cls: RateLimitClass, ip: string | null, identity?: string | null): BucketSpec[] {
  const policy = RATE_LIMITS[cls];
  const buckets: BucketSpec[] = [];
  if (ip) {
    buckets.push({ key: `${cls}:ip:${ip}`, capacity: policy.ip.capacity, refill: policy.ip.refill });
  }
  if (policy.identity && identity) {
    buckets.push({
      key: `${cls}:id:${identity}`,
      capacity: policy.identity.capacity,
      refill: policy.identity.refill,
    });
  }
  return buckets;
}

export interface RateLimitVerdict { allowed: boolean; retryAfterSec: number }

/** Consume a token from every applicable bucket. Fails open — see header. */
export async function consumeRateLimit(
  cls: RateLimitClass,
  ip: string | null,
  identity?: string | null,
): Promise<RateLimitVerdict> {
  const buckets = buildBuckets(cls, ip, identity);
  if (buckets.length === 0) return { allowed: true, retryAfterSec: 0 };
  try {
    const db = await sharedDb();
    // No tenant context: these buckets are platform infrastructure and the
    // most important ones are consumed before any tenant is known. The
    // SECURITY DEFINER function is the only access path (migration 020).
    const { rows } = await db.pool.query<{
      allowed: boolean; retry_after_sec: number; blocked_key: string | null;
    }>('SELECT * FROM app.rate_limit_consume($1::jsonb)', [JSON.stringify(buckets)]);

    const row = rows[0];
    if (!row) return { allowed: true, retryAfterSec: 0 };
    if (!row.allowed) {
      // Logged, never returned: which bucket refused would tell an attacker
      // whether a given phone number or account exists.
      console.warn(`[rate-limit] refused ${cls}, bucket=${row.blocked_key}, retry=${row.retry_after_sec}s`);
    }
    return { allowed: row.allowed, retryAfterSec: row.retry_after_sec };
  } catch (err) {
    console.error('[rate-limit] check failed, allowing request:', err);
    return { allowed: true, retryAfterSec: 0 };
  }
}

/**
 * Gate a request. Returns true when it may proceed; on refusal it writes the
 * 429 itself and returns false, so a caller reads:
 *
 *     if (!(await enforceRateLimit(req, res, cors, 'otp_request', phone))) return;
 *
 * Writing the response here rather than throwing keeps Retry-After attached
 * to the reply — an HttpError would lose the header in the generic catch
 * blocks every dispatcher already has.
 */
export async function enforceRateLimit(
  req: IncomingMessage,
  res: ServerResponse,
  cors: Record<string, string>,
  cls: RateLimitClass,
  identity?: string | null,
): Promise<boolean> {
  const verdict = await consumeRateLimit(cls, clientIp(req), identity);
  return sendIfRefused(res, cors, verdict);
}

/**
 * Identity-dimension only, for the case where the identity is not known
 * until the handler has parsed the body — an OTP request's phone number
 * being the one that matters. The dispatcher has already charged the IP
 * bucket for this request; charging it a second time here would halve
 * every IP allowance for no benefit.
 */
export async function enforceIdentityRateLimit(
  res: ServerResponse,
  cors: Record<string, string>,
  cls: RateLimitClass,
  identity: string,
): Promise<boolean> {
  const verdict = await consumeRateLimit(cls, null, identity);
  return sendIfRefused(res, cors, verdict);
}

function sendIfRefused(
  res: ServerResponse,
  cors: Record<string, string>,
  verdict: RateLimitVerdict,
): boolean {
  if (verdict.allowed) return true;
  json(
    res,
    429,
    {
      error: 'rate_limited',
      message: 'too many requests — please wait before trying again',
      retryAfterSec: verdict.retryAfterSec,
    },
    { ...cors, 'Retry-After': String(verdict.retryAfterSec) },
  );
  return false;
}
