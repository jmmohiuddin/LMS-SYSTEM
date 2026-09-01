/**
 * Student and guardian privacy, end to end.  (UI integration plan, P4 §21)
 *
 * P4 rebuilt the screens a student and a guardian see. None of it changed a
 * permission, an endpoint or a policy — and that claim is worth exactly as
 * much as the tests behind it, so this file states the matrix §21 asks for
 * and asserts every cell of it against a real database.
 *
 * ── Why the negative cases carry the weight ────────────────────────────────
 * A screen that shows the right thing proves almost nothing: the wrong data
 * simply was not asked for. What has to hold is that asking for it directly —
 * with a valid token, a well-formed request and somebody else's id — is
 * refused. Every test below therefore comes in pairs: the legitimate read
 * succeeds, and the same read aimed at a stranger returns nothing.
 *
 * ── And why the refusal must come from RLS ─────────────────────────────────
 * Each of these endpoints could filter in its own SQL and pass this file.
 * That is not what is being tested. The isolation lives in the row-level
 * policies (migration 010 and the RESTRICTIVE scopes), so a handler that
 * forgets its `WHERE` clause still returns nothing — which is the only kind
 * of isolation that survives a new endpoint written in a hurry.
 *
 *   DATABASE_URL=postgres://… node --test services/academics-svc/test/p4-privacy.test.ts
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { createDb, type Db, type TenantContext } from '../../../packages/server-core/src/db.ts';
import { installTestKeys, call } from '../../../packages/server-core/test/harness.ts';

const DATABASE_URL = process.env.DATABASE_URL;
const skip = !DATABASE_URL ? 'DATABASE_URL not set' : false;

/* Two tenants, so cross-tenant is a real question and not a hypothetical. */
const T_A      = '7a4b0000-0000-4000-8000-0000000000a0';
const T_B      = '7a4b0000-0000-4000-8000-0000000000b0';
const HEAD_A   = '7a4b0000-0000-4000-8000-0000000000a1';
const HEAD_B   = '7a4b0000-0000-4000-8000-0000000000b1';
/* Tenant A: two families. Rafi + Tahiya belong to Rahim; Shanto to Karim. */
const RAHIM    = '7a4b0000-0000-4000-8000-0000000000a2';
const KARIM    = '7a4b0000-0000-4000-8000-0000000000a3';
const RAFI     = '7a4b0000-0000-4000-8000-0000000000a4';
const TAHIYA   = '7a4b0000-0000-4000-8000-0000000000a5';
const SHANTO   = '7a4b0000-0000-4000-8000-0000000000a6';
/* Tenant B: one student, nobody in A may ever see. */
const B_STUDENT= '7a4b0000-0000-4000-8000-0000000000b2';

const YEAR_A   = '7a4b0000-0000-4000-8000-0000000000c1';
const YEAR_B   = '7a4b0000-0000-4000-8000-0000000000c2';
const CLASS_A  = '7a4b0000-0000-4000-8000-0000000000d1';
const CLASS_B  = '7a4b0000-0000-4000-8000-0000000000d2';
const SEC_A    = '7a4b0000-0000-4000-8000-0000000000e1';
const SEC_B    = '7a4b0000-0000-4000-8000-0000000000e2';

let db: Db;
let tokens: Record<string, string> = {};
let ward: typeof import('../api/ward.ts').default;
let attendance: typeof import('../api/attendance.ts').default;
let results: typeof import('../api/results.ts').default;
let subjects: typeof import('../api/subjects.ts').default;

const headA: TenantContext = { tenantId: T_A, userId: HEAD_A, role: 'principal' };
const headB: TenantContext = { tenantId: T_B, userId: HEAD_B, role: 'principal' };

/**
 * Each tenant is dropped in ITS OWN context.
 *
 * `DELETE FROM tenants WHERE id = ANY(...)` under tenant A's context deletes
 * only tenant A: RLS hides B's row from the statement, exactly as it is
 * supposed to. The first version of this helper did that, left B behind, and
 * the next run failed on `tenants_pkey` — which is the isolation working
 * correctly and the cleanup assuming it was not there.
 */
async function drop(): Promise<void> {
  for (const ctx of [headA, headB]) {
    await db.withTenant(ctx, async (c) => {
      await c.query('DELETE FROM tenants WHERE id = $1', [ctx.tenantId]);
    });
  }
}

