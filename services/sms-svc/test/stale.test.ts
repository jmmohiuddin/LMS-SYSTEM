/**
 * P-ops §6 — a message too old to be worth sending.
 *
 * The dispatcher's claim query is `WHERE status = 'queued' ORDER BY priority,
 * queued_at` with no bound on age, so every queued row is eventually sent
 * however long it waited. That is right for a dispatcher that missed a night.
 *
 * It is wrong after a suspension. Suspending a school for non-payment blocks
 * its sessions immediately — verified — but the outbox keeps filling from
 * attendance already taken, and nothing revokes or ages those rows. The first
 * dispatch after the school is restored would text every guardian about a day
 * months in the past.
 *
 * Telling a parent their child was absent on a day they cannot remember is
 * worse than silence: it reads as a system that has lost track of their child.
 * So a stale row is SUPPRESSED with a reason rather than sent or deleted — the
 * office can still see what was queued and why it never went, which is what
 * they need when a parent asks.
 *
 *   DATABASE_URL=postgresql://… node --test services/sms-svc/test/stale.test.ts
 */
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { createDb, type Db } from '../../../packages/server-core/src/db.ts';
import { lockFixtures, unlockFixtures, asBootstrap } from '../../../packages/server-core/test/harness.ts';
import { SmsDispatchWorker, STALE_SMS_DAYS } from '../src/dispatch.ts';
import type { SmsProvider } from '../src/provider.ts';

const DATABASE_URL = process.env.DATABASE_URL;
const skip = !DATABASE_URL ? 'DATABASE_URL not set' : false;

const T   = '9d100000-0000-4000-8000-00000000000a';
const MUM = '9d100000-0000-4000-8000-0000000000a1';
const PHONE = '+8801799820001';

describe('P-ops §6 — a suspension does not text parents about last quarter', { skip }, () => {
  let db: Db;
  const sent: string[] = [];
  const spyProvider: SmsProvider = {
    name: 'spy', live: true,
    async send(msisdn) { sent.push(msisdn); return { provider: 'spy', providerMsgId: 'x', costBdt: null }; },
  };

  const asIngest = <R>(fn: (c: import('pg').PoolClient) => Promise<R>) =>
    db.withTenant({ tenantId: T, userId: '', role: 'system_ingest' }, fn);

  before(async () => {
    await lockFixtures(DATABASE_URL as string);
    db = createDb(DATABASE_URL as string);
    await asBootstrap(db, { tenantId: T, userId: MUM, role: 'principal' }, async (c) => {
      await c.query('DELETE FROM sms_outbox WHERE tenant_id = $1', [T]);
      await c.query('DELETE FROM tenants WHERE id = $1', [T]);
      await c.query(
        `INSERT INTO tenants (id, slug, name_bn, name_en, stream, level)
         VALUES ($1,'pops-stale','পুরোনো','Stale','bangla_medium','secondary')`, [T]);
      await c.query(
        `INSERT INTO users (id, tenant_id, full_name_bn, full_name_en, phone_e164, status)
         VALUES ($1,$2,'মা','Mum',$3,'active')`, [MUM, T, PHONE]);
    });
  });

  after(async () => {
    if (!db) return;
    await asIngest((c) => c.query('DELETE FROM sms_outbox WHERE tenant_id = $1', [T]));
    await asBootstrap(db, { tenantId: T, userId: MUM, role: 'principal' },
      (c) => c.query('DELETE FROM tenants WHERE id = $1', [T]));
    await db.end(); await unlockFixtures();
  });

  /** One queued message about a school day `ageDays` in the past. */
  const queueAged = (dedupe: string, ageDays: number) => asIngest((c) => c.query(
    `INSERT INTO sms_outbox (tenant_id, created_on, recipient_id, msisdn,
                             template_code, body, dedupe_key)
     VALUES ($1, (now() - ($2 || ' days')::interval)::date, $3, $4,
             'attendance.absent.v1', 'অনুপস্থিত', $5)`,
    [T, String(ageDays), MUM, PHONE, dedupe]));

  const statusOf = (dedupe: string) => asIngest(async (c) => {
    const { rows } = await c.query<{ status: string; error_code: string | null }>(
      `SELECT status, error_code FROM sms_outbox WHERE tenant_id=$1 AND dedupe_key=$2`,
      [T, dedupe]);
    return rows[0];
  });

  const run = () => new SmsDispatchWorker(db, { provider: spyProvider, vapid: null }).run(T);

  beforeEach(async () => {
    sent.length = 0;
    await asIngest((c) => c.query('DELETE FROM sms_outbox WHERE tenant_id = $1', [T]));
  });

  test('THE ONE THAT MATTERS — a message from before a suspension is not sent', async () => {
    // 90 days: a school stopped for a term, then restored.
    await queueAged('stale-90', 90);
    await run();

    assert.deepEqual(sent, [], 'a guardian was texted about a day three months ago');
    const row = await statusOf('stale-90');
    assert.equal(row.status, 'suppressed');
    assert.equal(row.error_code, 'too_old_to_send',
      'the office must be able to see WHY it never went');
  });

  test('and today’s message still goes', async () => {
    await queueAged('fresh', 0);
    await run();
    assert.deepEqual(sent, [PHONE]);
    assert.equal((await statusOf('fresh')).status, 'sent');
  });

  test('a dispatcher that missed a long weekend still delivers', async () => {
    // The reason the bound is days rather than hours: a job that failed on
    // Friday must still send on Monday, or the guard would cost a school
    // real notices every time a run was missed.
    await queueAged('weekend', STALE_SMS_DAYS);
    await run();
    assert.deepEqual(sent, [PHONE], `a message ${STALE_SMS_DAYS} days old must still send`);
  });

  test('one day past the bound is where it stops', async () => {
    await queueAged('past-bound', STALE_SMS_DAYS + 1);
    await run();
    assert.deepEqual(sent, []);
    assert.equal((await statusOf('past-bound')).error_code, 'too_old_to_send');
  });

  test('a suppressed row is not deleted — the school can still account for it', async () => {
    await queueAged('kept', 60);
    await run();
    const row = await statusOf('kept');
    assert.ok(row, 'the row must survive as a record of what was queued');
    assert.equal(row.status, 'suppressed');
  });
});
