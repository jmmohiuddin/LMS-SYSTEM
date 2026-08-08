/**
 * Assignments (বাড়ির কাজ) — homework inbox and submission.
 *
 * One view, two audiences, because the underlying object is the same and
 * splitting them would duplicate the list/detail plumbing:
 *
 *   student — inbox sorted by urgency, tap to read and write an answer
 *   staff   — same list with submission counts, tap to review and grade
 *
 * Submissions go through the offline outbox, never a direct POST: a
 * student typing an answer on a phone with no signal must not lose it.
 * Grading is a normal authenticated POST — a teacher marking work is at a
 * desk far more often than not, and grading offline would risk two
 * teachers' marks silently diverging.
 */
import type { Auth } from './auth.ts';
import { formatCount } from '../../../packages/ui-core/src/format.ts';

interface Assignment {
  id: string;
  titleBn: string;
  dueAt: string;
  status: string;
  maxMarks: string | null;
  subjectBn: string;
  sectionName: string;
  submissionCount: number;
  ungradedCount: number;
  mySubmission: { submittedAt: string; marksAwarded: string | null; gradedAt: string | null } | null;
}

interface Submission {
  id: string;
  studentId: string;
  fullNameBn: string | null;
  rollNo: number | null;
  bodyBn: string | null;
  submittedAt: string;
  isLate: boolean;
  marksAwarded: string | null;
  feedbackBn: string | null;
  gradedAt: string | null;
}

interface Detail {
  assignment: {
    id: string; titleBn: string; instructionsBn: string | null;
    maxMarks: string | null; dueAt: string; allowsLate: boolean;
    status: string; subjectBn: string; sectionName: string;
  };
  submissions: Submission[];
}

export interface AssignmentsOutbox {
  enqueue(input: { entity: 'assignment_submission'; payload: unknown }): Promise<{ opId: string }>;
  flush(): Promise<unknown>;
}

export interface AssignmentsViewOptions {
  root: HTMLElement;
  doc: Document;
  auth: Auth;
  outbox: AssignmentsOutbox;
}

const CACHE_KEY = 'shikhon_assignments_cache';

const BN: Record<string, string> = { '0':'০','1':'১','2':'২','3':'৩','4':'৪','5':'৫','6':'৬','7':'৭','8':'৮','9':'৯' };
function bn(s: string | number | null | undefined): string {
  if (s === null || s === undefined || s === '') return '—';
  return String(s).replace(/[0-9]/g, (d) => BN[d] ?? d);
}

/** "৩ দিন বাকি" / "আজ শেষ" / "২ দিন দেরি" — urgency in words, not a raw date. */
function dueLabel(dueAt: string): { text: string; state: 'overdue' | 'today' | 'soon' | 'later' } {
  const ms = Date.parse(dueAt) - Date.now();
  const days = Math.floor(ms / 86400000);
  if (ms < 0) {
    const late = Math.abs(days) || 1;
    return { text: `${bn(late)} দিন পার`, state: 'overdue' };
  }
  if (days === 0) return { text: 'আজ শেষ', state: 'today' };
  if (days <= 2) return { text: `${bn(days)} দিন বাকি`, state: 'soon' };
  return { text: `${bn(days)} দিন বাকি`, state: 'later' };
}

export class AssignmentsView {
  private readonly o: AssignmentsViewOptions;
  private list: Assignment[] = [];
  private detail: Detail | null = null;
  private openId: string | null = null;
  private loading = true;
  private offline = false;
  private notice = '';
  private draft = '';

  constructor(options: AssignmentsViewOptions) {
    this.o = options;
    void this.loadList();
  }

  private get isStaff(): boolean {
    return !['student', 'guardian'].includes(this.o.auth.role);
  }

