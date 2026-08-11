/**
 * Soft-constraint evaluation — F-505, wireframe §8.2.
 *
 * §8.2 draws three example lines. They are the three this suite reproduces
 * character for character, because they are the specification:
 *
 *     • রফিক ইসলাম — সাপ্তাহিক ২৬ পিরিয়ড (লক্ষ্য ২৪) — যোগ্য গণিত শিক্ষক কম
 *     • নবম–খ গণিত সোম ও মঙ্গল পরপর
 *     • শিরিন — দিনে ৩ বার কক্ষ পরিবর্তন
 *
 * Pure module, so the fixtures are hand-written timetables rather than
 * whatever the solver happened to produce. That is the point of separating
 * it: these rules can be checked against the exact arrangement that should
 * trip them.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  evaluateSoftConstraints, type EvaluatedSlot, type SoftConstraintInput,
} from '../src/soft-constraints.ts';

const RAFIQ = 't-rafiq';
const SHIRIN = 't-shirin';
const MATHS = 's-maths';
const BANGLA = 's-bangla';
const SEC_9KHA = 'sec-9-kha';
const R204 = 'r-204';
const LAB1 = 'r-lab1';
const R301 = 'r-301';

function slot(over: Partial<EvaluatedSlot> = {}): EvaluatedSlot {
  return {
    dayOfWeek: 0, periodNo: 1, startsAt: '09:00', endsAt: '09:45',
    sectionId: SEC_9KHA, subjectId: BANGLA, teacherId: RAFIQ, roomId: R204,
    ...over,
  };
}

function input(slots: EvaluatedSlot[], over: Partial<SoftConstraintInput> = {}): SoftConstraintInput {
  return {
    slots,
    limits: new Map([
      [RAFIQ, { maxPerWeek: 24, maxPerDay: 6 }],
      [SHIRIN, { maxPerWeek: 24, maxPerDay: 6 }],
    ]),
    teacherNames: new Map([[RAFIQ, 'রফিক ইসলাম'], [SHIRIN, 'শিরিন']]),
    sectionNames: new Map([[SEC_9KHA, 'নবম–খ']]),
    subjectNames: new Map([[MATHS, 'গণিত'], [BANGLA, 'বাংলা']]),
    competentTeacherCount: new Map([[MATHS, 5], [BANGLA, 5]]),
    teachingDayCount: 5,
    ...over,
  };
}

describe("§8.2's three lines", () => {
  test('the weekly cap line, with its cause', () => {
    // 26 periods against a target of 24, and the reason is that there is
    // one qualified Maths teacher — which is a hiring case, not a
    // rebalancing one.
    const slots = Array.from({ length: 26 }, (_, i) => slot({
      subjectId: MATHS, dayOfWeek: i % 5, periodNo: Math.floor(i / 5) + 1,
    }));
    const r = evaluateSoftConstraints(input(slots, {
      competentTeacherCount: new Map([[MATHS, 1]]), teachingDayCount: 5,
    }));

    const v = r.violations.find((x) => x.code === 'teacher_weekly_cap');
    assert.ok(v, 'the cap violation is reported');
    assert.equal(v!.detailBn, 'রফিক ইসলাম — সাপ্তাহিক ২৬ পিরিয়ড (লক্ষ্য ২৪)');
    assert.equal(v!.causeBn, 'যোগ্য গণিত শিক্ষক কম (১ জন)');
    assert.equal(v!.overBy, 2);
  });

  test('the cause is withheld when the shortage is not real', () => {
    // Same overload, but five colleagues can teach it. Blaming a shortage
    // would send the coordinator to recruit when they should rebalance —
    // so no cause is claimed at all rather than a plausible-looking one.
    const slots = Array.from({ length: 26 }, (_, i) => slot({
      subjectId: MATHS, dayOfWeek: i % 5, periodNo: Math.floor(i / 5) + 1,
    }));
    const r = evaluateSoftConstraints(input(slots));
    const v = r.violations.find((x) => x.code === 'teacher_weekly_cap');
    assert.equal(v?.causeBn, undefined);
  });

  test('the consecutive-days line', () => {
    // Maths on Monday and Tuesday, two periods across a five-day week —
    // it could have been spread, and was not.
    const slots = [
      slot({ subjectId: MATHS, dayOfWeek: 1, periodNo: 2 }),
      slot({ subjectId: MATHS, dayOfWeek: 2, periodNo: 2 }),
    ];
    const r = evaluateSoftConstraints(input(slots));
    const v = r.violations.find((x) => x.code === 'subject_consecutive_days');
    assert.ok(v);
    assert.equal(v!.detailBn, 'নবম–খ গণিত সোম ও মঙ্গল পরপর');
  });

  test('the room-churn line', () => {
    // 204 → Lab 1 → 301 → 204 across one day is three changes.
    const slots = [
      slot({ teacherId: SHIRIN, dayOfWeek: 1, periodNo: 1, roomId: R204 }),
      slot({ teacherId: SHIRIN, dayOfWeek: 1, periodNo: 2, roomId: LAB1 }),
      slot({ teacherId: SHIRIN, dayOfWeek: 1, periodNo: 3, roomId: R301 }),
      slot({ teacherId: SHIRIN, dayOfWeek: 1, periodNo: 4, roomId: R204 }),
    ];
    const r = evaluateSoftConstraints(input(slots));
    const v = r.violations.find((x) => x.code === 'teacher_room_churn');
    assert.ok(v);
    assert.equal(v!.detailBn, 'শিরিন — সোমবার দিনে ৩ বার কক্ষ পরিবর্তন');
  });
});

describe('what must NOT be reported', () => {
  test('a subject that cannot avoid adjacent days is not flagged', () => {
    // Five days out of five must touch. Choosing D days out of W with no
    // two adjacent needs D ≤ ⌈W/2⌉, so anything above three days in a
    // five-day week is unavoidable — and reporting the unavoidable fills
    // the list with noise the coordinator can do nothing about.
    const slots = [0, 1, 2, 3, 4].map((d) =>
      slot({ subjectId: MATHS, dayOfWeek: d, periodNo: 2 }));
    const r = evaluateSoftConstraints(input(slots));
    assert.equal(r.violations.filter((v) => v.code === 'subject_consecutive_days').length, 0);
  });

  test('a teacher with no configured cap is not judged against a default', () => {
    const slots = Array.from({ length: 40 }, (_, i) => slot({
      teacherId: 'nobody', dayOfWeek: i % 5, periodNo: Math.floor(i / 5) + 1,
    }));
    const r = evaluateSoftConstraints(input(slots, { limits: new Map(), teachingDayCount: 5 }));
    assert.equal(r.violations.filter((v) => v.code.startsWith('teacher_')).length, 0);
  });

  test('staying in one room all day is not churn', () => {
    const slots = [1, 2, 3, 4, 5].map((p) =>
      slot({ teacherId: SHIRIN, dayOfWeek: 1, periodNo: p, roomId: R204 }));
    const r = evaluateSoftConstraints(input(slots));
    assert.equal(r.violations.filter((v) => v.code === 'teacher_room_churn').length, 0);
  });

  test('two changes in a day is under the threshold', () => {
    const slots = [
      slot({ teacherId: SHIRIN, dayOfWeek: 1, periodNo: 1, roomId: R204 }),
      slot({ teacherId: SHIRIN, dayOfWeek: 1, periodNo: 2, roomId: LAB1 }),
      slot({ teacherId: SHIRIN, dayOfWeek: 1, periodNo: 3, roomId: R301 }),
    ];
    const r = evaluateSoftConstraints(input(slots));
    assert.equal(r.violations.filter((v) => v.code === 'teacher_room_churn').length, 0);
  });

  test('a clean timetable reports nothing at all', () => {
    const slots = [
      slot({ subjectId: MATHS, dayOfWeek: 0, periodNo: 1 }),
      slot({ subjectId: MATHS, dayOfWeek: 2, periodNo: 1 }),
      slot({ subjectId: BANGLA, dayOfWeek: 1, periodNo: 1 }),
      slot({ subjectId: BANGLA, dayOfWeek: 3, periodNo: 1 }),
    ];
    assert.equal(evaluateSoftConstraints(input(slots)).violations.length, 0);
  });
});

describe('the other rules', () => {
  test('a daily cap is reported per day, naming the day', () => {
    const slots = Array.from({ length: 8 }, (_, i) =>
      slot({ dayOfWeek: 2, periodNo: i + 1 }));
    const r = evaluateSoftConstraints(input(slots));
    const v = r.violations.find((x) => x.code === 'teacher_daily_cap');
    assert.ok(v);
    assert.match(v!.detailBn, /মঙ্গলবার ৮ পিরিয়ড \(দৈনিক লক্ষ্য ৬\)/);
    assert.equal(v!.dayOfWeek, 2);
  });

  test('a full load with no day off is flagged', () => {
    // Six days at full load is the pattern that becomes sick leave.
    const slots = Array.from({ length: 24 }, (_, i) =>
      slot({ dayOfWeek: i % 6, periodNo: Math.floor(i / 6) + 1 }));
    const r = evaluateSoftConstraints(input(slots));
    const v = r.violations.find((x) => x.code === 'teacher_no_free_day');
    assert.ok(v);
    assert.match(v!.detailBn, /সপ্তাহে কোনো মুক্ত দিন নেই/);
  });

  test('a light load spread over six days is not flagged', () => {
    const slots = [0, 1, 2, 3, 4, 5].map((d) => slot({ dayOfWeek: d, periodNo: 1 }));
    const r = evaluateSoftConstraints(input(slots));
    assert.equal(r.violations.filter((v) => v.code === 'teacher_no_free_day').length, 0);
  });

  test('the same subject twice in one day is clustering', () => {
    const slots = [
      slot({ subjectId: MATHS, dayOfWeek: 1, periodNo: 1 }),
      slot({ subjectId: MATHS, dayOfWeek: 1, periodNo: 4 }),
    ];
    const r = evaluateSoftConstraints(input(slots));
    const v = r.violations.find((x) => x.code === 'subject_twice_in_one_day');
    assert.ok(v);
    assert.match(v!.detailBn, /সোমবার ২ পিরিয়ড একই দিনে/);
  });
});

describe('the honesty of a clean report', () => {
  test('rules that were NOT checked are named, with the reason', () => {
    // F-505 forbids silently accepting a violation. A rule that is never
    // run is a stronger version of the same problem: the screen says
    // "০ লঙ্ঘন" and means "০ of the rules I know about".
    const r = evaluateSoftConstraints(input([]));
    assert.equal(r.violations.length, 0);
    assert.equal(r.notEvaluated.length, 1);
    assert.match(r.notEvaluated[0].ruleBn, /কঠিন বিষয় দিনের শুরুতে/);
    assert.match(r.notEvaluated[0].whyBn, /সংরক্ষিত নেই/);
  });

  test('the worst violation sorts first', () => {
    const slots = [
      // 30 periods: six over the cap.
      ...Array.from({ length: 30 }, (_, i) =>
        slot({ subjectId: MATHS, dayOfWeek: i % 5, periodNo: Math.floor(i / 5) + 1 })),
      // and one adjacent-days pair, which is a much smaller matter.
      slot({ teacherId: SHIRIN, subjectId: BANGLA, dayOfWeek: 1, periodNo: 8 }),
      slot({ teacherId: SHIRIN, subjectId: BANGLA, dayOfWeek: 2, periodNo: 8 }),
    ];
    const r = evaluateSoftConstraints(input(slots));
    assert.equal(r.violations[0].code, 'teacher_weekly_cap');
  });
});
