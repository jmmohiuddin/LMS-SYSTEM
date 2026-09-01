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
import { onboardingMetrics, looksSynthetic } from '../../../packages/server-core/src/onboarding-metrics.ts';
import { parseBranding } from '../../../packages/ui-core/src/branding.ts';
import {
  runStudentImport, runTeacherImport, ImportError,
} from '../../academics-svc/src/import-run.ts';
import {
  generateCode, codeHash, activationConfigured,
} from '../../identity-svc/src/activation.ts';
import { goLiveChecks, subdomainsReady } from '../../../packages/server-core/src/go-live.ts';

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
      case 'GET health':    return json(res, 200, await tenantHealth(db, req), cors);
      case 'POST provision':return json(res, 200, await provision(db, op, req), cors);
      case 'POST branding': return json(res, 200, await setBranding(db, op, req), cors);
      case 'POST admin':    return json(res, 200, await createAdmin(db, op, req), cors);
      case 'POST import':   return json(res, 200, await runImport(db, op, req), cors);
      case 'POST plan':     return json(res, 200, await setPlan(db, op, req), cors);
      case 'POST status':   return json(res, 200, await setStatus(db, op, req), cors);
      case 'GET audit':     return json(res, 200, await readAudit(db, req), cors);

      // ── P7. Operations ──────────────────────────────────────────────
      case 'GET overview':  return json(res, 200, await overview(db), cors);
      case 'GET catalogue': return json(res, 200, await catalogue(db), cors);
      case 'GET operations':return json(res, 200, await getOperations(db, req), cors);
      case 'POST opsstate': return json(res, 200, await setOpsState(db, op, req), cors);
      case 'POST service':  return json(res, 200, await setService(db, op, req), cors);
      case 'POST portal':   return json(res, 200, await setPortal(db, op, req), cors);
      case 'POST payment':  return json(res, 200, await recordPayment(db, op, req), cors);
      case 'POST grace':    return json(res, 200, await extendGrace(db, op, req), cors);
      case 'POST cap':      return json(res, 200, await setCap(db, op, req), cors);
      case 'POST plans':    return json(res, 200, await savePlan(db, op, req), cors);
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
      // R-8 §9B. This used to return `msg` — the trigger's own English —
      // straight to the console. It is a last-resort net now: the student
      // import classifies the violation itself and answers with the numbers.
      // Anything reaching here has no numbers to give, so it says what it can
      // rather than what the database said.
      return json(res, 409, {
        error: 'student_cap_reached',
        message: 'শিক্ষার্থীর সীমা পেরিয়ে গেছে — কিছুই সংরক্ষণ হয়নি। '
          + '"প্ল্যান ও সীমা" থেকে সীমা বাড়িয়ে আবার চেষ্টা করুন।',
      }, cors);
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
         FROM tenants WHERE id = app.current_tenant()`), {
    // P7. The console must reach INTO a school the gate would stop — that is
    // how a suspended school gets inspected, and how it gets reopened. This
    // is the one service allowed past, and it is past because it is NOT a
    // school acting on itself.
    skipGate: true,
  });

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
    // R-8 §9D. Whether the school's own subdomain actually resolves. The
    // console listed it beside the install link as an equal way in, and
    // *.shikhonbd.com has never had DNS or a certificate — see go-live.ts.
    subdomainsLive: subdomainsReady(),
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
  }, {
    // P7. The console must reach INTO a school the gate would stop — that is
    // how a suspended school gets inspected, and how it gets reopened. This
    // is the one service allowed past, and it is past because it is NOT a
    // school acting on itself.
    skipGate: true,
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
  }, {
    // P7. The console must reach INTO a school the gate would stop — that is
    // how a suspended school gets inspected, and how it gets reopened. This
    // is the one service allowed past, and it is past because it is NOT a
    // school acting on itself.
    skipGate: true,
  });
}

interface AdminBody {
  /**
   * R-8 §9A. Set only after the operator has been shown WHO the phone number
   * already belongs to and what they already are. Without it, an existing
   * person is refused with 409 `user_exists` rather than silently given a new
   * role.
   */
  confirmExisting?: boolean;
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
    const existing = await c.query<{ id: string; full_name_bn: string; roles: string[] }>(
      `SELECT u.id, u.full_name_bn,
              COALESCE(array_agg(r.role_code) FILTER (WHERE r.role_code IS NOT NULL), '{}') AS roles
         FROM users u
         LEFT JOIN user_roles r ON r.user_id = u.id AND r.tenant_id = u.tenant_id
        WHERE u.phone_e164 = $1 AND u.deleted_at IS NULL
        GROUP BY u.id, u.full_name_bn`, [phone]);

    let userId: string;
    let reused = false;
    if (existing.rows[0]) {
      // ── R-8 §9A. Reuse is right; reusing SILENTLY is not. ───────────
      //
      // Granting the role rather than creating a second account for one human
      // is the correct behaviour and stays. What was wrong is that it happened
      // without saying so: an operator who mistyped a digit and landed on an
      // existing teacher's number, with "principal" selected, promoted that
      // teacher to principal of the school and saw only `reused: true` in a
      // response the console did not surface. It happened to me during R-7's
      // acceptance walk, which is how it got found.
      //
      // So an existing person now requires an explicit second act. The refusal
      // names WHO would be affected and what they already are, because "this
      // number is already registered" is not enough to decide with.
      const who = existing.rows[0];
      const already = who.roles.includes(roleCode);
      if (!b.confirmExisting) {
        throw new HttpError(409,
          already
            ? `${who.full_name_bn} ইতিমধ্যেই এই ভূমিকায় আছেন — নতুন কোড দিতে নিশ্চিত করুন।`
            : `এই নম্বরটি ${who.full_name_bn} এর — তাঁকে নতুন ভূমিকা দেওয়া হবে। নিশ্চিত করুন।`,
          'user_exists',
          {
            existingName: who.full_name_bn,
            existingRoles: who.roles,
            requestedRole: roleCode,
            alreadyHasRole: already,
          });
      }
      userId = who.id;
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
  }, {
    // P7. The console must reach INTO a school the gate would stop — that is
    // how a suspended school gets inspected, and how it gets reopened. This
    // is the one service allowed past, and it is past because it is NOT a
    // school acting on itself.
    skipGate: true,
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
    // ── R-8 §9B. The cap refusal, in the operator's language ──────────
    //
    // Migration 045's trigger is the guarantee and its message is written for
    // whoever reads a database log: "student cap reached: this institution is
    // capped at 500 students and this would make 512". That sentence reached
    // the console verbatim, in English, in the middle of an otherwise Bangla
    // screen. The trigger is left exactly as it is — it must fire under
    // concurrency and a developer-facing message is right for a
    // developer-facing surface — and the API stops passing it through.
    //
    // The numbers are read BEFORE the import, not after. The trigger aborts
    // the transaction, so a query issued from a catch block inside it fails
    // too, with `25P02 current transaction is aborted` — which is what the
    // first version of this did, turning a 409 into a 500. They are also not
    // parsed out of the message: a message format is not an interface.
    const capRow = await c.query<{ cap: number; enrolled: number }>(
      `SELECT t.student_cap AS cap,
              (SELECT count(DISTINCT e.student_id)::int FROM enrolments e
                WHERE e.tenant_id = t.id AND e.status = 'active') AS enrolled
         FROM tenants t WHERE t.id = $1`, [tenantId]);
    const cap = capRow.rows[0]?.cap ?? 0;
    const enrolled = capRow.rows[0]?.enrolled ?? 0;

    try {
      return await runStudentImport(c, {
        csv: b.csv ?? '', academicYearId: yearId, tenantId, userId: startedBy,
        commit: b.commit, digest: b.digest, fileName: b.fileName ?? null,
      });
    } catch (err) {
      if (isStudentCapViolation(err)) {
        throw new HttpError(409, capMessageBn(cap, enrolled),
          'student_cap_reached', { cap, enrolled });
      }
      throw err;
    }
  }, {
    // P7. The console must reach INTO a school the gate would stop — that is
    // how a suspended school gets inspected, and how it gets reopened. This
    // is the one service allowed past, and it is past because it is NOT a
    // school acting on itself.
    skipGate: true,
  });
}

/** Bangla numerals, so a number inside a Bangla sentence reads as one. */
function bn(n: number): string {
  return String(n).replace(/[0-9]/g, (d) => '০১২৩৪৫৬৭৮৯'[Number(d)]);
}

/**
 * What an operator is told when the cap refuses an import.
 *
 * Says the limit, says the current roll, says that NOTHING was imported —
 * which is the fact an operator most needs and the one a raw constraint
 * message never mentions — and names the screen that fixes it.
 */
export function capMessageBn(cap: number, enrolled: number): string {
  return `শিক্ষার্থীর সীমা পেরিয়ে যাচ্ছে — এই প্রতিষ্ঠানের সীমা ${bn(cap)} জন, `
    + `এখন ভর্তি আছে ${bn(enrolled)} জন। কিছুই আমদানি হয়নি। `
    + `"প্ল্যান ও সীমা" থেকে সীমা বাড়িয়ে আবার চেষ্টা করুন।`;
}

/**
 * Is this the student-cap trigger, rather than any other check constraint?
 *
 * Matched on the constraint's own text because migration 045 raises with
 * ERRCODE `check_violation` and no constraint name — a `RAISE EXCEPTION` in a
 * trigger function has none to give. Deliberately narrow: a different check
 * violation must keep its own error rather than be reported as a cap problem.
 */
export function isStudentCapViolation(err: unknown): boolean {
  const e = err as { code?: string; message?: string };
  return e?.code === '23514' && /student cap reached/i.test(e.message ?? '');
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
/**
 * GET health — what an operator needs to answer "is this school all right?"
 *
 * R-8 §10. The console could already say what a school HAS — classes, students,
 * a plan. It could not say how it was DOING: whether its messages were going
 * out, whether anybody had logged in this week, whether a queue was stuck. In a
 * pilot those are the only questions, and answering them meant SQL.
 *
 * ── What is deliberately NOT here ───────────────────────────────────────
 * No names, no phone numbers, no student rows. §10 says not to expose
 * student-level PII unnecessarily and none of it is necessary: an operator
 * supporting a school needs counts and timestamps, and the school's own staff —
 * who have a relationship with the children — have the screens that show
 * people. A platform operator browsing pupil records is exactly the thing
 * tenant isolation exists to make impossible, and it would be perverse to
 * rebuild it here for convenience.
 */
async function tenantHealth(db: Db, req: IncomingMessage) {
  const id = (query(req).get('id') ?? query(req).get('tenantId') ?? '').trim();
  if (!UUID_RE.test(id)) throw new HttpError(400, 'id must be a uuid', 'invalid_id');

  // Inside the tenant's own context. These tables are RLS-protected and a bare
  // pool query would silently return zeros — the mistake R-7 made three times.
  return db.withTenant({ tenantId: id, userId: id, role: 'system_ingest' }, async (c) => {
    const { rows: sms } = await c.query<Record<string, string>>(
      `SELECT
         count(*) FILTER (WHERE created_on = CURRENT_DATE)                    AS queued_today,
         count(*) FILTER (WHERE status IN ('sent','delivered'))               AS sent_total,
         count(*) FILTER (WHERE status = 'delivered')                         AS delivered_total,
         count(*) FILTER (WHERE status = 'failed')                            AS failed_total,
         count(*) FILTER (WHERE status = 'suppressed')                        AS suppressed_total,
         count(*) FILTER (WHERE status = 'queued')                            AS queued_now,
         COALESCE(sum(cost_bdt) FILTER (WHERE status IN ('sent','delivered')), 0)::text AS cost_bdt,
         COALESCE(sum(segments) FILTER (WHERE created_on >= date_trunc('month', CURRENT_DATE)), 0)::text
                                                                              AS segments_this_month,
         to_char(max(sent_at), 'YYYY-MM-DD"T"HH24:MI:SSZ')                    AS last_sent_at
       FROM sms_outbox`);

    // The reasons things did not send, most common first. Codes, not bodies:
    // a message body is a school's words to a parent.
    const { rows: errs } = await c.query<{ error_code: string; n: string }>(
      `SELECT COALESCE(error_code, 'unknown') AS error_code, count(*)::text AS n
         FROM sms_outbox
        WHERE status IN ('failed','suppressed') AND error_code IS NOT NULL
        GROUP BY 1 ORDER BY count(*) DESC LIMIT 5`);

    const { rows: push } = await c.query<Record<string, string>>(
      `SELECT count(*)::text AS devices,
              count(*) FILTER (WHERE last_success_at IS NOT NULL)::text AS devices_reached,
              to_char(max(last_success_at), 'YYYY-MM-DD"T"HH24:MI:SSZ') AS last_push_at
         FROM push_subscriptions`);

    // "Has anybody actually used this school?" — the single most useful
    // number during a pilot, and the one that says an onboarding stalled.
    const { rows: login } = await c.query<Record<string, string>>(
      `SELECT to_char(max(issued_at), 'YYYY-MM-DD"T"HH24:MI:SSZ') AS last_login_at,
              count(DISTINCT user_id) FILTER (WHERE issued_at > now() - interval '7 days')::text
                AS active_users_7d
         FROM user_sessions`);

    const { rows: att } = await c.query<Record<string, string>>(
      `SELECT to_char(max(taken_on), 'YYYY-MM-DD') AS last_attendance_on,
              count(*) FILTER (WHERE taken_on > CURRENT_DATE - 7)::text AS sessions_7d
         FROM attendance_sessions`);

    const oldest = await c.query<{ age_minutes: string | null }>(
      `SELECT EXTRACT(EPOCH FROM (now() - min(queued_at)))::bigint / 60 AS age_minutes
         FROM sms_outbox WHERE status = 'queued'`);

    return {
      sms: {
        queuedNow: Number(sms[0].queued_now),
        queuedToday: Number(sms[0].queued_today),
        sent: Number(sms[0].sent_total),
        delivered: Number(sms[0].delivered_total),
        failed: Number(sms[0].failed_total),
        suppressed: Number(sms[0].suppressed_total),
        segmentsThisMonth: Number(sms[0].segments_this_month),
        costBdt: Number(sms[0].cost_bdt),
        lastSentAt: sms[0].last_sent_at,
        // A queue that is not draining is the failure that looks like nothing.
        oldestQueuedMinutes: oldest.rows[0]?.age_minutes === null
          ? null : Number(oldest.rows[0]?.age_minutes ?? 0),
      },
      errors: errs.map((e) => ({ code: e.error_code, count: Number(e.n) })),
      push: {
        devices: Number(push[0].devices),
        devicesReached: Number(push[0].devices_reached),
        lastPushAt: push[0].last_push_at,
      },
      usage: {
        lastLoginAt: login[0].last_login_at,
        activeUsers7d: Number(login[0].active_users_7d),
        lastAttendanceOn: att[0].last_attendance_on,
        attendanceSessions7d: Number(att[0].sessions_7d),
      },
      // R-8 §11. How long this school's setup actually took, derived from the
      // console's own audit rows. The master plan carries an "under an hour"
      // target and R-8 forbids claiming it unmeasured — so the number goes on
      // a screen the operator already opens, rather than into a report nobody
      // re-runs.
      onboarding: await (async () => {
        const m = await onboardingMetrics(c, id);
        // `synthetic` is computed HERE and not in the browser, so the console
        // and scripts/pilot-report.mjs cannot disagree about whether a school
        // was set up by a person. Four console actions inside one second is a
        // seeding script, and rendering that as "০ মিনিট" would be the
        // prettiest lie on the screen.
        return { ...m, synthetic: looksSynthetic(m) };
      })(),
    };
  }, {
    // P7. The console must reach INTO a school the gate would stop — that is
    // how a suspended school gets inspected, and how it gets reopened. This
    // is the one service allowed past, and it is past because it is NOT a
    // school acting on itself.
    skipGate: true,
  });
}

async function setPlan(db: Db, op: Operator, req: IncomingMessage) {
  const b = await readJson<{
    tenantId?: string; planCode?: string; studentCap?: number; trialEndsOn?: string;
    reason?: string;
  }>(req);
  const tenantId = (b.tenantId ?? '').trim();
  if (!UUID_RE.test(tenantId)) throw new HttpError(400, 'tenantId must be a uuid', 'invalid_id');
  // P7. Every other commercial change in this console states why; a plan
  // change moves price, cap, services and grace at once and was the one
  // mutation that did not.
  const reason = requireReason(b.reason);

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
        `সীমা ${bn(cap)} করা যাবে না — এই প্রতিষ্ঠানে এখনই ${bn(enrolled)} জন শিক্ষার্থী আছে`,
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
    // reason, then statement — the same order every other platform action
    // uses, so `audit.platform_access.reason` holds a sentence a person wrote
    // rather than the string 'plan.update'.
    await c.query(
      `SELECT app.log_platform_action($1, $2, $3, $4)`,
      [op.id, tenantId, reason,
       `plan ${before[0].plan_code}/${before[0].student_cap} → ${plan}/${cap}`]);

    return {
      planCode: rows[0].plan_code,
      studentCap: rows[0].student_cap,
      trialEndsOn: rows[0].trial_ends_on,
      enrolled,
    };
  }, {
    // P7. The console must reach INTO a school the gate would stop — that is
    // how a suspended school gets inspected, and how it gets reopened. This
    // is the one service allowed past, and it is past because it is NOT a
    // school acting on itself.
    skipGate: true,
  });
}

async function setStatus(db: Db, op: Operator, req: IncomingMessage) {
  const b = await readJson<{ tenantId?: string; status?: string; reason?: string }>(req);
  const tenantId = (b.tenantId ?? '').trim();
  if (!UUID_RE.test(tenantId)) throw new HttpError(400, 'tenantId must be a uuid', 'invalid_id');
  if (!STATUSES.includes(b.status ?? '')) {
    throw new HttpError(400, 'অবস্থা সঠিক নয়', 'invalid_status', { field: 'status' });
  }
  // P7. Suspending through this endpoint is now a REAL suspension — 052 made
  // the gate honour `tenants.status`, which nothing read before. A change
  // that locks a whole school out has to say why, the same as every other
  // one in this console.
  const reason = requireReason(b.reason);

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
    [op.id, tenantId, b.status, reason]);
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
      id: String(r.id),
      // NOT the actor id. It is a JWT subject with no `users` row and no
      // directory behind it (B-39), so it resolves to nobody, cannot be
      // displayed under "never expose raw UUIDs", and shipping it to the
      // client only invites the next person to render it. The column stays
      // in `audit.platform_access`, where it is evidence.
      tenantId: r.tenant_id,
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

// ═══════════════════════════════════════════════════════════════════════
// P7 — operations
//
// Everything below changes what a school may DO, so everything below is
// audited and everything below demands a reason. `app.log_platform_action` is
// the one door: the platform session has SELECT on `audit.platform_access`
// and deliberately not INSERT, so an entry cannot be forged or backdated by
// the subject of the audit. 045 built it that way; P7 uses it unchanged.
// ═══════════════════════════════════════════════════════════════════════

const OPS_STATES = ['active', 'maintenance', 'limited', 'suspended'];
const SERVICE_STATES = ['enabled', 'disabled', 'limited', 'maintenance'];
const PORTALS = ['principal', 'it_admin', 'teacher', 'student', 'guardian'];
const PAY_METHODS = ['bank', 'bkash', 'nagad', 'rocket', 'cash', 'cheque', 'other'];

/**
 * A reason, or a refusal.
 *
 * Not politeness. The gate suite found that a state change without one leaves
 * the PREVIOUS reason on screen — so a school in maintenance reads "suspended
 * for non-payment", which is a sentence we told them that is not true.
 */
function requireReason(raw: unknown): string {
  const reason = typeof raw === 'string' ? raw.trim() : '';
  if (reason.length < 3) {
    throw new HttpError(400,
      'কারণ লিখুন — কারণ ছাড়া পরিবর্তন ছয় মাস পরে বাগ থেকে আলাদা করা যায় না',
      'reason_required', { field: 'reason' });
  }
  if (reason.length > 500) {
    throw new HttpError(400, 'কারণ ৫০০ অক্ষরের মধ্যে লিখুন', 'reason_too_long',
      { field: 'reason' });
  }
  return reason;
}

function requireTenantId(raw: unknown): string {
  const id = typeof raw === 'string' ? raw : '';
  if (!UUID_RE.test(id)) {
    throw new HttpError(400, 'tenantId must be a valid uuid', 'invalid_tenant');
  }
  return id;
}

/**
 * One row per tenant with everything the console's master list needs.
 *
 * Through `app.platform_overview()` — a SECURITY DEFINER function — because
 * `tenants` carries `tenant_self` and the platform role has no tenant. A
 * direct SELECT here returned zero rows with a 200, which is the worst shape
 * a permissions bug can take.
 */
async function overview(db: Db) {
  const { rows } = await db.pool.query(`SELECT * FROM app.platform_overview()`);
  return { tenants: rows.map(shapeOverview) };
}

function shapeOverview(r: Record<string, unknown>) {
  return {
    id: r.id,
    slug: String(r.slug),
    nameBn: r.name_bn,
    nameEn: r.name_en,
    stream: r.stream,
    level: r.level,
    district: r.district,
    status: r.status,
    // What the school may do RIGHT NOW — the two states an operator
    // actually decides on, kept separate so neither can be mistaken for
    // the other.
    access: r.access,
    opsState: r.ops_state ?? 'active',
    billingState: r.billing_state,
    stateReason: r.state_reason,
    planCode: r.plan_code,
    planName: r.plan_name,
    planPrice: r.plan_price === null ? null : String(r.plan_price),
    billingCycle: r.billing_cycle,
    studentCap: r.student_cap,
    studentCount: Number(r.student_count ?? 0),
    userCount: Number(r.user_count ?? 0),
    paidTotal: String(r.paid_total ?? '0'),
    nextDueOn: r.next_due_on,
    graceUntil: r.grace_until,
    trialEndsOn: r.trial_ends_on,
    createdAt: r.created_at,
    // Measured, never invented: the later of a real sign-in and a real
    // product event. Null means nobody has ever signed in, which the console
    // must say in words rather than as a date.
    lastActiveAt: r.last_active_at ?? null,
    portals: r.portals ?? {},
    services: r.services ?? {},
  };
}

/** The plans and the service catalogue. Static per deployment; read once. */
async function catalogue(db: Db) {
  const [plans, services] = await Promise.all([
    db.pool.query(`SELECT code, name_bn, price_bdt, billing_cycle, student_cap,
                          services, trial_days, grace_days, is_active
                     FROM plans ORDER BY price_bdt, code`),
    db.pool.query(`SELECT code, name_bn, effect_bn, depends_on, in_limited
                     FROM service_catalogue ORDER BY sort_order`),
  ]);
  return {
    plans: plans.rows.map((r: Record<string, unknown>) => ({
      code: r.code, nameBn: r.name_bn, priceBdt: String(r.price_bdt),
      billingCycle: r.billing_cycle, studentCap: r.student_cap,
      services: r.services, trialDays: r.trial_days, graceDays: r.grace_days,
      isActive: r.is_active,
    })),
    services: services.rows.map((r: Record<string, unknown>) => ({
      code: r.code, nameBn: r.name_bn, effectBn: r.effect_bn,
      dependsOn: r.depends_on, inLimited: r.in_limited,
    })),
  };
}

/** One school's operational state, entitlements, payments and effective services. */
async function getOperations(db: Db, req: IncomingMessage) {
  const id = requireTenantId(query(req).get('id'));
  const [ops, pay, eff] = await Promise.all([
    // Definer, for the reason in `overview` above.
    db.pool.query(`SELECT * FROM app.platform_operations($1)`, [id]),
    db.pool.query(
      `SELECT amount_bdt, paid_on, method, reference, note, covers_until, recorded_at
         FROM tenant_payments WHERE tenant_id = $1
        ORDER BY paid_on DESC, recorded_at DESC LIMIT 50`, [id]),
    // The EFFECTIVE state of every service, from the function that decides
    // it — never recomputed here. Two copies of this rule would eventually
    // disagree, and the console would then be lying about what is on.
    db.pool.query(
      `SELECT c.code, app.tenant_service_state($1, c.code) AS state
         FROM service_catalogue c ORDER BY c.sort_order`, [id]),
  ]);
  if (ops.rows.length === 0) throw new HttpError(404, 'no such tenant', 'not_found');
  const r = ops.rows[0] as Record<string, unknown>;
  return {
    operations: {
      access: r.access,
      opsState: r.ops_state ?? 'active',
      billingState: r.billing_state,
      reasonBn: r.reason_bn,
      until: r.until,
      stateReason: r.state_reason,
      stateChangedAt: r.state_changed_at,
      stateUntil: r.state_until,
      portals: r.portals ?? {},
      serviceOverrides: r.services ?? {},
      planCode: r.plan_code,
      planName: r.plan_name,
      planPrice: r.price_bdt === null || r.price_bdt === undefined
        ? null : String(r.price_bdt),
      billingCycle: r.billing_cycle,
      graceDays: r.grace_days,
      planCap: r.plan_cap,
      planServices: r.plan_services ?? {},
      studentCap: r.student_cap,
      studentCount: Number(r.student_count ?? 0),
      nextDueOn: r.next_due_on,
      graceUntil: r.grace_until,
      graceReason: r.grace_reason,
      trialEndsOn: r.trial_ends_on,
    },
    services: eff.rows.map((x: Record<string, unknown>) => ({
      code: x.code, state: x.state,
    })),
    payments: pay.rows.map((x: Record<string, unknown>) => ({
      amountBdt: String(x.amount_bdt), paidOn: x.paid_on, method: x.method,
      reference: x.reference, note: x.note, coversUntil: x.covers_until,
      recordedAt: x.recorded_at,
    })),
  };
}

/**
 * The tenant-wide control: active · maintenance · limited · suspended.
 *
 * Never deletes anything. §16: "Suspended institution — data remains
 * untouched, history preserved." This writes one column and a reason.
 */
async function setOpsState(db: Db, op: { id: string }, req: IncomingMessage) {
  const body = await readJson<Record<string, unknown>>(req);
  const id = requireTenantId(body.tenantId);
  const reason = requireReason(body.reason);
  const state = String(body.state ?? '');
  if (!OPS_STATES.includes(state)) {
    throw new HttpError(400, `state must be one of: ${OPS_STATES.join(', ')}`,
      'invalid_state', { field: 'state' });
  }
  const until = body.until === null || body.until === undefined || body.until === ''
    ? null : String(body.until);

  await db.pool.query(
    `UPDATE tenant_operations
        SET ops_state = $2::tenant_ops_state, state_reason = $3,
            state_changed_at = now(), state_changed_by = $4,
            state_until = $5, updated_at = now()
      WHERE tenant_id = $1`,
    [id, state, reason, op.id, until]);
  await db.pool.query(`SELECT app.log_platform_action($1, $2, $3, $4)`,
    [op.id, id, reason, `ops_state=${state}${until ? ` until=${until}` : ''}`]);

  return afterChange(db, id);
}

/** One service, for one school. */
async function setService(db: Db, op: { id: string }, req: IncomingMessage) {
  const body = await readJson<Record<string, unknown>>(req);
  const id = requireTenantId(body.tenantId);
  const reason = requireReason(body.reason);
  const code = String(body.service ?? '');
  const state = String(body.state ?? '');
  if (!SERVICE_STATES.includes(state)) {
    throw new HttpError(400, `state must be one of: ${SERVICE_STATES.join(', ')}`,
      'invalid_state', { field: 'state' });
  }
  const known = await db.pool.query(
    `SELECT code, name_bn FROM service_catalogue WHERE code = $1`, [code]);
  if (known.rows.length === 0) {
    throw new HttpError(400, 'unknown service', 'unknown_service', { field: 'service' });
  }

  // §10 — no impossible states. Turning a service OFF while something that
  // needs it is still on would leave the UI claiming a thing happened that
  // cannot have. The catalogue declares the dependencies; this refuses.
  if (state === 'disabled') {
    const dependents = await db.pool.query<{ code: string; name_bn: string }>(
      `SELECT c.code, c.name_bn FROM service_catalogue c
        WHERE $2 = ANY(c.depends_on)
          AND app.tenant_service_state($1, c.code) IN ('enabled','limited')`,
      [id, code]);
    if (dependents.rows.length > 0) {
      const names = dependents.rows.map((d) => d.name_bn).join(', ');
      throw new HttpError(409,
        `আগে ${names} বন্ধ করতে হবে — সেগুলো ${known.rows[0].name_bn}-এর উপর নির্ভর করে`,
        'dependency_active', { dependents: dependents.rows.map((d) => d.code) });
    }
  }

  await db.pool.query(
    `UPDATE tenant_operations
        SET services = CASE WHEN $3 = 'enabled'
                            -- 'enabled' REMOVES the override rather than
                            -- storing one, so the plan goes back to being
                            -- the authority. Storing "enabled" would
                            -- silently grant a service the plan excludes.
                            THEN services - $2::text
                            ELSE jsonb_set(services, ARRAY[$2::text], to_jsonb($3::text), true)
                       END,
            updated_at = now()
      WHERE tenant_id = $1`, [id, code, state]);
  await db.pool.query(`SELECT app.log_platform_action($1, $2, $3, $4)`,
    [op.id, id, reason, `service ${code}=${state}`]);

  return afterChange(db, id);
}

/**
 * One portal, for one school. §8: "Teachers cannot log in for this
 * institution right now, but Principal and IT Admin can."
 *
 * Never by deleting users or roles — this is one key in one jsonb column, and
 * turning it back on restores exactly what was there.
 */
async function setPortal(db: Db, op: { id: string }, req: IncomingMessage) {
  const body = await readJson<Record<string, unknown>>(req);
  const id = requireTenantId(body.tenantId);
  const reason = requireReason(body.reason);
  const portal = String(body.portal ?? '');
  const open = body.open === true;
  if (!PORTALS.includes(portal)) {
    throw new HttpError(400, `portal must be one of: ${PORTALS.join(', ')}`,
      'invalid_portal', { field: 'portal' });
  }
  // Closing the principal AND the IT admin portal locks the school's own
  // administrators out of a building only they can reopen from the inside.
  // Refused: an operator who genuinely wants that wants `suspended`, which
  // says so honestly.
  if (!open && (portal === 'principal' || portal === 'it_admin')) {
    const other = portal === 'principal' ? 'it_admin' : 'principal';
    const { rows } = await db.pool.query<{ open: boolean }>(
      `SELECT COALESCE((portals ->> $2)::boolean, true) AS open
         FROM tenant_operations WHERE tenant_id = $1`, [id, other]);
    if (rows[0] && rows[0].open === false) {
      throw new HttpError(409,
        'প্রধান শিক্ষক ও আইটি অ্যাডমিন — দুটোই বন্ধ করলে প্রতিষ্ঠানের কেউ আর প্রবেশ করতে পারবে না। '
        + 'পুরো প্রতিষ্ঠান বন্ধ করতে চাইলে "স্থগিত" ব্যবহার করুন।',
        'would_lock_out');
    }
  }

  await db.pool.query(
    `UPDATE tenant_operations
        SET portals = CASE WHEN $3
                           -- Open REMOVES the key: absent means allowed, so
                           -- the row goes back to its default shape rather
                           -- than accumulating true-valued keys.
                           THEN portals - $2::text
                           ELSE jsonb_set(portals, ARRAY[$2::text], 'false'::jsonb, true)
                      END,
            updated_at = now()
      WHERE tenant_id = $1`, [id, portal, open]);
  await db.pool.query(`SELECT app.log_platform_action($1, $2, $3, $4)`,
    [op.id, id, reason, `portal ${portal}=${open ? 'open' : 'closed'}`]);

  return afterChange(db, id);
}

/**
 * Record a manual payment. §12. There is no gateway and there will not be
 * one in P7 — shikhonBD invoices a school outside the product.
 */
async function recordPayment(db: Db, op: { id: string }, req: IncomingMessage) {
  const body = await readJson<Record<string, unknown>>(req);
  const id = requireTenantId(body.tenantId);
  const amount = Number(body.amountBdt);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new HttpError(400, 'টাকার পরিমাণ শূন্যের বেশি হতে হবে', 'invalid_amount',
      { field: 'amountBdt' });
  }
  const paidOn = String(body.paidOn ?? '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(paidOn)) {
    throw new HttpError(400, 'পরিশোধের তারিখ দিন', 'invalid_date', { field: 'paidOn' });
  }
  const method = String(body.method ?? '');
  if (!PAY_METHODS.includes(method)) {
    throw new HttpError(400, `method must be one of: ${PAY_METHODS.join(', ')}`,
      'invalid_method', { field: 'method' });
  }
  const reference = typeof body.reference === 'string' ? body.reference.trim() : '';
  const note = typeof body.note === 'string' ? body.note.trim() : null;
  const coversUntil = typeof body.coversUntil === 'string' && body.coversUntil
    ? body.coversUntil : null;

  try {
    await db.pool.query(
      `INSERT INTO tenant_payments
         (tenant_id, amount_bdt, paid_on, method, reference, note, covers_until, recorded_by)
       VALUES ($1, $2, $3, $4, NULLIF($5,''), $6, $7, $8)`,
      [id, amount.toFixed(2), paidOn, method, reference, note, coversUntil, op.id]);
  } catch (err) {
    // 23505 — the UNIQUE that 051 put on (tenant, date, amount, method,
    // reference). A duplicate payment is the commonest operator error with a
    // real cost, so the DATABASE refuses it rather than the UI warning.
    if ((err as { code?: string }).code === '23505') {
      throw new HttpError(409,
        'একই তারিখে একই পরিমাণের একই পেমেন্ট আগেই রেকর্ড করা আছে। '
        + 'সত্যিই দুটি আলাদা পেমেন্ট হলে রেফারেন্স নম্বর দিন।',
        'duplicate_payment');
    }
    throw err;
  }

  // The payment MOVES the due date, which is what re-evaluates the lifecycle.
  // §13: PAYMENT_RECORDED → RE-EVALUATE → REACTIVATE, and the re-evaluation is
  // the derived state recomputing itself the moment the date changes.
  if (coversUntil) {
    await db.pool.query(
      `UPDATE tenant_operations
          SET next_due_on = $2::date, grace_until = NULL, grace_reason = NULL,
              updated_at = now()
        WHERE tenant_id = $1`, [id, coversUntil]);
  }
  await db.pool.query(`SELECT app.log_platform_action($1, $2, $3, $4)`,
    [op.id, id, note ?? 'payment recorded',
     `payment ${amount.toFixed(2)} ${method} on ${paidOn}`
     + `${coversUntil ? ` covers_until=${coversUntil}` : ''}`]);

  return afterChange(db, id);
}

/** §14 — extend grace, with a reason, an actor and a history. */
async function extendGrace(db: Db, op: { id: string }, req: IncomingMessage) {
  const body = await readJson<Record<string, unknown>>(req);
  const id = requireTenantId(body.tenantId);
  const reason = requireReason(body.reason);
  const until = String(body.until ?? '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(until)) {
    throw new HttpError(400, 'কত তারিখ পর্যন্ত, সেটি দিন', 'invalid_date',
      { field: 'until' });
  }
  await db.pool.query(
    `UPDATE tenant_operations
        SET grace_until = $2::date, grace_reason = $3, grace_granted_by = $4,
            updated_at = now()
      WHERE tenant_id = $1`, [id, until, reason, op.id]);
  await db.pool.query(`SELECT app.log_platform_action($1, $2, $3, $4)`,
    [op.id, id, reason, `grace_until=${until}`]);
  return afterChange(db, id);
}

/** §19 — the student cap, with who changed it and when. */
const CYCLES = ['monthly', 'quarterly', 'half_yearly', 'yearly'];

/**
 * Create a plan, or change one.
 *
 * The whole plan is written, not a patch: a partial update of a price list is
 * how a plan ends up with a new price and last year's services.
 */
async function savePlan(db: Db, op: { id: string }, req: IncomingMessage) {
  const b = await readJson<Record<string, unknown>>(req);
  const reason = requireReason(b.reason);

  const code = String(b.code ?? '').trim().toLowerCase();
  if (!/^[a-z][a-z0-9_]{1,30}$/.test(code)) {
    throw new HttpError(400,
      'কোড ছোট হাতের ইংরেজি অক্ষর দিয়ে শুরু হবে, ২–৩১ অক্ষর, শুধু অক্ষর সংখ্যা ও আন্ডারস্কোর',
      'invalid_code', { field: 'code' });
  }
  const nameBn = String(b.nameBn ?? '').trim();
  if (nameBn.length < 2 || nameBn.length > 80) {
    throw new HttpError(400, 'প্ল্যানের নাম ২–৮০ অক্ষরের মধ্যে লিখুন',
      'invalid_name', { field: 'nameBn' });
  }
  const cycle = String(b.billingCycle ?? 'yearly');
  if (!CYCLES.includes(cycle)) {
    throw new HttpError(400, `billing cycle must be one of: ${CYCLES.join(', ')}`,
      'invalid_cycle', { field: 'billingCycle' });
  }
  const price = Number(b.priceBdt);
  if (!Number.isFinite(price) || price < 0 || price > 99_999_999) {
    throw new HttpError(400, 'মূল্য শূন্য বা তার বেশি একটি সংখ্যা হতে হবে',
      'invalid_price', { field: 'priceBdt' });
  }
  const cap = Number(b.studentCap);
  if (!Number.isInteger(cap) || cap < 1) {
    throw new HttpError(400, 'শিক্ষার্থীর সীমা শূন্যের বেশি একটি পূর্ণ সংখ্যা হতে হবে',
      'invalid_cap', { field: 'studentCap' });
  }
  const trial = Number(b.trialDays ?? 30);
  const grace = Number(b.graceDays ?? 14);
  for (const [n, v, field] of [['ট্রায়াল', trial, 'trialDays'], ['ছাড়', grace, 'graceDays']] as const) {
    if (!Number.isInteger(v) || v < 0 || v > 365) {
      throw new HttpError(400, `${n} ০ থেকে ৩৬৫ দিনের মধ্যে হতে হবে`,
        'invalid_days', { field });
    }
  }

  // Only codes the catalogue knows. An unknown key here would sit in the
  // plan for ever meaning nothing, and `tenant_service_state` would read it
  // as "not in plan" for a service nobody can name.
  const wanted = b.services && typeof b.services === 'object' && !Array.isArray(b.services)
    ? Object.entries(b.services as Record<string, unknown>)
      .filter(([, v]) => v === true).map(([k]) => k)
    : [];
  const { rows: known } = await db.pool.query<{ code: string }>(
    `SELECT code FROM service_catalogue`);
  const catalogue = new Set(known.map((r) => r.code));
  const unknown = wanted.filter((c) => !catalogue.has(c));
  if (unknown.length > 0) {
    throw new HttpError(400, `অজানা সেবা: ${unknown.join(', ')}`,
      'unknown_service', { field: 'services', unknown });
  }
  const services = Object.fromEntries(wanted.map((c) => [c, true]));

  // How many schools this moves. Read BEFORE the write so the number is the
  // one the operator was shown, and returned so the screen can say it again.
  // Through the definer view, NOT `FROM tenants`: the platform role cannot
  // see that table (`tenant_self`), so a direct count here returned 0 while
  // the screen correctly showed 2 — and wrote "0 schools affected" into the
  // audit trail. Fourth time this phase that a silent zero impersonated an
  // answer; see migration 053.
  const { rows: usedBy } = await db.pool.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM app.platform_overview() WHERE plan_code = $1`,
    [code]);
  const affected = Number(usedBy[0]?.n ?? 0);

  const { rows: before } = await db.pool.query<Record<string, unknown>>(
    `SELECT price_bdt, student_cap, grace_days FROM plans WHERE code = $1`, [code]);

  const { rows } = await db.pool.query<Record<string, unknown>>(
    `INSERT INTO plans (code, name_bn, price_bdt, billing_cycle, student_cap,
                        services, trial_days, grace_days, is_active)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9)
     ON CONFLICT (code) DO UPDATE SET
       name_bn = EXCLUDED.name_bn, price_bdt = EXCLUDED.price_bdt,
       billing_cycle = EXCLUDED.billing_cycle, student_cap = EXCLUDED.student_cap,
       services = EXCLUDED.services, trial_days = EXCLUDED.trial_days,
       grace_days = EXCLUDED.grace_days, is_active = EXCLUDED.is_active
     RETURNING code, name_bn, price_bdt, billing_cycle, student_cap, services,
               trial_days, grace_days, is_active`,
    [code, nameBn, price, cycle, cap, JSON.stringify(services), trial, grace,
     b.isActive === false ? false : true]);

  const was = before[0];
  await db.pool.query(`SELECT app.log_platform_action($1, $2, $3, $4)`,
    [op.id, null, reason,
      was
        ? `plan ${code}: ${was.price_bdt}/${was.student_cap}/${was.grace_days}d → `
          + `${price}/${cap}/${grace}d, ${wanted.length} services, ${affected} schools affected`
        : `plan ${code} created: ${price}/${cap}/${grace}d, ${wanted.length} services`]);

  const r = rows[0];
  return {
    ok: true,
    created: !was,
    affected,
    plan: {
      code: r.code, nameBn: r.name_bn, priceBdt: String(r.price_bdt),
      billingCycle: r.billing_cycle, studentCap: r.student_cap,
      services: r.services, trialDays: r.trial_days, graceDays: r.grace_days,
      isActive: r.is_active,
    },
  };
}