  private async loadList(): Promise<void> {
    try {
      const raw = localStorage.getItem(CACHE_KEY);
      if (raw) { this.list = JSON.parse(raw) as Assignment[]; this.loading = false; }
    } catch { /* cache is a nicety */ }
    this.render();

    try {
      const res = await this.o.auth.authedFetch('/api/v1/academics/assignments');
      if (!res.ok) throw new Error(String(res.status));
      const body = (await res.json()) as { assignments: Assignment[] };
      this.list = body.assignments;
      this.offline = false;
      try { localStorage.setItem(CACHE_KEY, JSON.stringify(this.list)); } catch { /* ignore */ }
    } catch {
      this.offline = this.list.length > 0;
    }
    this.loading = false;
    this.render();
  }

  private async openDetail(id: string): Promise<void> {
    this.openId = id;
    this.detail = null;
    this.notice = '';
    this.draft = '';
    this.loading = true;
    this.render();
    try {
      const res = await this.o.auth.authedFetch(
        `/api/v1/academics/assignments?assignmentId=${encodeURIComponent(id)}`,
      );
      if (!res.ok) throw new Error(String(res.status));
      this.detail = (await res.json()) as Detail;
      // Pre-fill with the student's existing answer so editing is natural.
      const mine = this.detail.submissions.find((s) => s.studentId === this.o.auth.userId);
      if (mine?.bodyBn) this.draft = mine.bodyBn;
      this.offline = false;
    } catch {
      this.offline = true;
    }
    this.loading = false;
    this.render();
  }

  private async submit(): Promise<void> {
    if (!this.detail || !this.draft.trim()) return;
    try {
      await this.o.outbox.enqueue({
        entity: 'assignment_submission',
        payload: { assignmentId: this.detail.assignment.id, bodyBn: this.draft.trim() },
      });
      void Promise.resolve(this.o.outbox.flush()).catch(() => {});
      this.notice = 'জমা হয়েছে ✓ (অফলাইন হলে সংযোগ ফিরলে পাঠানো হবে)';
    } catch {
      this.notice = 'জমা দেওয়া যায়নি — আবার চেষ্টা করুন।';
    }
    this.render();
  }

  private async grade(submissionId: string, marks: number, feedback: string): Promise<void> {
    try {
      const res = await this.o.auth.authedFetch('/api/v1/academics/assignments', {
        method: 'POST',
        body: JSON.stringify({ submissionId, marksAwarded: marks, feedbackBn: feedback }),
      });
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (res.ok && body.ok) {
        this.notice = 'নম্বর সংরক্ষিত ✓';
        if (this.openId) void this.openDetail(this.openId);
        return;
      }
      this.notice = body.error === 'grade_rejected'
        ? 'নম্বর সর্বোচ্চ নম্বরের চেয়ে বেশি হতে পারে না।'
        : 'সংরক্ষণ করা যায়নি।';
    } catch {
      this.notice = 'সংযোগে সমস্যা হয়েছে।';
    }
    this.render();
  }

  /* -------------------------------------------------------------- render */

