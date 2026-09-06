/**
 * GET  /api/v1/rms/setup?yearId=…            → readiness across every step
 * GET  /api/v1/rms/setup?yearId=…&step=…     → one step's data
 * POST /api/v1/rms/setup { yearId, step, … } → write one step
 *
 * The routine setup wizard's server half. Three of its steps are writers for
 * tables that had none, which is what kept P9 PARTIAL: bell times, subject
 * demand, and teacher availability.
 *
 * ── Readiness is computed HERE, once ─────────────────────────────────────
 * The wizard's whole promise is that nobody reaches Generate without knowing
 * what is missing, and a count computed in the browser can disagree with the
 * database the moment two people edit at once. So every step reports
 * `{ state, done, total, detail }` from one query set, and the browser
 * renders what it is told. P9-1 established this for assignments; this
 * extends it to the other five.
 *
 * `state` is deliberately three-valued and not a boolean:
 *
 *   ok        this step will not stop a generation run
 *   warn      generation will work and the result will be poorer — no
 *             availability recorded, no rooms with the capability a
 *             practical subject asks for
 *   blocked   generation cannot produce a usable routine at all
 *
 * A wizard that only said "incomplete" would make a school chase optional
 * work before a first run, which is the opposite of a one-minute promise.
 *
 * ── What this endpoint deliberately does NOT own ─────────────────────────
 * Working days. `tenants.weekend_days` is PLATFORM-owned: migration 069's
 * trigger refuses it from a school account by name, with its reason recorded
 * ("plan, cap, lifecycle, slug, weekend, shifts and key material are set by
 * the platform, not by a school account"). P9-2 preserves that decision
 * rather than quietly moving ownership — the wizard shows the value, says who
 * manages it, and offers no control. A step that silently gained the power to
 * change it would be a privilege escalation dressed as a convenience.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type pg from 'pg';
import { sharedDb } from '../../../packages/server-core/src/db.ts';
import { corsHeaders, readJson, json, HttpError } from '../../../packages/server-core/src/http.ts';
import { authenticate, requireRole } from '../../../packages/server-core/src/auth.ts';

type Client = pg.PoolClient;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/** The three roles that may author a routine, and therefore its inputs. */
const SETUP_ROLES = ['principal', 'school_owner', 'academic_coordinator'];
/**
 * Availability is the one step a department head may write: every row names
 * one teacher, so there is no school-wide blast radius, and a head of
 * department is who actually knows about a Thursday clinic.
 */
const AVAILABILITY_ROLES = [...SETUP_ROLES, 'dept_head'];

const BN_DIGITS = '০১২৩৪৫৬৭৮৯';
const bn = (n: number): string => String(n).replace(/[0-9]/g, (d) => BN_DIGITS[Number(d)]);

/** `period_kind`, as the enum defines it. */
const PERIOD_KINDS = ['teaching', 'assembly', 'tiffin', 'prayer', 'games', 'study', 'break'];
/** `teacher_availability.kind`, as its CHECK defines it. */
const AVAILABILITY_KINDS = ['unavailable', 'preferred', 'admin_duty'];

const DAY_BN = ['রবি', 'সোম', 'মঙ্গল', 'বুধ', 'বৃহস্পতি', 'শুক্র', 'শনি'];

type StepState = 'ok' | 'warn' | 'blocked';
interface StepReport {
  id: string;
  titleBn: string;
  state: StepState;
  /** One sentence a person can act on. Never "invalid configuration". */
  detailBn: string;
  done: number;
  total: number;
}

/* ─────────────────────────────── readiness ──────────────────────────── */

