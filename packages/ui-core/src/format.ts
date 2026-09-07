/**
 * Bangla/Latin numeral and date formatting.
 *
 * Implements docs/04-UIUX-ACCESSIBILITY.md §2.4. The policy exists because
 * mixing numeral systems is a genuine source of data loss: teachers type Latin
 * digits on a Bangla keyboard, and a naive parseInt on '১২' yields NaN, which
 * surfaces to the user as "the marks didn't save".
 *
 *   Prose, dates, period numbers, counts  → locale-appropriate
 *   Money, roll numbers, marks, phone, ID → ALWAYS Latin, tabular-nums
 *   Input                                 → accept both, normalise to Latin
 */

const BN_DIGITS = '০১২৩৪৫৬৭৮৯';
const LATIN_DIGITS = '0123456789';

/** '১২৩' → '123'. The single most important function in this file. */
export function toLatinDigits(s: string): string {
  return s.replace(/[০-৯]/g, (d) => String(BN_DIGITS.indexOf(d)));
}

/** '123' → '১২৩', for display in Bangla prose only. */
export function toBanglaDigits(s: string | number): string {
  return String(s).replace(/[0-9]/g, (d) => BN_DIGITS[LATIN_DIGITS.indexOf(d)]);
}

/**
 * Parse a number a user typed, in either numeral system.
 * Returns null rather than NaN so callers must handle it explicitly.
 */
