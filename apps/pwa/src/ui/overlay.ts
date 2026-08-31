/**
 * Modals, drawers and bottom sheets — one implementation. (P2)
 *
 * §18: the right interaction for the device. A 640px-wide modal centred on a
 * 360px phone is the single most common failure of a shared component system,
 * and it happens because "modal" gets built first and "sheet" gets added later
 * as a different thing. Here there is one overlay with a `kind`, and `auto`
 * resolves to a **centred modal on desktop and a bottom sheet on a phone** —
 * the same content, presented the way each device expects.
 *
 * ── Why this is hand-rolled and not `<dialog>` ─────────────────────────────
 * `<dialog showModal()>` gives a focus trap, a top layer and a backdrop for
 * free, and on a current browser it is the right answer. The reference device
 * for this product is not a current browser: 04-UIUX targets a 2 GB Android Go
 * phone, where the WebView can be years behind the phone, and a dialog that
 * silently renders inline — unstyled, untrapped, dismissable only by the back
 * button — is worse than no dialog. The trap below is forty lines and works
 * everywhere.
 *
 * ── What a focus trap has to get right ─────────────────────────────────────
 *   1. Focus moves IN on open — to the first control, or to the close button
 *      if there is none, never left behind the backdrop.
 *   2. Tab cycles inside and cannot escape, in both directions.
 *   3. Escape closes, from anywhere inside.
 *   4. Focus RETURNS to whatever opened it. A phone user who dismisses a sheet
 *      and finds focus at the top of the document has lost their place in a
 *      sixty-row register.
 *   5. The rest of the page is `aria-hidden` while it is open, or a screen
 *      reader wanders out of the dialog into the page behind it.
 */
import { el, icon, append, uid, clear, type Child } from './dom.ts';
import { button, buttonRow } from './button.ts';

export type OverlayKind = 'auto' | 'modal' | 'drawer' | 'sheet';

export interface OverlayOptions {
  title: string;
  /** Body content. Built by the caller — this module only frames it. */
  body: Child | Child[];
  kind?: OverlayKind;
  /** Footer controls. Rendered in a `buttonRow`; primary goes last. */
  actions?: Child[];
  /** Called after the overlay is removed, however it was dismissed. */
  onClose?: () => void;
  /** Set false for a decision that must be made (a confirm). Default true. */
  dismissible?: boolean;
  /** `alertdialog` for destructive confirmations — announced more insistently. */
  alert?: boolean;
  className?: string;
  /** Where to mount. Defaults to `document.body`. */
  mount?: HTMLElement;
}

export interface OverlayHandle {
  /** The dialog element, for tests and for patching content in place. */
  el: HTMLElement;
  close(): void;
}

const FOCUSABLE = [
  'a[href]', 'button:not([disabled])', 'input:not([disabled])',
  'select:not([disabled])', 'textarea:not([disabled])', '[tabindex]:not([tabindex="-1"])',
].join(',');

