/**
 * My results — F-805, wireframe §6.5
 *
 * Rebuilt from an accordion of exams to the layout the wireframe specifies:
 * an exam selector, one summary card, a component-breakdown table, the
 * optional-subject footnote, and a trend across terms.
 *
 * Three rules from §6.5, each load-bearing:
 *
 *   The component breakdown (CQ / MCQ / practical / CA) is ALWAYS visible.
 *   It is the board's own structure. A single total hides which half of the
 *   paper went wrong, which is the only actionable thing on the screen.
 *
 *   The optional-subject footnote is MANDATORY — "the rule most commonly
 *   misunderstood, and showing it prevents a support call." A student
 *   seeing a 64 counted differently from their other 64 needs the sentence
 *   next to it, not in a help article.
 *
 *   Results are strictly read-only and never visible before the school
 *   publishes. That is enforced by results_scope in the database, not here;
 *   this view could not show an unpublished result if it tried.
 */
import type { Auth } from './auth.ts';
import { formatCount, formatIdentifier } from '../../../packages/ui-core/src/format.ts';

interface SubjectRow {
  subjectBn: string;
  cqMarks: string | null;
  mcqMarks: string | null;
  practicalMarks: string | null;
  caMarks: string | null;
  totalMarks: string | null;
  gradeLetter: string | null;
  gradePoint: string | null;
  isAbsent: boolean;
  componentFailed?: boolean;
  requirementType: string | null;
}

interface Result {
  examId: string;
  examNameBn: string;
  examType: string;
  totalMarks: string | null;
  totalMax: string | null;
  percentage: string | null;
  gpa: string | null;
  letterGrade: string | null;
  subjectsFailed: number;
  isPass: boolean;
  rankInSection: number | null;
  publishedAt: string | null;
  subjects: SubjectRow[];
}

const CACHE_KEY = 'shikhon_results_cache';

const bn = (n: number | string | null | undefined): string =>
  n === null || n === undefined || n === '' ? '—' : formatCount(Number(n), 'bn');

/** Marks and GPA render as written on the tabulation sheet — no rounding. */
const mark = (s: string | null): string =>
  s === null || s === '' ? '—' : formatCount(Number(Number(s).toFixed(Number(s) % 1 ? 2 : 0)), 'bn');

export interface ResultsViewOptions {
  root: HTMLElement;
  doc: Document;
  auth: Auth;
}

export class ResultsView {
  private readonly o: ResultsViewOptions;
  private results: Result[] = [];
  private selected: string | null = null;
  private loading = true;
  private offline = false;

  constructor(options: ResultsViewOptions) {
    this.o = options;
    this.results = this.readCache();
    this.selected = this.results[0]?.examId ?? null;
    this.loading = this.results.length === 0;
    this.render();
    void this.load();
  }

  private readCache(): Result[] {
    try {
      const raw = localStorage.getItem(CACHE_KEY);
      const p = raw ? (JSON.parse(raw) as Result[]) : [];
      return Array.isArray(p) ? p : [];
    } catch { return []; }
  }

  private async load(): Promise<void> {
    try {
      const res = await this.o.auth.authedFetch('/api/v1/academics/results');
      if (!res.ok) throw new Error(String(res.status));
      const body = (await res.json()) as { results?: Result[] };
      this.results = body.results ?? [];
      this.selected = this.selected && this.results.some((r) => r.examId === this.selected)
        ? this.selected
        : this.results[0]?.examId ?? null;
      this.offline = false;
      try { localStorage.setItem(CACHE_KEY, JSON.stringify(this.results)); } catch { /* quota */ }
    } catch {
      if (this.results.length > 0) this.offline = true;
    } finally {
      this.loading = false;
      this.render();
    }
  }

