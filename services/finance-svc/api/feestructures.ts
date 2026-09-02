/**
 * GET    /api/v1/finance/feestructures?yearId=…  — what each fee costs
 * POST   /api/v1/finance/feestructures           — set a fee
 * PATCH  /api/v1/finance/feestructures           — change one
 * DELETE /api/v1/finance/feestructures?id=…      — remove one
 *
 * ── Why this exists (P0/A2) ─────────────────────────────────────────────
 * `fee_structures` had **zero rows across 126 institutions** and no writer
 * anywhere — not in TypeScript, not in any `app.*` function. The monthly
 * invoice run joins this table, so `POST /api/v1/finance/generate` produced
 * zero invoices for every school, every month, and returned success while
 * doing it. A school could enrol students and take attendance and could not
 * charge a single taka.
 *
 * `fee_heads` are different and already work: `app.provision_tenant` seeds
 * them, so a new school starts with a standard set (tuition, admission, exam,
 * transport…). What was missing is the price list — what each head costs, this
 * year, for this class.
 *
 * ── The contract the invoice engine imposes ─────────────────────────────
 * From `generate` in ./index.ts, quoted because the screen has to be honest
 * about it rather than paper over it:
 *
 *     JOIN fee_structures fs ON fs.academic_year_id = $1
 *                           AND (fs.class_id = e.class_id OR fs.class_id IS NULL)
 *                           AND fs.quota_category IS NULL
 *     JOIN fee_heads fh ON fh.id = fs.fee_head_id
 *                      AND fh.is_active AND fh.frequency = 'monthly'
 *     ORDER BY e.student_id, fs.fee_head_id, fs.class_id NULLS LAST
 *
 * Three things follow, and all three are surfaced rather than hidden:
 *
 *  1. Only `monthly` heads are billed by the monthly run. A price set against
 *     an `annual`, `exam` or `one_time` head is stored and never invoiced by
 *     it. `billedByMonthlyRun` says so per row, so the office is not left
 *     wondering why a fee it configured never appeared.
 *  2. `quota_category IS NULL`, so the engine ignores quota-scoped rows
 *     entirely. This endpoint therefore does not offer a quota field at all —
 *     a control whose value the engine discards is exactly the defect this
 *     project keeps finding.
 *  3. A NULL `class_id` is the school-wide price and a class row overrides it.
 *
 * ── Deleting a price is not deleting money ──────────────────────────────
 * Checkable rather than assumed: `invoice_lines` stores `fee_head_id`,
 * `description_bn`, `amount`, `waiver_amount` and `net_amount`, and does NOT
 * reference `fee_structures`. An issued invoice carries its own numbers, so
 * removing the configuration that produced it cannot alter or orphan it. A
 * structure is next month's instruction, not last month's record.
 *
 * ── Where authorization lives ───────────────────────────────────────────
 * Migration 067, in the same commit. Before it these tables carried
 * `tenant_isolation` and nothing else, so a session with
 * `app.role = 'student'` could set its own tuition to zero — proved against a
 * live database. `requireRole` below is the clean 403 in front of that.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { sharedDb } from '../../../packages/server-core/src/db.ts';
import { query, readJson, json, HttpError } from '../../../packages/server-core/src/http.ts';
import { authenticate, requireStaff, requireRole } from '../../../packages/server-core/src/auth.ts';
import { writeAudit } from '../../../packages/server-core/src/audit.ts';

/** The purchasable service this endpoint IS (migration 051 catalogue). */
const SERVICE = 'finance';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Mirrors `fee_structures_insert_scope` in migration 067. `it_admin` is here
 * and not on `fee_waivers`: they set a school up before an accountant exists,
 * but they do not decide which child stops paying.
 */
const FEE_ADMIN_ROLES = ['principal', 'school_owner', 'accountant', 'it_admin'];

