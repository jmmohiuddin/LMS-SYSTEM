/**
 * Room matching and the infeasibility diagnosis — F-504, F-503, §8.2
 *
 * Before this, the solver put every class in the section's home room and
 * never read subjects.requires_capability — so a chemistry practical was
 * scheduled into an ordinary classroom, which is not a lesson that
 * happened. Both columns existed; nothing joined them.
 *
 * The fixture is a school with one lab and more practical demand than the
 * lab can hold, because §8.2's rule is about what happens when it does not
 * fit: "Infeasibility reports the binding shortage in resource terms the
 * coordinator can act on — not 'no solution found'."
 *
 *   DATABASE_URL=postgresql://shikhon_runtime:… node --test services/rms-svc/test/solve-rooms.test.ts
 */
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { createDb, type Db, type TenantContext } from '../../../packages/server-core/src/db.ts';
import { RmsSolver } from '../src/solve.ts';

const DATABASE_URL = process.env.DATABASE_URL;
const skip = !DATABASE_URL ? 'DATABASE_URL not set' : false;

const T      = '7a600000-0000-4000-8000-00000000000a';
const COORD  = '7a600000-0000-4000-8000-0000000000ff';
const T1     = '7a600000-0000-4000-8000-0000000000a1';
const T2     = '7a600000-0000-4000-8000-0000000000a2';
const YEAR   = '7a600000-0000-4000-8000-000000000091';
const CLASS9 = '7a600000-0000-4000-8000-0000000000c9';
const SEC_A  = '7a600000-0000-4000-8000-0000000000b1';
const SEC_B  = '7a600000-0000-4000-8000-0000000000b2';
const CHEM   = '7a600000-0000-4000-8000-000000000137';
const BANGLA = '7a600000-0000-4000-8000-000000000101';
const ROOM_A = '7a600000-0000-4000-8000-0000000000d1';
const ROOM_B = '7a600000-0000-4000-8000-0000000000d2';
const LAB    = '7a600000-0000-4000-8000-0000000000d3';
const TPL    = '7a600000-0000-4000-8000-0000000000e1';
const RT     = '7a600000-0000-4000-8000-00000000a001';

let db: Db;
const asCoord: TenantContext = { tenantId: T, userId: COORD, role: 'academic_coordinator' };

async function dropFixtures(): Promise<void> {
  await db.withTenant({ ...asCoord, role: 'principal' }, async (c) => {
    await c.query('DELETE FROM tenants WHERE id = $1', [T]);
  });
}

async function seed(): Promise<void> {
  await dropFixtures();
  await db.withTenant({ ...asCoord, role: 'principal' }, async (c) => {
    await c.query(
      `INSERT INTO tenants (id, slug, name_bn, name_en, stream, level)
       VALUES ($1,'f504','কক্ষ','Rooms','bangla_medium','secondary')`, [T]);
    await c.query(
      `INSERT INTO users (id, tenant_id, full_name_bn, full_name_en, phone_e164) VALUES
         ($1,$4,'সমন্বয়ক','Coordinator','+8801796000001'),
         ($2,$4,'নাসরিন','Nasrin','+8801796000002'),
         ($3,$4,'রফিক','Rafiq','+8801796000003')`,
      [COORD, T1, T2, T]);
    await c.query(
      `INSERT INTO academic_years (id, tenant_id, label, starts_on, ends_on, is_current)
       VALUES ($1,$2,'2026','2026-01-01','2026-12-31',true)`, [YEAR, T]);
    await c.query(
      `INSERT INTO classes (id, tenant_id, level_no, name_bn, name_en, stream)
       VALUES ($1,$2,9,'নবম','Nine','bangla_medium')`, [CLASS9, T]);

    // Two ordinary classrooms and exactly one chemistry lab.
    await c.query(
      `INSERT INTO rooms (id, tenant_id, code, name_bn, capacity, capabilities) VALUES
         ($1,$4,'204','কক্ষ ২০৪',60,'{}'),
         ($2,$4,'205','কক্ষ ২০৫',60,'{}'),
         ($3,$4,'LAB-1','ল্যাব ১',40,'{chemistry_lab}')`,
      [ROOM_A, ROOM_B, LAB, T]);
    await c.query(
      `INSERT INTO sections (id, tenant_id, class_id, academic_year_id, name, home_room_id) VALUES
         ($1,$3,$4,$5,'ক',$6), ($2,$3,$4,$5,'খ',$7)`,
      [SEC_A, SEC_B, T, CLASS9, YEAR, ROOM_A, ROOM_B]);
    await c.query(
      `INSERT INTO subjects (id, tenant_id, nctb_code, name_bn, name_en, requires_capability,
                             is_practical) VALUES
         ($1,$3,'137','রসায়ন ব্যবহারিক','Chemistry Practical','chemistry_lab',true),
         ($2,$3,'101','বাংলা','Bangla',NULL,false)`,
      [CHEM, BANGLA, T]);

    await c.query(
      `INSERT INTO period_templates (id, tenant_id, name_bn, shift, effective_from)
       VALUES ($1,$2,'নিয়মিত','single','2026-01-01')`, [TPL, T]);
    // Two teaching periods a day.
    await c.query(
      `INSERT INTO period_definitions
         (id, tenant_id, template_id, period_no, label_bn, starts_at, ends_at, kind) VALUES
         (gen_random_uuid(),$1,$2,1,'১ম','09:00','09:45','teaching'),
         (gen_random_uuid(),$1,$2,2,'২য়','09:45','10:30','teaching')`,
      [T, TPL]);
    await c.query(
      `INSERT INTO routines (id, tenant_id, academic_year_id, period_template_id,
                             name_bn, status, effective_from)
       VALUES ($1,$2,$3,$4,'নিয়মিত রুটিন','draft','2026-01-01')`, [RT, T, YEAR, TPL]);
  });
}

