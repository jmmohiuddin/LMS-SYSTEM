/**
 * GET /api/v1/academics/lessons?chapterId=   → lessons in a chapter
 * GET /api/v1/academics/lessons?lessonId=    → one lesson with its blocks
 *
 * The second form is what the reader screen calls, and it returns the whole
 * lesson (all blocks, ordered) in one response so the PWA can cache the
 * entire lesson for offline reading in a single request. Splitting blocks
 * into their own paginated endpoint would make offline download of a
 * chapter an N+1 problem over a 2G link.
 *
 * Progress writes do NOT go here — they ride the offline outbox as
 * `lesson_progress` ops into POST /api/v1/sync/push (see
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
    const lessonId = q.get('lessonId') ?? '';

    if (!chapterId && !lessonId) {
      throw new HttpError(400, 'chapterId or lessonId is required', 'missing_parameter');
    }
    if (chapterId && !UUID_RE.test(chapterId)) {
      throw new HttpError(400, 'chapterId must be a valid uuid', 'invalid_chapter_id');
    }
    if (lessonId && !UUID_RE.test(lessonId)) {
      throw new HttpError(400, 'lessonId must be a valid uuid', 'invalid_lesson_id');
    }

    const db = await sharedDb();
    const ctx = { tenantId: claims.tid, userId: claims.sub, role: claims.role };

    /* ------------------------------------------------ single lesson + blocks */
    if (lessonId) {
      const result = await db.withTenant(ctx, async (client) => {
        const lessonRes = await client.query<{
          id: string; lesson_no: number; title_bn: string; title_en: string | null;
          est_minutes: number; chapter_id: string; chapter_name_bn: string;
          state: string | null; seconds_spent: number | null; last_block_no: number | null;
        }>(
          `SELECT l.id, l.lesson_no, l.title_bn, l.title_en, l.est_minutes,
                  l.chapter_id, ch.name_bn AS chapter_name_bn,
                  lp.state, lp.seconds_spent, lp.last_block_no
             FROM lessons l
             JOIN chapters ch ON ch.id = l.chapter_id
             LEFT JOIN lesson_progress lp
               ON lp.lesson_id = l.id AND lp.student_id = $2
            WHERE l.id = $1`,
          [lessonId, claims.sub],
        );
        const lesson = lessonRes.rows[0];
        if (!lesson) throw new HttpError(404, 'lesson not found', 'lesson_not_found');

        const blocksRes = await client.query<{
          id: string; block_no: number; kind: string;
          body_bn: string | null; media_key: string | null;
          alt_text_bn: string | null; caption_bn: string | null;
        }>(
          `SELECT id, block_no, kind::text, body_bn, media_key, alt_text_bn, caption_bn
             FROM lesson_blocks
            WHERE lesson_id = $1
            ORDER BY block_no`,
          [lessonId],
        );

        return {
          lesson: {
            id: lesson.id,
            lessonNo: lesson.lesson_no,
            title: { bn: lesson.title_bn, en: lesson.title_en },
            estMinutes: lesson.est_minutes,
            chapter: { id: lesson.chapter_id, nameBn: lesson.chapter_name_bn },
            progress: lesson.state
              ? {
                  state: lesson.state,
                  secondsSpent: lesson.seconds_spent ?? 0,
                  lastBlockNo: lesson.last_block_no,
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

    /* -------------------------------------------------- lesson list for chapter */
    const lessons = await db.withTenant(ctx, async (client) => {
      const r = await client.query<{
        id: string; lesson_no: number; title_bn: string; title_en: string | null;
        est_minutes: number; is_published: boolean;
        state: string | null; seconds_spent: number | null;
      }>(
        `SELECT l.id, l.lesson_no, l.title_bn, l.title_en, l.est_minutes, l.is_published,
                lp.state, lp.seconds_spent
           FROM lessons l
           LEFT JOIN lesson_progress lp
             ON lp.lesson_id = l.id AND lp.student_id = $2
          WHERE l.chapter_id = $1
          ORDER BY l.display_order, l.lesson_no`,
        [chapterId, claims.sub],
      );
      return r.rows;
    });

    json(res, 200, {
      chapterId,
      lessons: lessons.map((l) => ({
        id: l.id,
        lessonNo: l.lesson_no,
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
    console.error('[lessons] unexpected error', err);
    json(res, 500, { error: 'internal_error' }, cors);
  }
}
