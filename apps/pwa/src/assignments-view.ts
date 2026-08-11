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
import {
  planCompression, checkMedia, formatDuration, MEDIA_PROBLEM_BN, MAX_VOICE_MS,
  type MediaDraft,
} from '../../../packages/ui-core/src/media.ts';

/**
 * F-902 kill switch. Mirrors SUBMISSION_MEDIA_ENABLED in the sync applier
 * and SCRIPT_STORAGE_ENABLED in scripts.ts: this deployment has no object
 * storage, so captured bytes would have nowhere to go. Flip both when an
 * R2/S3 credential lands.
 */
export const SUBMISSION_MEDIA_ENABLED = false;


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
  gradedByName: string | null;
  /** F-103. Must be echoed back when grading, or the server refuses. */
  rowVersion: number;
}

/**
 * F-103. What the server returns when someone else graded the same script
 * first. Held in view state until a teacher resolves it — the client never
 * picks a winner either.
 */
interface GradeConflict {
  submissionId: string;
  currentRowVersion: number;
  yours: { marksAwarded: number; feedbackBn: string | null };
  theirs: {
    marksAwarded: string | null;
    feedbackBn: string | null;
    gradedAt: string | null;
    gradedByName: string | null;
  };
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
  /**
   * Wireframe §6.6's [ বাকি ] [ জমা ] [ মূল্যায়িত ] filter. A student with
   * twenty assignments across a term opens this screen to answer one
   * question — "what do I still owe?" — and an undifferentiated list makes
   * them scan every card to find out.
   */
  private filter: 'pending' | 'submitted' | 'graded' = 'pending';
  private detail: Detail | null = null;
  private openId: string | null = null;
  private loading = true;
  private offline = false;
  private notice: string | null = '';
  private draft = '';
  private draftStatusEl: HTMLElement | null = null;
  /** F-902. Set when a photo or voice answer has been captured for this assignment. */
  private mediaDraft: MediaDraft & { objectKey: string } | null = null;
  private mediaNotice = '';
  private recorder: MediaRecorder | null = null;
  private recStartedAt = 0;
  /** F-103. Non-null while a grading race is waiting on a human. */
  private conflict: GradeConflict | null = null;

