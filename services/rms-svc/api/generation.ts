/**
 * GET  /api/v1/rms/generation?routineId=…  → the generation result (§8.2)
 * GET  /api/v1/rms/generation?slotId=…     → why THIS teacher, this room
 * POST /api/v1/rms/generation { routineId, action: 'accept' | 'discard' }
 *
 * Wireframe §8.2, which covers two requirements at once: F-505's "every
 * soft-constraint trade is listed — nothing is silently accepted" and
 * F-503's "output must be explainable: for any slot, why this teacher and
 * this room".
 *
 * ── Hard versus soft, kept apart ─────────────────────────────────────────
 * §8.2 shows two counters, and they mean different things:
 *
 *     ✓ কঠিন শর্ত লঙ্ঘন: ০
 *     ⚠ নরম শর্ত ছাড় দেওয়া হয়েছে: ৭
 *
 * The hard count is not computed here and is not a judgement — it is
 * always zero for a stored routine, because the three exclusion
 * constraints make a hard violation unstorable. Reporting it is not
 * theatre: it tells the coordinator the guarantee exists, and if this
 * number were ever non-zero the database would have failed, not the
 * solver. The soft list is read from where the solver persisted it.
 *
 * ── The explanation is computed, never narrated ──────────────────────────
 * "একমাত্র যোগ্য ও মুক্ত শিক্ষক" is a claim about the school's competency
 * register and the rest of the timetable, and it is checked against both
 * before it is made. Where the answer is "one of several", that is what it
 * says. A confident-sounding explanation that is not true is worse than
 * none, because it ends the coordinator's thinking.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { sharedDb } from '../../../packages/server-core/src/db.ts';
import { corsHeaders, readJson, json, HttpError } from '../../../packages/server-core/src/http.ts';
import { authenticate, requireRole } from '../../../packages/server-core/src/auth.ts';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RMS_ROLES = ['principal', 'school_owner', 'academic_coordinator', 'dept_head'];

interface SoftViolation {
  code: string;
  detailBn: string;
  causeBn?: string;
}

interface StoredReport {
  unplaced?: Array<{ sectionId: string; subjectId: string; missing: number; reason: string }>;
  soft?: SoftViolation[];
  notEvaluated?: Array<{ ruleBn: string; whyBn: string }>;
}

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const cors = corsHeaders();
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }

  try {
    const claims = await authenticate(req);
    requireRole(claims, RMS_ROLES);

    const db = await sharedDb();
    const ctx = { tenantId: claims.tid, userId: claims.sub, role: claims.role };
    const url = new URL(req.url ?? '/', 'http://internal');

    if (req.method === 'POST') {
      const body = await readJson<{ routineId?: string; action?: string }>(req);
      const routineId = body.routineId ?? '';
      if (!UUID_RE.test(routineId)) {
        throw new HttpError(400, 'routineId must be a valid uuid', 'invalid_routine_id');
      }
      if (body.action !== 'accept' && body.action !== 'discard') {
        throw new HttpError(400, "action must be 'accept' or 'discard'", 'invalid_action');
      }
      const out = await db.withTenant(ctx, async (client) => {
        if (body.action === 'accept') {
          try {
            // The cross-shift gate (032) and the exclusion constraints both
            // fire here. Accepting is where a generated routine meets the
            // rest of the school.
            await client.query(
              `UPDATE routines SET status = 'active', published_at = now(), published_by = $2
                WHERE id = $1 AND status IN ('draft','review')`,
              [routineId, claims.sub]);
          } catch (err) {
            const code = (err as { code?: string }).code;
            // 23514 is the cross-shift gate raising by name (032); 23P01 is
            // an exclusion constraint refusing a double-booked teacher or
            // room. Both mean "this routine conflicts with what the school
            // already has", which is a 409 a coordinator can act on — not
            // an internal error.
            if (code !== '23514' && code !== '23P01') throw err;
            throw new HttpError(409, (err as Error).message,
              code === '23514' ? 'cross_shift_clash' : 'slot_conflict');
          }
          return { status: 'active' };
        }
        // Discard keeps the row and its slots. A coordinator who discards
        // a generated routine is rejecting THIS attempt, and the next run
        // is usually a comparison against it — deleting the evidence would
        // make "why was that better?" unanswerable.
        await client.query(
          `UPDATE routines SET status = 'archived' WHERE id = $1 AND status IN ('draft','review')`,
          [routineId]);
        return { status: 'archived' };
      });
      json(res, 200, out, cors);
      return;
    }

    if (req.method !== 'GET') { json(res, 405, { error: 'method_not_allowed' }, cors); return; }

    const slotId = url.searchParams.get('slotId') ?? '';
    if (slotId) {
      if (!UUID_RE.test(slotId)) throw new HttpError(400, 'slotId must be a valid uuid', 'invalid_slot_id');
      json(res, 200, await db.withTenant(ctx, (c) => explainSlot(c, slotId)), cors);
      return;
    }

    const routineId = url.searchParams.get('routineId') ?? '';
    if (!UUID_RE.test(routineId)) {
      throw new HttpError(400, 'routineId must be a valid uuid', 'invalid_routine_id');
    }
    json(res, 200, await db.withTenant(ctx, (c) => report(c, routineId)), cors);
  } catch (err) {
    if (err instanceof HttpError) {
      json(res, err.status, { error: err.code ?? 'error', message: err.message }, cors);
      return;
    }
    json(res, 500, { error: 'internal_error' }, cors);
  }
}

type Client = { query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }> };

async function report(client: Client, routineId: string) {
  const r = await client.query<{
    id: string; name_bn: string; status: string; shift: string;
    objective_score: string | null; solver_seconds: string | null;
    generated_by: string | null; soft_violations: StoredReport;
  }>(
    `SELECT id, name_bn, status, shift, objective_score, solver_seconds,
            generated_by, soft_violations
       FROM routines WHERE id = $1`,
    [routineId]);
  if (!r.rows[0]) throw new HttpError(404, 'routine not found', 'routine_not_found');
  const row = r.rows[0];
  const stored = row.soft_violations ?? {};

  const slots = await client.query<{
    id: string; day_of_week: number; period_no: number;
    starts_at: string; section_label: string; subject_bn: string;
    teacher_name_bn: string; room_code: string | null;
  }>(
    `SELECT rs.id, rs.day_of_week, rs.period_no, rs.starts_at,
            c.name_bn || '–' || sec.name AS section_label,
            sub.name_bn AS subject_bn, u.full_name_bn AS teacher_name_bn,
            rm.code AS room_code
       FROM routine_slots rs
       JOIN sections sec ON sec.id = rs.primary_section_id
       JOIN classes  c   ON c.id = sec.class_id
       JOIN subjects sub ON sub.id = rs.subject_id
       JOIN users    u   ON u.id = rs.teacher_id
       LEFT JOIN rooms rm ON rm.id = rs.room_id
      WHERE rs.routine_id = $1 AND rs.status = 'active' AND rs.slot_kind = 'teaching'
      ORDER BY rs.day_of_week, rs.period_no`,
    [routineId]);

  return {
    routine: {
      id: row.id, nameBn: row.name_bn, status: row.status, shift: row.shift,
      generatedBy: row.generated_by,
      objectiveScore: row.objective_score === null ? null : Number(row.objective_score),
      solverSeconds: row.solver_seconds === null ? null : Number(row.solver_seconds),
    },
    // Always zero for a stored routine: the three exclusion constraints
    // make a hard violation unstorable. Shown because "০" is the statement
    // that the guarantee is real, not a computed result.
    hardViolations: 0,
    soft: stored.soft ?? [],
    unplaced: stored.unplaced ?? [],
    notEvaluated: stored.notEvaluated ?? [],
    slots: slots.rows.map((s) => ({
      id: s.id, dayOfWeek: s.day_of_week, periodNo: s.period_no,
      startsAt: s.starts_at.slice(0, 5), sectionLabel: s.section_label,
      subjectBn: s.subject_bn, teacherNameBn: s.teacher_name_bn, roomCode: s.room_code,
    })),
  };
}

/**
 * F-503: "for any slot, why this teacher and this room."
 *
 * Both answers are counts against the school's own register, not stories.
 * "The only qualified and free teacher" is asserted only when the
 * competency table and the rest of the timetable agree that it is true.
 */
