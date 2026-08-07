/**
 * The complete chain, unmocked end to end.
 *
 *   DOM tap  →  AttendanceGrid  →  SyncEngine outbox  →  SyncPushHandler
 *            →  RLS-scoped PostgreSQL  →  absence SMS queued
 *
 * Every layer is the real implementation. The only thing standing in for
 * production is the HTTP hop (a direct call) and the browser (jsdom).
 *
 * This is the test that proves the product works, rather than that its parts
 * work individually.
 *
 *   DATABASE_URL=postgres://…  node --test test/vertical-slice.test.ts
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

import { createDb, type Db, type TenantContext } from '../src/db.ts';
import { SyncPushHandler } from '../src/push.ts';
import { SyncEngine } from '../../../packages/offline/src/sync-engine.ts';
import { MemoryOutboxStore } from '../../../packages/offline/src/store.ts';
import { AttendanceView } from '../../../apps/pwa/src/attendance-view.ts';
import type { Student } from '../../../packages/ui-core/src/attendance-grid.ts';
import type { PushRequest, PushResponse, SyncTransport } from '../../../packages/offline/src/types.ts';

const DATABASE_URL = process.env.DATABASE_URL;
const skip = !DATABASE_URL ? 'DATABASE_URL not set' : false;

const TENANT = '9c000000-0000-4000-8000-00000000000c';
const TEACHER = '9c000000-0000-4000-8000-0000000000c1';
const TAKEN_ON = '2026-10-15';

let db: Db;
let ctx: TenantContext;
let dom: JSDOM;
let doc: Document;
let sectionId: string;
let yearId: string;
let roster: Student[] = [];

/** The HTTP hop, minus HTTP. Can be switched offline. */
class DirectTransport implements SyncTransport {
  online = true;
  private readonly handler: SyncPushHandler;
  private readonly c: TenantContext;
  constructor(handler: SyncPushHandler, c: TenantContext) {
    this.handler = handler;
    this.c = c;
  }
  async push(req: PushRequest): Promise<PushResponse> {
    if (!this.online) throw new Error('Failed to fetch');
    const wire = JSON.parse(JSON.stringify(req)) as PushRequest;
    return JSON.parse(JSON.stringify(await this.handler.handle(wire, this.c))) as PushResponse;
  }
}

