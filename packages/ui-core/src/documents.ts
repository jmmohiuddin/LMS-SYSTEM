/**
 * The documents a school prints.  (R-5, docs/11-MASTER-PLAN.md)
 *
 * R-1 built the letterhead every printed thing sits on — logo, name, address,
 * watermark, signature — and said outright that the documents themselves are
 * R-5. This is that: one builder per document type, each producing the BODY
 * that `brandedDocument()` wraps in the tenant's identity.
 *
 * ── One renderer, six documents ─────────────────────────────────────────
 *
 *     data ──► buildX() ──► { title, meta, bodyHtml }
 *                              │
 *              branding ──► brandedDocument() ──► standalone printable HTML
 *
 * Every builder returns the same shape and none of them knows anything about
 * branding, colours or page furniture. That is the whole point: a school's
 * identity is applied in exactly one place, so adding a seventh document type
 * cannot accidentally produce one that prints unbranded — and changing the
 * letterhead changes all six.
 *
 * ── Pure strings, no DOM ────────────────────────────────────────────────
 * Same reason as branded-doc.ts: printing means handing complete markup to a
 * print window or a future server-side renderer, and a module with no
 * `document` dependency is testable in plain `node --test` and reusable from
 * a worker. Every builder here is a pure function of its input.
 *
 * ── Everything is escaped, without exception ────────────────────────────
 * These bodies interpolate student names, guardian names, remarks typed by a
 * teacher and institution text typed by an IT user. `escapeHtml` is applied
 * to every interpolation, including the ones that "obviously" cannot contain
 * markup — that judgement is what rots.
 *
 * ── Bangla is the default, and numerals follow ──────────────────────────
 * A report card that says "Class 9" and "৯ম শ্রেণি" in the same line is not
 * bilingual, it is unfinished. Digits go through `toBanglaDigits` for the bn
 * locale, money through `formatBdt`, and dates through the local `date()` /
 * `monthLabel()` helpers — NOT `formatShortDate`, which is the SMS form and
 * drops the year to save characters. No ISO date reaches an official document.
 */
import { type Branding } from './branding.ts';
import { escapeHtml } from './branded-doc.ts';
import {
  toBanglaDigits, formatBdt, formatDayMonth, formatTime, ordinalBn, type Locale,
} from './format.ts';

/**
 * The six the master plan names, in its own order of daily-habit frequency.
 *
 * `attendance_sheet` is the blank-grid paper fallback: a school whose network
 * is down still has to take a register, and a printed grid is what it falls
 * back to. It carries no student data beyond names and rolls.
 */
export type DocumentType =
  | 'fee_receipt'
  | 'report_card'
  | 'admit_card'
  | 'id_card'
  | 'transfer_certificate'
  | 'attendance_sheet'
  // P9-9. The one a school pins to a noticeboard. Unlike the six above it
  // is not about a student — it is about the institution's week — so it is
  // the first here that takes no `StudentRef` at all.
  | 'routine_sheet';

export const DOCUMENT_TITLES_BN: Record<DocumentType, string> = {
  fee_receipt: 'ফি রসিদ',
  report_card: 'প্রগতি পত্র',
  admit_card: 'প্রবেশপত্র',
  id_card: 'পরিচয়পত্র',
  transfer_certificate: 'ছাড়পত্র',
  attendance_sheet: 'হাজিরা শিট',
  routine_sheet: 'ক্লাস রুটিন',
};

const DOCUMENT_TITLES_EN: Record<DocumentType, string> = {
  fee_receipt: 'Fee Receipt',
  report_card: 'Report Card',
  admit_card: 'Admit Card',
  id_card: 'Identity Card',
  transfer_certificate: 'Transfer Certificate',
  attendance_sheet: 'Attendance Sheet',
  routine_sheet: 'Class Routine',
};

/** Which documents are naturally produced for a whole section at once. */
export const BULK_CAPABLE: DocumentType[] = ['report_card', 'admit_card', 'id_card'];

export interface DocumentBody {
  title: string;
  meta: { label: string; value: string }[];
  bodyHtml: string;
  showSignature?: boolean;
  signatureCaption?: string;
}

// ── shared helpers ──────────────────────────────────────────────────────

/** Digits a reader of this locale expects. */
function num(v: number | string | null | undefined, locale: Locale): string {
  if (v === null || v === undefined || v === '') return '—';
  return locale === 'bn' ? toBanglaDigits(String(v)) : String(v);
}

/**
 * A date on an official document — with its YEAR.
 *
 * Deliberately not `formatShortDate`, which is documented as the short form
 * "for SMS, where every character costs money" and drops the year entirely.
 * A receipt dated ১২/০৫ is one nobody can file, and reaching for the SMS
 * formatter here is the kind of reuse that looks harmless until somebody
 * needs the document two years later. Caught by a test that swept whole
 * documents for date-shaped text.
 */
function date(iso: string | null | undefined, locale: Locale): string {
  if (!iso) return '—';
  const day = String(iso).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return day;
  return `${formatDayMonth(day, locale)} ${num(day.slice(0, 4), locale)}`;
}

/**
 * A billing period as a person reads it: '2026-05' → 'মে ২০২৬'.
 *
 * The stored value is a machine key, and printing it on a receipt is exactly
 * the raw-ISO leak §18 rules out.
 */
function monthLabel(period: string, locale: Locale): string {
  if (!/^\d{4}-\d{2}$/.test(period)) return period;
  const month = formatDayMonth(`${period}-01`, locale).replace(/^\S+\s/, '');
  return `${month} ${num(period.slice(0, 4), locale)}`;
}

/** A label/value definition list — the shape most of these documents are. */
function fields(rows: [string, string][]): string {
  return [
    '<dl class="doc-fields">',
    ...rows.map(([k, v]) =>
      `<div><dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd></div>`),
    '</dl>',
  ].join('');
}

