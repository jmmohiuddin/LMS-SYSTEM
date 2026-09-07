/**
 * GET /api/v1/rms/timetable?scope=…  → the published routine, for one reader
 *
 * P9-8. Eight audiences, ONE dataset. A school's timetable exists once — the
 * routine whose `status = 'active'` — and every one of these is a WHERE
 * clause over it, not a copy of it:
 *
 *   institution   every shift the school runs
 *   class         one class, all its sections side by side
 *   group         science / humanities / business, across classes
 *   stream        bangla_medium / english_version / madrasah …
 *   section       one section's week
 *   teacher       one teacher's week
 *   room          one room or lab's week
 *   student       one student's week, their optional subjects only
 *
 * The alternative — a per-role table, or a materialised view per audience —
 * is how a school ends up with a teacher and a student reading different
 * timetables for the same hour. There is one routine, and everything below
 * selects from it.
 *
 * ── Only what is PUBLISHED, and never a draft ────────────────────────────
 * `status = 'active'` is the whole visibility rule, and it is applied in the
 * one place every scope passes through. A draft belongs to the coordinator
 * who is building it (P9-5/P9-6) and to the head reviewing it (P9-7); it is
 * not a timetable until somebody publishes it. B-108 made `superseded` a
 * state a school reaches on every revision, and those are excluded by the
 * same clause without needing to be named.
 *
 * ── Authorisation is per SCOPE, not per endpoint ─────────────────────────
 * A single `requireRole` on the handler would be wrong in both directions:
 * it would either let a student ask for the institution or stop a teacher
 * reading their own week. So each scope states who may ask for it, and the
 * subject-level ones ask the database rather than the token —
 * `app.my_section_ids()`, `app.my_ward_ids()` and `app.can_see_student()`
 * already encode "mine", have done since migration 010, and are what the RLS
 * policies themselves use.
 *
 * RLS is underneath all of it: a routine id from another school returns no
 * rows, which this reports as "no published routine" rather than as a
 * refusal, because the two are indistinguishable to a caller who is not
 * entitled to know the difference.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type pg from 'pg';
import { sharedDb } from '../../../packages/server-core/src/db.ts';
import { corsHeaders, query, json, HttpError } from '../../../packages/server-core/src/http.ts';
import { authenticate } from '../../../packages/server-core/src/auth.ts';
import { shiftLabelBn } from '../src/presentation.ts';

type Client = pg.PoolClient;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Who may look at the school as a whole, or at any part of it they choose. */
const ADMIN_ROLES = ['principal', 'school_owner', 'academic_coordinator', 'it_admin'];

export const SCOPES = [
  'institution', 'class', 'group', 'stream', 'section', 'teacher', 'room', 'student',
] as const;
export type Scope = (typeof SCOPES)[number];

const DAY_BN = ['রবি', 'সোম', 'মঙ্গল', 'বুধ', 'বৃহস্পতি', 'শুক্র', 'শনি'];

const GROUP_BN: Record<string, string> = {
  science: 'বিজ্ঞান', humanities: 'মানবিক', business_studies: 'ব্যবসায় শিক্ষা',
  vocational: 'ভোকেশনাল', general: 'সাধারণ', none: 'সাধারণ',
};
const STREAM_BN: Record<string, string> = {
  bangla_medium: 'বাংলা মাধ্যম', english_version: 'ইংরেজি ভার্সন',
  english_medium: 'ইংরেজি মাধ্যম', madrasah: 'মাদরাসা', technical: 'কারিগরি',
};

interface RoutineHead {
  id: string; version: number; shift: string; shiftBn: string;
  nameBn: string; publishedAt: string | null; yearLabel: string;
}
interface Lesson {
  // No lesson id. Nothing renders one, and every uuid that leaves the server
  // is one more thing a screen can accidentally print. `routineId` stays
  // because the grid is grouped by shift and that is what identifies a shift.
  routineId: string; dayOfWeek: number; periodNo: number;
  startsAt: string; endsAt: string;
  subjectBn: string | null; teacherBn: string | null; roomBn: string | null;
  sectionLabel: string | null; classBn: string | null;
  isParallel: boolean;
}
interface Period { routineId: string; periodNo: number; labelBn: string; startsAt: string; endsAt: string }

