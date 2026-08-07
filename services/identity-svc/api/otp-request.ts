/**
 * POST /api/v1/auth/otp/request
 * Body: { tenantId, phone, purpose }
 *
 * Currently disabled — see OTP_SENDING_ENABLED below. Real SMS sending was
 * never wired to a real aggregator (no credentials yet); the code was only
 * logged server-side (vercel logs) and, when the caller presented
 * SERVICE_API_KEY via X-Debug-Otp, echoed back in the response for testing.
 * That plumbing is left in place below the kill switch for when it's
 * re-enabled.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { sharedDb } from '../../../packages/server-core/src/db.ts';
import { corsHeaders, readJson, json, header, HttpError } from '../../../packages/server-core/src/http.ts';
import { randomOtpCode, sha256Buf } from '../../../packages/server-core/src/crypto.ts';

const PHONE_RE = /^\+8801[3-9][0-9]{8}$/;
const PURPOSES = new Set(['login', 'enrol_device', 'reset_password', 'verify_phone']);
const MIN_RESEND_INTERVAL_SECONDS = 45;
const OTP_TTL_MINUTES = 5;

// Kill switch: flip to `true` and redeploy to resume issuing OTP codes.
// While `false`, no challenge row is created and nothing is logged — the
// rest of the auth system (verify/refresh/logout, existing sessions) is
// untouched, so already-logged-in teachers keep working.
const OTP_SENDING_ENABLED = false;

interface OtpRequestBody {
  tenantId?: string;
  phone?: string;
  purpose?: string;
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

  if (!OTP_SENDING_ENABLED) {
    json(res, 503, { error: 'otp_disabled', message: 'OTP login is temporarily unavailable' }, cors);
    return;
  }

  try {
    const body = await readJson<OtpRequestBody>(req);
    const tenantId = body.tenantId ?? '';
    const phone = body.phone ?? '';
    const purpose = body.purpose ?? 'login';

    if (!tenantId) throw new HttpError(400, 'tenantId is required', 'tenant_required');
    if (!PHONE_RE.test(phone)) throw new HttpError(400, 'phone must be a valid +8801XXXXXXXXX number', 'invalid_phone');
    if (!PURPOSES.has(purpose)) throw new HttpError(400, `purpose must be one of ${[...PURPOSES].join(', ')}`, 'invalid_purpose');

    const db = await sharedDb();
    const result = await db.withTenant({ tenantId, userId: '', role: 'system_ingest' }, async (client) => {
      const recent = await client.query<{ created_at: string }>(
        `SELECT created_at FROM otp_challenges
          WHERE tenant_id = $1 AND phone_e164 = $2 AND purpose = $3
            AND consumed_at IS NULL AND expires_at > now()
          ORDER BY created_at DESC LIMIT 1`,
        [tenantId, phone, purpose],
      );
      if (recent.rows[0]) {
        const ageSeconds = (Date.now() - new Date(recent.rows[0].created_at).getTime()) / 1000;
        if (ageSeconds < MIN_RESEND_INTERVAL_SECONDS) {
          throw new HttpError(429, 'an OTP was already sent recently, please wait before retrying', 'too_soon');
        }
      }

      const code = randomOtpCode(6);
      const codeHash = sha256Buf(code);
      const inserted = await client.query<{ id: string; expires_at: string }>(
        `INSERT INTO otp_challenges (tenant_id, phone_e164, code_hash, purpose, expires_at)
         VALUES ($1, $2, $3, $4, now() + ($5 || ' minutes')::interval)
         RETURNING id, expires_at`,
        [tenantId, phone, codeHash, purpose, OTP_TTL_MINUTES],
      );

      // Stub SMS send — real aggregator integration is a follow-up.
      console.log(`[otp-request] tenant=${tenantId} phone=${phone} purpose=${purpose} code=${code}`);

      const debugKey = header(req, 'x-debug-otp');
      const isDebugAuthorized = !!process.env.SERVICE_API_KEY && debugKey === process.env.SERVICE_API_KEY;

      return {
        challengeId: inserted.rows[0].id,
        expiresAt: inserted.rows[0].expires_at,
        ...(isDebugAuthorized ? { debugCode: code } : {}),
      };
    });

    json(res, 200, { ok: true, ...result }, cors);
  } catch (err) {
    if (err instanceof HttpError) {
      json(res, err.status, { error: err.code ?? 'error', message: err.message }, cors);
      return;
    }
    console.error('[otp-request] unexpected error', err);
    json(res, 500, { error: 'internal_error' }, cors);
  }
}
