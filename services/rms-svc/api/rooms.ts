/**
 * GET   /api/v1/rms/rooms   — the room register
 * POST  /api/v1/rms/rooms   — add a room
 * PATCH /api/v1/rms/rooms   — correct one, or take it out of service
 *
 * ── Why this exists ─────────────────────────────────────────────────────
 * `rooms` has been a read-only table since migration 003. The solver reads it,
 * the routine grid joins it, the admit card prints it, the exam seat plan
 * depends on it — and nothing in the product has ever written a row. Across
 * 112 institutions in the working database there were **zero rooms**, so every
 * one of those readers was reading an empty table and the room half of the
 * timetable simply did not exist.
 *
 * ── Where the authorization actually lives ──────────────────────────────
 * Migration 065, in the same commit as this file. Until then `rooms` carried
 * `tenant_isolation` and no role scope at all, so a session holding
 * `app.role = 'student'` could insert a room — proved against a live database
 * before the policy was written. `requireRole` below is the clean 403 in front
 * of that; the database is what refuses.
 *
 * ── Deactivating is not deleting ────────────────────────────────────────
 * There is no DELETE here and migration 065 gives no role one.
 * `exam_halls.room_id` is ON DELETE RESTRICT, while `sections.home_room_id`
 * and `routine_slots.room_id` are ON DELETE SET NULL — so a delete either
 * fails on an exam hall or silently strips the room out of every timetable row
 * that ever named it, and a past routine quietly forgets where a class was
 * held. A room a school stops using gets `is_bookable = false`; the history
 * keeps pointing at it.
 *
 * ── One honest limitation ───────────────────────────────────────────────
 * `is_bookable = false` removes a room from the solver's spare and capable
 * pools. It does NOT remove it from a section's `home_room_id`, so an ordinary
 * class can still be placed in a room that has been taken out of service. That
 * is the existing solver's behaviour, it is not changed here, and the UI says
 * so where a room is still some section's home.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { sharedDb } from '../../../packages/server-core/src/db.ts';
import { corsHeaders, readJson, json, HttpError } from '../../../packages/server-core/src/http.ts';
import { authenticate, requireRole, requireStaff } from '../../../packages/server-core/src/auth.ts';
import { writeAudit } from '../../../packages/server-core/src/audit.ts';

/** Mirrors rooms_insert_scope / rooms_update_scope in migration 065. */
const ROOM_ROLES = ['principal', 'school_owner', 'academic_coordinator', 'it_admin'];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CODE_MAX = 20;
const NAME_MAX = 80;
const BUILDING_MAX = 60;
/** `capacity` is a smallint. 1000 is a hall; 32767 is a typo. */
const CAPACITY_MIN = 1;
const CAPACITY_MAX = 1000;
const FLOOR_MIN = -2;
const FLOOR_MAX = 20;
const CAPS_MAX = 8;
/** The same number as a Bangla numeral, for the sentence the office reads. */
const CAPS_MAX_BN = '৮';

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const cors = corsHeaders([], 'GET, POST, PATCH, OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }

  try {
    const claims = await authenticate(req);
    const db = await sharedDb();
    const ctx = { tenantId: claims.tid, userId: claims.sub, role: claims.role };

    // Reading is staff-wide: a class teacher hunting for a free room needs the
    // list, and it holds nothing private. Writing is the office's.
    if (req.method === 'GET') { requireStaff(claims); json(res, 200, await list(db, ctx), cors); return; }
    if (req.method === 'POST') { requireRole(claims, ROOM_ROLES); json(res, 200, await create(db, ctx, req), cors); return; }
    if (req.method === 'PATCH') { requireRole(claims, ROOM_ROLES); json(res, 200, await update(db, ctx, req), cors); return; }

    json(res, 405, { error: 'method_not_allowed' }, cors);
  } catch (err) {
    if (err instanceof HttpError) {
      json(res, err.status, { error: err.code, message: err.message, ...(err.detail ?? {}) }, cors);
      return;
    }
    const e = err as { code?: string; constraint?: string };
    // A duplicate code is a typo the office can fix, not a 500.
    if (e.code === '23505' && e.constraint === 'rooms_tenant_id_code_key') {
      json(res, 409, {
        error: 'duplicate_code', message: 'এই কোডের কক্ষ ইতিমধ্যে আছে।', field: 'code',
      }, cors);
      return;
    }
    console.error('[rms/rooms] unexpected error', err);
    json(res, 500, { error: 'internal_error' }, cors);
  }
}

