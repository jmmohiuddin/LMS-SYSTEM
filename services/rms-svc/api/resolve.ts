/**
 * POST /api/v1/rms/resolve  → recalculate part of a routine   (P9-6)
 *
 *   { routineId, scope: { kind: 'teacher', teacherId }, preview?, fingerprint? }
 *
 * A coordinator changes one thing — Rahim is away on Wednesday, the lab is
 * shut, 9-A's week needs rebuilding — and asks for that part to be worked
 * out again. Not the school.
 *
 * ── One solver, and it is the one that was already here ──────────────────
 * `RmsSolver` places `periodsPerWeek − alreadyPlaced` for each (section,
 * subject). A fully-placed routine is one it will not touch, and a routine
 * missing four lessons is one it will place four lessons into. So the whole
 * of "re-solve only the affected area" is: remove the affected slots, run
 * the solver. Every constraint, every clash check, every explanation is the
 * existing one, and a change to any of them changes this too.
 *
 * ── Atomic, because it has to be ─────────────────────────────────────────
 * The removal and the re-solve are ONE transaction, which is why
 * `solve({ client })` exists. Committing the removal and then failing the
 * placement would leave a school with lessons deleted and nothing put back —
 * §8's exact prohibition, and the worst possible outcome for a screen whose
 * purpose is to make a small change safely.
 *
 * ── Preview is the same transaction, rolled back ─────────────────────────
 * Not a simulation and not an estimate: the real solver, the real GiST
 * constraints, the real result — then `ROLLBACK`. A preview computed any
 * other way would be a second implementation of the thing it is previewing,
 * and would differ from it on exactly the cases that matter.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type pg from 'pg';
import { sharedDb } from '../../../packages/server-core/src/db.ts';
import { corsHeaders, readJson, json, HttpError } from '../../../packages/server-core/src/http.ts';
import { authenticate, requireRole } from '../../../packages/server-core/src/auth.ts';
import { writeAudit } from '../../../packages/server-core/src/audit.ts';
import { RmsSolver } from '../src/solve.ts';
import { logEdit } from '../src/edit-log.ts';
import {
  allSlots, slotsInScope, fingerprint, summarise,
  type Scope, type ScopedSlot, type ChangeSummary,
} from '../src/rescope.ts';
import { possessiveBn } from '../src/presentation.ts';

type Client = pg.PoolClient;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The same three that may author a routine. Re-solving IS authoring. */
const RESOLVE_ROLES = ['principal', 'school_owner', 'academic_coordinator'];

/** Statuses whose slots may still be moved. Published history is immutable. */
const EDITABLE = new Set(['draft', 'review']);

/**
 * Thrown to unwind a preview.
 *
 * `inTx` rolls back on any throw, so this carries the finished result out of
 * a transaction that is about to be discarded. It is never seen by a caller.
 */
class PreviewDone extends Error {
  readonly payload: unknown;
  constructor(payload: unknown) { super('preview'); this.payload = payload; }
}

function parseScope(raw: unknown): Scope {
  const s = raw as Record<string, unknown> | null;
  const kind = typeof s?.kind === 'string' ? s.kind : '';
  const uuid = (v: unknown) => (typeof v === 'string' && UUID_RE.test(v) ? v : '');

  if (kind === 'teacher' && uuid(s?.teacherId)) {
    return { kind: 'teacher', teacherId: uuid(s?.teacherId) };
  }
  if (kind === 'section' && uuid(s?.sectionId)) {
    return { kind: 'section', sectionId: uuid(s?.sectionId) };
  }
  if (kind === 'room' && uuid(s?.roomId)) {
    return { kind: 'room', roomId: uuid(s?.roomId) };
  }
  if (kind === 'day' && Number.isInteger(s?.dayOfWeek)
      && Number(s?.dayOfWeek) >= 0 && Number(s?.dayOfWeek) <= 6) {
    return { kind: 'day', dayOfWeek: Number(s?.dayOfWeek) };
  }
  throw new HttpError(400,
    'কোন অংশটি আবার হিসাব করতে হবে তা বেছে নিন — শিক্ষক, শাখা, কক্ষ বা দিন।',
    'invalid_scope');
}

