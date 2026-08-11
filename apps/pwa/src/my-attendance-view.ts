/**
 * My attendance — F-806
 *
 * "Own attendance record by month and subject, with a visible distinction
 * between excused and unexcused."
 *
 * That distinction is the screen. A child with eight excused absences for a
 * documented illness and a child with eight unexcused ones are in
 * completely different situations, and a single percentage tells a guardian
 * nothing about which. So excused is never folded into the headline figure
 * and never rendered in the same colour as an unexcused absence — it gets
 * its own count, its own chip, and its own row in the register.
 *
 * The wireframe has no screen for this one, so it is composed from the
 * documented component vocabulary (§3) rather than invented: status-chip
 * for the states, data-table for the per-subject grid, progress-bar with a
 * numeric label for the monthly bars, and the six universal states of §4.
 */
import type { Auth } from './auth.ts';
import { formatCount, formatIdentifier } from '../../../packages/ui-core/src/format.ts';

const bn = (n: number): string => formatCount(n, 'bn');

interface MonthRow {
  month: string; present: number; late: number; absent: number;
  excused: number; halfDay: number;
}
interface SubjectRow {
  subjectBn: string | null; present: number; late: number;
  absent: number; excused: number;
}
interface RecentRow {
  takenOn: string; status: string; minutesLate: number | null;
  remark: string | null; subjectBn: string | null;
}
interface Payload {
  totals: {
    present: number; late: number; absent: number; excused: number;
    halfDay: number; counted: number; attendedPercent: number | null;
  };
  byMonth: MonthRow[];
  bySubject: SubjectRow[];
  recent: RecentRow[];
}

const CACHE_KEY = 'shikhon_my_attendance';

/** Every state carries a glyph AND a Bangla label — never colour alone (F-812). */
const STATUS: Record<string, { bn: string; glyph: string; chip: string }> = {
  present:  { bn: 'উপস্থিত',        glyph: '✓', chip: 'success' },
  late:     { bn: 'দেরিতে',          glyph: '◔', chip: 'warning' },
  absent:   { bn: 'অনুপস্থিত',       glyph: '✗', chip: 'danger'  },
  excused:  { bn: 'ছুটি অনুমোদিত',   glyph: '⌂', chip: 'pending' },
  half_day: { bn: 'অর্ধদিবস',        glyph: '◑', chip: 'warning' },
};

const MONTH_BN = ['জানুয়ারি','ফেব্রুয়ারি','মার্চ','এপ্রিল','মে','জুন',
                  'জুলাই','আগস্ট','সেপ্টেম্বর','অক্টোবর','নভেম্বর','ডিসেম্বর'];
function monthLabel(ym: string): string {
  const [y, m] = ym.split('-');
  return `${MONTH_BN[Number(m) - 1] ?? ym} ${formatCount(Number(y), 'bn')}`;
}

export interface MyAttendanceViewOptions {
  root: HTMLElement;
  doc: Document;
  auth: Auth;
}

export class MyAttendanceView {
  private readonly o: MyAttendanceViewOptions;
  private data: Payload | null = null;
  private loading = true;
  private offline = false;
  private error = false;

  constructor(options: MyAttendanceViewOptions) {
    this.o = options;
    this.data = this.readCache();
    this.loading = this.data === null;
    this.render();
    void this.load();
  }

  private readCache(): Payload | null {
    try {
      const raw = localStorage.getItem(CACHE_KEY);
      return raw ? (JSON.parse(raw) as Payload) : null;
    } catch { return null; }
  }

  private async load(): Promise<void> {
    try {
      const res = await this.o.auth.authedFetch('/api/v1/academics/attendance');
      if (!res.ok) throw new Error(String(res.status));
      this.data = (await res.json()) as Payload;
      this.offline = false; this.error = false;
      try { localStorage.setItem(CACHE_KEY, JSON.stringify(this.data)); } catch { /* quota */ }
    } catch {
      if (this.data) this.offline = true; else this.error = true;
    } finally {
      this.loading = false;
      this.render();
    }
  }

