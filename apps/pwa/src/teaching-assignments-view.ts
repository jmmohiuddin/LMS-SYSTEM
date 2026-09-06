/**
 * "কে কোন বিষয় পড়ান" — the teaching-assignment matrix.
 *
 * P9-1's screen, and not a follow-up to it: `rms-svc/api/assignments.ts` is
 * the writer for `section_subject_teachers`, the one input
 * `solve.ts:loadDemand` reads to decide what a timetable must contain. P9-0
 * found that table holding six rows across 183 schools. Without this screen
 * the endpoint would be exactly the "backend complete — UI pending" state
 * D13 forbids.
 *
 * Named `teaching-assignments` because `assignments-view.ts` is homework
 * (বাড়ির কাজ) and has been since R-2. Two different things share the English
 * word and nothing in Bangla confuses them.
 *
 * ── The shape is the paperwork, not the table ──────────────────────────────
 * A coordinator holds one class in their head at a time: "class 9 — who is
 * taking maths in ক, in খ, in গ?" So this is subjects DOWN and sections
 * ACROSS, one class at a time, which is how the sheet already pinned up in
 * the office looks. A flat list of eight hundred assignments would be
 * technically equivalent and unusable.
 *
 * ── The empty cells are the feature ────────────────────────────────────────
 * The grid is built from the CURRICULUM (`class_subjects`) and not from the
 * assignments that exist, so a coordinator sees the eleven subjects nobody is
 * teaching yet rather than the two that are done. The progress line says the
 * same thing in a sentence, and P9-2's wizard reads it to decide whether
 * Generate may be reached at all — nobody arrives at that button without
 * knowing what is missing.
 *
 * ── Editing is a batch; saving is explicit ─────────────────────────────────
 * Changes are held locally and marked, then sent together in one transaction.
 * Eighty sections of typing should not be eighty requests — and a coordinator
 * who fills a column and loses their connection should find the column empty
 * and do it again, rather than find half of it saved and have to work out
 * which half.
 *
 * ── Mobile ─────────────────────────────────────────────────────────────────
 * A matrix does not survive 360px, so the narrow layout is one CARD PER
 * SUBJECT with a row per section — the same data read down instead of across.
 * `dataTable` does that transformation for read-only rows; here every cell is
 * an editable control, so the narrow shape is built directly rather than
 * pretending a table works.
 */
import {
  el, pageHeader, card, button, buttonRow, statusBadge, permissionState,
  deniedMessage, deniedContact, announce, toast, sectionHeading, listSkeleton,
} from './ui/index.ts';
import { emptyState, errorState } from './view-states.ts';
import { refuseUnlessOk, isDenied } from './http-status.ts';
import type { Auth } from './auth.ts';

const BN_DIGITS = '০১২৩৪৫৬৭৮৯';
const bn = (n: number): string => String(n).replace(/\d/g, (d) => BN_DIGITS[Number(d)]);

interface ClassRow { id: string; nameBn: string; levelNo: number }
interface SectionRow { id: string; name: string; shift: string }
interface SubjectRow {
  id: string; nameBn: string; periodsPerWeek: number;
  doublePeriodsPerWeek: number; requiresCapability: string | null;
}
interface TeacherRow { id: string; nameBn: string; employeeCode: string; teaches: string[] }
interface Cell { sectionId: string; subjectId: string; teacherId: string; teacherBn: string }

interface Grid {
  classes: ClassRow[];
  classId: string | null;
  sections: SectionRow[];
  subjects: SubjectRow[];
  teachers: TeacherRow[];
  cells: Cell[];
  progress: { required: number; assigned: number };
}

export interface TeachingAssignmentsViewOptions {
  root: HTMLElement;
  doc: Document;
  auth: Auth;
  /**
   * The academic year being planned. Optional: when absent the view resolves
   * the school's current year from `/academics/hierarchy`, the same way
   * `exams-view` does — a caller should not have to know the year to open a
   * screen whose whole subject is this year.
   */
  yearId?: string;
  /** Told after every load and save, so a wizard step can follow along. */
  onProgress?: (p: { required: number; assigned: number }) => void;
}

const key = (sectionId: string, subjectId: string) => `${sectionId}|${subjectId}`;

export class TeachingAssignmentsView {
  private readonly o: TeachingAssignmentsViewOptions;
  private grid: Grid | null = null;
  private loading = true;
  private saving = false;
  private denied = false;
  private deniedErr: unknown = null;
  private offline = false;
  private error = '';
  /** Cell → teacherId ('' means nobody). Only cells the user actually changed. */
  private pending = new Map<string, string>();

  /** Resolved once, then reused for every class switch and save. */
  private yearId = '';

