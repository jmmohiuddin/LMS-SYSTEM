/**
 * R-3 — the principal and IT admin screens.
 *
 * D13 makes loading, empty, error and success part of "done", so those four
 * moments are tested here as behaviour rather than trusted as polish. The
 * empty state gets the most attention because it is what a school sees on its
 * FIRST day, when every table is legitimately empty and nothing has failed.
 *
 * Beyond the states, the behaviours worth holding are the ones a school would
 * be harmed by losing:
 *
 *   - "nobody has taken attendance yet" is not rendered as 0%
 *   - a capped list never reads as a complete list
 *   - replacing a teacher demands a reason and says the record is kept
 *   - every irreversible action states its consequence with numbers first
 *   - the SMS cost warning is in segments, and comes from the server's limits
 *   - a fee block absent from the response is absent from the screen
 */
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

import { PrincipalView, type PrincipalDashboard } from '../src/principal-view.ts';
import { AcademicView } from '../src/academic-view.ts';
import { PublishView } from '../src/publish-view.ts';
import { InvoiceView } from '../src/invoice-view.ts';
import { AdminSettingsView } from '../src/admin-settings-view.ts';
import { RolloverView } from '../src/rollover-view.ts';
import { UsersView } from '../src/users-view.ts';
import { bnNum, skeleton, emptyState, errorState } from '../src/view-states.ts';

let dom: JSDOM;

beforeEach(() => {
  dom = new JSDOM('<!doctype html><html><body><main id="root"></main></body></html>',
    { url: 'https://school.example/app' });
  const g = globalThis as Record<string, unknown>;
  g.HTMLElement = dom.window.HTMLElement;
  g.HTMLInputElement = dom.window.HTMLInputElement;
  g.HTMLSelectElement = dom.window.HTMLSelectElement;
  g.HTMLButtonElement = dom.window.HTMLButtonElement;
  g.HTMLFormElement = dom.window.HTMLFormElement;
  g.KeyboardEvent = dom.window.KeyboardEvent;
  g.Event = dom.window.Event;
  g.location = dom.window.location;
  g.localStorage = dom.window.localStorage;
});

const doc = () => dom.window.document;
const root = () => doc().getElementById('root')!;
const text = () => root().textContent ?? '';
const settle = () => new Promise((r) => setTimeout(r, 0));

/** Click the nth row currently on screen. */
const clickRow = (i = 0) =>
  ([...root().querySelectorAll('.system-row')][i] as HTMLElement)
    .dispatchEvent(new dom.window.Event('click'));

/**
 * Drill tree → level → section. Two clicks, because the hierarchy really is
 * two levels deep before a section: শ্রেণি ৯, then বিজ্ঞান's sections.
 */
async function openSectionF(): Promise<void> {
  clickRow(0);            // Class 9
  await settle();
  clickRow(0);            // Section F
  await settle();
}

/** Click a button by its exact label. */
const clickLabel = (label: string) =>
  ([...root().querySelectorAll('button')].find((b) => b.textContent === label) as HTMLElement)
    .dispatchEvent(new dom.window.Event('click'));

/** An Auth stand-in. `status` lets a test drive the 403 and offline paths. */
function fakeAuth(
  routes: Record<string, unknown>,
  opts: { role?: string; status?: number; throws?: boolean } = {},
) {
  const calls: { path: string; init?: RequestInit }[] = [];
  return {
    calls,
    role: opts.role ?? 'principal',
    tenantId: 't1',
    userId: 'u1',
    displayName: 'প্রধান শিক্ষক',
    isLoggedIn: () => true,
    authedFetch: async (path: string, init?: RequestInit) => {
      calls.push({ path, init });
      if (opts.throws) throw new Error('offline');
      // Longest prefix wins. `/hierarchy?studentId=…` also starts with
      // `/hierarchy`, and insertion order silently handed it the tree — which
      // looked like a view bug for a while and was a stub bug.
      const key = Object.keys(routes)
        .filter((k) => path.startsWith(k))
        .sort((a, b) => b.length - a.length)[0];
      const body = key ? routes[key] : {};
      return new Response(JSON.stringify(body), {
        status: opts.status ?? 200, headers: { 'Content-Type': 'application/json' },
      });
    },
  };
}

