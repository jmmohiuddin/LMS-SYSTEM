/**
 * শিক্ষার্থী খুঁজুন — global student search, and one child's whole history.  (R-6)
 *
 * The master plan's exit criterion is a sentence about a person: "principal
 * types an old ID or a name; the student's full multi-year history appears".
 * This screen is that sentence.
 *
 *     খুঁজুন → তালিকা → একজনকে খুলুন → বছরওয়ারি ইতিহাস
 *
 * ── Two loads, not one ──────────────────────────────────────────────────
 * §15 of the brief, and it is the whole performance design: the search
 * returns a COMPACT row per student — name, code, latest class/section/roll,
 * status — and nothing else. A result list that carried each child's four
 * years of enrolment, attendance and results would do twenty-five students'
 * worth of history work to render one screen, and the person wanted one of
 * them. Opening a student is the second load.
 *
 * ── One route, two states ───────────────────────────────────────────────
 * The list and the detail live in one view rather than two routes, because
 * the back button has to return to the SEARCH RESULTS and not to an empty
 * search box. A hash route would lose the query; keeping both states here
 * means `← ফলাফলে ফিরুন` returns to exactly what was on screen.
 *
 * ── Current versus historical ───────────────────────────────────────────
 * §6 asks for these to be visibly different, and the timeline makes it
 * structural rather than cosmetic: the year whose enrolment is `active` is
 * rendered as the current row with its own heading, and every other year is
 * history. That flag comes from the server (`isCurrent`), computed from
 * `enrolments.status`, so a graduated child correctly has NO current row —
 * rather than the app assuming the last one must be.
 */
import type { Auth } from './auth.ts';
import { skeleton, errorState, emptyState, bnNum, bnDate } from './view-states.ts';

export interface StudentsViewOptions {
  root: HTMLElement;
  doc: Document;
  auth: Auth;
}

/**
 * The lifecycle values `student_profiles.lifecycle_status` actually permits.
 *
 * R-6's brief named six English words — Active, Transferred, Withdrawn,
 * Graduated, Archived, Alumni — and the column's CHECK permits six different
 * ones. The brief also says to reuse the existing model, so these are the
 * column's, with the Bangla a school would use. 'Archived' has no equivalent
 * and is not invented.
 */
const STATUS_BN: Record<string, string> = {
  enrolled: 'অধ্যয়নরত',
  promoted: 'উন্নীত',
  transferred_out: 'ছাড়পত্র নিয়েছে',
  dropped_out: 'ঝরে পড়েছে',
  graduated: 'উত্তীর্ণ',
  alumni: 'প্রাক্তন শিক্ষার্থী',
};

const ENROLMENT_STATUS_BN: Record<string, string> = {
  active: 'চলমান',
  promoted: 'উন্নীত',
  transferred: 'বদলি',
  left: 'ছেড়েছে',
  detained: 'একই শ্রেণিতে',
};

interface SearchResult {
  id: string;
  name: { bn: string; en: string | null };
  studentCode: string;
  lifecycleStatus: string;
  latest: {
    yearLabel: string; classBn: string | null; groupBn: string | null;
    section: string | null; rollNo: number | null; isCurrent: boolean;
  } | null;
}

interface SearchPayload {
  total: number; limit: number; offset: number;
  matchedOn: string | null;
  students: SearchResult[];
}

