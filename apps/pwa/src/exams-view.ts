/**
 * পরীক্ষা ব্যবস্থাপনা — the exam register.  (P0/A1)
 *
 * `exams` had a complete writer and no screen. `POST /api/v1/academics/exams`
 * has existed since migration 066 and nothing in the product had ever called
 * it: the only PWA readers of that URL are `marks-view` and `scripts-view`,
 * both GET with `?sectionId=`, and `exam-routine-view` posts to
 * `/api/v1/rms/examroutine`, which SCHEDULES an exam that already exists. So a
 * school could take attendance and could not examine anybody — and everything
 * below the exam (marks → grade → GPA → rank → publish → progress report →
 * admit card) was built, tested and unreachable.
 *
 * ── An exam is created WITH its papers ──────────────────────────────────
 * The server writes `exams` and `exam_subjects` in one transaction, one paper
 * per (section × subject the class teaches), maxima copied from
 * `class_subjects` and frozen. That is why this form asks for SECTIONS and not
 * for subjects: the subjects follow from the sections, and an exam with no
 * papers is invisible everywhere (the marks feed INNER JOINs `exam_subjects`).
 * If the chosen classes have no subjects configured the server refuses with
 * 409 `no_class_subjects` — a setup gap, not a form error, so its sentence is
 * shown as-is and points at subject setup.
 *
 * ── What this screen deliberately does NOT do ───────────────────────────
 * No delete: `exams_delete_scope ... USING (false)` refuses every role, because
 * a delete cascades through eight tables including `exam_marks`,
 * `exam_results` and `mark_corrections` — the record behind every certificate
 * the school has issued. A delete button would fail silently (`DELETE 0`).
 *
 * No status control: `exam_status` is an enum of six values and no endpoint
 * accepts one from a client. Status moves only as a side effect of two
 * purpose-built actions that live on their own screens — results publication
 * (`publish-view`) and routine publication (`exam-routine-view`). This screen
 * renders status and never sets it.
 *
 * No year/term/section editing after creation: PATCH writes seven columns and
 * ignores those three. A control that appears to work and silently does
 * nothing is worse than no control.
 */
import type { Auth } from './auth.ts';
import { skeleton, errorState, emptyState, successNote, bnNum } from './view-states.ts';
import { pageHeader } from './ui/page-header.ts';
import {
  el, append, button, buttonRow, field, dataTable, statusBadge,
  permissionState, permissionMessage, openDrawer,
  statCard, statRow, setBusy, announce, type OverlayHandle,
} from './ui/index.ts';

interface Exam {
  id: string;
  nameBn: string;
  nameEn: string;
  examType: string;
  status: string;
  startsOn: string | null;
  endsOn: string | null;
  weightPercent: number;
  isGpaBearing: boolean;
  paperCount: number;
  sectionCount: number;
  markCount: number;
}

interface Body {
  canManage: boolean;
  examTypes: string[];
  exams: Exam[];
}

/** From GET /api/v1/academics/hierarchy — years, and sections under classes. */
interface Section { id: string; name: string; studentCount: number }
interface Group { classId: string; group: string; groupBn: string; sections: Section[] }
interface Level { levelNo: number; nameBn: string; groups: Group[] }
interface Tree {
  years: { id: string; label: string; isCurrent: boolean }[];
  year: { id: string; label: string; isCurrent: boolean } | null;
  classes: Level[];
}

export interface ExamsViewOptions {
  root: HTMLElement;
  doc: Document;
  auth: Auth;
}

/** `exams_exam_type_check`, migration 005. Labels only — the SET comes from the server. */
const TYPE_BN: Record<string, string> = {
  class_test: 'শ্রেণি পরীক্ষা',
  monthly: 'মাসিক পরীক্ষা',
  half_yearly: 'অর্ধবার্ষিক',
  pre_test: 'প্রি-টেস্ট',
  test: 'টেস্ট',
  annual: 'বার্ষিক পরীক্ষা',
  model: 'মডেল টেস্ট',
  board: 'বোর্ড পরীক্ষা',
};
const typeLabel = (t: string) => TYPE_BN[t] ?? t;

