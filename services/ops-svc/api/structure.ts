/**
 * GET  /api/v1/ops/structure  — what a create form needs to offer
 * POST /api/v1/ops/structure  — create a class, a section, or an academic year
 *
 * R-3 completion pass. The gap R-3's own report named first: a school could
 * assign teachers to sections and move students between them, and could not
 * CREATE a section. Opening a seventh section mid-year still meant the pilot
 * runbook and a psql prompt.
 *
 * ── Three creates, one endpoint, because they are one workflow ──────────
 *     শিক্ষাবর্ষ → শ্রেণি → (বিভাগ) → সেকশন
 *
 * A school setting itself up does all three in one sitting, in that order,
 * and each one needs the previous one's id. Three endpoints would be three
 * round-trips and three chances for the client to hold a stale list.
 *
 * ── What the schema actually has, and what it does not ──────────────────
 * The brief asks for an academic year and an active/inactive flag on a class.
 * `classes` has neither: it is UNIQUE (tenant, level_no, stream, "group") and
 * carries no year and no is_active. That is correct — a class is a rung on a
 * ladder ("নবম শ্রেণি, বিজ্ঞান"), and it is the SECTION that belongs to a year.
 * A school does not create Class 9 again every January; it creates this
 * year's sections of it.
 *
 * So the year is asked for on the SECTION form, where the column exists, and
 * the class form does not offer a checkbox for a column that is not there. A
 * disabled field for a value nothing stores is worse than its absence: it
 * teaches the office that they set something.
 *
 * ── Authorization is the RLS policy, not this file ──────────────────────
 * Migration 042 adds the RESTRICTIVE write scopes these tables never had.
 * Before it, tenant isolation was complete and role scope was absent, so any
 * session in the school could have inserted a class. requireRole here is the
 * clean 403 in front of the policy, as everywhere else.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { sharedDb } from '../../../packages/server-core/src/db.ts';
import { corsHeaders, readJson, json, HttpError } from '../../../packages/server-core/src/http.ts';
import { authenticate, requireRole, requireStaff } from '../../../packages/server-core/src/auth.ts';
import { formatCount } from '../../../packages/ui-core/src/format.ts';
import { writeAudit } from '../../../packages/server-core/src/audit.ts';

/** Mirrors classes_insert_scope / sections_insert_scope in migration 042. */
const STRUCTURE_ROLES = ['principal', 'school_owner', 'academic_coordinator', 'it_admin'];

const STREAMS = new Set([
  'bangla_medium', 'english_version', 'english_medium', 'madrasah', 'technical',
]);
const GROUPS = new Set([
  'none', 'science', 'humanities', 'business_studies', 'vocational', 'general',
]);
const SHIFTS = new Set(['morning', 'day', 'evening', 'single']);

interface CreateBody {
  kind?: 'class' | 'section' | 'year';
  /** PATCH only: which row to correct. */
  id?: string;
  // class
  levelNo?: number | string;
  nameBn?: string;
  nameEn?: string;
  stream?: string;
  group?: string;
  displayOrder?: number | string;
  // section
  classId?: string;
  academicYearId?: string;
  name?: string;
  shift?: string;
  capacity?: number | string;
  // year
  label?: string;
  startsOn?: string;
  endsOn?: string;
  isCurrent?: boolean;
}

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const cors = corsHeaders([], 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }

  try {
    const claims = await authenticate(req);
    const db = await sharedDb();
    const ctx = { tenantId: claims.tid, userId: claims.sub, role: claims.role };

    if (req.method === 'GET') {
      // Any staff member may read the options — the tree itself is already
      // staff-readable, and a coordinator building a timetable needs them.
      requireStaff(claims);
      json(res, 200, await options(db, ctx), cors);
      return;
    }
    // B-6. PATCH corrects a name; POST creates. Same roles, same RLS scope
    // (migration 042 has allowed UPDATE on both tables since R-3) — what was
    // missing was any way for a person to reach it.
    if (req.method === 'PATCH') {
      requireRole(claims, STRUCTURE_ROLES);
      const body = await readJson<CreateBody>(req);
      switch (body.kind) {
        case 'class':   json(res, 200, await updateClass(db, ctx, body), cors); return;
        case 'section': json(res, 200, await updateSection(db, ctx, body), cors); return;
        default:
          throw new HttpError(400, 'kind must be class or section', 'bad_kind', { field: 'kind' });
      }
    }
    if (req.method !== 'POST') { json(res, 405, { error: 'method_not_allowed' }, cors); return; }

    requireRole(claims, STRUCTURE_ROLES);
    const body = await readJson<CreateBody>(req);

    switch (body.kind) {
      case 'class':   json(res, 200, await createClass(db, ctx, body), cors); return;
      case 'section': json(res, 200, await createSection(db, ctx, body), cors); return;
      case 'year':    json(res, 200, await createYear(db, ctx, body), cors); return;
      default:
        throw new HttpError(400, 'kind must be class, section or year', 'bad_kind', { field: 'kind' });
    }
  } catch (err) {
    if (err instanceof HttpError) {
      json(res, err.status, { error: err.code, message: err.message, ...(err.detail ?? {}) }, cors);
      return;
    }
    // A uniqueness collision is a user mistake with a readable cause, not a
    // 500. Naming which one is what stops the office trying again identically.
    const e = err as { code?: string; constraint?: string };
    if (e.code === '23505') {
      json(res, 409, {
        error: 'duplicate',
        message: e.constraint?.includes('sections')
          ? 'এই শ্রেণিতে এই নামের সেকশন এই শিফটে ইতিমধ্যে আছে।'
          : e.constraint?.includes('academic_years')
            ? 'এই নামের শিক্ষাবর্ষ ইতিমধ্যে আছে।'
            : 'এই শ্রেণি ও বিভাগের সমন্বয় ইতিমধ্যে আছে।',
      }, cors);
      return;
    }
    json(res, 500, { error: 'internal_error' }, cors);
  }
}

