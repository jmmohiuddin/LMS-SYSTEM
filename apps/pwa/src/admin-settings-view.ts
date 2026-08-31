/**
 * সেটিংস → এসএমএস — the notice-SMS length  (R-3, Part J)
 *
 * The screen that closes the gap which produced D13. R-2's finalisation made
 * this value tenant-configurable, tested it six ways and documented it in
 * three files, and left no way to set it except hand-written SQL against
 * production. A setting only a developer can reach is a setting the school
 * does not have.
 *
 * ── The limits come from the server ────────────────────────────────────
 * min, max, default and the segment size all arrive in the GET response
 * rather than being constants here. The same numbers are already the sender's
 * clamp (sms-svc's `noticeSmsMaxChars`), and a second copy in the browser
 * would eventually disagree — in the direction that costs the school money,
 * because the disagreement only shows up when somebody raises the cap.
 *
 * ── The cost is shown in segments, not characters ──────────────────────
 * "৪৮০ অক্ষর" means nothing to the person paying. "৭টি এসএমএস — প্রতি
 * অভিভাবকে ৭ গুণ খরচ" is the same fact in the unit the bill arrives in.
 * Bangla forces UCS-2, so a segment is 70 characters and not 160 — which is
 * exactly why this warning matters more here than it would in an English
 * product.
 */
import type { Auth } from './auth.ts';
import { skeleton, errorState, successNote, bnNum } from './view-states.ts';
import { pageHeader } from './ui/page-header.ts';

interface SmsSettings {
  noticeMaxChars: number;
  default: number;
  min: number;
  max: number;
  charsPerSegment: number;
}

/** R-9. Whether a delivered push may cancel the SMS for the same message. */
interface PushSettings {
  replacesSms: boolean;
  /** Does the DEPLOYMENT have VAPID keys? The toggle is inert without them. */
  available: boolean;
}

export interface AdminSettingsViewOptions {
  root: HTMLElement;
  doc: Document;
  auth: Auth;
  /** Advisory only — the server is the gate. Controls whether the form renders. */
  canManage: boolean;
}

export class AdminSettingsView {
  private readonly o: AdminSettingsViewOptions;
  private sms: SmsSettings | null = null;
  private push: PushSettings | null = null;
  private draft = 0;
  private loading = true;
  private error = '';
  private notice = '';
  private busy = false;

  constructor(options: AdminSettingsViewOptions) {
    this.o = options;
    this.render();
    void this.load();
  }

  private async load(): Promise<void> {
    this.loading = true; this.error = ''; this.render();
    try {
      const res = await this.o.auth.authedFetch('/api/v1/ops/settings');
      if (!res.ok) throw new Error(String(res.status));
      const body = (await res.json()) as { sms: SmsSettings; push?: PushSettings };
      this.sms = body.sms;
      this.push = body.push ?? null;
      this.draft = body.sms.noticeMaxChars;
    } catch {
      this.error = 'সেটিংস আনা যায়নি — সংযোগ পেলে আবার দেখা যাবে।';
    } finally {
      this.loading = false; this.render();
    }
  }

