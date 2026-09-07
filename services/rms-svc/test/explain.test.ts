/**
 * P9-4 — the explanation model, and the rule that makes it worth reading.
 *
 * `explain()` is pure, so every rule can be exercised against a hand-written
 * failure rather than against whatever the solver happened to produce. That
 * matters more here than anywhere else in the phase: the thing being tested
 * is a set of CLAIMS, and a claim is only as good as the evidence behind it.
 *
 * The four properties:
 *
 *   1. Same shortfall, different wall, different errand. `no_free_slot` is
 *      one code for four problems — the section was full, the teacher was
 *      teaching, the teacher had blocked the hour, the room was taken — and
 *      each sends a coordinator somewhere else. The tally decides which.
 *
 *   2. No claim without a counter. Where the solver recorded nothing, the
 *      explanation says less rather than guessing at the commonest cause.
 *
 *   3. No suggestion that cannot be acted on. "Use one of the other labs" is
 *      offered only to a school that HAS other labs.
 *
 *   4. A warning does not read as a failure. §4 is explicit, and the
 *      severity is what the screen colours by.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { explain, severityCounts, type ExplainInput } from '../src/explain.ts';
import type { BlockerTally } from '../src/solve.ts';
import {
  capabilityLabelBn, scrubMachineText, shiftLabelBn, unplacedReasonBn,
  possessiveBn,
} from '../src/presentation.ts';

const tally = (over: Partial<BlockerTally> = {}): BlockerTally => ({
  candidates: 35, sectionBusy: 0, teacherBusy: 0, teacherUnavailable: 0,
  noRoom: 0, crossShift: 0, crossShiftNames: [], ...over,
});

const demand = (over: Partial<ExplainInput['unplaced'][number]> = {}) => ({
  sectionId: 's1', subjectId: 'j1',
  sectionName: 'নবম — ক', subjectBn: 'জীববিজ্ঞান', teacherBn: 'রফিক স্যার',
  required: 4, placed: 3, missing: 1, reason: 'no_free_slot',
  ...over,
});

const input = (over: Partial<ExplainInput> = {}): ExplainInput => ({
  unplaced: [], soft: [], shortages: [], notEvaluated: [],
  setupWarnings: [], hardConflicts: 0, ...over,
});

describe('P9-4 — explaining a routine', () => {
  test('THE ONE THAT MATTERS — one shortfall, four walls, four errands', () => {
    const walls = [
      { t: tally({ teacherBusy: 30 }), category: 'teacher_conflict' },
      { t: tally({ teacherUnavailable: 30 }), category: 'availability_conflict' },
      { t: tally({ sectionBusy: 30 }), category: 'section_conflict' },
      { t: tally({ noRoom: 30 }), category: 'room_conflict' },
    ] as const;

    for (const w of walls) {
      const [item] = explain(input({
        unplaced: [demand({ blockers: w.t, capableRooms: 2 })],
      }));
      assert.equal(item.category, w.category,
        `${JSON.stringify(w.t)} → ${item.category}, expected ${w.category}`);
      assert.ok(item.suggestions.length > 0, 'every one of the four has a next step');
      // The evidence is the counter, and it is on screen.
      assert.match(item.whyBn, /৩০/, `the count must be in the sentence: ${item.whyBn}`);
      assert.match(item.whyBn, /৩৫/, 'and so must the denominator');
    }
  });

  test('a section busy in EVERY hour is a capacity problem, not a clash', () => {
    // 35 of 35 means the week is full, which is a different conversation
    // from "the section was busy in most hours" — one asks for a longer day,
    // the other asks for a lesson to be moved.
    const [item] = explain(input({
      unplaced: [demand({ blockers: tally({ sectionBusy: 35 }) })],
    }));
    assert.equal(item.category, 'insufficient_slots');
    assert.match(item.whatBn, /সব পিরিয়ড ইতিমধ্যে ভরে গেছে/);
    assert.ok(item.suggestions.some((s) => /আরও একটি পিরিয়ড যোগ/.test(s.textBn)),
      'the honest fix is a longer day or a smaller curriculum');
  });

  test('NO CLAIM WITHOUT A COUNTER — an empty tally explains less, not more', () => {
    const [item] = explain(input({
      unplaced: [demand({ blockers: tally({ candidates: 0 }) })],
    }));
    assert.equal(item.category, 'insufficient_slots');
    assert.match(item.whyBn, /নির্ণয় করা যায়নি/,
      'saying "the teacher was probably busy" would be the guess §8 forbids');
    assert.deepEqual(item.suggestions, [],
      'and a suggestion with no evidence behind it is worse than none');
  });

  test('and a missing tally altogether is treated the same way', () => {
    const [item] = explain(input({ unplaced: [demand({ blockers: undefined })] }));
    assert.equal(item.category, 'insufficient_slots');
    assert.deepEqual(item.suggestions, []);
  });

  test('NO SUGGESTION THAT CANNOT BE ACTED ON — one lab versus four', () => {
    const one = explain(input({
      unplaced: [demand({ reason: 'no_free_capable_room', capableRooms: 1,
                          blockers: tally({ noRoom: 30 }) })],
    }))[0];
    assert.ok(one.suggestions.some((s) => /আরও একটি উপযুক্ত কক্ষ যোগ/.test(s.textBn)),
      'a school with one lab must be told to get another, not to shuffle between them');
    assert.ok(!one.suggestions.some((s) => /মধ্যে কোনটিতে কখন/.test(s.textBn)));

    const four = explain(input({
      unplaced: [demand({ reason: 'no_free_capable_room', capableRooms: 4,
                          blockers: tally({ noRoom: 30 }) })],
    }))[0];
    assert.ok(four.suggestions.some((s) => /মধ্যে কোনটিতে কখন/.test(s.textBn)),
      'a school with four labs has a timetable to rearrange');
    assert.match(four.suggestions[0].evidenceBn, /৪টি কক্ষ উপযুক্ত/);
  });

  test('a school with NO such room is never told to rearrange its timetable', () => {
    const [item] = explain(input({
      unplaced: [demand({ reason: 'no_capable_room', capableRooms: 0 })],
    }));
    assert.equal(item.category, 'capability_missing');
    assert.ok(item.suggestions.every((s) => !/সরান|রুটিন/.test(s.textBn)),
      'nothing about the timetable can conjure a laboratory');
    assert.ok(item.suggestions.some((s) => /কক্ষ ব্যবস্থাপনা/.test(s.textBn)));
  });

  test('CROSS-SHIFT is named only when another shift actually held it', () => {
    const crossed = explain(input({
      unplaced: [demand({
        blockers: tally({ teacherBusy: 30, crossShift: 12, crossShiftNames: ['সকাল'] }),
      })],
    }))[0];
    assert.equal(crossed.category, 'cross_shift');
    assert.match(crossed.whyBn, /সকাল/, 'the shift is named');
    assert.match(crossed.whyBn, /১২/, 'with the count that makes it checkable');

    // The same wall, with no foreign owner: an ordinary teacher clash.
    const own = explain(input({
      unplaced: [demand({ blockers: tally({ teacherBusy: 30 }) })],
    }))[0];
    assert.equal(own.category, 'teacher_conflict');
    assert.doesNotMatch(own.whyBn, /শিফট/,
      'a section colliding with its own week is not cross-shift contention');
  });

  test('a DOUBLE PERIOD that scattered is a warning, and claims no wall', () => {
    const [item] = explain(input({
      unplaced: [demand({ reason: 'no_contiguous_pair', missing: 2,
                          blockers: tally({ candidates: 0 }) })],
    }));
    assert.equal(item.severity, 'warning', 'the lesson happened — it was split');
    assert.equal(item.category, 'double_period');
    assert.doesNotMatch(item.whyBn, /০টি/,
      'reported before the hour search runs, so it must not quote a zero tally');
  });

  test('THREE SEVERITIES, and a warning does not read as a failure', () => {
    const items = explain(input({
      unplaced: [demand({ blockers: tally({ teacherBusy: 30 }) })],
      soft: [{ code: 'teacher_weekly_cap', detailBn: 'রফিক — সাপ্তাহিক ২৬ পিরিয়ড',
               causeBn: 'যোগ্য গণিত শিক্ষক কম' }],
      setupWarnings: [{ titleBn: 'শিক্ষকের সময়-সীমা',
                        detailBn: 'কারও সময়-সীমা দেওয়া হয়নি' }],
      notEvaluated: [{ ruleBn: 'কঠিন বিষয় দিনের শুরুতে',
                       whyBn: 'কাঠিন্য মাত্রা সংরক্ষিত নেই' }],
    }));
    assert.deepEqual(severityCounts(items), { error: 1, warning: 2, info: 1 });
    assert.equal(items[0].severity, 'error', 'errors lead — that is where the work is');
    assert.equal(items.at(-1)?.severity, 'info');

    const setup = items.find((i) => i.category === 'setup_gap');
    assert.equal(setup?.severity, 'warning');
    assert.match(setup?.whyBn ?? '', /ঐচ্ছিক/,
      'an optional gap must say it is optional, or a school does an afternoon of work first');
  });

  test('a soft trade keeps the solver’s own cause and invents none', () => {
    const withCause = explain(input({
      soft: [{ code: 'teacher_weekly_cap', detailBn: 'রফিক — ২৬ পিরিয়ড',
               causeBn: 'যোগ্য গণিত শিক্ষক কম' }],
    }))[0];
    assert.equal(withCause.whyBn, 'যোগ্য গণিত শিক্ষক কম');

    const without = explain(input({
      soft: [{ code: 'teacher_room_churn', detailBn: 'শিরিন — দিনে ৩ বার কক্ষ পরিবর্তন' }],
    }))[0];
    assert.match(without.whyBn, /ছাড় দিতে হয়েছে/,
      '`soft-constraints.ts` states a cause only when it computed one; so does this');
  });

  test('a HARD CONFLICT leads the list and says the routine cannot be published', () => {
    const items = explain(input({
      hardConflicts: 4,
      unplaced: [demand({ missing: 9, blockers: tally({ teacherBusy: 30 }) })],
    }));
    assert.equal(items[0].category, 'hard_conflict');
    assert.match(items[0].impactBn, /প্রকাশ করা যাবে না/);
  });

  test('the worst shortfall is at the top of the list', () => {
    const items = explain(input({
      unplaced: [
        demand({ subjectBn: 'গণিত', missing: 1, blockers: tally({ teacherBusy: 30 }) }),
        demand({ subjectBn: 'রসায়ন', missing: 6, blockers: tally({ teacherBusy: 30 }) }),
      ],
    }));
    assert.match(items[0].titleBn, /রসায়ন/,
      'a coordinator with twenty minutes should spend them at the top');
  });

  test('FORTY SECTIONS with one over-subscribed subject is ONE finding', () => {
    // An 80-section fixture produced 1,516 findings in the browser: forty
    // rows saying the same thing about the same subject, which is not a list
    // anyone can work down and is close to a megabyte on a 2G connection.
    const sections = Array.from({ length: 40 }, (_, i) => demand({
      sectionId: `s${i}`, sectionName: `প্রথম — ${i}`, subjectBn: 'চারু ও কারুকলা',
      missing: 4, blockers: tally({ teacherBusy: 30 }),
    }));
    const items = explain(input({ unplaced: sections }));
    assert.equal(items.length, 1, 'one problem, one fix, one row');

    const [g] = items;
    assert.match(g.titleBn, /৪০টি শাখায় মোট ১৬০টি পিরিয়ড বসেনি/,
      'and the totals must add up to what the group replaced');
    // The sections are still named — a coordinator needs to know which.
    assert.equal(g.affectedBn.length, 13, 'twelve named, then a count');
    assert.match(g.affectedBn.at(-1) ?? '', /আরও ২৮টি শাখা/);
    assert.match(g.whyBn, /একই বাধা/,
      'one representative’s evidence, labelled as one — not presented as all forty');
    assert.equal(g.severity, 'error');
  });

  test('but two DIFFERENT walls under one subject stay apart', () => {
    // Same subject, different causes: grouping them would produce a sentence
    // that is true of neither.
    const items = explain(input({
      unplaced: [
        ...Array.from({ length: 3 }, (_, i) => demand({
          sectionId: `a${i}`, subjectBn: 'গণিত', blockers: tally({ teacherBusy: 30 }) })),
        ...Array.from({ length: 3 }, (_, i) => demand({
          sectionId: `b${i}`, subjectBn: 'গণিত',
          blockers: tally({ teacherUnavailable: 30 }) })),
      ],
    }));
    assert.equal(items.length, 2);
    assert.deepEqual(items.map((i) => i.category).sort(),
      ['availability_conflict', 'teacher_conflict']);
  });

  test('two of a kind are shown in full — grouping starts at three', () => {
    const items = explain(input({
      unplaced: Array.from({ length: 2 }, (_, i) => demand({
        sectionId: `s${i}`, sectionName: `নবম — ${i}`,
        blockers: tally({ teacherBusy: 30 }) })),
    }));
    assert.equal(items.length, 2, 'two rows are readable; forty are not');
  });

  test('a clean run explains nothing, which is the point', () => {
    assert.deepEqual(explain(input()), []);
    assert.deepEqual(severityCounts([]), { error: 0, warning: 0, info: 0 });
  });

  test('NO MACHINE IDENTIFIER survives into any sentence', () => {
    const items = explain(input({
      hardConflicts: 2,
      unplaced: [
        demand({ reason: 'no_capable_room', capableRooms: 0 }),
        demand({ reason: 'no_free_capable_room', capableRooms: 3,
                 blockers: tally({ noRoom: 20, crossShift: 5, crossShiftNames: ['দিবা'] }) }),
        demand({ blockers: tally({ teacherUnavailable: 30 }) }),
      ],
      soft: [{ code: 'teacher_daily_cap', detailBn: 'সালমা — দিনে ৮ পিরিয়ড' }],
      notEvaluated: [{ ruleBn: 'কঠিন বিষয়', whyBn: 'তথ্য নেই' }],
    }));
    const text = items.flatMap((i) => [
      i.titleBn, i.whatBn, i.whyBn, i.currentBn, i.impactBn,
      ...i.affectedBn, ...i.suggestions.flatMap((s) => [s.textBn, s.evidenceBn]),
    ]).join(' | ');

    assert.doesNotMatch(text, /[a-z]+_[a-z]+/, `snake_case reached a sentence: ${text}`);
    assert.doesNotMatch(text, /[0-9a-f]{8}-[0-9a-f]{4}/, 'a uuid reached a sentence');
    assert.doesNotMatch(text, /undefined|null|NaN/, 'a missing value reached a sentence');
    // A Latin numeral in front of a Bangla counter word is the failure
    // `bangla-numerals.test.ts` exists to catch, applied here to text it
    // cannot see because this module composes it at runtime.
    assert.doesNotMatch(text, /[0-9]+\s*টি/, 'a Latin numeral before টি');
  });

  test('every item carries all four drawer sections, always', () => {
    // §6's panel renders কারণ → বর্তমান অবস্থা → প্রভাব → সম্ভাব্য সমাধান.
    // An item missing one of the first three renders an empty heading.
    const items = explain(input({
      hardConflicts: 1,
      unplaced: [demand({ blockers: tally({ teacherBusy: 30 }) }),
                 demand({ reason: 'no_contiguous_pair', blockers: tally({ candidates: 0 }) })],
      shortages: [{ subjectsBn: ['রসায়ন'], detailBn: 'রসায়ন — কক্ষ কম',
                    capableRooms: 1, freePeriods: 8, demandedPeriods: 12 }],
      soft: [{ code: 'teacher_no_free_day', detailBn: 'রফিক — কোনো ফাঁকা দিন নেই' }],
      setupWarnings: [{ titleBn: 'সময়-সীমা', detailBn: 'দেওয়া হয়নি' }],
      notEvaluated: [{ ruleBn: 'কঠিন বিষয়', whyBn: 'তথ্য নেই' }],
    }));
    assert.equal(items.length, 7);
    for (const i of items) {
      for (const [field, value] of Object.entries({
        titleBn: i.titleBn, whatBn: i.whatBn, whyBn: i.whyBn,
        currentBn: i.currentBn, impactBn: i.impactBn,
      })) {
        assert.notEqual(value.trim(), '', `${i.id} has an empty ${field}`);
      }
      assert.ok(i.id.length > 0, 'a drawer must be reopenable on the same item');
    }
    // Ids are unique, or reopening a drawer lands on the wrong row.
    assert.equal(new Set(items.map((i) => i.id)).size, items.length);
  });
});

/**
 * P9-4 §9 — the audit, as a test.
 *
 * `rooms.capabilities` is `text[]` with no vocabulary: whatever an IT admin
 * types is a capability. So the danger is not the four codes we know about,
 * it is the fifth one nobody anticipated falling through a lookup table into
 * a sentence. These pin the fallback, which is the part that matters.
 */
