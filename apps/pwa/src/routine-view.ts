/**
 * Teacher's routine: a day view (default, today) and a week grid, both
 * backed by GET /api/v1/rms/routine (services/rms-svc/api/routine.ts),
 * which itself wraps db's app.teacher_day() — substitutions the teacher is
 * covering are already merged in, marked isSubstitution.
 *
 * Same offline-cache-in-localStorage approach as roster-view.ts: read-mostly
 * reference data, not durable writes, so a synchronous cache is enough.
 */
import type { Auth } from './auth.ts';
import { bnNum } from './view-states.ts';
import { formatDayMonth, formatTime } from '../../../packages/ui-core/src/format.ts';
import {
  el, append, icon, pageHeader, sectionHeading, tabs, listSkeleton,
  emptyState, statusBadge, badge, announce,
} from './ui/index.ts';

export interface RoutineSlot {
  slotId: string;
  periodNo: number;
  startsAt: string;
  endsAt: string;
  slotKind: string;
  subjectBn: string | null;
  sectionLabel: string | null;
  roomCode: string | null;
  isSubstitution: boolean;
  coveringForBn: string | null;
  studentCount: number | null;
  attendanceTaken: boolean;
  deliveryLogged: boolean;
}

interface DayResponse { scope: 'day'; date: string; slots: RoutineSlot[] }
interface WeekResponse { scope: 'week'; weekStart: string; days: { date: string; slots: RoutineSlot[] }[] }

const DAY_CACHE_PREFIX = 'shikhon_routine_day_';
const WEEK_CACHE_PREFIX = 'shikhon_routine_week_';

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

export interface RoutineViewOptions {
  root: HTMLElement;
  doc: Document;
  auth: Auth;
}

type Mode = 'day' | 'week';

export class RoutineView {
  private readonly o: RoutineViewOptions;
  private mode: Mode = 'day';
  private date = todayIso();
  private day: DayResponse | null = null;
  private week: WeekResponse | null = null;
  private offline = false;
  private loading = false;

