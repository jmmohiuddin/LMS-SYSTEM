/**
 * নথি ও ছাপা — choose a document, preview it, print it.  (R-5)
 *
 * The master plan's exit criterion is a workflow, not an endpoint: "a guardian
 * pays; the office prints a receipt with the school's logo, watermark and
 * signature. Term ends; report cards print for a whole section in one go."
 *
 *     ধরন বেছে নিন → রেকর্ড বেছে নিন → পূর্বরূপ → ছাপুন
 *
 * ── Why the preview is an iframe ────────────────────────────────────────
 * The server returns a COMPLETE standalone page: its own `@page{size:A4}`,
 * its own watermark layer, its own print rules. Injecting that into the app's
 * DOM would put A4 page geometry and a full-page watermark inside a phone
 * shell, and the app's stylesheet would fight the document's.
 *
 * An iframe keeps them apart, and — the part that matters — it means the
 * thing on screen IS the thing that prints. `iframe.contentWindow.print()`
 * prints exactly the previewed document, so the preview cannot drift from the
 * output the way a lookalike would.
 *
 * ── Why srcdoc and not a URL ────────────────────────────────────────────
 * The document is fetched with `authedFetch`, so it travels with the caller's
 * bearer token. Pointing an iframe at the endpoint URL would send a plain
 * browser request with no Authorization header — it would 401, and "fixing"
 * that would mean a cookie or a token in a query string, i.e. a document URL
 * that works without the app. §15 of the brief is explicit that arbitrary
 * document URLs must not bypass authorization; fetching then rendering into
 * `srcdoc` is how this endpoint never needs one.
 *
 * ── Bulk ────────────────────────────────────────────────────────────────
 * A section's report cards are ONE request returning ONE page of forty
 * documents, each with its own letterhead and a page break before it. The
 * office presses print once. Forty requests and forty print dialogues is not
 * a bulk feature.
 */
import { formatBdt } from '../../../packages/ui-core/src/format.ts';
import type { Auth } from './auth.ts';
import {
  skeleton, errorState, emptyState, successNote, bnNum, bnDate,
} from './view-states.ts';

export type DocKind =
  | 'fee_receipt' | 'report_card' | 'admit_card'
  | 'id_card' | 'transfer_certificate' | 'attendance_sheet';

interface DocSpec {
  kind: DocKind;
  labelBn: string;
  descBn: string;
  /** What has to be chosen before this can be produced. */
  needs: 'receipt' | 'exam+students' | 'students' | 'student' | 'section';
  bulk: boolean;
}

/** The six the master plan names, in its order of daily-habit frequency. */
const DOCS: DocSpec[] = [
  { kind: 'fee_receipt', labelBn: 'ফি রসিদ',
    descBn: 'পরিশোধের প্রমাণ — অভিভাবককে দেওয়ার জন্য', needs: 'receipt', bulk: false },
  { kind: 'report_card', labelBn: 'প্রগতি পত্র',
    descBn: 'প্রকাশিত ফলাফলের মার্কশিট', needs: 'exam+students', bulk: true },
  { kind: 'admit_card', labelBn: 'প্রবেশপত্র',
    descBn: 'পরীক্ষার সূচি, হল ও আসনসহ', needs: 'exam+students', bulk: true },
  { kind: 'id_card', labelBn: 'পরিচয়পত্র',
    descBn: 'শিক্ষার্থীর আইডি কার্ড', needs: 'students', bulk: true },
  { kind: 'transfer_certificate', labelBn: 'ছাড়পত্র',
    descBn: 'প্রতিষ্ঠান ত্যাগের প্রত্যয়নপত্র', needs: 'student', bulk: false },
  { kind: 'attendance_sheet', labelBn: 'হাজিরা শিট',
    descBn: 'খালি ছক — নেটওয়ার্ক ছাড়া খাতায় হাজিরা নেওয়ার জন্য', needs: 'section', bulk: false },
];

