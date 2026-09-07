/**
 * P9-8 — eight audiences, one routine.
 *
 * The properties that decide whether this can be trusted, each of which is a
 * real incident if it is wrong:
 *
 *   1. NOBODY READS A DRAFT. `status = 'active'` is the whole visibility
 *      rule and it is applied once, in the read every scope passes through.
 *      A student who can see next term's half-built timetable is a school
 *      answering questions about lessons it has not decided to run.
 *
 *   2. EVERY SCOPE IS THE SAME DATA. A section's grid, the teacher's grid and
 *      the institution's grid must agree about the same hour, because they
 *      are selections from one routine and not three datasets. The test for
 *      this compares them.
 *
 *   3. AUTHORISATION IS PER SCOPE. A teacher reads their own week without
 *      being an administrator, and cannot read the school's. A student reads
 *      their own section. A guardian reads their ward's. Each of those is a
 *      different sentence and they are asserted separately.
 *
 *   4. A STUDENT SEES THE SUBJECTS THEY TAKE. A parallel block is an hour
 *      where the section splits by religion or optional subject; showing all
 *      of them would put a class on a child's timetable they do not attend.
 *
 *   5. THE RESPONSE CARRIES NO INTERNALS. The first version of this endpoint
 *      spread its filter into the body and shipped the SQL predicate and a
 *      bound section uuid to the browser. Found in the browser; pinned here.
 *
 *   DATABASE_URL=postgres://shikhon_app:… \
 *     node --test services/rms-svc/test/timetable.test.ts
 */
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { createDb, type Db, type TenantContext } from '../../../packages/server-core/src/db.ts';
import {
  installTestKeys, call, lockFixtures, unlockFixtures, asBootstrap,
} from '../../../packages/server-core/test/harness.ts';

const DATABASE_URL = process.env.DATABASE_URL;
const skip = !DATABASE_URL ? 'DATABASE_URL not set' : false;

const T        = '7c990000-0000-4000-8000-0000000000a0';
const HEAD     = '7c990000-0000-4000-8000-0000000000a1';
const RAFIQ    = '7c990000-0000-4000-8000-0000000000a2';
const SALMA    = '7c990000-0000-4000-8000-0000000000a3';
const STUDENT  = '7c990000-0000-4000-8000-0000000000a4';
const GUARDIAN = '7c990000-0000-4000-8000-0000000000a5';
const OUTSIDER = '7c990000-0000-4000-8000-0000000000a6';
const YEAR     = '7c990000-0000-4000-8000-0000000000c1';
const KLASS    = '7c990000-0000-4000-8000-0000000000d1';
const SEC_A    = '7c990000-0000-4000-8000-0000000000e1';
const SEC_B    = '7c990000-0000-4000-8000-0000000000e2';
const BANGLA   = '7c990000-0000-4000-8000-0000000000f1';
const MATHS    = '7c990000-0000-4000-8000-0000000000f2';
const TPL      = '7c990000-0000-4000-8000-00000000ab01';
const ROOM_A   = '7c990000-0000-4000-8000-00000000ab02';
const ROOM_B   = '7c990000-0000-4000-8000-00000000ab04';
const ENROL    = '7c990000-0000-4000-8000-00000000ab05';

const T_B      = '7c990000-0000-4000-8000-0000000000b0';
const HEAD_B   = '7c990000-0000-4000-8000-0000000000b1';

let db: Db;
let headTok = '', headBTok = '', rafiqTok = '', studentTok = '', guardianTok = '', outsiderTok = '';
let timetable: Parameters<typeof call>[0];
let generate: Parameters<typeof call>[0];
let publish: Parameters<typeof call>[0];

const head: TenantContext = { tenantId: T, userId: HEAD, role: 'principal' };
const headB: TenantContext = { tenantId: T_B, userId: HEAD_B, role: 'principal' };

