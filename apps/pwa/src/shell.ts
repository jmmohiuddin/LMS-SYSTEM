/**
 * Navigation shell: a hash router plus a bottom tab bar around the app's
 * screens. Before this, the PWA was a single hard-coded screen (see
 * app.ts's old direct `new AttendanceView(...)` call) — this is what turns
 * it into an app with more than one page.
 *
 * Framework-free like everything else here: routes own a `<div>` container
 * they render into, the shell owns only the persistent chrome (header, tab
 * bar) and swaps the container's contents on hash change. `hashchange` is
 * used rather than the History API — no server-side route handling exists
 * (this is a static PWA shell), so a plain in-page anchor jump is the
 * simplest thing that survives a reload and works fully offline.
 */
import { iconSvg } from './icon.ts';

export interface ShellRoute {
  path: string;       // hash fragment without '#/', e.g. 'attendance'
  labelBn: string;
  glyph: string;       // single-character tab icon — no icon font budget
  mount: (container: HTMLElement) => void | Promise<void>;
  /** Called when navigating away, so a view can release listeners/timers. */
  unmount?: () => void;
  /**
   * Routable but not on the tab bar — reached from the আরও (More) menu or a
   * deep link. Keeps the bar at 5 tabs while the app has more pages.
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
  /** Demo mode only — lets a previewer see each role's dashboard. */
  roleSwitcher?: { current: string; onChange: (role: string) => void };
  /**
   * R-1. The institution's name and logo for the top bar. A teacher on a
   * shared device should be able to tell at a glance which school this
   * install belongs to, and the top bar is the one piece of chrome present
   * on every screen. Optional so a caller that has not resolved branding
   * yet still gets a working shell.
   */
  institution?: { name: string; logoUrl?: string };
}

export class Shell {
  private readonly o: ShellOptions;
  private viewEl!: HTMLElement;
  private tabEls = new Map<string, HTMLButtonElement>();
  private currentRoute: ShellRoute | null = null;
  private readonly onHashChange = () => { void this.renderRoute(); };
  private onConnectivity?: () => void;

  constructor(options: ShellOptions) {
    this.o = options;
    this.renderChrome();
    addEventListener('hashchange', this.onHashChange);
    void this.renderRoute();
  }

