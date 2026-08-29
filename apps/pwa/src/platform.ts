/**
 * shikhonBD platform console — the operator's surface.  (R-7)
 *
 * Two screens and a wizard:
 *
 *     প্রতিষ্ঠান তালিকা  →  + নতুন প্রতিষ্ঠান  →  ৯ ধাপ  →  সক্রিয় করুন
 *
 * ── What this is not ────────────────────────────────────────────────────
 * It is not the tenant application with an extra role. It is a separate page,
 * a separate bundle, a separate service, a separate database role and a
 * separate credential. A school compromised end to end reaches none of it,
 * and that separation is the point rather than a side effect: this is the one
 * surface that can see more than one school.
 *
 * It is also the one surface that keeps the shikhonBD brand (D11). Everything
 * under /app is white-labelled to the institution; here the operator needs to
 * know whose tool they are holding.
 *
 * ── Credentials, and why they are pasted ────────────────────────────────
 * The operator supplies a `super_admin` token and `PLATFORM_API_KEY`. Both
 * live in `sessionStorage`, not `localStorage`: a console left open on a
 * shared laptop should not survive the tab closing. The key is never baked
 * into this bundle — §24 — it is typed by the person, held for the session,
 * and sent as a header.
 *
 * Real operator SSO belongs with R-8's credential work; until then, two
 * pasted secrets is an honest posture for a tool used by a handful of people
 * who already hold the deployment's environment.
 *
 * ── The wizard commits as it goes ───────────────────────────────────────
 * R-7.15: every step commits, so an operator can stop after step 4 and finish
 * tomorrow, and a browser crash loses nothing. Screens 1–2 are held
 * client-side because nothing exists to hold them; from screen 3 the tenant
 * row exists and every later screen writes immediately. The progress the
 * console shows is READ BACK from the server (`app.tenant_onboarding_state`),
 * never remembered locally, so an interrupted setup reports what actually
 * landed rather than what this page thought it did.
 */
import { skeleton, errorState, emptyState, bnNum, bnDate } from './view-states.ts';
import {
  INSTITUTION_TYPE_BN, institutionTypeOf, institutionTypeLabel,
  defaultsForType, LEVELS_FOR_TYPE, STREAMS_FOR_TYPE,
  type InstitutionType,
} from './institution-type.ts';

const API = '/api/v1/platform';

const STREAM_BN: Record<string, string> = {
  bangla_medium: 'বাংলা মাধ্যম',
  english_version: 'ইংরেজি ভার্সন',
  english_medium: 'ইংরেজি মাধ্যম',
  madrasah: 'মাদ্রাসা',
  technical: 'কারিগরি',
};

const LEVEL_BN: Record<string, string> = {
  primary: 'প্রাথমিক',
  junior_secondary: 'নিম্ন মাধ্যমিক',
  secondary: 'মাধ্যমিক',
  higher_secondary: 'উচ্চ মাধ্যমিক',
  combined: 'সম্মিলিত (স্কুল ও কলেজ)',
};

const STATUS_BN: Record<string, string> = {
  trial: 'ট্রায়াল', active: 'সক্রিয়', suspended: 'স্থগিত', archived: 'সংরক্ষিত',
};

/**
 * The class range each level implies.
 *
 * Screen 5 pre-fills from this and queries a mismatch rather than silently
 * accepting it — a `primary` institution asking for class 10 is a typo far
 * more often than it is a school (R-7.15, screen 5).
 */
const LEVEL_RANGE: Record<string, [number, number]> = {
  primary: [1, 5],
  junior_secondary: [6, 8],
  secondary: [6, 10],
  higher_secondary: [11, 12],
  combined: [1, 12],
};

interface TenantRow {
  id: string; slug: string; nameBn: string; nameEn: string;
  stream: string; level: string; status: string;
  planCode: string; studentCap: number; studentCount: number;
  trialEndsOn: string | null; createdAt: string;
}

/** R-8. One line of the go-live posture, as the server computes it. */
interface GoLiveCheck {
  key: string;
  labelBn: string;
  ready: boolean;
  detailBn: string;
  severity: 'blocking' | 'advisory';
}

interface OnboardingState {
  years: number; gradingBands: number; classes: number; sections: number;
  subjects: number; feeHeads: number; teachers: number; students: number;
  guardians: number; admins: number; hasBranding: boolean;
}

/** Screens 1 and 2 only. Everything later is written the moment it is entered. */
interface Draft {
  nameBn: string; nameEn: string; stream: string; level: string;
  eiin: string; district: string; addressBn: string;
  slug: string; weekendDays: number[]; shifts: string[];
  planCode: string; studentCap: number; trialEndsOn: string;
}

/**
 * Where an interrupted setup resumes.
 *
 * R-7.15 promised the wizard is resumable — "an operator can stop after step 4
 * and finish tomorrow, and a browser crash loses nothing" — and every step does
 * commit, so nothing was ever lost. What was missing was the way back IN: the
 * wizard could only be entered by "+ নতুন প্রতিষ্ঠান", which clears `tenantId`
 * and starts a different school. An operator who stopped after the academic
 * setup had no route to the imports except SQL, which is the one thing this
 * console exists to remove.
 *
 * The step is derived from the same counts the readiness checklist shows, so
 * it cannot disagree with what the operator is looking at. Screens 1–3 are
 * skipped on resume: the tenant exists, so its identity, slug and plan are
 * already written and are edited from the school's own settings, not here.
 */
export function resumeStepFor(s: {
  years: number; classes: number;
  admins: number; teachers: number; students: number;
}): number {
  // Branding is deliberately NOT a gate. `has_branding` in migration 045
  // measures `settings.branding.logoUrl`, and the wizard's branding screen
  // cannot set a logo — it collects colour, head teacher and phone, with
  // uploads left to the school's own R-1 editor (a stated R-7 limitation).
  // Resuming there would land an operator on a screen that cannot satisfy the
  // check they were sent to satisfy, every time, forever.
  if (s.years === 0) return 4;       // screen 5 — academic year
  if (s.classes === 0) return 5;     // screen 6 — classes and sections
  if (s.admins === 0) return 6;      // screen 7 — the administrator accounts
  if (s.teachers === 0) return 7;    // screen 8 — teacher import
  return 8;                          // screen 9 — student import
}

const STEPS = [
  'প্রতিষ্ঠান', 'ঠিকানা ও স্লাগ', 'প্ল্যান', 'ব্র্যান্ডিং', 'শিক্ষাবর্ষ',
  'শ্রেণি ও শাখা', 'প্রধান শিক্ষক', 'শিক্ষক আমদানি', 'শিক্ষার্থী আমদানি',
] as const;

/**
 * A slug from an English name.
 *
 * R-7.3: lowercase, runs of non-alphanumerics become one hyphen, trimmed.
 * `Monipur High School` → `monipur-high-school`. On collision the console
 * offers a DISTRICT suffix rather than a number, because this becomes the
 * school's web address and `monipur-high-2` is not a URL anyone prints on an
 * admission slip.
 */
