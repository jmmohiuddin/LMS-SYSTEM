/**
 * B-108 — replacing a routine that is already live.
 *
 * Two defects, and until both were fixed a school that published once could
 * never publish again:
 *
 *   1. THE SOLVER COUNTED THE PREDECESSOR. `loadExistingSlots` gathered every
 *      ACTIVE routine for the year, on the assumption — written in its own
 *      comment — that the only other active routine is the other shift. A
 *      school that publishes and then regenerates has another one for the
 *      SAME shift, so the solver believed every teacher and room in the
 *      building was taken, by the timetable being replaced. Measured: 560
 *      placed in v1, 193 in v2, 125 of 129 unplaced reading `no_free_slot`.
 *
 *   2. THE REPLACEMENT COULD NOT BE PUBLISHED. `uq_routine_active` allows one
 *      active routine per (tenant, year, shift), and nothing in the product
 *      had ever written `supersedes_id` or the `superseded` status — the live
 *      database held 0 of each. Publishing v2 answered "একটি রুটিন ইতিমধ্যে
 *      চালু আছে — আগে সেটি বদলান" with nothing that could change it.
 *
 * The database was never the blocker and says so in its own constraint
 * comment: "a draft may still overlap the routine it will replace". The test
 * below proves that by hand rather than trusting it.
 *
 *   DATABASE_URL=postgres://shikhon_app:… \
 *     node --test services/rms-svc/test/replacement.test.ts
 */
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { createDb, type Db, type TenantContext } from '../../../packages/server-core/src/db.ts';
import {
  installTestKeys, call, lockFixtures, unlockFixtures, asBootstrap,
} from '../../../packages/server-core/test/harness.ts';

const DATABASE_URL = process.env.DATABASE_URL;
const skip = !DATABASE_URL ? 'DATABASE_URL not set' : false;

const T        = '7c980000-0000-4000-8000-0000000000a0';
const HEAD     = '7c980000-0000-4000-8000-0000000000a1';
const RAFIQ    = '7c980000-0000-4000-8000-0000000000a2';
const SALMA    = '7c980000-0000-4000-8000-0000000000a3';
const STUDENT  = '7c980000-0000-4000-8000-0000000000a4';
const GUARDIAN = '7c980000-0000-4000-8000-0000000000a5';
const YEAR     = '7c980000-0000-4000-8000-0000000000c1';
const KLASS    = '7c980000-0000-4000-8000-0000000000d1';
const SEC_A    = '7c980000-0000-4000-8000-0000000000e1';
const SEC_B    = '7c980000-0000-4000-8000-0000000000e2';
const BANGLA   = '7c980000-0000-4000-8000-0000000000f1';
const MATHS    = '7c980000-0000-4000-8000-0000000000f2';
const TPL      = '7c980000-0000-4000-8000-00000000ab01';
const ROOM_A   = '7c980000-0000-4000-8000-00000000ab02';
const ROOM_B   = '7c980000-0000-4000-8000-00000000ab04';

const T_B      = '7c980000-0000-4000-8000-0000000000b0';
const HEAD_B   = '7c980000-0000-4000-8000-0000000000b1';

let db: Db;
let headToken = '', headBToken = '', studentToken = '', guardianToken = '', teacherToken = '';
let generate: Parameters<typeof call>[0];
let publish: Parameters<typeof call>[0];
let editor: Parameters<typeof call>[0];
let resolve: Parameters<typeof call>[0];

const head: TenantContext = { tenantId: T, userId: HEAD, role: 'principal' };
const headB: TenantContext = { tenantId: T_B, userId: HEAD_B, role: 'principal' };

const post = (h: Parameters<typeof call>[0], body: unknown, token = headToken) =>
  call(h, { method: 'POST', url: '/', token, body } as Parameters<typeof call>[1]);

interface Row { id: string; version: number; status: string; generated_by: string }

const routines = async (): Promise<Row[]> => {
  const { rows } = await asBootstrap(db, head, (c) => c.query<Row>(
    `SELECT id, version, status::text AS status, generated_by
       FROM routines WHERE tenant_id = $1 ORDER BY version`, [T]));
  return rows;
};
const live = async () => (await routines()).find((r) => r.status === 'active') ?? null;
const draft = async () => (await routines()).filter((r) => r.status === 'draft').at(-1) ?? null;

