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
 *      → the list is a table with the row number, the field and the reason,
 *        AND is offered as a CSV built by the server, so the file the
 *        operator opens is the one the server judged.
 *
 *   "Partial import is permitted but the skipped count is stated
 *    explicitly and logged (no silent truncation)."
 *      → the primary button carries both numbers, exactly as §10.2 writes
 *        it: "৭৬৮টি ঠিক সারি আমদানি করুন, ১৬টি বাদ". There is no way to
 *        press it without reading how many students are being left out.
 *
 * ── What P5's audit of this screen found ──────────────────────────────────
 *
 * **Student import could not work at all.** `academicYearId` was an optional
 * option nobody passed: `app.ts` mounts `new ImportView({ root, doc, auth })`,
 * so every request went out without a year and came back 400 `invalid_year`.
 * The screen now asks `/academics/hierarchy` for the current year itself —
 * the same cached endpoint the academic screen reads — and says so when a
 * school has not created one yet, because "make a year first" is an
 * instruction and "academicYearId must be a valid uuid" is not.
 *
 * **The failure message was the server's English.** `body.message` went
 * straight to the screen, so the sentence above is what an operator in
 * Sylhet actually saw. Codes are mapped here; the English is never shown.
 *
 * **A failed validation was a dead end.** `render()` drew the picker only at
 * step 1 and the review only at step 3, so an error at step 2 left the
 * operator on a screen with a sentence and no control of any kind — no
 * retry, no back, no file input. The picker now renders through step 2.
 *
 * **The teacher importer had no UI.** R-7 shipped `runTeacherImport` and the
 * endpoint gates it to principal · owner · IT admin — and this screen sent
 * `kind: 'student'` unconditionally, which those same IT admins are not
 * allowed to do. So the one import an IT admin may run was unreachable and
 * the one they could reach refused them. The kind is now chosen from the
 * role, and offered as a choice only where the role really allows both.
 *
 * Framework-free manual DOM, same as every other view here.
 */
import type { Auth } from './auth.ts';
import { formatCount } from '../../../packages/ui-core/src/format.ts';
import {
  pageHeader, card, button, buttonRow, fileUpload, dataTable, statusBadge,
  statRow, statCard, permissionState, permissionMessage, el, append, tabs,
} from './ui/index.ts';
import { emptyState, errorState, skeleton, confirmDialog } from './view-states.ts';
import { isDenied } from './http-status.ts';

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

export type ImportKind = 'student' | 'teacher';

export interface ImportViewOptions {
  root: HTMLElement;
  doc: Document;
  auth: Auth;
  /**
   * The year to import into. Optional: when the caller does not know it, this
   * screen asks `/academics/hierarchy`. Left in the interface because R-7's
   * onboarding wizard mounts this view with a year it already holds.
   */
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

/** Mirrors `IMPORT_ROLES` / `STAFF_IMPORT_ROLES` in academics-svc/api/import.ts. */
const MAY_IMPORT: Record<ImportKind, readonly string[]> = {
  student: ['principal', 'school_owner', 'academic_coordinator'],
  teacher: ['principal', 'school_owner', 'it_admin'],
};

const KIND_BN: Record<ImportKind, string> = {
  student: 'শিক্ষার্থী',
  teacher: 'শিক্ষক ও কর্মী',
};

/**
 * What a failure means, in Bangla, keyed by the server's CODE.
 *
 * Never `body.message`: those strings are written for a developer reading a
 * log ("academicYearId must be a valid uuid", "file is larger than 1 MB") and
 * §14 forbids a raw backend message in visible text.
 */
const FAILURE_BN: Record<string, string> = {
  empty_file: 'ফাইলটি খালি। অন্তত একটি সারি থাকতে হবে।',
  file_too_large: 'ফাইলটি ১ মেগাবাইটের বেশি। কয়েক ভাগে ভাগ করে আপলোড করুন।',
  invalid_year: 'কোন শিক্ষাবর্ষে আমদানি হবে তা জানা যায়নি। একাডেমিক কাঠামো থেকে শিক্ষাবর্ষ তৈরি করুন।',
  unsupported_kind: 'এই ধরনের ফাইল আমদানি করা যায় না।',
  // The one failure that is genuinely about timing: step 2 judged one file
  // and step 4 presented another.
  digest_mismatch: 'যাচাইয়ের পর ফাইলটি বদলে গেছে। আবার আপলোড করে যাচাই করুন।',
  import_failed: 'আমদানি সম্পন্ন হয়নি। কোনো সারি লেখা হয়নি — আবার চেষ্টা করুন।',
};

export class ImportView {
  private readonly o: ImportViewOptions;
  private readonly kinds: ImportKind[];
  private kind: ImportKind;

