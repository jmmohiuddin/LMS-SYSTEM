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
import {
  pageHeader, card, dataTable, sectionHeading, statusBadge, button, buttonRow,
  listSkeleton, el,
} from './ui/index.ts';

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

    root.append(pageHeader(d, {
      title: 'নোটিফিকেশন',
      subtitle: 'এই যন্ত্রে বিদ্যালয়ের বার্তা পান — এসএমএসের বদলে নয়, তার আগে',
    }));

    if (this.notice) root.append(successNote(d, this.notice));
    if (this.error) root.append(errorState(d, this.error, () => void this.load()));
    if (this.loading) { root.append(listSkeleton(d, 2)); return; }

    const state = this.state();
    root.append(this.stateCard(state));

    // ── The other devices this person has registered ──────────────────
    // A table: each device is the same three facts, and a person deciding
    // which old phone to remove is comparing "last message" down a column.
    const devices = this.status?.devices ?? [];
    root.append(sectionHeading(d, { title: 'আপনার যন্ত্রসমূহ' }));
    root.append(dataTable(d, {
      caption: 'নোটিফিকেশন চালু আছে যেসব যন্ত্রে',
      rows: devices,
      rowKey: (dev) => dev.id,
      empty: {
        message: 'কোনো যন্ত্র যুক্ত নেই — যে যন্ত্রে নোটিফিকেশন চালু করবেন, '
          + 'সেটি এখানে দেখা যাবে।',
      },
      columns: [
        { key: 'label', header: 'যন্ত্র', mobile: 'title',
          cell: (dev) => dev.label || deviceLabelFor(''), width: 'minmax(0, 2fr)' },
        { key: 'when', header: 'সর্বশেষ বার্তা', mobile: 'subtitle',
          cell: (dev) => (dev.lastSuccessAt
            ? bnDate(dev.lastSuccessAt)
            : 'এখনো কোনো বার্তা যায়নি'),
          width: 'minmax(0, 1.4fr)' },
        { key: 'added', header: 'যুক্ত হয়েছে', mobile: 'meta',
          cell: (dev) => bnDate(dev.createdAt), width: 'minmax(0, 1.4fr)' },
        { key: 'actions', header: 'ব্যবস্থা', width: '150px',
          cell: (dev) => el(d, 'div', { className: 'ui-row-actions' }, button(d, {
            label: 'সরান', variant: 'secondary', size: 'sm',
            // Per-device: three buttons all called "সরান" are three
            // identical announcements.
            ariaLabel: `${dev.label || deviceLabelFor('')} থেকে নোটিফিকেশন সরান`,
            disabled: this.busy,
            onClick: () => void this.forget(dev),
          })) },
      ],
    }));
  }

  /**
   * What this device's notification state is, and the one thing to do about
   * it. Five states, and only two of them have an action — the other three
   * are fixed somewhere this app cannot reach, so they say where.
   */
  private stateCard(state: string): HTMLElement {
    const d = this.o.doc;

    const BADGE: Record<string, { state: string; label: string }> = {
      on:           { state: 'published', label: 'চালু আছে' },
      off:          { state: 'draft',     label: 'বন্ধ আছে' },
      denied:       { state: 'overdue',   label: 'ব্রাউজারে বন্ধ' },
      unsupported:  { state: 'draft',     label: 'সমর্থিত নয়' },
      unconfigured: { state: 'draft',     label: 'সার্ভারে চালু নেই' },
    };
    const b = BADGE[state] ?? BADGE.off;

    const body: Array<Node | null> = [
      el(d, 'p', {
        className: 'ui-card-note',
        text: 'নোটিফিকেশন চালু থাকলে বিদ্যালয়ের বার্তা সঙ্গে সঙ্গে এই যন্ত্রে আসবে — '
          + 'ইন্টারনেট খরচ প্রায় শূন্য, আর বিদ্যালয়ের এসএমএস খরচ কমে।',
      }),
    ];

    if (state === 'unsupported') {
      body.push(el(d, 'p', {
        className: 'ui-card-lead', text: 'এই ব্রাউজারে নোটিফিকেশন সমর্থিত নয়।',
      }));
      // Not a dead end: the SMS path is unaffected, and saying so stops
      // somebody concluding they will now miss their child's absence.
      body.push(el(d, 'p', {
        className: 'ui-card-note',
        text: 'বিদ্যালয়ের বার্তা আগের মতোই এসএমএসে ও অ্যাপের নোটিশ অংশে পাবেন।',
      }));
    } else if (state === 'unconfigured') {
      body.push(el(d, 'p', {
        className: 'ui-card-lead', text: 'এই সার্ভারে এখনো নোটিফিকেশন চালু করা হয়নি।',
      }));
      body.push(el(d, 'p', {
        className: 'ui-card-note', text: 'বিদ্যালয়ের আইটি অ্যাডমিনকে জানাতে পারেন।',
      }));
    } else if (state === 'denied') {
      body.push(el(d, 'p', {
        className: 'ui-card-lead', text: 'ব্রাউজারে নোটিফিকেশন বন্ধ করা আছে।',
      }));
      // The one state where the fix is entirely outside the app. A button
      // here would call requestPermission(), which returns 'denied'
      // immediately without showing anything, and look like a broken app.
      body.push(el(d, 'p', {
        className: 'ui-card-note',
        text: 'ঠিকানার পাশের তালা চিহ্নে চাপ দিয়ে "নোটিফিকেশন" চালু করুন, '
          + 'তারপর এই পাতা আবার খুলুন।',
      }));
    } else if (state === 'on') {
      body.push(el(d, 'p', {
        className: 'ui-card-lead', text: 'এই যন্ত্রে নোটিফিকেশন চালু আছে।',
      }));
      body.push(buttonRow(d, button(d, {
        label: 'এই যন্ত্রে বন্ধ করুন', variant: 'secondary', busy: this.busy,
        onClick: () => void this.disable(),
      })));
    } else {
      body.push(el(d, 'p', {
        className: 'ui-card-lead', text: 'এই যন্ত্রে নোটিফিকেশন বন্ধ আছে।',
      }));
      body.push(buttonRow(d, button(d, {
        label: 'নোটিফিকেশন চালু করুন', variant: 'primary', busy: this.busy,
        onClick: () => void this.enable(),
      })));
    }

    const host = card(d, {
      title: 'এই যন্ত্র', glyph: 'bell', headingLevel: 2,
      tone: state === 'on' ? 'success' : 'info',
      action: statusBadge(d, b),
    }, ...body);
    host.dataset.pushState = state;
    return host;
  }
}
