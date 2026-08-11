/**
 * Backfill tests for the untested academics endpoints  (F-106)
 *
 * assignments, practice, next-suggestion and results all shipped without
 * tests. They are almost entirely SQL, so a test that re-implements their
 * queries would only prove two copies of a query agree. These invoke the
 * REAL exported handlers, with a real signed JWT, against a real
 * PostgreSQL with RLS live — which means they also prove the endpoints are
 * gated, that a student cannot read another student's work, and that the
 * suggestion rules fire in the order they claim.
 *
 *   DATABASE_URL=postgresql://shikhon_runtime:… node --test services/academics-svc/test/api.test.ts
 *
 * Connect as the NON-privileged runtime role. sharedDb() refuses to boot on
 * a BYPASSRLS role, and every isolation assertion below would otherwise
 * pass vacuously.
 *
 * The suite provisions its own tenant and deletes it at the end, so it is
 * safe to point at any environment.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { createDb, type Db, type TenantContext } from '../../../packages/server-core/src/db.ts';
import { installTestKeys, call } from '../../../packages/server-core/test/harness.ts';

const DATABASE_URL = process.env.DATABASE_URL;
const skip = !DATABASE_URL ? 'DATABASE_URL not set' : false;

const T = '7a000000-0000-4000-8000-00000000000a';   // our tenant
const OTHER = '7b000000-0000-4000-8000-00000000000b'; // a second school
const TEACHER = '7a000000-0000-4000-8000-00000000aaa1';
const STUDENT = '7a000000-0000-4000-8000-00000000bbb1';
const STUDENT2 = '7a000000-0000-4000-8000-00000000bbb2';
const YEAR = '7a000000-0000-4000-8000-0000000000c1';
const CLASS = '7a000000-0000-4000-8000-0000000000c2';
const SECTION = '7a000000-0000-4000-8000-0000000000c3';
const SUBJECT = '7a000000-0000-4000-8000-0000000000c4';
const CH1 = '7a000000-0000-4000-8000-0000000000d1';
const CH2 = '7a000000-0000-4000-8000-0000000000d2';
const L1 = '7a000000-0000-4000-8000-0000000000e1';
const L2 = '7a000000-0000-4000-8000-0000000000e2';
const L3 = '7a000000-0000-4000-8000-0000000000e3';
const Q1 = '7a000000-0000-4000-8000-0000000000f1';
const Q2 = '7a000000-0000-4000-8000-0000000000f2';

let db: Db;
let teacherToken: string;
let studentToken: string;
let student2Token: string;
let otherTenantToken: string;

// Imported after installTestKeys() so nothing caches a key that is not there.
let assignments: typeof import('../api/assignments.ts').default;
let practice: typeof import('../api/practice.ts').default;
let next: typeof import('../api/next.ts').default;
let results: typeof import('../api/results.ts').default;
let subjects: typeof import('../api/subjects.ts').default;
let attendance: typeof import('../api/attendance.ts').default;

const asTeacher: TenantContext = { tenantId: T, userId: TEACHER, role: 'class_teacher' };
const asStudent: TenantContext = { tenantId: T, userId: STUDENT, role: 'student' };

/**
 * Delete the fixture tenants. Cascades to everything below them.
 *
 * Runs BEFORE seeding as well as after, because a run that dies partway
 * leaves its tenant behind and the next run then fails on a duplicate key
 * — a confusing failure that has nothing to do with what is being tested.
 * Scoped per tenant via withTenant, since tenant_self (migration 010)
 * only lets a session touch the tenant it has adopted.
 */
async function dropFixtures(): Promise<void> {
  for (const id of [T, OTHER]) {
    await db.withTenant({ tenantId: id, userId: TEACHER, role: 'principal' }, async (c) => {
      await c.query('DELETE FROM tenants WHERE id = $1', [id]);
    });
  }
}

