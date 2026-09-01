/**
 * আরও (More) — the menu page behind the fifth tab. The bar stays at five
 * tabs (04-UIUX: 360 px reference width); every additional feature page
 * lives here as a hash link, so deep links like #/fees keep working too.
 *
 * ── P6 ────────────────────────────────────────────────────────────────────
 *
 * This screen had **no page header at all** and rendered thirty-six
 * full-width `.more-item` strips down a 1110px column at desktop — the
 * longest stretched phone layout in the product, on the one screen every
 * role reaches.
 *
 * It is now `pageHeader` + `ui-card-grid`, which is the right primitive for
 * exactly this: the rows are a CHOICE with a sentence each, not records with
 * fields, so cards rather than a table. Three across at 1440, one on a phone.
 *
 * The theme control keeps its own card. It lives on this screen rather than
 * in a settings screen because a tenant's settings screen is about the
 * SCHOOL's decisions — SMS length, push policy — and this is about the person
 * holding the phone. The storage rule and the three options stay in
 * `./ui/theme.ts`, shared with the shell's profile menu, so only one of them
 * owns how it is stored.
 */
import { pageHeader, card, el, append } from './ui/index.ts';
import { readTheme, setTheme, THEME_OPTIONS, type ThemePref } from './ui/theme.ts';

export interface MoreItem {
  path: string;
  glyph: string;
  titleBn: string;
  subtitleBn: string;
}

export interface MoreViewOptions {
  root: HTMLElement;
  doc: Document;
  items: MoreItem[];
}

export class MoreView {
  constructor(o: MoreViewOptions) {
    const d = o.doc;
    o.root.textContent = '';

    o.root.append(pageHeader(d, {
      title: 'আরও',
      subtitle: 'এই ভূমিকার জন্য যেসব পাতা আছে',
    }));

    const grid = el(d, 'div', { className: 'ui-card-grid' });
    for (const item of o.items) {
      append(grid, card(d, {
        title: item.titleBn,
        subtitle: item.subtitleBn,
        glyph: item.glyph,
        variant: 'interactive',
        headingLevel: 3,
        onClick: () => { location.hash = `/${item.path}`; },
      }));
    }
    o.root.append(grid);

    o.root.append(themePicker(d));
  }
}

/**
 * F-1607. Theme choice: follow the phone, or pin light or dark.
 *
 * A `radiogroup` of three, not a select: three options that are all visible
 * is one glance, and the choice is about what the person is looking at.
 */
function themePicker(d: Document): HTMLElement {
  const group = el(d, 'div', {
    className: 'theme-options',
    attrs: { role: 'radiogroup', 'aria-label': 'রঙের ধরন' },
  });

  const current: ThemePref = readTheme();

  for (const opt of THEME_OPTIONS) {
    const btn = el(d, 'button', {
      className: 'theme-option', text: opt.labelBn, attrs: { type: 'button', role: 'radio' },
    });
    const chosen = current === opt.value;
    btn.setAttribute('aria-checked', String(chosen));
    btn.dataset.chosen = String(chosen);
    btn.addEventListener('click', () => {
      setTheme(opt.value);
      for (const other of group.querySelectorAll('.theme-option')) {
        const isThis = other === btn;
        other.setAttribute('aria-checked', String(isThis));
        (other as HTMLElement).dataset.chosen = String(isThis);
      }
    });
    append(group, btn);
  }

  return card(d, {
    title: 'রঙের ধরন',
    subtitle: 'এই যন্ত্রে সংরক্ষিত হবে — প্রতিষ্ঠানের কারও জন্য বদলাবে না।',
    glyph: 'star',
    headingLevel: 2,
  }, group);
}
