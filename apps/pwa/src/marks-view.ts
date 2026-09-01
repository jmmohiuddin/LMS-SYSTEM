/**
 * Offline-first marks entry (নম্বর tab).
 *
 * Read side: GET /api/v1/academics/exams?sectionId= feeds the exam-subject
 * picker; GET /api/v1/academics/marks?examSubjectId= feeds the entry grid,
 * cached in localStorage like roster-view.ts so the last-loaded sheet still
 * renders offline. Write side: the same outbox discipline as attendance —
 * each changed row becomes one `exam_mark` op (entity already supported by
 * the server applier, with optimistic concurrency on rowVersion), the UI
 * never awaits the network, and a published/locked exam renders read-only
 * because the server would conflict the write anyway.
 *
 * The section comes from shikhon_last_section (set by roster-view.ts) —
 * marks entry always follows "pick your section in the শিক্ষার্থী tab" first.
 */
import type { Auth } from './auth.ts';
import { formatCount } from '../../../packages/ui-core/src/format.ts';
import {
  el, append, icon, pageHeader, badge, emptyState, toast, humanError, field, listSkeleton,} from './ui/index.ts';

export interface ExamSubjectOption {
  examSubjectId: string;
  subject: { bn: string; en: string };
  cqMax: number;
  mcqMax: number;
  practicalMax: number;
  caMax: number;
  markingLocked: boolean;
}

export interface ExamSummary {
  id: string;
  nameBn: string;
  status: string;
  academicYearId: string;
  subjects: ExamSubjectOption[];
}

export interface MarkRow {
  rollNo: number;
  studentId: string;
  fullName: { bn: string | null; en: string | null };
  cqMarks: number | null;
  mcqMarks: number | null;
  practicalMarks: number | null;
  caMarks: number | null;
  isAbsent: boolean;
  rowVersion: number | null;
}

interface MarksResponse {
  academicYearId: string;
  examStatus: string;
  markingLocked: boolean;
  maxima: { cq: number; mcq: number; practical: number; ca: number };
  marks: MarkRow[];
}

type MarkKey = 'cqMarks' | 'mcqMarks' | 'practicalMarks' | 'caMarks';

/** Only what this view needs from the sync engine — keeps it testable. */
export interface MarksOutbox {
  enqueue(input: {
    entity: 'exam_mark';
    payload: unknown;
    baseVersion?: number;
  }): Promise<{ opId: string }>;
  flush(): Promise<unknown>;
}

export interface MarksViewOptions {
  root: HTMLElement;
  doc: Document;
  auth: Auth;
  outbox: MarksOutbox;
}

/** A rejection that still knows its HTTP status. Explicit field: strip-only. */
class HttpStatus extends Error {
  status: number;
  constructor(status: number) { super(String(status)); this.status = status; }
}

const EXAMS_CACHE_PREFIX = 'shikhon_exams_cache_';
const MARKS_CACHE_PREFIX = 'shikhon_marks_cache_';

export class MarksView {
  private readonly o: MarksViewOptions;
  private sectionId: string | null;
  private exams: ExamSummary[] = [];
  private selected: { exam: ExamSummary; subject: ExamSubjectOption } | null = null;
  private sheet: MarksResponse | null = null;
  private dirty = new Map<string, Partial<MarkRow>>();
  private offline = false;
  /** The server refused this read. Not an outage; no retry will help. */
  private denied = false;
  private loading = false;
  private savedAt = 0;
  private completeEl: HTMLElement | null = null;
  private activeKeys: MarkKey[] = [];

  constructor(options: MarksViewOptions) {
    this.o = options;
    this.sectionId = localStorage.getItem('shikhon_last_section');
    void this.init();
  }