type Db = Awaited<ReturnType<typeof sharedDb>>;
type Ctx = { tenantId: string; userId: string; role: string };

/**
 * Everything a create form needs, in one read: the years to attach a section
 * to, the classes to put it in, and the institution's own stream — so the
 * class form can default to it rather than asking a Bangla-medium school to
 * pick "bangla_medium" from a list of five.
 */
async function options(db: Db, ctx: Ctx) {
  return db.withTenant(ctx, async (c) => {
    const { rows: tenant } = await c.query<{ stream: string }>(
      `SELECT stream::text AS stream FROM tenants`,
    );
    const { rows: years } = await c.query<{ id: string; label: string; is_current: boolean }>(
      `SELECT id, label, is_current FROM academic_years ORDER BY starts_on DESC`,
    );
    const { rows: classes } = await c.query<{
      id: string; level_no: number; name_bn: string; group: string;
    }>(
      `SELECT id, level_no, name_bn, "group"::text AS "group"
         FROM classes ORDER BY level_no, display_order, "group"`,
    );
    return {
      defaultStream: tenant[0]?.stream ?? 'bangla_medium',
      years: years.map((y) => ({ id: y.id, label: y.label, isCurrent: y.is_current })),
      classes: classes.map((cl) => ({
        id: cl.id, levelNo: cl.level_no, nameBn: cl.name_bn, group: cl.group,
      })),
      streams: [...STREAMS],
      groups: [...GROUPS],
      shifts: [...SHIFTS],
    };
  });
}

