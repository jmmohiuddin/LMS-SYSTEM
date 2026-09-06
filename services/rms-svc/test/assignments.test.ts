/**
 * P9-1 — the teaching-assignment matrix, which is the input the generator
 * could not work without and no school could supply.
 *
 * P9-0's inventory found `section_subject_teachers` holding 6 rows across 183
 * schools with no writer anywhere, while `solve.ts:loadDemand` reads it and
 * nothing else to decide what a timetable must contain. This is that writer.
 *
 * ── What these tests are pinned to ─────────────────────────────────────────
 * Not "the endpoint returns 200". The table is a HISTORY table and migration
 * 072 refuses DELETE to everyone, so every edit has a shape: closing the open
 * row, opening a new one, and leaving the old one legible. A writer that
 * merely UPDATEd `teacher_id` in place would pass a naive test and quietly
 * destroy the record of who taught a class last term.
 *
 *   DATABASE_URL=postgres://shikhon_app:… \
 *     node --test services/rms-svc/test/assignments.test.ts
 */
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { createDb, type Db, type TenantContext } from '../../../packages/server-core/src/db.ts';
import { installTestKeys, call, lockFixtures, unlockFixtures, asBootstrap } from '../../../packages/server-core/test/harness.ts';

const DATABASE_URL = process.env.DATABASE_URL;
const skip = !DATABASE_URL ? 'DATABASE_URL not set' : false;

const T        = '7c910000-0000-4000-8000-0000000000a0';
const HEAD     = '7c910000-0000-4000-8000-0000000000a1';
const RAFIQ    = '7c910000-0000-4000-8000-0000000000a2';
const KARIM    = '7c910000-0000-4000-8000-0000000000a3';
const STUDENT  = '7c910000-0000-4000-8000-0000000000a4';
const YEAR     = '7c910000-0000-4000-8000-0000000000c1';
const YEAR_OLD = '7c910000-0000-4000-8000-0000000000c2';
const KLASS    = '7c910000-0000-4000-8000-0000000000d1';
const SEC_A    = '7c910000-0000-4000-8000-0000000000e1';
const SEC_B    = '7c910000-0000-4000-8000-0000000000e2';
const MATHS    = '7c910000-0000-4000-8000-0000000000f1';
const BANGLA   = '7c910000-0000-4000-8000-0000000000f2';
/** Studied by nobody — the "not in this class" refusal needs a real subject. */
const CHEM     = '7c910000-0000-4000-8000-0000000000f3';

let db: Db;
let headToken = '';
let studentToken = '';
let assignments: Parameters<typeof call>[0];

const head: TenantContext = { tenantId: T, userId: HEAD, role: 'principal' };

const get = (q: string, token = headToken) =>
  call(assignments, { url: `/?${q}`, token } as Parameters<typeof call>[1]);

const post = (body: unknown, token = headToken) =>
  call(assignments, { method: 'POST', url: '/', token, body } as Parameters<typeof call>[1]);

/** Every row for a cell, newest first — history included. */
const historyOf = (sectionId: string, subjectId: string) =>
  asBootstrap(db, head, (c) => c.query<{
    teacher_id: string; started_on: string; ended_on: string | null; end_reason: string | null;
  }>(
    `SELECT teacher_id, started_on::text, ended_on::text, end_reason
       FROM section_subject_teachers
      WHERE section_id = $1 AND subject_id = $2
      ORDER BY started_on DESC, ended_on NULLS FIRST`,
    [sectionId, subjectId]));

