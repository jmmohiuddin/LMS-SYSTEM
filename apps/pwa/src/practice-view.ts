/**
 * Practice (অনুশীলন) — one question at a time, immediate feedback.
 *
 * Mounted at the end of a topic by learn-view.ts. Deliberately NOT a
 * quiz: there is no score, no pass mark, and retrying is encouraged. The
 * only thing being measured is the signal V3 needs — did they get it, and
 * how long did it take.
 *
 * Answers are marked locally for instant feedback (the answer key ships
 * with the questions — see the practice endpoint's header for why that's
 * the right trade for formative work) and the attempt is queued to the
 * outbox, where the server re-marks it authoritatively. If the two ever
 * disagreed, the server's verdict is the one that counts; the local one
 * exists purely so a student on a bus isn't staring at a spinner.
 */
import { formatCount } from '../../../packages/ui-core/src/format.ts';

export interface PracticeOption {
  id: string;
  optionNo: number;
  textBn: string;
  isCorrect: boolean;
}

export interface PracticeQuestion {
  id: string;
  questionNo: number;
  kind: string;
  stemBn: string;
  explanationBn: string | null;
  difficulty: number;
  numericAnswer: string | null;
  numericTolerance: string | null;
  options: PracticeOption[];
  myProgress: { attempts: number; solved: boolean; lastResponseMs: number | null };
}

export interface PracticeOutbox {
  enqueue(input: { entity: 'practice_attempt'; payload: unknown }): Promise<{ opId: string }>;
  flush(): Promise<unknown>;
}

export interface PracticeViewOptions {
  root: HTMLElement;
  doc: Document;
  questions: PracticeQuestion[];
  outbox: PracticeOutbox;
  onDone?: () => void;
}

export class PracticeView {
  private readonly o: PracticeViewOptions;
  private index = 0;
  private selectedId: string | null = null;
  private typed = '';
  private revealed = false;
  private wasCorrect = false;
  private shownAt = Date.now();
  private attemptsThisSession = new Map<string, number>();
  private solved = new Set<string>();

  constructor(options: PracticeViewOptions) {
    this.o = options;
    for (const q of options.questions) if (q.myProgress.solved) this.solved.add(q.id);
    this.render();
  }

  private get current(): PracticeQuestion | undefined {
    return this.o.questions[this.index];
  }

  private markLocally(q: PracticeQuestion): boolean {
    if (q.kind === 'mcq' || q.kind === 'true_false') {
      return q.options.find((o) => o.id === this.selectedId)?.isCorrect ?? false;
    }
    if (q.kind === 'numeric') {
      const given = Number(this.typed);
      if (!Number.isFinite(given)) return false;
      const tol = Number(q.numericTolerance ?? 0);
      return Math.abs(given - Number(q.numericAnswer)) <= tol;
    }
    return false;   // short answer is server-marked; no local guess
  }

  private async check(): Promise<void> {
    const q = this.current;
    if (!q || this.revealed) return;
    if (!this.selectedId && !this.typed.trim()) return;

    const attemptNo = (this.attemptsThisSession.get(q.id) ?? q.myProgress.attempts) + 1;
    this.attemptsThisSession.set(q.id, attemptNo);
    this.wasCorrect = this.markLocally(q);
    this.revealed = true;
    if (this.wasCorrect) this.solved.add(q.id);

    try {
      await this.o.outbox.enqueue({
        entity: 'practice_attempt',
        payload: {
          questionId: q.id,
          attemptNo,
          selectedOptionId: this.selectedId,
          answerText: q.kind === 'short_answer' ? this.typed.trim() : null,
          answerNumeric: q.kind === 'numeric' ? Number(this.typed) : null,
          responseMs: Date.now() - this.shownAt,
        },
      });
      void Promise.resolve(this.o.outbox.flush()).catch(() => {});
    } catch {
      // A failed enqueue must not block the student from continuing.
    }
    this.render();
  }

  private retry(): void {
    this.revealed = false;
    this.selectedId = null;
    this.typed = '';
    this.shownAt = Date.now();
    this.render();
  }

  private next(): void {
    if (this.index >= this.o.questions.length - 1) { this.o.onDone?.(); return; }
    this.index += 1;
    this.retry();
  }

  /* -------------------------------------------------------------- render */