function table(headers: string[], rows: string[][], cls = ''): string {
  return [
    `<table class="doc-table${cls ? ' ' + cls : ''}">`,
    '<thead><tr>',
    ...headers.map((h) => `<th>${escapeHtml(h)}</th>`),
    '</tr></thead><tbody>',
    ...rows.map((r) => '<tr>' + r.map((c) => `<td>${escapeHtml(c)}</td>`).join('') + '</tr>'),
    '</tbody></table>',
  ].join('');
}

function titleFor(type: DocumentType, locale: Locale): string {
  return locale === 'en' ? DOCUMENT_TITLES_EN[type] : DOCUMENT_TITLES_BN[type];
}

/** The person a document is about, as every builder needs them. */
export interface StudentRef {
  nameBn: string;
  nameEn?: string | null;
  studentCode?: string | null;
  classBn?: string | null;
  groupBn?: string | null;
  section?: string | null;
  rollNo?: number | null;
  fatherNameBn?: string | null;
  motherNameBn?: string | null;
  dateOfBirth?: string | null;
  admissionDate?: string | null;
  bloodGroup?: string | null;
}

function studentFields(s: StudentRef, locale: Locale): [string, string][] {
  const out: [string, string][] = [['শিক্ষার্থীর নাম', s.nameBn]];
  if (s.studentCode) out.push(['আইডি', s.studentCode]);
  if (s.classBn) out.push(['শ্রেণি', s.groupBn ? `${s.classBn} · ${s.groupBn}` : s.classBn]);
  if (s.section) out.push(['শাখা', s.section]);
  if (s.rollNo != null) out.push(['রোল', num(s.rollNo, locale)]);
  return out;
}

// ── 1. Fee receipt ──────────────────────────────────────────────────────

export interface ReceiptData {
  student: StudentRef;
  receiptNo: string;
  issuedAt: string;
  amount: string;
  method: string;
  invoiceNo: string;
  billingPeriod: string;
  lines: { descriptionBn: string; amount: string; waiver: string }[];
  invoiceTotal: string;
  paidToDate: string;
  balance: string;
}

const METHOD_BN: Record<string, string> = {
  bkash: 'বিকাশ', nagad: 'নগদ', rocket: 'রকেট',
  cash: 'নগদ (হাতে)', bank: 'ব্যাংক', cheque: 'চেক',
};

/**
 * The document the master plan's exit criterion is about: "a guardian pays;
 * the office prints a receipt with the school's logo, watermark and
 * signature."
 *
 * The balance is printed even when it is zero, because "বকেয়া: ০" is the
 * sentence a parent came to the counter for. A receipt that omits it leaves
 * them asking.
 */
export function buildFeeReceipt(d: ReceiptData, locale: Locale = 'bn'): DocumentBody {
  const lines = d.lines.length > 0
    ? table(
        ['বিবরণ', 'টাকা', 'মওকুফ'],
        d.lines.map((l) => [
          l.descriptionBn,
          formatBdt(l.amount),
          Number(l.waiver) > 0 ? formatBdt(l.waiver) : '—',
        ]),
        'doc-table-money')
    // An invoice with no lines is a data problem, not a reason to print a
    // blank page: say so on the document so the office sees it.
    : '<p class="doc-note">এই ইনভয়েসে কোনো ফি বিবরণ নেই।</p>';

  return {
    title: titleFor('fee_receipt', locale),
    meta: [
      { label: 'রসিদ নম্বর', value: d.receiptNo },
      { label: 'তারিখ', value: date(d.issuedAt, locale) },
    ],
    bodyHtml: [
      fields([
        ...studentFields(d.student, locale),
        ['ইনভয়েস', d.invoiceNo],
        ['মাস', monthLabel(d.billingPeriod, locale)],
      ]),
      lines,
      '<div class="doc-total">',
      `<div><span>মোট বিল</span><b>${escapeHtml(formatBdt(d.invoiceTotal))}</b></div>`,
      `<div class="doc-total-paid"><span>এই রসিদে জমা</span><b>${escapeHtml(formatBdt(d.amount))}</b></div>`,
      `<div><span>মোট জমা</span><b>${escapeHtml(formatBdt(d.paidToDate))}</b></div>`,
      `<div><span>বকেয়া</span><b>${escapeHtml(formatBdt(d.balance))}</b></div>`,
      '</div>',
      `<p class="doc-note">পরিশোধের মাধ্যম: ${escapeHtml(METHOD_BN[d.method] ?? d.method)}</p>`,
    ].join(''),
  };
}

// ── 2. Report card ──────────────────────────────────────────────────────

export interface ReportCardData {
  student: StudentRef;
  examNameBn: string;
  yearLabel: string;
  subjects: {
    nameBn: string;
    obtained: string | null;
    max: string | null;
    grade: string | null;
    gradePoint: string | null;
    isAbsent: boolean;
  }[];
  totalMarks: string | null;
  totalMax: string | null;
  percentage: string | null;
  gpa: string | null;
  letterGrade: string | null;
  isPass: boolean;
  rankInSection: number | null;
  attendancePercent: string | null;
}

/**
 * Marks come from `exam_marks` and the summary from `exam_results` — both
 * authoritative, neither copied. The master plan is explicit that this must
 * not become a second data model for results, and a report card that
 * recomputed a GPA would be a second implementation of the board's rules,
 * disagreeing with the published one on exactly the borderline child.
 */
