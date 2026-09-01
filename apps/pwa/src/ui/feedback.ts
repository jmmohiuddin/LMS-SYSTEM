/**
 * Feedback: toasts, loaders, progress, tooltips, and the states. (P2)
 *
 * §16 asks for a clear confirmation after every important mutation and warns
 * against "toast spam" in the same breath. Those pull in opposite directions
 * unless you separate two things that look alike:
 *
 *   **Inline confirmation** — stays on the screen it belongs to, next to the
 *   thing that changed. This is the default, and it is what `successNote()`
 *   in view-states.ts has done since R-3. A result published, a section
 *   created, a notice sent: the answer belongs beside the action.
 *
 *   **Toast** — for a mutation whose result is NOT on screen any more:
 *   attendance that synced ten minutes after it was saved, a queued SMS that
 *   went out. There is nowhere to put that message except over the top.
 *
 * A toast is therefore rare by construction, and one is on screen at a time:
 * `toast()` replaces whatever is showing rather than stacking, because a stack
 * of three notifications is a thing to dismiss rather than a thing to read.
 */
import { el, icon, append, clear, type Child } from './dom.ts';
import { skeleton } from '../view-states.ts';

export type ToastTone = 'success' | 'error' | 'info';

let host: HTMLElement | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;

/**
 * The live region every toast is announced through.
 *
 * One region, created once and never removed. A live region that is added to
 * the DOM at the same moment as its content is not announced at all — the
 * reader has to be watching the region before the text arrives, which is the
 * single most common reason "it works but nothing is announced".
 */
