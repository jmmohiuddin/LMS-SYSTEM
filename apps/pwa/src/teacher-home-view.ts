/**
 * The teacher's home screen. (UI integration plan, P3)
 *
 * Before this, every role landed on the same grid of feature tiles — a screen
 * that answers "what CAN I do" for a person who arrived asking "what do I do
 * NOW". A teacher opening the app at 8:20am wants one thing: the class that is
 * about to start and whether its register has been taken.
 *
 * §"TEACHER DASHBOARD" asks the screen to answer three questions immediately:
 *
 *   1. What class/section do I have?      → today's periods, in order
 *   2. What do I need to do today?        → the same list, with ✓ where the
 *                                            register is already in
 *   3. What is the most urgent action?    → ONE card at the top, naming the
 *                                            section, going straight to it
 *
 * ── Where the data comes from, and why nothing new was built ───────────────
 * `GET /api/v1/rms/routine?scope=day` already returns every field this screen
 * needs — period, time, subject, section, room, `isSubstitution`,
 * `coveringForBn`, `studentCount` and, decisively, **`attendanceTaken`**. It
 * wraps `app.teacher_day()`, so substitutions the teacher is covering are
 * already merged in and the authorization is the one the routine screen
 * already relies on. No endpoint, no migration, no new permission.
 *
 * The urgent card is therefore *derived*, never stored: the first slot of the
 * day whose register is missing, preferring the one happening now. A stored
 * "next action" would go stale the moment a register was taken from another
 * device, which on a shared staffroom phone is the normal case.
 *
 * ── One dominant action, and only one ──────────────────────────────────────
 * §"Use exactly one visually dominant primary action". When every register is
 * in, there is no urgent card at all — the screen says so and shows the day.
 * A dashboard that always has a big red button teaches people to ignore it.
 */
import type { Auth } from './auth.ts';
import {
  el, append, icon, card, statRow, statCard, button, pageHeader, sectionHeading,
  badge, statusBadge, list, listItem, listSkeleton, emptyState, errorState,
  permissionState, humanError, announce,
} from './ui/index.ts';
import { formatCount, formatTime } from '../../../packages/ui-core/src/format.ts';

/** The subset of the routine slot this screen reads. Mirrors routine-view. */
export interface TeacherSlot {
  slotId: string;
  periodNo: number;
  startsAt: string;
  endsAt: string;
  slotKind: string;
  subjectBn: string | null;
  sectionLabel: string | null;
  sectionId?: string | null;
  roomCode: string | null;
  isSubstitution: boolean;
  coveringForBn: string | null;
  studentCount: number | null;
  attendanceTaken: boolean;
}

export interface TeacherHomeOptions {
  root: HTMLElement;
  doc: Document;
  auth: Auth;
  displayName?: string;
  /** Navigate to a route. Injected so the view never touches `location`. */
  go: (path: string) => void;
  /** Overridable for tests. */
  now?: () => Date;
}

const CACHE_KEY = 'shikhon_teacher_day_';

type Phase = 'loading' | 'ready' | 'error' | 'denied';

export class TeacherHomeView {
  private readonly o: TeacherHomeOptions;
  private phase: Phase = 'loading';
  private slots: TeacherSlot[] = [];
  private unread = 0;
  private errText = '';
  private fromCache = false;

  constructor(options: TeacherHomeOptions) {
    this.o = options;
    this.render();
    void this.load();
  }

  private now(): Date {
    return this.o.now ? this.o.now() : new Date();
  }