async function seed(): Promise<void> {
  await dropFixtures();
  await db.withTenant({ tenantId: T, userId: TEACHER, role: 'principal' }, async (c) => {
    await c.query(
      `INSERT INTO tenants (id, slug, name_bn, name_en, stream, level)
       VALUES ($1,'f106-a','পরীক্ষা ক','Test A','bangla_medium','secondary')`, [T]);
    await c.query(
      `INSERT INTO users (id, tenant_id, full_name_bn, full_name_en, phone_e164) VALUES
         ($1,$4,'শিক্ষক','Teacher','+8801797000001'),
         ($2,$4,'ছাত্র এক','Student One','+8801797000002'),
         ($3,$4,'ছাত্র দুই','Student Two','+8801797000003')`,
      [TEACHER, STUDENT, STUDENT2, T]);
    await c.query(
      `INSERT INTO academic_years (id, tenant_id, label, starts_on, ends_on, is_current)
       VALUES ($1,$2,'2026','2026-01-01','2026-12-31',true)`, [YEAR, T]);
    await c.query(
      `INSERT INTO classes (id, tenant_id, level_no, name_bn, name_en, stream)
       VALUES ($1,$2,9,'নবম','Nine','bangla_medium')`, [CLASS, T]);
    // The teacher is the section's class teacher. Not decoration: a
    // class_teacher only sees students in sections they actually hold
    // (app.my_section_ids), so without this the teacher cannot read the
    // submission they are supposed to grade — and the test would be
    // asserting against a teacher who has no business seeing this student.
    await c.query(
      `INSERT INTO sections (id, tenant_id, class_id, academic_year_id, name, class_teacher_id)
       VALUES ($1,$2,$3,$4,'ক',$5)`, [SECTION, T, CLASS, YEAR, TEACHER]);
    await c.query(
      `INSERT INTO subjects (id, tenant_id, nctb_code, name_bn, name_en)
       VALUES ($1,$2,'127','পদার্থবিজ্ঞান','Physics')`, [SUBJECT, T]);
    await c.query(
      `INSERT INTO enrolments (tenant_id, student_id, section_id, academic_year_id, roll_no, status)
       VALUES ($1,$2,$3,$4,1,'active'), ($1,$5,$3,$4,2,'active')`,
      [T, STUDENT, SECTION, YEAR, STUDENT2]);

    // Two chapters; the second requires the first.
    await c.query(
      `INSERT INTO chapters (id, tenant_id, subject_id, class_id, chapter_no, name_bn, is_published)
       VALUES ($1,$3,$4,$5,1,'অধ্যায় ১: গতি',true),
              ($2,$3,$4,$5,2,'অধ্যায় ২: বল',true)`,
      [CH1, CH2, T, SUBJECT, CLASS]);
    await c.query(
      `INSERT INTO chapter_prerequisites (tenant_id, chapter_id, prerequisite_id)
       VALUES ($1, $2, $3)`, [T, CH2, CH1]);

    await c.query(
      `INSERT INTO topics (id, tenant_id, chapter_id, topic_no, title_bn, is_published)
       VALUES ($1,$4,$5,1,'পাঠ ১',true), ($2,$4,$5,2,'পাঠ ২',true), ($3,$4,$6,1,'পাঠ ৩',true)`,
      [L1, L2, L3, T, CH1, CH2]);

    await c.query(
      `INSERT INTO practice_questions (id, tenant_id, topic_id, question_no, kind, stem_bn, explanation_bn)
       VALUES ($1,$3,$4,1,'mcq','গতি কী?','ব্যাখ্যা এক'),
              ($2,$3,$4,2,'mcq','বল কী?','ব্যাখ্যা দুই')`,
      [Q1, Q2, T, L1]);
    await c.query(
      `INSERT INTO practice_options (tenant_id, question_id, option_no, text_bn, is_correct)
       VALUES ($1,$2,1,'সঠিক',true), ($1,$2,2,'ভুল',false),
              ($1,$3,1,'সঠিক',true), ($1,$3,2,'ভুল',false)`,
      [T, Q1, Q2]);
  });

  // A second school, to prove isolation rather than assume it.
  await db.withTenant({ tenantId: OTHER, userId: TEACHER, role: 'principal' }, async (c) => {
    await c.query(
      `INSERT INTO tenants (id, slug, name_bn, name_en, stream, level)
       VALUES ($1,'f106-b','পরীক্ষা খ','Test B','bangla_medium','secondary')`, [OTHER]);
  });
}

