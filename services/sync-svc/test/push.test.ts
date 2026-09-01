/**
 * Integration tests for POST /sync/push against a REAL PostgreSQL database.
 *
 * Not mocked, on purpose: the properties being asserted (idempotency, RLS
 * isolation, ON CONFLICT merge semantics, published-mark immutability) all live
 * in the database. A mock would assert that the mock works.
 *
 *   DATABASE_URL=postgres://… node --test services/sync-svc/test/push.test.ts
 *
 * The suite provisions its own tenant and drops it at the end, so it is safe to
 * point at any environment.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { createDb, assertRlsEnforced, type Db, type TenantContext } from '../src/db.ts';
import { lockFixtures, unlockFixtures } from '../../../packages/server-core/test/harness.ts';
import { SyncPushHandler } from '../src/push.ts';
import type { OutboxOp, PushRequest } from '../../../packages/offline/src/types.ts';

const DATABASE_URL = process.env.DATABASE_URL;
const skip = !DATABASE_URL ? 'DATABASE_URL not set' : false;

const TENANT_A = '8a000000-0000-4000-8000-00000000000a';
const TENANT_B = '8b000000-0000-4000-8000-00000000000b';
const TEACHER = '8a000000-0000-4000-8000-0000000000t1'.replace('t1', 'a1');
const DEVICE = 'dev_sync_test';

let db: Db;
let handler: SyncPushHandler;
let ctxA: TenantContext;
let ctxB: TenantContext;
let sectionId: string;
let yearId: string;
let studentIds: string[] = [];
let seq = 0;

const nextOp = (over: Partial<OutboxOp> & Pick<OutboxOp, 'entity' | 'payload'>): OutboxOp => ({
  opId: crypto.randomUUID(),
  seq: ++seq,
  deviceId: DEVICE,
  tenantId: TENANT_A,
  actorId: TEACHER,
  operation: 'upsert',
  occurredAt: new Date().toISOString(),
  status: 'pending',
  attempts: 0,
  nextAttemptAt: 0,
  ...over,
});

const push = (ops: OutboxOp[], ctx = ctxA): Promise<ReturnType<SyncPushHandler['handle']>> => {
  const req: PushRequest = { deviceId: DEVICE, clientTime: new Date().toISOString(), ops };
  return handler.handle(req, ctx) as never;
};

/* ------------------------------------------------------------------ set-up */

before(async () => {
  if (skip) return;
  // Serialised against other runs of this same suite — the fixtures below
  // live at fixed uuids and two processes would delete each other's.
  await lockFixtures(DATABASE_URL as string);
  db = createDb(DATABASE_URL!);
  handler = new SyncPushHandler(db);

  ctxA = { tenantId: TENANT_A, userId: TEACHER, role: 'principal' };
  ctxB = { tenantId: TENANT_B, userId: TEACHER, role: 'principal' };

  await cleanup();

  // Tenant A: a fully provisioned institution with a section and 3 students.
  await db.withTenant(ctxA, async (c) => {
    await c.query(
      `INSERT INTO tenants (id, slug, name_bn, name_en, stream, level, shifts)
       VALUES ($1,'sync-test-a','সিঙ্ক ক','Sync A','bangla_medium','secondary','{day}')`,
      [TENANT_A],
    );
    await c.query(`SELECT app.provision_tenant($1::uuid,'2026','2026-01-01'::date,'2026-12-31'::date,9::smallint,10::smallint)`, [TENANT_A]);

    await c.query(
      `INSERT INTO users (id, tenant_id, full_name_bn, full_name_en, phone_e164)
       VALUES ($1, app.current_tenant(), 'রহিম', 'Rahim', '+8801799000001')`,
      [TEACHER],
    );

    const { rows: yr } = await c.query(`SELECT id FROM academic_years WHERE label='2026'`);
    yearId = yr[0].id;
    const { rows: cl } = await c.query(`SELECT id FROM classes WHERE level_no = 9`);
    const { rows: sec } = await c.query(
      `INSERT INTO sections (tenant_id, class_id, academic_year_id, name, shift)
       VALUES (app.current_tenant(), $1, $2, 'ক', 'day') RETURNING id`,
      [cl[0].id, yearId],
    );
    sectionId = sec[0].id;

    studentIds = [];
    for (let i = 1; i <= 3; i++) {
      const { rows } = await c.query(
        `INSERT INTO users (tenant_id, full_name_bn, full_name_en, phone_e164)
         VALUES (app.current_tenant(), $1, $2, $3) RETURNING id`,
        [`ছাত্র ${i}`, `Student ${i}`, `+880179900010${i}`],
      );
      studentIds.push(rows[0].id);
      await c.query(
        `INSERT INTO enrolments (tenant_id, student_id, section_id, academic_year_id, roll_no)
         VALUES (app.current_tenant(), $1, $2, $3, $4)`,
        [rows[0].id, sectionId, yearId, i],
      );
    }
  });

  // Tenant B exists only to prove it stays invisible.
  await db.withTenant(ctxB, async (c) => {
    await c.query(
      `INSERT INTO tenants (id, slug, name_bn, name_en, stream, level)
       VALUES ($1,'sync-test-b','সিঙ্ক খ','Sync B','madrasah','secondary')`,
      [TENANT_B],
    );
  });
});

