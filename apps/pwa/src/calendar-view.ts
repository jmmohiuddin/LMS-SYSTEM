/**
 * শিক্ষাপঞ্জি — the academic calendar  (R-4, docs/11-MASTER-PLAN.md)
 *
 * `calendar_days` has existed since migration 003 and has never had a screen,
 * while already being load-bearing: sms-svc reads it to suppress attendance
 * and notice SMS on holidays. This is the screen.
 *
 * ── Every role sees it; four roles can change it ────────────────────────
 * A school calendar a guardian cannot open is not a school calendar — ঈদের
 * ছুটি is exactly the thing a family plans around. So the read is universal
 * and only the controls are gated, by the server (migration 043's RESTRICTIVE
 * policies) with `canManage` deciding whether a button is drawn at all.
 *
 * ── The weekend comes from the tenant, never from a constant ────────────
 * `tenants.weekend_days` arrives in the response (0=Sun … 6=Sat). Monipur
 * runs {5,6}; many Madrasah run {5}. The month grid shades whatever it is
 * told, and there is no Friday in this file.
 *
 * ── Exams are drawn, not owned ──────────────────────────────────────────
 * Entries arriving with `editable: false` come from `exams` and
 * `exam_subjects` at read time. They render in the grid and open in the day
 * panel like anything else, and they carry no edit or delete control — the
 * routine screen is where an exam date changes. Copying them into
 * `calendar_days` would have made a second source of truth that goes stale
 * the first time a coordinator moves a paper.
 *
 * ── Offline ─────────────────────────────────────────────────────────────
 * READS are stale-while-revalidate in the service worker, exactly like the
 * inbox and the routine: a teacher opening the calendar on a dead link sees
 * the month they last loaded. WRITES are online-only and deliberately not
 * queued through the IndexedDB outbox — the outbox exists for attendance and
 * marks, which a teacher genuinely takes in a room with no signal. An IT
 * admin declaring next month's holiday from a corridor with no bars, to be
 * applied whenever the phone reconnects, is not a workflow; and a queued
 * holiday is one that silently suppresses SMS on a day nobody has agreed to
 * yet. See docs/07 §9g.
 */
import type { Auth } from './auth.ts';
import {
  skeleton, errorState, emptyState, successNote, confirmDialog, bnNum, bnDate,
} from './view-states.ts';
import { pageHeader } from './ui/page-header.ts';
import { permissionMessage } from './ui/index.ts';

export interface CalendarEntry {
  id: string;
  day: string;
  kind: string;
  titleBn: string;
  descriptionBn: string | null;
  appliesToShifts: string[] | null;
  academicYearId?: string;
  yearLabel?: string;
  createdByNameBn?: string | null;
  source: string;
  editable: boolean;
}

export interface CalendarPayload {
  range: { from: string; to: string };
  weekendDays: number[];
  shifts: string[];
  years: { id: string; label: string; isCurrent: boolean; startsOn: string; endsOn: string }[];
  currentYearId: string | null;
  entries: CalendarEntry[];
}

export interface CalendarViewOptions {
  root: HTMLElement;
  doc: Document;
  auth: Auth;
  /** Whether to offer the controls. The server and RLS are the gate. */
  canManage: boolean;
}

export const KIND_BN: Record<string, string> = {
  holiday: 'ছুটি',
  exam: 'পরীক্ষা',
  event: 'অনুষ্ঠান',
  ramadan_schedule: 'রমজানের সময়সূচি',
  working_weekend: 'খোলা',
};

const SHIFT_BN: Record<string, string> = {
  morning: 'সকাল', day: 'দিবা', evening: 'সন্ধ্যা', single: 'একক',
};

/** Sunday-first, matching `weekend_days` (0=Sun) and the BD working week. */
const WEEKDAY_BN = ['রবি', 'সোম', 'মঙ্গল', 'বুধ', 'বৃহঃ', 'শুক্র', 'শনি'];
const MONTH_BN = [
  'জানুয়ারি', 'ফেব্রুয়ারি', 'মার্চ', 'এপ্রিল', 'মে', 'জুন',
  'জুলাই', 'আগস্ট', 'সেপ্টেম্বর', 'অক্টোবর', 'নভেম্বর', 'ডিসেম্বর',
];

