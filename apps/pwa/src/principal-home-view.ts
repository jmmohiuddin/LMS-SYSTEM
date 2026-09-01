/**
 * প্রতিষ্ঠান — the principal's dashboard.  (P5)
 *
 * What a head teacher opens at 8am, standing in a corridor with a phone, and
 * what the same person reads at 10am on a desktop in the office. Those are
 * different screens with the same content, which is what "genuinely desktop
 * and genuinely mobile" means here — not one layout scaled.
 *
 * ── Three questions, in order, above the fold ──────────────────────────────
 * The brief asks the top of this screen to answer: what needs attention, what
 * changed, what can I act on. So:
 *
 *   1. **What needs attention** — the pending queue, and only when it is not
 *      empty. Four kinds of unfinished setup, each a link to the screen that
 *      finishes it. An empty queue renders as one calm line, not as four
 *      zeroes: "everything is assigned" is information, four ০s is noise.
 *   2. **What changed** — today's attendance, and today's absences. These are
 *      the only figures on the screen that differ from yesterday's.
 *   3. **What I can act on** — exams awaiting publication, recent notices,
 *      the fee position.
 *
 * Everything else is a standing count, and standing counts go last.
 *
 * ── What is deliberately NOT here ──────────────────────────────────────────
 * No charts. 04-UIUX prohibits client-side charting on the device floor, and
 * the brief says not to invent analytics to fill space. Nothing on this screen
 * is a trend: every figure is either today's, or a queue with this person's
 * name on it. A line that looks the same on Tuesday and Wednesday belongs in a
 * report, and reports have their own screen.
 *
 * No platform or subscription information of any kind. School tuition is not
 * ShikhonBD's own commercial relationship with the school, D16 puts that in
 * the Platform Console, and P5 must not blur the two.
 *
 * ── Two content decisions carried over from R-3, because they were right ───
 * **"Nobody has taken attendance yet" is not 0%.** The API returns
 * `percent: null` until a session is marked, and a dashboard that renders that
 * as 0% at 8:05 puts a head teacher on the phone to a class teacher who has
 * done nothing wrong.
 *
 * **The fee block is absent, not hidden.** `finance` is null in the response
 * for a coordinator — there is no CSS here doing the hiding, because a hidden
 * card with the numbers still in the response body is the frontend-filtering
 * pattern D13 rules out.
 */
import type { Auth } from './auth.ts';
import {
  el, append, card, statCard, statRow, button, pageHeader, sectionHeading,
  statusBadge, list, listItem, listSkeleton, emptyState, errorState,
  permissionState, permissionMessage, humanError,
} from './ui/index.ts';
import { refuseUnlessOk, isDenied, statusOf } from './http-status.ts';
import { formatCount, formatBdt, formatIdentifier } from '../../../packages/ui-core/src/format.ts';

const bn = (n: number): string => formatCount(n, 'bn');

export interface DashboardPayload {
  year: { id: string; label: string } | null;
  needsSetup: boolean;
  counts?: { students: number; teachers: number; sections: number; classes: number };
  attendanceToday?: {
    present: number; marked: number; percent: number | null;
    sessionsTaken: number; sectionsExpected: number;
  };
  absentToday?: {
    total: number;
    shown: Array<{
      studentId: string; nameBn: string; rollNo: number;
      section: string | null; classBn: string | null;
    }>;
  };
  upcomingExams?: Array<{ id: string; nameBn: string; startsOn: string; status: string }>;
  recentNotices?: Array<{
    id: string; title: string; category: string;
    publishedAt: string; recipientCount: number;
  }>;
  pending?: {
    sectionsWithoutClassTeacher: number;
    subjectsWithoutTeacher: number;
    examsAwaitingPublication: number;
    studentsWithoutSection: number;
  };
  /**
   * Money as STRINGS, all the way from `numeric(12,2)`. The endpoint sums the
   * outstanding total in PostgreSQL rather than subtracting in JS on purpose —
   * a school's fee balance must not round-trip through a float — and the field
   * names here are the endpoint's, checked against it. The first draft of this
   * screen invented `collectedThisMonth` and `invoicesDue`, and rendered
   * "undefinedটি ইনভয়েস বাকি" on the principal's dashboard.
   */
  finance?: {
    invoiced: string; collected: string; outstanding: string; unpaidCount: number;
  } | null;
}