after(async () => {
  if (skip) return;
  await cleanup();
  await db.end(); await unlockFixtures();
});

async function cleanup() {
  for (const [t, ctx] of [[TENANT_A, ctxA], [TENANT_B, ctxB]] as const) {
    try {
      await db.withTenant(ctx ?? { tenantId: t, userId: TEACHER, role: 'principal' }, async (c) => {
        await c.query(`DELETE FROM sync_operations WHERE tenant_id = $1`, [t]);
        await c.query(`DELETE FROM tenants WHERE id = $1`, [t]);
      });
    } catch { /* first run: nothing to clean */ }
  }
}

const attendanceOp = (
  statuses: Array<'present' | 'absent' | 'late'>,
  over: Partial<OutboxOp> = {},
  takenOn = '2026-08-06',
) =>
  nextOp({
    entity: 'attendance_session',
    payload: {
      sessionId: crypto.randomUUID(),
      sectionId,
      academicYearId: yearId,
      takenOn,
      mode: 'section_daily',
      records: studentIds.map((id, i) => ({ studentId: id, status: statuses[i] ?? 'present' })),
    },
    ...over,
  });

/* ------------------------------------------------------------------- tests */

describe('boot guard', { skip }, () => {
  test('refuses to run as a BYPASSRLS role', async () => {
    // The Neon owner has BYPASSRLS; the runtime role does not. Whichever this
    // suite is pointed at, the guard must agree with pg_roles.
    const { rows } = await db.pool.query(
      `SELECT rolbypassrls OR rolsuper AS privileged FROM pg_roles WHERE rolname = current_user`,
    );
    if (rows[0].privileged) {
      await assert.rejects(() => assertRlsEnforced(db), /refusing to start/);
    } else {
      await assert.doesNotReject(() => assertRlsEnforced(db));
    }
  });
});

describe('idempotency — the 2G resend', { skip }, () => {
  test('the same op sent twice applies once and reports duplicate', async () => {
    const op = attendanceOp(['present', 'absent', 'present']);

    const first = await push([op]);
    assert.equal(first.results[0].status, 'applied');
    assert.equal(first.results[0].sideEffects?.records, 3);

    const second = await push([op]);
    assert.equal(second.results[0].status, 'duplicate', 'replay must not re-apply');

    await db.withTenant(ctxA, async (c) => {
      const { rows } = await c.query(
        `SELECT count(*)::int AS n FROM attendance_records WHERE session_id = $1`,
        [(op.payload as { sessionId: string }).sessionId],
      );
      assert.equal(rows[0].n, 3, 'exactly one set of records');
    });
  });

  test('a whole batch resent after a dropped response is fully absorbed', async () => {
    const ops = [
      attendanceOp(['present', 'present', 'present'], {}, '2026-08-10'),
      attendanceOp(['absent', 'present', 'present'], {}, '2026-08-11'),
    ];
    const a = await push(ops);
    assert.deepEqual(a.results.map((r) => r.status), ['applied', 'applied']);

    const b = await push(ops); // client never saw the first response
    assert.deepEqual(b.results.map((r) => r.status), ['duplicate', 'duplicate']);
  });

  test('two different ops for the same section+day merge, they do not duplicate', async () => {
    // Same natural key, different opId — e.g. the teacher re-marked the register.
    const day = '2026-08-12';
    const first = attendanceOp(['present', 'present', 'present'], {}, day);
    const second = attendanceOp(['absent', 'absent', 'present'], {}, day);

    assert.equal((await push([first])).results[0].status, 'applied');
    assert.equal((await push([second])).results[0].status, 'applied');

    await db.withTenant(ctxA, async (c) => {
      const { rows } = await c.query(
        `SELECT count(*)::int AS n FROM attendance_sessions
          WHERE section_id = $1 AND taken_on = $2`,
        [sectionId, day],
      );
      assert.equal(rows[0].n, 1,
        'UNIQUE NULLS NOT DISTINCT merged the daily session instead of duplicating it');
    });
  });
});

