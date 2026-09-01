/**
 * B-6 — correcting a class or section name, and everything that must stay
 * uncorrectable.
 *
 * The gap was never in the database: migration 042 has allowed UPDATE on
 * `classes` and `sections` for principal, school_owner, academic_coordinator
 * and it_admin since R-3. What was missing was any way for a person to reach
 * it, so a section typed "কক" instead of "ক" could only be fixed with SQL —
 * which the pilot runbook calls a blocker, correctly.
 *
 * ── What these tests are actually guarding ────────────────────────────────
 * Not "does rename work". The dangerous half of an edit endpoint is what it
 * REFUSES, and here that is anything that re-bases records underneath it:
 *
 *   * a class's level, stream or group decide which subject template it draws
 *     from, and every enrolment, mark and result below it was derived on that
 *     basis. Changing one migrates nothing; it makes the history wrong.
 *   * a section's class or year moves every child in it without a single
 *     enrolment row changing — the roster simply appears somewhere else.
 *   * a capacity below the children already enrolled is read by the enrolment
 *     cap, so accepting it silently breaks admission the next morning.
 *
 * And the two that always matter: another school cannot touch these rows, and
 * a role outside the four cannot either — enforced by RLS, so a handler that
 * forgot its check would still fail.
 *
 *   DATABASE_URL=postgres://… node --test services/ops-svc/test/b6-structure-edit.test.ts
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { createDb, type Db, type TenantContext } from '../../../packages/server-core/src/db.ts';
import { installTestKeys, call } from '../../../packages/server-core/test/harness.ts';

const DATABASE_URL = process.env.DATABASE_URL;
const skip = !DATABASE_URL ? 'DATABASE_URL not set' : false;

const T_A     = '7b06d000-0000-4000-8000-0000000000a0';
const T_B     = '7b06d000-0000-4000-8000-0000000000b0';
const HEAD_A  = '7b06d000-0000-4000-8000-0000000000a1';
const HEAD_B  = '7b06d000-0000-4000-8000-0000000000b1';
const TEACHER = '7b06d000-0000-4000-8000-0000000000a2';
const STUDENT = '7b06d000-0000-4000-8000-0000000000a3';
const YEAR_A  = '7b06d000-0000-4000-8000-0000000000c1';
const YEAR_B  = '7b06d000-0000-4000-8000-0000000000c2';
const CLASS_A = '7b06d000-0000-4000-8000-0000000000d1';
const CLASS_B = '7b06d000-0000-4000-8000-0000000000d2';
const SEC_A   = '7b06d000-0000-4000-8000-0000000000e1';
const SEC_B   = '7b06d000-0000-4000-8000-0000000000e2';

let db: Db;
let tokens: Record<string, string> = {};
let structure: typeof import('../api/structure.ts').default;

const headA: TenantContext = { tenantId: T_A, userId: HEAD_A, role: 'principal' };
const headB: TenantContext = { tenantId: T_B, userId: HEAD_B, role: 'principal' };

async function drop(): Promise<void> {
  for (const ctx of [headA, headB]) {
    await db.withTenant(ctx, async (c) => {
      await c.query('DELETE FROM tenants WHERE id = $1', [ctx.tenantId]);
    });
  }
}

function phoneFor(id: string): string {
  return `+88019${String(parseInt(id.slice(-6), 16) % 100000000).padStart(8, '0')}`;
}

async function seedTenant(
  ctx: TenantContext, t: string, slug: string, head: string,
  year: string, klass: string, section: string, extras: Array<[string, string]> = [],
): Promise<void> {
  await db.withTenant(ctx, async (c) => {
    await c.query(
      `INSERT INTO tenants (id, slug, name_bn, name_en, stream, level)
       VALUES ($1,$2,'বি৬','B6','bangla_medium','secondary')`, [t, slug]);
    for (const [id, role] of [[head, 'principal'] as const, ...extras]) {
      await c.query(
        `INSERT INTO users (id, tenant_id, full_name_bn, full_name_en, phone_e164, status)
         VALUES ($1,$2,'ব্যবহারকারী','User',$3,'active')`, [id, t, phoneFor(id)]);
      await c.query(
        `INSERT INTO user_roles (tenant_id, user_id, role_code) VALUES ($1,$2,$3)`,
        [t, id, role]);
    }
    await c.query(
      `INSERT INTO academic_years (id, tenant_id, label, starts_on, ends_on, is_current)
       VALUES ($1,$2,'2026','2026-01-01','2026-12-31',true)`, [year, t]);
    await c.query(
      `INSERT INTO classes (id, tenant_id, level_no, name_bn, name_en, stream, "group")
       VALUES ($1,$2,9,'নবম','Nine','bangla_medium','science')`, [klass, t]);
    await c.query(
      `INSERT INTO sections (id, tenant_id, class_id, academic_year_id, name, capacity, student_count)
       VALUES ($1,$2,$3,$4,'কক',60,0)`, [section, t, klass, year]);
  });
}

async function seed(): Promise<void> {
  await drop();
  await seedTenant(headA, T_A, 'b6-a', HEAD_A, YEAR_A, CLASS_A, SEC_A,
    [[TEACHER, 'class_teacher'], [STUDENT, 'student']]);
  await seedTenant(headB, T_B, 'b6-b', HEAD_B, YEAR_B, CLASS_B, SEC_B);
}

let ready: Promise<void> | null = null;
function ensureSetup(): Promise<void> {
  ready ??= (async () => {
    await installTestKeys();
    db = createDb(DATABASE_URL as string);
    structure = (await import('../api/structure.ts')).default;
    await seed();
    const { signAccessToken } = await import('../../../packages/server-core/src/jwt.ts');
    const mint = (sub: string, tid: string, role: string) =>
      signAccessToken({ sub, tid, role, roles: [role] });
    tokens = {
      headA: await mint(HEAD_A, T_A, 'principal'),
      headB: await mint(HEAD_B, T_B, 'principal'),
      teacher: await mint(TEACHER, T_A, 'class_teacher'),
      student: await mint(STUDENT, T_A, 'student'),
    };
  })();
  return ready;
}

const patch = (token: string, body: unknown) =>
  call(structure, { method: 'PATCH', url: '/api/v1/ops/structure', token, body });

async function readSection(id: string, ctx: TenantContext) {
  return db.withTenant(ctx, async (c) => {
    const r = await c.query<{ name: string; capacity: number; class_id: string }>(
      `SELECT name, capacity, class_id FROM sections WHERE id = $1`, [id]);
    return r.rows[0];
  });
}

describe('B-6 — an office can correct its own typo', { skip }, () => {
  before(ensureSetup);

  test('a section is renamed, and the audit records both sides', async () => {
    const res = await patch(tokens.headA, { kind: 'section', id: SEC_A, name: 'ক' });
    assert.equal(res.status, 200);
    assert.equal((await readSection(SEC_A, headA)).name, 'ক');

    const entry = await db.withTenant(headA, async (c) => {
      const r = await c.query<{ action: string; before: unknown; after: unknown }>(
        `SELECT action, before_state AS before, after_state AS after FROM audit.activity_log
          WHERE entity_id = $1 ORDER BY created_at DESC LIMIT 1`, [SEC_A]);
      return r.rows[0];
    });
    assert.equal(entry.action, 'academic.section.update');
    // Both sides: an audit row that only says the new value cannot answer
    // "what did it used to say", which is the question asked after a mistake.
    assert.deepEqual(entry.before, { name: 'কক', capacity: 60 });
    assert.deepEqual(entry.after, { name: 'ক', capacity: 60 });
  });

  test('a class is renamed without touching level, stream or group', async () => {
    const res = await patch(tokens.headA, {
      kind: 'class', id: CLASS_A, nameBn: 'নবম শ্রেণি', nameEn: 'Class Nine',
      // Sent, and must be ignored — the endpoint has no parameter for them.
      levelNo: 5, stream: 'madrasah', group: 'commerce',
    });
    assert.equal(res.status, 200);
    const row = await db.withTenant(headA, async (c) => {
      const r = await c.query<{ name_bn: string; level_no: number; stream: string; group: string }>(
        `SELECT name_bn, level_no, stream::text AS stream, "group"::text AS "group"
           FROM classes WHERE id = $1`, [CLASS_A]);
      return r.rows[0];
    });
    assert.equal(row.name_bn, 'নবম শ্রেণি');
    assert.equal(row.level_no, 9, 'the level decides the subject template');
    assert.equal(row.stream, 'bangla_medium');
    assert.equal(row.group, 'science');
  });

  test('capacity can be raised, and never below the children already in it', async () => {
    await db.withTenant(headA, async (c) => {
      await c.query(`UPDATE sections SET student_count = 42 WHERE id = $1`, [SEC_A]);
    });
    const ok = await patch(tokens.headA, { kind: 'section', id: SEC_A, name: 'ক', capacity: 55 });
    assert.equal(ok.status, 200);
    assert.equal((await readSection(SEC_A, headA)).capacity, 55);

    const bad = await patch(tokens.headA, { kind: 'section', id: SEC_A, name: 'ক', capacity: 30 });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error, 'capacity_below_enrolled');
    // The message names the real number, so the office knows what it may set —
    // in BANGLA digits, because it is a count and the helper directly above it
    // on the same screen says it that way. (Roll numbers stay Latin; they are
    // identifiers read down a phone line. `format.ts` draws that line.)
    assert.match(String(bad.body.message), /৪২/);
    assert.doesNotMatch(String(bad.body.message), /42/);
    assert.equal((await readSection(SEC_A, headA)).capacity, 55, 'unchanged');
  });

  test('a section cannot be moved to another class or year', async () => {
    const before = await readSection(SEC_A, headA);
    const res = await patch(tokens.headA, {
      kind: 'section', id: SEC_A, name: 'ক',
      classId: CLASS_B, academicYearId: YEAR_B,      // ignored, not honoured
    });
    assert.equal(res.status, 200);
    assert.equal((await readSection(SEC_A, headA)).class_id, before.class_id,
      'moving a section moves every child in it, with no enrolment row changing');
  });

  test('an empty or oversized name is refused before the write', async () => {
    for (const name of ['', '   ', 'অ'.repeat(21)]) {
      const res = await patch(tokens.headA, { kind: 'section', id: SEC_A, name });
      assert.equal(res.status, 400, JSON.stringify(name));
      assert.equal(res.body.error, 'bad_name');
    }
  });

  test('a malformed id is refused before any query', async () => {
    const res = await patch(tokens.headA, { kind: 'section', id: 'not-a-uuid', name: 'ক' });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'bad_id');
  });
});

describe('B-6 — who may not', { skip }, () => {
  before(ensureSetup);
  after(async () => { await drop(); await db.end(); });

  test('a class teacher may not rename a section', async () => {
    const res = await patch(tokens.teacher, { kind: 'section', id: SEC_A, name: 'গ' });
    assert.equal(res.status, 403);
    assert.notEqual((await readSection(SEC_A, headA)).name, 'গ');
  });

  test('a student may not', async () => {
    const res = await patch(tokens.student, { kind: 'section', id: SEC_A, name: 'ঘ' });
    assert.equal(res.status, 403);
  });

  test('another school’s principal cannot rename this school’s section', async () => {
    const res = await patch(tokens.headB, { kind: 'section', id: SEC_A, name: 'হ্যাক' });
    // 404, not 403: under tenant B's context the row does not exist at all.
    // The distinction matters — a 403 would confirm the id is real somewhere.
    assert.equal(res.status, 404);
    assert.equal((await readSection(SEC_A, headA)).name, 'ক', 'untouched');
  });

  test('and cannot rename this school’s class', async () => {
    const res = await patch(tokens.headB, { kind: 'class', id: CLASS_A, nameBn: 'হ্যাক' });
    assert.equal(res.status, 404);
  });

  test('no token is 401', async () => {
    const res = await call(structure, {
      method: 'PATCH', url: '/api/v1/ops/structure', body: { kind: 'section', id: SEC_A, name: 'ক' },
    });
    assert.equal(res.status, 401);
  });

  test('a year cannot be edited through this endpoint at all', async () => {
    const res = await patch(tokens.headA, { kind: 'year', id: YEAR_A, name: '2027' });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'bad_kind');
  });
});
