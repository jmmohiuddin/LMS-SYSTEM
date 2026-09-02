/**
 * ইনভয়েস তৈরি — the monthly billing run  (R-3, Part I)
 *
 * The second endpoint D13's audit found with no caller:
 * `POST /api/v1/finance/generate` builds a month's invoices from the school's
 * fee structures, and nothing in the app reached it. `fees-view` reads
 * invoices; nothing created them. R-2's invoice auto-notice to fee-paying
 * guardians therefore could not fire from the product either.
 *
 * ── Idempotency is the safety net, and it is stated ────────────────────
 * The endpoint is idempotent per (student, billing period): a student already
 * invoiced for 2026-03 is skipped, not double-billed. That is a property of
 * the SQL, not of this screen being careful, which is what makes it safe to
 * let a nervous accountant press the button twice. The screen says so out
 * loud, because otherwise the second press is the scariest thing in the
 * product.
 *
 * ── There is no dry run, and the screen does not pretend there is ──────
 * `generate` has no preview mode. Rather than inventing a client-side
 * estimate — which would be a second implementation of fee structures,
 * waivers and class-specific overrides, disagreeing with the real one on
 * exactly the students whose fees are unusual — the confirmation states what
 * the run does and what its idempotency guarantees, and the result reports
 * what was actually created. An estimate that is wrong about money is worse
 * than no estimate.
 */
import { formatBdt } from '../../../packages/ui-core/src/format.ts';
import type { Auth } from './auth.ts';
import {
  skeleton, errorState, emptyState, successNote, confirmDialog, bnNum,
} from './view-states.ts';
import { pageHeader } from './ui/page-header.ts';
import { bnMonth } from './view-states.ts';
import {
  serverMessage, sectionHeading, buttonRow, button, dataTable, statusBadge,
  field, setFieldError, clearFieldError, permissionState, permissionMessage,
  el, append, openDrawer, setBusy, announce, type OverlayHandle,
} from './ui/index.ts';

interface InvoiceRow {
  id: string; invoiceNo: string; billingPeriod: string;
  totalAmount: string; balanceAmount: string; status: string;
}

export interface InvoiceViewOptions {
  root: HTMLElement;
  doc: Document;
  auth: Auth;
  /**
   * Whether to offer the generate control at all. The server is the gate
   * (BILLING_ROLES); this stops the screen offering a button that is
   * guaranteed to 403 — found in the browser, where a student was shown the
   * whole billing form because the invoice LIST is legitimately readable by
   * a guardian for their own child.
   */
  canGenerate: boolean;
}

