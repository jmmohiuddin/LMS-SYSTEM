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
 * Deliberately out of scope for this MVP pass (documented, not accidental):
 *   - class_subjects.double_periods_per_week — every placement is single.
 *   - subjects.requires_capability vs rooms.capabilities — every placement
 *     uses the section's home_room_id verbatim, no room-matching search.
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
  reason: string;
}

export interface SolveResult {
  routineId: string;
  solverRunId: string;
  totalDemand: number;
  placed: number;
  unplaced: UnplacedDemand[];
  objectiveScore: number;
  solverSeconds: number;
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
          let found: { day: number; period: TeachingPeriod } | null = null;

          // Pass 1: prefer a day this (section, subject) hasn't used yet, to
          // spread occurrences across the week. Pass 2: allow any day if
          // pass 1 comes up empty (a subject with periodsPerWeek > teaching
          // days must repeat a day eventually).
          for (const preferUnusedDay of [true, false]) {
            for (const day of teachingDays) {
              if (preferUnusedDay && usedDays.has(day)) continue;
              for (const period of periods) {
                const room = roomBySection.get(d.sectionId) ?? null;
                if (teacherBusy.overlaps(d.teacherId, day, period.startsAt, period.endsAt)) continue;
                if (sectionBusy.overlaps(d.sectionId, day, period.startsAt, period.endsAt)) continue;
                // The room constraint spans shifts too, and a two-shift
                // school shares rooms. Skipping this only moved the failure
                // to the INSERT, where it became a soft violation instead of
                // a placement somewhere else that would have worked.
                if (room && roomBusy.overlaps(room, day, period.startsAt, period.endsAt)) continue;
                if (isUnavailable(d.teacherId, day, period.startsAt, period.endsAt)) continue;
                found = { day, period };
                break;
              }
              if (found) break;
            }
            if (found) break;
          }

          if (!found) break;

          const { day, period } = found;
          const roomId = roomBySection.get(d.sectionId) ?? null;
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
          unplaced.push({
            sectionId: d.sectionId,
            subjectId: d.subjectId,
            teacherId: d.teacherId,
            missing: remaining - placedForThis,
            reason: 'no_free_slot',
          });
        }
      }

      let inserted = 0;
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
        [routineId, solverRunId, solverSeconds, objectiveScore, JSON.stringify(unplaced)],
      );

      return { routineId, solverRunId, totalDemand, placed: totalPlaced, unplaced, objectiveScore, solverSeconds };
    });
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
    }>(
      `SELECT sst.section_id, sst.subject_id, sst.teacher_id, cs.periods_per_week
         FROM section_subject_teachers sst
         JOIN sections s ON s.id = sst.section_id
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
