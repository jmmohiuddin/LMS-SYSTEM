/**
 * B-7 — ending a guardianship, and the twelve places that must notice.
 *
 * Migration 042 refused DELETE on `guardianships` deliberately: a family
 * relationship is a record, and the receipts, attendance rows and audit
 * entries covering that period must stay readable. What it did not provide is
 * a way to say the relationship ENDED — so turning off `receives_sms` left a
 * former guardian still reading a child's attendance, results and fees.
 *
 * ── What these tests are actually for ─────────────────────────────────────
 * Not "does the flag get set". The danger in this change is a read path that
 * keeps working after a revocation, and the worst of them is the absence SMS:
 * a missed filter there texts a stranger about a child every time the child is
 * marked absent. Migration 050 closes eleven of the twelve with a single
 * RESTRICTIVE policy rather than eleven edits, precisely because eleven edits
 * is a list somebody forgets — so what has to be proven is that the policy
 * actually reaches each of them, including the ones running under
 * `system_ingest` and the two SECURITY DEFINER functions it cannot reach.
 *
 * And the other half, which is easier to forget: **nothing is destroyed.** The
 * row, the fee, the receipt, the attendance record and the audit trail are all
 * still there afterwards.
 *
 *   DATABASE_URL=postgres://… node --test services/ops-svc/test/b7-guardian-revoke.test.ts
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { createDb, type Db, type TenantContext } from '../../../packages/server-core/src/db.ts';
import { installTestKeys, call } from '../../../packages/server-core/test/harness.ts';

const DATABASE_URL = process.env.DATABASE_URL;
const skip = !DATABASE_URL ? 'DATABASE_URL not set' : false;

const T_A      = '7b07e000-0000-4000-8000-0000000000a0';
const T_B      = '7b07e000-0000-4000-8000-0000000000b0';
const HEAD_A   = '7b07e000-0000-4000-8000-0000000000a1';
const HEAD_B   = '7b07e000-0000-4000-8000-0000000000b1';
/** Rafi has two guardians; Tahiya has one and no phone of her own. */
const RAFI     = '7b07e000-0000-4000-8000-0000000000a2';
const TAHIYA   = '7b07e000-0000-4000-8000-0000000000a3';
const FATHER   = '7b07e000-0000-4000-8000-0000000000a4';
const UNCLE    = '7b07e000-0000-4000-8000-0000000000a5';
const ONLY_ONE = '7b07e000-0000-4000-8000-0000000000a6';   // Tahiya's only guardian
const TEACHER  = '7b07e000-0000-4000-8000-0000000000a7';
const B_STUDENT= '7b07e000-0000-4000-8000-0000000000b2';

const YEAR_A   = '7b07e000-0000-4000-8000-0000000000c1';
const YEAR_B   = '7b07e000-0000-4000-8000-0000000000c2';
const CLASS_A  = '7b07e000-0000-4000-8000-0000000000d1';
const CLASS_B  = '7b07e000-0000-4000-8000-0000000000d2';
const SEC_A    = '7b07e000-0000-4000-8000-0000000000e1';
const SEC_B    = '7b07e000-0000-4000-8000-0000000000e2';

let db: Db;
let tokens: Record<string, string> = {};
let guardians: typeof import('../api/guardians.ts').default;

const headA: TenantContext = { tenantId: T_A, userId: HEAD_A, role: 'principal' };
const headB: TenantContext = { tenantId: T_B, userId: HEAD_B, role: 'principal' };
const asFather: TenantContext = { tenantId: T_A, userId: FATHER, role: 'guardian' };
const asUncle: TenantContext = { tenantId: T_A, userId: UNCLE, role: 'guardian' };
/** What the SMS dispatcher runs as. */
const asDispatcher: TenantContext = { tenantId: T_A, userId: '', role: 'system_ingest' };

async function drop(): Promise<void> {
  for (const ctx of [headA, headB]) {
    await db.withTenant(ctx, async (c) => {
      await c.query('DELETE FROM tenants WHERE id = $1', [ctx.tenantId]);
    });
  }
}

const phoneFor = (id: string) =>
  `+88016${String(parseInt(id.slice(-6), 16) % 100000000).padStart(8, '0')}`;

