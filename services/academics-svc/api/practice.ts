/**
 * GET /api/v1/academics/practice?lessonId=
 *
 * Practice questions for one lesson, with the student's own attempt
 * history folded in so the UI can show "you got this right last time"
 * without a second request.
 *
 * ── On sending the answer key to the client ──────────────────────────
 * This response includes `isCorrect` on each option and the explanation
 * text. That is a deliberate trade, not an oversight:
 *
 *   * Practice is FORMATIVE. Attempts never touch exam_results or
 *     assignment marks (migration 019), so there is no grade to cheat.
 *   * Offline is the point. A student revising on a bus with no signal
 *     must get immediate feedback — that's what makes practice a habit
 *     rather than a quiz. Round-tripping every answer to the server would
 *     make the feature useless for most of the target audience.
 *   * The trustworthy record is written server-side regardless: the sync
 *     applier re-marks every attempt against the database and ignores any
 *     client claim about correctness.
 *
 * A student who opens devtools to peek at answers has only cheated
 * themselves out of practice. If a summative quiz is ever built, it must
 * NOT reuse this endpoint — it needs server-side marking with the key
 * withheld, which is a different endpoint with different guarantees.
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
    const lessonId = query(req).get('lessonId') ?? '';
    if (!UUID_RE.test(lessonId)) {
      throw new HttpError(400, 'lessonId must be a valid uuid', 'invalid_lesson_id');
    }

    const db = await sharedDb();
    const result = await db.withTenant(
      { tenantId: claims.tid, userId: claims.sub, role: claims.role },
      async (client) => {
        const qs = await client.query<{
          id: string; question_no: number; kind: string; stem_bn: string;
          explanation_bn: string | null; difficulty: number;
          numeric_answer: string | null; numeric_tolerance: string;
          options: unknown;
          attempts: number; best_correct: boolean | null; last_response_ms: number | null;
        }>(
          `SELECT q.id, q.question_no, q.kind::text, q.stem_bn, q.explanation_bn,
                  q.difficulty, q.numeric_answer::text, q.numeric_tolerance::text,
                  COALESCE((
                    SELECT jsonb_agg(jsonb_build_object(
                             'id', o.id, 'optionNo', o.option_no,
                             'textBn', o.text_bn, 'isCorrect', o.is_correct)
                           ORDER BY o.option_no)
                      FROM practice_options o WHERE o.question_id = q.id
                  ), '[]'::jsonb) AS options,
                  (SELECT count(*)::int FROM practice_attempts a
                    WHERE a.question_id = q.id AND a.student_id = $2) AS attempts,
                  (SELECT bool_or(a.is_correct) FROM practice_attempts a
                    WHERE a.question_id = q.id AND a.student_id = $2) AS best_correct,
                  (SELECT a.response_ms FROM practice_attempts a
                    WHERE a.question_id = q.id AND a.student_id = $2
                    ORDER BY a.attempt_no DESC LIMIT 1) AS last_response_ms
             FROM practice_questions q
            WHERE q.lesson_id = $1 AND q.is_published
            ORDER BY q.question_no`,
          [lessonId, claims.sub],
        );
        return qs.rows;
      },
    );

    json(res, 200, {
      lessonId,
      questions: result.map((q) => ({
        id: q.id,
        questionNo: q.question_no,
        kind: q.kind,
        stemBn: q.stem_bn,
        explanationBn: q.explanation_bn,
        difficulty: q.difficulty,
        numericAnswer: q.numeric_answer,
        numericTolerance: q.numeric_tolerance,
        options: q.options,
        myProgress: {
          attempts: q.attempts,
          solved: q.best_correct ?? false,
          lastResponseMs: q.last_response_ms,
        },
      })),
    }, cors);
  } catch (err) {
    if (err instanceof HttpError) {
      json(res, err.status, { error: err.code ?? 'error', message: err.message }, cors);
      return;
    }
    console.error('[practice] unexpected error', err);
    json(res, 500, { error: 'internal_error' }, cors);
  }
}
