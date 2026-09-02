/**
 * M6 — the staff register, and the loop it closes.
 *
 * ── What this is really testing ─────────────────────────────────────────
 * Not "does a row get written". The substitute finder has refused to offer an
 * absent teacher since migration 006, reading `teacher_leaves` and
 * `teacher_availability` — and nothing in the product has ever written to
 * either. A repo-wide grep for `INSERT INTO teacher_leaves` finds one hit and
 * it is a test fixture. So the filter was real, tested, and inert.
 *
 * The test that matters is therefore the END of the loop, not the start:
 * mark Rafiq absent through the office screen, then ask the substitute finder
 * for cover and watch Rafiq disappear from the candidates. Everything else
 * here is scaffolding for that one assertion.
 *
 * Paired both ways, per the audit plan's evidence rule: the finder OFFERS him
 * before the mark and AFTER the mark is changed back to present. A filter that
 * excluded everybody would pass a one-sided test.
 *
 *   DATABASE_URL=postgres://… node --test services/ops-svc/test/staff-attendance.test.ts
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { createDb, type Db, type TenantContext } from '../../../packages/server-core/src/db.ts';
import { installTestKeys, call, lockFixtures, unlockFixtures, asBootstrap } from '../../../packages/server-core/test/harness.ts';

const DATABASE_URL = process.env.DATABASE_URL;
const skip = !DATABASE_URL ? 'DATABASE_URL not set' : false;

const T       = '7d600000-0000-4000-8000-00000000000a';
const HEAD    = '7d600000-0000-4000-8000-0000000000f1';
/** Rafiq teaches the period that needs covering; the other two could cover it. */
const RAFIQ   = '7d600000-0000-4000-8000-0000000000a1';
const SHAMIM  = '7d600000-0000-4000-8000-0000000000a2';
const NASRIN  = '7d600000-0000-4000-8000-0000000000a3';
const YEAR    = '7d600000-0000-4000-8000-0000000000c1';
const CLASS9  = '7d600000-0000-4000-8000-0000000000d1';
const SEC_KA  = '7d600000-0000-4000-8000-0000000000e1';
const MATH    = '7d600000-0000-4000-8000-0000000000b1';
const TPL     = '7d600000-0000-4000-8000-0000000000b2';
const RT      = '7d600000-0000-4000-8000-0000000000b3';
const SLOT    = '7d600000-0000-4000-8000-0000000000b4';

let db: Db;
let headToken = '';
let rafiqToken = '';
let staffAttendance: typeof import('../api/staff-attendance.ts').default;
let substitute: typeof import('../../rms-svc/api/substitute.ts').default;

const asHead: TenantContext = { tenantId: T, userId: HEAD, role: 'principal' };

/** A date the fixture owns outright, so nothing depends on the day this runs. */
const DAY = '2026-03-04';           // a Wednesday
const DOW = 3;

async function drop(): Promise<void> {
  await asBootstrap(db, asHead, async (c) => {
    await c.query('DELETE FROM tenants WHERE id = $1', [T]);
  });
}

