/**
 * Group & optional-subject selection — F-305 / F-304, wireframe §10.3.
 *
 * The input to the subject-based model. Every other academic screen reads
 * what this one writes: "আমার বিষয়" lists it, the exam-routine clash check
 * (§8.3) only finds anything because two students in one section hold
 * different optional subjects, and the routine's parallel blocks exist to
 * timetable exactly these choices.
 *
 * ── Derived is read-only; only the pools are choices ─────────────────────
 * §10.3: "Compulsory subjects are derived and shown read-only — the
 * coordinator never types them." So the compulsory list here is text, not
 * controls — there is nothing to click, because there is no decision to
 * make. The two genuine decisions are the religion variant and the fourth
 * subject, and each is rendered as the template's own pool, so a coordinator
 * cannot pick something this class does not offer. The server re-checks the
 * same bound; this screen is not the enforcement.
 *
 * ── The warning is the feature ───────────────────────────────────────────
 * §10.3 calls the regeneration warning mandatory, and it is the reason this
 * screen has a confirm step at all. Changing a fourth subject silently
 * re-cuts the student's timetable and invalidates their content assignments.
 * A coordinator who taps a dropdown and walks away has to be told that, in
 * words, before anything is written — so the save is two deliberate steps
 * and the second one restates the consequence.
 */
import type { Auth } from './auth.ts';
import { emptyState } from './view-states.ts';
import { pageHeader, card, field, listSkeleton, el } from './ui/index.ts';
import { formatCount } from '../../../packages/ui-core/src/format.ts';

interface Option { subjectId: string; nameBn: string; variant?: string | null }
interface Choice {
  student: {
    id: string; nameBn: string; rollNo: number;
    classBn: string; sectionName: string; groupCode: string;
  };
  hasTemplate: boolean;
  derived: Array<{ subjectId: string; nameBn: string; requirementType: string }>;
  religionOptions: Option[];
  optionalOptions: Option[];
  current: {
    religionVariant: string | null;
    religionSubjectId: string | null;
    optionalSubjectId: string | null;
  };
}

export interface SubjectChoiceViewOptions {
  root: HTMLElement;
  doc: Document;
  auth: Auth;
}

const GROUP_BN: Record<string, string> = {
  science: 'বিজ্ঞান', humanities: 'মানবিক', business_studies: 'ব্যবসায় শিক্ষা',
  arts: 'কলা', none: 'সাধারণ',
};

export class SubjectChoiceView {
  private readonly o: SubjectChoiceViewOptions;
  private students: Array<{ studentId: string; rollNo: number; nameBn: string }> = [];
  private studentId: string | null = null;
  private data: Choice | null = null;
  private draftReligion: string | null = null;
  private draftOptional: string | null = null;
  private confirming = false;
  private notice: { text: string; tone: 'warn' | 'ok' } | null = null;
  private loading = true;
  private busy = false;

  constructor(options: SubjectChoiceViewOptions) {
    this.o = options;
    void this.init();
  }

  private async init(): Promise<void> {
    this.render();
    // The roster this screen works through is the one the coordinator was
    // last looking at, same as marks entry — "pick your section first".
    const sectionId = localStorage.getItem('shikhon_last_section');
    if (sectionId) {
      try {
        const res = await this.o.auth.authedFetch(
          `/api/v1/academics/roster?sectionId=${encodeURIComponent(sectionId)}`);
        if (res.ok) {
          const body = (await res.json()) as {
            roster: Array<{ studentId: string; rollNo: number; fullName: { bn?: string; en?: string } }>;
          };
          this.students = body.roster.map((r) => ({
            studentId: r.studentId, rollNo: r.rollNo,
            nameBn: r.fullName.bn ?? r.fullName.en ?? `রোল ${r.rollNo}`,
          }));
          if (this.students[0]) this.studentId = this.students[0].studentId;
        }
      } catch { /* offline: the screen says it needs a connection */ }
    }
    if (this.studentId) await this.loadChoice(this.studentId);
    else { this.loading = false; this.render(); }
  }

  private async loadChoice(studentId: string): Promise<void> {
    this.loading = true;
    this.confirming = false;
    this.notice = null;
    this.render();
    try {
      const res = await this.o.auth.authedFetch(
        `/api/v1/academics/subjectchoice?studentId=${encodeURIComponent(studentId)}`);
      if (!res.ok) throw new Error(String(res.status));
      this.data = (await res.json()) as Choice;
      this.draftReligion = this.data.current.religionVariant;
      this.draftOptional = this.data.current.optionalSubjectId;
    } catch {
      this.data = null;
      this.notice = { text: 'তথ্য লোড হয়নি — সংযোগ দেখে আবার চেষ্টা করুন।', tone: 'warn' };
    }
    this.loading = false;
    this.render();
  }

