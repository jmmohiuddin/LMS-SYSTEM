/**
 * SikhokAI (শিক্ষক সহায়ক) — the teacher co-pilot page.
 *
 * A form over POST /api/v1/ai/sikhok: task type (CQ / MCQ / rubric / topic
 * plan), class level, subject, optional chapter and instructions. The
 * response is NCTB-bounded generated Markdown, rendered as preformatted
 * text (no client-side Markdown engine on a 2 GB device budget — the
 * structure reads fine as plain text).
 *
 * While the gateway is dark (no ANTHROPIC_API_KEY → 503 ai_disabled) the
 * page stays usable and explains itself instead of erroring.
 */
import type { Auth } from './auth.ts';

export interface SikhokViewOptions {
  root: HTMLElement;
  doc: Document;
  auth: Auth;
}

const TASKS: [string, string][] = [
  ['generate_cq', 'সৃজনশীল প্রশ্ন (CQ)'],
  ['generate_mcq', 'বহুনির্বাচনি প্রশ্ন (MCQ)'],
  ['rubric', 'মূল্যায়ন রুব্রিক'],
  ['lesson_plan', 'পাঠ পরিকল্পনা'],
];

export class SikhokView {
  private readonly o: SikhokViewOptions;
  private busy = false;
  private output = '';
  private error = '';
  private grounded: boolean | null = null;

  constructor(options: SikhokViewOptions) {
    this.o = options;
    this.render();
  }

  private async generate(input: {
    taskType: string; classLevel: number; subjectBn: string;
    chapterNo: number | null; instructions: string;
  }): Promise<void> {
    this.busy = true;
    this.error = '';
    this.render();
    try {
      const res = await this.o.auth.authedFetch('/api/v1/ai/sikhok', {
        method: 'POST',
        body: JSON.stringify({
          taskType: input.taskType,
          classLevel: input.classLevel,
          subjectBn: input.subjectBn,
          chapterNo: input.chapterNo ?? undefined,
          instructions: input.instructions || undefined,
        }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        ok?: boolean; content?: string; grounded?: boolean; error?: string;
      };
      if (res.ok && body.ok && body.content) {
        this.output = body.content;
        this.grounded = body.grounded ?? null;
      } else if (body.error === 'ai_disabled') {
        this.error = 'AI ফিচার এখনো চালু হয়নি — অ্যাডমিন চালু করলেই এখান থেকে প্রশ্নপত্র তৈরি করা যাবে।';
      } else if (body.error === 'ai_refused') {
        this.error = 'এই অনুরোধটি তৈরি করা সম্ভব হয়নি — অন্যভাবে চেষ্টা করুন।';
      } else if (res.status === 403) {
        this.error = 'এই ফিচারটি শুধু শিক্ষক/কর্মকর্তাদের জন্য।';
      } else {
        this.error = 'সংযোগে সমস্যা হয়েছে। আবার চেষ্টা করুন।';
      }
    } catch {
      this.error = 'সংযোগে সমস্যা হয়েছে। আবার চেষ্টা করুন।';
    }
    this.busy = false;
    this.render();
  }

  private render(): void {
    const d = this.o.doc;
    const root = this.o.root;
    root.textContent = '';

    const header = d.createElement('header');
    header.className = 'att-header';
    const h1 = d.createElement('h1');
    h1.textContent = 'শিক্ষক সহায়ক AI';
    const sub = d.createElement('p');
    sub.className = 'att-sub';
    sub.textContent = 'NCTB পাঠ্যক্রম অনুযায়ী প্রশ্ন, রুব্রিক ও পাঠ পরিকল্পনা';
    header.append(h1, sub);
    root.append(header);

    const form = d.createElement('form');
    form.className = 'ai-form';

    const taskSel = d.createElement('select');
    taskSel.className = 'section-picker ai-field';
    for (const [value, label] of TASKS) {
      const opt = d.createElement('option');
      opt.value = value;
      opt.textContent = label;
      taskSel.append(opt);
    }

    const classSel = d.createElement('select');
    classSel.className = 'section-picker ai-field';
    for (let c = 6; c <= 12; c += 1) {
      const opt = d.createElement('option');
      opt.value = String(c);
      opt.textContent = `শ্রেণি ${c}`;
      if (c === 9) opt.selected = true;
      classSel.append(opt);
    }

    const subjectIn = d.createElement('input');
    subjectIn.type = 'text';
    subjectIn.className = 'login-input ai-field';
    subjectIn.placeholder = 'বিষয় (যেমন: পদার্থবিজ্ঞান)';
    subjectIn.required = true;

    const chapterIn = d.createElement('input');
    chapterIn.type = 'number';
    chapterIn.className = 'login-input ai-field';
    chapterIn.placeholder = 'অধ্যায় নং (ঐচ্ছিক)';
    chapterIn.min = '1';

    const notesIn = d.createElement('textarea');
    notesIn.className = 'login-input ai-field ai-notes';
    notesIn.placeholder = 'অতিরিক্ত নির্দেশনা (ঐচ্ছিক)';
    notesIn.rows = 2;

    const submit = d.createElement('button');
    submit.type = 'submit';
    submit.className = 'btn-primary';
    submit.textContent = this.busy ? 'তৈরি হচ্ছে…' : 'তৈরি করুন';
    submit.disabled = this.busy;

    form.append(taskSel, classSel, subjectIn, chapterIn, notesIn, submit);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      if (this.busy || !subjectIn.value.trim()) return;
      void this.generate({
        taskType: taskSel.value,
        classLevel: Number(classSel.value),
        subjectBn: subjectIn.value.trim(),
        chapterNo: chapterIn.value ? Number(chapterIn.value) : null,
        instructions: notesIn.value.trim(),
      });
    });
    root.append(form);

    if (this.error) {
      const err = d.createElement('p');
      err.className = 'login-error';
      err.setAttribute('role', 'alert');
      err.hidden = false;
      err.textContent = this.error;
      root.append(err);
    }

    if (this.output) {
      if (this.grounded === false) {
        const note = d.createElement('p');
        note.className = 'att-sub';
        note.textContent = 'পাঠ্যবই কর্পাস এখনো যুক্ত হয়নি — সাধারণ পাঠ্যক্রম-জ্ঞান থেকে তৈরি; ব্যবহারের আগে যাচাই করুন।';
        root.append(note);
      }
      const out = d.createElement('pre');
      out.className = 'ai-output';
      out.textContent = this.output;
      root.append(out);
    }
  }
}