export function openOverlay(doc: Document, o: OverlayOptions): OverlayHandle {
  const mount = o.mount ?? doc.body;
  const opener = doc.activeElement as HTMLElement | null;
  const titleId = uid('dlg');
  const dismissible = o.dismissible !== false;

  const scrim = el(doc, 'div', {
    className: 'ui-scrim', data: { kind: o.kind ?? 'auto' },
  });
  const dialog = el(doc, 'div', {
    className: ['ui-dialog', o.className ?? ''].filter(Boolean).join(' '),
    attrs: {
      role: o.alert ? 'alertdialog' : 'dialog',
      'aria-modal': 'true',
      'aria-labelledby': titleId,
      tabindex: '-1',
    },
  });

  const head = el(doc, 'div', { className: 'ui-dialog-head' },
    el(doc, 'h2', { className: 'ui-dialog-title', text: o.title, attrs: { id: titleId } }));
  if (dismissible) {
    const x = el(doc, 'button', {
      className: 'ui-dialog-close',
      attrs: { type: 'button', 'aria-label': 'বন্ধ করুন' },
    }, icon(doc, 'x'));
    x.addEventListener('click', () => close());
    append(head, x);
  }

  const body = el(doc, 'div', { className: 'ui-dialog-body' });
  append(body, ...(Array.isArray(o.body) ? o.body : [o.body]));

  append(dialog, head, body);
  if (o.actions?.length) {
    append(dialog, el(doc, 'div', { className: 'ui-dialog-foot' },
      buttonRow(doc, ...o.actions)));
  }
  append(scrim, dialog);

  // Everything else on the page is hidden from readers for the duration. The
  // siblings are recorded so restoring cannot clobber an aria-hidden that was
  // already there for another reason.
  const hidden: Array<[HTMLElement, string | null]> = [];
  for (const sib of Array.from(mount.children) as HTMLElement[]) {
    hidden.push([sib, sib.getAttribute('aria-hidden')]);
    sib.setAttribute('aria-hidden', 'true');
  }
  mount.append(scrim);
  // The scrim itself must NOT be hidden — it was appended after the loop, so
  // it never entered `hidden`, which is why the loop runs first.

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && dismissible) { e.preventDefault(); close(); return; }
    if (e.key !== 'Tab') return;
    const items = [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE)]
      .filter((n) => n.offsetParent !== null || n === doc.activeElement);
    if (!items.length) { e.preventDefault(); dialog.focus(); return; }
    const first = items[0];
    const last = items[items.length - 1];
    if (e.shiftKey && doc.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && doc.activeElement === last) { e.preventDefault(); first.focus(); }
  };
  doc.addEventListener('keydown', onKey, true);

  if (dismissible) {
    scrim.addEventListener('click', (e) => { if (e.target === scrim) close(); });
  }

  let closed = false;
  function close(): void {
    if (closed) return;
    closed = true;
    doc.removeEventListener('keydown', onKey, true);
    scrim.remove();
    for (const [node, prev] of hidden) {
      if (prev === null) node.removeAttribute('aria-hidden');
      else node.setAttribute('aria-hidden', prev);
    }
    // Back to whatever opened it. Without this a phone user who dismisses a
    // sheet resumes at the top of the document, having lost their place.
    opener?.focus?.();
    o.onClose?.();
  }

  // Focus the first real control, or the dialog itself if it has none.
  const firstControl = dialog.querySelector<HTMLElement>(FOCUSABLE);
  (firstControl ?? dialog).focus();

  return { el: dialog, close };
}

/**
 * A confirmation for something that cannot be undone.
 *
 * `alertdialog`, not dismissible by clicking away, and **focus starts on
 * Cancel**. The last one is the whole point: a person who opened this by
 * mistake, or who hits Enter out of habit, must not destroy anything. The
 * confirm button is `danger` styled, so it does not look like the save button
 * their hand was already travelling toward.
 *
 * The body must say what will actually happen, with the numbers — "১৬৮ জন
 * শিক্ষার্থী উন্নীত হবে", not "আপনি কি নিশ্চিত?". A confirmation that carries
 * no information is a speed bump people learn to click through.
 */
export function confirmOverlay(doc: Document, o: {
  title: string;
  body: string;
  confirmLabel: string;
  cancelLabel?: string;
  danger?: boolean;
  onConfirm: () => void | Promise<void>;
  onCancel?: () => void;
  mount?: HTMLElement;
}): OverlayHandle {
  let handle: OverlayHandle;
  const cancel = button(doc, {
    label: o.cancelLabel ?? 'বাতিল', variant: 'secondary',
    onClick: () => { handle.close(); o.onCancel?.(); },
  });
  const confirm = button(doc, {
    label: o.confirmLabel,
    variant: o.danger ? 'danger' : 'primary',
    onClick: async () => {
      const { setBusy } = await import('./button.ts');
      setBusy(confirm, true);
      try { await o.onConfirm(); handle.close(); }
      finally { setBusy(confirm, false); }
    },
  });
  handle = openOverlay(doc, {
    title: o.title,
    body: el(doc, 'p', { className: 'ui-dialog-text', text: o.body }),
    actions: [cancel, confirm],
    alert: true,
    dismissible: false,
    kind: 'auto',
    mount: o.mount,
  });
  // Focus lands on Cancel because it is first in the DOM — stated here so a
  // later reorder of the actions array does not silently move it to Confirm.
  cancel.focus();
  return handle;
}

/**
 * A drawer for filters and pickers — anything that is a CHOICE, not a
 * destination. Slides from the side on desktop, up from the bottom on a phone.
 */
export function openDrawer(doc: Document, o: Omit<OverlayOptions, 'kind'>): OverlayHandle {
  return openOverlay(doc, { ...o, kind: 'drawer' });
}

/** Replace an open overlay's body without closing it (a filter re-render). */
export function setOverlayBody(handle: OverlayHandle, ...body: Child[]): void {
  const host = handle.el.querySelector('.ui-dialog-body');
  if (!host) return;
  clear(host);
  append(host, ...body);
}
