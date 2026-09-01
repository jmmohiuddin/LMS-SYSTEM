/**
 * The student's home screen. (UI integration plan, P4)
 *
 * §1: "A Student portal must NOT look like an administrative database."
 * §4 wants the top of the screen to answer three questions: what do I have
 * today, what needs attention, what is coming next.
 *
 * ── What this screen deliberately does NOT show ────────────────────────────
 * **Today's class routine.** §4 lists it first, and the product cannot answer
 * it: `GET /rms/routine` wraps `app.teacher_day(claims.sub, …)`, so a student
 * calling it gets their own — empty — teaching day, not their section's
 * timetable. There is no student-facing routine endpoint, and inventing a
 * plausible one on the client would be fabricated curriculum data, which §10
 * forbids in the same breath. The gap is named in the PHASE_LOG rather than
 * papered over with a card that would be right for a teacher and wrong here.
 *
 * ── What it shows instead, all from endpoints that exist ───────────────────
 *   `GET /academics/next`        what needs attention — homework due inside
 *                                three days and not submitted, a practice
 *                                question last answered wrong, the next
 *                                chapter. Already ranked by urgency, server
 *                                side, and already used by the old grid.
 *   `GET /academics/attendance`  the month's own attendance (F-806)
 *   `GET /academics/results`     the most recent PUBLISHED result
 *   `GET /ops/inbox`             notices addressed to this student (R-2)
 *
 * Each block renders as soon as its own request lands. On a 2 G connection
 * four sequential requests would be four seconds of blank screen; four
 * independent ones mean the screen fills in as the answers arrive and a slow
 * inbox never holds up the homework that is due today.
 */
import type { Auth } from './auth.ts';
import {
  el, append, card, statRow, statCard, button, pageHeader, sectionHeading,
  statusBadge, list, listItem, listSkeleton, emptyState, errorState,
  humanError, icon,
} from './ui/index.ts';
import { formatCount } from '../../../packages/ui-core/src/format.ts';

export interface Suggestion {
  kind: string;
  titleBn: string;
  whyBn: string;
  route: string;
  refId: string;
  urgency: 'high' | 'medium' | 'low';
}

interface AttendanceTotals {
  present: number; late: number; absent: number; excused: number;
  halfDay: number; counted: number; attendedPercent: number | null;
}

interface RecentResult {
  examNameBn: string; gpa: string | null; letterGrade: string | null;
  rankInSection: number | null; publishedAt: string | null;
}

interface NoticeRow { id: string; titleBn: string; publishedAt: string; readAt: string | null }

export interface StudentHomeOptions {
  root: HTMLElement;
  doc: Document;
  auth: Auth;
  displayName?: string;
  go: (path: string) => void;
  now?: () => Date;
}

/** Icon per suggestion kind. Names from ./icon.ts — never an emoji. */
const KIND_GLYPH: Record<string, string> = {
  assignment: 'clipboard',
  redo_practice: 'refresh',
  continue_topic: 'arrow-right',
  new_chapter: 'star',
};

export class StudentHomeView {
  private readonly o: StudentHomeOptions;
  private next: Suggestion[] | null = null;
  private totals: AttendanceTotals | null = null;
  private result: RecentResult | null = null;
  private notices: NoticeRow[] = [];
  private unread = 0;
  private failed = false;
  private errText = '';
  private booted = false;

  constructor(options: StudentHomeOptions) {
    this.o = options;
    this.render();
    void this.load();
  }

  private now(): Date { return this.o.now ? this.o.now() : new Date(); }

  /* ── data ───────────────────────────────────────────────────────────── */

