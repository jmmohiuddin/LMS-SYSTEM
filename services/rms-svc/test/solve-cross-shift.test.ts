/**
 * The routine solver, across shifts — F-506
 *
 * The database now refuses to publish a routine that double-books a
 * teacher against the other shift (migration 032). This suite is about the
 * half that decides whether that refusal is ever reached: a solver that
 * did not know about the other shift would happily generate a routine that
 * cannot be published, and hand the coordinator a screen full of soft
 * violations instead of a timetable.
 *
 * The fixture is the shape that breaks it. The morning shift's period 8
 * runs 12:00–12:45; the day shift's period 1 runs 12:30–13:15. Different
 * PERIOD NUMBERS, overlapping CLOCK TIME, and রফিক teaches in both shifts —
 * which is not an edge case, it is how a school with 45 teachers and two
 * shifts is staffed.
 *
 *   DATABASE_URL=postgresql://shikhon_runtime:… node --test services/rms-svc/test/solve-cross-shift.test.ts
 */
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { createDb, type Db, type TenantContext } from '../../../packages/server-core/src/db.ts';
import { RmsSolver } from '../src/solve.ts';

const DATABASE_URL = process.env.DATABASE_URL;
const skip = !DATABASE_URL ? 'DATABASE_URL not set' : false;

