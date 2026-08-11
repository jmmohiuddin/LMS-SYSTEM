/**
 * GET  /api/v1/rms/editor?sectionId=  → one section's week grid, for editing
 * POST /api/v1/rms/editor             → { action: 'move' | 'publish' }
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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Who owns the timetable. A class teacher reads it; they do not rewrite it. */
const EDITOR_ROLES = ['principal', 'school_owner', 'academic_coordinator'];

/** Statuses whose slots may still be moved. Published history is immutable. */
const EDITABLE = new Set(['draft', 'review']);

type Client = { query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }> };

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const cors = corsHeaders();
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }

  try {
    const claims = await authenticate(req);
    requireRole(claims, EDITOR_ROLES);
    const db = await sharedDb();
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
      const body = await readJson<{
        action?: string; slotId?: string; dayOfWeek?: number; periodNo?: number; routineId?: string;
      }>(req);
      if (body.action === 'move') {
        json(res, 200, await db.withTenant(ctx, (c) => move(c as Client, body)), cors);
        return;
      }
      if (body.action === 'publish') {
        json(res, 200, await db.withTenant(ctx, (c) => publish(c as Client, claims.sub, body.routineId ?? '')), cors);
        return;
      }
      throw new HttpError(400, "action must be 'move' or 'publish'", 'invalid_action');
    }

    json(res, 405, { error: 'method_not_allowed' }, cors);
  } catch (err) {
    if (err instanceof HttpError) {
      json(res, err.status, { error: err.code ?? 'error', message: err.message, ...(err.detail ?? {}) }, cors);
      return;
    }
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
       JOIN routines rt         ON rt.academic_year_id = y.id
      WHERE sec.id = $1
        AND rt.status IN ('draft','review','active')
      ORDER BY CASE rt.status WHEN 'draft' THEN 0 WHEN 'review' THEN 1 ELSE 2 END,
               rt.version DESC
      LIMIT 1`,
    [sectionId]);
  const routine = r.rows[0];
  if (!routine) {
    // Not an error: a section with no routine yet is the normal state before
    // generation has run, and the screen says so rather than showing a 404.
    return { routine: null, periods: [], slots: [], sectionId };
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
            rm.name AS room_name,
            s.is_double, s.double_group_id, s.parallel_pool, s.is_pinned, s.row_version
       FROM routine_slots s
       LEFT JOIN subjects sub ON sub.id = s.subject_id
       LEFT JOIN users u      ON u.id = s.teacher_id
       LEFT JOIN rooms rm     ON rm.id = s.room_id
      WHERE s.routine_id = $1 AND s.primary_section_id = $2 AND s.status = 'active'
      ORDER BY s.day_of_week, s.period_no`,
    [routine.id, sectionId]);

  return {
    sectionId,
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

  try {
    await c.query(
      `UPDATE routine_slots
          SET day_of_week = $2, period_no = $3, period_definition_id = $4,
              starts_at = $5, ends_at = $6,
              row_version = row_version + 1, updated_at = now()
        WHERE id = $1`,
      [slotId, day, periodNo, target.id, target.starts_at, target.ends_at]);
  } catch (err) {
    const e = err as { code?: string; constraint?: string; message?: string };
    // 23P01 = exclusion_violation. The database has spoken; now say why.
    if (e.code === '23P01') {
      throw await explainConflict(c, e.constraint ?? '', slot, day, target.starts_at, target.ends_at);
    }
    // The parallel-block trigger raises a plain exception with its own text.
    if (e.code === 'P0001') {
      throw new HttpError(409, e.message ?? 'সমান্তরাল ব্লকের নিয়ম ভেঙে যাচ্ছে।', 'parallel_block_conflict');
    }
    throw err;
  }
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
    `SELECT sub.name_bn AS subject_bn, u.full_name_bn AS teacher_name, rm.name AS room_name,
            cl.name_bn || '-' || sec.name AS section_label
       FROM routine_slots s
       LEFT JOIN subjects sub ON sub.id = s.subject_id
       LEFT JOIN users u      ON u.id = s.teacher_id
       LEFT JOIN rooms rm     ON rm.id = s.room_id
       LEFT JOIN sections sec ON sec.id = s.primary_section_id
       LEFT JOIN classes cl   ON cl.id = sec.class_id
      WHERE s.routine_id = $1 AND s.status = 'active' AND s.day_of_week = $2
        AND s.${dim.col} = $3
        AND s.starts_at < $5::time AND s.ends_at > $4::time
      LIMIT 1`,
    [slot.routine_id, day, dim.id, startsAt, endsAt]);
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

/* --------------------------------------------------------------- publish */

async function publish(c: Client, userId: string, routineId: string) {
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
  await c.query(
    `UPDATE routines SET status = 'active', published_at = now(), published_by = $2 WHERE id = $1`,
    [routineId, userId]);
  // The unfilled count travels with the success, not as a blocker: §8.1 marks
  // gaps ⚠ but does not forbid publishing a routine that still has them — a
  // school often publishes with a known hole while it hires. (§8.3's exam
  // routine is the one that genuinely blocks, and it does so elsewhere.)
  return { ok: true, unfilled: Number(rt.unfilled) };
}
