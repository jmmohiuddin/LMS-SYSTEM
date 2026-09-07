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
    totalDemand: 580, placed: 580, unplaced: [], softViolations: 12,
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
    softViolations: 3,
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

  test('a result with NO explanations never claims there are no problems', async () => {
    // P9-4 moved the unplaced detail into the findings list. This fixture
    // predates that field, which is exactly the shape an older build or a
    // truncated response would have — and the first version of the findings
    // card answered it with "কোনো সমস্যা পাওয়া যায়নি" above a summary
    // saying twelve periods were missing.
    post = { ok: true, status: 200, body: PARTIAL_RESULT };
    const v = await mount();
    buttonNamed('রুটিন তৈরি করুন')?.click();
    await settle();
    v.destroy();

    const t = root().textContent ?? '';
    assert.doesNotMatch(t, /কোনো সমস্যা পাওয়া যায়নি/,
      'the summary says twelve periods are missing; the claim must agree with it');
    assert.match(t, /ব্যাখ্যা পাওয়া যায়নি/, 'say what is actually true');
    assert.match(t, /১২টি পিরিয়ড বাকি/, 'and repeat the number that IS known');
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

/**
 * P9-4 — the explanation on screen.
 *
 * The API suite pins what is said. These pin how it reaches a person:
 *
 *   1. Three severities read as three different things, in WORDS. A red left
 *      rail is invisible to a screen reader and to anyone who cannot
 *      separate it from the amber one.
 *
 *   2. A school with nothing wrong sees a calm success state, not a panel of
 *      empty headings — and still sees what was NOT checked, because "০
 *      সমস্যা" otherwise means "০ of the rules we happen to run".
 *
 *   3. The drawer carries all four sections in order, and every sentence in
 *      it is the server's. A browser that rewrote one would drift from the
 *      evidence that justified it.
 *
 *   4. No machine identifier survives to the DOM.
 */
const EXPLANATIONS = [
  {
    id: 'unplaced:s1:j1:0', severity: 'error', category: 'teacher_conflict',
    titleBn: 'নবম — ক · জীববিজ্ঞান — ১টি পিরিয়ড বসেনি',
    whatBn: 'নবম — ক-এ জীববিজ্ঞান এর আরও ১টি পিরিয়ড প্রয়োজন। রফিক স্যার উপযুক্ত সব সময়েই ব্যস্ত ছিলেন।',
    whyBn: '৩৫টি সম্ভাব্য সময়ের মধ্যে ৩০টিতে তিনি অন্য শাখায় ক্লাস নিচ্ছিলেন।',
    affectedBn: ['নবম — ক', 'জীববিজ্ঞান', 'রফিক স্যার'],
    currentBn: '৪টির মধ্যে ৩টি পিরিয়ড বসানো হয়েছে — ১টি বাকি',
    impactBn: 'নবম — ক-এ জীববিজ্ঞান সপ্তাহে ১টি পিরিয়ড কম পড়বে।',
    suggestions: [
      { textBn: 'রফিক স্যারের অন্য কোনো শাখার একটি পিরিয়ড সরিয়ে এই সময়টি খালি করুন',
        evidenceBn: '৩০টি সময়ে তিনি অন্যত্র ক্লাস নিচ্ছিলেন' },
    ],
  },
  {
    id: 'setup:0', severity: 'warning', category: 'setup_gap',
    titleBn: 'শিক্ষকের সময়-সীমা',
    whatBn: 'কারও সময়-সীমা দেওয়া হয়নি — সবাইকে সব সময় ফাঁকা ধরা হবে',
    whyBn: 'এই তথ্যটি ঐচ্ছিক — না দিলেও রুটিন তৈরি হয়েছে।',
    affectedBn: [],
    currentBn: 'কারও সময়-সীমা দেওয়া হয়নি',
    impactBn: 'তথ্যটি দিলে পরের রুটিন আরও বাস্তবসম্মত হবে।',
    suggestions: [{ textBn: 'রুটিন তৈরির প্রস্তুতি পাতায় গিয়ে তথ্যটি দিন',
                    evidenceBn: 'ধাপটি এখনো ঐচ্ছিক হিসেবে বাকি আছে' }],
  },
  {
    id: 'unchecked:0', severity: 'info', category: 'not_evaluated',
    titleBn: 'যাচাই করা হয়নি — কঠিন বিষয় দিনের শুরুতে রাখা',
    whatBn: '"কঠিন বিষয় দিনের শুরুতে রাখা" নিয়মটি এই রানে পরীক্ষা করা হয়নি।',
    whyBn: 'বিষয়ের কাঠিন্য মাত্রা কোথাও সংরক্ষিত নেই',
    affectedBn: [],
    currentBn: 'পরীক্ষা করা হয়নি',
    impactBn: 'তাই "কোনো সমস্যা নেই" বলতে এই নিয়মটি ধরা হয়নি।',
    suggestions: [],
  },
];

const WITH_FINDINGS = {
  ...CLEAN_RESULT,
  shifts: [{ ...CLEAN_RESULT.shifts[0], placed: 579,
             unplaced: [{ sectionName: 'নবম — ক', subjectBn: 'জীববিজ্ঞান',
                          teacherBn: 'রফিক স্যার', required: 4, placed: 3, missing: 1,
                          reason: 'no_free_slot', reasonBn: 'সময় পাওয়া যায়নি' }] }],
  summary: { ...CLEAN_RESULT.summary, unplacedPeriods: 1, placed: 579 },
  explanations: EXPLANATIONS,
  severity: { error: 1, warning: 1, info: 1 },
};

const ALL_GOOD = {
  ...CLEAN_RESULT,
  explanations: [EXPLANATIONS[2]],
  severity: { error: 0, warning: 0, info: 1 },
};

const drawer = () => dom.window.document.querySelector('[role="dialog"]') as HTMLElement | null;
const closeDrawer = () => {
  const b = [...(drawer()?.querySelectorAll('button') ?? [])]
    .find((x) => (x.getAttribute('aria-label') ?? '').includes('বন্ধ'));
  b?.click();
};

describe('P9-4 — the explanation on screen', () => {
  beforeEach(() => {
    readiness = READY; runs = []; navigated = []; postCalls = 0; postGate = null;
    post = { ok: true, status: 200, body: WITH_FINDINGS };
    drawer()?.remove();
    dom.window.document.querySelectorAll('.ui-scrim').forEach((n) => n.remove());
  });

  const generate = async () => {
    const v = await mount();
    buttonNamed('রুটিন তৈরি করুন')?.click();
    await settle();
    return v;
  };

  test('THE ONE THAT MATTERS — three severities, said in words', async () => {
    const v = await generate();
    v.destroy();
    const t = root().textContent ?? '';
    assert.match(t, /ঠিক করা দরকার/, 'error');
    assert.match(t, /সতর্কতা/, 'warning');
    assert.match(t, /যা যাচাই করা হয়নি/, 'info');

    // The colour is a reinforcement, never the carrier (§14).
    const rows = [...root().querySelectorAll('.gen-finding')];
    assert.equal(rows.length, 3);
    for (const r of rows) {
      const label = r.querySelector('button')?.getAttribute('aria-label') ?? '';
      assert.match(label, /ঠিক করা দরকার|সতর্কতা|তথ্য/,
        'the severity must be in the accessible name, not only in the border');
    }
  });

  test('a warning does not read as a failure', async () => {
    post = { ok: true, status: 200,
             body: { ...WITH_FINDINGS,
                     explanations: [EXPLANATIONS[1], EXPLANATIONS[2]],
                     severity: { error: 0, warning: 1, info: 1 } } };
    const v = await generate();
    v.destroy();
    assert.match(root().textContent ?? '', /কোনোটিই রুটিন ব্যবহারে বাধা দেয় না/,
      'a school with only optional gaps must not be sent to fix them first');
  });

  test('ALL GOOD is a calm success state — and still says what was not checked', async () => {
    post = { ok: true, status: 200, body: ALL_GOOD };
    const v = await generate();
    v.destroy();
    const t = root().textContent ?? '';
    assert.match(t, /কোনো সমস্যা পাওয়া যায়নি/);
    assert.doesNotMatch(t, /ঠিক করা দরকার —/, 'no empty error heading');
    assert.match(t, /যাচাই করা হয়নি/,
      '"০ সমস্যা" means "০ of the rules we ran", and saying which is the honest part');
  });

  test('THE DRAWER carries all four sections, in order, from the server', async () => {
    const v = await generate();
    const open = root().querySelector('.gen-finding-open') as HTMLElement;
    open.click();
    await settle();

    const dlg = drawer();
    assert.ok(dlg, 'a focused panel, not a page of raw solver log');
    const text = dlg.textContent ?? '';
    for (const heading of ['কারণ', 'বর্তমান অবস্থা', 'প্রভাব', 'সম্ভাব্য সমাধান']) {
      assert.match(text, new RegExp(heading), `missing section: ${heading}`);
    }
    // Order matters: the reason before the state before the impact.
    const at = (h: string) => text.indexOf(h);
    assert.ok(at('কারণ') < at('বর্তমান অবস্থা'), 'কারণ first');
    assert.ok(at('বর্তমান অবস্থা') < at('প্রভাব'), 'then the state');
    assert.ok(at('প্রভাব') < at('সম্ভাব্য সমাধান'), 'then the impact, then the fix');

    // Verbatim from the server — not recomposed here.
    assert.match(text, /৩৫টি সম্ভাব্য সময়ের মধ্যে ৩০টিতে/);
    assert.match(text, /৩০টি সময়ে তিনি অন্যত্র ক্লাস নিচ্ছিলেন/,
      'the evidence line is what turns advice into an argument');
    closeDrawer();
    v.destroy();
  });

  test('the drawer is a labelled dialog and returns focus when it closes', async () => {
    const v = await generate();
    const open = root().querySelector('.gen-finding-open') as HTMLElement;
    open.focus();
    open.click();
    await settle();

    const dlg = drawer() as HTMLElement;
    assert.equal(dlg.getAttribute('role'), 'dialog');
    const labelledBy = dlg.getAttribute('aria-labelledby');
    assert.ok(labelledBy, 'an unlabelled dialog announces nothing');
    assert.match(
      dom.window.document.getElementById(labelledBy)?.textContent ?? '',
      /জীববিজ্ঞান/, 'and it is named for the finding it explains');

    closeDrawer();
    await settle();
    assert.equal(drawer(), null);
    assert.equal(dom.window.document.activeElement, open,
      'focus goes back to the row that opened it');
    v.destroy();
  });

  test('a finding with no honest suggestion says so rather than inventing one', async () => {
    post = { ok: true, status: 200,
             body: { ...WITH_FINDINGS, explanations: [EXPLANATIONS[2]],
                     severity: { error: 0, warning: 0, info: 1 } } };
    const v = await generate();
    (root().querySelector('.gen-finding-open') as HTMLElement).click();
    await settle();
    assert.match(drawer()?.textContent ?? '', /নিশ্চিত কোনো সমাধান বলা যাচ্ছে না/);
    closeDrawer();
    v.destroy();
  });

  test('NO MACHINE IDENTIFIER reaches the DOM, in the list or the drawer', async () => {
    const v = await generate();
    (root().querySelector('.gen-finding-open') as HTMLElement).click();
    await settle();
    const text = `${root().textContent ?? ''} ${drawer()?.textContent ?? ''}`;
    assert.doesNotMatch(text, /[0-9a-f]{8}-[0-9a-f]{4}/, 'a uuid');
    assert.doesNotMatch(text, /computer_lab|teacher_id|no_free_slot/, 'a database code');
    assert.doesNotMatch(text, /undefined|NaN/, 'a missing value');
    assert.doesNotMatch(text, /[0-9]+\s*টি/, 'a Latin numeral before a Bangla counter');
    closeDrawer();
    v.destroy();
  });

  test('the per-shift card no longer repeats the list', async () => {
    // Two copies of the same problems, and no way to tell which was the
    // real one. The shift card points at the single list instead.
    const v = await generate();
    v.destroy();
    assert.match(root().textContent ?? '', /কারণ ও সমাধান উপরের তালিকায়/);
    assert.equal(root().querySelectorAll('.gen-finding').length, 3,
      'exactly one row per finding, once');
  });
});
