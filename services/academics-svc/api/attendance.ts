/**
 * GET /api/v1/academics/attendance?studentId=&months=   — F-806, "My attendance"
 *
 * A student's own record, by month and by subject, "with a visible
 * distinction between excused and unexcused" (F-806). That distinction is
 * the entire point of the screen: a child with eight excused absences for
 * a documented illness and a child with eight unexcused ones are in
 * completely different situations, and a single "৯২% উপস্থিতি" figure
 * tells a guardian nothing about which.
 *
 * So the response never reports one rate. It reports the counts by status
 * and lets the surface show them, because collapsing them here would make
 * the distinction unrecoverable downstream.
 *
 * ── What counts as "attendance rate" ─────────────────────────────────────
 * Present and late both count as attended — a student who arrived at 8:15
 * was in the room. Excused is reported separately and excluded from the
 * denominator rather than counted as a miss, which is what "excused"
 * means. Getting this wrong in the other direction is how a school ends up
 * penalising a child for a hospital stay.
 *
 * Visibility is `attendance_scope` in the database: a student sees their
 * own, a guardian their wards', staff their sections. authenticate() is
 * therefore the right gate — requireStaff would break the case this exists
 * for.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { sharedDb } from '../../../packages/server-core/src/db.ts';
import { corsHeaders, query, json, HttpError } from '../../../packages/server-core/src/http.ts';
import { authenticate } from '../../../packages/server-core/src/auth.ts';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULT_MONTHS = 6;
const MAX_MONTHS = 24;

interface MonthRow {
  month: string;
  present: number; late: number; absent: number; excused: number; half_day: number;
}
interface SubjectRow {
  subject_bn: string | null;
  present: number; late: number; absent: number; excused: number;
}
interface RecentRow {
  taken_on: string; status: string; minutes_late: number | null;
  remark: string | null; subject_bn: string | null;
}

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const cors = corsHeaders();
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }
  if (req.method !== 'GET') { json(res, 405, { error: 'method_not_allowed' }, cors); return; }

  try {
    const claims = await authenticate(req);
    const q = query(req);
    const requested = q.get('studentId') ?? '';
    if (requested && !UUID_RE.test(requested)) {
      throw new HttpError(400, 'studentId must be a valid uuid', 'invalid_student_id');
    }
    const studentId = requested || claims.sub;

    const months = Math.min(
      Math.max(Number.parseInt(q.get('months') ?? String(DEFAULT_MONTHS), 10) || DEFAULT_MONTHS, 1),
      MAX_MONTHS,
    );

    const db = await sharedDb();
    const payload = await db.withTenant(
      { tenantId: claims.tid, userId: claims.sub, role: claims.role },
      async (client) => {
        // attendance_records is partitioned by month (migration 011), so
        // bounding on taken_on lets the planner prune rather than scan
        // every partition the school has ever had.
        const since = `${months} months`;

        const byMonth = await client.query<MonthRow>(
          `SELECT to_char(date_trunc('month', taken_on), 'YYYY-MM') AS month,
                  count(*) FILTER (WHERE status = 'present')::int  AS present,
                  count(*) FILTER (WHERE status = 'late')::int     AS late,
                  count(*) FILTER (WHERE status = 'absent')::int   AS absent,
                  count(*) FILTER (WHERE status = 'excused')::int  AS excused,
                  count(*) FILTER (WHERE status = 'half_day')::int AS half_day
             FROM attendance_records
            WHERE student_id = $1
              AND taken_on >= date_trunc('month', CURRENT_DATE - $2::interval)
            GROUP BY 1
            ORDER BY 1 DESC`,
          [studentId, since],
        );

        // Per subject, which is what turns "you missed nine days" into
        // "you missed nine chemistry periods" — the actionable form.
        const bySubject = await client.query<SubjectRow>(
          `SELECT sub.name_bn AS subject_bn,
                  count(*) FILTER (WHERE r.status = 'present')::int AS present,
                  count(*) FILTER (WHERE r.status = 'late')::int    AS late,
                  count(*) FILTER (WHERE r.status = 'absent')::int  AS absent,
                  count(*) FILTER (WHERE r.status = 'excused')::int AS excused
             FROM attendance_records r
             JOIN attendance_sessions s ON s.id = r.session_id
             LEFT JOIN subjects sub ON sub.id = s.subject_id
            WHERE r.student_id = $1
              AND r.taken_on >= date_trunc('month', CURRENT_DATE - $2::interval)
              AND s.subject_id IS NOT NULL
            GROUP BY sub.name_bn
            ORDER BY count(*) FILTER (WHERE r.status = 'absent') DESC, sub.name_bn`,
          [studentId, since],
        );

        // The absences themselves, most recent first. A guardian opening
        // this wants the dates, not a percentage.
        const recent = await client.query<RecentRow>(
          `SELECT r.taken_on::text, r.status::text, r.minutes_late, r.remark,
                  sub.name_bn AS subject_bn
             FROM attendance_records r
             LEFT JOIN attendance_sessions s ON s.id = r.session_id
             LEFT JOIN subjects sub ON sub.id = s.subject_id
            WHERE r.student_id = $1
              AND r.status <> 'present'
              AND r.taken_on >= date_trunc('month', CURRENT_DATE - $2::interval)
            ORDER BY r.taken_on DESC
            LIMIT 60`,
          [studentId, since],
        );

        return { byMonth: byMonth.rows, bySubject: bySubject.rows, recent: recent.rows };
      },
    );

    const totals = payload.byMonth.reduce(
      (a, m) => ({
        present: a.present + m.present, late: a.late + m.late,
        absent: a.absent + m.absent, excused: a.excused + m.excused,
        halfDay: a.halfDay + m.half_day,
      }),
      { present: 0, late: 0, absent: 0, excused: 0, halfDay: 0 },
    );
    // Excused is out of the denominator, not counted as a miss.
    const counted = totals.present + totals.late + totals.absent + totals.halfDay;

    json(res, 200, {
      studentId,
      months,
      totals: {
        ...totals,
        counted,
        attendedPercent: counted > 0
          ? Math.round(((totals.present + totals.late + totals.halfDay * 0.5) / counted) * 100)
          : null,
      },
      byMonth: payload.byMonth.map((m) => ({
        month: m.month,
        present: m.present, late: m.late, absent: m.absent,
        excused: m.excused, halfDay: m.half_day,
      })),
      bySubject: payload.bySubject.map((s) => ({
        subjectBn: s.subject_bn,
        present: s.present, late: s.late, absent: s.absent, excused: s.excused,
      })),
      recent: payload.recent.map((r) => ({
        takenOn: r.taken_on,
        status: r.status,
        minutesLate: r.minutes_late,
        remark: r.remark,
        subjectBn: r.subject_bn,
      })),
    }, cors);
  } catch (err) {
    if (err instanceof HttpError) {
      json(res, err.status, { error: err.code ?? 'error', message: err.message }, cors);
      return;
    }
    console.error('[attendance] unexpected error', err);
    json(res, 500, { error: 'internal_error' }, cors);
  }
}
