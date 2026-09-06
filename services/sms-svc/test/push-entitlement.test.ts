/**
 * B-53, the half the backlog row named and nothing had closed.
 *
 * The row said it plainly: "disabling `push` does not stop push at all — only
 * the subscribe endpoint is gated, not the sending path." That was exactly
 * right. `ops-svc/api/push.ts` declares `service: 'push'`, so a school with
 * push switched off cannot register a NEW device — and every device already
 * registered kept receiving notifications, because the dispatch run is gated
 * on `sms` and the push stage rides inside it.
 *
 * ── Why this one is worse than a missing notification ──────────────────────
 * `pushReplacesSms` lets a school say push is its transport and SMS is the
 * fallback. When it is on, a push the service ACCEPTS cancels the queued SMS.
 * So a school that switched push off and left `replacesSms` on had its paid
 * fallback cancelled by a transport it had disabled — the guardian got
 * neither. Silence in both channels, and nothing anywhere saying why.
 *
 * ── What is asserted ───────────────────────────────────────────────────────
 * Not "the code calls tenant_service_state". The push service here is a spy:
 * the test asserts that with push off it is never contacted at all, and that
 * the SMS the push would have cancelled still goes.
 *
 *   DATABASE_URL=postgres://shikhon_app:… \
 *   PLATFORM_DATABASE_URL=postgres://shikhon_platform:… \
 *     node --test services/sms-svc/test/push-entitlement.test.ts
 */
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { createDb, type Db } from '../../../packages/server-core/src/db.ts';
import { lockFixtures, unlockFixtures, asBootstrap } from '../../../packages/server-core/test/harness.ts';
import { SmsDispatchWorker } from '../src/dispatch.ts';
import { generateVapidKeys } from '../../../packages/server-core/src/web-push.ts';
import type { SmsProvider } from '../src/provider.ts';

const DATABASE_URL = process.env.DATABASE_URL;
const PLATFORM_URL = process.env.PLATFORM_DATABASE_URL;
const skip = !DATABASE_URL ? 'DATABASE_URL not set'
  : !PLATFORM_URL ? 'PLATFORM_DATABASE_URL not set' : false;

const T   = '9d530000-0000-4000-8000-00000000000a';
const MUM = '9d530000-0000-4000-8000-0000000000a1';
const PHONE = '+8801799530001';
const ORG = 'পুশ পরীক্ষা';
/**
 * A second school, genuinely on the `pilot` plan.
 *
 * The pilot-bug test below can be reached by switching `sms` off on the first
 * school, and that is a simulation: the state it produces is `disabled` where
 * a real pilot school has `not_in_plan`. Both fail the same check today, and
 * "both fail the same check today" is precisely the assumption a plan-shaped
 * bug hides behind — `tenant_service_state` has separate branches for them and
 * nothing stops those branches diverging.
 *
 * `pilot` is the plan real pilot schools are on, so it is worth a real school.
 */
const T_PILOT   = '9d530000-0000-4000-8000-00000000000b';
const MUM_PILOT = '9d530000-0000-4000-8000-0000000000b1';
const PHONE_PILOT = '+8801799530002';
/**
 * A real P-256 point, shared with `push-send.test.ts`.
 *
 * Not any base64 of the right length: the payload is genuinely encrypted
 * before the transport is called, so an invalid curve point fails inside
 * `web-push` and the spy is never contacted — which looks exactly like the
 * gate working and is not. That mistake cost an hour while this file was
 * being written, so the constant is quoted from the suite that already had a
 * valid one rather than invented again.
 */
const KEYS = {
  p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  auth: 'BTBZMqHH6r4Tts7J_aSIgg',
};

