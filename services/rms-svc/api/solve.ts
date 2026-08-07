/**
 * POST /api/v1/rms/solve
 * Body: { routineId }
 *
 * Runs the greedy-heuristic solver (../src/solve.ts) against an existing
 * DRAFT routine and writes the resulting slots + solver provenance. Creating
 * the draft routine row itself (period template, academic year, shift setup)
 * has no admin UI yet, so this endpoint only fills in a routine that already
 * exists — it's the solve step, not routine setup.
 *
 * RLS is the real gate (routine_write_scope / routine_slots_write_scope
 * restrict writes to principal/school_owner/academic_coordinator — see
 * db/migrations/010_rls_policies.sql); requireRole below just turns that
 * into a clean 403 instead of a confusing insert failure.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { sharedDb } from '../../../packages/server-core/src/db.ts';
import { corsHeaders, readJson, json, HttpError } from '../../../packages/server-core/src/http.ts';
import { authenticate, requireRole } from '../../../packages/server-core/src/auth.ts';
import { RmsSolver } from '../src/solve.ts';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RMS_ROLES = ['principal', 'school_owner', 'academic_coordinator'];

interface SolveBody {
  routineId?: string;
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
    requireRole(claims, RMS_ROLES);

    const body = await readJson<SolveBody>(req);
    const routineId = body.routineId ?? '';
    if (!UUID_RE.test(routineId)) throw new HttpError(400, 'routineId must be a valid uuid', 'invalid_routine_id');

    const db = await sharedDb();
    const solver = new RmsSolver(db);
    const result = await solver.solve(routineId, { tenantId: claims.tid, userId: claims.sub, role: claims.role });

    json(res, 200, { ok: true, ...result }, cors);
  } catch (err) {
    if (err instanceof HttpError) {
      json(res, err.status, { error: err.code ?? 'error', message: err.message }, cors);
      return;
    }
    const code = (err as { code?: string }).code;
    if (code === 'ROUTINE_NOT_FOUND') {
      json(res, 404, { error: code, message: (err as Error).message }, cors);
      return;
    }
    if (code === 'ROUTINE_NOT_DRAFT' || code === 'NO_TEACHING_PERIODS') {
      json(res, 409, { error: code, message: (err as Error).message }, cors);
      return;
    }
    console.error('[rms/solve] unexpected error', err);
    json(res, 500, { error: 'internal_error' }, cors);
  }
}
