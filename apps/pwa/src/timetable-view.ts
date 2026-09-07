/**
 * "রুটিন" — the published timetable, for whoever is reading it.  (P9-8)
 *
 * One screen and one grid for all eight audiences, because there is one
 * routine. A principal picking a room, a teacher opening their own week and a
 * guardian looking at their child are asking the same question with a
 * different WHERE clause, and the server answers it in one shape.
 *
 * ── The picker is the server's list, not this file's ─────────────────────
 * `offered` comes back with the scopes this caller may actually ask for,
 * built from the same role list and the same `app.my_section_ids()` /
 * `app.my_ward_ids()` the filters use. A picker assembled here from
 * `auth.role` would be a second opinion about permission, and the first time
 * the two disagreed a person would be offered a view the server refuses.
 *
 * ── Draft is not a state this screen has ─────────────────────────────────
 * The endpoint reads `status = 'active'` and nothing else, so there is no
 * branch here that could show one. "No published routine yet" is a real and
 * common state — a school in its first week — and it says what to do rather
 * than looking broken.
 *
 * ── Density ──────────────────────────────────────────────────────────────
 * A section's cell holds one lesson; the institution's holds sixteen. Rather
 * than two components, every cell holds a LIST and shows the first few with
 * a count for the rest — so the same grid reads sensibly whether it is one
 * student's Tuesday or a whole school's.
 */
import {
  el, pageHeader, card, statusBadge, statRow, statCard,
  permissionState, deniedMessage, deniedContact,
  listSkeleton, emptyState, errorState, field,
} from './ui/index.ts';
import { refuseUnlessOk, isDenied } from './http-status.ts';
import {
  formatCount, formatTime, formatDayMonth,
} from '../../../packages/ui-core/src/format.ts';
import type { Auth } from './auth.ts';

export interface Lesson {
  routineId: string;
  dayOfWeek: number;
  periodNo: number;
  startsAt: string;
  endsAt: string;
  subjectBn: string | null;
  teacherBn: string | null;
  roomBn: string | null;
  sectionLabel: string | null;
  classBn: string | null;
  isParallel: boolean;
}
export interface RoutineHead {
  id: string; version: number; shift: string; shiftBn: string;
  nameBn: string; publishedAt: string | null; yearLabel: string;
}
export interface Period {
  routineId: string; periodNo: number; labelBn: string; startsAt: string; endsAt: string;
}
export interface Offer {
  scope: string;
  labelBn: string;
  options?: Array<{ id: string; labelBn: string }>;
}
export interface TimetablePayload {
  ok?: boolean;
  scope: string;
  published: boolean;
  titleBn: string;
  subtitleBn: string;
  routines: RoutineHead[];
  periods: Period[];
  lessons: Lesson[];
  days: Array<{ dow: number; bn: string }>;
  offered: Offer[];
  counts: { sections: number; teachers: number; rooms: number; classes: number };
}

export interface TimetableViewOptions {
  root: HTMLElement;
  doc: Document;
  auth: Auth;
  /** Where "রুটিন তৈরি করুন" sends a coordinator with nothing published. */
  onNavigate?: (path: string) => void;
  /** Opening scope, for a deep link. */
  scope?: string;
  id?: string;
}

/** How many lessons a single cell prints before it counts the rest. */
const PER_CELL = 3;

const dateBn = (iso: string | null): string => {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const ymd = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
            + `-${String(d.getDate()).padStart(2, '0')}`;
  return `${formatDayMonth(ymd, 'bn')} ${formatCount(d.getFullYear(), 'bn')}`;
};

export class TimetableView {
  private readonly o: TimetableViewOptions;
  private scope: string;
  private id: string;

  private data: TimetablePayload | null = null;
  private loading = true;
  private denied = false;
  private deniedErr: unknown = null;
  private error = '';

  constructor(options: TimetableViewOptions) {
    this.o = options;
    this.scope = options.scope ?? '';
    this.id = options.id ?? '';
    void this.load();
  }

  private async load(): Promise<void> {
    this.loading = true; this.render();
    try {
      const qs = new URLSearchParams();
      // With neither set, the server answers from this reader's own menu.
      // Nothing here guesses a scope: a guess would be a second opinion
      // about permission, and the endpoint already holds the first.
      if (this.scope) qs.set('scope', this.scope);
      if (this.id) qs.set('id', this.id);
      const res = await this.o.auth.authedFetch(
        `/api/v1/rms/timetable${qs.toString() ? `?${qs}` : ''}`);
      await refuseUnlessOk(res);
      const b = await res.json() as TimetablePayload & { id?: string };
      this.data = b;
      this.scope = b.scope;
      if (typeof b.id === 'string') this.id = b.id;
      this.error = '';
    } catch (err) {
      if (isDenied(err)) { this.denied = true; this.deniedErr = err; }
      else {
        this.error = navigator.onLine
          ? 'রুটিন আনা যায়নি — একটু পরে আবার চেষ্টা করুন।'
          : 'সংযোগ নেই — সংযোগ পেলে রুটিন দেখা যাবে।';
      }
    } finally {
      this.loading = false; this.render();
    }
  }