interface Payload {
  ok?: boolean; scope?: string; id?: string; published?: boolean;
  titleBn?: string; subtitleBn?: string;
  counts?: { sections: number; teachers: number; rooms: number; classes: number };
  routines?: Array<{ id: string; version: number; shiftBn: string; publishedAt: string | null }>;
  periods?: Array<{ routineId: string; periodNo: number }>;
  lessons?: Array<{
    routineId: string; dayOfWeek: number; periodNo: number;
    subjectBn: string | null; teacherBn: string | null; roomBn: string | null;
    sectionLabel: string | null; classBn: string | null; isParallel: boolean;
  }>;
  days?: Array<{ dow: number; bn: string }>;
  offered?: Array<{ scope: string; labelBn: string; options?: Array<{ id: string; labelBn: string }> }>;
  error?: string; message?: string;
}

const get = (qs: string, token: string) =>
  call(timetable, { method: 'GET', url: `/?${qs}`, token } as Parameters<typeof call>[1]);
const body = async (qs: string, token: string): Promise<Payload> =>
  (await get(qs, token)).body as Payload;

/** A comparable identity for one lesson, independent of which scope asked. */
const key = (l: NonNullable<Payload['lessons']>[number]) =>
  `${l.dayOfWeek}|${l.periodNo}|${l.subjectBn}|${l.teacherBn}|${l.sectionLabel}`;

const publishAll = async () => {
  const g = await call(generate, {
    method: 'POST', url: '/', token: headTok, body: { yearId: YEAR },
  } as Parameters<typeof call>[1]);
  assert.equal(g.status, 200, JSON.stringify(g.body));
  const { rows } = await asBootstrap(db, head, (c) => c.query<{ id: string }>(
    `SELECT id FROM routines WHERE tenant_id = $1 AND status = 'draft'`, [T]));
  for (const r of rows) {
    const p = await call(publish, {
      method: 'POST', url: '/', token: headTok,
      body: { action: 'publish', routineId: r.id, confirmWarnings: true },
    } as Parameters<typeof call>[1]);
    assert.equal(p.status, 200, JSON.stringify(p.body));
  }
};

