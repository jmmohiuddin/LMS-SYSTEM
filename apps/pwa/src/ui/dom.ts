/**
 * The one element builder. (UI integration plan, P2)
 *
 * Every component in this directory is built from `el()`. It exists because
 * the alternative — which is what 59 view modules currently do — is six lines
 * of `createElement` / `className` / `textContent` / `append` per node, and at
 * that price nobody writes the seventh line that would have added the
 * `aria-label`. Making the correct thing one line long is most of what a
 * component system is for.
 *
 * Three deliberate absences:
 *
 *   1. **No `innerHTML`.** Everything here sets `textContent`. School data is
 *      user-entered — a student's name, a notice body, an institution's own
 *      title — and the one place raw markup is legitimate is our own icon set,
 *      which has its own door (`icon`, below) that no caller can pass a string
 *      through.
 *   2. **No reactivity, no vdom, no lifecycle.** The app is framework-free by
 *      decision (D1/D3) and the views own their own re-render. A component
 *      here is a function that returns a detached element; that is the whole
 *      contract, and it is the same contract `view-states.ts` has used since
 *      R-3.
 *   3. **No default `doc`.** Every builder takes the document explicitly, the
 *      way the existing helpers do, because the tests run in jsdom and the
 *      service worker has no `document` at all.
 */
import { iconSvg, hasIcon } from '../icon.ts';

/** Anything that can be appended: an element, text, or nothing. */
export type Child = Node | string | number | null | undefined | false;

export interface ElProps {
  className?: string;
  /** Sets `textContent`. Never parsed as HTML. */
  text?: string | number;
  /** Plain attributes. `null` removes; everything else is stringified. */
  attrs?: Record<string, string | number | boolean | null | undefined>;
  /** `data-*` without the prefix: `{ path: 'home' }` → `data-path="home"`. */
  data?: Record<string, string | number | undefined>;
  /** Event listeners, by event name. */
  on?: Partial<Record<keyof HTMLElementEventMap, (e: Event) => void>>;
  /** Inline style properties. Used sparingly — tokens live in app.css. */
  style?: Partial<CSSStyleDeclaration>;
}

/**
 * Build an element.
 *
 * `el(d, 'button', { className: 'btn-primary', text: 'সংরক্ষণ' })`
 */
export function el<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  props: ElProps = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = doc.createElement(tag);
  if (props.className) node.className = props.className;
  if (props.text !== undefined) node.textContent = String(props.text);
  for (const [k, v] of Object.entries(props.attrs ?? {})) {
    if (v === null || v === undefined || v === false) continue;
    node.setAttribute(k, v === true ? '' : String(v));
  }
  for (const [k, v] of Object.entries(props.data ?? {})) {
    if (v === undefined) continue;
    node.dataset[k] = String(v);
  }
  for (const [k, fn] of Object.entries(props.on ?? {})) {
    if (fn) node.addEventListener(k, fn as EventListener);
  }
  if (props.style) Object.assign(node.style, props.style);
  append(node, ...children);
  return node;
}

/** Append children, skipping `null` / `undefined` / `false` so callers can inline conditions. */
export function append(parent: Node, ...children: Child[]): void {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    parent.appendChild(typeof c === 'object' ? c : parent.ownerDocument!.createTextNode(String(c)));
  }
}

/**
 * An icon, as a `<span>` wrapping inline SVG.
 *
 * The single place in this directory that assigns `innerHTML`, and it can only
 * ever receive markup from `icon.ts` — the `name` is a lookup key, not
 * content, so no caller can route a string through it.
 *
 * `aria-hidden` always: every control in this system is labelled in text
 * beside the glyph or by an explicit `aria-label`. An icon that needs its own
 * accessible name is a control whose label is missing.
 *
 * An unknown name is a bug, not a shrug. `iconSvg` returns a neutral dot for
 * one and says nothing about it — which is how `CARD.students` carried a
 * `search` glyph that did not exist from R-6 until P1. In a development build
 * this complains; in production it still renders the dot rather than throwing
 * a screen away over an icon.
 */
export function icon(doc: Document, name: string, className = 'ui-icon'): HTMLElement {
  if (!hasIcon(name)) {
    console.warn(`[ui] no icon named "${name}" — rendering the fallback dot`);
  }
  const span = el(doc, 'span', { className, attrs: { 'aria-hidden': 'true' } });
  span.innerHTML = iconSvg(name);
  return span;
}

/**
 * Mark a run of text as being in a different language from its container.
 *
 * 04-UIUX §5: without `lang`, a screen reader pronounces Bangla with English
 * phonemes and vice versa. The app root is `lang="bn"`, so any English string
 * that is genuinely English — a plan code, an EIIN, "CQ", an email — should be
 * wrapped rather than left to the Bangla voice.
 */
export function lang(doc: Document, code: 'bn' | 'en', text: string): HTMLElement {
  return el(doc, 'span', { text, attrs: { lang: code } });
}

/** Remove every child. Faster and safer than `innerHTML = ''`. */
export function clear(node: Node): void {
  while (node.firstChild) node.removeChild(node.firstChild);
}

/**
 * A unique id, for `aria-labelledby` / `aria-describedby` / `<label for>`.
 *
 * Monotonic per document rather than random: a stable id makes a DOM snapshot
 * in a test diffable, and `Math.random()` in a render path makes every
 * re-render look like a change.
 */
let seq = 0;
export function uid(prefix = 'ui'): string {
  seq += 1;
  return `${prefix}-${seq}`;
}

/** Reset the id counter. Tests only, so ids do not drift between cases. */
export function resetUid(): void {
  seq = 0;
}