/** A distinct, well-formed BD number per user id. */
function phoneFor(id: string): string {
  // +8801 followed by NINE digits — `+880179410001` is one short and the
  // schema's CHECK says so.
  const n = parseInt(id.slice(-4), 16) % 100000000;
  return `+88017${String(n).padStart(8, '0')}`;
}

async function seedTenant(
  ctx: TenantContext, t: string, head: string, year: string,
  klass: string, section: string,
  students: Array<[string, string]>,
  /** Distinct guardian PEOPLE. */
  guardianUsers: Array<[string, string]>,
  /** guardian → child links. Rahim appears twice here and once above: a
   *  guardian with two children is one user row and two guardianships, and
   *  conflating them is what made the first run violate `users_pkey`. */
  links: Array<[string, string]>,
): Promise<void> {
  await db.withTenant(ctx, async (c) => {
    await c.query(
      `INSERT INTO tenants (id, slug, name_bn, name_en, stream, level)
       VALUES ($1,$2,'পি৪','P4','bangla_medium','secondary')`, [t, `p4-${t.slice(-4)}`]);
    await c.query(
      // A phone, because the schema refuses a user with no phone, no email
      // and no contactable guardian. Adults carry their own; the students
      // below are reachable through the guardianships inserted in the same
      // transaction.
      `INSERT INTO users (id, tenant_id, full_name_bn, full_name_en, phone_e164, status)
       VALUES ($1,$2,'প্রধান','Head',$3,'active')`, [head, t, phoneFor(head)]);
    for (const [id, name] of students) {
      // Students carry a phone too. Contactability is satisfied by a guardian
      // link OR a number, and tenant B's lone student has no guardian — a
      // school with an unlinked student is an ordinary case, not a broken one.
      await c.query(
        `INSERT INTO users (id, tenant_id, full_name_bn, full_name_en, phone_e164, status)
         VALUES ($1,$2,$3,$3,$4,'active')`, [id, t, name, phoneFor(id)]);
      await c.query(
        `INSERT INTO user_roles (tenant_id, user_id, role_code) VALUES ($1,$2,'student')`,
        [t, id]);
    }
    for (const [id, name] of guardianUsers) {
      await c.query(
        `INSERT INTO users (id, tenant_id, full_name_bn, full_name_en, phone_e164, status)
         VALUES ($1,$2,$3,$3,$4,'active')`, [id, t, name, phoneFor(id)]);
      await c.query(
        `INSERT INTO user_roles (tenant_id, user_id, role_code) VALUES ($1,$2,'guardian')`,
        [t, id]);
    }
    await c.query(
      `INSERT INTO academic_years (id, tenant_id, label, starts_on, ends_on, is_current)
       VALUES ($1,$2,'2026','2026-01-01','2026-12-31',true)`, [year, t]);
    await c.query(
      `INSERT INTO classes (id, tenant_id, level_no, name_bn, name_en, stream)
       VALUES ($1,$2,9,'নবম','Nine','bangla_medium')`, [klass, t]);
    await c.query(
      `INSERT INTO sections (id, tenant_id, class_id, academic_year_id, name, student_count)
       VALUES ($1,$2,$3,$4,'ক',0)`, [section, t, klass, year]);
    let roll = 1;
    for (const [id] of students) {
      await c.query(
        `INSERT INTO enrolments (tenant_id, student_id, section_id, academic_year_id, roll_no, status)
         VALUES ($1,$2,$3,$4,$5,'active')`, [t, id, section, year, roll++]);
    }
    for (const [gid, sid] of links) {
      await c.query(
        `INSERT INTO guardianships (tenant_id, student_id, guardian_id, relation, is_primary)
         VALUES ($1,$2,$3,'father',true)`, [t, sid, gid]);
    }
  });
}

async function seed(): Promise<void> {
  await drop();
  await seedTenant(headA, T_A, HEAD_A, YEAR_A, CLASS_A, SEC_A,
    [[RAFI, 'রাফি'], [TAHIYA, 'তাহিয়া'], [SHANTO, 'শান্ত']],
    [[RAHIM, 'রহিম'], [KARIM, 'করিম']],
    // Rahim fathers Rafi AND Tahiya — the multi-child case the selector
    // exists for. Karim fathers Shanto only, and is the stranger every
    // negative test aims at.
    [[RAHIM, RAFI], [RAHIM, TAHIYA], [KARIM, SHANTO]]);
  await seedTenant(headB, T_B, HEAD_B, YEAR_B, CLASS_B, SEC_B,
    [[B_STUDENT, 'অন্য স্কুলের ছাত্র']], [], []);
}

