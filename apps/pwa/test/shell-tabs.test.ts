/**
 * The tab bar is capped at five (Wireframe §2).
 *
 * "Five tabs on the bar, role-aware. Everything else is reachable but does
 * not compete for bar space — a deliberate constraint against tab sprawl as
 * the feature count grew past the original three-tab design."
 *
 * This is exactly the kind of rule that erodes one reasonable-looking
 * addition at a time — I broke it myself adding My Subjects and My
 * Attendance. A test is the only thing that holds it.
 */
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

import { Shell, type ShellRoute } from '../src/shell.ts';

let dom: JSDOM;

before(() => {
  dom = new JSDOM('<!doctype html><html><body><main id="root"></main></body></html>');
  (globalThis as Record<string, unknown>).HTMLElement = dom.window.HTMLElement;
  (globalThis as Record<string, unknown>).KeyboardEvent = dom.window.KeyboardEvent;
  // Shell calls bare addEventListener('hashchange') and reads location.hash,
  // which resolve off the global in a browser. jsdom keeps them on `window`.
  (globalThis as Record<string, unknown>).location = dom.window.location;
  (globalThis as Record<string, unknown>).addEventListener =
    dom.window.addEventListener.bind(dom.window);
  (globalThis as Record<string, unknown>).removeEventListener =
    dom.window.removeEventListener.bind(dom.window);
});

const route = (path: string, hidden = false): ShellRoute => ({
  path, labelBn: path, glyph: '•', hidden,
  mount: (c) => { c.textContent = path; },
});

function tabsFor(routes: ShellRoute[]): string[] {
  const root = dom.window.document.getElementById('root')!;
  root.textContent = '';
  new Shell({
    root, doc: dom.window.document, routes, defaultPath: routes[0].path,
    displayName: 'পরীক্ষা', onLogout: () => {},
  });
  return [...root.querySelectorAll('.shell-tab')]
    .map((t) => t.getAttribute('aria-label') ?? '');
}

describe('tab bar', () => {
  test('never renders more than five tabs, however many routes exist', () => {
    const many = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map((p) => route(p));
    const tabs = tabsFor(many);
    assert.equal(tabs.length, 5, `bar rendered ${tabs.length} tabs; §2 caps it at 5`);
  });

  test('the five are the first five declared, so order is the priority', () => {
    const tabs = tabsFor(['home', 'learn', 'homework', 'routine', 'more', 'extra'].map((p) => route(p)));
    assert.deepEqual(tabs, ['home', 'learn', 'homework', 'routine', 'more']);
  });

  test('a hidden route never takes a slot, even when there is room', () => {
    // My Subjects and My Attendance are hidden for exactly this reason:
    // reachable from the dashboard and More, absent from the bar.
    const tabs = tabsFor([
      route('home'), route('subjects', true), route('learn'), route('my-attendance', true),
    ]);
    assert.deepEqual(tabs, ['home', 'learn']);
  });

  test('a hidden route is still routable — hidden means off the bar, not gone', () => {
    const root = dom.window.document.getElementById('root')!;
    root.textContent = '';
    const routes = [route('home'), route('subjects', true)];
    const shell = new Shell({
      root, doc: dom.window.document, routes, defaultPath: 'home',
      displayName: 'পরীক্ষা', onLogout: () => {},
    });
    assert.ok(shell, 'shell constructs with hidden routes present');
    assert.equal(routes.find((r) => r.path === 'subjects')?.hidden, true);
  });

  test('fewer than five routes renders exactly those', () => {
    assert.equal(tabsFor([route('home'), route('more')]).length, 2);
  });
});

/**
 * P9-5 §17 — the shell asks before it loses somebody's work.
 *
 * Two views carried a `hasUnsavedChanges()` method that nothing ever called:
 * the assignment matrix since P9-1, the routine editor since P9-5. A guard
 * nobody asks is the same defect as a lock nobody can set, so the route
 * contract now has somewhere for the answer to go.
 *
 * The hash has already changed by the time the shell hears about it, which
 * is the part that makes this fiddly: blocking a navigation means putting
 * the address bar back, or it says the person is somewhere they are not.
 */