async function readiness(c: Client, yearId: string): Promise<{
  steps: StepReport[]; canGenerate: boolean; weekend: { days: number[]; managedBy: string };
}> {
  const steps: StepReport[] = [];

  // ── Working days. Read-only, and said so. ──────────────────────────
  const { rows: ten } = await c.query<{ weekend_days: number[] }>(
    'SELECT weekend_days FROM tenants WHERE id = app.current_tenant()');
  const weekendDays = ten[0]?.weekend_days ?? [5, 6];
  const teaching = [0, 1, 2, 3, 4, 5, 6].filter((d) => !weekendDays.includes(d));
  steps.push({
    id: 'workingdays',
    titleBn: 'সাপ্তাহিক কর্মদিবস',
    state: teaching.length > 0 ? 'ok' : 'blocked',
    detailBn: teaching.length > 0
      ? `সপ্তাহে ${bn(teaching.length)} দিন ক্লাস — ${teaching.map((d) => DAY_BN[d]).join(', ')}`
      : 'কোনো কর্মদিবস নেই — shikhonBD-এর সঙ্গে যোগাযোগ করুন',
    done: teaching.length, total: 7,
  });

  // ── Bell times ─────────────────────────────────────────────────────
  const { rows: periods } = await c.query<{
    template_id: string; teaching_periods: string; total_periods: string; name_bn: string;
  }>(
    `SELECT pt.id AS template_id, pt.name_bn,
            count(*) FILTER (WHERE pd.kind = 'teaching')::text AS teaching_periods,
            count(*)::text AS total_periods
       FROM period_templates pt
       LEFT JOIN period_definitions pd ON pd.template_id = pt.id
      WHERE pt.is_active
      GROUP BY pt.id, pt.name_bn
      ORDER BY pt.name_bn`);
  const teachingPeriods = periods.reduce((n, r) => n + Number(r.teaching_periods), 0);
  steps.push({
    id: 'periods',
    titleBn: 'পিরিয়ড ও বিরতি',
    state: teachingPeriods > 0 ? 'ok' : 'blocked',
    detailBn: teachingPeriods > 0
      ? `প্রতিদিন ${bn(Number(periods[0]?.teaching_periods ?? 0))}টি ক্লাস পিরিয়ড`
        + (periods.length > 1 ? ` · ${bn(periods.length)}টি শিফট` : '')
      : 'কোনো পিরিয়ড নির্ধারণ করা হয়নি — রুটিন তৈরি করা যাবে না',
    done: teachingPeriods, total: teachingPeriods || 1,
  });

  // ── Academic structure ─────────────────────────────────────────────
  const { rows: struct } = await c.query<{ classes: string; sections: string }>(
    `SELECT count(DISTINCT s.class_id)::text AS classes, count(*)::text AS sections
       FROM sections s WHERE s.academic_year_id = $1`, [yearId]);
  const sections = Number(struct[0]?.sections ?? 0);
  steps.push({
    id: 'structure',
    titleBn: 'শ্রেণি ও শাখা',
    state: sections > 0 ? 'ok' : 'blocked',
    detailBn: sections > 0
      ? `${bn(Number(struct[0].classes))}টি শ্রেণি · ${bn(sections)}টি শাখা`
      : 'এই শিক্ষাবর্ষে কোনো শাখা নেই',
    done: sections, total: sections || 1,
  });

  // ── Subject demand ─────────────────────────────────────────────────
  const { rows: demand } = await c.query<{ subjects: string; zero: string; weekly: string }>(
    `SELECT count(*)::text AS subjects,
            count(*) FILTER (WHERE cs.periods_per_week = 0)::text AS zero,
            COALESCE(sum(cs.periods_per_week), 0)::text AS weekly
       FROM class_subjects cs
      WHERE cs.academic_year_id = $1`, [yearId]);
  const subjects = Number(demand[0]?.subjects ?? 0);
  const zero = Number(demand[0]?.zero ?? 0);
  steps.push({
    id: 'demand',
    titleBn: 'বিষয় ও সাপ্তাহিক পিরিয়ড',
    state: subjects === 0 ? 'blocked' : zero > 0 ? 'warn' : 'ok',
    detailBn: subjects === 0
      ? 'কোনো বিষয় নির্ধারিত নেই'
      : zero > 0
        ? `${bn(zero)}টি বিষয়ে সাপ্তাহিক পিরিয়ড শূন্য — সেগুলো রুটিনে আসবে না`
        : `${bn(subjects)}টি বিষয় · সপ্তাহে মোট ${bn(Number(demand[0].weekly))}টি পিরিয়ড`,
    done: subjects - zero, total: subjects || 1,
  });

  // ── Teaching assignments (P9-1's counter, not a second one) ─────────
  const { rows: assign } = await c.query<{ required: string; assigned: string }>(
    `SELECT (SELECT count(*) FROM sections s
               JOIN class_subjects cs ON cs.class_id = s.class_id
                AND cs.academic_year_id = s.academic_year_id
              WHERE s.academic_year_id = $1)::text AS required,
            (SELECT count(*) FROM section_subject_teachers sst
               JOIN sections s ON s.id = sst.section_id
              WHERE sst.academic_year_id = $1 AND sst.ended_on IS NULL)::text AS assigned`,
    [yearId]);
  const required = Number(assign[0]?.required ?? 0);
  const assigned = Number(assign[0]?.assigned ?? 0);
  steps.push({
    id: 'assignments',
    titleBn: 'কে কোন বিষয় পড়ান',
    state: required === 0 ? 'blocked' : assigned >= required ? 'ok' : 'blocked',
    detailBn: required === 0
      ? 'নির্ধারণ করার মতো কিছু নেই — আগে বিষয় ও শাখা ঠিক করুন'
      : assigned >= required
        ? `${bn(required)}টির মধ্যে ${bn(required)}টি সম্পূর্ণ`
        : `${bn(required)}টির মধ্যে ${bn(assigned)}টি সম্পূর্ণ — ${bn(required - assigned)}টি বাকি`,
    done: assigned, total: required || 1,
  });

  // ── Teacher availability — a WARNING, never a blocker ───────────────
  // A school that records nothing here gets a routine built on the
  // assumption that every teacher is free all week, which is the right
  // default and is exactly what a first run should do.
  const { rows: avail } = await c.query<{ teachers: string; with_rows: string }>(
    `SELECT (SELECT count(DISTINCT sst.teacher_id) FROM section_subject_teachers sst
              WHERE sst.academic_year_id = $1 AND sst.ended_on IS NULL)::text AS teachers,
            (SELECT count(DISTINCT ta.teacher_id) FROM teacher_availability ta)::text AS with_rows`,
    [yearId]);
  const teacherCount = Number(avail[0]?.teachers ?? 0);
  const withRows = Number(avail[0]?.with_rows ?? 0);
  steps.push({
    id: 'availability',
    titleBn: 'শিক্ষকের সময়-সীমা',
    state: 'warn',
    detailBn: teacherCount === 0
      ? 'আগে শিক্ষক নির্ধারণ করুন'
      : withRows === 0
        ? 'কারও সময়-সীমা দেওয়া হয়নি — সবাইকে সব সময় ফাঁকা ধরা হবে'
        : `${bn(teacherCount)} জনের মধ্যে ${bn(withRows)} জনের সময়-সীমা দেওয়া আছে`,
    done: withRows, total: teacherCount || 1,
  });

  // ── Rooms ──────────────────────────────────────────────────────────
  const { rows: rooms } = await c.query<{ rooms: string; caps: string; needed: string }>(
    `SELECT (SELECT count(*) FROM rooms WHERE is_bookable)::text AS rooms,
            (SELECT count(DISTINCT cap) FROM rooms r,
                    LATERAL unnest(COALESCE(r.capabilities, '{}')) AS cap
              WHERE r.is_bookable)::text AS caps,
            (SELECT count(DISTINCT sub.requires_capability)
               FROM class_subjects cs JOIN subjects sub ON sub.id = cs.subject_id
              WHERE cs.academic_year_id = $1
                AND sub.requires_capability IS NOT NULL)::text AS needed`,
    [yearId]);
  const roomCount = Number(rooms[0]?.rooms ?? 0);
  const needed = Number(rooms[0]?.needed ?? 0);
  const caps = Number(rooms[0]?.caps ?? 0);
  steps.push({
    id: 'rooms',
    titleBn: 'কক্ষ ও ল্যাব',
    state: roomCount === 0 ? 'blocked' : (needed > 0 && caps < needed) ? 'warn' : 'ok',
    detailBn: roomCount === 0
      ? 'কোনো কক্ষ নেই — রুটিনে ক্লাস বসানোর জায়গা লাগবে'
      : (needed > 0 && caps < needed)
        ? `${bn(roomCount)}টি কক্ষ · ব্যবহারিক বিষয়ের জন্য প্রয়োজনীয় সব ধরনের ল্যাব নেই`
        : `${bn(roomCount)}টি কক্ষ পাওয়া গেছে`,
    done: roomCount, total: roomCount || 1,
  });

  return {
    steps,
    canGenerate: steps.every((s) => s.state !== 'blocked'),
    weekend: { days: weekendDays, managedBy: 'platform' },
  };
}

