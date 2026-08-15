/**
 * GET /api/v1/academics/classperf                     → analysable exam-subjects
 * GET /api/v1/academics/classperf?examSubjectId=<id>  → one class's analysis
 *
 * F-1501 (class performance) and F-1502 (students who may need support),
 * wireframe §7.5.
 *
 * ── The departure from the wireframe, and why ────────────────────────────
 * §7.5 draws "যে প্রশ্নগুলো ক্লাস সবচেয়ে বেশি ভুল করেছে" under an exam
 * header, which reads as per-question analysis of that exam. This schema
 * cannot produce that. exam_marks stores four component totals per student
 * per subject — cq / mcq / practical / ca — and there is no exam item
 * response table anywhere in the migrations. Marks arrive from a teacher
 * reading a paper script, not from a scanner, so the per-item data does
 * not exist to be aggregated. Inventing it would mean either a fabricated
 * number or a migration that quietly changes how marks are entered.
 *
 * So the screen sources each signal from where it is real, and says which
 * is which:
 *
 *   • Component analysis comes from the exam. It is coarser than
 *     per-question, but it is genuinely diagnostic: a class averaging 41%
 *     on MCQ and 78% on CQ has a recall problem, not a comprehension one,
 *     and NCTB's separate component pass marks make that gap consequential
 *     rather than academic.
 *
 *   • Question analysis comes from practice_attempts, which really is
 *     per-question, per-student, server-marked (see 019_practice.sql —
 *     ix_attempts_question exists for exactly this query). Practice
 *     questions hang off topics, and topics off chapters, which is what
 *     produces §7.5's "→ অধ্যায় ৯ পুনরায় আলোচনা করুন". Exam marks could
 *     never produce that recommendation; practice attempts can.
 *
 * The panel is labelled অনুশীলন, not পরীক্ষা. A teacher who thinks these
 * are exam questions would draw conclusions about the wrong cohort —
 * practice is voluntary, so it is self-selected.
 *
 * ── F-1502: the attention list is a soft signal, not a label ─────────────
 * §7.5 is unusually explicit: the list is "phrased as a soft signal …
 * never as a label, and it is never written to a student's permanent
 * record." Four things here follow from that, and none of them are
 * cosmetic:
 *
 *  1. Nothing is written. This handler is GET and issues no INSERT or
 *     UPDATE of any kind. There is no risk score column to leak into a
 *     transcript later, because there is no risk score.
 *
 *  2. There is no score. Each student carries a list of plain observations
 *     ("হাজিরা ৭২%", "টানা ৪ দিন অনুপস্থিত") and nothing that composes
 *     them into a number. A composite index is a label wearing a decimal
 *     point.
 *
 *  3. The list is ordered by roll number, not by severity. Sorting
 *     children by how much trouble they are in IS a ranking, and a ranking
 *     IS a label — the exact thing F-1502 forbids. Roll order keeps the
 *     panel reading as an excerpt of the register.
 *
 *  4. The list is not capped at a top-N. Capping would mean choosing which
 *     children are worst, which is (3) again by another route. The
 *     thresholds bound the list instead. If most of a class trips them,
 *     that is a fact about the term — a lost fortnight, a teacher on
 *     leave — and the screen says so rather than hiding it behind a
 *     "showing 5 of 34".
 *
 * Every signal is mechanical and stated in full so a teacher can disagree
 * with it. That is the difference between a prompt and a verdict.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { sharedDb } from '../../../packages/server-core/src/db.ts';
import { corsHeaders, json, HttpError } from '../../../packages/server-core/src/http.ts';
import { authenticate, requireRole } from '../../../packages/server-core/src/auth.ts';
import { dhakaToday } from '../../../packages/server-core/src/time.ts';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Teaching staff only. A guardian has no business reading a whole class's
 * weak points, and a student none at all — §7.5 is a teaching tool, and
 * the attention list in particular is about other people's children.
 */
const PERF_ROLES = ['class_teacher', 'subject_teacher', 'academic_coordinator', 'principal', 'school_owner'];

