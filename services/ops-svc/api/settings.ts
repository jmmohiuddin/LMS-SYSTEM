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
import { pushReplacesSms } from '../../sms-svc/src/push-send.ts';
import { vapidFromEnv } from '../../../packages/server-core/src/web-push.ts';

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
    const patch = await readJson<{
      sms?: { noticeMaxChars?: unknown };
      push?: { replacesSms?: unknown };
    }>(req);

    const raw = patch.sms?.noticeMaxChars;
    const rawPush = patch.push?.replacesSms;
    if (raw === undefined && rawPush === undefined) {
      throw new HttpError(400, 'কিছু পরিবর্তন করা হয়নি', 'nothing_to_update');
    }

    // R-9. A boolean, and strictly a boolean. This setting decides whether a
    // guardian stops receiving an SMS, so "truthy" is not good enough — a
    // stray string from a form that forgot to parse its checkbox must not
    // silently switch a school's safety net off.
    if (rawPush !== undefined && typeof rawPush !== 'boolean') {
      throw new HttpError(400, 'হ্যাঁ বা না নির্বাচন করুন', 'bad_boolean',
        { field: 'replacesSms' });
    }
    if (rawPush === true && vapidFromEnv() === null) {
      // Refusing is kinder than accepting. A school that switched this on
      // would believe push was carrying its messages, and instead nothing
      // would carry them: the setting only suppresses SMS for a push that was
      // ACCEPTED, so no push service means no suppression — but the principal
      // has no way to know that, and would stop watching.
      throw new HttpError(409,
        'এই সার্ভারে পুশ নোটিফিকেশন চালু নেই — আগে সেটি চালু করতে হবে',
        'push_not_configured');
    }

    // Reject rather than silently clamp. A principal who typed 900 and was
    // shown 480 without being told would believe the school sends 900.
    //
    // R-9 made both keys independently optional — the SMS screen and the push
    // screen save separately — so this only runs when a length was actually
    // sent. Validating an absent field would make changing the push toggle
    // impossible without also restating the SMS length.
    let n = NaN;
    if (raw !== undefined) {
      n = typeof raw === 'number' ? raw
        : (typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN);
      if (!Number.isFinite(n) || !Number.isInteger(n)) {
        throw new HttpError(400, 'সংখ্যা লিখুন', 'bad_number', { field: 'noticeMaxChars' });
      }
      if (n < NOTICE_SMS_MIN || n > NOTICE_SMS_HARD_CEILING) {
        throw new HttpError(400,
          `${NOTICE_SMS_MIN} থেকে ${NOTICE_SMS_HARD_CEILING} অক্ষরের মধ্যে দিন`,
          'out_of_range', { field: 'noticeMaxChars', min: NOTICE_SMS_MIN, max: NOTICE_SMS_HARD_CEILING });
      }
    }

    const body = await db.withTenant(ctx, async (c) => {
      const { rows: before } = await c.query<{ settings: unknown }>(
        `SELECT COALESCE(settings, '{}'::jsonb) AS settings FROM tenants`,
      );
      const previous = noticeSmsMaxChars(before[0]?.settings ?? null);
      const previousPush = pushReplacesSms(before[0]?.settings ?? null);

      // ── Merge, and NOT jsonb_set ──────────────────────────────────
      //
      // This used `jsonb_set(settings, '{sms,noticeMaxChars}', …, true)`, and
      // that is a silent no-op whenever the PARENT key is absent:
      //
      //   jsonb_set('{}', '{sms,noticeMaxChars}', '180', true)  →  {}
      //
      // `create_missing` creates the LAST element of the path, not the object
      // that would contain it. So on a school whose `settings` had never held
      // an `sms` object — every freshly provisioned school — this endpoint
      // returned 200, the screen said সংরক্ষিত, and nothing was written. The
      // value read back as the default on the next visit, which reads like the
      // school changing its mind rather than like a bug.
      //
      // Found in R-9's browser acceptance, because `push` is a key that never
      // pre-exists, so it failed on the FIRST save every time rather than only
      // on schools with empty settings.
      //
      // `||` merges and creates. Applied at both levels so the branding object
      // beside these keys survives, and so does the other key inside the same
      // sub-object.
      const sets: string[] = [];
      const args: unknown[] = [];
      if (raw !== undefined) {
        args.push(n);
        sets.push(`jsonb_build_object('sms',
          COALESCE(settings->'sms', '{}'::jsonb)
          || jsonb_build_object('noticeMaxChars', to_jsonb($${args.length}::int)))`);
      }
      if (rawPush !== undefined) {
        args.push(rawPush);
        sets.push(`jsonb_build_object('push',
          COALESCE(settings->'push', '{}'::jsonb)
          || jsonb_build_object('replacesSms', to_jsonb($${args.length}::boolean)))`);
      }
      const { rows } = await c.query<{ settings: unknown }>(
        `UPDATE tenants
            SET settings = COALESCE(settings, '{}'::jsonb) || ${sets.join(' || ')}
          RETURNING settings`,
        args,
      );
      if (rows.length === 0) {
        // RLS refused: the caller's tenant row is not writable by them.
        throw new HttpError(403, 'পরিবর্তনের অনুমতি নেই', 'forbidden');
      }

      await writeAudit(c, ctx, {
        action: 'ops.settings.update',
        entityType: 'tenant',
        entityId: ctx.tenantId,
        // Both keys are recorded whether or not they changed: an audit row
        // reading "replacesSms: false → false" is how someone later proves a
        // school's SMS was NOT silently switched off in this edit.
        before: { noticeMaxChars: previous, pushReplacesSms: previousPush },
        after: {
          noticeMaxChars: raw === undefined ? previous : n,
          pushReplacesSms: rawPush === undefined ? previousPush : rawPush,
        },
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
    push: {
      // Whether this school has opted into letting a delivered push cancel
      // the SMS…
      replacesSms: pushReplacesSms(settings),
      // …and whether the DEPLOYMENT can push at all. The screen needs both:
      // the toggle is meaningless without VAPID keys, and saying so is more
      // useful than a switch that appears to work and changes nothing.
      available: vapidFromEnv() !== null,
    },
  };
}
