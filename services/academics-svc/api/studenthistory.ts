/**
 * GET /api/v1/academics/students/history?studentId=<uuid>
 *
 * R-6's second half: everything the school knows about one child, across
 * every year they were here. The master plan calls this "the STU-… ten years
 * later requirement made visible".
 *
 * ── The history is not stored anywhere; it is read ──────────────────────
 * `enrolments` has carried one row per student per academic year since
 * migration 003 — section, roll, status, the dates it started and ended. That
 * IS the history. R-6 adds no `student_history` table and denormalises
 * nothing, because a second copy of the truth is a second thing to get wrong
 * during a rollover, and rollover already writes these rows (R-3).
 *
 * So the timeline is a read of four years of `enrolments`, ordered by the
 * academic year's start date, and the current year is whichever row says
 * `status = 'active'` rather than whichever row is newest. A child who left
 * in June has a latest row and no current one, and the UI must be able to
 * tell those apart — §6 of the brief — so the flag is computed here and not
 * inferred from the array position.
 *
 * ── Why one response and not eight ──────────────────────────────────────
 * §15: search returns a compact list, opening a student loads the detail.
 * That is the split that matters. Within the detail, eight tabs firing eight
 * requests would put a spinner on every tab of a page whose whole purpose is
 * to be read end to end, and the queries are all sub-millisecond index seeks
 * against the same student id. `ward.ts` made the same call for the same
 * reason and its comment says so.
 *
 * ── Authorization, and where it is tighter than RLS ─────────────────────
 * Visibility of the CHILD is `app.can_see_student`, the existing predicate:
 * a guardian reaches their wards, a student themselves, a teacher their own
 * sections, management everyone. If it returns false the response is 404, not
 * 403 — an id that is invisible must be indistinguishable from an id that
 * does not exist, or the endpoint tells a teacher which codes are real.
 *
 * Visibility of the TABS is narrower in one place. `invoice_scope` (migration
 * 010) reads `has_role(principal, owner, accountant) OR
 * can_see_student(student_id)`, so RLS alone would show a class teacher the
 * fee balance of every child in their section. A class teacher has no reason
 * to know which families are behind on fees, and R-5 established that the
 * fix for "RLS is right for its own table and too broad for this surface" is
 * a narrower gate at the endpoint. `MAY_SEE_FEES` is that gate.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { sharedDb } from '../../../packages/server-core/src/db.ts';
import { corsHeaders, query, json, HttpError } from '../../../packages/server-core/src/http.ts';
import { authenticate } from '../../../packages/server-core/src/auth.ts';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Finance is not general staff information. Guardians and students are here
 * because it is their own bill; `invoice_scope` still narrows them to their
 * own rows underneath.
 */
const MAY_SEE_FEES = ['principal', 'school_owner', 'accountant', 'guardian', 'student'];

/**
 * Contact details are shown to the people who administer the child and to the
 * family itself. R-3 settled this for the guardian panel — a phone number is
 * not something every staff member gets because they can open a drawer — and
 * the same line is drawn here, on the server.
 */
const MAY_SEE_CONTACT = [
  'principal', 'school_owner', 'academic_coordinator', 'it_admin', 'class_teacher',
  'accountant', 'guardian', 'student',
];

/**
 * Which R-5 documents this viewer may print for this child.
 *
 * Mirrors `services/ops-svc/api/document.ts`'s ACCESS deliberately: this is a
 * different service and importing across the boundary to save six lines would
 * couple academics to ops for a constant. The Documents tab lists what CAN be
 * produced — it hands out no URLs, because R-5's endpoint is the only way to
 * a document and it re-checks this list itself.
 */
const DOCUMENT_ACCESS: Record<string, string[]> = {
  fee_receipt: ['principal', 'school_owner', 'accountant', 'student', 'guardian'],
  report_card: ['principal', 'school_owner', 'academic_coordinator', 'dept_head',
                'class_teacher', 'subject_teacher', 'student', 'guardian'],
  admit_card: ['principal', 'school_owner', 'academic_coordinator', 'dept_head',
               'class_teacher', 'subject_teacher', 'student', 'guardian'],
  id_card: ['principal', 'school_owner', 'academic_coordinator', 'it_admin', 'class_teacher'],
  transfer_certificate: ['principal', 'school_owner'],
};

