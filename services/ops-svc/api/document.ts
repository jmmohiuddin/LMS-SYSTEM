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
  buildRoutineSheet,
  routineOrientation,
  routineSheetCss,
  type RoutineScope,
  type StudentRef,
} from '../../../packages/ui-core/src/documents.ts';
// P9-9. The routine's authoritative read, imported rather than reimplemented.
//
// It carries the per-scope authorisation P9-8 built and tested — a teacher
// gets their own week, a guardian their ward's, an administrator the school —
// and printing must obey exactly those rules. Re-deriving them here would be
// a second opinion about permission, which is the failure P9-8 spent a whole
// section avoiding. `platform-svc` already imports `academics-svc/src` for
// the same reason: the logic belongs to one service and the caller is
// another.
import {
  readTimetable, teachingDays, type Scope,
} from '../../rms-svc/api/timetable.ts';
import { toBanglaDigits } from '../../../packages/ui-core/src/format.ts';
import { dhakaToday } from '../../../packages/server-core/src/time.ts';

/**
 * The purchasable service this endpoint IS (migration 051 catalogue).
 * The gate in withTenant refuses the request when a school has this one
 * turned off, in maintenance, or absent from its plan.
 */
const SERVICE = 'documents';

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
  // P9-9. Everybody has a routine, so everybody may print ONE — but which
  // one is decided by `readTimetable`'s per-scope rules, not by this list. A
  // student reaching `type=routine_sheet&scope=institution` is refused there,
  // by the same code that refuses them on screen.
  routine_sheet: ['principal', 'school_owner', 'academic_coordinator', 'it_admin',
                  'dept_head', 'class_teacher', 'subject_teacher', 'student', 'guardian'],
};

/**
 * Which SERVICE each document's content belongs to (B-53).
 *
 * The handler declares `service: 'documents'`, and that is right for the
 * printing machinery itself — the letterhead, the branding, the page set.
 * But the machinery is not the content. A fee receipt is the finance
 * module's data on a school's letterhead, a report card is the results
 * module's, an attendance sheet the attendance module's. Verified against a
 * running stack: with each of those services switched off, this endpoint
 * still returned a complete, branded, printable document.
 *
 * That is worse than an API leak. These are pages a school hands to a parent
 * or files with a board — a fee receipt printed by a school that has no
 * finance module is a document nobody in the office can reconcile, and an
 * attendance sheet issued while attendance is mid-migration is a signed
 * statement about children built from a half-moved table.
 *
 * `id_card` and `transfer_certificate` map to nothing: an identity card is
 * the roster, and a transfer certificate is an administrative act about
 * enrolment. Both belong to the school as such and survive every service
 * being off, which is exactly what a school closing its finance module still
 * needs in order to send a child elsewhere.
 */
//
// P9-9's `routine_sheet` maps to nothing for the same reason as those two.
// There is no `routine` row in `service_catalogue` — the timetable is not a
// switchable module, it is what the school IS — and a school that has turned
// finance off still runs classes and still pins a routine to the wall.
const CONTENT_SERVICE: Partial<Record<DocumentType, string>> = {
  fee_receipt: 'finance',
  report_card: 'results',
  admit_card: 'results',
  attendance_sheet: 'attendance',
};

/** A batch is a section, and a section is at most a large classroom. */
const MAX_BULK = 120;

/**
 * How much of a landscape A4 the grid gets, and what one section costs in it.
 *
 * MEASURED, by printing the real document to a real PDF with headless Chrome
 * and reading element heights back out of the rendered page. The first attempt
 * at this phase asserted a page box of 297mm x 210mm from computed style and
 * was satisfied; the rasterisation showed EVERY class page spilling onto a
 * second and third sheet, because the letterhead, the title row and R-5's
 * signature block were spending 76mm before an hour was drawn. Trimmed, and
 * with the meta laid out in a row instead of a stack, they spend 48mm.
 *
 *   GRID_MM       162mm is what is left of the 210mm page.
 *
 *   SECTION_MM    A section's line costs ~5.8mm where the subject fits the
 *                 column and ~9.8mm where it wraps — and the names that wrap
 *                 are the real ones: `বাংলাদেশ ও বিশ্বপরিচয়`, `তথ্য ও যোগাযোগ
 *                 প্রযুক্তি`. 8mm is that spread, weighted toward the wrap,
 *                 because a page that fits only when no subject is long is a
 *                 page that spills at the first madrasa.
 *
 * A WARNING ABOUT MEASURING THIS. Headless Chrome lays out at 800px unless
 * told otherwise, which constrains `.doc` to ~212mm rather than 297mm and
 * wraps almost every cell. Measured that way a section appears to cost 11mm
 * and the cap comes out at 1 — one page per section, which is the booklet
 * this phase set out to replace. Measure with `--window-size=1123,794`.
 *
 * The cap divides one by the other, per TEACHING row, because what fills a
 * page is `rows x sections` and schools differ in the first: a madrasa
 * running ten hours cannot fit the sections a primary school running five
 * can. A constant would have been right for one of them.
 */
