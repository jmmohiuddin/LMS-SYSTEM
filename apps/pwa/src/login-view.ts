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
  private busy = false;

  constructor(options: LoginViewOptions) {
    this.o = options;
    this.tenantId = options.tenantId;
    this.render();
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
    form.append(submit);

    wrap.append(h1, sub, this.errorEl, form);
    root.append(wrap);
  }

  private showError(message: string): void {
    this.errorEl.textContent = message;
    this.errorEl.hidden = false;
  }

  private async onSubmit(): Promise<void> {
    if (this.busy) return;
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
        this.showError(this.friendlyError(err));
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
      this.showError(this.friendlyError(err));
      this.busy = false;
      this.render();
    }
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
