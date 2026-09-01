/**
 * Guardian home — F-1001, F-1002, F-203, wireframe §9.1
 *
 *   [☰] শিখন      [ আনিকা ▾ ]         [1]
 *   আনিকা রহমান · নবম–ক · রোল ০১
 *   ┌ আজকের হাজিরা ┬ বকেয়া ফি ┐
 *   │ ✓ উপস্থিত     │ ৳ ২,৫০০ │
 *   │ এ মাসে ৯৪%    │ ১৫ আগস্ট  │
 *   ফলাফল প্রকাশিত — ১ম সাময়িক · GPA 4.56 · মেধাক্রম ৭/৫২
 *   [        ফি পরিশোধ করুন        ]
 *
 * §9.1's rule is a warning about the reader, not the data: "This persona
 * has the lowest technical comfort in the product and may use the app four
 * times a year — it must survive being forgotten."
 *
 * Everything here follows from that sentence.
 *
 * The switcher is in the header and never scrolls away — §9.1 calls it
 * "the single most-used control here". It renders even while the child's
 * detail is still loading, so the first thing on screen is the thing the
 * guardian came to change.
 *
 * Three cards, in the order §9.1 draws them: attendance, fees, results.
 * Not content. A guardian is not a second student, and a syllabus tracker
 * would bury the three things they opened the app for.
 *
 * Every state carries a word. "✓ উপস্থিত" not a green dot; "৩ দিন বাকি" not
 * an amber border. Somebody who opens this four times a year has no
 * memory of what the colours meant last time.
 *
 * Framework-free manual DOM, same as every other view here.
 */
import type { Auth } from './auth.ts';
import { formatCount, formatIdentifier, formatBdt, formatDayMonth }
  from '../../../packages/ui-core/src/format.ts';
import {
  el, append, card, statCard, statRow, button, pageHeader, sectionHeading,
  statusBadge, listSkeleton, emptyState, errorState, humanError,
} from './ui/index.ts';
import { childSelector, childIdentity, type ChildOption } from './ui/child-selector.ts';

const bn = (n: number): string => formatCount(n, 'bn');

export interface WardSummary {
  studentId: string;
  nameBn: string;
  sectionLabel: string;
  rollNo: number;
  relationBn: string;
}

export interface WardHome extends WardSummary {
  attendance: {
    todayStatus: string | null;
    monthPercent: number | null;
    present: number; absent: number; late: number; halfDay: number; excused: number;
  };
  fees: { outstanding: number; earliestDue: string | null; overdueCount: number };
  result: {
    examNameBn: string; gpa: number | null;
    rankInSection: number | null; sectionSize: number | null;
  } | null;
}

export interface GuardianViewOptions {
  root: HTMLElement;
  doc: Document;
  auth: Auth;
  /** Navigates to the fee screen. §9.1: payment is one tap from home. */
  onOpenFees?: (studentId: string) => void;
  /** Navigates to the published mark sheet. */
  onOpenResults?: (studentId: string) => void;
}

/** Attendance states, each with a glyph AND a word (F-812). */
const TODAY: Record<string, { glyph: string; labelBn: string; tone: string }> = {
  present:  { glyph: '✓', labelBn: 'উপস্থিত',      tone: 'ok' },
  late:     { glyph: '◔', labelBn: 'দেরিতে এসেছে',  tone: 'warn' },
  half_day: { glyph: '◑', labelBn: 'অর্ধদিবস',      tone: 'warn' },
  absent:   { glyph: '✗', labelBn: 'অনুপস্থিত',     tone: 'danger' },
  excused:  { glyph: '⌾', labelBn: 'ছুটি মঞ্জুর',   tone: 'muted' },
};

const ENDPOINT = '/api/v1/academics/ward';
const CACHE_KEY = 'shikhon_guardian_home';

export class GuardianView {
  private readonly o: GuardianViewOptions;
  private wards: WardSummary[] = [];
  private selected: string | null = null;
  private home: WardHome | null = null;
  private loading = true;
  private offline = false;
  private error = false;

