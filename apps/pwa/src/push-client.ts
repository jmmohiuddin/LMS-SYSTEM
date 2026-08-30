/**
 * Turning notifications on, from the browser's side.  (R-9)
 *
 * The decisions live in pure functions at the top of this file and the browser
 * calls are confined to `PushClient` at the bottom. That split is the same one
 * sw-router.ts makes, and for the same reason: permission state, key encoding
 * and "what should this screen say" are all testable, and `pushManager` is not.
 *
 * ── Permission is asked for at the last possible moment ────────────────
 * A page that calls `Notification.requestPermission()` on load gets denied by
 * people who have not yet decided what the site is, and a denial is close to
 * permanent — the browser stops asking, and the only way back is a settings
 * screen most people cannot find. So the prompt happens on a click, on a
 * screen that has just explained what the notifications are for.
 */

/** What the UI must render. Every branch here is a real state a person hits. */
export type PushState =
  /** No service worker or no Push API — an old Android browser, or an iOS
   *  home-screen-less Safari. Nothing to offer. */
  | 'unsupported'
  /** The deployment has no VAPID keys. Not the person's problem to solve. */
  | 'unconfigured'
  /** Blocked at the browser level. A button here would do nothing at all,
   *  so the UI must explain where the block is instead. */
  | 'denied'
  /** Available, not yet on. */
  | 'off'
  /** On, for this browser. */
  | 'on';

export interface PushEnvironment {
  hasServiceWorker: boolean;
  hasPushManager: boolean;
  hasNotification: boolean;
  /** Push requires a secure context; localhost counts as one. */
  isSecureContext: boolean;
  permission: NotificationPermission | 'unavailable';
  /** From GET /api/v1/ops/push — does the server have VAPID keys? */
  serverEnabled: boolean;
  /** Does this browser currently hold a subscription we know about? */
  subscribed: boolean;
}

export function pushState(env: PushEnvironment): PushState {
  if (!env.hasServiceWorker || !env.hasPushManager || !env.hasNotification
      || !env.isSecureContext) {
    return 'unsupported';
  }
  // Checked before `denied` deliberately: on a deployment with no keys, a
  // person who has already blocked notifications for some other reason should
  // be told the school has not turned this on, not sent to fix their browser
  // for a feature that would not work anyway.
  if (!env.serverEnabled) return 'unconfigured';
  if (env.permission === 'denied') return 'denied';
  return env.subscribed ? 'on' : 'off';
}

/**
 * base64url → bytes, for `applicationServerKey`.
 *
 * `atob` needs standard base64 with padding and the VAPID key is base64url
 * without it. Getting this wrong throws `InvalidCharacterError` on some
 * browsers and — worse — silently produces a wrong key on others, which
 * subscribes successfully and then fails to decrypt every message.
 */
