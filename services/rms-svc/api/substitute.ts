/**
 * POST /api/v1/rms/substitute
 * Body: { slotId, date }                          → ranked candidate list
 * Body: { slotId, date, assign: true,
 *         substituteTeacherId, reason? }          → writes the substitution
 *
 * The substitution engine of docs/02-RMS-DEEP-DIVE.md §5, as one endpoint:
 * find ranks every teacher who passes the hard candidate filter (§5.1) by
 * the scoring model (§5.2); assign inserts the routine_substitutions row.
 *
 * Layered safety, matching the rest of the RMS: this endpoint's filter is
 * the *advisory* layer — the app.check_substitute_free() trigger
 * (db/migrations/006_routines_rms.sql) re-checks freedom at INSERT time, so
 * a stale candidate list can produce a clean 409 here but never a
 * double-booked teacher in the database. requireRole mirrors
 * substitution_write_scope in 010_rls_policies.sql.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { sharedDb } from '../../../packages/server-core/src/db.ts';
import { corsHeaders, readJson, json, HttpError } from '../../../packages/server-core/src/http.ts';
import { authenticate, requireRole } from '../../../packages/server-core/src/auth.ts';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const SUB_ROLES = ['principal', 'school_owner', 'academic_coordinator', 'dept_head'];

interface SubstituteBody {
  slotId?: string;
  date?: string;
  assign?: boolean;
  substituteTeacherId?: string;
  reason?: string;
}

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const cors = corsHeaders();
  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors);
    res.end();
    return;
  }
  if (req.method !== 'POST') {
    json(res, 405, { error: 'method_not_allowed' }, cors);
    return;
  }

  try {
    const claims = await authenticate(req);
    requireRole(claims, SUB_ROLES);

    const body = await readJson<SubstituteBody>(req);
    const slotId = body.slotId ?? '';
    const date = body.date ?? '';
    if (!UUID_RE.test(slotId)) throw new HttpError(400, 'slotId must be a valid uuid', 'invalid_slot_id');
    if (!DATE_RE.test(date)) throw new HttpError(400, 'date must be YYYY-MM-DD', 'invalid_date');

    const db = await sharedDb();
    const ctx = { tenantId: claims.tid, userId: claims.sub, role: claims.role };

    if (body.assign) {
      const substituteTeacherId = body.substituteTeacherId ?? '';
      if (!UUID_RE.test(substituteTeacherId)) {
        throw new HttpError(400, 'substituteTeacherId must be a valid uuid', 'invalid_substitute_teacher_id');
      }
      const result = await db.withTenant(ctx, async (client) => {
        const slot = await client.query<{ teacher_id: string }>(
          `SELECT teacher_id FROM routine_slots WHERE id = $1`,
          [slotId],
        );
        if (!slot.rows[0]) throw new HttpError(404, 'slot not found', 'slot_not_found');
        const inserted = await client.query<{ id: string }>(
          `INSERT INTO routine_substitutions
             (tenant_id, slot_id, substitution_date, action,
              original_teacher_id, substitute_teacher_id, reason,
              assignment_mode, status, assigned_by)
           VALUES (app.current_tenant(), $1, $2, 'assign', $3, $4, $5, 'manual', 'assigned', $6)
           RETURNING id`,
          [slotId, date, slot.rows[0].teacher_id, substituteTeacherId, body.reason ?? null, claims.sub],
        );
        return { substitutionId: inserted.rows[0].id };
      });
      json(res, 200, { ok: true, ...result }, cors);
      return;
    }

    const candidates = await db.withTenant(ctx, async (client) => {
      const slot = await client.query<{
        teacher_id: string; subject_id: string | null; time_range: string; day_of_week: number;
      }>(
        `SELECT teacher_id, subject_id, time_range, day_of_week
           FROM routine_slots WHERE id = $1`,
        [slotId],
      );
      if (!slot.rows[0]) throw new HttpError(404, 'slot not found', 'slot_not_found');
      const s = slot.rows[0];

      // Hard filter (02 §5.1): active staff, not the absentee, not teaching
      // or substituting in an overlapping period that day, not on approved
      // leave, not marked unavailable. Ranking (02 §5.2): subject expertise,
      // then lightest same-day load, then fewest recent substitutions.
      const r = await client.query<{
        teacher_id: string;
        full_name_bn: string | null;
        full_name_en: string | null;
        teaches_subject: boolean;
        load_today: number;
        subs_last_30d: number;
      }>(
        `WITH slot_ctx AS (
           SELECT $2::uuid AS subject_id, $3::timerange AS tr, $4::smallint AS dow, $5::date AS d
         ),
         teachers AS (
           SELECT DISTINCT u.id, u.full_name_bn, u.full_name_en
             FROM users u
             JOIN user_roles ur ON ur.user_id = u.id
            WHERE ur.role_code IN ('class_teacher','subject_teacher','dept_head','academic_coordinator')
              AND u.status = 'active'
              AND u.id <> $6
         )
         SELECT t.id AS teacher_id, t.full_name_bn, t.full_name_en,
                EXISTS (SELECT 1 FROM routine_slots rs2
                         WHERE rs2.teacher_id = t.id
                           AND rs2.status = 'active'
                           AND rs2.subject_id IS NOT DISTINCT FROM (SELECT subject_id FROM slot_ctx)
                           AND (SELECT subject_id FROM slot_ctx) IS NOT NULL) AS teaches_subject,
                (SELECT count(*)::int FROM routine_slots rs3
                  WHERE rs3.teacher_id = t.id
                    AND rs3.status = 'active'
                    AND rs3.day_of_week = (SELECT dow FROM slot_ctx)
                    AND rs3.slot_kind = 'teaching') AS load_today,
                (SELECT count(*)::int FROM routine_substitutions sub30
                  WHERE sub30.substitute_teacher_id = t.id
                    AND sub30.substitution_date > (SELECT d FROM slot_ctx) - 30
                    AND sub30.status IN ('assigned','completed')) AS subs_last_30d
           FROM teachers t
          WHERE NOT EXISTS (              -- teaching an overlapping period that weekday
                  SELECT 1 FROM routine_slots busy
                   WHERE busy.teacher_id = t.id
                     AND busy.status = 'active'
                     AND busy.day_of_week = (SELECT dow FROM slot_ctx)
                     AND busy.time_range && (SELECT tr FROM slot_ctx))
            AND NOT EXISTS (              -- already substituting an overlapping period that date
                  SELECT 1 FROM routine_substitutions rsub
                   JOIN routine_slots bslot ON bslot.id = rsub.slot_id
                   WHERE rsub.substitute_teacher_id = t.id
                     AND rsub.substitution_date = (SELECT d FROM slot_ctx)
                     AND rsub.status IN ('proposed','assigned')
                     AND bslot.time_range && (SELECT tr FROM slot_ctx))
            AND NOT EXISTS (              -- on approved leave that date
                  SELECT 1 FROM teacher_leaves tl
                   WHERE tl.teacher_id = t.id
                     AND tl.status IN ('approved','taken')
                     AND (SELECT d FROM slot_ctx) BETWEEN tl.starts_on AND tl.ends_on)
            AND NOT EXISTS (              -- marked unavailable in that window
                  SELECT 1 FROM teacher_availability ta
                   WHERE ta.teacher_id = t.id
                     AND ta.kind = 'unavailable'
                     AND ta.day_of_week = (SELECT dow FROM slot_ctx)
                     AND ta.time_range && (SELECT tr FROM slot_ctx)
                     AND ta.effective_from <= (SELECT d FROM slot_ctx)
                     AND (ta.effective_to IS NULL OR ta.effective_to >= (SELECT d FROM slot_ctx)))
          ORDER BY teaches_subject DESC, load_today ASC, subs_last_30d ASC, t.full_name_bn
          LIMIT 10`,
        [slotId, s.subject_id, s.time_range, s.day_of_week, date, s.teacher_id],
      );

      return r.rows.map((row, i) => ({
        teacherId: row.teacher_id,
        fullName: { bn: row.full_name_bn, en: row.full_name_en },
        rank: i + 1,
        matchScore: (row.teaches_subject ? 50 : 0) + Math.max(0, 30 - row.load_today * 5) + Math.max(0, 20 - row.subs_last_30d * 4),
        matchReasons: [
          row.teaches_subject ? 'subject_expertise' : 'no_subject_match',
          `load_today:${row.load_today}`,
          `subs_last_30d:${row.subs_last_30d}`,
        ],
      }));
    });

    json(res, 200, { ok: true, slotId, date, candidates }, cors);
  } catch (err) {
    if (err instanceof HttpError) {
      json(res, err.status, { error: err.code ?? 'error', message: err.message }, cors);
      return;
    }
    // The check_substitute_free trigger raises on a stale candidate — a
    // clean conflict, not a server fault.
    const pgErr = err as { code?: string; message?: string };
    if (pgErr.code === 'P0001' || pgErr.code === '23505') {
      json(res, 409, { error: 'substitute_conflict', message: pgErr.message ?? 'substitute is no longer free' }, cors);
      return;
    }
    console.error('[substitute] unexpected error', err);
    json(res, 500, { error: 'internal_error' }, cors);
  }
}