  constructor(options: GuardianViewOptions) {
    this.o = options;
    // Cache first. This persona is the likeliest to open the app on a
    // borrowed phone with a bad connection, and a blank screen would be
    // read as "the school has nothing for me".
    const cached = this.readCache();
    if (cached) {
      this.wards = cached.wards;
      this.home = cached.home;
      this.selected = cached.home?.studentId ?? cached.wards[0]?.studentId ?? null;
      this.loading = false;
    }
    this.render();
    void this.load();
  }

  private readCache(): { wards: WardSummary[]; home: WardHome | null } | null {
    try {
      const raw = localStorage.getItem(CACHE_KEY);
      return raw ? (JSON.parse(raw) as { wards: WardSummary[]; home: WardHome | null }) : null;
    } catch {
      return null;
    }
  }

  private async load(studentId?: string): Promise<void> {
    const target = studentId ?? this.selected;
    try {
      const res = await this.o.auth.authedFetch(
        target ? `${ENDPOINT}?studentId=${encodeURIComponent(target)}` : ENDPOINT);
      if (!res.ok) throw new Error(String(res.status));
      const body = (await res.json()) as { wards: WardSummary[]; student: WardHome | null };
      this.wards = body.wards;
      this.home = body.student;
      this.offline = false;
      this.error = false;

      // With no child chosen the first request only returns the list, so
      // pick one and fetch it. A guardian with one child must never have
      // to choose it.
      if (!body.student && body.wards.length > 0) {
        this.selected = body.wards[0].studentId;
        this.loading = true;
        this.render();
        await this.load(this.selected);
        return;
      }
      this.selected = body.student?.studentId ?? null;
      try {
        localStorage.setItem(CACHE_KEY, JSON.stringify({ wards: this.wards, home: this.home }));
      } catch { /* quota */ }
    } catch {
      // Cached data plus a banner beats an error page: last week's
      // attendance is still worth reading, and the fee balance changes
      // slowly.
      if (this.home) this.offline = true;
      else this.error = true;
    } finally {
      this.loading = false;
      this.render();
    }
  }

  private select(studentId: string): void {
    if (studentId === this.selected) return;
    this.selected = studentId;
    this.home = null;
    this.loading = true;
    this.render();
    void this.load(studentId);
  }

  // ── rendering ───────────────────────────────────────────────────────
  private render(): void {
    const d = this.o.doc;
    const root = this.o.root;
    root.textContent = '';
    root.setAttribute('lang', 'bn');

    append(root, pageHeader(d, {
      title: 'আমার সন্তান',
      subtitle: 'আজকের হাজিরা, ফলাফল ও বকেয়া ফি — এক নজরে।',
    }));

    // The selector first and always, even mid-load: §9.1 calls it "the single
    // most-used control here", and it is what the guardian opened the app to
    // use. It renders nothing at all for a single child — a control with one
    // option teaches people their tap did nothing.
    append(root, childSelector(d, {
      children: this.wards.map(toChildOption),
      selectedId: this.selected,
      onSelect: (id) => this.select(id),
    }));

    if (this.error) {
      append(root, errorState(d, humanError(navigator.onLine ? null : 'offline'), () => {
        this.error = false; this.loading = true; this.render(); void this.load();
      }));
      return;
    }
    if (this.offline) {
      // Cached data plus a sentence beats an error page: last week's
      // attendance is still worth reading and the fee balance changes slowly.
      append(root, el(d, 'p', { className: 'att-offline-note' },
        el(d, 'span', {
          text: 'অফলাইন — সর্বশেষ সংরক্ষিত তথ্য দেখানো হচ্ছে। সংযোগ পেলে নিজেই হালনাগাদ হবে।',
        })));
    }

    if (this.loading && !this.home) { append(root, listSkeleton(d, 3)); return; }
    if (!this.home) {
      append(root, emptyState(d, {
        // Says what to do. A guardian whose child is not linked cannot fix it
        // from this screen, and pretending otherwise wastes their afternoon.
        message: 'আপনার সাথে কোনো শিক্ষার্থী যুক্ত নেই। বিদ্যালয়ের অফিসে যোগাযোগ করুন।',
      }));
      return;
    }

    append(root,
      childIdentity(d, toChildOption(this.home)),
      this.cards(this.home),
      this.home.result ? this.resultCard(this.home) : null,
      this.payCta(this.home));
  }

