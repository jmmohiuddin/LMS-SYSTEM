/**
 * The attendance screen. (UI integration plan, P3 — highest priority)
 *
 * `AttendanceView` renders the grid and owns the save path; it is deliberately
 * untouched by this phase, because that path is the product's one durable
 * write and §"Do NOT restructure the outbox/save/sync implementation merely
 * for UI" is the right rule. **This module is everything around it**: which
 * section, which roster, and the eleven moments before and after the grid is
 * on screen.
 *
 * ── The defect this replaces ───────────────────────────────────────────────
 * Until now `app.ts` built the view from a localStorage cache written by a
 * DIFFERENT screen, with this fallback when nothing had been picked:
 *
 *     section: { id: 'demo-section', labelBn: '৯-ক', academicYearId: 'yr-2026' }
 *
 * A teacher who opened হাজিরা before ever visiting the roster got an empty
 * grid labelled "৯-ক" — a real-looking class that does not exist — and any
 * save was rejected by sync, because `yr-2026` is not a uuid. The screen said
 * "১টি পাঠানো যায়নি" and nothing said why. That is now impossible: the screen
 * asks the server which sections this teacher has, and if the answer is none
 * it says so.
 *
 * ── The states §"ATTENDANCE" names, and where each lives ───────────────────
 *   1 loading        · this module — skeleton while sections/roster load
 *   2 empty          · this module — no sections, or a section with no students
 *   3 loaded         · AttendanceView's grid
 *   4 saving         · the save button's busy state (P2 `onClickBusy`)
 *   5 saved          · the "সংরক্ষিত" snackbar + the chip
 *   6 offline        · the shell banner + an explicit line in the status strip
 *   7 queued         · the sync chip, with the count
 *   8 syncing        · the chip, while a flush is in flight
 *   9 sync failed    · the chip + a RETRY button that did not exist
 *  10 retry          · this module — `outbox.flush()` on demand
 *  11 permission     · this module — 403 from sections/roster
 *  12 error          · this module — anything else, through `humanError`
 *  13 success        · the snackbar, and the chip returning to "সিঙ্ক হয়েছে"
 *
 * ── What the teacher must always be able to see ────────────────────────────
 * Section · date · subject/period · student count · **how many marked** ·
 * whether saved · whether only queued locally. The status strip below carries
 * all seven, in words. Colour never carries any of them alone.
 */
import type { Auth } from './auth.ts';
import type { SectionSummary as RosterSectionSummary } from './roster-view.ts';
import type { Student } from '../../../packages/ui-core/src/attendance-grid.ts';
import { AttendanceView, type OutboxLike } from './attendance-view.ts';
import {
  el, append, icon, button, pageHeader, field, emptyState, errorState,
  permissionState, listSkeleton, humanError, announce, toast, badge,
} from './ui/index.ts';
import { formatCount } from '../../../packages/ui-core/src/format.ts';

/**
 * The real shape of `GET /academics/sections`, reused rather than re-guessed.
 *
 * The first cut of this screen assumed `{ labelBn, classLabelBn }` and got an
 * empty section picker with three blank options — the browser found it in
 * about ten seconds, and no type would have, because the response is parsed
 * from JSON. The label is composed the way roster-view.ts composes it, so the
 * two screens name the same section identically.
 */
type SectionSummary = RosterSectionSummary;

/** `নবম শ্রেণি — ক`. One spelling of a section, in both screens. */
function sectionLabel(s: SectionSummary): string {
  return `${s.className?.bn ?? ''} — ${s.name}`.replace(/^ — /, '');
}

interface RosterStudent {
  studentId: string;
  rollNo: number;
  nameBn: string;
  nameEn?: string | null;
}

export interface AttendanceScreenOptions {
  root: HTMLElement;
  doc: Document;
  auth: Auth;
  outbox: OutboxLike;
  newId: () => string;
  /** Today, as YYYY-MM-DD in the school's local day. */
  takenOn: string;
  subjectBn?: string;
  periodNo?: number | null;
  now?: () => number;
}