/** The certificate half of §4's tab list; the rest are everyday documents. */
const CERTIFICATE_TYPES = new Set(['transfer_certificate']);

type Client = { query: <T>(sql: string, p?: unknown[]) => Promise<{ rows: T[] }> };

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const cors = corsHeaders();
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }
  if (req.method !== 'GET') { json(res, 405, { error: 'method_not_allowed' }, cors); return; }

  try {
    const claims = await authenticate(req);
    const q = query(req);
    const studentId = (q.get('studentId') ?? '').trim();
    if (!UUID_RE.test(studentId)) {
      throw new HttpError(400, 'studentId must be a valid uuid', 'invalid_student_id');
    }

    const db = await sharedDb();
    const ctx = { tenantId: claims.tid, userId: claims.sub, role: claims.role };
    const role = claims.role;

    const payload = await db.withTenant(ctx, async (c) => {
      const profile = await loadProfile(c, studentId, MAY_SEE_CONTACT.includes(role));
      // Invisible and absent are the same answer, for the same reason as R-5.
      if (!profile) throw new HttpError(404, 'শিক্ষার্থী পাওয়া যায়নি', 'not_found');

      // Sequential, not Promise.all. These four share ONE pg client inside a
      // transaction, and a node-pg client can only run one query at a time —
      // `Promise.all` over the same client warns ("client is already
      // executing a query") and pg 9 removes the behaviour entirely. The
      // parallelism was imaginary: the driver serialised them anyway. Found
      // by the deprecation warning while measuring, not by a failing test,
      // which is the argument for reading warnings.
      const enrolments = await loadEnrolments(c, studentId);
      const attendance = await loadAttendance(c, studentId);
      const results = await loadResults(c, studentId);
      const fees = MAY_SEE_FEES.includes(role) ? await loadFees(c, studentId) : null;

      const printable = Object.entries(DOCUMENT_ACCESS)
        .filter(([, roles]) => roles.includes(role))
        .map(([type]) => type);

      return {
        student: profile,
        enrolments,
        attendance,
        results,
        fees,
        documents: printable.filter((t) => !CERTIFICATE_TYPES.has(t)),
        certificates: printable.filter((t) => CERTIFICATE_TYPES.has(t)),
        // Said plainly rather than left for the UI to infer from a null: a
        // tab that is empty because there is nothing and a tab that is empty
        // because this person may not see it are different sentences.
        permissions: { fees: MAY_SEE_FEES.includes(role), contact: MAY_SEE_CONTACT.includes(role) },
      };
    });

    json(res, 200, payload, cors);
  } catch (err) {
    const e = err instanceof HttpError ? err : new HttpError(500, 'internal_error', 'internal_error');
    json(res, e.status, { error: e.code, message: e.message, ...(e.detail ?? {}) }, cors);
  }
}

async function loadProfile(c: Client, studentId: string, maySeeContact: boolean) {
  const { rows } = await c.query<{
    id: string; name_bn: string; name_en: string | null; student_code: string;
    lifecycle_status: string; admission_date: string; graduated_on: string | null;
    blood_group: string | null; father_bn: string | null; mother_bn: string | null;
    dob: string | null; phone: string | null;
    board_registration_no: string | null; board_roll_no: string | null;
  }>(
    `SELECT u.id, u.full_name_bn AS name_bn, u.full_name_en AS name_en,
            sp.student_code, sp.lifecycle_status,
            sp.admission_date::text, sp.graduated_on::text,
            sp.blood_group, u.father_name_bn AS father_bn,
            u.mother_name_bn AS mother_bn, u.date_of_birth::text AS dob,
            u.phone_e164 AS phone,
            sp.board_registration_no, sp.board_roll_no
       FROM users u
       JOIN student_profiles sp ON sp.user_id = u.id
      WHERE u.id = $1 AND u.deleted_at IS NULL AND app.can_see_student(u.id)`,
    [studentId],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    id: r.id,
    name: { bn: r.name_bn, en: r.name_en },
    studentCode: r.student_code,
    lifecycleStatus: r.lifecycle_status,
    admissionDate: r.admission_date,
    graduatedOn: r.graduated_on,
    // Withheld at the SERVER, not hidden in the UI. A role that may not see
    // contact details never receives them, so nothing leaks to anyone who
    // opens the network tab.
    bloodGroup: maySeeContact ? r.blood_group : null,
    fatherNameBn: maySeeContact ? r.father_bn : null,
    motherNameBn: maySeeContact ? r.mother_bn : null,
    dateOfBirth: maySeeContact ? r.dob : null,
    phone: maySeeContact ? r.phone : null,
    boardRegistrationNo: maySeeContact ? r.board_registration_no : null,
    boardRollNo: maySeeContact ? r.board_roll_no : null,
  };
}

