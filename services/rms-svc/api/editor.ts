/**
 * GET  /api/v1/rms/editor?sectionId=  → one section's week grid, for editing
 * POST /api/v1/rms/editor             → { action: 'create-routine' | 'place'
 *                                        | 'assign' | 'move' | 'remove'
 *                                        | 'publish' }
 *
 * ── P0/A4: the grid could be edited and never filled ─────────────────────
 * `move` and `publish` have existed since §8.1. Nothing could CREATE a
 * `routines` row or a `routine_slots` row: `INSERT INTO routines` appeared
 * nowhere outside test fixtures, api/solve.ts says so in its own header
 * ("routine setup has no admin UI yet"), and the live database held 0
 * routines and 0 slots across every tenant. So the editor opened on an empty
 * grid it had no way to populate, the solver had nothing to fill, and the
 * publish button had nothing to publish. `create-routine`, `place`, `assign`
 * and `remove` are that missing half.
 *
 * F-502 / F-504 / F-506, wireframe §8.1 — the routine editor. The coordinator's
 * hardest screen, and the one the wireframe calls out as needing the most care.
 *
 * ── Why the database refuses, and why that is the point ──────────────────
 * §8.1: "The database exclusion constraints are the final arbiter — the UI is
 * an optimistic proposer." This endpoint is the seam where that is true. It
 * does NOT pre-check whether a move is legal; it attempts the write and lets
 * the three GiST exclusion constraints on routine_slots decide:
 *
 *   rs_no_teacher_double_booking   one teacher, one place, per overlapping hour
 *   rs_no_room_double_booking      one room, likewise
 *   rs_no_section_double_booking   one section, likewise (parallel pools exempt)
 *
 * Re-implementing those checks in TypeScript would create a second, divergent
 * arbiter that is wrong the moment the schema changes — and it would still
 * lose a race against a concurrent editor. The constraints already hold under
 * concurrency; the job here is to turn a 23P01 into a sentence.
 *
 * ── "never just 'invalid'" ───────────────────────────────────────────────
 * §8.1 requires that a rejection explain WHICH existing assignment conflicts.
 * So on a violation this re-queries for the slot that actually occupies the
 * target hour along the violated dimension, and returns it named: the teacher
 * and the class they are already teaching, the room and who is in it. A
 * coordinator who is told only "invalid" has to hunt the grid by eye; a
 * coordinator told "রফিক ইসলাম তখন নবম-খ-তে গণিত পড়াচ্ছেন" can act.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { sharedDb } from '../../../packages/server-core/src/db.ts';
import { corsHeaders, readJson, json, HttpError } from '../../../packages/server-core/src/http.ts';
import { authenticate, requireRole } from '../../../packages/server-core/src/auth.ts';
import { writeAudit } from '../../../packages/server-core/src/audit.ts';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Who owns the timetable. A class teacher reads it; they do not rewrite it. */
const EDITOR_ROLES = ['principal', 'school_owner', 'academic_coordinator'];

/** Statuses whose slots may still be moved. Published history is immutable. */
const EDITABLE = new Set(['draft', 'review']);

type Client = { query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[]; rowCount?: number | null }> };
type Ctx = { tenantId: string; userId: string; role: string };

interface SlotBody {
  action?: string;
  slotId?: string;
  routineId?: string;
  sectionId?: string;
  dayOfWeek?: number;
  periodNo?: number;
  subjectId?: string;
  teacherId?: string;
  roomId?: string | null;
  nameBn?: string;
}

/**
 * The institution's own teaching week.
 *
 * `tenants.weekend_days smallint[]` defaults to {5,6} — Friday and Saturday —
 * but it is per-institution and the live data already varies: one school in
 * this database keeps only Friday. The old grid hard-coded রবি–বৃহঃ, five
 * columns, so for that school Saturday was a teaching day with nowhere to put
 * a lesson. Days are 0=Sunday..6=Saturday, matching routine_slots.day_of_week.
 */
const DAY_BN = ['রবি', 'সোম', 'মঙ্গল', 'বুধ', 'বৃহঃ', 'শুক্র', 'শনি'];

async function teachingDays(c: Client): Promise<{ dow: number; bn: string }[]> {
  const r = await c.query<{ weekend_days: number[] }>(
    `SELECT weekend_days FROM tenants WHERE id = app.current_tenant()`);
  const weekend = new Set((r.rows[0]?.weekend_days ?? [5, 6]).map(Number));
  return [0, 1, 2, 3, 4, 5, 6]
    .filter((d) => !weekend.has(d))
    .map((d) => ({ dow: d, bn: DAY_BN[d] }));
}

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const cors = corsHeaders();
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }

  try {
    const claims = await authenticate(req);
    requireRole(claims, EDITOR_ROLES);
    const db = await sharedDb();
    // No `service:` key, deliberately. The service catalogue (migration 051)
    // has no `routine` or `timetable` entry — the class timetable is not a
    // purchasable service today — so there is nothing for the entitlement gate
    // to consult. That is an absence, not the B-70(b) bypass, which is about
    // handlers omitting a service that DOES exist. Recorded in BACKLOG.
    const ctx = { tenantId: claims.tid, userId: claims.sub, role: claims.role };

    if (req.method === 'GET') {
      const sectionId = new URL(req.url ?? '/', 'http://internal').searchParams.get('sectionId') ?? '';
      if (!UUID_RE.test(sectionId)) {
        throw new HttpError(400, 'sectionId must be a valid uuid', 'invalid_section_id');
      }
      json(res, 200, await db.withTenant(ctx, (c) => loadGrid(c as Client, sectionId)), cors);
      return;
    }

    if (req.method === 'POST') {
      const body = await readJson<SlotBody>(req);
      const write = <T>(fn: (c: Client) => Promise<T>) =>
        db.withTenant(ctx, (c) => fn(c as Client), { write: true });

      if (body.action === 'create-routine') {
        json(res, 200, await write((c) => createRoutine(c, ctx, body)), cors);
        return;
      }
      if (body.action === 'place') {
        json(res, 200, await write((c) => place(c, ctx, body)), cors);
        return;
      }
      if (body.action === 'assign') {
        json(res, 200, await write((c) => assign(c, ctx, body)), cors);
        return;
      }
      if (body.action === 'remove') {
        json(res, 200, await write((c) => remove(c, ctx, body)), cors);
        return;
      }
      if (body.action === 'move') {
        json(res, 200, await write((c) => move(c, body)), cors);
        return;
      }
      if (body.action === 'publish') {
        json(res, 200, await write((c) => publish(c, ctx, body.routineId ?? '')), cors);
        return;
      }
      throw new HttpError(400,
        "action must be 'create-routine', 'place', 'assign', 'move', 'remove' or 'publish'",
        'invalid_action');
    }

    json(res, 405, { error: 'method_not_allowed' }, cors);
  } catch (err) {
    if (err instanceof HttpError) {
      json(res, err.status, { error: err.code ?? 'error', message: err.message, ...(err.detail ?? {}) }, cors);
      return;
    }
    console.error('[rms/editor] unexpected error', err);
    json(res, 500, { error: 'internal_error' }, cors);
  }
}

