/**
 * platform-svc — the shikhonBD operator's surface.  (R-7)
 *
 *   GET  /api/v1/platform/tenants?q=      → the institution list
 *   POST /api/v1/platform/tenants         → create one
 *   GET  /api/v1/platform/tenant?id=      → one institution + derived state
 *   POST /api/v1/platform/provision       → app.provision_tenant + sections
 *   POST /api/v1/platform/branding        → the R-1 branding object
 *   POST /api/v1/platform/admin           → first principal / IT admin + code
 *   POST /api/v1/platform/import          → teacher or student CSV
 *   POST /api/v1/platform/status          → activate · suspend · restore
 *   GET  /api/v1/platform/audit?tenantId= → the platform audit trail
 *   GET  /api/v1/platform/readiness      → R-8 go-live posture
 *
 * This is NOT a tenant application. It is the one service that can see more
 * than one school, and everything about it is arranged so that a school
 * cannot become it.
 *
 * ── Three separate credentials, and none of them is a school's ──────────
 *
 *   1. A platform JWT whose role is `super_admin`. Tenant roles — principal,
 *      school_owner, it_admin — are rejected here even though they are the
 *      most powerful roles a school has, because a school compromised end to
 *      end must not be able to reach another school.
 *
 *   2. `PLATFORM_API_KEY`, a second factor from the environment, on every
 *      call. Creating a tenant is the highest-blast-radius operation in the
 *      product and a leaked session token should not be enough to do it.
 *      The key never reaches the browser: the console sends it because the
 *      operator pastes it into the console's own session, and it is checked
 *      here with a timing-safe compare.
 *
 *   3. `PLATFORM_DATABASE_URL`, a DIFFERENT database role from the one every
 *      school's requests run under. `shikhon_app` is confined by
 *      `tenant_self` and is not granted EXECUTE on `app.create_tenant`, so
 *      even with both credentials above, the runtime connection could not
 *      create a school. If this variable is unset the service answers 503
 *      rather than falling back — a fallback to the runtime role is how a
 *      platform endpoint quietly becomes a tenant endpoint.
 *
 * ── Why the platform role is NOT a BYPASSRLS role ───────────────────────
 * Migration 045 turns BYPASSRLS off. The three cross-tenant functions are
 * SECURITY DEFINER and work regardless; everything else this service does is
 * work inside ONE school, and for that it sets `app.tenant_id` and runs under
 * the same policies as everybody else. So a bug in the wizard cannot write
 * into the wrong school — RLS is still standing between it and the rows.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';

import { createDb, assertRlsEnforced, type Db } from '../../../packages/server-core/src/db.ts';
import { corsHeaders, query, readJson, json, HttpError } from '../../../packages/server-core/src/http.ts';
import { authenticate } from '../../../packages/server-core/src/auth.ts';
import { enforceRateLimit } from '../../../packages/server-core/src/rate-limit.ts';
import { parseBranding } from '../../../packages/ui-core/src/branding.ts';
import {
  runStudentImport, runTeacherImport, ImportError,
} from '../../academics-svc/src/import-run.ts';
import {
  generateCode, codeHash, activationConfigured,
} from '../../identity-svc/src/activation.ts';
import { goLiveChecks } from '../../../packages/server-core/src/go-live.ts';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SLUG_RE = /^[a-z0-9][a-z0-9-]{2,62}$/;
const PHONE_RE = /^\+8801[3-9]\d{8}$/;

const STREAMS = ['bangla_medium', 'english_version', 'english_medium', 'madrasah', 'technical'];
const LEVELS = ['primary', 'junior_secondary', 'secondary', 'higher_secondary', 'combined'];
const SHIFTS = ['morning', 'day', 'evening', 'single'];
const STATUSES = ['trial', 'active', 'suspended', 'archived'];
/** The roles the wizard may create for a school. Never a platform role. */
const ADMIN_ROLES = ['principal', 'school_owner', 'it_admin'];

let _db: Db | null = null;

/**
 * The platform connection, or none at all.
 *
 * No fallback to DATABASE_URL. A platform service that silently runs on the
 * tenant runtime role would fail every operation with a permission error at
 * best, and at worst would look like it worked while doing something else.
 */
async function platformDb(): Promise<Db> {
  if (_db) return _db;
  const url = process.env.PLATFORM_DATABASE_URL;
  if (!url) {
    throw new HttpError(503,
      'platform console is not configured on this deployment (PLATFORM_DATABASE_URL)',
      'platform_not_configured');
  }
  const db = createDb(url, { max: 3 });
  // The same boot guard the tenant services use. Migration 045 removed
  // BYPASSRLS from the platform role precisely so this still holds here.
  await assertRlsEnforced(db);
  _db = db;
  return db;
}