before(async () => {
  if (skip) return;
  await installTestKeys();
  db = createDb(DATABASE_URL!);

  const { signAccessToken } = await import('../../../packages/server-core/src/jwt.ts');
  teacherToken = await signAccessToken({ sub: TEACHER, tid: T, role: 'class_teacher', roles: ['class_teacher'] });
  studentToken = await signAccessToken({ sub: STUDENT, tid: T, role: 'student', roles: ['student'] });
  student2Token = await signAccessToken({ sub: STUDENT2, tid: T, role: 'student', roles: ['student'] });
  otherTenantToken = await signAccessToken({ sub: TEACHER, tid: OTHER, role: 'class_teacher', roles: ['class_teacher'] });

  assignments = (await import('../api/assignments.ts')).default;
  practice = (await import('../api/practice.ts')).default;
  next = (await import('../api/next.ts')).default;
  results = (await import('../api/results.ts')).default;
  subjects = (await import('../api/subjects.ts')).default;
  attendance = (await import('../api/attendance.ts')).default;

  await seed();
});

after(async () => {
  if (skip || !db) return;
  await dropFixtures();
  await db.end();
  const { sharedDb } = await import('../../../packages/server-core/src/db.ts');
  await (await sharedDb()).end();
});

/* ════════════════════════════════════════════════ every endpoint is gated */

describe('authentication', { skip }, () => {
  const endpoints = () => [
    ['assignments', assignments, '/api/v1/academics/assignments'],
    ['practice', practice, `/api/v1/academics/practice?topicId=${L1}`],
    ['next', next, '/api/v1/academics/next'],
    ['results', results, '/api/v1/academics/results'],
    ['subjects', subjects, '/api/v1/academics/subjects'],
    ['attendance', attendance, '/api/v1/academics/attendance'],
  ] as const;

  test('no token is 401 on every endpoint', async () => {
    for (const [name, handler, url] of endpoints()) {
      const r = await call(handler, { url });
      assert.equal(r.status, 401, `${name} answered ${r.status} without a token`);
    }
  });

  test('a garbage token is 401, not 500', async () => {
    for (const [name, handler, url] of endpoints()) {
      const r = await call(handler, { url, token: 'not.a.jwt' });
      assert.equal(r.status, 401, `${name} answered ${r.status} to a forged token`);
    }
  });
});

/* ═══════════════════════════════════════════════════════════ assignments */

