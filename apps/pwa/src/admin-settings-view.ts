/**
 * সেটিংস — the school's operational settings, grouped  (R-3 Part J · R-9 · P5)
 *
 * The screen that closes the gap which produced D13. R-2's finalisation made
 * the notice-SMS length tenant-configurable, tested it six ways and documented
 * it in three files, and left no way to set it except hand-written SQL against
 * production. A setting only a developer can reach is a setting the school
 * does not have.
 *
 * ── P5: an information architecture, not a form ────────────────────────────
 *
 * The brief asks for settings "grouped logically" and explicitly not for "a
 * giant uncontrolled form". What was here was two `<form class="card">`
 * blocks under two headings, and the honest observation is that the second
 * one was not a form at all — it is a policy switch that saves the moment it
 * is flipped.
 *
 * So the page is now three groups with one job each:
 *
 *   ১. বার্তা ও খরচ   — the two settings THIS endpoint owns, each with its
 *                       own save, its own validation and its own result.
 *   ২. অন্যান্য সেটিংস — the settings that exist but live on their own
 *                       screens. Named rather than duplicated: branding,
 *                       calendar and academic structure are each a screen
 *                       because each has content, and a settings page that
 *                       re-implemented them would be a second place to change
 *                       the same row.
 *
 * A settings hub that lists nothing but two SMS fields tells a head teacher
 * their school has two settings. It has more; they are elsewhere; saying so
 * is the whole value of the group.
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
import { skeleton, errorState, successNote, confirmDialog, bnNum } from './view-states.ts';
import {
  pageHeader, sectionHeading, card, button, buttonRow, field, setFieldError,
  clearFieldError, permissionState, serverMessage, statusBadge, el, append,
  type Field,
} from './ui/index.ts';
import { isDenied } from './http-status.ts';

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
  /** Navigate. Used by the "settings that live elsewhere" group. */
  go?: (path: string) => void;
}

/**
 * The settings this product has that are NOT in `/ops/settings`.
 *
 * Listed, never re-implemented. Each is a screen because each has content;
 * a copy of its controls here would be a second place to change one row.
 */
const ELSEWHERE: Array<{ path: string; titleBn: string; whatBn: string; glyph: string }> = [
  { path: 'branding', glyph: 'star', titleBn: 'প্রতিষ্ঠানের পরিচয়',
    whatBn: 'নাম, লোগো, রং ও ছাপা কাগজের শীর্ষভাগ' },
  { path: 'calendar', glyph: 'calendar', titleBn: 'শিক্ষাপঞ্জি',
    whatBn: 'ছুটি, পরীক্ষা, অনুষ্ঠান ও কর্মদিবসের সাপ্তাহিক ছুটি' },
  { path: 'academic', glyph: 'layers', titleBn: 'একাডেমিক কাঠামো',
    whatBn: 'শিক্ষাবর্ষ, শ্রেণি, বিভাগ ও সেকশন' },
  { path: 'users', glyph: 'users', titleBn: 'ব্যবহারকারী ও ভূমিকা',
    whatBn: 'কে কী দেখতে ও করতে পারবেন' },
];

export class AdminSettingsView {
  private readonly o: AdminSettingsViewOptions;
  private sms: SmsSettings | null = null;
  private push: PushSettings | null = null;
  private draft = 0;
  private loading = true;
  private error = '';
  private denied = false;
  private notice = '';
  private busy = false;

  constructor(options: AdminSettingsViewOptions) {
    this.o = options;
    this.render();
    void this.load();
  }