before(async () => {
  if (skip) return;

  dom = new JSDOM('<!doctype html><html><body><main id="root"></main></body></html>');
  doc = dom.window.document;
  (globalThis as Record<string, unknown>).HTMLElement = dom.window.HTMLElement;
  (globalThis as Record<string, unknown>).KeyboardEvent = dom.window.KeyboardEvent;

  db = createDb(DATABASE_URL!);
  ctx = { tenantId: TENANT, userId: TEACHER, role: 'principal' };
  await cleanup();

  await db.withTenant(ctx, async (c) => {
    await c.query(
      `INSERT INTO tenants (id, slug, name_bn, name_en, stream, level, shifts)
       VALUES ($1,'vertical-slice','উল্লম্ব','Vertical','bangla_medium','secondary','{day}')`,
      [TENANT],
    );
    await c.query(
      `SELECT app.provision_tenant($1::uuid,'2026','2026-01-01'::date,'2026-12-31'::date,9::smallint,10::smallint)`,
      [TENANT],
    );
    await c.query(
      `INSERT INTO users (id, tenant_id, full_name_bn, full_name_en, phone_e164)
       VALUES ($1, app.current_tenant(), 'রহিম স্যার', 'Rahim Sir', '+8801795000001')`,
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

    roster = [];
    for (let roll = 1; roll <= 60; roll++) {
      const id = (
        await c.query(
          `INSERT INTO users (tenant_id, full_name_bn, full_name_en, phone_e164)
           VALUES (app.current_tenant(), $1, $2, $3) RETURNING id`,
          [`শিক্ষার্থী ${roll}`, `Student ${roll}`, `+880179${String(5000100 + roll).padStart(7, '0')}`],
        )
      ).rows[0].id;
      roster.push({ studentId: id, rollNo: roll, nameBn: `শিক্ষার্থী ${roll}`, nameEn: `Student ${roll}` });
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
  } catch { /* first run */ }
}

function mountScreen() {
  const store = new MemoryOutboxStore();
  const transport = new DirectTransport(new SyncPushHandler(db), ctx);
  let offset = 0;
  const engine = new SyncEngine({
    deviceId: 'dev_vertical',
    tenantId: TENANT,
    actorId: TEACHER,
    store,
    transport,
    now: () => Date.now() + offset,
  });

  const root = doc.getElementById('root')!;
  const view = new AttendanceView({
    root,
    doc,
    students: roster,
    section: { id: sectionId, labelBn: '৯-ক', academicYearId: yearId },
    takenOn: TAKEN_ON,
    subjectBn: 'পদার্থবিজ্ঞান',
    outbox: engine,
    newId: () => crypto.randomUUID(),
  });

  const tapRoll = (roll: number) => {
    const t = root.querySelector<HTMLButtonElement>(
      `.tile[data-student-id="${roster[roll - 1].studentId}"]`,
    )!;
    t.dispatchEvent(new dom.window.Event('click'));
    return t;
  };

  return { view, root, engine, store, transport, tapRoll, advance: (ms: number) => { offset += ms; } };
}

describe('vertical slice: tap → outbox → server → database', { skip }, () => {
  test('a teacher marks a register offline and it lands in PostgreSQL', async () => {
    const { view, root, engine, store, transport, tapRoll, advance } = mountScreen();

    // ── 07:12, no signal at all ────────────────────────────────────────
    transport.online = false;

    // Rolls 7, 23 and 44 are absent. Three taps, not sixty.
    for (const roll of [7, 23, 44]) {
      const t = tapRoll(roll);
      assert.equal(t.dataset.status, 'absent');
    }
    // Roll 12 is late: two taps.
    tapRoll(12); tapRoll(12);
    assert.equal(
      root.querySelector<HTMLButtonElement>(
        `.tile[data-student-id="${roster[11].studentId}"]`,
      )!.dataset.status,
      'late',
    );

    assert.ok(
      root.querySelector('.att-counts')!.textContent!.includes('উপস্থিত ৫৬'),
      'counters reflect 56 present / 3 absent / 1 late',
    );

    // Save — must not throw, must not await the network.
    const saved = await view.save();
    assert.equal(saved.queued, true);
    await saved.flushed;   // let the background attempt fail before we retry
    assert.equal((await store.all()).length, 1, 'one durable op holding the whole register');
    assert.equal(root.querySelector('.sync-chip')!.getAttribute('data-state'), 'queued');

    // ── 11:40, back on 2G ─────────────────────────────────────────────
    transport.online = true;
    advance(4 * 60 * 60 * 1000);   // the backoff from the failed attempt has elapsed
    const flushed = await engine.flush();

    assert.equal(flushed.acked, 1, 'delivered');
    assert.equal((await store.all()).length, 0, 'outbox drained');
    await view.paintChip();
    assert.equal(root.querySelector('.sync-chip')!.getAttribute('data-state'), 'synced');

    // ── What actually reached the database ────────────────────────────
    await db.withTenant(ctx, async (c) => {
      const { rows } = await c.query(
        `SELECT count(*)::int                                        AS total,
                count(*) FILTER (WHERE status='present')::int        AS present,
                count(*) FILTER (WHERE status='absent')::int         AS absent,
                count(*) FILTER (WHERE status='late')::int           AS late,
                count(*) FILTER (WHERE sms_state='queued')::int      AS sms_queued
           FROM attendance_records WHERE taken_on = $1`,
        [TAKEN_ON],
      );
      assert.deepEqual(rows[0], { total: 60, present: 56, absent: 3, late: 1, sms_queued: 4 },
        'every student persisted; absent+late queued for SMS');

      const { rows: sess } = await c.query(
        `SELECT present_count, absent_count, late_count, mode
           FROM attendance_sessions WHERE taken_on = $1`,
        [TAKEN_ON],
      );
      assert.equal(sess.length, 1);
      assert.equal(sess[0].present_count, 56);
      assert.equal(sess[0].absent_count, 3);
      assert.equal(sess[0].late_count, 1);
      assert.equal(sess[0].mode, 'section_daily');

      // The transactional outbox raised one domain event per absence/lateness,
      // which is what the SMS worker consumes.
      const { rows: ev } = await c.query(
        `SELECT count(*)::int AS n FROM event_outbox
          WHERE event_type='attendance.marked.v1' AND payload->>'takenOn' = $1`,
        [TAKEN_ON],
      );
      assert.equal(ev[0].n, 4, 'one attendance.marked.v1 per absent/late student');

      // The right students, by roll number.
      const { rows: absentRolls } = await c.query(
        `SELECT e.roll_no FROM attendance_records ar
           JOIN enrolments e ON e.student_id = ar.student_id AND e.section_id = ar.section_id
          WHERE ar.taken_on = $1 AND ar.status = 'absent' ORDER BY e.roll_no`,
        [TAKEN_ON],
      );
      assert.deepEqual(absentRolls.map((r) => r.roll_no), [7, 23, 44]);
    });
  });

  test('re-saving the same register merges instead of duplicating', async () => {
    const { view, engine, transport, tapRoll, advance } = mountScreen();
    transport.online = true;

    tapRoll(9);                       // roll 9 absent
    await (await view.save()).flushed;

    // The teacher notices a mistake and re-marks the same day.
    const second = mountScreen();
    second.transport.online = true;
    second.tapRoll(9);                // absent again
    second.tapRoll(9);                // ...no, late
    await (await second.view.save()).flushed;

    await db.withTenant(ctx, async (c) => {
      const { rows } = await c.query(
        `SELECT count(*)::int AS sessions FROM attendance_sessions WHERE taken_on = $1`,
        [TAKEN_ON],
      );
      assert.equal(rows[0].sessions, 1,
        'UNIQUE NULLS NOT DISTINCT merged the daily session — no duplicate register');

      const { rows: rec } = await c.query(
        `SELECT count(*)::int AS n FROM attendance_records WHERE taken_on = $1`,
        [TAKEN_ON],
      );
      assert.equal(rec[0].n, 60, 'still exactly one row per student');
    });
    advance(0);
  });
});
