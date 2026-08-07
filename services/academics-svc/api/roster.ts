/**
 * GET /api/v1/academics/roster?sectionId=<uuid>
 *
 * Replaces the PWA's hardcoded placeholder roster with the real section +
 * enrolment data. RLS on `sections`/`enrolments` is currently tenant-only
 * (no per-role restrictive policy — see db/migrations/010_rls_policies.sql),
 * so staff-only access is enforced at the application layer via requireStaff.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { sharedDb } from '../../../packages/server-core/src/db.ts';
import { corsHeaders, query, json, HttpError } from '../../../packages/server-core/src/http.ts';
import { authenticate, requireStaff } from '../../../packages/server-core/src/auth.ts';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

    const sectionId = query(req).get('sectionId') ?? '';
    if (!UUID_RE.test(sectionId)) throw new HttpError(400, 'sectionId must be a valid uuid', 'invalid_section_id');

    const db = await sharedDb();
    const result = await db.withTenant({ tenantId: claims.tid, userId: claims.sub, role: claims.role }, async (client) => {
      const sectionRes = await client.query<{
        id: string;
        name: string;
        shift: string;
        capacity: number;
        student_count: number;
        class_name_bn: string;
        class_name_en: string;
        level_no: number;
      }>(
        `SELECT s.id, s.name, s.shift, s.capacity, s.student_count,
                c.name_bn AS class_name_bn, c.name_en AS class_name_en, c.level_no
           FROM sections s
           JOIN classes c ON c.id = s.class_id
          WHERE s.id = $1`,
        [sectionId],
      );
      const section = sectionRes.rows[0];
      if (!section) throw new HttpError(404, 'section not found', 'section_not_found');

      const rosterRes = await client.query<{
        roll_no: number;
        student_id: string;
        full_name_bn: string | null;
        full_name_en: string | null;
        phone_e164: string | null;
      }>(
        `SELECT e.roll_no, e.student_id, u.full_name_bn, u.full_name_en, u.phone_e164
           FROM enrolments e
           JOIN users u ON u.id = e.student_id
          WHERE e.section_id = $1 AND e.status = 'active'
          ORDER BY e.roll_no`,
        [sectionId],
      );

      return {
        section: {
          id: section.id,
          name: section.name,
          shift: section.shift,
          capacity: section.capacity,
          studentCount: section.student_count,
          className: { bn: section.class_name_bn, en: section.class_name_en },
          levelNo: section.level_no,
        },
        roster: rosterRes.rows.map((r) => ({
          rollNo: r.roll_no,
          studentId: r.student_id,
          fullName: { bn: r.full_name_bn, en: r.full_name_en },
          phone: r.phone_e164,
        })),
      };
    });

    json(res, 200, result, cors);
  } catch (err) {
    if (err instanceof HttpError) {
      json(res, err.status, { error: err.code ?? 'error', message: err.message }, cors);
      return;
    }
    console.error('[roster] unexpected error', err);
    json(res, 500, { error: 'internal_error' }, cors);
  }
}
