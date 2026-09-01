/**
 * একাডেমিক কাঠামো — the drill-down, and everything done from inside it
 * (R-3, Parts C, D, E, L and M)
 *
 *     শিক্ষাবর্ষ → শ্রেণি ৯ → বিজ্ঞান → সেকশন F → ৪০ জন শিক্ষার্থী
 *
 * ── One screen, four depths, because they are one thought ──────────────
 * Assigning a teacher, moving students and reading a student's history are not
 * separate destinations a person navigates to and then re-selects the section
 * in. They are things you do while looking at a section. Splitting them into
 * routes would mean re-choosing Class 9 → Science → F three times to do three
 * things to the same forty children.
 *
 * ── The tree is fetched once ───────────────────────────────────────────
 * `/hierarchy` returns the whole structure with counts. Drilling in and back
 * out is then instant and works from the service worker's cache — which is the
 * behaviour a head teacher standing in a corridor on 2G actually experiences.
 * Only opening a section costs a request, because only then do names load.
 *
 * ── Replacement asks why, and says what it will keep ───────────────────
 * The confirmation names the outgoing teacher and states that their record
 * stays. That sentence is the visible half of migration 041: a school that
 * believes a replacement erases the old teacher will avoid recording
 * replacements at all, and then the register and the truth diverge quietly.
 */
import type { Auth } from './auth.ts';
import { iconSvg } from './icon.ts';
import {
  skeleton, errorState, emptyState, successNote, confirmDialog, bnNum, bnDate,
} from './view-states.ts';
import {
  structureForm, createdNote, type StructureOptions, type StructureKind,
} from './structure-forms.ts';
import { openRename } from './structure-edit.ts';
import { GuardianPanel } from './guardian-panel.ts';

// ── Shapes returned by /api/v1/academics/hierarchy ──────────────────────

interface TreeSection {
  id: string; name: string; shift: string; capacity: number;
  studentCount: number;
  classTeacher: { id: string; nameBn: string } | null;
  subjectTeacherCount: number;
}
interface TreeGroup {
  classId: string; group: string; groupBn: string;
  sectionCount: number; studentCount: number; sections: TreeSection[];
}
interface TreeLevel {
  levelNo: number; nameBn: string; nameEn: string;
  sectionCount: number; studentCount: number; groups: TreeGroup[];
}
interface Tree {
  years: { id: string; label: string; isCurrent: boolean }[];
  year: { id: string; label: string } | null;
  classes: TreeLevel[];
}

interface SectionDetail {
  section: {
    id: string; name: string; shift: string; capacity: number; studentCount: number;
    classId: string; levelNo: number; classNameBn: string; groupBn: string;
    yearId: string; yearLabel: string;
  };
  classTeacher: { id: string; nameBn: string; since: string | null } | null;
  subjectTeachers: {
    assignmentId: string;
    subject: { id: string; nameBn: string; nameEn: string };
    teacher: { id: string; nameBn: string };
    startedOn: string;
  }[];
  unassignedSubjects: { id: string; nameBn: string }[];
  roster: { studentId: string; rollNo: number; nameBn: string; studentCode: string; status: string }[];
  history: {
    kind: string; subjectBn: string | null; teacherBn: string;
    startedOn: string; endedOn: string; endReason: string;
  }[];
}

interface StudentDetail {
  student: {
    id: string; nameBn: string; nameEn: string | null; studentCode: string | null;
    admissionDate: string | null; lifecycleStatus: string | null;
    bloodGroup: string | null; status: string;
  };
  current: {
    yearLabel: string; levelNo: number; classBn: string; groupBn: string;
    section: string; rollNo: number; status: string;
  } | null;
  history: {
    yearLabel: string; levelNo: number; classBn: string; groupBn: string;
    section: string; rollNo: number; status: string; enrolledOn: string; endedOn: string | null;
  }[];
  guardians: { nameBn: string; relation: string; isPrimary: boolean; canPayFees: boolean }[];
  attendance90d: { present: number; total: number };
}

interface Candidates {
  subjects: { id: string; nameBn: string; assigned: { id: string; nameBn: string } | null }[];
  teachers: {
    id: string; nameBn: string; employeeCode: string | null;
    currentLoad: number; expertiseSubjectIds: string[];
  }[];
}

export interface AcademicViewOptions {
  root: HTMLElement;
  doc: Document;
  auth: Auth;
  /** Whether this caller may change structure. Advisory: the server decides. */
  canManage: boolean;
  /**
   * Narrower than canManage: who may pay a child's fees is a statement about
   * a family, so coordinators are excluded. Mirrors guardianship_insert_scope
   * in migration 042.
   */
  canManageGuardians: boolean;
}

type Depth =
  | { at: 'tree' }
  | { at: 'level'; levelNo: number }
  | { at: 'section'; sectionId: string }
  | { at: 'student'; sectionId: string; studentId: string };

export class AcademicView {
  private readonly o: AcademicViewOptions;
  private tree: Tree | null = null;
  private detail: SectionDetail | null = null;
  private student: StudentDetail | null = null;
  private candidates: Candidates | null = null;

