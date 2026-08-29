/**
 * R-7 — the platform console, through the real endpoints.
 *
 * This is the only service that can see more than one school, so most of what
 * is worth asserting here is a REFUSAL: a school's most powerful role cannot
 * reach it, one credential is not enough, and a tenant id in a request body
 * does not become authority.
 *
 * The happy path is asserted too, end to end — create, provision, admin,
 * import, activate — because R-7's definition of done is that a school comes
 * out of it usable, and a wizard whose steps each pass in isolation can still
 * produce a school that cannot take attendance.
 *
 *   PLATFORM_DATABASE_URL=postgresql://shikhon_platform:… \
 *   DATABASE_URL=postgresql://shikhon_app:… \
 *   node --test services/platform-svc/test/platform.test.ts
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { createDb, type Db } from '../../../packages/server-core/src/db.ts';
import { installTestKeys, call } from '../../../packages/server-core/test/harness.ts';

const PLATFORM_URL = process.env.PLATFORM_DATABASE_URL;
const skip = !PLATFORM_URL ? 'PLATFORM_DATABASE_URL not set' : false;

const KEY = 'test-platform-key-r7';
const OPERATOR = '7a700000-0000-4000-8000-0000000000aa';
const PLATFORM_TENANT = '7a700000-0000-4000-8000-00000000000f';
const SLUG_A = 'r7-test-alpha';
const SLUG_B = 'r7-test-beta';

let db: Db;
let platform: typeof import('../api/index.ts').default;
let opToken = '';
let principalToken = '';

/** Every request the console makes carries both credentials. */
const asOperator = (url: string, body?: unknown) =>
  call(platform, {
    url, token: opToken,
    ...(body === undefined ? {} : { method: 'POST', body }),
    headers: { 'x-platform-key': KEY },
  } as Parameters<typeof call>[1]);

/**
 * Remove the fixture schools.
 *
 * Each tenant is deleted from INSIDE its own context, because migration 045
 * takes BYPASSRLS off the platform role: `tenant_self` is
 * `USING (id = app.current_tenant())`, so a bare `DELETE FROM tenants` from
 * the pool matches nothing at all — silently, which is how the first version
 * of this file left every fixture behind and then failed on a duplicate slug.
 *
 * The audit rows are deliberately NOT deleted. `audit.platform_access` has no
 * foreign key to `tenants` and is append-only by design; a test that could
 * erase an audit trail would be a test that proves the trail is erasable.
 */
async function cleanup(): Promise<void> {
  const { rows } = await db.pool.query<{ id: string }>(
    `SELECT id FROM app.platform_tenants(NULL) WHERE slug = ANY($1::citext[])`,
    [[SLUG_A, SLUG_B]]);
  for (const r of rows) {
    await db.withTenant({ tenantId: r.id, userId: OPERATOR, role: 'principal' }, async (c) => {
      // Money rows are ON DELETE RESTRICT, deliberately — a school's
      // financial history cannot be erased by erasing the school.
      await c.query(`DELETE FROM payment_receipts WHERE tenant_id = app.current_tenant()`);
      await c.query(`DELETE FROM ledger_entries   WHERE tenant_id = app.current_tenant()`);
      await c.query(`DELETE FROM mfs_transactions WHERE tenant_id = app.current_tenant()`);
      await c.query(`DELETE FROM tenants WHERE id = app.current_tenant()`);
    });
  }
}


/**
 * Read a count from INSIDE a tenant.
 *
 * Migration 045 takes BYPASSRLS off the platform role, so `db.pool.query`
 * against a tenant-scoped table returns nothing at all — not an error, just
 * zero rows. The first version of these assertions did exactly that and read
 * every count as 0, which looked like the endpoints had done nothing.
 */
async function countIn(tenantId: string, sql: string): Promise<number> {
  return db.withTenant({ tenantId, userId: OPERATOR, role: 'principal' }, async (c) => {
    const { rows } = await c.query<{ n: number }>(sql);
    return Number(rows[0].n);
  });
}

