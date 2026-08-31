/**
 * The button system. (P2)
 *
 * Before this there were 130 hand-typed class strings across 44 view modules —
 * `btn-primary`, `btn-secondary`, `btn-ghost btn-small`, `btn-primary
 * btn-inline` — and nothing enforced the two properties that actually matter:
 *
 *   1. **`type="button"`.** A `<button>` inside a `<form>` defaults to
 *      `type="submit"`. Every "cancel" and "add another row" control written
 *      without it submits the form instead. This module sets it always, and a
 *      submit button has to ask.
 *   2. **A busy button cannot be pressed twice.** The brief's §17 rule ("never
 *      allow double-submit") cannot be met by remembering it at 130 call
 *      sites. `busy` here disables the control, keeps its width so the layout
 *      does not jump, swaps the label for a spinner, and announces itself.
 *
 * ── The hierarchy, and what each level means ───────────────────────────────
 * `primary`   the one action this screen exists for. At most one per view.
 * `secondary` an alternative that is not the point — cancel, back, export.
 * `ghost`     low-priority, in a row of them: filters, table row actions.
 * `danger`    destructive and irreversible. Delete, revoke, remove.
 * `success`   only where the semantics are genuinely "this completed" —
 *             "সব উপস্থিত", not "save".
 *
 * `danger` is deliberately not a colour swap on `primary`: a destructive
 * button that looks like the primary one is how a person deletes a section
 * while reaching for "save".
 */
import { el, icon, type Child } from './dom.ts';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'success';
export type ButtonSize = 'md' | 'sm';

export interface ButtonOptions {
  label: string;
  onClick?: (e: Event) => void;
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Icon name from ../icon.ts, rendered before the label. */
  glyph?: string;
  disabled?: boolean;
  /** In flight: disabled, spinner in place of the glyph, announced. */
  busy?: boolean;
  /** Fill the container. The default is intrinsic width. */
  block?: boolean;
  /** `submit` only where the button really is a form's submit control. */
  type?: 'button' | 'submit';
  /** Extra classes for one-off placement (e.g. `att-save`). Not for restyling. */
  className?: string;
  /** Overrides the accessible name. Only for icon-only buttons. */
  ariaLabel?: string;
  attrs?: Record<string, string | number | boolean | null | undefined>;
}

const VARIANT: Record<ButtonVariant, string> = {
  primary: 'btn-primary',
  secondary: 'btn-secondary',
  ghost: 'btn-ghost',
  danger: 'btn-danger',
  success: 'btn-success',
};

export function button(doc: Document, o: ButtonOptions): HTMLButtonElement {
  const cls = [
    // `ui-btn` is a marker, not a look: it resets the `width: 100%` that
    // `.btn-primary` and `.btn-success` have carried since the app was
    // phone-only. Those two have never had an intrinsic-width form, so a
    // "save" in a table row or a page header stretched the whole column.
    // Scoped to this marker so the 130 legacy call sites keep the full-width
    // bar they were written for until their screen's phase migrates them.
    'ui-btn',
    VARIANT[o.variant ?? 'secondary'],
    o.size === 'sm' ? 'btn-small' : '',
    o.block ? 'btn-block' : '',
    o.className ?? '',
  ].filter(Boolean).join(' ');

  const btn = el(doc, 'button', {
    className: cls,
    attrs: {
      // Always explicit. The default is `submit`, and a "cancel" that submits
      // the form is the bug this line exists to make impossible.
      type: o.type ?? 'button',
      'aria-label': o.ariaLabel ?? null,
      ...(o.attrs ?? {}),
    },
  });

  const label = el(doc, 'span', { className: 'btn-label', text: o.label });
  if (o.glyph) btn.append(icon(doc, o.glyph, 'btn-glyph'));
  btn.append(label);

  if (o.onClick) btn.addEventListener('click', o.onClick);
  setBusy(btn, o.busy ?? false);
  if (o.disabled) btn.disabled = true;
  return btn;
}