/** Constant-time, and length-safe: a plain `!==` leaks the key one byte at a time. */
function keyMatches(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

interface Operator { id: string; role: string }

async function authorize(req: IncomingMessage): Promise<Operator> {
  const expected = process.env.PLATFORM_API_KEY;
  if (!expected) {
    throw new HttpError(503,
      'platform console is not configured on this deployment (PLATFORM_API_KEY)',
      'platform_not_configured');
  }
  const given = String(req.headers['x-platform-key'] ?? '');
  if (!given || !keyMatches(given, expected)) {
    // Deliberately the same answer as a bad token: an attacker with a valid
    // JWT and no key learns nothing about which of the two was wrong.
    throw new HttpError(403, 'platform credentials required', 'forbidden');
  }
  const claims = await authenticate(req);
  if (claims.role !== 'super_admin') {
    throw new HttpError(403, 'platform credentials required', 'forbidden');
  }
  return { id: claims.sub, role: claims.role };
}

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const cors = corsHeaders([], 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }

  const action = new URL(req.url ?? '/', 'http://internal').pathname
    .split('/').filter(Boolean).pop() ?? '';

  try {
    if (req.method !== 'OPTIONS') {
      // The console is a handful of operators, not a school. The `service`
      // bucket is the right size and keeps a scripted loop from walking the
      // tenant list.
      if (!(await enforceRateLimit(req, res, cors, 'mutation'))) return;
    }
    const op = await authorize(req);
    const db = await platformDb();

    switch (`${req.method} ${action}`) {
      case 'GET tenants':   return json(res, 200, await listTenants(db, req), cors);
      case 'POST tenants':  return json(res, 200, await createTenant(db, op, req), cors);
      case 'GET tenant':    return json(res, 200, await getTenant(db, req), cors);
      case 'POST provision':return json(res, 200, await provision(db, op, req), cors);
      case 'POST branding': return json(res, 200, await setBranding(db, op, req), cors);
      case 'POST admin':    return json(res, 200, await createAdmin(db, op, req), cors);
      case 'POST import':   return json(res, 200, await runImport(db, op, req), cors);
      case 'POST plan':     return json(res, 200, await setPlan(db, op, req), cors);
      case 'POST status':   return json(res, 200, await setStatus(db, op, req), cors);
      case 'GET audit':     return json(res, 200, await readAudit(db, req), cors);
      // R-8. Deliberately does NOT touch the database: it reports what this
      // deployment is configured to do, which is a property of the process,
      // not of any school.
      case 'GET readiness': return json(res, 200, readiness(), cors);
      default:
        return json(res, 404, { error: 'not_found' }, cors);
    }
  } catch (err) {
    if (err instanceof ImportError) {
      return json(res, err.status, { error: err.code, message: err.message }, cors);
    }
    if (err instanceof HttpError) {
      return json(res, err.status, { error: err.code ?? 'error', message: err.message, ...(err.detail ?? {}) }, cors);
    }
    const msg = err instanceof Error ? err.message : '';
    // Constraint violations are the operator's problem to solve, so their
    // MEANING is surfaced — but never the driver's text, which quotes the
    // offending row and a row can carry a person's details.
    if (/tenants_slug_key|duplicate key.*slug/i.test(msg)) {
      return json(res, 409, { error: 'slug_taken', message: 'এই স্লাগ আগে থেকেই ব্যবহৃত' }, cors);
    }
    if (/eiin/i.test(msg) && /duplicate|unique/i.test(msg)) {
      // Named as "already registered" without naming the other school —
      // that would leak one customer to another (R-7.15, screen 1).
      return json(res, 409, { error: 'eiin_taken', message: 'এই EIIN আগে থেকেই নিবন্ধিত' }, cors);
    }
    if (/student cap reached/i.test(msg)) {
      return json(res, 409, { error: 'cap_exceeded', message: msg }, cors);
    }
    return json(res, 500, { error: 'platform_error' }, cors);
  }
}

// ── The list and one institution ────────────────────────────────────────

async function listTenants(db: Db, req: IncomingMessage) {
  const q = (query(req).get('q') ?? '').trim();
  const { rows } = await db.pool.query(
    `SELECT * FROM app.platform_tenants($1)`, [q || null]);
  return {
    tenants: rows.map((r: Record<string, unknown>) => ({
      id: r.id, slug: String(r.slug), nameBn: r.name_bn, nameEn: r.name_en,
      stream: r.stream, level: r.level, status: r.status,
      planCode: r.plan_code, studentCap: r.student_cap,
      studentCount: Number(r.student_count),
      trialEndsOn: r.trial_ends_on, createdAt: r.created_at,
    })),
  };
}

