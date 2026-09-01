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
import {
  permissionMessage, pageHeader, sectionHeading, buttonRow, button, card,
  dataTable, statusBadge, field, setFieldError, clearFieldError, el, append,
  type Field, serverMessage,} from './ui/index.ts';

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
      if (res.status === 403) { this.error = permissionMessage('একাডেমিক কাঠামো'); return; }
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
      if (!res.ok) { this.error = serverMessage(body, res.status, 'তৈরি করা যায়নি।'); return; }
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
      if (!res.ok) { this.error = serverMessage(body, res.status, 'নির্ধারণ করা যায়নি।'); return; }
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
      if (!res.ok) { this.error = serverMessage(body, res.status, 'স্থানান্তর করা যায়নি।'); return; }
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

  /**
   * The trail, as real crumbs rather than a sentence.
   *
   * `pageHeader`'s `crumbs` render as links a person can click to jump two
   * levels back — the old `page-sub` said "শিক্ষাবর্ষ ২০২৬ · নবম শ্রেণি · ..."
   * as prose, which reads the same and goes nowhere. The back button stays:
   * on a phone the crumb row is the least reachable thing on the screen.
   */
  private header(): HTMLElement {
    const d = this.o.doc;
    const crumbs: Array<{ label: string; onClick?: () => void }> = [];
    const year = this.tree?.year?.label ?? '';
    if (this.depth.at !== 'tree') {
      crumbs.push({
        label: year ? `শিক্ষাবর্ষ ${year}` : 'একাডেমিক কাঠামো',
        onClick: () => { this.depth = { at: 'tree' }; this.error = ''; this.notice = ''; this.render(); },
      });
    }
    if (this.depth.at === 'section' && this.detail) {
      const levelNo = this.detail.section.levelNo;
      crumbs.push({
        label: this.detail.section.classNameBn,
        onClick: () => { this.depth = { at: 'level', levelNo }; this.error = ''; this.render(); },
      });
    }
    if (this.depth.at === 'student') {
      // Resolved from the TREE by the id we drilled through, not from
      // `student.current.section`. Those are the same row in real data and
      // were not in the demo — and a crumb that names a section other than
      // the one the person came from sends them somewhere else when clicked.
      const sectionId = this.depth.sectionId;
      const found = this.findSection(sectionId);
      if (found) {
        crumbs.push({
          label: found.classNameBn,
          onClick: () => { this.depth = { at: 'level', levelNo: found.levelNo }; this.error = ''; this.render(); },
        });
        crumbs.push({
          label: `সেকশন ${found.name}`,
          onClick: () => void this.openSection(sectionId),
        });
      }
    }

    // The current depth, as the LAST crumb. `breadcrumb()` renders the final
    // entry as "you are here" and every earlier one as a link — so without
    // this the one crumb at level depth was plain text and went nowhere. It
    // repeats the h1 on purpose: that is what a breadcrumb trail is.
    if (crumbs.length) crumbs.push({ label: this.title() });

    const back = this.depth.at === 'tree' ? undefined : button(d, {
      label: 'ফিরে যান', variant: 'ghost', size: 'sm', glyph: 'arrow-left',
      onClick: () => {
        this.notice = '';
        if (this.depth.at === 'student') void this.openSection(this.depth.sectionId);
        else if (this.depth.at === 'section') { this.depth = { at: 'tree' }; this.error = ''; this.render(); }
        else { this.depth = { at: 'tree' }; this.render(); }
      },
    });

    return pageHeader(d, {
      title: this.title(),
      subtitle: this.subtitle(),
      crumbs: crumbs.length ? crumbs : undefined,
      actions: back ? [back] : undefined,
    });
  }

  /** Where a section sits in the tree, by id. Used by the crumbs. */
  private findSection(sectionId: string): { name: string; classNameBn: string; levelNo: number } | null {
    for (const lvl of this.tree?.classes ?? []) {
      for (const g of lvl.groups) {
        for (const sec of g.sections) {
          if (sec.id === sectionId) {
            return { name: sec.name, classNameBn: `${lvl.nameBn} · ${g.groupBn}`, levelNo: lvl.levelNo };
          }
        }
      }
    }
    return null;
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

  /**
   * The one line of context the crumbs cannot carry: how many people this
   * depth is about. Renamed from `breadcrumb` because the crumbs are now real.
   */
  private subtitle(): string {
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
    const labels: Record<StructureKind, string> = {
      year: 'শিক্ষাবর্ষ তৈরি', class: 'নতুন শ্রেণি', section: 'নতুন সেকশন',
    };
    const glyphs: Record<StructureKind, string> = {
      year: 'calendar', class: 'layers', section: 'users',
    };
    return buttonRow(d, ...kinds.map((k) => button(d, {
      label: labels[k], variant: 'secondary', size: 'sm', glyph: glyphs[k],
      onClick: () => {
        this.creating = k; this.created = null;
        if (!this.structureOptions) void this.loadStructureOptions(); else this.render();
      },
    })));
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
    // The counts the brief asks for, as COLUMNS rather than a sentence: a
    // head teacher comparing section counts across six classes reads a column
    // in one pass and a run-on `·` line six times.
    root.append(dataTable(d, {
      caption: 'শ্রেণির তালিকা',
      rows: levels,
      rowKey: (l) => String(l.levelNo),
      onRowClick: (l) => { this.depth = { at: 'level', levelNo: l.levelNo }; this.render(); },
      columns: [
        { key: 'name', header: 'শ্রেণি', mobile: 'title', cell: (l) => l.nameBn,
          width: 'minmax(0, 1.4fr)' },
        { key: 'groups', header: 'বিভাগ', mobile: 'subtitle',
          cell: (l) => l.groups.map((g) => g.groupBn).join(' · ') || 'বিভাগ নেই',
          width: 'minmax(0, 2fr)' },
        { key: 'sections', header: 'সেকশন', mobile: 'meta', numeric: true,
          cell: (l) => bnNum(l.sectionCount), width: '110px' },
        { key: 'students', header: 'শিক্ষার্থী', mobile: 'meta', numeric: true,
          cell: (l) => bnNum(l.studentCount), width: '110px' },
      ],
    }));
  }

  /** B-6. "Correct the name" for one `classes` row. */
  private renameClassButton(
    classId: string, nameBn: string, nameEn: string, levelNo: number,
  ): HTMLElement {
    const d = this.o.doc;
    const b = button(d, {
      label: 'শ্রেণির নাম সংশোধন', variant: 'secondary', size: 'sm', glyph: 'edit',
      onClick: () => {
        openRename({
          doc: d,
          auth: this.o.auth,
          target: { kind: 'class', id: classId, nameBn, nameEn },
          // Re-read the tree: the level heading, the crumbs and every row
          // beneath carry this name.
          onSaved: () => { this.depth = { at: 'level', levelNo }; void this.loadTree(); },
        });
      },
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
        root.append(buttonRow(d, this.renameClassButton(
          g.classId, `${lvl.nameBn} — ${g.groupBn}`, lvl.nameEn, levelNo)));
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

      root.append(dataTable(d, {
        caption: `${lvl.nameBn} ${g.groupBn} — সেকশনের তালিকা`,
        rows: g.sections,
        rowKey: (sec) => sec.id,
        onRowClick: (sec) => void this.openSection(sec.id),
        columns: [
          { key: 'name', header: 'সেকশন', mobile: 'title',
            cell: (sec) => `সেকশন ${sec.name}`, width: 'minmax(0, 1fr)' },
          { key: 'teacher', header: 'শ্রেণি শিক্ষক', mobile: 'subtitle',
            cell: (sec) => sec.classTeacher?.nameBn ?? 'নির্ধারণ করা হয়নি',
            width: 'minmax(0, 2fr)' },
          { key: 'subj', header: 'বিষয় শিক্ষক', mobile: 'meta', numeric: true,
            cell: (sec) => bnNum(sec.subjectTeacherCount), width: '120px' },
          { key: 'students', header: 'শিক্ষার্থী', mobile: 'meta', numeric: true,
            cell: (sec) => bnNum(sec.studentCount), width: '110px' },
          // A section with no class teacher is the thing this screen exists to
          // surface, so it is a state in its own column rather than a clause
          // at the end of a sentence.
          { key: 'state', header: 'অবস্থা', mobile: 'status', width: '130px',
            cell: (sec) => sec.classTeacher
              ? statusBadge(d, { state: 'published', label: 'সম্পূর্ণ' })
              : statusBadge(d, { state: 'pending', label: 'শিক্ষক নেই' }) },
        ],
      }));
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
      root.append(buttonRow(d, button(d, {
        label: 'নাম সংশোধন করুন', variant: 'secondary', size: 'sm', glyph: 'edit',
        onClick: () => {
          openRename({
            doc: d,
            auth: this.o.auth,
            target: {
              kind: 'section', id: det.section.id, nameBn: det.section.name,
              capacity: det.section.capacity, studentCount: det.section.studentCount,
            },
            // Re-read rather than patch in place: the tree, the heading and
            // the crumbs all carry this name.
            onSaved: () => { void this.openSection(det.section.id); },
          });
        },
      })));
    }

    // ── Class teacher ──
    // A card rather than a heading plus a bare div: the assign/replace action
    // belongs in the card's own header row, beside the thing it changes.
    root.append(card(d, {
      title: 'শ্রেণি শিক্ষক',
      glyph: 'user',
      tone: det.classTeacher ? 'primary' : 'warn',
      action: this.o.canManage
        ? button(d, {
            label: det.classTeacher ? 'শিক্ষক বদল করুন' : 'শিক্ষক নির্ধারণ করুন',
            variant: 'secondary', size: 'sm',
            onClick: () => {
              this.panel = 'assign';
              this.assignTarget = {
                subjectId: null, subjectBn: 'শ্রেণি শিক্ষক',
                current: det.classTeacher?.nameBn ?? null,
              };
              if (!this.candidates) void this.loadCandidates(det.section.id); else this.render();
            },
          })
        : undefined,
    },
      el(d, 'p', {
        className: 'ui-card-lead',
        text: det.classTeacher?.nameBn ?? 'নির্ধারণ করা হয়নি',
      }),
      det.classTeacher?.since
        ? el(d, 'p', { className: 'ui-card-note', text: `${bnDate(det.classTeacher.since)} থেকে` })
        : null,
    ));

    // ── Subject teachers ──
    // Assigned and unassigned in ONE table, unassigned last. Two lists would
    // let a principal read the first one and stop; the empty subjects are the
    // most useful thing this screen can tell them in January.
    const subjectRows: Array<{ subjectId: string; subjectBn: string; teacherBn: string | null }> = [
      ...det.subjectTeachers.map((st) => ({
        subjectId: st.subject.id, subjectBn: st.subject.nameBn, teacherBn: st.teacher.nameBn,
      })),
      ...det.unassignedSubjects.map((u) => ({
        subjectId: u.id, subjectBn: u.nameBn, teacherBn: null,
      })),
    ];
    root.append(sectionHeading(d, { title: `বিষয় শিক্ষক · ${bnNum(subjectRows.length)}` }));
    root.append(dataTable(d, {
      caption: 'বিষয় ও শিক্ষকের তালিকা',
      rows: subjectRows,
      rowKey: (r) => r.subjectId,
      onRowClick: this.o.canManage
        ? (r) => {
            this.panel = 'assign';
            this.assignTarget = {
              subjectId: r.subjectId, subjectBn: r.subjectBn, current: r.teacherBn,
            };
            if (!this.candidates) void this.loadCandidates(det.section.id); else this.render();
          }
        : undefined,
      empty: { message: 'এই শ্রেণির জন্য কোনো বিষয় নির্ধারণ করা হয়নি।' },
      columns: [
        { key: 'subject', header: 'বিষয়', mobile: 'title', cell: (r) => r.subjectBn,
          width: 'minmax(0, 1.6fr)' },
        { key: 'teacher', header: 'শিক্ষক', mobile: 'subtitle',
          cell: (r) => r.teacherBn ?? 'নির্ধারণ করা হয়নি', width: 'minmax(0, 2fr)' },
        { key: 'state', header: 'অবস্থা', mobile: 'status', width: '120px',
          cell: (r) => r.teacherBn
            ? statusBadge(d, { state: 'published', label: 'নির্ধারিত' })
            : statusBadge(d, { state: 'pending', label: 'খালি' }) },
      ],
    }));

    if (this.panel === 'assign') root.append(this.assignPanel(det));

    // ── History ──
    if (det.history.length > 0) {
      root.append(sectionHeading(d, { title: 'দায়িত্ব পরিবর্তনের রেকর্ড' }));
      root.append(dataTable(d, {
        caption: 'দায়িত্ব পরিবর্তনের রেকর্ড',
        rows: det.history,
        rowKey: (h) => `${h.teacherBn}-${h.startedOn}-${h.subjectBn ?? 'ct'}`,
        columns: [
          { key: 'role', header: 'দায়িত্ব', mobile: 'title',
            cell: (h) => h.subjectBn ?? 'শ্রেণি শিক্ষক', width: 'minmax(0, 1.4fr)' },
          { key: 'teacher', header: 'শিক্ষক', mobile: 'subtitle', cell: (h) => h.teacherBn,
            width: 'minmax(0, 1.6fr)' },
          { key: 'period', header: 'সময়কাল', mobile: 'meta',
            cell: (h) => `${bnDate(h.startedOn)} → ${bnDate(h.endedOn)}`,
            width: 'minmax(0, 1.6fr)' },
          { key: 'reason', header: 'কারণ', mobile: 'meta', cell: (h) => h.endReason,
            width: 'minmax(0, 1.4fr)' },
        ],
      }));
    }

    // ── Roster ──
    root.append(sectionHeading(d, {
      title: `শিক্ষার্থী · ${bnNum(det.roster.length)}`,
      action: this.o.canManage && det.roster.length > 0
        ? button(d, {
            label: this.panel === 'move' ? 'নির্বাচন বন্ধ করুন' : 'একসাথে স্থানান্তর',
            variant: 'ghost', size: 'sm',
            onClick: () => {
              this.panel = this.panel === 'move' ? 'none' : 'move';
              this.selected.clear();
              this.render();
            },
          })
        : undefined,
    }));

    root.append(dataTable(d, {
      caption: `সেকশন ${det.section.name} — শিক্ষার্থীর তালিকা`,
      rows: det.roster,
      rowKey: (r) => r.studentId,
      // While selecting for a move, the row must NOT navigate: a tap that
      // opens a child's record when the person meant to tick them loses the
      // whole selection.
      onRowClick: this.panel === 'move' ? undefined : (r) => void this.openStudent(r.studentId),
      empty: {
        message: 'এই সেকশনে এখনো কোনো শিক্ষার্থী নেই। অন্য সেকশন থেকে স্থানান্তর করুন বা আমদানি করুন।',
      },
      columns: [
        ...(this.panel === 'move' ? [{
          key: 'pick', header: 'নির্বাচন', mobile: 'status' as const, width: '96px',
          cell: (r: { studentId: string; nameBn: string }) => this.pickBox(r.studentId, r.nameBn),
        }] : []),
        { key: 'roll', header: 'রোল', mobile: 'meta', numeric: true,
          cell: (r) => bnNum(r.rollNo), width: '90px' },
        { key: 'name', header: 'নাম', mobile: 'title', cell: (r) => r.nameBn,
          width: 'minmax(0, 2fr)' },
        // The school's permanent id, never the uuid.
        { key: 'code', header: 'স্থায়ী আইডি', mobile: 'meta',
          cell: (r) => r.studentCode || '—', width: 'minmax(0, 1fr)' },
        { key: 'status', header: 'অবস্থা', mobile: 'status', width: '120px',
          cell: (r) => statusBadge(d, {
            state: r.status === 'active' ? 'published' : 'overdue',
            label: r.status === 'active' ? 'সক্রিয়' : r.status,
          }) },
      ],
    }));

    if (this.panel === 'move' && this.selected.size > 0) root.append(this.movePanel(det));
  }

  /**
   * One roster checkbox. Wrapped in its own `<label>` because a bare 13px
   * `<input type=checkbox>` is not a touch target — the label is what a
   * thumb hits, and it is what a screen reader announces.
   */
  private pickBox(studentId: string, nameBn: string): HTMLElement {
    const d = this.o.doc;
    const box = el(d, 'input', { className: 'ui-check-box' }) as HTMLInputElement;
    box.type = 'checkbox';
    box.checked = this.selected.has(studentId);
    box.addEventListener('change', () => {
      if (box.checked) this.selected.add(studentId); else this.selected.delete(studentId);
      this.render();
    });
    const label = el(d, 'label', { className: 'ui-check' }, box,
      el(d, 'span', { className: 'ui-sr-only', text: `${nameBn} নির্বাচন` }));
    return label;
  }

  private assignTarget: { subjectId: string | null; subjectBn: string; current: string | null } | null = null;

  private assignPanel(det: SectionDetail): HTMLElement {
    const d = this.o.doc;
    const target = this.assignTarget;
    const form = el(d, 'form', { className: 'ui-card ui-card-form' });

    append(form, el(d, 'h3', {
      className: 'ui-card-title',
      text: target?.current
        ? `${target.subjectBn} — শিক্ষক বদল`
        : `${target?.subjectBn ?? ''} — শিক্ষক নির্ধারণ`,
    }));

    if (!this.candidates) { append(form, skeleton(d, 2)); return form; }

    // Current load rides in the option label because handing a sixth section
    // to somebody already carrying five is a decision, and it should be a
    // visible one at the moment it is made.
    const teacher = field(d, {
      label: 'শিক্ষক',
      name: 'teacher',
      kind: 'select',
      required: true,
      helper: 'বন্ধনীতে বর্তমান দায়িত্বের সংখ্যা।',
      options: [
        { value: '', label: 'বেছে নিন…' },
        ...this.candidates.teachers.map((t) => ({
          value: t.id,
          label: `${t.nameBn} (${bnNum(t.currentLoad)} বিষয়)` +
            (target?.subjectId && t.expertiseSubjectIds.includes(target.subjectId)
              ? ' · এই বিষয়ে দক্ষ' : ''),
        })),
      ],
    });
    append(form, teacher.root);

    const when = field(d, {
      label: 'কার্যকর তারিখ',
      name: 'startedOn',
      kind: 'date',
      required: true,
      value: new Date().toISOString().slice(0, 10),
      helper: 'এই তারিখ থেকে নতুন শিক্ষক দায়িত্বে থাকবেন।',
    });
    append(form, when.root);

    let reason: Field | null = null;
    if (target?.current) {
      reason = field(d, {
        label: 'পরিবর্তনের কারণ',
        name: 'reason',
        required: true,
        placeholder: 'যেমন: বদলি হয়েছেন',
        // The visible half of migration 041: a school that believes a
        // replacement erases the old teacher will stop recording
        // replacements, and then the register and the truth diverge quietly.
        helper: `${target.current}-এর রেকর্ড মুছে যাবে না — কে কখন দায়িত্বে ছিলেন তা সংরক্ষিত থাকবে।`,
      });
      append(form, reason.root);
    }

    append(form, buttonRow(d,
      button(d, {
        label: 'বাতিল', variant: 'secondary',
        onClick: () => { this.panel = 'none'; this.assignTarget = null; this.render(); },
      }),
      button(d, {
        label: 'নিশ্চিত করুন', variant: 'primary', type: 'submit', busy: this.busy,
      }),
    ));

    form.addEventListener('submit', (e) => {
      e.preventDefault();
      // Field-level, and NOT via `this.error` + a repaint: repainting rebuilds
      // this form from scratch and throws away the date and the reason the
      // person had already typed.
      clearFieldError(teacher.root);
      if (reason) clearFieldError(reason.root);
      if (!teacher.value()) {
        setFieldError(teacher.root, 'শিক্ষক বেছে নিন।');
        teacher.input.focus();
        return;
      }
      if (target?.current && !reason?.value().trim()) {
        setFieldError(reason!.root, 'পরিবর্তনের কারণ লিখুন।');
        reason!.input.focus();
        return;
      }
      const teacherName = this.candidates?.teachers.find((t) => t.id === teacher.value())?.nameBn ?? '';
      const go = () => void this.submitAssign(
        det.section.id, target?.subjectId ?? null, teacher.value(), when.value(),
        reason?.value() ?? '');

      // Replacement is irreversible in the sense that matters: it closes a
      // record with a date. Confirm it, naming both people.
      if (target?.current) {
        form.append(confirmDialog({
          doc: d,
          title: 'শিক্ষক বদল নিশ্চিত করুন',
          body: `${target.subjectBn}: ${target.current} → ${teacherName}, ${bnDate(when.value())} থেকে। ` +
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

    return form;
  }

  private movePanel(det: SectionDetail): HTMLElement {
    const d = this.o.doc;
    const host = el(d, 'section', { className: 'ui-card ui-card-form' });

    append(host, el(d, 'h3', {
      className: 'ui-card-title', text: `${bnNum(this.selected.size)} জন নির্বাচিত`,
    }));

    const options = [{ value: '', label: 'বেছে নিন…' }];
    for (const lvl of this.tree?.classes ?? []) {
      for (const g of lvl.groups) {
        for (const sec of g.sections) {
          if (sec.id === det.section.id) continue;
          options.push({
            value: sec.id,
            label: `${lvl.nameBn} · ${g.groupBn} · ${sec.name} (${bnNum(sec.studentCount)} জন)`,
          });
        }
      }
    }
    const dest = field(d, {
      label: 'যে সেকশনে পাঠাবেন',
      name: 'toSection',
      kind: 'select',
      required: true,
      helper: 'বন্ধনীতে ওই সেকশনের বর্তমান শিক্ষার্থী সংখ্যা।',
      options,
    });
    append(host, dest.root);

    append(host, buttonRow(d,
      button(d, {
        label: 'বাতিল', variant: 'secondary',
        onClick: () => { this.panel = 'none'; this.selected.clear(); this.render(); },
      }),
      button(d, {
        label: 'পূর্বরূপ দেখুন', variant: 'primary', busy: this.busy,
        onClick: () => {
          clearFieldError(dest.root);
          if (!dest.value()) {
            setFieldError(dest.root, 'সেকশন বেছে নিন।');
            dest.input.focus();
            return;
          }
          const label = options.find((o) => o.value === dest.value())?.label ?? '';
          const to = dest.value();
          // Preview before commit, as the brief requires — and the preview
          // comes from the same endpoint that will do the move, so the two
          // cannot disagree.
          host.append(confirmDialog({
            doc: d,
            title: 'স্থানান্তর নিশ্চিত করুন',
            body: `${bnNum(this.selected.size)} জন শিক্ষার্থী ${label}-এ যাবে। ` +
                  `নতুন রোল নম্বর দেওয়া হবে; আগের বছরের রেকর্ড অপরিবর্তিত থাকবে।`,
            confirmLabel: 'স্থানান্তর করুন',
            danger: true,
            onConfirm: () => void this.submitMove(to, false),
          }));
        },
      }),
    ));
    return host;
  }

  private renderStudent(root: HTMLElement): void {
    const d = this.o.doc;
    const stu = this.student;
    if (!stu) return;

    // Identity as a definition list, not five `system-row` paragraphs each
    // saying "label: value". A <dl> is what this is, and it is what a screen
    // reader announces as pairs.
    const facts: Array<[string, string]> = [
      ['স্থায়ী আইডি', stu.student.studentCode ?? '—'],
      ['ভর্তির তারিখ', bnDate(stu.student.admissionDate)],
      ['অবস্থা', stu.student.status === 'active' ? 'সক্রিয়' : stu.student.status],
    ];
    if (stu.current) {
      facts.splice(1, 0,
        ['শ্রেণি', `${stu.current.classBn} · ${stu.current.groupBn}`],
        ['সেকশন ও রোল', `${stu.current.section} · ${bnNum(stu.current.rollNo)}`]);
    }
    const dl = el(d, 'dl', { className: 'ui-facts' });
    for (const [k, v] of facts) {
      append(dl,
        el(d, 'dt', { className: 'ui-facts-key', text: k }),
        el(d, 'dd', { className: 'ui-facts-val', text: v }));
    }
    root.append(card(d, { title: 'পরিচয়', glyph: 'user' }, dl));

    // ৯০ days of attendance, as a figure rather than a sentence — and `null`
    // when nobody has taken any, because ০% is a claim about the child.
    const att = stu.attendance90d;
    root.append(card(d, { title: 'গত ৯০ দিনের হাজিরা', glyph: 'check-square', tone: 'info' },
      att.total > 0
        ? el(d, 'p', {
            className: 'ui-card-lead',
            text: `${bnNum(Math.round((att.present / att.total) * 100))}% · ` +
                  `${bnNum(att.present)} / ${bnNum(att.total)} দিন`,
          })
        : el(d, 'p', { className: 'ui-card-note', text: 'এই সময়ে কোনো হাজিরা নেওয়া হয়নি।' }),
    ));

    // R-3 completion: the guardian block is a live panel — linking,
    // relationship, SMS and fee permission — with its own loading, empty and
    // error states. It mounts into its own container so re-rendering it does
    // not rebuild the whole student drawer under the user's finger.
    const guardianHost = d.createElement('section');
    root.append(guardianHost);
    new GuardianPanel({
      root: guardianHost, doc: d, auth: this.o.auth,
      studentId: stu.student.id,
      studentNameBn: stu.student.nameBn,
      canManage: this.o.canManageGuardians,
    });

    root.append(sectionHeading(d, { title: 'শিক্ষাবর্ষভিত্তিক ইতিহাস' }));
    root.append(dataTable(d, {
      caption: `${stu.student.nameBn} — শিক্ষাবর্ষভিত্তিক ইতিহাস`,
      rows: stu.history,
      rowKey: (h) => `${h.yearLabel}-${h.section}-${h.rollNo}`,
      empty: { message: 'আগের কোনো শিক্ষাবর্ষের রেকর্ড নেই।' },
      columns: [
        { key: 'year', header: 'শিক্ষাবর্ষ', mobile: 'title', cell: (h) => h.yearLabel,
          width: 'minmax(0, 1fr)' },
        { key: 'class', header: 'শ্রেণি', mobile: 'subtitle',
          cell: (h) => `${h.classBn} · ${h.groupBn}`, width: 'minmax(0, 1.6fr)' },
        { key: 'section', header: 'সেকশন', mobile: 'meta', cell: (h) => h.section,
          width: '110px' },
        { key: 'roll', header: 'রোল', mobile: 'meta', numeric: true,
          cell: (h) => bnNum(h.rollNo), width: '90px' },
        { key: 'status', header: 'অবস্থা', mobile: 'status', width: '120px',
          cell: (h) => statusBadge(d, {
            state: h.status === 'active' ? 'published' : 'draft',
            label: h.status === 'active' ? 'সক্রিয়' : h.status,
          }) },
      ],
    }));
  }
}
