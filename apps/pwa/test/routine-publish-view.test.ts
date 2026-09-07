/**
 * P9-7 — the review screen, as a head teacher meets it.
 *
 * The API suite pins what the server decides. These are the things about the
 * SCREEN that decide whether a head can act on it:
 *
 *   1. THE CONFIRMATION SAYS WHAT WILL HAPPEN. §6. "আপনি কি নিশ্চিত?"
 *      carries no information and teaches people to click through. This one
 *      names the number of lessons, who will see them, what it replaces and
 *      what is being accepted — and only then offers the button.
 *
 *   2. A BLOCKED ROUTINE OFFERS NO PUBLISH. The server refuses anyway (§3 —
 *      the UI is not authoritative), but a head who presses a button and
 *      receives a 409 has learned the screen cannot be trusted.
 *
 *   3. THE FINGERPRINT TRAVELS WITH THE APPROVAL. §9. Approving a timetable
 *      that changed after it was drawn is approving something unread.
 *
 *   4. OFFLINE IS EXPLAINED, NOT HIDDEN. §14. Publishing cannot be queued;
 *      a coordinator who cannot find the button concludes it is broken.
 *
 *   5. EVERY STATE SAYS SOMETHING. §15. Loading, empty, error, denied — no
 *      blank screen, and the empty state carries the way out.
 */
