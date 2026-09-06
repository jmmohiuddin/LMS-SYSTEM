/**
 * "রুটিন তৈরির প্রস্তুতি" — the routine setup wizard.
 *
 * P9-2. Its promise is one sentence: **nobody reaches Generate without
 * knowing what is missing.** Everything below follows from that.
 *
 * ── Not a linear wizard, and that is deliberate ────────────────────────────
 * The brief proposes step → review → complete → next. A school's data does
 * not arrive in that order. The office already has rooms from last year, the
 * curriculum was seeded at provisioning, and the one thing genuinely missing
 * is usually the teacher assignments. A linear flow would march a coordinator
 * through five screens that are already correct to reach the sixth.
 *
 * So this is a CHECKLIST: every step, its state, and one sentence saying what
 * would fix it. A coordinator opens it, sees two red rows, fixes those, and
 * generates. That is the same information a linear wizard carries, minus the
 * marching — and the step order is still the dependency order, so reading top
 * to bottom is a valid way to do it for a school starting from nothing.
 *
 * ── The three states, and why the third one exists ─────────────────────────
 *   ✅ ok       will not stop a generation run
 *   ⚠️ warn     will run, and the result will be poorer
 *   ❌ blocked  cannot produce a usable routine
 *
 * `warn` is the state that makes the one-minute promise honest. Teacher
 * availability is the case: a school that has recorded none gets a routine
 * built on "everyone is free all week", which is the right default for a
 * first run. Making that a blocker would send a school off to do an
 * afternoon of optional data entry before seeing anything work.
 *
 * ── Where each step lives ──────────────────────────────────────────────────
 * Three steps open an editor INSIDE this view, because they had no screen at
 * all before P9-2 (bell times, subject demand, teacher availability). The
 * rest link out to screens that already exist and are already good — rooms,
 * the assignment matrix, the academic structure. Rebuilding those inside a
 * wizard would be a second implementation of each, and the second one is
 * always the one that rots.
 *
 * ── Readiness is never computed here ───────────────────────────────────────
 * Every count comes from `GET /rms/setup`. Two people editing at once would
 * make a browser-side count disagree with the database, and this screen's
 * only job is to be trusted about what is missing.
 */
import {
  el, pageHeader, card, button, buttonRow, statusBadge, sectionHeading,
  permissionState, deniedMessage, deniedContact, announce, toast, listSkeleton,
} from './ui/index.ts';
import { emptyState, errorState } from './view-states.ts';
import { refuseUnlessOk, isDenied } from './http-status.ts';
import type { Auth } from './auth.ts';

const BN_DIGITS = '০১২৩৪৫৬৭৮৯';
const bn = (n: number): string => String(n).replace(/\d/g, (d) => BN_DIGITS[Number(d)]);
const DAY_BN = ['রবিবার', 'সোমবার', 'মঙ্গলবার', 'বুধবার', 'বৃহস্পতিবার', 'শুক্রবার', 'শনিবার'];

const KIND_BN: Record<string, string> = {
  teaching: 'ক্লাস', assembly: 'অ্যাসেম্বলি', tiffin: 'টিফিন', prayer: 'নামাজ',
  games: 'খেলা', study: 'পড়াশোনা', break: 'বিরতি',
};
const AVAIL_BN: Record<string, string> = {
  unavailable: 'পারবেন না', preferred: 'পছন্দ', admin_duty: 'প্রশাসনিক দায়িত্ব',
};

interface Step {
  id: string; titleBn: string; state: 'ok' | 'warn' | 'blocked';
  detailBn: string; done: number; total: number;
}
interface Readiness {
  steps: Step[];
  canGenerate: boolean;
  weekend: { days: number[]; managedBy: string };
}
interface PeriodRow {
  id?: string; periodNo: number; labelBn: string; startsAt: string; endsAt: string; kind: string;
}
interface DemandRow {
  id: string; subjectId: string; nameBn: string; periodsPerWeek: number;
  doublePeriodsPerWeek: number; requiresCapability: string | null;
}
interface AvailBlock {
  id: string; teacherId: string; dayOfWeek: number;
  startsAt: string; endsAt: string; kind: string; reason: string | null;
}

export interface RoutineSetupViewOptions {
  root: HTMLElement;
  doc: Document;
  auth: Auth;
  yearId?: string;
  /** Where the steps that live on their own screens send the coordinator. */
  onNavigate?: (path: string) => void;
}

