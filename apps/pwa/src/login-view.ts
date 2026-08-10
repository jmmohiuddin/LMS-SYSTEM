/**
 * Phone → OTP → verify login screen.
 *
 * Framework-free, same conventions as attendance-view.ts: manual DOM,
 * Bangla-first copy, buttons sized to --tap-min, no client-side routing
 * concerns here — the shell decides what to show after onLoggedIn fires.
 *
 * tenantId is normally already known (baked into the install link the
 * school hands out, see app.ts's ?tid= / localStorage resolution) and
 * shown read-only; the rare case of a bare install with no tenant yet is
 * covered by a fallback text field so the screen never dead-ends.
 */
import type { Auth } from './auth.ts';

const PHONE_RE = /^\+8801[3-9][0-9]{8}$/;

/**
 * Wireframe §5.1: a rate-limit rejection renders as a countdown, not an
 * error. The difference matters — "সংযোগে সমস্যা" tells a teacher something
 * is broken and to try a different phone; a visible timer tells them the
 * system is fine and exactly how long to wait, which is the truth.
 *
 * Exported and pure so the wording and the minute/second boundary are
 * unit-testable without a DOM.
 */
export function cooldownMessage(secondsLeft: number): string {
  const s = Math.max(0, Math.ceil(secondsLeft));
  if (s >= 60) {
    const m = Math.ceil(s / 60);
    return `অনেকবার চেষ্টা হয়েছে। ${m} মিনিট পর আবার চেষ্টা করুন।`;
  }
  return `অনেকবার চেষ্টা হয়েছে। ${s} সেকেন্ড পর আবার চেষ্টা করুন।`;
}

// Mirrors OTP_SENDING_ENABLED in services/identity-svc/api/otp-request.ts —
// keep both in sync. This one skips showing the phone form entirely instead
// of making a teacher fill it in just to hit the 503 from that flag.
// Exported: while true, app.ts also drops session-less visitors straight
// into demo mode so every page stays viewable without a login.
export const LOGIN_DISABLED = true;

export interface LoginViewOptions {
  root: HTMLElement;
  doc: Document;
  auth: Auth;
  tenantId: string;
  onLoggedIn: () => void;
}

type Step = 'phone' | 'code';

export class LoginView {
  private readonly o: LoginViewOptions;
  private step: Step = 'phone';
  private phone = '';
  private tenantId: string;
  private errorEl!: HTMLElement;
  private cooldownEl!: HTMLElement;
  private submitEl!: HTMLButtonElement;
  private busy = false;
  /** epoch ms; 0 = no cooldown. F-102 — see cooldownMessage() above. */
  private cooldownUntil = 0;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(options: LoginViewOptions) {
    this.o = options;
    this.tenantId = options.tenantId;
    this.render();
  }