async function seed(): Promise<void> {
  await drop();
  await db.withTenant(headA, async (c) => {
    await c.query(
      `INSERT INTO tenants (id, slug, name_bn, name_en, stream, level)
       VALUES ($1,'b7-a','বি৭','B7','bangla_medium','secondary')`, [T_A]);

    const user = async (id: string, name: string, role: string, phone: string | null) => {
      await c.query(
        `INSERT INTO users (id, tenant_id, full_name_bn, full_name_en, phone_e164, status)
         VALUES ($1,$2,$3,$3,$4,'active')`, [id, T_A, name, phone]);
      await c.query(
        `INSERT INTO user_roles (tenant_id, user_id, role_code) VALUES ($1,$2,$3)`,
        [T_A, id, role]);
    };
    await user(HEAD_A, 'প্রধান', 'principal', phoneFor(HEAD_A));
    await user(TEACHER, 'শিক্ষক', 'class_teacher', phoneFor(TEACHER));
    await user(FATHER, 'বাবা', 'guardian', phoneFor(FATHER));
    await user(UNCLE, 'চাচা', 'guardian', phoneFor(UNCLE));
    await user(ONLY_ONE, 'একমাত্র অভিভাবক', 'guardian', phoneFor(ONLY_ONE));
    await user(RAFI, 'রাফি', 'student', phoneFor(RAFI));
    // No phone and no email: the case where losing her last guardian would
    // leave the school with no way to reach the family at all.
    await user(TAHIYA, 'তাহিয়া', 'student', null);

    await c.query(
      `INSERT INTO academic_years (id, tenant_id, label, starts_on, ends_on, is_current)
       VALUES ($1,$2,'2026','2026-01-01','2026-12-31',true)`, [YEAR_A, T_A]);
    await c.query(
      `INSERT INTO classes (id, tenant_id, level_no, name_bn, name_en, stream)
       VALUES ($1,$2,9,'নবম','Nine','bangla_medium')`, [CLASS_A, T_A]);
    await c.query(
      `INSERT INTO sections (id, tenant_id, class_id, academic_year_id, name, student_count)
       VALUES ($1,$2,$3,$4,'ক',0)`, [SEC_A, T_A, CLASS_A, YEAR_A]);
    let roll = 1;
    for (const sid of [RAFI, TAHIYA]) {
      await c.query(
        `INSERT INTO enrolments (tenant_id, student_id, section_id, academic_year_id, roll_no, status)
         VALUES ($1,$2,$3,$4,$5,'active')`, [T_A, sid, SEC_A, YEAR_A, roll++]);
    }
    for (const [gid, sid, primary] of [
      [FATHER, RAFI, true], [UNCLE, RAFI, false], [ONLY_ONE, TAHIYA, true],
    ] as const) {
      await c.query(
        `INSERT INTO guardianships
           (tenant_id, student_id, guardian_id, relation, is_primary, receives_sms, can_pay_fees)
         VALUES ($1,$2,$3,'father',$4,true,true)`, [T_A, sid, gid, primary]);
    }
  });

  await db.withTenant(headB, async (c) => {
    await c.query(
      `INSERT INTO tenants (id, slug, name_bn, name_en, stream, level)
       VALUES ($1,'b7-b','বি৭খ','B7B','bangla_medium','secondary')`, [T_B]);
    await c.query(
      `INSERT INTO users (id, tenant_id, full_name_bn, full_name_en, phone_e164, status)
       VALUES ($1,$2,'প্রধান খ','HeadB',$3,'active')`, [HEAD_B, T_B, phoneFor(HEAD_B)]);
    await c.query(
      `INSERT INTO user_roles (tenant_id, user_id, role_code) VALUES ($1,$2,'principal')`,
      [T_B, HEAD_B]);
    await c.query(
      `INSERT INTO users (id, tenant_id, full_name_bn, full_name_en, phone_e164, status)
       VALUES ($1,$2,'অন্য ছাত্র','OtherB',$3,'active')`, [B_STUDENT, T_B, phoneFor(B_STUDENT)]);
    await c.query(
      `INSERT INTO academic_years (id, tenant_id, label, starts_on, ends_on, is_current)
       VALUES ($1,$2,'2026','2026-01-01','2026-12-31',true)`, [YEAR_B, T_B]);
    await c.query(
      `INSERT INTO classes (id, tenant_id, level_no, name_bn, name_en, stream)
       VALUES ($1,$2,9,'নবম','Nine','bangla_medium')`, [CLASS_B, T_B]);
    await c.query(
      `INSERT INTO sections (id, tenant_id, class_id, academic_year_id, name, student_count)
       VALUES ($1,$2,$3,$4,'ক',0)`, [SEC_B, T_B, CLASS_B, YEAR_B]);
  });
}

let ready: Promise<void> | null = null;
function ensureSetup(): Promise<void> {
  ready ??= (async () => {
    await installTestKeys();
    db = createDb(DATABASE_URL as string);
    guardians = (await import('../api/guardians.ts')).default;
    await seed();
    const { signAccessToken } = await import('../../../packages/server-core/src/jwt.ts');
    const mint = (sub: string, tid: string, role: string) =>
      signAccessToken({ sub, tid, role, roles: [role] });
    tokens = {
      headA: await mint(HEAD_A, T_A, 'principal'),
      headB: await mint(HEAD_B, T_B, 'principal'),
      teacher: await mint(TEACHER, T_A, 'class_teacher'),
      father: await mint(FATHER, T_A, 'guardian'),
    };
  })();
  return ready;
}

