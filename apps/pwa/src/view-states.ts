/**
 * The four states every screen owes its user.  (R-3, D13)
 *
 * D13 makes loading, empty, error and success part of the definition of done
 * rather than polish. Eight new R-3 screens would otherwise be eight slightly
 * different renderings of the same four moments — and the one that got
 * skipped would be the empty state, which is what a school sees on its FIRST
 * DAY, when every table is empty and nothing has gone wrong.
 *
 * These are thin builders over the classes already in app.css (`.skel`,
 * `.empty-state`, `.login-error`, `.status-chip`). No new visual language, no
 * new tokens — the point is consistency with what R-1 and R-2 already look
 * like, not a component library.
 */

/**
 * A skeleton, not a spinner.
 *
 * A spinner says "wait"; a skeleton says "this is what is coming, and roughly
 * how much of it". On the reference network — a 2 GB Android phone on 2G —
 * that difference is several seconds of a person deciding whether the app is
 * broken.
 */
export function skeleton(doc: Document, rows = 3): HTMLElement {
  const wrap = doc.createElement('div');
  wrap.className = 'is-skeleton';
  wrap.style.padding = 'var(--s-4)';
  wrap.setAttribute('aria-busy', 'true');
  // Screen readers get a word; sighted users get the shape. Announcing every
  // grey bar would be noise.
  wrap.setAttribute('aria-label', 'লোড হচ্ছে');
  const title = doc.createElement('div');
  title.className = 'skel skel-title';
  wrap.append(title);
  for (let i = 0; i < rows; i++) {
    const line = doc.createElement('div');
    line.className = 'skel skel-bar';
    wrap.append(line);
  }
  return wrap;
}

export interface EmptyOptions {
  /** An icon name from ./icon.ts — never an emoji. */
  glyph?: string;
  message: string;
  /** Optional way out. An empty state that only says "nothing here" wastes the moment. */
  action?: { label: string; onClick: () => void };
}

/**
 * Empty is a state, not an absence.
 *
 * Every message passed in should say what is missing AND what would fill it.
 * "No sections yet" leaves a person looking at a wall; "no sections in this
 * class yet — add one to start enrolling students" tells them what this screen
 * is for.
 */
export function emptyState(doc: Document, o: EmptyOptions): HTMLElement {
  const wrap = doc.createElement('div');
  wrap.className = 'empty-state';
  if (o.glyph) {
    const g = doc.createElement('span');
    g.className = 'empty-glyph';
    g.setAttribute('aria-hidden', 'true');
    // Imported lazily by the caller when it wants an icon; a plain dot keeps
    // this module free of an import cycle with icon.ts.
    g.textContent = '·';
    wrap.append(g);
  }
  const p = doc.createElement('p');
  p.textContent = o.message;
  wrap.append(p);
  if (o.action) {
    const btn = doc.createElement('button');
    btn.type = 'button';
    btn.className = 'btn-secondary';
    btn.textContent = o.action.label;
    btn.addEventListener('click', o.action.onClick);
    wrap.append(btn);
  }
  return wrap;
}

/**
 * An error a person can act on.
 *
 * role="alert" so it is announced. The retry button is not optional where a
 * retry is meaningful: on this product's network most errors are a tunnel, and
 * the correct response is to try again in ten seconds, not to navigate away
 * and lose the form.
 */
export function errorState(
  doc: Document,
  message: string,
  onRetry?: () => void,
): HTMLElement {
  const wrap = doc.createElement('div');
  wrap.style.padding = 'var(--s-4)';
  const p = doc.createElement('p');
  p.className = 'login-error';
  p.setAttribute('role', 'alert');
  p.textContent = message;
  wrap.append(p);
  if (onRetry) {
    const btn = doc.createElement('button');
    btn.type = 'button';
    btn.className = 'btn-secondary';
    btn.textContent = 'আবার চেষ্টা করুন';
    btn.addEventListener('click', onRetry);
    wrap.append(btn);
  }
  return wrap;
}

/**
 * Confirmation after a mutation.
 *
 * `aria-live="polite"` rather than `role="alert"`: success should be
 * announced without interrupting, and interrupting a screen reader to say
 * "saved" is worse than saying it a beat later.
 */