async function setCap(db: Db, op: { id: string }, req: IncomingMessage) {
  const body = await readJson<Record<string, unknown>>(req);
  const id = requireTenantId(body.tenantId);
  const reason = requireReason(body.reason);
  const cap = Number(body.studentCap);
  if (!Number.isInteger(cap) || cap < 1) {
    throw new HttpError(400, 'সীমা একটি ধনাত্মক সংখ্যা হতে হবে', 'invalid_cap',
      { field: 'studentCap' });
  }
  // `tenants` is not writable by the platform role — `tenant_self` denies it,
  // and a direct UPDATE here reported success while changing nothing. The
  // definer function does the write, refuses a cap below the roll (§19 — "do
  // not corrupt existing records"), and writes its own audit row.
  try {
    await db.pool.query(`SELECT app.set_student_cap($1, $2, $3, $4)`,
      [op.id, id, cap, reason]);
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === '23514') {
      const { rows } = await db.pool.query<{ n: string }>(
        `SELECT student_count n FROM app.platform_operations($1)`, [id]);
      const enrolled = Number(rows[0]?.n ?? 0);
      throw new HttpError(409,
        `এই প্রতিষ্ঠানে এখন ${bn(enrolled)} জন শিক্ষার্থী আছে — সীমা তার কম করা যাবে না।`,
        'cap_below_enrolled', { enrolled });
    }
    if (code === '02000') throw new HttpError(404, 'no such tenant', 'not_found');
    throw err;
  }
  return afterChange(db, id);
}

/**
 * What the school looks like AFTER the change.
 *
 * Every operations endpoint returns this rather than `{ ok: true }`: the
 * console must render the consequence, and a console that re-fetches to find
 * out what it just did can show a state that is one request out of date.
 */
async function afterChange(db: Db, id: string) {
  const { rows } = await db.pool.query(
    `SELECT access, ops_state, billing_state, reason_bn, until,
            portals, services, next_due_on, grace_until, student_cap
       FROM app.platform_operations($1)`, [id]);
  const r = (rows[0] ?? {}) as Record<string, unknown>;
  return {
    ok: true,
    state: {
      access: r.access, opsState: r.ops_state, billingState: r.billing_state,
      reasonBn: r.reason_bn, until: r.until,
      portals: r.portals ?? {}, services: r.services ?? {},
      nextDueOn: r.next_due_on, graceUntil: r.grace_until,
      studentCap: r.student_cap,
    },
  };
}
