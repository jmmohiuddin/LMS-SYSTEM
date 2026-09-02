/**
 * P0/A1 — the exam chain, from a school that has never held one.
 *
 * ── The two defects this proves closed ──────────────────────────────────
 * 1. **Nothing could create an exam.** `INSERT INTO exams` appeared nowhere
 *    under services/ or packages/ outside tests, and no `app.*` function
 *    inserted one. Everything below it — marks entry, per-subject grade, GPA,
 *    rank, publish, the progress report, the admit card — was built, tested
 *    and unreachable.
 *
 * 2. **`POST /academics/publish` had never executed.** Its grading step was
 *
 *        UPDATE exam_marks m … FROM exam_subjects es,
 *          LATERAL app.compute_subject_grade(…, m.cq_marks, …)
 *
 *    and PostgreSQL rejects that at parse time: an UPDATE's target is not in
 *    scope for a LATERAL in its own FROM list —
 *    `invalid reference to FROM-clause entry for table "m"`. So the statement
 *    failed on every call. Nothing noticed, because defect 1 meant no exam
 *    existed to publish and the endpoint was unreachable from any test.
 *
 * That pair is the reason this file walks the WHOLE chain rather than testing
 * either end: each defect hid the other.
 *
 * ── Fixture discipline ──────────────────────────────────────────────────
 * The school starts with no exams. Every exam here is created through the real
 * endpoint. Per the audit's rule, fixture presence is not proof of a writer.
 *
 *   DATABASE_URL=postgres://… node --test services/academics-svc/test/exam-lifecycle.test.ts
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { createDb, type Db, type TenantContext } from '../../../packages/server-core/src/db.ts';
import { installTestKeys, call, lockFixtures, unlockFixtures, asBootstrap } from '../../../packages/server-core/test/harness.ts';

const DATABASE_URL = process.env.DATABASE_URL;
const skip = !DATABASE_URL ? 'DATABASE_URL not set' : false;

const T        = '7f200000-0000-4000-8000-00000000000a';
const OTHER    = '7f200000-0000-4000-8000-00000000000b';
const HEAD     = '7f200000-0000-4000-8000-0000000000f1';
const TEACHER  = '7f200000-0000-4000-8000-0000000000a1';
const HEAD_B   = '7f200000-0000-4000-8000-0000000000f2';
const YEAR     = '7f200000-0000-4000-8000-0000000000c1';
const CLASS9   = '7f200000-0000-4000-8000-0000000000d1';
const SEC_KA   = '7f200000-0000-4000-8000-0000000000e1';
const MATH     = '7f200000-0000-4000-8000-0000000000b1';
const BANGLA   = '7f200000-0000-4000-8000-0000000000b2';
const STU_A    = '7f200000-0000-4000-8000-00000000aa01';
const STU_B    = '7f200000-0000-4000-8000-00000000aa02';
const GUARD_A  = '7f200000-0000-4000-8000-00000000bb01';
const GUARD_B  = '7f200000-0000-4000-8000-00000000bb02';
/** School B, so cross-tenant is a real second school rather than a bare id. */
const YEAR_B   = '7f200000-0000-4000-8000-0000000000c2';

let db: Db;
let exams: typeof import('../api/exams.ts').default;
let publish: typeof import('../api/publish.ts').default;
let headToken = '';
let teacherToken = '';
let headBToken = '';

const asHead: TenantContext = { tenantId: T, userId: HEAD, role: 'principal' };
const asHeadB: TenantContext = { tenantId: OTHER, userId: HEAD_B, role: 'principal' };

async function drop(): Promise<void> {
  for (const ctx of [asHead, asHeadB]) {
    await asBootstrap(db, ctx, (c) => c.query('DELETE FROM tenants WHERE id = $1', [ctx.tenantId]));
  }
}