/* ─────────────────────────────── step data ──────────────────────────── */

async function periodsStep(c: Client) {
  const { rows: templates } = await c.query<{
    id: string; name_bn: string; shift: string; is_active: boolean;
  }>(`SELECT id, name_bn, shift::text AS shift, is_active FROM period_templates
       ORDER BY is_active DESC, name_bn`);
  const { rows: defs } = await c.query<{
    id: string; template_id: string; period_no: number; label_bn: string;
    starts_at: string; ends_at: string; kind: string;
  }>(`SELECT id, template_id, period_no, label_bn,
             to_char(starts_at,'HH24:MI') AS starts_at,
             to_char(ends_at,'HH24:MI') AS ends_at, kind::text AS kind
        FROM period_definitions ORDER BY template_id, period_no`);
  return {
    templates: templates.map((t) => ({
      id: t.id, nameBn: t.name_bn, shift: t.shift, isActive: t.is_active,
    })),
    periods: defs.map((d) => ({
      id: d.id, templateId: d.template_id, periodNo: d.period_no, labelBn: d.label_bn,
      startsAt: d.starts_at, endsAt: d.ends_at, kind: d.kind,
    })),
    kinds: PERIOD_KINDS,
  };
}

async function demandStep(c: Client, yearId: string, classId: string | null) {
  const { rows: classes } = await c.query<{ id: string; name_bn: string; level_no: number }>(
    `SELECT DISTINCT cl.id, cl.name_bn, cl.level_no
       FROM classes cl JOIN sections s ON s.class_id = cl.id AND s.academic_year_id = $1
      ORDER BY cl.level_no`, [yearId]);
  const target = classId ?? classes[0]?.id ?? null;
  if (!target) return { classes: [], classId: null, rows: [] };

  const { rows } = await c.query<{
    id: string; subject_id: string; name_bn: string; periods_per_week: number;
    double_periods_per_week: number; requires_capability: string | null;
  }>(
    `SELECT cs.id, cs.subject_id, sub.name_bn, cs.periods_per_week,
            cs.double_periods_per_week, sub.requires_capability
       FROM class_subjects cs JOIN subjects sub ON sub.id = cs.subject_id
      WHERE cs.class_id = $1 AND cs.academic_year_id = $2
      ORDER BY sub.name_bn`, [target, yearId]);
  return {
    classes: classes.map((r) => ({ id: r.id, nameBn: r.name_bn, levelNo: r.level_no })),
    classId: target,
    rows: rows.map((r) => ({
      id: r.id, subjectId: r.subject_id, nameBn: r.name_bn,
      periodsPerWeek: r.periods_per_week,
      doublePeriodsPerWeek: r.double_periods_per_week,
      requiresCapability: r.requires_capability,
    })),
  };
}

