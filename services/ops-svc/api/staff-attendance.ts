/**
 * GET  /api/v1/ops/staff-attendance?date=YYYY-MM-DD  — the day's register
 * POST /api/v1/ops/staff-attendance                  — mark one teacher
 *
 * M6 of P-pilot-hardening. The register every school already keeps in a book
 * by the office door, and the one thing the substitute finder was missing.
 *
 * ── Why this exists ─────────────────────────────────────────────────────
 * `app.rank_invigilators` and the substitute finder have both refused to
 * offer an absent teacher since migration 006. They read `teacher_leaves` and
 * `teacher_availability`, and nothing in the product has ever written to
 * either. So the filters were real, tested, and inert: on a live school the
 * substitute finder would cheerfully propose the one teacher everybody knows
 * is at a funeral. Migration 063 adds the register; this is the screen's half
 * of it.
 *
 * ── What this is NOT ────────────────────────────────────────────────────
 * Not leave management, not payroll, not an approval workflow. Three states,
 * one optional line of text, one row per teacher per day. A school that wants
 * accrual balances and sign-off chains wants a different product, and
 * `teacher_leaves` is still sitting there for the day this one grows into it.
 *
 * ── The date is a Bangladeshi date ──────────────────────────────────────
 * `app.today_dhaka()`, never CURRENT_DATE and never a UTC-truncated
 * timestamp. Between midnight and 6am Dhaka a UTC date names YESTERDAY, and
 * the unique key here is (tenant, teacher, date) — so the register would
 * silently overwrite the previous day's marks every early morning. P7 found
 * exactly this bug on a form whose table had the same shape.
 *
 * ── Marking is not the same as reading ──────────────────────────────────
 * Any staff member may read the register; a teacher hunting for cover needs
 * it and it holds nothing private. Writing is the office's. That is enforced
 * by `teacher_attendance_write_scope` in the database, not only by the
 * `requireRole` below — the role check is the clean 403 in front of RLS.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { sharedDb } from '../../../packages/server-core/src/db.ts';
import { corsHeaders, readJson, json, query, HttpError } from '../../../packages/server-core/src/http.ts';
import { authenticate, requireRole } from '../../../packages/server-core/src/auth.ts';
import { writeAudit } from '../../../packages/server-core/src/audit.ts';

/** Who may mark the register. Mirrors the RESTRICTIVE policy in 063. */
const MARK_ROLES = ['principal', 'school_owner', 'it_admin', 'academic_coordinator'];

/**
 * Whose attendance is kept. The same four role codes the substitute finder
 * draws its candidates from — a register that listed people the finder can
 * never offer would be a register nobody bothers to fill in.
 */
const TEACHING_ROLES = ['class_teacher', 'subject_teacher', 'dept_head', 'academic_coordinator'];

const STATUSES = new Set(['present', 'absent', 'on_leave']);
const REASON_MAX = 200;

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const cors = corsHeaders([], 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }

  try {
    const claims = await authenticate(req);
    const db = await sharedDb();
    const ctx = { tenantId: claims.tid, userId: claims.sub, role: claims.role };

    if (req.method === 'GET')  { json(res, 200, await read(db, ctx, req), cors); return; }
    if (req.method === 'POST') { requireRole(claims, MARK_ROLES); json(res, 200, await mark(db, ctx, req), cors); return; }

    json(res, 405, { error: 'method_not_allowed' }, cors);
  } catch (err) {
    if (err instanceof HttpError) {
      json(res, err.status, { error: err.code, message: err.message, ...(err.detail ?? {}) }, cors);
      return;
    }
    console.error('[staff-attendance] unexpected error', err);
    json(res, 500, { error: 'internal_error' }, cors);
  }
}

type Db = Awaited<ReturnType<typeof sharedDb>>;
type Ctx = { tenantId: string; userId: string; role: string };

/**
 * A date the caller supplied, or today in Dhaka. Validated as a shape rather
 * than parsed into a Date — `new Date('2026-09-01')` is midnight UTC, which is
 * six hours before the day it names here.
 */
function requestedDate(req: IncomingMessage): string | null {
  const raw = query(req).get('date');
  if (!raw) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    throw new HttpError(400, 'তারিখ সঠিক নয়।', 'bad_date');
  }
  return raw;
}

interface Row {
  teacher_id: string;
  full_name_bn: string | null;
  full_name_en: string | null;
  role_code: string;
  status: string | null;
  reason: string | null;
  marked_at: string | null;
  marked_by_name: string | null;
}

/**
 * The whole staff list with the day's marks alongside — a LEFT JOIN, because
 * the screen must show everyone who could be marked, not only those already
 * marked. An unmarked teacher comes back with `status: null`, which the UI
 * renders as "not yet marked" and `app.teacher_absent_on()` treats as present.
 */