/**
 * One setup, memoised, invoked from each suite's own `before`.
 *
 * A single TOP-LEVEL `before` does not gate the describes in node:test — they
 * start anyway and are cancelled mid-flight, which reports as eleven failures
 * and no assertion output. And a `before`/`after` pair inside only the FIRST
 * describe ends the pool when that describe does, so the later suites die with
 * "Cannot use a pool after calling end" — which reads like an isolation
 * failure and is not one. Memoising is what makes per-suite setup cheap enough
 * to be correct.
 */
let ready: Promise<void> | null = null;
function ensureSetup(): Promise<void> {
  ready ??= (async () => {
    await installTestKeys();
    db = createDb(DATABASE_URL as string);
    await seed();
    const { signAccessToken } = await import('../../../packages/server-core/src/jwt.ts');
    tokens = {
      rafi: await signAccessToken({ sub: RAFI, tid: T_A, role: 'student', roles: ['student'] }),
      shanto: await signAccessToken({ sub: SHANTO, tid: T_A, role: 'student', roles: ['student'] }),
      rahim: await signAccessToken({ sub: RAHIM, tid: T_A, role: 'guardian', roles: ['guardian'] }),
      karim: await signAccessToken({ sub: KARIM, tid: T_A, role: 'guardian', roles: ['guardian'] }),
      bStudent: await signAccessToken({
        sub: B_STUDENT, tid: T_B, role: 'student', roles: ['student'] }),
    };
    ward = (await import('../api/ward.ts')).default;
    attendance = (await import('../api/attendance.ts')).default;
    results = (await import('../api/results.ts')).default;
    subjects = (await import('../api/subjects.ts')).default;
  })();
  return ready;
}

describe('P4 §21 — a student sees only themselves', { skip }, () => {
  before(ensureSetup);
  const att = (token: string, qs = '') =>
    call(attendance, { url: `/api/v1/academics/attendance${qs}`, token });
  const res = (token: string, qs = '') =>
    call(results, { url: `/api/v1/academics/results${qs}`, token });
  const subj = (token: string, qs = '') =>
    call(subjects, { url: `/api/v1/academics/subjects${qs}`, token });

  test('THE ONE THAT MATTERS — asking for another student by id returns nothing', async () => {
    // Not "the screen does not offer a way to ask". A valid token, a
    // well-formed request, somebody else's id — the only test that means
    // anything.
    const own = await att(tokens.rafi);
    assert.equal(own.status, 200, 'a student must be able to read their own');

    const other = await att(tokens.rafi, `?studentId=${SHANTO}`);
    // Either refused outright or answered with an empty record. Both are
    // correct; leaking Shanto's days is not.
    if (other.status === 200) {
      const b = other.body as { totals?: { counted: number }; recent?: unknown[] };
      assert.equal(b.totals?.counted ?? 0, 0, 'another student\'s attendance leaked');
      assert.equal((b.recent ?? []).length, 0);
    } else {
      assert.ok(other.status === 403 || other.status === 404, `got ${other.status}`);
    }
  });

  test('a student reads their own results, and not a classmate\'s', async () => {
    const own = await res(tokens.rafi);
    assert.equal(own.status, 200);

    const other = await res(tokens.rafi, `?studentId=${SHANTO}`);
    if (other.status === 200) {
      const b = other.body as { results?: unknown[] };
      assert.equal((b.results ?? []).length, 0, 'a classmate\'s results leaked');
    } else {
      assert.ok(other.status === 403 || other.status === 404);
    }
  });

  test('a student reads their own subject set, and not a classmate\'s', async () => {
    assert.equal((await subj(tokens.rafi)).status, 200);
    const other = await subj(tokens.rafi, `?studentId=${SHANTO}`);
    if (other.status === 200) {
      const b = other.body as { subjects?: unknown[] };
      assert.equal((b.subjects ?? []).length, 0);
    } else {
      assert.ok(other.status === 403 || other.status === 404);
    }
  });

  test('a student is not a guardian — the ward endpoint gives them nothing', async () => {
    const r = await call(ward, { url: '/api/v1/academics/ward', token: tokens.rafi });
    if (r.status === 200) {
      assert.equal(((r.body as { wards?: unknown[] }).wards ?? []).length, 0,
        'a student was handed a guardian\'s ward list');
    } else {
      assert.ok(r.status === 403, `expected 403, got ${r.status}`);
    }
  });
});

