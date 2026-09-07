/**
 * GET  /api/v1/rms/publish?yearId=…   → what would go live, per shift  (P9-7)
 * POST /api/v1/rms/publish            → { action: 'submit' | 'withdraw'
 *                                        | 'publish' }
 *
 * The last step of the routine's life. P9-3 generates it, P9-4 explains it,
 * P9-5 lets a coordinator edit it, P9-6 recalculates parts of it — and until
 * now the only way to make it real was a button in the editor that published
 * whatever was on screen without ever saying what that was.
 *
 * ── Why REVIEW is a status and not a screen ──────────────────────────────
 * `routine_status` has carried `draft | review | active | superseded |
 * archived` since migration 006, and nothing in the product ever wrote
 * `review`. It is the same shape P9-1, P9-2 and P9-5 each found: a control
 * that exists, is enforced, and that nothing can reach.
 *
 * It matters because publishing is not one person's act in a Bangladeshi
 * school. An academic coordinator builds the timetable; the head decides it
 * is the school's. `review` is the state between those two people, and
 * without it the coordinator's only options are "still mine" and "live to
 * three thousand guardians".
 *
 * A routine in review is still editable (`EDITABLE` in editor.ts includes
 * it) and still invisible to students and teachers, because `app.student_day`
 * and `app.teacher_day` both join `r.status = 'active'`. Verified against the
 * live database rather than inferred: a draft v2 sitting beside a published
 * v1 returns 0 rows to both.
 *
 * ── The gate is in src/publish-gate.ts, and this file does not repeat it ──
 * `reviewRoutine` decides what blocks and what merely warns; the GET renders
 * its answer and `publishRoutine` enforces it. If the two disagreed, a
 * coordinator would read "প্রকাশ করা যাবে" and receive a 409 — which is the
 * defect this arrangement exists to make impossible.
 *
 * ── Online only, and it says so ──────────────────────────────────────────
 * §14. Publishing is not queued for later. It takes a lock the offline
 * outbox cannot hold: whether the timetable is publishable depends on every
 * other routine in the school at the moment it goes live, and a school with
 * two devices offline could otherwise queue two publications that are each
 * valid alone. The UI disables the action without a connection and says why;
 * nothing here writes to the outbox.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type pg from 'pg';
import { sharedDb } from '../../../packages/server-core/src/db.ts';
import { corsHeaders, readJson, json, HttpError } from '../../../packages/server-core/src/http.ts';
import { authenticate, requireRole } from '../../../packages/server-core/src/auth.ts';
import { writeAudit } from '../../../packages/server-core/src/audit.ts';
import { reviewRoutine, type PublishReview } from '../src/publish-gate.ts';
import { shiftLabelBn } from '../src/presentation.ts';
import { publishRoutine } from './editor.ts';

type Client = pg.PoolClient;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Who may see a review, and who may publish.
 *
 * Deliberately different lists. The three authoring roles build and submit;
 * publishing is the head's signature. `academic_coordinator` keeps it here
 * because in most Bangladeshi schools that IS the person the head delegates
 * the timetable to, and removing it would break the single-administrator
 * school the product is mostly sold to — but `it_admin`, who may configure
 * period templates, may not decide what the school teaches.
 */
const REVIEW_ROLES = ['principal', 'school_owner', 'academic_coordinator'];

/** Statuses that still belong to the coordinator rather than to the school. */
const UNPUBLISHED = new Set(['draft', 'review']);

/** What a status means to somebody who has never read an enum. */
const STATUS_BN: Record<string, string> = {
  draft: 'খসড়া',
  review: 'পর্যালোচনায়',
  active: 'প্রকাশিত',
  superseded: 'বাতিল — নতুন রুটিন চালু',
  archived: 'সংরক্ষিত',
};

interface Head {
  tenantNameBn: string;
  yearId: string;
  yearLabel: string;
}

async function head(c: Client, yearId: string): Promise<Head | null> {
  const { rows } = await c.query<{ tenant_name: string; year_label: string }>(
    `SELECT t.name_bn AS tenant_name, y.label AS year_label
       FROM academic_years y
       JOIN tenants t ON t.id = y.tenant_id
      WHERE y.id = $1`,
    [yearId]);
  const r = rows[0];
  return r ? { tenantNameBn: r.tenant_name, yearId, yearLabel: r.year_label } : null;
}

/**
 * Every routine for the year, newest version of each shift first.
 *
 * A school with two shifts publishes two routines, and §11 requires the
 * review to be per shift — a morning conflict is not an evening problem and
 * a head who is shown one number for both cannot act on either.
 */
async function routinesForYear(c: Client, yearId: string): Promise<string[]> {
  const { rows } = await c.query<{ id: string }>(
    `SELECT id FROM routines
      WHERE academic_year_id = $1 AND status <> 'archived'
      ORDER BY shift, version DESC`,
    [yearId]);
  return rows.map((r) => r.id);
}