async function seed(): Promise<void> {
  await drop();
  await asBootstrap(db, asHead, async (c) => {
    await c.query(
      `INSERT INTO tenants (id, slug, name_bn, name_en, stream, level)
       VALUES ($1,'m6-register','রেজিস্টার','Register','bangla_medium','secondary')`, [T]);

    const user = async (id: string, bn: string, en: string, role: string, phone: string) => {
      await c.query(
        `INSERT INTO users (id, tenant_id, full_name_bn, full_name_en, phone_e164, status)
         VALUES ($1,$2,$3,$4,$5,'active')`, [id, T, bn, en, phone]);
      await c.query(
        `INSERT INTO user_roles (tenant_id, user_id, role_code) VALUES ($1,$2,$3)`, [T, id, role]);
    };
    await user(HEAD,   'প্রধান শিক্ষক', 'Head',   'principal',       '+8801799630001');
    await user(RAFIQ,  'রফিক স্যার',    'Rafiq',  'subject_teacher', '+8801799630002');
    await user(SHAMIM, 'শামীম স্যার',   'Shamim', 'subject_teacher', '+8801799630003');
    await user(NASRIN, 'নাসরিন ম্যাডাম','Nasrin', 'class_teacher',   '+8801799630004');

    await c.query(
      `INSERT INTO academic_years (id, tenant_id, label, starts_on, ends_on, is_current)
       VALUES ($1,$2,'২০২৬','2026-01-01','2026-12-31',true)`, [YEAR, T]);
    await c.query(
      `INSERT INTO classes (id, tenant_id, level_no, name_bn, name_en, stream)
       VALUES ($1,$2,9,'নবম','Nine','bangla_medium')`, [CLASS9, T]);
    await c.query(
      `INSERT INTO sections (id, tenant_id, class_id, academic_year_id, name, capacity)
       VALUES ($1,$2,$3,$4,'ক',40)`, [SEC_KA, T, CLASS9, YEAR]);
    await c.query(
      `INSERT INTO subjects (id, tenant_id, nctb_code, name_bn, name_en)
       VALUES ($1,$2,'109','গণিত','Mathematics')`, [MATH, T]);

    await c.query(
      `INSERT INTO period_templates (id, tenant_id, name_bn, shift, effective_from)
       VALUES ($1,$2,'নিয়মিত','single','2026-01-01')`, [TPL, T]);
    const { rows: pd } = await c.query<{ id: string }>(
      `INSERT INTO period_definitions
         (id, tenant_id, template_id, period_no, label_bn, starts_at, ends_at, kind)
       VALUES (gen_random_uuid(),$1,$2,1,'১ম','09:00','09:45','teaching')
       RETURNING id`, [T, TPL]);
    await c.query(
      `INSERT INTO routines (id, tenant_id, academic_year_id, period_template_id,
                             name_bn, status, effective_from)
       VALUES ($1,$2,$3,$4,'রুটিন','active','2026-01-01')`, [RT, T, YEAR, TPL]);
    await c.query(
      `INSERT INTO routine_slots
         (id, tenant_id, routine_id, academic_year_id, routine_status, day_of_week,
          period_no, period_definition_id, starts_at, ends_at,
          primary_section_id, subject_id, teacher_id, status)
       VALUES ($1,$2,$3,$4,'active',$5,1,$6,'09:00','09:45',$7,$8,$9,'active')`,
      [SLOT, T, RT, YEAR, DOW, pd[0].id, SEC_KA, MATH, RAFIQ]);
  });
}

