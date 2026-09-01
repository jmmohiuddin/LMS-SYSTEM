/**
 * The shikhonBD Platform Operations Center.  (P7)
 *
 * Not a restyle of the R-7 console: a different product on the same
 * credentials. R-7 built a PROVISIONING tool — create a school, brand it,
 * make the first admin, import a roster — and it does that well. What it
 * could not do is OPERATE the schools afterwards, which is what a team
 * running forty institutions actually spends its day on.
 *
 * ── What P7-1's inventory found, and what this is for ─────────────────────
 *
 * `app.set_tenant_status` wrote `tenants.status`, the console had a button
 * for it, the audit log recorded it — and not one line of application code
 * read that column. An operator could suspend a school, get a success
 * message, and the school kept working.
 *
 * So the console is only half the fix. Migrations 051/052 made the state
 * real; this is the surface that lets a person see and change it without
 * writing SQL. Every control here maps to a database function that bites, and
 * every one of them says what it will do before it does it.
 *
 * ── Canonical, but denser ────────────────────────────────────────────────
 * Same tokens, same primitives, same shell as every tenant screen (§31). What
 * differs is density: an operator comparing forty schools needs a table, not
 * forty cards, and needs the numbers that decide an action in the same row as
 * the action.
 */
import {
  pageHeader, sectionHeading, card, button, buttonRow, dataTable, statusBadge,
  statRow, statCard, field, setFieldError, clearFieldError, tabs, openDrawer,
  setOverlayBody, listSkeleton, el, append, type OverlayHandle, type Field,
} from './ui/index.ts';
import {
  emptyState, errorState, successNote, confirmDialog, bnNum, bnDate, bnDateTime,
} from './view-states.ts';
import { formatBdt, formatCount, todayLocalIso } from '../../../packages/ui-core/src/format.ts';

const bn = (n: number): string => formatCount(n, 'bn');

/** How many attention rows the dashboard shows before it says "and N more". */
const QUEUE_LIMIT = 20;

/** How many recent platform actions the dashboard shows. */
const FEED_LIMIT = 12;

// ── Shapes the platform API returns ────────────────────────────────────

export interface TenantOverview {
  id: string;
  slug: string;
  nameBn: string;
  nameEn: string;
  stream: string;
  level: string;
  district: string | null;
  status: string;
  access: 'full' | 'read_only' | 'none';
  opsState: string;
  billingState: string;
  stateReason: string | null;
  planCode: string;
  planName: string | null;
  planPrice: string | null;
  billingCycle: string | null;
  studentCap: number;
  studentCount: number;
  userCount: number;
  paidTotal: string;
  nextDueOn: string | null;
  graceUntil: string | null;
  trialEndsOn: string | null;
  createdAt: string;
  /** Last real sign-in or product event. Null = never used. */
  lastActiveAt: string | null;
  portals: Record<string, boolean>;
  services: Record<string, string>;
}

export interface ServiceRow { code: string; nameBn: string; effectBn: string; dependsOn: string[]; inLimited: boolean }
export interface PlanRow {
  code: string; nameBn: string; priceBdt: string; billingCycle: string;
  studentCap: number; services: Record<string, boolean>; trialDays: number;
  graceDays: number; isActive: boolean;
}
export interface PaymentRow {
  amountBdt: string; paidOn: string; method: string; reference: string | null;
  note: string | null; coversUntil: string | null; recordedAt: string;
}
export interface AuditRow {
  id: string; reason: string | null; statement: string | null; at: string;
  /** Present on the cross-institution feed; null for a platform-wide act. */
  tenantId?: string | null;
}
export interface Operations {
  access: string; opsState: string; billingState: string;
  reasonBn: string | null; until: string | null;
  stateReason: string | null; stateChangedAt: string | null; stateUntil: string | null;
  portals: Record<string, boolean>;
  serviceOverrides: Record<string, string>;
  planCode: string; planName: string | null; planPrice: string | null;
  billingCycle: string | null; graceDays: number | null;
  planCap: number | null; planServices: Record<string, boolean>;
  studentCap: number; studentCount: number;
  nextDueOn: string | null; graceUntil: string | null; graceReason: string | null;
  trialEndsOn: string | null;
}

// ── Vocabulary ─────────────────────────────────────────────────────────

/**
 * The four operational states, as a person reads them.
 *
 * `limited` and `suspended` are deliberately different words with different
 * tones: one is a bill and the other is a decision, and an operator must
 * never reach for the wrong one because they looked alike.
 */
export const OPS_BN: Record<string, { label: string; state: string; effect: string }> = {
  active: {
    label: 'সক্রিয়', state: 'published',
    effect: 'প্ল্যানে যা আছে, সব কিছু চলছে।',
  },
  maintenance: {
    label: 'রক্ষণাবেক্ষণ', state: 'invited',
    effect: 'শুধু দেখা যাবে — কোনো পরিবর্তন সংরক্ষণ হবে না। '
      + 'এটি আমাদের সিদ্ধান্ত, বকেয়ার সাথে সম্পর্ক নেই।',
  },
  limited: {
    label: 'সীমিত', state: 'partial',
    effect: 'শুধু দেখা যাবে। হাজিরা, ফলাফল, নোটিশ ও শিক্ষাপঞ্জি পড়া যাবে; '
      + 'নতুন কিছু লেখা যাবে না।',
  },
  suspended: {
    label: 'স্থগিত', state: 'overdue',
    effect: 'প্রতিষ্ঠানের কেউ প্রবেশ করতে পারবেন না। '
      + 'কোনো তথ্য মুছবে না — সব অক্ষত থাকবে এবং পুনরায় চালু করলে ফিরে আসবে।',
  },
};

export const BILLING_BN: Record<string, { label: string; state: string }> = {
  trial:        { label: 'ট্রায়াল',       state: 'invited' },
  active:       { label: 'পরিশোধিত',     state: 'published' },
  grace_period: { label: 'ছাড়ের মেয়াদে', state: 'partial' },
  limited:      { label: 'বকেয়া',        state: 'overdue' },
};

export const SERVICE_STATE_BN: Record<string, { label: string; state: string }> = {
  enabled:     { label: 'চালু',            state: 'published' },
  limited:     { label: 'শুধু পড়া',        state: 'partial' },
  maintenance: { label: 'রক্ষণাবেক্ষণ',    state: 'invited' },
  disabled:    { label: 'বন্ধ',            state: 'overdue' },
  not_in_plan: { label: 'প্ল্যানে নেই',    state: 'draft' },
  unknown:     { label: 'অজানা',           state: 'draft' },
};

export const PORTAL_BN: Record<string, string> = {
  principal: 'প্রধান শিক্ষক ও মালিক',
  it_admin: 'আইটি অ্যাডমিন',
  teacher: 'শিক্ষক ও কর্মী',
  student: 'শিক্ষার্থী',
  guardian: 'অভিভাবক',
};

export const METHOD_BN: Record<string, string> = {
  bank: 'ব্যাংক', bkash: 'bKash', nagad: 'Nagad', rocket: 'Rocket',
  cash: 'নগদ', cheque: 'চেক', other: 'অন্যান্য',
};

// ── Attention ──────────────────────────────────────────────────────────

export interface Attention {
  tenantId: string;
  nameBn: string;
  kind: string;
  labelBn: string;
  /** Higher sorts first. Money and lock-outs outrank a cap warning. */
  weight: number;
}

/**
 * What needs a person today, derived from the same rows the table shows.
 *
 * Deliberately NOT a separate endpoint: an attention queue computed from
 * different data than the list beside it is an attention queue that
 * eventually disagrees with the list beside it.
 */
/** How long a school may sit empty before it stops being "being set up". */
export const ONBOARDING_WINDOW_DAYS = 30;

const DAY_MS = 86_400_000;

/**
 * Created a while ago and still has nobody in it.
 *
 * Deliberately not an alert: nothing is broken and nothing is urgent. It is a
 * number an operator should be able to see and filter by — §1's "recently
 * inactive" — and that is all.
 */
export function isDormant(t: TenantOverview, now = Date.now()): boolean {
  if (t.studentCount > 0 || t.userCount > 1) return false;
  const born = Date.parse(t.createdAt);
  if (Number.isNaN(born)) return false;
  return now - born > ONBOARDING_WINDOW_DAYS * DAY_MS;
}

/** Created within the onboarding window — §1's "recently onboarded". */
export function isRecent(t: TenantOverview, now = Date.now()): boolean {
  const born = Date.parse(t.createdAt);
  if (Number.isNaN(born)) return false;
  return now - born <= ONBOARDING_WINDOW_DAYS * DAY_MS;
}

/** How long a school may go untouched before it is worth asking about. */
export const QUIET_DAYS = 30;

/**
 * Set up, and then nobody came back — §26's "recently inactive".
 *
 * Distinct from `isDormant`, which is about a school that was never filled
 * in. This one has students and users and has simply not been OPENED, which
 * is the quieter and more expensive failure: a school that was onboarded,
 * invoiced, and is not being used.
 *
 * Measured from real sign-ins and real product events (migration 057). A
 * school created three days ago with nobody in it yet is not "quiet" — it is
 * new, and `isRecent` already counts it.
 */
export function isQuiet(t: TenantOverview, now = Date.now()): boolean {
  if (isRecent(t, now) || isDormant(t, now)) return false;
  if (!t.lastActiveAt) return true;
  const seen = Date.parse(t.lastActiveAt);
  if (Number.isNaN(seen)) return false;
  return now - seen > QUIET_DAYS * DAY_MS;
}