const GRID_MM = 162;
const SECTION_MM = 8;
const HEAD_AND_BANDS_MM = 20;
/**
 * What a section costs on §9's notice-board sheet, relative to the reading
 * copy. The type is 22% larger, and the cost is 45% larger — because a wider
 * glyph does not just take more room, it takes a whole extra LINE the moment
 * a subject name stops fitting the column, and the names that stop fitting
 * are the common ones. Scaling by the type ratio alone was tried and the
 * rasterisation caught it: 10 pages of board sheet came out as 13.
 */
const BOARD_SCALE = 1.45;

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
    const ctx = { tenantId: claims.tid, userId: claims.sub, role: claims.role, service: SERVICE };

    const html = await db.withTenant(ctx, async (c) => {
      // The whole reason this is safe: branding is read from the row the
      // session's tenant context selects, and nothing else.
      const { rows: brandRows } = await c.query<{
        branding: unknown; name_bn: string; name_en: string;
      }>(
        // P9-9. The tenant's own NAME comes along with its branding.
        // `parseBranding({})` falls back to the neutral "শিক্ষা প্রতিষ্ঠান" —
        // deliberately, so an unbranded school does not look like a different
        // one — but a school that has never opened the branding screen still
        // HAS a name, given when it was created and never optional. Printing
        // a placeholder on its routine, its receipts and its certificates was
        // losing the one identifying fact every document is required to
        // carry. Branding still wins where it is set, so a school that brands
        // itself differently keeps that.
        `SELECT COALESCE(settings->'branding', '{}'::jsonb) AS branding,
                name_bn, name_en
           FROM tenants`,
      );
      const row = brandRows[0];
      const branding = parseBranding({
        ...(row?.name_bn ? { nameBn: row.name_bn, shortName: row.name_bn } : {}),
        ...(row?.name_en ? { nameEn: row.name_en } : {}),
        ...(row?.branding as Record<string, unknown> ?? {}),
      });

      // The content's own entitlement, checked before a single row of it is
      // read. `limited` still prints: a school in billing arrears is the one
      // whose parents most need a receipt for what they have paid.
      const contentService = CONTENT_SERVICE[type];
      if (contentService) {
        const { rows: st } = await c.query<{ state: string }>(
          'SELECT app.tenant_service_state(app.current_tenant(), $1) AS state',
          [contentService]);
        const state = st[0]?.state;
        if (state !== 'enabled' && state !== 'limited') {
          // 403 and not an empty document: a blank page reads as "this child
          // has no record", which is a different and more alarming claim than
          // "this school does not run that module".
          throw new HttpError(403,
            state === 'not_in_plan'
              ? 'এই নথির জন্য প্রয়োজনীয় সেবা আপনার প্যাকেজে নেই'
              : 'এই নথির জন্য প্রয়োজনীয় সেবা এই প্রতিষ্ঠানের জন্য আপাতত বন্ধ রয়েছে',
            'service_unavailable', { service: contentService });
        }
      }

      const sections = await build(c, ctx, type, q, branding);
      if (sections.length === 0) {
        throw new HttpError(404, 'নথির জন্য কোনো তথ্য পাওয়া যায়নি', 'no_data');
      }

      return brandedDocumentSet({
        branding,
        sections,
        locale: q.get('locale') === 'en' ? 'en' : 'bn',
        // P9-9. The routine is the first document whose PAPER depends on its
        // content: a section's week fits portrait, a whole institution's does
        // not. Everything else keeps `documentBodyCss()` alone and the A4
        // portrait `@page` that `brandedDocumentCss` sets.
        extraCss: documentBodyCss() + extraCssFor(type, q),
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
    case 'routine_sheet':        return routineSheet(c, ctx, q);
  }
}

/** The scope a routine sheet is of, validated the same way the API validates it. */
function routineScopeOf(q: URLSearchParams): RoutineScope {
  const raw = q.get('scope') ?? '';
  const known: RoutineScope[] = ['institution', 'class', 'group', 'stream',
                                 'section', 'teacher', 'room', 'student'];
  if (!known.includes(raw as RoutineScope)) {
    throw new HttpError(400, `scope must be one of: ${known.join(', ')}`, 'invalid_scope');
  }
  return raw as RoutineScope;
}

/**
 * Paper that follows the content, not the document type.
 *
 * `board=1` is §9's notice-board sheet: the same grid at a size meant to be
 * read standing a metre from the wall. It changes only type scale, so the
 * board copy and the file copy are the same routine — a mode that also
 * dropped or reordered anything would give a school two documents to
 * reconcile the next time somebody edited the timetable.
 */
function extraCssFor(type: DocumentType, q: URLSearchParams): string {
  if (type !== 'routine_sheet') return '';
  const board = q.get('board') === '1';
  return routineSheetCss(routineOrientation(routineScopeOf(q)), board);
}

/**
 * One printed routine — the SAME read the screen uses.  (P9-9)
 *
 * `readTimetable` holds both the authorisation and the filter, so a printed
 * sheet cannot show an hour the screen would refuse, and cannot go stale
 * against it either. It reads `routines.status = 'active'` and nothing else,
 * which is what makes §15 true without a check here: a draft, a routine under
 * review and a superseded version are all invisible to it.
 */
async function routineSheet(
  c: Client, ctx: Ctx, q: URLSearchParams,
): Promise<BrandedSection[]> {
  const scope = routineScopeOf(q);
  const board = q.get('board') === '1';
  const idParam = q.get('id') ?? '';
  const id = idParam === 'self' ? ctx.userId : idParam;

  const [t, days] = await Promise.all([
    readTimetable(c as never, scope as Scope, id, ctx.role, null),
    teachingDays(c as never),
  ]);
  if (!t.published) {
    // Not an empty grid. A blank sheet pinned to a noticeboard is a claim
    // that the school has no classes; "nothing published yet" is the truth.
    throw new HttpError(409,
      'এখনো কোনো রুটিন প্রকাশ করা হয়নি — প্রকাশের পর ছাপা যাবে।',
      'not_published');
  }

  // One page per shift, ALWAYS. A two-shift school's morning period 8 and day
  // period 1 are different hours with the same number, so a single grid keyed
  // on period number would print two different times in one row.
  //
  // Within a shift, a booklet is one page PER CLASS — that is the grouping a
  // school reads by, and §8 asks for it to survive. A class wider than one
  // page splits into further CLASS pages of six sections each, never into
  // per-section pages: the first version did the latter and turned a
  // 120-section college into 120 sheets with no class structure left in them.
  //
  //   20-section school  → 5 classes of 4  → 5 pages, one per class
  //   120-section college → 4 classes of 30 → 20 pages, 5 per class
  //
  // Each page names its class and lists the sections on it, so a reader
  // holding sheet three of five knows what they are holding.
  const booklet = scope === 'institution' || scope === 'group'
                  || scope === 'stream' || scope === 'class';

  const pages: BrandedSection[] = [];
  // §12 needs "page x of y", and y is not known until every page is built.
  // Collected as data first, rendered once the count is in.
  const specs: Array<Parameters<typeof buildRoutineSheet>[0]> = [];

  for (const r of t.routines) {
    const periods = t.periods.filter((p) => p.routineId === r.id);
    const mine = t.lessons.filter((l) => l.routineId === r.id);
    const common = {
      scopeKind: scope, yearLabel: r.yearLabel, shiftBn: r.shiftBn,
      version: r.version, publishedAt: r.publishedAt, days, periods,
    };

    if (!booklet) {
      specs.push({ ...common, scopeTitle: t.titleBn, lessons: mine });
      continue;
    }

    // Grouped on (level, name) rather than name alone: a college runs
    // "একাদশ" in both science and humanities, and merging those onto one page
    // would stack two classes' sections in a cell — the very thing this split
    // exists to prevent. The level also gives the booklet its order.
    const byClass = new Map<string, typeof mine>();
    for (const l of mine) {
      const key = `${String(l.classLevel ?? 99).padStart(2, '0')}|${l.classBn ?? ''}`;
      if (!byClass.has(key)) byClass.set(key, []);
      byClass.get(key)!.push(l);
    }

    for (const key of [...byClass.keys()].sort()) {
      const lessons = byClass.get(key)!;
      const classBn = lessons[0]?.classBn ?? key.split('|')[1] ?? '';
      const sections = [...new Set(lessons.map((l) => l.sectionLabel ?? ''))].sort();
      // Only TEACHING rows carry lessons; a break is a one-line band.
      const rows = Math.max(1,
        periods.filter((p) => (p.kind ?? 'teaching') === 'teaching').length);
      const perPage = Math.max(1, Math.min(8, Math.floor(
        (GRID_MM - HEAD_AND_BANDS_MM) / rows
        / (SECTION_MM * (board ? BOARD_SCALE : 1)))));

      for (let i = 0; i < sections.length; i += perPage) {
        const chunk = new Set(sections.slice(i, i + perPage));
        specs.push({
          // The page stays a CLASS page even when a class needs several of
          // them — the title says the class, and the sheet's own caption says
          // which sections are on this one.
          ...common, scopeKind: 'class', scopeTitle: classBn,
          lessons: lessons.filter((l) => chunk.has(l.sectionLabel ?? '')),
        });
      }
    }
  }

  for (const [i, spec] of specs.entries()) {
    pages.push(buildRoutineSheet(
      specs.length > 1 ? { ...spec, pageNo: i + 1, pageCount: specs.length } : spec));
  }
  return pages;
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
        `একবারে সর্বোচ্চ ${toBanglaDigits(MAX_BULK)} জনের নথি তৈরি করা যায়`, 'too_many', { field: 'studentIds' });
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
    // The date printed on a document a school keeps. A UTC server dated a
    // certificate issued at 00:30 in Dhaka to the day before.
    issuedOn: dhakaToday(),
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
