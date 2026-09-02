/**
 * শিক্ষক হাজিরা — the staff register.  (M6)
 *
 * The register every school already keeps in a book by the office door, and
 * the one piece of data the substitute finder was missing: it has excluded
 * absent teachers since migration 006, and until migration 063 nothing in the
 * product could say who was absent.
 *
 * ── One screen, one decision per row ────────────────────────────────────
 * A date at the top and a list of teachers under it, each with three buttons.
 * No bulk actions, no "mark all present", no leave-balance column. A head
 * teacher does this once each morning against a list of thirty names, and the
 * fastest version of that is three fat targets per row, not a workflow.
 *
 * ── Marking is immediate, and says so ───────────────────────────────────
 * There is no save button. Each button POSTs on press and the row shows what
 * the server came back with — not what was clicked. A register that showed
 * the optimistic answer would show a mark that failed, which is worse than
 * showing nothing on a screen whose whole job is to be believed.
 *
 * ── Today is a Dhaka today ──────────────────────────────────────────────
 * `todayLocalIso()`, never `toISOString().slice(0,10)`. Between midnight and
 * 6am Dhaka the UTC date names YESTERDAY, and the register's key is
 * (teacher, date) — so an early-morning mark would silently overwrite the
 * previous day. P7 found exactly that on a form with the same shape.
 */
import type { Auth } from './auth.ts';
import { skeleton, errorState, emptyState, successNote, bnNum } from './view-states.ts';
import { ROLE_BN } from './ui/roles.ts';
import { pageHeader } from './ui/page-header.ts';
import { todayLocalIso } from '../../../packages/ui-core/src/format.ts';
import {
  el, append, button, buttonRow, field, dataTable, statCard, statRow,
  statusBadge, permissionState, permissionMessage,
} from './ui/index.ts';

interface TeacherRow {
  teacherId: string;
  name: { bn: string | null; en: string | null };
  roleCode: string;
  status: string | null;
  reason: string | null;
  markedAt: string | null;
  markedBy: string | null;
}

interface RegisterBody {
  date: string;
  canMark: boolean;
  total: number;
  marked: number;
  away: number;
  teachers: TeacherRow[];
}

export interface StaffAttendanceViewOptions {
  root: HTMLElement;
  doc: Document;
  auth: Auth;
}

/**
 * The three states, in the order the office thinks about them. `present`
 * first because it is the answer for most of the list.
 */
const CHOICES: Array<{ value: string; label: string }> = [
  { value: 'present',  label: 'উপস্থিত' },
  { value: 'absent',   label: 'অনুপস্থিত' },
  { value: 'on_leave', label: 'ছুটি' },
];

const STATUS_BN: Record<string, string> = {
  present: 'উপস্থিত', absent: 'অনুপস্থিত', on_leave: 'ছুটি',
};

export class StaffAttendanceView {
  private date = todayLocalIso();
  private data: RegisterBody | null = null;
  private loading = true;
  private denied = false;
  private error = '';
  private notice = '';
  /** The teacher whose row is mid-request, so only that row is disabled. */
  private busy = '';
  /** Reason text per teacher, kept while the drawer-less row is being edited. */
  private reasons = new Map<string, string>();

  constructor(private readonly o: StaffAttendanceViewOptions) {
    this.render();
    void this.load();
  }

  private async load(): Promise<void> {
    this.loading = true;
    this.error = '';
    this.render();
    try {
      const res = await this.o.auth.authedFetch(
        `/api/v1/ops/staff-attendance?date=${encodeURIComponent(this.date)}`);
      if (res.status === 403) { this.denied = true; this.loading = false; this.render(); return; }
      if (!res.ok) throw new Error(String(res.status));
      this.data = await res.json() as RegisterBody;
      this.reasons.clear();
      for (const t of this.data.teachers) if (t.reason) this.reasons.set(t.teacherId, t.reason);
    } catch {
      this.error = 'হাজিরা তালিকা আনা যায়নি।';
    } finally {
      this.loading = false;
      this.render();
    }
  }