/**
 * The timeline. One row per year the child was enrolled, oldest first, each
 * carrying the class, group, section and roll AS THEY WERE — never derived
 * from the current row, which is the whole point of keeping the history.
 *
 * Uses ix_enrolment_student_history (migration 044): 0.089 ms for a
 * four-year timeline, against 1.255 ms for the scan it replaced.
 */
async function loadEnrolments(c: Client, studentId: string) {
  const { rows } = await c.query<{
    year_label: string; starts_on: string; class_bn: string; class_en: string;
    level_no: number; group_bn: string; section_name: string; shift: string;
    roll_no: number; status: string; enrolled_on: string; ended_on: string | null;
  }>(
    `SELECT ay.label AS year_label, ay.starts_on::text,
            cl.name_bn AS class_bn, cl.name_en AS class_en, cl.level_no,
            cl."group"::text AS group_bn,
            s.name AS section_name, s.shift::text AS shift,
            e.roll_no, e.status,
            e.enrolled_on::text, e.ended_on::text
       FROM enrolments e
       JOIN sections s        ON s.id = e.section_id
       JOIN classes cl        ON cl.id = s.class_id
       JOIN academic_years ay ON ay.id = e.academic_year_id
      WHERE e.student_id = $1
      ORDER BY ay.starts_on ASC`,
    [studentId],
  );
  return rows.map((r) => ({
    yearLabel: r.year_label,
    classBn: r.class_bn,
    classEn: r.class_en,
    levelNo: r.level_no,
    groupBn: r.group_bn,
    section: r.section_name,
    shift: r.shift,
    rollNo: r.roll_no,
    status: r.status,
    enrolledOn: r.enrolled_on,
    endedOn: r.ended_on,
    // §6. 'active' is the school's own word for the enrolment that is
    // running, and it survives a child leaving: the last row of a graduate's
    // timeline is 'promoted' or 'left', and none of their rows is current.
    isCurrent: r.status === 'active',
  }));
}

/**
 * Attendance per academic year, counted rather than listed: a child with four
 * years here has roughly 800 records and no one reads 800 rows. The year
 * boundaries come from `academic_years`, so a school whose year does not
 * start in January still gets its own years.
 *
 * Served by ix_att_rec_student (tenant, student, taken_on) INCLUDE (status) —
 * an index-only scan, 0.366 ms on the fixture.
 */
async function loadAttendance(c: Client, studentId: string) {
  const { rows } = await c.query<{
    year_label: string; present: string; absent: string; late: string;
    excused: string; half_day: string; total: string;
  }>(
    `SELECT ay.label AS year_label,
            count(*) FILTER (WHERE ar.status = 'present')::text  AS present,
            count(*) FILTER (WHERE ar.status = 'absent')::text   AS absent,
            count(*) FILTER (WHERE ar.status = 'late')::text     AS late,
            count(*) FILTER (WHERE ar.status = 'excused')::text  AS excused,
            count(*) FILTER (WHERE ar.status = 'half_day')::text AS half_day,
            count(*)::text AS total
       FROM attendance_records ar
       JOIN academic_years ay
         ON ay.tenant_id = ar.tenant_id
        AND ar.taken_on BETWEEN ay.starts_on AND ay.ends_on
      WHERE ar.student_id = $1
      GROUP BY ay.label, ay.starts_on
      ORDER BY ay.starts_on ASC`,
    [studentId],
  );
  return rows.map((r) => {
    const total = Number(r.total);
    const present = Number(r.present);
    const late = Number(r.late);
    const half = Number(r.half_day);
    return {
      yearLabel: r.year_label,
      present, absent: Number(r.absent), late,
      excused: Number(r.excused), halfDay: half, total,
      // A late arrival is a day attended; an excused absence is not counted
      // against the child but is not a day present either, so it is excluded
      // from the denominator rather than scored as attendance.
      percent: total === 0 ? null
        : Math.round(((present + late + half * 0.5) / total) * 1000) / 10,
    };
  });
}

