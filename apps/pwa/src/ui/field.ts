/**
 * The form system. (P2)
 *
 * Every field owes six things, and the reason this is a module rather than a
 * convention is that the sixth is always the one that gets skipped:
 *
 *   label · helper · required marker · validation · error · **association**
 *
 * Association is `<label for>` plus `aria-describedby` plus `aria-invalid`.
 * Without it a screen reader reads "edit text, blank" — the label, the helper
 * and the error are all on screen and none of them reach the person who most
 * needs them. It cannot be added from the outside afterwards, because it needs
 * ids that only the builder can mint.
 *
 * ── The rule about errors this app has broken before ───────────────────────
 * §13: "never return users to an empty form after a server error when their
 * existing input can be preserved." These builders never re-create an input to
 * show an error; `setFieldError()` patches the existing node, so the value the
 * person typed is still in it. A guardian on 2G who loses a half-typed
 * admission form to a timeout does not type it again — they stop.
 *
 * ── Bangla and numbers ─────────────────────────────────────────────────────
 * `inputmode` is set from the field kind, not guessed at the call site: a roll
 * number, a mark and an amount all want the numeric keypad, and on a phone the
 * difference between the numeric pad and the full keyboard is most of the
 * entry time. Phone fields get `inputmode="tel"` and `dir="ltr"` — a Bangladeshi
 * number typed into an RTL-neutral Bangla context renders its digits in the
 * wrong order often enough to matter.
 */
import { el, icon, append, uid, type Child } from './dom.ts';

export type FieldKind =
  | 'text' | 'number' | 'tel' | 'email' | 'password' | 'date' | 'time'
  | 'search' | 'textarea' | 'select';

export interface FieldOptions {
  label: string;
  name: string;
  kind?: FieldKind;
  value?: string;
  /** Shown under the label, before any error. Explains, never scolds. */
  helper?: string;
  required?: boolean;
  disabled?: boolean;
  placeholder?: string;
  /** `select` only. */
  options?: Array<{ value: string; label: string; disabled?: boolean }>;
  /** Anything the browser should enforce: min, max, maxlength, step, pattern. */
  attrs?: Record<string, string | number | boolean | null | undefined>;
  onInput?: (value: string, e: Event) => void;
  onChange?: (value: string, e: Event) => void;
  className?: string;
  /** Rendered after the control — a unit, a currency mark, a "verify" button. */
  suffix?: Child;
}

export interface Field {
  /** The `<div class="ui-field">` to append. */
  root: HTMLElement;
  /** The control itself, for focus, value reads and direct listeners. */
  input: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
  /** Read the current value. */
  value(): string;
}

const INPUTMODE: Partial<Record<FieldKind, string>> = {
  number: 'numeric', tel: 'tel', email: 'email', search: 'search',
};

/**
 * One labelled control, wired for a screen reader.
 *
 * Returns the wrapper AND the input: callers need the input to focus it after
 * a validation failure, and hunting for it with a querySelector is how the
 * wrong field gets focused on a form with two of the same name.
 */
export function field(doc: Document, o: FieldOptions): Field {
  const kind = o.kind ?? 'text';
  const id = uid('f');
  const helpId = `${id}-help`;
  const errId = `${id}-err`;

  const root = el(doc, 'div', {
    className: ['ui-field', o.className ?? ''].filter(Boolean).join(' '),
    data: { kind },
  });

  const label = el(doc, 'label', { className: 'ui-field-label', attrs: { for: id } },
    el(doc, 'span', { text: o.label }));
  if (o.required) {
    // A word, not just an asterisk: "*" alone is a convention people are
    // assumed to know, and 04-UIUX §5 forbids meaning carried by one glyph.
    // The asterisk stays for scanning; the word is what is announced.
    append(label,
      el(doc, 'span', { className: 'ui-req', text: '*', attrs: { 'aria-hidden': 'true' } }),
      el(doc, 'span', { className: 'ui-sr-only', text: '(আবশ্যক)' }));
  }
  root.append(label);

  let input: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
  const shared = {
    id, name: o.name,
    required: o.required ?? null,
    disabled: o.disabled ?? null,
    'aria-describedby': o.helper ? helpId : null,
    ...(o.attrs ?? {}),
  };

  if (kind === 'textarea') {
    input = el(doc, 'textarea', {
      className: 'ui-input', attrs: { ...shared, placeholder: o.placeholder ?? null },
    });
    input.value = o.value ?? '';
  } else if (kind === 'select') {
    const sel = el(doc, 'select', { className: 'ui-input ui-select', attrs: shared });
    for (const opt of o.options ?? []) {
      const node = el(doc, 'option', {
        text: opt.label, attrs: { value: opt.value, disabled: opt.disabled ?? null },
      });
      if (opt.value === o.value) node.selected = true;
      sel.append(node);
    }
    input = sel;
  } else {
    input = el(doc, 'input', {
      className: 'ui-input',
      attrs: {
        ...shared,
        type: kind === 'number' ? 'text' : kind,
        // type="number" is deliberately avoided: it silently discards what it
        // considers invalid, so a mis-keyed mark vanishes rather than being
        // corrected, and its spinner is a 12px target on a phone. `text` with
        // inputmode gives the numeric keypad without the data loss.
        inputmode: INPUTMODE[kind] ?? null,
        dir: kind === 'tel' || kind === 'email' ? 'ltr' : null,
        placeholder: o.placeholder ?? null,
        value: o.value ?? null,
        autocomplete: kind === 'password' ? 'current-password' : null,
      },
    });
  }

  const control = el(doc, 'div', { className: 'ui-field-control' }, input, o.suffix);
  root.append(control);

  if (o.helper) {
    root.append(el(doc, 'p', {
      className: 'ui-field-help', text: o.helper, attrs: { id: helpId },
    }));
  }
  // The error node exists from the start, empty and hidden. Creating it later
  // means `aria-describedby` has to be rewritten at the moment of failure,
  // which is the moment most likely to be got wrong.
  root.append(el(doc, 'p', {
    className: 'ui-field-error', attrs: { id: errId, hidden: true },
  }));

  const emit = (fn?: (v: string, e: Event) => void) => (e: Event) => {
    // Clearing on input, not on blur: an error that stays while the person is
    // fixing it reads as "still wrong" and makes them delete correct work.
    clearFieldError(root);
    fn?.((input as HTMLInputElement).value, e);
  };
  if (o.onInput) input.addEventListener('input', emit(o.onInput));
  if (o.onChange) input.addEventListener('change', emit(o.onChange));
  else input.addEventListener('input', emit());

  return { root, input, value: () => (input as HTMLInputElement).value };
}