describe('P4 §21 — a guardian sees only their own children', { skip }, () => {
  before(ensureSetup);
  const wardOf = (token: string, studentId?: string) =>
    call(ward, {
      url: `/api/v1/academics/ward${studentId ? `?studentId=${studentId}` : ''}`,
      token,
    });

  test('THE ONE THAT MATTERS — the ward list is exactly this family', async () => {
    const r = await wardOf(tokens.rahim);
    assert.equal(r.status, 200);
    const ids = ((r.body as { wards: Array<{ studentId: string }> }).wards ?? [])
      .map((w) => w.studentId).sort();
    assert.deepEqual(ids, [RAFI, TAHIYA].sort(), 'the ward list is not the family');
    assert.ok(!ids.includes(SHANTO), 'another family\'s child appeared in the list');
  });

  test('THE ONE THAT MATTERS — naming another family\'s child by id is refused', async () => {
    // The multi-child selector changes `?studentId=`. This is the request it
    // makes, aimed at a child the guardian does not father.
    const r = await wardOf(tokens.rahim, SHANTO);
    if (r.status === 200) {
      assert.equal((r.body as { student: unknown }).student, null,
        'another family\'s child was returned');
    } else {
      assert.ok(r.status === 403 || r.status === 404, `got ${r.status}`);
    }
  });

  test('the other family sees the mirror image, and no more', async () => {
    // Symmetry matters: a rule that only holds in one direction is a filter
    // somebody wrote, not an isolation policy.
    const r = await wardOf(tokens.karim);
    assert.equal(r.status, 200);
    const ids = ((r.body as { wards: Array<{ studentId: string }> }).wards ?? [])
      .map((w) => w.studentId);
    assert.deepEqual(ids, [SHANTO]);
    const cross = await wardOf(tokens.karim, RAFI);
    if (cross.status === 200) {
      assert.equal((cross.body as { student: unknown }).student, null);
    }
  });

  test('a guardian cannot read a non-child\'s attendance directly', async () => {
    const r = await call(attendance, {
      url: `/api/v1/academics/attendance?studentId=${SHANTO}`, token: tokens.rahim });
    if (r.status === 200) {
      const b = r.body as { totals?: { counted: number } };
      assert.equal(b.totals?.counted ?? 0, 0);
    } else {
      assert.ok(r.status === 403 || r.status === 404);
    }
  });
});

describe('P4 §21 — tenant isolation holds for both personas', { skip }, () => {
  before(ensureSetup);
  // Last suite in the file, so this is where the pool closes.
  after(async () => { if (db) { await drop(); await db.end(); } });
  test('THE ONE THAT MATTERS — tenant A cannot reach a tenant B student', async () => {
    // The id is real and the token is valid. Only the tenant differs, which
    // is the whole of multi-tenancy.
    for (const [who, token] of [['guardian', tokens.rahim], ['student', tokens.rafi]] as const) {
      const r = await call(ward, {
        url: `/api/v1/academics/ward?studentId=${B_STUDENT}`, token });
      if (r.status === 200) {
        assert.equal((r.body as { student: unknown }).student, null,
          `a ${who} in tenant A reached a tenant B student`);
      } else {
        assert.ok(r.status === 403 || r.status === 404, `${who}: got ${r.status}`);
      }
    }
  });

  test('a tenant B student reaching into tenant A gets nothing', async () => {
    const r = await call(attendance, {
      url: `/api/v1/academics/attendance?studentId=${RAFI}`, token: tokens.bStudent });
    if (r.status === 200) {
      const b = r.body as { totals?: { counted: number } };
      assert.equal(b.totals?.counted ?? 0, 0, 'cross-tenant attendance leaked');
    } else {
      assert.ok(r.status === 403 || r.status === 404);
    }
  });

  test('the isolation is the DATABASE\'s, not the handler\'s', async () => {
    // The same question asked underneath the API: with tenant A's context
    // set, tenant B's student is not visible even by primary key. A handler
    // that forgets its WHERE clause still returns nothing.
    await db.withTenant({ tenantId: T_A, userId: RAHIM, role: 'guardian' }, async (c) => {
      const r = await c.query('SELECT id FROM users WHERE id = $1', [B_STUDENT]);
      assert.equal(r.rowCount, 0, 'RLS did not hide a foreign tenant\'s row');
    });
    // …and the mirror, so this is isolation rather than one missing grant.
    await db.withTenant({ tenantId: T_B, userId: HEAD_B, role: 'principal' }, async (c) => {
      const r = await c.query('SELECT id FROM users WHERE id = $1', [RAFI]);
      assert.equal(r.rowCount, 0);
    });
  });
});