  private render(): void {
    const d = this.o.doc;
    const root = this.o.root;
    root.textContent = '';
    root.setAttribute('lang', 'bn');

    const header = d.createElement('header');
    header.className = 'page-header page-header-row';
    const h1 = d.createElement('h1');
    h1.textContent = 'ফলাফল';
    header.append(h1);

    // The exam selector from §6.5's "[ প্রথম সাময়িক ▾ ]". A <select> rather
    // than a custom menu: it is one control, it works offline, and the
    // native picker is the one control every Android user already knows.
    if (this.results.length > 1) {
      const sel = d.createElement('select');
      sel.className = 'exam-select';
      sel.setAttribute('aria-label', 'পরীক্ষা বেছে নিন');
      for (const r of this.results) {
        const opt = d.createElement('option');
        opt.value = r.examId;
        opt.textContent = r.examNameBn;
        if (r.examId === this.selected) opt.selected = true;
        sel.append(opt);
      }
      sel.addEventListener('change', () => { this.selected = sel.value; this.render(); });
      header.append(sel);
    }
    root.append(header);

    if (this.offline) {
      const b = d.createElement('p');
      b.className = 'inline-notice';
      b.textContent = 'অফলাইন — সংরক্ষিত ফলাফল দেখানো হচ্ছে';
      root.append(b);
    }

    if (this.loading && this.results.length === 0) { this.skeleton(root); return; }
    if (this.results.length === 0) { this.empty(root); return; }

    const r = this.results.find((x) => x.examId === this.selected) ?? this.results[0];
    root.append(this.summary(r));
    root.append(this.table(r));
    const note = this.optionalFootnote(r);
    if (note) root.append(note);
    if (this.results.length > 1) root.append(this.trend());
  }

  /** GPA, rank, publication date and the mark-sheet download (§6.5). */
  private summary(r: Result): HTMLElement {
    const d = this.o.doc;
    const card = d.createElement('section');
    card.className = 'card result-summary';

    const row = d.createElement('div');
    row.className = 'result-summary-row';

    const gpaBox = d.createElement('div');
    const gpaLabel = d.createElement('span');
    gpaLabel.className = 'result-stat-label';
    gpaLabel.textContent = 'GPA';
    const gpaVal = d.createElement('span');
    gpaVal.className = 'result-stat-value';
    // GPA is an identifier-like figure a guardian cross-checks against a
    // printed mark sheet, so it stays Latin (ui-core's numeral policy).
    gpaVal.textContent = r.gpa ? formatIdentifier(Number(r.gpa).toFixed(2)) : '—';
    gpaBox.append(gpaLabel, gpaVal);
    row.append(gpaBox);

    if (r.rankInSection) {
      const rankBox = d.createElement('div');
      const rl = d.createElement('span');
      rl.className = 'result-stat-label';
      rl.textContent = 'মেধাক্রম';
      const rv = d.createElement('span');
      rv.className = 'result-stat-value';
      rv.textContent = bn(r.rankInSection);
      rankBox.append(rl, rv);
      row.append(rankBox);
    }

    const gradeBox = d.createElement('div');
    const gl = d.createElement('span');
    gl.className = 'result-stat-label';
    gl.textContent = 'গ্রেড';
    const gv = d.createElement('span');
    gv.className = 'result-stat-value';
    gv.textContent = r.letterGrade ?? '—';
    gradeBox.append(gl, gv);
    row.append(gradeBox);
    card.append(row);

    if (r.publishedAt) {
      const pub = d.createElement('p');
      pub.className = 'result-published';
      pub.textContent = `প্রকাশিত: ${new Date(r.publishedAt).toLocaleDateString('bn-BD', {
        day: 'numeric', month: 'long', year: 'numeric',
      })}`;
      card.append(pub);
    }

    if (!r.isPass) {
      // Failure is stated in words, with a count — never as a red cell the
      // reader has to interpret (F-812).
      const chip = d.createElement('span');
      chip.className = 'status-chip';
      chip.dataset.state = 'danger';
      chip.textContent = r.subjectsFailed > 0
        ? `${bn(r.subjectsFailed)} বিষয়ে অকৃতকার্য`
        : 'অকৃতকার্য';
      card.append(chip);
    }
    return card;
  }

