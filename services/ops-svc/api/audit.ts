/**
 * GET /api/v1/ops/audit — the institution's own change history, read-only
 *
 * R-3 completion pass, the last of its three gaps. Migration 041 made
 * `audit.activity_log` readable by management and R-3's mutations began
 * writing to it; nothing displayed it. F-1603's screen.
 *
 * ── Read-only means read-only ───────────────────────────────────────────
 * GET is the only method. 010 revokes UPDATE and DELETE from the application
 * role and 041 deliberately did not restore them, so there is no write path
 * to expose even if somebody added one here. A trail its subject can edit is
 * decoration.
 *
 * ── Who may read it ─────────────────────────────────────────────────────
 * `activity_read_scope` (041) admits principal, school_owner and it_admin.
 * requireRole mirrors it. A class teacher browsing the institution's change
 * history is a different product: they would see every user creation, every
 * fee-permission change, every promotion, for children who are not theirs.
 *
 * ── Redaction, and why there is not much to redact ──────────────────────
 * The `before_state` / `after_state` blobs are written by
 * server-core/audit.ts, whose contract is already "small diffs, never PII" —
 * the enrolment move logs student IDS, not names, for exactly this reason.
 * But a contract is not a guarantee against a future caller, so this endpoint
 * masks defensively on the way OUT: any key that looks like a phone, an email,
 * a national ID or a credential is replaced with '•••'. Masking at read time
 * rather than write time is deliberate — the log keeps what happened, and the
 * screen shows what a reader is allowed to see.
 *
 * A phone number is masked to its last two digits rather than removed
 * entirely, because "the number was changed to one ending 47" is what makes
 * an audit entry useful to the person checking it.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { sharedDb } from '../../../packages/server-core/src/db.ts';
import { corsHeaders, json, query, HttpError } from '../../../packages/server-core/src/http.ts';
import { authenticate, requireRole } from '../../../packages/server-core/src/auth.ts';

/** Mirrors activity_read_scope in migration 041. */
const AUDIT_READERS = ['principal', 'school_owner', 'it_admin'];

const PAGE = 50;

/**
 * Keys whose values never leave this endpoint intact, matched
 * case-insensitively on the key name rather than by sniffing values — a
 * value-sniffing redactor misses a phone stored as a number and mangles a
 * roll number that looks like one.
 */
const SENSITIVE_KEY = /(phone|mobile|email|nid|brc|password|secret|token|otp|dob|birth|account)/i;

/** Last two digits kept: enough to recognise, not enough to dial. */
function maskValue(v: unknown): unknown {
  if (typeof v !== 'string' || v.length === 0) return '•••';
  const tail = v.slice(-2);
  return /^\d+$/.test(tail) ? `•••${tail}` : '•••';
}

function redact(value: unknown, depth = 0): unknown {
  if (depth > 6 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SENSITIVE_KEY.test(k) ? maskValue(v) : redact(v, depth + 1);
  }
  return out;
}