/** 'YYYY-MM-DD' in UTC — the same calendar the server stores dates in. */
function iso(y: number, m: number, d: number): string {
  return `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

export class CalendarView {
  private readonly o: CalendarViewOptions;
  private data: CalendarPayload | null = null;
  private loading = true;
  private error = '';
  private notice = '';
  private busy = false;

  /** The month on screen, as year and 0-based month. */
  private year: number;
  private month: number;
  private selectedDay: string | null = null;
  private kindFilter = '';
  private editing: CalendarEntry | null = null;
  private creating = false;

  constructor(options: CalendarViewOptions) {
    this.o = options;
    const now = new Date();
    this.year = now.getFullYear();
    this.month = now.getMonth();
    this.render();
    void this.load();
  }

  // ── data ──────────────────────────────────────────────────────────────

  private rangeOfMonth(): { from: string; to: string } {
    const last = new Date(Date.UTC(this.year, this.month + 1, 0)).getUTCDate();
    return { from: iso(this.year, this.month, 1), to: iso(this.year, this.month, last) };
  }

  private async load(): Promise<void> {
    this.loading = true; this.error = ''; this.render();
    try {
      const { from, to } = this.rangeOfMonth();
      const qs = new URLSearchParams({ from, to });
      if (this.kindFilter) qs.set('kind', this.kindFilter);
      const res = await this.o.auth.authedFetch(`/api/v1/ops/calendar?${qs}`);
      if (res.status === 403) { this.error = permissionMessage('শিক্ষাপঞ্জি'); return; }
      if (!res.ok) throw new Error(String(res.status));
      this.data = (await res.json()) as CalendarPayload;
    } catch {
      this.error = 'শিক্ষাপঞ্জি আনা যায়নি — সংযোগ পেলে আবার দেখা যাবে।';
    } finally {
      this.loading = false; this.render();
    }
  }

  private async save(payload: Record<string, unknown>, editingId: string | null): Promise<void> {
    this.busy = true; this.error = ''; this.render();
    try {
      const res = await this.o.auth.authedFetch('/api/v1/ops/calendar', {
        method: editingId ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(editingId ? { ...payload, id: editingId } : payload),
      });
      const body = await res.json() as { notified?: number; message?: string };
      if (!res.ok) {
        this.error = body.message ?? 'সংরক্ষণ করা যায়নি।';
        return;
      }
      this.notice = (editingId ? 'পরিবর্তন সংরক্ষিত হয়েছে।' : 'শিক্ষাপঞ্জিতে যুক্ত হয়েছে।')
        + (body.notified ? ` ${bnNum(body.notified)} জনকে জানানো হয়েছে।` : '');
      this.editing = null; this.creating = false;
      await this.load();
    } catch {
      this.error = 'সংযোগ নেই — সংরক্ষণ করা যায়নি।';
    } finally {
      this.busy = false; this.render();
    }
  }

  private async remove(entry: CalendarEntry): Promise<void> {
    this.busy = true; this.error = ''; this.render();
    try {
      const res = await this.o.auth.authedFetch(
        `/api/v1/ops/calendar?id=${encodeURIComponent(entry.id)}`, { method: 'DELETE' });
      const body = await res.json() as { message?: string };
      if (!res.ok) {
        this.error = res.status === 403
          ? 'এই এন্ট্রি পরিবর্তনের অনুমতি আপনার নেই।'
          : body.message ?? 'মুছে ফেলা যায়নি।';
        return;
      }
      this.notice = `"${entry.titleBn}" শিক্ষাপঞ্জি থেকে সরানো হয়েছে।`;
      await this.load();
    } catch {
      this.error = 'সংযোগ নেই — মুছে ফেলা যায়নি।';
    } finally {
      this.busy = false; this.render();
    }
  }

  // ── helpers ───────────────────────────────────────────────────────────

  private entriesOn(day: string): CalendarEntry[] {
    return (this.data?.entries ?? []).filter((e) => e.day === day);
  }

  private isWeekend(dow: number): boolean {
    return (this.data?.weekendDays ?? []).includes(dow);
  }

  private isHoliday(day: string): boolean {
    return this.entriesOn(day).some((e) => e.kind === 'holiday');
  }

  /**
   * A weekend the school has declared a working day.  (R-4.1)
   *
   * The same precedence the SMS sender applies in
   * `sms-svc/src/dispatch.ts::nonWorkingReasonFor`: a holiday on the same
   * date wins, because a school that has declared one has made the more
   * specific statement. Keeping the two in step matters — a cell that says
   * "খোলা" while the sender suppresses the SMS is the calendar lying about
   * what the system will do.
   */
  private isWorkingWeekend(day: string, dow: number): boolean {
    if (!this.isWeekend(dow)) return false;
    if (this.isHoliday(day)) return false;
    return this.entriesOn(day).some((e) => e.kind === 'working_weekend');
  }

  /** The three states a cell can be in, for the label and the legend. */
  private dayState(day: string, dow: number): 'holiday' | 'working_weekend' | 'weekend' | 'normal' {
    if (this.isHoliday(day)) return 'holiday';
    if (this.isWorkingWeekend(day, dow)) return 'working_weekend';
    if (this.isWeekend(dow)) return 'weekend';
    return 'normal';
  }

  private todayIso(): string {
    const t = new Date();
    return iso(t.getFullYear(), t.getMonth(), t.getDate());
  }

  private step(by: number): void {
    const d = new Date(Date.UTC(this.year, this.month + by, 1));
    this.year = d.getUTCFullYear();
    this.month = d.getUTCMonth();
    this.selectedDay = null;
    this.editing = null; this.creating = false; this.notice = '';
    void this.load();
  }

  // ── render ────────────────────────────────────────────────────────────

  private render(): void {
    const d = this.o.doc;
    const root = this.o.root;
    root.textContent = '';

    const header = pageHeader(d, {
      title: 'শিক্ষাপঞ্জি',
      subtitle: `${MONTH_BN[this.month]} ${bnNum(this.year)}`,
    });
    root.append(header);

    root.append(this.monthNav());

    if (this.notice) root.append(successNote(d, this.notice));
    if (this.error) {
      root.append(errorState(d, this.error,
        this.error.includes('অনুমতি') ? undefined : () => void this.load()));
      // A refusal is the whole answer; a grid underneath it would say
      // "nothing is scheduled", which is a different and untrue claim.
      if (this.error.includes('অনুমতি')) return;
    }

    if (this.loading) { root.append(skeleton(d, 5)); return; }
    if (!this.data) return;

    root.append(this.filters());
    if (this.o.canManage) root.append(this.createBar());
    if (this.creating || this.editing) root.append(this.form());

    root.append(this.grid());
    root.append(this.legend());
    root.append(this.dayPanel());
    root.append(this.upcoming());
  }

  private monthNav(): HTMLElement {
    const d = this.o.doc;
    const bar = d.createElement('div');
    bar.className = 'page-header-row';
    bar.style.padding = '0 var(--s-4) var(--s-3)';

    const prev = d.createElement('button');
    prev.type = 'button';
    prev.className = 'btn-secondary btn-small';
    prev.setAttribute('aria-label', 'আগের মাস');
    prev.textContent = '← আগের';
    prev.addEventListener('click', () => this.step(-1));

    const today = d.createElement('button');
    today.type = 'button';
    today.className = 'btn-ghost btn-small';
    today.textContent = 'আজ';
    today.addEventListener('click', () => {
      const t = new Date();
      this.year = t.getFullYear(); this.month = t.getMonth();
      this.selectedDay = this.todayIso();
      void this.load();
    });

    const next = d.createElement('button');
    next.type = 'button';
    next.className = 'btn-secondary btn-small';
    next.setAttribute('aria-label', 'পরের মাস');
    next.textContent = 'পরের →';
    next.addEventListener('click', () => this.step(1));

    bar.append(prev, today, next);
    return bar;
  }

  private filters(): HTMLElement {
    const d = this.o.doc;
    const wrap = d.createElement('div');
    // The existing segmented control (.seg-bar/.seg-opt), not a new one.
    wrap.className = 'seg-bar';
    wrap.setAttribute('role', 'group');
    wrap.setAttribute('aria-label', 'ধরন অনুযায়ী ছাঁকুন');

    const mk = (value: string, labelBn: string): void => {
      const b = d.createElement('button');
      b.type = 'button';
      b.className = 'seg-opt';
      // Selection is a filled block plus aria-pressed, never colour alone.
      b.setAttribute('data-active', String(this.kindFilter === value));
      b.setAttribute('aria-pressed', String(this.kindFilter === value));
      b.textContent = labelBn;
      b.addEventListener('click', () => {
        this.kindFilter = this.kindFilter === value ? '' : value;
        this.selectedDay = null;
        void this.load();
      });
      wrap.append(b);
    };
    mk('', 'সব');
    for (const k of ['holiday', 'working_weekend', 'exam']) mk(k, KIND_BN[k]);
    return wrap;
  }

  private createBar(): HTMLElement {
    const d = this.o.doc;
    const bar = d.createElement('div');
    bar.className = 'action-row';
    bar.style.padding = '0 var(--s-4) var(--s-3)';
    const b = d.createElement('button');
    b.type = 'button';
    b.className = 'btn-secondary btn-small';
    b.textContent = 'নতুন এন্ট্রি';
    b.disabled = this.creating || this.editing !== null;
    b.addEventListener('click', () => {
      this.creating = true; this.editing = null; this.notice = ''; this.render();
    });
    bar.append(b);
    return bar;
  }

  /**
   * The month grid. A table, not a div soup: a calendar IS tabular data, and
   * `<th scope="col">` on the weekday row is what lets a screen reader say
   * "বুধবার, ১০" instead of reading a wall of numbers.
   */
  private grid(): HTMLElement {
    const d = this.o.doc;
    const scroll = d.createElement('div');
    scroll.className = 'table-scroll';
    scroll.style.padding = '0 var(--s-4)';

    const table = d.createElement('table');
    table.className = 'data-table cal-grid';
    const caption = d.createElement('caption');
    caption.className = 'visually-hidden';
    caption.textContent = `${MONTH_BN[this.month]} ${bnNum(this.year)} মাসের শিক্ষাপঞ্জি`;
    table.append(caption);

    const thead = d.createElement('thead');
    const hr = d.createElement('tr');
    for (let dow = 0; dow < 7; dow++) {
      const th = d.createElement('th');
      th.scope = 'col';
      th.textContent = WEEKDAY_BN[dow];
      if (this.isWeekend(dow)) th.classList.add('cal-weekend');
      hr.append(th);
    }
    thead.append(hr);
    table.append(thead);

    const tbody = d.createElement('tbody');
    const first = new Date(Date.UTC(this.year, this.month, 1)).getUTCDay();
    const days = new Date(Date.UTC(this.year, this.month + 1, 0)).getUTCDate();
    const today = this.todayIso();

    let cell = 0;
    let tr = d.createElement('tr');
    for (; cell < first; cell++) tr.append(d.createElement('td'));

    for (let day = 1; day <= days; day++, cell++) {
      if (cell % 7 === 0 && cell > 0) { tbody.append(tr); tr = d.createElement('tr'); }
      const dayIso = iso(this.year, this.month, day);
      const dow = (first + day - 1) % 7;
      const entries = this.entriesOn(dayIso);

      const state = this.dayState(dayIso, dow);

      const td = d.createElement('td');
      td.className = 'cal-cell';
      // `data-state` carries the ONE answer — holiday, working weekend,
      // weekend or normal — rather than two classes a reader has to combine.
      // A working weekend is still a weekend column; what changes is that
      // this particular date is open, so it must not look shut.
      td.setAttribute('data-state', state);
      if (this.isWeekend(dow)) td.classList.add('cal-weekend');
      if (state === 'holiday') td.classList.add('cal-holiday');
      if (state === 'working_weekend') td.classList.add('cal-working');
      if (dayIso === today) td.classList.add('cal-today');
      if (dayIso === this.selectedDay) td.classList.add('cal-selected');

      const btn = d.createElement('button');
      btn.type = 'button';
      btn.className = 'cal-day';
      // The accessible name carries what the visual marker carries, so a
      // shaded holiday is not information only a sighted user gets — and a
      // working weekend has to SAY it is open, because the column around it
      // still reads as the weekend.
      const parts = [`${bnNum(day)} ${MONTH_BN[this.month]}`];
      if (state === 'weekend') parts.push('সাপ্তাহিক ছুটি');
      if (state === 'working_weekend') parts.push('সাপ্তাহিক ছুটির দিনে খোলা');
      for (const e of entries) parts.push(`${KIND_BN[e.kind] ?? e.kind}: ${e.titleBn}`);
      btn.setAttribute('aria-label', parts.join(' · '));
      if (dayIso === this.selectedDay) btn.setAttribute('aria-current', 'date');

      const num = d.createElement('span');
      num.className = 'cal-num';
      num.textContent = bnNum(day);
      btn.append(num);

      if (entries.length > 0) {
        const dots = d.createElement('span');
        dots.className = 'cal-dots';
        dots.setAttribute('aria-hidden', 'true');
        // Capped at three: a fourth dot in a 40px cell is noise, and the
        // count is in the accessible name and the day panel either way.
        for (const e of entries.slice(0, 3)) {
          const dot = d.createElement('span');
          dot.className = 'cal-dot';
          dot.setAttribute('data-kind', e.kind);
          dots.append(dot);
        }
        btn.append(dots);
      }

      btn.addEventListener('click', () => {
        this.selectedDay = this.selectedDay === dayIso ? null : dayIso;
        this.render();
      });
      td.append(btn);
      tr.append(td);
    }
    while (cell % 7 !== 0) { tr.append(d.createElement('td')); cell++; }
    tbody.append(tr);
    table.append(tbody);
    scroll.append(table);
    return scroll;
  }

  /**
   * The three day states, named.  (R-4.1)
   *
   * A shaded column and an underline are markers; a person seeing them for
   * the first time has to guess what they mean, and "this Saturday is
   * shaded but that one is not" is precisely the thing a working weekend
   * introduces. So the states are written out under the grid.
   *
   * Rendered only when a state is actually present in the month on screen —
   * a legend explaining a marker nobody can see is furniture.
   */
  private legend(): HTMLElement {
    const d = this.o.doc;
    const wrap = d.createElement('ul');
    wrap.className = 'cal-legend';
    wrap.setAttribute('aria-label', 'দিনের ধরন');

    const present = new Set<string>();
    const first = new Date(Date.UTC(this.year, this.month, 1)).getUTCDay();
    const total = new Date(Date.UTC(this.year, this.month + 1, 0)).getUTCDate();
    for (let day = 1; day <= total; day++) {
      present.add(this.dayState(iso(this.year, this.month, day), (first + day - 1) % 7));
    }

    const items: [string, string][] = [
      ['holiday', 'ছুটি — বন্ধ, হাজিরার এসএমএস যাবে না'],
      ['working_weekend', 'সাপ্তাহিক ছুটির দিনে খোলা — স্বাভাবিক কর্মদিবসের মতো'],
      ['weekend', 'সাপ্তাহিক ছুটি'],
    ];
    for (const [state, labelBn] of items) {
      if (!present.has(state)) continue;
      const li = d.createElement('li');
      li.className = 'cal-legend-item';
      const swatch = d.createElement('span');
      swatch.className = 'cal-legend-swatch';
      swatch.setAttribute('data-state', state);
      swatch.setAttribute('aria-hidden', 'true');
      const text = d.createElement('span');
      text.textContent = labelBn;
      li.append(swatch, text);
      wrap.append(li);
    }
    return wrap;
  }

  /** What is on the selected day, or a prompt to pick one. */
  private dayPanel(): HTMLElement {
    const d = this.o.doc;
    const wrap = d.createElement('section');
    wrap.setAttribute('aria-live', 'polite');

    if (!this.selectedDay) {
      const p = d.createElement('p');
      p.className = 'att-sub';
      p.style.padding = 'var(--s-3) var(--s-4)';
      p.textContent = 'বিস্তারিত দেখতে একটি তারিখে চাপ দিন।';
      wrap.append(p);
      return wrap;
    }

    const h = d.createElement('h2');
    h.className = 'section-heading';
    h.textContent = bnDate(this.selectedDay);
    wrap.append(h);

    const entries = this.entriesOn(this.selectedDay);
    if (entries.length === 0) {
      wrap.append(emptyState(d, {
        message: 'এই দিনে কোনো কিছু নির্ধারিত নেই।',
        action: this.o.canManage
          ? { label: 'এই দিনে এন্ট্রি যোগ করুন', onClick: () => {
              this.creating = true; this.editing = null; this.render();
            } }
          : undefined,
      }));
      return wrap;
    }

    for (const e of entries) wrap.append(this.entryCard(e));
    return wrap;
  }

  private entryCard(e: CalendarEntry): HTMLElement {
    const d = this.o.doc;
    const card = d.createElement('article');
    card.className = 'card';
    card.style.margin = '0 var(--s-4) var(--s-3)';

    const head = d.createElement('div');
    head.className = 'page-header-row';
    const title = d.createElement('p');
    title.className = 'system-title';
    title.textContent = e.titleBn;
    const chip = d.createElement('span');
    chip.className = 'status-chip';
    if (e.kind === 'holiday') chip.setAttribute('data-state', 'warning');
    else if (e.kind === 'working_weekend') chip.setAttribute('data-state', 'success');
    else if (e.kind === 'exam') chip.setAttribute('data-state', 'pending');
    chip.textContent = KIND_BN[e.kind] ?? e.kind;
    head.append(title, chip);
    card.append(head);

    if (e.descriptionBn) {
      const p = d.createElement('p');
      p.className = 'att-sub';
      // textContent, never innerHTML: typed by a person at the school and
      // rendered in every reader's browser.
      p.textContent = e.descriptionBn;
      card.append(p);
    }

    if (e.kind === 'working_weekend') {
      const effect = d.createElement('p');
      effect.className = 'att-sub';
      effect.textContent =
        'এই দিনটি সাপ্তাহিক ছুটি হলেও স্বাভাবিক কর্মদিবস হিসেবে গণ্য হবে — ' +
        'হাজিরা ও নোটিশের এসএমএস যথারীতি যাবে।';
      card.append(effect);
    }

    const meta: string[] = [];
    if (e.appliesToShifts?.length) {
      meta.push(`কেবল ${e.appliesToShifts.map((s) => SHIFT_BN[s] ?? s).join(', ')} শিফট`);
    }
    if (!e.editable) {
      // Say WHERE it comes from, so nobody hunts for an edit button that will
      // never be here.
      meta.push('পরীক্ষার সূচি থেকে — পরিবর্তন করতে পরীক্ষার রুটিনে যান');
    } else if (e.createdByNameBn) {
      meta.push(`যোগ করেছেন ${e.createdByNameBn}`);
    }
    if (meta.length) {
      const m = d.createElement('p');
      m.className = 'att-sub';
      m.textContent = meta.join(' · ');
      card.append(m);
    }

    if (this.o.canManage && e.editable) {
      const row = d.createElement('div');
      row.className = 'action-row';
      const edit = d.createElement('button');
      edit.type = 'button';
      edit.className = 'btn-ghost btn-small';
      edit.textContent = 'সম্পাদনা';
      edit.disabled = this.busy;
      edit.addEventListener('click', () => {
        this.editing = e; this.creating = false; this.notice = ''; this.render();
      });

      const del = d.createElement('button');
      del.type = 'button';
      del.className = 'btn-ghost btn-small';
      del.textContent = 'মুছে ফেলুন';
      del.disabled = this.busy;
      del.addEventListener('click', () => {
        card.append(confirmDialog({
          doc: d,
          title: 'শিক্ষাপঞ্জি থেকে সরানো',
          // Both of these kinds change whether messages go out that day, in
          // opposite directions. Saying only "this will be removed" leaves
          // the office to discover the effect from a parent's complaint.
          body: e.kind === 'holiday'
            ? `"${e.titleBn}" (${bnDate(e.day)}) সরানো হবে। ছুটি সরালে ওই দিনের ` +
              'হাজিরার এসএমএস আবার পাঠানো হবে।'
            : e.kind === 'working_weekend'
              ? `"${e.titleBn}" (${bnDate(e.day)}) সরানো হবে। এরপর দিনটি আবার ` +
                'সাপ্তাহিক ছুটি হিসেবে গণ্য হবে এবং ওই দিনের এসএমএস বন্ধ থাকবে।'
              : `"${e.titleBn}" (${bnDate(e.day)}) শিক্ষাপঞ্জি থেকে সরানো হবে।`,
          confirmLabel: 'সরান',
          danger: true,
          onConfirm: () => void this.remove(e),
        }));
      });
      row.append(edit, del);
      card.append(row);
    }
    return card;
  }

  /** The next things coming, across the whole month on screen. */
  private upcoming(): HTMLElement {
    const d = this.o.doc;
    const wrap = d.createElement('section');
    const h = d.createElement('h2');
    h.className = 'section-heading';
    h.textContent = 'আসন্ন';
    wrap.append(h);

    const today = this.todayIso();
    const next = (this.data?.entries ?? [])
      .filter((e) => e.day >= today)
      .slice(0, 6);

    if (next.length === 0) {
      wrap.append(emptyState(d, {
        message: (this.data?.entries.length ?? 0) > 0
          ? 'এই মাসে আর কিছু বাকি নেই।'
          : this.kindFilter
            ? 'এই ধরনের কিছু এই মাসে নির্ধারিত নেই।'
            : 'এই মাসে কোনো কিছু নির্ধারিত নেই।',
        action: this.o.canManage && !this.kindFilter
          ? { label: 'এন্ট্রি যোগ করুন', onClick: () => {
              this.creating = true; this.editing = null; this.render();
            } }
          : undefined,
      }));
      return wrap;
    }

    const list = d.createElement('div');
    list.className = 'system-list';
    for (const e of next) {
      const row = d.createElement('button');
      row.type = 'button';
      row.className = 'system-row';
      const t = d.createElement('span');
      t.className = 'system-title';
      t.textContent = e.titleBn;
      const desc = d.createElement('span');
      desc.className = 'system-desc';
      desc.textContent = `${bnDate(e.day)} · ${KIND_BN[e.kind] ?? e.kind}`;
      row.append(t, desc);
      row.addEventListener('click', () => { this.selectedDay = e.day; this.render(); });
      list.append(row);
    }
    wrap.append(list);
    return wrap;
  }

  /**
   * The create/edit form.
   *
   * Deliberately has no start/end time: nothing in this product reads one.
   * The SMS suppression asks "is this day a holiday", attendance asks the
   * same, and the grid draws a day cell. A time the office filled in that no
   * part of the system honoured would be worse than its absence, because they
   * would plan around it.
   */
  private form(): HTMLElement {
    const d = this.o.doc;
    const e = this.editing;
    const form = d.createElement('form');
    form.className = 'card card-form';
    form.style.margin = '0 var(--s-4) var(--s-3)';

    const h = d.createElement('p');
    h.className = 'notice-confirm-label';
    h.textContent = e ? 'এন্ট্রি সম্পাদনা' : 'নতুন এন্ট্রি';
    form.append(h);

    const err = d.createElement('p');
    err.className = 'login-error';
    err.setAttribute('role', 'alert');
    err.hidden = true;
    form.append(err);

    const field = (labelBn: string, el: HTMLElement): void => {
      const l = d.createElement('label');
      l.className = 'field';
      l.textContent = labelBn;
      l.append(el);
      form.append(l);
    };

    const kind = d.createElement('select');
    kind.className = 'field-input';
    for (const [k, labelBn] of Object.entries(KIND_BN)) {
      const opt = d.createElement('option');
      opt.value = k; opt.textContent = labelBn;
      opt.selected = e ? e.kind === k : k === 'holiday';
      kind.append(opt);
    }
    field('ধরন', kind);

    const title = d.createElement('input');
    title.type = 'text';
    title.className = 'field-input';
    title.value = e?.titleBn ?? '';
    title.maxLength = 120;
    field('শিরোনাম', title);

    const desc = d.createElement('textarea');
    desc.className = 'field-input';
    desc.rows = 3;
    desc.value = e?.descriptionBn ?? '';
    field('বিবরণ (ঐচ্ছিক)', desc);

    const day = d.createElement('input');
    day.type = 'date';
    day.className = 'field-input';
    day.value = e?.day ?? this.selectedDay ?? this.todayIso();
    field('তারিখ', day);

    // The audience this schema has. Only offered when the school actually
    // runs more than one shift — a single-shift school choosing "which
    // shift" is a question with one answer.
    const shifts = this.data?.shifts ?? [];
    let shiftBoxes: HTMLInputElement[] = [];
    if (shifts.length > 1) {
      const group = d.createElement('fieldset');
      group.style.border = '0';
      group.style.padding = '0';
      const legend = d.createElement('legend');
      legend.className = 'field';
      legend.textContent = 'কোন শিফটে প্রযোজ্য (খালি রাখলে সব শিফটে)';
      group.append(legend);
      shiftBoxes = shifts.map((s) => {
        const l = d.createElement('label');
        l.className = 'sms-toggle';
        const cb = d.createElement('input');
        cb.type = 'checkbox';
        cb.value = s;
        cb.checked = e?.appliesToShifts?.includes(s) ?? false;
        l.append(cb, d.createTextNode(' ' + (SHIFT_BN[s] ?? s)));
        group.append(l);
        return cb;
      });
      form.append(group);
    }

    // Notify through R-2. Never a second pipeline.
    const notifyLabel = d.createElement('label');
    notifyLabel.className = 'sms-toggle';
    const notify = d.createElement('input');
    notify.type = 'checkbox';
    notifyLabel.append(notify, d.createTextNode(' সবাইকে নোটিশ পাঠান'));
    form.append(notifyLabel);

    const smsLabel = d.createElement('label');
    smsLabel.className = 'sms-toggle';
    const sms = d.createElement('input');
    sms.type = 'checkbox';
    sms.disabled = true;
    smsLabel.append(sms, d.createTextNode(' এসএমএসও পাঠান'));
    form.append(smsLabel);

    const smsNote = d.createElement('p');
    smsNote.className = 'att-sub';
    smsNote.textContent =
      'নোটিশ সবার নোটিফিকেশনে যাবে। এসএমএস খরচসাপেক্ষ — শুধু জরুরি ঘোষণায় ব্যবহার করুন।';
    form.append(smsNote);

    notify.addEventListener('change', () => {
      sms.disabled = !notify.checked;
      if (!notify.checked) sms.checked = false;
    });

    const row = d.createElement('div');
    row.className = 'action-row';
    const cancel = d.createElement('button');
    cancel.type = 'button';
    cancel.className = 'btn-secondary';
    cancel.textContent = 'বাতিল';
    cancel.addEventListener('click', () => {
      this.creating = false; this.editing = null; this.render();
    });
    const save = d.createElement('button');
    save.type = 'submit';
    save.className = 'btn-primary';
    save.disabled = this.busy;
    save.textContent = this.busy ? 'সংরক্ষণ হচ্ছে…' : 'সংরক্ষণ করুন';
    row.append(cancel, save);
    form.append(row);

    form.addEventListener('submit', (ev) => {
      ev.preventDefault();
      err.hidden = true;
      if (!title.value.trim()) {
        err.textContent = 'শিরোনাম লিখুন'; err.hidden = false; return;
      }
      if (!day.value) {
        err.textContent = 'তারিখ দিন'; err.hidden = false; return;
      }
      const chosen = shiftBoxes.filter((b) => b.checked).map((b) => b.value);
      const payload: Record<string, unknown> = {
        kind: kind.value,
        titleBn: title.value.trim(),
        descriptionBn: desc.value.trim(),
        day: day.value,
        appliesToShifts: chosen.length ? chosen : null,
        notify: notify.checked,
        sendSms: sms.checked,
      };
      const go = () => void this.save(payload, e?.id ?? null);

      // Notifying is the irreversible half: a notice cannot be recalled once
      // it is in nine hundred people's bells.
      if (notify.checked) {
        form.append(confirmDialog({
          doc: d,
          title: 'নোটিশ পাঠানো নিশ্চিত করুন',
          body: `"${title.value.trim()}" সম্পর্কে প্রতিষ্ঠানের সবাইকে নোটিশ যাবে` +
                (sms.checked ? ', এবং অভিভাবকদের এসএমএসও যাবে' : '') +
                '। নোটিশ পাঠানোর পর ফিরিয়ে নেওয়া যায় না।',
          confirmLabel: 'পাঠান',
          danger: true,
          onConfirm: go,
        }));
      } else {
        go();
      }
    });

    return form;
  }
}