async function createClass(db: Db, ctx: Ctx, b: CreateBody) {
  const levelNo = Number(b.levelNo);
  if (!Number.isInteger(levelNo) || levelNo < 1 || levelNo > 12) {
    throw new HttpError(400, 'শ্রেণি ১ থেকে ১২-এর মধ্যে হতে হবে', 'bad_level', { field: 'levelNo' });
  }
  const nameBn = (b.nameBn ?? '').trim();
  if (!nameBn) throw new HttpError(400, 'বাংলা নাম লিখুন', 'bad_name', { field: 'nameBn' });
  const stream = (b.stream ?? '').trim();
  if (!STREAMS.has(stream)) {
    throw new HttpError(400, 'ধারা বেছে নিন', 'bad_stream', { field: 'stream' });
  }
  const group = (b.group ?? 'none').trim();
  if (!GROUPS.has(group)) {
    throw new HttpError(400, 'বিভাগ বেছে নিন', 'bad_group', { field: 'group' });
  }
  // `name_en` is NOT NULL — the same constraint that bit the create-user
  // endpoint. Fall back to the Bangla name rather than demanding a
  // transliteration before the form will submit.
  const nameEn = (b.nameEn ?? '').trim() || nameBn;
  const displayOrder = Number.isFinite(Number(b.displayOrder)) ? Number(b.displayOrder) : levelNo;

  return db.withTenant(ctx, async (c) => {
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO classes (tenant_id, level_no, name_bn, name_en, stream, "group", display_order)
       VALUES ($1, $2, $3, $4, $5::institution_stream, $6::academic_group, $7)
       RETURNING id`,
      [ctx.tenantId, levelNo, nameBn, nameEn, stream, group, displayOrder],
    );
    const id = rows[0].id;

    await writeAudit(c, ctx, {
      action: 'academic.class.create',
      entityType: 'class',
      entityId: id,
      after: { levelNo, nameBn, stream, group },
    });

    return { id, kind: 'class', levelNo, nameBn, nameEn, stream, group };
  });
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function requireId(b: CreateBody): string {
  const id = (b.id ?? '').trim();
  if (!UUID_RE.test(id)) throw new HttpError(400, 'id দরকার', 'bad_id', { field: 'id' });
  return id;
}

/**
 * Correct a class's NAME. Not its level, stream or group.
 *
 * Those three decide which subject template the class draws from, and every
 * enrolment, mark and result beneath it was derived on that basis. Changing
 * one after the fact does not migrate anything — it silently makes the
 * history wrong. A school that genuinely needs it needs the rollover tool.
 */
async function updateClass(db: Db, ctx: Ctx, b: CreateBody) {
  const id = requireId(b);
  const nameBn = (b.nameBn ?? '').trim();
  if (!nameBn) throw new HttpError(400, 'বাংলা নাম লিখুন', 'bad_name', { field: 'nameBn' });
  const nameEn = (b.nameEn ?? '').trim() || nameBn;
  const displayOrder = Number.isFinite(Number(b.displayOrder))
    ? Number(b.displayOrder) : undefined;

  return db.withTenant(ctx, async (c) => {
    const { rows: before } = await c.query<{
      name_bn: string; name_en: string; display_order: number;
    }>(`SELECT name_bn, name_en, display_order FROM classes WHERE id = $1`, [id]);
    // RLS makes another school's class invisible, so "not found" and "not
    // yours" are the same answer here — deliberately.
    if (before.length === 0) throw new HttpError(404, 'শ্রেণি পাওয়া যায়নি', 'class_not_found');

    const { rowCount } = await c.query(
      `UPDATE classes
          SET name_bn = $2, name_en = $3,
              display_order = COALESCE($4, display_order)
        WHERE id = $1`,
      [id, nameBn, nameEn, displayOrder ?? null],
    );
    // The UPDATE policy is RESTRICTIVE, so a role outside STRUCTURE_ROLES
    // matches no rows rather than raising. Zero rows after a successful SELECT
    // means RLS refused the write, and saying so beats reporting success.
    if (rowCount === 0) throw new HttpError(403, 'পরিবর্তনের অনুমতি নেই', 'forbidden');

    await writeAudit(c, ctx, {
      action: 'academic.class.update',
      entityType: 'class',
      entityId: id,
      before: { nameBn: before[0].name_bn, nameEn: before[0].name_en,
                displayOrder: before[0].display_order },
      after: { nameBn, nameEn, displayOrder: displayOrder ?? before[0].display_order },
    });
    return { id, kind: 'class', nameBn, nameEn };
  });
}

/**
 * Correct a section's name or capacity. Not its class or its year.
 *
 * Moving a section between classes moves every child enrolled in it, without
 * a single enrolment row changing — the roster would simply appear somewhere
 * else. That is the rollover tool's job, where it is explicit and audited per
 * student.
 */
async function updateSection(db: Db, ctx: Ctx, b: CreateBody) {
  const id = requireId(b);
  const name = (b.name ?? '').trim();
  if (!name) throw new HttpError(400, 'সেকশনের নাম লিখুন', 'bad_name', { field: 'name' });
  if (name.length > 20) throw new HttpError(400, 'নাম খুব বড়', 'bad_name', { field: 'name' });

  const capacity = Number(b.capacity);
  const hasCapacity = b.capacity !== undefined && b.capacity !== null && b.capacity !== '';
  if (hasCapacity && (!Number.isInteger(capacity) || capacity < 1 || capacity > 300)) {
    throw new HttpError(400, 'ধারণক্ষমতা ১ থেকে ৩০০-এর মধ্যে দিন', 'bad_capacity',
      { field: 'capacity' });
  }

  return db.withTenant(ctx, async (c) => {
    const { rows: before } = await c.query<{
      name: string; capacity: number; student_count: number;
    }>(`SELECT name, capacity, student_count FROM sections WHERE id = $1`, [id]);
    if (before.length === 0) throw new HttpError(404, 'সেকশন পাওয়া যায়নি', 'section_not_found');

    // A capacity below the children already in the room is not a typo the
    // office wants saved silently; the enrolment cap reads this column.
    if (hasCapacity && capacity < before[0].student_count) {
      throw new HttpError(400,
        // Bangla digits here too. The message is read by the same person, on
        // the same screen, immediately under a helper that says it in Bangla.
        `এই শাখায় এখন ${formatCount(before[0].student_count, 'bn')} জন শিক্ষার্থী আছে — `
        + 'ধারণক্ষমতা তার কম দেওয়া যাবে না',
        'capacity_below_enrolled', { field: 'capacity' });
    }

    const { rowCount } = await c.query(
      `UPDATE sections
          SET name = $2, capacity = COALESCE($3, capacity)
        WHERE id = $1`,
      [id, name, hasCapacity ? capacity : null],
    );
    if (rowCount === 0) throw new HttpError(403, 'পরিবর্তনের অনুমতি নেই', 'forbidden');

    await writeAudit(c, ctx, {
      action: 'academic.section.update',
      entityType: 'section',
      entityId: id,
      before: { name: before[0].name, capacity: before[0].capacity },
      after: { name, capacity: hasCapacity ? capacity : before[0].capacity },
    });
    return { id, kind: 'section', name, capacity: hasCapacity ? capacity : before[0].capacity };
  });
}

async function createSection(db: Db, ctx: Ctx, b: CreateBody) {
  const classId = (b.classId ?? '').trim();
  const yearId = (b.academicYearId ?? '').trim();
  const name = (b.name ?? '').trim();
  if (!classId) throw new HttpError(400, 'শ্রেণি বেছে নিন', 'bad_class', { field: 'classId' });
  if (!yearId) throw new HttpError(400, 'শিক্ষাবর্ষ বেছে নিন', 'bad_year', { field: 'academicYearId' });
  if (!name) throw new HttpError(400, 'সেকশনের নাম লিখুন', 'bad_name', { field: 'name' });
  if (name.length > 20) {
    throw new HttpError(400, 'নাম খুব বড়', 'bad_name', { field: 'name' });
  }
  const shift = (b.shift ?? 'morning').trim();
  if (!SHIFTS.has(shift)) throw new HttpError(400, 'শিফট বেছে নিন', 'bad_shift', { field: 'shift' });

  const capacity = Number(b.capacity ?? 60);
  if (!Number.isInteger(capacity) || capacity < 1 || capacity > 300) {
    throw new HttpError(400, 'ধারণক্ষমতা ১ থেকে ৩০০-এর মধ্যে দিন', 'bad_capacity', { field: 'capacity' });
  }

  return db.withTenant(ctx, async (c) => {
    // RLS makes another school's class invisible, so this catches the
    // ordinary mistake and reports it as a 404 rather than a foreign-key
    // error the office cannot read.
    const { rows: cls } = await c.query<{ name_bn: string; group: string }>(
      `SELECT name_bn, "group"::text AS "group" FROM classes WHERE id = $1`, [classId],
    );
    if (cls.length === 0) throw new HttpError(404, 'শ্রেণি পাওয়া যায়নি', 'class_not_found');

    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO sections (tenant_id, class_id, academic_year_id, name, shift, capacity)
       VALUES ($1, $2, $3, $4, $5::shift_code, $6)
       RETURNING id`,
      [ctx.tenantId, classId, yearId, name, shift, capacity],
    );
    const id = rows[0].id;

    await writeAudit(c, ctx, {
      action: 'academic.section.create',
      entityType: 'section',
      entityId: id,
      after: { name, classId, yearId, shift, capacity },
    });

    return {
      id, kind: 'section', name, shift, capacity,
      classNameBn: cls[0].name_bn, group: cls[0].group,
    };
  });
}

