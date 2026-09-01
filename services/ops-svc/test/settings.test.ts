/**
 * /api/v1/ops/settings — the school's operational settings.
 *
 * Written in R-9, for a bug that had been shipping since R-3.
 *
 * The endpoint wrote its values with
 * `jsonb_set(settings, '{sms,noticeMaxChars}', …, true)`, and `create_missing`
 * creates the LAST element of a path, never the object that would contain it:
 *
 *     jsonb_set('{}', '{sms,noticeMaxChars}', '180', true)  →  {}
 *
 * So on any school whose `settings` had never held an `sms` object — every
 * freshly provisioned one — the PUT returned 200, the screen said সংরক্ষিত,
 * and nothing was written. The next visit showed the default, which reads like
 * somebody undoing the change rather than like a defect.
 *
 * It survived because there was no test file for this endpoint at all. R-9
 * found it within a minute of adding a second key, because `push` is a key
 * that never pre-exists, so it failed on the first save every time.
 *
 * Hence the shape of this suite: it starts from EMPTY settings, and it checks
 * the database rather than the response — a response can echo a value that was
 * never stored, which is precisely what was happening.
 *
 *   DATABASE_URL=postgresql://… node --test services/ops-svc/test/settings.test.ts
 */
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { createDb, type Db, type TenantContext } from '../../../packages/server-core/src/db.ts';
import { installTestKeys, call, lockFixtures, unlockFixtures} from '../../../packages/server-core/test/harness.ts';
import { generateVapidKeys } from '../../../packages/server-core/src/web-push.ts';

const DATABASE_URL = process.env.DATABASE_URL;
const skip = !DATABASE_URL ? 'DATABASE_URL not set' : false;

const T     = '9cc00000-0000-4000-8000-00000000000a';
const HEAD  = '9cc00000-0000-4000-8000-0000000000a1';
const TEACH = '9cc00000-0000-4000-8000-0000000000a2';

let db: Db;
let settings: typeof import('../api/settings.ts').default;
let headToken = '';
let teacherToken = '';
const asHead: TenantContext = { tenantId: T, userId: HEAD, role: 'principal' };

/** What is ACTUALLY in the column — not what the response claimed. */
async function stored(): Promise<Record<string, unknown>> {
  return db.withTenant(asHead, async (c) => {
    const { rows } = await c.query<{ settings: Record<string, unknown> }>(
      `SELECT COALESCE(settings, '{}'::jsonb) AS settings FROM tenants WHERE id = $1`, [T]);
    return rows[0]?.settings ?? {};
  });
}