  private pick(scope: string, id: string): void {
    this.scope = scope; this.id = id;
    this.denied = false; this.deniedErr = null;
    void this.load();
  }

  /* ------------------------------------------------------------- render */

  private render(): void {
    const d = this.o.doc;
    const root = this.o.root;
    root.textContent = '';
    root.append(pageHeader(d, {
      title: 'রুটিন',
      subtitle: this.data?.published
        ? `${this.data.titleBn} · ${this.data.subtitleBn}`
        : 'প্রতিষ্ঠানের চালু ক্লাস রুটিন',
    }));

    if (this.denied) {
      root.append(permissionState(d, {
        message: deniedMessage(this.deniedErr),
        contact: deniedContact(this.deniedErr),
      }));
      return;
    }
    if (this.loading) { root.append(listSkeleton(d, 3)); return; }
    if (this.error) {
      root.append(errorState(d, this.error, () => { void this.load(); }));
      return;
    }
    if (this.data && this.data.offered.length > 1) root.append(this.pickerCard());
    if (!this.data?.published) { root.append(this.nothingPublished()); return; }

    root.append(this.summaryCard());
    for (const r of this.data.routines) root.append(this.gridCard(r));
  }

  /** §15 — a real and ordinary state, with the way out. */
  private nothingPublished(): HTMLElement {
    const d = this.o.doc;
    return emptyState(d, {
      glyph: 'clock',
      message: 'এখনো কোনো রুটিন প্রকাশ করা হয়নি। প্রকাশ হলে এখানে দেখা যাবে।',
      ...(this.o.onNavigate
        ? { action: { label: 'রুটিন তৈরি ও প্রকাশ',
                      onClick: () => this.o.onNavigate?.('routinepublish') } }
        : {}),
    });
  }

  /** The scopes this reader may ask for — the server's list, verbatim. */
  private pickerCard(): HTMLElement {
    const d = this.o.doc;
    const data = this.data!;
    const body = el(d, 'div', { className: 'ui-stack' });

    const current = data.offered.find((o) => o.scope === this.scope) ?? data.offered[0];
    body.append(field(d, {
      label: 'কার রুটিন', name: 'scope', kind: 'select', value: current.scope,
      options: data.offered.map((o) => ({ value: o.scope, label: o.labelBn })),
      onChange: (v) => {
        const next = data.offered.find((o) => o.scope === v);
        if (!next) return;
        this.pick(next.scope, next.options?.[0]?.id ?? '');
      },
    }).root);

    // A scope with a list needs a second choice; one without (the whole
    // institution) does not, and drawing an empty picker beside it would be
    // a control that does nothing.
    if (current.options && current.options.length > 0) {
      body.append(field(d, {
        label: 'কোনটি', name: 'subject', kind: 'select',
        value: this.id || current.options[0].id,
        options: current.options.map((x) => ({ value: x.id, label: x.labelBn })),
        onChange: (v) => this.pick(current.scope, v),
      }).root);
    }
    return card(d, { title: 'রুটিন বেছে নিন', glyph: 'search' }, body);
  }

  private summaryCard(): HTMLElement {
    const d = this.o.doc;
    const data = this.data!;
    const body = el(d, 'div', { className: 'ui-stack' });
    // The server's counts, on ids. Counting the rendered labels here made a
    // twenty-section school report four, because every class has a 'ক'.
    const n = data.counts ?? { sections: 0, teachers: 0, rooms: 0, classes: 0 };
    body.append(statRow(d,
      statCard(d, { label: 'মোট ক্লাস', value: `${formatCount(data.lessons.length, 'bn')}টি` }),
      statCard(d, { label: 'শাখা', value: `${formatCount(n.sections, 'bn')}টি` }),
      statCard(d, { label: 'শিক্ষক', value: `${formatCount(n.teachers, 'bn')} জন` }),
      statCard(d, { label: 'কক্ষ', value: `${formatCount(n.rooms, 'bn')}টি` }),
    ));

    const r = data.routines[0];
    if (r) {
      body.append(el(d, 'p', {
        className: 'ui-card-note',
        text: `${r.yearLabel} শিক্ষাবর্ষ · সংস্করণ ${formatCount(r.version, 'bn')}`
            + ` · প্রকাশ: ${dateBn(r.publishedAt)}`,
      }));
    }
    return card(d, {
      title: data.titleBn,
      subtitle: data.subtitleBn,
      action: statusBadge(d, { state: 'active', label: 'প্রকাশিত' }),
    }, body);
  }