type Phase = 'loading' | 'ready' | 'empty' | 'error' | 'denied';

const LAST_SECTION_KEY = 'shikhon_last_section';
const SECTIONS_CACHE = 'shikhon_sections_cache';
const rosterCache = (id: string): string => `shikhon_roster_cache_${id}`;

export class AttendanceScreen {
  private readonly o: AttendanceScreenOptions;
  private phase: Phase = 'loading';
  private sections: SectionSummary[] = [];
  private sectionId: string | null = null;
  private roster: RosterStudent[] = [];
  private errText = '';
  private view: AttendanceView | null = null;
  private gridHost!: HTMLElement;
  private statusHost!: HTMLElement;
  private saveBtn: HTMLButtonElement | null = null;
  private marked = 0;
  private onConnectivity?: () => void;

  constructor(options: AttendanceScreenOptions) {
    this.o = options;
    this.render();
    void this.boot();
    // The status strip says "offline — কাজ চালিয়ে যান" in words. It listens
    // for itself rather than reading a flag once, because the interesting
    // transition is the one that happens WHILE the register is open.
    this.onConnectivity = () => this.paintStatus();
    addEventListener('online', this.onConnectivity);
    addEventListener('offline', this.onConnectivity);
  }

  destroy(): void {
    if (this.onConnectivity) {
      removeEventListener('online', this.onConnectivity);
      removeEventListener('offline', this.onConnectivity);
    }
  }

  /* ── data ───────────────────────────────────────────────────────────── */

  private async boot(): Promise<void> {
    const cachedSections = read<SectionSummary[]>(SECTIONS_CACHE) ?? [];
    if (cachedSections.length) this.sections = cachedSections;

    try {
      const res = await this.o.auth.authedFetch('/api/v1/academics/sections');
      if (res.status === 403) { this.phase = 'denied'; this.render(); return; }
      if (!res.ok) throw new Status(res.status);
      const body = (await res.json()) as { sections: SectionSummary[] };
      this.sections = body.sections ?? [];
      write(SECTIONS_CACHE, this.sections);
    } catch (err) {
      if (!this.sections.length) {
        this.phase = 'error';
        this.errText = humanError(navigator.onLine ? null : 'offline',
          err instanceof Status ? err.status : undefined);
        this.render();
        return;
      }
      // Cached sections are enough to take a register offline, which is the
      // entire point of this screen.
    }

    if (!this.sections.length) { this.phase = 'empty'; this.render(); return; }

    const remembered = safeGet(LAST_SECTION_KEY);
    this.sectionId = this.sections.some((s) => s.id === remembered)
      ? remembered
      : this.sections[0].id;
    await this.loadRoster(this.sectionId!);
  }

  private async loadRoster(sectionId: string): Promise<void> {
    this.phase = 'loading';
    this.render();

    const cached = read<RosterStudent[]>(rosterCache(sectionId));
    if (cached?.length) this.roster = cached;

    try {
      const res = await this.o.auth.authedFetch(
        `/api/v1/academics/roster?sectionId=${encodeURIComponent(sectionId)}`);
      if (res.status === 403) { this.phase = 'denied'; this.render(); return; }
      if (!res.ok) throw new Status(res.status);
      const body = (await res.json()) as { roster: RosterStudent[] };
      this.roster = body.roster ?? [];
      write(rosterCache(sectionId), this.roster);
      safeSet(LAST_SECTION_KEY, sectionId);
    } catch (err) {
      if (!this.roster.length) {
        this.phase = 'error';
        this.errText = humanError(navigator.onLine ? null : 'offline',
          err instanceof Status ? err.status : undefined);
        this.render();
        return;
      }
    }

    this.phase = this.roster.length ? 'ready' : 'empty';
    this.render();
  }

