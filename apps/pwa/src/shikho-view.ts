/**
 * ShikhoAI (শিখো) — the student Socratic tutor chat.
 *
 * A minimal chat over POST /api/v1/ai/shikho. Stateless per turn on the
 * wire (the server logs sessions for audit; conversational memory is a
 * follow-on) — the transcript here is for the reader, and the tutor's
 * Socratic system prompt does the pedagogy. Handles the ai_disabled 503
 * with a friendly banner so the page ships before the API key does.
 */
import type { Auth } from './auth.ts';
import { formatCount } from '../../../packages/ui-core/src/format.ts';

export interface ShikhoViewOptions {
  root: HTMLElement;
  doc: Document;
  auth: Auth;
}

/**
 * A turn in the transcript. An assistant turn always carries WHAT KIND of
 * answer it is — §6.7 admits no unmarked reply:
 *   grounded    — the retrieval found NCTB passages; `sources` names them
 *   ungrounded  — answered from general curriculum knowledge, said out loud
 *   refused     — the model declined; an honest state, not an error
 *   unavailable — offline or the service is dark (F-1311), never a hang
 */
type TurnKind = 'grounded' | 'ungrounded' | 'refused' | 'unavailable';
interface Turn {
  role: 'user' | 'assistant';
  text: string;
  kind?: TurnKind;
  sources?: string[];
}

export class ShikhoView {
  private readonly o: ShikhoViewOptions;
  private turns: Turn[] = [];
  private busy = false;
  private error = '';
  private classLevel = 9;
  private draft = '';

  /** True when the device has cached lessons/practice to fall back on. */
  private hasCachedStudy(): boolean {
    try {
      return Object.keys(localStorage).some(
        (k) => k.startsWith('shikhon_practice_') || k.startsWith('shikhon_topic_cache_'),
      );
    } catch { return false; }
  }

  constructor(options: ShikhoViewOptions) {
    this.o = options;
    this.render();
  }

  private async send(message: string): Promise<void> {
    this.turns.push({ role: 'user', text: message });

    // F-1311: offline is answered from here, not by letting a doomed request
    // hang. The student is told plainly and pointed at what still works.
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      this.turns.push({
        role: 'assistant', kind: 'unavailable',
        text: 'এখন ইন্টারনেট নেই, তাই শিখো টিউটর উত্তর দিতে পারছে না। সংযোগ ফিরলে আবার জিজ্ঞাসা করো।',
      });
      this.render();
      return;
    }

