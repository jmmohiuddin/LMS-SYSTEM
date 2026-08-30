/**
 * GET /api/v1/academics/subjects   — F-802, "My subjects"
 *
 * The subject-based model made visible. Wireframe §6.2 states the whole
 * design intent in one line: "No catalog, no browse, no enrol,
 * no search-for-a-course."
 *
 * A student does not choose subjects. Their class, group and institution
 * type determine the set, derived once by app.derive_student_subjects()
 * (F-304, migration 025). This endpoint returns THAT set — the student's
 * own, including their religion variant and their optional subject, not
 * the class template. Two students sitting next to each other get
 * different lists, and that is the point: an exam routine built on the
 * class template clashes for one of them.
 *
 * Progress is expressed as syllabus progress (PRD §5.6, frame 1) —
 * chapters taught out of chapters in the subject. Not mastery: that is
 * F-1401 and it is gated on data that does not exist yet. Reporting a
 * confident mastery percentage from zero attempts would be a fabricated
 * number in front of a fourteen-year-old.
 *
 * Staff may pass ?studentId= to view a particular student's set. RLS
 * (student_subject_read_scope, migration 025) is the gate — a student
 * passing another student's id gets an empty list, not an error, because
 * a subject set reveals a child's religion.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { sharedDb } from '../../../packages/server-core/src/db.ts';
import { corsHeaders, query, json, HttpError } from '../../../packages/server-core/src/http.ts';
import { authenticate } from '../../../packages/server-core/src/auth.ts';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The requirement-type chip in wireframe §6.2. Bangla, because this is a
 * student-facing label and the product is Bangla-primary (N-12).
 */
const REQUIREMENT_LABEL: Record<string, string> = {
  compulsory:       'আবশ্যিক',
  group_compulsory: 'বিভাগ আবশ্যিক',
  optional:         'চতুর্থ বিষয়',
  religion_variant: 'ধর্ম',
  co_curricular:    'সহপাঠ',
};

