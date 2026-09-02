/**
 * Routine editor — F-502 / F-504 / F-506, wireframe §8.1.
 *
 * The coordinator's hardest screen: a week of periods against a week of days,
 * where every move can collide with a teacher, a room, or the section itself.
 *
 * ── Why this moves by tap, and not by drag ───────────────────────────────
 * §8.1 draws the interaction as drag-and-drop. It is implemented here as
 * tap-to-pick-up, tap-to-place, because on the device this product actually
 * targets, dragging is the worse instrument for the same job:
 *
 *   • The floor is 360x640 on a 2GB phone (§1), and §11 says the mobile
 *     layout IS the design — desktop is the enhancement. At 360px the grid
 *     scrolls horizontally, so source and target are frequently not on
 *     screen together. A drag that requires auto-scrolling mid-gesture with
 *     a thumb is a drag that gets dropped in the wrong cell.
 *   • HTML5 drag-and-drop does not fire on touch at all without a polyfill,
 *     and the critical path is budgeted at 180 KB gzipped (TRD §3).
 *   • Selection survives scrolling. Pick up a class, scroll to Thursday,
 *     put it down — the phone equivalent of holding it in your other hand.
 *   • It is the same gesture on touch, mouse, and keyboard, so keyboard
 *     support is not a second implementation.
 *
 * And it makes the constraint feedback BETTER, which is the actual
 * requirement. F-504 asks for live feedback; a drag can only tell you about
 * the cell under the pointer, whereas a held selection lets the grid mark
 * every reachable cell at once — see markTargets().
 *
 * ── What the client may and may not claim ────────────────────────────────
 * The database's exclusion constraints are the final arbiter (§8.1); this
 * screen is "an optimistic proposer". So it hints only what it can actually
 * see — this section's own week, which is the whole of the section-collision
 * dimension — and never pre-judges teacher or room collisions, which live in
 * other sections' slots it was never sent. Those surface on the attempt, as
 * a sentence naming the class that already owns the hour.
 */
import type { Auth } from './auth.ts';
import { emptyState, errorState } from './view-states.ts';
import {
  pageHeader, field, statusBadge, listSkeleton, openDrawer, button, buttonRow,
  el, append, setBusy, announce, confirmOverlay, type OverlayHandle,
} from './ui/index.ts';
import { formatCount } from '../../../packages/ui-core/src/format.ts';

/**
 * The teaching week comes from the SERVER, which reads `tenants.weekend_days`.
 *
 * This file used to hard-code রবি–বৃহঃ — Sunday to Thursday, five fixed
 * columns. `weekend_days` defaults to {5,6} so that matched most schools, but
 * it is per-institution and the live data already varies: one school in this
 * database keeps only Friday, which makes Saturday a teaching day the grid had
 * no column for. Lessons there would have been invisible and unplaceable.
 *
 * The fallback is used only before the first response arrives.
 */
const FALLBACK_DAYS: Array<{ dow: number; bn: string }> = [
  { dow: 0, bn: 'রবি' }, { dow: 1, bn: 'সোম' }, { dow: 2, bn: 'মঙ্গল' },
  { dow: 3, bn: 'বুধ' }, { dow: 4, bn: 'বৃহঃ' },
];

interface Period {
  periodNo: number; labelBn: string; startsAt: string; endsAt: string; kind: string;
}
interface Slot {
  id: string; dayOfWeek: number; periodNo: number;
  subjectBn: string | null; teacherName: string | null; roomName: string | null;
  isDouble: boolean; doubleGroupId: string | null;
  parallelPool: string | null; isPinned: boolean; rowVersion: number;
}
interface RoutineMeta {
  id: string; nameBn: string; shift: string; status: string; version: number;
  publishedAt: string | null; editable: boolean; sectionLabel: string;
}
interface Day { dow: number; bn: string }
interface PickSubject { id: string; nameBn: string; periodsPerWeek: number }
interface PickTeacher { subjectId: string; id: string; nameBn: string }
interface PickRoom { id: string; label: string; capacity: number | null }
/** What a section needs before a routine can exist for it. */
interface Setup {
  academicYearId: string; yearLabel: string; shift: string;
  periodTemplateId: string | null; periodTemplateName: string | null;
  sectionLabel: string; effectiveFrom: string;
}
interface Grid {
  sectionId: string;
  routine: RoutineMeta | null;
  periods: Period[];
  slots: Slot[];
  days?: Day[];
  setup?: Setup | null;
  subjects?: PickSubject[];
  teachers?: PickTeacher[];
  rooms?: PickRoom[];
}

