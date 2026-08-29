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
import { type Branding, brandName } from './branding.ts';
import { escapeHtml } from './branded-doc.ts';
import { toBanglaDigits, formatBdt, formatDayMonth, type Locale } from './format.ts';

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
  | 'attendance_sheet';

export const DOCUMENT_TITLES_BN: Record<DocumentType, string> = {
  fee_receipt: 'ফি রসিদ',
  report_card: 'প্রগতি পত্র',
  admit_card: 'প্রবেশপত্র',
  id_card: 'পরিচয়পত্র',
  transfer_certificate: 'ছাড়পত্র',
  attendance_sheet: 'হাজিরা শিট',
};

const DOCUMENT_TITLES_EN: Record<DocumentType, string> = {
  fee_receipt: 'Fee Receipt',
  report_card: 'Report Card',
  admit_card: 'Admit Card',
  id_card: 'Identity Card',
  transfer_certificate: 'Transfer Certificate',
  attendance_sheet: 'Attendance Sheet',
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
