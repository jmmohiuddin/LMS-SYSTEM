/**
 * ফি নির্ধারণ — the price list.  (P0/A2)
 *
 * What each fee head costs, this academic year, optionally per class. The
 * monthly invoice run reads exactly this table, and it had no writer at all:
 * `fee_structures` held zero rows across 126 institutions, so
 * `POST /finance/generate` billed nothing, for every school, every month.
 *
 * ── The screen tells the truth about what gets billed ───────────────────
 * The invoice run joins `fh.frequency = 'monthly' AND fh.is_active`. A price
 * set against an annual, exam or one-time head is stored and never invoiced by
 * it. Rather than hide that, every row carries a badge saying whether the
 * monthly run will pick it up — a fee somebody configured and never saw on an
 * invoice is the kind of silence this product has been bitten by before.
 *
 * ── No quota field ──────────────────────────────────────────────────────
 * The engine joins `fs.quota_category IS NULL`, so a quota-scoped price is
 * ignored entirely. Offering the field would be a control whose value is
 * discarded, which is the exact defect this phase exists to close.
 *
 * ── School-wide and per-class ───────────────────────────────────────────
 * A price with no class is the school-wide default; a class price overrides it
 * (`ORDER BY … class_id NULLS LAST` in the run). Both are shown, grouped by
 * head, so the override is visible rather than inferred.
 */
import type { Auth } from './auth.ts';
import { formatBdt } from '../../../packages/ui-core/src/format.ts';
import { skeleton, errorState, emptyState, successNote, bnNum } from './view-states.ts';
import { pageHeader } from './ui/page-header.ts';
import {
  el, append, button, buttonRow, field, dataTable, statusBadge,
  permissionState, permissionMessage, openDrawer, confirmOverlay,
  statCard, statRow, setBusy, announce, type OverlayHandle,
} from './ui/index.ts';

interface Structure {
  id: string;
  feeHeadId: string;
  headBn: string;
  headCode: string;
  frequency: string;
  headActive: boolean;
  classId: string | null;
  classBn: string | null;
  amount: number;
  lateFeePerDay: number | null;
  lateFeeCap: number | null;
  dueDayOfMonth: number | null;
  billedByMonthlyRun: boolean;
}

interface Body {
  canManage: boolean;
  academicYearId: string | null;
  years: Array<{ id: string; label: string; isCurrent: boolean }>;
  classes: Array<{ id: string; nameBn: string }>;
  heads: Array<{ id: string; nameBn: string; code: string; frequency: string; isActive: boolean }>;
  structures: Structure[];
}

export interface FeeStructuresViewOptions {
  root: HTMLElement;
  doc: Document;
  auth: Auth;
}

/** The six frequencies `fee_heads_frequency_check` allows. */
const FREQUENCY_BN: Record<string, string> = {
  one_time: 'এককালীন',
  monthly: 'মাসিক',
  quarterly: 'ত্রৈমাসিক',
  half_yearly: 'ষাণ্মাসিক',
  annual: 'বার্ষিক',
  exam: 'পরীক্ষাভিত্তিক',
};
const freqLabel = (f: string) => FREQUENCY_BN[f] ?? f;

export class FeeStructuresView {
  private data: Body | null = null;
  private loading = true;
  private denied = false;
  /** The whole service is off for this school's plan — a different refusal. */
  private planBlocked = '';
  private error = '';
  private notice = '';
  private busy = false;
  private yearId = '';
  private search = '';

  // Declared and assigned rather than a `private readonly o` parameter
  // property: Node's type-stripping test runner rejects those outright, so a
  // view written that way cannot be imported by a test at all. Both P0
  // writers were, which is why neither had one.
  private readonly o: FeeStructuresViewOptions;

  constructor(options: FeeStructuresViewOptions) {
    this.o = options;
    this.render();
    void this.load();
  }