  private render(): void {
    if (this.openId) { this.renderDetail(); return; }
    const d = this.o.doc;
    const root = this.o.root;
    root.textContent = '';

    const header = d.createElement('header');
    header.className = 'page-header';
    const h1 = d.createElement('h1');
    h1.textContent = 'বাড়ির কাজ';
    const sub = d.createElement('p');
    sub.className = 'page-sub';
    sub.textContent = this.isStaff ? 'দেওয়া কাজ ও জমা পড়া উত্তর' : 'তোমার জমা দিতে হবে যেসব';
    header.append(h1, sub);
    root.append(header);

    if (this.offline) root.append(this.banner('অফলাইন — সংরক্ষিত তালিকা দেখানো হচ্ছে', 'inline-notice'));
    if (this.loading && this.list.length === 0) { root.append(this.msg('লোড হচ্ছে…')); return; }
    if (this.list.length === 0) {
      root.append(this.msg(this.isStaff ? 'এখনো কোনো কাজ দেওয়া হয়নি।' : 'এখন কোনো বাড়ির কাজ নেই।'));
      return;
    }

    const ul = d.createElement('ul');
    ul.className = 'assign-list';
    for (const a of this.list) {
      const li = d.createElement('li');
      const btn = d.createElement('button');
      btn.type = 'button';
      btn.className = 'card assign-card';

      const due = dueLabel(a.dueAt);
      // A submitted assignment is no longer urgent, whatever the clock says.
      const done = !this.isStaff && a.mySubmission !== null;
      btn.dataset.state = done ? 'done' : due.state;

      const body = d.createElement('span');
      body.className = 'assign-body';
      const title = d.createElement('span');
      title.className = 'assign-title';
      title.textContent = a.titleBn;
      const meta = d.createElement('span');
      meta.className = 'assign-meta';
      meta.textContent = this.isStaff
        ? `${a.subjectBn} · ${a.sectionName} · ${bn(a.submissionCount)} জমা`
        : a.subjectBn;
      body.append(title, meta);

      const chip = d.createElement('span');
      chip.className = 'assign-chip';
      if (this.isStaff) {
        chip.dataset.state = a.ungradedCount > 0 ? 'soon' : 'done';
        chip.textContent = a.ungradedCount > 0 ? `${bn(a.ungradedCount)} বাকি` : 'সব দেখা';
      } else if (done) {
        chip.dataset.state = 'done';
        chip.textContent = a.mySubmission?.gradedAt
          ? `${bn(a.mySubmission.marksAwarded)}${a.maxMarks ? `/${bn(a.maxMarks)}` : ''}`
          : 'জমা হয়েছে';
      } else {
        chip.dataset.state = due.state;
        chip.textContent = due.text;
      }

      btn.append(body, chip);
      btn.addEventListener('click', () => { void this.openDetail(a.id); });
      li.append(btn);
      ul.append(li);
    }
    root.append(ul);
  }

  private renderDetail(): void {
    const d = this.o.doc;
    const root = this.o.root;
    root.textContent = '';

    const bar = d.createElement('div');
    bar.className = 'back-bar';
    const back = d.createElement('button');
    back.type = 'button';
    back.className = 'btn-ghost back-btn';
    back.textContent = '← সব কাজ';
    back.addEventListener('click', () => {
      this.openId = null; this.detail = null; this.notice = '';
      void this.loadList();
    });
    bar.append(back);
    root.append(bar);

    if (this.loading || !this.detail) { root.append(this.msg('লোড হচ্ছে…')); return; }
    const a = this.detail.assignment;

    const header = d.createElement('header');
    header.className = 'page-header';
    const h1 = d.createElement('h1');
    h1.textContent = a.titleBn;
    const sub = d.createElement('p');
    sub.className = 'page-sub';
    const due = dueLabel(a.dueAt);
    sub.textContent = `${a.subjectBn} · ${due.text}${a.maxMarks ? ` · সর্বোচ্চ ${bn(a.maxMarks)}` : ''}`;
    header.append(h1, sub);
    root.append(header);

    if (a.instructionsBn) {
      const card = d.createElement('div');
      card.className = 'card assign-instructions';
      card.textContent = a.instructionsBn;
      root.append(card);
    }

    if (this.notice) root.append(this.banner(this.notice, 'inline-notice'));

    if (this.isStaff) { this.renderSubmissionList(root); return; }

    /* ------------------------------------------------------ student answer */
    const mine = this.detail.submissions.find((s) => s.studentId === this.o.auth.userId);

    if (mine?.gradedAt) {
      const graded = d.createElement('div');
      graded.className = 'card assign-graded';
      const score = d.createElement('div');
      score.className = 'assign-score';
      score.textContent = `${bn(mine.marksAwarded)}${a.maxMarks ? ` / ${bn(a.maxMarks)}` : ''}`;
      graded.append(score);
      if (mine.feedbackBn) {
        const fb = d.createElement('p');
        fb.className = 'assign-feedback';
        fb.textContent = mine.feedbackBn;
        graded.append(fb);
      }
      root.append(graded);
      const answer = d.createElement('div');
      answer.className = 'card assign-instructions';
      answer.textContent = mine.bodyBn ?? '';
      root.append(answer);
      return;
    }

    const closed = !a.allowsLate && Date.parse(a.dueAt) < Date.now();
    if (closed) {
      root.append(this.banner('সময় শেষ — এই কাজটি আর জমা নেওয়া হচ্ছে না।', 'inline-notice'));
      return;
    }

    const form = d.createElement('div');
    form.className = 'card card-form';
    const label = d.createElement('label');
    label.className = 'field';
    label.append(d.createTextNode('তোমার উত্তর'));
    const ta = d.createElement('textarea');
    ta.className = 'field-input assign-answer';
    ta.rows = 8;
    ta.value = this.draft;
    ta.placeholder = 'এখানে লেখো…';
    ta.addEventListener('input', () => { this.draft = ta.value; });
    label.append(ta);

    const send = d.createElement('button');
    send.type = 'button';
    send.className = 'btn-primary';
    send.textContent = mine ? 'উত্তর হালনাগাদ করো' : 'জমা দাও';
    send.addEventListener('click', () => { void this.submit(); });

    form.append(label, send);
    root.append(form);
  }

