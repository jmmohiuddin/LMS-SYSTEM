/**
 * B-15 — a student's own day, and everybody who must not read it.
 *
 * The card P4 refused to build. `GET /rms/routine` is teacher-scoped, so the
 * student home shipped without "today's classes" rather than fabricating one.
 * `app.student_day` (migration 049) and `/academics/myroutine` answer it
 * properly, and this file is the reason to believe they answer it safely.
 *
 * ── Four properties, and the last two are the ones that could hurt ─────────
 *
 *   1. A student sees their own day, in period order, with the substitute
 *      named where a period is covered.
 *   2. Parallel blocks are filtered by what the student actually takes — the
 *      Hindu student does not get the Islamic-studies period on their
 *      timetable, and the Muslim student does not get the Hindu one.
 *   3. NOBODY reads a day that is not theirs. Not another student, not
 *      another family's guardian, not another tenant's principal.
 *   4. The refusal is SILENT. An unauthorised read returns an empty day, not
 *      a 404 and not an error naming the student — because a distinguishable
 *      error is an id oracle, which is the thing migration 010 and
 *      studenthistory.ts both went out of their way not to build.
 *
 * Property 3 is asserted against the DATABASE FUNCTION, not only the handler.
 * The handler could filter correctly and pass; what has to hold is that the
 * gate is inside `app.student_day` via `app.can_see_student`, so a second
 * endpoint written next year in a hurry inherits it.
 *
 *   DATABASE_URL=postgres://… node --test services/academics-svc/test/b15-student-routine.test.ts
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { createDb, type Db, type TenantContext } from '../../../packages/server-core/src/db.ts';
import { installTestKeys, call } from '../../../packages/server-core/test/harness.ts';
import type { StudentSlot } from '../api/myroutine.ts';

/** `call` reports the body as Record<string, unknown>; this names the shape. */
const slotsOf = (body: Record<string, unknown>): StudentSlot[] =>
  (body.slots ?? []) as StudentSlot[];

const DATABASE_URL = process.env.DATABASE_URL;
const skip = !DATABASE_URL ? 'DATABASE_URL not set' : false;

/* Distinct from p4-privacy's ids so the two suites can run in any order. */
const T_A       = '7b15c000-0000-4000-8000-0000000000a0';
const T_B       = '7b15c000-0000-4000-8000-0000000000b0';
const HEAD_A    = '7b15c000-0000-4000-8000-0000000000a1';
const HEAD_B    = '7b15c000-0000-4000-8000-0000000000b1';
/* Tenant A, section ক: two students who share every ordinary period and
   differ on exactly one — the religion variant. */
const MUSLIM    = '7b15c000-0000-4000-8000-0000000000a2';
const HINDU     = '7b15c000-0000-4000-8000-0000000000a3';
/* A third student in a DIFFERENT section: same school, different day. */
const OTHER_SEC = '7b15c000-0000-4000-8000-0000000000a4';
const GUARDIAN  = '7b15c000-0000-4000-8000-0000000000a5';  // parent of MUSLIM only
const TEACHER   = '7b15c000-0000-4000-8000-0000000000a6';
const SUB_TEACH = '7b15c000-0000-4000-8000-0000000000a7';
/* A parallel block is two rooms at the same hour, so it needs two teachers:
   `rs_no_teacher_double_booking` refuses one person in both, correctly. */
const TEACH_2   = '7b15c000-0000-4000-8000-0000000000a8';
const TEACH_3   = '7b15c000-0000-4000-8000-0000000000a9';
const B_STUDENT = '7b15c000-0000-4000-8000-0000000000b2';

