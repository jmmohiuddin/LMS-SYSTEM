/**
 * Greedy-heuristic routine solver.
 *
 * Not a constraint solver (no backtracking, no ILP) — a single deterministic
 * pass that places the highest-demand (section, subject) pairs first, into
 * the earliest free (day, period) slot for both the teacher and the section,
 * preferring a day that subject hasn't already used that week, and skipping
 * anything the teacher has marked unavailable. Whatever it can't place is
 * reported as a soft violation rather than blocking the whole run — a human
 * resolves the leftovers by hand, or fixes the input data and re-runs.
 *
 * Idempotent by design: for each (section, subject) it only tops up
 * (periodsPerWeek - alreadyPlaced) new slots, counting whatever is already
 * active in this routine (pinned or from a prior solver run). Re-running
 * solve() on a partially-filled routine fills gaps instead of duplicating.
 *
 * Cross-shift aware (F-506). A teacher and a room are booked against the
 * whole ACADEMIC YEAR, not against this routine: a two-shift school shares
 * both, and the morning shift's last period overlaps the day shift's first.
 * Two things follow. Existing bookings are loaded from every ACTIVE routine
 * in the year, not just this one; and busy-checks compare TIME INTERVALS
 * rather than period numbers, because morning period 8 and day period 1 are
 * different numbers at the same clock time. Migration 032 makes the database
 * enforce the same thing, and a solver that ignored it would happily produce
 * a routine that cannot be published.
 *
 * Room matching (F-504). A subject that names a required capability —
 * a chemistry practical needing a chemistry lab — is placed into a room
 * that HAS that capability and is free at that hour, not into the
 * section's home classroom. Where no capable room is free, the demand is
 * reported unplaced with the binding shortage in resource terms, which is
 * what §8.2 asks for: "রসায়নের ১২টি ল্যাব পিরিয়ড দরকার; ল্যাব ১-এ ৮টি খালি"
 * rather than "no solution found".
 *
 * Deliberately out of scope for this MVP pass (documented, not accidental):
 *   - class_subjects.double_periods_per_week — every placement is single.
 *   - teacher_leaves — date-specific, doesn't apply to a weekly template.
 *
 * Clash-freedom is guaranteed by routine_slots' three GiST exclusion
 * constraints (teacher/room/section double-booking, see
 * db/migrations/006_routines_rms.sql), not by this file's in-memory
 * bookkeeping — the in-memory maps only avoid hammering the DB with doomed
 * inserts. A 23P01/23505 on insert is still caught and downgraded to a soft
 * violation, the same way SyncPushHandler.applyOne() handles push conflicts.
 */
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import type { Db, TenantContext } from '../../../packages/server-core/src/db.ts';
import {
  evaluateSoftConstraints, type EvaluatedSlot, type SoftConstraintReport,
} from './soft-constraints.ts';

interface TeachingPeriod {
  periodNo: number;
  startsAt: string;
  endsAt: string;
  periodDefinitionId: string;
}

interface Demand {
  sectionId: string;
  subjectId: string;
  teacherId: string;
  periodsPerWeek: number;
  /** subjects.requires_capability — null for an ordinary classroom subject. */
  requiresCapability: string | null;
}

interface Placement {
  sectionId: string;
  subjectId: string;
  teacherId: string;
  dayOfWeek: number;
  periodNo: number;
  periodDefinitionId: string;
  startsAt: string;
  endsAt: string;
  roomId: string | null;
}

export interface UnplacedDemand {
  sectionId: string;
  subjectId: string;
  teacherId: string;
  missing: number;
  /**
   * no_free_slot          — no hour works for this teacher and section
   * no_capable_room       — the school has NO room with the capability
   * no_free_capable_room  — it has one, and it is full
   *
   * The three send a coordinator to three different places, so they are
   * three reasons rather than one.
   */
  reason: string;
  capability?: string;
}

