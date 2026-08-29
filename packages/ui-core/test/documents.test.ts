/**
 * R-5 — the documents a school prints.
 *
 * Every builder here is pure, so the properties that matter are testable
 * without a database or a browser. The ones worth holding:
 *
 *   - the SAME code produces two schools' letterheads, and neither leaks
 *     into the other
 *   - no ISO date and no Latin digit reaches an official Bangla document
 *   - a missing logo, watermark or signature degrades; it never breaks
 *   - a hostile institution name cannot inject markup into a receipt
 *   - forty report cards are forty pages, each fully branded
 *   - the platform's brand never appears as the institution's identity
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { parseBranding, type Branding } from '../src/branding.ts';
import { brandedDocument, brandedDocumentSet } from '../src/branded-doc.ts';
import {
  buildFeeReceipt,
  buildReportCard,
  buildAdmitCard,
  buildIdCard,
  buildTransferCertificate,
  buildAttendanceSheet,
  documentBodyCss,
  ADMIT_INSTRUCTIONS_BN,
  DOCUMENT_TITLES_BN,
  BULK_CAPABLE,
  type StudentRef,
} from '../src/documents.ts';

// Two institutions, as different as two real ones are.
const MONIPUR: Branding = parseBranding({
  nameBn: 'মনিপুর উচ্চ বিদ্যালয়',
  nameEn: 'Monipur High School',
  shortName: 'মনিপুর',
  logoUrl: 'https://cdn.example/monipur-logo.png',
  primaryColor: '#1B5E20',
  address: 'মিরপুর, ঢাকা ১২১৬',
  phone: '+8801711000001',
  email: 'office@monipur.example',
  watermarkUrl: 'https://cdn.example/monipur-mark.png',
  headmasterName: 'মোঃ আব্দুল কাদের',
  signatureUrl: 'https://cdn.example/monipur-sign.png',
});

const MOHAMMADPUR: Branding = parseBranding({
  nameBn: 'মোহাম্মদপুর কলেজ',
  nameEn: 'Mohammadpur College',
  shortName: 'মোহাম্মদপুর',
  logoUrl: 'https://cdn.example/mpur-logo.png',
  primaryColor: '#0D47A1',
  address: 'মোহাম্মদপুর, ঢাকা ১২০৭',
  phone: '+8801711000002',
  watermarkUrl: 'https://cdn.example/mpur-mark.png',
  headmasterName: 'ড. সালমা খাতুন',
  signatureUrl: 'https://cdn.example/mpur-sign.png',
});

/** A school that has filled in nothing but its name. Day one. */
const BARE: Branding = parseBranding({ nameBn: 'নতুন বিদ্যালয়' });

const RAFI: StudentRef = {
  nameBn: 'রাফি হাসান',
  nameEn: 'Rafi Hasan',
  studentCode: '2024-0091',
  classBn: 'নবম শ্রেণি',
  groupBn: 'বিজ্ঞান',
  section: 'F',
  rollNo: 7,
  fatherNameBn: 'মোঃ হাসান',
  motherNameBn: 'রোকসানা বেগম',
  admissionDate: '2024-01-05',
  bloodGroup: 'B+',
};

const RECEIPT = {
  student: RAFI,
  receiptNo: 'RCP-2026-00001',
  issuedAt: '2026-05-12T09:15:00Z',
  amount: '1300.00',
  method: 'bkash',
  invoiceNo: 'INV-2026-05-00001',
  billingPeriod: '2026-05',
  lines: [
    { descriptionBn: 'মাসিক বেতন', amount: '1200.00', waiver: '200.00' },
    { descriptionBn: 'পরীক্ষার ফি', amount: '300.00', waiver: '0.00' },
  ],
  invoiceTotal: '1300.00',
  paidToDate: '1300.00',
  balance: '0.00',
};

const REPORT = {
  student: RAFI,
  examNameBn: 'অর্ধবার্ষিক পরীক্ষা',
  yearLabel: '২০২৬',
  subjects: [
    { nameBn: 'পদার্থবিজ্ঞান', obtained: '79', max: '100', grade: 'A', gradePoint: '4.00', isAbsent: false },
    { nameBn: 'রসায়ন', obtained: null, max: '100', grade: null, gradePoint: null, isAbsent: true },
  ],
  totalMarks: '79', totalMax: '200', percentage: '39.50', gpa: '2.00',
  letterGrade: 'C', isPass: false, rankInSection: 12, attendancePercent: '94.50',
};