/**
 * A school's first act. Without a year there are no sections, so the
 * hierarchy screen's empty state offers this rather than dead-ending.
 */
async function createYear(db: Db, ctx: Ctx, b: CreateBody) {
  const label = (b.label ?? '').trim();
  if (!label) throw new HttpError(400, 'শিক্ষাবর্ষের নাম লিখুন', 'bad_label', { field: 'label' });
  const startsOn = (b.startsOn ?? '').trim();
  const endsOn = (b.endsOn ?? '').trim();
  for (const [v, field] of [[startsOn, 'startsOn'], [endsOn, 'endsOn']] as [string, string][]) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) {
      throw new HttpError(400, 'তারিখ দিন', 'bad_date', { field });
    }
  }
  if (endsOn <= startsOn) {
    throw new HttpError(400, 'শেষের তারিখ শুরুর পরে হতে হবে', 'bad_range', { field: 'endsOn' });
  }

  return db.withTenant(ctx, async (c) => {
    // `academic_years.is_current` has no unique index, so two current years
    // are possible in the schema. Every reader picks
    // `ORDER BY is_current DESC, starts_on DESC LIMIT 1`, which would then be
    // arbitrary. Clearing the old one here keeps the answer single.
    if (b.isCurrent) {
      await c.query(`UPDATE academic_years SET is_current = false WHERE is_current`);
    }
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO academic_years (tenant_id, label, starts_on, ends_on, is_current)
       VALUES ($1, $2, $3::date, $4::date, $5)
       RETURNING id`,
      [ctx.tenantId, label, startsOn, endsOn, b.isCurrent === true],
    );
    const id = rows[0].id;

    await writeAudit(c, ctx, {
      action: 'academic.year.create',
      entityType: 'academic_year',
      entityId: id,
      after: { label, startsOn, endsOn, isCurrent: b.isCurrent === true },
    });

    return { id, kind: 'year', label, startsOn, endsOn, isCurrent: b.isCurrent === true };
  });
}
