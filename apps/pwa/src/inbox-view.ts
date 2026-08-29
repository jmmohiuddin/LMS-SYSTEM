/**
 * নোটিশ — the inbox behind the bell  (R-2, docs/11-MASTER-PLAN.md)
 *
 * Every role has one. What differs is what is in it, and that was decided when
 * the notice was published and the receipts were written — this screen does not
 * interpret audiences at all, it lists the caller's own receipts.
 *
 * ── Reading is a side effect of opening, not a button ───────────────────
 * A notice is marked read when its body is expanded. An explicit "mark as
 * read" control asks a guardian to do bookkeeping for the school's benefit;
 * expanding it is already the act of reading it. "সব পড়া হয়েছে" exists for the
 * backlog case — a teacher returning from leave to 40 notices — and is the
 * only place the user is asked to declare anything.
 *
 * ── Unread is a state, not a colour ─────────────────────────────────────
 * Unread rows carry a marker and a heavier title, not only a tint: the
 * reference device is a 2 GB Android phone in daylight, and a pale background
 * difference is the first thing that stops being visible.
 */
import type { Auth } from './auth.ts';
import { CATEGORY_LABELS_BN, type NoticeCategory } from '../../../packages/ui-core/src/notice.ts';
import { iconSvg } from './icon.ts';

export interface InboxNotice {
  receiptId: string;
  noticeId: string;
  title: string;
  body: string;
  category: string;
  deliveredAt: string;
  readAt: string | null;
  aboutStudent: { id: string; nameBn: string | null } | null;
}

export interface InboxViewOptions {
  root: HTMLElement;
  doc: Document;
  auth: Auth;
  /** Called after a read so the shell's badge can follow without a refetch. */
  onUnreadChange?: (unread: number) => void;
}

/** Icon per category — one drawn set, tintable, no emoji (see icon.ts). */
const CATEGORY_GLYPH: Record<string, string> = {
  general: 'bell',
  teacher: 'users',
  student: 'book-open',
  guardian: 'users',
  class: 'layers',
  section: 'layers',
  exam: 'award',
  fee: 'wallet',
  attendance: 'check-square',
  emergency: 'alert-triangle',
};

/** "আজ" / "গতকাল" / a date — a timestamp is not what a reader wants. */
export function relativeDayBn(iso: string, now = Date.now()): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return '';
  const days = Math.floor((now - then) / 86_400_000);
  if (days <= 0) return 'আজ';
  if (days === 1) return 'গতকাল';
  if (days < 7) return `${days} দিন আগে`;
  return new Date(then).toLocaleDateString('bn-BD', { day: 'numeric', month: 'short' });
}

export class InboxView {
  private readonly o: InboxViewOptions;
  private notices: InboxNotice[] = [];
  private unread = 0;
  private loading = true;
  private error = '';
  private expanded = new Set<string>();

  constructor(options: InboxViewOptions) {
    this.o = options;
    this.render();
    void this.load();
  }

  private async load(): Promise<void> {
    try {
      const res = await this.o.auth.authedFetch('/api/v1/ops/inbox?limit=50');
      if (!res.ok) throw new Error(String(res.status));
      const body = (await res.json()) as { unread: number; notices: InboxNotice[] };
      this.notices = body.notices ?? [];
      this.unread = body.unread ?? 0;
      this.error = '';
      this.o.onUnreadChange?.(this.unread);
    } catch {
      // Offline is expected on this product's reference network. The service
      // worker serves the last inbox from cache; if even that is absent, say
      // so plainly rather than showing an empty inbox, which reads as
      // "nothing has happened" and is a different, wrong claim.
      if (this.notices.length === 0) this.error = 'নোটিশ আনা যায়নি — সংযোগ পেলে আবার দেখা যাবে।';
    } finally {
      this.loading = false;
      this.render();
    }
  }

