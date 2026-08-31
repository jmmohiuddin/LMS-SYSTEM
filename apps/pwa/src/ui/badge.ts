/**
 * Badges and status. (P2)
 *
 * There are two different things here that look alike and must not be merged:
 *
 *   **Badge** is a label. "৪র্থ শ্রেণি", "বিজ্ঞান", "CQ". It carries no state
 *   and no urgency, and it is decoration around text that is already there.
 *
 *   **StatusBadge** is a *value*. "প্রকাশিত", "বকেয়া", "স্থগিত". It is the
 *   answer to a question the reader is asking, and 04-UIUX §5 forbids
 *   answering it with colour alone — so every status carries a word, and the
 *   ones that mean trouble carry a glyph as well.
 *
 * The colour-alone rule is not theoretical here. A fee row that says "overdue"
 * only by being red is unreadable to a colour-blind guardian, invisible in the
 * printed receipt, and meaningless to a screen reader — three failures from
 * one shortcut.
 */
import { el, icon, append } from './dom.ts';

export type BadgeTone = 'neutral' | 'primary' | 'info' | 'success' | 'warn' | 'danger';

/** A plain label. No state, no announcement. */
export function badge(doc: Document, o: {
  label: string;
  tone?: BadgeTone;
  glyph?: string;
  className?: string;
}): HTMLElement {
  const b = el(doc, 'span', {
    className: ['ui-badge', o.className ?? ''].filter(Boolean).join(' '),
    data: { tone: o.tone ?? 'neutral' },
  });
  if (o.glyph) append(b, icon(doc, o.glyph, 'ui-badge-glyph'));
  append(b, el(doc, 'span', { text: o.label }));
  return b;
}

/**
 * The canonical states, and what each one is called.
 *
 * Defined here rather than at each call site so "published" is the same word
 * and the same colour on the results screen, the audit log and the printed
 * report — and so a new screen cannot quietly invent a seventh state.
 */
export const STATUS: Record<string, { tone: BadgeTone; glyph?: string }> = {
  active:    { tone: 'success' },
  published: { tone: 'success' },
  paid:      { tone: 'success' },
  present:   { tone: 'success' },
  synced:    { tone: 'success' },
  draft:     { tone: 'neutral' },
  pending:   { tone: 'neutral' },
  queued:    { tone: 'neutral', glyph: 'clock' },
  invited:   { tone: 'info' },
  partial:   { tone: 'warn' },
  due:       { tone: 'warn', glyph: 'clock' },
  late:      { tone: 'warn', glyph: 'clock' },
  overdue:   { tone: 'danger', glyph: 'alert-triangle' },
  absent:    { tone: 'danger' },
  failed:    { tone: 'danger', glyph: 'alert-triangle' },
  suspended: { tone: 'danger', glyph: 'alert-triangle' },
};

export interface StatusOptions {
  /** A key from STATUS, or a free tone for a state this table does not know. */
  state: keyof typeof STATUS | string;
  /** The word a person reads. Always required — colour is never the message. */
  label: string;
  tone?: BadgeTone;
  className?: string;
}

/**
 * A state, spelled out.
 *
 * Not `role="status"`: these render inside lists and tables, dozens at a time,
 * and a live region per row would make a screen reader read the whole table
 * aloud on every refresh. A status that CHANGES in front of the user is
 * announced by the view that changed it, through `announce()` in feedback.ts.
 */
export function statusBadge(doc: Document, o: StatusOptions): HTMLElement {
  const known = STATUS[o.state];
  return badge(doc, {
    label: o.label,
    tone: o.tone ?? known?.tone ?? 'neutral',
    glyph: known?.glyph,
    className: ['ui-status', o.className ?? ''].filter(Boolean).join(' '),
  });
}

/**
 * A count on a control — the bell's unread, a tab's pending items.
 *
 * Zero renders nothing at all rather than a "0": a badge showing zero is a
 * decoration that says "no news" in the loudest way available. Above 9 it
 * caps, because three digits do not fit and the exact number has stopped
 * being actionable by then.
 */
export function countBadge(doc: Document, count: number, label: string): HTMLElement | null {
  const n = Math.max(0, Math.floor(count));
  if (n === 0) return null;
  return el(doc, 'span', {
    className: 'ui-count',
    text: n > 9 ? '৯+' : bnDigits(n),
    attrs: { 'aria-label': `${label} — ${n}` },
  });
}

/** Latin digits to Bangla. Local to avoid a cycle with view-states.ts. */
function bnDigits(n: number): string {
  return String(n).replace(/\d/g, (d) => '০১২৩৪৫৬৭৮৯'[Number(d)]);
}
