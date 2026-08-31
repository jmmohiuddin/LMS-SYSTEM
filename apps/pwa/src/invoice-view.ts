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
          : body.message ?? 'ইনভয়েস তৈরি করা যায়নি।';
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
      const note = d.createElement('p');
      note.className = 'att-sub';
      note.style.padding = '0 var(--s-4) var(--s-3)';
      note.textContent = 'ইনভয়েস তৈরির অনুমতি কেবল প্রধান শিক্ষক, প্রতিষ্ঠান মালিক ও হিসাবরক্ষকের।';
      root.append(note);
      this.renderRecent(root);
      return;
    }

    const card = d.createElement('div');
    card.className = 'card card-form';
    card.style.margin = '0 var(--s-4) var(--s-3)';

    const field = d.createElement('label');
    field.className = 'field';
    field.textContent = 'বিলিং মাস';
    const input = d.createElement('input');
    input.type = 'month';
    input.className = 'field-input';
    input.value = this.period;
    input.addEventListener('change', () => { this.period = input.value; });
    field.append(input);
    card.append(field);

    // Said before the button, not after the second press.
    const safe = d.createElement('p');
    safe.className = 'att-sub';
    safe.textContent =
      'একই মাসে দুইবার চালালে কারও দ্বিতীয় ইনভয়েস তৈরি হবে না — ' +
      'যাদের ইনভয়েস আগেই আছে তাদের বাদ দেওয়া হয়।';
    card.append(safe);

    const btn = d.createElement('button');
    btn.type = 'button';
    btn.className = 'btn-primary';
    btn.disabled = this.busy;
    btn.textContent = this.busy ? 'তৈরি হচ্ছে…' : 'ইনভয়েস তৈরি করুন';
    btn.addEventListener('click', () => {
      if (!/^\d{4}-\d{2}$/.test(this.period)) {
        this.error = 'মাস বেছে নিন।'; this.render(); return;
      }
      card.append(confirmDialog({
        doc: d,
        title: 'ইনভয়েস তৈরি নিশ্চিত করুন',
        body:
          `${this.period} মাসের জন্য ইনভয়েস তৈরি হবে। ` +
          'যাদের এই মাসের ইনভয়েস আগেই আছে, তাদের নতুন ইনভয়েস হবে না। ' +
          'ফি পরিশোধের দায়িত্বে থাকা অভিভাবকদের জানানো হবে।',
        confirmLabel: 'তৈরি করুন',
        danger: true,
        onConfirm: () => void this.generate(),
      }));
    });
    card.append(btn);
    root.append(card);

    this.renderRecent(root);
  }

  private renderRecent(root: HTMLElement): void {
    const d = this.o.doc;
    const h2 = d.createElement('h2');
    h2.className = 'section-heading';
    h2.textContent = 'সাম্প্রতিক ইনভয়েস';
    root.append(h2);

    if (this.loading) { root.append(skeleton(d, 3)); return; }
    if (this.recent.length === 0) {
      root.append(emptyState(d, {
        message: 'এখনো কোনো ইনভয়েস তৈরি হয়নি। মাস বেছে নিয়ে তৈরি করুন।',
      }));
      return;
    }

    const list = d.createElement('div');
    list.className = 'system-list';
    for (const inv of this.recent) {
      const row = d.createElement('div');
      row.className = 'system-row';
      const t = d.createElement('span');
      t.className = 'system-title';
      t.textContent = inv.invoiceNo;
      const desc = d.createElement('span');
      desc.className = 'system-desc';
      // Amounts printed exactly as the server sent them: decimal strings.
      desc.textContent = `${inv.billingPeriod} · ${formatBdt(inv.totalAmount)}`;
      const chip = d.createElement('span');
      chip.className = 'status-chip';
      if (Number(inv.balanceAmount) <= 0) chip.setAttribute('data-state', 'success');
      chip.textContent = Number(inv.balanceAmount) <= 0 ? 'পরিশোধিত' : 'বকেয়া';
      row.append(t, desc, chip);
      list.append(row);
    }
    root.append(list);
  }
}