interface HistoryPayload {
  student: {
    id: string; name: { bn: string; en: string | null }; studentCode: string;
    lifecycleStatus: string; admissionDate: string; graduatedOn: string | null;
    bloodGroup: string | null; fatherNameBn: string | null;
    motherNameBn: string | null; dateOfBirth: string | null; phone: string | null;
    boardRegistrationNo: string | null; boardRollNo: string | null;
  };
  enrolments: {
    yearLabel: string; classBn: string; classEn: string; levelNo: number;
    groupBn: string; section: string; shift: string; rollNo: number;
    status: string; enrolledOn: string; endedOn: string | null; isCurrent: boolean;
  }[];
  attendance: {
    yearLabel: string; present: number; absent: number; late: number;
    excused: number; halfDay: number; total: number; percent: number | null;
  }[];
  results: {
    yearLabel: string; examBn: string; totalMarks: string | null;
    totalMax: string | null; percentage: string | null; gpa: string | null;
    letterGrade: string | null; isPass: boolean; rankInSection: number | null;
  }[];
  fees: {
    years: { yearLabel: string; invoices: number; billed: string; paid: string; due: string }[];
    receipts: { id: string; receiptNo: string; issuedAt: string; amount: string;
                method: string; invoiceNo: string }[];
  } | null;
  documents: string[];
  certificates: string[];
  permissions: { fees: boolean; contact: boolean };
}

const DOC_LABEL_BN: Record<string, string> = {
  fee_receipt: 'ফি রসিদ',
  report_card: 'প্রগতি পত্র',
  admit_card: 'প্রবেশপত্র',
  id_card: 'পরিচয়পত্র',
  transfer_certificate: 'ছাড়পত্র',
};

type Tab = 'profile' | 'enrolments' | 'attendance' | 'results' | 'fees' | 'documents';

const TAB_BN: Record<Tab, string> = {
  profile: 'পরিচিতি',
  enrolments: 'ভর্তির ইতিহাস',
  attendance: 'হাজিরা',
  results: 'ফলাফল',
  fees: 'ফি',
  documents: 'নথি',
};

export class StudentsView {
  private readonly o: StudentsViewOptions;
  private readonly doc: Document;

  private q = '';
  private status = '';
  private searching = false;
  private searchError = '';
  private payload: SearchPayload | null = null;
  /** Distinguishes "not searched yet" from "searched and found nobody". */
  private searched = false;

  private openId: string | null = null;
  private history: HistoryPayload | null = null;
  private historyLoading = false;
  private historyError = '';
  private tab: Tab = 'enrolments';

  /** Bumped per request so a slow first search cannot overwrite a fast second. */
  private seq = 0;

  constructor(o: StudentsViewOptions) {
    this.o = o;
    this.doc = o.doc;
    this.render();
  }

  // ── Data ──────────────────────────────────────────────────────────────

  private async runSearch(offset = 0): Promise<void> {
    const text = this.q.trim();
    if (!text && !this.status) {
      this.searchError = 'অনুসন্ধানের জন্য অন্তত ২টি অক্ষর লিখুন।';
      this.payload = null; this.searched = false; this.render();
      return;
    }
    if (text && text.length < 2) {
      this.searchError = 'অনুসন্ধানের জন্য অন্তত ২টি অক্ষর লিখুন।';
      this.payload = null; this.searched = false; this.render();
      return;
    }

    const mine = ++this.seq;
    this.searching = true; this.searchError = ''; this.render();
    try {
      const p = new URLSearchParams();
      if (text) p.set('q', text);
      if (this.status) p.set('status', this.status);
      p.set('offset', String(offset));
      const res = await this.o.auth.authedFetch(`/api/v1/academics/students/search?${p}`);
      if (mine !== this.seq) return;      // a newer search already answered
      if (!res.ok) {
        let msg = 'শিক্ষার্থীদের তথ্য লোড করা যায়নি। আবার চেষ্টা করুন।';
        try {
          const body = await res.json() as { message?: string };
          if (body.message) msg = body.message;
        } catch { /* a non-JSON failure keeps the default */ }
        this.searchError = msg; this.payload = null;
        return;
      }
      this.payload = await res.json() as SearchPayload;
      this.searched = true;
    } catch {
      if (mine !== this.seq) return;
      this.searchError = 'সংযোগ নেই — শিক্ষার্থীদের তথ্য লোড করা যায়নি।';
      this.payload = null;
    } finally {
      if (mine === this.seq) { this.searching = false; this.render(); }
    }
  }