/**
 * Published results only. `exam_results` carries `published_at`, and an
 * unpublished result is a mark the school has not agreed yet — R-5 refused to
 * print one and this refuses to show one, including to management, because
 * "the principal saw it early" is how an unpublished GPA reaches a parent.
 */
async function loadResults(c: Client, studentId: string) {
  const { rows } = await c.query<{
    year_label: string; exam_bn: string; total_marks: string | null;
    total_max: string | null; percentage: string | null; gpa: string | null;
    letter_grade: string | null; is_pass: boolean; rank_in_section: number | null;
    published_at: string;
  }>(
    `SELECT ay.label AS year_label, ex.name_bn AS exam_bn,
            er.total_marks::text, er.total_max::text, er.percentage::text,
            er.gpa::text, er.letter_grade, er.is_pass, er.rank_in_section,
            er.published_at::text
       FROM exam_results er
       JOIN exams ex          ON ex.id = er.exam_id
       JOIN academic_years ay ON ay.id = er.academic_year_id
      WHERE er.student_id = $1 AND er.published_at IS NOT NULL
      ORDER BY ay.starts_on ASC, ex.starts_on ASC`,
    [studentId],
  );
  return rows.map((r) => ({
    yearLabel: r.year_label,
    examBn: r.exam_bn,
    totalMarks: r.total_marks,
    totalMax: r.total_max,
    percentage: r.percentage,
    gpa: r.gpa,
    letterGrade: r.letter_grade,
    isPass: r.is_pass,
    rankInSection: r.rank_in_section,
  }));
}

/**
 * Fees per year plus the receipts that paid them. `invoice_scope` narrows a
 * guardian to their own child underneath this, and MAY_SEE_FEES has already
 * kept teachers out entirely.
 */
async function loadFees(c: Client, studentId: string) {
  const { rows: years } = await c.query<{
    year_label: string; invoices: string; billed: string; paid: string; due: string;
  }>(
    `SELECT ay.label AS year_label, count(*)::text AS invoices,
            COALESCE(sum(i.total_amount), 0)::text  AS billed,
            COALESCE(sum(i.paid_amount), 0)::text   AS paid,
            COALESCE(sum(i.balance_amount), 0)::text AS due
       FROM invoices i
       JOIN academic_years ay ON ay.id = i.academic_year_id
      WHERE i.student_id = $1
      GROUP BY ay.label, ay.starts_on
      ORDER BY ay.starts_on ASC`,
    [studentId],
  );

  const { rows: receipts } = await c.query<{
    id: string; receipt_no: string; issued_at: string; amount: string;
    method: string; invoice_no: string;
  }>(
    `SELECT pr.id, pr.receipt_no, pr.issued_at::text, pr.amount::text,
            pr.method::text AS method, i.invoice_no
       FROM payment_receipts pr
       JOIN invoices i ON i.id = pr.invoice_id
      WHERE pr.student_id = $1
      ORDER BY pr.issued_at DESC
      LIMIT 50`,
    [studentId],
  );

  return {
    years: years.map((y) => ({
      yearLabel: y.year_label,
      invoices: Number(y.invoices),
      billed: y.billed,
      paid: y.paid,
      due: y.due,
    })),
    // The receipt id is here so the Documents tab can print one through R-5's
    // endpoint, which re-authorises it. It is an id, not a URL.
    receipts: receipts.map((r) => ({
      id: r.id,
      receiptNo: r.receipt_no,
      issuedAt: r.issued_at,
      amount: r.amount,
      method: r.method,
      invoiceNo: r.invoice_no,
    })),
  };
}
