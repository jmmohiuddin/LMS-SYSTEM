/**
 * GET /api/v1/academics/chapters?classId=&subjectId=
 *
 * The syllabus browse surface: every published chapter for a class (and
 * optionally one subject), each with its lesson count, total estimated
 * minutes, prerequisite pointer, and — for the calling student — how many
 * of its lessons they have completed.
 *
 * Deliberately one query with the progress join baked in rather than a
 * separate /progress call: the student's chapter list is useless without
 * "3 of 5 done" on it, and a second round trip on a 2G connection is the
 * difference between a screen that feels instant and one that doesn't.
 *
 * Visibility is entirely RLS's job (017): unpublished chapters are hidden
 * from non-staff by chapter_read_scope, and progress rows are filtered by
 * app.can_see_student. authenticate() alone is therefore the right gate —
 * a student calling this sees their syllabus, a teacher sees the same
 * chapters plus unpublished drafts.
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
    const classId = q.get('classId') ?? '';
    const subjectId = q.get('subjectId') ?? '';

    if (!UUID_RE.test(classId)) {
      throw new HttpError(400, 'classId must be a valid uuid', 'invalid_class_id');
    }
    if (subjectId && !UUID_RE.test(subjectId)) {
      throw new HttpError(400, 'subjectId must be a valid uuid', 'invalid_subject_id');
    }

    const db = await sharedDb();
    const chapters = await db.withTenant(
      { tenantId: claims.tid, userId: claims.sub, role: claims.role },
      async (client) => {
        const r = await client.query<{
          id: string; chapter_no: number; name_bn: string; name_en: string | null;
          summary_bn: string | null; est_minutes: number; is_published: boolean;
          subject_id: string; subject_bn: string; subject_en: string;
          prerequisite_chapter_id: string | null; prerequisite_name_bn: string | null;
          lesson_count: number; completed_count: number;
        }>(
          `SELECT ch.id, ch.chapter_no, ch.name_bn, ch.name_en, ch.summary_bn,
                  ch.est_minutes, ch.is_published,
                  ch.subject_id, s.name_bn AS subject_bn, s.name_en AS subject_en,
                  ch.prerequisite_chapter_id,
                  pre.name_bn AS prerequisite_name_bn,
                  (SELECT count(*)::int FROM lessons l
                    WHERE l.chapter_id = ch.id AND l.is_published) AS lesson_count,
                  (SELECT count(*)::int FROM lessons l
                     JOIN lesson_progress lp
                       ON lp.lesson_id = l.id
                      AND lp.student_id = $3
                      AND lp.state = 'completed'
                    WHERE l.chapter_id = ch.id AND l.is_published) AS completed_count
             FROM chapters ch
             JOIN subjects s ON s.id = ch.subject_id
             LEFT JOIN chapters pre ON pre.id = ch.prerequisite_chapter_id
            WHERE ch.class_id = $1
              AND ($2::uuid IS NULL OR ch.subject_id = $2)
            ORDER BY s.name_bn, ch.display_order, ch.chapter_no`,
          [classId, subjectId || null, claims.sub],
        );
        return r.rows;
      },
    );

    json(res, 200, {
      chapters: chapters.map((c) => ({
        id: c.id,
        chapterNo: c.chapter_no,
        name: { bn: c.name_bn, en: c.name_en },
        summaryBn: c.summary_bn,
        estMinutes: c.est_minutes,
        isPublished: c.is_published,
        subject: { id: c.subject_id, bn: c.subject_bn, en: c.subject_en },
        prerequisite: c.prerequisite_chapter_id
          ? { id: c.prerequisite_chapter_id, nameBn: c.prerequisite_name_bn }
          : null,
        lessonCount: c.lesson_count,
        completedCount: c.completed_count,
      })),
    }, cors);
  } catch (err) {
    if (err instanceof HttpError) {
      json(res, err.status, { error: err.code ?? 'error', message: err.message }, cors);
      return;
    }
    console.error('[chapters] unexpected error', err);
    json(res, 500, { error: 'internal_error' }, cors);
  }
}
