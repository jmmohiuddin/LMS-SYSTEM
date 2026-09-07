/**
 * P9-7 — review, then publish.
 *
 * Publishing is the only irreversible act in the routine workstream. A draft
 * can be regenerated, an edit can be undone, a scoped re-solve can be rolled
 * back — but the moment `routines.status` becomes `active`, every student,
 * guardian and teacher in the school is looking at it. So these are the
 * properties that decide whether that act can be trusted:
 *
 *   1. A HARD CONFLICT BLOCKS. §4, and the one the earlier probe could not
 *      exercise. One teacher in two rooms at nine on Sunday is a timetable
 *      that cannot be taught, and no confirmation dialog makes it teachable.
 *      Proved by planting the conflict and confirming it at DB level, so the
 *      test cannot pass by the gate merely being wired to a constant.
 *
 *   2. A REFUSAL CHANGES NOTHING. §7. Half a publish — routine active, slots
 *      still draft — is a school whose timetable exists for the database and
 *      not for the people in it.
 *
 *   3. REVIEW IS INVISIBLE. §8. `review` is a real status this phase started
 *      writing; if it leaked to students it would be worse than no review
 *      state at all, because a coordinator would believe it private.
 *
 *   4. WARNINGS ARE CONFIRMED, NOT ASSUMED. §5. Publishing over a known gap
 *      is allowed and is a decision; publishing over one silently is not.
 *
 *   5. THE SCREEN AND THE SERVER AGREE. `canPublish` is computed by the same
 *      function that refuses. A review saying "ready" followed by a 409 is
 *      the defect the shared gate exists to prevent.
 *
 *   DATABASE_URL=postgres://shikhon_app:… \
 *     node --test services/rms-svc/test/publish.test.ts
 */
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { createDb, type Db, type TenantContext } from '../../../packages/server-core/src/db.ts';
import { formatCount } from '../../../packages/ui-core/src/format.ts';
import {
  installTestKeys, call, lockFixtures, unlockFixtures, asBootstrap,
} from '../../../packages/server-core/test/harness.ts';

const DATABASE_URL = process.env.DATABASE_URL;
const skip = !DATABASE_URL ? 'DATABASE_URL not set' : false;

const T       = '7c970000-0000-4000-8000-0000000000a0';
const HEAD    = '7c970000-0000-4000-8000-0000000000a1';
const RAFIQ   = '7c970000-0000-4000-8000-0000000000a2';
const SALMA   = '7c970000-0000-4000-8000-0000000000a3';
const STUDENT = '7c970000-0000-4000-8000-0000000000a4';
const ITADMIN = '7c970000-0000-4000-8000-0000000000a5';
const YEAR    = '7c970000-0000-4000-8000-0000000000c1';
const KLASS   = '7c970000-0000-4000-8000-0000000000d1';
const SEC_A   = '7c970000-0000-4000-8000-0000000000e1';
const SEC_B   = '7c970000-0000-4000-8000-0000000000e2';
const BANGLA  = '7c970000-0000-4000-8000-0000000000f1';
const MATHS   = '7c970000-0000-4000-8000-0000000000f2';
const TPL     = '7c970000-0000-4000-8000-00000000ab01';
const ROOM_A  = '7c970000-0000-4000-8000-00000000ab02';
const ROOM_B  = '7c970000-0000-4000-8000-00000000ab04';
const ROUTINE = '7c970000-0000-4000-8000-00000000ab03';

const T_B     = '7c970000-0000-4000-8000-0000000000b0';
const HEAD_B  = '7c970000-0000-4000-8000-0000000000b1';

let db: Db;
let headToken = '';
let headBToken = '';
let studentToken = '';
let teacherToken = '';
let itToken = '';
let publish: Parameters<typeof call>[0];
let generate: Parameters<typeof call>[0];
let editor: Parameters<typeof call>[0];

const head: TenantContext = { tenantId: T, userId: HEAD, role: 'principal' };
const headB: TenantContext = { tenantId: T_B, userId: HEAD_B, role: 'principal' };