export function successNote(doc: Document, message: string): HTMLElement {
  const p = doc.createElement('p');
  p.className = 'status-chip';
  p.setAttribute('data-state', 'success');
  p.setAttribute('aria-live', 'polite');
  p.style.margin = 'var(--s-3) var(--s-4)';
  p.textContent = message;
  return p;
}

/**
 * A confirmation dialogue for the things that cannot be undone.
 *
 * R-3 has five: replacing a teacher, moving students in bulk, committing a
 * promotion, publishing results, and generating invoices. Each one either
 * changes what a whole school sees or spends its money, and none has an undo
 * button — so each one gets a sentence naming the actual consequence, with
 * the numbers in it, before it happens.
 *
 * Deliberately not `window.confirm`: it cannot say "168 students will be
 * promoted", it is unstyled, and on Android it is easy to dismiss by accident.
 * This renders inline, defaults focus to Cancel, and closes on Escape.
 */
export interface ConfirmOptions {
  doc: Document;
  title: string;
  /** Say what will happen, with the numbers. Not "are you sure?". */
  body: string;
  confirmLabel: string;
  cancelLabel?: string;
  /** Marks the confirm button as destructive rather than routine. */
  danger?: boolean;
  onConfirm: () => void;
  onCancel?: () => void;
}

export function confirmDialog(o: ConfirmOptions): HTMLElement {
  const d = o.doc;
  const wrap = d.createElement('div');
  wrap.className = 'card notice-confirm';
  wrap.setAttribute('role', 'alertdialog');
  wrap.setAttribute('aria-modal', 'false');
  wrap.style.margin = 'var(--s-3) var(--s-4)';

  const h = d.createElement('p');
  h.className = 'notice-confirm-label';
  h.textContent = o.title;

  const body = d.createElement('p');
  body.className = 'notice-confirm-line';
  body.textContent = o.body;

  const row = d.createElement('div');
  row.className = 'action-row';

  // Cancel first in the DOM, so the first thing focus and a screen reader
  // reach on an irreversible dialogue is the way out.
  const cancel = d.createElement('button');
  cancel.type = 'button';
  cancel.className = 'btn-secondary';
  cancel.textContent = o.cancelLabel ?? 'বাতিল';
  cancel.addEventListener('click', () => { wrap.remove(); o.onCancel?.(); });

  const ok = d.createElement('button');
  ok.type = 'button';
  ok.className = o.danger ? 'btn-primary' : 'btn-primary';
  if (o.danger) ok.setAttribute('data-danger', 'true');
  ok.textContent = o.confirmLabel;
  ok.addEventListener('click', () => { wrap.remove(); o.onConfirm(); });

  row.append(cancel, ok);
  wrap.append(h, body, row);

  wrap.addEventListener('keydown', (e) => {
    if ((e as KeyboardEvent).key === 'Escape') { wrap.remove(); o.onCancel?.(); }
  });
  // Deferred so the caller can append it before focus moves.
  queueMicrotask(() => cancel.focus());

  return wrap;
}

/** Bangla digits. A screen that counts in Bangla must count in Bangla throughout. */
export function bnNum(n: number | string): string {
  return String(n).replace(/\d/g, (d) => '০১২৩৪৫৬৭৮৯'[Number(d)]);
}

/**
 * A date a Bangladeshi school reads.
 *
 * Found in the browser, not in a test: the section screen was printing
 * `2026-01-05` next to `৪০ জন` and `৫ বিষয় শিক্ষক`. Every number around it was
 * Bangla and the date was ISO, which reads as a debug value that escaped —
 * and on the assignment-history rows, the dates are the whole point of the
 * record. jsdom's Intl is enough to catch a crash but not to catch this;
 * only looking at it was.
 *
 * Falls back to the raw string rather than throwing: a date this cannot parse
 * is still information, and an assignment history that renders "Invalid Date"
 * where a teacher's tenure should be is worse than one that shows the raw
 * value.
 */
export function bnDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  try {
    return new Date(t).toLocaleDateString('bn-BD', {
      day: 'numeric', month: 'long', year: 'numeric',
    });
  } catch {
    return iso;
  }
}
