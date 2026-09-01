/**
 * প্রতিষ্ঠান — what this school IS  (R-3 Part A · rebuilt in P6)
 *
 * ── P6: this screen and `home` were competing ─────────────────────────────
 *
 * P5 rebuilt the principal's `home` on the design system and left this one —
 * reading the SAME endpoint, showing the SAME figures — in the principal's
 * navigation in R-3 markup. Two dashboards, one of them worse.
 *
 * Whether a school wants two at all is an owner decision and is recorded in
 * PHASE_LOG rather than taken here. What P6 does is stop them competing, by
 * giving each a different QUESTION and ordering it accordingly:
 *
 *   `home`        what needs me now — attention, then what changed today
 *   `institution` what this school is — the standing shape, then today
 *                 measured against it, then the calendar and the record
 *
 * Same data, opposite order, and every heading names its question.
 *
 * ── Ordered by what changes today ──────────────────────────────────────
 * Attendance first, because it is the only number on the screen that is
 * different from yesterday's and the only one where being late to notice
 * costs something. Then what is waiting for this person, then the standing
 * counts, then quick actions.
 *
 * The brief lists nine blocks and also says "do not overload the dashboard".
 * The resolution: nothing here is analysis. Every figure is either today's, or
 * a queue with this person's name on it. Trend lines that look the same on
 * Tuesday and Wednesday belong in a report.
 *
 * ── "Nobody has taken attendance yet" is not 0% ────────────────────────
 * The API returns `percent: null` when no session has been marked, and this
 * screen renders that as a sentence rather than a zero. A dashboard that says
 * 0% at 8:05am is a dashboard that gets a head teacher onto the phone to a
 * class teacher who has done nothing wrong.
 *
 * ── The fee block is absent, not hidden ────────────────────────────────
 * `finance` is null in the response for a coordinator. There is no CSS here
 * doing the hiding, because a hidden card with the numbers still in the
 * response body is exactly the frontend-filtering pattern D13 rules out.
 */
import { formatBdt } from '../../../packages/ui-core/src/format.ts';
import type { Auth } from './auth.ts';
import { errorState, emptyState, bnNum, bnDate } from './view-states.ts';
import {
  pageHeader, sectionHeading, card, statRow, statCard, dataTable, statusBadge,
  listSkeleton, el, append,
} from './ui/index.ts';

export interface PrincipalDashboard {
  year: { id: string; label: string } | null;
  needsSetup: boolean;
  counts?: { students: number; teachers: number; sections: number; classes: number };
  attendanceToday?: {
    present: number; marked: number; percent: number | null;
    sessionsTaken: number; sectionsExpected: number;
  };
  absentToday?: {
    total: number;
    shown: { studentId: string; nameBn: string; rollNo: number; section: string; classBn: string }[];
  };
  upcomingExams?: { id: string; nameBn: string; startsOn: string; status: string }[];
  recentNotices?: { id: string; title: string; category: string; publishedAt: string | null; recipientCount: number }[];
  pending?: {
    sectionsWithoutClassTeacher: number;
    subjectsWithoutTeacher: number;
    examsAwaitingPublication: number;
    studentsWithoutSection: number;
  };
  finance?: { invoiced: string; collected: string; outstanding: string; unpaidCount: number } | null;
}

export interface PrincipalViewOptions {
  root: HTMLElement;
  doc: Document;
  auth: Auth;
  /** Navigation is the shell's job; this view only says where it wants to go. */
  onNavigate: (path: string) => void;
}

/** The quick actions from the brief, in the order a school day uses them. */
const ACTIONS: { path: string; glyph: string; labelBn: string }[] = [
  { path: 'academic',  glyph: 'layers',       labelBn: 'একাডেমিক কাঠামো' },
  { path: 'compose',   glyph: 'edit',         labelBn: 'নোটিশ পাঠান' },
  { path: 'attendance', glyph: 'check-square', labelBn: 'হাজিরা' },
  { path: 'publish',   glyph: 'award',        labelBn: 'ফলাফল প্রকাশ' },
  { path: 'invoices',  glyph: 'wallet',       labelBn: 'ইনভয়েস তৈরি' },
  { path: 'users',     glyph: 'users',        labelBn: 'ব্যবহারকারী' },
  { path: 'rollover',  glyph: 'repeat',       labelBn: 'বার্ষিক উন্নয়ন' },
  { path: 'adminsettings', glyph: 'settings', labelBn: 'সেটিংস' },
];