/**
 * May this caller ask for this scope, and about this subject?
 *
 * Returns the SQL predicate that narrows the published slots, or throws. The
 * predicate and the permission are decided together on purpose: a scope whose
 * authorisation lives apart from its filter is one where the two can drift,
 * and the drift is silent until somebody reads a week they should not have.
 */
async function scopeFilter(
  c: Client, scope: Scope, id: string, role: string,
): Promise<{ where: string; params: unknown[]; titleBn: string; subtitleBn: string }> {
  const isAdmin = ADMIN_ROLES.includes(role);

  const deny = () => new HttpError(403,
    'এই রুটিন দেখার অনুমতি আপনার নেই।', 'forbidden_scope', { scope });

  if (scope === 'institution') {
    if (!isAdmin) throw deny();
    const { rows } = await c.query<{ name_bn: string }>(
      `SELECT name_bn FROM tenants WHERE id = app.current_tenant()`);
    return { where: 'TRUE', params: [],
      titleBn: rows[0]?.name_bn ?? 'প্রতিষ্ঠান',
      subtitleBn: 'পুরো প্রতিষ্ঠানের চালু রুটিন' };
  }

  if (scope === 'class') {
    if (!isAdmin) throw deny();
    if (!UUID_RE.test(id)) throw new HttpError(400, 'শ্রেণি বেছে নিন', 'invalid_class_id');
    const { rows } = await c.query<{ name_bn: string }>(
      `SELECT name_bn FROM classes WHERE id = $1`, [id]);
    if (!rows[0]) throw new HttpError(404, 'শ্রেণি পাওয়া যায়নি', 'class_not_found');
    return { where: 'cls.id = $N', params: [id],
      titleBn: rows[0].name_bn, subtitleBn: 'শ্রেণির সব শাখার রুটিন' };
  }

  if (scope === 'group' || scope === 'stream') {
    if (!isAdmin) throw deny();
    const table = scope === 'group' ? GROUP_BN : STREAM_BN;
    if (!Object.prototype.hasOwnProperty.call(table, id)) {
      throw new HttpError(400,
        scope === 'group' ? 'বিভাগ বেছে নিন' : 'মাধ্যম বেছে নিন',
        scope === 'group' ? 'invalid_group' : 'invalid_stream');
    }
    // `group` is a reserved word and is quoted in the schema; naming the
    // column here rather than interpolating the scope keeps it that way.
    return {
      where: scope === 'group' ? 'cls."group"::text = $N' : 'cls.stream::text = $N',
      params: [id],
      titleBn: table[id],
      subtitleBn: scope === 'group' ? 'এই বিভাগের সব শ্রেণির রুটিন'
                                    : 'এই মাধ্যমের সব শ্রেণির রুটিন',
    };
  }

  if (scope === 'section') {
    if (!UUID_RE.test(id)) throw new HttpError(400, 'শাখা বেছে নিন', 'invalid_section_id');
    // "Mine", asked of the database rather than of the token. A teacher who
    // teaches the section, a student enrolled in it, a guardian whose ward
    // is — each is a different sentence in SQL and the same answer here.
    const { rows } = await c.query<{
      teaches: boolean; enrolled: boolean; name: string | null; class_bn: string | null;
    }>(
      `SELECT $1::uuid = ANY(app.my_section_ids()) AS teaches,
              EXISTS (SELECT 1 FROM enrolments e
                       WHERE e.section_id = $1 AND e.status = 'active'
                         AND (e.student_id = app.current_user_id()
                              OR e.student_id = ANY(app.my_ward_ids()))) AS enrolled,
              (SELECT s.name FROM sections s WHERE s.id = $1) AS name,
              (SELECT c2.name_bn FROM sections s JOIN classes c2 ON c2.id = s.class_id
                WHERE s.id = $1) AS class_bn`,
      [id]);
    const r = rows[0];
    if (!r?.name) throw new HttpError(404, 'শাখা পাওয়া যায়নি', 'section_not_found');
    if (!isAdmin && !r.teaches && !r.enrolled) throw deny();
    return { where: 'rs.primary_section_id = $N', params: [id],
      titleBn: `${r.class_bn ?? ''} — ${r.name}`.trim(),
      subtitleBn: 'শাখার সাপ্তাহিক রুটিন' };
  }

  if (scope === 'teacher') {
    if (!UUID_RE.test(id)) throw new HttpError(400, 'শিক্ষক বেছে নিন', 'invalid_teacher_id');
    // A teacher reads their own week without being an admin. Anyone else's
    // is an administrative question.
    const { rows } = await c.query<{ me: boolean; name_bn: string | null }>(
      `SELECT $1::uuid = app.current_user_id() AS me,
              (SELECT full_name_bn FROM users WHERE id = $1) AS name_bn`, [id]);
    const r = rows[0];
    // Permission BEFORE existence. Checked the other way round, a student
    // asking about a teacher got 404 — because `users_scope` hides the row
    // from them — while asking about a room got 403, and the difference
    // between the two answers is itself information. This way the refusal is
    // the same shape for everyone who may not ask, and 404 is reserved for a
    // caller who MAY ask about somebody who is not there.
    if (!isAdmin && !r?.me) throw deny();
    if (!r?.name_bn) throw new HttpError(404, 'শিক্ষক পাওয়া যায়নি', 'teacher_not_found');
    return { where: 'rs.teacher_id = $N', params: [id],
      titleBn: r.name_bn, subtitleBn: 'শিক্ষকের সাপ্তাহিক রুটিন' };
  }

  if (scope === 'room') {
    if (!isAdmin) throw deny();
    if (!UUID_RE.test(id)) throw new HttpError(400, 'কক্ষ বেছে নিন', 'invalid_room_id');
    const { rows } = await c.query<{ label: string }>(
      `SELECT COALESCE(name_bn, code) AS label FROM rooms WHERE id = $1`, [id]);
    if (!rows[0]) throw new HttpError(404, 'কক্ষ পাওয়া যায়নি', 'room_not_found');
    return { where: 'rs.room_id = $N', params: [id],
      titleBn: rows[0].label, subtitleBn: 'কক্ষের সাপ্তাহিক ব্যবহার' };
  }

  // scope === 'student'
  if (!UUID_RE.test(id)) throw new HttpError(400, 'শিক্ষার্থী বেছে নিন', 'invalid_student_id');
  // `can_see_student` is the same gate `app.student_day` is inner-joined to:
  // the student themselves, a guardian's ward, a teacher of their section,
  // or an administrator. One definition, used by both.
  const { rows } = await c.query<{ allowed: boolean; name_bn: string | null }>(
    `SELECT app.can_see_student($1) AS allowed,
            (SELECT full_name_bn FROM users WHERE id = $1) AS name_bn`, [id]);
  if (!rows[0]?.allowed) throw deny();
  if (!rows[0].name_bn) throw new HttpError(404, 'শিক্ষার্থী পাওয়া যায়নি', 'student_not_found');
  return {
    // The student's own section, and within it only the lessons they take:
    // a parallel block is one hour in which the section splits by religion
    // or optional subject, and showing all of them would put a class on this
    // student's timetable that they do not attend.
    where: `rs.primary_section_id IN (
              SELECT e.section_id FROM enrolments e
               WHERE e.student_id = $N AND e.status = 'active')
            AND (rs.parallel_pool IS NULL
                 OR EXISTS (SELECT 1 FROM student_subjects ss
                             JOIN enrolments e2 ON e2.id = ss.enrolment_id
                            WHERE e2.student_id = $N AND e2.status = 'active'
                              AND ss.subject_id = rs.subject_id))`,
    params: [id],
    titleBn: rows[0].name_bn, subtitleBn: 'শিক্ষার্থীর সাপ্তাহিক রুটিন',
  };
}