const AMOUNT_MAX = 10_000_000;   // ten million taka: a school fee, not a budget
const DUE_DAY_MIN = 1;
const DUE_DAY_MAX = 28;          // fee_structures_due_day_of_month_check
/** The same numbers in Bangla, for the sentences the office reads. */
const DUE_DAY_MIN_BN = '১';
const DUE_DAY_MAX_BN = '২৮';

export default async function handler(
  req: IncomingMessage, res: ServerResponse, cors: Record<string, string>,
): Promise<void> {
  const claims = await authenticate(req);
  const db = await sharedDb();
  const ctx = {
    tenantId: claims.tid, userId: claims.sub, role: claims.role, service: SERVICE,
  };

  // Reading the price list is staff-wide: a class teacher fielding "how much
  // is my son's transport fee" needs it, and it holds nothing about any child.
  if (req.method === 'GET') {
    requireStaff(claims);
    json(res, 200, await list(db, ctx, req, claims.role), cors);
    return;
  }
  if (req.method === 'POST') {
    requireRole(claims, FEE_ADMIN_ROLES);
    json(res, 200, await create(db, ctx, req), cors);
    return;
  }
  if (req.method === 'PATCH') {
    requireRole(claims, FEE_ADMIN_ROLES);
    json(res, 200, await update(db, ctx, req), cors);
    return;
  }
  if (req.method === 'DELETE') {
    requireRole(claims, FEE_ADMIN_ROLES);
    json(res, 200, await remove(db, ctx, req), cors);
    return;
  }
  json(res, 405, { error: 'method_not_allowed' }, cors);
}

type Db = Awaited<ReturnType<typeof sharedDb>>;
type Ctx = { tenantId: string; userId: string; role: string; service: string };

interface Row {
  id: string;
  fee_head_id: string;
  head_bn: string;
  head_code: string;
  frequency: string;
  head_active: boolean;
  academic_year_id: string;
  class_id: string | null;
  class_bn: string | null;
  amount: string;
  late_fee_per_day: string | null;
  late_fee_cap: string | null;
  due_day_of_month: number | null;
}

const shape = (r: Row) => ({
  id: r.id,
  feeHeadId: r.fee_head_id,
  headBn: r.head_bn,
  headCode: r.head_code,
  frequency: r.frequency,
  headActive: r.head_active,
  academicYearId: r.academic_year_id,
  classId: r.class_id,
  classBn: r.class_bn,
  amount: Number(r.amount),
  lateFeePerDay: r.late_fee_per_day === null ? null : Number(r.late_fee_per_day),
  lateFeeCap: r.late_fee_cap === null ? null : Number(r.late_fee_cap),
  dueDayOfMonth: r.due_day_of_month,
  // The honest flag. A price on a non-monthly head is stored and never
  // invoiced by the monthly run, and the office deserves to be told on the
  // row rather than left to wonder.
  billedByMonthlyRun: r.frequency === 'monthly' && r.head_active,
});