export interface PrincipalHomeOptions {
  root: HTMLElement;
  doc: Document;
  auth: Auth;
  displayName?: string;
  go: (path: string) => void;
  now?: () => Date;
}

export class PrincipalHomeView {
  private readonly o: PrincipalHomeOptions;
  private data: DashboardPayload | null = null;
  private loading = true;
  private denied = false;
  private errText = '';

  constructor(options: PrincipalHomeOptions) {
    this.o = options;
    this.render();
    void this.load();
  }

  private now(): Date { return this.o.now ? this.o.now() : new Date(); }

  private async load(): Promise<void> {
    try {
      const res = await this.o.auth.authedFetch('/api/v1/ops/dashboard');
      refuseUnlessOk(res);
      this.data = (await res.json()) as DashboardPayload;
      this.denied = false;
      this.errText = '';
    } catch (err) {
      if (isDenied(err)) { this.denied = true; this.data = null; }
      else this.errText = humanError(navigator.onLine ? null : 'offline', statusOf(err));
    } finally {
      this.loading = false;
      this.render();
    }
  }

  /* ── render ─────────────────────────────────────────────────────────── */

  private render(): void {
    const d = this.o.doc;
    const root = this.o.root;
    root.textContent = '';
    root.setAttribute('lang', 'bn');

    append(root, pageHeader(d, {
      title: greeting(this.now()) + (this.o.displayName ? `, ${this.o.displayName}` : ''),
      subtitle: this.data?.year
        ? `${todayBn(this.now())} · শিক্ষাবর্ষ ${this.data.year.label}`
        : todayBn(this.now()),
    }));

    if (this.denied) {
      append(root, permissionState(d, {
        message: permissionMessage('প্রতিষ্ঠানের সারসংক্ষেপ'),
        contact: 'আইটি অ্যাডমিন',
      }));
      return;
    }
    if (this.loading && !this.data) { append(root, listSkeleton(d, 5)); return; }
    if (this.errText && !this.data) {
      append(root, errorState(d, this.errText, () => {
        this.errText = ''; this.loading = true; this.render(); void this.load();
      }));
      return;
    }
    if (!this.data) return;

    // A school with no academic year cannot be summarised, and saying "০ জন
    // শিক্ষার্থী" would be a true number that reads as a broken screen.
    if (this.data.needsSetup) {
      append(root, emptyState(d, {
        message: 'এই বছরের শিক্ষাবর্ষ এখনো তৈরি হয়নি — সেটি না থাকলে শ্রেণি, '
          + 'সেকশন বা ভর্তি কিছুই শুরু করা যায় না।',
        action: { label: 'একাডেমিক কাঠামো', onClick: () => this.o.go('academic') },
      }));
      return;
    }

    append(root,
      this.attention(),
      this.today(),
      this.actionable(),
      this.standing());
  }

