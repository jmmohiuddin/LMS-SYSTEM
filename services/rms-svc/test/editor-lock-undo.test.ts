/**
 * P9-5 — lock, undo, and the two operators who edit at once.
 *
 * `editor-authoring.test.ts` covers place/assign/move/remove and the three
 * clash sentences. These are the four things P9-5 adds, each of which is a
 * real incident if it is wrong:
 *
 *   1. A LOCK that could be set but not respected would be worse than none:
 *      a coordinator marks the head teacher's Monday class untouchable and a
 *      later run moves it anyway. `is_pinned` has been enforced since
 *      migration 006 and had no writer until now, so the enforcement is the
 *      part already proven — this pins that the writer reaches it.
 *
 *   2. UNDO must restore what was actually there. An undo that "succeeds"
 *      and puts back something slightly different is the feature that loses
 *      the work it exists to protect.
 *
 *   3. TWO OPERATORS must not silently overwrite each other. `row_version`
 *      has been incremented since A4 and checked by nothing, so the second
 *      writer won and the first was never told.
 *
 *   4. A PUBLISHED routine is not editable, through any of the new actions.
 *      Draft and published are different things and the editor works on one.
 *
 *   DATABASE_URL=postgres://shikhon_app:… \
 *     node --test services/rms-svc/test/editor-lock-undo.test.ts
 */
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { createDb, type Db, type TenantContext } from '../../../packages/server-core/src/db.ts';
import {
  installTestKeys, call, lockFixtures, unlockFixtures, asBootstrap,
} from '../../../packages/server-core/test/harness.ts';

const DATABASE_URL = process.env.DATABASE_URL;
const skip = !DATABASE_URL ? 'DATABASE_URL not set' : false;

const T       = '7c950000-0000-4000-8000-0000000000a0';
const HEAD    = '7c950000-0000-4000-8000-0000000000a1';
const RAFIQ   = '7c950000-0000-4000-8000-0000000000a2';
const SALMA   = '7c950000-0000-4000-8000-0000000000a3';
const STUDENT = '7c950000-0000-4000-8000-0000000000a4';
const YEAR    = '7c950000-0000-4000-8000-0000000000c1';
const KLASS   = '7c950000-0000-4000-8000-0000000000d1';
const SEC_A   = '7c950000-0000-4000-8000-0000000000e1';
const BANGLA  = '7c950000-0000-4000-8000-0000000000f1';
const MATHS   = '7c950000-0000-4000-8000-0000000000f2';
const TPL     = '7c950000-0000-4000-8000-00000000ab01';
const ROOM    = '7c950000-0000-4000-8000-00000000ab02';
const ROUTINE = '7c950000-0000-4000-8000-00000000ab03';

/** A second school, so isolation is a question that can be asked. */
const T_B     = '7c950000-0000-4000-8000-0000000000b0';
const HEAD_B  = '7c950000-0000-4000-8000-0000000000b1';

let db: Db;
let headToken = '';
let headBToken = '';
let studentToken = '';
let editor: Parameters<typeof call>[0];

const head: TenantContext = { tenantId: T, userId: HEAD, role: 'principal' };
const headB: TenantContext = { tenantId: T_B, userId: HEAD_B, role: 'principal' };

const post = (body: unknown, token = headToken) =>
  call(editor, { method: 'POST', url: '/', token, body } as Parameters<typeof call>[1]);
const grid = (token = headToken) =>
  call(editor, { url: `/?sectionId=${SEC_A}`, token } as Parameters<typeof call>[1]);

interface Slot {
  id: string; dayOfWeek: number; periodNo: number; subjectBn: string | null;
  teacherName: string | null; roomName: string | null;
  isPinned: boolean; rowVersion: number;
}
interface Grid {
  slots: Slot[];
  undo: Array<{ id: string; action: string; labelBn: string }>;
  routine: { id: string; status: string; editable: boolean };
}

