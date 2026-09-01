/**
 * Contiguous double periods — F-504's last clause, in the solver
 *
 * class_subjects.double_periods_per_week has existed since migration 003
 * and the solver has never read it: every practical was scheduled as
 * isolated singles, and a science experiment cannot set up, run and pack
 * away in 45 minutes.
 *
 * The period template here has tiffin in the middle — p2 ends 10:30, p3
 * begins 11:00 — because the wrong implementation pairs by PERIOD NUMBER
 * and would happily place a "double" across the break. Adjacency is by
 * time.
 *
 * These runs COMMIT for real, so migration 035's deferred trigger audits
 * every double the solver writes — a solver that produced a malformed
 * pair could not finish the test.
 *
 *   DATABASE_URL=postgresql://shikhon_runtime:… node --test services/rms-svc/test/solve-doubles.test.ts
 */
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { createDb, type Db, type TenantContext } from '../../../packages/server-core/src/db.ts';
import { lockFixtures, unlockFixtures } from '../../../packages/server-core/test/harness.ts';
import { RmsSolver } from '../src/solve.ts';

const DATABASE_URL = process.env.DATABASE_URL;
const skip = !DATABASE_URL ? 'DATABASE_URL not set' : false;

const T      = '7aa00000-0000-4000-8000-00000000000a';
const COORD  = '7aa00000-0000-4000-8000-0000000000ff';
const T1     = '7aa00000-0000-4000-8000-0000000000a1';
const YEAR   = '7aa00000-0000-4000-8000-000000000091';
const CLASS9 = '7aa00000-0000-4000-8000-0000000000c9';
const SEC    = '7aa00000-0000-4000-8000-0000000000b1';
const CHEM   = '7aa00000-0000-4000-8000-000000000137';
const ROOM   = '7aa00000-0000-4000-8000-0000000000d1';
const LAB    = '7aa00000-0000-4000-8000-0000000000d2';
const TPL    = '7aa00000-0000-4000-8000-0000000000e1';
const RT     = '7aa00000-0000-4000-8000-00000000a001';

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
       VALUES ($1,'f504d','দ্বৈত','Doubles','bangla_medium','secondary')`, [T]);
    await c.query(
      `INSERT INTO users (id, tenant_id, full_name_bn, full_name_en, phone_e164) VALUES
         ($1,$3,'সমন্বয়ক','Coordinator','+8801799300001'),
         ($2,$3,'নাসরিন','Nasrin','+8801799300002')`, [COORD, T1, T]);
    await c.query(
      `INSERT INTO academic_years (id, tenant_id, label, starts_on, ends_on, is_current)
       VALUES ($1,$2,'2026','2026-01-01','2026-12-31',true)`, [YEAR, T]);
    await c.query(
      `INSERT INTO classes (id, tenant_id, level_no, name_bn, name_en, stream)
       VALUES ($1,$2,9,'নবম','Nine','bangla_medium')`, [CLASS9, T]);
    await c.query(
      `INSERT INTO rooms (id, tenant_id, code, name_bn, capacity, capabilities) VALUES
         ($1,$3,'204','কক্ষ ২০৪',60,'{}'),
         ($2,$3,'LAB-1','ল্যাব ১',40,'{chemistry_lab}')`, [ROOM, LAB, T]);
    await c.query(
      `INSERT INTO sections (id, tenant_id, class_id, academic_year_id, name, home_room_id)
       VALUES ($1,$2,$3,$4,'ক',$5)`, [SEC, T, CLASS9, YEAR, ROOM]);
    await c.query(
      `INSERT INTO subjects (id, tenant_id, nctb_code, name_bn, name_en,
                             requires_capability, is_practical)
       VALUES ($1,$2,'137','রসায়ন ব্যবহারিক','Chem Practical','chemistry_lab',true)`,
      [CHEM, T]);
    await c.query(
      `INSERT INTO period_templates (id, tenant_id, name_bn, shift, effective_from)
       VALUES ($1,$2,'নিয়মিত','single','2026-01-01')`, [TPL, T]);
    // Tiffin between p2 and p3. Pairing by period NUMBER would put a
    // "double" across it; pairing by time cannot.
    await c.query(
      `INSERT INTO period_definitions
         (id, tenant_id, template_id, period_no, label_bn, starts_at, ends_at, kind) VALUES
         (gen_random_uuid(),$1,$2,1,'১ম','09:00','09:45','teaching'),
         (gen_random_uuid(),$1,$2,2,'২য়','09:45','10:30','teaching'),
         (gen_random_uuid(),$1,$2,3,'৩য়','11:00','11:45','teaching')`,
      [T, TPL]);
    await c.query(
      `INSERT INTO routines (id, tenant_id, academic_year_id, period_template_id,
                             name_bn, status, effective_from)
       VALUES ($1,$2,$3,$4,'রুটিন','draft','2026-01-01')`, [RT, T, YEAR, TPL]);
    // Four periods a week, ONE of them a double.
    await c.query(
      `INSERT INTO class_subjects
         (tenant_id, class_id, subject_id, academic_year_id, periods_per_week,
          double_periods_per_week)
       VALUES ($1,$2,$3,$4,4,1)`, [T, CLASS9, CHEM, YEAR]);
    await c.query(
      `INSERT INTO section_subject_teachers
         (tenant_id, section_id, subject_id, teacher_id, academic_year_id)
       VALUES ($1,$2,$3,$4,$5)`, [T, SEC, CHEM, T1, YEAR]);
  });
}

interface Row {
  day: number; period: number; starts: string; ends: string;
  room: string | null; is_double: boolean; group: string | null;
}

async function slots(): Promise<Row[]> {
  return db.withTenant(asCoord, async (c) => {
    const { rows } = await c.query<Row>(
      `SELECT rs.day_of_week AS day, rs.period_no AS period,
              rs.starts_at AS starts, rs.ends_at AS ends,
              rm.code AS room, rs.is_double, rs.double_group_id AS "group"
         FROM routine_slots rs LEFT JOIN rooms rm ON rm.id = rs.room_id
        WHERE rs.routine_id = $1 ORDER BY rs.day_of_week, rs.period_no`, [RT]);
    return rows;
  });
}

describe('double periods in the solver (F-504)', { skip }, () => {
  before(async () => { db = createDb(DATABASE_URL as string); await seed(); });
  after(async () => { if (db) { await dropFixtures(); await db.end(); await unlockFixtures(); } });
  beforeEach(async () => {
    await db.withTenant(asCoord, async (c) => { await c.query('DELETE FROM routine_slots'); });
  });

  test('THE ONE THAT MATTERS — one pair is contiguous, the rest are singles', async () => {
    const result = await new RmsSolver(db).solve(RT, asCoord);
    assert.equal(result.placed, 4);
    assert.equal(result.unplaced.length, 0);

    const rows = await slots();
    const halves = rows.filter((r) => r.is_double);
    const singles = rows.filter((r) => !r.is_double);
    assert.equal(halves.length, 2, 'one double = two halves');
    assert.equal(singles.length, 2);

    // The two halves share a group, a day, a room — and ABUT.
    assert.equal(halves[0].group, halves[1].group);
    assert.ok(halves[0].group !== null);
    assert.equal(halves[0].day, halves[1].day);
    assert.equal(halves[0].room, halves[1].room);
    assert.equal(halves[0].ends, halves[1].starts,
                 'the second half begins exactly when the first ends');
    // And the singles belong to no group at all.
    assert.ok(singles.every((r) => r.group === null));
  });

  test('a double never spans tiffin', async () => {
    // Only p1–p2 abut; p2→p3 has a half-hour gap. Whatever days the pair
    // lands on, it must be the 09:00–10:30 stretch.
    await new RmsSolver(db).solve(RT, asCoord);
    const halves = (await slots()).filter((r) => r.is_double)
      .sort((a, b) => a.starts.localeCompare(b.starts));
    assert.equal(halves[0].starts.slice(0, 5), '09:00');
    assert.equal(halves[1].ends.slice(0, 5), '10:30');
  });

  test('a practical double keeps ONE lab for both halves', async () => {
    // An experiment that changes room at half time abandons its own
    // apparatus. Both halves in LAB-1, not the section's classroom.
    await new RmsSolver(db).solve(RT, asCoord);
    const halves = (await slots()).filter((r) => r.is_double);
    assert.deepEqual(halves.map((h) => h.room), ['LAB-1', 'LAB-1']);
  });

  test('re-running tops up instead of stacking a second double', async () => {
    await new RmsSolver(db).solve(RT, asCoord);
    const result = await new RmsSolver(db).solve(RT, asCoord);
    assert.equal(result.placed, 4, 'nothing new to place');
    const halves = (await slots()).filter((r) => r.is_double);
    assert.equal(halves.length, 2, 'still exactly one double');
  });

  test('when no contiguous pair is free, the double is reported, not faked', async () => {
    // The teacher declares 09:00–09:45 unavailable every day. p1–p2 is the
    // only abutting pair, so no double can run — but p2 and p3 alone still
    // absorb singles. The wrong implementation places two separated halves
    // wearing the label; migration 035 would refuse them at COMMIT, and
    // this asserts the solver never tries.
    await db.withTenant(asCoord, async (c) => {
      for (const day of [0, 1, 2, 3, 4, 5, 6]) {
        await c.query(
          `INSERT INTO teacher_availability
             (tenant_id, teacher_id, day_of_week, starts_at, ends_at, kind)
           VALUES ($1,$2,$3,'09:00','09:45','unavailable')`, [T, T1, day]);
      }
    });

    const result = await new RmsSolver(db).solve(RT, asCoord);
    const halves = (await slots()).filter((r) => r.is_double);
    assert.equal(halves.length, 0, 'no double was faked from separated periods');
    // The four periods still run — as singles — because four scattered
    // periods beat two missing ones. But the degradation is REPORTED: a
    // practical in 45-minute fragments is a different lesson than the one
    // the curriculum asked for.
    assert.equal(result.placed, 4);
    assert.equal(result.unplaced.length, 1);
    assert.equal(result.unplaced[0].reason, 'no_contiguous_pair');

    await db.withTenant(asCoord, async (c) => {
      await c.query('DELETE FROM teacher_availability WHERE teacher_id = $1', [T1]);
    });
  });
});