/** One entry on the review screen. */
type Entry = PublishReview & {
  shiftBn: string;
  statusBn: string;
  publishedAt: string | null;
  publishedByBn: string | null;
  /** Live now for this shift, if any — what publishing would replace. */
  supersedes: { version: number; publishedAt: string | null } | null;
  /** §6. What publishing this would do, in sentences. */
  consequenceBn: string[];
  /** The one line at the top of the card. Composed here, for the same reason. */
  verdictBn: string;
};

const BN_DIGITS = '০১২৩৪৫৬৭৮৯';
const bn = (n: number): string => String(n).replace(/[0-9]/g, (d) => BN_DIGITS[Number(d)]);

/**
 * The confirmation's own words.
 *
 * Composed HERE and not in the browser, for the reason P9-3's screen states
 * about its verdict: a browser that assembles a sentence out of counters
 * drifts from the numbers printed beside it the first time either changes.
 * The server holds the counts, the live version and the warnings, so it is
 * the only place the sentence and the numbers cannot disagree.
 *
 * It also keeps a paragraph of Bangla off a 2G phone's critical path, which
 * is budgeted at 180 KB gzipped for the whole application.
 */
function consequenceBn(r: PublishReview, shiftBn: string,
                       supersedes: { version: number } | null): string[] {
  const lines = [
    `${shiftBn} শিফটের ${bn(r.slots)}টি ক্লাস আজ থেকে সবার রুটিনে দেখা যাবে — `
    + 'শিক্ষক, শিক্ষার্থী ও অভিভাবক সবাই।',
  ];
  if (supersedes) {
    lines.push(`এখন চালু ${bn(supersedes.version)} নম্বর রুটিনটি বাতিল হয়ে যাবে।`);
  }
  for (const w of r.warnings) lines.push(`মেনে নেওয়া হচ্ছে: ${w.messageBn}`);
  lines.push('প্রকাশের পর এই রুটিন সরাসরি বদলানো যাবে না — বদলাতে হলে নতুন '
    + 'খসড়া তৈরি করতে হবে।');
  return lines;
}

async function decorate(c: Client, r: PublishReview): Promise<Entry> {
  const { rows } = await c.query<{
    published_at: string | null; publisher: string | null;
    live_version: number | null; live_published_at: string | null;
  }>(
    `SELECT to_char(rt.published_at AT TIME ZONE 'UTC',
                    'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS published_at,
            u.full_name_bn AS publisher,
            live.version AS live_version,
            to_char(live.published_at AT TIME ZONE 'UTC',
                    'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS live_published_at
       FROM routines rt
       LEFT JOIN users u ON u.id = rt.published_by
       LEFT JOIN routines live
              ON live.academic_year_id = rt.academic_year_id
             AND live.shift = rt.shift
             AND live.status = 'active'
             AND live.id <> rt.id
      WHERE rt.id = $1`,
    [r.routineId]);
  const x = rows[0];
  const shiftBn = shiftLabelBn(r.shift);
  const supersedes = x?.live_version != null
    ? { version: x.live_version, publishedAt: x.live_published_at }
    : null;
  return {
    ...r,
    shiftBn,
    statusBn: STATUS_BN[r.status] ?? r.status,
    publishedAt: x?.published_at ?? null,
    publishedByBn: x?.publisher ?? null,
    supersedes,
    consequenceBn: consequenceBn(r, shiftBn, supersedes),
    verdictBn: r.status === 'active'
      ? 'এই রুটিন চালু আছে।'
      : r.canPublish
        ? 'এই রুটিন প্রকাশ করা যাবে।'
        : 'এই রুটিন এখনই প্রকাশ করা যাবে না।',
  };
}

/* ---------------------------------------------------------------- submit */

/**
 * draft → review, or review → draft.
 *
 * Deliberately NOT gated on the routine being clean. A coordinator who has
 * done what they can with a timetable that still has a conflict needs to be
 * able to hand it to the head and say so — refusing the handover would leave
 * the two of them with no way to discuss it inside the product.
 *
 * Publishing is where the conflict blocks, and that is the right place: it is
 * the point at which the school's day would actually become wrong.
 */