  /** 1. What needs attention. Absent entirely when there is nothing. */
  private attention(): HTMLElement | null {
    const d = this.o.doc;
    const p = this.data?.pending;
    if (!p) return null;

    const items: Array<[number, string, string, string]> = [
      [p.sectionsWithoutClassTeacher, 'শ্রেণি শিক্ষক নেই',
       'সেকশনে শ্রেণি শিক্ষক নির্ধারণ করা হয়নি', 'academic'],
      [p.subjectsWithoutTeacher, 'বিষয় শিক্ষক নেই',
       'বিষয়ে শিক্ষক নির্ধারণ করা হয়নি', 'academic'],
      [p.studentsWithoutSection, 'সেকশনে নেই',
       'শিক্ষার্থী কোনো সেকশনে নেই', 'students'],
      [p.examsAwaitingPublication, 'ফলাফল প্রকাশ বাকি',
       'পরীক্ষার ফলাফল এখনো প্রকাশ হয়নি', 'publish'],
    ];
    const open = items.filter(([n]) => n > 0);

    const wrap = el(d, 'section');
    append(wrap, sectionHeading(d, { title: 'যা নজর দেওয়া দরকার' }));

    if (open.length === 0) {
      // One calm line, not four zeroes. "Everything is assigned" is
      // information; a row of ০s is a wall a person has to read to learn
      // nothing.
      append(wrap, card(d, {
        title: 'সব কিছু নির্ধারিত আছে',
        glyph: 'check-square', tone: 'success',
      }, el(d, 'p', { className: 'sh-note',
        text: 'শিক্ষক, সেকশন ও ফলাফল প্রকাশ — কোথাও কিছু বাকি নেই।' })));
      return wrap;
    }

    append(wrap, list(d, 'যা নজর দেওয়া দরকার', ...open.map(([n, label, detail, route]) =>
      listItem(d, {
        title: `${bn(n)} ${label}`,
        subtitle: `${bn(n)}টি ${detail}`,
        glyph: 'alert-triangle',
        status: statusBadge(d, { state: 'due', label: 'বাকি' }),
        onClick: () => this.o.go(route),
        className: 'is-urgent',
      }))));
    return wrap;
  }

  /** 2. What changed today. */
  private today(): HTMLElement {
    const d = this.o.doc;
    const a = this.data?.attendanceToday;
    const absent = this.data?.absentToday;
    const wrap = el(d, 'section');
    append(wrap, sectionHeading(d, { title: 'আজকের অবস্থা' }));

    const taken = a ? `${bn(a.sessionsTaken)} / ${bn(a.sectionsExpected)} সেকশন` : undefined;
    append(wrap, statRow(d,
      statCard(d, {
        label: 'আজকের উপস্থিতি',
        // null is "nobody has taken it yet" and is a different statement from
        // 0%. The screen must not render them the same way.
        value: a?.percent === null || a?.percent === undefined
          ? 'এখনো নেওয়া হয়নি'
          : `${bn(a.percent)}%`,
        note: a?.percent === null || a?.percent === undefined
          ? taken
          : `${bn(a.present)} / ${bn(a.marked)} জন · ${taken}`,
        glyph: 'check-square',
        tone: a?.percent === null || a?.percent === undefined ? 'info'
          : a.percent >= 90 ? 'success' : a.percent >= 75 ? 'warn' : 'accent2',
        onClick: () => this.o.go('academic'),
      }),
      statCard(d, {
        label: 'আজ অনুপস্থিত',
        value: absent ? `${bn(absent.total)} জন` : '—',
        note: absent && absent.total > absent.shown.length
          ? `প্রথম ${bn(absent.shown.length)} জন নিচে`
          : undefined,
        glyph: 'user-x',
        tone: (absent?.total ?? 0) === 0 ? 'success' : 'warn',
      })));

    if (absent && absent.shown.length > 0) {
      append(wrap, list(d, 'আজ অনুপস্থিত', ...absent.shown.map((s) => listItem(d, {
        title: s.nameBn,
        // Roll stays Latin — it is an identifier, read down a phone to the
        // class teacher, not a count.
        subtitle: [s.classBn, s.section].filter(Boolean).join(' — ')
          + ` · রোল ${formatIdentifier(s.rollNo)}`,
        glyph: 'user',
      }))));
    }
    return wrap;
  }