export function attentionQueue(rows: TenantOverview[], now = Date.now()): Attention[] {
  const out: Attention[] = [];
  for (const t of rows) {
    // Ranked by how many people are stopped, not by how alarming it sounds.
    // A suspended school is a total outage; an overdue one still works for
    // reading; a full roll stops only the next admission.
    if (t.access === 'none') {
      out.push({ tenantId: t.id, nameBn: t.nameBn, kind: 'suspended', weight: 100,
        labelBn: 'স্থগিত — কেউ প্রবেশ করতে পারছেন না' });
    }
    if (t.billingState === 'limited') {
      out.push({ tenantId: t.id, nameBn: t.nameBn, kind: 'overdue', weight: 95,
        labelBn: t.nextDueOn
          ? `বকেয়া — শেষ তারিখ ছিল ${bnDate(t.nextDueOn)}`
          : 'বকেয়া' });
    } else if (t.billingState === 'grace_period') {
      out.push({ tenantId: t.id, nameBn: t.nameBn, kind: 'grace', weight: 70,
        labelBn: t.graceUntil
          ? `ছাড়ের মেয়াদ ${bnDate(t.graceUntil)} পর্যন্ত`
          : 'ছাড়ের মেয়াদে চলছে' });
    }
    // A school that cannot enrol its next child has a problem it cannot see
    // until a parent is standing at the desk.
    const cap = t.studentCap || 0;
    if (cap > 0 && t.studentCount >= cap) {
      out.push({ tenantId: t.id, nameBn: t.nameBn, kind: 'cap_full', weight: 90,
        labelBn: `শিক্ষার্থীর সীমা পূর্ণ — ${bn(t.studentCount)} / ${bn(cap)}` });
    } else if (cap > 0 && t.studentCount >= cap * 0.9) {
      out.push({ tenantId: t.id, nameBn: t.nameBn, kind: 'cap_near', weight: 60,
        labelBn: `সীমার কাছাকাছি — ${bn(t.studentCount)} / ${bn(cap)}` });
    }
    const closed = Object.entries(t.portals).filter(([, open]) => open === false);
    if (closed.length > 0) {
      out.push({ tenantId: t.id, nameBn: t.nameBn, kind: 'portal', weight: 80,
        labelBn: `${closed.map(([k]) => PORTAL_BN[k] ?? k).join(', ')} — প্রবেশ বন্ধ` });
    }
    const off = Object.entries(t.services).filter(([, v]) => v === 'disabled');
    if (off.length > 0) {
      out.push({ tenantId: t.id, nameBn: t.nameBn, kind: 'service', weight: 50,
        labelBn: `${bn(off.length)}টি সেবা বন্ধ করা আছে` });
    }
    // Never onboarded: a school created and then forgotten is the quietest
    // failure on this screen, because nobody complains about it.
    //
    // But only while somebody could still plausibly be onboarding it. Past
    // that this is not a task anybody is going to do today, and left
    // unbounded it produced thirty identical rows that buried the outages
    // above. Older empty schools are counted on the dashboard instead — see
    // `dormant`.
    if (t.studentCount === 0 && t.userCount <= 1 && !isDormant(t, now)) {
      out.push({ tenantId: t.id, nameBn: t.nameBn, kind: 'onboarding', weight: 40,
        labelBn: 'অসম্পূর্ণ সেটআপ — কোনো শিক্ষার্থী যোগ হয়নি' });
    }
  }
  return out.sort((a, b) => b.weight - a.weight || a.nameBn.localeCompare(b.nameBn));
}

export interface OpsViewOptions {
  root: HTMLElement;
  doc: Document;
  /** Calls the platform API with the operator's token and key. */
  call<T>(path: string, init?: RequestInit): Promise<T>;
  /** Open the R-7 provisioning detail for one school. */
  onOpenTenant(id: string): void;
  /** Start the R-7 creation wizard. */
  onNewTenant(): void;
}

type Tab = 'dashboard' | 'institutions' | 'plans';

export class PlatformOpsView {
  private readonly o: OpsViewOptions;
  private tab: Tab = 'dashboard';
  private rows: TenantOverview[] = [];
  private services: ServiceRow[] = [];
  private plans: PlanRow[] = [];
  private loading = true;
  private error = '';
  private notice = '';
  private search = '';
  private filter = 'all';
  private drawer: OverlayHandle | null = null;
  private openId: string | null = null;
  private ops: Operations | null = null;
  private effective: Array<{ code: string; state: string }> = [];
  private payments: PaymentRow[] = [];
  private audit: AuditRow[] = [];
  /** §27 — the same trail, across every school. Read once with the list. */
  private feed: AuditRow[] = [];
  private detailTab = 'overview';
  private busy = false;

  constructor(options: OpsViewOptions) {
    this.o = options;
    this.render();
    void this.load();
  }

  // ── data ─────────────────────────────────────────────────────────────
  private async load(): Promise<void> {
    this.loading = true; this.error = ''; this.render();
    try {
      const [ov, cat, feed] = await Promise.all([
        this.o.call<{ tenants: TenantOverview[] }>('/overview'),
        this.o.call<{ plans: PlanRow[]; services: ServiceRow[] }>('/catalogue'),
        // Its own failure: a console that cannot show its history is still a
        // console that must show its schools.
        this.o.call<{ entries: AuditRow[] }>('/audit').catch(() => ({ entries: [] })),
      ]);
      this.rows = ov.tenants;
      this.plans = cat.plans;
      this.services = cat.services;
      this.feed = feed.entries;
    } catch (err) {
      this.error = (err as Error).message || 'তালিকা আনা যায়নি।';
    }
    this.loading = false;
    this.render();
  }

  private async openDetail(id: string): Promise<void> {
    this.openId = id;
    this.detailTab = 'overview';
    this.ops = null;
    this.renderDrawer();
    try {
      const [r, a] = await Promise.all([
        this.o.call<{
          operations: Operations;
          services: Array<{ code: string; state: string }>;
          payments: PaymentRow[];
        }>(`/operations?id=${encodeURIComponent(id)}`),
        // Its own request and its own failure: a school whose history cannot
        // be read is still a school an operator must be able to act on.
        this.o.call<{ entries: AuditRow[] }>(
          `/audit?tenantId=${encodeURIComponent(id)}`).catch(() => ({ entries: [] })),
      ]);
      this.ops = r.operations;
      this.effective = r.services;
      this.payments = r.payments;
      this.audit = a.entries;
    } catch (err) {
      this.error = (err as Error).message || 'তথ্য আনা যায়নি।';
    }
    this.renderDrawer();
  }

