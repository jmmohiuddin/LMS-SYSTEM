/**
 * Is this routine safe to publish, and what would publishing mean?  (P9-7)
 *
 * ── One gate, two callers ────────────────────────────────────────────────
 * The review screen asks it to draw a verdict; the publish endpoint asks it
 * to decide. Both go through here, so the screen cannot say "safe" about a
 * routine the server would refuse, and the server cannot refuse for a reason
 * the screen never showed. A second copy of these rules is the defect this
 * file exists to prevent — and P9-4 already found that shape twice, in two
 * readers of the same routines disagreeing about hard conflicts.
 *
 * ── What blocks, and what merely warns ───────────────────────────────────
 * BLOCKING is reserved for what makes a routine unusable or unstorable:
 *
 *   a hard conflict — one teacher, room or section in two places at one hour.
 *   The database refuses these at publish anyway, when
 *   `trg_routines_propagate_status` flips every slot to
 *   `routine_status = 'active'` and the year-scoped exclusions bite at once.
 *   Counting them HERE means a coordinator learns before they press the
 *   button, with the number in front of them, rather than from a 409.
 *
 *   an empty routine. Publishing nothing replaces a school's timetable with
 *   nothing, which no school ever means to do.
 *
 * There is deliberately NO "these lessons have no teacher" warning.
 * `routine_slots` has carried `CHECK (slot_kind <> 'teaching' OR ... teacher_id
 * IS NOT NULL)` since migration 006, so a teaching slot without a teacher
 * cannot exist and a count of them is a tautology, not a measurement. The gap
 * a school actually has is a DEMAND the solver could not place, which is the
 * `unplaced` warning below. (The old `unfilled` count reported the tautology
 * as a finding; the only place its sentence had ever appeared was the demo,
 * which hard-coded the state the schema forbids.)
 *
 * WARNINGS do not block, and that is the existing contract rather than a new
 * decision: §8.1 marks gaps ⚠ and permits publishing over them, because a
 * school routinely publishes a timetable with a known hole while it hires.
 * Turning that into a blocker would stop schools using the product for a
 * situation the product is meant to survive.
 *
 * ── The fingerprint ──────────────────────────────────────────────────────
 * Reused from P9-6 rather than reinvented: `count(*) || ':' ||
 * sum(row_version)` over the routine's active slots. The review screen shows
 * a routine; if somebody edits it between the reading and the publishing,
 * the person is approving something they did not see.
 */
import type pg from 'pg';
import { fingerprint } from './rescope.ts';

type Client = Pick<pg.PoolClient, 'query'>;

const BN_DIGITS = '০১২৩৪৫৬৭৮৯';
const bn = (n: number): string => String(n).replace(/[0-9]/g, (d) => BN_DIGITS[Number(d)]);

/** Statuses a routine may be published FROM. Published history is immutable. */
export const PUBLISHABLE = new Set(['draft', 'review']);

export interface Finding {
  /** Machine code for tests and telemetry. Never rendered. */
  code: string;
  /** The sentence a coordinator reads. */
  messageBn: string;
  /** What to do about it, when there is something to do. */
  actionBn?: string;
}

export interface PublishReview {
  routineId: string;
  status: string;
  version: number;
  shift: string;
  nameBn: string;
  yearLabel: string;
  /** Slots that would go live. */
  slots: number;
  sections: number;
  teachers: number;
  /** Locked slots, which a coordinator deliberately protected. */
  pinned: number;
  hardConflicts: number;
  softViolations: number;
  unplacedDemands: number;
  lastModified: string | null;
  fingerprint: string;
  blockers: Finding[];
  warnings: Finding[];
  canPublish: boolean;
}

/**
 * Count teacher, room and section double-bookings in what is stored.
 *
 * The same one-pass window scan `generate.ts` uses, for the same reason: the
 * pairwise self-join is quadratic and the partial GiST indexes cannot help
 * it, because a draft is not `routine_status = 'active'`.
 */