  private async open(id: string): Promise<void> {
    this.openId = id;
    this.history = null;
    this.historyError = '';
    this.historyLoading = true;
    this.tab = 'enrolments';
    this.render();
    try {
      const res = await this.o.auth.authedFetch(
        `/api/v1/academics/students/history?studentId=${encodeURIComponent(id)}`);
      if (!res.ok) {
        this.historyError = res.status === 404
          ? 'শিক্ষার্থী পাওয়া যায়নি।'
          : 'শিক্ষার্থীর তথ্য লোড করা যায়নি। আবার চেষ্টা করুন।';
        return;
      }
      this.history = await res.json() as HistoryPayload;
    } catch {
      this.historyError = 'সংযোগ নেই — শিক্ষার্থীর তথ্য লোড করা যায়নি।';
    } finally {
      this.historyLoading = false;
      this.render();
    }
  }

  // ── Render ────────────────────────────────────────────────────────────

  private render(): void {
    const d = this.doc;
    this.o.root.replaceChildren();

    const h = d.createElement('h2');
    h.className = 'page-header';
    h.textContent = 'শিক্ষার্থী খুঁজুন';
    this.o.root.append(h);

    if (this.openId) { this.renderDetail(); return; }
    this.renderSearch();
  }

  private renderSearch(): void {
    const d = this.doc;

    const form = d.createElement('form');
    form.className = 'card card-form';
    form.addEventListener('submit', (e) => { e.preventDefault(); void this.runSearch(); });

    const label = d.createElement('label');
    label.className = 'field';
    label.textContent = 'আইডি, নাম, মোবাইল বা রেজিস্ট্রেশন নম্বর';
    label.htmlFor = 'stu-q';
    form.append(label);

    const input = d.createElement('input');
    input.id = 'stu-q';
    input.type = 'search';
    input.className = 'field-input';
    input.placeholder = 'STU-8F39A271 / রাফি হাসান / 01712…';
    input.value = this.q;
    input.autocomplete = 'off';
    input.addEventListener('input', () => { this.q = input.value; });
    form.append(input);

    const filters = d.createElement('div');
    filters.className = 'field';

    const statusLabel = d.createElement('label');
    statusLabel.className = 'field';
    statusLabel.textContent = 'অবস্থা';
    statusLabel.htmlFor = 'stu-status';
    const sel = d.createElement('select');
    sel.id = 'stu-status';
    sel.className = 'field-input';
    const any = d.createElement('option');
    any.value = ''; any.textContent = 'সব';
    sel.append(any);
    for (const [value, bn] of Object.entries(STATUS_BN)) {
      const opt = d.createElement('option');
      opt.value = value; opt.textContent = bn;
      if (value === this.status) opt.selected = true;
      sel.append(opt);
    }
    sel.addEventListener('change', () => { this.status = sel.value; void this.runSearch(); });
    filters.append(statusLabel, sel);
    form.append(filters);

    const go = d.createElement('button');
    go.type = 'submit';
    go.className = 'btn-primary';
    go.textContent = this.searching ? 'খোঁজা হচ্ছে…' : 'খুঁজুন';
    go.disabled = this.searching;
    form.append(go);
    this.o.root.append(form);

    if (this.searching) { this.o.root.append(skeleton(d, 4)); return; }

    if (this.searchError) {
      this.o.root.append(errorState(d, this.searchError, () => void this.runSearch()));
      return;
    }

    if (!this.searched || !this.payload) {
      // Not an error and not empty: nothing has been asked yet. Saying so
      // beats an empty panel that looks like a failed search.
      this.o.root.append(emptyState(d, {
        message: 'স্থায়ী আইডি, নাম বা মোবাইল নম্বর দিয়ে খুঁজুন। '
               + 'প্রাক্তন শিক্ষার্থীরাও পাওয়া যাবে।',
      }));
      return;
    }

    const p = this.payload;
    if (p.students.length === 0) {
      this.o.root.append(emptyState(d, { message: 'কোনো শিক্ষার্থী পাওয়া যায়নি।' }));
      return;
    }

    const count = d.createElement('p');
    count.className = 'page-sub';
    count.setAttribute('aria-live', 'polite');
    count.textContent = `${bnNum(p.total)} জন পাওয়া গেছে`
      + (p.total > p.students.length
        ? ` — ${bnNum(p.offset + 1)}–${bnNum(p.offset + p.students.length)} দেখানো হচ্ছে`
        : '');
    this.o.root.append(count);

    const list = d.createElement('div');
    list.className = 'system-list';
    for (const s of p.students) list.append(this.resultRow(s));
    this.o.root.append(list);

    if (p.total > p.offset + p.students.length || p.offset > 0) {
      this.o.root.append(this.pager(p));
    }
  }

