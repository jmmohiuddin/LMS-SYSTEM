/**
 * File input. (P2)
 *
 * Two callers exist today and they want opposite things: the CSV import wants
 * one file and a name to confirm it picked the right one; the answer-script
 * capture wants the camera, several photos, and to survive a phone that runs
 * out of memory holding them. Both are served by a real `<input type="file">`
 * with the right attributes — there is no drag-and-drop zone here, because the
 * primary device has no cursor to drag with, and a desktop-only affordance
 * that is dead on a phone is worse than a button that works on both.
 *
 * The native input is visually hidden and driven by a real button. That is the
 * one accessible way to restyle a file input: `opacity:0` over the button
 * leaves a control a screen reader announces as "choose file, no file chosen"
 * with no label, and `display:none` on the input breaks keyboard activation
 * unless the label is wired — which is what `<label for>` below does.
 */
import { el, icon, append, uid } from './dom.ts';

export interface UploadOptions {
  label: string;
  name: string;
  /** MIME types or extensions, e.g. '.csv,text/csv' or 'image/*'. */
  accept?: string;
  multiple?: boolean;
  /** `environment` opens the rear camera directly on a phone. */
  capture?: 'environment' | 'user';
  helper?: string;
  onFiles: (files: File[]) => void;
  /** Rejects anything larger, in bytes, before the caller sees it. */
  maxBytes?: number;
  className?: string;
}

export function fileUpload(doc: Document, o: UploadOptions): {
  root: HTMLElement;
  input: HTMLInputElement;
  reset(): void;
} {
  const id = uid('up');
  const helpId = `${id}-help`;
  const root = el(doc, 'div', {
    className: ['ui-upload', o.className ?? ''].filter(Boolean).join(' '),
  });

  const input = el(doc, 'input', {
    className: 'ui-sr-only ui-upload-input',
    attrs: {
      id, type: 'file', name: o.name,
      accept: o.accept ?? null,
      multiple: o.multiple ?? null,
      capture: o.capture ?? null,
      'aria-describedby': o.helper ? helpId : null,
    },
  });

  // `<label for>` IS the button. It is keyboard-activatable, it is announced
  // with the input's name, and it needs no JavaScript to open the picker —
  // which matters on a WebView where a synthetic .click() on a file input is
  // sometimes blocked as un-gestured.
  const trigger = el(doc, 'label', {
    className: 'btn-secondary ui-upload-trigger', attrs: { for: id },
  }, icon(doc, 'upload', 'btn-glyph'), el(doc, 'span', { text: o.label }));

  const chosen = el(doc, 'p', {
    className: 'ui-upload-chosen', attrs: { 'aria-live': 'polite' },
  });
  const err = el(doc, 'p', {
    className: 'ui-field-error', attrs: { role: 'alert', hidden: true },
  });

  input.addEventListener('change', () => {
    const files = [...(input.files ?? [])];
    err.hidden = true;
    if (!files.length) { chosen.textContent = ''; return; }
    if (o.maxBytes) {
      const big = files.find((f) => f.size > o.maxBytes!);
      if (big) {
        // Named and sized, because "file too large" without either sends a
        // person back to a folder of forty photos to guess which one.
        err.textContent =
          `"${big.name}" অনেক বড় (${mb(big.size)} MB)। সর্বোচ্চ ${mb(o.maxBytes!)} MB।`;
        err.hidden = false;
        input.value = '';
        chosen.textContent = '';
        return;
      }
    }
    chosen.textContent = files.length === 1
      ? files[0].name
      : `${bn(files.length)}টি ফাইল নির্বাচিত`;
    o.onFiles(files);
  });

  append(root, input, trigger, chosen);
  if (o.helper) {
    append(root, el(doc, 'p', {
      className: 'ui-field-help', text: o.helper, attrs: { id: helpId },
    }));
  }
  append(root, err);

  return {
    root, input,
    reset() { input.value = ''; chosen.textContent = ''; err.hidden = true; },
  };
}

const mb = (b: number): string => (b / (1024 * 1024)).toFixed(1);
const bn = (n: number): string =>
  String(n).replace(/\d/g, (d) => '০১২৩৪৫৬৭৮৯'[Number(d)]);
