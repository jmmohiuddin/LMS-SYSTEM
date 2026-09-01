/**
 * Substitution finder (বদলি শিক্ষক) — the RMS §5 engine as a page.
 *
 * Flow: pick a date → the user's own teaching slots that day (from
 * GET /api/v1/rms/routine, the same source as the routine tab) → tap a slot
 * → POST /api/v1/rms/substitute ranks free, subject-matched candidates →
 * one tap assigns (coordinator-level roles; the server's 403 is surfaced
 * plainly for everyone else, and the check_substitute_free DB trigger keeps
 * a stale list from ever double-booking anyone).
 */
import type { Auth } from './auth.ts';
import type { RoutineSlot } from './routine-view.ts';
import { formatTime } from '../../../packages/ui-core/src/format.ts';
import {
  pageHeader, field, dataTable, statusBadge, button, listSkeleton, openDrawer,
  setOverlayBody, el, append, type OverlayHandle,
} from './ui/index.ts';
import { bnDate, bnNum, successNote } from './view-states.ts';

interface Candidate {
  teacherId: string;
  fullName: { bn: string | null; en: string | null };
  rank: number;
  matchScore: number;
  matchReasons: string[];
}

export interface SubstituteViewOptions {
  root: HTMLElement;
  doc: Document;
  auth: Auth;
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

export class SubstituteView {
  private readonly o: SubstituteViewOptions;
  private date = todayIso();
  private slots: RoutineSlot[] = [];
  private selectedSlot: RoutineSlot | null = null;
  private candidates: Candidate[] = [];
  private busy = false;
  private notice = '';
  /** The open candidate drawer, so a result can fill it without a repaint. */
  private drawer: OverlayHandle | null = null;
  /** Which periods already have a substitute, so the table says so. */
  private readonly assignedSlots = new Set<string>();
  private assignedTo: string | null = null;

  constructor(options: SubstituteViewOptions) {
    this.o = options;
    void this.loadSlots();
  }

  private async loadSlots(): Promise<void> {
    this.busy = true;
    // A new day is a new set of periods: a drawer left open over it would be
    // staffing a period that is no longer on screen.
    this.drawer?.close();
    this.drawer = null;
    this.selectedSlot = null;
    this.candidates = [];
    this.assignedTo = null;
    this.notice = '';
    this.render();
    try {
      const res = await this.o.auth.authedFetch(`/api/v1/rms/routine?scope=day&date=${this.date}`);
      if (!res.ok) throw new Error(String(res.status));
      const body = (await res.json()) as { slots: RoutineSlot[] };
      this.slots = body.slots.filter((s) => s.slotKind === 'teaching' && !s.isSubstitution);
    } catch {
      this.slots = [];
      this.notice = 'রুটিন আনা যায়নি — সংযোগ দেখুন।';
    }
    this.busy = false;
    this.render();
  }

  private async findCandidates(slot: RoutineSlot): Promise<void> {
    this.selectedSlot = slot;
    this.candidates = [];
    this.assignedTo = null;
    this.busy = true;
    this.notice = '';
    this.render();
    try {
      const res = await this.o.auth.authedFetch('/api/v1/rms/substitute', {
        method: 'POST',
        body: JSON.stringify({ slotId: slot.slotId, date: this.date }),
      });
      const body = (await res.json().catch(() => ({}))) as { candidates?: Candidate[]; error?: string };
      if (res.ok && body.candidates) {
        this.candidates = body.candidates;
        if (this.candidates.length === 0) this.notice = 'ঐ পিরিয়ডে কোনো শিক্ষক ফাঁকা নেই।';
      } else if (res.status === 403) {
        this.notice = 'বদলি খোঁজা শুধু সমন্বয়কারী/অধ্যক্ষ পর্যায়ের জন্য।';
      } else {
        this.notice = 'প্রার্থী খোঁজা যায়নি। আবার চেষ্টা করুন।';
      }
    } catch {
      this.notice = 'সংযোগে সমস্যা হয়েছে। আবার চেষ্টা করুন।';
    }
    this.busy = false;
    this.render();
  }

  private async assign(candidate: Candidate): Promise<void> {
    const slot = this.selectedSlot;
    if (!slot || this.busy) return;
    this.busy = true;
    this.render();
    try {
      const res = await this.o.auth.authedFetch('/api/v1/rms/substitute', {
        method: 'POST',
        body: JSON.stringify({
          slotId: slot.slotId,
          date: this.date,
          assign: true,
          substituteTeacherId: candidate.teacherId,
        }),
      });
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (res.ok && body.ok) {
        this.assignedTo = candidate.fullName.bn || candidate.fullName.en || candidate.teacherId;
        // The table behind the drawer says so too, so a coordinator staffing
        // six periods can see which are done without closing anything.
        this.assignedSlots.add(slot.slotId);
        this.notice = '';
      } else if (body.error === 'substitute_conflict') {
        this.notice = 'এই শিক্ষক ইতিমধ্যে ব্যস্ত হয়ে গেছেন — অন্য কাউকে বেছে নিন।';
        await this.findCandidates(slot);
        return;
      } else if (res.status === 403) {
        this.notice = 'বদলি নির্ধারণ শুধু সমন্বয়কারী/অধ্যক্ষ পর্যায়ের জন্য।';
      } else {
        this.notice = 'নির্ধারণ করা যায়নি। আবার চেষ্টা করুন।';
      }
    } catch {
      this.notice = 'সংযোগে সমস্যা হয়েছে। আবার চেষ্টা করুন।';
    }
    this.busy = false;
    this.render();
  }

