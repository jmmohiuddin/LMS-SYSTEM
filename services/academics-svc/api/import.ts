/**
 * POST /api/v1/academics/import   — F-1601, wireframe §10.2
 *
 *   { kind:'student', academicYearId, fileName, csv }
 *        → step 2/3: validates and returns per-row errors. Writes nothing.
 *   { kind:'student', academicYearId, fileName, csv, commit:true, digest }
 *        → step 4: imports the valid rows, skips the rest, records a batch.
 *
 *   { kind:'teacher', fileName, csv }  and the same commit shape  (R-7 §13)
 *
 * §10.2: "Dry-run first, always — nothing is written until step 4."
 *
 * ── Why there is no staging table ────────────────────────────────────────
 * The obvious way to hold a dry-run between step 2 and step 4 is a table of
 * parsed rows. It is also forbidden: a row may carry a birth registration
 * number, and a national identifier is never written in plaintext anywhere.
 * A staging table of raw CSV rows is exactly that, sitting in the database
 * for as long as the operator takes lunch.
 *
 * So validation is stateless and the commit re-sends the file. The cost is
 * parsing 800 rows twice, which is nothing. The guard against sending a
 * DIFFERENT file the second time is the digest: step 2 returns a sha256 over
 * the parsed rows, and step 4 must present it back.
 *
 * ── Why the whole import is one transaction ──────────────────────────────
 * A partial write is the one outcome nobody can recover from: 300 students
 * in, 484 not, and no way to tell which without comparing by hand. §10.2
 * permits skipping INVALID rows — that is a decision made before any write —
 * but every row that passes validation lands, or none does.
 *
 * ── Why this file is now thin  (R-7) ─────────────────────────────────────
 * The orchestration moved to `src/import-run.ts` so R-7's onboarding wizard
 * can run the SAME import for a school that has no accounts yet. A platform
 * operator has no tenant JWT, so they cannot come through this endpoint; the
 * alternatives were to mint them an impersonation token or to write a second
 * importer, and a second importer is how two code paths end up disagreeing
 * about what a phone number looks like. This handler keeps the HTTP contract
 * and the role gate; the work is shared.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';

import { sharedDb } from '../../../packages/server-core/src/db.ts';
import { corsHeaders, readJson, json, HttpError } from '../../../packages/server-core/src/http.ts';
import { authenticate, requireRole } from '../../../packages/server-core/src/auth.ts';
import {
  runStudentImport, runTeacherImport, ImportError,
} from '../src/import-run.ts';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IMPORT_ROLES = ['principal', 'school_owner', 'academic_coordinator'];
/** Staff accounts are school-wide; an IT admin owns them, a coordinator does not. */
const STAFF_IMPORT_ROLES = ['principal', 'school_owner', 'it_admin'];

interface ImportBody {
  kind?: string;
  academicYearId?: string;
  fileName?: string;
  csv?: string;
  commit?: boolean;
  digest?: string;
}

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const cors = corsHeaders();
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }
  if (req.method !== 'POST') { json(res, 405, { error: 'method_not_allowed' }, cors); return; }

  try {
    const claims = await authenticate(req);
    const body = await readJson<ImportBody>(req);

    if (body.kind !== 'student' && body.kind !== 'teacher') {
      throw new HttpError(400, "kind must be 'student' or 'teacher'", 'unsupported_kind');
    }
    requireRole(claims, body.kind === 'teacher' ? STAFF_IMPORT_ROLES : IMPORT_ROLES);

    const db = await sharedDb();
    const ctx = { tenantId: claims.tid, userId: claims.sub, role: claims.role };

    const result = await db.withTenant(ctx, async (client) => {
      if (body.kind === 'teacher') {
        return runTeacherImport(client, {
          csv: body.csv ?? '', tenantId: claims.tid, userId: claims.sub,
          commit: body.commit, digest: body.digest, fileName: body.fileName ?? null,
        });
      }
      const academicYearId = body.academicYearId ?? '';
      if (!UUID_RE.test(academicYearId)) {
        throw new HttpError(400, 'academicYearId must be a valid uuid', 'invalid_year');
      }
      return runStudentImport(client, {
        csv: body.csv ?? '', academicYearId, tenantId: claims.tid, userId: claims.sub,
        commit: body.commit, digest: body.digest, fileName: body.fileName ?? null,
      });
    });

    json(res, 200, result, cors);
  } catch (err) {
    if (err instanceof ImportError) {
      json(res, err.status, { error: err.code, message: err.message }, cors);
      return;
    }
    if (err instanceof HttpError) {
      json(res, err.status, { error: err.code ?? 'error', message: err.message }, cors);
      return;
    }
    // Never echo a driver message: it can quote the row that failed, and a
    // row can hold a birth registration number.
    json(res, 500, { error: 'import_failed' }, cors);
  }
}
