/**
 * Product event ingest — F-1503, TRD §13
 *
 * The batch endpoint's three promises: replay costs nothing, PII is
 * refused with the event's INDEX and never its content, and an oversized
 * batch is refused loudly rather than trimmed.
 *
 *   DATABASE_URL=postgresql://shikhon_runtime:… node --test services/ops-svc/test/events.test.ts
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { createDb, type Db, type TenantContext } from '../../../packages/server-core/src/db.ts';
import { installTestKeys, call } from '../../../packages/server-core/test/harness.ts';

const DATABASE_URL = process.env.DATABASE_URL;
const skip = !DATABASE_URL ? 'DATABASE_URL not set' : false;

const T       = '7ac00000-0000-4000-8000-00000000000a';
const STUDENT = '7ac00000-0000-4000-8000-0000000000a1';
const HEAD    = '7ac00000-0000-4000-8000-0000000000ff';

let db: Db;
let studentToken: string;
let events: typeof import('../api/events.ts').default;
const asHead: TenantContext = { tenantId: T, userId: HEAD, role: 'principal' };

async function dropFixtures(): Promise<void> {
  await db.withTenant(asHead, async (c) => {
    await c.query('DELETE FROM tenants WHERE id = $1', [T]);
  });
}

describe('event ingest (F-1503)', { skip }, () => {
  before(async () => {
    await installTestKeys();
    db = createDb(DATABASE_URL as string);
    await dropFixtures();
    await db.withTenant(asHead, async (c) => {
      await c.query(
        `INSERT INTO tenants (id, slug, name_bn, name_en, stream, level)
         VALUES ($1,'f1503','ইভেন্ট','Events','bangla_medium','secondary')`, [T]);
      await c.query(
        `INSERT INTO users (id, tenant_id, full_name_bn, full_name_en, phone_e164, status) VALUES
           ($1,$3,'ছাত্র','Student','+8801799500001','active'),
           ($2,$3,'অধ্যক্ষ','Head','+8801799500002','active')`, [STUDENT, HEAD, T]);
    });
    const { signAccessToken } = await import('../../../packages/server-core/src/jwt.ts');
    studentToken = await signAccessToken({
      sub: STUDENT, tid: T, role: 'student', roles: ['student'] });
    events = (await import('../api/events.ts')).default;
  });
  after(async () => { if (db) { await dropFixtures(); await db.end(); } });

  const wire = (over: Record<string, unknown> = {}) => ({
    id: randomUUID(),
    type: 'engagement.chapter_opened',
    occurredAt: new Date(Date.now() - 60_000).toISOString(),
    payload: { chapterId: 'c1' },
    ...over,
  });

  const post = (body: unknown, token = studentToken) =>
    call(events, { method: 'POST', url: '/api/v1/ops/events', token, body });

  test('a batch lands, and a REPLAY of it counts nothing twice', async () => {
    const batch = [wire(), wire(), wire()];
    const first = await post({ events: batch });
    assert.equal(first.status, 200);
    assert.deepEqual(first.body, { accepted: 3, duplicates: 0 });

    // The client sent, timed out, and sent again — the normal offline
    // story, and the reason the id is client-generated.
    const again = await post({ events: batch });
    assert.deepEqual(again.body, { accepted: 0, duplicates: 3 });

    await db.withTenant(asHead, async (c) => {
      const n = await c.query<{ count: string }>(
        `SELECT count(*) FROM product_events WHERE tenant_id = $1`, [T]);
      assert.equal(n.rows[0].count, '3');
    });
  });

  test('THE ONE THAT MATTERS — PII is refused by index, never echoed', async () => {
    const r = await post({
      events: [wire(), wire({ payload: { studentName: 'আনিকা রহমান' } })],
    });
    assert.equal(r.status, 400);
    const b = r.body as { error: string; message: string };
    assert.equal(b.error, 'payload_rejected');
    assert.match(b.message, /event 1/);
    // The refusal must not carry the thing it refused: an error message
    // is a log line, and keeping PII out of log lines is the whole point.
    assert.ok(!JSON.stringify(r.body).includes('আনিকা'));
  });

  test('a refused batch writes NOTHING — all or nothing per request', async () => {
    await db.withTenant(asHead, async (c) => {
      const before = await c.query<{ count: string }>(
        `SELECT count(*) FROM product_events WHERE tenant_id = $1`, [T]);
      const r = await post({
        events: [wire(), wire({ payload: { phone: '+8801712345678' } })],
      });
      assert.equal(r.status, 400);
      const after = await c.query<{ count: string }>(
        `SELECT count(*) FROM product_events WHERE tenant_id = $1`, [T]);
      assert.equal(after.rows[0].count, before.rows[0].count,
        'the clean event in the batch must not land while its sibling is refused — '
        + 'the client will retry the whole batch and the ids make that free');
    });
  });

  test('an oversized batch is refused loudly, never trimmed', async () => {
    const r = await post({ events: Array.from({ length: 101 }, () => wire()) });
    assert.equal(r.status, 413);
    assert.equal((r.body as { error: string }).error, 'batch_too_large');
  });

  test('a clock claiming the future is refused', async () => {
    // Offline explains a LATE clock; nothing explains an early one, and it
    // would poison the day it rolls into.
    const r = await post({
      events: [wire({ occurredAt: new Date(Date.now() + 3_600_000).toISOString() })],
    });
    assert.equal(r.status, 400);
    assert.equal((r.body as { error: string }).error, 'clock_ahead');
  });

  test('unauthenticated requests are rejected before any parsing matters', async () => {
    const r = await call(events, {
      method: 'POST', url: '/api/v1/ops/events', body: { events: [wire()] } });
    assert.equal(r.status, 401);
  });

  test('a malformed event names its index and field', async () => {
    const r = await post({ events: [wire(), wire({ type: 'clicked_button' })] });
    assert.equal(r.status, 400);
    assert.match((r.body as { message: string }).message, /event 1: type/);
  });
});