/** The one sentence a coordinator reads first. */
function verdictBn(sum: ChangeSummary, scopedCount: number): string {
  const bn = (n: number) => String(n).replace(/[0-9]/g, (d) => '০১২৩৪৫৬৭৮৯'[Number(d)]);
  if (scopedCount === 0) return 'এই অংশে বদলানোর মতো কোনো ক্লাস নেই।';
  if (sum.lost > 0) {
    return `${bn(sum.moved.length - sum.lost)}টি ক্লাস সরানো হয়েছে, `
         + `${bn(sum.lost)}টির জন্য কোনো বৈধ সময় পাওয়া যায়নি।`;
  }
  if (sum.moved.length === 0) return 'হিসাব করা হয়েছে — কিছুই বদলানোর দরকার হয়নি।';
  return `${bn(sum.moved.length)}টি ক্লাস নতুন সময়ে বসানো হয়েছে।`;
}

/**
 * The whole operation, inside ONE transaction.
 *
 * Returns the payload. When `preview` is set it throws `PreviewDone` at the
 * end instead, so the transaction rolls back and the routine is untouched.
 */
async function run(
  c: Client, ctx: { tenantId: string; userId: string; role: string },
  o: { routineId: string; scope: Scope; preview: boolean; solver: RmsSolver },
): Promise<unknown> {
  const rt = await c.query<{ status: string; academic_year_id: string; shift: string }>(
    `SELECT status::text AS status, academic_year_id, shift::text AS shift
       FROM routines WHERE id = $1`, [o.routineId]);
  if (!rt.rows[0]) throw new HttpError(404, 'রুটিনটি পাওয়া যায়নি', 'routine_not_found');
  if (!EDITABLE.has(rt.rows[0].status)) {
    throw new HttpError(409,
      'প্রকাশিত রুটিন সরাসরি বদলানো যায় না — নতুন খসড়া তৈরি করুন।', 'routine_not_editable');
  }

  const before = await allSlots(c, o.routineId);
  const scoped = await slotsInScope(c, o.routineId, o.scope);

  // §4, by construction rather than by a check: a pinned slot is never in the
  // removal set, so it is still there when the solver counts what is already
  // placed, and the solver works around it like any other placed lesson.
  const removable = scoped.filter((s) => !s.isPinned);

  if (removable.length > 0) {
    await c.query(
      `UPDATE routine_slots
          SET status = 'removed', row_version = row_version + 1, updated_at = now()
        WHERE id = ANY($1::uuid[])`,
      [removable.map((s) => s.id)]);
  }

  // The other shifts of this year, so a two-shift school does not re-place a
  // lesson into a room the morning is using. The P9-3 bug, not reintroduced.
  const sib = await c.query<{ id: string }>(
    `SELECT id FROM routines
      WHERE academic_year_id = $1 AND status = 'draft' AND id <> $2`,
    [rt.rows[0].academic_year_id, o.routineId]);

  const solved = await o.solver.solve(o.routineId, ctx, {
    client: c,
    alsoBookedAgainst: sib.rows.map((r) => r.id),
  });

  const after = await allSlots(c, o.routineId);
  const summary = summarise(before, after, scoped);

  const payload = {
    ok: true,
    preview: o.preview,
    routineId: o.routineId,
    scope: o.scope,
    summary,
    verdictBn: verdictBn(summary, scoped.length),
    unplaced: solved.unplaced.length,
    softViolations: solved.soft?.violations?.length ?? 0,
    fingerprint: await fingerprint(c, o.routineId),
  };

  if (o.preview) throw new PreviewDone(payload);

  // §18. ONE undo entry for an operation a coordinator asked for once.
  await logEdit(c, {
    tenantId: ctx.tenantId, routineId: o.routineId, actorId: ctx.userId,
    action: 'resolve', slotId: null,
    inverse: {
      op: 'resolve',
      restore: removable.map((s) => s.id),
      remove: after.filter((s) => !before.some((b) => b.id === s.id)).map((s) => s.id),
    },
    labelBn: scopeLabel(o.scope, scoped),
  });
  await writeAudit(c as never, ctx, {
    action: 'rms.routine.resolve',
    entityType: 'routine',
    entityId: o.routineId,
    before: { scope: o.scope, affected: scoped.length },
    after: { moved: summary.moved.length, lost: summary.lost },
  });
  return payload;
}

