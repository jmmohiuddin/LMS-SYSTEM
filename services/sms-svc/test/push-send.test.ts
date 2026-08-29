/**
 * R-9 — the push stage of the notification pipeline.
 *
 * This is where the phase's actual value is, and where its actual danger is.
 * Cancelling a school's SMS is cancelling the message a parent is most likely
 * to see, so the suite is built around the orderings that could lose one:
 *
 *   • a push that FAILED must never cancel an SMS;
 *   • an emergency must never be cancelled at all;
 *   • a login code must never be cancelled at all;
 *   • a school that has not opted in must never have anything cancelled.
 *
 * Each of those is one wrong `if` away from being untrue, and none of them
 * would produce an error anywhere — the symptom is a parent who was not told
 * something, which nobody reports as a bug.
 *
 *   DATABASE_URL=postgresql://… node --test services/sms-svc/test/push-send.test.ts
 */
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { createDb, type Db } from '../../../packages/server-core/src/db.ts';
import { generateVapidKeys } from '../../../packages/server-core/src/web-push.ts';
import { PushSender, pushReplacesSms, pushPayloadFor } from '../src/push-send.ts';

const DATABASE_URL = process.env.DATABASE_URL;
const skip = !DATABASE_URL ? 'DATABASE_URL not set' : false;

const T    = '9cb00000-0000-4000-8000-00000000000a';
const MUM  = '9cb00000-0000-4000-8000-0000000000a1';
const DAD  = '9cb00000-0000-4000-8000-0000000000a2';
const ORG  = 'মিরপুর বালিকা বিদ্যালয়';

const KEYS = {
  p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  auth: 'BTBZMqHH6r4Tts7J_aSIgg',
};

describe('R-9 — reading the school\'s opt-in', () => {
  test('THE ONE THAT MATTERS — anything but a literal true is off', () => {
    // This setting decides whether a guardian stops getting an SMS. A truthy
    // string must not be enough to switch a school's safety net off.
    for (const v of [undefined, null, {}, { push: {} }, { push: { replacesSms: 'true' } },
      { push: { replacesSms: 1 } }, { push: { replacesSms: 'yes' } },
      { push: null }, 'nonsense', 42]) {
      assert.equal(pushReplacesSms(v), false, JSON.stringify(v));
    }
    assert.equal(pushReplacesSms({ push: { replacesSms: true } }), true);
  });

  test('it does not collide with the SMS settings beside it', () => {
    const settings = { sms: { noticeMaxChars: 200 }, push: { replacesSms: true } };
    assert.equal(pushReplacesSms(settings), true);
  });
});

describe('R-9 — what the notification says', () => {
  test('the school signs the title, and does not sign twice', () => {
    const payload = JSON.parse(pushPayloadFor(
      `আপনার সন্তান আজ অনুপস্থিত ছিল। — ${ORG}`, ORG, '#/inbox', 'k'));
    assert.equal(payload.title, ORG);
    // The SMS ends "— school" because there is nowhere else to put the sender.
    // A notification has a title, so showing it twice is just noise.
    assert.equal(payload.body, 'আপনার সন্তান আজ অনুপস্থিত ছিল।');
    assert.doesNotMatch(payload.body, /—/);
  });

  test('a body without the signature is left alone', () => {
    const payload = JSON.parse(pushPayloadFor('কোনো স্বাক্ষর নেই', ORG, '#/home', 'k'));
    assert.equal(payload.body, 'কোনো স্বাক্ষর নেই');
  });

  test('D11 — the platform never appears in a parent\'s notification', () => {
    const payload = pushPayloadFor(`বার্তা — ${ORG}`, ORG, '#/inbox', 'k');
    assert.doesNotMatch(payload, /ShikhonBD/i);
    assert.match(payload, /মিরপুর/);
  });
});