const slots = async (): Promise<Slot[]> => ((await grid()).body as unknown as Grid).slots;
const undoStack = async () => ((await grid()).body as unknown as Grid).undo;
const findSlot = async (subjectBn: string): Promise<Slot> => {
  const s = (await slots()).find((x) => x.subjectBn === subjectBn);
  assert.ok(s, `no slot for ${subjectBn}`);
  return s;
};

describe('P9-5 — locking and undoing a routine edit', { skip }, () => {
  before(async () => {
    await installTestKeys();
    await lockFixtures(DATABASE_URL as string);
    db = createDb(DATABASE_URL as string);

    await asBootstrap(db, head, async (c) => {
      await c.query('DELETE FROM tenants WHERE id = $1', [T]);
      await c.query(
        `INSERT INTO tenants (id, slug, name_bn, name_en, stream, level, weekend_days)
         VALUES ($1,'p95-edit','পি৯৫','P95','bangla_medium','secondary','{5,6}')`, [T]);
      for (const [id, bn, phone, role] of [
        [HEAD, 'প্রধান', '+8801799950001', 'principal'],
        [RAFIQ, 'রফিক স্যার', '+8801799950002', 'subject_teacher'],
        [SALMA, 'সালমা ম্যাডাম', '+8801799950003', 'subject_teacher'],
        [STUDENT, 'ছাত্র', '+8801799950004', 'student'],
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
      await c.query(
        `INSERT INTO sections (id, tenant_id, class_id, academic_year_id, name, student_count, shift)
         VALUES ($1,$2,$3,$4,'ক',0,'single')`, [SEC_A, T, KLASS, YEAR]);
      for (const [id, nameBn] of [[BANGLA, 'বাংলা'], [MATHS, 'গণিত']] as const) {
        await c.query(
          `INSERT INTO subjects (id, tenant_id, name_bn, name_en, short_name)
           VALUES ($1,$2,$3,'S',substr($3,1,3))`, [id, T, nameBn]);
        await c.query(
          `INSERT INTO class_subjects
             (tenant_id, class_id, subject_id, academic_year_id, periods_per_week)
           VALUES ($1,$2,$3,$4,3)`, [T, KLASS, id, YEAR]);
      }
      await c.query(
        `INSERT INTO section_subject_teachers
           (tenant_id, section_id, subject_id, teacher_id, academic_year_id, started_on)
         VALUES ($1,$2,$3,$4,$5,'2026-01-05'), ($1,$2,$6,$7,$5,'2026-01-05')`,
        [T, SEC_A, BANGLA, RAFIQ, YEAR, MATHS, SALMA]);

      await c.query(
        `INSERT INTO period_templates (id, tenant_id, name_bn, shift, effective_from, is_active)
         VALUES ($1,$2,'নিয়মিত','single','2026-01-01',true)`, [TPL, T]);
      for (let i = 1; i <= 4; i++) {
        await c.query(
          `INSERT INTO period_definitions
             (tenant_id, template_id, period_no, label_bn, starts_at, ends_at, kind)
           VALUES ($1,$2,$3,$4,$5::time,$6::time,'teaching')`,
          [T, TPL, i, `${i} নম্বর`,
           `${String(8 + i).padStart(2, '0')}:00`, `${String(8 + i).padStart(2, '0')}:45`]);
      }
      await c.query(
        `INSERT INTO rooms (id, tenant_id, code, name_bn, capacity, capabilities, is_bookable)
         VALUES ($1,$2,'R-1','কক্ষ ১',60,'{}',true)`, [ROOM, T]);
      await c.query(
        `INSERT INTO routines (id, tenant_id, academic_year_id, period_template_id, shift,
                               name_bn, version, status, effective_from, generated_by, created_by)
         VALUES ($1,$2,$3,$4,'single','খসড়া',1,'draft','2026-01-01','manual',$5)`,
        [ROUTINE, T, YEAR, TPL, HEAD]);
    });

    await asBootstrap(db, headB, async (c) => {
      await c.query('DELETE FROM tenants WHERE id = $1', [T_B]);
      await c.query(
        `INSERT INTO tenants (id, slug, name_bn, name_en, stream, level)
         VALUES ($1,'p95-other','পাশের','Other','bangla_medium','secondary')`, [T_B]);
      await c.query(
        `INSERT INTO users (id, tenant_id, full_name_bn, full_name_en, phone_e164, status)
         VALUES ($1,$2,'অন্য','B','+8801799950009','active')`, [HEAD_B, T_B]);
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
    editor = (await import('../api/editor.ts')).default;
  });

  after(async () => {
    if (!db) return;
    for (const [ctx, id] of [[head, T], [headB, T_B]] as const) {
      await asBootstrap(db, ctx, (c) => c.query('DELETE FROM tenants WHERE id = $1', [id]));
    }
    await db.end();
    await unlockFixtures();
  });

  /**
   * One draft routine, one lesson in it, an empty undo stack.
   *
   * The log is emptied by marking entries consumed, not by deleting them:
   * `edit_log_delete_scope` is `USING (false)`, so nothing — including this
   * fixture — may remove a row. The first version of this file used DELETE,
   * which removed nothing and let every test inherit the previous one's
   * stack. The policy was right; the fixture was wrong.
   */
  const drainLog = () => asBootstrap(db, head, (c) => c.query(
    `UPDATE routine_edit_log SET undone_at = now() WHERE tenant_id = $1`, [T]));

  beforeEach(async () => {
    await asBootstrap(db, head, async (c) => {
      await c.query('DELETE FROM routine_slots WHERE tenant_id = $1', [T]);
      await c.query(`UPDATE routines SET status = 'draft' WHERE id = $1`, [ROUTINE]);
    });
    const r = await post({
      action: 'place', routineId: ROUTINE, sectionId: SEC_A,
      dayOfWeek: 0, periodNo: 1, subjectId: BANGLA, teacherId: RAFIQ, roomId: ROOM,
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    // The placement itself is an undoable edit; drain it so each test starts
    // from a stack it controls.
    await drainLog();
  });

  /* ─────────────────────────────── lock ─────────────────────────────── */

  test('THE ONE THAT MATTERS — a locked slot refuses to be moved or removed', async () => {
    const slot = await findSlot('বাংলা');
    assert.equal(slot.isPinned, false);

    const locked = await post({ action: 'lock', slotId: slot.id, rowVersion: slot.rowVersion });
    assert.equal(locked.status, 200, JSON.stringify(locked.body));
    assert.equal((locked.body as { isPinned: boolean }).isPinned, true);
    assert.equal((await findSlot('বাংলা')).isPinned, true, 'and the grid says so');

    // The enforcement has existed since migration 006; this is the first time
    // a school could reach it.
    const moved = await post({ action: 'move', slotId: slot.id, dayOfWeek: 1, periodNo: 2 });
    assert.equal(moved.status, 409);
    assert.equal((moved.body as { error: string }).error, 'slot_pinned');
    assert.match((moved.body as { message: string }).message, /পিন/);

    const removed = await post({ action: 'remove', slotId: slot.id });
    assert.equal(removed.status, 409);
    assert.equal((removed.body as { error: string }).error, 'slot_pinned');
  });

  test('unlocking gives it back', async () => {
    const slot = await findSlot('বাংলা');
    await post({ action: 'lock', slotId: slot.id });
    await post({ action: 'unlock', slotId: slot.id });
    assert.equal((await findSlot('বাংলা')).isPinned, false);
    assert.equal((await post({ action: 'move', slotId: slot.id, dayOfWeek: 1, periodNo: 2 })).status,
      200, 'and it moves again');
  });

  test('locking twice is not an error, and does not stack up undo entries', async () => {
    // A second lock that logged an entry would push the coordinator's real
    // previous edit out of reach of the undo button.
    const slot = await findSlot('বাংলা');
    await post({ action: 'lock', slotId: slot.id });
    const again = await post({ action: 'lock', slotId: (await findSlot('বাংলা')).id });
    assert.equal(again.status, 200);
    assert.equal((again.body as { changed: boolean }).changed, false);
    assert.equal((await undoStack()).length, 1, 'one lock, one entry');
  });

  /* ─────────────────────────────── undo ─────────────────────────────── */

  test('THE ONE THAT MATTERS — undo puts a moved lesson back where it was', async () => {
    const before = await findSlot('বাংলা');
    assert.equal(before.dayOfWeek, 0);
    assert.equal(before.periodNo, 1);

    await post({ action: 'move', slotId: before.id, dayOfWeek: 2, periodNo: 3,
                 rowVersion: before.rowVersion });
    const moved = await findSlot('বাংলা');
    assert.equal(moved.dayOfWeek, 2);
    assert.equal(moved.periodNo, 3);

    const stack = await undoStack();
    assert.equal(stack.length, 1);
    assert.equal(stack[0].action, 'move');
    assert.match(stack[0].labelBn, /নবম-ক · বাংলা/,
      'the button must say what it will undo, in words');

    const undone = await post({ action: 'undo', routineId: ROUTINE });
    assert.equal(undone.status, 200, JSON.stringify(undone.body));
    const back = await findSlot('বাংলা');
    assert.equal(back.dayOfWeek, 0, 'the day it came from');
    assert.equal(back.periodNo, 1, 'and the period');
    assert.equal((await undoStack()).length, 0, 'the entry is consumed');
  });

  test('undo restores a removed lesson, and a placed one disappears again', async () => {
    const slot = await findSlot('বাংলা');
    await post({ action: 'remove', slotId: slot.id, rowVersion: slot.rowVersion });
    assert.equal((await slots()).length, 0);
    await post({ action: 'undo', routineId: ROUTINE });
    assert.equal((await slots()).length, 1, 'the lesson is back in the grid');

    // And the other direction: undoing a placement takes it out.
    await drainLog();
    const placed = await post({
      action: 'place', routineId: ROUTINE, sectionId: SEC_A,
      dayOfWeek: 3, periodNo: 2, subjectId: MATHS, teacherId: SALMA, roomId: ROOM,
    });
    assert.equal(placed.status, 200, JSON.stringify(placed.body));
    assert.equal((await slots()).length, 2);
    await post({ action: 'undo', routineId: ROUTINE });
    assert.equal((await slots()).length, 1, 'the placement is reversed');
  });

  test('undo restores the teacher and room an assign changed', async () => {
    const slot = await findSlot('বাংলা');
    assert.equal(slot.teacherName, 'রফিক স্যার');
    // Reassigning to Salma needs her to carry the subject; she does not, so
    // the honest edit here is the room.
    await post({ action: 'assign', slotId: slot.id, roomId: null,
                 rowVersion: slot.rowVersion });
    assert.equal((await findSlot('বাংলা')).roomName, null);

    await post({ action: 'undo', routineId: ROUTINE });
    assert.equal((await findSlot('বাংলা')).roomName, 'কক্ষ ১', 'the room comes back');
  });

  test('undo unwinds several edits, newest first', async () => {
    const s0 = await findSlot('বাংলা');
    await post({ action: 'move', slotId: s0.id, dayOfWeek: 1, periodNo: 2 });
    await post({ action: 'move', slotId: s0.id, dayOfWeek: 3, periodNo: 4 });
    assert.equal((await undoStack()).length, 2);

    await post({ action: 'undo', routineId: ROUTINE });
    const mid = await findSlot('বাংলা');
    assert.deepEqual([mid.dayOfWeek, mid.periodNo], [1, 2], 'back one step, not all the way');

    await post({ action: 'undo', routineId: ROUTINE });
    const start = await findSlot('বাংলা');
    assert.deepEqual([start.dayOfWeek, start.periodNo], [0, 1]);
  });

  test('an empty stack says so rather than pretending', async () => {
    const r = await post({ action: 'undo', routineId: ROUTINE });
    assert.equal(r.status, 409);
    assert.equal((r.body as { error: string }).error, 'nothing_to_undo');
  });

  test('there is NO redo — an undone entry is consumed', async () => {
    // Documented limit, asserted so it cannot become an accident. Pressing
    // undo twice must not put the move back.
    const slot = await findSlot('বাংলা');
    await post({ action: 'move', slotId: slot.id, dayOfWeek: 2, periodNo: 3 });
    await post({ action: 'undo', routineId: ROUTINE });
    const second = await post({ action: 'undo', routineId: ROUTINE });
    assert.equal(second.status, 409);
    assert.equal((second.body as { error: string }).error, 'nothing_to_undo');
    const s = await findSlot('বাংলা');
    assert.deepEqual([s.dayOfWeek, s.periodNo], [0, 1], 'still where undo put it');
  });

  test('an undo that cannot fit says which lesson is in the way', async () => {
    // Move A out of Sunday period 1, put B there, then try to undo A's move.
    const a = await findSlot('বাংলা');
    await post({ action: 'move', slotId: a.id, dayOfWeek: 2, periodNo: 3 });
    const placed = await post({
      action: 'place', routineId: ROUTINE, sectionId: SEC_A,
      dayOfWeek: 0, periodNo: 1, subjectId: MATHS, teacherId: SALMA, roomId: ROOM,
    });
    assert.equal(placed.status, 200, JSON.stringify(placed.body));

    // The placement is newest, so undo it first to reach the move.
    await post({ action: 'undo', routineId: ROUTINE });
    // Now put something else in that hour by hand, so the move's inverse
    // cannot land.
    const blocked = await post({
      action: 'place', routineId: ROUTINE, sectionId: SEC_A,
      dayOfWeek: 0, periodNo: 1, subjectId: MATHS, teacherId: SALMA, roomId: ROOM,
    });
    assert.equal(blocked.status, 200, JSON.stringify(blocked.body));
    await asBootstrap(db, head, (c) => c.query(
      `UPDATE routine_edit_log SET undone_at = now()
        WHERE tenant_id = $1 AND action = 'place' AND undone_at IS NULL`, [T]));

    const r = await post({ action: 'undo', routineId: ROUTINE });
    assert.equal(r.status, 409, JSON.stringify(r.body));
    assert.equal((r.body as { error: string }).error, 'undo_blocked');
    assert.match((r.body as { message: string }).message, /বাংলা/,
      'it names the lesson it could not put back');
  });

  /* ──────────────────────────── concurrency ─────────────────────────── */

  test('THE ONE THAT MATTERS — a stale edit is refused, not silently applied', async () => {
    // Two coordinators load the grid. One moves a class. The other, still
    // holding the version they rendered, moves it somewhere else.
    const asRendered = await findSlot('বাংলা');

    const first = await post({ action: 'move', slotId: asRendered.id,
                              dayOfWeek: 1, periodNo: 2,
                              rowVersion: asRendered.rowVersion });
    assert.equal(first.status, 200);

    const second = await post({ action: 'move', slotId: asRendered.id,
                               dayOfWeek: 3, periodNo: 4,
                               rowVersion: asRendered.rowVersion });
    assert.equal(second.status, 409, 'the second writer must not win silently');
    assert.equal((second.body as { error: string }).error, 'stale_slot');
    assert.match((second.body as { message: string }).message, /অন্য কেউ বদলে ফেলেছেন/);

    const s = await findSlot('বাংলা');
    assert.deepEqual([s.dayOfWeek, s.periodNo], [1, 2], 'the first writer’s change stands');
  });

  test('and re-reading the grid lets the second edit through', async () => {
    const first = await findSlot('বাংলা');
    await post({ action: 'move', slotId: first.id, dayOfWeek: 1, periodNo: 2,
                 rowVersion: first.rowVersion });
    const fresh = await findSlot('বাংলা');
    const retry = await post({ action: 'move', slotId: fresh.id, dayOfWeek: 3, periodNo: 4,
                               rowVersion: fresh.rowVersion });
    assert.equal(retry.status, 200, 'the remedy is to look, then act');
  });

  test('a caller that sends no version keeps the old behaviour', async () => {
    // The endpoint predates `rowVersion` and other screens still call it.
    const slot = await findSlot('বাংলা');
    await post({ action: 'move', slotId: slot.id, dayOfWeek: 1, periodNo: 2 });
    const noVersion = await post({ action: 'move', slotId: slot.id, dayOfWeek: 3, periodNo: 4 });
    assert.equal(noVersion.status, 200);
  });

  /* ───────────────────────── draft and security ─────────────────────── */

  test('a PUBLISHED routine refuses lock, unlock and undo', async () => {
    const slot = await findSlot('বাংলা');
    await post({ action: 'move', slotId: slot.id, dayOfWeek: 1, periodNo: 2 });
    await asBootstrap(db, head, (c) =>
      c.query(`UPDATE routines SET status = 'active' WHERE id = $1`, [ROUTINE]));

    for (const body of [
      { action: 'lock', slotId: slot.id },
      { action: 'unlock', slotId: slot.id },
      { action: 'undo', routineId: ROUTINE },
    ]) {
      const r = await post(body);
      assert.equal(r.status, 409, `${body.action} on a published routine`);
      assert.equal((r.body as { error: string }).error, 'routine_not_editable');
    }
  });

  test('a student can neither lock nor undo', async () => {
    const slot = await findSlot('বাংলা');
    assert.equal((await post({ action: 'lock', slotId: slot.id }, studentToken)).status, 403);
    assert.equal((await post({ action: 'undo', routineId: ROUTINE }, studentToken)).status, 403);
    assert.equal((await grid(studentToken)).status, 403);
  });

  test('TENANT ISOLATION — another school cannot lock or undo this one’s routine', async () => {
    const slot = await findSlot('বাংলা');
    for (const body of [
      { action: 'lock', slotId: slot.id },
      { action: 'undo', routineId: ROUTINE },
      { action: 'move', slotId: slot.id, dayOfWeek: 1, periodNo: 2 },
    ]) {
      const r = await post(body, headBToken);
      assert.notEqual(r.status, 200, `${body.action} crossed a tenant boundary`);
    }
    const s = await findSlot('বাংলা');
    assert.deepEqual([s.dayOfWeek, s.periodNo], [0, 1], 'untouched');

    // And the log itself is invisible to them.
    const { rows } = await asBootstrap(db, headB, (c) => c.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM routine_edit_log', []));
    assert.equal(rows[0].n, '0');
  });

  test('NOBODY may delete an undo entry, not even to tidy up', async () => {
    // Found by this file's own fixture, which used DELETE and silently
    // removed nothing, letting every test inherit the previous one's stack.
    // The policy was right. A coordinator who could delete their own entries
    // could hide an edit from the stack that exists to reverse it.
    const slot = await findSlot('বাংলা');
    await post({ action: 'lock', slotId: slot.id });
    assert.equal((await undoStack()).length, 1);

    const del = await asBootstrap(db, head, (c) =>
      c.query('DELETE FROM routine_edit_log WHERE tenant_id = $1', [T]));
    assert.equal(del.rowCount, 0, 'the delete policy is USING (false), for everyone');
    assert.equal((await undoStack()).length, 1, 'and the entry is still there');
  });

  test('the undo log names what it will reverse, and never a uuid', async () => {
    const slot = await findSlot('বাংলা');
    await post({ action: 'lock', slotId: slot.id });
    const stack = await undoStack();
    assert.equal(stack.length, 1);
    assert.equal(stack[0].action, 'lock');
    assert.doesNotMatch(stack[0].labelBn, /[0-9a-f]{8}-[0-9a-f]{4}/);
    assert.doesNotMatch(stack[0].labelBn, /[0-9]+/, 'Bangla numerals, not Latin');
    assert.match(stack[0].labelBn, /পিরিয়ড/);
  });
});
