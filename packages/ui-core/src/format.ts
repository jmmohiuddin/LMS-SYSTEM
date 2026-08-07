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

export function formatBdt(amount: number | string): string {
  const n = typeof amount === 'string' ? Number(toLatinDigits(amount)) : amount;
  if (!Number.isFinite(n)) return '৳ —';
  return `৳ ${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
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
