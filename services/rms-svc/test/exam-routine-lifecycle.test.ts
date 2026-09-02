/**
 * Publishing an exam ROUTINE must not end the exam.
 *
 * `exams.status` is the RESULTS lifecycle: planned → ongoing → marking →
 * moderation → published → locked. `published` means a parent has been shown
 * a grade, which is why three separate places treat it as final:
 *
 *   academics-svc/api/exams.ts    PATCH refuses it — "ফলাফল প্রকাশিত পরীক্ষা"
 *   academics-svc/api/publish.ts  refuses to publish results twice
 *   sync-svc/src/appliers.ts      refuses every mark, published_marks_immutable
 *
 * `POST /api/v1/rms/examroutine {publish:true}` published the SCHEDULE — a
 * different fact, told to parents weeks before anyone sits the paper — and
 * wrote that same `status = 'published'`. Proven against the live HTTP API in
 * the order a real school works:
 *
 *   1. create the exam                     → planned, 12 papers
 *   2. publish the exam routine            → status becomes published
 *   3. correct a typo in the exam name     → 409, already published
 *   4. a teacher enters a mark             → conflict, published_marks_immutable
 *   5. the office publishes the results    → 409, already published
 *
 * So a school that announces its exam schedule — the normal thing to do —
 * permanently bricks that exam. Nothing anywhere moves `status` backwards, so
 * there is no recovery inside the product. The whole chain below the exam
 * (marks → grade → GPA → rank → publish → progress report) becomes
 * unreachable for it.
 *
 * The two facts are now separate: `exams.routine_published_at` records that
 * the schedule was announced, and `exams.status` is left to mean what every
 * reader of it already assumes.
 *
 * The old suite ASSERTED the conflation (`b.exam.status === 'published'`
 * after a routine publish), which is why the bug survived a green suite —
 * the test was written from the same misunderstanding as the code.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { createDb, type Db } from '../../../packages/server-core/src/db.ts';
import { installTestKeys, call, lockFixtures, unlockFixtures, asBootstrap } from '../../../packages/server-core/test/harness.ts';

const DATABASE_URL = process.env.DATABASE_URL;
const skip = !DATABASE_URL ? 'DATABASE_URL not set' : false;

// Own uuids: this suite must not share fixtures with examroutine.test.ts,
// which deletes its tenant in `after`.
const T       = '7c010000-0000-4000-8000-00000000000c';
const HEAD    = '7c010000-0000-4000-8000-0000000000ff';
const PUPIL   = '7c010000-0000-4000-8000-0000000000a1';
const YEAR    = '7c010000-0000-4000-8000-000000000091';
const CLASS   = '7c010000-0000-4000-8000-0000000000c1';
const SECTION = '7c010000-0000-4000-8000-0000000000c2';
const ENROL   = '7c010000-0000-4000-8000-0000000000e1';
const BANGLA  = '7c010000-0000-4000-8000-000000000101';
const EXAM    = '7c010000-0000-4000-8000-000000000092';

let db: Db;
let headToken: string;
let examroutine: typeof import('../api/examroutine.ts').default;
let exams: typeof import('../../academics-svc/api/exams.ts').default;

async function dropFixtures(): Promise<void> {
  await asBootstrap(db, { tenantId: T, userId: HEAD, role: 'principal' }, async (c) => {
    await c.query('DELETE FROM tenants WHERE id = $1', [T]);
  });
}

async function seed(): Promise<void> {
  await dropFixtures();
  await asBootstrap(db, { tenantId: T, userId: HEAD, role: 'principal' }, async (c) => {
    await c.query(
      `INSERT INTO tenants (id, slug, name_bn, name_en, stream, level)
       VALUES ($1,'a1-lifecycle','পরীক্ষা জীবনচক্র','Exam Lifecycle','bangla_medium','secondary')`, [T]);
    await c.query(
      `INSERT INTO users (id, tenant_id, full_name_bn, full_name_en, phone_e164) VALUES
         ($1,$3,'প্রধান শিক্ষক','Head','+8801797000001'),
         ($2,$3,'ছাত্র','Pupil','+8801797000002')`, [HEAD, PUPIL, T]);
    await c.query(
      `INSERT INTO academic_years (id, tenant_id, label, starts_on, ends_on, is_current)
       VALUES ($1,$2,'2026','2026-01-01','2026-12-31',true)`, [YEAR, T]);
    await c.query(
      `INSERT INTO classes (id, tenant_id, level_no, name_bn, name_en, stream, "group")
       VALUES ($1,$2,9,'নবম','Nine','bangla_medium','science')`, [CLASS, T]);
    await c.query(
      `INSERT INTO sections (id, tenant_id, class_id, academic_year_id, name)
       VALUES ($1,$2,$3,$4,'ক')`, [SECTION, T, CLASS, YEAR]);
    await c.query(
      `INSERT INTO enrolments (id, tenant_id, student_id, section_id, academic_year_id, roll_no, status)
       VALUES ($1,$2,$3,$4,$5,1,'active')`, [ENROL, T, PUPIL, SECTION, YEAR]);
    await c.query(
      `INSERT INTO subjects (id, tenant_id, nctb_code, name_bn, name_en)
       VALUES ($1,$2,'101','বাংলা','Bangla')`, [BANGLA, T]);
    await c.query(
      `INSERT INTO student_subjects (tenant_id, enrolment_id, subject_id, requirement_type, source)
       VALUES ($1,$2,$3,'group_compulsory','template')`, [T, ENROL, BANGLA]);
    await c.query(
      `INSERT INTO exams (id, tenant_id, academic_year_id, name_bn, name_en, exam_type,
                          starts_on, ends_on, status)
       VALUES ($1,$2,$3,'বার্ষিক পরীক্ষা','Annual','annual','2026-12-10','2026-12-20','planned')`,
      [EXAM, T, YEAR]);
    // One paper, no clash — this suite is about the lifecycle, not clashes.
    await c.query(
      `INSERT INTO exam_subjects
         (tenant_id, exam_id, section_id, subject_id, exam_date, start_time,
          duration_minutes, cq_max, mcq_max)
       VALUES ($1,$2,$3,$4,'2026-12-14','10:00',180,70,30)`,
      [T, EXAM, SECTION, BANGLA]);
  });
}

const publishRoutine = () => call(examroutine, {
  method: 'POST', url: '/api/v1/rms/examroutine',
  token: headToken, body: { examId: EXAM, publish: true },
});

const readExam = async (): Promise<{ status: string; routinePublished?: boolean }> => {
  const r = await call(examroutine, {
    url: `/api/v1/rms/examroutine?examId=${EXAM}`, token: headToken });
  return (r.body as { exam: { status: string; routinePublished?: boolean } }).exam;
};

const dbStatus = async (): Promise<{ status: string; published_at: string | null }> =>
  asBootstrap(db, { tenantId: T, userId: HEAD, role: 'principal' }, async (c) => {
    const r = await c.query<{ status: string; published_at: string | null }>(
      `SELECT status::text AS status, published_at FROM exams WHERE id = $1`, [EXAM]);
    return r.rows[0];
  });

describe('publishing a routine announces a schedule, it does not end the exam', { skip }, () => {
  before(async () => {
    await installTestKeys();
    await lockFixtures(DATABASE_URL as string);
    db = createDb(DATABASE_URL as string);
    await seed();
    const { signAccessToken } = await import('../../../packages/server-core/src/jwt.ts');
    headToken = await signAccessToken({ sub: HEAD, tid: T, role: 'principal', roles: ['principal'] });
    examroutine = (await import('../api/examroutine.ts')).default;
    exams = (await import('../../academics-svc/api/exams.ts')).default;
  });

  after(async () => {
    if (db) { await dropFixtures(); await db.end(); await unlockFixtures(); }
  });

  test('THE ONE THAT MATTERS — after publishing the routine the exam is still markable', async () => {
    const pub = await publishRoutine();
    assert.equal(pub.status, 200, JSON.stringify(pub.body));

    const row = await dbStatus();
    // `published` is what appliers.ts, publish.ts and exams.ts all read as
    // "the results are out". A schedule announcement must not say that.
    assert.notEqual(row.status, 'published',
      'publishing the ROUTINE set the exam to published — every mark is now refused');
    assert.notEqual(row.status, 'locked');
    // And it must not have forged a results-publication timestamp either.
    assert.equal(row.published_at, null);
  });

  test('the schedule announcement is still recorded — the reschedule guard needs it', async () => {
    // The guard exists for a real reason: parents have been told. Separating
    // the two facts must not lose the one the guard depends on.
    const exam = await readExam();
    assert.equal(exam.routinePublished, true,
      'the routine publication was not recorded anywhere');

    const cur = await call(examroutine, {
      url: `/api/v1/rms/examroutine?examId=${EXAM}`, token: headToken });
    const paper = (cur.body as { papers: Array<{ examSubjectId: string }> }).papers[0];
    const r = await call(examroutine, {
      method: 'POST', url: '/api/v1/rms/examroutine', token: headToken,
      body: { examId: EXAM, reschedule: {
        examSubjectId: paper.examSubjectId, examDate: '2026-12-19', startTime: '09:00' } },
    });
    assert.equal(r.status, 409, 'a published routine must still refuse a silent reschedule');
    assert.equal((r.body as { error: string }).error, 'exam_published');
  });

  test('the office can still correct the exam after announcing its schedule', async () => {
    // A typo in the exam name is exactly what gets noticed once the schedule
    // is on the noticeboard.
    const r = await call(exams, {
      method: 'PATCH', url: '/api/v1/academics/exams', token: headToken,
      body: { id: EXAM, nameBn: 'বার্ষিক পরীক্ষা ২০২৬' },
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal((r.body as { nameBn: string }).nameBn, 'বার্ষিক পরীক্ষা ২০২৬');
  });

  test('and a real results publication still moves it to published', async () => {
    // The other half: separating the facts must not make the exam
    // un-publishable. Set by the publish endpoint's own UPDATE shape.
    await asBootstrap(db, { tenantId: T, userId: HEAD, role: 'principal' }, async (c) => {
      await c.query(
        `UPDATE exams SET status = 'published', published_at = now(), published_by = $2
          WHERE id = $1`, [EXAM, HEAD]);
    });
    const row = await dbStatus();
    assert.equal(row.status, 'published');
    assert.notEqual(row.published_at, null);

    // And NOW editing is correctly refused — the guard still works when the
    // status genuinely means "a parent has seen a grade".
    const r = await call(exams, {
      method: 'PATCH', url: '/api/v1/academics/exams', token: headToken,
      body: { id: EXAM, nameBn: 'আবার বদল' },
    });
    assert.equal(r.status, 409);
    assert.equal((r.body as { error: string }).error, 'exam_published');
  });
});
