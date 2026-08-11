/**
 * GET /api/v1/academics/next
 *
 * "What should I study next?" — the single question a student opens the
 * app with, answered as a short ranked list instead of a menu.
 *
 * Strategy §13 is explicit that this starts as DETERMINISTIC RULES, not a
 * model: with one cohort's worth of data, an ML ranker would be fitting
 * noise, and its mistakes would be unexplainable to a 14-year-old. Every
 * suggestion here carries a plain-language `whyBn` the student can argue
 * with, which is a feature — if the reason is wrong, they can ignore it
 * and we can see the rule was wrong.
 *
 * The rules, in priority order:
 *
 *   1. Homework due within 3 days and not submitted. A deadline someone
 *      else set outranks anything self-paced.
 *   2. A practice question whose LAST attempt was wrong. Getting it wrong
 *      and never returning is the most common silent failure in
 *      self-study — this is the closest thing to spaced repetition that
 *      is honest at this data volume.
 *   3. The next unread topic in a chapter already begun. Finishing beats
 *      starting; a half-read chapter is the highest-yield place to spend
 *      twenty minutes.
 *   4. A new chapter whose prerequisite is complete. Only offered when
 *      nothing above applies, so the student is never pushed forward
 *      while something behind them is unfinished.
 *
 * Deliberately capped at 3 suggestions. A ranked list of ten is a menu
 * again, which is the thing this endpoint exists to replace.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { sharedDb } from '../../../packages/server-core/src/db.ts';
import { corsHeaders, json, HttpError } from '../../../packages/server-core/src/http.ts';
import { authenticate } from '../../../packages/server-core/src/auth.ts';

type Kind = 'assignment' | 'redo_practice' | 'continue_topic' | 'new_chapter';

interface Suggestion {
  kind: Kind;
  titleBn: string;
  whyBn: string;
  route: string;           // hash route the PWA should open
  refId: string;
  urgency: 'high' | 'medium' | 'low';
}

const MAX_SUGGESTIONS = 3;

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const cors = corsHeaders();
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }
  if (req.method !== 'GET') { json(res, 405, { error: 'method_not_allowed' }, cors); return; }

  try {
    const claims = await authenticate(req);
    const db = await sharedDb();

    const suggestions = await db.withTenant(
      { tenantId: claims.tid, userId: claims.sub, role: claims.role },
      async (client) => {
        const out: Suggestion[] = [];

        /* ── Rule 1: homework due soon, not submitted ──────────────── */
        const due = await client.query<{ id: string; title_bn: string; days: number }>(
          `SELECT a.id, a.title_bn,
                  GREATEST(0, EXTRACT(day FROM a.due_at - now())::int) AS days
             FROM assignments a
            WHERE a.status = 'open'
              AND a.due_at > now()
              AND a.due_at < now() + interval '3 days'
              AND NOT EXISTS (
                    SELECT 1 FROM assignment_submissions s
                     WHERE s.assignment_id = a.id AND s.student_id = $1)
            ORDER BY a.due_at
            LIMIT 2`,
          [claims.sub],
        );
        for (const a of due.rows) {
          out.push({
            kind: 'assignment',
            titleBn: a.title_bn,
            whyBn: a.days <= 0 ? 'আজই জমা দিতে হবে' : `${a.days} দিনের মধ্যে জমা দিতে হবে`,
            route: 'assignments',
            refId: a.id,
            urgency: 'high',
          });
        }

        /* ── Rule 2: a practice question last answered wrong ───────── */
        if (out.length < MAX_SUGGESTIONS) {
          // DISTINCT ON gives the latest attempt per question; we only want
          // the ones where that latest attempt was still wrong. A question
          // they eventually got right is not a gap.
          const wrong = await client.query<{ topic_id: string; title_bn: string; n: number }>(
            `WITH latest AS (
               SELECT DISTINCT ON (a.question_id)
                      a.question_id, a.topic_id, a.is_correct
                 FROM practice_attempts a
                WHERE a.student_id = $1
                ORDER BY a.question_id, a.attempt_no DESC
             )
             SELECT l.topic_id, ls.title_bn, count(*)::int AS n
               FROM latest l
               JOIN topics ls ON ls.id = l.topic_id
              WHERE NOT l.is_correct
              GROUP BY l.topic_id, ls.title_bn
              ORDER BY n DESC
              LIMIT 1`,
            [claims.sub],
          );
          for (const w of wrong.rows) {
            out.push({
              kind: 'redo_practice',
              titleBn: w.title_bn,
              whyBn: `${w.n}টি প্রশ্ন এখনো ভুল আছে — আবার চেষ্টা করো`,
              route: 'learn',
              refId: w.topic_id,
              urgency: 'medium',
            });
          }
        }

        /* ── Rule 3: next unread topic in a chapter already begun ─── */
        if (out.length < MAX_SUGGESTIONS) {
          const cont = await client.query<{ topic_id: string; title_bn: string; chapter_bn: string }>(
            `SELECT l.id AS topic_id, l.title_bn, c.name_bn AS chapter_bn
               FROM topics l
               JOIN chapters c ON c.id = l.chapter_id
              WHERE l.is_published
                -- chapter has at least one completed topic (already begun)
                AND EXISTS (
                      SELECT 1 FROM topic_progress p
                       JOIN topics l2 ON l2.id = p.topic_id
                      WHERE l2.chapter_id = c.id
                        AND p.student_id = $1 AND p.state = 'completed')
                -- but THIS topic isn't done
                AND NOT EXISTS (
                      SELECT 1 FROM topic_progress p2
                       WHERE p2.topic_id = l.id
                         AND p2.student_id = $1 AND p2.state = 'completed')
              ORDER BY c.chapter_no, l.topic_no
              LIMIT 1`,
            [claims.sub],
          );
          for (const c of cont.rows) {
            out.push({
              kind: 'continue_topic',
              titleBn: c.title_bn,
              whyBn: `${c.chapter_bn} অধ্যায়টি শেষ করো`,
              route: 'learn',
              refId: c.topic_id,
              urgency: 'medium',
            });
          }
        }

        /* ── Rule 4: a new chapter whose prerequisite is done ──────── */
        if (out.length < MAX_SUGGESTIONS) {
          const fresh = await client.query<{ id: string; name_bn: string; subject_bn: string }>(
            `SELECT c.id, c.name_bn, s.name_bn AS subject_bn
               FROM chapters c
               JOIN subjects s ON s.id = c.subject_id
              WHERE c.is_published
                -- untouched
                AND NOT EXISTS (
                      SELECT 1 FROM topic_progress p
                       JOIN topics l ON l.id = p.topic_id
                      WHERE l.chapter_id = c.id AND p.student_id = $1)
                -- prerequisite satisfied (or none)
                AND (c.prerequisite_chapter_id IS NULL OR EXISTS (
                      SELECT 1 FROM topic_progress p2
                       JOIN topics l2 ON l2.id = p2.topic_id
                      WHERE l2.chapter_id = c.prerequisite_chapter_id
                        AND p2.student_id = $1 AND p2.state = 'completed'))
              ORDER BY c.chapter_no
              LIMIT 1`,
            [claims.sub],
          );
          for (const f of fresh.rows) {
            out.push({
              kind: 'new_chapter',
              titleBn: f.name_bn,
              whyBn: `${f.subject_bn} — নতুন অধ্যায় শুরু করার জন্য প্রস্তুত`,
              route: 'learn',
              refId: f.id,
              urgency: 'low',
            });
          }
        }

        return out.slice(0, MAX_SUGGESTIONS);
      },
    );

    json(res, 200, { suggestions }, cors);
  } catch (err) {
    if (err instanceof HttpError) {
      json(res, err.status, { error: err.code ?? 'error', message: err.message }, cors);
      return;
    }
    console.error('[next] unexpected error', err);
    json(res, 500, { error: 'internal_error' }, cors);
  }
}