async function getTenant(db: Db, req: IncomingMessage) {
  const id = (query(req).get('id') ?? '').trim();
  if (!UUID_RE.test(id)) throw new HttpError(400, 'id must be a uuid', 'invalid_id');

  const { rows } = await db.pool.query(
    `SELECT * FROM app.platform_tenants(NULL) WHERE id = $1`, [id]);
  if (rows.length === 0) throw new HttpError(404, 'no such institution', 'not_found');

  const state = await db.pool.query(`SELECT * FROM app.tenant_onboarding_state($1)`, [id]);
  const s = state.rows[0] as Record<string, string | boolean>;

  // Inside the tenant's own context, not on the bare pool.
  //
  // `app.platform_tenants` and `app.tenant_onboarding_state` are SECURITY
  // DEFINER and run as the owner, so a bare `db.pool.query` serves them. This
  // one reads `tenants` directly, and `tenant_self` is `id =
  // app.current_tenant()` — with no context set, the row is invisible and the
  // query returns NOTHING. It did not error; it returned an empty branding
  // object, so a school that HAD been branded looked unbranded in the
  // console. Found by reading the payload after the branding step.
  const brand = await db.withTenant(
    { tenantId: id, userId: id, role: 'principal' },
    (c) => c.query<{ branding: unknown; weekend: number[]; shifts: string[] }>(
      `SELECT COALESCE(settings->'branding','{}'::jsonb) AS branding,
              weekend_days AS weekend, shifts::text[] AS shifts
         FROM tenants WHERE id = app.current_tenant()`),
  );

  const r = rows[0] as Record<string, unknown>;
  return {
    tenant: {
      id: r.id, slug: String(r.slug), nameBn: r.name_bn, nameEn: r.name_en,
      stream: r.stream, level: r.level, status: r.status,
      planCode: r.plan_code, studentCap: r.student_cap,
      studentCount: Number(r.student_count),
      trialEndsOn: r.trial_ends_on, createdAt: r.created_at,
      weekendDays: brand.rows[0]?.weekend ?? [], shifts: brand.rows[0]?.shifts ?? [],
      branding: brand.rows[0]?.branding ?? {},
    },
    // Derived from real rows, so it reports what actually landed rather than
    // what a stage column believed. §23.
    state: {
      years: Number(s.years), gradingBands: Number(s.grading_bands),
      classes: Number(s.classes), sections: Number(s.sections),
      subjects: Number(s.subjects), feeHeads: Number(s.fee_heads),
      teachers: Number(s.teachers), students: Number(s.students),
      guardians: Number(s.guardians), admins: Number(s.admins),
      hasBranding: Boolean(s.has_branding),
    },
    // The two gates, computed in one place so the console and the activate
    // endpoint cannot disagree about whether a school is ready.
    canActivate: Number(s.years) > 0 && Number(s.grading_bands) > 0 && Number(s.admins) > 0,
  };
}

// ── Creation ────────────────────────────────────────────────────────────

interface CreateBody {
  slug?: string; nameBn?: string; nameEn?: string;
  stream?: string; level?: string;
  eiin?: string; mpoCode?: string; boardCode?: string;
  district?: string; upazila?: string; addressBn?: string;
  weekendDays?: number[]; shifts?: string[];
  timezone?: string; locale?: string;
  planCode?: string; studentCap?: number; trialEndsOn?: string;
}

