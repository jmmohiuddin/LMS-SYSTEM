/**
 * Minimal request/response helpers for Vercel Node serverless functions.
 * There is no framework here on purpose — see services/sync-svc/api/push.ts,
 * whose CORS/header/readBody/json shape this generalises.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';

/**
 * R-8 §1/§8. Which origins may read an authenticated response.
 *
 * `*` has been correct-but-broad since the beginning. It is not a CSRF hole —
 * this API authenticates by bearer token and never by cookie, so a browser
 * sends no ambient credential and a hostile page has nothing to ride on. What
 * `*` does cost is defence in depth: any origin may call the API, and a token
 * that leaked into one could be used from it.
 *
 * `ALLOWED_ORIGINS` narrows that. Unset — every deployment today — the
 * behaviour is exactly what it was, because a production control that breaks
 * an unconfigured deployment is a control nobody turns on.
 *
 * The request's own origin is echoed rather than the list being returned, and
 * `Vary: Origin` goes with it: a shared cache must not serve one origin's
 * allowed response to another.
 */
function allowedOrigins(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env.ALLOWED_ORIGINS ?? '')
    .split(',').map((o) => o.trim()).filter((o) => o.length > 0);
}

export function corsOriginFor(
  requestOrigin: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): { origin: string; vary: boolean } {
  const allow = allowedOrigins(env);
  if (allow.length === 0) return { origin: '*', vary: false };
  // A request with no Origin header is not a browser cross-origin request —
  // curl, a cron, a native client. It is refused an echo rather than given a
  // wildcard, which would defeat the list for exactly the caller most able to
  // omit the header.
  if (requestOrigin && allow.includes(requestOrigin)) {
    return { origin: requestOrigin, vary: true };
  }
  return { origin: allow[0], vary: true };
}

export function corsHeaders(
  extraHeaders: string[] = [],
  methods = 'GET, POST, OPTIONS',
  requestOrigin?: string,
): Record<string, string> {
  const { origin, vary } = corsOriginFor(requestOrigin);
  return {
    ...(vary ? { Vary: 'Origin' } : {}),
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': methods,
    'Access-Control-Allow-Headers': [
      'Content-Type',
      'Authorization',
      'X-Tenant-ID',
      'X-User-ID',
      'X-Role',
      ...extraHeaders,
    ].join(', '),
  };
}

export function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export function header(req: IncomingMessage, name: string): string {
  const v = req.headers[name.toLowerCase()];
  return Array.isArray(v) ? v[0] ?? '' : v ?? '';
}

export function query(req: IncomingMessage): URLSearchParams {
  const url = new URL(req.url ?? '/', 'http://internal');
  return url.searchParams;
}

export async function readJson<T>(req: IncomingMessage): Promise<T> {
  const raw = await readBody(req);
  return JSON.parse(raw) as T;
}

export function json(res: ServerResponse, code: number, body: unknown, cors: Record<string, string>): void {
  const payload = JSON.stringify(body);
  res.writeHead(code, { ...cors, 'Content-Type': 'application/json' });
  res.end(payload);
}

export class HttpError extends Error {
  // Longhand rather than constructor parameter properties: node --test
  // strips types instead of compiling them, and parameter properties are the
  // one TS-only construct it cannot strip. Since every server module reaches
  // this file, that single construct made all of server-core un-testable
  // under the project's `node --test file.ts` convention.
  readonly status: number;
  readonly code?: string;
  /**
   * Structured context spread into the error body alongside `error` and
   * `message`. For refusals a screen has to act on rather than merely print —
   * the routine editor naming the class that already owns an hour, say — a
   * sentence is what the user reads and this is what the UI renders. Optional
   * everywhere; an endpoint that has nothing to add omits it.
   */
  readonly detail?: Record<string, unknown>;

  constructor(status: number, message: string, code?: string, detail?: Record<string, unknown>) {
    super(message);
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

/**
 * What this school may do right now. Produced by `app.tenant_access` (052).
 */
export interface TenantAccess {
  access: 'full' | 'read_only' | 'none';
  opsState: string;
  billingState: string;
  /** Bangla, for the person. Null when there is nothing to explain. */
  reasonBn: string | null;
  until: string | null;
  /**
   * B-84. `app.tenant_service_state` for the service this request named, set
   * only on a refusal that named one. `not_in_plan` is a commercial fact —
   * the school never bought it — and `disabled` / `maintenance` are
   * operational ones. The remedies differ (ring sales, or wait), so the
   * screen has to be able to tell them apart without parsing Bangla prose.
   */
  serviceState?: string;
}

/**
 * The school is suspended, limited or in maintenance, and this request cannot
 * proceed.  (P7)
 *
 * An `HttpError` on purpose. Every service in this repository already ends its
 * handler with `if (err instanceof HttpError) { json(res, err.status, …) }`,
 * fifty-four times over. Making this a subclass means all fifty-four already
 * refuse correctly, with the right status and a sentence a school can read —
 * rather than fifty-four edits, of which the forgotten one is an endpoint that
 * keeps serving a suspended school.
 *
 * **403, not 402.** A school in arrears is refused for a commercial reason,
 * but every client in this product already knows what a 403 means — `isDenied`
 * tests for exactly it — and none of them knows what a 402 means.
 */
export class TenantBlocked extends HttpError {
  readonly access: TenantAccess;
  /**
   * The same sentence as `message`, under the name the rest of the product
   * uses for a Bangla string meant for a person. `message` is what a log
   * shows; this is what a screen shows, and keeping both makes it obvious at
   * a call site which one is being read.
   */
  readonly reasonBn: string;

  constructor(access: TenantAccess) {
    // `tenant_blocked`, not `forbidden`: the remedy is completely different —
    // a refused ROLE needs a different person, a blocked TENANT needs a
    // payment or a call to us — and the screen has to say which.
    super(
      403,
      access.reasonBn ?? 'এই প্রতিষ্ঠানের অ্যাকাউন্টে এখন এই কাজটি করা যাচ্ছে না।',
      'tenant_blocked',
      {
        access: access.access,
        opsState: access.opsState,
        billingState: access.billingState,
        until: access.until,
        // B-84. Present only when a service was named. `not_in_plan` means
        // buy it; `disabled` and `maintenance` mean wait or ring us. Those
        // are different errands for the office and the screen must be able
        // to send them on the right one.
        ...(access.serviceState ? { serviceState: access.serviceState } : {}),
      },
    );
    this.access = access;
    this.reasonBn = this.message;
  }
}