/* ------------------------------------------------------------------ read */

async function loadGrid(c: Client, sectionId: string) {
  // The section's routine for the CURRENT year. Draft wins over active: the
  // coordinator edits the thing they are building, not the thing in force.
  const r = await c.query<{
    id: string; name_bn: string; shift: string; status: string; version: number;
    published_at: string | null; period_template_id: string;
    section_label: string;
  }>(
    `SELECT rt.id, rt.name_bn, rt.shift, rt.status, rt.version, rt.published_at,
            rt.period_template_id,
            cl.name_bn || '-' || sec.name AS section_label
       FROM sections sec
       JOIN classes cl          ON cl.id = sec.class_id
       JOIN academic_years y    ON y.id = sec.academic_year_id AND y.is_current
       -- Matched on shift as well as year: routines is UNIQUE per
       -- (tenant, year, shift, version) and a section carries its own shift.
       -- Without it a two-shift school's morning section could be handed the
       -- day shift's routine, and with it the wrong period template, so the
       -- grid would draw the wrong bells.
       JOIN routines rt         ON rt.academic_year_id = y.id AND rt.shift = sec.shift
      WHERE sec.id = $1
        AND rt.status IN ('draft','review','active')
      ORDER BY CASE rt.status WHEN 'draft' THEN 0 WHEN 'review' THEN 1 ELSE 2 END,
               rt.version DESC
      LIMIT 1`,
    [sectionId]);
  const routine = r.rows[0];
  const days = await teachingDays(c);

  if (!routine) {
    // Not an error: a section with no routine yet is the normal state — and
    // until A4 it was a PERMANENT one, because nothing could create the
    // routine row. The screen needs enough context to offer that now.
    const setup = await c.query<{
      year_id: string; year_label: string; shift: string;
      template_id: string | null; template_name: string | null;
      section_label: string; year_starts: string;
    }>(
      `SELECT y.id AS year_id, y.label AS year_label, sec.shift::text AS shift,
              pt.id AS template_id, pt.name_bn AS template_name,
              cl.name_bn || '-' || sec.name AS section_label,
              y.starts_on::text AS year_starts
         FROM sections sec
         JOIN classes cl       ON cl.id = sec.class_id
         JOIN academic_years y ON y.id = sec.academic_year_id AND y.is_current
         LEFT JOIN period_templates pt
                ON pt.tenant_id = sec.tenant_id AND pt.shift = sec.shift
               AND pt.is_active
        WHERE sec.id = $1
        ORDER BY pt.effective_from DESC
        LIMIT 1`,
      [sectionId]);
    const st = setup.rows[0];
    return {
      sectionId, routine: null, periods: [], slots: [], days,
      setup: st
        ? {
          academicYearId: st.year_id, yearLabel: st.year_label, shift: st.shift,
          periodTemplateId: st.template_id, periodTemplateName: st.template_name,
          sectionLabel: st.section_label, effectiveFrom: st.year_starts,
        }
        : null,
    };
  }

  const periods = await c.query<{
    period_no: number; label_bn: string; starts_at: string; ends_at: string; kind: string;
  }>(
    `SELECT period_no, label_bn, starts_at, ends_at, kind
       FROM period_definitions
      WHERE template_id = $1
      ORDER BY period_no`,
    [routine.period_template_id]);

  const slots = await c.query<{
    id: string; day_of_week: number; period_no: number;
    subject_bn: string | null; teacher_name: string | null; room_name: string | null;
    is_double: boolean; double_group_id: string | null; parallel_pool: string | null;
    is_pinned: boolean; row_version: number;
  }>(
    `SELECT s.id, s.day_of_week, s.period_no,
            sub.name_bn AS subject_bn,
            u.full_name_bn AS teacher_name,
            -- rooms has code (NOT NULL) and name_bn (nullable). It has no
            -- column called name, and asking for one made both of this file's
            -- slot queries fail at parse time, so the routine editor has never
            -- opened a grid and the clash sentence below has never been shown.
            -- COALESCE rather than code alone because the value lands inside a
            -- Bangla sentence, where ROOM-204 reads worse than a room's own
            -- name when the school has bothered to give it one.
            COALESCE(rm.name_bn, rm.code) AS room_name,
            s.is_double, s.double_group_id, s.parallel_pool, s.is_pinned, s.row_version
       FROM routine_slots s
       LEFT JOIN subjects sub ON sub.id = s.subject_id
       LEFT JOIN users u      ON u.id = s.teacher_id
       LEFT JOIN rooms rm     ON rm.id = s.room_id
      WHERE s.routine_id = $1 AND s.primary_section_id = $2 AND s.status = 'active'
      ORDER BY s.day_of_week, s.period_no`,
    [routine.id, sectionId]);

  // What the authoring form is allowed to offer. Subjects come from the
  // class's own curriculum, teachers from the people actually assigned to
  // teach that subject in THIS section, rooms from the tenant's register.
  // None of it is invented: a picker that offered an unassigned teacher would
  // be proposing a timetable the school never staffed.
  const subjects = await c.query<{
    id: string; name_bn: string; periods_per_week: number; doubles: number;
  }>(
    `SELECT sub.id, sub.name_bn,
            cs.periods_per_week, cs.double_periods_per_week AS doubles
       FROM sections sec
       JOIN class_subjects cs ON cs.class_id = sec.class_id
                             AND cs.academic_year_id = sec.academic_year_id
       JOIN subjects sub      ON sub.id = cs.subject_id
      WHERE sec.id = $1
      ORDER BY sub.name_bn`,
    [sectionId]);

  const teachers = await c.query<{
    subject_id: string; teacher_id: string; name_bn: string;
  }>(
    `SELECT sst.subject_id, sst.teacher_id, u.full_name_bn AS name_bn
       FROM section_subject_teachers sst
       JOIN users u ON u.id = sst.teacher_id
      WHERE sst.section_id = $1
        AND sst.ended_on IS NULL
      ORDER BY u.full_name_bn`,
    [sectionId]);

  const rooms = await c.query<{ id: string; label: string; capacity: number | null }>(
    `SELECT id, COALESCE(name_bn, code) AS label, capacity
       FROM rooms WHERE is_bookable ORDER BY code`);

  return {
    sectionId,
    days,
    subjects: subjects.rows.map((x) => ({
      id: x.id, nameBn: x.name_bn,
      periodsPerWeek: x.periods_per_week, doublePeriodsPerWeek: x.doubles,
    })),
    // Grouped by subject: the teacher picker narrows once a subject is chosen.
    teachers: teachers.rows.map((t) => ({
      subjectId: t.subject_id, id: t.teacher_id, nameBn: t.name_bn,
    })),
    rooms: rooms.rows.map((r2) => ({ id: r2.id, label: r2.label, capacity: r2.capacity })),
    routine: {
      id: routine.id, nameBn: routine.name_bn, shift: routine.shift,
      status: routine.status, version: routine.version,
      publishedAt: routine.published_at,
      editable: EDITABLE.has(routine.status),
      sectionLabel: routine.section_label,
    },
    periods: periods.rows.map((p) => ({
      periodNo: p.period_no, labelBn: p.label_bn,
      startsAt: String(p.starts_at).slice(0, 5), endsAt: String(p.ends_at).slice(0, 5),
      kind: p.kind,
    })),
    slots: slots.rows.map((s) => ({
      id: s.id, dayOfWeek: s.day_of_week, periodNo: s.period_no,
      subjectBn: s.subject_bn, teacherName: s.teacher_name, roomName: s.room_name,
      isDouble: s.is_double, doubleGroupId: s.double_group_id,
      parallelPool: s.parallel_pool, isPinned: s.is_pinned, rowVersion: s.row_version,
    })),
  };
}