async function createTenant(db: Db, op: Operator, req: IncomingMessage) {
  const b = await readJson<CreateBody>(req);

  const nameBn = (b.nameBn ?? '').trim();
  const nameEn = (b.nameEn ?? '').trim();
  const slug = (b.slug ?? '').trim().toLowerCase();
  if (!nameBn || nameBn.length > 120) throw new HttpError(400, 'বাংলা নাম দিন', 'invalid_name_bn', { field: 'nameBn' });
  if (!nameEn || nameEn.length > 120) throw new HttpError(400, 'ইংরেজি নাম দিন', 'invalid_name_en', { field: 'nameEn' });
  if (!SLUG_RE.test(slug)) {
    throw new HttpError(400,
      'স্লাগ ছোট হাতের অক্ষর, সংখ্যা ও হাইফেন — ৩ থেকে ৬৩ অক্ষর',
      'invalid_slug', { field: 'slug' });
  }
  if (!STREAMS.includes(b.stream ?? '')) throw new HttpError(400, 'প্রতিষ্ঠানের ধরন বেছে নিন', 'invalid_stream', { field: 'stream' });
  if (!LEVELS.includes(b.level ?? '')) throw new HttpError(400, 'স্তর বেছে নিন', 'invalid_level', { field: 'level' });

  const eiin = (b.eiin ?? '').trim();
  if (eiin && !/^\d{6,8}$/.test(eiin)) {
    throw new HttpError(400, 'EIIN ৬–৮ সংখ্যার হতে হবে', 'invalid_eiin', { field: 'eiin' });
  }

  const weekend = Array.isArray(b.weekendDays) && b.weekendDays.length > 0
    ? b.weekendDays.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6)
    : [5, 6];
  if (weekend.length === 0) throw new HttpError(400, 'সাপ্তাহিক ছুটি বেছে নিন', 'invalid_weekend', { field: 'weekendDays' });

  const shifts = Array.isArray(b.shifts) && b.shifts.length > 0
    ? b.shifts.filter((s) => SHIFTS.includes(s))
    : ['single'];
  if (shifts.length === 0) throw new HttpError(400, 'অন্তত একটি শিফট', 'invalid_shifts', { field: 'shifts' });

  const cap = Number(b.studentCap ?? 500);
  if (!Number.isInteger(cap) || cap <= 0) {
    throw new HttpError(400, 'শিক্ষার্থীর সীমা শূন্যের বেশি হতে হবে', 'invalid_cap', { field: 'studentCap' });
  }

  const { rows } = await db.pool.query<{ id: string; slug: string; status: string }>(
    `SELECT * FROM app.create_tenant(
       $1,$2,$3,$4,$5::institution_stream,$6::institution_level,
       $7,$8,$9,$10,$11,$12,
       $13::smallint[],$14::shift_code[],$15,$16,$17,$18,$19,$20::tenant_status,$21)`,
    [op.id, slug, nameBn, nameEn, b.stream, b.level,
     eiin || null, b.mpoCode ?? null, b.boardCode ?? null,
     b.district ?? null, b.upazila ?? null, b.addressBn ?? null,
     weekend, shifts, b.timezone ?? 'Asia/Dhaka', b.locale ?? 'bn',
     b.planCode ?? 'pilot', cap, b.trialEndsOn || null, 'trial',
     'R-7 onboarding wizard'],
  );
  return { tenant: { id: rows[0].id, slug: String(rows[0].slug), status: rows[0].status } };
}

// ── Provisioning ────────────────────────────────────────────────────────

interface ProvisionBody {
  tenantId?: string; yearLabel?: string; startsOn?: string; endsOn?: string;
  minLevel?: number; maxLevel?: number; sectionsPerClass?: number;
}

/**
 * The academic spine, via the function that already builds it.
 *
 * `app.provision_tenant` raises 42501 unless it runs inside the tenant's own
 * context, which is the guard that stops a mis-scoped session provisioning
 * the wrong school — so this runs it through `withTenant`, exactly as a
 * school's own session would. None of its logic is reimplemented here; the
 * wizard collects validated inputs and calls it.
 *
 * It is idempotent (ON CONFLICT DO NOTHING throughout), so a retry after a
 * failure is always safe. §22 asks for that and the function already had it.
 */
