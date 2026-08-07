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
import { formatDayMonth, formatTime } from '../../../packages/ui-core/src/format.ts';

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

    const header = d.createElement('header');
    header.className = 'att-header';
    const h1 = d.createElement('h1');
    h1.textContent = 'রুটিন';
    header.append(h1);

    const toggle = d.createElement('div');
    toggle.className = 'routine-toggle';
    for (const [mode, label] of [['day', 'আজ'], ['week', 'সপ্তাহ']] as const) {
      const btn = d.createElement('button');
      btn.type = 'button';
      btn.className = 'btn-secondary';
      btn.classList.toggle('active', this.mode === mode);
      btn.textContent = label;
      btn.addEventListener('click', () => {
        if (this.mode === mode) return;
        this.mode = mode;
        void this.load();
      });
      toggle.append(btn);
    }
    header.append(toggle);

    if (this.offline) {
      const banner = d.createElement('p');
      banner.className = 'offline-banner';
      banner.textContent = 'অফলাইন — সর্বশেষ সংরক্ষিত রুটিন দেখানো হচ্ছে';
      header.append(banner);
    }

    root.append(header);

    if (this.loading && !this.day && !this.week) {
      const p = d.createElement('p');
      p.className = 'att-sub';
      p.textContent = 'লোড হচ্ছে…';
      root.append(p);
      return;
    }

    if (this.mode === 'day') {
      this.renderDay(root, this.day?.slots ?? []);
    } else {
      const days = this.week?.days ?? [];
      for (const day of days) {
        const dayHeading = d.createElement('h2');
        dayHeading.className = 'routine-day-heading';
        dayHeading.textContent = formatDayMonth(day.date, 'bn');
        root.append(dayHeading);
        this.renderDay(root, day.slots);
      }
    }
  }

  private renderDay(root: HTMLElement, slots: RoutineSlot[]): void {
    const d = this.o.doc;
    if (slots.length === 0) {
      const p = d.createElement('p');
      p.className = 'att-sub';
      p.textContent = 'এই দিনে কোনো ক্লাস নেই।';
      root.append(p);
      return;
    }

    const list = d.createElement('ul');
    list.className = 'routine-list';
    for (const s of slots) {
      const li = d.createElement('li');
      li.className = 'routine-row';
      li.dataset.kind = s.slotKind;
      if (s.isSubstitution) li.dataset.substitution = 'true';

      const time = d.createElement('span');
      time.className = 'routine-time';
      time.textContent = `${formatTime(s.startsAt.slice(0, 5), 'bn')}`;

      const body = d.createElement('span');
      body.className = 'routine-body';
      const title = d.createElement('span');
      title.className = 'routine-subject';
      title.textContent = s.subjectBn ?? (s.slotKind === 'teaching' ? '—' : s.slotKind);
      body.append(title);
      if (s.sectionLabel) {
        const meta = d.createElement('span');
        meta.className = 'routine-meta';
        meta.textContent = [s.sectionLabel, s.roomCode].filter(Boolean).join(' · ');
        body.append(meta);
      }
      if (s.isSubstitution) {
        const sub = d.createElement('span');
        sub.className = 'routine-sub-tag';
        sub.textContent = s.coveringForBn ? `পরিবর্তে: ${s.coveringForBn}` : 'পরিবর্তী ক্লাস';
        body.append(sub);
      }

      li.append(time, body);

      if (s.slotKind === 'teaching' && s.attendanceTaken) {
        const chip = d.createElement('span');
        chip.className = 'routine-chip';
        chip.textContent = 'হাজিরা নেওয়া হয়েছে';
        li.append(chip);
      }

      list.append(li);
    }
    root.append(list);
  }
}