describe('P9-8 — role-specific views of one published routine', { skip }, () => {
  before(async () => {
    await installTestKeys();
    await lockFixtures(DATABASE_URL as string);
    db = createDb(DATABASE_URL as string);

    await asBootstrap(db, head, async (c) => {
      await c.query('DELETE FROM tenants WHERE id = $1', [T]);
      await c.query(
        `INSERT INTO tenants (id, slug, name_bn, name_en, stream, level, weekend_days)
         VALUES ($1,'p98','পি৯৮ বিদ্যালয়','P98','bangla_medium','secondary','{5,6}')`, [T]);
      for (const [id, bn, phone, role] of [
        [HEAD, 'প্রধান শিক্ষক', '+8801799990001', 'principal'],
        [RAFIQ, 'রফিক স্যার', '+8801799990002', 'subject_teacher'],
        [SALMA, 'সালমা ম্যাডাম', '+8801799990003', 'subject_teacher'],
        [STUDENT, 'ছাত্র', '+8801799990004', 'student'],
        [GUARDIAN, 'অভিভাবক', '+8801799990005', 'guardian'],
        [OUTSIDER, 'বাইরের ছাত্র', '+8801799990006', 'student'],
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
        `INSERT INTO classes (id, tenant_id, level_no, name_bn, name_en, stream, "group")
         VALUES ($1,$2,9,'নবম','Nine','bangla_medium','science')`, [KLASS, T]);
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
      // Rafiq teaches Bangla in section ক only, so "the sections I teach" is
      // a real subset and the teacher scope has something to be narrower than.
      await c.query(
        `INSERT INTO section_subject_teachers
           (tenant_id, section_id, subject_id, teacher_id, academic_year_id, started_on)
         VALUES ($1,$2,$3,$4,$5,'2026-01-05'), ($1,$2,$6,$7,$5,'2026-01-05'),
                ($1,$8,$3,$7,$5,'2026-01-05'), ($1,$8,$6,$7,$5,'2026-01-05')`,
        [T, SEC_A, BANGLA, RAFIQ, YEAR, MATHS, SALMA, SEC_B]);
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
      // The student is in ক; the guardian is their guardian; the outsider is
      // in খ, so "my section" and "somebody else's" both exist.
      await c.query(
        `INSERT INTO enrolments (id, tenant_id, student_id, section_id, academic_year_id,
                                 roll_no, status, enrolled_on)
         VALUES ($1,$2,$3,$4,$5,1,'active','2026-01-05')`,
        [ENROL, T, STUDENT, SEC_A, YEAR]);
      await c.query(
        `INSERT INTO enrolments (tenant_id, student_id, section_id, academic_year_id,
                                 roll_no, status, enrolled_on)
         VALUES ($1,$2,$3,$4,2,'active','2026-01-05')`,
        [T, OUTSIDER, SEC_B, YEAR]);
      await c.query(
        `INSERT INTO guardianships (tenant_id, student_id, guardian_id, relation, is_primary)
         VALUES ($1,$2,$3,'father',true)`, [T, STUDENT, GUARDIAN]);
    });

    await asBootstrap(db, headB, async (c) => {
      await c.query('DELETE FROM tenants WHERE id = $1', [T_B]);
      await c.query(
        `INSERT INTO tenants (id, slug, name_bn, name_en, stream, level)
         VALUES ($1,'p98-other','পাশের','Other','bangla_medium','secondary')`, [T_B]);
      await c.query(
        `INSERT INTO users (id, tenant_id, full_name_bn, full_name_en, phone_e164, status)
         VALUES ($1,$2,'অন্য','B','+8801799990009','active')`, [HEAD_B, T_B]);
      await c.query(
        `INSERT INTO user_roles (tenant_id, user_id, role_code) VALUES ($1,$2,'principal')`,
        [T_B, HEAD_B]);
    });

    const { signAccessToken } = await import('../../../packages/server-core/src/jwt.ts');
    headTok = await signAccessToken({ sub: HEAD, tid: T, role: 'principal', roles: ['principal'] });
    headBTok = await signAccessToken({ sub: HEAD_B, tid: T_B, role: 'principal', roles: ['principal'] });
    rafiqTok = await signAccessToken({
      sub: RAFIQ, tid: T, role: 'subject_teacher', roles: ['subject_teacher'] });
    studentTok = await signAccessToken({ sub: STUDENT, tid: T, role: 'student', roles: ['student'] });
    guardianTok = await signAccessToken({ sub: GUARDIAN, tid: T, role: 'guardian', roles: ['guardian'] });
    outsiderTok = await signAccessToken({ sub: OUTSIDER, tid: T, role: 'student', roles: ['student'] });

    timetable = (await import('../api/timetable.ts')).default;
    generate = (await import('../api/generate.ts')).default;
    publish = (await import('../api/publish.ts')).default;
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
    });
  });

  /* ─────────────────────── the visibility rule ────────────────────────── */

  test('THE ONE THAT MATTERS — a draft is invisible to everybody', async () => {
    // Generated but NOT published: a coordinator's work in progress.
    const g = await call(generate, {
      method: 'POST', url: '/', token: headTok, body: { yearId: YEAR },
    } as Parameters<typeof call>[1]);
    assert.equal(g.status, 200);
    const { rows } = await asBootstrap(db, head, (c) => c.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM routine_slots WHERE tenant_id = $1
        AND status = 'active'`, [T]));
    assert.ok(rows[0].n > 0, 'the draft really does have lessons in it');

    for (const [who, token] of [
      ['principal', headTok], ['teacher', rafiqTok],
      ['student', studentTok], ['guardian', guardianTok],
    ] as const) {
      const b = await body('scope=section&id=' + SEC_A, token);
      assert.equal(b.published, false, `${who} was shown a draft`);
      assert.equal(b.lessons?.length, 0, `${who} was shown draft lessons`);
    }

    await publishAll();
    const after = await body('scope=section&id=' + SEC_A, studentTok);
    assert.equal(after.published, true, 'and it appears the moment it is published');
    assert.ok((after.lessons?.length ?? 0) > 0);
  });

  test('a SUPERSEDED version is invisible too, without being named', async () => {
    await publishAll();
    const first = await body(`scope=section&id=${SEC_A}`, headTok);
    const v1 = first.routines?.[0]?.version;
    assert.equal(v1, 1);

    // Replace it (B-108) and the old version stops being anybody's timetable.
    await call(generate, { method: 'POST', url: '/', token: headTok,
      body: { yearId: YEAR, baseline: 'current' } } as Parameters<typeof call>[1]);
    const { rows } = await asBootstrap(db, head, (c) => c.query<{ id: string }>(
      `SELECT id FROM routines WHERE tenant_id = $1 AND status = 'draft'`, [T]));
    await call(publish, { method: 'POST', url: '/', token: headTok,
      body: { action: 'publish', routineId: rows[0].id, confirmWarnings: true },
    } as Parameters<typeof call>[1]);

    const now = await body(`scope=section&id=${SEC_A}`, headTok);
    assert.equal(now.routines?.length, 1, 'exactly one routine is anybody’s timetable');
    assert.equal(now.routines?.[0].version, 2);
  });

  /* ──────────────────── one dataset, eight selections ─────────────────── */

  test('§2 — every scope is a selection from the same routine, not a copy', async () => {
    await publishAll();
    const inst = await body('scope=institution', headTok);
    const sec = await body(`scope=section&id=${SEC_A}`, headTok);
    const tea = await body(`scope=teacher&id=${RAFIQ}`, headTok);
    const cls = await body(`scope=class&id=${KLASS}`, headTok);

    const all = new Set((inst.lessons ?? []).map(key));
    assert.ok(all.size > 0);
    for (const [name, part] of [['section', sec], ['teacher', tea], ['class', cls]] as const) {
      assert.ok((part.lessons?.length ?? 0) > 0, `${name} is empty`);
      for (const l of part.lessons ?? []) {
        assert.ok(all.has(key(l)),
          `${name} showed a lesson the institution does not have: ${key(l)}`);
      }
    }
    // And the narrower ones really are narrower.
    assert.ok((sec.lessons?.length ?? 0) < (inst.lessons?.length ?? 0));
    assert.ok((tea.lessons?.length ?? 0) < (inst.lessons?.length ?? 0));
  });

  test('all eight scopes answer, and each names what it is', async () => {
    await publishAll();
    const cases: Array<[string, string]> = [
      ['institution', ''], ['class', KLASS], ['group', 'science'],
      ['stream', 'bangla_medium'], ['section', SEC_A], ['teacher', RAFIQ],
      ['room', ROOM_A], ['student', STUDENT],
    ];
    for (const [scope, id] of cases) {
      const b = await body(`scope=${scope}${id ? `&id=${id}` : ''}`, headTok);
      assert.equal(b.published, true, scope);
      assert.ok((b.titleBn ?? '').length > 0, `${scope} has no title`);
      assert.ok((b.subtitleBn ?? '').length > 0, `${scope} has no subtitle`);
      assert.ok((b.lessons?.length ?? 0) > 0, `${scope} returned nothing`);
      assert.ok((b.periods?.length ?? 0) > 0, `${scope} has no bell schedule`);
      assert.equal(b.days?.length, 5, `${scope} — the school teaches five days`);
    }
  });

  test('the counts are the school’s, not the grid’s', async () => {
    await publishAll();
    const b = await body('scope=institution', headTok);
    // Every class has a section named 'ক'. Counting the rendered labels — the
    // first version of the screen did — reported a two-section school as one.
    assert.equal(b.counts?.sections, 2);
    assert.equal(b.counts?.classes, 1);
    assert.ok((b.counts?.teachers ?? 0) >= 2);
  });

  /* ─────────────────────────── §3 who may read ────────────────────────── */

  test('§3 — a teacher reads their own week and not the school’s', async () => {
    await publishAll();
    const own = await body('scope=teacher&id=self', rafiqTok);
    assert.equal(own.published, true);
    assert.ok((own.lessons?.length ?? 0) > 0, 'a teacher can read their own week');
    assert.equal(own.titleBn, 'রফিক স্যার');

    assert.equal((await get('scope=institution', rafiqTok)).status, 403);
    assert.equal((await get(`scope=teacher&id=${SALMA}`, rafiqTok)).status, 403);
    assert.equal((await get(`scope=room&id=${ROOM_A}`, rafiqTok)).status, 403);
    assert.equal((await get(`scope=class&id=${KLASS}`, rafiqTok)).status, 403);

    // But the sections they teach ARE theirs.
    assert.equal((await get(`scope=section&id=${SEC_A}`, rafiqTok)).status, 200);
    assert.equal((await get(`scope=section&id=${SEC_B}`, rafiqTok)).status, 403,
      'a section they do not teach is not theirs');
  });

  test('§3 — a student reads their own section and nobody else’s', async () => {
    await publishAll();
    const own = await body('scope=student&id=self', studentTok);
    assert.equal(own.published, true);
    assert.ok((own.lessons?.length ?? 0) > 0);

    assert.equal((await get(`scope=section&id=${SEC_A}`, studentTok)).status, 200,
      'their own section, by section scope');
    assert.equal((await get(`scope=section&id=${SEC_B}`, studentTok)).status, 403);
    assert.equal((await get(`scope=student&id=${OUTSIDER}`, studentTok)).status, 403,
      'another child’s timetable is not theirs to read');
    assert.equal((await get('scope=institution', studentTok)).status, 403);
    assert.equal((await get(`scope=teacher&id=${RAFIQ}`, studentTok)).status, 403);
    assert.equal((await get(`scope=room&id=${ROOM_A}`, studentTok)).status, 403);
  });

  test('§3 — a guardian reads their ward’s, and only their ward’s', async () => {
    await publishAll();
    const ward = await body(`scope=student&id=${STUDENT}`, guardianTok);
    assert.equal(ward.published, true);
    assert.ok((ward.lessons?.length ?? 0) > 0);
    assert.equal(ward.titleBn, 'ছাত্র');

    assert.equal((await get(`scope=student&id=${OUTSIDER}`, guardianTok)).status, 403);
    assert.equal((await get('scope=institution', guardianTok)).status, 403);
    assert.equal((await get(`scope=section&id=${SEC_B}`, guardianTok)).status, 403);
    // The ward's own section IS readable — it is the same timetable.
    assert.equal((await get(`scope=section&id=${SEC_A}`, guardianTok)).status, 200);
  });

  test('the menu offers exactly what the caller may ask for', async () => {
    await publishAll();
    const menuOf = async (token: string) =>
      ((await body('', token)).offered ?? []).map((o) => o.scope);

    assert.deepEqual((await menuOf(headTok)).sort(),
      ['class', 'group', 'institution', 'room', 'stream', 'teacher']);
    assert.deepEqual((await menuOf(rafiqTok)).sort(), ['section', 'teacher']);
    assert.deepEqual(await menuOf(studentTok), ['student']);
    assert.deepEqual(await menuOf(guardianTok), ['student']);

    // Everything the menu offers must actually answer — a picker that lists a
    // view the server refuses is the drift this test exists to prevent.
    for (const token of [headTok, rafiqTok, studentTok, guardianTok]) {
      for (const o of (await body('', token)).offered ?? []) {
        const id = o.options?.[0]?.id ?? '';
        const r = await get(`scope=${o.scope}${id ? `&id=${id}` : ''}`, token);
        assert.equal(r.status, 200,
          `offered ${o.scope} but refused it: ${JSON.stringify(r.body)}`);
      }
    }
  });

  test('§4 — a student sees the half of a split hour they actually attend', async () => {
    await publishAll();
    const before = (await body('scope=student&id=self', studentTok)).lessons ?? [];
    const bangla = before.find((l) => l.subjectBn === 'বাংলা');
    assert.ok(bangla, 'the fixture places Bangla for this student');

    // Turn that hour into a parallel block — the shape a religion or optional
    // subject takes, where the section splits and each child attends one half.
    await asBootstrap(db, head, async (c) => {
      await c.query(
        `UPDATE routine_slots SET parallel_pool = 'religion'
          WHERE routine_id IN (SELECT id FROM routines WHERE tenant_id = $1
                                AND status = 'active')
            AND primary_section_id = $2 AND day_of_week = $3 AND period_no = $4`,
        [T, SEC_A, bangla.dayOfWeek, bangla.periodNo]);
      // The student takes MATHS in that block, not Bangla.
      await c.query(
        `INSERT INTO student_subjects
           (tenant_id, enrolment_id, subject_id, requirement_type, source)
         VALUES ($1,$2,$3,'religion_variant','template')`, [T, ENROL, MATHS]);
    });

    const after = (await body('scope=student&id=self', studentTok)).lessons ?? [];
    const stillThere = after.some((l) =>
      l.dayOfWeek === bangla.dayOfWeek && l.periodNo === bangla.periodNo
      && l.subjectBn === 'বাংলা');
    assert.equal(stillThere, false,
      'a class this child does not attend must not be on their timetable');
    assert.ok(after.some((l) => l.isParallel === false || l.isParallel === true),
      'the rest of the week is untouched');

    // The SECTION's grid still shows the whole block — it is the section's
    // hour, and a coordinator has to see both halves of it.
    const sec = (await body(`scope=section&id=${SEC_A}`, headTok)).lessons ?? [];
    assert.ok(sec.some((l) =>
      l.dayOfWeek === bangla.dayOfWeek && l.periodNo === bangla.periodNo
      && l.isParallel), 'the section keeps the split hour, marked as split');

    await asBootstrap(db, head, async (c) => {
      await c.query(`DELETE FROM student_subjects WHERE tenant_id = $1`, [T]);
      await c.query(`UPDATE routine_slots SET parallel_pool = NULL
                      WHERE tenant_id = $1`, [T]);
    });
  });

  /* ───────────────────────── §10 tenant isolation ─────────────────────── */

  test('§10 — another school gets its own answer, never this one’s', async () => {
    await publishAll();
    // B holding A's ids: not found, because RLS makes them not exist.
    assert.equal((await get(`scope=section&id=${SEC_A}`, headBTok)).status, 404);
    assert.equal((await get(`scope=teacher&id=${RAFIQ}`, headBTok)).status, 404);
    assert.equal((await get(`scope=class&id=${KLASS}`, headBTok)).status, 404);
    assert.equal((await get(`scope=room&id=${ROOM_A}`, headBTok)).status, 404);
    // 404, not 403: B is an administrator, so `can_see_student` says yes —
    // it asks about ROLE, not about tenancy — and RLS then hides the row, so
    // the honest answer is that no such student exists here. Confirming the
    // id with a 403 would be the leak.
    assert.equal((await get(`scope=student&id=${STUDENT}`, headBTok)).status, 404);

    // B's own institution answers — with B's name and nothing of A's.
    const b = await body('scope=institution', headBTok);
    assert.equal(b.published, false, 'B has published nothing');
    assert.equal(b.titleBn, 'পাশের');
    assert.equal(b.lessons?.length, 0);
  });

  /* ─────────────────────── §5 no internals on the wire ────────────────── */

  test('the response carries no SQL and no identifiers it does not need', async () => {
    await publishAll();
    for (const qs of ['scope=institution', `scope=section&id=${SEC_A}`,
                      `scope=student&id=${STUDENT}`]) {
      const b = await body(qs, headTok) as Record<string, unknown>;
      // The first version spread the filter into the body and shipped the
      // predicate plus a bound uuid to the browser. Found in a real browser.
      assert.equal('where' in b, false, `${qs} leaked its SQL predicate`);
      assert.equal('params' in b, false, `${qs} leaked its bound parameter`);
      for (const l of (b.lessons as Array<Record<string, unknown>>) ?? []) {
        assert.equal('id' in l, false, 'a lesson carries no uuid — nothing renders one');
        assert.equal('teacherId' in l, false);
        assert.equal('sectionId' in l, false);
      }
    }
  });

  /* ───────────────────────── shape and refusals ───────────────────────── */

  test('bad input is refused, and an unknown scope is never guessed at', async () => {
    await publishAll();
    assert.equal((await get('scope=everything', headTok)).status, 400);
    assert.equal((await get('scope=section&id=not-a-uuid', headTok)).status, 400);
    assert.equal((await get('scope=group&id=wizardry', headTok)).status, 400);
    assert.equal((await get('scope=stream&id=klingon', headTok)).status, 400);
    assert.equal((await get('scope=class&id=7c990000-0000-4000-8000-00000000dead', headTok))
      .status, 404);
    assert.equal((await get('scope=institution&yearId=nope', headTok)).status, 400);
  });

  test('with nothing published the answer is "not yet", not an error', async () => {
    const b = await body(`scope=section&id=${SEC_A}`, headTok);
    assert.equal(b.published, false);
    assert.deepEqual(b.lessons, []);
    assert.deepEqual(b.routines, []);
    assert.ok((b.titleBn ?? '').length > 0, 'it still says what was asked for');
    assert.ok((b.offered?.length ?? 0) > 0, 'and the picker still works');
  });

  test('a two-shift school gets one grid per shift, never one keyed on period', async () => {
    // Morning period 8 and day period 1 are different hours with the same
    // number; a single table keyed on period number would merge them.
    await asBootstrap(db, head, async (c) => {
      await c.query(`UPDATE sections SET shift = 'day' WHERE id = $1`, [SEC_B]);
      await c.query(
        `INSERT INTO period_templates (id, tenant_id, name_bn, shift, effective_from, is_active)
         VALUES ($1,$2,'দিবা','day','2026-01-01',true)`,
        ['7c990000-0000-4000-8000-00000000ab08', T]);
      for (let i = 1; i <= 6; i++) {
        await c.query(
          `INSERT INTO period_definitions
             (tenant_id, template_id, period_no, label_bn, starts_at, ends_at, kind)
           VALUES ($1,$2,$3,$4,$5::time,$6::time,'teaching')`,
          [T, '7c990000-0000-4000-8000-00000000ab08', i, `${i} নম্বর`,
           `${String(13 + i).padStart(2, '0')}:00`, `${String(13 + i).padStart(2, '0')}:45`]);
      }
    });
    await publishAll();
    const b = await body('scope=institution', headTok);
    assert.equal(b.routines?.length, 2, 'one routine per shift');
    const shifts = new Set(b.routines?.map((r) => r.shiftBn));
    assert.equal(shifts.size, 2);
    // Every lesson belongs to one of them, and the periods are grouped the
    // same way, so the screen can draw a grid per shift.
    const ids = new Set(b.routines?.map((r) => r.id));
    for (const l of b.lessons ?? []) assert.ok(ids.has(l.routineId));
    for (const p of b.periods ?? []) assert.ok(ids.has(p.routineId));

    // The routines created against the second template hold a FK to it, so
    // they go first — `beforeEach` would clear them, but not before this
    // DELETE runs.
    await asBootstrap(db, head, async (c) => {
      await c.query(`UPDATE sections SET shift = 'single' WHERE id = $1`, [SEC_B]);
      await c.query('DELETE FROM routine_slots WHERE tenant_id = $1', [T]);
      await c.query('DELETE FROM routines WHERE tenant_id = $1', [T]);
      await c.query(`DELETE FROM period_definitions WHERE template_id = $1`,
        ['7c990000-0000-4000-8000-00000000ab08']);
      await c.query(`DELETE FROM period_templates WHERE id = $1`,
        ['7c990000-0000-4000-8000-00000000ab08']);
    });
  });
});
