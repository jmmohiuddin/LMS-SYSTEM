/**
 * Bulk import — F-1601, wireframe §10.2 "the pilot blocker"
 *
 *   ①ফাইল ─── ②যাচাই ─── ③পূর্বরূপ ─── ④আমদানি
 *
 * The screen a head teacher meets on day one, with 784 rows exported from
 * a spreadsheet that has been maintained by hand for six years. Almost all
 * of the design here is about the sixteen rows that are wrong.
 *
 * §10.2's rules and how the screen keeps them:
 *
 *   "Dry-run first, always — nothing is written until step 4."
 *      → the import button does not exist before validation has run, and
 *        the file cannot skip a step. Step 2 is a different request from
 *        step 4, and only step 4 says commit.
 *
 *   "Errors are reported per row with the reason, and the error list is
 *    downloadable so it can be fixed in the source spreadsheet."
 *      → the list is rendered AND offered as a CSV built by the server, so
 *        the file the operator opens is the one the server judged.
 *
 *   "Partial import is permitted but the skipped count is stated
 *    explicitly and logged (no silent truncation)."
 *      → the primary button carries both numbers, exactly as §10.2 writes
 *        it: "৭৬৮টি ঠিক সারি আমদানি করুন, ১৬টি বাদ". There is no way to
 *        press it without reading how many students are being left out.
 *
 * Framework-free manual DOM, same as every other view here.
 */
import type { Auth } from './auth.ts';
import { formatCount } from '../../../packages/ui-core/src/format.ts';
import { pageHeader } from './ui/page-header.ts';

const bn = (n: number): string => formatCount(n, 'bn');

export interface ImportError {
  lineNo: number;
  rollNo: string;
  field: string;
  messageBn: string;
}

interface DryRun {
  digest: string;
  rowsRead: number;
  rowsValid: number;
  rowsRejected: number;
  rowsImported: number;
  batchId: string | null;
  errors: ImportError[];
  errorCsv: string | null;
}

export interface ImportViewOptions {
  root: HTMLElement;
  doc: Document;
  auth: Auth;
  /** The year to import into. Supplied by the shell; no picker in this screen. */
  academicYearId?: string;
}

type Step = 1 | 2 | 3 | 4;

const STEPS: Array<{ n: Step; labelBn: string }> = [
  { n: 1, labelBn: 'ফাইল' },
  { n: 2, labelBn: 'যাচাই' },
  { n: 3, labelBn: 'পূর্বরূপ' },
  { n: 4, labelBn: 'আমদানি' },
];

/** §10.2 shows a handful and then "···". A wall of 784 is not a report. */
const ERRORS_SHOWN = 12;

export class ImportView {
  private readonly o: ImportViewOptions;
  private step: Step = 1;
  private fileName = '';
  private csv = '';
  private result: DryRun | null = null;
  private busy = false;
  private error: string | null = null;

  constructor(options: ImportViewOptions) {
    this.o = options;
    this.render();
  }