const dashboard = (over: Partial<PrincipalDashboard> = {}): PrincipalDashboard => ({
  year: { id: 'y1', label: '২০২৬' },
  needsSetup: false,
  counts: { students: 1240, teachers: 48, sections: 26, classes: 6 },
  attendanceToday: { present: 1102, marked: 1180, percent: 93, sessionsTaken: 22, sectionsExpected: 26 },
  absentToday: { total: 78, shown: [
    { studentId: 's1', nameBn: 'করিম', rollNo: 4, section: 'F', classBn: 'নবম' },
  ] },
  upcomingExams: [],
  recentNotices: [],
  pending: {
    sectionsWithoutClassTeacher: 2, subjectsWithoutTeacher: 3,
    examsAwaitingPublication: 1, studentsWithoutSection: 0,
  },
  finance: null,
  ...over,
});

// ── The four states D13 requires ───────────────────────────────────────

describe('the four states', () => {
  test('loading is a skeleton, not a spinner, and is announced as busy', () => {
    const el = skeleton(doc(), 3);
    assert.equal(el.getAttribute('aria-busy'), 'true');
    assert.ok(el.querySelector('.skel-title'), 'a skeleton shows the shape of what is coming');
    assert.equal(el.querySelectorAll('.skel-bar').length, 3);
  });

  test('an empty state offers a way out, not just a full stop', () => {
    let clicked = false;
    const el = emptyState(doc(), {
      message: 'এখনো কিছু নেই।',
      action: { label: 'যোগ করুন', onClick: () => { clicked = true; } },
    });
    const btn = el.querySelector('button')!;
    btn.dispatchEvent(new dom.window.Event('click'));
    assert.ok(clicked, 'the empty state is where a person is told what to do next');
  });

  test('an error is announced and offers a retry', () => {
    let retried = false;
    const el = errorState(doc(), 'আনা যায়নি।', () => { retried = true; });
    assert.equal(el.querySelector('[role="alert"]')?.textContent, 'আনা যায়নি।');
    el.querySelector('button')!.dispatchEvent(new dom.window.Event('click'));
    assert.ok(retried);
  });

  test('a 403 offers no retry, because retrying cannot help', async () => {
    new PrincipalView({
      root: root(), doc: doc(),
      auth: fakeAuth({}, { status: 403 }) as never,
      onNavigate: () => {},
    });
    await settle();
    assert.match(text(), /অনুমতি/);
    assert.equal(root().querySelectorAll('button').length, 0,
      'a permission error with a retry button teaches the user to keep pressing it');
  });

  test('losing the network says so, and offers a retry', async () => {
    new PrincipalView({
      root: root(), doc: doc(),
      auth: fakeAuth({}, { throws: true }) as never,
      onNavigate: () => {},
    });
    await settle();
    assert.match(text(), /সংযোগ/);
    assert.ok(root().querySelector('button'), 'a network error is exactly the retryable kind');
  });
});

// ── Part A: the principal dashboard ────────────────────────────────────