interface TreeSection {
  id: string; name: string; studentCount: number;
}
interface Tree {
  classes: {
    levelNo: number; nameBn: string;
    groups: { groupBn: string; sections: TreeSection[] }[];
  }[];
}
interface RosterStudent { studentId: string; rollNo: number; nameBn: string }
interface ExamOption { examId: string; examNameBn: string; status: string }
interface ReceiptRow {
  id: string; receiptNo: string; amount: string; issuedAt: string; studentNameBn?: string | null;
}

export interface DocumentsViewOptions {
  root: HTMLElement;
  doc: Document;
  auth: Auth;
  /**
   * Which document kinds to offer. Advisory: the endpoint's own ACCESS list
   * and RLS are the enforcement, and a kind offered in error produces a clean
   * 403 rather than a document.
   */
  allowed: DocKind[];
}

export class DocumentsView {
  private readonly o: DocumentsViewOptions;

  private kind: DocKind | null = null;
  private tree: Tree | null = null;
  private exams: ExamOption[] = [];
  private receipts: ReceiptRow[] = [];
  private roster: RosterStudent[] = [];

  private sectionId = '';
  private examId = '';
  private receiptId = '';
  private selected = new Set<string>();

  private previewHtml = '';
  private loading = false;
  private generating = false;
  private error = '';
  private notice = '';

  constructor(options: DocumentsViewOptions) {
    this.o = options;
    this.render();
  }

  private spec(): DocSpec | null {
    return DOCS.find((d) => d.kind === this.kind) ?? null;
  }

  // ── loading ───────────────────────────────────────────────────────────

  private async pick(kind: DocKind): Promise<void> {
    this.kind = kind;
    this.previewHtml = ''; this.error = ''; this.notice = '';
    this.selected.clear(); this.roster = []; this.receiptId = '';
    this.loading = true; this.render();
    try {
      const need = this.spec()!.needs;
      if (need === 'receipt') {
        const res = await this.o.auth.authedFetch('/api/v1/finance/receipts?limit=30');
        if (res.status === 403) { this.error = 'রসিদ দেখার অনুমতি আপনার নেই।'; return; }
        if (!res.ok) throw new Error(String(res.status));
        const body = (await res.json()) as { receipts?: ReceiptRow[] };
        this.receipts = body.receipts ?? [];
      } else {
        const res = await this.o.auth.authedFetch('/api/v1/academics/hierarchy');
        if (res.status === 403) { this.error = 'একাডেমিক কাঠামো দেখার অনুমতি নেই।'; return; }
        if (!res.ok) throw new Error(String(res.status));
        this.tree = (await res.json()) as Tree;
        if (need === 'exam+students') {
          const ex = await this.o.auth.authedFetch('/api/v1/academics/publish');
          if (ex.ok) {
            const b = (await ex.json()) as { exams?: ExamOption[] };
            this.exams = b.exams ?? [];
          } else {
            // A class teacher may print report cards and cannot read the
            // publish-readiness list. Not an error — the exam picker just
            // has nothing to offer, and the empty state says so.
            this.exams = [];
          }
        }
      }
    } catch {
      this.error = 'তালিকা আনা যায়নি — সংযোগ পেলে আবার দেখা যাবে।';
    } finally {
      this.loading = false; this.render();
    }
  }

  private async loadRoster(sectionId: string): Promise<void> {
    this.sectionId = sectionId;
    this.selected.clear();
    this.previewHtml = '';
    this.loading = true; this.render();
    try {
      const res = await this.o.auth.authedFetch(
        `/api/v1/academics/hierarchy?sectionId=${encodeURIComponent(sectionId)}`);
      if (!res.ok) throw new Error(String(res.status));
      const body = (await res.json()) as { roster?: RosterStudent[] };
      this.roster = body.roster ?? [];
      // A whole section is the common case, so it is the default; unticking
      // is easier than ticking forty boxes.
      for (const s of this.roster) this.selected.add(s.studentId);
    } catch {
      this.error = 'শিক্ষার্থীর তালিকা আনা যায়নি।';
    } finally {
      this.loading = false; this.render();
    }
  }