  private render(): void {
    const d = this.o.doc;
    const root = this.o.root;
    root.textContent = '';

    root.append(pageHeader(d, {
      title: 'বদলি শিক্ষক',
      subtitle: 'অনুপস্থিতির দিনে ফাঁকা ও বিষয়-মিল শিক্ষক খুঁজুন',
    }));

    // A labelled field. This was a bare `<input type=date>` with no name of
    // any kind, on the screen whose entire question is which day.
    root.append(field(d, {
      label: 'কোন দিনের জন্য',
      name: 'day',
      kind: 'date',
      value: this.date,
      helper: 'ওই দিনের রুটিন থেকে পিরিয়ডগুলো আসবে।',
      onChange: (v) => {
        if (!v) return;
        this.date = v;
        void this.loadSlots();
      },
    }).root);

    if (this.notice) {
      root.append(el(d, 'p', {
        className: 'login-error', attrs: { role: 'alert' }, text: this.notice,
      }));
    }

    if (this.busy && this.slots.length === 0) { root.append(listSkeleton(d, 4)); return; }

    root.append(dataTable(d, {
      caption: `${bnDate(this.date)} — এই দিনের পিরিয়ড`,
      rows: this.slots,
      rowKey: (sl) => sl.slotId,
      onRowClick: (sl) => { void this.findCandidates(sl); },
      empty: {
        glyph: 'clock',
        message: 'এই দিনে আপনার কোনো ক্লাস নেই। অন্য তারিখ বেছে নিন।',
      },
      columns: [
        { key: 'time', header: 'সময়', mobile: 'meta',
          cell: (sl) => formatTime(sl.startsAt.slice(0, 5), 'bn'), width: '120px' },
        { key: 'subject', header: 'বিষয়', mobile: 'title',
          cell: (sl) => sl.subjectBn ?? '—', width: 'minmax(0, 2fr)' },
        { key: 'section', header: 'শাখা', mobile: 'subtitle',
          cell: (sl) => sl.sectionLabel ?? '—', width: 'minmax(0, 1.4fr)' },
        { key: 'state', header: 'অবস্থা', mobile: 'status', width: '160px',
          cell: (sl) => (this.assignedSlots.has(sl.slotId)
            ? statusBadge(d, { state: 'published', label: 'বদলি নির্ধারিত' })
            : statusBadge(d, { state: 'pending', label: 'বদলি লাগবে' })) },
      ],
    }));

    // The drawer is filled from the same render pass that draws the table,
    // so a result landing mid-search reaches it without a second code path.
    if (this.selectedSlot) this.renderCandidates();
  }

  /**
   * Candidates for ONE period, in a drawer.
   *
   * A drawer rather than a second full screen: the coordinator is staffing a
   * day, and replacing the day with a candidate list makes them remember
   * which period they were on. Everything that was on the old candidate
   * screen is here, plus the period itself as the drawer's own subtitle.
   */
  private renderCandidates(): void {
    const d = this.o.doc;
    const sl = this.selectedSlot;
    if (!sl) return;

    const body = el(d, 'div', { className: 'ui-card-form' });

    if (this.assignedTo) {
      append(body, successNote(d, `${this.assignedTo} কে বদলি নির্ধারণ করা হয়েছে।`));
    } else if (this.busy) {
      append(body, listSkeleton(d, 3));
    } else {
      append(body, dataTable(d, {
        caption: 'সম্ভাব্য বদলি শিক্ষক',
        rows: this.candidates,
        rowKey: (c) => String(c.rank),
        empty: {
          glyph: 'users',
          message: 'এই সময়ে কোনো শিক্ষক ফাঁকা নেই। অন্য পিরিয়ড দেখুন বা রুটিন বদলান।',
        },
        columns: [
          { key: 'rank', header: 'ক্রম', mobile: 'meta', numeric: true,
            cell: (c) => bnNum(c.rank), width: '80px' },
          { key: 'name', header: 'শিক্ষক', mobile: 'title',
            cell: (c) => c.fullName.bn || c.fullName.en || '—', width: 'minmax(0, 2fr)' },
          // WHY this teacher is suggested. A ranked list with no stated
          // reason is a ranking a coordinator cannot disagree with.
          { key: 'why', header: 'কেন', mobile: 'subtitle', width: 'minmax(0, 1.8fr)',
            cell: (c) => (c.matchReasons.includes('subject_expertise')
              ? 'এই বিষয়ে দক্ষ · এই সময়ে ফাঁকা'
              : 'এই সময়ে ফাঁকা') },
          { key: 'act', header: 'ব্যবস্থা', width: '150px',
            cell: (c) => el(d, 'div', { className: 'ui-row-actions' }, button(d, {
              label: 'নির্ধারণ', variant: 'primary', size: 'sm',
              ariaLabel: `${c.fullName.bn || c.fullName.en || 'এই শিক্ষক'}-কে বদলি নির্ধারণ করুন`,
              disabled: this.busy,
              onClick: () => { void this.assign(c); },
            })) },
        ],
      }));
    }

    if (this.drawer) setOverlayBody(this.drawer, body);
    else {
      this.drawer = openDrawer(d, {
        title: `${sl.subjectBn ?? '—'} · ${sl.sectionLabel ?? ''}`,
        body,
        onClose: () => {
          this.drawer = null;
          this.selectedSlot = null;
          this.assignedTo = '';
          this.notice = '';
          this.render();
        },
      });
    }
  }
}
