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
  private assignedTo: string | null = null;

  constructor(options: SubstituteViewOptions) {
    this.o = options;
    void this.loadSlots();
  }

  private async loadSlots(): Promise<void> {
    this.busy = true;
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

    const header = d.createElement('header');
    header.className = 'att-header';
    const h1 = d.createElement('h1');
    h1.textContent = 'বদলি শিক্ষক';
    const sub = d.createElement('p');
    sub.className = 'att-sub';
    sub.textContent = 'অনুপস্থিতির দিনে ফাঁকা ও বিষয়-মিল শিক্ষক খুঁজুন';
    header.append(h1, sub);
    root.append(header);

    const dateIn = d.createElement('input');
    dateIn.type = 'date';
    dateIn.className = 'section-picker';
    dateIn.value = this.date;
    dateIn.addEventListener('change', () => {
      if (!dateIn.value) return;
      this.date = dateIn.value;
      void this.loadSlots();
    });
    root.append(dateIn);

    if (this.notice) {
      const n = d.createElement('p');
      n.className = 'login-error';
      n.setAttribute('role', 'alert');
      n.hidden = false;
      n.textContent = this.notice;
      root.append(n);
    }

    if (this.busy && this.slots.length === 0 && !this.selectedSlot) {
      const p = d.createElement('p');
      p.className = 'att-sub';
      p.textContent = 'লোড হচ্ছে…';
      root.append(p);
      return;
    }

    if (!this.selectedSlot) {
      if (this.slots.length === 0 && !this.busy && !this.notice) {
        const p = d.createElement('p');
        p.className = 'att-sub';
        p.textContent = 'এই দিনে আপনার কোনো ক্লাস নেই।';
        root.append(p);
        return;
      }
      const list = d.createElement('ul');
      list.className = 'routine-list';
      for (const s of this.slots) {
        const li = d.createElement('li');
        li.className = 'routine-row sub-slot';
        const time = d.createElement('span');
        time.className = 'routine-time';
        time.textContent = formatTime(s.startsAt.slice(0, 5), 'bn');
        const body = d.createElement('button');
        body.type = 'button';
        body.className = 'sub-slot-btn';
        body.textContent = `${s.subjectBn ?? '—'} · ${s.sectionLabel ?? ''}`;
        body.addEventListener('click', () => { void this.findCandidates(s); });
        li.append(time, body);
        list.append(li);
      }
      root.append(list);
      return;
    }

    // candidate stage
    const slotLine = d.createElement('p');
    slotLine.className = 'att-sub';
    slotLine.textContent =
      `${this.date} · ${formatTime(this.selectedSlot.startsAt.slice(0, 5), 'bn')} · ` +
      `${this.selectedSlot.subjectBn ?? ''} ${this.selectedSlot.sectionLabel ?? ''}`;
    root.append(slotLine);

    const back = d.createElement('button');
    back.type = 'button';
    back.className = 'btn-secondary';
    back.textContent = '← অন্য পিরিয়ড';
    back.addEventListener('click', () => { this.selectedSlot = null; this.notice = ''; this.render(); });
    root.append(back);

    if (this.assignedTo) {
      const okMsg = d.createElement('p');
      okMsg.className = 'routine-chip sub-assigned';
      okMsg.textContent = `✓ ${this.assignedTo} কে বদলি নির্ধারণ করা হয়েছে`;
      root.append(okMsg);
      return;
    }

    if (this.busy) {
      const p = d.createElement('p');
      p.className = 'att-sub';
      p.textContent = 'খোঁজা হচ্ছে…';
      root.append(p);
      return;
    }

    const list = d.createElement('ul');
    list.className = 'sub-candidates';
    for (const c of this.candidates) {
      const li = d.createElement('li');
      li.className = 'sub-candidate';
      const body = d.createElement('span');
      body.className = 'more-body';
      const name = d.createElement('span');
      name.className = 'more-title';
      name.textContent = `${c.rank}. ${c.fullName.bn || c.fullName.en || '—'}`;
      const why = d.createElement('span');
      why.className = 'more-sub';
      why.textContent = c.matchReasons.includes('subject_expertise')
        ? 'বিষয়-মিল আছে · ফাঁকা'
        : 'ফাঁকা';
      body.append(name, why);
      const btn = d.createElement('button');
      btn.type = 'button';
      btn.className = 'btn-primary sub-assign';
      btn.textContent = 'নির্ধারণ';
      btn.addEventListener('click', () => { void this.assign(c); });
      li.append(body, btn);
      list.append(li);
    }
    root.append(list);
  }
}