  /** 3. What can be acted on: exams, notices, money. */
  private actionable(): HTMLElement {
    const d = this.o.doc;
    const wrap = el(d, 'div', { className: 'ph-cols' });

    const exams = this.data?.upcomingExams ?? [];
    const examCol = el(d, 'section');
    append(examCol, sectionHeading(d, {
      title: 'পরীক্ষা',
      action: button(d, { label: 'ফলাফল প্রকাশ', variant: 'ghost', size: 'sm',
        onClick: () => this.o.go('publish') }),
    }));
    append(examCol, exams.length === 0
      ? emptyState(d, { message: 'সামনে কোনো পরীক্ষা নির্ধারিত নেই।' })
      : list(d, 'আসন্ন পরীক্ষা', ...exams.map((e) => listItem(d, {
          title: e.nameBn,
          subtitle: bnDate(e.startsOn),
          glyph: 'clipboard',
          status: statusBadge(d, EXAM_STATE[e.status] ?? { state: 'pending', label: e.status }),
          onClick: () => this.o.go('publish'),
        }))));
    append(wrap, examCol);

    const notices = this.data?.recentNotices ?? [];
    const noticeCol = el(d, 'section');
    append(noticeCol, sectionHeading(d, {
      title: 'সাম্প্রতিক নোটিশ',
      action: button(d, { label: 'সব দেখুন', variant: 'ghost', size: 'sm',
        onClick: () => this.o.go('inbox') }),
    }));
    append(noticeCol, notices.length === 0
      ? emptyState(d, { message: 'সম্প্রতি কোনো নোটিশ প্রকাশ হয়নি।' })
      : list(d, 'সাম্প্রতিক নোটিশ', ...notices.map((n) => listItem(d, {
          title: n.title,
          subtitle: `${bnDate(n.publishedAt)} · ${bn(n.recipientCount)} জনের কাছে`,
          glyph: 'bell',
          onClick: () => this.o.go('inbox'),
        }))));
    append(wrap, noticeCol);

    // Absent, not hidden, for a role the server does not send it to.
    const f = this.data?.finance;
    if (f) {
      const money = el(d, 'section');
      append(money, sectionHeading(d, {
        title: 'ফি',
        action: button(d, { label: 'ফি ব্যবস্থাপনা', variant: 'ghost', size: 'sm',
          onClick: () => this.o.go('fees') }),
      }));
      append(money, statRow(d,
        statCard(d, {
          label: 'মোট বকেয়া',
          value: formatBdt(Number(f.outstanding)),
          note: `${bn(f.unpaidCount)}টি ইনভয়েস বাকি`,
          glyph: 'wallet',
          tone: Number(f.outstanding) > 0 ? 'warn' : 'success',
          onClick: () => this.o.go('fees'),
        }),
        statCard(d, {
          // The academic YEAR, not the month: that is the window the endpoint
          // sums over, and a label that says otherwise is a wrong number
          // dressed as a right one.
          label: 'এ বছর আদায়',
          value: formatBdt(Number(f.collected)),
          note: `মোট ইনভয়েস ${formatBdt(Number(f.invoiced))}`,
          glyph: 'trending-up', tone: 'success',
        })));
      append(wrap, money);
    }
    return wrap;
  }

  /** 4. Standing counts. Last, because they are the same as yesterday. */
  private standing(): HTMLElement {
    const d = this.o.doc;
    const c = this.data?.counts;
    const wrap = el(d, 'section');
    append(wrap, sectionHeading(d, { title: 'প্রতিষ্ঠান' }));
    append(wrap, statRow(d,
      statCard(d, { label: 'শিক্ষার্থী', value: bn(c?.students ?? 0),
        glyph: 'users', tone: 'primary', onClick: () => this.o.go('students') }),
      statCard(d, { label: 'শিক্ষক', value: bn(c?.teachers ?? 0),
        glyph: 'user', tone: 'info', onClick: () => this.o.go('users') }),
      statCard(d, { label: 'শ্রেণি', value: bn(c?.classes ?? 0),
        glyph: 'layers', tone: 'accent2', onClick: () => this.o.go('academic') }),
      statCard(d, { label: 'সেকশন', value: bn(c?.sections ?? 0),
        glyph: 'grid', tone: 'primary', onClick: () => this.o.go('academic') })));
    return wrap;
  }
}

const EXAM_STATE: Record<string, { state: 'due' | 'pending' | 'published'; label: string }> = {
  scheduled: { state: 'pending', label: 'নির্ধারিত' },
  ongoing: { state: 'due', label: 'চলছে' },
  marking: { state: 'due', label: 'নম্বর দেওয়া হচ্ছে' },
  published: { state: 'published', label: 'প্রকাশিত' },
};

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
