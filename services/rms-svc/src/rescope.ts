/**
 * Scoped re-solve: what to recalculate, and what to leave alone.  (P9-6)
 *
 * ── There is no second solver, and there did not need to be ──────────────
 * `RmsSolver` is a TOP-UP solver: for each (section, subject) it places
 * `periodsPerWeek − alreadyPlaced`, counting whatever is already active in
 * the routine. So a routine that is fully placed is a routine it will not
 * touch — and removing a handful of slots makes it place exactly those back,
 * around everything that stayed.
 *
 * That is the whole mechanism. "Re-solve only the affected area" is
 * `remove the affected slots, then run the solver you already have`. Nothing
 * in the constraint engine, the clash checking, the room matching or the
 * explanation is duplicated, and a change to any of them changes this too.
 *
 * ── The dependency closure is the affected set, and nothing beyond it ────
 * §3 asks for the closure and warns against re-solving an arbitrary
 * percentage. Those pull in opposite directions until you notice that the
 * solver only ever ADDS into free hours: it cannot displace a slot that
 * stayed. So freeing teacher Rahim's Wednesday hour cannot cascade into
 * anyone else's timetable — the only demands short after the removal are the
 * ones removed, and the only slots that move are theirs.
 *
 * The closure is therefore exactly the selected slots. Anything wider would
 * be movement a coordinator did not ask for.
 *
 * ── Pinned slots are never selected ─────────────────────────────────────
 * §4 is mandatory and it is satisfied by construction rather than by a check
 * somewhere: a pinned slot is excluded from the removal set, so it is still
 * there when the solver counts what is already placed, and the solver works
 * around it exactly as it works around every other placed lesson.
 */
import type pg from 'pg';

type Client = Pick<pg.PoolClient, 'query'>;

/**
 * What a coordinator points at.
 *
 * Deliberately four selectors and not "any predicate". Each maps to a
 * question a school actually asks — "Rahim is away", "rebuild 9-A",
 * "the lab is closed", "Wednesday is a holiday" — and each resolves to a set
 * of slots the solver can put back. §2 says not to expose an option the
 * solver cannot guarantee, and a free-form filter would be one.
 */
export type Scope =
  | { kind: 'teacher'; teacherId: string }
  | { kind: 'section'; sectionId: string }
  | { kind: 'room'; roomId: string }
  | { kind: 'day'; dayOfWeek: number };

export interface ScopedSlot {
  id: string;
  dayOfWeek: number;
  periodNo: number;
  sectionId: string | null;
  subjectId: string | null;
  teacherId: string | null;
  roomId: string | null;
  sectionLabel: string | null;
  subjectBn: string | null;
  teacherBn: string | null;
  roomLabel: string | null;
  isPinned: boolean;
  rowVersion: number;
}

const DAY_BN = ['রবি', 'সোম', 'মঙ্গল', 'বুধ', 'বৃহঃ', 'শুক্র', 'শনি'];
const BN_DIGITS = '০১২৩৪৫৬৭৮৯';
const bn = (n: number): string => String(n).replace(/[0-9]/g, (d) => BN_DIGITS[Number(d)]);

/** "সোম ৩য় পিরিয়ড" — where a lesson sits, in the words the grid uses. */
export function whenBn(dayOfWeek: number, periodNo: number): string {
  return `${DAY_BN[dayOfWeek] ?? ''} ${bn(periodNo)} নম্বর পিরিয়ড`;
}

/** "৯ম-ক · গণিত · রফিক স্যার · সোম ৩য় পিরিয়ড" — §7's আগে/পরে line. */
export function slotLine(s: ScopedSlot): string {
  return [
    s.sectionLabel ?? 'শাখা',
    s.subjectBn ?? 'বিষয়',
    s.teacherBn ?? 'শিক্ষক',
    whenBn(s.dayOfWeek, s.periodNo),
  ].join(' · ');
}

const SELECT_SLOTS = `
  SELECT s.id, s.day_of_week, s.period_no, s.primary_section_id, s.subject_id,
         s.teacher_id, s.room_id, s.is_pinned, s.row_version,
         cl.name_bn || '-' || sec.name AS section_label,
         sub.name_bn AS subject_bn,
         u.full_name_bn AS teacher_bn,
         COALESCE(rm.name_bn, rm.code) AS room_label
    FROM routine_slots s
    LEFT JOIN sections sec ON sec.id = s.primary_section_id
    LEFT JOIN classes cl   ON cl.id = sec.class_id
    LEFT JOIN subjects sub ON sub.id = s.subject_id
    LEFT JOIN users u      ON u.id = s.teacher_id
    LEFT JOIN rooms rm     ON rm.id = s.room_id
   WHERE s.routine_id = $1 AND s.status = 'active' AND s.slot_kind = 'teaching'`;

interface Row {
  id: string; day_of_week: number; period_no: number;
  primary_section_id: string | null; subject_id: string | null;
  teacher_id: string | null; room_id: string | null;
  is_pinned: boolean; row_version: number;
  section_label: string | null; subject_bn: string | null;
  teacher_bn: string | null; room_label: string | null;
}

const toSlot = (r: Row): ScopedSlot => ({
  id: r.id, dayOfWeek: r.day_of_week, periodNo: r.period_no,
  sectionId: r.primary_section_id, subjectId: r.subject_id,
  teacherId: r.teacher_id, roomId: r.room_id,
  sectionLabel: r.section_label, subjectBn: r.subject_bn,
  teacherBn: r.teacher_bn, roomLabel: r.room_label,
  isPinned: r.is_pinned, rowVersion: r.row_version,
});