async function provision(db: Db, op: Operator, req: IncomingMessage) {
  const b = await readJson<ProvisionBody>(req);
  const tenantId = (b.tenantId ?? '').trim();
  if (!UUID_RE.test(tenantId)) throw new HttpError(400, 'tenantId must be a uuid', 'invalid_id');

  const minLevel = Number(b.minLevel ?? 1);
  const maxLevel = Number(b.maxLevel ?? 10);
  if (!Number.isInteger(minLevel) || !Number.isInteger(maxLevel)
      || minLevel < 1 || maxLevel > 12 || minLevel > maxLevel) {
    throw new HttpError(400, 'শ্রেণির পরিসর ১–১২ এবং ক্রমানুসারে হতে হবে', 'invalid_range', { field: 'minLevel' });
  }
  const perClass = Math.min(Math.max(Number(b.sectionsPerClass ?? 1), 0), 10);
  const label = (b.yearLabel ?? String(new Date().getUTCFullYear())).trim();
  const startsOn = b.startsOn || `${label}-01-01`;
  const endsOn = b.endsOn || `${label}-12-31`;
  if (endsOn <= startsOn) {
    throw new HttpError(400, 'শিক্ষাবর্ষের শেষ তারিখ শুরুর পরে হতে হবে', 'invalid_dates', { field: 'endsOn' });
  }

  // `principal` rather than `super_admin`: inside a school the operator acts
  // with a school's authority, and the RLS policies are written in terms of
  // school roles. A platform role has no meaning to `sections_insert_scope`.
  const ctx = { tenantId, userId: op.id, role: 'principal' };

  return db.withTenant(ctx, async (c) => {
    const { rows } = await c.query<{ provision_tenant: string }>(
      `SELECT app.provision_tenant($1, $2, $3::date, $4::date, $5::smallint, $6::smallint)`,
      [tenantId, label, startsOn, endsOn, minLevel, maxLevel],
    );
    // The function returns a table of (object, count) rows as composite
    // text; showing it verbatim is how the operator knows the grading scale
    // exists (R-7.15, screen 5).
    const seeded = rows.map((r) => String(r.provision_tenant));

    // The step provision_tenant does not do. Without subject templates,
    // app.derive_student_subjects raises and the student import rejects every
    // row with 'বিষয় তালিকা (টেমপ্লেট) তৈরি হয়নি' — a freshly provisioned
    // school that cannot accept a single student. See migration 045 §5b.
    const curriculum = await c.query<{ object: string; seeded: number }>(
      `SELECT * FROM app.provision_curriculum($1, NULL)`, [tenantId]);
    for (const r of curriculum.rows) seeded.push(`(${r.object},${r.seeded})`);

    let sectionsMade = 0;
    if (perClass > 0) {
      const names = ['ক', 'খ', 'গ', 'ঘ', 'ঙ', 'চ', 'ছ', 'জ', 'ঝ', 'ঞ'].slice(0, perClass);
      const made = await c.query<{ id: string }>(
        `INSERT INTO sections (tenant_id, class_id, academic_year_id, name, shift)
         SELECT app.current_tenant(), cl.id, ay.id, n, (SELECT (t.shifts)[1] FROM tenants t)
           FROM classes cl
           CROSS JOIN unnest($1::text[]) AS n
           JOIN academic_years ay ON ay.tenant_id = cl.tenant_id AND ay.is_current
          WHERE cl.tenant_id = app.current_tenant()
         ON CONFLICT DO NOTHING
         RETURNING id`,
        [names],
      );
      sectionsMade = made.rows.length;
    }

    await c.query(
      `SELECT app.log_platform_action($1, $2, 'R-7 provisioning', $3)`,
      [op.id, tenantId, `provision_tenant ${label} ${minLevel}-${maxLevel}, ${sectionsMade} sections`],
    );

    const state = await c.query(`SELECT * FROM app.tenant_onboarding_state($1)`, [tenantId]);
    return { seeded, sectionsMade, state: state.rows[0] };
  });
}

// ── Branding, admins, imports, status ───────────────────────────────────

async function setBranding(db: Db, op: Operator, req: IncomingMessage) {
  const b = await readJson<{ tenantId?: string; branding?: Record<string, unknown> }>(req);
  const tenantId = (b.tenantId ?? '').trim();
  if (!UUID_RE.test(tenantId)) throw new HttpError(400, 'tenantId must be a uuid', 'invalid_id');

  // R-1's parser is the VALIDATOR — hex colours only, raster assets only,
  // per-field byte caps. Re-implementing it here would let the console accept
  // something the school's own editor would reject.
  //
  // It is not the serialiser, though, and that distinction cost a round of
  // acceptance: `parseBranding` fills a DEFAULT for every field it is not
  // given, so saving `{nameBn, primaryColor}` came back carrying
  // `nameEn: "Institution"` — and would have written that placeholder over
  // every school's real English name. Only the keys the operator actually
  // supplied are persisted; the rest stay absent, which is what lets
  // migration 039's seed keep showing the school's own name.
  const supplied = b.branding ?? {};
  const parsed = parseBranding(supplied) as unknown as Record<string, unknown>;
  const clean: Record<string, string> = {};
  for (const key of Object.keys(supplied)) {
    const v = parsed[key];
    if (typeof v === 'string' && v !== '') clean[key] = v;
  }

  const ctx = { tenantId, userId: op.id, role: 'principal' };
  return db.withTenant(ctx, async (c) => {
    await c.query(
      `UPDATE tenants SET settings = jsonb_set(COALESCE(settings,'{}'::jsonb),
                                               '{branding}', $1::jsonb, true),
                          updated_at = now()
        WHERE id = app.current_tenant()`,
      [JSON.stringify(clean)],
    );
    await c.query(
      `SELECT app.log_platform_action($1, $2, 'R-7 branding', 'set branding')`,
      [op.id, tenantId]);
    return { branding: clean };
  });
}

interface AdminBody {
  tenantId?: string; nameBn?: string; nameEn?: string;
  phone?: string; email?: string; roleCode?: string;
}

/**
 * The first account, and the one everything else in the school is created by.
 *
 * Login on day one is by activation code, not OTP: onboarding must not depend
 * on the SMS aggregator contract (R-8). The code is returned ONCE and is
 * never stored — `activation_codes` holds an HMAC under ACTIVATION_PEPPER —
 * so an operator who loses it issues another rather than looking it up.
 */