describe('P-ops §5 — a school that switched push off is not still pushed to', { skip }, () => {
  let db: Db;
  let plat: Db;
  const vapid = generateVapidKeys();
  /** Every URL the push transport was asked to contact. Must stay empty. */
  let pushHits: string[] = [];
  const sent: string[] = [];

  const fakePush = (async (url: string) => {
    pushHits.push(url);
    return { status: 201, ok: true } as Response;
  }) as unknown as typeof fetch;

  const spyProvider: SmsProvider = {
    name: 'spy', live: true,
    async send(msisdn) { sent.push(msisdn); return { provider: 'spy', providerMsgId: 'x', costBdt: null }; },
  };

  const asIngest = <R>(fn: (c: import('pg').PoolClient) => Promise<R>) =>
    db.withTenant({ tenantId: T, userId: '', role: 'system_ingest' }, fn);

  const setServices = (json: string) => plat.pool.query(
    `INSERT INTO tenant_operations (tenant_id, ops_state, services)
     VALUES ($1, 'active', $2::jsonb)
     ON CONFLICT (tenant_id) DO UPDATE SET ops_state='active', services = $2::jsonb`,
    [T, json]);

  before(async () => {
    await lockFixtures(DATABASE_URL as string);
    db = createDb(DATABASE_URL as string);
    plat = createDb(PLATFORM_URL as string);
    await asBootstrap(db, { tenantId: T, userId: MUM, role: 'principal' }, async (c) => {
      await c.query('DELETE FROM push_subscriptions WHERE tenant_id = $1', [T]);
      await c.query('DELETE FROM sms_outbox WHERE tenant_id = $1', [T]);
      await c.query('DELETE FROM tenants WHERE id = $1', [T]);
      await c.query(
        `INSERT INTO tenants (id, slug, name_bn, name_en, stream, level, settings)
         VALUES ($1,'b53-push',$2,'Push Test','bangla_medium','secondary',
                 '{"push":{"replacesSms":true}}'::jsonb)`, [T, ORG]);
      await c.query(
        `INSERT INTO users (id, tenant_id, full_name_bn, full_name_en, phone_e164, status)
         VALUES ($1,$2,'মা','Mum',$3,'active')`, [MUM, T, PHONE]);
      await c.query(
        `INSERT INTO user_roles (tenant_id, user_id, role_code) VALUES ($1,$2,'guardian')`,
        [T, MUM]);
    });
    await asBootstrap(db, { tenantId: T_PILOT, userId: MUM_PILOT, role: 'principal' }, async (c) => {
      await c.query('DELETE FROM push_subscriptions WHERE tenant_id = $1', [T_PILOT]);
      await c.query('DELETE FROM sms_outbox WHERE tenant_id = $1', [T_PILOT]);
      await c.query('DELETE FROM tenants WHERE id = $1', [T_PILOT]);
      await c.query(
        `INSERT INTO tenants (id, slug, name_bn, name_en, stream, level, plan_code, settings)
         VALUES ($1,'b83-pilot','পাইলট','Pilot','bangla_medium','secondary','pilot',
                 '{"push":{"replacesSms":true}}'::jsonb)`, [T_PILOT]);
      await c.query(
        `INSERT INTO users (id, tenant_id, full_name_bn, full_name_en, phone_e164, status)
         VALUES ($1,$2,'মা','Mum',$3,'active')`, [MUM_PILOT, T_PILOT, PHONE_PILOT]);
      await c.query(
        `INSERT INTO user_roles (tenant_id, user_id, role_code) VALUES ($1,$2,'guardian')`,
        [T_PILOT, MUM_PILOT]);
    });
    await plat.pool.query(
      `INSERT INTO tenant_operations (tenant_id, ops_state, services)
       VALUES ($1,'active','{}'::jsonb)
       ON CONFLICT (tenant_id) DO UPDATE SET ops_state='active', services='{}'::jsonb`,
      [T_PILOT]);

    await setServices('{}');
  });

  after(async () => {
    if (!db) return;
    await asIngest(async (c) => {
      await c.query('DELETE FROM push_subscriptions WHERE tenant_id = $1', [T]);
      await c.query('DELETE FROM sms_outbox WHERE tenant_id = $1', [T]);
    });
    await asBootstrap(db, { tenantId: T, userId: MUM, role: 'principal' },
      (c) => c.query('DELETE FROM tenants WHERE id = $1', [T]));
    await db.withTenant({ tenantId: T_PILOT, userId: '', role: 'system_ingest' }, async (c) => {
      await c.query('DELETE FROM push_subscriptions WHERE tenant_id = $1', [T_PILOT]);
      await c.query('DELETE FROM sms_outbox WHERE tenant_id = $1', [T_PILOT]);
    }, { skipGate: true });
    await asBootstrap(db, { tenantId: T_PILOT, userId: MUM_PILOT, role: 'principal' },
      (c) => c.query('DELETE FROM tenants WHERE id = $1', [T_PILOT]));
    await db.end(); await plat.end(); await unlockFixtures();
  });

  beforeEach(async () => {
    pushHits = []; sent.length = 0;
    // Reset the switches here, not at the end of each test. A test that fails
    // its assertion never reaches its own restore, and the next run then sees
    // a school still in `limited` — which reads as a second, unrelated
    // failure. That happened while this file was being written.
    await setServices('{}');
    await plat.pool.query(
      `UPDATE tenant_operations SET ops_state='active' WHERE tenant_id=$1`, [T]);
    await asIngest(async (c) => {
      await c.query('DELETE FROM push_subscriptions WHERE tenant_id = $1', [T]);
      await c.query('DELETE FROM sms_outbox WHERE tenant_id = $1', [T]);
    });
    // One registered device, from before the operator switched push off.
    await db.withTenant({ tenantId: T, userId: MUM, role: 'guardian' }, (c) =>
      c.query('SELECT app.claim_push_subscription($1,$2,$3,$4)',
        ['https://fcm.googleapis.com/fcm/send/mum-phone', KEYS.p256dh, KEYS.auth, 'মোবাইল']));
    await asIngest((c) => c.query(
      `INSERT INTO sms_outbox (tenant_id, recipient_id, msisdn, template_code, body,
                               dedupe_key, context)
       VALUES ($1,$2,$3,'notice.published.v1',$4,'b53-push-1','{"noticeId":"n1"}'::jsonb)`,
      [T, MUM, PHONE, `বার্তা — ${ORG}`]));
  });

  const run = () => new SmsDispatchWorker(db, { provider: spyProvider, vapid, fetchImpl: fakePush })
    .run(T);

  test('baseline — with push on, the device IS contacted', async () => {
    await run();
    assert.equal(pushHits.length, 1,
      'without this the next test proves only that the fixture is broken');
  });

  test('THE ONE THAT MATTERS — push off means the push service is never contacted', async () => {
    await setServices('{"push":"disabled"}');
    await run();

    assert.deepEqual(pushHits, [],
      'a device registered before the switch was still being pushed to');
  });

  test('…and the SMS it would have cancelled still goes', async () => {
    // The consequence that makes this more than a missing notification.
    // `replacesSms` is on for this school, so a push the service accepted
    // used to cancel the queued SMS. With push disabled the guardian must
    // still be reached — by the paid transport, which is the whole point of
    // it being the fallback.
    await setServices('{"push":"disabled"}');
    await run();

    assert.deepEqual(sent, [PHONE],
      'the guardian got neither transport — silence in both channels');
  });

  test('maintenance is off too — a transport mid-migration sends nothing', async () => {
    await setServices('{"push":"maintenance"}');
    await run();
    assert.deepEqual(pushHits, []);
    assert.deepEqual(sent, [PHONE]);
  });

  test('a school in arrears sends nothing — both transports stop together', async () => {
    // `limited` is the arrears state, and `service_catalogue.in_limited` is
    // false for BOTH `sms` and `push`. So the honest assertion is not "push
    // survives" — it is that the policy is the catalogue's and this code does
    // not quietly invent a softer one. If someone later decides a school in
    // arrears should keep the free transport, that is a row in
    // `service_catalogue`, not an `if` in a worker.
    await plat.pool.query(
      `UPDATE tenant_operations SET ops_state='limited' WHERE tenant_id=$1`, [T]);
    await run();

    assert.deepEqual(pushHits, []);
    assert.deepEqual(sent, []);
  });

  test('THE PILOT BUG — a plan with push and no SMS still pushes', async () => {
    // `pilot` and `madrasa_basic` carry `push: true` and no `sms` key at all.
    // The run used to be gated on `service: 'sms'`, so for every school on
    // those plans the gate refused before the first statement and the push
    // stage never executed. Their devices registered, their subscribe
    // endpoint answered 200, and not one notification was ever delivered —
    // silently, because a refused run reports a blocked tenant and not a
    // missing feature.
    //
    // Simulated here by the state the plan produces, `not_in_plan` for sms
    // with push on, rather than by changing this fixture's plan: `tenants`
    // carries one policy for the app role and the platform role updates zero
    // rows, so a plan change in a test would silently do nothing — which is
    // how the earlier version of this suite passed while proving nothing.
    await setServices('{"sms":"disabled"}');
    await run();

    assert.equal(pushHits.length, 1,
      'a school whose plan has push but not SMS got no push at all');
    assert.deepEqual(sent, [],
      'and its SMS must still not go — that is the part that costs money');
  });

  test('B-83 ON A REAL PILOT SCHOOL — not_in_plan, not a simulated disable', async () => {
    // The plan itself, not a switch: `pilot` carries `push: true` and no `sms`
    // key at all, so `tenant_service_state` returns `not_in_plan` for sms and
    // `enabled` for push. That is the exact configuration every real pilot
    // school is in, and the one under which none of them had ever received a
    // notification.
    const state = async (svc: string) => {
      const { rows } = await plat.pool.query<{ s: string }>(
        'SELECT app.tenant_service_state($1,$2) AS s', [T_PILOT, svc]);
      return rows[0].s;
    };
    assert.equal(await state('sms'), 'not_in_plan',
      'the fixture must be a genuine pilot school, or this proves nothing');
    assert.equal(await state('push'), 'enabled');

    const hits: string[] = [];
    // One line: node's type-stripper cannot parse an `as` cast that starts on
    // a continuation line after a parenthesised arrow.
    const spy = (async (url: string) => { hits.push(url); return { status: 201, ok: true }; }) as unknown as typeof fetch;
    const sentHere: string[] = [];
    const provider: SmsProvider = {
      name: 'spy', live: true,
      async send(m) { sentHere.push(m); return { provider: 'spy', providerMsgId: 'x', costBdt: null }; },
    };

    await db.withTenant({ tenantId: T_PILOT, userId: MUM_PILOT, role: 'guardian' }, (c) =>
      c.query('SELECT app.claim_push_subscription($1,$2,$3,$4)',
        ['https://fcm.googleapis.com/fcm/send/pilot', KEYS.p256dh, KEYS.auth, 'মোবাইল']));
    await db.withTenant({ tenantId: T_PILOT, userId: '', role: 'system_ingest' }, (c) =>
      c.query(
        `INSERT INTO sms_outbox (tenant_id, recipient_id, msisdn, template_code, body,
                                 dedupe_key, context)
         VALUES ($1,$2,$3,'notice.published.v1','বার্তা — পাইলট','pilot-1','{"noticeId":"n1"}'::jsonb)`,
        [T_PILOT, MUM_PILOT, PHONE_PILOT]), { skipGate: true });

    await new SmsDispatchWorker(db, { provider, vapid, fetchImpl: spy }).run(T_PILOT);

    assert.equal(hits.length, 1,
      'a real pilot school still received no push — B-83 is not closed');
    assert.deepEqual(sentHere, [],
      'and its SMS must not go: the plan does not include it, and that costs money');
  });
});
