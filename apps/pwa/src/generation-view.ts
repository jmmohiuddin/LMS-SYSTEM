/**
 * Routine generation result — F-503, F-505, wireframe §8.2
 *
 *   ✓ কঠিন শর্ত লঙ্ঘন: ০
 *   নরম শর্ত ছাড় দেওয়া হয়েছে: ৭
 *   যা ছাড় দিতে হয়েছে
 *   • রফিক ইসলাম — সাপ্তাহিক ২৬ পিরিয়ড (লক্ষ্য ২৪) — যোগ্য গণিত শিক্ষক কম
 *   [ কেন এই বরাদ্দ? ]  স্লট বেছে নিন
 *   [ গ্রহণ করুন ] [ পুনরায় তৈরি ] [ বাতিল ]
 *
 * The screen where a coordinator decides whether to accept a machine's
 * timetable for 1,200 children. Three things it must not do.
 *
 * It must not bury the trade-offs. §8.2 puts the soft-constraint count in
 * the header, beside the hard count, and the list immediately under it —
 * before the accept button, not behind a disclosure. "Nothing is silently
 * accepted" is a layout requirement as much as a data one.
 *
 * It must not show a clean report that isn't. When rules could not be
 * evaluated the screen says which, because "০ লঙ্ঘন" otherwise means
 * "০ of the rules I happen to check" and reads as a guarantee.
 *
 * It must not explain a slot until asked. §8.2 makes the explanation a
 * deliberate act — pick a slot, read why. Rendering 300 justifications
 * nobody requested is how a screen becomes unreadable.
 */
import type { Auth } from './auth.ts';
import { errorState } from './view-states.ts';
import { formatCount, formatTime } from '../../../packages/ui-core/src/format.ts';
import { pageHeader } from './ui/page-header.ts';
import { serverMessage, statRow, statCard, listSkeleton,} from './ui/index.ts';

const bn = (n: number): string => formatCount(n, 'bn');

/** 0 = Sunday, matching routine_slots.day_of_week. */
const DAY_BN = ['রবি', 'সোম', 'মঙ্গল', 'বুধ', 'বৃহস্পতি', 'শুক্র', 'শনি'];

export interface SoftViolation {
  code: string;
  detailBn: string;
  causeBn?: string;
}

export interface GenSlot {
  id: string;
  dayOfWeek: number;
  periodNo: number;
  startsAt: string;
  sectionLabel: string;
  subjectBn: string;
  teacherNameBn: string;
  roomCode: string | null;
}

export interface Explanation {
  slotId: string;
  sectionLabel: string;
  subjectBn: string;
  dayOfWeek: number;
  periodNo: number;
  teacherWhyBn: string;
  roomWhyBn: string | null;
}

export interface CapabilityShortage {
  capability: string;
  demandedPeriods: number;
  capableRooms: number;
  freePeriods: number;
  detailBn: string;
}

interface Report {
  routine: { id: string; nameBn: string; status: string; objectiveScore: number | null };
  hardViolations: number;
  soft: SoftViolation[];
  unplaced: Array<{ missing: number; reason: string }>;
  notEvaluated: Array<{ ruleBn: string; whyBn: string }>;
  shortages: CapabilityShortage[];
  slots: GenSlot[];
}

export interface GenerationViewOptions {
  root: HTMLElement;
  doc: Document;
  auth: Auth;
  routineId: string;
  /** Re-runs the solver. §8.2's [ পুনরায় তৈরি ]. */
  onRegenerate?: (routineId: string) => void;
}

const ENDPOINT = '/api/v1/rms/generation';
const SOFT_SHOWN = 8;

export class GenerationView {
  private readonly o: GenerationViewOptions;
  private data: Report | null = null;
  private explanation: Explanation | null = null;
  private loading = true;
  private busy = false;
  private error: string | null = null;
  private expanded = false;

  constructor(options: GenerationViewOptions) {
    this.o = options;
    this.render();
    void this.load();
  }