  private async load(): Promise<void> {
    // Four independent requests. One slow answer must not hold the others
    // back, so each repaints when it lands rather than awaiting the set.
    const get = async <T>(path: string): Promise<T | null> => {
      try {
        const res = await this.o.auth.authedFetch(path);
        if (!res.ok) return null;
        return (await res.json()) as T;
      } catch { return null; }
    };

    const jobs = [
      get<{ suggestions: Suggestion[] }>('/api/v1/academics/next')
        .then((b) => { this.next = b?.suggestions ?? []; this.repaint(); }),
      get<{ totals: AttendanceTotals }>('/api/v1/academics/attendance?months=1')
        .then((b) => { this.totals = b?.totals ?? null; this.repaint(); }),
      get<{ results: RecentResult[] }>('/api/v1/academics/results')
        .then((b) => { this.result = b?.results?.[0] ?? null; this.repaint(); }),
      get<{ notices: NoticeRow[]; unread: number }>('/api/v1/ops/inbox?limit=3')
        .then((b) => { this.notices = b?.notices ?? []; this.unread = b?.unread ?? 0; this.repaint(); }),
    ];

    await Promise.all(jobs);
    this.booted = true;
    // Everything failed AND nothing is cached from a previous paint: that is
    // an error worth a screen. One failure among four is not — the block that
    // failed simply shows its own empty state.
    if (this.next === null && this.totals === null && !this.notices.length) {
      this.failed = true;
      this.errText = humanError(navigator.onLine ? null : 'offline');
    }
    this.repaint();
  }

  private repaint(): void { this.render(); }

  /* ── render ─────────────────────────────────────────────────────────── */

  private render(): void {
    const d = this.o.doc;
    const root = this.o.root;
    root.textContent = '';

    append(root, pageHeader(d, {
      title: greeting(this.now()) + (this.o.displayName ? `, ${this.o.displayName}` : ''),
      subtitle: todayBn(this.now()),
    }));

    if (!this.booted && this.next === null && this.totals === null) {
      append(root, listSkeleton(d, 4));
      return;
    }
    if (this.failed) {
      append(root, errorState(d, this.errText, () => {
        this.failed = false; this.booted = false;
        this.render();
        void this.load();
      }));
      return;
    }

    append(root, this.attention(), this.summary(), this.noticeBlock(), this.quick());
  }

  /**
   * What needs attention — the screen's reason to exist.
   *
   * The server already ranks these, so the client neither re-sorts nor
   * invents a rule. When there is nothing due, the block says so plainly
   * rather than disappearing: "nothing is due" is information a student came
   * for, and an absent block reads as a screen that failed to load.
   */
  private attention(): HTMLElement {
    const d = this.o.doc;
    const wrap = el(d, 'section');
    append(wrap, sectionHeading(d, { title: 'এখন যা দরকার' }));

    if (this.next === null) { append(wrap, listSkeleton(d, 2)); return wrap; }

    if (!this.next.length) {
      append(wrap, card(d, { title: 'এই মুহূর্তে জমা দেওয়ার কিছু নেই',
        glyph: 'check-square', tone: 'success' },
        el(d, 'p', { className: 'sh-note',
          text: 'তিন দিনের মধ্যে জমা দিতে হবে এমন কোনো কাজ নেই। পড়াশোনা চালিয়ে যাও।' }),
        button(d, { label: 'পড়াশোনায় যাও', variant: 'secondary', glyph: 'book-open',
          onClick: () => this.o.go('learn') })));
      return wrap;
    }

    const items = this.next.map((s) => listItem(d, {
      title: s.titleBn,
      subtitle: s.whyBn,
      glyph: KIND_GLYPH[s.kind] ?? 'star',
      // A word for the urgency, never the colour alone.
      status: s.urgency === 'high'
        ? statusBadge(d, { state: 'due', label: 'জরুরি' })
        : undefined,
      onClick: () => this.o.go(s.route),
      className: s.urgency === 'high' ? 'is-urgent' : undefined,
    }));
    append(wrap, list(d, 'এখন যা দরকার', ...items));
    return wrap;
  }