describe('tenant isolation', { skip }, () => {
  test('an op claiming another tenant is rejected outright', async () => {
    const op = attendanceOp(['present', 'present', 'present'], { tenantId: TENANT_B }, '2026-08-13');
    const res = await push([op]);
    assert.equal(res.results[0].status, 'rejected');
    assert.equal(res.results[0].error?.code, 'TENANT_MISMATCH');
    assert.equal(res.results[0].error?.retryable, false, 'never retry an isolation breach');
  });

  test("tenant B's session cannot reach tenant A's section", async () => {
    // Same payload, but pushed under tenant B's context: RLS hides the section.
    const op = attendanceOp(['present', 'present', 'present'], { tenantId: TENANT_B }, '2026-08-14');
    const res = await push([op], ctxB);
    assert.equal(res.results[0].status, 'rejected');
    assert.equal(res.results[0].error?.code, 'SECTION_NOT_ASSIGNED',
      'RLS made the foreign section invisible');
  });
});

describe('per-op isolation', { skip }, () => {
  test('one bad op does not roll back the good ones in the batch', async () => {
    const good1 = attendanceOp(['present', 'present', 'present'], {}, '2026-08-17');
    const bad = nextOp({ entity: 'attendance_session', payload: { nonsense: true } });
    const good2 = attendanceOp(['absent', 'present', 'present'], {}, '2026-08-18');

    const res = await push([good1, bad, good2]);
    assert.deepEqual(res.results.map((r) => r.status), ['applied', 'rejected', 'applied'],
      'a malformed op must not wedge the whole outbox');
    assert.equal(res.results[1].error?.code, 'MALFORMED_PAYLOAD');
    assert.equal(res.results[1].error?.retryable, false);
  });

  test('ops are applied in author order regardless of array order', async () => {
    const a = attendanceOp(['present', 'present', 'present'], {}, '2026-08-19');
    const b = attendanceOp(['absent', 'absent', 'absent'], {}, '2026-08-19');
    // b was authored after a; deliver them reversed.
    const res = await push([b, a]);
    assert.equal(res.results.length, 2);
    assert.equal(res.results[0].opId, a.opId, 'lower seq applied first');
  });

  test('an unknown entity is rejected, not silently swallowed', async () => {
    const res = await push([nextOp({ entity: 'routine_slot' as never, payload: {} })]);
    assert.equal(res.results[0].error?.code, 'UNSUPPORTED_ENTITY');
  });
});

describe('absence side effects', { skip }, () => {
  test('absent records are queued for SMS and raise a domain event', async () => {
    const day = '2026-08-20';
    const op = attendanceOp(['absent', 'late', 'present'], {}, day);
    const res = await push([op]);
    assert.equal(res.results[0].sideEffects?.smsQueued, 2, 'absent + late');

    await db.withTenant(ctxA, async (c) => {
      const { rows: q } = await c.query(
        `SELECT count(*)::int AS n FROM attendance_records
          WHERE taken_on = $1 AND sms_state = 'queued'`,
        [day],
      );
      assert.equal(q[0].n, 2);

      const { rows: ev } = await c.query(
        `SELECT count(*)::int AS n FROM event_outbox
          WHERE event_type = 'attendance.marked.v1'
            AND payload->>'takenOn' = $1`,
        [day],
      );
      assert.equal(ev[0].n, 2, 'transactional outbox event per absence');
    });
  });

  test('present-only attendance queues nothing', async () => {
    const day = '2026-08-21';
    const res = await push([attendanceOp(['present', 'present', 'present'], {}, day)]);
    assert.equal(res.results[0].sideEffects?.smsQueued, 0);
  });
});

