/**
 * GET    /api/v1/ops/calendar?from=&to=  — everything happening in a range
 * POST   /api/v1/ops/calendar            — create an entry (optionally notify)
 * PATCH  /api/v1/ops/calendar            — edit one
 * DELETE /api/v1/ops/calendar?id=        — withdraw one
 *
 * R-4 of docs/11-MASTER-PLAN.md. `calendar_days` has existed since migration
 * 003 and has never had a screen, while already being load-bearing: sms-svc
 * reads it twice to suppress attendance and notice SMS on holidays. A row in
 * this table already stops messages reaching nine hundred guardians.
 *
 * ── Exams are read, never copied ────────────────────────────────────────
 * The response merges three sources and only ONE of them is this table:
 *
 *   calendar_days      — holidays, events, meetings, closures (writable here)
 *   exams              — the exam period, from `exams.starts_on/ends_on`
 *   exam_subjects      — each paper, from `exam_subjects.exam_date`
 *
 * The exam rows come back flagged `source: 'exam'` and `editable: false`. They
 * are computed at read time from the authoritative tables, so a coordinator
 * who moves a paper moves it on the calendar too, with nothing to
 * re-synchronise. Writing an exam into `calendar_days` would have created a
 * second source of truth that goes stale the first time a date changes —
 * which is the failure mode this endpoint exists to avoid, not to introduce.
 *
 * ── The weekend comes from the tenant ───────────────────────────────────
 * `tenants.weekend_days` is a smallint[] (0=Sun … 6=Sat) defaulting to {5,6}.
 * Many Madrasah run {5}. The response carries it so the month view can shade
 * the right days, and nothing in this file or the UI hardcodes Friday.
 *
 * ── Authorization ───────────────────────────────────────────────────────
 * READS are open to every signed-in member of the institution, including
 * students and guardians — a school calendar that guardians cannot see is not
 * a school calendar. WRITES are the four structural roles, enforced by
 * migration 043's RESTRICTIVE policies with requireRole as the clean 403 in
 * front of them.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { sharedDb } from '../../../packages/server-core/src/db.ts';
import { corsHeaders, readJson, json, query, HttpError } from '../../../packages/server-core/src/http.ts';
import { authenticate, requireRole } from '../../../packages/server-core/src/auth.ts';
import { writeAudit } from '../../../packages/server-core/src/audit.ts';

/** Mirrors calendar_{insert,update,delete}_scope in migration 043. */
const CALENDAR_WRITERS = ['principal', 'school_owner', 'academic_coordinator', 'it_admin'];

/** The `kind` CHECK on calendar_days, unchanged since 003. */
const KINDS = new Set(['holiday', 'exam', 'event', 'ramadan_schedule', 'working_weekend']);
const SHIFTS = new Set(['morning', 'day', 'evening', 'single']);

const MAX_TITLE = 120;
const MAX_DESCRIPTION = 2000;
/** A year and a bit. Enough for any view; bounded so one request cannot scan a decade. */
const MAX_RANGE_DAYS = 400;

interface CalendarBody {
  id?: string;
  academicYearId?: string;
  day?: string;
  kind?: string;
  titleBn?: string;
  descriptionBn?: string;
  appliesToShifts?: string[] | null;
  /** Publish a notice about this entry, through R-2. Never a second pipeline. */
  notify?: boolean;
  sendSms?: boolean;
}

