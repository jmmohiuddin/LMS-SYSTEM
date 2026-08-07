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

export interface ShikhoViewOptions {
  root: HTMLElement;
  doc: Document;
  auth: Auth;
}

interface Turn { role: 'user' | 'assistant'; text: string }

export class ShikhoView {
  private readonly o: ShikhoViewOptions;
  private turns: Turn[] = [];
  private busy = false;
  private error = '';
  private classLevel = 9;
  private draft = '';

  constructor(options: ShikhoViewOptions) {
    this.o = options;
    this.render();
  }

  private async send(message: string): Promise<void> {
    this.turns.push({ role: 'user', text: message });
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
      };
      if (res.ok && body.ok && body.reply) {
        this.turns.push({ role: 'assistant', text: body.reply });
      } else if (body.error === 'ai_disabled') {
        this.error = 'শিখো টিউটর এখনো চালু হয়নি — অ্যাডমিন চালু করলেই প্রশ্ন করা যাবে।';
      } else if (body.error === 'ai_refused') {
        this.turns.push({ role: 'assistant', text: 'এই প্রশ্নে সাহায্য করতে পারছি না — পড়াশোনার প্রশ্ন করো!' });
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
    h1.textContent = 'শিখো টিউটর';
    const sub = d.createElement('p');
    sub.className = 'att-sub';
    sub.textContent = 'উত্তর বলে দেয় না — বুঝে শিখতে সাহায্য করে';
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
      const bubble = d.createElement('div');
      bubble.className = t.role === 'user' ? 'chat-bubble chat-user' : 'chat-bubble chat-ai';
      bubble.textContent = t.text;
      chat.append(bubble);
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
      opt.textContent = String(c);
      opt.selected = c === this.classLevel;
      classSel.append(opt);
    }
    classSel.addEventListener('change', () => { this.classLevel = Number(classSel.value); });

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