async function availabilityStep(c: Client, yearId: string) {
  const { rows: teachers } = await c.query<{ id: string; name_bn: string }>(
    `SELECT DISTINCT u.id, u.full_name_bn AS name_bn
       FROM section_subject_teachers sst JOIN users u ON u.id = sst.teacher_id
      WHERE sst.academic_year_id = $1 AND sst.ended_on IS NULL
      ORDER BY u.full_name_bn`, [yearId]);
  const { rows } = await c.query<{
    id: string; teacher_id: string; day_of_week: number;
    starts_at: string; ends_at: string; kind: string; reason: string | null;
  }>(
    `SELECT id, teacher_id, day_of_week,
            to_char(starts_at,'HH24:MI') AS starts_at,
            to_char(ends_at,'HH24:MI') AS ends_at, kind, reason
       FROM teacher_availability
      WHERE effective_to IS NULL OR effective_to >= app.today_dhaka()
      ORDER BY teacher_id, day_of_week, starts_at`);
  return {
    teachers: teachers.map((t) => ({ id: t.id, nameBn: t.name_bn })),
    blocks: rows.map((r) => ({
      id: r.id, teacherId: r.teacher_id, dayOfWeek: r.day_of_week,
      startsAt: r.starts_at, endsAt: r.ends_at, kind: r.kind, reason: r.reason,
    })),
    kinds: AVAILABILITY_KINDS,
  };
}

/* ──────────────────────────────── writers ───────────────────────────── */

interface PeriodInput {
  periodNo?: number; labelBn?: string; startsAt?: string; endsAt?: string; kind?: string;
}