  private async load(): Promise<void> {
    try {
      const res = await this.o.auth.authedFetch(
        `${ENDPOINT}?routineId=${encodeURIComponent(this.o.routineId)}`);
      if (!res.ok) throw new Error(String(res.status));
      this.data = (await res.json()) as Report;
      this.error = null;
    } catch {
      this.error = 'ফলাফল লোড হয়নি।';
    } finally {
      this.loading = false;
      this.render();
    }
  }

  private async explain(slotId: string): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.render();
    try {
      const res = await this.o.auth.authedFetch(`${ENDPOINT}?slotId=${encodeURIComponent(slotId)}`);
      if (!res.ok) throw new Error(String(res.status));
      this.explanation = (await res.json()) as Explanation;
      this.error = null;
    } catch {
      this.error = 'ব্যাখ্যা পাওয়া যায়নি।';
    } finally {
      this.busy = false;
      this.render();
    }
  }

  private async act(action: 'accept' | 'discard'): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.error = null;
    this.render();
    try {
      const res = await this.o.auth.authedFetch(ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ routineId: this.o.routineId, action }),
      });
      const body = (await res.json()) as { status?: string; message?: string };
      if (!res.ok) {
        // The server's refusal names a teacher or a room. That text is the
        // whole value of the failure, so it is shown verbatim rather than
        // replaced with "could not publish".
        this.error = serverMessage(body, res.status, 'কাজটি সম্পন্ন হয়নি।');
      } else if (this.data) {
        this.data.routine.status = body.status ?? this.data.routine.status;
      }
    } catch {
      this.error = 'সংযোগ পাওয়া যায়নি।';
    } finally {
      this.busy = false;
      this.render();
      void this.load();
    }
  }

  // ── rendering ───────────────────────────────────────────────────────
  private render(): void {
    const d = this.o.doc;
    const root = this.o.root;
    root.textContent = '';
    root.setAttribute('lang', 'bn');

    const header = pageHeader(d, {
      title: 'রুটিন তৈরি হয়েছে',
      subtitle: this.loading ? 'লোড হচ্ছে…' : (this.data?.routine.nameBn ?? ''),
    });
    root.append(header);

    // An error is the whole answer: with no report loaded there is nothing
    // to render underneath it but a blank.
    if (this.error) {
      root.append(errorState(d, this.error, () => void this.load()));
      return;
    }

    if (this.loading) { root.append(listSkeleton(d, 4)); return; }
    if (!this.data) return;

    root.append(this.counters(this.data));
    // Above the trade list: a shortage is why periods are missing, and a
    // coordinator reading "৪টি পিরিয়ড বসানো যায়নি" without it has to guess.
    if (this.data.shortages.length > 0) root.append(this.shortageList(this.data));
    if (this.data.soft.length > 0 || this.data.unplaced.length > 0) {
      root.append(this.tradeList(this.data));
    }
    if (this.data.notEvaluated.length > 0) root.append(this.notEvaluated(this.data));
    root.append(this.explainPanel(this.data));
    root.append(this.actions(this.data));
  }

  private counters(r: Report): HTMLElement {
    const d = this.o.doc;
    // Figures, not three sentences. These are the three numbers a
    // coordinator decides on — whether to accept this routine, and what it
    // cost — and a decision is made from a comparison.
    return statRow(d,
      statCard(d, {
        label: 'কঠিন শর্ত লঙ্ঘন', value: bn(r.hardViolations), glyph: 'lock',
        // Zero because the database's exclusion constraints make a hard
        // violation unstorable — the figure states that the guarantee exists
        // rather than that the run happened to be lucky.
        tone: r.hardViolations === 0 ? 'success' : 'warn',
        note: r.hardViolations === 0 ? 'ডাটাবেসেই অসম্ভব' : undefined,
      }),
      statCard(d, {
        label: 'নরম শর্তে ছাড়', value: bn(r.soft.length), glyph: 'alert-triangle',
        tone: r.soft.length > 0 ? 'warn' : 'success',
        note: r.soft.length > 0 ? 'নিচে কোনগুলো দেখুন' : 'কিছু ছাড় দিতে হয়নি',
      }),
      ...(r.routine.objectiveScore !== null
        ? [statCard(d, {
            label: 'চাহিদা পূরণ', value: `${bn(Math.round(r.routine.objectiveScore))}%`,
            glyph: 'trending-up', tone: 'info',
          })]
        : []),
    );
  }

  /**
   * F-503 / §8.2: "Infeasibility reports the binding shortage in resource
   * terms the coordinator can act on — not 'no solution found'."
   *
   * This is the section somebody screenshots and takes to a budget
   * meeting, so it leads with the resource and the two numbers.
   */
  private shortageList(r: Report): HTMLElement {
    const d = this.o.doc;
    const box = d.createElement('section');
    box.className = 'card gen-shortage';
    const h = d.createElement('h2');
    h.className = 'gen-head';
    h.textContent = 'কেন বসানো যায়নি';
    box.append(h);

    const ul = d.createElement('ul');
    ul.className = 'gen-trades gen-shortage-list';
    for (const s of r.shortages) {
      const li = d.createElement('li');
      const what = d.createElement('span');
      what.className = 'gen-trade-what';
      what.textContent = s.detailBn;
      li.append(what);
      ul.append(li);
    }
    box.append(ul);
    return box;
  }

  private tradeList(r: Report): HTMLElement {
    const d = this.o.doc;
    const box = d.createElement('section');
    box.className = 'card';

    const h = d.createElement('h2');
    h.className = 'gen-head';
    h.textContent = 'যা ছাড় দিতে হয়েছে';
    box.append(h);

    const ul = d.createElement('ul');
    ul.className = 'gen-trades';
    const shown = this.expanded ? r.soft : r.soft.slice(0, SOFT_SHOWN);
    for (const v of shown) {
      const li = d.createElement('li');
      const what = d.createElement('span');
      what.className = 'gen-trade-what';
      what.textContent = v.detailBn;
      li.append(what);
      if (v.causeBn) {
        // The cause is what turns a complaint into an argument for a hire.
        const why = d.createElement('span');
        why.className = 'gen-trade-why';
        why.textContent = `— ${v.causeBn}`;
        li.append(why);
      }
      ul.append(li);
    }
    box.append(ul);

    if (!this.expanded && r.soft.length > SOFT_SHOWN) {
      const more = d.createElement('button');
      more.type = 'button';
      more.className = 'btn-secondary btn-small';
      // Never a bare "···": the count is what tells a coordinator whether
      // this is a tidy routine or a bad one.
      more.textContent = `··· আরও ${bn(r.soft.length - SOFT_SHOWN)}টি দেখুন`;
      more.addEventListener('click', () => { this.expanded = true; this.render(); });
      box.append(more);
    }

    if (r.unplaced.length > 0) {
      const missing = r.unplaced.reduce((sum, u) => sum + u.missing, 0);
      const p = d.createElement('p');
      p.className = 'gen-counter is-warn';
      // Distinct from a soft trade: an unplaced period is a class that
      // does not happen, not a preference given up.
      p.textContent = `${bn(missing)}টি পিরিয়ড বসানো যায়নি`;
      box.append(p);
    }
    return box;
  }

  private notEvaluated(r: Report): HTMLElement {
    const d = this.o.doc;
    const box = d.createElement('section');
    box.className = 'card gen-unchecked';
    const h = d.createElement('h2');
    h.className = 'gen-head';
    h.textContent = 'যা যাচাই করা হয়নি';
    box.append(h);
    const ul = d.createElement('ul');
    // Its own class, not gen-trades: these are rules that did not run, not
    // trades that were made, and a selector that cannot tell them apart
    // would let an un-run rule be counted as a violation.
    ul.className = 'gen-trades gen-unchecked-list';
    for (const n of r.notEvaluated) {
      const li = d.createElement('li');
      const what = d.createElement('span');
      what.className = 'gen-trade-what';
      what.textContent = n.ruleBn;
      const why = d.createElement('span');
      why.className = 'gen-trade-why';
      why.textContent = `— ${n.whyBn}`;
      li.append(what, why);
      ul.append(li);
    }
    box.append(ul);
    return box;
  }

  private explainPanel(r: Report): HTMLElement {
    const d = this.o.doc;
    const box = d.createElement('section');
    box.className = 'card';

    const h = d.createElement('h2');
    h.className = 'gen-head';
    h.textContent = 'কেন এই বরাদ্দ?';
    box.append(h);

    const select = d.createElement('select');
    select.className = 'gen-slot-select';
    select.setAttribute('aria-label', 'স্লট বেছে নিন');
    const blank = d.createElement('option');
    blank.value = '';
    blank.textContent = 'স্লট বেছে নিন';
    select.append(blank);
    for (const s of r.slots) {
      const opt = d.createElement('option');
      opt.value = s.id;
      opt.textContent = `${DAY_BN[s.dayOfWeek]} · পিরিয়ড ${bn(s.periodNo)} · `
                      + `${s.sectionLabel} · ${s.subjectBn}`;
      if (this.explanation?.slotId === s.id) opt.selected = true;
      select.append(opt);
    }
    select.addEventListener('change', () => {
      if (select.value) void this.explain(select.value);
      else { this.explanation = null; this.render(); }
    });
    box.append(select);

    if (this.explanation) {
      const e = this.explanation;
      const card = d.createElement('div');
      card.className = 'gen-explain';
      card.setAttribute('role', 'status');

      const head = d.createElement('p');
      head.className = 'gen-explain-head';
      head.textContent = `${DAY_BN[e.dayOfWeek]} · পিরিয়ড ${bn(e.periodNo)} · `
                       + `${e.sectionLabel} · ${e.subjectBn}`;
      card.append(head);

      const who = d.createElement('p');
      who.className = 'gen-explain-line';
      who.textContent = e.teacherWhyBn;
      card.append(who);

      if (e.roomWhyBn) {
        const where = d.createElement('p');
        where.className = 'gen-explain-line';
        where.textContent = e.roomWhyBn;
        card.append(where);
      }
      box.append(card);
    }
    return box;
  }

  private actions(r: Report): HTMLElement {
    const d = this.o.doc;
    const box = d.createElement('div');
    box.className = 'card action-row';

    const published = r.routine.status === 'active';
    const state = d.createElement('span');
    state.className = 'status-chip';
    state.dataset.state = published ? 'success' : 'pending';
    state.textContent = published ? '✓ প্রকাশিত' : '✎ খসড়া';
    box.append(state);

    if (!published) {
      const accept = d.createElement('button');
      accept.type = 'button';
      accept.className = 'btn-primary';
      accept.textContent = 'গ্রহণ করুন';
      accept.disabled = this.busy;
      accept.addEventListener('click', () => { void this.act('accept'); });
      box.append(accept);

      const again = d.createElement('button');
      again.type = 'button';
      again.className = 'btn-secondary';
      again.textContent = 'পুনরায় তৈরি';
      again.disabled = this.busy || !this.o.onRegenerate;
      again.addEventListener('click', () => { this.o.onRegenerate?.(this.o.routineId); });
      box.append(again);

      const cancel = d.createElement('button');
      cancel.type = 'button';
      cancel.className = 'btn-secondary';
      cancel.textContent = 'বাতিল';
      cancel.disabled = this.busy;
      cancel.addEventListener('click', () => { void this.act('discard'); });
      box.append(cancel);
    }
    return box;
  }

  private skeleton(): HTMLElement {
    const d = this.o.doc;
    const box = d.createElement('div');
    box.setAttribute('aria-busy', 'true');
    box.setAttribute('aria-label', 'ফলাফল লোড হচ্ছে');
    for (let i = 0; i < 3; i++) {
      const card = d.createElement('div');
      card.className = 'card is-skeleton';
      const a = d.createElement('div'); a.className = 'skel skel-title';
      const b = d.createElement('div'); b.className = 'skel skel-line';
      card.append(a, b);
      box.append(card);
    }
    return box;
  }
}

/** Exported for the shell's route, which formats a slot label the same way. */
export function slotLabel(s: GenSlot): string {
  return `${DAY_BN[s.dayOfWeek]} · ${formatTime(s.startsAt, 'bn')} · ${s.sectionLabel} · ${s.subjectBn}`;
}
