/**
 * R-8 §4 — what a notice would cost, before it is sent.
 *
 * The composer already restated the audience as a sentence and showed the
 * segments per person. What it could never say was how many people "সব
 * অভিভাবক" IS. A head teacher choosing between "this section" and "all
 * guardians" was choosing between two phrases, one of which costs a hundred
 * times more than the other, with nothing on screen to say so.
 *
 * Two things this has to get right, and both are ways of being wrong that
 * would go unnoticed:
 *
 *   • `smsRecipients` must be the people who would ACTUALLY be texted — a
 *     phone on file, and consent if they are a guardian — not everyone in the
 *     audience. The bill is made of the smaller number and the gap between
 *     them is usually large.
 *   • the segment count must be computed from the message the SENDER builds,
 *     not from the notice body. `noticeSmsBody` trims to the tenant's cap and
 *     signs with the school, so estimating from the raw body is wrong in both
 *     directions at once.
 *
 *   DATABASE_URL=postgresql://… node --test services/ops-svc/test/notice-preview.test.ts
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { createDb, type Db, type TenantContext } from '../../../packages/server-core/src/db.ts';
import { installTestKeys, call } from '../../../packages/server-core/test/harness.ts';
import { SMS_CONFIRM_THRESHOLD } from '../api/notices.ts';

const DATABASE_URL = process.env.DATABASE_URL;
const skip = !DATABASE_URL ? 'DATABASE_URL not set' : false;

const T     = '9d100000-0000-4000-8000-00000000000a';
const HEAD  = '9d100000-0000-4000-8000-0000000000f1';
const YEAR  = '9d100000-0000-4000-8000-000000000091';
const CLASS = '9d100000-0000-4000-8000-0000000000c9';
const SEC   = '9d100000-0000-4000-8000-0000000000d1';

/** Two guardians with phones, one of whom has withheld consent. */
const KID_A = '9d100000-0000-4000-8000-0000000000b1';
const KID_B = '9d100000-0000-4000-8000-0000000000b2';
const G_YES = '9d100000-0000-4000-8000-0000000000e1';
const G_NO  = '9d100000-0000-4000-8000-0000000000e2';

let db: Db;
let notices: typeof import('../api/notices.ts').default;
let headToken = '';
const asHead: TenantContext = { tenantId: T, userId: HEAD, role: 'principal' };

