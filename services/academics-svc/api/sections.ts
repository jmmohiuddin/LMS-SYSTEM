/**
 * GET /api/v1/academics/sections
 *
 * Feeds the PWA's section picker (roster-view.ts) — the roster endpoint
 * needs a sectionId, and until an admin UI exists there was no way for the
 * app to discover one. Returns every section in the tenant; RLS on
 * `sections` is tenant-only (see roster.ts's comment and
 * db/migrations/010_rls_policies.sql), so staff-only access is enforced at
 * the application layer via requireStaff, same as roster.ts.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { sharedDb } from '../../../packages/server-core/src/db.ts';
import { corsHeaders, json, HttpError } from '../../../packages/server-core/src/http.ts';
import { authenticate, requireStaff } from '../../../packages/server-core/src/auth.ts';

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const cors = corsHeaders();
  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors);
    res.end();
    return;
  }
  if (req.method !== 'GET') {
    json(res, 405, { error: 'method_not_allowed' }, cors);
    return;
  }

  try {
    const claims = await authenticate(req);
    requireStaff(claims);

    const db = await sharedDb();
    const sections = await db.withTenant(
      { tenantId: claims.tid, userId: claims.sub, role: claims.role },
      async (client) => {
        const r = await client.query<{
          id: string;
          name: string;
          shift: string;
          student_count: number;
          class_name_bn: string;
          class_name_en: string;
          level_no: number;
          academic_year_id: string;
        }>(
          // `academic_year_id` is returned because attendance needs it and had
          // no way to learn it. The attendance screen was mounted with a
          // hardcoded `academicYearId: 'yr-2026'` left over from early
          // development, so every save a real teacher made was rejected by
          // sync with `invalid input syntax for type uuid: "yr-2026"` — a 200
          // response carrying a rejection the screen could only render as
          // "১টি পাঠানো যায়নি". A section already knows its year; it simply
          // was not being told.
          `SELECT s.id, s.name, s.shift, s.student_count, s.academic_year_id,
                  c.name_bn AS class_name_bn, c.name_en AS class_name_en, c.level_no
             FROM sections s
             JOIN classes c ON c.id = s.class_id
            ORDER BY c.level_no, s.name`,
        );
        return r.rows.map((row) => ({
          id: row.id,
          name: row.name,
          shift: row.shift,
          studentCount: row.student_count,
          className: { bn: row.class_name_bn, en: row.class_name_en },
          levelNo: row.level_no,
          academicYearId: row.academic_year_id,
        }));
      },
    );

    json(res, 200, { sections }, cors);
  } catch (err) {
    if (err instanceof HttpError) {
      json(res, err.status, { error: err.code ?? 'error', message: err.message }, cors);
      return;
    }
    console.error('[sections] unexpected error', err);
    json(res, 500, { error: 'internal_error' }, cors);
  }
}