  private async load(): Promise<void> {
    this.loading = true;
    this.error = '';
    this.render();
    try {
      const q = this.yearId ? `?yearId=${encodeURIComponent(this.yearId)}` : '';
      const res = await this.o.auth.authedFetch(`/api/v1/finance/feestructures${q}`);
      if (res.status === 403) {
        // Two different 403s. The entitlement gate returns `tenant_blocked`
        // with a Bangla reason from the database; a role refusal does not.
        // Telling them apart matters: one is "ask your principal", the other
        // is "your school has not bought this".
        const body = await res.json().catch(() => ({})) as { error?: string; message?: string };
        if (body.error === 'tenant_blocked') this.planBlocked = body.message ?? '';
        else this.denied = true;
        return;
      }
      if (!res.ok) throw new Error(String(res.status));
      this.data = await res.json() as Body;
      this.yearId = this.data.academicYearId ?? '';
    } catch {
      this.error = 'ফি-এর তালিকা আনা যায়নি।';
    } finally {
      this.loading = false;
      this.render();
    }
  }

  /**
   * Returns '' when the write was accepted, otherwise the sentence to show.
   *
   * It deliberately does NOT set `this.error` on a refusal. It used to, and
   * the `finally` below then called `load()`, whose first statement is
   * `this.error = ''` — so every refusal erased its own message and the
   * screen went back to looking exactly as it had. Handing the message to
   * the caller puts it where the person is looking: a rejected form keeps it
   * inside the drawer, a rejected delete raises it on the page.
   */
  private async send(
    method: 'POST' | 'PATCH' | 'DELETE', payload: Record<string, unknown>, ok: string,
  ): Promise<string> {
    this.busy = true;
    this.notice = '';
    try {
      const url = method === 'DELETE'
        ? `/api/v1/finance/feestructures?id=${encodeURIComponent(String(payload.id))}`
        : '/api/v1/finance/feestructures';
      const res = await this.o.auth.authedFetch(url, {
        method,
        ...(method === 'DELETE' ? {} : {
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        }),
      });
      const out = await res.json().catch(() => ({})) as { message?: string; headBn?: string };
      if (!res.ok) {
        // The server's Bangla message names what it objected to — a duplicate,
        // a due day past 28. Showing it verbatim beats a generic failure the
        // office cannot act on.
        return out.message ?? 'ফি সংরক্ষণ করা যায়নি।';
      }
      this.notice = `${out.headBn ?? 'ফি'} — ${ok}`;
      return '';
    } catch {
      return 'ফি সংরক্ষণ করা যায়নি।';
    } finally {
      this.busy = false;
      await this.load();
    }
  }