export function buildReportCard(d: ReportCardData, locale: Locale = 'bn'): DocumentBody {
  const rows = d.subjects.map((s) => [
    s.nameBn,
    s.isAbsent ? 'অনুপস্থিত' : num(s.obtained, locale),
    num(s.max, locale),
    s.isAbsent ? '—' : (s.grade ?? '—'),
    s.isAbsent ? '—' : num(s.gradePoint, locale),
  ]);

  const summary: [string, string][] = [
    ['মোট নম্বর', `${num(d.totalMarks, locale)} / ${num(d.totalMax, locale)}`],
    ['শতকরা', d.percentage ? `${num(d.percentage, locale)}%` : '—'],
    ['জিপিএ', num(d.gpa, locale)],
    ['গ্রেড', d.letterGrade ?? '—'],
    ['ফলাফল', d.isPass ? 'উত্তীর্ণ' : 'অনুত্তীর্ণ'],
  ];
  if (d.rankInSection != null) summary.push(['শাখায় স্থান', num(d.rankInSection, locale)]);
  if (d.attendancePercent) summary.push(['উপস্থিতি', `${num(d.attendancePercent, locale)}%`]);

  return {
    title: titleFor('report_card', locale),
    meta: [
      { label: 'পরীক্ষা', value: d.examNameBn },
      { label: 'শিক্ষাবর্ষ', value: d.yearLabel },
    ],
    bodyHtml: [
      fields(studentFields(d.student, locale)),
      d.subjects.length > 0
        ? table(['বিষয়', 'প্রাপ্ত', 'পূর্ণমান', 'গ্রেড', 'পয়েন্ট'], rows)
        // Publishing sets the result row; a card with no subject marks means
        // the exam had no papers for this student's section.
        : '<p class="doc-note">এই পরীক্ষায় এই শিক্ষার্থীর কোনো বিষয়ের নম্বর নেই।</p>',
      '<div class="doc-summary">',
      fields(summary),
      '</div>',
    ].join(''),
    signatureCaption: undefined,
  };
}

// ── 3. Admit card ───────────────────────────────────────────────────────

export interface AdmitCardData {
  student: StudentRef;
  examNameBn: string;
  yearLabel: string;
  papers: {
    subjectBn: string;
    examDate: string | null;
    startTime: string | null;
    hallBn: string | null;
    seat: string | null;
  }[];
  instructionsBn: string[];
}

/**
 * Seat and hall come from `exam_seats` when a seat plan has been drawn and
 * are simply blank when it has not — a school that seats candidates on the
 * day still needs the card printed with the paper dates on it. Refusing to
 * print until a seat plan exists would be the system deciding how the school
 * runs its exam.
 */
export function buildAdmitCard(d: AdmitCardData, locale: Locale = 'bn'): DocumentBody {
  const rows = d.papers.map((p) => [
    p.subjectBn,
    date(p.examDate, locale),
    p.startTime ? num(p.startTime.slice(0, 5), locale) : '—',
    p.hallBn ?? '—',
    p.seat ? num(p.seat, locale) : '—',
  ]);

  return {
    title: titleFor('admit_card', locale),
    meta: [
      { label: 'পরীক্ষা', value: d.examNameBn },
      { label: 'শিক্ষাবর্ষ', value: d.yearLabel },
    ],
    bodyHtml: [
      fields(studentFields(d.student, locale)),
      d.papers.length > 0
        ? table(['বিষয়', 'তারিখ', 'সময়', 'হল', 'আসন'], rows)
        : '<p class="doc-note">এই পরীক্ষার কোনো বিষয়সূচি এখনো নির্ধারিত হয়নি।</p>',
      d.instructionsBn.length > 0
        ? '<div class="doc-rules"><h3>নির্দেশাবলি</h3><ol>'
          + d.instructionsBn.map((i) => `<li>${escapeHtml(i)}</li>`).join('')
          + '</ol></div>'
        : '',
    ].join(''),
  };
}

/** What every Bangladeshi admit card says. Institution-neutral by design. */
export const ADMIT_INSTRUCTIONS_BN = [
  'পরীক্ষার নির্ধারিত সময়ের ৩০ মিনিট আগে পরীক্ষাকক্ষে উপস্থিত থাকতে হবে।',
  'প্রবেশপত্র ছাড়া কোনো পরীক্ষার্থীকে পরীক্ষাকক্ষে প্রবেশ করতে দেওয়া হবে না।',
  'মোবাইল ফোন বা কোনো ইলেকট্রনিক ডিভাইস সঙ্গে আনা যাবে না।',
  'প্রবেশপত্রটি পরীক্ষা শেষ না হওয়া পর্যন্ত সংরক্ষণ করতে হবে।',
];

// ── 4. Student ID card ──────────────────────────────────────────────────

export interface IdCardData {
  student: StudentRef;
  yearLabel: string;
  validUntil: string | null;
  guardianPhone?: string | null;
}

/**
 * A compact block, and `showSignature: false`, because a signature line on
 * something the size of a card is furniture.
 *
 * It still sits on the A4 letterhead, like every other document, and that is
 * a known limitation rather than a design: a school printing a section's
 * cards gets one card per sheet and cuts them out. Laying several to a page
 * needs a second page geometry the renderer does not have yet, and inventing
 * one here would mean a second print path to keep correct. Recorded in the
 * R-5 entry of docs/PHASE_LOG.md so it is a decision, not an oversight.
 *
 * The photo is a box, not an image: `student_profiles.photo_key` exists and
 * the object storage behind it is stubbed until an R2/S3 credential lands
 * (see academics-svc/api/scripts.ts). Printing an empty frame the school can
 * paste into is what schools did before this product and is honest; a broken
 * image icon is not.
 */
export function buildIdCard(d: IdCardData, locale: Locale = 'bn'): DocumentBody {
  return {
    title: titleFor('id_card', locale),
    meta: [{ label: 'শিক্ষাবর্ষ', value: d.yearLabel }],
    showSignature: false,
    bodyHtml: [
      '<div class="doc-idcard">',
      '<div class="doc-photo" aria-hidden="true"><span>ছবি</span></div>',
      '<div class="doc-idcard-body">',
      fields([
        ...studentFields(d.student, locale),
        ...(d.student.bloodGroup ? [['রক্তের গ্রুপ', d.student.bloodGroup] as [string, string]] : []),
        ...(d.guardianPhone ? [['অভিভাবকের মোবাইল', d.guardianPhone] as [string, string]] : []),
        ...(d.validUntil ? [['মেয়াদ', date(d.validUntil, locale)] as [string, string]] : []),
      ]),
      '</div>',
      '</div>',
    ].join(''),
  };
}

// ── 5. Transfer certificate ─────────────────────────────────────────────

