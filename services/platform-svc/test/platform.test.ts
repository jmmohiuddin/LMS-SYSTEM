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
import { installTestKeys, call, asBootstrap } from '../../../packages/server-core/test/harness.ts';

const PLATFORM_URL = process.env.PLATFORM_DATABASE_URL;
const skip = !PLATFORM_URL ? 'PLATFORM_DATABASE_URL not set' : false;

const KEY = 'test-platform-key-r7';
const OPERATOR = '7a700000-0000-4000-8000-0000000000aa';
const PLATFORM_TENANT = '7a700000-0000-4000-8000-00000000000f';
const SLUG_A = 'r7-test-alpha';
const SLUG_B = 'r7-test-beta';

/**
 * A device id per RUN, not a constant.
 *
 * Activation redemption is rate-limited as `otp_verify` — 10 per hour, keyed
 * on the device. With a fixed id every run of this suite spent from the SAME
 * bucket, so the fifth run in an hour failed with a 429 and looked exactly
 * like a flaky test. It was the limiter working correctly on a test that had
 * accidentally made itself the attacker.
 *
 * This does not weaken the limit: it is asserted where it belongs, in
 * `packages/server-core`'s rate-limit suite and in `security-probe.mjs`.
 * Here it was deciding the outcome of a test about onboarding.
 */
