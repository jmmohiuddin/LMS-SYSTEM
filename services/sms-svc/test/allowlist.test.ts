/**
 * R-8 §4 — the test-recipient allowlist.
 *
 * The safety net for the step nobody in this product has taken yet: pointing a
 * real aggregator at a real school's data. Between "no provider configured"
 * and "texting nine hundred guardians" there was nothing, and that step is
 * where a wrong audience, a wrong template, or a leftover fixture in a
 * production database costs a school its standing rather than costing a
 * developer an afternoon.
 *
 * Two properties, and the second is the one that makes it useful rather than
 * merely safe:
 *
 *   1. With the allowlist set, a number not on it is NOT sent to.
 *   2. The row is still written, still counted, still visible — only the SEND
 *      is withheld. A pilot therefore exercises the real pipeline and can read
 *      exactly what would have gone out.
 *
 *   DATABASE_URL=postgresql://… node --test services/sms-svc/test/allowlist.test.ts
 */
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { createDb, type Db } from '../../../packages/server-core/src/db.ts';
import { lockFixtures, unlockFixtures } from '../../../packages/server-core/test/harness.ts';
import {
  smsTestRecipients, smsRestrictedToAllowlist,
} from '../../../packages/server-core/src/go-live.ts';
import { SmsDispatchWorker } from '../src/dispatch.ts';
import type { SmsProvider } from '../src/provider.ts';

const DATABASE_URL = process.env.DATABASE_URL;
const skip = !DATABASE_URL ? 'DATABASE_URL not set' : false;

const T   = '9d000000-0000-4000-8000-00000000000a';
const MUM = '9d000000-0000-4000-8000-0000000000a1';
const DAD = '9d000000-0000-4000-8000-0000000000a2';
const ON_LIST  = '+8801799810001';
const OFF_LIST = '+8801799810002';

describe('R-8 §4 — reading the allowlist', () => {
  test('THE ONE THAT MATTERS — empty means unrestricted, not "send to nobody"', () => {
    // The failure mode to avoid: an unset variable read as an empty allowlist
    // would silence every school on every deployment, and the symptom would be
    // parents quietly not being told things.
    assert.deepEqual(smsTestRecipients({}), []);
    assert.equal(smsRestrictedToAllowlist({}), false);
    assert.equal(smsRestrictedToAllowlist({ SMS_TEST_RECIPIENTS: '' }), false);
    assert.equal(smsRestrictedToAllowlist({ SMS_TEST_RECIPIENTS: '  ,  , ' }), false);
  });

  test('a list is split, trimmed and emptied of blanks', () => {
    assert.deepEqual(
      smsTestRecipients({ SMS_TEST_RECIPIENTS: ' +8801711000001 , +8801711000002 ,,' }),
      ['+8801711000001', '+8801711000002']);
    assert.equal(
      smsRestrictedToAllowlist({ SMS_TEST_RECIPIENTS: '+8801711000001' }), true);
  });
});

