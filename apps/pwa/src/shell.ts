/**
 * The application shell — desktop and mobile. (UI integration plan, P1)
 *
 * Before P1 this was a mobile shell that a desktop browser happened to be
 * able to open: a sticky bar with the school's name, a fixed five-tab bar at
 * the bottom, and one column of content between them at every width from
 * 320px to 2560px. On a laptop that is a stretched phone. It also built the
 * bar from *route order*, which knows nothing about who is holding the
 * device, so a student's phone offered "হাজিরা নিন" and a section roster.
 *
 * P1 gives the product two deliberate layouts from one DOM:
 *
 *   ≥1024px   a persistent sidebar (grouped, role-specific, collapsible to a
 *             48px icon rail), a topbar carrying breadcrumb + actions, and a
 *             centred content column that stops growing at 1200px.
 *   <1024px   the mobile shell, kept: compact header with the institution's
 *             identity, a bottom bar of five role-chosen tabs, and sheets
 *             rather than menus.
 *
 * **One DOM, CSS decides.** Both navs are rendered and the media query hides
 * one — `display:none` removes a subtree from the accessibility tree as well
 * as the page, so a screen reader never meets the hidden one. The alternative
 * (re-rendering on resize) drops focus, remounts the current route and needs
 * a resize listener to be correct; this needs neither. The single exception
 * is the icon rail, which is an attribute the shell sets, because the rail is
 * a *preference* between 1280px and infinity and a *constraint* below that,
 * and expressing "user choice OR viewport" in CSS alone means duplicating
 * every rail rule inside a media query.
 *
 * What did NOT change: the hash router, `ShellRoute`, the five-tab cap, the
 * offline banner, the bell, the branding patch-in-place, or a single view.
 * Every route mounts into `.shell-view` exactly as before.
 */
import { iconSvg } from './icon.ts';
import { formatCount } from '../../../packages/ui-core/src/format.ts';
import { navFor, crumbFor, type RoleNav } from './ui/nav.ts';
import { roleLabel } from './ui/roles.ts';
import { readTheme, setTheme, THEME_OPTIONS } from './ui/theme.ts';

export interface ShellRoute {
  path: string;       // hash fragment without '#/', e.g. 'attendance'
  labelBn: string;
  glyph: string;       // icon name from ./icon.ts — never an emoji
  mount: (container: HTMLElement) => void | Promise<void>;
  /** Called when navigating away, so a view can release listeners/timers. */
  unmount?: () => void;
  /**
   * Routable but not on the tab bar — reached from the আরও (More) menu, the
   * desktop sidebar or a deep link. Keeps the bar at 5 tabs while the app has
   * forty pages.
   */
  hidden?: boolean;
}

export interface ShellOptions {
  root: HTMLElement;
  doc: Document;
  routes: ShellRoute[];
  defaultPath: string;
  displayName: string;
  onLogout: () => void;
  /**
   * P1. The signed-in role. Drives the sidebar groups and which five routes
   * reach the bottom bar. Absent (tests, previews) falls back to route order,
   * which is exactly the pre-P1 behaviour — so an existing caller that has
   * not been told about roles still gets a working shell.
   */
  role?: string;
  /** Demo mode only — lets a previewer see each role's dashboard. */
  roleSwitcher?: { current: string; onChange: (role: string) => void };
  /**
   * R-1. The institution's name and logo. A teacher on a shared device should
   * be able to tell at a glance which school this install belongs to, and the
   * shell chrome is the one piece present on every screen. Optional so a
   * caller that has not resolved branding yet still gets a working shell.
   */
  institution?: { name: string; logoUrl?: string };
  /**
   * R-2. The notification bell. Present for every role, because every role
   * has an inbox — what differs is what is in it, and that was decided when
   * the notice was published. Omitted only in contexts with no inbox to open.
   */
  bell?: { onOpen: () => void };
  /**
   * P1 §30. Marks this as the demo environment, in the chrome, on every
   * screen. A demo that looks exactly like the product is a trust problem the
   * moment someone screenshots it.
   */
  demo?: boolean;
}