  private queryFor(): URLSearchParams | null {
    const q = new URLSearchParams({ type: this.kind ?? '' });
    switch (this.spec()?.needs) {
      case 'receipt':
        if (!this.receiptId) { this.error = 'একটি রসিদ বেছে নিন।'; return null; }
        q.set('receiptId', this.receiptId);
        break;
      case 'exam+students':
        if (!this.examId) { this.error = 'পরীক্ষা বেছে নিন।'; return null; }
        q.set('examId', this.examId);
        if (this.selected.size === 0) { this.error = 'অন্তত একজন শিক্ষার্থী বেছে নিন।'; return null; }
        q.set('studentIds', [...this.selected].join(','));
        break;
      case 'students':
        if (this.selected.size === 0) { this.error = 'অন্তত একজন শিক্ষার্থী বেছে নিন।'; return null; }
        q.set('studentIds', [...this.selected].join(','));
        break;
      case 'student':
        if (this.selected.size !== 1) { this.error = 'একজন শিক্ষার্থী বেছে নিন।'; return null; }
        q.set('studentId', [...this.selected][0]);
        break;
      case 'section':
        if (!this.sectionId) { this.error = 'শাখা বেছে নিন।'; return null; }
        q.set('sectionId', this.sectionId);
        break;
    }
    return q;
  }

  private async generate(): Promise<void> {
    this.error = ''; this.notice = '';
    const q = this.queryFor();
    if (!q) { this.render(); return; }

    this.generating = true; this.previewHtml = ''; this.render();
    try {
      const res = await this.o.auth.authedFetch(`/api/v1/ops/document?${q}`);
      if (!res.ok) {
        // The endpoint answers JSON on failure and HTML on success.
        let message = 'নথি তৈরি করা যায়নি।';
        try {
          const body = await res.json() as { message?: string };
          if (body.message) message = body.message;
        } catch { /* a non-JSON failure keeps the default */ }
        this.error = res.status === 403
          ? 'এই নথি তৈরির অনুমতি আপনার নেই।'
          : message;
        return;
      }
      this.previewHtml = await res.text();
      const n = this.count();
      this.notice = n > 1
        ? `${bnNum(n)} টি নথি তৈরি হয়েছে — নিচে দেখে নিয়ে ছাপুন।`
        : 'নথি তৈরি হয়েছে — দেখে নিয়ে ছাপুন।';
    } catch {
      this.error = 'সংযোগ নেই — নথি তৈরি করা যায়নি।';
    } finally {
      this.generating = false; this.render();
    }
  }

  /** How many documents this run produces, for the confirmation copy. */
  private count(): number {
    switch (this.spec()?.needs) {
      case 'exam+students':
      case 'students': return this.selected.size;
      case 'student': return 1;
      default: return 1;
    }
  }

  private print(): void {
    const frame = this.o.root.querySelector('iframe');
    const win = (frame as HTMLIFrameElement | null)?.contentWindow;
    if (!win) { this.error = 'পূর্বরূপ প্রস্তুত নয় — আবার তৈরি করুন।'; this.render(); return; }
    // Focus first: some browsers ignore print() on a background frame.
    win.focus();
    win.print();
  }

  // ── render ────────────────────────────────────────────────────────────

  private render(): void {
    const d = this.o.doc;
    const root = this.o.root;
    root.textContent = '';

    const header = d.createElement('header');
    header.className = 'page-header';
    const h1 = d.createElement('h1');
    h1.textContent = 'নথি ও ছাপা';
    const sub = d.createElement('p');
    sub.className = 'page-sub';
    sub.textContent = this.kind
      ? this.spec()!.labelBn
      : 'প্রতিষ্ঠানের নিজস্ব লোগো, সিল ও স্বাক্ষরসহ';
    header.append(h1, sub);
    root.append(header);

    if (this.notice) root.append(successNote(d, this.notice));
    if (this.error) {
      root.append(errorState(d, this.error,
        this.error.includes('অনুমতি') ? undefined : () => {
          this.error = '';
          if (this.kind) void this.pick(this.kind); else this.render();
        }));
      if (this.error.includes('অনুমতি')) { root.append(this.typePicker()); return; }
    }

    if (!this.kind) { root.append(this.typePicker()); return; }

    root.append(this.backBar());
    if (this.loading) { root.append(skeleton(d, 3)); return; }

    root.append(this.selectors());
    root.append(this.actions());
    if (this.previewHtml) root.append(this.preview());
  }