export interface TransferCertificateData {
  student: StudentRef;
  certificateNo: string;
  issuedOn: string;
  lastClassBn: string;
  lastYearLabel: string;
  admissionDate: string | null;
  leftOn: string | null;
  conductBn: string;
  reasonBn: string;
  duesCleared: boolean;
}

/**
 * A letter, not a form, so it reads as prose — this is a document a parent
 * hands to another institution and a form-shaped one looks provisional.
 *
 * The history comes from `enrolments`, which R-3 established is never
 * overwritten. That is the whole reason a transfer certificate can be issued
 * years later and still be true.
 */
export function buildTransferCertificate(
  d: TransferCertificateData, locale: Locale = 'bn',
): DocumentBody {
  const name = escapeHtml(d.student.nameBn);
  const father = d.student.fatherNameBn ? escapeHtml(d.student.fatherNameBn) : null;
  const mother = d.student.motherNameBn ? escapeHtml(d.student.motherNameBn) : null;

  const parentage = [
    father ? `পিতা: ${father}` : null,
    mother ? `মাতা: ${mother}` : null,
  ].filter(Boolean).join(', ');

  return {
    title: titleFor('transfer_certificate', locale),
    meta: [
      { label: 'ছাড়পত্র নম্বর', value: d.certificateNo },
      { label: 'ইস্যুর তারিখ', value: date(d.issuedOn, locale) },
    ],
    bodyHtml: [
      '<div class="doc-letter">',
      `<p>এই মর্মে প্রত্যয়ন করা যাইতেছে যে, <b>${name}</b>`,
      parentage ? `, ${escapeHtml(parentage)},` : ',',
      ` এই প্রতিষ্ঠানের ${escapeHtml(d.lastYearLabel)} শিক্ষাবর্ষে`,
      ` <b>${escapeHtml(d.lastClassBn)}</b> শ্রেণিতে অধ্যয়নরত ছিল।</p>`,
      d.admissionDate
        ? `<p>সে ${escapeHtml(date(d.admissionDate, locale))} তারিখে এই প্রতিষ্ঠানে ভর্তি হয়`
          + (d.leftOn ? ` এবং ${escapeHtml(date(d.leftOn, locale))} তারিখ পর্যন্ত অধ্যয়ন করে।</p>` : '।</p>')
        : '',
      `<p>আমার জানামতে তাহার আচরণ <b>${escapeHtml(d.conductBn)}</b>।`,
      d.duesCleared
        ? ' প্রতিষ্ঠানের কোনো পাওনা তাহার নিকট বকেয়া নাই।'
        // Stated rather than omitted: an office issuing a TC with dues
        // outstanding has made a decision, and the document should show it.
        : ' প্রতিষ্ঠানের পাওনা সম্পূর্ণ পরিশোধিত হয় নাই।',
      '</p>',
      `<p>${escapeHtml(d.reasonBn)}</p>`,
      '<p>আমি তাহার ভবিষ্যৎ জীবনের সর্বাঙ্গীণ সাফল্য কামনা করি।</p>',
      '</div>',
      fields(studentFields(d.student, locale)),
    ].join(''),
  };
}

// ── 6. Attendance sheet ─────────────────────────────────────────────────

export interface AttendanceSheetData {
  classBn: string;
  groupBn: string | null;
  section: string;
  yearLabel: string;
  monthBn: string;
  students: { rollNo: number; nameBn: string }[];
  /** How many day columns to draw. A month, typically. */
  dayColumns: number;
}

/**
 * The paper fallback. A school whose network is down still has to take a
 * register, and this is what it prints — a blank grid with the roll and the
 * names already filled in, which is the part that takes an hour by hand.
 *
 * It deliberately carries no marks, no attendance history and no guardian
 * details: it is going to sit on a desk in a classroom all month.
 */
export function buildAttendanceSheet(
  d: AttendanceSheetData, locale: Locale = 'bn',
): DocumentBody {
  const days = Array.from({ length: d.dayColumns }, (_, i) => num(i + 1, locale));
  const head = ['রোল', 'নাম', ...days];
  const rows = d.students.map((s) => [
    num(s.rollNo, locale), s.nameBn, ...days.map(() => ''),
  ]);

  return {
    title: titleFor('attendance_sheet', locale),
    meta: [
      { label: 'শ্রেণি', value: d.groupBn ? `${d.classBn} · ${d.groupBn}` : d.classBn },
      { label: 'শাখা', value: d.section },
      { label: 'মাস', value: d.monthBn },
    ],
    showSignature: true,
    signatureCaption: 'শ্রেণি শিক্ষক',
    bodyHtml: d.students.length > 0
      ? table(head, rows, 'doc-table-grid')
      : '<p class="doc-note">এই শাখায় কোনো শিক্ষার্থী নেই।</p>',
  };
}

// ── The document-level CSS these bodies need ────────────────────────────

/**
 * Styling for the body shapes above, appended to `brandedDocumentCss()`.
 *
 * Kept here rather than in branded-doc.ts because these are the DOCUMENTS'
 * classes, not the letterhead's — R-1's foundation should stay the foundation
 * and not accumulate a rule for every table a later phase invents.
 *
 * The page-break rules are the part that matters for bulk: forty report cards
 * printed in one go must be forty pages, each with its own letterhead, and a
 * table that splits across a page must repeat its header. Browsers do neither
 * by default.
 */