  private section(): SectionSummary | null {
    return this.sections.find((s) => s.id === this.sectionId) ?? null;
  }

  /* ── render ─────────────────────────────────────────────────────────── */

  private render(): void {
    const d = this.o.doc;
    const root = this.o.root;
    root.textContent = '';
    this.view = null;
    this.saveBtn = null;

    const sec = this.section();
    append(root, pageHeader(d, {
      title: 'হাজিরা',
      subtitle: sec
        ? 'আজকের ক্লাসের উপস্থিতি নিন — অফলাইনেও কাজ করে, সংযোগ পেলে নিজেই জমা হয়।'
        : 'শ্রেণির উপস্থিতি নিন।',
      actions: this.sections.length > 1 ? [this.sectionPicker()] : [],
    }));

    switch (this.phase) {
      case 'loading':
        append(root, listSkeleton(d, 6));
        return;

      case 'denied':
        append(root, permissionState(d, {
          message: 'এই সেকশনের হাজিরা নেওয়ার অনুমতি আপনার নেই।',
          contact: 'প্রধান শিক্ষক',
        }));
        return;

      case 'error':
        append(root, errorState(d, this.errText, () => { void this.boot(); }));
        return;

      case 'empty':
        append(root, this.sections.length
          ? emptyState(d, {
              // Named, and with the way out. "No data" on a screen a teacher
              // opened to take a register is a dead end.
              message: `${sec ? sectionLabel(sec) : 'এই সেকশনে'}-তে এখনো কোনো শিক্ষার্থী ভর্তি হয়নি।`
                + ' শিক্ষার্থী যোগ করার পর হাজিরা নেওয়া যাবে।',
              action: { label: 'শিক্ষার্থী তালিকা দেখুন',
                        onClick: () => { location.hash = '/roster'; } },
            })
          : emptyState(d, {
              message: 'আপনার নামে কোনো সেকশন নির্ধারিত নেই, তাই হাজিরা নেওয়ার কিছু নেই।',
              action: { label: 'রুটিন দেখুন', onClick: () => { location.hash = '/routine'; } },
            }));
        return;

      case 'ready':
        break;
    }

    // The status strip: section · date · subject · count · marked · saved.
    this.statusHost = el(d, 'div', { className: 'att-status', attrs: { 'aria-live': 'polite' } });
    append(root, this.statusHost);

    this.gridHost = el(d, 'div', { className: 'att-host' });
    append(root, this.gridHost);

    this.view = new AttendanceView({
      root: this.gridHost,
      doc: d,
      students: this.roster.map(toStudent),
      section: {
        id: sec!.id,
        labelBn: sectionLabel(sec!),
        academicYearId: sec!.academicYearId,
      },
      takenOn: this.o.takenOn,
      periodNo: this.o.periodNo ?? null,
      subjectBn: this.o.subjectBn,
      outbox: this.o.outbox,
      newId: this.o.newId,
      now: this.o.now,
      embedded: true,
    });

    this.adoptSaveButton();
    this.watchMarks();
    this.paintStatus();
  }

  private sectionPicker(): HTMLElement {
    const f = field(this.o.doc, {
      label: 'সেকশন',
      name: 'section',
      kind: 'select',
      value: this.sectionId ?? '',
      options: this.sections.map((x) => ({ value: x.id, label: sectionLabel(x) })),
      onChange: (v) => {
        this.sectionId = v;
        void this.loadRoster(v);
      },
      className: 'att-section-picker',
    });
    return f.root;
  }