/** Steps this view edits itself, because they had no screen before P9-2. */
const INLINE = new Set(['periods', 'demand', 'availability']);
/** Steps that belong to a screen that already exists and is already good. */
const ELSEWHERE: Record<string, string> = {
  structure: 'structure',
  assignments: 'teachingassignments',
  rooms: 'rooms',
};

export class RoutineSetupView {
  private readonly o: RoutineSetupViewOptions;
  private yearId = '';
  private readiness: Readiness | null = null;
  private open: string | null = null;
  private loading = true;
  private busy = false;
  private denied = false;
  private deniedErr: unknown = null;
  private error = '';

  /** Step-local state, loaded when a step is opened. */
  private periods: { templates: Array<{ id: string; nameBn: string; shift: string }>;
                     rows: PeriodRow[]; templateId: string } | null = null;
  private demand: { classes: Array<{ id: string; nameBn: string }>; classId: string;
                    rows: DemandRow[] } | null = null;
  private avail: { teachers: Array<{ id: string; nameBn: string }>;
                   blocks: AvailBlock[] } | null = null;

  constructor(options: RoutineSetupViewOptions) {
    this.o = options;
    this.yearId = options.yearId ?? '';
    void this.start();
  }

  private async start(): Promise<void> {
    if (!this.yearId) {
      try {
        const res = await this.o.auth.authedFetch('/api/v1/academics/hierarchy');
        await refuseUnlessOk(res);
        const b = await res.json() as
          { years?: Array<{ id: string; isCurrent?: boolean }>; year?: { id: string } };
        this.yearId = b.years?.find((y) => y.isCurrent)?.id ?? b.years?.[0]?.id
          ?? b.year?.id ?? '';
      } catch (err) {
        if (isDenied(err)) { this.denied = true; this.deniedErr = err; }
        else this.error = 'শিক্ষাবর্ষ আনা যায়নি — সংযোগ পেলে আবার দেখা যাবে।';
        this.loading = false; this.render(); return;
      }
    }
    await this.loadReadiness();
  }

  private async loadReadiness(): Promise<void> {
    this.loading = true; this.render();
    try {
      const res = await this.o.auth.authedFetch(
        `/api/v1/rms/setup?yearId=${encodeURIComponent(this.yearId)}`);
      await refuseUnlessOk(res);
      this.readiness = await res.json() as Readiness;
      this.error = '';
    } catch (err) {
      if (isDenied(err)) { this.denied = true; this.deniedErr = err; }
      else this.error = 'প্রস্তুতির তথ্য আনা যায়নি — সংযোগ পেলে আবার দেখা যাবে।';
    } finally {
      this.loading = false; this.render();
    }
  }

  /** Toggle a step open or shut; navigate away for the ones that live elsewhere. */
  private async openStep(id: string): Promise<void> {
    const path = ELSEWHERE[id];
    if (path) { this.o.onNavigate?.(path); return; }
    if (!INLINE.has(id)) return;

    this.open = this.open === id ? null : id;
    if (!this.open) { this.render(); return; }
    await this.reloadStep(this.open);
  }

  /**
   * Re-fetch the open step WITHOUT toggling it.
   *
   * `openStep` is a toggle, so calling it after a save would shut the editor
   * the coordinator is working in — which is exactly what the first version
   * of `save()` did.
   */
  private async reloadStep(id: string): Promise<void> {
    this.loading = true; this.render();
    try {
      const res = await this.o.auth.authedFetch(
        `/api/v1/rms/setup?yearId=${encodeURIComponent(this.yearId)}&step=${id}`);
      await refuseUnlessOk(res);
      const b = await res.json() as Record<string, unknown>;
      if (id === 'periods') {
        const templates = (b.templates as Array<{ id: string; nameBn: string; shift: string }>) ?? [];
        const templateId = templates[0]?.id ?? '';
        // The endpoint returns every template's periods in one list, because
        // a school with two shifts wants both loaded before it picks one.
        // Only the chosen shift is edited at a time.
        const chosen = this.periods?.templateId && templates.some(
          (t) => t.id === this.periods?.templateId) ? this.periods.templateId : templateId;
        this.periods = {
          templates,
          templateId: chosen,
          rows: ((b.periods as Array<PeriodRow & { templateId: string }>) ?? [])
            .filter((row) => row.templateId === chosen)
            .map((row) => ({ ...row })),
        };
      }
      if (id === 'demand') {
        this.demand = {
          classes: (b.classes as Array<{ id: string; nameBn: string }>) ?? [],
          classId: String(b.classId ?? ''),
          rows: (b.rows as DemandRow[]) ?? [],
        };
      }
      if (id === 'availability') {
        this.avail = {
          teachers: (b.teachers as Array<{ id: string; nameBn: string }>) ?? [],
          blocks: (b.blocks as AvailBlock[]) ?? [],
        };
      }
      this.error = '';
    } catch (err) {
      if (isDenied(err)) { this.denied = true; this.deniedErr = err; }
      else this.error = 'তথ্য আনা যায়নি — সংযোগ পেলে আবার দেখা যাবে।';
    } finally {
      this.loading = false; this.render();
    }
  }