async function createAdmin(db: Db, op: Operator, req: IncomingMessage) {
  const b = await readJson<AdminBody>(req);
  const tenantId = (b.tenantId ?? '').trim();
  if (!UUID_RE.test(tenantId)) throw new HttpError(400, 'tenantId must be a uuid', 'invalid_id');

  const nameBn = (b.nameBn ?? '').trim();
  if (!nameBn) throw new HttpError(400, 'নাম দিন', 'invalid_name', { field: 'nameBn' });
  const phone = (b.phone ?? '').trim();
  if (!PHONE_RE.test(phone)) {
    throw new HttpError(400, 'মোবাইল নম্বর +৮৮০১… ফরম্যাটে দিন', 'invalid_phone', { field: 'phone' });
  }
  const roleCode = b.roleCode ?? 'principal';
  if (!ADMIN_ROLES.includes(roleCode)) {
    throw new HttpError(400, 'ভূমিকা প্রধান শিক্ষক, পরিচালক বা আইটি অ্যাডমিন হতে পারে',
      'invalid_role', { field: 'roleCode' });
  }

  const ctx = { tenantId, userId: op.id, role: 'principal' };
  return db.withTenant(ctx, async (c) => {
    // The same phone may legitimately exist in ANOTHER school, so this is
    // scoped to the tenant by RLS. Within one school it is the same person,
    // and the honest answer is to grant them the role rather than create a
    // second account for one human (R-7.15, screen 6).
    const existing = await c.query<{ id: string }>(
      `SELECT id FROM users WHERE phone_e164 = $1 AND deleted_at IS NULL`, [phone]);

    let userId: string;
    let reused = false;
    if (existing.rows[0]) {
      userId = existing.rows[0].id;
      reused = true;
    } else {
      const u = await c.query<{ id: string }>(
        `INSERT INTO users (tenant_id, full_name_bn, full_name_en, phone_e164, status)
         VALUES (app.current_tenant(), $1, $2, $3, 'invited') RETURNING id`,
        [nameBn, (b.nameEn ?? '').trim() || nameBn, phone],
      );
      userId = u.rows[0].id;
    }

    await c.query(
      `INSERT INTO user_roles (tenant_id, user_id, role_code, scope_type)
       VALUES (app.current_tenant(), $1, $2, 'tenant') ON CONFLICT DO NOTHING`,
      [userId, roleCode]);

    // Same generator and same HMAC as identity-svc's own issuer — see
    // services/identity-svc/src/activation.ts. A second alphabet here would
    // mint codes the redeemer's normaliser mangles, and the head teacher
    // holding the printed slip would just be told it does not work.
    if (!activationConfigured()) {
      throw new HttpError(503,
        'activation codes are not configured on this deployment (ACTIVATION_PEPPER)',
        'activation_not_configured');
    }
    const code = generateCode();
    // `issued_by` FKs to `users` — a person INSIDE this school. For the first
    // account there is nobody inside the school yet: the platform issued it,
    // and the platform operator has no row in this tenant. Writing `op.id`
    // violates the constraint, which is how this was found.
    //
    // The account is recorded as its own issuer, and the truthful record of
    // who really did it is the `audit.platform_access` row written below with
    // the operator's real id. That is the right division: the FK column
    // answers "which member of this school", and for a school's first
    // account the honest answer is nobody — so it points at the account
    // itself rather than at a fiction.
    await c.query(
      `INSERT INTO activation_codes (tenant_id, user_id, code_hash, issued_by)
       VALUES (app.current_tenant(), $1, $2, $1)`,
      [userId, codeHash(code)]);

    await c.query(
      `SELECT app.log_platform_action($1, $2, 'R-7 first admin', $3)`,
      [op.id, tenantId, `${reused ? 'granted' : 'created'} ${roleCode}`]);

    return { userId, roleCode, reused, activationCode: code };
  });
}

