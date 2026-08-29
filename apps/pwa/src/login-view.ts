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
import {
  applyCachedThenRefresh,
  fetchPublicBranding,
  cachedBranding,
} from './branding.ts';
import { type Branding, brandName } from '../../../packages/ui-core/src/branding.ts';

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

type Step = 'phone' | 'code' | 'activate';

export class LoginView {
  private readonly o: LoginViewOptions;
  private step: Step = 'phone';
  private phone = '';
  private tenantId: string;
  /**
   * The institution's identity. Starts from the local cache so the first
   * paint already carries the school's name — see branding.ts on why a
   * network round-trip before painting is the wrong trade on 2G — and is
   * replaced by the server's answer when it arrives.
   */
  private branding: Branding;
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
    this.branding = cachedBranding(this.tenantId);
    this.render();
    // Paint from cache (already done by render above), then reconcile with
    // the server. A school that changed its logo this morning sees it on
    // the next launch without the login screen ever waiting on the network.
    if (this.tenantId) {
      const { refreshed } = applyCachedThenRefresh(
        options.doc,
        this.tenantId,
        () => fetchPublicBranding(this.tenantId),
      );
      void refreshed.then((b) => {
        // Only re-render if something visible actually changed — a
        // re-render mid-typing would discard the phone number.
        if (b.nameBn !== this.branding.nameBn
          || b.nameEn !== this.branding.nameEn
          || b.logoUrl !== this.branding.logoUrl
          || b.shortName !== this.branding.shortName) {
          this.branding = b;
          this.render();
        } else {
          this.branding = b;
        }
      });
    }
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

    // R-1: the institution's mark, not the platform's. A school that has
    // uploaded a logo gets the logo; one that has not gets the first
    // letter of its own name in the Ata Ekta 56px rounded brand square,
    // which is still ITS identity rather than "শি" for ShikhonBD.
    const institution = brandName(this.branding);
    const brand = d.createElement('div');
    brand.className = 'login-brand';

    const mark = d.createElement('div');
    mark.className = 'login-brandmark';
    if (this.branding.logoUrl) {
      const img = d.createElement('img');
      img.className = 'login-brandlogo';
      img.src = this.branding.logoUrl;
      img.alt = '';
      mark.classList.add('has-logo');
      mark.append(img);
    } else {
      // [...institution] rather than charAt(0): Bangla is multi-byte, and
      // charAt would slice a grapheme in half and render a broken glyph.
      mark.textContent = [...institution][0] ?? '';
    }

    const brandNameEl = d.createElement('div');
    brandNameEl.className = 'login-brandname';
    brandNameEl.textContent = institution;
    const tagline = d.createElement('div');
    tagline.className = 'login-tagline';
    // Deliberately generic: this is the school's screen, and naming the
    // platform on it is the exact thing R-1 removes.
    tagline.textContent = 'শিক্ষা ব্যবস্থাপনা ব্যবস্থা';
    brand.append(mark, brandNameEl, tagline);

    // Kept for a11y and page title, but hidden — the brand element above
    // carries the visible headline now.
    const h1 = d.createElement('h1');
    h1.textContent = institution;
    h1.className = 'visually-hidden';

    if (LOGIN_DISABLED && this.step !== 'activate') {
      // F-202. The OTP kill switch used to be a dead end; now it is a
      // detour. The aggregator negotiation blocks SMS, not the school —
      // and the school can hand out activation codes on paper.
      const notice = d.createElement('p');
      notice.className = 'att-sub';
      notice.textContent = 'মোবাইল কোডে লগইন সাময়িকভাবে বন্ধ আছে।';
      const enter = d.createElement('button');
      enter.type = 'button';
      enter.className = 'btn-primary login-activate-entry';
      enter.textContent = 'সক্রিয়ন কোড দিয়ে প্রবেশ করুন';
      enter.addEventListener('click', () => { this.step = 'activate'; this.render(); });
      const hint = d.createElement('p');
      hint.className = 'att-sub login-activate-hint';
      hint.textContent = 'কোড পাবেন আপনার শ্রেণিশিক্ষক বা অফিস থেকে।';
      wrap.append(h1, brand, notice, enter, hint);
      root.append(wrap);
      return;
    }

    const sub = d.createElement('p');
    sub.className = 'att-sub';
    sub.textContent = this.step === 'activate'
      ? 'শিক্ষকের দেওয়া ৮ অক্ষরের কোডটি দিন'
      : this.step === 'phone'
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

    if (this.step === 'activate') {
      const label = d.createElement('label');
      label.className = 'login-label';
      label.textContent = 'সক্রিয়ন কোড';
      const input = d.createElement('input');
      input.type = 'text';
      input.name = 'activationCode';
      input.className = 'login-input login-code-input';
      // Uppercase letters and digits; autocapitalize helps the ten-year-old
      // typing it. NOT one-time-code — that hint summons the SMS reader,
      // and this code never arrives by SMS.
      input.autocomplete = 'off';
      input.setAttribute('autocapitalize', 'characters');
      input.maxLength = 12;
      label.append(input);
      form.append(label);

      if (!LOGIN_DISABLED) {
        // Only offer the way back when there IS a way back.
        const back = d.createElement('button');
        back.type = 'button';
        back.className = 'btn-secondary';
        back.textContent = 'মোবাইল নম্বরে ফিরে যান';
        back.addEventListener('click', () => { this.step = 'phone'; this.render(); });
        form.append(back);
      }
    } else if (this.step === 'phone') {
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
      : this.step === 'activate' ? 'প্রবেশ করুন'
        : this.step === 'phone' ? 'কোড পাঠান' : 'যাচাই করুন';
    submit.disabled = this.busy;
    this.submitEl = submit;
    form.append(submit);

    wrap.append(h1, brand, sub, this.errorEl, this.cooldownEl, form);
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

    if (this.step === 'activate') {
      const input = this.o.root.querySelector<HTMLInputElement>('input[name="activationCode"]');
      const code = input?.value.trim() ?? '';
      if (code.replace(/[^A-Za-z0-9]/g, '').length < 8) {
        this.showError('৮ অক্ষরের কোডটি সম্পূর্ণ দিন।');
        return;
      }
      this.busy = true;
      this.render();
      try {
        await this.o.auth.redeemActivationCode(this.tenantId, code);
        this.o.onLoggedIn();
      } catch (err) {
        this.busy = false;
        this.render();
        this.handleFailure(err);
      }
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
      case 'invalid_code': return this.step === 'activate'
        ? 'কোডটি সঠিক নয় বা মেয়াদ শেষ — শিক্ষকের কাছে নতুন কোড চান।'
        : 'কোডটি সঠিক নয়।';
      case 'activation_unconfigured': return 'এই সুবিধাটি এখনো চালু হয়নি।';
      case 'too_many_attempts': return 'অনেকবার চেষ্টা হয়েছে — নতুন কোড চান।';
      case 'challenge_not_found': return 'কোডের মেয়াদ শেষ — আবার চেষ্টা করুন।';
      case 'user_not_found': return 'এই নম্বরে কোনো অ্যাকাউন্ট পাওয়া যায়নি।';
      case 'account_not_active': return 'অ্যাকাউন্টটি সক্রিয় নয়।';
      default: return 'সংযোগে সমস্যা হয়েছে। আবার চেষ্টা করুন।';
    }
  }
}
