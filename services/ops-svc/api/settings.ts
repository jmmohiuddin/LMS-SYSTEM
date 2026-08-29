/**
 * GET /api/v1/ops/settings — the school's operational settings
 * PUT /api/v1/ops/settings — change them
 *
 * R-3 of docs/11-MASTER-PLAN.md, Part J. This endpoint exists because of a
 * specific failure, and it is worth saying which one.
 *
 * R-2's finalisation made the notice-SMS length tenant-configurable at
 * `tenants.settings->'sms'->>'noticeMaxChars'`, wrote six tests for the
 * reader, clamped it, and documented it in three files — and provided no way
 * to set it except writing SQL by hand against production. That is what D13
 * now calls "Backend complete — UI pending", and this is the write path it
 * was missing. A setting only a developer can reach is a setting the school
 * does not have.
 *
 * ── Validation lives with the reader, not here ──────────────────────────
 * The clamping rules are sms-svc's `noticeSmsMaxChars()` — 70 (one Bangla
 * UCS-2 segment) to a 480 hard ceiling, defaulting to 180. This endpoint
 * imports and applies exactly that function rather than restating the numbers,
 * so the value a school can save is by construction a value the sender will
 * honour. Two copies of the range would eventually disagree, and the direction
 * they disagree in is the one that costs money.
 *
 * ── Merge, never replace ────────────────────────────────────────────────
 * `tenants.settings` is one jsonb blob holding branding (R-1), provisioning
 * seeds, and now this. A PUT that wrote the whole object would let the SMS
 * screen blank the school's logo. `jsonb_set` on the one key it owns, same
 * shape as R-1's branding writer.
 *
 * ── There is no tenant parameter ────────────────────────────────────────
 * The only tenant a caller can name is the one they authenticated as. R-1's
 * `tenant_self` RLS policy is the boundary; requireRole is the clean 403 in
 * front of it.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { sharedDb } from '../../../packages/server-core/src/db.ts';
import { corsHeaders, readJson, json, HttpError } from '../../../packages/server-core/src/http.ts';
import { authenticate, requireRole } from '../../../packages/server-core/src/auth.ts';
import { writeAudit } from '../../../packages/server-core/src/audit.ts';
import {
  noticeSmsMaxChars,
  NOTICE_SMS_DEFAULT_MAX,
  NOTICE_SMS_HARD_CEILING,
  NOTICE_SMS_MIN,
} from '../../sms-svc/src/dispatch.ts';

/** Same four roles that own branding — these are structural settings. */
const SETTINGS_ROLES = ['principal', 'school_owner', 'it_admin', 'academic_coordinator'];

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const cors = corsHeaders([], 'GET, PUT, OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }

  try {
    const claims = await authenticate(req);
    const db = await sharedDb();
    const ctx = { tenantId: claims.tid, userId: claims.sub, role: claims.role };

    if (req.method === 'GET') {
      // Readable by any staff member: a class teacher composing a notice
      // benefits from knowing the SMS cap they are writing against, and it
      // is not a secret. Writing is the gated act.
      const body = await db.withTenant(ctx, async (c) => {
        const { rows } = await c.query<{ settings: unknown }>(
          `SELECT COALESCE(settings, '{}'::jsonb) AS settings FROM tenants`,
        );
        return settingsPayload(rows[0]?.settings ?? {});
      });
      json(res, 200, body, cors);
      return;
    }

    if (req.method !== 'PUT') { json(res, 405, { error: 'method_not_allowed' }, cors); return; }

    requireRole(claims, SETTINGS_ROLES);
    const patch = await readJson<{ sms?: { noticeMaxChars?: unknown } }>(req);

    const raw = patch.sms?.noticeMaxChars;
    if (raw === undefined) {
      throw new HttpError(400, 'কিছু পরিবর্তন করা হয়নি', 'nothing_to_update');
    }

    // Reject rather than silently clamp. A principal who typed 900 and was
    // shown 480 without being told would believe the school sends 900.
    const n = typeof raw === 'number' ? raw
      : (typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN);
    if (!Number.isFinite(n) || !Number.isInteger(n)) {
      throw new HttpError(400, 'সংখ্যা লিখুন', 'bad_number', { field: 'noticeMaxChars' });
    }
    if (n < NOTICE_SMS_MIN || n > NOTICE_SMS_HARD_CEILING) {
      throw new HttpError(400,
        `${NOTICE_SMS_MIN} থেকে ${NOTICE_SMS_HARD_CEILING} অক্ষরের মধ্যে দিন`,
        'out_of_range', { field: 'noticeMaxChars', min: NOTICE_SMS_MIN, max: NOTICE_SMS_HARD_CEILING });
    }

    const body = await db.withTenant(ctx, async (c) => {
      const { rows: before } = await c.query<{ settings: unknown }>(
        `SELECT COALESCE(settings, '{}'::jsonb) AS settings FROM tenants`,
      );
      const previous = noticeSmsMaxChars(before[0]?.settings ?? null);

      const { rows } = await c.query<{ settings: unknown }>(
        // jsonb_set with create_missing, on the one key this screen owns.
        // The branding object beside it is untouched.
        `UPDATE tenants
            SET settings = jsonb_set(
                  COALESCE(settings, '{}'::jsonb),
                  '{sms,noticeMaxChars}',
                  to_jsonb($1::int),
                  true)
          RETURNING settings`,
        [n],
      );
      if (rows.length === 0) {
        // RLS refused: the caller's tenant row is not writable by them.
        throw new HttpError(403, 'পরিবর্তনের অনুমতি নেই', 'forbidden');
      }

      await writeAudit(c, ctx, {
        action: 'ops.settings.update',
        entityType: 'tenant',
        entityId: ctx.tenantId,
        before: { noticeMaxChars: previous },
        after: { noticeMaxChars: n },
      });

      return settingsPayload(rows[0].settings);
    });

    json(res, 200, body, cors);
  } catch (err) {
    if (err instanceof HttpError) {
      json(res, err.status, { error: err.code, message: err.message, ...(err.detail ?? {}) }, cors);
      return;
    }
    json(res, 500, { error: 'internal_error' }, cors);
  }
}

/**
 * What the settings screen renders. The limits travel WITH the value so the
 * form's validation is the server's validation, and a future change to the
 * ceiling reaches the screen without a matching frontend deploy.
 */
function settingsPayload(settings: unknown) {
  return {
    sms: {
      noticeMaxChars: noticeSmsMaxChars(settings),
      default: NOTICE_SMS_DEFAULT_MAX,
      min: NOTICE_SMS_MIN,
      max: NOTICE_SMS_HARD_CEILING,
      // Bangla forces UCS-2, so a segment is 70 characters rather than 160.
      // The screen needs this to show a cost, and it is not a number the
      // frontend should be carrying its own copy of.
      charsPerSegment: NOTICE_SMS_MIN,
    },
  };
}