const YEAR_A    = '7b15c000-0000-4000-8000-0000000000c1';
const YEAR_B    = '7b15c000-0000-4000-8000-0000000000c2';
const CLASS_A   = '7b15c000-0000-4000-8000-0000000000d1';
const CLASS_B   = '7b15c000-0000-4000-8000-0000000000d2';
const SEC_A     = '7b15c000-0000-4000-8000-0000000000e1';
const SEC_A2    = '7b15c000-0000-4000-8000-0000000000e3';
const SEC_B     = '7b15c000-0000-4000-8000-0000000000e2';
const TMPL_A    = '7b15c000-0000-4000-8000-0000000000f1';
const ROUTINE_A = '7b15c000-0000-4000-8000-0000000000f2';
const ROOM_A    = '7b15c000-0000-4000-8000-0000000000f3';
const ROOM_B    = '7b15c000-0000-4000-8000-0000000000f4';
const SUB_BANGLA= '7b15c000-0000-4000-8000-00000000010a';
const SUB_ISLAM = '7b15c000-0000-4000-8000-00000000010b';
const SUB_HINDU = '7b15c000-0000-4000-8000-00000000010c';
const SLOT_P1   = '7b15c000-0000-4000-8000-00000000020a';
const SLOT_ISLAM= '7b15c000-0000-4000-8000-00000000020b';
const SLOT_HINDU= '7b15c000-0000-4000-8000-00000000020c';
const SLOT_OTHER= '7b15c000-0000-4000-8000-00000000020d';

/**
 * A fixed date whose weekday is known and stable. 2026-03-02 is a Monday, so
 * `EXTRACT(DOW)` is 1 — the value every slot below is written for. A test that
 * used CURRENT_DATE would pass six days in seven and fail on the seventh,
 * which is exactly the shape of the bug P3.1 spent an afternoon on.
 */
const DAY = '2026-03-02';
const DOW = 1;

let db: Db;
let tokens: Record<string, string> = {};
let myroutine: typeof import('../api/myroutine.ts').default;

const headA: TenantContext = { tenantId: T_A, userId: HEAD_A, role: 'principal' };
const headB: TenantContext = { tenantId: T_B, userId: HEAD_B, role: 'principal' };

/** Each tenant dropped in its own context — RLS scopes DELETE too. */
async function drop(): Promise<void> {
  for (const ctx of [headA, headB]) {
    await db.withTenant(ctx, async (c) => {
      await c.query('DELETE FROM tenants WHERE id = $1', [ctx.tenantId]);
    });
  }
}

function phoneFor(id: string): string {
  const n = parseInt(id.slice(-6), 16) % 100000000;
  return `+88018${String(n).padStart(8, '0')}`;
}

async function user(c: any, id: string, t: string, name: string, role: string): Promise<void> {
  await c.query(
    `INSERT INTO users (id, tenant_id, full_name_bn, full_name_en, phone_e164, status)
     VALUES ($1,$2,$3,$3,$4,'active')`, [id, t, name, phoneFor(id)]);
  await c.query(
    `INSERT INTO user_roles (tenant_id, user_id, role_code) VALUES ($1,$2,$3)`, [t, id, role]);
}