// ── The multi-tenant property, which is the whole phase ─────────────────

describe('one codebase, two institutions', () => {
  const forA = brandedDocument({ branding: MONIPUR, ...buildFeeReceipt(RECEIPT) });
  const forB = brandedDocument({ branding: MOHAMMADPUR, ...buildFeeReceipt(RECEIPT) });

  test('THE ONE THAT MATTERS — neither school appears on the other’s receipt', () => {
    assert.match(forA, /মনিপুর উচ্চ বিদ্যালয়/);
    assert.doesNotMatch(forA, /মোহাম্মদপুর/);
    assert.match(forB, /মোহাম্মদপুর কলেজ/);
    assert.doesNotMatch(forB, /মনিপুর/);
  });

  test('logos, colours, watermarks and signatures all differ', () => {
    assert.match(forA, /monipur-logo\.png/);
    assert.match(forB, /mpur-logo\.png/);
    assert.doesNotMatch(forA, /mpur-logo\.png/);

    assert.match(forA, /#1B5E20/i);
    assert.match(forB, /#0D47A1/i);

    assert.match(forA, /monipur-mark\.png/);
    assert.match(forB, /mpur-mark\.png/);

    assert.match(forA, /monipur-sign\.png/);
    assert.match(forB, /mpur-sign\.png/);
  });

  test('each head signs their own school’s document', () => {
    assert.match(forA, /মোঃ আব্দুল কাদের/);
    assert.match(forB, /ড\. সালমা খাতুন/);
    assert.doesNotMatch(forA, /সালমা/);
  });

  test('the platform brand never appears as the institution', () => {
    // D11: shikhonBD is the platform's brand and belongs on the marketing
    // site, never on a school's official document.
    for (const html of [forA, forB]) {
      assert.doesNotMatch(html, /shikhon/i);
    }
  });

  test('the student data is identical — only the identity changed', () => {
    for (const html of [forA, forB]) {
      assert.match(html, /রাফি হাসান/);
      assert.match(html, /RCP-2026-00001/);
    }
  });
});

// ── Degrading, not breaking ────────────────────────────────────────────

describe('a school that has uploaded nothing', () => {
  const html = brandedDocument({ branding: BARE, ...buildFeeReceipt(RECEIPT) });

  test('still produces a usable receipt', () => {
    assert.match(html, /নতুন বিদ্যালয়/);
    assert.match(html, /RCP-2026-00001/);
    assert.match(html, /রাফি হাসান/);
  });

  test('renders no broken image for a missing logo, watermark or signature', () => {
    // §14: never a broken image, never another tenant's asset.
    // Assert on the ELEMENT, not the class name: the stylesheet is inlined
    // into every document, so the "doc-sign-img" rule is present whether or
    // not an <img> is. The first version of this test matched the rule and
    // failed on correct output.
    assert.doesNotMatch(html, /<img[^>]*src=""/);
    assert.doesNotMatch(html, /<div class="doc-watermark"/);
    assert.doesNotMatch(html, /<img class="doc-sign-img"/);
    // The gap where the image would have been keeps the block's height.
    assert.match(html, /doc-sign-gap/);
  });

  test('but still prints the signature RULE, so it can be signed by hand', () => {
    // A document a head signs with a pen is still a valid document, and the
    // line is what makes that possible.
    assert.match(html, /<div class="doc-sign-rule">/);
  });

  test('a hostile institution name cannot inject markup', () => {
    const hostile = parseBranding({ nameBn: '<img src=x onerror=alert(1)>খারাপ' });
    const out = brandedDocument({ branding: hostile, ...buildFeeReceipt(RECEIPT) });
    assert.doesNotMatch(out, /<img src=x/);
    assert.match(out, /&lt;img src=x/);
  });

  test('nor can a student name typed by an office', () => {
    const evil = buildFeeReceipt({
      ...RECEIPT,
      student: { ...RAFI, nameBn: '<script>x</script>রাফি' },
    });
    const out = brandedDocument({ branding: MONIPUR, ...evil });
    assert.doesNotMatch(out, /<script>/);
    assert.match(out, /&lt;script&gt;/);
  });
});

// ── Localisation ───────────────────────────────────────────────────────

describe('Bangla, not almost-Bangla', () => {
  test('no ISO date reaches an official document', () => {
    for (const body of [
      buildFeeReceipt(RECEIPT),
      buildReportCard(REPORT),
      buildTransferCertificate({
        student: RAFI, certificateNo: 'TC-২০২৬-0091', issuedOn: '2026-07-01',
        lastClassBn: 'নবম শ্রেণি', lastYearLabel: '২০২৬', admissionDate: '2024-01-05',
        leftOn: '2026-06-30', conductBn: 'সন্তোষজনক',
        reasonBn: 'অভিভাবকের আবেদনের প্রেক্ষিতে।', duesCleared: true,
      }),
    ]) {
      const html = brandedDocument({ branding: MONIPUR, ...body });
      // Identifiers legitimately look date-shaped (INV-2026-05-00001), so the
      // sweep drops the stylesheet and the document numbers first, then looks
      // for anything still shaped like a machine date.
      const prose = html
        .replace(/<style>[\s\S]*?<\/style>/, '')
        .replace(/\b(?:INV|RCP|TC)-[\w-]+/g, '');
      assert.doesNotMatch(prose, /\d{4}-\d{2}-\d{2}/,
        `${body.title} leaked an ISO date`);
      assert.doesNotMatch(prose, /\b\d{4}-\d{2}\b/,
        `${body.title} leaked a raw billing period`);
    }
  });

  test('digits are Bangla in the body', () => {
    const html = brandedDocument({ branding: MONIPUR, ...buildReportCard(REPORT) });
    assert.match(html, /৭৯/, 'the mark');
    assert.match(html, /১২/, 'the rank');
  });

  test('an English document keeps Latin digits', () => {
    const html = brandedDocument({
      branding: MONIPUR, locale: 'en', ...buildReportCard(REPORT, 'en'),
    });
    assert.match(html, /Report Card/);
    assert.match(html, />79</);
  });

  test('a missing value is a dash, never "null" or "undefined"', () => {
    const thin = buildReportCard({
      ...REPORT, totalMarks: null, gpa: null, letterGrade: null,
      rankInSection: null, attendancePercent: null,
    });
    const html = brandedDocument({ branding: MONIPUR, ...thin });
    assert.doesNotMatch(html, /null|undefined|NaN/);
    assert.match(html, /—/);
  });
});

// ── Each document says the thing it exists to say ──────────────────────

describe('fee receipt', () => {
  const body = buildFeeReceipt(RECEIPT);
  const html = brandedDocument({ branding: MONIPUR, ...body });

  test('carries the receipt number and the fee lines', () => {
    assert.match(html, /RCP-2026-00001/);
    assert.match(html, /মাসিক বেতন/);
    assert.match(html, /পরীক্ষার ফি/);
  });

  test('shows the balance even when it is zero', () => {
    // "বকেয়া: ০" is the sentence a parent came to the counter for.
    assert.match(html, /বকেয়া/);
  });

  test('names the payment method in Bangla', () => {
    assert.match(html, /বিকাশ/);
  });

  test('an invoice with no lines says so rather than printing blank', () => {
    const empty = buildFeeReceipt({ ...RECEIPT, lines: [] });
    assert.match(empty.bodyHtml, /কোনো ফি বিবরণ নেই/);
  });
});

describe('report card', () => {
  const html = brandedDocument({ branding: MONIPUR, ...buildReportCard(REPORT) });

  test('lists every subject with its grade', () => {
    assert.match(html, /পদার্থবিজ্ঞান/);
    assert.match(html, /রসায়ন/);
  });

  test('an absent paper says absent rather than zero', () => {
    // A zero and an absence are different facts about a child.
    assert.match(html, /অনুপস্থিত/);
  });

  test('states pass or fail plainly', () => {
    assert.match(html, /অনুত্তীর্ণ/);
    const passing = buildReportCard({ ...REPORT, isPass: true });
    assert.match(passing.bodyHtml, /উত্তীর্ণ/);
  });

  test('an exam with no marks for this student says so', () => {
    const none = buildReportCard({ ...REPORT, subjects: [] });
    assert.match(none.bodyHtml, /কোনো বিষয়ের নম্বর নেই/);
  });
});

describe('admit card', () => {
  const body = buildAdmitCard({
    student: RAFI, examNameBn: 'অর্ধবার্ষিক পরীক্ষা', yearLabel: '২০২৬',
    papers: [
      { subjectBn: 'পদার্থবিজ্ঞান', examDate: '2026-06-12', startTime: '10:00:00',
        hallBn: 'হল ১', seat: '3-4' },
      { subjectBn: 'রসায়ন', examDate: '2026-06-14', startTime: null,
        hallBn: null, seat: null },
    ],
    instructionsBn: ADMIT_INSTRUCTIONS_BN,
  });

  test('prints the papers, the hall and the seat', () => {
    assert.match(body.bodyHtml, /পদার্থবিজ্ঞান/);
    assert.match(body.bodyHtml, /হল ১/);
  });

  test('prints a paper with no seat plan rather than refusing', () => {
    // A school that seats candidates on the day still needs the card.
    assert.match(body.bodyHtml, /রসায়ন/);
  });

  test('carries the instructions, and they name no school', () => {
    assert.match(body.bodyHtml, /৩০ মিনিট আগে/);
    for (const line of ADMIT_INSTRUCTIONS_BN) {
      assert.doesNotMatch(line, /মনিপুর|Monipur/,
        'instructions must be institution-neutral');
    }
  });

  test('an exam with no papers says so', () => {
    const none = buildAdmitCard({
      student: RAFI, examNameBn: 'x', yearLabel: '২০২৬',
      papers: [], instructionsBn: [],
    });
    assert.match(none.bodyHtml, /কোনো বিষয়সূচি এখনো নির্ধারিত হয়নি/);
  });
});

describe('ID card', () => {
  const body = buildIdCard({
    student: RAFI, yearLabel: '২০২৬', validUntil: '2026-12-31',
    guardianPhone: '+8801711000009',
  });

  test('has no signature block — a signature on a card is furniture', () => {
    assert.equal(body.showSignature, false);
    const html = brandedDocument({ branding: MONIPUR, ...body });
    assert.doesNotMatch(html, /<div class="doc-sign-rule">/);
  });

  test('leaves a photo FRAME rather than a broken image', () => {
    // `student_profiles.photo_key` exists and the storage behind it is
    // stubbed; an empty frame is what a school pastes into.
    assert.match(body.bodyHtml, /doc-photo/);
    assert.doesNotMatch(body.bodyHtml, /<img/);
  });

  test('carries the guardian number, which is what the card is FOR', () => {
    assert.match(body.bodyHtml, /8801711000009/);
  });
});

describe('transfer certificate', () => {
  const body = buildTransferCertificate({
    student: RAFI, certificateNo: 'TC-২০২৬-2024-0091', issuedOn: '2026-07-01',
    lastClassBn: 'নবম শ্রেণি', lastYearLabel: '২০২৬', admissionDate: '2024-01-05',
    leftOn: '2026-06-30', conductBn: 'সন্তোষজনক',
    reasonBn: 'অভিভাবকের আবেদনের প্রেক্ষিতে তাহাকে ছাড়পত্র প্রদান করা হইল।',
    duesCleared: true,
  });

  test('reads as a letter, naming the child and the parents', () => {
    assert.match(body.bodyHtml, /প্রত্যয়ন করা যাইতেছে/);
    assert.match(body.bodyHtml, /রাফি হাসান/);
    assert.match(body.bodyHtml, /মোঃ হাসান/);
  });

  test('states dues cleared', () => {
    assert.match(body.bodyHtml, /বকেয়া নাই/);
  });

  test('and states them UNCLEARED rather than omitting it', () => {
    // An office issuing a TC with dues outstanding has made a decision; the
    // document should show it rather than quietly imply the opposite.
    const owing = buildTransferCertificate({
      student: RAFI, certificateNo: 'TC-1', issuedOn: '2026-07-01',
      lastClassBn: 'নবম শ্রেণি', lastYearLabel: '২০২৬', admissionDate: null,
      leftOn: null, conductBn: 'সন্তোষজনক', reasonBn: 'x', duesCleared: false,
    });
    assert.match(owing.bodyHtml, /পরিশোধিত হয় নাই/);
  });
});

describe('attendance sheet', () => {
  const body = buildAttendanceSheet({
    classBn: 'নবম শ্রেণি', groupBn: 'বিজ্ঞান', section: 'F', yearLabel: '২০২৬',
    monthBn: 'অক্টোবর 2026',
    students: [
      { rollNo: 1, nameBn: 'রাফি' }, { rollNo: 2, nameBn: 'সাদিয়া' },
    ],
    dayColumns: 31,
  });

  test('draws a blank grid with the names already filled in', () => {
    assert.match(body.bodyHtml, /রাফি/);
    assert.match(body.bodyHtml, /সাদিয়া/);
    assert.match(body.bodyHtml, /doc-table-grid/);
  });

  test('is signed by the class teacher, not the head', () => {
    assert.equal(body.signatureCaption, 'শ্রেণি শিক্ষক');
  });

  test('carries no marks, attendance history or guardian details', () => {
    // It sits on a classroom desk all month.
    assert.doesNotMatch(body.bodyHtml, /জিপিএ|অভিভাবক|মোবাইল/);
  });

  test('an empty section says so instead of printing an empty grid', () => {
    const none = buildAttendanceSheet({
      classBn: 'ক', groupBn: null, section: 'ক', yearLabel: '২০২৬',
      monthBn: 'মে', students: [], dayColumns: 31,
    });
    assert.match(none.bodyHtml, /কোনো শিক্ষার্থী নেই/);
  });
});

// ── Bulk ───────────────────────────────────────────────────────────────

describe('forty report cards in one go', () => {
  const forty = Array.from({ length: 40 }, (_, i) => buildReportCard({
    ...REPORT,
    student: { ...RAFI, nameBn: `শিক্ষার্থী ${i + 1}`, rollNo: i + 1 },
  }));
  const html = brandedDocumentSet({
    branding: MONIPUR, sections: forty, extraCss: documentBodyCss(),
  });

  test('THE ONE THAT MATTERS — forty pages, each fully branded', () => {
    // Count ELEMENTS, not class tokens — the stylesheet is inlined once and
    // names every one of these classes, so a bare-token count is off by the
    // number of CSS rules rather than measuring the pages.
    assert.equal((html.match(/<main class="doc">/g) ?? []).length, 40);
    // Not one letterhead at the top and thirty-nine bare pages.
    assert.equal((html.match(/<header class="doc-head">/g) ?? []).length, 40);
    assert.equal((html.match(/<div class="doc-watermark"><\/div>/g) ?? []).length, 40,
      'every page carries the watermark');
    assert.equal((html.match(/<div class="doc-sign-rule"><\/div>/g) ?? []).length, 40);
  });

  test('and it is ONE html document, not forty', () => {
    assert.equal((html.match(/<!doctype html>/gi) ?? []).length, 1);
  });

  test('with a page break between them', () => {
    assert.match(html, /\.doc\+\.doc\{page-break-before:always/);
    assert.match(html, /break-before:page/);
  });

  test('long tables repeat their header and never split a row', () => {
    assert.match(html, /thead\{display:table-header-group\}/);
    assert.match(html, /\.doc-table tr\{page-break-inside:avoid/);
  });

  test('the signature block is never split across a page', () => {
    assert.match(html, /\.doc-foot,\.doc-sign\{page-break-inside:avoid/);
  });

  test('every student appears exactly once', () => {
    for (let i = 1; i <= 40; i++) {
      assert.equal((html.match(new RegExp(`শিক্ষার্থী ${i}<`, 'g')) ?? []).length, 1);
    }
  });
});

// ── The catalogue ──────────────────────────────────────────────────────

describe('the document set', () => {
  test('every type has a Bangla title', () => {
    for (const [kind, title] of Object.entries(DOCUMENT_TITLES_BN)) {
      assert.ok(title.length > 0, kind);
      assert.doesNotMatch(title, /[A-Za-z]/, `${kind} title should be Bangla`);
    }
  });

  test('the bulk-capable set is the one that makes sense per student', () => {
    assert.deepEqual([...BULK_CAPABLE].sort(),
      ['admit_card', 'id_card', 'report_card']);
  });

  test('A4 and print rules are present in every document', () => {
    const html = brandedDocument({ branding: MONIPUR, ...buildFeeReceipt(RECEIPT) });
    assert.match(html, /@page\{size:A4/);
    assert.match(html, /print-color-adjust:exact/,
      'browsers strip background imagery from print by default — the watermark needs this');
  });
});