async function seed(): Promise<void> {
  await drop();

  await asBootstrap(db, asHead, async (c) => {
    await c.query(
      `INSERT INTO tenants (id, slug, name_bn, name_en, stream, level)
       VALUES ($1,'p0-exam-a','পরীক্ষা বিদ্যালয়','Exam School','bangla_medium','secondary')`, [T]);
    await c.query(
      `INSERT INTO users (id, tenant_id, full_name_bn, full_name_en, phone_e164, status) VALUES
         ($1,$3,'প্রধান শিক্ষক','Head','+8801799660001','active'),
         ($2,$3,'রফিক স্যার','Rafiq','+8801799660002','active')`, [HEAD, TEACHER, T]);
    await c.query(
      `INSERT INTO user_roles (tenant_id, user_id, role_code) VALUES
         ($1,$2,'principal'), ($1,$3,'subject_teacher')`, [T, HEAD, TEACHER]);

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
      `INSERT INTO subjects (id, tenant_id, nctb_code, name_bn, name_en) VALUES
         ($1,$3,'109','গণিত','Mathematics'), ($2,$3,'101','বাংলা','Bangla')`,
      [MATH, BANGLA, T]);

    // The class actually teaches these two. The exam writer copies component
    // maxima from here, which is migration 005's stated rule.
    await c.query(
      `INSERT INTO class_subjects
         (tenant_id, class_id, subject_id, academic_year_id, periods_per_week,
          total_marks, cq_marks, mcq_marks, practical_marks, ca_marks,
          cq_pass_marks, mcq_pass_marks) VALUES
         ($1,$2,$3,$4,5,100,70,30,0,0,23,10),
         ($1,$2,$5,$4,5,100,70,30,0,0,23,10)`,
      [T, CLASS9, MATH, YEAR, BANGLA]);

    // The grading scale a real school gets from app.provision_tenant. Without
    // it publish answers 422 no_grading_scale — which is the endpoint working
    // correctly on a school that was never provisioned, and it is why this
    // fixture seeds the same bands rather than pretending.
    const scale = await c.query<{ id: string }>(
      `INSERT INTO grading_scales (tenant_id, name, effective_from, is_default)
       VALUES (app.current_tenant(), 'Bangladesh Board Scale', '2026-01-01', true)
       RETURNING id`);
    await c.query(
      `INSERT INTO grading_bands
         (tenant_id, scale_id, min_percent, max_percent, letter, grade_point, description_bn) VALUES
         (app.current_tenant(), $1, 80, 100  , 'A+', 5.00, 'অসাধারণ'),
         (app.current_tenant(), $1, 70,  79.99,'A' , 4.00, 'খুব ভালো'),
         (app.current_tenant(), $1, 60,  69.99,'A-', 3.50, 'ভালো'),
         (app.current_tenant(), $1, 50,  59.99,'B' , 3.00, 'মোটামুটি'),
         (app.current_tenant(), $1, 40,  49.99,'C' , 2.00, 'গড়'),
         (app.current_tenant(), $1, 33,  39.99,'D' , 1.00, 'উত্তীর্ণ'),
         (app.current_tenant(), $1,  0,  32.99,'F' , 0.00, 'অকৃতকার্য')`,
      [scale.rows[0].id]);

    // Two students with a contactable guardian each (migration 031 refuses a
    // phone-less child with nobody to ring, checked at COMMIT).
    for (const [stu, guard, name, n] of [
      [STU_A, GUARD_A, 'আনিকা', '1'], [STU_B, GUARD_B, 'বিজয়', '2'],
    ] as const) {
      await c.query(
        `INSERT INTO users (id, tenant_id, full_name_bn, full_name_en, status)
         VALUES ($1,$2,$3,$3,'active')`, [stu, T, name]);
      await c.query(`INSERT INTO user_roles (tenant_id, user_id, role_code) VALUES ($1,$2,'student')`,
        [T, stu]);
      await c.query(
        `INSERT INTO users (id, tenant_id, full_name_bn, full_name_en, phone_e164, status)
         VALUES ($1,$2,$3,$3,$4,'active')`, [guard, T, `${name}র অভিভাবক`, `+880179967000${n}`]);
      await c.query(`INSERT INTO user_roles (tenant_id, user_id, role_code) VALUES ($1,$2,'guardian')`,
        [T, guard]);
      await c.query(
        `INSERT INTO guardianships (tenant_id, student_id, guardian_id, relation, is_primary)
         VALUES ($1,$2,$3,'father',true)`, [T, stu, guard]);
      await c.query(
        `INSERT INTO enrolments (tenant_id, student_id, section_id, academic_year_id, roll_no, status)
         VALUES ($1,$2,$3,$4,$5,'active')`, [T, stu, SEC_KA, YEAR, Number(n)]);
    }
  });

  await asBootstrap(db, asHeadB, async (c) => {
    await c.query(
      `INSERT INTO tenants (id, slug, name_bn, name_en, stream, level)
       VALUES ($1,'p0-exam-b','অন্য বিদ্যালয়','Other School','bangla_medium','secondary')`, [OTHER]);
    await c.query(
      `INSERT INTO users (id, tenant_id, full_name_bn, full_name_en, phone_e164, status)
       VALUES ($1,$2,'প্রধান খ','Head B','+8801799660003','active')`, [HEAD_B, OTHER]);
    await c.query(`INSERT INTO user_roles (tenant_id, user_id, role_code) VALUES ($1,$2,'principal')`,
      [OTHER, HEAD_B]);
    await c.query(
      `INSERT INTO academic_years (id, tenant_id, label, starts_on, ends_on, is_current)
       VALUES ($1,$2,'২০২৬','2026-01-01','2026-12-31',true)`, [YEAR_B, OTHER]);
  });
}