describe('ops/settings', { skip }, () => {
  before(async () => {
    await installTestKeys();
    const vapid = generateVapidKeys();
    process.env.VAPID_PUBLIC_KEY = vapid.publicKey;
    process.env.VAPID_PRIVATE_KEY = vapid.privateKey;

    // Serialised against other runs of this same suite — the fixtures below

    // live at fixed uuids and two processes would delete each other's.

    await lockFixtures(DATABASE_URL as string);

    db = createDb(DATABASE_URL as string);
    await db.withTenant(asHead, async (c) => {
      await c.query('DELETE FROM tenants WHERE id = $1', [T]);
      await c.query(
        `INSERT INTO tenants (id, slug, name_bn, name_en, stream, level)
         VALUES ($1,'r9-settings','সেটিংস','Settings','bangla_medium','secondary')`, [T]);
      await c.query(
        `INSERT INTO users (id, tenant_id, full_name_bn, full_name_en, phone_e164, status) VALUES
           ($1,$3,'প্রধান','Head','+8801799730001','active'),
           ($2,$3,'শিক্ষক','Teacher','+8801799730002','active')`, [HEAD, TEACH, T]);
      await c.query(
        `INSERT INTO user_roles (tenant_id, user_id, role_code) VALUES
           ($1,$2,'principal'), ($1,$3,'class_teacher')`, [T, HEAD, TEACH]);
    });
    const { signAccessToken } = await import('../../../packages/server-core/src/jwt.ts');
    headToken = await signAccessToken({ sub: HEAD, tid: T, role: 'principal', roles: ['principal'] });
    teacherToken = await signAccessToken({
      sub: TEACH, tid: T, role: 'class_teacher', roles: ['class_teacher'] });
    settings = (await import('../api/settings.ts')).default;
  });

  after(async () => {
    if (db) {
      await db.withTenant(asHead, (c) => c.query('DELETE FROM tenants WHERE id = $1', [T]));
      await db.end(); await unlockFixtures();
    }
    delete process.env.VAPID_PUBLIC_KEY;
    delete process.env.VAPID_PRIVATE_KEY;
  });

  beforeEach(async () => {
    // The state the bug needed: nothing in settings at all.
    await db.withTenant(asHead, (c) =>
      c.query(`UPDATE tenants SET settings = '{}'::jsonb WHERE id = $1`, [T]));
  });

  const put = (body: unknown, token = headToken) =>
    call(settings, { method: 'PUT', url: '/api/v1/ops/settings', token, body });
  const get = (token = headToken) =>
    call(settings, { method: 'GET', url: '/api/v1/ops/settings', token });

  test('THE ONE THAT MATTERS — a first save on empty settings is actually written', async () => {
    assert.deepEqual(await stored(), {}, 'precondition: nothing stored');

    const r = await put({ sms: { noticeMaxChars: 240 } });
    assert.equal(r.status, 200, JSON.stringify(r.body));

    // The column, not the response. The response was right all along; the
    // column was not.
    assert.deepEqual(await stored(), { sms: { noticeMaxChars: 240 } });
  });

  test('THE ONE THAT MATTERS — the push toggle is written on a first save too', async () => {
    await put({ push: { replacesSms: true } });
    assert.deepEqual(await stored(), { push: { replacesSms: true } });
  });

  test('the value survives a fresh read', async () => {
    await put({ sms: { noticeMaxChars: 300 }, push: { replacesSms: true } });
    const r = await get();
    assert.equal((r.body.sms as { noticeMaxChars: number }).noticeMaxChars, 300);
    assert.equal((r.body.push as { replacesSms: boolean }).replacesSms, true);
  });

  test('one key does not clobber the other', async () => {
    await put({ push: { replacesSms: true } });
    await put({ sms: { noticeMaxChars: 240 } });
    assert.deepEqual(await stored(), {
      sms: { noticeMaxChars: 240 }, push: { replacesSms: true },
    });
  });

  test('THE ONE THAT MATTERS — neither key can blank the branding beside them', async () => {
    // `tenants.settings` is one blob holding R-1's branding as well. A PUT
    // that wrote the whole object would let the SMS screen erase a school's
    // logo, which is the reason this is a merge and not a replace.
    await db.withTenant(asHead, (c) => c.query(
      `UPDATE tenants SET settings = '{"branding":{"nameBn":"আসল নাম","logoUrl":"/l.png"},
        "provisioning":{"seeded":true}}'::jsonb WHERE id = $1`, [T]));

    await put({ sms: { noticeMaxChars: 240 } });
    await put({ push: { replacesSms: true } });

    const after = await stored();
    assert.deepEqual(after.branding, { nameBn: 'আসল নাম', logoUrl: '/l.png' });
    assert.deepEqual(after.provisioning, { seeded: true });
    assert.deepEqual(after.sms, { noticeMaxChars: 240 });
    assert.deepEqual(after.push, { replacesSms: true });
  });

  test('an unrelated key inside the same sub-object survives', async () => {
    await db.withTenant(asHead, (c) => c.query(
      `UPDATE tenants SET settings = '{"sms":{"noticeMaxChars":100,"somethingElse":"keep"}}'::jsonb
        WHERE id = $1`, [T]));
    await put({ sms: { noticeMaxChars: 240 } });
    assert.deepEqual(await stored(), {
      sms: { noticeMaxChars: 240, somethingElse: 'keep' },
    });
  });

  describe('validation', () => {
    test('an empty patch is refused rather than silently doing nothing', async () => {
      const r = await put({});
      assert.equal(r.status, 400);
      assert.equal(r.body.error, 'nothing_to_update');
    });

    test('the length is bounded, and rejected rather than clamped', async () => {
      // A principal who typed 900 and was shown 480 without being told would
      // believe the school sends 900.
      for (const v of [10, 900, 0, -1, 'abc', null, 12.5]) {
        const r = await put({ sms: { noticeMaxChars: v } });
        assert.equal(r.status, 400, String(v));
      }
      assert.deepEqual(await stored(), {}, 'nothing was written by a refused save');
    });

    test('THE ONE THAT MATTERS — the push toggle takes a boolean and only a boolean', async () => {
      // This one decides whether a guardian stops receiving an SMS. A form
      // that forgot to parse its checkbox must not switch a school's safety
      // net off with the string "false".
      for (const v of ['true', 'false', 1, 0, 'yes', {}]) {
        const r = await put({ push: { replacesSms: v } });
        assert.equal(r.status, 400, JSON.stringify(v));
        assert.equal(r.body.error, 'bad_boolean');
      }
      assert.deepEqual(await stored(), {});
    });

    test('turning suppression on with no push configured is refused', async () => {
      const pub = process.env.VAPID_PUBLIC_KEY;
      delete process.env.VAPID_PUBLIC_KEY;
      try {
        const r = await put({ push: { replacesSms: true } });
        // 409 rather than 400: the request is well formed, the deployment is
        // not ready for it. Accepting would leave a school believing push was
        // carrying its messages while nothing was.
        assert.equal(r.status, 409);
        assert.equal(r.body.error, 'push_not_configured');
        assert.deepEqual(await stored(), {});

        // Turning it OFF must still work — otherwise a school that enabled it
        // before the keys were removed could never disable it again.
        await db.withTenant(asHead, (c) => c.query(
          `UPDATE tenants SET settings = '{"push":{"replacesSms":true}}'::jsonb WHERE id=$1`, [T]));
        const off = await put({ push: { replacesSms: false } });
        assert.equal(off.status, 200);
        assert.deepEqual(await stored(), { push: { replacesSms: false } });
      } finally {
        process.env.VAPID_PUBLIC_KEY = pub;
      }
    });
  });

  describe('authorization', () => {
    test('no token, no settings', async () => {
      const r = await call(settings, { method: 'GET', url: '/api/v1/ops/settings' });
      assert.equal(r.status, 401);
    });

    test('a class teacher may READ the policy but not set it', async () => {
      // Reading is not the gated act: a teacher composing a notice benefits
      // from knowing the SMS cap they are writing against.
      assert.equal((await get(teacherToken)).status, 200);

      const w = await put({ sms: { noticeMaxChars: 240 } }, teacherToken);
      assert.equal(w.status, 403);
      const p = await put({ push: { replacesSms: true } }, teacherToken);
      assert.equal(p.status, 403);
      assert.deepEqual(await stored(), {}, 'a refused write leaves nothing behind');
    });
  });

  test('the audit trail records both keys, changed or not', async () => {
    await put({ push: { replacesSms: true } });
    const entry = await db.withTenant(asHead, async (c) => {
      const { rows } = await c.query<{ after: Record<string, unknown> }>(
        `SELECT after_state AS after FROM audit.activity_log
          WHERE tenant_id = $1 AND action = 'ops.settings.update'
          ORDER BY id DESC LIMIT 1`, [T]);
      return rows[0];
    });
    assert.ok(entry, 'a settings change must be auditable');
    // Both are recorded whether or not they changed: an entry reading
    // "replacesSms: false → false" is how somebody later proves a school's
    // SMS was not quietly switched off in this edit.
    assert.equal(entry.after.pushReplacesSms, true);
    assert.equal(typeof entry.after.noticeMaxChars, 'number');
  });
});
