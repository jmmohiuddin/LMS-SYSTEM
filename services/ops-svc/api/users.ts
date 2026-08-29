/**
 * GET   /api/v1/ops/users?q=…&role=…  — search the institution's people
 * POST  /api/v1/ops/users             — create a staff account
 * PATCH /api/v1/ops/users             — deactivate / reactivate
 *
 * R-3 of docs/11-MASTER-PLAN.md, Part B. The IT admin's user screen.
 *
 * ── Deactivate, never delete ────────────────────────────────────────────
 * There is no DELETE here and there will not be one. A teacher who left in
 * 2024 still marked attendance in 2024, still published marks, and is still
 * the answer to "who taught this section". `users.status` moves to 'left';
 * every row that references them keeps referencing a person who exists.
 * `section_subject_teachers.teacher_id` is even ON DELETE RESTRICT, so the
 * database would refuse anyway — this is the schema's opinion, not a new one.
 *
 * ── Creating an account does not create a password ──────────────────────
 * F-202's activation codes already solve first login without an SMS
 * aggregator: the school creates the account, the system issues a short code,
 * the teacher redeems it. This endpoint therefore never touches
 * `password_hash` and never returns a credential. Inventing a second
 * onboarding path here would be a second place for account takeover to live.
 *
 * ── Search is over this institution, and cannot be otherwise ────────────
 * No tenant parameter exists. RLS scopes every query to the caller's school,
 * so a search for a name that exists in another tenant returns nothing — not
 * because the query filters it out, but because the row is not there.
 *
 * Phone numbers are searchable because that is how a Bangladeshi school office
 * actually identifies a person, but the search is EXACT on phone: a prefix
 * search over a PII column is a way to enumerate the school's contact list one
 * digit at a time.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { sharedDb } from '../../../packages/server-core/src/db.ts';
import { corsHeaders, readJson, json, query, HttpError } from '../../../packages/server-core/src/http.ts';
import { authenticate, requireRole } from '../../../packages/server-core/src/auth.ts';
import { writeAudit } from '../../../packages/server-core/src/audit.ts';

const USER_ADMIN_ROLES = ['principal', 'school_owner', 'it_admin'];
/** Reading the staff list is wider — a coordinator builds timetables from it. */
const USER_READ_ROLES = [...USER_ADMIN_ROLES, 'academic_coordinator'];

/**
 * Roles an IT admin may hand out. Deliberately excludes super_admin (platform,
 * not tenant) and school_owner: the person who owns the institution is not
 * created from inside its own admin screen.
 */
const GRANTABLE = new Set([
  'principal', 'academic_coordinator', 'dept_head', 'accountant',
  'class_teacher', 'subject_teacher', 'librarian', 'it_admin',
]);

const SEARCH_LIMIT = 50;

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const cors = corsHeaders([], 'GET, POST, PATCH, OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }

  try {
    const claims = await authenticate(req);
    const db = await sharedDb();
    const ctx = { tenantId: claims.tid, userId: claims.sub, role: claims.role };

    if (req.method === 'GET')   { requireRole(claims, USER_READ_ROLES);  json(res, 200, await search(db, ctx, req), cors); return; }
    if (req.method === 'POST')  { requireRole(claims, USER_ADMIN_ROLES); json(res, 200, await create(db, ctx, req), cors); return; }
    if (req.method === 'PATCH') { requireRole(claims, USER_ADMIN_ROLES); json(res, 200, await setStatus(db, ctx, req), cors); return; }

    json(res, 405, { error: 'method_not_allowed' }, cors);
  } catch (err) {
    if (err instanceof HttpError) {
      json(res, err.status, { error: err.code, message: err.message, ...(err.detail ?? {}) }, cors);
      return;
    }
    json(res, 500, { error: 'internal_error' }, cors);
  }
}

type Db = Awaited<ReturnType<typeof sharedDb>>;
type Ctx = { tenantId: string; userId: string; role: string };