async function runImport(db: Db, op: Operator, req: IncomingMessage) {
  const b = await readJson<{
    tenantId?: string; kind?: string; csv?: string; academicYearId?: string;
    commit?: boolean; digest?: string; fileName?: string;
  }>(req);
  const tenantId = (b.tenantId ?? '').trim();
  if (!UUID_RE.test(tenantId)) throw new HttpError(400, 'tenantId must be a uuid', 'invalid_id');
  if (b.kind !== 'student' && b.kind !== 'teacher') {
    throw new HttpError(400, "kind must be 'student' or 'teacher'", 'unsupported_kind');
  }

  const ctx = { tenantId, userId: op.id, role: 'principal' };
  return db.withTenant(ctx, async (c) => {
    // `import_batches.started_by` FKs to `users` — a person inside THIS
    // school. The platform operator has no row there, so passing their id
    // violates the constraint; found by running the wizard's teacher step.
    //
    // The batch is attributed to the school's own principal, which the wizard
    // has already created two screens earlier, and to nobody at all if it
    // somehow has not. The record of which OPERATOR ran it is the
    // `audit.platform_access` row — the same division as the activation code
    // above: the tenant-scoped column names a member of the school, the
    // platform audit names us.
    const owner = await c.query<{ id: string }>(
      `SELECT ur.user_id AS id FROM user_roles ur
        WHERE ur.role_code IN ('principal','school_owner','it_admin')
        ORDER BY ur.created_at LIMIT 1`);
    const startedBy = owner.rows[0]?.id ?? null;

    if (b.kind === 'teacher') {
      return runTeacherImport(c, {
        csv: b.csv ?? '', tenantId, userId: startedBy,
        commit: b.commit, digest: b.digest, fileName: b.fileName ?? null,
      });
    }
    // The wizard pre-fills the current year; falling back to it here means a
    // console that forgot the field still imports into the right year rather
    // than 400-ing after the operator has uploaded an 800-row file.
    let yearId = (b.academicYearId ?? '').trim();
    if (!UUID_RE.test(yearId)) {
      const y = await c.query<{ id: string }>(
        `SELECT id FROM academic_years WHERE is_current LIMIT 1`);
      if (!y.rows[0]) {
        throw new HttpError(409,
          'এই প্রতিষ্ঠানে শিক্ষাবর্ষ নেই — আগে একাডেমিক ধাপ সম্পন্ন করুন', 'no_academic_year');
      }
      yearId = y.rows[0].id;
    }
    return runStudentImport(c, {
      csv: b.csv ?? '', academicYearId: yearId, tenantId, userId: startedBy,
      commit: b.commit, digest: b.digest, fileName: b.fileName ?? null,
    });
  });
}

/**
 * Activate, suspend, restore. Never delete.
 *
 * Activation is gated on the two things that break silently later — no
 * academic year, and no grading bands — plus an account that can run the
 * school. Everything else (no logo, no students yet) is the operator's
 * business, not a gate.
 */
/**
 * POST plan — change a school's plan, student cap or trial end.  (R-7 completion)
 *
 * These three columns were writable exactly once, at creation, and never
 * again. A school that outgrew its cap therefore needed SQL against
 * production — the one thing this console exists to remove — and the cap
 * refusal an operator sees on an over-cap import ("capped at 500 and this
 * would make 512") named a limit nothing in the UI could raise.
 *
 * No migration: the platform role is a member of `shikhon_app` and writes
 * inside the target tenant's own context, exactly as `setBranding` does. There
 * is no cross-tenant statement here to need a DEFINER function for.
 */
