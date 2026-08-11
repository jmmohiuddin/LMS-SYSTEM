/**
 * Soft-constraint evaluation  (F-505, wireframe §8.2)
 *
 * F-505: "Every soft-constraint violation in a generated routine must be
 * listed, not silently accepted." §8.2 draws what that list looks like:
 *
 *     ⚠ নরম শর্ত ছাড় দেওয়া হয়েছে: ৭
 *     • রফিক ইসলাম — সাপ্তাহিক ২৬ পিরিয়ড (লক্ষ্য ২৪) — যোগ্য গণিত শিক্ষক কম
 *     • নবম–খ গণিত সোম ও মঙ্গল পরপর
 *     • শিরিন — দিনে ৩ বার কক্ষ পরিবর্তন
 *
 * Three things that shape this file, all read off those three lines.
 *
 * A violation names a PERSON or a SECTION, never a rule. "teacher_weekly_
 * cap_exceeded: 3" is a number a coordinator cannot act on; "রফিক ইসলাম —
 * সাপ্তাহিক ২৬ পিরিয়ড (লক্ষ্য ২৪)" is a conversation they can have.
 *
 * The first line carries a CAUSE — "যোগ্য গণিত শিক্ষক কম", too few
 * qualified Maths teachers. A soft constraint is traded away for a reason,
 * and the reason is what turns the list into an argument for a hire (which
 * is what F-515 says routine analytics are for). Where the cause can be
 * computed it is stated; where it cannot, the field is absent rather than
 * guessed.
 *
 * Pure. No database, no clock. It takes the placed slots and what the
 * school configured, and returns a list. That is what lets the rules be
 * tested against a hand-written timetable rather than against whatever the
 * solver happened to produce.
 */

export interface EvaluatedSlot {
  dayOfWeek: number;
  periodNo: number;
  startsAt: string;
  endsAt: string;
  sectionId: string;
  subjectId: string;
  teacherId: string;
  roomId: string | null;
}

export interface TeacherLimits {
  maxPerWeek: number;
  maxPerDay: number;
}

export interface SoftConstraintInput {
  slots: EvaluatedSlot[];
  /** teacherId → their configured caps. Missing means "no cap configured". */
  limits: Map<string, TeacherLimits>;
  /** Display names, so a violation can name a person rather than a uuid. */
  teacherNames: Map<string, string>;
  sectionNames: Map<string, string>;
  subjectNames: Map<string, string>;
  /**
   * subjectId → how many teachers in the school are competent to teach it.
   * This is what turns "over cap" into "over cap BECAUSE there is one
   * qualified Maths teacher", which is the difference between a complaint
   * and a hiring case.
   */
  competentTeacherCount: Map<string, number>;
  /**
   * How many days the school actually teaches. Sunday–Thursday for most
   * Bangladeshi schools, six days for some, and it is what decides whether
   * a clustering complaint is fair — see the adjacency rule below.
   */
  teachingDayCount: number;
  /** How many room changes in one day counts as churn. §8.2 flags 3. */
  roomChurnThreshold?: number;
}

export type SoftCode =
  | 'teacher_weekly_cap'
  | 'teacher_daily_cap'
  | 'subject_consecutive_days'
  | 'subject_twice_in_one_day'
  | 'teacher_room_churn'
  | 'teacher_no_free_day';

export interface SoftViolation {
  code: SoftCode;
  /** Ready to render. §8.2's list is sentences, not codes plus a lookup. */
  detailBn: string;
  /** Present only when it can be computed. Never guessed. */
  causeBn?: string;
  teacherId?: string;
  sectionId?: string;
  subjectId?: string;
  dayOfWeek?: number;
  /** The number that was exceeded, and by how much, for sorting. */
  overBy?: number;
}

export interface SoftConstraintReport {
  violations: SoftViolation[];
  /**
   * Rules this build cannot evaluate, and why.
   *
   * F-505 forbids silently accepting a violation. A rule that is not
   * checked at all is a stronger version of the same problem: the screen
   * says "০ লঙ্ঘন" and means "০ of the rules I know about". Saying which
   * rules were not run is the only honest way to show a clean report.
   */
  notEvaluated: Array<{ ruleBn: string; whyBn: string }>;
}

const BN_DIGITS = '০১২৩৪৫৬৭৮৯';
const bn = (n: number): string =>
  String(n).replace(/\d/g, (d) => BN_DIGITS[Number(d)]);