type Db = Awaited<ReturnType<typeof sharedDb>>;
type Ctx = { tenantId: string; userId: string; role: string };

interface Row {
  id: string; code: string; name_bn: string | null; building: string | null;
  floor_no: number | null; capacity: number | null;
  capabilities: string[] | null; is_bookable: boolean;
  home_sections: number; slot_count: number; hall_count: number;
}

const shape = (r: Row) => ({
  id: r.id, code: r.code, nameBn: r.name_bn, building: r.building,
  floorNo: r.floor_no, capacity: r.capacity,
  capabilities: r.capabilities ?? [], isBookable: r.is_bookable,
  homeSections: Number(r.home_sections), slotCount: Number(r.slot_count),
  hallCount: Number(r.hall_count),
});

/**
 * What a capability may be, read from the database rather than a constant.
 *
 * There is no CHECK on `rooms.capabilities`, so the only real definition of a
 * valid capability is "something a subject actually requires". A hard-coded
 * list in TypeScript drifts the day a school adds a subject, and a capability
 * nobody requires is a room attribute that can never match anything.
 * `subject_catalogue` is platform-global and `subjects` is tenant-scoped, so
 * the union is correctly per-school.
 */
async function capabilityOptions(c: { query: (t: string) => Promise<{ rows: Array<{ cap: string }> }> }): Promise<string[]> {
  const { rows } = await c.query(
    `SELECT cap FROM (
       SELECT DISTINCT requires_capability AS cap FROM subject_catalogue WHERE requires_capability IS NOT NULL
       UNION
       SELECT DISTINCT requires_capability      FROM subjects           WHERE requires_capability IS NOT NULL
     ) u ORDER BY cap`);
  return rows.map((r) => r.cap);
}

async function list(db: Db, ctx: Ctx): Promise<unknown> {
  return db.withTenant(ctx, async (c) => {
    const { rows } = await c.query<Row>(
      // The three counts exist so the "take out of service" confirmation can
      // say what the room is currently carrying, instead of asking blind.
      `SELECT r.id, r.code, r.name_bn, r.building, r.floor_no, r.capacity,
              r.capabilities, r.is_bookable,
              (SELECT count(*) FROM sections s WHERE s.home_room_id = r.id) AS home_sections,
              (SELECT count(*) FROM routine_slots rs
                 JOIN routines rt ON rt.id = rs.routine_id
                WHERE rs.room_id = r.id AND rs.status = 'active'
                  AND rt.status IN ('draft','review','active'))            AS slot_count,
              (SELECT count(*) FROM exam_halls h WHERE h.room_id = r.id)   AS hall_count
         FROM rooms r
        ORDER BY r.is_bookable DESC, r.code`);

    return {
      canManage: ROOM_ROLES.includes(ctx.role),
      capabilityOptions: await capabilityOptions(c),
      rooms: rows.map(shape),
    };
  });
}

interface Body {
  id?: string; code?: string; nameBn?: string; building?: string;
  floorNo?: number | null; capacity?: number; capabilities?: unknown; isBookable?: boolean;
}