describe('assignments', { skip }, () => {
  let assignmentId = '';

  test('a student cannot create one', async () => {
    const r = await call(assignments, {
      method: 'POST', token: studentToken,
      url: '/api/v1/academics/assignments',
      body: {
        sectionId: SECTION, subjectId: SUBJECT, academicYearId: YEAR,
        titleBn: 'ছাত্রের বানানো', dueAt: new Date(Date.now() + 864e5).toISOString(),
      },
    });
    assert.equal(r.status, 403);
  });

  test('a due date in the past is refused', async () => {
    // Homework due yesterday is always a typo, and accepting it puts a
    // permanently-overdue card at the top of every student's list.
    const r = await call(assignments, {
      method: 'POST', token: teacherToken,
      url: '/api/v1/academics/assignments',
      body: {
        sectionId: SECTION, subjectId: SUBJECT, academicYearId: YEAR,
        titleBn: 'অতীত', dueAt: new Date(Date.now() - 864e5).toISOString(),
      },
    });
    assert.equal(r.status, 400);
    assert.equal(r.body.error, 'due_in_past');
  });

  test('a teacher can create one', async () => {
    const r = await call(assignments, {
      method: 'POST', token: teacherToken,
      url: '/api/v1/academics/assignments',
      body: {
        sectionId: SECTION, subjectId: SUBJECT, academicYearId: YEAR,
        titleBn: 'রচনা লেখো', maxMarks: 20,
        dueAt: new Date(Date.now() + 2 * 864e5).toISOString(),
      },
    });
    assert.equal(r.status, 200, r.raw);
    assignmentId = r.body.assignmentId as string;
    assert.ok(assignmentId);
  });

  test('the detail view carries rowVersion, without which grading is impossible', async () => {
    await db.withTenant(asStudent, async (c) => {
      await c.query(
        `INSERT INTO assignment_submissions (id, tenant_id, assignment_id, student_id, body_bn, submitted_at)
         VALUES (gen_random_uuid(), $1, $2, $3, 'আমার উত্তর', now())`,
        [T, assignmentId, STUDENT]);
    });
    const r = await call(assignments, {
      token: teacherToken, url: `/api/v1/academics/assignments?assignmentId=${assignmentId}`,
    });
    assert.equal(r.status, 200, r.raw);
    const subs = r.body.submissions as { rowVersion: number; studentId: string }[];
    assert.equal(subs.length, 1);
    assert.equal(typeof subs[0].rowVersion, 'number');
    assert.ok(subs[0].rowVersion >= 1);
  });

  test('grading without rowVersion is refused — F-103 cannot be opted out of', async () => {
    const detail = await call(assignments, {
      token: teacherToken, url: `/api/v1/academics/assignments?assignmentId=${assignmentId}`,
    });
    const sub = (detail.body.submissions as { id: string }[])[0];
    const r = await call(assignments, {
      method: 'POST', token: teacherToken, url: '/api/v1/academics/assignments',
      body: { submissionId: sub.id, marksAwarded: 15 },
    });
    assert.equal(r.status, 400);
    assert.equal(r.body.error, 'row_version_required');
  });

  test('marks above the maximum are refused, and say what the maximum is', async () => {
    const detail = await call(assignments, {
      token: teacherToken, url: `/api/v1/academics/assignments?assignmentId=${assignmentId}`,
    });
    const sub = (detail.body.submissions as { id: string; rowVersion: number }[])[0];
    const r = await call(assignments, {
      method: 'POST', token: teacherToken, url: '/api/v1/academics/assignments',
      body: { submissionId: sub.id, marksAwarded: 999, rowVersion: sub.rowVersion },
    });
    assert.equal(r.status, 422);
    assert.equal(r.body.error, 'marks_exceed_max');
    assert.ok(String(r.body.message).includes('20'), 'the message must name the maximum');
  });

  test('a valid grade lands and bumps the version', async () => {
    const detail = await call(assignments, {
      token: teacherToken, url: `/api/v1/academics/assignments?assignmentId=${assignmentId}`,
    });
    const sub = (detail.body.submissions as { id: string; rowVersion: number }[])[0];
    const r = await call(assignments, {
      method: 'POST', token: teacherToken, url: '/api/v1/academics/assignments',
      body: { submissionId: sub.id, marksAwarded: 15, feedbackBn: 'ভালো', rowVersion: sub.rowVersion },
    });
    assert.equal(r.status, 200, r.raw);
    assert.equal(r.body.rowVersion, sub.rowVersion + 1);
  });

  test('a second grade at the stale version is a 409 naming the other grader', async () => {
    // The whole point of F-103, exercised through the real endpoint rather
    // than the SQL: the loser must be told who beat them, not "rejected".
    const detail = await call(assignments, {
      token: teacherToken, url: `/api/v1/academics/assignments?assignmentId=${assignmentId}`,
    });
    const sub = (detail.body.submissions as { id: string; rowVersion: number }[])[0];
    const stale = sub.rowVersion - 1;
    const r = await call(assignments, {
      method: 'POST', token: teacherToken, url: '/api/v1/academics/assignments',
      body: { submissionId: sub.id, marksAwarded: 8, rowVersion: stale },
    });
    assert.equal(r.status, 409, r.raw);
    assert.equal(r.body.error, 'grade_conflict');
    const conflict = r.body.conflict as {
      yours: { marksAwarded: number }; theirs: { marksAwarded: string; gradedByName: string };
    };
    assert.equal(conflict.yours.marksAwarded, 8);
    assert.equal(Number(conflict.theirs.marksAwarded), 15);
    assert.equal(conflict.theirs.gradedByName, 'শিক্ষক');
  });

  test('another school sees none of it', async () => {
    const r = await call(assignments, { token: otherTenantToken, url: '/api/v1/academics/assignments' });
    assert.equal(r.status, 200);
    assert.equal((r.body.assignments as unknown[]).length, 0);
  });
});

