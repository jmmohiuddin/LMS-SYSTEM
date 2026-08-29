/**
 * GET  /api/v1/ops/notices        — notices this caller may see (author view)
 * POST /api/v1/ops/notices        — create, and publish in the same call
 *
 * R-2 of docs/11-MASTER-PLAN.md. The endpoint a head teacher uses to tell the
 * school something.
 *
 * ── The client sends INTENT, never a recipient list ─────────────────────
 * The body carries `audience: {type:'section', ids:[…]}`. Who that actually
 * reaches — which students are enrolled in those sections today, which
 * guardians those students have — is resolved by app.resolve_notice_audience()
 * inside the tenant's own context, at publish time.
 *
 * A client that sent the recipient list would be asking the server to trust a
 * roster the client assembled. That is the confused-deputy shape R-1 removed
 * from the branding endpoints, and it is worse here: the wrong roster does not
 * show one school another school's logo, it tells 900 guardians something that
 * was meant for the staff.
 *
 * ── A class teacher may write, but only to their own sections ───────────
 * The RLS policy admits four roles to INSERT. Narrowing a class teacher to the
 * sections they actually teach happens HERE, against app.my_section_ids(),
 * because expressing "every id in this jsonb array is a section you teach" as
 * a policy predicate would be a second implementation of that function — and
 * the two would disagree eventually, in whichever direction is more permissive.
 *
 * ── Publish is one transaction ──────────────────────────────────────────
 * Resolve → insert receipts → emit the SMS event → stamp the notice, all
 * inside app.publish_notice(). A notice that is "published" but reached nobody
 * is worse than one that failed, because nothing reports it.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { sharedDb } from '../../../packages/server-core/src/db.ts';
import { corsHeaders, readJson, json, query, HttpError } from '../../../packages/server-core/src/http.ts';
import { authenticate, requireRole } from '../../../packages/server-core/src/auth.ts';
import {
  parseNotice,
  NoticeError,
  type NoticeDraft,
} from '../../../packages/ui-core/src/notice.ts';

/**
 * Who may publish at all. Mirrors the notice_write_scope RLS policy — the
 * policy is the boundary, this is the clean 403 in front of it.
 */
const AUTHOR_ROLES = ['principal', 'school_owner', 'academic_coordinator', 'class_teacher'];
/** Roles whose reach is the whole institution. */
const SCHOOL_WIDE_ROLES = new Set(['principal', 'school_owner', 'academic_coordinator']);

interface NoticeRow {
  id: string;
  title: string;
  body: string;
  category: string;
  audience: unknown;
  send_sms: boolean;
  status: string;
  published_at: string | null;
  recipient_count: number;
  created_at: string;
}

/**
 * A class teacher may address only sections they teach — and only by section.
 * "All guardians" from a class teacher is a school-wide broadcast wearing a
 * narrower job title.
 */
async function assertAudienceAllowed(
  client: { query: (q: string, p?: unknown[]) => Promise<{ rows: { ok: boolean }[] }> },
  role: string,
  draft: NoticeDraft,
): Promise<void> {
  if (SCHOOL_WIDE_ROLES.has(role)) return;

  if (draft.audience.type !== 'section') {
    throw new HttpError(403,
      'a class teacher may publish to their own sections only',
      'audience_not_permitted', { field: 'audience' });
  }
  const ids = draft.audience.ids ?? [];
  const { rows } = await client.query(
    `SELECT ($1::uuid[] <@ app.my_section_ids()) AS ok`,
    [ids],
  );
  if (!rows[0]?.ok) {
    throw new HttpError(403,
      'one or more of those sections is not yours',
      'audience_not_permitted', { field: 'audience' });
  }
}

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const cors = corsHeaders([], 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }

  try {
    const claims = await authenticate(req);
    const db = await sharedDb();
    const ctx = { tenantId: claims.tid, userId: claims.sub, role: claims.role };

    // ── List ──────────────────────────────────────────────────────────
    if (req.method === 'GET') {
      const limit = Math.min(100, Math.max(1, Number(query(req).get('limit') ?? 50)));
      const notices = await db.withTenant(ctx, async (c) => {
        // RLS (notice_read_scope) decides what is visible: management sees
        // everything, everyone else sees what they hold a receipt for or
        // wrote themselves. No WHERE clause here does that work.
        const { rows } = await c.query<NoticeRow>(
          `SELECT id, title, body, category, audience, send_sms, status,
                  published_at, recipient_count, created_at
             FROM notices
            ORDER BY COALESCE(published_at, created_at) DESC
            LIMIT $1`,
          [limit],
        );
        return rows;
      });
      json(res, 200, { notices }, cors);
      return;
    }

    if (req.method !== 'POST') {
      json(res, 405, { error: 'method_not_allowed' }, cors);
      return;
    }

    // ── Create (+ publish) ────────────────────────────────────────────
    requireRole(claims, AUTHOR_ROLES);

    const body = await readJson<{ notice?: unknown; publish?: boolean }>(req);
    let draft: NoticeDraft;
    try {
      draft = parseNotice(body.notice);
    } catch (err) {
      if (err instanceof NoticeError) {
        throw new HttpError(400, err.message, 'invalid_notice', { field: err.field });
      }
      throw err;
    }

    const result = await db.withTenant(ctx, async (c) => {
      await assertAudienceAllowed(c as never, claims.role, draft);

      const inserted = await c.query<{ id: string }>(
        `INSERT INTO notices
           (tenant_id, title, body, category, audience, send_sms, created_by)
         VALUES (app.current_tenant(), $1, $2, $3::notice_category, $4::jsonb, $5, $6)
         RETURNING id`,
        [draft.title, draft.body, draft.category,
         JSON.stringify(draft.audience), draft.sendSms, claims.sub],
      );
      const noticeId = inserted.rows[0].id;

      // A draft is a notice nobody has been told about; publishing is what
      // makes it real, and the default is to publish because that is what an
      // author who pressed "send" meant.
      if (body.publish === false) {
        return { noticeId, status: 'draft', recipients: 0, smsQueued: false };
      }

      const pub = await c.query<{ recipients: number; sms_event: boolean }>(
        `SELECT recipients, sms_event FROM app.publish_notice($1::uuid)`,
        [noticeId],
      );
      return {
        noticeId,
        status: 'published',
        recipients: pub.rows[0]?.recipients ?? 0,
        // The event is queued; sms-svc decides per recipient whether it
        // survives the cap, the weekend, the holiday and consent.
        smsQueued: pub.rows[0]?.sms_event ?? false,
      };
    });

    json(res, 201, result, cors);
  } catch (err) {
    if (err instanceof HttpError) {
      json(res, err.status,
        { error: err.code ?? 'error', message: err.message, ...(err.detail ?? {}) }, cors);
      return;
    }
    const code = (err as { code?: string }).code;
    // 42501 from the audience resolver means the session context was wrong —
    // a bug here, not a caller error.
    if (code === '22023') {
      json(res, 400, { error: 'invalid_audience', message: 'that audience selects nobody' }, cors);
      return;
    }
    json(res, 500, { error: 'internal_error' }, cors);
  }
}