/**
 * Replace one template's whole bell schedule.
 *
 * Whole-template and not row-by-row, because periods are only meaningful
 * together: moving period 4 later usually means moving 5, 6 and 7, and a
 * per-row API would make the office save seven times and hit an overlap
 * refusal on six of them. The database enforces non-overlap
 * (`pd_no_overlap_within_template`, migration 073) and this checks the same
 * thing first so the message names the two periods rather than a constraint.
 */
async function savePeriods(c: Client, templateId: string, list: PeriodInput[]) {
  if (!UUID_RE.test(templateId)) {
    throw new HttpError(400, 'শিফট বেছে নিন', 'invalid_template', { field: 'templateId' });
  }
  if (list.length === 0) {
    throw new HttpError(400, 'অন্তত একটি পিরিয়ড দিন', 'no_periods');
  }
  if (list.length > 20) {
    throw new HttpError(400, `একটি শিফটে সর্বোচ্চ ${bn(20)}টি পিরিয়ড`, 'too_many_periods');
  }

  const clean = list.map((p, i) => {
    const startsAt = String(p.startsAt ?? '');
    const endsAt = String(p.endsAt ?? '');
    const labelBn = String(p.labelBn ?? '').trim();
    const kind = String(p.kind ?? 'teaching');
    const periodNo = Number(p.periodNo ?? i + 1);

    if (!TIME_RE.test(startsAt) || !TIME_RE.test(endsAt)) {
      throw new HttpError(400, `${bn(periodNo)} নম্বর পিরিয়ডের সময় ২৪-ঘণ্টার ফরম্যাটে দিন`,
        'invalid_time', { field: 'startsAt', periodNo });
    }
    if (endsAt <= startsAt) {
      throw new HttpError(400,
        `${bn(periodNo)} নম্বর পিরিয়ড ${startsAt}-এ শুরু হয়ে ${endsAt}-এ শেষ হতে পারে না`,
        'ends_before_start', { field: 'endsAt', periodNo });
    }
    if (!labelBn) {
      throw new HttpError(400, `${bn(periodNo)} নম্বর পিরিয়ডের নাম দিন`,
        'invalid_label', { field: 'labelBn', periodNo });
    }
    if (!PERIOD_KINDS.includes(kind)) {
      throw new HttpError(400, 'পিরিয়ডের ধরন সঠিক নয়', 'invalid_kind', { field: 'kind' });
    }
    return { periodNo, labelBn, startsAt, endsAt, kind };
  });

  // Overlap, named in the school's own words. The EXCLUDE constraint would
  // refuse this too, with a message naming a constraint nobody can act on.
  const sorted = [...clean].sort((a, b) => a.startsAt.localeCompare(b.startsAt));
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].startsAt < sorted[i - 1].endsAt) {
      throw new HttpError(409,
        `"${sorted[i - 1].labelBn}" (${sorted[i - 1].startsAt}–${sorted[i - 1].endsAt}) `
        + `এবং "${sorted[i].labelBn}" (${sorted[i].startsAt}–${sorted[i].endsAt}) `
        + 'একই সময়ে পড়ছে',
        'period_overlap', { field: 'startsAt' });
    }
  }
  const nos = new Set(clean.map((p) => p.periodNo));
  if (nos.size !== clean.length) {
    throw new HttpError(409, 'একই পিরিয়ড নম্বর দুইবার দেওয়া হয়েছে', 'duplicate_period_no');
  }

  // Replace wholesale, inside the caller's transaction: a template that is
  // half-old and half-new is a bell schedule nobody rang.
  const { rows: owned } = await c.query(
    'SELECT 1 FROM period_templates WHERE id = $1', [templateId]);
  if (!owned[0]) throw new HttpError(404, 'শিফটটি পাওয়া যায়নি', 'template_not_found');

  await c.query('DELETE FROM period_definitions WHERE template_id = $1', [templateId]);
  for (const p of clean) {
    await c.query(
      `INSERT INTO period_definitions
         (tenant_id, template_id, period_no, label_bn, starts_at, ends_at, kind)
       VALUES (app.current_tenant(), $1, $2, $3, $4::time, $5::time, $6::period_kind)`,
      [templateId, p.periodNo, p.labelBn, p.startsAt, p.endsAt, p.kind]);
  }
  return { periods: clean.length, teaching: clean.filter((p) => p.kind === 'teaching').length };
}

interface DemandInput { id?: string; periodsPerWeek?: number; doublePeriodsPerWeek?: number }

