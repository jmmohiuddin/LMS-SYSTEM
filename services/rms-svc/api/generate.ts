/**
 * POST /api/v1/rms/generate { yearId }  → run the solver over the whole school
 * GET  /api/v1/rms/generate?yearId=…    → the last result, from the database
 *
 * P9-3. The READY → GENERATE → RESULT step, and deliberately an ORCHESTRATOR
 * rather than a solver: `RmsSolver` is called unchanged, once per shift.
 *
 * ── Why an institution-wide action needs its own endpoint ────────────────
 * `POST /rms/solve` takes a `routineId` and fills that one routine. A routine
 * is scoped to one (year, shift) — so a two-shift college needs two of them,
 * and a coordinator pressing "Generate" is asking about their whole school,
 * not about a uuid they have never seen. Everything below is the difference
 * between those two sentences: find or make the drafts, run each, and add up
 * an answer a person can read.
 *
 * ── Pressing Generate twice must be safe (§10) ───────────────────────────
 * Two mechanisms, and both are needed.
 *
 * `editor.ts:createRoutine` versions as `max(version) + 1`, so calling it
 * again would leave a school with draft v1 and draft v2 and no way to know
 * which the timetable is. This REUSES the newest draft for the (year, shift)
 * and only creates one when there is none.
 *
 * And `RmsSolver.solve` is idempotent by construction: for each (section,
 * subject) it tops up `periodsPerWeek − alreadyPlaced`, counting what is
 * already there. So a second run over the same draft fills the gaps the first
 * one left and duplicates nothing. That property is the solver's, not this
 * file's — the test asserts it end to end because a change to either half
 * would break it.
 *
 * ── The readiness gate is the same one the wizard reads ──────────────────
 * Checked HERE, server-side, before any routine is created. A browser that
 * had a stale `canGenerate: true` — because someone else emptied the room
 * list a minute ago — must not be able to start a run that would produce a
 * useless timetable and a draft routine nobody asked for.
 *
 * ── What this does NOT do ────────────────────────────────────────────────
 * Publish (P9-7), re-solve a scope (P9-6), or render the grid (P9-8). It
 * writes draft slots and returns numbers. `GET` re-reads those numbers from
 * `routines.soft_violations` and the slot counts, so a refresh after a
 * generation shows the same result rather than an empty screen (§13).
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type pg from 'pg';
import { sharedDb } from '../../../packages/server-core/src/db.ts';
import { corsHeaders, readJson, json, HttpError } from '../../../packages/server-core/src/http.ts';
import { authenticate, requireRole } from '../../../packages/server-core/src/auth.ts';
import { RmsSolver, type SolveResult } from '../src/solve.ts';
import {
  capabilityLabelBn, scrubMachineText, unplacedReasonBn,
} from '../src/presentation.ts';
import { explain, severityCounts } from '../src/explain.ts';
import { readiness } from './setup.ts';

type Client = pg.PoolClient;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The same three that may author a routine. Generating IS authoring. */
const GENERATE_ROLES = ['principal', 'school_owner', 'academic_coordinator'];

const BN_DIGITS = '০১২৩৪৫৬৭৮৯';
const bn = (n: number): string => String(n).replace(/[0-9]/g, (d) => BN_DIGITS[Number(d)]);

/**
 * An unplaced demand with the three words a person needs to act on it.
 *
 * The solver reports `{sectionId, subjectId, teacherId, missing, reason}` —
 * correct, and unreadable. A coordinator looking at "৩টি বাকি" against a uuid
 * cannot tell whether it is their problem or the machine's. §7 asks for the
 * class, the subject and the shortfall, so they are resolved here, once, from
 * the same database that stores the routine.
 */
interface NamedUnplaced {
  sectionId: string;
  subjectId: string;
  sectionName: string;
  subjectBn: string;
  teacherBn: string | null;
  required: number;
  placed: number;
  missing: number;
  reason: string;
  reasonBn: string;
  capability?: string;
  /** How many rooms carry the capability this subject needs. Decides which
   *  suggestion is honest: add a room, or rearrange the ones that exist. */
  capableRooms?: number;
  blockers?: SolveResult['unplaced'][number]['blockers'];
}

