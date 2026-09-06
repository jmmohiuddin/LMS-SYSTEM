/**
 * P9-3 — the generate screen, as a coordinator meets it.
 *
 * The API suite pins what the server does. These are the five things about
 * the SCREEN that decide whether a school can act on it:
 *
 *   1. The verdict is the server's sentence. A browser that composed its own
 *      from the counters would disagree with the numbers beside it the first
 *      time either changed, and being believed is this screen's whole value.
 *
 *   2. No invented progress. `POST /rms/generate` is one blocking request
 *      with no stream and no job id, so the wait shows a spinner, a true
 *      elapsed second count, and a sentence saying why there is no
 *      percentage. A bar creeping to 90% and stopping teaches people to
 *      distrust the wait, and then the result.
 *
 *   3. A hard conflict outranks "all periods placed". The teacher and room
 *      EXCLUDE constraints only bind an ACTIVE routine, so a draft can hold
 *      a clash that publish will refuse. Leading with the cheerful number
 *      would send someone to publish a routine that cannot be published.
 *
 *   4. Unplaced demand reads as a to-do list — class, subject, shortfall,
 *      and the reason in a sentence, because the four reasons are four
 *      different errands.
 *
 *   5. "Generation failed." never appears alone. Each refusal says what it
 *      was and what to do next.
 */
