/**
 * GET  /api/v1/ops/inbox        — this person's notices + unread count
 * POST /api/v1/ops/inbox        — mark read: { noticeId } or { all: true }
 *
 * R-2 of docs/11-MASTER-PLAN.md. The bell, and what is behind it.
 *
 * ── Every signed-in role reads their own inbox ──────────────────────────
 * There is no requireRole here on purpose. A student, a guardian, a teacher
 * and the head teacher all have an inbox; what differs is what is IN it, and
 * that was decided at publish time when the receipts were written. The read
 * path does not interpret audiences at all — it selects the caller's own
 * receipt rows, and `receipt_read_scope` (RLS) is what confines it.
 *
 * That is the answer to "can a student see a teachers-only notice?": not
 * because the category says so, not because the UI hides it, but because no
 * receipt exists for them, and the RESTRICTIVE policy on notices only admits
 * rows the caller holds a receipt for.
 *
 * ── One round trip ──────────────────────────────────────────────────────
 * The bell needs a count and the inbox needs a list, and a bell that costs a
 * second request would be a request on every screen. Both come back together,
 * like /academics/ward does for the guardian home.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { sharedDb } from '../../../packages/server-core/src/db.ts';
import { corsHeaders, readJson, json, query, HttpError } from '../../../packages/server-core/src/http.ts';
import { authenticate } from '../../../packages/server-core/src/auth.ts';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface InboxRow {
  receipt_id: string;
  notice_id: string;
  title: string;
  body: string;
  category: string;
  delivered_at: string;
  read_at: string | null;
  about_student_id: string | null;
  about_student_name: string | null;
}

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const cors = corsHeaders([], 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }

  try {
    const claims = await authenticate(req);
    const db = await sharedDb();
    const ctx = { tenantId: claims.tid, userId: claims.sub, role: claims.role };

    // ── Read the inbox ────────────────────────────────────────────────
    if (req.method === 'GET') {
      const limit = Math.min(100, Math.max(1, Number(query(req).get('limit') ?? 30)));
      const unreadOnly = query(req).get('unread') === '1';

      const out = await db.withTenant(ctx, async (c) => {
        const { rows } = await c.query<InboxRow>(
          `SELECT r.id            AS receipt_id,
                  n.id            AS notice_id,
                  n.title, n.body, n.category,
                  r.delivered_at, r.read_at,
                  r.about_student_id,
                  s.full_name_bn  AS about_student_name
             FROM notice_receipts r
             JOIN notices n ON n.id = r.notice_id
             LEFT JOIN users s ON s.id = r.about_student_id
            WHERE r.user_id = app.current_user_id()
              AND ($1::boolean = false OR r.read_at IS NULL)
            ORDER BY r.delivered_at DESC
            LIMIT $2`,
          [unreadOnly, limit],
        );

        // Counted separately rather than from the page above: the badge must
        // say 47 when the list shows 30.
        const count = await c.query<{ unread: string }>(
          `SELECT count(*) AS unread FROM notice_receipts
            WHERE user_id = app.current_user_id() AND read_at IS NULL`,
        );
        return { rows, unread: Number(count.rows[0]?.unread ?? 0) };
      });

      json(res, 200, {
        unread: out.unread,
        notices: out.rows.map((r) => ({
          receiptId: r.receipt_id,
          noticeId: r.notice_id,
          title: r.title,
          body: r.body,
          category: r.category,
          deliveredAt: r.delivered_at,
          readAt: r.read_at,
          // Present only on a guardian's receipt: which child this is about.
          aboutStudent: r.about_student_id
            ? { id: r.about_student_id, nameBn: r.about_student_name }
            : null,
        })),
      }, cors);
      return;
    }

    if (req.method !== 'POST') {
      json(res, 405, { error: 'method_not_allowed' }, cors);
      return;
    }

    // ── Mark read ─────────────────────────────────────────────────────
    const body = await readJson<{ noticeId?: string; all?: boolean }>(req);
    if (!body.all && !UUID_RE.test(body.noticeId ?? '')) {
      throw new HttpError(400, 'send a noticeId, or all:true', 'invalid_request');
    }

    const marked = await db.withTenant(ctx, async (c) => {
      // `user_id = current_user` appears here AND in receipt_update_scope.
      // The policy is what makes it safe; the predicate is what makes the
      // statement say what it means.
      const { rowCount } = await c.query(
        `UPDATE notice_receipts
            SET read_at = now()
          WHERE user_id = app.current_user_id()
            AND read_at IS NULL
            AND ($1::boolean = true OR notice_id = $2::uuid)`,
        [body.all === true, body.noticeId ?? null],
      );
      return rowCount ?? 0;
    });

    // Marking an already-read notice read is not an error — a second tap on a
    // slow connection is the same intent, and 0 is the honest count.
    json(res, 200, { marked }, cors);
  } catch (err) {
    if (err instanceof HttpError) {
      json(res, err.status,
        { error: err.code ?? 'error', message: err.message, ...(err.detail ?? {}) }, cors);
      return;
    }
    json(res, 500, { error: 'internal_error' }, cors);
  }
}