  private typePicker(): HTMLElement {
    const d = this.o.doc;
    const wrap = d.createElement('div');

    const offered = DOCS.filter((s) => this.o.allowed.includes(s.kind));
    if (offered.length === 0) {
      wrap.append(emptyState(d, {
        message: 'আপনার ভূমিকার জন্য কোনো নথি তৈরির অনুমতি নেই।',
      }));
      return wrap;
    }

    const list = d.createElement('div');
    list.className = 'system-list';
    for (const s of offered) {
      const row = d.createElement('button');
      row.type = 'button';
      row.className = 'system-row';
      const t = d.createElement('span');
      t.className = 'system-title';
      t.textContent = s.labelBn;
      const desc = d.createElement('span');
      desc.className = 'system-desc';
      desc.textContent = s.descBn;
      row.append(t, desc);
      if (s.bulk) {
        const chip = d.createElement('span');
        chip.className = 'status-chip';
        chip.textContent = 'একসাথে সবার';
        row.append(chip);
      }
      row.addEventListener('click', () => void this.pick(s.kind));
      list.append(row);
    }
    wrap.append(list);
    return wrap;
  }

  private backBar(): HTMLElement {
    const d = this.o.doc;
    const bar = d.createElement('div');
    bar.className = 'back-bar';
    const back = d.createElement('button');
    back.type = 'button';
    back.className = 'back-btn';
    back.textContent = '← অন্য নথি';
    back.addEventListener('click', () => {
      this.kind = null; this.previewHtml = ''; this.error = ''; this.notice = '';
      this.render();
    });
    bar.append(back);
    return bar;
  }

  private selectors(): HTMLElement {
    const d = this.o.doc;
    const wrap = d.createElement('div');
    const need = this.spec()!.needs;

    if (need === 'receipt') { wrap.append(this.receiptPicker()); return wrap; }

    if (need === 'exam+students') wrap.append(this.examPicker());
    wrap.append(this.sectionPicker());
    if (need !== 'section') wrap.append(this.studentPicker());
    return wrap;
  }

  private receiptPicker(): HTMLElement {
    const d = this.o.doc;
    const wrap = d.createElement('div');
    const h = d.createElement('h2');
    h.className = 'section-heading';
    h.textContent = 'রসিদ বেছে নিন';
    wrap.append(h);

    if (this.receipts.length === 0) {
      wrap.append(emptyState(d, {
        message: 'এখনো কোনো পরিশোধের রসিদ নেই। ফি জমা হলে এখানে রসিদ দেখা যাবে।',
      }));
      return wrap;
    }

    const list = d.createElement('div');
    list.className = 'system-list';
    for (const r of this.receipts) {
      const row = d.createElement('button');
      row.type = 'button';
      row.className = 'system-row';
      if (r.id === this.receiptId) row.setAttribute('aria-current', 'true');
      const t = d.createElement('span');
      t.className = 'system-title';
      t.textContent = r.receiptNo;
      const desc = d.createElement('span');
      desc.className = 'system-desc';
      desc.textContent = `${bnDate(r.issuedAt)} · ${formatBdt(r.amount)}`
        + (r.studentNameBn ? ` · ${r.studentNameBn}` : '');
      row.append(t, desc);
      row.addEventListener('click', () => {
        this.receiptId = r.id; this.previewHtml = ''; this.error = ''; this.render();
      });
      list.append(row);
    }
    wrap.append(list);
    return wrap;
  }