/** 'YYYY-MM' for a Date, in the local calendar the school bills by. */
function periodOf(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

export class InvoiceView {
  private readonly o: InvoiceViewOptions;
  private recent: InvoiceRow[] = [];
  private loading = true;
  private error = '';
  private notice = '';
  private busy = false;
  private period = periodOf(new Date());

  constructor(options: InvoiceViewOptions) {
    this.o = options;
    this.render();
    void this.load();
  }

  private async load(): Promise<void> {
    this.loading = true; this.error = ''; this.render();
    try {
      const res = await this.o.auth.authedFetch('/api/v1/finance/invoices?limit=20');
      if (res.status === 403) { this.error = 'ইনভয়েস দেখার অনুমতি আপনার নেই।'; return; }
      if (!res.ok) throw new Error(String(res.status));
      const body = (await res.json()) as { invoices?: InvoiceRow[] };
      this.recent = body.invoices ?? [];
    } catch {
      this.error = 'ইনভয়েস আনা যায়নি — সংযোগ পেলে আবার দেখা যাবে।';
    } finally {
      this.loading = false; this.render();
    }
  }

  private async generate(): Promise<void> {
    this.busy = true; this.error = ''; this.render();
    try {
      const res = await this.o.auth.authedFetch('/api/v1/finance/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ billingPeriod: this.period }),
      });
      const body = await res.json() as {
        invoiceCount?: number; notified?: number; message?: string; error?: string;
      };
      if (!res.ok) {
        this.error = body.error === 'no_academic_year'
          ? 'এই মাসটি কোনো শিক্ষাবর্ষের মধ্যে পড়ে না।'
          : serverMessage(body, res.status, 'ইনভয়েস তৈরি করা যায়নি।', 'ইনভয়েস');
        return;
      }
      const n = body.invoiceCount ?? 0;
      // Zero is a real, common and correct outcome — it means everybody was
      // already billed for this month. Saying "0 invoices created" without
      // that sentence reads as a failure.
      this.notice = n === 0
        ? 'নতুন কোনো ইনভয়েস তৈরি হয়নি — এই মাসের জন্য সবার ইনভয়েস আগেই তৈরি হয়েছে।'
        : `${bnNum(n)} টি ইনভয়েস তৈরি হয়েছে` +
          (body.notified ? ` · ${bnNum(body.notified)} জন অভিভাবককে জানানো হয়েছে।` : '।');
      await this.load();
    } catch {
      this.error = 'সংযোগ নেই — ইনভয়েস তৈরি করা যায়নি।';
    } finally {
      this.busy = false; this.render();
    }
  }

  private render(): void {
    const d = this.o.doc;
    const root = this.o.root;
    root.textContent = '';

    const header = pageHeader(d, {
      title: 'ইনভয়েস তৈরি',
      subtitle: 'ফি কাঠামো অনুযায়ী মাসিক বিল তৈরি হয়।',
    });
    root.append(header);

    if (this.notice) root.append(successNote(d, this.notice));
    if (this.error) {
      root.append(errorState(d, this.error,
        this.error.includes('অনুমতি') ? undefined : () => void this.load()));
    }

    if (!this.o.canGenerate) {
      // The refusal, and NOTHING under it.
      //
      // This first said "a reader who may not generate may still read what
      // was generated", and then the student pass showed a child their own
      // three invoices under the heading "সাম্প্রতিক ইনভয়েস" on a screen
      // called "ইনভয়েস তৈরি". A family reading its own bills has `#/fees`,
      // which is built for it; this screen is the monthly billing run.
      root.append(permissionState(d, {
        message: permissionMessage('ইনভয়েস তৈরি'),
        contact: 'প্রধান শিক্ষক, প্রতিষ্ঠান মালিক ও হিসাবরক্ষক',
      }));
      return;
    }

    const form = el(d, 'form', { className: 'ui-card ui-card-form' });
    append(form, el(d, 'h3', { className: 'ui-card-title', text: 'নতুন ইনভয়েস' }));

    const period = field(d, {
      label: 'বিলিং মাস',
      name: 'period',
      kind: 'month',
      value: this.period,
      required: true,
      // Said before the button, not after the second press.
      helper: 'একই মাসে দুইবার চালালে কারও দ্বিতীয় ইনভয়েস তৈরি হবে না — ' +
              'যাদের ইনভয়েস আগেই আছে তাদের বাদ দেওয়া হয়।',
      onChange: (v) => { this.period = v; },
    });
    append(form, period.root);

    append(form, buttonRow(d, button(d, {
      label: 'ইনভয়েস তৈরি করুন', variant: 'primary', type: 'submit', busy: this.busy,
    })));

    form.addEventListener('submit', (e) => {
      e.preventDefault();
      this.period = period.value();
      if (!/^\d{4}-\d{2}$/.test(this.period)) {
        // Field-level: the month picker keeps whatever the person set while
        // they fix it, instead of the whole screen repainting under them.
        setFieldError(period.root, 'মাস বেছে নিন।');
        period.input.focus();
        return;
      }
      clearFieldError(period.root);
      form.append(confirmDialog({
        doc: d,
        title: 'ইনভয়েস তৈরি নিশ্চিত করুন',
        body:
          `${bnMonth(this.period)} মাসের জন্য ইনভয়েস তৈরি হবে। ` +
          'যাদের এই মাসের ইনভয়েস আগেই আছে, তাদের নতুন ইনভয়েস হবে না। ' +
          'ফি পরিশোধের দায়িত্বে থাকা অভিভাবকদের জানানো হবে।',
        confirmLabel: 'তৈরি করুন',
        danger: true,
        onConfirm: () => void this.generate(),
      }));
    });
    root.append(form);

    this.renderRecent(root);
  }

  private renderRecent(root: HTMLElement): void {
    const d = this.o.doc;
    root.append(sectionHeading(d, { title: 'সাম্প্রতিক ইনভয়েস' }));

    if (this.loading) { root.append(skeleton(d, 3)); return; }
    if (this.recent.length === 0) {
      root.append(emptyState(d, {
        message: 'এখনো কোনো ইনভয়েস তৈরি হয়নি। মাস বেছে নিয়ে তৈরি করুন।',
      }));
      return;
    }

    root.append(dataTable(d, {
      caption: 'সাম্প্রতিক ইনভয়েস',
      rows: this.recent,
      rowKey: (inv) => inv.invoiceNo,
      columns: [
        { key: 'no', header: 'ইনভয়েস', mobile: 'title', cell: (inv) => inv.invoiceNo,
          width: 'minmax(0, 1.8fr)' },
        // Was `2026-08`, printed straight out of the database.
        { key: 'period', header: 'মাস', mobile: 'subtitle',
          cell: (inv) => bnMonth(inv.billingPeriod), width: 'minmax(0, 1.2fr)' },
        // Amounts printed exactly as the server sent them: decimal strings.
        { key: 'total', header: 'মোট', mobile: 'meta', numeric: true,
          cell: (inv) => formatBdt(inv.totalAmount), width: 'minmax(0, 1.2fr)' },
        // The balance, not just the total. Without it a clerk who has just
        // taken ৳600 against a ৳1,500 bill sees the row unchanged and cannot
        // tell whether the money registered — the total never moves.
        { key: 'due', header: 'বকেয়া', mobile: 'meta', numeric: true,
          cell: (inv) => formatBdt(inv.balanceAmount), width: 'minmax(0, 1.2fr)' },
        { key: 'state', header: 'অবস্থা', mobile: 'status', width: '130px',
          cell: (inv) => statusBadge(d, {
            state: Number(inv.balanceAmount) <= 0 ? 'paid'
              : Number(inv.balanceAmount) < Number(inv.totalAmount) ? 'partial' : 'due',
            // Three states, not two: a bill with something paid against it is
            // neither settled nor untouched, and the office needs to see which
            // families have started paying.
            label: Number(inv.balanceAmount) <= 0 ? 'পরিশোধিত'
              : Number(inv.balanceAmount) < Number(inv.totalAmount) ? 'আংশিক' : 'বকেয়া',
          }) },
        // P-writers/B-48. Until this, an issued bill could never be marked
        // paid: the only receipt writer in the product was the MFS webhook and
        // POST /finance/pay is kill-switched. A school takes money at the
        // counter, so the counter is where the control belongs.
        ...(this.o.canGenerate ? [{
          key: 'collect', header: 'ব্যবস্থা',
          cell: (inv: InvoiceRow) => (Number(inv.balanceAmount) <= 0
            ? el(d, 'span', { className: 'att-sub', text: '—' })
            : buttonRow(d, button(d, {
              label: 'টাকা জমা নিন', size: 'sm', variant: 'primary',
              disabled: this.busy,
              onClick: () => { void this.openCollect(inv); },
            }))),
        }] : []),
      ],
    }));
  }

  /* ------------------------------------------------------------ payment */

  /**
   * Take a payment against one bill.
   *
   * Opens on the server's own view of the invoice rather than the list row:
   * the list is a snapshot and somebody else may have collected since it was
   * drawn, so the balance shown here — and the balance the save is checked
   * against — is read fresh.
   */
  private async openCollect(inv: InvoiceRow): Promise<void> {
    const d = this.o.doc;
    let data: {
      invoice: { invoiceNo: string; studentBn: string; balanceAmount: number; totalAmount: number };
      methods: { code: string; labelBn: string }[];
      receipts: { receiptNo: string; amount: number; methodBn: string }[];
    };
    try {
      const res = await this.o.auth.authedFetch(
        `/api/v1/finance/payments?invoiceId=${encodeURIComponent(inv.id)}`);
      if (!res.ok) throw new Error(String(res.status));
      data = await res.json() as typeof data;
    } catch {
      this.error = 'বিলের তথ্য আনা যায়নি।';
      this.render();
      return;
    }

    const form = el(d, 'div', { className: 'ui-fieldset' });
    const errLine = el(d, 'p', {
      className: 'ui-field-error', attrs: { role: 'alert', hidden: 'hidden' },
    });
    append(form, errLine);

    append(form, el(d, 'p', {
      className: 'att-sub',
      text: `${data.invoice.studentBn} · ${data.invoice.invoiceNo} — `
        + `মোট ${formatBdt(String(data.invoice.totalAmount))}, `
        + `বকেয়া ${formatBdt(String(data.invoice.balanceAmount))}`,
    }));

    const amount = field(d, {
      label: 'কত টাকা জমা হলো', name: 'amount', kind: 'number', required: true,
      value: String(data.invoice.balanceAmount),
      helper: 'পুরোটা বা একাংশ — কিস্তিতে নিলে প্রতিবার আলাদা রসিদ হবে।',
      attrs: { min: 1, max: data.invoice.balanceAmount, step: 1 },
    });
    const method = field(d, {
      label: 'কীভাবে এসেছে', name: 'method', kind: 'select', required: true,
      // Server-supplied, from the mfs_provider enum — never a hard-coded list.
      options: data.methods.map((m) => ({ value: m.code, label: m.labelBn })),
    });
    const reference = field(d, {
      label: 'রেফারেন্স', name: 'reference',
      helper: 'ঐচ্ছিক — চেক নম্বর বা ট্রানজেকশন আইডি।',
      attrs: { maxlength: 120 },
    });
    append(form, amount.root, method.root, reference.root);

    if (data.receipts.length > 0) {
      append(form, el(d, 'p', {
        className: 'ui-field-label', text: 'আগের রসিদ',
      }));
      for (const r of data.receipts) {
        append(form, el(d, 'p', {
          className: 'att-sub',
          text: `${r.receiptNo} — ${formatBdt(String(r.amount))} (${r.methodBn})`,
        }));
      }
    }

    let handle: OverlayHandle;
    const cancel = button(d, {
      label: 'বাতিল', variant: 'secondary', onClick: () => handle.close(),
    });
    const save = button(d, {
      label: 'রসিদ দিন', variant: 'primary',
      onClick: async () => {
        errLine.setAttribute('hidden', 'hidden');
        setBusy(save, true);
        let msg = '';
        let issued: { receiptNo?: string; ledgerPosted?: boolean } = {};
        try {
          const res = await this.o.auth.authedFetch('/api/v1/finance/payments', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              invoiceId: inv.id,
              amount: Number(amount.input.value),
              method: method.input.value,
              reference: reference.input.value.trim() || undefined,
            }),
          });
          const out = await res.json().catch(() => ({})) as
            { message?: string; receiptNo?: string; ledgerPosted?: boolean };
          if (!res.ok) msg = out.message ?? 'টাকা জমা নেওয়া যায়নি।';
          else issued = out;
        } catch {
          msg = 'সংযোগ নেই — টাকা জমা নেওয়া হয়নি।';
        }
        setBusy(save, false);
        // A refusal keeps the drawer open with the amount intact: the server
        // names the balance when it refuses an overpayment, and the clerk
        // needs the figure they typed still in front of them (B-60).
        if (msg) {
          errLine.textContent = msg;
          errLine.removeAttribute('hidden');
          announce(d, msg, true);
          return;
        }
        handle.close();
        await this.load();
        this.notice = `রসিদ ${issued.receiptNo ?? ''} দেওয়া হয়েছে।`
          // Honest when the books were skipped: the receipt is valid, the
          // ledger row is not there, and an accountant should know now rather
          // than at reconciliation.
          + (issued.ledgerPosted === false
            ? ' হিসাবের খাতা এখনো তৈরি হয়নি — লেজারে ওঠেনি।' : '');
        this.render();
      },
    });
    handle = openDrawer(d, {
      title: 'টাকা জমা নিন',
      body: form,
      actions: [cancel, save],
    });
  }
}