/** Every teaching slot in the routine, for the before/after comparison. */
export async function allSlots(c: Client, routineId: string): Promise<ScopedSlot[]> {
  const { rows } = await c.query<Row>(`${SELECT_SLOTS} ORDER BY s.day_of_week, s.period_no`,
                                      [routineId]);
  return rows.map(toSlot);
}

/**
 * The slots this scope selects, pinned ones included so the caller can SAY
 * how many were protected (§6 wants that number) — filtering happens at the
 * removal, not here.
 */
export async function slotsInScope(
  c: Client, routineId: string, scope: Scope,
): Promise<ScopedSlot[]> {
  const where = {
    teacher: 'AND s.teacher_id = $2',
    section: 'AND s.primary_section_id = $2',
    room: 'AND s.room_id = $2',
    day: 'AND s.day_of_week = $2',
  }[scope.kind];
  const arg =
    scope.kind === 'teacher' ? scope.teacherId
    : scope.kind === 'section' ? scope.sectionId
    : scope.kind === 'room' ? scope.roomId
    : scope.dayOfWeek;
  const { rows } = await c.query<Row>(
    `${SELECT_SLOTS} ${where} ORDER BY s.day_of_week, s.period_no`, [routineId, arg]);
  return rows.map(toSlot);
}

/**
 * A cheap answer to "has this routine changed since you looked?". (§10)
 *
 * Not a lock and not a row version — a FINGERPRINT. `count` moves when a
 * slot is added or removed and `sum(row_version)` moves when any slot is
 * edited, because every editor mutation increments it (P9-5). Two changes
 * that cancelled out exactly could in principle agree, and this is
 * documented as a fingerprint rather than a guarantee for that reason; the
 * database's exclusion constraints remain the thing that cannot be fooled.
 */
export async function fingerprint(c: Client, routineId: string): Promise<string> {
  const { rows } = await c.query<{ fp: string }>(
    `SELECT count(*)::text || ':' || COALESCE(sum(row_version), 0)::text AS fp
       FROM routine_slots
      WHERE routine_id = $1 AND status = 'active'`,
    [routineId]);
  return rows[0]?.fp ?? '0:0';
}

export interface Movement {
  beforeBn: string;
  afterBn: string;
  sectionLabel: string | null;
  subjectBn: string | null;
}

export interface ChangeSummary {
  affected: number;
  pinnedPreserved: number;
  removed: number;
  placed: number;
  unchanged: number;
  moved: Movement[];
  /** Demands that were taken out and could not be put back anywhere. */
  lost: number;
}

/**
 * What actually changed, by comparing the two snapshots. (§6/§7)
 *
 * Matched on (section, subject) rather than on slot id, because the solver
 * places NEW rows: the lesson a coordinator recognises as "9-A's maths that
 * used to be on Monday" has a different id afterwards, and pairing by id
 * would report every scoped re-solve as "all of it removed, all of it added"
 * — true, useless, and exactly the kind of summary nobody reads twice.
 */
export function summarise(
  before: ScopedSlot[], after: ScopedSlot[], scoped: ScopedSlot[],
): ChangeSummary {
  const key = (s: ScopedSlot) => `${s.sectionId ?? ''}|${s.subjectId ?? ''}`;
  const at = (s: ScopedSlot) => `${s.dayOfWeek}|${s.periodNo}`;

  const afterIds = new Set(after.map((s) => s.id));
  const unchanged = before.filter((s) => afterIds.has(s.id));
  const pinnedPreserved = scoped.filter((s) => s.isPinned).length;

  // Group both sides by (section, subject) and pair off the positions that
  // are no longer occupied with the ones that newly are.
  const groupBy = (rows: ScopedSlot[]): Map<string, ScopedSlot[]> => {
    const m = new Map<string, ScopedSlot[]>();
    for (const s of rows) {
      const list = m.get(key(s));
      if (list) list.push(s); else m.set(key(s), [s]);
    }
    return m;
  };
  const beforeIds = new Set(before.map((s) => s.id));
  const byKeyBefore = groupBy(before.filter((s) => !afterIds.has(s.id)));   // gone
  const byKeyAfter = groupBy(after.filter((s) => !beforeIds.has(s.id)));    // arrived

  const moved: Movement[] = [];
  let lost = 0;
  for (const [k, gone] of byKeyBefore) {
    const arrived = byKeyAfter.get(k) ?? [];
    // Same hour, same subject, same section: it did not actually move, the
    // row is just new. Not a movement a coordinator needs to read about.
    const goneMoved = gone.filter((g) => !arrived.some((a) => at(a) === at(g)));
    const arrivedNew = arrived.filter((a) => !gone.some((g) => at(g) === at(a)));
    for (let i = 0; i < goneMoved.length; i++) {
      const from = goneMoved[i];
      const to = arrivedNew[i];
      if (to) {
        moved.push({
          beforeBn: slotLine(from), afterBn: slotLine(to),
          sectionLabel: from.sectionLabel, subjectBn: from.subjectBn,
        });
      } else {
        // Taken out and never put back: the demand is now short, and §9 says
        // that must be said rather than shown as a successful re-solve.
        lost++;
        moved.push({
          beforeBn: slotLine(from), afterBn: 'কোথাও বসানো যায়নি',
          sectionLabel: from.sectionLabel, subjectBn: from.subjectBn,
        });
      }
    }
  }

  return {
    affected: scoped.length,
    pinnedPreserved,
    removed: before.length - unchanged.length,
    placed: after.length - unchanged.length,
    unchanged: unchanged.length,
    moved,
    lost,
  };
}
