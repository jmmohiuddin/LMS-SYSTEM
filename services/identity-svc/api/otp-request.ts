/**
 * POST /api/v1/auth/otp/request
 * Body: { tenantId, phone, purpose }
 *
 * Off by default — see OTP_SENDING_ENABLED below.
 *
 * Until R-8 the code was only written to the server log, and, when the caller
 * presented SERVICE_API_KEY via X-Debug-Otp, echoed back in the response for
 * testing. It now goes to `sms_outbox` in the same transaction as the
 * challenge, so the ordinary dispatcher → provider → aggregator path carries
 * it and a delivery report comes back against it. The debug echo is kept: it
 * is how the acceptance run reads a code without a phone, and it still
 * requires the service key.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { sharedDb } from '../../../packages/server-core/src/db.ts';
import { corsHeaders, readJson, json, header, HttpError } from '../../../packages/server-core/src/http.ts';
import { randomOtpCode, sha256Buf } from '../../../packages/server-core/src/crypto.ts';
import { enforceIdentityRateLimit } from '../../../packages/server-core/src/rate-limit.ts';
import { otpSendingEnabled } from '../../../packages/server-core/src/go-live.ts';
import {
  matchServiceKey, looksLikeBrowser, keyFingerprint, logServiceKeyEvent,
  tenantSwitchAllowed,
} from '../../../packages/server-core/src/service-auth.ts';

const PHONE_RE = /^\+8801[3-9][0-9]{8}$/;
const PURPOSES = new Set(['login', 'enrol_device', 'reset_password', 'verify_phone']);
const MIN_RESEND_INTERVAL_SECONDS = 45;
const OTP_TTL_MINUTES = 5;
/** The same number for a reader rather than for an interval. */
const OTP_TTL_MINUTES_BN = '৫';

// R-8: this was a hardcoded `const … = false`, so resuming OTP login meant
// editing this file, rebuilding and redeploying — on the day a school is
// waiting to log in, with a code change in the path. It is now
// `OTP_SENDING_ENABLED` in the environment, read per request so the switch
// takes effect on the next invocation rather than the next deploy.
//
// It still fails CLOSED: unset, misspelt, or anything other than the exact
// string "true" leaves OTP off. While off, no challenge row is created and
// nothing is logged — the rest of the auth system (verify/refresh/logout,
// existing sessions) is untouched, so already-logged-in teachers keep working
// and activation-code login is unaffected.

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

  if (!otpSendingEnabled()) {
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

    // F-102, identity dimension. The dispatcher charged this request's IP
    // bucket; this is the first point the phone number exists to charge.
    // Placed before any database write or SMS send, so a refused request
    // costs nothing downstream. Keyed on tenant+phone: the same number at
    // two schools is two identities.
    if (!(await enforceIdentityRateLimit(res, cors, 'otp_request', `${tenantId}:${phone}`))) return;

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

      // R-8. This was `console.log(code)` and a comment saying the aggregator
      // was a follow-up — which meant that turning OTP_SENDING_ENABLED on, on
      // a deployment with a fully configured aggregator, produced a challenge
      // whose code reached nobody. The readiness screen would have shown OTP
      // and SMS both green while login was impossible for every real user,
      // which is the exact failure this phase exists to prevent.
      //
      // The code now goes into `sms_outbox`, in the SAME transaction as the
      // challenge: if the queue insert fails the challenge is rolled back
      // with it, so there is never a code the product believes it sent.
      const org = await client.query<{ name_bn: string | null }>(
        `SELECT name_bn FROM tenants WHERE id = $1`, [tenantId],
      );
      // Signed with the SCHOOL's name. A parent receiving "— ShikhonBD" would
      // be reading their software vendor's brand on a message from their
      // child's school; D11 puts the platform brand nowhere near a guardian.
      // The fallback is a neutral word, never the platform's name.
      const orgName = org.rows[0]?.name_bn ?? 'বিদ্যালয়';
      // The two numbers in this message are deliberately in different digits.
      // The duration is prose and takes Bangla numerals like every other
      // number the product shows a parent. The CODE stays in Latin digits
      // because it is not prose — it is a literal to be typed back into a
      // field, and a person reading ৯৯৫৯৪৭ off an SMS has to transliterate it
      // before they can enter it.
      const smsBody = `আপনার লগইন কোড ${code}। ${OTP_TTL_MINUTES_BN} মিনিটের মধ্যে ব্যবহার করুন। কাউকে জানাবেন না। — ${orgName}`;

      await client.query(
        `INSERT INTO sms_outbox
           (tenant_id, msisdn, template_code, locale, body, encoding, segments,
            priority, dedupe_key, context)
         VALUES ($1, $2, 'auth.otp.v1', 'bn', $3, 'unicode', $4, 1, $5, $6)`,
        [
          tenantId, phone, smsBody,
          // Bangla forces UCS-2: 70 characters to a segment, not 160.
          Math.max(1, Math.ceil(smsBody.length / 70)),
          // Keyed on the CHALLENGE, not on the phone and the day. A person
          // who did not receive the first code asks for another one, and the
          // daily dedupe index would have swallowed every retry after the
          // first — locking them out for the rest of the day.
          `otp:${inserted.rows[0].id}`,
          // The code itself is never put in `context`: that column is read
          // by the dispatcher's logs and by support.
          JSON.stringify({ purpose, challengeId: inserted.rows[0].id }),
        ],
      );

      // R-8 §2. Echoing a live OTP is an account-takeover primitive: whoever
      // reads it becomes that person. So it now sits behind the same single
      // switch as service-key tenant switching — off in production unless
      // SERVICE_KEY_TENANT_SWITCH says otherwise — and is refused outright
      // from a browser, since no legitimate caller of it is a page. Dev and CI
      // are unchanged, which is where the acceptance run needs it.
      const debugKey = header(req, 'x-debug-otp');
      const debugLabel = matchServiceKey(debugKey, process.env);
      const isDebugAuthorized = debugLabel !== null
        && tenantSwitchAllowed(process.env)
        && looksLikeBrowser(req) === null;
      if (debugLabel !== null) {
        logServiceKeyEvent({
          event: isDebugAuthorized ? 'otp_debug_echo' : 'otp_debug_echo_refused',
          endpoint: 'auth/otp/request', fingerprint: keyFingerprint(debugKey),
          keyLabel: debugLabel,
        });
      }

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