  private async load(): Promise<void> {
    this.loading = true; this.error = ''; this.denied = false; this.render();
    try {
      const res = await this.o.auth.authedFetch('/api/v1/ops/settings');
      if (isDenied(res)) { this.denied = true; return; }
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
      if (!res.ok) {
        this.error = serverMessage(body, res.status, 'সংরক্ষণ করা যায়নি।', 'সেটিংস');
        return;
      }
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

    root.append(pageHeader(d, {
      title: 'সেটিংস',
      subtitle: 'প্রতিষ্ঠানের বার্তা, খরচ ও পরিচয় সংক্রান্ত সিদ্ধান্ত',
    }));

    // A refusal is the whole answer: rendering the groups underneath would
    // say "you may not see this" and then show it.
    if (this.denied) {
      root.append(permissionState(d, {
        message: 'সেটিংস দেখার অনুমতি আপনার নেই।',
        contact: 'প্রধান শিক্ষক, প্রতিষ্ঠান মালিক, আইটি অ্যাডমিন ও একাডেমিক সমন্বয়ক',
      }));
      return;
    }

    if (this.notice) root.append(successNote(d, this.notice));
    if (this.error) root.append(errorState(d, this.error, () => void this.load()));
    if (this.loading) { root.append(skeleton(d, 3)); return; }
    if (!this.sms) return;

    root.append(sectionHeading(d, { title: 'বার্তা ও খরচ' }));
    root.append(this.smsCard());
    const push = this.pushCard();
    if (push) root.append(push);

    root.append(sectionHeading(d, { title: 'অন্যান্য সেটিংস' }));
    root.append(this.elsewhereCard());
  }

  /** Read-only note, in the canonical wording, or nothing. */
  private readOnlyNote(): HTMLElement | null {
    if (this.o.canManage) return null;
    const d = this.o.doc;
    return el(d, 'p', {
      className: 'ui-card-note',
      // Names all four roles the endpoint allows — the old sentence said
      // "প্রধান শিক্ষক ও আইটি অ্যাডমিন" and left out the owner and the
      // coordinator, both of whom may in fact change this.
      text: 'আপনি শুধু দেখতে পারবেন — পরিবর্তনের অনুমতি প্রধান শিক্ষক, প্রতিষ্ঠান মালিক, ' +
            'আইটি অ্যাডমিন ও একাডেমিক সমন্বয়কের।',
    });
  }

  // ── group ১a: the notice-SMS length ──────────────────────────────────
  private smsCard(): HTMLElement {
    const d = this.o.doc;
    const sms = this.sms as SmsSettings;
    const form = el(d, 'form', { className: 'ui-card ui-card-form' });

    append(form, el(d, 'h3', { className: 'ui-card-title', text: 'নোটিশ এসএমএসের দৈর্ঘ্য' }));

    const chars: Field = field(d, {
      label: 'সর্বোচ্চ অক্ষর',
      name: 'noticeMaxChars',
      kind: 'number',
      value: String(this.draft),
      disabled: !this.o.canManage,
      helper: `প্রস্তাবিত ${bnNum(sms.default)} · সর্বনিম্ন ${bnNum(sms.min)} · ` +
              `সর্বোচ্চ ${bnNum(sms.max)}`,
      attrs: { min: sms.min, max: sms.max, step: 1 },
    });
    append(form, chars.root);

    // aria-live so a screen-reader user hears the cost change as they type,
    // which is the entire point of showing it live.
    const cost = el(d, 'p', {
      className: 'sms-cost', attrs: { 'aria-live': 'polite', id: 'sms-cost-note' },
    });
    const warn = el(d, 'p', { className: 'inline-notice' });
    warn.hidden = true;
    append(form, cost, warn);

    append(form, el(d, 'p', {
      className: 'ui-card-note',
      text: 'এসএমএসে সংক্ষিপ্ত বার্তা যাবে; পুরো নোটিশ সবসময় অ্যাপে থাকবে। ' +
            'প্রতিটি এসএমএসে প্রতিষ্ঠানের নাম থাকবে।',
    }));

    const reset = button(d, {
      label: `প্রস্তাবিত (${bnNum(sms.default)})`, variant: 'secondary',
      disabled: !this.o.canManage,
      onClick: () => { (chars.input as HTMLInputElement).value = String(sms.default); sync(); },
    });
    const saveBtn = button(d, {
      label: 'সংরক্ষণ করুন', variant: 'primary', type: 'submit',
      busy: this.busy, disabled: !this.o.canManage,
    });

    const sync = (): void => {
      const n = Number(chars.value());
      const ok = Number.isFinite(n) && n >= sms.min && n <= sms.max;
      const segs = this.segments(Number.isFinite(n) ? n : sms.default);
      cost.textContent =
        `প্রতি প্রাপকে আনুমানিক ${bnNum(segs)} টি এসএমএস ` +
        `(বাংলায় প্রতি এসএমএসে ${bnNum(sms.charsPerSegment)} অক্ষর)।`;
      // The warning appears when the school goes beyond the recommendation,
      // stated as a multiple of the bill rather than as a number of letters.
      const over = ok && n > sms.default;
      warn.hidden = !over;
      if (over) {
        const baseSegs = this.segments(sms.default);
        warn.textContent =
          `প্রস্তাবিত দৈর্ঘ্যের চেয়ে বেশি — খরচ প্রায় ${bnNum((segs / baseSegs).toFixed(1))} গুণ হতে পারে। ` +
          'এসএমএস প্রতিষ্ঠানের সবচেয়ে বড় চলতি খরচ।';
      }
      if (ok) { clearFieldError(chars.root); this.draft = Math.floor(n); }
      saveBtn.toggleAttribute('disabled', this.busy || !ok || !this.o.canManage);
    };
    chars.input.addEventListener('input', sync);

    append(form, buttonRow(d, reset, saveBtn));
    const ro = this.readOnlyNote();
    if (ro) append(form, ro);

    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const n = Number(chars.value());
      if (!Number.isFinite(n) || n < sms.min || n > sms.max) {
        // Field-level, so the number the person typed stays in front of them
        // while they correct it.
        setFieldError(chars.root,
          `${bnNum(sms.min)} থেকে ${bnNum(sms.max)} এর মধ্যে একটি সংখ্যা দিন।`);
        chars.input.focus();
        return;
      }
      void this.save();
    });