export function slugify(name: string): string {
  return name.toLowerCase().normalize('NFKD')
    .replace(/[^\p{Letter}\p{Number}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
    .slice(0, 63);
}

class Console_ {
  private readonly doc = document;
  private readonly root: HTMLElement;

  private token = sessionStorage.getItem('shikhon_platform_token') ?? '';
  private key = sessionStorage.getItem('shikhon_platform_key') ?? '';

  private view: 'list' | 'wizard' | 'detail' | 'readiness' = 'list';
  private tenants: TenantRow[] = [];
  private loading = false;
  private error = '';
  private notice = '';
  private search = '';

  private step = 0;
  /**
   * Admin accounts created in this wizard run, WITH their activation codes.
   *
   * The codes are held here for the length of the operator's session and
   * nowhere else — the server stores only an HMAC and will never show one
   * again. Keeping the list is what stops the second account's code being
   * destroyed by the third: `activationCode` alone held exactly one, so
   * creating a principal and then an IT admin displayed one code and silently
   * dropped the other.
   */
  private adminsMade: Array<{
    nameBn: string; roleCode: string; roleBn: string; code: string;
  }> = [];
  private draft: Draft = {
    nameBn: '', nameEn: '', stream: 'bangla_medium', level: 'secondary',
    eiin: '', district: '', addressBn: '',
    slug: '', weekendDays: [5, 6], shifts: ['single'],
    planCode: 'pilot', studentCap: 500, trialEndsOn: '',
  };
  /** Set once screen 3 commits. From here the wizard is resumable. */
  private tenantId: string | null = null;
  private detail: { tenant: TenantRow & { branding: Record<string, string>; weekendDays: number[] };
                    state: OnboardingState; canActivate: boolean } | null = null;
  private activationCode = '';
  private busy = false;

  /** R-8. Null until the readiness screen is opened. */
  private goLive: { checks: GoLiveCheck[]; ready: boolean; blockingRemaining: number } | null = null;

  constructor(root: HTMLElement) {
    this.root = root;
    if (this.token && this.key) void this.loadList();
    else this.render();
  }

  // ── Transport ─────────────────────────────────────────────────────────

  private async call<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await fetch(`${API}/${path}`, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.token}`,
        // Never in the bundle. Typed by the operator, held for the session.
        'X-Platform-Key': this.key,
        ...(init.headers ?? {}),
      },
    });
    const body = await res.json().catch(() => ({})) as Record<string, unknown>;
    if (!res.ok) {
      const err = new Error(String(body.message ?? body.error ?? 'অজানা ত্রুটি'));
      (err as Error & { code?: string; detail?: unknown }).code = String(body.error ?? '');
      (err as Error & { detail?: unknown }).detail = body;
      throw err;
    }
    return body as T;
  }

  private async loadList(): Promise<void> {
    this.loading = true; this.error = ''; this.render();
    try {
      const r = await this.call<{ tenants: TenantRow[] }>(
        `tenants?q=${encodeURIComponent(this.search)}`);
      this.tenants = r.tenants;
    } catch (e) {
      this.error = (e as Error).message;
      this.tenants = [];
    } finally {
      this.loading = false; this.render();
    }
  }

  private async loadReadiness(): Promise<void> {
    this.loading = true; this.error = ''; this.goLive = null; this.render();
    try {
      this.goLive = await this.call('readiness');
    } catch (e) {
      this.error = (e as Error).message;
    } finally {
      this.loading = false; this.render();
    }
  }

  private async loadDetail(id: string): Promise<void> {
    this.loading = true; this.error = ''; this.render();
    try {
      this.detail = await this.call(`tenant?id=${encodeURIComponent(id)}`);
      this.tenantId = id;
    } catch (e) {
      this.error = (e as Error).message;
    } finally {
      this.loading = false; this.render();
    }
  }

  // ── Shell ─────────────────────────────────────────────────────────────

  private render(): void {
    const d = this.doc;
    this.root.replaceChildren();

    const bar = d.createElement('header');
    bar.className = 'platform-bar';
    const brand = d.createElement('span');
    brand.className = 'platform-brand';
    // D11: this stays. It is the platform's own tool.
    brand.textContent = 'shikhonBD';
    const sub = d.createElement('span');
    sub.className = 'platform-sub';
    sub.textContent = 'প্ল্যাটফর্ম কনসোল';
    bar.append(brand, sub);

    if (this.token && this.key) {
      const out = d.createElement('button');
      out.type = 'button'; out.className = 'btn-ghost btn-small';
      out.textContent = 'সেশন শেষ';
      out.addEventListener('click', () => {
        sessionStorage.removeItem('shikhon_platform_token');
        sessionStorage.removeItem('shikhon_platform_key');
        this.token = ''; this.key = ''; this.view = 'list'; this.render();
      });
      bar.append(out);
    }
    this.root.append(bar);

    const main = d.createElement('main');
    main.className = 'platform-main';
    this.root.append(main);

    if (!this.token || !this.key) { this.renderSignIn(main); return; }
    if (this.view === 'readiness') { this.renderReadiness(main); return; }
    if (this.view === 'wizard') { this.renderWizard(main); return; }
    if (this.view === 'detail') { this.renderDetail(main); return; }
    this.renderList(main);
  }

  private renderSignIn(main: HTMLElement): void {
    const d = this.doc;
    const h = d.createElement('h1');
    h.className = 'platform-title';
    h.textContent = 'অপারেটর সাইন-ইন';
    const p = d.createElement('p');
    p.className = 'page-sub';
    p.textContent = 'প্ল্যাটফর্ম টোকেন ও কী দিন। এগুলো শুধু এই সেশনে থাকে।';
    main.append(h, p);

    const form = d.createElement('form');
    form.className = 'card card-form';

    const tokenField = this.field('অপারেটর টোকেন (super_admin JWT)', 'password', this.token);
    const keyField = this.field('PLATFORM_API_KEY', 'password', this.key);
    form.append(tokenField.wrap, keyField.wrap);

    const go = d.createElement('button');
    go.type = 'submit'; go.className = 'btn-primary'; go.textContent = 'প্রবেশ';
    form.append(go);

    if (this.error) form.append(errorState(d, this.error));

    form.addEventListener('submit', (e) => {
      e.preventDefault();
      this.token = tokenField.input.value.trim();
      this.key = keyField.input.value.trim();
      if (!this.token || !this.key) { this.error = 'দুটোই দিতে হবে।'; this.render(); return; }
      sessionStorage.setItem('shikhon_platform_token', this.token);
      sessionStorage.setItem('shikhon_platform_key', this.key);
      void this.loadList();
    });
    main.append(form);
  }

  // ── The institution list ──────────────────────────────────────────────

  private renderList(main: HTMLElement): void {
    const d = this.doc;
    const head = d.createElement('div');
    head.className = 'platform-head';
    const h = d.createElement('h1');
    h.className = 'platform-title';
    h.textContent = 'প্রতিষ্ঠানসমূহ';
    const add = d.createElement('button');
    add.type = 'button'; add.className = 'btn-primary btn-inline';
    add.textContent = '+ নতুন প্রতিষ্ঠান';
    add.addEventListener('click', () => {
      this.step = 0; this.tenantId = null; this.activationCode = '';
      this.draft = {
        nameBn: '', nameEn: '', stream: 'bangla_medium', level: 'secondary',
        eiin: '', district: '', addressBn: '',
        slug: '', weekendDays: [5, 6], shifts: ['single'],
        planCode: 'pilot', studentCap: 500, trialEndsOn: '',
      };
      this.view = 'wizard'; this.error = ''; this.render();
    });
    // R-8. The posture screen sits beside "new institution" because the
    // operator who is about to onboard a school is exactly the person who
    // needs to know whether its SMS will actually send.
    const posture = d.createElement('button');
    posture.type = 'button'; posture.className = 'btn-secondary btn-inline';
    posture.textContent = 'গো-লাইভ অবস্থা';
    posture.addEventListener('click', () => {
      this.view = 'readiness'; this.error = ''; void this.loadReadiness();
    });
    head.append(h, posture, add);
    main.append(head);

    const searchForm = d.createElement('form');
    searchForm.className = 'platform-search';
    const si = d.createElement('input');
    si.type = 'search'; si.className = 'field-input';
    si.placeholder = 'নাম বা স্লাগ দিয়ে খুঁজুন';
    si.value = this.search;
    si.addEventListener('input', () => { this.search = si.value; });
    searchForm.append(si);
    searchForm.addEventListener('submit', (e) => { e.preventDefault(); void this.loadList(); });
    main.append(searchForm);

    if (this.notice) {
      const n = d.createElement('p');
      n.className = 'status-chip'; n.setAttribute('aria-live', 'polite');
      n.textContent = this.notice;
      main.append(n);
    }
    if (this.loading) { main.append(skeleton(d, 4)); return; }
    if (this.error) { main.append(errorState(d, this.error, () => void this.loadList())); return; }
    if (this.tenants.length === 0) {
      main.append(emptyState(d, {
        message: 'কোনো প্রতিষ্ঠান নেই। "নতুন প্রতিষ্ঠান" দিয়ে শুরু করুন।',
      }));
      return;
    }

    const table = d.createElement('div');
    table.className = 'table-scroll';
    const t = d.createElement('table');
    t.className = 'data-table';
    const thead = d.createElement('thead');
    const hr = d.createElement('tr');
    // §18's columns, and nothing student-level: the platform list carries
    // counts, never a child's name.
    for (const label of ['প্রতিষ্ঠান', 'ধরন', 'স্লাগ', 'অবস্থা', 'প্ল্যান',
                         'শিক্ষার্থী', 'ট্রায়াল শেষ', 'তৈরি', '']) {
      const th = d.createElement('th'); th.scope = 'col'; th.textContent = label; hr.append(th);
    }
    thead.append(hr);
    const tbody = d.createElement('tbody');
    for (const row of this.tenants) tbody.append(this.tenantRow(row));
    t.append(thead, tbody);
    table.append(t);
    main.append(table);
  }

  private tenantRow(row: TenantRow): HTMLElement {
    const d = this.doc;
    const tr = d.createElement('tr');
    const cell = (text: string): HTMLElement => {
      const td = d.createElement('td'); td.textContent = text; return td;
    };
    tr.append(cell(row.nameBn));
    // The derived TYPE, not the medium. This column is headed ধরন and used
    // to print the stream, which is how a college came to be listed as a
    // madrasa.
    tr.append(cell(institutionTypeLabel(row.stream, row.level)));
    const slug = cell(row.slug); slug.className = 'mono'; tr.append(slug);

    const st = d.createElement('td');
    const chip = d.createElement('span');
    chip.className = `status-chip status-${row.status}`;
    chip.textContent = STATUS_BN[row.status] ?? row.status;
    st.append(chip);
    tr.append(st);

    tr.append(cell(row.planCode));
    tr.append(cell(`${bnNum(row.studentCount)} / ${bnNum(row.studentCap)}`));
    tr.append(cell(row.trialEndsOn ? bnDate(row.trialEndsOn) : '—'));
    tr.append(cell(bnDate(row.createdAt)));

    const act = d.createElement('td');
    const open = d.createElement('button');
    open.type = 'button'; open.className = 'btn-ghost btn-small';
    open.textContent = 'খুলুন';
    open.addEventListener('click', () => { this.view = 'detail'; void this.loadDetail(row.id); });
    act.append(open);
    tr.append(act);
    return tr;
  }

  // ── R-8: go-live readiness ────────────────────────────────────────────

  /**
   * What this deployment is configured to do, and what is still dark.
   *
   * Every line is computed by the server from its own environment — this
   * screen ticks nothing and remembers nothing. A go-live checklist somebody
   * maintains by hand is wrong the first time a variable is renamed, and the
   * operator reading this is usually the person who just renamed one.
   *
   * Blocking and advisory are separated because folding them together would
   * leave the screen permanently amber over things like MFS, which a pilot
   * school does not need and may never turn on. A permanently amber screen is
   * one nobody reads.
   */
  private renderReadiness(main: HTMLElement): void {
    const d = this.doc;

    const back = d.createElement('button');
    back.type = 'button'; back.className = 'btn-secondary';
    back.textContent = '← তালিকায় ফিরুন';
    back.addEventListener('click', () => {
      this.view = 'list'; this.goLive = null; this.error = ''; void this.loadList();
    });
    main.append(back);

    const h = d.createElement('h1');
    h.className = 'platform-title';
    h.textContent = 'গো-লাইভ অবস্থা';
    main.append(h);

    if (this.loading) { main.append(skeleton(d, 6)); return; }
    if (this.error) {
      main.append(errorState(d, this.error, () => void this.loadReadiness()));
      return;
    }
    const g = this.goLive;
    if (!g) return;

    const summary = d.createElement('p');
    summary.className = 'page-sub';
    summary.setAttribute('aria-live', 'polite');
    summary.textContent = g.ready
      ? 'সব আবশ্যক সেটিং প্রস্তুত — বাস্তব শিক্ষার্থীদের জন্য চালু করা যায়।'
      : `${bnNum(g.blockingRemaining)} টি আবশ্যক সেটিং বাকি আছে।`;
    main.append(summary);

    for (const [severity, heading] of [
      ['blocking', 'আবশ্যক'], ['advisory', 'ঐচ্ছিক'],
    ] as Array<['blocking' | 'advisory', string]>) {
      const rows = g.checks.filter((c) => c.severity === severity);
      if (rows.length === 0) continue;

      const card = d.createElement('div');
      card.className = 'card platform-state';
      const ch = d.createElement('h2');
      ch.className = 'section-heading';
      ch.textContent = heading;
      card.append(ch);

      const dl = d.createElement('dl');
      dl.className = 'detail-list';
      for (const c of rows) {
        const wrap = d.createElement('div');
        const dt = d.createElement('dt');
        dt.textContent = c.labelBn;
        const dd = d.createElement('dd');
        // The glyph, the state word AND the reason — never colour alone
        // (F-812), and never a bare tick that leaves an operator guessing
        // which variable is missing.
        dd.textContent = `${c.ready ? '✓' : '⚠'} ${c.detailBn}`;
        dd.className = c.ready ? 'state-ok' : 'state-pending';
        wrap.append(dt, dd);
        dl.append(wrap);
      }
      card.append(dl);
      main.append(card);
    }

    // The half of R-8 no environment variable can answer.
    const note = d.createElement('div');
    note.className = 'card platform-state';
    const nh = d.createElement('h2');
    nh.className = 'section-heading';
    nh.textContent = 'এই পর্দা যা জানে না';
    const np = d.createElement('p');
    np.className = 'page-sub';
    np.textContent = 'অ্যাগ্রিগেটরের চুক্তি, এমএফএস মার্চেন্ট চুক্তি, তথ্য কোথায় রাখা হবে '
      + 'সেই সিদ্ধান্ত, এবং পাইলট স্কুলগুলো — এগুলো কনফিগারেশন নয়, তাই এখানে টিক দেওয়া যায় না। '
      + 'docs/11-MASTER-PLAN.md §R-8 দেখুন।';
    note.append(nh, np);
    main.append(note);
  }

  // ── One institution ───────────────────────────────────────────────────

  private renderDetail(main: HTMLElement): void {
    const d = this.doc;
    const back = d.createElement('button');
    back.type = 'button'; back.className = 'btn-secondary';
    back.textContent = '← তালিকায় ফিরুন';
    back.addEventListener('click', () => {
      this.view = 'list'; this.detail = null; this.notice = ''; void this.loadList();
    });
    main.append(back);

    if (this.loading) { main.append(skeleton(d, 5)); return; }

    const det = this.detail;

    // An error takes over the screen ONLY when there is nothing to take over:
    // a failed LOAD has no content behind it. A failed SAVE does, and blanking
    // the screen for one — which is what this did — left an operator whose cap
    // change was refused looking at a bare "try again" with the form they were
    // editing gone, and no way back except a reload.
    if (this.error && !det) {
      const id = this.tenantId;
      main.append(errorState(d, this.error, () => { if (id) void this.loadDetail(id); }));
      return;
    }
    if (!det) return;
    if (this.error) {
      const p = d.createElement('p');
      p.className = 'login-error';
      p.setAttribute('role', 'alert');
      p.textContent = this.error;
      main.append(p);
    }

    const h = d.createElement('h1');
    h.className = 'platform-title';
    h.textContent = det.tenant.nameBn;
    const sub = d.createElement('p');
    sub.className = 'page-sub';
    sub.textContent = `${det.tenant.slug} · ${institutionTypeLabel(det.tenant.stream, det.tenant.level)}`
      + ` · ${STREAM_BN[det.tenant.stream] ?? det.tenant.stream}`
      + ` · ${STATUS_BN[det.tenant.status] ?? det.tenant.status}`;
    main.append(h, sub);

    main.append(this.stateChecklist(det.state, det.canActivate));
    main.append(this.planEditor(det.tenant));
    main.append(this.accessPanel(det.tenant));
    main.append(this.statusActions(det.tenant, det.canActivate));

    if (this.notice) {
      const n = d.createElement('p');
      n.className = 'status-chip'; n.setAttribute('aria-live', 'polite');
      n.textContent = this.notice;
      main.append(n);
    }
  }

  /**
   * §23's checklist, and the thing the operator actually reads after a
   * failure. Every number is a COUNT from the database, so a step that half
   * finished shows what landed rather than a tick somebody set.
   */
  private stateChecklist(s: OnboardingState, canActivate: boolean): HTMLElement {
    const d = this.doc;
    const wrap = d.createElement('div');
    wrap.className = 'card platform-state';
    const h = d.createElement('h2');
    h.className = 'section-heading';
    h.textContent = 'প্রস্তুতির অবস্থা';
    wrap.append(h);

    const rows: Array<[string, number, boolean, string]> = [
      ['শিক্ষাবর্ষ', s.years, s.years > 0, 'সক্রিয় করতে আবশ্যক'],
      ['গ্রেডিং স্কেল', s.gradingBands, s.gradingBands > 0, 'সক্রিয় করতে আবশ্যক — না থাকলে প্রথম ফলাফল প্রকাশ ব্যর্থ হবে'],
      ['প্রশাসক অ্যাকাউন্ট', s.admins, s.admins > 0, 'সক্রিয় করতে আবশ্যক'],
      ['শ্রেণি', s.classes, s.classes > 0, ''],
      ['শাখা', s.sections, s.sections > 0, ''],
      ['বিষয়', s.subjects, s.subjects > 0, ''],
      ['ফি খাত', s.feeHeads, s.feeHeads > 0, ''],
      ['শিক্ষক', s.teachers, s.teachers > 0, 'ঐচ্ছিক — পরে আমদানি করা যায়'],
      ['শিক্ষার্থী', s.students, s.students > 0, 'ঐচ্ছিক — পরে আমদানি করা যায়'],
      ['অভিভাবক', s.guardians, s.guardians > 0, 'শিক্ষার্থী আমদানির সঙ্গে তৈরি হয়'],
      // Labelled লোগো, not ব্র্যান্ডিং: migration 045 measures `logoUrl`, and
      // the wizard's branding step sets colour and head teacher but no logo.
      // Called ব্র্যান্ডিং it reported "not done" to an operator who had just
      // done it.
      ['লোগো', s.hasBranding ? 1 : 0, s.hasBranding, 'ঐচ্ছিক — প্রতিষ্ঠান নিজেই আপলোড করতে পারে'],
    ];
    const list = d.createElement('dl');
    list.className = 'detail-list';
    for (const [label, count, ok, note] of rows) {
      const div = d.createElement('div');
      const dt = d.createElement('dt');
      dt.textContent = label;
      const dd = d.createElement('dd');
      // A tick or a warning triangle, always paired with the count and the
      // note — never colour or a glyph alone (F-812).
      dd.textContent = `${ok ? '✓' : '⚠'} ${bnNum(count)}${note ? ` · ${note}` : ''}`;
      dd.className = ok ? 'state-ok' : 'state-pending';
      div.append(dt, dd);
      list.append(div);
    }
    wrap.append(list);

    if (!canActivate) {
      const p = d.createElement('p');
      p.className = 'page-sub';
      p.textContent = 'শিক্ষাবর্ষ, গ্রেডিং স্কেল ও একজন প্রশাসক — এই তিনটি ছাড়া সক্রিয় করা যাবে না।';
      wrap.append(p);
    }
    return wrap;
  }

  /** R-7.12: the school's door, in both forms, with the subdomain first. */
  private accessPanel(t: TenantRow): HTMLElement {
    const d = this.doc;
    const wrap = d.createElement('div');
    wrap.className = 'card platform-state';
    const h = d.createElement('h2');
    h.className = 'section-heading';
    h.textContent = 'প্রতিষ্ঠানের ঠিকানা';
    wrap.append(h);

    const host = location.host.replace(/^platform\./, '');
    const rows: Array<[string, string]> = [
      ['সাবডোমেইন', `${t.slug}.${host}/app`],
      ['ইনস্টল লিংক', `${location.origin}/app?tid=${t.id}`],
    ];
    const dl = d.createElement('dl');
    dl.className = 'detail-list';
    for (const [k, v] of rows) {
      const div = d.createElement('div');
      const dt = d.createElement('dt'); dt.textContent = k;
      const dd = d.createElement('dd'); dd.className = 'mono'; dd.textContent = v;
      div.append(dt, dd); dl.append(div);
    }
    wrap.append(dl);

    const note = d.createElement('p');
    note.className = 'page-sub';
    note.textContent = 'দুটোই একই প্রতিষ্ঠানে নিয়ে যায়। পুরোনো ?tid= লিংক কাজ করতেই থাকবে।';
    wrap.append(note);

    if (this.activationCode) {
      const code = d.createElement('p');
      code.className = 'platform-code';
      code.textContent = `অ্যাক্টিভেশন কোড: ${this.activationCode}`;
      const warn = d.createElement('p');
      warn.className = 'page-sub';
      warn.textContent = 'কোডটি একবারই দেখানো হয় — সংরক্ষণ করা হয় না। ৭২ ঘণ্টা পর মেয়াদ শেষ।';
      wrap.append(code, warn);
    }
    return wrap;
  }

  /**
   * The plan, cap and trial end — editable.  (R-7 completion)
   *
   * These were writable exactly once, on wizard screen 3, and never again. A
   * school that outgrew its cap needed SQL, and the refusal an operator sees
   * on an over-cap import named a limit nothing in the console could raise.
   */
  private planEditor(t: TenantRow): HTMLElement {
    const d = this.doc;
    const wrap = d.createElement('div');
    wrap.className = 'card platform-state';
    const h = d.createElement('h2');
    h.className = 'section-heading';
    h.textContent = 'প্ল্যান ও সীমা';
    wrap.append(h);

    const form = d.createElement('div');
    form.className = 'card-form';
    const plan = this.field('প্ল্যান কোড', 'text', t.planCode ?? '');
    const cap = this.field('শিক্ষার্থীর সীমা *', 'number', String(t.studentCap ?? 0));
    const trial = this.field('ট্রায়াল শেষের তারিখ', 'date', t.trialEndsOn ?? '');
    cap.input.dataset.field = 'student-cap';
    form.append(plan.wrap, cap.wrap, trial.wrap);

    const note = d.createElement('p');
    note.className = 'page-sub';
    note.textContent = 'সীমা সার্ভারে প্রয়োগ হয় — বর্তমান শিক্ষার্থী সংখ্যার নিচে নামানো যাবে না।';
    form.append(note);

    const row = d.createElement('div');
    row.className = 'action-row';
    const save = d.createElement('button');
    save.type = 'button';
    save.className = 'btn-primary btn-inline';
    save.dataset.action = 'save-plan';
    save.textContent = this.busy ? 'অপেক্ষা করুন…' : 'সংরক্ষণ করুন';
    save.disabled = this.busy;
    save.addEventListener('click', async () => {
      this.busy = true; this.error = ''; this.notice = ''; this.render();
      try {
        const r = await this.call<{ studentCap: number; planCode: string }>('plan', {
          method: 'POST',
          body: JSON.stringify({
            tenantId: t.id,
            planCode: plan.input.value.trim(),
            studentCap: Number(cap.input.value),
            trialEndsOn: trial.input.value || '',
          }),
        });
        this.notice = `সংরক্ষিত — ${r.planCode} · সীমা ${bnNum(r.studentCap)}`;
        await this.loadDetail(t.id);
        return;
      } catch (e) { this.error = (e as Error).message; }
      finally { this.busy = false; this.render(); }
    });
    row.append(save);
    form.append(row);
    wrap.append(form);
    return wrap;
  }

  private statusActions(t: TenantRow, canActivate: boolean): HTMLElement {
    const d = this.doc;
    const row = d.createElement('div');
    row.className = 'action-row';

    // The way back into the wizard. Placed with the status actions because it
    // is the other thing an operator does from this screen, and labelled by
    // what is actually missing rather than "continue" — an operator returning
    // a week later should not have to work out where they stopped.
    const st = this.detail?.state;
    if (st) {
      const step = resumeStepFor(st);
      const resume = d.createElement('button');
      resume.type = 'button';
      resume.className = 'btn-secondary';
      resume.dataset.action = 'resume-setup';
      resume.textContent = `সেটআপ চালিয়ে যান — ${STEPS[step]}`;
      resume.disabled = this.busy;
      resume.addEventListener('click', () => {
        this.tenantId = t.id;
        this.step = step;
        this.activationCode = '';
        this.adminsMade = [];
        // The draft describes screens 1–3, which are already committed for an
        // existing tenant. It is filled from the row so screen 6's class-range
        // hint still matches the school's level if the operator steps back.
        this.draft = {
          nameBn: t.nameBn, nameEn: t.nameEn, stream: t.stream, level: t.level,
          eiin: '', district: '', addressBn: '',
          slug: t.slug, weekendDays: [5, 6], shifts: ['single'],
          planCode: '', studentCap: 0, trialEndsOn: '',
        };
        this.view = 'wizard';
        this.error = ''; this.notice = '';
        this.render();
      });
      row.append(resume);
    }

    const set = (status: string, label: string, enabled: boolean): void => {
      const b = d.createElement('button');
      b.type = 'button';
      b.className = status === 'active' ? 'btn-primary btn-inline' : 'btn-secondary';
      b.textContent = label;
      b.disabled = !enabled || this.busy;
      b.addEventListener('click', () => void this.setStatus(t.id, status));
      row.append(b);
    };

    if (t.status !== 'active') set('active', 'সক্রিয় করুন', canActivate);
    if (t.status === 'active' || t.status === 'trial') set('suspended', 'স্থগিত করুন', true);
    if (t.status === 'suspended') set('active', 'পুনরায় চালু', canActivate);
    return row;
  }

  private async setStatus(id: string, status: string): Promise<void> {
    this.busy = true; this.error = ''; this.notice = ''; this.render();
    try {
      await this.call('status', {
        method: 'POST', body: JSON.stringify({ tenantId: id, status }),
      });
      this.notice = status === 'active' ? 'প্রতিষ্ঠান সক্রিয় হয়েছে।'
        : status === 'suspended' ? 'প্রতিষ্ঠান স্থগিত হয়েছে — তথ্য অক্ষত আছে।'
        : 'অবস্থা পরিবর্তিত হয়েছে।';
      await this.loadDetail(id);
    } catch (e) {
      // The endpoint names the exact blockers; showing them beats "failed".
      this.error = (e as Error).message;
    } finally {
      this.busy = false; this.render();
    }
  }

  // ── The wizard ────────────────────────────────────────────────────────

  private renderWizard(main: HTMLElement): void {
    const d = this.doc;

    const cancel = d.createElement('button');
    cancel.type = 'button'; cancel.className = 'btn-secondary';
    cancel.textContent = '← বাতিল করে তালিকায়';
    cancel.addEventListener('click', () => {
      this.view = this.tenantId ? 'detail' : 'list';
      this.error = '';
      if (this.tenantId) void this.loadDetail(this.tenantId); else void this.loadList();
    });
    main.append(cancel);

    main.append(this.progress());

    const h = d.createElement('h1');
    h.className = 'platform-title';
    h.textContent = `ধাপ ${bnNum(this.step + 1)} — ${STEPS[this.step]}`;
    main.append(h);

    if (this.error) main.append(errorState(d, this.error));
    if (this.notice) {
      const n = d.createElement('p');
      n.className = 'status-chip'; n.setAttribute('aria-live', 'polite');
      n.textContent = this.notice;
      main.append(n);
    }

    switch (this.step) {
      case 0: return this.screenInstitution(main);
      case 1: return this.screenSlug(main);
      case 2: return this.screenPlan(main);
      case 3: return this.screenBranding(main);
      case 4: return this.screenAcademic(main);
      case 5: return this.screenStructure(main);
      case 6: return this.screenAdmin(main);
      case 7: return this.screenImport(main, 'teacher');
      case 8: return this.screenImport(main, 'student');
    }
  }

  /**
   * The progress indicator, and it says three things, not one: which step,
   * which are done, and which remain. §6 — the operator must not have to
   * guess.
   */
  private progress(): HTMLElement {
    const d = this.doc;
    const nav = d.createElement('ol');
    nav.className = 'wizard-steps';
    nav.setAttribute('aria-label', 'ধাপসমূহ');
    STEPS.forEach((label, i) => {
      const li = d.createElement('li');
      const done = i < this.step;
      li.className = i === this.step ? 'wizard-step is-current'
        : done ? 'wizard-step is-done' : 'wizard-step';
      // The state is in the text as well as the class: a tick, the current
      // marker, or nothing. Never colour alone.
      li.textContent = `${done ? '✓ ' : ''}${bnNum(i + 1)}. ${label}`;
      if (i === this.step) li.setAttribute('aria-current', 'step');
      nav.append(li);
    });
    return nav;
  }

  private field(label: string, type: string, value: string, hint = ''): {
    wrap: HTMLElement; input: HTMLInputElement;
  } {
    const d = this.doc;
    const wrap = d.createElement('label');
    wrap.className = 'field';
    const span = d.createElement('span');
    span.textContent = label;
    const input = d.createElement('input');
    input.type = type; input.className = 'field-input'; input.value = value;
    wrap.append(span, input);
    if (hint) {
      const p = d.createElement('span');
      p.className = 'field-hint'; p.textContent = hint;
      wrap.append(p);
    }
    return { wrap, input };
  }

  private select(label: string, options: Record<string, string>, value: string): {
    wrap: HTMLElement; input: HTMLSelectElement;
  } {
    const d = this.doc;
    const wrap = d.createElement('label');
    wrap.className = 'field';
    const span = d.createElement('span');
    span.textContent = label;
    const sel = d.createElement('select');
    sel.className = 'field-input';
    for (const [v, t] of Object.entries(options)) {
      const o = d.createElement('option');
      o.value = v; o.textContent = t;
      if (v === value) o.selected = true;
      sel.append(o);
    }
    wrap.append(span, sel);
    return { wrap, input: sel };
  }

  private nav(main: HTMLElement, onNext: () => void | Promise<void>, nextLabel = 'পরবর্তী →',
              skippable = false): void {
    const d = this.doc;
    const row = d.createElement('div');
    row.className = 'action-row';

    if (this.step > 0) {
      const back = d.createElement('button');
      back.type = 'button'; back.className = 'btn-secondary';
      back.textContent = '← আগের';
      back.disabled = this.busy;
      back.addEventListener('click', () => { this.step--; this.error = ''; this.notice = ''; this.render(); });
      row.append(back);
    }
    if (skippable) {
      const skip = d.createElement('button');
      skip.type = 'button'; skip.className = 'btn-ghost btn-small';
      skip.textContent = 'এই ধাপ বাদ দিন';
      skip.disabled = this.busy;
      skip.addEventListener('click', () => { this.step++; this.error = ''; this.notice = ''; this.render(); });
      row.append(skip);
    }
    const next = d.createElement('button');
    next.type = 'button'; next.className = 'btn-primary btn-inline';
    next.textContent = this.busy ? 'অপেক্ষা করুন…' : nextLabel;
    next.disabled = this.busy;
    next.addEventListener('click', () => { void onNext(); });
    row.append(next);
    main.append(row);
  }

  // Screen 1 — institution identity. Nothing is written yet.
  private screenInstitution(main: HTMLElement): void {
    const d = this.doc;
    const form = d.createElement('div');
    form.className = 'card card-form';
    const nameBn = this.field('বাংলা নাম *', 'text', this.draft.nameBn);
    const nameEn = this.field('ইংরেজি নাম *', 'text', this.draft.nameEn,
      'স্লাগ এখান থেকেই তৈরি হবে');
    // ── Type first, then the two columns it implies ─────────────────
    //
    // This field used to be the STREAM, labelled "প্রতিষ্ঠানের ধরন". A stream
    // is a teaching medium, not a type, and the result was on the screen: a
    // college onboarded here was stored `stream=madrasah, level=combined` and
    // listed as মাদ্রাসা. An operator should not have to know that "College"
    // is spelled `higher_secondary`.
    const currentType = institutionTypeOf(this.draft.stream, this.draft.level);
    const type = this.select('প্রতিষ্ঠানের ধরন *', INSTITUTION_TYPE_BN, currentType);

    // Only the mediums and levels this type can actually have. Offering
    // "madrasah medium" under School would let an operator build a school
    // that reads back as a madrasa — the confusion this is removing.
    const pick = (all: Record<string, string>, allowed: readonly string[]) =>
      Object.fromEntries(allowed.map((k) => [k, all[k] ?? k]));
    const stream = this.select('মাধ্যম *',
      pick(STREAM_BN, STREAMS_FOR_TYPE[currentType]), this.draft.stream);
    const level = this.select('স্তর *',
      pick(LEVEL_BN, LEVELS_FOR_TYPE[currentType]), this.draft.level);

    // Changing the type re-renders with the choices that type allows, keeping
    // a compatible medium rather than resetting a correction the operator has
    // already made.
    type.input.addEventListener('change', () => {
      const next = type.input.value as InstitutionType;
      const dflt = defaultsForType(next, {
        stream: this.draft.stream, level: this.draft.level,
      });
      this.draft.nameBn = nameBn.input.value.trim();
      this.draft.nameEn = nameEn.input.value.trim();
      this.draft.stream = dflt.stream;
      this.draft.level = dflt.level;
      this.render();
    });

    const eiin = this.field('EIIN', 'text', this.draft.eiin, '৬–৮ সংখ্যা, ঐচ্ছিক');
    const district = this.field('জেলা', 'text', this.draft.district);
    const address = this.field('ঠিকানা (বাংলা)', 'text', this.draft.addressBn,
      'ছাপা কাগজের শীর্ষভাগে যাবে');
    form.append(nameBn.wrap, nameEn.wrap, type.wrap, stream.wrap, level.wrap,
                eiin.wrap, district.wrap, address.wrap);
    main.append(form);

    this.nav(main, () => {
      this.draft.nameBn = nameBn.input.value.trim();
      this.draft.nameEn = nameEn.input.value.trim();
      this.draft.stream = stream.input.value;
      this.draft.level = level.input.value;
      this.draft.eiin = eiin.input.value.trim();
      this.draft.district = district.input.value.trim();
      this.draft.addressBn = address.input.value.trim();

      if (!this.draft.nameBn) { this.error = 'বাংলা নাম দিন।'; this.render(); return; }
      if (!this.draft.nameEn) { this.error = 'ইংরেজি নাম দিন।'; this.render(); return; }
      if (this.draft.eiin && !/^\d{6,8}$/.test(this.draft.eiin)) {
        this.error = 'EIIN ৬–৮ সংখ্যার হতে হবে।'; this.render(); return;
      }
      // A madrasah's weekend is commonly Friday only. Pre-selecting by type
      // is the difference between a correct calendar and a school that gets
      // texted on its quiet day (R-7.15, screen 2).
      this.draft.weekendDays = this.draft.stream === 'madrasah' ? [5] : [5, 6];
      if (!this.draft.slug) this.draft.slug = slugify(this.draft.nameEn);
      this.error = ''; this.step = 1; this.render();
    });
  }

  // Screen 2 — slug, weekend, shifts. Still nothing written.
  private screenSlug(main: HTMLElement): void {
    const d = this.doc;
    const form = d.createElement('div');
    form.className = 'card card-form';
    const slug = this.field('স্লাগ *', 'text', this.draft.slug || slugify(this.draft.nameEn),
      'এটিই প্রতিষ্ঠানের ওয়েব ঠিকানা হবে — ছাপা হয়ে গেলে আর বদলানো যাবে না');
    form.append(slug.wrap);

    const weekend = d.createElement('fieldset');
    weekend.className = 'field';
    const legend = d.createElement('legend');
    legend.textContent = 'সাপ্তাহিক ছুটি *';
    weekend.append(legend);
    const DAYS = ['রবি', 'সোম', 'মঙ্গল', 'বুধ', 'বৃহঃ', 'শুক্র', 'শনি'];
    const boxes: HTMLInputElement[] = [];
    DAYS.forEach((label, i) => {
      const l = d.createElement('label');
      l.className = 'check-inline';
      const cb = d.createElement('input');
      cb.type = 'checkbox'; cb.value = String(i);
      cb.checked = this.draft.weekendDays.includes(i);
      const s = d.createElement('span'); s.textContent = label;
      l.append(cb, s); weekend.append(l); boxes.push(cb);
    });
    form.append(weekend);

    const shifts = this.select('শিফট *',
      { single: 'একক', morning: 'সকাল', day: 'দিবা', evening: 'সন্ধ্যা' },
      this.draft.shifts[0] ?? 'single');
    form.append(shifts.wrap);
    main.append(form);

    this.nav(main, () => {
      this.draft.slug = slug.input.value.trim().toLowerCase();
      this.draft.weekendDays = boxes.filter((b) => b.checked).map((b) => Number(b.value));
      this.draft.shifts = [shifts.input.value];
      if (!/^[a-z0-9][a-z0-9-]{2,62}$/.test(this.draft.slug)) {
        this.error = 'স্লাগ ছোট হাতের অক্ষর, সংখ্যা ও হাইফেন — ৩ থেকে ৬৩ অক্ষর।';
        this.render(); return;
      }
      if (this.draft.weekendDays.length === 0) {
        this.error = 'অন্তত একটি সাপ্তাহিক ছুটির দিন বেছে নিন।'; this.render(); return;
      }
      this.error = ''; this.step = 2; this.render();
    });
  }

  /**
   * Screen 3 — plan, and the screen that WRITES.
   *
   * Everything before this is a draft in the browser; everything after is
   * resumable, because the tenant row now exists and each later screen
   * commits on its own.
   */
  private screenPlan(main: HTMLElement): void {
    const d = this.doc;
    const form = d.createElement('div');
    form.className = 'card card-form';
    const plan = this.field('প্ল্যান কোড', 'text', this.draft.planCode);
    const cap = this.field('শিক্ষার্থীর সীমা *', 'number', String(this.draft.studentCap),
      'সার্ভারে প্রয়োগ হয় — সীমার বেশি আমদানি বাতিল হবে');
    const trial = this.field('ট্রায়াল শেষের তারিখ', 'date', this.draft.trialEndsOn);
    form.append(plan.wrap, cap.wrap, trial.wrap);

    const note = d.createElement('p');
    note.className = 'page-sub';
    note.textContent = 'এই ধাপে প্রতিষ্ঠানটি তৈরি হবে। এরপর যেকোনো সময় থেমে আবার শুরু করা যাবে।';
    form.append(note);
    main.append(form);

    if (this.tenantId) {
      const done = d.createElement('p');
      done.className = 'status-chip';
      done.textContent = 'প্রতিষ্ঠান তৈরি হয়ে গেছে — পরের ধাপে যান।';
      main.append(done);
      this.nav(main, () => { this.step = 3; this.error = ''; this.render(); });
      return;
    }

    this.nav(main, async () => {
      this.draft.planCode = plan.input.value.trim() || 'pilot';
      this.draft.studentCap = Number(cap.input.value) || 0;
      this.draft.trialEndsOn = trial.input.value;
      if (this.draft.studentCap <= 0) {
        this.error = 'শিক্ষার্থীর সীমা শূন্যের বেশি হতে হবে।'; this.render(); return;
      }
      this.busy = true; this.error = ''; this.render();
      try {
        const r = await this.call<{ tenant: { id: string; slug: string } }>('tenants', {
          method: 'POST',
          body: JSON.stringify({
            slug: this.draft.slug, nameBn: this.draft.nameBn, nameEn: this.draft.nameEn,
            stream: this.draft.stream, level: this.draft.level,
            eiin: this.draft.eiin || undefined, district: this.draft.district || undefined,
            addressBn: this.draft.addressBn || undefined,
            weekendDays: this.draft.weekendDays, shifts: this.draft.shifts,
            planCode: this.draft.planCode, studentCap: this.draft.studentCap,
            trialEndsOn: this.draft.trialEndsOn || undefined,
          }),
        });
        this.tenantId = r.tenant.id;
        this.notice = 'প্রতিষ্ঠান তৈরি হয়েছে।';
        this.step = 3;
      } catch (e) {
        const err = e as Error & { code?: string };
        // A slug collision offers a district suffix, never a number: this
        // becomes the school's web address (R-7.3).
        if (err.code === 'slug_taken' && this.draft.district) {
          const alt = `${this.draft.slug}-${slugify(this.draft.district)}`;
          this.error = `${err.message} — চেষ্টা করুন: ${alt}`;
          this.draft.slug = alt;
          this.step = 1;
        } else {
          this.error = err.message;
        }
      } finally {
        this.busy = false; this.render();
      }
    }, 'প্রতিষ্ঠান তৈরি করুন');
  }

  // Screen 4 — branding. Skippable: migration 039 already seeded the name.
  private screenBranding(main: HTMLElement): void {
    const d = this.doc;
    const form = d.createElement('div');
    form.className = 'card card-form';
    const primary = this.field('প্রধান রং', 'text', '#1B5E20', 'হেক্স, যেমন #1B5E20');
    const head = this.field('প্রধান শিক্ষকের নাম', 'text', '', 'ছাপা কাগজে স্বাক্ষরের নিচে যাবে');
    const phone = this.field('ফোন', 'text', '');
    form.append(primary.wrap, head.wrap, phone.wrap);

    const note = d.createElement('p');
    note.className = 'page-sub';
    note.textContent = 'লোগো ও সিল প্রতিষ্ঠান নিজেই পরে দিতে পারবে। '
      + 'এই ধাপ বাদ দিলেও কাগজে প্রতিষ্ঠানের নিজের নামই ছাপা হবে।';
    form.append(note);
    main.append(form);

    this.nav(main, async () => {
      const branding: Record<string, string> = {
        nameBn: this.draft.nameBn, nameEn: this.draft.nameEn,
      };
      if (primary.input.value.trim()) branding.primaryColor = primary.input.value.trim();
      if (head.input.value.trim()) branding.headmasterName = head.input.value.trim();
      if (phone.input.value.trim()) branding.phone = phone.input.value.trim();
      if (this.draft.addressBn) branding.address = this.draft.addressBn;

      this.busy = true; this.error = ''; this.render();
      try {
        await this.call('branding', {
          method: 'POST', body: JSON.stringify({ tenantId: this.tenantId, branding }),
        });
        this.notice = 'ব্র্যান্ডিং সংরক্ষিত হয়েছে।';
        this.step = 4;
      } catch (e) { this.error = (e as Error).message; }
      finally { this.busy = false; this.render(); }
    }, 'সংরক্ষণ করে পরবর্তী →', true);
  }

  // Screen 5 — the academic year. Combined with screen 6's structure in one
  // provision call, because app.provision_tenant creates both.
  private screenAcademic(main: HTMLElement): void {
    const d = this.doc;
    const year = String(new Date().getUTCFullYear());
    const form = d.createElement('div');
    form.className = 'card card-form';
    const label = this.field('শিক্ষাবর্ষ *', 'text', year);
    const starts = this.field('শুরু *', 'date', `${year}-01-01`);
    const ends = this.field('শেষ *', 'date', `${year}-12-31`);
    form.append(label.wrap, starts.wrap, ends.wrap);

    const note = d.createElement('p');
    note.className = 'page-sub';
    note.textContent = 'শিক্ষাবর্ষের সঙ্গে টার্ম, গ্রেডিং স্কেল, ঘণ্টাসূচি, বিষয় ও ফি খাত তৈরি হবে। '
      + 'গ্রেডিং স্কেল ছাড়া বছরের প্রথম ফলাফল প্রকাশ ব্যর্থ হয় — তাই এটি বাদ দেওয়া যায় না।';
    form.append(note);
    main.append(form);

    this.nav(main, () => {
      if (ends.input.value <= starts.input.value) {
        this.error = 'শেষের তারিখ শুরুর পরে হতে হবে।'; this.render(); return;
      }
      this.draft.planCode = this.draft.planCode; // untouched; kept for clarity
      (this as unknown as { _year: { label: string; starts: string; ends: string } })._year = {
        label: label.input.value.trim() || year,
        starts: starts.input.value, ends: ends.input.value,
      };
      this.error = ''; this.step = 5; this.render();
    });
  }

  // Screen 6 — classes, groups and sections, then provision.
  private screenStructure(main: HTMLElement): void {
    const d = this.doc;
    const [lo, hi] = LEVEL_RANGE[this.draft.level] ?? [1, 10];
    const form = d.createElement('div');
    form.className = 'card card-form';
    const min = this.field('সর্বনিম্ন শ্রেণি *', 'number', String(lo));
    const max = this.field('সর্বোচ্চ শ্রেণি *', 'number', String(hi));
    const per = this.field('প্রতি শ্রেণিতে শাখা', 'number', '1',
      'ক, খ, গ… — পরে যোগ করা যাবে');
    form.append(min.wrap, max.wrap, per.wrap);

    const note = d.createElement('p');
    note.className = 'page-sub';
    note.textContent = `${LEVEL_BN[this.draft.level]} স্তরের জন্য সাধারণত `
      + `${bnNum(lo)}–${bnNum(hi)} শ্রেণি। ভিন্ন হলে বদলে নিন।`;
    form.append(note);
    main.append(form);

    this.nav(main, async () => {
      const y = (this as unknown as { _year?: { label: string; starts: string; ends: string } })._year;
      const minL = Number(min.input.value), maxL = Number(max.input.value);
      if (!Number.isInteger(minL) || !Number.isInteger(maxL) || minL < 1 || maxL > 12 || minL > maxL) {
        this.error = 'শ্রেণির পরিসর ১–১২ এবং ক্রমানুসারে হতে হবে।'; this.render(); return;
      }
      this.busy = true; this.error = ''; this.render();
      try {
        const r = await this.call<{ seeded: string[]; sectionsMade: number }>('provision', {
          method: 'POST',
          body: JSON.stringify({
            tenantId: this.tenantId,
            yearLabel: y?.label, startsOn: y?.starts, endsOn: y?.ends,
            minLevel: minL, maxLevel: maxL,
            sectionsPerClass: Number(per.input.value) || 0,
          }),
        });
        // Showing the counts verbatim is how an operator knows the grading
        // scale exists (R-7.15, screen 5).
        this.notice = `তৈরি হয়েছে — ${r.seeded.join(', ')} · শাখা ${bnNum(r.sectionsMade)}`;
        this.step = 6;
      } catch (e) { this.error = (e as Error).message; }
      finally { this.busy = false; this.render(); }
    }, 'একাডেমিক কাঠামো তৈরি করুন');
  }

  /**
   * Screen 7 — the school's administrator accounts.
   *
   * Plural, since the R-7 completion pass. It created exactly one account and
   * advanced, so a school needing both a principal AND an IT admin — the
   * documented shape for anything larger than a village school (R-7.9) —
   * could not be finished here. The operator's only route to the second
   * account was SQL, which is the one thing this console exists to remove.
   *
   * Each account is created on its own and its code shown on its own, because
   * an activation code is displayed exactly once and two of them on screen
   * together is how one gets handed to the wrong person.
   */
  private screenAdmin(main: HTMLElement): void {
    const d = this.doc;

    // What this run has already created. An operator who has just made the
    // principal should see that before being asked for another name.
    if (this.adminsMade.length > 0) {
      const made = d.createElement('div');
      made.className = 'card platform-state';
      const mh = d.createElement('h2');
      mh.className = 'section-heading';
      mh.textContent = 'তৈরি হয়েছে';
      made.append(mh);
      const mlist = d.createElement('dl');
      mlist.className = 'detail-list';
      for (const a of this.adminsMade) {
        const div = d.createElement('div');
        const dt = d.createElement('dt'); dt.textContent = a.nameBn + ' · ' + a.roleBn;
        const dd = d.createElement('dd');
        // The code sits WITH the name. Two codes and two people is exactly the
        // situation in which one gets handed to the wrong person.
        dd.textContent = a.code;
        dd.className = 'mono state-ok';
        div.append(dt, dd); mlist.append(div);
      }
      made.append(mlist);
      const warn = d.createElement('p');
      warn.className = 'page-sub';
      warn.textContent = 'কোডগুলো এখনই লিখে নিন — সার্ভারে সংরক্ষণ করা হয় না, '
        + 'এই পাতা ছাড়লে আর দেখা যাবে না। ৭২ ঘণ্টা পর মেয়াদ শেষ।';
      made.append(warn);
      main.append(made);
    }

    const form = d.createElement('div');
    form.className = 'card card-form';
    const nameBn = this.field('নাম (বাংলা) *', 'text', '');
    const phone = this.field('মোবাইল *', 'text', '', '+৮৮০১… ফরম্যাটে');
    const ROLES: Record<string, string> = {
      principal: 'প্রধান শিক্ষক', school_owner: 'পরিচালক', it_admin: 'আইটি অ্যাডমিন',
    };
    // Suggest the role NOT yet made: after the principal, an IT admin is the
    // likely next account, and defaulting to principal again invites a
    // duplicate.
    const madeRoles = new Set(this.adminsMade.map((a) => a.roleCode));
    const suggested = madeRoles.has('principal') && !madeRoles.has('it_admin')
      ? 'it_admin' : 'principal';
    const role = this.select('ভূমিকা', ROLES, suggested);
    form.append(nameBn.wrap, phone.wrap, role.wrap);

    const note = d.createElement('p');
    note.className = 'page-sub';
    note.textContent = 'অ্যাক্টিভেশন কোড একবারই দেখানো হবে। কোডটি সংরক্ষণ করা হয় না — '
      + 'সরাসরি বা ফোনে দিন, ইমেইলে নয়।';
    form.append(note);
    main.append(form);

    /**
     * Create, and stay.
     *
     * The first version of this advanced to the next screen on the primary
     * button, which set the activation code and then navigated away from the
     * only screen that renders it — so the account was created and its code
     * was never seen. A code is shown once and stored nowhere; losing one
     * means the person it belongs to cannot log in, and the only repair is to
     * issue another.
     *
     * So the primary action creates and stays. Moving on is a separate,
     * explicit click, available once at least one account exists.
     */
    const create = async (): Promise<void> => {
      const p = phone.input.value.trim();
      if (!nameBn.input.value.trim()) { this.error = 'নাম দিন।'; this.render(); return; }
      if (!/^\+8801[3-9]\d{8}$/.test(p)) {
        this.error = 'মোবাইল নম্বর +৮৮০১… ফরম্যাটে দিন।'; this.render(); return;
      }
      this.busy = true; this.error = ''; this.render();
      try {
        const r = await this.call<{ activationCode: string; reused: boolean }>('admin', {
          method: 'POST',
          body: JSON.stringify({
            tenantId: this.tenantId, nameBn: nameBn.input.value.trim(),
            phone: p, roleCode: role.input.value,
          }),
        });
        this.activationCode = r.activationCode;
        this.adminsMade.push({
          nameBn: nameBn.input.value.trim(),
          roleCode: role.input.value,
          roleBn: ROLES[role.input.value] ?? role.input.value,
          code: r.activationCode,
        });
        this.notice = r.reused
          ? 'এই নম্বরের ব্যবহারকারী আগেই ছিল — নতুন অ্যাকাউন্ট না বানিয়ে ভূমিকা দেওয়া হয়েছে।'
          : 'প্রশাসক অ্যাকাউন্ট তৈরি হয়েছে — কোডটি নিচে দেখুন।';
      } catch (e) { this.error = (e as Error).message; }
      finally { this.busy = false; this.render(); }
    };

    const made = this.adminsMade.length > 0;
    this.nav(main, () => create(), made
      ? 'আরেকজন তৈরি করুন' : 'অ্যাকাউন্ট তৈরি করুন');
    const row = main.lastElementChild;
    (row?.lastElementChild as HTMLElement | null)?.setAttribute('data-action', 'create-admin');

    if (made) {
      // Only offered once an account exists, because a school cannot be
      // activated without one — `canActivate` gates on exactly this.
      const done = d.createElement('button');
      done.type = 'button';
      done.className = 'btn-primary btn-inline';
      done.textContent = 'পরবর্তী →';
      done.disabled = this.busy;
      done.dataset.action = 'admins-done';
      done.addEventListener('click', () => {
        this.step = 7; this.error = ''; this.notice = ''; this.render();
      });
      row?.append(done);
    }
  }

  /**
   * Screens 8 and 9 — the two imports, same shape.
   *
   * Dry run first, always. The button states the counts, so "৭৬৮টি ঠিক সারি
   * আমদানি করুন, ১৬টি বাদ" is on the control itself rather than in a message
   * above it — nothing is written until it is pressed.
   */
  private screenImport(main: HTMLElement, kind: 'teacher' | 'student'): void {
    const d = this.doc;
    const state = (this as unknown as {
      _imp?: Record<string, { digest: string; valid: number; rejected: number;
                              read: number; errorCsv: string | null; errors: unknown[];
                              // The exact text the dry run judged. Held because
                              // `render()` rebuilds the file input, so by the time
                              // the operator presses Import the file they chose is
                              // no longer attached to anything — the commit read
                              // an empty input and answered "choose a CSV file",
                              // one click after validating that very file.
                              //
                              // Keeping it is also what `digest` was always for:
                              // the bytes imported are now provably the bytes
                              // that were checked, rather than whatever is in the
                              // picker at the second click.
                              csv: string }>;
    });
    state._imp = state._imp ?? {};
    const prior = state._imp[kind];

    const form = d.createElement('div');
    form.className = 'card card-form';
    const label = d.createElement('label');
    label.className = 'field';
    const span = d.createElement('span');
    span.textContent = kind === 'teacher' ? 'শিক্ষকের CSV' : 'শিক্ষার্থীর CSV';
    const file = d.createElement('input');
    file.type = 'file'; file.accept = '.csv,text/csv'; file.className = 'field-input';
    label.append(span, file);
    form.append(label);

    const hint = d.createElement('p');
    hint.className = 'page-sub';
    hint.textContent = kind === 'teacher'
      ? 'কলাম: নাম, আইডি, মোবাইল — ইংরেজি বা বাংলা হেডার চলবে। '
        + 'সেকশন/বিষয় বণ্টন পরে, প্রতিষ্ঠানের নিজের পর্দা থেকে।'
      : 'কলাম: রোল, নাম, শ্রেণি, শাখা, অভিভাবকের মোবাইল। '
        + 'একই মোবাইলের দুই শিক্ষার্থী একজন অভিভাবকের দুই সন্তান হিসেবে যুক্ত হবে।';
    form.append(hint);
    main.append(form);

    if (prior) {
      const summary = d.createElement('p');
      summary.className = 'status-chip';
      summary.setAttribute('aria-live', 'polite');
      summary.textContent = `পড়া হয়েছে ${bnNum(prior.read)} · ঠিক ${bnNum(prior.valid)}`
        + ` · বাদ ${bnNum(prior.rejected)}`;
      main.append(summary);

      if (prior.errorCsv) {
        // Built by the server so the file the operator opens is
        // byte-identical to the one the server judged.
        const dl = d.createElement('a');
        dl.className = 'btn-secondary';
        dl.href = `data:text/csv;charset=utf-8,${encodeURIComponent(prior.errorCsv)}`;
        dl.download = `${kind}-errors.csv`;
        dl.textContent = 'ভুলের তালিকা নামান';
        main.append(dl);
      }
    }

    const readFile = async (): Promise<string | null> => {
      const f = file.files?.[0];
      if (!f) { this.error = 'একটি CSV ফাইল বেছে নিন।'; this.render(); return null; }
      return f.text();
    };

    const row = d.createElement('div');
    row.className = 'action-row';

    const back = d.createElement('button');
    back.type = 'button'; back.className = 'btn-secondary';
    back.textContent = '← আগের';
    back.disabled = this.busy;
    back.addEventListener('click', () => { this.step--; this.error = ''; this.render(); });
    row.append(back);

    const skip = d.createElement('button');
    skip.type = 'button'; skip.className = 'btn-ghost btn-small';
    skip.textContent = 'এই ধাপ বাদ দিন';
    skip.disabled = this.busy;
    skip.addEventListener('click', () => {
      if (this.step === 8) { this.finish(); return; }
      this.step++; this.error = ''; this.notice = ''; this.render();
    });
    row.append(skip);

    const check = d.createElement('button');
    check.type = 'button'; check.className = 'btn-secondary';
    check.textContent = 'যাচাই করুন';
    check.disabled = this.busy;
    check.addEventListener('click', async () => {
      const csv = await readFile();
      if (csv === null) return;
      this.busy = true; this.error = ''; this.render();
      try {
        const r = await this.call<{ digest: string; rowsValid: number; rowsRejected: number;
                                    rowsRead: number; errorCsv: string | null; errors: unknown[] }>(
          'import', {
            method: 'POST',
            body: JSON.stringify({ tenantId: this.tenantId, kind, csv,
                                   fileName: file.files?.[0]?.name }),
          });
        state._imp![kind] = {
          digest: r.digest, valid: r.rowsValid, rejected: r.rowsRejected,
          read: r.rowsRead, errorCsv: r.errorCsv, errors: r.errors,
          // The text that was actually judged — see the note on `csv` above.
          csv,
        };
        this.notice = r.rowsRejected === 0
          ? 'সব সারি ঠিক আছে — এখন আমদানি করুন।'
          : 'কিছু সারিতে ভুল আছে — তালিকা দেখে ঠিক করুন, অথবা বাকিগুলো আমদানি করুন।';
      } catch (e) { this.error = (e as Error).message; }
      finally { this.busy = false; this.render(); }
    });
    row.append(check);

    if (prior && prior.valid > 0) {
      const commit = d.createElement('button');
      commit.type = 'button'; commit.className = 'btn-primary btn-inline';
      // The count is ON the button. §10.2 — never a silent truncation.
      commit.textContent = prior.rejected > 0
        ? `${bnNum(prior.valid)}টি ঠিক সারি আমদানি করুন, ${bnNum(prior.rejected)}টি বাদ`
        : `${bnNum(prior.valid)}টি আমদানি করুন`;
      commit.disabled = this.busy;
      commit.addEventListener('click', async () => {
        // Re-selecting is still allowed: a picked file wins, so an operator who
        // deliberately chooses a corrected file gets the corrected file.
        const csv = (file.files?.length ? await readFile() : prior.csv) ?? null;
        if (csv === null) return;
        this.busy = true; this.error = ''; this.render();
        try {
          const r = await this.call<{ rowsImported: number }>('import', {
            method: 'POST',
            body: JSON.stringify({
              tenantId: this.tenantId, kind, csv, commit: true, digest: prior.digest,
              fileName: file.files?.[0]?.name,
            }),
          });
          this.notice = `${bnNum(r.rowsImported)} জন আমদানি হয়েছে।`;
          delete state._imp![kind];
          if (this.step === 8) { this.finish(); return; }
          this.step++;
        } catch (e) { this.error = (e as Error).message; }
        finally { this.busy = false; this.render(); }
      });
      row.append(commit);
    }

    main.append(row);
  }

  /** Screen 9's end: hand the operator the review, where Activate lives. */
  private finish(): void {
    this.view = 'detail';
    this.notice = 'সব ধাপ শেষ। নিচের তালিকা দেখে সক্রিয় করুন।';
    this.busy = false;
    if (this.tenantId) void this.loadDetail(this.tenantId);
    else this.render();
  }
}

/**
 * Dark mode is an explicit `data-theme` attribute in this design system, not
 * a media query — so a page that never sets it renders its LIGHT palette on
 * whatever ground the browser paints. On a dark-preference machine that put
 * `#1f2937` text on black, which is how the first screenshot of this console
 * came out unreadable. The tenant app sets the attribute from its own
 * settings; the console has no school to ask, so it follows the operator's
 * machine.
 */
function applyTheme(): void {
  const dark = matchMedia('(prefers-color-scheme: dark)').matches;
  document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
}

/**
 * Boot only in a browser.
 *
 * This file used to call `matchMedia` and `getElementById` at module scope,
 * which made it impossible to import outside a browser — so the nine screens
 * that are the only way an institution comes into existence had no test file
 * at all, and a college spent a phase being listed as a madrasa. The guard
 * costs one condition and buys the suite.
 */
if (typeof document !== 'undefined' && typeof matchMedia !== 'undefined') {
  applyTheme();
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);
  const root = document.getElementById('root');
  if (root) new Console_(root);
}
