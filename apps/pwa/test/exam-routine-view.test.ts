/**
 * The exam routine screen — F-510, wireframe §8.3.
 *
 * §8.3 is called "the screen that proves the subject-based model", and
 * what makes it that is not the table of papers — it is the panel naming
 * the children caught by a clash, and the fact that publication is shut
 * while they are. Those are what this suite holds still.
 *
 * The view never re-derives a clash; the server does that. So there is
 * nothing here asserting clash LOGIC — that lives in db/tests/exam_clash.sql
 * and services/rms-svc/test/examroutine.test.ts, against a real roster.
 * What is asserted here is that the screen tells the truth about what the
 * server said.
 */
import { test, describe, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

import { ExamRoutineView } from '../src/exam-routine-view.ts';

let dom: JSDOM;

before(() => {
  dom = new JSDOM('<!doctype html><html><body><main id="root"></main></body></html>',
                  { url: 'http://localhost/' });
  (globalThis as Record<string, unknown>).HTMLElement = dom.window.HTMLElement;
  for (const key of ['localStorage', 'location'] as const) {
    Object.defineProperty(globalThis, key, {
      value: dom.window[key], configurable: true, writable: true,
    });
  }
});

const EXAM = {
  id: 'e1', nameBn: 'বার্ষিক পরীক্ষা', examType: 'annual',
  startsOn: '2026-12-10', endsOn: '2026-12-20', status: 'planned',
};

const paper = (id: string, subjectBn: string, examDate: string, hasClash: boolean) => ({
  examSubjectId: id, sectionName: 'ক', subjectBn, examDate,
  startTime: '10:00', endTime: '13:00', durationMinutes: 180, hasClash,
});

/** Two papers clash on the 14th; Physics on the 15th is innocent. */
const withClash = {
  exam: EXAM,
  papers: [
    paper('p1', 'রসায়ন', '2026-12-14', true),
    paper('p2', 'উচ্চতর গণিত', '2026-12-14', true),
    paper('p3', 'পদার্থবিজ্ঞান', '2026-12-15', false),
  ],
  clashes: [{
    studentNameBn: 'আনিকা', rollNo: 7, sectionName: 'ক', examDate: '2026-12-14',
    subjectABn: 'রসায়ন', subjectBBn: 'উচ্চতর গণিত', startA: '10:00', startB: '10:00',
  }],
  affectedStudents: 1,
  canPublish: false,
};

const clean = {
  ...withClash,
  papers: withClash.papers.map((p) => ({ ...p, hasClash: false })),
  clashes: [],
  affectedStudents: 0,
  canPublish: true,
};

/** A stub Auth that answers the list request and then the routine request. */
function stubAuth(routine: unknown, sent: Array<Record<string, unknown>> = []) {
  return {
    authedFetch: async (url: string, init?: { body?: string }) => {
      if (init?.body) sent.push(JSON.parse(init.body) as Record<string, unknown>);
      const body = url.includes('examId=') || init ? routine : { exams: [EXAM] };
      return { ok: true, status: 200, json: async () => body } as unknown as Response;
    },
  } as unknown as ConstructorParameters<typeof ExamRoutineView>[0]['auth'];
}

async function mount(routine: unknown, sent?: Array<Record<string, unknown>>) {
  const root = dom.window.document.getElementById('root') as HTMLElement;
  root.textContent = '';
  new ExamRoutineView({ root, doc: dom.window.document, auth: stubAuth(routine, sent) });
  // Two awaited fetches before the final render.
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
  return root;
}

describe('exam routine view (§8.3)', () => {
  let root: HTMLElement;

  describe('with a clash standing', () => {
    beforeEach(async () => { root = await mount(withClash); });

    test('names the affected student rather than only counting', () => {
      const panel = root.querySelector('#clash-panel');
      assert.ok(panel, 'the clash panel is rendered');
      assert.match(panel!.textContent ?? '', /আনিকা/);
      assert.match(panel!.textContent ?? '', /রসায়ন \+ উচ্চতর গণিত/);
    });

    test('the headline counts students, in Bangla numerals', () => {
      const head = root.querySelector('.clash-head');
      assert.match(head?.textContent ?? '', /১ জন শিক্ষার্থীর/);
    });

    test('the roll number stays in Latin digits — it is an identifier', () => {
      assert.equal(root.querySelector('.clash-roll')?.textContent, '7');
    });

    test('both papers of the pair are flagged and the innocent one is not', () => {
      const flagged = root.querySelectorAll('tr.is-flagged');
      assert.equal(flagged.length, 2);
      const rows = [...root.querySelectorAll('tbody tr')];
      const physics = rows.find((r) => r.textContent?.includes('পদার্থবিজ্ঞান'));
      assert.ok(physics && !physics.classList.contains('is-flagged'));
    });

    test('every status carries a word, never colour or a glyph alone (F-812)', () => {
      const chips = [...root.querySelectorAll('.data-table .status-chip')];
      assert.equal(chips.length, 3);
      assert.ok(chips.every((c) => /সংঘর্ষ|ঠিক আছে/.test(c.textContent ?? '')));
    });

    test('publish is disabled and says why', () => {
      const pub = [...root.querySelectorAll('button')]
        .find((b) => b.textContent === 'প্রকাশ করুন') as HTMLButtonElement;
      assert.ok(pub, 'the publish button exists');
      assert.equal(pub.disabled, true);
      assert.match(pub.title, /সংঘর্ষ/);
    });

    test('each flagged paper offers the reschedule that closes the loop', () => {
      const buttons = [...root.querySelectorAll('button')]
        .filter((b) => b.textContent === 'সময় পরিবর্তন করুন');
      assert.equal(buttons.length, 2);
    });

    test('rescheduling posts the paper id, date and time the server expects', async () => {
      const sent: Array<Record<string, unknown>> = [];
      const r = await mount(withClash, sent);
      const open = [...r.querySelectorAll('button')]
        .find((b) => b.textContent === 'সময় পরিবর্তন করুন') as HTMLButtonElement;
      open.click();

      const date = r.querySelector('input[type=date]') as HTMLInputElement;
      const time = r.querySelector('input[type=time]') as HTMLInputElement;
      assert.equal(date.value, '2026-12-14', 'prefilled with the current slot');
      date.value = '2026-12-17';
      time.value = '09:30';

      const save = [...r.querySelectorAll('button')]
        .find((b) => b.textContent === 'সংরক্ষণ') as HTMLButtonElement;
      save.click();
      await new Promise((res) => setTimeout(res, 0));

      assert.equal(sent.length, 1);
      assert.deepEqual(sent[0].reschedule, {
        examSubjectId: 'p1', examDate: '2026-12-17', startTime: '09:30',
      });
    });
  });

  describe('with a clean routine', () => {
    beforeEach(async () => { root = await mount(clean); });

    test('no clash panel is rendered at all', () => {
      assert.equal(root.querySelector('#clash-panel'), null);
    });

    test('publish is enabled', () => {
      const pub = [...root.querySelectorAll('button')]
        .find((b) => b.textContent === 'প্রকাশ করুন') as HTMLButtonElement;
      assert.equal(pub.disabled, false);
    });

    test('a clean routine offers no reschedule rows to clutter it', () => {
      assert.equal(root.querySelectorAll('tr.row-action').length, 0);
    });
  });

  describe('once published', () => {
    test('the routine cannot be rescheduled or published again from here', async () => {
      root = await mount({ ...clean, exam: { ...EXAM, status: 'published' } });
      const labels = [...root.querySelectorAll('button')].map((b) => b.textContent);
      assert.ok(!labels.includes('প্রকাশ করুন'));
      assert.ok(!labels.includes('সময় পরিবর্তন করুন'));
      // And the state is stated, not merely implied by what is missing.
      assert.match(root.querySelector('.action-row .status-chip')?.textContent ?? '', /প্রকাশিত/);
    });
  });
});