  private visible(): Structure[] {
    const rows = this.data?.structures ?? [];
    const q = this.search.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) =>
      r.headBn.toLowerCase().includes(q)
      || r.headCode.toLowerCase().includes(q)
      || (r.classBn ?? '').toLowerCase().includes(q));
  }

  private render(): void {
    const d = this.o.doc;
    const root = this.o.root;
    root.textContent = '';

    root.append(pageHeader(d, {
      title: 'ফি নির্ধারণ',
      subtitle: 'কোন ফি কত — মাসিক বিল এই তালিকা থেকেই তৈরি হয়',
    }));

    if (this.planBlocked) {
      // Not a permission problem, and saying "ask your principal" would send
      // the office somewhere that cannot help.
      root.append(emptyState(d, { message: this.planBlocked }));
      return;
    }
    if (this.denied) {
      root.append(permissionState(d, {
        message: permissionMessage('ফি নির্ধারণ'),
        contact: 'প্রধান শিক্ষক, প্রতিষ্ঠান মালিক, হিসাবরক্ষক ও আইটি অ্যাডমিন',
      }));
      return;
    }

    if (this.notice) root.append(successNote(d, this.notice));
    if (this.error) root.append(errorState(d, this.error, () => void this.load()));

    if (this.loading) { root.append(skeleton(d, 5)); return; }
    const data = this.data;
    if (!data) return;

    if (!data.academicYearId) {
      root.append(emptyState(d, {
        message: 'আগে একটি শিক্ষাবর্ষ তৈরি করুন — ফি সবসময় একটি শিক্ষাবর্ষের জন্য নির্ধারিত হয়।',
      }));
      return;
    }

    root.append(this.controls(data));
    root.append(this.summary(data));

    const rows = this.visible();
    if (rows.length === 0) {
      root.append(emptyState(d, {
        message: this.search
          ? 'এই নামে কোনো ফি পাওয়া যায়নি।'
          : 'এই শিক্ষাবর্ষে এখনো কোনো ফি নির্ধারণ করা হয়নি। ফি না থাকলে মাসিক বিল তৈরি হবে না।',
        action: data.canManage && !this.search
          ? { label: 'প্রথম ফি নির্ধারণ করুন', onClick: () => this.openForm(null) }
          : undefined,
      }));
      return;
    }

    root.append(dataTable(d, {
      caption: 'নির্ধারিত ফি-এর তালিকা',
      rows,
      rowKey: (r) => r.id,
      columns: [
        {
          key: 'head', header: 'ফি', mobile: 'title',
          cell: (r) => r.headBn,
          width: 'minmax(0, 2fr)',
        },
        {
          key: 'scope', header: 'কার জন্য', mobile: 'subtitle',
          // A NULL class is the school-wide default. Saying "whole school"
          // beats an empty cell the office has to interpret.
          cell: (r) => r.classBn ?? 'পুরো প্রতিষ্ঠান',
        },
        {
          key: 'amount', header: 'টাকা', mobile: 'meta', numeric: true,
          cell: (r) => formatBdt(r.amount),
        },
        {
          key: 'due', header: 'শেষ তারিখ', mobile: 'meta',
          cell: (r) => (r.dueDayOfMonth === null
            ? 'নির্ধারিত নয়'
            : `প্রতি মাসের ${bnNum(r.dueDayOfMonth)} তারিখ`),
        },
        {
          key: 'billed', header: 'মাসিক বিলে', mobile: 'status',
          cell: (r) => statusBadge(d, {
            state: r.billedByMonthlyRun ? 'published' : 'pending',
            label: r.billedByMonthlyRun ? 'বিলে আসবে' : freqLabel(r.frequency),
          }),
        },
        ...(data.canManage ? [{
          key: 'actions', header: 'ব্যবস্থা',
          cell: (r: Structure) => this.rowActions(r),
        }] : []),
      ],
    }));

    // The honest footnote, shown only when it applies to something on screen.
    if (rows.some((r) => !r.billedByMonthlyRun)) {
      root.append(el(d, 'p', {
        className: 'att-sub',
        text: 'যেসব ফি মাসিক নয়, সেগুলো মাসিক বিল তৈরির সময় যুক্ত হবে না — সেগুলো আলাদাভাবে আদায় করতে হবে।',
      }));
    }
  }

  private controls(data: Body): HTMLElement {
    const d = this.o.doc;
    const wrap = el(d, 'div', { className: 'ui-fieldset' });

    const year = field(d, {
      label: 'শিক্ষাবর্ষ', name: 'year', kind: 'select',
      value: this.yearId,
      options: data.years.map((y) => ({
        value: y.id, label: y.isCurrent ? `${y.label} (চলতি)` : y.label,
      })),
      onChange: (v) => { this.yearId = v; void this.load(); },
    });
    const search = field(d, {
      label: 'খুঁজুন', name: 'q', kind: 'search', value: this.search,
      placeholder: 'ফি বা শ্রেণির নাম',
      onInput: (v) => { this.search = v; this.render(); },
    });
    append(wrap, year.root, search.root);

    if (data.canManage) {
      append(wrap, buttonRow(d, button(d, {
        label: 'নতুন ফি নির্ধারণ', variant: 'primary', disabled: this.busy,
        onClick: () => this.openForm(null),
      })));
    }
    return wrap;
  }

  private summary(data: Body): HTMLElement {
    const d = this.o.doc;
    const billed = data.structures.filter((r) => r.billedByMonthlyRun);
    // The monthly total for a school-wide student: the class-specific rows
    // override, so this is deliberately labelled as the school-wide baseline
    // rather than "what every child pays", which would be a guess.
    const wide = billed.filter((r) => r.classId === null)
      .reduce((sum, r) => sum + r.amount, 0);
    return statRow(d,
      statCard(d, {
        label: 'নির্ধারিত ফি', value: bnNum(data.structures.length), glyph: 'wallet',
      }),
      statCard(d, {
        label: 'মাসিক বিলে আসবে', value: bnNum(billed.length), glyph: 'check-square',
        note: billed.length === 0 ? 'কোনোটিই নয় — বিল খালি আসবে' : undefined,
        tone: billed.length === 0 ? 'warn' : 'primary',
      }),
      statCard(d, {
        label: 'পুরো প্রতিষ্ঠানের মাসিক', value: formatBdt(wide), glyph: 'percent',
        note: 'শ্রেণিভিত্তিক ফি আলাদা',
      }));
  }

  private rowActions(r: Structure): HTMLElement {
    const d = this.o.doc;
    return buttonRow(d,
      button(d, {
        label: 'সম্পাদনা', size: 'sm', disabled: this.busy,
        onClick: () => this.openForm(r),
      }),
      button(d, {
        label: 'সরান', size: 'sm', variant: 'danger', disabled: this.busy,
        onClick: () => this.confirmRemove(r),
      }));
  }

  private confirmRemove(r: Structure): void {
    confirmOverlay(this.o.doc, {
      title: `${r.headBn} সরাবেন?`,
      // The question an accountant will actually ask, answered before they
      // have to ask it. invoice_lines stores its own amounts and does not
      // reference fee_structures, so an issued invoice cannot be changed here.
      body: `${r.classBn ?? 'পুরো প্রতিষ্ঠান'} — ${formatBdt(r.amount)}। `
        + 'এটি সরালে পরের মাস থেকে আর বিলে আসবে না। ইতিমধ্যে তৈরি হওয়া বিল ও রসিদ অপরিবর্তিত থাকবে।',
      confirmLabel: 'সরান',
      danger: true,
      onConfirm: async () => {
        // No drawer survives a delete, so a refusal belongs on the page.
        // Set after `send` resolves: its own `load()` would have cleared it.
        const msg = await this.send('DELETE', { id: r.id }, 'সরানো হয়েছে।');
        if (msg) { this.error = msg; this.render(); }
      },
    });
  }

  private openForm(existing: Structure | null): void {
    const d = this.o.doc;
    const data = this.data;
    if (!data) return;

    const form = el(d, 'div', { className: 'ui-fieldset' });

    // Editing never re-points a price at a different head or class: that is a
    // different fee, and the unique scope would collide with the real one.
    const headField = existing
      ? null
      : field(d, {
        label: 'কোন ফি', name: 'feeHeadId', kind: 'select', required: true,
        options: data.heads.filter((h) => h.isActive).map((h) => ({
          value: h.id, label: `${h.nameBn} — ${freqLabel(h.frequency)}`,
        })),
        helper: 'কেবল মাসিক ফি স্বয়ংক্রিয়ভাবে মাসিক বিলে যুক্ত হয়।',
      });

    const classField = existing
      ? null
      : field(d, {
        label: 'কার জন্য', name: 'classId', kind: 'select',
        options: [
          { value: '', label: 'পুরো প্রতিষ্ঠান' },
          ...data.classes.map((c) => ({ value: c.id, label: c.nameBn })),
        ],
        helper: 'শ্রেণির জন্য আলাদা ফি দিলে সেটিই প্রাধান্য পাবে।',
      });

    const amount = field(d, {
      label: 'টাকার অঙ্ক', name: 'amount', kind: 'number', required: true,
      value: existing ? String(existing.amount) : '',
      attrs: { min: 0, step: 1 },
    });
    const dueDay = field(d, {
      label: 'প্রতি মাসের কত তারিখে শেষ', name: 'dueDayOfMonth', kind: 'number',
      value: existing?.dueDayOfMonth === null || existing?.dueDayOfMonth === undefined
        ? '' : String(existing.dueDayOfMonth),
      helper: 'ঐচ্ছিক — ১ থেকে ২৮ (ফেব্রুয়ারির কারণে ২৮-এর বেশি নয়)।',
      attrs: { min: 1, max: 28, step: 1 },
    });
    const lateFee = field(d, {
      label: 'দৈনিক বিলম্ব ফি', name: 'lateFeePerDay', kind: 'number',
      value: String(existing?.lateFeePerDay ?? 0),
      helper: 'ঐচ্ছিক — শূন্য মানে বিলম্ব ফি নেই।',
      attrs: { min: 0, step: 1 },
    });
    const lateCap = field(d, {
      label: 'বিলম্ব ফির সর্বোচ্চ সীমা', name: 'lateFeeCap', kind: 'number',
      value: existing?.lateFeeCap === null || existing?.lateFeeCap === undefined
        ? '' : String(existing.lateFeeCap),
      helper: 'ঐচ্ছিক।',
      attrs: { min: 0, step: 1 },
    });

    // A refusal is shown here, beside the values that caused it, and the
    // drawer stays open so they do not have to be retyped.
    const errLine = el(d, 'p', {
      className: 'ui-field-error',
      attrs: { role: 'alert', hidden: 'hidden' },
    });
    append(form, errLine);

    for (const f of [headField, classField, amount, dueDay, lateFee, lateCap]) {
      if (f) append(form, f.root);
    }

    let handle: OverlayHandle;
    const cancel = button(d, { label: 'বাতিল', variant: 'secondary', onClick: () => handle.close() });
    const save = button(d, {
      label: existing ? 'সংরক্ষণ করুন' : 'নির্ধারণ করুন',
      variant: 'primary',
      onClick: async () => {
        const num = (v: string) => (v.trim() === '' ? null : Number(v));
        const payload: Record<string, unknown> = {
          amount: Number(amount.input.value),
          dueDayOfMonth: num(dueDay.input.value),
          lateFeePerDay: num(lateFee.input.value) ?? 0,
          lateFeeCap: num(lateCap.input.value),
        };
        if (existing) {
          payload.id = existing.id;
        } else {
          payload.feeHeadId = headField?.input.value ?? '';
          payload.academicYearId = this.yearId;
          const cls = classField?.input.value ?? '';
          payload.classId = cls === '' ? null : cls;
        }

        errLine.setAttribute('hidden', 'hidden');
        setBusy(save, true);
        // The drawer closes only once the server has accepted it. It used to
        // close here, before the request was even sent, so a refusal looked
        // exactly like a save.
        const msg = await this.send(existing ? 'PATCH' : 'POST', payload,
          existing ? 'সংরক্ষণ করা হয়েছে।' : 'নির্ধারণ করা হয়েছে।');
        setBusy(save, false);
        if (!msg) { handle.close(); return; }
        errLine.textContent = msg;
        errLine.removeAttribute('hidden');
        // Announced as well as shown: focus is on the button just pressed, and
        // a message that only appears is one a screen-reader user never gets.
        announce(d, msg, true);
      },
    });
    handle = openDrawer(d, {
      title: existing ? `${existing.headBn} সম্পাদনা` : 'নতুন ফি নির্ধারণ',
      body: form,
      actions: [cancel, save],
    });
  }
}