  /** Nothing to confirm if nothing moved. */
  private get dirty(): boolean {
    if (!this.data) return false;
    return this.draftReligion !== this.data.current.religionVariant
        || this.draftOptional !== this.data.current.optionalSubjectId;
  }

  private async save(): Promise<void> {
    if (!this.data || this.busy) return;
    this.busy = true; this.render();
    try {
      const res = await this.o.auth.authedFetch('/api/v1/academics/subjectchoice', {
        method: 'POST',
        body: JSON.stringify({
          studentId: this.data.student.id,
          religionVariant: this.draftReligion,
          optionalSubjectId: this.draftOptional,
        }),
      });
      const body = (await res.json().catch(() => ({}))) as
        { ok?: boolean; message?: string; subjectCount?: number };
      if (res.ok && body.ok) {
        this.busy = false;
        await this.loadChoice(this.data.student.id);
        this.notice = {
          text: `সংরক্ষিত — এখন ${formatCount(body.subjectCount ?? 0, 'bn')}টি বিষয়। `
              + 'রুটিন ও পাঠ বরাদ্দ নতুন করে তৈরি করতে হবে।',
          tone: 'ok',
        };
        this.render();
        return;
      }
      this.notice = { text: body.message ?? 'সংরক্ষণ করা যায়নি।', tone: 'warn' };
    } catch {
      this.notice = { text: 'সংযোগ নেই — পরিবর্তন সংরক্ষণ হয়নি।', tone: 'warn' };
    }
    this.busy = false; this.confirming = false;
    this.render();
  }

  /* ------------------------------------------------------------- render */

  private render(): void {
    const d = this.o.doc;
    const root = this.o.root;
    root.textContent = '';
    root.setAttribute('lang', 'bn');

    root.append(pageHeader(d, {
      title: 'বিভাগ ও বিষয় নির্বাচন',
      subtitle: this.data
        ? `${this.data.student.classBn}-${this.data.student.sectionName} · `
          + `রোল ${formatCount(this.data.student.rollNo, 'bn')}`
        : 'ধর্ম শিক্ষা ও চতুর্থ বিষয় নির্ধারণ',
    }));

    if (this.students.length > 0) {
      // A labelled control. It had an `aria-label` only — so a coordinator
      // working down a class of forty saw a bare dropdown and had to open it
      // to learn what it chose.
      root.append(field(d, {
        label: 'শিক্ষার্থী',
        name: 'student',
        kind: 'select',
        value: this.studentId ?? '',
        // Roll first: it is the order the register is in and the order a
        // coordinator works down.
        options: this.students.map((st) => ({
          value: st.studentId,
          label: `${formatCount(st.rollNo, 'bn')} · ${st.nameBn}`,
        })),
        onChange: (v) => { this.studentId = v; void this.loadChoice(v); },
      }).root);
    }

    if (this.notice) {
      const n = d.createElement('p');
      n.className = this.notice.tone === 'warn' ? 'inline-notice is-danger' : 'inline-notice';
      n.setAttribute('role', 'status');
      n.textContent = this.notice.text;
      root.append(n);
    }

    if (this.loading) { root.append(listSkeleton(d, 4)); return; }
    if (!this.data) {
      if (this.students.length === 0) {
        root.append(emptyState(d, {
          glyph: 'users',
          message: 'আগে শিক্ষার্থী তালিকা থেকে একটি সেকশন নির্বাচন করুন — '
            + 'তারপর সেই শাখার শিক্ষার্থীদের বিষয় নির্ধারণ করা যাবে।',
          action: { label: 'শিক্ষার্থী তালিকা', onClick: () => { location.hash = '/roster'; } },
        }));
      }
      return;
    }
    if (!this.data.hasTemplate) {
      root.append(emptyState(d, {
        glyph: 'layers',
        message: 'এই শ্রেণির জন্য বিষয়-টেমপ্লেট তৈরি হয়নি। আগে টেমপ্লেট তৈরি করুন।',
      }));
      return;
    }

    root.append(this.groupBlock());
    root.append(this.derivedBlock());
    if (this.data.religionOptions.length > 0) {
      root.append(this.poolBlock('ধর্ম শিক্ষা', this.data.religionOptions, 'religion'));
    }
    if (this.data.optionalOptions.length > 0) {
      root.append(this.poolBlock('চতুর্থ বিষয় (একটি বেছে নিন)', this.data.optionalOptions, 'optional'));
    }
    root.append(this.footer());
  }

