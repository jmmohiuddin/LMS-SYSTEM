/**
 * GET /api/v1/ops/dashboard — the principal's morning screen
 *
 * R-3 of docs/11-MASTER-PLAN.md, Part A.
 *
 * ── One request, because it is opened on a phone at 8am ─────────────────
 * Nine cards fetched separately is nine round-trips on a 2G connection before
 * a head teacher can see whether their school turned up today. The same
 * decision academics-svc/ward.ts made for the guardian home, for the same
 * reason. It is one `withTenant` call, so it is also one transaction and one
 * consistent picture rather than nine snapshots taken seconds apart.
 *
 * ── What is on it, and what deliberately is not ─────────────────────────
 * The brief lists nine things and adds "do not overload the dashboard.
 * Prioritise daily school operations." Those pull against each other, so:
 * every number here is either something that changes today (attendance,
 * absences) or something that is WAITING for this person (unpublished marks,
 * sections with no class teacher, unassigned subjects). Analytics that do not
 * change between Tuesday and Wednesday belong on a report, not here.
 *
 * The absent list is capped at 12 names. A principal scanning a dashboard is
 * not reading 200 names on a phone; they are noticing whether the number is
 * unusual. The full list is one tap away in attendance.
 *
 * ── Fees appear only for the roles that may see money ───────────────────
 * `financeVisible` is decided here, server-side, and the block is simply
 * absent for a coordinator. Sending the numbers and hiding the card would be
 * the frontend-hiding pattern D13 and R-1 both rule out — the data would still
 * be in the response body, one devtools tab away.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { sharedDb } from '../../../packages/server-core/src/db.ts';
import { corsHeaders, json, HttpError } from '../../../packages/server-core/src/http.ts';
import { authenticate, requireRole } from '../../../packages/server-core/src/auth.ts';

/** Who gets an institution-wide overview at all. */
const DASHBOARD_ROLES = [
  'principal', 'school_owner', 'academic_coordinator', 'it_admin',
];
/** Of those, who may see money. Mirrors finance-svc's BILLING_ROLES. */
const FINANCE_ROLES = new Set(['principal', 'school_owner']);

