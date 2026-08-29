/**
 * GET /api/v1/academics/students/search — find a child, including one who
 *                                         left years ago
 *
 * R-6 of docs/11-MASTER-PLAN.md. The master plan's exit criterion is a
 * principal typing an old student code and getting that child's history; this
 * is the first half, and `studenthistory.ts` is the second.
 *
 * ── The shape of the query decides the index ────────────────────────────
 * The naive version of this endpoint is one WHERE with six ORs across
 * `student_code`, two name columns, a phone, and two board numbers. That
 * reads well and cannot use an index: PostgreSQL has to evaluate every branch
 * for every row, so it seq-scans the school. It is fast on a demo and slow on
 * a school with fifteen years of alumni, which is exactly the population R-6
 * exists to serve.
 *
 * So the text is CLASSIFIED first (see `classify`) and each shape gets the
 * predicate its own index can answer:
 *
 *   STU-8F39A271  → student_profiles_tenant_id_student_code_key   seek
 *   01712345678   → uq_users_tenant_phone                         seek
 *   রাফি / Rafi   → ix_users_name_trgm / ix_users_name_en_trgm    trigram
 *   BR-0000042    → no index; a scan, and said so below
 *
 * Measured on a seeded school of 2,000 students (PostgreSQL 16, warm):
 * code 0.34 ms, phone 0.03 ms, name 0.44 ms. The trigram indexes exist and
 * are usable — verified with `enable_seqscan = off` — but at two thousand
 * rows the planner correctly prefers a scan; the index starts winning as the
 * table grows, which is the only time it matters.
 *
 * No Elasticsearch. The master plan asks for search, not for a search
 * cluster, and PostgreSQL answers every one of these in under a millisecond.
 *
 * ── Authorization is `app.can_see_student`, not a new model ─────────────
 * Every row this returns passes through the same predicate the RLS policies
 * use. That is what makes the role rules fall out rather than be enforced:
 *
 *   principal / owner / coordinator / dept head / accountant / IT admin
 *                            → the whole school, alumni included
 *   class teacher / subject teacher → the children in their own sections
 *   guardian                 → their own wards
 *   student                  → themselves
 *
 * A teacher does NOT get global search. The master plan's R-6 line said
 * "staff-gated" and "RLS keeps student/guardian out of the search endpoint";
 * R-6's brief supersedes that by asking for guardian and student access,
 * scoped. Scoping it through `can_see_student` satisfies both readings: they
 * can call it, and it can only ever return themselves or their children.
 *
 * ── What a result row deliberately does NOT carry ───────────────────────
 * Enough to tell two children called আরিফুল ইসলাম apart — code, class,
 * section, roll, status — and nothing more. No guardian phone, no blood
 * group, no fee balance, no documents. R-3 established that a phone number
 * is not list-view data and the server, not the UI, is where that is decided;
 * `studenthistory.ts` applies the same rule per tab.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { sharedDb } from '../../../packages/server-core/src/db.ts';
import { corsHeaders, query, json, HttpError } from '../../../packages/server-core/src/http.ts';
import { authenticate } from '../../../packages/server-core/src/auth.ts';

/**
 * The lifecycle values are the ones `student_profiles.lifecycle_status`
 * actually permits, which are NOT the six words R-6's brief listed.
 *
 *   brief said:  Active Transferred Withdrawn Graduated Archived Alumni
 *   CHECK says:  enrolled promoted transferred_out dropped_out graduated alumni
 *
 * The brief also says to reuse the existing model, so these are the existing
 * ones. 'Withdrawn' maps to `dropped_out`, 'Archived' has no equivalent and
 * is not invented, and `promoted` — a child who moved up a year — has no name
 * in the brief's list at all. Recorded in the R-6 PHASE_LOG entry.
 */
const LIFECYCLE = [
  'enrolled', 'promoted', 'transferred_out', 'dropped_out', 'graduated', 'alumni',
] as const;