describe('R-8 §4 — the dispatcher honours it', { skip }, () => {
  let db: Db;
  /** Records what a provider was ASKED to send. */
  const sent: string[] = [];
  const spyProvider: SmsProvider = {
    name: 'spy', live: true,
    async send(msisdn) { sent.push(msisdn); return { provider: 'spy', providerMsgId: 'x', costBdt: null }; },
  };

  const asIngest = <T>(fn: (c: import('pg').PoolClient) => Promise<T>) =>
    db.withTenant({ tenantId: T, userId: '', role: 'system_ingest' }, fn);

  before(async () => {
    // Serialised against other runs of this same suite — the fixtures below
    // live at fixed uuids and two processes would delete each other's.
    await lockFixtures(DATABASE_URL as string);
    db = createDb(DATABASE_URL as string);
    await asIngest(async (c) => {
      await c.query('DELETE FROM sms_outbox WHERE tenant_id = $1', [T]);
    });
    await db.withTenant({ tenantId: T, userId: MUM, role: 'principal' }, async (c) => {
      await c.query('DELETE FROM tenants WHERE id = $1', [T]);
      await c.query(
        `INSERT INTO tenants (id, slug, name_bn, name_en, stream, level)
         VALUES ($1,'r8-allow','অনুমোদিত','Allow','bangla_medium','secondary')`, [T]);
      await c.query(
        `INSERT INTO users (id, tenant_id, full_name_bn, full_name_en, phone_e164, status) VALUES
           ($1,$3,'মা','Mum',$4,'active'),
           ($2,$3,'বাবা','Dad',$5,'active')`,
        [MUM, DAD, T, ON_LIST, OFF_LIST]);
    });
  });

  after(async () => {
    if (!db) return;
    await asIngest((c) => c.query('DELETE FROM sms_outbox WHERE tenant_id = $1', [T]));
    await db.withTenant({ tenantId: T, userId: MUM, role: 'principal' },
      (c) => c.query('DELETE FROM tenants WHERE id = $1', [T]));
    await db.end(); await unlockFixtures();
  });

  beforeEach(async () => {
    sent.length = 0;
    await asIngest(async (c) => {
      await c.query('DELETE FROM sms_outbox WHERE tenant_id = $1', [T]);
      for (const [i, phone] of [ON_LIST, OFF_LIST].entries()) {
        await c.query(
          `INSERT INTO sms_outbox (tenant_id, recipient_id, msisdn, template_code,
                                   body, dedupe_key)
           VALUES ($1,$2,$3,'notice.published.v1','পরীক্ষা',$4)`,
          [T, i === 0 ? MUM : DAD, phone, `allow-${i}`]);
      }
    });
  });

  const statusOf = (dedupe: string) => asIngest(async (c) => {
    const { rows } = await c.query<{ status: string; error_code: string | null }>(
      `SELECT status, error_code FROM sms_outbox WHERE tenant_id=$1 AND dedupe_key=$2`,
      [T, dedupe]);
    return rows[0];
  });

  const run = (testRecipients?: string[]) =>
    new SmsDispatchWorker(db, { provider: spyProvider, vapid: null, testRecipients })
      .run(T);

  test('THE ONE THAT MATTERS — only an allowlisted number is sent to', async () => {
    await run([ON_LIST]);
    assert.deepEqual(sent, [ON_LIST], 'a number off the list reached the provider');
  });

  test('THE ONE THAT MATTERS — the withheld row is recorded, not hidden', async () => {
    await run([ON_LIST]);
    const off = await statusOf('allow-1');
    // The row still exists and says exactly why nothing was sent. A pilot can
    // read what WOULD have gone out, which is the point of running the real
    // pipeline rather than a mock of it.
    assert.equal(off.status, 'suppressed');
    assert.equal(off.error_code, 'not_in_test_allowlist');

    const on = await statusOf('allow-0');
    assert.equal(on.status, 'sent');
  });

  test('an empty allowlist sends to everybody', async () => {
    // The default, and every real deployment. Getting this backwards would
    // silence a school without an error anywhere.
    await run([]);
    assert.deepEqual([...sent].sort(), [ON_LIST, OFF_LIST].sort());
    assert.equal((await statusOf('allow-1')).status, 'sent');
  });

  test('a withheld message is not counted as dispatched', async () => {
    const r = await run([ON_LIST]);
    assert.equal(r.dispatched, 1, 'withheld messages must not inflate the count');
  });

  test('withholding does not consume an attempt or mark a failure', async () => {
    // It is not an error and must not age toward the five-attempt give-up:
    // when the allowlist is lifted the message should still be sendable.
    await run([ON_LIST]);
    const off = await asIngest(async (c) => {
      const { rows } = await c.query<{ attempts: number }>(
        `SELECT attempts FROM sms_outbox WHERE tenant_id=$1 AND dedupe_key='allow-1'`, [T]);
      return rows[0];
    });
    assert.equal(off.attempts, 0);
  });
});
