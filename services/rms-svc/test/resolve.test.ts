/**
 * P9-6 — recalculating part of a routine, and leaving the rest alone.
 *
 * The five properties that decide whether a coordinator can trust this
 * button, each of which is a real incident if it is wrong:
 *
 *   1. UNAFFECTED SLOTS DO NOT MOVE. §5 asks for this to be proved from the
 *      database rather than from a screenshot, and it is the whole promise:
 *      "recalculate this part" that quietly rearranged the school would be
 *      worse than regenerating, because nobody would be watching for it.
 *
 *   2. PINNED SLOTS SURVIVE. Mandatory (§4). A coordinator pins the head
 *      teacher's Monday class and a later recalculation moves it anyway —
 *      that is the lock being a lie.
 *
 *   3. FAILURE IS ATOMIC. The removal and the re-solve are one transaction,
 *      so a failure leaves the previous valid draft exactly as it was. Half
 *      of it — lessons deleted, nothing put back — is the worst outcome
 *      available to a screen whose purpose is a safe small change.
 *
 *   4. NO SOLUTION IS SAID, NOT HIDDEN. When a lesson cannot go back
 *      anywhere, the summary says so and the old routine is not overwritten
 *      with a worse one.
 *
 *   5. PREVIEW CHANGES NOTHING. It is the real solver in a transaction that
 *      is rolled back; if it left anything behind it would be an apply
 *      wearing a preview's label.
 *
 *   DATABASE_URL=postgres://shikhon_app:… \
 *     node --test services/rms-svc/test/resolve.test.ts
 */
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { createDb, type Db, type TenantContext } from '../../../packages/server-core/src/db.ts';
import {
  installTestKeys, call, lockFixtures, unlockFixtures, asBootstrap,
} from '../../../packages/server-core/test/harness.ts';

const DATABASE_URL = process.env.DATABASE_URL;
const skip = !DATABASE_URL ? 'DATABASE_URL not set' : false;

const T       = '7c960000-0000-4000-8000-0000000000a0';
const HEAD    = '7c960000-0000-4000-8000-0000000000a1';
const RAFIQ   = '7c960000-0000-4000-8000-0000000000a2';
const SALMA   = '7c960000-0000-4000-8000-0000000000a3';
const STUDENT = '7c960000-0000-4000-8000-0000000000a4';
const YEAR    = '7c960000-0000-4000-8000-0000000000c1';
const KLASS   = '7c960000-0000-4000-8000-0000000000d1';
const SEC_A   = '7c960000-0000-4000-8000-0000000000e1';
const SEC_B   = '7c960000-0000-4000-8000-0000000000e2';
const BANGLA  = '7c960000-0000-4000-8000-0000000000f1';
const MATHS   = '7c960000-0000-4000-8000-0000000000f2';
const TPL     = '7c960000-0000-4000-8000-00000000ab01';
const ROOM_A  = '7c960000-0000-4000-8000-00000000ab02';
const ROOM_B  = '7c960000-0000-4000-8000-00000000ab04';
const ROUTINE = '7c960000-0000-4000-8000-00000000ab03';

const T_B     = '7c960000-0000-4000-8000-0000000000b0';
const HEAD_B  = '7c960000-0000-4000-8000-0000000000b1';

let db: Db;
let headToken = '';
let headBToken = '';
let studentToken = '';
let resolve: Parameters<typeof call>[0];
let editor: Parameters<typeof call>[0];
let generate: Parameters<typeof call>[0];

const head: TenantContext = { tenantId: T, userId: HEAD, role: 'principal' };
const headB: TenantContext = { tenantId: T_B, userId: HEAD_B, role: 'principal' };

const post = (h: Parameters<typeof call>[0], body: unknown, token = headToken) =>
  call(h, { method: 'POST', url: '/', token, body } as Parameters<typeof call>[1]);

interface Slot {
  id: string; day_of_week: number; period_no: number;
  primary_section_id: string; subject_id: string; teacher_id: string;
  room_id: string | null; is_pinned: boolean; status: string;
}

