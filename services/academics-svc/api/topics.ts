/**
 * GET /api/v1/academics/topics?chapterId=   → topics in a chapter
 * GET /api/v1/academics/topics?topicId=    → one topic with its blocks
 *
 * The second form is what the reader screen calls, and it returns the whole
 * topic (all blocks, ordered) in one response so the PWA can cache the
 * entire topic for offline reading in a single request. Splitting blocks
 * into their own paginated endpoint would make offline download of a
 * chapter an N+1 problem over a 2G link.
 *
 * Progress writes do NOT go here — they ride the offline outbox as
 * `topic_progress` ops into POST /api/v1/sync/push (see
 * services/sync-svc/src/appliers.ts), same as attendance and marks.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { sharedDb } from '../../../packages/server-core/src/db.ts';
import { corsHeaders, query, json, HttpError } from '../../../packages/server-core/src/http.ts';
import { authenticate } from '../../../packages/server-core/src/auth.ts';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const cors = corsHeaders();
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }
  if (req.method !== 'GET') { json(res, 405, { error: 'method_not_allowed' }, cors); return; }

  try {
    const claims = await authenticate(req);
    const q = query(req);
    const chapterId = q.get('chapterId') ?? '';
    const topicId = q.get('topicId') ?? '';

    if (!chapterId && !topicId) {
      throw new HttpError(400, 'chapterId or topicId is required', 'missing_parameter');
    }
    if (chapterId && !UUID_RE.test(chapterId)) {
      throw new HttpError(400, 'chapterId must be a valid uuid', 'invalid_chapter_id');
    }
    if (topicId && !UUID_RE.test(topicId)) {
      throw new HttpError(400, 'topicId must be a valid uuid', 'invalid_topic_id');
    }

    const db = await sharedDb();
    const ctx = { tenantId: claims.tid, userId: claims.sub, role: claims.role };

    /* ------------------------------------------------ single topic + blocks */
    if (topicId) {
      const result = await db.withTenant(ctx, async (client) => {
        const topicRes = await client.query<{
          id: string; topic_no: number; title_bn: string; title_en: string | null;
          est_minutes: number; chapter_id: string; chapter_name_bn: string;
          state: string | null; seconds_spent: number | null; last_block_no: number | null;
        }>(
          `SELECT l.id, l.topic_no, l.title_bn, l.title_en, l.est_minutes,
                  l.chapter_id, ch.name_bn AS chapter_name_bn,
                  lp.state, lp.seconds_spent, lp.last_block_no
             FROM topics l
             JOIN chapters ch ON ch.id = l.chapter_id
             LEFT JOIN topic_progress lp
               ON lp.topic_id = l.id AND lp.student_id = $2
            WHERE l.id = $1`,
          [topicId, claims.sub],
        );
        const topic = topicRes.rows[0];
        if (!topic) throw new HttpError(404, 'topic not found', 'topic_not_found');

        const blocksRes = await client.query<{
          id: string; block_no: number; kind: string;
          body_bn: string | null; media_key: string | null;
          alt_text_bn: string | null; caption_bn: string | null;
        }>(
          `SELECT id, block_no, kind::text, body_bn, media_key, alt_text_bn, caption_bn
             FROM topic_blocks
            WHERE topic_id = $1
            ORDER BY block_no`,
          [topicId],
        );

        return {
          topic: {
            id: topic.id,
            topicNo: topic.topic_no,
            title: { bn: topic.title_bn, en: topic.title_en },
            estMinutes: topic.est_minutes,
            chapter: { id: topic.chapter_id, nameBn: topic.chapter_name_bn },
            progress: topic.state
              ? {
                  state: topic.state,
                  secondsSpent: topic.seconds_spent ?? 0,
                  lastBlockNo: topic.last_block_no,
                }
              : null,
          },
          blocks: blocksRes.rows.map((b) => ({
            id: b.id,
            blockNo: b.block_no,
            kind: b.kind,
            bodyBn: b.body_bn,
            mediaKey: b.media_key,
            altTextBn: b.alt_text_bn,
            captionBn: b.caption_bn,
          })),
        };
      });
      json(res, 200, result, cors);
      return;
    }

    /* -------------------------------------------------- topic list for chapter */
    const topics = await db.withTenant(ctx, async (client) => {
      const r = await client.query<{
        id: string; topic_no: number; title_bn: string; title_en: string | null;
        est_minutes: number; is_published: boolean;
        state: string | null; seconds_spent: number | null;
      }>(
        `SELECT l.id, l.topic_no, l.title_bn, l.title_en, l.est_minutes, l.is_published,
                lp.state, lp.seconds_spent
           FROM topics l
           LEFT JOIN topic_progress lp
             ON lp.topic_id = l.id AND lp.student_id = $2
          WHERE l.chapter_id = $1
          ORDER BY l.display_order, l.topic_no`,
        [chapterId, claims.sub],
      );
      return r.rows;
    });

    json(res, 200, {
      chapterId,
      topics: topics.map((l) => ({
        id: l.id,
        topicNo: l.topic_no,
        title: { bn: l.title_bn, en: l.title_en },
        estMinutes: l.est_minutes,
        isPublished: l.is_published,
        progress: l.state ? { state: l.state, secondsSpent: l.seconds_spent ?? 0 } : null,
      })),
    }, cors);
  } catch (err) {
    if (err instanceof HttpError) {
      json(res, err.status, { error: err.code ?? 'error', message: err.message }, cors);
      return;
    }
    console.error('[topics] unexpected error', err);
    json(res, 500, { error: 'internal_error' }, cors);
  }
}
