/**
 * নোটিফিকেশন — turning push on for this browser.  (R-9)
 *
 * Available to every role, because every role receives notices: a guardian
 * gets their child's absence, a teacher gets the staff notice, a student gets
 * the exam routine. There is nothing to gate here — the only thing this screen
 * can do is register the device of whoever is holding it.
 *
 * ── Why the screen leads with what it costs the school ─────────────────
 * SMS is roughly 80% of a school's running bill (docs/05 §5). A parent turning
 * this on is doing the school a real favour, and saying so is both true and
 * more persuasive than "enable notifications?". It also sets an honest
 * expectation: the school may later stop sending them the SMS.
 *
 * ── Every branch of `pushState` is rendered ────────────────────────────
 * Including the two that have no button. A browser that has blocked
 * notifications shows a button that silently does nothing — the permission
 * prompt never appears again — so `denied` gets an explanation of where the
 * block actually is instead of a control that cannot work.
 */
import type { Auth } from './auth.ts';
import {
  PushClient, pushState, deviceLabelFor,
  type PushState, type PushDevice, type PushStatusResponse,
} from './push-client.ts';
import { skeleton, errorState, successNote, emptyState, bnDate } from './view-states.ts';

export interface NotificationsViewOptions {
  root: HTMLElement;
  doc: Document;
  auth: Auth;
  /** Injected so the suite can drive every state without a real browser. */
  client?: PushClient;
  win?: Window;
}

export class NotificationsView {
  private readonly o: NotificationsViewOptions;
  private readonly client: PushClient;
  private status: PushStatusResponse | null = null;
  private subscribed = false;
  private loading = true;
  private error = '';
  private notice = '';
  private busy = false;

  constructor(options: NotificationsViewOptions) {
    this.o = options;
    this.client = options.client
      ?? new PushClient((p, i) => options.auth.authedFetch(p, i), options.win);
    this.render();
    void this.load();
  }

  private async load(): Promise<void> {
    this.loading = true; this.error = ''; this.render();
    try {
      this.status = await this.client.status();
      if (!this.status) {
        this.error = 'নোটিফিকেশন সেটিংস আনা যায়নি — সংযোগ পেলে আবার দেখা যাবে।';
      }
      this.subscribed = await this.client.isSubscribed();
    } catch {
      this.error = 'নোটিফিকেশন সেটিংস আনা যায়নি — সংযোগ পেলে আবার দেখা যাবে।';
    } finally {
      this.loading = false; this.render();
    }
  }

  private state(): PushState {
    const win = this.o.win ?? globalThis.window;
    return pushState({
      hasServiceWorker: Boolean(win?.navigator && 'serviceWorker' in win.navigator),
      hasPushManager: Boolean(win && 'PushManager' in win),
      hasNotification: Boolean(win && 'Notification' in win),
      isSecureContext: Boolean(win?.isSecureContext),
      permission: this.client.permission(),
      serverEnabled: this.status?.enabled === true,
      subscribed: this.subscribed,
    });
  }

  private async enable(): Promise<void> {
    const key = this.status?.publicKey;
    if (!key) return;
    this.busy = true; this.error = ''; this.notice = ''; this.render();
    const r = await this.client.enable(key);
    if (r.ok) {
      this.notice = 'এই যন্ত্রে নোটিফিকেশন চালু হয়েছে।';
      this.subscribed = true;
      // Re-read so the device list shows the row that was just created,
      // rather than appearing only after the next visit.
      this.status = (await this.client.status()) ?? this.status;
    } else {
      this.error = r.message;
    }
    this.busy = false; this.render();
  }

  private async disable(): Promise<void> {
    this.busy = true; this.error = ''; this.notice = ''; this.render();
    const ok = await this.client.disable();
    if (ok) {
      this.notice = 'এই যন্ত্রে নোটিফিকেশন বন্ধ হয়েছে।';
      this.subscribed = false;
      this.status = (await this.client.status()) ?? this.status;
    } else {
      this.error = 'বন্ধ করা যায়নি — আবার চেষ্টা করুন।';
    }
    this.busy = false; this.render();
  }

  private async forget(d: PushDevice): Promise<void> {
    this.busy = true; this.error = ''; this.notice = ''; this.render();
    const ok = await this.client.forget(d.id);
    if (ok) {
      this.notice = 'যন্ত্রটি সরানো হয়েছে।';
      this.status = (await this.client.status()) ?? this.status;
      this.subscribed = await this.client.isSubscribed();
    } else {
      this.error = 'সরানো যায়নি — আবার চেষ্টা করুন।';
    }
    this.busy = false; this.render();
  }