/**
 * All six values of the `exam_status` enum. Four of them are never written by
 * any production code today, but the server can return any of them (a fixture,
 * an import, a future endpoint) and a row with no label would render blank.
 */
const STATUS_BN: Record<string, { label: string; state: string }> = {
  planned:    { label: 'পরিকল্পিত',            state: 'draft' },
  ongoing:    { label: 'চলছে',                 state: 'active' },
  marking:    { label: 'নম্বর দেওয়া হচ্ছে',      state: 'partial' },
  moderation: { label: 'যাচাই চলছে',            state: 'partial' },
  published:  { label: 'ফলাফল প্রকাশিত',        state: 'published' },
  locked:     { label: 'চূড়ান্ত',               state: 'published' },
};
const statusOf = (s: string) => STATUS_BN[s] ?? { label: s, state: 'pending' };

/** Editing is refused by the server once results are out. */
const isFinal = (e: Exam) => e.status === 'published' || e.status === 'locked';

/** "2026-12-10" + "2026-12-20" → "১০–২০ ডিসেম্বর". Dhaka days, compared as strings. */
const MONTH_BN = ['জানুয়ারি', 'ফেব্রুয়ারি', 'মার্চ', 'এপ্রিল', 'মে', 'জুন',
  'জুলাই', 'আগস্ট', 'সেপ্টেম্বর', 'অক্টোবর', 'নভেম্বর', 'ডিসেম্বর'];

function dateRange(from: string | null, to: string | null): string {
  if (!from && !to) return 'তারিখ নির্ধারিত নয়';
  const part = (iso: string) => {
    const [, m, d] = iso.split('-');
    return { day: bnNum(Number(d)), month: MONTH_BN[Number(m) - 1] ?? m };
  };
  if (from && to) {
    const a = part(from);
    const b = part(to);
    return a.month === b.month
      ? `${a.day}–${b.day} ${a.month}`
      : `${a.day} ${a.month} – ${b.day} ${b.month}`;
  }
  const one = part((from ?? to) as string);
  return `${one.day} ${one.month}`;
}

export class ExamsView {
  private data: Body | null = null;
  private tree: Tree | null = null;
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
  // view written that way cannot be imported by a test at all (B-62).
  private readonly o: ExamsViewOptions;

  constructor(options: ExamsViewOptions) {
    this.o = options;
    this.render();
    void this.load();
  }

  private async load(): Promise<void> {
    this.loading = true;
    this.error = '';
    this.render();
    try {
      // The hierarchy carries the year list and the sections the create form
      // needs; the exam list carries canManage and the server's own exam-type
      // set.
      //
      // They are only parallel once a year is known. `/academics/exams` with
      // NO query is the marks feed and answers 400 `invalid_section_id` — it
      // does not default to the current year the way the fee endpoint does —
      // so the first load has to learn the year from the hierarchy before it
      // can ask for that year's exams.
      const treeRes = await this.o.auth.authedFetch(
        `/api/v1/academics/hierarchy${this.yearId ? `?yearId=${encodeURIComponent(this.yearId)}` : ''}`);
      if (treeRes.ok) {
        const t = await treeRes.clone().json() as Tree;
        if (t.year) this.yearId = t.year.id;
      }
      const examRes = await this.o.auth.authedFetch(
        `/api/v1/academics/exams?yearId=${encodeURIComponent(this.yearId)}`);

      for (const res of [treeRes, examRes]) {
        if (res.status === 403) {
          // Two different 403s. The entitlement gate returns `tenant_blocked`
          // with a Bangla reason from the database; a role refusal does not.
          // Telling them apart matters: one is "ask your principal", the other
          // is "your school has not bought this".
          const b = await res.json().catch(() => ({})) as { error?: string; message?: string };
          if (b.error === 'tenant_blocked') this.planBlocked = b.message ?? '';
          else this.denied = true;
          return;
        }
      }
      if (!treeRes.ok || !examRes.ok) throw new Error(String(examRes.status));

      this.tree = await treeRes.json() as Tree;
      this.data = await examRes.json() as Body;
      this.yearId = this.tree.year?.id ?? '';
    } catch {
      this.error = 'পরীক্ষার তালিকা আনা যায়নি।';
    } finally {
      this.loading = false;
      this.render();
    }
  }