async function list(db: Db, ctx: Ctx, req: IncomingMessage, role: string): Promise<unknown> {
  const yearId = query(req).get('yearId') ?? '';
  if (yearId && !UUID_RE.test(yearId)) {
    throw new HttpError(400, 'শিক্ষাবর্ষ সঠিক নয়।', 'bad_year', { field: 'yearId' });
  }

  return db.withTenant(ctx, async (c) => {
    // Default to the current year rather than making the caller name one:
    // there is exactly one `is_current` year per school.
    const year = yearId || (await c.query<{ id: string }>(
      `SELECT id FROM academic_years WHERE is_current ORDER BY starts_on DESC LIMIT 1`)
    ).rows[0]?.id || '';

    if (!year) {
      // A school with no academic year cannot have a price list. Saying so is
      // more use than an empty table.
      return {
        canManage: FEE_ADMIN_ROLES.includes(role),
        academicYearId: null, years: [], classes: [], heads: [], structures: [],
      };
    }

    const [structures, years, classes, heads] = await Promise.all([
      c.query<Row>(
        `SELECT fs.id, fs.fee_head_id, fh.name_bn AS head_bn, fh.code AS head_code,
                fh.frequency, fh.is_active AS head_active,
                fs.academic_year_id, fs.class_id, cl.name_bn AS class_bn,
                fs.amount, fs.late_fee_per_day, fs.late_fee_cap, fs.due_day_of_month
           FROM fee_structures fs
           JOIN fee_heads fh ON fh.id = fs.fee_head_id
           LEFT JOIN classes cl ON cl.id = fs.class_id
          WHERE fs.academic_year_id = $1
          ORDER BY fh.frequency, fh.name_bn, cl.level_no NULLS FIRST`,
        [year]),
      c.query<{ id: string; label: string; is_current: boolean }>(
        `SELECT id, label, is_current FROM academic_years ORDER BY starts_on DESC`),
      c.query<{ id: string; name_bn: string }>(
        `SELECT id, name_bn FROM classes ORDER BY level_no, name_bn`),
      c.query<{ id: string; name_bn: string; code: string; frequency: string; is_active: boolean }>(
        `SELECT id, name_bn, code, frequency, is_active FROM fee_heads
          ORDER BY is_active DESC, frequency, name_bn`),
    ]);

    return {
      canManage: FEE_ADMIN_ROLES.includes(role),
      academicYearId: year,
      years: years.rows.map((y) => ({ id: y.id, label: y.label, isCurrent: y.is_current })),
      classes: classes.rows.map((x) => ({ id: x.id, nameBn: x.name_bn })),
      heads: heads.rows.map((h) => ({
        id: h.id, nameBn: h.name_bn, code: h.code,
        frequency: h.frequency, isActive: h.is_active,
      })),
      structures: structures.rows.map(shape),
    };
  });
}

interface Body {
  id?: string;
  feeHeadId?: string;
  academicYearId?: string;
  classId?: string | null;
  amount?: number;
  lateFeePerDay?: number | null;
  lateFeeCap?: number | null;
  dueDayOfMonth?: number | null;
}

function money(v: unknown, field: string, label: string): number | null {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) {
    throw new HttpError(400, `${label} ঋণাত্মক হতে পারে না।`, 'bad_amount', { field });
  }
  if (n > AMOUNT_MAX) {
    throw new HttpError(400, `${label} অনেক বেশি — আবার দেখুন।`, 'bad_amount', { field });
  }
  // Two decimal places: the column is numeric(12,2) and a third would be
  // silently rounded, which is not a thing to do to money.
  return Math.round(n * 100) / 100;
}

function validate(b: Body): {
  amount: number; lateFeePerDay: number; lateFeeCap: number | null;
  dueDay: number | null;
} {
  const amount = money(b.amount, 'amount', 'টাকার অঙ্ক');
  if (amount === null) {
    throw new HttpError(400, 'টাকার অঙ্ক লিখুন।', 'bad_amount', { field: 'amount' });
  }
  // NOT NULL with a default of 0 in the schema, and 0 is also what "no late
  // fee" means — an unknown daily charge is not a thing. Passing an explicit
  // NULL violated the constraint and surfaced as a 500.
  const lateFeePerDay = money(b.lateFeePerDay, 'lateFeePerDay', 'দৈনিক বিলম্ব ফি') ?? 0;
  const lateFeeCap = money(b.lateFeeCap, 'lateFeeCap', 'বিলম্ব ফির সর্বোচ্চ সীমা');

  let dueDay: number | null = null;
  if (b.dueDayOfMonth !== undefined && b.dueDayOfMonth !== null) {
    dueDay = Number(b.dueDayOfMonth);
    if (!Number.isInteger(dueDay) || dueDay < DUE_DAY_MIN || dueDay > DUE_DAY_MAX) {
      // 28, not 31: February. The CHECK constraint says the same thing.
      throw new HttpError(400,
        `শেষ তারিখ ${DUE_DAY_MIN_BN} থেকে ${DUE_DAY_MAX_BN}-এর মধ্যে দিন।`,
        'bad_due_day', { field: 'dueDayOfMonth' });
    }
  }
  return { amount, lateFeePerDay, lateFeeCap, dueDay };
}