  /** Three numbers a student actually asks about. Not a wall of analytics. */
  private summary(): HTMLElement {
    const d = this.o.doc;
    const pct = this.totals?.attendedPercent;
    return statRow(d,
      statCard(d, {
        label: 'এ মাসে হাজিরা',
        value: pct === null || pct === undefined ? '—' : `${formatCount(pct, 'bn')}%`,
        note: this.totals ? `${formatCount(this.totals.counted, 'bn')} দিন গণনা হয়েছে` : undefined,
        glyph: 'percent',
        tone: pct === null || pct === undefined ? 'info' : pct >= 80 ? 'success' : 'warn',
        onClick: () => this.o.go('my-attendance'),
      }),
      statCard(d, {
        label: 'সর্বশেষ ফলাফল',
        value: this.result?.gpa ? `GPA ${this.result.gpa}` : '—',
        note: this.result?.examNameBn ?? 'এখনো কোনো ফলাফল প্রকাশ হয়নি',
        glyph: 'award', tone: 'accent2',
        onClick: () => this.o.go('results'),
      }),
      statCard(d, {
        label: 'নতুন নোটিশ',
        value: `${formatCount(this.unread, 'bn')} টি`,
        glyph: 'bell', tone: 'info',
        onClick: () => this.o.go('inbox'),
      }));
  }

  private noticeBlock(): HTMLElement {
    const d = this.o.doc;
    const wrap = el(d, 'section');
    append(wrap, sectionHeading(d, {
      title: 'সাম্প্রতিক নোটিশ',
      action: button(d, { label: 'সব দেখুন', variant: 'ghost', size: 'sm',
        onClick: () => this.o.go('inbox') }),
    }));
    if (!this.notices.length) {
      append(wrap, emptyState(d, { message: 'এখনো কোনো নোটিশ আসেনি।' }));
      return wrap;
    }
    append(wrap, list(d, 'সাম্প্রতিক নোটিশ', ...this.notices.map((n) => listItem(d, {
      title: n.titleBn,
      subtitle: bnDate(n.publishedAt),
      glyph: 'bell',
      status: n.readAt ? undefined : statusBadge(d, { state: 'pending', label: 'নতুন' }),
      onClick: () => this.o.go('inbox'),
    }))));
    return wrap;
  }

  private quick(): HTMLElement {
    const d = this.o.doc;
    const wrap = el(d, 'section');
    append(wrap, sectionHeading(d, { title: 'দ্রুত প্রবেশ' }));
    const grid = el(d, 'div', { className: 'sh-quick' });
    const tiles: Array<[string, string, string, string]> = [
      ['subjects', 'layers', 'আমার বিষয়', 'শ্রেণি ও বিভাগ অনুযায়ী'],
      ['assignments', 'clipboard', 'বাড়ির কাজ', 'জমা দিতে হবে যেসব'],
      ['results', 'award', 'ফলাফল', 'পরীক্ষার নম্বর ও গ্রেড'],
      ['fees', 'wallet', 'বেতন ও ফি', 'ইনভয়েস ও রসিদ'],
    ];
    for (const [path, glyph, title, sub] of tiles) {
      append(grid, card(d, {
        title, subtitle: sub, glyph, headingLevel: 3, tone: 'primary',
        onClick: () => this.o.go(path),
      }));
    }
    append(wrap, grid);
    return wrap;
  }
}

export function greeting(now: Date): string {
  const h = now.getHours();
  if (h < 5) return 'শুভ রাত্রি';
  if (h < 12) return 'শুভ সকাল';
  if (h < 17) return 'শুভ দুপুর';
  if (h < 20) return 'শুভ বিকেল';
  return 'শুভ সন্ধ্যা';
}

const MONTHS = ['জানুয়ারি', 'ফেব্রুয়ারি', 'মার্চ', 'এপ্রিল', 'মে', 'জুন', 'জুলাই',
  'আগস্ট', 'সেপ্টেম্বর', 'অক্টোবর', 'নভেম্বর', 'ডিসেম্বর'];
const DAYS = ['রবিবার', 'সোমবার', 'মঙ্গলবার', 'বুধবার', 'বৃহস্পতিবার', 'শুক্রবার', 'শনিবার'];

export function todayBn(now: Date): string {
  return `${DAYS[now.getDay()]}, ${formatCount(now.getDate(), 'bn')} ${MONTHS[now.getMonth()]}`;
}

function bnDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${formatCount(d.getDate(), 'bn')} ${MONTHS[d.getMonth()]}`;
}
