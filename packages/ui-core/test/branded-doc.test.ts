/**
 * Print foundation tests (R-1).
 *
 * Everything future receipts, report cards and admit cards will sit on.
 * Two things are being asserted: that a document carries the RIGHT
 * institution's identity, and that a tenant-supplied string cannot become
 * markup on the way there. The second matters more — the values here are
 * typed by a school IT user and interpolated into HTML.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  brandedDocument,
  brandedLetterhead,
  brandedSignature,
  brandedDocumentCss,
  escapeHtml,
} from '../src/branded-doc.ts';
import { parseBranding } from '../src/branding.ts';

const PNG_1PX =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const SCHOOL_A = parseBranding({
  nameBn: 'শাহজালাল আদর্শ উচ্চ বিদ্যালয়',
  nameEn: 'Shahjalal Adarsha High School',
  shortName: 'শাহজালাল',
  logoUrl: PNG_1PX,
  primaryColor: '#156a3f',
  address: 'জিন্দাবাজার, সিলেট ৩১০০',
  phone: '+8801711000001',
  email: 'office@shahjalal.example.edu.bd',
  headmasterName: 'মোঃ আব্দুল কাদের',
  signatureUrl: PNG_1PX,
  watermarkUrl: PNG_1PX,
});

const COLLEGE_B = parseBranding({
  nameBn: 'নর্থ সিটি মহিলা কলেজ',
  nameEn: 'North City College',
  shortName: 'নর্থ সিটি',
  primaryColor: '#1b3e7a',
  address: 'উত্তরা সেক্টর ৭, ঢাকা ১২৩০',
  phone: '+8801711000002',
  headmasterName: 'অধ্যাপক সালমা বেগম',
});

describe('escapeHtml', () => {
  test('neutralises every character that can open a tag or close an attribute', () => {
    assert.equal(escapeHtml('<script>'), '&lt;script&gt;');
    assert.equal(escapeHtml('a"b\'c&d'), 'a&quot;b&#39;c&amp;d');
  });
});

describe('letterhead', () => {
  test('carries the institution name, address and contact line', () => {
    const html = brandedLetterhead(SCHOOL_A);
    assert.match(html, /শাহজালাল আদর্শ উচ্চ বিদ্যালয়/);
    assert.match(html, /জিন্দাবাজার, সিলেট ৩১০০/);
    assert.match(html, /\+8801711000001/);
    assert.match(html, /office@shahjalal\.example\.edu\.bd/);
    assert.match(html, /<img class="doc-logo"/);
  });

  test('uses the English name in the en locale', () => {
    assert.match(brandedLetterhead(SCHOOL_A, 'en'), /Shahjalal Adarsha High School/);
  });

  test('omits the logo element entirely when there is no logo', () => {
    const html = brandedLetterhead(COLLEGE_B);
    assert.doesNotMatch(html, /doc-logo/);
    assert.match(html, /নর্থ সিটি মহিলা কলেজ/);
  });

  test('escapes tenant text rather than emitting it as markup', () => {
    const hostile = parseBranding({
      nameBn: '<img src=x onerror=alert(1)>',
      address: '</style><script>alert(2)</script>',
    });
    const html = brandedLetterhead(hostile);
    assert.doesNotMatch(html, /<script/);
    assert.doesNotMatch(html, /<img src=x/);
    assert.match(html, /&lt;img src=x/);
  });
});

describe('signature block', () => {
  test('prints the head teacher above the rule', () => {
    const html = brandedSignature(SCHOOL_A);
    assert.match(html, /মোঃ আব্দুল কাদের/);
    assert.match(html, /doc-sign-img/);
  });

  test('still prints a signable rule when no signature image exists', () => {
    // A document a head has to sign by hand is still a valid document.
    const html = brandedSignature(COLLEGE_B);
    assert.doesNotMatch(html, /doc-sign-img/);
    assert.match(html, /doc-sign-rule/);
    assert.match(html, /অধ্যাপক সালমা বেগম/);
  });

  test('an explicit caption overrides the head teacher name', () => {
    assert.match(brandedSignature(SCHOOL_A, 'হিসাবরক্ষক'), /হিসাবরক্ষক/);
  });
});

describe('document css', () => {
  test('includes a print-colour-adjust watermark layer only when set', () => {
    const withMark = brandedDocumentCss(SCHOOL_A);
    assert.match(withMark, /doc-watermark/);
    // Browsers strip background imagery from printed pages by default —
    // the exact setting that would silently drop a school's watermark.
    assert.match(withMark, /print-color-adjust:exact/);
    assert.doesNotMatch(brandedDocumentCss(COLLEGE_B), /doc-watermark/);
  });
});

describe('brandedDocument', () => {
  test('is a complete standalone document with the tenant colour inlined', () => {
    const html = brandedDocument({
      branding: SCHOOL_A,
      title: 'ফি রসিদ',
      bodyHtml: '<p>মোট: ১২০০ টাকা</p>',
      meta: [{ label: 'রসিদ নং', value: 'R-2026-0001' }],
    });
    assert.match(html, /^<!doctype html>/);
    assert.match(html, /<html lang="bn">/);
    assert.match(html, /--doc-primary:#156a3f/);
    assert.match(html, /<title>ফি রসিদ — শাহজালাল আদর্শ উচ্চ বিদ্যালয়<\/title>/);
    assert.match(html, /মোট: ১২০০ টাকা/);
    assert.match(html, /R-2026-0001/);
    // No external references: a receipt must print identically from a
    // saved file with no network.
    assert.doesNotMatch(html, /<link /);
    assert.doesNotMatch(html, /<script/);
  });

  test('showSignature:false drops the footer for documents that need none', () => {
    const html = brandedDocument({
      branding: SCHOOL_A, title: 'তালিকা', bodyHtml: '<p>x</p>', showSignature: false,
    });
    // The stylesheet always defines .doc-foot; what must be absent is the
    // footer ELEMENT and the signature rule inside it.
    assert.doesNotMatch(html, /<footer/);
    assert.doesNotMatch(html, /doc-sign-rule"/);
    // …and the same document with the footer on does have both.
    const withSig = brandedDocument({
      branding: SCHOOL_A, title: 'তালিকা', bodyHtml: '<p>x</p>',
    });
    assert.match(withSig, /<footer class="doc-foot">/);
  });

  test('two tenants produce documents that share no identity', () => {
    // The R-1 acceptance criterion, at the document layer.
    const a = brandedDocument({ branding: SCHOOL_A, title: 'রসিদ', bodyHtml: '' });
    const b = brandedDocument({ branding: COLLEGE_B, title: 'রসিদ', bodyHtml: '' });

    assert.match(a, /শাহজালাল/);
    assert.doesNotMatch(a, /নর্থ সিটি/);
    assert.match(b, /নর্থ সিটি/);
    assert.doesNotMatch(b, /শাহজালাল/);

    assert.match(a, /--doc-primary:#156a3f/);
    assert.match(b, /--doc-primary:#1b3e7a/);

    // A's address, phone and head teacher must appear on A's paper only.
    assert.doesNotMatch(b, /জিন্দাবাজার/);
    assert.doesNotMatch(b, /\+8801711000001/);
    assert.doesNotMatch(b, /আব্দুল কাদের/);
  });

  test('a hostile asset URL is dropped, not printed, and never throws', () => {
    // A receipt with a missing logo must still print. A receipt that
    // throws is a parent standing at a counter with no proof of payment.
    const b = { ...SCHOOL_A, logoUrl: 'javascript:alert(1)' };
    const html = brandedDocument({ branding: b, title: 'রসিদ', bodyHtml: '' });
    assert.doesNotMatch(html, /javascript:/);
    assert.match(html, /শাহজালাল/);
  });
});
