/**
 * GET /api/v1/ops/document?type=…  — a printable document on the tenant's
 *                                    own letterhead
 *
 * R-5 of docs/11-MASTER-PLAN.md. The endpoint behind every print button.
 *
 * ── The tenant is never a parameter ─────────────────────────────────────
 * Branding comes from `tenants.settings->'branding'` read inside
 * `withTenant()`, i.e. from the JWT and nothing else. There is no tenantId in
 * the query string, the body or a header, so there is no way for a Tenant A
 * user to render a document on Tenant B's letterhead — not because a check
 * rejects it, but because the request has no way to express it.
 *
 * The DATA is the same story one layer down: every id in the query string is
 * looked up under RLS, so a receipt id from another school returns 404 for
 * the same reason a typo does. §20 of the brief asks for both halves and
 * `db/tests/documents.sql` asserts both.
 *
 * ── Print-first, no PDF, no bucket ──────────────────────────────────────
 * This returns HTML. The master plan says print-first — `window.print()` plus
 * print CSS — with server-side PDF "only where a stored artifact is
 * required". Nothing requires one yet: `payment_receipts.pdf_object_key`
 * exists and stays NULL because the object storage behind it is stubbed
 * pending an R2/S3 credential (see academics-svc/api/scripts.ts, same
 * pattern as OTP and MFS).
 *
 * That is a deliberate scope line, not an omission. A browser's own
 * "Save as PDF" produces the file a school actually needs, from the same
 * markup, with no bucket to secure and no renderer to keep patched. When the
 * credential lands, this endpoint's output is exactly what gets rendered
 * server-side — the markup does not change.
 *
 * ── Authorization is per document type ──────────────────────────────────
 * A receipt is not a report card is not a transfer certificate, and the
 * people who may print them differ. `ACCESS` below is the allowlist; RLS
 * underneath restricts WHICH rows each caller can reach, so a class teacher
 * printing report cards gets their own sections and nobody else's.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { sharedDb } from '../../../packages/server-core/src/db.ts';
import { corsHeaders, query, HttpError } from '../../../packages/server-core/src/http.ts';
import { authenticate } from '../../../packages/server-core/src/auth.ts';
import { parseBranding, type Branding } from '../../../packages/ui-core/src/branding.ts';
import {
  brandedDocumentSet, type BrandedSection,
} from '../../../packages/ui-core/src/branded-doc.ts';
import {
  type DocumentType,
  documentBodyCss,
  buildFeeReceipt,
  buildReportCard,
  buildAdmitCard,
  buildIdCard,
  buildTransferCertificate,
  buildAttendanceSheet,
  ADMIT_INSTRUCTIONS_BN,
  type StudentRef,
} from '../../../packages/ui-core/src/documents.ts';

/**
 * Who may print what.
 *
 * Money documents follow finance-svc's BILLING_ROLES. Result documents follow
 * the publish gate plus class teachers, who hand report cards out. A transfer
 * certificate is a legal statement about a child's record and is
 * principal-level, deliberately narrower than the rest.
 *
 * This list decides WHO may ask for a type. It does not decide WHICH children
 * they get: RLS plus `app.can_see_student` in loadStudents does that, so a
 * guardian on the fee_receipt row reaches their own wards and a subject
 * teacher on the report_card row reaches their own sections.
 */
const ACCESS: Record<DocumentType, string[]> = {
  fee_receipt: ['principal', 'school_owner', 'accountant', 'student', 'guardian'],
  report_card: ['principal', 'school_owner', 'academic_coordinator', 'dept_head',
                'class_teacher', 'subject_teacher', 'student', 'guardian'],
  admit_card: ['principal', 'school_owner', 'academic_coordinator', 'dept_head',
               'class_teacher', 'subject_teacher', 'student', 'guardian'],
  id_card: ['principal', 'school_owner', 'academic_coordinator', 'it_admin', 'class_teacher'],
  transfer_certificate: ['principal', 'school_owner'],
  attendance_sheet: ['principal', 'school_owner', 'academic_coordinator',
                     'dept_head', 'class_teacher', 'subject_teacher'],
};