/** Below this the sidebar is gone and the bottom bar is the navigation. */
const DESKTOP_MIN = 1024;
/** Between DESKTOP_MIN and this the sidebar is an icon rail, not a choice. */
const RAIL_MAX = 1279;
const RAIL_KEY = 'shikhon_sidebar_rail';

export class Shell {
  private readonly o: ShellOptions;
  private readonly nav: RoleNav | null;
  private viewEl!: HTMLElement;
  private shellEl!: HTMLElement;
  private bellEls: HTMLButtonElement[] = [];
  private bellBadgeEls: HTMLElement[] = [];
  private navEls = new Map<string, HTMLElement[]>();
  private crumbEl: HTMLElement | null = null;
  private profileMenu: HTMLElement | null = null;
  private profileBtns: HTMLButtonElement[] = [];
  private currentRoute: ShellRoute | null = null;
  private booted = false;
  private readonly onHashChange = () => { void this.renderRoute(); };
  private onConnectivity?: () => void;
  private onDocPointer?: (e: Event) => void;
  private onDocKey?: (e: KeyboardEvent) => void;
  private railQuery: MediaQueryList | null = null;
  private onRailQuery?: () => void;

  constructor(options: ShellOptions) {
    this.o = options;
    this.nav = options.role ? navFor(options.role) : null;
    this.renderChrome();
    addEventListener('hashchange', this.onHashChange);
    void this.renderRoute();
  }

  /**
   * Update the institution plate after construction.
   *
   * The shell is built from the CACHED branding so it paints immediately, but
   * the server's answer arrives a round-trip later — and on a device's very
   * first launch there is no cache at all, so without this the chrome would
   * sit on the neutral placeholder until the next reload. Patching the nodes
   * in place rather than re-rendering keeps the current route mounted and its
   * scroll position intact. Both plates (mobile header, desktop sidebar) are
   * patched, because both are in the DOM at all times.
   */
  setInstitution(institution: { name: string; logoUrl?: string }): void {
    this.o.institution = institution;
    const d = this.o.doc;
    for (const org of this.o.root.querySelectorAll<HTMLElement>('.shell-org')) {
      // Only the mobile plate hides: the desktop brand row also carries the
      // rail toggle, and hiding that would take the sidebar control away with
      // the name it was waiting for.
      if (org.classList.contains('shell-org-mobile')) org.hidden = !institution.name;
      let nameEl = org.querySelector('.shell-org-name');
      if (!nameEl) {
        nameEl = d.createElement('span');
        nameEl.className = 'shell-org-name';
        org.append(nameEl);
      }
      nameEl.textContent = institution.name;

      const existing = org.querySelector<HTMLImageElement>('.shell-org-logo');
      const mark = org.querySelector<HTMLElement>('.shell-org-mark');
      if (institution.logoUrl) {
        if (existing) {
          existing.src = institution.logoUrl;
        } else {
          const img = d.createElement('img');
          img.className = 'shell-org-logo';
          img.src = institution.logoUrl;
          img.alt = '';
          org.prepend(img);
        }
        mark?.remove();
      } else {
        existing?.remove();
        // No logo: the monogram takes its place rather than leaving a gap
        // where the identity goes. First letter of the school's own name.
        if (!mark) org.prepend(this.monogram(institution.name));
        else mark.textContent = firstGrapheme(institution.name);
      }
    }
  }

  /**
   * Set the unread count on the bell.
   *
   * A badge showing "0" is noise, so zero hides it entirely. Above 9 it reads
   * "৯+": the exact number stops being actionable there, and three digits do
   * not fit a 20px badge at 360px.
   */
  setUnread(count: number): void {
    const n = Math.max(0, Math.floor(count));
    const label = n === 0 ? 'নোটিশ' : `নোটিশ — ${n}টি পড়া হয়নি`;
    for (const badge of this.bellBadgeEls) {
      badge.hidden = n === 0;
      badge.textContent = n > 9 ? '৯+' : formatCount(n, 'bn');
    }
    for (const bell of this.bellEls) bell.setAttribute('aria-label', label);
  }