async function moveStatus(
  c: Client, ctx: { tenantId: string; userId: string; role: string },
  routineId: string, to: 'draft' | 'review',
) {
  if (!UUID_RE.test(routineId)) {
    throw new HttpError(400, 'routineId must be a valid uuid', 'invalid_routine_id');
  }
  const { rows } = await c.query<{ status: string }>(
    `SELECT status::text AS status FROM routines WHERE id = $1`, [routineId]);
  const from = rows[0]?.status;
  if (!from) throw new HttpError(404, 'routine not found', 'routine_not_found');
  if (!UNPUBLISHED.has(from)) {
    throw new HttpError(409,
      'প্রকাশিত রুটিন আবার খসড়ায় ফেরানো যায় না — নতুন খসড়া তৈরি করুন।',
      'already_published');
  }
  if (from === to) {
    throw new HttpError(409,
      to === 'review'
        ? 'এই রুটিন আগে থেকেই পর্যালোচনায় আছে।'
        : 'এই রুটিন আগে থেকেই খসড়া অবস্থায় আছে।',
      'already_in_status');
  }
  await c.query(`UPDATE routines SET status = $2 WHERE id = $1`, [routineId, to]);
  await writeAudit(c as never, ctx, {
    action: to === 'review' ? 'rms.routine.submit' : 'rms.routine.withdraw',
    entityType: 'routine',
    entityId: routineId,
    after: { status: to, fromStatus: from },
  });
  return {
    ok: true,
    status: to,
    statusBn: STATUS_BN[to],
    messageBn: to === 'review'
      ? 'রুটিনটি পর্যালোচনার জন্য পাঠানো হয়েছে। এখনো কেউ এটি দেখতে পাচ্ছে না।'
      : 'রুটিনটি আবার খসড়ায় ফেরানো হয়েছে।',
  };
}

/* --------------------------------------------------------------- handler */

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const cors = corsHeaders([], 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }

  try {
    const claims = await authenticate(req);
    requireRole(claims, REVIEW_ROLES);
    const db = await sharedDb();
    const ctx = { tenantId: claims.tid, userId: claims.sub, role: claims.role };

    if (req.method === 'GET') {
      const url = new URL(req.url ?? '/', 'http://internal');
      const yearId = url.searchParams.get('yearId') ?? '';
      const routineId = url.searchParams.get('routineId') ?? '';

      if (UUID_RE.test(routineId)) {
        const out = await db.withTenant(ctx, async (c) => {
          const r = await reviewRoutine(c as Client, routineId);
          if (!r) throw new HttpError(404, 'routine not found', 'routine_not_found');
          return decorate(c as Client, r);
        });
        json(res, 200, { ok: true, routine: out }, cors);
        return;
      }
      if (!UUID_RE.test(yearId)) {
        throw new HttpError(400, 'শিক্ষাবর্ষ বেছে নিন', 'invalid_year_id');
      }
      const out = await db.withTenant(ctx, async (c) => {
        const h = await head(c as Client, yearId);
        if (!h) throw new HttpError(404, 'academic year not found', 'year_not_found');
        const ids = await routinesForYear(c as Client, yearId);
        const entries: Entry[] = [];
        for (const id of ids) {
          const r = await reviewRoutine(c as Client, id);
          if (r) entries.push(await decorate(c as Client, r));
        }
        return { ok: true, ...h, routines: entries };
      });
      json(res, 200, out, cors);
      return;
    }

    if (req.method !== 'POST') { json(res, 405, { error: 'method_not_allowed' }, cors); return; }

    const body = await readJson<{
      action?: string; routineId?: string; fingerprint?: string;
      confirmWarnings?: boolean;
    }>(req);
    const routineId = String(body.routineId ?? '');
    const action = String(body.action ?? '');

    if (action === 'submit' || action === 'withdraw') {
      const out = await db.withTenant(ctx, (c) =>
        moveStatus(c as Client, ctx, routineId, action === 'submit' ? 'review' : 'draft'),
      { write: true });
      json(res, 200, out, cors);
      return;
    }
    if (action === 'publish') {
      // The editor's button and this screen call the SAME function. There is
      // no second set of publish rules to drift out of step.
      const out = await db.withTenant(ctx, (c) =>
        publishRoutine(c as never, ctx, routineId, {
          fingerprint: typeof body.fingerprint === 'string' && body.fingerprint
            ? body.fingerprint : undefined,
          confirmWarnings: body.confirmWarnings === true,
        }), { write: true });
      json(res, 200, {
        ...out,
        messageBn: 'রুটিন প্রকাশিত হয়েছে। শিক্ষক ও শিক্ষার্থীরা এখন এটি দেখতে পাবেন।',
      }, cors);
      return;
    }
    throw new HttpError(400,
      "action must be 'submit', 'withdraw' or 'publish'", 'unknown_action');
  } catch (err) {
    if (err instanceof HttpError) {
      json(res, err.status, { error: err.code, message: err.message, ...(err.detail ?? {}) }, cors);
      return;
    }
    console.error('[rms/publish]', err);
    json(res, 500, {
      error: 'internal_error',
      // §7. The publish is one UPDATE inside one transaction; a failure
      // leaves the routine exactly as it was, and saying so is what stops a
      // coordinator publishing twice.
      messageBn: 'প্রকাশ করা যায়নি — রুটিন আগের অবস্থাতেই আছে।',
    }, cors);
  }
}
