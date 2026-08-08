/**
 * Results (ফলাফল) — the student/guardian report-card view.
 *
 * Reads GET /api/v1/academics/results, which defaults to the caller's own
 * results. RLS guarantees a family only ever sees published rows, so this
 * view never has to reason about moderation state — if it's here, it's
 * official.
 *
 * Presentation follows the board report card a Bangladeshi family already
 * knows: GPA in the largest type, letter grade beside it, then the
 * subject-by-subject breakdown. Rank is shown when the school computed one
 * but is deliberately not emphasised over GPA — it's positional, not an
 * achievement measure, and leading with it changes what a student
 * optimises for.
 */
import type { Auth } from './auth.ts';
import { formatCount } from '../../../packages/ui-core/src/format.ts';

interface SubjectRow {
  subjectBn: string;
  totalMarks: string | null;
  gradeLetter: string | null;
  gradePoint: string | null;
  isAbsent: boolean;
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

const BN_DIGITS: Record<string, string> = {
  '0': '০', '1': '১', '2': '২', '3': '৩', '4': '৪',
  '5': '৫', '6': '৬', '7': '৭', '8': '৮', '9': '৯',
};
function bnNum(s: string | null | undefined): string {
  if (s === null || s === undefined || s === '') return '—';
  return String(s).replace(/[0-9]/g, (d) => BN_DIGITS[d] ?? d);
}

export interface ResultsViewOptions {
  root: HTMLElement;
  doc: Document;
  auth: Auth;
}

export class ResultsView {
  private readonly o: ResultsViewOptions;
  private results: Result[] = [];
  private expanded: string | null = null;
  private loading = true;
  private offline = false;

  constructor(options: ResultsViewOptions) {
    this.o = options;
    void this.load();
  }

  private async load(): Promise<void> {
    try {
      const raw = localStorage.getItem(CACHE_KEY);
      if (raw) { this.results = JSON.parse(raw) as Result[]; this.loading = false; }
    } catch { /* cache is a nicety */ }
    this.render();

    try {
      const res = await this.o.auth.authedFetch('/api/v1/academics/results');
      if (!res.ok) throw new Error(String(res.status));
      const body = (await res.json()) as { results: Result[] };
      this.results = body.results;
      this.offline = false;
      try { localStorage.setItem(CACHE_KEY, JSON.stringify(this.results)); } catch { /* ignore */ }
    } catch {
      this.offline = this.results.length > 0;
    }
    this.loading = false;
    this.render();
  }

  private render(): void {
    const d = this.o.doc;
    const root = this.o.root;
    root.textContent = '';

    const header = d.createElement('header');
    header.className = 'page-header';
    const h1 = d.createElement('h1');
    h1.textContent = 'ফলাফল';
    const sub = d.createElement('p');
    sub.className = 'page-sub';
    sub.textContent = 'প্রকাশিত পরীক্ষার ফলাফল ও বিষয়ভিত্তিক নম্বর';
    header.append(h1, sub);
    root.append(header);

    if (this.offline) {
      const banner = d.createElement('p');
      banner.className = 'inline-notice';
      banner.textContent = 'অফলাইন — সংরক্ষিত ফলাফল দেখানো হচ্ছে';
      root.append(banner);
    }

    if (this.loading && this.results.length === 0) {
      root.append(this.msg('লোড হচ্ছে…'));
      return;
    }
    if (this.results.length === 0) {
      root.append(this.msg('এখনো কোনো ফলাফল প্রকাশিত হয়নি।'));
      return;
    }

    const list = d.createElement('ul');
    list.className = 'result-list';

    for (const r of this.results) {
      const li = d.createElement('li');
      li.className = 'card result-card';
      li.dataset.pass = String(r.isPass);

      const head = d.createElement('button');
      head.type = 'button';
      head.className = 'result-head';
      head.setAttribute('aria-expanded', String(this.expanded === r.examId));

      const info = d.createElement('span');
      info.className = 'result-info';
      const name = d.createElement('span');
      name.className = 'result-exam';
      name.textContent = r.examNameBn;
      const meta = d.createElement('span');
      meta.className = 'result-meta';
      const bits: string[] = [];
      if (r.percentage) bits.push(`${bnNum(Number(r.percentage).toFixed(0))}%`);
      if (r.rankInSection) bits.push(`মেধাক্রম ${formatCount(r.rankInSection, 'bn')}`);
      if (r.subjectsFailed > 0) bits.push(`${formatCount(r.subjectsFailed, 'bn')} বিষয়ে অকৃতকার্য`);
      meta.textContent = bits.join(' · ') || 'বিস্তারিত দেখতে চাপুন';
      info.append(name, meta);

      const score = d.createElement('span');
      score.className = 'result-score';
      const gpa = d.createElement('span');
      gpa.className = 'result-gpa';
      gpa.textContent = bnNum(r.gpa);
      const letter = d.createElement('span');
      letter.className = 'result-letter';
      letter.textContent = r.letterGrade ?? '—';
      score.append(gpa, letter);

      head.append(info, score);
      head.addEventListener('click', () => {
        this.expanded = this.expanded === r.examId ? null : r.examId;
        this.render();
      });
      li.append(head);

      if (this.expanded === r.examId) {
        const detail = d.createElement('div');
        detail.className = 'result-detail';
        for (const s of r.subjects) {
          const row = d.createElement('div');
          row.className = 'result-subject';
          const label = d.createElement('span');
          label.textContent = s.subjectBn;
          const marks = d.createElement('span');
          marks.className = 'result-subject-mark';
          marks.textContent = s.isAbsent
            ? 'অনুপস্থিত'
            : `${bnNum(s.totalMarks ? Number(s.totalMarks).toFixed(0) : null)} · ${s.gradeLetter ?? '—'}`;
          if (s.isAbsent) marks.dataset.absent = 'true';
          row.append(label, marks);
          detail.append(row);
        }
        if (r.totalMarks && r.totalMax) {
          const total = d.createElement('div');
          total.className = 'result-subject result-total';
          const label = d.createElement('span');
          label.textContent = 'মোট';
          const val = d.createElement('span');
          val.textContent = `${bnNum(Number(r.totalMarks).toFixed(0))} / ${bnNum(Number(r.totalMax).toFixed(0))}`;
          total.append(label, val);
          detail.append(total);
        }
        li.append(detail);
      }
      list.append(li);
    }
    root.append(list);
  }

  private msg(text: string): HTMLElement {
    const p = this.o.doc.createElement('p');
    p.className = 'page-sub empty';
    p.textContent = text;
    return p;
  }
}