  /**
   * One result row.
   *
   * Everything here exists to tell two children with the same name apart —
   * §3 — and nothing here is anything else. No guardian phone, no blood
   * group, no fee balance: the server does not send them to a list, so there
   * is nothing to hide in the markup.
   */
  private resultRow(s: SearchResult): HTMLElement {
    const d = this.doc;
    const btn = d.createElement('button');
    btn.type = 'button';
    btn.className = 'system-row';
    btn.addEventListener('click', () => void this.open(s.id));

    const main = d.createElement('span');
    main.className = 'system-body';

    const name = d.createElement('span');
    name.className = 'system-title';
    name.textContent = s.name.bn;
    main.append(name);

    const code = d.createElement('span');
    code.className = 'system-path';
    code.textContent = s.studentCode;
    main.append(code);

    const where = d.createElement('span');
    where.className = 'system-desc';
    if (s.latest) {
      const parts = [s.latest.classBn, s.latest.groupBn, s.latest.section ? `শাখা ${s.latest.section}` : null,
                     s.latest.rollNo != null ? `রোল ${bnNum(s.latest.rollNo)}` : null]
        .filter(Boolean);
      where.textContent = (s.latest.isCurrent ? '' : `${bnNum(s.latest.yearLabel)} · `) + parts.join(' · ');
    } else {
      where.textContent = 'কোনো ভর্তির তথ্য নেই';
    }
    main.append(where);
    btn.append(main);

    const chip = d.createElement('span');
    chip.className = 'system-chip';
    chip.textContent = STATUS_BN[s.lifecycleStatus] ?? s.lifecycleStatus;
    btn.append(chip);

    return btn;
  }

  private pager(p: SearchPayload): HTMLElement {
    const d = this.doc;
    const row = d.createElement('div');
    row.className = 'action-row';

    const prev = d.createElement('button');
    prev.type = 'button'; prev.className = 'btn-secondary';
    prev.textContent = '← আগের';
    prev.disabled = p.offset === 0;
    prev.addEventListener('click', () => void this.runSearch(Math.max(0, p.offset - p.limit)));

    const next = d.createElement('button');
    next.type = 'button'; next.className = 'btn-secondary';
    next.textContent = 'পরের →';
    next.disabled = p.offset + p.students.length >= p.total;
    next.addEventListener('click', () => void this.runSearch(p.offset + p.limit));

    row.append(prev, next);
    return row;
  }

  // ── The one student ───────────────────────────────────────────────────