import { test, describe, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

import { RoutineGenerateView } from '../src/routine-generate-view.ts';

let dom: JSDOM;

before(() => {
  dom = new JSDOM('<!doctype html><html><body><main id="root"></main></body></html>',
                  { url: 'http://localhost/' });
  const g = globalThis as Record<string, unknown>;
  g.HTMLElement = dom.window.HTMLElement;
  g.CSS = dom.window.CSS;
  for (const key of ['localStorage', 'location'] as const) {
    Object.defineProperty(globalThis, key, {
      value: dom.window[key], configurable: true, writable: true,
    });
  }
});

const doc = () => dom.window.document;
const root = () => doc().getElementById('root') as HTMLElement;
const settle = async () => {
  for (let i = 0; i < 14; i++) await new Promise((r) => setTimeout(r, 0));
};
const YEAR = 'aaaaaaaa-0000-4000-8000-00000000000a';
const ROUTINE_M = 'bbbbbbbb-0000-4000-8000-00000000000b';

const READY = {
  steps: [
    { id: 'periods', titleBn: 'পিরিয়ড ও বিরতি', state: 'ok',
      detailBn: 'প্রতিদিন ৭টি ক্লাস পিরিয়ড', done: 7, total: 7 },
    { id: 'availability', titleBn: 'শিক্ষকের সময়-সীমা', state: 'warn',
      detailBn: 'কারও সময়-সীমা দেওয়া হয়নি', done: 0, total: 20 },
  ],
  canGenerate: true,
};
const BLOCKED = {
  steps: [
    { id: 'assignments', titleBn: 'কে কোন বিষয় পড়ান', state: 'blocked',
      detailBn: '১২টির মধ্যে ৩টি সম্পূর্ণ — ৯টি বাকি', done: 3, total: 12 },
    { id: 'rooms', titleBn: 'কক্ষ ও ল্যাব', state: 'ok',
      detailBn: '২২টি কক্ষ পাওয়া গেছে', done: 22, total: 22 },
  ],
  canGenerate: false,
};

const CLEAN_RESULT = {
  shifts: [{
    shift: 'morning', routineId: ROUTINE_M, version: 1, created: true,
    totalDemand: 580, placed: 580, unplaced: [], soft: { violations: [] },
    shortages: [], solverSeconds: 1.06,
  }],
  summary: {
    totalDemand: 580, placed: 580, unplacedPeriods: 0, unplacedDemands: 0,
    softViolations: 12, hardConflicts: 0, shortages: [],
    solverSeconds: 1.06, totalSeconds: 1.2,
    verdictBn: 'সব ৫৮০টি পিরিয়ড বসানো হয়েছে',
  },
};

const PARTIAL_RESULT = {
  shifts: [{
    shift: 'day', routineId: ROUTINE_M, version: 2, created: false,
    totalDemand: 100, placed: 88,
    unplaced: [{
      sectionName: 'নবম — ক', subjectBn: 'রসায়ন ব্যবহারিক', teacherBn: 'সালমা ম্যাডাম',
      required: 4, placed: 1, missing: 3, reason: 'no_free_capable_room',
      reasonBn: 'উপযুক্ত কক্ষ আছে, কিন্তু ওই সময়ে সেটি খালি নেই',
    }],
    soft: { violations: [] },
    shortages: [{ capability: 'chemistry_lab',
                  detailBn: 'রসায়নের ১২টি ল্যাব পিরিয়ড দরকার; ১টি কক্ষে ৮টি খালি' }],
    solverSeconds: 0.4,
  }],
  summary: {
    totalDemand: 100, placed: 88, unplacedPeriods: 12, unplacedDemands: 1,
    softViolations: 3, hardConflicts: 0,
    shortages: [{ capability: 'chemistry_lab',
                  detailBn: 'রসায়নের ১২টি ল্যাব পিরিয়ড দরকার; ১টি কক্ষে ৮টি খালি' }],
    solverSeconds: 0.4, totalSeconds: 0.6,
    verdictBn: '১০০টির মধ্যে ৮৮টি বসানো হয়েছে — ১২টি বাকি',
  },
};

const CONFLICT_RESULT = {
  ...CLEAN_RESULT,
  summary: {
    ...CLEAN_RESULT.summary, hardConflicts: 4,
    verdictBn: '৪টি সময়ের সংঘাত রয়ে গেছে — এই রুটিন প্রকাশ করা যাবে না',
  },
};

let readiness: unknown = READY;
let runs: { routineId: string; shift: string; version: number; status: string;
            slots: number; solverSeconds: number | null; generatedAt: string | null }[] = [];
let post: { ok: boolean; status: number; body: unknown } =
  { ok: true, status: 200, body: CLEAN_RESULT };
let postCalls = 0;
let navigated: string[] = [];
let postGate: (() => Promise<void>) | null = null;

function auth() {
  return {
    role: 'academic_coordinator',
    authedFetch: async (url: string, init?: { method?: string }) => {
      if (init?.method === 'POST') {
        postCalls++;
        if (postGate) await postGate();
        return { ok: post.ok, status: post.status,
                 json: async () => post.body } as unknown as Response;
      }
      if (url.includes('/rms/generate')) {
        return { ok: true, status: 200,
                 json: async () => ({ runs }) } as unknown as Response;
      }
      if (url.includes('/rms/setup')) {
        return { ok: true, status: 200,
                 json: async () => JSON.parse(JSON.stringify(readiness)) } as unknown as Response;
      }
      return { ok: true, status: 200,
               json: async () => ({ years: [{ id: YEAR, isCurrent: true }] }) } as unknown as Response;
    },
  } as unknown as ConstructorParameters<typeof RoutineGenerateView>[0]['auth'];
}

const mount = async (extra: Partial<ConstructorParameters<typeof RoutineGenerateView>[0]> = {}) => {
  root().textContent = '';
  const v = new RoutineGenerateView({
    root: root(), doc: doc(), auth: auth(), yearId: YEAR,
    onNavigate: (p) => navigated.push(p), ...extra,
  });
  await settle();
  return v;
};

const buttonNamed = (text: string) =>
  [...root().querySelectorAll('button')].find((b) => (b.textContent ?? '').includes(text));

describe('P9-3 — the generate screen', () => {
  beforeEach(() => {
    readiness = READY; runs = []; navigated = []; postCalls = 0; postGate = null;
    post = { ok: true, status: 200, body: CLEAN_RESULT };
  });

  test('THE ONE THAT MATTERS — one press, and the answer is the server’s sentence', async () => {
    const v = await mount();
    buttonNamed('রুটিন তৈরি করুন')?.click();
    await settle();
    v.destroy();

    assert.equal(postCalls, 1);
    const t = root().textContent ?? '';
    assert.match(t, /সব ৫৮০টি পিরিয়ড বসানো হয়েছে/,
      'rendered verbatim — a browser-composed sentence would drift from the numbers');
    assert.match(t, /৫৮০ \/ ৫৮০/, 'and the counters agree with it');
  });

  test('the WAIT is honest — elapsed seconds, and no invented percentage', async () => {
    let release: (() => void) | null = null;
    postGate = () => new Promise<void>((r) => { release = r; });
    let clock = 1_000_000;
    const v = await mount({ now: () => clock });

    buttonNamed('রুটিন তৈরি করুন')?.click();
    await settle();

    const waiting = root().textContent ?? '';
    assert.match(waiting, /০ সেকেন্ড চলছে/, 'the count starts at zero and is real');
    assert.match(waiting, /কত শতাংশ হয়েছে তা বলা যাচ্ছে না/,
      'says why there is no percentage rather than inventing one');
    assert.equal(root().querySelector('[role="progressbar"]'), null,
      'a determinate bar over an unmeasurable wait is a lie');
    assert.ok(root().querySelector('[role="status"]'), 'but the wait is announced');

    clock += 3_000;
    release?.();
    await settle();
    v.destroy();
    assert.match(root().textContent ?? '', /সব ৫৮০টি পিরিয়ড/);
  });

  test('a HARD CONFLICT outranks “all periods placed”', async () => {
    post = { ok: true, status: 200, body: CONFLICT_RESULT };
    const v = await mount();
    buttonNamed('রুটিন তৈরি করুন')?.click();
    await settle();
    v.destroy();

    const t = root().textContent ?? '';
    assert.match(t, /প্রকাশ করা যাবে না/,
      'the routine cannot be published, and that is the headline');
    assert.match(t, /রুটিন সম্পাদনা/, 'and it offers the screen that can fix it');
  });

  test('UNPLACED demand names the class, the subject and the reason', async () => {
    post = { ok: true, status: 200, body: PARTIAL_RESULT };
    const v = await mount();
    buttonNamed('রুটিন তৈরি করুন')?.click();
    await settle();
    v.destroy();

    const t = root().textContent ?? '';
    assert.match(t, /নবম — ক/, 'the class');
    assert.match(t, /রসায়ন ব্যবহারিক/, 'the subject');
    assert.match(t, /৩টি পিরিয়ড বাকি/, 'the shortfall');
    assert.match(t, /ওই সময়ে সেটি খালি নেই/,
      'and the reason — "no capable room" and "the room is full" are different errands');
    assert.doesNotMatch(t, /[0-9a-f]{8}-[0-9a-f]{4}/, 'never a raw uuid');
  });

  test('a school that is NOT READY cannot press the button, and is told why', async () => {
    readiness = BLOCKED;
    const v = await mount();
    v.destroy();

    const go = buttonNamed('রুটিন তৈরি করুন');
    assert.ok(go, 'the button is still shown, so its state is the message');
    assert.equal(go.disabled, true);
    const t = root().textContent ?? '';
    assert.match(t, /কে কোন বিষয় পড়ান/, 'the blocked step is named');
    assert.match(t, /৯টি বাকি/, 'with the count that will clear it');

    buttonNamed('প্রস্তুতি দেখুন')?.click();
    await settle();
    assert.deepEqual(navigated, ['routinesetup']);
  });

  test('a stale READY in this browser is corrected by the server’s refusal', async () => {
    // The window between "the checklist said yes" and pressing the button.
    // Someone else emptied the room list; the server refuses with the steps.
    post = {
      ok: false, status: 409,
      body: {
        error: 'not_ready',
        message: 'রুটিন তৈরি করা যাবে না — কক্ষ ও ল্যাব বাকি আছে',
        steps: [{ id: 'rooms', titleBn: 'কক্ষ ও ল্যাব', state: 'blocked',
                  detailBn: 'কোনো কক্ষ নেই — রুটিনে ক্লাস বসানোর জায়গা লাগবে',
                  done: 0, total: 1 }],
      },
    };
    const v = await mount();
    buttonNamed('রুটিন তৈরি করুন')?.click();
    await settle();
    v.destroy();

    const t = root().textContent ?? '';
    assert.match(t, /কক্ষ ও ল্যাব বাকি আছে/, 'the server’s own sentence');
    assert.match(t, /কোনো কক্ষ নেই/, 'and the step it named, not this browser’s stale copy');
    assert.equal(buttonNamed('রুটিন তৈরি করুন')?.disabled, true);
  });

  test('a SERVER ERROR offers a retry and says the earlier work is not lost', async () => {
    post = { ok: false, status: 500,
             body: { error: 'internal_error', message: 'রুটিন তৈরি করা যায়নি' } };
    const v = await mount();
    buttonNamed('রুটিন তৈরি করুন')?.click();
    await settle();

    const t = root().textContent ?? '';
    assert.match(t, /রুটিন তৈরি করা যায়নি/);
    assert.notEqual(buttonNamed('আবার চেষ্টা করুন'), undefined,
      'a refusal with no way forward is the failure state the brief forbids');

    post = { ok: true, status: 200, body: CLEAN_RESULT };
    buttonNamed('আবার চেষ্টা করুন')?.click();
    await settle();
    v.destroy();
    assert.equal(postCalls, 2);
    assert.match(root().textContent ?? '', /সব ৫৮০টি পিরিয়ড/);
  });

  test('a PRIOR run survives a refresh, and the button says it will top up', async () => {
    runs = [{ routineId: ROUTINE_M, shift: 'morning', version: 1, status: 'draft',
              slots: 540, solverSeconds: 1.1, generatedAt: '2026-09-06 10:00:00+00' }];
    const v = await mount();
    v.destroy();

    const t = root().textContent ?? '';
    assert.match(t, /৫৪০টি পিরিয়ড বসানো আছে/, 'the earlier run is on screen, not lost');
    assert.match(t, /নতুন রুটিন তৈরি হবে না/,
      'and the commonest fear at this button — a second timetable — is answered');
    assert.notEqual(buttonNamed('আবার তৈরি করুন'), undefined);
  });

  test('the explanation screen is one tap from every shift', async () => {
    const v = await mount();
    buttonNamed('রুটিন তৈরি করুন')?.click();
    await settle();
    buttonNamed('বিস্তারিত ব্যাখ্যা')?.click();
    await settle();
    v.destroy();
    assert.deepEqual(navigated, [`generation?routineId=${ROUTINE_M}`],
      'the §8.2 explainer already exists — this links to it rather than copying it');
  });

  test('a refusal to READ the screen shows permission, not an empty page', async () => {
    root().textContent = '';
    const v = new RoutineGenerateView({
      root: root(), doc: doc(), yearId: YEAR,
      auth: {
        role: 'student',
        authedFetch: async () => ({ ok: false, status: 403,
          json: async () => ({ error: 'forbidden' }) } as unknown as Response),
      } as unknown as ConstructorParameters<typeof RoutineGenerateView>[0]['auth'],
    });
    await settle();
    v.destroy();
    assert.match(root().textContent ?? '', /অনুমতি/);
  });

  test('pressing twice while a run is in flight sends one request', async () => {
    let release: (() => void) | null = null;
    postGate = () => new Promise<void>((r) => { release = r; });
    const v = await mount();

    buttonNamed('রুটিন তৈরি করুন')?.click();
    await settle();
    // The button is gone during the wait; calling generate again directly is
    // the harsher version of the same double-press.
    (v as unknown as { generate: () => Promise<void> }).generate();
    await settle();
    release?.();
    await settle();
    v.destroy();
    assert.equal(postCalls, 1, 'a second run would top up a routine mid-solve');
  });
});