  private depth: Depth = { at: 'tree' };
  private loading = true;
  private error = '';
  private notice = '';
  /** Which panel is open inside a section: assignment, bulk move, or neither. */
  private panel: 'none' | 'assign' | 'move' = 'none';
  /** R-3 completion: which create form is open, if any. */
  private creating: StructureKind | null = null;
  private structureOptions: StructureOptions | null = null;
  private selected = new Set<string>();
  private busy = false;
  private created: Record<string, unknown> | null = null;

  constructor(options: AcademicViewOptions) {
    this.o = options;
    this.render();
    void this.loadTree();
  }

  // ── loading ───────────────────────────────────────────────────────────

  private async loadTree(): Promise<void> {
    this.loading = true; this.error = ''; this.render();
    try {
      const res = await this.o.auth.authedFetch('/api/v1/academics/hierarchy');
      if (res.status === 403) { this.error = 'এই পাতা দেখার অনুমতি নেই।'; return; }
      if (!res.ok) throw new Error(String(res.status));
      this.tree = (await res.json()) as Tree;
    } catch {
      this.error = 'কাঠামো আনা যায়নি — সংযোগ পেলে আবার দেখা যাবে।';
    } finally {
      this.loading = false; this.render();
    }
  }

  private async openSection(sectionId: string): Promise<void> {
    this.depth = { at: 'section', sectionId };
    this.panel = 'none'; this.selected.clear();
    this.loading = true; this.error = ''; this.detail = null; this.render();
    try {
      const res = await this.o.auth.authedFetch(
        `/api/v1/academics/hierarchy?sectionId=${encodeURIComponent(sectionId)}`);
      if (!res.ok) throw new Error(String(res.status));
      this.detail = (await res.json()) as SectionDetail;
    } catch {
      this.error = 'সেকশনের তথ্য আনা যায়নি।';
    } finally {
      this.loading = false; this.render();
    }
  }

  private async openStudent(studentId: string): Promise<void> {
    const sectionId = this.depth.at === 'section' || this.depth.at === 'student'
      ? this.depth.sectionId : '';
    this.depth = { at: 'student', sectionId, studentId };
    this.loading = true; this.error = ''; this.student = null; this.render();
    try {
      const res = await this.o.auth.authedFetch(
        `/api/v1/academics/hierarchy?studentId=${encodeURIComponent(studentId)}`);
      if (!res.ok) throw new Error(String(res.status));
      this.student = (await res.json()) as StudentDetail;
    } catch {
      this.error = 'শিক্ষার্থীর তথ্য আনা যায়নি।';
    } finally {
      this.loading = false; this.render();
    }
  }

  /**
   * The lists a create form needs. Fetched lazily, on the first time a form
   * is opened, rather than with the tree: most visits to this screen are
   * navigation, and the options only matter to the four roles that may
   * create anything.
   */
  private async loadStructureOptions(): Promise<void> {
    try {
      const res = await this.o.auth.authedFetch('/api/v1/ops/structure');
      if (!res.ok) throw new Error(String(res.status));
      this.structureOptions = (await res.json()) as StructureOptions;
    } catch {
      this.error = 'তালিকা আনা যায়নি — সংযোগ দেখুন।';
    } finally {
      this.render();
    }
  }