  /** The group is reported, not offered — see the endpoint's header. */
  private groupBlock(): HTMLElement {
    const d = this.o.doc;
    return card(d, { title: 'বিভাগ', glyph: 'layers', headingLevel: 2 },
      el(d, 'p', {
        className: 'ui-card-lead',
        text: GROUP_BN[this.data!.student.groupCode] ?? this.data!.student.groupCode,
      }),
      // Honest about where the control actually lives, rather than showing a
      // dropdown that would quietly mean "re-enrol this child".
      el(d, 'p', {
        className: 'ui-card-note',
        text: 'বিভাগ নির্ধারিত হয় শাখা অনুযায়ী। বিভাগ বদলাতে শিক্ষার্থীকে '
          + 'অন্য শাখায় স্থানান্তর করতে হবে।',
      }));
  }

  private derivedBlock(): HTMLElement {
    const d = this.o.doc;
    // Text, not controls: there is no decision here, so there is nothing to
    // press. §10.3 — "the coordinator never types them".
    return card(d, {
      title: 'আবশ্যিক বিষয়', subtitle: 'টেমপ্লেট থেকে স্বয়ংক্রিয়ভাবে নির্ধারিত',
      glyph: 'book-open', headingLevel: 2,
    },
      this.data!.derived.length === 0
        ? el(d, 'p', { className: 'ui-card-note', text: 'এখনো নির্ধারিত হয়নি।' })
        : el(d, 'p', {
            className: 'choice-derived',
            text: this.data!.derived.map((sub) => sub.nameBn).join(' · '),
          }));
  }

  private poolBlock(title: string, options: Option[], kind: 'religion' | 'optional'): HTMLElement {
    const d = this.o.doc;
    const box = card(d, { title, glyph: 'layers', headingLevel: 2 });

    const group = d.createElement('div');
    group.className = 'choice-options';
    group.setAttribute('role', 'radiogroup');
    group.setAttribute('aria-label', title);

    for (const opt of options) {
      const value = kind === 'religion' ? (opt.variant ?? '') : opt.subjectId;
      const chosen = kind === 'religion'
        ? this.draftReligion === value
        : this.draftOptional === value;
      const btn = d.createElement('button');
      btn.type = 'button';
      btn.className = 'choice-option';
      btn.dataset.chosen = String(chosen);
      btn.setAttribute('role', 'radio');
      btn.setAttribute('aria-checked', String(chosen));
      btn.textContent = opt.nameBn;
      btn.disabled = this.busy;
      btn.addEventListener('click', () => {
        // Tapping the chosen one clears it — a fourth subject can be removed,
        // and a control with no way back is a trap.
        if (kind === 'religion') this.draftReligion = chosen ? null : value;
        else this.draftOptional = chosen ? null : value;
        this.confirming = false;
        this.notice = null;
        this.render();
      });
      group.append(btn);
    }
    box.append(group);
    return box;
  }

  private footer(): HTMLElement {
    const d = this.o.doc;
    const wrap = d.createElement('div');
    wrap.className = 'choice-footer';

    if (!this.dirty) {
      const p = d.createElement('p');
      p.className = 'choice-note';
      p.textContent = 'কোনো পরিবর্তন করা হয়নি।';
      wrap.append(p);
      return wrap;
    }

    if (!this.confirming) {
      const go = d.createElement('button');
      go.type = 'button';
      go.className = 'btn-primary';
      go.textContent = 'পরিবর্তন সংরক্ষণ করুন';
      go.disabled = this.busy;
      go.addEventListener('click', () => { this.confirming = true; this.render(); });
      wrap.append(go);
      return wrap;
    }

    // §10.3: "The regeneration warning is mandatory." It is shown BEFORE the
    // write, states the two things that go stale, and requires a second
    // deliberate press — the whole reason this screen confirms at all.
    const warn = d.createElement('div');
    warn.className = 'inline-notice is-danger choice-warning';
    warn.setAttribute('role', 'alert');
    warn.textContent =
      'এই পরিবর্তনে এই শিক্ষার্থীর বিষয় বরাদ্দ নতুন করে তৈরি হবে, '
      + 'এবং তার রুটিন ও পাঠ বরাদ্দ পুরোনো হয়ে যাবে — নতুন করে তৈরি করতে হবে।';
    const row = d.createElement('div');
    row.className = 'choice-confirm-row';
    const confirm = d.createElement('button');
    confirm.type = 'button';
    confirm.className = 'btn-primary';
    confirm.textContent = 'নিশ্চিত করুন';
    confirm.disabled = this.busy;
    confirm.addEventListener('click', () => { void this.save(); });
    const cancel = d.createElement('button');
    cancel.type = 'button';
    cancel.className = 'btn-secondary';
    cancel.textContent = 'বাতিল';
    cancel.disabled = this.busy;
    cancel.addEventListener('click', () => { this.confirming = false; this.render(); });
    row.append(confirm, cancel);
    wrap.append(warn, row);
    return wrap;
  }

  private msg(text: string): HTMLElement {
    const p = this.o.doc.createElement('p');
    p.className = 'page-sub empty';
    p.textContent = text;
    return p;
  }
}
