/**
 * The whole loop, unmocked.
 *
 * The real client SyncEngine is wired to the real SyncPushHandler against the
 * real database. Nothing between them is stubbed except the HTTP hop itself —
 * so this asserts that the two halves genuinely agree on the protocol, which
 * unit tests on either side cannot.
 *
 *   DATABASE_URL=postgres://… node --test test/e2e-client-server.test.ts
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { createDb, type Db, type TenantContext } from '../src/db.ts';
import { SyncPushHandler } from '../src/push.ts';
import { SyncEngine } from '../../../packages/offline/src/sync-engine.ts';
import { MemoryOutboxStore } from '../../../packages/offline/src/store.ts';
import type { PushRequest, PushResponse, SyncTransport } from '../../../packages/offline/src/types.ts';

const DATABASE_URL = process.env.DATABASE_URL;
const skip = !DATABASE_URL ? 'DATABASE_URL not set' : false;

const TENANT = '8e000000-0000-4000-8000-00000000000e';
const TEACHER = '8e000000-0000-4000-8000-0000000000e1';

let db: Db;
let ctx: TenantContext;
let sectionId: string;
let yearId: string;
let studentIds: string[] = [];

/** Stands in for fetch('/api/v1/sync/push'). Can be switched offline. */
class DirectTransport implements SyncTransport {
  online = true;
  requests = 0;
  private readonly handler: SyncPushHandler;
  private readonly c: TenantContext;

  constructor(handler: SyncPushHandler, c: TenantContext) {
    this.handler = handler;
    this.c = c;
  }
  async push(req: PushRequest): Promise<PushResponse> {
    this.requests++;
    if (!this.online) throw new Error('Failed to fetch');
    // Round-trip through JSON exactly as the wire would.
    const wire = JSON.parse(JSON.stringify(req)) as PushRequest;
    return JSON.parse(JSON.stringify(await this.handler.handle(wire, this.c))) as PushResponse;
  }
}

before(async () => {
  if (skip) return;
  db = createDb(DATABASE_URL!);
  ctx = { tenantId: TENANT, userId: TEACHER, role: 'principal' };
  await cleanup();

  await db.withTenant(ctx, async (c) => {
    await c.query(
      `INSERT INTO tenants (id, slug, name_bn, name_en, stream, level, shifts)
       VALUES ($1,'e2e-loop','লুপ','Loop','bangla_medium','secondary','{day}')`,
      [TENANT],
    );
    await c.query(
      `SELECT app.provision_tenant($1::uuid,'2026','2026-01-01'::date,'2026-12-31'::date,9::smallint,10::smallint)`,
      [TENANT],
    );
    await c.query(
      `INSERT INTO users (id, tenant_id, full_name_bn, full_name_en, phone_e164)
       VALUES ($1, app.current_tenant(), 'রহিম স্যার', 'Rahim Sir', '+8801798000001')`,
      [TEACHER],
    );

    yearId = (await c.query(`SELECT id FROM academic_years WHERE label='2026'`)).rows[0].id;
    const classId = (await c.query(`SELECT id FROM classes WHERE level_no=9`)).rows[0].id;
    sectionId = (
      await c.query(
        `INSERT INTO sections (tenant_id, class_id, academic_year_id, name, shift, capacity)
         VALUES (app.current_tenant(), $1, $2, 'ক', 'day', 60) RETURNING id`,
        [classId, yearId],
      )
    ).rows[0].id;

    studentIds = [];
    for (let roll = 1; roll <= 60; roll++) {
      const id = (
        await c.query(
          `INSERT INTO users (tenant_id, full_name_bn, full_name_en, phone_e164)
           VALUES (app.current_tenant(), $1, $2, $3) RETURNING id`,
          // Distinct band from the teacher's number: roll 1 previously
          // generated exactly +8801798000001 and collided.
          [`শিক্ষার্থী ${roll}`, `Student ${roll}`, `+880179${String(9000000 + roll).padStart(7, '0')}`],
        )
      ).rows[0].id;
      studentIds.push(id);
      await c.query(
        `INSERT INTO enrolments (tenant_id, student_id, section_id, academic_year_id, roll_no)
         VALUES (app.current_tenant(), $1, $2, $3, $4)`,
        [id, sectionId, yearId, roll],
      );
    }
  });
});

after(async () => {
  if (skip) return;
  await cleanup();
  await db.end();
});

async function cleanup() {
  try {
    await db.withTenant({ tenantId: TENANT, userId: TEACHER, role: 'principal' }, async (c) => {
      await c.query(`DELETE FROM sync_operations WHERE tenant_id = $1`, [TENANT]);
      await c.query(`DELETE FROM tenants WHERE id = $1`, [TENANT]);
    });
  } catch { /* nothing to clean on first run */ }
}

/**
 * A controllable clock. After a failed flush the op is legitimately backed off
 * into the future, so "come back online and retry" has to advance time — the
 * same thing that happens when the teacher's phone reconnects hours later.
 */
function makeClient(transport: SyncTransport) {
  const store = new MemoryOutboxStore();
  let offset = 0;
  const engine = new SyncEngine({
    deviceId: 'dev_e2e_phone',
    tenantId: TENANT,
    actorId: TEACHER,
    store,
    transport,
    now: () => Date.now() + offset,
  });
  const advance = (ms: number) => { offset += ms; };
  return { engine, store, advance };
}