  private render(): void {
    const d = this.o.doc;
    const root = this.o.root;
    root.textContent = '';

    const header = d.createElement('header');
    header.className = 'page-header';
    const h1 = d.createElement('h1');
    h1.textContent = 'নোটিফিকেশন';
    const sub = d.createElement('p');
    sub.className = 'page-sub';
    sub.textContent = 'এই যন্ত্রে বিদ্যালয়ের বার্তা পান';
    header.append(h1, sub);
    root.append(header);

    if (this.notice) root.append(successNote(d, this.notice));
    if (this.error) root.append(errorState(d, this.error, () => void this.load()));
    if (this.loading) { root.append(skeleton(d, 2)); return; }

    const card = d.createElement('div');
    card.className = 'card card-form';
    card.style.margin = '0 var(--s-4) var(--s-3)';

    const state = this.state();
    card.dataset.pushState = state;

    const why = d.createElement('p');
    why.className = 'att-sub';
    why.textContent =
      'নোটিফিকেশন চালু থাকলে বিদ্যালয়ের বার্তা সঙ্গে সঙ্গে এই যন্ত্রে আসবে — '
      + 'ইন্টারনেট খরচ প্রায় শূন্য, আর বিদ্যালয়ের এসএমএস খরচ কমে।';
    card.append(why);

    const status = d.createElement('p');
    status.className = 'inline-notice';
    card.append(status);

    const row = d.createElement('div');
    row.className = 'action-row';

    if (state === 'unsupported') {
      status.textContent = 'এই ব্রাউজারে নোটিফিকেশন সমর্থিত নয়।';
      const hint = d.createElement('p');
      hint.className = 'att-sub';
      // Not a dead end: the SMS path is unaffected, and saying so stops
      // somebody concluding they will now miss their child's absence.
      hint.textContent =
        'বিদ্যালয়ের বার্তা আগের মতোই এসএমএসে ও অ্যাপের নোটিশ অংশে পাবেন।';
      card.append(hint);
    } else if (state === 'unconfigured') {
      status.textContent = 'এই সার্ভারে এখনো নোটিফিকেশন চালু করা হয়নি।';
      const hint = d.createElement('p');
      hint.className = 'att-sub';
      hint.textContent = 'বিদ্যালয়ের আইটি অ্যাডমিনকে জানাতে পারেন।';
      card.append(hint);
    } else if (state === 'denied') {
      status.textContent = 'ব্রাউজারে নোটিফিকেশন বন্ধ করা আছে।';
      const hint = d.createElement('p');
      hint.className = 'att-sub';
      // The one state where the fix is entirely outside the app. A button
      // here would call requestPermission(), which returns 'denied'
      // immediately without showing anything, and look like a broken app.
      hint.textContent =
        'ঠিকানার পাশের তালা 🔒 চিহ্নে চাপ দিয়ে "নোটিফিকেশন" চালু করুন, '
        + 'তারপর এই পাতা আবার খুলুন।';
      card.append(hint);
    } else if (state === 'on') {
      status.textContent = 'এই যন্ত্রে নোটিফিকেশন চালু আছে।';
      const off = d.createElement('button');
      off.type = 'button';
      off.className = 'btn-secondary';
      off.textContent = this.busy ? 'অপেক্ষা করুন…' : 'এই যন্ত্রে বন্ধ করুন';
      off.disabled = this.busy;
      off.addEventListener('click', () => void this.disable());
      row.append(off);
    } else {
      status.textContent = 'এই যন্ত্রে নোটিফিকেশন বন্ধ আছে।';
      const on = d.createElement('button');
      on.type = 'button';
      on.className = 'btn-primary';
      on.textContent = this.busy ? 'চালু হচ্ছে…' : 'নোটিফিকেশন চালু করুন';
      on.disabled = this.busy;
      on.addEventListener('click', () => void this.enable());
      row.append(on);
    }

    if (row.childElementCount > 0) card.append(row);
    root.append(card);

    // ── The other devices this person has registered ──────────────────
    const devices = this.status?.devices ?? [];
    const h2 = d.createElement('h2');
    h2.className = 'section-heading';
    h2.textContent = 'আপনার যন্ত্রসমূহ';
    root.append(h2);

    if (devices.length === 0) {
      root.append(emptyState(d, {
        message: 'কোনো যন্ত্র যুক্ত নেই — যে যন্ত্রে নোটিফিকেশন চালু করবেন, '
          + 'সেটি এখানে দেখা যাবে।',
      }));
      return;
    }

    const list = d.createElement('ul');
    list.className = 'system-list';
    list.style.margin = '0 var(--s-4) var(--s-3)';
    for (const dev of devices) {
      const li = d.createElement('li');
      li.className = 'card system-row';
      li.dataset.deviceId = dev.id;

      const text = d.createElement('div');
      text.className = 'system-body';
      const name = d.createElement('p');
      name.className = 'system-title';
      name.textContent = dev.label || deviceLabelFor('');
      const meta = d.createElement('p');
      meta.className = 'system-desc';
      meta.textContent = dev.lastSuccessAt
        ? `সর্বশেষ বার্তা ${bnDate(dev.lastSuccessAt)}`
        : `যুক্ত হয়েছে ${bnDate(dev.createdAt)} — এখনো কোনো বার্তা যায়নি`;
      text.append(name, meta);

      const drop = d.createElement('button');
      drop.type = 'button';
      drop.className = 'btn-secondary';
      drop.textContent = 'সরান';
      drop.disabled = this.busy;
      drop.addEventListener('click', () => void this.forget(dev));

      li.append(text, drop);
      list.append(li);
    }
    root.append(list);
  }
}