  private cards(h: WardHome): HTMLElement {
    const d = this.o.doc;
    const state = TODAY[h.attendance.todayStatus ?? ''] ?? null;
    const owed = h.fees.outstanding;

    // Two numbers, in the order §9.1 draws them. Never a bare glyph:
    // somebody opening this four times a year does not remember what a green
    // tick meant, so the word is the message and the glyph is the echo.
    return statRow(d,
      statCard(d, {
        label: 'আজকের হাজিরা',
        value: state ? `${state.glyph} ${state.labelBn}` : 'আজ হাজিরা নেওয়া হয়নি',
        note: h.attendance.monthPercent === null
          ? 'এ মাসের হিসাব নেই'
          : `এ মাসে ${bn(h.attendance.monthPercent)}%`,
        glyph: 'check-square',
        tone: state?.tone === 'ok' ? 'success'
          : state?.tone === 'danger' ? 'warn'
          : state?.tone === 'warn' ? 'warn' : 'info',
      }),
      statCard(d, {
        label: 'বকেয়া ফি',
        value: owed === 0 ? '✓ বকেয়া নেই' : formatBdt(owed),
        note: owed === 0
          ? 'সব পরিশোধিত'
          : h.fees.overdueCount > 0
            ? `${bn(h.fees.overdueCount)}টি বিল সময় পেরিয়েছে`
            : h.fees.earliestDue
              ? `${formatDayMonth(h.fees.earliestDue, 'bn')} শেষ তারিখ`
              : '',
        glyph: 'wallet',
        tone: owed === 0 ? 'success' : h.fees.overdueCount > 0 ? 'warn' : 'accent2',
        onClick: this.o.onOpenFees ? () => this.o.onOpenFees?.(h.studentId) : undefined,
      }));
  }

  private resultCard(h: WardHome): HTMLElement {
    const d = this.o.doc;
    const r = h.result as NonNullable<WardHome['result']>;
    const parts: string[] = [];
    if (r.gpa !== null) parts.push(`GPA ${r.gpa.toFixed(2)}`);
    // A rank without its cohort is a number a guardian cannot read. §9.1
    // draws "মেধাক্রম ৭/৫২" for exactly that reason.
    if (r.rankInSection !== null && r.sectionSize !== null) {
      parts.push(`মেধাক্রম ${bn(r.rankInSection)}/${bn(r.sectionSize)}`);
    }
    return card(d, {
      title: r.examNameBn,
      subtitle: parts.join(' · '),
      glyph: 'award',
      tone: 'accent2',
      // Published is the only result a guardian ever sees — the endpoint
      // returns nothing else — and saying so removes the question. It sits in
      // the card's action slot beside the button rather than needing a new
      // `badge` option: one slot, two things, no component change.
      action: el(d, 'div', { className: 'ward-result-actions' },
        statusBadge(d, { state: 'published', label: 'প্রকাশিত' }),
        this.o.onOpenResults
          ? button(d, {
              label: 'মার্কশিট দেখুন', variant: 'secondary', size: 'sm',
              onClick: () => this.o.onOpenResults?.(h.studentId),
            })
          : null),
    });
  }

  private payCta(h: WardHome): HTMLElement {
    const d = this.o.doc;
    // §9.1 labels this "বিকাশে ফি পরিশোধ করুন". MFS checkout (F-1005) is not
    // built, so naming bKash here would promise a flow that does not exist.
    // This opens the fee screen, which does — one tap from home, as §9.1
    // requires, without the lie.
    return el(d, 'div', { className: 'ward-cta' },
      button(d, {
        label: h.fees.outstanding > 0 ? 'ফি পরিশোধ করুন' : 'ফি ও রসিদ দেখুন',
        variant: 'primary', block: true, glyph: 'wallet',
        disabled: !this.o.onOpenFees,
        onClick: () => this.o.onOpenFees?.(h.studentId),
      }));
  }

}

/**
 * A ward summary as the selector's option.
 *
 * One mapping, used by the selector, the identity block and the sheet, so the
 * three cannot name the same child differently — which is the specific way a
 * "which child am I looking at" bug appears.
 */
function toChildOption(w: WardSummary): ChildOption {
  return {
    studentId: w.studentId,
    nameBn: w.nameBn,
    sectionLabel: w.sectionLabel,
    rollNo: w.rollNo,
    relationBn: w.relationBn,
  };
}