/**
 * A capability shortage with the subject that wanted it.
 *
 * `solve.ts` writes "'computer_lab' কক্ষে ৮০টি পিরিয়ড দরকার" — the raw
 * capability code, in the middle of a Bangla sentence, on the screen a head
 * teacher reads. The code is whatever an IT admin typed into
 * `subjects.requires_capability`, so there is no lookup table that could
 * translate it; what CAN be said is which subjects asked for it, and that is
 * the sentence a person can act on.
 *
 * The solver's own `detailBn` is left untouched — other screens read it, and
 * F-503's shortage text is theirs.
 */
interface NamedShortage {
  capability: string;
  subjectsBn: string[];
  demandedPeriods: number;
  capableRooms: number;
  freePeriods: number;
  detailBn: string;
}

interface ShiftResult {
  shift: string;
  routineId: string;
  version: number;
  created: boolean;
  totalDemand: number;
  placed: number;
  unplaced: NamedUnplaced[];
  soft: SolveResult['soft'];
  shortages: NamedShortage[];
  solverSeconds: number;
  /** B-108. The live version this draft was copied from, or null if fresh. */
  copiedFromVersion: number | null;
  /** How many lessons the copy carried. 0 on the 'inputs' baseline. */
  copiedSlots: number;
}

/** Which subjects asked for each capability that ran short. */
async function nameShortages(
  c: Client, yearId: string, shortages: SolveResult['shortages'],
): Promise<NamedShortage[]> {
  if (shortages.length === 0) return [];
  const caps = shortages.map((s) => s.capability);
  const { rows } = await c.query<{ capability: string; subjects: string[] }>(
    `SELECT sub.requires_capability AS capability,
            array_agg(DISTINCT sub.name_bn ORDER BY sub.name_bn) AS subjects
       FROM class_subjects cs
       JOIN subjects sub ON sub.id = cs.subject_id
      WHERE cs.academic_year_id = $1 AND sub.requires_capability = ANY($2::text[])
      GROUP BY 1`,
    [yearId, caps]);
  const byCap = new Map(rows.map((r) => [r.capability, r.subjects]));
  return shortages.map((s) => {
    const subjects = byCap.get(s.capability) ?? [];
    return {
      ...s,
      subjectsBn: subjects,
      // Rewritten around the subject, so no machine code reaches a person.
      // Where the school named a capability no subject uses any more, the
      // code is all there is — and saying so is better than saying nothing.
      detailBn: subjects.length > 0
        ? `${subjects.join(', ')} — ${bn(s.demandedPeriods)}টি পিরিয়ড দরকার; `
          + `${capabilityLabelBn(s.capability)} ${bn(s.capableRooms)}টিতে `
          + `${bn(s.freePeriods)}টি সময় খালি ছিল`
        // Composed by the solver and possibly stored months ago, so the
        // machine code is removed on the way out rather than at the writer.
        : scrubMachineText(s.detailBn),
    };
  });
}

/**
 * Put names to the ids, and count what actually got stored.
 *
 * `placed` is COUNTED from `routine_slots` rather than derived as
 * `required − missing`. The two should agree, and if they ever disagree the
 * stored rows are the truth — §6's rule, applied to the summary and not only
 * to the conflict check.
 */
