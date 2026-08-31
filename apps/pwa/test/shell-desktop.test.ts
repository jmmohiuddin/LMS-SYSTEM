/**
 * The application shell. (P1-A/B/D)
 *
 * The shell is the one component every screen is inside, so its failures are
 * never local: a sidebar that loses its active state is wrong on forty pages,
 * and a profile menu that cannot be closed traps focus on all of them.
 *
 * These are DOM tests, not layout tests — jsdom has no layout engine and
 * cannot tell whether the sidebar is 240px or gone. What is asserted here is
 * the STRUCTURE both layouts are built from, which is what an accessibility
 * tree and a keyboard actually walk. The geometry (breakpoints, overflow,
 * contrast, tap targets) is measured in a real browser and recorded in the
 * PHASE_LOG entry; neither check can stand in for the other.
 */
import { test, describe, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

import { Shell, type ShellRoute } from '../src/shell.ts';
import { navFor } from '../src/ui/nav.ts';

let dom: JSDOM;
const doc = () => dom.window.document;
const root = () => doc().getElementById('root') as HTMLElement;

before(() => {
  dom = new JSDOM('<!doctype html><html><body><main id="root"></main></body></html>',
    { url: 'http://localhost/app' });
  const g = globalThis as Record<string, unknown>;
  g.HTMLElement = dom.window.HTMLElement;
  g.KeyboardEvent = dom.window.KeyboardEvent;
  g.location = dom.window.location;
  // `navigator` is a getter-only global in Node 24, so plain assignment
  // throws. The shell reads navigator.onLine for the offline banner.
  Object.defineProperty(globalThis, 'navigator',
    { value: dom.window.navigator, configurable: true });
  // Same trap: Node 24 ships its own `localStorage` global, so `g.localStorage
  // = …` fails silently and the assignment appears to work. The shell's writes
  // are inside try/catch (private-browsing mode), so the failure surfaced as
  // "the theme was never stored" rather than as an error.
  Object.defineProperty(globalThis, 'localStorage',
    { value: dom.window.localStorage, configurable: true });
  // `applyTheme` writes data-theme on the document element, and the module
  // reads the bare global, not the `doc` the shell was handed.
  g.document = dom.window.document;
  g.addEventListener = dom.window.addEventListener.bind(dom.window);
  g.removeEventListener = dom.window.removeEventListener.bind(dom.window);
  // jsdom's matchMedia never matches, so the rail reads its stored preference
  // — the branch these tests exercise. The viewport branch is a browser check.
  g.matchMedia = (q: string) => ({
    matches: false, media: q,
    addEventListener() {}, removeEventListener() {},
  });
});

beforeEach(() => {
  root().textContent = '';
  dom.window.location.hash = '';
  try { dom.window.localStorage.clear(); } catch { /* ignore */ }
});

/** A route for every path a role's navigation mentions, plus extras. */
function routesFor(role: string): ShellRoute[] {
  const paths = new Set([
    ...navFor(role).groups.flatMap((g) => g.items.map((i) => i.path)),
    ...navFor(role).tabs,
    'home',
  ]);
  return [...paths].map((path) => ({
    path, labelBn: path, glyph: 'home',
    mount: (c: HTMLElement) => { c.textContent = `view:${path}`; },
  }));
}

function mount(opts: Partial<Parameters<typeof Shell.prototype.constructor>[0]> = {}): Shell {
  const role = (opts as { role?: string }).role;
  return new Shell({
    root: root(), doc: doc(), routes: routesFor(role ?? ''), defaultPath: 'home',
    displayName: 'রহিম উদ্দিন', onLogout: () => {},
    institution: { name: 'শাহজালাল আদর্শ উচ্চ বিদ্যালয়' },
    bell: { onOpen: () => {} },
    ...(opts as object),
  } as ConstructorParameters<typeof Shell>[0]);
}

describe('P1 — both navigations exist in one DOM', () => {
  test('THE ONE THAT MATTERS — sidebar and bottom bar are present together', () => {
    // The layout is chosen by CSS, not by JavaScript. If the shell ever
    // started rendering only one, every resize would remount the current
    // route and drop the user's focus and scroll position — and a rotated
    // phone would lose a half-entered attendance register.
    mount({ role: 'class_teacher' });
    assert.ok(root().querySelector('.d-sidebar'), 'desktop sidebar missing');
    assert.ok(root().querySelector('.shell-tabbar'), 'mobile bottom bar missing');
    assert.ok(root().querySelector('.shell-topbar'), 'top bar missing');
  });

  test('the two navigations have different accessible names', () => {
    // Both are in the tree; a screen reader meets whichever CSS reveals.
    // Two landmarks called "প্রধান মেনু" would be indistinguishable if a
    // future rule ever showed both.
    mount({ role: 'class_teacher' });
    const names = [...root().querySelectorAll('nav')]
      .map((n) => n.getAttribute('aria-label'));
    assert.equal(new Set(names).size, names.length, `duplicate nav labels: ${names}`);
  });

  test('the content region is a <main>, focusable but not tabbable', () => {
    mount({ role: 'class_teacher' });
    const view = root().querySelector('.shell-view') as HTMLElement;
    assert.equal(view.tagName, 'MAIN');
    assert.equal(view.tabIndex, -1);
  });

  test('a skip link is the first thing a keyboard reaches', () => {
    mount({ role: 'principal' });
    const first = root().querySelector('.shell')?.firstElementChild;
    assert.equal(first?.className, 'skip-link',
      'without this, reaching content past a 20-row sidebar costs 20 tabs');
  });
});

describe('P1 — the sidebar is the role’s, and never a dead link', () => {
  test('THE ONE THAT MATTERS — a row is only rendered if its route exists', () => {
    // A nav row whose route is unregistered is a link to nothing, and
    // esbuild tree-shakes the view out of the bundle as unreferenced. Both
    // times that shipped, the menu entry looked perfectly fine.
    const routes: ShellRoute[] = [
      { path: 'home', labelBn: 'হোম', glyph: 'home', mount: () => {} },
    ];
    new Shell({
      root: root(), doc: doc(), routes, defaultPath: 'home',
      displayName: 'x', onLogout: () => {}, role: 'principal',
    });
    const rendered = [...root().querySelectorAll('.dnav')]
      .map((a) => (a as HTMLElement).dataset.path);
    assert.deepEqual(rendered, ['home'],
      'the sidebar rendered rows for routes that do not exist');
  });

  test('each role gets its own grouped sidebar', () => {
    for (const role of ['class_teacher', 'student', 'guardian', 'principal', 'it_admin']) {
      root().textContent = '';
      mount({ role });
      const rows = [...root().querySelectorAll('.dnav')]
        .map((a) => (a as HTMLElement).dataset.path);
      assert.deepEqual(rows, navFor(role).groups.flatMap((g) => g.items.map((i) => i.path)),
        `${role}'s sidebar does not match its model`);
      assert.ok(root().querySelectorAll('.d-nav-label').length >= 2,
        `${role}'s sidebar is ungrouped`);
    }
  });

  test('an IT admin’s sidebar has no attendance row', () => {
    mount({ role: 'it_admin' });
    const rows = [...root().querySelectorAll('.dnav')]
      .map((a) => (a as HTMLElement).dataset.path);
    assert.ok(!rows.includes('attendance'));
    assert.ok(rows.includes('more'), 'but everything is still reachable');
  });

  test('with no role the sidebar still navigates', () => {
    // Demo previews and the older callers. An empty sidebar is worse than a
    // flat one, and this is the branch a caller that predates P1 takes.
    mount({});
    assert.ok(root().querySelectorAll('.dnav').length > 0);
  });

  test('every row carries a title, so the icon rail has tooltips', () => {
    mount({ role: 'principal' });
    for (const a of root().querySelectorAll('.dnav')) {
      assert.ok(a.getAttribute('title'), 'a collapsed rail leaves only the title');
    }
  });
});

describe('P1 — the active route is marked in every navigation at once', () => {
  test('THE ONE THAT MATTERS — sidebar and tab agree on where you are', () => {
    // They are separate elements for the same route. Marking one and not the
    // other means the answer to "which page am I on" depends on the width of
    // the window, which is the question navigation exists to answer.
    mount({ role: 'class_teacher' });
    dom.window.location.hash = '#/roster';
    dom.window.dispatchEvent(new dom.window.HashChangeEvent('hashchange'));

    const side = root().querySelector('.dnav[data-path="roster"]');
    const tab = root().querySelector('.shell-tab[data-path="roster"]');
    assert.ok(side && tab, 'roster should appear in both navigations');
    assert.equal(side.getAttribute('aria-current'), 'page');
    assert.equal(tab.getAttribute('aria-current'), 'page');
    assert.ok(side.classList.contains('active'));
    assert.ok(tab.classList.contains('active'));

    // …and exactly one row per navigation is current. (The breadcrumb's last
    // crumb is also aria-current="page" — that is the standard pattern for a
    // breadcrumb and is counted separately.)
    assert.equal(root().querySelectorAll('.dnav[aria-current="page"]').length, 1);
    assert.equal(root().querySelectorAll('.shell-tab[aria-current="page"]').length, 1);
  });

  test('the breadcrumb names the section and the page', () => {
    mount({ role: 'class_teacher' });
    dom.window.location.hash = '#/attendance';
    dom.window.dispatchEvent(new dom.window.HashChangeEvent('hashchange'));
    const parts = [...root().querySelectorAll('.shell-crumb-part')]
      .map((e) => e.textContent);
    assert.deepEqual(parts, ['দৈনন্দিন', 'হাজিরা']);
    const last = root().querySelectorAll('.shell-crumb-part');
    assert.equal(last[last.length - 1].getAttribute('aria-current'), 'page');
  });

  test('a hash with a query still resolves its route', () => {
    // The generation screen is reached as #/generation?routineId=…, and
    // `resolvePath` compared the whole fragment before P1 split it.
    const routes: ShellRoute[] = [
      { path: 'home', labelBn: 'হোম', glyph: 'home', mount: (c) => { c.textContent = 'home'; } },
      { path: 'generation', labelBn: 'ফলাফল', glyph: 'settings',
        mount: (c) => { c.textContent = 'generation'; } },
    ];
    new Shell({ root: root(), doc: doc(), routes, defaultPath: 'home',
                displayName: 'x', onLogout: () => {} });
    dom.window.location.hash = '#/generation?routineId=abc';
    dom.window.dispatchEvent(new dom.window.HashChangeEvent('hashchange'));
    assert.equal(root().querySelector('.shell-view')?.textContent, 'generation');
  });
});

describe('P1 — the profile menu', () => {
  test('THE ONE THAT MATTERS — Escape closes it and returns focus', () => {
    // A menu that cannot be dismissed from the keyboard is a focus trap on
    // every screen in the product, because this control is in the chrome.
    mount({ role: 'principal' });
    const btn = root().querySelector('.shell-avatar') as HTMLButtonElement;
    btn.click();
    assert.ok(root().querySelector('.shell-menu'), 'menu should open');
    assert.equal(btn.getAttribute('aria-expanded'), 'true');

    doc().dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    assert.equal(root().querySelector('.shell-menu'), null, 'Escape must close it');
    assert.equal(btn.getAttribute('aria-expanded'), 'false');
    assert.equal(doc().activeElement, btn, 'focus must come back to the trigger');
  });

  test('a click outside closes it', () => {
    mount({ role: 'principal' });
    (root().querySelector('.shell-avatar') as HTMLButtonElement).click();
    assert.ok(root().querySelector('.shell-menu'));
    doc().body.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    assert.equal(root().querySelector('.shell-menu'), null);
  });

  test('a click inside does not', () => {
    mount({ role: 'principal' });
    (root().querySelector('.shell-avatar') as HTMLButtonElement).click();
    const menu = root().querySelector('.shell-menu') as HTMLElement;
    menu.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    assert.ok(root().querySelector('.shell-menu'), 'the menu closed on its own contents');
  });

  test('navigating away closes it', () => {
    // Otherwise it floats over the next screen, anchored to nothing.
    mount({ role: 'class_teacher' });
    (root().querySelector('.shell-avatar') as HTMLButtonElement).click();
    dom.window.location.hash = '#/roster';
    dom.window.dispatchEvent(new dom.window.HashChangeEvent('hashchange'));
    assert.equal(root().querySelector('.shell-menu'), null);
  });

  test('it carries the person, the role and a way out', () => {
    mount({ role: 'it_admin' });
    (root().querySelector('.shell-avatar') as HTMLButtonElement).click();
    const menu = root().querySelector('.shell-menu') as HTMLElement;
    assert.match(menu.textContent ?? '', /রহিম উদ্দিন/);
    assert.match(menu.textContent ?? '', /আইটি অ্যাডমিন/, 'the role must not render as it_admin');
    assert.ok(menu.querySelector('.shell-logout'));
    assert.equal(menu.getAttribute('role'), 'menu');
  });

  test('the theme control writes the same key the boot script reads', () => {
    // app.html applies the theme before the stylesheet paints, from
    // `shikhon_theme`. A second control writing a different key would apply
    // for one session and vanish on reload.
    mount({ role: 'student' });
    (root().querySelector('.shell-avatar') as HTMLButtonElement).click();
    const opts = [...root().querySelectorAll('.shell-theme .theme-option')] as HTMLElement[];
    assert.equal(opts.length, 3, 'phone / light / dark');
    (opts[2] as HTMLButtonElement).click();
    assert.equal(dom.window.localStorage.getItem('shikhon_theme'), 'dark');
    assert.equal(doc().documentElement.getAttribute('data-theme'), 'dark');
    assert.equal(opts[2].getAttribute('aria-checked'), 'true');
    assert.equal(opts[0].getAttribute('aria-checked'), 'false');

    // 'system' is the ABSENCE of the key, never the string 'system'.
    (opts[0] as HTMLButtonElement).click();
    assert.equal(dom.window.localStorage.getItem('shikhon_theme'), null);
  });
});

describe('P1 — the institution, the bell and the demo marker', () => {
  test('the school’s identity appears in both plates', () => {
    mount({ role: 'principal' });
    const names = [...root().querySelectorAll('.shell-org-name')]
      .map((e) => e.textContent);
    assert.equal(names.length, 2, 'sidebar brand and mobile header');
    assert.ok(names.every((n) => n === 'শাহজালাল আদর্শ উচ্চ বিদ্যালয়'));
  });

  test('setInstitution patches both, without remounting the route', () => {
    const shell = mount({ role: 'principal' });
    dom.window.location.hash = '#/students';
    dom.window.dispatchEvent(new dom.window.HashChangeEvent('hashchange'));
    const before = root().querySelector('.shell-view')?.textContent;

    shell.setInstitution({ name: 'মোহাম্মদপুর কলেজ' });
    assert.deepEqual([...root().querySelectorAll('.shell-org-name')].map((e) => e.textContent),
      ['মোহাম্মদপুর কলেজ', 'মোহাম্মদপুর কলেজ']);
    assert.equal(root().querySelector('.shell-view')?.textContent, before,
      'the mounted route must survive a branding update');
  });

  test('the monogram takes a whole Bangla grapheme, not a half one', () => {
    // `'ক্ষুদ্র'[0]` is 'ক' with the conjunct's other half orphaned into the
    // next slot. A school whose name begins with a conjunct would show a
    // broken cluster in the chrome of every screen.
    const shell = mount({ role: 'student' });
    shell.setInstitution({ name: 'ক্ষুদ্র বিদ্যালয়' });
    const mark = root().querySelector('.shell-org-mark');
    assert.ok(mark);
    assert.ok((mark.textContent ?? '').length > 1,
      `expected a full grapheme cluster, got ${JSON.stringify(mark.textContent)}`);
  });

  test('a logo replaces the monogram rather than sitting beside it', () => {
    const shell = mount({ role: 'student' });
    shell.setInstitution({ name: 'ঢাকা কলেজ', logoUrl: 'https://cdn.example/l.png' });
    for (const org of root().querySelectorAll('.shell-org')) {
      assert.ok(org.querySelector('.shell-org-logo'));
      assert.equal(org.querySelector('.shell-org-mark'), null);
    }
  });

  test('the unread badge counts, hides at zero and caps at ৯+', () => {
    const shell = mount({ role: 'guardian' });
    const badge = root().querySelector('.shell-bell-badge') as HTMLElement;
    shell.setUnread(0);
    assert.equal(badge.hidden, true, 'a badge reading zero is noise');
    shell.setUnread(3);
    assert.equal(badge.hidden, false);
    assert.equal(badge.textContent, '৩');
    shell.setUnread(42);
    assert.equal(badge.textContent, '৯+', 'three digits do not fit a 20px badge');
    assert.match(root().querySelector('.shell-bell')?.getAttribute('aria-label') ?? '', /পড়া হয়নি/);
  });

  test('a demo says so, and a real session never does', () => {
    // §31/§30. A demo that looks exactly like the product is a trust problem
    // the moment somebody screenshots it.
    mount({ role: 'class_teacher', demo: true } as never);
    assert.ok(root().querySelector('.shell-demobar'), 'demo must be marked in the chrome');
    assert.match(root().querySelector('.shell-demobar')?.textContent ?? '', /ডেমো/);

    root().textContent = '';
    mount({ role: 'class_teacher' });
    assert.equal(root().querySelector('.shell-demobar'), null,
      'a school must never see a demo marker');
  });
});

describe('P1 — the icon rail', () => {
  test('the stored preference is applied on construction', () => {
    dom.window.localStorage.setItem('shikhon_sidebar_rail', 'on');
    mount({ role: 'principal' });
    assert.equal(root().querySelector('.shell')?.getAttribute('data-rail'), 'on');
  });

  test('the toggle flips it and remembers', () => {
    mount({ role: 'principal' });
    const shell = root().querySelector('.shell') as HTMLElement;
    assert.equal(shell.dataset.rail, 'off');
    (root().querySelector('.d-rail-toggle') as HTMLButtonElement).click();
    assert.equal(shell.dataset.rail, 'on');
    assert.equal(dom.window.localStorage.getItem('shikhon_sidebar_rail'), 'on');
    (root().querySelector('.d-rail-toggle') as HTMLButtonElement).click();
    assert.equal(shell.dataset.rail, 'off');
  });

  test('the toggle says which way it goes', () => {
    mount({ role: 'principal' });
    const btn = root().querySelector('.d-rail-toggle') as HTMLButtonElement;
    assert.equal(btn.getAttribute('aria-expanded'), 'true');
    assert.match(btn.getAttribute('aria-label') ?? '', /সংকুচিত/);
    btn.click();
    assert.equal(btn.getAttribute('aria-expanded'), 'false');
    assert.match(btn.getAttribute('aria-label') ?? '', /চওড়া/);
  });
});

describe('P1 — nothing in the chrome is nameless', () => {
  test('every control has an accessible name', () => {
    // The bottom tabs already needed explicit aria-labels: their child spans
    // alone leave some readers, and headless tools, with an empty name.
    mount({ role: 'principal', demo: true } as never);
    (root().querySelector('.shell-avatar') as HTMLButtonElement).click();
    const nameless = [...root().querySelectorAll('button, a[href], select')]
      .filter((el) => !(el.getAttribute('aria-label') || el.getAttribute('aria-labelledby')
                        || (el.textContent ?? '').trim() || el.getAttribute('title')))
      .map((el) => el.className);
    assert.deepEqual(nameless, []);
  });
});
