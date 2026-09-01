/**
 * Parallel blocks — F-504, the last hard constraint
 *
 * "religion and optional-subject splits scheduled as coherent parallel
 * blocks."
 *
 * A Class 9 section splits four ways for religion. All four groups must be
 * taught in the SAME period: schedule them separately and the section
 * spends four hours with three quarters of the room sitting idle, which is
 * not a timetable any school would accept.
 *
 * Before this the solver treated each (section, subject) demand
 * independently, and sectionBusy actively PREVENTED the right answer — the
 * second religion paper could not go where the first one was.
 *
 * The fixture is a real Bangladeshi shape: one section, four religion
 * variants sharing a selection pool, four teachers, and only two ordinary
 * rooms besides the section's own — so the block has exactly enough space
 * and the test can tell "found four rooms" from "got lucky".
 *
 *   DATABASE_URL=postgresql://shikhon_runtime:… node --test services/rms-svc/test/solve-parallel.test.ts
 */
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { createDb, type Db, type TenantContext } from '../../../packages/server-core/src/db.ts';
import { lockFixtures, unlockFixtures } from '../../../packages/server-core/test/harness.ts';
import { RmsSolver } from '../src/solve.ts';

const DATABASE_URL = process.env.DATABASE_URL;
const skip = !DATABASE_URL ? 'DATABASE_URL not set' : false;