/** A batch is a section, and a section is at most a large classroom. */
const MAX_BULK = 120;

const MONTHS_BN = [
  'জানুয়ারি', 'ফেব্রুয়ারি', 'মার্চ', 'এপ্রিল', 'মে', 'জুন',
  'জুলাই', 'আগস্ট', 'সেপ্টেম্বর', 'অক্টোবর', 'নভেম্বর', 'ডিসেম্বর',
];

type Db = Awaited<ReturnType<typeof sharedDb>>;
type Ctx = { tenantId: string; userId: string; role: string };
type Client = Parameters<Parameters<Db['withTenant']>[1]>[0];

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const cors = corsHeaders([], 'GET, OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }
  if (req.method !== 'GET') {
    res.writeHead(405, { ...cors, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'method_not_allowed' }));
    return;
  }

  try {
    const claims = await authenticate(req);
    const q = query(req);
    const type = (q.get('type') ?? '') as DocumentType;
    if (!(type in ACCESS)) {
      throw new HttpError(400, 'unknown document type', 'bad_type', { field: 'type' });
    }
    if (!ACCESS[type].includes(claims.role)) {
      throw new HttpError(403, 'এই নথি তৈরির অনুমতি আপনার নেই', 'forbidden');
    }

    const db = await sharedDb();
    const ctx = { tenantId: claims.tid, userId: claims.sub, role: claims.role };

    const html = await db.withTenant(ctx, async (c) => {
      // The whole reason this is safe: branding is read from the row the
      // session's tenant context selects, and nothing else.
      const { rows: brandRows } = await c.query<{ branding: unknown }>(
        `SELECT COALESCE(settings->'branding', '{}'::jsonb) AS branding FROM tenants`,
      );
      const branding = parseBranding(brandRows[0]?.branding ?? {});

      const sections = await build(c, ctx, type, q, branding);
      if (sections.length === 0) {
        throw new HttpError(404, 'নথির জন্য কোনো তথ্য পাওয়া যায়নি', 'no_data');
      }

      return brandedDocumentSet({
        branding,
        sections,
        locale: q.get('locale') === 'en' ? 'en' : 'bn',
        extraCss: documentBodyCss(),
      });
    });

    res.writeHead(200, {
      ...cors,
      'Content-Type': 'text/html; charset=utf-8',
      // Never cached: a document carries a named child's marks or a family's
      // fee balance, and a shared proxy holding one is a leak that outlives
      // the session.
      'Cache-Control': 'no-store, private',
      // The response is a full document rendered in a print window; nothing
      // should frame it or sniff it into something else.
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'SAMEORIGIN',
    });
    res.end(html);
  } catch (err) {
    const e = err instanceof HttpError
      ? err
      : new HttpError(500, 'internal_error', 'internal_error');
    res.writeHead(e.status, { ...cors, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: e.code, message: e.message, ...(e.detail ?? {}) }));
  }
}

// ── Dispatch ────────────────────────────────────────────────────────────

async function build(
  c: Client, ctx: Ctx, type: DocumentType, q: URLSearchParams, branding: Branding,
): Promise<BrandedSection[]> {
  switch (type) {
    case 'fee_receipt':          return feeReceipt(c, q);
    case 'report_card':          return reportCards(c, q);
    case 'admit_card':           return admitCards(c, q);
    case 'id_card':              return idCards(c, q);
    case 'transfer_certificate': return transferCertificate(c, q, branding);
    case 'attendance_sheet':     return attendanceSheet(c, q);
  }
}

/**
 * The student ids a bulk document is for: either an explicit list, or every
 * active enrolment in a section.
 *
 * Resolving a SECTION into students server-side rather than trusting a list
 * from the browser is what makes "generate for the whole section" safe: the
 * roster comes from `enrolments` under RLS, so a caller cannot smuggle in a
 * student from a section they do not teach.
 */
