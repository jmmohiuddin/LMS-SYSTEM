/**
 * Ledger (লেজার ও পুনর্মিলন) — PRD §4 double-entry ledger view.
 *
 * Reads GET /api/v1/finance/ledger when authenticated as accountant-level;
 * falls back to demo data otherwise. Shows the chart of accounts, recent
 * balanced batches (DR/CR pairs) and the running totals per MFS provider —
 * this is the surface that proves receipts + ledger posting are actually
 * happening, since the writes live inside the webhook processor.
 */
import { formatBdt } from '../../../packages/ui-core/src/format.ts';
import type { Auth } from './auth.ts';
import {
  pageHeader, sectionHeading, card, dataTable, statRow, statCard, listSkeleton,
  permissionState, permissionMessage,
} from './ui/index.ts';
import { errorState } from './view-states.ts';
import { isDenied } from './http-status.ts';
import { bnDate } from './view-states.ts';

/** The account types this chart uses, in words rather than in English keys. */
const ACCOUNT_TYPE_BN: Record<string, string> = {
  asset: 'সম্পদ',
  liability: 'দায়',
  income: 'আয়',
  expense: 'ব্যয়',
  equity: 'মূলধন',
};

interface AccountBalance {
  code: string;
  nameBn: string;
  type: 'asset' | 'liability' | 'equity' | 'income' | 'expense';
  balance: string;
}

interface LedgerBatch {
  batchId: string;
  entryDate: string;
  memo: string;
  lines: { accountCode: string; debit: string; credit: string }[];
}

interface LedgerPayload {
  accounts: AccountBalance[];
  batches: LedgerBatch[];
  reconciliation: { provider: string; posted: string; reconciled: string }[];
}

/**
 * R-8 audit — the THIRD private money formatter found in this pass, and on the
 * surface where it mattered most: a double-entry ledger whose debits and
 * credits an accounts clerk reconciles against a bank statement. Bangla digits
 * are the wrong choice there for the same reason they are wrong on a receipt.
 * One formatter now, in ui-core.
 */
const taka = formatBdt;

export interface LedgerViewOptions {
  root: HTMLElement;
  doc: Document;
  auth: Auth;
}

export class LedgerView {
  private readonly o: LedgerViewOptions;
  private data: LedgerPayload | null = null;
  private loading = true;
  /** The server refused. No retry can help, and no data may be shown. */
  private denied = false;
  private error = '';

  constructor(options: LedgerViewOptions) {
    this.o = options;
    void this.load();
  }

  /**
   * P5. A refusal renders a refusal.
   *
   * This method used to answer a 403 with `this.data = DEMO` — a complete,
   * plausible chart of accounts and three double-entry batches in taka, under
   * one quiet line saying they were samples. Two rules at once: B-30's "a
   * refusal is not a data state", and the standing rule against faking
   * production state. A school's coordinator opening this saw numbers that
   * looked exactly like their books and were not.
   *
   * Nothing is fabricated here now. The demo's own fixture lives in
   * `demo.ts`, gated to the roles `LEDGER_ROLES` allows, like every other
   * screen's demo data.
   */
  private async load(): Promise<void> {
    try {
      const res = await this.o.auth.authedFetch('/api/v1/finance/ledger');
      if (isDenied(res)) { this.denied = true; }
      else if (res.ok) { this.data = (await res.json()) as LedgerPayload; }
      else { this.error = 'হিসাব আনা যায়নি — সংযোগ পেলে আবার দেখা যাবে।'; }
    } catch {
      this.error = 'সংযোগ নেই — হিসাব আনা যায়নি।';
    }
    this.loading = false;
    this.render();
  }

  private render(): void {
    const d = this.o.doc;
    const root = this.o.root;
    root.textContent = '';

    root.append(pageHeader(d, {
      title: 'লেজার ও পুনর্মিলন',
      subtitle: 'দ্বৈত-এন্ট্রি হিসাব — bKash/Nagad পুনর্মিলন সহ',
    }));

    if (this.denied) {
      root.append(permissionState(d, {
        message: permissionMessage('লেজার ও পুনর্মিলন'),
        contact: 'প্রধান শিক্ষক, প্রতিষ্ঠান মালিক ও হিসাবরক্ষক',
      }));
      return;
    }
    if (this.error) { root.append(errorState(d, this.error, () => void this.load())); return; }
    if (this.loading || !this.data) { root.append(listSkeleton(d, 4)); return; }

    // ── MFS reconciliation: the money-in view ──
    // Stat cards, because each provider is one figure with one verdict, and
    // that is what a stat card is for. Cards that did this by hand had their
    // own `.recon-card` class and their own margins.
    root.append(sectionHeading(d, { title: 'MFS পুনর্মিলন' }));
    root.append(statRow(d, ...this.data.reconciliation.map((r) => {
      const matched = Number(r.reconciled) === Number(r.posted);
      return statCard(d, {
        label: r.provider,
        value: taka(r.posted),
        glyph: 'wallet',
        tone: matched ? 'success' : 'warn',
        // Never the tint alone: a school reconciling money must be able to
        // tell "all matched" from "some matched" without seeing colour.
        note: matched ? 'সম্পূর্ণ মিলেছে' : `${taka(r.reconciled)} মিলেছে — বাকিটা মেলেনি`,
      });
    })));

    // ── Chart of accounts ──
    root.append(sectionHeading(d, { title: 'হিসাব-তালিকা' }));
    root.append(dataTable(d, {
      caption: 'হিসাব-তালিকা',
      rows: this.data.accounts,
      rowKey: (a) => a.code,
      columns: [
        { key: 'code', header: 'কোড', mobile: 'meta', cell: (a) => a.code,
          width: 'minmax(0, 1.2fr)' },
        { key: 'name', header: 'হিসাব', mobile: 'title', cell: (a) => a.nameBn,
          width: 'minmax(0, 2fr)' },
        { key: 'type', header: 'ধরন', mobile: 'subtitle',
          cell: (a) => ACCOUNT_TYPE_BN[a.type] ?? a.type, width: 'minmax(0, 1fr)' },
        { key: 'bal', header: 'ব্যালেন্স', mobile: 'meta', numeric: true,
          cell: (a) => taka(a.balance), width: 'minmax(0, 1.2fr)' },
      ],
    }));

    // ── Recent entries ──
    // One table per batch: double entry is READ as a table, and the fact that
    // the two columns sum to the same number is the whole point of the layout.
    root.append(sectionHeading(d, { title: 'সাম্প্রতিক এন্ট্রি' }));
    for (const b of this.data.batches) {
      root.append(card(d, {
        title: b.memo,
        subtitle: bnDate(b.entryDate),
        glyph: 'book',
        headingLevel: 3,
      }, dataTable(d, {
        caption: `${b.memo} — ডেবিট ও ক্রেডিট`,
        rows: b.lines,
        rowKey: (l) => `${b.batchId}-${l.accountCode}`,
        columns: [
          { key: 'acct', header: 'হিসাব', mobile: 'title', cell: (l) => l.accountCode,
            width: 'minmax(0, 2fr)' },
          { key: 'dr', header: 'ডেবিট', mobile: 'meta', numeric: true,
            cell: (l) => (Number(l.debit) > 0 ? taka(l.debit) : '—'),
            width: 'minmax(0, 1.2fr)' },
          { key: 'cr', header: 'ক্রেডিট', mobile: 'meta', numeric: true,
            cell: (l) => (Number(l.credit) > 0 ? taka(l.credit) : '—'),
            width: 'minmax(0, 1.2fr)' },
        ],
      })));
    }
  }

}
