/**
 * P9-3 — READY → GENERATE → RESULT, against a real database.
 *
 * The solver has its own suites (`solve-*.test.ts`) and they are not repeated
 * here. This is about the four things the ORCHESTRATOR is responsible for,
 * each of which would be a real incident:
 *
 *   1. The readiness gate holds SERVER-side. A browser with a stale
 *      `canGenerate: true` — someone emptied the room list a minute ago —
 *      must not start a run that creates a draft routine nobody asked for.
 *
 *   2. Pressing Generate twice is safe. `editor.ts:createRoutine` versions as
 *      `max(version) + 1`, so a naive orchestrator would leave a school with
 *      draft v1 and draft v2 and no way to tell which one is the timetable.
 *
 *   3. Hard conflicts are IMPOSSIBLE, and it is proved by re-querying the
 *      stored rows rather than by believing the solver's own count. §6 is
 *      explicit about that, and the three GiST EXCLUDE constraints are what
 *      makes the answer trustworthy: a double-booking cannot be stored.
 *
 *   4. The result survives a refresh. A generation that lived only in browser
 *      memory would be a demo, not a product.
 *
 *   DATABASE_URL=postgres://shikhon_app:… \
 *     node --test services/rms-svc/test/generate.test.ts
 */
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { createDb, type Db, type TenantContext } from '../../../packages/server-core/src/db.ts';
import { installTestKeys, call, lockFixtures, unlockFixtures, asBootstrap } from '../../../packages/server-core/test/harness.ts';

const DATABASE_URL = process.env.DATABASE_URL;
const skip = !DATABASE_URL ? 'DATABASE_URL not set' : false;

const T        = '7c930000-0000-4000-8000-0000000000a0';
const HEAD     = '7c930000-0000-4000-8000-0000000000a1';
const RAFIQ    = '7c930000-0000-4000-8000-0000000000a2';
const SALMA    = '7c930000-0000-4000-8000-0000000000a3';
const STUDENT  = '7c930000-0000-4000-8000-0000000000a4';
const YEAR     = '7c930000-0000-4000-8000-0000000000c1';
const KLASS    = '7c930000-0000-4000-8000-0000000000d1';
const SEC_A    = '7c930000-0000-4000-8000-0000000000e1';
const SEC_B    = '7c930000-0000-4000-8000-0000000000e2';
const BANGLA   = '7c930000-0000-4000-8000-0000000000f1';
const MATHS    = '7c930000-0000-4000-8000-0000000000f2';
const TPL      = '7c930000-0000-4000-8000-00000000ab01';
const ROOM     = '7c930000-0000-4000-8000-00000000ab02';

/** A second school, for §14. */
const T_B      = '7c930000-0000-4000-8000-0000000000b0';
const HEAD_B   = '7c930000-0000-4000-8000-0000000000b1';
const YEAR_B   = '7c930000-0000-4000-8000-0000000000b2';

let db: Db;
let headToken = '';
let headBToken = '';
let studentToken = '';
let generate: Parameters<typeof call>[0];

const head: TenantContext = { tenantId: T, userId: HEAD, role: 'principal' };
const headB: TenantContext = { tenantId: T_B, userId: HEAD_B, role: 'principal' };

const run = (body: unknown, token = headToken) =>
  call(generate, { method: 'POST', url: '/', token, body } as Parameters<typeof call>[1]);
const read = (q: string, token = headToken) =>
  call(generate, { url: `/?${q}`, token } as Parameters<typeof call>[1]);

interface Summary {
  totalDemand: number; placed: number; unplacedPeriods: number;
  softViolations: number; hardConflicts: number; solverSeconds: number;
  totalSeconds: number; verdictBn: string;
}