/**
 * Show a validation error on a field, keeping the value.
 *
 * `aria-describedby` gains the error id (keeping the helper's), `aria-invalid`
 * goes true, and the message appears. Nothing is re-created, so whatever the
 * person typed is still there — which is §13's rule, enforced by construction
 * rather than by remembering it.
 */
export function setFieldError(root: HTMLElement, message: string): void {
  const input = root.querySelector<HTMLElement>('.ui-input');
  const err = root.querySelector<HTMLElement>('.ui-field-error');
  if (!input || !err) return;
  err.textContent = message;
  err.hidden = false;
  root.dataset.invalid = 'true';
  input.setAttribute('aria-invalid', 'true');
  const help = root.querySelector('.ui-field-help')?.id;
  input.setAttribute('aria-describedby', [help, err.id].filter(Boolean).join(' '));
}

/** Remove a field's error state. Safe to call when there is none. */
export function clearFieldError(root: HTMLElement): void {
  const input = root.querySelector<HTMLElement>('.ui-input');
  const err = root.querySelector<HTMLElement>('.ui-field-error');
  if (!input || !err || err.hidden) return;
  err.textContent = '';
  err.hidden = true;
  delete root.dataset.invalid;
  input.removeAttribute('aria-invalid');
  const help = root.querySelector('.ui-field-help')?.id;
  if (help) input.setAttribute('aria-describedby', help);
  else input.removeAttribute('aria-describedby');
}

/**
 * Report a set of errors and focus the first one.
 *
 * Focus matters more than it looks: on a phone the invalid field is usually
 * scrolled off, and a form that says "3 problems" without moving to one is a
 * scavenger hunt. Returns whether anything was wrong, so a submit handler
 * reads `if (reportErrors(form, errs)) return;`.
 */
export function reportErrors(
  scope: HTMLElement,
  errors: Record<string, string>,
): boolean {
  let first: HTMLElement | null = null;
  for (const [name, message] of Object.entries(errors)) {
    const input = scope.querySelector<HTMLElement>(`[name="${CSS.escape(name)}"]`);
    const root = input?.closest<HTMLElement>('.ui-field');
    if (!root) continue;
    setFieldError(root, message);
    first ??= input!;
  }
  first?.focus();
  return first !== null;
}

/**
 * A search box: icon, input, and a clear button that appears once there is
 * something to clear.
 *
 * §19 — "no type-ahead network spam on 2G". This calls `onSearch` on submit
 * and on clear, never on every keystroke. R-6 decided that for the student
 * search and it is the same trade here: on the reference network a keystroke
 * search means a request per character and a result set that arrives out of
 * order.
 */
export function searchField(doc: Document, o: {
  label: string;
  placeholder?: string;
  value?: string;
  onSearch: (q: string) => void;
  /** Announced result count, e.g. "১২টি ফলাফল". Rendered under the box. */
  resultNote?: string;
  className?: string;
}): { root: HTMLElement; input: HTMLInputElement } {
  const id = uid('search');
  const form = el(doc, 'form', {
    className: ['ui-search', o.className ?? ''].filter(Boolean).join(' '),
    attrs: { role: 'search' },
  });
  const label = el(doc, 'label', {
    className: 'ui-sr-only', text: o.label, attrs: { for: id },
  });
  const box = el(doc, 'div', { className: 'ui-search-box' });
  const input = el(doc, 'input', {
    className: 'ui-input ui-search-input',
    attrs: {
      id, type: 'search', name: 'q', inputmode: 'search',
      placeholder: o.placeholder ?? o.label, value: o.value ?? null,
      // The browser's own clear affordance is inconsistent and untappable on
      // Android; ours is below and is a real 48px control.
      autocomplete: 'off', enterkeyhint: 'search',
    },
  });
  const clear = el(doc, 'button', {
    className: 'ui-search-clear',
    attrs: { type: 'button', 'aria-label': 'খালি করুন', hidden: !o.value },
  }, icon(doc, 'x'));
  const submit = el(doc, 'button', {
    className: 'ui-search-submit', attrs: { type: 'submit', 'aria-label': o.label },
  }, icon(doc, 'search'));

  const sync = () => { clear.hidden = input.value.length === 0; };
  input.addEventListener('input', sync);
  clear.addEventListener('click', () => {
    input.value = '';
    sync();
    input.focus();
    o.onSearch('');
  });
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    o.onSearch(input.value.trim());
  });

  append(box, submit, input, clear);
  append(form, label, box);
  if (o.resultNote) {
    // polite, not assertive: a count that interrupts what is being read is
    // worse than one that waits for a pause.
    append(form, el(doc, 'p', {
      className: 'ui-search-note', text: o.resultNote,
      attrs: { 'aria-live': 'polite' },
    }));
  }
  return { root: form, input };
}
