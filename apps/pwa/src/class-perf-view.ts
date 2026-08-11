/**
 * Class performance and students who may need support — wireframe §7.5,
 * F-1501 and F-1502.
 *
 * See services/academics-svc/api/classperf.ts for why the question-level
 * panel is sourced from practice rather than from the exam, and for the
 * four structural consequences of F-1502's "soft signal, never a label".
 * This file's job is to not undo any of them in the markup.
 *
 * Three things here are deliberate and easy to "fix" into a violation:
 *
 *  • The attention list is not sorted, filtered or badged by severity. No
 *    red for the worst child. The signals carry their own numbers, and
 *    that is the whole of the emphasis.
 *
 *  • Every student's signals are shown in full. A "+২ আরও" affordance
 *    would turn the panel into a summary of a child, which is a label.
 *
 *  • The heading is §7.5's exact phrasing — "সহায়তা প্রয়োজন হতে পারে",
 *    may need support. Not "দুর্বল শিক্ষার্থী", not "ঝুঁকিতে". The
 *    conditional is the point, and it is why the panel can exist at all.
 */
import type { Auth } from './auth.ts';
import { toBanglaDigits } from '../../../packages/ui-core/src/format.ts';

type Choice = { examSubjectId: string; label: string };
type Component = { key: string; labelBn: string; max: number; average: number | null; percent: number | null };
type Question = { questionNo: number; kind: string; stemBn: string; chapterBn: string; attempts: number; wrongPercent: number };
type Attention = { studentId: string; nameBn: string; rollNo: number; signals: string[] };
type Thresholds = { attendanceFloorPercent: number; streakDays: number; markDropPoints: number; windowDays: number };
type Analysis = {
  header: { examSubjectId: string; label: string };
  coverage: { marked: number; enrolled: number; absent: number };
  components: Component[];
  practice: { questions: Question[]; reteach: { chapterBn: string; questionCount: number } | null; source: string };
  attention: Attention[];
  thresholds: Thresholds;
};
type Payload = { choices: Choice[]; analysis: Analysis | null };

export interface ClassPerfViewOptions {
  root: HTMLElement;
  doc: Document;
  auth: Auth;
}

const LAST_KEY = 'shikhon_last_perf_exam';

export class ClassPerfView {
  private readonly o: ClassPerfViewOptions;
  private choices: Choice[] = [];
  private analysis: Analysis | null = null;
  private selected = '';
  private loading = true;
  private failed = false;

  constructor(options: ClassPerfViewOptions) {
    this.o = options;
    // Explicit null check. '' is a real "nothing chosen yet" and
    // localStorage returning null must not be coerced into it silently.
    const stored = localStorage.getItem(LAST_KEY);
    this.selected = stored === null ? '' : stored;
    void this.load();
  }

  private async load(): Promise<void> {
    this.loading = true;
    this.failed = false;
    this.render();
    try {
      const qs = this.selected ? `?examSubjectId=${encodeURIComponent(this.selected)}` : '';
      const res = await this.o.auth.authedFetch(`/api/v1/academics/classperf${qs}`);
      if (!res.ok) throw new Error(String(res.status));
      const body = (await res.json()) as Payload;
      this.choices = body.choices;
      this.analysis = body.analysis;
    } catch {
      this.failed = true;
    }
    this.loading = false;
    this.render();
  }

  private render(): void {
    const d = this.o.doc;
    const root = this.o.root;
    root.textContent = '';

    const header = d.createElement('div');
    header.className = 'page-header';
    const h1 = d.createElement('h1');
    h1.textContent = 'শ্রেণির ফলাফল বিশ্লেষণ';
    header.append(h1);
    root.append(header);

    if (this.loading) {
      root.append(this.note('তথ্য আনা হচ্ছে…'));
      return;
    }
    if (this.failed) {
      root.append(this.notice('বিশ্লেষণ আনা যায়নি। সংযোগ পেলে আবার চেষ্টা করুন।', 'is-danger'));
      return;
    }
    if (this.choices.length === 0) {
      root.append(this.note('এখনো কোনো পরীক্ষার নম্বর দেওয়া হয়নি। নম্বর দেওয়া শেষ হলে এখানে শ্রেণির বিশ্লেষণ দেখা যাবে।'));
      return;
    }

    root.append(this.picker());

    if (!this.analysis) {
      root.append(this.note('উপরের তালিকা থেকে শ্রেণি ও পরীক্ষা বেছে নিলে বিশ্লেষণ দেখা যাবে।'));
      return;
    }
    const a = this.analysis;
    root.append(this.coverageLine(a.coverage));
    root.append(this.componentPanel(a.components));
    root.append(this.practicePanel(a.practice));
    root.append(this.attentionPanel(a.attention, a.thresholds, a.coverage.enrolled));
  }