  private renderSubmissionList(root: HTMLElement): void {
    const d = this.o.doc;
    const subs = this.detail?.submissions ?? [];
    if (subs.length === 0) { root.append(this.msg('এখনো কেউ জমা দেয়নি।')); return; }

    const ul = d.createElement('ul');
    ul.className = 'sub-list';
    for (const s of subs) {
      const li = d.createElement('li');
      li.className = 'card sub-item';
      li.dataset.graded = String(s.gradedAt !== null);

      const head = d.createElement('div');
      head.className = 'sub-head';
      const who = d.createElement('span');
      who.className = 'sub-who';
      who.textContent = `${s.rollNo ? bn(s.rollNo) + '. ' : ''}${s.fullNameBn ?? '—'}`;
      const state = d.createElement('span');
      state.className = 'sub-state';
      state.textContent = s.gradedAt
        ? `${bn(s.marksAwarded)} ✓`
        : s.isLate ? 'দেরিতে জমা' : 'অদেখা';
      if (s.isLate && !s.gradedAt) state.dataset.late = 'true';
      head.append(who, state);
      li.append(head);

      const body = d.createElement('p');
      body.className = 'sub-body';
      body.textContent = s.bodyBn ?? '(ছবি)';
      li.append(body);

      if (!s.gradedAt) {
        const row = d.createElement('div');
        row.className = 'sub-grade-row';
        const mark = d.createElement('input');
        mark.type = 'number';
        mark.className = 'field-input sub-mark';
        mark.min = '0';
        mark.step = '0.5';
        mark.placeholder = 'নম্বর';
        const fb = d.createElement('input');
        fb.type = 'text';
        fb.className = 'field-input sub-feedback';
        fb.placeholder = 'মন্তব্য (ঐচ্ছিক)';
        const save = d.createElement('button');
        save.type = 'button';
        save.className = 'btn-primary btn-small';
        save.textContent = 'দাও';
        save.addEventListener('click', () => {
          const m = Number(mark.value);
          if (!Number.isFinite(m) || m < 0) { this.notice = 'সঠিক নম্বর দিন।'; this.render(); return; }
          void this.grade(s.id, m, fb.value.trim());
        });
        row.append(mark, fb, save);
        li.append(row);
      } else if (s.feedbackBn) {
        const fb = d.createElement('p');
        fb.className = 'assign-feedback';
        fb.textContent = s.feedbackBn;
        li.append(fb);
      }
      ul.append(li);
    }
    root.append(ul);
  }

  private banner(text: string, cls: string): HTMLElement {
    const p = this.o.doc.createElement('p');
    p.className = cls;
    p.setAttribute('role', 'status');
    p.textContent = text;
    return p;
  }

  private msg(text: string): HTMLElement {
    const p = this.o.doc.createElement('p');
    p.className = 'page-sub empty';
    p.textContent = text;
    return p;
  }
}