export class PrincipalView {
  private readonly o: PrincipalViewOptions;
  private data: PrincipalDashboard | null = null;
  private loading = true;
  private error = '';

  constructor(options: PrincipalViewOptions) {
    this.o = options;
    this.render();
    void this.load();
  }

  private async load(): Promise<void> {
    this.loading = true;
    this.error = '';
    this.render();
    try {
      const res = await this.o.auth.authedFetch('/api/v1/ops/dashboard');
      if (res.status === 403) {
        // Not an error to retry. The screen says so instead of offering a
        // button that will fail identically.
        this.error = 'এই পাতা দেখার অনুমতি আপনার নেই।';
        this.data = null;
        return;
      }
      if (!res.ok) throw new Error(String(res.status));
      this.data = (await res.json()) as PrincipalDashboard;
    } catch {
      this.error = 'তথ্য আনা যায়নি — সংযোগ পেলে আবার দেখা যাবে।';
    } finally {
      this.loading = false;
      this.render();
    }
  }

  private render(): void {
    const d = this.o.doc;
    const root = this.o.root;
    root.textContent = '';

    root.append(pageHeader(d, {
      title: 'প্রতিষ্ঠান',
      subtitle: this.data?.year
        ? `শিক্ষাবর্ষ ${this.data.year.label} — প্রতিষ্ঠানের সামগ্রিক চিত্র`
        : 'প্রতিষ্ঠানের সামগ্রিক চিত্র',
    }));

    if (this.loading) { root.append(listSkeleton(d, 4)); return; }
    if (this.error) {
      root.append(errorState(d, this.error,
        this.error.includes('অনুমতি') ? undefined : () => void this.load()));
      return;
    }
    if (!this.data) return;

    // Day one: the tenant exists but has no academic year. Not an error, and
    // not a dashboard of zeroes pretending to be a school with no students.
    if (this.data.needsSetup) {
      root.append(emptyState(d, {
        glyph: 'calendar',
        message: 'এখনো কোনো শিক্ষাবর্ষ তৈরি হয়নি। শিক্ষাবর্ষ তৈরি হলে এখানে প্রতিষ্ঠানের দৈনিক অবস্থা দেখা যাবে।',
        action: { label: 'একাডেমিক কাঠামো', onClick: () => this.o.onNavigate('academic') },
      }));
      return;
    }

    // The standing shape FIRST. `home` puts these last on purpose — they are
    // the same as yesterday — and that is exactly why they lead here: this
    // screen answers "what is this school", not "what needs me".
    this.renderCounts(root);
    this.renderAttendance(root);
    if (this.data.finance) this.renderFinance(root, this.data.finance);
    this.renderExams(root);
    this.renderNotices(root);
    this.renderPending(root);
    this.renderActions(root);
  }

  private heading(parent: HTMLElement, text: string): void {
    parent.append(sectionHeading(this.o.doc, { title: text }));
  }