/**
 * Every filter takes at most ONE subject, so `$N` is always `$1` — but the
 * student filter names it twice (its section and its optional subjects), and
 * writing `$1` inline in each branch is how the next branch gets it wrong.
 */
function bind(where: string): string {
  return where.replace(/\$N/g, '$1');
}

export async function readTimetable(
  c: Client, scope: Scope, id: string, role: string, yearId: string | null,
) {
  const f = await scopeFilter(c, scope, id, role);
  // One placeholder per filter parameter, whatever how many times the SQL
  // mentions it.
  const where = bind(f.where);

  const { rows: heads } = await c.query<{
    id: string; version: number; shift: string; name_bn: string;
    published_at: string | null; year_label: string;
  }>(
    // The ONE visibility rule. Draft, review and superseded are all excluded
    // by it without being named, which is why a new lifecycle state cannot
    // accidentally become readable by an audience.
    `SELECT r.id, r.version, r.shift::text AS shift, r.name_bn,
            to_char(r.published_at AT TIME ZONE 'UTC',
                    'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS published_at,
            y.label AS year_label
       FROM routines r
       JOIN academic_years y ON y.id = r.academic_year_id
      WHERE r.status = 'active'
        AND ($1::uuid IS NULL OR r.academic_year_id = $1)
      ORDER BY r.shift`,
    [yearId]);
  if (heads.length === 0) {
    return { published: false, titleBn: f.titleBn, subtitleBn: f.subtitleBn,
             routines: [] as RoutineHead[], periods: [] as Period[],
             lessons: [] as Lesson[],
             counts: { sections: 0, teachers: 0, rooms: 0, classes: 0 } };
  }
  const routineIds = heads.map((h) => h.id);

  const { rows: lessons } = await c.query<{
    routine_id: string; day_of_week: number; period_no: number;
    starts_at: string; ends_at: string; subject_bn: string | null;
    teacher_bn: string | null; room_bn: string | null;
    section_label: string | null; class_bn: string | null; parallel_pool: string | null;
  }>(
    `SELECT rs.routine_id, rs.day_of_week, rs.period_no,
            to_char(rs.starts_at, 'HH24:MI') AS starts_at,
            to_char(rs.ends_at, 'HH24:MI') AS ends_at,
            sub.name_bn AS subject_bn,
            u.full_name_bn AS teacher_bn,
            COALESCE(rm.name_bn, rm.code) AS room_bn,
            sec.name AS section_label,
            cls.name_bn AS class_bn,
            rs.parallel_pool
       FROM routine_slots rs
       LEFT JOIN subjects sub ON sub.id = rs.subject_id
       LEFT JOIN users u      ON u.id = rs.teacher_id
       LEFT JOIN rooms rm     ON rm.id = rs.room_id
       LEFT JOIN sections sec ON sec.id = rs.primary_section_id
       LEFT JOIN classes cls  ON cls.id = sec.class_id
      WHERE rs.routine_id = ANY($${f.params.length + 1}::uuid[])
        AND rs.status = 'active'
        AND (${where})
      ORDER BY rs.day_of_week, rs.period_no, cls.level_no, sec.name`,
    [...f.params, routineIds]);

  const { rows: periods } = await c.query<{
    routine_id: string; period_no: number; label_bn: string;
    starts_at: string; ends_at: string;
  }>(
    `SELECT r.id AS routine_id, pd.period_no, pd.label_bn,
            to_char(pd.starts_at, 'HH24:MI') AS starts_at,
            to_char(pd.ends_at, 'HH24:MI') AS ends_at
       FROM routines r
       JOIN period_definitions pd ON pd.template_id = r.period_template_id
      WHERE r.id = ANY($1::uuid[]) AND pd.kind = 'teaching'
      ORDER BY r.shift, pd.period_no`,
    [routineIds]);

  // Counted here, on the ids, and not in the browser on the labels. A
  // section is 'ক' in every class, so de-duplicating the rendered labels told
  // a head their twenty-section school had four — the numbers on this screen
  // have to be the school's, not the grid's.
  const { rows: counts } = await c.query<{
    sections: number; teachers: number; rooms: number; classes: number;
  }>(
    `SELECT count(DISTINCT rs.primary_section_id)::int AS sections,
            count(DISTINCT rs.teacher_id)::int AS teachers,
            count(DISTINCT rs.room_id)::int AS rooms,
            count(DISTINCT sec.class_id)::int AS classes
       FROM routine_slots rs
       LEFT JOIN sections sec ON sec.id = rs.primary_section_id
       LEFT JOIN classes cls  ON cls.id = sec.class_id
      WHERE rs.routine_id = ANY($${f.params.length + 1}::uuid[])
        AND rs.status = 'active'
        AND (${where})`,
    [...f.params, routineIds]);

  return {
    published: true,
    // NOT `...f`. That spread put the SQL predicate and its bound parameter —
    // a section or student UUID — into the HTTP response, where the browser
    // neither needs them nor should see them. Only the two presentation
    // fields cross the wire.
    titleBn: f.titleBn,
    subtitleBn: f.subtitleBn,
    counts: counts[0] ?? { sections: 0, teachers: 0, rooms: 0, classes: 0 },
    routines: heads.map((h): RoutineHead => ({
      id: h.id, version: h.version, shift: h.shift, shiftBn: shiftLabelBn(h.shift),
      nameBn: h.name_bn, publishedAt: h.published_at, yearLabel: h.year_label,
    })),
    periods: periods.map((p): Period => ({
      routineId: p.routine_id, periodNo: p.period_no, labelBn: p.label_bn,
      startsAt: p.starts_at, endsAt: p.ends_at,
    })),
    lessons: lessons.map((l): Lesson => ({
      routineId: l.routine_id, dayOfWeek: l.day_of_week, periodNo: l.period_no,
      startsAt: l.starts_at, endsAt: l.ends_at,
      subjectBn: l.subject_bn, teacherBn: l.teacher_bn, roomBn: l.room_bn,
      sectionLabel: l.section_label, classBn: l.class_bn,
      isParallel: l.parallel_pool !== null,
    })),
  };
}

