/**
 * GET  /api/v1/ops/rollover?from=…&to=…  — the promotion preview
 * POST /api/v1/ops/rollover              — plan it, or commit a plan
 *
 * R-3 of docs/11-MASTER-PLAN.md, Part G. Moving every child in the school up a
 * year, once, at the end of it.
 *
 * ── The SQL already existed and is not re-implemented here ──────────────
 * Migration 033 has `app.rollover_preview()`, `app.commit_rollover()`, and the
 * `year_rollovers` table that freezes what the preview promised so a rollover
 * which moved fewer children than it said is visible afterwards. This file is
 * a thin HTTP shell over that. Every rule — who is promoted, who repeats
 * because they were detained, who graduates from the top class, who is blocked
 * — stays in one place, in SQL, where the transaction is.
 *
 * ── Three steps, because it is irreversible ─────────────────────────────
 *   preview  (GET)                   → read-only, run as often as you like
 *   plan     (POST, no rolloverId)   → freezes the counts into year_rollovers
 *   commit   (POST, with rolloverId) → moves everybody, once
 *
 * The plan step exists so the numbers on the confirmation screen are the
 * numbers the database agreed to, not numbers the browser remembered from a
 * request made ten minutes and one enrolment ago.
 *
 * ── Blocked students stop the whole thing, and that is correct ──────────
 * `commit_rollover` refuses while any student is blocked rather than skipping
 * them. A rollover that quietly left thirty children behind is discovered in
 * March by a teacher whose register is short. This endpoint surfaces that
 * refusal as a readable list rather than a 500.
 *
 * ── On the brief's four buckets ─────────────────────────────────────────
 * Part G asks for Promote / Repeat / Transfer / Withdraw. The schema's four
 * are promote / repeat / graduate / blocked. Transfer and withdraw are not
 * rollover outcomes here: a student who left has an enrolment status of
 * 'transferred' or 'left' already, set when it happened, and the preview
 * simply does not consider them (it reads only 'active' and 'detained').
 * Inventing rollover buckets for them would mean the year-end screen was
 * where a school recorded a departure that happened in August. It is
 * documented rather than silently different.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { sharedDb } from '../../../packages/server-core/src/db.ts';
import { corsHeaders, readJson, json, query, HttpError } from '../../../packages/server-core/src/http.ts';
import { authenticate, requireRole } from '../../../packages/server-core/src/auth.ts';
import { writeAudit } from '../../../packages/server-core/src/audit.ts';

/** Mirrors rollover_read_scope in migration 033. */
const ROLLOVER_READ = ['principal', 'school_owner', 'academic_coordinator', 'it_admin'];
/** Mirrors rollover_insert_scope. Moving the whole school is an owner-level act. */
const ROLLOVER_WRITE = ['principal', 'school_owner'];

interface PreviewRow {
  enrolment_id: string;
  student_id: string;
  student_name_bn: string;
  from_class_level: number;
  from_section: string;
  from_roll: number;
  action: string;
  to_class_level: number | null;
  to_section_id: string | null;
  to_section: string | null;
  to_roll: number | null;
  blocker_bn: string | null;
}

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const cors = corsHeaders([], 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }

  try {
    const claims = await authenticate(req);
    const db = await sharedDb();
    const ctx = { tenantId: claims.tid, userId: claims.sub, role: claims.role };

    if (req.method === 'GET') {
      requireRole(claims, ROLLOVER_READ);
      const q = query(req);
      const from = q.get('from');
      const to = q.get('to');
      json(res, 200, await preview(db, ctx, from, to), cors);
      return;
    }

    if (req.method !== 'POST') { json(res, 405, { error: 'method_not_allowed' }, cors); return; }
    requireRole(claims, ROLLOVER_WRITE);

    const body = await readJson<{ fromYearId?: string; toYearId?: string; rolloverId?: string }>(req);

    if (body.rolloverId) { json(res, 200, await commit(db, ctx, body.rolloverId), cors); return; }

    const from = body.fromYearId?.trim();
    const to = body.toYearId?.trim();
    if (!from || !to) throw new HttpError(400, 'দুইটি শিক্ষাবর্ষ বেছে নিন', 'bad_request');
    if (from === to) throw new HttpError(400, 'একই বছর থেকে একই বছরে উন্নীত করা যায় না', 'same_year');
    json(res, 200, await plan(db, ctx, from, to), cors);
  } catch (err) {
    if (err instanceof HttpError) {
      json(res, err.status, { error: err.code, message: err.message, ...(err.detail ?? {}) }, cors);
      return;
    }
    json(res, 500, { error: 'internal_error' }, cors);
  }
}

type Db = Awaited<ReturnType<typeof sharedDb>>;
type Ctx = { tenantId: string; userId: string; role: string };

function summarise(rows: PreviewRow[]) {
  return {
    considered: rows.length,
    promote: rows.filter((r) => r.action === 'promote').length,
    repeat: rows.filter((r) => r.action === 'repeat').length,
    graduate: rows.filter((r) => r.action === 'graduate').length,
    blocked: rows.filter((r) => r.action === 'blocked').length,
  };
}