export interface SolveResult {
  routineId: string;
  solverRunId: string;
  totalDemand: number;
  placed: number;
  unplaced: UnplacedDemand[];
  /**
   * F-505. Every soft constraint traded away, named. Separate from
   * `unplaced`, which is a demand that could not be met at all — the two
   * mean different things to a coordinator and §8.2 shows them apart:
   * "কঠিন শর্ত লঙ্ঘন: ০" above "নরম শর্ত ছাড় দেওয়া হয়েছে: ৭".
   */
  soft: SoftConstraintReport;
  /**
   * F-503's infeasibility diagnosis, in the terms §8.2 requires:
   * "রসায়নের ১২টি ল্যাব পিরিয়ড দরকার; ল্যাব ১-এ ৮টি খালি" — not
   * "no solution found". Only capabilities that actually ran short appear.
   */
  shortages: CapabilityShortage[];
  objectiveScore: number;
  solverSeconds: number;
}

export interface CapabilityShortage {
  capability: string;
  /** Periods a week the routine asked for. */
  demandedPeriods: number;
  /** Rooms in the school that have it. Zero is a different problem. */
  capableRooms: number;
  /** Slots those rooms still had free when the solver gave up. */
  freePeriods: number;
  detailBn: string;
}

/**
 * Half-open time intervals per (resource, weekday).
 *
 * Half-open on purpose, and it is the whole reason this class exists rather
 * than a Set of period numbers: a period ending at 12:30 and one starting
 * at 12:30 do NOT overlap. A two-shift school hands over exactly like that,
 * and treating the handover as a clash would make the common timetable
 * unschedulable.
 *
 * Linear scan. A school's week is a few thousand slots; an interval tree
 * here would be a structure nobody could read for no measurable gain.
 */
class IntervalBook {
  private readonly byKey = new Map<string, Array<[string, string]>>();

  add(resourceId: string, day: number, startsAt: string, endsAt: string): void {
    const k = `${resourceId}|${day}`;
    const list = this.byKey.get(k);
    if (list) list.push([startsAt, endsAt]);
    else this.byKey.set(k, [[startsAt, endsAt]]);
  }

  overlaps(resourceId: string, day: number, startsAt: string, endsAt: string): boolean {
    const list = this.byKey.get(`${resourceId}|${day}`);
    if (!list) return false;
    // Times are 'HH:MM:SS' from pg or 'HH:MM' from a period definition, and
    // both compare correctly as strings only if they are the same width.
    const s = norm(startsAt);
    const e = norm(endsAt);
    return list.some(([bs, be]) => s < norm(be) && norm(bs) < e);
  }
}

/** '12:30' and '12:30:00' must compare equal. */
function norm(t: string): string {
  return t.length === 5 ? `${t}:00` : t;
}

/** Returned by pickRoom when no room can host this period. */
const NO_ROOM = Symbol('no-room');

const BN_DIGITS = '০১২৩৪৫৬৭৮৯';
const bnNum = (n: number): string => String(n).replace(/\d/g, (d) => BN_DIGITS[Number(d)]);

export class RmsSolver {
  private readonly db: Db;
  private readonly now: () => number;

  constructor(db: Db, opts: { now?: () => number } = {}) {
    this.db = db;
    this.now = opts.now ?? Date.now;
  }