    this.busy = true;
    this.error = '';
    this.render();
    try {
      const res = await this.o.auth.authedFetch('/api/v1/ai/shikho', {
        method: 'POST',
        body: JSON.stringify({ message, classLevel: this.classLevel }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        ok?: boolean; reply?: string; error?: string;
        grounded?: boolean; sources?: string[];
      };
      if (res.ok && body.ok && body.reply) {
        // Every reply is labelled. A grounded one names its textbook
        // sections; an ungrounded one says so rather than passing general
        // model knowledge off as the syllabus (F-1302).
        this.turns.push({
          role: 'assistant',
          text: body.reply,
          kind: body.grounded ? 'grounded' : 'ungrounded',
          sources: body.sources ?? [],
        });
      } else if (body.error === 'ai_disabled') {
        this.turns.push({
          role: 'assistant', kind: 'unavailable',
          text: 'শিখো টিউটর এখনো চালু হয়নি — স্কুল চালু করলেই প্রশ্ন করা যাবে।',
        });
      } else if (body.error === 'ai_refused') {
        this.turns.push({
          role: 'assistant', kind: 'refused',
          text: 'এই প্রশ্নে সাহায্য করতে পারছি না। পড়াশোনার প্রশ্ন করো, বা শিক্ষককে জিজ্ঞাসা করো।',
        });
      } else {
        this.error = 'সংযোগে সমস্যা হয়েছে। আবার চেষ্টা করুন।';
      }
    } catch {
      // A failed request on a live connection is a connection problem; a
      // failed request with no connection is the offline state above.
      this.turns.push({
        role: 'assistant', kind: 'unavailable',
        text: 'উত্তর আনা গেল না — সংযোগ পরীক্ষা করে আবার চেষ্টা করো।',
      });
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
    h1.textContent = 'শিখো টিউটর';
    const sub = d.createElement('p');
    sub.className = 'att-sub';
    // §6.7: the scope is pinned and VISIBLE, so the student understands the
    // boundary the tutor is answering inside rather than discovering it.
    sub.textContent = `${formatCount(this.classLevel, 'bn')} শ্রেণির পাঠ্যসূচি · উত্তর বলে দেয় না, বুঝিয়ে দেয়`;
    header.append(h1, sub);
    root.append(header);

    const chat = d.createElement('div');
    chat.className = 'chat-log';
    if (this.turns.length === 0) {
      const hint = d.createElement('p');
      hint.className = 'att-sub';
      hint.textContent = 'যেকোনো পড়াশোনার প্রশ্ন করো — বাংলা, English বা Banglish-এ।';
      chat.append(hint);
    }
    for (const t of this.turns) {
      if (t.role === 'user') {
        const bubble = d.createElement('div');
        bubble.className = 'chat-bubble chat-user';
        bubble.textContent = t.text;
        chat.append(bubble);
        continue;
      }

      // An assistant turn is a bubble plus its state line. The state line is
      // not decoration: it is how a student knows whether they are reading
      // their textbook or the model's general knowledge.
      const wrap = d.createElement('div');
      wrap.className = 'chat-answer';
      wrap.dataset.kind = t.kind ?? 'ungrounded';

      const bubble = d.createElement('div');
      bubble.className = 'chat-bubble chat-ai';
      bubble.textContent = t.text;
      wrap.append(bubble);

      const state = d.createElement('p');
      state.className = 'chat-source';
      if (t.kind === 'grounded') {
        state.textContent = t.sources && t.sources.length > 0
          ? `✓ NCTB পাঠ্যবই — ${t.sources.join(' · ')}`
          : '✓ NCTB পাঠ্যবই থেকে';
      } else if (t.kind === 'ungrounded') {
        // Honest, and deliberately not alarming: this is a normal state, it
        // just is not the textbook, and the student is told where to check.
        state.textContent = 'পাঠ্যবইয়ের নির্দিষ্ট অংশ পাওয়া যায়নি — বইয়ের সাথে মিলিয়ে নিও।';
      } else if (t.kind === 'refused') {
        state.textContent = 'এই প্রশ্নের উত্তর দেওয়া হয়নি।';
      } else {
        state.textContent = 'উত্তর দেওয়া যায়নি।';
      }
      wrap.append(state);

      // F-1311: offline does not dead-end. When the device has lessons or
      // practice already cached, point at them instead of leaving the
      // student staring at a tutor that cannot answer.
      if (t.kind === 'unavailable' && this.hasCachedStudy()) {
        const go = d.createElement('button');
        go.type = 'button';
        go.className = 'btn-secondary btn-small chat-offline-cta';
        go.textContent = 'সংরক্ষিত পাঠ ও অনুশীলন দেখো';
        go.addEventListener('click', () => { location.hash = '#/learn'; });
        wrap.append(go);
      }

      chat.append(wrap);
    }
    if (this.busy) {
      const typing = d.createElement('div');
      typing.className = 'chat-bubble chat-ai chat-typing';
      typing.textContent = 'ভাবছি…';
      chat.append(typing);
    }
    root.append(chat);

    if (this.error) {
      const err = d.createElement('p');
      err.className = 'login-error';
      err.setAttribute('role', 'alert');
      err.hidden = false;
      err.textContent = this.error;
      root.append(err);
    }

    const form = d.createElement('form');
    form.className = 'chat-form';

    const classSel = d.createElement('select');
    classSel.className = 'chat-class';
    classSel.setAttribute('aria-label', 'শ্রেণি');
    for (let c = 6; c <= 12; c += 1) {
      const opt = d.createElement('option');
      opt.value = String(c);
      // Bangla digits, like every other number this product shows a student.
      opt.textContent = formatCount(c, 'bn');
      opt.selected = c === this.classLevel;
      classSel.append(opt);
    }
    // Re-render: the header states the scope, so it must not go stale the
    // moment the student changes the class they are asking about.
    classSel.addEventListener('change', () => {
      this.classLevel = Number(classSel.value);
      this.render();
    });

    const input = d.createElement('input');
    input.type = 'text';
    input.className = 'chat-input';
    input.placeholder = 'তোমার প্রশ্ন লেখো…';
    input.value = this.draft;
    input.addEventListener('input', () => { this.draft = input.value; });

    const send = d.createElement('button');
    send.type = 'submit';
    send.className = 'btn-primary chat-send';
    send.textContent = 'পাঠাও';
    send.disabled = this.busy;

    form.append(classSel, input, send);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const msg = input.value.trim();
      if (!msg || this.busy) return;
      this.draft = '';
      void this.send(msg);
    });
    root.append(form);

    chat.scrollTop = chat.scrollHeight;
    if (!this.busy) input.focus();
  }
}