describe('client ↔ server, no mocks between them', { skip }, () => {
  test('a full section marked with no signal reaches the database intact', async () => {
    const transport = new DirectTransport(new SyncPushHandler(db), ctx);
    const { engine, store, advance } = makeClient(transport);

    // 07:12 — no signal. Roll 20, 40, 60 are absent.
    transport.online = false;
    const sessionId = crypto.randomUUID();
    await engine.enqueue({
      entity: 'attendance_session',
      opId: sessionId,
      payload: {
        sessionId,
        sectionId,
        academicYearId: yearId,
        takenOn: '2026-09-01',
        mode: 'section_daily',
        records: studentIds.map((id, i) => ({
          studentId: id,
          status: (i + 1) % 20 === 0 ? 'absent' : 'present',
        })),
      },
    });

    await engine.flush();
    assert.equal((await engine.state()).pending, 1, 'work retained while offline');
    assert.equal((await store.all()).length, 1, 'nothing lost');

    // 11:40 — back on 2G. Time really has passed, so the backoff has elapsed.
    transport.online = true;
    advance(4 * 60 * 60 * 1000);
    const res = await engine.flush();

    assert.equal(res.acked, 1, 'delivered');
    assert.equal((await store.all()).length, 0, 'outbox drained');
    assert.equal((await engine.state()).failed, 0);

    await db.withTenant(ctx, async (c) => {
      const { rows } = await c.query(
        `SELECT count(*)::int AS total,
                count(*) FILTER (WHERE status='absent')::int AS absent,
                count(*) FILTER (WHERE sms_state='queued')::int AS queued
           FROM attendance_records WHERE taken_on = '2026-09-01'`,
      );
      assert.equal(rows[0].total, 60, 'every student persisted');
      assert.equal(rows[0].absent, 3, 'rolls 20/40/60');
      assert.equal(rows[0].queued, 3, 'absence SMS queued for exactly those three');

      const { rows: sess } = await c.query(
        `SELECT present_count, absent_count FROM attendance_sessions WHERE taken_on='2026-09-01'`,
      );
      assert.equal(sess[0].present_count, 57);
      assert.equal(sess[0].absent_count, 3);
    });
  });

  test('a mid-flight failure loses nothing and resends cleanly', async () => {
    const transport = new DirectTransport(new SyncPushHandler(db), ctx);
    const { engine, store, advance } = makeClient(transport);

    // Three days of registers authored offline.
    for (const day of ['2026-09-02', '2026-09-03', '2026-09-04']) {
      const sid = crypto.randomUUID();
      await engine.enqueue({
        entity: 'attendance_session',
        opId: sid,
        payload: {
          sessionId: sid, sectionId, academicYearId: yearId, takenOn: day, mode: 'section_daily',
          records: studentIds.slice(0, 10).map((id) => ({ studentId: id, status: 'present' })),
        },
      });
    }

    transport.online = false;
    await engine.flush();
    assert.equal((await store.all()).length, 3, 'all three survive the failure');

    transport.online = true;
    advance(60 * 60 * 1000);
    await engine.flush();
    const left = await store.all();
    assert.equal(left.length, 0,
      `leftover: ${JSON.stringify(left.map((o) => ({ st: o.status, err: o.lastError, cf: o.conflict?.reason })))}`);

    await db.withTenant(ctx, async (c) => {
      const { rows } = await c.query(
        `SELECT count(DISTINCT taken_on)::int AS days, count(*)::int AS rows
           FROM attendance_records WHERE taken_on BETWEEN '2026-09-02' AND '2026-09-04'`,
      );
      assert.equal(rows[0].days, 3);
      assert.equal(rows[0].rows, 30, '3 days × 10 students, no duplicates');
    });
  });

  test('the client drops its op when the server says the result is published', async () => {
    const handler = new SyncPushHandler(db);
    const transport = new DirectTransport(handler, ctx);
    const { engine, store } = makeClient(transport);

    const { examSubjectId } = await db.withTenant(ctx, async (c) => {
      const examId = (
        await c.query(
          `INSERT INTO exams (tenant_id, academic_year_id, name_bn, name_en, exam_type, status)
           VALUES (app.current_tenant(), $1, 'বার্ষিক', 'Annual', 'annual', 'published') RETURNING id`,
          [yearId],
        )
      ).rows[0].id;
      const subjectId = (await c.query(`SELECT id FROM subjects WHERE name_en='Mathematics' LIMIT 1`)).rows[0].id;
      const esId = (
        await c.query(
          `INSERT INTO exam_subjects (tenant_id, exam_id, section_id, subject_id)
           VALUES (app.current_tenant(), $1, $2, $3) RETURNING id`,
          [examId, sectionId, subjectId],
        )
      ).rows[0].id;
      return { examSubjectId: esId };
    });

    await engine.enqueue({
      entity: 'exam_mark',
      payload: { examSubjectId, studentId: studentIds[0], academicYearId: yearId, cqMarks: 70, mcqMarks: 30 },
    });
    await engine.flush();

    // Server said published_marks_immutable → the client's own policy resolves
    // to server_wins and discards the op. No user prompt, no stuck outbox.
    const rem = await store.all();
    assert.equal(rem.length, 0,
      `server_wins conflicts settle without user intervention; leftover: ${JSON.stringify(
        rem.map((o) => ({ st: o.status, err: o.lastError, cf: o.conflict?.reason, res: o.conflict?.resolution })))}`);
    assert.equal((await engine.state()).conflicts, 0);
  });

  test('clock skew observed by the client comes from the server response', async () => {
    const transport = new DirectTransport(new SyncPushHandler(db), ctx);
    const { engine } = makeClient(transport);
    await engine.enqueue({
      entity: 'class_delivery_log',
      payload: { slotId: crypto.randomUUID(), deliveredOn: '2026-09-05', wasHeld: true },
    });
    await engine.flush();
    // The op references a non-existent slot and is rejected — but the response
    // still carries the offset, which is what is being asserted here.
    assert.equal(typeof engine.clockOffsetMs, 'number');
    assert.ok(Math.abs(engine.clockOffsetMs) < 60_000, 'local clock roughly aligned');
  });
});
