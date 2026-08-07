/**
 * Attendance grid state machine.
 *
 * The 30-second screen (docs/04-UIUX-ACCESSIBILITY.md §4.1). Framework-free
 * and synchronous so it can be unit-tested exhaustively and driven from any
 * renderer.
 *
 * Design decisions encoded here, and why:
 *
 *   * DEFAULT ALL PRESENT. In a typical section 3–5 students are absent.
 *     Marking exceptions is ~6 taps; marking everyone is 60. The grid opens
 *     with every student present.
 *   * TAP-TO-CYCLE, not a picker. present → absent → late → present. One tap
 *     per state change, no modal, no scroll-away.
 *   * ROLL NUMBERS, not names. Teachers call the roll, and Bangla names are
 *     ~3× wider — names would cut the grid from 5 columns to 2.
 *   * UNDO, not confirm. Save is instant with a 5-second undo window. A
 *     confirmation dialog on a 30-second task is a 20% time tax.
 */

export type AttendanceStatus = 'present' | 'absent' | 'late' | 'excused';

export interface Student {
  studentId: string;
  rollNo: number;
  nameBn: string;
  nameEn?: string;
}

export interface GridEntry {
  studentId: string;
  rollNo: number;
  nameBn: string;
  nameEn?: string;
  status: AttendanceStatus;
  minutesLate?: number;
  /** True once the teacher has explicitly touched this student. */
  touched: boolean;
}

export interface GridCounts {
  total: number;
  present: number;
  absent: number;
  late: number;
  excused: number;
  /** Students the teacher never touched — all still on the default. */
  untouched: number;
}

export interface GridSnapshot {
  entries: GridEntry[];
  counts: GridCounts;
  dirty: boolean;
}

/** present → absent → late → present. 'excused' is only set explicitly. */
const CYCLE: AttendanceStatus[] = ['present', 'absent', 'late'];

export interface AttendanceGridOptions {
  students: Student[];
  /** Restore a previously saved/queued draft. */
  initial?: Record<string, AttendanceStatus>;
  onChange?: (snapshot: GridSnapshot) => void;
}

export class AttendanceGrid {
  private readonly order: string[] = [];
  private readonly entries = new Map<string, GridEntry>();
  private readonly onChange?: (s: GridSnapshot) => void;
  private undoStack: Array<{ studentId: string; status: AttendanceStatus; touched: boolean }> = [];
  private savedAt: number | null = null;
  private changedSinceSave = false;

  constructor(opts: AttendanceGridOptions) {
    this.onChange = opts.onChange;

    // Sort by roll number: the only order a teacher reads a register in.
    const sorted = [...opts.students].sort((a, b) => a.rollNo - b.rollNo);
    for (const s of sorted) {
      this.order.push(s.studentId);
      const restored = opts.initial?.[s.studentId];
      this.entries.set(s.studentId, {
        studentId: s.studentId,
        rollNo: s.rollNo,
        nameBn: s.nameBn,
        nameEn: s.nameEn,
        status: restored ?? 'present',
        touched: restored !== undefined,
      });
    }
    this.changedSinceSave = opts.initial !== undefined;
  }

  /** One tap on a tile. */
  cycle(studentId: string): AttendanceStatus | undefined {
    const e = this.entries.get(studentId);
    if (!e) return undefined;

    this.pushUndo(e);
    const idx = CYCLE.indexOf(e.status);
    // 'excused' is outside the cycle; tapping it rejoins at 'present'.
    e.status = idx === -1 ? 'present' : CYCLE[(idx + 1) % CYCLE.length];
    if (e.status !== 'late') e.minutesLate = undefined;
    e.touched = true;
    this.changed();
    return e.status;
  }

  /** Long-press / detail sheet: set a status directly. */
  set(studentId: string, status: AttendanceStatus, minutesLate?: number): boolean {
    const e = this.entries.get(studentId);
    if (!e) return false;
    this.pushUndo(e);
    e.status = status;
    e.minutesLate = status === 'late' ? minutesLate : undefined;
    e.touched = true;
    this.changed();
    return true;
  }