const post = (h: Parameters<typeof call>[0], body: unknown, token = headToken) =>
  call(h, { method: 'POST', url: '/', token, body } as Parameters<typeof call>[1]);
const getReview = (qs: string, token = headToken) =>
  call(publish, { method: 'GET', url: `/?${qs}`, token } as Parameters<typeof call>[1]);

/** The one routine's own review payload, as the screen would receive it. */
const review = async (token = headToken) => {
  const r = await getReview(`routineId=${ROUTINE}`, token);
  return r.body as {
    ok?: boolean;
    routine?: {
      status: string; statusBn: string; slots: number; sections: number;
      teachers: number; pinned: number; hardConflicts: number;
      unplacedDemands: number; softViolations: number; fingerprint: string;
      canPublish: boolean; version: number; shiftBn: string; yearLabel: string;
      lastModified: string | null;
      warnings: Array<{ code: string; messageBn: string }>;
      blockers: Array<{ code: string; messageBn: string }>;
      supersedes: { version: number } | null;
      consequenceBn: string[];
      verdictBn: string;
    };
  };
};

const routineRow = async () => {
  const { rows } = await asBootstrap(db, head, (c) => c.query<{
    status: string; stamped: boolean; published_by: string | null;
    live: number; total: number;
  }>(
    `SELECT status::text AS status, published_at IS NOT NULL AS stamped, published_by,
            (SELECT count(*)::int FROM routine_slots s
              WHERE s.routine_id = r.id AND s.status = 'active'
                AND s.routine_status = 'active') AS live,
            (SELECT count(*)::int FROM routine_slots s
              WHERE s.routine_id = r.id AND s.status = 'active') AS total
       FROM routines r WHERE r.id = $1`, [ROUTINE]));
  return rows[0];
};

/**
 * Give two lessons at the same hour the same teacher.
 *
 * The teacher exclusion is `WHERE status = 'active' AND routine_status =
 * 'active'`, so a DRAFT can hold this state — which is precisely why the
 * publish has to catch it. Returns the row it damaged so it can be restored.
 */
const plantTeacherConflict = async () => {
  const { rows } = await asBootstrap(db, head, (c) => c.query<{
    a_teacher: string; b_id: string; b_teacher: string;
  }>(
    `SELECT a.teacher_id AS a_teacher, b.id AS b_id, b.teacher_id AS b_teacher
       FROM routine_slots a
       JOIN routine_slots b
         ON b.routine_id = a.routine_id AND b.id <> a.id
        AND b.day_of_week = a.day_of_week AND b.starts_at = a.starts_at
        AND b.teacher_id IS DISTINCT FROM a.teacher_id AND b.status = 'active'
      WHERE a.routine_id = $1 AND a.status = 'active'
        AND a.teacher_id IS NOT NULL AND b.teacher_id IS NOT NULL
      LIMIT 1`, [ROUTINE]));
  const p = rows[0];
  assert.ok(p, 'the fixture must have two lessons at one hour to collide');
  await asBootstrap(db, head, (c) => c.query(
    `UPDATE routine_slots SET teacher_id = $2 WHERE id = $1`, [p.b_id, p.a_teacher]));
  return () => asBootstrap(db, head, (c) => c.query(
    `UPDATE routine_slots SET teacher_id = $2 WHERE id = $1`, [p.b_id, p.b_teacher]));
};

/**
 * Ask for more Bangla than a week contains, and regenerate.
 *
 * Rafiq teaches Bangla in both sections, and the week has thirty teaching
 * hours; twenty periods in each section needs forty of his. The solver places
 * what it can and reports the rest as unplaced — a REAL warning, produced by
 * the real solver, rather than a state written into the row to make a test
 * pass. (The obvious alternative, a teaching slot with no teacher, cannot
 * exist: migration 006 forbids it.)
 */
const overSubscribe = async () => {
  await asBootstrap(db, head, (c) => c.query(
    `UPDATE class_subjects SET periods_per_week = 20
      WHERE tenant_id = $1 AND subject_id = $2`, [T, BANGLA]));
  await asBootstrap(db, head, async (c) => {
    await c.query('DELETE FROM routine_slots WHERE tenant_id = $1', [T]);
  });
  const r = await post(generate, { yearId: YEAR });
  assert.equal(r.status, 200, JSON.stringify(r.body));
};