  private render(): void {
    const d = this.o.doc;
    const root = this.o.root;
    root.textContent = '';

    const q = this.current;
    if (!q) {
      const done = d.createElement('p');
      done.className = 'page-sub empty';
      done.textContent = 'এই পাঠে কোনো অনুশীলন নেই।';
      root.append(done);
      return;
    }

    // Progress dots — solved / attempted / untouched, so the student sees
    // shape of the set at a glance rather than just "3 of 6".
    const rail = d.createElement('div');
    rail.className = 'prac-rail';
    rail.setAttribute('aria-label',
      `প্রশ্ন ${q.questionNo}, মোট ${this.o.questions.length}`);
    this.o.questions.forEach((item, i) => {
      const dot = d.createElement('span');
      dot.className = 'prac-dot';
      dot.dataset.state = this.solved.has(item.id) ? 'solved'
        : i === this.index ? 'current' : 'todo';
      rail.append(dot);
    });
    root.append(rail);

    const card = d.createElement('div');
    card.className = 'card prac-card';

    const meta = d.createElement('div');
    meta.className = 'prac-meta';
    const num = d.createElement('span');
    num.textContent = `প্রশ্ন ${formatCount(q.questionNo, 'bn')}`;
    const diff = d.createElement('span');
    diff.className = 'prac-difficulty';
    diff.textContent = '●'.repeat(q.difficulty) + '○'.repeat(5 - q.difficulty);
    diff.setAttribute('aria-label', `কঠিনতা ${q.difficulty} / ৫`);
    meta.append(num, diff);
    card.append(meta);

    const stem = d.createElement('p');
    stem.className = 'prac-stem';
    stem.textContent = q.stemBn;
    card.append(stem);

    if (q.kind === 'mcq' || q.kind === 'true_false') {
      const list = d.createElement('div');
      list.className = 'prac-options';
      list.setAttribute('role', 'radiogroup');
      for (const opt of q.options) {
        const btn = d.createElement('button');
        btn.type = 'button';
        btn.className = 'prac-option';
        btn.setAttribute('role', 'radio');
        btn.setAttribute('aria-checked', String(this.selectedId === opt.id));
        btn.disabled = this.revealed;

        // A mark, not just a colour. Right and wrong used to be carried by a
        // green or red background alone, which a red-green colour-blind
        // student cannot read — and that is roughly one boy in twelve.
        const mark = d.createElement('span');
        mark.className = 'prac-mark';
        mark.setAttribute('aria-hidden', 'true');
        const label = d.createElement('span');
        label.className = 'prac-option-text';
        label.textContent = opt.textBn;

        if (this.revealed) {
          // After answering, show BOTH what they chose and what was right —
          // marking only the wrong answer teaches nothing.
          if (opt.isCorrect) {
            btn.dataset.state = 'correct';
            mark.textContent = '✓';
            // Spoken as well as shown, so the state does not depend on sight.
            btn.setAttribute('aria-label', `${opt.textBn} — সঠিক উত্তর`);
          } else if (opt.id === this.selectedId) {
            btn.dataset.state = 'wrong';
            mark.textContent = '✗';
            btn.setAttribute('aria-label', `${opt.textBn} — তোমার উত্তর, ভুল`);
          } else {
            mark.textContent = '';
          }
        } else if (this.selectedId === opt.id) {
          mark.textContent = '●';
          btn.dataset.state = 'selected';
        } else {
          mark.textContent = '○';
        }
        btn.append(mark, label);

        btn.addEventListener('click', () => {
          if (this.revealed) return;
          this.selectedId = opt.id;
          this.render();
        });
        list.append(btn);
      }
      card.append(list);
    } else {
      const input = d.createElement('input');
      input.type = q.kind === 'numeric' ? 'number' : 'text';
      input.className = 'field-input prac-input';
      input.placeholder = q.kind === 'numeric' ? 'উত্তর লেখো' : 'সংক্ষেপে লেখো';
      input.value = this.typed;
      input.disabled = this.revealed;
      if (q.kind === 'numeric') input.step = 'any';
      input.addEventListener('input', () => { this.typed = input.value; });
      card.append(input);
    }

    if (this.revealed) {
      const verdict = d.createElement('div');
      verdict.className = 'prac-verdict';
      verdict.dataset.correct = String(this.wasCorrect);
      verdict.setAttribute('role', 'status');
      verdict.textContent = q.kind === 'short_answer'
        ? 'উত্তর জমা হয়েছে — শিক্ষক যাচাই করবেন'
        : this.wasCorrect ? '✓ ঠিক হয়েছে!' : '✗ আবার ভাবো';
      card.append(verdict);

      if (q.explanationBn) {
        const exp = d.createElement('p');
        exp.className = 'prac-explanation';
        exp.textContent = q.explanationBn;
        card.append(exp);
      }
    }

    const actions = d.createElement('div');
    actions.className = 'prac-actions';
    if (!this.revealed) {
      const check = d.createElement('button');
      check.type = 'button';
      check.className = 'btn-primary';
      check.textContent = 'যাচাই করো';
      check.disabled = !this.selectedId && !this.typed.trim();
      check.addEventListener('click', () => { void this.check(); });
      actions.append(check);
    } else {
      if (!this.wasCorrect && q.kind !== 'short_answer') {
        const again = d.createElement('button');
        again.type = 'button';
        again.className = 'btn-secondary prac-retry';
        again.textContent = 'আবার চেষ্টা করো';
        again.addEventListener('click', () => { this.retry(); });
        actions.append(again);
      }
      const next = d.createElement('button');
      next.type = 'button';
      next.className = 'btn-primary';
      next.textContent = this.index >= this.o.questions.length - 1 ? 'শেষ করো' : 'পরের প্রশ্ন →';
      next.addEventListener('click', () => { this.next(); });
      actions.append(next);
    }
    card.append(actions);
    root.append(card);
  }
}