async function read(db: Db, ctx: Ctx, req: IncomingMessage): Promise<unknown> {
  const date = requestedDate(req);

  return db.withTenant(ctx, async (c) => {
    const { rows } = await c.query<Row & { the_date: string }>(
      `WITH d AS (SELECT COALESCE($1::date, app.today_dhaka()) AS day)
       SELECT u.id AS teacher_id, u.full_name_bn, u.full_name_en,
              max(ur.role_code) AS role_code,
              ta.status, ta.reason, ta.marked_at,
              m.full_name_bn AS marked_by_name,
              (SELECT day FROM d)::text AS the_date
         FROM users u
         JOIN user_roles ur ON ur.user_id = u.id AND ur.tenant_id = u.tenant_id
         LEFT JOIN teacher_attendance ta
                ON ta.teacher_id = u.id
               AND ta.attendance_date = (SELECT day FROM d)
         LEFT JOIN users m ON m.id = ta.marked_by
        WHERE u.status = 'active'
          AND u.deleted_at IS NULL
          AND ur.role_code = ANY($2)
          AND (ur.valid_until IS NULL OR ur.valid_until >= (SELECT day FROM d))
        GROUP BY u.id, u.full_name_bn, u.full_name_en,
                 ta.status, ta.reason, ta.marked_at, m.full_name_bn
        ORDER BY u.full_name_bn`,
      [date, TEACHING_ROLES],
    );

    const away = rows.filter((r) => r.status === 'absent' || r.status === 'on_leave').length;
    const marked = rows.filter((r) => r.status !== null).length;

    return {
      date: rows[0]?.the_date ?? date,
      canMark: MARK_ROLES.includes(ctx.role),
      total: rows.length,
      marked,
      away,
      teachers: rows.map((r) => ({
        teacherId: r.teacher_id,
        name: { bn: r.full_name_bn, en: r.full_name_en },
        roleCode: r.role_code,
        status: r.status,
        reason: r.reason,
        markedAt: r.marked_at,
        markedBy: r.marked_by_name,
      })),
    };
  });
}

interface MarkBody {
  teacherId?: string;
  date?: string;
  status?: string;
  reason?: string;
}

/**
 * One teacher, one day. Re-marking corrects the existing row rather than
 * adding a second opinion — the audit log carries who changed what, which is
 * where a correction belongs.
 */
async function mark(db: Db, ctx: Ctx, req: IncomingMessage): Promise<unknown> {
  const body = await readJson<MarkBody>(req);
  const teacherId = body.teacherId ?? '';
  const status = body.status ?? '';
  const reason = (body.reason ?? '').trim();

  if (!teacherId) throw new HttpError(400, 'কোন শিক্ষক তা জানানো হয়নি।', 'teacher_required');
  if (!STATUSES.has(status)) throw new HttpError(400, 'উপস্থিতির অবস্থা সঠিক নয়।', 'bad_status');
  if (body.date !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(body.date)) {
    throw new HttpError(400, 'তারিখ সঠিক নয়।', 'bad_date');
  }
  if (reason.length > REASON_MAX) {
    throw new HttpError(400, `কারণ ${REASON_MAX} অক্ষরের মধ্যে লিখুন।`, 'reason_too_long');
  }

  return db.withTenant(ctx, async (c) => {
    // The person must actually be teaching staff at this school. Without
    // this, the register would accept any user id RLS lets through — a
    // guardian, a student — and the substitute finder would then be
    // excluding people it was never going to offer.
    const who = await c.query<{ full_name_bn: string | null }>(
      `SELECT u.full_name_bn
         FROM users u
        WHERE u.id = $1 AND u.status = 'active' AND u.deleted_at IS NULL
          AND EXISTS (SELECT 1 FROM user_roles ur
                       WHERE ur.user_id = u.id AND ur.tenant_id = u.tenant_id
                         AND ur.role_code = ANY($2))`,
      [teacherId, TEACHING_ROLES],
    );
    if (who.rowCount === 0) {
      throw new HttpError(404, 'এই শিক্ষককে পাওয়া যায়নি।', 'teacher_not_found');
    }

    // Read the previous mark before overwriting it, so the audit entry can
    // say what changed rather than only what it now is.
    const prev = await c.query<{ status: string; reason: string | null }>(
      `SELECT status, reason FROM teacher_attendance
        WHERE teacher_id = $1
          AND attendance_date = COALESCE($2::date, app.today_dhaka())`,
      [teacherId, body.date ?? null],
    );

    const { rows } = await c.query<{ attendance_date: string; status: string; reason: string | null }>(
      `INSERT INTO teacher_attendance
         (tenant_id, teacher_id, attendance_date, status, reason, marked_by)
       VALUES (app.current_tenant(), $1,
               COALESCE($2::date, app.today_dhaka()), $3, NULLIF($4, ''), $5)
       ON CONFLICT (tenant_id, teacher_id, attendance_date) DO UPDATE
          SET status     = EXCLUDED.status,
              reason     = EXCLUDED.reason,
              marked_by  = EXCLUDED.marked_by,
              updated_at = now()
       RETURNING attendance_date::text AS attendance_date, status, reason`,
      [teacherId, body.date ?? null, status, reason, ctx.userId],
    );
    const row = rows[0];

    await writeAudit(c, ctx, {
      action: 'ops.staff_attendance.mark',
      entityType: 'teacher_attendance',
      entityId: teacherId,
      before: prev.rows[0] ? { status: prev.rows[0].status, reason: prev.rows[0].reason } : null,
      after: { status: row.status, reason: row.reason, date: row.attendance_date },
    });

    return {
      teacherId,
      nameBn: who.rows[0].full_name_bn,
      date: row.attendance_date,
      status: row.status,
      reason: row.reason,
    };
    // `write: true` refuses a read-only school before the handler does work
    // it would throw away. It is what db.ts asks write paths to pass, and no
    // endpoint had been passing it — the guarantee comes from
    // `transaction_read_only` either way, so nothing was broken by that, but
    // this is the documented shape.
  }, { write: true });
}
