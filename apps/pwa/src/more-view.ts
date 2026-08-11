/**
 * আরও (More) — the menu page behind the fifth tab. The bar stays at five
 * tabs (04-UIUX: 360 px reference width); every additional feature page
 * lives here as a hash link, so deep links like #/fees keep working too.
 */
import { iconSvg } from './icon.ts';

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

    const header = d.createElement('header');
    header.className = 'att-header';
    const h1 = d.createElement('h1');
    h1.textContent = 'আরও';
    header.append(h1);
    o.root.append(header);

    const list = d.createElement('ul');
    list.className = 'more-list';
    for (const item of o.items) {
      const li = d.createElement('li');
      const btn = d.createElement('button');
      btn.type = 'button';
      btn.className = 'more-item';
      const glyph = d.createElement('span');
      glyph.className = 'more-glyph';
      glyph.setAttribute('aria-hidden', 'true');
      glyph.innerHTML = iconSvg(item.glyph);
      const body = d.createElement('span');
      body.className = 'more-body';
      const title = d.createElement('span');
      title.className = 'more-title';
      title.textContent = item.titleBn;
      const sub = d.createElement('span');
      sub.className = 'more-sub';
      sub.textContent = item.subtitleBn;
      body.append(title, sub);
      btn.append(glyph, body);
      btn.addEventListener('click', () => { location.hash = `/${item.path}`; });
      li.append(btn);
      list.append(li);
    }
    o.root.append(list);
    o.root.append(themePicker(d));
  }
}

/**
 * F-1607. Theme choice: follow the phone, or pin light or dark.
 *
 * Lives here rather than in a settings screen because this product has no
 * settings screen, and inventing one for a single control would bury it.
 *
 * 'system' is the default and is stored as the ABSENCE of a key, so a
 * student who never touches this follows their phone forever — including
 * when Android flips it at sunset. Pinning writes the key; going back to
 * system removes it. Storing the literal string 'system' would work until
 * someone read it as a third theme and tried to render it.
 */
function themePicker(d: Document): HTMLElement {
  const wrap = d.createElement('section');
  wrap.className = 'card theme-picker';

  const h = d.createElement('h2');
  h.className = 'section-heading';
  h.textContent = 'রঙের ধরন';
  wrap.append(h);

  const group = d.createElement('div');
  group.className = 'theme-options';
  group.setAttribute('role', 'radiogroup');
  group.setAttribute('aria-label', 'রঙের ধরন');

  const current = (() => {
    try { return localStorage.getItem('shikhon_theme'); } catch { return null; }
  })();

  const options: Array<{ value: string | null; labelBn: string }> = [
    { value: null, labelBn: 'ফোন অনুযায়ী' },
    { value: 'light', labelBn: 'উজ্জ্বল' },
    { value: 'dark', labelBn: 'অন্ধকার' },
  ];

  for (const opt of options) {
    const btn = d.createElement('button');
    btn.type = 'button';
    btn.className = 'theme-option';
    btn.setAttribute('role', 'radio');
    const chosen = current === opt.value;
    btn.setAttribute('aria-checked', String(chosen));
    btn.dataset.chosen = String(chosen);
    btn.textContent = opt.labelBn;
    btn.addEventListener('click', () => {
      try {
        if (opt.value === null) localStorage.removeItem('shikhon_theme');
        else localStorage.setItem('shikhon_theme', opt.value);
      } catch { /* private mode: the choice applies for this session only */ }
      applyTheme(opt.value);
      for (const other of group.querySelectorAll('.theme-option')) {
        const isThis = other === btn;
        other.setAttribute('aria-checked', String(isThis));
        (other as HTMLElement).dataset.chosen = String(isThis);
      }
    });
    group.append(btn);
  }

  wrap.append(group);
  return wrap;
}

/** Mirrors the boot script in index.html — same rule, applied live. */
function applyTheme(pref: string | null): void {
  const dark = pref === 'dark'
    || (pref !== 'light' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
}
