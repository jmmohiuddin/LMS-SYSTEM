/**
 * Home / dashboard — the new default landing screen.
 *
 * A calm re-orientation surface: greeting card at the top, the two things a
 * teacher is most likely to touch (today's routine, take attendance) as
 * primary cards, then a compact grid of every other feature.
 *
 * For students there is one addition that changes the screen's job: a
 * "next" block fetched from /academics/next. The grid answers "what CAN I
 * do"; the next block answers "what SHOULD I do", which is the question a
 * student actually arrives with. It renders progressively — the cards
 * paint immediately and the suggestions slot in when they arrive, so the
 * shell is never blocked on a request.
 */
import { iconSvg } from './icon.ts';

export interface DashboardItem {
  path: string;
  /** An icon name from ./icon.ts, not an emoji. */
  glyph: string;
  titleBn: string;
  subtitleBn: string;
  variant?: 'primary' | 'secondary';
}

export interface Suggestion {
  kind: string;
  titleBn: string;
  whyBn: string;
  route: string;
  refId: string;
  urgency: 'high' | 'medium' | 'low';
}

export interface HomeViewOptions {
  root: HTMLElement;
  doc: Document;
  displayName?: string;
  primary: DashboardItem[];
  secondary: DashboardItem[];
  /** Supplied for students/guardians only; omitted = no "next" block. */
  loadNext?: () => Promise<Suggestion[]>;
}

// Icon names (see ./icon.ts), not emoji: one drawn set, one stroke weight,
// tinting with the card's urgency colour via currentColor.
const KIND_GLYPH: Record<string, string> = {
  assignment: 'edit',
  redo_practice: 'refresh',
  continue_topic: 'arrow-right',
  new_chapter: 'star',
};

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

    // "What should I study next" — inserted between hero and cards, so it
    // reads as the answer to the greeting's question rather than a fourth
    // navigation option.
    if (o.loadNext) {
      const slot = d.createElement('section');
      slot.className = 'next-slot';
      // The suggestions arrive after first paint; the region announces itself
      // to a screen reader when they do, and aria-busy carries the load state.
      slot.setAttribute('aria-live', 'polite');
      o.root.append(slot);
      this.loadNextInto(d, slot, o.loadNext);
    }

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
      // "Quick access", not "all sections": the grid is now a short shortcut
      // row, and the long tail lives in আরও. Naming it honestly stops it
      // reading as the whole index.
      sectionH.textContent = 'দ্রুত প্রবেশ';
      o.root.append(sectionH);

      const grid = d.createElement('div');
      grid.className = 'card-grid secondary-grid';
      for (const item of o.secondary) grid.append(this.buildCard(d, item, false));
      o.root.append(grid);
    }
  }

  /**
   * Load the suggestions with the three states the old code collapsed into
   * one. It painted nothing until the fetch resolved and swallowed failure
   * into nothing — on the slow connections these users actually have, the
   * one element built for them simply, silently, wasn't there. Now: a
   * skeleton holds the space from first paint (so the grid below never jumps
   * under a thumb), an empty result is a quiet reassurance, and a failure is
   * an honest retry, not a void.
   */
  private loadNextInto(
    d: Document, slot: HTMLElement, loader: () => Promise<Suggestion[]>,
  ): void {
    this.renderNextSkeleton(d, slot);
    slot.setAttribute('aria-busy', 'true');
    loader()
      .then((list) => { slot.setAttribute('aria-busy', 'false'); this.renderNext(d, slot, list); })
      .catch(() => {
        slot.setAttribute('aria-busy', 'false');
        this.renderNextError(d, slot, () => this.loadNextInto(d, slot, loader));
      });
  }

  /** The section heading, always the same string. */
  private nextHeading(d: Document): HTMLElement {
    const h2 = d.createElement('h2');
    h2.className = 'section-heading';
    h2.textContent = 'এখন যা করবে';
    return h2;
  }

  /** Skeleton of the real list — a shape, never a spinner (Wireframe §4). */
  private renderNextSkeleton(d: Document, slot: HTMLElement): void {
    slot.textContent = '';
    slot.append(this.nextHeading(d));
    const wrap = d.createElement('div');
    wrap.className = 'next-skel';
    for (let i = 0; i < 2; i++) {
      const card = d.createElement('div');
      card.className = 'next-skel-card is-skeleton';
      const title = d.createElement('span'); title.className = 'skel skel-title';
      const line = d.createElement('span'); line.className = 'skel skel-line';
      card.append(title, line);
      wrap.append(card);
    }
    slot.append(wrap);
  }

  /** Couldn't load — a sentence and a retry, never a silent gap. */
  private renderNextError(d: Document, slot: HTMLElement, retry: () => void): void {
    slot.textContent = '';
    slot.append(this.nextHeading(d));
    const row = d.createElement('div');
    row.className = 'next-error-row';
    const p = d.createElement('p');
    p.className = 'next-note';
    p.textContent = 'পরামর্শ লোড হয়নি।';
    const btn = d.createElement('button');
    btn.type = 'button';
    btn.className = 'next-retry';
    btn.textContent = 'আবার চেষ্টা';
    btn.addEventListener('click', retry);
    row.append(p, btn);
    slot.append(row);
  }

  private renderNext(d: Document, slot: HTMLElement, list: Suggestion[]): void {
    slot.textContent = '';
    slot.append(this.nextHeading(d));

    // Nothing due is a real, good answer — say so, quietly, instead of
    // leaving a blank where a moment ago there was a skeleton.
    if (list.length === 0) {
      const p = d.createElement('p');
      p.className = 'next-note';
      p.textContent = 'আজ নতুন করে কিছু করার নেই — এগিয়ে আছো।';
      slot.append(p);
      return;
    }

    const ul = d.createElement('ul');
    ul.className = 'next-list';
    for (const s of list) {
      const li = d.createElement('li');
      const btn = d.createElement('button');
      btn.type = 'button';
      btn.className = 'card next-card';
      btn.dataset.urgency = s.urgency;

      const glyph = d.createElement('span');
      glyph.className = 'next-glyph';
      glyph.setAttribute('aria-hidden', 'true');
      glyph.innerHTML = iconSvg(KIND_GLYPH[s.kind] ?? '');

      const body = d.createElement('span');
      body.className = 'next-body';
      const title = d.createElement('span');
      title.className = 'next-title';
      title.textContent = s.titleBn;
      // The reason is the point — a suggestion a student can't interrogate
      // is one they'll learn to ignore.
      const why = d.createElement('span');
      why.className = 'next-why';
      why.textContent = s.whyBn;
      body.append(title, why);

      btn.append(glyph, body);
      btn.addEventListener('click', () => { location.hash = `/${s.route}`; });
      li.append(btn);
      ul.append(li);
    }
    slot.append(ul);
  }

  private buildCard(d: Document, item: DashboardItem, primary: boolean): HTMLElement {
    const card = d.createElement('button');
    card.type = 'button';
    card.className = primary ? 'card home-card home-card-primary' : 'card home-card';
    card.setAttribute('aria-label', item.titleBn);

    const glyph = d.createElement('span');
    glyph.className = 'home-glyph';
    glyph.setAttribute('aria-hidden', 'true');
    glyph.innerHTML = iconSvg(item.glyph);

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
