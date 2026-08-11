/**
 * Exam routine with per-student clash check — F-510, wireframe §8.3
 *
 * The spec calls this "the screen that proves the subject-based model".
 * Two legitimate Class 11 Science subjects share a slot; nothing is wrong
 * at class level; four named students cannot be in both rooms. It only
 * becomes visible when the routine is checked against each student's own
 * resolved subject set.
 *
 * Three things that follow from that, and shape this file:
 *
 * The clash panel names students. §8.3 shows roll, name and the two
 * subjects, not a count — "৪ জন" is the headline, the names are the
 * content. A coordinator told "4 clashes" goes hunting; a coordinator told
 * "১০৪ মাহির ফয়সাল — উচ্চতর গণিত + জীববিজ্ঞান" fixes it.
 *
 * BOTH papers of a pair are flagged, not just the later one, because the
 * coordinator has to choose which of the two to move.
 *
 * The publish button is never a lie. It is disabled while clashes stand
 * and says why. If it were somehow pressed anyway the server would refuse
 * — the gate is a database trigger — so this is courtesy, not security.
 *
 * Framework-free manual DOM, same as every other view here.
 */
import type { Auth } from './auth.ts';
import {
  formatCount, formatIdentifier, formatDayMonth, formatTime,
} from '../../../packages/ui-core/src/format.ts';

const bn = (n: number): string => formatCount(n, 'bn');

export interface ExamSummary {
  id: string;
  nameBn: string;
  examType: string;
  startsOn: string;
  endsOn: string;
  status: string;
}

export interface PaperRow {
  examSubjectId: string;
  sectionName: string;
  subjectBn: string;
  examDate: string | null;
  startTime: string | null;
  endTime: string | null;
  durationMinutes: number | null;
  hasClash: boolean;
}

export interface ClashRow {
  studentNameBn: string;
  rollNo: number;
  sectionName: string;
  examDate: string;
  subjectABn: string;
  subjectBBn: string;
  startA: string;
  startB: string;
}

interface RoutinePayload {
  exam: ExamSummary;
  papers: PaperRow[];
  clashes: ClashRow[];
  affectedStudents: number;
  canPublish: boolean;
}

export interface ExamRoutineViewOptions {
  root: HTMLElement;
  doc: Document;
  auth: Auth;
}

const ENDPOINT = '/api/v1/rms/examroutine';

export class ExamRoutineView {
  private readonly o: ExamRoutineViewOptions;
  private exams: ExamSummary[] = [];
  private selected: string | null = null;
  private data: RoutinePayload | null = null;
  private loading = true;
  private error: string | null = null;
  private busy = false;
  /** The paper whose inline reschedule row is open, if any. */
  private editing: string | null = null;

  constructor(options: ExamRoutineViewOptions) {
    this.o = options;
    this.render();
    void this.loadExams();
  }

  private async loadExams(): Promise<void> {
    try {
      const res = await this.o.auth.authedFetch(ENDPOINT);
      if (!res.ok) throw new Error(String(res.status));
      const body = (await res.json()) as { exams?: ExamSummary[] };
      this.exams = body.exams ?? [];
      this.selected = this.exams[0]?.id ?? null;
      if (this.selected) { await this.loadRoutine(); return; }
      this.loading = false;
      this.render();
    } catch {
      this.loading = false;
      this.error = 'পরীক্ষার তালিকা লোড হয়নি।';
      this.render();
    }
  }

  private async loadRoutine(): Promise<void> {
    if (!this.selected) return;
    this.loading = true;
    this.error = null;
    this.render();
    try {
      const res = await this.o.auth.authedFetch(
        `${ENDPOINT}?examId=${encodeURIComponent(this.selected)}`);
      if (!res.ok) throw new Error(String(res.status));
      this.data = (await res.json()) as RoutinePayload;
    } catch {
      this.error = 'রুটিন লোড হয়নি।';
    } finally {
      this.loading = false;
      this.render();
    }
  }

