/**
 * Guardian home — F-1001, F-1002, F-203, wireframe §9.1.
 *
 * §9.1's rule is about the reader: "This persona has the lowest technical
 * comfort in the product and may use the app four times a year — it must
 * survive being forgotten."
 *
 * So the assertions here are mostly about legibility to somebody with no
 * memory of the app: every status carries a WORD and not just a glyph or a
 * colour, the rank is never shown without its cohort, and the switcher is
 * on screen before the child's data has finished loading.
 */
import { test, describe, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

import { GuardianView } from '../src/guardian-view.ts';

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

const ANIKA = {
  studentId: 's-anika', nameBn: 'আনিকা রহমান', sectionLabel: 'নবম–ক',
  rollNo: 1, relationBn: 'পিতা',
};
const BIJOY = {
  studentId: 's-bijoy', nameBn: 'বিজয় রহমান', sectionLabel: 'ষষ্ঠ–খ',
  rollNo: 12, relationBn: 'পিতা',
};

const HOME = {
  ...ANIKA,
  attendance: {
    todayStatus: 'present', monthPercent: 94,
    present: 17, absent: 1, late: 0, halfDay: 0, excused: 2,
  },
  fees: { outstanding: 2500, earliestDue: '2026-08-15', overdueCount: 0 },
  result: { examNameBn: '১ম সাময়িক', gpa: 4.56, rankInSection: 7, sectionSize: 52 },
};

function stubAuth(home: unknown, wards = [ANIKA, BIJOY], seen: string[] = []) {
  return {
    authedFetch: async (url: string) => {
      seen.push(url);
      const body = url.includes('studentId=') ? { wards, student: home } : { wards, student: null };
      return { ok: true, status: 200, json: async () => body } as unknown as Response;
    },
  } as unknown as ConstructorParameters<typeof GuardianView>[0]['auth'];
}

async function mount(home: unknown, wards = [ANIKA, BIJOY], seen: string[] = []) {
  localStorage.clear();
  const root = dom.window.document.getElementById('root') as HTMLElement;
  root.textContent = '';
  new GuardianView({
    root, doc: dom.window.document, auth: stubAuth(home, wards, seen),
    onOpenFees: () => {}, onOpenResults: () => {},
  });
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
  return root;
}

describe('guardian home (§9.1)', () => {
  let root: HTMLElement;
  beforeEach(async () => { root = await mount(HOME); });

  test('F-203 — the switcher lists every child and marks the current one', () => {
    const opts = [...root.querySelectorAll('.ui-child-strip .ui-child-opt')];
    assert.equal(opts.length, 2);
    // The option now names the class as well: "আনিকা" and "আনিকা" are two
    // different children in more Bangladeshi families than not, and the
    // selector is the one control that must never be ambiguous.
    assert.deepEqual(opts.map((o) => o.querySelector('.ui-child-opt-name')?.textContent),
      ['আনিকা রহমান', 'বিজয় রহমান']);
    for (const o of opts) {
      // The section, whatever it is, must be in the name a reader hears.
      assert.match(o.getAttribute('aria-label') ?? '', /—\s*\S+/,
        'the accessible name must disambiguate two children with one name');
      assert.ok((o.getAttribute('aria-label') ?? '').includes(
        o.querySelector('.ui-child-opt-meta')?.textContent ?? '__none__'),
        'the spoken name carries the same section the eye sees');
    }
    // Selection is announced, not only coloured.
    assert.equal(opts[0].getAttribute('aria-selected'), 'true');
    assert.equal(opts[1].getAttribute('aria-selected'), 'false');
  });

  test('a guardian with one child is never asked to choose', async () => {
    const r = await mount({ ...HOME }, [ANIKA]);
    assert.equal(r.querySelector('.ui-child-strip'), null);
    assert.match(r.textContent ?? '', /আনিকা রহমান/);
  });

  test('the child is identified by class and roll, roll in Latin digits', () => {
    // The roll is an identifier — it is what a guardian reads down the
    // phone to the office — so it does not get Bangla numerals.
    assert.match(root.querySelector('.ui-child-identity')?.textContent ?? '', /নবম–ক · রোল 1/);
  });

  test('THE ONE THAT MATTERS — no status is carried by colour alone', () => {
    // Somebody who opens this four times a year has no memory of what a
    // green tint meant. F-812.
    //
    // Asserted per CARD, not per line: §9.1 draws the fee amount alone on
    // its main line with "বকেয়া ফি" as the heading above it, so requiring
    // words on every main line would contradict the wireframe. What must
    // hold is that removing the colour leaves the card still readable —
    // which it does via the heading, a glyph, and the sub-line.
    const cards = [...root.querySelectorAll('.ui-stat')];
    assert.equal(cards.length, 2);
    for (const card of cards) {
      // The tone moved to the tinted glyph square when these became shared
      // stat cards; what it means, and what this test guards, is unchanged.
      const tone = card.querySelector('.ui-stat-glyph')?.getAttribute('data-tone');
      assert.ok(tone, 'the card has a tone at all');
      const words = (card.textContent ?? '').replace(/[✓✗◔◑⌾⚠৳\s,.\d০-৯%–·\/]/g, '');
      assert.ok(words.length > 3, `"${card.textContent}" survives losing its colour`);
    }
    // And the one that can be said in a word, is.
    assert.match(cards[0].querySelector('.ui-stat-value')?.textContent ?? '', /উপস্থিত/);
  });

  test('attendance shows today and the month, in Bangla numerals', () => {
    const card = root.querySelectorAll('.ui-stat')[0];
    assert.match(card.textContent ?? '', /✓ উপস্থিত/);
    assert.match(card.textContent ?? '', /এ মাসে ৯৪%/);
  });

  test('fees show the amount and the NEXT due date', () => {
    const card = root.querySelectorAll('.ui-stat')[1];
    assert.match(card.textContent ?? '', /2,500/);
    assert.match(card.textContent ?? '', /শেষ তারিখ/);
  });

  test('an overdue bill reads differently from one merely due', async () => {
    const r = await mount({ ...HOME, fees: { outstanding: 2500, earliestDue: '2026-07-15', overdueCount: 2 } });
    const card = r.querySelectorAll('.ui-stat')[1];
    // The P2 stat card's tones are the palette's semantic set — there is no
    // `danger` step, and overdue takes `warn`. That is a rename, not a
    // loosening: the property this test exists to guard is that an overdue
    // bill READS differently, and F-812 requires that difference to be in
    // words rather than in a tint. So the words are what is asserted.
    assert.equal(card.querySelector('.ui-stat-glyph')?.getAttribute('data-tone'), 'warn');
    assert.match(card.textContent ?? '', /২টি বিল সময় পেরিয়েছে/);
    // …and demonstrably different from the merely-due wording.
    assert.doesNotMatch(card.textContent ?? '', /শেষ তারিখ/);
  });

  test('nothing owed is stated as good news, not as an empty card', async () => {
    const r = await mount({ ...HOME, fees: { outstanding: 0, earliestDue: null, overdueCount: 0 } });
    const card = r.querySelectorAll('.ui-stat')[1];
    assert.match(card.textContent ?? '', /✓ বকেয়া নেই/);
    assert.match(card.textContent ?? '', /সব পরিশোধিত/);
  });

  test('the rank is never shown without its cohort', () => {
    // "৭" alone is meaningless; "৭/৫২" is a fact. §9.1 draws it that way.
    // The GPA and the rank are the result card's subtitle now; the rule they
    // guard is unchanged — a rank is never shown without its cohort.
    assert.match(root.querySelector('.ui-card-sub')?.textContent ?? '',
                 /GPA 4\.56 · মেধাক্রম ৭\/৫২/);
  });

  test('no published result means no result card at all', async () => {
    const r = await mount({ ...HOME, result: null });
    assert.equal(r.querySelector('.ui-card-sub'), null,
                 'an empty results card would read as "your child has no marks"');
  });

  test('payment is one tap from home', () => {
    const cta = root.querySelector('.ward-cta button') as HTMLButtonElement;
    assert.ok(cta);
    assert.equal(cta.disabled, false);
    assert.match(cta.textContent ?? '', /ফি পরিশোধ করুন/);
  });

  test('with nothing owed the same control offers receipts instead', async () => {
    const r = await mount({ ...HOME, fees: { outstanding: 0, earliestDue: null, overdueCount: 0 } });
    assert.match(r.querySelector('.ward-cta button')?.textContent ?? '', /ফি ও রসিদ দেখুন/);
  });

  test('a day with no attendance taken says so rather than showing absent', async () => {
    // Silence is not absence. Reporting an unmarked register as "absent"
    // is how a guardian ends up phoning the school about nothing.
    const r = await mount({ ...HOME, attendance: { ...HOME.attendance, todayStatus: null } });
    assert.match(r.querySelectorAll('.ui-stat')[0].textContent ?? '', /আজ হাজিরা নেওয়া হয়নি/);
  });
});

describe('switching children', () => {
  test('choosing the other child refetches for that child', async () => {
    const seen: string[] = [];
    const root = await mount(HOME, [ANIKA, BIJOY], seen);
    seen.length = 0;

    ([...root.querySelectorAll('.ui-child-strip .ui-child-opt')][1] as HTMLButtonElement).click();
    for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0));

    assert.ok(seen.some((u) => u.includes('studentId=s-bijoy')),
              'the request names the child that was chosen');
  });

  test('the switcher stays on screen while the new child loads', async () => {
    const root = await mount(HOME);
    ([...root.querySelectorAll('.ui-child-strip .ui-child-opt')][1] as HTMLButtonElement).click();
    // Synchronously after the click, before any fetch resolves.
    assert.ok(root.querySelector('.ui-child-strip'),
              '§9.1 calls this the single most-used control here');
    assert.ok(root.querySelector('[aria-busy=true]'), 'and a skeleton, not a blank screen');
  });
});

