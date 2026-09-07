/**
 * The one place a machine identifier becomes something a person can read.
 * (P9-4 §9)
 *
 * P9-3 found `"computer_lab" কক্ষে ৮০টি পিরিয়ড দরকার` on the generation
 * screen — a database string in the middle of a Bangla sentence, in front of
 * a head teacher. The audit that followed found the same value reaching the
 * explainer screen too, from `routines.soft_violations` where the solver had
 * already written it, so fixing the writer would not have fixed the rows
 * already stored. Both readers now go through here.
 *
 * ── Why a map AND a scrubber ──────────────────────────────────────────────
 * `rooms.capabilities` is `text[]` with no vocabulary: whatever an IT admin
 * types is a capability. So a lookup table can never be complete, and a
 * lookup table that silently falls through to the raw code is the bug this
 * file exists to prevent. The map covers what the schema's own comment
 * names; everything else becomes "বিশেষ কক্ষ" — less specific, and true.
 *
 * The scrubber exists because the sentence was composed before anyone knew
 * it would be shown: `solve.ts` wrote `"computer_lab"` into a stored jsonb
 * blob months ago. Rewriting the sentence on the way out is the only way to
 * fix rows that already exist.
 *
 * ── The rule ──────────────────────────────────────────────────────────────
 * Nothing that a developer chose reaches a screen: no enum value, no column
 * name, no uuid, no snake_case token. Where the product cannot say what
 * something is, it says less rather than showing the identifier.
 */

/**
 * The capabilities the schema's own comment names (003_academics.sql:123),
 * plus the four in use across the fixtures and the benchmark.
 */
const CAPABILITY_BN: Record<string, string> = {
  physics_lab: 'পদার্থবিজ্ঞান ল্যাব',
  chemistry_lab: 'রসায়ন ল্যাব',
  biology_lab: 'জীববিজ্ঞান ল্যাব',
  computer_lab: 'কম্পিউটার ল্যাব',
  computer: 'কম্পিউটার সুবিধা',
  projector: 'প্রজেক্টর',
  prayer_hall: 'নামাজ ঘর',
  library: 'পাঠাগার',
  auditorium: 'মিলনায়তন',
  science_lab: 'বিজ্ঞান ল্যাব',
  language_lab: 'ভাষা ল্যাব',
};

/**
 * Anything a developer or an admin typed: `computer_lab`, `room_id`, `EXAM_HALL`.
 *
 * Built fresh at each use rather than held as a module constant. A `/g`
 * regular expression carries `lastIndex` between calls, so a shared one
 * returns true, then false, then true for the same input — a bug that only
 * appears once the second sentence is scrubbed.
 */
const machineToken = (): RegExp =>
  /\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b|\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g;
const uuidPattern = (): RegExp =>
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const isMachineToken = (s: string): boolean =>
  /^(?:[a-z][a-z0-9]*(?:_[a-z0-9]+)+|[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)$/.test(s);

/**
 * What to call a room capability in front of a person.
 *
 * Never the code. A school that invented `senior_science_annexe` gets
 * "বিশেষ কক্ষ", which tells them less than they know and nothing they can
 * misread — and the subject that needed it is named beside this everywhere
 * it is used, so the sentence still identifies the problem.
 */
export function capabilityLabelBn(capability: string | null | undefined): string {
  if (!capability) return 'বিশেষ কক্ষ';
  return CAPABILITY_BN[capability] ?? 'বিশেষ কক্ষ';
}

/**
 * Rewrite a sentence that may already contain machine identifiers.
 *
 * Used on text that was composed elsewhere — a stored `soft_violations`
 * blob, a solver `detailBn` — where the alternative is showing the row as
 * written. Quoted codes lose their quotes along with the code, because
 * `"বিশেষ কক্ষ" কক্ষে` reads like a room actually named that.
 */
export function scrubMachineText(text: string): string {
  if (!text) return text;
  return text
    .replace(uuidPattern(), 'শনাক্তকারী')
    .replace(/["'`]([a-zA-Z][a-zA-Z0-9_]*)["'`]/g, (whole, token: string) =>
      (isMachineToken(token) || token in CAPABILITY_BN)
        ? capabilityLabelBn(token)
        : whole)
    .replace(machineToken(), (token) => CAPABILITY_BN[token] ?? 'বিশেষ কক্ষ');
}

/**
 * `shift_code`, as a person says it.
 *
 * Falls back to the code rather than to a generic word: the shift vocabulary
 * IS closed (`morning, day, evening, single`), so an unknown value here
 * would be a schema change someone must notice, not a school's free text.
 */
export const SHIFT_BN: Record<string, string> = {
  morning: 'সকাল', day: 'দিবা', evening: 'সান্ধ্য', single: 'একক',
};
export const shiftLabelBn = (shift: string): string => SHIFT_BN[shift] ?? shift;

/**
 * Why a demand could not be met, in a sentence that names the next step.
 *
 * Deliberately not a paraphrase of the code: `no_free_capable_room` means
 * the lab exists and is full, which sends a coordinator somewhere completely
 * different from `no_capable_room`, where the school has no such room at all.
 */
export const UNPLACED_REASON_BN: Record<string, string> = {
  no_free_slot: 'শিক্ষক ও শাখা — দুজনেরই একসাথে ফাঁকা সময় পাওয়া যায়নি',
  no_capable_room: 'এই বিষয়ের জন্য প্রয়োজনীয় ধরনের কোনো কক্ষ প্রতিষ্ঠানে নেই',
  no_free_capable_room: 'উপযুক্ত কক্ষ আছে, কিন্তু ওই সময়ে সেটি খালি নেই',
  no_contiguous_pair: 'পরপর দুই পিরিয়ড একসাথে পাওয়া যায়নি — আলাদা করে বসানো হয়েছে',
};
export const unplacedReasonBn = (reason: string): string =>
  UNPLACED_REASON_BN[reason] ?? 'কারণ জানা যায়নি';

/**
 * A Bangla name in the possessive: "রফিক স্যার" → "রফিক স্যারের".
 *
 * Concatenating a name to a noun gives "রফিক স্যার ক্লাসগুলো", which is not
 * a sentence — Bangla marks the genitive and a reader notices its absence
 * immediately. The rule is the ordinary one:
 *
 *   ends in a vowel (sign or letter)  →  "র"   সালমা → সালমার
 *   ends in a consonant               →  "ের"  স্যার → স্যারের
 *
 * Deliberately not a general morphology engine. This handles the two cases
 * a person's name actually takes; anything more would be a linguistics
 * project inside a timetable, and getting the common case right is what
 * makes the sentence read as written by someone who speaks the language.
 */
const BN_VOWEL_ENDINGS = 'অআইঈউঊএঐওঔািীুূৃেৈোৌ';
export function possessiveBn(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return trimmed;
  const last = trimmed[trimmed.length - 1];
  return BN_VOWEL_ENDINGS.includes(last) ? `${trimmed}র` : `${trimmed}ের`;
}
