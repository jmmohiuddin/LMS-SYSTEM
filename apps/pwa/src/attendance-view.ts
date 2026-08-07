/**
 * The attendance grid, rendered.
 *
 * Deliberately framework-free: the whole critical path is budgeted at 180 KB
 * gzipped, and this screen is ~4 KB of DOM code. It binds an AttendanceGrid
 * (state) to a SyncEngine (durability) and never awaits the network.
 *
 * Layout follows docs/04-UIUX-ACCESSIBILITY.md §4.1.
 */
import { AttendanceGrid, type Student, type GridSnapshot } from '../../../packages/ui-core/src/attendance-grid.ts';
import { formatCount, formatDayMonth } from '../../../packages/ui-core/src/format.ts';

export interface SaveResult {
  opId: string;
  queued: boolean;
  /**
   * Resolves when the background flush attempt settles (success OR failure).
   * The UI ignores it — that is the point of the design — but a "sync now"
   * button, or a test, needs to know when the attempt finished. Without this
   * the engine's single-flight mutex silently collapses a caller's own flush
   * into the one already running.
   */
  flushed: Promise<void>;
}

/** Only what this view needs from @shikhon/offline — keeps it testable. */
export interface OutboxLike {
  enqueue(input: {
    entity: 'attendance_session';
    opId?: string;
    payload: unknown;
  }): Promise<{ opId: string }>;
  flush(): Promise<unknown>;
  state(): Promise<{ pending: number; failed: number; conflicts: number; lastSyncAt?: number }>;
}

export interface AttendanceViewOptions {
  root: HTMLElement;
  doc: Document;
  students: Student[];
  section: { id: string; labelBn: string; academicYearId: string };
  takenOn: string;
  periodNo?: number | null;
  subjectBn?: string;
  locale?: 'bn' | 'en';
  outbox: OutboxLike;
  newId: () => string;
  now?: () => number;
}

const STATUS_GLYPH = { present: '✓', absent: '✗', late: '⏱', excused: '⌂' } as const;

export class AttendanceView {
  private readonly o: AttendanceViewOptions;
  private readonly grid: AttendanceGrid;
  private readonly locale: 'bn' | 'en';
  private tiles = new Map<string, HTMLButtonElement>();
  private countsEl!: HTMLElement;
  private chipEl!: HTMLElement;
  private undoEl!: HTMLElement;

  constructor(options: AttendanceViewOptions) {
    this.o = options;
    this.locale = options.locale ?? 'bn';
    this.grid = new AttendanceGrid({
      students: options.students,
      onChange: (s) => this.onGridChange(s),
    });
    this.render();
  }

  /* ------------------------------------------------------------ render */

  private render(): void {
    const d = this.o.doc;
    const root = this.o.root;
    root.textContent = '';
    root.setAttribute('lang', this.locale);

    // Header
    const header = d.createElement('header');
    header.className = 'att-header';
    const h1 = d.createElement('h1');
    h1.textContent = this.locale === 'bn' ? 'হাজিরা' : 'Attendance';
    const sub = d.createElement('p');
    sub.className = 'att-sub';
    sub.textContent = [
      this.o.section.labelBn,
      this.o.subjectBn,
      formatDayMonth(this.o.takenOn, this.locale),
    ].filter(Boolean).join(' · ');
    this.chipEl = d.createElement('span');
    this.chipEl.className = 'sync-chip';
    this.chipEl.setAttribute('aria-live', 'polite');
    header.append(h1, sub, this.chipEl);

    // Live counters — aria-live so a screen-reader user hears the tally change
    this.countsEl = d.createElement('div');
    this.countsEl.className = 'att-counts';
    this.countsEl.setAttribute('aria-live', 'polite');

    const markAll = d.createElement('button');
    markAll.type = 'button';
    markAll.className = 'btn-secondary';
    markAll.textContent = this.locale === 'bn' ? 'সবাই উপস্থিত' : 'All present';
    markAll.addEventListener('click', () => this.grid.markAllPresent());

    // Grid — role=group of checkbox-like tiles, arrow-key navigable
    const grid = d.createElement('div');
    grid.className = 'att-grid';
    grid.setAttribute('role', 'group');
    grid.setAttribute('aria-label', this.locale === 'bn' ? 'শিক্ষার্থী তালিকা' : 'Student list');

    for (const e of this.grid.entriesInOrder()) {
      const tile = d.createElement('button');
      tile.type = 'button';
      tile.className = 'tile';
      tile.dataset.studentId = e.studentId;
      tile.dataset.status = e.status;
      tile.setAttribute('role', 'checkbox');
      tile.setAttribute('aria-checked', String(e.status === 'present'));
      tile.setAttribute('aria-label', this.grid.ariaLabel(e.studentId, this.locale));

      const roll = d.createElement('span');
      roll.className = 'tile-roll';
      roll.textContent = formatCount(e.rollNo, this.locale);
      const glyph = d.createElement('span');
      glyph.className = 'tile-glyph';
      glyph.setAttribute('aria-hidden', 'true'); // the label already says the status
      glyph.textContent = STATUS_GLYPH[e.status];
      tile.append(roll, glyph);

      tile.addEventListener('click', () => this.grid.cycle(e.studentId));
      tile.addEventListener('keydown', (ev) => this.onTileKey(ev as KeyboardEvent, e.studentId));

      this.tiles.set(e.studentId, tile);
      grid.append(tile);
    }

    // Sticky save + undo
    const footer = d.createElement('footer');
    footer.className = 'att-footer';
    const save = d.createElement('button');
    save.type = 'button';
    save.className = 'btn-primary';
    save.dataset.action = 'save';
    save.textContent = this.locale === 'bn' ? 'সংরক্ষণ করুন' : 'Save';
    save.addEventListener('click', () => { void this.save(); });

    this.undoEl = d.createElement('div');
    this.undoEl.className = 'snackbar';
    this.undoEl.hidden = true;
    this.undoEl.setAttribute('role', 'status');
    footer.append(save, this.undoEl);

    root.append(header, this.countsEl, markAll, grid, footer);
    this.paintCounts();
    void this.paintChip();
  }