  /**
   * Update the institution plate after construction.
   *
   * The shell is built from the CACHED branding so it paints immediately,
   * but the server's answer arrives a round-trip later — and on a device's
   * very first launch there is no cache at all, so without this the top bar
   * would sit on the neutral placeholder until the next reload. Patching
   * the two nodes in place rather than re-rendering keeps the current
   * route mounted and its scroll position intact.
   */
  setInstitution(institution: { name: string; logoUrl?: string }): void {
    this.o.institution = institution;
    const d = this.o.doc;
    const org = this.o.root.querySelector('.shell-org');
    if (!org) return;

    let nameEl = org.querySelector('.shell-org-name');
    if (!nameEl) {
      nameEl = d.createElement('span');
      nameEl.className = 'shell-org-name';
      org.append(nameEl);
    }
    nameEl.textContent = institution.name;

    const existing = org.querySelector<HTMLImageElement>('.shell-org-logo');
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
    } else {
      existing?.remove();
    }
  }

  /** Call when the shell itself is being torn down (e.g. on logout). */
  destroy(): void {
    removeEventListener('hashchange', this.onHashChange);
    if (this.onConnectivity) {
      removeEventListener('online', this.onConnectivity);
      removeEventListener('offline', this.onConnectivity);
    }
    this.currentRoute?.unmount?.();
  }

  private resolvePath(): string {
    const h = location.hash.replace(/^#\/?/, '');
    return this.o.routes.some((r) => r.path === h) ? h : this.o.defaultPath;
  }

  private renderChrome(): void {
    const d = this.o.doc;
    const root = this.o.root;
    root.textContent = '';
    root.setAttribute('lang', 'bn');

    const shellEl = d.createElement('div');
    shellEl.className = 'shell';

    const topbar = d.createElement('div');
    topbar.className = 'shell-topbar';

    // R-1: institution identity leads the bar, before the person's name.
    // Whose school this is outranks who is signed in — a teacher covering
    // at a second institution needs that distinction more than a reminder
    // of their own name.
    if (this.o.institution?.name) {
      const org = d.createElement('span');
      org.className = 'shell-org';
      if (this.o.institution.logoUrl) {
        const img = d.createElement('img');
        img.className = 'shell-org-logo';
        img.src = this.o.institution.logoUrl;
        img.alt = '';
        org.append(img);
      }
      const orgName = d.createElement('span');
      orgName.className = 'shell-org-name';
      orgName.textContent = this.o.institution.name;
      org.append(orgName);
      topbar.append(org);
    }

    const who = d.createElement('span');
    who.className = 'shell-who';
    who.textContent = this.o.displayName;
    const logout = d.createElement('button');
    logout.type = 'button';
    logout.className = 'shell-logout';
    logout.textContent = 'লগ আউট';
    logout.addEventListener('click', () => this.o.onLogout());

    // Demo-only role picker. The home dashboard differs per role, so
    // without this the student and guardian surfaces are unreachable in a
    // preview — and those are the two people a demo most needs to show.
    if (this.o.roleSwitcher) {
      const picker = d.createElement('select');
      picker.className = 'shell-role';
      picker.setAttribute('aria-label', 'ডেমো ভূমিকা পরিবর্তন করুন');
      const roles: [string, string][] = [
        ['class_teacher', 'শ্রেণি শিক্ষক'],
        ['student', 'শিক্ষার্থী'],
        ['guardian', 'অভিভাবক'],
        ['principal', 'অধ্যক্ষ'],
        ['accountant', 'হিসাবরক্ষক'],
      ];
      for (const [value, label] of roles) {
        const opt = d.createElement('option');
        opt.value = value;
        opt.textContent = label;
        opt.selected = value === this.o.roleSwitcher.current;
        picker.append(opt);
      }
      picker.addEventListener('change', () => this.o.roleSwitcher?.onChange(picker.value));
      topbar.append(who, picker, logout);
    } else {
      topbar.append(who, logout);
    }

    // Offline is a banner, never a modal (Wireframe §4): it must not block
    // work, and it belongs to the whole shell, not one screen — the moment a
    // teacher needs it most is mid-task, whatever screen they are on. Hidden
    // while online; toggled by the browser's own connectivity events.
    const offlineBanner = d.createElement('p');
    offlineBanner.className = 'offline-banner';
    offlineBanner.setAttribute('role', 'status');
    const offlineIcon = d.createElement('span');
    offlineIcon.className = 'offline-icon';
    offlineIcon.setAttribute('aria-hidden', 'true');
    offlineIcon.innerHTML = iconSvg('wifi-off');
    const offlineText = d.createElement('span');
    offlineText.textContent = 'অফলাইন — কাজ চালিয়ে যান, সংযোগ পেলে জমা হবে';
    offlineBanner.append(offlineIcon, offlineText);
    this.onConnectivity = () => { offlineBanner.hidden = navigator.onLine; };
    this.onConnectivity();
    addEventListener('online', this.onConnectivity);
    addEventListener('offline', this.onConnectivity);

    this.viewEl = d.createElement('div');
    this.viewEl.className = 'shell-view';
    this.viewEl.id = 'shell-view';

    const tabbar = d.createElement('nav');
    tabbar.className = 'shell-tabbar';
    tabbar.setAttribute('aria-label', 'প্রধান মেনু');
    // Wireframe §2: "Five tabs on the bar, role-aware. Everything else is
    // reachable but does not compete for bar space — a deliberate constraint
    // against tab sprawl as the feature count grew past the original
    // three-tab design."
    //
    // Enforced here rather than trusted to whoever adds the next route. At
    // 360px a sixth tab wraps its label onto two lines and the bar stops
    // being scannable, which is exactly how the constraint gets violated:
    // one reasonable-looking addition at a time.
    const MAX_TABS = 5;
    const barRoutes = this.o.routes.filter((r) => !r.hidden).slice(0, MAX_TABS);
    for (const route of barRoutes) {
      const tab = d.createElement('button');
      tab.type = 'button';
      tab.className = 'shell-tab';
      tab.dataset.path = route.path;
      // Explicit accessible name — the child spans alone leave some readers
      // (and headless tools like the browser MCP) with an empty button name.
      tab.setAttribute('aria-label', route.labelBn);
      const glyph = d.createElement('span');
      glyph.className = 'shell-tab-glyph';
      // route.glyph is an icon name (see ./icon.ts), rendered as inline SVG.
      glyph.setAttribute('aria-hidden', 'true');
      glyph.innerHTML = iconSvg(route.glyph);
      const label = d.createElement('span');
      label.className = 'shell-tab-label';
      label.textContent = route.labelBn;
      tab.append(glyph, label);
      tab.addEventListener('click', () => { location.hash = `/${route.path}`; });
      this.tabEls.set(route.path, tab);
      tabbar.append(tab);
    }

    shellEl.append(topbar, offlineBanner, this.viewEl, tabbar);
    root.append(shellEl);
  }

  private async renderRoute(): Promise<void> {
    const path = this.resolvePath();
    if (this.currentRoute?.path === path) return;

    this.currentRoute?.unmount?.();
    this.currentRoute = this.o.routes.find((r) => r.path === path) ?? null;

    for (const [p, tab] of this.tabEls) {
      const active = p === path;
      tab.setAttribute('aria-current', active ? 'page' : 'false');
      tab.classList.toggle('active', active);
    }

    this.viewEl.textContent = '';
    if (!this.currentRoute) return;
    await this.currentRoute.mount(this.viewEl);
  }
}