  private step: Step = 1;
  private fileName = '';
  private csv = '';
  private result: DryRun | null = null;
  private busy = false;
  private error: string | null = null;
  private denied = false;

  /** Resolved once, for the student import only. */
  private yearId: string | null = null;
  private yearLabel = '';
  private yearState: 'idle' | 'loading' | 'ready' | 'none' | 'failed' = 'idle';

  constructor(options: ImportViewOptions) {
    this.o = options;
    const role = options.auth.role;
    this.kinds = (['student', 'teacher'] as const).filter((k) => MAY_IMPORT[k].includes(role));
    // Default to student where allowed — it is the day-one job. An IT admin,
    // who may only do staff, lands on staff.
    this.kind = this.kinds[0] ?? 'student';
    this.yearId = options.academicYearId ?? null;
    if (this.yearId) this.yearState = 'ready';
    this.render();
    // Only if there is actually an import to do. A role with none was asking
    // `/hierarchy` for a year it could never use, and then showing that year
    // in the header of a screen it was about to be refused from.
    if (this.kinds.length > 0 && this.kind === 'student' && !this.yearId) void this.loadYear();
  }

  // ── the year, for the student import ────────────────────────────────
  /**
   * Asked of `/hierarchy` rather than required from the caller.
   *
   * The caller did not pass one, which is how student import shipped broken;
   * and the shell has no business knowing which year an import screen wants.
   */
  private async loadYear(): Promise<void> {
    this.yearState = 'loading';
    this.render();
    try {
      const res = await this.o.auth.authedFetch('/api/v1/academics/hierarchy');
      if (isDenied(res)) { this.denied = true; this.yearState = 'failed'; this.render(); return; }
      if (!res.ok) { this.yearState = 'failed'; this.render(); return; }
      const body = (await res.json()) as { year: { id: string; label: string } | null };
      if (body.year) {
        this.yearId = body.year.id;
        this.yearLabel = body.year.label;
        this.yearState = 'ready';
      } else {
        this.yearState = 'none';
      }
    } catch {
      this.yearState = 'failed';
    }
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
          kind: this.kind,
          // Only the student import takes a year; the teacher import is
          // school-wide and the endpoint rejects a year it did not ask for.
          ...(this.kind === 'student' ? { academicYearId: this.yearId ?? '' } : {}),
          fileName: this.fileName,
          csv: this.csv,
          ...(commit ? { commit: true, digest: this.result?.digest } : {}),
        }),
      });
      const body = (await res.json()) as DryRun & { error?: string };
      if (!res.ok) {
        if (isDenied(res)) {
          this.denied = true;
        } else {
          this.error = FAILURE_BN[body.error ?? ''] ?? 'ফাইলটি পড়া যায়নি। আবার চেষ্টা করুন।';
        }
        // Back to the picker either way: a failure at step 2 or step 4 must
        // leave a way forward, and the way forward is always a file.
        this.step = 1;
      } else {
        this.result = body;
        this.step = commit ? 4 : 3;
      }
    } catch {
      this.error = 'সংযোগ পাওয়া যায়নি। পরে চেষ্টা করুন।';
      this.step = 1;
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
    a.download = `import-errors-${this.fileName || this.kind}.csv`;
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

  private accept(file: File): void {
    this.fileName = file.name;
    this.error = null;
    const reader = new FileReader();
    reader.onload = () => {
      this.csv = String(reader.result ?? '');
      this.step = 2;
      this.render();
      void this.send(false);
    };
    reader.onerror = () => {
      this.error = 'ফাইলটি পড়া যায়নি। এটি কি সত্যিই একটি CSV ফাইল?';
      this.step = 1;
      this.render();
    };
    // The server strips the BOM; reading as UTF-8 is what keeps Bangla
    // intact on the way in.
    reader.readAsText(file, 'utf-8');
  }

  // ── rendering ───────────────────────────────────────────────────────
  private render(): void {
    const d = this.o.doc;
    const root = this.o.root;
    root.textContent = '';
    root.setAttribute('lang', 'bn');

    // A role with no import at all, or one the server refused. Named before
    // anything else is drawn, and WITHOUT the step count: "ধাপ ১ / ৪" above a
    // refusal implies there is a first step to take.
    const barred = this.kinds.length === 0 || this.denied;

    root.append(pageHeader(d, {
      title: barred ? 'আমদানি' : `${KIND_BN[this.kind]} আমদানি`,
      subtitle: barred
        ? undefined
        : this.kind === 'student' && this.yearLabel
          ? `শিক্ষাবর্ষ ${this.yearLabel} · ধাপ ${bn(this.step)} / ${bn(4)}`
          : `ধাপ ${bn(this.step)} / ${bn(4)}`,
    }));

    if (this.kinds.length === 0) {
      root.append(permissionState(d, {
        // The canonical sentence FIRST. Naming who may without saying the
        // reader may not leaves them looking for the button.
        message: permissionMessage('আমদানি'),
        contact: 'প্রধান শিক্ষক, প্রতিষ্ঠান মালিক, একাডেমিক সমন্বয়ক ও আইটি অ্যাডমিন',
      }));
      return;
    }
    if (this.denied) {
      root.append(permissionState(d, {
        contact: 'প্রধান শিক্ষক বা প্রতিষ্ঠান মালিক',
      }));
      return;
    }

    // Offered only where the role really allows both — a principal and an
    // owner. A tab strip with one tab is a decoration that implies a choice.
    if (this.kinds.length > 1) {
      root.append(tabs(d, {
        label: 'কী আমদানি করবেন',
        items: this.kinds.map((k) => ({ id: k, label: KIND_BN[k] })),
        active: this.kind,
        onSelect: (id) => {
          if (id === this.kind) return;
          this.kind = id as ImportKind;
          this.reset();
          if (this.kind === 'student' && !this.yearId && this.yearState === 'idle') void this.loadYear();
        },
      }));
    }

    root.append(this.stepper());

    if (this.error) {
      root.append(errorState(d, this.error));
    }

    // The student import needs a year to exist. Say which thing is missing
    // and where to make it, rather than letting the file be read first and
    // rejected afterwards.
    if (this.kind === 'student') {
      if (this.yearState === 'loading') { root.append(skeleton(d, 2)); return; }
      if (this.yearState === 'none') {
        root.append(emptyState(d, {
          message: 'এই প্রতিষ্ঠানে এখনো কোনো শিক্ষাবর্ষ তৈরি হয়নি। শিক্ষার্থী কোন বছরে ভর্তি হবে ' +
                   'তা ঠিক না থাকলে আমদানি করা যায় না।',
          action: {
            label: 'একাডেমিক কাঠামোতে যান',
            onClick: () => { this.o.doc.defaultView!.location.hash = '#/academic'; },
          },
        }));
        return;
      }
      if (this.yearState === 'failed') {
        root.append(errorState(d, 'শিক্ষাবর্ষ জানা যায়নি।', () => void this.loadYear()));
        return;
      }
    }

    if (this.step === 1 || this.step === 2) root.append(this.filePicker());
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
    const columnsBn = this.kind === 'student'
      ? 'রোল, নাম, শ্রেণি, শাখা, মোবাইল, চতুর্থ বিষয় (নবম শ্রেণি থেকে আবশ্যক)।'
      : 'নাম, আইডি, মোবাইল, পদবি, ভূমিকা, যোগদানের তারিখ।';

    const body: Array<Node | null> = [
      el(d, 'p', { className: 'ui-card-note', text: `কলাম: ${columnsBn}` }),
      // §10.2: "the file never contains a subject column". Saying so up front
      // saves an operator building one.
      this.kind === 'student'
        ? el(d, 'p', {
            className: 'ui-card-note',
            text: 'বিষয়ের তালিকা ফাইলে দিতে হবে না — আমদানির পর টেমপ্লেট থেকে ' +
                  'স্বয়ংক্রিয়ভাবে নির্ধারিত হবে।',
          })
        : el(d, 'p', {
            className: 'ui-card-note',
            text: 'ভূমিকা খালি থাকলে বিষয় শিক্ষক ধরা হবে। কেউ লগইন করতে পারবেন না ' +
                  'যতক্ষণ না তাঁকে সক্রিয়ন কোড দেওয়া হয়।',
          }),
      fileUpload(d, {
        label: 'CSV ফাইল বেছে নিন',
        name: 'csv',
        accept: '.csv,text/csv',
        // Rejected here as well as at the server, so a 1 MB file does not
        // travel over 2G to be refused.
        maxBytes: 1_000_000,
        helper: this.fileName ? `আগে বেছে নেওয়া: ${this.fileName}` : 'সর্বোচ্চ ১ মেগাবাইট।',
        onFiles: (files) => { if (files[0]) this.accept(files[0]); },
      }).root,
    ];

    if (this.step === 2 || this.busy) {
      body.push(el(d, 'p', {
        className: 'ui-card-note', text: 'যাচাই করা হচ্ছে…',
        attrs: { role: 'status' },
      }));
    }

    return card(d, {
      title: 'ফাইল', glyph: 'upload', className: 'import-card',
    }, ...body);
  }

  private reviewCard(): HTMLElement {
    const d = this.o.doc;
    const r = this.result as DryRun;
    const shown = r.errors.slice(0, ERRORS_SHOWN);

    const parts: Array<Node | null> = [
      // The three numbers as figures, not a paragraph. A partial import is a
      // decision, and a decision is made from a comparison.
      statRow(d,
        statCard(d, { label: 'পড়া হয়েছে', value: `${bn(r.rowsRead)}টি সারি`, glyph: 'book-open' }),
        statCard(d, {
          label: 'আমদানির উপযুক্ত', value: `${bn(r.rowsValid)}টি`, glyph: 'check-square',
          tone: r.rowsValid > 0 ? 'success' : 'warn',
        }),
        statCard(d, {
          label: 'বাদ পড়বে', value: `${bn(r.rowsRejected)}টি`, glyph: 'alert-triangle',
          tone: r.rowsRejected > 0 ? 'warn' : 'success',
          note: r.rowsRejected > 0 ? 'নিচের কারণগুলো দেখুন' : 'কোনো সারিতে সমস্যা নেই',
        }),
      ),
    ];

    if (r.rowsRejected > 0) {
      parts.push(dataTable(d, {
        caption: 'যে সারিগুলো বাদ পড়বে',
        rows: shown,
        rowKey: (e) => `${e.lineNo}-${e.field}`,
        columns: [
          { key: 'line', header: 'সারি', mobile: 'title', numeric: true,
            cell: (e) => `সারি ${bn(e.lineNo)}`, width: '110px' },
          { key: 'who', header: 'রোল / আইডি', mobile: 'meta',
            cell: (e) => e.rollNo || '—', width: '130px' },
          { key: 'why', header: 'কারণ', mobile: 'subtitle', cell: (e) => e.messageBn,
            width: 'minmax(0, 3fr)' },
        ],
      }));
      if (r.errors.length > ERRORS_SHOWN) {
        // Never "···" alone: the count is what tells the operator whether to
        // keep scrolling or to go and fix the spreadsheet.
        parts.push(el(d, 'p', {
          className: 'ui-card-note',
          text: `আরও ${bn(r.errors.length - ERRORS_SHOWN)}টি সারিতে সমস্যা আছে — ` +
                'সম্পূর্ণ তালিকা নামিয়ে নিন।',
        }));
      }
      parts.push(buttonRow(d,
        button(d, {
          label: 'সমস্যার তালিকা নামান', variant: 'secondary', glyph: 'book',
          disabled: !r.errorCsv,
          onClick: () => { this.downloadErrors(); },
        }),
        button(d, {
          label: 'ঠিক করে আবার আপলোড', variant: 'ghost',
          onClick: () => { this.reset(); },
        }),
      ));
    }

    const host = card(d, {
      title: 'পূর্বরূপ', glyph: 'search', className: 'import-card',
      subtitle: 'এখনো কিছু লেখা হয়নি।',
    }, ...parts);

    if (r.rowsValid === 0) {
      append(host, el(d, 'p', {
        className: 'ui-card-note',
        text: 'কোনো সারি আমদানির উপযুক্ত নয়। ফাইলটি ঠিক করে আবার চেষ্টা করুন।',
      }));
      return host;
    }

    // §10.2's exact phrasing. Both numbers on the button itself, so the
    // skipped students cannot be pressed past without being read.
    const label = r.rowsRejected > 0
      ? `${bn(r.rowsValid)}টি ঠিক সারি আমদানি করুন, ${bn(r.rowsRejected)}টি বাদ`
      : `${bn(r.rowsValid)}টি সারি আমদানি করুন`;

    append(host, buttonRow(d, button(d, {
      label, variant: 'primary', busy: this.busy, className: 'import-go',
      onClick: () => {
        // This is the write, and it is the first one. Confirmed because the
        // count on the button is a number a person can read past — the
        // dialog restates what is being LEFT OUT, which is the part §10.2
        // says must never be silent.
        host.append(confirmDialog({
          doc: d,
          title: 'আমদানি নিশ্চিত করুন',
          body: r.rowsRejected > 0
            ? `${bn(r.rowsValid)}টি ${KIND_BN[this.kind]} যোগ হবে। ` +
              `${bn(r.rowsRejected)}টি সারি বাদ যাবে — সেগুলো যোগ হবে না।`
            : `${bn(r.rowsValid)}টি ${KIND_BN[this.kind]} যোগ হবে।`,
          confirmLabel: 'আমদানি করুন',
          onConfirm: () => void this.send(true),
        }));
      },
    })));
    return host;
  }

  private doneCard(): HTMLElement {
    const d = this.o.doc;
    const r = this.result as DryRun;

    const parts: Array<Node | null> = [
      el(d, 'p', {
        className: 'ui-card-lead',
        text: `${bn(r.rowsImported)}টি ${KIND_BN[this.kind]} আমদানি হয়েছে`,
        attrs: { role: 'status' },
      }),
    ];

    if (r.rowsRejected > 0) {
      // Stated after the fact as well as before it. "No silent truncation"
      // means the skipped rows are still on screen once the work is done.
      parts.push(el(d, 'div', { className: 'ui-row-actions' },
        statusBadge(d, { state: 'pending', label: `${bn(r.rowsRejected)}টি সারি বাদ দেওয়া হয়েছে` })));
      if (r.errorCsv) {
        parts.push(button(d, {
          label: 'বাদ পড়া সারির তালিকা', variant: 'secondary', glyph: 'book',
          onClick: () => { this.downloadErrors(); },
        }));
      }
    }

    parts.push(el(d, 'p', {
      className: 'ui-card-note',
      text: this.kind === 'student'
        ? 'প্রতিটি শিক্ষার্থীর বিষয় তালিকা টেমপ্লেট থেকে নির্ধারিত হয়েছে।'
        : 'নতুন কেউ এখনো লগইন করতে পারবেন না — ব্যবহারকারী পাতা থেকে সক্রিয়ন কোড দিন।',
    }));

    parts.push(buttonRow(d, button(d, {
      label: 'আরেকটি ফাইল আমদানি করুন', variant: 'secondary',
      onClick: () => { this.reset(); },
    })));

    return card(d, {
      title: 'আমদানি সম্পন্ন', glyph: 'check-square', tone: 'success',
      className: 'import-card',
    }, ...parts);
  }
}