/**
 * One printed routine — the grid a school pins up.  (P9-9)
 *
 * Takes the SAME data `GET /api/v1/rms/timetable` returns to the screen, so a
 * printed sheet and the screen it was printed from cannot disagree. There is
 * no second query and no second shape; this builder only lays it out.
 *
 * ── What the first version got wrong ─────────────────────────────────────
 * It was printable, and it was not readable. Three faults, all of which show
 * up only on paper:
 *
 *   1. A LESSON WAS FOUR LINES. Subject, class-section, teacher and room each
 *      took a line of their own, so a class of four sections put SIXTEEN
 *      lines in one cell and the grid compressed into a grey band. A notice
 *      board is read standing up, from a metre away, by somebody looking for
 *      one hour. Below, a cell in a multi-section sheet is ONE LINE per
 *      section — `ক  গণিত · রফিক · ১০১` — with the section label in a fixed
 *      column so the eye runs straight down it.
 *
 *   2. THE PERIOD NUMBERS WERE OFF BY ONE. `period_no` is a position in the
 *      school day, not a count of teaching hours, and tiffin holds position 5
 *      in the seeded day shift. Numbering the periods with `ordinalBn(6)`
 *      printed "৬ষ্ঠ" over the hour the school itself labels "৫ম". The school
 *      already typed the name it uses; `labelBn` is that name, and the
 *      ordinal is only a fallback for a template that left it blank.
 *
 *   3. TIFFIN WAS INVISIBLE. `period_definitions.kind` has seven values and
 *      migration 012 seeds four of them into every school — সমাবেশ, টিফিন,
 *      জোহর. The read filtered on `kind = 'teaching'` and threw the rest
 *      away, so the break the whole day is built around never reached the
 *      paper. It is now a band across the full width of the grid, which is
 *      also what makes the hours above and below it legible as morning and
 *      afternoon rather than as one undifferentiated column of nine.
 *
 * ── What each audience needs in the cell ─────────────────────────────────
 * §9 and §10 ask for teacher and room sheets that do not repeat what the page
 * is already about. A teacher's sheet says the section and the room; a room's
 * says the section and the teacher; a section's says the subject and who
 * teaches it. `omit` is that rule, and it is the same one the screen uses.
 */
export interface RoutineLesson {
  dayOfWeek: number;
  periodNo: number;
  startsAt: string;
  endsAt: string;
  subjectBn: string | null;
  teacherBn: string | null;
  roomBn: string | null;
  sectionLabel: string | null;
  classBn: string | null;
  classLevel: number | null;
  isParallel: boolean;
}

/** One row of the grid: a teaching hour, or a break the school observes. */
export interface RoutinePeriod {
  periodNo: number;
  /** The school's OWN name for this hour — "৫ম", "টিফিন", "সমাবেশ". */
  labelBn: string;
  startsAt: string;
  endsAt: string;
  /**
   * Defaults to 'teaching' so a caller that predates period kinds still gets
   * a correct grid rather than a page of bands.
   */
  kind?: string;
}

export interface RoutineSheetData {
  /** What this sheet is OF — "নবম শ্রেণি — ক", a teacher's name, a room. */
  scopeTitle: string;
  scopeKind: RoutineScope;
  yearLabel: string;
  shiftBn: string;
  version: number;
  /** ISO. Null when the routine predates the publish stamp. */
  publishedAt: string | null;
  days: Array<{ dow: number; bn: string }>;
  periods: RoutinePeriod[];
  lessons: RoutineLesson[];
  /** §12 — "পৃষ্ঠা ৩ / ৭" at the foot. Omitted for a single-page sheet. */
  pageNo?: number;
  pageCount?: number;
}

export type RoutineScope =
  | 'institution' | 'class' | 'group' | 'stream'
  | 'section' | 'teacher' | 'room' | 'student';

export const ROUTINE_SCOPE_BN: Record<RoutineScope, string> = {
  institution: 'প্রতিষ্ঠানের রুটিন',
  class: 'শ্রেণির রুটিন',
  group: 'বিভাগের রুটিন',
  stream: 'মাধ্যমের রুটিন',
  section: 'শাখার রুটিন',
  teacher: 'শিক্ষকের রুটিন',
  room: 'কক্ষের রুটিন',
  student: 'শিক্ষার্থীর রুটিন',
};

/**
 * Does a cell on this sheet hold ONE lesson, or one per section?  (§3, §13)
 *
 * This is the single fact the whole layout turns on — the orientation, the
 * shape of a cell and how many sections a page may carry all follow from it,
 * rather than from a per-scope flag somebody has to remember to keep in step.
 */
export function routineIsDense(scope: RoutineScope): boolean {
  return scope === 'institution' || scope === 'class'
      || scope === 'group' || scope === 'stream';
}

/**
 * Portrait or landscape, decided by how much goes in a cell.  (§3, §14)
 *
 * A section, a teacher, a room and a student each get ONE lesson per hour, so
 * six columns fit portrait A4 (182mm of usable width, ~30mm a column) and the
 * sheet reads the way a noticeboard notice should.
 *
 * A dense sheet stacks every section running at that hour. At 30mm those wrap
 * into slivers, so they take landscape — 269mm usable, ~45mm a column, which
 * is what a one-line lesson needs. §14 asks for a real `@page` size and this
 * is where it is decided.
 */
export function routineOrientation(scope: RoutineScope): 'portrait' | 'landscape' {
  return routineIsDense(scope) ? 'landscape' : 'portrait';
}

/**
 * What a cell need not carry: what the page is already about, and — on a
 * dense sheet — what there is no width for.
 *
 * The second half is measured. A landscape A4 gives a day column ~50mm, and a
 * dense cell spends it on one line per section. `বাংলাদেশ ও বিশ্বপরিচয়`
 * with a teacher's name already fills it; adding the room wraps EVERY line to
 * a second, and a second line costs ~3.9mm on every row of every page. The
 * room is on the section's own sheet, on the teacher's, and on the room's —
 * three places a person can look. A class notice board answers a different
 * question: which subject, and who is taking it.
 *
 * Measured on the small profile, per section per row:
 *   subject + teacher + room   11.2mm   -> 1 section a page
 *   subject + teacher           8.4mm   -> 2 sections a page
 */
function omit(scope: RoutineScope): { teacher: boolean; room: boolean; section: boolean } {
  return {
    teacher: scope === 'teacher',
    room: scope === 'room' || routineIsDense(scope),
    section: scope === 'section' || scope === 'student',
  };
}

/** A break, an assembly, a prayer — anything that is not a taught hour. */
function isBreak(p: RoutinePeriod): boolean {
  return (p.kind ?? 'teaching') !== 'teaching';
}

