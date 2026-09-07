/**
 * Why the routine came out the way it did.  (P9-4)
 *
 * F-503 already answers "why THIS teacher in THIS slot" for a placed lesson
 * (`api/generation.ts:explainSlot`), and F-505 already lists every soft
 * constraint traded away (`soft-constraints.ts`). Neither answers the
 * question a coordinator actually arrives with, which is about the lessons
 * that are NOT there: what failed, why, who is involved, and what to change.
 *
 * ── Claim → evidence, with no exceptions ──────────────────────────────────
 * Every sentence below is emitted only when a counter supports it. The
 * solver now records which guard turned each candidate hour away
 * (`BlockerTally`), so "the teacher was busy" is not a guess about the
 * commonest cause — it is 34 of 35 hours, and where the tally is empty this
 * file says less rather than more.
 *
 * That rule is what makes the suggestions safe. "Ask this teacher to free an
 * hour" is only offered when the teacher was in fact the wall; "use another
 * room" is only offered when a second capable room exists. A plausible
 * suggestion that turns out to be impossible costs a coordinator an
 * afternoon and costs the product their trust in everything else on the
 * screen.
 *
 * ── Three severities, and they are not decoration ─────────────────────────
 *   error   — the curriculum is not fully delivered, or the routine cannot
 *             be published. Someone must act.
 *   warning — it will work and it could be better. Nobody must act today.
 *   info    — something this build did not check, said out loud.
 *
 * §4 is explicit that a warning must not look like a failure. A school with
 * no teacher availability recorded gets a perfectly good first routine, and
 * telling them so in red would send them off to do an afternoon of optional
 * data entry before they had seen anything work.
 *
 * ── Pure ──────────────────────────────────────────────────────────────────
 * No database, no clock, no ids resolved here. It takes rows that have
 * already been given names and returns sentences, which is what lets the
 * rules be tested against a hand-written failure rather than against
 * whatever the solver happened to produce that day.
 */
import type { BlockerTally } from './solve.ts';

export type Severity = 'error' | 'warning' | 'info';

/**
 * The eight failure shapes a coordinator can act on, plus the two that
 * describe the report itself.
 *
 * They are separate because the ACTION is separate. `capability_missing`
 * means the school has no such room and someone must build or re-label one;
 * `room_conflict` means it has one and the timetable is fighting over it.
 * Merging them would produce a sentence that is true and useless.
 */
export type Category =
  | 'teacher_conflict'
  | 'section_conflict'
  | 'room_conflict'
  | 'availability_conflict'
  | 'capability_missing'
  | 'insufficient_slots'
  | 'cross_shift'
  | 'double_period'
  | 'hard_conflict'
  | 'setup_gap'
  | 'soft_tradeoff'
  | 'not_evaluated';

export interface Suggestion {
  textBn: string;
  /** Why this is worth trying HERE, from the same counters. Never a guess. */
  evidenceBn: string;
}

export interface Explanation {
  /** Stable within one report, so a drawer can be reopened on the same item. */
  id: string;
  severity: Severity;
  category: Category;
  /** The one line the list shows. */
  titleBn: string;
  /** কারণ — what happened. */
  whatBn: string;
  /** Why, in the terms the counters support. */
  whyBn: string;
  /** Who and what is involved: the section, the subject, the teacher, a room. */
  affectedBn: string[];
  /** বর্তমান অবস্থা — the numbers as they stand. */
  currentBn: string;
  /** প্রভাব — what it means for the school if nothing changes. */
  impactBn: string;
  /** সম্ভাব্য সমাধান. Empty when nothing can be honestly suggested. */
  suggestions: Suggestion[];
}

const BN_DIGITS = '০১২৩৪৫৬৭৮৯';
const bn = (n: number): string => String(n).replace(/\d/g, (d) => BN_DIGITS[Number(d)]);

/** An unplaced demand after `generate.ts` has put names to its ids. */
export interface NamedUnplacedInput {
  sectionId: string;
  subjectId: string;
  sectionName: string;
  subjectBn: string;
  teacherBn: string | null;
  required: number;
  placed: number;
  missing: number;
  reason: string;
  /** How many rooms in the school carry the capability this subject needs. */
  capableRooms?: number;
  blockers?: BlockerTally;
}

