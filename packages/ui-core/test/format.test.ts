/**
 * Numeral, date and SMS-cost formatting.
 *
 * The numeral rules are not cosmetic: mixing systems is a real source of data
 * loss, and SMS segment count is ~80% of this product's infrastructure bill.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  toLatinDigits, toBanglaDigits, parseUserNumber, formatCount, formatIdentifier,
  formatBdt, formatDayMonth, formatShortDate, formatTime, smsEncoding, smsSegments,
} from '../src/format.ts';

describe('numeral conversion', () => {
  test('round-trips both ways', () => {
    assert.equal(toLatinDigits('১২৩৪৫৬৭৮৯০'), '1234567890');
    assert.equal(toBanglaDigits('1234567890'), '১২৩৪৫৬৭৮৯০');
    assert.equal(toLatinDigits(toBanglaDigits('42')), '42');
  });

  test('leaves non-digits alone and handles mixed input', () => {
    assert.equal(toLatinDigits('রোল ১২ — Section ক'), 'রোল 12 — Section ক');
    assert.equal(toLatinDigits('১2৩'), '123', 'mixed systems in one string');
  });
});

describe('parseUserNumber — the "marks didn\'t save" bug', () => {
  test('accepts Bangla digits, which parseInt would turn into NaN', () => {
    assert.equal(parseUserNumber('৬৫'), 65);
    assert.equal(Number.isNaN(Number('৬৫')), true, 'proving the naive path fails');
  });

  test('accepts Latin, mixed, decimals and stray whitespace/commas', () => {
    assert.equal(parseUserNumber('65'), 65);
    assert.equal(parseUserNumber(' ৬5 '), 65);
    assert.equal(parseUserNumber('৪৯.৫'), 49.5);
    assert.equal(parseUserNumber('1,250'), 1250);
  });

  test('returns null — never NaN — for anything unparseable', () => {
    for (const bad of ['', '   ', 'abc', '১২ক', '--5', '1.2.3']) {
      assert.equal(parseUserNumber(bad), null, `input: "${bad}"`);
    }
  });
});

describe('numeral policy by field type', () => {
  test('counts follow the locale', () => {
    assert.equal(formatCount(38, 'bn'), '৩৮');
    assert.equal(formatCount(38, 'en'), '38');
  });

  test('identifiers are ALWAYS Latin — a roll number must match the paper register', () => {
    assert.equal(formatIdentifier(12), '12');
    assert.equal(formatIdentifier('১২'), '12', 'normalises even if handed Bangla');
  });

  test('money is Latin with two decimals and thousands separators', () => {
    assert.equal(formatBdt(1250), '৳ 1,250.00');
    assert.equal(formatBdt('১২৫০.৫'), '৳ 1,250.50');
    assert.equal(formatBdt('nonsense'), '৳ —', 'degrades visibly rather than showing NaN');
  });

  test('THE ONE THAT MATTERS — lakh grouping, because that is how BDT is read', () => {
    // R-8 audit. Bangladesh reads in lakh and crore. 125000 written as
    // "125,000" makes a school's accounts clerk count digits; ১,২৫,০০০ is the
    // shape they already know, and Latin digits keep it checkable against a
    // bank slip. Below a lakh en-IN and en-US agree, which is why this is the
    // only case that could have caught the change.
    assert.equal(formatBdt(125000), '৳ 1,25,000.00');
    assert.equal(formatBdt(12500000), '৳ 1,25,00,000.00');
  });

  test('zero and negatives are shown, not hidden', () => {
    // A zero balance is information a parent needs; a blank is not.
    assert.equal(formatBdt(0), '৳ 0.00');
    assert.match(formatBdt(-50), /50\.00/);
  });
});

describe('dates and times', () => {
  test('Gregorian months with Bangla names — what school notices actually use', () => {
    assert.equal(formatDayMonth('2026-08-06', 'bn'), '৬ আগস্ট');
    assert.equal(formatDayMonth('2026-08-06', 'en'), '6 August');
    assert.equal(formatDayMonth('2026-01-31', 'bn'), '৩১ জানুয়ারি');
  });

  test('parses as a plain date, not UTC — no off-by-one from timezone', () => {
    // A Date-based implementation in Asia/Dhaka would render this as the 5th.
    assert.equal(formatDayMonth('2026-12-01', 'en'), '1 December');
  });

  test('short date for SMS, where every character costs money', () => {
    assert.equal(formatShortDate('2026-08-06', 'bn'), '০৬/০৮');
    assert.equal(formatShortDate('2026-08-06', 'en'), '06/08');
  });

  test('time formatting per locale', () => {
    assert.equal(formatTime('10:20', 'bn'), '১০:২০');
    assert.equal(formatTime('10:20', 'en'), '10:20 AM');
    assert.equal(formatTime('13:05', 'en'), '1:05 PM');
    assert.equal(formatTime('00:30', 'en'), '12:30 AM');
  });

  test('malformed input is returned unchanged rather than throwing', () => {
    assert.equal(formatDayMonth('garbage', 'bn'), 'garbage');
    assert.equal(formatTime('nope', 'en'), 'nope');
  });
});

describe('SMS cost — the largest line in the infrastructure budget', () => {
  test('Bangla forces UCS-2 at 70 chars per segment', () => {
    assert.equal(smsEncoding('Your child was absent today'), 'gsm7');
    assert.equal(smsEncoding('আপনার সন্তান আজ অনুপস্থিত ছিল'), 'unicode');
  });

  test('segment maths matches the GSM spec', () => {
    assert.deepEqual(smsSegments('a'.repeat(160)), { encoding: 'gsm7', segments: 1, chars: 160 });
    assert.deepEqual(smsSegments('a'.repeat(161)), { encoding: 'gsm7', segments: 2, chars: 161 });
    assert.deepEqual(smsSegments('অ'.repeat(70)), { encoding: 'unicode', segments: 1, chars: 70 });
    assert.deepEqual(smsSegments('অ'.repeat(71)), { encoding: 'unicode', segments: 2, chars: 71 });
    assert.equal(smsSegments('').segments, 0);
  });

  test('extended GSM-7 characters cost two septets', () => {
    assert.equal(smsSegments('€').chars, 2);
    assert.equal(smsSegments('{}').chars, 4);
  });

  test('the real absence template is measured, not guessed', () => {
    const body =
      'প্রিয় অভিভাবক, আপনার সন্তান রহিম (রোল ১২) আজ ০৬/০৮ তারিখে বিদ্যালয়ে অনুপস্থিত ছিল।';
    const { encoding, segments } = smsSegments(body);
    assert.equal(encoding, 'unicode');
    assert.ok(segments >= 2, `Bangla absence SMS is ${segments} segments — budget accordingly`);

    // The 70-char variant the template library must also ship.
    const short = 'রহিম (রোল ১২) আজ অনুপস্থিত। — ধানমন্ডি স্কুল';
    assert.equal(smsSegments(short).segments, 1, 'short variant fits one segment');
  });
});
