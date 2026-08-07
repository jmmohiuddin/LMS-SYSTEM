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
  private loading = false;
  private savedAt = 0;

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
      if (!res.ok) throw new Error(String(res.status));
      const body = (await res.json()) as { exams: ExamSummary[] };
      this.exams = body.exams;
      this.offline = false;
      this.cacheSet(EXAMS_CACHE_PREFIX + this.sectionId, this.exams);
    } catch {
      this.offline = this.exams.length > 0;
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
      if (!res.ok) throw new Error(String(res.status));
      this.sheet = (await res.json()) as MarksResponse;
      this.offline = false;
      this.cacheSet(MARKS_CACHE_PREFIX + examSubjectId, this.sheet);
    } catch {
      this.offline = this.sheet !== null;
    }
    this.loading = false;
    this.render();
  }

  private get readOnly(): boolean {
    const s = this.sheet;
    return !!s && (s.markingLocked || s.examStatus === 'published' || s.examStatus === 'locked');
  }

  /** One outbox op per changed student; UI acknowledges locally, always. */
  private async save(): Promise<void> {
    const sel = this.selected;
    const sheet = this.sheet;
    if (!sel || !sheet || this.dirty.size === 0) return;

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
    this.render();
  }

  private markDirty(studentId: string, change: Partial<MarkRow>): void {
    this.dirty.set(studentId, { ...this.dirty.get(studentId), ...change });
    this.savedAt = 0;
    this.paintSaveBar();
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

    const header = d.createElement('header');
    header.className = 'att-header';
    const h1 = d.createElement('h1');
    h1.textContent = 'নম্বর এন্ট্রি';
    header.append(h1);
    if (this.offline) {
      const banner = d.createElement('p');
      banner.className = 'offline-banner';
      banner.textContent = 'অফলাইন — সর্বশেষ সংরক্ষিত তথ্য দেখানো হচ্ছে';
      header.append(banner);
    }
    root.append(header);

    if (!this.sectionId) {
      const p = d.createElement('p');
      p.className = 'att-sub';
      p.textContent = 'আগে শিক্ষার্থী ট্যাব থেকে একটি সেকশন নির্বাচন করুন।';
      root.append(p);
      return;
    }

    // exam-subject picker: one option per (exam, subject) pair
    const picker = d.createElement('select');
    picker.className = 'section-picker';
    picker.setAttribute('aria-label', 'পরীক্ষা ও বিষয় নির্বাচন করুন');
    const placeholder = d.createElement('option');
    placeholder.value = '';
    placeholder.textContent = 'পরীক্ষা ও বিষয় নির্বাচন করুন';
    placeholder.disabled = true;
    placeholder.selected = !this.selected;
    picker.append(placeholder);
    for (const exam of this.exams) {
      for (const subject of exam.subjects) {
        const opt = d.createElement('option');
        opt.value = subject.examSubjectId;
        opt.textContent = `${exam.nameBn} — ${subject.subject.bn}`;
        opt.selected = this.selected?.subject.examSubjectId === subject.examSubjectId;
        picker.append(opt);
      }
    }
    picker.addEventListener('change', () => {
      for (const exam of this.exams) {
        const subject = exam.subjects.find((s) => s.examSubjectId === picker.value);
        if (subject) {
          this.selected = { exam, subject };
          void this.loadSheet(subject.examSubjectId);
          return;
        }
      }
    });
    root.append(picker);

    if (this.exams.length === 0 && !this.loading) {
      const p = d.createElement('p');
      p.className = 'att-sub';
      p.textContent = 'এই সেকশনের জন্য কোনো পরীক্ষা পাওয়া যায়নি।';
      root.append(p);
      return;
    }
    if (!this.selected) return;
    if (this.loading && !this.sheet) {
      const p = d.createElement('p');
      p.className = 'att-sub';
      p.textContent = 'লোড হচ্ছে…';
      root.append(p);
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

    type MarkKey = 'cqMarks' | 'mcqMarks' | 'practicalMarks' | 'caMarks';
    const components = ([
      { key: 'cqMarks', label: 'সৃজনশীল', max: sheet.maxima.cq },
      { key: 'mcqMarks', label: 'MCQ', max: sheet.maxima.mcq },
      { key: 'practicalMarks', label: 'ব্যবহারিক', max: sheet.maxima.practical },
      { key: 'caMarks', label: 'ধারাবাহিক', max: sheet.maxima.ca },
    ] as { key: MarkKey; label: string; max: number }[]).filter((c) => c.max > 0);

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
          const n = input.value === '' ? null : Math.min(Math.max(Number(input.value), 0), comp.max);
          this.markDirty(row.studentId, { [comp.key]: n } as Partial<MarkRow>);
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
      save.textContent = 'সংরক্ষণ করুন';
      save.disabled = this.dirty.size === 0;
      save.addEventListener('click', () => { void this.save(); });
      bar.append(chip, save);
      root.append(bar);
      this.saveBarEl = bar;
      this.paintSaveBar();
    }
  }
}