  private renderDetail(): void {
    const d = this.doc;

    const back = d.createElement('button');
    back.type = 'button';
    back.className = 'btn-secondary';
    back.textContent = '← ফলাফলে ফিরুন';
    back.addEventListener('click', () => {
      this.openId = null; this.history = null; this.historyError = ''; this.render();
    });
    this.o.root.append(back);

    if (this.historyLoading) { this.o.root.append(skeleton(d, 6)); return; }
    if (this.historyError) {
      const id = this.openId;
      this.o.root.append(errorState(d, this.historyError, () => { if (id) void this.open(id); }));
      return;
    }
    const h = this.history;
    if (!h) return;

    const head = d.createElement('div');
    head.className = 'page-header';
    const name = d.createElement('h3');
    name.className = 'stu-name';
    name.textContent = h.student.name.bn;
    const sub = d.createElement('p');
    sub.className = 'page-sub';
    sub.textContent = `${h.student.studentCode} · ${STATUS_BN[h.student.lifecycleStatus] ?? h.student.lifecycleStatus}`;
    head.append(name, sub);
    this.o.root.append(head);

    const tabs = d.createElement('div');
    tabs.className = 'tab-row';
    tabs.setAttribute('role', 'tablist');
    for (const t of Object.keys(TAB_BN) as Tab[]) {
      // The fees tab is not rendered disabled for a role that may not see
      // fees — it is not rendered at all. A greyed-out tab tells a class
      // teacher that a balance exists and that they are not trusted with it,
      // which is worse than not mentioning money.
      if (t === 'fees' && !h.permissions.fees) continue;
      const b = d.createElement('button');
      b.type = 'button';
      b.className = t === this.tab ? 'tab is-active' : 'tab';
      b.setAttribute('role', 'tab');
      b.setAttribute('aria-selected', String(t === this.tab));
      b.textContent = TAB_BN[t];
      b.addEventListener('click', () => { this.tab = t; this.render(); });
      tabs.append(b);
    }
    this.o.root.append(tabs);

    const panel = d.createElement('div');
    panel.className = 'stu-panel';
    panel.setAttribute('role', 'tabpanel');
    this.o.root.append(panel);

    switch (this.tab) {
      case 'profile':    this.renderProfile(panel, h); break;
      case 'enrolments': this.renderTimeline(panel, h); break;
      case 'attendance': this.renderAttendance(panel, h); break;
      case 'results':    this.renderResults(panel, h); break;
      case 'fees':       this.renderFees(panel, h); break;
      case 'documents':  this.renderDocuments(panel, h); break;
    }
  }

  private renderProfile(panel: HTMLElement, h: HistoryPayload): void {
    const s = h.student;
    const rows: [string, string | null][] = [
      ['নাম', s.name.bn],
      ['ইংরেজি নাম', s.name.en],
      ['আইডি', s.studentCode],
      ['অবস্থা', STATUS_BN[s.lifecycleStatus] ?? s.lifecycleStatus],
      ['ভর্তির তারিখ', bnDate(s.admissionDate)],
      ['উত্তীর্ণ', s.graduatedOn ? bnDate(s.graduatedOn) : null],
      ['পিতা', s.fatherNameBn],
      ['মাতা', s.motherNameBn],
      ['জন্মতারিখ', s.dateOfBirth ? bnDate(s.dateOfBirth) : null],
      ['রক্তের গ্রুপ', s.bloodGroup],
      ['মোবাইল', s.phone],
      ['বোর্ড রেজি.', s.boardRegistrationNo],
    ];
    panel.append(this.definitionList(rows));

    if (!h.permissions.contact) {
      const note = this.doc.createElement('p');
      note.className = 'page-sub';
      note.textContent = 'যোগাযোগ ও ব্যক্তিগত তথ্য দেখার অনুমতি আপনার নেই।';
      panel.append(note);
    }
  }

