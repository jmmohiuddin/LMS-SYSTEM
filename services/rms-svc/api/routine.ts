/**
 * GET /api/v1/rms/routine?scope=day&date=YYYY-MM-DD
 * GET /api/v1/rms/routine?scope=week&weekStart=YYYY-MM-DD
 *
 * The PWA's routine view for the authenticated teacher. Both shapes reuse
 * app.teacher_day() (see db/migrations/006_routines_rms.sql) — it already
 * merges a teacher's own slots with substitutions they're covering for a
 * single date, so "week" is just seven calls to it rather than a second
 * query to keep in sync.
 *
 * date/weekStart default to "today" / "the Sunday on or before today" in
 * the tenant's local sense — we take whatever the caller sends (YYYY-MM-DD)
 * at face value; the PWA is expected to compute these from the device
 * clock, which is what the teacher actually cares about.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { sharedDb } from '../../../packages/server-core/src/db.ts';
import { corsHeaders, query, json, HttpError } from '../../../packages/server-core/src/http.ts';
import { authenticate, requireStaff } from '../../../packages/server-core/src/auth.ts';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

interface TeacherDayRow {
  slot_id: string;
  period_no: number;
  starts_at: string;
  ends_at: string;
  slot_kind: string;
  subject_bn: string | null;
  section_label: string | null;
  room_code: string | null;
  is_substitution: boolean;
  covering_for: string | null;
  student_count: number | null;
  attendance_taken: boolean;
  delivery_logged: boolean;
}

function mapRow(r: TeacherDayRow) {
  return {
    slotId: r.slot_id,
    periodNo: r.period_no,
    startsAt: r.starts_at,
    endsAt: r.ends_at,
    slotKind: r.slot_kind,
    subjectBn: r.subject_bn,
    sectionLabel: r.section_label,
    roomCode: r.room_code,
    isSubstitution: r.is_substitution,
    coveringForBn: r.covering_for,
    studentCount: r.student_count,
    attendanceTaken: r.attendance_taken,
    deliveryLogged: r.delivery_logged,
  };
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Sunday on/before `iso` — Bangladesh's week starts Sunday (see 006 migration comment). */
function sundayOnOrBefore(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - d.getUTCDay());
  return d.toISOString().slice(0, 10);
}

function addDays(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const cors = corsHeaders();
  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors);
    res.end();
    return;
  }
  if (req.method !== 'GET') {
    json(res, 405, { error: 'method_not_allowed' }, cors);
    return;
  }

  try {
    const claims = await authenticate(req);
    requireStaff(claims);

    const q = query(req);
    const scope = q.get('scope') === 'week' ? 'week' : 'day';

    const db = await sharedDb();
    const ctx = { tenantId: claims.tid, userId: claims.sub, role: claims.role };

    if (scope === 'day') {
      const date = q.get('date') ?? todayIso();
      if (!DATE_RE.test(date)) throw new HttpError(400, 'date must be YYYY-MM-DD', 'invalid_date');

      const slots = await db.withTenant(ctx, async (client) => {
        const r = await client.query<TeacherDayRow>(
          `SELECT * FROM app.teacher_day($1, $2::date)`,
          [claims.sub, date],
        );
        return r.rows.map(mapRow);
      });

      json(res, 200, { scope, date, slots }, cors);
      return;
    }

    // scope === 'week'
    const rawStart = q.get('weekStart') ?? sundayOnOrBefore(todayIso());
    if (!DATE_RE.test(rawStart)) throw new HttpError(400, 'weekStart must be YYYY-MM-DD', 'invalid_date');
    const weekStart = sundayOnOrBefore(rawStart);

    const days = await db.withTenant(ctx, async (client) => {
      const out: { date: string; slots: ReturnType<typeof mapRow>[] }[] = [];
      for (let i = 0; i < 7; i++) {
        const date = addDays(weekStart, i);
        const r = await client.query<TeacherDayRow>(
          `SELECT * FROM app.teacher_day($1, $2::date)`,
          [claims.sub, date],
        );
        out.push({ date, slots: r.rows.map(mapRow) });
      }
      return out;
    });

    json(res, 200, { scope, weekStart, days }, cors);
  } catch (err) {
    if (err instanceof HttpError) {
      json(res, err.status, { error: err.code ?? 'error', message: err.message }, cors);
      return;
    }
    console.error('[rms/routine] unexpected error', err);
    json(res, 500, { error: 'internal_error' }, cors);
  }
}
