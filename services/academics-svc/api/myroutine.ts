/**
 * GET /api/v1/academics/myroutine              → the caller's own day (student)
 * GET /api/v1/academics/myroutine?studentId=   → one child's day (guardian)
 * GET /api/v1/academics/myroutine?date=YYYY-MM-DD
 *
 * B-15. The gap P4 named and refused to fabricate around: `GET /rms/routine`
 * wraps `app.teacher_day(claims.sub, …)`, so a student calling it receives
 * their own — empty — TEACHING day. The student home therefore shipped with no
 * "today's classes" card at all, which is the honest outcome and a poor one.
 *
 * ── Why a separate endpoint rather than a flag on /rms/routine ────────────
 * `/rms/routine` is `requireStaff`-gated and returns `attendanceTaken`,
 * `deliveryLogged` and `studentCount` — the operational state of a teacher's
 * day. Widening it would mean either handing those to students or branching on
 * role inside an endpoint whose whole contract is "what am I responsible for
 * today". This one answers a different question — "where do I have to be
 * today" — for a different reader, so it is a different endpoint reading a
 * different function.
 *
 * ── Authorisation ─────────────────────────────────────────────────────────
 * Two layers, and the second is the one that holds:
 *
 *   1. `requireRole` keeps the endpoint to the personas it is for. A teacher
 *      is included deliberately: a class teacher answering "what does 9-A have
 *      after lunch" should not need a second screen, and `can_see_student`
 *      already limits them to their own sections.
 *   2. `app.student_day` inner-joins every row to `app.can_see_student()` —
 *      the same helper the RLS policies use. A guardian naming a child who is
 *      not theirs, or a student naming a classmate, gets an EMPTY DAY, not an
 *      error: an error would confirm the id exists, which is the enumeration
 *      oracle migration 010 and `studenthistory.ts` both avoid.
 *
 * So the failure mode of forgetting a check here is an empty screen, never a
 * leak. That is the arrangement worth having.
 *
 * ── What it does not return ───────────────────────────────────────────────
 * No `attendanceTaken`, no `deliveryLogged`, no `studentCount`. A student does
 * not need to know whether the register has been taken, and the number of
 * children in the room is not theirs to count.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { sharedDb } from '../../../packages/server-core/src/db.ts';
import { corsHeaders, json, HttpError } from '../../../packages/server-core/src/http.ts';
import { authenticate, requireRole } from '../../../packages/server-core/src/auth.ts';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Who may ask. Students and guardians are the point; the three staff roles are
 * here because `can_see_student` already scopes them to their own sections and
 * a class teacher legitimately reads their section's day.
 */
const ROUTINE_ROLES = [
  'student', 'guardian',
  'class_teacher', 'subject_teacher', 'principal', 'school_owner',
  'academic_coordinator',
];

export interface StudentSlot {
  slotId: string;
  periodNo: number;
  startsAt: string;
  endsAt: string;
  kind: string;
  subjectBn: string | null;
  subjectEn: string | null;
  sectionLabel: string | null;
  roomCode: string | null;
  teacherNameBn: string | null;
  isSubstitution: boolean;
}

interface Row {
  slot_id: string;
  period_no: number;
  starts_at: string;
  ends_at: string;
  slot_kind: string;
  subject_bn: string | null;
  subject_en: string | null;
  section_label: string | null;
  room_code: string | null;
  teacher_name_bn: string | null;
  is_substitution: boolean;
}

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const cors = corsHeaders();
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }
  if (req.method !== 'GET') { json(res, 405, { error: 'method_not_allowed' }, cors); return; }

  try {
    const claims = await authenticate(req);
    requireRole(claims, ROUTINE_ROLES);

    const url = new URL(req.url ?? '/', 'http://internal');
    const qsStudent = url.searchParams.get('studentId') ?? '';
    const qsDate = url.searchParams.get('date') ?? '';

    if (qsStudent && !UUID_RE.test(qsStudent)) {
      throw new HttpError(400, 'studentId must be a valid uuid', 'invalid_student_id');
    }
    if (qsDate && !DATE_RE.test(qsDate)) {
      throw new HttpError(400, 'date must be YYYY-MM-DD', 'invalid_date');
    }

    // A student asking about somebody else is refused HERE rather than left to
    // return an empty day. `can_see_student` would already answer nothing, so
    // this changes no data — it changes the message, from a puzzling blank
    // screen to a sentence. The id is not echoed back.
    if (claims.role === 'student' && qsStudent && qsStudent !== claims.sub) {
      throw new HttpError(403, 'a student may only read their own routine', 'forbidden');
    }

    const studentId = qsStudent || claims.sub;
    const db = await sharedDb();
    const ctx = { tenantId: claims.tid, userId: claims.sub, role: claims.role };

    const rows = await db.withTenant(ctx, async (c) => {
      const r = await c.query<Row>(
        `SELECT slot_id, period_no, starts_at::text, ends_at::text, slot_kind,
                subject_bn, subject_en, section_label, room_code,
                teacher_name_bn, is_substitution
           FROM app.student_day($1::uuid, COALESCE($2::date, CURRENT_DATE))`,
        [studentId, qsDate || null],
      );
      return r.rows;
    });

    const slots: StudentSlot[] = rows.map((r) => ({
      slotId: r.slot_id,
      periodNo: r.period_no,
      // `time` comes back as HH:MM:SS; the screen wants HH:MM and should not
      // have to know that.
      startsAt: r.starts_at.slice(0, 5),
      endsAt: r.ends_at.slice(0, 5),
      kind: r.slot_kind,
      subjectBn: r.subject_bn,
      subjectEn: r.subject_en,
      sectionLabel: r.section_label,
      roomCode: r.room_code,
      teacherNameBn: r.teacher_name_bn,
      isSubstitution: r.is_substitution,
    }));

    json(res, 200, {
      date: qsDate || new Date().toISOString().slice(0, 10),
      studentId,
      slots,
    }, cors);
  } catch (err) {
    if (err instanceof HttpError) {
      json(res, err.status, { error: err.code, message: err.message }, cors);
      return;
    }
    json(res, 500, { error: 'internal_error' }, cors);
  }
}