export function parseUserNumber(input: string): number | null {
  const cleaned = toLatinDigits(input).trim().replace(/[,\s]/g, '');
  if (cleaned === '' || !/^-?\d*\.?\d+$/.test(cleaned)) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

export type Locale = 'bn' | 'en';

/** Counts, period numbers, prose numbers — follow the locale. */
export function formatCount(n: number, locale: Locale): string {
  return locale === 'bn' ? toBanglaDigits(n) : String(n);
}

/**
 * Identifiers and money — ALWAYS Latin, whatever the locale.
 * A roll number rendered as '১২' cannot be cross-checked against a paper
 * register, and a fee amount in Bangla digits is a support ticket.
 */
export function formatIdentifier(n: number | string): string {
  return toLatinDigits(String(n));
}

/**
 * The one money formatter in the product.  (R-8 audit — "money formatting",
 * carried open since R-5, decided here.)
 *
 * It was not the only one. `apps/pwa/src/fees-view.ts` carried a private
 * `money()` that rendered Bangla digits with `en-IN` grouping, so a parent saw
 * **৳ ১,২৫০** on the fees screen and **৳ 1,250.00** on the receipt printed for
 * the same invoice. That is the support ticket the comment above predicted,
 * and it is also two sources of truth for one decision.
 *
 * Two choices, both deliberate:
 *
 *   **Latin digits**, per `formatIdentifier` above — money has to be
 *   cross-checkable against a bank slip, an MFS statement and a paper ledger,
 *   none of which are in Bangla digits.
 *
 *   **`en-IN` grouping**, changed from `en-US` here. Bangladesh reads in lakh
 *   and crore: ১,২৫,০০০ not 125,000. Below a lakh the two are identical, which
 *   is why every existing expectation still holds — the difference appears
 *   exactly where a school's annual figures live.
 *
 * Always two decimals: an amount on a receipt must not be ambiguous.
 */
export function formatBdt(amount: number | string): string {
  const n = typeof amount === 'string' ? Number(toLatinDigits(amount)) : amount;
  if (!Number.isFinite(n)) return '৳ —';
  return `৳ ${n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/**
 * Bangla month names on the Gregorian calendar — which is what school notices
 * actually use. Bengali-calendar months (বৈশাখ…) are for cultural dates only.
 */
const BN_MONTHS = [
  'জানুয়ারি', 'ফেব্রুয়ারি', 'মার্চ', 'এপ্রিল', 'মে', 'জুন',
  'জুলাই', 'আগস্ট', 'সেপ্টেম্বর', 'অক্টোবর', 'নভেম্বর', 'ডিসেম্বর',
];
const EN_MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/** 'YYYY-MM-DD' → '৬ আগস্ট' / '6 August'. Parsed as a plain date, not UTC. */
export function formatDayMonth(isoDate: string, locale: Locale): string {
  const [y, m, d] = isoDate.split('-').map(Number);
  if (!y || !m || !d) return isoDate;
  return locale === 'bn'
    ? `${toBanglaDigits(d)} ${BN_MONTHS[m - 1]}`
    : `${d} ${EN_MONTHS[m - 1]}`;
}

/** Short form for SMS, where every character costs money (70/segment in UCS-2). */
export function formatShortDate(isoDate: string, locale: Locale): string {
  const [, m, d] = isoDate.split('-');
  const s = `${d}/${m}`;
  return locale === 'bn' ? toBanglaDigits(s) : s;
}

/** '10:20' → '১০:২০' / '10:20 AM'. */
export function formatTime(hhmm: string, locale: Locale): string {
  const [h, m] = hhmm.split(':').map(Number);
  if (Number.isNaN(h) || Number.isNaN(m)) return hhmm;
  if (locale === 'bn') return toBanglaDigits(`${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`);
  const suffix = h < 12 ? 'AM' : 'PM';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, '0')} ${suffix}`;
}

/**
 * SMS segment count. Bangla forces UCS-2 at 70 chars/segment versus 160 for
 * GSM-7, and SMS is ~80% of this product's infrastructure cost, so templates
 * are validated against this in CI.
 */
const GSM7 =
  "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?" +
  '¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà';
const GSM7_EXT = '^{}\\[~]|€';

export function smsEncoding(body: string): 'gsm7' | 'unicode' {
  for (const ch of body) {
    if (!GSM7.includes(ch) && !GSM7_EXT.includes(ch)) return 'unicode';
  }
  return 'gsm7';
}

export function smsSegments(body: string): { encoding: 'gsm7' | 'unicode'; segments: number; chars: number } {
  const encoding = smsEncoding(body);
  // Extended GSM-7 characters occupy two septets.
  const chars =
    encoding === 'gsm7'
      ? [...body].reduce((n, ch) => n + (GSM7_EXT.includes(ch) ? 2 : 1), 0)
      : [...body].length;
  const single = encoding === 'gsm7' ? 160 : 70;
  const multi = encoding === 'gsm7' ? 153 : 67; // UDH steals space in concatenated SMS
  const segments = chars === 0 ? 0 : chars <= single ? 1 : Math.ceil(chars / multi);
  return { encoding, segments, chars };
}

/**
 * A class level as a Bangladeshi school says it: `9` → "নবম".
 *
 * Ordinals in Bangla are per-number, not a suffix. Building them by appending
 * "ম" gives "১১ম" where a school says "একাদশ", and P4 shipped exactly that
 * mistake once already as "২ম পিরিয়ড". This table has been correct in
 * `structure-forms.ts` since R-3; it lives here so there is only one.
 */
const LEVEL_BN = [
  '', 'প্রথম', 'দ্বিতীয়', 'তৃতীয়', 'চতুর্থ', 'পঞ্চম', 'ষষ্ঠ',
  'সপ্তম', 'অষ্টম', 'নবম', 'দশম', 'একাদশ', 'দ্বাদশ',
] as const;

export function levelNameBn(level: number): string {
  return LEVEL_BN[level] ?? String(level);
}

/**
 * The short ordinal a school writes on a printed sheet: `1` → "১ম", `2` → "২য়".
 *
 * A separate table from LEVEL_BN because these are different words for
 * different jobs — a class is "নবম শ্রেণি" in full, a period is "৯ম" in a
 * grid cell where four characters is all the column has. Both are per-number
 * for the SAME reason the comment above gives: the suffix is not "ম" for
 * every number, and "২ম" is the mistake P4 shipped. ২য়, ৩য়, ৪র্থ and ৬ষ্ঠ
 * each differ, and a school notices immediately.
 *
 * Beyond the table it falls back to the plain Bangla numeral rather than
 * guessing a suffix: "১৩" is honest where "১৩ম" would be wrong.
 */
const ORDINAL_BN = [
  '', '১ম', '২য়', '৩য়', '৪র্থ', '৫ম', '৬ষ্ঠ',
  '৭ম', '৮ম', '৯ম', '১০ম', '১১তম', '১২তম',
] as const;

export function ordinalBn(n: number): string {
  return ORDINAL_BN[n] ?? toBanglaDigits(n);
}

/**
 * The part of the day a clock time falls in, as Bangladesh says it.
 *
 * A school day that runs to 14:00 prints "১৪:০০" on a 24-hour clock, and a
 * teacher reads that as a period number before they read it as a time — which
 * is exactly the confusion this exists to remove. Bangla has no bare 12-hour
 * clock: `১:০০` alone is ambiguous, and the part of the day is what removes
 * the ambiguity. So the two travel together.
 *
 * The boundaries are the everyday ones, not astronomical: দুপুর covers noon
 * through the early afternoon (দুপুর ১টা, দুপুর ২টা), বিকাল the late
 * afternoon. A school's periods land in ভোর/সকাল/দুপুর/বিকাল; সন্ধ্যা and
 * রাত are here so a night shift or an exam slot does not fall off the table.
 */
export function dayPartBn(hhmm: string): string {
  const h = Number(hhmm.split(':')[0]);
  if (Number.isNaN(h)) return '';
  if (h >= 4 && h < 6) return 'ভোর';
  if (h >= 6 && h < 12) return 'সকাল';
  if (h >= 12 && h < 15) return 'দুপুর';
  if (h >= 15 && h < 18) return 'বিকাল';
  if (h >= 18 && h < 20) return 'সন্ধ্যা';
  return 'রাত';
}

/**
 * One period's clock range, the way a Bangladeshi school reads it.
 *
 *   bn  →  "সকাল ১০:০০–১০:৪৫",  "দুপুর ১:০০–১:৪৫"
 *   en  →  "10:00–10:45 AM"
 *
 * The part of the day is named ONCE, from the START, and the range follows —
 * "সকাল ১১:৩০–১২:১৫" rather than "সকাল ১১:৩০–দুপুর ১২:১৫", which is how a
 * routine is spoken and half the width. A period that genuinely straddles a
 * boundary is still read correctly: the reader has the start's part of day
 * and the end is minutes later, not hours.
 *
 * The hour loses its leading zero here where `formatTime` keeps it. On a
 * 24-hour clock the zero aligns a column; with the part of day in front of
 * it, "সকাল ০৯:০০" is a padded numeral nobody says out loud.
 */
export function formatClockRange(
  startHhmm: string, endHhmm: string, locale: Locale,
): string {
  const h12 = (hhmm: string): string => {
    const [h, m] = hhmm.split(':').map(Number);
    if (Number.isNaN(h) || Number.isNaN(m)) return hhmm;
    const hour = h % 12 === 0 ? 12 : h % 12;
    return `${hour}:${String(m).padStart(2, '0')}`;
  };
  if (locale !== 'bn') {
    const [h] = endHhmm.split(':').map(Number);
    return `${h12(startHhmm)}–${h12(endHhmm)} ${h < 12 ? 'AM' : 'PM'}`;
  }
  const part = dayPartBn(startHhmm);
  const range = toBanglaDigits(`${h12(startHhmm)}–${h12(endHhmm)}`);
  return part ? `${part} ${range}` : range;
}

/**
 * Today, on the calendar the person in front of the screen is reading.
 *
 * `new Date().toISOString().slice(0, 10)` is UTC, and Dhaka is six hours
 * ahead of it — so from midnight to 6am local, that expression names
 * YESTERDAY. server-core has `dhakaToday` for the same trap on the server
 * side, where the fix is to add a fixed offset because the host is UTC.
 *
 * In a browser the fix is the opposite one: read the LOCAL fields the user's
 * own clock already has, and never go through UTC at all. That also keeps an
 * operator abroad honest — they get their own today, not Dhaka's.
 *
 * P7 found it defaulting the date on a payment form: a payment recorded at
 * 1am in Dhaka would have been dated to the previous day, in a table whose
 * unique constraint includes the date.
 */
export function todayLocalIso(now: Date = new Date()): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

/**
 * Bangla weekday names, full form. `বৃহঃ` and friends are the SHORT form and
 * belong to whoever needs a hero line to fit, not here.
 */
const BN_WEEKDAYS = [
  'রবিবার', 'সোমবার', 'মঙ্গলবার', 'বুধবার', 'বৃহস্পতিবার', 'শুক্রবার', 'শনিবার',
];

/**
 * "রবিবার, ৬ আগস্ট" — the date line every home screen puts under its greeting.
 *
 * There were three byte-identical private copies of this, one in each of
 * `principal-home-view`, `student-home-view` and `teacher-home-view`, each
 * with its own DAYS and MONTHS arrays beside it. Three copies of a month
 * table is three chances to mistype a month.
 *
 * `home-view.ts` keeps a different one on purpose: its hero line uses the
 * SHORT weekday ("রবি") because the full form does not fit, so it is a
 * different string rather than a duplicate of this one.
 *
 * Takes the instant, so a caller with an injected clock stays testable.
 */
export function weekdayDateBn(now: Date): string {
  return `${BN_WEEKDAYS[now.getDay()]}, ${toBanglaDigits(now.getDate())} ${BN_MONTHS[now.getMonth()]}`;
}
