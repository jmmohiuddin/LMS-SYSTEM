/**
 * Session state: OTP login, token storage, silent refresh, and the
 * authedFetch() wrapper every other view uses to reach the API.
 *
 * Tokens live in localStorage, not IndexedDB — small and synchronous, which
 * matters at boot: the shell needs a same-tick answer to "is anyone logged
 * in?" before it decides whether to render the login view or the app. The
 * access token is short-lived (15m, see services/identity-svc/api/otp-verify.ts);
 * the refresh token rotates on every use, so only the latest copy is ever
 * valid — losing this to a crash mid-refresh means a re-login, not a wedge.
 */
const STORAGE_KEY = 'shikhon_auth';

export interface AuthUser {
  id: string;
  fullNameBn: string | null;
  fullNameEn: string | null;
  role: string;
  roles: string[];
}

interface StoredAuth {
  tenantId: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // epoch ms
  user: AuthUser;
}

export class AuthError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

export interface AuthOptions {
  apiBase: string;
  deviceId: string;
  now?: () => number;
}

export class Auth {
  private readonly o: AuthOptions;
  private state: StoredAuth | null;

  constructor(o: AuthOptions) {
    this.o = o;
    this.state = this.load();
  }

  private load(): StoredAuth | null {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? (JSON.parse(raw) as StoredAuth) : null;
    } catch {
      return null;
    }
  }

  private persist(): void {
    if (this.state) localStorage.setItem(STORAGE_KEY, JSON.stringify(this.state));
    else localStorage.removeItem(STORAGE_KEY);
  }

  isLoggedIn(): boolean {
    return this.state !== null;
  }

  get tenantId(): string { return this.state?.tenantId ?? ''; }
  get userId(): string { return this.state?.user.id ?? ''; }
  get role(): string { return this.state?.user.role ?? ''; }
  get roles(): string[] { return this.state?.user.roles ?? []; }
  get user(): AuthUser | null { return this.state?.user ?? null; }
  get displayName(): string {
    return this.state?.user.fullNameBn || this.state?.user.fullNameEn || '';
  }

  /** Step 1 of login: sends (or logs, pending SMS aggregator) the OTP code. */
  async requestOtp(
    tenantId: string,
    phone: string,
    purpose = 'login',
  ): Promise<{ challengeId: string; expiresAt: string; debugCode?: string }> {
    return this.postPublic('/api/v1/auth/otp/request', { tenantId, phone, purpose });
  }

  /** Step 2: verifies the code and establishes the session. */
  async verifyOtp(tenantId: string, phone: string, code: string, purpose = 'login'): Promise<void> {
    const body = await this.postPublic<{
      accessToken: string;
      refreshToken: string;
      expiresIn: number;
      user: AuthUser;
    }>('/api/v1/auth/otp/verify', { tenantId, phone, purpose, code, deviceId: this.o.deviceId });

    const now = (this.o.now ?? Date.now)();
    this.state = {
      tenantId,
      accessToken: body.accessToken,
      refreshToken: body.refreshToken,
      expiresAt: now + body.expiresIn * 1000,
      user: body.user,
    };
    this.persist();
  }

  async logout(): Promise<void> {
    const s = this.state;
    this.state = null;
    this.persist();
    if (!s) return;
    try {
      // Best-effort: an offline logout is still a logout locally, and the
      // server-side session simply expires on its own (30-day TTL).
      await fetch(`${this.o.apiBase}/api/v1/auth/logout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tenantId: s.tenantId, refreshToken: s.refreshToken }),
      });
    } catch {
      // ignore — see comment above
    }
  }

  /** Refreshes when the access token is expired or within 60s of expiry. */
  private async ensureFreshToken(): Promise<string | null> {
    // Captured into a local: `this.state` is a mutable property, so TS can't
    // carry the null-check across the `await`s below — a local const can.
    const current = this.state;
    if (!current) return null;
    const now = (this.o.now ?? Date.now)();
    if (current.expiresAt - now > 60_000) return current.accessToken;

    try {
      const res = await fetch(`${this.o.apiBase}/api/v1/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tenantId: current.tenantId,
          refreshToken: current.refreshToken,
          deviceId: this.o.deviceId,
        }),
      });
      if (!res.ok) {
        // The refresh token is dead (expired/revoked/already-rotated) —
        // nothing left to do but ask the teacher to log in again.
        this.state = null;
        this.persist();
        return null;
      }
      const body = (await res.json()) as { accessToken: string; refreshToken: string; expiresIn: number };
      this.state = {
        ...current,
        accessToken: body.accessToken,
        refreshToken: body.refreshToken,
        expiresAt: now + body.expiresIn * 1000,
      };
      this.persist();
      return this.state.accessToken;
    } catch {
      // Offline: keep the (possibly stale) access token rather than logging
      // the teacher out just because the network is down.
      return current.accessToken;
    }
  }

  /**
   * fetch() wrapper used by every authenticated view: attaches the bearer
   * token, refreshing ahead of expiry when online. Returns the raw Response
   * — HTTP-status handling stays with the caller, same convention as
   * transport.ts's FetchTransport.
   */
  async authedFetch(path: string, init: RequestInit = {}): Promise<Response> {
    const token = await this.ensureFreshToken();
    if (!token) throw new AuthError('not_authenticated', 'not logged in');
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${token}`);
    if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
    return fetch(`${this.o.apiBase}${path}`, { ...init, headers });
  }

  private async postPublic<T>(path: string, payload: unknown): Promise<T> {
    const res = await fetch(`${this.o.apiBase}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new AuthError(
        (body as { error?: string }).error ?? 'request_failed',
        (body as { message?: string }).message ?? res.statusText,
      );
    }
    return body as T;
  }
}