  private render(): void {
    const d = this.o.doc;
    const root = this.o.root;
    root.textContent = '';
    root.setAttribute('lang', 'bn');

    const header = d.createElement('header');
    header.className = 'page-header';
    const h1 = d.createElement('h1');
    h1.textContent = 'আমার হাজিরা';
    const sub = d.createElement('p');
    sub.className = 'page-sub';
    sub.textContent = 'মাস ও বিষয় অনুযায়ী নিজের উপস্থিতির হিসাব';
    header.append(h1, sub);
    root.append(header);

    if (this.offline) {
      const b = d.createElement('p');
      b.className = 'inline-notice';
      b.textContent = 'অফলাইন — সংরক্ষিত হিসাব দেখানো হচ্ছে';
      root.append(b);
    }

    if (this.loading && !this.data) { this.skeleton(root); return; }
    if (this.error && !this.data)   { this.errorState(root); return; }
    if (!this.data || this.data.totals.counted === 0) { this.empty(root); return; }

    root.append(this.summary(this.data));
    if (this.data.byMonth.length) root.append(this.months(this.data.byMonth));
    if (this.data.bySubject.length) root.append(this.subjects(this.data.bySubject));
    if (this.data.recent.length) root.append(this.register(this.data.recent));
  }

  private summary(p: Payload): HTMLElement {
    const d = this.o.doc;
    const card = d.createElement('section');
    card.className = 'card att-summary';

    const pct = d.createElement('div');
    pct.className = 'att-headline';
    const v = d.createElement('span');
    v.className = 'result-stat-value';
    // A rate a guardian may quote to the school — Latin, like the mark sheet.
    v.textContent = p.totals.attendedPercent === null
      ? '—' : `${formatIdentifier(p.totals.attendedPercent)}%`;
    const l = d.createElement('span');
    l.className = 'result-stat-label';
    l.textContent = `${bn(p.totals.counted)} কর্মদিবসে উপস্থিতি`;
    pct.append(v, l);
    card.append(pct);

    // Counts, not a single number. Excused sits beside the others rather
    // than inside them, which is the whole requirement.
    const chips = d.createElement('div');
    chips.className = 'att-chips';
    const counts: [string, number][] = [
      ['present', p.totals.present], ['late', p.totals.late],
      ['absent', p.totals.absent], ['excused', p.totals.excused],
    ];
    for (const [key, n] of counts) {
      if (n === 0 && key !== 'absent') continue;
      const meta = STATUS[key];
      const chip = d.createElement('span');
      chip.className = 'status-chip';
      chip.dataset.state = meta.chip;
      chip.textContent = `${meta.glyph} ${meta.bn} ${bn(n)}`;
      chips.append(chip);
    }
    card.append(chips);

    if (p.totals.excused > 0) {
      // Said in words, because "excused does not count against you" is the
      // question a guardian actually opened this screen to answer.
      const note = d.createElement('p');
      note.className = 'att-note';
      note.textContent = 'অনুমোদিত ছুটি উপস্থিতির হারে গণনা করা হয়নি।';
      card.append(note);
    }
    return card;
  }

  private months(rows: MonthRow[]): HTMLElement {
    const d = this.o.doc;
    const sec = d.createElement('section');
    sec.className = 'att-section';
    const h = d.createElement('h2');
    h.textContent = 'মাস অনুযায়ী';
    sec.append(h);

    const ul = d.createElement('ul');
    ul.className = 'att-month-list';
    for (const m of rows) {
      const counted = m.present + m.late + m.absent + m.halfDay;
      const attended = m.present + m.late + m.halfDay * 0.5;
      const pct = counted > 0 ? Math.round((attended / counted) * 100) : 0;

      const li = d.createElement('li');
      li.className = 'att-month';
      const label = d.createElement('span');
      label.className = 'att-month-name';
      label.textContent = monthLabel(m.month);

      const track = d.createElement('div');
      track.className = 'progress-track';
      track.setAttribute('role', 'progressbar');
      track.setAttribute('aria-valuemin', '0');
      track.setAttribute('aria-valuemax', '100');
      track.setAttribute('aria-valuenow', String(pct));
      track.setAttribute('aria-label',
        `${monthLabel(m.month)}: ${counted} দিনের মধ্যে ${m.present + m.late} দিন উপস্থিত`);
      const fill = d.createElement('div');
      fill.className = 'progress-fill';
      fill.style.width = `${pct}%`;
      // Below 75% is where a school starts intervening, so the bar changes
      // tone — and the count beside it says the same thing in numbers.
      if (pct < 75) fill.dataset.low = 'true';
      track.append(fill);

      const count = d.createElement('span');
      count.className = 'att-month-count';
      count.textContent = m.absent > 0
        ? `${bn(m.absent)} দিন অনুপস্থিত`
        : 'পূর্ণ উপস্থিতি';
      li.append(label, track, count);
      ul.append(li);
    }
    sec.append(ul);
    return sec;
  }