async function search(db: Db, ctx: Ctx, req: IncomingMessage) {
  const q = query(req);
  const term = (q.get('q') ?? '').trim();
  const role = (q.get('role') ?? '').trim();
  const status = (q.get('status') ?? '').trim();

  return db.withTenant(ctx, async (c) => {
    const { rows } = await c.query<{
      id: string; name_bn: string; name_en: string | null; phone: string | null;
      status: string; roles: string[]; employee_code: string | null;
      student_code: string | null; created_at: string;
    }>(
      `SELECT u.id, u.full_name_bn AS name_bn, u.full_name_en AS name_en,
              u.phone_e164 AS phone, u.status::text AS status,
              COALESCE(array_agg(DISTINCT ur.role_code)
                       FILTER (WHERE ur.role_code IS NOT NULL), '{}') AS roles,
              sp.employee_code, stp.student_code,
              u.created_at::text AS created_at
         FROM users u
         LEFT JOIN user_roles ur      ON ur.user_id = u.id
         LEFT JOIN staff_profiles sp  ON sp.user_id = u.id
         LEFT JOIN student_profiles stp ON stp.user_id = u.id
        WHERE u.deleted_at IS NULL
          -- Name is a prefix/substring search; phone is exact. See the header:
          -- a partial-phone search is a contact-list enumerator.
          AND ($1 = '' OR u.full_name_bn ILIKE '%' || $1 || '%'
                       OR u.full_name_en ILIKE '%' || $1 || '%'
                       OR u.phone_e164 = $1
                       OR sp.employee_code = $1
                       OR stp.student_code = $1)
          AND ($3 = '' OR u.status::text = $3)
        GROUP BY u.id, u.full_name_bn, u.full_name_en, u.phone_e164, u.status,
                 sp.employee_code, stp.student_code, u.created_at
        HAVING ($2 = '' OR $2 = ANY(array_agg(ur.role_code)))
        ORDER BY u.full_name_bn
        LIMIT $4`,
      [term, role, status, SEARCH_LIMIT],
    );

    return {
      users: rows.map((r) => ({
        id: r.id,
        nameBn: r.name_bn,
        nameEn: r.name_en,
        phone: r.phone,
        status: r.status,
        roles: r.roles,
        employeeCode: r.employee_code,
        studentCode: r.student_code,
        createdAt: r.created_at,
      })),
      // The screen must be able to say "showing the first 50 of more" rather
      // than implying the search found everything.
      truncated: rows.length === SEARCH_LIMIT,
      limit: SEARCH_LIMIT,
    };
  });
}

/** E.164 for Bangladesh, the same shape the import wizard accepts. */
function normalisePhone(raw: string): string {
  const digits = raw.replace(/[^\d+]/g, '');
  if (/^\+8801[3-9]\d{8}$/.test(digits)) return digits;
  if (/^8801[3-9]\d{8}$/.test(digits)) return `+${digits}`;
  if (/^01[3-9]\d{8}$/.test(digits)) return `+88${digits}`;
  throw new HttpError(400, 'মোবাইল নম্বরটি ঠিক নয়', 'bad_phone', { field: 'phone' });
}