describe('principal dashboard', () => {
  test('THE ONE THAT MATTERS — no attendance yet is not 0%', async () => {
    new PrincipalView({
      root: root(), doc: doc(),
      auth: fakeAuth({ '/api/v1/ops/dashboard': dashboard({
        attendanceToday: { present: 0, marked: 0, percent: null, sessionsTaken: 0, sectionsExpected: 26 },
      }) }) as never,
      onNavigate: () => {},
    });
    await settle();
    // 0% at 8:05am sends a head teacher after a class teacher who has done
    // nothing wrong.
    assert.doesNotMatch(text(), /০%/);
    assert.match(text(), /হাজিরা নেওয়া হয়নি/);
  });

  test('a truncated absent list says how many more there are', async () => {
    new PrincipalView({
      root: root(), doc: doc(),
      auth: fakeAuth({ '/api/v1/ops/dashboard': dashboard() }) as never,
      onNavigate: () => {},
    });
    await settle();
    // 78 absent, 1 shown — the screen must not imply the list is the list.
    assert.match(text(), new RegExp(`আরও ${bnNum(77)}`));
  });

  test('the fee block is absent when the server withheld it', async () => {
    new PrincipalView({
      root: root(), doc: doc(),
      auth: fakeAuth({ '/api/v1/ops/dashboard': dashboard({ finance: null }) }) as never,
      onNavigate: () => {},
    });
    await settle();
    assert.doesNotMatch(text(), /বকেয়া/);
  });

  test('and present when it was sent', async () => {
    new PrincipalView({
      root: root(), doc: doc(),
      auth: fakeAuth({ '/api/v1/ops/dashboard': dashboard({
        finance: { invoiced: '1000.00', collected: '600.00', outstanding: '400.00', unpaidCount: 3 },
      }) }) as never,
      onNavigate: () => {},
    });
    await settle();
    assert.match(text(), /বকেয়া/);
  });

  test('day one — no academic year is guidance, not a wall of zeroes', async () => {
    new PrincipalView({
      root: root(), doc: doc(),
      auth: fakeAuth({ '/api/v1/ops/dashboard': { year: null, needsSetup: true } }) as never,
      onNavigate: () => {},
    });
    await settle();
    assert.match(text(), /শিক্ষাবর্ষ তৈরি হয়নি/);
    assert.doesNotMatch(text(), /শিক্ষার্থী\s*০/);
  });

  test('pending items are only listed when there are any', async () => {
    new PrincipalView({
      root: root(), doc: doc(),
      auth: fakeAuth({ '/api/v1/ops/dashboard': dashboard({
        pending: { sectionsWithoutClassTeacher: 0, subjectsWithoutTeacher: 0,
                   examsAwaitingPublication: 0, studentsWithoutSection: 0 },
      }) }) as never,
      onNavigate: () => {},
    });
    await settle();
    assert.match(text(), /কিছু বাকি নেই/);
  });
});

// ── Parts C, D, L: the hierarchy and assignment ────────────────────────

const tree = {
  years: [{ id: 'y1', label: '২০২৬', isCurrent: true }],
  year: { id: 'y1', label: '২০২৬' },
  classes: [{
    levelNo: 9, nameBn: 'নবম শ্রেণি', nameEn: 'Nine',
    sectionCount: 2, studentCount: 78,
    groups: [{
      classId: 'c1', group: 'science', groupBn: 'বিজ্ঞান',
      sectionCount: 2, studentCount: 78,
      sections: [
        { id: 'secF', name: 'F', shift: 'morning', capacity: 60, studentCount: 40,
          classTeacher: { id: 't1', nameBn: 'রহিম স্যার' }, subjectTeacherCount: 5 },
        { id: 'secE', name: 'E', shift: 'morning', capacity: 60, studentCount: 38,
          classTeacher: null, subjectTeacherCount: 4 },
      ],
    }],
  }],
};