  async solve(routineId: string, ctx: TenantContext): Promise<SolveResult> {
    const startedAt = this.now();
    return this.db.withTenant(ctx, async (client) => {
      const routine = await this.loadRoutine(client, routineId);
      const teachingDays = this.teachingDays(routine.weekendDays);

      const periods = await this.loadTeachingPeriods(client, routine.periodTemplateId);
      if (periods.length === 0) {
        throw Object.assign(new Error('period template has no teaching periods'), { code: 'NO_TEACHING_PERIODS' });
      }

      const sections = await this.loadSections(client, routine.academicYearId, routine.shift);
      const demand = await this.loadDemand(client, routine.academicYearId, routine.shift);
      const existing = await this.loadExistingSlots(client, routineId, routine.academicYearId);
      const unavailability = await this.loadUnavailability(client, [...new Set(demand.map((d) => d.teacherId))]);

      // F-506. Bookings are held as TIME INTERVALS per (resource, day), not
      // as period numbers: morning period 8 and day period 1 are different
      // numbers covering the same clock time, and a period-keyed set would
      // call both free.
      const teacherBusy = new IntervalBook();
      const roomBusy = new IntervalBook();
      const sectionBusy = new IntervalBook();
      const sectionSubjectDays = new Map<string, Set<number>>();
      const placedCount = new Map<string, number>();

      for (const row of existing) {
        if (row.teacher_id) teacherBusy.add(row.teacher_id, row.day_of_week, row.starts_at, row.ends_at);
        if (row.room_id) roomBusy.add(row.room_id, row.day_of_week, row.starts_at, row.ends_at);
        // Only THIS routine's slots constrain the section and count toward
        // what is already placed. The other shift's sections are not ours,
        // and counting their periods would leave our own demand short.
        if (!row.is_mine) continue;
        sectionBusy.add(row.primary_section_id, row.day_of_week, row.starts_at, row.ends_at);
        const ssKey = `${row.primary_section_id}|${row.subject_id}`;
        if (!sectionSubjectDays.has(ssKey)) sectionSubjectDays.set(ssKey, new Set());
        sectionSubjectDays.get(ssKey)!.add(row.day_of_week);
        placedCount.set(ssKey, (placedCount.get(ssKey) ?? 0) + 1);
      }

      const roomBySection = new Map(sections.map((s) => [s.id, s.homeRoomId]));

      // F-504. Rooms that carry each capability a subject in this routine
      // asks for. Loaded once: a school has thirty rooms and the set does
      // not change during a solve.
      const wantedCaps = [...new Set(demand.map((d) => d.requiresCapability).filter(Boolean))] as string[];
      const roomsByCapability = await this.loadCapableRooms(client, wantedCaps);

      const isUnavailable = (teacherId: string, day: number, startsAt: string, endsAt: string): boolean => {
        const rows = unavailability.get(teacherId);
        if (!rows) return false;
        return rows.some((u) => u.dayOfWeek === day && u.startsAt < endsAt && u.endsAt > startsAt);
      };

      const placements: Placement[] = [];
      const unplaced: UnplacedDemand[] = [];

      // Most-frequent subjects first — they're the hardest to fit once the
      // week fills up, so give them first pick of open slots.
      const sorted = [...demand].sort((a, b) => b.periodsPerWeek - a.periodsPerWeek);

      for (const d of sorted) {
        const ssKey = `${d.sectionId}|${d.subjectId}`;
        const already = placedCount.get(ssKey) ?? 0;
        const remaining = Math.max(0, d.periodsPerWeek - already);
        let placedForThis = 0;

        for (let i = 0; i < remaining; i++) {
          const usedDays = sectionSubjectDays.get(ssKey) ?? new Set<number>();
          let found: { day: number; period: TeachingPeriod; roomId: string | null } | null = null;

          // Pass 1: prefer a day this (section, subject) hasn't used yet, to
          // spread occurrences across the week. Pass 2: allow any day if
          // pass 1 comes up empty (a subject with periodsPerWeek > teaching
          // days must repeat a day eventually).
          for (const preferUnusedDay of [true, false]) {
            for (const day of teachingDays) {
              if (preferUnusedDay && usedDays.has(day)) continue;
              for (const period of periods) {
                if (teacherBusy.overlaps(d.teacherId, day, period.startsAt, period.endsAt)) continue;
                if (sectionBusy.overlaps(d.sectionId, day, period.startsAt, period.endsAt)) continue;
                if (isUnavailable(d.teacherId, day, period.startsAt, period.endsAt)) continue;

                // F-504. A subject that names a capability goes in a room
                // that HAS it — a chemistry practical belongs in a
                // chemistry lab, not in the section's classroom because
                // that is where the section usually sits.
                //
                // The room constraint spans shifts (F-506), and a
                // two-shift school shares its rooms, so freedom is checked
                // against the whole year rather than this routine.
                const room = this.pickRoom(
                  d, roomBySection, roomsByCapability, roomBusy, day, period);
                if (room === NO_ROOM) continue;

                found = { day, period, roomId: room };
                break;
              }
              if (found) break;
            }
            if (found) break;
          }

          if (!found) break;

          const { day, period, roomId } = found;
          teacherBusy.add(d.teacherId, day, period.startsAt, period.endsAt);
          sectionBusy.add(d.sectionId, day, period.startsAt, period.endsAt);
          if (roomId) roomBusy.add(roomId, day, period.startsAt, period.endsAt);
          if (!sectionSubjectDays.has(ssKey)) sectionSubjectDays.set(ssKey, new Set());
          sectionSubjectDays.get(ssKey)!.add(day);

          placements.push({
            sectionId: d.sectionId,
            subjectId: d.subjectId,
            teacherId: d.teacherId,
            dayOfWeek: day,
            periodNo: period.periodNo,
            periodDefinitionId: period.periodDefinitionId,
            startsAt: period.startsAt,
            endsAt: period.endsAt,
            roomId,
          });
          placedForThis++;
        }

        if (placedForThis < remaining) {
          // Which shortage stopped it matters: "no hour is free" sends a
          // coordinator to the timetable, "no lab is free" sends them to
          // the room register or to the builders. Reporting both as
          // no_free_slot would send them to the wrong place.
          const capped = d.requiresCapability !== null
            && (roomsByCapability.get(d.requiresCapability)?.length ?? 0) > 0;
          unplaced.push({
            sectionId: d.sectionId,
            subjectId: d.subjectId,
            teacherId: d.teacherId,
            missing: remaining - placedForThis,
            reason: d.requiresCapability === null ? 'no_free_slot'
                  : capped ? 'no_free_capable_room' : 'no_capable_room',
            ...(d.requiresCapability ? { capability: d.requiresCapability } : {}),
          });
        }
      }

      let inserted = 0;
      // The ones that actually landed. `placements` is what we intended;
      // a slice of it by count would silently include a row the database
      // rejected, and the soft-constraint report would then describe a
      // timetable that does not exist.
      const written: Placement[] = [];
      for (const p of placements) {
        try {
          await client.query(
            `INSERT INTO routine_slots
               (tenant_id, routine_id, day_of_week, period_no, period_definition_id,
                starts_at, ends_at, slot_kind, primary_section_id, subject_id, teacher_id, room_id)
             VALUES (app.current_tenant(), $1, $2, $3, $4, $5, $6, 'teaching', $7, $8, $9, $10)`,
            [
              routineId,
              p.dayOfWeek,
              p.periodNo,
              p.periodDefinitionId,
              p.startsAt,
              p.endsAt,
              p.sectionId,
              p.subjectId,
              p.teacherId,
              p.roomId,
            ],
          );
          inserted++;
          written.push(p);
        } catch (err) {
          const code = (err as { code?: string }).code;
          if (code === '23P01' || code === '23505') {
            unplaced.push({
              sectionId: p.sectionId,
              subjectId: p.subjectId,
              teacherId: p.teacherId,
              missing: 1,
              reason: 'db_conflict',
            });
            continue;
          }
          throw err;
        }
      }

      // F-505. Evaluated over the routine as it now stands — this run's
      // placements PLUS whatever was already there — because a coordinator
      // reading the report cares about the timetable, not about which pass
      // wrote which row.
      const finalSlots: EvaluatedSlot[] = [
        ...existing.filter((r) => r.is_mine).map((r) => ({
          dayOfWeek: r.day_of_week, periodNo: r.period_no,
          startsAt: r.starts_at, endsAt: r.ends_at,
          sectionId: r.primary_section_id, subjectId: r.subject_id,
          teacherId: r.teacher_id, roomId: r.room_id,
        })),
        ...written.map((p) => ({
          dayOfWeek: p.dayOfWeek, periodNo: p.periodNo,
          startsAt: p.startsAt, endsAt: p.endsAt,
          sectionId: p.sectionId, subjectId: p.subjectId,
          teacherId: p.teacherId, roomId: p.roomId,
        })),
      ];
      const soft = evaluateSoftConstraints({
        slots: finalSlots,
        teachingDayCount: teachingDays.length,
        ...(await this.loadSoftContext(client, finalSlots)),
      });

      // F-503 / §8.2. Only for capabilities that actually blocked
      // something — a school with a spare lab does not need to be told
      // about it, and a report full of non-problems is one nobody reads.
      const shortages: CapabilityShortage[] = [];
      for (const cap of new Set(unplaced.map((u) => u.capability).filter(Boolean) as string[])) {
        const rooms = roomsByCapability.get(cap) ?? [];
        let free = 0;
        for (const roomId of rooms) {
          for (const day of teachingDays) {
            for (const p of periods) {
              if (!roomBusy.overlaps(roomId, day, p.startsAt, p.endsAt)) free++;
            }
          }
        }
        const demanded = demand
          .filter((d) => d.requiresCapability === cap)
          .reduce((sum, d) => sum + d.periodsPerWeek, 0);
        shortages.push({
          capability: cap,
          demandedPeriods: demanded,
          capableRooms: rooms.length,
          freePeriods: free,
          detailBn: rooms.length === 0
            // The two say different things to a coordinator: one is a
            // timetable problem, the other is a building problem.
            ? `"${cap}" সুবিধাসম্পন্ন কোনো কক্ষ নেই — ${bnNum(demanded)}টি পিরিয়ড দরকার`
            : `"${cap}" কক্ষে ${bnNum(demanded)}টি পিরিয়ড দরকার; `
              + `${bnNum(rooms.length)}টি কক্ষে ${bnNum(free)}টি খালি`,
        });
      }

      const totalDemand = demand.reduce((sum, d) => sum + d.periodsPerWeek, 0);
      // Only THIS routine's slots count as placed. `existing` now also
      // carries the other shift's, which constrain placement but are not
      // this routine's work — counting them would report a day-shift
      // routine as complete because the morning shift is.
      const totalPlaced = existing.filter((r) => r.is_mine).length + inserted;
      const objectiveScore = totalDemand > 0 ? Math.round((totalPlaced / totalDemand) * 10000) / 100 : 100;
      const solverRunId = randomUUID();
      const solverSeconds = Math.round(((this.now() - startedAt) / 1000) * 100) / 100;

      await client.query(
        `UPDATE routines
            SET generated_by = 'solver', solver_run_id = $2, solver_seconds = $3,
                objective_score = $4, soft_violations = $5::jsonb, updated_at = now()
          WHERE id = $1`,
        // Both lists are persisted, because §8.2 is a screen a coordinator
        // comes back to after the run — a report that lives only in one
        // HTTP response has already failed the "nothing silently accepted"
        // requirement the moment they close the tab.
        [routineId, solverRunId, solverSeconds, objectiveScore,
         JSON.stringify({ unplaced, soft: soft.violations,
                          notEvaluated: soft.notEvaluated, shortages })],
      );

      return {
        routineId, solverRunId, totalDemand, placed: totalPlaced,
        unplaced, soft, shortages, objectiveScore, solverSeconds,
      };
    });
  }