export interface ExplainInput {
  unplaced: NamedUnplacedInput[];
  soft: Array<{ code: string; detailBn: string; causeBn?: string }>;
  shortages: Array<{ subjectsBn: string[]; detailBn: string;
                     capableRooms: number; freePeriods: number;
                     demandedPeriods: number }>;
  notEvaluated: Array<{ ruleBn: string; whyBn: string }>;
  /** Readiness steps the wizard already marked `warn`. Not recomputed here. */
  setupWarnings: Array<{ titleBn: string; detailBn: string }>;
  /** Counted from the stored rows by `generate.ts`. Never assumed. */
  hardConflicts: number;
}

/**
 * The blocker that actually stopped this demand, or null.
 *
 * Null is a real answer and is used: a `no_contiguous_pair` finding is
 * reported before the hour-by-hour search ever runs, so its tally is all
 * zeros, and inventing a dominant cause from zeros would be exactly the
 * speculation §8 forbids.
 */
function dominant(t: BlockerTally | undefined):
  { kind: 'section' | 'teacher' | 'unavailable' | 'room'; count: number } | null {
  if (!t || t.candidates === 0) return null;
  const ranked = [
    { kind: 'teacher' as const, count: t.teacherBusy },
    { kind: 'room' as const, count: t.noRoom },
    { kind: 'unavailable' as const, count: t.teacherUnavailable },
    { kind: 'section' as const, count: t.sectionBusy },
  ].filter((x) => x.count > 0).sort((a, b) => b.count - a.count);
  return ranked[0] ?? null;
}

/** "৩৪টির মধ্যে ৩০টি সময়ে" — the denominator is what makes it checkable. */
function share(count: number, of: number): string {
  return `${bn(of)}টি সম্ভাব্য সময়ের মধ্যে ${bn(count)}টিতে`;
}