async function nameUnplaced(
  c: Client, routineId: string, yearId: string, unplaced: SolveResult['unplaced'],
  capableRoomsByCapability: Map<string, number> = new Map(),
): Promise<NamedUnplaced[]> {
  if (unplaced.length === 0) return [];
  const sectionIds = [...new Set(unplaced.map((u) => u.sectionId))];
  const subjectIds = [...new Set(unplaced.map((u) => u.subjectId))];

  const { rows } = await c.query<{
    section_id: string; subject_id: string; section_name: string;
    class_bn: string; subject_bn: string; teacher_bn: string | null;
    required: number; placed: string;
  }>(
    `SELECT sec.id AS section_id, sub.id AS subject_id,
            sec.name AS section_name, cl.name_bn AS class_bn,
            sub.name_bn AS subject_bn,
            t.full_name_bn AS teacher_bn,
            COALESCE(cs.periods_per_week, 0) AS required,
            (SELECT count(*) FROM routine_slots rs
              WHERE rs.routine_id = $1 AND rs.primary_section_id = sec.id
                AND rs.subject_id = sub.id AND rs.status <> 'removed')::text AS placed
       FROM sections sec
       JOIN classes cl ON cl.id = sec.class_id
       CROSS JOIN subjects sub
       LEFT JOIN class_subjects cs
              ON cs.class_id = sec.class_id AND cs.subject_id = sub.id
             AND cs.academic_year_id = $2
       LEFT JOIN section_subject_teachers sst
              ON sst.section_id = sec.id AND sst.subject_id = sub.id
             AND sst.academic_year_id = $2 AND sst.ended_on IS NULL
       LEFT JOIN users t ON t.id = sst.teacher_id
      WHERE sec.id = ANY($3::uuid[]) AND sub.id = ANY($4::uuid[])`,
    [routineId, yearId, sectionIds, subjectIds]);

  const key = (s: string, j: string) => `${s}|${j}`;
  const byPair = new Map(rows.map((r) => [key(r.section_id, r.subject_id), r]));

  return unplaced.map((u) => {
    const r = byPair.get(key(u.sectionId, u.subjectId));
    return {
      sectionId: u.sectionId,
      subjectId: u.subjectId,
      // "৯ম — ক" reads as a place in a school; a uuid does not.
      sectionName: r ? `${r.class_bn} — ${r.section_name}` : '—',
      subjectBn: r?.subject_bn ?? '—',
      teacherBn: r?.teacher_bn ?? null,
      required: Number(r?.required ?? u.missing),
      placed: Number(r?.placed ?? 0),
      missing: u.missing,
      reason: u.reason,
      reasonBn: unplacedReasonBn(u.reason),
      ...(u.capability
        ? { capability: u.capability,
            capableRooms: capableRoomsByCapability.get(u.capability) ?? 0 }
        : {}),
      ...(u.blockers ? { blockers: u.blockers } : {}),
    };
  });
}

/**
 * Find the newest DRAFT for this (year, shift), or make one.
 *
 * Draft only. An ACTIVE routine is what a school is running today, and
 * solving into it would rewrite this week's timetable underneath the people
 * following it — that is P9-6's scoped re-solve and P9-7's publish, not this.
 */
async function draftFor(
  c: Client, ctx: { userId: string }, yearId: string, shift: string,
): Promise<{ routineId: string; version: number; created: boolean }> {
  const { rows: existing } = await c.query<{ id: string; version: number }>(
    `SELECT id, version FROM routines
      WHERE academic_year_id = $1 AND shift = $2::shift_code AND status = 'draft'
      ORDER BY version DESC LIMIT 1`,
    [yearId, shift]);
  if (existing[0]) {
    return { routineId: existing[0].id, version: existing[0].version, created: false };
  }

  const { rows: tpl } = await c.query<{ template_id: string; year_starts: string }>(
    `SELECT pt.id AS template_id, y.starts_on::text AS year_starts
       FROM academic_years y
       LEFT JOIN period_templates pt
              ON pt.shift = $2::shift_code AND pt.is_active
      WHERE y.id = $1
      ORDER BY pt.effective_from DESC
      LIMIT 1`,
    [yearId, shift]);
  if (!tpl[0]?.template_id) {
    // The same refusal `editor.ts` gives, for the same reason: an evening
    // shift is provisioned with a named but EMPTY template.
    throw new HttpError(409,
      `এই শিফটের জন্য কোনো পিরিয়ড টেমপ্লেট নেই — আগে ঘণ্টার সময়সূচি তৈরি করুন।`,
      'no_period_template', { shift });
  }

  const { rows: v } = await c.query<{ next: number }>(
    `SELECT COALESCE(max(version), 0) + 1 AS next
       FROM routines WHERE academic_year_id = $1 AND shift = $2::shift_code`,
    [yearId, shift]);
  const { rows: ins } = await c.query<{ id: string; version: number }>(
    `INSERT INTO routines (tenant_id, academic_year_id, period_template_id, shift,
                           name_bn, version, effective_from, generated_by, created_by)
     VALUES (app.current_tenant(), $1, $2, $3::shift_code, $4, $5, $6::date, 'solver', $7)
     RETURNING id, version`,
    [yearId, tpl[0].template_id, shift, `স্বয়ংক্রিয় রুটিন v${bn(v[0].next)}`,
     v[0].next, tpl[0].year_starts, ctx.userId]);
  return { routineId: ins[0].id, version: ins[0].version, created: true };
}