  constructor(options: RoutineViewOptions) {
    this.o = options;
    void this.load();
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

  private async load(): Promise<void> {
    this.loading = true;
    this.render();

    if (this.mode === 'day') {
      const cacheKey = DAY_CACHE_PREFIX + this.date;
      const cached = this.cacheGet<DayResponse>(cacheKey);
      if (cached) this.day = cached;
      try {
        const res = await this.o.auth.authedFetch(`/api/v1/rms/routine?scope=day&date=${this.date}`);
        if (!res.ok) throw new Error(String(res.status));
        this.day = (await res.json()) as DayResponse;
        this.offline = false;
        this.cacheSet(cacheKey, this.day);
      } catch {
        this.offline = this.day !== null;
      }
    } else {
      const cacheKey = WEEK_CACHE_PREFIX + this.date;
      const cached = this.cacheGet<WeekResponse>(cacheKey);
      if (cached) this.week = cached;
      try {
        const res = await this.o.auth.authedFetch(`/api/v1/rms/routine?scope=week&weekStart=${this.date}`);
        if (!res.ok) throw new Error(String(res.status));
        this.week = (await res.json()) as WeekResponse;
        this.offline = false;
        this.cacheSet(cacheKey, this.week);
      } catch {
        this.offline = this.week !== null;
      }
    }

    this.loading = false;
    this.render();
  }

  private render(): void {
    const d = this.o.doc;
    const root = this.o.root;
    root.textContent = '';

    append(root, pageHeader(d, {
      title: 'রুটিন',
      subtitle: this.mode === 'day'
        ? 'আজকের ক্লাস ও সময়সূচি — বদলি ক্লাস চিহ্নিত করা আছে।'
        : 'এই সপ্তাহের সব ক্লাস, দিন অনুযায়ী।',
    }));

    // A real tab strip: roving tabindex and arrow keys, instead of two
    // buttons wearing an `.active` class.
    append(root, tabs(d, {
      label: 'রুটিনের সময়সীমা',
      active: this.mode,
      items: [{ id: 'day', label: 'আজ' }, { id: 'week', label: 'সপ্তাহ' }],
      onSelect: (id) => {
        if (this.mode === id) return;
        this.mode = id as Mode;
        announce(d, id === 'day' ? 'আজকের রুটিন' : 'সাপ্তাহিক রুটিন');
        void this.load();
      },
    }));

    // Offline is a statement about the data, not a failure: a cached routine
    // is exactly as useful as a fresh one for knowing where to stand at 10am.
    if (this.offline) {
      append(root, el(d, 'p', { className: 'att-offline-note' },
        el(d, 'span', {
          text: 'অফলাইন — সর্বশেষ সংরক্ষিত রুটিন দেখানো হচ্ছে। সংযোগ পেলে নিজেই হালনাগাদ হবে।',
        })));
    }

    if (this.loading && !this.day && !this.week) {
      append(root, listSkeleton(d, 5));
      return;
    }

    if (this.mode === 'day') {
      this.renderDay(root, this.day?.slots ?? []);
    } else {
      const days = this.week?.days ?? [];
      if (!days.length) {
        append(root, emptyState(d, {
          message: 'এই সপ্তাহের কোনো রুটিন এখনো তৈরি হয়নি।',
        }));
        return;
      }
      // The grid for a desk, the stack for a phone. See the module header.
      append(root, this.weekGrid(days));
      const stack = el(d, 'div', { className: 'routine-week-stack' });
      for (const day of days) {
        append(stack, sectionHeading(d, { title: formatDayMonth(day.date, 'bn') }));
        this.renderDay(stack, day.slots);
      }
      append(root, stack);
    }
  }

  /**
   * The week as a school draws it: periods down the side, days across the top.
   *
   * A real `<table>` with `<th scope>` on BOTH axes, which is what lets a
   * screen reader say "বুধবার, ৩য় পিরিয়ড, গণিত" instead of reading forty
   * cells in a row. Same reasoning as the calendar's month grid.
   *
   * The period rows come from the union of every day's `periodNo`, because a
   * Thursday can be short and a grid built from one day's periods would drop
   * the rest of the week's last class.
   */
  private weekGrid(days: Array<{ date: string; slots: RoutineSlot[] }>): HTMLElement {
    const d = this.o.doc;
    const periods = [...new Set(days.flatMap((day) => day.slots.map((sl) => sl.periodNo)))]
      .sort((a, b) => a - b);

    // The time a period starts is the same all week, so it labels the row.
    const startOf = new Map<number, string>();
    for (const day of days) {
      for (const sl of day.slots) {
        if (!startOf.has(sl.periodNo)) startOf.set(sl.periodNo, sl.startsAt.slice(0, 5));
      }
    }

    const scroll = el(d, 'div', { className: 'table-scroll routine-week-scroll' });
    const table = el(d, 'table', { className: 'data-table routine-grid' });
    append(table, el(d, 'caption', {
      className: 'ui-sr-only', text: 'এই সপ্তাহের রুটিন — সারি পিরিয়ড, কলাম দিন',
    }));

    const thead = el(d, 'thead');
    const hrow = el(d, 'tr');
    append(hrow, el(d, 'th', { text: 'পিরিয়ড', attrs: { scope: 'col' } }));
    for (const day of days) {
      append(hrow, el(d, 'th', {
        text: formatDayMonth(day.date, 'bn'), attrs: { scope: 'col' },
      }));
    }
    append(thead, hrow);
    append(table, thead);

    const tbody = el(d, 'tbody');
    for (const periodNo of periods) {
      const tr = el(d, 'tr');
      const start = startOf.get(periodNo);
      append(tr, el(d, 'th', { className: 'routine-grid-period', attrs: { scope: 'row' } },
        el(d, 'span', { className: 'routine-grid-no', text: `${bnNum(periodNo)}` }),
        start
          ? el(d, 'span', { className: 'routine-grid-time', text: formatTime(start, 'bn') })
          : null));

      for (const day of days) {
        const sl = day.slots.find((x) => x.periodNo === periodNo);
        const td = el(d, 'td', {
          className: 'routine-grid-cell',
          data: {
            kind: sl?.slotKind,
            substitution: sl?.isSubstitution ? 'true' : undefined,
          },
        });
        if (!sl) {
          // An empty cell is a free period, and saying so beats a blank a
          // reader has to interpret.
          append(td, el(d, 'span', { className: 'ui-sr-only', text: 'ক্লাস নেই' }));
        } else if (sl.slotKind !== 'teaching') {
          append(td, el(d, 'span', { className: 'routine-grid-kind', text: slotKindBn(sl.slotKind) }));
        } else {
          append(td,
            el(d, 'span', { className: 'routine-grid-subject', text: sl.subjectBn ?? '—' }),
            sl.sectionLabel
              ? el(d, 'span', { className: 'routine-grid-meta', text: sl.sectionLabel })
              : null,
            // The substitution mark carries the same word it does in the day
            // list, not a colour: a teacher reading the grid must not have to
            // learn a second vocabulary.
            sl.isSubstitution
              ? el(d, 'span', { className: 'routine-grid-sub', text: 'বদলি' })
              : null);
        }
        append(tr, td);
      }
      append(tbody, tr);
    }
    append(table, tbody);
    append(scroll, table);
    return scroll;
  }

  private renderDay(root: HTMLElement, slots: RoutineSlot[]): void {
    const d = this.o.doc;
    if (slots.length === 0) {
      append(root, emptyState(d, {
        message: 'এই দিনে আপনার কোনো ক্লাস নেই।',
      }));
      return;
    }

    const ul = el(d, 'ul', {
      className: 'routine-list', attrs: { 'aria-label': 'ক্লাসের তালিকা' },
    });
    for (const s of slots) {
      const li = el(d, 'li', {
        className: 'routine-row',
        data: { kind: s.slotKind, substitution: s.isSubstitution ? 'true' : undefined },
      });

      append(li, el(d, 'span', {
        className: 'routine-time', text: formatTime(s.startsAt.slice(0, 5), 'bn'),
      }));

      const body = el(d, 'span', { className: 'routine-body' });
      append(body, el(d, 'span', {
        className: 'routine-subject',
        text: s.subjectBn ?? (s.slotKind === 'teaching' ? '—' : slotKindBn(s.slotKind)),
      }));
      if (s.sectionLabel) {
        append(body, el(d, 'span', {
          className: 'routine-meta',
          text: [s.sectionLabel, s.roomCode ? `কক্ষ ${s.roomCode}` : null]
            .filter(Boolean).join(' · '),
        }));
      }
      if (s.isSubstitution) {
        // §"If a substitution exists, clearly explain why and what changed."
        // The old tag said "পরিবর্তী ক্লাস" — which names the fact and
        // answers none of the question a teacher standing in an unfamiliar
        // corridor is actually asking.
        append(body, el(d, 'span', { className: 'routine-sub-note' },
          icon(d, 'repeat', 'routine-sub-glyph'),
          el(d, 'span', {
            text: s.coveringForBn
              ? `${s.coveringForBn}-এর বদলি হিসেবে আপনি এই ক্লাসটি নিচ্ছেন।`
              : 'এটি আপনার নিজের ক্লাস নয় — বদলি হিসেবে নিচ্ছেন।',
          })));
      }
      append(li, body);

      // Never colour alone: the register's state is a word on every teaching
      // row, present or absent from the day.
      if (s.slotKind === 'teaching' && s.sectionLabel) {
        append(li, s.attendanceTaken
          ? statusBadge(d, { state: 'present', label: 'হাজিরা জমা' })
          : statusBadge(d, { state: 'pending', label: 'হাজিরা বাকি' }));
      } else if (s.slotKind !== 'teaching') {
        append(li, badge(d, { label: slotKindBn(s.slotKind) }));
      }

      append(ul, li);
    }
    append(root, ul);
  }
}

/**
 * Slot kinds, in Bangla.
 *
 * The old renderer printed `s.slotKind` straight into the subject line when
 * there was no subject — so a break rendered as the literal string "break" on
 * a Bangla screen.
 */
function slotKindBn(kind: string): string {
  switch (kind) {
    case 'break':     return 'বিরতি';
    case 'assembly':  return 'সমাবেশ';
    case 'prayer':    return 'নামাজ';
    case 'lunch':     return 'দুপুরের বিরতি';
    case 'free':      return 'ফাঁকা সময়';
    case 'teaching':  return 'ক্লাস';
    default:          return kind;
  }
}
