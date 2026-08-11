/**
 * Fallback activation — F-202
 *
 * The path that keeps a pilot from being hostage to an SMS aggregator
 * negotiation. What this suite holds still:
 *
 *   • WHO may issue for WHOM is the RLS policy's decision — a class
 *     teacher activates their own students and nobody else's;
 *   • the plaintext code exists exactly once, in the issue response —
 *     never in the database;
 *   • a code is single-use, expiring, and dies when replaced;
 *   • redemption mints the SAME session shape as OTP verification;
 *   • without its pepper the whole endpoint fails closed.
 *
 *   DATABASE_URL=postgresql://shikhon_runtime:… node --test services/identity-svc/test/activate.test.ts
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { createDb, type Db, type TenantContext } from '../../../packages/server-core/src/db.ts';
import { installTestKeys, call } from '../../../packages/server-core/test/harness.ts';

const DATABASE_URL = process.env.DATABASE_URL;
const skip = !DATABASE_URL ? 'DATABASE_URL not set' : false;

const T        = '7ad00000-0000-4000-8000-00000000000a';
const HEAD     = '7ad00000-0000-4000-8000-0000000000ff';
const TEACHER  = '7ad00000-0000-4000-8000-0000000000a1';   // class teacher of ক
const ANIKA    = '7ad00000-0000-4000-8000-0000000000b1';   // in ক
const BIJOY    = '7ad00000-0000-4000-8000-0000000000b2';   // in খ — NOT the teacher's
const YEAR     = '7ad00000-0000-4000-8000-000000000091';
const CLASS9   = '7ad00000-0000-4000-8000-0000000000c9';
const SEC_KA   = '7ad00000-0000-4000-8000-0000000000d1';
const SEC_KHA  = '7ad00000-0000-4000-8000-0000000000d2';

let db: Db;
let headToken: string;
let teacherToken: string;
let studentToken: string;
let activate: typeof import('../api/activate.ts').default;
const asHead: TenantContext = { tenantId: T, userId: HEAD, role: 'principal' };

async function dropFixtures(): Promise<void> {
  await db.withTenant(asHead, async (c) => {
    await c.query('DELETE FROM tenants WHERE id = $1', [T]);
  });
}

describe('fallback activation (F-202)', { skip }, () => {
  before(async () => {
    await installTestKeys();
    process.env.ACTIVATION_PEPPER = 'test-pepper-32-bytes-of-entropy!';
    db = createDb(DATABASE_URL as string);
    await dropFixtures();
    await db.withTenant(asHead, async (c) => {
      await c.query(
        `INSERT INTO tenants (id, slug, name_bn, name_en, stream, level)
         VALUES ($1,'f202','সক্রিয়ন','Activation','bangla_medium','secondary')`, [T]);
      await c.query(
        `INSERT INTO users (id, tenant_id, full_name_bn, full_name_en, phone_e164, status) VALUES
           ($1,$5,'প্রধান শিক্ষক','Head','+8801799600001','active'),
           ($2,$5,'শ্রেণি শিক্ষক','Teacher','+8801799600002','active'),
           ($3,$5,'আনিকা','Anika',NULL,'invited'),
           ($4,$5,'বিজয়','Bijoy',NULL,'invited')`,
        [HEAD, TEACHER, ANIKA, BIJOY, T]);
      await c.query(
        `INSERT INTO academic_years (id, tenant_id, label, starts_on, ends_on, is_current)
         VALUES ($1,$2,'2026','2026-01-01','2026-12-31',true)`, [YEAR, T]);
      await c.query(
        `INSERT INTO classes (id, tenant_id, level_no, name_bn, name_en, stream)
         VALUES ($1,$2,9,'নবম','Nine','bangla_medium')`, [CLASS9, T]);
      // The teacher holds ক; বিজয় is in খ, which is the whole point.
      await c.query(
        `INSERT INTO sections (id, tenant_id, class_id, academic_year_id, name, class_teacher_id) VALUES
           ($1,$3,$4,$5,'ক',$6), ($2,$3,$4,$5,'খ',NULL)`,
        [SEC_KA, SEC_KHA, T, CLASS9, YEAR, TEACHER]);
      await c.query(
        `INSERT INTO enrolments (tenant_id, student_id, section_id, academic_year_id, roll_no, status) VALUES
           ($1,$2,$4,$6,1,'active'), ($1,$3,$5,$6,1,'active')`,
        [T, ANIKA, BIJOY, SEC_KA, SEC_KHA, YEAR]);
      await c.query(
        `INSERT INTO user_roles (tenant_id, user_id, role_code) VALUES
           ($1,$2,'student'), ($1,$3,'student')`, [T, ANIKA, BIJOY]);
      // Migration 031: a student with no phone must have a contactable
      // guardian, checked at COMMIT — which is also how these students
      // would really exist, since the importer writes the guardianship in
      // the same transaction.
      await c.query(
        `INSERT INTO guardianships (tenant_id, student_id, guardian_id, relation, is_primary) VALUES
           ($1,$2,$4,'legal_guardian',true), ($1,$3,$4,'legal_guardian',true)`,
        [T, ANIKA, BIJOY, HEAD]);
    });
    const { signAccessToken } = await import('../../../packages/server-core/src/jwt.ts');
    headToken = await signAccessToken({
      sub: HEAD, tid: T, role: 'academic_coordinator', roles: ['academic_coordinator'] });
    teacherToken = await signAccessToken({
      sub: TEACHER, tid: T, role: 'class_teacher', roles: ['class_teacher'] });
    studentToken = await signAccessToken({
      sub: ANIKA, tid: T, role: 'student', roles: ['student'] });
    activate = (await import('../api/activate.ts')).default;
  });
  after(async () => { if (db) { await dropFixtures(); await db.end(); } });

  const post = (body: Record<string, unknown>, token?: string) =>
    call(activate, { method: 'POST', url: '/api/v1/auth/activate', token, body });

  const issue = async (userId: string, token = headToken): Promise<string> => {
    const r = await post({ action: 'issue', userId }, token);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return (r.body as { code: string }).code;
  };

  test('THE ONE THAT MATTERS — issue, hand over, redeem, and you are signed in', async () => {
    const code = await issue(ANIKA);
    // Readable across a classroom: no 0/O, no 1/I/L.
    assert.match(code, /^[A-HJKMNP-Z2-8]{8}$/);

    const r = await post({ action: 'redeem', tenantId: T, code, deviceId: randomUUID() });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const b = r.body as {
      accessToken: string; refreshToken: string;
      user: { id: string; role: string; fullNameBn: string };
    };
    // The same session shape OTP verification mints — one session model,
    // whichever door was used.
    assert.ok(b.accessToken.split('.').length === 3, 'a real JWT');
    assert.ok(b.refreshToken.length >= 32);
    assert.equal(b.user.id, ANIKA);
    assert.equal(b.user.role, 'student');

    // Activation is the moment 'invited' becomes real.
    await db.withTenant(asHead, async (c) => {
      const s = await c.query<{ status: string }>(
        'SELECT status FROM users WHERE id = $1', [ANIKA]);
      assert.equal(s.rows[0].status, 'active');
    });
  });

  test('the plaintext code exists exactly once — never in the database', async () => {
    const code = await issue(BIJOY);
    await db.withTenant(asHead, async (c) => {
      const rows = await c.query<Record<string, unknown>>(
        `SELECT id, encode(code_hash, 'hex') AS h, user_id, issued_by
           FROM activation_codes WHERE user_id = $1`, [BIJOY]);
      const dump = JSON.stringify(rows.rows);
      assert.ok(!dump.includes(code),
        'a stored plaintext would make every DB read a credential leak');
    });
  });

  test('a class teacher activates their OWN students and nobody else\'s', async () => {
    // ক is theirs.
    const own = await post({ action: 'issue', userId: ANIKA }, teacherToken);
    assert.equal(own.status, 200, JSON.stringify(own.body));

    // খ is not — and the refusal comes from the RLS policy, not from this
    // endpoint remembering to check.
    const other = await post({ action: 'issue', userId: BIJOY }, teacherToken);
    assert.equal(other.status, 403);
    assert.equal((other.body as { error: string }).error, 'not_your_student');
  });

  test('a student cannot issue codes at all', async () => {
    const r = await post({ action: 'issue', userId: BIJOY }, studentToken);
    assert.equal(r.status, 403);
  });

  test('a code is single-use — the second redemption fails', async () => {
    const code = await issue(ANIKA);
    const first = await post({ action: 'redeem', tenantId: T, code, deviceId: randomUUID() });
    assert.equal(first.status, 200);
    const second = await post({ action: 'redeem', tenantId: T, code, deviceId: randomUUID() });
    assert.equal(second.status, 400);
    assert.equal((second.body as { error: string }).error, 'invalid_code');
  });

  test('re-issuing kills the code still out on paper', async () => {
    const monday = await issue(ANIKA);
    const tuesday = await issue(ANIKA);
    // The slip lost on Monday is dead the moment Tuesday's replacement is
    // printed.
    const stale = await post({ action: 'redeem', tenantId: T, code: monday, deviceId: randomUUID() });
    assert.equal(stale.status, 400);
    const fresh = await post({ action: 'redeem', tenantId: T, code: tuesday, deviceId: randomUUID() });
    assert.equal(fresh.status, 200);
  });

  test('an expired code fails with the SAME error as a wrong one', async () => {
    const code = await issue(ANIKA);
    await db.withTenant(asHead, async (c) => {
      await c.query(
        // Age the whole row: the CHECK requires expires_at > created_at,
        // so an expired code is an OLD code, not one that expired before
        // it was born.
        `UPDATE activation_codes
            SET created_at = now() - interval '80 hours',
                expires_at = now() - interval '8 hours'
          WHERE user_id = $1 AND used_at IS NULL AND revoked_at IS NULL`, [ANIKA]);
    });
    const r = await post({ action: 'redeem', tenantId: T, code, deviceId: randomUUID() });
    assert.equal(r.status, 400);
    // "expired" would tell a guesser they found a real code; "incorrect"
    // tells them nothing.
    assert.equal((r.body as { error: string }).error, 'invalid_code');
    assert.match((r.body as { message: string }).message, /incorrect or expired/);
  });

  test('a wrong code is a clean 400, not a hint', async () => {
    const r = await post({ action: 'redeem', tenantId: T, code: 'WRONGCOD', deviceId: randomUUID() });
    assert.equal(r.status, 400);
    assert.equal((r.body as { error: string }).error, 'invalid_code');
  });

  test('guessing from one device runs into the identity rate limit', async () => {
    const deviceId = randomUUID();
    let limited = false;
    for (let i = 0; i < 12; i++) {
      const r = await post({ action: 'redeem', tenantId: T, code: 'AAAABBB2', deviceId });
      if (r.status === 429) { limited = true; break; }
    }
    assert.ok(limited, 'the otp_verify identity bucket caps per-device guessing');
  });

  test('without its pepper the endpoint fails closed, loudly', async () => {
    const saved = process.env.ACTIVATION_PEPPER;
    delete process.env.ACTIVATION_PEPPER;
    try {
      const r = await post({ action: 'issue', userId: ANIKA }, headToken);
      assert.equal(r.status, 503);
      assert.equal((r.body as { error: string }).error, 'activation_unconfigured');
    } finally {
      process.env.ACTIVATION_PEPPER = saved;
    }
  });
});