function unplacedExplanation(u: NamedUnplacedInput, index: number): Explanation {
  const t = u.blockers;
  const who = [u.sectionName, u.subjectBn, ...(u.teacherBn ? [u.teacherBn] : [])];
  const currentBn = `${bn(u.required)}টির মধ্যে ${bn(u.placed)}টি পিরিয়ড বসানো হয়েছে`
                  + ` — ${bn(u.missing)}টি বাকি`;
  const impactBn = `${u.sectionName}-এ ${u.subjectBn} সপ্তাহে ${bn(u.missing)}টি পিরিয়ড কম পড়বে।`;
  const titleBn = `${u.sectionName} · ${u.subjectBn} — ${bn(u.missing)}টি পিরিয়ড বসেনি`;
  const base = {
    id: `unplaced:${u.sectionId}:${u.subjectId}:${index}`,
    severity: 'error' as const,
    titleBn,
    affectedBn: who,
    currentBn,
    impactBn,
  };

  // The school owns no room of the required kind. Nothing about the
  // timetable can fix that, so nothing about the timetable is suggested.
  if (u.reason === 'no_capable_room') {
    return {
      ...base,
      category: 'capability_missing',
      whatBn: `${u.subjectBn} এর জন্য বিশেষ কক্ষ দরকার, কিন্তু প্রতিষ্ঠানে সেরকম `
            + 'কোনো কক্ষ নিবন্ধিত নেই।',
      whyBn: 'উপযুক্ত কক্ষের সংখ্যা শূন্য — তাই কোনো সময়েই এই ক্লাস বসানো যায়নি।',
      suggestions: [
        { textBn: 'কক্ষ ব্যবস্থাপনায় গিয়ে উপযুক্ত কক্ষটি যোগ করুন বা বিদ্যমান কক্ষে '
                + 'সেই সুবিধা যুক্ত করুন',
          evidenceBn: 'এই ধরনের কক্ষ এখন শূন্য' },
        { textBn: `${u.subjectBn} এর জন্য বিশেষ কক্ষের শর্ত তুলে দিন`,
          evidenceBn: 'শর্তটি বিষয়ের সেটিংসে দেওয়া আছে' },
      ],
    };
  }

  // A required contiguous pair ran as scattered singles. Reported before the
  // hour search, so there is no tally and none is pretended.
  if (u.reason === 'no_contiguous_pair') {
    return {
      ...base,
      severity: 'warning',
      category: 'double_period',
      titleBn: `${u.sectionName} · ${u.subjectBn} — পরপর দুই পিরিয়ড পাওয়া যায়নি`,
      whatBn: `${u.subjectBn} এর ${bn(u.missing)}টি জোড়া পিরিয়ড পরপর বসানো যায়নি; `
            + 'আলাদা আলাদা পিরিয়ড হিসেবে বসানো হয়েছে।',
      whyBn: 'সপ্তাহের কোনো দিনেই পাশাপাশি দুটি পিরিয়ড একসাথে খালি পাওয়া যায়নি।',
      currentBn: `${bn(u.missing)}টি জোড়া আলাদা পিরিয়ড হয়ে গেছে`,
      impactBn: 'ব্যবহারিক ক্লাস দুই ভাগে হলে সরঞ্জাম গোছাতেই সময় চলে যায়।',
      suggestions: [
        { textBn: 'ঘণ্টার সময়সূচিতে বিরতির অবস্থান বদলে পরপর দুটি পিরিয়ড তৈরি করুন',
          evidenceBn: 'জোড়া পিরিয়ড বিরতির দুই পাশে পড়লে একসাথে বসানো যায় না' },
      ],
    };
  }

  const d = dominant(t);

  // The room exists and is full. Cross-shift is a sub-case with a different
  // errand, so it is separated only when the counters say it happened.
  if (u.reason === 'no_free_capable_room' || d?.kind === 'room') {
    const crossed = (t?.crossShift ?? 0) > 0 && (t?.crossShiftNames.length ?? 0) > 0;
    const suggestions: Suggestion[] = [];
    if ((u.capableRooms ?? 0) > 1) {
      suggestions.push({
        textBn: 'উপযুক্ত কক্ষগুলোর মধ্যে কোনটিতে কখন ক্লাস আছে দেখে একটি ক্লাস সরান',
        evidenceBn: `এই বিষয়ের জন্য ${bn(u.capableRooms ?? 0)}টি কক্ষ উপযুক্ত`,
      });
    } else {
      suggestions.push({
        textBn: 'আরও একটি উপযুক্ত কক্ষ যোগ করুন',
        evidenceBn: 'এই বিষয়ের জন্য উপযুক্ত কক্ষ মাত্র একটি',
      });
    }
    if (crossed) {
      suggestions.push({
        textBn: `${(t as BlockerTally).crossShiftNames.join(' ও ')} শিফটের সাথে কক্ষ `
              + 'ভাগাভাগির সময় বদলান',
        evidenceBn: `${bn((t as BlockerTally).crossShift)}টি সময়ে অন্য শিফট কক্ষটি ব্যবহার করছিল`,
      });
    }
    return {
      ...base,
      category: crossed ? 'cross_shift' : 'room_conflict',
      whatBn: `${u.subjectBn} এর জন্য উপযুক্ত কক্ষ দরকার, কিন্তু যে সময়গুলোতে `
            + 'শাখা ও শিক্ষক দুজনেই মুক্ত ছিলেন, সেই সময়ে কক্ষটি খালি ছিল না।',
      whyBn: crossed
        ? `${(t as BlockerTally).crossShiftNames.join(' ও ')} শিফটের রুটিন ওই সময়ে `
          + `কক্ষটি ধরে রেখেছিল — ${share((t as BlockerTally).crossShift,
              (t as BlockerTally).candidates)} এটিই বাধা ছিল।`
        : t ? `${share(t.noRoom, t.candidates)} উপযুক্ত কক্ষ ব্যস্ত ছিল।`
            : 'উপযুক্ত কক্ষ ওই সময়ে ব্যস্ত ছিল।',
      suggestions,
    };
  }

  // Nothing was ever examined — the search did not run. Say only that.
  if (!d) {
    return {
      ...base,
      category: 'insufficient_slots',
      whatBn: `${u.sectionName}-এ ${u.subjectBn} এর ${bn(u.missing)}টি পিরিয়ড বসানো যায়নি।`,
      whyBn: 'কোন বাধায় আটকেছে তা এই রানে আলাদা করে নির্ণয় করা যায়নি।',
      suggestions: [],
    };
  }

  if (d.kind === 'unavailable') {
    return {
      ...base,
      category: 'availability_conflict',
      whatBn: `${u.teacherBn ?? 'নির্বাচিত শিক্ষক'} যে সময়গুলোতে পড়াতে পারবেন না বলে `
            + 'জানিয়েছেন, বাকি সময়ে শাখাটি মুক্ত ছিল না।',
      whyBn: `${share(d.count, (t as BlockerTally).candidates)} শিক্ষকের `
           + 'দেওয়া সময়-সীমা বাধা হয়েছে।',
      suggestions: [
        { textBn: `${u.teacherBn ?? 'শিক্ষকের'} সময়-সীমা আবার দেখে নিন — কোনো একটি `
                + 'সময় খুলে দিলে এই পিরিয়ডটি বসে যাবে',
          evidenceBn: `${bn(d.count)}টি সময়ে সময়-সীমাই একমাত্র বাধা ছিল` },
        { textBn: 'এই বিষয়ের জন্য অন্য একজন শিক্ষক নির্ধারণ করুন',
          evidenceBn: 'শিক্ষক বদলালে সময়-সীমাও বদলে যায়' },
      ],
    };
  }

  if (d.kind === 'section') {
    const full = d.count === (t as BlockerTally).candidates;
    return {
      ...base,
      category: full ? 'insufficient_slots' : 'section_conflict',
      whatBn: full
        ? `${u.sectionName}-এর সপ্তাহের সব পিরিয়ড ইতিমধ্যে ভরে গেছে।`
        : `${u.sectionName} যে সময়গুলোতে মুক্ত ছিল, সেখানে অন্য বাধা ছিল।`,
      whyBn: `${share(d.count, (t as BlockerTally).candidates)} শাখাটির অন্য ক্লাস চলছিল।`,
      impactBn: full
        ? `${u.sectionName}-এর সাপ্তাহিক চাহিদা সপ্তাহে যত পিরিয়ড আছে তার চেয়ে বেশি।`
        : impactBn,
      suggestions: full
        ? [
            { textBn: 'ঘণ্টার সময়সূচিতে দিনে আরও একটি পিরিয়ড যোগ করুন',
              evidenceBn: 'সপ্তাহের প্রতিটি সম্ভাব্য সময়েই শাখাটি ব্যস্ত ছিল' },
            { textBn: 'বিষয়ভিত্তিক সাপ্তাহিক পিরিয়ড সংখ্যা কমিয়ে দিন',
              evidenceBn: 'মোট চাহিদা সপ্তাহের ধারণক্ষমতার চেয়ে বেশি' },
          ]
        : [
            { textBn: 'এই শাখার অন্য কোনো বিষয়ের একটি পিরিয়ড সরিয়ে জায়গা করুন',
              evidenceBn: `${bn(d.count)}টি সময়ে শাখাটির অন্য ক্লাস ছিল` },
          ],
    };
  }

  // Teacher busy — the commonest, and the one §2's example is about.
  const crossed = (t?.crossShift ?? 0) > 0 && (t?.crossShiftNames.length ?? 0) > 0;
  const suggestions: Suggestion[] = [
    { textBn: `${u.teacherBn ?? 'এই শিক্ষকের'} অন্য কোনো শাখার একটি পিরিয়ড সরিয়ে `
            + 'এই সময়টি খালি করুন',
      evidenceBn: `${bn(d.count)}টি সময়ে তিনি অন্যত্র ক্লাস নিচ্ছিলেন` },
    { textBn: 'এই বিষয়ের জন্য আরও একজন শিক্ষক নির্ধারণ করুন',
      evidenceBn: 'একজন শিক্ষক একসাথে দুই জায়গায় থাকতে পারেন না' },
  ];
  if (crossed) {
    suggestions.push({
      textBn: `${(t as BlockerTally).crossShiftNames.join(' ও ')} শিফটে এই শিক্ষকের `
            + 'ক্লাস কমান',
      evidenceBn: `${bn((t as BlockerTally).crossShift)}টি সময়ে তিনি অন্য শিফটে ব্যস্ত ছিলেন`,
    });
  }
  return {
    ...base,
    category: crossed ? 'cross_shift' : 'teacher_conflict',
    whatBn: `${u.sectionName}-এ ${u.subjectBn} এর আরও ${bn(u.missing)}টি পিরিয়ড প্রয়োজন। `
          + `${u.teacherBn ?? 'নির্বাচিত শিক্ষক'} উপযুক্ত সব সময়েই ব্যস্ত ছিলেন।`,
    whyBn: crossed
      ? `${share(d.count, (t as BlockerTally).candidates)} তিনি অন্যত্র পড়াচ্ছিলেন, `
        + `যার ${bn((t as BlockerTally).crossShift)}টি ${(t as BlockerTally)
            .crossShiftNames.join(' ও ')} শিফটের ক্লাস।`
      : `${share(d.count, (t as BlockerTally).candidates)} তিনি অন্য শাখায় ক্লাস নিচ্ছিলেন।`,
    suggestions,
  };
}