describe('P9-1 — who teaches what, where', { skip }, () => {
  before(async () => {
    await installTestKeys();
    await lockFixtures(DATABASE_URL as string);
    db = createDb(DATABASE_URL as string);

    await asBootstrap(db, head, async (c) => {
      await c.query('DELETE FROM tenants WHERE id = $1', [T]);
      await c.query(
        `INSERT INTO tenants (id, slug, name_bn, name_en, stream, level)
         VALUES ($1,'p91-assign','পি৯','P9','bangla_medium','secondary')`, [T]);
      for (const [id, bn, phone, role] of [
        [HEAD, 'প্রধান', '+8801799910001', 'principal'],
        [RAFIQ, 'রফিক স্যার', '+8801799910002', 'subject_teacher'],
        [KARIM, 'করিম স্যার', '+8801799910003', 'subject_teacher'],
        [STUDENT, 'ছাত্র', '+8801799910004', 'student'],
      ] as const) {
        await c.query(
          `INSERT INTO users (id, tenant_id, full_name_bn, full_name_en, phone_e164, status)
           VALUES ($1,$2,$3,'X',$4,'active')`, [id, T, bn, phone]);
        await c.query(
          `INSERT INTO user_roles (tenant_id, user_id, role_code) VALUES ($1,$2,$3)`,
          [T, id, role]);
      }
      // Staff profiles: the grid lists teachers by joining these, so a
      // "teacher" without one is correctly not offered.
      for (const [id, code] of [[RAFIQ, 'EMP-1'], [KARIM, 'EMP-2'], [HEAD, 'EMP-0']] as const) {
        await c.query(
          `INSERT INTO staff_profiles (user_id, tenant_id, employee_code)
           VALUES ($1,$2,$3) ON CONFLICT (user_id) DO NOTHING`, [id, T, code]);
      }
      for (const [id, label, cur] of [
        [YEAR, '2026', true], [YEAR_OLD, '2025', false],
      ] as const) {
        await c.query(
          `INSERT INTO academic_years (id, tenant_id, label, starts_on, ends_on, is_current)
           VALUES ($1,$2,$3,($3||'-01-01')::date,($3||'-12-31')::date,$4)`,
          [id, T, label, cur]);
      }
      await c.query(
        `INSERT INTO classes (id, tenant_id, level_no, name_bn, name_en, stream)
         VALUES ($1,$2,9,'নবম','Nine','bangla_medium')`, [KLASS, T]);
      for (const [id, name, year] of [
        [SEC_A, 'ক', YEAR], [SEC_B, 'খ', YEAR],
      ] as const) {
        await c.query(
          `INSERT INTO sections (id, tenant_id, class_id, academic_year_id, name, student_count)
           VALUES ($1,$2,$3,$4,$5,0)`, [id, T, KLASS, year, name]);
      }
      for (const [id, bn, en] of [
        [MATHS, 'গণিত', 'Mathematics'], [BANGLA, 'বাংলা', 'Bangla'],
        [CHEM, 'রসায়ন', 'Chemistry'],
      ] as const) {
        await c.query(
          `INSERT INTO subjects (id, tenant_id, name_bn, name_en, short_name)
           VALUES ($1,$2,$3,$4,substr($3,1,3))`, [id, T, bn, en]);
      }
      // The curriculum: class 9 studies maths and bangla. NOT chemistry.
      for (const [sub, pw] of [[MATHS, 6], [BANGLA, 5]] as const) {
        await c.query(
          `INSERT INTO class_subjects
             (tenant_id, class_id, subject_id, academic_year_id, periods_per_week)
           VALUES ($1,$2,$3,$4,$5)`, [T, KLASS, sub, YEAR, pw]);
      }
    });

    const { signAccessToken } = await import('../../../packages/server-core/src/jwt.ts');
    headToken = await signAccessToken({ sub: HEAD, tid: T, role: 'principal', roles: ['principal'] });
    studentToken = await signAccessToken({
      sub: STUDENT, tid: T, role: 'student', roles: ['student'] });
    assignments = (await import('../api/assignments.ts')).default;
  });

  after(async () => {
    if (!db) return;
    await asBootstrap(db, head, (c) => c.query('DELETE FROM tenants WHERE id = $1', [T]));
    await db.end(); await unlockFixtures();
  });

  // Close every open row between cases. DELETE is refused by design
  // (migration 072), so the reset is the same operation the product performs.
  beforeEach(() => asBootstrap(db, head, (c) => c.query(
    `UPDATE section_subject_teachers
        SET ended_on = started_on, end_reason = 'test reset'
      WHERE tenant_id = $1 AND ended_on IS NULL`, [T])));

  test('the grid shows the EMPTY cells — that is what it is for', async () => {
    const r = await get(`yearId=${YEAR}`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const g = r.body as {
      sections: unknown[]; subjects: unknown[]; teachers: unknown[];
      progress: { required: number; assigned: number };
    };

    assert.equal(g.sections.length, 2);
    assert.equal(g.subjects.length, 2, 'maths and bangla — not chemistry, which the class does not study');
    assert.ok(g.teachers.length >= 2, 'the teachers who could fill a cell');
    assert.deepEqual(g.progress, { required: 4, assigned: 0 },
      'a coordinator opening this needs to see how much is NOT done');
  });

  test('THE ONE THAT MATTERS — an assignment lands and the solver can see it', async () => {
    const r = await post({ yearId: YEAR, changes: [
      { sectionId: SEC_A, subjectId: MATHS, teacherId: RAFIQ },
      { sectionId: SEC_B, subjectId: MATHS, teacherId: KARIM },
    ] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body, { opened: 2, closed: 0, unchanged: 0 });

    // Read back the way `loadDemand` does: open rows, this year, this shift.
    const { rows } = await asBootstrap(db, head, (c) => c.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM section_subject_teachers
        WHERE academic_year_id = $1 AND ended_on IS NULL`, [YEAR]));
    assert.equal(rows[0].n, '2');
  });

  test('reassigning CLOSES the old row rather than overwriting it', async () => {
    // The property the whole history table exists for. A writer that UPDATEd
    // `teacher_id` in place would pass "the cell now says Karim" and destroy
    // the record of who taught it in March.
    await post({ yearId: YEAR, changes: [{ sectionId: SEC_A, subjectId: MATHS, teacherId: RAFIQ }] });
    const r = await post({ yearId: YEAR, changes: [
      { sectionId: SEC_A, subjectId: MATHS, teacherId: KARIM }] });
    assert.deepEqual(r.body, { opened: 1, closed: 1, unchanged: 0 });

    const { rows } = await historyOf(SEC_A, MATHS);
    const open = rows.filter((x) => x.ended_on === null);
    const shut = rows.filter((x) => x.ended_on !== null);
    assert.equal(open.length, 1, 'exactly one current teacher');
    assert.equal(open[0].teacher_id, KARIM);
    assert.ok(shut.some((x) => x.teacher_id === RAFIQ),
      'the previous teacher must survive as history');
    assert.ok(shut.every((x) => x.end_reason),
      'and a closed row must say why it closed');
  });

  test('clearing a cell closes without reopening', async () => {
    await post({ yearId: YEAR, changes: [{ sectionId: SEC_A, subjectId: MATHS, teacherId: RAFIQ }] });
    const r = await post({ yearId: YEAR, changes: [
      { sectionId: SEC_A, subjectId: MATHS, teacherId: null }] });
    assert.deepEqual(r.body, { opened: 0, closed: 1, unchanged: 0 });

    const { rows } = await historyOf(SEC_A, MATHS);
    assert.equal(rows.filter((x) => x.ended_on === null).length, 0,
      'nobody teaches it now — and the generator should say so, not skip it');
  });

  test('saving an unchanged grid writes nothing', async () => {
    // Without this, re-saving would close and reopen every row and fill the
    // history with churn that means nothing to anyone reading it later.
    await post({ yearId: YEAR, changes: [{ sectionId: SEC_A, subjectId: MATHS, teacherId: RAFIQ }] });
    const before = (await historyOf(SEC_A, MATHS)).rows.length;

    const again = await post({ yearId: YEAR, changes: [
      { sectionId: SEC_A, subjectId: MATHS, teacherId: RAFIQ }] });
    assert.deepEqual(again.body, { opened: 0, closed: 0, unchanged: 1 });

    // A DELTA, not an absolute count: earlier cases in this file left CLOSED
    // rows for the same cell and they are supposed to still be there —
    // nothing deletes teaching history, so the fixture cannot reset to zero.
    const after = (await historyOf(SEC_A, MATHS)).rows.length;
    assert.equal(after, before, 'a no-op save added a row');
  });

  test('a subject the class does not study is refused, in Bangla', async () => {
    const r = await post({ yearId: YEAR, changes: [
      { sectionId: SEC_A, subjectId: CHEM, teacherId: RAFIQ }] });
    assert.equal(r.status, 409);
    assert.equal((r.body as { error: string }).error, 'subject_not_in_class');
    assert.match((r.body as { message: string }).message, /[ঀ-৿]/);
  });

  test('a section from another YEAR cannot be written into this one', async () => {
    // The stale-tab case: last year's screen still open, this year's payload.
    const r = await post({ yearId: YEAR_OLD, changes: [
      { sectionId: SEC_A, subjectId: MATHS, teacherId: RAFIQ }] });
    assert.equal(r.status, 404);
    assert.equal((r.body as { error: string }).error, 'section_not_in_year');
  });

  test('a batch is all or nothing', async () => {
    // A coordinator who fills a column and hits a bad cell halfway should
    // find the column empty and do it again — not find half of it done and
    // have to work out which half.
    const r = await post({ yearId: YEAR, changes: [
      { sectionId: SEC_A, subjectId: MATHS, teacherId: RAFIQ },
      { sectionId: SEC_A, subjectId: CHEM, teacherId: RAFIQ },   // refused
    ] });
    assert.equal(r.status, 409);

    const { rows } = await historyOf(SEC_A, MATHS);
    assert.equal(rows.filter((x) => x.ended_on === null).length, 0,
      'the good half of a refused batch must roll back — no cell may be left current');
  });

  test('a student cannot write the school’s teaching load', async () => {
    // B-89 at the HTTP layer. RLS refuses it underneath (migration 072); this
    // asserts the endpoint does not hand a student a 500 on the way there.
    const r = await post({ yearId: YEAR, changes: [
      { sectionId: SEC_A, subjectId: MATHS, teacherId: STUDENT }] }, studentToken);
    assert.equal(r.status, 403);
  });

  test('and cannot read the grid either', async () => {
    const r = await get(`yearId=${YEAR}`, studentToken);
    assert.equal(r.status, 403);
  });

  test('progress counts what is done out of what is needed', async () => {
    await post({ yearId: YEAR, changes: [
      { sectionId: SEC_A, subjectId: MATHS, teacherId: RAFIQ },
      { sectionId: SEC_A, subjectId: BANGLA, teacherId: KARIM },
      { sectionId: SEC_B, subjectId: MATHS, teacherId: KARIM },
    ] });
    const g = (await get(`yearId=${YEAR}`)).body as {
      progress: { required: number; assigned: number };
    };
    assert.deepEqual(g.progress, { required: 4, assigned: 3 },
      'the wizard must never let anyone reach Generate without knowing this');
  });
});