async function create(db: Db, ctx: Ctx, req: IncomingMessage): Promise<unknown> {
  const body = await readJson<Body>(req);
  if (!UUID_RE.test(body.feeHeadId ?? '')) {
    throw new HttpError(400, 'কোন ফি তা বেছে নিন।', 'bad_head', { field: 'feeHeadId' });
  }
  if (!UUID_RE.test(body.academicYearId ?? '')) {
    throw new HttpError(400, 'শিক্ষাবর্ষ বেছে নিন।', 'bad_year', { field: 'academicYearId' });
  }
  const classId = body.classId ? String(body.classId) : null;
  if (classId !== null && !UUID_RE.test(classId)) {
    throw new HttpError(400, 'শ্রেণি সঠিক নয়।', 'bad_class', { field: 'classId' });
  }
  const v = validate(body);

  return db.withTenant(ctx, async (c) => {
    // RLS scopes all three lookups to the caller's school, so another
    // school's head, year or class is simply not found — which is the same
    // answer a mistyped id gets, deliberately.
    const head = await c.query<{ name_bn: string; frequency: string }>(
      `SELECT name_bn, frequency FROM fee_heads WHERE id = $1`, [body.feeHeadId]);
    if (head.rowCount === 0) throw new HttpError(404, 'ফি-এর খাতটি পাওয়া যায়নি।', 'head_not_found');

    const yr = await c.query(`SELECT 1 FROM academic_years WHERE id = $1`, [body.academicYearId]);
    if (yr.rowCount === 0) throw new HttpError(404, 'শিক্ষাবর্ষটি পাওয়া যায়নি।', 'year_not_found');

    if (classId) {
      const cl = await c.query(`SELECT 1 FROM classes WHERE id = $1`, [classId]);
      if (cl.rowCount === 0) throw new HttpError(404, 'শ্রেণিটি পাওয়া যায়নি।', 'class_not_found');
    }

    const { rows } = await c.query<Row>(
      `INSERT INTO fee_structures
         (tenant_id, fee_head_id, academic_year_id, class_id, quota_category,
          amount, late_fee_per_day, late_fee_cap, due_day_of_month)
       VALUES (app.current_tenant(), $1, $2, $3, NULL, $4, $5, $6, $7)
       RETURNING id, fee_head_id, academic_year_id, class_id, amount,
                 late_fee_per_day, late_fee_cap, due_day_of_month,
                 '' AS head_bn, '' AS head_code, '' AS frequency,
                 true AS head_active, NULL AS class_bn`,
      [body.feeHeadId, body.academicYearId, classId, v.amount,
        v.lateFeePerDay, v.lateFeeCap, v.dueDay]);

    await writeAudit(c, ctx, {
      action: 'finance.fee_structure.create',
      entityType: 'fee_structure',
      entityId: rows[0].id,
      after: {
        head: head.rows[0].name_bn, frequency: head.rows[0].frequency,
        classId, amount: v.amount, dueDayOfMonth: v.dueDay,
        lateFeePerDay: v.lateFeePerDay, lateFeeCap: v.lateFeeCap,
      },
    });

    return { id: rows[0].id, headBn: head.rows[0].name_bn, amount: v.amount };
  }, { write: true });
}