async function preview(db: Db, ctx: Ctx, from: string | null, to: string | null) {
  return db.withTenant(ctx, async (c) => {
    const { rows: years } = await c.query<{ id: string; label: string; is_current: boolean }>(
      `SELECT id, label, is_current FROM academic_years ORDER BY starts_on DESC`,
    );
    // Fewer than two years is not an error; it is a school that has not
    // created next year yet. The screen says exactly that and offers no
    // preview, rather than showing an empty one that reads as "nobody to
    // promote".
    if (!from || !to) {
      return {
        years: years.map((y) => ({ id: y.id, label: y.label, isCurrent: y.is_current })),
        needsTargetYear: years.length < 2,
        summary: null, students: [], existing: null,
      };
    }

    const { rows } = await c.query<PreviewRow>(
      `SELECT * FROM app.rollover_preview($1, $2)`, [from, to],
    );

    // A rollover already planned or committed between these two years. Two
    // plans for the same pair is what the UNIQUE constraint on
    // year_rollovers prevents, and the screen must know before it offers a
    // button that will fail.
    const { rows: existing } = await c.query<{
      id: string; status: string; considered: number; to_promote: number;
      to_repeat: number; to_graduate: number; blocked: number;
      promoted: number; repeated: number; graduated: number;
      committed_at: string | null;
    }>(
      `SELECT id, status, considered, to_promote, to_repeat, to_graduate, blocked,
              promoted, repeated, graduated, committed_at::text AS committed_at
         FROM year_rollovers
        WHERE from_year_id = $1 AND to_year_id = $2`,
      [from, to],
    );

    return {
      years: years.map((y) => ({ id: y.id, label: y.label, isCurrent: y.is_current })),
      needsTargetYear: false,
      fromYear: years.find((y) => y.id === from) ?? null,
      toYear: years.find((y) => y.id === to) ?? null,
      summary: summarise(rows),
      students: rows.map((r) => ({
        studentId: r.student_id,
        nameBn: r.student_name_bn,
        fromLevel: r.from_class_level,
        fromSection: r.from_section,
        fromRoll: r.from_roll,
        action: r.action,
        toLevel: r.to_class_level,
        toSection: r.to_section,
        toRoll: r.to_roll,
        blockerBn: r.blocker_bn,
      })),
      existing: existing[0]
        ? {
            id: existing[0].id,
            status: existing[0].status,
            planned: {
              considered: existing[0].considered,
              promote: existing[0].to_promote,
              repeat: existing[0].to_repeat,
              graduate: existing[0].to_graduate,
              blocked: existing[0].blocked,
            },
            actual: existing[0].status === 'committed'
              ? {
                  promoted: existing[0].promoted,
                  repeated: existing[0].repeated,
                  graduated: existing[0].graduated,
                  committedAt: existing[0].committed_at,
                }
              : null,
          }
        : null,
    };
  });
}

/** Freeze the preview's counts into a row the commit step can be checked against. */
async function plan(db: Db, ctx: Ctx, from: string, to: string) {
  return db.withTenant(ctx, async (c) => {
    const { rows } = await c.query<PreviewRow>(
      `SELECT * FROM app.rollover_preview($1, $2)`, [from, to],
    );
    const s = summarise(rows);

    const { rows: saved } = await c.query<{ id: string; status: string }>(
      `INSERT INTO year_rollovers
         (tenant_id, from_year_id, to_year_id, considered, to_promote,
          to_repeat, to_graduate, blocked, planned_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (tenant_id, from_year_id, to_year_id) DO UPDATE
         SET considered = EXCLUDED.considered,
             to_promote = EXCLUDED.to_promote,
             to_repeat = EXCLUDED.to_repeat,
             to_graduate = EXCLUDED.to_graduate,
             blocked = EXCLUDED.blocked,
             planned_by = EXCLUDED.planned_by
         -- Re-planning is only meaningful while it has not run. A committed
         -- rollover's frozen counts are the record of what it promised.
         WHERE year_rollovers.status = 'planned'
       RETURNING id, status`,
      [ctx.tenantId, from, to, s.considered, s.promote, s.repeat, s.graduate, s.blocked, ctx.userId],
    );

    if (saved.length === 0) {
      throw new HttpError(409,
        'এই দুই বছরের উন্নয়ন ইতিমধ্যে সম্পন্ন হয়েছে', 'already_committed');
    }

    return { rolloverId: saved[0].id, status: saved[0].status, summary: s };
  });
}

async function commit(db: Db, ctx: Ctx, rolloverId: string) {
  return db.withTenant(ctx, async (c) => {
    try {
      const { rows } = await c.query<{ promoted: number; repeated: number; graduated: number }>(
        `SELECT * FROM app.commit_rollover($1)`, [rolloverId],
      );
      const r = rows[0] ?? { promoted: 0, repeated: 0, graduated: 0 };

      await writeAudit(c, ctx, {
        action: 'academic.rollover.commit',
        entityType: 'year_rollover',
        entityId: rolloverId,
        after: r,
      });

      return { committed: true, ...r };
    } catch (err) {
      // commit_rollover raises with a readable message and a HINT — a
      // blocked-student list, or "already committed". Turning that into a
      // 500 would leave the school looking at "something went wrong" when
      // the database just told them exactly what.
      const e = err as { code?: string; message?: string; hint?: string };
      if (e.code === '23514' || e.code === '22023' || e.code === 'P0002') {
        throw new HttpError(409, e.message ?? 'উন্নয়ন সম্পন্ন করা যায়নি',
          'rollover_refused', { hint: e.hint ?? null });
      }
      throw err;
    }
  });
}