export function buildRoutineSheet(d: RoutineSheetData, locale: Locale = 'bn'): DocumentBody {
  const bn = locale === 'bn';
  const skip = omit(d.scopeKind);
  const dense = routineIsDense(d.scopeKind);

  const byCell = new Map<string, RoutineLesson[]>();
  for (const l of d.lessons) {
    const k = `${l.dayOfWeek}|${l.periodNo}`;
    if (!byCell.has(k)) byCell.set(k, []);
    byCell.get(k)!.push(l);
  }

  const head = [
    `<th class="rt-period-col">${escapeHtml(bn ? 'পিরিয়ড ও সময়' : 'Period & time')}</th>`,
    ...d.days.map((day) =>
      `<th>${escapeHtml(bn ? `${day.bn}বার` : day.bn)}</th>`),
  ].join('');

  const detail = (l: RoutineLesson): string => {
    const bits: string[] = [];
    if (!skip.teacher && l.teacherBn) bits.push(l.teacherBn);
    if (!skip.room && l.roomBn) bits.push(l.roomBn);
    return bits.length ? escapeHtml(bits.join(' · ')) : '';
  };

  const rows = d.periods.map((p) => {
    // §5. A break is a band across the whole grid, not a row of empty cells.
    // It is what turns nine numbered hours into a morning and an afternoon.
    if (isBreak(p)) {
      return `<tr class="rt-band"><td colspan="${d.days.length + 1}">`
        + `<span class="rt-band-name">${escapeHtml(
            bn ? toBanglaDigits(p.labelBn) : p.labelBn)}</span>`
        + `<span class="rt-band-time">${escapeHtml(
            `${formatTime(p.startsAt, locale)}–${formatTime(p.endsAt, locale)}`)}</span>`
        + '</td></tr>';
    }

    const cells = d.days.map((day) => {
      const here = byCell.get(`${day.dow}|${p.periodNo}`) ?? [];
      if (here.length === 0) return '<td class="rt-empty">—</td>';

      const inner = here.map((l) => {
        const subject = `<b>${escapeHtml(l.subjectBn ?? (bn ? 'ক্লাস' : 'Class'))}</b>`;
        const who = detail(l);
        const split = l.isParallel
          ? ` <i>${escapeHtml(bn ? 'বিভাজিত' : 'split')}</i>` : '';

        // ONE LINE per section on a dense sheet, with the section label in a
        // column of its own so a reader scans down it. This is the whole
        // difference between the first version and this one.
        if (dense && !skip.section) {
          return '<div class="rt-line">'
            + `<span class="rt-sec">${escapeHtml(l.sectionLabel ?? '·')}</span>`
            + `<span class="rt-what">${subject}`
            + (who ? ` <span class="rt-who">${who}</span>` : '') + split
            + '</span></div>';
        }
        // One lesson in the cell: it can afford a second line.
        const line2 = [
          skip.section || !l.sectionLabel ? '' : escapeHtml(
            `${l.classBn ? `${l.classBn}-` : ''}${l.sectionLabel}`),
          who,
        ].filter(Boolean).join(' · ');
        return `<div class="rt-lesson">${subject}${split}`
          + (line2 ? `<span class="rt-who">${line2}</span>` : '') + '</div>';
      }).join('');
      return `<td>${inner}</td>`;
    }).join('');

    // §5. Both the school's own name for the hour AND its clock time, and
    // neither of them as small print — this column is how a reader finds
    // their row at all.
    // The school's own name for the hour, with its digits in the reader's
    // numerals. Only the figures are localised; the words are the school's.
    // There is one label, not one per locale, so an English sheet shows the
    // same hour by the same name — the alternative is a computed number, and
    // a computed number is the off-by-one this replaced.
    const label = p.labelBn?.trim()
      ? (bn ? toBanglaDigits(p.labelBn.trim()) : p.labelBn.trim())
      : (bn ? ordinalBn(p.periodNo) : String(p.periodNo));
    return '<tr>'
      + '<th class="rt-period" scope="row">'
      + `<span class="rt-no">${escapeHtml(label)}</span>`
      + `<span class="rt-time">${escapeHtml(
          `${formatTime(p.startsAt, locale)}–${formatTime(p.endsAt, locale)}`)}</span>`
      + '</th>' + cells + '</tr>';
  }).join('');

  const meta: { label: string; value: string }[] = [
    { label: bn ? 'শিক্ষাবর্ষ' : 'Year', value: d.yearLabel },
    { label: bn ? 'শিফট' : 'Shift', value: d.shiftBn },
    { label: bn ? 'সংস্করণ' : 'Version', value: num(d.version, locale) },
  ];
  if (d.publishedAt) {
    meta.push({ label: bn ? 'প্রকাশ' : 'Published', value: date(d.publishedAt, locale) });
  }

  // §3. A dense page is a CLASS's page, so it says which of that class's
  // sections are on it. With a wide class split across pages (below), this
  // caption is the only thing that tells a reader which sheet is theirs.
  const sections = dense && !skip.section
    ? [...new Set(d.lessons.map((l) => l.sectionLabel).filter(Boolean))] as string[]
    : [];
  const caption = sections.length
    ? `<p class="rt-sections">${escapeHtml(
        (bn ? 'শাখা: ' : 'Sections: ') + sections.join(', '))}</p>`
    : '';

  // §12. The foot of every page, so a sheet torn off a board still says which
  // routine it is and whether a page is missing.
  const foot = [
    `${escapeHtml(bn ? 'সংস্করণ' : 'Version')} ${escapeHtml(num(d.version, locale))}`,
    d.publishedAt
      ? `${escapeHtml(bn ? 'প্রকাশ' : 'Published')} ${escapeHtml(date(d.publishedAt, locale))}`
      : '',
  ].filter(Boolean).join(' · ');
  const pager = d.pageNo && d.pageCount
    ? `<span>${escapeHtml(bn
        ? `পৃষ্ঠা ${num(d.pageNo, locale)} / ${num(d.pageCount, locale)}`
        : `Page ${d.pageNo} / ${d.pageCount}`)}</span>`
    : '';
  const sign = `<span class="rt-sign">${escapeHtml(
    bn ? 'প্রধান শিক্ষক' : 'Head of Institution')}</span>`;

  const empty = d.lessons.length === 0;
  return {
    // The letterhead above already carries the institution's name, so the
    // institution's own sheet does not repeat it — "প্রতিষ্ঠানের রুটিন —
    // ছোট স্কুল" under a heading that says ছোট স্কুল reads as a stutter.
    // Every other scope names the part it is of, which the letterhead cannot.
    title: d.scopeKind === 'institution'
      ? ROUTINE_SCOPE_BN[d.scopeKind]
      : `${ROUTINE_SCOPE_BN[d.scopeKind]} — ${d.scopeTitle}`,
    meta,
    bodyHtml: empty
      // §15's other half: a sheet with no lessons must say so rather than
      // print an empty grid somebody pins up and then wonders about.
      ? `<p class="doc-note">${escapeHtml(bn
          ? 'এই অংশের জন্য প্রকাশিত রুটিনে কোনো ক্লাস নেই।'
          : 'The published routine has no classes for this selection.')}</p>`
      : caption
        + `<table class="doc-table rt-grid"><thead><tr>${head}</tr></thead>`
        + `<tbody>${rows}</tbody></table>`
        + `<div class="rt-foot"><span>${foot}</span>${pager}${sign}</div>`,
    // A timetable is the institution's statement about its own week and the
    // head signs it — but on a signature LINE in the footer, not in R-5's
    // 190px block with its 56px blank gap. That block is ~30mm at the foot of
    // every page, and a class page was over a sheet of A4 by about 35mm.
    // Measured, not guessed: see the rasterisation table in PHASE_LOG.
    showSignature: false,
  };
}