/* ------------------------------------------------------- clash checking */

/**
 * The window the exclusion constraints deliberately leave open.
 *
 * Read the three predicates and they do not say the same thing:
 *
 *   rs_no_section_double_booking  (tenant, ROUTINE, section, day, range)
 *                                 WHERE status='active'
 *   rs_no_teacher_double_booking  (tenant, YEAR,    teacher, day, range)
 *                                 WHERE status='active' AND routine_status='active'
 *   rs_no_room_double_booking     (tenant, YEAR,    room,    day, range)   ditto
 *
 * So a section is protected inside its own routine at every status, while
 * teacher and room are protected only once the routine is ACTIVE — and across
 * the whole academic year, not one routine. A draft may therefore be built with
 * one teacher in two places, and the database will not object until publish,
 * when `trg_routines_propagate_status` flips every slot to `routine_status =
 * 'active'` and the constraints suddenly apply to all of them at once.
 *
 * That is a coherent design — a half-built draft should not be nagged — but it
 * is a poor authoring experience: the coordinator would place forty lessons and
 * be told at publish that the third one was wrong. So this checks the two
 * year-scoped dimensions in the API at placement time.
 *
 * It is NOT a second arbiter. The database remains the final gate, and this
 * loses nothing if it races: a clash that slips past here is still refused at
 * publish. It exists to tell someone sooner.
 */
async function findClash(
  c: Client,
  o: {
    academicYearId: string; day: number; startsAt: string; endsAt: string;
    teacherId: string | null; roomId: string | null; excludeSlotId?: string;
  },
): Promise<HttpError | null> {
  for (const dim of [
    { col: 'teacher_id', id: o.teacherId, code: 'teacher_busy' },
    { col: 'room_id', id: o.roomId, code: 'room_busy' },
  ] as const) {
    if (!dim.id) continue;
    const r = await c.query<{
      subject_bn: string | null; teacher_name: string | null;
      room_name: string | null; section_label: string | null;
    }>(
      `SELECT sub.name_bn AS subject_bn, u.full_name_bn AS teacher_name,
              COALESCE(rm.name_bn, rm.code) AS room_name,
              cl.name_bn || '-' || sec.name AS section_label
         FROM routine_slots s
         LEFT JOIN subjects sub ON sub.id = s.subject_id
         LEFT JOIN users u      ON u.id = s.teacher_id
         LEFT JOIN rooms rm     ON rm.id = s.room_id
         LEFT JOIN sections sec ON sec.id = s.primary_section_id
         LEFT JOIN classes cl   ON cl.id = sec.class_id
        WHERE s.academic_year_id = $1
          AND s.status = 'active'
          AND s.slot_kind IN ('teaching','exam')
          AND s.day_of_week = $2
          AND s.${dim.col} = $3
          AND s.starts_at < $5::time AND s.ends_at > $4::time
          AND ($6::uuid IS NULL OR s.id <> $6::uuid)
        LIMIT 1`,
      [o.academicYearId, o.day, dim.id, o.startsAt, o.endsAt, o.excludeSlotId ?? null]);
    const other = r.rows[0];
    if (!other) continue;

    const cls = other.section_label ?? 'অন্য শাখা';
    const subj = other.subject_bn ?? 'ক্লাস';
    const msg = dim.code === 'teacher_busy'
      ? `${other.teacher_name ?? 'এই শিক্ষক'} তখন ${cls}-এ ${subj} পড়াচ্ছেন।`
      : `${other.room_name ?? 'এই কক্ষ'} তখন ${cls}-এর ${subj} ক্লাসে ব্যবহৃত হচ্ছে।`;
    return new HttpError(409, msg, dim.code, {
      conflict: {
        subjectBn: other.subject_bn, teacherName: other.teacher_name,
        roomName: other.room_name, sectionLabel: other.section_label,
      },
    });
  }
  return null;
}

/* ----------------------------------------------------------- authoring */

