/**
 * P9-2 — the wizard's server half.
 *
 * Three of its steps are writers for tables that had none, which is what kept
 * P9 PARTIAL: bell times, subject demand, teacher availability. The fourth
 * thing it does is the readiness check, which is the wizard's entire promise —
 * nobody reaches Generate without knowing what is missing.
 *
 * ── What these tests are pinned to ─────────────────────────────────────────
 * Not "the endpoint returns 200". Three properties that decide whether a
 * school can use this at all:
 *
 *   1. `state` is three-valued and the third value is used. A wizard that
 *      only knew complete/incomplete would make a school chase optional work
 *      before its first run — availability is the case, and it must WARN and
 *      never block.
 *
 *   2. Validation names the thing. "দুপুর ১:২০-এর বিরতি ৫ম period-এর সঙ্গে
 *      overlap করছে" and not "invalid schedule". The database would refuse an
 *      overlap anyway (`pd_no_overlap_within_template`, migration 073) with a
 *      message naming a constraint nobody in an office can act on.
 *
 *   3. Working days stay PLATFORM-owned. Migration 069 refuses
 *      `tenants.weekend_days` from a school account on purpose; this endpoint
 *      reports the value and offers no way to write it. A step that quietly
 *      gained that power would be a privilege escalation dressed as a
 *      convenience.
 *
 *   DATABASE_URL=postgres://shikhon_app:… \
 *     node --test services/rms-svc/test/setup.test.ts
 */
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { createDb, type Db, type TenantContext } from '../../../packages/server-core/src/db.ts';
import { installTestKeys, call, lockFixtures, unlockFixtures, asBootstrap } from '../../../packages/server-core/test/harness.ts';

const DATABASE_URL = process.env.DATABASE_URL;
const skip = !DATABASE_URL ? 'DATABASE_URL not set' : false;

const T       = '7c920000-0000-4000-8000-0000000000a0';
const HEAD    = '7c920000-0000-4000-8000-0000000000a1';
const RAFIQ   = '7c920000-0000-4000-8000-0000000000a2';
const STUDENT = '7c920000-0000-4000-8000-0000000000a3';
const DEPT    = '7c920000-0000-4000-8000-0000000000a4';
const YEAR    = '7c920000-0000-4000-8000-0000000000c1';
const KLASS   = '7c920000-0000-4000-8000-0000000000d1';
const SEC_A   = '7c920000-0000-4000-8000-0000000000e1';
const MATHS   = '7c920000-0000-4000-8000-0000000000f1';
const CHEM    = '7c920000-0000-4000-8000-0000000000f2';
const TEMPLATE = '7c920000-0000-4000-8000-00000000ab01';
const ROOM    = '7c920000-0000-4000-8000-00000000ab02';

let db: Db;
let headToken = '';
let studentToken = '';
let deptToken = '';
let setup: Parameters<typeof call>[0];

const head: TenantContext = { tenantId: T, userId: HEAD, role: 'principal' };

const get = (q: string, token = headToken) =>
  call(setup, { url: `/?${q}`, token } as Parameters<typeof call>[1]);
const post = (body: unknown, token = headToken) =>
  call(setup, { method: 'POST', url: '/', token, body } as Parameters<typeof call>[1]);

interface Step { id: string; state: string; detailBn: string; done: number; total: number }
const stepsOf = async (token = headToken) => {
  const r = await get(`yearId=${YEAR}`, token);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const b = r.body as { steps: Step[]; canGenerate: boolean; weekend: { managedBy: string } };
  return { ...b, by: (id: string) => b.steps.find((s) => s.id === id) as Step };
};