  /**
   * The component table. `data-table` from the component vocabulary (§3):
   * dense, horizontally scrollable, first column frozen — because six
   * columns of marks do not fit 360px and the subject name is the one you
   * must keep in view while scrolling the rest.
   */
  private table(r: Result): HTMLElement {
    const d = this.o.doc;
    const wrap = d.createElement('div');
    wrap.className = 'table-scroll';
    const t = d.createElement('table');
    t.className = 'data-table';

    const anyPractical = r.subjects.some((s) => s.practicalMarks !== null);
    const anyCa = r.subjects.some((s) => s.caMarks !== null);
    const cols = ['বিষয়', 'CQ', 'MCQ'];
    if (anyPractical) cols.push('ব্যা.');
    if (anyCa) cols.push('ধারা.');
    cols.push('মোট', 'গ্রেড');

    const thead = d.createElement('thead');
    const hr = d.createElement('tr');
    for (const c of cols) {
      const th = d.createElement('th');
      th.textContent = c;
      th.scope = 'col';
      hr.append(th);
    }
    thead.append(hr);
    t.append(thead);

    const tbody = d.createElement('tbody');
    for (const s of r.subjects) {
      const tr = d.createElement('tr');
      const th = d.createElement('th');
      th.scope = 'row';
      th.textContent = s.subjectBn;
      // The superscript ⁴ the wireframe ties to the footnote below.
      if (s.requirementType === 'optional') {
        const sup = d.createElement('sup');
        sup.textContent = '৪';
        th.append(sup);
      }
      tr.append(th);

      if (s.isAbsent) {
        const td = d.createElement('td');
        td.colSpan = cols.length - 1;
        td.className = 'is-absent';
        td.textContent = 'অনুপস্থিত';
        tr.append(td);
      } else {
        const vals = [mark(s.cqMarks), mark(s.mcqMarks)];
        if (anyPractical) vals.push(mark(s.practicalMarks));
        if (anyCa) vals.push(mark(s.caMarks));
        vals.push(mark(s.totalMarks));
        for (const v of vals) {
          const td = d.createElement('td');
          td.textContent = v;
          tr.append(td);
        }
        const g = d.createElement('td');
        g.className = 'cell-grade';
        g.textContent = s.gradeLetter ?? '—';
        if (s.componentFailed) {
          // Component failure is why a good total can still be a fail. It
          // is stated, not implied by a colour.
          const note = d.createElement('span');
          note.className = 'cell-note';
          note.textContent = ' (উপাদানে অকৃতকার্য)';
          g.append(note);
        }
        tr.append(g);
      }
      tbody.append(tr);
    }
    t.append(tbody);
    wrap.append(t);
    return wrap;
  }

  /**
   * §6.5: "The optional-subject footnote is mandatory: it is the rule most
   * commonly misunderstood, and showing it prevents a support call."
   */
  private optionalFootnote(r: Result): HTMLElement | null {
    if (!r.subjects.some((s) => s.requirementType === 'optional')) return null;
    const p = this.o.doc.createElement('p');
    p.className = 'result-footnote';
    p.textContent =
      '৪ চতুর্থ বিষয় — নির্ধারিত সীমার অতিরিক্ত গ্রেড পয়েন্ট মোট GPA-তে যোগ হয়েছে, '
      + 'এবং এই বিষয়টি বিষয়সংখ্যার হিসাবে ধরা হয়নি।';
    return p;
  }

  /** Trend across terms — §6.5's প্রবণতা row. Oldest first, so it reads left to right. */
  private trend(): HTMLElement {
    const d = this.o.doc;
    const box = d.createElement('section');
    box.className = 'result-trend';
    const h = d.createElement('h2');
    h.textContent = 'প্রবণতা';
    box.append(h);

    const list = d.createElement('ol');
    list.className = 'trend-list';
    const ordered = [...this.results].reverse();
    for (const r of ordered) {
      const li = d.createElement('li');
      li.className = 'trend-point';
      if (r.examId === this.selected) li.dataset.current = 'true';
      const v = d.createElement('span');
      v.className = 'trend-gpa';
      v.textContent = r.gpa ? formatIdentifier(Number(r.gpa).toFixed(2)) : '—';
      const l = d.createElement('span');
      l.className = 'trend-label';
      l.textContent = r.examNameBn;
      li.append(v, l);
      list.append(li);
    }
    box.append(list);
    return box;
  }

  private skeleton(root: HTMLElement): void {
    const d = this.o.doc;
    const card = d.createElement('div');
    card.className = 'card result-summary is-skeleton';
    card.setAttribute('aria-busy', 'true');
    for (const c of ['skel skel-title', 'skel skel-line', 'skel skel-bar']) {
      const x = d.createElement('div'); x.className = c; card.append(x);
    }
    root.append(card);
  }

  private empty(root: HTMLElement): void {
    const d = this.o.doc;
    const box = d.createElement('div');
    box.className = 'empty-state';
    const g = d.createElement('div');
    g.className = 'empty-glyph'; g.textContent = '⃝'; g.setAttribute('aria-hidden', 'true');
    const p = d.createElement('p');
    // Honest about WHY it is empty: a result exists but is not published
    // yet, and the family cannot see it until the school says so.
    p.textContent = 'এখনো কোনো ফলাফল প্রকাশিত হয়নি। স্কুল প্রকাশ করলে এখানে দেখা যাবে।';
    box.append(g, p);
    root.append(box);
  }
}