/**
 * The grid's own print rules, on top of `documentBodyCss()`.
 *
 * Kept separate because it is the only document whose table is WIDE, and the
 * rules that make a wide table survive a page break are not ones the receipt
 * or the report card need.
 *
 * ── §10 grayscale ────────────────────────────────────────────────────────
 * Every tone here is a grey, and nothing on the sheet carries meaning by
 * colour alone: the break band is a band because of its RULES and its centred
 * label, the period column because of its weight, an empty hour because it
 * says "—". A school's mono laser prints this the same as a colour one.
 *
 * ── §9 notice-board mode ─────────────────────────────────────────────────
 * `board` scales the type up for a sheet that will be read standing a metre
 * away. It drops nothing — it only makes the same grid bigger, so a head who
 * prints both gets the same routine twice, not two routines.
 */
export function routineSheetCss(
  orientation: 'portrait' | 'landscape', board = false,
): string {
  // The numeric face, for the two spans whose whole content is a figure.
  const NUM = 'font-family:"Noto Sans Bengali","Hind Siliguri",system-ui,sans-serif';
  const s = board
    ? { grid: 14, no: 19, time: 13, who: 12.5, band: 17, pad: '5px 5px', col: 24, sec: 6 }
    : { grid: 11.5, no: 14.5, time: 10, who: 10.5, band: 13, pad: '3px 4px', col: 20, sec: 4.5 };

  return [
    `@page{size:A4 ${orientation};margin:0}`,
    // Landscape needs the letterhead's page box to follow it, or the document
    // keeps a 210mm column in the middle of a 297mm sheet.
    orientation === 'landscape'
      ? '.doc{max-width:297mm;min-height:210mm;padding:9mm 9mm}'
      : '',
    // §8. A landscape A4 is 210mm tall and the letterhead, the title row and
    // the signature were spending 76mm of it before a single hour was drawn.
    // These overrides are the routine sheet's alone — a receipt and a
    // transfer certificate are portrait and have the room. Every one was
    // sized against a rasterised page, not chosen for looks.
    orientation === 'landscape'
      ? '.doc-head{padding-bottom:5px}.doc-logo{width:42px;height:42px}'
        + '.doc-org{font-size:16px}.doc-addr,.doc-contact{font-size:10px}'
        + '.doc-title-row{margin:7px 0 5px;align-items:baseline}'
        + '.doc-title{font-size:14px}'
        + '.doc-meta{font-size:10px;display:flex;flex-wrap:wrap;gap:2px 12px}'
        + '.doc-meta div{margin-bottom:0}.doc-table{margin:4px 0}'
      : '',
    // §2. A heavier rule around the outside and under the day header, so the
    // grid reads as a grid from across a corridor rather than as grey text.
    `.rt-grid{table-layout:fixed;font-size:${s.grid}px;border:1.5px solid #374151}`,
    `.rt-grid th,.rt-grid td{vertical-align:top;padding:${s.pad}}`,
    '.rt-grid thead th{border-bottom:1.5px solid #374151;text-align:center;'
      + 'font-size:1.05em;letter-spacing:.01em}',
    `.rt-period-col{width:${s.col}mm}`,
    `.rt-period{width:${s.col}mm;background:#f3f4f6;text-align:center;`
      + '-webkit-print-color-adjust:exact;print-color-adjust:exact}',
    // §5. The hour's own name, large; its clock time under it, still legible.
    // Neither is metadata — this column is how a reader finds their row.
    `.rt-no{display:block;font-weight:700;font-size:${s.no}px;line-height:1.25;${NUM}}`,
    `.rt-time{display:block;font-size:${s.time}px;color:#374151;white-space:nowrap;${NUM}}`,

    // ── §5 the break band ──
    // Full width, ruled top and bottom, centred. This is the one row on the
    // sheet that is not a lesson and it must not look like one.
    '.rt-band td{background:#e5e7eb;text-align:center;padding:5px 6px;'
      + 'border-top:2px solid #374151;border-bottom:2px solid #374151;'
      + '-webkit-print-color-adjust:exact;print-color-adjust:exact}',
    `.rt-band-name{font-weight:700;font-size:${s.band}px;letter-spacing:.08em}`,
    `.rt-band-time{margin-inline-start:10px;font-size:${s.time}px;color:#374151;${NUM}}`,

    // ── the cell ──
    // A dense sheet: one flex line per section, the label in a column of its
    // own so the eye runs down it.
    '.rt-line{display:flex;gap:4px;line-height:1.3;padding:1px 0}',
    '.rt-line+.rt-line{border-top:1px dotted #d1d5db;margin-top:1px;padding-top:2px}',
    `.rt-sec{flex:none;min-width:${s.sec}mm;font-weight:700;color:#111827}`,
    '.rt-what{min-width:0;overflow-wrap:anywhere}',
    // A single-lesson sheet: subject, then its detail on a second line.
    '.rt-lesson{padding:1px 0;line-height:1.35}',
    '.rt-lesson+.rt-lesson{border-top:1px dotted #d1d5db;margin-top:2px;padding-top:2px}',
    `.rt-who{color:#374151;font-size:${s.who}px}`,
    '.rt-lesson .rt-who{display:block}',
    `.rt-line i,.rt-lesson i{font-size:${s.time}px;color:#4b5563}`,
    '.rt-empty{color:#9ca3af;text-align:center}',
    // §3. Which sections this page carries — the caption that tells a reader
    // which sheet is theirs when a wide class runs to several.
    `.rt-sections{margin:0 0 6px;font-size:${s.who}px;color:#374151;font-weight:600}`,
    // §12. Version, date and page x of y, at the foot of every page.
    '.rt-foot{display:flex;justify-content:space-between;align-items:flex-end;'
      + `gap:12px;margin-top:5px;font-size:${s.time}px;color:#4b5563}`,
    // The signature LINE: room to sign above it, the caption under it. ~11mm
    // against the block's ~30mm, which is most of what made a class page
    // spill onto a second sheet.
    `.rt-sign{flex:none;min-width:44mm;margin-top:${board ? 12 : 9}mm;`
      + 'text-align:center;border-top:1px solid #374151;padding-top:3px;'
      + 'color:#1f2937;font-weight:600}',

    '@media print{',
    // §6. A routine row is one hour of the school's week and must not be cut
    // in half by a page boundary; the header repeats so page two is readable
    // without page one beside it. `documentBodyCss` sets both for `.doc-table`
    // already — restated here because this table is the one where a break in
    // the wrong place is a person reading the wrong hour.
    '  .rt-grid tr{page-break-inside:avoid;break-inside:avoid}',
    '  .rt-grid thead{display:table-header-group}',
    '  .rt-grid tbody{break-inside:auto}',
    '  .rt-lesson,.rt-line{page-break-inside:avoid;break-inside:avoid}',
    '}',
  ].filter(Boolean).join('');
}