async function seed(): Promise<void> {
  await drop();

  await db.withTenant(headA, async (c) => {
    await c.query(
      `INSERT INTO tenants (id, slug, name_bn, name_en, stream, level)
       VALUES ($1,'b15-a','বি১৫ক','B15A','bangla_medium','secondary')`, [T_A]);
    await user(c, HEAD_A, T_A, 'প্রধান', 'principal');
    await user(c, MUSLIM, T_A, 'রাফি', 'student');
    await user(c, HINDU, T_A, 'অর্ণব', 'student');
    await user(c, OTHER_SEC, T_A, 'সাদিয়া', 'student');
    await user(c, GUARDIAN, T_A, 'রহিম', 'guardian');
    await user(c, TEACHER, T_A, 'নাজমা ম্যাডাম', 'class_teacher');
    await user(c, SUB_TEACH, T_A, 'বদলি স্যার', 'subject_teacher');
    await user(c, TEACH_2, T_A, 'ফরিদ স্যার', 'subject_teacher');
    await user(c, TEACH_3, T_A, 'দীপক স্যার', 'subject_teacher');

    await c.query(
      `INSERT INTO academic_years (id, tenant_id, label, starts_on, ends_on, is_current)
       VALUES ($1,$2,'2026','2026-01-01','2026-12-31',true)`, [YEAR_A, T_A]);
    await c.query(
      `INSERT INTO classes (id, tenant_id, level_no, name_bn, name_en, stream)
       VALUES ($1,$2,9,'নবম','Nine','bangla_medium')`, [CLASS_A, T_A]);
    for (const [id, name] of [[SEC_A, 'ক'], [SEC_A2, 'খ']] as const) {
      await c.query(
        `INSERT INTO sections (id, tenant_id, class_id, academic_year_id, name, student_count)
         VALUES ($1,$2,$3,$4,$5,0)`, [id, T_A, CLASS_A, YEAR_A, name]);
    }
    for (const [id, code] of [[ROOM_A, '১০১'], [ROOM_B, '১০২']] as const) {
      await c.query(
        `INSERT INTO rooms (id, tenant_id, code, name_bn, capacity)
         VALUES ($1,$2,$3,'রুম ' || $3,40)`, [id, T_A, code]);
    }

    for (const [id, bn, en] of [
      [SUB_BANGLA, 'বাংলা', 'Bangla'],
      [SUB_ISLAM, 'ইসলাম শিক্ষা', 'Islamic Studies'],
      [SUB_HINDU, 'হিন্দুধর্ম শিক্ষা', 'Hindu Religion'],
    ] as const) {
      await c.query(
        `INSERT INTO subjects (id, tenant_id, name_bn, name_en) VALUES ($1,$2,$3,$4)`,
        [id, T_A, bn, en]);
    }

    // Enrolments, and the subject choice that makes the parallel block real.
    const enrolIds: Record<string, string> = {};
    let roll = 1;
    for (const [sid, sec] of [
      [MUSLIM, SEC_A], [HINDU, SEC_A], [OTHER_SEC, SEC_A2],
    ] as const) {
      const r = await c.query<{ id: string }>(
        `INSERT INTO enrolments (tenant_id, student_id, section_id, academic_year_id, roll_no, status)
         VALUES ($1,$2,$3,$4,$5,'active') RETURNING id`,
        [T_A, sid, sec, YEAR_A, roll++]);
      enrolIds[sid] = r.rows[0].id;
    }
    await c.query(
      `INSERT INTO guardianships (tenant_id, student_id, guardian_id, relation, is_primary)
       VALUES ($1,$2,$3,'father',true)`, [T_A, MUSLIM, GUARDIAN]);

    // Each student takes exactly one religion variant.
    for (const [sid, subj] of [[MUSLIM, SUB_ISLAM], [HINDU, SUB_HINDU]] as const) {
      await c.query(
        `INSERT INTO student_subjects
           (tenant_id, enrolment_id, subject_id, requirement_type, source)
         VALUES ($1,$2,$3,'religion_variant','template')`,
        [T_A, enrolIds[sid], subj]);
    }

    // Period template → definitions → routine → slots.
    await c.query(
      `INSERT INTO period_templates (id, tenant_id, name_bn, effective_from)
       VALUES ($1,$2,'নিয়মিত','2026-01-01')`, [TMPL_A, T_A]);
    const pdef: string[] = [];
    for (const [no, from, to] of [[1, '08:00', '08:45'], [2, '08:50', '09:35']] as const) {
      const r = await c.query<{ id: string }>(
        `INSERT INTO period_definitions (tenant_id, template_id, period_no, label_bn, starts_at, ends_at)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
        [T_A, TMPL_A, no, `${no}ম পিরিয়ড`, from, to]);
      pdef.push(r.rows[0].id);
    }
    await c.query(
      `INSERT INTO routines (id, tenant_id, academic_year_id, period_template_id,
                             name_bn, status, effective_from)
       VALUES ($1,$2,$3,$4,'২০২৬ রুটিন','active','2026-01-01')`,
      [ROUTINE_A, T_A, YEAR_A, TMPL_A]);

    const slot = async (
      id: string, section: string, pno: number, pdefId: string,
      from: string, to: string, subject: string, pool: string | null,
      teacher: string = TEACHER, room: string = ROOM_A,
    ) => {
      await c.query(
        `INSERT INTO routine_slots
           (id, tenant_id, routine_id, academic_year_id, day_of_week, period_no,
            period_definition_id, starts_at, ends_at, primary_section_id,
            subject_id, teacher_id, room_id, parallel_pool, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'active')`,
        [id, T_A, ROUTINE_A, YEAR_A, DOW, pno, pdefId, from, to,
         section, subject, teacher, room, pool]);
    };
    // Period 1: the whole section, together.
    await slot(SLOT_P1, SEC_A, 1, pdef[0], '08:00', '08:45', SUB_BANGLA, null);
    // Period 2: two variants at the same hour — a parallel block, not a clash.
    await slot(SLOT_ISLAM, SEC_A, 2, pdef[1], '08:50', '09:35', SUB_ISLAM, 'religion',
               TEACHER, ROOM_A);
    await slot(SLOT_HINDU, SEC_A, 2, pdef[1], '08:50', '09:35', SUB_HINDU, 'religion',
               TEACH_2, ROOM_B);
    // Another section entirely, so "wrong section" is a real negative. Its own
    // teacher and room, for the same reason.
    await slot(SLOT_OTHER, SEC_A2, 1, pdef[0], '08:00', '08:45', SUB_BANGLA, null,
               TEACH_3, ROOM_B);

    // Period 1 is covered by somebody else today.
    await c.query(
      `INSERT INTO routine_substitutions
         (tenant_id, slot_id, substitution_date, action, original_teacher_id,
          substitute_teacher_id, status)
       VALUES ($1,$2,$3,'assign',$4,$5,'assigned')`,
      [T_A, SLOT_P1, DAY, TEACHER, SUB_TEACH]);
  });

  await db.withTenant(headB, async (c) => {
    await c.query(
      `INSERT INTO tenants (id, slug, name_bn, name_en, stream, level)
       VALUES ($1,'b15-b','বি১৫খ','B15B','bangla_medium','secondary')`, [T_B]);
    await user(c, HEAD_B, T_B, 'প্রধান খ', 'principal');
    await user(c, B_STUDENT, T_B, 'অন্য স্কুল', 'student');
    await c.query(
      `INSERT INTO academic_years (id, tenant_id, label, starts_on, ends_on, is_current)
       VALUES ($1,$2,'2026','2026-01-01','2026-12-31',true)`, [YEAR_B, T_B]);
    await c.query(
      `INSERT INTO classes (id, tenant_id, level_no, name_bn, name_en, stream)
       VALUES ($1,$2,9,'নবম','Nine','bangla_medium')`, [CLASS_B, T_B]);
    await c.query(
      `INSERT INTO sections (id, tenant_id, class_id, academic_year_id, name, student_count)
       VALUES ($1,$2,$3,$4,'ক',0)`, [SEC_B, T_B, CLASS_B, YEAR_B]);
    await c.query(
      `INSERT INTO enrolments (tenant_id, student_id, section_id, academic_year_id, roll_no, status)
       VALUES ($1,$2,$3,$4,1,'active')`, [T_B, B_STUDENT, SEC_B, YEAR_B]);
  });
}

let ready: Promise<void> | null = null;
function ensureSetup(): Promise<void> {
  ready ??= (async () => {
    // installTestKeys() only plants the signing pair in the environment; the
    // tokens are minted afterwards, as in p4-privacy.test.ts.
    await installTestKeys();
    db = createDb(DATABASE_URL as string);
    myroutine = (await import('../api/myroutine.ts')).default;
    await seed();
    const { signAccessToken } = await import('../../../packages/server-core/src/jwt.ts');
    const mint = (sub: string, tid: string, role: string) =>
      signAccessToken({ sub, tid, role, roles: [role] });
    tokens = {
      muslim:   await mint(MUSLIM, T_A, 'student'),
      hindu:    await mint(HINDU, T_A, 'student'),
      otherSec: await mint(OTHER_SEC, T_A, 'student'),
      guardian: await mint(GUARDIAN, T_A, 'guardian'),
      teacher:  await mint(TEACHER, T_A, 'class_teacher'),
      headB:    await mint(HEAD_B, T_B, 'principal'),
      bStudent: await mint(B_STUDENT, T_B, 'student'),
    };
  })();
  return ready;
}

/** Read the function directly, under a chosen session. */
async function dayFor(ctx: TenantContext, student: string): Promise<any[]> {
  return db.withTenant(ctx, async (c) => {
    const r = await c.query<any>(
      `SELECT * FROM app.student_day($1::uuid, $2::date)`, [student, DAY]);
    return r.rows;
  });
}

describe('B-15 · app.student_day — what a student sees', { skip }, () => {
  before(ensureSetup);

  test('own day: period order, subject, room, and the substitute named', async () => {
    const rows = await dayFor({ tenantId: T_A, userId: MUSLIM, role: 'student' }, MUSLIM);
    assert.equal(rows.length, 2, 'period 1 plus ONE religion variant');
    assert.deepEqual(rows.map((r) => r.period_no), [1, 2], 'ordered by start time');

    const [p1, p2] = rows;
    assert.equal(p1.subject_bn, 'বাংলা');
    assert.equal(p1.room_code, '১০১');
    assert.equal(p1.starts_at.slice(0, 5), '08:00');
    // Covered today: the student is told who is actually taking it.
    assert.equal(p1.is_substitution, true);
    assert.equal(p1.teacher_name_bn, 'বদলি স্যার',
      'a covered period names the SUBSTITUTE, not the timetabled teacher');

    assert.equal(p2.is_substitution, false);
    assert.equal(p2.teacher_name_bn, 'নাজমা ম্যাডাম');
  });

  test('a parallel block gives each student only the variant they take', async () => {
    const muslim = await dayFor({ tenantId: T_A, userId: MUSLIM, role: 'student' }, MUSLIM);
    const hindu = await dayFor({ tenantId: T_A, userId: HINDU, role: 'student' }, HINDU);

    assert.deepEqual(muslim.map((r) => r.subject_bn), ['বাংলা', 'ইসলাম শিক্ষা']);
    assert.deepEqual(hindu.map((r) => r.subject_bn), ['বাংলা', 'হিন্দুধর্ম শিক্ষা']);
    // The point stated as the property rather than the arrangement: neither
    // student is ever shown a period they do not attend.
    assert.ok(!muslim.some((r) => r.subject_bn === 'হিন্দুধর্ম শিক্ষা'));
    assert.ok(!hindu.some((r) => r.subject_bn === 'ইসলাম শিক্ষা'));
  });

  test('the day is the enrolled section’s, not the class’s', async () => {
    // OTHER_SEC is in ক-খ, which has one period and no religion block.
    const rows = await dayFor({ tenantId: T_A, userId: OTHER_SEC, role: 'student' }, OTHER_SEC);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].section_label, 'নবম — খ');
  });

  test('a date outside the academic year returns nothing, not last year’s day', async () => {
    const rows = await db.withTenant(
      { tenantId: T_A, userId: MUSLIM, role: 'student' },
      async (c) => (await c.query(
        `SELECT * FROM app.student_day($1::uuid, '2025-03-03'::date)`, [MUSLIM])).rows);
    assert.equal(rows.length, 0);
  });
});

describe('B-15 · app.student_day — who may not read it', { skip }, () => {
  before(ensureSetup);

  test('a student cannot read a classmate’s day', async () => {
    const rows = await dayFor({ tenantId: T_A, userId: HINDU, role: 'student' }, MUSLIM);
    assert.equal(rows.length, 0,
      'same school, same section, still not theirs to read');
  });

  test('a guardian reads their own child and no other', async () => {
    const g: TenantContext = { tenantId: T_A, userId: GUARDIAN, role: 'guardian' };
    assert.equal((await dayFor(g, MUSLIM)).length, 2, 'their own child');
    assert.equal((await dayFor(g, HINDU)).length, 0, 'a child who is not theirs');
  });

  test('a teacher reads only students in their own sections', async () => {
    // TEACHER is not class_teacher of either section here — no assignment row
    // exists — so app.my_section_ids() is empty and the answer is nothing.
    const t: TenantContext = { tenantId: T_A, userId: TEACHER, role: 'class_teacher' };
    assert.equal((await dayFor(t, MUSLIM)).length, 0,
      'teaching a slot is not the same as being scoped to the student');
  });

  test('another tenant’s principal gets nothing, even with the right uuid', async () => {
    const rows = await dayFor(headB, MUSLIM);
    assert.equal(rows.length, 0);
  });

  test('the refusal is SILENT — an unknown id and a forbidden id look identical', async () => {
    const g: TenantContext = { tenantId: T_A, userId: GUARDIAN, role: 'guardian' };
    const forbidden = await dayFor(g, HINDU);
    const nonexistent = await dayFor(g, '7b15c000-0000-4000-8000-0000000000ff');
    assert.deepEqual(forbidden, nonexistent,
      'a distinguishable answer would confirm which student ids exist');
  });
});

describe('B-15 · GET /academics/myroutine', { skip }, () => {
  before(ensureSetup);
  after(async () => { await drop(); await db.end(); });

  test('a student gets their own day with no teacher-only fields', async () => {
    const res = await call(myroutine, {
      method: 'GET', url: `/api/v1/academics/myroutine?date=${DAY}`, token: tokens.muslim,
    });
    assert.equal(res.status, 200);
    assert.equal(slotsOf(res.body).length, 2);
    assert.equal(slotsOf(res.body)[0].startsAt, '08:00', 'HH:MM, not HH:MM:SS');
    assert.equal(slotsOf(res.body)[0].isSubstitution, true);
    assert.equal(slotsOf(res.body)[0].teacherNameBn, 'বদলি স্যার');

    const keys = Object.keys(slotsOf(res.body)[0]);
    for (const leak of ['studentCount', 'attendanceTaken', 'deliveryLogged']) {
      assert.ok(!keys.includes(leak), `${leak} is a teacher's fact and must not ship here`);
    }
  });

  test('a guardian reads their child by id', async () => {
    const res = await call(myroutine, {
      method: 'GET',
      url: `/api/v1/academics/myroutine?studentId=${MUSLIM}&date=${DAY}`,
      token: tokens.guardian,
    });
    assert.equal(res.status, 200);
    assert.equal(slotsOf(res.body).length, 2);
  });

  test('a guardian asking for another family’s child gets an EMPTY day, not an error', async () => {
    const res = await call(myroutine, {
      method: 'GET',
      url: `/api/v1/academics/myroutine?studentId=${HINDU}&date=${DAY}`,
      token: tokens.guardian,
    });
    // 200 with nothing: same shape as "no classes today". An error here would
    // tell a stranger that this uuid is a real student at this school.
    assert.equal(res.status, 200);
    assert.deepEqual(slotsOf(res.body), []);
  });

  test('a student naming a classmate is refused in words, and the id is not echoed', async () => {
    const res = await call(myroutine, {
      method: 'GET',
      url: `/api/v1/academics/myroutine?studentId=${HINDU}&date=${DAY}`,
      token: tokens.muslim,
    });
    assert.equal(res.status, 403);
    assert.ok(!JSON.stringify(res.body).includes(HINDU),
      'the refusal must not repeat the id back');
  });

  test('cross-tenant: tenant B’s student cannot name tenant A’s student', async () => {
    const res = await call(myroutine, {
      method: 'GET',
      url: `/api/v1/academics/myroutine?studentId=${MUSLIM}&date=${DAY}`,
      token: tokens.bStudent,
    });
    // Refused as "not your own id" before the database is even asked; and if
    // the role check were removed, RLS would still return nothing.
    assert.equal(res.status, 403);
  });

  test('cross-tenant, with a role that MAY name others', async () => {
    const res = await call(myroutine, {
      method: 'GET',
      url: `/api/v1/academics/myroutine?studentId=${MUSLIM}&date=${DAY}`,
      token: tokens.headB,
    });
    assert.equal(res.status, 200);
    assert.deepEqual(slotsOf(res.body), [],
      'a principal of another school reaches nothing — this is the RLS test');
  });

  test('a malformed id is rejected before any query runs', async () => {
    const res = await call(myroutine, {
      method: 'GET', url: '/api/v1/academics/myroutine?studentId=not-a-uuid',
      token: tokens.guardian,
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'invalid_student_id');
  });

  test('a malformed date is rejected', async () => {
    const res = await call(myroutine, {
      method: 'GET', url: '/api/v1/academics/myroutine?date=2026-3-2', token: tokens.muslim,
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'invalid_date');
  });

  test('no token is 401', async () => {
    const res = await call(myroutine, { method: 'GET', url: '/api/v1/academics/myroutine' });
    assert.equal(res.status, 401);
  });
});