  /**
   * The timeline — R-6's core acceptance requirement.
   *
   * Current and historical are separated by a heading rather than by a colour,
   * because §6 asks a person to be able to tell them apart and a tint is not
   * a distinction on a cheap phone in daylight.
   */
  private renderTimeline(panel: HTMLElement, h: HistoryPayload): void {
    const d = this.doc;
    if (h.enrolments.length === 0) {
      panel.append(emptyState(d, {
        message: 'এই শিক্ষার্থীর কোনো ভর্তির তথ্য নেই।',
      }));
      return;
    }

    const current = h.enrolments.filter((e) => e.isCurrent);
    const past = h.enrolments.filter((e) => !e.isCurrent);

    if (current.length > 0) {
      panel.append(this.sectionHeading('বর্তমান ভর্তি'));
      for (const e of current) panel.append(this.yearRow(e, true));
    }
    if (past.length > 0) {
      panel.append(this.sectionHeading(
        current.length > 0 ? 'পূর্ববর্তী বছরসমূহ' : 'ভর্তির ইতিহাস'));
      // Newest first in the past list: the year someone is looking for is
      // usually the most recent one they remember.
      for (const e of [...past].reverse()) panel.append(this.yearRow(e, false));
    }
  }

  private yearRow(
    e: HistoryPayload['enrolments'][number], isCurrent: boolean,
  ): HTMLElement {
    const d = this.doc;
    const row = d.createElement('div');
    row.className = isCurrent ? 'timeline-row is-current' : 'timeline-row';

    const year = d.createElement('span');
    year.className = 'timeline-year';
    year.textContent = bnNum(e.yearLabel);
    row.append(year);

    const body = d.createElement('span');
    body.className = 'timeline-body';

    const where = d.createElement('span');
    where.className = 'timeline-where';
    where.textContent = [e.classBn, e.groupBn, `শাখা ${e.section}`, `রোল ${bnNum(e.rollNo)}`]
      .filter(Boolean).join(' · ');
    body.append(where);

    const meta = d.createElement('span');
    meta.className = 'timeline-meta';
    meta.textContent = ENROLMENT_STATUS_BN[e.status] ?? e.status;
    if (e.endedOn) meta.textContent += ` · ${bnDate(e.endedOn)} পর্যন্ত`;
    body.append(meta);

    row.append(body);
    return row;
  }

  private renderAttendance(panel: HTMLElement, h: HistoryPayload): void {
    const d = this.doc;
    if (h.attendance.length === 0) {
      panel.append(emptyState(d, { message: 'এই শিক্ষার্থীর হাজিরার কোনো তথ্য নেই।' }));
      return;
    }
    const table = this.table(
      ['শিক্ষাবর্ষ', 'উপস্থিত', 'অনুপস্থিত', 'দেরি', 'ছুটি', 'শতকরা'],
      h.attendance.map((a) => [
        bnNum(a.yearLabel), bnNum(a.present), bnNum(a.absent),
        bnNum(a.late), bnNum(a.excused),
        a.percent == null ? '—' : `${bnNum(a.percent)}%`,
      ]),
    );
    panel.append(table);
  }

  private renderResults(panel: HTMLElement, h: HistoryPayload): void {
    const d = this.doc;
    if (h.results.length === 0) {
      panel.append(emptyState(d, {
        message: 'প্রকাশিত কোনো ফলাফল নেই। অপ্রকাশিত ফলাফল এখানে দেখানো হয় না।',
      }));
      return;
    }
    panel.append(this.table(
      ['শিক্ষাবর্ষ', 'পরীক্ষা', 'নম্বর', 'জিপিএ', 'গ্রেড', 'ফলাফল'],
      h.results.map((r) => [
        bnNum(r.yearLabel), r.examBn,
        r.totalMarks && r.totalMax ? `${bnNum(r.totalMarks)}/${bnNum(r.totalMax)}` : '—',
        r.gpa ? bnNum(r.gpa) : '—',
        r.letterGrade ?? '—',
        r.isPass ? 'উত্তীর্ণ' : 'অনুত্তীর্ণ',
      ]),
    ));
  }