/** Independent of the endpoint: does the database itself hold a clash? */
const clashesAtDbLevel = async (): Promise<number> => {
  const { rows } = await asBootstrap(db, head, (c) => c.query<{ n: number }>(
    `SELECT count(*)::int AS n
       FROM routine_slots a JOIN routine_slots b
         ON b.routine_id = a.routine_id AND b.id <> a.id
        AND b.day_of_week = a.day_of_week AND b.teacher_id = a.teacher_id
        AND b.starts_at < a.ends_at AND b.ends_at > a.starts_at
        AND b.status = 'active'
      WHERE a.routine_id = $1 AND a.status = 'active'`, [ROUTINE]));
  return rows[0].n;
};

describe('P9-7 — routine review and publish', { skip }, () => {
  before(async () => {
    await installTestKeys();
    await lockFixtures(DATABASE_URL as string);
    db = createDb(DATABASE_URL as string);

    await asBootstrap(db, head, async (c) => {
      await c.query('DELETE FROM tenants WHERE id = $1', [T]);
      await c.query(
        `INSERT INTO tenants (id, slug, name_bn, name_en, stream, level, weekend_days)
         VALUES ($1,'p97','পি৯৭ বিদ্যালয়','P97','bangla_medium','secondary','{5,6}')`, [T]);
      for (const [id, bn, phone, role] of [
        [HEAD, 'প্রধান শিক্ষক', '+8801799970001', 'principal'],
        [RAFIQ, 'রফিক স্যার', '+8801799970002', 'subject_teacher'],
        [SALMA, 'সালমা ম্যাডাম', '+8801799970003', 'subject_teacher'],
        [STUDENT, 'ছাত্র', '+8801799970004', 'student'],
        [ITADMIN, 'আইটি', '+8801799970005', 'it_admin'],
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
         VALUES ($1,'p97-other','পাশের','Other','bangla_medium','secondary')`, [T_B]);
      await c.query(
        `INSERT INTO users (id, tenant_id, full_name_bn, full_name_en, phone_e164, status)
         VALUES ($1,$2,'অন্য','B','+8801799970009','active')`, [HEAD_B, T_B]);
      await c.query(
        `INSERT INTO user_roles (tenant_id, user_id, role_code) VALUES ($1,$2,'principal')`,
        [T_B, HEAD_B]);
    });

    const { signAccessToken } = await import('../../../packages/server-core/src/jwt.ts');
    headToken = await signAccessToken({ sub: HEAD, tid: T, role: 'principal', roles: ['principal'] });
    headBToken = await signAccessToken({
      sub: HEAD_B, tid: T_B, role: 'principal', roles: ['principal'] });
    studentToken = await signAccessToken({
      sub: STUDENT, tid: T, role: 'student', roles: ['student'] });
    teacherToken = await signAccessToken({
      sub: RAFIQ, tid: T, role: 'subject_teacher', roles: ['subject_teacher'] });
    itToken = await signAccessToken({
      sub: ITADMIN, tid: T, role: 'it_admin', roles: ['it_admin'] });
    publish = (await import('../api/publish.ts')).default;
    generate = (await import('../api/generate.ts')).default;
    editor = (await import('../api/editor.ts')).default;
  });

  after(async () => {
    if (!db) return;
    for (const [ctx, id] of [[head, T], [headB, T_B]] as const) {
      await asBootstrap(db, ctx, (c) => c.query('DELETE FROM tenants WHERE id = $1', [id]));
    }
    await db.end();
    await unlockFixtures();
  });

  /** A freshly generated, unpublished routine every time. */
  beforeEach(async () => {
    await asBootstrap(db, head, async (c) => {
      await c.query(
        `UPDATE routine_edit_log SET undone_at = now()
          WHERE tenant_id = $1 AND undone_at IS NULL`, [T]);
      await c.query('DELETE FROM routine_slots WHERE tenant_id = $1', [T]);
      await c.query('DELETE FROM routines WHERE tenant_id = $1', [T]);
      await c.query(
        `INSERT INTO routines (id, tenant_id, academic_year_id, period_template_id, shift,
                               name_bn, version, status, effective_from, generated_by, created_by)
         VALUES ($1,$2,$3,$4,'single','খসড়া',1,'draft','2026-01-01','solver',$5)`,
        [ROUTINE, T, YEAR, TPL, HEAD]);
      // `overSubscribe` raises this; put it back so each test starts from a
      // routine the solver can satisfy completely.
      await c.query(
        `UPDATE class_subjects SET periods_per_week = 3 WHERE tenant_id = $1`, [T]);
    });
    const r = await post(generate, { yearId: YEAR });
    assert.equal(r.status, 200, JSON.stringify(r.body));
  });

  /* ─────────────────────────── §4 the blocker ─────────────────────────── */

  test('THE ONE THAT MATTERS — a teacher booked twice at one hour cannot be published', async () => {
    assert.equal(await clashesAtDbLevel(), 0, 'the generated routine starts clean');
    const restore = await plantTeacherConflict();
    // Independent of anything this phase wrote: the database really holds it.
    assert.ok(await clashesAtDbLevel() > 0, 'the conflict was actually planted');

    const seen = await review();
    assert.ok(seen.routine);
    assert.ok(seen.routine.hardConflicts > 0, 'the review counts it');
    assert.equal(seen.routine.canPublish, false, 'and says so before the button is pressed');
    assert.deepEqual(seen.routine.blockers.map((b) => b.code), ['hard_conflict']);

    // Confirming warnings must NOT get past it. A conflict is not a warning.
    const r = await post(publish, {
      action: 'publish', routineId: ROUTINE, confirmWarnings: true });
    assert.equal(r.status, 409, JSON.stringify(r.body));
    assert.equal((r.body as { error?: string }).error, 'hard_conflict');
    assert.match((r.body as { message?: string }).message ?? '', /একই সময়ে/);

    // §7 — and nothing moved.
    const row = await routineRow();
    assert.equal(row.status, 'draft', 'the routine is still a draft');
    assert.equal(row.stamped, false, 'nothing was stamped published');
    assert.equal(row.live, 0, 'not one slot went live');

    await restore();
    assert.equal(await clashesAtDbLevel(), 0);
    const r2 = await post(publish, {
      action: 'publish', routineId: ROUTINE, confirmWarnings: true });
    assert.equal(r2.status, 200, 'and once the conflict is gone it publishes');
  });

  test('the gate and the publisher never disagree', async () => {
    // §5's real risk is a review that says "ready" and a server that refuses.
    // They are the same function, and this is the assertion that keeps it so.
    const clean = await review();
    assert.equal(clean.routine?.canPublish, true);
    const restore = await plantTeacherConflict();
    const dirty = await review();
    assert.equal(dirty.routine?.canPublish, false);
    const refused = await post(publish, {
      action: 'publish', routineId: ROUTINE, confirmWarnings: true });
    assert.equal(refused.status, 409);
    await restore();
    const ok = await post(publish, {
      action: 'publish', routineId: ROUTINE, confirmWarnings: true });
    assert.equal(ok.status, 200);
  });

  test('an empty routine is refused — publishing nothing is never meant', async () => {
    await asBootstrap(db, head, (c) => c.query(
      `UPDATE routine_slots SET status = 'removed' WHERE routine_id = $1`, [ROUTINE]));
    const seen = await review();
    assert.equal(seen.routine?.slots, 0);
    assert.deepEqual(seen.routine?.blockers.map((b) => b.code), ['empty_routine']);
    const r = await post(publish, {
      action: 'publish', routineId: ROUTINE, confirmWarnings: true });
    assert.equal(r.status, 409);
    assert.equal((r.body as { error?: string }).error, 'empty_routine');
  });

  /* ─────────────────────── §2 the review surface ──────────────────────── */

  test('§2 — the review states every fact the brief asks a head to see', async () => {
    const seen = await review();
    const r = seen.routine;
    assert.ok(r);
    assert.equal(r.status, 'draft');
    assert.equal(r.statusBn, 'খসড়া', 'a status a head can read, not an enum');
    assert.equal(r.yearLabel, '2026');
    assert.equal(r.shiftBn, 'একক');
    assert.equal(r.version, 1);
    assert.ok(r.slots > 0, 'total scheduled periods');
    assert.equal(r.sections, 2, 'sections affected');
    assert.ok(r.teachers > 0);
    assert.equal(typeof r.pinned, 'number');
    assert.equal(typeof r.unplacedDemands, 'number');
    assert.ok(r.lastModified, 'last modified');
    assert.match(r.fingerprint, /^\d+:\d+$/, 'the version the screen was drawn from');
    assert.equal(r.supersedes, null, 'nothing is live for this shift yet');

    // The year-wide read carries the institution, for the screen's heading.
    const year = await getReview(`yearId=${YEAR}`);
    assert.equal(year.status, 200);
    const b = year.body as { tenantNameBn?: string; routines?: unknown[] };
    assert.equal(b.tenantNameBn, 'পি৯৭ বিদ্যালয়');
    assert.equal(b.routines?.length, 1);
  });

  test('§6 — the server composes what publishing would do, numbers and all', async () => {
    // The screen renders these; it does not build them. A browser that
    // assembled the sentence from the counters beside it would disagree with
    // them the first time either changed — P9-3's rule, and it matters most
    // on the one button in this workstream that cannot be undone.
    const seen = await review();
    const said = (seen.routine?.consequenceBn ?? []).join(' ');
    assert.match(said, new RegExp(`${formatCount(seen.routine!.slots, 'bn')}টি ক্লাস`),
      'the count in the sentence is the count on the card');
    assert.match(said, /শিক্ষক, শিক্ষার্থী ও অভিভাবক/, 'who will see it');
    assert.match(said, /সরাসরি বদলানো যাবে না/, 'and that it cannot be taken back');
    assert.doesNotMatch(said, /[0-9]/, 'Bangla numerals only');
    assert.equal(seen.routine?.verdictBn, 'এই রুটিন প্রকাশ করা যাবে।');

    await overSubscribe();
    const warned = await review();
    assert.ok((warned.routine?.consequenceBn ?? [])
      .some((l) => l.startsWith('মেনে নেওয়া হচ্ছে')),
      'every warning being accepted is named in the confirmation');

    const restore = await plantTeacherConflict();
    assert.equal((await review()).routine?.verdictBn, 'এই রুটিন এখনই প্রকাশ করা যাবে না।');
    await restore();
  });

  test('once one is live, the consequence says what would be replaced', async () => {
    await post(publish, { action: 'publish', routineId: ROUTINE, confirmWarnings: true });
    await post(generate, { yearId: YEAR });
    const { rows } = await asBootstrap(db, head, (c) => c.query<{ id: string }>(
      `SELECT id FROM routines WHERE tenant_id = $1 AND status = 'draft'`, [T]));
    const r = await getReview(`routineId=${rows[0].id}`);
    const said = ((r.body as { routine?: { consequenceBn: string[] } }).routine
      ?.consequenceBn ?? []).join(' ');
    assert.match(said, /১ নম্বর রুটিনটি বাতিল হয়ে যাবে/,
      'a head about to publish v2 is told v1 goes away');
  });

  test('the counts are the database, not a stored summary', async () => {
    const before = (await review()).routine?.slots ?? 0;
    await asBootstrap(db, head, (c) => c.query(
      `UPDATE routine_slots SET status = 'removed'
        WHERE id = (SELECT id FROM routine_slots
                     WHERE routine_id = $1 AND status = 'active' LIMIT 1)`, [ROUTINE]));
    assert.equal((await review()).routine?.slots, before - 1,
      'a routine edited outside this endpoint is still counted honestly');
  });

  test('once something is live, the review says what publishing would replace', async () => {
    await post(publish, { action: 'publish', routineId: ROUTINE, confirmWarnings: true });
    // A second draft for the same year and shift.
    const gen = await post(generate, { yearId: YEAR });
    assert.equal(gen.status, 200);
    const { rows } = await asBootstrap(db, head, (c) => c.query<{ id: string }>(
      `SELECT id FROM routines WHERE tenant_id = $1 AND status = 'draft'`, [T]));
    assert.equal(rows.length, 1, 'a new draft exists beside the published one');
    const seen = await getReview(`routineId=${rows[0].id}`);
    const r = (seen.body as { routine?: { supersedes: { version: number } | null } }).routine;
    assert.equal(r?.supersedes?.version, 1,
      'a head about to publish v2 is told v1 is what it replaces');
  });

  /* ───────────────────── §8 draft / review / published ─────────────────── */

  test('§8 — a routine in review is still invisible to the school', async () => {
    const sub = await post(publish, { action: 'submit', routineId: ROUTINE });
    assert.equal(sub.status, 200, JSON.stringify(sub.body));
    assert.equal((sub.body as { status?: string }).status, 'review');

    const { rows } = await asBootstrap(db, head, (c) => c.query<{ n: number; slots: number }>(
      `SELECT (SELECT count(*)::int FROM app.student_day($1::uuid, date '2026-03-01')) AS n,
              (SELECT count(*)::int FROM routine_slots s
                WHERE s.routine_id = $2 AND s.routine_status = 'review') AS slots`,
      [STUDENT, ROUTINE]));
    assert.equal(rows[0].n, 0, 'a student sees nothing of a routine under review');
    assert.ok(rows[0].slots > 0, 'and the status really did propagate to the slots');
  });

  test('§8 — publishing v2 does not disturb what v1 is showing until it lands', async () => {
    await post(publish, { action: 'publish', routineId: ROUTINE, confirmWarnings: true });
    const live = await asBootstrap(db, head, (c) => c.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM routine_slots
        WHERE routine_id = $1 AND status = 'active' AND routine_status = 'active'`, [ROUTINE]));
    assert.ok(live.rows[0].n > 0);

    await post(generate, { yearId: YEAR });
    const after = await asBootstrap(db, head, (c) => c.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM routine_slots
        WHERE routine_id = $1 AND status = 'active' AND routine_status = 'active'`, [ROUTINE]));
    assert.equal(after.rows[0].n, live.rows[0].n,
      'the published routine is untouched by a new draft beside it');
  });

  test('a routine may be sent to review and taken back', async () => {
    assert.equal((await post(publish, { action: 'submit', routineId: ROUTINE })).status, 200);
    assert.equal((await post(publish, { action: 'submit', routineId: ROUTINE })).status, 409,
      'submitting twice is a mistake worth naming');
    const back = await post(publish, { action: 'withdraw', routineId: ROUTINE });
    assert.equal(back.status, 200);
    assert.equal((back.body as { status?: string }).status, 'draft');
  });

  test('a routine under review can still be edited — that is what review is for', async () => {
    await post(publish, { action: 'submit', routineId: ROUTINE });
    const { rows } = await asBootstrap(db, head, (c) => c.query<{ id: string; v: number }>(
      `SELECT id, row_version AS v FROM routine_slots
        WHERE routine_id = $1 AND status = 'active' LIMIT 1`, [ROUTINE]));
    const r = await post(editor, {
      action: 'remove', slotId: rows[0].id, rowVersion: rows[0].v });
    assert.equal(r.status, 200, JSON.stringify(r.body));
  });

  /* ───────────────────────── §5 warnings ──────────────────────────────── */

  test('§5 — a warning must be acknowledged, and acknowledging it is enough', async () => {
    await overSubscribe();
    const seen = await review();
    const codes = (seen.routine?.warnings ?? []).map((w) => w.code);
    assert.ok(codes.includes('unplaced'),
      `the solver must actually have reported a gap: ${JSON.stringify(codes)}`);
    assert.equal(seen.routine?.canPublish, true, 'a gap does not block — §8.1');
    assert.equal(seen.routine?.blockers.length, 0);

    const bare = await post(publish, { action: 'publish', routineId: ROUTINE });
    assert.equal(bare.status, 409, JSON.stringify(bare.body));
    assert.equal((bare.body as { error?: string }).error, 'warnings_unconfirmed');
    const carried = (bare.body as { warnings?: Array<{ code: string }> }).warnings ?? [];
    assert.ok(carried.some((w) => w.code === 'unplaced'),
      'the refusal carries the warnings, so a client that has not shown them can');
    assert.equal((await routineRow()).status, 'draft', 'and it did not publish');

    const ok = await post(publish, {
      action: 'publish', routineId: ROUTINE, confirmWarnings: true });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    const kept = (ok.body as { warnings?: Array<{ code: string }> }).warnings ?? [];
    assert.ok(kept.some((w) => w.code === 'unplaced'),
      'what was accepted travels with the success rather than being forgotten');
  });

  /* ─────────────────────── §9 version / concurrency ───────────────────── */

  test('§9 — a routine edited after the review was drawn refuses to publish', async () => {
    const seen = await review();
    const fp = seen.routine!.fingerprint;

    // Somebody else edits, through the editor, which is what bumps
    // row_version — the fingerprint tracks application edits, and that is
    // the concurrency case it exists for.
    const { rows } = await asBootstrap(db, head, (c) => c.query<{ id: string; v: number }>(
      `SELECT id, row_version AS v FROM routine_slots
        WHERE routine_id = $1 AND status = 'active' LIMIT 1`, [ROUTINE]));
    await post(editor, { action: 'remove', slotId: rows[0].id, rowVersion: rows[0].v });

    const stale = await post(publish, {
      action: 'publish', routineId: ROUTINE, fingerprint: fp, confirmWarnings: true });
    assert.equal(stale.status, 409, JSON.stringify(stale.body));
    assert.equal((stale.body as { error?: string }).error, 'stale_routine');
    assert.equal((await routineRow()).status, 'draft');

    // The refusal hands back the current one, so a re-read can succeed.
    const now = (stale.body as { fingerprint?: string }).fingerprint;
    assert.notEqual(now, fp);
    const ok = await post(publish, {
      action: 'publish', routineId: ROUTINE, fingerprint: now, confirmWarnings: true });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
  });

  test('a publish without a fingerprint is still allowed — it is a check, not a ceremony', async () => {
    const r = await post(publish, {
      action: 'publish', routineId: ROUTINE, confirmWarnings: true });
    assert.equal(r.status, 200);
  });

  /* ──────────────────────── §7 / §10 the act itself ───────────────────── */

  test('publishing flips the routine and every one of its slots, and stamps who did it', async () => {
    const before = await review();
    const r = await post(publish, {
      action: 'publish', routineId: ROUTINE, confirmWarnings: true,
      fingerprint: before.routine!.fingerprint });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.match((r.body as { messageBn?: string }).messageBn ?? '', /শিক্ষার্থীরা এখন/);

    const row = await routineRow();
    assert.equal(row.status, 'active');
    assert.equal(row.stamped, true);
    assert.equal(row.published_by, HEAD);
    assert.equal(row.live, row.total, 'every active slot went live, not most of them');
    assert.equal(row.live, before.routine!.slots, 'and it is the number the head was shown');
  });

  test('§10 — the audit records what was known to be wrong at the time', async () => {
    await overSubscribe();
    await post(publish, { action: 'submit', routineId: ROUTINE });
    await post(publish, { action: 'publish', routineId: ROUTINE, confirmWarnings: true });

    const { rows } = await asBootstrap(db, head, (c) => c.query<{
      action: string; actor_id: string; actor_role: string;
      entity_type: string; entity_id: string; after_state: Record<string, unknown>;
    }>(
      `SELECT action, actor_id, actor_role, entity_type, entity_id, after_state
         FROM audit.activity_log
        WHERE tenant_id = $1 AND action LIKE 'rms.routine.%'
        ORDER BY created_at`, [T]));
    // The log is append-only and shared with every other test in this
    // tenant, so it is the MOST RECENT pair that belongs to this one.
    const submitted = rows.filter((x) => x.action === 'rms.routine.submit').at(-1);
    const published = rows.filter((x) => x.action === 'rms.routine.publish').at(-1);
    assert.ok(submitted, 'the handover is on the record too');
    assert.equal(submitted.after_state.fromStatus, 'draft');
    assert.ok(published);
    assert.equal(published.actor_id, HEAD);
    assert.equal(published.actor_role, 'principal');
    assert.equal(published.entity_type, 'routine');
    assert.equal(published.entity_id, ROUTINE);
    assert.equal(published.after_state.status, 'active');
    assert.equal(published.after_state.fromStatus, 'review');
    assert.equal(published.after_state.hardConflicts, 0);
    assert.ok(Array.isArray(published.after_state.warnings));
    assert.ok((published.after_state.warnings as string[]).includes('unplaced'),
      'the gap was visible and accepted, and the record says so');
  });

  test('a published routine cannot be published again, or withdrawn', async () => {
    await post(publish, { action: 'publish', routineId: ROUTINE, confirmWarnings: true });
    const again = await post(publish, {
      action: 'publish', routineId: ROUTINE, confirmWarnings: true });
    assert.equal(again.status, 409);
    assert.equal((again.body as { error?: string }).error, 'already_published');
    const back = await post(publish, { action: 'withdraw', routineId: ROUTINE });
    assert.equal(back.status, 409);
    assert.equal((back.body as { error?: string }).error, 'already_published');
  });

  /* ──────────────────────── §11 / §12 who may ─────────────────────────── */

  test('§11 — a student, a teacher and an IT admin can neither see the review nor publish', async () => {
    for (const [who, token] of [
      ['student', studentToken], ['teacher', teacherToken], ['it_admin', itToken],
    ] as const) {
      assert.equal((await getReview(`yearId=${YEAR}`, token)).status, 403, `${who} read`);
      assert.equal(
        (await post(publish, { action: 'publish', routineId: ROUTINE, confirmWarnings: true }, token)).status,
        403, `${who} publish`);
      assert.equal(
        (await post(publish, { action: 'submit', routineId: ROUTINE }, token)).status,
        403, `${who} submit`);
    }
    assert.equal((await routineRow()).status, 'draft');
  });

  test('§12 — another school holding the id gets nothing, and changes nothing', async () => {
    assert.equal((await getReview(`yearId=${YEAR}`, headBToken)).status, 404,
      'a year id from another school is not found');
    const r = await getReview(`routineId=${ROUTINE}`, headBToken);
    assert.equal(r.status, 404);
    const p = await post(publish, {
      action: 'publish', routineId: ROUTINE, confirmWarnings: true }, headBToken);
    assert.equal(p.status, 404, JSON.stringify(p.body));
    assert.equal((p.body as { error?: string }).error, 'routine_not_found');
    const s = await post(publish, { action: 'submit', routineId: ROUTINE }, headBToken);
    assert.equal(s.status, 404);
    assert.equal((await routineRow()).status, 'draft', 'and nothing happened to it');
  });

  /* ─────────────────────────── shape / input ──────────────────────────── */

  test('bad input is refused in words, not in stack traces', async () => {
    assert.equal((await getReview('yearId=not-a-uuid')).status, 400);
    assert.equal((await post(publish, { action: 'publish', routineId: 'nope' })).status, 400);
    assert.equal((await post(publish, { action: 'demolish', routineId: ROUTINE })).status, 400);
    const missing = await post(publish, {
      action: 'publish', routineId: '7c970000-0000-4000-8000-00000000dead' });
    assert.equal(missing.status, 404);
  });

  test('no machine identifier reaches a sentence a person reads', async () => {
    const restore = await plantTeacherConflict();
    const seen = await review();
    const sentences = [
      ...(seen.routine?.blockers ?? []), ...(seen.routine?.warnings ?? []),
    ].map((f) => f.messageBn).join(' ');
    assert.ok(sentences.length > 0);
    assert.doesNotMatch(sentences, /[0-9a-f]{8}-[0-9a-f]{4}/, 'no uuid');
    assert.doesNotMatch(sentences, /[0-9]/, 'Bangla numerals only');
    assert.doesNotMatch(sentences, /hard_conflict|routine_slots|undefined|NaN/);
    await restore();
  });
});