/** "রফিক স্যারের ক্লাসগুলো আবার হিসাব" — what the undo button will say. */
function scopeLabel(scope: Scope, scoped: ScopedSlot[]): string {
  const DAY_BN = ['রবি', 'সোম', 'মঙ্গল', 'বুধ', 'বৃহঃ', 'শুক্র', 'শনি'];
  const first = scoped[0];
  // A person's name takes the genitive; a section or room LABEL does not,
  // because "নবম-কের" reads as nonsense — the noun after it carries the
  // relationship instead.
  if (scope.kind === 'teacher') {
    return `${possessiveBn(first?.teacherBn ?? 'শিক্ষক')} ক্লাসগুলো আবার হিসাব`;
  }
  if (scope.kind === 'section') {
    return `${first?.sectionLabel ?? 'এই'} শাখার রুটিন আবার হিসাব`;
  }
  if (scope.kind === 'room') {
    return `${first?.roomLabel ?? 'এই'} কক্ষের ক্লাসগুলো আবার হিসাব`;
  }
  return `${DAY_BN[scope.dayOfWeek] ?? ''}বারের ক্লাসগুলো আবার হিসাব`;
}

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const cors = corsHeaders([], 'POST, OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }

  try {
    const claims = await authenticate(req);
    requireRole(claims, RESOLVE_ROLES);
    const db = await sharedDb();
    const ctx = { tenantId: claims.tid, userId: claims.sub, role: claims.role };

    if (req.method !== 'POST') { json(res, 405, { error: 'method_not_allowed' }, cors); return; }

    const body = await readJson<{
      routineId?: string; scope?: unknown; preview?: boolean; fingerprint?: string;
    }>(req);
    const routineId = String(body.routineId ?? '');
    if (!UUID_RE.test(routineId)) {
      throw new HttpError(400, 'রুটিন বেছে নিন', 'invalid_routine_id');
    }
    const scope = parseScope(body.scope);
    const preview = body.preview === true;
    const solver = new RmsSolver(db);

    try {
      const out = await db.withTenant(ctx, async (c) => {
        // §10. Somebody else may have edited since this screen was drawn.
        // Checked INSIDE the transaction, so the answer cannot go stale
        // between the check and the work.
        if (typeof body.fingerprint === 'string' && body.fingerprint.length > 0) {
          const now = await fingerprint(c as Client, routineId);
          if (now !== body.fingerprint) {
            throw new HttpError(409,
              'এই রুটিনটি আপনার পর্দায় দেখানোর পর অন্য কেউ বদলে ফেলেছেন। '
              + 'নতুন অবস্থা দেখে আবার চেষ্টা করুন।',
              'stale_routine', { expected: body.fingerprint, actual: now });
          }
        }
        return run(c as Client, ctx, { routineId, scope, preview, solver });
      }, { write: true });
      json(res, 200, out, cors);
    } catch (err) {
      // A preview's transaction has just rolled back; the result rode out on
      // the exception. Everything else is a real failure.
      if (err instanceof PreviewDone) { json(res, 200, err.payload, cors); return; }
      throw err;
    }
  } catch (err) {
    if (err instanceof HttpError) {
      json(res, err.status, { error: err.code, message: err.message, ...(err.detail ?? {}) }, cors);
      return;
    }
    const code = (err as { code?: string }).code;
    if (code === 'NO_TEACHING_PERIODS' || code === 'ROUTINE_NOT_DRAFT') {
      json(res, 409, { error: code, message: (err as Error).message }, cors); return;
    }
    console.error('[rms/resolve]', err);
    // §8. The transaction rolled back, so the previous draft is intact — and
    // saying so is the difference between a coordinator retrying and a
    // coordinator checking every lesson by hand.
    json(res, 500, {
      error: 'internal_error',
      message: 'আবার হিসাব করা যায়নি — রুটিন আগের অবস্থাতেই আছে।',
    }, cors);
  }
}