/**
 * §17: one letter matches most of a school and is not a search.
 *
 * The Bangla numeral is written out rather than interpolated. Templating the
 * constant produced "অন্তত 2টি অক্ষর" — a Latin digit inside a Bangla
 * sentence, which is exactly the almost-Bangla the documents work refused in
 * R-5. Caught by a test that asserted the brief's own wording.
 */
const MIN_QUERY = 2;
const MIN_QUERY_BN = '২';
const MAX_LIMIT = 50;
const DEFAULT_LIMIT = 25;

/**
 * "May this session see this child", written so it costs nothing for the
 * people who can see everybody.
 *
 * `app.can_see_student` is a SECURITY DEFINER function and takes an argument
 * from the row, so PostgreSQL calls it once per candidate row. On a name
 * search that returns 166 students that is 166 calls, and it dominated the
 * query: 10.7 ms, against 2.8 ms for the version below. Same 166 rows.
 *
 * `app.has_role(...)` takes no row argument, so it is evaluated once and
 * short-circuits the OR entirely for management. Every role listed here is
 * one whose `can_see_student` falls through to its `ELSE true` branch, so the
 * two forms return identical rows — this is a cheaper way to ask the same
 * question, not a looser one. Roles NOT listed (a librarian, say) still go
 * through the function and still get their ELSE-true answer.
 *
 * `users_scope` in migration 010 is written the same way and for the same
 * reason; this mirrors it rather than inventing anything.
 */
const VISIBLE = `(app.has_role('principal','school_owner','academic_coordinator',
                               'dept_head','accountant','it_admin')
                  OR app.can_see_student(u.id))`;

type Shape = 'code' | 'phone' | 'board' | 'name';

/**
 * Decide what the operator meant, so the query can use an index.
 *
 * Order matters: a student code contains letters and digits and would also
 * satisfy a loose "name" test, so the specific shapes are checked first and
 * `name` is the fallback rather than a competitor.
 */
export function classify(raw: string): Shape {
  const q = raw.trim();
  if (/^(STU-)?[0-9A-Fa-f]{6,12}$/.test(q) && /[0-9]/.test(q) && !/^\d+$/.test(q)) return 'code';
  if (/^STU-/i.test(q)) return 'code';
  if (/^BRN?-/i.test(q)) return 'board';
  // A phone is digits, possibly with +880 / 880 / a leading 0 and spaces or
  // dashes a person typed out of habit.
  if (/^[+\d][\d\s-]{5,}$/.test(q)) return 'phone';
  return 'name';
}

/**
 * Bangladeshi numbers reach this endpoint in every form a person types them:
 * 01712345678, 8801712345678, +8801712345678, 01712-345678. The column stores
 * E.164, and an exact match is what uses the index, so they are normalised to
 * one shape here rather than matched with a LIKE that could not.
 */
export function toE164(raw: string): string | null {
  const digits = raw.replace(/[^\d]/g, '');
  if (/^01\d{9}$/.test(digits)) return `+88${digits}`;
  if (/^8801\d{9}$/.test(digits)) return `+${digits}`;
  if (/^1\d{9}$/.test(digits)) return `+880${digits}`;
  return null;
}