describe('when the network is gone', () => {
  test('cached data is shown under a banner rather than an error page', async () => {
    await mount(HOME);   // primes the cache

    const root = dom.window.document.getElementById('root') as HTMLElement;
    root.textContent = '';
    new GuardianView({
      root, doc: dom.window.document,
      auth: { authedFetch: async () => { throw new Error('offline'); } } as never,
    });
    for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0));

    assert.match(root.textContent ?? '', /অফলাইন/);
    // Last week's attendance is still worth reading, and the balance
    // changes slowly.
    assert.match(root.textContent ?? '', /আনিকা রহমান/);
    assert.match(root.textContent ?? '', /উপস্থিত/);
  });

  test('with no cache at all it offers a retry, not a blank screen', async () => {
    localStorage.clear();
    const root = dom.window.document.getElementById('root') as HTMLElement;
    root.textContent = '';
    new GuardianView({
      root, doc: dom.window.document,
      auth: { authedFetch: async () => { throw new Error('offline'); } } as never,
    });
    for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0));

    // The message comes from the shared `humanError` now and names the
    // cause — "no internet connection" rather than "could not load", which is
    // the difference between a person waiting and a person giving up. What
    // this test guards is that SOMETHING is said and a retry is offered.
    assert.match(root.textContent ?? '', /সংযোগ|সমস্যা/);
    assert.ok([...root.querySelectorAll('button')]
      .some((b) => /আবার চেষ্টা/.test(b.textContent ?? '')), 'no retry offered');
    assert.ok([...root.querySelectorAll('button')].some((b) => b.textContent === 'আবার চেষ্টা করুন'));
  });
});
