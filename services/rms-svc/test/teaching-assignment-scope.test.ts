/**
 * B-89 — who may say which teacher takes which subject in which section.
 *
 * Found by P9-0's inventory, before the routine wizard was written, and it is
 * the reason the wizard could not be written first.
 *
 * `section_subject_teachers` carried one policy: `tenant_isolation`,
 * PERMISSIVE, FOR ALL. Tenant-match was the entire test. Proved live as
 * `app.role = 'student'` against a real school:
 *
 *     INSERT … teacher_id = <the student's own id>   ->  INSERT 0 1
 *     DELETE FROM section_subject_teachers …          ->  DELETE 1
 *
 * ── Why this table and not another ─────────────────────────────────────────
 * `solve.ts:loadDemand` reads THIS TABLE and nothing else to decide what the
 * timetable must contain. Whoever can write it writes the school's entire
 * teaching load — so a student could have named themselves the teacher of
 * every section, and the generator would have built a week around it.
 *
 * The same shape as B-77 on `payment_receipts`: a table sitting beside
 * well-scoped neighbours, inheriting only the isolation every table gets.
 * `class_teacher_assignments` — the "who is the class teacher" table right
 * next to it — got per-command scopes in migration 010. This one was missed.
 *
 * ── The three properties, and why DELETE is its own case ───────────────────
 * A RESTRICTIVE `FOR ALL` with `USING (true)` gates INSERT and UPDATE through
 * WITH CHECK and leaves DELETE wide open, because USING is what DELETE
 * consults. That is this codebase's recurring hole (069's header records it),
 * so the commands are separate policies and separate tests.
 *
 * DELETE is refused for EVERYONE, including a principal:
 * `started_on`/`ended_on`/`end_reason` make this a history table, and erasing
 * a row erases the fact that somebody taught a class — which is exactly what
 * a school needs when a parent asks who was teaching in March.
 *
 *   DATABASE_URL=postgres://shikhon_app:… \
 *     node --test services/rms-svc/test/teaching-assignment-scope.test.ts
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { createDb, type Db, type TenantContext } from '../../../packages/server-core/src/db.ts';
import { lockFixtures, unlockFixtures, asBootstrap } from '../../../packages/server-core/test/harness.ts';

const DATABASE_URL = process.env.DATABASE_URL;
const skip = !DATABASE_URL ? 'DATABASE_URL not set' : false;

const T       = '7b890000-0000-4000-8000-0000000000a0';
const HEAD    = '7b890000-0000-4000-8000-0000000000a1';
const TEACHER = '7b890000-0000-4000-8000-0000000000a2';
const STUDENT = '7b890000-0000-4000-8000-0000000000a3';
const YEAR    = '7b890000-0000-4000-8000-0000000000c1';
const KLASS   = '7b890000-0000-4000-8000-0000000000d1';
const SECTION = '7b890000-0000-4000-8000-0000000000e1';
const SUBJECT = '7b890000-0000-4000-8000-0000000000f1';

let db: Db;
const head: TenantContext = { tenantId: T, userId: HEAD, role: 'principal' };

/** One assignment, attempted as whoever the caller says they are. */
const assignAs = (role: string, userId: string, teacherId: string) =>
  db.withTenant({ tenantId: T, userId, role }, (c) => c.query(
    `INSERT INTO section_subject_teachers
       (tenant_id, section_id, subject_id, teacher_id, academic_year_id, started_on)
     VALUES ($1,$2,$3,$4,$5,'2026-01-05')`,
    [T, SECTION, SUBJECT, teacherId, YEAR]), { write: true });

/**
 * Reset between cases by CLOSING the open rows, not deleting them.
 *
 * The first version of this helper used DELETE and every test after the first
 * failed on `uq_sst_current` — which is this migration working: nothing may
 * delete teaching history, including a test fixture. Closing is also the real
 * operation a school performs when a subject changes hands, so the reset path
 * and the product path are the same one.
 *
 * `end_reason` is not optional: `sst_reason_belongs_to_a_closed_row` requires
 * that `ended_on` and `end_reason` are set together, so a closed row always
 * says why. And `ended_on = started_on` rather than a fixed date, because
 * `sst_period_is_ordered` refuses a row that ended before it began — a
 * same-day close is the shortest legal assignment.
 */
const clear = () => asBootstrap(db, head, (c) =>
  c.query(`UPDATE section_subject_teachers
              SET ended_on = started_on, end_reason = 'test reset'
            WHERE tenant_id = $1 AND ended_on IS NULL`, [T]));