  private async init(): Promise<void> {
    if (!this.sectionId) {
      this.render();
      return;
    }
    const cached = this.cacheGet<ExamSummary[]>(EXAMS_CACHE_PREFIX + this.sectionId);
    if (cached) this.exams = cached;
    this.render();
    try {
      const res = await this.o.auth.authedFetch(
        `/api/v1/academics/exams?sectionId=${encodeURIComponent(this.sectionId)}`,
      );
      if (!res.ok) throw new HttpStatus(res.status);
      const body = (await res.json()) as { exams: ExamSummary[] };
      this.exams = body.exams;
      this.offline = false;
      this.denied = false;
      this.cacheSet(EXAMS_CACHE_PREFIX + this.sectionId, this.exams);
    } catch (err) {
      const status = err instanceof HttpStatus ? err.status : undefined;
      // A refusal is not an offline state. Showing a cached exam list under
      // "সর্বশেষ সংরক্ষিত" to somebody the server just refused says the
      // opposite of what the server said, and offers a retry that cannot work.
      this.denied = status === 403;
      if (this.denied) { this.exams = []; this.sheet = null; }
      this.offline = !this.denied && this.exams.length > 0;
    }
    this.render();
  }

  private cacheGet<T>(key: string): T | null {
    try {
      const raw = localStorage.getItem(key);
      return raw ? (JSON.parse(raw) as T) : null;
    } catch {
      return null;
    }
  }