  private examPicker(): HTMLElement {
    const d = this.o.doc;
    const wrap = d.createElement('div');
    const field = d.createElement('label');
    field.className = 'field';
    field.style.padding = '0 var(--s-4)';
    field.textContent = 'পরীক্ষা';

    if (this.exams.length === 0) {
      wrap.append(emptyState(d, {
        message: this.kind === 'report_card'
          ? 'প্রকাশিত ফলাফলসহ কোনো পরীক্ষা পাওয়া যায়নি। ফলাফল প্রকাশের পর প্রগতি পত্র তৈরি করা যাবে।'
          : 'কোনো পরীক্ষা পাওয়া যায়নি।',
      }));
      return wrap;
    }

    const select = d.createElement('select');
    select.className = 'field-input';
    const blank = d.createElement('option');
    blank.value = ''; blank.textContent = 'বেছে নিন…';
    select.append(blank);
    // A report card is only meaningful for a published exam; the endpoint
    // refuses otherwise, so the picker does not offer it.
    const usable = this.kind === 'report_card'
      ? this.exams.filter((e) => e.status === 'published')
      : this.exams;
    for (const e of usable) {
      const opt = d.createElement('option');
      opt.value = e.examId;
      opt.textContent = e.examNameBn;
      opt.selected = e.examId === this.examId;
      select.append(opt);
    }
    select.addEventListener('change', () => {
      this.examId = select.value; this.previewHtml = ''; this.render();
    });
    field.append(select);
    wrap.append(field);
    return wrap;
  }

  private sectionPicker(): HTMLElement {
    const d = this.o.doc;
    const wrap = d.createElement('div');
    const field = d.createElement('label');
    field.className = 'field';
    field.style.padding = 'var(--s-2) var(--s-4) 0';
    field.textContent = 'শ্রেণি ও শাখা';

    const options: { id: string; label: string; n: number }[] = [];
    for (const lvl of this.tree?.classes ?? []) {
      for (const g of lvl.groups) {
        for (const s of g.sections) {
          options.push({
            id: s.id,
            label: `${lvl.nameBn} · ${g.groupBn} · ${s.name}`,
            n: s.studentCount,
          });
        }
      }
    }

    if (options.length === 0) {
      wrap.append(emptyState(d, {
        message: 'কোনো শাখা তৈরি হয়নি। একাডেমিক কাঠামোতে শাখা তৈরি করুন।',
      }));
      return wrap;
    }

    const select = d.createElement('select');
    select.className = 'field-input';
    const blank = d.createElement('option');
    blank.value = ''; blank.textContent = 'বেছে নিন…';
    select.append(blank);
    for (const o of options) {
      const opt = d.createElement('option');
      opt.value = o.id;
      opt.textContent = `${o.label} (${bnNum(o.n)} জন)`;
      opt.selected = o.id === this.sectionId;
      select.append(opt);
    }
    select.addEventListener('change', () => {
      if (select.value) void this.loadRoster(select.value);
    });
    field.append(select);
    wrap.append(field);
    return wrap;
  }

  private studentPicker(): HTMLElement {
    const d = this.o.doc;
    const wrap = d.createElement('div');
    if (!this.sectionId) return wrap;

    const single = this.spec()!.needs === 'student';
    const h = d.createElement('h2');
    h.className = 'section-heading';
    h.textContent = single ? 'শিক্ষার্থী' : `শিক্ষার্থী · ${bnNum(this.selected.size)} নির্বাচিত`;
    wrap.append(h);

    if (this.roster.length === 0) {
      wrap.append(emptyState(d, { message: 'এই শাখায় কোনো শিক্ষার্থী নেই।' }));
      return wrap;
    }

    if (!single) {
      const bar = d.createElement('div');
      bar.className = 'action-row';
      bar.style.padding = '0 var(--s-4) var(--s-2)';
      const all = d.createElement('button');
      all.type = 'button';
      all.className = 'btn-ghost btn-small';
      const everyone = this.selected.size === this.roster.length;
      all.textContent = everyone ? 'সবার নির্বাচন বাতিল' : 'সবাইকে নির্বাচন করুন';
      all.addEventListener('click', () => {
        if (everyone) this.selected.clear();
        else for (const s of this.roster) this.selected.add(s.studentId);
        this.previewHtml = ''; this.render();
      });
      bar.append(all);
      wrap.append(bar);
    }

    const list = d.createElement('ul');
    list.className = 'roster-list';
    for (const s of this.roster) {
      const li = d.createElement('li');
      li.className = 'roster-row';
      const box = d.createElement('input');
      box.type = single ? 'radio' : 'checkbox';
      if (single) box.name = 'doc-student';
      box.checked = this.selected.has(s.studentId);
      box.setAttribute('aria-label', s.nameBn);
      box.addEventListener('change', () => {
        if (single) { this.selected.clear(); if (box.checked) this.selected.add(s.studentId); }
        else if (box.checked) this.selected.add(s.studentId);
        else this.selected.delete(s.studentId);
        this.previewHtml = '';
        this.render();
      });
      const roll = d.createElement('span');
      roll.className = 'roster-roll';
      roll.textContent = bnNum(s.rollNo);
      const name = d.createElement('span');
      name.className = 'roster-name';
      name.textContent = s.nameBn;
      li.append(box, roll, name);
      list.append(li);
    }
    wrap.append(list);
    return wrap;
  }