async function create(db: Db, ctx: Ctx, req: IncomingMessage) {
  const body = await readJson<{
    nameBn?: string; nameEn?: string; phone?: string;
    roleCode?: string; employeeCode?: string; designationBn?: string;
  }>(req);

  const nameBn = (body.nameBn ?? '').trim();
  const roleCode = (body.roleCode ?? '').trim();
  if (!nameBn) throw new HttpError(400, 'নাম লিখুন', 'bad_request', { field: 'nameBn' });
  if (!GRANTABLE.has(roleCode)) {
    throw new HttpError(400, 'এই ভূমিকা দেওয়া যাবে না', 'bad_role', { field: 'roleCode' });
  }
  const phone = normalisePhone(body.phone ?? '');

  return db.withTenant(ctx, async (c) => {
    const { rows: dupe } = await c.query<{ id: string; name_bn: string }>(
      `SELECT id, full_name_bn AS name_bn FROM users
        WHERE phone_e164 = $1 AND deleted_at IS NULL`,
      [phone],
    );
    if (dupe.length > 0) {
      // Naming the existing holder is deliberate: within one school this is
      // not a leak, and "already in use" with no name sends the office
      // hunting. It is the same institution's own staff list.
      throw new HttpError(409,
        `এই নম্বরটি ইতিমধ্যে ${dupe[0].name_bn}-এর জন্য ব্যবহৃত`,
        'phone_taken', { field: 'phone', existingId: dupe[0].id });
    }

    // `users.full_name_en` is NOT NULL. Found by running this INSERT against
    // the real schema: the endpoint typechecked, and would have failed on the
    // first teacher an office added without an English name — which in a
    // Bangla-medium school is most of them.
    //
    // Falling back to the Bangla name rather than demanding an English one:
    // the office has the name it has, and refusing the form until somebody
    // transliterates it is a worse product than a row where both columns hold
    // the same string. The school can fill it in later.
    const nameEn = (body.nameEn ?? '').trim() || nameBn;
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO users (tenant_id, full_name_bn, full_name_en, phone_e164, status)
       VALUES ($1, $2, $3, $4, 'invited')
       RETURNING id`,
      [ctx.tenantId, nameBn, nameEn, phone],
    );
    const userId = rows[0].id;

    await c.query(
      `INSERT INTO user_roles (tenant_id, user_id, role_code) VALUES ($1, $2, $3)`,
      [ctx.tenantId, userId, roleCode],
    );

    // Staff get a staff profile; the employee code is what a school's own
    // paperwork uses and the assignment screens display.
    await c.query(
      `INSERT INTO staff_profiles (user_id, tenant_id, employee_code, designation_bn)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id) DO NOTHING`,
      [userId, ctx.tenantId, (body.employeeCode ?? '').trim() || null,
       (body.designationBn ?? '').trim() || null],
    );

    await writeAudit(c, ctx, {
      action: 'ops.user.create',
      entityType: 'user',
      entityId: userId,
      after: { nameBn, roleCode },
    });

    // 'invited', not 'active': the account exists and cannot yet be used.
    // First login goes through F-202's activation code, which is a separate,
    // audited act — see the header.
    return { id: userId, nameBn, roleCode, status: 'invited' };
  });
}

async function setStatus(db: Db, ctx: Ctx, req: IncomingMessage) {
  const body = await readJson<{ userId?: string; active?: boolean }>(req);
  const userId = (body.userId ?? '').trim();
  if (!userId) throw new HttpError(400, 'userId is required', 'bad_request', { field: 'userId' });
  if (typeof body.active !== 'boolean') {
    throw new HttpError(400, 'active must be true or false', 'bad_request', { field: 'active' });
  }
  if (userId === ctx.userId && body.active === false) {
    // Not paternalism: an IT admin who locks themselves out of a single-admin
    // school has no second path back in, because there is no platform console
    // yet (R-7).
    throw new HttpError(400, 'নিজের অ্যাকাউন্ট নিষ্ক্রিয় করা যাবে না', 'cannot_deactivate_self');
  }

  return db.withTenant(ctx, async (c) => {
    const { rows: before } = await c.query<{ status: string; name_bn: string }>(
      `SELECT status::text AS status, full_name_bn AS name_bn FROM users WHERE id = $1`,
      [userId],
    );
    if (before.length === 0) throw new HttpError(404, 'ব্যবহারকারী পাওয়া যায়নি', 'not_found');

    // 'left', not 'deleted': the person's history stays attributable. See
    // the header — nothing here removes a row.
    const next = body.active ? 'active' : 'left';
    const { rows } = await c.query<{ status: string }>(
      `UPDATE users SET status = $1::user_status, row_version = row_version + 1
        WHERE id = $2 RETURNING status::text AS status`,
      [next, userId],
    );
    if (rows.length === 0) throw new HttpError(403, 'পরিবর্তনের অনুমতি নেই', 'forbidden');

    await writeAudit(c, ctx, {
      action: body.active ? 'ops.user.reactivate' : 'ops.user.deactivate',
      entityType: 'user',
      entityId: userId,
      before: { status: before[0].status },
      after: { status: rows[0].status },
    });

    return { id: userId, nameBn: before[0].name_bn, status: rows[0].status };
  });
}