export function urlBase64ToUint8Array(base64url: string): Uint8Array {
  const padding = '='.repeat((4 - (base64url.length % 4)) % 4);
  const base64 = (base64url + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
  return out;
}

/**
 * A short, honest name for the device, so a person can tell their phone from
 * the office computer when revoking one.
 *
 * Deliberately coarse. A full user-agent string is a fingerprint, it would sit
 * in the database, and it answers a question nobody asked — "which of my
 * devices is this" needs three words, not a version number.
 */
export function deviceLabelFor(userAgent: string): string {
  const ua = userAgent.toLowerCase();
  if (/ipad|tablet/.test(ua)) return 'ট্যাবলেট';
  if (/iphone|android.*mobile|mobile/.test(ua)) return 'মোবাইল';
  if (/android/.test(ua)) return 'ট্যাবলেট';
  return 'কম্পিউটার';
}

export interface PushDevice {
  id: string;
  label: string | null;
  createdAt: string;
  lastSuccessAt: string | null;
  fingerprint: string;
}

export interface PushStatusResponse {
  enabled: boolean;
  publicKey: string | null;
  devices: PushDevice[];
}

type Fetcher = (path: string, init?: RequestInit) => Promise<Response>;

/**
 * The impure half: talks to the browser and to the server.
 *
 * Every method returns rather than throws for the outcomes a person can cause
 * — a denied prompt, an unsupported browser — because those are states to
 * render, not errors to log.
 */
/**
 * `Notification` is a global in the DOM lib but is NOT declared as a property
 * of the `Window` interface, so reaching it through an injected window is a
 * type error — which is what `tsc` had been reporting here since R-9. The
 * window is injected rather than taken from the global precisely so the tests
 * can drive this with a stub, and that is worth keeping; what it costs is
 * having to state the shape.
 *
 * Optional, because a browser without it is a real case this class handles.
 */
type NotificationWindow = Window & {
  Notification?: {
    permission: NotificationPermission;
    requestPermission(): Promise<NotificationPermission>;
  };
};

export class PushClient {
  private readonly authedFetch: Fetcher;
  private readonly nav: Navigator;
  private readonly win: NotificationWindow;

  constructor(authedFetch: Fetcher, win: NotificationWindow = globalThis.window) {
    this.authedFetch = authedFetch;
    this.win = win;
    this.nav = win.navigator;
  }

  supported(): boolean {
    return Boolean(
      this.nav && 'serviceWorker' in this.nav
      && 'PushManager' in this.win && 'Notification' in this.win
      && this.win.isSecureContext,
    );
  }

  permission(): NotificationPermission | 'unavailable' {
    const notification = this.win?.Notification;
    if (!notification) return 'unavailable';
    return notification.permission;
  }

  async status(): Promise<PushStatusResponse | null> {
    try {
      const res = await this.authedFetch('/api/v1/ops/push');
      if (!res.ok) return null;
      return (await res.json()) as PushStatusResponse;
    } catch {
      return null;
    }
  }

  /**
   * The subscription this browser currently holds, if any.
   *
   * `getRegistration()` and NOT `serviceWorker.ready`.
   *
   * `.ready` resolves when there is an ACTIVE worker — and when registration
   * has failed it does not resolve at all. Not slowly: never. A browser that
   * blocks service workers (a corporate policy, some private-window modes, a
   * failed update) left this screen on its loading skeleton permanently, with
   * no error and no way out, because the promise the loader awaited had no
   * rejection path. Found in a real browser; the unit tests could not see it,
   * because they inject a client rather than touching `navigator`.
   *
   * `getRegistration()` settles either way — with a registration or with
   * undefined — which is the question actually being asked here.
   */
  private async existing(): Promise<PushSubscription | null> {
    if (!this.supported()) return null;
    const reg = await this.nav.serviceWorker.getRegistration();
    if (!reg) return null;
    return reg.pushManager.getSubscription();
  }

  async isSubscribed(): Promise<boolean> {
    try {
      return (await this.existing()) !== null;
    } catch {
      return false;
    }
  }

  /**
   * An active worker, or a refusal after `ms`.
   *
   * Subscribing genuinely needs `.ready` — a push subscription belongs to an
   * active registration — so the hang cannot be avoided here the way it is
   * above. It is bounded instead: after the timeout the person is told the
   * app could not start its background worker, which is a sentence they can
   * act on, rather than a spinner that never stops.
   */
  private async readyRegistration(ms = 5000): Promise<ServiceWorkerRegistration | null> {
    return Promise.race([
      this.nav.serviceWorker.ready,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), ms)),
    ]).catch(() => null);
  }

  /**
   * Ask, subscribe, and register. Returns what to tell the person.
   *
   * `userVisibleOnly: true` is not optional — Chrome refuses a subscription
   * without it, and the promise it rejects with does not explain why.
   */
  async enable(publicKey: string): Promise<
    { ok: true } | { ok: false; reason: PushState | 'failed'; message: string }
  > {
    if (!this.supported()) {
      return { ok: false, reason: 'unsupported',
        message: 'এই ব্রাউজারে নোটিফিকেশন চালু করা যায় না।' };
    }

    // supported() has already established this, but narrowing does not
    // survive the call boundary and an assertion here would be a lie waiting
    // to happen in a browser we have not met.
    const notification = this.win.Notification;
    if (!notification) {
      return { ok: false, reason: 'unsupported',
        message: 'এই ব্রাউজারে নোটিফিকেশন চালু করা যায় না।' };
    }
    const permission = await notification.requestPermission();
    if (permission !== 'granted') {
      return { ok: false, reason: permission === 'denied' ? 'denied' : 'off',
        message: permission === 'denied'
          ? 'ব্রাউজারে নোটিফিকেশন বন্ধ করা আছে — ব্রাউজারের সেটিংস থেকে চালু করুন।'
          : 'অনুমতি দেওয়া হয়নি।' };
    }

    try {
      const reg = await this.readyRegistration();
      if (!reg) {
        return { ok: false, reason: 'failed',
          message: 'অ্যাপের ব্যাকগ্রাউন্ড সেবা চালু হয়নি — পাতাটি একবার রিফ্রেশ করে দেখুন।' };
      }
      const applicationServerKey = urlBase64ToUint8Array(publicKey);

      let sub = await reg.pushManager.getSubscription();
      if (sub) {
        // A subscription made against a DIFFERENT server key — the deployment
        // rotated its VAPID pair — cannot be reused, and re-subscribing over
        // it throws InvalidStateError. Drop it and start again rather than
        // leaving the person permanently unable to turn notifications on.
        const current = sub.options?.applicationServerKey;
        const same = current
          ? sameKey(new Uint8Array(current as ArrayBuffer), applicationServerKey)
          : false;
        if (!same) { await sub.unsubscribe().catch(() => undefined); sub = null; }
      }
      if (!sub) {
        sub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: applicationServerKey as unknown as BufferSource,
        });
      }

      const json = sub.toJSON() as { endpoint?: string; keys?: Record<string, string> };
      const res = await this.authedFetch('/api/v1/ops/push', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          endpoint: json.endpoint,
          keys: { p256dh: json.keys?.p256dh, auth: json.keys?.auth },
          deviceLabel: deviceLabelFor(this.nav.userAgent ?? ''),
        }),
      });
      if (!res.ok) {
        // The server would not record it, so the browser must not keep a
        // subscription the server has never heard of — it would look "on" and
        // receive nothing.
        await sub.unsubscribe().catch(() => undefined);
        const body = await res.json().catch(() => ({})) as { message?: string };
        return { ok: false, reason: 'failed',
          message: body.message ?? 'সার্ভারে সংরক্ষণ করা যায়নি।' };
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, reason: 'failed',
        message: `চালু করা যায়নি — ${(err as Error).message}` };
    }
  }

  /** Give up this browser's subscription, on both sides. */
  async disable(): Promise<boolean> {
    try {
      const sub = await this.existing();
      const endpoint = sub?.endpoint;
      // The server is told first. If the browser unsubscribed first and the
      // request then failed, the row would stay and the school would keep
      // pushing to an endpoint nobody is listening on.
      if (endpoint) {
        await this.authedFetch('/api/v1/ops/push', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ endpoint }),
        }).catch(() => undefined);
      }
      await sub?.unsubscribe();
      return true;
    } catch {
      return false;
    }
  }

  /** Remove another device by id — the one you are not holding. */
  async forget(id: string): Promise<boolean> {
    try {
      const res = await this.authedFetch('/api/v1/ops/push', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      });
      return res.ok;
    } catch {
      return false;
    }
  }
}

function sameKey(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}