const sectionDetail = {
  section: { id: 'secF', name: 'F', shift: 'morning', capacity: 60, studentCount: 40,
             classId: 'c1', levelNo: 9, classNameBn: 'নবম শ্রেণি', groupBn: 'বিজ্ঞান',
             yearId: 'y1', yearLabel: '২০২৬' },
  classTeacher: { id: 't1', nameBn: 'রহিম স্যার', since: '2026-01-05' },
  subjectTeachers: [{
    assignmentId: 'a1', subject: { id: 'sub1', nameBn: 'পদার্থবিজ্ঞান', nameEn: 'Physics' },
    teacher: { id: 't2', nameBn: 'করিম স্যার' }, startedOn: '2026-01-05',
  }],
  unassignedSubjects: [{ id: 'sub2', nameBn: 'রসায়ন' }],
  roster: [
    { studentId: 's1', rollNo: 1, nameBn: 'শিক্ষার্থী ১', studentCode: 'X1', status: 'active' },
    { studentId: 's2', rollNo: 2, nameBn: 'শিক্ষার্থী ২', studentCode: 'X2', status: 'active' },
  ],
  history: [{ kind: 'subject_teacher', subjectBn: 'পদার্থবিজ্ঞান', teacherBn: 'জামাল স্যার',
              startedOn: '2026-01-05', endedOn: '2026-03-15', endReason: 'বদলি হয়েছেন' }],
};

describe('academic hierarchy', () => {
  const routes = {
    '/api/v1/academics/hierarchy?sectionId': sectionDetail,
    '/api/v1/academics/hierarchy': tree,
    '/api/v1/ops/assign': {
      subjects: [{ id: 'sub1', nameBn: 'পদার্থবিজ্ঞান', assigned: { id: 't2', nameBn: 'করিম স্যার' } }],
      teachers: [
        { id: 't2', nameBn: 'করিম স্যার', employeeCode: 'T2', currentLoad: 3, expertiseSubjectIds: ['sub1'] },
        { id: 't3', nameBn: 'হাসান স্যার', employeeCode: 'T3', currentLoad: 1, expertiseSubjectIds: [] },
      ],
    },
  };

  test('the tree shows counts at every level', async () => {
    new AcademicView({ root: root(), doc: doc(), auth: fakeAuth(routes) as never, canManage: true });
    await settle();
    assert.match(text(), /নবম শ্রেণি/);
    assert.match(text(), /বিজ্ঞান/);
    assert.match(text(), new RegExp(`${bnNum(78)} জন`));
  });

  test('a section with no class teacher is marked, not left to be read', async () => {
    new AcademicView({ root: root(), doc: doc(), auth: fakeAuth(routes) as never, canManage: true });
    await settle();
    clickRow(0);   // into Class 9, where section E has no class teacher
    await settle();
    assert.match(text(), /শিক্ষক নেই/);
  });

  test('an empty class says so instead of rendering nothing', async () => {
    const emptyTree = {
      ...tree,
      classes: [{ ...tree.classes[0], groups: [{ ...tree.classes[0].groups[0], sections: [] }] }],
    };
    new AcademicView({
      root: root(), doc: doc(),
      auth: fakeAuth({ '/api/v1/academics/hierarchy': emptyTree }) as never, canManage: true,
    });
    await settle();
    clickRow(0);
    await settle();
    assert.match(text(), /কোনো সেকশন তৈরি হয়নি/);
  });

  test('a subject nobody teaches is shown as empty, not omitted', async () => {
    new AcademicView({ root: root(), doc: doc(), auth: fakeAuth(routes) as never, canManage: true });
    await settle();
    await openSectionF();
    // The most useful thing this screen tells a principal in January.
    assert.match(text(), /রসায়ন/);
    assert.match(text(), /খালি/);
  });

  test('the replacement record is visible on the section', async () => {
    new AcademicView({ root: root(), doc: doc(), auth: fakeAuth(routes) as never, canManage: true });
    await settle();
    await openSectionF();
    assert.match(text(), /জামাল স্যার/, 'the replaced teacher stays on the record');
    assert.match(text(), /বদলি হয়েছেন/, 'and so does the reason');
  });

  test('a teacher sees no management controls', async () => {
    new AcademicView({ root: root(), doc: doc(), auth: fakeAuth(routes) as never, canManage: false });
    await settle();
    await openSectionF();
    assert.doesNotMatch(text(), /শিক্ষক বদল করুন/);
    assert.doesNotMatch(text(), /একসাথে স্থানান্তর/);
  });

  test('THE ONE THAT MATTERS — replacement states that the old record is kept', async () => {
    new AcademicView({ root: root(), doc: doc(), auth: fakeAuth(routes) as never, canManage: true });
    await settle();
    await openSectionF();
    clickLabel('শিক্ষক বদল করুন');
    await settle();
    assert.match(text(), /রেকর্ড মুছে যাবে না/,
      'a school that thinks replacing erases the old teacher stops recording replacements');
    assert.match(text(), /পরিবর্তনের কারণ/, 'a history of changes with no reasons is a list of dates');
  });

  test('the student drawer shows the year-by-year history and no guardian phone', async () => {
    const withStudent = {
      ...routes,
      '/api/v1/academics/hierarchy?studentId': {
        student: { id: 's1', nameBn: 'শিক্ষার্থী ১', nameEn: null, studentCode: 'X1',
                   admissionDate: '2024-01-05', lifecycleStatus: 'enrolled',
                   bloodGroup: 'B+', status: 'active' },
        current: { yearLabel: '২০২৬', levelNo: 9, classBn: 'নবম', groupBn: 'বিজ্ঞান',
                   section: 'F', rollNo: 1, status: 'active' },
        history: [
          { yearLabel: '২০২৬', levelNo: 9, classBn: 'নবম', groupBn: 'বিজ্ঞান', section: 'F',
            rollNo: 1, status: 'active', enrolledOn: '2026-01-05', endedOn: null },
          { yearLabel: '২০২৫', levelNo: 8, classBn: 'অষ্টম', groupBn: 'সাধারণ', section: 'খ',
            rollNo: 12, status: 'promoted', enrolledOn: '2025-01-05', endedOn: '2025-12-20' },
        ],
        guardians: [{ nameBn: 'আব্দুল করিম', relation: 'father', isPrimary: true, canPayFees: true }],
        attendance90d: { present: 74, total: 80 },
      },
    };
    new AcademicView({ root: root(), doc: doc(), auth: fakeAuth(withStudent) as never, canManage: true });
    await settle();
    await openSectionF();
    [...root().querySelectorAll('.roster-name')][0].dispatchEvent(new dom.window.Event('click'));
    await settle();
    assert.match(text(), /২০২৫/, 'the ten-year history is the point of never overwriting enrolments');
    assert.match(text(), /আব্দুল করিম/);
    assert.doesNotMatch(text(), /\+8801|01[3-9]\d{8}/,
      'a phone number here is a phone number on every teacher’s device');
  });
});

