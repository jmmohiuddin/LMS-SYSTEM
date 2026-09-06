/**
 * P0/A4 — authoring a routine, and the three clashes the database refuses.
 *
 * `editor.ts` had no test at all. That is how it shipped a query selecting
 * `rm.name` — a column `rooms` does not have — which made every slot query
 * fail at parse time, so the routine editor had never once opened a grid.
 *
 * It could also only MOVE a slot and PUBLISH. Nothing anywhere could create a
 * `routines` row or a `routine_slots` row: `INSERT INTO routines` appeared
 * nowhere outside test fixtures, and the live database held **0 routines and
 * 0 slots across every tenant** while 10 period templates sat provisioned and
 * unused. The solver filled a routine that could not exist and the publish
 * button published it.
 *
 * ── What is deliberately NOT re-implemented ─────────────────────────────
 * The three clashes are GiST exclusion constraints on `routine_slots`:
 *
 *   rs_no_teacher_double_booking   (tenant, year, teacher, day, time_range)
 *   rs_no_room_double_booking      (tenant, year, room,    day, time_range)
 *   rs_no_section_double_booking   (tenant, routine, section, day, time_range)
 *
 * `place` attempts the write and turns the 23P01 into a sentence. These tests
 * therefore assert the DATABASE refuses — a JS pre-check would pass them while
 * losing a race, and would drift the moment the schema changed.
 *
 * `time_range` is half-open, so a period ending at 09:45 and one starting at
 * 09:45 do not collide. The fixture uses two genuinely overlapping periods to
 * make the constraints fire.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { createDb, type Db } from '../../../packages/server-core/src/db.ts';
import { installTestKeys, call, lockFixtures, unlockFixtures, asBootstrap } from '../../../packages/server-core/test/harness.ts';

const DATABASE_URL = process.env.DATABASE_URL;
const skip = !DATABASE_URL ? 'DATABASE_URL not set' : false;

const T       = '7c020000-0000-4000-8000-00000000000c';
const OTHER   = '7c020000-0000-4000-8000-00000000000d';
const COORD   = '7c020000-0000-4000-8000-0000000000ff';
const TEACH_A = '7c020000-0000-4000-8000-0000000000a1';
const TEACH_B = '7c020000-0000-4000-8000-0000000000a2';
const YEAR    = '7c020000-0000-4000-8000-000000000091';
const CLASS   = '7c020000-0000-4000-8000-0000000000c1';
const SEC_A   = '7c020000-0000-4000-8000-0000000000c2';
const SEC_B   = '7c020000-0000-4000-8000-0000000000c3';
const BANGLA  = '7c020000-0000-4000-8000-000000000101';
const MATHS   = '7c020000-0000-4000-8000-000000000102';
const ROOM    = '7c020000-0000-4000-8000-0000000000f1';
const TPL     = '7c020000-0000-4000-8000-000000000201';

let db: Db;
let coordToken: string;
let teacherToken: string;
let otherToken: string;
let editor: typeof import('../api/editor.ts').default;

async function dropFixtures(): Promise<void> {
  for (const id of [T, OTHER]) {
    await asBootstrap(db, { tenantId: id, userId: COORD, role: 'principal' }, async (c) => {
      await c.query('DELETE FROM tenants WHERE id = $1', [id]);
    });
  }
}

async function seed(): Promise<void> {
  await dropFixtures();
  await asBootstrap(db, { tenantId: T, userId: COORD, role: 'principal' }, async (c) => {
    await c.query(
      `INSERT INTO tenants (id, slug, name_bn, name_en, stream, level, weekend_days)
       VALUES ($1,'a4-editor','রুটিন লেখা','Routine Authoring','bangla_medium','secondary','{5,6}')`, [T]);
    await c.query(
      `INSERT INTO users (id, tenant_id, full_name_bn, full_name_en, phone_e164) VALUES
         ($1,$4,'সমন্বয়ক','Coordinator','+8801796000001'),
         ($2,$4,'রফিক ইসলাম','Rafiq','+8801796000002'),
         ($3,$4,'সালমা খাতুন','Salma','+8801796000003')`,
      [COORD, TEACH_A, TEACH_B, T]);
    await c.query(
      `INSERT INTO academic_years (id, tenant_id, label, starts_on, ends_on, is_current)
       VALUES ($1,$2,'2026','2026-01-01','2026-12-31',true)`, [YEAR, T]);
    await c.query(
      `INSERT INTO classes (id, tenant_id, level_no, name_bn, name_en, stream, "group")
       VALUES ($1,$2,9,'নবম','Nine','bangla_medium','science')`, [CLASS, T]);
    await c.query(
      `INSERT INTO sections (id, tenant_id, class_id, academic_year_id, name, shift) VALUES
         ($1,$3,$4,$5,'ক','single'), ($2,$3,$4,$5,'খ','single')`,
      [SEC_A, SEC_B, T, CLASS, YEAR]);
    await c.query(
      `INSERT INTO subjects (id, tenant_id, nctb_code, name_bn, name_en) VALUES
         ($1,$3,'101','বাংলা','Bangla'), ($2,$3,'109','গণিত','Maths')`,
      [BANGLA, MATHS, T]);
    await c.query(
      `INSERT INTO class_subjects (tenant_id, class_id, subject_id, academic_year_id, periods_per_week)
       VALUES ($1,$2,$3,$4,6), ($1,$2,$5,$4,6)`,
      [T, CLASS, BANGLA, YEAR, MATHS]);
    // Rafiq teaches both subjects in BOTH sections — which is what makes a
    // teacher clash reachable at all.
    await c.query(
      `INSERT INTO section_subject_teachers
         (tenant_id, section_id, subject_id, teacher_id, academic_year_id, started_on) VALUES
         ($1,$2,$4,$6,$8,'2026-01-01'), ($1,$2,$5,$6,$8,'2026-01-01'),
         ($1,$3,$4,$6,$8,'2026-01-01'), ($1,$3,$5,$7,$8,'2026-01-01')`,
      [T, SEC_A, SEC_B, BANGLA, MATHS, TEACH_A, TEACH_B, YEAR]);
    await c.query(
      `INSERT INTO rooms (id, tenant_id, code, name_bn, capacity)
       VALUES ($1,$2,'201','কক্ষ ২০১',60)`, [ROOM, T]);
    await c.query(
      `INSERT INTO period_templates (id, tenant_id, name_bn, shift, effective_from, is_active)
       VALUES ($1,$2,'নিয়মিত ঘণ্টা','single','2026-01-01',true)`, [TPL, T]);
    // A REAL bell schedule: consecutive, non-overlapping.
    //
    // Periods 1 and 2 used to overlap on purpose (09:00-10:00 and
    // 09:30-10:30) so that a clash was reachable. P9-2's
    // `pd_no_overlap_within_template` (migration 073) now refuses that, and
    // rightly: a school cannot ring period 1 and period 2 at overlapping
    // times in one shift, so the fixture was reaching its clash through a
    // state no school can be in.
    //
    // The clashes below are reachable without it, and more directly — "the
    // same section twice in one hour" IS the same period. Placing twice into
    // period 1 collides on the identical time range, which is exactly what
    // the three GiST constraints exist to catch.
    await c.query(
      `INSERT INTO period_definitions (tenant_id, template_id, period_no, label_bn, starts_at, ends_at, kind) VALUES
         ($1,$2,1,'১ম','09:00','10:00','teaching'),
         ($1,$2,2,'২য়','10:00','11:00','teaching'),
         ($1,$2,3,'টিফিন','11:00','11:30','tiffin'),
         ($1,$2,4,'৩য়','11:30','12:30','teaching')`,
      [T, TPL]);
  });

  await asBootstrap(db, { tenantId: OTHER, userId: COORD, role: 'principal' }, async (c) => {
    await c.query(
      `INSERT INTO tenants (id, slug, name_bn, name_en, stream, level)
       VALUES ($1,'a4-editor-b','অন্য বিদ্যালয়','Other','bangla_medium','secondary')`, [OTHER]);
  });
}

const post = (body: Record<string, unknown>, token = coordToken) =>
  call(editor, { method: 'POST', url: '/api/v1/rms/editor', token, body });

const grid = (token = coordToken) =>
  call(editor, { url: `/api/v1/rms/editor?sectionId=${SEC_A}`, token });

let routineId = '';

describe('A4 — routine authoring', { skip }, () => {
  before(async () => {
    await installTestKeys();
    await lockFixtures(DATABASE_URL as string);
    db = createDb(DATABASE_URL as string);
    await seed();
    const { signAccessToken } = await import('../../../packages/server-core/src/jwt.ts');
    coordToken = await signAccessToken({
      sub: COORD, tid: T, role: 'academic_coordinator', roles: ['academic_coordinator'] });
    teacherToken = await signAccessToken({
      sub: TEACH_A, tid: T, role: 'subject_teacher', roles: ['subject_teacher'] });
    otherToken = await signAccessToken({
      sub: COORD, tid: OTHER, role: 'academic_coordinator', roles: ['academic_coordinator'] });
    editor = (await import('../api/editor.ts')).default;
  });

  after(async () => {
    if (db) { await dropFixtures(); await db.end(); await unlockFixtures(); }
  });

  test('an empty section offers the setup a routine needs, not a dead end', async () => {
    const r = await grid();
    assert.equal(r.status, 200);
    const b = r.body as {
      routine: null; days: { dow: number; bn: string }[];
      setup: { periodTemplateId: string; shift: string; sectionLabel: string } | null;
    };
    assert.equal(b.routine, null);
    // Before A4 this returned {routine:null, periods:[], slots:[]} and the
    // screen had nowhere to go — the routine row could not be created.
    assert.ok(b.setup, 'the screen must be told which template and shift to create against');
    assert.equal(b.setup?.periodTemplateId, TPL);
    assert.equal(b.setup?.shift, 'single');
    // Five teaching days for a {5,6} weekend, and they come from the tenant.
    assert.deepEqual(b.days.map((d) => d.dow), [0, 1, 2, 3, 4]);
  });

  test('THE ONE THAT MATTERS — a routine can be created and a lesson placed', async () => {
    const c = await post({ action: 'create-routine', sectionId: SEC_A, nameBn: 'নিয়মিত রুটিন ২০২৬' });
    assert.equal(c.status, 200, JSON.stringify(c.body));
    routineId = (c.body as { routineId: string }).routineId;
    assert.ok(routineId);

    const p = await post({
      action: 'place', routineId, sectionId: SEC_A, dayOfWeek: 0, periodNo: 1,
      subjectId: BANGLA, teacherId: TEACH_A, roomId: ROOM,
    });
    assert.equal(p.status, 200, JSON.stringify(p.body));

    const g = await grid();
    const b = g.body as { slots: { dayOfWeek: number; periodNo: number; subjectBn: string; teacherName: string; roomName: string }[] };
    assert.equal(b.slots.length, 1);
    assert.equal(b.slots[0].subjectBn, 'বাংলা');
    assert.equal(b.slots[0].teacherName, 'রফিক ইসলাম');
    assert.equal(b.slots[0].roomName, 'কক্ষ ২০১');
  });

  test('the pickers offer only this class’s subjects and this section’s teachers', async () => {
    const b = (await grid()).body as {
      subjects: { id: string }[];
      teachers: { subjectId: string; id: string }[];
      rooms: { id: string }[];
    };
    assert.deepEqual(b.subjects.map((x) => x.id).sort(), [BANGLA, MATHS].sort());
    // Section ক: Rafiq for both subjects. Salma teaches only in section খ, so
    // she must not be offered here.
    assert.ok(b.teachers.every((t) => t.id === TEACH_A),
      'a teacher not assigned to this section was offered');
    assert.ok(b.rooms.some((r) => r.id === ROOM));
  });

  describe('the database refuses the three clashes, and the API names them', () => {
    test('SECTION clash — the same section, twice in one hour', async () => {
      // The SAME period as the placement above: one hour, one section, two
      // lessons. No overlapping bell schedule needed to reach it.
      const r = await post({
        action: 'place', routineId, sectionId: SEC_A, dayOfWeek: 0, periodNo: 1,
        subjectId: MATHS, teacherId: TEACH_A,
      });
      assert.equal(r.status, 409, JSON.stringify(r.body));
      const b = r.body as { error: string; message: string };
      // Section is checked first by the constraint order; whichever fires, the
      // message must name a real thing rather than say "conflict".
      assert.ok(['section_busy', 'teacher_busy'].includes(b.error), b.error);
      assert.match(b.message, /বাংলা/, 'the refusal must name the class already there');
    });

    test('TEACHER clash — one teacher, two sections, one hour', async () => {
      const r = await post({
        action: 'place', routineId, sectionId: SEC_B, dayOfWeek: 0, periodNo: 1,
        subjectId: BANGLA, teacherId: TEACH_A,
      });
      assert.equal(r.status, 409, JSON.stringify(r.body));
      const b = r.body as { error: string; message: string };
      assert.equal(b.error, 'teacher_busy');
      assert.match(b.message, /রফিক ইসলাম/, 'the refusal must name the teacher');
      assert.match(b.message, /নবম-ক/, 'and the class they are already with');
    });

    test('ROOM clash — one room, two sections, one hour', async () => {
      // Salma teaches maths in section খ, so this is not a teacher clash.
      const r = await post({
        action: 'place', routineId, sectionId: SEC_B, dayOfWeek: 0, periodNo: 1,
        subjectId: MATHS, teacherId: TEACH_B, roomId: ROOM,
      });
      assert.equal(r.status, 409, JSON.stringify(r.body));
      const b = r.body as { error: string; message: string };
      assert.equal(b.error, 'room_busy');
      assert.match(b.message, /কক্ষ ২০১/, 'the refusal must name the room');
    });

    test('and a genuinely free hour is accepted', async () => {
      const r = await post({
        action: 'place', routineId, sectionId: SEC_B, dayOfWeek: 0, periodNo: 4,
        subjectId: MATHS, teacherId: TEACH_B, roomId: ROOM,
      });
      assert.equal(r.status, 200, JSON.stringify(r.body));
    });
  });

  describe('the domain rules the form must not be able to break', () => {
    test('a break period is not a teaching hour', async () => {
      const r = await post({
        action: 'place', routineId, sectionId: SEC_A, dayOfWeek: 1, periodNo: 3,
        subjectId: BANGLA, teacherId: TEACH_A,
      });
      assert.equal(r.status, 409);
      assert.equal((r.body as { error: string }).error, 'period_not_teaching');
    });

    test('the institution’s own weekend is refused — never a hard-coded Friday', async () => {
      // day 5 is Friday, which THIS tenant does not teach on.
      const r = await post({
        action: 'place', routineId, sectionId: SEC_A, dayOfWeek: 5, periodNo: 1,
        subjectId: BANGLA, teacherId: TEACH_A,
      });
      assert.equal(r.status, 409);
      assert.equal((r.body as { error: string }).error, 'not_a_teaching_day');
    });

    test('a teacher who does not teach that subject here is refused', async () => {
      // Salma teaches maths in খ, not বাংলা in ক.
      const r = await post({
        action: 'place', routineId, sectionId: SEC_A, dayOfWeek: 1, periodNo: 1,
        subjectId: BANGLA, teacherId: TEACH_B,
      });
      assert.equal(r.status, 409);
      assert.equal((r.body as { error: string }).error, 'teacher_not_assigned');
    });
  });

  test('a lesson can be reassigned, and removed without destroying the record', async () => {
    const g = (await grid()).body as { slots: { id: string; periodNo: number }[] };
    const slot = g.slots.find((s) => s.periodNo === 1);
    assert.ok(slot);

    const a = await post({ action: 'assign', slotId: slot!.id, subjectId: MATHS, teacherId: TEACH_A });
    assert.equal(a.status, 200, JSON.stringify(a.body));
    const after = (await grid()).body as { slots: { id: string; subjectBn: string }[] };
    assert.equal(after.slots.find((s) => s.id === slot!.id)?.subjectBn, 'গণিত');

    const r = await post({ action: 'remove', slotId: slot!.id });
    assert.equal(r.status, 200, JSON.stringify(r.body));

    const gone = (await grid()).body as { slots: { id: string }[] };
    assert.ok(!gone.slots.some((s) => s.id === slot!.id), 'the slot must leave the grid');

    // Soft delete: the row survives as history, and the hour is free again.
    const row = await asBootstrap(db, { tenantId: T, userId: COORD, role: 'principal' }, async (c) => {
      const q = await c.query<{ status: string }>(
        `SELECT status FROM routine_slots WHERE id = $1`, [slot!.id]);
      return q.rows[0];
    });
    assert.equal(row.status, 'removed', 'remove must be a soft delete, not a destruction');

    const reuse = await post({
      action: 'place', routineId, sectionId: SEC_A, dayOfWeek: 0, periodNo: 1,
      subjectId: BANGLA, teacherId: TEACH_A,
    });
    assert.equal(reuse.status, 200, 'a removed slot must stop blocking its hour');
  });

  test('publishing writes the ROUTINE lifecycle and nothing else', async () => {
    const r = await post({ action: 'publish', routineId });
    assert.equal(r.status, 200, JSON.stringify(r.body));

    const row = await asBootstrap(db, { tenantId: T, userId: COORD, role: 'principal' }, async (c) => {
      const q = await c.query<{ status: string; published_at: string | null }>(
        `SELECT status::text AS status, published_at FROM routines WHERE id = $1`, [routineId]);
      return q.rows[0];
    });
    assert.equal(row.status, 'active');
    assert.notEqual(row.published_at, null);
  });

  test('A1 REGRESSION — publishing a class routine leaves the exam alone', async () => {
    // Migration 068 separated the two lifecycles after publishing an exam
    // ROUTINE was found to set exams.status='published', which made the exam
    // permanently unmarkable. The class routine published in the test above
    // must not have reached anywhere near an exam.
    const exam = await asBootstrap(db, { tenantId: T, userId: COORD, role: 'principal' }, async (c) => {
      const e = await c.query<{ id: string }>(
        `INSERT INTO exams (tenant_id, academic_year_id, name_bn, name_en, exam_type, status)
         VALUES ($1,$2,'বার্ষিক','Annual','annual','planned') RETURNING id`, [T, YEAR]);
      return e.rows[0].id;
    });

    // A second routine cannot be published while one is active — the domain
    // allows exactly one per (year, shift). That refusal is itself worth
    // asserting: it used to be a 500.
    const c2 = await post({ action: 'create-routine', sectionId: SEC_A, nameBn: 'দ্বিতীয় খসড়া' });
    const second = (c2.body as { routineId: string }).routineId;
    const pub = await post({ action: 'publish', routineId: second });
    assert.equal(pub.status, 409, JSON.stringify(pub.body));
    assert.equal((pub.body as { error: string }).error, 'routine_already_active');

    const after = await asBootstrap(db, { tenantId: T, userId: COORD, role: 'principal' }, async (c) => {
      const q = await c.query<{ status: string; published_at: string | null; rpa: string | null }>(
        `SELECT status::text AS status, published_at, routine_published_at AS rpa
           FROM exams WHERE id = $1`, [exam]);
      return q.rows[0];
    });
    assert.equal(after.status, 'planned', 'a class-routine publish moved exams.status');
    assert.equal(after.published_at, null);
    assert.equal(after.rpa, null);
  });

  test('a published routine refuses further edits', async () => {
    const r = await post({
      action: 'place', routineId, sectionId: SEC_A, dayOfWeek: 2, periodNo: 1,
      subjectId: BANGLA, teacherId: TEACH_A,
    });
    assert.equal(r.status, 409);
    assert.equal((r.body as { error: string }).error, 'routine_not_editable');
  });

  describe('authorization and isolation', () => {
    test('a subject teacher may not author — the server refuses, not the UI', async () => {
      for (const body of [
        { action: 'create-routine', sectionId: SEC_A, nameBn: 'অবৈধ' },
        { action: 'place', routineId, sectionId: SEC_A, dayOfWeek: 1, periodNo: 1, subjectId: BANGLA, teacherId: TEACH_A },
        { action: 'remove', slotId: routineId },
      ]) {
        const r = await post(body, teacherToken);
        assert.equal(r.status, 403, `${body.action} was not refused`);
      }
    });

    test('another school cannot author into this one', async () => {
      const r = await post({
        action: 'place', routineId, sectionId: SEC_A, dayOfWeek: 1, periodNo: 1,
        subjectId: BANGLA, teacherId: TEACH_A,
      }, otherToken);
      // RLS makes the routine invisible, so it is genuinely not found.
      assert.equal(r.status, 404);
      assert.equal((r.body as { error: string }).error, 'routine_not_found');
    });

    test('and cannot read this section’s grid', async () => {
      const r = await call(editor, { url: `/api/v1/rms/editor?sectionId=${SEC_A}`, token: otherToken });
      const b = r.body as { routine: unknown; setup: unknown };
      assert.equal(b.routine, null);
      assert.equal(b.setup, null, 'another school must not learn this one’s shift or template');
    });
  });
});