export interface SectionOption { id: string; label: string }

export interface RoutineEditorViewOptions {
  root: HTMLElement;
  doc: Document;
  auth: Auth;
}

const SHIFT_BN: Record<string, string> = {
  morning: 'প্রাতঃ', day: 'দিবা', evening: 'সান্ধ্য', single: 'একক',
};
const STATUS_BN: Record<string, string> = {
  draft: 'খসড়া', review: 'পর্যালোচনায়', active: 'প্রকাশিত',
  superseded: 'প্রতিস্থাপিত', archived: 'সংরক্ষিত',
};

export class RoutineEditorView {
  private readonly o: RoutineEditorViewOptions;
  private sections: SectionOption[] = [];
  private sectionId: string | null = null;
  private grid: Grid | null = null;
  private selected: string | null = null;
  private notice: { text: string; tone: 'warn' | 'ok' } | null = null;
  private loading = true;
  /**
   * The load failed. Distinct from `notice`, and the distinction is the
   * point: a failure means the app does NOT know whether this section has a
   * routine, so "no routine has been created" must not be rendered under it.
   */
  private failed = false;
  private busy = false;

  constructor(options: RoutineEditorViewOptions) {
    this.o = options;
    this.sectionId = localStorage.getItem('shikhon_last_section');
    void this.init();
  }

  private async init(): Promise<void> {
    this.render();
    try {
      const res = await this.o.auth.authedFetch('/api/v1/academics/sections');
      if (res.ok) {
        const body = (await res.json()) as { sections: Array<{ id: string; name: string; className?: { bn?: string } }> };
        this.sections = body.sections.map((s) => ({
          id: s.id, label: `${s.className?.bn ?? ''}-${s.name}`.replace(/^-/, ''),
        }));
        if (!this.sectionId && this.sections[0]) this.sectionId = this.sections[0].id;
      }
    } catch { /* offline: the picker stays empty and the grid says why */ }
    if (this.sectionId) await this.loadGrid(this.sectionId);
    else { this.loading = false; this.render(); }
  }

  private async loadGrid(sectionId: string): Promise<void> {
    this.failed = false;
    this.loading = true;
    this.selected = null;
    this.render();
    try {
      const res = await this.o.auth.authedFetch(
        `/api/v1/rms/editor?sectionId=${encodeURIComponent(sectionId)}`);
      if (!res.ok) throw new Error(String(res.status));
      this.grid = (await res.json()) as Grid;
      this.notice = null;
    } catch {
      this.grid = null;
      // A FAILURE, not a notice. The render used to draw this warning and
      // then "এই শাখার জন্য কোনো রুটিন তৈরি হয়নি" underneath — but a failed
      // load does not know whether the section has a routine.
      this.failed = true;
      this.notice = null;
    }
    this.loading = false;
    this.render();
  }

  /* ------------------------------------------------------------ writing */

  /** The institution's own teaching days, never a constant. */
  private days(): Day[] {
    return this.grid?.days?.length ? this.grid.days : FALLBACK_DAYS;
  }