function parseDay(raw: string | undefined, field: string): string {
  if (!raw || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    throw new HttpError(400, 'তারিখ দিন', 'bad_date', { field });
  }
  const d = new Date(`${raw}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== raw) {
    throw new HttpError(400, 'এই তারিখটি নেই', 'bad_date', { field });
  }
  return raw;
}

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const cors = corsHeaders([], 'GET, POST, PATCH, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }

  try {
    const claims = await authenticate(req);
    const db = await sharedDb();
    const ctx = { tenantId: claims.tid, userId: claims.sub, role: claims.role };

    // No requireStaff on the read: the calendar is the one management-adjacent
    // screen every role legitimately needs. A guardian planning around ঈদের
    // ছুটি is the whole point of publishing one.
    if (req.method === 'GET') { json(res, 200, await read(db, ctx, req), cors); return; }

    requireRole(claims, CALENDAR_WRITERS);
    if (req.method === 'POST')   { json(res, 200, await create(db, ctx, req), cors); return; }
    if (req.method === 'PATCH')  { json(res, 200, await update(db, ctx, req), cors); return; }
    if (req.method === 'DELETE') { json(res, 200, await remove(db, ctx, req), cors); return; }

    json(res, 405, { error: 'method_not_allowed' }, cors);
  } catch (err) {
    if (err instanceof HttpError) {
      json(res, err.status, { error: err.code, message: err.message, ...(err.detail ?? {}) }, cors);
      return;
    }
    const e = err as { code?: string };
    if (e.code === '23505') {
      json(res, 409, {
        error: 'duplicate',
        message: 'এই দিনে এই নামের একটি এন্ট্রি ইতিমধ্যে আছে।',
      }, cors);
      return;
    }
    json(res, 500, { error: 'internal_error' }, cors);
  }
}

type Db = Awaited<ReturnType<typeof sharedDb>>;
type Ctx = { tenantId: string; userId: string; role: string };

// ── Read ────────────────────────────────────────────────────────────────

async function read(db: Db, ctx: Ctx, req: IncomingMessage) {
  const q = query(req);
  const kindFilter = (q.get('kind') ?? '').trim();
  if (kindFilter && !KINDS.has(kindFilter)) {
    throw new HttpError(400, 'unknown kind', 'bad_kind', { field: 'kind' });
  }

  // Default to the month around today when the client asks for nothing —
  // the first paint of the calendar should not need two round-trips.
  const today = new Date();
  const defFrom = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
  const defTo = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 0));
  const from = q.get('from') ? parseDay(q.get('from') ?? '', 'from') : defFrom.toISOString().slice(0, 10);
  const to = q.get('to') ? parseDay(q.get('to') ?? '', 'to') : defTo.toISOString().slice(0, 10);
  if (to < from) throw new HttpError(400, 'শেষের তারিখ শুরুর পরে হতে হবে', 'bad_range', { field: 'to' });
  const span = (Date.parse(to) - Date.parse(from)) / 86_400_000;
  if (span > MAX_RANGE_DAYS) {
    throw new HttpError(400, 'একবারে সর্বোচ্চ এক বছরের তথ্য দেখা যায়', 'range_too_wide', { field: 'to' });
  }

  return db.withTenant(ctx, async (c) => {
    // The institution's own weekend, and its shifts. Nothing downstream
    // hardcodes Friday; a Madrasah on {5} shades one day and a school on
    // {5,6} shades two.
    const { rows: tenant } = await c.query<{ weekend_days: number[]; shifts: string[] }>(
      `SELECT weekend_days, shifts FROM tenants`,
    );

    const { rows: years } = await c.query<{
      id: string; label: string; is_current: boolean; starts_on: string; ends_on: string;
    }>(
      `SELECT id, label, is_current, starts_on::text, ends_on::text
         FROM academic_years ORDER BY starts_on DESC`,
    );
    const currentYear = years.find((y) => y.is_current) ?? years[0] ?? null;

    const { rows: entries } = await c.query<{
      id: string; day: string; kind: string; title_bn: string;
      description_bn: string | null; applies_to_shifts: string[] | null;
      academic_year_id: string; year_label: string;
      created_by: string | null; created_by_name: string | null;
    }>(
      `SELECT cd.id, cd.day::text, cd.kind, cd.title_bn, cd.description_bn,
              cd.applies_to_shifts::text[] AS applies_to_shifts,
              cd.academic_year_id, ay.label AS year_label,
              cd.created_by, u.full_name_bn AS created_by_name
         FROM calendar_days cd
         JOIN academic_years ay ON ay.id = cd.academic_year_id
         LEFT JOIN users u ON u.id = cd.created_by
        WHERE cd.day BETWEEN $1::date AND $2::date
          AND ($3 = '' OR cd.kind = $3)
        ORDER BY cd.day, cd.kind, cd.title_bn`,
      [from, to, kindFilter],
    );

    // ── The authoritative exam sources, read not copied ──────────────
    // An exam PERIOD (exams.starts_on … ends_on) and the individual PAPERS
    // (exam_subjects.exam_date) are different things and a school wants both:
    // "অর্ধবার্ষিক পরীক্ষা চলছে" across a fortnight, and "পদার্থবিজ্ঞান" on the
    // Tuesday. Both come back read-only.
    const wantExams = !kindFilter || kindFilter === 'exam';
    const examEntries: {
      id: string; day: string; kind: string; titleBn: string;
      descriptionBn: string | null; source: string; editable: boolean;
      appliesToShifts: string[] | null;
    }[] = [];

    if (wantExams) {
      const { rows: papers } = await c.query<{
        exam_subject_id: string; exam_date: string; subject_bn: string;
        exam_name_bn: string; section_name: string | null; class_bn: string | null;
      }>(
        `SELECT es.id AS exam_subject_id, es.exam_date::text, sub.name_bn AS subject_bn,
                e.name_bn AS exam_name_bn, s.name AS section_name, cl.name_bn AS class_bn
           FROM exam_subjects es
           JOIN exams e     ON e.id = es.exam_id
           JOIN subjects sub ON sub.id = es.subject_id
           LEFT JOIN sections s ON s.id = es.section_id
           LEFT JOIN classes cl ON cl.id = s.class_id
          WHERE es.exam_date BETWEEN $1::date AND $2::date
          ORDER BY es.exam_date, sub.name_bn`,
        [from, to],
      );
      for (const p of papers) {
        examEntries.push({
          id: `exam-subject:${p.exam_subject_id}`,
          day: p.exam_date,
          kind: 'exam',
          titleBn: `${p.exam_name_bn} — ${p.subject_bn}`,
          descriptionBn: p.class_bn && p.section_name
            ? `${p.class_bn} · সেকশন ${p.section_name}`
            : null,
          source: 'exam',
          editable: false,
          appliesToShifts: null,
        });
      }

      const { rows: periods } = await c.query<{
        id: string; name_bn: string; starts_on: string; ends_on: string; status: string;
      }>(
        `SELECT id, name_bn, starts_on::text, ends_on::text, status::text AS status
           FROM exams
          WHERE starts_on <= $2::date AND ends_on >= $1::date`,
        [from, to],
      );
      for (const p of periods) {
        examEntries.push({
          id: `exam:${p.id}`,
          day: p.starts_on,
          kind: 'exam',
          titleBn: p.name_bn,
          descriptionBn: p.starts_on === p.ends_on
            ? null
            : `${p.starts_on} — ${p.ends_on}`,
          source: 'exam',
          editable: false,
          appliesToShifts: null,
        });
      }
    }

    return {
      range: { from, to },
      // The tenant's own configuration, never a constant in the client.
      weekendDays: tenant[0]?.weekend_days ?? [5, 6],
      shifts: tenant[0]?.shifts ?? ['single'],
      years: years.map((y) => ({
        id: y.id, label: y.label, isCurrent: y.is_current,
        startsOn: y.starts_on, endsOn: y.ends_on,
      })),
      currentYearId: currentYear?.id ?? null,
      entries: [
        ...entries.map((e) => ({
          id: e.id,
          day: e.day,
          kind: e.kind,
          titleBn: e.title_bn,
          descriptionBn: e.description_bn,
          appliesToShifts: e.applies_to_shifts,
          academicYearId: e.academic_year_id,
          yearLabel: e.year_label,
          createdByNameBn: e.created_by_name,
          source: 'calendar',
          editable: true,
        })),
        ...examEntries,
      ].sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0)),
    };
  });
}

// ── Write ───────────────────────────────────────────────────────────────

function validate(b: CalendarBody, partial = false): {
  day?: string; kind?: string; titleBn?: string;
  descriptionBn?: string | null; shifts?: string[] | null;
} {
  const out: Record<string, unknown> = {};

  if (!partial || b.day !== undefined) out.day = parseDay(b.day, 'day');

  if (!partial || b.kind !== undefined) {
    const kind = (b.kind ?? '').trim();
    if (!KINDS.has(kind)) throw new HttpError(400, 'ধরন বেছে নিন', 'bad_kind', { field: 'kind' });
    out.kind = kind;
  }

  if (!partial || b.titleBn !== undefined) {
    const title = (b.titleBn ?? '').trim();
    if (!title) throw new HttpError(400, 'শিরোনাম লিখুন', 'bad_title', { field: 'titleBn' });
    if (title.length > MAX_TITLE) {
      throw new HttpError(400, `শিরোনাম সর্বোচ্চ ${MAX_TITLE} অক্ষর`, 'bad_title', { field: 'titleBn' });
    }
    out.titleBn = title;
  }

  if (b.descriptionBn !== undefined) {
    const d = (b.descriptionBn ?? '').trim();
    if (d.length > MAX_DESCRIPTION) {
      throw new HttpError(400, 'বিবরণ খুব বড়', 'bad_description', { field: 'descriptionBn' });
    }
    out.descriptionBn = d || null;
  }

  if (b.appliesToShifts !== undefined) {
    const shifts = b.appliesToShifts;
    if (shifts === null || shifts.length === 0) {
      // NULL means "all shifts", which is what an empty selection means to a
      // person. Storing an empty array would mean "no shifts", i.e. nobody.
      out.shifts = null;
    } else {
      for (const s of shifts) {
        if (!SHIFTS.has(s)) throw new HttpError(400, 'শিফট ভুল', 'bad_shift', { field: 'appliesToShifts' });
      }
      out.shifts = shifts;
    }
  }

  return out as ReturnType<typeof validate>;
}

/**
 * The academic year an entry belongs to, derived from its date rather than
 * trusted from the client.
 *
 * A calendar entry for 3 January belongs to the year that contains 3 January,
 * and no screen should be able to file it under a different one — the SMS
 * suppression and the attendance reader both scope by year, so a misfiled
 * holiday is a day the school thinks is a holiday and the system does not.
 */
async function yearFor(
  c: { query: (q: string, p?: unknown[]) => Promise<{ rows: { id: string }[] }> },
  day: string,
  requested: string | undefined,
): Promise<string> {
  const { rows } = await c.query(
    `SELECT id FROM academic_years
      WHERE $1::date BETWEEN starts_on AND ends_on
      ORDER BY is_current DESC, starts_on DESC LIMIT 1`,
    [day],
  );
  if (rows[0]) return rows[0].id;

  // No year covers it. Rather than inventing one, refuse and say so — a
  // school planning next year's calendar needs to create next year first,
  // which is a screen R-3's completion pass added.
  throw new HttpError(400,
    'এই তারিখ কোনো শিক্ষাবর্ষের মধ্যে পড়ে না — আগে শিক্ষাবর্ষ তৈরি করুন',
    'no_academic_year', { field: 'day', requested: requested ?? null });
}

/**
 * Tell the school, through R-2 — never a second pipeline.
 *
 * `app.emit_auto_notice` is the same function the exam-routine, results and
 * invoice emitters use, idempotent on (tenant, source_kind, source_ref), so a
 * double-submitted form announces nothing twice and an edit that re-notifies
 * reuses the same notice rather than sending a second one.
 */
async function notifyAbout(
  c: { query: (q: string, p?: unknown[]) => Promise<{ rows: { recipients: number }[] }> },
  entryId: string,
  kind: string,
  titleBn: string,
  descriptionBn: string | null,
  day: string,
  sendSms: boolean,
): Promise<number> {
  // A closure and a holiday are 'general' news to the institution; an exam
  // date is exam news. The category drives the icon and the guardian's
  // filter, so it is worth getting right rather than defaulting.
  const category = kind === 'exam' ? 'exam' : 'general';
  const body = [descriptionBn, `তারিখ: ${day}`].filter(Boolean).join('\n\n');
  const { rows } = await c.query(
    `SELECT recipients FROM app.emit_auto_notice(
       'calendar', $1::uuid, $2, $3, $4::notice_category, '{"type":"all"}'::jsonb, $5)`,
    [entryId, titleBn, body, category, sendSms],
  );
  return rows[0]?.recipients ?? 0;
}

async function create(db: Db, ctx: Ctx, req: IncomingMessage) {
  const b = await readJson<CalendarBody>(req);
  const v = validate(b);

  return db.withTenant(ctx, async (c) => {
    const yearId = await yearFor(c, v.day!, b.academicYearId);

    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO calendar_days
         (tenant_id, academic_year_id, day, kind, title_bn, description_bn,
          applies_to_shifts, created_by)
       VALUES ($1, $2, $3::date, $4, $5, $6, $7::shift_code[], $8)
       RETURNING id`,
      [ctx.tenantId, yearId, v.day, v.kind, v.titleBn,
       v.descriptionBn ?? null, v.shifts ?? null, ctx.userId],
    );
    const id = rows[0].id;

    let notified = 0;
    if (b.notify) {
      notified = await notifyAbout(c, id, v.kind!, v.titleBn!, v.descriptionBn ?? null,
                                   v.day!, b.sendSms === true);
    }

    await writeAudit(c, ctx, {
      action: 'academic.calendar.create',
      entityType: 'calendar_day',
      entityId: id,
      after: { day: v.day, kind: v.kind, titleBn: v.titleBn, notified },
    });

    return { id, day: v.day, kind: v.kind, titleBn: v.titleBn, notified };
  });
}