  /** Per-assignment autosave key (§6.6: "drafts autosave continuously"). */
  private draftKey(assignmentId: string): string {
    return `shikhon_assign_draft_${assignmentId}`;
  }

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
      // A locally-autosaved draft is unsent work in progress — it wins over
      // the last submitted body, because it is what the student was in the
      // middle of writing when the tab closed or the phone died.
      try {
        const saved = localStorage.getItem(this.draftKey(id));
        if (saved !== null) this.draft = saved;
      } catch { /* private mode — fall back to in-memory draft */ }
      this.offline = false;
    } catch {
      this.offline = true;
    }
    this.loading = false;
    this.render();
  }

  private async submit(): Promise<void> {
    // F-902. A photo or a spoken answer is a complete submission on its own —
    // a student who photographs a page of working has not failed to answer.
    if (!this.detail || (!this.draft.trim() && !this.mediaDraft)) return;
    try {
      const m = this.mediaDraft;
      await this.o.outbox.enqueue({
        entity: 'assignment_submission',
        payload: {
          assignmentId: this.detail.assignment.id,
          bodyBn: this.draft.trim() || null,
          ...(m ? {
            mediaKey: m.objectKey, mediaKind: m.kind, mediaBytes: m.bytes,
            mediaDurationMs: m.durationMs ?? null, mediaSha256: m.sha256 ?? null,
          } : {}),
        },
      });
      void Promise.resolve(this.o.outbox.flush()).catch(() => {});
      // Submitted: the autosaved draft has served its purpose. Clear it so a
      // stale draft can never resurrect over the answer that was actually
      // sent. (A later edit starts a fresh draft, and a fresh version.)
      try { localStorage.removeItem(this.draftKey(this.detail.assignment.id)); } catch { /* ignore */ }
      this.notice = 'জমা হয়েছে ✓ (অফলাইন হলে সংযোগ ফিরলে পাঠানো হবে)';
    } catch {
      this.notice = 'জমা দেওয়া যায়নি — আবার চেষ্টা করুন।';
    }
    this.render();
  }

  /**
   * Photograph a page of handwritten work.
   *
   * The compression ladder in ui-core/media decides the trade; this method
   * only supplies the encoder and reports the outcome. A camera JPEG is
   * routinely 4 MB and will not complete an upload on 3G, so nothing is
   * accepted until it is under 250 KB — and if it never gets there, the
   * student is told to retake it rather than handed a queued upload that
   * will fail hours later.
   */
  private async capturePhoto(assignmentId: string): Promise<void> {
    this.mediaNotice = '';
    const d = this.o.doc;
    const input = d.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    // Prefers the rear camera on a phone; on a desktop it is an ordinary
    // file picker, which is what a teacher testing the flow will get.
    input.setAttribute('capture', 'environment');
    const file: File | null = await new Promise((resolve) => {
      input.addEventListener('change', () => resolve(input.files?.[0] ?? null), { once: true });
      input.click();
    });
    if (!file) return;

    try {
      const bitmap = await createImageBitmap(file);
      let lastBlob: Blob | null = null;
      const plan = await planCompression(async (longestEdge, quality) => {
        const scale = Math.min(1, longestEdge / Math.max(bitmap.width, bitmap.height));
        const canvas = d.createElement('canvas');
        canvas.width = Math.round(bitmap.width * scale);
        canvas.height = Math.round(bitmap.height * scale);
        const ctx = canvas.getContext('2d');
        if (!ctx) return 0;
        ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
        lastBlob = await new Promise<Blob | null>((r) =>
          canvas.toBlob((b) => r(b), 'image/jpeg', quality));
        return lastBlob?.size ?? 0;
      });
      if (!plan || !lastBlob) {
        this.mediaNotice = MEDIA_PROBLEM_BN.too_large;
        this.render();
        return;
      }
      await this.holdMedia(assignmentId, lastBlob, { kind: 'photo', bytes: plan.bytes });
    } catch {
      this.mediaNotice = MEDIA_PROBLEM_BN.empty;
      this.render();
    }
  }

  /**
   * A spoken answer. Capped at 90 seconds by a timer as well as by
   * validation, because a phone that goes into a pocket mid-recording
   * would otherwise produce a file no 3G connection will ever send.
   */
  private async toggleVoice(assignmentId: string): Promise<void> {
    this.mediaNotice = '';
    if (this.recorder) { this.recorder.stop(); return; }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const rec = new MediaRecorder(stream);
      const chunks: Blob[] = [];
      this.recStartedAt = Date.now();
      rec.addEventListener('dataavailable', (e) => { if (e.data.size) chunks.push(e.data); });
      rec.addEventListener('stop', () => {
        // Release the microphone. A PWA holding the mic open after
        // recording shows a permanent recording indicator, which reads as
        // the app listening to a child's home.
        for (const t of stream.getTracks()) t.stop();
        const durationMs = Date.now() - this.recStartedAt;
        this.recorder = null;
        void this.holdMedia(assignmentId, new Blob(chunks, { type: rec.mimeType }),
                            { kind: 'voice', bytes: chunks.reduce((n, c) => n + c.size, 0), durationMs });
      });
      rec.start();
      this.recorder = rec;
      globalThis.setTimeout(() => { if (this.recorder === rec) rec.stop(); }, MAX_VOICE_MS);
      this.render();
    } catch {
      this.mediaNotice = 'মাইক্রোফোন ব্যবহারের অনুমতি পাওয়া যায়নি।';
      this.render();
    }
  }

  /**
   * Validate, hash, and hold a capture until the student presses submit.
   *
   * The object key is built from ids only — never a filename. A camera
   * supplies names, and a name lands in every bucket listing and access log
   * that touches the object; a photo of a child's homework should not
   * announce whose it is.
   */
  private async holdMedia(assignmentId: string, blob: Blob, draft: MediaDraft): Promise<void> {
    const sha256 = await sha256Hex(await blob.arrayBuffer());
    const problem = checkMedia({ ...draft, sha256 });
    if (problem) {
      this.mediaNotice = MEDIA_PROBLEM_BN[problem];
      this.render();
      return;
    }
    const ext = draft.kind === 'photo' ? 'jpg' : 'webm';
    this.mediaDraft = { ...draft, sha256, objectKey: `submissions/${assignmentId}/${sha256}.${ext}` };
    this.render();
  }

  private async grade(
    submissionId: string,
    marks: number,
    feedback: string,
    rowVersion: number,
  ): Promise<void> {
    try {
      const res = await this.o.auth.authedFetch('/api/v1/academics/assignments', {
        method: 'POST',
        // F-103: rowVersion is what the screen was showing. Without it the
        // server rejects the write rather than silently overwriting.
        body: JSON.stringify({ submissionId, marksAwarded: marks, feedbackBn: feedback, rowVersion }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        ok?: boolean; error?: string; message?: string; conflict?: GradeConflict;
      };
      if (res.ok && body.ok) {
        this.conflict = null;
        this.notice = 'নম্বর সংরক্ষিত ✓';
        if (this.openId) void this.openDetail(this.openId);
        return;
      }
      if (res.status === 409 && body.conflict) {
        // Not an error to dismiss — a decision to put in front of a person.
        this.conflict = body.conflict;
        this.notice = null;
        this.render();
        return;
      }
      this.notice = body.error === 'marks_exceed_max'
        ? 'নম্বর সর্বোচ্চ নম্বরের চেয়ে বেশি হতে পারে না।'
        : body.error === 'row_version_required'
          ? 'তালিকাটি পুরোনো — আবার লোড করে চেষ্টা করুন।'
          : 'সংরক্ষণ করা যায়নি।';
    } catch {
      this.notice = 'সংযোগে সমস্যা হয়েছে।';
    }
    this.render();
  }

  /**
   * The conflict card. Shows both marks side by side with the other
   * teacher's name, and offers exactly two choices — keep theirs, or
   * replace with mine. There is no "merge" and no automatic winner: this is
   * a child's grade, and a person decides whose mark stands.
   */
  private renderConflict(root: HTMLElement): void {
    const c = this.conflict;
    if (!c) return;
    const d = this.o.doc;

    const card = d.createElement('section');
    card.className = 'card grade-conflict';
    card.setAttribute('role', 'alertdialog');
    card.setAttribute('aria-label', 'নম্বরে দ্বন্দ্ব');

    const h = d.createElement('h3');
    h.textContent = 'এই খাতাটি ইতিমধ্যে অন্য কেউ দেখেছেন';
    card.append(h);

    const who = d.createElement('p');
    who.className = 'conflict-who';
    who.textContent = c.theirs.gradedByName
      ? `${c.theirs.gradedByName} নম্বর দিয়েছেন।`
      : 'অন্য একজন শিক্ষক নম্বর দিয়েছেন।';
    card.append(who);

    const table = d.createElement('dl');
    table.className = 'conflict-compare';
    const addRow = (label: string, mark: string, note: string | null) => {
      const dt = d.createElement('dt');
      dt.textContent = label;
      const dd = d.createElement('dd');
      dd.textContent = note ? `${mark} — ${note}` : mark;
      table.append(dt, dd);
    };
    addRow('তাঁদের নম্বর', bn(c.theirs.marksAwarded ?? '—'), c.theirs.feedbackBn);
    addRow('আপনার নম্বর', bn(c.yours.marksAwarded), c.yours.feedbackBn);
    card.append(table);

    const actions = d.createElement('div');
    actions.className = 'conflict-actions';

    const keep = d.createElement('button');
    keep.type = 'button';
    keep.className = 'btn-secondary';
    keep.textContent = 'তাঁদেরটি রাখুন';
    keep.addEventListener('click', () => {
      this.conflict = null;
      this.notice = 'আগের নম্বরই রাখা হয়েছে।';
      if (this.openId) void this.openDetail(this.openId);
    });

    const replace = d.createElement('button');
    replace.type = 'button';
    replace.className = 'btn-primary';
    replace.textContent = 'আমারটি দিয়ে বদলান';
    replace.addEventListener('click', () => {
      // Re-submits against the version the server just reported, so this
      // is a deliberate overwrite of a known value — not a blind retry.
      void this.grade(
        c.submissionId,
        c.yours.marksAwarded,
        c.yours.feedbackBn ?? '',
        c.currentRowVersion,
      );
    });

    actions.append(keep, replace);
    card.append(actions);
    root.append(card);
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

    root.append(this.filterBar());

    const shown = this.list.filter((a) => this.matchesFilter(a));
    if (shown.length === 0) {
      root.append(this.emptyForFilter());
      return;
    }

    const ul = d.createElement('ul');
    ul.className = 'assign-list';
    for (const a of shown) {
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
      this.openId = null; this.detail = null; this.notice = ''; this.conflict = null;
      void this.loadList();
    });
    bar.append(back);
    root.append(bar);

    if (this.loading || !this.detail) { root.append(this.msg('লোড হচ্ছে…')); return; }
    // Above everything else: an unresolved conflict is the only thing on
    // this screen that is waiting on the teacher.
    this.renderConflict(root);
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
    const assignmentId = a.id;
    ta.addEventListener('input', () => {
      this.draft = ta.value;
      // Autosave continuously (§6.6). localStorage is synchronous and an
      // answer is a few KB — a student on a dying battery or a flaky signal
      // must not lose typed work to a backgrounded, evicted tab. An emptied
      // field clears the key, so "I deleted it" is not later "restored".
      try {
        if (ta.value) localStorage.setItem(this.draftKey(assignmentId), ta.value);
        else localStorage.removeItem(this.draftKey(assignmentId));
      } catch { /* private mode / quota — the in-memory draft still holds */ }
      if (this.draftStatusEl) this.draftStatusEl.textContent = ta.value ? 'খসড়া সংরক্ষিত' : '';
    });
    label.append(ta);

    // Reassures the student their work is kept even before they submit —
    // the whole point of autosave is that they can trust leaving the screen.
    const status = d.createElement('span');
    status.className = 'assign-draft-status';
    status.setAttribute('aria-live', 'polite');
    status.textContent = this.draft ? 'খসড়া সংরক্ষিত' : '';
    this.draftStatusEl = status;

    const send = d.createElement('button');
    send.type = 'button';
    send.className = 'btn-primary';
    send.textContent = mine ? 'উত্তর হালনাগাদ করো' : 'জমা দাও';
    send.addEventListener('click', () => { void this.submit(); });

    form.append(label, status);
    const media = this.renderCapture(a.id);
    if (media) form.append(media);
    form.append(send);
    root.append(form);
  }

  /**
   * F-902. Photo of handwritten work, or a spoken answer.
   *
   * Returns null when the deployment has no object storage, which is the
   * current state: the bytes would name a blob that can never be fetched.
   * Rendering a disabled camera button instead would be worse than
   * rendering nothing — it advertises a capability the school does not
   * have and invites a student to lose work discovering that.
   *
   * The sync applier refuses media independently (SUBMISSION_MEDIA_ENABLED
   * there), so this is presentation, not enforcement.
   */
  private renderCapture(assignmentId: string): HTMLElement | null {
    if (!SUBMISSION_MEDIA_ENABLED) return null;
    const d = this.o.doc;
    const row = d.createElement('div');
    row.className = 'assign-capture';

    const photo = d.createElement('button');
    photo.type = 'button';
    photo.className = 'btn-secondary';
    photo.textContent = 'ছবি তোলো';
    photo.addEventListener('click', () => { void this.capturePhoto(assignmentId); });

    const voice = d.createElement('button');
    voice.type = 'button';
    voice.className = 'btn-secondary';
    voice.textContent = this.recorder ? 'রেকর্ডিং থামাও' : 'বলে উত্তর দাও';
    voice.addEventListener('click', () => { void this.toggleVoice(assignmentId); });

    row.append(photo, voice);

    if (this.mediaDraft) {
      const held = d.createElement('p');
      held.className = 'assign-capture-held';
      held.textContent = this.mediaDraft.kind === 'photo'
        ? `ছবি যুক্ত হয়েছে (${Math.round(this.mediaDraft.bytes / 1024)} কিলোবাইট)`
        : `রেকর্ডিং যুক্ত হয়েছে (${formatDuration(this.mediaDraft.durationMs ?? 0)})`;
      const drop = d.createElement('button');
      drop.type = 'button';
      drop.className = 'btn-ghost';
      drop.textContent = 'সরাও';
      drop.addEventListener('click', () => { this.mediaDraft = null; this.render(); });
      row.append(held, drop);
    }
    if (this.mediaNotice) {
      const n = d.createElement('p');
      n.className = 'inline-notice is-danger';
      n.setAttribute('role', 'alert');
      n.textContent = this.mediaNotice;
      row.append(n);
    }
    return row;
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
          void this.grade(s.id, m, fb.value.trim(), s.rowVersion);
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

  /** Which bucket an assignment falls in, from the student's point of view. */
  private matchesFilter(a: Assignment): boolean {
    if (this.isStaff) {
      // Staff read the same three buckets as marking progress, not as debt.
      if (this.filter === 'pending')   return a.ungradedCount > 0;
      if (this.filter === 'submitted') return a.submissionCount > 0;
      return a.submissionCount > 0 && a.ungradedCount === 0;
    }
    const sub = a.mySubmission;
    if (this.filter === 'pending')   return sub === null;
    if (this.filter === 'submitted') return sub !== null && !sub.gradedAt;
    return sub !== null && !!sub.gradedAt;
  }

  private countFor(f: 'pending' | 'submitted' | 'graded'): number {
    const was = this.filter;
    this.filter = f;
    const n = this.list.filter((a) => this.matchesFilter(a)).length;
    this.filter = was;
    return n;
  }

  /**
   * A segmented control, not a dropdown: three options that must all be
   * visible and reachable in one tap. Each tab carries its count, so the
   * student knows there is nothing under a tab before opening it.
   */
  private filterBar(): HTMLElement {
    const d = this.o.doc;
    const bar = d.createElement('div');
    bar.className = 'seg-bar';
    bar.setAttribute('role', 'tablist');
    bar.setAttribute('aria-label', 'বাড়ির কাজের অবস্থা');

    const tabs: [typeof this.filter, string][] = this.isStaff
      ? [['pending', 'দেখা বাকি'], ['submitted', 'জমা হয়েছে'], ['graded', 'সব দেখা']]
      : [['pending', 'বাকি'], ['submitted', 'জমা'], ['graded', 'মূল্যায়িত']];

    for (const [key, label] of tabs) {
      const b = d.createElement('button');
      b.type = 'button';
      b.className = 'seg-opt';
      b.setAttribute('role', 'tab');
      const active = this.filter === key;
      b.setAttribute('aria-selected', String(active));
      if (active) b.dataset.active = 'true';
      const n = this.countFor(key);
      b.textContent = n > 0 ? `${label} ${bn(n)}` : label;
      b.setAttribute('aria-label', `${label}, ${bn(n)}টি`);
      b.addEventListener('click', () => { this.filter = key; this.render(); });
      bar.append(b);
    }
    return bar;
  }

  private emptyForFilter(): HTMLElement {
    const d = this.o.doc;
    const box = d.createElement('div');
    box.className = 'empty-state';
    const g = d.createElement('div');
    g.className = 'empty-glyph';
    g.setAttribute('aria-hidden', 'true');
    // "Nothing pending" is good news and should not look like an error.
    g.textContent = this.filter === 'pending' ? '✓' : '⃝';
    const p = d.createElement('p');
    p.textContent = this.isStaff
      ? { pending: 'সব খাতা দেখা হয়েছে।', submitted: 'এখনো কেউ জমা দেয়নি।',
          graded: 'এখনো কিছু মূল্যায়ন করা হয়নি।' }[this.filter]
      : { pending: 'কোনো কাজ বাকি নেই।', submitted: 'জমা দেওয়া কোনো কাজ নেই।',
          graded: 'এখনো কোনো কাজ মূল্যায়িত হয়নি।' }[this.filter];
    box.append(g, p);
    return box;
  }

  private msg(text: string): HTMLElement {
    const p = this.o.doc.createElement('p');
    p.className = 'page-sub empty';
    p.textContent = text;
    return p;
  }
}

/** Content hash, so a retry after a dropped connection is the same object. */
async function sha256Hex(buf: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
