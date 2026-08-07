/**
 * Home / dashboard — the new default landing screen.
 *
 * A calm re-orientation surface: greeting card at the top, the two things a
 * teacher is most likely to touch (today's routine, take attendance) as
 * primary cards, then a compact grid of every other feature. No fetches on
 * mount — the shell is on the critical path and every card can be reached
 * with one tap, so the surface has to boot instantly.
 */
export interface DashboardItem {
  path: string;
  glyph: string;
  titleBn: string;
  subtitleBn: string;
  variant?: 'primary' | 'secondary';
}

export interface HomeViewOptions {
  root: HTMLElement;
  doc: Document;
  displayName?: string;
  primary: DashboardItem[];
  secondary: DashboardItem[];
}

function greetingBn(): string {
  const h = new Date().getHours();
  if (h < 5) return 'শুভ রাত্রি';
  if (h < 12) return 'শুভ সকাল';
  if (h < 17) return 'শুভ দুপুর';
  if (h < 20) return 'শুভ বিকেল';
  return 'শুভ সন্ধ্যা';
}

function todayBn(): string {
  const months = ['জানুয়ারি','ফেব্রুয়ারি','মার্চ','এপ্রিল','মে','জুন','জুলাই','আগস্ট','সেপ্টেম্বর','অক্টোবর','নভেম্বর','ডিসেম্বর'];
  const days = ['রবি','সোম','মঙ্গল','বুধ','বৃহঃ','শুক্র','শনি'];
  const d = new Date();
  const digits: Record<string,string> = { '0':'০','1':'১','2':'২','3':'৩','4':'৪','5':'৫','6':'৬','7':'৭','8':'৮','9':'৯' };
  const day = String(d.getDate()).replace(/[0-9]/g, (c) => digits[c] ?? c);
  return `${days[d.getDay()]}, ${day} ${months[d.getMonth()]}`;
}

export class HomeView {
  constructor(o: HomeViewOptions) {
    const d = o.doc;
    o.root.textContent = '';

    // Hero: greeting + today.
    const hero = d.createElement('section');
    hero.className = 'hero';
    const heroDate = d.createElement('p');
    heroDate.className = 'hero-date';
    heroDate.textContent = todayBn();
    const heroGreet = d.createElement('h1');
    heroGreet.className = 'hero-greet';
    const name = (o.displayName ?? '').trim();
    heroGreet.textContent = name ? `${greetingBn()}, ${name}` : greetingBn();
    const heroSub = d.createElement('p');
    heroSub.className = 'hero-sub';
    heroSub.textContent = 'আজ কী করতে চান?';
    hero.append(heroDate, heroGreet, heroSub);
    o.root.append(hero);

    // Primary cards (large, two-up).
    if (o.primary.length > 0) {
      const primaryGrid = d.createElement('div');
      primaryGrid.className = 'card-grid primary-grid';
      for (const item of o.primary) primaryGrid.append(this.buildCard(d, item, true));
      o.root.append(primaryGrid);
    }

    // Section heading + secondary grid.
    if (o.secondary.length > 0) {
      const sectionH = d.createElement('h2');
      sectionH.className = 'section-heading';
      sectionH.textContent = 'সব বিভাগ';
      o.root.append(sectionH);

      const grid = d.createElement('div');
      grid.className = 'card-grid secondary-grid';
      for (const item of o.secondary) grid.append(this.buildCard(d, item, false));
      o.root.append(grid);
    }
  }

  private buildCard(d: Document, item: DashboardItem, primary: boolean): HTMLElement {
    const card = d.createElement('button');
    card.type = 'button';
    card.className = primary ? 'card home-card home-card-primary' : 'card home-card';
    card.setAttribute('aria-label', item.titleBn);

    const glyph = d.createElement('span');
    glyph.className = 'home-glyph';
    glyph.setAttribute('aria-hidden', 'true');
    glyph.textContent = item.glyph;

    const body = d.createElement('span');
    body.className = 'home-body';
    const title = d.createElement('span');
    title.className = 'home-title';
    title.textContent = item.titleBn;
    const sub = d.createElement('span');
    sub.className = 'home-sub';
    sub.textContent = item.subtitleBn;
    body.append(title, sub);

    card.append(glyph, body);
    card.addEventListener('click', () => { location.hash = `/${item.path}`; });
    return card;
  }
}