interface Row {
  subject_id: string;
  name_bn: string;
  name_en: string | null;
  nctb_code: string | null;
  code_verified?: boolean;
  requirement_type: string;
  paper_structure: string;
  assessment_scheme: string;
  total_chapters: number;
  completed_chapters: number;
  next_chapter_id: string | null;
  next_chapter_no: number | null;
  next_chapter_name: string | null;
}

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const cors = corsHeaders();
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }
  if (req.method !== 'GET') { json(res, 405, { error: 'method_not_allowed' }, cors); return; }

  try {
    const claims = await authenticate(req);
    const requested = query(req).get('studentId') ?? '';
    if (requested && !UUID_RE.test(requested)) {
      throw new HttpError(400, 'studentId must be a valid uuid', 'invalid_student_id');
    }
    const studentId = requested || claims.sub;

    const db = await sharedDb();
    const rows = await db.withTenant(
      { tenantId: claims.tid, userId: claims.sub, role: claims.role },
      async (client) => {
        const r = await client.query<Row>(
          // One round trip. The student home and this screen are the two
          // that must render fast on a 2GB Android device (N-01), and a
          // per-subject follow-up query would be N+1 over ~10 subjects.
          `WITH mine AS (
             SELECT ss.subject_id, ss.requirement_type, e.section_id, s.class_id
               FROM student_subjects ss
               JOIN enrolments e ON e.id = ss.enrolment_id
               JOIN sections   s ON s.id = e.section_id
              WHERE e.student_id = $1
                AND e.status = 'active'
           ),
           chapter_counts AS (
             SELECT m.subject_id,
                    count(*) FILTER (WHERE c.is_published)::int AS total_chapters,
                    -- "Completed" means every published topic in the chapter
                    -- is completed for this student. A chapter half-read is
                    -- not progress a student would call progress.
                    count(*) FILTER (
                      WHERE c.is_published AND NOT EXISTS (
                        SELECT 1 FROM topics t
                         WHERE t.chapter_id = c.id AND t.is_published
                           AND NOT EXISTS (
                             SELECT 1 FROM topic_progress tp
                              WHERE tp.topic_id = t.id AND tp.student_id = $1
                                AND tp.state = 'completed'))
                    )::int AS completed_chapters
               FROM mine m
               JOIN chapters c
                 ON c.subject_id = m.subject_id AND c.class_id = m.class_id
              GROUP BY m.subject_id
           ),
           next_chapter AS (
             SELECT DISTINCT ON (m.subject_id)
                    m.subject_id, c.id AS next_chapter_id,
                    c.chapter_no AS next_chapter_no, c.name_bn AS next_chapter_name
               FROM mine m
               JOIN chapters c
                 ON c.subject_id = m.subject_id AND c.class_id = m.class_id
              WHERE c.is_published
                -- The first chapter not yet finished, in canonical NCTB order.
                AND EXISTS (
                  SELECT 1 FROM topics t
                   WHERE t.chapter_id = c.id AND t.is_published
                     AND NOT EXISTS (
                       SELECT 1 FROM topic_progress tp
                        WHERE tp.topic_id = t.id AND tp.student_id = $1
                          AND tp.state = 'completed'))
              ORDER BY m.subject_id, c.chapter_no
           )
           SELECT m.subject_id, sub.name_bn, sub.name_en, sub.nctb_code,
                  -- R-8 section 9C. Whether OUR seed for this code was ever
                  -- checked against a board publication. subject_catalogue's
                  -- verified_against column has existed since migration 012 and
                  -- is NULL on all 73 rows, so today this is false for
                  -- everything -- which is the truth, and was invisible.
                  -- Migration 048's H-prefixed identifiers are ours outright
                  -- and looked exactly as official as any other code.
                  EXISTS (SELECT 1 FROM subject_catalogue sc
                           WHERE sc.nctb_code = sub.nctb_code
                             AND sc.verified_against IS NOT NULL) AS code_verified,
                  m.requirement_type,
                  sub.paper_structure::text, sub.assessment_scheme::text,
                  COALESCE(cc.total_chapters, 0)     AS total_chapters,
                  COALESCE(cc.completed_chapters, 0) AS completed_chapters,
                  nc.next_chapter_id, nc.next_chapter_no, nc.next_chapter_name
             FROM mine m
             JOIN subjects sub ON sub.id = m.subject_id
             LEFT JOIN chapter_counts cc ON cc.subject_id = m.subject_id
             LEFT JOIN next_chapter  nc ON nc.subject_id = m.subject_id
            ORDER BY
              -- Compulsory first, then group, then the chosen extras. This
              -- matches how a student's own routine reads.
              CASE m.requirement_type
                WHEN 'compulsory' THEN 1 WHEN 'group_compulsory' THEN 2
                WHEN 'religion_variant' THEN 3 WHEN 'optional' THEN 4 ELSE 5 END,
              sub.nctb_code NULLS LAST, sub.name_bn`,
          [studentId],
        );
        return r.rows;
      },
    );

    json(res, 200, {
      studentId,
      subjects: rows.map((r) => ({
        subjectId: r.subject_id,
        nameBn: r.name_bn,
        nameEn: r.name_en,
        nctbCode: r.nctb_code,
        // False until a curriculum specialist signs the code off; see
        // 06-DEPLOYMENT.md §6, which has carried that task since R-7.
        codeVerified: r.code_verified === true,
        requirementType: r.requirement_type,
        requirementLabelBn: REQUIREMENT_LABEL[r.requirement_type] ?? r.requirement_type,
        paperStructure: r.paper_structure,
        assessmentScheme: r.assessment_scheme,
        totalChapters: r.total_chapters,
        completedChapters: r.completed_chapters,
        // Sent rather than computed on the client: the same number appears
        // on the guardian surface and in reporting, and two implementations
        // of one percentage eventually disagree.
        progressPercent: r.total_chapters > 0
          ? Math.round((r.completed_chapters / r.total_chapters) * 100)
          : 0,
        nextChapter: r.next_chapter_id
          ? { id: r.next_chapter_id, chapterNo: r.next_chapter_no, nameBn: r.next_chapter_name }
          : null,
      })),
    }, cors);
  } catch (err) {
    if (err instanceof HttpError) {
      json(res, err.status, { error: err.code ?? 'error', message: err.message }, cors);
      return;
    }
    console.error('[subjects] unexpected error', err);
    json(res, 500, { error: 'internal_error' }, cors);
  }
}