describe('R-7 — platform console', { skip }, () => {
  before(async () => {
    await installTestKeys();
    process.env.PLATFORM_API_KEY = KEY;
    process.env.ACTIVATION_PEPPER ??= 'r7-test-pepper-0123456789abcdef';
    db = createDb(PLATFORM_URL as string, { max: 3 });
    await cleanup();
    const { signAccessToken } = await import('../../../packages/server-core/src/jwt.ts');
    opToken = await signAccessToken({
      sub: OPERATOR, tid: PLATFORM_TENANT, role: 'super_admin', roles: ['super_admin'],
    });
    // A school's most powerful role, for the refusal tests.
    principalToken = await signAccessToken({
      sub: OPERATOR, tid: PLATFORM_TENANT, role: 'principal', roles: ['principal'],
    });
    platform = (await import('../api/index.ts')).default;
  });
  after(async () => { if (db) { await cleanup(); await db.end(); } });

  // ── §24 security: three credentials, and a school holds none of them ──

  describe('authorization', () => {
    test('THE ONE THAT MATTERS — a principal cannot reach the platform', async () => {
      const r = await call(platform, {
        url: '/api/v1/platform/tenants', token: principalToken,
        headers: { 'x-platform-key': KEY },
      } as Parameters<typeof call>[1]);
      assert.equal(r.status, 403);
    });

    test('a valid platform token without the key is refused', async () => {
      const r = await call(platform, { url: '/api/v1/platform/tenants', token: opToken });
      assert.equal(r.status, 403);
    });

    test('the key without a token is refused', async () => {
      const r = await call(platform, {
        url: '/api/v1/platform/tenants',
        headers: { 'x-platform-key': KEY },
      } as Parameters<typeof call>[1]);
      assert.equal(r.status, 401);
    });

    test('a wrong key is refused, and says no more than a wrong token does', async () => {
      const bad = await call(platform, {
        url: '/api/v1/platform/tenants', token: opToken,
        headers: { 'x-platform-key': 'not-the-key' },
      } as Parameters<typeof call>[1]);
      assert.equal(bad.status, 403);
      // Same code either way: an attacker holding one of the two learns
      // nothing about which half they got right.
      const noKey = await call(platform, { url: '/api/v1/platform/tenants', token: opToken });
      assert.equal((bad.body as { error: string }).error, (noKey.body as { error: string }).error);
    });
  });

  // ── The wizard, in order ──────────────────────────────────────────────

  describe('onboarding an institution', () => {
    let tenantId = '';

    test('create — validation refuses before anything is written', async () => {
      const noName = await asOperator('/api/v1/platform/tenants',
        { slug: SLUG_A, nameEn: 'X', stream: 'bangla_medium', level: 'secondary' });
      assert.equal(noName.status, 400);
      assert.equal((noName.body as { error: string }).error, 'invalid_name_bn');

      const badSlug = await asOperator('/api/v1/platform/tenants',
        { slug: 'NO', nameBn: 'ক', nameEn: 'X', stream: 'bangla_medium', level: 'secondary' });
      assert.equal(badSlug.status, 400);
      assert.equal((badSlug.body as { error: string }).error, 'invalid_slug');

      const badStream = await asOperator('/api/v1/platform/tenants',
        { slug: SLUG_A, nameBn: 'ক', nameEn: 'X', stream: 'montessori', level: 'secondary' });
      assert.equal(badStream.status, 400);

      const { rows } = await db.pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM app.platform_tenants(NULL) WHERE slug = $1::citext`,
        [SLUG_A]);
      assert.equal(Number(rows[0].n), 0, 'a refused create left a tenant behind');
    });

    test('create writes the tenant and audits it in the same transaction', async () => {
      const r = await asOperator('/api/v1/platform/tenants', {
        slug: SLUG_A, nameBn: 'আলফা বিদ্যালয়', nameEn: 'Alpha School',
        stream: 'bangla_medium', level: 'secondary',
        district: 'ঢাকা', studentCap: 3, planCode: 'pilot',
      });
      assert.equal(r.status, 200);
      tenantId = (r.body as { tenant: { id: string } }).tenant.id;

      const audit = await db.pool.query(
        `SELECT admin_id, statement FROM audit.platform_access WHERE tenant_id = $1`, [tenantId]);
      assert.equal(audit.rows.length, 1);
      assert.equal(audit.rows[0].admin_id, OPERATOR);
      assert.match(audit.rows[0].statement, /create_tenant/);
    });

    test('a duplicate slug is refused by name, without naming the other school', async () => {
      const r = await asOperator('/api/v1/platform/tenants', {
        slug: SLUG_A, nameBn: 'অন্য', nameEn: 'Other',
        stream: 'madrasah', level: 'secondary',
      });
      assert.equal(r.status, 409);
      assert.equal((r.body as { error: string }).error, 'slug_taken');
      assert.doesNotMatch(JSON.stringify(r.body), /Alpha|আলফা/,
        'the refusal named the school that already holds the slug');
    });

    test('§16 — activation is blocked until the two silent failures are covered', async () => {
      const r = await asOperator('/api/v1/platform/status', { tenantId, status: 'active' });
      assert.equal(r.status, 409);
      const b = r.body as { error: string; blockers: string[] };
      assert.equal(b.error, 'activation_blocked');
      // Named, not a generic refusal: the operator has to know which screen
      // fixes it.
      assert.ok(b.blockers.length >= 2, `expected blockers, got ${JSON.stringify(b.blockers)}`);
    });

    test('provision seeds the spine, INCLUDING the grading scale', async () => {
      const r = await asOperator('/api/v1/platform/provision', {
        tenantId, yearLabel: '2027', startsOn: '2027-01-01', endsOn: '2027-12-31',
        minLevel: 6, maxLevel: 8, sectionsPerClass: 2,
      });
      assert.equal(r.status, 200);
      const b = r.body as { seeded: string[]; sectionsMade: number };
      // Without bands, app.compute_subject_grade returns NULL and the year's
      // first result publication fails months later with no obvious cause.
      assert.ok(b.seeded.some((s) => s.includes('grading_bands')), 'no grading bands');
      // And the templates provision_tenant does not create, without which
      // the student import rejects every row.
      assert.ok(b.seeded.some((s) => s.includes('subject_templates')), 'no subject templates');
      assert.ok(b.sectionsMade > 0);
    });

    test('provision is idempotent — a retry after a failure is always safe', async () => {
      const again = await asOperator('/api/v1/platform/provision', {
        tenantId, yearLabel: '2027', startsOn: '2027-01-01', endsOn: '2027-12-31',
        minLevel: 6, maxLevel: 8, sectionsPerClass: 2,
      });
      assert.equal(again.status, 200);
      assert.equal(await countIn(tenantId, 'SELECT count(*)::int AS n FROM academic_years'), 1,
        'a second provision created a second academic year');
    });

    test('branding writes only the keys supplied, never a placeholder', async () => {
      const r = await asOperator('/api/v1/platform/branding', {
        tenantId, branding: { nameBn: 'আলফা বিদ্যালয়', primaryColor: '#1B5E20' },
      });
      assert.equal(r.status, 200);
      const b = (r.body as { branding: Record<string, string> }).branding;
      // parseBranding fills defaults for absent fields; persisting those
      // would have written "Institution" over every school's English name.
      assert.deepEqual(Object.keys(b).sort(), ['nameBn', 'primaryColor']);
    });

    test('the first admin is created with a one-time activation code', async () => {
      const r = await asOperator('/api/v1/platform/admin', {
        tenantId, nameBn: 'প্রধান শিক্ষক', phone: '+8801799910001', roleCode: 'principal',
      });
      assert.equal(r.status, 200);
      const b = r.body as { activationCode: string; reused: boolean };
      assert.match(b.activationCode, /^[A-Z2-9]{8}$/);
      assert.equal(b.reused, false);

      // The code itself is never stored — only an HMAC.
      assert.equal(await countIn(tenantId, 'SELECT count(*)::int AS n FROM activation_codes'), 1);
    });

    test('the same phone twice grants the role rather than duplicating the person', async () => {
      const r = await asOperator('/api/v1/platform/admin', {
        tenantId, nameBn: 'প্রধান শিক্ষক', phone: '+8801799910001', roleCode: 'it_admin',
      });
      assert.equal(r.status, 200);
      assert.equal((r.body as { reused: boolean }).reused, true);
      assert.equal(
        await countIn(tenantId,
          "SELECT count(*)::int AS n FROM users WHERE phone_e164 = '+8801799910001'"),
        1, 'a second account was created for one human');
    });

    test('a platform role can never be granted to a school account', async () => {
      const r = await asOperator('/api/v1/platform/admin', {
        tenantId, nameBn: 'x', phone: '+8801799910009', roleCode: 'super_admin',
      });
      assert.equal(r.status, 400);
      assert.equal((r.body as { error: string }).error, 'invalid_role');
    });

    test('teacher import — dry run writes nothing and names the bad rows', async () => {
      const csv = [
        'নাম,আইডি,মোবাইল',
        'রফিকুল ইসলাম,TA-1,01799911001',
        'সালমা খাতুন,TA-2,01799911002',
        'নাসরিন আক্তার,TA-3,',      // no phone, no email → rejected
      ].join('\n');
      const dry = await asOperator('/api/v1/platform/import', { tenantId, kind: 'teacher', csv });
      assert.equal(dry.status, 200);
      const b = dry.body as { rowsRead: number; rowsValid: number; rowsRejected: number;
                              digest: string; errorCsv: string | null };
      assert.equal(b.rowsRead, 3);
      assert.equal(b.rowsValid, 2);
      assert.equal(b.rowsRejected, 1);
      assert.ok(b.errorCsv, 'no downloadable error list');

      assert.equal(await countIn(tenantId, 'SELECT count(*)::int AS n FROM staff_profiles'), 0,
        'the dry run wrote staff');

      const done = await asOperator('/api/v1/platform/import', {
        tenantId, kind: 'teacher', csv, commit: true, digest: b.digest,
      });
      assert.equal((done.body as { rowsImported: number }).rowsImported, 2);
    });

    test('a swapped file between validation and commit is refused', async () => {
      const csv = 'নাম,আইডি,মোবাইল\nঅন্য কেউ,TA-9,01799911009';
      const r = await asOperator('/api/v1/platform/import', {
        tenantId, kind: 'teacher', csv, commit: true, digest: 'f'.repeat(64),
      });
      assert.equal(r.status, 409);
      assert.equal((r.body as { error: string }).error, 'digest_mismatch');
    });

    test('§14 — siblings on one mobile become ONE guardian with two children', async () => {
      const csv = [
        'রোল,নাম,শ্রেণি,শাখা,অভিভাবক,মোবাইল,সম্পর্ক',
        '১,রাফি হাসান,6,ক,মোঃ হাসান,01799912001,father',
        '২,সাদিয়া হাসান,7,ক,মোঃ হাসান,01799912001,father',
      ].join('\n');
      const dry = await asOperator('/api/v1/platform/import', { tenantId, kind: 'student', csv });
      const d = dry.body as { rowsValid: number; digest: string };
      assert.equal(d.rowsValid, 2);
      const done = await asOperator('/api/v1/platform/import', {
        tenantId, kind: 'student', csv, commit: true, digest: d.digest,
      });
      assert.equal((done.body as { rowsImported: number }).rowsImported, 2);

      assert.equal(
        await countIn(tenantId, 'SELECT count(DISTINCT guardian_id)::int AS n FROM guardianships'),
        1, 'two siblings produced two guardians');
    });

    test('§20 — the cap is enforced by the SERVER, with both numbers stated', async () => {
      // The tenant was created with student_cap 3 and has 2 students.
      const csv = [
        'রোল,নাম,শ্রেণি,শাখা,অভিভাবক,মোবাইল,সম্পর্ক',
        '৩,একজন,6,ক,অভিভাবক,01799912003,father',
        '৪,দুইজন,6,ক,অভিভাবক,01799912004,father',
      ].join('\n');
      const dry = await asOperator('/api/v1/platform/import', { tenantId, kind: 'student', csv });
      const d = dry.body as { digest: string; rowsValid: number };
      assert.equal(d.rowsValid, 2);
      const r = await asOperator('/api/v1/platform/import', {
        tenantId, kind: 'student', csv, commit: true, digest: d.digest,
      });
      assert.equal(r.status, 409);
      const body = r.body as { error: string; message: string };
      assert.equal(body.error, 'cap_exceeded');
      // "cap exceeded" tells an operator nothing; the numbers tell them
      // whether to trim the file or raise the plan.
      assert.match(body.message, /3/);
      assert.match(body.message, /4/);

      assert.equal(await countIn(tenantId, 'SELECT count(*)::int AS n FROM student_profiles'), 2,
        'an over-cap import wrote rows anyway');
    });

    test('the derived state reports what actually landed', async () => {
      const r = await asOperator(`/api/v1/platform/tenant?id=${tenantId}`);
      const b = r.body as { state: Record<string, number | boolean>; canActivate: boolean };
      assert.equal(b.state.years, 1);
      assert.ok((b.state.gradingBands as number) > 0);
      assert.equal(b.state.students, 2);
      assert.equal(b.state.guardians, 1);
      assert.ok((b.state.teachers as number) >= 2);
      assert.equal(b.canActivate, true);
    });

    test('activate, then suspend, then restore — data untouched throughout', async () => {
      assert.equal((await asOperator('/api/v1/platform/status',
        { tenantId, status: 'active' })).status, 200);

      const before = await countIn(tenantId, 'SELECT count(*)::int AS n FROM student_profiles');

      assert.equal((await asOperator('/api/v1/platform/status',
        { tenantId, status: 'suspended', reason: 'non-payment' })).status, 200);

      const after = await countIn(tenantId, 'SELECT count(*)::int AS n FROM student_profiles');
      assert.equal(after, before, 'suspension lost data');

      const back = await asOperator('/api/v1/platform/status', { tenantId, status: 'active' });
      assert.equal(back.status, 200);
      const t = await asOperator(`/api/v1/platform/tenant?id=${tenantId}`);
      assert.equal((t.body as { tenant: { status: string } }).tenant.status, 'active');
    });

    /**
     * R-7's exit criterion, and the one nothing else covers.
     *
     * The wizard mints the code and identity-svc redeems it, which means the
     * two must agree on the alphabet, the length and the HMAC. Extracting
     * those three into a shared module during R-7 left `CODE_LEN` undefined
     * in the redeem path — a ReferenceError that surfaced as a 500 on the
     * ONE login a brand-new school has. identity-svc's ten tests all passed
     * through it, because none of them redeems a code.
     *
     * So this asserts the round trip: a school's first principal signs in
     * with the printed slip and gets a session with the right role.
     */
    test('THE ONE THAT MATTERS — the head teacher logs in with the printed code', async () => {
      const issued = await asOperator('/api/v1/platform/admin', {
        tenantId, nameBn: 'নতুন প্রধান', phone: '+8801799910055', roleCode: 'principal',
      });
      const code = (issued.body as { activationCode: string }).activationCode;

      const activate = (await import('../../identity-svc/api/activate.ts')).default;
      const r = await call(activate, {
        method: 'POST', url: '/api/v1/auth/activate',
        body: { action: 'redeem', tenantId, code, deviceId: 'r7-test-device' },
      });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      const b = r.body as { accessToken: string; user: { role: string } };
      assert.equal(b.user.role, 'principal');
      assert.ok(b.accessToken.length > 100);

      // Single use: the same slip cannot sign in twice.
      const again = await call(activate, {
        method: 'POST', url: '/api/v1/auth/activate',
        body: { action: 'redeem', tenantId, code, deviceId: 'r7-test-device-2' },
      });
      assert.equal(again.status, 400);
      assert.equal((again.body as { error: string }).error, 'invalid_code');
    });

    test('§25 — every platform action is in the audit trail', async () => {
      const r = await asOperator(`/api/v1/platform/audit?tenantId=${tenantId}`);
      const entries = (r.body as { entries: Array<{ reason: string; actorId: string }> }).entries;
      const reasons = entries.map((e) => e.reason).join(' ');
      for (const expected of ['onboarding wizard', 'provisioning', 'branding', 'first admin']) {
        assert.match(reasons, new RegExp(expected), `no audit row for ${expected}`);
      }
      // The operator, not the school.
      assert.ok(entries.every((e) => e.actorId === OPERATOR));
    });
  });

  // ── §24 isolation ─────────────────────────────────────────────────────

  describe('tenant isolation', () => {
    test('a second institution is entirely separate', async () => {
      const r = await asOperator('/api/v1/platform/tenants', {
        slug: SLUG_B, nameBn: 'বিটা মাদ্রাসা', nameEn: 'Beta Madrasah',
        stream: 'madrasah', level: 'secondary', weekendDays: [5], studentCap: 50,
      });
      assert.equal(r.status, 200);
      const b = (r.body as { tenant: { id: string } }).tenant.id;

      const state = await asOperator(`/api/v1/platform/tenant?id=${b}`);
      const s = (state.body as { state: Record<string, number> }).state;
      assert.equal(s.students, 0, 'a brand new school already had students');
      assert.equal(s.classes, 0);

      // The madrasah default weekend is Friday only, not Friday+Saturday.
      const t = (state.body as { tenant: { weekendDays: number[] } }).tenant;
      assert.deepEqual(t.weekendDays, [5]);
    });

    test('an unknown tenant id is 404, not a 500 and not a leak', async () => {
      const r = await asOperator('/api/v1/platform/tenant?id=7a700000-0000-4000-8000-000000000999');
      assert.equal(r.status, 404);
    });

    test('a malformed tenant id never reaches the database', async () => {
      const r = await asOperator('/api/v1/platform/tenant?id=not-a-uuid');
      assert.equal(r.status, 400);
    });
  });
});
