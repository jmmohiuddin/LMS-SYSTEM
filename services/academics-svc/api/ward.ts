/**
 * GET /api/v1/academics/ward            → the guardian's children
 * GET /api/v1/academics/ward?studentId= → one child's home payload (§9.1)
 *
 * F-1001 / F-1002 / F-203, wireframe §9.1.
 *
 * §9.1's rule, which is really a warning: "This persona has the lowest
 * technical comfort in the product and may use the app four times a year —
 * it must survive being forgotten."
 *
 * That shapes the payload more than any performance concern. Everything
 * §9.1 draws arrives in ONE response: today's attendance, the month's
 * percentage, the outstanding balance with its due date, and the latest
 * published result. A guardian opening the app
 * in August after last using it in May must not watch four spinners
 * resolve in sequence, and must never see a half-drawn screen where the
 * fee card has loaded and the attendance card has not.
 *
 * §9.1 also draws a school-notices list. This schema has no notices table,
 * so that card is not built rather than stubbed — see loadHome().
 *
 * ── The authorisation boundary ───────────────────────────────────────────
 * Every query below is scoped by app.can_see_student(), the same helper
 * the RLS policies use. A guardian passing another school's student id
 * gets a 404 because the row is invisible, not because this file
 * remembered to check — which is the only arrangement worth having.
 *
 * ── What is deliberately NOT here ────────────────────────────────────────
 * Content. §9.1: "The surface leads with attendance, results and fees, not
 * content." A guardian is not a second student, and giving them a syllabus
 * tracker would bury the three things they actually opened the app for.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { sharedDb } from '../../../packages/server-core/src/db.ts';
import { corsHeaders, json, HttpError } from '../../../packages/server-core/src/http.ts';
import { authenticate, requireRole } from '../../../packages/server-core/src/auth.ts';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Staff roles are allowed too: a class teacher looking at what a guardian sees. */
const WARD_ROLES = ['guardian', 'principal', 'school_owner', 'academic_coordinator', 'class_teacher'];

type Client = { query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }> };

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const cors = corsHeaders();
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }
  if (req.method !== 'GET') { json(res, 405, { error: 'method_not_allowed' }, cors); return; }

  try {
    const claims = await authenticate(req);
    requireRole(claims, WARD_ROLES);

    const db = await sharedDb();
    const ctx = { tenantId: claims.tid, userId: claims.sub, role: claims.role };
    const studentId = new URL(req.url ?? '/', 'http://internal').searchParams.get('studentId') ?? '';

    if (studentId && !UUID_RE.test(studentId)) {
      throw new HttpError(400, 'studentId must be a valid uuid', 'invalid_student_id');
    }

    const payload = await db.withTenant(ctx, async (client) => {
      const wards = await loadWards(client);
      if (!studentId) return { wards, student: null };

      const ward = wards.find((w) => w.studentId === studentId);
      // Not 403. The guardian either has this child or does not, and a
      // distinct code would confirm the student exists to somebody who
      // should not be able to learn that.
      if (!ward) throw new HttpError(404, 'student not found', 'student_not_found');

      return { wards, student: await loadHome(client, ward) };
    });

    json(res, 200, payload, cors);
  } catch (err) {
    if (err instanceof HttpError) {
      json(res, err.status, { error: err.code ?? 'error', message: err.message }, cors);
      return;
    }
    json(res, 500, { error: 'internal_error' }, cors);
  }
}

interface Ward {
  studentId: string;
  enrolmentId: string;
  nameBn: string;
  sectionLabel: string;
  rollNo: number;
  relationBn: string;
}

const RELATION_BN: Record<string, string> = {
  father: 'পিতা', mother: 'মাতা', brother: 'ভাই', sister: 'বোন',
  uncle: 'চাচা', aunt: 'খালা', grandparent: 'দাদা/নানা',
  legal_guardian: 'অভিভাবক', other: 'অন্যান্য',
};

/**
 * F-203. Every child this guardian is linked to.
 *
 * §9.1 puts the ward switcher in the header of every guardian screen and
 * calls it "the single most-used control here", so the list ships with
 * every response rather than being fetched again per switch — a guardian
 * with three children switches more often than they do anything else.
 */
async function loadWards(client: Client): Promise<Ward[]> {
  const { rows } = await client.query<{
    student_id: string; enrolment_id: string; name_bn: string;
    section_label: string; roll_no: number; relation: string;
  }>(
    `SELECT u.id AS student_id, e.id AS enrolment_id, u.full_name_bn AS name_bn,
            c.name_bn || '–' || sec.name AS section_label, e.roll_no, g.relation
       FROM guardianships g
       JOIN users u      ON u.id = g.student_id AND u.deleted_at IS NULL
       JOIN enrolments e ON e.student_id = u.id AND e.status = 'active'
       JOIN sections sec ON sec.id = e.section_id
       JOIN classes  c   ON c.id = sec.class_id
       JOIN academic_years y ON y.id = e.academic_year_id AND y.is_current
      WHERE g.guardian_id = app.current_user_id()
      ORDER BY c.level_no DESC, e.roll_no`,
  );
  return rows.map((r) => ({
    studentId: r.student_id,
    enrolmentId: r.enrolment_id,
    nameBn: r.name_bn,
    sectionLabel: r.section_label,
    rollNo: r.roll_no,
    relationBn: RELATION_BN[r.relation] ?? r.relation,
  }));
}