/** Everything both writers validate, in one place so they cannot disagree. */
async function clean(
  body: Body,
  allowed: string[],
  opts: { requireCode: boolean },
): Promise<{ code: string; nameBn: string; building: string; floorNo: number | null; capacity: number; capabilities: string[] }> {
  const code = (body.code ?? '').trim();
  if (opts.requireCode || body.code !== undefined) {
    if (!code) throw new HttpError(400, 'কক্ষের কোড লিখুন।', 'bad_code', { field: 'code' });
    if (code.length > CODE_MAX) {
      throw new HttpError(400, `কোড ${CODE_MAX} অক্ষরের মধ্যে দিন।`, 'bad_code', { field: 'code' });
    }
  }

  const nameBn = (body.nameBn ?? '').trim();
  if (nameBn.length > NAME_MAX) {
    throw new HttpError(400, `নাম ${NAME_MAX} অক্ষরের মধ্যে দিন।`, 'bad_name', { field: 'nameBn' });
  }
  const building = (body.building ?? '').trim();
  if (building.length > BUILDING_MAX) {
    throw new HttpError(400, `ভবনের নাম ${BUILDING_MAX} অক্ষরের মধ্যে দিন।`, 'bad_building', { field: 'building' });
  }

  const floorNo = body.floorNo === undefined || body.floorNo === null ? null : Number(body.floorNo);
  if (floorNo !== null && (!Number.isInteger(floorNo) || floorNo < FLOOR_MIN || floorNo > FLOOR_MAX)) {
    throw new HttpError(400, `তলা ${FLOOR_MIN} থেকে ${FLOOR_MAX}-এর মধ্যে দিন।`, 'bad_floor', { field: 'floorNo' });
  }

  // Not optional in spirit. The column defaults to 60, but a blank field that
  // silently means 60 is a lie about a number the exam seat-grid reads.
  const capacity = body.capacity === undefined ? 60 : Number(body.capacity);
  if (!Number.isInteger(capacity) || capacity < CAPACITY_MIN || capacity > CAPACITY_MAX) {
    throw new HttpError(400,
      `ধারণক্ষমতা ${CAPACITY_MIN} থেকে ${CAPACITY_MAX}-এর মধ্যে দিন।`, 'bad_capacity', { field: 'capacity' });
  }

  let capabilities: string[] = [];
  if (body.capabilities !== undefined) {
    if (!Array.isArray(body.capabilities)) {
      throw new HttpError(400, 'সুবিধার তালিকা সঠিক নয়।', 'bad_capabilities', { field: 'capabilities' });
    }
    // Trimmed, de-duplicated and sorted so the audit before/after diff means
    // something rather than recording a reordering as a change.
    capabilities = [...new Set(body.capabilities.map((x) => String(x).trim()).filter(Boolean))].sort();
    if (capabilities.length > CAPS_MAX) {
      throw new HttpError(400, `সুবিধা ${CAPS_MAX_BN}টির বেশি দেওয়া যাবে না।`, 'bad_capabilities', { field: 'capabilities' });
    }
    for (const cap of capabilities) {
      if (!allowed.includes(cap)) {
        throw new HttpError(400,
          `"${cap}" — এই সুবিধাটি কোনো বিষয়ের জন্য দরকার হয় না।`, 'bad_capability', { field: 'capabilities' });
      }
    }
  }

  return { code, nameBn, building, floorNo, capacity, capabilities };
}

async function create(db: Db, ctx: Ctx, req: IncomingMessage): Promise<unknown> {
  const body = await readJson<Body>(req);

  return db.withTenant(ctx, async (c) => {
    const v = await clean(body, await capabilityOptions(c), { requireCode: true });

    const { rows } = await c.query<Row>(
      `INSERT INTO rooms (tenant_id, code, name_bn, building, floor_no, capacity, capabilities, is_bookable)
       VALUES (app.current_tenant(), $1, NULLIF($2,''), NULLIF($3,''), $4, $5, $6::text[], true)
       RETURNING id, code, name_bn, building, floor_no, capacity, capabilities, is_bookable,
                 0 AS home_sections, 0 AS slot_count, 0 AS hall_count`,
      [v.code, v.nameBn, v.building, v.floorNo, v.capacity, v.capabilities]);

    const row = rows[0];
    await writeAudit(c, ctx, {
      action: 'academic.room.create',
      entityType: 'room',
      entityId: row.id,
      after: {
        code: row.code, nameBn: row.name_bn, building: row.building,
        floorNo: row.floor_no, capacity: row.capacity, capabilities: v.capabilities,
      },
    });

    return shape(row);
  }, { write: true });
}