/** Below this, over the window, attendance is worth a teacher's notice. */
const ATTENDANCE_FLOOR_PERCENT = 80;
/** Consecutive absent days that count as a streak worth naming. */
const STREAK_DAYS = 3;
/** Percentage-point fall against the same subject last exam. */
const MARK_DROP_POINTS = 15;
/** Days of attendance history the percentage is computed over. */
const WINDOW_DAYS = 30;
/** A practice question needs this many attempts before its error rate means anything. */
const MIN_ATTEMPTS = 5;
/** Error rate at or above which a question is worth showing. */
const WRONG_FLOOR_PERCENT = 40;

type Client = { query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }> };

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const cors = corsHeaders();
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }
  if (req.method !== 'GET') { json(res, 405, { error: 'method_not_allowed' }, cors); return; }

  try {
    const claims = await authenticate(req);
    requireRole(claims, PERF_ROLES);

    const examSubjectId = new URL(req.url ?? '/', 'http://internal').searchParams.get('examSubjectId') ?? '';
    if (examSubjectId && !UUID_RE.test(examSubjectId)) {
      throw new HttpError(400, 'examSubjectId must be a valid uuid', 'invalid_exam_subject_id');
    }

    const db = await sharedDb();
    const ctx = { tenantId: claims.tid, userId: claims.sub, role: claims.role };

    const payload = await db.withTenant(ctx, async (client: Client) => {
      const choices = await loadChoices(client);
      if (!examSubjectId) return { choices, analysis: null };
      // RLS decides visibility. A subject teacher who does not take this
      // section sees no row and gets a 404 — not a 403, which would
      // confirm the class exists to someone who cannot see it.
      const head = await loadHeader(client, examSubjectId);
      if (!head) throw new HttpError(404, 'exam subject not found', 'exam_subject_not_found');
      return { choices, analysis: await analyse(client, head) };
    });

    json(res, 200, payload, cors);
  } catch (err) {
    if (err instanceof HttpError) {
      json(res, err.status, { error: err.code, message: err.message }, cors);
      return;
    }
    console.error('classperf failed', err);
    json(res, 500, { error: 'internal_error' }, cors);
  }
}

type Header = {
  examSubjectId: string;
  sectionId: string;
  subjectId: string;
  label: string;
  cqMax: number; mcqMax: number; practicalMax: number; caMax: number;
  examStartsOn: string | null;
  academicYearId: string;
};

/** The exam-subjects this user can analyse, newest exam first. */
async function loadChoices(client: Client): Promise<Array<{ examSubjectId: string; label: string }>> {
  const { rows } = await client.query<{ id: string; label: string }>(
    `SELECT es.id,
            cl.name_bn || '-' || s.name_bn || ' · ' || sub.name_bn || ' · ' || e.name_bn AS label
       FROM exam_subjects es
       JOIN exams    e   ON e.id   = es.exam_id
       JOIN sections s   ON s.id   = es.section_id
       JOIN classes  cl  ON cl.id  = s.class_id
       JOIN subjects sub ON sub.id = es.subject_id
      -- Analysing an exam nobody has marked yet shows a screen of zeroes
      -- and teaches the teacher to distrust the screen.
      WHERE EXISTS (SELECT 1 FROM exam_marks m WHERE m.exam_subject_id = es.id)
      ORDER BY e.starts_on DESC NULLS LAST, cl.level_no, s.name_bn
      LIMIT 60`,
  );
  return rows.map((r) => ({ examSubjectId: r.id, label: r.label }));
}