/** Reset demand between tests without rebuilding the school. */
async function setDemand(rows: Array<[string, string, string, number]>): Promise<void> {
  await db.withTenant(asCoord, async (c) => {
    await c.query('DELETE FROM routine_slots');
    await c.query('DELETE FROM section_subject_teachers');
    await c.query('DELETE FROM class_subjects');
    for (const [sectionId, subjectId, teacherId, perWeek] of rows) {
      await c.query(
        `INSERT INTO class_subjects (tenant_id, class_id, subject_id, academic_year_id, periods_per_week)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (tenant_id, class_id, subject_id, academic_year_id)
         DO UPDATE SET periods_per_week = EXCLUDED.periods_per_week`,
        [T, CLASS9, subjectId, YEAR, perWeek]);
      await c.query(
        `INSERT INTO section_subject_teachers
           (tenant_id, section_id, subject_id, teacher_id, academic_year_id)
         VALUES ($1,$2,$3,$4,$5)`,
        [T, sectionId, subjectId, teacherId, YEAR]);
    }
  });
}

async function roomsUsed(): Promise<Array<{ subject: string; room: string | null }>> {
  return db.withTenant(asCoord, async (c) => {
    const { rows } = await c.query<{ subject: string; room: string | null }>(
      `SELECT sub.name_bn AS subject, rm.code AS room
         FROM routine_slots rs
         JOIN subjects sub ON sub.id = rs.subject_id
         LEFT JOIN rooms rm ON rm.id = rs.room_id
        WHERE rs.routine_id = $1 ORDER BY rs.day_of_week, rs.period_no`, [RT]);
    return rows;
  });
}

describe('room matching (F-504)', { skip }, () => {
  before(async () => { db = createDb(DATABASE_URL as string); await seed(); });
  after(async () => { if (db) { await dropFixtures(); await db.end(); } });
  beforeEach(async () => {
    await db.withTenant(asCoord, async (c) => { await c.query('DELETE FROM routine_slots'); });
  });

  test('THE ONE THAT MATTERS — a practical goes in the lab, not the classroom', async () => {
    await setDemand([[SEC_A, CHEM, T1, 1]]);
    const result = await new RmsSolver(db).solve(RT, asCoord);
    assert.equal(result.placed, 1);

    const used = await roomsUsed();
    assert.equal(used.length, 1);
    // Section ক's home room is 204. Before F-504 that is where this landed.
    assert.equal(used[0].room, 'LAB-1');
  });

  test('an ordinary subject still uses the section\'s home room', async () => {
    await setDemand([[SEC_A, BANGLA, T1, 1]]);
    await new RmsSolver(db).solve(RT, asCoord);
    assert.equal((await roomsUsed())[0].room, '204');
  });

  test('two sections needing the lab at once are given different hours', async () => {
    // One lab, two sections, two periods a day — both fit, in sequence.
    await setDemand([[SEC_A, CHEM, T1, 1], [SEC_B, CHEM, T2, 1]]);
    const result = await new RmsSolver(db).solve(RT, asCoord);
    assert.equal(result.placed, 2);
    assert.equal(result.unplaced.length, 0);

    const used = await roomsUsed();
    assert.deepEqual(used.map((u) => u.room), ['LAB-1', 'LAB-1']);
    // And never at the same time, which the exclusion constraint would
    // have refused anyway — this asserts the solver knew, rather than
    // finding out from a rejected INSERT.
    await db.withTenant(asCoord, async (c) => {
      const { rows } = await c.query<{ n: string }>(
        `SELECT count(*) AS n FROM routine_slots a JOIN routine_slots b
            ON a.id <> b.id AND a.room_id = b.room_id
           AND a.day_of_week = b.day_of_week AND a.starts_at = b.starts_at`);
      assert.equal(rows[0].n, '0');
    });
  });

  test('a practical is never dropped into an ordinary room as a fallback', async () => {
    // Five periods of practical against a lab with room for four this
    // week (2 periods x 5 days = 10, but one teacher can only be in one
    // place, so demand beyond the teacher's free hours goes unplaced).
    // Whatever IS placed must be in the lab.
    await setDemand([[SEC_A, CHEM, T1, 8]]);
    await new RmsSolver(db).solve(RT, asCoord);
    const used = await roomsUsed();
    assert.ok(used.length > 0);
    assert.ok(used.every((u) => u.room === 'LAB-1'),
              'a chemistry practical in a room with no gas or water is not a lesson');
  });
});