/* ══════════════════════════════════════════════════════════════ practice */

describe('practice', { skip }, () => {
  test('a malformed topicId is a 400, not a database error', async () => {
    const r = await call(practice, { token: studentToken, url: '/api/v1/academics/practice?topicId=nope' });
    assert.equal(r.status, 400);
    assert.equal(r.body.error, 'invalid_topic_id');
  });

  test('questions come back with their options and the explanation', async () => {
    // The answer key IS sent deliberately (see the endpoint header): practice
    // is formative and must work with no signal. This asserts that trade is
    // actually in effect rather than half-implemented.
    const r = await call(practice, { token: studentToken, url: `/api/v1/academics/practice?topicId=${L1}` });
    assert.equal(r.status, 200, r.raw);
    const qs = r.body.questions as {
      id: string; stemBn: string; explanationBn: string | null;
      options: { isCorrect: boolean }[];
    }[];
    assert.equal(qs.length, 2);
    assert.ok(qs[0].explanationBn, 'the explanation must ship for offline feedback');
    assert.equal(qs[0].options.length, 2);
    assert.equal(qs[0].options.filter((o) => o.isCorrect).length, 1);
  });

  test('one student never sees another student\'s attempts', async () => {
    await db.withTenant(asStudent, async (c) => {
      await c.query(
        `INSERT INTO practice_attempts
           (id, tenant_id, question_id, student_id, topic_id, attempt_no, is_correct)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, 1, false)`,
        [T, Q1, STUDENT, L1]);
    });

    const mine = await call(practice, { token: studentToken, url: `/api/v1/academics/practice?topicId=${L1}` });
    const theirs = await call(practice, { token: student2Token, url: `/api/v1/academics/practice?topicId=${L1}` });

    const attempted = (r: typeof mine) =>
      (r.body.questions as { myProgress: { attempts: number } }[])
        .filter((q) => q.myProgress.attempts > 0).length;

    assert.ok(attempted(mine) >= 1, 'a student must see their own attempt history');
    assert.equal(attempted(theirs), 0, 'a student must NOT see another student\'s attempts');
  });

  test('another school gets nothing for the same topic id', async () => {
    const r = await call(practice, { token: otherTenantToken, url: `/api/v1/academics/practice?topicId=${L1}` });
    // Either an empty set or a 404 is correct; leaking the questions is not.
    if (r.status === 200) {
      assert.equal((r.body.questions as unknown[]).length, 0);
    } else {
      assert.ok(r.status === 404 || r.status === 403, `unexpected ${r.status}`);
    }
  });
});

/* ═════════════════════════════════════════════════ what to study next */