/**
 * Copy the live routine for this shift into a fresh draft. (B-108)
 *
 * Returns how many slots were copied, or 0 when the school has nothing
 * published for this shift yet — in which case the caller has an ordinary
 * empty draft and the solver fills it, which is the right answer rather than
 * an error.
 *
 * `is_pinned` rides along deliberately (§5). `time_range` is maintained by
 * `trg_slot_time_range` and `routine_status` by `trg_routine_slots_facts`, so
 * neither is copied; `row_version` restarts at 1 because these are new rows
 * and P9-5's concurrency check is about THIS draft's edit history.
 *
 * `routine_slot_sections` is not copied because nothing writes it: parallel
 * blocks are expressed through `parallel_pool`, which is.
 */
async function cloneLiveInto(
  c: Client, draftId: string, yearId: string, shift: string,
): Promise<{ copied: number; fromVersion: number | null }> {
  const { rows: live } = await c.query<{ id: string; version: number; template: string }>(
    `SELECT id, version, period_template_id AS template
       FROM routines
      WHERE academic_year_id = $1 AND shift = $2::shift_code AND status = 'active'`,
    [yearId, shift]);
  if (!live[0]) return { copied: 0, fromVersion: null };

  // A copied slot points at a period_definition_id. If the school has since
  // adopted a new bell schedule, the new draft is on a different template and
  // those ids belong to the old one — the copy would look right and place
  // every lesson at the previous timetable's clock times. Refused rather than
  // silently produced.
  const { rows: mine } = await c.query<{ template: string }>(
    `SELECT period_template_id AS template FROM routines WHERE id = $1`, [draftId]);
  if (mine[0]?.template !== live[0].template) {
    throw new HttpError(409,
      'ঘণ্টার সময়সূচি বদলেছে, তাই চালু রুটিনটি হুবহু নকল করা যাবে না — '
      + 'নতুন করে তৈরি করুন।',
      'period_template_changed', { shift });
  }

  const { rowCount } = await c.query(
    `INSERT INTO routine_slots
       (tenant_id, routine_id, academic_year_id, day_of_week, period_no,
        period_definition_id, starts_at, ends_at, slot_kind,
        primary_section_id, subject_id, teacher_id, room_id,
        is_double, double_group_id, is_pinned, notes, parallel_pool)
     SELECT s.tenant_id, $1, s.academic_year_id, s.day_of_week, s.period_no,
            s.period_definition_id, s.starts_at, s.ends_at, s.slot_kind,
            s.primary_section_id, s.subject_id, s.teacher_id, s.room_id,
            s.is_double, s.double_group_id, s.is_pinned, s.notes, s.parallel_pool
       FROM routine_slots s
      WHERE s.routine_id = $2 AND s.status = 'active'`,
    [draftId, live[0].id]);

  await c.query(
    `UPDATE routines SET generated_by = 'copied' WHERE id = $1`, [draftId]);
  return { copied: rowCount ?? 0, fromVersion: live[0].version };
}

