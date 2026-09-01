/**
 * Fees view (বেতন tab): invoices + digital receipts.
 *
 * GET /api/v1/finance/invoices feeds the list; tapping an invoice expands
 * its line items and lazily fetches GET /api/v1/finance/receipts for it.
 * Same offline-cache-in-localStorage approach as roster-view.ts.
 *
 * Who sees what is decided by RLS (invoice_scope in
 * db/migrations/010_rls_policies.sql): guardians/students see their own,
 * accountant/principal/owner see everything, and an ordinary subject
 * teacher legitimately sees none — the empty state says so instead of
 * pretending it's an error.
 */
import { formatBdt } from '../../../packages/ui-core/src/format.ts';
import type { Auth } from './auth.ts';
import { refuseUnlessOk, isDenied } from './http-status.ts';
import { permissionState, permissionMessage } from './ui/index.ts';

interface InvoiceLine {
  descriptionBn: string;
  amount: string;
  waiverAmount: string;
  netAmount: string;
}

interface Invoice {
  id: string;
  invoiceNo: string;
  billingPeriod: string | null;
  issuedOn: string;
  dueOn: string;
  totalAmount: string;
  paidAmount: string;
  balanceAmount: string;
  status: string;
  lines: InvoiceLine[];
}

interface Receipt {
  receiptNo: string;
  amount: string;
  method: string;
  issuedAt: string;
}

const CACHE_KEY = 'shikhon_invoices_cache';

const STATUS_BN: Record<string, string> = {
  issued: 'বকেয়া',
  partly_paid: 'আংশিক পরিশোধিত',
  paid: 'পরিশোধিত',
  overdue: 'মেয়াদোত্তীর্ণ',
  waived: 'মওকুফ',
  cancelled: 'বাতিল',
};

/**
 * R-8 audit. This file used to carry its own `money()`, rendering Bangla
 * digits — so a parent read **৳ ১,২৫০** here and **৳ 1,250.00** on the receipt
 * printed for the same invoice. Two formatters, one decision, two answers.
 * There is now one, in ui-core, and the reasoning lives with it.
 */
const money = formatBdt;

export interface FeesViewOptions {
  root: HTMLElement;
  doc: Document;
  auth: Auth;
}

export class FeesView {
  private readonly o: FeesViewOptions;
  private invoices: Invoice[] = [];
  private receipts = new Map<string, Receipt[]>();
  private expanded: string | null = null;
  private offline = false;
  /**
   * The server refused this read (403). Distinct from `offline`, and the
   * distinction is the point: an outage is temporary and a refusal is not,
   * so this state offers no retry and shows no cached data (B-30).
   */
  private denied = false;
  private loading = true;

  constructor(options: FeesViewOptions) {
    this.o = options;
    void this.init();
  }

  private async init(): Promise<void> {
    try {
      const raw = localStorage.getItem(CACHE_KEY);
      if (raw) {
        this.invoices = JSON.parse(raw) as Invoice[];
        this.loading = false;
      }
    } catch { /* cache is a nicety */ }
    this.render();

    try {
      const res = await this.o.auth.authedFetch('/api/v1/finance/invoices');
      refuseUnlessOk(res);
      const body = (await res.json()) as { invoices: Invoice[] };
      this.invoices = body.invoices;
      this.offline = false;
      try { localStorage.setItem(CACHE_KEY, JSON.stringify(this.invoices)); } catch { /* best-effort */ }
    } catch (err) {
      if (isDenied(err)) {
        // Fees are the most sensitive thing on a student's phone after
        // results: a stale invoice list left on screen after a refusal is
        // somebody's money.
        this.denied = true; this.invoices = []; this.offline = false;
        try { localStorage.removeItem(CACHE_KEY); } catch { /* private mode */ }
        // These two have no `finally { render() }`, so a bare return
        // computed the denied state and never painted it.
        this.loading = false; this.render(); return;
      }
      this.offline = this.invoices.length > 0;
    }
    this.loading = false;
    this.render();
  }