  constructor(options: TeachingAssignmentsViewOptions) {
    this.o = options;
    this.yearId = options.yearId ?? '';
    void this.start();
  }

  private async start(): Promise<void> {
    if (this.yearId) { await this.load(null); return; }
    try {
      const res = await this.o.auth.authedFetch('/api/v1/academics/hierarchy');
      await refuseUnlessOk(res);
      const body = await res.json() as
        { years?: Array<{ id: string; isCurrent?: boolean }>; year?: { id: string } };
      this.yearId = body.years?.find((y) => y.isCurrent)?.id
        ?? body.years?.[0]?.id ?? body.year?.id ?? '';
    } catch (err) {
      if (isDenied(err)) { this.denied = true; this.deniedErr = err; }
      else this.error = 'শিক্ষাবর্ষ আনা যায়নি — সংযোগ পেলে আবার দেখা যাবে।';
      this.loading = false; this.render(); return;
    }
    if (!this.yearId) {
      this.loading = false;
      this.error = '';
      this.render();
      return;
    }
    await this.load(null);
  }

  /** Unsaved edits, for a router that wants to warn before leaving. */
  hasUnsavedChanges(): boolean { return this.pending.size > 0; }

  private async load(classId: string | null): Promise<void> {
    this.loading = true; this.error = ''; this.render();
    try {
      const q = new URLSearchParams({ yearId: this.yearId });
      if (classId) q.set('classId', classId);
      const res = await this.o.auth.authedFetch(`/api/v1/rms/assignments?${q}`);
      await refuseUnlessOk(res);
      this.grid = await res.json() as Grid;
      this.pending.clear();
      this.offline = false;
      this.o.onProgress?.(this.grid.progress);
    } catch (err) {
      if (isDenied(err)) {
        this.denied = true; this.deniedErr = err; this.grid = null;
      } else {
        this.offline = true;
        this.error = 'তালিকা আনা যায়নি — সংযোগ পেলে আবার দেখা যাবে।';
      }
    } finally {
      this.loading = false; this.render();
    }
  }