import { test, describe, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

import { RoutinePublishView, type ReviewEntry } from '../src/routine-publish-view.ts';

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
const text = () => root().textContent ?? '';
const buttonNamed = (label: string) =>
  [...root().querySelectorAll('button')]
    .find((b) => (b.textContent ?? '').includes(label));
const dialog = () =>
  doc().querySelector('[role="alertdialog"], [role="dialog"]') as HTMLElement | null;
const dialogButton = (label: string) =>
  [...(dialog()?.querySelectorAll('button') ?? [])]
    .find((b) => (b.textContent ?? '').includes(label));

const YEAR = 'aaaaaaaa-0000-4000-8000-00000000000a';
const RID = 'bbbbbbbb-0000-4000-8000-00000000000b';

const CLEAN: ReviewEntry = {
  routineId: RID, status: 'draft', statusBn: 'খসড়া', version: 2,
  shift: 'morning', shiftBn: 'সকাল', nameBn: 'বার্ষিক রুটিন', yearLabel: '২০২৬',
  slots: 560, sections: 20, teachers: 23, pinned: 2,
  hardConflicts: 0, softViolations: 12, unplacedDemands: 0,
  lastModified: '2026-03-01T04:00:00.000Z', fingerprint: '560:1120',
  publishedAt: null, publishedByBn: null, supersedes: null,
  blockers: [], warnings: [], canPublish: true,
  // Composed by the server (api/publish.ts), not by the screen — the rule
  // P9-3's generate view states about its verdict: a browser that assembles
  // a sentence out of the counters printed beside it drifts from them the
  // first time either changes.
  verdictBn: 'এই রুটিন প্রকাশ করা যাবে।',
  consequenceBn: [
    'সকাল শিফটের ৫৬০টি ক্লাস আজ থেকে সবার রুটিনে দেখা যাবে — '
    + 'শিক্ষক, শিক্ষার্থী ও অভিভাবক সবাই।',
    'প্রকাশের পর এই রুটিন সরাসরি বদলানো যাবে না — বদলাতে হলে নতুন খসড়া তৈরি করতে হবে।',
  ],
};
const WARNED: ReviewEntry = {
  ...CLEAN, unplacedDemands: 2,
  warnings: [{
    code: 'unplaced',
    messageBn: '২টি বিষয়ের কিছু পিরিয়ড বসানো যায়নি।',
    actionBn: 'প্রকাশ করা যাবে, তবে ওই বিষয়গুলো সপ্তাহে কম পড়বে।',
  }],
  consequenceBn: [
    CLEAN.consequenceBn[0],
    'মেনে নেওয়া হচ্ছে: ২টি বিষয়ের কিছু পিরিয়ড বসানো যায়নি।',
    CLEAN.consequenceBn[1],
  ],
};
const BLOCKED: ReviewEntry = {
  ...CLEAN, hardConflicts: 3, canPublish: false,
  verdictBn: 'এই রুটিন এখনই প্রকাশ করা যাবে না।',
  blockers: [{
    code: 'hard_conflict',
    messageBn: '৩টি ক্লাস একই সময়ে একই শিক্ষক, কক্ষ বা শাখার সঙ্গে পড়ে গেছে।',
    actionBn: 'রুটিন সম্পাদনা পাতায় গিয়ে সংঘর্ষগুলো সরান — তারপর প্রকাশ করা যাবে।',
  }],
};
const PUBLISHED: ReviewEntry = {
  ...CLEAN, status: 'active', statusBn: 'প্রকাশিত', canPublish: false,
  verdictBn: 'এই রুটিন চালু আছে।',
  publishedAt: '2026-03-02T05:30:00.000Z', publishedByBn: 'প্রধান শিক্ষক',
};
const REPLACING: ReviewEntry = {
  ...CLEAN, version: 3, supersedes: { version: 2, publishedAt: '2026-01-01T00:00:00.000Z' },
  consequenceBn: [
    CLEAN.consequenceBn[0],
    'এখন চালু ২ নম্বর রুটিনটি বাতিল হয়ে যাবে।',
    CLEAN.consequenceBn[1],
  ],
};

let entries: ReviewEntry[] = [];
let getReply: { ok: boolean; status: number; body: unknown } | null = null;
let postReply: { ok: boolean; status: number; body: unknown } =
  { ok: true, status: 200, body: { ok: true, messageBn: 'রুটিন প্রকাশিত হয়েছে।' } };
let sent: Array<Record<string, unknown>> = [];
let navigated: string[] = [];
let online = true;

function auth() {
  return {
    role: 'principal',
    authedFetch: async (url: string, init?: { method?: string; body?: string }) => {
      if (init?.method === 'POST') {
        sent.push(JSON.parse(String(init.body ?? '{}')));
        return { ok: postReply.ok, status: postReply.status,
                 json: async () => postReply.body } as unknown as Response;
      }
      if (url.includes('/rms/publish')) {
        if (getReply) {
          return { ok: getReply.ok, status: getReply.status,
                   json: async () => getReply.body } as unknown as Response;
        }
        return { ok: true, status: 200, json: async () => ({
          ok: true, tenantNameBn: 'পি৯৭ বিদ্যালয়', yearLabel: '২০২৬',
          routines: JSON.parse(JSON.stringify(entries)),
        }) } as unknown as Response;
      }
      return { ok: true, status: 200,
               json: async () => ({ years: [{ id: YEAR, isCurrent: true }] }) } as unknown as Response;
    },
  } as never;
}

const mount = async () => {
  root().textContent = '';
  new RoutinePublishView({
    root: root(), doc: doc(), auth: auth(), yearId: YEAR,
    onNavigate: (p) => navigated.push(p),
    online: () => online,
  });
  await settle();
};

describe('P9-7 — the routine review screen', () => {
  beforeEach(() => {
    entries = [structuredClone(CLEAN)];
    getReply = null;
    postReply = { ok: true, status: 200,
                  body: { ok: true, messageBn: 'রুটিন প্রকাশিত হয়েছে।' } };
    sent = [];
    navigated = [];
    online = true;
    dialog()?.remove();
    doc().querySelectorAll('.ui-scrim').forEach((n) => n.remove());
  });

  /* ───────────────────────── §6 the confirmation ──────────────────────── */

  test('THE ONE THAT MATTERS — the confirmation says what publishing does, before it does it', async () => {
    entries = [structuredClone(REPLACING)];
    await mount();

    buttonNamed('প্রকাশ করুন')?.click();
    await settle();
    assert.equal(sent.length, 0, 'opening the confirmation publishes nothing');

    const said = dialog()?.textContent ?? '';
    assert.match(said, /৫৬০টি ক্লাস/, 'how many lessons');
    assert.match(said, /শিক্ষক, শিক্ষার্থী ও অভিভাবক/, 'who will see them');
    assert.match(said, /২ নম্বর রুটিনটি বাতিল/, 'what it replaces');
    assert.match(said, /সরাসরি বদলানো যাবে না/, 'and that it cannot be taken back');
  });

  test('the confirmation lists every warning being accepted', async () => {
    entries = [structuredClone(WARNED)];
    await mount();
    buttonNamed('প্রকাশ করুন')?.click();
    await settle();
    assert.match(dialog()?.textContent ?? '',
      /মেনে নেওয়া হচ্ছে: ২টি বিষয়ের কিছু পিরিয়ড বসানো যায়নি।/,
      'publishing over a known gap is a decision, and it is named');
  });

  test('§9 — approving sends the fingerprint the screen was drawn from', async () => {
    await mount();
    buttonNamed('প্রকাশ করুন')?.click();
    await settle();
    dialogButton('হ্যাঁ, প্রকাশ করুন')?.click();
    await settle();

    assert.equal(sent.length, 1);
    assert.equal(sent[0].action, 'publish');
    assert.equal(sent[0].routineId, RID);
    assert.equal(sent[0].confirmWarnings, true);
    assert.equal(sent[0].fingerprint, '560:1120',
      'a routine edited after the head read it must not be published unread');
  });

  test('cancelling publishes nothing', async () => {
    await mount();
    buttonNamed('প্রকাশ করুন')?.click();
    await settle();
    dialogButton('বাতিল')?.click();
    await settle();
    assert.equal(sent.length, 0);
  });

  /* ────────────────────────── §3 blockers ─────────────────────────────── */

  test('a blocked routine offers no publish button, and says why and what to do', async () => {
    entries = [structuredClone(BLOCKED)];
    await mount();

    assert.equal(buttonNamed('প্রকাশ করুন')?.disabled, true,
      'the button is present but unreachable — hiding it would read as a bug');
    assert.match(text(), /এই রুটিন এখনই প্রকাশ করা যাবে না।/);
    assert.match(text(), /৩টি ক্লাস একই সময়ে/, 'the reason');
    assert.match(text(), /রুটিন সম্পাদনা পাতায় গিয়ে/, 'and the next step');
  });

  test('a hard-conflict count of zero is still shown', async () => {
    await mount();
    assert.match(text(), /সময়ের সংঘর্ষ/);
    assert.match(text(), /০টি/,
      'a head who reads "০টি" has been told; an absent row leaves them to assume');
  });

  test('the server refusing an unconfirmed publish reopens the confirmation with its warnings', async () => {
    // §5. The server hands back what it wants confirmed; re-asking with those
    // on screen is the point of the refusal, not an error to print.
    postReply = { ok: false, status: 409, body: {
      error: 'warnings_unconfirmed',
      message: 'এই রুটিনে কিছু সতর্কতা আছে।',
      warnings: [{ code: 'soft', messageBn: '৯টি ক্ষেত্রে পছন্দের নিয়ম ছাড় দিতে হয়েছে।' }],
    } };
    await mount();
    // Reach the endpoint directly by confirming an entry the screen believed
    // clean — the state a stale screen is actually in.
    buttonNamed('প্রকাশ করুন')?.click();
    await settle();
    dialogButton('হ্যাঁ, প্রকাশ করুন')?.click();
    await settle();

    const said = dialog()?.textContent ?? '';
    assert.match(said, /মেনে নেওয়া হচ্ছে: ৯টি ক্ষেত্রে পছন্দের নিয়ম ছাড়/,
      'the second ask shows what the server wanted confirmed');
    assert.ok(said.indexOf('মেনে নেওয়া হচ্ছে') < said.indexOf('সরাসরি বদলানো যাবে না'),
      'and it lands above the closing line rather than after it');
  });

  test('a refused action keeps the review on screen', async () => {
    // It used to throw into the permission panel, so a head who was reading
    // their timetable lost it and was told they may not see it. Found in the
    // demo, whose 403 means "this build does not write".
    postReply = { ok: false, status: 403, body: {
      error: 'demo_read_only',
      message: 'এটি প্রদর্শনী সংস্করণ — এখানে সত্যিকারের রুটিন প্রকাশ করা যায় না।',
    } };
    await mount();
    buttonNamed('প্রকাশ করুন')?.click();
    await settle();
    dialogButton('হ্যাঁ, প্রকাশ করুন')?.click();
    await settle();

    assert.match(text(), /এটি প্রদর্শনী সংস্করণ/, 'the server says why');
    assert.match(text(), /মোট ক্লাস/, 'and the review is still there');
    assert.doesNotMatch(text(), /অনুমতি আপনার নেই/,
      'a refused action is not a refused screen');
  });

  test('a refusal is shown in the server’s own words', async () => {
    postReply = { ok: false, status: 409, body: {
      error: 'stale_routine',
      message: 'এই রুটিনটি আপনার পর্দায় দেখানোর পর অন্য কেউ বদলে ফেলেছেন।',
    } };
    await mount();
    buttonNamed('প্রকাশ করুন')?.click();
    await settle();
    dialogButton('হ্যাঁ, প্রকাশ করুন')?.click();
    await settle();
    assert.match(text(), /অন্য কেউ বদলে ফেলেছেন/);
  });

  /* ──────────────────────── §2 the facts ──────────────────────────────── */

  test('§2 — every number carries the word that says what it counts', async () => {
    await mount();
    for (const label of ['মোট ক্লাস', 'শাখা', 'শিক্ষক', 'সময়ের সংঘর্ষ',
                         'বসানো যায়নি', 'পিন করা']) {
      assert.match(text(), new RegExp(label), `missing: ${label}`);
    }
    assert.match(text(), /৫৬০টি/);
    assert.match(text(), /২০টি/);
    assert.match(text(), /২৩ জন/);
    assert.match(text(), /খসড়া নম্বর ২/, 'the version being reviewed');
    assert.match(text(), /সর্বশেষ পরিবর্তন/);
    assert.match(text(), /পি৯৭ বিদ্যালয়/, 'the institution');
  });

  test('no machine identifier or Latin numeral reaches the screen', async () => {
    entries = [structuredClone(BLOCKED)];
    await mount();
    assert.doesNotMatch(text(), /[0-9a-f]{8}-[0-9a-f]{4}/, 'no uuid');
    assert.doesNotMatch(text(), /hard_conflict|unplaced|routine_slots/, 'no codes');
    assert.doesNotMatch(text(), /undefined|NaN|\[object/);
  });

  /* ───────────────────── draft → review → published ───────────────────── */

  test('a draft offers the handover; a routine in review offers it back', async () => {
    await mount();
    assert.ok(buttonNamed('পর্যালোচনার জন্য পাঠান'), 'a draft can be handed over');
    assert.equal(buttonNamed('খসড়ায় ফেরত নিন'), undefined);

    buttonNamed('পর্যালোচনার জন্য পাঠান')?.click();
    await settle();
    assert.equal(sent[0].action, 'submit');

    entries = [{ ...structuredClone(CLEAN), status: 'review', statusBn: 'পর্যালোচনায়' }];
    await mount();
    assert.ok(buttonNamed('খসড়ায় ফেরত নিন'));
    assert.equal(buttonNamed('পর্যালোচনার জন্য পাঠান'), undefined);
  });

  test('a published routine offers no lifecycle buttons at all', async () => {
    entries = [structuredClone(PUBLISHED)];
    await mount();
    assert.equal(buttonNamed('প্রকাশ করুন'), undefined);
    assert.equal(buttonNamed('পর্যালোচনার জন্য পাঠান'), undefined);
    assert.equal(buttonNamed('খসড়ায় ফেরত নিন'), undefined);
    assert.match(text(), /এই রুটিন চালু আছে — /,
      'no dari before the clause that continues the sentence');
    assert.match(text(), /প্রকাশ করেছেন প্রধান শিক্ষক/, 'who published it');
  });

  test('a live routine is not described as broken', async () => {
    // The server marks a published routine `already_published` so the publish
    // endpoint refuses a second attempt. Shown under "যা ঠিক করতে হবে" it told
    // a head their working timetable needed fixing — found in the browser,
    // against the real API, immediately after a successful publish.
    entries = [{
      ...structuredClone(PUBLISHED),
      blockers: [{ code: 'already_published', messageBn: 'এই রুটিন আগেই প্রকাশিত।',
                   actionBn: 'বদলাতে হলে নতুন খসড়া তৈরি করুন।' }],
      warnings: [{ code: 'soft', messageBn: '১২টি ক্ষেত্রে পছন্দের নিয়ম ছাড় দিতে হয়েছে।' }],
    }];
    await mount();
    assert.doesNotMatch(text(), /যা ঠিক করতে হবে/, 'a live routine has nothing to fix');
    assert.doesNotMatch(text(), /এই রুটিন আগেই প্রকাশিত।/);
    assert.match(text(), /যা জেনে রাখা দরকার/, 'but what it carries is still worth reading');
    assert.match(text(), /১২টি ক্ষেত্রে পছন্দের নিয়ম/);
  });

  /* ─────────────────────────── §14 / §15 states ───────────────────────── */

  test('§14 — offline disables publishing and says why, rather than hiding it', async () => {
    online = false;
    await mount();
    assert.equal(buttonNamed('প্রকাশ করুন')?.disabled, true);
    assert.equal(buttonNamed('পর্যালোচনার জন্য পাঠান')?.disabled, true);
    assert.match(text(), /সংযোগ নেই — রুটিন দেখা যাচ্ছে, কিন্তু প্রকাশ করতে ইন্টারনেট লাগবে।/);
    assert.match(text(), /৫৬০টি/, 'and the review is still readable');
  });

  test('§15 — the empty state names the next step', async () => {
    entries = [];
    await mount();
    assert.match(text(), /এখনো কোনো রুটিন তৈরি হয়নি/);
    const make = buttonNamed('রুটিন তৈরি করুন');
    assert.ok(make, 'an empty state that only says "nothing here" wastes the moment');
    make.click();
    assert.deepEqual(navigated, ['routinegenerate']);
  });

  test('§15 — a failed read offers a retry, not a blank screen', async () => {
    getReply = { ok: false, status: 500, body: { error: 'internal_error' } };
    await mount();
    assert.ok(text().length > 0, 'never blank');
    assert.match(text(), /আবার চেষ্টা করুন/);
  });

  test('§15 — a refusal shows who to ask, not a retry', async () => {
    getReply = { ok: false, status: 403, body: { error: 'forbidden' } };
    await mount();
    assert.ok(text().length > 0);
    assert.equal(buttonNamed('আবার চেষ্টা করুন'), undefined,
      'a retry button on a locked door teaches people to hammer it');
  });

  test('two shifts are reviewed separately', async () => {
    entries = [
      { ...structuredClone(CLEAN), shift: 'morning', shiftBn: 'সকাল' },
      { ...structuredClone(BLOCKED), routineId: 'cccccccc-0000-4000-8000-00000000000c',
        shift: 'day', shiftBn: 'দিবা' },
    ];
    await mount();
    assert.match(text(), /সকাল শিফট/);
    assert.match(text(), /দিবা শিফট/);
    // §11. A morning conflict is not an evening problem, so one blocked shift
    // must not disable the other's publish.
    const publishButtons = [...root().querySelectorAll('button')]
      .filter((b) => (b.textContent ?? '').includes('প্রকাশ করুন'));
    assert.equal(publishButtons.length, 2);
    assert.equal(publishButtons[0].disabled, false);
    assert.equal(publishButtons[1].disabled, true);
  });
});