/**
 * Every shift this year's sections actually run, EARLIEST FIRST.
 *
 * The order decides who wins a contended room, because each shift is solved
 * against the ones before it. Ordering by the shift's text put 'day' ahead of
 * 'morning' and handed the alphabet a scheduling decision: the morning shift
 * lost its last period to a day shift that had not started yet.
 *
 * `shift_code` is declared morning, day, evening, single — which is the clock
 * order — so ordering by the ENUM rather than by its text is both the fix and
 * the explanation.
 *
 * The output column is deliberately NOT called `shift`. `ORDER BY` resolves
 * an output alias before an input column, so `SELECT shift::text AS shift …
 * ORDER BY shift` sorts by the text after all and quietly restores the bug —
 * which it did once already.
 */
async function shiftsOf(c: Client, yearId: string): Promise<string[]> {
  const { rows } = await c.query<{ code: string }>(
    `SELECT shift::text AS code FROM sections
      WHERE academic_year_id = $1
      GROUP BY shift ORDER BY shift`, [yearId]);
  return rows.map((r) => r.code);
}

/**
 * Count teacher, room and section double-bookings in what was just stored.
 *
 * §6 says to prove it by re-querying rather than by trusting the solver, and
 * the first version of this file did neither: it returned a hard-coded 0 and
 * a comment claiming the three GiST EXCLUDE constraints made a conflict
 * unstorable. Read their predicates and that is only true of an ACTIVE
 * routine —
 *
 *   rs_no_section_double_booking  … WHERE status='active'
 *   rs_no_teacher_double_booking  … WHERE status='active'
 *                                     AND routine_status='active'
 *   rs_no_room_double_booking     … ditto
 *
 * — so a DRAFT is protected within itself on sections and not at all on
 * teachers and rooms. That gap is deliberate (two rival drafts of one shift
 * must not block each other) and `editor.ts:findClash` already compensates
 * for it in manual authoring. `scripts/routine-benchmark.mjs` then found 40
 * cross-shift room collisions in an 80-section school, which is what a
 * hard-coded zero buys you.
 *
 * So it is counted. If it is ever non-zero the routine cannot be published,
 * and the coordinator has to hear that now rather than at publish time.
 */
async function countHardConflicts(c: Client, routineIds: string[]): Promise<number> {
  if (routineIds.length === 0) return 0;
  // Counted with a window, not a self-join.
  //
  // The obvious `FROM mine a JOIN mine b ON a.id < b.id AND … && …` is
  // correct and quadratic, and the partial GiST indexes cannot help it
  // because they carry `WHERE routine_status = 'active'` and these routines
  // are drafts. At 120 sections it took 4.3 of the run's 12.5 seconds —
  // a verification step costing a third of the thing it verifies.
  //
  // Sorting each (resource, day) by start time and comparing against the
  // running maximum end time is one pass. A slot conflicts exactly when it
  // begins before something already in that room, that teacher's day or that
  // section's day has finished. The count is of colliding SLOTS rather than
  // of pairs, which is the more useful number anyway; zero means the same
  // thing either way, and `scripts/routine-benchmark.mjs` still runs the
  // pairwise form as an independent check.
  const clash = (partition: string, where: string) => `
    SELECT count(*) FROM (
      SELECT starts_at < max(ends_at) OVER (
               PARTITION BY ${partition} ORDER BY starts_at, ends_at
               ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) AS hit
        FROM mine WHERE ${where}) q
     WHERE hit`;
  const { rows } = await c.query<{ n: string }>(
    `WITH mine AS (
       SELECT routine_id, teacher_id, room_id, primary_section_id, parallel_pool,
              day_of_week, starts_at, ends_at, slot_kind
         FROM routine_slots
        WHERE routine_id = ANY($1::uuid[]) AND status = 'active'
     )
     SELECT (
        (${clash('teacher_id, day_of_week',
                 `teacher_id IS NOT NULL AND slot_kind IN ('teaching','exam')`)})
      + (${clash('room_id, day_of_week',
                 `room_id IS NOT NULL AND slot_kind IN ('teaching','exam')`)})
      + (${clash('routine_id, primary_section_id, day_of_week',
                 'primary_section_id IS NOT NULL AND parallel_pool IS NULL')})
     )::text AS n`,
    [routineIds]);
  return Number(rows[0].n);
}

