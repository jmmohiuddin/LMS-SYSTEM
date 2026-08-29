/**
 * Tenant branding API — R-1, docs/11-MASTER-PLAN.md
 *
 * Two halves:
 *
 *   1. buildManifest() is pure and always runs, including in CI with no
 *      database. It decides what a school's INSTALLED app is called, which
 *      is the part of R-1 a reviewer cannot see by looking at a screen.
 *
 *   2. The endpoint tests need a real PostgreSQL, because the thing being
 *      asserted is that ROW-LEVEL SECURITY — not this code — is what stops
 *      one school reading or overwriting another's identity. A mock would
 *      assert the opposite of what matters: it would prove the handler
 *      behaves, while the guarantee lives in the policy underneath it.
 *
 *   DATABASE_URL=postgresql://shikhon_runtime:… node --test services/ops-svc/test/branding.test.ts
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { createDb, type Db, type TenantContext } from '../../../packages/server-core/src/db.ts';
import { installTestKeys, call } from '../../../packages/server-core/test/harness.ts';
import { buildManifest } from '../api/manifest.ts';
import { parseBranding, DEFAULT_BRANDING } from '../../../packages/ui-core/src/branding.ts';

const PNG_1PX =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

// ──────────────────────────────────────────────────────────────────────
//  Pure: the installed-app identity
// ──────────────────────────────────────────────────────────────────────
describe('buildManifest', () => {
  const A = parseBranding({
    nameBn: 'শাহজালাল আদর্শ উচ্চ বিদ্যালয়', nameEn: 'Shahjalal High',
    shortName: 'শাহজালাল', primaryColor: '#156a3f', logoUrl: PNG_1PX,
  });
  const B = parseBranding({
    nameBn: 'নর্থ সিটি মহিলা কলেজ', nameEn: 'North City College',
    shortName: 'নর্থ সিটি', primaryColor: '#1b3e7a',
  });

  test('installs as the institution, with its own colour', () => {
    const m = buildManifest(A, 'tenant-a');
    assert.equal(m.name, 'শাহজালাল আদর্শ উচ্চ বিদ্যালয়');
    assert.equal(m.short_name, 'শাহজালাল');
    assert.equal(m.theme_color, '#156a3f');
    assert.equal(m.display, 'standalone');
  });

  test('start_url carries the tenant, so a fresh install knows its school', () => {
    // An installed icon launches with no query string of its own. Without
    // this, an install done before first login opens a tenant-less app.
    //
    // The path is /app since R-1-A — "/" is the shikhonBD marketing site,
    // and a school installing its own app must land in the application.
    assert.equal(buildManifest(A, 'tenant-a').start_url, '/app?tid=tenant-a');
    assert.equal(buildManifest(A, null).start_url, '/app');
    assert.equal(buildManifest(A, 'tenant-a').scope, '/app');
  });

  test('uses the tenant icon when there is one, the platform icon otherwise', () => {
    const withIcon = buildManifest(A, 't') as { icons: { src: string }[] };
    assert.equal(withIcon.icons[0].src, PNG_1PX);

    const without = buildManifest(B, 't') as { icons: { src: string }[] };
    // Chrome refuses to offer installation with no usable icon, so a
    // school with a plain icon beats a school with no install.
    assert.equal(without.icons[0].src, '/icons/icon-192.png');
    assert.ok(without.icons.some((i) => i.src.endsWith('icon-512.png')));
  });

  test('THE ONE THAT MATTERS — installing A never yields B', () => {
    const a = JSON.stringify(buildManifest(A, 'tenant-a'));
    const b = JSON.stringify(buildManifest(B, 'tenant-b'));

    assert.match(a, /শাহজালাল/);
    assert.doesNotMatch(a, /নর্থ সিটি/);
    assert.match(b, /নর্থ সিটি/);
    assert.doesNotMatch(b, /শাহজালাল/);
    assert.doesNotMatch(b, /#156a3f/);
    assert.doesNotMatch(b, /tenant-a/);
  });

  test('an unconfigured tenant installs neutral, never as the platform', () => {
    const m = buildManifest(DEFAULT_BRANDING, null) as Record<string, string>;
    assert.doesNotMatch(JSON.stringify(m), /ShikhonBD/i);
    assert.doesNotMatch(JSON.stringify(m), /শিখন/);
  });
});

// ──────────────────────────────────────────────────────────────────────
//  Endpoint + RLS
// ──────────────────────────────────────────────────────────────────────
const DATABASE_URL = process.env.DATABASE_URL;
const skip = !DATABASE_URL ? 'DATABASE_URL not set' : false;

const T_A  = '7bc00000-0000-4000-8000-00000000000a';
const T_B  = '7bc00000-0000-4000-8000-00000000000b';
const HEAD_A    = '7bc00000-0000-4000-8000-0000000000a1';
const HEAD_B    = '7bc00000-0000-4000-8000-0000000000b1';
const TEACHER_A = '7bc00000-0000-4000-8000-0000000000a2';

let db: Db;
let branding: typeof import('../api/branding.ts').default;
let brand: typeof import('../api/brand.ts').default;
let headAToken: string;
let headBToken: string;
let teacherAToken: string;

const asA: TenantContext = { tenantId: T_A, userId: HEAD_A, role: 'principal' };
const asB: TenantContext = { tenantId: T_B, userId: HEAD_B, role: 'principal' };

const BRANDING_A = {
  nameBn: 'শাহজালাল আদর্শ উচ্চ বিদ্যালয়',
  nameEn: 'Shahjalal Adarsha High School',
  shortName: 'শাহজালাল',
  logoUrl: PNG_1PX,
  primaryColor: '#156a3f',
  accentColor: '#4e7a94',
  address: 'জিন্দাবাজার, সিলেট ৩১০০',
  phone: '+8801711000001',
  email: 'office@shahjalal.example.edu.bd',
  website: 'https://shahjalal.example.edu.bd',
  headmasterName: 'মোঃ আব্দুল কাদের',
};

const BRANDING_B = {
  nameBn: 'নর্থ সিটি মহিলা কলেজ',
  nameEn: 'North City College',
  shortName: 'নর্থ সিটি',
  primaryColor: '#1b3e7a',
  accentColor: '#a76a47',
  address: 'উত্তরা সেক্টর ৭, ঢাকা ১২৩০',
  phone: '+8801711000002',
  headmasterName: 'অধ্যাপক সালমা বেগম',
};

async function dropFixtures(): Promise<void> {
  for (const [ctx, id] of [[asA, T_A], [asB, T_B]] as const) {
    await db.withTenant(ctx, async (c) => {
      await c.query('DELETE FROM tenants WHERE id = $1', [id]);
    });
  }
}

describe('tenant branding endpoint (R-1)', { skip }, () => {
  before(async () => {
    await installTestKeys();
    db = createDb(DATABASE_URL as string);
    await dropFixtures();

    await db.withTenant(asA, async (c) => {
      await c.query(
        `INSERT INTO tenants (id, slug, name_bn, name_en, stream, level)
         VALUES ($1,'r1-school-a','শাহজালাল','Shahjalal','bangla_medium','secondary')`, [T_A]);
      await c.query(
        `INSERT INTO users (id, tenant_id, full_name_bn, full_name_en, phone_e164, status) VALUES
           ($1,$3,'অধ্যক্ষ ক','Head A','+8801799600001','active'),
           ($2,$3,'শিক্ষক ক','Teacher A','+8801799600003','active')`,
        [HEAD_A, TEACHER_A, T_A]);
    });
    await db.withTenant(asB, async (c) => {
      await c.query(
        `INSERT INTO tenants (id, slug, name_bn, name_en, stream, level)
         VALUES ($1,'r1-college-b','নর্থ সিটি','North City','bangla_medium','college')`, [T_B]);
      await c.query(
        `INSERT INTO users (id, tenant_id, full_name_bn, full_name_en, phone_e164, status)
         VALUES ($1,$2,'অধ্যক্ষ খ','Head B','+8801799600002','active')`, [HEAD_B, T_B]);
    });

    const { signAccessToken } = await import('../../../packages/server-core/src/jwt.ts');
    headAToken = await signAccessToken({
      sub: HEAD_A, tid: T_A, role: 'principal', roles: ['principal'] });
    headBToken = await signAccessToken({
      sub: HEAD_B, tid: T_B, role: 'principal', roles: ['principal'] });
    teacherAToken = await signAccessToken({
      sub: TEACHER_A, tid: T_A, role: 'class_teacher', roles: ['class_teacher'] });

    branding = (await import('../api/branding.ts')).default;
    brand = (await import('../api/brand.ts')).default;
  });

  after(async () => { if (db) { await dropFixtures(); await db.end(); } });

  const get = (token: string) =>
    call(branding, { method: 'GET', url: '/api/v1/ops/branding', token });
  const put = (token: string, body: unknown) =>
    call(branding, { method: 'PUT', url: '/api/v1/ops/branding', token, body });

  test('a school saves its identity and reads it back', async () => {
    const saved = await put(headAToken, { branding: BRANDING_A });
    assert.equal(saved.status, 200);

    const read = await get(headAToken);
    assert.equal(read.status, 200);
    const b = (read.body as { branding: Record<string, string> }).branding;
    assert.equal(b.nameBn, BRANDING_A.nameBn);
    assert.equal(b.primaryColor, '#156a3f');
    assert.equal(b.address, BRANDING_A.address);
    assert.equal(b.headmasterName, BRANDING_A.headmasterName);
  });

  test('THE ONE THAT MATTERS — B reads B, never A', async () => {
    await put(headBToken, { branding: BRANDING_B });

    const readB = await get(headBToken);
    const b = (readB.body as { branding: Record<string, string> }).branding;
    assert.equal(b.nameBn, BRANDING_B.nameBn);
    assert.equal(b.primaryColor, '#1b3e7a');

    // Nothing of A's may appear in B's payload — not the name, not the
    // colour, not the address, not the logo.
    const asText = JSON.stringify(readB.body);
    assert.doesNotMatch(asText, /শাহজালাল/);
    assert.doesNotMatch(asText, /#156a3f/);
    assert.doesNotMatch(asText, /জিন্দাবাজার/);
    assert.doesNotMatch(asText, /আব্দুল কাদের/);

    // …and A is unchanged by B having written.
    const readA = await get(headAToken);
    assert.equal((readA.body as { branding: Record<string, string> }).branding.nameBn,
      BRANDING_A.nameBn);
  });

  test('B cannot overwrite A, even naming A in the payload', async () => {
    // There is no tenant id in the URL or the body by design, so the only
    // tenant a caller can name is the one they authenticated as. This
    // asserts the consequence: a hostile write lands on the writer's own
    // row or nowhere.
    await put(headBToken, {
      branding: { ...BRANDING_B, nameBn: 'দখল করা নাম' },
      tenantId: T_A,
      organization_id: T_A,
    });

    const readA = await get(headAToken);
    const a = (readA.body as { branding: Record<string, string> }).branding;
    assert.equal(a.nameBn, BRANDING_A.nameBn, 'tenant A was overwritten by tenant B');

    // The write did land — on B's own row, which is the correct outcome.
    const readB = await get(headBToken);
    assert.equal((readB.body as { branding: Record<string, string> }).branding.nameBn,
      'দখল করা নাম');
    // Put B back for later tests.
    await put(headBToken, { branding: BRANDING_B });
  });

  test('the database, not the handler, is what confines the write', async () => {
    // Prove the claim directly: with tenant A's session context, an UPDATE
    // that explicitly targets tenant B matches zero rows because the
    // tenant_self policy has already narrowed the table.
    const affected = await db.withTenant(asA, async (c) => {
      const r = await c.query(
        `UPDATE tenants SET settings = settings || '{"branding":{"nameBn":"ভুয়া"}}'::jsonb
          WHERE id = $1`, [T_B]);
      return r.rowCount;
    });
    assert.equal(affected, 0, 'RLS did not confine a cross-tenant UPDATE');

    const readB = await get(headBToken);
    assert.equal((readB.body as { branding: Record<string, string> }).branding.nameBn,
      BRANDING_B.nameBn);
  });

  test('a teacher may read the letterhead but not repaint the school', async () => {
    const read = await get(teacherAToken);
    assert.equal(read.status, 200, 'staff need the letterhead for printed documents');

    const write = await put(teacherAToken, { branding: { ...BRANDING_A, nameBn: 'পরিবর্তিত' } });
    assert.equal(write.status, 403);

    const after = await get(headAToken);
    assert.equal((after.body as { branding: Record<string, string> }).branding.nameBn,
      BRANDING_A.nameBn);
  });

  test('an unauthenticated caller gets nothing from the private endpoint', async () => {
    const read = await call(branding, { method: 'GET', url: '/api/v1/ops/branding' });
    assert.equal(read.status, 401);
  });

  test('invalid values are refused with the field that caused it', async () => {
    const r = await put(headAToken, {
      branding: { ...BRANDING_A, primaryColor: 'red; background:url(//evil)' },
    });
    assert.equal(r.status, 400);
    const b = r.body as { error: string; field: string };
    assert.equal(b.error, 'invalid_branding');
    // The field name is what lets the editor place the message beside the
    // input rather than at the top of the form.
    assert.equal(b.field, 'primaryColor');
  });

  test('a partial update leaves the untouched fields alone', async () => {
    await put(headAToken, { branding: { primaryColor: '#7a1b3e' } });
    const read = await get(headAToken);
    const b = (read.body as { branding: Record<string, string> }).branding;
    assert.equal(b.primaryColor, '#7a1b3e');
    assert.equal(b.address, BRANDING_A.address, 'a colour change wiped the address');
    assert.equal(b.logoUrl, PNG_1PX, 'a colour change wiped the logo');
    await put(headAToken, { branding: BRANDING_A });
  });

  describe('pre-auth /ops/brand', () => {
    const fetchBrand = (key: string) =>
      call(brand, { method: 'GET', url: `/api/v1/ops/brand?slug=${encodeURIComponent(key)}` });

    test('serves the login screen its school, with no session at all', async () => {
      const r = await fetchBrand('r1-school-a');
      assert.equal(r.status, 200);
      const body = r.body as { tenantId: string; branding: Record<string, string> };
      assert.equal(body.tenantId, T_A);
      assert.equal(body.branding.nameBn, BRANDING_A.nameBn);
      assert.equal(body.branding.primaryColor, '#156a3f');
    });

    test('THE ONE THAT MATTERS — it leaks nothing beyond the signboard', async () => {
      const r = await fetchBrand('r1-school-a');
      const text = JSON.stringify(r.body);
      // Contact details and document assets stay behind authentication: a
      // directory of every school's phone and address is a scrape.
      for (const [field, value] of [
        ['address', BRANDING_A.address],
        ['phone', BRANDING_A.phone],
        ['email', BRANDING_A.email],
        ['headmasterName', BRANDING_A.headmasterName],
      ] as const) {
        assert.doesNotMatch(text, new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
          `${field} leaked to an unauthenticated caller`);
      }
      const b = (r.body as { branding: Record<string, unknown> }).branding;
      assert.deepEqual(Object.keys(b).sort(), [
        'accentColor', 'faviconUrl', 'logoUrl', 'nameBn', 'nameEn', 'primaryColor', 'shortName',
      ]);
    });

    test('answers by tenant id too — the install link carries the id', async () => {
      const r = await call(brand, { method: 'GET', url: `/api/v1/ops/brand?tid=${T_A}` });
      assert.equal((r.body as { tenantId: string }).tenantId, T_A);
    });

    test('an unknown school is neutral, not a 404 existence oracle', async () => {
      const r = await fetchBrand('no-such-school-at-all');
      assert.equal(r.status, 200);
      const body = r.body as { tenantId: string | null; branding: Record<string, string> };
      assert.equal(body.tenantId, null);
      assert.equal(body.branding.nameBn, DEFAULT_BRANDING.nameBn);
    });

    test('a malformed key is refused the same way, and never reaches SQL', async () => {
      for (const bad of ["' OR 1=1 --", '../../etc', 'a', '']) {
        const r = await call(brand, {
          method: 'GET', url: `/api/v1/ops/brand?slug=${encodeURIComponent(bad)}`,
        });
        assert.equal(r.status, 200);
        assert.equal((r.body as { tenantId: string | null }).tenantId, null);
      }
    });

    test('two schools get two different pre-auth identities', async () => {
      const a = JSON.stringify((await fetchBrand('r1-school-a')).body);
      const b = JSON.stringify((await fetchBrand('r1-college-b')).body);
      assert.match(a, /শাহজালাল/);
      assert.doesNotMatch(a, /নর্থ সিটি/);
      assert.match(b, /নর্থ সিটি/);
      assert.doesNotMatch(b, /শাহজালাল/);
    });
  });
});