async function update(db: Db, ctx: Ctx, req: IncomingMessage) {
  const b = await readJson<CalendarBody>(req);
  const id = (b.id ?? '').trim();
  if (!id) throw new HttpError(400, 'id is required', 'bad_request', { field: 'id' });
  const v = validate(b, true);

  return db.withTenant(ctx, async (c) => {
    const { rows: before } = await c.query<{
      day: string; kind: string; title_bn: string; description_bn: string | null;
    }>(
      `SELECT day::text, kind, title_bn, description_bn FROM calendar_days WHERE id = $1`,
      [id],
    );
    // Invisible and absent are the same answer: an id from another school
    // must not be distinguishable from a typo.
    if (before.length === 0) throw new HttpError(404, 'এন্ট্রি পাওয়া যায়নি', 'not_found');
    const prev = before[0];

    const day = v.day ?? prev.day;
    const yearId = await yearFor(c, day, b.academicYearId);

    const { rows } = await c.query<{ id: string }>(
      // COALESCE on the parameters, so a PATCH carrying one field does not
      // blank the others. `descriptionBn` is deliberately handled by the
      // separate $5 flag: null there means "clear it", absent means "leave it".
      `UPDATE calendar_days
          SET day = $2::date,
              academic_year_id = $3,
              kind = COALESCE($4, kind),
              title_bn = COALESCE($5, title_bn),
              description_bn = CASE WHEN $6 THEN $7 ELSE description_bn END,
              applies_to_shifts = CASE WHEN $8 THEN $9::shift_code[] ELSE applies_to_shifts END
        WHERE id = $1
      RETURNING id`,
      [id, day, yearId, v.kind ?? null, v.titleBn ?? null,
       b.descriptionBn !== undefined, v.descriptionBn ?? null,
       b.appliesToShifts !== undefined, v.shifts ?? null],
    );
    // RLS refused the UPDATE: visible to read, not writable by this caller.
    if (rows.length === 0) {
      throw new HttpError(403, 'এই এন্ট্রি পরিবর্তনের অনুমতি আপনার নেই', 'forbidden');
    }

    let notified = 0;
    if (b.notify) {
      notified = await notifyAbout(c, id, v.kind ?? prev.kind, v.titleBn ?? prev.title_bn,
                                   v.descriptionBn ?? prev.description_bn, day,
                                   b.sendSms === true);
    }

    await writeAudit(c, ctx, {
      action: 'academic.calendar.update',
      entityType: 'calendar_day',
      entityId: id,
      before: { day: prev.day, kind: prev.kind, titleBn: prev.title_bn },
      after: { day, kind: v.kind ?? prev.kind, titleBn: v.titleBn ?? prev.title_bn, notified },
    });

    return { id, day, notified };
  });
}