// ── Part H: result publishing ──────────────────────────────────────────

describe('result publishing', () => {
  const exams = {
    exams: [{
      examId: 'e1', examNameBn: 'অর্ধবার্ষিক', status: 'marking',
      startsOn: '2026-06-10', endsOn: '2026-06-20',
      subjects: [
        { examSubjectId: 'es1', subjectBn: 'পদার্থ', sectionName: 'F', enrolled: 40, marked: 40 },
        { examSubjectId: 'es2', subjectBn: 'রসায়ন', sectionName: 'F', enrolled: 40, marked: 31 },
      ],
    }],
  };

  test('incompleteness is shown before the button, not after it', async () => {
    new PublishView({ root: root(), doc: doc(), auth: fakeAuth({ '/api/v1/academics/publish': exams }) as never });
    await settle();
    assert.match(text(), /নম্বর বাকি/);
  });

  test('the confirmation names what is missing, with numbers', async () => {
    new PublishView({ root: root(), doc: doc(), auth: fakeAuth({ '/api/v1/academics/publish': exams }) as never });
    await settle();
    clickLabel('ফলাফল প্রকাশ করুন');
    assert.match(text(), /অপরিবর্তনীয়|সম্পাদনা করা যাবে না/);
    assert.match(text(), new RegExp(`${bnNum(1)} টি বিষয়ে`));
  });

  test('the confirmation defaults focus to cancel', async () => {
    new PublishView({ root: root(), doc: doc(), auth: fakeAuth({ '/api/v1/academics/publish': exams }) as never });
    await settle();
    clickLabel('ফলাফল প্রকাশ করুন');
    await settle();
    assert.equal(doc().activeElement?.textContent, 'বাতিল',
      'the first thing reached on an irreversible dialogue is the way out');
  });

  test('no exams is guidance, not a blank screen', async () => {
    new PublishView({ root: root(), doc: doc(), auth: fakeAuth({ '/api/v1/academics/publish': { exams: [] } }) as never });
    await settle();
    assert.match(text(), /কোনো পরীক্ষা তৈরি হয়নি/);
  });
});