  private renderAttendance(root: HTMLElement): void {
    const d = this.o.doc;
    const a = this.data?.attendanceToday;
    if (!a) return;
    this.heading(root, 'আজকের হাজিরা');

    // `percent: null` is "nobody has taken attendance yet", NOT 0%. A
    // dashboard reading ০% at 8:05 puts a head teacher on the phone to a
    // class teacher who has done nothing wrong.
    if (a.percent === null) {
      root.append(card(d, { title: 'এখনো নেওয়া হয়নি', glyph: 'clock', tone: 'info' },
        el(d, 'p', {
          className: 'ui-card-note',
          text: `আজ কোনো শ্রেণিতে হাজিরা নেওয়া হয়নি। ${bnNum(a.sectionsExpected)} টি সেকশনের নেওয়ার কথা।`,
        })));
      return;
    }

    const absent = this.data?.absentToday;
    root.append(statRow(d,
      statCard(d, {
        label: 'উপস্থিতি', value: `${bnNum(a.percent)}%`, glyph: 'check-square',
        note: `${bnNum(a.present)} / ${bnNum(a.marked)} জন`,
        tone: a.percent >= 90 ? 'success' : a.percent >= 75 ? 'warn' : 'accent2',
      }),
      statCard(d, {
        label: 'হাজিরা নেওয়া হয়েছে', value: `${bnNum(a.sessionsTaken)} / ${bnNum(a.sectionsExpected)}`,
        glyph: 'users', note: 'সেকশন',
        tone: a.sessionsTaken >= a.sectionsExpected ? 'success' : 'warn',
      }),
      statCard(d, {
        label: 'আজ অনুপস্থিত', value: `${bnNum(absent?.total ?? 0)} জন`,
        glyph: 'alert-triangle',
        tone: (absent?.total ?? 0) === 0 ? 'success' : 'warn',
      }),
    ));

    // The absentee list as a TABLE. It was `.roster-row` strips at 1077px,
    // where an office comparing roll numbers read one name per line across
    // the whole width.
    if (absent && absent.shown.length > 0) {
      root.append(dataTable(d, {
        caption: 'আজ অনুপস্থিত শিক্ষার্থী',
        rows: absent.shown,
        rowKey: (st) => st.studentId,
        columns: [
          { key: 'roll', header: 'রোল', mobile: 'meta', numeric: true,
            cell: (st) => bnNum(st.rollNo ?? '—'), width: '90px' },
          { key: 'name', header: 'নাম', mobile: 'title', cell: (st) => st.nameBn,
            width: 'minmax(0, 2fr)' },
          { key: 'class', header: 'শ্রেণি', mobile: 'subtitle',
            cell: (st) => st.classBn, width: 'minmax(0, 1.2fr)' },
          { key: 'section', header: 'সেকশন', mobile: 'meta',
            cell: (st) => st.section, width: '110px' },
        ],
      }));
      if (absent.total > absent.shown.length) {
        // Never imply the list is the whole list.
        root.append(el(d, 'p', {
          className: 'ui-card-note',
          text: `আরও ${bnNum(absent.total - absent.shown.length)} জন অনুপস্থিত — সম্পূর্ণ তালিকা শ্রেণিভিত্তিক হাজিরায়।`,
        }));
      }
    }
  }

  private renderPending(root: HTMLElement): void {
    const d = this.o.doc;
    const p = this.data?.pending;
    if (!p) return;

    const items: { n: number; labelBn: string; path: string }[] = [
      { n: p.sectionsWithoutClassTeacher, labelBn: 'সেকশনে শ্রেণি শিক্ষক নেই', path: 'academic' },
      { n: p.subjectsWithoutTeacher,      labelBn: 'বিষয়ে শিক্ষক নির্ধারণ হয়নি', path: 'academic' },
      { n: p.examsAwaitingPublication,    labelBn: 'পরীক্ষার ফলাফল প্রকাশ বাকি', path: 'publish' },
      { n: p.studentsWithoutSection,      labelBn: 'শিক্ষার্থীর সেকশন নেই',     path: 'academic' },
    ].filter((i) => i.n > 0);

    this.heading(root, 'কাঠামোয় যা অসম্পূর্ণ');
    // Only the non-zero rows, and one calm line when there are none. A row of
    // ০s is a wall a person reads to learn nothing.
    if (items.length === 0) {
      root.append(card(d, { title: 'কাঠামো সম্পূর্ণ', glyph: 'check-square', tone: 'success' },
        el(d, 'p', {
          className: 'ui-card-note',
          text: 'প্রতিটি সেকশনে শ্রেণি শিক্ষক আছে, প্রতিটি বিষয়ে শিক্ষক আছে, ' +
                'এবং সব শিক্ষার্থীর সেকশন নির্ধারিত।',
        })));
      return;
    }

    root.append(dataTable(d, {
      caption: 'কাঠামোয় যা অসম্পূর্ণ',
      rows: items,
      rowKey: (i) => i.labelBn,
      onRowClick: (i) => this.o.onNavigate(i.path),
      columns: [
        { key: 'what', header: 'কী বাকি', mobile: 'title', cell: (i) => i.labelBn,
          width: 'minmax(0, 3fr)' },
        { key: 'n', header: 'সংখ্যা', mobile: 'status', numeric: true,
          cell: (i) => statusBadge(d, { state: 'pending', label: `${bnNum(i.n)} টি` }),
          width: '130px' },
      ],
    }));
  }

  private renderCounts(root: HTMLElement): void {
    const d = this.o.doc;
    const c = this.data?.counts;
    if (!c) return;
    this.heading(root, 'এই প্রতিষ্ঠান');

    root.append(statRow(d,
      statCard(d, { label: 'শিক্ষার্থী', value: bnNum(c.students), glyph: 'users' }),
      statCard(d, { label: 'শিক্ষক ও কর্মী', value: bnNum(c.teachers), glyph: 'user', tone: 'info' }),
      statCard(d, { label: 'সেকশন', value: bnNum(c.sections), glyph: 'layers', tone: 'accent2' }),
      statCard(d, { label: 'শ্রেণি', value: bnNum(c.classes), glyph: 'book-open', tone: 'accent2' }),
    ));
  }