  /**
   * Returns '' when the write was accepted, otherwise the sentence to show.
   *
   * It deliberately does NOT set `this.error` on a refusal: the `finally`
   * below calls `load()`, whose first statement is `this.error = ''`, so a
   * refusal would erase its own message and the screen would go back to
   * looking exactly as it had. That is B-60, and this is the shape both other
   * writers were corrected to.
   */
  private async send(
    method: 'POST' | 'PATCH', payload: Record<string, unknown>, ok: string,
  ): Promise<string> {
    this.busy = true;
    this.notice = '';
    try {
      const res = await this.o.auth.authedFetch('/api/v1/academics/exams', {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const out = await res.json().catch(() => ({})) as { message?: string; nameBn?: string };
      if (!res.ok) {
        // The server's Bangla message names what it objected to — a duplicate
        // name, a date outside the year, a class with no subjects configured.
        return out.message ?? 'পরীক্ষা সংরক্ষণ করা যায়নি।';
      }
      this.notice = `${out.nameBn ?? 'পরীক্ষা'} — ${ok}`;
      return '';
    } catch {
      return 'পরীক্ষা সংরক্ষণ করা যায়নি।';
    } finally {
      this.busy = false;
      await this.load();
    }
  }

  private visible(): Exam[] {
    const rows = this.data?.exams ?? [];
    const q = this.search.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((e) =>
      e.nameBn.toLowerCase().includes(q)
      || e.nameEn.toLowerCase().includes(q)
      || typeLabel(e.examType).toLowerCase().includes(q));
  }

  private render(): void {
    const d = this.o.doc;
    const root = this.o.root;
    root.textContent = '';

    root.append(pageHeader(d, {
      title: 'পরীক্ষা ব্যবস্থাপনা',
      subtitle: 'পরীক্ষা তৈরি করুন — নম্বর, ফলাফল ও পরীক্ষার রুটিন সবই এখান থেকে শুরু হয়',
    }));

    if (this.planBlocked) {
      root.append(emptyState(d, { message: this.planBlocked }));
      return;
    }
    if (this.denied) {
      root.append(permissionState(d, {
        message: permissionMessage('পরীক্ষা'),
        contact: 'প্রধান শিক্ষক, প্রতিষ্ঠান মালিক, একাডেমিক সমন্বয়কারী ও বিভাগীয় প্রধান',
      }));
      return;
    }

    if (this.notice) root.append(successNote(d, this.notice));
    if (this.error) root.append(errorState(d, this.error, () => void this.load()));

    if (this.loading) { root.append(skeleton(d, 5)); return; }
    const data = this.data;
    const tree = this.tree;
    if (!data || !tree) return;

    if (!tree.year) {
      root.append(emptyState(d, {
        message: 'আগে একটি শিক্ষাবর্ষ তৈরি করুন — পরীক্ষা সবসময় একটি শিক্ষাবর্ষের ভেতরে হয়।',
      }));
      return;
    }

    root.append(this.controls(data, tree));
    root.append(this.summary(data));

    const rows = this.visible();
    if (rows.length === 0) {
      root.append(emptyState(d, {
        message: this.search
          ? 'এই নামে কোনো পরীক্ষা পাওয়া যায়নি।'
          : 'এই শিক্ষাবর্ষে এখনো কোনো পরীক্ষা তৈরি করা হয়নি। পরীক্ষা না থাকলে নম্বর দেওয়া বা ফলাফল প্রকাশ করা যাবে না।',
        action: data.canManage && !this.search
          ? { label: 'প্রথম পরীক্ষা তৈরি করুন', onClick: () => this.openForm(null) }
          : undefined,
      }));
      return;
    }

    root.append(dataTable(d, {
      caption: 'পরীক্ষার তালিকা',
      rows,
      rowKey: (e) => e.id,
      columns: [
        {
          key: 'name', header: 'পরীক্ষা', mobile: 'title',
          cell: (e) => e.nameBn,
          width: 'minmax(0, 2fr)',
        },
        {
          key: 'type', header: 'ধরন', mobile: 'subtitle',
          cell: (e) => typeLabel(e.examType),
        },
        {
          key: 'dates', header: 'তারিখ', mobile: 'meta',
          cell: (e) => dateRange(e.startsOn, e.endsOn),
        },
        {
          key: 'scope', header: 'বিষয় ও সেকশন', mobile: 'meta',
          // paperCount is what makes the exam markable at all — an exam with
          // no papers is invisible to the marks screen.
          cell: (e) => `${bnNum(e.paperCount)} বিষয় · ${bnNum(e.sectionCount)} সেকশন`,
        },
        {
          key: 'marks', header: 'নম্বর দেওয়া', mobile: 'meta', numeric: true,
          cell: (e) => bnNum(e.markCount),
        },
        {
          key: 'status', header: 'অবস্থা', mobile: 'status',
          cell: (e) => statusBadge(d, statusOf(e.status)),
        },
        ...(data.canManage ? [{
          key: 'actions', header: 'ব্যবস্থা',
          cell: (e: Exam) => this.rowActions(e),
        }] : []),
      ],
    }));

    // Shown only when it applies to something on screen: the reason an edit
    // control is missing from some rows and not others.
    if (rows.some(isFinal)) {
      root.append(el(d, 'p', {
        className: 'att-sub',
        text: 'ফলাফল প্রকাশিত পরীক্ষা আর সম্পাদনা করা যায় না — প্রকাশিত ফল অভিভাবককে ইতিমধ্যে জানানো হয়েছে।',
      }));
    }
  }

  private controls(data: Body, tree: Tree): HTMLElement {
    const d = this.o.doc;
    const wrap = el(d, 'div', { className: 'ui-fieldset' });

    const year = field(d, {
      label: 'শিক্ষাবর্ষ', name: 'year', kind: 'select',
      value: this.yearId,
      options: tree.years.map((y) => ({
        value: y.id, label: y.isCurrent ? `${y.label} (চলতি)` : y.label,
      })),
      onChange: (v) => { this.yearId = v; void this.load(); },
    });
    const search = field(d, {
      label: 'খুঁজুন', name: 'q', kind: 'search', value: this.search,
      placeholder: 'পরীক্ষার নাম বা ধরন',
      onInput: (v) => { this.search = v; this.render(); },
    });
    append(wrap, year.root, search.root);

    if (data.canManage) {
      append(wrap, buttonRow(d, button(d, {
        label: 'নতুন পরীক্ষা', variant: 'primary', disabled: this.busy,
        onClick: () => this.openForm(null),
      })));
    }
    return wrap;
  }

  private summary(data: Body): HTMLElement {
    const d = this.o.doc;
    const exams = data.exams;
    const papers = exams.reduce((n, e) => n + e.paperCount, 0);
    const done = exams.filter(isFinal).length;
    return statRow(d,
      statCard(d, { label: 'পরীক্ষা', value: bnNum(exams.length), glyph: 'clipboard' }),
      statCard(d, {
        label: 'মোট বিষয়', value: bnNum(papers), glyph: 'layers',
        note: 'নম্বর এই বিষয়গুলোতেই দেওয়া যায়',
      }),
      statCard(d, {
        label: 'ফলাফল প্রকাশিত', value: bnNum(done), glyph: 'check-square',
        note: done === 0 ? 'এখনো কোনোটির ফল প্রকাশ হয়নি' : undefined,
      }));
  }

  private rowActions(e: Exam): HTMLElement {
    const d = this.o.doc;
    // No delete: the database refuses it for every role and a button here
    // would report a deletion that never happened (DELETE 0 raises nothing).
    if (isFinal(e)) {
      return el(d, 'span', { className: 'att-sub', text: '—' });
    }
    return buttonRow(d, button(d, {
      label: 'সম্পাদনা', size: 'sm', disabled: this.busy,
      onClick: () => this.openForm(e),
    }));
  }

  private openForm(existing: Exam | null): void {
    const d = this.o.doc;
    const data = this.data;
    const tree = this.tree;
    if (!data || !tree || !tree.year) return;

    const form = el(d, 'div', { className: 'ui-fieldset' });

    // A refusal is shown here, beside the values that caused it, and the
    // drawer stays open so they do not have to be retyped (B-60).
    const errLine = el(d, 'p', {
      className: 'ui-field-error',
      attrs: { role: 'alert', hidden: 'hidden' },
    });
    append(form, errLine);

    const nameBn = field(d, {
      label: 'পরীক্ষার নাম', name: 'nameBn', required: true,
      value: existing?.nameBn ?? '',
      helper: 'যেমন — "বার্ষিক পরীক্ষা ২০২৬"। একই শিক্ষাবর্ষে একই নাম দুবার দেওয়া যাবে না।',
      attrs: { maxlength: 120 },
    });
    const nameEn = field(d, {
      label: 'নাম (ইংরেজি)', name: 'nameEn',
      value: existing?.nameEn ?? '',
      helper: 'ঐচ্ছিক — না দিলে বাংলা নামটিই ব্যবহার হবে।',
      attrs: { maxlength: 120 },
    });
    const examType = field(d, {
      label: 'ধরন', name: 'examType', kind: 'select', required: true,
      value: existing?.examType ?? '',
      // The set comes from the server, which reads it from the same constant
      // the CHECK constraint is kept in step with. A hard-coded list here
      // would drift the day a type is added.
      options: data.examTypes.map((t) => ({ value: t, label: typeLabel(t) })),
    });
    const startsOn = field(d, {
      label: 'শুরুর তারিখ', name: 'startsOn', kind: 'date',
      value: existing?.startsOn ?? '',
      helper: `ঐচ্ছিক — ${tree.year.label} শিক্ষাবর্ষের ভেতরে হতে হবে।`,
    });
    const endsOn = field(d, {
      label: 'শেষ তারিখ', name: 'endsOn', kind: 'date',
      value: existing?.endsOn ?? '',
      helper: 'ঐচ্ছিক — শুরুর তারিখের আগে হতে পারে না।',
    });
    const weight = field(d, {
      label: 'ফলাফলে ওজন (%)', name: 'weightPercent', kind: 'number',
      value: String(existing?.weightPercent ?? 100),
      helper: 'বার্ষিক ফলে এই পরীক্ষা কতটা গণ্য হবে — ০ থেকে ১০০।',
      attrs: { min: 0, max: 100, step: 1 },
    });

    append(form, nameBn.root, nameEn.root, examType.root,
      startsOn.root, endsOn.root, weight.root);

    // Toggle button, not a checkbox: this design system has no checkbox field
    // kind, and a filled button reads as an answer rather than an open
    // question. Same control the room register uses for capabilities.
    let gpaBearing = existing?.isGpaBearing ?? true;
    const gpaGroup = el(d, 'div', { className: 'ui-fieldset' });
    append(gpaGroup, el(d, 'p', { className: 'ui-field-label', text: 'জিপিএ' }));
    const gpaBtn = button(d, {
      label: 'জিপিএ-তে গণ্য হবে',
      variant: gpaBearing ? 'primary' : 'secondary',
      onClick: () => {
        gpaBearing = !gpaBearing;
        gpaBtn.setAttribute('aria-pressed', gpaBearing ? 'true' : 'false');
        gpaBtn.className = gpaBtn.className
          .replace(/ui-btn-(primary|secondary)/, gpaBearing ? 'ui-btn-primary' : 'ui-btn-secondary');
      },
    });
    gpaBtn.setAttribute('aria-pressed', gpaBearing ? 'true' : 'false');
    append(gpaGroup, buttonRow(d, gpaBtn), el(d, 'p', {
      className: 'att-sub',
      text: 'শ্রেণি পরীক্ষার মতো ছোট পরীক্ষা সাধারণত জিপিএ-তে গণ্য হয় না।',
    }));
    append(form, gpaGroup);

    // ── Sections ────────────────────────────────────────────────────────
    // Only on creation. PATCH writes seven columns and reads none of
    // academicYearId, termId or sectionIds, so offering them on an edit would
    // be a control that appears to work and silently does nothing.
    const chosen = new Set<string>();
    if (!existing) {
      const group = el(d, 'div', { className: 'ui-fieldset' });
      append(group, el(d, 'p', { className: 'ui-field-label', text: 'কোন সেকশন পরীক্ষা দেবে *' }));

      const anySection = tree.classes.some((l) => l.groups.some((g) => g.sections.length > 0));
      if (!anySection) {
        append(group, el(d, 'p', {
          className: 'att-sub',
          text: 'এই শিক্ষাবর্ষে কোনো সেকশন নেই। আগে শ্রেণি ও সেকশন তৈরি করুন।',
        }));
      }

      for (const level of tree.classes) {
        for (const g of level.groups) {
          if (g.sections.length === 0) continue;
          // "নবম · বিজ্ঞান" — the group matters because two classes at the
          // same level teach different subjects, and the papers follow the
          // class, not the level.
          append(group, el(d, 'p', {
            className: 'att-sub',
            text: `${level.nameBn} · ${g.groupBn}`,
          }));
          const row = buttonRow(d);
          for (const s of g.sections) {
            const btn = button(d, {
              label: `${s.name} (${bnNum(s.studentCount)} জন)`,
              variant: 'secondary',
              onClick: () => {
                const on = chosen.has(s.id);
                if (on) chosen.delete(s.id); else chosen.add(s.id);
                btn.setAttribute('aria-pressed', on ? 'false' : 'true');
                btn.className = btn.className
                  .replace(/ui-btn-(primary|secondary)/, on ? 'ui-btn-secondary' : 'ui-btn-primary');
              },
            });
            btn.setAttribute('aria-pressed', 'false');
            append(row, btn);
          }
          append(group, row);
        }
      }
      append(group, el(d, 'p', {
        className: 'att-sub',
        text: 'প্রতিটি সেকশনের শ্রেণিতে যেসব বিষয় নির্ধারিত আছে, সেগুলোর জন্য প্রশ্নপত্র স্বয়ংক্রিয়ভাবে তৈরি হবে।',
      }));
      append(form, group);
    }

    let handle: OverlayHandle;
    const cancel = button(d, { label: 'বাতিল', variant: 'secondary', onClick: () => handle.close() });
    const save = button(d, {
      label: existing ? 'সংরক্ষণ করুন' : 'পরীক্ষা তৈরি করুন',
      variant: 'primary',
      onClick: async () => {
        const payload: Record<string, unknown> = {
          nameBn: nameBn.input.value.trim(),
          nameEn: nameEn.input.value.trim(),
          examType: examType.input.value,
          weightPercent: Number(weight.input.value),
          startsOn: startsOn.input.value || null,
          endsOn: endsOn.input.value || null,
          isGpaBearing: gpaBearing,
        };
        if (existing) {
          payload.id = existing.id;
        } else {
          payload.academicYearId = this.yearId;
          payload.sectionIds = [...chosen];
        }

        errLine.setAttribute('hidden', 'hidden');
        setBusy(save, true);
        // The drawer closes only once the server has accepted it (B-60).
        const msg = await this.send(existing ? 'PATCH' : 'POST', payload,
          existing ? 'সংরক্ষণ করা হয়েছে।' : 'তৈরি করা হয়েছে।');
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
      title: existing ? `${existing.nameBn} সম্পাদনা` : 'নতুন পরীক্ষা',
      body: form,
      actions: [cancel, save],
    });
  }
}