describe('R-9 — the push stage', { skip }, () => {
  let db: Db;
  const vapid = generateVapidKeys();

  /** A push service that answers however the test says. */
  function fakePush(status: number | ((url: string) => number)) {
    const hits: string[] = [];
    const impl = (async (url: string) => {
      hits.push(url);
      const s = typeof status === 'function' ? status(url) : status;
      return { status: s, ok: s >= 200 && s < 300 } as Response;
    }) as unknown as typeof fetch;
    return { impl, hits };
  }

  const asIngest = <T>(fn: (c: import('pg').PoolClient) => Promise<T>) =>
    db.withTenant({ tenantId: T, userId: '', role: 'system_ingest' }, fn);

  /** Queue one message exactly as the enqueue stages would. */
  async function queueSms(o: {
    recipient?: string | null; template?: string; body?: string;
    dedupe: string; context?: Record<string, unknown>;
  }): Promise<void> {
    await asIngest(async (c) => {
      await c.query(
        `INSERT INTO sms_outbox
           (tenant_id, recipient_id, msisdn, template_code, body, dedupe_key, context)
         VALUES ($1,$2,'+8801799720001',$3,$4,$5,$6)`,
        [T, o.recipient === undefined ? MUM : o.recipient,
         o.template ?? 'notice.published.v1',
         o.body ?? `বার্তা — ${ORG}`, o.dedupe,
         JSON.stringify(o.context ?? { noticeId: 'n1' })]);
    });
  }

  const statusOf = (dedupe: string) => asIngest(async (c) => {
    const { rows } = await c.query<{ status: string; error_code: string | null }>(
      `SELECT status, error_code FROM sms_outbox WHERE tenant_id=$1 AND dedupe_key=$2`,
      [T, dedupe]);
    return rows[0];
  });

  before(async () => {
    db = createDb(DATABASE_URL as string);
    await asIngest(async (c) => {
      await c.query('DELETE FROM push_subscriptions WHERE tenant_id = $1', [T]);
      await c.query('DELETE FROM sms_outbox WHERE tenant_id = $1', [T]);
    });
    await db.withTenant({ tenantId: T, userId: MUM, role: 'principal' }, async (c) => {
      await c.query('DELETE FROM tenants WHERE id = $1', [T]);
      await c.query(
        `INSERT INTO tenants (id, slug, name_bn, name_en, stream, level)
         VALUES ($1,'r9-push',$2,'Mirpur','bangla_medium','secondary')`, [T, ORG]);
      await c.query(
        `INSERT INTO users (id, tenant_id, full_name_bn, full_name_en, phone_e164, status) VALUES
           ($1,$3,'মা','Mum','+8801799720001','active'),
           ($2,$3,'বাবা','Dad','+8801799720002','active')`, [MUM, DAD, T]);
      await c.query(
        `INSERT INTO user_roles (tenant_id, user_id, role_code) VALUES
           ($1,$2,'guardian'), ($1,$3,'guardian')`, [T, MUM, DAD]);
    });
  });

  after(async () => {
    if (!db) return;
    await asIngest(async (c) => {
      await c.query('DELETE FROM push_subscriptions WHERE tenant_id = $1', [T]);
      await c.query('DELETE FROM sms_outbox WHERE tenant_id = $1', [T]);
    });
    await db.withTenant({ tenantId: T, userId: MUM, role: 'principal' }, async (c) => {
      await c.query('DELETE FROM tenants WHERE id = $1', [T]);
    });
    await db.end();
  });

  beforeEach(async () => {
    await asIngest(async (c) => {
      await c.query('DELETE FROM push_subscriptions WHERE tenant_id = $1', [T]);
      await c.query('DELETE FROM sms_outbox WHERE tenant_id = $1', [T]);
    });
    // The mum has a phone registered; the dad does not.
    await db.withTenant({ tenantId: T, userId: MUM, role: 'guardian' }, async (c) => {
      await c.query(`SELECT app.claim_push_subscription($1,$2,$3,$4)`,
        ['https://fcm.googleapis.com/fcm/send/mum-phone', KEYS.p256dh, KEYS.auth, 'মোবাইল']);
    });
  });

  test('THE ONE THAT MATTERS — a delivered push cancels the SMS, when opted in', async () => {
    await queueSms({ dedupe: 'd1' });
    const f = fakePush(201);
    const r = await asIngest((c) => new PushSender(vapid, { fetchImpl: f.impl })
      .run(c, T, { replacesSms: true, orgName: ORG }));

    assert.equal(r.attempted, 1);
    assert.equal(r.accepted, 1);
    assert.equal(r.smsSuppressed, 1);
    const row = await statusOf('d1');
    assert.equal(row.status, 'suppressed');
    // The row stays an honest record of what the school did not pay for.
    assert.equal(row.error_code, 'delivered_by_push');
  });

  test('THE ONE THAT MATTERS — a FAILED push leaves the SMS queued', async () => {
    // The ordering that matters: push first, cancel second. The other order
    // loses the message every time push fails, and it fails for ordinary
    // reasons — a revoked permission, an outage.
    for (const status of [500, 429, 403]) {
      await asIngest((c) => c.query('DELETE FROM sms_outbox WHERE tenant_id=$1', [T]));
      await queueSms({ dedupe: `fail-${status}` });
      const f = fakePush(status);
      const r = await asIngest((c) => new PushSender(vapid, { fetchImpl: f.impl })
        .run(c, T, { replacesSms: true, orgName: ORG }));
      assert.equal(r.smsSuppressed, 0, `${status} must not cancel an SMS`);
      assert.equal((await statusOf(`fail-${status}`)).status, 'queued');
    }
  });

  test('a school that has not opted in keeps its SMS, and is told what it would save', async () => {
    await queueSms({ dedupe: 'd2' });
    const f = fakePush(201);
    const r = await asIngest((c) => new PushSender(vapid, { fetchImpl: f.impl })
      .run(c, T, { replacesSms: false, orgName: ORG }));

    assert.equal(r.accepted, 1, 'push is additive by default, not off');
    assert.equal(r.smsSuppressed, 0);
    // The number that makes the case for opting in.
    assert.equal(r.couldHaveSuppressed, 1);
    assert.equal((await statusOf('d2')).status, 'queued');
  });

  test('THE ONE THAT MATTERS — an emergency is never cancelled', async () => {
    await queueSms({ dedupe: 'd3', context: { noticeId: 'n9', category: 'emergency' } });
    const f = fakePush(201);
    const r = await asIngest((c) => new PushSender(vapid, { fetchImpl: f.impl })
      .run(c, T, { replacesSms: true, orgName: ORG }));

    assert.equal(r.accepted, 1, 'it still goes by push…');
    assert.equal(r.smsSuppressed, 0, '…and by SMS as well');
    assert.equal(r.couldHaveSuppressed, 0, 'not counted as a missed saving either');
    assert.equal((await statusOf('d3')).status, 'queued');
  });

  test('THE ONE THAT MATTERS — a login code is never pushed or cancelled', async () => {
    // A person requesting a login code may be doing so BECAUSE they have lost
    // access to the app that would have received the push.
    await queueSms({ dedupe: 'd4', template: 'auth.otp.v1', body: 'কোড 123456' });
    const f = fakePush(201);
    const r = await asIngest((c) => new PushSender(vapid, { fetchImpl: f.impl })
      .run(c, T, { replacesSms: true, orgName: ORG }));

    assert.equal(r.attempted, 0);
    assert.equal(f.hits.length, 0, 'a login code must not leave by this route at all');
    assert.equal((await statusOf('d4')).status, 'queued');
  });

  test('someone with no subscription is untouched', async () => {
    await queueSms({ dedupe: 'd5', recipient: DAD });
    const f = fakePush(201);
    const r = await asIngest((c) => new PushSender(vapid, { fetchImpl: f.impl })
      .run(c, T, { replacesSms: true, orgName: ORG }));
    assert.equal(r.attempted, 0);
    assert.equal((await statusOf('d5')).status, 'queued');
  });

  test('a bulk message with no addressee is not pushed', async () => {
    await queueSms({ dedupe: 'd6', recipient: null });
    const f = fakePush(201);
    const r = await asIngest((c) => new PushSender(vapid, { fetchImpl: f.impl })
      .run(c, T, { replacesSms: true, orgName: ORG }));
    assert.equal(r.attempted, 0);
  });

  test('a dead subscription is pruned, and its SMS still goes', async () => {
    await queueSms({ dedupe: 'd7' });
    const f = fakePush(410);
    const r = await asIngest((c) => new PushSender(vapid, { fetchImpl: f.impl })
      .run(c, T, { replacesSms: true, orgName: ORG }));

    assert.equal(r.pruned, 1);
    assert.equal(r.smsSuppressed, 0);
    assert.equal((await statusOf('d7')).status, 'queued');
    const left = await asIngest(async (c) => {
      const { rows } = await c.query<{ n: string }>(
        'SELECT count(*) AS n FROM push_subscriptions WHERE tenant_id=$1', [T]);
      return Number(rows[0].n);
    });
    assert.equal(left, 0, 'a browser that is gone must not be retried forever');
  });

  test('an outage does NOT prune — the subscription survives', async () => {
    await queueSms({ dedupe: 'd8' });
    const f = fakePush(503);
    const r = await asIngest((c) => new PushSender(vapid, { fetchImpl: f.impl })
      .run(c, T, { replacesSms: true, orgName: ORG }));
    assert.equal(r.pruned, 0);
    const left = await asIngest(async (c) => {
      const { rows } = await c.query<{ n: string }>(
        'SELECT count(*) AS n FROM push_subscriptions WHERE tenant_id=$1', [T]);
      return Number(rows[0].n);
    });
    assert.equal(left, 1);
  });

  test('every device the person has is contacted', async () => {
    await db.withTenant({ tenantId: T, userId: MUM, role: 'guardian' }, async (c) => {
      await c.query(`SELECT app.claim_push_subscription($1,$2,$3,$4)`,
        ['https://fcm.googleapis.com/fcm/send/mum-desk', KEYS.p256dh, KEYS.auth, 'কম্পিউটার']);
    });
    await queueSms({ dedupe: 'd9' });
    const f = fakePush(201);
    const r = await asIngest((c) => new PushSender(vapid, { fetchImpl: f.impl })
      .run(c, T, { replacesSms: true, orgName: ORG }));

    assert.equal(r.accepted, 2, 'a parent at work should see it on either device');
    // One message, one SMS cancelled — not one per device.
    assert.equal(r.smsSuppressed, 1);
  });

  test('one accepted device is enough to cancel the SMS', async () => {
    await db.withTenant({ tenantId: T, userId: MUM, role: 'guardian' }, async (c) => {
      await c.query(`SELECT app.claim_push_subscription($1,$2,$3,$4)`,
        ['https://fcm.googleapis.com/fcm/send/mum-broken', KEYS.p256dh, KEYS.auth, 'পুরনো']);
    });
    await queueSms({ dedupe: 'd10' });
    // The old device is gone; the phone works.
    const f = fakePush((url) => (url.includes('broken') ? 410 : 201));
    const r = await asIngest((c) => new PushSender(vapid, { fetchImpl: f.impl })
      .run(c, T, { replacesSms: true, orgName: ORG }));

    assert.equal(r.accepted, 1);
    assert.equal(r.pruned, 1);
    assert.equal(r.smsSuppressed, 1);
  });

  test('nothing queued means no work and no requests', async () => {
    const f = fakePush(201);
    const r = await asIngest((c) => new PushSender(vapid, { fetchImpl: f.impl })
      .run(c, T, { replacesSms: true, orgName: ORG }));
    assert.deepEqual(r, { attempted: 0, accepted: 0, smsSuppressed: 0, pruned: 0, couldHaveSuppressed: 0 });
    assert.equal(f.hits.length, 0);
  });

  test('an already-sent message is not pushed after the fact', async () => {
    await queueSms({ dedupe: 'd11' });
    await asIngest((c) => c.query(
      `UPDATE sms_outbox SET status='sent' WHERE tenant_id=$1 AND dedupe_key=$2`, [T, 'd11']));
    const f = fakePush(201);
    const r = await asIngest((c) => new PushSender(vapid, { fetchImpl: f.impl })
      .run(c, T, { replacesSms: true, orgName: ORG }));
    assert.equal(r.attempted, 0, 'the parent already has it — a push would be a duplicate');
  });
});