  // ── actions ─────────────────────────────────────────────────────────
  private async send(commit: boolean): Promise<void> {
    if (this.busy || !this.csv) return;
    this.busy = true;
    this.error = null;
    this.render();
    try {
      const res = await this.o.auth.authedFetch('/api/v1/academics/import', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          kind: 'student',
          academicYearId: this.o.academicYearId,
          fileName: this.fileName,
          csv: this.csv,
          ...(commit ? { commit: true, digest: this.result?.digest } : {}),
        }),
      });
      const body = (await res.json()) as DryRun & { message?: string };
      if (!res.ok) {
        this.error = body.message ?? 'ফাইলটি পড়া যায়নি।';
        // A digest mismatch means the file changed underneath the check.
        // Sending the operator back to step 1 is the only honest response.
        if (this.step === 4) this.step = 1;
      } else {
        this.result = body;
        this.step = commit ? 4 : 3;
      }
    } catch {
      this.error = 'সংযোগ পাওয়া যায়নি। পরে চেষ্টা করুন।';
    } finally {
      this.busy = false;
      this.render();
    }
  }

  private downloadErrors(): void {
    if (!this.result?.errorCsv) return;
    const d = this.o.doc;
    // The server built this, BOM and all, so the file Excel opens is
    // byte-identical to the one the server judged.
    const blob = new Blob([this.result.errorCsv], { type: 'text/csv;charset=utf-8' });
    const a = d.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `import-errors-${this.fileName || 'students'}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  private reset(): void {
    this.step = 1;
    this.csv = '';
    this.fileName = '';
    this.result = null;
    this.error = null;
    this.render();
  }

  // ── rendering ───────────────────────────────────────────────────────
  private render(): void {
    const d = this.o.doc;
    const root = this.o.root;
    root.textContent = '';
    root.setAttribute('lang', 'bn');

    const header = pageHeader(d, {
      title: 'শিক্ষার্থী আমদানি',
      subtitle: `ধাপ ${bn(this.step)} / ${bn(4)}`,
    });
    root.append(header);

    root.append(this.stepper());

    if (this.error) {
      const p = d.createElement('p');
      p.className = 'inline-notice is-danger';
      p.setAttribute('role', 'alert');
      p.textContent = `${this.error}`;
      root.append(p);
    }

    if (this.step === 1) root.append(this.filePicker());
    if (this.step === 3) root.append(this.reviewCard());
    if (this.step === 4) root.append(this.doneCard());
  }

  private stepper(): HTMLElement {
    const d = this.o.doc;
    const ol = d.createElement('ol');
    ol.className = 'stepper';
    ol.setAttribute('aria-label', 'আমদানির ধাপ');
    for (const s of STEPS) {
      const li = d.createElement('li');
      li.className = 'stepper-step';
      const state = s.n < this.step ? 'done' : s.n === this.step ? 'current' : 'todo';
      li.dataset.state = state;
      if (state === 'current') li.setAttribute('aria-current', 'step');

      const num = d.createElement('span');
      num.className = 'stepper-num';
      // A tick for done, the number for the rest. Never state by colour
      // alone — this bar is the only thing telling the operator whether
      // anything has been written yet.
      num.textContent = state === 'done' ? '✓' : bn(s.n);
      const label = d.createElement('span');
      label.className = 'stepper-label';
      label.textContent = s.labelBn;
      li.append(num, label);
      ol.append(li);
    }
    return ol;
  }

  private filePicker(): HTMLElement {
    const d = this.o.doc;
    const card = d.createElement('section');
    card.className = 'card import-card';

    const p = d.createElement('p');
    p.className = 'import-help';
    p.textContent = 'CSV ফাইল বেছে নিন। কলাম: রোল, নাম, শ্রেণি, শাখা, মোবাইল, '
                  + 'চতুর্থ বিষয় (নবম শ্রেণি থেকে আবশ্যক)।';
    card.append(p);

    const note = d.createElement('p');
    note.className = 'import-help import-help-quiet';
    // §10.2: "the file never contains a subject column". Saying so up front
    // saves an operator building one.
    note.textContent = 'বিষয়ের তালিকা ফাইলে দিতে হবে না — আমদানির পর টেমপ্লেট থেকে '
                     + 'স্বয়ংক্রিয়ভাবে নির্ধারিত হবে।';
    card.append(note);

    const input = d.createElement('input');
    input.type = 'file';
    input.accept = '.csv,text/csv';
    input.setAttribute('aria-label', 'CSV ফাইল');
    input.addEventListener('change', () => {
      const file = input.files?.[0];
      if (!file) return;
      this.fileName = file.name;
      const reader = new FileReader();
      reader.onload = () => {
        this.csv = String(reader.result ?? '');
        this.step = 2;
        this.render();
        void this.send(false);
      };
      reader.onerror = () => { this.error = 'ফাইলটি পড়া যায়নি।'; this.render(); };
      // The server strips the BOM; reading as UTF-8 is what keeps Bangla
      // intact on the way in.
      reader.readAsText(file, 'utf-8');
    });
    card.append(input);

    if (this.step === 2 || this.busy) {
      const busy = d.createElement('p');
      busy.className = 'import-help';
      busy.setAttribute('role', 'status');
      busy.textContent = 'যাচাই করা হচ্ছে…';
      card.append(busy);
    }
    return card;
  }

  private reviewCard(): HTMLElement {
    const d = this.o.doc;
    const r = this.result as DryRun;
    const card = d.createElement('section');
    card.className = 'card import-card';

    const read = d.createElement('p');
    read.className = 'import-stat is-ok';
    read.textContent = `✓ ${bn(r.rowsRead)}টি সারি পড়া হয়েছে`;
    card.append(read);

    if (r.rowsRejected > 0) {
      const bad = d.createElement('p');
      bad.className = 'import-stat is-warn';
      bad.textContent = `${bn(r.rowsRejected)}টি সারিতে সমস্যা`;
      card.append(bad);

      const ul = d.createElement('ul');
      ul.className = 'import-errors';
      for (const e of r.errors.slice(0, ERRORS_SHOWN)) {
        const li = d.createElement('li');
        const line = d.createElement('span');
        line.className = 'import-line';
        line.textContent = `সারি ${bn(e.lineNo)}`;
        const why = d.createElement('span');
        why.className = 'import-why';
        why.textContent = e.messageBn;
        li.append(line, why);
        ul.append(li);
      }
      if (r.errors.length > ERRORS_SHOWN) {
        const more = d.createElement('li');
        more.className = 'import-more';
        // Never "···" alone: the count is what tells the operator whether
        // to keep scrolling or to go and fix the spreadsheet.
        more.textContent = `··· আরও ${bn(r.errors.length - ERRORS_SHOWN)}টি`;
        ul.append(more);
      }
      card.append(ul);

      const dl = d.createElement('button');
      dl.type = 'button';
      dl.className = 'btn-secondary';
      dl.textContent = 'সমস্যার তালিকা';
      dl.addEventListener('click', () => { this.downloadErrors(); });

      const again = d.createElement('button');
      again.type = 'button';
      again.className = 'btn-secondary';
      again.textContent = 'ঠিক করে আবার আপলোড';
      again.addEventListener('click', () => { this.reset(); });

      const row = d.createElement('div');
      row.className = 'import-actions';
      row.append(dl, again);
      card.append(row);
    }

    const go = d.createElement('button');
    go.type = 'button';
    go.className = 'btn-primary import-go';
    go.disabled = this.busy || r.rowsValid === 0;
    // §10.2's exact phrasing. Both numbers on the button itself, so the
    // skipped students cannot be pressed past without being read.
    go.textContent = r.rowsRejected > 0
      ? `${bn(r.rowsValid)}টি ঠিক সারি আমদানি করুন, ${bn(r.rowsRejected)}টি বাদ`
      : `${bn(r.rowsValid)}টি সারি আমদানি করুন`;
    go.addEventListener('click', () => { void this.send(true); });
    card.append(go);

    if (r.rowsValid === 0) {
      const none = d.createElement('p');
      none.className = 'import-help';
      none.textContent = 'কোনো সারি আমদানির উপযুক্ত নয়। ফাইলটি ঠিক করে আবার চেষ্টা করুন।';
      card.append(none);
    }
    return card;
  }

  private doneCard(): HTMLElement {
    const d = this.o.doc;
    const r = this.result as DryRun;
    const card = d.createElement('section');
    card.className = 'card import-card';

    const h = d.createElement('p');
    h.className = 'import-stat is-ok';
    h.setAttribute('role', 'status');
    h.textContent = `✓ ${bn(r.rowsImported)}টি শিক্ষার্থী আমদানি হয়েছে`;
    card.append(h);

    if (r.rowsRejected > 0) {
      // Stated after the fact as well as before it. "No silent truncation"
      // means the skipped rows are still on screen once the work is done.
      const skipped = d.createElement('p');
      skipped.className = 'import-stat is-warn';
      skipped.textContent = `${bn(r.rowsRejected)}টি সারি বাদ দেওয়া হয়েছে`;
      card.append(skipped);

      if (r.errorCsv) {
        const dl = d.createElement('button');
        dl.type = 'button';
        dl.className = 'btn-secondary';
        dl.textContent = 'বাদ পড়া সারির তালিকা';
        dl.addEventListener('click', () => { this.downloadErrors(); });
        card.append(dl);
      }
    }

    const next = d.createElement('p');
    next.className = 'import-help';
    next.textContent = 'প্রতিটি শিক্ষার্থীর বিষয় তালিকা টেমপ্লেট থেকে নির্ধারিত হয়েছে।';
    card.append(next);

    const more = d.createElement('button');
    more.type = 'button';
    more.className = 'btn-secondary';
    more.textContent = 'আরেকটি ফাইল আমদানি করুন';
    more.addEventListener('click', () => { this.reset(); });
    card.append(more);

    return card;
  }
}