  /**
   * Names and caps for the soft-constraint report.
   *
   * Loaded AFTER placement and only for the people and things that appear
   * in it — a school of 45 teachers and 30 rooms has no reason to ship the
   * whole staff register into a report about four of them.
   */
  private async loadSoftContext(client: pg.PoolClient, slots: EvaluatedSlot[]) {
    const teacherIds = [...new Set(slots.map((s) => s.teacherId))];
    const sectionIds = [...new Set(slots.map((s) => s.sectionId))];
    const subjectIds = [...new Set(slots.map((s) => s.subjectId))];

    const limits = new Map<string, { maxPerWeek: number; maxPerDay: number }>();
    const teacherNames = new Map<string, string>();
    if (teacherIds.length > 0) {
      const { rows } = await client.query<{
        user_id: string; full_name_bn: string;
        max_periods_per_week: number; max_periods_per_day: number;
      }>(
        `SELECT u.id AS user_id, u.full_name_bn,
                sp.max_periods_per_week, sp.max_periods_per_day
           FROM users u
           LEFT JOIN staff_profiles sp ON sp.user_id = u.id
          WHERE u.id = ANY($1::uuid[])`,
        [teacherIds],
      );
      for (const r of rows) {
        teacherNames.set(r.user_id, r.full_name_bn);
        // A teacher with no staff_profile has no configured cap, and is
        // therefore not judged against an invented one.
        if (r.max_periods_per_week !== null) {
          limits.set(r.user_id, {
            maxPerWeek: r.max_periods_per_week, maxPerDay: r.max_periods_per_day,
          });
        }
      }
    }

    const sectionNames = new Map<string, string>();
    if (sectionIds.length > 0) {
      const { rows } = await client.query<{ id: string; label: string }>(
        `SELECT s.id, c.name_bn || '–' || s.name AS label
           FROM sections s JOIN classes c ON c.id = s.class_id
          WHERE s.id = ANY($1::uuid[])`,
        [sectionIds],
      );
      for (const r of rows) sectionNames.set(r.id, r.label);
    }

    const subjectNames = new Map<string, string>();
    const competentTeacherCount = new Map<string, number>();
    if (subjectIds.length > 0) {
      const { rows } = await client.query<{ id: string; name_bn: string; competent: string }>(
        `SELECT s.id, s.name_bn,
                (SELECT count(*) FROM teacher_competencies tc
                  WHERE tc.subject_id = s.id AND tc.is_active) AS competent
           FROM subjects s WHERE s.id = ANY($1::uuid[])`,
        [subjectIds],
      );
      for (const r of rows) {
        subjectNames.set(r.id, r.name_bn);
        competentTeacherCount.set(r.id, Number(r.competent));
      }
    }

    return { limits, teacherNames, sectionNames, subjectNames, competentTeacherCount };
  }

