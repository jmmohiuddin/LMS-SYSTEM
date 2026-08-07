/**
 * Attendance grid behaviour.
 *
 * The claim under test is the product claim: a 60-student section marked in
 * under 30 seconds. That translates to a tap budget, which is asserted here.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { AttendanceGrid, type Student } from '../src/attendance-grid.ts';

const section = (n = 60): Student[] =>
  Array.from({ length: n }, (_, i) => ({
    studentId: `stu_${i + 1}`,
    rollNo: i + 1,
    nameBn: `শিক্ষার্থী ${i + 1}`,
    nameEn: `Student ${i + 1}`,
  }));

describe('opening state', () => {
  test('everyone starts present — marking exceptions, not the whole register', () => {
    const g = new AttendanceGrid({ students: section() });
    const c = g.counts();
    assert.equal(c.total, 60);
    assert.equal(c.present, 60);
    assert.equal(c.absent, 0);
    assert.equal(c.untouched, 60, 'nothing touched yet');
    assert.equal(g.snapshot().dirty, false, 'an untouched grid is not dirty');
  });

  test('entries are ordered by roll number regardless of input order', () => {
    const shuffled = [...section(10)].reverse();
    const g = new AttendanceGrid({ students: shuffled });
    assert.deepEqual(g.entriesInOrder().map((e) => e.rollNo), [1,2,3,4,5,6,7,8,9,10]);
  });

  test('a queued draft is restored, and those students count as touched', () => {
    const g = new AttendanceGrid({
      students: section(5),
      initial: { stu_2: 'absent', stu_4: 'late' },
    });
    const c = g.counts();
    assert.equal(c.absent, 1);
    assert.equal(c.late, 1);
    assert.equal(c.present, 3);
    assert.equal(c.untouched, 3);
    assert.equal(g.snapshot().dirty, true, 'a restored draft has unsaved work');
  });
});

describe('tap-to-cycle', () => {
  test('present → absent → late → present', () => {
    const g = new AttendanceGrid({ students: section(1) });
    assert.equal(g.cycle('stu_1'), 'absent');
    assert.equal(g.cycle('stu_1'), 'late');
    assert.equal(g.cycle('stu_1'), 'present');
  });

  test('an unknown student id is a no-op, not a crash', () => {
    const g = new AttendanceGrid({ students: section(1) });
    assert.equal(g.cycle('nope'), undefined);
    assert.equal(g.counts().present, 1);
  });

  test('cycling away from late clears minutesLate', () => {
    const g = new AttendanceGrid({ students: section(1) });
    g.set('stu_1', 'late', 12);
    assert.equal(g.entriesInOrder()[0].minutesLate, 12);
    g.cycle('stu_1'); // late → present
    assert.equal(g.entriesInOrder()[0].minutesLate, undefined);
  });

  test('excused sits outside the cycle and rejoins at present', () => {
    const g = new AttendanceGrid({ students: section(1) });
    g.set('stu_1', 'excused');
    assert.equal(g.cycle('stu_1'), 'present');
  });

  test('counters stay correct across many taps', () => {
    const g = new AttendanceGrid({ students: section(10) });
    g.cycle('stu_1');                       // absent
    g.cycle('stu_2'); g.cycle('stu_2');     // late
    g.cycle('stu_3'); g.cycle('stu_3'); g.cycle('stu_3'); // back to present
    const c = g.counts();
    assert.deepEqual(
      { p: c.present, a: c.absent, l: c.late, t: c.total },
      { p: 8, a: 1, l: 1, t: 10 },
    );
  });
});

describe('the 30-second claim', () => {
  test('a 60-student section with 4 absences takes 4 taps', () => {
    let taps = 0;
    const g = new AttendanceGrid({ students: section(60) });
    for (const roll of [12, 27, 41, 58]) {
      g.cycle(`stu_${roll}`);
      taps++;
    }
    assert.equal(taps, 4, 'exceptions only — never 60 taps');
    const c = g.counts();
    assert.equal(c.absent, 4);
    assert.equal(c.present, 56);
  });

  test('one late student costs two taps, and that is the worst case per student', () => {
    const g = new AttendanceGrid({ students: section(60) });
    g.cycle('stu_7'); g.cycle('stu_7');
    assert.equal(g.counts().late, 1);
  });
});

describe('mark-all-present and undo', () => {
  test('mark-all resets every status and is undoable as one action', () => {
    const g = new AttendanceGrid({ students: section(5) });
    g.cycle('stu_1'); // absent
    g.cycle('stu_2'); g.cycle('stu_2'); // late
    assert.equal(g.counts().present, 3);

    g.markAllPresent();
    assert.equal(g.counts().present, 5);

    assert.equal(g.undo(), true);
    const c = g.counts();
    assert.equal(c.absent, 1, 'the whole mark-all is undone in one step');
    assert.equal(c.late, 1);
  });

  test('undo restores the previous status of a single tap', () => {
    const g = new AttendanceGrid({ students: section(3) });
    g.cycle('stu_2');
    assert.equal(g.entriesInOrder()[1].status, 'absent');
    g.undo();
    assert.equal(g.entriesInOrder()[1].status, 'present');
    assert.equal(g.entriesInOrder()[1].touched, false, 'touched state restored too');
  });

  test('undo is available only after an action, and only once', () => {
    const g = new AttendanceGrid({ students: section(2) });
    assert.equal(g.canUndo, false);
    assert.equal(g.undo(), false);
    g.cycle('stu_1');
    assert.equal(g.canUndo, true);
    assert.equal(g.undo(), true);
    assert.equal(g.canUndo, false, 'no undo stack — one level, matching the snackbar');
  });

  test('saving clears the undo window', () => {
    const g = new AttendanceGrid({ students: section(2) });
    g.cycle('stu_1');
    g.markSaved(1_760_000_000_000);
    assert.equal(g.canUndo, false);
    assert.equal(g.snapshot().dirty, false);
    assert.equal(g.lastSavedAt, 1_760_000_000_000);
  });
});

describe('payload for the offline outbox', () => {
  test('every student is included, even untouched ones', () => {
    const g = new AttendanceGrid({ students: section(60) });
    g.cycle('stu_20');
    const p = g.toPayload({
      sessionId: 'sess-1', sectionId: 'sec-1', academicYearId: 'yr-1', takenOn: '2026-08-06',
    });
    assert.equal(p.records.length, 60,
      'a partial register is worse than none — missing rows look like "not yet marked"');
    assert.equal(p.mode, 'section_daily');
    assert.equal(p.records.filter((r) => r.status === 'absent').length, 1);
  });

  test('records are in roll order and carry minutesLate only when late', () => {
    const g = new AttendanceGrid({ students: section(4) });
    g.set('stu_2', 'late', 9);
    g.set('stu_3', 'absent');
    const p = g.toPayload({
      sessionId: 's', sectionId: 'sec', academicYearId: 'y', takenOn: '2026-08-06', periodNo: 3,
      mode: 'period_wise',
    });
    assert.deepEqual(p.records.map((r) => r.studentId), ['stu_1','stu_2','stu_3','stu_4']);
    assert.equal((p.records[1] as { minutesLate?: number }).minutesLate, 9);
    assert.equal('minutesLate' in p.records[2], false, 'absent carries no minutesLate');
    assert.equal(p.periodNo, 3);
    assert.equal(p.mode, 'period_wise');
  });
});

describe('accessibility labels', () => {
  test('short, everyday Bangla — TalkBack Bangla TTS is poor', () => {
    const g = new AttendanceGrid({ students: section(3) });
    g.cycle('stu_2');
    assert.equal(g.ariaLabel('stu_2'), 'রোল 2, শিক্ষার্থী 2, অনুপস্থিত');
    assert.equal(g.ariaLabel('stu_2', 'en'), 'Roll 2, Student 2, absent');
  });

  test('an unknown id yields an empty label rather than throwing', () => {
    const g = new AttendanceGrid({ students: section(1) });
    assert.equal(g.ariaLabel('nope'), '');
  });
});

describe('change notification', () => {
  test('every mutation emits a snapshot for the renderer', () => {
    const seen: number[] = [];
    const g = new AttendanceGrid({
      students: section(5),
      onChange: (s) => seen.push(s.counts.absent),
    });
    g.cycle('stu_1');   // 1 absent
    g.cycle('stu_2');   // 2 absent
    g.undo();           // back to 1
    g.markAllPresent(); // 0
    assert.deepEqual(seen, [1, 2, 1, 0]);
  });
});