/** Every active slot, straight from the database. §5 wants DB assertions. */
const liveSlots = async (): Promise<Slot[]> => {
  const { rows } = await asBootstrap(db, head, (c) => c.query<Slot>(
    `SELECT id, day_of_week, period_no, primary_section_id, subject_id,
            teacher_id, room_id, is_pinned, status
       FROM routine_slots
      WHERE routine_id = $1 AND status = 'active'
      ORDER BY day_of_week, period_no, primary_section_id`, [ROUTINE]));
  return rows;
};

/** A comparable fingerprint of one slot's placement. */
const place = (s: Slot) =>
  `${s.primary_section_id}|${s.subject_id}|${s.day_of_week}|${s.period_no}|${s.teacher_id}`;

describe('P9-6 — scoped re-solve', { skip }, () => {
  before(async () => {
    await installTestKeys();
    await lockFixtures(DATABASE_URL as string);
    db = createDb(DATABASE_URL as string);

    await asBootstrap(db, head, async (c) => {
      await c.query('DELETE FROM tenants WHERE id = $1', [T]);
      await c.query(
        `INSERT INTO tenants (id, slug, name_bn, name_en, stream, level, weekend_days)
         VALUES ($1,'p96','পি৯৬','P96','bangla_medium','secondary','{5,6}')`, [T]);
      for (const [id, bn, phone, role] of [
        [HEAD, 'প্রধান', '+8801799960001', 'principal'],
        [RAFIQ, 'রফিক স্যার', '+8801799960002', 'subject_teacher'],
        [SALMA, 'সালমা ম্যাডাম', '+8801799960003', 'subject_teacher'],
        [STUDENT, 'ছাত্র', '+8801799960004', 'student'],
      ] as const) {
        await c.query(
          `INSERT INTO users (id, tenant_id, full_name_bn, full_name_en, phone_e164, status)
           VALUES ($1,$2,$3,'X',$4,'active')`, [id, T, bn, phone]);
        await c.query(
          `INSERT INTO user_roles (tenant_id, user_id, role_code) VALUES ($1,$2,$3)`,
          [T, id, role]);
      }
      await c.query(
        `INSERT INTO academic_years (id, tenant_id, label, starts_on, ends_on, is_current)
         VALUES ($1,$2,'2026','2026-01-01','2026-12-31',true)`, [YEAR, T]);
      await c.query(
        `INSERT INTO classes (id, tenant_id, level_no, name_bn, name_en, stream)
         VALUES ($1,$2,9,'নবম','Nine','bangla_medium')`, [KLASS, T]);
      for (const [id, code] of [[ROOM_A, 'R-1'], [ROOM_B, 'R-2']] as const) {
        await c.query(
          `INSERT INTO rooms (id, tenant_id, code, name_bn, capacity, capabilities, is_bookable)
           VALUES ($1,$2,$3,$3,60,'{}',true)`, [id, T, code]);
      }
      for (const [id, name] of [[SEC_A, 'ক'], [SEC_B, 'খ']] as const) {
        await c.query(
          `INSERT INTO sections (id, tenant_id, class_id, academic_year_id, name,
                                 student_count, shift, home_room_id)
           VALUES ($1,$2,$3,$4,$5,40,'single',$6)`,
          [id, T, KLASS, YEAR, name, id === SEC_A ? ROOM_A : ROOM_B]);
      }
      for (const [id, nameBn] of [[BANGLA, 'বাংলা'], [MATHS, 'গণিত']] as const) {
        await c.query(
          `INSERT INTO subjects (id, tenant_id, name_bn, name_en, short_name)
           VALUES ($1,$2,$3,'S',substr($3,1,3))`, [id, T, nameBn]);
        await c.query(
          `INSERT INTO class_subjects
             (tenant_id, class_id, subject_id, academic_year_id, periods_per_week)
           VALUES ($1,$2,$3,$4,3)`, [T, KLASS, id, YEAR]);
      }
      // Rafiq takes Bangla in both sections, Salma maths in both — so a
      // teacher scope selects across sections, which is the case worth
      // testing.
      for (const sec of [SEC_A, SEC_B]) {
        await c.query(
          `INSERT INTO section_subject_teachers
             (tenant_id, section_id, subject_id, teacher_id, academic_year_id, started_on)
           VALUES ($1,$2,$3,$4,$5,'2026-01-05'), ($1,$2,$6,$7,$5,'2026-01-05')`,
          [T, sec, BANGLA, RAFIQ, YEAR, MATHS, SALMA]);
      }
      await c.query(
        `INSERT INTO period_templates (id, tenant_id, name_bn, shift, effective_from, is_active)
         VALUES ($1,$2,'নিয়মিত','single','2026-01-01',true)`, [TPL, T]);
      for (let i = 1; i <= 6; i++) {
        await c.query(
          `INSERT INTO period_definitions
             (tenant_id, template_id, period_no, label_bn, starts_at, ends_at, kind)
           VALUES ($1,$2,$3,$4,$5::time,$6::time,'teaching')`,
          [T, TPL, i, `${i} নম্বর`,
           `${String(8 + i).padStart(2, '0')}:00`, `${String(8 + i).padStart(2, '0')}:45`]);
      }
    });

    await asBootstrap(db, headB, async (c) => {
      await c.query('DELETE FROM tenants WHERE id = $1', [T_B]);
      await c.query(
        `INSERT INTO tenants (id, slug, name_bn, name_en, stream, level)
         VALUES ($1,'p96-other','পাশের','Other','bangla_medium','secondary')`, [T_B]);
      await c.query(
        `INSERT INTO users (id, tenant_id, full_name_bn, full_name_en, phone_e164, status)
         VALUES ($1,$2,'অন্য','B','+8801799960009','active')`, [HEAD_B, T_B]);
      await c.query(
        `INSERT INTO user_roles (tenant_id, user_id, role_code) VALUES ($1,$2,'principal')`,
        [T_B, HEAD_B]);
    });

    const { signAccessToken } = await import('../../../packages/server-core/src/jwt.ts');
    headToken = await signAccessToken({ sub: HEAD, tid: T, role: 'principal', roles: ['principal'] });
    headBToken = await signAccessToken({
      sub: HEAD_B, tid: T_B, role: 'principal', roles: ['principal'] });
    studentToken = await signAccessToken({
      sub: STUDENT, tid: T, role: 'student', roles: ['student'] });
    resolve = (await import('../api/resolve.ts')).default;
    editor = (await import('../api/editor.ts')).default;
    generate = (await import('../api/generate.ts')).default;
  });

  after(async () => {
    if (!db) return;
    for (const [ctx, id] of [[head, T], [headB, T_B]] as const) {
      await asBootstrap(db, ctx, (c) => c.query('DELETE FROM tenants WHERE id = $1', [id]));
    }
    await db.end();
    await unlockFixtures();
  });

  /** A freshly generated routine every time, with a known id. */
  beforeEach(async () => {
    await asBootstrap(db, head, async (c) => {
      await c.query(
        `UPDATE routine_edit_log SET undone_at = now()
          WHERE tenant_id = $1 AND undone_at IS NULL`, [T]);
      await c.query('DELETE FROM routine_slots WHERE tenant_id = $1', [T]);
      await c.query('DELETE FROM routines WHERE tenant_id = $1', [T]);
      await c.query(
        `INSERT INTO routines (id, tenant_id, academic_year_id, period_template_id, shift,
                               name_bn, version, status, effective_from, generated_by, created_by)
         VALUES ($1,$2,$3,$4,'single','খসড়া',1,'draft','2026-01-01','solver',$5)`,
        [ROUTINE, T, YEAR, TPL, HEAD]);
    });
    const r = await post(generate, { yearId: YEAR });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok((await liveSlots()).length > 0, 'the fixture must actually have a routine');
  });

  /* ────────────────── the promise: leave the rest alone ────────────────── */

  test('THE ONE THAT MATTERS — only the scoped teacher moves; everything else is byte-identical', async () => {
    const before = await liveSlots();
    const rafiqBefore = before.filter((s) => s.teacher_id === RAFIQ);
    const othersBefore = before.filter((s) => s.teacher_id !== RAFIQ);
    assert.ok(rafiqBefore.length > 0 && othersBefore.length > 0, 'fixture has both');

    const r = await post(resolve, {
      routineId: ROUTINE, scope: { kind: 'teacher', teacherId: RAFIQ },
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));

    // §5, from the database. Every slot NOT in scope keeps its id, its hour,
    // its teacher and its room — not merely "the same number of them".
    const after = await liveSlots();
    const othersAfter = after.filter((s) => s.teacher_id !== RAFIQ);
    assert.deepEqual(
      othersAfter.map((s) => `${s.id}|${place(s)}|${s.room_id}`).sort(),
      othersBefore.map((s) => `${s.id}|${place(s)}|${s.room_id}`).sort(),
      'a slot outside the scope moved');

    // And the scoped teacher is still fully placed.
    assert.equal(after.filter((s) => s.teacher_id === RAFIQ).length, rafiqBefore.length,
      'the scope was re-placed, not merely emptied');
  });

  test('a SECTION scope leaves the other section untouched', async () => {
    const before = await liveSlots();
    const otherBefore = before.filter((s) => s.primary_section_id !== SEC_A);

    const r = await post(resolve, {
      routineId: ROUTINE, scope: { kind: 'section', sectionId: SEC_A },
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));

    const otherAfter = (await liveSlots()).filter((s) => s.primary_section_id !== SEC_A);
    assert.deepEqual(
      otherAfter.map((s) => `${s.id}|${place(s)}`).sort(),
      otherBefore.map((s) => `${s.id}|${place(s)}`).sort());
  });

  test('a DAY scope touches only that day', async () => {
    const before = await liveSlots();
    const day = before[0].day_of_week;
    const otherDaysBefore = before.filter((s) => s.day_of_week !== day);

    const r = await post(resolve, { routineId: ROUTINE, scope: { kind: 'day', dayOfWeek: day } });
    assert.equal(r.status, 200, JSON.stringify(r.body));

    const otherDaysAfter = (await liveSlots()).filter((s) => s.day_of_week !== day);
    assert.deepEqual(
      otherDaysAfter.map((s) => `${s.id}|${place(s)}`).sort(),
      otherDaysBefore.map((s) => `${s.id}|${place(s)}`).sort());
  });

  /* ─────────────────────────────── pins ─────────────────────────────── */

  test('THE ONE THAT MATTERS — a PINNED slot in scope is untouched, id and all', async () => {
    // §4 is mandatory: pin, then recalculate the very scope it sits in.
    const target = (await liveSlots()).find((s) => s.teacher_id === RAFIQ) as Slot;
    const lock = await post(editor, { action: 'lock', slotId: target.id });
    assert.equal(lock.status, 200, JSON.stringify(lock.body));

    const r = await post(resolve, {
      routineId: ROUTINE, scope: { kind: 'teacher', teacherId: RAFIQ },
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok((r.body as { summary: { pinnedPreserved: number } }).summary.pinnedPreserved >= 1,
      'the summary must SAY how many were protected');

    const after = (await liveSlots()).find((s) => s.id === target.id);
    assert.ok(after, 'the pinned slot still exists, with the same id');
    assert.equal(place(after), place(target), 'and in exactly the same place');
    assert.equal(after.is_pinned, true);
  });

  /* ───────────────────────────── preview ────────────────────────────── */

  test('PREVIEW changes nothing — it is the real solver, rolled back', async () => {
    const before = await liveSlots();
    const fp = before.map((s) => `${s.id}|${place(s)}`).sort().join(',');

    const r = await post(resolve, {
      routineId: ROUTINE, scope: { kind: 'teacher', teacherId: RAFIQ }, preview: true,
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const body = r.body as { preview: boolean; summary: { affected: number } };
    assert.equal(body.preview, true);
    assert.ok(body.summary.affected > 0, 'and it still reports what WOULD be affected');

    const after = await liveSlots();
    assert.equal(after.map((s) => `${s.id}|${place(s)}`).sort().join(','), fp,
      'a preview that left anything behind would be an apply in disguise');

    // Nor may it leave an undo entry: there is nothing to undo.
    const { rows } = await asBootstrap(db, head, (c) => c.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM routine_edit_log
        WHERE routine_id = $1 AND undone_at IS NULL`, [ROUTINE]));
    assert.equal(rows[0].n, '0');
  });

  /* ──────────────────────── no solution, atomicity ───────────────────── */

  test('NO SOLUTION is reported, and the old routine is not made worse', async () => {
    // Block Rafiq's whole week, then recalculate his scope. His lessons come
    // out and cannot go back — §9's case exactly.
    await asBootstrap(db, head, (c) => c.query(
      `INSERT INTO teacher_availability
         (tenant_id, teacher_id, day_of_week, starts_at, ends_at, kind)
       SELECT $1, $2, d, '00:00'::time, '23:59'::time, 'unavailable'
         FROM generate_series(0, 6) AS d`, [T, RAFIQ]));

    const before = await liveSlots();
    const othersBefore = before.filter((s) => s.teacher_id !== RAFIQ);

    const r = await post(resolve, {
      routineId: ROUTINE, scope: { kind: 'teacher', teacherId: RAFIQ },
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const b = r.body as { summary: { lost: number; moved: Array<{ afterBn: string }> };
                          verdictBn: string };
    assert.ok(b.summary.lost > 0, 'the shortfall must be counted, not hidden');
    assert.match(b.verdictBn, /কোনো বৈধ সময় পাওয়া যায়নি/,
      'and said in the sentence a coordinator reads first');
    assert.ok(b.summary.moved.some((m) => m.afterBn === 'কোথাও বসানো যায়নি'),
      'each one names the lesson that could not be placed');

    // Everyone else is untouched: a failure for one teacher is not a licence
    // to rearrange the school.
    const othersAfter = (await liveSlots()).filter((s) => s.teacher_id !== RAFIQ);
    assert.deepEqual(
      othersAfter.map((s) => `${s.id}|${place(s)}`).sort(),
      othersBefore.map((s) => `${s.id}|${place(s)}`).sort());

    await asBootstrap(db, head, (c) =>
      c.query('DELETE FROM teacher_availability WHERE tenant_id = $1', [T]));
  });

  /* ──────────────────────────── idempotency ─────────────────────────── */

  test('running it twice changes nothing the second time', async () => {
    await post(resolve, { routineId: ROUTINE, scope: { kind: 'section', sectionId: SEC_A } });
    const afterFirst = await liveSlots();

    const second = await post(resolve, {
      routineId: ROUTINE, scope: { kind: 'section', sectionId: SEC_A },
    });
    assert.equal(second.status, 200);
    const afterSecond = await liveSlots();

    assert.equal(afterSecond.length, afterFirst.length, 'no duplicate slots');
    // The placements are the same, though the rows are new: the solver is
    // deterministic, so re-solving the same gaps produces the same week.
    assert.deepEqual(
      afterSecond.map(place).sort(), afterFirst.map(place).sort(),
      'a deterministic solver given the same gaps must produce the same answer');
  });

  /* ───────────────────────────── concurrency ─────────────────────────── */

  test('a STALE fingerprint is refused rather than applied', async () => {
    const r1 = await post(resolve, {
      routineId: ROUTINE, scope: { kind: 'section', sectionId: SEC_A }, preview: true,
    });
    const fp = (r1.body as { fingerprint: string }).fingerprint;

    // Somebody else edits in between.
    const slot = (await liveSlots()).find((s) => s.primary_section_id === SEC_B) as Slot;
    const moved = await post(editor, {
      action: 'move', slotId: slot.id,
      dayOfWeek: slot.day_of_week, periodNo: slot.period_no,
    });
    assert.equal(moved.status, 200, JSON.stringify(moved.body));

    const r2 = await post(resolve, {
      routineId: ROUTINE, scope: { kind: 'section', sectionId: SEC_A }, fingerprint: fp,
    });
    assert.equal(r2.status, 409);
    assert.equal((r2.body as { error: string }).error, 'stale_routine');
    assert.match((r2.body as { message: string }).message, /অন্য কেউ বদলে ফেলেছেন/);
  });

  test('and the fresh fingerprint goes through', async () => {
    const peek = await post(resolve, {
      routineId: ROUTINE, scope: { kind: 'section', sectionId: SEC_A }, preview: true,
    });
    const fp = (peek.body as { fingerprint: string }).fingerprint;
    const r = await post(resolve, {
      routineId: ROUTINE, scope: { kind: 'section', sectionId: SEC_A }, fingerprint: fp,
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
  });

  /* ──────────────────────────────── undo ─────────────────────────────── */

  test('ONE undo reverses the whole scoped re-solve', async () => {
    // §18: not dozens of entries for one operation.
    const before = await liveSlots();
    await post(resolve, { routineId: ROUTINE, scope: { kind: 'teacher', teacherId: RAFIQ } });

    const { rows: log } = await asBootstrap(db, head, (c) => c.query<{
      n: string; label_bn: string; action: string;
    }>(
      `SELECT count(*)::text AS n, min(label_bn) AS label_bn, min(action) AS action
         FROM routine_edit_log WHERE routine_id = $1 AND undone_at IS NULL`, [ROUTINE]));
    assert.equal(log[0].n, '1', 'one operation, one entry');
    assert.equal(log[0].action, 'resolve');
    assert.match(log[0].label_bn, /রফিক স্যারের ক্লাসগুলো আবার হিসাব/);

    const undone = await post(editor, { action: 'undo', routineId: ROUTINE });
    assert.equal(undone.status, 200, JSON.stringify(undone.body));

    const after = await liveSlots();
    assert.deepEqual(
      after.map((s) => `${s.id}|${place(s)}`).sort(),
      before.map((s) => `${s.id}|${place(s)}`).sort(),
      'the routine is exactly as it was, same rows and all');
  });

  /* ───────────────────────── security and isolation ───────────────────── */

  test('a student cannot re-solve anything', async () => {
    assert.equal((await post(resolve, {
      routineId: ROUTINE, scope: { kind: 'teacher', teacherId: RAFIQ },
    }, studentToken)).status, 403);
  });

  test('TENANT ISOLATION — another school cannot re-solve this one', async () => {
    const before = await liveSlots();
    const r = await post(resolve, {
      routineId: ROUTINE, scope: { kind: 'teacher', teacherId: RAFIQ },
    }, headBToken);
    assert.equal(r.status, 404, JSON.stringify(r.body));
    assert.equal((r.body as { error: string }).error, 'routine_not_found');

    const after = await liveSlots();
    assert.deepEqual(after.map((s) => `${s.id}|${place(s)}`).sort(),
                     before.map((s) => `${s.id}|${place(s)}`).sort(),
                     'not one slot moved');

    const { rows } = await asBootstrap(db, headB, (c) => c.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM routine_edit_log', []));
    assert.equal(rows[0].n, '0', 'and no log entry leaked either way');
  });

  test('a PUBLISHED routine refuses to be re-solved', async () => {
    await asBootstrap(db, head, (c) =>
      c.query(`UPDATE routines SET status = 'active' WHERE id = $1`, [ROUTINE]));
    const r = await post(resolve, {
      routineId: ROUTINE, scope: { kind: 'teacher', teacherId: RAFIQ },
    });
    assert.equal(r.status, 409);
    assert.equal((r.body as { error: string }).error, 'routine_not_editable');
  });

  test('an unknown scope is refused with a sentence, not a stack trace', async () => {
    for (const scope of [
      undefined, {}, { kind: 'everything' }, { kind: 'teacher' },
      { kind: 'teacher', teacherId: 'not-a-uuid' }, { kind: 'day', dayOfWeek: 9 },
    ]) {
      const r = await post(resolve, { routineId: ROUTINE, scope });
      assert.equal(r.status, 400, JSON.stringify(scope));
      assert.equal((r.body as { error: string }).error, 'invalid_scope');
      assert.match((r.body as { message: string }).message, /বেছে নিন/);
    }
  });

  test('the summary reads in Bangla, with no identifier in it', async () => {
    const r = await post(resolve, {
      routineId: ROUTINE, scope: { kind: 'teacher', teacherId: RAFIQ },
    });
    const b = r.body as {
      verdictBn: string;
      summary: { moved: Array<{ beforeBn: string; afterBn: string }> };
    };
    const text = [b.verdictBn, ...b.summary.moved.flatMap((m) => [m.beforeBn, m.afterBn])].join(' ');
    assert.doesNotMatch(text, /[0-9a-f]{8}-[0-9a-f]{4}/, 'a uuid reached the summary');
    assert.doesNotMatch(text, /[a-z]+_[a-z]+/, 'a machine identifier reached the summary');
    assert.doesNotMatch(text, /undefined|null|NaN/);
    assert.doesNotMatch(text, /[0-9]+টি/, 'Latin numerals before a Bangla counter');
  });
});

/**
 * P9-6 §12 — a scoped re-solve in a two-shift school.
 *
 * P9-3's defect was that the second shift's solve could not see the first,
 * because F-506 books against ACTIVE routines and both were drafts. A scoped
 * re-solve runs the same solver on one of those drafts, so it inherits the
 * same exposure — and this is the test that says it did not.
 *
 * The fixture is P9-3's regression school: two rooms, four sections, a
 * handover where the morning's last period overlaps the day's first.
 */
const T2      = '7c960000-0000-4000-8000-0000000000d0';
const HEAD2   = '7c960000-0000-4000-8000-0000000000d1';
const YEAR2   = '7c960000-0000-4000-8000-0000000000d2';
const KLASS_M = '7c960000-0000-4000-8000-0000000000d3';
const KLASS_D = '7c960000-0000-4000-8000-0000000000d4';
const SUBJ_M  = '7c960000-0000-4000-8000-0000000000d5';
const SUBJ_D  = '7c960000-0000-4000-8000-0000000000d6';

describe('P9-6 §12 — scoped re-solve across two shifts', { skip }, () => {
  let db2: Db;
  let token = '';
  let resolve2: Parameters<typeof call>[0];
  let generate2: Parameters<typeof call>[0];
  const head2: TenantContext = { tenantId: T2, userId: HEAD2, role: 'principal' };

  before(async () => {
    await installTestKeys();
    await lockFixtures(DATABASE_URL as string);
    db2 = createDb(DATABASE_URL as string);

    await asBootstrap(db2, head2, async (c) => {
      await c.query('DELETE FROM tenants WHERE id = $1', [T2]);
      await c.query(
        `INSERT INTO tenants (id, slug, name_bn, name_en, stream, level, weekend_days)
         VALUES ($1,'p96-two','দুই শিফট','Two','bangla_medium','combined','{5,6}')`, [T2]);
      await c.query(
        `INSERT INTO users (id, tenant_id, full_name_bn, full_name_en, phone_e164, status)
         VALUES ($1,$2,'প্রধান','Head','+8801799961000','active')`, [HEAD2, T2]);
      await c.query(
        `INSERT INTO user_roles (tenant_id, user_id, role_code) VALUES ($1,$2,'principal')`,
        [T2, HEAD2]);
      await c.query(
        `INSERT INTO academic_years (id, tenant_id, label, starts_on, ends_on, is_current)
         VALUES ($1,$2,'2026','2026-01-01','2026-12-31',true)`, [YEAR2, T2]);

      const rooms: string[] = [];
      for (const code of ['R-1', 'R-2']) {
        const { rows } = await c.query<{ id: string }>(
          `INSERT INTO rooms (tenant_id, code, name_bn, capacity, capabilities, is_bookable)
           VALUES ($1,$2,$2,50,'{}',true) RETURNING id`, [T2, code]);
        rooms.push(rows[0].id);
      }

      // The handover overlaps: morning period 2 runs 08:45–09:30 and the
      // day's first starts at 09:00. Schools really do this.
      const bells: Record<string, ReadonlyArray<readonly [string, string]>> = {
        morning: [['08:00', '08:45'], ['08:45', '09:30']],
        day: [['09:00', '09:45'], ['09:45', '10:30']],
      };
      for (const shift of ['morning', 'day']) {
        const { rows: tpl } = await c.query<{ id: string }>(
          `INSERT INTO period_templates (tenant_id, name_bn, shift, effective_from, is_active)
           VALUES ($1,$2,$3::shift_code,'2026-01-01',true) RETURNING id`,
          [T2, shift, shift]);
        let n = 0;
        for (const [from, to] of bells[shift]) {
          await c.query(
            `INSERT INTO period_definitions
               (tenant_id, template_id, period_no, label_bn, starts_at, ends_at, kind)
             VALUES ($1,$2,$3,$4,$5::time,$6::time,'teaching')`,
            [T2, tpl[0].id, ++n, String(n), from, to]);
        }
      }

      const plan = [
        { klass: KLASS_M, shift: 'morning', subject: SUBJ_M, level: 5, bn: 'সকালের বিষয়' },
        { klass: KLASS_D, shift: 'day', subject: SUBJ_D, level: 8, bn: 'দিনের বিষয়' },
      ];
      let serial = 0;
      for (const p of plan) {
        await c.query(
          `INSERT INTO classes (id, tenant_id, level_no, name_bn, name_en, stream)
           VALUES ($1,$2,$3,$4,'C','bangla_medium')`, [p.klass, T2, p.level, p.bn]);
        await c.query(
          `INSERT INTO subjects (id, tenant_id, name_bn, name_en, short_name)
           VALUES ($1,$2,$3,'S',substr($3,1,3))`, [p.subject, T2, p.bn]);
        await c.query(
          `INSERT INTO class_subjects
             (tenant_id, class_id, subject_id, academic_year_id, periods_per_week)
           VALUES ($1,$2,$3,$4,10)`, [T2, p.klass, p.subject, YEAR2]);
        for (let i = 0; i < 2; i++) {
          const { rows: sec } = await c.query<{ id: string }>(
            `INSERT INTO sections (tenant_id, class_id, academic_year_id, name, shift,
                                   student_count, home_room_id)
             VALUES ($1,$2,$3,$4,$5::shift_code,40,$6) RETURNING id`,
            [T2, p.klass, YEAR2, ['ক', 'খ'][i], p.shift, rooms[i]]);
          const { rows: t } = await c.query<{ id: string }>(
            `INSERT INTO users (tenant_id, full_name_bn, full_name_en, phone_e164, status)
             VALUES ($1,$2,'T',$3,'active') RETURNING id`,
            [T2, `শিক্ষক ${++serial}`, `+880179996${2000 + serial}`]);
          await c.query(
            `INSERT INTO user_roles (tenant_id, user_id, role_code)
             VALUES ($1,$2,'subject_teacher')`, [T2, t[0].id]);
          await c.query(
            `INSERT INTO section_subject_teachers
               (tenant_id, section_id, subject_id, teacher_id, academic_year_id, started_on)
             VALUES ($1,$2,$3,$4,$5,'2026-01-01')`,
            [T2, sec[0].id, p.subject, t[0].id, YEAR2]);
        }
      }
    });

    const { signAccessToken } = await import('../../../packages/server-core/src/jwt.ts');
    token = await signAccessToken({
      sub: HEAD2, tid: T2, role: 'principal', roles: ['principal'] });
    resolve2 = (await import('../api/resolve.ts')).default;
    generate2 = (await import('../api/generate.ts')).default;
  });

  after(async () => {
    if (!db2) return;
    await asBootstrap(db2, head2, (c) => c.query('DELETE FROM tenants WHERE id = $1', [T2]));
    await db2.end();
    await unlockFixtures();
  });

  test('THE ONE THAT MATTERS — re-solving one shift does not double-book the other', async () => {
    const gen = await call(generate2,
      { method: 'POST', url: '/', token, body: { yearId: YEAR2 } } as Parameters<typeof call>[1]);
    assert.equal(gen.status, 200, JSON.stringify(gen.body));

    // The morning routine, and one of its sections to re-solve.
    const { rows: rt } = await asBootstrap(db2, head2, (c) => c.query<{
      id: string; sec: string;
    }>(
      `SELECT r.id, (SELECT s.primary_section_id FROM routine_slots s
                      WHERE s.routine_id = r.id AND s.status = 'active' LIMIT 1) AS sec
         FROM routines r
        WHERE r.academic_year_id = $1 AND r.shift = 'morning'::shift_code`, [YEAR2]));
    assert.ok(rt[0]?.sec, 'the morning shift has slots to re-solve');

    const r = await call(resolve2, {
      method: 'POST', url: '/', token,
      body: { routineId: rt[0].id, scope: { kind: 'section', sectionId: rt[0].sec } },
    } as Parameters<typeof call>[1]);
    assert.equal(r.status, 200, JSON.stringify(r.body));

    // The whole school, both drafts, asked of the stored rows — the same
    // question P9-3's regression test asks, because a scoped re-solve runs
    // the same solver and inherits the same exposure.
    const { rows } = await asBootstrap(db2, head2, (c) => c.query<{ n: string }>(
      `SELECT count(*)::text AS n
         FROM routine_slots a JOIN routine_slots b
           ON a.id < b.id AND a.day_of_week = b.day_of_week
          AND a.time_range && b.time_range
          AND (a.teacher_id = b.teacher_id
               OR (a.room_id = b.room_id AND a.room_id IS NOT NULL))
        WHERE a.tenant_id = $1 AND a.status = 'active' AND b.status = 'active'`, [T2]));
    assert.equal(rows[0].n, '0',
      'a room cannot hold two classes at 09:15, and a scoped re-solve must not create one');
  });
});