  /**
   * One POST, one shape of failure.
   *
   * Returns '' when accepted, otherwise the server's own sentence — which for
   * a clash names the teacher, the room or the class already in that hour.
   * Callers decide where to put it: a drawer keeps it inside the form beside
   * the values that caused it, the grid raises it as a notice.
   */
  private async send(body: Record<string, unknown>): Promise<string> {
    try {
      const res = await this.o.auth.authedFetch('/api/v1/rms/editor', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const out = (await res.json().catch(() => ({}))) as { ok?: boolean; message?: string };
      if (res.ok && out.ok) return '';
      return out.message ?? 'কাজটি সম্পন্ন হয়নি।';
    } catch {
      return 'সংযোগ নেই — পরিবর্তন সংরক্ষণ হয়নি।';
    }
  }

  private slotAt(dow: number, periodNo: number): Slot | undefined {
    return this.grid?.slots.find((s) => s.dayOfWeek === dow && s.periodNo === periodNo);
  }

  private pick(slot: Slot): void {
    // Refuse locally what the server would refuse anyway, and say why now
    // rather than after a round trip the coordinator has to wait for.
    if (slot.isPinned) {
      this.notice = { text: 'এই ক্লাসটি পিন করা — সরানো যাবে না।', tone: 'warn' };
      this.render(); return;
    }
    if (slot.isDouble || slot.doubleGroupId) {
      this.notice = {
        text: 'দ্বৈত পিরিয়ড আলাদা করে সরানো যায় না — দুটি অংশ একসাথেই থাকে।', tone: 'warn' };
      this.render(); return;
    }
    this.selected = this.selected === slot.id ? null : slot.id;
    this.notice = null;
    this.render();
  }

  private async place(dow: number, periodNo: number): Promise<void> {
    const slotId = this.selected;
    if (!slotId || this.busy) return;
    this.busy = true;
    this.notice = null;
    this.render();
    try {
      const res = await this.o.auth.authedFetch('/api/v1/rms/editor', {
        method: 'POST',
        body: JSON.stringify({ action: 'move', slotId, dayOfWeek: dow, periodNo }),
      });
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; message?: string };
      if (res.ok && body.ok) {
        this.selected = null;
        this.busy = false;
        await this.loadGrid(this.grid!.sectionId);   // re-read: the DB is the truth
        this.notice = { text: 'সরানো হয়েছে।', tone: 'ok' };
        this.render();
        return;
      }
      // F-504: the refusal names the class that already owns the hour.
      this.notice = { text: body.message ?? 'ওই ঘরে বসানো গেল না।', tone: 'warn' };
    } catch {
      this.notice = { text: 'সংযোগ নেই — পরিবর্তন সংরক্ষণ হয়নি।', tone: 'warn' };
    }
    this.busy = false;
    this.render();
  }