/** 0 = Sunday, matching routine_slots.day_of_week. */
const DAY_BN = ['রবি', 'সোম', 'মঙ্গল', 'বুধ', 'বৃহস্পতি', 'শুক্র', 'শনি'];

const DEFAULT_ROOM_CHURN = 3;

export function evaluateSoftConstraints(input: SoftConstraintInput): SoftConstraintReport {
  const violations: SoftViolation[] = [];
  const churnThreshold = input.roomChurnThreshold ?? DEFAULT_ROOM_CHURN;

  const teacher = (id: string): string => input.teacherNames.get(id) ?? 'শিক্ষক';
  const section = (id: string): string => input.sectionNames.get(id) ?? 'শাখা';
  const subject = (id: string): string => input.subjectNames.get(id) ?? 'বিষয়';

  // ── teacher load, weekly and daily ──────────────────────────────────
  const perTeacher = new Map<string, EvaluatedSlot[]>();
  for (const s of input.slots) {
    const list = perTeacher.get(s.teacherId);
    if (list) list.push(s);
    else perTeacher.set(s.teacherId, [s]);
  }

  for (const [teacherId, slots] of perTeacher) {
    const limits = input.limits.get(teacherId);
    if (!limits) continue;   // no cap configured is not a violation

    if (slots.length > limits.maxPerWeek) {
      // §8.2's first line, cause included. The cause is only claimed when
      // the data supports it: a teacher over cap because they are the only
      // person qualified for a subject is a hiring problem; a teacher over
      // cap in a school with five qualified colleagues is a distribution
      // problem, and saying the wrong one sends the coordinator the wrong way.
      const scarce = scarcestSubject(slots, input.competentTeacherCount);
      violations.push({
        code: 'teacher_weekly_cap',
        teacherId,
        overBy: slots.length - limits.maxPerWeek,
        detailBn: `${teacher(teacherId)} — সাপ্তাহিক ${bn(slots.length)} পিরিয়ড `
                + `(লক্ষ্য ${bn(limits.maxPerWeek)})`,
        ...(scarce
          ? { causeBn: `যোগ্য ${subject(scarce.subjectId)} শিক্ষক কম `
                     + `(${bn(scarce.competent)} জন)`, subjectId: scarce.subjectId }
          : {}),
      });
    }

    const byDay = new Map<number, number>();
    for (const s of slots) byDay.set(s.dayOfWeek, (byDay.get(s.dayOfWeek) ?? 0) + 1);
    for (const [day, count] of [...byDay].sort((a, b) => a[0] - b[0])) {
      if (count > limits.maxPerDay) {
        violations.push({
          code: 'teacher_daily_cap',
          teacherId,
          dayOfWeek: day,
          overBy: count - limits.maxPerDay,
          detailBn: `${teacher(teacherId)} — ${DAY_BN[day]}বার ${bn(count)} পিরিয়ড `
                  + `(দৈনিক লক্ষ্য ${bn(limits.maxPerDay)})`,
        });
      }
    }

    // A teacher carrying a full load with no day off is the pattern that
    // turns into sick leave. Only flagged for teachers actually at or over
    // their weekly cap — a light load spread over six days is fine.
    const daysWorked = byDay.size;
    if (daysWorked >= 6 && slots.length >= limits.maxPerWeek) {
      violations.push({
        code: 'teacher_no_free_day',
        teacherId,
        detailBn: `${teacher(teacherId)} — সপ্তাহে কোনো মুক্ত দিন নেই `
                + `(${bn(slots.length)} পিরিয়ড, ${bn(daysWorked)} দিন)`,
      });
    }
  }

  // ── subject distribution across the week ────────────────────────────
  const perSectionSubject = new Map<string, EvaluatedSlot[]>();
  for (const s of input.slots) {
    const k = `${s.sectionId}|${s.subjectId}`;
    const list = perSectionSubject.get(k);
    if (list) list.push(s);
    else perSectionSubject.set(k, [s]);
  }

  for (const [key, slots] of perSectionSubject) {
    const [sectionId, subjectId] = key.split('|');
    const days = [...new Set(slots.map((s) => s.dayOfWeek))].sort((a, b) => a - b);

    // §8.2: "নবম–খ গণিত সোম ও মঙ্গল পরপর" — the same subject on
    // back-to-back days.
    //
    // Only reported when it was AVOIDABLE. Choosing D days out of W with no
    // two adjacent is possible exactly when D ≤ ⌈W/2⌉ — so a subject
    // needing four days in a five-day week must touch adjacent days, and
    // saying so would fill the list with noise the coordinator can do
    // nothing about. A list nobody reads is the same as no list.
    if (days.length <= Math.ceil(input.teachingDayCount / 2)) {
      for (let i = 0; i + 1 < days.length; i++) {
        if (days[i + 1] === days[i] + 1) {
          violations.push({
            code: 'subject_consecutive_days',
            sectionId, subjectId,
            dayOfWeek: days[i],
            detailBn: `${section(sectionId)} ${subject(subjectId)} `
                    + `${DAY_BN[days[i]]} ও ${DAY_BN[days[i + 1]]} পরপর`,
          });
        }
      }
    }

    const byDay = new Map<number, number>();
    for (const s of slots) byDay.set(s.dayOfWeek, (byDay.get(s.dayOfWeek) ?? 0) + 1);
    for (const [day, count] of [...byDay].sort((a, b) => a[0] - b[0])) {
      // Two periods of one subject in a day is normal for a double period
      // and poor for anything else. The solver never places doubles yet, so
      // any repeat here is clustering — but only reportable if there was a
      // free day to move it to.
      if (count > 1 && byDay.size < input.teachingDayCount) {
        violations.push({
          code: 'subject_twice_in_one_day',
          sectionId, subjectId,
          dayOfWeek: day,
          overBy: count - 1,
          detailBn: `${section(sectionId)} ${subject(subjectId)} — `
                  + `${DAY_BN[day]}বার ${bn(count)} পিরিয়ড একই দিনে`,
        });
      }
    }
  }

  // ── room-to-room movement ───────────────────────────────────────────
  // §8.2: "শিরিন — দিনে ৩ বার কক্ষ পরিবর্তন". Counted per day in period
  // order: a teacher who ends period 2 in room 204 and starts period 3 in
  // Lab 1 has moved once. Free periods in between do not count as a move,
  // because the walk is what costs, not the adjacency.
  for (const [teacherId, slots] of perTeacher) {
    const byDay = new Map<number, EvaluatedSlot[]>();
    for (const s of slots) {
      const list = byDay.get(s.dayOfWeek);
      if (list) list.push(s);
      else byDay.set(s.dayOfWeek, [s]);
    }
    for (const [day, daySlots] of [...byDay].sort((a, b) => a[0] - b[0])) {
      const ordered = [...daySlots].sort((a, b) => a.periodNo - b.periodNo);
      let moves = 0;
      for (let i = 1; i < ordered.length; i++) {
        const prev = ordered[i - 1].roomId;
        const cur = ordered[i].roomId;
        if (prev && cur && prev !== cur) moves++;
      }
      if (moves >= churnThreshold) {
        violations.push({
          code: 'teacher_room_churn',
          teacherId,
          dayOfWeek: day,
          overBy: moves - churnThreshold + 1,
          detailBn: `${teacher(teacherId)} — ${DAY_BN[day]}বার দিনে `
                  + `${bn(moves)} বার কক্ষ পরিবর্তন`,
        });
      }
    }
  }

  // Worst first: a teacher eight periods over cap matters more than one
  // section with a subject on two adjacent days.
  violations.sort((a, b) => (b.overBy ?? 0) - (a.overBy ?? 0));

  return {
    violations,
    notEvaluated: [
      {
        ruleBn: 'কঠিন বিষয় দিনের শুরুতে রাখা',
        // The schema has no notion of cognitive demand, and inventing a
        // default every school leaves untouched would make this rule fire
        // never while appearing to be checked — worse than absent.
        whyBn: 'বিষয়ের কাঠিন্য মাত্রা কোথাও সংরক্ষিত নেই',
      },
    ],
  };
}

/**
 * Of the subjects this teacher carries, the one with the fewest competent
 * colleagues — and only when that number is genuinely small.
 *
 * Returns nothing when every subject has several qualified teachers,
 * because then the load is a distribution choice rather than a shortage,
 * and blaming a shortage would send a coordinator to recruit instead of to
 * rebalance.
 */
function scarcestSubject(
  slots: EvaluatedSlot[],
  competent: Map<string, number>,
): { subjectId: string; competent: number } | null {
  let best: { subjectId: string; competent: number } | null = null;
  for (const subjectId of new Set(slots.map((s) => s.subjectId))) {
    const n = competent.get(subjectId);
    if (n === undefined || n > 2) continue;
    if (!best || n < best.competent) best = { subjectId, competent: n };
  }
  return best;
}