describe('P9-2 — the routine setup wizard, server side', { skip }, () => {
  before(async () => {
    await installTestKeys();
    await lockFixtures(DATABASE_URL as string);
    db = createDb(DATABASE_URL as string);

    await asBootstrap(db, head, async (c) => {
      await c.query('DELETE FROM tenants WHERE id = $1', [T]);
      await c.query(
        `INSERT INTO tenants (id, slug, name_bn, name_en, stream, level)
         VALUES ($1,'p92-setup','পি৯২','P92','bangla_medium','secondary')`, [T]);
      for (const [id, bn, phone, role] of [
        [HEAD, 'প্রধান', '+8801799920001', 'principal'],
        [RAFIQ, 'রফিক স্যার', '+8801799920002', 'subject_teacher'],
        [STUDENT, 'ছাত্র', '+8801799920003', 'student'],
        [DEPT, 'বিভাগীয় প্রধান', '+8801799920004', 'dept_head'],
      ] as const) {
        await c.query(
          `INSERT INTO users (id, tenant_id, full_name_bn, full_name_en, phone_e164, status)
           VALUES ($1,$2,$3,'X',$4,'active')`, [id, T, bn, phone]);
        await c.query(
          `INSERT INTO user_roles (tenant_id, user_id, role_code) VALUES ($1,$2,$3)`,
          [T, id, role]);
      }
      await c.query(
        `INSERT INTO staff_profiles (user_id, tenant_id, employee_code)
         VALUES ($1,$2,'EMP-1')`, [RAFIQ, T]);
      await c.query(
        `INSERT INTO academic_years (id, tenant_id, label, starts_on, ends_on, is_current)
         VALUES ($1,$2,'2026','2026-01-01','2026-12-31',true)`, [YEAR, T]);
      await c.query(
        `INSERT INTO classes (id, tenant_id, level_no, name_bn, name_en, stream)
         VALUES ($1,$2,9,'নবম','Nine','bangla_medium')`, [KLASS, T]);
      await c.query(
        `INSERT INTO sections (id, tenant_id, class_id, academic_year_id, name, student_count)
         VALUES ($1,$2,$3,$4,'ক',0)`, [SEC_A, T, KLASS, YEAR]);
      await c.query(
        `INSERT INTO subjects (id, tenant_id, name_bn, name_en, short_name)
         VALUES ($1,$2,'গণিত','Mathematics','গণি')`, [MATHS, T]);
      // A practical subject, so the room step has something to want.
      await c.query(
        `INSERT INTO subjects (id, tenant_id, name_bn, name_en, short_name, requires_capability)
         VALUES ($1,$2,'রসায়ন','Chemistry','রসা','chemistry_lab')`, [CHEM, T]);
      for (const sub of [MATHS, CHEM]) {
        await c.query(
          `INSERT INTO class_subjects
             (tenant_id, class_id, subject_id, academic_year_id, periods_per_week)
           VALUES ($1,$2,$3,$4,4)`, [T, KLASS, sub, YEAR]);
      }
      await c.query(
        `INSERT INTO period_templates (id, tenant_id, name_bn, shift, effective_from, is_active)
         VALUES ($1,$2,'সকাল','morning','2026-01-01',true)`, [TEMPLATE, T]);
      await c.query(
        `INSERT INTO rooms (id, tenant_id, code, name_bn, capacity, capabilities, is_bookable)
         VALUES ($1,$2,'R-1','কক্ষ ১',40,'{}',true)`, [ROOM, T]);
    });

    const { signAccessToken } = await import('../../../packages/server-core/src/jwt.ts');
    headToken = await signAccessToken({ sub: HEAD, tid: T, role: 'principal', roles: ['principal'] });
    studentToken = await signAccessToken({ sub: STUDENT, tid: T, role: 'student', roles: ['student'] });
    deptToken = await signAccessToken({ sub: DEPT, tid: T, role: 'dept_head', roles: ['dept_head'] });
    setup = (await import('../api/setup.ts')).default;
  });

  after(async () => {
    if (!db) return;
    await asBootstrap(db, head, (c) => c.query('DELETE FROM tenants WHERE id = $1', [T]));
    await db.end(); await unlockFixtures();
  });

  beforeEach(() => asBootstrap(db, head, async (c) => {
    await c.query('DELETE FROM period_definitions WHERE tenant_id = $1', [T]);
    await c.query('DELETE FROM teacher_availability WHERE tenant_id = $1', [T]);
    await c.query(
      `UPDATE section_subject_teachers SET ended_on = started_on, end_reason = 'reset'
        WHERE tenant_id = $1 AND ended_on IS NULL`, [T]);
    await c.query('UPDATE class_subjects SET periods_per_week = 4 WHERE tenant_id = $1', [T]);
  }));

  /* ───────────────────────────── readiness ──────────────────────────── */

  test('THE ONE THAT MATTERS — readiness says exactly what is missing', async () => {
    const r = await stepsOf();
    assert.equal(r.canGenerate, false, 'nothing is set up yet');

    assert.equal(r.by('periods').state, 'blocked');
    assert.match(r.by('periods').detailBn, /কোনো পিরিয়ড/);

    assert.equal(r.by('assignments').state, 'blocked');
    assert.match(r.by('assignments').detailBn, /বাকি|সম্পূর্ণ/,
      'it must name the count, not say "incomplete"');

    // Structure and rooms ARE ready, and saying so is half the value: a
    // coordinator must not re-check work that is already done.
    assert.equal(r.by('structure').state, 'ok');
    assert.equal(r.by('rooms').state, 'warn', 'a chemistry lab is wanted and absent');
  });

  test('availability WARNS and never blocks', async () => {
    // The distinction the three-valued state exists for. A school that has
    // recorded nothing gets a routine built on "everyone is free", which is
    // the right default for a first run.
    const r = await stepsOf();
    assert.equal(r.by('availability').state, 'warn');
    assert.notEqual(r.by('availability').state, 'blocked',
      'chasing optional work before a first run is the opposite of one minute');
  });

  test('working days are reported and NOT writable', async () => {
    const r = await stepsOf();
    assert.equal(r.weekend.managedBy, 'platform',
      'migration 069 makes this platform-owned and P9-2 preserves that');
    assert.match(r.by('workingdays').detailBn, /সপ্তাহে .* দিন ক্লাস/);

    // There is no step for it, so the endpoint refuses the attempt outright.
    const attempt = await post({ step: 'workingdays', weekendDays: [0, 1, 2, 3, 4, 5, 6] });
    assert.equal(attempt.status, 400);
    assert.equal((attempt.body as { error: string }).error, 'invalid_step');
  });

  /* ─────────────────────────── bell times ───────────────────────────── */

  test('a bell schedule saves, and readiness turns', async () => {
    const r = await post({ step: 'periods', templateId: TEMPLATE, periods: [
      { periodNo: 1, labelBn: '১ম', startsAt: '08:00', endsAt: '08:45', kind: 'teaching' },
      { periodNo: 2, labelBn: '২য়', startsAt: '08:45', endsAt: '09:30', kind: 'teaching' },
      { periodNo: 3, labelBn: 'টিফিন', startsAt: '09:30', endsAt: '10:00', kind: 'tiffin' },
      { periodNo: 4, labelBn: '৩য়', startsAt: '10:00', endsAt: '10:45', kind: 'teaching' },
    ] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body, { periods: 4, teaching: 3 });

    const after = await stepsOf();
    assert.equal(after.by('periods').state, 'ok');
    assert.match(after.by('periods').detailBn, /প্রতিদিন ৩টি ক্লাস পিরিয়ড/,
      'it counts TEACHING periods — a tiffin break is not a lesson');
  });

  test('an overlapping break is refused BY NAME, not by constraint', async () => {
    const r = await post({ step: 'periods', templateId: TEMPLATE, periods: [
      { periodNo: 1, labelBn: '৫ম পিরিয়ড', startsAt: '13:00', endsAt: '13:45', kind: 'teaching' },
      { periodNo: 2, labelBn: 'বিরতি', startsAt: '13:20', endsAt: '13:50', kind: 'break' },
    ] });
    assert.equal(r.status, 409);
    const msg = (r.body as { message: string }).message;
    assert.match(msg, /৫ম পিরিয়ড/, 'names the first period');
    assert.match(msg, /বিরতি/, 'and the break it collides with');
    assert.match(msg, /13:20|13:45/, 'and the times, so it can be fixed without guessing');
  });

  test('a period that ends before it starts is refused', async () => {
    const r = await post({ step: 'periods', templateId: TEMPLATE, periods: [
      { periodNo: 1, labelBn: '১ম', startsAt: '10:00', endsAt: '09:00', kind: 'teaching' },
    ] });
    assert.equal(r.status, 400);
    assert.equal((r.body as { error: string }).error, 'ends_before_start');
    assert.match((r.body as { message: string }).message, /10:00.*09:00/);
  });

  test('saving a schedule REPLACES it — no half-old, half-new bell', async () => {
    await post({ step: 'periods', templateId: TEMPLATE, periods: [
      { periodNo: 1, labelBn: '১ম', startsAt: '08:00', endsAt: '08:45', kind: 'teaching' },
      { periodNo: 2, labelBn: '২য়', startsAt: '09:00', endsAt: '09:45', kind: 'teaching' },
    ] });
    await post({ step: 'periods', templateId: TEMPLATE, periods: [
      { periodNo: 1, labelBn: 'নতুন ১ম', startsAt: '07:30', endsAt: '08:15', kind: 'teaching' },
    ] });
    const g = await get(`yearId=${YEAR}&step=periods`);
    const body = g.body as { periods: Array<{ labelBn: string }> };
    assert.equal(body.periods.length, 1, 'the old schedule must not survive alongside the new');
    assert.equal(body.periods[0].labelBn, 'নতুন ১ম');
  });

  /* ────────────────────────── subject demand ────────────────────────── */

  test('subject demand is editable, and zero periods is a WARNING', async () => {
    const g = await get(`yearId=${YEAR}&step=demand`);
    const rows = (g.body as { rows: Array<{ id: string; nameBn: string }> }).rows;
    assert.equal(rows.length, 2);

    const r = await post({ step: 'demand', yearId: YEAR, rows: [
      { id: rows[0].id, periodsPerWeek: 6, doublePeriodsPerWeek: 1 },
      { id: rows[1].id, periodsPerWeek: 0, doublePeriodsPerWeek: 0 },
    ] });
    assert.equal(r.status, 200, JSON.stringify(r.body));

    const after = await stepsOf();
    assert.equal(after.by('demand').state, 'warn');
    assert.match(after.by('demand').detailBn, /শূন্য/,
      'a subject with no periods will not appear in the routine and must be said');
  });

  test('more doubles than the week can hold is refused with the arithmetic', async () => {
    const g = await get(`yearId=${YEAR}&step=demand`);
    const rows = (g.body as { rows: Array<{ id: string }> }).rows;
    const r = await post({ step: 'demand', yearId: YEAR, rows: [
      { id: rows[0].id, periodsPerWeek: 3, doublePeriodsPerWeek: 2 },
    ] });
    assert.equal(r.status, 409);
    assert.match((r.body as { message: string }).message, /৪টি পিরিয়ড লাগবে/,
      'two doubles need four periods — say so, do not say "invalid"');
  });

  test('the marks columns are never touched by the demand editor', async () => {
    // `class_subjects` carries a CHECK that cq+mcq+practical+ca = total. A
    // demand writer that wrote the whole row would trip it, and this screen
    // is not where a school edits marks.
    const g = await get(`yearId=${YEAR}&step=demand`);
    const rows = (g.body as { rows: Array<{ id: string }> }).rows;
    await post({ step: 'demand', yearId: YEAR, rows: [
      { id: rows[0].id, periodsPerWeek: 7, doublePeriodsPerWeek: 0 }] });

    const { rows: marks } = await asBootstrap(db, head, (c) => c.query<{
      total_marks: number; cq_marks: number; periods_per_week: number;
    }>('SELECT total_marks, cq_marks, periods_per_week FROM class_subjects WHERE id = $1',
      [rows[0].id]));
    assert.equal(marks[0].periods_per_week, 7);
    assert.equal(marks[0].total_marks, 100, 'marks must be exactly as they were');
    assert.equal(marks[0].cq_marks, 70);
  });

  /* ─────────────────────── teacher availability ─────────────────────── */

  test('availability records a block, and distinguishes a preference', async () => {
    const block = await post({ step: 'availability', teacherId: RAFIQ, dayOfWeek: 1,
      startsAt: '08:00', endsAt: '10:00', kind: 'unavailable', reason: 'ক্লিনিক' });
    assert.equal(block.status, 200, JSON.stringify(block.body));

    const pref = await post({ step: 'availability', teacherId: RAFIQ, dayOfWeek: 2,
      startsAt: '08:00', endsAt: '10:00', kind: 'preferred' });
    assert.equal(pref.status, 200);

    const g = await get(`yearId=${YEAR}&step=availability`);
    const blocks = (g.body as { blocks: Array<{ kind: string; reason: string | null }> }).blocks;
    assert.equal(blocks.length, 2);
    assert.ok(blocks.some((b) => b.kind === 'unavailable' && b.reason === 'ক্লিনিক'));
    assert.ok(blocks.some((b) => b.kind === 'preferred'),
      'a preference is not an unavailability and the model keeps them apart');
  });

  test('a block can be removed — a mistake must not outlive the moment', async () => {
    const made = await post({ step: 'availability', teacherId: RAFIQ, dayOfWeek: 3,
      startsAt: '11:00', endsAt: '12:00', kind: 'unavailable' });
    const id = (made.body as { id: string }).id;
    const gone = await post({ step: 'availability', remove: id });
    assert.equal(gone.status, 200);

    const g = await get(`yearId=${YEAR}&step=availability`);
    assert.equal((g.body as { blocks: unknown[] }).blocks.length, 0);
  });

  test('a DEPT HEAD may set availability but not the curriculum', async () => {
    // Deliberate, and narrower than it looks: every availability row names
    // one teacher, so there is no school-wide blast radius — and a head of
    // department is who actually knows about a Thursday clinic.
    const ok = await post({ step: 'availability', teacherId: RAFIQ, dayOfWeek: 4,
      startsAt: '08:00', endsAt: '09:00', kind: 'unavailable' }, deptToken);
    assert.equal(ok.status, 200, JSON.stringify(ok.body));

    const g = await get(`yearId=${YEAR}&step=demand`, headToken);
    const rows = (g.body as { rows: Array<{ id: string }> }).rows;
    const refused = await post({ step: 'demand', yearId: YEAR, rows: [
      { id: rows[0].id, periodsPerWeek: 9, doublePeriodsPerWeek: 0 }] }, deptToken);
    assert.equal(refused.status, 403, 'the curriculum is not a department head’s to set');
  });

  /* ───────────────────────────── security ───────────────────────────── */

  test('a student can neither read the setup nor write any step', async () => {
    assert.equal((await get(`yearId=${YEAR}`, studentToken)).status, 403);
    assert.equal((await get(`yearId=${YEAR}&step=demand`, studentToken)).status, 403);
    assert.equal((await post({ step: 'periods', templateId: TEMPLATE, periods: [
      { periodNo: 1, labelBn: 'x', startsAt: '08:00', endsAt: '09:00' }] },
      studentToken)).status, 403);
    assert.equal((await post({ step: 'availability', teacherId: STUDENT, dayOfWeek: 1,
      startsAt: '08:00', endsAt: '16:00', kind: 'unavailable' }, studentToken)).status, 403);
  });

  test('canGenerate turns true only when nothing is blocked', async () => {
    await post({ step: 'periods', templateId: TEMPLATE, periods: [
      { periodNo: 1, labelBn: '১ম', startsAt: '08:00', endsAt: '08:45', kind: 'teaching' },
    ] });
    // Both subjects assigned — the assignments step is the last blocker.
    await asBootstrap(db, head, (c) => c.query(
      `INSERT INTO section_subject_teachers
         (tenant_id, section_id, subject_id, teacher_id, academic_year_id, started_on)
       SELECT $1, $2, sub.id, $3, $4, '2026-01-05'
         FROM subjects sub WHERE sub.tenant_id = $1 AND sub.id IN ($5, $6)`,
      [T, SEC_A, RAFIQ, YEAR, MATHS, CHEM]));

    const r = await stepsOf();
    assert.equal(r.by('assignments').state, 'ok');
    assert.equal(r.canGenerate, true,
      'warnings must not hold a school back — only blockers do');
  });
});