  /** Call when the shell itself is being torn down (e.g. on logout). */
  destroy(): void {
    removeEventListener('hashchange', this.onHashChange);
    if (this.onConnectivity) {
      removeEventListener('online', this.onConnectivity);
      removeEventListener('offline', this.onConnectivity);
    }
    const d = this.o.doc;
    if (this.onDocPointer) d.removeEventListener('click', this.onDocPointer, true);
    if (this.onDocKey) d.removeEventListener('keydown', this.onDocKey);
    if (this.railQuery && this.onRailQuery) {
      this.railQuery.removeEventListener('change', this.onRailQuery);
    }
    this.currentRoute?.unmount?.();
  }

  /* ── chrome ─────────────────────────────────────────────────────────── */

  private resolvePath(): string {
    const h = location.hash.replace(/^#\/?/, '').split('?')[0];
    return this.o.routes.some((r) => r.path === h) ? h : this.o.defaultPath;
  }

  private route(path: string): ShellRoute | undefined {
    return this.o.routes.find((r) => r.path === path);
  }

  /** The five bottom-bar routes: the role's choice, or route order. */
  private barRoutes(): ShellRoute[] {
    const MAX_TABS = 5;   // Wireframe §2 — enforced here, not trusted to callers
    if (this.nav) {
      const picked = this.nav.tabs
        .map((p) => this.route(p))
        .filter((r): r is ShellRoute => Boolean(r));
      if (picked.length) return picked.slice(0, MAX_TABS);
      // Every tab the role asked for is missing from the route table. Falling
      // through beats rendering an empty bar: a nav model that has drifted
      // from the routes is a bug for nav.test.ts to fail on, not a reason to
      // leave a teacher with no navigation at all.
    }
    return this.o.routes.filter((r) => !r.hidden).slice(0, MAX_TABS);
  }

  private monogram(name: string): HTMLElement {
    const el = this.o.doc.createElement('span');
    el.className = 'shell-org-mark';
    el.setAttribute('aria-hidden', 'true');
    el.textContent = firstGrapheme(name);
    return el;
  }

  private renderChrome(): void {
    const d = this.o.doc;
    const root = this.o.root;
    root.textContent = '';
    root.setAttribute('lang', 'bn');

    const shellEl = d.createElement('div');
    shellEl.className = 'shell';
    this.shellEl = shellEl;
    if (this.o.demo) shellEl.dataset.demo = 'on';

    // Keyboard users land on this first; it is the only way past a
    // fifteen-row sidebar without fifteen Tab presses.
    const skip = d.createElement('a');
    skip.className = 'skip-link';
    skip.href = '#shell-view';
    skip.textContent = 'মূল অংশে যান';
    skip.addEventListener('click', (e) => {
      e.preventDefault();
      this.viewEl.focus();
    });

    this.viewEl = d.createElement('main');
    this.viewEl.className = 'shell-view';
    this.viewEl.id = 'shell-view';
    // Focusable but not tabbable: the skip link and every route change move
    // focus here, so a keyboard user's next Tab is inside the new page.
    this.viewEl.tabIndex = -1;

    const main = d.createElement('div');
    main.className = 'shell-main';
    main.append(this.buildTopbar());
    // §30. The demo marker and the role picker are their own strip rather
    // than three more things in the app bar. Two reasons, and the second is
    // the one that decided it: at 390px the chip, the picker, the bell and
    // the avatar left the institution's name showing "শা" and pushed the
    // avatar off the screen edge; and a banner saying this is a demo is a
    // stronger signal than a chip lost among the controls. Neither exists in
    // a real session — a school's staff never see this element at all.
    if (this.o.demo) main.append(this.buildDemoBar());
    main.append(this.buildOfflineBanner(), this.viewEl);

    shellEl.append(skip, this.buildSidebar(), main, this.buildTabbar());
    root.append(shellEl);

    this.applyRail();
    this.wireDismissal();
  }

  /* ── desktop sidebar ────────────────────────────────────────────────── */

  private buildSidebar(): HTMLElement {
    const d = this.o.doc;
    const aside = d.createElement('div');
    aside.className = 'd-sidebar';

    // Institution identity leads. Whose school this is outranks who is signed
    // in — a teacher covering at a second institution needs that distinction
    // more than a reminder of their own name (R-1).
    const brand = d.createElement('div');
    brand.className = 'd-brand shell-org';
    const name = this.o.institution?.name ?? '';
    if (this.o.institution?.logoUrl) {
      const img = d.createElement('img');
      img.className = 'shell-org-logo';
      img.src = this.o.institution.logoUrl;
      img.alt = '';
      brand.append(img);
    } else if (name) {
      brand.append(this.monogram(name));
    }
    const brandName = d.createElement('span');
    brandName.className = 'shell-org-name';
    brandName.textContent = name;
    brand.append(brandName);

    const rail = d.createElement('button');
    rail.type = 'button';
    rail.className = 'd-rail-toggle';
    rail.innerHTML = iconSvg('panel-left');
    rail.addEventListener('click', () => this.toggleRail());
    brand.append(rail);

    const nav = d.createElement('nav');
    nav.className = 'd-nav';
    nav.setAttribute('aria-label', 'প্রধান মেনু');

    const groups = this.nav
      ? this.nav.groups
      // No role (tests, previews): one flat group of every visible route, so
      // the sidebar is still navigable rather than empty.
      : [{ labelBn: '', items: this.o.routes.filter((r) => !r.hidden)
            .map((r) => ({ path: r.path, labelBn: r.labelBn, glyph: r.glyph })) }];

    for (const group of groups) {
      const section = d.createElement('div');
      section.className = 'd-nav-group';
      if (group.labelBn) {
        const label = d.createElement('p');
        label.className = 'd-nav-label';
        label.textContent = group.labelBn;
        // Hidden from readers when the rail collapses it away; the rows keep
        // their own accessible names either way.
        section.append(label);
      }
      for (const item of group.items) {
        if (!this.route(item.path)) continue;   // never render a dead link
        section.append(this.navRow(item.path, item.labelBn, item.glyph));
      }
      if (section.querySelector('.dnav')) nav.append(section);
    }

    const foot = d.createElement('div');
    foot.className = 'd-sidebar-foot';
    foot.append(this.profileButton('d-profile'));

    aside.append(brand, nav, foot);
    return aside;
  }

  private navRow(path: string, labelBn: string, glyph: string): HTMLElement {
    const d = this.o.doc;
    const a = d.createElement('a');
    a.className = 'dnav';
    a.href = `#/${path}`;
    a.dataset.path = path;
    // title, not a custom tooltip: when the rail hides the label this is the
    // only thing left, and the platform's own tooltip is the one that appears
    // for a mouse and is read by a screen reader without extra wiring.
    a.title = labelBn;
    const g = d.createElement('span');
    g.className = 'dnav-glyph';
    g.setAttribute('aria-hidden', 'true');
    g.innerHTML = iconSvg(glyph);
    const l = d.createElement('span');
    l.className = 'dnav-label';
    l.textContent = labelBn;
    a.append(g, l);
    this.remember(path, a);
    return a;
  }

  private remember(path: string, el: HTMLElement): void {
    const list = this.navEls.get(path) ?? [];
    list.push(el);
    this.navEls.set(path, list);
  }

  /* ── topbar ─────────────────────────────────────────────────────────── */

  private buildTopbar(): HTMLElement {
    const d = this.o.doc;
    const bar = d.createElement('header');
    bar.className = 'shell-topbar';

    // Mobile identity plate. On desktop the sidebar carries it, so this one
    // is hidden there rather than repeating the school's name twice.
    const org = d.createElement('span');
    org.className = 'shell-org shell-org-mobile';
    const name = this.o.institution?.name ?? '';
    if (this.o.institution?.logoUrl) {
      const img = d.createElement('img');
      img.className = 'shell-org-logo';
      img.src = this.o.institution.logoUrl;
      img.alt = '';
      org.append(img);
    } else if (name) {
      org.append(this.monogram(name));
    }
    const orgName = d.createElement('span');
    orgName.className = 'shell-org-name';
    orgName.textContent = name;
    org.append(orgName);
    // An empty name plate looks broken, so it is hidden until there is a name
    // — but it stays in the DOM, which the pre-P1 shell did not do. That shell
    // OMITTED the node, and `setInstitution` began with `if (!org) return`, so
    // a shell built before branding resolved could never be given a name at
    // all: it waited for a reload. Present-and-hidden is patchable.
    org.hidden = !name;

    // Desktop breadcrumb. Deliberately NOT a page <h1>: 26 views already
    // render their own, and §5 forbids saying the same thing twice in the
    // topbar and the content header. A breadcrumb ending in the page name is
    // an orientation cue at 13px, not a second title.
    const crumb = d.createElement('nav');
    crumb.className = 'shell-crumb';
    crumb.setAttribute('aria-label', 'অবস্থান');
    this.crumbEl = crumb;

    const actions = d.createElement('div');
    actions.className = 'shell-actions';

    // R-6's student search, reached from every screen for the roles whose
    // navigation carries it. Not a global search box: nothing in this system
    // searches across notices, fees and students at once, and an input that
    // implies it would be a promise the API cannot keep.
    if (this.route('students') && this.navHas('students')) {
      const search = d.createElement('a');
      search.className = 'shell-icon-btn shell-search';
      search.href = '#/students';
      search.setAttribute('aria-label', 'শিক্ষার্থী খুঁজুন');
      search.title = 'শিক্ষার্থী খুঁজুন';
      search.innerHTML = iconSvg('search');
      actions.append(search);
    }

    if (this.o.bell) actions.append(this.bellButton());
    actions.append(this.profileButton('shell-avatar'));

    bar.append(org, crumb, actions);
    return bar;
  }

  private buildDemoBar(): HTMLElement {
    const d = this.o.doc;
    const bar = d.createElement('div');
    bar.className = 'shell-demobar';
    const chip = d.createElement('span');
    chip.className = 'shell-demo-chip';
    chip.textContent = 'ডেমো পরিবেশ';
    const note = d.createElement('span');
    note.className = 'shell-demo-note';
    note.textContent = 'নমুনা তথ্য — কোনো প্রকৃত শিক্ষার্থীর তথ্য নয়';
    bar.append(chip, note);
    if (this.o.roleSwitcher) bar.append(this.roleSwitcher());
    return bar;
  }

  private navHas(path: string): boolean {
    if (!this.nav) return true;
    return this.nav.groups.some((g) => g.items.some((i) => i.path === path));
  }

  private bellButton(): HTMLButtonElement {
    const d = this.o.doc;
    const bell = d.createElement('button');
    bell.type = 'button';
    bell.className = 'shell-icon-btn shell-bell';
    bell.setAttribute('aria-label', 'নোটিশ');
    const glyph = d.createElement('span');
    glyph.className = 'shell-bell-glyph';
    glyph.setAttribute('aria-hidden', 'true');
    glyph.innerHTML = iconSvg('bell');
    const badge = d.createElement('span');
    badge.className = 'shell-bell-badge';
    badge.hidden = true;
    bell.append(glyph, badge);
    bell.addEventListener('click', () => this.o.bell?.onOpen());
    this.bellEls.push(bell);
    this.bellBadgeEls.push(badge);
    return bell;
  }

  private roleSwitcher(): HTMLElement {
    const d = this.o.doc;
    const picker = d.createElement('select');
    picker.className = 'shell-role';
    picker.setAttribute('aria-label', 'ডেমো ভূমিকা পরিবর্তন করুন');
    const roles: [string, string][] = [
      ['class_teacher', 'শ্রেণি শিক্ষক'],
      ['student', 'শিক্ষার্থী'],
      ['guardian', 'অভিভাবক'],
      ['principal', 'অধ্যক্ষ'],
      ['it_admin', 'আইটি অ্যাডমিন'],
      ['accountant', 'হিসাবরক্ষক'],
    ];
    for (const [value, label] of roles) {
      const opt = d.createElement('option');
      opt.value = value;
      opt.textContent = label;
      opt.selected = value === this.o.roleSwitcher?.current;
      picker.append(opt);
    }
    picker.addEventListener('change', () => this.o.roleSwitcher?.onChange(picker.value));
    return picker;
  }

  /* ── profile menu ───────────────────────────────────────────────────── */

  private profileButton(className: string): HTMLButtonElement {
    const d = this.o.doc;
    const btn = d.createElement('button');
    btn.type = 'button';
    btn.className = className;
    btn.setAttribute('aria-haspopup', 'menu');
    btn.setAttribute('aria-expanded', 'false');
    btn.setAttribute('aria-label', `${this.o.displayName} — অ্যাকাউন্ট মেনু`);

    const avatar = d.createElement('span');
    avatar.className = 'shell-avatar-mark';
    avatar.setAttribute('aria-hidden', 'true');
    avatar.textContent = firstGrapheme(this.o.displayName);

    const who = d.createElement('span');
    who.className = 'shell-who';
    const nm = d.createElement('span');
    nm.className = 'shell-who-name';
    nm.textContent = this.o.displayName;
    who.append(nm);
    if (this.o.role) {
      const rl = d.createElement('span');
      rl.className = 'shell-who-role';
      rl.textContent = roleLabel(this.o.role);
      who.append(rl);
    }

    btn.append(avatar, who);
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.toggleProfile(btn);
    });
    this.profileBtns.push(btn);
    return btn;
  }

  private toggleProfile(anchor: HTMLButtonElement): void {
    if (this.profileMenu) { this.closeProfile(); return; }
    const d = this.o.doc;
    const menu = d.createElement('div');
    menu.className = 'shell-menu';
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-label', 'অ্যাকাউন্ট');

    const head = d.createElement('div');
    head.className = 'shell-menu-head';
    const nm = d.createElement('p');
    nm.className = 'shell-menu-name';
    nm.textContent = this.o.displayName;
    head.append(nm);
    if (this.o.role) {
      const rl = d.createElement('p');
      rl.className = 'shell-menu-role';
      rl.textContent = roleLabel(this.o.role);
      head.append(rl);
    }
    menu.append(head);

    // The theme control, same storage and same three options as the More
    // screen's — one implementation in ui/theme.ts, offered in both places
    // because a desktop user never opens আরও and a phone user never sees
    // this menu's full form.
    const themeLabel = d.createElement('p');
    themeLabel.className = 'shell-menu-label';
    themeLabel.id = 'shell-theme-label';
    themeLabel.textContent = 'রঙের ধরন';
    const group = d.createElement('div');
    group.className = 'shell-theme';
    group.setAttribute('role', 'radiogroup');
    group.setAttribute('aria-labelledby', 'shell-theme-label');
    const current = readTheme();
    for (const opt of THEME_OPTIONS) {
      const b = d.createElement('button');
      b.type = 'button';
      b.className = 'theme-option';
      b.setAttribute('role', 'radio');
      const chosen = current === opt.value;
      b.setAttribute('aria-checked', String(chosen));
      b.dataset.chosen = String(chosen);
      b.textContent = opt.labelBn;
      b.addEventListener('click', () => {
        setTheme(opt.value);
        for (const other of group.querySelectorAll('.theme-option')) {
          const isThis = other === b;
          other.setAttribute('aria-checked', String(isThis));
          (other as HTMLElement).dataset.chosen = String(isThis);
        }
      });
      group.append(b);
    }
    menu.append(themeLabel, group);

    const logout = d.createElement('button');
    logout.type = 'button';
    logout.className = 'shell-menu-item shell-logout';
    logout.setAttribute('role', 'menuitem');
    const lg = d.createElement('span');
    lg.setAttribute('aria-hidden', 'true');
    lg.className = 'shell-menu-glyph';
    lg.innerHTML = iconSvg('log-out');
    const lt = d.createElement('span');
    lt.textContent = 'লগ আউট';
    logout.append(lg, lt);
    logout.addEventListener('click', () => { this.closeProfile(); this.o.onLogout(); });
    menu.append(logout);

    anchor.setAttribute('aria-expanded', 'true');
    anchor.after(menu);
    this.profileMenu = menu;
    // Focus the first control so the menu is usable from the keyboard the
    // instant it opens; Escape and an outside click both close it.
    menu.querySelector<HTMLElement>('button')?.focus();
  }

  private closeProfile(): void {
    if (!this.profileMenu) return;
    const anchor = this.profileMenu.previousElementSibling as HTMLElement | null;
    this.profileMenu.remove();
    this.profileMenu = null;
    for (const b of this.profileBtns) b.setAttribute('aria-expanded', 'false');
    anchor?.focus();
  }

  /**
   * Escape and outside-click, once for the whole shell.
   *
   * Capture phase on click: a menu item's own handler runs first and closes
   * the menu itself, so this only ever fires for a click that landed outside.
   */
  private wireDismissal(): void {
    const d = this.o.doc;
    this.onDocPointer = (e: Event) => {
      if (!this.profileMenu) return;
      const t = e.target as Node;
      if (this.profileMenu.contains(t)) return;
      if (this.profileBtns.some((b) => b.contains(t))) return;
      this.closeProfile();
    };
    this.onDocKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && this.profileMenu) {
        e.preventDefault();
        this.closeProfile();
      }
    };
    d.addEventListener('click', this.onDocPointer, true);
    d.addEventListener('keydown', this.onDocKey);
  }

  /* ── rail ───────────────────────────────────────────────────────────── */

  /**
   * The sidebar is an icon rail when the user asked for it, or when the
   * viewport is desktop-but-narrow (1024–1279) where 240px of chrome takes a
   * quarter of a 1024px screen away from a table that needs it.
   *
   * Expressed as an attribute rather than pure CSS because the condition is
   * "preference OR viewport", and CSS can only express that by repeating
   * every rail rule inside a media query — which is how the two halves
   * eventually disagree.
   */
  private applyRail(): void {
    const forced = () => typeof matchMedia === 'function'
      && matchMedia(`(min-width: ${DESKTOP_MIN}px) and (max-width: ${RAIL_MAX}px)`).matches;
    const pref = () => {
      try { return localStorage.getItem(RAIL_KEY) === 'on'; } catch { return false; }
    };
    const paint = () => {
      this.shellEl.dataset.rail = forced() || pref() ? 'on' : 'off';
      for (const b of this.shellEl.querySelectorAll('.d-rail-toggle')) {
        b.setAttribute('aria-expanded', String(this.shellEl.dataset.rail !== 'on'));
        b.setAttribute('aria-label', this.shellEl.dataset.rail === 'on'
          ? 'মেনু চওড়া করুন' : 'মেনু সংকুচিত করুন');
      }
    };
    paint();
    if (typeof matchMedia === 'function') {
      this.railQuery = matchMedia(`(max-width: ${RAIL_MAX}px)`);
      this.onRailQuery = paint;
      this.railQuery.addEventListener('change', paint);
    }
    this.repaintRail = paint;
  }

  private repaintRail: () => void = () => {};

  private toggleRail(): void {
    const on = this.shellEl.dataset.rail === 'on';
    try { localStorage.setItem(RAIL_KEY, on ? 'off' : 'on'); } catch { /* session only */ }
    this.repaintRail();
  }

  /* ── mobile bottom bar ──────────────────────────────────────────────── */

  private buildTabbar(): HTMLElement {
    const d = this.o.doc;
    const tabbar = d.createElement('nav');
    tabbar.className = 'shell-tabbar';
    tabbar.setAttribute('aria-label', 'দ্রুত মেনু');
    for (const route of this.barRoutes()) {
      const tab = d.createElement('button');
      tab.type = 'button';
      tab.className = 'shell-tab';
      tab.dataset.path = route.path;
      // Explicit accessible name — the child spans alone leave some readers
      // (and headless tools) with an empty button name.
      tab.setAttribute('aria-label', route.labelBn);
      const glyph = d.createElement('span');
      glyph.className = 'shell-tab-glyph';
      glyph.setAttribute('aria-hidden', 'true');
      glyph.innerHTML = iconSvg(route.glyph);
      const label = d.createElement('span');
      label.className = 'shell-tab-label';
      label.textContent = route.labelBn;
      tab.append(glyph, label);
      tab.addEventListener('click', () => { location.hash = `/${route.path}`; });
      this.remember(route.path, tab);
      tabbar.append(tab);
    }
    return tabbar;
  }

  private buildOfflineBanner(): HTMLElement {
    const d = this.o.doc;
    // Offline is a banner, never a modal (Wireframe §4): it must not block
    // work, and it belongs to the whole shell, not one screen — the moment a
    // teacher needs it most is mid-task, whatever screen they are on.
    const banner = d.createElement('p');
    banner.className = 'offline-banner';
    banner.setAttribute('role', 'status');
    const icon = d.createElement('span');
    icon.className = 'offline-icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.innerHTML = iconSvg('wifi-off');
    const text = d.createElement('span');
    text.textContent = 'অফলাইন — কাজ চালিয়ে যান, সংযোগ পেলে জমা হবে';
    banner.append(icon, text);
    this.onConnectivity = () => { banner.hidden = navigator.onLine; };
    this.onConnectivity();
    addEventListener('online', this.onConnectivity);
    addEventListener('offline', this.onConnectivity);
    return banner;
  }

  /* ── routing ────────────────────────────────────────────────────────── */

  private async renderRoute(): Promise<void> {
    const path = this.resolvePath();
    if (this.currentRoute?.path === path) return;

    this.closeProfile();
    this.currentRoute?.unmount?.();
    this.currentRoute = this.route(path) ?? null;

    for (const [p, els] of this.navEls) {
      const active = p === path;
      for (const el of els) {
        el.setAttribute('aria-current', active ? 'page' : 'false');
        el.classList.toggle('active', active);
      }
    }
    this.paintCrumb(path);

    this.viewEl.textContent = '';
    if (!this.currentRoute) return;
    await this.currentRoute.mount(this.viewEl);

    // Every navigation after the first moves focus into the new page and
    // resets the scroll. Without it a keyboard user's next Tab continues from
    // wherever it was in the sidebar, and a mouse user arrives at a new page
    // scrolled halfway down the previous one. Skipped on boot, where moving
    // focus would steal it from whatever the browser restored.
    if (this.booted) {
      this.viewEl.focus({ preventScroll: true });
      this.viewEl.scrollTop = 0;
      scrollTo({ top: 0 });
    }
    this.booted = true;
  }

  private paintCrumb(path: string): void {
    const crumb = this.crumbEl;
    if (!crumb) return;
    crumb.textContent = '';
    const d = this.o.doc;
    const parts = this.o.role
      ? crumbFor(this.o.role, path)
      : [this.route(path)?.labelBn ?? ''];
    const clean = parts.filter(Boolean);
    if (!clean.length) return;
    clean.forEach((part, i) => {
      if (i > 0) {
        const sep = d.createElement('span');
        sep.className = 'shell-crumb-sep';
        sep.setAttribute('aria-hidden', 'true');
        sep.textContent = '›';
        crumb.append(sep);
      }
      const el = d.createElement('span');
      el.className = 'shell-crumb-part';
      el.textContent = part;
      if (i === clean.length - 1) el.setAttribute('aria-current', 'page');
      crumb.append(el);
    });
  }
}

/**
 * The first character of a name, for a monogram.
 *
 * Bangla is the point: `'মোহাম্মদপুর'[0]` is `'ম'` but `'ক্ষুদ্র'[0]` is
 * `'ক'` with the conjunct's other half orphaned into the next slot, and a
 * name beginning with a surrogate pair (an emoji in a school's display name,
 * which happens) splits into a lone half. A grapheme segmenter takes the
 * whole cluster; where it is unavailable the spread operator at least takes
 * whole code points.
 */
function firstGrapheme(s: string): string {
  const t = s.trim();
  if (!t) return '•';
  try {
    const seg = new Intl.Segmenter('bn', { granularity: 'grapheme' });
    for (const g of seg.segment(t)) return g.segment;
  } catch { /* no Segmenter: fall through */ }
  return [...t][0] ?? '•';
}