describe('P9-3 — generating an institution-wide routine', { skip }, () => {
  before(async () => {
    await installTestKeys();
    await lockFixtures(DATABASE_URL as string);
    db = createDb(DATABASE_URL as string);

    await asBootstrap(db, head, async (c) => {
      await c.query('DELETE FROM tenants WHERE id = $1', [T]);
      await c.query(
        `INSERT INTO tenants (id, slug, name_bn, name_en, stream, level)
         VALUES ($1,'p93-gen','পি৯৩','P93','bangla_medium','secondary')`, [T]);
      for (const [id, bn, phone, role] of [
        [HEAD, 'প্রধান', '+8801799930001', 'principal'],
        [RAFIQ, 'রফিক স্যার', '+8801799930002', 'subject_teacher'],
        [SALMA, 'সালমা ম্যাডাম', '+8801799930003', 'subject_teacher'],
        [STUDENT, 'ছাত্র', '+8801799930004', 'student'],
      ] as const) {
        await c.query(
          `INSERT INTO users (id, tenant_id, full_name_bn, full_name_en, phone_e164, status)
           VALUES ($1,$2,$3,'X',$4,'active')`, [id, T, bn, phone]);
        await c.query(
          `INSERT INTO user_roles (tenant_id, user_id, role_code) VALUES ($1,$2,$3)`,
          [T, id, role]);
      }
      for (const [id, code] of [[RAFIQ, 'EMP-1'], [SALMA, 'EMP-2']] as const) {
        await c.query(
          `INSERT INTO staff_profiles (user_id, tenant_id, employee_code)
           VALUES ($1,$2,$3)`, [id, T, code]);
      }
      await c.query(
        `INSERT INTO academic_years (id, tenant_id, label, starts_on, ends_on, is_current)
         VALUES ($1,$2,'2026','2026-01-01','2026-12-31',true)`, [YEAR, T]);
      await c.query(
        `INSERT INTO classes (id, tenant_id, level_no, name_bn, name_en, stream)
         VALUES ($1,$2,9,'নবম','Nine','bangla_medium')`, [KLASS, T]);
      for (const [id, name] of [[SEC_A, 'ক'], [SEC_B, 'খ']] as const) {
        await c.query(
          `INSERT INTO sections (id, tenant_id, class_id, academic_year_id, name, student_count, shift)
           VALUES ($1,$2,$3,$4,$5,0,'single')`, [id, T, KLASS, YEAR, name]);
      }
      for (const [id, bnName, en] of [
        [BANGLA, 'বাংলা', 'Bangla'], [MATHS, 'গণিত', 'Mathematics'],
      ] as const) {
        await c.query(
          `INSERT INTO subjects (id, tenant_id, name_bn, name_en, short_name)
           VALUES ($1,$2,$3,$4,substr($3,1,3))`, [id, T, bnName, en]);
        await c.query(
          `INSERT INTO class_subjects
             (tenant_id, class_id, subject_id, academic_year_id, periods_per_week)
           VALUES ($1,$2,$3,$4,3)`, [T, KLASS, id, YEAR]);
      }
      // Bell schedule: five teaching periods, consecutive and legal.
      await c.query(
        `INSERT INTO period_templates (id, tenant_id, name_bn, shift, effective_from, is_active)
         VALUES ($1,$2,'নিয়মিত','single','2026-01-01',true)`, [TPL, T]);
      for (let i = 1; i <= 5; i++) {
        const from = `${String(8 + i - 1).padStart(2, '0')}:00`;
        const to = `${String(8 + i - 1).padStart(2, '0')}:45`;
        await c.query(
          `INSERT INTO period_definitions
             (tenant_id, template_id, period_no, label_bn, starts_at, ends_at, kind)
           VALUES ($1,$2,$3,$4,$5::time,$6::time,'teaching')`,
          [T, TPL, i, `${i} নম্বর`, from, to]);
      }
      await c.query(
        `INSERT INTO rooms (id, tenant_id, code, name_bn, capacity, capabilities, is_bookable)
         VALUES ($1,$2,'R-1','কক্ষ ১',60,'{}',true)`, [ROOM, T]);
    });

    // The neighbour, so §14 is a real question.
    await asBootstrap(db, headB, async (c) => {
      await c.query('DELETE FROM tenants WHERE id = $1', [T_B]);
      await c.query(
        `INSERT INTO tenants (id, slug, name_bn, name_en, stream, level)
         VALUES ($1,'p93-other','পাশের','Other','bangla_medium','secondary')`, [T_B]);
      await c.query(
        `INSERT INTO users (id, tenant_id, full_name_bn, full_name_en, phone_e164, status)
         VALUES ($1,$2,'অন্য প্রধান','Head B','+8801799930009','active')`, [HEAD_B, T_B]);
      await c.query(
        `INSERT INTO user_roles (tenant_id, user_id, role_code) VALUES ($1,$2,'principal')`,
        [T_B, HEAD_B]);
      await c.query(
        `INSERT INTO academic_years (id, tenant_id, label, starts_on, ends_on, is_current)
         VALUES ($1,$2,'2026','2026-01-01','2026-12-31',true)`, [YEAR_B, T_B]);
    });

    const { signAccessToken } = await import('../../../packages/server-core/src/jwt.ts');
    headToken = await signAccessToken({ sub: HEAD, tid: T, role: 'principal', roles: ['principal'] });
    headBToken = await signAccessToken({
      sub: HEAD_B, tid: T_B, role: 'principal', roles: ['principal'] });
    studentToken = await signAccessToken({
      sub: STUDENT, tid: T, role: 'student', roles: ['student'] });
    generate = (await import('../api/generate.ts')).default;
  });

  after(async () => {
    if (!db) return;
    for (const [ctx, id] of [[head, T], [headB, T_B]] as const) {
      await asBootstrap(db, ctx, (c) => c.query('DELETE FROM tenants WHERE id = $1', [id]));
    }
    await db.end(); await unlockFixtures();
  });

  /** Back to a school with assignments and no routine at all. */
  beforeEach(() => asBootstrap(db, head, async (c) => {
    await c.query('DELETE FROM routine_slots WHERE tenant_id = $1', [T]);
    await c.query('DELETE FROM routines WHERE tenant_id = $1', [T]);
    await c.query(
      `UPDATE section_subject_teachers SET ended_on = started_on, end_reason = 'reset'
        WHERE tenant_id = $1 AND ended_on IS NULL`, [T]);
    // Rafiq takes both subjects in ক, Salma both in খ — four assignments,
    // which is what `class_subjects × sections` requires.
    for (const [sec, teacher] of [[SEC_A, RAFIQ], [SEC_B, SALMA]] as const) {
      for (const sub of [BANGLA, MATHS]) {
        await c.query(
          `INSERT INTO section_subject_teachers
             (tenant_id, section_id, subject_id, teacher_id, academic_year_id, started_on)
           VALUES ($1,$2,$3,$4,$5,'2026-01-05')`, [T, sec, sub, teacher, YEAR]);
      }
    }
  }));

  test('THE ONE THAT MATTERS — Generate fills a real week and says so', async () => {
    const r = await run({ yearId: YEAR });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const b = r.body as { shifts: unknown[]; summary: Summary };

    // 2 sections × 2 subjects × 3 periods = 12.
    assert.equal(b.summary.totalDemand, 12);
    assert.equal(b.summary.placed, 12, JSON.stringify(b.summary));
    assert.equal(b.summary.unplacedPeriods, 0);
    assert.match(b.summary.verdictBn, /সব ১২টি পিরিয়ড বসানো হয়েছে/,
      'the first sentence a coordinator reads must be the answer');
    assert.equal(b.shifts.length, 1, 'one shift, one routine');

    // And the slots are really there, not merely counted.
    const { rows } = await asBootstrap(db, head, (c) => c.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM routine_slots
        WHERE tenant_id = $1 AND status <> 'removed'`, [T]));
    assert.equal(rows[0].n, '12');
  });

  test('HARD CONFLICTS ARE COUNTED, not assumed — and there are none', async () => {
    // §6. The solver reporting zero is not evidence, and neither is the
    // database: read the three EXCLUDE predicates and only the SECTION one
    // applies to a draft. Teacher and room are gated on
    // `routine_status = 'active'`, so a draft may hold either. This looks
    // for a teacher, a section or a room in two places at one time, in the
    // STORED rows.
    await run({ yearId: YEAR });
    const { rows } = await asBootstrap(db, head, (c) => c.query<{
      teacher: string; section: string; room: string;
    }>(
      `SELECT
         (SELECT count(*) FROM routine_slots a JOIN routine_slots b
            ON a.id < b.id AND a.teacher_id = b.teacher_id
           AND a.day_of_week = b.day_of_week AND a.time_range && b.time_range
           AND a.status <> 'removed' AND b.status <> 'removed'
          WHERE a.tenant_id = $1)::text AS teacher,
         (SELECT count(*) FROM routine_slots a JOIN routine_slots b
            ON a.id < b.id AND a.primary_section_id = b.primary_section_id
           AND a.day_of_week = b.day_of_week AND a.time_range && b.time_range
           AND a.status <> 'removed' AND b.status <> 'removed'
          WHERE a.tenant_id = $1)::text AS section,
         (SELECT count(*) FROM routine_slots a JOIN routine_slots b
            ON a.id < b.id AND a.room_id = b.room_id AND a.room_id IS NOT NULL
           AND a.day_of_week = b.day_of_week AND a.time_range && b.time_range
           AND a.status <> 'removed' AND b.status <> 'removed'
          WHERE a.tenant_id = $1)::text AS room`, [T]));
    assert.deepEqual(rows[0], { teacher: '0', section: '0', room: '0' });
    // And the endpoint's own number is the same one, measured the same way.
    const again = await run({ yearId: YEAR });
    assert.equal((again.body as { summary: Summary }).summary.hardConflicts, 0);
  });

  test('THE DETECTOR DETECTS — a conflict planted in the draft is reported', async () => {
    // A zero from a counter that can only return zero is worth nothing, and
    // this counter has no constraint standing behind it: `routine_status =
    // 'active'` keeps the teacher and room EXCLUDE constraints out of a
    // draft, which is precisely why the count exists. So plant one.
    //
    // The copy keeps the teacher, the room, the day and the hour and changes
    // only the section — one teacher in two places at once, which the
    // database accepts here and would refuse at publish.
    await run({ yearId: YEAR });

    // Free one hour in section খ first. The solver places both sections
    // identically — same days, same periods — so without this there is no
    // hour where খ is free while ক is teaching, and nowhere to plant.
    const freed = await asBootstrap(db, head, (c) => c.query<{
      day_of_week: number; period_no: number;
    }>(
      `DELETE FROM routine_slots
        WHERE id = (SELECT b.id FROM routine_slots b
                      JOIN routine_slots a
                        ON a.tenant_id = b.tenant_id AND a.primary_section_id = $3
                       AND a.day_of_week = b.day_of_week AND a.time_range && b.time_range
                       AND a.status = 'active'
                     WHERE b.tenant_id = $1 AND b.primary_section_id = $2
                       AND b.status = 'active' LIMIT 1)
        RETURNING day_of_week, period_no`,
      [T, SEC_B, SEC_A]));
    assert.equal(freed.rowCount, 1);

    const planted = await asBootstrap(db, head, (c) => c.query(
      `INSERT INTO routine_slots
         (tenant_id, routine_id, academic_year_id, day_of_week, period_no,
          period_definition_id, starts_at, ends_at, slot_kind,
          primary_section_id, subject_id, teacher_id, room_id)
       SELECT s.tenant_id, s.routine_id, s.academic_year_id, s.day_of_week,
              s.period_no, s.period_definition_id, s.starts_at, s.ends_at,
              s.slot_kind, $2, s.subject_id, s.teacher_id, s.room_id
         FROM routine_slots s
        WHERE s.tenant_id = $1 AND s.primary_section_id = $3 AND s.status = 'active'
          AND s.day_of_week = $4 AND s.period_no = $5
        LIMIT 1`,
      [T, SEC_B, SEC_A, freed.rows[0].day_of_week, freed.rows[0].period_no]));
    assert.equal(planted.rowCount, 1,
      'the draft accepted one teacher in two sections at the same hour');

    const r = await run({ yearId: YEAR });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const s = (r.body as { summary: Summary }).summary;
    assert.ok(s.hardConflicts > 0,
      `the planted conflict was not seen: ${JSON.stringify(s)}`);
    assert.match(s.verdictBn, /প্রকাশ করা যাবে না/,
      'and it must outrank "all periods placed" in the one sentence people read');
  });

  test('IDEMPOTENT — pressing Generate twice changes nothing', async () => {
    const first = await run({ yearId: YEAR });
    const a = (first.body as { summary: Summary; shifts: Array<{ created: boolean }> });
    assert.equal(a.shifts[0].created, true, 'the first run makes the draft');

    const second = await run({ yearId: YEAR });
    const b = (second.body as { summary: Summary; shifts: Array<{ created: boolean }> });
    assert.equal(b.shifts[0].created, false, 'the second must REUSE it, not version up');
    assert.equal(b.summary.placed, a.summary.placed);

    const { rows } = await asBootstrap(db, head, (c) => c.query<{
      routines: string; slots: string;
    }>(
      `SELECT (SELECT count(*) FROM routines WHERE tenant_id = $1)::text AS routines,
              (SELECT count(*) FROM routine_slots
                WHERE tenant_id = $1 AND status <> 'removed')::text AS slots`, [T]));
    assert.equal(rows[0].routines, '1', 'a second draft would leave nobody knowing which is real');
    assert.equal(rows[0].slots, '12', 'and the week must not be placed twice');
  });

  test('a run that DIED halfway is completed by the retry, not restarted', async () => {
    // §10's second half: "failed generation, then retry". A run that dies
    // partway leaves a routine with some of its week in it — that is the
    // state a coordinator presses Generate again from.
    //
    // The first attempt at this test removed half the ASSIGNMENTS instead,
    // and the readiness gate refused the run outright. It was right to: a
    // school with three of four subjects unassigned is not ready. The
    // half-finished state that actually occurs is half-finished SLOTS.
    await run({ yearId: YEAR });
    const wiped = await asBootstrap(db, head, (c) => c.query(
      `DELETE FROM routine_slots
        WHERE tenant_id = $1 AND primary_section_id = $2`, [T, SEC_B]));
    assert.equal(wiped.rowCount, 6, 'six of the twelve are gone, as a crash would leave them');

    const retried = await run({ yearId: YEAR });
    const b = retried.body as { summary: Summary; shifts: Array<{ created: boolean }> };
    assert.equal(b.shifts[0].created, false, 'the same draft, not a new version');
    assert.equal(b.summary.placed, 12, 'the retry must fill the gap');

    const { rows } = await asBootstrap(db, head, (c) => c.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM routine_slots
        WHERE tenant_id = $1 AND status <> 'removed'`, [T]));
    assert.equal(rows[0].n, '12', 'and place each period once, not twice');
  });

  test('the READINESS GATE holds server-side, before any routine is created', async () => {
    // A browser with a stale canGenerate must not be able to start a run.
    // Remove every room: the wizard calls that blocked.
    await asBootstrap(db, head, (c) => c.query(
      'UPDATE rooms SET is_bookable = false WHERE tenant_id = $1', [T]));
    const r = await run({ yearId: YEAR });
    assert.equal(r.status, 409);
    assert.equal((r.body as { error: string }).error, 'not_ready');
    assert.match((r.body as { message: string }).message, /কক্ষ/,
      'and it must name the step, not say "not ready"');

    const { rows } = await asBootstrap(db, head, (c) => c.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM routines WHERE tenant_id = $1', [T]));
    assert.equal(rows[0].n, '0', 'a refused run must not leave a draft routine behind');

    await asBootstrap(db, head, (c) => c.query(
      'UPDATE rooms SET is_bookable = true WHERE tenant_id = $1', [T]));
  });

  test('UNPLACED DEMAND names the class, the subject and the shortfall', async () => {
    // Five teaching periods a day × 5 teaching days = 25 slots per section,
    // but one teacher cannot be in two sections at once. Demand 6 periods of
    // each subject for both sections through ONE teacher forces a shortfall.
    await asBootstrap(db, head, async (c) => {
      await c.query(
        `UPDATE section_subject_teachers SET teacher_id = $2
          WHERE tenant_id = $1 AND ended_on IS NULL`, [T, RAFIQ]);
      await c.query(
        'UPDATE class_subjects SET periods_per_week = 20 WHERE tenant_id = $1', [T]);
    });
    const r = await run({ yearId: YEAR });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const b = r.body as { shifts: Array<{ unplaced: Array<Record<string, unknown>> }>;
                          summary: Summary };

    assert.ok(b.summary.unplacedPeriods > 0, 'this demand cannot fit — it must say so');
    assert.ok(b.shifts[0].unplaced.length > 0);
    const u = b.shifts[0].unplaced[0];
    // §7: the row must be readable without opening the database.
    for (const key of ['sectionName', 'subjectBn', 'required', 'placed', 'missing']) {
      assert.ok(key in u, `unplaced demand must carry ${key}: ${JSON.stringify(u)}`);
    }
    assert.equal((r.body as { summary: Summary }).summary.hardConflicts, 0,
      'a partial routine is still a legal one');

    await asBootstrap(db, head, (c) => c.query(
      'UPDATE class_subjects SET periods_per_week = 3 WHERE tenant_id = $1', [T]));
  });

  test('the result SURVIVES a refresh — it is not browser memory', async () => {
    await run({ yearId: YEAR });
    const g = await read(`yearId=${YEAR}`);
    assert.equal(g.status, 200);
    const runs = (g.body as { runs: Array<{ slots: number; shift: string; status: string }> }).runs;
    assert.equal(runs.length, 1);
    assert.equal(runs[0].slots, 12);
    assert.equal(runs[0].status, 'draft');
  });

  test('a STUDENT cannot generate, and cannot read the result', async () => {
    assert.equal((await run({ yearId: YEAR }, studentToken)).status, 403);
    assert.equal((await read(`yearId=${YEAR}`, studentToken)).status, 403);
  });

  test('TENANT ISOLATION — another school cannot generate into this one', async () => {
    await run({ yearId: YEAR });

    // The neighbour, holding this school's yearId, which is the shape a
    // copied URL or a leaked id takes.
    const cross = await run({ yearId: YEAR }, headBToken);
    assert.equal(cross.status, 409,
      `another school generated into this one’s academic year: ${JSON.stringify(cross.body)}`);
    // And it is refused as "your school is not ready", never as "that year
    // has 2 sections" — a refusal that counted OUR rows would be a leak
    // dressed as an error message.
    assert.equal((cross.body as { error: string }).error, 'not_ready');
    const { rows: theirs } = await asBootstrap(db, headB, (c) => c.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM routines WHERE tenant_id = $1', [T_B]));
    assert.equal(theirs[0].n, '0');

    const g = await read(`yearId=${YEAR}`, headBToken);
    assert.equal(g.status, 200, 'the endpoint answers about the CALLER’s school');
    assert.deepEqual((g.body as { runs: unknown[] }).runs, [],
      'and must show nothing of ours — RLS hides the routine entirely');

    // Ours is untouched.
    const mine = await read(`yearId=${YEAR}`);
    assert.equal((mine.body as { runs: unknown[] }).runs.length, 1);
  });

  test('timings are reported, and separated', async () => {
    // §9 asks for solver time and total time apart, so a slow result can be
    // attributed rather than guessed at.
    const r = await run({ yearId: YEAR });
    const s = (r.body as { summary: Summary }).summary;
    assert.equal(typeof s.solverSeconds, 'number');
    assert.equal(typeof s.totalSeconds, 'number');
    assert.ok(s.totalSeconds >= s.solverSeconds,
      'the total includes the solver plus the readiness check and the drafts');
  });
});

/**
 * §11 — a two-shift school, generated in ONE press.
 *
 * The defect this pins was found by `scripts/routine-benchmark.mjs`, not by
 * reasoning: an 80-section two-shift school came back with forty stored room
 * double-bookings and a summary that said zero. Three things had to line up.
 *
 *   The solver books against every ACTIVE routine in the year (F-506), and
 *   in a single institution-wide run neither shift is active yet — so the
 *   day shift could not see the morning shift.
 *
 *   The teacher and room EXCLUDE constraints are predicated on
 *   `routine_status = 'active'`, so the database accepted every one of them.
 *   That predicate is right — two rival drafts of one shift must not block
 *   each other — which is why the fix is in the caller, not the schema.
 *
 *   And the summary reported `hardConflicts: 0` as a constant.
 *
 * The school below is the smallest thing that reproduces it: the morning's
 * second period overlaps the day's first, and both shifts share the same two
 * classrooms, because that is what a two-shift school IS.
 */
const T2       = '7c930000-0000-4000-8000-0000000000c0';
const HEAD2    = '7c930000-0000-4000-8000-0000000000c2';
const YEAR2    = '7c930000-0000-4000-8000-0000000000c3';
const KLASS_M  = '7c930000-0000-4000-8000-0000000000c4';
const KLASS_D  = '7c930000-0000-4000-8000-0000000000c5';
const SUBJ_M   = '7c930000-0000-4000-8000-0000000000c6';
const SUBJ_D   = '7c930000-0000-4000-8000-0000000000c7';

describe('P9-3 §11 — two shifts sharing one building', { skip }, () => {
  let db2: Db;
  let token = '';
  let generate2: Parameters<typeof call>[0];
  const head2: TenantContext = { tenantId: T2, userId: HEAD2, role: 'principal' };

  before(async () => {
    await installTestKeys();
    await lockFixtures(DATABASE_URL as string);
    db2 = createDb(DATABASE_URL as string);

    await asBootstrap(db2, head2, async (c) => {
      await c.query('DELETE FROM tenants WHERE id = $1', [T2]);
      await c.query(
        `INSERT INTO tenants (id, slug, name_bn, name_en, stream, level, weekend_days)
         VALUES ($1,'p93-two','দুই শিফট','Two','bangla_medium','combined','{5,6}')`, [T2]);
      await c.query(
        `INSERT INTO users (id, tenant_id, full_name_bn, full_name_en, phone_e164, status)
         VALUES ($1,$2,'প্রধান','Head','+8801799931000','active')`, [HEAD2, T2]);
      await c.query(
        `INSERT INTO user_roles (tenant_id, user_id, role_code) VALUES ($1,$2,'principal')`,
        [T2, HEAD2]);
      await c.query(
        `INSERT INTO academic_years (id, tenant_id, label, starts_on, ends_on, is_current)
         VALUES ($1,$2,'2026','2026-01-01','2026-12-31',true)`, [YEAR2, T2]);

      // TWO classrooms, used by both shifts. This is the whole point.
      const rooms: string[] = [];
      for (const code of ['R-1', 'R-2']) {
        const { rows } = await c.query<{ id: string }>(
          `INSERT INTO rooms (tenant_id, code, name_bn, capacity, capabilities, is_bookable)
           VALUES ($1,$2,$2,50,'{}',true) RETURNING id`, [T2, code]);
        rooms.push(rows[0].id);
      }

      // The handover overlaps: morning period 2 runs 08:45-09:30 and the
      // day's first period starts at 09:00. Schools really do this.
      const bells: Record<string, ReadonlyArray<readonly [string, string]>> = {
        morning: [['08:00', '08:45'], ['08:45', '09:30']],
        day: [['09:00', '09:45'], ['09:45', '10:30']],
      };
      for (const shift of ['morning', 'day']) {
        const { rows: tpl } = await c.query<{ id: string }>(
          `INSERT INTO period_templates (tenant_id, name_bn, shift, effective_from, is_active)
           VALUES ($1,$2,$3::shift_code,'2026-01-01',true) RETURNING id`,
          [T2, shift, shift]);
        let n = 0;
        for (const [from, to] of bells[shift]) {
          await c.query(
            `INSERT INTO period_definitions
               (tenant_id, template_id, period_no, label_bn, starts_at, ends_at, kind)
             VALUES ($1,$2,$3,$4,$5::time,$6::time,'teaching')`,
            [T2, tpl[0].id, ++n, String(n), from, to]);
        }
      }

      // One class per shift, two sections each, and a separate teacher for
      // every section — so the only thing they can fight over is a room.
      const plan = [
        { klass: KLASS_M, shift: 'morning', subject: SUBJ_M, level: 5,
          subjectBn: 'সকালের বিষয়', ppw: 10 },
        { klass: KLASS_D, shift: 'day', subject: SUBJ_D, level: 8,
          subjectBn: 'দিনের বিষয়', ppw: 10 },
      ];
      let teacherSerial = 0;
      for (const p of plan) {
        await c.query(
          `INSERT INTO classes (id, tenant_id, level_no, name_bn, name_en, stream)
           VALUES ($1,$2,$3,$4,'C','bangla_medium')`, [p.klass, T2, p.level, p.subjectBn]);
        await c.query(
          `INSERT INTO subjects (id, tenant_id, name_bn, name_en, short_name)
           VALUES ($1,$2,$3,'S',substr($3,1,3))`, [p.subject, T2, p.subjectBn]);
        await c.query(
          `INSERT INTO class_subjects
             (tenant_id, class_id, subject_id, academic_year_id, periods_per_week)
           VALUES ($1,$2,$3,$4,$5)`, [T2, p.klass, p.subject, YEAR2, p.ppw]);

        for (let i = 0; i < 2; i++) {
          const { rows: sec } = await c.query<{ id: string }>(
            `INSERT INTO sections (tenant_id, class_id, academic_year_id, name, shift,
                                   student_count, home_room_id)
             VALUES ($1,$2,$3,$4,$5::shift_code,40,$6) RETURNING id`,
            [T2, p.klass, YEAR2, ['ক', 'খ'][i], p.shift, rooms[i]]);
          const { rows: t } = await c.query<{ id: string }>(
            `INSERT INTO users (tenant_id, full_name_bn, full_name_en, phone_e164, status)
             VALUES ($1,$2,'T',$3,'active') RETURNING id`,
            [T2, `শিক্ষক ${++teacherSerial}`, `+880179993${1000 + teacherSerial}`]);
          await c.query(
            `INSERT INTO user_roles (tenant_id, user_id, role_code)
             VALUES ($1,$2,'subject_teacher')`, [T2, t[0].id]);
          await c.query(
            `INSERT INTO section_subject_teachers
               (tenant_id, section_id, subject_id, teacher_id, academic_year_id, started_on)
             VALUES ($1,$2,$3,$4,$5,'2026-01-01')`,
            [T2, sec[0].id, p.subject, t[0].id, YEAR2]);
        }
      }
    });

    const { signAccessToken } = await import('../../../packages/server-core/src/jwt.ts');
    token = await signAccessToken({
      sub: HEAD2, tid: T2, role: 'principal', roles: ['principal'] });
    generate2 = (await import('../api/generate.ts')).default;
  });

  after(async () => {
    if (!db2) return;
    await asBootstrap(db2, head2, (c) => c.query('DELETE FROM tenants WHERE id = $1', [T2]));
    await db2.end();
    await unlockFixtures();
  });

  test('THE REGRESSION — one press, two shifts, and no room booked twice', async () => {
    const r = await call(generate2,
      { method: 'POST', url: '/', token, body: { yearId: YEAR2 } } as Parameters<typeof call>[1]);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const b = r.body as unknown as { shifts: Array<{ shift: string }>; summary: Summary };

    assert.deepEqual(b.shifts.map((s) => s.shift).sort(), ['day', 'morning'],
      'one press must produce a routine for every shift the school runs');
    assert.equal(b.summary.hardConflicts, 0,
      `the two drafts collided: ${JSON.stringify(b.summary)}`);

    // Asked of the stored rows, across BOTH routines, with the exclusion
    // constraints' own predicates — minus the `routine_status = 'active'`
    // clause that is exactly why they did not fire.
    const { rows } = await asBootstrap(db2, head2, (c) => c.query<{ n: string }>(
      `SELECT count(*)::text AS n
         FROM routine_slots a JOIN routine_slots b
           ON a.id < b.id AND a.day_of_week = b.day_of_week
          AND a.time_range && b.time_range
          AND (a.teacher_id = b.teacher_id
               OR (a.room_id = b.room_id AND a.room_id IS NOT NULL))
        WHERE a.tenant_id = $1 AND a.status = 'active' AND b.status = 'active'`, [T2]));
    assert.equal(rows[0].n, '0', 'a room cannot hold two classes at 09:15');
  });

  test('the MORNING shift is solved first — the clock decides, not the alphabet', async () => {
    // Whoever is solved first wins a contended room, so the order is a
    // scheduling decision and belongs to the school day. `shift_code` is
    // declared morning, day, evening, single; sorting the enum's TEXT put
    // 'day' first and took the morning shift's last period away for a shift
    // that had not started yet.
    //
    // Two rooms serve four sections here and the handover overlaps, so one
    // shift must lose periods. It has to be the later one, and the loss has
    // to be visible rather than resolved by double-booking the room.
    const r = await call(generate2,
      { method: 'GET', url: `/?yearId=${YEAR2}`, token } as Parameters<typeof call>[1]);
    assert.equal(r.status, 200);
    const runs = (r.body as unknown as {
      runs: Array<{ shift: string; slots: number }> }).runs;
    assert.equal(runs.length, 2);
    const day = runs.find((x) => x.shift === 'day');
    const morning = runs.find((x) => x.shift === 'morning');
    assert.ok(morning && day, JSON.stringify(runs));
    assert.equal(morning.slots, 20, 'the morning shift fills its whole week');
    assert.equal(day.slots, 10,
      `the day shift loses the periods that overlap it: ${JSON.stringify(runs)}`);
  });
});