describe('M6 — the staff register', { skip }, () => {
  before(async () => {
    await installTestKeys();
    await lockFixtures(DATABASE_URL as string);
    db = createDb(DATABASE_URL as string);
    await seed();

    const { signAccessToken } = await import('../../../packages/server-core/src/jwt.ts');
    headToken = await signAccessToken({ sub: HEAD, tid: T, role: 'principal', roles: ['principal'] });
    rafiqToken = await signAccessToken({
      sub: RAFIQ, tid: T, role: 'subject_teacher', roles: ['subject_teacher'] });

    staffAttendance = (await import('../api/staff-attendance.ts')).default;
    substitute = (await import('../../rms-svc/api/substitute.ts')).default;
  });

  after(async () => { if (db) { await drop(); await db.end(); await unlockFixtures(); } });

  const get = (token: string, date = DAY) =>
    call(staffAttendance, {
      method: 'GET', url: `/api/v1/ops/staff-attendance?date=${date}`, token,
    } as Parameters<typeof call>[1]);

  const post = (token: string, body: unknown) =>
    call(staffAttendance, {
      method: 'POST', url: '/api/v1/ops/staff-attendance', token, body,
    } as Parameters<typeof call>[1]);

  const candidates = async (): Promise<string[]> => {
    const r = await call(substitute, {
      method: 'POST', url: '/api/v1/rms/substitute', token: headToken,
      body: { slotId: SLOT, date: DAY },
    } as Parameters<typeof call>[1]);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return (r.body as { candidates: Array<{ teacherId: string }> })
      .candidates.map((c) => c.teacherId);
  };

  test('THE ONE THAT MATTERS — marking a teacher absent removes them from cover', async () => {
    // ── POSITIVE: unmarked, Shamim is offered ──
    const before = await candidates();
    assert.ok(before.includes(SHAMIM),
      `an unmarked teacher must be offerable: ${JSON.stringify(before)}`);
    // Rafiq is never a candidate — he is the one being covered for.
    assert.ok(!before.includes(RAFIQ), 'the absent slot owner is never their own substitute');

    // ── the act: the office marks Shamim absent for that day ──
    const marked = await post(headToken, { teacherId: SHAMIM, date: DAY, status: 'absent' });
    assert.equal(marked.status, 200, JSON.stringify(marked.body));

    // ── NEGATIVE ──
    const during = await candidates();
    assert.ok(!during.includes(SHAMIM),
      'a teacher marked absent must not be offered as cover');
    assert.ok(during.includes(NASRIN),
      'and the rest of the staff must still be offered — this is a filter, not an outage');

    // ── and back again, so the negative is not simply everything breaking ──
    const restored = await post(headToken, { teacherId: SHAMIM, date: DAY, status: 'present' });
    assert.equal(restored.status, 200);
    assert.ok((await candidates()).includes(SHAMIM),
      'marking a teacher present again must return them to the pool');
  });

  test('on_leave excludes as firmly as absent — the difference is for the head teacher', async () => {
    await post(headToken, { teacherId: SHAMIM, date: DAY, status: 'on_leave', reason: 'পারিবারিক কাজ' });
    assert.ok(!(await candidates()).includes(SHAMIM));
    await post(headToken, { teacherId: SHAMIM, date: DAY, status: 'present' });
  });

  test('the mark is for ONE day, not from that day on', async () => {
    await post(headToken, { teacherId: NASRIN, date: DAY, status: 'absent' });
    // The same slot, a week later. Nothing was marked for that date.
    const r = await call(substitute, {
      method: 'POST', url: '/api/v1/rms/substitute', token: headToken,
      body: { slotId: SLOT, date: '2026-03-11' },
    } as Parameters<typeof call>[1]);
    assert.equal(r.status, 200);
    const ids = (r.body as { candidates: Array<{ teacherId: string }> }).candidates.map((c) => c.teacherId);
    assert.ok(ids.includes(NASRIN), 'yesterday’s absence must not follow a teacher forever');
    await post(headToken, { teacherId: NASRIN, date: DAY, status: 'present' });
  });

  test('an unmarked register excludes nobody', async () => {
    // The first morning a school uses this, nothing is marked. Every teacher
    // must still be offerable — "not yet marked" is not "absent".
    const r = await call(substitute, {
      method: 'POST', url: '/api/v1/rms/substitute', token: headToken,
      body: { slotId: SLOT, date: '2026-04-01' },
    } as Parameters<typeof call>[1]);
    const ids = (r.body as { candidates: Array<{ teacherId: string }> }).candidates.map((c) => c.teacherId);
    assert.ok(ids.includes(SHAMIM) && ids.includes(NASRIN));
  });

  test('the register lists every teacher, marked or not, with a running count', async () => {
    await post(headToken, { teacherId: RAFIQ, date: DAY, status: 'absent', reason: 'অসুস্থ' });
    const r = await get(headToken);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const body = r.body as {
      date: string; total: number; marked: number; away: number; canMark: boolean;
      teachers: Array<{ teacherId: string; status: string | null; reason: string | null; name: { bn: string } }>;
    };
    assert.equal(body.date, DAY);
    assert.equal(body.total, 3, 'the head teacher holds no teaching role; the other three do');
    assert.equal(body.away, 1);
    assert.equal(body.canMark, true);

    const rafiq = body.teachers.find((t) => t.teacherId === RAFIQ);
    assert.equal(rafiq?.status, 'absent');
    assert.equal(rafiq?.reason, 'অসুস্থ');
    assert.equal(rafiq?.name.bn, 'রফিক স্যার');

    const shamim = body.teachers.find((t) => t.teacherId === SHAMIM);
    assert.equal(shamim?.status, 'present', 'marked present earlier in this file');

    await post(headToken, { teacherId: RAFIQ, date: DAY, status: 'present' });
  });

  test('every screen name is a name — no raw UUIDs reach the register', async () => {
    const r = await get(headToken);
    const text = JSON.stringify((r.body as { teachers: unknown[] }).teachers
      .map((t) => (t as { name: unknown; reason: unknown }).name));
    assert.ok(!/[0-9a-f]{8}-[0-9a-f]{4}-/.test(text), text);
    assert.ok(!/undefined|null,|\[object/.test(text.replace(/"en":null/g, '')), text);
  });

  test('a subject teacher may READ the register but not write it', async () => {
    // Reading is deliberately open to staff: a teacher looking for cover needs
    // it, and it holds nothing private.
    const r = await get(rafiqToken);
    assert.equal(r.status, 200);
    assert.equal((r.body as { canMark: boolean }).canMark, false,
      'and the screen must be told, rather than discovering it on submit');

    const w = await post(rafiqToken, { teacherId: SHAMIM, date: DAY, status: 'absent' });
    assert.equal(w.status, 403, JSON.stringify(w.body));
  });

  test('the database refuses the write too, not only the role check', async () => {
    // requireRole is the clean 403 in front of RLS. If it were the only
    // guard, a new endpoint that forgot it would be an open door. This is
    // 063's RESTRICTIVE policy answering directly.
    const asRafiq: TenantContext = { tenantId: T, userId: RAFIQ, role: 'subject_teacher' };
    await assert.rejects(
      () => db.withTenant(asRafiq, (c) => c.query(
        `INSERT INTO teacher_attendance (tenant_id, teacher_id, attendance_date, status, marked_by)
         VALUES (app.current_tenant(), $1, $2, 'absent', $1)`, [RAFIQ, DAY])),
      /row-level security|violates/i,
    );
  });

  test('only real teaching staff can be marked', async () => {
    const r = await post(headToken, { teacherId: HEAD, date: DAY, status: 'absent' });
    assert.equal(r.status, 404, 'the head teacher holds no teaching role in this fixture');
    assert.equal((r.body as { error: string }).error, 'teacher_not_found');
  });

  test('bad input is refused in Bangla, before anything is written', async () => {
    for (const [body, code] of [
      [{ teacherId: SHAMIM, date: DAY, status: 'holiday' }, 'bad_status'],
      [{ teacherId: SHAMIM, date: '4 March', status: 'absent' }, 'bad_date'],
      [{ date: DAY, status: 'absent' }, 'teacher_required'],
      [{ teacherId: SHAMIM, date: DAY, status: 'absent', reason: 'অ'.repeat(201) }, 'reason_too_long'],
    ] as const) {
      const r = await post(headToken, body);
      assert.equal(r.status, 400, JSON.stringify(r.body));
      assert.equal((r.body as { error: string }).error, code);
      const msg = (r.body as { message: string }).message;
      assert.match(msg, /[ঀ-৿]/, `not Bangla: ${msg}`);
    }
  });

  test('re-marking corrects the row and the audit says what changed', async () => {
    await post(headToken, { teacherId: SHAMIM, date: DAY, status: 'absent', reason: 'অসুস্থ' });
    await post(headToken, { teacherId: SHAMIM, date: DAY, status: 'on_leave', reason: 'ছুটি' });

    const rows = await asBootstrap(db, asHead, async (c) => {
      const one = await c.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM teacher_attendance
          WHERE teacher_id = $1 AND attendance_date = $2`, [SHAMIM, DAY]);
      const audit = await c.query<{ before: unknown; after: unknown }>(
        `SELECT before_state AS before, after_state AS after FROM audit.activity_log
          WHERE action = 'ops.staff_attendance.mark' AND entity_id = $1
          ORDER BY created_at DESC LIMIT 1`, [SHAMIM]);
      return { count: one.rows[0].n, audit: audit.rows[0] };
    });

    assert.equal(rows.count, '1', 'a correction replaces the mark, it does not add a second');
    assert.deepEqual(rows.audit.before, { status: 'absent', reason: 'অসুস্থ' });
    assert.deepEqual(rows.audit.after, { status: 'on_leave', reason: 'ছুটি', date: DAY });

    await post(headToken, { teacherId: SHAMIM, date: DAY, status: 'present' });
  });

  test('another school cannot see or mark this register', async () => {
    const OTHER = '7d600000-0000-4000-8000-0000000000ff';
    const otherCtx: TenantContext = { tenantId: OTHER, userId: HEAD, role: 'principal' };
    const seen = await asBootstrap(db, otherCtx, async (c) => {
      const { rows } = await c.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM teacher_attendance`);
      return rows[0].n;
    });
    assert.equal(seen, '0', 'RLS returns no rows, rather than another school’s register');

    // And the absence test answers only for the caller's tenant, so one
    // school's sick day cannot remove a teacher from another school's cover.
    const leaks = await asBootstrap(db, otherCtx, async (c) => {
      const { rows } = await c.query<{ away: boolean }>(
        `SELECT app.teacher_absent_on($1, $2) AS away`, [SHAMIM, DAY]);
      return rows[0].away;
    });
    assert.equal(leaks, false);
  });
});