async function explainSlot(client: Client, slotId: string) {
  const s = await client.query<{
    subject_id: string; teacher_id: string; room_id: string | null;
    day_of_week: number; starts_at: string; ends_at: string;
    academic_year_id: string; level_no: number;
    section_label: string; subject_bn: string; teacher_name_bn: string;
    room_code: string | null; requires_capability: string | null;
    home_room_id: string | null; period_no: number; routine_id: string;
  }>(
    `SELECT rs.subject_id, rs.teacher_id, rs.room_id, rs.day_of_week,
            rs.starts_at, rs.ends_at, rs.academic_year_id, rs.period_no,
            rs.routine_id,
            c.level_no, c.name_bn || '–' || sec.name AS section_label,
            sub.name_bn AS subject_bn, sub.requires_capability,
            u.full_name_bn AS teacher_name_bn, rm.code AS room_code,
            sec.home_room_id
       FROM routine_slots rs
       JOIN sections sec ON sec.id = rs.primary_section_id
       JOIN classes  c   ON c.id = sec.class_id
       JOIN subjects sub ON sub.id = rs.subject_id
       JOIN users    u   ON u.id = rs.teacher_id
       LEFT JOIN rooms rm ON rm.id = rs.room_id
      WHERE rs.id = $1`,
    [slotId]);
  if (!s.rows[0]) throw new HttpError(404, 'slot not found', 'slot_not_found');
  const row = s.rows[0];

  // How many teachers could have taken this, and how many of those were
  // actually free at this hour. The second number is the one that makes
  // the explanation true rather than plausible.
  const qualified = await client.query<{ teacher_id: string; busy: boolean }>(
    `SELECT tc.teacher_id,
            EXISTS (
              SELECT 1 FROM routine_slots o
               WHERE o.teacher_id = tc.teacher_id
                 AND o.academic_year_id = $2
                 AND o.day_of_week = $3
                 AND o.starts_at < $5::time AND $4::time < o.ends_at
                 AND o.status = 'active'
                 -- This routine's OWN slots count, plus any ACTIVE
                 -- routine's. A generated routine is a draft, so without
                 -- the first half the explanation would never see the
                 -- placements it is explaining and would call every
                 -- colleague free. Same rule the solver places by.
                 AND (o.routine_id = $8 OR o.routine_status = 'active')
                 AND o.id <> $6
            )
            -- A teacher who declared this hour unavailable was never a
            -- candidate either. The solver filters on it, so an
            -- explanation that ignored it would count people who could not
            -- have taken the slot.
            OR EXISTS (
              SELECT 1 FROM teacher_availability ta
               WHERE ta.teacher_id = tc.teacher_id
                 AND ta.kind = 'unavailable'
                 AND ta.day_of_week = $3
                 AND ta.starts_at < $5::time AND $4::time < ta.ends_at
            ) AS busy
       FROM teacher_competencies tc
      WHERE tc.subject_id = $1 AND tc.is_active
        AND $7 BETWEEN tc.min_class_level AND tc.max_class_level`,
    [row.subject_id, row.academic_year_id, row.day_of_week,
     row.starts_at, row.ends_at, slotId, row.level_no, row.routine_id]);

  const qualifiedCount = qualified.rows.length;
  const freeCount = qualified.rows.filter((q) => !q.busy).length;

  let teacherWhyBn: string;
  if (qualifiedCount === 0) {
    // Honest, and worth surfacing: nobody is registered as competent, so
    // this assignment rests on nothing the system can vouch for.
    teacherWhyBn = `${row.teacher_name_bn} — ${row.subject_bn} এর জন্য কোনো `
                 + 'যোগ্যতা নিবন্ধিত নেই';
  } else if (qualifiedCount === 1) {
    teacherWhyBn = `${row.teacher_name_bn} — ${row.subject_bn} এর একমাত্র যোগ্য শিক্ষক`;
  } else if (freeCount === 1) {
    teacherWhyBn = `${row.teacher_name_bn} — এই পিরিয়ডে একমাত্র যোগ্য ও মুক্ত শিক্ষক`
                 + ` (${toBn(qualifiedCount)} জন যোগ্য)`;
  } else {
    teacherWhyBn = `${row.teacher_name_bn} — ${toBn(freeCount)} জন যোগ্য ও মুক্ত `
                 + 'শিক্ষকের একজন';
  }

  let roomWhyBn: string | null = null;
  if (row.room_code) {
    if (row.requires_capability) {
      const rooms = await client.query<{ count: string }>(
        `SELECT count(*) FROM rooms WHERE $1 = ANY(capabilities) AND is_bookable`,
        [row.requires_capability]);
      const n = Number(rooms.rows[0].count);
      roomWhyBn = n === 1
        ? `${row.room_code} — একমাত্র উপযুক্ত কক্ষ`
        : `${row.room_code} — ${toBn(n)}টি উপযুক্ত কক্ষের একটি`;
    } else if (row.home_room_id && row.home_room_id === row.room_id) {
      roomWhyBn = `${row.room_code} — শাখার নিজস্ব কক্ষ`;
    } else {
      roomWhyBn = `${row.room_code} — সাধারণ শ্রেণিকক্ষ`;
    }
  }

  return {
    slotId,
    sectionLabel: row.section_label,
    subjectBn: row.subject_bn,
    dayOfWeek: row.day_of_week,
    periodNo: row.period_no,
    startsAt: row.starts_at.slice(0, 5),
    teacherWhyBn,
    roomWhyBn,
    qualifiedCount,
    freeCount,
  };
}

const BN_DIGITS = '০১২৩৪৫৬৭৮৯';
const toBn = (n: number): string => String(n).replace(/\d/g, (d) => BN_DIGITS[Number(d)]);