  private picker(): HTMLElement {
    const d = this.o.doc;
    const select = d.createElement('select');
    select.className = 'section-picker';
    select.setAttribute('aria-label', 'শ্রেণি ও পরীক্ষা');

    const blank = d.createElement('option');
    blank.value = '';
    blank.textContent = '— শ্রেণি ও পরীক্ষা বেছে নিন —';
    select.append(blank);

    for (const c of this.choices) {
      const opt = d.createElement('option');
      opt.value = c.examSubjectId;
      opt.textContent = c.label;
      if (c.examSubjectId === this.selected) opt.selected = true;
      select.append(opt);
    }
    select.addEventListener('change', () => {
      this.selected = select.value;
      localStorage.setItem(LAST_KEY, this.selected);
      void this.load();
    });
    return select;
  }

  /**
   * Every average below is over the marked students only. Saying so once,
   * up front, is cheaper than a footnote on each number, and it stops a
   * half-marked exam from reading as a bad result.
   */
  private coverageLine(c: { marked: number; enrolled: number; absent: number }): HTMLElement {
    const parts = [`${bn(c.marked)}/${bn(c.enrolled)} জনের নম্বর দেওয়া হয়েছে`];
    if (c.absent > 0) parts.push(`${bn(c.absent)} জন অনুপস্থিত — হিসাবের বাইরে`);
    const p = this.note(parts.join(' · '));
    // Sits outside any card, so it insets itself.
    p.className = 'page-sub perf-coverage';
    return p;
  }

  /** Exam component averages. Real exam data, so it leads. */
  private componentPanel(components: Component[]): HTMLElement {
    const card = this.card('পরীক্ষার অংশভিত্তিক ফল');
    if (components.length === 0) {
      card.append(this.note('এই পরীক্ষার কোনো নম্বর পাওয়া যায়নি।'));
      return card;
    }
    const d = this.o.doc;
    const list = d.createElement('div');
    list.className = 'perf-bars';

    for (const c of components) {
      const row = d.createElement('div');
      row.className = 'perf-bar';

      const name = d.createElement('span');
      name.className = 'perf-bar-label';
      name.textContent = c.labelBn;

      const track = d.createElement('span');
      track.className = 'perf-bar-track';
      const fill = d.createElement('span');
      fill.className = 'perf-bar-fill';
      // A null average means nobody holds a mark for this component — an
      // empty track, not a zero-width bar labelled ০%.
      fill.style.width = `${c.percent ?? 0}%`;
      // Half the component's own maximum is the only threshold drawn here,
      // and it earns the tone because NCTB pass marks are per component: a
      // class under 50 on CQ is heading for component failures whatever
      // the totals say.
      if (c.percent !== null && c.percent < 50) fill.dataset.tone = 'low';
      track.append(fill);

      const value = d.createElement('span');
      value.className = 'perf-bar-value';
      value.textContent = c.percent === null
        ? '—'
        : `${bn(c.percent)}% · গড় ${bn(c.average ?? 0)}/${bn(c.max)}`;

      row.append(name, track, value);
      list.append(row);
    }
    card.append(list);
    return card;
  }

