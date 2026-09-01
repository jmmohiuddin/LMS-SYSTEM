/**
 * Guardian home — F-1001, F-1002, F-203, wireframe §9.1
 *
 * The fixture is the case the ward switcher exists for: রহিম উদ্দিন has two
 * children at the school, in different classes, with different attendance,
 * different fees and only one of them holding a published result.
 *
 * The assertions that matter most are the negative ones. This persona has
 * the lowest technical comfort in the product and the guardian surface is
 * the one place where a leak is most likely — a guardian must see their
 * own children and nothing else, and the isolation must come from RLS
 * rather than from this endpoint remembering to filter.
 *
 *   DATABASE_URL=postgresql://shikhon_runtime:… node --test services/academics-svc/test/ward.test.ts
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { createDb, type Db, type TenantContext } from '../../../packages/server-core/src/db.ts';
import { installTestKeys, call, lockFixtures, unlockFixtures} from '../../../packages/server-core/test/harness.ts';

const DATABASE_URL = process.env.DATABASE_URL;
const skip = !DATABASE_URL ? 'DATABASE_URL not set' : false;

const T        = '7a400000-0000-4000-8000-00000000000a';
const HEAD     = '7a400000-0000-4000-8000-0000000000ff';
const RAHIM    = '7a400000-0000-4000-8000-0000000000a1';
const OTHER_G  = '7a400000-0000-4000-8000-0000000000a9';
const ANIKA    = '7a400000-0000-4000-8000-0000000000b1';
const BIJOY    = '7a400000-0000-4000-8000-0000000000b2';
const STRANGER = '7a400000-0000-4000-8000-0000000000b3';
const YEAR     = '7a400000-0000-4000-8000-000000000091';
const CLASS9   = '7a400000-0000-4000-8000-0000000000c9';
const CLASS6   = '7a400000-0000-4000-8000-0000000000c6';
const SEC9     = '7a400000-0000-4000-8000-0000000000d1';
const SEC6     = '7a400000-0000-4000-8000-0000000000d2';
const E_ANIKA  = '7a400000-0000-4000-8000-0000000000e1';
const E_BIJOY  = '7a400000-0000-4000-8000-0000000000e2';
const E_STRANGE= '7a400000-0000-4000-8000-0000000000e3';
const EXAM     = '7a400000-0000-4000-8000-000000000092';

let db: Db;
let rahimToken: string;
let otherGuardianToken: string;
let ward: typeof import('../api/ward.ts').default;
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
       VALUES ($1,'f1001','অভিভাবক','Guardian School','bangla_medium','secondary')`, [T]);
    await c.query(
      `INSERT INTO users (id, tenant_id, full_name_bn, full_name_en, phone_e164, status) VALUES
         ($1,$7,'প্রধান শিক্ষক','Head','+8801794100001','active'),
         ($2,$7,'রহিম উদ্দিন','Rahim','+8801794100002','active'),
         ($3,$7,'অন্য অভিভাবক','Other','+8801794100003','active'),
         ($4,$7,'আনিকা রহমান','Anika',NULL,'active'),
         ($5,$7,'বিজয় রহমান','Bijoy',NULL,'active'),
         ($6,$7,'অপরিচিত','Stranger',NULL,'active')`,
      [HEAD, RAHIM, OTHER_G, ANIKA, BIJOY, STRANGER, T]);
    await c.query(
      `INSERT INTO academic_years (id, tenant_id, label, starts_on, ends_on, is_current)
       VALUES ($1,$2,'2026','2026-01-01','2026-12-31',true)`, [YEAR, T]);
    await c.query(
      `INSERT INTO classes (id, tenant_id, level_no, name_bn, name_en, stream) VALUES
         ($1,$3,9,'নবম','Nine','bangla_medium'), ($2,$3,6,'ষষ্ঠ','Six','bangla_medium')`,
      [CLASS9, CLASS6, T]);
    await c.query(
      // student_count is left at 0: app.refresh_section_count maintains it
      // from enrolments, and seeding a number here would only be overwritten.
      `INSERT INTO sections (id, tenant_id, class_id, academic_year_id, name, student_count) VALUES
         ($1,$3,$4,$6,'ক',0), ($2,$3,$5,$6,'খ',0)`,
      [SEC9, SEC6, T, CLASS9, CLASS6, YEAR]);
    await c.query(
      `INSERT INTO enrolments (id, tenant_id, student_id, section_id, academic_year_id, roll_no, status) VALUES
         ($1,$4,$5,$8,$10,1,'active'),
         ($2,$4,$6,$9,$10,5,'active'),
         ($3,$4,$7,$8,$10,9,'active')`,
      [E_ANIKA, E_BIJOY, E_STRANGE, T, ANIKA, BIJOY, STRANGER, SEC9, SEC6, YEAR]);
    await c.query(
      `INSERT INTO guardianships (tenant_id, student_id, guardian_id, relation, is_primary) VALUES
         ($1,$2,$4,'father',true), ($1,$3,$4,'father',true), ($1,$5,$6,'father',true)`,
      [T, ANIKA, BIJOY, RAHIM, STRANGER, OTHER_G]);
    await c.query(
      `INSERT INTO user_roles (tenant_id, user_id, role_code) VALUES
         ($1,$2,'guardian'), ($1,$3,'guardian')`, [T, RAHIM, OTHER_G]);
  });
}

async function post(sql: string, params: unknown[]): Promise<void> {
  await db.withTenant(asHead, async (c) => { await c.query(sql, params); });
}

describe('guardian home (§9.1)', { skip }, () => {
  before(async () => {
    await installTestKeys();
    // Serialised against other runs of this same suite — the fixtures below
    // live at fixed uuids and two processes would delete each other's.
    await lockFixtures(DATABASE_URL as string);
    db = createDb(DATABASE_URL as string);
    await seed();
    const { signAccessToken } = await import('../../../packages/server-core/src/jwt.ts');
    rahimToken = await signAccessToken({ sub: RAHIM, tid: T, role: 'guardian', roles: ['guardian'] });
    otherGuardianToken = await signAccessToken({
      sub: OTHER_G, tid: T, role: 'guardian', roles: ['guardian'] });
    ward = (await import('../api/ward.ts')).default;
  });
  after(async () => { if (db) { await dropFixtures(); await db.end(); await unlockFixtures(); } });

  const get = (qs = '', token = rahimToken) =>
    call(ward, { url: `/api/v1/academics/ward${qs ? `?${qs}` : ''}`, token });

  test('F-203 — the switcher lists both children, with class and roll', async () => {
    const r = await get();
    assert.equal(r.status, 200);
    const b = r.body as { wards: Array<{ nameBn: string; sectionLabel: string; rollNo: number }> };
    assert.equal(b.wards.length, 2);
    // Ordered by class descending: the older child first, which is the one
    // a guardian is usually checking on.
    assert.deepEqual(b.wards.map((w) => w.nameBn), ['আনিকা রহমান', 'বিজয় রহমান']);
    assert.equal(b.wards[0].sectionLabel, 'নবম–ক');
    assert.equal(b.wards[0].rollNo, 1);
  });

  test('THE ONE THAT MATTERS — a guardian cannot open another family\'s child', async () => {
    // Not 403: a distinct code would confirm the student exists to
    // somebody who should not be able to learn that.
    const r = await get(`studentId=${STRANGER}`);
    assert.equal(r.status, 404);

    // And the other direction, so the fixture is not accidentally empty.
    const mine = await get(`studentId=${STRANGER}`, otherGuardianToken);
    assert.equal(mine.status, 200);
    assert.equal((mine.body as { student: { nameBn: string } }).student.nameBn, 'অপরিচিত');
  });

  test('the switcher list is scoped too, not just the detail', async () => {
    const r = await get('', otherGuardianToken);
    const b = r.body as { wards: Array<{ nameBn: string }> };
    assert.equal(b.wards.length, 1);
    assert.equal(b.wards[0].nameBn, 'অপরিচিত');
  });

  test('everything §9.1 draws arrives in ONE response', async () => {
    // The persona "may use the app four times a year — it must survive
    // being forgotten". Four sequential spinners is how it does not.
    const r = await get(`studentId=${ANIKA}`);
    const s = (r.body as { student: Record<string, unknown> }).student;
    for (const key of ['nameBn', 'sectionLabel', 'rollNo', 'attendance', 'fees', 'result']) {
      assert.ok(key in s, `${key} is present`);
    }
  });

  test('attendance excludes excused from the denominator', async () => {
    // ── Why these four days are not simply CURRENT_DATE - 3 … CURRENT_DATE ──
    //
    // `monthPercent` is month-to-date by design: the guardian screen renders
    // it as "এ মাসে ৯৪%", and the endpoint scopes on
    // `taken_on >= date_trunc('month', CURRENT_DATE)`. That contract is right
    // and is not what changed here.
    //
    // The fixture used to walk backwards from today, which silently assumed
    // four consecutive days always share a calendar month. They do from the
    // 4th onward and never on the 1st, 2nd or 3rd — on those dates the older
    // days belong to the previous month, the filter drops them, and the ratio
    // becomes whatever survives. On the 1st that is a single present day:
    // 100%, against an expected 67%. The test therefore failed on three days
    // of every month and passed on the rest, which is worse than failing
    // always, because it looks like a flake.
    //
    // The window below is anchored so that it always contains today AND
    // always lies inside the current month: it starts up to three days back,
    // clamped at the month's first day, and extends forward to make four.
    // Every month has at least 28 days, so month-start + 3 always exists.
    //
    //   1st  → 1st–4th      15th → 12th–15th      31st → 28th–31st
    //
    // Statuses are assigned relative to TODAY rather than by a fixed offset,
    // because today's position inside the window now varies: today is
    // present, then one more present, one absent, one excused — 2 of 3
    // counted, the excused day excluded from the denominator.
    await post(
      `INSERT INTO attendance_sessions
         (id, tenant_id, section_id, academic_year_id, taken_on, taken_by, taken_at)
       SELECT gen_random_uuid(),$1,$2,$3,d::date,$4,now()
         FROM generate_series(
                CURRENT_DATE - LEAST(3, EXTRACT(day FROM CURRENT_DATE)::int - 1),
                CURRENT_DATE - LEAST(3, EXTRACT(day FROM CURRENT_DATE)::int - 1) + 3,
                interval '1 day') d`,
      [T, SEC9, YEAR, HEAD]);
    await post(
      `WITH others AS (
         SELECT s.id, s.taken_on,
                row_number() OVER (ORDER BY s.taken_on) AS rn
           FROM attendance_sessions s
          WHERE s.section_id = $3 AND s.taken_on <> CURRENT_DATE
       )
       INSERT INTO attendance_records
         (tenant_id, session_id, student_id, section_id, taken_on, status, marked_by, marked_at)
       SELECT $1, s.id, $2, $3, s.taken_on,
              CASE
                WHEN s.taken_on = CURRENT_DATE THEN 'present'
                WHEN o.rn = 1 THEN 'present'
                WHEN o.rn = 2 THEN 'absent'
                ELSE 'excused' END::attendance_status,
              $4, now()
         FROM attendance_sessions s
         LEFT JOIN others o ON o.id = s.id
        WHERE s.section_id = $3`,
      [T, ANIKA, SEC9, HEAD]);

    const r = await get(`studentId=${ANIKA}`);
    const a = (r.body as { student: { attendance: {
      todayStatus: string; monthPercent: number; excused: number } } }).student.attendance;
    assert.equal(a.todayStatus, 'present');
    // 2 present of 3 counted days — the excused day is not a miss. Same
    // rule as the student's own attendance screen (F-806).
    assert.equal(a.monthPercent, 67);
    assert.equal(a.excused, 1);
  });

  test('fees report the balance and the NEXT due date, not the oldest', async () => {
    await post(
      `INSERT INTO invoices
         (tenant_id, invoice_no, student_id, academic_year_id, section_id,
          billing_period, issued_on, due_on, subtotal, total_amount, paid_amount,
          status) VALUES
         ($1,'INV-1',$2,$3,$4,'2026-07','2026-07-01','2026-07-15',2000,2000,2000,'paid'),
         ($1,'INV-2',$2,$3,$4,'2026-08','2026-08-01','2026-08-15',2000,2000,0,'issued'),
         ($1,'INV-3',$2,$3,$4,'2026-09','2026-09-01','2026-09-15',500,500,0,'issued')`,
      [T, ANIKA, YEAR, SEC9]);

    const r = await get(`studentId=${ANIKA}`);
    const f = (r.body as { student: { fees: {
      outstanding: number; earliestDue: string } } }).student.fees;
    assert.equal(f.outstanding, 2500);
    // The date a guardian needs is the next one they must act on. A paid
    // invoice contributes neither the balance nor the date.
    assert.equal(f.earliestDue, '2026-08-15');
  });

  test('the due date survives the UTC+6 boundary', async () => {
    // pg parses a bare date at local midnight; toISOString would report
    // 2026-08-14 from Dhaka, and a fee due date off by one is a guardian
    // paying late.
    const r = await get(`studentId=${ANIKA}`);
    assert.match((r.body as { student: { fees: { earliestDue: string } } })
      .student.fees.earliestDue, /^2026-08-15$/);
  });

  test('only a PUBLISHED result is shown', async () => {
    await post(
      `INSERT INTO exams (id, tenant_id, academic_year_id, name_bn, name_en, exam_type,
                          starts_on, ends_on, status)
       VALUES ($1,$2,$3,'১ম সাময়িক','First Term','half_yearly','2026-06-01','2026-06-10','planned')`,
      [EXAM, T, YEAR]);
    await post(
      `INSERT INTO exam_results
         (tenant_id, exam_id, student_id, section_id, academic_year_id,
          total_marks, total_max, percentage, gpa, letter_grade, is_pass, rank_in_section)
       VALUES ($1,$2,$3,$4,$5,456,500,91.2,4.56,'A+',true,7)`,
      [T, EXAM, ANIKA, SEC9, YEAR]);

    const draft = await get(`studentId=${ANIKA}`);
    assert.equal((draft.body as { student: { result: unknown } }).student.result, null,
                 'an unpublished result is a working figure, not news');

    // Both, exactly as the real publish transaction does (publish.ts). The
    // one that actually gates the guardian is exam_results.published_at:
    // results_scope in migration 010 reads it, so a result is invisible
    // until the school has agreed it — this endpoint's exams.status filter
    // is the second lock, not the first.
    await post(`UPDATE exams SET status = 'published', published_at = now() WHERE id = $1`, [EXAM]);
    await post('UPDATE exam_results SET published_at = now() WHERE exam_id = $1', [EXAM]);
    const published = await get(`studentId=${ANIKA}`);
    const res = (published.body as { student: { result: {
      examNameBn: string; gpa: number; rankInSection: number; sectionSize: number } } }).student.result;
    assert.equal(res.examNameBn, '১ম সাময়িক');
    assert.equal(res.gpa, 4.56);
    // §9.1 renders "মেধাক্রম ৭/৫২" — the rank is meaningless without the
    // cohort size beside it. The size is sections.student_count, which is
    // trigger-maintained from enrolments, so it is 2 here (Anika and the
    // stranger) no matter what the fixture wrote into the column.
    assert.equal(res.rankInSection, 7);
    assert.equal(res.sectionSize, 2);
  });

  test('a child with no result yet returns null rather than a zero GPA', async () => {
    const r = await get(`studentId=${BIJOY}`);
    assert.equal((r.body as { student: { result: unknown } }).student.result, null);
  });

  test('a child with no fees returns zero, not null', async () => {
    // A guardian with nothing to pay must see "০", which is information.
    const r = await get(`studentId=${BIJOY}`);
    const f = (r.body as { student: { fees: { outstanding: number; earliestDue: null } } })
      .student.fees;
    assert.equal(f.outstanding, 0);
    assert.equal(f.earliestDue, null);
  });

  test('an unauthenticated request is rejected', async () => {
    const r = await call(ward, { url: '/api/v1/academics/ward' });
    assert.equal(r.status, 401);
  });

  test('a malformed studentId is a 400, not a 500', async () => {
    const r = await get('studentId=not-a-uuid');
    assert.equal(r.status, 400);
  });
});