  /**
   * Every write goes through here.
   *
   * Returns a message on failure and `''` on success, so a refused save
   * leaves the form and its typing exactly where they were — the same
   * contract `writer-save-errors.test.ts` exists to protect.
   */
  private async send(body: unknown): Promise<string> {
    try {
      const res = await this.o.auth.authedFetch('/api/v1/rms/setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const b = await res.json().catch(() => null) as { message?: string } | null;
      return res.ok ? '' : (b?.message ?? 'সংরক্ষণ করা যায়নি।');
    } catch {
      return 'সংযোগ নেই — সংরক্ষণ করা যায়নি।';
    }
  }

  private async save(body: unknown, okBn: string): Promise<void> {
    this.busy = true; this.render();
    const msg = await this.send(body);
    this.busy = false;
    if (msg) {
      this.error = msg; this.render(); announce(this.o.doc, msg); return;
    }
    this.error = '';
    toast(this.o.doc, { message: okBn, tone: 'success' });
    // Readiness is server truth and a save may have moved it. The open
    // editor is refreshed, not toggled.
    await this.loadReadiness();
    if (this.open) await this.reloadStep(this.open);
  }

  /* ───────────────────────────── step editors ─────────────────────────── */

  private periodsEditor(): HTMLElement {
    const d = this.o.doc;
    const p = this.periods;
    const wrap = el(d, 'div', { className: 'ui-stack setup-editor' });
    if (!p) return wrap;

    if (p.templates.length > 1) {
      const pick = el(d, 'label', { className: 'field' });
      pick.append(el(d, 'span', { className: 'field-label', text: 'শিফট' }));
      const sel = d.createElement('select');
      sel.className = 'field-input';
      for (const t of p.templates) {
        const o = d.createElement('option');
        o.value = t.id; o.textContent = t.nameBn;
        if (t.id === p.templateId) o.selected = true;
        sel.append(o);
      }
      sel.addEventListener('change', () => {
        p.templateId = sel.value;
        void this.openStep('periods');
      });
      pick.append(sel);
      wrap.append(pick);
    }

    const list = el(d, 'div', { className: 'ui-stack' });
    p.rows.forEach((row, i) => {
      const line = el(d, 'div', { className: 'setup-period-row' });

      const label = d.createElement('input');
      label.className = 'field-input';
      label.value = row.labelBn;
      label.setAttribute('aria-label', `${bn(i + 1)} নম্বর পিরিয়ডের নাম`);
      label.addEventListener('input', () => { row.labelBn = label.value; });

      const from = d.createElement('input');
      from.type = 'time'; from.className = 'field-input';
      from.value = row.startsAt;
      from.setAttribute('aria-label', `${row.labelBn || bn(i + 1)} — শুরু`);
      from.addEventListener('input', () => { row.startsAt = from.value; });

      const to = d.createElement('input');
      to.type = 'time'; to.className = 'field-input';
      to.value = row.endsAt;
      to.setAttribute('aria-label', `${row.labelBn || bn(i + 1)} — শেষ`);
      to.addEventListener('input', () => { row.endsAt = to.value; });

      const kind = d.createElement('select');
      kind.className = 'field-input';
      kind.setAttribute('aria-label', `${row.labelBn || bn(i + 1)} — ধরন`);
      for (const k of Object.keys(KIND_BN)) {
        const o = d.createElement('option');
        o.value = k; o.textContent = KIND_BN[k];
        if (k === row.kind) o.selected = true;
        kind.append(o);
      }
      kind.addEventListener('change', () => { row.kind = kind.value; });

      line.append(label, from, to, kind, button(d, {
        label: 'সরান', variant: 'ghost', size: 'sm',
        onClick: () => { p.rows.splice(i, 1); this.render(); },
      }));
      list.append(line);
    });
    wrap.append(list);

    wrap.append(buttonRow(d,
      button(d, {
        label: 'পিরিয়ড যোগ করুন', variant: 'secondary',
        onClick: () => {
          const last = p.rows[p.rows.length - 1];
          // Start the new one where the last finished — the office's own
          // arithmetic, so nobody types a timestamp twice.
          const startsAt = last?.endsAt ?? '08:00';
          const endsAt = addMinutes(startsAt, 45);
          p.rows.push({
            periodNo: (last?.periodNo ?? 0) + 1,
            labelBn: `${bn(p.rows.filter((r) => r.kind === 'teaching').length + 1)}ম`,
            startsAt, endsAt, kind: 'teaching',
          });
          this.render();
        },
      }),
      button(d, {
        label: this.busy ? 'সংরক্ষণ হচ্ছে…' : 'সংরক্ষণ করুন',
        variant: 'primary', disabled: this.busy || p.rows.length === 0,
        onClick: () => void this.save(
          { step: 'periods', templateId: p.templateId,
            periods: p.rows.map((r, i) => ({ ...r, periodNo: i + 1 })) },
          'পিরিয়ড সংরক্ষণ হয়েছে'),
      })));
    return wrap;
  }

  private demandEditor(): HTMLElement {
    const d = this.o.doc;
    const m = this.demand;
    const wrap = el(d, 'div', { className: 'ui-stack setup-editor' });
    if (!m) return wrap;

    if (m.classes.length > 1) {
      const pick = el(d, 'label', { className: 'field' });
      pick.append(el(d, 'span', { className: 'field-label', text: 'শ্রেণি' }));
      const sel = d.createElement('select');
      sel.className = 'field-input';
      for (const c of m.classes) {
        const o = d.createElement('option');
        o.value = c.id; o.textContent = c.nameBn;
        if (c.id === m.classId) o.selected = true;
        sel.append(o);
      }
      sel.addEventListener('change', async () => {
        const res = await this.o.auth.authedFetch(
          `/api/v1/rms/setup?yearId=${this.yearId}&step=demand&classId=${sel.value}`);
        const b = await res.json() as { rows: DemandRow[]; classId: string };
        m.rows = b.rows; m.classId = b.classId;
        this.render();
      });
      pick.append(sel);
      wrap.append(pick);
    }

    for (const row of m.rows) {
      const line = el(d, 'div', { className: 'setup-demand-row' });
      const name = el(d, 'span', { className: 'setup-demand-name' });
      name.append(el(d, 'strong', { text: row.nameBn }));
      if (row.requiresCapability) {
        name.append(el(d, 'span', { className: 'ui-cell-meta', text: ' · ল্যাব লাগবে' }));
      }

      const weekly = d.createElement('input');
      weekly.type = 'number'; weekly.min = '0'; weekly.max = '20';
      weekly.className = 'field-input';
      weekly.value = String(row.periodsPerWeek);
      weekly.setAttribute('aria-label', `${row.nameBn} — সপ্তাহে কয়টি পিরিয়ড`);
      weekly.addEventListener('input', () => { row.periodsPerWeek = Number(weekly.value); });

      const dbl = d.createElement('input');
      dbl.type = 'number'; dbl.min = '0'; dbl.max = '10';
      dbl.className = 'field-input';
      dbl.value = String(row.doublePeriodsPerWeek);
      dbl.setAttribute('aria-label', `${row.nameBn} — কয়টি ডাবল পিরিয়ড`);
      dbl.addEventListener('input', () => { row.doublePeriodsPerWeek = Number(dbl.value); });

      line.append(name,
        labelled(d, 'সাপ্তাহিক', weekly),
        labelled(d, 'ডাবল', dbl));
      wrap.append(line);
    }

    wrap.append(buttonRow(d, button(d, {
      label: this.busy ? 'সংরক্ষণ হচ্ছে…' : 'সংরক্ষণ করুন',
      variant: 'primary', disabled: this.busy || m.rows.length === 0,
      onClick: () => void this.save({
        step: 'demand', yearId: this.yearId,
        rows: m.rows.map((r) => ({
          id: r.id, periodsPerWeek: r.periodsPerWeek,
          doublePeriodsPerWeek: r.doublePeriodsPerWeek,
        })),
      }, 'সাপ্তাহিক পিরিয়ড সংরক্ষণ হয়েছে'),
    })));
    return wrap;
  }

  private availabilityEditor(): HTMLElement {
    const d = this.o.doc;
    const a = this.avail;
    const wrap = el(d, 'div', { className: 'ui-stack setup-editor' });
    if (!a) return wrap;

    if (a.teachers.length === 0) {
      wrap.append(emptyState(d, {
        glyph: 'users',
        message: 'আগে "কে কোন বিষয় পড়ান" ধাপে শিক্ষক নির্ধারণ করুন।',
      }));
      return wrap;
    }

    // Existing blocks first: what a coordinator opens this to check.
    if (a.blocks.length > 0) {
      for (const b of a.blocks) {
        const t = a.teachers.find((x) => x.id === b.teacherId);
        const line = el(d, 'div', { className: 'setup-avail-row' });
        line.append(el(d, 'span', {
          text: `${t?.nameBn ?? '—'} · ${DAY_BN[b.dayOfWeek]} ${b.startsAt}–${b.endsAt}`,
        }));
        line.append(statusBadge(d, b.kind === 'preferred'
          ? { state: 'active', label: AVAIL_BN[b.kind], tone: 'success' }
          : { state: 'pending', label: AVAIL_BN[b.kind] ?? b.kind, tone: 'warn' }));
        if (b.reason) line.append(el(d, 'span', { className: 'ui-cell-meta', text: b.reason }));
        line.append(button(d, {
          label: 'বাতিল', variant: 'ghost', size: 'sm',
          onClick: () => void this.save({ step: 'availability', remove: b.id }, 'বাতিল হয়েছে'),
        }));
        wrap.append(line);
      }
    } else {
      wrap.append(el(d, 'p', {
        className: 'ui-card-note',
        text: 'কারও সময়-সীমা দেওয়া হয়নি — সবাইকে সব সময় ফাঁকা ধরা হবে। এটি ঐচ্ছিক।',
      }));
    }

    // The add form.
    const teacher = d.createElement('select');
    teacher.className = 'field-input';
    teacher.setAttribute('aria-label', 'শিক্ষক');
    for (const t of a.teachers) {
      const o = d.createElement('option');
      o.value = t.id; o.textContent = t.nameBn;
      teacher.append(o);
    }
    const day = d.createElement('select');
    day.className = 'field-input';
    day.setAttribute('aria-label', 'দিন');
    DAY_BN.forEach((label, i) => {
      const o = d.createElement('option');
      o.value = String(i); o.textContent = label;
      if (i === 1) o.selected = true;
      day.append(o);
    });
    const from = d.createElement('input');
    from.type = 'time'; from.className = 'field-input'; from.value = '08:00';
    from.setAttribute('aria-label', 'শুরু');
    const to = d.createElement('input');
    to.type = 'time'; to.className = 'field-input'; to.value = '10:00';
    to.setAttribute('aria-label', 'শেষ');
    const kind = d.createElement('select');
    kind.className = 'field-input';
    kind.setAttribute('aria-label', 'ধরন');
    for (const k of Object.keys(AVAIL_BN)) {
      const o = d.createElement('option');
      o.value = k; o.textContent = AVAIL_BN[k];
      kind.append(o);
    }
    const reason = d.createElement('input');
    reason.className = 'field-input';
    reason.placeholder = 'কারণ (ঐচ্ছিক)';
    reason.setAttribute('aria-label', 'কারণ');

    const form = el(d, 'div', { className: 'setup-avail-form' });
    form.append(
      labelled(d, 'শিক্ষক', teacher), labelled(d, 'দিন', day),
      labelled(d, 'শুরু', from), labelled(d, 'শেষ', to),
      labelled(d, 'ধরন', kind), labelled(d, 'কারণ', reason));
    wrap.append(sectionHeading(d, { title: 'নতুন সময়-সীমা', level: 3 }), form);

    wrap.append(buttonRow(d, button(d, {
      label: this.busy ? 'যোগ হচ্ছে…' : 'যোগ করুন',
      variant: 'primary', disabled: this.busy,
      onClick: () => void this.save({
        step: 'availability', teacherId: teacher.value, dayOfWeek: Number(day.value),
        startsAt: from.value, endsAt: to.value, kind: kind.value, reason: reason.value.trim(),
      }, 'সময়-সীমা যোগ হয়েছে'),
    })));
    return wrap;
  }

  /* ───────────────────────────────── render ───────────────────────────── */

  private render(): void {
    const d = this.o.doc;
    const root = this.o.root;
    root.textContent = '';

    if (this.denied) {
      root.append(pageHeader(d, { title: 'রুটিন তৈরির প্রস্তুতি' }));
      root.append(permissionState(d, {
        message: deniedMessage(this.deniedErr, 'রুটিন প্রস্তুতি'),
        contact: deniedContact(this.deniedErr),
      }));
      return;
    }

    root.append(pageHeader(d, {
      title: 'রুটিন তৈরির প্রস্তুতি',
      subtitle: 'রুটিন তৈরির আগে যা যা লাগবে — কী বাকি আছে এখানেই দেখা যায়',
    }));

    if (this.loading && !this.readiness) { root.append(listSkeleton(d, 5)); return; }

    if (this.error && !this.readiness) {
      root.append(errorState(d, this.error, () => void this.loadReadiness()));
      return;
    }
    const r = this.readiness;
    if (!r) {
      root.append(emptyState(d, {
        glyph: 'calendar',
        message: 'চলতি শিক্ষাবর্ষ পাওয়া যায়নি। আগে শিক্ষাবর্ষ তৈরি করুন।',
      }));
      return;
    }

    if (this.error) root.append(errorState(d, this.error));

    const blocked = r.steps.filter((s) => s.state === 'blocked').length;
    const warned = r.steps.filter((s) => s.state === 'warn').length;

    root.append(card(d, {
      title: r.canGenerate ? 'রুটিন তৈরি করা যাবে' : 'এখনো কিছু বাকি আছে',
      subtitle: r.canGenerate
        ? (warned > 0
          ? `${bn(warned)}টি ঐচ্ছিক বিষয় বাকি — চাইলে এখনই তৈরি করা যাবে`
          : 'সব প্রস্তুত')
        : `${bn(blocked)}টি ধাপ শেষ না হলে রুটিন তৈরি করা যাবে না`,
      glyph: r.canGenerate ? 'check-square' : 'alert-triangle',
      tone: r.canGenerate ? 'success' : 'warn',
    }));

    for (const s of r.steps) {
      const badge = s.state === 'ok'
        ? statusBadge(d, { state: 'active', label: 'সম্পূর্ণ', tone: 'success' })
        : s.state === 'warn'
          ? statusBadge(d, { state: 'pending', label: 'ঐচ্ছিক', tone: 'warn' })
          : statusBadge(d, { state: 'blocked', label: 'প্রয়োজন', tone: 'danger' });

      const body = el(d, 'div', { className: 'ui-stack' });
      body.append(el(d, 'p', { className: 'ui-card-note', text: s.detailBn }));

      // Working days are the platform's. Say where they are managed rather
      // than offering a control that would be refused (migration 069).
      if (s.id === 'workingdays') {
        body.append(el(d, 'p', {
          className: 'ui-cell-meta',
          text: 'কর্মদিবস shikhonBD নির্ধারণ করে — পরিবর্তনের প্রয়োজন হলে যোগাযোগ করুন।',
        }));
      } else if (INLINE.has(s.id) || ELSEWHERE[s.id]) {
        body.append(buttonRow(d, button(d, {
          label: this.open === s.id ? 'বন্ধ করুন'
            : ELSEWHERE[s.id] ? 'এই ধাপে যান' : 'ঠিক করুন',
          variant: s.state === 'blocked' ? 'primary' : 'secondary',
          onClick: () => void this.openStep(s.id),
        })));
      }

      if (this.open === s.id) {
        if (this.loading) body.append(listSkeleton(d, 3));
        else if (s.id === 'periods') body.append(this.periodsEditor());
        else if (s.id === 'demand') body.append(this.demandEditor());
        else if (s.id === 'availability') body.append(this.availabilityEditor());
      }

      root.append(card(d, {
        title: s.titleBn, action: badge, glyph: 'clock', headingLevel: 3,
      }, body));
    }
  }
}

/** A control with its Bangla label, so every input has an accessible name. */
function labelled(d: Document, labelBn: string, control: HTMLElement): HTMLElement {
  const wrap = el(d, 'label', { className: 'field' });
  wrap.append(el(d, 'span', { className: 'field-label', text: labelBn }));
  wrap.append(control);
  return wrap;
}

/** "08:45" + 45 → "09:30". The office should never do this arithmetic. */
function addMinutes(hhmm: string, minutes: number): string {
  const [h, m] = hhmm.split(':').map(Number);
  const total = (h * 60 + m + minutes) % (24 * 60);
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}
