/**
 * The go-live switches, in one place.  (R-8)
 *
 * The master plan's R-8 reads like a list of environment variables:
 * "`OTP_SENDING_ENABLED=true`, `LOGIN_DISABLED=false` (gate already
 * satisfied)". They were not environment variables. All three were hardcoded
 * `const` declarations in three different files:
 *
 *     services/identity-svc/api/otp-request.ts   const OTP_SENDING_ENABLED = false
 *     services/finance-svc/api/index.ts          const MFS_PAYMENTS_ENABLED = false
 *     apps/pwa/src/login-view.ts                 export const LOGIN_DISABLED = true
 *
 * So "flipping the switch" meant editing three files, rebuilding, and
 * redeploying — on the day a school is waiting to log in, with a code change
 * in the path. That is not a switch; it is a release. R-8's real work is
 * making these configuration, so going live is something an operator does to
 * the environment rather than something an engineer does to the source.
 *
 * ── Fail closed, and mean it ────────────────────────────────────────────
 * Every switch here defaults OFF. An unset variable, a typo, a lost env file
 * — all of them leave the product in the state it is in today rather than
 * accidentally texting nine hundred guardians. `enabled()` only accepts the
 * exact strings below; `ENABLED`, `yes` and `1` are deliberately NOT among
 * them, because a switch that guesses what you meant is a switch that can be
 * turned on by accident.
 *
 * ── Why one module and not three constants ──────────────────────────────
 * The readiness screen in the platform console reports what is on. If it read
 * the environment itself it would be a second opinion, and the two would
 * drift the first time a variable was renamed. It calls these functions, so
 * the screen and the endpoint cannot disagree about whether SMS is live.
 */

/**
 * Strictly `true` or `false`, nothing else.
 *
 * A missing variable and a misspelt one give the same answer as `false`,
 * which is the answer that cannot hurt anybody.
 */
export function enabled(name: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return (env[name] ?? '').trim().toLowerCase() === 'true';
}

/**
 * OTP login. Gated on F-102 rate limiting, which has been live since
 * migration 020 — so this variable is the only thing left, and it needs the
 * SMS aggregator underneath it to be useful.
 */
export function otpSendingEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return enabled('OTP_SENDING_ENABLED', env);
}

/**
 * MFS payment INITIATION. The webhooks are unaffected and stay open: a
 * settlement for a payment made before the switch was thrown must still land.
 */
export function mfsPaymentsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return enabled('MFS_PAYMENTS_ENABLED', env);
}

/** The AI gateway is enabled by the PRESENCE of its key, not by a flag. */
export function aiEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return !!env.ANTHROPIC_API_KEY;
}

/**
 * Is a real SMS aggregator configured?
 *
 * Deliberately not "is SMS_PROVIDER set" — a provider named without its
 * credentials is not configured, it is broken, and the readiness screen must
 * say so rather than showing a tick.
 */
export function smsProviderConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  const name = (env.SMS_PROVIDER ?? '').trim().toLowerCase();
  if (!name || name === 'stub') return false;
  if (name === 'ssl_wireless') {
    return !!env.SMS_ENDPOINT && !!env.SMS_API_TOKEN && !!env.SMS_SENDER_ID;
  }
  return false;
}

/** One readiness item, as the console renders it. */
export interface GoLiveCheck {
  key: string;
  /** What an operator would call it. */
  labelBn: string;
  ready: boolean;
  /** Why it is not ready, or what it is when it is. Never a bare boolean. */
  detailBn: string;
  /**
   * `blocking` items stop real students using the product. `advisory` ones
   * are posture — worth fixing before a pilot, not before a login.
   */
  severity: 'blocking' | 'advisory';
}

/**
 * The R-8 checklist, computed from the environment rather than ticked by a
 * person.
 *
 * A checklist someone maintains by hand is a checklist that is wrong the
 * first time a variable is removed. Every line here is derived, so it cannot
 * claim readiness the deployment does not have.
 *
 * The items the master plan lists that are NOT environment-observable — the
 * aggregator contract itself, the data-residency decision, the pilot — are
 * absent by design. This screen answers "is this deployment configured", and
 * inventing a checkbox for "have we signed with SSL Wireless" would put a
 * commercial fact behind a tick nobody could verify.
 */