/**
 * Put a button into (or out of) its busy state.
 *
 * Exported because the common case is a button that becomes busy on click and
 * stops when the request answers — recreating the element would lose focus
 * mid-action, which on a phone means the keyboard closes.
 *
 * The width is pinned before the label is replaced. Without that, a 96px
 * "সংরক্ষণ করুন" becomes a 32px spinner and every control to its right jumps
 * left — on a form that is merely ugly, on a row of table actions it means the
 * next button slides under the finger already travelling towards it.
 */
export function setBusy(btn: HTMLButtonElement, busy: boolean): void {
  const doc = btn.ownerDocument;
  if (busy) {
    if (btn.dataset.busy === 'true') return;
    const w = btn.getBoundingClientRect().width;
    if (w > 0) btn.style.minWidth = `${Math.round(w)}px`;
    btn.dataset.busy = 'true';
    btn.disabled = true;
    // aria-busy, not a visually-hidden "loading" string: the button keeps its
    // accessible name, and a reader that supports aria-busy says the rest.
    btn.setAttribute('aria-busy', 'true');
    const spin = el(doc, 'span', {
      className: 'btn-spinner', attrs: { 'aria-hidden': 'true' },
    });
    btn.querySelector('.btn-glyph')?.remove();
    btn.prepend(spin);
  } else {
    if (btn.dataset.busy !== 'true') return;
    delete btn.dataset.busy;
    btn.disabled = false;
    btn.removeAttribute('aria-busy');
    btn.style.minWidth = '';
    btn.querySelector('.btn-spinner')?.remove();
  }
}

/**
 * Run an async action with the button busy for its duration, once.
 *
 * This is the double-submit guard as a function rather than as a rule people
 * remember. A second click while the first is in flight does nothing, and the
 * button is restored whether the action resolves or throws — a failed save
 * that leaves a permanently disabled button is a screen a teacher has to
 * reload, losing the register.
 */
export function onClickBusy(
  btn: HTMLButtonElement,
  action: () => Promise<void>,
  onError?: (err: unknown) => void,
): void {
  btn.addEventListener('click', async () => {
    if (btn.dataset.busy === 'true') return;
    setBusy(btn, true);
    try {
      await action();
    } catch (err) {
      // Caught, never rethrown. An async event listener that rejects produces
      // an unhandled rejection with no stack the caller can act on, and in a
      // service-worker-controlled page that is a console entry nobody sees.
      // Callers that care pass `onError`; callers that forget still get a
      // restored button and a logged cause rather than a silent dead control.
      if (onError) onError(err);
      else console.error('[ui] button action failed', err);
    } finally {
      setBusy(btn, false);
    }
  });
}

/**
 * An icon-only control.
 *
 * `label` is required and becomes the accessible name — an icon-only button
 * with no name is the single most common accessibility defect in an
 * application like this, and there is no way to add one later from the outside.
 * `title` too, so a mouse user gets the same word a screen reader does.
 */
export function iconButton(doc: Document, o: {
  glyph: string;
  label: string;
  onClick?: (e: Event) => void;
  variant?: 'ghost' | 'danger';
  className?: string;
  disabled?: boolean;
}): HTMLButtonElement {
  const btn = el(doc, 'button', {
    className: ['ui-icon-btn', o.variant === 'danger' ? 'is-danger' : '', o.className ?? '']
      .filter(Boolean).join(' '),
    attrs: { type: 'button', 'aria-label': o.label, title: o.label },
  }, icon(doc, o.glyph));
  if (o.onClick) btn.addEventListener('click', o.onClick);
  if (o.disabled) btn.disabled = true;
  return btn;
}

/**
 * A row of buttons with one primary.
 *
 * Order is the point, and it is ONE order: DOM order is priority order, least
 * important first. On a phone that column puts the primary at the bottom,
 * under the thumb; on desktop the same source order becomes a row and the
 * primary finishes the line on the right. Callers pass "cancel, save" and the
 * layout is right in both places without a second rule.
 */
export function buttonRow(doc: Document, ...children: Child[]): HTMLElement {
  return el(doc, 'div', { className: 'ui-button-row' }, ...children);
}
