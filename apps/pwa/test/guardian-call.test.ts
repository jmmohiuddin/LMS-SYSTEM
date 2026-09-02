/**
 * A guardian's phone number is a call, and only where the server sent one.
 *
 * ── What is actually at stake ───────────────────────────────────────────
 * `GET /api/v1/ops/guardians` returns the real number to principal,
 * school_owner and it_admin, and `phone: null` to every other staff role —
 * server-side, because R-3 established that a number on a screen every teacher
 * can open is a number on every teacher's device. The panel must therefore
 * decide what to render from the DATA, never from a role it re-derives on the
 * client: a second copy of that rule is free to drift from the first, and
 * hiding a number the response still carried is the pattern D13 forbids.
 *
 * So both halves are asserted here. A number present becomes a `tel:` anchor
 * an office can press; a number absent leaves nothing at all — no empty link,
 * no dash, no separator hanging off the relation.
 */
import { test, describe, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

import { GuardianPanel } from '../src/guardian-panel.ts';

let dom: JSDOM;

before(() => {
  dom = new JSDOM('<!doctype html><html><body><main id="root"></main></body></html>',
                  { url: 'http://localhost/' });
  (globalThis as Record<string, unknown>).HTMLElement = dom.window.HTMLElement;
  for (const key of ['localStorage', 'location'] as const) {
    Object.defineProperty(globalThis, key, {
      value: dom.window[key], configurable: true, writable: true,
    });
  }
});

const FATHER = {
  linkId: 'l-1', guardianId: 'g-1', nameBn: 'আব্দুল হোসেন',
  phone: '+8801711223344', relation: 'father',
  isPrimary: true, receivesSms: true, canPayFees: true, otherWards: 0,
};
const MOTHER = {
  linkId: 'l-2', guardianId: 'g-2', nameBn: 'রোকেয়া বেগম',
  phone: null, relation: 'mother',
  isPrimary: false, receivesSms: true, canPayFees: false, otherWards: 2,
};

/**
 * The panel fetches on construction. A fake `authedFetch` is the whole seam —
 * what matters is the shape the server sends, which is what varies by role.
 */
function mount(guardians: unknown[], canManage = true): HTMLElement {
  const root = dom.window.document.createElement('div');
  const auth = {
    authedFetch: async () => ({
      ok: true, status: 200,
      json: async () => ({ student: { id: 's-1', nameBn: 'তানভীর হোসেন' }, guardians }),
    }),
  };
  new GuardianPanel({
    root, doc: dom.window.document,
    auth: auth as unknown as ConstructorParameters<typeof GuardianPanel>[0]['auth'],
    studentId: 's-1', studentNameBn: 'তানভীর হোসেন', canManage,
  });
  return root;
}

/** The panel loads asynchronously; give the microtask queue a turn. */
const settle = () => new Promise((r) => setTimeout(r, 0));

describe('the guardian call link', () => {
  beforeEach(() => { dom.window.document.body.innerHTML = '<main id="root"></main>'; });

  test('THE ONE THAT MATTERS — a number the server sent becomes a tel: link', async () => {
    const root = mount([FATHER]);
    await settle();

    const links = root.querySelectorAll('a[href^="tel:"]');
    assert.equal(links.length, 1, root.textContent ?? '');
    const a = links[0] as HTMLAnchorElement;

    // The href must be the raw E.164 a dialler understands.
    assert.equal(a.getAttribute('href'), 'tel:+8801711223344');
    assert.equal(a.textContent, '+8801711223344');

    // Named, because "+8801711223344" read aloud by a screen reader does not
    // say whose number it is or what pressing it does.
    const label = a.getAttribute('aria-label') ?? '';
    assert.match(label, /আব্দুল হোসেন/);
    assert.match(label, /ফোন করুন/);
  });

  test('THE ONE THAT MATTERS — no number means no link, and no debris', async () => {
    // What a class teacher receives. The panel must not invent a link, and
    // must not leave the separator that would have preceded one.
    const root = mount([MOTHER]);
    await settle();

    assert.equal(root.querySelectorAll('a[href^="tel:"]').length, 0);
    const text = root.textContent ?? '';
    assert.ok(!/\+880/.test(text), text);
    assert.ok(!/null|undefined/.test(text), text);
    // The relation still reads, and it is not followed by a dangling dot.
    assert.match(text, /মা/);
    assert.ok(!/মা\s*·\s*·/.test(text), text);
  });

  test('a mixed list links exactly the numbers that arrived', async () => {
    const root = mount([FATHER, MOTHER]);
    await settle();
    const hrefs = [...root.querySelectorAll('a[href^="tel:"]')]
      .map((a) => a.getAttribute('href'));
    assert.deepEqual(hrefs, ['tel:+8801711223344']);
  });

  test('the number stays in Latin digits', async () => {
    // R-8's rule: Bangla numerals for counts, Latin for money and for
    // identifiers. A phone number is an identifier — somebody reads it down
    // another phone, or types it into one.
    const root = mount([FATHER]);
    await settle();
    const a = root.querySelector('a[href^="tel:"]') as HTMLAnchorElement;
    assert.ok(!/[০-৯]/.test(a.textContent ?? ''), a.textContent ?? '');
    assert.ok(!/[০-৯]/.test(a.getAttribute('href') ?? ''));
  });

  test('a read-only viewer still gets the call', async () => {
    // `canManage` decides whether the permissions can be EDITED. It has
    // nothing to do with whether the office may ring the number — the server
    // already answered that by sending it.
    const root = mount([FATHER], false);
    await settle();
    assert.equal(root.querySelectorAll('a[href^="tel:"]').length, 1);
  });
});