async function remove(db: Db, ctx: Ctx, req: IncomingMessage) {
  const id = (query(req).get('id') ?? '').trim();
  if (!id) throw new HttpError(400, 'id is required', 'bad_request', { field: 'id' });

  return db.withTenant(ctx, async (c) => {
    const { rows: before } = await c.query<{ day: string; kind: string; title_bn: string }>(
      `SELECT day::text, kind, title_bn FROM calendar_days WHERE id = $1`, [id],
    );
    if (before.length === 0) throw new HttpError(404, 'এন্ট্রি পাওয়া যায়নি', 'not_found');

    const { rowCount } = await c.query(`DELETE FROM calendar_days WHERE id = $1`, [id]);
    if (!rowCount) {
      throw new HttpError(403, 'এই এন্ট্রি মুছে ফেলার অনুমতি আপনার নেই', 'forbidden');
    }

    // The entry is gone; the audit row is what remains of it. This is the
    // reason DELETE is permitted here and forbidden on classes and sections
    // (042): nothing references a calendar entry, so the log is a sufficient
    // record of its removal.
    await writeAudit(c, ctx, {
      action: 'academic.calendar.delete',
      entityType: 'calendar_day',
      entityId: id,
      before: { day: before[0].day, kind: before[0].kind, titleBn: before[0].title_bn },
    });

    return { id, deleted: true };
  });
}