  private async submitStructure(payload: Record<string, unknown>): Promise<void> {
    this.busy = true; this.error = ''; this.render();
    try {
      const res = await this.o.auth.authedFetch('/api/v1/ops/structure', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const body = await res.json() as {
        kind?: string; label?: string; nameBn?: string; name?: string;
        classNameBn?: string; message?: string;
      };
      if (!res.ok) { this.error = body.message ?? 'তৈরি করা যায়নি।'; return; }
      this.created = body;
      this.creating = null;
      // The options list is now stale — the new class must be selectable as a
      // section's parent immediately.
      this.structureOptions = null;
      await this.loadTree();
      if (this.depth.at === 'level') this.render();
    } catch {
      this.error = 'সংযোগ নেই — তৈরি করা যায়নি।';
    } finally {
      this.busy = false; this.render();
    }
  }

  private async loadCandidates(sectionId: string): Promise<void> {
    try {
      const res = await this.o.auth.authedFetch(
        `/api/v1/ops/assign?sectionId=${encodeURIComponent(sectionId)}`);
      if (!res.ok) throw new Error(String(res.status));
      this.candidates = (await res.json()) as Candidates;
    } catch {
      this.error = 'শিক্ষকের তালিকা আনা যায়নি।';
    } finally {
      this.render();
    }
  }

  // ── mutations ─────────────────────────────────────────────────────────

  private async submitAssign(
    sectionId: string, subjectId: string | null, teacherId: string,
    effectiveDate: string, reason: string,
  ): Promise<void> {
    this.busy = true; this.render();
    try {
      const res = await this.o.auth.authedFetch('/api/v1/ops/assign', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sectionId, subjectId, teacherId, effectiveDate, reason }),
      });
      const body = await res.json() as {
        replaced?: { nameBn: string } | null; unchanged?: boolean;
        teacher?: { nameBn: string }; message?: string;
      };
      if (!res.ok) { this.error = body.message ?? 'নির্ধারণ করা যায়নি।'; return; }
      this.error = '';
      this.notice = body.unchanged
        ? 'ইনি ইতিমধ্যে এই দায়িত্বে ছিলেন — কিছু পরিবর্তন হয়নি।'
        : body.replaced
          ? `${body.replaced.nameBn}-এর পরিবর্তে ${body.teacher?.nameBn} নির্ধারিত হয়েছেন। আগের রেকর্ড রয়ে গেছে।`
          : `${body.teacher?.nameBn} নির্ধারিত হয়েছেন।`;
      this.panel = 'none';
      await this.openSection(sectionId);
    } catch {
      this.error = 'সংযোগ নেই — নির্ধারণ করা যায়নি।';
    } finally {
      this.busy = false; this.render();
    }
  }

  private async submitMove(sectionId: string, dryRun: boolean): Promise<void> {
    this.busy = true; this.render();
    try {
      const res = await this.o.auth.authedFetch('/api/v1/ops/enrol', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sectionId, studentIds: [...this.selected], dryRun }),
      });
      const body = await res.json() as {
        moving?: { studentId: string; nameBn: string; toRollNo: number }[];
        committed?: boolean; overCapacity?: boolean; message?: string;
        section?: { countAfter: number; capacity: number };
      };
      if (!res.ok) { this.error = body.message ?? 'স্থানান্তর করা যায়নি।'; return; }
      this.error = '';
      if (body.committed) {
        this.notice = `${bnNum(body.moving?.length ?? 0)} জন শিক্ষার্থী স্থানান্তরিত হয়েছে।`;
        this.selected.clear(); this.panel = 'none';
        await this.openSection(sectionId);
      }
    } catch {
      this.error = 'সংযোগ নেই — স্থানান্তর করা যায়নি।';
    } finally {
      this.busy = false; this.render();
    }
  }

  // ── rendering ─────────────────────────────────────────────────────────

  private render(): void {
    const d = this.o.doc;
    const root = this.o.root;
    root.textContent = '';

    root.append(this.header());
    if (this.notice) root.append(successNote(d, this.notice));
    if (this.created) root.append(createdNote(d, this.created));
    if (this.error) {
      root.append(errorState(d, this.error,
        this.error.includes('অনুমতি') ? undefined : () => void this.loadTree()));
      // A refusal is the whole answer. Rendering the empty state underneath
      // it says 'you may not see this' and then 'there is nothing here',
      // which are different claims and only one of them is true.
      if (this.error.includes('অনুমতি')) return;
    }
    if (this.loading) { root.append(skeleton(d, 4)); return; }

    // The create forms sit above whatever level is on screen, so the office
    // stays where they were when the new thing appears below.
    if (this.creating) {
      if (!this.structureOptions) {
        void this.loadStructureOptions();
        root.append(skeleton(d, 2));
      } else {
        root.append(structureForm({
          doc: d,
          kind: this.creating,
          options: this.structureOptions,
          // Narrowed into a local first: TS does not carry the discriminant
          // through the property access inside the object literal.
          presetClassId: this.presetClassId(),
          busy: this.busy,
          onSubmit: (payload) => void this.submitStructure(payload),
          onCancel: () => { this.creating = null; this.render(); },
        }));
      }
    }

    switch (this.depth.at) {
      case 'tree':    this.renderTree(root); break;
      case 'level':   this.renderLevel(root, this.depth.levelNo); break;
      case 'section': this.renderSection(root); break;
      case 'student': this.renderStudent(root); break;
    }
  }

  /** Breadcrumb + back. Depth without a way out is a trap on a phone. */
  private header(): HTMLElement {
    const d = this.o.doc;
    const header = d.createElement('header');
    header.className = 'page-header';

    if (this.depth.at !== 'tree') {
      const bar = d.createElement('div');
      bar.className = 'back-bar';
      const back = d.createElement('button');
      back.type = 'button';
      back.className = 'back-btn';
      back.textContent = '← ফিরে যান';
      back.addEventListener('click', () => {
        this.notice = '';
        if (this.depth.at === 'student') void this.openSection(this.depth.sectionId);
        else if (this.depth.at === 'section') { this.depth = { at: 'tree' }; this.error = ''; this.render(); }
        else { this.depth = { at: 'tree' }; this.render(); }
      });
      bar.append(back);
      header.append(bar);
    }

    const h1 = d.createElement('h1');
    h1.textContent = this.title();
    header.append(h1);

    const sub = d.createElement('p');
    sub.className = 'page-sub';
    sub.textContent = this.breadcrumb();
    header.append(sub);
    return header;
  }

  private title(): string {
    if (this.depth.at === 'student') return this.student?.student.nameBn ?? 'শিক্ষার্থী';
    if (this.depth.at === 'section') {
      return this.detail
        ? `সেকশন ${this.detail.section.name}`
        : 'সেকশন';
    }
    if (this.depth.at === 'level') {
      const levelNo = this.depth.levelNo;
      return this.tree?.classes.find((c) => c.levelNo === levelNo)?.nameBn ?? 'শ্রেণি';
    }
    return 'একাডেমিক কাঠামো';
  }

  private breadcrumb(): string {
    const year = this.tree?.year?.label ?? '';
    if (this.depth.at === 'section' && this.detail) {
      const s = this.detail.section;
      return `${year} · ${s.classNameBn} · ${s.groupBn} · ${bnNum(s.studentCount)} জন`;
    }
    if (this.depth.at === 'student' && this.student?.current) {
      const c = this.student.current;
      return `${c.classBn} · ${c.groupBn} · সেকশন ${c.section} · রোল ${bnNum(c.rollNo)}`;
    }
    return year ? `শিক্ষাবর্ষ ${year}` : '';
  }

  /**
   * When the office opens the section form from inside a class, that class is
   * pre-selected — they are already looking at the thing that needs a section.
   */
  private presetClassId(): string | undefined {
    if (this.depth.at !== 'level') return undefined;
    const levelNo = this.depth.levelNo;
    return this.tree?.classes.find((c) => c.levelNo === levelNo)?.groups[0]?.classId;
  }

  /** The create bar. Only drawn for the roles that may actually create. */
  private createBar(kinds: StructureKind[]): HTMLElement | null {
    if (!this.o.canManage || this.creating) return null;
    const d = this.o.doc;
    const bar = d.createElement('div');
    bar.className = 'action-row';
    bar.style.padding = '0 var(--s-4) var(--s-3)';
    const labels: Record<StructureKind, string> = {
      year: 'শিক্ষাবর্ষ তৈরি', class: 'নতুন শ্রেণি', section: 'নতুন সেকশন',
    };
    for (const k of kinds) {
      const b = d.createElement('button');
      b.type = 'button';
      b.className = 'btn-secondary btn-small';
      b.textContent = labels[k];
      b.addEventListener('click', () => {
        this.creating = k; this.created = null;
        if (!this.structureOptions) void this.loadStructureOptions(); else this.render();
      });
      bar.append(b);
    }
    return bar;
  }

  private renderTree(root: HTMLElement): void {
    const d = this.o.doc;
    const levels = this.tree?.classes ?? [];
    const noYear = (this.tree?.years.length ?? 0) === 0;

    const bar = this.createBar(noYear ? ['year'] : ['year', 'class', 'section']);
    if (bar) root.append(bar);

    if (levels.length === 0) {
      root.append(emptyState(d, {
        message: noYear
          ? 'এখনো কোনো শিক্ষাবর্ষ তৈরি হয়নি। শিক্ষাবর্ষ দিয়েই প্রতিষ্ঠান শুরু হয় — ' +
            'এরপর শ্রেণি, তারপর সেকশন।'
          : 'এই শিক্ষাবর্ষে কোনো শ্রেণি তৈরি হয়নি। শ্রেণি তৈরি করে তার সেকশন যোগ করুন।',
        action: this.o.canManage
          ? {
              label: noYear ? 'শিক্ষাবর্ষ তৈরি করুন' : 'শ্রেণি তৈরি করুন',
              onClick: () => {
                this.creating = noYear ? 'year' : 'class';
                if (!this.structureOptions) void this.loadStructureOptions(); else this.render();
              },
            }
          : undefined,
      }));
      return;
    }
    const list = d.createElement('div');
    list.className = 'system-list';
    for (const lvl of levels) {
      const row = d.createElement('button');
      row.type = 'button';
      row.className = 'system-row';
      const t = d.createElement('span');
      t.className = 'system-title';
      t.textContent = lvl.nameBn;
      const desc = d.createElement('span');
      desc.className = 'system-desc';
      // The counts the brief asks for at every level.
      desc.textContent =
        `${lvl.groups.map((g) => g.groupBn).join(' · ')} · ` +
        `${bnNum(lvl.sectionCount)} সেকশন · ${bnNum(lvl.studentCount)} জন`;
      row.append(t, desc);
      row.addEventListener('click', () => { this.depth = { at: 'level', levelNo: lvl.levelNo }; this.render(); });
      list.append(row);
    }
    root.append(list);
  }

  /** B-6. "Correct the name" for one `classes` row. */
  private renameClassButton(
    classId: string, nameBn: string, nameEn: string, levelNo: number,
  ): HTMLButtonElement {
    const d = this.o.doc;
    const b = d.createElement('button');
    b.type = 'button';
    b.className = 'btn-secondary btn-small';
    b.textContent = 'শ্রেণির নাম সংশোধন';
    b.addEventListener('click', () => {
      openRename({
        doc: d,
        auth: this.o.auth,
        target: { kind: 'class', id: classId, nameBn, nameEn },
        // Re-read the tree: the level heading, the breadcrumb and every row
        // beneath carry this name.
        onSaved: () => { this.depth = { at: 'level', levelNo }; void this.loadTree(); },
      });
    });
    return b;
  }

  private renderLevel(root: HTMLElement, levelNo: number): void {
    const d = this.o.doc;
    const lvl = this.tree?.classes.find((c) => c.levelNo === levelNo);
    if (!lvl) { this.depth = { at: 'tree' }; this.render(); return; }

    const bar = this.createBar(['section']);
    if (bar) root.append(bar);

    // B-6. The class whose sections these are.
    //
    // A "level" in this tree is a level NUMBER, and `classes` rows hang off
    // its groups — নবম বিজ্ঞান and নবম ব্যবসায় are two rows, not one. So the
    // button is offered per group, from the group heading below, and only
    // when the level has exactly one group is it offered here as well, where
    // there is no ambiguity about which record it means.
    if (this.o.canManage && bar && lvl.groups.length === 1) {
      bar.append(this.renameClassButton(lvl.groups[0].classId, lvl.nameBn, lvl.nameEn, levelNo));
    }

    for (const g of lvl.groups) {
      const h = d.createElement('h2');
      h.className = 'section-heading';
      h.textContent = `${g.groupBn} · ${bnNum(g.sectionCount)} সেকশন · ${bnNum(g.studentCount)} জন`;
      root.append(h);

      // One class row per group, so the rename sits with the group it names.
      if (this.o.canManage && lvl.groups.length > 1) {
        const gbar = d.createElement('div');
        gbar.className = 'action-row';
        gbar.style.padding = '0 var(--s-4) var(--s-3)';
        gbar.append(this.renameClassButton(
          g.classId, `${lvl.nameBn} — ${g.groupBn}`, lvl.nameEn, levelNo));
        root.append(gbar);
      }

      if (g.sections.length === 0) {
        root.append(emptyState(d, {
          message: `${lvl.nameBn} ${g.groupBn}-এ এখনো কোনো সেকশন তৈরি হয়নি।`,
          action: this.o.canManage
            ? { label: 'সেকশন তৈরি করুন', onClick: () => {
                this.creating = 'section'; this.created = null;
                if (!this.structureOptions) void this.loadStructureOptions(); else this.render();
              } }
            : undefined,
        }));
        continue;
      }

      const list = d.createElement('div');
      list.className = 'system-list';
      for (const s of g.sections) {
        const row = d.createElement('button');
        row.type = 'button';
        row.className = 'system-row';
        const t = d.createElement('span');
        t.className = 'system-title';
        t.textContent = `সেকশন ${s.name}`;
        const desc = d.createElement('span');
        desc.className = 'system-desc';
        desc.textContent =
          `${bnNum(s.studentCount)} জন · ` +
          (s.classTeacher ? `শ্রেণি শিক্ষক: ${s.classTeacher.nameBn}` : 'শ্রেণি শিক্ষক নেই') +
          ` · ${bnNum(s.subjectTeacherCount)} বিষয় শিক্ষক`;
        row.append(t, desc);
        // A section with no class teacher is the thing this screen exists to
        // surface, so it is marked rather than left to be read out of a
        // sentence.
        if (!s.classTeacher) {
          const chip = d.createElement('span');
          chip.className = 'status-chip';
          chip.setAttribute('data-state', 'warning');
          chip.textContent = 'শিক্ষক নেই';
          row.append(chip);
        }
        row.addEventListener('click', () => void this.openSection(s.id));
        list.append(row);
      }
      root.append(list);
    }
  }

  private renderSection(root: HTMLElement): void {
    const d = this.o.doc;
    const det = this.detail;
    if (!det) return;

    // ── B-6: correct the name ──
    // On the detail screen rather than the list: a rename needs the current
    // value in front of you, and a pencil against forty rows invites the
    // wrong one. Same four roles the endpoint and migration 042 allow.
    if (this.o.canManage) {
      const bar = d.createElement('div');
      bar.className = 'action-row';
      bar.style.padding = '0 var(--s-4) var(--s-3)';
      const rename = d.createElement('button');
      rename.type = 'button';
      rename.className = 'btn-secondary btn-small';
      rename.textContent = 'নাম সংশোধন করুন';
      rename.addEventListener('click', () => {
        openRename({
          doc: d,
          auth: this.o.auth,
          target: {
            kind: 'section', id: det.section.id, nameBn: det.section.name,
            capacity: det.section.capacity, studentCount: det.section.studentCount,
          },
          // Re-read rather than patch in place: the tree, the heading and the
          // breadcrumb all carry this name, and one of them would be missed.
          onSaved: () => { void this.openSection(det.section.id); },
        });
      });
      bar.append(rename);
      root.append(bar);
    }

    // ── Class teacher ──
    const h1 = d.createElement('h2');
    h1.className = 'section-heading';
    h1.textContent = 'শ্রেণি শিক্ষক';
    root.append(h1);

    const ctCard = d.createElement('div');
    ctCard.className = 'card';
    ctCard.style.margin = '0 var(--s-4) var(--s-3)';
    const ctName = d.createElement('p');
    ctName.className = 'system-title';
    ctName.textContent = det.classTeacher?.nameBn ?? 'নির্ধারণ করা হয়নি';
    ctCard.append(ctName);
    if (det.classTeacher?.since) {
      const since = d.createElement('p');
      since.className = 'att-sub';
      since.textContent = `${bnDate(det.classTeacher.since)} থেকে`;
      ctCard.append(since);
    }
    if (this.o.canManage) {
      const btn = d.createElement('button');
      btn.type = 'button';
      btn.className = 'btn-secondary btn-small';
      btn.textContent = det.classTeacher ? 'শিক্ষক বদল করুন' : 'শিক্ষক নির্ধারণ করুন';
      btn.addEventListener('click', () => {
        this.panel = 'assign';
        this.assignTarget = { subjectId: null, subjectBn: 'শ্রেণি শিক্ষক', current: det.classTeacher?.nameBn ?? null };
        if (!this.candidates) void this.loadCandidates(det.section.id); else this.render();
      });
      ctCard.append(btn);
    }
    root.append(ctCard);

    // ── Subject teachers ──
    const h2 = d.createElement('h2');
    h2.className = 'section-heading';
    h2.textContent = `বিষয় শিক্ষক · ${bnNum(det.subjectTeachers.length)}`;
    root.append(h2);

    if (det.subjectTeachers.length === 0 && det.unassignedSubjects.length === 0) {
      root.append(emptyState(d, {
        message: 'এই শ্রেণির জন্য কোনো বিষয় নির্ধারণ করা হয়নি।',
      }));
    } else {
      const list = d.createElement('div');
      list.className = 'system-list';
      for (const st of det.subjectTeachers) {
        list.append(this.subjectRow(det.section.id, st.subject.id, st.subject.nameBn, st.teacher.nameBn));
      }
      // Subjects with nobody teaching them — the most useful thing this
      // screen can tell a principal in January.
      for (const u of det.unassignedSubjects) {
        list.append(this.subjectRow(det.section.id, u.id, u.nameBn, null));
      }
      root.append(list);
    }

    if (this.panel === 'assign') root.append(this.assignPanel(det));

    // ── History ──
    if (det.history.length > 0) {
      const h3 = d.createElement('h2');
      h3.className = 'section-heading';
      h3.textContent = 'দায়িত্ব পরিবর্তনের রেকর্ড';
      root.append(h3);
      const list = d.createElement('div');
      list.className = 'system-list';
      for (const h of det.history) {
        const row = d.createElement('div');
        row.className = 'system-row';
        const t = d.createElement('span');
        t.className = 'system-title';
        t.textContent = h.subjectBn ? `${h.subjectBn} — ${h.teacherBn}` : `শ্রেণি শিক্ষক — ${h.teacherBn}`;
        const desc = d.createElement('span');
        desc.className = 'system-desc';
        desc.textContent = `${bnDate(h.startedOn)} → ${bnDate(h.endedOn)} · ${h.endReason}`;
        row.append(t, desc);
        list.append(row);
      }
      root.append(list);
    }

    // ── Roster ──
    const h4 = d.createElement('h2');
    h4.className = 'section-heading';
    h4.textContent = `শিক্ষার্থী · ${bnNum(det.roster.length)}`;
    root.append(h4);

    if (det.roster.length === 0) {
      root.append(emptyState(d, {
        message: 'এই সেকশনে এখনো কোনো শিক্ষার্থী নেই। অন্য সেকশন থেকে স্থানান্তর করুন বা আমদানি করুন।',
      }));
      return;
    }

    if (this.o.canManage) {
      const bar = d.createElement('div');
      bar.className = 'action-row';
      bar.style.padding = '0 var(--s-4) var(--s-2)';
      const sel = d.createElement('button');
      sel.type = 'button';
      sel.className = 'btn-ghost btn-small';
      sel.textContent = this.panel === 'move' ? 'নির্বাচন বন্ধ করুন' : 'একসাথে স্থানান্তর';
      sel.addEventListener('click', () => {
        this.panel = this.panel === 'move' ? 'none' : 'move';
        this.selected.clear();
        this.render();
      });
      bar.append(sel);
      root.append(bar);
    }

    const list = d.createElement('ul');
    list.className = 'roster-list';
    for (const s of det.roster) {
      const li = d.createElement('li');
      li.className = 'roster-row';

      if (this.panel === 'move') {
        const cb = d.createElement('input');
        cb.type = 'checkbox';
        cb.checked = this.selected.has(s.studentId);
        cb.setAttribute('aria-label', `${s.nameBn} নির্বাচন`);
        cb.addEventListener('change', () => {
          if (cb.checked) this.selected.add(s.studentId); else this.selected.delete(s.studentId);
          this.render();
        });
        li.append(cb);
      }

      const roll = d.createElement('span');
      roll.className = 'roster-roll';
      roll.textContent = bnNum(s.rollNo);
      const btn = d.createElement('button');
      btn.type = 'button';
      btn.className = 'roster-name';
      btn.style.textAlign = 'start';
      btn.textContent = s.nameBn;
      btn.addEventListener('click', () => void this.openStudent(s.studentId));
      li.append(roll, btn);
      list.append(li);
    }
    root.append(list);

    if (this.panel === 'move' && this.selected.size > 0) root.append(this.movePanel(det));
  }

  private subjectRow(
    sectionId: string, subjectId: string, subjectBn: string, teacherBn: string | null,
  ): HTMLElement {
    const d = this.o.doc;
    const row = d.createElement(this.o.canManage ? 'button' : 'div');
    row.className = 'system-row';
    if (row instanceof HTMLButtonElement) row.type = 'button';
    const t = d.createElement('span');
    t.className = 'system-title';
    t.textContent = subjectBn;
    const desc = d.createElement('span');
    desc.className = 'system-desc';
    desc.textContent = teacherBn ?? 'শিক্ষক নির্ধারণ করা হয়নি';
    row.append(t, desc);
    if (!teacherBn) {
      const chip = d.createElement('span');
      chip.className = 'status-chip';
      chip.setAttribute('data-state', 'warning');
      chip.textContent = 'খালি';
      row.append(chip);
    }
    if (this.o.canManage) {
      row.addEventListener('click', () => {
        this.panel = 'assign';
        this.assignTarget = { subjectId, subjectBn, current: teacherBn };
        if (!this.candidates) void this.loadCandidates(sectionId); else this.render();
      });
    }
    return row;
  }

  private assignTarget: { subjectId: string | null; subjectBn: string; current: string | null } | null = null;

  private assignPanel(det: SectionDetail): HTMLElement {
    const d = this.o.doc;
    const target = this.assignTarget;
    const card = d.createElement('form');
    card.className = 'card card-form';
    card.style.margin = '0 var(--s-4) var(--s-3)';

    const h = d.createElement('p');
    h.className = 'notice-confirm-label';
    h.textContent = target?.current
      ? `${target.subjectBn} — শিক্ষক বদল`
      : `${target?.subjectBn ?? ''} — শিক্ষক নির্ধারণ`;
    card.append(h);

    if (!this.candidates) { card.append(skeleton(d, 2)); return card; }

    const teacherField = d.createElement('label');
    teacherField.className = 'field';
    teacherField.textContent = 'শিক্ষক';
    const select = d.createElement('select');
    select.className = 'field-input';
    const blank = d.createElement('option');
    blank.value = ''; blank.textContent = 'বেছে নিন…';
    select.append(blank);
    for (const t of this.candidates.teachers) {
      const opt = d.createElement('option');
      opt.value = t.id;
      // Current load is shown because handing a sixth section to somebody
      // already carrying five is a decision, and it should be a visible one.
      const expert = target?.subjectId && t.expertiseSubjectIds.includes(target.subjectId) ? ' · এই বিষয়ে দক্ষ' : '';
      opt.textContent = `${t.nameBn} (${bnNum(t.currentLoad)} বিষয়)${expert}`;
      select.append(opt);
    }
    teacherField.append(select);
    card.append(teacherField);

    const dateField = d.createElement('label');
    dateField.className = 'field';
    dateField.textContent = 'কার্যকর তারিখ';
    const date = d.createElement('input');
    date.type = 'date';
    date.className = 'field-input';
    date.value = new Date().toISOString().slice(0, 10);
    dateField.append(date);
    card.append(dateField);

    let reason: HTMLInputElement | null = null;
    if (target?.current) {
      const rf = d.createElement('label');
      rf.className = 'field';
      rf.textContent = 'পরিবর্তনের কারণ';
      reason = d.createElement('input');
      reason.type = 'text';
      reason.className = 'field-input';
      reason.placeholder = 'যেমন: বদলি হয়েছেন';
      reason.required = true;
      rf.append(reason);
      card.append(rf);

      // The visible half of migration 041.
      const keep = d.createElement('p');
      keep.className = 'att-sub';
      keep.textContent =
        `${target.current}-এর রেকর্ড মুছে যাবে না — কে কখন দায়িত্বে ছিলেন তা সংরক্ষিত থাকবে।`;
      card.append(keep);
    }

    const row = d.createElement('div');
    row.className = 'action-row';
    const cancel = d.createElement('button');
    cancel.type = 'button';
    cancel.className = 'btn-secondary';
    cancel.textContent = 'বাতিল';
    cancel.addEventListener('click', () => { this.panel = 'none'; this.assignTarget = null; this.render(); });

    const save = d.createElement('button');
    save.type = 'submit';
    save.className = 'btn-primary';
    save.textContent = this.busy ? 'অপেক্ষা করুন…' : 'নিশ্চিত করুন';
    save.disabled = this.busy;
    row.append(cancel, save);
    card.append(row);

    card.addEventListener('submit', (e) => {
      e.preventDefault();
      if (!select.value) { this.error = 'শিক্ষক বেছে নিন।'; this.render(); return; }
      if (target?.current && !(reason?.value ?? '').trim()) {
        this.error = 'পরিবর্তনের কারণ লিখুন।'; this.render(); return;
      }
      const teacherName = this.candidates?.teachers.find((t) => t.id === select.value)?.nameBn ?? '';
      const go = () => void this.submitAssign(
        det.section.id, target?.subjectId ?? null, select.value, date.value, reason?.value ?? '');

      // Replacement is irreversible in the sense that matters: it closes a
      // record with a date. Confirm it, naming both people.
      if (target?.current) {
        card.append(confirmDialog({
          doc: d,
          title: 'শিক্ষক বদল নিশ্চিত করুন',
          body: `${target.subjectBn}: ${target.current} → ${teacherName}, ${bnDate(date.value)} থেকে। ` +
                `${target.current}-এর আগের দায়িত্বের রেকর্ড সংরক্ষিত থাকবে।`,
          confirmLabel: 'বদল করুন',
          danger: true,
          onConfirm: go,
        }));
        this.error = '';
      } else {
        go();
      }
    });

    return card;
  }

  private movePanel(det: SectionDetail): HTMLElement {
    const d = this.o.doc;
    const card = d.createElement('div');
    card.className = 'card';
    card.style.margin = 'var(--s-3) var(--s-4)';

    const h = d.createElement('p');
    h.className = 'notice-confirm-label';
    h.textContent = `${bnNum(this.selected.size)} জন নির্বাচিত`;
    card.append(h);

    const field = d.createElement('label');
    field.className = 'field';
    field.textContent = 'যে সেকশনে পাঠাবেন';
    const select = d.createElement('select');
    select.className = 'field-input';
    const blank = d.createElement('option');
    blank.value = ''; blank.textContent = 'বেছে নিন…';
    select.append(blank);
    for (const lvl of this.tree?.classes ?? []) {
      for (const g of lvl.groups) {
        for (const s of g.sections) {
          if (s.id === det.section.id) continue;
          const opt = d.createElement('option');
          opt.value = s.id;
          opt.textContent = `${lvl.nameBn} · ${g.groupBn} · ${s.name} (${bnNum(s.studentCount)} জন)`;
          select.append(opt);
        }
      }
    }
    field.append(select);
    card.append(field);

    const row = d.createElement('div');
    row.className = 'action-row';
    const cancel = d.createElement('button');
    cancel.type = 'button';
    cancel.className = 'btn-secondary';
    cancel.textContent = 'বাতিল';
    cancel.addEventListener('click', () => { this.panel = 'none'; this.selected.clear(); this.render(); });

    const go = d.createElement('button');
    go.type = 'button';
    go.className = 'btn-primary';
    go.textContent = this.busy ? 'অপেক্ষা করুন…' : 'পূর্বরূপ দেখুন';
    go.disabled = this.busy;
    go.addEventListener('click', () => {
      if (!select.value) { this.error = 'সেকশন বেছে নিন।'; this.render(); return; }
      const label = select.options[select.selectedIndex].textContent ?? '';
      const target = select.value;
      // Preview before commit, as the brief requires — and the preview comes
      // from the same endpoint that will do the move, so it cannot disagree.
      card.append(confirmDialog({
        doc: d,
        title: 'স্থানান্তর নিশ্চিত করুন',
        body: `${bnNum(this.selected.size)} জন শিক্ষার্থী ${label}-এ যাবে। ` +
              `নতুন রোল নম্বর দেওয়া হবে; আগের বছরের রেকর্ড অপরিবর্তিত থাকবে।`,
        confirmLabel: 'স্থানান্তর করুন',
        danger: true,
        onConfirm: () => void this.submitMove(target, false),
      }));
    });
    row.append(cancel, go);
    card.append(row);
    return card;
  }

  private renderStudent(root: HTMLElement): void {
    const d = this.o.doc;
    const s = this.student;
    if (!s) return;

    const card = d.createElement('div');
    card.className = 'card';
    card.style.margin = '0 var(--s-4) var(--s-3)';
    const rows: [string, string][] = [
      ['স্থায়ী আইডি', s.student.studentCode ?? '—'],
      ['ভর্তির তারিখ', bnDate(s.student.admissionDate)],
      ['অবস্থা', s.student.status === 'active' ? 'সক্রিয়' : s.student.status],
    ];
    if (s.current) {
      rows.splice(1, 0,
        ['শ্রেণি', `${s.current.classBn} · ${s.current.groupBn}`],
        ['সেকশন ও রোল', `${s.current.section} · ${bnNum(s.current.rollNo)}`]);
    }
    for (const [k, v] of rows) {
      const p = d.createElement('p');
      p.className = 'system-row';
      p.textContent = `${k}: ${v}`;
      card.append(p);
    }
    root.append(card);

    const att = s.attendance90d;
    const h = d.createElement('h2');
    h.className = 'section-heading';
    h.textContent = 'গত ৯০ দিনের হাজিরা';
    root.append(h);
    const attP = d.createElement('p');
    attP.className = 'att-sub';
    attP.style.padding = '0 var(--s-4) var(--s-3)';
    attP.textContent = att.total > 0
      ? `${bnNum(Math.round((att.present / att.total) * 100))}% · ${bnNum(att.present)} / ${bnNum(att.total)}`
      : 'এই সময়ে কোনো হাজিরা নেওয়া হয়নি।';
    root.append(attP);

    // R-3 completion: the guardian block is now a live panel — linking,
    // relationship, SMS and fee permission — with its own loading, empty and
    // error states. It mounts into its own container so re-rendering it does
    // not rebuild the whole student drawer under the user's finger.
    const guardianHost = d.createElement('section');
    root.append(guardianHost);
    new GuardianPanel({
      root: guardianHost, doc: d, auth: this.o.auth,
      studentId: s.student.id,
      studentNameBn: s.student.nameBn,
      canManage: this.o.canManageGuardians,
    });

    const hh = d.createElement('h2');
    hh.className = 'section-heading';
    hh.textContent = 'শিক্ষাবর্ষভিত্তিক ইতিহাস';
    root.append(hh);
    const list = d.createElement('div');
    list.className = 'system-list';
    for (const e of s.history) {
      const row = d.createElement('div');
      row.className = 'system-row';
      const t = d.createElement('span');
      t.className = 'system-title';
      t.textContent = `${e.yearLabel} · ${e.classBn} ${e.section}`;
      const desc = d.createElement('span');
      desc.className = 'system-desc';
      desc.textContent = `রোল ${bnNum(e.rollNo)} · ${e.status}`;
      row.append(t, desc);
      list.append(row);
    }
    root.append(list);
  }
}