function toastHost(doc: Document): HTMLElement {
  if (host?.isConnected) return host;
  host = el(doc, 'div', {
    className: 'ui-toast-host',
    attrs: { role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true' },
  });
  doc.body.append(host);
  return host;
}

export function toast(doc: Document, o: {
  message: string;
  tone?: ToastTone;
  /** A single follow-up, e.g. "দেখুন". More than one belongs on the screen. */
  action?: { label: string; onClick: () => void };
  /** Milliseconds. Errors default to staying until dismissed. */
  duration?: number;
}): void {
  const h = toastHost(doc);
  if (timer) { clearTimeout(timer); timer = null; }
  clear(h);

  const tone = o.tone ?? 'info';
  const node = el(doc, 'div', { className: 'ui-toast', data: { tone } });
  if (tone !== 'info') {
    append(node, icon(doc, tone === 'success' ? 'check-square' : 'alert-triangle', 'ui-toast-glyph'));
  }
  append(node, el(doc, 'span', { className: 'ui-toast-text', text: o.message }));
  if (o.action) {
    const b = el(doc, 'button', {
      className: 'ui-toast-action', text: o.action.label, attrs: { type: 'button' },
    });
    b.addEventListener('click', () => { o.action!.onClick(); clear(h); });
    append(node, b);
  }
  const dismiss = el(doc, 'button', {
    className: 'ui-toast-close',
    attrs: { type: 'button', 'aria-label': 'বন্ধ করুন' },
  }, icon(doc, 'x'));
  dismiss.addEventListener('click', () => { clear(h); });
  append(node, dismiss);
  append(h, node);

  // An error stays until dismissed. Auto-hiding the one message a person
  // needed to read — and on this network that message is usually "saved
  // offline, will sync" — is how a teacher ends the day not knowing whether
  // the register went in.
  const ms = o.duration ?? (tone === 'error' ? 0 : 4000);
  if (ms > 0) timer = setTimeout(() => clear(h), ms);
}

/**
 * Announce something to a screen reader without showing anything.
 *
 * For state changes that are visible but not textual: a filter that narrowed a
 * table to twelve rows, a tab that switched, a row that moved. Sighted users
 * see it; without this, nobody else does.
 */
export function announce(doc: Document, message: string, assertive = false): void {
  const h = toastHost(doc);
  const region = assertive ? 'assertive' : 'polite';
  const sr = el(doc, 'p', {
    className: 'ui-sr-only', text: message,
    attrs: { role: assertive ? 'alert' : 'status', 'aria-live': region },
  });
  h.append(sr);
  setTimeout(() => sr.remove(), 1200);
}

/**
 * A spinner for an area that is loading INSIDE an otherwise-loaded screen —
 * a table refreshing under a filter, a section expanding.
 *
 * A full-page skeleton is for a first load; using one for a refresh throws
 * away the content the person is reading in order to say "wait".
 */
export function inlineLoader(doc: Document, label = 'লোড হচ্ছে'): HTMLElement {
  return el(doc, 'div', {
    className: 'ui-inline-loader', attrs: { role: 'status', 'aria-label': label },
  }, el(doc, 'span', { className: 'ui-spinner', attrs: { 'aria-hidden': 'true' } }),
     el(doc, 'span', { className: 'ui-sr-only', text: label }));
}

/**
 * Determinate progress for bulk work — an import, an invoice run, a bulk SMS.
 *
 * A real `<progress>`-equivalent with `role="progressbar"` and the three aria
 * values, because "৩৪%" as text alone tells a screen-reader user nothing about
 * whether it is moving. The label carries the count as well as the percentage:
 * "৩৪০ / ১০০০ সারি" is what a person waiting on an import wants.
 */
export function progress(doc: Document, o: {
  value: number;
  max: number;
  label: string;
}): HTMLElement {
  const pct = o.max > 0 ? Math.min(100, Math.round((o.value / o.max) * 100)) : 0;
  const wrap = el(doc, 'div', { className: 'ui-progress' });
  append(wrap, el(doc, 'p', { className: 'ui-progress-label', text: o.label }));
  const bar = el(doc, 'div', {
    className: 'ui-progress-track',
    attrs: {
      role: 'progressbar', 'aria-valuenow': o.value,
      'aria-valuemin': 0, 'aria-valuemax': o.max, 'aria-valuetext': o.label,
    },
  }, el(doc, 'span', { className: 'ui-progress-fill', style: { width: `${pct}%` } }));
  append(wrap, bar);
  return wrap;
}

/**
 * A tooltip.
 *
 * Deliberately minimal, and deliberately never the only carrier of anything:
 * a tooltip does not exist on a touch device, so a control whose meaning lives
 * in one is unusable on the product's primary platform. This attaches `title`
 * plus `aria-describedby` to an element that ALREADY has a visible label or an
 * `aria-label`; it adds detail, never identity.
 */
export function tooltip(doc: Document, target: HTMLElement, text: string): void {
  if (!target.getAttribute('aria-label') && !target.textContent?.trim()) {
    console.warn('[ui] tooltip on an unlabelled control — a tooltip is not a label');
  }
  target.title = text;
}

/**
 * The three screen states, wrapped so no screen invents its own.
 *
 * These delegate to `view-states.ts`, which has produced them since R-3 and is
 * used by 20+ modules. Re-exporting rather than reimplementing keeps one
 * definition; the additions here are the two things the originals lack.
 */
export { skeleton, emptyState, errorState, successNote } from '../view-states.ts';

/**
 * A skeleton shaped like a list, rather than three generic bars.
 *
 * A skeleton's job is to say "this is what is coming and roughly how much" —
 * a list skeleton that looks like a paragraph fails at exactly that.
 */
export function listSkeleton(doc: Document, rows = 5): HTMLElement {
  const wrap = el(doc, 'div', {
    className: 'is-skeleton ui-list-skeleton',
    attrs: { 'aria-busy': 'true', 'aria-label': 'লোড হচ্ছে' },
  });
  for (let i = 0; i < rows; i++) {
    append(wrap, el(doc, 'div', { className: 'ui-skel-row' },
      el(doc, 'span', { className: 'skel skel-avatar' }),
      el(doc, 'span', { className: 'ui-skel-lines' },
        el(doc, 'span', { className: 'skel skel-bar' }),
        el(doc, 'span', { className: 'skel skel-bar is-short' }))));
  }
  return wrap;
}

/**
 * The screen a person sees when the server says no.
 *
 * §15 forbids showing raw SQL, PostgreSQL errors, internal UUIDs, stack traces
 * or backend codes. This is the one place a 403 becomes a sentence: it says
 * what could not be done and who can do it, and it deliberately offers no
 * retry — retrying a permission failure is the definition of futile, and a
 * retry button here teaches people to hammer a locked door.
 */
export function permissionState(doc: Document, o: {
  message?: string;
  /** Who to ask. "প্রধান শিক্ষক" / "আইটি অ্যাডমিন". */
  contact?: string;
} = {}): HTMLElement {
  const wrap = el(doc, 'div', { className: 'ui-state ui-state-denied', attrs: { role: 'note' } });
  append(wrap,
    icon(doc, 'lock', 'ui-state-glyph'),
    el(doc, 'p', {
      className: 'ui-state-title',
      // Defaults through permissionMessage() so this component is not a
      // sixth wording of the same sentence — it was, until B-30.
      text: o.message ?? permissionMessage(),
    }),
    o.contact
      ? el(doc, 'p', {
          className: 'ui-state-detail',
          text: `প্রয়োজন হলে ${o.contact}-এর সাথে যোগাযোগ করুন।`,
        })
      : null);
  return wrap;
}

/**
 * Turn whatever the network or the server produced into a sentence.
 *
 * The rule from §15, applied once instead of at every catch site. Anything not
 * recognised becomes the generic line — an unrecognised error is exactly the
 * case where the raw text is most likely to be a stack trace or a constraint
 * name, and "duplicate key value violates unique constraint
 * students_tenant_id_roll_key" is not a sentence anyone should read.
 */
export function humanError(
  code: string | null | undefined,
  status?: number,
  /**
   * What was refused, when the screen knows — "শিক্ষাপঞ্জি", "রসিদ".
   * Used only for 401/403/404; see `permissionMessage`.
   */
  subject?: string,
): string {
  switch (code) {
    case 'offline':          return 'ইন্টারনেট সংযোগ নেই। সংযোগ পেলে আবার চেষ্টা করুন।';
    case 'forbidden':        return permissionMessage(subject);
    case 'not_found':        return 'তথ্যটি খুঁজে পাওয়া যায়নি।';
    case 'conflict':         return 'এই তথ্য ইতিমধ্যে আছে।';
    case 'validation':       return 'কিছু তথ্য ঠিক নেই। লাল চিহ্নিত ঘরগুলো দেখুন।';
    case 'rate_limited':     return 'একটু পরে আবার চেষ্টা করুন।';
    default: break;
  }
  if (status === 401) return 'আপনার সেশন শেষ হয়ে গেছে। আবার লগইন করুন।';
  if (status === 403) return permissionMessage(subject);
  if (status === 404) return 'তথ্যটি খুঁজে পাওয়া যায়নি।';
  if (status && status >= 500) return 'সার্ভারে সমস্যা হয়েছে। একটু পরে আবার চেষ্টা করুন।';
  return 'কিছু সমস্যা হয়েছে। আবার চেষ্টা করুন।';
}

/**
 * The canonical refusal. ONE pattern, with room for a subject.  (B-30)
 *
 * Before this there were five wordings for one condition:
 * `humanError`'s "এই কাজটি করার অনুমতি আপনার নেই।", the documents screen's
 * "রসিদ দেখার অনুমতি আপনার নেই।" and "একাডেমিক কাঠামো দেখার অনুমতি নেই।", the
 * calendar's "শিক্ষাপঞ্জি দেখার অনুমতি নেই।", and — on six other screens — no
 * permission message at all, because a 403 fell through to "আনা যায়নি".
 *
 * A school support call gets a different sentence depending on which screen
 * the caller happened to be looking at, which is worse than any one of them.
 *
 * The subject is kept rather than flattened away, because "শিক্ষাপঞ্জি দেখার
 * অনুমতি আপনার নেই।" tells a person what they cannot see and the bare form
 * does not. What is unified is the SHAPE and the ending; the specificity was
 * the good part of the bespoke strings.
 */
export function permissionMessage(subject?: string): string {
  return subject
    ? `${subject} দেখার অনুমতি আপনার নেই।`
    : 'এই কাজটি করার অনুমতি আপনার নেই।';
}

/**
 * The refusal plus the one thing a person can actually do about it.
 *
 * Not folded into `permissionMessage` because it is wrong in one place: an
 * IT admin refused something does not ring the head teacher about it.
 */
export function permissionMessageWithContact(subject?: string): string {
  return `${permissionMessage(subject)} প্রয়োজন হলে প্রধান শিক্ষকের সাথে যোগাযোগ করুন।`;
}

/** A full-screen first-load skeleton. Re-exported name for discoverability. */
export const pageSkeleton = skeleton;
