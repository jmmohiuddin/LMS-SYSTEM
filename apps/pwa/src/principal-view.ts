/**
 * প্রতিষ্ঠান — the principal's dashboard  (R-3, Part A)
 *
 * What a head teacher opens at 8am on a phone, standing in a corridor.
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
import type { Auth } from './auth.ts';
import { iconSvg } from './icon.ts';
import { skeleton, errorState, emptyState, bnNum } from './view-states.ts';

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

    const header = d.createElement('header');
    header.className = 'page-header';
    const h1 = d.createElement('h1');
    h1.textContent = 'প্রতিষ্ঠান';
    header.append(h1);
    const sub = d.createElement('p');
    sub.className = 'page-sub';
    sub.textContent = this.data?.year ? `শিক্ষাবর্ষ ${this.data.year.label}` : 'আজকের অবস্থা';
    header.append(sub);
    root.append(header);

    if (this.loading) { root.append(skeleton(d, 4)); return; }
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

    this.renderAttendance(root);
    this.renderPending(root);
    this.renderCounts(root);
    if (this.data.finance) this.renderFinance(root, this.data.finance);
    this.renderExams(root);
    this.renderNotices(root);
    this.renderActions(root);
  }

  private heading(parent: HTMLElement, text: string): void {
    const h = this.o.doc.createElement('h2');
    h.className = 'section-heading';
    h.textContent = text;
    parent.append(h);
  }

  private renderAttendance(root: HTMLElement): void {
    const d = this.o.doc;
    const a = this.data?.attendanceToday;
    if (!a) return;
    this.heading(root, 'আজকের হাজিরা');

    const card = d.createElement('div');
    card.className = 'card';
    card.style.margin = '0 var(--s-4) var(--s-3)';

    if (a.percent === null) {
      // The distinction that matters most on this screen.
      const p = d.createElement('p');
      p.className = 'att-sub';
      p.textContent = 'আজ এখনো কোনো শ্রেণিতে হাজিরা নেওয়া হয়নি।';
      card.append(p);
    } else {
      const big = d.createElement('p');
      big.className = 'result-gpa';
      big.textContent = `${bnNum(a.percent)}%`;
      const meta = d.createElement('p');
      meta.className = 'att-sub';
      meta.textContent =
        `${bnNum(a.present)} / ${bnNum(a.marked)} উপস্থিত · ` +
        `${bnNum(a.sessionsTaken)} টি ক্লাসে নেওয়া হয়েছে`;
      card.append(big, meta);

      const absent = this.data?.absentToday;
      if (absent && absent.total > 0) {
        const list = d.createElement('ul');
        list.className = 'roster-list';
        for (const s of absent.shown) {
          const li = d.createElement('li');
          li.className = 'roster-row';
          const roll = d.createElement('span');
          roll.className = 'roster-roll';
          roll.textContent = bnNum(s.rollNo ?? '—');
          const name = d.createElement('span');
          name.className = 'roster-name';
          name.textContent = `${s.nameBn} · ${s.classBn} ${s.section}`;
          li.append(roll, name);
          list.append(li);
        }
        card.append(list);
        if (absent.total > absent.shown.length) {
          // Never imply the list is the whole list.
          const more = d.createElement('p');
          more.className = 'att-sub';
          more.textContent = `আরও ${bnNum(absent.total - absent.shown.length)} জন অনুপস্থিত`;
          card.append(more);
        }
      } else {
        const none = d.createElement('p');
        none.className = 'att-sub';
        none.textContent = 'কেউ অনুপস্থিত নেই।';
        card.append(none);
      }
    }
    root.append(card);
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

    this.heading(root, 'আপনার সিদ্ধান্তের অপেক্ষায়');
    if (items.length === 0) {
      const ok = d.createElement('p');
      ok.className = 'att-sub';
      ok.style.padding = '0 var(--s-4) var(--s-3)';
      ok.textContent = 'কিছু বাকি নেই।';
      root.append(ok);
      return;
    }

    const list = d.createElement('div');
    list.className = 'system-list';
    for (const i of items) {
      const row = d.createElement('button');
      row.type = 'button';
      row.className = 'system-row';
      const title = d.createElement('span');
      title.className = 'system-title';
      title.textContent = `${bnNum(i.n)} — ${i.labelBn}`;
      row.append(title);
      row.addEventListener('click', () => this.o.onNavigate(i.path));
      list.append(row);
    }
    root.append(list);
  }

  private renderCounts(root: HTMLElement): void {
    const d = this.o.doc;
    const c = this.data?.counts;
    if (!c) return;
    this.heading(root, 'প্রতিষ্ঠান');

    const grid = d.createElement('div');
    grid.className = 'card-grid secondary-grid';
    for (const [labelBn, n] of [
      ['শিক্ষার্থী', c.students], ['শিক্ষক', c.teachers],
      ['সেকশন', c.sections], ['শ্রেণি', c.classes],
    ] as [string, number][]) {
      const tile = d.createElement('div');
      tile.className = 'card';
      const v = d.createElement('p');
      v.className = 'result-stat-value';
      v.textContent = bnNum(n);
      const l = d.createElement('p');
      l.className = 'result-stat-label';
      l.textContent = labelBn;
      tile.append(v, l);
      grid.append(tile);
    }
    root.append(grid);
  }

  private renderFinance(root: HTMLElement, f: NonNullable<PrincipalDashboard['finance']>): void {
    const d = this.o.doc;
    this.heading(root, 'ফি');
    const card = d.createElement('div');
    card.className = 'card';
    card.style.margin = '0 var(--s-4) var(--s-3)';
    for (const [labelBn, v] of [
      ['বকেয়া', f.outstanding], ['আদায়', f.collected], ['মোট বিল', f.invoiced],
    ] as [string, string][]) {
      const row = d.createElement('p');
      row.className = 'fees-row';
      // Amounts stay as the server's decimal strings — never parsed into a
      // JS number on the way to a screen a school reconciles against.
      row.textContent = `${labelBn}: ৳ ${bnNum(v)}`;
      card.append(row);
    }
    const n = d.createElement('p');
    n.className = 'att-sub';
    n.textContent = `${bnNum(f.unpaidCount)} টি ইনভয়েস অপরিশোধিত`;
    card.append(n);
    root.append(card);
  }

  private renderExams(root: HTMLElement): void {
    const d = this.o.doc;
    const exams = this.data?.upcomingExams ?? [];
    if (exams.length === 0) return;
    this.heading(root, 'পরীক্ষা');
    const list = d.createElement('div');
    list.className = 'system-list';
    for (const e of exams) {
      const row = d.createElement('div');
      row.className = 'system-row';
      const t = d.createElement('span');
      t.className = 'system-title';
      t.textContent = e.nameBn;
      const s = d.createElement('span');
      s.className = 'status-chip';
      if (e.status === 'published') s.setAttribute('data-state', 'success');
      s.textContent = e.status === 'published' ? 'প্রকাশিত' : 'চলমান';
      row.append(t, s);
      list.append(row);
    }
    root.append(list);
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
    const list = d.createElement('div');
    list.className = 'system-list';
    for (const n of notices) {
      const row = d.createElement('button');
      row.type = 'button';
      row.className = 'system-row';
      const t = d.createElement('span');
      t.className = 'system-title';
      t.textContent = n.title;
      const c = d.createElement('span');
      c.className = 'system-desc';
      c.textContent = `${bnNum(n.recipientCount)} জনের কাছে`;
      row.append(t, c);
      row.addEventListener('click', () => this.o.onNavigate('inbox'));
      list.append(row);
    }
    root.append(list);
  }

  private renderActions(root: HTMLElement): void {
    const d = this.o.doc;
    this.heading(root, 'দ্রুত কাজ');
    const grid = d.createElement('div');
    grid.className = 'card-grid secondary-grid';
    for (const a of ACTIONS) {
      const btn = d.createElement('button');
      btn.type = 'button';
      btn.className = 'home-card';
      const g = d.createElement('span');
      g.className = 'home-glyph';
      g.setAttribute('aria-hidden', 'true');
      g.innerHTML = iconSvg(a.glyph);
      const t = d.createElement('span');
      t.className = 'home-title';
      t.textContent = a.labelBn;
      btn.append(g, t);
      btn.addEventListener('click', () => this.o.onNavigate(a.path));
      grid.append(btn);
    }
    root.append(grid);
  }
}