  private async post(body: Record<string, unknown>): Promise<void> {
    if (!this.selected || this.busy) return;
    this.busy = true;
    this.render();
    try {
      const res = await this.o.auth.authedFetch(ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ examId: this.selected, ...body }),
      });
      const payload = (await res.json()) as RoutinePayload & { message?: string };
      if (res.ok) {
        this.data = payload;
        this.editing = null;
        this.error = null;
      } else {
        // The server's refusal is the honest text: it names a student.
        this.error = payload.message ?? 'কাজটি সম্পন্ন হয়নি।';
        await this.loadRoutine();
        return;
      }
    } catch {
      this.error = 'সংযোগ পাওয়া যায়নি। পরে চেষ্টা করুন।';
    } finally {
      this.busy = false;
      this.render();
    }
  }

  // ── rendering ───────────────────────────────────────────────────────
  private render(): void {
    const d = this.o.doc;
    const root = this.o.root;
    root.textContent = '';
    root.setAttribute('lang', 'bn');

    const exam = this.data?.exam ?? this.exams.find((e) => e.id === this.selected) ?? null;

    const header = d.createElement('header');
    header.className = 'page-header';
    const h1 = d.createElement('h1');
    h1.textContent = 'পরীক্ষার রুটিন';
    const sub = d.createElement('p');
    sub.className = 'page-sub';
    sub.textContent = this.loading ? 'লোড হচ্ছে…' : (exam?.nameBn ?? '');
    header.append(h1, sub);
    root.append(header);

    if (this.exams.length > 1) root.append(this.selector());
    if (this.error) root.append(this.notice(`${this.error}`, 'inline-notice is-danger'));

    if (this.loading) { root.append(this.skeleton()); return; }
    if (!exam) { root.append(this.empty()); return; }

    root.append(this.actions(exam));
    if (this.data) {
      root.append(this.paperTable(this.data.papers));
      if (this.data.clashes.length > 0) root.append(this.clashPanel(this.data));
    }
  }

  private selector(): HTMLElement {
    const d = this.o.doc;
    const bar = d.createElement('div');
    bar.className = 'seg-bar';
    bar.setAttribute('role', 'tablist');
    bar.setAttribute('aria-label', 'পরীক্ষা নির্বাচন');
    for (const e of this.exams) {
      const b = d.createElement('button');
      b.type = 'button';
      b.className = 'seg-opt';
      b.setAttribute('role', 'tab');
      b.setAttribute('aria-selected', String(e.id === this.selected));
      b.dataset.active = String(e.id === this.selected);
      b.textContent = e.nameBn;
      b.addEventListener('click', () => {
        if (e.id === this.selected) return;
        this.selected = e.id;
        this.data = null;
        this.editing = null;
        void this.loadRoutine();
      });
      bar.append(b);
    }
    return bar;
  }

  private actions(exam: ExamSummary): HTMLElement {
    const d = this.o.doc;
    const box = d.createElement('div');
    box.className = 'card action-row';

    const state = d.createElement('span');
    state.className = 'status-chip';
    const published = exam.status === 'published';
    state.dataset.state = published ? 'success' : 'pending';
    state.textContent = published ? '✓ প্রকাশিত' : '✎ খসড়া';
    box.append(state);

    // §8.3's [ যাচাই ]. Re-runs the check against the live roster — a
    // student's optional subject can change between one look and the next.
    const verify = d.createElement('button');
    verify.type = 'button';
    verify.className = 'btn-secondary';
    verify.textContent = 'যাচাই';
    verify.disabled = this.busy;
    verify.addEventListener('click', () => { void this.loadRoutine(); });
    box.append(verify);

    if (!published) {
      const pub = d.createElement('button');
      pub.type = 'button';
      pub.className = 'btn-primary';
      pub.textContent = 'প্রকাশ করুন';
      const blocked = !(this.data?.canPublish ?? false);
      pub.disabled = this.busy || blocked;
      if (blocked) {
        // Disabled with a stated reason, never disabled and silent.
        pub.title = 'সময় সংঘর্ষ থাকা অবস্থায় রুটিন প্রকাশ করা যাবে না';
        pub.setAttribute('aria-describedby', 'clash-panel');
      }
      pub.addEventListener('click', () => { void this.post({ publish: true }); });
      box.append(pub);
    }
    return box;
  }

  private paperTable(papers: PaperRow[]): HTMLElement {
    const d = this.o.doc;
    if (papers.length === 0) return this.empty();

    const wrap = d.createElement('div');
    wrap.className = 'table-scroll';
    const table = d.createElement('table');
    table.className = 'data-table';

    const thead = d.createElement('thead');
    const hr = d.createElement('tr');
    for (const label of ['তারিখ', 'সময়', 'বিষয়', 'শাখা', 'অবস্থা']) {
      const th = d.createElement('th');
      th.scope = 'col';
      th.textContent = label;
      hr.append(th);
    }
    thead.append(hr);
    table.append(thead);

    const tbody = d.createElement('tbody');
    for (const p of papers) {
      const tr = d.createElement('tr');
      if (p.hasClash) tr.classList.add('is-flagged');

      const date = d.createElement('th');
      date.scope = 'row';
      date.textContent = p.examDate ? formatDayMonth(p.examDate, 'bn') : '—';
      tr.append(date);

      const time = d.createElement('td');
      time.textContent = p.startTime && p.endTime
        ? `${formatTime(p.startTime, 'bn')}–${formatTime(p.endTime, 'bn')}`
        : 'সময় নির্ধারিত হয়নি';
      tr.append(time);

      for (const text of [p.subjectBn, p.sectionName]) {
        const td = d.createElement('td');
        td.textContent = text;
        tr.append(td);
      }

      // A glyph AND a word. Colour and shape alone fail F-812, and a bare
      // tells a coordinator nothing about what to do.
      const st = d.createElement('td');
      const chip = d.createElement('span');
      chip.className = 'status-chip';
      chip.dataset.state = p.hasClash ? 'warning' : 'success';
      chip.textContent = p.hasClash ? 'সংঘর্ষ' : '✓ ঠিক আছে';
      st.append(chip);
      tr.append(st);

      tbody.append(tr);

      if (p.hasClash && this.data?.exam.status !== 'published') {
        tbody.append(this.rescheduleRow(p));
      }
    }
    table.append(tbody);
    wrap.append(table);
    return wrap;
  }

  /** §8.3's [ সময় পরিবর্তন করুন ], inline under the paper it moves. */
  private rescheduleRow(p: PaperRow): HTMLElement {
    const d = this.o.doc;
    const tr = d.createElement('tr');
    tr.className = 'row-action';
    const td = d.createElement('td');
    td.colSpan = 5;

    if (this.editing !== p.examSubjectId) {
      const open = d.createElement('button');
      open.type = 'button';
      open.className = 'btn-secondary btn-small';
      open.textContent = 'সময় পরিবর্তন করুন';
      open.disabled = this.busy;
      open.addEventListener('click', () => { this.editing = p.examSubjectId; this.render(); });
      td.append(open);
      tr.append(td);
      return tr;
    }

    const form = d.createElement('div');
    form.className = 'inline-form';

    const dateIn = d.createElement('input');
    dateIn.type = 'date';
    dateIn.value = p.examDate ?? '';
    dateIn.setAttribute('aria-label', `${p.subjectBn} — নতুন তারিখ`);

    const timeIn = d.createElement('input');
    timeIn.type = 'time';
    timeIn.value = p.startTime ?? '';
    timeIn.setAttribute('aria-label', `${p.subjectBn} — নতুন সময়`);

    const save = d.createElement('button');
    save.type = 'button';
    save.className = 'btn-primary btn-small';
    save.textContent = 'সংরক্ষণ';
    save.disabled = this.busy;
    save.addEventListener('click', () => {
      if (!dateIn.value || !timeIn.value) {
        this.error = 'তারিখ ও সময় দুটোই দিতে হবে।';
        this.render();
        return;
      }
      void this.post({
        reschedule: {
          examSubjectId: p.examSubjectId,
          examDate: dateIn.value,
          startTime: timeIn.value.slice(0, 5),
        },
      });
    });

    const cancel = d.createElement('button');
    cancel.type = 'button';
    cancel.className = 'btn-secondary btn-small';
    cancel.textContent = 'বাতিল';
    cancel.addEventListener('click', () => { this.editing = null; this.render(); });

    form.append(dateIn, timeIn, save, cancel);
    td.append(form);
    tr.append(td);
    return tr;
  }

  private clashPanel(data: RoutinePayload): HTMLElement {
    const d = this.o.doc;
    const box = d.createElement('section');
    box.className = 'card urgency-rail-card';
    box.id = 'clash-panel';
    box.setAttribute('role', 'group');

    const h = d.createElement('h2');
    h.className = 'clash-head';
    // The headline counts STUDENTS, as §8.3 does. One student sitting three
    // overlapping papers is one child with a problem, not three.
    h.textContent = `${bn(data.affectedStudents)} জন শিক্ষার্থীর দুটি পরীক্ষা একই সময়ে`;
    box.append(h);

    const ul = d.createElement('ul');
    ul.className = 'clash-list';
    for (const c of data.clashes) {
      const li = d.createElement('li');

      const roll = d.createElement('span');
      roll.className = 'clash-roll';
      // Roll numbers are identifiers, so they stay in Latin digits —
      // the same rule the roster and the mark sheet follow.
      roll.textContent = formatIdentifier(c.rollNo);

      const name = d.createElement('span');
      name.className = 'clash-name';
      name.textContent = c.studentNameBn;

      const what = d.createElement('span');
      what.className = 'clash-subjects';
      what.textContent = `${c.subjectABn} + ${c.subjectBBn}`;

      const when = d.createElement('span');
      when.className = 'clash-when';
      when.textContent = `${formatDayMonth(c.examDate, 'bn')} · ${formatTime(c.startA, 'bn')}`;

      li.append(roll, name, what, when);
      ul.append(li);
    }
    box.append(ul);
    return box;
  }

  private skeleton(): HTMLElement {
    const d = this.o.doc;
    const box = d.createElement('div');
    box.setAttribute('aria-busy', 'true');
    box.setAttribute('aria-label', 'রুটিন লোড হচ্ছে');
    for (let i = 0; i < 4; i++) {
      const card = d.createElement('div');
      card.className = 'card is-skeleton';
      const a = d.createElement('div'); a.className = 'skel skel-title';
      const b = d.createElement('div'); b.className = 'skel skel-line';
      card.append(a, b);
      box.append(card);
    }
    return box;
  }

  private empty(): HTMLElement {
    const d = this.o.doc;
    const box = d.createElement('div');
    box.className = 'empty-state';
    const glyph = d.createElement('div');
    glyph.className = 'empty-glyph';
    glyph.textContent = '⃝';
    glyph.setAttribute('aria-hidden', 'true');
    const msg = d.createElement('p');
    msg.textContent = 'এই শিক্ষাবর্ষে কোনো পরীক্ষার সময়সূচি তৈরি হয়নি।';
    box.append(glyph, msg);
    return box;
  }

  private notice(text: string, cls: string): HTMLElement {
    const p = this.o.doc.createElement('p');
    p.className = cls;
    p.setAttribute('role', 'status');
    p.textContent = text;
    return p;
  }
}