/**
 * Turn one generation result into a list a person can work down.
 *
 * Ordered by severity and, within `error`, by how many periods are missing:
 * a section short four periods matters more than one short a single period,
 * and a coordinator with twenty minutes should spend them at the top.
 */
/**
 * Fold the identical ones together.
 *
 * A large school over-subscribes ONE subject and every section reports it:
 * an 80-section fixture produced 1,516 findings, which is not a list a
 * person can work down and is close to a megabyte on a 2G connection. Forty
 * rows saying "প্রথম — ক · চারু ও কারুকলা — ৪টি পিরিয়ড বসেনি" are one
 * problem with one fix.
 *
 * Grouped on (category, subject) and only AFTER each one's category is
 * decided, so a group is genuinely one cause. Members whose walls differ
 * stay apart, because they are different problems that happen to share a
 * subject. The sections are named in `affectedBn` rather than summarised
 * away — a coordinator still needs to know which classes are short.
 */
const GROUP_AT = 3;
const NAMED_MEMBERS = 12;

function group(items: Explanation[]): Explanation[] {
  const buckets = new Map<string, Explanation[]>();
  const order: string[] = [];
  for (const item of items) {
    // Only the per-demand findings group; a hard conflict or an unchecked
    // rule is already one row.
    // Two things group, for the same reason and on different keys.
    //
    // An unplaced demand groups on (category, subject): forty sections short
    // of the same subject for the same reason is one problem with one fix.
    //
    // A soft trade groups on its RULE. The 80-section benchmark produced
    // 1,358 of them — one per teacher over their weekly cap — and a list
    // that long is not read at all, so the ninety who are fine get the same
    // attention as the eight who are badly over.
    const key = item.id.startsWith('unplaced:')
      ? `${item.category}|${item.affectedBn[1] ?? ''}`
      : item.id.startsWith('soft:')
        ? `soft|${item.id.split(':')[1]}`
        : `single:${item.id}`;
    if (!buckets.has(key)) { buckets.set(key, []); order.push(key); }
    (buckets.get(key) as Explanation[]).push(item);
  }

  const out: Explanation[] = [];
  for (const key of order) {
    const members = buckets.get(key) as Explanation[];
    if (members.length < GROUP_AT) { out.push(...members); continue; }

    const first = members[0];
    if (key.startsWith('soft|')) {
      // The individual sentences ARE the detail — each names a person and a
      // number — so they go into the drawer rather than being summarised
      // away. F-505's "nothing is silently accepted" is kept: every one is
      // still listed, one level in.
      out.push({
        ...first,
        id: `group:${key}`,
        titleBn: `${bn(members.length)}টি ক্ষেত্রে নরম শর্তে ছাড় — ${first.titleBn}`,
        whatBn: `একই ধরনের ${bn(members.length)}টি ছাড় দেওয়া হয়েছে।`,
        whyBn: first.whyBn,
        affectedBn: members.slice(0, NAMED_MEMBERS).map((m) => m.titleBn)
          .concat(members.length > NAMED_MEMBERS
            ? [`আরও ${bn(members.length - NAMED_MEMBERS)}টি`] : []),
        currentBn: `${bn(members.length)}টি ছাড়`,
        impactBn: first.impactBn,
      });
      continue;
    }
    const subjectBn = first.affectedBn[1] ?? 'এই বিষয়';
    const sections = members.map((m) => m.affectedBn[0]).filter(Boolean);
    // The totals are summed from the members' own numbers, never recomputed
    // from something else — the group must add up to what it replaced.
    const periods = members.reduce((n, m) => {
      const match = /([০-৯]+)টি পিরিয়ড বসেনি/.exec(m.titleBn);
      return n + (match ? Number(match[1].replace(/[০-৯]/g,
        (d) => String('০১২৩৪৫৬৭৮৯'.indexOf(d)))) : 0);
    }, 0);

    out.push({
      ...first,
      id: `group:${key}`,
      titleBn: `${subjectBn} — ${bn(sections.length)}টি শাখায় মোট `
             + `${bn(periods)}টি পিরিয়ড বসেনি`,
      whatBn: `${subjectBn} এর পিরিয়ড ${bn(sections.length)}টি শাখায় সম্পূর্ণ বসানো `
            + `যায়নি। কারণ সবগুলোতে একই — ${first.whatBn}`,
      // One representative's evidence, and it is labelled as one.
      whyBn: `${first.whyBn} (${sections[0]}-এর হিসাব; বাকিগুলোতেও একই বাধা)`,
      affectedBn: sections.length > NAMED_MEMBERS
        ? [...sections.slice(0, NAMED_MEMBERS),
           `আরও ${bn(sections.length - NAMED_MEMBERS)}টি শাখা`]
        : sections,
      currentBn: `${bn(sections.length)}টি শাখা · মোট ${bn(periods)}টি পিরিয়ড বাকি`,
      impactBn: `${bn(sections.length)}টি শাখায় ${subjectBn} সপ্তাহে কম পড়বে।`,
    });
  }
  return out;
}