interface Row {
  id: string;
  created_at: string;
  actor_id: string | null;
  actor_role: string | null;
  actor_name: string | null;
  action: string;
  entity_type: string | null;
  entity_id: string | null;
  before_state: unknown;
  after_state: unknown;
}

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const cors = corsHeaders([], 'GET, OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }
  if (req.method !== 'GET') { json(res, 405, { error: 'method_not_allowed' }, cors); return; }

  try {
    const claims = await authenticate(req);
    requireRole(claims, AUDIT_READERS);

    const db = await sharedDb();
    const ctx = { tenantId: claims.tid, userId: claims.sub, role: claims.role };
    const q = query(req);

    const action = (q.get('action') ?? '').trim();
    const entityType = (q.get('entityType') ?? '').trim();
    const actorId = (q.get('actorId') ?? '').trim();
    const from = (q.get('from') ?? '').trim();
    const to = (q.get('to') ?? '').trim();
    const offset = Math.max(0, Number(q.get('offset') ?? 0) || 0);

    for (const [v, name] of [[from, 'from'], [to, 'to']] as [string, string][]) {
      if (v && !/^\d{4}-\d{2}-\d{2}$/.test(v)) {
        throw new HttpError(400, 'তারিখ YYYY-MM-DD আকারে দিন', 'bad_date', { field: name });
      }
    }

    const body = await db.withTenant(ctx, async (c) => {
      // RLS is what scopes this to the caller's institution — there is no
      // tenant_id in the WHERE clause and no tenant parameter in the URL.
      // Fetch PAGE + 1 to know whether there is another page without a
      // second COUNT(*) over a table that only grows.
      const { rows } = await c.query<Row>(
        `SELECT a.id::text, a.created_at::text, a.actor_id, a.actor_role,
                u.full_name_bn AS actor_name, a.action, a.entity_type,
                a.entity_id::text, a.before_state, a.after_state
           FROM audit.activity_log a
           LEFT JOIN users u ON u.id = a.actor_id
          -- The uuid and date filters are passed as NULL, not as an empty
          -- string. PostgreSQL evaluates a constant cast at plan time, so
          -- comparing an empty string cast to uuid throws "invalid input
          -- syntax for type uuid" even though the OR would short-circuit --
          -- and the no-filter case is the DEFAULT view of this screen, so
          -- every first load would have been a 500. Found by running the
          -- query rather than by reading it.
          WHERE ($1 = '' OR a.action = $1)
            AND ($2 = '' OR a.entity_type = $2)
            AND ($3::uuid IS NULL OR a.actor_id = $3::uuid)
            AND ($4::date IS NULL OR a.created_at >= $4::date)
            -- The upper bound is inclusive of the whole day: a person
            -- filtering "to the 5th" means the end of the 5th, not its
            -- first instant.
            AND ($5::date IS NULL OR a.created_at < ($5::date + 1))
          ORDER BY a.created_at DESC, a.id DESC
          LIMIT $6 OFFSET $7`,
        // Empty string means "no filter" to the caller and NULL to postgres.
        [action, entityType, actorId || null, from || null, to || null, PAGE + 1, offset],
      );

      // The distinct values actually present, so the filter dropdowns offer
      // what this school has done rather than every action the code can emit.
      const { rows: facets } = await c.query<{ kind: string; value: string; n: number }>(
        `SELECT 'action' AS kind, action AS value, count(*)::int AS n
           FROM audit.activity_log GROUP BY action
          UNION ALL
         SELECT 'entity_type', entity_type, count(*)::int
           FROM audit.activity_log WHERE entity_type IS NOT NULL GROUP BY entity_type
          ORDER BY kind, value`,
      );

      const { rows: actors } = await c.query<{ id: string; name_bn: string | null; n: number }>(
        `SELECT a.actor_id::text AS id, u.full_name_bn AS name_bn, count(*)::int AS n
           FROM audit.activity_log a
           LEFT JOIN users u ON u.id = a.actor_id
          WHERE a.actor_id IS NOT NULL
          GROUP BY a.actor_id, u.full_name_bn
          ORDER BY count(*) DESC
          LIMIT 25`,
      );

      const page = rows.slice(0, PAGE);
      return {
        entries: page.map((r) => ({
          id: r.id,
          at: r.created_at,
          actor: {
            id: r.actor_id,
            // A deleted or foreign actor id shows as the id rather than as
            // blank: "who did this" with no answer is the one thing an audit
            // entry must not say.
            nameBn: r.actor_name ?? (r.actor_id ? '(অজানা)' : '(সিস্টেম)'),
            role: r.actor_role,
          },
          action: r.action,
          entityType: r.entity_type,
          entityId: r.entity_id,
          before: redact(r.before_state),
          after: redact(r.after_state),
        })),
        hasMore: rows.length > PAGE,
        offset,
        pageSize: PAGE,
        facets: {
          actions: facets.filter((f) => f.kind === 'action')
            .map((f) => ({ value: f.value, count: f.n })),
          entityTypes: facets.filter((f) => f.kind === 'entity_type')
            .map((f) => ({ value: f.value, count: f.n })),
          actors: actors.map((a) => ({
            id: a.id, nameBn: a.name_bn ?? '(অজানা)', count: a.n,
          })),
        },
      };
    });

    json(res, 200, body, cors);
  } catch (err) {
    if (err instanceof HttpError) {
      json(res, err.status, { error: err.code, message: err.message, ...(err.detail ?? {}) }, cors);
      return;
    }
    json(res, 500, { error: 'internal_error' }, cors);
  }
}