  private renderFinance(root: HTMLElement, f: NonNullable<PrincipalDashboard['finance']>): void {
    const d = this.o.doc;
    // Named for the PERIOD it covers. The figures are the academic year's,
    // not the month's, and a label that does not say so is a wrong number
    // dressed as a right one — the exact defect P5 found on `home`.
    this.heading(root, 'এই শিক্ষাবর্ষের ফি');
    // Amounts stay as the server's decimal strings — never parsed into a JS
    // number on the way to a screen a school reconciles against.
    root.append(statRow(d,
      statCard(d, {
        label: 'মোট বিল', value: formatBdt(f.invoiced), glyph: 'wallet',
      }),
      statCard(d, {
        label: 'আদায়', value: formatBdt(f.collected), glyph: 'check-square', tone: 'success',
      }),
      statCard(d, {
        label: 'বকেয়া', value: formatBdt(f.outstanding), glyph: 'alert-triangle',
        tone: Number(f.outstanding) > 0 ? 'warn' : 'success',
        note: `${bnNum(f.unpaidCount)} টি ইনভয়েস অপরিশোধিত`,
      }),
    ));
  }

  private renderExams(root: HTMLElement): void {
    const d = this.o.doc;
    const exams = this.data?.upcomingExams ?? [];
    if (exams.length === 0) return;
    this.heading(root, 'পরীক্ষা');
    root.append(dataTable(d, {
      caption: 'আসন্ন ও চলমান পরীক্ষা',
      rows: exams,
      rowKey: (e) => e.id,
      columns: [
        { key: 'name', header: 'পরীক্ষা', mobile: 'title', cell: (e) => e.nameBn,
          width: 'minmax(0, 2.4fr)' },
        { key: 'starts', header: 'শুরু', mobile: 'subtitle', cell: (e) => bnDate(e.startsOn),
          width: 'minmax(0, 1.4fr)' },
        { key: 'status', header: 'অবস্থা', mobile: 'status', width: '140px',
          cell: (e) => statusBadge(d, {
            state: e.status === 'published' ? 'published' : 'pending',
            label: e.status === 'published' ? 'প্রকাশিত' : 'চলমান',
          }) },
      ],
    }));
  }

  private renderNotices(root: HTMLElement): void {
    const d = this.o.doc;
    const notices = this.data?.recentNotices ?? [];
    this.heading(root, 'সাম্প্রতিক নোটিশ');
    if (notices.length === 0) {
      root.append(emptyState(d, {
        message: 'এখনো কোনো নোটিশ প্রকাশ করা হয়নি।',
        action: { label: 'নোটিশ পাঠান', onClick: () => this.o.onNavigate('compose') },
      }));
      return;
    }
    root.append(dataTable(d, {
      caption: 'সাম্প্রতিক নোটিশ',
      rows: notices,
      rowKey: (n) => n.id,
      onRowClick: () => this.o.onNavigate('inbox'),
      columns: [
        { key: 'title', header: 'নোটিশ', mobile: 'title', cell: (n) => n.title,
          width: 'minmax(0, 2.6fr)' },
        { key: 'when', header: 'প্রকাশ', mobile: 'subtitle',
          cell: (n) => bnDate(n.publishedAt), width: 'minmax(0, 1.4fr)' },
        // The reach is the number the author remembers, so it is a column
        // rather than a clause.
        { key: 'reach', header: 'কতজনের কাছে', mobile: 'meta', numeric: true,
          cell: (n) => `${bnNum(n.recipientCount)} জন`, width: 'minmax(0, 1.2fr)' },
      ],
    }));
  }

  private renderActions(root: HTMLElement): void {
    const d = this.o.doc;
    this.heading(root, 'দ্রুত কাজ');
    const grid = el(d, 'div', { className: 'ui-card-grid' });
    for (const a of ACTIONS) {
      append(grid, card(d, {
        title: a.labelBn, glyph: a.glyph, variant: 'interactive', headingLevel: 3,
        onClick: () => this.o.onNavigate(a.path),
      }));
    }
    root.append(grid);
  }
}