const T        = '7a200000-0000-4000-8000-00000000000a';
const COORD    = '7a200000-0000-4000-8000-0000000000ff';
const RAFIQ    = '7a200000-0000-4000-8000-0000000000a1';
const SALMA    = '7a200000-0000-4000-8000-0000000000a2';
const YEAR     = '7a200000-0000-4000-8000-000000000091';
const CLASS9   = '7a200000-0000-4000-8000-0000000000c9';
const CLASS6   = '7a200000-0000-4000-8000-0000000000c6';
const SEC_M    = '7a200000-0000-4000-8000-0000000000b1';   // morning
const SEC_D    = '7a200000-0000-4000-8000-0000000000b2';   // day
const BANGLA   = '7a200000-0000-4000-8000-000000000109';
const MATHS    = '7a200000-0000-4000-8000-000000000107';
const ROOM_M   = '7a200000-0000-4000-8000-0000000000d1';
const ROOM_D   = '7a200000-0000-4000-8000-0000000000d2';
const TPL_M    = '7a200000-0000-4000-8000-0000000000e1';
const TPL_D    = '7a200000-0000-4000-8000-0000000000e2';
const PD_M8    = '7a200000-0000-4000-8000-0000000000f1';
const PD_D1    = '7a200000-0000-4000-8000-0000000000f2';
const RT_M     = '7a200000-0000-4000-8000-00000000a001';
const RT_D     = '7a200000-0000-4000-8000-00000000a002';

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
       VALUES ($1,'f506-solver','দ্বৈত শিফট','Two Shift','bangla_medium','secondary')`, [T]);
    await c.query(
      `INSERT INTO users (id, tenant_id, full_name_bn, full_name_en, phone_e164) VALUES
         ($1,$4,'সমন্বয়ক','Coordinator','+8801792000001'),
         ($2,$4,'রফিক ইসলাম','Rafiq','+8801792000002'),
         ($3,$4,'সালমা খাতুন','Salma','+8801792000003')`,
      [COORD, RAFIQ, SALMA, T]);
    await c.query(
      `INSERT INTO academic_years (id, tenant_id, label, starts_on, ends_on, is_current)
       VALUES ($1,$2,'2026','2026-01-01','2026-12-31',true)`, [YEAR, T]);
    await c.query(
      `INSERT INTO classes (id, tenant_id, level_no, name_bn, name_en, stream) VALUES
         ($1,$3,9,'নবম','Nine','bangla_medium'), ($2,$3,6,'ষষ্ঠ','Six','bangla_medium')`,
      [CLASS9, CLASS6, T]);
    await c.query(
      `INSERT INTO rooms (id, tenant_id, code, name_bn, capacity) VALUES
         ($1,$3,'204','কক্ষ ২০৪',60), ($2,$3,'205','কক্ষ ২০৫',60)`,
      [ROOM_M, ROOM_D, T]);
    await c.query(
      `INSERT INTO sections (id, tenant_id, class_id, academic_year_id, name, shift, home_room_id) VALUES
         ($1,$3,$4,$6,'ক','morning',$7), ($2,$3,$5,$6,'খ','day',$8)`,
      [SEC_M, SEC_D, T, CLASS9, CLASS6, YEAR, ROOM_M, ROOM_D]);
    await c.query(
      `INSERT INTO subjects (id, tenant_id, nctb_code, name_bn, name_en) VALUES
         ($1,$3,'109','বাংলা','Bangla'), ($2,$3,'107','গণিত','Mathematics')`,
      [BANGLA, MATHS, T]);

    // One teaching period per shift, overlapping by fifteen minutes. That
    // narrowness is the point: the ONLY slot the day shift can use is the
    // one the morning shift already occupies.
    await c.query(
      `INSERT INTO period_templates (id, tenant_id, name_bn, shift, effective_from) VALUES
         ($1,$3,'প্রভাতি','morning','2026-01-01'), ($2,$3,'দিবা','day','2026-01-01')`,
      [TPL_M, TPL_D, T]);
    await c.query(
      `INSERT INTO period_definitions
         (id, tenant_id, template_id, period_no, label_bn, starts_at, ends_at, kind) VALUES
         ($1,$3,$4,8,'৮ম','12:00','12:45','teaching'),
         ($2,$3,$5,1,'১ম','12:30','13:15','teaching')`,
      [PD_M8, PD_D1, T, TPL_M, TPL_D]);

    // One period a week of each subject, both taught by রফিক.
    await c.query(
      `INSERT INTO class_subjects (tenant_id, class_id, subject_id, academic_year_id, periods_per_week)
       VALUES ($1,$2,$4,$6,1), ($1,$3,$5,$6,1)`,
      [T, CLASS9, CLASS6, BANGLA, MATHS, YEAR]);
    await c.query(
      `INSERT INTO section_subject_teachers (tenant_id, section_id, subject_id, teacher_id, academic_year_id)
       VALUES ($1,$2,$4,$6,$8), ($1,$3,$5,$7,$8)`,
      [T, SEC_M, SEC_D, BANGLA, MATHS, RAFIQ, RAFIQ, YEAR]);

    await c.query(
      `INSERT INTO routines (id, tenant_id, academic_year_id, period_template_id, shift,
                             name_bn, status, effective_from) VALUES
         ($1,$3,$4,$5,'morning','প্রভাতি রুটিন','active','2026-01-01'),
         ($2,$3,$4,$6,'day','দিবা রুটিন','draft','2026-01-01')`,
      [RT_M, RT_D, T, YEAR, TPL_M, TPL_D]);
  });
}

/** Every weekday the morning teacher is already booked at 12:00–12:45. */
async function fillMorning(): Promise<void> {
  await db.withTenant(asCoord, async (c) => {
    for (const day of [0, 1, 2, 3, 4]) {
      await c.query(
        `INSERT INTO routine_slots
           (tenant_id, routine_id, day_of_week, period_no, period_definition_id,
            starts_at, ends_at, primary_section_id, subject_id, teacher_id, room_id)
         VALUES (app.current_tenant(),$1,$2,8,$3,'12:00','12:45',$4,$5,$6,$7)`,
        [RT_M, day, PD_M8, SEC_M, BANGLA, RAFIQ, ROOM_M]);
    }
  });
}

describe('routine solver across shifts (F-506)', { skip }, () => {
  before(async () => { db = createDb(DATABASE_URL as string); await seed(); });
  after(async () => { if (db) { await dropFixtures(); await db.end(); } });

  beforeEach(async () => {
    await db.withTenant(asCoord, async (c) => {
      await c.query('DELETE FROM routine_slots');
      await c.query(`UPDATE routines SET status = 'active' WHERE id = $1`, [RT_M]);
      await c.query(`UPDATE routines SET status = 'draft'  WHERE id = $1`, [RT_D]);
    });
  });

  test('THE ONE THAT MATTERS — the day shift is not placed over the morning', async () => {
    await fillMorning();

    const result = await new RmsSolver(db).solve(RT_D, asCoord);

    // Every hour the day shift could use is one রফিক is already teaching in
    // the morning shift, so the honest answer is "cannot place", not a
    // placement that would fail at publication.
    assert.equal(result.placed, 0);
    assert.equal(result.unplaced.length, 1);
    assert.equal(result.unplaced[0].teacherId, RAFIQ);
    assert.equal(result.unplaced[0].reason, 'no_free_slot');

    await db.withTenant(asCoord, async (c) => {
      const n = await c.query<{ count: string }>(
        'SELECT count(*) FROM routine_slots WHERE routine_id = $1', [RT_D]);
      assert.equal(n.rows[0].count, '0', 'nothing was written for the day shift');
    });
  });

  test('and the routine it did not write would indeed have been unpublishable', async () => {
    // The other half of the guarantee: had the solver placed those slots,
    // publication would fail. Insert one by hand to prove the pair agree.
    await fillMorning();
    await db.withTenant(asCoord, async (c) => {
      await c.query(
        `INSERT INTO routine_slots
           (tenant_id, routine_id, day_of_week, period_no, period_definition_id,
            starts_at, ends_at, primary_section_id, subject_id, teacher_id, room_id)
         VALUES (app.current_tenant(),$1,1,1,$2,'12:30','13:15',$3,$4,$5,$6)`,
        [RT_D, PD_D1, SEC_D, MATHS, RAFIQ, ROOM_D]);
    });

    await assert.rejects(
      db.withTenant(asCoord, async (c) => {
        await c.query(`UPDATE routines SET status = 'active' WHERE id = $1`, [RT_D]);
      }),
      /রফিক/,
    );
  });

  test('a free teacher in the same hour is placed normally', async () => {
    // The exclusion must be about রফিক being busy, not about the hour
    // being cursed.
    await fillMorning();
    await db.withTenant(asCoord, async (c) => {
      await c.query(
        `UPDATE section_subject_teachers SET teacher_id = $1 WHERE section_id = $2`,
        [SALMA, SEC_D]);
    });

    const result = await new RmsSolver(db).solve(RT_D, asCoord);
    assert.equal(result.placed, 1);
    assert.equal(result.unplaced.length, 0);

    await db.withTenant(asCoord, async (c) => {
      await c.query(`UPDATE section_subject_teachers SET teacher_id = $1 WHERE section_id = $2`,
                    [RAFIQ, SEC_D]);
    });
  });

  test('a morning routine that is only a DRAFT does not block the day shift', async () => {
    // Drafts constrain nothing — a coordinator building two routines side
    // by side must not have the first one veto the second.
    await db.withTenant(asCoord, async (c) => {
      await c.query(`UPDATE routines SET status = 'draft' WHERE id = $1`, [RT_M]);
    });
    await fillMorning();

    const result = await new RmsSolver(db).solve(RT_D, asCoord);
    assert.equal(result.placed, 1, 'the day shift places against a draft morning');
  });

  test('a clean handover at 12:45 is not an overlap', async () => {
    // The morning ends exactly when the day begins. Half-open intervals, so
    // this is the timetable a well-run school already uses and it must
    // stay schedulable.
    await fillMorning();
    await db.withTenant(asCoord, async (c) => {
      await c.query(`UPDATE period_definitions SET starts_at = '12:45', ends_at = '13:30'
                      WHERE id = $1`, [PD_D1]);
    });

    const result = await new RmsSolver(db).solve(RT_D, asCoord);
    assert.equal(result.placed, 1);

    await db.withTenant(asCoord, async (c) => {
      await c.query(`UPDATE period_definitions SET starts_at = '12:30', ends_at = '13:15'
                      WHERE id = $1`, [PD_D1]);
    });
  });
});
