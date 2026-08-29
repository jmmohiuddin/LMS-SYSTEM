/**
 * Notice SMS policy (R-2 finalisation).
 *
 * SMS is roughly 80% of the infrastructure bill (docs/05 §5), so the two
 * decisions this file covers — how long an alert may be, and whose name is on
 * it — are the most expensive and the most visible in the product. Both were
 * previously untested; sms-svc had no test workspace at all.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  noticeSmsBody,
  noticeSmsMaxChars,
  NOTICE_SMS_DEFAULT_MAX,
  NOTICE_SMS_HARD_CEILING,
} from '../src/dispatch.ts';

const ORG = 'শাহজালাল';

describe('noticeSmsMaxChars', () => {
  test('defaults to 180 when a tenant has configured nothing', () => {
    assert.equal(noticeSmsMaxChars(null), NOTICE_SMS_DEFAULT_MAX);
    assert.equal(noticeSmsMaxChars({}), NOTICE_SMS_DEFAULT_MAX);
    assert.equal(noticeSmsMaxChars({ sms: {} }), NOTICE_SMS_DEFAULT_MAX);
    assert.equal(noticeSmsMaxChars({ branding: { nameBn: 'ক' } }), NOTICE_SMS_DEFAULT_MAX);
  });

  test('a tenant may raise it — 180 is a default, not a technical limit', () => {
    assert.equal(noticeSmsMaxChars({ sms: { noticeMaxChars: 320 } }), 320);
  });

  test('a tenant may lower it — a tight SMS budget is a real case', () => {
    // 70 characters is exactly one Bangla segment.
    assert.equal(noticeSmsMaxChars({ sms: { noticeMaxChars: 70 } }), 70);
  });

  test('clamps to the hard ceiling rather than trusting the number', () => {
    // Past ~7 segments an SMS has stopped being an alert, and the honest
    // answer is a shorter notice rather than a bigger bill.
    assert.equal(noticeSmsMaxChars({ sms: { noticeMaxChars: 5000 } }), NOTICE_SMS_HARD_CEILING);
    assert.equal(noticeSmsMaxChars({ sms: { noticeMaxChars: 1 } }), 70);
    assert.equal(noticeSmsMaxChars({ sms: { noticeMaxChars: -40 } }), 70);
  });

  test('survives junk in the settings blob', () => {
    for (const junk of ['abc', {}, [], true, NaN, Infinity, null, undefined]) {
      assert.equal(
        noticeSmsMaxChars({ sms: { noticeMaxChars: junk } }),
        NOTICE_SMS_DEFAULT_MAX,
        String(junk),
      );
    }
  });

  test('accepts a numeric string, because jsonb round-trips as text', () => {
    assert.equal(noticeSmsMaxChars({ sms: { noticeMaxChars: '240' } }), 240);
  });
});

describe('noticeSmsBody', () => {
  test('THE ONE THAT MATTERS — it is signed by the school, never the platform', () => {
    const body = noticeSmsBody('ছুটির নোটিশ', 'আগামীকাল বন্ধ।', ORG);
    assert.match(body, /শাহজালাল/);
    // The regression this exists for: templates used to end "— ShikhonBD".
    // A parent should be told by the school their child attends.
    assert.doesNotMatch(body, /ShikhonBD/i);
  });

  test('a short notice arrives whole', () => {
    const body = noticeSmsBody('ছুটি', 'আগামীকাল বন্ধ।', ORG);
    assert.match(body, /ছুটি/);
    assert.match(body, /আগামীকাল বন্ধ।/);
  });

  test('a long notice is truncated to an alert, not sent in full', () => {
    // 4000 characters is 58 UCS-2 segments per guardian; to 900 guardians
    // that is over ৳20,000 for one message.
    const body = noticeSmsBody('জরুরি', 'ক'.repeat(4000), ORG);
    assert.ok(body.length <= NOTICE_SMS_DEFAULT_MAX,
      `alert is ${body.length} chars, cap is ${NOTICE_SMS_DEFAULT_MAX}`);
    assert.match(body, /…/, 'truncation should be visible, not silent');
    assert.match(body, /শাহজালাল/, 'the signature survives truncation');
  });

  test('honours a tenant-raised cap', () => {
    const short = noticeSmsBody('জরুরি', 'ক'.repeat(4000), ORG, 180);
    const long = noticeSmsBody('জরুরি', 'ক'.repeat(4000), ORG, 400);
    assert.ok(long.length > short.length);
    assert.ok(long.length <= 400);
  });

  test('a title alone still produces a signed alert', () => {
    // No room for a lead: the headline plus the school is the whole message.
    const body = noticeSmsBody('ক'.repeat(160), 'বিস্তারিত অ্যাপে।', ORG);
    assert.match(body, /শাহজালাল/);
    assert.ok(body.length <= NOTICE_SMS_DEFAULT_MAX + ORG.length + 4);
  });

  test('collapses whitespace so a multi-line notice does not waste segments', () => {
    const body = noticeSmsBody('সভা', 'প্রথম\n\n   দ্বিতীয়', ORG);
    assert.doesNotMatch(body, /\n/);
    assert.doesNotMatch(body, /   /);
  });

  test('an empty body degrades to the headline, not to a dangling colon', () => {
    const body = noticeSmsBody('ছুটি', '', ORG);
    assert.equal(body, `ছুটি — ${ORG}`);
  });
});