describe('next-suggestion', { skip }, () => {
  test('never returns more than three — a longer list is a menu again', async () => {
    const r = await call(next, { token: studentToken, url: '/api/v1/academics/next' });
    assert.equal(r.status, 200, r.raw);
    assert.ok((r.body.suggestions as unknown[]).length <= 3);
  });

  test('every suggestion carries a reason the student can argue with', async () => {
    // The endpoint's premise: deterministic rules, each explainable. A
    // suggestion with an empty whyBn is the failure mode that turns this
    // back into an opaque recommender.
    const r = await call(next, { token: studentToken, url: '/api/v1/academics/next' });
    for (const s of r.body.suggestions as { whyBn: string; route: string; refId: string; kind: string }[]) {
      assert.ok(s.whyBn && s.whyBn.trim().length > 0, `empty reason on a ${s.kind} suggestion`);
      assert.ok(s.route, 'a suggestion the UI cannot navigate to is useless');
      assert.ok(s.refId);
    }
  });

  test('an unsubmitted assignment due soon outranks everything else', async () => {
    // Rule 1. A deadline someone else set beats anything self-paced, and
    // STUDENT2 has submitted nothing.
    await call(assignments, {
      method: 'POST', token: teacherToken, url: '/api/v1/academics/assignments',
      body: {
        sectionId: SECTION, subjectId: SUBJECT, academicYearId: YEAR,
        titleBn: 'কাল জমা', dueAt: new Date(Date.now() + 36e5 * 20).toISOString(),
      },
    });
    const r = await call(next, { token: student2Token, url: '/api/v1/academics/next' });
    const first = (r.body.suggestions as { kind: string; urgency: string }[])[0];
    assert.equal(first?.kind, 'assignment');
    assert.equal(first.urgency, 'high');
  });

  test('a question last answered wrong comes back as practice to redo', async () => {
    // Rule 2. STUDENT has one wrong attempt on Q1 (seeded above) and no
    // pending homework, so redo_practice should surface.
    const r = await call(next, { token: studentToken, url: '/api/v1/academics/next' });
    const kinds = (r.body.suggestions as { kind: string }[]).map((s) => s.kind);
    assert.ok(kinds.includes('redo_practice'), `expected redo_practice, got ${kinds.join(', ')}`);
  });

  test('a question eventually answered correctly is NOT a gap', async () => {
    // Only the LATEST attempt counts. Treating every past mistake as an
    // outstanding gap would bury a student under work they have already done.
    await db.withTenant(asStudent, async (c) => {
      await c.query(
        `INSERT INTO practice_attempts
           (id, tenant_id, question_id, student_id, topic_id, attempt_no, is_correct)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, 2, true)`,
        [T, Q1, STUDENT, L1]);
    });
    const r = await call(next, { token: studentToken, url: '/api/v1/academics/next' });
    const kinds = (r.body.suggestions as { kind: string }[]).map((s) => s.kind);
    assert.ok(!kinds.includes('redo_practice'),
      'a corrected question must stop being suggested');
  });

  test('a half-finished chapter beats starting a new one', async () => {
    // Rule 3 above rule 4. Finishing what is already open is the
    // higher-yield twenty minutes, and pushing a student forward while
    // something behind them is unfinished is the behaviour being avoided.
    await db.withTenant(asStudent, async (c) => {
      await c.query(
        `INSERT INTO topic_progress (id, tenant_id, topic_id, student_id, state, completed_at)
         VALUES (gen_random_uuid(), $1, $2, $3, 'completed', now())`,
        [T, L1, STUDENT]);
    });
    const r = await call(next, { token: studentToken, url: '/api/v1/academics/next' });
    const s = r.body.suggestions as { kind: string; refId: string }[];
    const cont = s.find((x) => x.kind === 'continue_topic');
    const fresh = s.find((x) => x.kind === 'new_chapter');
    assert.ok(cont, `expected continue_topic, got ${s.map((x) => x.kind).join(', ')}`);
    assert.equal(cont.refId, L2, 'it must point at the next unread topic in the begun chapter');
    if (fresh) {
      assert.ok(s.indexOf(cont) < s.indexOf(fresh), 'continue must rank above new_chapter');
    }
  });

  test('a new chapter is only offered once its prerequisite is complete', async () => {
    // Rule 4, and the reason F-104 matters: chapter 2 requires chapter 1.
    const before = await call(next, { token: student2Token, url: '/api/v1/academics/next' });
    const beforeIds = (before.body.suggestions as { refId: string }[]).map((s) => s.refId);
    assert.ok(!beforeIds.includes(CH2), 'chapter 2 was offered before chapter 1 was touched');
  });

  test('suggestions are per-student, not per-section', async () => {
    const mine = await call(next, { token: studentToken, url: '/api/v1/academics/next' });
    const theirs = await call(next, { token: student2Token, url: '/api/v1/academics/next' });
    assert.notDeepEqual(
      (mine.body.suggestions as { kind: string; refId: string }[]).map((s) => `${s.kind}:${s.refId}`),
      (theirs.body.suggestions as { kind: string; refId: string }[]).map((s) => `${s.kind}:${s.refId}`),
      'two students with different histories got identical advice',
    );
  });

  test('another school gets an empty list, not ours', async () => {
    const r = await call(next, { token: otherTenantToken, url: '/api/v1/academics/next' });
    assert.equal(r.status, 200);
    assert.equal((r.body.suggestions as unknown[]).length, 0);
  });
});

/* ═══════════════════════════════════════════════════════════════ results */