  /**
   * Give the grid's save button a busy state and a single-flight guard.
   *
   * Done by adopting the existing button rather than by changing
   * `AttendanceView.save()`: the save path stays exactly the code that has
   * been tested since R-0, and the double-submit guard §17 requires is added
   * around it. Two taps on a slow phone used to enqueue two sessions with two
   * different opIds for the same register.
   */
  private adoptSaveButton(): void {
    const btn = this.gridHost.querySelector<HTMLButtonElement>('button[data-action="save"]');
    if (!btn || !this.view) return;
    this.saveBtn = btn;
    const clone = btn.cloneNode(true) as HTMLButtonElement;   // drops the old listener
    btn.replaceWith(clone);
    this.saveBtn = clone;
    clone.classList.add('ui-btn', 'btn-block');

    let busy = false;
    clone.addEventListener('click', async () => {
      if (busy) return;
      busy = true;
      clone.disabled = true;
      clone.setAttribute('aria-busy', 'true');
      try {
        const result = await this.view!.save();
        this.paintStatus();
        // Says which state it reached, in words: saved locally is not the
        // same promise as delivered, and on this network the difference is
        // the whole day's work.
        toast(this.o.doc, {
          message: navigator.onLine
            ? 'হাজিরা সংরক্ষিত — জমা হচ্ছে'
            : 'হাজিরা এই যন্ত্রে সংরক্ষিত — সংযোগ পেলে নিজেই জমা হবে',
          tone: 'success',
        });
        await result.flushed;
        void this.view!.paintChip();
        this.paintStatus();
      } catch (err) {
        // Enqueue itself failing means IndexedDB refused — genuinely rare and
        // genuinely fatal to this register, so it is said plainly and the
        // marks stay on screen to be saved again.
        toast(this.o.doc, {
          message: 'হাজিরা সংরক্ষণ করা যায়নি। আবার চেষ্টা করুন।',
          tone: 'error',
        });
        console.error('[attendance] enqueue failed', err);
      } finally {
        busy = false;
        clone.disabled = false;
        clone.removeAttribute('aria-busy');
      }
    });
  }

  /**
   * How many the teacher has actually decided about.
   *
   * NOT a count of tiles with a status: `AttendanceGrid` starts every student
   * at `present`, so that number is the class size from the first frame and
   * would be a reassuring lie. `touched` is the honest measure — the students
   * whose status this teacher has set by hand — and it is labelled "হাতে
   * চিহ্নিত" rather than "চিহ্নিত" so it cannot be read as "the register is
   * only half done". The authoritative tally stays the grid's own
   * present/absent/late counters, which have been there since R-0.
   */
  private watchMarks(): void {
    const recount = () => {
      const snap = this.view?.state;
      if (!snap) return;
      const n = snap.entries.filter((e) => e.touched).length;
      if (n !== this.marked) { this.marked = n; this.paintStatus(); }
    };
    this.gridHost.addEventListener('click', () => setTimeout(recount, 0));
    this.gridHost.addEventListener('keyup', () => setTimeout(recount, 0));
    recount();
  }

  /**
   * The seven facts, in words.
   *
   * §"The teacher must always know: what section, what date, what
   * subject/period, how many students, how many marked, whether changes are
   * saved, whether changes are only queued locally." Colour echoes; the text
   * carries.
   */
  private paintStatus(): void {
    if (!this.statusHost) return;
    const d = this.o.doc;
    const sec = this.section();
    this.statusHost.textContent = '';

    const facts = el(d, 'div', { className: 'att-facts' });
    const fact = (label: string, value: string) => {
      append(facts, el(d, 'span', { className: 'att-fact' },
        el(d, 'span', { className: 'att-fact-label', text: label }),
        el(d, 'span', { className: 'att-fact-value', text: value })));
    };
    fact('সেকশন', sec ? sectionLabel(sec) : '—');
    fact('তারিখ', bnDate(this.o.takenOn));
    if (this.o.subjectBn) fact('বিষয়', this.o.subjectBn);
    if (this.o.periodNo != null) fact('পিরিয়ড', formatCount(this.o.periodNo, 'bn'));
    fact('শিক্ষার্থী', `${formatCount(this.roster.length, 'bn')} জন`);
    fact('হাতে চিহ্নিত', `${formatCount(this.marked, 'bn')} / ${formatCount(this.roster.length, 'bn')}`);
    append(this.statusHost, facts);

    if (!navigator.onLine) {
      append(this.statusHost, el(d, 'p', { className: 'att-offline-note' },
        icon(d, 'wifi-off', 'att-offline-glyph'),
        el(d, 'span', {
          text: 'এখন অফলাইন — হাজিরা নিন, এই যন্ত্রে জমা থাকবে এবং সংযোগ পেলে নিজেই পাঠানো হবে।',
        })));
    }
    void this.paintSync();
  }