const slotCount = async (routineId: string) => {
  const { rows } = await asBootstrap(db, head, (c) => c.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM routine_slots
      WHERE routine_id = $1 AND status = 'active'`, [routineId]));
  return rows[0].n;
};

/** What the SCHOOL is reading — the version, through the live join. */
const consumersRead = async () => {
  const { rows } = await asBootstrap(db, head, (c) => c.query<{ version: number; n: number }>(
    `SELECT r.version, count(*)::int AS n
       FROM routine_slots s JOIN routines r ON r.id = s.routine_id
      WHERE r.tenant_id = $1 AND r.status = 'active'
        AND s.status = 'active' AND s.routine_status = 'active'
      GROUP BY r.version`, [T]));
  return rows[0] ?? null;
};

/** §12, independent of the solver: does this routine hold any clash at all? */
const clashes = async (routineId: string) => {
  const { rows } = await asBootstrap(db, head, (c) => c.query<{
    teacher: number; room: number; section: number; bad_room: number; unavailable: number;
  }>(
    `WITH mine AS (SELECT * FROM routine_slots
                    WHERE routine_id = $1 AND status = 'active')
     SELECT
       (SELECT count(*)::int FROM mine a JOIN mine b ON b.id <> a.id
          AND b.day_of_week = a.day_of_week AND b.teacher_id = a.teacher_id
          AND b.starts_at < a.ends_at AND b.ends_at > a.starts_at) AS teacher,
       (SELECT count(*)::int FROM mine a JOIN mine b ON b.id <> a.id
          AND b.day_of_week = a.day_of_week AND b.room_id = a.room_id
          AND b.starts_at < a.ends_at AND b.ends_at > a.starts_at) AS room,
       (SELECT count(*)::int FROM mine a JOIN mine b ON b.id <> a.id
          AND b.day_of_week = a.day_of_week
          AND b.primary_section_id = a.primary_section_id
          AND a.parallel_pool IS NULL AND b.parallel_pool IS NULL
          AND b.starts_at < a.ends_at AND b.ends_at > a.starts_at) AS section,
       (SELECT count(*)::int FROM mine s
          LEFT JOIN subjects sub ON sub.id = s.subject_id
          LEFT JOIN rooms rm ON rm.id = s.room_id
         WHERE sub.requires_capability IS NOT NULL
           AND sub.requires_capability <> ''
           AND NOT (sub.requires_capability
                    = ANY(COALESCE(rm.capabilities, '{}')))) AS bad_room,
       (SELECT count(*)::int FROM mine s
          JOIN teacher_availability ta ON ta.teacher_id = s.teacher_id
           AND ta.kind = 'unavailable' AND ta.day_of_week = s.day_of_week
           AND ta.starts_at < s.ends_at AND ta.ends_at > s.starts_at) AS unavailable`,
    [routineId]));
  return rows[0];
};

/** Generate, then publish, the first version. Every test starts here. */
const publishV1 = async () => {
  const g = await post(generate, { yearId: YEAR });
  assert.equal(g.status, 200, JSON.stringify(g.body));
  const v1 = (await routines())[0];
  const p = await post(publish, {
    action: 'publish', routineId: v1.id, confirmWarnings: true });
  assert.equal(p.status, 200, JSON.stringify(p.body));
  return v1;
};

describe('B-108 — replacing a live routine', { skip }, () => {
  before(async () => {
    await installTestKeys();
    await lockFixtures(DATABASE_URL as string);
    db = createDb(DATABASE_URL as string);

    await asBootstrap(db, head, async (c) => {
      await c.query('DELETE FROM tenants WHERE id = $1', [T]);
      await c.query(
        `INSERT INTO tenants (id, slug, name_bn, name_en, stream, level, weekend_days)
         VALUES ($1,'b108','বি১০৮ বিদ্যালয়','B108','bangla_medium','secondary','{5,6}')`, [T]);
      for (const [id, bn, phone, role] of [
        [HEAD, 'প্রধান শিক্ষক', '+8801799980001', 'principal'],
        [RAFIQ, 'রফিক স্যার', '+8801799980002', 'subject_teacher'],
        [SALMA, 'সালমা ম্যাডাম', '+8801799980003', 'subject_teacher'],
        [STUDENT, 'ছাত্র', '+8801799980004', 'student'],
        [GUARDIAN, 'অভিভাবক', '+8801799980005', 'guardian'],
      ] as const) {
        await c.query(
          `INSERT INTO users (id, tenant_id, full_name_bn, full_name_en, phone_e164, status)
           VALUES ($1,$2,$3,'X',$4,'active')`, [id, T, bn, phone]);
        await c.query(
          `INSERT INTO user_roles (tenant_id, user_id, role_code) VALUES ($1,$2,$3)`,
          [T, id, role]);
      }
      await c.query(
        `INSERT INTO academic_years (id, tenant_id, label, starts_on, ends_on, is_current)
         VALUES ($1,$2,'2026','2026-01-01','2026-12-31',true)`, [YEAR, T]);
      await c.query(
        `INSERT INTO classes (id, tenant_id, level_no, name_bn, name_en, stream)
         VALUES ($1,$2,9,'নবম','Nine','bangla_medium')`, [KLASS, T]);
      for (const [id, code] of [[ROOM_A, 'R-1'], [ROOM_B, 'R-2']] as const) {
        await c.query(
          `INSERT INTO rooms (id, tenant_id, code, name_bn, capacity, capabilities, is_bookable)
           VALUES ($1,$2,$3,$3,60,'{}',true)`, [id, T, code]);
      }
      for (const [id, name] of [[SEC_A, 'ক'], [SEC_B, 'খ']] as const) {
        await c.query(
          `INSERT INTO sections (id, tenant_id, class_id, academic_year_id, name,
                                 student_count, shift, home_room_id)
           VALUES ($1,$2,$3,$4,$5,40,'single',$6)`,
          [id, T, KLASS, YEAR, name, id === SEC_A ? ROOM_A : ROOM_B]);
      }
      for (const [id, nameBn] of [[BANGLA, 'বাংলা'], [MATHS, 'গণিত']] as const) {
        await c.query(
          `INSERT INTO subjects (id, tenant_id, name_bn, name_en, short_name)
           VALUES ($1,$2,$3,'S',substr($3,1,3))`, [id, T, nameBn]);
        await c.query(
          `INSERT INTO class_subjects
             (tenant_id, class_id, subject_id, academic_year_id, periods_per_week)
           VALUES ($1,$2,$3,$4,3)`, [T, KLASS, id, YEAR]);
      }
      for (const sec of [SEC_A, SEC_B]) {
        await c.query(
          `INSERT INTO section_subject_teachers
             (tenant_id, section_id, subject_id, teacher_id, academic_year_id, started_on)
           VALUES ($1,$2,$3,$4,$5,'2026-01-05'), ($1,$2,$6,$7,$5,'2026-01-05')`,
          [T, sec, BANGLA, RAFIQ, YEAR, MATHS, SALMA]);
      }
      await c.query(
        `INSERT INTO period_templates (id, tenant_id, name_bn, shift, effective_from, is_active)
         VALUES ($1,$2,'নিয়মিত','single','2026-01-01',true)`, [TPL, T]);
      for (let i = 1; i <= 6; i++) {
        await c.query(
          `INSERT INTO period_definitions
             (tenant_id, template_id, period_no, label_bn, starts_at, ends_at, kind)
           VALUES ($1,$2,$3,$4,$5::time,$6::time,'teaching')`,
          [T, TPL, i, `${i} নম্বর`,
           `${String(8 + i).padStart(2, '0')}:00`, `${String(8 + i).padStart(2, '0')}:45`]);
      }
    });

    await asBootstrap(db, headB, async (c) => {
      await c.query('DELETE FROM tenants WHERE id = $1', [T_B]);
      await c.query(
        `INSERT INTO tenants (id, slug, name_bn, name_en, stream, level)
         VALUES ($1,'b108-other','পাশের','Other','bangla_medium','secondary')`, [T_B]);
      await c.query(
        `INSERT INTO users (id, tenant_id, full_name_bn, full_name_en, phone_e164, status)
         VALUES ($1,$2,'অন্য','B','+8801799980009','active')`, [HEAD_B, T_B]);
      await c.query(
        `INSERT INTO user_roles (tenant_id, user_id, role_code) VALUES ($1,$2,'principal')`,
        [T_B, HEAD_B]);
    });

    const { signAccessToken } = await import('../../../packages/server-core/src/jwt.ts');
    headToken = await signAccessToken({ sub: HEAD, tid: T, role: 'principal', roles: ['principal'] });
    headBToken = await signAccessToken({ sub: HEAD_B, tid: T_B, role: 'principal', roles: ['principal'] });
    studentToken = await signAccessToken({ sub: STUDENT, tid: T, role: 'student', roles: ['student'] });
    guardianToken = await signAccessToken({ sub: GUARDIAN, tid: T, role: 'guardian', roles: ['guardian'] });
    teacherToken = await signAccessToken({
      sub: RAFIQ, tid: T, role: 'subject_teacher', roles: ['subject_teacher'] });
    generate = (await import('../api/generate.ts')).default;
    publish = (await import('../api/publish.ts')).default;
    editor = (await import('../api/editor.ts')).default;
    resolve = (await import('../api/resolve.ts')).default;
  });

  after(async () => {
    if (!db) return;
    for (const [ctx, id] of [[head, T], [headB, T_B]] as const) {
      await asBootstrap(db, ctx, (c) => c.query('DELETE FROM tenants WHERE id = $1', [id]));
    }
    await db.end();
    await unlockFixtures();
  });

  beforeEach(async () => {
    await asBootstrap(db, head, async (c) => {
      await c.query(
        `UPDATE routine_edit_log SET undone_at = now()
          WHERE tenant_id = $1 AND undone_at IS NULL`, [T]);
      await c.query('DELETE FROM routine_slots WHERE tenant_id = $1', [T]);
      await c.query('DELETE FROM routines WHERE tenant_id = $1', [T]);
      await c.query(
        `UPDATE class_subjects SET periods_per_week = 3 WHERE tenant_id = $1`, [T]);
    });
  });

  /* ─────────────────────── the root cause ──────────────────────────────── */

  test('THE ONE THAT MATTERS — a replacement fills as completely as the original', async () => {
    const v1 = await publishV1();
    const filled = await slotCount(v1.id);
    assert.ok(filled > 0, 'the fixture must actually have a timetable');

    const g = await post(generate, { yearId: YEAR });
    assert.equal(g.status, 200, JSON.stringify(g.body));
    const v2 = await draft();
    assert.ok(v2, 'a replacement draft was created');
    assert.equal(v2.version, 2);

    // The defect: v2 came back a fraction of v1 because the solver counted
    // v1's teachers and rooms as taken.
    assert.equal(await slotCount(v2.id), filled,
      'the replacement must not be starved by the routine it replaces');

    const reasons = (g.body as { shifts?: Array<{ unplaced: Array<{ reason: string }> }> })
      .shifts?.[0]?.unplaced.map((u) => u.reason) ?? [];
    assert.equal(reasons.filter((r) => r === 'no_free_slot').length, 0,
      `nothing should be unplaceable for want of a free hour: ${JSON.stringify(reasons)}`);
  });

  test('the database never blocked this — the constraints are innocent', async () => {
    // The teacher and room exclusions are `WHERE routine_status = 'active'`,
    // and their comment says "a draft may still overlap the routine it will
    // replace". Proved rather than trusted: the same teacher AND the same
    // room, at the same hour, in a draft beside the live routine.
    const v1 = await publishV1();
    const { rows: busy } = await asBootstrap(db, head, (c) => c.query<{
      day_of_week: number; period_no: number; period_definition_id: string;
      starts_at: string; ends_at: string; primary_section_id: string;
      subject_id: string; teacher_id: string; room_id: string;
    }>(
      `SELECT day_of_week, period_no, period_definition_id,
              starts_at::text, ends_at::text, primary_section_id, subject_id,
              teacher_id, room_id
         FROM routine_slots
        WHERE routine_id = $1 AND status = 'active' AND room_id IS NOT NULL
        LIMIT 1`, [v1.id]));
    const b = busy[0];
    assert.ok(b);

    const { rows: bare } = await asBootstrap(db, head, (c) => c.query<{ id: string }>(
      `INSERT INTO routines (tenant_id, academic_year_id, period_template_id, shift,
                             name_bn, version, effective_from, generated_by, created_by)
       VALUES ($1,$2,$3,'single','সংঘর্ষ পরীক্ষা',99,'2026-01-01','solver',$4)
       RETURNING id`, [T, YEAR, TPL, HEAD]));

    await asBootstrap(db, head, (c) => c.query(
      `INSERT INTO routine_slots
         (tenant_id, routine_id, academic_year_id, day_of_week, period_no,
          period_definition_id, starts_at, ends_at, slot_kind,
          primary_section_id, subject_id, teacher_id, room_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7::time,$8::time,'teaching',$9,$10,$11,$12)`,
      [T, bare[0].id, YEAR, b.day_of_week, b.period_no, b.period_definition_id,
       b.starts_at, b.ends_at, b.primary_section_id, b.subject_id,
       b.teacher_id, b.room_id]));
    // Reaching here IS the assertion: the insert did not raise 23P01.
    await asBootstrap(db, head, (c) => c.query(
      'DELETE FROM routines WHERE id = $1', [bare[0].id]));
  });

  test('another SHIFT is still competition — only the predecessor is exempt', async () => {
    // The shift test is the whole fix, and it would be wrong in the other
    // direction too: exempting every active routine would let a two-shift
    // school book one teacher in both halves of the day.
    const v1 = await publishV1();
    const { rows } = await asBootstrap(db, head, (c) => c.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM routines
        WHERE academic_year_id = $1 AND status = 'active'
          AND shift <> (SELECT shift FROM routines WHERE id = $2)`, [YEAR, v1.id]));
    assert.equal(rows[0].n, 0, 'this fixture is single-shift, by construction');
    // Cross-shift protection has its own suite (solve-cross-shift.test.ts);
    // what matters here is that the predicate names a SHIFT and not merely
    // "any active routine", which the query text is asserted for below.
    const src = await import('node:fs').then((fs) => fs.promises.readFile(
      new URL('../src/solve.ts', import.meta.url), 'utf8'));
    assert.match(src, /rs\.routine_status = 'active' AND r\.shift <> \$4::shift_code/,
      'the exemption must be scoped to this routine’s own shift');
  });

  /* ─────────────────── §2 / §5 the two baselines ──────────────────────── */

  test('§5 — the clone carries pinned lessons, unchanged and still pinned', async () => {
    const v1 = await publishV1();
    const { rows: pinned } = await asBootstrap(db, head, (c) => c.query<{
      day_of_week: number; period_no: number; teacher_id: string;
      primary_section_id: string; subject_id: string;
    }>(
      `UPDATE routine_slots SET is_pinned = true
        WHERE id IN (SELECT id FROM routine_slots
                      WHERE routine_id = $1 AND status = 'active' LIMIT 2)
       RETURNING day_of_week, period_no, teacher_id, primary_section_id, subject_id`,
      [v1.id]));
    assert.equal(pinned.length, 2);

    const g = await post(generate, { yearId: YEAR, baseline: 'current' });
    assert.equal(g.status, 200, JSON.stringify(g.body));
    const v2 = await draft();
    assert.ok(v2);
    assert.equal(v2.generated_by, 'copied',
      'the provenance must survive the solver’s own top-up write');

    const { rows: after } = await asBootstrap(db, head, (c) => c.query<{
      day_of_week: number; period_no: number; teacher_id: string;
      primary_section_id: string; subject_id: string;
    }>(
      `SELECT day_of_week, period_no, teacher_id, primary_section_id, subject_id
         FROM routine_slots
        WHERE routine_id = $1 AND status = 'active' AND is_pinned`, [v2.id]));
    const key = (r: typeof after[number]) =>
      `${r.day_of_week}|${r.period_no}|${r.teacher_id}|${r.primary_section_id}|${r.subject_id}`;
    assert.deepEqual(after.map(key).sort(), pinned.map(key).sort(),
      'a coordinator’s pinned decisions must not be lost in a replacement');

    const shift = (g.body as { shifts?: Array<{ copiedFromVersion: number; copiedSlots: number }> })
      .shifts?.[0];
    assert.equal(shift?.copiedFromVersion, 1, 'the screen is told what it copied');
    assert.equal(shift?.copiedSlots, await slotCount(v1.id));
  });

  test('the two baselines are genuinely different, and the default is the old one', async () => {
    const v1 = await publishV1();
    await asBootstrap(db, head, (c) => c.query(
      `UPDATE routine_slots SET is_pinned = true
        WHERE id = (SELECT id FROM routine_slots
                     WHERE routine_id = $1 AND status = 'active' LIMIT 1)`, [v1.id]));

    // 'inputs' — no baseline named, which is what every caller before B-108
    // sent and must keep meaning what it always did.
    const fresh = await post(generate, { yearId: YEAR });
    assert.equal(fresh.status, 200);
    const v2 = await draft();
    assert.ok(v2);
    assert.equal(v2.generated_by, 'solver');
    const { rows: p } = await asBootstrap(db, head, (c) => c.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM routine_slots
        WHERE routine_id = $1 AND status = 'active' AND is_pinned`, [v2.id]));
    assert.equal(p[0].n, 0, 'a fresh draft is built from demand, not from v1');
    assert.equal((fresh.body as { shifts?: Array<{ copiedFromVersion: number | null }> })
      .shifts?.[0]?.copiedFromVersion, null);
  });

  test('a typo in the baseline is refused rather than silently picking one', async () => {
    await publishV1();
    const r = await post(generate, { yearId: YEAR, baseline: 'currrent' });
    assert.equal(r.status, 400);
    assert.equal((r.body as { error?: string }).error, 'invalid_baseline');
  });

  test('cloning is refused when the bell schedule has changed underneath it', async () => {
    // A copied slot points at a period_definition_id. On a new template those
    // ids belong to the old one, and the copy would look right while placing
    // every lesson at the previous timetable's clock times.
    const v1 = await publishV1();
    void v1;
    await asBootstrap(db, head, async (c) => {
      await c.query(`UPDATE period_templates SET is_active = false WHERE id = $1`, [TPL]);
      const t2 = '7c980000-0000-4000-8000-00000000ab09';
      await c.query(
        `INSERT INTO period_templates (id, tenant_id, name_bn, shift, effective_from, is_active)
         VALUES ($1,$2,'নতুন ঘণ্টা','single','2026-06-01',true)`, [t2, T]);
      for (let i = 1; i <= 6; i++) {
        await c.query(
          `INSERT INTO period_definitions
             (tenant_id, template_id, period_no, label_bn, starts_at, ends_at, kind)
           VALUES ($1,$2,$3,$4,$5::time,$6::time,'teaching')`,
          [T, t2, i, `${i} নম্বর`,
           `${String(9 + i).padStart(2, '0')}:10`, `${String(9 + i).padStart(2, '0')}:55`]);
      }
    });
    const r = await post(generate, { yearId: YEAR, baseline: 'current' });
    assert.equal(r.status, 409, JSON.stringify(r.body));
    assert.equal((r.body as { error?: string }).error, 'period_template_changed');

    // Drafts created against the new template hold a FK to it, so they go
    // first — `beforeEach` would clear them, but not before this DELETE runs.
    await asBootstrap(db, head, async (c) => {
      await c.query('DELETE FROM routine_slots WHERE tenant_id = $1', [T]);
      await c.query('DELETE FROM routines WHERE tenant_id = $1', [T]);
      await c.query(`DELETE FROM period_definitions WHERE tenant_id = $1
                       AND template_id <> $2`, [T, TPL]);
      await c.query(`DELETE FROM period_templates WHERE id <> $1 AND tenant_id = $2`, [TPL, T]);
      await c.query(`UPDATE period_templates SET is_active = true WHERE id = $1`, [TPL]);
    });
  });

  /* ─────────────────── §3 / §8 the swap ───────────────────────────────── */

  test('§3 — the school keeps reading v1 for as long as v2 is a draft', async () => {
    await publishV1();
    const before = await consumersRead();
    assert.equal(before?.version, 1);

    await post(generate, { yearId: YEAR, baseline: 'current' });
    assert.deepEqual(await consumersRead(), before,
      'creating a replacement must not change one lesson of the live timetable');

    // Edit it, re-solve part of it — still nothing moves for the school.
    const v2 = await draft();
    assert.ok(v2);
    const { rows: s } = await asBootstrap(db, head, (c) => c.query<{
      id: string; v: number; sec: string }>(
      `SELECT id, row_version AS v, primary_section_id AS sec FROM routine_slots
        WHERE routine_id = $1 AND status = 'active' AND NOT is_pinned LIMIT 1`, [v2.id]));
    assert.equal((await post(editor, {
      action: 'remove', slotId: s[0].id, rowVersion: s[0].v })).status, 200);
    assert.equal((await post(resolve, {
      routineId: v2.id, scope: { kind: 'section', sectionId: s[0].sec } })).status, 200);
    assert.deepEqual(await consumersRead(), before, 'still v1, still intact');
  });

  test('§8 — publishing the replacement swaps both sides, in one transaction', async () => {
    const v1 = await publishV1();
    await post(generate, { yearId: YEAR, baseline: 'current' });
    const v2 = await draft();
    assert.ok(v2);

    const p = await post(publish, {
      action: 'publish', routineId: v2.id, confirmWarnings: true });
    assert.equal(p.status, 200, JSON.stringify(p.body));
    assert.equal((p.body as { supersededVersion?: number }).supersededVersion, 1);

    const rows = await routines();
    const old = rows.find((r) => r.version === 1);
    const now = rows.find((r) => r.version === 2);
    assert.equal(old?.status, 'superseded', 'the predecessor steps down');
    assert.equal(now?.status, 'active', 'and the replacement takes over');
    assert.equal((await consumersRead())?.version, 2, 'the school reads the new one');

    const { rows: sup } = await asBootstrap(db, head, (c) => c.query<{
      supersedes: string | null; ended: boolean }>(
      `SELECT supersedes_id AS supersedes, effective_to IS NOT NULL AS ended
         FROM routines WHERE id = $1`, [v2.id]));
    assert.equal(sup[0].supersedes, v1.id, 'and the record says what it replaced');

    // Every slot moved with it, not most of them.
    const { rows: prop } = await asBootstrap(db, head, (c) => c.query<{
      live: number; retired: number }>(
      `SELECT count(*) FILTER (WHERE routine_status = 'active')::int AS live,
              count(*) FILTER (WHERE routine_status = 'superseded')::int AS retired
         FROM routine_slots WHERE tenant_id = $1 AND status = 'active'`, [T]));
    assert.equal(prop[0].live, await slotCount(v2.id));
    assert.equal(prop[0].retired, await slotCount(v1.id));
  });

  test('a failed publish leaves the old routine live and whole', async () => {
    const v1 = await publishV1();
    await post(generate, { yearId: YEAR, baseline: 'current' });
    const v2 = await draft();
    assert.ok(v2);
    // Give the replacement a conflict it cannot go live with.
    await asBootstrap(db, head, (c) => c.query(
      `UPDATE routine_slots b SET teacher_id = a.teacher_id
         FROM routine_slots a
        WHERE a.routine_id = $1 AND b.routine_id = $1 AND a.id <> b.id
          AND a.day_of_week = b.day_of_week AND a.starts_at = b.starts_at
          AND a.teacher_id IS DISTINCT FROM b.teacher_id
          AND b.id = (SELECT b2.id FROM routine_slots b2
                       WHERE b2.routine_id = $1 AND b2.status = 'active' LIMIT 1)`,
      [v2.id]));

    const p = await post(publish, {
      action: 'publish', routineId: v2.id, confirmWarnings: true });
    assert.equal(p.status, 409, JSON.stringify(p.body));

    const rows = await routines();
    assert.equal(rows.find((r) => r.version === 1)?.status, 'active',
      'a refused replacement must not retire the timetable the school is using');
    assert.equal(rows.find((r) => r.version === 2)?.status, 'draft');
    assert.equal((await consumersRead())?.version, 1);
    void v1;
  });

  test('the publish screen shows the live routine and the draft, not the history', async () => {
    await publishV1();
    await post(generate, { yearId: YEAR, baseline: 'current' });
    const v2 = await draft();
    assert.ok(v2);
    await post(publish, { action: 'publish', routineId: v2.id, confirmWarnings: true });
    await post(generate, { yearId: YEAR, baseline: 'current' });

    const r = await call(publish, {
      method: 'GET', url: `/?yearId=${YEAR}`, token: headToken,
    } as Parameters<typeof call>[1]);
    assert.equal(r.status, 200);
    const listed = (r.body as { routines?: Array<{ version: number; status: string }> })
      .routines ?? [];
    assert.deepEqual(listed.map((x) => x.status).sort(), ['active', 'draft'],
      'a school accumulates a retired version every revision; the publish '
      + 'screen is not where they belong');
    assert.deepEqual(listed.map((x) => x.version).sort(), [2, 3]);
  });

  /* ─────────────────── §12 hard constraints ───────────────────────────── */

  test('§12 — a replacement holds no clash of any kind', async () => {
    await publishV1();
    for (const baseline of ['current', 'inputs'] as const) {
      await asBootstrap(db, head, (c) => c.query(
        `DELETE FROM routine_slots WHERE tenant_id = $1 AND routine_id IN
           (SELECT id FROM routines WHERE tenant_id = $1 AND status = 'draft')`, [T]));
      await asBootstrap(db, head, (c) => c.query(
        `DELETE FROM routines WHERE tenant_id = $1 AND status = 'draft'`, [T]));
      const g = await post(generate, { yearId: YEAR, baseline });
      assert.equal(g.status, 200, JSON.stringify(g.body));
      const v = await draft();
      assert.ok(v, baseline);
      assert.deepEqual(await clashes(v.id),
        { teacher: 0, room: 0, section: 0, bad_room: 0, unavailable: 0 },
        `baseline '${baseline}' produced a clash`);
    }
  });

  /* ─────────────────── §14 who may replace ────────────────────────────── */

  test('§14 — only the authoring roles may create or publish a replacement', async () => {
    await publishV1();
    await post(generate, { yearId: YEAR, baseline: 'current' });
    const v2 = await draft();
    assert.ok(v2);

    for (const [who, token] of [
      ['student', studentToken], ['guardian', guardianToken], ['teacher', teacherToken],
    ] as const) {
      assert.equal(
        (await post(generate, { yearId: YEAR, baseline: 'current' }, token)).status, 403,
        `${who} created a replacement`);
      assert.equal(
        (await post(publish,
          { action: 'publish', routineId: v2.id, confirmWarnings: true }, token)).status, 403,
        `${who} published a replacement`);
    }
    assert.equal((await routines()).find((r) => r.version === 2)?.status, 'draft',
      'and nothing they did changed it');
    assert.equal((await consumersRead())?.version, 1);
  });

  /* ─────────────────── §10 tenant isolation ──────────────────────────── */

  test('§10 — another school cannot replace this one’s routine, and keeps its own', async () => {
    await publishV1();
    await post(generate, { yearId: YEAR, baseline: 'current' });
    const v2 = await draft();
    assert.ok(v2);

    // B holding A's ids gets nothing. The generate refusal is the readiness
    // gate rather than a 404 — B's own school has no sections in a year it
    // cannot see, so it is refused for being empty rather than for the year
    // being somebody else's. Either way it is a refusal, and the assertions
    // below are that A is untouched, which is the property that matters.
    const gB = await post(generate, { yearId: YEAR, baseline: 'current' }, headBToken);
    assert.ok(gB.status >= 400, `B was allowed to generate: ${JSON.stringify(gB.body)}`);
    const p = await post(publish,
      { action: 'publish', routineId: v2.id, confirmWarnings: true }, headBToken);
    assert.equal(p.status, 404, JSON.stringify(p.body));
    assert.equal((p.body as { error?: string }).error, 'routine_not_found');

    const rows = await routines();
    assert.equal(rows.find((r) => r.version === 1)?.status, 'active');
    assert.equal(rows.find((r) => r.version === 2)?.status, 'draft');
    assert.equal((await consumersRead())?.version, 1);

    // And B's own school is untouched — it has no routines at all.
    const { rows: bRows } = await asBootstrap(db, headB, (c) => c.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM routines WHERE tenant_id = $1`, [T_B]));
    assert.equal(bRows[0].n, 0);
  });

  /* ─────────────────── §13 explanations ──────────────────────────────── */

  test('§13 — an unplaceable demand still says so, and says why', async () => {
    // The fix must not have been "stop reporting no_free_slot". Ask for more
    // Bangla than the week holds and the reason must come back.
    await publishV1();
    await asBootstrap(db, head, (c) => c.query(
      `UPDATE class_subjects SET periods_per_week = 20
        WHERE tenant_id = $1 AND subject_id = $2`, [T, BANGLA]));
    const g = await post(generate, { yearId: YEAR });
    assert.equal(g.status, 200);
    const unplaced = (g.body as { shifts?: Array<{ unplaced: Array<{ reason: string }> }> })
      .shifts?.[0]?.unplaced ?? [];
    assert.ok(unplaced.length > 0, 'an impossible demand must be reported');
    assert.ok(unplaced.some((u) => u.reason === 'no_free_slot'),
      `no_free_slot must still be reachable: ${JSON.stringify(unplaced.map((u) => u.reason))}`);
  });
});
