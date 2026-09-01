/**
 * Test harness for driving real serverless handlers  (F-106)
 *
 * The endpoints being backfilled (assignments, practice, next, results,
 * ledger) are almost entirely SQL. Testing them by re-implementing their
 * queries in the test would assert that two copies of a query agree, which
 * is worth nothing. So these helpers invoke the ACTUAL exported handler,
 * with a real signed JWT, against a real PostgreSQL with RLS live.
 *
 * A generated Ed25519 keypair is installed into the environment before any
 * handler is imported, so `authenticate()` and `verifyAccessToken()` run
 * unmodified — no auth stubbing, which means the tests also prove the
 * endpoints are actually gated.
 */
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { generateKeyPair, exportPKCS8, exportSPKI } from 'jose';
import pg from 'pg';

/**
 * Install a throwaway signing keypair. Must be called before the first
 * sign or verify — jwt.ts caches the imported key on first use, so a later
 * call would be silently ignored.
 */
export async function installTestKeys(): Promise<void> {
  const { privateKey, publicKey } = await generateKeyPair('EdDSA', {
    crv: 'Ed25519',
    extractable: true,
  });
  process.env.JWT_PRIVATE_KEY = await exportPKCS8(privateKey);
  process.env.JWT_PUBLIC_KEY = await exportSPKI(publicKey);
}

/**
 * Serialise DB-backed test processes against one database.
 *
 * ── The failure this prevents ─────────────────────────────────────────────
 * Every DB suite here builds its fixtures at FIXED uuids and drops them in
 * `after`. That is deliberate and readable — a test that says
 * `SEC_A = '7b06d000-…-e1'` can be reasoned about — and it is safe as long as
 * only one process owns those rows at a time. Two runs of the same suite
 * overlapping do not fail loudly; they delete each other's fixtures halfway
 * through and report a scatter of assertion failures with no common cause.
 *
 * P5 hit this once and could not reproduce it. P6 reproduced it on demand by
 * running one suite three times at once, and got the same `pass 12` P5 saw.
 *
 * `pg_advisory_lock` is session-scoped, so it is released when the connection
 * closes — including when a test process is killed, which a lock table would
 * not survive. The key is arbitrary and constant: every DB suite in this
 * repository shares one database, so they share one lock.
 */
const FIXTURE_LOCK = 8_913_224_017;

/**
 * Its OWN connection, not one from the pool. `pg_advisory_lock` is
 * session-scoped, and a pooled client returns to the pool the moment the
 * query resolves — taking the lock on one would release it immediately and
 * look like it worked.
 */
let lockClient: pg.Client | null = null;

export async function lockFixtures(connectionString: string): Promise<void> {
  if (lockClient) return;
  const client = new pg.Client({ connectionString });
  await client.connect();
  // Blocks until whoever holds it lets go. A wait, not a race.
  await client.query('SELECT pg_advisory_lock($1)', [FIXTURE_LOCK]);
  lockClient = client;
}

export async function unlockFixtures(): Promise<void> {
  if (!lockClient) return;
  const client = lockClient;
  lockClient = null;
  // Ending the connection releases the lock even if this throws — which is
  // why a session lock beats a lock TABLE: a killed test process cannot
  // leave the next one waiting forever.
  try { await client.query('SELECT pg_advisory_unlock($1)', [FIXTURE_LOCK]); }
  finally { await client.end(); }
}

export interface CapturedResponse {
  status: number;
  headers: Record<string, string>;
  body: Record<string, unknown>;
  raw: string;
}

/**
 * A ServerResponse stand-in that records what the handler wrote. Handlers
 * only ever reach `writeHead` and `end` (via http.ts's `json`), so nothing
 * larger is needed and anything else would be pretending.
 */
function captureResponse(): { res: ServerResponse; captured: CapturedResponse } {
  const captured: CapturedResponse = { status: 0, headers: {}, body: {}, raw: '' };
  const res = {
    writeHead(status: number, headers: Record<string, string> = {}) {
      captured.status = status;
      captured.headers = headers;
      return this;
    },
    end(chunk?: string) {
      if (chunk) {
        captured.raw = chunk;
        try {
          captured.body = JSON.parse(chunk) as Record<string, unknown>;
        } catch {
          /* non-JSON body; `raw` still holds it */
        }
      }
    },
  } as unknown as ServerResponse;
  return { res, captured };
}

export interface CallOptions {
  // PUT is here for /ops/branding (R-1), the first endpoint in the product
  // to replace a whole resource rather than append to one. DELETE arrived
  // with R-9's /ops/push, where a person gives up a device — and the type was
  // not widened at the time, so `tsc` had been rejecting push.test.ts ever
  // since. Nobody saw it because `node --test` strips types instead of
  // checking them, and the suite went green while the type gate stayed red.
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'OPTIONS';
  url?: string;
  token?: string;
  body?: unknown;
  headers?: Record<string, string>;
}

type Handler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

/** Invoke a handler exactly as Vercel would, and return what it wrote. */
export async function call(handler: Handler, opts: CallOptions = {}): Promise<CapturedResponse> {
  const payload = opts.body === undefined ? '' : JSON.stringify(opts.body);
  // Readable.from gives the handler a genuine stream, so readBody()'s
  // event plumbing is exercised rather than bypassed. Buffer chunks, not
  // strings: readBody does Buffer.concat, which rejects string chunks —
  // exactly as the real http server would deliver them.
  const req = Readable.from(payload ? [Buffer.from(payload, 'utf8')] : []) as unknown as IncomingMessage;
  req.method = opts.method ?? 'GET';
  req.url = opts.url ?? '/';
  req.headers = {
    ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
    ...(payload ? { 'content-type': 'application/json' } : {}),
    // Rate limiting (F-102) charges per source IP. Without a stable one,
    // every call in a suite shares the socket's address and a long suite
    // could exhaust a bucket and start getting 429s partway through —
    // a failure that would look like the endpoint's fault.
    'x-forwarded-for': opts.headers?.['x-forwarded-for'] ?? randomTestIp(),
    ...opts.headers,
  };
  const { res, captured } = captureResponse();
  await handler(req, res);
  return captured;
}

/** A fresh RFC 5737 documentation address per call, so buckets never collide. */
function randomTestIp(): string {
  const n = Math.floor(Math.random() * 65536);
  return `198.18.${(n >> 8) & 0xff}.${n & 0xff}`;
}