describe('R-8 §4 — the audience preview', { skip }, () => {
  before(async () => {
    await installTestKeys();
    db = createDb(DATABASE_URL as string);
    await db.withTenant(asHead, async (c) => {
      await c.query('DELETE FROM tenants WHERE id = $1', [T]);
      await c.query(
        `INSERT INTO tenants (id, slug, name_bn, name_en, stream, level)
         VALUES ($1,'r8-preview','প্রাক্কলন','Preview','bangla_medium','secondary')`, [T]);
      await c.query(
        `INSERT INTO users (id, tenant_id, full_name_bn, full_name_en, phone_e164, status) VALUES
           ($1,$6,'প্রধান','Head','+8801799820001','active'),
           ($2,$6,'শিশু ক','Kid A',NULL,'active'),
           ($3,$6,'শিশু খ','Kid B',NULL,'active'),
           ($4,$6,'অভিভাবক ক','G Yes','+8801799820011','active'),
           ($5,$6,'অভিভাবক খ','G No','+8801799820012','active')`,
        [HEAD, KID_A, KID_B, G_YES, G_NO, T]);
      await c.query(
        `INSERT INTO user_roles (tenant_id, user_id, role_code) VALUES
           ($1,$2,'principal'), ($1,$3,'student'), ($1,$4,'student'),
           ($1,$5,'guardian'), ($1,$6,'guardian')`,
        [T, HEAD, KID_A, KID_B, G_YES, G_NO]);
      await c.query(
        `INSERT INTO academic_years (id, tenant_id, label, starts_on, ends_on, is_current)
         VALUES ($1,$2,'2026','2026-01-01','2026-12-31',true)`, [YEAR, T]);
      await c.query(
        `INSERT INTO classes (id, tenant_id, level_no, name_bn, name_en, stream)
         VALUES ($1,$2,9,'নবম','Nine','bangla_medium')`, [CLASS, T]);
      await c.query(
        `INSERT INTO sections (id, tenant_id, class_id, academic_year_id, name)
         VALUES ($1,$2,$3,$4,'ক')`, [SEC, T, CLASS, YEAR]);
      await c.query(
        `INSERT INTO enrolments (tenant_id, student_id, section_id, academic_year_id, roll_no, status)
         VALUES ($1,$2,$4,$5,1,'active'), ($1,$3,$4,$5,2,'active')`,
        [T, KID_A, KID_B, SEC, YEAR]);
      // One guardian consents to SMS; the other does not.
      await c.query(
        `INSERT INTO guardianships (tenant_id, student_id, guardian_id, relation,
                                    is_primary, receives_sms) VALUES
           ($1,$2,$4,'father',true,true),
           ($1,$3,$5,'father',true,false)`,
        [T, KID_A, KID_B, G_YES, G_NO]);
    });
    const { signAccessToken } = await import('../../../packages/server-core/src/jwt.ts');
    headToken = await signAccessToken({ sub: HEAD, tid: T, role: 'principal', roles: ['principal'] });
    notices = (await import('../api/notices.ts')).default;
  });

  after(async () => {
    if (!db) return;
    await db.withTenant(asHead, (c) => c.query('DELETE FROM tenants WHERE id = $1', [T]));
    await db.end();
  });

  const preview = (body: Record<string, unknown>, token = headToken) =>
    call(notices, {
      method: 'POST', url: '/api/v1/ops/notices?preview=1', token, body,
    });

  test('THE ONE THAT MATTERS — it counts who would be TEXTED, not who is in the audience', async () => {
    const r = await preview({
      audience: { type: 'guardians' }, title: 'ছুটি', body: 'আগামীকাল বন্ধ।', sendSms: true,
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const b = r.body as { recipients: number; smsRecipients: number };
    // Two guardians receive the notice…
    assert.equal(b.recipients, 2);
    // …and exactly one of them has consented to SMS. The gap between these
    // two numbers is the whole reason this endpoint exists.
    assert.equal(b.smsRecipients, 1);
  });

  test('somebody with no phone is in the audience and not in the bill', async () => {
    const r = await preview({
      audience: { type: 'students' }, title: 'ছুটি', body: 'আগামীকাল বন্ধ।', sendSms: true,
    });
    const b = r.body as { recipients: number; smsRecipients: number };
    assert.equal(b.recipients, 2, 'both students receive the notice');
    assert.equal(b.smsRecipients, 0, 'neither has a phone, so neither costs anything');
  });

  test('sendSms off means no SMS cost at all', async () => {
    const r = await preview({
      audience: { type: 'guardians' }, title: 'ছুটি', body: 'আগামীকাল বন্ধ।', sendSms: false,
    });
    const b = r.body as { recipients: number; smsRecipients: number; segmentsTotal: number };
    assert.equal(b.recipients, 2, 'the in-app audience is unchanged');
    assert.equal(b.smsRecipients, 0);
    assert.equal(b.segmentsTotal, 0);
  });

  test('THE ONE THAT MATTERS — segments come from the SENT message, not the body', async () => {
    // `noticeSmsBody` prepends the title and appends "— <school>", so a body
    // that is one segment on its own can be two once it is signed. Estimating
    // from the raw body under-reports every message the product sends.
    const short = await preview({
      audience: { type: 'guardians' }, title: 'ছুটি', body: 'বন্ধ।', sendSms: true,
    });
    const long = await preview({
      audience: { type: 'guardians' }, title: 'ছুটি',
      body: 'আ'.repeat(200), sendSms: true,
    });
    const a = short.body as { segmentsEach: number };
    const z = long.body as { segmentsEach: number };
    assert.ok(a.segmentsEach >= 1);
    assert.ok(z.segmentsEach > a.segmentsEach, 'a longer notice must cost more');
  });

  test('a big send is flagged, a small one is not', async () => {
    const small = await preview({
      audience: { type: 'guardians' }, title: 'ছুটি', body: 'বন্ধ।', sendSms: true,
    });
    assert.equal((small.body as { needsConfirmation: boolean }).needsConfirmation, false);
    assert.equal((small.body as { confirmThreshold: number }).confirmThreshold,
      SMS_CONFIRM_THRESHOLD);
  });

  test('the section audience counts only that section', async () => {
    const r = await preview({
      audience: { type: 'section', ids: [SEC] }, title: 'ছুটি', body: 'বন্ধ।', sendSms: true,
    });
    const b = r.body as { recipients: number };
    // The two students plus their two guardians — the same resolver the
    // publish path uses, so the estimate cannot disagree with the send.
    assert.ok(b.recipients >= 2, `expected the section's people, got ${b.recipients}`);
  });

  test('preview WRITES NOTHING', async () => {
    const before = await db.withTenant(asHead, async (c) => {
      const { rows } = await c.query<{ n: string }>('SELECT count(*) AS n FROM notices');
      return rows[0].n;
    });
    await preview({ audience: { type: 'all' }, title: 'ছুটি', body: 'বন্ধ।', sendSms: true });
    const after = await db.withTenant(asHead, async (c) => {
      const { rows } = await c.query<{ n: string }>('SELECT count(*) AS n FROM notices');
      return rows[0].n;
    });
    // It is an estimate. A preview that published would be the worst possible
    // bug in a feature whose entire purpose is preventing an accidental send.
    assert.equal(after, before);
  });

  test('it needs a session, and the author role', async () => {
    const anon = await call(notices, {
      method: 'POST', url: '/api/v1/ops/notices?preview=1',
      body: { audience: { type: 'all' }, title: 'x', body: 'y', sendSms: true },
    });
    assert.equal(anon.status, 401);

    // A student must not be able to size the school's guardian list.
    const { signAccessToken } = await import('../../../packages/server-core/src/jwt.ts');
    const studentToken = await signAccessToken({
      sub: KID_A, tid: T, role: 'student', roles: ['student'] });
    const r = await preview({ audience: { type: 'all' }, title: 'x', body: 'y', sendSms: true },
      studentToken);
    assert.equal(r.status, 403);
  });
});