  /**
   * Send only what changed.
   *
   * Returns a message on failure and `''` on success rather than setting
   * `this.error` — A2's lesson: a `finally { render() }` that reloaded would
   * wipe the message before anyone read it, and the grid must stay on screen
   * with the offending choice still selected.
   */
  private async send(): Promise<string> {
    const changes = [...this.pending.entries()].map(([k, teacherId]) => {
      const [sectionId, subjectId] = k.split('|');
      return { sectionId, subjectId, teacherId: teacherId || null };
    });
    try {
      const res = await this.o.auth.authedFetch('/api/v1/rms/assignments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ yearId: this.yearId, changes }),
      });
      const body = await res.json().catch(() => null) as { message?: string } | null;
      return res.ok ? '' : (body?.message ?? 'সংরক্ষণ করা যায়নি।');
    } catch {
      return 'সংযোগ নেই — সংরক্ষণ করা যায়নি।';
    }
  }

  private currentTeacher(sectionId: string, subjectId: string): string {
    const k = key(sectionId, subjectId);
    if (this.pending.has(k)) return this.pending.get(k) as string;
    return this.grid?.cells.find(
      (c) => c.sectionId === sectionId && c.subjectId === subjectId)?.teacherId ?? '';
  }

  /** One editable cell: a real <select>, so keyboard and screen reader work. */
  private picker(section: SectionRow, subject: SubjectRow): HTMLElement {
    const d = this.o.doc;
    const g = this.grid as Grid;
    const k = key(section.id, subject.id);
    const chosen = this.currentTeacher(section.id, subject.id);

    const sel = d.createElement('select');
    sel.className = 'field-input assign-cell';
    // Named explicitly: a screen reader landing in a grid cell announces
    // neither its column header nor its row header.
    sel.setAttribute('aria-label', `${subject.nameBn} — ${section.name} শাখার শিক্ষক`);
    // Both layouts are rendered and CSS picks one, so every cell exists TWICE
    // in the DOM. The pending map is keyed by cell so the state stays right,
    // but the twin control would keep showing the old name until a save —
    // and a tablet crossing the breakpoint would then display stale choices.
    // The key lets the change handler move both.
    sel.dataset.cellKey = k;
    if (this.pending.has(k)) sel.dataset.dirty = 'true';

    const none = d.createElement('option');
    none.value = '';
    none.textContent = '— কেউ নয় —';
    sel.append(none);

    for (const t of g.teachers) {
      const opt = d.createElement('option');
      opt.value = t.id;
      // The competency register is a HINT, never a filter: it is empty in
      // every school on this deployment, so filtering by it would offer an
      // empty list and make the screen unusable.
      opt.textContent = t.teaches.includes(subject.id) ? `${t.nameBn} ✓` : t.nameBn;
      if (t.id === chosen) opt.selected = true;
      sel.append(opt);
    }

    sel.addEventListener('change', () => {
      const saved = g.cells.find(
        (c) => c.sectionId === section.id && c.subjectId === subject.id)?.teacherId ?? '';
      // Choosing back what was already saved is not a change. Without this, a
      // coordinator who opens a dropdown and re-picks the same name leaves the
      // grid "dirty" and is warned about work that does not exist.
      if (sel.value === saved) this.pending.delete(k);
      else this.pending.set(k, sel.value);

      // Move the twin in the other layout with it.
      const dirty = this.pending.has(k) ? 'true' : '';
      for (const twin of d.querySelectorAll<HTMLSelectElement>(
        `select.assign-cell[data-cell-key="${CSS.escape(k)}"]`)) {
        twin.value = sel.value;
        twin.dataset.dirty = dirty;
      }
      this.renderBar();
    });
    return sel;
  }

  /** Wide: subjects down, sections across — the office's own sheet. */
  private matrix(): HTMLElement {
    const d = this.o.doc;
    const g = this.grid as Grid;

    const table = el(d, 'table', { className: 'ui-table assign-matrix' });
    table.append(el(d, 'caption', {
      text: `${g.classes.find((c) => c.id === g.classId)?.nameBn ?? ''}`
        + ' — বিষয় ও শাখাভিত্তিক শিক্ষক',
    }));

    const head = el(d, 'thead');
    const hr = el(d, 'tr');
    hr.append(el(d, 'th', { text: 'বিষয়', attrs: { scope: 'col' } }));
    for (const s of g.sections) {
      hr.append(el(d, 'th', { text: `${s.name} শাখা`, attrs: { scope: 'col' } }));
    }
    head.append(hr); table.append(head);

    const body = el(d, 'tbody');
    for (const sub of g.subjects) {
      const tr = el(d, 'tr');
      const th = el(d, 'th', { attrs: { scope: 'row' } });
      th.append(el(d, 'span', { className: 'assign-subject', text: sub.nameBn }));
      // The weekly load, because it is what makes an assignment mean
      // something: six periods is a different ask from two.
      th.append(el(d, 'span', {
        className: 'ui-cell-meta',
        text: `সপ্তাহে ${bn(sub.periodsPerWeek)}টি পিরিয়ড`
          + (sub.requiresCapability ? ' · ল্যাব লাগবে' : ''),
      }));
      tr.append(th);
      for (const sec of g.sections) {
        const td = el(d, 'td');
        td.append(this.picker(sec, sub));
        tr.append(td);
      }
      body.append(tr);
    }
    table.append(body);

    const scroll = el(d, 'div', { className: 'ui-table-scroll' });
    scroll.append(table);
    return scroll;
  }

  /** Narrow: one card per subject, a row per section. Same data, read down. */
  private stack(): HTMLElement {
    const d = this.o.doc;
    const g = this.grid as Grid;
    const wrap = el(d, 'div', { className: 'assign-stack' });

    for (const sub of g.subjects) {
      const rows = el(d, 'div', { className: 'ui-stack' });
      for (const sec of g.sections) {
        const row = el(d, 'label', { className: 'field assign-row' });
        row.append(el(d, 'span', { className: 'field-label', text: `${sec.name} শাখা` }));
        row.append(this.picker(sec, sub));
        rows.append(row);
      }
      wrap.append(card(d, {
        title: sub.nameBn,
        subtitle: `সপ্তাহে ${bn(sub.periodsPerWeek)}টি পিরিয়ড`
          + (sub.requiresCapability ? ' · ল্যাব লাগবে' : ''),
        glyph: 'book-open',
        headingLevel: 3,
      }, rows));
    }
    return wrap;
  }

  /** The save bar, re-rendered alone so a dropdown never loses focus. */
  private renderBar(): void {
    const bar = this.o.doc.getElementById('assign-bar');
    if (!bar) return;
    bar.textContent = '';
    for (const node of this.barChildren()) bar.append(node);
  }

  private barChildren(): HTMLElement[] {
    const d = this.o.doc;
    const g = this.grid as Grid;
    const dirty = this.pending.size;

    const status = el(d, 'p', { className: 'ui-card-note' });
    status.append(el(d, 'span', {
      text: `${bn(g.progress.assigned)} / ${bn(g.progress.required)} টি ঘর পূরণ হয়েছে`,
    }));
    if (dirty > 0) {
      status.append(el(d, 'span', {
        className: 'assign-dirty',
        text: ` · ${bn(dirty)}টি পরিবর্তন সংরক্ষণ করা হয়নি`,
      }));
    }

    return [status, buttonRow(d, button(d, {
      label: this.saving ? 'সংরক্ষণ হচ্ছে…' : 'সংরক্ষণ করুন',
      variant: 'primary',
      disabled: this.saving || dirty === 0,
      onClick: () => { void this.onSave(); },
    }))];
  }

  private async onSave(): Promise<void> {
    if (this.pending.size === 0) return;
    this.saving = true; this.renderBar();
    const n = this.pending.size;
    const msg = await this.send();
    this.saving = false;

    if (msg) {
      // The grid stays exactly as it is, offending choice still selected.
      this.error = msg;
      this.render();
      announce(this.o.doc, msg);
      return;
    }
    toast(this.o.doc, { message: `${bn(n)}টি পরিবর্তন সংরক্ষণ হয়েছে`, tone: 'success' });
    await this.load(this.grid?.classId ?? null);
  }

  private render(): void {
    const d = this.o.doc;
    const root = this.o.root;
    root.textContent = '';

    if (this.denied) {
      root.append(pageHeader(d, { title: 'কে কোন বিষয় পড়ান' }));
      root.append(permissionState(d, {
        message: deniedMessage(this.deniedErr, 'শিক্ষক নির্ধারণ'),
        contact: deniedContact(this.deniedErr),
      }));
      return;
    }

    root.append(pageHeader(d, {
      title: 'কে কোন বিষয় পড়ান',
      subtitle: 'রুটিন তৈরির আগে প্রতিটি শাখার প্রতিটি বিষয়ে একজন শিক্ষক দিন',
    }));

    if (this.loading) { root.append(listSkeleton(d, 6)); return; }

    if (this.error && !this.grid) {
      root.append(errorState(d, this.error, () => void this.load(null)));
      return;
    }
    const g = this.grid;
    if (!g) {
      root.append(emptyState(d, {
        glyph: 'calendar',
        message: 'চলতি শিক্ষাবর্ষ পাওয়া যায়নি। আগে শিক্ষাবর্ষ তৈরি করুন।',
      }));
      return;
    }

    if (g.classes.length === 0) {
      root.append(emptyState(d, {
        glyph: 'layers',
        message: 'এই শিক্ষাবর্ষে কোনো শ্রেণি বা শাখা নেই। আগে একাডেমিক কাঠামো তৈরি করুন।',
      }));
      return;
    }

    // A save failed. Loud, above the grid, and the grid stays editable.
    if (this.error) root.append(errorState(d, this.error));
    if (this.offline) {
      root.append(el(d, 'p', {
        className: 'ui-banner-offline',
        text: 'অফলাইন — সর্বশেষ সংরক্ষিত তথ্য দেখানো হচ্ছে।',
      }));
    }

    // A <select> and not tabs: a college has twelve classes, and tabs would
    // wrap into three rows on a phone.
    const picker = el(d, 'label', { className: 'field' });
    picker.append(el(d, 'span', { className: 'field-label', text: 'শ্রেণি' }));
    const sel = d.createElement('select');
    sel.className = 'field-input';
    for (const c of g.classes) {
      const opt = d.createElement('option');
      opt.value = c.id; opt.textContent = c.nameBn;
      if (c.id === g.classId) opt.selected = true;
      sel.append(opt);
    }
    sel.addEventListener('change', () => {
      if (this.pending.size > 0
        && !confirm('সংরক্ষণ না করা পরিবর্তন আছে। শ্রেণি বদলালে সেগুলো হারিয়ে যাবে।')) {
        sel.value = g.classId ?? '';
        return;
      }
      void this.load(sel.value);
    });
    picker.append(sel);
    root.append(picker);

    if (g.subjects.length === 0) {
      root.append(emptyState(d, {
        glyph: 'book-open',
        message: 'এই শ্রেণিতে কোনো বিষয় নির্ধারিত নেই। পাঠ্যসূচি ছাড়া রুটিন তৈরি করা যাবে না।',
      }));
      return;
    }

    const complete = g.progress.assigned === g.progress.required;
    root.append(sectionHeading(d, {
      title: 'শিক্ষক নির্ধারণ',
      action: statusBadge(d, complete
        ? { state: 'active', label: 'সম্পূর্ণ', tone: 'success' }
        : { state: 'pending', label: 'অসম্পূর্ণ', tone: 'warn' }),
    }));

    // Both shapes render and CSS chooses. Building only one would mean a
    // resize across the breakpoint showed the wrong thing until reload.
    root.append(this.matrix());
    root.append(this.stack());

    const bar = el(d, 'div', { className: 'assign-bar' });
    bar.id = 'assign-bar';
    for (const node of this.barChildren()) bar.append(node);
    root.append(bar);
  }
}