  private async publish(): Promise<void> {
    const routine = this.grid?.routine;
    if (!routine || this.busy) return;
    this.busy = true; this.render();
    try {
      const res = await this.o.auth.authedFetch('/api/v1/rms/editor', {
        method: 'POST',
        body: JSON.stringify({ action: 'publish', routineId: routine.id }),
      });
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; message?: string; unfilled?: number };
      if (res.ok && body.ok) {
        this.busy = false;
        await this.loadGrid(this.grid!.sectionId);
        this.notice = body.unfilled
          ? { text: `প্রকাশিত হয়েছে — তবে ${formatCount(body.unfilled, 'bn')}টি ঘর এখনো খালি।`, tone: 'warn' }
          : { text: 'রুটিন প্রকাশিত হয়েছে।', tone: 'ok' };
        this.render();
        return;
      }
      this.notice = { text: body.message ?? 'প্রকাশ করা যায়নি।', tone: 'warn' };
    } catch {
      this.notice = { text: 'সংযোগ নেই — প্রকাশ করা যায়নি।', tone: 'warn' };
    }
    this.busy = false;
    this.render();
  }

  /* ------------------------------------------------------------- render */

  private render(): void {
    const d = this.o.doc;
    const root = this.o.root;
    root.textContent = '';

    const rt = this.grid?.routine;
    root.append(pageHeader(d, {
      title: 'রুটিন সম্পাদনা',
      // F-506: the shift is named in the header, because a teacher working
      // both shifts is the most common source of real-world routine failure
      // and the coordinator must always know which one they are editing.
      subtitle: rt
        ? `${rt.sectionLabel} · ${SHIFT_BN[rt.shift] ?? rt.shift}`
        : 'পিরিয়ড সরান — সংঘর্ষ হলে কারণ জানায়',
      badge: rt
        ? statusBadge(d, {
            state: rt.status === 'published' ? 'published' : 'draft',
            label: `${STATUS_BN[rt.status] ?? rt.status} · সংস্করণ ${formatCount(rt.version, 'bn')}`,
          })
        : undefined,
    }));

    if (this.sections.length > 0) {
      root.append(field(d, {
        label: 'শাখা',
        name: 'section',
        kind: 'select',
        value: this.sectionId ?? '',
        options: this.sections.map((sec) => ({ value: sec.id, label: sec.label })),
        onChange: (v) => {
          this.sectionId = v;
          try { localStorage.setItem('shikhon_last_section', v); } catch { /* quota */ }
          void this.loadGrid(v);
        },
      }).root);
    }

    // A failure is the whole answer. This used to draw the warning AND then
    // "এই শাখার জন্য কোনো রুটিন তৈরি হয়নি" underneath it — two contradictory
    // claims, and the second one is not knowable when the first is true.
    if (this.failed) {
      root.append(errorState(d, 'রুটিন আনা যায়নি — সংযোগ দেখে আবার চেষ্টা করুন।',
        () => { if (this.sectionId) void this.loadGrid(this.sectionId); }));
      return;
    }

    if (this.loading && !this.grid) { root.append(listSkeleton(d, 5)); return; }

    if (this.notice) {
      const n = d.createElement('p');
      n.className = this.notice.tone === 'warn' ? 'inline-notice is-danger' : 'inline-notice';
      n.setAttribute('role', 'status');
      n.textContent = this.notice.text;
      root.append(n);
    }

    if (!this.grid?.routine) {
      const setup = this.grid?.setup ?? null;
      if (!setup) {
        root.append(emptyState(d, {
          glyph: 'clock',
          message: 'এই শাখার জন্য কোনো রুটিন তৈরি হয়নি।',
        }));
        return;
      }
      if (!setup.periodTemplateId) {
        // provision_tenant clones a bell schedule per shift from
        // period_template_defaults, which carries only `day` and `morning`
        // rows — an evening shift is provisioned with an empty template.
        root.append(emptyState(d, {
          glyph: 'clock',
          message: 'এই শিফটের জন্য ঘণ্টার সময়সূচি (পিরিয়ড টেমপ্লেট) নেই — '
            + 'আগে সেটি তৈরি করতে হবে, তারপর রুটিন বানানো যাবে।',
        }));
        return;
      }
      root.append(emptyState(d, {
        glyph: 'clock',
        message: `${setup.sectionLabel} · ${setup.yearLabel} শিক্ষাবর্ষের জন্য এখনো কোনো রুটিন নেই। `
          + 'রুটিন তৈরি করলে সপ্তাহের ছক খুলবে এবং ক্লাস বসানো যাবে।',
        action: { label: 'রুটিন তৈরি করুন', onClick: () => this.openCreate(setup) },
      }));
      return;
    }

    // The pick-up banner. Present only while something is held, so the screen
    // reads as "nothing is happening" when nothing is.
    if (this.selected) {
      const held = this.grid.slots.find((s) => s.id === this.selected);
      const bar = d.createElement('div');
      bar.className = 'card editor-holding';
      const what = d.createElement('p');
      what.className = 'editor-holding-what';
      what.textContent = `সরানো হচ্ছে: ${held?.subjectBn ?? 'ক্লাস'}`
        + (held?.teacherName ? ` · ${held.teacherName}` : '');
      const how = d.createElement('p');
      how.className = 'editor-holding-how';
      how.textContent = 'যে ঘরে বসাতে চান সেই খালি ঘরে চাপ দিন।';
      const acts = buttonRow(d,
        button(d, {
          label: 'সম্পাদনা', size: 'sm', variant: 'secondary', disabled: this.busy,
          onClick: () => { if (held) this.openLesson(held); },
        }),
        button(d, {
          label: 'সরান', size: 'sm', variant: 'danger', disabled: this.busy,
          onClick: () => { if (held) this.confirmRemove(held); },
        }),
        button(d, {
          label: 'বাতিল', size: 'sm', variant: 'secondary',
          onClick: () => { this.selected = null; this.render(); },
        }));
      bar.append(what, how, acts);
      root.append(bar);
    }

    root.append(this.buildGrid());
    root.append(this.legend());

    if (rt?.editable) {
      const wrap = d.createElement('div');
      wrap.className = 'editor-actions';
      const pub = d.createElement('button');
      pub.type = 'button';
      pub.className = 'btn-primary';
      pub.textContent = 'প্রকাশ করুন';
      pub.disabled = this.busy;
      pub.addEventListener('click', () => { void this.publish(); });
      wrap.append(pub);
      root.append(wrap);
    }
  }

  /* ------------------------------------------------------------ drawers */

  /** Name the routine, and create the draft the grid hangs off. */
  private openCreate(setup: Setup): void {
    const d = this.o.doc;
    const form = el(d, 'div', { className: 'ui-fieldset' });
    const errLine = el(d, 'p', {
      className: 'ui-field-error', attrs: { role: 'alert', hidden: 'hidden' },
    });
    const name = field(d, {
      label: 'রুটিনের নাম', name: 'nameBn', required: true,
      value: `নিয়মিত রুটিন ${setup.yearLabel}`,
      helper: `${SHIFT_BN[setup.shift] ?? setup.shift} শিফট · ঘণ্টার সময়সূচি: ${setup.periodTemplateName ?? '—'}`,
      attrs: { maxlength: 120 },
    });
    append(form, errLine, name.root);
    append(form, el(d, 'p', {
      className: 'att-sub',
      text: 'খসড়া হিসেবে তৈরি হবে। ক্লাস বসানো শেষ হলে প্রকাশ করতে পারবেন।',
    }));

    let handle: OverlayHandle;
    const cancel = button(d, {
      label: 'বাতিল', variant: 'secondary', onClick: () => handle.close(),
    });
    const save = button(d, {
      label: 'তৈরি করুন', variant: 'primary',
      onClick: async () => {
        errLine.setAttribute('hidden', 'hidden');
        setBusy(save, true);
        const msg = await this.send({
          action: 'create-routine', sectionId: this.grid?.sectionId, nameBn: name.input.value.trim(),
        });
        setBusy(save, false);
        if (msg) {
          errLine.textContent = msg;
          errLine.removeAttribute('hidden');
          announce(d, msg, true);
          return;
        }
        handle.close();
        await this.loadGrid(this.grid!.sectionId);
        this.notice = { text: 'রুটিন তৈরি হয়েছে — এখন ক্লাস বসান।', tone: 'ok' };
        this.render();
      },
    });
    handle = openDrawer(d, { title: 'নতুন রুটিন', body: form, actions: [cancel, save] });
  }

  /**
   * Place a lesson in an empty cell, or change the one already there.
   *
   * The teacher list narrows to the people actually assigned to teach the
   * chosen subject in THIS section — `section_subject_teachers` — so the form
   * cannot propose a timetable the school never staffed.
   */
  private openLesson(existing: Slot | null, dow?: number, periodNo?: number): void {
    const d = this.o.doc;
    const g = this.grid;
    if (!g?.routine) return;
    const subjects = g.subjects ?? [];
    const allTeachers = g.teachers ?? [];
    const rooms = g.rooms ?? [];

    const form = el(d, 'div', { className: 'ui-fieldset' });
    const errLine = el(d, 'p', {
      className: 'ui-field-error', attrs: { role: 'alert', hidden: 'hidden' },
    });
    append(form, errLine);

    if (subjects.length === 0) {
      append(form, el(d, 'p', {
        className: 'att-sub',
        text: 'এই শ্রেণির পাঠ্যসূচিতে কোনো বিষয় নেই — আগে বিষয় নির্ধারণ করুন।',
      }));
    }

    // Reconstruct the current subject from its Bangla name: the grid payload
    // carries names for display, not ids, and widening it is a server change
    // this screen does not need.
    const currentSubject = existing
      ? subjects.find((x) => x.nameBn === existing.subjectBn)?.id ?? ''
      : '';

    const subject = field(d, {
      label: 'বিষয়', name: 'subjectId', kind: 'select', required: true,
      value: currentSubject,
      options: subjects.map((x) => ({ value: x.id, label: x.nameBn })),
    });
    const teacher = field(d, {
      label: 'শিক্ষক', name: 'teacherId', kind: 'select', required: true,
      options: [], helper: 'কেবল এই সেকশনে এই বিষয়ের জন্য দায়িত্বপ্রাপ্ত শিক্ষক।',
    });
    const room = field(d, {
      label: 'কক্ষ', name: 'roomId', kind: 'select',
      options: [{ value: '', label: 'নির্দিষ্ট নয়' },
        ...rooms.map((r) => ({ value: r.id, label: r.label }))],
      helper: 'ঐচ্ছিক।',
    });

    const fillTeachers = (): void => {
      const sel = teacher.input as HTMLSelectElement;
      const chosen = subject.input.value;
      const opts = allTeachers.filter((t) => t.subjectId === chosen);
      sel.textContent = '';
      for (const t of opts) {
        const o = d.createElement('option');
        o.value = t.id;
        o.textContent = t.nameBn;
        sel.append(o);
      }
      if (opts.length === 0) {
        const o = d.createElement('option');
        o.value = '';
        o.textContent = 'এই বিষয়ে কোনো শিক্ষক নিযুক্ত নন';
        sel.append(o);
      }
      const match = opts.find((t) => t.nameBn === existing?.teacherName);
      if (match) sel.value = match.id;
    };
    subject.input.addEventListener('change', fillTeachers);
    fillTeachers();

    if (existing?.roomName) {
      const r = rooms.find((x) => x.label === existing.roomName);
      if (r) (room.input as HTMLSelectElement).value = r.id;
    }
    append(form, subject.root, teacher.root, room.root);

    let handle: OverlayHandle;
    const cancel = button(d, {
      label: 'বাতিল', variant: 'secondary', onClick: () => handle.close(),
    });
    const save = button(d, {
      label: existing ? 'সংরক্ষণ করুন' : 'বসান', variant: 'primary',
      onClick: async () => {
        errLine.setAttribute('hidden', 'hidden');
        setBusy(save, true);
        const roomId = (room.input as HTMLSelectElement).value || null;
        const msg = existing
          ? await this.send({
            action: 'assign', slotId: existing.id,
            subjectId: subject.input.value, teacherId: teacher.input.value, roomId,
          })
          : await this.send({
            action: 'place', routineId: g.routine!.id, sectionId: g.sectionId,
            dayOfWeek: dow, periodNo,
            subjectId: subject.input.value, teacherId: teacher.input.value, roomId,
          });
        setBusy(save, false);
        // The drawer stays open on a refusal and the typed choices survive, so
        // a coordinator told "রফিক ইসলাম তখন নবম-খ-তে গণিত পড়াচ্ছেন" can pick a
        // different teacher without rebuilding the form (B-60).
        if (msg) {
          errLine.textContent = msg;
          errLine.removeAttribute('hidden');
          announce(d, msg, true);
          return;
        }
        handle.close();
        this.selected = null;
        await this.loadGrid(g.sectionId);
        this.notice = { text: existing ? 'হালনাগাদ হয়েছে।' : 'ক্লাস বসানো হয়েছে।', tone: 'ok' };
        this.render();
      },
    });
    handle = openDrawer(d, {
      title: existing ? 'ক্লাস সম্পাদনা' : 'ক্লাস বসান',
      body: form,
      actions: [cancel, save],
    });
  }

  private confirmRemove(slot: Slot): void {
    confirmOverlay(this.o.doc, {
      title: `${slot.subjectBn ?? 'ক্লাস'} সরাবেন?`,
      // A soft delete: routine_slots.status becomes 'removed', the row stays.
      body: 'ঘরটি খালি হয়ে যাবে এবং ওই সময়ে অন্য ক্লাস বসানো যাবে। '
        + 'রেকর্ড মুছে যাবে না — কী ছিল তা সংরক্ষিত থাকবে।',
      confirmLabel: 'সরান',
      danger: true,
      onConfirm: async () => {
        const msg = await this.send({ action: 'remove', slotId: slot.id });
        this.selected = null;
        await this.loadGrid(this.grid!.sectionId);
        this.notice = msg ? { text: msg, tone: 'warn' } : { text: 'সরানো হয়েছে।', tone: 'ok' };
        this.render();
      },
    });
  }

  private buildGrid(): HTMLElement {
    const d = this.o.doc;
    const grid = this.grid!;
    const scroll = d.createElement('div');
    // §11: horizontally scrollable with a frozen first column — six columns
    // do not fit 360px, and the period is the one thing that must stay in
    // view while the rest scrolls.
    scroll.className = 'table-scroll';
    const table = d.createElement('table');
    table.className = 'data-table routine-grid';

    const thead = d.createElement('thead');
    const hr = d.createElement('tr');
    const corner = d.createElement('th');
    corner.textContent = 'পিরিয়ড';
    hr.append(corner);
    for (const day of this.days()) {
      const th = d.createElement('th');
      th.textContent = day.bn;
      hr.append(th);
    }
    thead.append(hr);
    table.append(thead);

    const tbody = d.createElement('tbody');
    for (const p of grid.periods) {
      const tr = d.createElement('tr');
      const rowHead = d.createElement('th');
      rowHead.className = 'routine-period';
      const no = d.createElement('span');
      no.className = 'routine-period-no';
      no.textContent = formatCount(p.periodNo, 'bn');
      const time = d.createElement('span');
      time.className = 'routine-period-time';
      time.textContent = p.startsAt;
      rowHead.append(no, time);
      tr.append(rowHead);

      if (p.kind !== 'teaching') {
        // The break spans the week as one band, exactly as §8.1 draws it.
        const td = d.createElement('td');
        td.className = 'routine-break';
        td.colSpan = this.days().length;
        td.textContent = p.labelBn;
        tr.append(td);
        tbody.append(tr);
        continue;
      }

      for (const day of this.days()) {
        tr.append(this.buildCell(day.dow, p));
      }
      tbody.append(tr);
    }
    table.append(tbody);
    scroll.append(table);
    return scroll;
  }

  private buildCell(dow: number, p: Period): HTMLElement {
    const d = this.o.doc;
    const td = d.createElement('td');
    td.className = 'routine-cell';
    const slot = this.slotAt(dow, p.periodNo);
    const dayBn = this.days().find((x) => x.dow === dow)?.bn ?? '';

    const btn = d.createElement('button');
    btn.type = 'button';
    btn.className = 'routine-slot';
    btn.disabled = !this.grid?.routine?.editable || this.busy;

    if (slot) {
      btn.dataset.filled = 'true';
      btn.dataset.selected = String(this.selected === slot.id);
      btn.setAttribute('aria-pressed', String(this.selected === slot.id));
      if (slot.isPinned) btn.dataset.pinned = 'true';

      const subject = d.createElement('span');
      subject.className = 'routine-slot-subject';
      subject.textContent = slot.subjectBn ?? '—';
      // The wireframe's own legend marks: fork = parallel block (religion or
      // optional-subject split), joined squares = double period.
      if (slot.parallelPool) subject.append(this.mark('⑂', 'সমান্তরাল ব্লক'));
      if (slot.isDouble || slot.doubleGroupId) subject.append(this.mark('⧉', 'দ্বৈত পিরিয়ড'));

      const teacher = d.createElement('span');
      teacher.className = 'routine-slot-meta';
      teacher.textContent = slot.teacherName ?? 'শিক্ষক নেই';
      if (!slot.teacherName) teacher.dataset.missing = 'true';

      const room = d.createElement('span');
      room.className = 'routine-slot-meta';
      room.textContent = slot.roomName ?? '';

      btn.append(subject, teacher, room);
      btn.setAttribute('aria-label',
        `${dayBn}, পিরিয়ড ${formatCount(p.periodNo, 'bn')}, ${slot.subjectBn ?? 'ক্লাস'}`
        + (slot.teacherName ? `, ${slot.teacherName}` : ''));
      btn.addEventListener('click', () => this.pick(slot));
    } else {
      btn.dataset.filled = 'false';
      const empty = d.createElement('span');
      empty.className = 'routine-slot-empty';
      // Plain words, not a warning glyph: an empty period is a fact the
      // coordinator is working ON, not an error being reported AT them.
      empty.textContent = 'খালি';
      btn.append(empty);
      btn.setAttribute('aria-label',
        `${dayBn}, পিরিয়ড ${formatCount(p.periodNo, 'bn')}, খালি`
        + (this.selected ? ' — এখানে বসাতে চাপ দিন' : ' — নতুন ক্লাস বসাতে চাপ দিন'));
      // Holding a class makes this a drop target. Holding nothing, it is now
      // where a NEW lesson is placed — until A4 an empty cell was inert,
      // because nothing in the product could create a slot to put in it.
      if (this.selected) {
        btn.dataset.target = 'true';
        btn.addEventListener('click', () => { void this.place(dow, p.periodNo); });
      } else {
        btn.addEventListener('click', () => this.openLesson(null, dow, p.periodNo));
      }
    }
    td.append(btn);
    return td;
  }

  private mark(glyph: string, label: string): HTMLElement {
    const s = this.o.doc.createElement('span');
    s.className = 'routine-mark';
    s.textContent = glyph;
    s.title = label;                      // hover / long-press
    s.setAttribute('aria-label', label);  // and said aloud, not just drawn
    return s;
  }

  private legend(): HTMLElement {
    const d = this.o.doc;
    const wrap = d.createElement('div');
    wrap.className = 'att-legend';
    for (const [glyph, label] of [['⑂', 'সমান্তরাল ব্লক'], ['⧉', 'দ্বৈত পিরিয়ড']] as const) {
      const item = d.createElement('span');
      item.className = 'att-legend-item';
      const g = d.createElement('span');
      g.className = 'att-legend-glyph';
      g.textContent = glyph;
      const l = d.createElement('span');
      l.textContent = label;
      item.append(g, l);
      wrap.append(item);
    }
    return wrap;
  }

  private msg(text: string): HTMLElement {
    const p = this.o.doc.createElement('p');
    p.className = 'page-sub empty';
    p.textContent = text;
    return p;
  }
}