async function saveDemand(c: Client, yearId: string, list: DemandInput[]) {
  if (list.length === 0) throw new HttpError(400, 'কোনো পরিবর্তন পাঠানো হয়নি', 'no_changes');
  if (list.length > 200) {
    throw new HttpError(400, `একবারে সর্বোচ্চ ${bn(200)}টি বিষয়`, 'too_many_rows');
  }
  let changed = 0;
  for (const row of list) {
    const id = String(row.id ?? '');
    if (!UUID_RE.test(id)) {
      throw new HttpError(400, 'বিষয় সঠিক নয়', 'invalid_row', { field: 'id' });
    }
    const perWeek = Number(row.periodsPerWeek);
    const doubles = Number(row.doublePeriodsPerWeek ?? 0);
    if (!Number.isInteger(perWeek) || perWeek < 0 || perWeek > 20) {
      throw new HttpError(400, `সাপ্তাহিক পিরিয়ড ০ থেকে ${bn(20)}-এর মধ্যে দিন`,
        'invalid_periods', { field: 'periodsPerWeek' });
    }
    if (!Number.isInteger(doubles) || doubles < 0) {
      throw new HttpError(400, 'ডাবল পিরিয়ড ঋণাত্মক হতে পারে না',
        'invalid_doubles', { field: 'doublePeriodsPerWeek' });
    }
    // Two periods make one double, so the doubles cannot outgrow the week.
    if (doubles * 2 > perWeek) {
      throw new HttpError(409,
        `${bn(doubles)}টি ডাবল পিরিয়ডের জন্য সপ্তাহে অন্তত ${bn(doubles * 2)}টি পিরিয়ড লাগবে`,
        'doubles_exceed_week', { field: 'doublePeriodsPerWeek' });
    }
    // `periods_per_week` and `double_periods_per_week` ONLY. The marks
    // columns on this table are governed by a CHECK that they sum to
    // `total_marks`, and this screen is not where a school edits marks.
    const { rowCount } = await c.query(
      `UPDATE class_subjects SET periods_per_week = $2, double_periods_per_week = $3
        WHERE id = $1 AND academic_year_id = $4`, [id, perWeek, doubles, yearId]);
    if (rowCount === 0) {
      throw new HttpError(404, 'এই শিক্ষাবর্ষে বিষয়টি পাওয়া যায়নি', 'row_not_in_year');
    }
    changed += 1;
  }
  return { changed };
}

interface AvailabilityInput {
  teacherId?: string; dayOfWeek?: number; startsAt?: string; endsAt?: string;
  kind?: string; reason?: string | null;
}

async function addAvailability(c: Client, b: AvailabilityInput) {
  const teacherId = String(b.teacherId ?? '');
  if (!UUID_RE.test(teacherId)) {
    throw new HttpError(400, 'শিক্ষক বেছে নিন', 'invalid_teacher', { field: 'teacherId' });
  }
  const day = Number(b.dayOfWeek);
  if (!Number.isInteger(day) || day < 0 || day > 6) {
    throw new HttpError(400, 'দিন বেছে নিন', 'invalid_day', { field: 'dayOfWeek' });
  }
  const startsAt = String(b.startsAt ?? '');
  const endsAt = String(b.endsAt ?? '');
  if (!TIME_RE.test(startsAt) || !TIME_RE.test(endsAt)) {
    throw new HttpError(400, 'সময় ২৪-ঘণ্টার ফরম্যাটে দিন', 'invalid_time', { field: 'startsAt' });
  }
  if (endsAt <= startsAt) {
    throw new HttpError(400, `${DAY_BN[day]}বারের সময়টি শুরুর আগেই শেষ হচ্ছে`,
      'ends_before_start', { field: 'endsAt' });
  }
  const kind = String(b.kind ?? 'unavailable');
  if (!AVAILABILITY_KINDS.includes(kind)) {
    throw new HttpError(400, 'ধরন সঠিক নয়', 'invalid_kind', { field: 'kind' });
  }
  const { rows: t } = await c.query('SELECT 1 FROM users WHERE id = $1 AND deleted_at IS NULL',
    [teacherId]);
  if (!t[0]) throw new HttpError(404, 'শিক্ষক পাওয়া যায়নি', 'teacher_not_found');

  const { rows } = await c.query<{ id: string }>(
    `INSERT INTO teacher_availability
       (tenant_id, teacher_id, day_of_week, starts_at, ends_at, time_range, kind, reason)
     VALUES (app.current_tenant(), $1, $2, $3::time, $4::time,
             timerange($3::time, $4::time), $5, NULLIF($6,''))
     RETURNING id`,
    [teacherId, day, startsAt, endsAt, kind, (b.reason ?? '').trim()]);
  return { id: rows[0].id };
}