describe('results', { skip }, () => {
  test('a student sees only their own', async () => {
    const r = await call(results, { token: studentToken, url: '/api/v1/academics/results' });
    assert.equal(r.status, 200, r.raw);
    const rows = (r.body.results ?? []) as { studentId?: string }[];
    for (const row of rows) {
      if (row.studentId) assert.equal(row.studentId, STUDENT);
    }
  });

  test('another school sees nothing', async () => {
    const r = await call(results, { token: otherTenantToken, url: '/api/v1/academics/results' });
    assert.equal(r.status, 200);
    assert.equal(((r.body.results ?? []) as unknown[]).length, 0);
  });
});

/* ═════════════════════════════════════════════ F-802 — my subjects */

describe('my subjects', { skip }, () => {
  // The fixture has no subject template, so derivation has nothing to
  // resolve. That is the honest zero state for a school mid-onboarding,
  // and the endpoint must render it rather than error.
  test('a student with no derived subjects gets an empty list, not an error', async () => {
    const r = await call(subjects, { token: studentToken, url: '/api/v1/academics/subjects' });
    assert.equal(r.status, 200, r.raw);
    assert.ok(Array.isArray(r.body.subjects));
  });

  test('a malformed studentId is a 400, not a database error', async () => {
    const r = await call(subjects, {
      token: teacherToken, url: '/api/v1/academics/subjects?studentId=nope',
    });
    assert.equal(r.status, 400);
    assert.equal(r.body.error, 'invalid_student_id');
  });

  test('a derived subject set comes back with progress and the next chapter', async () => {
    // Build the smallest real template: one compulsory subject, one
    // published chapter, one published topic.
    await db.withTenant({ tenantId: T, userId: TEACHER, role: 'principal' }, async (c) => {
      const scheme = '7a000000-0000-4000-8000-00000000005c';
      const tpl    = '7a000000-0000-4000-8000-00000000007c';
      await c.query(
        `INSERT INTO curriculum_schemes
           (id, tenant_id, academic_year_id, stage, assessment_model, grade_rule_set, effective_from)
         VALUES ($1,$2,$3,'secondary','marks_cq_mcq',
                 '{"bands":[{"min":0,"grade":"F","point":0}]}'::jsonb,'2026-01-01')`,
        [scheme, T, YEAR]);
      await c.query(
        `INSERT INTO subject_templates (id, tenant_id, curriculum_scheme_id, class_id, group_code)
         VALUES ($1,$2,$3,$4,NULL)`, [tpl, T, scheme, CLASS]);
      await c.query(
        `INSERT INTO subject_template_items
           (tenant_id, template_id, subject_id, requirement_type, display_order)
         VALUES ($1,$2,$3,'compulsory',1)`, [T, tpl, SUBJECT]);
      await c.query(
        `INSERT INTO topics (id, tenant_id, chapter_id, topic_no, title_bn, is_published)
         VALUES (gen_random_uuid(), $1, $2, 9, 'পাঠ ৯', true)`, [T, CH1]);
      await c.query(`SELECT app.derive_student_subjects($1::uuid)`, [
        (await c.query('SELECT id FROM enrolments WHERE student_id = $1', [STUDENT])).rows[0].id,
      ]);
    });

    const r = await call(subjects, { token: studentToken, url: '/api/v1/academics/subjects' });
    assert.equal(r.status, 200, r.raw);
    const list = r.body.subjects as {
      nameBn: string; requirementType: string; requirementLabelBn: string;
      totalChapters: number; progressPercent: number;
      nextChapter: { chapterNo: number } | null;
    }[];
    assert.equal(list.length, 1, 'the derived set should hold exactly the templated subject');
    assert.equal(list[0].requirementType, 'compulsory');
    // The chip is a Bangla LABEL, so requirement type is never carried by
    // colour alone (F-812, wireframe §6.2).
    assert.equal(list[0].requirementLabelBn, 'আবশ্যিক');
    assert.ok(list[0].totalChapters >= 1, 'published chapters should be counted');
    assert.ok(list[0].nextChapter, 'an unfinished chapter must surface as the next one');
  });

  test('a student cannot read another student\'s subject set', async () => {
    // Not an ordinary read scope: a subject set reveals a child's religion.
    // RLS returns nothing rather than erroring, so this asserts emptiness.
    const r = await call(subjects, {
      token: student2Token, url: `/api/v1/academics/subjects?studentId=${STUDENT}`,
    });
    assert.equal(r.status, 200);
    assert.equal((r.body.subjects as unknown[]).length, 0);
  });

  test('a teacher who holds the section can read it', async () => {
    const r = await call(subjects, {
      token: teacherToken, url: `/api/v1/academics/subjects?studentId=${STUDENT}`,
    });
    assert.equal(r.status, 200, r.raw);
    assert.ok((r.body.subjects as unknown[]).length >= 1);
  });

  test('another school sees nothing', async () => {
    const r = await call(subjects, {
      token: otherTenantToken, url: `/api/v1/academics/subjects?studentId=${STUDENT}`,
    });
    assert.equal(r.status, 200);
    assert.equal((r.body.subjects as unknown[]).length, 0);
  });
});