describe('exam marks', { skip }, () => {
  let examSubjectId: string;

  before(async () => {
    if (skip) return;
    await db.withTenant(ctxA, async (c) => {
      const { rows: ex } = await c.query(
        `INSERT INTO exams (tenant_id, academic_year_id, name_bn, name_en, exam_type, status)
         VALUES (app.current_tenant(), $1, 'বার্ষিক', 'Annual', 'annual', 'marking') RETURNING id`,
        [yearId],
      );
      const { rows: sub } = await c.query(`SELECT id FROM subjects WHERE name_en='Mathematics' LIMIT 1`);
      const { rows: es } = await c.query(
        `INSERT INTO exam_subjects (tenant_id, exam_id, section_id, subject_id)
         VALUES (app.current_tenant(), $1, $2, $3) RETURNING id`,
        [ex[0].id, sectionId, sub[0].id],
      );
      examSubjectId = es[0].id;
    });
  });

  test('marks apply and return an incrementing row version', async () => {
    const res = await push([
      nextOp({
        entity: 'exam_mark',
        payload: { examSubjectId, studentId: studentIds[0], academicYearId: yearId, cqMarks: 60, mcqMarks: 25 },
      }),
    ]);
    assert.equal(res.results[0].status, 'applied');
    assert.equal(res.results[0].rowVersion, 1);
  });

  test('a stale baseVersion is reported as a conflict, not clobbered', async () => {
    await push([
      nextOp({
        entity: 'exam_mark',
        payload: { examSubjectId, studentId: studentIds[1], academicYearId: yearId, cqMarks: 50, mcqMarks: 20 },
      }),
    ]);
    const res = await push([
      nextOp({
        entity: 'exam_mark',
        baseVersion: 99,
        payload: { examSubjectId, studentId: studentIds[1], academicYearId: yearId, cqMarks: 70, mcqMarks: 30 },
      }),
    ]);
    assert.equal(res.results[0].status, 'conflict');
    assert.equal(res.results[0].conflict?.reason, 'version_conflict');
  });

  test('published marks are immutable and the client is told why', async () => {
    await db.withTenant(ctxA, async (c) => {
      await c.query(
        `UPDATE exams SET status='published', published_at=now()
          WHERE id = (SELECT exam_id FROM exam_subjects WHERE id=$1)`,
        [examSubjectId],
      );
    });

    const res = await push([
      nextOp({
        entity: 'exam_mark',
        payload: { examSubjectId, studentId: studentIds[0], academicYearId: yearId, cqMarks: 70, mcqMarks: 30 },
      }),
    ]);
    assert.equal(res.results[0].status, 'conflict');
    assert.equal(res.results[0].conflict?.reason, 'published_marks_immutable');

    await db.withTenant(ctxA, async (c) => {
      const { rows } = await c.query(
        `SELECT cq_marks FROM exam_marks WHERE exam_subject_id=$1 AND student_id=$2`,
        [examSubjectId, studentIds[0]],
      );
      assert.equal(Number(rows[0].cq_marks), 60, 'the published mark was NOT overwritten');
    });
  });

  test('a conflicted op replays as the same conflict, not as a duplicate', async () => {
    const op = nextOp({
      entity: 'exam_mark',
      payload: { examSubjectId, studentId: studentIds[2], academicYearId: yearId, cqMarks: 40, mcqMarks: 20 },
    });
    const a = await push([op]);
    assert.equal(a.results[0].status, 'conflict');
    const b = await push([op]);
    assert.equal(b.results[0].status, 'conflict', 'replay is answered consistently');
  });
});

describe('clock skew', { skip }, () => {
  test('the response reports the client/server offset', async () => {
    const skewMs = 120_000;
    const req: PushRequest = {
      deviceId: DEVICE,
      clientTime: new Date(Date.now() + skewMs).toISOString(),
      ops: [],
    };
    const res = await handler.handle(req, ctxA);
    assert.ok(res.clockSkewMs !== undefined);
    assert.ok(Math.abs(res.clockSkewMs! - skewMs) < 5000, `skew ≈ ${skewMs}ms, got ${res.clockSkewMs}`);
  });
});

describe('batch limits', { skip }, () => {
  test('an oversized batch is truncated rather than accepted wholesale', async () => {
    const small = new SyncPushHandler(db, { maxOps: 2 });
    const ops = [
      attendanceOp(['present', 'present', 'present'], {}, '2026-08-24'),
      attendanceOp(['present', 'present', 'present'], {}, '2026-08-25'),
      attendanceOp(['present', 'present', 'present'], {}, '2026-08-26'),
    ];
    const res = await small.handle({ deviceId: DEVICE, clientTime: new Date().toISOString(), ops }, ctxA);
    assert.equal(res.results.length, 2, 'excess ops are simply not answered, so the client retries them');
  });
});