async function removeAvailability(c: Client, id: string) {
  if (!UUID_RE.test(id)) {
    throw new HttpError(400, 'সঠিক নয়', 'invalid_id', { field: 'id' });
  }
  const { rowCount } = await c.query('DELETE FROM teacher_availability WHERE id = $1', [id]);
  if (rowCount === 0) throw new HttpError(404, 'পাওয়া যায়নি', 'not_found');
  return { removed: 1 };
}

/* ──────────────────────────────── handler ───────────────────────────── */

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const cors = corsHeaders([], 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }

  try {
    const claims = await authenticate(req);
    const url = new URL(req.url ?? '/', 'http://internal');
    const step = url.searchParams.get('step') ?? '';
    const db = await sharedDb();
    // No `service:` key — the catalogue has no routine service, the same
    // absence `editor.ts` and `assignments.ts` record. Not a B-70(b) bypass.
    const ctx = { tenantId: claims.tid, userId: claims.sub, role: claims.role };

    if (req.method === 'GET') {
      // Reading the setup is allowed to anyone who may author a routine.
      // A teacher does not need it and a student must not have it.
      requireRole(claims, AVAILABILITY_ROLES);
      const yearId = url.searchParams.get('yearId') ?? '';
      if (!UUID_RE.test(yearId)) {
        throw new HttpError(400, 'শিক্ষাবর্ষ বেছে নিন', 'invalid_year', { field: 'yearId' });
      }
      const classId = url.searchParams.get('classId');
      if (classId && !UUID_RE.test(classId)) {
        throw new HttpError(400, 'শ্রেণি সঠিক নয়', 'invalid_class', { field: 'classId' });
      }

      const out = await db.withTenant(ctx, async (raw) => {
        const c = raw as Client;
        if (step === 'periods') return periodsStep(c);
        if (step === 'demand') return demandStep(c, yearId, classId);
        if (step === 'availability') return availabilityStep(c, yearId);
        return readiness(c, yearId);
      });
      json(res, 200, out, cors);
      return;
    }

    if (req.method === 'POST') {
      const body = await readJson<Record<string, unknown>>(req);
      const which = String(body.step ?? '');

      // Availability is the one step a dept_head may write; everything else
      // needs a routine author. Checked per step rather than once, because
      // one endpoint with one role list would either lock a dept_head out of
      // their own job or hand them the curriculum.
      requireRole(claims, which === 'availability' ? AVAILABILITY_ROLES : SETUP_ROLES);

      const write = <T>(fn: (c: Client) => Promise<T>) =>
        db.withTenant(ctx, (c) => fn(c as Client), { write: true });

      if (which === 'periods') {
        json(res, 200, await write((c) => savePeriods(
          c, String(body.templateId ?? ''), (body.periods ?? []) as PeriodInput[])), cors);
        return;
      }
      if (which === 'demand') {
        const yearId = String(body.yearId ?? '');
        if (!UUID_RE.test(yearId)) {
          throw new HttpError(400, 'শিক্ষাবর্ষ বেছে নিন', 'invalid_year', { field: 'yearId' });
        }
        json(res, 200, await write((c) => saveDemand(
          c, yearId, (body.rows ?? []) as DemandInput[])), cors);
        return;
      }
      if (which === 'availability') {
        if (body.remove) {
          json(res, 200, await write((c) => removeAvailability(c, String(body.remove))), cors);
          return;
        }
        json(res, 200, await write((c) => addAvailability(c, body as AvailabilityInput)), cors);
        return;
      }
      throw new HttpError(400, "step must be 'periods', 'demand' or 'availability'",
        'invalid_step', { field: 'step' });
    }

    json(res, 405, { error: 'method_not_allowed' }, cors);
  } catch (err) {
    if (err instanceof HttpError) {
      json(res, err.status, { error: err.code, message: err.message, ...(err.detail ?? {}) }, cors);
      return;
    }
    console.error('[rms/setup]', err);
    json(res, 500, { error: 'internal_error', message: 'সংরক্ষণ করা যায়নি' }, cors);
  }
}