  private cacheSet(key: string, value: unknown): void {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // best-effort cache
    }
  }

  private async loadSheet(examSubjectId: string): Promise<void> {
    this.loading = true;
    this.dirty.clear();
    const cached = this.cacheGet<MarksResponse>(MARKS_CACHE_PREFIX + examSubjectId);
    if (cached) this.sheet = cached;
    this.render();
    try {
      const res = await this.o.auth.authedFetch(
        `/api/v1/academics/marks?examSubjectId=${encodeURIComponent(examSubjectId)}`,
      );
      if (!res.ok) throw new HttpStatus(res.status);
      this.sheet = (await res.json()) as MarksResponse;
      this.offline = false;
      this.denied = false;
      this.cacheSet(MARKS_CACHE_PREFIX + examSubjectId, this.sheet);
    } catch (err) {
      const status = err instanceof HttpStatus ? err.status : undefined;
      this.denied = status === 403;
      if (this.denied) this.sheet = null;
      this.offline = !this.denied && this.sheet !== null;
    }
    this.loading = false;
    this.render();
  }

  private get readOnly(): boolean {
    const s = this.sheet;
    return !!s && (s.markingLocked || s.examStatus === 'published' || s.examStatus === 'locked');
  }

  /** One outbox op per changed student; UI acknowledges locally, always. */
  /**
   * True while a save is in flight.
   *
   * `dirty.size === 0` was the only guard, and it is cleared AFTER the
   * enqueue loop finishes — so two taps on a slow phone both passed it and
   * enqueued the same marks twice, with two different op ids. The outbox
   * de-duplicates by opId and these had none, so both would have posted.
   */
  private saving = false;

  private async save(): Promise<void> {
    if (this.saving) return;
    const sel = this.selected;
    const sheet = this.sheet;
    if (!sel || !sheet || this.dirty.size === 0) return;

    this.saving = true;
    this.paintSaveBar();
    try {
    for (const [studentId, change] of this.dirty) {
      const row = sheet.marks.find((m) => m.studentId === studentId);
      if (!row) continue;
      const merged = { ...row, ...change };
      await this.o.outbox.enqueue({
        entity: 'exam_mark',
        baseVersion: row.rowVersion ?? undefined,
        payload: {
          examSubjectId: sel.subject.examSubjectId,
          studentId,
          academicYearId: sheet.academicYearId,
          cqMarks: merged.cqMarks,
          mcqMarks: merged.mcqMarks,
          practicalMarks: merged.practicalMarks,
          caMarks: merged.caMarks,
          isAbsent: merged.isAbsent,
        },
      });
      Object.assign(row, change);
    }
    this.dirty.clear();
    this.savedAt = Date.now();
    this.cacheSet(MARKS_CACHE_PREFIX + sel.subject.examSubjectId, sheet);
    // Fire-and-forget: offline failure is the normal case, not an error.
    void Promise.resolve(this.o.outbox.flush()).catch(() => {});
    toast(this.o.doc, {
      message: navigator.onLine
        ? 'নম্বর সংরক্ষিত — জমা হচ্ছে'
        : 'নম্বর এই যন্ত্রে সংরক্ষিত — সংযোগ পেলে নিজেই জমা হবে',
      tone: 'success',
    });
    } catch (err) {
      // The typed marks are still in `this.dirty` and still on screen: §13's
      // rule is that a recoverable failure never costs the user their input,
      // and re-rendering from `sheet` would discard exactly the numbers the
      // teacher just keyed in.
      toast(this.o.doc, {
        message: 'নম্বর সংরক্ষণ করা যায়নি। ঘরের নম্বরগুলো ঠিক আছে — আবার চেষ্টা করুন।',
        tone: 'error',
      });
      console.error('[marks] enqueue failed', err);
    } finally {
      this.saving = false;
    }
    this.render();
  }

  private markDirty(studentId: string, change: Partial<MarkRow>): void {
    this.dirty.set(studentId, { ...this.dirty.get(studentId), ...change });
    this.savedAt = 0;
    this.paintSaveBar();
  }

  /** Drop one field from a student's pending change (F-709: an over-max
   *  value is never queued), and forget the student entirely if nothing else
   *  is pending. */
  private clearDirtyField(studentId: string, key: MarkKey): void {
    const cur = this.dirty.get(studentId);
    if (!cur) return;
    delete (cur as Record<string, unknown>)[key];
    if (Object.keys(cur).length === 0) this.dirty.delete(studentId);
    this.savedAt = 0;
    this.paintSaveBar();
  }

  /** Flag or clear an over-max field. max=null clears. The message names the
   *  ceiling and says plainly that nothing was saved, so the number the
   *  teacher still sees in the box is not mistaken for a stored mark. */
  private fieldError(input: HTMLInputElement, max: number | null): void {
    const label = input.parentElement;
    const existing = label?.querySelector<HTMLElement>('.marks-error') ?? null;
    if (max === null) {
      input.removeAttribute('aria-invalid');
      existing?.remove();
      return;
    }
    input.setAttribute('aria-invalid', 'true');
    const err = existing ?? this.o.doc.createElement('span');
    err.className = 'marks-error';
    err.setAttribute('role', 'alert');
    err.textContent = `সর্বোচ্চ ${formatCount(max, 'bn')} — সংরক্ষণ হয়নি`;
    if (!existing) label?.append(err);
  }

  /** "am I done?" — how many students are accounted for (a mark in any active
   *  component, or marked absent), out of the section total. Reflects unsaved
   *  edits so the count moves as the teacher types. */
  private paintComplete(): void {
    const el = this.completeEl;
    const sheet = this.sheet;
    if (!el || !sheet) return;
    const total = sheet.marks.length;
    let done = 0;
    for (const row of sheet.marks) {
      const m = { ...row, ...this.dirty.get(row.studentId) };
      if (m.isAbsent || this.activeKeys.some((k) => m[k] !== null && m[k] !== undefined)) done++;
    }
    el.textContent = `নম্বর দেওয়া হয়েছে ${formatCount(done, 'bn')} / ${formatCount(total, 'bn')}`;
    el.dataset.done = String(done === total);
  }

  private saveBarEl: HTMLElement | null = null;

  private paintSaveBar(): void {
    if (!this.saveBarEl) return;
    const btn = this.saveBarEl.querySelector('button');
    if (btn) btn.disabled = this.dirty.size === 0;
    const chip = this.saveBarEl.querySelector<HTMLElement>('.marks-chip');
    if (chip) {
      chip.textContent = this.dirty.size > 0
        ? `${formatCount(this.dirty.size, 'bn')}টি পরিবর্তন`
        : this.savedAt ? 'সংরক্ষিত ✓' : '';
    }
  }

  private render(): void {
    const d = this.o.doc;
    const root = this.o.root;
    root.textContent = '';

    // Once a sheet is chosen, name what is being marked — the wireframe's
    // "১ম সাময়িক · নবম–ক · পদার্থবিজ্ঞান". Answers "which paper am I in?"
    // without scrolling back to the picker.
    append(root, pageHeader(d, {
      title: 'নম্বর এন্ট্রি',
      subtitle: this.selected
        ? `${this.selected.exam.nameBn} · ${this.selected.subject.subject.bn}`
        : 'পরীক্ষা ও বিষয় বেছে নিয়ে নম্বর দিন — অফলাইনেও কাজ করে।',
      badge: this.readOnly
        ? badge(d, { label: 'প্রকাশিত — পরিবর্তন করা যাবে না', tone: 'info', glyph: 'lock' })
        : undefined,
    }));

    // §"published marks immutability". The gate existed; nothing said WHY the
    // inputs were dead, so a teacher trying to fix a typo met a form that
    // simply would not accept keystrokes.
    if (this.readOnly) {
      append(root, el(d, 'p', { className: 'att-offline-note' },
        icon(d, 'lock', 'att-offline-glyph'),
        el(d, 'span', {
          text: 'এই পরীক্ষার ফলাফল প্রকাশিত হয়ে গেছে, তাই নম্বর আর পরিবর্তন করা যাবে না। '
            + 'সংশোধন প্রয়োজন হলে প্রধান শিক্ষকের সাথে যোগাযোগ করুন।',
        })));
    }

    // §5 of the closure pass: ONE permission sentence across the product,
    // from humanError(), rather than each screen inventing "could not fetch".
    if (this.denied) {
      append(root, emptyState(d, {
        message: humanError('forbidden')
          + ' প্রয়োজন হলে প্রধান শিক্ষকের সাথে যোগাযোগ করুন।',
      }));
      return;
    }

    if (this.offline) {
      append(root, el(d, 'p', { className: 'att-offline-note' },
        el(d, 'span', {
          text: 'অফলাইন — সর্বশেষ সংরক্ষিত নম্বর দেখানো হচ্ছে। নতুন নম্বর এই যন্ত্রে জমা থাকবে।',
        })));
    }

    if (!this.sectionId) {
      append(root, emptyState(d, {
        message: 'আগে শিক্ষার্থী তালিকা থেকে একটি সেকশন বেছে নিন — তারপর সেই শাখার নম্বর দেওয়া যাবে।',
        action: { label: 'শিক্ষার্থী তালিকা', onClick: () => { location.hash = '/roster'; } },
      }));
      return;
    }

    // One option per (exam, subject) pair, on the P2 field — so the control
    // carries a VISIBLE label. It had an `aria-label` only, which told a
    // screen reader what it was and a teacher nothing until they opened it.
    const options = this.exams.flatMap((exam) =>
      exam.subjects.map((subject) => ({
        value: subject.examSubjectId,
        label: `${exam.nameBn} — ${subject.subject.bn}`,
      })));
    const picker = field(d, {
      label: 'পরীক্ষা ও বিষয়',
      name: 'examSubject',
      kind: 'select',
      value: this.selected?.subject.examSubjectId ?? '',
      helper: 'নম্বর দেওয়া অফলাইনেও কাজ করে — সংযোগ পেলে নিজেই জমা হবে।',
      options: [
        { value: '', label: 'পরীক্ষা ও বিষয় নির্বাচন করুন' },
        ...options,
      ],
      onChange: (v) => {
        for (const exam of this.exams) {
          const subject = exam.subjects.find((sub) => sub.examSubjectId === v);
          if (subject) {
            this.selected = { exam, subject };
            void this.loadSheet(subject.examSubjectId);
            return;
          }
        }
      },
    });
    root.append(picker.root);

    if (this.exams.length === 0 && !this.loading) {
      root.append(emptyState(d, {
        glyph: 'award',
        message: 'এই সেকশনের জন্য কোনো পরীক্ষা পাওয়া যায়নি। পরীক্ষা তৈরি হলে '
          + 'এখানে নম্বর দেওয়া যাবে।',
      }));
      return;
    }
    if (!this.selected) return;
    if (this.loading && !this.sheet) {
      root.append(listSkeleton(d, 5));
      return;
    }
    const sheet = this.sheet;
    if (!sheet) return;

    if (this.readOnly) {
      const notice = d.createElement('p');
      notice.className = 'offline-banner';
      notice.textContent = 'ফলাফল প্রকাশিত/লকড — নম্বর এখন শুধু দেখা যাবে।';
      root.append(notice);
    }

    const components = ([
      { key: 'cqMarks', label: 'সৃজনশীল', max: sheet.maxima.cq },
      { key: 'mcqMarks', label: 'MCQ', max: sheet.maxima.mcq },
      { key: 'practicalMarks', label: 'ব্যবহারিক', max: sheet.maxima.practical },
      { key: 'caMarks', label: 'ধারাবাহিক', max: sheet.maxima.ca },
    ] as { key: MarkKey; label: string; max: number }[]).filter((c) => c.max > 0);
    this.activeKeys = components.map((c) => c.key);

    // Completeness counter, always visible: the teacher's answer to "have I
    // marked everyone?" (§7.2). Sits above the list so it does not scroll away.
    this.completeEl = d.createElement('p');
    this.completeEl.className = 'marks-complete';
    this.completeEl.setAttribute('aria-live', 'polite');
    root.append(this.completeEl);

    const list = d.createElement('ul');
    list.className = 'marks-list';
    for (const row of sheet.marks) {
      const li = d.createElement('li');
      li.className = 'marks-row';

      const who = d.createElement('div');
      who.className = 'marks-who';
      const roll = d.createElement('span');
      roll.className = 'roster-roll';
      roll.textContent = formatCount(row.rollNo, 'bn');
      const name = d.createElement('span');
      name.className = 'roster-name';
      name.textContent = row.fullName.bn || row.fullName.en || '—';
      who.append(roll, name);
      li.append(who);

      const inputs = d.createElement('div');
      inputs.className = 'marks-inputs';
      for (const comp of components) {
        const label = d.createElement('label');
        label.className = 'marks-label';
        label.textContent = comp.label;
        const input = d.createElement('input');
        input.type = 'number';
        input.className = 'marks-input';
        input.min = '0';
        input.max = String(comp.max);
        input.step = '0.5';
        input.inputMode = 'decimal';
        input.disabled = this.readOnly || row.isAbsent;
        const v = row[comp.key];
        input.value = v === null || v === undefined ? '' : String(v);
        input.addEventListener('input', () => {
          const raw = input.value.trim();
          if (raw === '') {
            this.fieldError(input, null);
            this.markDirty(row.studentId, { [comp.key]: null } as Partial<MarkRow>);
            this.paintComplete();
            return;
          }
          const n = Number(raw);
          // F-709: a mark over the paper's ceiling (or negative / not a
          // number) is REJECTED inline and persists nothing. The old code
          // silently clamped 75 to 70 — so a teacher who typed 75 saved 70
          // and never knew. Now the field flags it and the value is not
          // recorded until it is corrected.
          if (!Number.isFinite(n) || n < 0 || n > comp.max) {
            this.fieldError(input, comp.max);
            this.clearDirtyField(row.studentId, comp.key);
            this.paintComplete();
            return;
          }
          this.fieldError(input, null);
          this.markDirty(row.studentId, { [comp.key]: n } as Partial<MarkRow>);
          this.paintComplete();
        });
        label.append(input);
        inputs.append(label);
      }

      const absent = d.createElement('label');
      absent.className = 'marks-label marks-absent';
      const cb = d.createElement('input');
      cb.type = 'checkbox';
      cb.checked = row.isAbsent;
      cb.disabled = this.readOnly;
      cb.addEventListener('change', () => {
        this.markDirty(row.studentId, { isAbsent: cb.checked });
        for (const inp of inputs.querySelectorAll('input')) inp.disabled = cb.checked || this.readOnly;
      });
      absent.append(cb, d.createTextNode('অনুপস্থিত'));
      li.append(inputs, absent);

      list.append(li);
    }
    root.append(list);

    if (!this.readOnly) {
      const bar = d.createElement('div');
      bar.className = 'marks-savebar';
      const chip = d.createElement('span');
      chip.className = 'marks-chip';
      const save = d.createElement('button');
      save.type = 'button';
      save.className = 'btn-primary';
      save.textContent = this.saving ? 'সংরক্ষণ হচ্ছে…' : 'সংরক্ষণ করুন';
      save.disabled = this.dirty.size === 0 || this.saving;
      if (this.saving) save.setAttribute('aria-busy', 'true');
      save.addEventListener('click', () => { void this.save(); });
      bar.append(chip, save);
      root.append(bar);
      this.saveBarEl = bar;
      this.paintSaveBar();
    }

    this.paintComplete();
  }
}