async function update(db: Db, ctx: Ctx, req: IncomingMessage): Promise<unknown> {
  const body = await readJson<Body>(req);
  const id = (body.id ?? '').trim();
  if (!UUID_RE.test(id)) {
    throw new HttpError(400, 'কোন কক্ষ তা জানানো হয়নি।', 'room_required', { field: 'id' });
  }

  return db.withTenant(ctx, async (c) => {
    const before = await c.query<Row>(
      `SELECT id, code, name_bn, building, floor_no, capacity, capabilities, is_bookable,
              0 AS home_sections, 0 AS slot_count, 0 AS hall_count
         FROM rooms WHERE id = $1`, [id]);
    if (before.rowCount === 0) {
      // RLS already scopes this to the caller's school, so "not found" here
      // covers another school's room too — and says the same thing either way.
      throw new HttpError(404, 'এই কক্ষটি পাওয়া যায়নি।', 'room_not_found');
    }
    const was = before.rows[0];

    // PATCH means "change what I named". Every field the caller omitted has
    // to be carried over from the existing row BEFORE validation, because
    // `clean` fills gaps with create-time defaults — so an un-merged
    // `{ id, isBookable: false }` silently reset capacity to 60 and emptied
    // capabilities. Taking a room out of service would have quietly wiped the
    // lab flag that decides which practicals can be placed in it.
    const v = await clean({
      code: body.code ?? was.code,
      nameBn: body.nameBn ?? was.name_bn ?? '',
      building: body.building ?? was.building ?? '',
      floorNo: body.floorNo !== undefined ? body.floorNo : was.floor_no,
      capacity: body.capacity ?? was.capacity ?? 60,
      capabilities: body.capabilities ?? was.capabilities ?? [],
    }, await capabilityOptions(c), { requireCode: true });
    const bookable = body.isBookable === undefined ? was.is_bookable : Boolean(body.isBookable);

    const { rows } = await c.query<Row>(
      `UPDATE rooms
          SET code = $2, name_bn = NULLIF($3,''), building = NULLIF($4,''),
              floor_no = $5, capacity = $6, capabilities = $7::text[], is_bookable = $8
        WHERE id = $1
       RETURNING id, code, name_bn, building, floor_no, capacity, capabilities, is_bookable,
                 (SELECT count(*) FROM sections s WHERE s.home_room_id = rooms.id) AS home_sections,
                 (SELECT count(*) FROM routine_slots rs
                    JOIN routines rt ON rt.id = rs.routine_id
                   WHERE rs.room_id = rooms.id AND rs.status = 'active'
                     AND rt.status IN ('draft','review','active'))            AS slot_count,
                 (SELECT count(*) FROM exam_halls h WHERE h.room_id = rooms.id) AS hall_count`,
      [id, v.code, v.nameBn, v.building, v.floorNo, v.capacity, v.capabilities, bookable]);

    const row = rows[0];
    // Taking a room out of service is a different event from correcting its
    // name, and the register is read to answer the first question.
    const action = was.is_bookable === row.is_bookable
      ? 'academic.room.update'
      : (row.is_bookable ? 'academic.room.reactivate' : 'academic.room.deactivate');

    await writeAudit(c, ctx, {
      action,
      entityType: 'room',
      entityId: id,
      before: {
        code: was.code, nameBn: was.name_bn, building: was.building,
        floorNo: was.floor_no, capacity: was.capacity,
        capabilities: was.capabilities ?? [], isBookable: was.is_bookable,
      },
      after: {
        code: row.code, nameBn: row.name_bn, building: row.building,
        floorNo: row.floor_no, capacity: row.capacity,
        capabilities: v.capabilities, isBookable: row.is_bookable,
      },
    });

    return shape(row);
  }, { write: true });
}
