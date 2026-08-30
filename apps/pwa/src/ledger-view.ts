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
  private notice = '';

  constructor(options: LedgerViewOptions) {
    this.o = options;
    void this.load();
  }

  private async load(): Promise<void> {
    try {
      const res = await this.o.auth.authedFetch('/api/v1/finance/ledger');
      if (res.ok) {
        this.data = (await res.json()) as LedgerPayload;
      } else if (res.status === 401 || res.status === 403) {
        this.notice = 'শুধু হিসাবরক্ষক পর্যায়ের জন্য — নমুনা ডেটা দেখানো হচ্ছে।';
        this.data = DEMO;
      } else {
        this.data = DEMO;
      }
    } catch {
      this.data = DEMO;
    }
    this.loading = false;
    this.render();
  }

  private render(): void {
    const d = this.o.doc;
    const root = this.o.root;
    root.textContent = '';

    const header = d.createElement('header');
    header.className = 'page-header';
    const h1 = d.createElement('h1');
    h1.textContent = 'লেজার ও পুনর্মিলন';
    const sub = d.createElement('p');
    sub.className = 'page-sub';
    sub.textContent = 'দ্বৈত-এন্ট্রি হিসাব — bKash/Nagad পুনর্মিলন সহ';
    header.append(h1, sub);
    root.append(header);

    if (this.notice) {
      const n = d.createElement('p');
      n.className = 'inline-notice';
      n.textContent = this.notice;
      root.append(n);
    }

    if (this.loading || !this.data) {
      const p = d.createElement('p'); p.className = 'page-sub'; p.textContent = 'লোড হচ্ছে…';
      root.append(p);
      return;
    }

    // Reconciliation cards — the money-in view.
    const recH = d.createElement('h2');
    recH.className = 'section-heading';
    recH.textContent = 'MFS পুনর্মিলন';
    root.append(recH);
    const recGrid = d.createElement('div');
    recGrid.className = 'recon-grid';
    for (const r of this.data.reconciliation) {
      const card = d.createElement('div');
      card.className = 'card recon-card';
      const label = d.createElement('span'); label.className = 'recon-provider'; label.textContent = r.provider;
      const posted = d.createElement('span'); posted.className = 'recon-posted'; posted.textContent = taka(r.posted);
      const meta = d.createElement('span'); meta.className = 'recon-meta';
      const match = Number(r.reconciled) === Number(r.posted);
      meta.textContent = match ? '✓ সম্পূর্ণ মিলেছে' : `${taka(r.reconciled)} মিলেছে`;
      meta.dataset.state = match ? 'ok' : 'partial';
      card.append(label, posted, meta);
      recGrid.append(card);
    }
    root.append(recGrid);

    // Chart of accounts.
    const acctH = d.createElement('h2');
    acctH.className = 'section-heading';
    acctH.textContent = 'হিসাব-তালিকা';
    root.append(acctH);
    const acctList = d.createElement('ul');
    acctList.className = 'ledger-list';
    for (const a of this.data.accounts) {
      const li = d.createElement('li');
      li.className = 'ledger-row';
      li.dataset.type = a.type;
      const code = d.createElement('span'); code.className = 'ledger-code'; code.textContent = a.code;
      const name = d.createElement('span'); name.className = 'ledger-name'; name.textContent = a.nameBn;
      const bal = d.createElement('span'); bal.className = 'ledger-bal'; bal.textContent = taka(a.balance);
      li.append(code, name, bal);
      acctList.append(li);
    }
    root.append(acctList);

    // Recent entries.
    const batchH = d.createElement('h2');
    batchH.className = 'section-heading';
    batchH.textContent = 'সাম্প্রতিক এন্ট্রি';
    root.append(batchH);
    for (const b of this.data.batches) {
      const card = d.createElement('div');
      card.className = 'card batch-card';
      const memo = d.createElement('div'); memo.className = 'batch-memo';
      memo.textContent = `${b.entryDate} · ${b.memo}`;
      card.append(memo);
      for (const line of b.lines) {
        const row = d.createElement('div');
        row.className = 'batch-line';
        const acct = d.createElement('span'); acct.textContent = line.accountCode;
        const dr = d.createElement('span'); dr.className = 'batch-dr';
        dr.textContent = Number(line.debit) > 0 ? `DR ${taka(line.debit)}` : '';
        const cr = d.createElement('span'); cr.className = 'batch-cr';
        cr.textContent = Number(line.credit) > 0 ? `CR ${taka(line.credit)}` : '';
        row.append(acct, dr, cr);
        card.append(row);
      }
      root.append(card);
    }
  }
}

const DEMO: LedgerPayload = {
  accounts: [
    { code: 'MFS-BKASH',  nameBn: 'bKash সংগ্রহ',   type: 'asset',  balance: '18450.00' },
    { code: 'MFS-NAGAD',  nameBn: 'Nagad সংগ্রহ',   type: 'asset',  balance: '9200.00' },
    { code: 'MFS-ROCKET', nameBn: 'Rocket সংগ্রহ',  type: 'asset',  balance: '3100.00' },
    { code: 'CASH',       nameBn: 'নগদ',            type: 'asset',  balance: '5750.00' },
    { code: 'FEE-INCOME', nameBn: 'বেতন ও ফি আয়',   type: 'income', balance: '36500.00' },
  ],
  batches: [
    {
      batchId: 'demo-b1', entryDate: '2026-08-08', memo: 'MFS payment received (bKash)',
      lines: [
        { accountCode: 'MFS-BKASH', debit: '1250.00', credit: '0' },
        { accountCode: 'FEE-INCOME', debit: '0', credit: '1250.00' },
      ],
    },
    {
      batchId: 'demo-b2', entryDate: '2026-08-08', memo: 'MFS payment received (Nagad)',
      lines: [
        { accountCode: 'MFS-NAGAD', debit: '750.00', credit: '0' },
        { accountCode: 'FEE-INCOME', debit: '0', credit: '750.00' },
      ],
    },
    {
      batchId: 'demo-b3', entryDate: '2026-08-07', memo: 'MFS payment received (bKash)',
      lines: [
        { accountCode: 'MFS-BKASH', debit: '1000.00', credit: '0' },
        { accountCode: 'FEE-INCOME', debit: '0', credit: '1000.00' },
      ],
    },
  ],
  reconciliation: [
    { provider: 'bKash',  posted: '18450.00', reconciled: '18450.00' },
    { provider: 'Nagad',  posted: '9200.00',  reconciled: '9200.00' },
    { provider: 'Rocket', posted: '3100.00',  reconciled: '2350.00' },
  ],
};