  private async loadRoutine(client: pg.PoolClient, routineId: string) {
    const { rows } = await client.query<{
      id: string;
      academic_year_id: string;
      shift: string;
      period_template_id: string;
      status: string;
    }>(`SELECT id, academic_year_id, shift, period_template_id, status FROM routines WHERE id = $1`, [routineId]);
    const routine = rows[0];
    if (!routine) throw Object.assign(new Error('routine not found'), { code: 'ROUTINE_NOT_FOUND' });
    if (routine.status !== 'draft') {
      throw Object.assign(new Error('only draft routines can be solved'), { code: 'ROUTINE_NOT_DRAFT' });
    }

    const tenantRes = await client.query<{ weekend_days: number[] }>(
      `SELECT weekend_days FROM tenants WHERE id = app.current_tenant()`,
    );

    return {
      academicYearId: routine.academic_year_id,
      shift: routine.shift,
      periodTemplateId: routine.period_template_id,
      weekendDays: new Set(tenantRes.rows[0]?.weekend_days ?? [5, 6]),
    };
  }

  private teachingDays(weekendDays: Set<number>): number[] {
    const days: number[] = [];
    for (let d = 0; d <= 6; d++) if (!weekendDays.has(d)) days.push(d);
    return days;
  }

  private async loadTeachingPeriods(client: pg.PoolClient, templateId: string): Promise<TeachingPeriod[]> {
    const { rows } = await client.query<{ id: string; period_no: number; starts_at: string; ends_at: string }>(
      `SELECT id, period_no, starts_at, ends_at FROM period_definitions
        WHERE template_id = $1 AND kind = 'teaching' ORDER BY period_no`,
      [templateId],
    );
    return rows.map((r) => ({
      periodNo: r.period_no,
      startsAt: r.starts_at,
      endsAt: r.ends_at,
      periodDefinitionId: r.id,
    }));
  }

