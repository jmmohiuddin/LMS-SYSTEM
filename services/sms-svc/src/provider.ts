/**
 * The SMS provider seam.  (R-8)
 *
 * The master plan's R-8 says "implement the real provider adapter behind the
 * existing interface". There was no interface: `SmsDispatchWorker` called a
 * private `sendStub()` directly, and the comment above it said swapping in a
 * real provider "only touches sendStub below" — which was true and is exactly
 * the shape that makes a provider swap a code change to the worker.
 *
 * This is that interface. The worker now asks for a provider and sends
 * through it; which one it gets is an environment decision, made once at
 * `resolveProvider()`.
 *
 * ── Nothing here invents a credential ───────────────────────────────────
 * Without `SMS_PROVIDER` set, or with its credentials absent, the stub is
 * returned and the log line is unchanged. That is not a fallback bolted on
 * for safety — it is the correct behaviour until an aggregator contract
 * exists, and it fails LOUDLY in one specific case: if `SMS_PROVIDER` names a
 * real provider and its credentials are missing, `resolveProvider` throws
 * rather than quietly sending nothing. A school that believes its messages
 * are going out is worse off than one that knows they are not.
 *
 * ── Why SSL Wireless is the shape ───────────────────────────────────────
 * It is the aggregator most Bangladeshi schools' vendors resell, and its API
 * is the plainest of the three the plan names: a form POST with an api_token,
 * a sid, and a csms_id we choose for idempotency. ADN and Robi differ in
 * field names and envelope, not in shape, so they are additional
 * implementations of this interface rather than changes to it.
 *
 * The delivery report is a separate inbound call — see `api/dlr.ts`. The
 * provider tells us `sent`; only the DLR tells us `delivered`, and the
 * database has carried `delivered_at`, `error_code` and `cost_bdt` since
 * migration 001 waiting for it.
 */

export interface SendResult {
  /** The provider's own id, stored on the row so a DLR can find it again. */
  providerMsgId: string;
  /** What goes in `sms_outbox.provider`. */
  provider: string;
  /** Per-message cost when the provider reports one; NULL is honest otherwise. */
  costBdt?: number | null;
}

export interface SmsProvider {
  readonly name: string;
  /** True when this provider actually reaches a network. */
  readonly live: boolean;
  send(msisdn: string, body: string, csmsId: string): Promise<SendResult>;
}

/**
 * The stub. Logs and returns an id, exactly as before R-8.
 *
 * `live: false` is what the readiness endpoint reports to the operator, so
 * "SMS is not really sending" is visible on a screen rather than inferable
 * from a log line nobody is watching.
 */
export class StubProvider implements SmsProvider {
  readonly name = 'stub';
  readonly live = false;

  async send(msisdn: string, body: string, csmsId: string): Promise<SendResult> {
    const providerMsgId = `stub_${csmsId}`;
    console.log(`[sms-dispatch] STUB SEND to=${msisdn} id=${providerMsgId} body=${JSON.stringify(body)}`);
    return { providerMsgId, provider: 'stub', costBdt: null };
  }
}

/**
 * SSL Wireless, the shape most BD school vendors resell.
 *
 * `csms_id` is OUR id and the provider treats it as an idempotency key, which
 * is why the worker passes the outbox row's own id: a cron that fires twice
 * cannot send a parent the same message twice.
 */
export class SslWirelessProvider implements SmsProvider {
  readonly name = 'ssl_wireless';
  readonly live = true;

  private readonly endpoint: string;
  private readonly token: string;
  private readonly sid: string;

  constructor(o: { endpoint: string; token: string; sid: string }) {
    this.endpoint = o.endpoint;
    this.token = o.token;
    this.sid = o.sid;
  }

  async send(msisdn: string, body: string, csmsId: string): Promise<SendResult> {
    const res = await fetch(this.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_token: this.token,
        sid: this.sid,
        msisdn: msisdn.replace(/^\+/, ''),
        sms: body,
        csms_id: csmsId,
      }),
      // A school's cron must not hang on an aggregator having a bad night.
      // The row stays 'queued' and the next run retries it.
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) {
      throw new Error(`ssl_wireless HTTP ${res.status}`);
    }
    const payload = await res.json().catch(() => ({})) as {
      status?: string; status_code?: number; error_message?: string;
      smsinfo?: Array<{ sms_status?: string; reference_id?: string }>;
    };

    // The provider answers 200 with a failure inside the body, which is the
    // usual shape for this class of API. Treating HTTP 200 as success would
    // mark undelivered messages 'sent' and lose them.
    if (payload.status && payload.status.toUpperCase() !== 'SUCCESS') {
      throw new Error(`ssl_wireless ${payload.status}: ${payload.error_message ?? 'no detail'}`);
    }

    const reference = payload.smsinfo?.[0]?.reference_id;
    return {
      providerMsgId: reference ?? csmsId,
      provider: this.name,
      // Not reported per-message by this API; billing is reconciled from the
      // provider's own statement. NULL rather than a guess.
      costBdt: null,
    };
  }
}

/**
 * Which provider this deployment uses, decided once from the environment.
 *
 * Absent `SMS_PROVIDER`, the stub — the state every deployment is in until an
 * aggregator contract lands. Named but unconfigured, this THROWS: an operator
 * who set `SMS_PROVIDER=ssl_wireless` believes messages are going out, and
 * silently sending nothing would be the worst of the three outcomes.
 */
export function resolveProvider(env: NodeJS.ProcessEnv = process.env): SmsProvider {
  const name = (env.SMS_PROVIDER ?? '').trim().toLowerCase();
  if (!name || name === 'stub') return new StubProvider();

  if (name === 'ssl_wireless') {
    const token = env.SMS_API_TOKEN ?? '';
    const sid = env.SMS_SENDER_ID ?? '';
    const endpoint = env.SMS_ENDPOINT ?? '';
    const missing = [
      !endpoint && 'SMS_ENDPOINT',
      !token && 'SMS_API_TOKEN',
      !sid && 'SMS_SENDER_ID',
    ].filter(Boolean);
    if (missing.length > 0) {
      throw new Error(
        `SMS_PROVIDER=ssl_wireless but ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not set`);
    }
    return new SslWirelessProvider({ endpoint, token, sid });
  }

  throw new Error(`unknown SMS_PROVIDER "${name}" — expected 'stub' or 'ssl_wireless'`);
}
