/**
 * The student's home screen. (UI integration plan, P4)
 *
 * §1: "A Student portal must NOT look like an administrative database."
 * §4 wants the top of the screen to answer three questions: what do I have
 * today, what needs attention, what is coming next.
 *
 * ── Today's classes: the card this screen was built around ─────────────────
 * §4 lists it first, and for the whole of P4 the product could not answer it:
 * `GET /rms/routine` wraps `app.teacher_day(claims.sub, …)`, so a student
 * calling it received their own — empty — TEACHING day. Rather than invent a
 * plausible timetable on the client (fabricated curriculum data, which §10
 * forbids in the same breath as asking for the card) P4 shipped without it and
 * wrote the gap down.
 *
 * B-15 closed it properly: `app.student_day` (migration 049) and
 * `GET /academics/myroutine`, section-scoped, parallel-block filtered by what
 * this student actually takes, substitutions resolved to whoever is really
 * taking the period. Not a widening of the teacher endpoint — a sibling, for a
 * different reader asking a different question.
 *
 * ── The rest, all from endpoints that already existed ──────────────────────
 *   `GET /academics/myroutine`   today's classes, current and next (B-15)
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

/** One period of the student's own day. Mirrors StudentSlot on the server. */
export interface RoutineSlot {
  slotId: string;
  periodNo: number;
  /** 'HH:MM', already trimmed server-side. */
  startsAt: string;
  endsAt: string;
  subjectBn: string | null;
  roomCode: string | null;
  teacherNameBn: string | null;
  isSubstitution: boolean;
}

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
  private slots: RoutineSlot[] | null = null;
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
      // B-15. First in the list because it is first on the screen, and its own
      // request because a slow inbox must not delay "where do I have to be".
      get<{ slots: RoutineSlot[] }>('/api/v1/academics/myroutine')
        .then((b) => { this.slots = b?.slots ?? []; this.repaint(); }),
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
    if (this.next === null && this.totals === null && this.slots === null
        && !this.notices.length) {
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

    append(root, this.today(), this.attention(), this.summary(),
           this.noticeBlock(), this.quick());
  }

  /**
   * Today's classes, with the one that is happening NOW called out.
   *
   * §4 wants three questions answered at the top of the screen and this is the
   * first of them. The current period is marked rather than merely listed:
   * a student glancing at their phone between periods is asking "which room
   * next", and making them read six rows to work that out is the difference
   * between a timetable and an answer.
   *
   * `now` comes from the same injectable clock the greeting uses, so the
   * "current period" is testable rather than dependent on when the suite runs.
   */
  private today(): HTMLElement {
    const d = this.o.doc;
    const wrap = el(d, 'section');
    append(wrap, sectionHeading(d, { title: 'আজকের ক্লাস' }));

    if (this.slots === null) { append(wrap, listSkeleton(d, 3)); return wrap; }

    if (!this.slots.length) {
      // A holiday, a weekend, or a routine that has not been published. The
      // screen says the true thing it knows and does not guess which.
      append(wrap, emptyState(d, { message: 'আজ কোনো ক্লাস নেই।' }));
      return wrap;
    }

    const mins = this.now().getHours() * 60 + this.now().getMinutes();
    const at = (t: string): number => {
      const [h, m] = t.split(':').map(Number);
      return (h ?? 0) * 60 + (m ?? 0);
    };
    const currentIdx = this.slots.findIndex(
      (s) => mins >= at(s.startsAt) && mins < at(s.endsAt));
    const nextIdx = currentIdx >= 0
      ? -1
      : this.slots.findIndex((s) => at(s.startsAt) > mins);

    const items = this.slots.map((s, i) => {
      const when = `${periodBn(s.periodNo)} পিরিয়ড · ${bnTime(s.startsAt)}–${bnTime(s.endsAt)}`;
      // The substitution rides with the NAME it qualifies, not in the badge:
      // "who is taking this" and "when is this" are different facts, and the
      // badge can only hold one. Putting substitution there meant a covered
      // period that happened to be running now silently stopped saying it was
      // covered — which is the one moment the student needs to know.
      const teacher = s.teacherNameBn
        ? (s.isSubstitution ? `${s.teacherNameBn} (বদলি)` : s.teacherNameBn)
        : (s.isSubstitution ? 'বদলি শিক্ষক' : null);
      const where = [s.roomCode ? `রুম ${s.roomCode}` : null, teacher]
        .filter(Boolean).join(' · ');
      return listItem(d, {
        title: s.subjectBn ?? 'বিষয় নির্ধারিত হয়নি',
        subtitle: when,
        meta: where || undefined,
        glyph: 'clock',
        // A word, never a tint alone: this list is read at a glance in a
        // corridor between periods.
        status: i === currentIdx
          ? statusBadge(d, { state: 'due', label: 'এখন চলছে' })
          : i === nextIdx
            ? statusBadge(d, { state: 'pending', label: 'পরবর্তী' })
            : undefined,
        className: i === currentIdx ? 'is-urgent' : undefined,
      });
    });
    append(wrap, list(d, 'আজকের ক্লাস', ...items));
    return wrap;
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

/**
 * Bangla ordinals. NOT `formatCount(n) + 'ম'`, which is how the first draft
 * of this card produced "২ম পিরিয়ড" — the suffix differs per number and only
 * 1, 5, 7 and 8 take ম, so the bug is invisible in a screenshot of period one.
 * Beyond the table it degrades to the plain number rather than guessing a
 * suffix: a school with a fifteenth period is unlikely, and "১৫" is honest
 * where "১৫ম" would be invented grammar.
 */
const PERIOD_BN = [
  '', '১ম', '২য়', '৩য়', '৪র্থ', '৫ম', '৬ষ্ঠ', '৭ম', '৮ম', '৯ম', '১০ম',
  '১১তম', '১২তম',
];

export function periodBn(n: number): string {
  return PERIOD_BN[n] ?? formatCount(n, 'bn');
}

/**
 * 'HH:MM' in Bangla digits. Times are read, not cross-checked against a paper
 * register, so unlike a roll number they are localised — `formatIdentifier`
 * exists for the opposite case and this is deliberately not it.
 */
export function bnTime(hhmm: string): string {
  const [h, m] = hhmm.split(':');
  return `${formatCount(Number(h), 'bn')}:${(m ?? '00').replace(/\d/g,
    (x) => '০১২৩৪৫৬৭৮৯'[Number(x)])}`;
}

function bnDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${formatCount(d.getDate(), 'bn')} ${MONTHS[d.getMonth()]}`;
}