  /**
   * The sync line, and the retry that never existed.
   *
   * The chip in the grid's header has said "৩টি পাঠানো যায়নি" since R-0 with
   * no way to act on it — a teacher reading it could only reload and hope.
   */
  private async paintSync(): Promise<void> {
    const d = this.o.doc;
    const old = this.statusHost.querySelector('.att-sync-line');
    old?.remove();
    let s: { pending: number; failed: number };
    try { s = await this.o.outbox.state(); } catch { return; }
    if (s.pending === 0 && s.failed === 0) return;

    const line = el(d, 'p', { className: 'att-sync-line', data: { state: s.failed ? 'failed' : 'queued' } });
    append(line, badge(d, {
      label: s.failed
        ? `${formatCount(s.failed, 'bn')}টি পাঠানো যায়নি`
        : `${formatCount(s.pending, 'bn')}টি অপেক্ষমাণ`,
      tone: s.failed ? 'danger' : 'warn',
      glyph: s.failed ? 'alert-triangle' : 'clock',
    }));
    append(line, el(d, 'span', {
      className: 'att-sync-text',
      text: s.failed
        ? 'কিছু হাজিরা সার্ভারে পৌঁছায়নি। তথ্য এই যন্ত্রে নিরাপদ আছে।'
        : 'হাজিরা এই যন্ত্রে জমা আছে, পাঠানো হচ্ছে।',
    }));
    append(line, button(d, {
      label: 'আবার পাঠান', variant: 'secondary', size: 'sm', glyph: 'refresh',
      onClick: async () => {
        announce(d, 'আবার পাঠানোর চেষ্টা হচ্ছে');
        try { await this.o.outbox.flush(); } catch { /* stays queued */ }
        void this.view?.paintChip();
        this.paintStatus();
      },
    }));
    append(this.statusHost, line);
  }

  /** Test seam. */
  get inner(): AttendanceView | null { return this.view; }
}

function toStudent(r: RosterStudent): Student {
  return { studentId: r.studentId, rollNo: r.rollNo, nameBn: r.nameBn,
           nameEn: r.nameEn ?? undefined };
}

// No constructor parameter property: Node runs this repo's TypeScript in
// STRIP-ONLY mode, which rejects `constructor(public x)` outright. `tsc`
// accepts it, so the type gate is silent and only the test runner fails.
class Status extends Error {
  readonly status: number;
  constructor(status: number) { super(`http_${status}`); this.status = status; }
}

function read<T>(key: string): T | null {
  try { const raw = localStorage.getItem(key); return raw ? (JSON.parse(raw) as T) : null; }
  catch { return null; }
}
function write(key: string, value: unknown): void {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* quota */ }
}
function safeGet(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}
function safeSet(key: string, value: string): void {
  try { localStorage.setItem(key, value); } catch { /* quota */ }
}

const MONTHS_BN = ['জানুয়ারি', 'ফেব্রুয়ারি', 'মার্চ', 'এপ্রিল', 'মে', 'জুন', 'জুলাই',
  'আগস্ট', 'সেপ্টেম্বর', 'অক্টোবর', 'নভেম্বর', 'ডিসেম্বর'];

function bnDate(iso: string): string {
  const [y, m, dd] = iso.split('-').map(Number);
  if (!y || !m || !dd) return iso;
  return `${formatCount(dd, 'bn')} ${MONTHS_BN[m - 1]} ${formatCount(y, 'bn')}`;
}