  /**
   * Every operations POST goes through here.
   *
   * The endpoint returns the school's state AFTER the change, so the drawer
   * renders the consequence rather than re-fetching and possibly showing a
   * state one request out of date.
   */
  private async act(path: string, body: Record<string, unknown>, done: string): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.renderDrawer();
    try {
      await this.o.call(path, { method: 'POST', body: JSON.stringify(body) });
      this.notice = done;
      this.busy = false;
      // Both surfaces move: the drawer shows the new state, and the row
      // behind it stops disagreeing with the drawer in front of it.
      await Promise.all([this.load(), this.openDetail(String(body.tenantId))]);
    } catch (err) {
      this.busy = false;
      this.error = (err as Error).message || 'কাজটি সম্পন্ন হয়নি।';
      this.renderDrawer();
      this.render();
    }
  }

  // ── the page ─────────────────────────────────────────────────────────
  private render(): void {
    const d = this.o.doc;
    const root = this.o.root;
    root.replaceChildren();

    root.append(pageHeader(d, {
      title: 'প্ল্যাটফর্ম অপারেশনস',
      subtitle: this.loading
        ? 'লোড হচ্ছে…'
        : `${bn(this.rows.length)}টি প্রতিষ্ঠান পরিচালনায়`,
      actions: [
        button(d, {
          label: 'নতুন প্রতিষ্ঠান', variant: 'primary', glyph: 'star',
          onClick: () => this.o.onNewTenant(),
        }),
        button(d, {
          label: 'হালনাগাদ', variant: 'ghost', glyph: 'refresh',
          onClick: () => { void this.load(); },
        }),
      ],
    }));

    if (this.notice) root.append(successNote(d, this.notice));
    if (this.error) root.append(errorState(d, this.error, () => { void this.load(); }));
    if (this.loading) { root.append(listSkeleton(d, 5)); return; }

    root.append(tabs(d, {
      label: 'অপারেশনস',
      active: this.tab,
      items: [
        { id: 'dashboard', label: 'ড্যাশবোর্ড' },
        { id: 'institutions', label: 'প্রতিষ্ঠান', count: this.rows.length },
        { id: 'plans', label: 'প্ল্যান', count: this.plans.length },
      ],
      onSelect: (id) => { this.tab = id as Tab; this.render(); },
    }));

    if (this.tab === 'dashboard') this.renderDashboard(root);
    else if (this.tab === 'plans') this.renderPlans(root);
    else this.renderList(root);
  }

  // ── 3. the plan catalogue (§16) ──────────────────────────────────────
  //
  // A plan is not a property of one school. Editing one from inside a
  // school's drawer would read as though it only touched that school, and it
  // touches every school on it — so it lives here, and the number of schools
  // affected is on the button that does it.
  private renderPlans(root: HTMLElement): void {
    const d = this.o.doc;
    const usedBy = (code: string) => this.rows.filter((t) => t.planCode === code).length;

    root.append(sectionHeading(d, {
      title: 'প্ল্যান',
      action: button(d, {
        label: 'নতুন প্ল্যান', variant: 'secondary', glyph: 'layers',
        onClick: () => this.planForm(null),
      }),
    }));

    root.append(card(d, { title: 'প্ল্যান কী ঠিক করে', glyph: 'layers', headingLevel: 3 },
      el(d, 'p', {
        className: 'ui-card-note',
        text: 'প্ল্যান ঠিক করে মূল্য, শিক্ষার্থীর সর্বোচ্চ সংখ্যা, কোন সেবাগুলো কেনা আছে, '
          + 'এবং বিল দেরি হলে কত দিন ছাড় পাওয়া যাবে। প্ল্যান বদলালে সেই প্ল্যানের '
          + 'প্রতিটি প্রতিষ্ঠানে সঙ্গে সঙ্গে কার্যকর হয়।',
      })));

    root.append(dataTable(d, {
      caption: 'প্ল্যানের তালিকা',
      rows: this.plans,
      rowKey: (p) => p.code,
      onRowClick: (p) => this.planForm(p),
      columns: [
        { key: 'name', header: 'প্ল্যান', mobile: 'title',
          cell: (p) => p.nameBn, width: 'minmax(0, 1.4fr)' },
        { key: 'price', header: 'মূল্য', mobile: 'subtitle', numeric: true, width: '180px',
          cell: (p) => `${formatBdt(p.priceBdt)} / ${CYCLE_BN[p.billingCycle] ?? p.billingCycle}` },
        { key: 'cap', header: 'সীমা', mobile: 'meta', numeric: true, width: '110px',
          cell: (p) => bn(p.studentCap) },
        { key: 'svc', header: 'সেবা', mobile: 'meta', numeric: true, width: '110px',
          cell: (p) => `${bn(Object.values(p.services).filter(Boolean).length)}টি` },
        { key: 'used', header: 'প্রতিষ্ঠান', mobile: 'meta', numeric: true, width: '120px',
          cell: (p) => `${bn(usedBy(p.code))}টি` },
        { key: 'state', header: 'অবস্থা', mobile: 'status', width: '130px',
          cell: (p) => statusBadge(d, p.isActive
            ? { state: 'paid', label: 'চালু' }
            : { state: 'draft', label: 'বন্ধ' }) },
      ],
    }));
  }

  /**
   * Create or change a plan.
   *
   * The WHOLE plan is submitted, never a patch: a partial update of a price
   * list is how a plan ends up carrying a new price and last year's services.
   */
  private planForm(existing: PlanRow | null): void {
    const d = this.o.doc;
    const affected = existing
      ? this.rows.filter((t) => t.planCode === existing.code).length : 0;

    const code = field(d, {
      label: 'কোড', name: 'code', value: existing?.code ?? '', required: !existing,
      helper: existing
        ? 'কোড বদলানো যায় না — এটি প্রতিষ্ঠানের সঙ্গে যুক্ত।'
        : 'ছোট হাতের ইংরেজি, যেমন: standard_plus। পরে আর বদলানো যাবে না।',
      attrs: existing ? { readonly: 'readonly' } : {},
    });
    const nameBn = field(d, { label: 'নাম', name: 'nameBn', required: true,
      value: existing?.nameBn ?? '' });
    const price = field(d, { label: 'মূল্য (৳)', name: 'priceBdt', kind: 'number',
      required: true, value: existing ? String(Number(existing.priceBdt)) : '',
      attrs: { min: 0, step: '0.01' } });
    const cycle = field(d, {
      label: 'বিলিং চক্র', name: 'billingCycle', kind: 'select',
      value: existing?.billingCycle ?? 'yearly',
      options: Object.entries(CYCLE_BN).map(([value, label]) => ({ value, label })),
    });
    const cap = field(d, { label: 'শিক্ষার্থীর সীমা', name: 'studentCap', kind: 'number',
      required: true, value: existing ? String(existing.studentCap) : '',
      attrs: { min: 1, step: 1 } });
    const trial = field(d, { label: 'ট্রায়াল (দিন)', name: 'trialDays', kind: 'number',
      value: String(existing?.trialDays ?? 30), attrs: { min: 0, max: 365, step: 1 } });
    const grace = field(d, { label: 'ছাড় (দিন)', name: 'graceDays', kind: 'number',
      value: String(existing?.graceDays ?? 14), attrs: { min: 0, max: 365, step: 1 },
      helper: 'বিলের শেষ তারিখের পর কত দিন প্রতিষ্ঠান পূর্ণ সক্রিয় থাকবে।' });

    // Which services the plan buys, in the same table shape the
    // per-institution service tab uses — including the "বন্ধ করলে" column,
    // because leaving a service OUT of a plan and switching it off for one
    // school have the same consequence and should read the same way.
    const YESNO = [{ value: 'yes', label: 'আছে' }, { value: 'no', label: 'নেই' }];
    const picks = new Map<string, Field>();
    for (const svc of this.services) {
      picks.set(svc.code, field(d, {
        label: svc.nameBn, name: `svc_${svc.code}`, kind: 'select', options: YESNO,
        value: (existing ? existing.services[svc.code] === true : true) ? 'yes' : 'no',
      }));
    }
    const list = dataTable(d, {
      caption: 'এই প্ল্যানে কোন সেবাগুলো আছে',
      rows: this.services,
      rowKey: (s) => s.code,
      columns: [
        { key: 'name', header: 'সেবা', mobile: 'title', cell: (s) => s.nameBn,
          width: 'minmax(0, 1.2fr)' },
        { key: 'effect', header: 'না থাকলে', mobile: 'subtitle', cell: (s) => s.effectBn,
          width: 'minmax(0, 2.4fr)' },
        { key: 'in', header: 'প্ল্যানে', mobile: 'status', width: '130px',
          cell: (s) => picks.get(s.code)!.root },
      ],
    });

    const active = field(d, {
      label: 'নতুন প্রতিষ্ঠানে দেওয়া যাবে', name: 'isActive', kind: 'select',
      options: YESNO, value: (existing ? existing.isActive : true) ? 'yes' : 'no',
      helper: '"নেই" করলে নতুন প্রতিষ্ঠানে এই প্ল্যান বেছে নেওয়া যাবে না। '
        + 'যেসব প্রতিষ্ঠান এখন এই প্ল্যানে আছে, তাদের কিছুই বদলাবে না।',
    });
    const why = field(d, { label: 'কারণ', name: 'reason', required: true,
      placeholder: existing ? 'যেমন: ২০২৭ সালের মূল্য তালিকা' : 'যেমন: নতুন প্যাকেজ চালু' });

    const form = el(d, 'div', { className: 'ui-card-form' });
    append(form, code.root, nameBn.root, price.root, cycle.root, cap.root,
      trial.root, grace.root,
      sectionHeading(d, { title: 'সেবা' }), list,
      active.root, why.root);

    if (existing && affected > 0) {
      append(form, card(d, {
        title: 'এই বদল কাদের ছোঁবে', glyph: 'alert-triangle', tone: 'warn', headingLevel: 3,
      }, el(d, 'p', {
        className: 'ui-card-note',
        text: `এখন ${bn(affected)}টি প্রতিষ্ঠান এই প্ল্যানে আছে। মূল্য, সীমা বা সেবা `
          + 'বদলালে সঙ্গে সঙ্গে সবার ক্ষেত্রে কার্যকর হবে — প্ল্যান থেকে বাদ দেওয়া '
          + 'সেবা তখনই বন্ধ হয়ে যাবে।',
      })));
    }

    const drawer = openDrawer(d, {
      title: existing ? `${existing.nameBn} — পরিবর্তন` : 'নতুন প্ল্যান',
      body: form,
      actions: [button(d, {
        label: existing ? 'সংরক্ষণ করুন' : 'প্ল্যান তৈরি করুন',
        variant: 'primary', busy: this.busy,
        onClick: () => {
          for (const f of [code, nameBn, price, cap, why]) clearFieldError(f.root);
          if (!existing && !/^[a-z][a-z0-9_]{1,30}$/.test(code.value().trim())) {
            setFieldError(code.root, 'ছোট হাতের ইংরেজি অক্ষর দিয়ে শুরু করুন, ২–৩১ অক্ষর।');
            return;
          }
          if (!nameBn.value().trim()) { setFieldError(nameBn.root, 'নাম লিখুন।'); return; }
          if (!(Number(price.value()) >= 0)) { setFieldError(price.root, 'মূল্য দিন।'); return; }
          if (!(Number(cap.value()) >= 1)) { setFieldError(cap.root, 'সীমা দিন।'); return; }
          if (!why.value().trim()) {
            setFieldError(why.root, 'কারণ লিখুন।');
            why.input.focus();
            return;
          }
          const services: Record<string, boolean> = {};
          for (const [c, f] of picks) services[c] = f.value() === 'yes';
          const body = {
            code: (existing?.code ?? code.value()).trim().toLowerCase(),
            nameBn: nameBn.value().trim(),
            priceBdt: Number(price.value()),
            billingCycle: cycle.value(),
            studentCap: Number(cap.value()),
            trialDays: Number(trial.value()),
            graceDays: Number(grace.value()),
            services,
            isActive: active.value() === 'yes',
            reason: why.value().trim(),
          };
          const go = (): void => { drawer.close(); void this.commitPlan(body, existing !== null); };
          // A plan with schools on it is a change to all of them at once, so
          // the number is read before the change, not after it.
          if (existing && affected > 0) {
            const dlg = confirmDialog({
              doc: d,
              title: 'প্ল্যান পরিবর্তন — নিশ্চিত করুন',
              body: `${bn(affected)}টি প্রতিষ্ঠান এই প্ল্যানে আছে। পরিবর্তনটি `
                + 'সবার ক্ষেত্রে সঙ্গে সঙ্গে কার্যকর হবে।',
              confirmLabel: 'পরিবর্তন করুন',
              danger: true,
              onConfirm: go,
            });
            append(form, dlg);
            dlg.scrollIntoView({ block: 'nearest' });
            (dlg.querySelector('button') as HTMLElement | null)?.focus();
            return;
          }
          go();
        },
      })],
      onClose: () => { /* nothing is held open by this drawer */ },
    });
  }

  private async commitPlan(body: Record<string, unknown>, existed: boolean): Promise<void> {
    this.busy = true;
    try {
      const r = await this.o.call<{ affected: number }>('/plans', {
        method: 'POST', body: JSON.stringify(body),
      });
      this.notice = existed
        ? `প্ল্যান হালনাগাদ হয়েছে — ${bn(r.affected)}টি প্রতিষ্ঠানে কার্যকর।`
        : 'নতুন প্ল্যান তৈরি হয়েছে।';
      this.busy = false;
      await this.load();
    } catch (err) {
      this.busy = false;
      this.error = (err as Error).message || 'প্ল্যান সংরক্ষণ করা যায়নি।';
      this.render();
    }
  }

  // ── 1. dashboard ─────────────────────────────────────────────────────
  private renderDashboard(root: HTMLElement): void {
    const d = this.o.doc;
    const r = this.rows;
    const by = (f: (t: TenantOverview) => boolean) => r.filter(f).length;

    root.append(sectionHeading(d, { title: 'প্রতিষ্ঠান' }));
    root.append(statRow(d,
      statCard(d, { label: 'মোট', value: bn(r.length), glyph: 'layers' }),
      statCard(d, {
        label: 'পূর্ণ সক্রিয়', value: bn(by((t) => t.access === 'full')),
        glyph: 'check-square', tone: 'success',
      }),
      statCard(d, {
        label: 'শুধু পড়া', value: bn(by((t) => t.access === 'read_only')),
        glyph: 'lock', tone: 'warn',
        note: 'সীমিত বা রক্ষণাবেক্ষণে',
      }),
      statCard(d, {
        label: 'স্থগিত', value: bn(by((t) => t.access === 'none')),
        glyph: 'alert-triangle',
        tone: by((t) => t.access === 'none') > 0 ? 'accent2' : 'success',
      }),
    ));

    root.append(sectionHeading(d, { title: 'বাণিজ্যিক অবস্থা' }));
    root.append(statRow(d,
      statCard(d, {
        label: 'ট্রায়ালে', value: bn(by((t) => t.billingState === 'trial')),
        glyph: 'clock', tone: 'info',
      }),
      statCard(d, {
        label: 'পরিশোধিত', value: bn(by((t) => t.billingState === 'active')),
        glyph: 'wallet', tone: 'success',
      }),
      statCard(d, {
        label: 'ছাড়ের মেয়াদে', value: bn(by((t) => t.billingState === 'grace_period')),
        glyph: 'clock', tone: 'warn',
      }),
      statCard(d, {
        label: 'বকেয়া', value: bn(by((t) => t.billingState === 'limited')),
        glyph: 'alert-triangle',
        tone: by((t) => t.billingState === 'limited') > 0 ? 'accent2' : 'success',
      }),
    ));

    root.append(sectionHeading(d, { title: 'ব্যবহার' }));
    const students = r.reduce((n, t) => n + t.studentCount, 0);
    const users = r.reduce((n, t) => n + t.userCount, 0);
    const collected = r.reduce((n, t) => n + Number(t.paidTotal || 0), 0);
    root.append(statRow(d,
      statCard(d, { label: 'মোট শিক্ষার্থী', value: bn(students), glyph: 'users' }),
      statCard(d, { label: 'সক্রিয় ব্যবহারকারী', value: bn(users), glyph: 'user', tone: 'info' }),
      statCard(d, {
        label: 'মোট আদায়', value: formatBdt(collected), glyph: 'trending-up', tone: 'success',
        note: 'রেকর্ড করা সব পেমেন্ট',
      }),
    ));

    // §1's "recently onboarded" and "recently inactive". Counts, not alerts:
    // neither is a thing to DO today, and both are things a team running
    // forty schools is asked about weekly. The dormant card carries a note
    // saying what it counts, because "নিষ্ক্রিয়" on its own could mean four
    // different things.
    const fresh = r.filter((t) => isRecent(t)).length;
    const dormant = r.filter((t) => isDormant(t)).length;
    const quiet = r.filter((t) => isQuiet(t)).length;
    root.append(statRow(d,
      statCard(d, {
        label: 'নতুন যুক্ত', value: bn(fresh), glyph: 'star', tone: 'info',
        note: `গত ${bn(ONBOARDING_WINDOW_DAYS)} দিনে তৈরি`,
      }),
      statCard(d, {
        label: 'অসম্পূর্ণ সেটআপ', value: bn(dormant),
        glyph: 'clock', tone: dormant > 0 ? 'warn' : undefined,
        note: 'তৈরির পর কোনো শিক্ষার্থী যোগ হয়নি',
      }),
      // Set up, invoiced, and not being opened — the quieter and more
      // expensive failure, and the one nobody complains about.
      statCard(d, {
        label: 'অনেকদিন কেউ ঢোকেনি', value: bn(quiet),
        glyph: 'wifi-off', tone: quiet > 0 ? 'warn' : undefined,
        note: 'গত ' + bn(QUIET_DAYS) + ' দিনে কেউ প্রবেশ করেননি',
      }),
    ));

    // ── the attention queue ──
    const queue = attentionQueue(r);
    root.append(sectionHeading(d, {
      title: 'যা নজর দেওয়া দরকার',
      action: queue.length > 0
        ? statusBadge(d, { state: 'pending', label: `${bn(queue.length)}টি` })
        : undefined,
    }));
    if (queue.length === 0) {
      root.append(card(d, {
        title: 'সব ঠিক আছে', glyph: 'check-square', tone: 'success', headingLevel: 3,
      }, el(d, 'p', {
        className: 'ui-card-note',
        text: 'কোনো প্রতিষ্ঠানে বকেয়া নেই, কোনোটি স্থগিত নেই, এবং কেউ সীমার কাছাকাছি নয়।',
      })));
    } else {
      // Shown in full only up to a point. Past QUEUE_LIMIT the operator is
      // scrolling, not working, and the rows below the fold are by
      // construction the least urgent ones. The remainder is stated, never
      // silently dropped.
      const shown = queue.slice(0, QUEUE_LIMIT);
      root.append(dataTable(d, {
        caption: 'যেসব প্রতিষ্ঠানে ব্যবস্থা নেওয়া দরকার',
        rows: shown,
        rowKey: (a) => `${a.tenantId}-${a.kind}`,
        // Every row goes to the school it is about. An alert that does not
        // reach the thing it is about is a notification, not an alert.
        onRowClick: (a) => { void this.openDetail(a.tenantId); },
        columns: [
          { key: 'name', header: 'প্রতিষ্ঠান', mobile: 'title', cell: (a) => a.nameBn,
            width: 'minmax(0, 1.8fr)' },
          { key: 'what', header: 'কী', mobile: 'subtitle', cell: (a) => a.labelBn,
            width: 'minmax(0, 3fr)' },
          { key: 'kind', header: 'ধরন', mobile: 'status', width: '150px',
            cell: (a) => statusBadge(d, {
              state: a.weight >= 90 ? 'overdue' : a.weight >= 70 ? 'partial' : 'pending',
              label: ATTENTION_BN[a.kind] ?? a.kind,
            }) },
        ],
      }));
      if (queue.length > shown.length) {
        root.append(el(d, 'p', {
          className: 'ui-card-note',
          text: `আরও ${bn(queue.length - shown.length)}টি কম জরুরি বিষয় আছে — `
            + 'প্রতিষ্ঠান তালিকায় ছেঁকে দেখুন।',
        }));
      }
    }

    this.renderFeed(root);
  }

  /**
   * §27 — what OUR team has been doing, across every school.
   *
   * The per-institution history answers "what happened to this school". This
   * answers "what have we been doing", which is the question an operator
   * arriving in the morning actually has, and the one that catches a
   * colleague's change nobody mentioned.
   *
   * Same trail, same rows, no second pipeline — `GET platform/audit` without
   * a tenant filter is the cross-institution view it has always served and
   * nothing had ever read.
   */
  private renderFeed(root: HTMLElement): void {
    const d = this.o.doc;
    if (this.feed.length === 0) return;

    const nameOf = new Map(this.rows.map((t) => [t.id, t.nameBn]));
    const shown = this.feed.slice(0, FEED_LIMIT);

    root.append(sectionHeading(d, { title: 'সাম্প্রতিক কার্যক্রম' }));
    root.append(card(d, { title: 'shikhonBD দল যা করেছে', glyph: 'clock', headingLevel: 3 },
      el(d, 'p', {
        className: 'ui-card-note',
        text: 'প্ল্যাটফর্ম থেকে করা সব পরিবর্তন, নতুনটি আগে। এই তালিকা মোছা যায় না।',
      })));
    root.append(dataTable(d, {
      caption: 'প্ল্যাটফর্ম থেকে করা সাম্প্রতিক পরিবর্তন',
      rows: shown,
      rowKey: (r) => r.id,
      columns: [
        { key: 'when', header: 'কখন', mobile: 'title', width: '180px',
          cell: (r) => bnDateTime(r.at) },
        // A platform-wide act — a plan change — belongs to no one school, and
        // saying so is more honest than leaving the cell empty.
        { key: 'who', header: 'প্রতিষ্ঠান', mobile: 'subtitle', width: 'minmax(0, 1.5fr)',
          cell: (r) => r.tenantId
            ? (nameOf.get(r.tenantId) ?? 'অন্য একটি প্রতিষ্ঠান')
            : 'সব প্রতিষ্ঠান' },
        { key: 'why', header: 'কারণ', mobile: 'meta', width: 'minmax(0, 2fr)',
          cell: (r) => r.reason ?? '—' },
        { key: 'what', header: 'কী হয়েছিল', mobile: 'meta', width: 'minmax(0, 2fr)',
          cell: (r) => r.statement ?? '—' },
      ],
    }));
    if (this.feed.length > shown.length) {
      root.append(el(d, 'p', {
        className: 'ui-card-note',
        text: `আরও ${bn(this.feed.length - shown.length)}টি পুরোনো পরিবর্তন আছে — `
          + 'প্রতিটি প্রতিষ্ঠানের "ইতিহাস" ট্যাবে সেই প্রতিষ্ঠানের পুরো তালিকা আছে।',
      }));
    }
  }

  // ── 2. the master list ───────────────────────────────────────────────
  private renderList(root: HTMLElement): void {
    const d = this.o.doc;

    const search = field(d, {
      label: 'খুঁজুন', name: 'q', kind: 'search',
      value: this.search,
      placeholder: 'নাম, স্লাগ বা জেলা',
      onInput: (v) => {
        this.search = v;
        this.repaintTable();
      },
    });
    append(root, search.root);

    root.append(tabs(d, {
      label: 'ছাঁকনি',
      active: this.filter,
      items: [
        { id: 'all', label: 'সব', count: this.rows.length },
        { id: 'attention', label: 'নজর দরকার',
          count: new Set(attentionQueue(this.rows).map((a) => a.tenantId)).size },
        { id: 'overdue', label: 'বকেয়া',
          count: this.rows.filter((t) => t.billingState === 'limited').length },
        { id: 'blocked', label: 'স্থগিত / সীমিত',
          count: this.rows.filter((t) => t.access !== 'full').length },
      ],
      onSelect: (id) => { this.filter = id; this.render(); },
    }));

    const host = el(d, 'div', { className: 'plat-table-host' });
    root.append(host);
    this.tableHost = host;
    this.repaintTable();
  }

  private tableHost: HTMLElement | null = null;

  private visible(): TenantOverview[] {
    const q = this.search.trim().toLowerCase();
    const flagged = new Set(attentionQueue(this.rows).map((a) => a.tenantId));
    return this.rows.filter((t) => {
      if (this.filter === 'attention' && !flagged.has(t.id)) return false;
      if (this.filter === 'overdue' && t.billingState !== 'limited') return false;
      if (this.filter === 'blocked' && t.access === 'full') return false;
      if (!q) return true;
      return [t.nameBn, t.nameEn, t.slug, t.district ?? '']
        .some((x) => x.toLowerCase().includes(q));
    });
  }

  /**
   * Repaint only the table.
   *
   * A search box that re-renders the whole page loses its own focus on every
   * keystroke — which is the one thing a search box may not do.
   */
  private repaintTable(): void {
    const d = this.o.doc;
    const host = this.tableHost;
    if (!host) return;
    host.replaceChildren();

    host.append(dataTable(d, {
      caption: 'প্রতিষ্ঠানের তালিকা',
      rows: this.visible(),
      rowKey: (t) => t.id,
      onRowClick: (t) => { void this.openDetail(t.id); },
      empty: {
        glyph: 'search',
        message: this.search
          ? 'এই নামে কোনো প্রতিষ্ঠান পাওয়া যায়নি।'
          : 'এই ছাঁকনিতে কোনো প্রতিষ্ঠান নেই।',
      },
      columns: [
        { key: 'name', header: 'প্রতিষ্ঠান', mobile: 'title', width: 'minmax(0, 2fr)',
          cell: (t) => t.nameBn },
        // The school's own slug, never the uuid. It is what an operator says
        // on the phone and types into a URL.
        { key: 'slug', header: 'ঠিকানা', mobile: 'subtitle', width: 'minmax(0, 1.4fr)',
          cell: (t) => t.slug },
        { key: 'students', header: 'শিক্ষার্থী', mobile: 'meta', numeric: true,
          width: '150px',
          cell: (t) => `${bn(t.studentCount)} / ${bn(t.studentCap)}` },
        { key: 'plan', header: 'প্ল্যান', mobile: 'meta', width: 'minmax(0, 1.2fr)',
          cell: (t) => t.planName ?? t.planCode },
        { key: 'billing', header: 'বিলিং', mobile: 'meta', width: '150px',
          cell: (t) => statusBadge(d, BILLING_BN[t.billingState]
            ?? { label: t.billingState, state: 'draft' }) },
        // §26 — measured, from real sign-ins and real product events.
        { key: 'seen', header: 'শেষ ব্যবহার', mobile: 'meta', width: '170px',
          cell: (t) => t.lastActiveAt ? bnDate(t.lastActiveAt) : 'কখনো নয়' },
        // The EFFECTIVE answer, not `ops_state`. A school suspended by its
        // legacy status, its bill or a closed portal has `ops_state` of
        // 'active', and a list an operator scans for trouble must not show
        // "সক্রিয়" next to a school nobody can sign in to.
        { key: 'access', header: 'অবস্থা', mobile: 'status', width: '150px',
          cell: (t) => statusBadge(d, t.access === 'none'
            ? { label: 'বন্ধ', state: 'overdue' }
            : t.access === 'read_only'
              ? { label: 'শুধু পড়া', state: 'partial' }
              : OPS_BN[t.opsState] ?? { label: t.opsState, state: 'draft' }) },
      ],
    }));
  }

  // ── 3. the command centre ────────────────────────────────────────────
  private renderDrawer(): void {
    const d = this.o.doc;
    const id = this.openId;
    if (!id) return;
    const t = this.rows.find((x) => x.id === id);
    const body = el(d, 'div', { className: 'ui-card-form plat-detail' });

    if (!this.ops) {
      append(body, listSkeleton(d, 4));
    } else {
      append(body, this.identity(this.ops, t));
      append(body, tabs(d, {
        label: 'বিভাগ',
        active: this.detailTab,
        items: [
          { id: 'overview', label: 'সারসংক্ষেপ' },
          { id: 'services', label: 'সেবা' },
          { id: 'portals', label: 'প্রবেশ' },
          { id: 'billing', label: 'সাবস্ক্রিপশন' },
          { id: 'payments', label: 'পেমেন্ট', count: this.payments.length },
          { id: 'audit', label: 'ইতিহাস' },
        ],
        onSelect: (x) => { this.detailTab = x; this.renderDrawer(); },
      }));
      if (this.detailTab === 'overview') append(body, this.overviewTab(this.ops, id));
      if (this.detailTab === 'services') append(body, this.servicesTab(id));
      if (this.detailTab === 'portals') append(body, this.portalsTab(this.ops, id));
      if (this.detailTab === 'billing') append(body, this.billingTab(this.ops, id));
      if (this.detailTab === 'payments') append(body, this.paymentsTab(id));
      if (this.detailTab === 'audit') append(body, this.auditTab());
    }

    if (this.drawer) setOverlayBody(this.drawer, body);
    else {
      this.drawer = openDrawer(d, {
        title: t?.nameBn ?? 'প্রতিষ্ঠান',
        body,
        actions: [button(d, {
          label: 'প্রভিশনিং ও ব্র্যান্ডিং', variant: 'secondary', glyph: 'settings',
          onClick: () => { this.closeDrawer(); this.o.onOpenTenant(id); },
        })],
        onClose: () => { this.drawer = null; this.openId = null; this.ops = null; },
      });
    }
  }

  /**
   * Show a confirmation where the operator can reach it.
   *
   * Inside the drawer when one is open, because the drawer is a modal: it
   * covers the page with a scrim and marks everything outside itself
   * `aria-hidden`. A confirmation appended to the page behind it is drawn
   * under the drawer and read by nobody — which is what every dangerous
   * action in this console was doing.
   *
   * Focus moves to the dialogue's first control, which `confirmDialog` puts
   * in the DOM as Cancel on purpose: the way out is the first thing reached.
   */
  private showConfirm(dlg: HTMLElement): void {
    const host = this.drawer?.el.querySelector('.ui-dialog-body') ?? this.o.root;
    host.append(dlg);
    dlg.scrollIntoView({ block: 'nearest' });
    (dlg.querySelector('button') as HTMLElement | null)?.focus();
  }

  private closeDrawer(): void {
    this.drawer?.close();
    this.drawer = null;
    this.openId = null;
    this.ops = null;
  }

  /** Above the fold: who, what state, and the three numbers that decide. */
  private identity(o: Operations, t?: TenantOverview): HTMLElement {
    const d = this.o.doc;
    const wrap = el(d, 'section');
    const ops = OPS_BN[o.opsState] ?? { label: o.opsState, state: 'draft', effect: '' };

    // The headline is the EFFECTIVE answer, not the `ops_state` field.
    //
    // Four things can block a school — the ops state this console sets, the
    // legacy `tenants.status`, the bill, and a closed portal — and only the
    // first is `ops_state`. Leading with the field produced "সক্রিয়" above
    // "কেউ প্রবেশ করতে পারছেন না" on a school suspended by its status column,
    // which tells an operator nothing about which control to reach for.
    const ACCESS_BN: Record<string, string> = {
      full: 'সব চালু', read_only: 'শুধু পড়া যাবে', none: 'কেউ প্রবেশ করতে পারছেন না',
    };
    // When the ops state does NOT explain the answer, say what does.
    const disagrees = o.access !== 'full' && o.opsState === 'active';
    append(wrap, statRow(d,
      statCard(d, {
        label: 'এখন যা সম্ভব', value: ACCESS_BN[o.access] ?? o.access, glyph: 'lock',
        tone: o.access === 'full' ? 'success' : o.access === 'none' ? 'accent2' : 'warn',
        note: disagrees
          ? `প্রতিষ্ঠানের অবস্থা "${ops.label}" — বাধাটি বিলিং, প্রবেশপথ বা পুরোনো স্ট্যাটাস থেকে`
          : `প্রতিষ্ঠানের অবস্থা: ${ops.label}`,
      }),
      statCard(d, {
        label: 'শিক্ষার্থী', value: `${bn(o.studentCount)} / ${bn(o.studentCap)}`,
        glyph: 'users',
        tone: o.studentCount >= o.studentCap ? 'accent2'
          : o.studentCount >= o.studentCap * 0.9 ? 'warn' : 'primary',
        note: o.studentCount >= o.studentCap ? 'সীমা পূর্ণ' : undefined,
      }),
      statCard(d, {
        label: 'বিলিং',
        value: (BILLING_BN[o.billingState] ?? { label: o.billingState }).label,
        glyph: 'wallet',
        tone: o.billingState === 'limited' ? 'accent2'
          : o.billingState === 'grace_period' ? 'warn' : 'success',
        note: o.nextDueOn ? `শেষ তারিখ ${bnDate(o.nextDueOn)}` : 'কোনো তারিখ নির্ধারিত নেই',
      }),
    ));

    // What the SCHOOL is being told right now. An operator must be able to
    // read the sentence their own decision is producing.
    if (o.reasonBn) {
      append(wrap, card(d, {
        title: 'প্রতিষ্ঠান যা দেখছে', glyph: 'message', headingLevel: 3,
        tone: o.access === 'none' ? 'warn' : 'info',
      }, el(d, 'p', { className: 'ui-card-lead', text: o.reasonBn })));
    }
    if (t) {
      const dl = el(d, 'dl', { className: 'ui-facts' });
      append(dl,
        el(d, 'dt', { className: 'ui-facts-key', text: 'ঠিকানা' }),
        el(d, 'dd', { className: 'ui-facts-val', text: t.slug }),
        el(d, 'dt', { className: 'ui-facts-key', text: 'জেলা' }),
        el(d, 'dd', { className: 'ui-facts-val', text: t.district || '—' }),
        el(d, 'dt', { className: 'ui-facts-key', text: 'ব্যবহারকারী' }),
        el(d, 'dd', { className: 'ui-facts-val', text: `${bn(t.userCount)} জন` }),
        el(d, 'dt', { className: 'ui-facts-key', text: 'যুক্ত হয়েছে' }),
        el(d, 'dd', { className: 'ui-facts-val', text: bnDate(t.createdAt) }));
      append(wrap, card(d, { title: 'পরিচয়', glyph: 'star', headingLevel: 3 }, dl));
    }
    return wrap;
  }

  /** The tenant-wide control. Four states, each explained before it is taken. */
  private overviewTab(o: Operations, id: string): HTMLElement {
    const d = this.o.doc;
    const wrap = el(d, 'section');
    append(wrap, sectionHeading(d, { title: 'প্রতিষ্ঠানের অবস্থা' }));

    for (const state of ['active', 'maintenance', 'limited', 'suspended']) {
      const meta = OPS_BN[state];
      const current = o.opsState === state;
      append(wrap, card(d, {
        title: meta.label,
        glyph: state === 'active' ? 'check-square' : state === 'suspended' ? 'alert-triangle' : 'lock',
        headingLevel: 3,
        tone: current ? 'primary' : undefined,
        action: current
          ? statusBadge(d, { state: 'published', label: 'বর্তমান' })
          : button(d, {
              label: `${meta.label} করুন`,
              variant: state === 'suspended' ? 'danger' : 'secondary',
              size: 'sm',
              disabled: this.busy,
              onClick: () => this.askState(id, state, meta),
            }),
      },
        // The consequence, always, whether or not it is the current state.
        // An operator comparing two states must be able to read both.
        el(d, 'p', { className: 'ui-card-note', text: meta.effect }),
        current && o.stateReason
          ? el(d, 'p', { className: 'ui-card-note', text: `কারণ: ${o.stateReason}` })
          : null,
      ));
    }

    append(wrap, sectionHeading(d, { title: 'শিক্ষার্থীর সীমা' }));
    const cap = field(d, {
      label: 'সর্বোচ্চ শিক্ষার্থী', name: 'studentCap', kind: 'number',
      value: String(o.studentCap),
      helper: `এখন ভর্তি ${bn(o.studentCount)} জন · প্ল্যানে ${bn(o.planCap ?? o.studentCap)} জন পর্যন্ত`,
      attrs: { min: 1 },
    });
    const capReason = field(d, {
      label: 'কারণ', name: 'capReason', required: true,
      placeholder: 'যেমন: নতুন শাখা খুলেছে',
    });
    append(wrap, card(d, { title: 'সীমা পরিবর্তন', glyph: 'users', headingLevel: 3 },
      cap.root, capReason.root,
      buttonRow(d, button(d, {
        label: 'সীমা সংরক্ষণ করুন', variant: 'secondary', busy: this.busy,
        onClick: () => {
          clearFieldError(capReason.root);
          if (!capReason.value().trim()) {
            setFieldError(capReason.root, 'কারণ লিখুন।');
            capReason.input.focus();
            return;
          }
          void this.act('/cap', {
            tenantId: id, studentCap: Number(cap.value()), reason: capReason.value().trim(),
          }, 'শিক্ষার্থীর সীমা পরিবর্তন হয়েছে।');
        },
      }))));
    return wrap;
  }

  /**
   * A state change is the most consequential thing on this screen, so it
   * always passes through a confirmation that names the consequence and
   * demands a reason in the same step.
   */
  private askState(id: string, state: string, meta: { label: string; effect: string }): void {
    const d = this.o.doc;
    const reason = field(d, {
      label: 'কারণ', name: 'reason', required: true,
      helper: 'প্রতিষ্ঠান এই কারণটিই দেখতে পাবে।',
      placeholder: state === 'suspended' ? 'যেমন: চুক্তি নবায়ন হয়নি' : '',
    });
    const host = el(d, 'div');
    append(host, reason.root);
    const dlg = confirmDialog({
      doc: d,
      title: `${meta.label} — নিশ্চিত করুন`,
      body: meta.effect,
      confirmLabel: meta.label,
      danger: state === 'suspended' || state === 'limited',
      onConfirm: () => {
        if (!reason.value().trim()) {
          setFieldError(reason.root, 'কারণ ছাড়া পরিবর্তন করা যায় না।');
          reason.input.focus();
          return;
        }
        void this.act('/opsstate',
          { tenantId: id, state, reason: reason.value().trim() },
          `${meta.label} করা হয়েছে।`);
      },
    });
    // The reason field goes INSIDE the confirmation: a yes/no followed by a
    // second dialog asking why is two decisions where there is one.
    dlg.querySelector('.notice-confirm-line')?.after(host);
    this.showConfirm(dlg);
  }

  /** §6 — every service, its effective state, and what changing it does. */
  private servicesTab(id: string): HTMLElement {
    const d = this.o.doc;
    const wrap = el(d, 'section');
    const stateOf = new Map(this.effective.map((s) => [s.code, s.state]));

    append(wrap, card(d, {
      title: 'সেবা নিয়ন্ত্রণ', glyph: 'settings', headingLevel: 3,
    }, el(d, 'p', {
      className: 'ui-card-note',
      text: 'প্ল্যান ঠিক করে কোন সেবা কেনা আছে; এখান থেকে সেই সেবা এই প্রতিষ্ঠানের '
        + 'জন্য বন্ধ বা সীমিত করা যায়। প্ল্যানে না থাকা সেবা এখান থেকে চালু করা যায় না।',
    })));

    append(wrap, dataTable(d, {
      caption: 'সেবার তালিকা ও অবস্থা',
      rows: this.services,
      rowKey: (s) => s.code,
      columns: [
        { key: 'name', header: 'সেবা', mobile: 'title', cell: (s) => s.nameBn,
          width: 'minmax(0, 1.4fr)' },
        // What turning it off DOES, in the row, so the consequence is read
        // before the control is reached rather than after.
        { key: 'effect', header: 'বন্ধ করলে', mobile: 'subtitle', cell: (s) => s.effectBn,
          width: 'minmax(0, 3fr)' },
        { key: 'state', header: 'অবস্থা', mobile: 'status', width: '140px',
          cell: (s) => statusBadge(d, SERVICE_STATE_BN[stateOf.get(s.code) ?? 'unknown']) },
        { key: 'act', header: 'ব্যবস্থা', width: '210px',
          cell: (s) => this.serviceActions(id, s, stateOf.get(s.code) ?? 'unknown') },
      ],
    }));
    return wrap;
  }

  private serviceActions(id: string, s: ServiceRow, state: string): HTMLElement {
    const d = this.o.doc;
    const row = el(d, 'div', { className: 'ui-row-actions' });
    if (state === 'not_in_plan') {
      // Not "switched off" — not bought. Different remedy, so a different
      // sentence and no button that would fail.
      append(row, el(d, 'span', { className: 'ui-card-note', text: 'প্ল্যান বদলান' }));
      return row;
    }
    const set = (next: string, label: string, danger = false) => button(d, {
      label, variant: danger ? 'danger' : 'secondary', size: 'sm',
      ariaLabel: `${s.nameBn} — ${label}`,
      disabled: this.busy,
      onClick: () => this.askService(id, s, next, label),
    });
    if (state !== 'disabled') append(row, set('disabled', 'বন্ধ', true));
    if (state !== 'enabled') append(row, set('enabled', 'চালু'));
    return row;
  }

  private askService(id: string, s: ServiceRow, next: string, label: string): void {
    const d = this.o.doc;
    const reason = field(d, { label: 'কারণ', name: 'reason', required: true });
    const host = el(d, 'div');
    append(host, reason.root);
    const dlg = confirmDialog({
      doc: d,
      title: `${s.nameBn} — ${label}`,
      body: next === 'disabled'
        ? s.effectBn
        : `${s.nameBn} আবার চালু হবে — প্ল্যানে থাকলে।`,
      confirmLabel: label,
      danger: next === 'disabled',
      onConfirm: () => {
        if (!reason.value().trim()) {
          setFieldError(reason.root, 'কারণ লিখুন।');
          reason.input.focus();
          return;
        }
        void this.act('/service',
          { tenantId: id, service: s.code, state: next, reason: reason.value().trim() },
          `${s.nameBn} — ${label} করা হয়েছে।`);
      },
    });
    dlg.querySelector('.notice-confirm-line')?.after(host);
    this.showConfirm(dlg);
  }

  /** §8 — per-portal sign-in, never by deleting users or roles. */
  private portalsTab(o: Operations, id: string): HTMLElement {
    const d = this.o.doc;
    const wrap = el(d, 'section');
    append(wrap, card(d, {
      title: 'পোর্টাল প্রবেশ', glyph: 'lock', headingLevel: 3,
    }, el(d, 'p', {
      className: 'ui-card-note',
      text: 'কোনো ব্যবহারকারী বা ভূমিকা মুছে ফেলা হয় না — শুধু এই মুহূর্তে প্রবেশ '
        + 'বন্ধ থাকে। আবার চালু করলে সবাই আগের মতোই ফিরে পাবেন।',
    })));

    const rows = Object.keys(PORTAL_BN).map((code) => ({
      code, open: o.portals[code] !== false,
    }));
    append(wrap, dataTable(d, {
      caption: 'পোর্টালভিত্তিক প্রবেশ',
      rows,
      rowKey: (p) => p.code,
      columns: [
        { key: 'name', header: 'পোর্টাল', mobile: 'title',
          cell: (p) => PORTAL_BN[p.code], width: 'minmax(0, 2fr)' },
        { key: 'state', header: 'অবস্থা', mobile: 'status', width: '150px',
          cell: (p) => statusBadge(d, p.open
            ? { state: 'published', label: 'প্রবেশ খোলা' }
            : { state: 'overdue', label: 'প্রবেশ বন্ধ' }) },
        { key: 'act', header: 'ব্যবস্থা', width: '180px',
          cell: (p) => el(d, 'div', { className: 'ui-row-actions' }, button(d, {
            label: p.open ? 'বন্ধ করুন' : 'খুলে দিন',
            variant: p.open ? 'danger' : 'secondary', size: 'sm',
            ariaLabel: `${PORTAL_BN[p.code]} — ${p.open ? 'প্রবেশ বন্ধ করুন' : 'প্রবেশ খুলে দিন'}`,
            disabled: this.busy,
            onClick: () => this.askPortal(id, p.code, !p.open),
          })) },
      ],
    }));
    return wrap;
  }

  private askPortal(id: string, portal: string, open: boolean): void {
    const d = this.o.doc;
    const reason = field(d, { label: 'কারণ', name: 'reason', required: true });
    const host = el(d, 'div');
    append(host, reason.root);
    const dlg = confirmDialog({
      doc: d,
      title: `${PORTAL_BN[portal]} — ${open ? 'প্রবেশ খুলুন' : 'প্রবেশ বন্ধ করুন'}`,
      body: open
        ? `${PORTAL_BN[portal]} আবার লগইন করতে পারবেন।`
        : `${PORTAL_BN[portal]} এখন থেকে লগইন করতে পারবেন না। `
          + 'তাঁদের অ্যাকাউন্ট, ভূমিকা ও সব তথ্য অক্ষত থাকবে।',
      confirmLabel: open ? 'খুলে দিন' : 'বন্ধ করুন',
      danger: !open,
      onConfirm: () => {
        if (!reason.value().trim()) {
          setFieldError(reason.root, 'কারণ লিখুন।');
          reason.input.focus();
          return;
        }
        void this.act('/portal',
          { tenantId: id, portal, open, reason: reason.value().trim() },
          `${PORTAL_BN[portal]} — ${open ? 'প্রবেশ খোলা হয়েছে' : 'প্রবেশ বন্ধ করা হয়েছে'}।`);
      },
    });
    dlg.querySelector('.notice-confirm-line')?.after(host);
    this.showConfirm(dlg);
  }

  /** §11 §13 §14 — the plan, the lifecycle, and the grace window. */
  private billingTab(o: Operations, id: string): HTMLElement {
    const d = this.o.doc;
    const wrap = el(d, 'section');

    const dl = el(d, 'dl', { className: 'ui-facts' });
    const facts: Array<[string, string]> = [
      ['প্ল্যান', o.planName ?? o.planCode],
      ['মূল্য', o.planPrice ? `${formatBdt(o.planPrice)} / ${CYCLE_BN[o.billingCycle ?? ''] ?? o.billingCycle}` : '—'],
      ['বর্তমান অবস্থা', (BILLING_BN[o.billingState] ?? { label: o.billingState }).label],
      ['পরবর্তী শেষ তারিখ', o.nextDueOn ? bnDate(o.nextDueOn) : 'নির্ধারিত নেই'],
      ['ছাড়ের মেয়াদ', o.graceUntil ? bnDate(o.graceUntil) : `প্ল্যান অনুযায়ী ${bn(o.graceDays ?? 0)} দিন`],
      ['ট্রায়াল শেষ', o.trialEndsOn ? bnDate(o.trialEndsOn) : '—'],
    ];
    for (const [k, v] of facts) {
      append(dl,
        el(d, 'dt', { className: 'ui-facts-key', text: k }),
        el(d, 'dd', { className: 'ui-facts-val', text: v }));
    }
    append(wrap, card(d, { title: 'সাবস্ক্রিপশন', glyph: 'wallet', headingLevel: 3 },
      dl,
      // The lifecycle is DERIVED. Saying so on the screen stops an operator
      // hunting for a status field to correct.
      el(d, 'p', {
        className: 'ui-card-note',
        text: 'বিলিং অবস্থা তারিখ ও পেমেন্ট থেকে নিজে থেকেই নির্ধারিত হয় — '
          + 'হাতে বদলানোর কোনো ঘর নেই। পেমেন্ট রেকর্ড করলে তারিখ এগোবে এবং '
          + 'অবস্থা নিজেই বদলাবে।',
      })));

    if (o.graceReason) {
      append(wrap, card(d, { title: 'চলতি ছাড়', glyph: 'clock', headingLevel: 3, tone: 'warn' },
        el(d, 'p', { className: 'ui-card-note', text: o.graceReason })));
    }

    append(wrap, this.planCard(o, id));

    const until = field(d, {
      label: 'ছাড় কত তারিখ পর্যন্ত', name: 'until', kind: 'date',
      value: o.graceUntil ?? '',
      helper: 'এই তারিখ পর্যন্ত প্রতিষ্ঠান পূর্ণ সক্রিয় থাকবে।',
    });
    const why = field(d, { label: 'কারণ', name: 'reason', required: true,
      placeholder: 'যেমন: চেক পাঠানো হয়েছে' });
    append(wrap, card(d, { title: 'ছাড়ের মেয়াদ বাড়ান', glyph: 'clock', headingLevel: 3 },
      until.root, why.root,
      buttonRow(d, button(d, {
        label: 'ছাড় দিন', variant: 'secondary', busy: this.busy,
        onClick: () => {
          clearFieldError(why.root);
          if (!until.value()) { setFieldError(until.root, 'তারিখ দিন।'); return; }
          if (!why.value().trim()) {
            setFieldError(why.root, 'কারণ লিখুন।');
            why.input.focus();
            return;
          }
          void this.act('/grace',
            { tenantId: id, until: until.value(), reason: why.value().trim() },
            'ছাড়ের মেয়াদ বাড়ানো হয়েছে।');
        },
      }))));
    return wrap;
  }

  /** §33 — what this console has done to this school, and why. */
  private auditTab(): HTMLElement {
    const d = this.o.doc;
    const wrap = el(d, 'section');

    append(wrap, card(d, { title: 'পরিবর্তনের ইতিহাস', glyph: 'clock', headingLevel: 3 },
      el(d, 'p', {
        className: 'ui-card-note',
        text: 'shikhonBD-এর পক্ষ থেকে এই প্রতিষ্ঠানে করা প্রতিটি পরিবর্তন, '
          + 'সঙ্গে যে কারণ লেখা হয়েছিল। এই তালিকা মোছা যায় না।',
      })));

    if (this.audit.length === 0) {
      append(wrap, emptyState(d, {
        glyph: 'clock',
        message: 'এই প্রতিষ্ঠানে shikhonBD থেকে এখনো কোনো পরিবর্তন করা হয়নি।',
      }));
      return wrap;
    }

    append(wrap, dataTable(d, {
      caption: 'প্ল্যাটফর্ম থেকে করা পরিবর্তন',
      rows: this.audit,
      rowKey: (r) => r.id,
      columns: [
        { key: 'when', header: 'কখন', mobile: 'title', width: '190px',
          cell: (r) => bnDateTime(r.at) },
        // The operator's own sentence. It is the column that makes this list
        // worth keeping — "suspended" tells nobody anything six months later.
        { key: 'why', header: 'কারণ', mobile: 'subtitle',
          cell: (r) => r.reason ?? '—', width: 'minmax(0, 2fr)' },
        { key: 'what', header: 'কী হয়েছিল', mobile: 'meta',
          cell: (r) => r.statement ?? '—', width: 'minmax(0, 2fr)' },
      ],
    }));
    return wrap;
  }

  /**
   * §16 — move a school to another plan.
   *
   * One control, four consequences: price, student cap, which services are
   * bought, and how many days of grace the bill gets. They are named on the
   * screen before the change, because a plan code alone tells an operator
   * none of them — and the operator is usually doing this while a headmaster
   * is on the phone.
   *
   * The cap moves with the plan unless it is already higher: a school that
   * negotiated 1,600 seats on a 1,500 plan does not lose them to an unrelated
   * plan change. And a plan whose cap is below the school's current roll is
   * refused here rather than at the server, with both numbers.
   */
  private planCard(o: Operations, id: string): HTMLElement {
    const d = this.o.doc;
    const enrolled = o.studentCount;
    const current = this.plans.find((p) => p.code === o.planCode);

    const pick = field(d, {
      label: 'প্ল্যান', name: 'planCode', kind: 'select', value: o.planCode,
      options: this.plans.map((p) => ({
        value: p.code,
        label: `${p.nameBn} — ${formatBdt(p.priceBdt)} / ${CYCLE_BN[p.billingCycle] ?? p.billingCycle}`,
      })),
    });
    // What the chosen plan would mean, kept current as the operator browses.
    const effect = el(d, 'p', { className: 'ui-card-note' });
    const describe = (): void => {
      const p = this.plans.find((x) => x.code === pick.value());
      if (!p) { effect.textContent = ''; return; }
      const cap = Math.max(p.studentCap, o.studentCap);
      const on = Object.entries(p.services).filter(([, v]) => v).length;
      effect.textContent =
        `${p.nameBn}: ${formatBdt(p.priceBdt)} / ${CYCLE_BN[p.billingCycle] ?? p.billingCycle}, `
        + `শিক্ষার্থীর সীমা ${bn(cap)}, ${bn(on)}টি সেবা, ছাড় ${bn(p.graceDays)} দিন।`
        + (p.studentCap < enrolled
          ? ` — এই প্ল্যানের সীমা ${bn(p.studentCap)}, কিন্তু এখানে ${bn(enrolled)} জন শিক্ষার্থী আছে।`
          : '');
    };
    pick.input.addEventListener('change', describe);
    describe();

    const why = field(d, { label: 'কারণ', name: 'reason', required: true,
      placeholder: 'যেমন: নতুন চুক্তি স্বাক্ষরিত' });

    return card(d, { title: 'প্ল্যান বদলান', glyph: 'layers', headingLevel: 3 },
      pick.root, effect, why.root,
      buttonRow(d, button(d, {
        label: 'প্ল্যান বদলান', variant: 'secondary', busy: this.busy,
        onClick: () => {
          clearFieldError(pick.root); clearFieldError(why.root);
          const next = this.plans.find((x) => x.code === pick.value());
          if (!next) { setFieldError(pick.root, 'প্ল্যান বেছে নিন।'); return; }
          if (next.code === o.planCode) {
            setFieldError(pick.root, 'এটি এখনকার প্ল্যানই — অন্য একটি বেছে নিন।');
            return;
          }
          if (!why.value().trim()) {
            setFieldError(why.root, 'কারণ লিখুন।');
            why.input.focus();
            return;
          }
          const cap = Math.max(next.studentCap, o.studentCap);
          if (cap < enrolled) {
            setFieldError(pick.root,
              `এই প্ল্যানে সীমা ${bn(cap)}, কিন্তু এখানে ${bn(enrolled)} জন শিক্ষার্থী আছে।`);
            return;
          }
          const dlg = confirmDialog({
            doc: d,
            title: 'প্ল্যান বদল — নিশ্চিত করুন',
            body: `${current?.nameBn ?? o.planCode} থেকে ${next.nameBn}। `
              + `নতুন মূল্য ${formatBdt(next.priceBdt)} / `
              + `${CYCLE_BN[next.billingCycle] ?? next.billingCycle}, `
              + `শিক্ষার্থীর সীমা ${bn(cap)}। `
              + 'প্ল্যানে না থাকা সেবা সঙ্গে সঙ্গে বন্ধ হয়ে যাবে।',
            confirmLabel: 'প্ল্যান বদলান',
            onConfirm: () => {
              void this.act('/plan',
                { tenantId: id, planCode: next.code, studentCap: cap,
                  reason: why.value().trim() },
                'প্ল্যান বদলানো হয়েছে।');
            },
          });
          this.showConfirm(dlg);
        },
      })));
  }

  /** §12 — manual payments. No gateway, by decision. */
  private paymentsTab(id: string): HTMLElement {
    const d = this.o.doc;
    const wrap = el(d, 'section');

    const amount = field(d, { label: 'টাকার পরিমাণ', name: 'amountBdt', kind: 'number',
      required: true, attrs: { min: 1, step: '0.01' } });
    const paidOn = field(d, { label: 'পরিশোধের তারিখ', name: 'paidOn', kind: 'date',
      required: true, value: todayLocalIso() });
    const method = field(d, {
      label: 'মাধ্যম', name: 'method', kind: 'select', required: true,
      options: Object.entries(METHOD_BN).map(([value, label]) => ({ value, label })),
    });
    const reference = field(d, { label: 'রেফারেন্স', name: 'reference',
      helper: 'ব্যাংক স্লিপ বা ট্রানজেকশন নম্বর — একই দিনে দুটি পেমেন্ট আলাদা করতে লাগে।' });
    const covers = field(d, { label: 'কত তারিখ পর্যন্ত মেয়াদ', name: 'coversUntil',
      kind: 'date', helper: 'দিলে পরবর্তী শেষ তারিখ এখানেই সরে যাবে।' });
    const note = field(d, { label: 'নোট', name: 'note', kind: 'textarea', attrs: { rows: 2 } });

    append(wrap, card(d, { title: 'পেমেন্ট রেকর্ড করুন', glyph: 'wallet', headingLevel: 3 },
      amount.root, paidOn.root, method.root, reference.root, covers.root, note.root,
      buttonRow(d, button(d, {
        label: 'রেকর্ড করুন', variant: 'primary', busy: this.busy,
        onClick: () => {
          clearFieldError(amount.root);
          const v = Number(amount.value());
          if (!Number.isFinite(v) || v <= 0) {
            setFieldError(amount.root, 'টাকার পরিমাণ দিন।');
            amount.input.focus();
            return;
          }
          const host = el(d, 'div');
          const dlg = confirmDialog({
            doc: d,
            title: 'পেমেন্ট নিশ্চিত করুন',
            body: `${formatBdt(v)} · ${METHOD_BN[method.value()]} · ${bnDate(paidOn.value())}`
              + (covers.value() ? ` — মেয়াদ ${bnDate(covers.value())} পর্যন্ত এগোবে।` : ''),
            confirmLabel: 'রেকর্ড করুন',
            onConfirm: () => void this.act('/payment', {
              tenantId: id, amountBdt: v, paidOn: paidOn.value(),
              method: method.value(), reference: reference.value().trim(),
              coversUntil: covers.value() || null, note: note.value().trim() || null,
            }, 'পেমেন্ট রেকর্ড হয়েছে।'),
          });
          host.append(dlg);
          this.o.root.append(host);
        },
      }))));

    append(wrap, sectionHeading(d, { title: 'পেমেন্টের ইতিহাস' }));
    append(wrap, dataTable(d, {
      caption: 'রেকর্ড করা পেমেন্ট',
      rows: this.payments,
      rowKey: (p) => `${p.paidOn}-${p.amountBdt}-${p.reference ?? ''}`,
      empty: { glyph: 'wallet', message: 'এখনো কোনো পেমেন্ট রেকর্ড করা হয়নি।' },
      columns: [
        { key: 'on', header: 'তারিখ', mobile: 'title', cell: (p) => bnDate(p.paidOn),
          width: 'minmax(0, 1.4fr)' },
        { key: 'amt', header: 'পরিমাণ', mobile: 'meta', numeric: true,
          cell: (p) => formatBdt(p.amountBdt), width: 'minmax(0, 1.2fr)' },
        { key: 'how', header: 'মাধ্যম', mobile: 'subtitle',
          cell: (p) => METHOD_BN[p.method] ?? p.method, width: 'minmax(0, 1fr)' },
        { key: 'ref', header: 'রেফারেন্স', mobile: 'meta',
          cell: (p) => p.reference || '—', width: 'minmax(0, 1.4fr)' },
        { key: 'covers', header: 'মেয়াদ', mobile: 'meta',
          cell: (p) => (p.coversUntil ? bnDate(p.coversUntil) : '—'),
          width: 'minmax(0, 1.2fr)' },
      ],
    }));
    return wrap;
  }
}

const ATTENTION_BN: Record<string, string> = {
  overdue: 'বকেয়া',
  cap_full: 'সীমা পূর্ণ',
  suspended: 'স্থগিত',
  portal: 'প্রবেশ বন্ধ',
  grace: 'ছাড়',
  cap_near: 'সীমার কাছে',
  service: 'সেবা বন্ধ',
  onboarding: 'সেটআপ',
};

const CYCLE_BN: Record<string, string> = {
  monthly: 'মাস', quarterly: 'ত্রৈমাসিক', yearly: 'বছর',
};