/**
 * Attempt a write that a constraint may refuse, and survive the refusal.
 *
 * PostgreSQL aborts the whole transaction on a failed statement: every
 * subsequent command answers `current transaction is aborted` until rollback.
 * `explainConflict` runs a SELECT *after* the violation to find out who is
 * already in that hour — so without a savepoint that SELECT dies too, the
 * original 23P01 is replaced by a 25P02, and the handler returns 500.
 *
 * That is not a new hazard. `move` has had this shape since §8.1, which means
 * its clash sentence — the whole "never just 'invalid'" requirement — has
 * never once been produced: every real clash came back as an opaque 500.
 * Found by writing this file's first test.
 *
 * The savepoint is the same device `writeAudit` already uses for the same
 * reason. Rolling back to it discards only the failed statement and leaves the
 * transaction usable, so the explanatory query can run.
 */
async function tryWrite(
  c: Client,
  run: () => Promise<void>,
  onViolation: (e: { code?: string; constraint?: string; message?: string }) => Promise<HttpError>,
): Promise<void> {
  const sp = `rms_${Math.random().toString(36).slice(2, 10)}`;
  await c.query(`SAVEPOINT ${sp}`);
  try {
    await run();
    await c.query(`RELEASE SAVEPOINT ${sp}`);
  } catch (err) {
    await c.query(`ROLLBACK TO SAVEPOINT ${sp}`);
    const e = err as { code?: string; constraint?: string; message?: string };
    if (e.code === '23P01' || e.code === 'P0001' || e.code === '23514' || e.code === '23505') {
      throw await onViolation(e);
    }
    throw err;
  }
}


/** Resolve the target period, shared by `place` and `move`. */
async function resolvePeriod(
  c: Client, templateId: string, periodNo: number,
): Promise<{ id: string; starts_at: string; ends_at: string }> {
  const pd = await c.query<{ id: string; starts_at: string; ends_at: string; kind: string }>(
    `SELECT id, starts_at, ends_at, kind
       FROM period_definitions WHERE template_id = $1 AND period_no = $2`,
    [templateId, periodNo]);
  const target = pd.rows[0];
  if (!target) throw new HttpError(400, 'no such period in this routine', 'unknown_period');
  if (target.kind !== 'teaching') {
    throw new HttpError(409, 'বিরতির ঘরে ক্লাস বসানো যায় না।', 'period_not_teaching');
  }
  return target;
}

/**
 * Create the draft routine a section's grid hangs off.
 *
 * One routine per (year, shift), versioned. `uq_routine_active` already allows
 * at most one ACTIVE routine per (tenant, year, shift); several drafts may
 * coexist, so the version is max+1 rather than a fixed 1.
 */
async function createRoutine(c: Client, ctx: Ctx, b: SlotBody) {
  const sectionId = b.sectionId ?? '';
  if (!UUID_RE.test(sectionId)) {
    throw new HttpError(400, 'sectionId must be a valid uuid', 'invalid_section_id');
  }
  const nameBn = (b.nameBn ?? '').trim();
  if (!nameBn) throw new HttpError(400, 'রুটিনের নাম লিখুন।', 'bad_name', { field: 'nameBn' });
  if (nameBn.length > 120) {
    throw new HttpError(400, 'নাম ১২০ অক্ষরের মধ্যে দিন।', 'bad_name', { field: 'nameBn' });
  }

  const setup = await c.query<{
    year_id: string; shift: string; template_id: string | null; year_starts: string;
  }>(
    `SELECT y.id AS year_id, sec.shift::text AS shift, pt.id AS template_id,
            y.starts_on::text AS year_starts
       FROM sections sec
       JOIN academic_years y ON y.id = sec.academic_year_id AND y.is_current
       LEFT JOIN period_templates pt
              ON pt.tenant_id = sec.tenant_id AND pt.shift = sec.shift AND pt.is_active
      WHERE sec.id = $1
      ORDER BY pt.effective_from DESC
      LIMIT 1`,
    [sectionId]);
  const st = setup.rows[0];
  if (!st) throw new HttpError(404, 'সেকশনটি পাওয়া যায়নি।', 'section_not_found');
  if (!st.template_id) {
    // `app.provision_tenant` clones a bell schedule per shift in tenants.shifts
    // from `period_template_defaults`, which holds only `day` and `morning`
    // rows — so an evening shift is provisioned with a named but EMPTY
    // template, and a school on one has nothing to hang periods off.
    throw new HttpError(409,
      'এই শিফটের জন্য কোনো পিরিয়ড টেমপ্লেট নেই — আগে ঘণ্টার সময়সূচি তৈরি করুন।',
      'no_period_template');
  }

  const v = await c.query<{ next: number }>(
    `SELECT COALESCE(max(version), 0) + 1 AS next
       FROM routines WHERE academic_year_id = $1 AND shift = $2::shift_code`,
    [st.year_id, st.shift]);

  const ins = await c.query<{ id: string; version: number }>(
    `INSERT INTO routines (tenant_id, academic_year_id, period_template_id, shift,
                           name_bn, version, effective_from, generated_by, created_by)
     VALUES (app.current_tenant(), $1, $2, $3::shift_code, $4, $5, $6::date, 'manual', $7)
     RETURNING id, version`,
    [st.year_id, st.template_id, st.shift, nameBn, v.rows[0].next, st.year_starts, ctx.userId]);

  await writeAudit(c as never, ctx, {
    action: 'rms.routine.create',
    entityType: 'routine',
    entityId: ins.rows[0].id,
    after: { nameBn, shift: st.shift, version: ins.rows[0].version },
  });
  return { ok: true, routineId: ins.rows[0].id, version: ins.rows[0].version };
}

/**
 * Put a lesson in an empty cell.
 *
 * Like `move`, this does NOT pre-check the three clashes. The GiST exclusion
 * constraints are the arbiter — re-implementing them here would be a second,
 * divergent one that still loses a race — so the write is attempted and a
 * 23P01 is turned into the sentence §8.1 asks for by `explainConflict`.
 */