// ── Part I: invoice generation ─────────────────────────────────────────

describe('invoice generation', () => {
  test('idempotency is promised before the button, not discovered after', async () => {
    new InvoiceView({ root: root(), doc: doc(), auth: fakeAuth({ '/api/v1/finance/invoices': { invoices: [] } }) as never, canGenerate: true });
    await settle();
    assert.match(text(), /দুইবার চালালে/,
      'without this sentence the second press is the scariest thing in the product');
  });

  test('zero new invoices is explained, not reported as a failure', async () => {
    const auth = fakeAuth({
      '/api/v1/finance/invoices': { invoices: [] },
      '/api/v1/finance/generate': { invoiceCount: 0 },
    });
    new InvoiceView({ root: root(), doc: doc(), auth: auth as never, canGenerate: true });
    await settle();
    clickLabel('ইনভয়েস তৈরি করুন');
    await settle();
    clickLabel('তৈরি করুন');
    // generate() awaits the POST and then a reload; both need to land.
    await settle(); await settle(); await settle();
    assert.match(text(), /সবার ইনভয়েস আগেই তৈরি হয়েছে/);
  });
});

// ── Part J: the SMS setting that produced D13 ──────────────────────────

describe('invoice generation — permission', () => {
  test('a caller who may not generate is offered no form', async () => {
    // Found in the browser: the invoice LIST is legitimately readable by a
    // guardian for their own child, so the screen loaded and drew a billing
    // form that would have 403'd on submit.
    new InvoiceView({
      root: root(), doc: doc(),
      auth: fakeAuth({ '/api/v1/finance/invoices': { invoices: [] } }) as never,
      canGenerate: false,
    });
    await settle();
    assert.equal(root().querySelectorAll('input[type=month]').length, 0);
    assert.match(text(), /অনুমতি কেবল/);
  });
});

