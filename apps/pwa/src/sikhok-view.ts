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
import { levelNameBn } from '../../../packages/ui-core/src/format.ts';
import {
  pageHeader, card, button, buttonRow, field, setFieldError, clearFieldError,
  statusBadge, el, append, type Field, permissionState, permissionMessage,} from './ui/index.ts';


export interface SikhokViewOptions {
  root: HTMLElement;
  doc: Document;
  auth: Auth;
}

/**
 * Mirrors `requireStaff` in server-core, which blocks exactly these two.
 * Advisory only — the endpoint is the gate; this decides whether the form is
 * offered at all.
 */
const NOT_STAFF = ['student', 'guardian'];

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

    root.append(pageHeader(d, { title: 'শিক্ষক সহায়ক AI' }));

    // A student typing this URL used to meet the whole generator — task type,
    // class, subject, and a live "তৈরি করুন". The endpoint refuses them, so
    // nothing could have been generated; offering it anyway implies a child
    // may write their own exam questions.
    if (NOT_STAFF.includes(this.o.auth.role)) {
      root.append(permissionState(d, {
        message: permissionMessage('শিক্ষক সহায়ক AI'),
        contact: 'শিক্ষক ও কর্মকর্তা',
      }));
      return;
    }

    root.append(el(d, 'p', {
      className: 'page-sub',
      text: 'NCTB পাঠ্যক্রম অনুযায়ী প্রশ্ন, রুব্রিক ও পাঠ পরিকল্পনা',
    }));

    const form = el(d, 'form', { className: 'ui-card ui-card-form' });

    const task = field(d, {
      label: 'কী তৈরি করবেন', name: 'taskType', kind: 'select', required: true,
      options: TASKS.map(([value, label]) => ({ value, label })),
    });
    const level = field(d, {
      label: 'শ্রেণি', name: 'classLevel', kind: 'select', required: true,
      value: '9',
      // These read "শ্রেণি 6 … শ্রেণি 12" — Latin digits in a Bangla product,
      // on the one control that names the class. `levelNameBn` is the table
      // `structure-forms` has had since R-3; appending "ম" to a numeral gives
      // "১১ম" where a school says "একাদশ".
      options: Array.from({ length: 7 }, (_, i) => {
        const c = i + 6;
        return { value: String(c), label: `${levelNameBn(c)} শ্রেণি` };
      }),
    });
    const subject = field(d, {
      label: 'বিষয়', name: 'subjectBn', required: true,
      placeholder: 'যেমন: পদার্থবিজ্ঞান',
      helper: 'পাঠ্যবইয়ে যে নামে আছে, সেই নাম লিখুন।',
    });
    const chapter = field(d, {
      label: 'অধ্যায় নম্বর', name: 'chapterNo', kind: 'number',
      attrs: { min: 1 }, helper: 'ঐচ্ছিক — দিলে ওই অধ্যায়ে সীমাবদ্ধ থাকবে।',
    });
    const notes = field(d, {
      label: 'অতিরিক্ত নির্দেশনা', name: 'instructions', kind: 'textarea',
      attrs: { rows: 3 }, helper: 'ঐচ্ছিক — যেমন "সহজ ভাষায়" বা "১০ নম্বরের"।',
    });
    append(form, task.root, level.root, subject.root, chapter.root, notes.root);

    append(form, buttonRow(d, button(d, {
      label: 'তৈরি করুন', variant: 'primary', type: 'submit', busy: this.busy,
    })));

    form.addEventListener('submit', (e) => {
      e.preventDefault();
      if (this.busy) return;
      clearFieldError(subject.root);
      if (!subject.value().trim()) {
        // Field-level, so the class and the instructions the person already
        // chose stay in front of them.
        setFieldError(subject.root, 'কোন বিষয়ের জন্য, সেটি লিখুন।');
        subject.input.focus();
        return;
      }
      void this.generate({
        taskType: task.value(),
        classLevel: Number(level.value()),
        subjectBn: subject.value().trim(),
        chapterNo: chapter.value() ? Number(chapter.value()) : null,
        instructions: notes.value().trim(),
      });
    });
    root.append(card(d, {
      title: 'কী চান', glyph: 'edit', headingLevel: 2,
    }, form));

    if (this.error) {
      root.append(el(d, 'p', {
        className: 'login-error', attrs: { role: 'alert' }, text: this.error,
      }));
    }

    if (this.output) {
      root.append(card(d, {
        title: 'তৈরি হয়েছে', glyph: 'book-open', headingLevel: 2,
        tone: this.grounded === false ? 'warn' : 'success',
        // Whether this came from the textbook corpus is a fact about how far
        // to trust it, so it sits beside the output rather than under it.
        action: this.grounded === false
          ? statusBadge(d, { state: 'pending', label: 'যাচাই করে নিন' })
          : statusBadge(d, { state: 'published', label: 'পাঠ্যক্রম-ভিত্তিক' }),
      },
        this.grounded === false
          ? el(d, 'p', {
              className: 'ui-card-note',
              text: 'পাঠ্যবই কর্পাস এখনো যুক্ত হয়নি — সাধারণ পাঠ্যক্রম-জ্ঞান থেকে তৈরি; ' +
                    'ব্যবহারের আগে যাচাই করুন।',
            })
          : null,
        // Preformatted text, not a Markdown engine: 04-UIUX's device budget
        // does not carry a parser for structure that reads fine as plain text.
        el(d, 'pre', { className: 'ai-output', text: this.output }),
      ));
    }
  }
}
