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

    // The switcher first and always, even mid-load — it is what the
    // guardian came to use.
    if (this.wards.length > 1) root.append(this.switcher());

    if (this.error) { root.append(this.errorState()); return; }
    if (this.offline) root.append(this.banner('অফলাইন — সর্বশেষ সংরক্ষিত তথ্য'));

    if (this.loading && !this.home) { root.append(this.skeleton()); return; }
    if (!this.home) { root.append(this.emptyState()); return; }

    root.append(this.identity(this.home));
    root.append(this.cards(this.home));
    if (this.home.result) root.append(this.resultCard(this.home));
    root.append(this.payCta(this.home));
  }

  private switcher(): HTMLElement {
    const d = this.o.doc;
    const bar = d.createElement('div');
    bar.className = 'seg-bar ward-switcher';
    bar.setAttribute('role', 'tablist');
    bar.setAttribute('aria-label', 'সন্তান নির্বাচন');
    for (const w of this.wards) {
      const b = d.createElement('button');
      b.type = 'button';
      b.className = 'seg-opt';
      b.setAttribute('role', 'tab');
      b.setAttribute('aria-selected', String(w.studentId === this.selected));
      b.dataset.active = String(w.studentId === this.selected);
      b.textContent = w.nameBn;
      b.addEventListener('click', () => { this.select(w.studentId); });
      bar.append(b);
    }
    return bar;
  }

  private identity(h: WardHome): HTMLElement {
    const d = this.o.doc;
    const box = d.createElement('header');
    box.className = 'page-header ward-identity';
    const h1 = d.createElement('h1');
    h1.textContent = h.nameBn;
    const sub = d.createElement('p');
    sub.className = 'page-sub';
    // The roll number stays in Latin digits: it is an identifier, and it
    // is what a guardian reads out on the phone to the school office.
    sub.textContent = `${h.sectionLabel} · রোল ${formatIdentifier(h.rollNo)}`;
    box.append(h1, sub);
    return box;
  }

  private cards(h: WardHome): HTMLElement {
    const d = this.o.doc;
    const grid = d.createElement('div');
    grid.className = 'ward-grid';

    // ── attendance
    const att = d.createElement('section');
    att.className = 'card ward-card';
    const attHead = d.createElement('h2');
    attHead.className = 'ward-card-head';
    attHead.textContent = 'আজকের হাজিরা';
    att.append(attHead);

    const state = TODAY[h.attendance.todayStatus ?? ''] ?? null;
    const attMain = d.createElement('p');
    attMain.className = 'ward-card-main';
    attMain.dataset.tone = state?.tone ?? 'muted';
    // Never a bare glyph. Somebody opening this four times a year does not
    // remember what a green tick meant.
    attMain.textContent = state
      ? `${state.glyph} ${state.labelBn}`
      : 'আজ হাজিরা নেওয়া হয়নি';
    att.append(attMain);

    const attSub = d.createElement('p');
    attSub.className = 'ward-card-sub';
    attSub.textContent = h.attendance.monthPercent === null
      ? 'এ মাসের হিসাব নেই'
      : `এ মাসে ${bn(h.attendance.monthPercent)}%`;
    att.append(attSub);
    grid.append(att);

    // ── fees
    const fee = d.createElement('section');
    fee.className = 'card ward-card';
    const feeHead = d.createElement('h2');
    feeHead.className = 'ward-card-head';
    feeHead.textContent = 'বকেয়া ফি';
    fee.append(feeHead);

    const owed = h.fees.outstanding;
    const feeMain = d.createElement('p');
    feeMain.className = 'ward-card-main';
    feeMain.dataset.tone = owed === 0 ? 'ok' : h.fees.overdueCount > 0 ? 'danger' : 'warn';
    feeMain.textContent = owed === 0 ? '✓ বকেয়া নেই' : `${formatBdt(owed)} `;
    fee.append(feeMain);

    const feeSub = d.createElement('p');
    feeSub.className = 'ward-card-sub';
    feeSub.textContent = owed === 0
      ? 'সব পরিশোধিত'
      : h.fees.overdueCount > 0
        ? `${bn(h.fees.overdueCount)}টি বিল সময় পেরিয়েছে`
        : h.fees.earliestDue
          ? `${formatDayMonth(h.fees.earliestDue, 'bn')} শেষ তারিখ`
          : '';
    fee.append(feeSub);
    grid.append(fee);

    return grid;
  }

  private resultCard(h: WardHome): HTMLElement {
    const d = this.o.doc;
    const r = h.result as NonNullable<WardHome['result']>;
    const card = d.createElement('section');
    card.className = 'card ward-result';

    const head = d.createElement('h2');
    head.className = 'ward-card-head';
    head.textContent = `ফলাফল প্রকাশিত — ${r.examNameBn}`;
    card.append(head);

    const line = d.createElement('p');
    line.className = 'ward-result-line';
    const parts: string[] = [];
    if (r.gpa !== null) parts.push(`GPA ${r.gpa.toFixed(2)}`);
    // A rank without its cohort is a number a guardian cannot read. §9.1
    // draws "মেধাক্রম ৭/৫২" for exactly that reason.
    if (r.rankInSection !== null && r.sectionSize !== null) {
      parts.push(`মেধাক্রম ${bn(r.rankInSection)}/${bn(r.sectionSize)}`);
    }
    line.textContent = parts.join(' · ');
    card.append(line);

    if (this.o.onOpenResults) {
      const btn = d.createElement('button');
      btn.type = 'button';
      btn.className = 'btn-secondary';
      btn.textContent = 'মার্কশিট দেখুন';
      btn.addEventListener('click', () => { this.o.onOpenResults?.(h.studentId); });
      card.append(btn);
    }
    return card;
  }

  private payCta(h: WardHome): HTMLElement {
    const d = this.o.doc;
    const wrap = d.createElement('div');
    wrap.className = 'ward-cta';
    const btn = d.createElement('button');
    btn.type = 'button';
    btn.className = 'btn-primary';
    // §9.1 labels this "বিকাশে ফি পরিশোধ করুন". MFS checkout (F-1005) is
    // not built, so naming bKash here would promise a flow that does not
    // exist. This opens the fee screen, which does — one tap from home,
    // as §9.1 requires, without the lie.
    btn.textContent = h.fees.outstanding > 0 ? 'ফি পরিশোধ করুন' : 'ফি ও রসিদ দেখুন';
    btn.disabled = !this.o.onOpenFees;
    btn.addEventListener('click', () => { this.o.onOpenFees?.(h.studentId); });
    wrap.append(btn);
    return wrap;
  }

  private banner(text: string): HTMLElement {
    const p = this.o.doc.createElement('p');
    p.className = 'inline-notice';
    p.setAttribute('role', 'status');
    p.textContent = text;
    return p;
  }

  private skeleton(): HTMLElement {
    const d = this.o.doc;
    const box = d.createElement('div');
    box.setAttribute('aria-busy', 'true');
    box.setAttribute('aria-label', 'তথ্য লোড হচ্ছে');
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

  private emptyState(): HTMLElement {
    const d = this.o.doc;
    const box = d.createElement('div');
    box.className = 'empty-state';
    const glyph = d.createElement('div');
    glyph.className = 'empty-glyph';
    glyph.textContent = '⃝';
    glyph.setAttribute('aria-hidden', 'true');
    const msg = d.createElement('p');
    // Says what to do. A guardian whose child is not linked cannot fix it
    // from this screen, and pretending otherwise wastes their afternoon.
    msg.textContent = 'আপনার সাথে কোনো শিক্ষার্থী যুক্ত নেই। বিদ্যালয়ের অফিসে যোগাযোগ করুন।';
    box.append(glyph, msg);
    return box;
  }

  private errorState(): HTMLElement {
    const d = this.o.doc;
    const box = d.createElement('div');
    box.className = 'empty-state';
    const glyph = d.createElement('div');
    glyph.className = 'empty-glyph';
    // U+2715 — no emoji form, so it takes the ink and cannot be stripped by
    // an emoji sweep the way the warning sign that used to sit here was.
    glyph.textContent = '✕';
    glyph.setAttribute('aria-hidden', 'true');
    const msg = d.createElement('p');
    msg.textContent = 'তথ্য লোড হয়নি।';
    const retry = d.createElement('button');
    retry.type = 'button';
    retry.className = 'btn-secondary';
    retry.textContent = 'আবার চেষ্টা করুন';
    retry.addEventListener('click', () => {
      this.error = false; this.loading = true; this.render(); void this.load();
    });
    box.append(glyph, msg, retry);
    return box;
  }
}