async function countHardConflicts(c: Client, routineId: string): Promise<number> {
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
         FROM routine_slots WHERE routine_id = $1 AND status = 'active'
     )
     SELECT (
        (${clash('teacher_id, day_of_week',
                 `teacher_id IS NOT NULL AND slot_kind IN ('teaching','exam')`)})
      + (${clash('room_id, day_of_week',
                 `room_id IS NOT NULL AND slot_kind IN ('teaching','exam')`)})
      + (${clash('routine_id, primary_section_id, day_of_week',
                 'primary_section_id IS NOT NULL AND parallel_pool IS NULL')})
     )::text AS n`,
    [routineId]);
  return Number(rows[0]?.n ?? 0);
}

/**
 * Everything the review screen shows and the publish endpoint decides on.
 *
 * Returns `null` when the routine does not exist or is not visible — the
 * caller turns that into a 404, and RLS is what makes the two the same thing
 * for a school looking at somebody else's id.
 */
export async function reviewRoutine(
  c: Client, routineId: string,
): Promise<PublishReview | null> {
  const { rows } = await c.query<{
    id: string; status: string; version: number; shift: string; name_bn: string;
    year_label: string; slots: string; sections: string; teachers: string;
    pinned: string; last_modified: string | null;
    soft: unknown;
  }>(
    `SELECT r.id, r.status::text AS status, r.version, r.shift::text AS shift,
            r.name_bn, y.label AS year_label, r.soft_violations AS soft,
            (SELECT count(*) FROM routine_slots s
              WHERE s.routine_id = r.id AND s.status = 'active')::text AS slots,
            (SELECT count(DISTINCT s.primary_section_id) FROM routine_slots s
              WHERE s.routine_id = r.id AND s.status = 'active')::text AS sections,
            (SELECT count(DISTINCT s.teacher_id) FROM routine_slots s
              WHERE s.routine_id = r.id AND s.status = 'active'
                AND s.teacher_id IS NOT NULL)::text AS teachers,
            (SELECT count(*) FROM routine_slots s
              WHERE s.routine_id = r.id AND s.status = 'active'
                AND s.is_pinned)::text AS pinned,
            -- ISO 8601, not the plain ::text cast this used first: Postgres
            -- renders a timestamptz with a TWO-digit offset (+00), which is
            -- not valid ISO and which new Date() refuses in Chrome — so the
            -- review screen printed an em-dash for every timestamp.
            -- (Backticks are also deliberately absent: this comment lives
            -- inside a JS template literal, and one would end the string.)
            (SELECT to_char(max(s.updated_at) AT TIME ZONE 'UTC',
                            'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
               FROM routine_slots s WHERE s.routine_id = r.id) AS last_modified
       FROM routines r
       JOIN academic_years y ON y.id = r.academic_year_id
      WHERE r.id = $1`,
    [routineId]);
  const r = rows[0];
  if (!r) return null;

  const stored = (r.soft ?? {}) as {
    soft?: unknown[]; unplaced?: unknown[];
  };
  const hardConflicts = await countHardConflicts(c, routineId);
  const slots = Number(r.slots);
  const unplacedDemands = Array.isArray(stored.unplaced) ? stored.unplaced.length : 0;
  const softViolations = Array.isArray(stored.soft) ? stored.soft.length : 0;

  const blockers: Finding[] = [];
  const warnings: Finding[] = [];

  if (!PUBLISHABLE.has(r.status)) {
    blockers.push({
      code: 'already_published',
      messageBn: 'এই রুটিন আগেই প্রকাশিত।',
      actionBn: 'বদলাতে হলে নতুন খসড়া তৈরি করুন।',
    });
  }
  if (hardConflicts > 0) {
    blockers.push({
      code: 'hard_conflict',
      messageBn: `${bn(hardConflicts)}টি ক্লাস একই সময়ে একই শিক্ষক, কক্ষ বা শাখার `
               + 'সঙ্গে পড়ে গেছে।',
      actionBn: 'রুটিন সম্পাদনা পাতায় গিয়ে সংঘর্ষগুলো সরান — তারপর প্রকাশ করা যাবে।',
    });
  }
  if (slots === 0) {
    blockers.push({
      code: 'empty_routine',
      messageBn: 'এই রুটিনে একটিও ক্লাস নেই।',
      actionBn: 'আগে রুটিন তৈরি করুন।',
    });
  }

  if (unplacedDemands > 0) {
    warnings.push({
      code: 'unplaced',
      messageBn: `${bn(unplacedDemands)}টি বিষয়ের কিছু পিরিয়ড বসানো যায়নি।`,
      actionBn: 'প্রকাশ করা যাবে, তবে ওই বিষয়গুলো সপ্তাহে কম পড়বে।',
    });
  }
  if (softViolations > 0) {
    warnings.push({
      code: 'soft',
      messageBn: `${bn(softViolations)}টি ক্ষেত্রে পছন্দের নিয়ম ছাড় দিতে হয়েছে।`,
      actionBn: 'রুটিন চলবে — বিস্তারিত ব্যাখ্যায় কী ছাড় দেওয়া হয়েছে দেখা যাবে।',
    });
  }

  return {
    routineId: r.id,
    status: r.status,
    version: r.version,
    shift: r.shift,
    nameBn: r.name_bn,
    yearLabel: r.year_label,
    slots,
    sections: Number(r.sections),
    teachers: Number(r.teachers),
    pinned: Number(r.pinned),
    hardConflicts,
    softViolations,
    unplacedDemands,
    lastModified: r.last_modified,
    fingerprint: await fingerprint(c, routineId),
    blockers,
    warnings,
    canPublish: blockers.length === 0,
  };
}