/* ═══════════════════════════════════════════ F-806 — my attendance */

describe('my attendance', { skip }, () => {
  test('excused absences are reported SEPARATELY and left out of the rate', async () => {
    // The requirement in one assertion. A child with excused absences for a
    // documented illness must not be scored as if they skipped.
    await db.withTenant({ tenantId: T, userId: TEACHER, role: 'class_teacher' }, async (c) => {
      const sess = (await c.query(
        `INSERT INTO attendance_sessions
           (id, tenant_id, section_id, academic_year_id, taken_on, mode, taken_by, taken_at)
         VALUES (gen_random_uuid(), $1, $2, $3, CURRENT_DATE, 'section_daily', $4, now())
         RETURNING id`, [T, SECTION, YEAR, TEACHER])).rows[0].id;
      for (const [day, status] of [[0, 'present'], [1, 'present'], [2, 'absent'], [3, 'excused']]) {
        await c.query(
          `INSERT INTO attendance_records
             (id, tenant_id, session_id, student_id, section_id, taken_on, status,
              marked_by, marked_at)
           VALUES (gen_random_uuid(), $1, $2, $3, $4, CURRENT_DATE - $5::int, $6, $7, now())`,
          [T, sess, STUDENT, SECTION, day, status, TEACHER]);
      }
    });

    const r = await call(attendance, { token: studentToken, url: '/api/v1/academics/attendance' });
    assert.equal(r.status, 200, r.raw);
    const t = r.body.totals as {
      present: number; absent: number; excused: number;
      counted: number; attendedPercent: number;
    };
    assert.equal(t.excused, 1, 'the excused day must be counted as excused');
    assert.equal(t.counted, 3, 'and must NOT appear in the denominator');
    // 2 attended of 3 counted = 67%. Folding the excused day in as a miss
    // would give 50%, which is the bug this asserts against.
    assert.equal(t.attendedPercent, 67);
  });

  test('the absence register lists dates, not just a percentage', async () => {
    const r = await call(attendance, { token: studentToken, url: '/api/v1/academics/attendance' });
    const recent = r.body.recent as { takenOn: string; status: string }[];
    assert.ok(recent.length >= 2, 'non-present days should be listed individually');
    assert.ok(recent.every((x) => x.status !== 'present'), 'present days are not absences');
    assert.ok(recent.every((x) => /^\d{4}-\d{2}-\d{2}$/.test(x.takenOn)), 'each carries a date');
  });

  test('months is clamped, so a hostile value cannot scan every partition', async () => {
    const r = await call(attendance, {
      token: studentToken, url: '/api/v1/academics/attendance?months=99999',
    });
    assert.equal(r.status, 200);
    assert.ok((r.body.months as number) <= 24);
  });

  test('a student cannot read another student\'s attendance', async () => {
    const r = await call(attendance, {
      token: student2Token, url: `/api/v1/academics/attendance?studentId=${STUDENT}`,
    });
    assert.equal(r.status, 200);
    assert.equal((r.body.totals as { counted: number }).counted, 0);
  });

  test('another school sees nothing', async () => {
    const r = await call(attendance, {
      token: otherTenantToken, url: `/api/v1/academics/attendance?studentId=${STUDENT}`,
    });
    assert.equal(r.status, 200);
    assert.equal((r.body.totals as { counted: number }).counted, 0);
  });
});