  private renderFees(panel: HTMLElement, h: HistoryPayload): void {
    const d = this.doc;
    const f = h.fees;
    if (!f || (f.years.length === 0 && f.receipts.length === 0)) {
      panel.append(emptyState(d, { message: 'এই শিক্ষার্থীর কোনো ফি-র তথ্য নেই।' }));
      return;
    }
    if (f.years.length > 0) {
      panel.append(this.sectionHeading('বছরওয়ারি'));
      panel.append(this.table(
        ['শিক্ষাবর্ষ', 'বিল', 'জমা', 'বকেয়া'],
        f.years.map((y) => [
          bnNum(y.yearLabel), `৳ ${y.billed}`, `৳ ${y.paid}`, `৳ ${y.due}`,
        ]),
      ));
    }
    if (f.receipts.length > 0) {
      panel.append(this.sectionHeading('রসিদ'));
      panel.append(this.table(
        ['রসিদ', 'তারিখ', 'টাকা'],
        f.receipts.map((r) => [r.receiptNo, bnDate(r.issuedAt), `৳ ${r.amount}`]),
      ));
    }
  }

  /**
   * What this person may PRINT for this child — not a list of stored files.
   *
   * R-5 generates documents on demand and there is no object store, so there
   * are no document URLs to expose here and §10's rule is satisfied by there
   * being nothing to leak. The button hands the work to the R-5 screen, which
   * re-authorises the request itself.
   */
  private renderDocuments(panel: HTMLElement, h: HistoryPayload): void {
    const d = this.doc;
    const all = [...h.documents, ...h.certificates];
    if (all.length === 0) {
      panel.append(emptyState(d, { message: 'এই শিক্ষার্থীর জন্য নথি তৈরির অনুমতি আপনার নেই।' }));
      return;
    }

    const note = d.createElement('p');
    note.className = 'page-sub';
    note.textContent = 'প্রতিষ্ঠানের লেটারহেডে যেসব নথি আপনি তৈরি করতে পারেন:';
    panel.append(note);

    const list = d.createElement('ul');
    list.className = 'plain-list';
    for (const t of all) {
      const li = d.createElement('li');
      li.textContent = DOC_LABEL_BN[t] ?? t;
      list.append(li);
    }
    panel.append(list);

    const go = d.createElement('button');
    go.type = 'button';
    go.className = 'btn-secondary';
    go.textContent = 'নথি ও ছাপা খুলুন';
    go.addEventListener('click', () => { location.hash = '#/documents'; });
    panel.append(go);
  }

  // ── Small builders ────────────────────────────────────────────────────

  private sectionHeading(text: string): HTMLElement {
    const el = this.doc.createElement('h4');
    el.className = 'section-heading';
    el.textContent = text;
    return el;
  }

  private definitionList(rows: [string, string | null][]): HTMLElement {
    const d = this.doc;
    const dl = d.createElement('dl');
    dl.className = 'detail-list';
    for (const [k, v] of rows) {
      if (v == null || v === '') continue;
      const wrap = d.createElement('div');
      const dt = d.createElement('dt'); dt.textContent = k;
      const dd = d.createElement('dd'); dd.textContent = v;
      wrap.append(dt, dd);
      dl.append(wrap);
    }
    return dl;
  }

  private table(headers: string[], rows: string[][]): HTMLElement {
    const d = this.doc;
    // The wrapper scrolls, not the page: a six-column table on a 360px phone
    // must not push the whole app sideways.
    const wrap = d.createElement('div');
    wrap.className = 'table-scroll';
    const t = d.createElement('table');
    t.className = 'data-table';
    const thead = d.createElement('thead');
    const hr = d.createElement('tr');
    for (const h of headers) {
      const th = d.createElement('th');
      th.scope = 'col';
      th.textContent = h;
      hr.append(th);
    }
    thead.append(hr);
    const tbody = d.createElement('tbody');
    for (const r of rows) {
      const tr = d.createElement('tr');
      for (const cell of r) {
        const td = d.createElement('td');
        td.textContent = cell;
        tr.append(td);
      }
      tbody.append(tr);
    }
    t.append(thead, tbody);
    wrap.append(t);
    return wrap;
  }
}