  private subjects(rows: SubjectRow[]): HTMLElement {
    const d = this.o.doc;
    const sec = d.createElement('section');
    sec.className = 'att-section';
    const h = d.createElement('h2');
    h.textContent = 'বিষয় অনুযায়ী';
    sec.append(h);

    const wrap = d.createElement('div');
    wrap.className = 'table-scroll';
    const t = d.createElement('table');
    t.className = 'data-table';
    const thead = d.createElement('thead');
    const hr = d.createElement('tr');
    for (const c of ['বিষয়', 'উপস্থিত', 'দেরিতে', 'অনুপস্থিত', 'ছুটি']) {
      const th = d.createElement('th'); th.scope = 'col'; th.textContent = c; hr.append(th);
    }
    thead.append(hr); t.append(thead);

    const tbody = d.createElement('tbody');
    for (const s of rows) {
      const tr = d.createElement('tr');
      const th = d.createElement('th');
      th.scope = 'row';
      th.textContent = s.subjectBn ?? '—';
      tr.append(th);
      for (const n of [s.present, s.late, s.absent, s.excused]) {
        const td = d.createElement('td');
        td.textContent = bn(n);
        tr.append(td);
      }
      tbody.append(tr);
    }
    t.append(tbody); wrap.append(t); sec.append(wrap);
    return sec;
  }

  /** The dates themselves. A guardian wants "which days", not a percentage. */
  private register(rows: RecentRow[]): HTMLElement {
    const d = this.o.doc;
    const sec = d.createElement('section');
    sec.className = 'att-section';
    const h = d.createElement('h2');
    h.textContent = 'অনুপস্থিতির তালিকা';
    sec.append(h);

    const ul = d.createElement('ul');
    ul.className = 'att-register';
    for (const r of rows) {
      const meta = STATUS[r.status] ?? { bn: r.status, glyph: '•', chip: 'pending' };
      const li = d.createElement('li');
      li.className = 'att-entry';

      const date = d.createElement('span');
      date.className = 'att-entry-date';
      const dt = new Date(r.takenOn);
      date.textContent = dt.toLocaleDateString('bn-BD', {
        day: 'numeric', month: 'short', weekday: 'short',
      });

      const body = d.createElement('span');
      body.className = 'att-entry-body';
      const chip = d.createElement('span');
      chip.className = 'status-chip';
      chip.dataset.state = meta.chip;
      chip.textContent = `${meta.glyph} ${meta.bn}`;
      body.append(chip);

      if (r.status === 'late' && r.minutesLate) {
        const m = d.createElement('span');
        m.className = 'att-entry-note';
        m.textContent = `${bn(r.minutesLate)} মিনিট`;
        body.append(m);
      }
      if (r.subjectBn) {
        const s = d.createElement('span');
        s.className = 'att-entry-note';
        s.textContent = r.subjectBn;
        body.append(s);
      }
      if (r.remark) {
        const rem = d.createElement('span');
        rem.className = 'att-entry-note';
        rem.textContent = r.remark;
        body.append(rem);
      }
      li.append(date, body);
      ul.append(li);
    }
    sec.append(ul);
    return sec;
  }

  private skeleton(root: HTMLElement): void {
    const d = this.o.doc;
    const card = d.createElement('div');
    card.className = 'card att-summary is-skeleton';
    card.setAttribute('aria-busy', 'true');
    for (const c of ['skel skel-title', 'skel skel-line', 'skel skel-bar']) {
      const x = d.createElement('div'); x.className = c; card.append(x);
    }
    root.append(card);
  }

  private empty(root: HTMLElement): void {
    const d = this.o.doc;
    const box = d.createElement('div');
    box.className = 'empty-state';
    const g = d.createElement('div');
    g.className = 'empty-glyph'; g.textContent = '⃝'; g.setAttribute('aria-hidden', 'true');
    const p = d.createElement('p');
    p.textContent = 'এখনো কোনো হাজিরা নেওয়া হয়নি।';
    box.append(g, p);
    root.append(box);
  }

  private errorState(root: HTMLElement): void {
    const d = this.o.doc;
    const box = d.createElement('div');
    box.className = 'empty-state';
    const g = d.createElement('div');
    // U+2715, not the warning-sign emoji that used to be here: no emoji form,
    // so it inherits the ink and survives an emoji sweep.
    g.className = 'empty-glyph'; g.textContent = '✕'; g.setAttribute('aria-hidden', 'true');
    const p = d.createElement('p');
    p.textContent = 'হাজিরার হিসাব লোড হয়নি।';
    const retry = d.createElement('button');
    retry.type = 'button';
    retry.className = 'btn-secondary';
    retry.textContent = 'আবার চেষ্টা করুন';
    retry.addEventListener('click', () => {
      this.loading = true; this.error = false; this.render(); void this.load();
    });
    box.append(g, p, retry);
    root.append(box);
  }
}
