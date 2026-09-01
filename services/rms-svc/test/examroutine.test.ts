/**
 * Exam routine endpoint — wireframe §8.3, F-510
 *
 * The fixture is §8.3's own scenario, which is also the one a class-level
 * check cannot see: two Class 9 Science students in ONE section, identical
 * except for their optional subject. Anika takes Higher Maths, Bijoy takes
 * Agriculture. Higher Maths is scheduled against Chemistry, so exactly one
 * of them has a clash and the section template knows nothing about it.
 *
 *   DATABASE_URL=postgresql://shikhon_runtime:… node --test services/rms-svc/test/examroutine.test.ts
 *
 * Connect as the NON-privileged runtime role. sharedDb() refuses to boot on
 * a BYPASSRLS role, and the isolation assertion would otherwise pass
 * vacuously.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { createDb, type Db } from '../../../packages/server-core/src/db.ts';
import { installTestKeys, call, lockFixtures, unlockFixtures} from '../../../packages/server-core/test/harness.ts';

const DATABASE_URL = process.env.DATABASE_URL;
const skip = !DATABASE_URL ? 'DATABASE_URL not set' : false;

const T       = '7c000000-0000-4000-8000-00000000000c';
const OTHER   = '7c000000-0000-4000-8000-00000000000d';
const COORD   = '7c000000-0000-4000-8000-0000000000ff';
const ANIKA   = '7c000000-0000-4000-8000-0000000000a1';
const BIJOY   = '7c000000-0000-4000-8000-0000000000a2';
const YEAR    = '7c000000-0000-4000-8000-000000000091';
const CLASS   = '7c000000-0000-4000-8000-0000000000c1';
const SECTION = '7c000000-0000-4000-8000-0000000000c2';
const E_ANIKA = '7c000000-0000-4000-8000-0000000000e1';
const E_BIJOY = '7c000000-0000-4000-8000-0000000000e2';
const CHEM    = '7c000000-0000-4000-8000-000000000137';
const PHYS    = '7c000000-0000-4000-8000-000000000136';
const HMATH   = '7c000000-0000-4000-8000-000000000126';
const AGRI    = '7c000000-0000-4000-8000-000000000127';
const EXAM    = '7c000000-0000-4000-8000-000000000092';

let db: Db;
let coordToken: string;
let studentToken: string;
let otherTenantToken: string;
let examroutine: typeof import('../api/examroutine.ts').default;

async function dropFixtures(): Promise<void> {
  for (const id of [T, OTHER]) {
    await db.withTenant({ tenantId: id, userId: COORD, role: 'principal' }, async (c) => {
      await c.query('DELETE FROM tenants WHERE id = $1', [id]);
    });
  }
}

async function seed(): Promise<void> {
  await dropFixtures();
  await db.withTenant({ tenantId: T, userId: COORD, role: 'principal' }, async (c) => {
    await c.query(
      `INSERT INTO tenants (id, slug, name_bn, name_en, stream, level)
       VALUES ($1,'f510-api','পরীক্ষা রুটিন','Exam Routine','bangla_medium','secondary')`, [T]);
    await c.query(
      `INSERT INTO users (id, tenant_id, full_name_bn, full_name_en, phone_e164) VALUES
         ($1,$4,'সমন্বয়ক','Coordinator','+8801798000001'),
         ($2,$4,'আনিকা','Anika','+8801798000002'),
         ($3,$4,'বিজয়','Bijoy','+8801798000003')`,
      [COORD, ANIKA, BIJOY, T]);
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
       VALUES ($1,$3,$4,$6,$7,7,'active'), ($2,$3,$5,$6,$7,8,'active')`,
      [E_ANIKA, E_BIJOY, T, ANIKA, BIJOY, SECTION, YEAR]);
    await c.query(
      `INSERT INTO subjects (id, tenant_id, nctb_code, name_bn, name_en) VALUES
         ($1,$5,'137','রসায়ন','Chemistry'),
         ($2,$5,'136','পদার্থবিজ্ঞান','Physics'),
         ($3,$5,'126','উচ্চতর গণিত','Higher Mathematics'),
         ($4,$5,'127','কৃষিশিক্ষা','Agriculture')`,
      [CHEM, PHYS, HMATH, AGRI, T]);
    // Identical except the optional. This is the whole fixture.
    await c.query(
      `INSERT INTO student_subjects (tenant_id, enrolment_id, subject_id, requirement_type, source) VALUES
         ($1,$2,$4,'group_compulsory','template'),
         ($1,$2,$5,'group_compulsory','template'),
         ($1,$2,$6,'optional','template'),
         ($1,$3,$4,'group_compulsory','template'),
         ($1,$3,$5,'group_compulsory','template'),
         ($1,$3,$7,'optional','template')`,
      [T, E_ANIKA, E_BIJOY, CHEM, PHYS, HMATH, AGRI]);
    await c.query(
      `INSERT INTO exams (id, tenant_id, academic_year_id, name_bn, name_en, exam_type,
                          starts_on, ends_on, status)
       VALUES ($1,$2,$3,'বার্ষিক পরীক্ষা','Annual','annual','2026-12-10','2026-12-20','planned')`,
      [EXAM, T, YEAR]);
    // Chemistry and Higher Maths at the same hour on the same day.
    await c.query(
      `INSERT INTO exam_subjects
         (tenant_id, exam_id, section_id, subject_id, exam_date, start_time,
          duration_minutes, cq_max, mcq_max) VALUES
         ($1,$2,$3,$4,'2026-12-14','10:00',180,50,25),
         ($1,$2,$3,$5,'2026-12-15','10:00',180,50,25),
         ($1,$2,$3,$6,'2026-12-14','10:00',180,50,25)`,
      [T, EXAM, SECTION, CHEM, PHYS, HMATH]);
  });

  await db.withTenant({ tenantId: OTHER, userId: COORD, role: 'principal' }, async (c) => {
    await c.query(
      `INSERT INTO tenants (id, slug, name_bn, name_en, stream, level)
       VALUES ($1,'f510-api-b','অন্য বিদ্যালয়','Other School','bangla_medium','secondary')`, [OTHER]);
  });
}

describe('exam routine endpoint (§8.3, F-510)', { skip }, () => {
  before(async () => {
    await installTestKeys();
    // Serialised against other runs of this same suite — the fixtures below
    // live at fixed uuids and two processes would delete each other's.
    await lockFixtures(DATABASE_URL as string);
    db = createDb(DATABASE_URL as string);
    await seed();
    const { signAccessToken } = await import('../../../packages/server-core/src/jwt.ts');
    coordToken = await signAccessToken({
      sub: COORD, tid: T, role: 'academic_coordinator', roles: ['academic_coordinator'] });
    studentToken = await signAccessToken({
      sub: ANIKA, tid: T, role: 'student', roles: ['student'] });
    otherTenantToken = await signAccessToken({
      sub: COORD, tid: OTHER, role: 'academic_coordinator', roles: ['academic_coordinator'] });
    examroutine = (await import('../api/examroutine.ts')).default;
  });

  after(async () => {
    if (db) { await dropFixtures(); await db.end(); await unlockFixtures(); }
  });

  test('the clash is reported for Anika only, and named', async () => {
    const r = await call(examroutine, { url: `/api/v1/rms/examroutine?examId=${EXAM}`, token: coordToken });
    assert.equal(r.status, 200);
    const b = r.body as { clashes: Array<Record<string, unknown>>; affectedStudents: number };
    assert.equal(b.clashes.length, 1);
    assert.equal(b.clashes[0].studentNameBn, 'আনিকা');
    assert.equal(b.clashes[0].rollNo, 7);
    // §8.3 counts students, not clash rows.
    assert.equal(b.affectedStudents, 1);
  });

  test('both offending papers carry the flag, the innocent one does not', async () => {
    const r = await call(examroutine, { url: `/api/v1/rms/examroutine?examId=${EXAM}`, token: coordToken });
    const papers = (r.body as { papers: Array<{ subjectBn: string; hasClash: boolean }> }).papers;
    const by = (n: string) => papers.find((p) => p.subjectBn === n);
    // §8.3 marks both rows of the pair, not just the later one — a
    // coordinator has to choose which of the two to move.
    assert.equal(by('রসায়ন')?.hasClash, true);
    assert.equal(by('উচ্চতর গণিত')?.hasClash, true);
    // Physics is on a different day and must stay clean.
    assert.equal(by('পদার্থবিজ্ঞান')?.hasClash, false);
  });

  test('end time is computed from the duration, not stored', async () => {
    const r = await call(examroutine, { url: `/api/v1/rms/examroutine?examId=${EXAM}`, token: coordToken });
    const p = (r.body as { papers: Array<{ subjectBn: string; startTime: string; endTime: string }> })
      .papers.find((x) => x.subjectBn === 'রসায়ন');
    assert.equal(p?.startTime, '10:00');
    assert.equal(p?.endTime, '13:00');
  });

  test('publication is refused with 409 and the error names the student', async () => {
    const r = await call(examroutine, {
      method: 'POST', url: '/api/v1/rms/examroutine',
      token: coordToken, body: { examId: EXAM, publish: true },
    });
    assert.equal(r.status, 409);
    const b = r.body as { error: string; message: string };
    assert.equal(b.error, 'exam_routine_clash');
    assert.match(b.message, /আনিকা/);
    // And the refusal is real: the exam is still unpublished.
    const after = await call(examroutine, {
      url: `/api/v1/rms/examroutine?examId=${EXAM}`, token: coordToken });
    assert.equal((after.body as { exam: { status: string } }).exam.status, 'planned');
  });

  test('rescheduling through the endpoint clears the clash, and publication then succeeds', async () => {
    // §8.3's own loop: see the clash, move one of the two papers, re-check.
    const before = await call(examroutine, {
      url: `/api/v1/rms/examroutine?examId=${EXAM}`, token: coordToken });
    const hmath = (before.body as { papers: Array<{ subjectBn: string; examSubjectId: string }> })
      .papers.find((p) => p.subjectBn === 'উচ্চতর গণিত');

    const moved = await call(examroutine, {
      method: 'POST', url: '/api/v1/rms/examroutine', token: coordToken,
      body: { examId: EXAM, reschedule: {
        examSubjectId: hmath?.examSubjectId, examDate: '2026-12-17', startTime: '10:00' } },
    });
    assert.equal(moved.status, 200);
    // The move and the re-check are one response: the coordinator never
    // sees a stale ⚠ next to a paper they just fixed.
    const b0 = moved.body as { clashes: unknown[]; canPublish: boolean;
                               papers: Array<{ subjectBn: string; examDate: string }> };
    assert.equal(b0.clashes.length, 0);
    assert.equal(b0.canPublish, true);
    assert.equal(b0.papers.find((p) => p.subjectBn === 'উচ্চতর গণিত')?.examDate, '2026-12-17');

    const r = await call(examroutine, {
      method: 'POST', url: '/api/v1/rms/examroutine',
      token: coordToken, body: { examId: EXAM, publish: true },
    });
    assert.equal(r.status, 200);
    const b = r.body as { exam: { status: string }; canPublish: boolean; clashes: unknown[] };
    assert.equal(b.exam.status, 'published');
    assert.equal(b.canPublish, true);
    assert.equal(b.clashes.length, 0);
  });

  test('a published routine cannot be rescheduled through this screen', async () => {
    // Runs after the publish above, so the exam is live. Parents have been
    // told; moving a paper underneath them is a different feature.
    const cur = await call(examroutine, {
      url: `/api/v1/rms/examroutine?examId=${EXAM}`, token: coordToken });
    const paper = (cur.body as { papers: Array<{ examSubjectId: string }> }).papers[0];
    const r = await call(examroutine, {
      method: 'POST', url: '/api/v1/rms/examroutine', token: coordToken,
      body: { examId: EXAM, reschedule: {
        examSubjectId: paper.examSubjectId, examDate: '2026-12-19', startTime: '09:00' } },
    });
    assert.equal(r.status, 409);
    assert.equal((r.body as { error: string }).error, 'exam_published');
  });

  test('a reschedule with a malformed time is rejected before any write', async () => {
    const r = await call(examroutine, {
      method: 'POST', url: '/api/v1/rms/examroutine', token: coordToken,
      body: { examId: EXAM, reschedule: {
        examSubjectId: EXAM, examDate: '2026-12-19', startTime: '25:99' } },
    });
    assert.equal(r.status, 400);
    assert.equal((r.body as { error: string }).error, 'invalid_start_time');
  });

  test('a student cannot read the exam routine editor', async () => {
    const r = await call(examroutine, {
      url: `/api/v1/rms/examroutine?examId=${EXAM}`, token: studentToken });
    assert.equal(r.status, 403);
  });

  test('another school cannot see this exam at all', async () => {
    const r = await call(examroutine, {
      url: `/api/v1/rms/examroutine?examId=${EXAM}`, token: otherTenantToken });
    // Not 403 — RLS makes the row invisible, so it is genuinely not found.
    assert.equal(r.status, 404);
  });

  test('an unauthenticated request is rejected before any query', async () => {
    const r = await call(examroutine, { url: `/api/v1/rms/examroutine?examId=${EXAM}` });
    assert.equal(r.status, 401);
  });

  test('no examId lists the current year\'s exams for the selector', async () => {
    const r = await call(examroutine, { url: '/api/v1/rms/examroutine', token: coordToken });
    assert.equal(r.status, 200);
    const exams = (r.body as { exams: Array<{ id: string; nameBn: string }> }).exams;
    assert.equal(exams.length, 1);
    assert.equal(exams[0].id, EXAM);
    assert.equal(exams[0].nameBn, 'বার্ষিক পরীক্ষা');
  });

  test('a malformed examId is rejected as a bad request, not a 500', async () => {
    const r = await call(examroutine, {
      url: '/api/v1/rms/examroutine?examId=not-a-uuid', token: coordToken });
    assert.equal(r.status, 400);
    assert.equal((r.body as { error: string }).error, 'invalid_exam_id');
  });
});
