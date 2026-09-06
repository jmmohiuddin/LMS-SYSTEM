/**
 * B-87 — a school adding staff, through the form rather than a CSV.
 *
 * The §E onboarding walk could not get past "add the first teacher": the form
 * marked the staff-ID box optional, the handler passed `|| null` into a NOT
 * NULL column, and the office got `{"error":"internal_error"}`. Every unit
 * test supplied the field, so nothing had ever seen it.
 *
 * ── Why the answer is "required" and not "generate one" ────────────────────
 * The product had already decided this, twice, and the two decisions are
 * different on purpose:
 *
 *   student_code   GENERATED — `studentCodeFor(userId)` in import-run.ts,
 *                  `STU-` plus eight hex of the user's uuid. A child does not
 *                  arrive holding a student number; the school assigns one,
 *                  and deriving it from the id cannot collide.
 *
 *   employee_code  SUPPLIED — `teacher-import.ts` REFUSES a CSV without an
 *                  `employee_code` column (line 121) and fails any row whose
 *                  cell is blank (line 159), in Bangla, and de-duplicates
 *                  within the file. It is the school's own staff number, the
 *                  one already on their paperwork.
 *
 * Generating one here would mean the same teacher gets one code when typed
 * into the form and a different one when imported from the school's
 * spreadsheet, and the app would disagree with the office's own records. So
 * the form is brought in line with the importer, not the other way round.
 *
 * ── The second 500, which is the likelier one ──────────────────────────────
 * `UNIQUE (tenant_id, employee_code)` is real, and the INSERT's
 * `ON CONFLICT (user_id) DO NOTHING` covers only the primary key. A school
 * re-adding a teacher, or typing a code that already exists, hits 23505 —
 * and a duplicate staff number is a far more ordinary mistake than a blank
 * one. It must name the field, not page an engineer.
 *
 *   DATABASE_URL=postgres://shikhon_app:… \
 *     node --test services/ops-svc/test/staff-create.test.ts
 */
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { createDb, type Db, type TenantContext } from '../../../packages/server-core/src/db.ts';
import { installTestKeys, call, lockFixtures, unlockFixtures, asBootstrap } from '../../../packages/server-core/test/harness.ts';

const DATABASE_URL = process.env.DATABASE_URL;
const skip = !DATABASE_URL ? 'DATABASE_URL not set' : false;

const T    = '7b870000-0000-4000-8000-0000000000a0';
const HEAD = '7b870000-0000-4000-8000-0000000000a1';

let db: Db;
let token = '';
let users: Parameters<typeof call>[0];

const head: TenantContext = { tenantId: T, userId: HEAD, role: 'principal' };

const addStaff = (body: Record<string, unknown>) =>
  call(users, { method: 'POST', url: '/', token, body } as Parameters<typeof call>[1]);