  /* ----------------------------------------------------------- updates */

  private onGridChange(s: GridSnapshot): void {
    for (const e of s.entries) {
      const tile = this.tiles.get(e.studentId);
      if (!tile) continue;
      if (tile.dataset.status !== e.status) {
        tile.dataset.status = e.status;
        tile.setAttribute('aria-checked', String(e.status === 'present'));
        tile.setAttribute('aria-label', this.grid.ariaLabel(e.studentId, this.locale));
        const glyph = tile.querySelector('.tile-glyph');
        if (glyph) glyph.textContent = STATUS_GLYPH[e.status];
      }
    }
    this.paintCounts();
  }

  private paintCounts(): void {
    const c = this.grid.counts();
    this.countsEl.textContent =
      this.locale === 'bn'
        ? `উপস্থিত ${formatCount(c.present, 'bn')}   অনুপস্থিত ${formatCount(c.absent, 'bn')}   দেরি ${formatCount(c.late, 'bn')}`
        : `Present ${c.present}   Absent ${c.absent}   Late ${c.late}`;
  }

  /** The ⚡ chip: queued-op count and last sync. Never blocks anything. */
  async paintChip(): Promise<void> {
    const s = await this.o.outbox.state();
    if (s.pending === 0 && s.failed === 0) {
      this.chipEl.textContent = this.locale === 'bn' ? 'সিঙ্ক হয়েছে' : 'Synced';
      this.chipEl.dataset.state = 'synced';
    } else if (s.failed > 0) {
      this.chipEl.textContent =
        this.locale === 'bn'
          ? `${formatCount(s.failed, 'bn')}টি পাঠানো যায়নি`
          : `${s.failed} could not sync`;
      this.chipEl.dataset.state = 'failed';
    } else {
      this.chipEl.textContent =
        this.locale === 'bn'
          ? `⚡ ${formatCount(s.pending, 'bn')}টি অপেক্ষমাণ`
          : `⚡ ${s.pending} queued`;
      this.chipEl.dataset.state = 'queued';
    }
  }

  /* -------------------------------------------------------------- save */

  /**
   * Writes to the outbox and returns. The network is attempted afterwards and
   * is allowed to fail — that is the whole point of the design.
   */
  async save(): Promise<SaveResult> {
    const sessionId = this.o.newId();
    const payload = this.grid.toPayload({
      sessionId,
      sectionId: this.o.section.id,
      academicYearId: this.o.section.academicYearId,
      takenOn: this.o.takenOn,
      periodNo: this.o.periodNo ?? null,
      mode: this.o.periodNo == null ? 'section_daily' : 'period_wise',
    });

    const op = await this.o.outbox.enqueue({
      entity: 'attendance_session',
      opId: sessionId,           // op id IS the session id — one row, one op
      payload,
    });

    this.grid.markSaved((this.o.now ?? Date.now)());
    this.showUndo();

    // Fire-and-forget from the UI's perspective. A rejection here is normal
    // offline and must not surface as an unhandled rejection or an error toast.
    const flushed = Promise.resolve(this.o.outbox.flush())
      .catch(() => {})
      .then(() => this.paintChip());

    await this.paintChip();

    return { opId: op.opId, queued: true, flushed };
  }

  private showUndo(): void {
    this.undoEl.hidden = false;
    this.undoEl.textContent = this.locale === 'bn' ? 'সংরক্ষিত' : 'Saved';
  }

  /* ------------------------------------------------------- keyboard a11y */

  private onTileKey(ev: KeyboardEvent, studentId: string): void {
    const order = this.grid.entriesInOrder().map((e) => e.studentId);
    const i = order.indexOf(studentId);
    const COLUMNS = 5; // matches the 360px layout
    let next = -1;

    switch (ev.key) {
      case ' ': case 'Enter': ev.preventDefault(); this.grid.cycle(studentId); return;
      case 'ArrowRight': next = i + 1; break;
      case 'ArrowLeft':  next = i - 1; break;
      case 'ArrowDown':  next = i + COLUMNS; break;
      case 'ArrowUp':    next = i - COLUMNS; break;
      case 'Home':       next = 0; break;
      case 'End':        next = order.length - 1; break;
      default: return;
    }
    ev.preventDefault();
    if (next < 0 || next >= order.length) return;
    this.tiles.get(order[next])?.focus();
  }

  /* ------------------------------------------------------------ testing */

  get state() {
    return this.grid.snapshot();
  }
}