describe('leaving a view with unsaved work', () => {
  const root = () => dom.window.document.getElementById('root') as HTMLElement;

  /**
   * One shell at a time.
   *
   * Every Shell listens on the GLOBAL `hashchange`, so a shell left alive by
   * an earlier test answers this test's navigations too — and if its route
   * carries a guard, it blocks and rewrites the hash underneath the shell
   * being tested. The tests above never noticed because they only inspect
   * the first render.
   */
  let live: Shell | null = null;
  const shellWith = (routes: ShellRoute[]) => {
    live?.destroy();
    root().textContent = '';
    dom.window.location.hash = `#/${routes[0].path}`;
    live = new Shell({
      root: root(), doc: dom.window.document, routes, defaultPath: routes[0].path,
      displayName: 'পরীক্ষা', onLogout: () => {},
    });
    return live;
  };
  const settle = async () => {
    for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
  };

  test('THE ONE THAT MATTERS — a blocked navigation stays put, hash and all', async () => {
    let asked = 0;
    let resumeFn: (() => void) | null = null;
    const routes: ShellRoute[] = [
      { ...route('editor'), guardLeave: (resume) => { asked++; resumeFn = resume; return true; } },
      route('elsewhere'),
    ];
    shellWith(routes);
    await settle();

    dom.window.location.hash = '#/elsewhere';
    await settle();

    assert.equal(asked, 1, 'the view was asked');
    assert.match(root().textContent ?? '', /editor/, 'and is still on screen');
    assert.equal(dom.window.location.hash, '#/editor',
      'the address bar goes back too — otherwise the back button lands nowhere');
  });

  test('and confirming resumes the navigation that was blocked', async () => {
    let resumeFn: (() => void) | null = null;
    const routes: ShellRoute[] = [
      { ...route('editor'), guardLeave: (resume) => { resumeFn = resume; return true; } },
      route('elsewhere'),
    ];
    shellWith(routes);
    await settle();
    dom.window.location.hash = '#/elsewhere';
    await settle();
    assert.match(root().textContent ?? '', /editor/);

    (resumeFn as unknown as () => void)();
    await settle();
    assert.match(root().textContent ?? '', /elsewhere/, 'the person gets where they were going');
    assert.equal(dom.window.location.hash, '#/elsewhere');
  });

  test('a guard that returns false does not interrupt anybody', async () => {
    // The ordinary case, and the one that must stay cheap: nothing unsaved.
    let asked = 0;
    const routes: ShellRoute[] = [
      { ...route('editor'), guardLeave: () => { asked++; return false; } },
      route('elsewhere'),
    ];
    shellWith(routes);
    await settle();
    dom.window.location.hash = '#/elsewhere';
    await settle();
    assert.equal(asked, 1);
    assert.match(root().textContent ?? '', /elsewhere/);
  });

  test('a route with no guard behaves exactly as it always did', async () => {
    const routes: ShellRoute[] = [route('editor'), route('elsewhere')];
    shellWith(routes);
    await settle();
    dom.window.location.hash = '#/elsewhere';
    await settle();
    assert.match(root().textContent ?? '', /elsewhere/);
  });

  test('the guard is asked once per navigation, not once per render', async () => {
    // A guard that fired twice would show two dialogs, and the second would
    // outlive the answer to the first.
    let asked = 0;
    const routes: ShellRoute[] = [
      { ...route('editor'), guardLeave: (resume) => { asked++; resume(); return true; } },
      route('elsewhere'),
    ];
    shellWith(routes);
    await settle();
    dom.window.location.hash = '#/elsewhere';
    await settle();
    assert.equal(asked, 1);
    assert.match(root().textContent ?? '', /elsewhere/);
  });
});
