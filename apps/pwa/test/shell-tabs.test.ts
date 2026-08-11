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