async function loadHeader(client: Client, id: string): Promise<Header | null> {
  const { rows } = await client.query<Header & Record<string, never>>(
    `SELECT es.id            AS "examSubjectId",
            es.section_id    AS "sectionId",
            es.subject_id    AS "subjectId",
            cl.name_bn || '-' || s.name_bn || ' · ' || sub.name_bn || ' · ' || e.name_bn AS label,
            es.cq_max        AS "cqMax",
            es.mcq_max       AS "mcqMax",
            es.practical_max AS "practicalMax",
            es.ca_max        AS "caMax",
            e.starts_on      AS "examStartsOn",
            e.academic_year_id AS "academicYearId"
       FROM exam_subjects es
       JOIN exams    e   ON e.id   = es.exam_id
       JOIN sections s   ON s.id   = es.section_id
       JOIN classes  cl  ON cl.id  = s.class_id
       JOIN subjects sub ON sub.id = es.subject_id
      WHERE es.id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

async function analyse(client: Client, head: Header) {
  const components = await loadComponents(client, head);
  const questions = await loadQuestions(client, head);
  return {
    header: { examSubjectId: head.examSubjectId, label: head.label },
    coverage: await loadCoverage(client, head),
    components,
    practice: {
      questions,
      reteach: reteachHint(questions),
      // Carried in the payload so the client cannot forget which cohort
      // these numbers describe.
      source: 'practice',
    },
    attention: await loadAttention(client, head),
    thresholds: {
      attendanceFloorPercent: ATTENDANCE_FLOOR_PERCENT,
      streakDays: STREAK_DAYS,
      markDropPoints: MARK_DROP_POINTS,
      windowDays: WINDOW_DAYS,
    },
  };
}

/** How much of the class is actually marked — every average below is over this. */
async function loadCoverage(client: Client, head: Header) {
  const { rows } = await client.query<{ marked: string; enrolled: string; absent: string }>(
    `SELECT COUNT(m.student_id) FILTER (WHERE NOT m.is_absent) AS marked,
            COUNT(*)                                          AS enrolled,
            COUNT(m.student_id) FILTER (WHERE m.is_absent)     AS absent
       FROM enrolments en
       LEFT JOIN exam_marks m
         ON m.exam_subject_id = $1 AND m.student_id = en.student_id
      WHERE en.section_id = $2 AND en.status = 'active'`,
    [head.examSubjectId, head.sectionId],
  );
  const r = rows[0];
  return { marked: Number(r?.marked ?? 0), enrolled: Number(r?.enrolled ?? 0), absent: Number(r?.absent ?? 0) };
}

const COMPONENT_LABELS: Record<string, string> = {
  mcq: 'বহুনির্বাচনি', cq: 'সৃজনশীল', practical: 'ব্যবহারিক', ca: 'ধারাবাহিক মূল্যায়ন',
};

/**
 * Class average per component, as a percentage of that component's own
 * maximum — the only form in which CQ out of 70 and MCQ out of 30 can be
 * compared at a glance, which is the entire point of the panel.
 *
 * Absentees are excluded. A zero for a child who was not in the room is
 * not a fact about the teaching.
 */
async function loadComponents(client: Client, head: Header) {
  const { rows } = await client.query<{ cq: string | null; mcq: string | null; practical: string | null; ca: string | null }>(
    `SELECT AVG(cq_marks) AS cq, AVG(mcq_marks) AS mcq,
            AVG(practical_marks) AS practical, AVG(ca_marks) AS ca
       FROM exam_marks
      WHERE exam_subject_id = $1 AND NOT is_absent`,
    [head.examSubjectId],
  );
  const avg = rows[0] ?? { cq: null, mcq: null, practical: null, ca: null };
  const maxima: Record<string, number> = {
    mcq: Number(head.mcqMax), cq: Number(head.cqMax),
    practical: Number(head.practicalMax), ca: Number(head.caMax),
  };

  return (['mcq', 'cq', 'practical', 'ca'] as const)
    // A component with a zero maximum is not part of this subject's
    // scheme; showing it as "0%" would read as a catastrophe.
    .filter((k) => maxima[k] > 0)
    .map((k) => {
      const raw = avg[k];
      return {
        key: k,
        labelBn: COMPONENT_LABELS[k],
        max: maxima[k],
        average: raw === null ? null : Number(Number(raw).toFixed(2)),
        percent: raw === null ? null : Math.round((Number(raw) / maxima[k]) * 100),
      };
    });
}

/**
 * The questions this section's students most often get wrong in practice,
 * restricted to this subject's chapters.
 *
 * Only the newest attempt per student per question counts. Practice is
 * repeatable by design, so counting every attempt would make a question
 * that students returned to and eventually mastered look like the hardest
 * one in the chapter.
 */
async function loadQuestions(client: Client, head: Header) {
  const { rows } = await client.query<{
    questionNo: number; kind: string; stemBn: string; chapterBn: string;
    attempts: string; wrong: string;
  }>(
    `WITH latest AS (
       SELECT DISTINCT ON (pa.question_id, pa.student_id)
              pa.question_id, pa.is_correct
         FROM practice_attempts pa
         JOIN enrolments en
           ON en.student_id = pa.student_id
          AND en.section_id = $1
          AND en.status = 'active'
        ORDER BY pa.question_id, pa.student_id, pa.attempt_no DESC
     )
     SELECT q.question_no                              AS "questionNo",
            q.kind::text                               AS kind,
            q.stem_bn                                  AS "stemBn",
            ch.name_bn                                 AS "chapterBn",
            COUNT(*)                                   AS attempts,
            COUNT(*) FILTER (WHERE NOT l.is_correct)   AS wrong
       FROM latest l
       JOIN practice_questions q ON q.id = l.question_id
       JOIN topics   t  ON t.id  = q.topic_id
       JOIN chapters ch ON ch.id = t.chapter_id
      WHERE ch.subject_id = $2
      GROUP BY q.id, q.question_no, q.kind, q.stem_bn, ch.name_bn
     HAVING COUNT(*) >= $3
        AND COUNT(*) FILTER (WHERE NOT l.is_correct) * 100 / COUNT(*) >= $4
      ORDER BY COUNT(*) FILTER (WHERE NOT l.is_correct)::numeric / COUNT(*) DESC
      LIMIT 8`,
    [head.sectionId, head.subjectId, MIN_ATTEMPTS, WRONG_FLOOR_PERCENT],
  );

  return rows.map((r) => ({
    questionNo: r.questionNo,
    kind: r.kind,
    stemBn: r.stemBn,
    chapterBn: r.chapterBn,
    attempts: Number(r.attempts),
    wrongPercent: Math.round((Number(r.wrong) / Number(r.attempts)) * 100),
  }));
}

type Q = { chapterBn: string; wrongPercent: number };

/**
 * §7.5's "→ অধ্যায় ৯ পুনরায় আলোচনা করুন".
 *
 * One chapter, and only when at least two of its questions are among the
 * weak ones. A single hard question is a hard question; two in one chapter
 * is a chapter that did not land. Recommending a re-teach off one data
 * point would spend a period of a teacher's week on noise.
 */
function reteachHint(questions: Q[]): { chapterBn: string; questionCount: number } | null {
  const byChapter = new Map<string, number>();
  for (const q of questions) byChapter.set(q.chapterBn, (byChapter.get(q.chapterBn) ?? 0) + 1);
  let best: { chapterBn: string; questionCount: number } | null = null;
  for (const [chapterBn, questionCount] of byChapter) {
    if (questionCount >= 2 && (!best || questionCount > best.questionCount)) best = { chapterBn, questionCount };
  }
  return best;
}

type AttendanceRow = { studentId: string; nameBn: string; rollNo: number; present: string; total: string; streak: string };
type DropRow = { studentId: string; dropPoints: string };

/**
 * F-1502. Three mechanical observations, each stated in full, none of them
 * combined into a score and none of them stored.
 */
async function loadAttention(client: Client, head: Header) {
  const { rows: att } = await client.query<AttendanceRow>(
    `WITH days AS (
       SELECT ar.student_id, ar.taken_on,
              (ar.status = 'absent') AS absent,
              (ar.status IN ('present','late')) AS here
         FROM attendance_records ar
        WHERE ar.section_id = $1
          AND ar.taken_on >= CURRENT_DATE - ($2::int || ' days')::interval
     ),
     -- Length of the CURRENT absence run: count back from the most recent
     -- record until a day the student was here. A streak that ended last
     -- month is history, not a signal.
     streaks AS (
       SELECT d.student_id,
              COUNT(*) FILTER (WHERE d.absent AND d.taken_on > COALESCE(
                (SELECT MAX(d2.taken_on) FROM days d2
                  WHERE d2.student_id = d.student_id AND d2.here), '-infinity'::date)) AS streak
         FROM days d GROUP BY d.student_id
     )
     SELECT en.student_id                        AS "studentId",
            u.full_name_bn                       AS "nameBn",
            en.roll_no                           AS "rollNo",
            COUNT(*) FILTER (WHERE d.here)       AS present,
            COUNT(d.taken_on)                    AS total,
            COALESCE(MAX(st.streak), 0)          AS streak
       FROM enrolments en
       JOIN users u  ON u.id = en.student_id
       LEFT JOIN days d    ON d.student_id  = en.student_id
       LEFT JOIN streaks st ON st.student_id = en.student_id
      WHERE en.section_id = $1 AND en.status = 'active'
      GROUP BY en.student_id, u.full_name_bn, en.roll_no
      ORDER BY en.roll_no`,
    [head.sectionId, WINDOW_DAYS],
  );

  const drops = await loadMarkDrops(client, head);

  const out: Array<{ studentId: string; nameBn: string; rollNo: number; signals: string[] }> = [];
  for (const r of att) {
    const total = Number(r.total);
    const percent = total > 0 ? Math.round((Number(r.present) / total) * 100) : null;
    const streak = Number(r.streak);
    const signals: string[] = [];

    if (percent !== null && total >= 5 && percent < ATTENDANCE_FLOOR_PERCENT) {
      signals.push(`গত ${bn(WINDOW_DAYS)} দিনে হাজিরা ${bn(percent)}%`);
    }
    if (streak >= STREAK_DAYS) signals.push(`টানা ${bn(streak)} দিন অনুপস্থিত`);
    const drop = drops.get(r.studentId);
    if (drop !== undefined) signals.push(`গত পরীক্ষার চেয়ে নম্বর ${bn(drop)}% কম`);

    if (signals.length > 0) {
      out.push({ studentId: r.studentId, nameBn: r.nameBn, rollNo: Number(r.rollNo), signals });
    }
  }
  // Already in roll order from the query — see the file header, point 3.
  return out;
}

/**
 * Fall in this subject's total, as a percentage of its maximum, against
 * the most recent earlier exam that also covered this subject and section.
 * Absences on either side are skipped: a zero from a missed exam is not a
 * decline in understanding.
 */
async function loadMarkDrops(client: Client, head: Header): Promise<Map<string, number>> {
  const { rows } = await client.query<DropRow>(
    `WITH this_exam AS (
       SELECT m.student_id,
              m.total_marks * 100.0 /
                NULLIF(es.cq_max + es.mcq_max + es.practical_max + es.ca_max, 0) AS pct
         FROM exam_marks m
         JOIN exam_subjects es ON es.id = m.exam_subject_id
        WHERE m.exam_subject_id = $1 AND NOT m.is_absent
     ),
     prev_subject AS (
       SELECT es.id
         FROM exam_subjects es
         JOIN exams e ON e.id = es.exam_id
        WHERE es.section_id = $2 AND es.subject_id = $3 AND es.id <> $1
          AND e.starts_on < $4::date
        ORDER BY e.starts_on DESC
        LIMIT 1
     ),
     prev AS (
       SELECT m.student_id,
              m.total_marks * 100.0 /
                NULLIF(es.cq_max + es.mcq_max + es.practical_max + es.ca_max, 0) AS pct
         FROM exam_marks m
         JOIN exam_subjects es ON es.id = m.exam_subject_id
         JOIN prev_subject ps  ON ps.id = es.id
        WHERE NOT m.is_absent
     )
     SELECT t.student_id AS "studentId",
            ROUND(p.pct - t.pct) AS "dropPoints"
       FROM this_exam t JOIN prev p ON p.student_id = t.student_id
      WHERE p.pct - t.pct >= $5`,
    [head.examSubjectId, head.sectionId, head.subjectId, head.examStartsOn ?? dhakaToday(), MARK_DROP_POINTS],
  );
  return new Map(rows.map((r) => [r.studentId, Number(r.dropPoints)]));
}

/** Bangla-Bengali digits. The signal strings are read by teachers, not parsed. */
function bn(n: number): string {
  return String(n).replace(/[0-9]/g, (d) => '০১২৩৪৫৬৭৮৯'[Number(d)]);
}