  private actions(): HTMLElement {
    const d = this.o.doc;
    const wrap = d.createElement('div');
    wrap.className = 'action-row';
    wrap.style.padding = 'var(--s-3) var(--s-4)';

    const n = this.count();
    if (this.spec()!.bulk && this.selected.size > 0) {
      // The count the brief asks for, said before the button rather than
      // discovered from a print dialogue with forty pages in it.
      const note = d.createElement('p');
      note.className = 'att-sub';
      note.style.marginInlineEnd = 'auto';
      note.textContent = `${bnNum(n)} জন নির্বাচিত · ${bnNum(n)} টি নথি তৈরি হবে`;
      wrap.append(note);
    }

    const go = d.createElement('button');
    go.type = 'button';
    go.className = 'btn-primary';
    go.disabled = this.generating;
    go.textContent = this.generating
      ? (n > 1 ? `${bnNum(n)} টি তৈরি হচ্ছে…` : 'তৈরি হচ্ছে…')
      : (this.previewHtml ? 'আবার তৈরি করুন' : 'পূর্বরূপ দেখুন');
    go.addEventListener('click', () => void this.generate());
    wrap.append(go);

    if (this.previewHtml) {
      const print = d.createElement('button');
      print.type = 'button';
      print.className = 'btn-secondary';
      print.textContent = 'ছাপুন';
      print.addEventListener('click', () => this.print());
      wrap.append(print);
    }
    return wrap;
  }

  private preview(): HTMLElement {
    const d = this.o.doc;
    const wrap = d.createElement('section');
    const h = d.createElement('h2');
    h.className = 'section-heading';
    h.textContent = 'পূর্বরূপ';
    wrap.append(h);

    const note = d.createElement('p');
    note.className = 'att-sub';
    note.style.padding = '0 var(--s-4) var(--s-2)';
    // Say where the PDF comes from: this product has no PDF renderer and no
    // bucket, and a school looking for a "Download PDF" button should be
    // told where the file actually comes from rather than left hunting.
    note.textContent = 'ছাপার সময় "Save as PDF" বেছে নিলে পিডিএফ ফাইল সংরক্ষণ করা যাবে।';
    wrap.append(note);

    const frame = d.createElement('iframe');
    frame.className = 'doc-preview';
    frame.title = `${this.spec()?.labelBn ?? 'নথি'} — পূর্বরূপ`;
    // Sandboxed, and `allow-scripts` is deliberately absent: the document is
    // server-generated markup in which every interpolated value is escaped,
    // and with no script permission nothing in it can execute even if that
    // escaping were ever wrong. Defence that does not depend on the
    // escaping being right.
    //
    // `allow-same-origin` IS granted, because the print button calls
    // `contentWindow.print()` from the parent and an opaque origin would
    // block it. Same-origin without scripts is the safe half of the pair —
    // it grants the parent a handle, not the frame a capability.
    frame.setAttribute('sandbox', 'allow-same-origin allow-modals');
    frame.srcdoc = this.previewHtml;
    wrap.append(frame);
    return wrap;
  }
}