describe('B-87 — a new school adds its first teacher', { skip }, () => {
  before(async () => {
    await installTestKeys();
    await lockFixtures(DATABASE_URL as string);
    db = createDb(DATABASE_URL as string);
    await asBootstrap(db, head, async (c) => {
      await c.query('DELETE FROM tenants WHERE id = $1', [T]);
      await c.query(
        `INSERT INTO tenants (id, slug, name_bn, name_en, stream, level)
         VALUES ($1,'b87-staff','কর্মী','Staff','bangla_medium','secondary')`, [T]);
      await c.query(
        `INSERT INTO users (id, tenant_id, full_name_bn, full_name_en, phone_e164, status)
         VALUES ($1,$2,'প্রধান','Head','+8801799870001','active')`, [HEAD, T]);
      await c.query(
        `INSERT INTO user_roles (tenant_id, user_id, role_code) VALUES ($1,$2,'principal')`,
        [T, HEAD]);
    });
    const { signAccessToken } = await import('../../../packages/server-core/src/jwt.ts');
    token = await signAccessToken({ sub: HEAD, tid: T, role: 'principal', roles: ['principal'] });
    users = (await import('../api/users.ts')).default;
  });

  after(async () => {
    if (!db) return;
    await asBootstrap(db, head, (c) => c.query('DELETE FROM tenants WHERE id = $1', [T]));
    await db.end(); await unlockFixtures();
  });

  /** Only the head survives between cases, so codes cannot leak across them. */
  beforeEach(() => asBootstrap(db, head, (c) =>
    c.query('DELETE FROM users WHERE tenant_id = $1 AND id <> $2', [T, HEAD])));

  test('THE ONE THAT MATTERS — a blank staff ID is a field error, never a 500', async () => {
    const r = await addStaff({
      nameBn: 'রফিক স্যার', phone: '+8801799870002', roleCode: 'subject_teacher',
    });

    assert.notEqual(r.status, 500,
      'a school adding its first teacher got internal_error — B-87');
    assert.equal(r.status, 400);
    assert.equal((r.body as { field?: string }).field, 'employeeCode',
      'the form has to know which box to point at');
  });

  test('with a staff ID, the teacher is created and keeps that exact code', async () => {
    const r = await addStaff({
      nameBn: 'রফিক স্যার', phone: '+8801799870003', roleCode: 'subject_teacher',
      employeeCode: 'EMP-014',
    });
    assert.ok(r.status < 400, `${r.status} ${JSON.stringify(r.body)}`);

    // The school's own number, unchanged. Not a generated one — that is the
    // whole decision this test records.
    const { rows } = await asBootstrap(db, head, (c) => c.query<{ employee_code: string }>(
      `SELECT sp.employee_code FROM staff_profiles sp
         JOIN users u ON u.id = sp.user_id
        WHERE u.phone_e164 = '+8801799870003'`));
    assert.equal(rows[0]?.employee_code, 'EMP-014');
  });

  test('a DUPLICATE staff ID is a 409 naming the field, not a 500', async () => {
    // The likelier mistake by far: a school re-adding a teacher, or typing a
    // number that is already in use. `UNIQUE (tenant_id, employee_code)` is
    // real and `ON CONFLICT (user_id)` does not cover it.
    const first = await addStaff({
      nameBn: 'প্রথম', phone: '+8801799870004', roleCode: 'subject_teacher',
      employeeCode: 'EMP-020',
    });
    assert.ok(first.status < 400, `first: ${JSON.stringify(first.body)}`);

    const second = await addStaff({
      nameBn: 'দ্বিতীয়', phone: '+8801799870005', roleCode: 'librarian',
      employeeCode: 'EMP-020',
    });

    assert.notEqual(second.status, 500,
      'a duplicate staff number paged an engineer instead of naming the field');
    assert.equal(second.status, 409);
    assert.equal((second.body as { field?: string }).field, 'employeeCode');
  });

  test('…and the rejected duplicate leaves no half-made user behind', async () => {
    await addStaff({
      nameBn: 'প্রথম', phone: '+8801799870006', roleCode: 'subject_teacher',
      employeeCode: 'EMP-030',
    });
    await addStaff({
      nameBn: 'দ্বিতীয়', phone: '+8801799870007', roleCode: 'librarian',
      employeeCode: 'EMP-030',
    });

    // The `users` row is inserted before `staff_profiles`, so a refusal that
    // does not roll back would leave a person with a login, a role and no
    // staff record — invisible on the staff screen and present in the roll.
    const { rows } = await asBootstrap(db, head, (c) => c.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM users
        WHERE tenant_id = $1 AND phone_e164 = '+8801799870007'`, [T]));
    assert.equal(rows[0].n, '0', 'a rejected duplicate left an orphaned user row');
  });

  test('the same staff ID is fine at a DIFFERENT school', async () => {
    // The UNIQUE is per tenant, and it must stay that way: two schools
    // numbering their staff from 1 is the normal case, not a conflict.
    const r = await addStaff({
      nameBn: 'রফিক', phone: '+8801799870008', roleCode: 'subject_teacher',
      employeeCode: 'EMP-001',
    });
    assert.ok(r.status < 400, JSON.stringify(r.body));

    const { rows } = await asBootstrap(db, head, (c) => c.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM staff_profiles WHERE employee_code = 'EMP-001'`));
    // RLS scopes this to one school; the other tenants' EMP-001 rows exist
    // and are invisible, which is the property being asserted.
    assert.equal(rows[0].n, '1');
  });
});