/** What a coordinator reads first: is this usable? */
function summarise(results: ShiftResult[], hardConflicts: number, ms: number) {
  const totalDemand = results.reduce((n, r) => n + r.totalDemand, 0);
  const placed = results.reduce((n, r) => n + r.placed, 0);
  const unplacedPeriods = results.reduce(
    (n, r) => n + r.unplaced.reduce((m, u) => m + (u.missing ?? 0), 0), 0);
  const softCount = results.reduce((n, r) => n + (r.soft?.violations?.length ?? 0), 0);
  return {
    totalDemand,
    placed,
    unplacedPeriods,
    unplacedDemands: results.reduce((n, r) => n + r.unplaced.length, 0),
    softViolations: softCount,
    hardConflicts,
    shortages: results.flatMap((r) => r.shortages),
    solverSeconds: Number(results.reduce((n, r) => n + r.solverSeconds, 0).toFixed(3)),
    totalSeconds: Number((ms / 1000).toFixed(3)),
    // The one sentence the summary exists for. A hard conflict outranks
    // everything else in it: a routine carrying one cannot be published, so
    // saying "all 2,360 periods placed" would be true and useless.
    verdictBn: hardConflicts > 0
      ? `${bn(hardConflicts)}টি সময়ের সংঘাত রয়ে গেছে — এই রুটিন প্রকাশ করা যাবে না`
      : unplacedPeriods === 0
        ? `সব ${bn(totalDemand)}টি পিরিয়ড বসানো হয়েছে`
        : `${bn(totalDemand)}টির মধ্যে ${bn(placed)}টি বসানো হয়েছে — ${bn(unplacedPeriods)}টি বাকি`,
  };
}