describe('P0/A1 — the exam chain', { skip }, () => {
  before(async () => {
    await installTestKeys();
    await lockFixtures(DATABASE_URL as string);
    db = createDb(DATABASE_URL as string);
    await seed();

    const { signAccessToken } = await import('../../../packages/server-core/src/jwt.ts');
    headToken = await signAccessToken({ sub: HEAD, tid: T, role: 'principal', roles: ['principal'] });
    teacherToken = await signAccessToken({ sub: TEACHER, tid: T, role: 'subject_teacher', roles: ['subject_teacher'] });
    headBToken = await signAccessToken({ sub: HEAD_B, tid: OTHER, role: 'principal', roles: ['principal'] });

    exams = (await import('../api/exams.ts')).default;
    publish = (await import('../api/publish.ts')).default;
  });

  after(async () => { if (db) { await drop(); await db.end(); await unlockFixtures(); } });

  const listYear = (token: string, yearId = YEAR) =>
    call(exams, { method: 'GET', url: `/api/v1/academics/exams?yearId=${yearId}`, token } as Parameters<typeof call>[1]);
  const listSection = (token: string, sectionId = SEC_KA) =>
    call(exams, { method: 'GET', url: `/api/v1/academics/exams?sectionId=${sectionId}`, token } as Parameters<typeof call>[1]);
  const createExam = (token: string, body: unknown) =>
    call(exams, { method: 'POST', url: '/api/v1/academics/exams', token, body } as Parameters<typeof call>[1]);
  const patchExam = (token: string, body: unknown) =>
    call(exams, { method: 'PATCH', url: '/api/v1/academics/exams', token, body } as Parameters<typeof call>[1]);
  const doPublish = (token: string, examId: string) =>
    call(publish, { method: 'POST', url: '/api/v1/academics/publish', token, body: { examId } } as Parameters<typeof call>[1]);

  let examId = '';

  test('THE ONE THAT MATTERS — a school with no exams can create one, with its papers', async () => {
    const empty = await listYear(headToken);
    assert.equal(empty.status, 200, JSON.stringify(empty.body));
    assert.deepEqual((empty.body as { exams: unknown[] }).exams, [],
      'this school has never held an exam');

    const made = await createExam(headToken, {
      academicYearId: YEAR, nameBn: 'বার্ষিক পরীক্ষা', nameEn: 'Annual',
      examType: 'annual', startsOn: '2026-11-01', endsOn: '2026-11-10',
      sectionIds: [SEC_KA],
    });
    assert.equal(made.status, 200, JSON.stringify(made.body));
    const b = made.body as { id: string; paperCount: number };
    examId = b.id;

    // Two papers, because the class teaches two subjects. An exam created bare
    // would be invisible: the marks feed INNER JOINs exam_subjects.
    assert.equal(b.paperCount, 2, JSON.stringify(made.body));

    const after = await listYear(headToken);
    const row = (after.body as { exams: Array<{ id: string; paperCount: number; status: string }> }).exams[0];
    assert.equal(row.id, examId);
    assert.equal(row.paperCount, 2);
    assert.equal(row.status, 'planned');
  });

  test('the component maxima are copied from class_subjects, then frozen', async () => {
    // Migration 005's own instruction. If they were not copied the marks form
    // would offer the column defaults (70/30) regardless of what the class
    // actually teaches.
    const rows = await asBootstrap(db, asHead, async (c) => {
      const { rows } = await c.query<{ cq_max: string; mcq_max: string; cq_pass: string }>(
        `SELECT cq_max, mcq_max, cq_pass FROM exam_subjects WHERE exam_id = $1 ORDER BY subject_id`,
        [examId]);
      return rows;
    });
    assert.equal(rows.length, 2);
    for (const r of rows) {
      assert.equal(Number(r.cq_max), 70);
      assert.equal(Number(r.mcq_max), 30);
      assert.equal(Number(r.cq_pass), 23);
    }
  });

  test('the marks-entry feed can now see it — the chain is reachable', async () => {
    const feed = await listSection(teacherToken);
    assert.equal(feed.status, 200, JSON.stringify(feed.body));
    const list = (feed.body as { exams: Array<{ id: string; subjects: unknown[] }> }).exams;
    assert.equal(list.length, 1, 'the exam a teacher must mark');
    assert.equal(list[0].subjects.length, 2);
  });

  test('THE SECOND ONE THAT MATTERS — publish actually executes', async () => {
    // Marks are entered through the offline outbox in the product; inserting
    // them here is fixture setup. What is under test is publication, which had
    // never once run.
    await asBootstrap(db, asHead, async (c) => {
      await c.query(
        // `total_marks` is a GENERATED column — the database adds the four
        // components itself, and naming it here is rejected outright.
        `INSERT INTO exam_marks
           (tenant_id, exam_subject_id, student_id, academic_year_id,
            cq_marks, mcq_marks, practical_marks, ca_marks, entered_by)
         SELECT app.current_tenant(), es.id, e.student_id, $2,
                v.cq, v.mcq, 0, 0, $3
           FROM exam_subjects es
           JOIN enrolments e ON e.section_id = es.section_id AND e.status = 'active'
           JOIN LATERAL (SELECT CASE WHEN e.roll_no = 1 THEN 60 ELSE 40 END AS cq,
                                CASE WHEN e.roll_no = 1 THEN 25 ELSE 20 END AS mcq) v ON true
          WHERE es.exam_id = $1`,
        [examId, YEAR, HEAD]);

      // Publication requires the exam to be past 'planned'.
      await c.query(`UPDATE exams SET status = 'marking' WHERE id = $1`, [examId]);
    });

    const r = await doPublish(headToken, examId);
    assert.equal(r.status, 200, `publish must execute: ${JSON.stringify(r.body)}`);

    // And it must have DONE something — a 200 that graded nothing would be the
    // same defect wearing a success.
    const out = await asBootstrap(db, asHead, async (c) => {
      const g = await c.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM exam_marks m
           JOIN exam_subjects es ON es.id = m.exam_subject_id
          WHERE es.exam_id = $1 AND m.grade_letter IS NOT NULL`, [examId]);
      const res = await c.query<{ student_id: string; gpa: string; rank_in_section: number | null }>(
        `SELECT student_id, gpa, rank_in_section FROM exam_results
          WHERE exam_id = $1 ORDER BY rank_in_section`, [examId]);
      const st = await c.query<{ status: string }>(`SELECT status FROM exams WHERE id = $1`, [examId]);
      return { graded: Number(g.rows[0].n), results: res.rows, status: st.rows[0].status };
    });

    assert.equal(out.graded, 4, 'every mark row must carry a grade (2 students x 2 papers)');
    assert.equal(out.results.length, 2, 'one result row per student');
    assert.equal(out.status, 'published');

    // Rank is dense within the section, best first. Anika scored higher.
    assert.equal(out.results[0].rank_in_section, 1);
    assert.equal(out.results[0].student_id, STU_A);
    assert.equal(out.results[1].rank_in_section, 2);
    assert.ok(Number(out.results[0].gpa) >= Number(out.results[1].gpa));
  });

  test('publishing twice is refused, and the first result stands', async () => {
    const again = await doPublish(headToken, examId);
    assert.equal(again.status, 409, JSON.stringify(again.body));
    assert.equal((again.body as { error: string }).error, 'already_published');

    const n = await asBootstrap(db, asHead, async (c) => {
      const { rows } = await c.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM exam_results WHERE exam_id = $1`, [examId]);
      return Number(rows[0].n);
    });
    assert.equal(n, 2, 'a refused re-publish must not duplicate results');
  });

  test('a published exam can no longer be edited', async () => {
    const r = await patchExam(headToken, { id: examId, nameBn: 'নাম বদলে দিলাম' });
    assert.equal(r.status, 409, JSON.stringify(r.body));
    assert.equal((r.body as { error: string }).error, 'exam_published');
  });

  test('a subject teacher may read exams but may not create or publish one', async () => {
    const read = await listYear(teacherToken);
    assert.equal(read.status, 200, 'reading is staff-wide');

    const make = await createExam(teacherToken, {
      academicYearId: YEAR, nameBn: 'শিক্ষকের পরীক্ষা', examType: 'class_test', sectionIds: [SEC_KA],
    });
    assert.equal(make.status, 403, JSON.stringify(make.body));

    const pub = await doPublish(teacherToken, examId);
    assert.equal(pub.status, 403, JSON.stringify(pub.body));
  });

  test('THE DATABASE refuses the write too, not only the role check', async () => {
    // Migration 066. Before it, a subject teacher's session could insert an
    // exam directly — proved against a live database.
    const asTeacher: TenantContext = { tenantId: T, userId: TEACHER, role: 'subject_teacher' };
    await assert.rejects(
      () => db.withTenant(asTeacher, (c) => c.query(
        `INSERT INTO exams (tenant_id, academic_year_id, name_bn, name_en, exam_type)
         VALUES (app.current_tenant(), $1, 'সরাসরি', 'Direct', 'annual')`, [YEAR])),
      /exams_insert_scope|row-level security/i);
  });

  test('another school cannot see, edit or publish this exam', async () => {
    const theirs = await listYear(headBToken, YEAR_B);
    assert.deepEqual((theirs.body as { exams: unknown[] }).exams, []);

    // School B naming school A's year: RLS hides the row, so it is not found.
    const stolenYear = await createExam(headBToken, {
      academicYearId: YEAR, nameBn: 'দখল', examType: 'annual', sectionIds: [SEC_KA],
    });
    assert.equal(stolenYear.status, 404, JSON.stringify(stolenYear.body));

    const stolenPatch = await patchExam(headBToken, { id: examId, nameBn: 'দখল' });
    assert.equal(stolenPatch.status, 404, JSON.stringify(stolenPatch.body));

    const stolenPublish = await doPublish(headBToken, examId);
    assert.equal(stolenPublish.status, 404, JSON.stringify(stolenPublish.body));

    // And school A's exam is untouched.
    const mine = (await listYear(headToken)).body as { exams: Array<{ nameBn: string }> };
    assert.equal(mine.exams[0].nameBn, 'বার্ষিক পরীক্ষা');
  });

  test('validation refuses in Bangla, names the field, and writes nothing', async () => {
    const before = ((await listYear(headToken)).body as { exams: unknown[] }).exams.length;

    for (const [body, code, field] of [
      [{ academicYearId: YEAR, nameBn: '', examType: 'annual', sectionIds: [SEC_KA] }, 'bad_name', 'nameBn'],
      [{ academicYearId: YEAR, nameBn: 'ক', examType: 'nonsense', sectionIds: [SEC_KA] }, 'bad_exam_type', 'examType'],
      [{ academicYearId: YEAR, nameBn: 'ক', examType: 'annual', sectionIds: [] }, 'no_sections', 'sectionIds'],
      [{ academicYearId: 'not-a-uuid', nameBn: 'ক', examType: 'annual', sectionIds: [SEC_KA] }, 'bad_year', 'academicYearId'],
      [{ academicYearId: YEAR, nameBn: 'ক', examType: 'annual', sectionIds: [SEC_KA],
         startsOn: '2026-11-10', endsOn: '2026-11-01' }, 'bad_date_order', 'endsOn'],
      // Inside the year is the rule; 2027 is not.
      [{ academicYearId: YEAR, nameBn: 'ক', examType: 'annual', sectionIds: [SEC_KA],
         startsOn: '2027-03-01' }, 'date_outside_year', 'startsOn'],
    ] as const) {
      const r = await createExam(headToken, body);
      assert.equal(r.status, 400, `${JSON.stringify(body)} -> ${JSON.stringify(r.body)}`);
      const out = r.body as { error: string; message: string; field?: string };
      assert.equal(out.error, code, JSON.stringify(body));
      assert.equal(out.field, field, 'the form must be able to mark the offending box');
      assert.match(out.message, /[ঀ-৿]/, `not Bangla: ${out.message}`);
      // No raw backend text reaches the office.
      assert.ok(!/violates|constraint|SQLSTATE|null value|invalid input syntax/i.test(out.message), out.message);
    }

    assert.equal(((await listYear(headToken)).body as { exams: unknown[] }).exams.length, before,
      'a refused create must leave nothing behind');
  });

  test('two exams cannot share a name inside one year', async () => {
    const dup = await createExam(headToken, {
      academicYearId: YEAR, nameBn: 'বার্ষিক পরীক্ষা', examType: 'annual', sectionIds: [SEC_KA],
    });
    assert.equal(dup.status, 409, JSON.stringify(dup.body));
    assert.equal((dup.body as { error: string }).error, 'duplicate_name');
    assert.match((dup.body as { message: string }).message, /[ঀ-৿]/);
  });

  test('an exam whose class teaches nothing is refused, and rolls back', async () => {
    // A section whose class has no class_subjects produces no papers. The exam
    // must not survive: one that cannot be marked is worse than a refusal.
    const EMPTY_CLASS = '7f200000-0000-4000-8000-0000000000d9';
    const EMPTY_SEC = '7f200000-0000-4000-8000-0000000000e9';
    await asBootstrap(db, asHead, async (c) => {
      await c.query(
        `INSERT INTO classes (id, tenant_id, level_no, name_bn, name_en, stream)
         VALUES ($1,$2,10,'দশম','Ten','bangla_medium') ON CONFLICT DO NOTHING`, [EMPTY_CLASS, T]);
      await c.query(
        `INSERT INTO sections (id, tenant_id, class_id, academic_year_id, name, capacity)
         VALUES ($1,$2,$3,$4,'ক',40) ON CONFLICT DO NOTHING`, [EMPTY_SEC, T, EMPTY_CLASS, YEAR]);
    });

    const r = await createExam(headToken, {
      academicYearId: YEAR, nameBn: 'বিষয়হীন পরীক্ষা', examType: 'annual', sectionIds: [EMPTY_SEC],
    });
    assert.equal(r.status, 409, JSON.stringify(r.body));
    assert.equal((r.body as { error: string }).error, 'no_class_subjects');

    const orphan = await asBootstrap(db, asHead, async (c) => {
      const { rows } = await c.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM exams WHERE name_bn = 'বিষয়হীন পরীক্ষা'`);
      return Number(rows[0].n);
    });
    assert.equal(orphan, 0, 'the exam must roll back with its missing papers');
  });

  test('editing an unpublished exam works and is audited', async () => {
    const made = await createExam(headToken, {
      academicYearId: YEAR, nameBn: 'অর্ধবার্ষিক', examType: 'half_yearly', sectionIds: [SEC_KA],
    });
    assert.equal(made.status, 200, JSON.stringify(made.body));
    const id = (made.body as { id: string }).id;

    const r = await patchExam(headToken, { id, nameBn: 'অর্ধবার্ষিক পরীক্ষা', startsOn: '2026-06-01' });
    assert.equal(r.status, 200, JSON.stringify(r.body));

    const entry = await asBootstrap(db, asHead, async (c) => {
      const { rows } = await c.query<{ before: Record<string, unknown>; after: Record<string, unknown> }>(
        `SELECT before_state AS before, after_state AS after FROM audit.activity_log
          WHERE entity_type = 'exam' AND entity_id = $1 AND action = 'academic.exam.update'
          ORDER BY created_at DESC LIMIT 1`, [id]);
      return rows[0];
    });
    assert.equal(entry.before.nameBn, 'অর্ধবার্ষিক');
    assert.equal(entry.after.nameBn, 'অর্ধবার্ষিক পরীক্ষা');
    assert.equal(entry.after.startsOn, '2026-06-01');

    // A PATCH that names only the date must not reset the type to a default.
    const kept = await asBootstrap(db, asHead, async (c) => {
      const { rows } = await c.query<{ exam_type: string }>(
        `SELECT exam_type FROM exams WHERE id = $1`, [id]);
      return rows[0].exam_type;
    });
    assert.equal(kept, 'half_yearly', 'an omitted field must be carried across, not defaulted');
  });
});