export function documentBodyCss(): string {
  return [
    '.doc-fields{display:grid;grid-template-columns:repeat(2,1fr);gap:4px 16px;margin:0 0 12px}',
    '.doc-fields>div{display:flex;gap:6px;font-size:12px;min-width:0}',
    '.doc-fields dt{margin:0;color:#6b7280;flex:none}',
    '.doc-fields dd{margin:0;font-weight:600;overflow-wrap:anywhere}',
    '.doc-table{width:100%;border-collapse:collapse;font-size:11.5px;margin:8px 0}',
    '.doc-table th,.doc-table td{border:1px solid #d1d5db;padding:4px 6px;text-align:left}',
    '.doc-table thead th{background:#f3f4f6;font-weight:700;'
      + '-webkit-print-color-adjust:exact;print-color-adjust:exact}',
    '.doc-table-money td:nth-child(2),.doc-table-money td:nth-child(3){text-align:right}',
    // The blank register: narrow day columns, tall rows to write in.
    '.doc-table-grid td{height:20px}',
    '.doc-table-grid th:nth-child(n+3),.doc-table-grid td:nth-child(n+3){width:18px;padding:2px;text-align:center}',
    '.doc-summary{margin-top:12px;padding-top:8px;border-top:1px solid #d1d5db}',
    '.doc-total{margin:10px 0 0;margin-left:auto;width:250px;font-size:12px}',
    '.doc-total>div{display:flex;justify-content:space-between;padding:3px 0}',
    '.doc-total-paid{border-top:1px solid #d1d5db;border-bottom:1px solid #d1d5db;font-size:13px}',
    '.doc-note{font-size:11.5px;color:#4b5563;margin:8px 0 0}',
    '.doc-rules{margin-top:14px;font-size:11px}',
    '.doc-rules h3{font-size:12px;margin:0 0 4px}',
    '.doc-rules ol{margin:0;padding-inline-start:18px}',
    '.doc-letter{font-size:13px;line-height:1.9;margin-bottom:14px}',
    '.doc-letter p{margin:0 0 10px}',
    // The ID card: its own small block, photo frame on the left.
    '.doc-idcard{display:flex;gap:14px;align-items:flex-start}',
    '.doc-photo{width:100px;height:120px;border:1px solid #9ca3af;display:flex;'
      + 'align-items:center;justify-content:center;color:#9ca3af;font-size:11px;flex:none}',
    '.doc-idcard-body{flex:1;min-width:0}',
    '.doc-idcard .doc-fields{grid-template-columns:1fr}',
    // ── Bulk printing ──
    // Each document is its own page. `break-after` is the modern property and
    // `page-break-after` the one older print engines honour; both are set
    // because a wrong page break in a batch of forty is forty wrong pages.
    '.doc+.doc{page-break-before:always;break-before:page}',
    '@media print{',
    '  .doc{page-break-after:auto;break-after:auto}',
    '  .doc-table{page-break-inside:auto}',
    '  .doc-table tr{page-break-inside:avoid;break-inside:avoid}',
    '  .doc-table thead{display:table-header-group}',   // repeat on each page
    '  .doc-foot,.doc-sign{page-break-inside:avoid;break-inside:avoid}',
    '  .doc-letter{orphans:3;widows:3}',
    '}',
  ].join('');
}