const ABSENT_LIST_CAP = 12;

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const cors = corsHeaders([], 'GET, OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }
  if (req.method !== 'GET') { json(res, 405, { error: 'method_not_allowed' }, cors); return; }

  try {
    const claims = await authenticate(req);
    requireRole(claims, DASHBOARD_ROLES);
    const showFinance = FINANCE_ROLES.has(claims.role);

    const db = await sharedDb();
    const ctx = { tenantId: claims.tid, userId: claims.sub, role: claims.role };

    const body = await db.withTenant(ctx, async (c) => {
      const { rows: yearRows } = await c.query<{ id: string; label: string }>(
        `SELECT id, label FROM academic_years
          ORDER BY is_current DESC, starts_on DESC LIMIT 1`,
      );
      const year = yearRows[0] ?? null;

      // A tenant with no academic year is a school mid-onboarding, not a
      // failure. Everything below keys off the year, so answer honestly and
      // let the screen say "set up an academic year" instead of showing a
      // dashboard of zeroes that looks like a school with no students.
      if (!year) {
        return { year: null, needsSetup: true };
      }

      const { rows: counts } = await c.query<{
        students: number; teachers: number; sections: number; classes: number;
      }>(
        `SELECT
           (SELECT count(*)::int FROM enrolments e
             WHERE e.academic_year_id = $1 AND e.status = 'active')       AS students,
           (SELECT count(DISTINCT ur.user_id)::int
              FROM user_roles ur
              JOIN roles r ON r.code = ur.role_code AND r.is_staff
              JOIN users u ON u.id = ur.user_id AND u.status = 'active')  AS teachers,
           (SELECT count(*)::int FROM sections s
             WHERE s.academic_year_id = $1)                               AS sections,
           (SELECT count(*)::int FROM classes)                            AS classes`,
        [year.id],
      );

      // Today's attendance, over the sessions that were actually taken. The
      // denominator is deliberately the marked students, not the enrolled
      // ones: at 8:40am most sections have not been taken yet, and dividing
      // by the whole school would show 4% and start a panic.
      const { rows: att } = await c.query<{
        present: number; marked: number; sessions: number; sections_expected: number;
      }>(
        `SELECT
           count(*) FILTER (WHERE ar.status IN ('present','late','half_day'))::int AS present,
           count(ar.id)::int                                                       AS marked,
           (SELECT count(*)::int FROM attendance_sessions s
             WHERE s.taken_on = CURRENT_DATE)                                      AS sessions,
           (SELECT count(*)::int FROM sections s
             WHERE s.academic_year_id = $1)                                        AS sections_expected
         FROM attendance_records ar
        WHERE ar.taken_on = CURRENT_DATE`,
        [year.id],
      );

      const { rows: absent } = await c.query<{
        student_id: string; name_bn: string; roll_no: number;
        section: string; class_bn: string; status: string;
      }>(
        `SELECT ar.student_id, u.full_name_bn AS name_bn, e.roll_no,
                s.name AS section, cl.name_bn AS class_bn, ar.status::text AS status
           FROM attendance_records ar
           JOIN users u     ON u.id = ar.student_id
           JOIN sections s  ON s.id = ar.section_id
           JOIN classes cl  ON cl.id = s.class_id
           LEFT JOIN enrolments e
                  ON e.student_id = ar.student_id AND e.section_id = ar.section_id
                 AND e.status = 'active'
          WHERE ar.taken_on = CURRENT_DATE AND ar.status = 'absent'
          ORDER BY cl.level_no, s.name, e.roll_no
          LIMIT $1`,
        [ABSENT_LIST_CAP],
      );
      const { rows: absentTotal } = await c.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM attendance_records
          WHERE taken_on = CURRENT_DATE AND status = 'absent'`,
      );

      const { rows: exams } = await c.query<{
        id: string; name_bn: string; starts_on: string; status: string;
      }>(
        `SELECT id, name_bn, starts_on::text AS starts_on, status::text AS status
           FROM exams
          WHERE academic_year_id = $1 AND starts_on >= CURRENT_DATE - INTERVAL '7 days'
          ORDER BY starts_on
          LIMIT 5`,
        [year.id],
      );

      const { rows: notices } = await c.query<{
        id: string; title: string; category: string;
        published_at: string | null; recipient_count: number;
      }>(
        `SELECT id, title, category::text AS category,
                published_at::text AS published_at, recipient_count
           FROM notices
          WHERE status = 'published'
          ORDER BY published_at DESC
          LIMIT 5`,
      );

      // The pending block: things that are waiting for a decision by this
      // person. Each one is a real operational failure if it is still true in
      // February, and each is invisible anywhere else in the product.
      const { rows: pending } = await c.query<{
        sections_without_class_teacher: number;
        subjects_without_teacher: number;
        exams_awaiting_publication: number;
        students_without_section: number;
      }>(
        `SELECT
           (SELECT count(*)::int FROM sections s
             WHERE s.academic_year_id = $1 AND s.class_teacher_id IS NULL)
             AS sections_without_class_teacher,
           (SELECT count(*)::int
              FROM sections s
              JOIN class_subjects cs
                ON cs.class_id = s.class_id AND cs.academic_year_id = s.academic_year_id
             WHERE s.academic_year_id = $1
               AND NOT EXISTS (SELECT 1 FROM section_subject_teachers sst
                                WHERE sst.section_id = s.id
                                  AND sst.subject_id = cs.subject_id
                                  AND sst.ended_on IS NULL))
             AS subjects_without_teacher,
           (SELECT count(*)::int FROM exams e
             WHERE e.academic_year_id = $1 AND e.status <> 'published'
               AND e.ends_on < CURRENT_DATE)
             AS exams_awaiting_publication,
           (SELECT count(*)::int
              FROM users u
              JOIN user_roles ur ON ur.user_id = u.id AND ur.role_code = 'student'
             WHERE u.status = 'active'
               AND NOT EXISTS (SELECT 1 FROM enrolments e
                                WHERE e.student_id = u.id
                                  AND e.academic_year_id = $1
                                  AND e.status = 'active'))
             AS students_without_section`,
        [year.id],
      );

      let finance: { invoiced: string; collected: string; outstanding: string; unpaidCount: number } | null = null;
      if (showFinance) {
        // Money stays a string the whole way out: these are numeric(12,2),
        // and the outstanding total is summed BY POSTGRES rather than
        // subtracted in JS. A school's fee balance must not round-trip
        // through a float.
        const { rows: fin } = await c.query<{
          invoiced: string; collected: string; outstanding: string; unpaid: number;
        }>(
          `SELECT COALESCE(sum(i.total_amount),   0)::text AS invoiced,
                  COALESCE(sum(i.paid_amount),    0)::text AS collected,
                  COALESCE(sum(i.balance_amount), 0)::text AS outstanding,
                  count(*) FILTER (WHERE i.balance_amount > 0)::int AS unpaid
             FROM invoices i
            WHERE i.academic_year_id = $1`,
          [year.id],
        );
        finance = {
          invoiced: fin[0]?.invoiced ?? '0',
          collected: fin[0]?.collected ?? '0',
          outstanding: fin[0]?.outstanding ?? '0',
          unpaidCount: fin[0]?.unpaid ?? 0,
        };
      }

      const marked = att[0]?.marked ?? 0;
      return {
        year: { id: year.id, label: year.label },
        needsSetup: false,
        counts: {
          students: counts[0]?.students ?? 0,
          teachers: counts[0]?.teachers ?? 0,
          sections: counts[0]?.sections ?? 0,
          classes: counts[0]?.classes ?? 0,
        },
        attendanceToday: {
          present: att[0]?.present ?? 0,
          marked,
          // 0/0 is "nobody has taken attendance yet", which is a different
          // statement from 0%, and the screen must not render it as one.
          percent: marked > 0 ? Math.round(((att[0]?.present ?? 0) / marked) * 100) : null,
          sessionsTaken: att[0]?.sessions ?? 0,
          sectionsExpected: att[0]?.sections_expected ?? 0,
        },
        absentToday: {
          total: absentTotal[0]?.n ?? 0,
          shown: absent.map((a) => ({
            studentId: a.student_id,
            nameBn: a.name_bn,
            rollNo: a.roll_no,
            section: a.section,
            classBn: a.class_bn,
          })),
        },
        upcomingExams: exams.map((e) => ({
          id: e.id, nameBn: e.name_bn, startsOn: e.starts_on, status: e.status,
        })),
        recentNotices: notices.map((n) => ({
          id: n.id, title: n.title, category: n.category,
          publishedAt: n.published_at, recipientCount: n.recipient_count,
        })),
        pending: {
          sectionsWithoutClassTeacher: pending[0]?.sections_without_class_teacher ?? 0,
          subjectsWithoutTeacher: pending[0]?.subjects_without_teacher ?? 0,
          examsAwaitingPublication: pending[0]?.exams_awaiting_publication ?? 0,
          studentsWithoutSection: pending[0]?.students_without_section ?? 0,
        },
        finance,
      };
    });

    json(res, 200, body, cors);
  } catch (err) {
    if (err instanceof HttpError) {
      json(res, err.status, { error: err.code, message: err.message }, cors);
      return;
    }
    json(res, 500, { error: 'internal_error' }, cors);
  }
}