/** The days this school teaches, so an empty column is not drawn for Friday. */
async function teachingDays(c: Client): Promise<Array<{ dow: number; bn: string }>> {
  const { rows } = await c.query<{ weekend: number[] }>(
    `SELECT weekend_days AS weekend FROM tenants WHERE id = app.current_tenant()`);
  const weekend = new Set(rows[0]?.weekend ?? [5, 6]);
  return [0, 1, 2, 3, 4, 5, 6]
    .filter((d) => !weekend.has(d))
    .map((d) => ({ dow: d, bn: DAY_BN[d] }));
}

/**
 * What this caller may ask for at all, so the screen offers exactly that.
 *
 * Derived from the same role list and the same database helpers the filters
 * use — a picker built from a second opinion is one that eventually offers a
 * scope the server refuses.
 */
async function offered(c: Client, role: string) {
  const isAdmin = ADMIN_ROLES.includes(role);
  const out: Array<{ scope: Scope; labelBn: string; options?: Array<{ id: string; labelBn: string }> }> = [];

  if (isAdmin) {
    out.push({ scope: 'institution', labelBn: 'পুরো প্রতিষ্ঠান' });
    const { rows: classes } = await c.query<{ id: string; name_bn: string }>(
      `SELECT id, name_bn FROM classes ORDER BY level_no, name_bn`);
    out.push({ scope: 'class', labelBn: 'শ্রেণি',
      options: classes.map((x) => ({ id: x.id, labelBn: x.name_bn })) });
    const { rows: groups } = await c.query<{ g: string }>(
      `SELECT DISTINCT "group"::text AS g FROM classes ORDER BY 1`);
    out.push({ scope: 'group', labelBn: 'বিভাগ',
      options: groups.map((x) => ({ id: x.g, labelBn: GROUP_BN[x.g] ?? x.g })) });
    const { rows: streams } = await c.query<{ s: string }>(
      `SELECT DISTINCT stream::text AS s FROM classes ORDER BY 1`);
    out.push({ scope: 'stream', labelBn: 'মাধ্যম',
      options: streams.map((x) => ({ id: x.s, labelBn: STREAM_BN[x.s] ?? x.s })) });
    const { rows: rooms } = await c.query<{ id: string; label: string }>(
      `SELECT id, COALESCE(name_bn, code) AS label FROM rooms
        WHERE is_bookable ORDER BY code`);
    out.push({ scope: 'room', labelBn: 'কক্ষ ও ল্যাব',
      options: rooms.map((x) => ({ id: x.id, labelBn: x.label })) });
    const { rows: teachers } = await c.query<{ id: string; name_bn: string }>(
      `SELECT DISTINCT u.id, u.full_name_bn AS name_bn
         FROM users u JOIN user_roles ur ON ur.user_id = u.id
        WHERE ur.role_code IN ('subject_teacher','class_teacher','dept_head','principal')
          AND u.status = 'active'
        ORDER BY 2`);
    out.push({ scope: 'teacher', labelBn: 'শিক্ষক',
      options: teachers.map((x) => ({ id: x.id, labelBn: x.name_bn })) });
  }

  // Everyone gets the parts of the school that are theirs, named from the
  // database rather than from the token.
  //
  // "My own week" first, because for a teacher it is the whole reason they
  // opened this screen, and for a student it is the only thing on it. `self`
  // is resolved by the handler to the caller, so no id leaves the server.
  const { rows: self } = await c.query<{ teaches: boolean; studies: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM routine_slots rs
                     JOIN routines r ON r.id = rs.routine_id
                    WHERE r.status = 'active' AND rs.status = 'active'
                      AND rs.teacher_id = app.current_user_id()) AS teaches,
            EXISTS (SELECT 1 FROM enrolments e
                    WHERE e.student_id = app.current_user_id()
                      AND e.status = 'active') AS studies`);
  if (self[0]?.teaches) {
    out.unshift({ scope: 'teacher', labelBn: 'আমার রুটিন',
      options: [{ id: 'self', labelBn: 'আমার সাপ্তাহিক ক্লাস' }] });
  }
  if (self[0]?.studies) {
    out.unshift({ scope: 'student', labelBn: 'আমার রুটিন',
      options: [{ id: 'self', labelBn: 'আমার সাপ্তাহিক ক্লাস' }] });
  }

  const { rows: mine } = await c.query<{ id: string; label: string }>(
    `SELECT s.id, c.name_bn || ' — ' || s.name AS label
       FROM sections s JOIN classes c ON c.id = s.class_id
      WHERE s.id = ANY(app.my_section_ids())
      ORDER BY c.level_no, s.name`);
  if (mine.length > 0 && !isAdmin) {
    out.push({ scope: 'section', labelBn: 'আমার শাখা',
      options: mine.map((x) => ({ id: x.id, labelBn: x.label })) });
  }
  const { rows: wards } = await c.query<{ id: string; name_bn: string }>(
    `SELECT id, full_name_bn AS name_bn FROM users
      WHERE id = ANY(app.my_ward_ids()) ORDER BY 2`);
  if (wards.length > 0) {
    out.push({ scope: 'student', labelBn: 'আমার সন্তান',
      options: wards.map((x) => ({ id: x.id, labelBn: x.name_bn })) });
  }
  return out;
}

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const cors = corsHeaders([], 'GET, OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }
  if (req.method !== 'GET') { json(res, 405, { error: 'method_not_allowed' }, cors); return; }

  try {
    const claims = await authenticate(req);
    const db = await sharedDb();
    const ctx = { tenantId: claims.tid, userId: claims.sub, role: claims.role };
    const q = query(req);

    const raw = q.get('scope') ?? '';
    if (raw !== '' && !SCOPES.includes(raw as Scope)) {
      throw new HttpError(400, `scope must be one of: ${SCOPES.join(', ')}`, 'invalid_scope');
    }
    const yearId = q.get('yearId');
    if (yearId && !UUID_RE.test(yearId)) {
      throw new HttpError(400, 'শিক্ষাবর্ষ বেছে নিন', 'invalid_year');
    }

    const out = await db.withTenant(ctx, async (c) => {
      const menu = await offered(c as Client, claims.role);

      // An omitted scope is answered from the reader's OWN menu — the first
      // thing `offered()` lists for them, which is by construction something
      // they may have. Deliberately not "some default scope": a default is a
      // second opinion about permission, and the day somebody widens a role
      // list a default becomes a leak. The menu cannot leak, because it is
      // the same function the filters below are gated by.
      if (menu.length === 0) {
        throw new HttpError(403,
          'এই প্রতিষ্ঠানে আপনার দেখার মতো কোনো রুটিন নেই।', 'no_scope_offered');
      }
      const chosen = raw === '' ? menu[0].scope : (raw as Scope);
      const idParam = q.get('id')
        ?? (raw === '' ? (menu[0].options?.[0]?.id ?? '') : '');
      // `self` is the only shorthand, and it means the caller.
      const id = idParam === 'self' ? claims.sub : idParam;

      const data = await readTimetable(c as Client, chosen, id, claims.role, yearId);
      return { ok: true, scope: chosen, id, ...data,
               days: await teachingDays(c as Client),
               offered: menu };
    });
    json(res, 200, out, cors);
  } catch (err) {
    if (err instanceof HttpError) {
      json(res, err.status, { error: err.code, message: err.message, ...(err.detail ?? {}) }, cors);
      return;
    }
    console.error('[rms/timetable]', err);
    json(res, 500, { error: 'internal_error', message: 'রুটিন আনা যায়নি।' }, cors);
  }
}