  private async markRead(noticeId: string): Promise<void> {
    const row = this.notices.find((n) => n.noticeId === noticeId);
    if (!row || row.readAt) return;
    // Optimistic: the badge should drop the instant it is opened, and a failed
    // request costs nothing but a re-mark on the next load.
    row.readAt = new Date().toISOString();
    this.unread = Math.max(0, this.unread - 1);
    this.o.onUnreadChange?.(this.unread);
    this.render();
    try {
      await this.o.auth.authedFetch('/api/v1/ops/inbox', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ noticeId }),
      });
    } catch { /* the next load re-marks it */ }
  }

  private async markAllRead(): Promise<void> {
    for (const n of this.notices) n.readAt ??= new Date().toISOString();
    this.unread = 0;
    this.o.onUnreadChange?.(0);
    this.render();
    try {
      await this.o.auth.authedFetch('/api/v1/ops/inbox', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ all: true }),
      });
    } catch { /* the next load re-marks them */ }
  }

  private render(): void {
    const d = this.o.doc;
    const root = this.o.root;
    root.textContent = '';

    const header = d.createElement('header');
    header.className = 'att-header';
    const h1 = d.createElement('h1');
    h1.textContent = 'নোটিশ';
    header.append(h1);
    if (this.unread > 0) {
      const all = d.createElement('button');
      all.type = 'button';
      all.className = 'btn-ghost btn-small';
      all.textContent = 'সব পড়া হয়েছে';
      all.addEventListener('click', () => { void this.markAllRead(); });
      header.append(all);
    }
    root.append(header);

    if (this.loading) {
      const p = d.createElement('p');
      p.className = 'att-sub';
      p.style.padding = 'var(--s-4)';
      p.textContent = 'লোড হচ্ছে…';
      root.append(p);
      return;
    }

    if (this.error) {
      const p = d.createElement('p');
      p.className = 'login-error';
      p.setAttribute('role', 'alert');
      p.style.margin = 'var(--s-4)';
      p.textContent = this.error;
      root.append(p);
    }

    if (this.notices.length === 0 && !this.error) {
      const empty = d.createElement('p');
      empty.className = 'att-sub';
      empty.style.padding = 'var(--s-4)';
      empty.textContent = 'এখনো কোনো নোটিশ নেই।';
      root.append(empty);
      return;
    }

    const list = d.createElement('div');
    list.className = 'notice-list';

    for (const n of this.notices) {
      const item = d.createElement('article');
      item.className = 'notice-card';
      if (!n.readAt) item.classList.add('unread');
      if (n.category === 'emergency') item.classList.add('urgent');

      const head = d.createElement('button');
      head.type = 'button';
      head.className = 'notice-head';
      const open = this.expanded.has(n.noticeId);
      head.setAttribute('aria-expanded', String(open));

      const glyph = d.createElement('span');
      glyph.className = 'notice-glyph';
      glyph.setAttribute('aria-hidden', 'true');
      glyph.innerHTML = iconSvg(CATEGORY_GLYPH[n.category] ?? 'bell');

      const main = d.createElement('span');
      main.className = 'notice-main';
      const title = d.createElement('span');
      title.className = 'notice-title';
      title.textContent = n.title;
      const meta = d.createElement('span');
      meta.className = 'notice-meta';
      // A guardian with two children needs to know WHICH child this is about
      // before they read a word of it.
      const who = n.aboutStudent?.nameBn ? ` · ${n.aboutStudent.nameBn}` : '';
      meta.textContent =
        `${CATEGORY_LABELS_BN[n.category as NoticeCategory] ?? n.category} · ${relativeDayBn(n.deliveredAt)}${who}`;
      main.append(title, meta);

      head.append(glyph, main);
      if (!n.readAt) {
        const dot = d.createElement('span');
        dot.className = 'notice-dot';
        dot.setAttribute('aria-label', 'পড়া হয়নি');
        head.append(dot);
      }

      head.addEventListener('click', () => {
        if (this.expanded.has(n.noticeId)) this.expanded.delete(n.noticeId);
        else {
          this.expanded.add(n.noticeId);
          void this.markRead(n.noticeId);
        }
        this.render();
      });

      item.append(head);

      if (open) {
        const body = d.createElement('p');
        body.className = 'notice-body';
        // textContent, never innerHTML: this string was typed by a person at
        // the school and is being placed in every reader's browser.
        body.textContent = n.body;
        item.append(body);
      }

      list.append(item);
    }

    root.append(list);
  }
}