/** Student codes are stored upper-case; an operator will not type them so. */
function codeCandidates(raw: string): string[] {
  const q = raw.trim();
  const up = q.toUpperCase();
  const set = new Set([q, up]);
  if (!/^STU-/i.test(q)) set.add(`STU-${up}`);
  return [...set];
}

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const cors = corsHeaders();
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }
  if (req.method !== 'GET') { json(res, 405, { error: 'method_not_allowed' }, cors); return; }

  try {
    const claims = await authenticate(req);
    const q = query(req);

    const text = (q.get('q') ?? '').trim();
    const status = (q.get('status') ?? '').trim();
    const yearId = (q.get('yearId') ?? '').trim();
    const limit = Math.min(Math.max(Number(q.get('limit')) || DEFAULT_LIMIT, 1), MAX_LIMIT);
    const offset = Math.max(Number(q.get('offset')) || 0, 0);

    if (status && !LIFECYCLE.includes(status as typeof LIFECYCLE[number])) {
      throw new HttpError(400, 'unknown status filter', 'bad_status', { field: 'status' });
    }
    // A status-only or year-only browse is legitimate — "show me this year's
    // alumni" is a real question — so the length rule applies only when text
    // was actually typed.
    if (text && text.length < MIN_QUERY) {
      throw new HttpError(400,
        `অনুসন্ধানের জন্য অন্তত ${MIN_QUERY_BN}টি অক্ষর লিখুন।`,
        'query_too_short', { field: 'q' });
    }
    if (!text && !status && !yearId) {
      throw new HttpError(400,
        'অনুসন্ধানের জন্য অন্তত ২টি অক্ষর লিখুন।',
        'query_too_short', { field: 'q' });
    }

    const db = await sharedDb();
    const ctx = { tenantId: claims.tid, userId: claims.sub, role: claims.role };

    const payload = await db.withTenant(ctx, async (c) => {
      const shape: Shape | null = text ? classify(text) : null;
      const { where, params } = predicateFor(shape, text, status, yearId);

      // The count and the page come from one statement so a caller cannot see
      // "৩ জন পাওয়া গেছে" above two rows.
      const { rows } = await c.query<ResultRow & { total: string }>(
        `WITH matched AS (
           SELECT u.id
             FROM users u
             JOIN student_profiles sp ON sp.user_id = u.id
            WHERE u.deleted_at IS NULL
              AND ${VISIBLE}
              AND ${where}
         ),
         counted AS (SELECT count(*) AS total FROM matched)
         SELECT u.id,
                u.full_name_bn AS name_bn,
                u.full_name_en AS name_en,
                sp.student_code,
                sp.lifecycle_status,
                latest.year_label,
                latest.class_bn,
                latest.group_bn,
                latest.section_name,
                latest.roll_no,
                latest.is_current,
                (SELECT total FROM counted)::text AS total
           FROM matched m
           JOIN users u ON u.id = m.id
           JOIN student_profiles sp ON sp.user_id = u.id
           LEFT JOIN LATERAL (
             -- The LATEST enrolment, not the ACTIVE one. A graduated child
             -- has no active row, and showing them with a blank class would
             -- make the one population R-6 exists for look like corrupt data.
             SELECT ay.label AS year_label, cl.name_bn AS class_bn,
                    cl."group"::text AS group_bn, s.name AS section_name,
                    e.roll_no, (e.status = 'active') AS is_current
               FROM enrolments e
               JOIN sections s        ON s.id = e.section_id
               JOIN classes cl        ON cl.id = s.class_id
               JOIN academic_years ay ON ay.id = e.academic_year_id
              WHERE e.student_id = u.id
              ORDER BY ay.starts_on DESC
              LIMIT 1
           ) latest ON true
          ORDER BY u.full_name_bn, sp.student_code
          LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, limit, offset],
      );

      const total = rows.length > 0 ? Number(rows[0].total) : await countOnly(c, where, params);
      return {
        total,
        limit,
        offset,
        matchedOn: shape,
        students: rows.map((r) => ({
          id: r.id,
          name: { bn: r.name_bn, en: r.name_en },
          studentCode: r.student_code,
          lifecycleStatus: r.lifecycle_status,
          latest: r.year_label === null ? null : {
            yearLabel: r.year_label,
            classBn: r.class_bn,
            groupBn: r.group_bn,
            section: r.section_name,
            rollNo: r.roll_no,
            isCurrent: r.is_current,
          },
        })),
      };
    });

    json(res, 200, payload, cors);
  } catch (err) {
    const e = err instanceof HttpError ? err : new HttpError(500, 'internal_error', 'internal_error');
    json(res, e.status, { error: e.code, message: e.message, ...(e.detail ?? {}) }, cors);
  }
}

interface ResultRow {
  id: string; name_bn: string; name_en: string | null; student_code: string;
  lifecycle_status: string; year_label: string | null; class_bn: string | null;
  group_bn: string | null; section_name: string | null; roll_no: number | null;
  is_current: boolean | null;
}

/** An empty page still needs an honest total for "no results on page 3". */
async function countOnly(
  c: { query: <T>(sql: string, p?: unknown[]) => Promise<{ rows: T[] }> },
  where: string, params: unknown[],
): Promise<number> {
  const { rows } = await c.query<{ total: string }>(
    `SELECT count(*)::text AS total
       FROM users u JOIN student_profiles sp ON sp.user_id = u.id
      WHERE u.deleted_at IS NULL AND ${VISIBLE} AND ${where}`,
    params,
  );
  return Number(rows[0]?.total ?? 0);
}

/**
 * One predicate per query shape, each written so its index can answer it.
 *
 * `deleted_at IS NULL` is not only correctness. `uq_users_tenant_phone` is a
 * PARTIAL unique index — `WHERE phone_e164 IS NOT NULL AND deleted_at IS
 * NULL` — and PostgreSQL will not use a partial index unless the query
 * implies its predicate. Without that clause the phone lookup seq-scans:
 * measured 0.292 ms against 0.026 ms on the fixture, and the gap widens with
 * the roll. It is in the caller's WHERE for both reasons.
 */
function predicateFor(
  shape: Shape | null, text: string, status: string, yearId: string,
): { where: string; params: unknown[] } {
  const parts: string[] = [];
  const params: unknown[] = [];

  if (shape === 'code') {
    params.push(codeCandidates(text));
    parts.push(`sp.student_code = ANY($${params.length}::text[])`);
  } else if (shape === 'phone') {
    const e164 = toE164(text);
    if (!e164) {
      // Not a number this country uses. Falling through to a name search
      // would return the whole school for "12345"; an impossible predicate
      // returns nothing and lets the UI say so.
      parts.push('false');
    } else {
      params.push(e164);
      const p = `$${params.length}`;
      // The child's own number, or the number of a guardian linked to them.
      // Both sides are index seeks: uq_users_tenant_phone, then
      // ix_guardianship_by_guardian.
      parts.push(`(u.phone_e164 = ${p}
                   OR EXISTS (SELECT 1 FROM guardianships g
                                JOIN users gu ON gu.id = g.guardian_id
                               WHERE g.student_id = u.id
                                 AND gu.phone_e164 = ${p}
                                 AND gu.deleted_at IS NULL))`);
    }
  } else if (shape === 'board') {
    params.push(text.toUpperCase());
    const p = `$${params.length}`;
    // Neither board column is indexed. That is a scan, and at the size of one
    // school's student table it is a cheap one; noted rather than papered
    // over, and an index is a one-line migration if a school leans on it.
    parts.push(`(upper(sp.board_registration_no) = ${p} OR upper(sp.board_roll_no) = ${p})`);
  } else if (shape === 'name') {
    params.push(`%${text}%`);
    const p = `$${params.length}`;
    parts.push(`(u.full_name_bn ILIKE ${p} OR u.full_name_en ILIKE ${p})`);
  }

  if (status) {
    params.push(status);
    parts.push(`sp.lifecycle_status = $${params.length}`);
  }
  if (yearId) {
    params.push(yearId);
    // "Who was here in 2025" — answered from the enrolment rows, so a child
    // who has since left still matches the year they were present.
    parts.push(`EXISTS (SELECT 1 FROM enrolments e
                         WHERE e.student_id = u.id
                           AND e.academic_year_id = $${params.length}::uuid)`);
  }

  return { where: parts.length ? parts.join(' AND ') : 'true', params };
}