  /** The [সবাই উপস্থিত] button. Also the implicit opening state. */
  markAllPresent(): void {
    this.undoStack = this.order.map((id) => {
      const e = this.entries.get(id)!;
      return { studentId: id, status: e.status, touched: e.touched };
    });
    for (const id of this.order) {
      const e = this.entries.get(id)!;
      e.status = 'present';
      e.minutesLate = undefined;
      e.touched = true;
    }
    this.changed();
  }

  /** The 5-second snackbar. Undoes the last action, including markAllPresent. */
  undo(): boolean {
    if (this.undoStack.length === 0) return false;
    for (const u of this.undoStack) {
      const e = this.entries.get(u.studentId);
      if (!e) continue;
      e.status = u.status;
      e.touched = u.touched;
      if (u.status !== 'late') e.minutesLate = undefined;
    }
    this.undoStack = [];
    this.changed();
    return true;
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  counts(): GridCounts {
    const c: GridCounts = { total: this.order.length, present: 0, absent: 0, late: 0, excused: 0, untouched: 0 };
    for (const id of this.order) {
      const e = this.entries.get(id)!;
      c[e.status]++;
      if (!e.touched) c.untouched++;
    }
    return c;
  }

  entriesInOrder(): GridEntry[] {
    return this.order.map((id) => ({ ...this.entries.get(id)! }));
  }

  snapshot(): GridSnapshot {
    return { entries: this.entriesInOrder(), counts: this.counts(), dirty: this.changedSinceSave };
  }

  /**
   * Payload for @shikhon/offline enqueue(). Every student is included, always —
   * a partial register is worse than none, because the missing rows are
   * indistinguishable from "not yet marked".
   */
  toPayload(meta: {
    sessionId: string;
    sectionId: string;
    academicYearId: string;
    takenOn: string;
    periodNo?: number | null;
    routineSlotId?: string | null;
    subjectId?: string | null;
    mode?: 'section_daily' | 'period_wise';
  }) {
    return {
      ...meta,
      mode: meta.mode ?? 'section_daily',
      records: this.order.map((id) => {
        const e = this.entries.get(id)!;
        return {
          studentId: e.studentId,
          status: e.status,
          ...(e.status === 'late' && e.minutesLate !== undefined ? { minutesLate: e.minutesLate } : {}),
        };
      }),
    };
  }

  markSaved(at: number): void {
    this.savedAt = at;
    this.changedSinceSave = false;
    this.undoStack = [];
  }

  get lastSavedAt(): number | null {
    return this.savedAt;
  }

  /**
   * Accessibility label for a tile. Read verbatim by TalkBack, whose Bangla
   * TTS is poor — so this stays short and uses everyday words.
   */
  ariaLabel(studentId: string, locale: 'bn' | 'en' = 'bn'): string {
    const e = this.entries.get(studentId);
    if (!e) return '';
    const bn: Record<AttendanceStatus, string> = {
      present: 'উপস্থিত', absent: 'অনুপস্থিত', late: 'দেরি', excused: 'ছুটি',
    };
    const en: Record<AttendanceStatus, string> = {
      present: 'present', absent: 'absent', late: 'late', excused: 'excused',
    };
    return locale === 'bn'
      ? `রোল ${e.rollNo}, ${e.nameBn}, ${bn[e.status]}`
      : `Roll ${e.rollNo}, ${e.nameEn ?? e.nameBn}, ${en[e.status]}`;
  }

  private pushUndo(e: GridEntry): void {
    this.undoStack = [{ studentId: e.studentId, status: e.status, touched: e.touched }];
  }

  private changed(): void {
    this.changedSinceSave = true;
    this.onChange?.(this.snapshot());
  }
}