/** First occurrence wins. Used for rules reported once per shift. */
function dedupeBy<T>(rows: T[], key: (row: T) => string): T[] {
  const seen = new Set<string>();
  return rows.filter((r) => {
    const k = key(r);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** Re-read a previous run from the database, so a refresh is not an empty page. */
async function lastResult(c: Client, yearId: string) {
  const { rows } = await c.query<{
    id: string; shift: string; version: number; status: string;
    soft_violations: unknown; solver_seconds: string | null;
    generated_at: string | null; slots: string;
  }>(
    `SELECT r.id, r.shift::text AS shift, r.version, r.status::text AS status,
            r.soft_violations, r.solver_seconds::text,
            r.updated_at::text AS generated_at,
            (SELECT count(*) FROM routine_slots s
              WHERE s.routine_id = r.id AND s.status <> 'removed')::text AS slots
       FROM routines r
      -- B-108. 'copied' as well as 'solver': a replacement draft is copied
      -- from the live routine and then topped up, and filtering it out made
      -- the draft a coordinator had just created vanish from this screen.
      WHERE r.academic_year_id = $1 AND r.generated_by IN ('solver','copied')
      ORDER BY r.updated_at DESC`,
    [yearId]);
  return {
    runs: rows.map((r) => ({
      routineId: r.id, shift: r.shift, version: r.version, status: r.status,
      slots: Number(r.slots),
      solverSeconds: r.solver_seconds === null ? null : Number(r.solver_seconds),
      generatedAt: r.generated_at,
      soft: r.soft_violations,
    })),
  };
}

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const cors = corsHeaders([], 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }

  try {
    const claims = await authenticate(req);
    requireRole(claims, GENERATE_ROLES);
    const db = await sharedDb();
    const ctx = { tenantId: claims.tid, userId: claims.sub, role: claims.role };

    if (req.method === 'GET') {
      const yearId = new URL(req.url ?? '/', 'http://internal').searchParams.get('yearId') ?? '';
      if (!UUID_RE.test(yearId)) {
        throw new HttpError(400, 'শিক্ষাবর্ষ বেছে নিন', 'invalid_year', { field: 'yearId' });
      }
      json(res, 200,
        await db.withTenant(ctx, (c) => lastResult(c as Client, yearId)), cors);
      return;
    }

    if (req.method !== 'POST') { json(res, 405, { error: 'method_not_allowed' }, cors); return; }

    const body = await readJson<{ yearId?: string; baseline?: string }>(req);
    // B-108. 'current' copies the live routine into the new draft; 'inputs'
    // (the default, and what this endpoint always did) builds from academic
    // demand. Anything else is a typo, and a typo must not silently pick one.
    const baseline = body.baseline === undefined ? 'inputs' : String(body.baseline);
    if (baseline !== 'inputs' && baseline !== 'current') {
      throw new HttpError(400, "baseline must be 'inputs' or 'current'",
        'invalid_baseline', { field: 'baseline' });
    }
    const yearId = String(body.yearId ?? '');
    if (!UUID_RE.test(yearId)) {
      throw new HttpError(400, 'শিক্ষাবর্ষ বেছে নিন', 'invalid_year', { field: 'yearId' });
    }

    // ── The gate, server-side, before anything is created ──────────────
    const ready = await db.withTenant(ctx, (c) => readiness(c as Client, yearId));
    if (!ready.canGenerate) {
      const blocked = ready.steps.filter((s) => s.state === 'blocked');
      throw new HttpError(409,
        `রুটিন তৈরি করা যাবে না — ${blocked.map((s) => s.titleBn).join(', ')} বাকি আছে`,
        'not_ready', { steps: blocked });
    }

    const startedAt = Date.now();
    const shifts = await db.withTenant(ctx, (c) => shiftsOf(c as Client, yearId));
    if (shifts.length === 0) {
      throw new HttpError(409, 'এই শিক্ষাবর্ষে কোনো শাখা নেই', 'no_sections');
    }

    const results: ShiftResult[] = [];
    for (const shift of shifts) {
      // The draft is created in its own transaction so a solver failure on
      // shift two does not roll back shift one's completed work — a school
      // with a morning routine and a failed day shift should keep the
      // morning one and be told about the other.
      const draft = await db.withTenant(
        ctx, (c) => draftFor(c as Client, ctx, yearId, shift), { write: true });

      // B-108. Copy the live routine in FIRST, so the solver meets a draft
      // that is already full and tops up only what the copy could not carry.
      // Only into a draft this run just created — copying into one a
      // coordinator has been editing would duplicate every lesson in it.
      const cloned = baseline === 'current' && draft.created
        ? await db.withTenant(
            ctx, (c) => cloneLiveInto(c as Client, draft.routineId, yearId, shift),
            { write: true })
        : { copied: 0, fromVersion: null };

      // Every draft this run has already filled is booked against. Without
      // it the day shift places lessons into rooms the morning shift is
      // still using — the two drafts are invisible to each other, and the
      // database will not object until publish.
      const solved = await new RmsSolver(db).solve(draft.routineId, ctx,
        { alsoBookedAgainst: results.map((r) => r.routineId) });
      const [named, shortages] = await db.withTenant(ctx, async (c) => {
        // The shortage rows already know how many rooms carry each
        // capability; reusing them keeps `nameUnplaced` to one query and
        // stops the explanation suggesting "add a room" to a school that
        // has four of them (§16 — no N+1, no second source of truth).
        const shorts = await nameShortages(c as Client, yearId, solved.shortages);
        const capableRooms = new Map(shorts.map((x) => [x.capability, x.capableRooms]));
        return [
          await nameUnplaced(c as Client, draft.routineId, yearId,
                             solved.unplaced, capableRooms),
          shorts,
        ] as const;
      });
      results.push({
        shift,
        routineId: draft.routineId,
        version: draft.version,
        created: draft.created,
        totalDemand: solved.totalDemand,
        placed: solved.placed,
        unplaced: named,
        soft: solved.soft,
        shortages,
        solverSeconds: solved.solverSeconds,
        // B-108. What this draft was built FROM, so the screen can say it
        // rather than leave a coordinator to infer why 560 lessons appeared
        // in a routine they have not edited yet.
        copiedFromVersion: cloned.fromVersion,
        copiedSlots: cloned.copied,
      });
    }

    const hardConflicts = await db.withTenant(
      ctx, (c) => countHardConflicts(c as Client, results.map((r) => r.routineId)));

    // P9-4. Built from the run that just happened, not by asking the solver
    // again: the whole explanation is a pure function of the result plus the
    // readiness the gate already computed. §16's "one generation result,
    // structured explanation data, efficient lookup" is the shape.
    const explanations = explain({
      unplaced: results.flatMap((r) => r.unplaced),
      // NOTE: `blockers` is consumed here and stripped below. It is the
      // solver's own bookkeeping — how many candidate hours each guard
      // rejected — and §1 says not to expose solver internals. It also cost
      // 175 kB of the college profile's 375 kB response, which on a 2G
      // connection is most of a minute for data nothing renders.

      soft: results.flatMap((r) => r.soft?.violations ?? []),
      shortages: results.flatMap((r) => r.shortages),
      // The same rule can be reported once per shift; a coordinator needs to
      // read it once.
      notEvaluated: dedupeBy(
        results.flatMap((r) => r.soft?.notEvaluated ?? []), (n) => n.ruleBn),
      // Not recomputed. These are the steps the wizard already marked
      // optional-and-missing, which is exactly §4's warning example.
      setupWarnings: ready.steps
        .filter((step) => step.state === 'warn')
        .map((step) => ({ titleBn: step.titleBn, detailBn: step.detailBn })),
      hardConflicts,
    });

    json(res, 200, {
      ok: true,
      yearId,
      // What the browser actually renders, and nothing else.
      //
      // `blockers` is the solver's own bookkeeping and `soft` is its full
      // violation list — 1,172 sentences on the college profile, 210 kB of a
      // 375 kB response, none of which this screen draws: the trades are
      // already in `explanations`, grouped, and the full list is served by
      // the F-503 explainer from `routines.soft_violations` where the solver
      // persisted it. §1 says not to expose solver internals; on 2G this is
      // also most of a minute for data nothing uses.
      shifts: results.map((r) => ({
        shift: r.shift,
        routineId: r.routineId,
        version: r.version,
        created: r.created,
        totalDemand: r.totalDemand,
        placed: r.placed,
        solverSeconds: r.solverSeconds,
        softViolations: r.soft?.violations?.length ?? 0,
        unplaced: r.unplaced.map(({ blockers, ...rest }) => {
          void blockers;
          return rest;
        }),
        shortages: r.shortages,
        // B-108. Where this draft came from. Without it the screen cannot
        // tell a coordinator why a routine they have not touched already
        // holds five hundred lessons.
        copiedFromVersion: r.copiedFromVersion,
        copiedSlots: r.copiedSlots,
      })),
      summary: summarise(results, hardConflicts, Date.now() - startedAt),
      explanations,
      severity: severityCounts(explanations),
    }, cors);
  } catch (err) {
    if (err instanceof HttpError) {
      json(res, err.status, { error: err.code, message: err.message, ...(err.detail ?? {}) }, cors);
      return;
    }
    const code = (err as { code?: string }).code;
    if (code === 'ROUTINE_NOT_FOUND') {
      json(res, 404, { error: code, message: 'রুটিনটি পাওয়া যায়নি' }, cors); return;
    }
    if (code === 'ROUTINE_NOT_DRAFT' || code === 'NO_TEACHING_PERIODS') {
      json(res, 409, { error: code, message: (err as Error).message }, cors); return;
    }
    console.error('[rms/generate]', err);
    json(res, 500, { error: 'internal_error', message: 'রুটিন তৈরি করা যায়নি' }, cors);
  }
}