/** Everything §9.1 draws, in one round trip. */
async function loadHome(client: Client, ward: Ward) {
  // Sequential, not Promise.all. These share ONE pooled client inside one
  // transaction, and firing three queries at it concurrently is not
  // something node-postgres promises to handle — the wins would be
  // imaginary anyway, since they queue on the same socket regardless.
  const attendance = await loadAttendance(client, ward.studentId);
  const fees = await loadFees(client, ward.studentId);
  const result = await loadLatestResult(client, ward.studentId);
  // §9.1 also draws a "স্কুলের বিজ্ঞপ্তি" list. There is no notices table
  // in this schema — not an empty one, none — so the field is absent
  // rather than an array that is always empty. A screen that renders an
  // empty notices card teaches a guardian the school never posts anything.
  return { ...ward, attendance, fees, result };
}

async function loadAttendance(client: Client, studentId: string) {
  const { rows } = await client.query<{
    today_status: string | null; present: string; late: string;
    absent: string; half_day: string; excused: string;
  }>(
    `WITH month AS (
       SELECT a.status, a.taken_on AS d
         FROM attendance_records a
        WHERE a.student_id = $1
          AND a.taken_on >= date_trunc('month', CURRENT_DATE)::date
     )
     SELECT (SELECT status FROM month WHERE d = CURRENT_DATE LIMIT 1) AS today_status,
            count(*) FILTER (WHERE status = 'present')  AS present,
            count(*) FILTER (WHERE status = 'late')     AS late,
            count(*) FILTER (WHERE status = 'absent')   AS absent,
            count(*) FILTER (WHERE status = 'half_day') AS half_day,
            count(*) FILTER (WHERE status = 'excused')  AS excused
       FROM month`,
    [studentId]);
  const r = rows[0];
  const n = (v: string | null): number => Number(v ?? 0);
  // Excused is excluded from the denominator — the same rule as F-806's
  // My-attendance screen. A child kept home for a funeral has not missed
  // school in the sense a percentage is measuring.
  const counted = n(r.present) + n(r.late) + n(r.absent) + n(r.half_day);
  return {
    todayStatus: r.today_status,
    monthPercent: counted > 0
      ? Math.round(((n(r.present) + n(r.late) + n(r.half_day) * 0.5) / counted) * 100)
      : null,
    present: n(r.present), absent: n(r.absent), late: n(r.late),
    halfDay: n(r.half_day), excused: n(r.excused),
  };
}

async function loadFees(client: Client, studentId: string) {
  const { rows } = await client.query<{
    outstanding: string; earliest_due: string | null; overdue: string;
  }>(
    `SELECT COALESCE(sum(i.balance_amount), 0) AS outstanding,
            min(i.due_on) FILTER (WHERE i.balance_amount > 0) AS earliest_due,
            count(*) FILTER (WHERE i.balance_amount > 0
                               AND i.due_on < CURRENT_DATE) AS overdue
       FROM invoices i
      WHERE i.student_id = $1 AND i.status <> 'cancelled'`,
    [studentId]);
  const r = rows[0];
  return {
    outstanding: Number(r.outstanding),
    // The date a guardian is looking for is the NEXT one, not the oldest
    // invoice's — that is what tells them whether to act today.
    earliestDue: isoDate(r.earliest_due),
    overdueCount: Number(r.overdue),
  };
}

async function loadLatestResult(client: Client, studentId: string) {
  const { rows } = await client.query<{
    exam_name_bn: string; gpa: string | null; rank_in_section: number | null;
    section_size: number | null;
  }>(
    // Published only. An unpublished result is a working figure, and a
    // guardian who sees one before the school has agreed it will treat it
    // as final.
    //
    // The real lock is one layer down: results_scope (migration 010) lets
    // a guardian read a row only when exam_results.published_at is set, so
    // the filter here is the second lock rather than the guarantee.
    // "মেধাক্রম ৭/৫২" needs the cohort size, which lives on the section
    // as a trigger-maintained count rather than on the result row.
    `SELECT x.name_bn AS exam_name_bn, r.gpa, r.rank_in_section,
            sec.student_count AS section_size
       FROM exam_results r
       JOIN exams x    ON x.id = r.exam_id
       JOIN sections sec ON sec.id = r.section_id
      WHERE r.student_id = $1 AND x.status = 'published'
      ORDER BY r.published_at DESC NULLS LAST, x.starts_on DESC
      LIMIT 1`,
    [studentId]);
  if (!rows[0]) return null;
  const r = rows[0];
  return {
    examNameBn: r.exam_name_bn,
    gpa: r.gpa === null ? null : Number(r.gpa),
    rankInSection: r.rank_in_section,
    sectionSize: r.section_size,
  };
}

/**
 * pg returns a `date` as a JS Date, and String(d).slice(0,10) yields
 * "Thu Dec 17". toISOString is not the fix either: pg parses a bare date
 * at local midnight and Dhaka is UTC+6, so the ISO form is the PREVIOUS
 * day — and a fee due date off by one is a guardian paying late.
 */
function isoDate(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) {
    return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}`
         + `-${String(v.getDate()).padStart(2, '0')}`;
  }
  return String(v).slice(0, 10);
}