describe('P9-4 §9 — no machine identifier reaches a person', () => {
  test('THE ONE THAT MATTERS — an unknown capability degrades, never leaks', () => {
    assert.equal(capabilityLabelBn('computer_lab'), 'কম্পিউটার ল্যাব');
    // The case the map cannot cover, and the reason the map is not enough.
    assert.equal(capabilityLabelBn('senior_science_annexe'), 'বিশেষ কক্ষ');
    assert.equal(capabilityLabelBn(''), 'বিশেষ কক্ষ');
    assert.equal(capabilityLabelBn(null), 'বিশেষ কক্ষ');
    assert.equal(capabilityLabelBn(undefined), 'বিশেষ কক্ষ');
  });

  test('a sentence stored months ago is repaired on the way out', () => {
    // Written by `solve.ts` into `routines.soft_violations`. Fixing the
    // writer cannot fix a row that already exists.
    const stored = '"computer_lab" কক্ষে ৮০টি পিরিয়ড দরকার; ৩টি কক্ষে ৭৫টি খালি';
    const out = scrubMachineText(stored);
    assert.match(out, /কম্পিউটার ল্যাব/);
    assert.doesNotMatch(out, /computer_lab/);
    assert.doesNotMatch(out, /"/, 'the quotes go with the code — "বিশেষ কক্ষ" reads like a name');
    assert.match(out, /৮০টি পিরিয়ড দরকার/, 'and the rest of the sentence survives');
  });

  test('and so is an unknown one, a uuid, and a screaming enum', () => {
    assert.match(scrubMachineText('"senior_annexe" কক্ষে জায়গা নেই'), /বিশেষ কক্ষ/);
    assert.doesNotMatch(
      scrubMachineText('slot 7c930000-0000-4000-8000-0000000000a1 blocked'),
      /[0-9a-f]{8}-/);
    assert.doesNotMatch(scrubMachineText('NO_FREE_SLOT ঘটেছে'), /NO_FREE_SLOT/);
  });

  test('the scrubber is not sticky', () => {
    // A `/g` regex holds `lastIndex` between calls, so a shared one answers
    // true, then false, then true for the same input. Two identical calls
    // must agree, and the third must too.
    const s = '"computer_lab" কক্ষ';
    const a = scrubMachineText(s);
    assert.equal(scrubMachineText(s), a);
    assert.equal(scrubMachineText(s), a);
  });

  test('ordinary Bangla and a school’s own room codes are left alone', () => {
    // `rooms.code` is the school's own label — "R-1", "ভবন-২". Scrubbing it
    // would be the opposite failure: removing information a person needs.
    for (const text of [
      'নবম — ক শাখায় জীববিজ্ঞান বসানো যায়নি',
      'কক্ষ R-1 তখন ব্যস্ত ছিল',
      'ভবন-২ এর ৩ নম্বর কক্ষ',
    ]) {
      assert.equal(scrubMachineText(text), text, text);
    }
  });

  test('the shift vocabulary is closed, so an unknown one is not hidden', () => {
    assert.equal(shiftLabelBn('morning'), 'সকাল');
    // Deliberately NOT 'বিশেষ শিফট': `shift_code` is an enum, so a value
    // outside it is a schema change somebody must notice, not a school's
    // free text.
    assert.equal(shiftLabelBn('twilight'), 'twilight');
  });

  test('every unplaced reason has a sentence, and the unknown one says so', () => {
    for (const code of ['no_free_slot', 'no_capable_room',
                        'no_free_capable_room', 'no_contiguous_pair']) {
      const s = unplacedReasonBn(code);
      assert.doesNotMatch(s, /[a-z]+_[a-z]+/, `${code} leaked its own name`);
      assert.ok(s.length > 10, `${code} needs a sentence, not a word`);
    }
    assert.equal(unplacedReasonBn('something_new'), 'কারণ জানা যায়নি');
  });
});

/**
 * P9-6 — a name joined to a noun, in Bangla.
 *
 * "রফিক স্যার ক্লাসগুলো" is not a sentence, and a Bangla reader notices the
 * missing genitive the way an English reader notices "Rahim classes". The
 * undo button says this out loud, so it has to be right.
 */
describe('P9-6 — the Bangla genitive', () => {
  test('THE ONE THAT MATTERS — consonant takes ের, vowel takes র', () => {
    assert.equal(possessiveBn('রফিক স্যার'), 'রফিক স্যারের');
    assert.equal(possessiveBn('সালমা'), 'সালমার');
    assert.equal(possessiveBn('ম্যাডাম'), 'ম্যাডামের');
    assert.equal(possessiveBn('রুবি'), 'রুবির');
  });

  test('an empty or spacey name does not produce a dangling suffix', () => {
    assert.equal(possessiveBn(''), '');
    assert.equal(possessiveBn('   '), '');
    assert.equal(possessiveBn(' রফিক '), 'রফিকের', 'trimmed before the rule is applied');
  });

  test('and no Latin letter is treated as a Bangla vowel', () => {
    // The first draft's vowel set began with a Latin 'a', which would have
    // given an English-transliterated name the wrong ending.
    assert.equal(possessiveBn('Rahima'), 'Rahimaের',
      'a Latin name is not something this rule claims to handle — and it must '
      + 'not silently pick the vowel branch because of a stray character');
  });
});