async function place(c: Client, ctx: Ctx, b: SlotBody) {
  const routineId = b.routineId ?? '';
  const sectionId = b.sectionId ?? '';
  const subjectId = b.subjectId ?? '';
  const teacherId = b.teacherId ?? '';
  for (const [v, name, code] of [
    [routineId, 'routineId', 'invalid_routine_id'],
    [sectionId, 'sectionId', 'invalid_section_id'],
    [subjectId, 'subjectId', 'invalid_subject_id'],
    [teacherId, 'teacherId', 'invalid_teacher_id'],
  ] as const) {
    if (!UUID_RE.test(v)) throw new HttpError(400, `${name} must be a valid uuid`, code);
  }
  const roomId = b.roomId ? String(b.roomId) : null;
  if (roomId !== null && !UUID_RE.test(roomId)) {
    throw new HttpError(400, 'roomId must be a valid uuid', 'invalid_room_id');
  }
  const day = Number(b.dayOfWeek);
  const periodNo = Number(b.periodNo);
  if (!Number.isInteger(day) || day < 0 || day > 6) {
    throw new HttpError(400, 'dayOfWeek must be 0-6', 'invalid_day');
  }
  if (!Number.isInteger(periodNo)) throw new HttpError(400, 'periodNo is required', 'invalid_period');

  const rt = await c.query<{ status: string; period_template_id: string; shift: string }>(
    `SELECT status::text AS status, period_template_id, shift::text AS shift
       FROM routines WHERE id = $1`, [routineId]);
  const routine = rt.rows[0];
  if (!routine) throw new HttpError(404, 'routine not found', 'routine_not_found');
  if (!EDITABLE.has(routine.status)) {
    throw new HttpError(409,
      'প্রকাশিত রুটিন সরাসরি বদলানো যায় না — নতুন খসড়া তৈরি করুন।', 'routine_not_editable');
  }

  // A day the school does not teach on. The database's CHECK only bounds
  // 0..6; which of those seven are teaching days is the institution's own
  // configuration, and nothing below this line would notice.
  const days = await teachingDays(c);
  if (!days.some((d) => d.dow === day)) {
    throw new HttpError(409,
      'এই দিনটি এই প্রতিষ্ঠানের সাপ্তাহিক ছুটি — ওই দিনে ক্লাস বসানো যায় না।',
      'not_a_teaching_day', { field: 'dayOfWeek' });
  }

  // The section must belong to this routine's shift, or the slot would sit in
  // a grid drawn with another shift's bells.
  const sec = await c.query<{ shift: string }>(
    `SELECT shift::text AS shift FROM sections WHERE id = $1`, [sectionId]);
  if (!sec.rows[0]) throw new HttpError(404, 'সেকশনটি পাওয়া যায়নি।', 'section_not_found');
  if (sec.rows[0].shift !== routine.shift) {
    throw new HttpError(409, 'এই সেকশন অন্য শিফটের।', 'section_wrong_shift', { field: 'sectionId' });
  }

  // The subject must be on that class's curriculum, and the teacher must
  // actually be assigned to teach it in this section. Both are refusals the
  // form should never provoke — its pickers are built from these same two
  // queries — but a direct API call is not the form.
  const ok = await c.query<{ subject_ok: boolean; teacher_ok: boolean }>(
    `SELECT
       EXISTS (SELECT 1 FROM sections sec
                 JOIN class_subjects cs ON cs.class_id = sec.class_id
                                       AND cs.academic_year_id = sec.academic_year_id
                WHERE sec.id = $1 AND cs.subject_id = $2)                AS subject_ok,
       EXISTS (SELECT 1 FROM section_subject_teachers sst
                WHERE sst.section_id = $1 AND sst.subject_id = $2
                  AND sst.teacher_id = $3 AND sst.ended_on IS NULL)      AS teacher_ok`,
    [sectionId, subjectId, teacherId]);
  if (!ok.rows[0]?.subject_ok) {
    throw new HttpError(409,
      'এই বিষয়টি এই শ্রেণির পাঠ্যসূচিতে নেই।', 'subject_not_in_class', { field: 'subjectId' });
  }
  if (!ok.rows[0]?.teacher_ok) {
    throw new HttpError(409,
      'এই শিক্ষককে এই সেকশনে এই বিষয়ের জন্য দায়িত্ব দেওয়া হয়নি।',
      'teacher_not_assigned', { field: 'teacherId' });
  }

  const target = await resolvePeriod(c, routine.period_template_id, periodNo);

  const yr = await c.query<{ academic_year_id: string }>(
    `SELECT academic_year_id FROM routines WHERE id = $1`, [routineId]);
  const clash = await findClash(c, {
    academicYearId: yr.rows[0].academic_year_id,
    day, startsAt: target.starts_at, endsAt: target.ends_at,
    teacherId, roomId,
  });
  if (clash) throw clash;

  let slotId = '';
  await tryWrite(c, async () => {
    const ins = await c.query<{ id: string }>(
      `INSERT INTO routine_slots
         (tenant_id, routine_id, day_of_week, period_no, period_definition_id,
          starts_at, ends_at, slot_kind, primary_section_id, subject_id, teacher_id, room_id)
       VALUES (app.current_tenant(), $1, $2, $3, $4, $5, $6, 'teaching', $7, $8, $9, $10)
       RETURNING id`,
      [routineId, day, periodNo, target.id, target.starts_at, target.ends_at,
        sectionId, subjectId, teacherId, roomId]);
    slotId = ins.rows[0].id;
  }, async (e) => {
    if (e.code === '23P01') {
      return explainConflict(c, e.constraint ?? '',
        { routine_id: routineId, teacher_id: teacherId, room_id: roomId,
          primary_section_id: sectionId },
        day, target.starts_at, target.ends_at);
    }
    return new HttpError(409, e.message ?? 'সমান্তরাল ব্লকের নিয়ম ভেঙে যাচ্ছে।', 'parallel_block_conflict');
  });

  await writeAudit(c as never, ctx, {
    action: 'rms.slot.place',
    entityType: 'routine_slot',
    entityId: slotId,
    after: { routineId, sectionId, subjectId, teacherId, roomId, dayOfWeek: day, periodNo },
  });
  return { ok: true, slotId };
}

