/**
 * Routine generation result — F-503, F-505, wireframe §8.2
 *
 * The report itself is tested without a database in
 * soft-constraints.test.ts. What needs a real one is the half §8.2 calls
 * "কেন এই বরাদ্দ?" — the per-slot explanation, which is a claim about the
 * school's competency register and the rest of the timetable and is only
 * worth anything if it is checked against both.
 *
 * The fixture is built so each answer is provably different:
 *   • Chemistry has ONE qualified teacher            → "একমাত্র যোগ্য শিক্ষক"
 *   • Bangla has THREE, two of them busy this hour   → "একমাত্র যোগ্য ও মুক্ত"
 *   • Maths has THREE, all free                      → "৩ জন ... একজন"
 *
 *   DATABASE_URL=postgresql://shikhon_runtime:… node --test services/rms-svc/test/generation.test.ts
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { createDb, type Db, type TenantContext } from '../../../packages/server-core/src/db.ts';
import { installTestKeys, call, lockFixtures, unlockFixtures} from '../../../packages/server-core/test/harness.ts';

const DATABASE_URL = process.env.DATABASE_URL;
const skip = !DATABASE_URL ? 'DATABASE_URL not set' : false;

const T      = '7a300000-0000-4000-8000-00000000000a';
const COORD  = '7a300000-0000-4000-8000-0000000000ff';
const T1     = '7a300000-0000-4000-8000-0000000000a1';
const T2     = '7a300000-0000-4000-8000-0000000000a2';
const T3     = '7a300000-0000-4000-8000-0000000000a3';
const YEAR   = '7a300000-0000-4000-8000-000000000091';
const CLASS9 = '7a300000-0000-4000-8000-0000000000c9';
const SEC    = '7a300000-0000-4000-8000-0000000000b1';
const SEC2   = '7a300000-0000-4000-8000-0000000000b2';
const SEC3   = '7a300000-0000-4000-8000-0000000000b3';
const CHEM   = '7a300000-0000-4000-8000-000000000137';
const BANGLA = '7a300000-0000-4000-8000-000000000101';
const MATHS  = '7a300000-0000-4000-8000-000000000107';
const ROOM   = '7a300000-0000-4000-8000-0000000000d1';
const LAB    = '7a300000-0000-4000-8000-0000000000d2';
const ROOM2  = '7a300000-0000-4000-8000-0000000000d3';
const TPL    = '7a300000-0000-4000-8000-0000000000e1';
const PD1    = '7a300000-0000-4000-8000-0000000000f1';
const PD2    = '7a300000-0000-4000-8000-0000000000f2';
const RT     = '7a300000-0000-4000-8000-00000000a001';

const SLOT_CHEM   = '7a300000-0000-4000-8000-00000000b001';
const SLOT_BANGLA = '7a300000-0000-4000-8000-00000000b002';
const SLOT_MATHS  = '7a300000-0000-4000-8000-00000000b003';
const SLOT_T3     = '7a300000-0000-4000-8000-00000000b004';

let db: Db;
let coordToken: string;
let studentToken: string;
let generation: typeof import('../api/generation.ts').default;
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
       VALUES ($1,'f505','জেনারেশন','Generation','bangla_medium','secondary')`, [T]);
    await c.query(
      `INSERT INTO users (id, tenant_id, full_name_bn, full_name_en, phone_e164) VALUES
         ($1,$5,'সমন্বয়ক','Coordinator','+8801793000001'),
         ($2,$5,'নাসরিন আক্তার','Nasrin','+8801793000002'),
         ($3,$5,'রফিক ইসলাম','Rafiq','+8801793000003'),
         ($4,$5,'শিরিন','Shirin','+8801793000004')`,
      [COORD, T1, T2, T3, T]);
    await c.query(
      `INSERT INTO academic_years (id, tenant_id, label, starts_on, ends_on, is_current)
       VALUES ($1,$2,'2026','2026-01-01','2026-12-31',true)`, [YEAR, T]);
    await c.query(
      `INSERT INTO classes (id, tenant_id, level_no, name_bn, name_en, stream)
       VALUES ($1,$2,9,'নবম','Nine','bangla_medium')`, [CLASS9, T]);
    await c.query(
      `INSERT INTO rooms (id, tenant_id, code, name_bn, capacity, capabilities) VALUES
         ($1,$4,'204','কক্ষ ২০৪',60,'{}'),
         ($2,$4,'LAB-1','ল্যাব ১',40,'{chemistry_lab}'),
         ($3,$4,'205','কক্ষ ২০৫',60,'{}')`,
      [ROOM, LAB, ROOM2, T]);
    await c.query(
      `INSERT INTO sections (id, tenant_id, class_id, academic_year_id, name, home_room_id) VALUES
         ($1,$4,$5,$6,'ক',$7), ($2,$4,$5,$6,'খ',$7), ($3,$4,$5,$6,'গ',$7)`,
      [SEC, SEC2, SEC3, T, CLASS9, YEAR, ROOM]);
    await c.query(
      `INSERT INTO subjects (id, tenant_id, nctb_code, name_bn, name_en, requires_capability) VALUES
         ($1,$4,'137','রসায়ন','Chemistry','chemistry_lab'),
         ($2,$4,'101','বাংলা','Bangla',NULL),
         ($3,$4,'107','গণিত','Mathematics',NULL)`,
      [CHEM, BANGLA, MATHS, T]);

    // Chemistry: one qualified. Bangla and Maths: all three.
    await c.query(
      `INSERT INTO teacher_competencies
         (tenant_id, teacher_id, subject_id, min_class_level, max_class_level) VALUES
         ($1,$2,$5,9,10),
         ($1,$2,$6,9,10), ($1,$3,$6,9,10), ($1,$4,$6,9,10),
         ($1,$2,$7,9,10), ($1,$3,$7,9,10), ($1,$4,$7,9,10)`,
      [T, T1, T2, T3, CHEM, BANGLA, MATHS]);

    await c.query(
      `INSERT INTO period_templates (id, tenant_id, name_bn, shift, effective_from)
       VALUES ($1,$2,'নিয়মিত','single','2026-01-01')`, [TPL, T]);
    await c.query(
      `INSERT INTO period_definitions
         (id, tenant_id, template_id, period_no, label_bn, starts_at, ends_at, kind) VALUES
         ($1,$3,$4,1,'১ম','09:00','09:45','teaching'),
         ($2,$3,$4,2,'২য়','09:45','10:30','teaching')`,
      [PD1, PD2, T, TPL]);
    await c.query(
      `INSERT INTO routines (id, tenant_id, academic_year_id, period_template_id,
                             name_bn, status, effective_from, generated_by,
                             objective_score, solver_seconds, soft_violations)
       VALUES ($1,$2,$3,$4,'নিয়মিত রুটিন','draft','2026-01-01','solver',96.5,1.2,
               $5::jsonb)`,
      [RT, T, YEAR, TPL, JSON.stringify({
        unplaced: [{ sectionId: SEC, subjectId: MATHS, missing: 1, reason: 'no_free_slot' }],
        soft: [
          { code: 'teacher_weekly_cap',
            detailBn: 'রফিক ইসলাম — সাপ্তাহিক ২৬ পিরিয়ড (লক্ষ্য ২৪)',
            causeBn: 'যোগ্য গণিত শিক্ষক কম (১ জন)' },
          { code: 'teacher_room_churn', detailBn: 'শিরিন — সোমবার দিনে ৩ বার কক্ষ পরিবর্তন' },
        ],
        notEvaluated: [{ ruleBn: 'কঠিন বিষয় দিনের শুরুতে রাখা',
                         whyBn: 'বিষয়ের কাঠিন্য মাত্রা কোথাও সংরক্ষিত নেই' }],
      })]);

    // Period 1 Sunday: Chemistry in the lab (T1), Bangla for section খ
    // taken by T2, Maths for section গ taken by T3. All three Bangla-
    // qualified teachers are therefore accounted for at 09:00, leaving the
    // incumbent as the only one who could have taken the Bangla slot.
    await c.query(
      `INSERT INTO routine_slots
         (id, tenant_id, routine_id, day_of_week, period_no, period_definition_id,
          starts_at, ends_at, primary_section_id, subject_id, teacher_id, room_id) VALUES
         ($1,app.current_tenant(),$7,0,1,$4,'09:00','09:45',$5,$8,$10,$12),
         ($2,app.current_tenant(),$7,0,1,$4,'09:00','09:45',$6,$9,$11,$13),
         ($3,app.current_tenant(),$7,0,2,$14,'09:45','10:30',$5,$15,$10,$13),
         ($16,app.current_tenant(),$7,0,1,$4,'09:00','09:45',$17,$15,$18,$19)`,
      [SLOT_CHEM, SLOT_BANGLA, SLOT_MATHS, PD1, SEC, SEC2, RT,
       CHEM, BANGLA, T1, T2, LAB, ROOM, PD2, MATHS, SLOT_T3, SEC3, T3, ROOM2]);
  });
}

describe('generation result (§8.2)', { skip }, () => {
  before(async () => {
    await installTestKeys();
    // Serialised against other runs of this same suite — the fixtures below
    // live at fixed uuids and two processes would delete each other's.
    await lockFixtures(DATABASE_URL as string);
    db = createDb(DATABASE_URL as string);
    await seed();
    const { signAccessToken } = await import('../../../packages/server-core/src/jwt.ts');
    coordToken = await signAccessToken({
      sub: COORD, tid: T, role: 'academic_coordinator', roles: ['academic_coordinator'] });
    studentToken = await signAccessToken({ sub: COORD, tid: T, role: 'student', roles: ['student'] });
    generation = (await import('../api/generation.ts')).default;
  });
  after(async () => { if (db) { await dropFixtures(); await db.end(); await unlockFixtures(); } });

  const get = (qs: string, token = coordToken) =>
    call(generation, { url: `/api/v1/rms/generation?${qs}`, token });

  test('the report shows both counters and the persisted trades', async () => {
    const r = await get(`routineId=${RT}`);
    assert.equal(r.status, 200);
    const b = r.body as {
      hardViolations: number; soft: Array<{ detailBn: string; causeBn?: string }>;
      unplaced: unknown[]; notEvaluated: unknown[]; slots: unknown[];
    };
    // §8.2's two counters mean different things and are kept apart.
    assert.equal(b.hardViolations, 0);
    assert.equal(b.soft.length, 2);
    assert.equal(b.soft[0].detailBn, 'রফিক ইসলাম — সাপ্তাহিক ২৬ পিরিয়ড (লক্ষ্য ২৪)');
    assert.equal(b.soft[0].causeBn, 'যোগ্য গণিত শিক্ষক কম (১ জন)');
    assert.equal(b.unplaced.length, 1);
    assert.equal(b.notEvaluated.length, 1);
    assert.equal(b.slots.length, 4);
  });

  test('a single qualified teacher is described as exactly that', async () => {
    const r = await get(`slotId=${SLOT_CHEM}`);
    const b = r.body as { teacherWhyBn: string; qualifiedCount: number };
    assert.equal(b.qualifiedCount, 1);
    assert.equal(b.teacherWhyBn, 'নাসরিন আক্তার — রসায়ন এর একমাত্র যোগ্য শিক্ষক');
  });

  test('"the only free one" is asserted only when the timetable agrees', async () => {
    // Three teachers can take Bangla. At 09:00 on Sunday T1 is in the lab
    // and T3 is teaching Maths, so only the incumbent was available. Note
    // the incumbent counts as free for their OWN slot — the question is
    // who COULD have taken it, and they obviously could.
    const r = await get(`slotId=${SLOT_BANGLA}`);
    const b = r.body as { teacherWhyBn: string; qualifiedCount: number; freeCount: number };
    assert.equal(b.qualifiedCount, 3);
    assert.equal(b.freeCount, 1);
    assert.match(b.teacherWhyBn, /এই পিরিয়ডে একমাত্র যোগ্য ও মুক্ত শিক্ষক/);
  });

  test('when several were free it says so, rather than claiming necessity', async () => {
    // Period 2 has nobody else booked. A confident-sounding explanation
    // that is not true is worse than none — it ends the thinking.
    const r = await get(`slotId=${SLOT_MATHS}`);
    const b = r.body as { teacherWhyBn: string; freeCount: number };
    assert.equal(b.freeCount, 3);
    assert.match(b.teacherWhyBn, /৩ জন যোগ্য ও মুক্ত শিক্ষকের একজন/);
  });

  test('a capability room is explained by the capability, not by habit', async () => {
    const r = await get(`slotId=${SLOT_CHEM}`);
    assert.equal((r.body as { roomWhyBn: string }).roomWhyBn, 'LAB-1 — একমাত্র উপযুক্ত কক্ষ');
  });

  test("a plain classroom is explained as the section's own", async () => {
    const r = await get(`slotId=${SLOT_MATHS}`);
    assert.equal((r.body as { roomWhyBn: string }).roomWhyBn, '204 — শাখার নিজস্ব কক্ষ');
  });

  test('accepting publishes the routine', async () => {
    const r = await call(generation, {
      method: 'POST', url: '/api/v1/rms/generation', token: coordToken,
      body: { routineId: RT, action: 'accept' },
    });
    assert.equal(r.status, 200);
    assert.equal((r.body as { status: string }).status, 'active');

    const after = await get(`routineId=${RT}`);
    assert.equal((after.body as { routine: { status: string } }).routine.status, 'active');
  });

  test('discarding archives rather than deletes — the comparison matters', async () => {
    await db.withTenant(asCoord, async (c) => {
      await c.query(`UPDATE routines SET status = 'draft' WHERE id = $1`, [RT]);
    });
    const r = await call(generation, {
      method: 'POST', url: '/api/v1/rms/generation', token: coordToken,
      body: { routineId: RT, action: 'discard' },
    });
    assert.equal((r.body as { status: string }).status, 'archived');

    // The slots survive: the next run is usually compared against this one,
    // and deleting the evidence makes "why was that better?" unanswerable.
    await db.withTenant(asCoord, async (c) => {
      const n = await c.query<{ count: string }>(
        'SELECT count(*) FROM routine_slots WHERE routine_id = $1', [RT]);
      assert.equal(n.rows[0].count, '4');
    });
  });

  test('a student cannot read a generation report', async () => {
    const r = await get(`routineId=${RT}`, studentToken);
    assert.equal(r.status, 403);
  });

  test('an unknown routine is a 404, not an empty report', async () => {
    const r = await get('routineId=7a300000-0000-4000-8000-0000000000ee');
    assert.equal(r.status, 404);
  });
});
