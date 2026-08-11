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
  }
}