const DEVICE = `r7-test-device-${process.pid}-${Math.floor(Math.random() * 1e6)}`;

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
  // Also the P10 fixtures, by PREFIX.
  //
  // Those suites create a school per run with a pid in its slug, so a fixed
  // list cannot name them. Without this they leaked four tenants per run into
  // a database the whole repository shares — and the symptom was not "the
  // platform suite is untidy", it was `fee-structures.test.ts` failing to
  // start, intermittently, in a different service. A test that leaves rows
  // behind is a test that eventually breaks someone else's.
  const { rows } = await db.pool.query<{ id: string }>(
    `SELECT id FROM app.platform_tenants(NULL)
      WHERE slug = ANY($1::citext[]) OR slug::text LIKE 'p10-%'`,
    [[SLUG_A, SLUG_B]]);
  for (const r of rows) {
    // Bootstrap: these suites leave schools suspended on purpose, and the
    // gate refuses a suspended school — so the ordinary path could not clean
    // up after the very tests that matter most here.
    await asBootstrap(db, { tenantId: r.id, userId: OPERATOR, role: 'principal' }, async (c) => {
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
  // Bootstrap, like the console itself: this counts rows in schools that are
  // deliberately suspended, to prove suspension loses nothing. Reading a
  // suspended school is exactly what the platform service is for — every one
  // of its own `withTenant` calls declares `skipGate` for the same reason.
  return asBootstrap(db, { tenantId, userId: OPERATOR, role: 'principal' }, async (c) => {
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
      const r = await asOperator('/api/v1/platform/status', { tenantId, status: 'active', reason: 'R-7 acceptance' });
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
      assert.equal(b.nameBn, 'আলফা বিদ্যালয়');
      assert.equal(b.primaryColor, '#1b5e20');
      assert.ok(!('nameEn' in b), 'a placeholder English name was persisted');
      assert.ok(!('accentColor' in b), 'a placeholder accent colour was persisted');
    });

    test('THE ONE THAT MATTERS — a partial write keeps everything else', async () => {
      // P8. `jsonb_set(settings, {branding}, clean)` REPLACED the object, so a
      // request carrying one key deleted every key already saved. Observed on
      // a real tenant: changing only the primary colour erased the school's
      // name, English name, short name and logo — the whole white-label
      // identity, from a colour picker.
      //
      // The test that was here checked the placeholder half of the rule and
      // not this half, which is why it passed throughout.
      //
      // services/ops-svc/api/branding.ts — the SCHOOL's own editor — had it
      // right all along and says so in its header. The console reimplemented
      // the rule instead of reusing it.
      await asOperator('/api/v1/platform/branding', {
        tenantId,
        branding: {
          nameBn: 'আলফা বিদ্যালয়', nameEn: 'Alpha School',
          shortName: 'আলফা', logoUrl: '/media/alpha.png', primaryColor: '#1B5E20',
        },
      });

      const r = await asOperator('/api/v1/platform/branding', {
        tenantId, branding: { primaryColor: '#0D47A1' },
      });
      assert.equal(r.status, 200);
      const b = (r.body as { branding: Record<string, string> }).branding;

      assert.equal(b.primaryColor, '#0d47a1', 'the change did not take');
      assert.equal(b.nameBn, 'আলফা বিদ্যালয়', 'the school lost its name');
      assert.equal(b.nameEn, 'Alpha School', 'the school lost its English name');
      assert.equal(b.shortName, 'আলফা', 'the school lost its short name');
      assert.equal(b.logoUrl, '/media/alpha.png', 'the school lost its logo');

      // And the row itself, not just what the response chose to echo back.
      const stored = await asOperator(`/api/v1/platform/tenant?id=${tenantId}`);
      const t = (stored.body as { tenant: { branding?: Record<string, string> } }).tenant;
      if (t.branding) {
        assert.equal(t.branding.logoUrl, '/media/alpha.png',
          'the response and the stored row disagree');
      }
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

    test('R-8 §9A — an existing number is REFUSED until the operator confirms', async () => {
      // Reuse is right; reusing silently was not. An operator who mistypes a
      // digit and lands on an existing teacher's number, with "principal"
      // selected, used to promote that teacher and see only `reused: true` in
      // a response the console never surfaced. It happened during R-7's
      // acceptance walk, which is how it was found.
      const r = await asOperator('/api/v1/platform/admin', {
        tenantId, nameBn: 'প্রধান শিক্ষক', phone: '+8801799910001', roleCode: 'it_admin',
      });
      assert.equal(r.status, 409);
      const body = r.body as {
        error: string; existingName: string; existingRoles: string[];
        requestedRole: string; alreadyHasRole: boolean;
      };
      assert.equal(body.error, 'user_exists');
      // The refusal must name WHO and WHAT THEY ALREADY ARE — "this number is
      // already registered" is not enough to decide with.
      assert.ok(body.existingName.length > 0);
      assert.ok(Array.isArray(body.existingRoles));
      assert.equal(body.requestedRole, 'it_admin');

      // Nothing was granted by the refusal.
      assert.equal(
        await countIn(tenantId,
          "SELECT count(*)::int AS n FROM user_roles r JOIN users u ON u.id = r.user_id"
          + " WHERE u.phone_e164 = '+8801799910001' AND r.role_code = 'it_admin'"),
        0, 'a refused request granted the role anyway');
    });

    test('R-8 §9A — confirmed, it grants the role rather than duplicating the person', async () => {
      const r = await asOperator('/api/v1/platform/admin', {
        tenantId, nameBn: 'প্রধান শিক্ষক', phone: '+8801799910001', roleCode: 'it_admin',
        confirmExisting: true,
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
      const body = r.body as {
        error: string; message: string; cap?: number; enrolled?: number;
      };
      assert.equal(body.error, 'student_cap_reached');
      // R-8 §9B. The numbers still have to be there — they are what tells an
      // operator whether to trim the file or raise the plan — but they arrive
      // as fields AND in Bangla numerals in the message, rather than as the
      // database trigger's English sentence passed through verbatim.
      assert.equal(body.cap, 3);
      assert.equal(typeof body.enrolled, 'number');
      assert.match(body.message, /৩/, 'the cap, in Bangla numerals');
      assert.doesNotMatch(body.message, /student cap reached/i,
        'the database trigger English must not reach an operator');
      assert.match(body.message, /কিছুই আমদানি হয়নি/,
        'an operator must be told that nothing was written');

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
        { tenantId, status: 'active', reason: 'R-7 acceptance' })).status, 200);

      const before = await countIn(tenantId, 'SELECT count(*)::int AS n FROM student_profiles');

      assert.equal((await asOperator('/api/v1/platform/status',
        { tenantId, status: 'suspended', reason: 'non-payment' })).status, 200);

      const after = await countIn(tenantId, 'SELECT count(*)::int AS n FROM student_profiles');
      assert.equal(after, before, 'suspension lost data');

      const back = await asOperator('/api/v1/platform/status', { tenantId, status: 'active', reason: 'R-7 acceptance' });
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
        body: { action: 'redeem', tenantId, code, deviceId: DEVICE },
      });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      const b = r.body as { accessToken: string; user: { role: string } };
      assert.equal(b.user.role, 'principal');
      assert.ok(b.accessToken.length > 100);

      // Single use: the same slip cannot sign in twice.
      const again = await call(activate, {
        method: 'POST', url: '/api/v1/auth/activate',
        body: { action: 'redeem', tenantId, code, deviceId: `${DEVICE}-2` },
      });
      assert.equal(again.status, 400);
      assert.equal((again.body as { error: string }).error, 'invalid_code');
    });

    test('§25 — every platform action is in the audit trail', async () => {
      const r = await asOperator(`/api/v1/platform/audit?tenantId=${tenantId}`);
      const entries = (r.body as { entries: Array<{ reason: string }> }).entries;
      const reasons = entries.map((e) => e.reason).join(' ');
      for (const expected of ['onboarding wizard', 'provisioning', 'branding', 'first admin']) {
        assert.match(reasons, new RegExp(expected), `no audit row for ${expected}`);
      }

      // The operator, not the school — asserted against the STORED row.
      //
      // P7 stopped shipping `admin_id` to the client: it is a JWT subject
      // with no `users` row behind it, so it resolves to nobody, cannot be
      // displayed under "never expose raw UUIDs", and sending it only invites
      // the next person to render it (B-39). The property it was proving is
      // about what is RECORDED, so it is checked where it is recorded — which
      // is the stronger place for it, since a projection could be right while
      // the row was wrong.
      const { rows } = await db.pool.query<{ admin_id: string }>(
        `SELECT DISTINCT admin_id FROM audit.platform_access WHERE tenant_id = $1`,
        [tenantId]);
      assert.deepEqual(rows.map((x) => x.admin_id), [OPERATOR],
        'a platform action was attributed to somebody other than the operator');

      // And the id never reaches the client, which is the point of removing it.
      assert.ok(!JSON.stringify(r.body).includes(OPERATOR),
        'the audit response is leaking an operator uuid again');
    });
  });

  // ── §24 isolation ─────────────────────────────────────────────────────

  // ── §16 D16: the plan CATALOGUE, not just a school's plan ──
  //
  // A school's plan had a screen; the plans it could be changed TO were seed
  // rows editable only in psql. A plan's price, cap, services and grace
  // window are commercial state, and P7's own gate says none of that may be
  // SQL-only.
  describe('the plan catalogue', () => {
    const PLAN = 'p7_test_plan';
    const base = {
      code: PLAN, nameBn: 'পরীক্ষামূলক প্ল্যান', priceBdt: 12345.5,
      billingCycle: 'yearly', studentCap: 250, trialDays: 15, graceDays: 20,
      services: { attendance: true, results: true }, isActive: true,
      reason: 'P7 test — the catalogue must be operable without SQL',
    };

    after(async () => {
      // No DELETE endpoint by design (a plan with schools on it cannot be
      // removed without orphaning or cascading), so the fixture is removed
      // directly. Safe: nothing is on it.
      await db.pool.query('DELETE FROM plans WHERE code = $1', [PLAN]);
    });

    test('THE ONE THAT MATTERS — a plan can be created without touching SQL', async () => {
      const r = await asOperator('/api/v1/platform/plans', base);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      const b = r.body as { created: boolean; affected: number; plan: Record<string, unknown> };
      assert.equal(b.created, true);
      assert.equal(b.affected, 0, 'a brand new plan cannot already have schools');
      assert.equal(b.plan.studentCap, 250);
      assert.equal(b.plan.graceDays, 20);
      assert.deepEqual(b.plan.services, { attendance: true, results: true });
    });

    test('it appears in the catalogue the console reads', async () => {
      const r = await asOperator('/api/v1/platform/catalogue');
      const plans = (r.body as { plans: Array<{ code: string }> }).plans;
      assert.ok(plans.some((p) => p.code === PLAN), 'the new plan is not in the picker');
    });

    test('the whole plan is written, so a dropped service is really dropped', async () => {
      // A PATCH would leave last year's services beside this year's price.
      await asOperator('/api/v1/platform/plans',
        { ...base, services: { attendance: true }, reason: 'drop results' });
      const r = await asOperator('/api/v1/platform/catalogue');
      const p = (r.body as { plans: Array<{ code: string; services: Record<string, boolean> }> })
        .plans.find((x) => x.code === PLAN);
      assert.deepEqual(p?.services, { attendance: true });
    });

    test('a service the catalogue does not know is refused by name', async () => {
      const r = await asOperator('/api/v1/platform/plans',
        { ...base, services: { attendance: true, teleportation: true } });
      assert.equal(r.status, 400);
      assert.equal((r.body as { error: string }).error, 'unknown_service');
    });

    test('no reason, no change — the same rule as every other commercial act', async () => {
      const r = await asOperator('/api/v1/platform/plans', { ...base, reason: '' });
      assert.equal(r.status, 400);
      assert.equal((r.body as { error: string }).error, 'reason_required');
    });

    test('a nonsense code is refused before it reaches the database', async () => {
      for (const code of ['A', 'has space', 'Has-Caps', '9leading', '']) {
        const r = await asOperator('/api/v1/platform/plans', { ...base, code });
        assert.equal(r.status, 400, code);
        assert.equal((r.body as { error: string }).error, 'invalid_code', code);
      }
    });

    test('a cap or price below zero is refused', async () => {
      assert.equal((await asOperator('/api/v1/platform/plans',
        { ...base, studentCap: 0 })).status, 400);
      assert.equal((await asOperator('/api/v1/platform/plans',
        { ...base, priceBdt: -1 })).status, 400);
    });

    test('the change is in the audit trail, carrying the operator sentence', async () => {
      await asOperator('/api/v1/platform/plans',
        { ...base, priceBdt: 999, reason: 'দাম কমানো হয়েছে' });
      // Scoped to THIS plan, not "the newest row". These suites share one
      // database (B-35) and the console itself writes here, so "the latest
      // audit row is mine" is only true when nothing else is running — which
      // is exactly the assumption that makes a suite pass once and fail the
      // second time.
      const { rows } = await db.pool.query<{ reason: string; statement: string }>(
        `SELECT reason, statement FROM audit.platform_access
          WHERE tenant_id IS NULL AND statement LIKE $1
          ORDER BY created_at DESC, id DESC LIMIT 1`, [`plan ${PLAN}:%`]);
      assert.equal(rows[0].reason, 'দাম কমানো হয়েছে');
      assert.match(rows[0].statement, new RegExp(PLAN));
      // The count of affected schools must be REAL. It was 0 for every plan
      // once, because the query read `FROM tenants` as the platform role and
      // RLS hid every row — a silent zero that reached the audit trail.
      assert.match(rows[0].statement, /\d+ schools affected/);
    });

    test('a school cannot reach it', async () => {
      const r = await call(platform, {
        url: '/api/v1/platform/plans', method: 'POST', body: base,
        token: principalToken, headers: { 'x-platform-key': KEY },
      } as Parameters<typeof call>[1]);
      assert.equal(r.status, 403);
    });
  });


  // ── §8 service dependency safety ──
  //
  // `setService` refuses to switch a service off while something that depends
  // on it is still on. That code had never executed: the seeded catalogue
  // declares NO dependencies (051 removed the one bogus entry it shipped
  // with), so the refusal was a path with no data behind it — present,
  // plausible, and never once run.
  //
  // These declare a dependency for the length of the test and take it away
  // again. That tests the MECHANISM, which is the honest thing to test:
  // inventing a product rule so the assertion has something to bite would be
  // asserting a fiction.
  describe('service dependency safety', () => {
    let tenantId = '';

    before(async () => {
      const r = await asOperator('/api/v1/platform/tenants', {
        slug: 'r7-test-dep', nameBn: 'নির্ভরতা পরীক্ষা', nameEn: 'Dep Test',
        stream: 'bangla_medium', level: 'secondary', studentCap: 10,
      });
      tenantId = (r.body as { tenant: { id: string } }).tenant.id;
      await db.pool.query(
        `UPDATE service_catalogue SET depends_on = '{results}' WHERE code = 'reports'`);
    });

    after(async () => {
      // Reference data shared by every suite — always put it back.
      await db.pool.query(
        `UPDATE service_catalogue SET depends_on = '{}' WHERE code = 'reports'`);
      if (tenantId) {
        await asBootstrap(db, { tenantId, userId: OPERATOR, role: 'principal' },
          (c) => c.query('DELETE FROM tenants WHERE id = app.current_tenant()'));
      }
    });

    test('THE ONE THAT MATTERS — a service in use by another is refused', async () => {
      const r = await asOperator('/api/v1/platform/service', {
        tenantId, service: 'results', state: 'disabled',
        reason: 'should be refused while reports depends on it',
      });
      assert.equal(r.status, 409, JSON.stringify(r.body));
      assert.equal((r.body as { error: string }).error, 'dependency_active');
    });

    test('and it NAMES what has to go first', async () => {
      const r = await asOperator('/api/v1/platform/service', {
        tenantId, service: 'results', state: 'disabled', reason: 'naming check',
      });
      const b = r.body as { message: string; dependents: string[] };
      assert.deepEqual(b.dependents, ['reports']);
      // The operator is told the Bangla NAME, not the code — "রিপোর্ট", not
      // "reports". A refusal that names an internal code is a refusal the
      // person cannot act on.
      assert.match(b.message, /রিপোর্ট/);
    });

    test('turn the dependent off first, and it goes through', async () => {
      assert.equal((await asOperator('/api/v1/platform/service', {
        tenantId, service: 'reports', state: 'disabled', reason: 'dependent first',
      })).status, 200);
      assert.equal((await asOperator('/api/v1/platform/service', {
        tenantId, service: 'results', state: 'disabled', reason: 'now allowed',
      })).status, 200);
    });

    test('the catalogue cannot name a service that does not exist', async () => {
      // Migration 058. Before it, a dangling code silently made the refusal
      // above stop firing — no error, no match, no protection.
      await assert.rejects(
        () => db.pool.query(
          `UPDATE service_catalogue SET depends_on = '{ghost}' WHERE code = 'reports'`),
        (err: unknown) => (err as { code?: string }).code === '23503');
    });

    test('nor depend on itself', async () => {
      await assert.rejects(
        () => db.pool.query(
          `UPDATE service_catalogue SET depends_on = '{reports}' WHERE code = 'reports'`),
        (err: unknown) => (err as { code?: string }).code === '23514');
    });
  });

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

  // ── P10-1 · the fleet, one page at a time ──────────────────────────────
  //
  // The console used to fetch EVERY school on every request — 142 kB at 258
  // schools — and page, sort and triage in the browser. These pin the parts
  // a paginated list gets wrong quietly.

  describe('fleet pagination', () => {
    test('THE ONE THAT MATTERS — the total describes the FLEET, not the page', async () => {
      // The failure this prevents: an operator filters to the schools that
      // are down, sees "25 of 25" because that is the page size, and closes
      // the screen believing they have seen all of them.
      const small = await asOperator('/api/v1/platform/tenants?size=2&page=1');
      assert.equal(small.status, 200);
      const b = small.body as { tenants: unknown[]; page: Record<string, number | string> };
      assert.ok(b.tenants.length <= 2, `page returned ${b.tenants.length}`);

      const all = await asOperator('/api/v1/platform/tenants?size=100&page=1');
      const a = all.body as { tenants: unknown[]; page: Record<string, number> };
      assert.equal(b.page.total, a.page.total,
        'a page of 2 and a page of 100 must report the same total');
      assert.ok((b.page.total as number) >= b.tenants.length);
    });

    test('page 2 does not repeat page 1', async () => {
      const p1 = await asOperator('/api/v1/platform/tenants?size=3&page=1');
      const p2 = await asOperator('/api/v1/platform/tenants?size=3&page=2');
      const ids = (r: typeof p1) =>
        ((r.body as { tenants: { id: string }[] }).tenants).map((t) => t.id);
      const overlap = ids(p1).filter((id) => ids(p2).includes(id));
      assert.deepEqual(overlap, [], 'a school appeared on both pages');
    });

    test('the page size is clamped, so a caller cannot ask for the fleet', async () => {
      const r = await asOperator('/api/v1/platform/tenants?size=100000');
      const b = r.body as { tenants: unknown[]; page: { size: number } };
      assert.ok(b.page.size <= 100, `size came back ${b.page.size}`);
      assert.ok(b.tenants.length <= 100);
    });

    test('an unknown sort key falls back rather than reaching the database', async () => {
      const r = await asOperator(
        '/api/v1/platform/tenants?sort=' + encodeURIComponent("name; DROP TABLE tenants--"));
      assert.equal(r.status, 200);
      assert.equal((r.body as { page: { sort: string } }).page.sort, 'name');
      // And the fleet is still there.
      const after = await asOperator('/api/v1/platform/tenants?size=1');
      assert.equal(after.status, 200);
    });

    test('sorting by students is numeric, not lexicographic', async () => {
      const r = await asOperator('/api/v1/platform/tenants?sort=students&dir=desc&size=50');
      const counts = ((r.body as { tenants: { studentCount: number }[] }).tenants)
        .map((t) => t.studentCount);
      const sorted = [...counts].sort((x, y) => y - x);
      assert.deepEqual(counts, sorted, '9 must not sort above 10');
    });

    test('every row carries the operational state the console shows', async () => {
      const r = await asOperator('/api/v1/platform/tenants?size=1');
      const t = (r.body as { tenants: Record<string, unknown>[] }).tenants[0];
      if (!t) return;                       // an empty fixture is not a failure
      for (const k of ['status', 'access', 'opsState', 'billingState',
                       'studentCount', 'userCount', 'classCount',
                       'sectionCount', 'severity']) {
        assert.ok(k in t, `the fleet row has no ${k}`);
      }
      assert.ok(['critical', 'warning', 'info', 'none'].includes(t.severity as string),
        `unexpected severity ${String(t.severity)}`);
    });

    test('the summary counts the whole fleet, not the page', async () => {
      const sum = await asOperator('/api/v1/platform/fleetsummary');
      assert.equal(sum.status, 200);
      const s = sum.body as {
        total: number; attention: { critical: number; warning: number; info: number } };
      const page = await asOperator('/api/v1/platform/tenants?size=1');
      assert.equal(s.total, (page.body as { page: { total: number } }).page.total,
        'the summary and an unfiltered page must agree on the fleet size');

      // And a severity filter returns exactly what the summary promised.
      const crit = await asOperator('/api/v1/platform/tenants?attention=critical&size=100');
      const rows = (crit.body as { tenants: { severity: string }[] }).tenants;
      assert.ok(rows.every((t) => t.severity === 'critical'),
        'a critical-only page contained something else');
      assert.equal((crit.body as { page: { total: number } }).page.total,
        s.attention.critical,
        'the filtered total must equal the badge that offered the filter');
    });

    test('the fleet is not reachable without both credentials', async () => {
      const noKey = await call(platform, {
        url: '/api/v1/platform/fleetsummary', token: opToken });
      assert.equal(noKey.status, 403);
      const asSchool = await call(platform, {
        url: '/api/v1/platform/fleetsummary', token: principalToken,
        headers: { 'x-platform-key': KEY },
      } as Parameters<typeof call>[1]);
      assert.equal(asSchool.status, 403);
    });
  });

  // ── P10-4 · health ─────────────────────────────────────────────────────
  //
  // `/platform/health` has existed since R-8 and had NO tests. The audit that
  // set P10's scope said the ops console never called it; that was true then
  // and R-8 wired it, so the gap left is coverage rather than a feature.
  //
  // The point of this endpoint is that an operator supporting a school can
  // see whether its messages are going out and whether anybody has signed in
  // — WITHOUT reading pupil records. So the tests are about the shape it
  // promises, the states it must survive, and the line it must not cross.

  describe('tenant health', () => {
    let tenantId = '';
    let freshId = '';

    before(async () => {
      // Two schools: one the suite has exercised, and one created and left
      // alone. The second is the state EVERY school is in on its first day,
      // and the one a health screen is most likely to render badly.
      const a = await asOperator('/api/v1/platform/tenants', {
        nameBn: 'হেলথ বিদ্যালয়', nameEn: 'Health School',
        slug: `p10-health-${process.pid}`, stream: 'bangla_medium',
        level: 'secondary', planCode: 'pilot', studentCap: 100,
      });
      tenantId = (a.body as { tenant: { id: string } }).tenant?.id ?? '';
      const b = await asOperator('/api/v1/platform/tenants', {
        nameBn: 'নতুন বিদ্যালয়', nameEn: 'Fresh School',
        slug: `p10-fresh-${process.pid}`, stream: 'bangla_medium',
        level: 'secondary', planCode: 'pilot', studentCap: 100,
      });
      freshId = (b.body as { tenant: { id: string } }).tenant?.id ?? '';
    });

    test('THE ONE THAT MATTERS — health carries no pupil-level data', async () => {
      // A platform operator browsing a child's record is the thing tenant
      // isolation exists to prevent. Health is counts and timestamps; if a
      // name or a phone number ever appears in it, that is the breach.
      const r = await asOperator(`/api/v1/platform/health?id=${tenantId}`);
      assert.equal(r.status, 200);
      const raw = JSON.stringify(r.body);
      assert.doesNotMatch(raw, /\+8801\d{9}/, 'a phone number reached the operator');
      // Every leaf is a number, a null, an ISO date, or a known error code —
      // never free text a school typed about a person.
      const walk = (v: unknown, path: string): void => {
        if (v === null || typeof v === 'number' || typeof v === 'boolean') return;
        if (typeof v === 'string') {
          assert.ok(
            /^\d{4}-\d{2}-\d{2}/.test(v) || /^[a-z0-9_.:-]+$/i.test(v),
            `${path} carries free text: ${v}`);
          return;
        }
        if (Array.isArray(v)) { v.forEach((x, i) => walk(x, `${path}[${i}]`)); return; }
        for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
          walk(x, `${path}.${k}`);
        }
      };
      walk(r.body, 'health');
    });

    test('the shape an operator reads is all present', async () => {
      const r = await asOperator(`/api/v1/platform/health?id=${tenantId}`);
      const b = r.body as Record<string, Record<string, unknown>>;
      for (const k of ['sms', 'push', 'usage']) {
        assert.ok(b[k], `health has no ${k}`);
      }
      for (const k of ['queuedNow', 'sent', 'delivered', 'failed',
                       'oldestQueuedMinutes']) {
        assert.ok(k in b.sms, `sms has no ${k}`);
      }
      for (const k of ['lastLoginAt', 'activeUsers7d', 'lastAttendanceOn']) {
        assert.ok(k in b.usage, `usage has no ${k}`);
      }
      assert.ok(Array.isArray(b.errors), 'errors must be a list, even when empty');
    });

    test('a school that has done NOTHING reports zeroes and nulls, not an error', async () => {
      // The state every newly provisioned school is in, and the one a
      // dashboard is most likely to render badly: no SMS, no logins, no
      // attendance. `null` is the honest answer to "when did they last sign
      // in"; 0 is the honest answer to "how many". Neither is an error, and
      // a screen that throws here is a screen an operator meets on day one.
      const fresh = await asOperator(`/api/v1/platform/health?id=${freshId}`);
      assert.equal(fresh.status, 200);
      const b = fresh.body as Record<string, Record<string, unknown>>;
      assert.equal(typeof b.sms.queuedNow, 'number');
      assert.equal(b.sms.oldestQueuedMinutes, null,
        'an empty queue has no oldest message — null, not 0');
      assert.ok(b.usage.lastLoginAt === null || typeof b.usage.lastLoginAt === 'string');
    });

    test('a queue that is not draining is visible as an AGE, not just a count', async () => {
      // "The failure that looks like nothing": ten thousand queued messages
      // and a stopped sender look identical to a count. The age of the
      // oldest queued message is what distinguishes them, which is why the
      // endpoint computes it.
      const r = await asOperator(`/api/v1/platform/health?id=${tenantId}`);
      const sms = (r.body as { sms: Record<string, unknown> }).sms;
      assert.ok('oldestQueuedMinutes' in sms);
      if (Number(sms.queuedNow) > 0) {
        assert.equal(typeof sms.oldestQueuedMinutes, 'number',
          'a non-empty queue must report how old its oldest message is');
      }
    });

    test('health needs both credentials, like everything else here', async () => {
      const noKey = await call(platform, {
        url: `/api/v1/platform/health?id=${tenantId}`, token: opToken });
      assert.equal(noKey.status, 403);
      const asSchool = await call(platform, {
        url: `/api/v1/platform/health?id=${tenantId}`, token: principalToken,
        headers: { 'x-platform-key': KEY },
      } as Parameters<typeof call>[1]);
      assert.equal(asSchool.status, 403);
    });

    test('a malformed or unknown id is refused before the database', async () => {
      const bad = await asOperator('/api/v1/platform/health?id=not-a-uuid');
      assert.equal(bad.status, 400);
      // A well-formed id for a school that does not exist must not 500. It is
      // the shape a stale bookmark has.
      const gone = await asOperator(
        '/api/v1/platform/health?id=00000000-0000-4000-8000-0000000000ee');
      assert.ok(gone.status === 200 || gone.status === 404,
        `a stale id answered ${gone.status}`);
    });
  });

  // ── P10-6 · institution identity ───────────────────────────────────────
  //
  // `tenants.name_bn` and friends were written once by the onboarding wizard
  // and by nothing else in the product. A school onboarded with a typo kept
  // it, on every document it printed.

  describe('institution identity', () => {
    let idA = '';
    let idB = '';
    /**
     * EIINs per RUN, not constants — for the same reason DEVICE above is.
     *
     * `tenants.eiin` is UNIQUE across the platform and this suite runs
     * against a database that keeps its rows. A fixed number collided with
     * the previous run's leftover, and the duplicate-EIIN refusal fired on
     * the test that was supposed to SET one. It looked like a flaky test and
     * was the constraint working correctly.
     */
    const EIIN_1 = String(200000 + Math.floor(Math.random() * 700000));
    const EIIN_2 = String(200000 + Math.floor(Math.random() * 700000));

    before(async () => {
      const a = await asOperator('/api/v1/platform/tenants', {
        nameBn: 'ভুল বানান বিদ্যালয়', nameEn: 'Typo School',
        slug: `p10-ident-a-${process.pid}`, stream: 'bangla_medium',
        level: 'secondary', planCode: 'pilot', studentCap: 100,
      });
      idA = (a.body as { tenant: { id: string } }).tenant?.id ?? '';
      const b = await asOperator('/api/v1/platform/tenants', {
        nameBn: 'দ্বিতীয় বিদ্যালয়', nameEn: 'Second School',
        slug: `p10-ident-b-${process.pid}`, stream: 'bangla_medium',
        level: 'secondary', planCode: 'pilot', studentCap: 100,
      });
      idB = (b.body as { tenant: { id: string } }).tenant?.id ?? '';
    });

    test('THE ONE THAT MATTERS — a typo can be corrected, and the audit says what moved', async () => {
      const r = await asOperator('/api/v1/platform/identity', {
        tenantId: idA, nameBn: 'সঠিক বানান বিদ্যালয়', nameEn: 'Correct School',
        eiin: EIIN_1, district: 'ঢাকা', upazila: 'ধানমন্ডি',
        addressBn: 'রোড ৫', reason: 'বানান ভুল ছিল',
      });
      assert.equal(r.status, 200);
      const t = (r.body as { tenant: Record<string, string> }).tenant;
      assert.equal(t.nameBn, 'সঠিক বানান বিদ্যালয়');
      assert.equal(t.eiin, EIIN_1);
      assert.equal(t.district, 'ঢাকা');

      // The audit names the FIELDS. "identity updated" tells a later reader
      // nothing, and this console's premise is that a dangerous act leaves a
      // record somebody can actually read.
      const audit = await asOperator(`/api/v1/platform/audit?id=${idA}`);
      const entries = (audit.body as { entries: Array<Record<string, string>> }).entries;
      const row = entries.find((e) => (e.statement ?? '').includes('update_tenant_identity'));
      assert.ok(row, 'the correction left no audit row');
      assert.match(row!.statement, /name_bn/);
      assert.match(row!.statement, /eiin/);
      assert.equal(row!.reason, 'বানান ভুল ছিল');
    });

    test('the slug is NOT editable through this path', async () => {
      // It is install-link infrastructure: people have already installed a
      // PWA that resolves through it. Changing it is a migration of
      // everyone's entry point, not a correction.
      const before = await asOperator(`/api/v1/platform/tenant?id=${idA}`);
      const slugBefore = (before.body as { tenant: { slug: string } }).tenant.slug;

      const r = await asOperator('/api/v1/platform/identity', {
        tenantId: idA, nameBn: 'সঠিক বানান বিদ্যালয়', nameEn: 'Correct School',
        slug: 'a-brand-new-slug', reason: 'চেষ্টা',
      });
      assert.equal(r.status, 200);

      const after = await asOperator(`/api/v1/platform/tenant?id=${idA}`);
      assert.equal((after.body as { tenant: { slug: string } }).tenant.slug, slugBefore,
        'the slug moved — installed apps would stop resolving');
    });

    test('a school cannot be left without a name', async () => {
      // Both are NOT NULL in the schema and both are on every printed
      // document. A blank is not an edit.
      for (const bad of [{ nameBn: '', nameEn: 'X' }, { nameBn: 'ক', nameEn: '   ' }]) {
        const r = await asOperator('/api/v1/platform/identity',
          { tenantId: idA, ...bad });
        assert.equal(r.status, 400, JSON.stringify(bad));
        assert.equal((r.body as { error: string }).error, 'name_required');
      }
    });

    test('an EIIN already in use is refused with a sentence, not a 500', async () => {
      const r = await asOperator('/api/v1/platform/identity', {
        tenantId: idB, nameBn: 'দ্বিতীয় বিদ্যালয়', nameEn: 'Second School',
        eiin: EIIN_1, reason: 'সংঘর্ষ',
      });
      assert.equal(r.status, 409);
      assert.equal((r.body as { error: string }).error, 'eiin_taken');
    });

    test('a non-numeric EIIN never reaches the database', async () => {
      const r = await asOperator('/api/v1/platform/identity', {
        tenantId: idB, nameBn: 'দ্বিতীয় বিদ্যালয়', nameEn: 'Second School',
        eiin: 'ABC-123',
      });
      assert.equal(r.status, 400);
      assert.equal((r.body as { error: string }).error, 'invalid_eiin');
    });

    test('saving with nothing changed writes no audit noise', async () => {
      const before = await asOperator(`/api/v1/platform/audit?id=${idB}`);
      const n = (before.body as { entries: unknown[] }).entries.length;
      await asOperator('/api/v1/platform/identity', {
        tenantId: idB, nameBn: 'দ্বিতীয় বিদ্যালয়', nameEn: 'Second School',
      });
      const after = await asOperator(`/api/v1/platform/audit?id=${idB}`);
      assert.equal((after.body as { entries: unknown[] }).entries.length, n,
        'pressing save twice is not an event');
    });

    test('a school cannot rename itself, and needs both credentials', async () => {
      const asSchool = await call(platform, {
        url: '/api/v1/platform/identity', method: 'POST',
        body: { tenantId: idA, nameBn: 'দখল', nameEn: 'Seized' },
        token: principalToken, headers: { 'x-platform-key': KEY },
      } as Parameters<typeof call>[1]);
      assert.equal(asSchool.status, 403);

      const noKey = await call(platform, {
        url: '/api/v1/platform/identity', method: 'POST',
        body: { tenantId: idA, nameBn: 'দখল', nameEn: 'Seized' },
        token: opToken,
      } as Parameters<typeof call>[1]);
      assert.equal(noKey.status, 403);
    });

    test('a partial save does not wipe what it did not mention', async () => {
      // The bug this pins, found by another test tripping over it: a save
      // that sent only the name cleared the EIIN, the district and the
      // address, because absent and blank were the same thing to the writer.
      // Silent data loss on a screen whose whole job is correcting data.
      await asOperator('/api/v1/platform/identity', {
        tenantId: idB, nameBn: 'দ্বিতীয় বিদ্যালয়', nameEn: 'Second School',
        eiin: EIIN_2, district: 'চট্টগ্রাম', addressBn: 'বন্দর রোড',
      });
      // Now save ONLY the name, as a narrower screen would.
      await asOperator('/api/v1/platform/identity', {
        tenantId: idB, nameBn: 'দ্বিতীয় বিদ্যালয় (সংশোধিত)', nameEn: 'Second School',
      });
      const after = await asOperator(`/api/v1/platform/tenant?id=${idB}`);
      const t = (after.body as { tenant: Record<string, string | null> }).tenant;
      assert.equal(t.nameBn, 'দ্বিতীয় বিদ্যালয় (সংশোধিত)', 'the name did change');
      assert.equal(t.eiin, EIIN_2, 'the EIIN survived a save that did not mention it');
      assert.equal(t.district, 'চট্টগ্রাম');
      assert.equal(t.addressBn, 'বন্দর রোড');

      // …and an EXPLICIT empty string still clears, because an operator must
      // be able to remove a wrong EIIN.
      await asOperator('/api/v1/platform/identity', {
        tenantId: idB, nameBn: 'দ্বিতীয় বিদ্যালয় (সংশোধিত)',
        nameEn: 'Second School', eiin: '',
      });
      const cleared = await asOperator(`/api/v1/platform/tenant?id=${idB}`);
      assert.equal(
        (cleared.body as { tenant: { eiin: string | null } }).tenant.eiin, null,
        'an explicit blank must still clear the field');
    });

    test('a malformed tenant id is refused before the database', async () => {
      const r = await asOperator('/api/v1/platform/identity',
        { tenantId: 'not-a-uuid', nameBn: 'ক', nameEn: 'K' });
      assert.equal(r.status, 400);
      assert.equal((r.body as { error: string }).error, 'invalid_id');
    });
  });
});