export function explain(input: ExplainInput): Explanation[] {
  const out: Explanation[] = [];

  if (input.hardConflicts > 0) {
    out.push({
      id: 'hard:conflicts',
      severity: 'error',
      category: 'hard_conflict',
      titleBn: `${bn(input.hardConflicts)}টি ক্লাস একই সময়ে একই জায়গায় পড়েছে`,
      whatBn: 'একই শিক্ষক, কক্ষ বা শাখার জন্য একই সময়ে একাধিক ক্লাস বসানো হয়েছে।',
      whyBn: 'সংরক্ষিত রুটিনের সারিগুলো আবার পড়ে এই সংখ্যাটি গোনা হয়েছে।',
      affectedBn: [],
      currentBn: `${bn(input.hardConflicts)}টি সংঘাত`,
      impactBn: 'এই অবস্থায় রুটিন প্রকাশ করা যাবে না — প্রকাশের সময় ডেটাবেজ আটকে দেবে।',
      suggestions: [
        { textBn: 'রুটিন সম্পাদনা পাতায় গিয়ে সংঘর্ষে পড়া ক্লাসগুলো সরান',
          evidenceBn: 'সংঘাতগুলো সংরক্ষিত সারিতেই আছে' },
      ],
    });
  }

  const sorted = [...input.unplaced].sort((a, b) => b.missing - a.missing);
  sorted.forEach((u, i) => out.push(unplacedExplanation(u, i)));

  for (const [i, s] of input.shortages.entries()) {
    // Only when it says something the per-demand rows do not: the
    // school-wide picture for one kind of room.
    out.push({
      id: `shortage:${i}`,
      severity: 'warning',
      category: s.capableRooms === 0 ? 'capability_missing' : 'room_conflict',
      titleBn: s.subjectsBn.length > 0
        ? `${s.subjectsBn.join(', ')} — বিশেষ কক্ষ কম পড়েছে`
        : 'বিশেষ কক্ষ কম পড়েছে',
      whatBn: s.detailBn,
      whyBn: `সপ্তাহে ${bn(s.demandedPeriods)}টি পিরিয়ড দরকার ছিল; উপযুক্ত `
           + `${bn(s.capableRooms)}টি কক্ষে ${bn(s.freePeriods)}টি সময় খালি ছিল।`,
      affectedBn: s.subjectsBn,
      currentBn: `${bn(s.capableRooms)}টি কক্ষ · ${bn(s.freePeriods)}টি খালি সময়`,
      impactBn: 'ব্যবহারিক ক্লাসগুলো পুরোপুরি বসানো যায়নি।',
      suggestions: s.capableRooms === 0
        ? [{ textBn: 'উপযুক্ত একটি কক্ষ নিবন্ধন করুন',
             evidenceBn: 'এই ধরনের কক্ষ এখন শূন্য' }]
        : [{ textBn: 'আরও একটি কক্ষে এই সুবিধা যুক্ত করুন',
             evidenceBn: `চাহিদা ${bn(s.demandedPeriods)}, খালি সময় ${bn(s.freePeriods)}` }],
    });
  }

  for (const [i, v] of input.soft.entries()) {
    out.push({
      id: `soft:${v.code}:${i}`,
      severity: 'warning',
      category: 'soft_tradeoff',
      titleBn: v.detailBn,
      whatBn: v.detailBn,
      // The cause is claimed only when `soft-constraints.ts` computed one.
      whyBn: v.causeBn ?? 'রুটিন বসাতে গিয়ে এই পছন্দটি ছাড় দিতে হয়েছে।',
      affectedBn: [],
      currentBn: v.detailBn,
      impactBn: 'রুটিন চলবে, তবে এটি আদর্শ অবস্থা নয়।',
      suggestions: [],
    });
  }

  for (const [i, w] of input.setupWarnings.entries()) {
    out.push({
      id: `setup:${i}`,
      severity: 'warning',
      category: 'setup_gap',
      titleBn: w.titleBn,
      whatBn: w.detailBn,
      whyBn: 'এই তথ্যটি ঐচ্ছিক — না দিলেও রুটিন তৈরি হয়েছে।',
      affectedBn: [],
      currentBn: w.detailBn,
      impactBn: 'তথ্যটি দিলে পরের রুটিন আরও বাস্তবসম্মত হবে।',
      suggestions: [
        { textBn: 'রুটিন তৈরির প্রস্তুতি পাতায় গিয়ে তথ্যটি দিন',
          evidenceBn: 'ধাপটি এখনো ঐচ্ছিক হিসেবে বাকি আছে' },
      ],
    });
  }

  for (const [i, n] of input.notEvaluated.entries()) {
    out.push({
      id: `unchecked:${i}`,
      severity: 'info',
      category: 'not_evaluated',
      titleBn: `যাচাই করা হয়নি — ${n.ruleBn}`,
      whatBn: `"${n.ruleBn}" নিয়মটি এই রানে পরীক্ষা করা হয়নি।`,
      whyBn: n.whyBn,
      affectedBn: [],
      currentBn: 'পরীক্ষা করা হয়নি',
      impactBn: 'তাই "কোনো সমস্যা নেই" বলতে এই নিয়মটি ধরা হয়নি।',
      suggestions: [],
    });
  }

  const rank: Record<Severity, number> = { error: 0, warning: 1, info: 2 };
  return group(out).sort((a, b) => rank[a.severity] - rank[b.severity]);
}

/** How many of each severity, for the header a coordinator reads first. */
export function severityCounts(items: Explanation[]): Record<Severity, number> {
  return {
    error: items.filter((i) => i.severity === 'error').length,
    warning: items.filter((i) => i.severity === 'warning').length,
    info: items.filter((i) => i.severity === 'info').length,
  };
}