export function goLiveChecks(env: NodeJS.ProcessEnv = process.env): GoLiveCheck[] {
  const smsReady = smsProviderConfigured(env);
  const otp = otpSendingEnabled(env);

  return [
    {
      key: 'sms_provider',
      labelBn: 'এসএমএস অ্যাগ্রিগেটর',
      ready: smsReady,
      detailBn: smsReady
        ? `${env.SMS_PROVIDER} — প্রেরক আইডি ${env.SMS_SENDER_ID}`
        : (env.SMS_PROVIDER ?? '').trim() && (env.SMS_PROVIDER ?? '').trim() !== 'stub'
          ? 'প্রোভাইডার নির্বাচিত, কিন্তু ক্রেডেনশিয়াল অসম্পূর্ণ — বার্তা যাবে না'
          : 'কোনো অ্যাগ্রিগেটর নেই — বার্তা লগে যায়, ফোনে নয়',
      severity: 'blocking',
    },
    {
      key: 'sms_dlr',
      labelBn: 'ডেলিভারি রিপোর্ট',
      ready: !!env.SMS_DLR_SECRET,
      detailBn: env.SMS_DLR_SECRET
        ? 'অ্যাগ্রিগেটর ডেলিভারি জানাতে পারবে'
        : 'SMS_DLR_SECRET নেই — বার্তা পৌঁছেছে কি না জানা যাবে না',
      severity: 'advisory',
    },
    {
      key: 'otp_login',
      labelBn: 'ওটিপি লগইন',
      ready: otp,
      detailBn: otp
        ? (smsReady ? 'চালু' : 'চালু — কিন্তু অ্যাগ্রিগেটর ছাড়া ওটিপি পৌঁছাবে না')
        : 'বন্ধ — অ্যাক্টিভেশন কোড দিয়ে লগইন চলছে',
      severity: 'blocking',
    },
    {
      key: 'pii_key',
      labelBn: 'পিআইআই এনক্রিপশন কী',
      ready: !!env.PII_MASTER_KEY_V1,
      detailBn: env.PII_MASTER_KEY_V1
        ? 'জন্ম নিবন্ধন ও এনআইডি সংরক্ষণ করা যাবে'
        : 'নেই — জন্ম নিবন্ধন নম্বরসহ সারি আমদানিতে বাদ পড়বে',
      severity: 'blocking',
    },
    {
      key: 'mfs',
      labelBn: 'অনলাইন ফি (এমএফএস)',
      ready: mfsPaymentsEnabled(env),
      detailBn: mfsPaymentsEnabled(env)
        ? 'চালু'
        : 'বন্ধ — অভিভাবক অফিসে ফি দেবেন',
      severity: 'advisory',
    },
    {
      key: 'ai',
      labelBn: 'এআই সহায়ক',
      ready: aiEnabled(env),
      detailBn: aiEnabled(env)
        ? 'চালু — প্রতিষ্ঠানভিত্তিক টোকেন সীমা প্রযোজ্য'
        : 'বন্ধ — ANTHROPIC_API_KEY নেই',
      severity: 'advisory',
    },
    {
      key: 'maintenance_cron',
      labelBn: 'রাত্রিকালীন রক্ষণাবেক্ষণ',
      ready: !!env.DATABASE_MAINTENANCE_URL,
      detailBn: env.DATABASE_MAINTENANCE_URL
        ? 'পার্টিশন ও পুরনো তথ্য পরিষ্কার হবে'
        : 'DATABASE_MAINTENANCE_URL নেই — পার্টিশন তৈরি হবে না',
      severity: 'blocking',
    },
    {
      key: 'platform_console',
      labelBn: 'প্ল্যাটফর্ম কনসোল',
      // If this is false the operator is not reading this screen, but it
      // belongs in the list so the list is the whole posture.
      ready: !!env.PLATFORM_API_KEY && !!env.PLATFORM_DATABASE_URL,
      detailBn: env.PLATFORM_API_KEY && env.PLATFORM_DATABASE_URL
        ? 'নতুন প্রতিষ্ঠান যোগ করা যাবে'
        : 'অসম্পূর্ণ — অনবোর্ডিং ম্যানুয়াল রানবুকে ফিরে যাবে',
      severity: 'advisory',
    },
  ];
}
