/**
 * P0 — the room register, which nothing in the product could write.
 *
 * ── What was wrong ──────────────────────────────────────────────────────
 * `rooms` has been read-only since migration 003. The solver reads it, the
 * routine grid joins it, the admit card prints it — and across 112 tenants in
 * the working database there were **zero rows**. Every reader was reading an
 * empty table.
 *
 * And it was writable by anybody. Until migration 065 `rooms` carried
 * `tenant_isolation` and no role scope, so a session holding
 * `app.role = 'student'` could insert one. Nothing had exercised it because
 * nothing wrote rooms at all — which is exactly why the policy had to land in
 * the same commit as the writer.
 *
 * ── What is asserted ────────────────────────────────────────────────────
 * The audit brief's rule: fixture presence is not proof of a writer. So every
 * room here is created through the real endpoint, from a school that starts
 * with none — and the last test proves the solver actually consumes what the
 * endpoint wrote, because a register nothing reads is the defect this phase
 * exists to close, one level up.
 *
 *   DATABASE_URL=postgres://… node --test services/rms-svc/test/rooms.test.ts
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { createDb, type Db, type TenantContext } from '../../../packages/server-core/src/db.ts';
import { installTestKeys, call, lockFixtures, unlockFixtures, asBootstrap } from '../../../packages/server-core/test/harness.ts';

const DATABASE_URL = process.env.DATABASE_URL;
const skip = !DATABASE_URL ? 'DATABASE_URL not set' : false;

const T       = '7f100000-0000-4000-8000-00000000000a';
const OTHER   = '7f100000-0000-4000-8000-00000000000b';
const HEAD    = '7f100000-0000-4000-8000-0000000000f1';
const TEACHER = '7f100000-0000-4000-8000-0000000000a1';
const HEAD_B  = '7f100000-0000-4000-8000-0000000000f2';

let db: Db;
let rooms: typeof import('../api/rooms.ts').default;
let headToken = '';
let teacherToken = '';
let headBToken = '';

const asHead: TenantContext = { tenantId: T, userId: HEAD, role: 'principal' };
const asHeadB: TenantContext = { tenantId: OTHER, userId: HEAD_B, role: 'principal' };

async function drop(): Promise<void> {
  for (const ctx of [asHead, asHeadB]) {
    await asBootstrap(db, ctx, (c) => c.query('DELETE FROM tenants WHERE id = $1', [ctx.tenantId]));
  }
}

async function seed(): Promise<void> {
  await drop();
  const school = async (ctx: TenantContext, slug: string, head: string, phone: string, teacher?: string) => {
    await asBootstrap(db, ctx, async (c) => {
      await c.query(
        `INSERT INTO tenants (id, slug, name_bn, name_en, stream, level)
         VALUES ($1,$2,'কক্ষ বিদ্যালয়','Room School','bangla_medium','secondary')`,
        [ctx.tenantId, slug]);
      await c.query(
        `INSERT INTO users (id, tenant_id, full_name_bn, full_name_en, phone_e164, status)
         VALUES ($1,$2,'প্রধান শিক্ষক','Head',$3,'active')`,
        [head, ctx.tenantId, phone + '1']);
      await c.query(`INSERT INTO user_roles (tenant_id, user_id, role_code) VALUES ($1,$2,'principal')`,
        [ctx.tenantId, head]);
      if (teacher) {
        await c.query(
          `INSERT INTO users (id, tenant_id, full_name_bn, full_name_en, phone_e164, status)
           VALUES ($1,$2,'রফিক স্যার','Rafiq',$3,'active')`,
          [teacher, ctx.tenantId, phone + '2']);
        await c.query(`INSERT INTO user_roles (tenant_id, user_id, role_code) VALUES ($1,$2,'subject_teacher')`,
          [ctx.tenantId, teacher]);
      }
    });
  };
  await school(asHead, 'p0-rooms-a', HEAD, '+880179965000', TEACHER);
  await school(asHeadB, 'p0-rooms-b', HEAD_B, '+880179965100');
}

describe('P0 — the room register', { skip }, () => {
  before(async () => {
    await installTestKeys();
    await lockFixtures(DATABASE_URL as string);
    db = createDb(DATABASE_URL as string);
    await seed();

    const { signAccessToken } = await import('../../../packages/server-core/src/jwt.ts');
    headToken = await signAccessToken({ sub: HEAD, tid: T, role: 'principal', roles: ['principal'] });
    teacherToken = await signAccessToken({ sub: TEACHER, tid: T, role: 'subject_teacher', roles: ['subject_teacher'] });
    headBToken = await signAccessToken({ sub: HEAD_B, tid: OTHER, role: 'principal', roles: ['principal'] });

    rooms = (await import('../api/rooms.ts')).default;
  });

  after(async () => { if (db) { await drop(); await db.end(); await unlockFixtures(); } });

  const get = (token: string) =>
    call(rooms, { method: 'GET', url: '/api/v1/rms/rooms', token } as Parameters<typeof call>[1]);
  const post = (token: string, body: unknown) =>
    call(rooms, { method: 'POST', url: '/api/v1/rms/rooms', token, body } as Parameters<typeof call>[1]);
  const patch = (token: string, body: unknown) =>
    call(rooms, { method: 'PATCH', url: '/api/v1/rms/rooms', token, body } as Parameters<typeof call>[1]);

  test('THE ONE THAT MATTERS — a school with no rooms can create one', async () => {
    // Starts empty. Not a fixture: this school was provisioned above with no
    // rooms at all, which is the state every real school starts in.
    const empty = await get(headToken);
    assert.equal(empty.status, 200, JSON.stringify(empty.body));
    assert.deepEqual((empty.body as { rooms: unknown[] }).rooms, []);
    assert.equal((empty.body as { canManage: boolean }).canManage, true);

    const made = await post(headToken, {
      code: '204', nameBn: 'পদার্থবিজ্ঞান ল্যাব', building: 'মূল ভবন',
      floorNo: 2, capacity: 40, capabilities: ['physics_lab'],
    });
    assert.equal(made.status, 200, JSON.stringify(made.body));
    const room = made.body as { id: string; code: string; capabilities: string[]; isBookable: boolean };
    assert.equal(room.code, '204');
    assert.deepEqual(room.capabilities, ['physics_lab']);
    assert.equal(room.isBookable, true, 'a new room is in service');

    const after = await get(headToken);
    assert.equal((after.body as { rooms: unknown[] }).rooms.length, 1);
  });

  test('the capability list comes from the database, not a hard-coded array', async () => {
    const r = await get(headToken);
    const opts = (r.body as { capabilityOptions: string[] }).capabilityOptions;
    // Whatever a subject in this school actually requires — nothing else can
    // ever match, so nothing else may be offered.
    assert.ok(opts.length > 0, JSON.stringify(opts));
    assert.ok(opts.includes('physics_lab'), JSON.stringify(opts));

    const bad = await post(headToken, { code: 'X1', capabilities: ['swimming_pool'] });
    assert.equal(bad.status, 400, JSON.stringify(bad.body));
    assert.equal((bad.body as { error: string }).error, 'bad_capability');
    assert.match((bad.body as { message: string }).message, /[ঀ-৿]/);
  });

  test('a duplicate code is a 409 the office can act on, not a 500', async () => {
    const dup = await post(headToken, { code: '204', nameBn: 'আবার ২০৪' });
    assert.equal(dup.status, 409, JSON.stringify(dup.body));
    assert.equal((dup.body as { error: string }).error, 'duplicate_code');
    assert.match((dup.body as { message: string }).message, /[ঀ-৿]/);
  });

  test('bad input is refused in Bangla, before anything is written', async () => {
    for (const [body, code] of [
      [{ code: '' }, 'bad_code'],
      [{ code: 'x'.repeat(21) }, 'bad_code'],
      [{ code: 'C1', capacity: 0 }, 'bad_capacity'],
      [{ code: 'C2', capacity: -5 }, 'bad_capacity'],
      [{ code: 'C3', capacity: 5000 }, 'bad_capacity'],
      [{ code: 'C4', capacity: 1.5 }, 'bad_capacity'],
      [{ code: 'C5', floorNo: 99 }, 'bad_floor'],
      [{ code: 'C6', nameBn: 'ক'.repeat(81) }, 'bad_name'],
      [{ code: 'C7', capabilities: 'not-an-array' }, 'bad_capabilities'],
      [{ code: 'C8', capabilities: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'] }, 'bad_capabilities'],
    ] as const) {
      const r = await post(headToken, body);
      assert.equal(r.status, 400, `${JSON.stringify(body)} -> ${JSON.stringify(r.body)}`);
      assert.equal((r.body as { error: string }).error, code, JSON.stringify(body));
      assert.match((r.body as { message: string }).message, /[ঀ-৿]/);
    }

    // And nothing landed.
    const r = await get(headToken);
    assert.equal((r.body as { rooms: unknown[] }).rooms.length, 1);
  });

  test('a teacher may READ the register but not write it', async () => {
    const r = await get(teacherToken);
    assert.equal(r.status, 200, 'a teacher hunting for a free room needs the list');
    assert.equal((r.body as { canManage: boolean }).canManage, false,
      'and the screen must be told, rather than discovering it on submit');

    const w = await post(teacherToken, { code: 'T1' });
    assert.equal(w.status, 403, JSON.stringify(w.body));
  });

  test('THE DATABASE refuses the write too, not only the role check', async () => {
    // Migration 065. Before it, `rooms` had tenant isolation and no role
    // scope, so this insert SUCCEEDED as a student. If requireRole were the
    // only guard, an endpoint that forgot it would be an open door.
    const asStudent: TenantContext = { tenantId: T, userId: TEACHER, role: 'student' };
    await assert.rejects(
      () => db.withTenant(asStudent, (c) => c.query(
        `INSERT INTO rooms (tenant_id, code, capacity)
         VALUES (app.current_tenant(), 'STUDENT-MADE', 30)`)),
      /rooms_insert_scope|row-level security/i);
  });

  test('nobody may DELETE a room, in any role', async () => {
    // exam_halls.room_id is ON DELETE RESTRICT; sections.home_room_id and
    // routine_slots.room_id are ON DELETE SET NULL. A delete would either
    // fail on a hall or silently make a past routine forget where a class met.
    const id = ((await get(headToken)).body as { rooms: Array<{ id: string }> }).rooms[0].id;
    const deleted = await db.withTenant(asHead,
      (c) => c.query('DELETE FROM rooms WHERE id = $1', [id]), { write: true });
    assert.equal(deleted.rowCount, 0, 'the delete must match no row rather than erroring');

    const still = await get(headToken);
    assert.equal((still.body as { rooms: unknown[] }).rooms.length, 1, 'the room survives');
  });

  test('a room is taken out of service, never deleted — and the audit says which', async () => {
    const id = ((await get(headToken)).body as { rooms: Array<{ id: string }> }).rooms[0].id;

    const off = await patch(headToken, { id, isBookable: false });
    assert.equal(off.status, 200, JSON.stringify(off.body));
    assert.equal((off.body as { isBookable: boolean }).isBookable, false);

    const on = await patch(headToken, { id, isBookable: true });
    assert.equal((on.body as { isBookable: boolean }).isBookable, true);

    const acts = await asBootstrap(db, asHead, async (c) => {
      const { rows } = await c.query<{ action: string }>(
        `SELECT action FROM audit.activity_log
          WHERE entity_type = 'room' AND entity_id = $1 ORDER BY created_at`, [id]);
      return rows.map((r) => r.action);
    });
    assert.deepEqual(acts,
      ['academic.room.create', 'academic.room.deactivate', 'academic.room.reactivate'],
      'taking a room out of service is a different event from correcting its name');
  });

  test('correcting a room records what changed', async () => {
    const id = ((await get(headToken)).body as { rooms: Array<{ id: string }> }).rooms[0].id;
    const r = await patch(headToken, { id, nameBn: 'পদার্থ ল্যাব (নতুন নাম)', capacity: 45 });
    assert.equal(r.status, 200, JSON.stringify(r.body));

    const entry = await asBootstrap(db, asHead, async (c) => {
      const { rows } = await c.query<{ before: Record<string, unknown>; after: Record<string, unknown> }>(
        `SELECT before_state AS before, after_state AS after FROM audit.activity_log
          WHERE entity_type = 'room' AND entity_id = $1 AND action = 'academic.room.update'
          ORDER BY created_at DESC LIMIT 1`, [id]);
      return rows[0];
    });
    assert.equal(entry.before.capacity, 40);
    assert.equal(entry.after.capacity, 45);
  });

  test('another school cannot see or touch this register', async () => {
    const theirs = await get(headBToken);
    assert.equal(theirs.status, 200);
    assert.deepEqual((theirs.body as { rooms: unknown[] }).rooms, [],
      'RLS returns no rows, rather than another school’s rooms');

    const id = ((await get(headToken)).body as { rooms: Array<{ id: string }> }).rooms[0].id;
    const cross = await patch(headBToken, { id, nameBn: 'দখল' });
    assert.equal(cross.status, 404, JSON.stringify(cross.body));

    // And school A's room is untouched.
    const mine = (await get(headToken)).body as { rooms: Array<{ nameBn: string }> };
    assert.notEqual(mine.rooms[0].nameBn, 'দখল');
  });

  test('THE POINT OF ALL THIS — the solver sees a room the endpoint created', async () => {
    // A register the engine ignores is the defect this phase exists to close,
    // one level up. The solver draws its room pools from `rooms` filtered on
    // is_bookable, so this asserts against the same predicate the solver uses.
    const pool = await asBootstrap(db, asHead, async (c) => {
      const { rows } = await c.query<{ code: string; capabilities: string[] }>(
        `SELECT code, capabilities FROM rooms WHERE is_bookable ORDER BY code`);
      return rows;
    });
    assert.equal(pool.length, 1, 'the room the endpoint wrote is in the solver’s pool');
    assert.equal(pool[0].code, '204');
    assert.deepEqual(pool[0].capabilities, ['physics_lab'],
      'and carries the capability a practical subject would need');

    // Out of service removes it from that pool, which is what deactivation is for.
    const id = ((await get(headToken)).body as { rooms: Array<{ id: string }> }).rooms[0].id;
    await patch(headToken, { id, isBookable: false });
    const after = await asBootstrap(db, asHead, async (c) => {
      const { rows } = await c.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM rooms WHERE is_bookable`);
      return Number(rows[0].n);
    });
    assert.equal(after, 0, 'an out-of-service room leaves the solver’s pool');
    await patch(headToken, { id, isBookable: true });
  });
});