/** Change who teaches an existing lesson, what, or where. */
async function assign(c: Client, ctx: Ctx, b: SlotBody) {
  const slotId = b.slotId ?? '';
  if (!UUID_RE.test(slotId)) throw new HttpError(400, 'slotId must be a valid uuid', 'invalid_slot_id');

  const cur = await c.query<{
    routine_id: string; status: string; day_of_week: number;
    starts_at: string; ends_at: string; primary_section_id: string | null;
    subject_id: string | null; teacher_id: string | null; room_id: string | null;
  }>(
    `SELECT s.routine_id, rt.status::text AS status, s.day_of_week, s.starts_at, s.ends_at,
            s.primary_section_id, s.subject_id, s.teacher_id, s.room_id
       FROM routine_slots s
       JOIN routines rt ON rt.id = s.routine_id
      WHERE s.id = $1 AND s.status = 'active'`,
    [slotId]);
  const slot = cur.rows[0];
  if (!slot) throw new HttpError(404, 'slot not found', 'slot_not_found');
  if (!EDITABLE.has(slot.status)) {
    throw new HttpError(409,
      'প্রকাশিত রুটিন সরাসরি বদলানো যায় না — নতুন খসড়া তৈরি করুন।', 'routine_not_editable');
  }

  // Carry forward what was not named, exactly as A1's PATCH does: an omitted
  // field must not silently revert to a default.
  const subjectId = b.subjectId ?? slot.subject_id;
  const teacherId = b.teacherId ?? slot.teacher_id;
  const roomId = b.roomId === undefined ? slot.room_id : (b.roomId ? String(b.roomId) : null);
  if (!subjectId || !teacherId) {
    // routine_slots_check1: a teaching slot must carry section, subject and
    // teacher. Refusing here beats a raw 23514.
    throw new HttpError(400, 'বিষয় ও শিক্ষক দুটোই দিতে হবে।', 'subject_and_teacher_required');
  }

  const ok = await c.query<{ teacher_ok: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM section_subject_teachers sst
                     WHERE sst.section_id = $1 AND sst.subject_id = $2
                       AND sst.teacher_id = $3 AND sst.ended_on IS NULL) AS teacher_ok`,
    [slot.primary_section_id, subjectId, teacherId]);
  if (!ok.rows[0]?.teacher_ok) {
    throw new HttpError(409,
      'এই শিক্ষককে এই সেকশনে এই বিষয়ের জন্য দায়িত্ব দেওয়া হয়নি।',
      'teacher_not_assigned', { field: 'teacherId' });
  }

  const yr2 = await c.query<{ academic_year_id: string }>(
    `SELECT academic_year_id FROM routines WHERE id = $1`, [slot.routine_id]);
  const clash2 = await findClash(c, {
    academicYearId: yr2.rows[0].academic_year_id,
    day: slot.day_of_week, startsAt: slot.starts_at, endsAt: slot.ends_at,
    teacherId, roomId, excludeSlotId: slotId,
  });
  if (clash2) throw clash2;

  await tryWrite(c, async () => {
    await c.query(
      `UPDATE routine_slots
          SET subject_id = $2, teacher_id = $3, room_id = $4,
              row_version = row_version + 1, updated_at = now()
        WHERE id = $1`,
      [slotId, subjectId, teacherId, roomId]);
  }, async (e) => explainConflict(c, e.constraint ?? '',
    { routine_id: slot.routine_id, teacher_id: teacherId, room_id: roomId,
      primary_section_id: slot.primary_section_id },
    slot.day_of_week, slot.starts_at, slot.ends_at));

  await writeAudit(c as never, ctx, {
    action: 'rms.slot.assign',
    entityType: 'routine_slot',
    entityId: slotId,
    before: { subjectId: slot.subject_id, teacherId: slot.teacher_id, roomId: slot.room_id },
    after: { subjectId, teacherId, roomId },
  });
  return { ok: true, slotId };
}

/**
 * Take a lesson out of the grid.
 *
 * A soft delete, because the domain already models one: `routine_slots.status`
 * is `active | removed`. All three exclusion constraints are `WHERE status =
 * 'active'`, so a removed slot stops blocking its hour without the row — and
 * the record of what was once scheduled — being destroyed.
 */
async function remove(c: Client, ctx: Ctx, b: SlotBody) {
  const slotId = b.slotId ?? '';
  if (!UUID_RE.test(slotId)) throw new HttpError(400, 'slotId must be a valid uuid', 'invalid_slot_id');

  const cur = await c.query<{
    status: string; is_pinned: boolean; subject_bn: string | null;
    double_group_id: string | null; is_double: boolean;
  }>(
    `SELECT rt.status::text AS status, s.is_pinned, sub.name_bn AS subject_bn,
            s.double_group_id, s.is_double
       FROM routine_slots s
       JOIN routines rt      ON rt.id = s.routine_id
       LEFT JOIN subjects sub ON sub.id = s.subject_id
      WHERE s.id = $1 AND s.status = 'active'`,
    [slotId]);
  const slot = cur.rows[0];
  if (!slot) throw new HttpError(404, 'slot not found', 'slot_not_found');
  if (!EDITABLE.has(slot.status)) {
    throw new HttpError(409,
      'প্রকাশিত রুটিন সরাসরি বদলানো যায় না — নতুন খসড়া তৈরি করুন।', 'routine_not_editable');
  }
  if (slot.is_pinned) {
    throw new HttpError(409, 'এই ক্লাসটি পিন করা — আগে পিন সরান।', 'slot_pinned');
  }
  if (slot.is_double || slot.double_group_id) {
    // Same reasoning as `move`: half a double period is not a thing.
    throw new HttpError(409,
      'দ্বৈত পিরিয়ড আলাদা করে সরানো যায় না — দুটি অংশ একসাথেই থাকে।', 'double_period_indivisible');
  }

  await c.query(
    `UPDATE routine_slots
        SET status = 'removed', row_version = row_version + 1, updated_at = now()
      WHERE id = $1`,
    [slotId]);

  await writeAudit(c as never, ctx, {
    action: 'rms.slot.remove',
    entityType: 'routine_slot',
    entityId: slotId,
    before: { subjectBn: slot.subject_bn },
  });
  return { ok: true, slotId };
}

/* ------------------------------------------------------------------ move */

async function move(
  c: Client,
  body: { slotId?: string; dayOfWeek?: number; periodNo?: number },
): Promise<{ ok: true; slotId: string }> {
  const slotId = body.slotId ?? '';
  if (!UUID_RE.test(slotId)) throw new HttpError(400, 'slotId must be a valid uuid', 'invalid_slot_id');
  const day = Number(body.dayOfWeek);
  const periodNo = Number(body.periodNo);
  if (!Number.isInteger(day) || day < 0 || day > 6) {
    throw new HttpError(400, 'dayOfWeek must be 0-6', 'invalid_day');
  }
  if (!Number.isInteger(periodNo)) throw new HttpError(400, 'periodNo is required', 'invalid_period');

  const cur = await c.query<{
    routine_id: string; status: string; is_double: boolean; double_group_id: string | null;
    is_pinned: boolean; teacher_id: string | null; room_id: string | null;
    primary_section_id: string | null; period_template_id: string;
  }>(
    `SELECT s.routine_id, rt.status, s.is_double, s.double_group_id, s.is_pinned,
            s.teacher_id, s.room_id, s.primary_section_id, rt.period_template_id
       FROM routine_slots s
       JOIN routines rt ON rt.id = s.routine_id
      WHERE s.id = $1 AND s.status = 'active'`,
    [slotId]);
  const slot = cur.rows[0];
  if (!slot) throw new HttpError(404, 'slot not found', 'slot_not_found');

  if (!EDITABLE.has(slot.status)) {
    throw new HttpError(409,
      'প্রকাশিত রুটিন সরাসরি বদলানো যায় না — নতুন খসড়া তৈরি করুন।', 'routine_not_editable');
  }
  if (slot.is_pinned) {
    throw new HttpError(409, 'এই ক্লাসটি পিন করা — আগে পিন সরান।', 'slot_pinned');
  }
  // §8.1: double periods "cannot be split by drag". Moving one half is exactly
  // that split, so it is refused here rather than half-applied. Moving the
  // pair as a unit is a separate operation this endpoint does not yet offer.
  if (slot.is_double || slot.double_group_id) {
    throw new HttpError(409,
      'দ্বৈত পিরিয়ড আলাদা করে সরানো যায় না — দুটি অংশ একসাথেই থাকে।', 'double_period_indivisible');
  }

  const pd = await c.query<{ id: string; starts_at: string; ends_at: string; kind: string }>(
    `SELECT id, starts_at, ends_at, kind
       FROM period_definitions WHERE template_id = $1 AND period_no = $2`,
    [slot.period_template_id, periodNo]);
  const target = pd.rows[0];
  if (!target) throw new HttpError(400, 'no such period in this routine', 'unknown_period');
  if (target.kind !== 'teaching') {
    throw new HttpError(409, 'বিরতির ঘরে ক্লাস বসানো যায় না।', 'period_not_teaching');
  }

  await tryWrite(c, async () => {
    await c.query(
      `UPDATE routine_slots
          SET day_of_week = $2, period_no = $3, period_definition_id = $4,
              starts_at = $5, ends_at = $6,
              row_version = row_version + 1, updated_at = now()
        WHERE id = $1`,
      [slotId, day, periodNo, target.id, target.starts_at, target.ends_at]);
  }, async (e) => {
    // 23P01 = exclusion_violation. The database has spoken; now say why.
    if (e.code === '23P01') {
      return explainConflict(c, e.constraint ?? '', slot, day, target.starts_at, target.ends_at);
    }
    // The parallel-block trigger raises a plain exception with its own text.
    return new HttpError(409, e.message ?? 'সমান্তরাল ব্লকের নিয়ম ভেঙে যাচ্ছে।', 'parallel_block_conflict');
  });
  return { ok: true, slotId };
}

/**
 * Turn an exclusion violation into the sentence §8.1 demands. The constraint
 * name says WHICH dimension collided; this finds the slot sitting in that
 * hour and names it, so the coordinator learns what to move instead.
 */
async function explainConflict(
  c: Client,
  constraint: string,
  slot: { routine_id: string; teacher_id: string | null; room_id: string | null; primary_section_id: string | null },
  day: number,
  startsAt: string,
  endsAt: string,
): Promise<HttpError> {
  const dims: Record<string, { col: string; id: string | null; code: string }> = {
    rs_no_teacher_double_booking: { col: 'teacher_id', id: slot.teacher_id, code: 'teacher_busy' },
    rs_no_room_double_booking:    { col: 'room_id',    id: slot.room_id,    code: 'room_busy' },
    rs_no_section_double_booking: { col: 'primary_section_id', id: slot.primary_section_id, code: 'section_busy' },
  };
  const dim = dims[constraint];
  if (!dim || !dim.id) {
    return new HttpError(409, 'ওই সময়ে আরেকটি ক্লাস আছে।', 'slot_conflict');
  }

  const r = await c.query<{
    subject_bn: string | null; teacher_name: string | null;
    room_name: string | null; section_label: string | null;
  }>(
    `SELECT sub.name_bn AS subject_bn, u.full_name_bn AS teacher_name,
            COALESCE(rm.name_bn, rm.code) AS room_name,
            cl.name_bn || '-' || sec.name AS section_label
       FROM routine_slots s
       LEFT JOIN subjects sub ON sub.id = s.subject_id
       LEFT JOIN users u      ON u.id = s.teacher_id
       LEFT JOIN rooms rm     ON rm.id = s.room_id
       LEFT JOIN sections sec ON sec.id = s.primary_section_id
       LEFT JOIN classes cl   ON cl.id = sec.class_id
      WHERE s.status = 'active' AND s.day_of_week = $2
        AND s.${dim.col} = $3
        AND s.starts_at < $5::time AND s.ends_at > $4::time
        -- Scoped as the violated constraint is scoped, not always by routine:
        -- the section constraint keys on routine_id, but teacher and room key
        -- on academic_year_id and so can collide with a slot in a DIFFERENT
        -- routine (another shift's, say). Filtering by routine_id for those
        -- two found nothing and fell back to the generic sentence.
        AND ($1::uuid IS NULL OR s.routine_id = $1::uuid)
      LIMIT 1`,
    [dim.code === 'section_busy' ? slot.routine_id : null, day, dim.id, startsAt, endsAt]);
  const other = r.rows[0];

  // Name the clash in the coordinator's own terms. Falling back to the generic
  // sentence only if the conflicting row cannot be read (an RLS-invisible row
  // in another section, say) — better a vague truth than a confident guess.
  if (!other) return new HttpError(409, 'ওই সময়ে আরেকটি ক্লাস আছে।', 'slot_conflict');
  const cls = other.section_label ?? 'অন্য শাখা';
  const subj = other.subject_bn ?? 'ক্লাস';
  const msg =
    dim.code === 'teacher_busy'
      ? `${other.teacher_name ?? 'এই শিক্ষক'} তখন ${cls}-এ ${subj} পড়াচ্ছেন।`
      : dim.code === 'room_busy'
        ? `${other.room_name ?? 'এই কক্ষ'} তখন ${cls}-এর ${subj} ক্লাসে ব্যবহৃত হচ্ছে।`
        : `এই শাখার তখন ${subj} ক্লাস আছে।`;
  return new HttpError(409, msg, dim.code, {
    conflict: {
      subjectBn: other.subject_bn, teacherName: other.teacher_name,
      roomName: other.room_name, sectionLabel: other.section_label,
    },
  });
}

/**
 * The first teacher or room double-booking that would stop publication.
 *
 * Runs against the draft's own slots, pairing each with any other active slot
 * in the same academic year that overlaps it. This is the same question the
 * exclusion constraints ask; asking it in SQL lets the refusal name a person
 * and a class instead of quoting a constraint.
 */
async function firstPublishClash(c: Client, routineId: string): Promise<HttpError | null> {
  const r = await c.query<{
    kind: string; teacher_name: string | null; room_name: string | null;
    mine: string | null; theirs: string | null; subject_bn: string | null;
  }>(
    `SELECT CASE WHEN a.teacher_id = b.teacher_id THEN 'teacher' ELSE 'room' END AS kind,
            u.full_name_bn AS teacher_name,
            COALESCE(rm.name_bn, rm.code) AS room_name,
            mc.name_bn || '-' || ms.name AS mine,
            tc.name_bn || '-' || ts.name AS theirs,
            sub.name_bn AS subject_bn
       FROM routine_slots a
       JOIN routine_slots b
         ON b.academic_year_id = a.academic_year_id
        AND b.id <> a.id
        AND b.status = 'active'
        AND b.slot_kind IN ('teaching','exam')
        AND b.day_of_week = a.day_of_week
        AND b.starts_at < a.ends_at AND b.ends_at > a.starts_at
        AND ((a.teacher_id IS NOT NULL AND b.teacher_id = a.teacher_id)
          OR (a.room_id    IS NOT NULL AND b.room_id    = a.room_id))
       LEFT JOIN users u       ON u.id = a.teacher_id
       LEFT JOIN rooms rm      ON rm.id = a.room_id
       LEFT JOIN subjects sub  ON sub.id = a.subject_id
       LEFT JOIN sections ms   ON ms.id = a.primary_section_id
       LEFT JOIN classes  mc   ON mc.id = ms.class_id
       LEFT JOIN sections ts   ON ts.id = b.primary_section_id
       LEFT JOIN classes  tc   ON tc.id = ts.class_id
      WHERE a.routine_id = $1 AND a.status = 'active'
        AND a.slot_kind IN ('teaching','exam')
      LIMIT 1`,
    [routineId]);
  const x = r.rows[0];
  if (!x) return null;
  const mine = x.mine ?? 'এক শাখা';
  const theirs = x.theirs ?? 'অন্য শাখা';
  return x.kind === 'teacher'
    ? new HttpError(409,
      `${x.teacher_name ?? 'একজন শিক্ষক'} একই সময়ে ${mine} ও ${theirs} — দুই জায়গায় আছেন।`,
      'teacher_busy')
    : new HttpError(409,
      `${x.room_name ?? 'একটি কক্ষ'} একই সময়ে ${mine} ও ${theirs} — দুই ক্লাসে দেওয়া আছে।`,
      'room_busy');
}

/* --------------------------------------------------------------- publish */

async function publish(c: Client, ctx: Ctx, routineId: string) {
  if (!UUID_RE.test(routineId)) throw new HttpError(400, 'routineId must be a valid uuid', 'invalid_routine_id');
  const r = await c.query<{ status: string; unfilled: string }>(
    `SELECT rt.status,
            (SELECT count(*) FROM routine_slots s
              WHERE s.routine_id = rt.id AND s.status = 'active'
                AND s.slot_kind = 'teaching' AND s.teacher_id IS NULL) AS unfilled
       FROM routines rt WHERE rt.id = $1`,
    [routineId]);
  const rt = r.rows[0];
  if (!rt) throw new HttpError(404, 'routine not found', 'routine_not_found');
  if (!EDITABLE.has(rt.status)) {
    throw new HttpError(409, 'এই রুটিন আগেই প্রকাশিত।', 'already_published');
  }
  // Writes routines.status ONLY. Migration 068 separated the exam lifecycle
  // from the routine lifecycle after publishing an exam ROUTINE was found to
  // set exams.status = 'published', which made the exam permanently
  // unmarkable. Nothing in this file touches exams.
  //
  // `trg_routines_cross_shift` fires here and raises check_violation (23514)
  // when the same teacher is booked in both shifts at one hour. That is a
  // business refusal, not a server fault — B-70(a), in this path — so it is a
  // 409 carrying the trigger's own sentence, which names the teacher.
  await tryWrite(c, async () => {
    await c.query(
      `UPDATE routines SET status = 'active', published_at = now(), published_by = $2 WHERE id = $1`,
      [routineId, ctx.userId]);
  }, async (e) => {
    // Publication is where the teacher and room constraints first apply:
    // propagate_routine_status flips every slot to routine_status='active' and
    // the year-scoped exclusions bite all at once. Say which one, not
    // 'conflicting key value violates exclusion constraint'.
    if (e.code === '23P01') {
      const named = await firstPublishClash(c, routineId);
      if (named) return named;
      return new HttpError(409, 'রুটিনে সময়ের সংঘর্ষ আছে — প্রকাশ করা যায়নি।', 'slot_conflict');
    }
    // uq_routine_active: at most one ACTIVE routine per (tenant, year, shift).
    // A school replacing its timetable supersedes the old one rather than
    // running two, and the domain carries `superseded` + supersedes_id for it.
    if (e.code === '23505') {
      return new HttpError(409,
        'এই শিক্ষাবর্ষ ও শিফটে একটি রুটিন ইতিমধ্যে চালু আছে — আগে সেটি বদলান।',
        'routine_already_active');
    }
    return new HttpError(409,
      e.message ?? 'অন্য শিফটের সাথে রুটিন সংঘর্ষ করছে।', 'cross_shift_conflict');
  });
  await writeAudit(c as never, ctx, {
    action: 'rms.routine.publish',
    entityType: 'routine',
    entityId: routineId,
    after: { status: 'active', unfilled: Number(rt.unfilled) },
  });
  // The unfilled count travels with the success, not as a blocker: §8.1 marks
  // gaps ⚠ but does not forbid publishing a routine that still has them — a
  // school often publishes with a known hole while it hires. (§8.3's exam
  // routine is the one that genuinely blocks, and it does so elsewhere.)
  return { ok: true, unfilled: Number(rt.unfilled) };
}
