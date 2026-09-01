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
import { permissionMessage, serverMessage,
  sectionHeading, card, button, buttonRow, statusBadge, field, setFieldError,
  clearFieldError, el, append,
} from './ui/index.ts';

/** The shared badge vocabulary, so a holiday tints like every other warning. */
const KIND_BADGE: Record<string, string> = {
  holiday: 'partial',
  working_weekend: 'published',
  exam: 'pending',
};

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
        this.error = serverMessage(body, res.status, 'সংরক্ষণ করা যায়নি।', 'শিক্ষাপঞ্জি');
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
          : serverMessage(body, res.status, 'মুছে ফেলা যায়নি।', 'শিক্ষাপঞ্জি');
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
    return buttonRow(d,
      button(d, {
        label: 'আগের', variant: 'secondary', size: 'sm', glyph: 'arrow-left',
        // Named by MONTH, not "previous": three identical "আগের" buttons on
        // one screen are three identical announcements.
        ariaLabel: `আগের মাস — ${MONTH_BN[(this.month + 11) % 12]}`,
        onClick: () => this.step(-1),
      }),
      button(d, {
        label: 'আজ', variant: 'ghost', size: 'sm',
        onClick: () => {
          const t = new Date();
          this.year = t.getFullYear(); this.month = t.getMonth();
          this.selectedDay = this.todayIso();
          void this.load();
        },
      }),
      button(d, {
        label: 'পরের', variant: 'secondary', size: 'sm', glyph: 'arrow-right',
        ariaLabel: `পরের মাস — ${MONTH_BN[(this.month + 1) % 12]}`,
        onClick: () => this.step(1),
      }),
    );
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
    return buttonRow(d, button(d, {
      label: 'নতুন এন্ট্রি', variant: 'secondary', size: 'sm', glyph: 'calendar',
      disabled: this.creating || this.editing !== null,
      onClick: () => {
        this.creating = true; this.editing = null; this.notice = ''; this.render();
      },
    }));
  }

  /**
   * The month grid. A table, not a div soup: a calendar IS tabular data, and
   * `<th scope="col">` on the weekday row is what lets a screen reader say
   * "বুধবার, ১০" instead of reading a wall of numbers.
   */
  private grid(): HTMLElement {
    const d = this.o.doc;
    const scroll = d.createElement('div');
    // Its own class as well as the shared one: the month grid is seven fixed
    // columns and needs the gutters back on a narrow phone, and that must not
    // change every other `.table-scroll` in the app. See `.cal-scroll` in
    // app.css for the measurement.
    scroll.className = 'table-scroll cal-scroll';

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
    const notes: string[] = [];
    if (e.kind === 'working_weekend') {
      notes.push('এই দিনটি সাপ্তাহিক ছুটি হলেও স্বাভাবিক কর্মদিবস হিসেবে গণ্য হবে — ' +
                 'হাজিরা ও নোটিশের এসএমএস যথারীতি যাবে।');
    }
    const meta: string[] = [];
    if (e.appliesToShifts?.length) {
      meta.push(`কেবল ${e.appliesToShifts.map((sh) => SHIFT_BN[sh] ?? sh).join(', ')} শিফট`);
    }
    if (!e.editable) {
      // Say WHERE it comes from, so nobody hunts for an edit button that will
      // never be here.
      meta.push('পরীক্ষার সূচি থেকে — পরিবর্তন করতে পরীক্ষার রুটিনে যান');
    } else if (e.createdByNameBn) {
      meta.push(`যোগ করেছেন ${e.createdByNameBn}`);
    }

    const host = card(d, {
      title: e.titleBn,
      glyph: e.kind === 'exam' ? 'award' : 'calendar',
      tone: e.kind === 'holiday' ? 'warn' : e.kind === 'working_weekend' ? 'success' : 'info',
      headingLevel: 3,
      action: statusBadge(d, { state: KIND_BADGE[e.kind] ?? 'draft', label: KIND_BN[e.kind] ?? e.kind }),
    },
      // textContent via `text`, never innerHTML: typed by a person at the
      // school and rendered in every reader's browser.
      e.descriptionBn ? el(d, 'p', { className: 'ui-card-note', text: e.descriptionBn }) : null,
      ...notes.map((n) => el(d, 'p', { className: 'ui-card-note', text: n })),
      meta.length ? el(d, 'p', { className: 'ui-card-note', text: meta.join(' · ') }) : null,
    );

    if (this.o.canManage && e.editable) {
      append(host, buttonRow(d,
        button(d, {
          label: 'সম্পাদনা', variant: 'ghost', size: 'sm', glyph: 'edit',
          ariaLabel: `${e.titleBn} সম্পাদনা করুন`,
          disabled: this.busy,
          onClick: () => {
            this.editing = e; this.creating = false; this.notice = ''; this.render();
          },
        }),
        button(d, {
          label: 'মুছে ফেলুন', variant: 'ghost', size: 'sm',
          ariaLabel: `${e.titleBn} শিক্ষাপঞ্জি থেকে সরান`,
          disabled: this.busy,
          onClick: () => {
            host.append(confirmDialog({
              doc: d,
              title: 'শিক্ষাপঞ্জি থেকে সরানো',
              // Both of these kinds change whether messages go out that day,
              // in opposite directions. Saying only "this will be removed"
              // leaves the office to discover the effect from a parent's
              // complaint.
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
          },
        }),
      ));
    }
    return host;
  }

  /** The next things coming, across the whole month on screen. */
  private upcoming(): HTMLElement {
    const d = this.o.doc;
    const wrap = d.createElement('section');
    wrap.append(sectionHeading(d, { title: 'আসন্ন' }));

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
    const form = el(d, 'form', { className: 'ui-card ui-card-form' });

    append(form, el(d, 'h3', {
      className: 'ui-card-title', text: e ? 'এন্ট্রি সম্পাদনা' : 'নতুন এন্ট্রি',
    }));

    const kind = field(d, {
      label: 'ধরন', name: 'kind', kind: 'select', required: true,
      value: e?.kind ?? 'holiday',
      options: Object.entries(KIND_BN).map(([k, labelBn]) => ({ value: k, label: labelBn })),
    });
    const title = field(d, {
      label: 'শিরোনাম', name: 'titleBn', required: true,
      value: e?.titleBn ?? '', attrs: { maxlength: 120 },
      helper: 'ক্যালেন্ডারের ঘরে এই লেখাটিই দেখা যাবে।',
    });
    const desc = field(d, {
      label: 'বিবরণ', name: 'descriptionBn', kind: 'textarea',
      value: e?.descriptionBn ?? '', attrs: { rows: 3 },
      helper: 'ঐচ্ছিক।',
    });
    const day = field(d, {
      label: 'তারিখ', name: 'day', kind: 'date', required: true,
      value: e?.day ?? this.selectedDay ?? this.todayIso(),
    });
    append(form, kind.root, title.root, desc.root, day.root);

    // The audience this schema has. Only offered when the school actually
    // runs more than one shift — a single-shift school choosing "which
    // shift" is a question with one answer.
    const shifts = this.data?.shifts ?? [];
    let shiftBoxes: HTMLInputElement[] = [];
    if (shifts.length > 1) {
      const group = el(d, 'fieldset', { className: 'ui-fieldset' });
      append(group, el(d, 'legend', {
        className: 'ui-field-label', text: 'কোন শিফটে প্রযোজ্য (খালি রাখলে সব শিফটে)',
      }));
      shiftBoxes = shifts.map((sh) => {
        const cb = el(d, 'input', { className: 'ui-check-box' }) as HTMLInputElement;
        cb.type = 'checkbox';
        cb.value = sh;
        cb.checked = e?.appliesToShifts?.includes(sh) ?? false;
        append(group, el(d, 'label', { className: 'sms-toggle' },
          el(d, 'span', { className: 'ui-check' }, cb),
          el(d, 'span', { text: SHIFT_BN[sh] ?? sh })));
        return cb;
      });
      append(form, group);
    }

    // Notify through R-2. Never a second pipeline.
    const notify = el(d, 'input', { className: 'ui-check-box' }) as HTMLInputElement;
    notify.type = 'checkbox';
    const sms = el(d, 'input', { className: 'ui-check-box' }) as HTMLInputElement;
    sms.type = 'checkbox';
    sms.disabled = true;
    append(form,
      el(d, 'label', { className: 'sms-toggle' },
        el(d, 'span', { className: 'ui-check' }, notify),
        el(d, 'span', { text: 'সবাইকে নোটিশ পাঠান' })),
      el(d, 'label', { className: 'sms-toggle' },
        el(d, 'span', { className: 'ui-check' }, sms),
        el(d, 'span', { text: 'এসএমএসও পাঠান' })),
      el(d, 'p', {
        className: 'ui-card-note',
        text: 'নোটিশ সবার নোটিফিকেশনে যাবে। এসএমএস খরচসাপেক্ষ — ' +
              'শুধু জরুরি ঘোষণায় ব্যবহার করুন।',
      }));

    notify.addEventListener('change', () => {
      sms.disabled = !notify.checked;
      if (!notify.checked) sms.checked = false;
    });

    append(form, buttonRow(d,
      button(d, {
        label: 'বাতিল', variant: 'secondary',
        onClick: () => { this.creating = false; this.editing = null; this.render(); },
      }),
      button(d, {
        label: 'সংরক্ষণ করুন', variant: 'primary', type: 'submit', busy: this.busy,
      }),
    ));

    form.addEventListener('submit', (ev) => {
      ev.preventDefault();
      // Each message in its OWN field. The single error line at the top of
      // this form once said "শিরোনাম লিখুন" while the cursor sat in the date.
      clearFieldError(title.root);
      clearFieldError(day.root);
      if (!title.value().trim()) {
        setFieldError(title.root, 'শিরোনাম লিখুন।');
        title.input.focus();
        return;
      }
      if (!day.value()) {
        setFieldError(day.root, 'তারিখ দিন।');
        day.input.focus();
        return;
      }
      const chosen = shiftBoxes.filter((b) => b.checked).map((b) => b.value);
      const payload: Record<string, unknown> = {
        kind: kind.value(),
        titleBn: title.value().trim(),
        descriptionBn: desc.value().trim(),
        day: day.value(),
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
          body: `"${title.value().trim()}" সম্পর্কে প্রতিষ্ঠানের সবাইকে নোটিশ যাবে` +
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