  private async save(): Promise<void> {
    this.busy = true; this.error = ''; this.notice = ''; this.render();
    try {
      const res = await this.o.auth.authedFetch('/api/v1/ops/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sms: { noticeMaxChars: this.draft } }),
      });
      const body = await res.json() as { sms?: SmsSettings; push?: PushSettings; message?: string };
      if (!res.ok) { this.error = body.message ?? 'সংরক্ষণ করা যায়নি।'; return; }
      this.sms = body.sms ?? this.sms;
      this.push = body.push ?? this.push;
      if (body.sms) this.draft = body.sms.noticeMaxChars;
      this.notice = `সংরক্ষিত — নোটিশ এসএমএস সর্বোচ্চ ${bnNum(this.draft)} অক্ষর।`;
    } catch {
      this.error = 'সংযোগ নেই — সংরক্ষণ করা যায়নি।';
    } finally {
      this.busy = false; this.render();
    }
  }

  private segments(chars: number): number {
    const per = this.sms?.charsPerSegment ?? 70;
    return Math.max(1, Math.ceil(chars / per));
  }

  private render(): void {
    const d = this.o.doc;
    const root = this.o.root;
    root.textContent = '';

    const header = pageHeader(d, {
      title: 'সেটিংস',
      subtitle: 'নোটিফিকেশন ও এসএমএস',
    });
    root.append(header);

    if (this.notice) root.append(successNote(d, this.notice));
    if (this.error) root.append(errorState(d, this.error, () => void this.load()));
    if (this.loading) { root.append(skeleton(d, 3)); return; }
    if (!this.sms) return;

    const h2 = d.createElement('h2');
    h2.className = 'section-heading';
    h2.textContent = 'নোটিশ এসএমএসের দৈর্ঘ্য';
    root.append(h2);

    const card = d.createElement('form');
    card.className = 'card card-form';
    card.style.margin = '0 var(--s-4) var(--s-3)';

    const field = d.createElement('label');
    field.className = 'field';
    field.textContent = 'সর্বোচ্চ অক্ষর';
    const input = d.createElement('input');
    input.type = 'number';
    input.className = 'field-input';
    input.min = String(this.sms.min);
    input.max = String(this.sms.max);
    input.step = '1';
    input.value = String(this.draft);
    input.setAttribute('aria-describedby', 'sms-cost-note');
    field.append(input);
    card.append(field);

    const bounds = d.createElement('p');
    bounds.className = 'att-sub';
    bounds.textContent =
      `প্রস্তাবিত ${bnNum(this.sms.default)} · সর্বনিম্ন ${bnNum(this.sms.min)} · ` +
      `সর্বোচ্চ ${bnNum(this.sms.max)}`;
    card.append(bounds);

    const cost = d.createElement('p');
    cost.className = 'sms-cost';
    cost.id = 'sms-cost-note';
    // aria-live so a screen-reader user hears the cost change as they type,
    // which is the entire point of showing it live.
    cost.setAttribute('aria-live', 'polite');
    card.append(cost);

    const warn = d.createElement('p');
    warn.className = 'inline-notice';
    warn.hidden = true;
    card.append(warn);

    const policy = d.createElement('p');
    policy.className = 'att-sub';
    policy.textContent =
      'এসএমএসে সংক্ষিপ্ত বার্তা যাবে; পুরো নোটিশ সবসময় অ্যাপে থাকবে। ' +
      'প্রতিটি এসএমএসে প্রতিষ্ঠানের নাম থাকবে।';
    card.append(policy);

    const syncCost = (): void => {
      const n = Number(input.value);
      const segs = this.segments(Number.isFinite(n) ? n : this.sms!.default);
      cost.textContent =
        `প্রতি প্রাপকে আনুমানিক ${bnNum(segs)} টি এসএমএস ` +
        `(বাংলায় প্রতি এসএমএসে ${bnNum(this.sms!.charsPerSegment)} অক্ষর)।`;
      // The warning appears when the school goes beyond the recommendation,
      // stated as a multiple of the bill rather than as a number of letters.
      const overDefault = Number.isFinite(n) && n > this.sms!.default;
      warn.hidden = !overDefault;
      if (overDefault) {
        const baseSegs = this.segments(this.sms!.default);
        warn.textContent =
          `প্রস্তাবিত দৈর্ঘ্যের চেয়ে বেশি — খরচ প্রায় ${bnNum((segs / baseSegs).toFixed(1))} গুণ হতে পারে। ` +
          'এসএমএস প্রতিষ্ঠানের সবচেয়ে বড় চলতি খরচ।';
      }
      save.disabled = this.busy
        || !Number.isFinite(n) || n < this.sms!.min || n > this.sms!.max;
      this.draft = Number.isFinite(n) ? Math.floor(n) : this.draft;
    };

    const row = d.createElement('div');
    row.className = 'action-row';
    const reset = d.createElement('button');
    reset.type = 'button';
    reset.className = 'btn-secondary';
    reset.textContent = `প্রস্তাবিত (${bnNum(this.sms.default)})`;
    reset.addEventListener('click', () => {
      input.value = String(this.sms!.default);
      syncCost();
    });
    const save = d.createElement('button');
    save.type = 'submit';
    save.className = 'btn-primary';
    save.textContent = this.busy ? 'সংরক্ষণ হচ্ছে…' : 'সংরক্ষণ করুন';
    row.append(reset, save);
    card.append(row);

    if (!this.o.canManage) {
      // Read-only for staff who may see the policy but not set it. The server
      // refuses the PUT regardless; this only avoids offering a button that
      // is guaranteed to 403.
      input.disabled = true;
      save.disabled = true;
      reset.disabled = true;
      const ro = d.createElement('p');
      ro.className = 'att-sub';
      ro.textContent = 'পরিবর্তনের অনুমতি কেবল প্রধান শিক্ষক ও আইটি অ্যাডমিনের।';
      card.append(ro);
    }

    input.addEventListener('input', syncCost);
    card.addEventListener('submit', (e) => { e.preventDefault(); void this.save(); });
    root.append(card);
    syncCost();

    this.renderPushCard(root);
  }

  /**
   * R-9. The school's decision about whether push may REPLACE an SMS.
   *
   * Off by default and deliberately framed as a trade rather than a feature.
   * A push notification can be muted at the OS level or land on a phone the
   * parent has handed to the child; an SMS is harder to miss. So the screen
   * states what is gained and what is given up, and lets the school choose —
   * this is a judgement about their parents, not a technical fact we can
   * decide for them.
   */
  private async savePush(next: boolean): Promise<void> {
    this.busy = true; this.error = ''; this.notice = ''; this.render();
    try {
      const res = await this.o.auth.authedFetch('/api/v1/ops/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ push: { replacesSms: next } }),
      });
      const body = await res.json() as { push?: PushSettings; message?: string };
      if (!res.ok) { this.error = body.message ?? 'সংরক্ষণ করা যায়নি।'; return; }
      this.push = body.push ?? this.push;
      this.notice = next
        ? 'সংরক্ষিত — নোটিফিকেশন পৌঁছালে সেই বার্তার এসএমএস আর পাঠানো হবে না।'
        : 'সংরক্ষিত — নোটিফিকেশনের পাশাপাশি এসএমএসও যাবে।';
    } catch {
      this.error = 'সংযোগ নেই — সংরক্ষণ করা যায়নি।';
    } finally {
      this.busy = false; this.render();
    }
  }

  private renderPushCard(root: HTMLElement): void {
    if (!this.push) return;
    const d = this.o.doc;

    const h2 = d.createElement('h2');
    h2.className = 'section-heading';
    h2.textContent = 'নোটিফিকেশন ও এসএমএস খরচ';
    root.append(h2);

    const card = d.createElement('div');
    card.className = 'card card-form';
    card.style.margin = '0 var(--s-4) var(--s-3)';
    card.dataset.pushAvailable = String(this.push.available);

    const explain = d.createElement('p');
    explain.className = 'att-sub';
    explain.textContent =
      'যাঁরা অ্যাপে নোটিফিকেশন চালু করেছেন, তাঁদের বার্তা ইন্টারনেটে যায় — খরচ নেই। '
      + 'সেই বার্তার এসএমএসটি বন্ধ রাখলে প্রতিষ্ঠানের খরচ কমে।';
    card.append(explain);

    if (!this.push.available) {
      // The toggle would save and change nothing: suppression only applies to
      // a push a service ACCEPTED, and with no VAPID keys none ever is.
      const off = d.createElement('p');
      off.className = 'inline-notice';
      off.textContent = 'এই সার্ভারে নোটিফিকেশন চালু নেই — সেটি চালু হলে এই সুবিধা ব্যবহার করা যাবে।';
      card.append(off);
      root.append(card);
      return;
    }

    const label = d.createElement('label');
    // Same idiom as the notice composer's SMS toggle — a checkbox row with a
    // tap target big enough for a phone.
    label.className = 'sms-toggle';
    const box = d.createElement('input');
    box.type = 'checkbox';
    box.checked = this.push.replacesSms;
    box.disabled = this.busy || !this.o.canManage;
    box.id = 'push-replaces-sms';
    const text = d.createElement('span');
    text.textContent = 'নোটিফিকেশন পৌঁছালে একই বার্তার এসএমএস পাঠানো হবে না';
    label.append(box, text);
    card.append(label);

    const caveat = d.createElement('p');
    caveat.className = 'att-sub';
    // The two exceptions are stated on the screen, not just in the code, so a
    // principal deciding this knows what is NOT being given up.
    caveat.textContent =
      'জরুরি নোটিশ ও লগইন কোড সবসময় এসএমএসেও যাবে। '
      + 'যাঁদের নোটিফিকেশন চালু নেই, তাঁরা আগের মতোই এসএমএস পাবেন।';
    card.append(caveat);

    if (this.o.canManage) {
      box.addEventListener('change', () => void this.savePush(box.checked));
    } else {
      const ro = d.createElement('p');
      ro.className = 'att-sub';
      ro.textContent = 'পরিবর্তনের অনুমতি কেবল প্রধান শিক্ষক ও আইটি অ্যাডমিনের।';
      card.append(ro);
    }

    root.append(card);
  }
}