describe('SMS notice settings', () => {
  const settings = { sms: { noticeMaxChars: 180, default: 180, min: 70, max: 480, charsPerSegment: 70 } };

  test('the limits come from the server, not from a constant in the browser', async () => {
    new AdminSettingsView({ root: root(), doc: doc(), auth: fakeAuth({ '/api/v1/ops/settings': settings }) as never, canManage: true });
    await settle();
    const input = root().querySelector('input[type=number]') as HTMLInputElement;
    assert.equal(input.min, '70');
    assert.equal(input.max, '480');
    assert.equal(input.value, '180');
  });

  test('cost is shown in segments, because that is the unit the bill arrives in', async () => {
    new AdminSettingsView({ root: root(), doc: doc(), auth: fakeAuth({ '/api/v1/ops/settings': settings }) as never, canManage: true });
    await settle();
    assert.match(text(), new RegExp(`${bnNum(3)} টি এসএমএস`), '180 chars ÷ 70 = 3 Bangla segments');
  });

  test('going over the recommendation warns in multiples of the bill', async () => {
    new AdminSettingsView({ root: root(), doc: doc(), auth: fakeAuth({ '/api/v1/ops/settings': settings }) as never, canManage: true });
    await settle();
    const input = root().querySelector('input[type=number]') as HTMLInputElement;
    input.value = '420';
    input.dispatchEvent(new dom.window.Event('input'));
    const warn = root().querySelector('.inline-notice') as HTMLElement;
    assert.equal(warn.hidden, false);
    assert.match(warn.textContent ?? '', /গুণ/);
  });

  test('an out-of-range value cannot be saved', async () => {
    new AdminSettingsView({ root: root(), doc: doc(), auth: fakeAuth({ '/api/v1/ops/settings': settings }) as never, canManage: true });
    await settle();
    const input = root().querySelector('input[type=number]') as HTMLInputElement;
    input.value = '9000';
    input.dispatchEvent(new dom.window.Event('input'));
    const save = [...root().querySelectorAll('button')].find((b) => b.textContent?.includes('সংরক্ষণ'))!;
    assert.equal((save as HTMLButtonElement).disabled, true);
  });

  test('the policy is stated: SMS is an alert, the app holds the notice', async () => {
    new AdminSettingsView({ root: root(), doc: doc(), auth: fakeAuth({ '/api/v1/ops/settings': settings }) as never, canManage: true });
    await settle();
    assert.match(text(), /পুরো নোটিশ সবসময় অ্যাপে থাকবে/);
    assert.match(text(), /প্রতিষ্ঠানের নাম/);
  });

  test('a caller who may not change it gets a disabled form and a reason', async () => {
    new AdminSettingsView({ root: root(), doc: doc(), auth: fakeAuth({ '/api/v1/ops/settings': settings }) as never, canManage: false });
    await settle();
    assert.equal((root().querySelector('input[type=number]') as HTMLInputElement).disabled, true);
    assert.match(text(), /অনুমতি কেবল/);
  });
});

// ── Part G: rollover ───────────────────────────────────────────────────

describe('yearly rollover', () => {
  const preview = {
    years: [{ id: 'y2', label: '২০২৭', isCurrent: false }, { id: 'y1', label: '২০২৬', isCurrent: true }],
    needsTargetYear: false,
    fromYear: { id: 'y1', label: '২০২৬' }, toYear: { id: 'y2', label: '২০২৭' },
    summary: { considered: 180, promote: 168, repeat: 5, graduate: 4, blocked: 3 },
    students: [
      { studentId: 's1', nameBn: 'ক', fromLevel: 9, fromSection: 'F', fromRoll: 1,
        action: 'promote', toLevel: 10, toSection: 'ক', toRoll: 1, blockerBn: null },
      { studentId: 's2', nameBn: 'খ', fromLevel: 9, fromSection: 'F', fromRoll: 2,
        action: 'blocked', toLevel: null, toSection: null, toRoll: null,
        blockerBn: 'দশম শ্রেণিতে সেকশন নেই' },
    ],
    existing: null,
  };

  test('blocked students are named above the button, with the reason', async () => {
    new RolloverView({ root: root(), doc: doc(), auth: fakeAuth({ '/api/v1/ops/rollover': preview }) as never, canCommit: true });
    await settle();
    assert.match(text(), /দশম শ্রেণিতে সেকশন নেই/);
    assert.match(text(), /কাউকে বাদ দিয়ে করা হয় না/);
  });

  test('one year only is guidance, not an empty preview', async () => {
    new RolloverView({
      root: root(), doc: doc(),
      auth: fakeAuth({ '/api/v1/ops/rollover': {
        years: [{ id: 'y1', label: '২০২৬', isCurrent: true }],
        needsTargetYear: true, summary: null, students: [], existing: null,
      } }) as never,
      canCommit: true,
    });
    await settle();
    assert.match(text(), /দুইটি শিক্ষাবর্ষ দরকার/);
  });

  test('a caller who may not commit is told, and offered nothing', async () => {
    new RolloverView({ root: root(), doc: doc(), auth: fakeAuth({ '/api/v1/ops/rollover': preview }) as never, canCommit: false });
    await settle();
    assert.match(text(), /অনুমতি কেবল/);
    assert.equal([...root().querySelectorAll('button')]
      .filter((b) => b.textContent?.includes('সম্পন্ন করুন')).length, 0);
  });

  test('the commit button appears only after a plan is saved, and stays blocked', async () => {
    const planned = { ...preview, existing: {
      id: 'r1', status: 'planned',
      planned: { considered: 180, promote: 168, repeat: 5, graduate: 4, blocked: 3 },
      actual: null,
    } };
    new RolloverView({ root: root(), doc: doc(), auth: fakeAuth({ '/api/v1/ops/rollover': planned }) as never, canCommit: true });
    await settle();
    const commit = [...root().querySelectorAll('button')]
      .find((b) => b.textContent?.includes('উন্নয়ন সম্পন্ন করুন')) as HTMLButtonElement;
    assert.ok(commit, 'the plan step gates the commit button');
    assert.equal(commit.disabled, true, '3 blocked students must stop it');
  });

  test('the named list is available, because a count is not something to trust', async () => {
    new RolloverView({ root: root(), doc: doc(), auth: fakeAuth({ '/api/v1/ops/rollover': preview }) as never, canCommit: true });
    await settle();
    [...root().querySelectorAll('button')]
      .find((b) => b.textContent?.includes('তালিকা দেখুন'))!
      .dispatchEvent(new dom.window.Event('click'));
    assert.ok(root().querySelector('.data-table'));
    assert.match(text(), /উন্নীত/);
  });
});