  /**
   * Which room this demand can use at this hour, or NO_ROOM.
   *
   * Two different questions wearing one name. A subject with a required
   * capability needs a room that HAS it and is free; an ordinary subject
   * uses the section's home room, and a section with no home room is
   * placed roomless rather than refused — small schools genuinely run
   * that way, and a null room_id is honest about it.
   */
  private pickRoom(
    d: Demand,
    roomBySection: Map<string, string | null>,
    roomsByCapability: Map<string, string[]>,
    roomBusy: IntervalBook,
    day: number,
    period: TeachingPeriod,
  ): string | null | typeof NO_ROOM {
    if (d.requiresCapability === null) {
      const home = roomBySection.get(d.sectionId) ?? null;
      if (home === null) return null;   // no home room recorded; place it roomless
      return roomBusy.overlaps(home, day, period.startsAt, period.endsAt) ? NO_ROOM : home;
    }

    const candidates = roomsByCapability.get(d.requiresCapability) ?? [];
    for (const roomId of candidates) {
      if (!roomBusy.overlaps(roomId, day, period.startsAt, period.endsAt)) return roomId;
    }
    // A capability subject is never dropped into an ordinary classroom as
    // a fallback. A chemistry practical in a room with no gas or water is
    // not a lesson that happened.
    return NO_ROOM;
  }