const T      = '7a700000-0000-4000-8000-00000000000a';
const COORD  = '7a700000-0000-4000-8000-0000000000ff';
const TEACH  = ['a1', 'a2', 'a3', 'a4'].map((x) => `7a700000-0000-4000-8000-0000000000${x}`);
const YEAR   = '7a700000-0000-4000-8000-000000000091';
const CLASS9 = '7a700000-0000-4000-8000-0000000000c9';
const SEC    = '7a700000-0000-4000-8000-0000000000b1';
const SCHEME = '7a700000-0000-4000-8000-0000000000e0';
const TMPL   = '7a700000-0000-4000-8000-0000000000e9';
const REL    = ['f1', 'f2', 'f3', 'f4'].map((x) => `7a700000-0000-4000-8000-0000000000${x}`);
const BANGLA = '7a700000-0000-4000-8000-000000000101';
const ROOMS  = ['d1', 'd2', 'd3', 'd4'].map((x) => `7a700000-0000-4000-8000-0000000000${x}`);
const TPL    = '7a700000-0000-4000-8000-0000000000e1';
const RT     = '7a700000-0000-4000-8000-00000000a001';

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
       VALUES ($1,'f504p','সমান্তরাল','Parallel','bangla_medium','secondary')`, [T]);
    await c.query(
      `INSERT INTO users (id, tenant_id, full_name_bn, full_name_en, phone_e164)
       VALUES ($1,$2,'সমন্বয়ক','Coordinator','+8801797100000')`, [COORD, T]);
    for (let i = 0; i < 4; i++) {
      await c.query(
        `INSERT INTO users (id, tenant_id, full_name_bn, full_name_en, phone_e164)
         VALUES ($1,$2,$3,$4,$5)`,
        [TEACH[i], T, `শিক্ষক ${i + 1}`, `Teacher ${i + 1}`, `+880179710000${i + 1}`]);
    }
    await c.query(
      `INSERT INTO academic_years (id, tenant_id, label, starts_on, ends_on, is_current)
       VALUES ($1,$2,'2026','2026-01-01','2026-12-31',true)`, [YEAR, T]);
    await c.query(
      `INSERT INTO classes (id, tenant_id, level_no, name_bn, name_en, stream, "group")
       VALUES ($1,$2,9,'নবম','Nine','bangla_medium','science')`, [CLASS9, T]);

    // The section's own room plus three others. Four groups need four.
    for (let i = 0; i < 4; i++) {
      await c.query(
        `INSERT INTO rooms (id, tenant_id, code, name_bn, capacity, capabilities)
         VALUES ($1,$2,$3,$4,60,'{}')`,
        [ROOMS[i], T, `20${i + 1}`, `কক্ষ ২০${i + 1}`]);
    }
    await c.query(
      `INSERT INTO sections (id, tenant_id, class_id, academic_year_id, name, home_room_id)
       VALUES ($1,$2,$3,$4,'ক',$5)`, [SEC, T, CLASS9, YEAR, ROOMS[0]]);

    const names = ['ইসলাম শিক্ষা', 'হিন্দুধর্ম', 'বৌদ্ধধর্ম', 'খ্রিস্টধর্ম'];
    for (let i = 0; i < 4; i++) {
      await c.query(
        `INSERT INTO subjects (id, tenant_id, nctb_code, name_bn, name_en)
         VALUES ($1,$2,$3,$4,$5)`,
        [REL[i], T, `11${i}`, names[i], `Religion ${i + 1}`]);
    }
    await c.query(
      `INSERT INTO subjects (id, tenant_id, nctb_code, name_bn, name_en)
       VALUES ($1,$2,'101','বাংলা','Bangla')`, [BANGLA, T]);

    // The selection pool is what makes these four alternatives — the same
    // mechanism the subject model uses for optional subjects.
    await c.query(
      `INSERT INTO curriculum_schemes
         (id, tenant_id, academic_year_id, stage, assessment_model, grade_rule_set, effective_from)
       VALUES ($1,$2,$3,'secondary','marks_cq_mcq',
               '{"bands":[{"min":0,"grade":"F","point":0}],"fail_grade":"F"}'::jsonb,'2026-01-01')`,
      [SCHEME, T, YEAR]);
    await c.query(
      `INSERT INTO subject_templates (id, tenant_id, curriculum_scheme_id, class_id, group_code)
       VALUES ($1,$2,$3,$4,'science')`, [TMPL, T, SCHEME, CLASS9]);
    for (let i = 0; i < 4; i++) {
      await c.query(
        `INSERT INTO subject_template_items
           (tenant_id, template_id, subject_id, requirement_type, religion_variant, selection_pool)
         VALUES ($1,$2,$3,'religion_variant',$4,'religion')`,
        [T, TMPL, REL[i], ['islam', 'hindu', 'buddhist', 'christian'][i]]);
    }
    await c.query(
      `INSERT INTO subject_template_items (tenant_id, template_id, subject_id, requirement_type)
       VALUES ($1,$2,$3,'compulsory')`, [T, TMPL, BANGLA]);

    await c.query(
      `INSERT INTO period_templates (id, tenant_id, name_bn, shift, effective_from)
       VALUES ($1,$2,'নিয়মিত','single','2026-01-01')`, [TPL, T]);
    await c.query(
      `INSERT INTO period_definitions
         (id, tenant_id, template_id, period_no, label_bn, starts_at, ends_at, kind) VALUES
         (gen_random_uuid(),$1,$2,1,'১ম','09:00','09:45','teaching'),
         (gen_random_uuid(),$1,$2,2,'২য়','09:45','10:30','teaching'),
         (gen_random_uuid(),$1,$2,3,'৩য়','10:30','11:15','teaching')`,
      [T, TPL]);
    await c.query(
      `INSERT INTO routines (id, tenant_id, academic_year_id, period_template_id,
                             name_bn, status, effective_from)
       VALUES ($1,$2,$3,$4,'রুটিন','draft','2026-01-01')`, [RT, T, YEAR, TPL]);

    // One period a week of each religion variant, one teacher each.
    for (let i = 0; i < 4; i++) {
      await c.query(
        `INSERT INTO class_subjects
           (tenant_id, class_id, subject_id, academic_year_id, periods_per_week)
         VALUES ($1,$2,$3,$4,1)`, [T, CLASS9, REL[i], YEAR]);
      await c.query(
        `INSERT INTO section_subject_teachers
           (tenant_id, section_id, subject_id, teacher_id, academic_year_id)
         VALUES ($1,$2,$3,$4,$5)`, [T, SEC, REL[i], TEACH[i], YEAR]);
    }
  });
}

async function placed(): Promise<Array<{
  subject: string; day: number; period: number; room: string | null; teacher: string;
}>> {
  return db.withTenant(asCoord, async (c) => {
    const { rows } = await c.query<{
      subject: string; day: number; period: number; room: string | null; teacher: string;
    }>(
      `SELECT sub.name_bn AS subject, rs.day_of_week AS day, rs.period_no AS period,
              rm.code AS room, u.full_name_bn AS teacher
         FROM routine_slots rs
         JOIN subjects sub ON sub.id = rs.subject_id
         JOIN users u ON u.id = rs.teacher_id
         LEFT JOIN rooms rm ON rm.id = rs.room_id
        WHERE rs.routine_id = $1 ORDER BY rs.day_of_week, rs.period_no, sub.name_bn`, [RT]);
    return rows;
  });
}

describe('parallel blocks (F-504)', { skip }, () => {
  before(async () => { db = createDb(DATABASE_URL as string); await seed(); });
  after(async () => { if (db) { await dropFixtures(); await db.end(); await unlockFixtures(); } });
  beforeEach(async () => {
    await db.withTenant(asCoord, async (c) => { await c.query('DELETE FROM routine_slots'); });
  });

  test('THE ONE THAT MATTERS — four religion variants share one period', async () => {
    const result = await new RmsSolver(db).solve(RT, asCoord);
    assert.equal(result.placed, 4);
    assert.equal(result.unplaced.length, 0);

    const rows = await placed();
    assert.equal(rows.length, 4);
    // One slot, four subjects. Scheduled separately this would occupy four
    // periods with three quarters of the section idle in each.
    const slots = new Set(rows.map((r) => `${r.day}|${r.period}`));
    assert.equal(slots.size, 1, 'all four are in the SAME day and period');
  });

  test('each group gets its own teacher and its own room', async () => {
    await new RmsSolver(db).solve(RT, asCoord);
    const rows = await placed();

    assert.equal(new Set(rows.map((r) => r.teacher)).size, 4);
    // Only one group can stay in the section's own classroom; the other
    // three walk somewhere else, which is what a school actually does.
    assert.equal(new Set(rows.map((r) => r.room)).size, 4);
    assert.ok(rows.some((r) => r.room === '201'), "the section's own room is used");
  });

  test('an ordinary subject is not folded into the block', async () => {
    // Bangla has no selection pool, so it must NOT share the religion slot
    // — the whole section takes it together.
    await db.withTenant(asCoord, async (c) => {
      await c.query(
        `INSERT INTO class_subjects (tenant_id, class_id, subject_id, academic_year_id, periods_per_week)
         VALUES ($1,$2,$3,$4,1) ON CONFLICT DO NOTHING`, [T, CLASS9, BANGLA, YEAR]);
      await c.query(
        `INSERT INTO section_subject_teachers
           (tenant_id, section_id, subject_id, teacher_id, academic_year_id)
         VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`, [T, SEC, BANGLA, TEACH[0], YEAR]);
    });

    await new RmsSolver(db).solve(RT, asCoord);
    const rows = await placed();
    const bangla = rows.find((r) => r.subject === 'বাংলা');
    const religionSlot = rows.filter((r) => r.subject !== 'বাংলা')[0];
    assert.ok(bangla);
    assert.notEqual(`${bangla!.day}|${bangla!.period}`,
                    `${religionSlot.day}|${religionSlot.period}`);

    await db.withTenant(asCoord, async (c) => {
      await c.query('DELETE FROM section_subject_teachers WHERE subject_id = $1', [BANGLA]);
      await c.query('DELETE FROM class_subjects WHERE subject_id = $1', [BANGLA]);
    });
  });

  test('the block is refused rather than split when rooms run short', async () => {
    // Take two rooms out of service: three groups cannot be housed, so the
    // block does not run at all. Placing two of four would be worse than
    // placing none — the section would be half-taught and half-idle, and
    // nobody would notice from the timetable.
    await db.withTenant(asCoord, async (c) => {
      await c.query(`UPDATE rooms SET is_bookable = false WHERE id = ANY($1::uuid[])`,
                    [[ROOMS[2], ROOMS[3]]]);
    });

    const result = await new RmsSolver(db).solve(RT, asCoord);
    assert.equal(result.placed, 0);
    // Reported per subject, because a coordinator looks up "why is
    // হিন্দুধর্ম missing", not "why is pool religion missing".
    assert.equal(result.unplaced.length, 4);
    assert.ok(result.unplaced.every((u) => u.parallelPool === 'religion'));

    await db.withTenant(asCoord, async (c) => {
      await c.query(`UPDATE rooms SET is_bookable = true WHERE id = ANY($1::uuid[])`,
                    [[ROOMS[2], ROOMS[3]]]);
    });
  });

  test('one teacher cannot cover two groups of the same block', async () => {
    // Two variants assigned to the same person: they would have to be in
    // two rooms at once, so the block cannot run.
    await db.withTenant(asCoord, async (c) => {
      await c.query(
        `UPDATE section_subject_teachers SET teacher_id = $1 WHERE subject_id = $2`,
        [TEACH[0], REL[1]]);
    });

    const result = await new RmsSolver(db).solve(RT, asCoord);
    assert.equal(result.placed, 0);

    await db.withTenant(asCoord, async (c) => {
      await c.query(
        `UPDATE section_subject_teachers SET teacher_id = $1 WHERE subject_id = $2`,
        [TEACH[1], REL[1]]);
    });
  });

  test('regenerating puts the block back exactly where it was', async () => {
    // §8.2: "regenerating after one change must not reshuffle the whole
    // school". Rooms are chosen in a stable order for that reason.
    await new RmsSolver(db).solve(RT, asCoord);
    const first = await placed();
    await db.withTenant(asCoord, async (c) => { await c.query('DELETE FROM routine_slots'); });
    await new RmsSolver(db).solve(RT, asCoord);
    assert.deepEqual(await placed(), first);
  });
});