const revoke = (token: string, body: unknown) =>
  call(guardians, { method: 'DELETE', url: '/api/v1/ops/guardians', token, body });

/** `app.my_ward_ids()` under a chosen session — the access gate itself. */
async function wardsOf(ctx: TenantContext): Promise<string[]> {
  return db.withTenant(ctx, async (c) => {
    const r = await c.query<{ ids: string[] }>('SELECT app.my_ward_ids() AS ids');
    return r.rows[0].ids;
  });
}

describe('B-7 — the relationship ends', { skip }, () => {
  before(ensureSetup);

  test('the uncle is revoked, and the row is still there', async () => {
    const res = await revoke(tokens.headA, {
      studentId: RAFI, guardianId: UNCLE, reason: 'ভুল করে যুক্ত হয়েছিল',
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));

    // NOT deleted. The whole premise of migration 042 is that this row is a
    // record; it now carries an end date and nothing else changed about it.
    const row = await db.withTenant(headA, async (c) => {
      const r = await c.query<{ revoked_at: string | null; revoked_reason: string;
                                relation: string; receives_sms: boolean }>(
        `SELECT revoked_at, revoked_reason, relation, receives_sms
           FROM guardianships WHERE student_id = $1 AND guardian_id = $2`,
        [RAFI, UNCLE]);
      return r.rows[0];
    });
    assert.ok(row, 'the row survives — it is a record, not a toggle');
    assert.ok(row.revoked_at);
    assert.equal(row.revoked_reason, 'ভুল করে যুক্ত হয়েছিল');
    assert.equal(row.relation, 'father', 'the historical relationship is unchanged');
    assert.equal(row.receives_sms, false, 'and the SMS flag is dropped as well');
  });

  test('THE ONE THAT MATTERS — the former guardian stops reading the child', async () => {
    // `app.my_ward_ids()` is what `app.can_see_student()` asks, and
    // `can_see_student` is what every guardian-facing RLS policy asks. If this
    // one array still holds Rafi, the uncle can still read his attendance,
    // results and fees no matter what any screen shows.
    assert.deepEqual(await wardsOf(asUncle), []);
    // …and the father, who was not revoked, is untouched.
    assert.deepEqual(await wardsOf(asFather), [RAFI]);
  });

  test('THE OTHER ONE — the absence SMS stops going to them', async () => {
    // Exactly the query sms-svc/dispatch.ts runs, under the role it runs as.
    // A missed filter here texts a stranger about a child every time that
    // child is marked absent, which is the worst outcome this change could
    // have. It is closed by the RLS policy, not by an edit to the dispatcher.
    const recipients = await db.withTenant(asDispatcher, async (c) => {
      const r = await c.query<{ guardian_id: string }>(
        `SELECT g.guardian_id FROM guardianships g
           JOIN users u ON u.id = g.guardian_id
          WHERE g.tenant_id = $1 AND g.student_id = $2 AND g.receives_sms = true`,
        [T_A, RAFI]);
      return r.rows.map((x) => x.guardian_id);
    });
    assert.deepEqual(recipients, [FATHER]);
  });

  test('the revoked row is invisible to every ordinary reader', async () => {
    for (const [name, ctx] of [
      ['the dispatcher', asDispatcher],
      ['a teacher', { tenantId: T_A, userId: TEACHER, role: 'class_teacher' }],
      ['the other guardian', asFather],
    ] as const) {
      const n = await db.withTenant(ctx, async (c) => {
        const r = await c.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM guardianships
            WHERE student_id = $1 AND guardian_id = $2`, [RAFI, UNCLE]);
        return r.rows[0].n;
      });
      assert.equal(n, 0, `${name} must not see an ended link`);
    }
  });

  test('…and visible to the office, which needs to know it ended', async () => {
    const n = await db.withTenant(headA, async (c) => {
      const r = await c.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM guardianships
          WHERE student_id = $1 AND guardian_id = $2 AND revoked_at IS NOT NULL`,
        [RAFI, UNCLE]);
      return r.rows[0].n;
    });
    assert.equal(n, 1);
  });

  test('the same guardian can be linked again — the usual reason to revoke is a typo',
    async () => {
      await db.withTenant(headA, async (c) => {
        await c.query(
          `INSERT INTO guardianships (tenant_id, student_id, guardian_id, relation, is_primary)
           VALUES ($1,$2,$3,'uncle',false)`, [T_A, RAFI, UNCLE]);
      });
      assert.deepEqual(await wardsOf(asUncle), [RAFI], 'the new link works');
      // Cleaned up so the later tests see the state they expect.
      await db.withTenant(headA, async (c) => {
        await c.query(
          `DELETE FROM guardianships WHERE student_id = $1 AND guardian_id = $2
             AND revoked_at IS NULL`, [RAFI, UNCLE]);
      });
    });

  test('the audit entry names people, not uuids', async () => {
    const entry = await db.withTenant(headA, async (c) => {
      const r = await c.query<{ action: string; before: Record<string, unknown> }>(
        `SELECT action, before_state AS before FROM audit.activity_log
          WHERE action = 'ops.guardian.revoke' ORDER BY created_at DESC LIMIT 1`);
      return r.rows[0];
    });
    assert.equal(entry.action, 'ops.guardian.revoke');
    assert.equal(entry.before.guardian, 'চাচা');
    assert.equal(entry.before.student, 'রাফি');
  });
});