  /**
   * One shift's week.
   *
   * A two-shift school gets two grids and not one: morning period 8 and day
   * period 1 are different numbers over the same clock time, so a single
   * table keyed on period number would put two different hours in one row.
   */
  private gridCard(r: RoutineHead): HTMLElement {
    const d = this.o.doc;
    const data = this.data!;
    const periods = data.periods.filter((p) => p.routineId === r.id);
    const lessons = data.lessons.filter((l) => l.routineId === r.id);

    if (periods.length === 0) {
      return card(d, { title: r.shiftBn, glyph: 'clock' },
        emptyState(d, { message: 'এই শিফটের ঘণ্টার সময়সূচি পাওয়া যায়নি।' }));
    }

    const byCell = new Map<string, Lesson[]>();
    for (const l of lessons) {
      const k = `${l.dayOfWeek}|${l.periodNo}`;
      if (!byCell.has(k)) byCell.set(k, []);
      byCell.get(k)!.push(l);
    }

    const scroll = el(d, 'div', { className: 'table-scroll' });
    const table = el(d, 'table', { className: 'data-table routine-grid' });
    const thead = el(d, 'thead');
    const hrow = el(d, 'tr');
    hrow.append(el(d, 'th', { text: 'পিরিয়ড', attrs: { scope: 'col' } }));
    for (const day of data.days) {
      hrow.append(el(d, 'th', { text: `${day.bn}বার`, attrs: { scope: 'col' } }));
    }
    thead.append(hrow);
    table.append(thead);

    const tbody = el(d, 'tbody');
    for (const p of periods) {
      const tr = el(d, 'tr');
      const th = el(d, 'th', { className: 'routine-grid-period', attrs: { scope: 'row' } });
      th.append(el(d, 'span', {
        className: 'routine-grid-no', text: `${formatCount(p.periodNo, 'bn')}` }));
      // Its own class, not `routine-slot-meta`: that one also carries teacher
      // and room NAMES, and `--font-bn-num` on it would move their letters
      // too. This span is a clock time and nothing else.
      th.append(el(d, 'span', {
        className: 'routine-grid-time',
        text: `${formatTime(p.startsAt, 'bn')}–${formatTime(p.endsAt, 'bn')}` }));
      tr.append(th);

      for (const day of data.days) {
        const td = el(d, 'td', { className: 'routine-cell' });
        const here = byCell.get(`${day.dow}|${p.periodNo}`) ?? [];
        if (here.length === 0) {
          td.append(el(d, 'span', { className: 'routine-slot-empty', text: '—' }));
        } else {
          for (const l of here.slice(0, PER_CELL)) td.append(this.cell(l, day.bn, p));
          if (here.length > PER_CELL) {
            td.append(el(d, 'span', {
              className: 'routine-slot-meta',
              text: `আরও ${formatCount(here.length - PER_CELL, 'bn')}টি`,
            }));
          }
        }
        tr.append(td);
      }
      tbody.append(tr);
    }
    table.append(tbody);
    scroll.append(table);

    const body = el(d, 'div', { className: 'ui-stack' });
    body.append(scroll);
    return card(d, {
      title: `${r.shiftBn} শিফট`,
      subtitle: `${formatCount(lessons.length, 'bn')}টি ক্লাস`,
      glyph: 'clock',
    }, body);
  }

  /**
   * One lesson.
   *
   * A `div`, not a `button`: nothing here is clickable, and a control that
   * does nothing when pressed is worse than a plain cell. The accessible name
   * carries the day and hour because a screen reader moving through a table
   * cell by cell has no other way to know which one it is in.
   */
  private cell(l: Lesson, dayBn: string, p: Period): HTMLElement {
    const d = this.o.doc;
    const wrap = el(d, 'div', { className: 'routine-slot' });
    wrap.setAttribute('data-filled', 'true');

    const what = [l.subjectBn ?? 'ক্লাস'];
    // The section only when the reader is looking at more than one — on a
    // section's own grid every cell would repeat it.
    if (this.scope !== 'section' && this.scope !== 'student' && l.sectionLabel) {
      what.push(`${l.classBn ?? ''}-${l.sectionLabel}`.replace(/^-/, ''));
    }
    wrap.append(el(d, 'span', { className: 'routine-slot-subject', text: what.join(' · ') }));

    // The teacher, unless this IS the teacher's own grid.
    if (this.scope !== 'teacher' && l.teacherBn) {
      wrap.append(el(d, 'span', { className: 'routine-slot-meta', text: l.teacherBn }));
    }
    if (this.scope !== 'room' && l.roomBn) {
      wrap.append(el(d, 'span', { className: 'routine-slot-meta', text: l.roomBn }));
    }
    if (l.isParallel) {
      wrap.append(el(d, 'span', { className: 'routine-slot-meta', text: 'বিভাজিত ক্লাস' }));
    }

    wrap.setAttribute('aria-label', [
      `${dayBn}বার`,
      `${formatCount(p.periodNo, 'bn')} নম্বর পিরিয়ড`,
      `${formatTime(l.startsAt, 'bn')} থেকে ${formatTime(l.endsAt, 'bn')}`,
      ...what,
      l.teacherBn ?? '',
      l.roomBn ?? '',
    ].filter(Boolean).join(', '));
    return wrap;
  }
}