  private async mark(teacherId: string, status: string): Promise<void> {
    this.busy = teacherId;
    this.notice = '';
    this.error = '';
    this.render();
    try {
      const res = await this.o.auth.authedFetch('/api/v1/ops/staff-attendance', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          teacherId, date: this.date, status,
          // A reason belongs to being away. Sending one with `present` would
          // leave "অসুস্থ" attached to a teacher who came in.
          reason: status === 'present' ? '' : (this.reasons.get(teacherId) ?? ''),
        }),
      });
      const body = await res.json() as { message?: string; nameBn?: string; status?: string; reason?: string | null };
      if (!res.ok) {
        this.error = body.message ?? 'হাজিরা লেখা যায়নি।';
        return;
      }
      // Take the server's answer, not the button that was pressed.
      const row = this.data?.teachers.find((t) => t.teacherId === teacherId);
      if (row && this.data) {
        const wasAway = row.status === 'absent' || row.status === 'on_leave';
        const isAway = body.status === 'absent' || body.status === 'on_leave';
        if (row.status === null) this.data.marked += 1;
        if (wasAway && !isAway) this.data.away -= 1;
        if (!wasAway && isAway) this.data.away += 1;
        row.status = body.status ?? null;
        row.reason = body.reason ?? null;
      }
      this.notice = `${body.nameBn ?? 'শিক্ষক'} — ${STATUS_BN[body.status ?? ''] ?? ''} লেখা হয়েছে।`;
    } catch {
      this.error = 'হাজিরা লেখা যায়নি।';
    } finally {
      this.busy = '';
      this.render();
    }
  }

  private render(): void {
    const d = this.o.doc;
    const root = this.o.root;
    root.textContent = '';

    root.append(pageHeader(d, {
      title: 'শিক্ষক হাজিরা',
      subtitle: 'কে এসেছেন, কে আসেননি — বিকল্প শিক্ষক খোঁজায় এটিই ব্যবহার হয়',
    }));

    // The refusal is the whole answer, and it comes before any control. A
    // date box and thirty rows of buttons above a 403 is an invitation to a
    // second refusal.
    if (this.denied) {
      root.append(permissionState(d, {
        message: permissionMessage('শিক্ষক হাজিরা'),
        contact: 'প্রধান শিক্ষক, প্রতিষ্ঠান মালিক ও আইটি অ্যাডমিন',
      }));
      return;
    }

    if (this.notice) root.append(successNote(d, this.notice));
    if (this.error) root.append(errorState(d, this.error, () => void this.load()));

    root.append(field(d, {
      label: 'তারিখ',
      name: 'date',
      kind: 'date',
      value: this.date,
      helper: 'অন্য দিনের হাজিরা দেখতে বা সংশোধন করতে তারিখ বদলান।',
      onChange: (v) => { if (!v) return; this.date = v; void this.load(); },
    }).root);

    if (this.loading) { root.append(skeleton(d, 5)); return; }

    const data = this.data;
    if (!data) return;

    if (data.teachers.length === 0) {
      root.append(emptyState(d, {
        message: 'এই প্রতিষ্ঠানে এখনো কোনো শিক্ষক যোগ করা হয়নি।',
      }));
      return;
    }

    root.append(this.summary(data));

    // Read-only staff get the register without the buttons. The server has
    // already said `canMark: false`, so this is not hidden UI standing in for
    // authorization — it is the screen agreeing with the answer it was given.
    const canMark = data.canMark;

    root.append(dataTable(d, {
      caption: 'শিক্ষকের হাজিরা তালিকা',
      rows: data.teachers,
      rowKey: (t) => t.teacherId,
      columns: [
        {
          key: 'name', header: 'নাম', mobile: 'title',
          cell: (t) => t.name.bn ?? t.name.en ?? 'নাম নেই',
          width: 'minmax(0, 2fr)',
        },
        {
          key: 'role', header: 'ভূমিকা', mobile: 'subtitle',
          cell: (t) => ROLE_BN[t.roleCode] ?? t.roleCode,
        },
        {
          key: 'status', header: 'অবস্থা', mobile: 'status',
          cell: (t) => t.status === null
            // Not "present". An unmarked teacher is a teacher nobody has
            // looked at yet, and the substitute finder treats it that way too.
            ? statusBadge(d, { state: 'pending', label: 'চিহ্নিত হয়নি' })
            : statusBadge(d, {
              state: t.status === 'present' ? 'published' : 'overdue',
              label: STATUS_BN[t.status] ?? t.status,
            }),
        },
        // Read-only staff see the reason as text. For anybody who can mark,
        // the box and the buttons are ONE cell: they are written in one
        // request, and on a phone the table collapses to a card where two
        // separate meta items are joined by a "·" — a stray dot beside a text
        // input, which reads as a defect.
        ...(canMark ? [] : [{
          key: 'reason', header: 'কারণ', mobile: 'meta' as const,
          cell: (t: TeacherRow) => t.reason ?? '—',
        }]),
        ...(canMark ? [{
          key: 'actions', header: 'চিহ্নিত করুন',
          cell: (t: TeacherRow) => this.markCell(t),
        }] : []),
      ],
    }));
  }

  /**
   * Three counts, so the office can see at a glance what is left to do.
   *
   * statCard/statRow rather than a row of spans: the first draft used two
   * class names this codebase does not have (`ui-filter-bar`, `ui-stack`), so
   * the counts rendered with no gap at all and read as "৫চিহ্নিত: ১". An
   * invented class name fails silently, which is exactly why the components
   * exist.
   */
  private summary(data: RegisterBody): HTMLElement {
    const d = this.o.doc;
    const left = data.total - data.marked;
    return statRow(d,
      statCard(d, { label: 'মোট শিক্ষক', value: bnNum(data.total), glyph: 'users' }),
      statCard(d, {
        label: 'চিহ্নিত', value: bnNum(data.marked), glyph: 'check-square',
        note: left > 0 ? `বাকি ${bnNum(left)} জন` : 'সবাইকে চিহ্নিত করা হয়েছে',
      }),
      statCard(d, {
        label: 'অনুপস্থিত ও ছুটি', value: bnNum(data.away), glyph: 'alert-triangle',
        tone: data.away > 0 ? 'warn' : 'primary',
      }));
  }

  private reasonBox(t: TeacherRow): HTMLElement {
    // Optional, and only meaningful when somebody is away — but it must be
    // fillable BEFORE the button is pressed, because the mark and the reason
    // are written in one request.
    return field(this.o.doc, {
      label: 'কারণ',
      name: `reason-${t.teacherId}`,
      value: this.reasons.get(t.teacherId) ?? '',
      placeholder: 'ঐচ্ছিক',
      attrs: { maxlength: 200 },
      disabled: this.busy === t.teacherId,
      onInput: (v) => { this.reasons.set(t.teacherId, v); },
    }).root;
  }

  /** The reason and the three buttons, together, because they are one write. */
  private markCell(t: TeacherRow): HTMLElement {
    // .ui-fieldset is the codebase's column stack with a gap — this cell is a
    // field plus its buttons, which is what that utility is for.
    const wrap = el(this.o.doc, 'div', { className: 'ui-fieldset' });
    append(wrap, this.reasonBox(t), this.rowButtons(t));
    return wrap;
  }

  private rowButtons(t: TeacherRow): HTMLElement {
    const d = this.o.doc;
    const wrap = buttonRow(d);
    for (const c of CHOICES) {
      append(wrap, button(d, {
        label: c.label,
        // The current state is the filled button, so the row reads as an
        // answer rather than as three open questions.
        variant: t.status === c.value ? 'primary' : 'secondary',
        disabled: this.busy === t.teacherId,
        onClick: () => { void this.mark(t.teacherId, c.value); },
      }));
    }
    return wrap;
  }
}