  /** Called by the shell when the view is torn down. Stops the tick. */
  destroy(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private render(): void {
    const d = this.o.doc;
    const root = this.o.root;
    root.textContent = '';
    root.setAttribute('lang', 'bn');

    const wrap = d.createElement('div');
    wrap.className = 'login-wrap';

    const h1 = d.createElement('h1');
    h1.textContent = 'শিখন';

    if (LOGIN_DISABLED) {
      const notice = d.createElement('p');
      notice.className = 'att-sub';
      notice.textContent = 'লগইন সাময়িকভাবে বন্ধ আছে। পরে আবার চেষ্টা করুন।';
      wrap.append(h1, notice);
      root.append(wrap);
      return;
    }

    const sub = d.createElement('p');
    sub.className = 'att-sub';
    sub.textContent = this.step === 'phone'
      ? 'আপনার মোবাইল নম্বর দিন'
      : `${this.phone} নম্বরে পাঠানো কোডটি দিন`;

    this.errorEl = d.createElement('p');
    this.errorEl.className = 'login-error';
    this.errorEl.setAttribute('role', 'alert');
    this.errorEl.hidden = true;

    // Deliberately role="status", not "alert": a countdown is a wait, not a
    // failure, and it updates every second — an alert would re-announce on
    // every tick.
    this.cooldownEl = d.createElement('p');
    this.cooldownEl.className = 'login-cooldown';
    this.cooldownEl.setAttribute('role', 'status');
    this.cooldownEl.hidden = true;

    const form = d.createElement('form');
    form.className = 'login-form';
    form.addEventListener('submit', (e) => { e.preventDefault(); void this.onSubmit(); });

    if (!this.tenantId) {
      const tLabel = d.createElement('label');
      tLabel.className = 'login-label';
      tLabel.textContent = 'স্কুল আইডি';
      const tInput = d.createElement('input');
      tInput.type = 'text';
      tInput.name = 'tenantId';
      tInput.className = 'login-input';
      tInput.autocomplete = 'off';
      tInput.addEventListener('input', () => { this.tenantId = tInput.value.trim(); });
      tLabel.append(tInput);
      form.append(tLabel);
    }

    if (this.step === 'phone') {
      const label = d.createElement('label');
      label.className = 'login-label';
      label.textContent = 'মোবাইল নম্বর';
      const input = d.createElement('input');
      input.type = 'tel';
      input.name = 'phone';
      input.className = 'login-input';
      input.placeholder = '+8801XXXXXXXXX';
      input.autocomplete = 'tel';
      input.value = this.phone;
      input.addEventListener('input', () => { this.phone = input.value.trim(); });
      label.append(input);
      form.append(label);
    } else {
      const label = d.createElement('label');
      label.className = 'login-label';
      label.textContent = 'যাচাইকরণ কোড';
      const input = d.createElement('input');
      input.type = 'text';
      input.name = 'code';
      input.className = 'login-input';
      input.inputMode = 'numeric';
      input.autocomplete = 'one-time-code';
      label.append(input);
      form.append(label);

      const back = d.createElement('button');
      back.type = 'button';
      back.className = 'btn-secondary';
      back.textContent = 'নম্বর পরিবর্তন করুন';
      back.addEventListener('click', () => { this.step = 'phone'; this.render(); });
      form.append(back);
    }

    const submit = d.createElement('button');
    submit.type = 'submit';
    submit.className = 'btn-primary';
    submit.textContent = this.busy
      ? 'অপেক্ষা করুন…'
      : this.step === 'phone' ? 'কোড পাঠান' : 'যাচাই করুন';
    submit.disabled = this.busy;
    this.submitEl = submit;
    form.append(submit);

    wrap.append(h1, sub, this.errorEl, this.cooldownEl, form);
    root.append(wrap);
    this.paintCooldown();
  }

  private showError(message: string): void {
    this.errorEl.textContent = message;
    this.errorEl.hidden = false;
  }

  /**
   * Enter the F-102 cooldown. The submit button stays disabled and the
   * countdown ticks down to zero, at which point the form re-arms itself —
   * the teacher never has to guess whether it is safe to retry.
   */
  private startCooldown(seconds: number): void {
    this.cooldownUntil = Date.now() + Math.max(1, Math.ceil(seconds)) * 1000;
    this.errorEl.hidden = true;
    if (this.timer === null) {
      this.timer = setInterval(() => this.paintCooldown(), 1000);
    }
    this.paintCooldown();
  }

  private paintCooldown(): void {
    if (!this.cooldownEl) return;
    const left = (this.cooldownUntil - Date.now()) / 1000;
    if (left <= 0) {
      this.cooldownUntil = 0;
      this.cooldownEl.hidden = true;
      this.destroy();
      if (this.submitEl && !this.busy) this.submitEl.disabled = false;
      return;
    }
    this.cooldownEl.textContent = cooldownMessage(left);
    this.cooldownEl.hidden = false;
    if (this.submitEl) this.submitEl.disabled = true;
  }

  private async onSubmit(): Promise<void> {
    if (this.busy) return;
    if (this.cooldownUntil > Date.now()) return;
    this.errorEl.hidden = true;

    if (!this.tenantId) {
      this.showError('স্কুল আইডি প্রয়োজন।');
      return;
    }

    if (this.step === 'phone') {
      if (!PHONE_RE.test(this.phone)) {
        this.showError('সঠিক মোবাইল নম্বর দিন (উদাহরণ: +8801712345678)।');
        return;
      }
      this.busy = true;
      this.render();
      try {
        await this.o.auth.requestOtp(this.tenantId, this.phone);
        this.step = 'code';
      } catch (err) {
        this.handleFailure(err);
      } finally {
        this.busy = false;
        this.render();
      }
      return;
    }

    const codeInput = this.o.root.querySelector<HTMLInputElement>('input[name="code"]');
    const code = codeInput?.value.trim() ?? '';
    if (!/^[0-9]{4,8}$/.test(code)) {
      this.showError('সঠিক কোড দিন।');
      return;
    }
    this.busy = true;
    this.render();
    try {
      await this.o.auth.verifyOtp(this.tenantId, this.phone, code);
      this.o.onLoggedIn();
    } catch (err) {
      this.busy = false;
      this.render();
      this.handleFailure(err);
    }
  }

  /**
   * A 429 becomes a countdown; everything else becomes an error line. Split
   * out so both submit paths agree — they used to differ only by accident.
   */
  private handleFailure(err: unknown): void {
    const e = err as { code?: string; retryAfterSec?: number };
    if (e?.code === 'rate_limited') {
      this.startCooldown(e.retryAfterSec && e.retryAfterSec > 0 ? e.retryAfterSec : 60);
      return;
    }
    this.showError(this.friendlyError(err));
  }

  private friendlyError(err: unknown): string {
    const code = (err as { code?: string })?.code;
    switch (code) {
      case 'otp_disabled': return 'লগইন সাময়িকভাবে বন্ধ আছে। পরে আবার চেষ্টা করুন।';
      case 'too_soon': return 'একটু আগে কোড পাঠানো হয়েছে, একটু অপেক্ষা করুন।';
      case 'invalid_code': return 'কোডটি সঠিক নয়।';
      case 'too_many_attempts': return 'অনেকবার চেষ্টা হয়েছে — নতুন কোড চান।';
      case 'challenge_not_found': return 'কোডের মেয়াদ শেষ — আবার চেষ্টা করুন।';
      case 'user_not_found': return 'এই নম্বরে কোনো অ্যাকাউন্ট পাওয়া যায়নি।';
      case 'account_not_active': return 'অ্যাকাউন্টটি সক্রিয় নয়।';
      default: return 'সংযোগে সমস্যা হয়েছে। আবার চেষ্টা করুন।';
    }
  }
}
