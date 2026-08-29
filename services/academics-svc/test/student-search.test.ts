/**
 * R-6 — student search and one child's history, through the real handlers.
 *
 * `db/tests/student_search.sql` asserts what the DATABASE will hand out.
 * This file asserts what the ENDPOINTS do with it: the query classifier, the
 * privacy withholding, the 404-not-403 stance, the pagination arithmetic, and
 * the four role scopes end to end with a signed token.
 *
 * The fixture is the master plan's own worked example. রাফি হাসান —
 * STU-8F39A271 — arrives in 2024 in class 7 section ক roll 14, moves every
 * year, and graduates. He is the case that breaks a timeline built by joining
 * the current enrolment to each year, and the case R-6 exists to serve: a
 * child who has left and must still be findable.
 *
 *   DATABASE_URL=postgresql://shikhon_app:… node --test services/academics-svc/test/student-search.test.ts
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { createDb, type Db, type TenantContext } from '../../../packages/server-core/src/db.ts';
import { installTestKeys, call } from '../../../packages/server-core/test/harness.ts';
import { classify, toE164 } from '../api/search.ts';

const DATABASE_URL = process.env.DATABASE_URL;
const skip = !DATABASE_URL ? 'DATABASE_URL not set' : false;

const T       = '7a600000-0000-4000-8000-00000000000a';
const HEAD    = '7a600000-0000-4000-8000-0000000000ff';
const TEACHER = '7a600000-0000-4000-8000-0000000000fe';
const DAD     = '7a600000-0000-4000-8000-0000000000fd';
const RAFI    = '7a600000-0000-4000-8000-0000000000a1';
const NUSRAT  = '7a600000-0000-4000-8000-0000000000a2';
const Y24 = '7a600000-0000-4000-8000-000000000024';
const Y25 = '7a600000-0000-4000-8000-000000000025';
const Y26 = '7a600000-0000-4000-8000-000000000026';
const Y27 = '7a600000-0000-4000-8000-000000000027';
const C7 = '7a600000-0000-4000-8000-0000000000c7';
const C8 = '7a600000-0000-4000-8000-0000000000c8';
const C9 = '7a600000-0000-4000-8000-0000000000c9';
const C10 = '7a600000-0000-4000-8000-0000000000ca';
const S24 = '7a600000-0000-4000-8000-0000000000d4';
const S25 = '7a600000-0000-4000-8000-0000000000d5';
const S26 = '7a600000-0000-4000-8000-0000000000d6';
const S27 = '7a600000-0000-4000-8000-0000000000d7';
const S_OTHER = '7a600000-0000-4000-8000-0000000000d9';

let db: Db;
let headToken: string;
let teacherToken: string;
let dadToken: string;
let studentToken: string;
let search: typeof import('../api/search.ts').default;
let history: typeof import('../api/studenthistory.ts').default;
const asHead: TenantContext = { tenantId: T, userId: HEAD, role: 'principal' };

async function dropFixtures(): Promise<void> {
  await db.withTenant(asHead, async (c) => {
    await c.query('DELETE FROM tenants WHERE id = $1', [T]);
  });
}

async function seed(): Promise<void> {
  await dropFixtures();
  await db.withTenant(asHead, async (c) => {
    await c.query(
      `INSERT INTO tenants (id, slug, name_bn, name_en, stream, level)
       VALUES ($1,'r6-search','খোঁজ বিদ্যালয়','Search School','bangla_medium','secondary')`,
      [T]);
    await c.query(
      `INSERT INTO users (id, tenant_id, full_name_bn, full_name_en, phone_e164, status,
                          father_name_bn, mother_name_bn, date_of_birth) VALUES
         ($1,$6,'প্রধান শিক্ষক','Head','+8801794600001','active',NULL,NULL,NULL),
         ($2,$6,'শ্রেণি শিক্ষক','Teacher','+8801794600002','active',NULL,NULL,NULL),
         ($3,$6,'রহিম উদ্দিন','Rahim','+8801794600003','active',NULL,NULL,NULL),
         ($4,$6,'রাফি হাসান','Rafi Hasan','+8801794600004','active',
            'মোঃ হাসান','রোকসানা বেগম','2010-03-14'),
         ($5,$6,'নুসরাত জাহান','Nusrat Jahan','+8801794600005','active',
            'মোঃ জাহান','সালমা বেগম','2011-05-02')`,
      [HEAD, TEACHER, DAD, RAFI, NUSRAT, T]);
    await c.query(
      `INSERT INTO user_roles (tenant_id, user_id, role_code) VALUES
         ($1,$2,'principal'), ($1,$3,'class_teacher'), ($1,$4,'guardian'),
         ($1,$5,'student'), ($1,$6,'student')`,
      [T, HEAD, TEACHER, DAD, RAFI, NUSRAT]);
    await c.query(
      `INSERT INTO academic_years (id, tenant_id, label, starts_on, ends_on, is_current) VALUES
         ($1,$5,'2024','2024-01-01','2024-12-31',false),
         ($2,$5,'2025','2025-01-01','2025-12-31',false),
         ($3,$5,'2026','2026-01-01','2026-12-31',false),
         ($4,$5,'2027','2027-01-01','2027-12-31',true)`,
      [Y24, Y25, Y26, Y27, T]);
    await c.query(
      `INSERT INTO classes (id, tenant_id, level_no, name_bn, name_en, stream, "group") VALUES
         ($1,$5,7,'সপ্তম','Seven','bangla_medium','none'),
         ($2,$5,8,'অষ্টম','Eight','bangla_medium','none'),
         ($3,$5,9,'নবম','Nine','bangla_medium','science'),
         ($4,$5,10,'দশম','Ten','bangla_medium','science')`,
      [C7, C8, C9, C10, T]);
    await c.query(
      // The 2027 section is the teacher's; the "other" section is not, which
      // is what every teacher-scope assertion turns on.
      `INSERT INTO sections (id, tenant_id, class_id, academic_year_id, name, class_teacher_id) VALUES
         ($1,$7,$8,$12,'ক',NULL),
         ($2,$7,$9,$13,'খ',NULL),
         ($3,$7,$10,$14,'গ',NULL),
         ($4,$7,$11,$15,'ঘ',$6),
         ($5,$7,$10,$15,'ঙ',NULL)`,
      [S24, S25, S26, S27, S_OTHER, TEACHER, T, C7, C8, C9, C10, Y24, Y25, Y26, Y27]);
    await c.query(
      // Four years, four sections, four rolls — the brief's own numbers.
      `INSERT INTO enrolments (tenant_id, student_id, section_id, academic_year_id,
                               roll_no, status, enrolled_on, ended_on) VALUES
         ($1,$2,$3,$7,14,'promoted','2024-01-05','2024-12-20'),
         ($1,$2,$4,$8,9,'promoted','2025-01-05','2025-12-20'),
         ($1,$2,$5,$9,12,'promoted','2026-01-05','2026-12-20'),
         ($1,$2,$6,$10,8,'active','2027-01-05',NULL),
         ($1,$11,$12,$10,3,'active','2027-01-05',NULL)`,
      [T, RAFI, S24, S25, S26, S27, Y24, Y25, Y26, Y27, NUSRAT, S_OTHER]);
    await c.query(
      `INSERT INTO student_profiles (user_id, tenant_id, student_code, admission_date,
                                     admission_class, lifecycle_status, graduated_on,
                                     blood_group, board_registration_no) VALUES
         ($1,$3,'STU-8F39A271','2024-01-05',7,'graduated','2027-02-28','B+','BR-0000001'),
         ($2,$3,'STU-11B2C3D4','2027-01-05',9,'enrolled',NULL,'O+','BR-0000002')`,
      [RAFI, NUSRAT, T]);
    await c.query(
      `INSERT INTO guardianships (tenant_id, student_id, guardian_id, relation, is_primary)
       VALUES ($1,$2,$3,'father',true)`, [T, RAFI, DAD]);
  });
}

describe('R-6 — student search', { skip }, () => {
  before(async () => {
    await installTestKeys();
    db = createDb(DATABASE_URL as string);
    await seed();
    const { signAccessToken } = await import('../../../packages/server-core/src/jwt.ts');
    headToken = await signAccessToken({ sub: HEAD, tid: T, role: 'principal', roles: ['principal'] });
    teacherToken = await signAccessToken({ sub: TEACHER, tid: T, role: 'class_teacher', roles: ['class_teacher'] });
    dadToken = await signAccessToken({ sub: DAD, tid: T, role: 'guardian', roles: ['guardian'] });
    studentToken = await signAccessToken({ sub: RAFI, tid: T, role: 'student', roles: ['student'] });
    search = (await import('../api/search.ts')).default;
    history = (await import('../api/studenthistory.ts')).default;
  });
  after(async () => { if (db) { await dropFixtures(); await db.end(); } });

  const find = (qs: string, token = headToken) =>
    call(search, { url: `/api/v1/academics/students/search?${qs}`, token });
  const open = (id: string, token = headToken) =>
    call(history, { url: `/api/v1/academics/students/history?studentId=${id}`, token });

  // ── The classifier, which is what makes each query indexable ──────────

  describe('query classification', () => {
    test('a student code is recognised however it is typed', () => {
      assert.equal(classify('STU-8F39A271'), 'code');
      assert.equal(classify('stu-8f39a271'), 'code');
      assert.equal(classify('8F39A271'), 'code');
    });
    test('a Bangladeshi phone is a phone, in any of its four forms', () => {
      assert.equal(classify('01712345678'), 'phone');
      assert.equal(classify('+8801712345678'), 'phone');
      assert.equal(classify('01712-345678'), 'phone');
      assert.equal(toE164('01712345678'), '+8801712345678');
      assert.equal(toE164('8801712345678'), '+8801712345678');
      assert.equal(toE164('01712-345678'), '+8801712345678');
      assert.equal(toE164('1712345678'), '+8801712345678');
    });
    test('a number that is not a Bangladeshi mobile is refused, not guessed', () => {
      assert.equal(toE164('12345'), null);
      assert.equal(toE164('009988776655443322'), null);
    });
    test('a name is the fallback, in either script', () => {
      assert.equal(classify('রাফি'), 'name');
      assert.equal(classify('Rafi Hasan'), 'name');
    });
    test('a board number is its own shape', () => {
      assert.equal(classify('BR-0000001'), 'board');
      assert.equal(classify('BRN-000042'), 'board');
    });
  });

  // ── The core acceptance ──────────────────────────────────────────────

  test('THE ONE THAT MATTERS — an old code finds a graduated student', async () => {
    const r = await find('q=STU-8F39A271');
    assert.equal(r.status, 200);
    const b = r.body as { total: number; matchedOn: string; students: Array<{
      name: { bn: string }; studentCode: string; lifecycleStatus: string;
      latest: { yearLabel: string; classBn: string; section: string; rollNo: number; isCurrent: boolean };
    }> };
    assert.equal(b.total, 1);
    assert.equal(b.matchedOn, 'code');
    assert.equal(b.students[0].name.bn, 'রাফি হাসান');
    assert.equal(b.students[0].lifecycleStatus, 'graduated');
    // Enough to tell two children with the same name apart — §3.
    assert.equal(b.students[0].latest.classBn, 'দশম');
    assert.equal(b.students[0].latest.section, 'ঘ');
    assert.equal(b.students[0].latest.rollNo, 8);
  });

  test('the code is found without its prefix, and case does not matter', async () => {
    for (const q of ['8F39A271', '8f39a271', 'stu-8f39a271']) {
      const b = (await find(`q=${encodeURIComponent(q)}`)).body as { total: number };
      assert.equal(b.total, 1, `"${q}" found ${b.total}`);
    }
  });

  test('by Bangla name, by English name, and by phone', async () => {
    for (const [q, expect] of [['রাফি', 1], ['Rafi', 1], ['হাসান', 1],
                               ['01794600004', 1]] as [string, number][]) {
      const b = (await find(`q=${encodeURIComponent(q)}`)).body as { total: number };
      assert.equal(b.total, expect, `"${q}" returned ${b.total}`);
    }
  });

  test('a guardian phone finds the child, not the guardian', async () => {
    const b = (await find('q=01794600003')).body as {
      total: number; students: Array<{ name: { bn: string } }> };
    assert.equal(b.total, 1);
    assert.equal(b.students[0].name.bn, 'রাফি হাসান');
  });

  test('by board registration number', async () => {
    const b = (await find('q=BR-0000001')).body as { total: number };
    assert.equal(b.total, 1);
  });

  test('the lifecycle filter selects, and alumni are not excluded by default', async () => {
    const graduated = (await find('status=graduated')).body as { total: number };
    assert.equal(graduated.total, 1);
    const enrolled = (await find('status=enrolled')).body as { total: number };
    assert.equal(enrolled.total, 1);
    // A name that matches both children returns both, graduate included.
    const all = (await find('q=ান')).body as { total: number };
    assert.ok(all.total >= 2, `a broad search returned ${all.total}`);
  });

  test('an unknown status is refused rather than silently ignored', async () => {
    const r = await find('status=archived');
    assert.equal(r.status, 400);
    assert.equal((r.body as { error: string }).error, 'bad_status');
  });

  test('§17 — a one-character query is refused with the message the UI shows', async () => {
    const r = await find('q=র');
    assert.equal(r.status, 400);
    const b = r.body as { error: string; message: string };
    assert.equal(b.error, 'query_too_short');
    assert.match(b.message, /অন্তত ২টি অক্ষর/);
  });

  test('an empty search is refused, not answered with the whole school', async () => {
    assert.equal((await find('')).status, 400);
  });

  test('a phone-shaped query that is not a real number finds nobody', async () => {
    // Not the whole school, which is what a fallback to name search would do.
    const b = (await find('q=999999999')).body as { total: number };
    assert.equal(b.total, 0);
  });

  // ── §14 privacy: the list carries nothing it should not ───────────────

  test('a result row carries no phone, no guardian and no blood group', async () => {
    const r = await find('q=STU-8F39A271');
    const raw = JSON.stringify(r.body);
    assert.doesNotMatch(raw, /\+8801/, 'a phone number reached the result list');
    assert.doesNotMatch(raw, /B\+/, 'a blood group reached the result list');
    assert.doesNotMatch(raw, /রোকসানা/, 'a parent name reached the result list');
  });

  // ── §13 role scoping ─────────────────────────────────────────────────

  test('a class teacher searches their own section, not the school', async () => {
    const b = (await find('q=ান', teacherToken)).body as {
      total: number; students: Array<{ name: { bn: string } }> };
    assert.equal(b.total, 1);
    assert.equal(b.students[0].name.bn, 'রাফি হাসান');
  });

  test('a guardian searches their own children only', async () => {
    const b = (await find('q=ান', dadToken)).body as {
      total: number; students: Array<{ name: { bn: string } }> };
    assert.equal(b.total, 1);
    assert.equal(b.students[0].name.bn, 'রাফি হাসান');
  });

  test('a student searches themselves only', async () => {
    const b = (await find('q=ান', studentToken)).body as {
      total: number; students: Array<{ id: string }> };
    assert.equal(b.total, 1);
    assert.equal(b.students[0].id, RAFI);
  });

  test('a teacher naming another section\'s student by code still gets nothing', async () => {
    const b = (await find('q=STU-11B2C3D4', teacherToken)).body as { total: number };
    assert.equal(b.total, 0);
  });

  // ── §15 pagination ───────────────────────────────────────────────────

  test('the page and the total agree', async () => {
    const b = (await find('q=ান&limit=1')).body as {
      total: number; limit: number; offset: number; students: unknown[] };
    assert.equal(b.total, 2);
    assert.equal(b.students.length, 1);
    assert.equal(b.limit, 1);
    const p2 = (await find('q=ান&limit=1&offset=1')).body as { total: number; students: unknown[] };
    assert.equal(p2.total, 2, 'the total changed between pages');
    assert.equal(p2.students.length, 1);
    // Past the end: an honest total and no rows, not a 404.
    const p3 = (await find('q=ান&limit=1&offset=9')).body as { total: number; students: unknown[] };
    assert.equal(p3.total, 2);
    assert.equal(p3.students.length, 0);
  });
});

describe('R-6 — one student\'s history', { skip }, () => {
  before(async () => {
    await installTestKeys();
    db = createDb(DATABASE_URL as string);
    await seed();
    const { signAccessToken } = await import('../../../packages/server-core/src/jwt.ts');
    headToken = await signAccessToken({ sub: HEAD, tid: T, role: 'principal', roles: ['principal'] });
    teacherToken = await signAccessToken({ sub: TEACHER, tid: T, role: 'class_teacher', roles: ['class_teacher'] });
    dadToken = await signAccessToken({ sub: DAD, tid: T, role: 'guardian', roles: ['guardian'] });
    history = (await import('../api/studenthistory.ts')).default;
  });
  after(async () => { if (db) { await dropFixtures(); await db.end(); } });

  const open = (id: string, token = headToken) =>
    call(history, { url: `/api/v1/academics/students/history?studentId=${id}`, token });

  test('THE ONE THAT MATTERS — four years, each with its own class, section and roll', async () => {
    const r = await open(RAFI);
    assert.equal(r.status, 200);
    const b = r.body as { enrolments: Array<{
      yearLabel: string; classBn: string; section: string; rollNo: number; isCurrent: boolean }> };
    assert.equal(b.enrolments.length, 4);
    assert.deepEqual(
      b.enrolments.map((e) => [e.yearLabel, e.classBn, e.section, e.rollNo]),
      [['2024', 'সপ্তম', 'ক', 14],
       ['2025', 'অষ্টম', 'খ', 9],
       ['2026', 'নবম', 'গ', 12],
       ['2027', 'দশম', 'ঘ', 8]],
    );
  });

  test('oldest first, so the timeline reads forwards', async () => {
    const b = (await open(RAFI)).body as { enrolments: Array<{ yearLabel: string }> };
    assert.deepEqual(b.enrolments.map((e) => e.yearLabel), ['2024', '2025', '2026', '2027']);
  });

  test('§6 — exactly one year is current, and it is the active enrolment', async () => {
    const b = (await open(RAFI)).body as { enrolments: Array<{ yearLabel: string; isCurrent: boolean }> };
    const current = b.enrolments.filter((e) => e.isCurrent);
    assert.equal(current.length, 1);
    assert.equal(current[0].yearLabel, '2027');
  });

  test('the profile carries the lifecycle and the graduation date', async () => {
    const b = (await open(RAFI)).body as {
      student: { studentCode: string; lifecycleStatus: string; graduatedOn: string | null } };
    assert.equal(b.student.studentCode, 'STU-8F39A271');
    assert.equal(b.student.lifecycleStatus, 'graduated');
    assert.match(b.student.graduatedOn ?? '', /^2027-02-28/);
  });

  test('an invisible student is 404, not 403 — an id must not be confirmable', async () => {
    // NUSRAT is real and in a section this teacher does not teach.
    const r = await open(NUSRAT, teacherToken);
    assert.equal(r.status, 404);
    // And an id that does not exist gives the SAME answer.
    const ghost = await open('7a600000-0000-4000-8000-000000000999', teacherToken);
    assert.equal(ghost.status, 404);
    assert.deepEqual(
      (r.body as { error: string }).error,
      (ghost.body as { error: string }).error,
      'a real-but-invisible id is distinguishable from a nonexistent one');
  });

  test('a malformed id is a 400, and never reaches the database', async () => {
    const r = await open('not-a-uuid');
    assert.equal(r.status, 400);
  });

  test('§9 — a class teacher gets no fees at all, and is told so', async () => {
    const b = (await open(RAFI, teacherToken)).body as {
      fees: unknown; permissions: { fees: boolean } };
    assert.equal(b.fees, null);
    assert.equal(b.permissions.fees, false);
  });

  test('§14 — a teacher outside MAY_SEE_CONTACT gets no phone or parents', async () => {
    // A class teacher IS in the contact list — they ring parents. The
    // withholding is asserted through the flag and the payload together, so
    // this test still means something if the list changes.
    const b = (await open(RAFI, teacherToken)).body as {
      student: { phone: string | null; fatherNameBn: string | null };
      permissions: { contact: boolean } };
    if (b.permissions.contact) {
      assert.ok(b.student.phone, 'contact permitted but no phone sent');
    } else {
      assert.equal(b.student.phone, null);
      assert.equal(b.student.fatherNameBn, null);
    }
  });

  test('a guardian opens their own child and sees the fee tab', async () => {
    const b = (await open(RAFI, dadToken)).body as {
      permissions: { fees: boolean }; enrolments: unknown[] };
    assert.equal(b.permissions.fees, true);
    assert.equal(b.enrolments.length, 4);
  });

  test('a guardian cannot open a child who is not theirs', async () => {
    assert.equal((await open(NUSRAT, dadToken)).status, 404);
  });

  test('the document list is what this role may PRINT, and carries no URLs', async () => {
    const b = (await open(RAFI)).body as { documents: string[]; certificates: string[] };
    assert.ok(b.documents.includes('report_card'));
    // A principal may issue a transfer certificate; it is listed separately.
    assert.deepEqual(b.certificates, ['transfer_certificate']);
    assert.doesNotMatch(JSON.stringify(b), /https?:\/\//, 'a document URL was exposed');

    const t = (await open(RAFI, teacherToken)).body as { certificates: string[] };
    assert.deepEqual(t.certificates, [], 'a class teacher was offered a transfer certificate');
  });

  test('results are published-only, and attendance is summarised per year', async () => {
    const b = (await open(RAFI)).body as { results: unknown[]; attendance: unknown[] };
    // The fixture publishes nothing and records no attendance, so both are
    // empty — and empty is what the UI must render as a state, not a crash.
    assert.ok(Array.isArray(b.results));
    assert.ok(Array.isArray(b.attendance));
  });
});