    sync();
    return form;
  }

  // ── group ১b: push vs SMS ────────────────────────────────────────────
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
      if (!res.ok) {
        this.error = serverMessage(body, res.status, 'সংরক্ষণ করা যায়নি।', 'সেটিংস');
        return;
      }
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

  private pushCard(): HTMLElement | null {
    if (!this.push) return null;
    const d = this.o.doc;
    const push = this.push;

    const body: Array<Node | null> = [
      el(d, 'p', {
        className: 'ui-card-note',
        text: 'যাঁরা অ্যাপে নোটিফিকেশন চালু করেছেন, তাঁদের বার্তা ইন্টারনেটে যায় — খরচ নেই। ' +
              'সেই বার্তার এসএমএসটি বন্ধ রাখলে প্রতিষ্ঠানের খরচ কমে।',
      }),
    ];

    if (!push.available) {
      // The toggle would save and change nothing: suppression only applies to
      // a push a service ACCEPTED, and with no VAPID keys none ever is.
      body.push(el(d, 'p', {
        className: 'inline-notice',
        text: 'এই সার্ভারে নোটিফিকেশন চালু নেই — সেটি চালু হলে এই সুবিধা ব্যবহার করা যাবে।',
      }));
      return card(d, {
        title: 'নোটিফিকেশন ও এসএমএস খরচ', glyph: 'bell',
        action: statusBadge(d, { state: 'draft', label: 'চালু নেই' }),
      }, ...body);
    }

    const box = el(d, 'input', { className: 'ui-check-box' }) as HTMLInputElement;
    box.type = 'checkbox';
    box.id = 'push-replaces-sms';
    box.checked = push.replacesSms;
    box.disabled = this.busy || !this.o.canManage;

    const host = card(d, {
      title: 'নোটিফিকেশন ও এসএমএস খরচ', glyph: 'bell',
      action: statusBadge(d, {
        state: push.replacesSms ? 'published' : 'draft',
        label: push.replacesSms ? 'এসএমএস বন্ধ' : 'দুটোই যাবে',
      }),
    }, ...body,
      // Same idiom as the notice composer's SMS toggle, with the 44px hit
      // area the bare checkbox does not have.
      el(d, 'label', { className: 'sms-toggle' },
        el(d, 'span', { className: 'ui-check' }, box),
        el(d, 'span', { text: 'নোটিফিকেশন পৌঁছালে একই বার্তার এসএমএস পাঠানো হবে না' })),
      // The two exceptions are stated on the screen, not just in the code, so
      // a principal deciding this knows what is NOT being given up.
      el(d, 'p', {
        className: 'ui-card-note',
        text: 'জরুরি নোটিশ ও লগইন কোড সবসময় এসএমএসেও যাবে। ' +
              'যাঁদের নোটিফিকেশন চালু নেই, তাঁরা আগের মতোই এসএমএস পাবেন।',
      }),
      this.readOnlyNote(),
    );

    if (this.o.canManage) {
      box.addEventListener('change', () => {
        const next = box.checked;
        // Turning it ON stops SMS going out for every guardian in the school
        // who has a working push subscription. That is a school-wide change
        // to how families are reached, so it is confirmed; turning it back
        // OFF only adds messages, so it is not.
        if (!next) { void this.savePush(false); return; }
        box.checked = push.replacesSms;   // until confirmed
        host.append(confirmDialog({
          doc: d,
          title: 'এসএমএস বন্ধ করা নিশ্চিত করুন',
          body: 'যাঁদের ফোনে নোটিফিকেশন পৌঁছাবে, তাঁরা ওই বার্তার এসএমএস আর পাবেন না। ' +
                'জরুরি নোটিশ ও লগইন কোড এতে বাদ যাবে না।',
          confirmLabel: 'বন্ধ করুন',
          onConfirm: () => void this.savePush(true),
        }));
      });
    }
    return host;
  }

  // ── group ২: what is a setting but lives elsewhere ───────────────────
  private elsewhereCard(): HTMLElement {
    const d = this.o.doc;
    const go = this.o.go ?? ((path: string) => {
      const w = d.defaultView;
      if (w) w.location.hash = `#/${path}`;
    });
    return card(d, {
      title: 'নিজের নিজের পাতায়', glyph: 'settings',
      subtitle: 'এগুলোও প্রতিষ্ঠানের সেটিংস — যে জিনিসের সেটিং, সেখানেই আছে।',
    },
      ...ELSEWHERE.map((e) => card(d, {
        title: e.titleBn, subtitle: e.whatBn, glyph: e.glyph,
        variant: 'interactive', onClick: () => go(e.path),
      })),
    );
  }
}