  /**
   * capability → room ids that have it, in a stable order.
   *
   * Ordered by code so a re-run fills the same lab first: §8.2 requires
   * that "regenerating after one change must not reshuffle the whole
   * school".
   */
  private async loadCapableRooms(
    client: pg.PoolClient,
    capabilities: string[],
  ): Promise<Map<string, string[]>> {
    const map = new Map<string, string[]>();
    if (capabilities.length === 0) return map;
    const { rows } = await client.query<{ capability: string; id: string }>(
      `SELECT cap AS capability, r.id
         FROM unnest($1::text[]) AS cap
         JOIN rooms r ON cap = ANY(r.capabilities) AND r.is_bookable
        ORDER BY cap, r.code`,
      [capabilities],
    );
    for (const r of rows) {
      const list = map.get(r.capability);
      if (list) list.push(r.id);
      else map.set(r.capability, [r.id]);
    }
    // A capability nobody has still gets an entry, so the caller can tell
    // "no such room exists" from "they are all busy".
    for (const c of capabilities) if (!map.has(c)) map.set(c, []);
    return map;
  }

  private async loadSections(
    client: pg.PoolClient,
    academicYearId: string,
    shift: string,
  ): Promise<Array<{ id: string; homeRoomId: string | null }>> {
    const { rows } = await client.query<{ id: string; home_room_id: string | null }>(
      `SELECT id, home_room_id FROM sections WHERE academic_year_id = $1 AND shift = $2`,
      [academicYearId, shift],
    );
    return rows.map((r) => ({ id: r.id, homeRoomId: r.home_room_id }));
  }

  private async loadDemand(client: pg.PoolClient, academicYearId: string, shift: string): Promise<Demand[]> {
    const { rows } = await client.query<{
      section_id: string;
      subject_id: string;
      teacher_id: string;
      periods_per_week: number;
      requires_capability: string | null;
    }>(
      `SELECT sst.section_id, sst.subject_id, sst.teacher_id, cs.periods_per_week,
              sub.requires_capability
         FROM section_subject_teachers sst
         JOIN sections s ON s.id = sst.section_id
         JOIN subjects sub ON sub.id = sst.subject_id
         JOIN class_subjects cs ON cs.class_id = s.class_id
          AND cs.subject_id = sst.subject_id AND cs.academic_year_id = sst.academic_year_id
        WHERE sst.academic_year_id = $1 AND s.shift = $2`,
      [academicYearId, shift],
    );
    return rows.map((r) => ({
      sectionId: r.section_id,
      subjectId: r.subject_id,
      teacherId: r.teacher_id,
      periodsPerWeek: r.periods_per_week,
      requiresCapability: r.requires_capability,
    }));
  }

  private async loadExistingSlots(
    client: pg.PoolClient, routineId: string, academicYearId: string,
  ) {
    const { rows } = await client.query<{
      primary_section_id: string;
      subject_id: string;
      teacher_id: string;
      day_of_week: number;
      period_no: number;
      starts_at: string;
      ends_at: string;
      room_id: string | null;
      is_mine: boolean;
    }>(
      // F-506. This routine's own slots, PLUS every slot in any other
      // ACTIVE routine for the same year — which is the other shift. A
      // teacher booked in the morning is not free in the afternoon just
      // because a different routine_id owns that hour.
      `SELECT rs.primary_section_id, rs.subject_id, rs.teacher_id, rs.day_of_week,
              rs.period_no, rs.starts_at, rs.ends_at, rs.room_id,
              (rs.routine_id = $1) AS is_mine
         FROM routine_slots rs
        WHERE rs.academic_year_id = $2
          AND rs.status = 'active'
          AND rs.slot_kind = 'teaching'
          AND (rs.routine_id = $1 OR rs.routine_status = 'active')`,
      [routineId, academicYearId],
    );
    return rows;
  }

  private async loadUnavailability(
    client: pg.PoolClient,
    teacherIds: string[],
  ): Promise<Map<string, Array<{ dayOfWeek: number; startsAt: string; endsAt: string }>>> {
    const map = new Map<string, Array<{ dayOfWeek: number; startsAt: string; endsAt: string }>>();
    if (teacherIds.length === 0) return map;
    const { rows } = await client.query<{
      teacher_id: string;
      day_of_week: number;
      starts_at: string;
      ends_at: string;
    }>(
      `SELECT teacher_id, day_of_week, starts_at, ends_at FROM teacher_availability
        WHERE teacher_id = ANY($1) AND kind = 'unavailable'`,
      [teacherIds],
    );
    for (const r of rows) {
      if (!map.has(r.teacher_id)) map.set(r.teacher_id, []);
      map.get(r.teacher_id)!.push({ dayOfWeek: r.day_of_week, startsAt: r.starts_at, endsAt: r.ends_at });
    }
    return map;
  }
}