async function studentIdsFor(c: Client, q: URLSearchParams): Promise<string[]> {
  const explicit = (q.get('studentIds') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (explicit.length > 0) {
    if (explicit.length > MAX_BULK) {
      throw new HttpError(400,
        `একবারে সর্বোচ্চ ${MAX_BULK} জনের নথি তৈরি করা যায়`, 'too_many', { field: 'studentIds' });
    }
    return explicit;
  }

  const one = (q.get('studentId') ?? '').trim();
  if (one) return [one];

  const sectionId = (q.get('sectionId') ?? '').trim();
  if (!sectionId) {
    throw new HttpError(400, 'studentId or sectionId is required', 'bad_request');
  }
  const { rows } = await c.query<{ student_id: string }>(
    `SELECT e.student_id FROM enrolments e
      WHERE e.section_id = $1 AND e.status = 'active'
      ORDER BY e.roll_no LIMIT $2`,
    [sectionId, MAX_BULK + 1],
  );
  if (rows.length > MAX_BULK) {
    throw new HttpError(400,
      `এই শাখায় ${MAX_BULK}-এর বেশি শিক্ষার্থী আছে`, 'too_many', { field: 'sectionId' });
  }
  return rows.map((r) => r.student_id);
}

interface StudentRow {
  id: string; name_bn: string; name_en: string | null; student_code: string | null;
  class_bn: string | null; group_bn: string | null; section: string | null;
  roll_no: number | null; father_bn: string | null; mother_bn: string | null;
  dob: string | null; admission_date: string | null; blood_group: string | null;
  year_label: string | null;
}

const GROUP_BN: Record<string, string> = {
  none: 'সাধারণ', science: 'বিজ্ঞান', humanities: 'মানবিক',
  business_studies: 'ব্যবসায় শিক্ষা', vocational: 'ভোকেশনাল', general: 'সাধারণ',
};

/**
 * One query for the person every document names, ordered by roll.
 *
 * ── Why `app.can_see_student` is here and not left to RLS ───────────────
 * `users_scope` (migration 010) ends with `OR app.is_staff()`, because the
 * staff directory is visible to staff. That is right for a directory and
 * wrong for a document: reading a colleague's name in a list is not the same
 * act as printing an official, letterheaded admit card for a child you do not
 * teach, carrying their roll, their parents' names and their seat.
 *
 * So the printed surface is deliberately tighter than the directory surface.
 * `app.can_see_student` is the existing predicate for exactly this — `true`
 * for principal, owner, coordinator, dept head, accountant and IT admin;
 * narrowed to their own wards, own record or own sections for guardians,
 * students and teachers. Calling it here means an id a caller may look up but
 * may not print for simply produces no page, and a request for nothing but
 * such ids 404s in the handler.
 *
 * This closes report cards, admit cards, ID cards, receipts and transfer
 * certificates in one place, because all five funnel through here.
 */
async function loadStudents(c: Client, ids: string[]): Promise<StudentRow[]> {
  const { rows } = await c.query<StudentRow>(
    `SELECT u.id, u.full_name_bn AS name_bn, u.full_name_en AS name_en,
            sp.student_code, cl.name_bn AS class_bn,
            cl."group"::text AS group_bn, s.name AS section, e.roll_no,
            u.father_name_bn AS father_bn, u.mother_name_bn AS mother_bn,
            u.date_of_birth::text AS dob, sp.admission_date::text AS admission_date,
            sp.blood_group, ay.label AS year_label
       FROM users u
       LEFT JOIN student_profiles sp ON sp.user_id = u.id
       LEFT JOIN enrolments e ON e.student_id = u.id AND e.status = 'active'
       LEFT JOIN sections s   ON s.id = e.section_id
       LEFT JOIN classes cl   ON cl.id = s.class_id
       LEFT JOIN academic_years ay ON ay.id = e.academic_year_id
      WHERE u.id = ANY($1::uuid[]) AND app.can_see_student(u.id)
      ORDER BY e.roll_no NULLS LAST, u.full_name_bn`,
    [ids],
  );
  return rows;
}

function toRef(r: StudentRow): StudentRef {
  return {
    nameBn: r.name_bn,
    nameEn: r.name_en,
    studentCode: r.student_code,
    classBn: r.class_bn,
    groupBn: r.group_bn ? GROUP_BN[r.group_bn] ?? r.group_bn : null,
    section: r.section,
    rollNo: r.roll_no,
    fatherNameBn: r.father_bn,
    motherNameBn: r.mother_bn,
    dateOfBirth: r.dob,
    admissionDate: r.admission_date,
    bloodGroup: r.blood_group,
  };
}

// ── 1. Fee receipt ──────────────────────────────────────────────────────

async function feeReceipt(c: Client, q: URLSearchParams): Promise<BrandedSection[]> {
  const id = (q.get('receiptId') ?? '').trim();
  if (!id) throw new HttpError(400, 'receiptId is required', 'bad_request', { field: 'receiptId' });

  const { rows } = await c.query<{
    receipt_no: string; issued_at: string; amount: string; method: string;
    invoice_id: string; invoice_no: string; billing_period: string;
    total_amount: string; paid_amount: string; balance_amount: string;
    student_id: string;
  }>(
    `SELECT pr.receipt_no, pr.issued_at::text, pr.amount::text, pr.method::text AS method,
            i.id AS invoice_id, i.invoice_no, i.billing_period,
            i.total_amount::text, i.paid_amount::text, i.balance_amount::text,
            pr.student_id
       FROM payment_receipts pr
       JOIN invoices i ON i.id = pr.invoice_id
      WHERE pr.id = $1`,
    [id],
  );
  // Invisible and absent are the same answer: a receipt id from another
  // school must be indistinguishable from a typo.
  if (rows.length === 0) throw new HttpError(404, 'রসিদ পাওয়া যায়নি', 'not_found');
  const r = rows[0];

  const { rows: lines } = await c.query<{ description_bn: string; amount: string; waiver_amount: string }>(
    `SELECT description_bn, amount::text, waiver_amount::text
       FROM invoice_lines WHERE invoice_id = $1 ORDER BY description_bn`,
    [r.invoice_id],
  );

  const students = await loadStudents(c, [r.student_id]);
  if (students.length === 0) throw new HttpError(404, 'শিক্ষার্থী পাওয়া যায়নি', 'not_found');

  return [buildFeeReceipt({
    student: toRef(students[0]),
    receiptNo: r.receipt_no,
    issuedAt: r.issued_at,
    amount: r.amount,
    method: r.method,
    invoiceNo: r.invoice_no,
    billingPeriod: r.billing_period,
    lines: lines.map((l) => ({
      descriptionBn: l.description_bn, amount: l.amount, waiver: l.waiver_amount,
    })),
    invoiceTotal: r.total_amount,
    paidToDate: r.paid_amount,
    balance: r.balance_amount,
  })];
}

// ── 2. Report card ──────────────────────────────────────────────────────

async function reportCards(c: Client, q: URLSearchParams): Promise<BrandedSection[]> {
  const examId = (q.get('examId') ?? '').trim();
  if (!examId) throw new HttpError(400, 'examId is required', 'bad_request', { field: 'examId' });

  const { rows: exam } = await c.query<{ name_bn: string; status: string; year_label: string }>(
    `SELECT e.name_bn, e.status::text AS status, ay.label AS year_label
       FROM exams e JOIN academic_years ay ON ay.id = e.academic_year_id
      WHERE e.id = $1`,
    [examId],
  );
  if (exam.length === 0) throw new HttpError(404, 'পরীক্ষা পাওয়া যায়নি', 'not_found');
  if (exam[0].status !== 'published') {
    // A report card for an unpublished exam is a mark sheet handed out before
    // the school agreed the marks. RLS already hides the results from
    // students; this refuses it to staff too, with a reason.
    throw new HttpError(409,
      'এই পরীক্ষার ফলাফল এখনো প্রকাশিত হয়নি — আগে প্রকাশ করুন',
      'not_published');
  }

  const ids = await studentIdsFor(c, q);
  const students = await loadStudents(c, ids);

  const { rows: results } = await c.query<{
    student_id: string; total_marks: string | null; total_max: string | null;
    percentage: string | null; gpa: string | null; letter_grade: string | null;
    is_pass: boolean; rank_in_section: number | null; attendance_percent: string | null;
  }>(
    `SELECT student_id, total_marks::text, total_max::text, percentage::text,
            gpa::text, letter_grade, is_pass, rank_in_section, attendance_percent::text
       FROM exam_results WHERE exam_id = $1 AND student_id = ANY($2::uuid[])`,
    [examId, ids],
  );
  const byStudent = new Map(results.map((r) => [r.student_id, r]));

  const { rows: marks } = await c.query<{
    student_id: string; subject_bn: string; total_marks: string | null;
    max_marks: string | null; grade_letter: string | null;
    grade_point: string | null; is_absent: boolean;
  }>(
    `SELECT m.student_id, sub.name_bn AS subject_bn, m.total_marks::text,
            (es.cq_max + es.mcq_max + es.practical_max + es.ca_max)::text AS max_marks,
            m.grade_letter, m.grade_point::text, m.is_absent
       FROM exam_marks m
       JOIN exam_subjects es ON es.id = m.exam_subject_id
       JOIN subjects sub     ON sub.id = es.subject_id
      WHERE es.exam_id = $1 AND m.student_id = ANY($2::uuid[])
      ORDER BY sub.name_bn`,
    [examId, ids],
  );

  return students.map((s) => {
    const res = byStudent.get(s.id);
    return buildReportCard({
      student: toRef(s),
      examNameBn: exam[0].name_bn,
      yearLabel: exam[0].year_label,
      subjects: marks.filter((m) => m.student_id === s.id).map((m) => ({
        nameBn: m.subject_bn,
        obtained: m.total_marks,
        max: m.max_marks,
        grade: m.grade_letter,
        gradePoint: m.grade_point,
        isAbsent: m.is_absent,
      })),
      totalMarks: res?.total_marks ?? null,
      totalMax: res?.total_max ?? null,
      percentage: res?.percentage ?? null,
      gpa: res?.gpa ?? null,
      letterGrade: res?.letter_grade ?? null,
      isPass: res?.is_pass ?? false,
      rankInSection: res?.rank_in_section ?? null,
      attendancePercent: res?.attendance_percent ?? null,
    });
  });
}

// ── 3. Admit card ───────────────────────────────────────────────────────

async function admitCards(c: Client, q: URLSearchParams): Promise<BrandedSection[]> {
  const examId = (q.get('examId') ?? '').trim();
  if (!examId) throw new HttpError(400, 'examId is required', 'bad_request', { field: 'examId' });

  const { rows: exam } = await c.query<{ name_bn: string; year_label: string }>(
    `SELECT e.name_bn, ay.label AS year_label
       FROM exams e JOIN academic_years ay ON ay.id = e.academic_year_id
      WHERE e.id = $1`,
    [examId],
  );
  if (exam.length === 0) throw new HttpError(404, 'পরীক্ষা পাওয়া যায়নি', 'not_found');

  const ids = await studentIdsFor(c, q);
  const students = await loadStudents(c, ids);

  // Papers per student. The seat comes from `exam_seats` when a plan has been
  // drawn and is simply absent when it has not — see buildAdmitCard.
  const { rows: papers } = await c.query<{
    student_id: string; subject_bn: string; exam_date: string | null;
    start_time: string | null; hall_bn: string | null;
    seat_row: number | null; seat_col: number | null;
  }>(
    // `exam_halls` carries no name of its own — it points at a `rooms` row,
    // which is where the code a candidate reads on the door lives. Found by
    // running this against the real schema, not by reading it.
    `SELECT e.student_id, sub.name_bn AS subject_bn, es.exam_date::text,
            seat.start_time::text,
            COALESCE(r.name_bn, r.code) AS hall_bn,
            seat.seat_row, seat.seat_col
       FROM enrolments e
       JOIN exam_subjects es ON es.section_id = e.section_id AND es.exam_id = $1
       JOIN subjects sub     ON sub.id = es.subject_id
       LEFT JOIN exam_seats seat ON seat.enrolment_id = e.id AND seat.exam_subject_id = es.id
       LEFT JOIN exam_halls h    ON h.id = seat.hall_id
       LEFT JOIN rooms r         ON r.id = h.room_id
      WHERE e.student_id = ANY($2::uuid[]) AND e.status = 'active'
      ORDER BY es.exam_date NULLS LAST, sub.name_bn`,
    [examId, ids],
  );

  return students.map((s) => buildAdmitCard({
    student: toRef(s),
    examNameBn: exam[0].name_bn,
    yearLabel: exam[0].year_label,
    papers: papers.filter((p) => p.student_id === s.id).map((p) => ({
      subjectBn: p.subject_bn,
      examDate: p.exam_date,
      startTime: p.start_time,
      hallBn: p.hall_bn,
      seat: p.seat_row != null && p.seat_col != null ? `${p.seat_row}-${p.seat_col}` : null,
    })),
    instructionsBn: ADMIT_INSTRUCTIONS_BN,
  }));
}

// ── 4. Student ID card ──────────────────────────────────────────────────

async function idCards(c: Client, q: URLSearchParams): Promise<BrandedSection[]> {
  const ids = await studentIdsFor(c, q);
  const students = await loadStudents(c, ids);

  // The primary guardian's number is the one on the card — it is what the
  // card is FOR when a child is found unwell or lost.
  const { rows: phones } = await c.query<{ student_id: string; phone: string | null }>(
    `SELECT gs.student_id, g.phone_e164 AS phone
       FROM guardianships gs JOIN users g ON g.id = gs.guardian_id
      WHERE gs.student_id = ANY($1::uuid[]) AND gs.is_primary`,
    [ids],
  );
  const phoneOf = new Map(phones.map((p) => [p.student_id, p.phone]));

  const { rows: year } = await c.query<{ label: string; ends_on: string }>(
    `SELECT label, ends_on::text FROM academic_years
      ORDER BY is_current DESC, starts_on DESC LIMIT 1`,
  );

  return students.map((s) => buildIdCard({
    student: toRef(s),
    yearLabel: s.year_label ?? year[0]?.label ?? '',
    validUntil: year[0]?.ends_on ?? null,
    guardianPhone: phoneOf.get(s.id) ?? null,
  }));
}

// ── 5. Transfer certificate ─────────────────────────────────────────────

async function transferCertificate(
  c: Client, q: URLSearchParams, _branding: Branding,
): Promise<BrandedSection[]> {
  const studentId = (q.get('studentId') ?? '').trim();
  if (!studentId) {
    throw new HttpError(400, 'studentId is required', 'bad_request', { field: 'studentId' });
  }

  const students = await loadStudents(c, [studentId]);
  if (students.length === 0) throw new HttpError(404, 'শিক্ষার্থী পাওয়া যায়নি', 'not_found');
  const s = students[0];

  // The LAST enrolment, active or not — a transfer certificate is issued
  // after the child has left, so the current-enrolment join in loadStudents
  // is often empty and this is the row that matters. `enrolments` is never
  // overwritten (R-3), which is why this is still true years later.
  const { rows: last } = await c.query<{
    class_bn: string; year_label: string; ended_on: string | null; status: string;
  }>(
    `SELECT cl.name_bn AS class_bn, ay.label AS year_label,
            e.ended_on::text, e.status
       FROM enrolments e
       JOIN sections s        ON s.id = e.section_id
       JOIN classes cl        ON cl.id = s.class_id
       JOIN academic_years ay ON ay.id = e.academic_year_id
      WHERE e.student_id = $1
      ORDER BY ay.starts_on DESC LIMIT 1`,
    [studentId],
  );
  if (last.length === 0) {
    throw new HttpError(409,
      'এই শিক্ষার্থীর কোনো ভর্তির রেকর্ড নেই — ছাড়পত্র দেওয়া যাবে না', 'no_enrolment');
  }

  const { rows: dues } = await c.query<{ outstanding: string }>(
    `SELECT COALESCE(sum(balance_amount), 0)::text AS outstanding
       FROM invoices WHERE student_id = $1`,
    [studentId],
  );

  return [buildTransferCertificate({
    student: toRef(s),
    // Deterministic and tenant-unique by construction: `student_code` is
    // UNIQUE per tenant, so this cannot collide and regenerating gives the
    // same number. See docs/07 §9h for why there is no serial register yet.
    certificateNo: `TC-${last[0].year_label}-${s.student_code ?? s.id.slice(0, 8)}`,
    issuedOn: new Date().toISOString().slice(0, 10),
    lastClassBn: last[0].class_bn,
    lastYearLabel: last[0].year_label,
    admissionDate: s.admission_date,
    leftOn: last[0].ended_on,
    conductBn: (q.get('conduct') ?? 'সন্তোষজনক').slice(0, 40),
    reasonBn: (q.get('reason') ?? 'অভিভাবকের আবেদনের প্রেক্ষিতে তাহাকে ছাড়পত্র প্রদান করা হইল।')
      .slice(0, 300),
    duesCleared: Number(dues[0]?.outstanding ?? 0) <= 0,
  })];
}

// ── 6. Attendance sheet ─────────────────────────────────────────────────

async function attendanceSheet(c: Client, q: URLSearchParams): Promise<BrandedSection[]> {
  const sectionId = (q.get('sectionId') ?? '').trim();
  if (!sectionId) {
    throw new HttpError(400, 'sectionId is required', 'bad_request', { field: 'sectionId' });
  }

  const { rows: sec } = await c.query<{
    name: string; class_bn: string; group_bn: string; year_label: string;
  }>(
    `SELECT s.name, cl.name_bn AS class_bn, cl."group"::text AS group_bn,
            ay.label AS year_label
       FROM sections s
       JOIN classes cl        ON cl.id = s.class_id
       JOIN academic_years ay ON ay.id = s.academic_year_id
      WHERE s.id = $1`,
    [sectionId],
  );
  if (sec.length === 0) throw new HttpError(404, 'শাখা পাওয়া যায়নি', 'not_found');

  // This is the one document that is a SECTION rather than a set of students,
  // so it cannot lean on loadStudents' filter. It asks the same question a
  // different way: may this caller see the children on this roster? A subject
  // teacher can read any student's name from the staff directory, but printing
  // another class's register on the school's letterhead is not theirs to do.
  const { rows: roster } = await c.query<{
    roll_no: number; name_bn: string; visible: boolean;
  }>(
    `SELECT e.roll_no, u.full_name_bn AS name_bn,
            app.can_see_student(u.id) AS visible
       FROM enrolments e JOIN users u ON u.id = e.student_id
      WHERE e.section_id = $1 AND e.status = 'active'
      ORDER BY e.roll_no`,
    [sectionId],
  );
  if (roster.some((r) => !r.visible)) {
    throw new HttpError(403,
      'এই শাখার হাজিরা খাতা তৈরির অনুমতি আপনার নেই', 'forbidden');
  }

  const monthParam = (q.get('month') ?? '').trim();
  const now = new Date();
  const month = /^\d{4}-\d{2}$/.test(monthParam)
    ? monthParam
    : `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const [yy, mm] = month.split('-').map(Number);
  const dayColumns = new Date(Date.UTC(yy, mm, 0)).getUTCDate();

  return [buildAttendanceSheet({
    classBn: sec[0].class_bn,
    groupBn: GROUP_BN[sec[0].group_bn] ?? sec[0].group_bn,
    section: sec[0].name,
    yearLabel: sec[0].year_label,
    monthBn: `${MONTHS_BN[mm - 1]} ${yy}`,
    students: roster.map((r) => ({ rollNo: r.roll_no, nameBn: r.name_bn })),
    dayColumns,
  })];
}