  /**
   * §7.5's question-level panel. Labelled অনুশীলন in the heading and again
   * in the note, because a teacher who reads these as exam questions is
   * reading about a self-selected cohort and does not know it.
   */
  private practicePanel(p: Analysis['practice']): HTMLElement {
    const d = this.o.doc;
    const card = this.card('অনুশীলনে যে প্রশ্নগুলো সবচেয়ে বেশি ভুল হয়েছে');
    card.append(this.note('অনুশীলনের উত্তর থেকে — পরীক্ষার খাতা থেকে নয়। যারা অনুশীলন করেছে কেবল তাদের হিসাব।'));

    if (p.questions.length === 0) {
      card.append(this.note('এই বিষয়ে যথেষ্ট অনুশীলন হয়নি, তাই প্রশ্নভিত্তিক হিসাব দেওয়া যাচ্ছে না।'));
      return card;
    }

    const list = d.createElement('ul');
    list.className = 'perf-qlist';
    for (const q of p.questions) {
      const li = d.createElement('li');
      li.className = 'perf-q';

      const stem = d.createElement('p');
      stem.className = 'perf-q-stem';
      stem.textContent = `প্রশ্ন ${bn(q.questionNo)} — ${q.stemBn}`;

      const meta = d.createElement('p');
      meta.className = 'perf-q-meta';
      meta.textContent = `${q.chapterBn} · ${bn(q.wrongPercent)}% ভুল · ${bn(q.attempts)} জন`;

      li.append(stem, meta);
      list.append(li);
    }
    card.append(list);

    if (p.reteach) {
      const hint = d.createElement('p');
      hint.className = 'perf-reteach';
      hint.textContent = `${p.reteach.chapterBn} — এই অধ্যায়ের ${bn(p.reteach.questionCount)}টি প্রশ্নে বেশি ভুল হয়েছে। পুনরায় আলোচনা করা যেতে পারে।`;
      card.append(hint);
    }
    return card;
  }

  /**
   * F-1502. The heading, the stated method and the absence of any ranking
   * are the feature; the list itself is almost incidental.
   */
  private attentionPanel(rows: Attention[], t: Thresholds, enrolled: number): HTMLElement {
    const d = this.o.doc;
    const card = this.card('যাদের সহায়তা প্রয়োজন হতে পারে');

    // The method is printed so a teacher can disagree with it. A signal
    // whose derivation is hidden is an accusation.
    card.append(this.note(
      'এটি কেবল একটি ইঙ্গিত — কোনো রায় নয়, এবং কোথাও সংরক্ষণ করা হয় না। '
      + `হিসাব: গত ${bn(t.windowDays)} দিনে হাজিরা ${bn(t.attendanceFloorPercent)}%-এর কম, `
      + `অথবা টানা ${bn(t.streakDays)} দিন অনুপস্থিত, `
      + `অথবা গত পরীক্ষার চেয়ে নম্বর ${bn(t.markDropPoints)}% বা তার বেশি কম।`,
    ));

    if (rows.length === 0) {
      card.append(this.note('এই মুহূর্তে কারও ক্ষেত্রে এই ইঙ্গিতগুলো মেলেনি।'));
      return card;
    }

    // If half the class trips the thresholds, the honest reading is that
    // something happened to the class, not to the children — a lost
    // fortnight, a teacher on leave. Saying so stops a teacher working
    // down thirty names one at a time looking for thirty causes.
    if (enrolled > 0 && rows.length * 2 >= enrolled) {
      const wide = d.createElement('p');
      wide.className = 'perf-wide-note';
      wide.textContent = `শ্রেণির ${bn(rows.length)} জন — প্রায় অর্ধেক বা তার বেশি — এই ইঙ্গিতে পড়েছে। `
        + 'এটি সাধারণত এক-একজনের নয়, পুরো শ্রেণির কোনো ঘটনার ইঙ্গিত।';
      card.append(wide);
    }

    const list = d.createElement('ul');
    list.className = 'perf-attention';
    for (const r of rows) {
      const li = d.createElement('li');
      li.className = 'perf-att-row';

      const name = d.createElement('p');
      name.className = 'perf-att-name';
      name.textContent = `${bn(r.rollNo)} · ${r.nameBn}`;

      const signals = d.createElement('ul');
      signals.className = 'perf-att-signals';
      for (const s of r.signals) {
        const sig = d.createElement('li');
        sig.textContent = s;
        signals.append(sig);
      }
      li.append(name, signals);
      list.append(li);
    }
    card.append(list);
    return card;
  }

  private card(title: string): HTMLElement {
    const d = this.o.doc;
    const card = d.createElement('section');
    card.className = 'card perf-card';
    const h = d.createElement('h2');
    h.className = 'section-heading';
    h.textContent = title;
    card.append(h);
    return card;
  }

  private note(text: string): HTMLElement {
    const p = this.o.doc.createElement('p');
    p.className = 'page-sub';
    p.textContent = text;
    return p;
  }

  private notice(text: string, tone: string): HTMLElement {
    const p = this.o.doc.createElement('p');
    p.className = `inline-notice ${tone}`;
    p.textContent = text;
    return p;
  }
}

function bn(n: number): string {
  return toBanglaDigits(n);
}
