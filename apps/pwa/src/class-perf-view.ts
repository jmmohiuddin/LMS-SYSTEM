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
import {
  pageHeader, card as uiCard, dataTable, field, statRow, statCard, listSkeleton, el,
} from './ui/index.ts';
import { emptyState, errorState } from './view-states.ts';
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

    root.append(pageHeader(d, {
      title: 'শ্রেণির ফলাফল বিশ্লেষণ',
      subtitle: 'কোন অংশে দুর্বলতা, এবং কাদের সহায়তা লাগতে পারে',
    }));

    if (this.loading) { root.append(listSkeleton(d, 3)); return; }
    if (this.failed) {
      root.append(errorState(d, 'বিশ্লেষণ আনা যায়নি। সংযোগ পেলে আবার চেষ্টা করুন।',
        () => void this.load()));
      return;
    }
    if (this.choices.length === 0) {
      root.append(emptyState(d, {
        glyph: 'trending-up',
        message: 'এখনো কোনো পরীক্ষার নম্বর দেওয়া হয়নি। নম্বর দেওয়া শেষ হলে এখানে '
          + 'শ্রেণির বিশ্লেষণ দেখা যাবে।',
      }));
      return;
    }

    root.append(this.picker());

    if (!this.analysis) {
      root.append(emptyState(d, {
        glyph: 'search',
        message: 'উপরের তালিকা থেকে শ্রেণি ও পরীক্ষা বেছে নিলে বিশ্লেষণ দেখা যাবে।',
      }));
      return;
    }
    const a = this.analysis;
    root.append(this.coverageLine(a.coverage));
    root.append(this.componentPanel(a.components));
    root.append(this.practicePanel(a.practice));
    root.append(this.attentionPanel(a.attention, a.thresholds, a.coverage.enrolled));
  }

  private picker(): HTMLElement {
    // A visible label, not an `aria-label`. The old control announced itself
    // to a screen reader and told a sighted teacher nothing until they opened
    // it — which on this screen is the difference between "an exam" and
    // "which exam am I looking at".
    const f = field(this.o.doc, {
      label: 'শ্রেণি ও পরীক্ষা',
      name: 'examSubject',
      kind: 'select',
      value: this.selected,
      helper: 'বাছাই মনে রাখা হয় — পরের বার এই পাতাতেই ফিরে আসবেন।',
      options: [
        { value: '', label: '— শ্রেণি ও পরীক্ষা বেছে নিন —' },
        ...this.choices.map((c) => ({ value: c.examSubjectId, label: c.label })),
      ],
      onChange: (v) => {
        this.selected = v;
        localStorage.setItem(LAST_KEY, this.selected);
        void this.load();
      },
    });
    return f.root;
  }

  /**
   * Every average below is over the marked students only. Saying so once,
   * up front, is cheaper than a footnote on each number, and it stops a
   * half-marked exam from reading as a bad result.
   */
  private coverageLine(c: { marked: number; enrolled: number; absent: number }): HTMLElement {
    const d = this.o.doc;
    // Figures, because the whole screen is qualified by them: an average over
    // 12 of 40 children is not the class's average, and a teacher must see
    // that before reading anything below.
    return statRow(d,
      statCard(d, {
        label: 'নম্বর দেওয়া হয়েছে', value: `${bn(c.marked)} / ${bn(c.enrolled)}`,
        glyph: 'check-square',
        tone: c.marked >= c.enrolled ? 'success' : 'warn',
        note: c.marked < c.enrolled ? 'নিচের সব গড় কেবল এদের নিয়ে' : 'সবার নম্বর আছে',
      }),
      statCard(d, {
        label: 'অনুপস্থিত', value: `${bn(c.absent)} জন`, glyph: 'alert-triangle',
        tone: c.absent > 0 ? 'warn' : 'success',
        note: c.absent > 0 ? 'হিসাবের বাইরে' : undefined,
      }),
    );
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

    // The wrong-percentage is what this panel is FOR, so it is a sortable
    // column rather than the third clause of a sentence.
    card.append(dataTable(d, {
      caption: 'অনুশীলনে সবচেয়ে বেশি ভুল হওয়া প্রশ্ন',
      rows: p.questions,
      rowKey: (q) => String(q.questionNo),
      columns: [
        { key: 'q', header: 'প্রশ্ন', mobile: 'title',
          cell: (q) => `প্রশ্ন ${bn(q.questionNo)} — ${q.stemBn}`,
          width: 'minmax(0, 3fr)' },
        { key: 'ch', header: 'অধ্যায়', mobile: 'subtitle', cell: (q) => q.chapterBn,
          width: 'minmax(0, 1.4fr)' },
        { key: 'wrong', header: 'ভুল', mobile: 'meta', numeric: true,
          cell: (q) => `${bn(q.wrongPercent)}%`, width: '110px' },
        { key: 'n', header: 'কতজন করেছে', mobile: 'meta', numeric: true,
          cell: (q) => bn(q.attempts), width: '130px' },
      ],
    }));

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

    card.append(dataTable(d, {
      caption: 'যাদের সহায়তা প্রয়োজন হতে পারে',
      rows,
      rowKey: (r) => String(r.rollNo),
      columns: [
        { key: 'roll', header: 'রোল', mobile: 'meta', numeric: true,
          cell: (r) => bn(r.rollNo), width: '90px' },
        { key: 'name', header: 'নাম', mobile: 'title', cell: (r) => r.nameBn,
          width: 'minmax(0, 1.6fr)' },
        // Every signal, in full. A count would turn a list of reasons into a
        // score, and a score is the ranking this feature deliberately has not
        // got.
        { key: 'why', header: 'কেন', mobile: 'subtitle', width: 'minmax(0, 3fr)',
          cell: (r) => el(d, 'ul', { className: 'perf-att-signals' },
            ...r.signals.map((sig) => el(d, 'li', { text: sig }))) },
      ],
    }));
    return card;
  }

  private card(title: string): HTMLElement {
    return uiCard(this.o.doc, {
      title, glyph: 'trending-up', headingLevel: 2, className: 'perf-card',
    });
  }

  private note(text: string): HTMLElement {
    const p = this.o.doc.createElement('p');
    p.className = 'ui-card-note';
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