describe('B-89 — a teaching assignment is not something a student may write', { skip }, () => {
  before(async () => {
    await lockFixtures(DATABASE_URL as string);
    db = createDb(DATABASE_URL as string);
    await asBootstrap(db, head, async (c) => {
      await c.query('DELETE FROM tenants WHERE id = $1', [T]);
      await c.query(
        `INSERT INTO tenants (id, slug, name_bn, name_en, stream, level)
         VALUES ($1,'b89-assign','বি৮৯','B89','bangla_medium','secondary')`, [T]);
      for (const [id, bn, phone, role] of [
        [HEAD, 'প্রধান', '+8801799890001', 'principal'],
        [TEACHER, 'শিক্ষক', '+8801799890002', 'subject_teacher'],
        [STUDENT, 'ছাত্র', '+8801799890003', 'student'],
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
      await c.query(
        `INSERT INTO sections (id, tenant_id, class_id, academic_year_id, name, student_count)
         VALUES ($1,$2,$3,$4,'ক',0)`, [SECTION, T, KLASS, YEAR]);
      await c.query(
        `INSERT INTO subjects (id, tenant_id, name_bn, name_en, short_name)
         VALUES ($1,$2,'গণিত','Mathematics','গণি')`, [SUBJECT, T]);
    });
  });

  after(async () => {
    if (!db) return;
    await clear();
    await asBootstrap(db, head, (c) => c.query('DELETE FROM tenants WHERE id = $1', [T]));
    await db.end(); await unlockFixtures();
  });

  test('THE ONE THAT MATTERS — a student cannot make themselves a teacher', async () => {
    await clear();
    await assert.rejects(
      () => assignAs('student', STUDENT, STUDENT),
      /row-level security|sst_insert_scope|read-only|blocked/i,
      'a student named themselves the teacher of a section');
  });

  test('nor can a teacher assign themselves a subject', async () => {
    // A subject teacher is trusted with marks and attendance and is NOT
    // trusted with the school's teaching load — that is the coordinator's.
    await clear();
    await assert.rejects(() => assignAs('subject_teacher', TEACHER, TEACHER),
      /row-level security|sst_insert_scope|read-only|blocked/i);
  });

  test('a principal can, which is what makes the refusals meaningful', async () => {
    await clear();
    await assignAs('principal', HEAD, TEACHER);
    const { rows } = await asBootstrap(db, head, (c) => c.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM section_subject_teachers
        WHERE tenant_id = $1 AND ended_on IS NULL`, [T]));
    assert.equal(rows[0].n, '1');
  });

  test('an academic coordinator can too — it is their job', async () => {
    await clear();
    await assignAs('academic_coordinator', HEAD, TEACHER);
    const { rows } = await asBootstrap(db, head, (c) => c.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM section_subject_teachers
        WHERE tenant_id = $1 AND ended_on IS NULL`, [T]));
    assert.equal(rows[0].n, '1');
  });

  test('nobody may DELETE — this is a history table', async () => {
    // Not even a principal. Reassigning closes a row and opens another, so a
    // teacher's record of what they taught survives the change. A DELETE
    // erases the fact that somebody taught a class.
    await clear();
    await assignAs('principal', HEAD, TEACHER);

    const { rowCount } = await db.withTenant(
      { tenantId: T, userId: HEAD, role: 'principal' },
      (c) => c.query('DELETE FROM section_subject_teachers WHERE tenant_id = $1', [T]),
      { write: true });
    assert.equal(rowCount, 0, 'a DELETE removed teaching history');

    const { rows } = await asBootstrap(db, head, (c) => c.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM section_subject_teachers
        WHERE tenant_id = $1 AND ended_on IS NULL`, [T]));
    assert.equal(rows[0].n, '1', 'and the row must still be there');
  });

  test('a student cannot UPDATE an assignment to point at themselves', async () => {
    // The other half of the same bypass: if INSERT is closed and UPDATE is
    // not, a student rewrites an existing row instead of adding one.
    await clear();
    await assignAs('principal', HEAD, TEACHER);

    const res = await db.withTenant(
      { tenantId: T, userId: STUDENT, role: 'student' },
      (c) => c.query('UPDATE section_subject_teachers SET teacher_id = $2 WHERE tenant_id = $1',
        [T, STUDENT]),
      { write: true },
    ).catch((e: unknown) => e);

    if (typeof res === 'object' && res !== null && 'rowCount' in res) {
      assert.equal((res as { rowCount: number }).rowCount, 0,
        'a student rewrote a teaching assignment to name themselves');
    }
    const { rows } = await asBootstrap(db, head, (c) => c.query<{ teacher_id: string }>(
      `SELECT teacher_id FROM section_subject_teachers
        WHERE tenant_id = $1 AND ended_on IS NULL`, [T]));
    assert.equal(rows[0].teacher_id, TEACHER, 'the assignment must be unchanged');
  });

  test('two ACTIVE assignments for one (section, subject) are impossible', async () => {
    // Not new — `uq_sst_current` has always done this — but load-bearing for
    // P9 and worth a test in the file that explains why: `loadDemand` would
    // read the demand twice and place double the periods a class actually
    // has, from one accidental double-click.
    await clear();
    await assignAs('principal', HEAD, TEACHER);
    await assert.rejects(() => assignAs('principal', HEAD, HEAD),
      /uq_sst_current|duplicate key/i);
  });
});