// ── Part B: users ──────────────────────────────────────────────────────

describe('user management', () => {
  const users = {
    users: [
      { id: 'u1', nameBn: 'রহিম স্যার', nameEn: null, phone: '+8801700000001',
        status: 'active', roles: ['class_teacher'], employeeCode: 'T1', studentCode: null },
    ],
    truncated: true, limit: 50,
  };

  test('there is no delete, and deactivation says the record is kept', async () => {
    new UsersView({ root: root(), doc: doc(), auth: fakeAuth({ '/api/v1/ops/users': users }) as never, canManage: true });
    await settle();
    assert.doesNotMatch(text(), /মুছে ফেলুন/);
    [...root().querySelectorAll('button')]
      .find((b) => b.textContent === 'নিষ্ক্রিয় করুন')!
      .dispatchEvent(new dom.window.Event('click'));
    assert.match(text(), /রেকর্ড মুছে যাবে না/);
  });

  test('a capped list never reads as a complete one', async () => {
    new UsersView({ root: root(), doc: doc(), auth: fakeAuth({ '/api/v1/ops/users': users }) as never, canManage: true });
    await settle();
    assert.match(text(), /প্রথম ৫০ জন/);
  });

  test('creating an account never offers a password', async () => {
    new UsersView({ root: root(), doc: doc(), auth: fakeAuth({ '/api/v1/ops/users': users }) as never, canManage: true });
    await settle();
    [...root().querySelectorAll('button')]
      .find((b) => b.textContent?.includes('নতুন শিক্ষক'))!
      .dispatchEvent(new dom.window.Event('click'));
    assert.equal(root().querySelectorAll('input[type=password]').length, 0);
    assert.match(text(), /অ্যাক্টিভেশন কোড/);
  });

  test('a read-only caller is offered no controls', async () => {
    new UsersView({ root: root(), doc: doc(), auth: fakeAuth({ '/api/v1/ops/users': users }) as never, canManage: false });
    await settle();
    assert.equal([...root().querySelectorAll('button')]
      .filter((b) => b.textContent === 'নিষ্ক্রিয় করুন').length, 0);
  });

  test('an empty search explains the exact-phone rule rather than looking broken', async () => {
    const v = new UsersView({
      root: root(), doc: doc(),
      auth: fakeAuth({ '/api/v1/ops/users': { users: [], truncated: false } }) as never,
      canManage: true,
    });
    (v as unknown as { term: string }).term = '017';
    await settle();
    (v as unknown as { render: () => void }).render();
    assert.match(text(), /মোবাইল নম্বর পুরোটা/);
  });
});