async function setPlan(db: Db, op: Operator, req: IncomingMessage) {
  const b = await readJson<{
    tenantId?: string; planCode?: string; studentCap?: number; trialEndsOn?: string;
  }>(req);
  const tenantId = (b.tenantId ?? '').trim();
  if (!UUID_RE.test(tenantId)) throw new HttpError(400, 'tenantId must be a uuid', 'invalid_id');

  const ctx = { tenantId, userId: op.id, role: 'principal' };
  return db.withTenant(ctx, async (c) => {
    const { rows: before } = await c.query<{
      plan_code: string; student_cap: number; trial_ends_on: string | null;
    }>(`SELECT plan_code, student_cap, trial_ends_on FROM tenants WHERE id = $1`, [tenantId]);
    if (before.length === 0) throw new HttpError(404, 'প্রতিষ্ঠান পাওয়া যায়নি', 'not_found');

    const cap = b.studentCap === undefined ? before[0].student_cap : Number(b.studentCap);
    if (!Number.isInteger(cap) || cap <= 0) {
      throw new HttpError(400, 'শিক্ষার্থীর সীমা শূন্যের বেশি হতে হবে', 'invalid_cap',
        { field: 'studentCap' });
    }

    // A cap below what the school already has would leave it permanently over
    // its limit: migration 045's trigger refuses the NEXT enrolment, so the
    // school could never enrol another student and nothing in the UI would
    // explain why. Refused here, naming both numbers the way the trigger does.
    const { rows: used } = await c.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM enrolments
        WHERE tenant_id = $1 AND status = 'active'`, [tenantId]);
    const enrolled = Number(used[0].n);
    if (cap < enrolled) {
      throw new HttpError(409,
        `সীমা ${cap} করা যাবে না — এই প্রতিষ্ঠানে এখনই ${enrolled} জন শিক্ষার্থী আছে`,
        'cap_below_enrolled', { cap, enrolled });
    }

    const plan = (b.planCode ?? before[0].plan_code).trim().slice(0, 40) || before[0].plan_code;
    const trial = b.trialEndsOn === undefined ? before[0].trial_ends_on
      : ((b.trialEndsOn ?? '').trim() || null);

    const { rows } = await c.query<{
      plan_code: string; student_cap: number; trial_ends_on: string | null;
    }>(
      `UPDATE tenants SET plan_code = $2, student_cap = $3, trial_ends_on = $4::date
        WHERE id = $1
        RETURNING plan_code, student_cap, trial_ends_on`,
      [tenantId, plan, cap, trial]);
    if (rows.length === 0) throw new HttpError(403, 'পরিবর্তনের অনুমতি নেই', 'forbidden');

    // The platform audit trail, same as every other cross-tenant act: who
    // raised whose cap, and from what to what.
    await c.query(
      `SELECT app.log_platform_action($1, $2, $3, $4)`,
      [op.id, tenantId, 'plan.update',
       `${before[0].plan_code}/${before[0].student_cap} → ${plan}/${cap}`]);

    return {
      planCode: rows[0].plan_code,
      studentCap: rows[0].student_cap,
      trialEndsOn: rows[0].trial_ends_on,
      enrolled,
    };
  });
}

async function setStatus(db: Db, op: Operator, req: IncomingMessage) {
  const b = await readJson<{ tenantId?: string; status?: string; reason?: string }>(req);
  const tenantId = (b.tenantId ?? '').trim();
  if (!UUID_RE.test(tenantId)) throw new HttpError(400, 'tenantId must be a uuid', 'invalid_id');
  if (!STATUSES.includes(b.status ?? '')) {
    throw new HttpError(400, 'অবস্থা সঠিক নয়', 'invalid_status', { field: 'status' });
  }

  if (b.status === 'active') {
    const { rows } = await db.pool.query<Record<string, string>>(
      `SELECT * FROM app.tenant_onboarding_state($1)`, [tenantId]);
    const s = rows[0];
    const blockers: string[] = [];
    if (Number(s.years) === 0) blockers.push('শিক্ষাবর্ষ তৈরি হয়নি');
    // Singled out because it is the failure that HIDES: without bands,
    // app.compute_subject_grade returns NULL and the first result
    // publication of the year fails, months later, with no obvious cause.
    if (Number(s.grading_bands) === 0) blockers.push('গ্রেডিং স্কেল তৈরি হয়নি');
    if (Number(s.admins) === 0) blockers.push('প্রতিষ্ঠানের কোনো প্রশাসক অ্যাকাউন্ট নেই');
    if (blockers.length > 0) {
      throw new HttpError(409,
        `সক্রিয় করা যাচ্ছে না — ${blockers.join(', ')}`,
        'activation_blocked', { blockers });
    }
  }

  const { rows } = await db.pool.query<{ set_tenant_status: string }>(
    `SELECT app.set_tenant_status($1, $2, $3::tenant_status, $4)`,
    [op.id, tenantId, b.status, b.reason ?? null]);
  return { previous: rows[0].set_tenant_status, status: b.status };
}

async function readAudit(db: Db, req: IncomingMessage) {
  const tenantId = (query(req).get('tenantId') ?? '').trim();
  const { rows } = await db.pool.query(
    `SELECT id, admin_id, tenant_id, reason, statement, created_at
       FROM audit.platform_access
      WHERE ($1::uuid IS NULL OR tenant_id = $1::uuid)
      ORDER BY created_at DESC, id DESC
      LIMIT 100`,
    [UUID_RE.test(tenantId) ? tenantId : null]);
  return {
    entries: rows.map((r: Record<string, unknown>) => ({
      id: String(r.id), actorId: r.admin_id, tenantId: r.tenant_id,
      reason: r.reason, statement: r.statement, at: r.created_at,
    })),
  };
}

// ── R-8: go-live readiness ──────────────────────────────────────────────

/**
 * What this deployment is actually configured to do.
 *
 * Every line is DERIVED from the environment, never ticked by a person. A
 * hand-maintained go-live checklist is wrong the first time a variable is
 * renamed, and the operator who most needs this screen is the one who has
 * just changed something.
 *
 * It reads no database and names no tenant: readiness is a property of the
 * process, identical for every school on it. That is also why it is safe for
 * it to be the one platform endpoint with no tenant parameter at all.
 *
 * The values themselves never leave the process — only whether each is
 * present, plus the two that are not secret (the provider name and the
 * sender id, both of which appear on every message a school sends). §24: no
 * platform secret in browser code, and none in a browser response either.
 */
function readiness() {
  const checks = goLiveChecks();
  const blocking = checks.filter((c) => c.severity === 'blocking');
  return {
    checks,
    // "Ready" means every BLOCKING item passes. Advisory items are posture
    // worth fixing before a pilot, not before a login, and folding them in
    // would leave the screen permanently red — and a permanently red check
    // is one nobody reads.
    ready: blocking.every((c) => c.ready),
    blockingRemaining: blocking.filter((c) => !c.ready).length,
  };
}