async function update(db: Db, ctx: Ctx, req: IncomingMessage): Promise<unknown> {
  const body = await readJson<Body>(req);
  const id = (body.id ?? '').trim();
  if (!UUID_RE.test(id)) {
    throw new HttpError(400, 'কোন ফি তা জানানো হয়নি।', 'structure_required', { field: 'id' });
  }

  return db.withTenant(ctx, async (c) => {
    const before = await c.query<{
      amount: string; late_fee_per_day: string | null; late_fee_cap: string | null;
      due_day_of_month: number | null; head_bn: string;
    }>(
      `SELECT fs.amount, fs.late_fee_per_day, fs.late_fee_cap, fs.due_day_of_month,
              fh.name_bn AS head_bn
         FROM fee_structures fs JOIN fee_heads fh ON fh.id = fs.fee_head_id
        WHERE fs.id = $1`, [id]);
    if (before.rowCount === 0) {
      throw new HttpError(404, 'এই ফি-টি পাওয়া যায়নি।', 'structure_not_found');
    }
    const was = before.rows[0];

    // PATCH carries the unnamed fields across. Letting them fall through to a
    // create-time default is how "change the due date" silently zeroes a late
    // fee — a bug the room writer shipped with and its own test caught.
    const v = validate({
      amount: body.amount ?? Number(was.amount),
      lateFeePerDay: body.lateFeePerDay !== undefined
        ? body.lateFeePerDay
        : (was.late_fee_per_day === null ? null : Number(was.late_fee_per_day)),
      lateFeeCap: body.lateFeeCap !== undefined
        ? body.lateFeeCap
        : (was.late_fee_cap === null ? null : Number(was.late_fee_cap)),
      dueDayOfMonth: body.dueDayOfMonth !== undefined ? body.dueDayOfMonth : was.due_day_of_month,
    });

    await c.query(
      `UPDATE fee_structures
          SET amount = $2, late_fee_per_day = $3, late_fee_cap = $4, due_day_of_month = $5
        WHERE id = $1`,
      [id, v.amount, v.lateFeePerDay, v.lateFeeCap, v.dueDay]);

    await writeAudit(c, ctx, {
      action: 'finance.fee_structure.update',
      entityType: 'fee_structure',
      entityId: id,
      before: {
        head: was.head_bn, amount: Number(was.amount),
        dueDayOfMonth: was.due_day_of_month,
        lateFeePerDay: was.late_fee_per_day === null ? null : Number(was.late_fee_per_day),
      },
      after: {
        head: was.head_bn, amount: v.amount, dueDayOfMonth: v.dueDay,
        lateFeePerDay: v.lateFeePerDay,
      },
    });

    return { id, headBn: was.head_bn, amount: v.amount };
  }, { write: true });
}

async function remove(db: Db, ctx: Ctx, req: IncomingMessage): Promise<unknown> {
  const id = query(req).get('id') ?? '';
  if (!UUID_RE.test(id)) {
    throw new HttpError(400, 'কোন ফি তা জানানো হয়নি।', 'structure_required', { field: 'id' });
  }

  return db.withTenant(ctx, async (c) => {
    const before = await c.query<{ amount: string; head_bn: string; class_id: string | null }>(
      `SELECT fs.amount, fs.class_id, fh.name_bn AS head_bn
         FROM fee_structures fs JOIN fee_heads fh ON fh.id = fs.fee_head_id
        WHERE fs.id = $1`, [id]);
    if (before.rowCount === 0) {
      throw new HttpError(404, 'এই ফি-টি পাওয়া যায়নি।', 'structure_not_found');
    }
    const was = before.rows[0];

    const del = await c.query(`DELETE FROM fee_structures WHERE id = $1`, [id]);
    if (del.rowCount === 0) {
      // RLS matched no row for a DELETE the role is not allowed. Reported as
      // a refusal rather than a success that changed nothing.
      throw new HttpError(403, 'এই ফি মুছে ফেলার অনুমতি নেই।', 'forbidden');
    }

    await writeAudit(c, ctx, {
      action: 'finance.fee_structure.delete',
      entityType: 'fee_structure',
      entityId: id,
      before: { head: was.head_bn, amount: Number(was.amount), classId: was.class_id },
    });

    // Said back to the caller because it is the question an accountant will
    // ask: no, this did not touch anything already billed.
    return { id, headBn: was.head_bn, issuedInvoicesUnaffected: true };
  }, { write: true });
}