  private async toggle(invoiceId: string): Promise<void> {
    this.expanded = this.expanded === invoiceId ? null : invoiceId;
    this.render();
    if (this.expanded === invoiceId && !this.receipts.has(invoiceId)) {
      try {
        const res = await this.o.auth.authedFetch(
          `/api/v1/finance/receipts?invoiceId=${encodeURIComponent(invoiceId)}`,
        );
        if (res.ok) {
          const body = (await res.json()) as { receipts: Receipt[] };
          this.receipts.set(invoiceId, body.receipts);
          if (this.expanded === invoiceId) this.render();
        }
      } catch { /* offline — lines still show */ }
    }
  }

  private render(): void {
    const d = this.o.doc;
    const root = this.o.root;
    root.textContent = '';

    const header = d.createElement('header');
    header.className = 'att-header';
    const h1 = d.createElement('h1');
    h1.textContent = 'বেতন ও ফি';
    header.append(h1);
    if (this.offline) {
      const banner = d.createElement('p');
      banner.className = 'offline-banner';
      banner.textContent = 'অফলাইন — সর্বশেষ সংরক্ষিত তথ্য দেখানো হচ্ছে';
      header.append(banner);
    }
    // B-30. A refusal outranks the offline banner, the skeleton and the
    // empty state: nothing is loading, there is nothing to show, and
    // calling it "offline" is the lie this item exists to remove.
    if (this.denied) {
      root.append(permissionState(d, {
        message: permissionMessage('বেতন ও ফি'),
        contact: 'প্রধান শিক্ষক',
      }));
      return;
    }

    root.append(header);

    if (this.loading) {
      const p = d.createElement('p');
      p.className = 'att-sub';
      p.textContent = 'লোড হচ্ছে…';
      root.append(p);
      return;
    }
    if (this.invoices.length === 0) {
      const p = d.createElement('p');
      p.className = 'att-sub';
      p.textContent = 'কোনো ইনভয়েস পাওয়া যায়নি। (অভিভাবক নিজের সন্তানের, হিসাবরক্ষক সবার ইনভয়েস দেখতে পান।)';
      root.append(p);
      return;
    }

    const list = d.createElement('ul');
    list.className = 'fees-list';
    for (const inv of this.invoices) {
      const li = d.createElement('li');
      li.className = 'fees-row';
      li.dataset.status = inv.status;

      const head = d.createElement('button');
      head.type = 'button';
      head.className = 'fees-head';
      head.setAttribute('aria-expanded', String(this.expanded === inv.id));

      const title = d.createElement('span');
      title.className = 'fees-title';
      title.textContent = inv.billingPeriod ? `${inv.invoiceNo} · ${inv.billingPeriod}` : inv.invoiceNo;

      const meta = d.createElement('span');
      meta.className = 'fees-meta';
      meta.textContent = `${STATUS_BN[inv.status] ?? inv.status} · বকেয়া ${money(inv.balanceAmount)}`;

      const amount = d.createElement('span');
      amount.className = 'fees-amount';
      amount.textContent = money(inv.totalAmount);

      head.append(title, meta, amount);
      head.addEventListener('click', () => { void this.toggle(inv.id); });
      li.append(head);

      if (this.expanded === inv.id) {
        const detail = d.createElement('div');
        detail.className = 'fees-detail';

        for (const line of inv.lines) {
          const row = d.createElement('div');
          row.className = 'fees-line';
          const label = d.createElement('span');
          label.textContent = line.descriptionBn;
          const amt = d.createElement('span');
          amt.textContent = Number(line.waiverAmount) > 0
            ? `${money(line.netAmount)} (মওকুফ ${money(line.waiverAmount)})`
            : money(line.amount);
          row.append(label, amt);
          detail.append(row);
        }

        const due = d.createElement('div');
        due.className = 'fees-line fees-due';
        due.textContent = `শেষ তারিখ: ${inv.dueOn}`;
        detail.append(due);

        const receipts = this.receipts.get(inv.id);
        if (receipts && receipts.length > 0) {
          const rh = d.createElement('div');
          rh.className = 'fees-line fees-receipts-h';
          rh.textContent = 'রসিদ:';
          detail.append(rh);
          for (const r of receipts) {
            const row = d.createElement('div');
            row.className = 'fees-line';
            const label = d.createElement('span');
            label.textContent = `${r.receiptNo} · ${r.method}`;
            const amt = d.createElement('span');
            amt.textContent = money(r.amount);
            row.append(label, amt);
            detail.append(row);
          }
        }
        li.append(detail);
      }
      list.append(li);
    }
    root.append(list);
  }
}