  private todayIso(): string {
    // Local date, not toISOString(): a teacher in Dhaka opening the app at
    // 07:00 is on the day their timetable says, and UTC would still be
    // yesterday for six hours of every morning.
    const d = this.now();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  /* ── data ───────────────────────────────────────────────────────────── */

  private async load(): Promise<void> {
    const date = this.todayIso();
    // Paint the cached day first. Reference data, read-mostly — the same
    // approach routine-view.ts and roster-view.ts already use, and on a 2G
    // cold start it is the difference between a screen and a spinner.
    const cached = this.readCache(date);
    if (cached) {
      this.slots = cached;
      this.fromCache = true;
      this.phase = 'ready';
      this.render();
    }

    try {
      const res = await this.o.auth.authedFetch(
        `/api/v1/rms/routine?scope=day&date=${date}`);
      if (res.status === 403) {
        // A staff account with no timetable is not an error and not a
        // permission problem in the usual sense — but the endpoint's own
        // answer is 403, so the screen says what it can rather than
        // pretending the day is empty.
        this.phase = 'denied';
        this.render();
        return;
      }
      if (!res.ok) throw new Httpish(res.status);
      const body = (await res.json()) as { slots?: TeacherSlot[] };
      this.slots = body.slots ?? [];
      this.fromCache = false;
      this.writeCache(date, this.slots);
      this.phase = 'ready';
    } catch (err) {
      // A cached day already on screen must not be replaced by an error: the
      // teacher can still see their periods, and the banner in the shell
      // already says the device is offline.
      if (this.fromCache) { this.render(); return; }
      this.phase = 'error';
      this.errText = humanError(
        navigator.onLine ? null : 'offline',
        err instanceof Httpish ? err.status : undefined);
    }
    this.render();
    void this.loadUnread();
  }

  /** The bell count is a nicety: its failure must never reach the screen. */
  private async loadUnread(): Promise<void> {
    try {
      const res = await this.o.auth.authedFetch('/api/v1/ops/inbox?limit=1');
      if (!res.ok) return;
      const body = (await res.json()) as { unread?: number };
      const n = body.unread ?? 0;
      if (n !== this.unread) { this.unread = n; this.render(); }
    } catch { /* offline: the dashboard is still correct without it */ }
  }

  private readCache(date: string): TeacherSlot[] | null {
    try {
      const raw = localStorage.getItem(CACHE_KEY + date);
      return raw ? (JSON.parse(raw) as TeacherSlot[]) : null;
    } catch { return null; }
  }

  private writeCache(date: string, slots: TeacherSlot[]): void {
    try { localStorage.setItem(CACHE_KEY + date, JSON.stringify(slots)); }
    catch { /* quota or private mode — the screen works without it */ }
  }

  /* ── derivation ─────────────────────────────────────────────────────── */

  /** Teaching periods only. A break is not a class and must not be counted. */
  private teaching(): TeacherSlot[] {
    return this.slots.filter((s) => s.slotKind !== 'break' && s.sectionLabel);
  }

  /**
   * The one thing to do next.
   *
   * The period happening RIGHT NOW whose register is missing, else the next
   * one that has not started, else the earliest missing register of the day.
   * Derived on every render rather than stored: a register taken on another
   * device changes this answer, and a shared staffroom phone is the normal
   * case, not the edge one.
   */
  private urgent(): TeacherSlot | null {
    const pending = this.teaching().filter((s) => !s.attendanceTaken);
    if (!pending.length) return null;
    const t = this.hhmm(this.now());
    return pending.find((s) => s.startsAt <= t && t <= s.endsAt)
      ?? pending.find((s) => s.startsAt >= t)
      ?? pending[0];
  }

  private hhmm(d: Date): string {
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }

  private isNow(s: TeacherSlot): boolean {
    const t = this.hhmm(this.now());
    return s.startsAt <= t && t <= s.endsAt;
  }

  /* ── render ─────────────────────────────────────────────────────────── */

  private render(): void {
    const d = this.o.doc;
    const root = this.o.root;
    root.textContent = '';

    append(root, pageHeader(d, {
      title: greetingBn(this.now()) + (this.o.displayName ? `, ${this.o.displayName}` : ''),
      subtitle: todayBn(this.now()),
    }));

    if (this.phase === 'loading') {
      append(root, listSkeleton(d, 4));
      return;
    }
    if (this.phase === 'denied') {
      append(root, permissionState(d, {
        message: 'আপনার জন্য আজকের কোনো রুটিন নেই।',
        contact: 'একাডেমিক সমন্বয়কারী',
      }));
      return;
    }
    if (this.phase === 'error') {
      append(root, errorState(d, this.errText, () => {
        this.phase = 'loading';
        this.render();
        void this.load();
      }));
      return;
    }

    append(root, this.urgentBlock(), this.summary(), this.todayList(), this.quickRow());
  }

  /** The single dominant action, or the sentence that replaces it. */
  private urgentBlock(): HTMLElement {
    const d = this.o.doc;
    const next = this.urgent();
    const teaching = this.teaching();

    if (!teaching.length) {
      return card(d, { title: 'আজ কোনো ক্লাস নেই', glyph: 'clock', tone: 'info' },
        el(d, 'p', { className: 'th-note',
          text: 'আজকের রুটিনে আপনার কোনো ক্লাস নেই। রুটিন দেখে নিশ্চিত হয়ে নিন।' }),
        button(d, { label: 'রুটিন দেখুন', variant: 'secondary',
          glyph: 'clock', onClick: () => this.o.go('routine') }));
    }

    if (!next) {
      // Every register is in. No primary action at all — a dashboard that
      // always shows a big button teaches people to stop reading it.
      return card(d, { title: 'আজকের সব হাজিরা নেওয়া হয়েছে', glyph: 'check-square',
        tone: 'success' },
        el(d, 'p', { className: 'th-note',
          text: `আজকের ${formatCount(teaching.length, 'bn')}টি ক্লাসের হাজিরাই জমা হয়েছে।` }));
    }

    const now = this.isNow(next);
    const wrap = el(d, 'section', { className: 'th-urgent', data: { now: String(now) } });
    append(wrap,
      el(d, 'p', { className: 'th-urgent-kicker',
        text: now ? 'এখন চলছে' : 'পরবর্তী ক্লাস' }),
      el(d, 'h2', { className: 'th-urgent-title',
        text: `${next.sectionLabel} · ${next.subjectBn ?? 'ক্লাস'}` }),
      el(d, 'p', { className: 'th-urgent-meta', text: [
        `${formatTime(next.startsAt, 'bn')}–${formatTime(next.endsAt, 'bn')}`,
        next.roomCode ? `কক্ষ ${next.roomCode}` : null,
        next.studentCount != null ? `${formatCount(next.studentCount, 'bn')} জন` : null,
      ].filter(Boolean).join(' · ') }));

    if (next.isSubstitution) {
      // §"If a substitution exists, clearly explain why and what changed."
      append(wrap, el(d, 'p', { className: 'th-sub-note' },
        icon(d, 'repeat', 'th-sub-glyph'),
        el(d, 'span', { text: next.coveringForBn
          ? `${next.coveringForBn}-এর বদলি হিসেবে আপনি এই ক্লাসটি নিচ্ছেন।`
          : 'এটি আপনার নিজের ক্লাস নয় — বদলি হিসেবে নিচ্ছেন।' })));
    }

    append(wrap, button(d, {
      label: 'হাজিরা নিন', variant: 'primary', glyph: 'check-square', block: true,
      className: 'th-urgent-go',
      onClick: () => {
        announce(this.o.doc, `${next.sectionLabel} — হাজিরা খোলা হচ্ছে`);
        this.o.go('attendance');
      },
    }));
    return wrap;
  }

  /** Three numbers, not a wall of them. */
  private summary(): HTMLElement {
    const d = this.o.doc;
    const teaching = this.teaching();
    const done = teaching.filter((s) => s.attendanceTaken).length;
    return statRow(d,
      statCard(d, { label: 'আজকের ক্লাস', value: `${formatCount(teaching.length, 'bn')} টি`,
        glyph: 'clock', tone: 'info' }),
      statCard(d, { label: 'হাজিরা জমা', value: `${formatCount(done, 'bn')} / ${formatCount(teaching.length, 'bn')}`,
        glyph: 'check-square', tone: done === teaching.length ? 'success' : 'warn' }),
      statCard(d, { label: 'নতুন নোটিশ', value: `${formatCount(this.unread, 'bn')} টি`,
        glyph: 'bell', tone: 'accent2', onClick: () => this.o.go('inbox') }));
  }

  /** The day, in order, with the register's state spelled out on every row. */
  private todayList(): HTMLElement {
    const d = this.o.doc;
    const wrap = el(d, 'section');
    append(wrap, sectionHeading(d, {
      title: 'আজকের ক্লাস',
      action: button(d, { label: 'পুরো রুটিন', variant: 'ghost', size: 'sm',
        onClick: () => this.o.go('routine') }),
    }));

    const teaching = this.teaching();
    if (!teaching.length) {
      append(wrap, emptyState(d, {
        message: 'আজকের রুটিনে আপনার কোনো ক্লাস নেই।',
        action: { label: 'সাপ্তাহিক রুটিন দেখুন', onClick: () => this.o.go('routine') },
      }));
      return wrap;
    }

    const items = teaching.map((s) => listItem(d, {
      title: `${s.sectionLabel} · ${s.subjectBn ?? 'ক্লাস'}`,
      subtitle: [
        `${formatTime(s.startsAt, 'bn')}–${formatTime(s.endsAt, 'bn')}`,
        s.roomCode ? `কক্ষ ${s.roomCode}` : null,
      ].filter(Boolean).join(' · '),
      meta: s.isSubstitution
        ? (s.coveringForBn ? `বদলি — ${s.coveringForBn}` : 'বদলি ক্লাস')
        : undefined,
      glyph: this.isNow(s) ? 'clock' : 'book-open',
      // Never colour alone: the word is the status, the tint is the echo.
      status: s.attendanceTaken
        ? statusBadge(d, { state: 'present', label: 'হাজিরা জমা' })
        : statusBadge(d, { state: 'pending', label: 'হাজিরা বাকি' }),
      onClick: () => this.o.go('attendance'),
      className: this.isNow(s) ? 'is-now' : undefined,
    }));
    append(wrap, list(d, 'আজকের ক্লাস', ...items));
    return wrap;
  }

  /** The short tail. Four, not fourteen — the rest is one tap away in আরও. */
  private quickRow(): HTMLElement {
    const d = this.o.doc;
    const wrap = el(d, 'section');
    append(wrap, sectionHeading(d, { title: 'দ্রুত প্রবেশ' }));
    const grid = el(d, 'div', { className: 'th-quick' });
    const tiles: Array<[string, string, string, string]> = [
      ['roster', 'users', 'সেকশন রোস্টার', 'শিক্ষার্থীর তালিকা'],
      ['marks', 'edit', 'নম্বর এন্ট্রি', 'CQ · MCQ · ব্যবহারিক'],
      ['assignments', 'clipboard', 'বাড়ির কাজ', 'কাজ দাও ও নম্বর দাও'],
      ['calendar', 'calendar', 'শিক্ষাপঞ্জি', 'ছুটি ও পরীক্ষা'],
    ];
    for (const [path, glyph, title, sub] of tiles) {
      append(grid, card(d, {
        title, subtitle: sub, glyph, headingLevel: 3,
        tone: 'primary', onClick: () => this.o.go(path),
      }));
    }
    append(wrap, grid);
    return wrap;
  }
}

/** Distinguishes a bad status from a network throw, for `humanError`. */
// No constructor parameter property: Node runs this repo's TypeScript in
// STRIP-ONLY mode, which rejects `constructor(public x)` outright. `tsc`
// accepts it, so the type gate is silent and only the test runner fails.
class Httpish extends Error {
  readonly status: number;
  constructor(status: number) { super(`http_${status}`); this.status = status; }
}

export function greetingBn(now: Date): string {
  const h = now.getHours();
  if (h < 5) return 'শুভ রাত্রি';
  if (h < 12) return 'শুভ সকাল';
  if (h < 17) return 'শুভ দুপুর';
  if (h < 20) return 'শুভ বিকেল';
  return 'শুভ সন্ধ্যা';
}

export function todayBn(now: Date): string {
  const months = ['জানুয়ারি', 'ফেব্রুয়ারি', 'মার্চ', 'এপ্রিল', 'মে', 'জুন', 'জুলাই',
    'আগস্ট', 'সেপ্টেম্বর', 'অক্টোবর', 'নভেম্বর', 'ডিসেম্বর'];
  const days = ['রবিবার', 'সোমবার', 'মঙ্গলবার', 'বুধবার', 'বৃহস্পতিবার', 'শুক্রবার', 'শনিবার'];
  return `${days[now.getDay()]}, ${formatCount(now.getDate(), 'bn')} ${months[now.getMonth()]}`;
}
