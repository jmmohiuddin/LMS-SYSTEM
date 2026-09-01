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
import {
  permissionState, permissionMessage, pageHeader, dataTable, statusBadge,
  openDrawer, setOverlayBody, listSkeleton, el, append, type OverlayHandle,
} from './ui/index.ts';
import { bnDate, bnMonth } from './view-states.ts';

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

/**
 * The shared badge vocabulary, so an unpaid invoice tints like every other
 * overdue thing in the product rather than like fees only.
 */
const BADGE_STATE: Record<string, string> = {
  issued: 'due',
  partly_paid: 'partial',
  paid: 'paid',
  overdue: 'overdue',
  waived: 'draft',
  cancelled: 'draft',
};

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
  /** The open invoice drawer, so a late receipt can fill it without a repaint. */
  private drawer: OverlayHandle | null = null;
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

  /**
   * Open one invoice.
   *
   * A DRAWER, not an inline expansion. The list is now a table, and a table
   * row cannot hold a second table of line items and receipts — and on a
   * phone an expansion pushes every other invoice off the screen, which is
   * the thing a parent is comparing against.
   */
  private async toggle(invoiceId: string): Promise<void> {
    this.expanded = invoiceId;
    const inv = this.invoices.find((i) => i.id === invoiceId);
    if (!inv) return;
    const handle = openDrawer(this.o.doc, {
      title: inv.billingPeriod
        ? `${inv.invoiceNo} · ${bnMonth(inv.billingPeriod)}`
        : inv.invoiceNo,
      body: this.detail(inv),
      onClose: () => { this.expanded = null; },
    });
    this.drawer = handle;
    if (!this.receipts.has(invoiceId)) {
      try {
        const res = await this.o.auth.authedFetch(
          `/api/v1/finance/receipts?invoiceId=${encodeURIComponent(invoiceId)}`,
        );
        if (res.ok) {
          const body = (await res.json()) as { receipts: Receipt[] };
          this.receipts.set(invoiceId, body.receipts);
          // Re-fill the drawer in place. Re-rendering the whole screen would
          // close it under the reader's finger.
          if (this.expanded === invoiceId) setOverlayBody(handle, this.detail(inv));
        }
      } catch { /* offline — the lines still show; only receipts are missing */ }
    }
  }

  /** One invoice's lines, due date and receipts. Drawer body. */
  private detail(inv: Invoice): HTMLElement {
    const d = this.o.doc;
    const host = el(d, 'div', { className: 'ui-card-form' });

    append(host, dataTable(d, {
      caption: `${inv.invoiceNo} — খাতওয়ারি`,
      rows: inv.lines,
      rowKey: (l) => l.descriptionBn,
      columns: [
        { key: 'what', header: 'খাত', mobile: 'title', cell: (l) => l.descriptionBn,
          width: 'minmax(0, 2fr)' },
        { key: 'amount', header: 'টাকা', mobile: 'meta', numeric: true,
          cell: (l) => (Number(l.waiverAmount) > 0
            ? `${money(l.netAmount)} (মওকুফ ${money(l.waiverAmount)})`
            : money(l.amount)),
          width: 'minmax(0, 1.4fr)' },
      ],
    }));

    const dl = el(d, 'dl', { className: 'ui-facts' });
    append(dl,
      el(d, 'dt', { className: 'ui-facts-key', text: 'মোট' }),
      el(d, 'dd', { className: 'ui-facts-val', text: money(inv.totalAmount) }),
      el(d, 'dt', { className: 'ui-facts-key', text: 'পরিশোধিত' }),
      el(d, 'dd', { className: 'ui-facts-val', text: money(inv.paidAmount) }),
      el(d, 'dt', { className: 'ui-facts-key', text: 'বকেয়া' }),
      el(d, 'dd', { className: 'ui-facts-val', text: money(inv.balanceAmount) }),
      // Was `শেষ তারিখ: 2026-08-10` — an ISO date on a Bangla screen.
      el(d, 'dt', { className: 'ui-facts-key', text: 'শেষ তারিখ' }),
      el(d, 'dd', { className: 'ui-facts-val', text: bnDate(inv.dueOn) }));
    append(host, dl);

    const receipts = this.receipts.get(inv.id);
    if (receipts && receipts.length > 0) {
      append(host, dataTable(d, {
        caption: `${inv.invoiceNo} — রসিদ`,
        rows: receipts,
        rowKey: (r) => r.receiptNo,
        columns: [
          { key: 'no', header: 'রসিদ', mobile: 'title', cell: (r) => r.receiptNo,
            width: 'minmax(0, 1.6fr)' },
          { key: 'how', header: 'মাধ্যম', mobile: 'subtitle', cell: (r) => r.method,
            width: 'minmax(0, 1fr)' },
          { key: 'amt', header: 'টাকা', mobile: 'meta', numeric: true,
            cell: (r) => money(r.amount), width: 'minmax(0, 1fr)' },
        ],
      }));
    } else if (Number(inv.paidAmount) > 0) {
      append(host, el(d, 'p', { className: 'ui-card-note', text: 'রসিদ আনা হচ্ছে…' }));
    }
    return host;
  }

  private render(): void {
    const d = this.o.doc;
    const root = this.o.root;
    root.textContent = '';

    // B-30. A refusal outranks the offline banner, the skeleton and the
    // empty state: nothing is loading, there is nothing to show, and calling
    // it "offline" is the lie that item exists to remove.
    if (this.denied) {
      root.append(pageHeader(d, { title: 'বেতন ও ফি' }));
      root.append(permissionState(d, {
        message: permissionMessage('বেতন ও ফি'),
        contact: 'প্রধান শিক্ষক',
      }));
      return;
    }

    root.append(pageHeader(d, {
      title: 'বেতন ও ফি',
      subtitle: 'ইনভয়েস, মওকুফ ও ডিজিটাল রসিদ',
      badge: this.offline
        ? statusBadge(d, { state: 'pending', label: 'অফলাইন — সর্বশেষ সংরক্ষিত' })
        : undefined,
    }));

    if (this.loading) { root.append(listSkeleton(d, 3)); return; }

    root.append(dataTable(d, {
      caption: 'ইনভয়েসের তালিকা',
      rows: this.invoices,
      rowKey: (inv) => inv.id,
      onRowClick: (inv) => { void this.toggle(inv.id); },
      empty: {
        message: 'কোনো ইনভয়েস পাওয়া যায়নি। অভিভাবক নিজের সন্তানের এবং ' +
                 'হিসাবরক্ষক সবার ইনভয়েস দেখতে পান।',
      },
      columns: [
        { key: 'no', header: 'ইনভয়েস', mobile: 'title', cell: (inv) => inv.invoiceNo,
          width: 'minmax(0, 1.6fr)' },
        // Was `2026-08` — a database key printed at a parent.
        { key: 'period', header: 'মাস', mobile: 'subtitle',
          cell: (inv) => bnMonth(inv.billingPeriod), width: 'minmax(0, 1.2fr)' },
        { key: 'total', header: 'মোট', mobile: 'meta', numeric: true,
          cell: (inv) => money(inv.totalAmount), width: 'minmax(0, 1fr)' },
        { key: 'balance', header: 'বকেয়া', mobile: 'meta', numeric: true,
          cell: (inv) => money(inv.balanceAmount), width: 'minmax(0, 1fr)' },
        { key: 'status', header: 'অবস্থা', mobile: 'status', width: '150px',
          cell: (inv) => statusBadge(d, {
            state: BADGE_STATE[inv.status] ?? 'pending',
            label: STATUS_BN[inv.status] ?? inv.status,
          }) },
      ],
    }));
  }
}