describe('the infeasibility diagnosis (F-503, §8.2)', { skip }, () => {
  before(async () => { db = createDb(DATABASE_URL as string); await seed(); });
  after(async () => { if (db) { await dropFixtures(); await db.end(); } });
  beforeEach(async () => {
    await db.withTenant(asCoord, async (c) => { await c.query('DELETE FROM routine_slots'); });
  });

  test('a lab that cannot hold the demand reports the shortage in resource terms', async () => {
    // Two sections, five practical periods each: ten periods against a
    // single lab with ten slots — and two different teachers, so the
    // binding constraint really is the room.
    await setDemand([[SEC_A, CHEM, T1, 6], [SEC_B, CHEM, T2, 6]]);
    const result = await new RmsSolver(db).solve(RT, asCoord);

    assert.ok(result.unplaced.length > 0, 'some demand could not be placed');
    assert.equal(result.shortages.length, 1);
    const s = result.shortages[0];
    assert.equal(s.capability, 'chemistry_lab');
    assert.equal(s.capableRooms, 1);
    assert.equal(s.demandedPeriods, 12);
    // §8.2: "রসায়নের ১২টি ল্যাব পিরিয়ড দরকার; ল্যাব ১-এ ৮টি খালি" — the
    // numbers a coordinator argues for a second lab with.
    assert.match(s.detailBn, /১২টি পিরিয়ড দরকার/);
    assert.match(s.detailBn, /কক্ষে .*খালি/);
  });

  test('the reason distinguishes a full lab from no lab at all', async () => {
    await setDemand([[SEC_A, CHEM, T1, 6], [SEC_B, CHEM, T2, 6]]);
    const full = await new RmsSolver(db).solve(RT, asCoord);
    assert.ok(full.unplaced.some((u) => u.reason === 'no_free_capable_room'));

    // Now take the capability away entirely — the school has no lab.
    await db.withTenant(asCoord, async (c) => {
      await c.query('DELETE FROM routine_slots');
      await c.query(`UPDATE rooms SET capabilities = '{}' WHERE id = $1`, [LAB]);
    });
    const none = await new RmsSolver(db).solve(RT, asCoord);
    assert.ok(none.unplaced.every((u) => u.reason === 'no_capable_room'));
    assert.equal(none.placed, 0);

    const s = none.shortages[0];
    assert.equal(s.capableRooms, 0);
    // A building problem, not a timetable problem, and it says so.
    assert.match(s.detailBn, /কোনো কক্ষ নেই/);

    await db.withTenant(asCoord, async (c) => {
      await c.query(`UPDATE rooms SET capabilities = '{chemistry_lab}' WHERE id = $1`, [LAB]);
    });
  });

  test('a routine that fits reports no shortage at all', async () => {
    await setDemand([[SEC_A, CHEM, T1, 1], [SEC_A, BANGLA, T1, 1]]);
    const result = await new RmsSolver(db).solve(RT, asCoord);
    assert.equal(result.unplaced.length, 0);
    assert.equal(result.shortages.length, 0,
                 'a school with a spare lab does not need to be told about it');
  });

  test('the shortage is persisted with the routine, not only returned', async () => {
    await setDemand([[SEC_A, CHEM, T1, 6], [SEC_B, CHEM, T2, 6]]);
    await new RmsSolver(db).solve(RT, asCoord);
    await db.withTenant(asCoord, async (c) => {
      const { rows } = await c.query<{ soft_violations: { shortages?: unknown[] } }>(
        'SELECT soft_violations FROM routines WHERE id = $1', [RT]);
      assert.ok(Array.isArray(rows[0].soft_violations.shortages));
      assert.equal(rows[0].soft_violations.shortages!.length, 1);
    });
  });
});