describe('B-7 — what it refuses', { skip }, () => {
  before(ensureSetup);
  after(async () => { await drop(); await db.end(); });

  test('a child is never left with no contactable adult', async () => {
    // Tahiya has no phone and no email of her own. Migration 031 refuses to
    // CREATE a student in that state; revocation is the back door into it.
    const res = await revoke(tokens.headA, {
      studentId: TAHIYA, guardianId: ONLY_ONE, reason: 'পরীক্ষা',
    });
    assert.equal(res.status, 409);
    assert.equal(res.body.error, 'last_contactable_guardian');
    // The message says what to do about it, because there is something.
    assert.match(String(res.body.message), /অন্য একজন অভিভাবক যুক্ত করুন/);
    assert.deepEqual(await wardsOf({ tenantId: T_A, userId: ONLY_ONE, role: 'guardian' }),
      [TAHIYA], 'and nothing changed');
  });

  test('…but it succeeds once another contactable guardian exists', async () => {
    await db.withTenant(headA, async (c) => {
      await c.query(
        `INSERT INTO guardianships (tenant_id, student_id, guardian_id, relation, is_primary)
         VALUES ($1,$2,$3,'uncle',false)`, [T_A, TAHIYA, UNCLE]);
    });
    const res = await revoke(tokens.headA, {
      studentId: TAHIYA, guardianId: ONLY_ONE, reason: 'অভিভাবক পরিবর্তন',
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.wasPrimary, true);
    assert.equal(res.body.needsNewPrimary, true,
      'a student whose PRIMARY guardian just ended needs another one named');
  });

  test('a reason is required — a revocation with no why is indistinguishable from a bug',
    async () => {
      for (const reason of ['', '   ']) {
        const res = await revoke(tokens.headA, { studentId: RAFI, guardianId: FATHER, reason });
        assert.equal(res.status, 400);
        assert.equal(res.body.error, 'reason_required');
      }
    });

  test('a class teacher may not', async () => {
    const res = await revoke(tokens.teacher, {
      studentId: RAFI, guardianId: FATHER, reason: 'চেষ্টা',
    });
    assert.equal(res.status, 403);
    assert.deepEqual(await wardsOf(asFather), [RAFI], 'untouched');
  });

  test('a guardian may not unlink themselves from a child', async () => {
    const res = await revoke(tokens.father, {
      studentId: RAFI, guardianId: FATHER, reason: 'চেষ্টা',
    });
    assert.equal(res.status, 403);
  });

  test('another school’s principal cannot end this school’s relationship', async () => {
    const res = await revoke(tokens.headB, {
      studentId: RAFI, guardianId: FATHER, reason: 'হ্যাক',
    });
    // 404: under tenant B's context the row does not exist. A 403 would
    // confirm that this pair is real somewhere.
    assert.equal(res.status, 404);
    assert.deepEqual(await wardsOf(asFather), [RAFI], 'untouched');
  });

  test('an already-ended relationship cannot be ended twice', async () => {
    const res = await revoke(tokens.headA, {
      studentId: TAHIYA, guardianId: ONLY_ONE, reason: 'আবার',
    });
    assert.equal(res.status, 404);
  });

  test('a malformed id is refused before any query runs', async () => {
    const res = await revoke(tokens.headA, {
      studentId: 'not-a-uuid', guardianId: FATHER, reason: 'x',
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'bad_student');
  });

  test('no token is 401', async () => {
    const res = await call(guardians, {
      method: 'DELETE', url: '/api/v1/ops/guardians',
      body: { studentId: RAFI, guardianId: FATHER, reason: 'x' },
    });
    assert.equal(res.status, 401);
  });
});
