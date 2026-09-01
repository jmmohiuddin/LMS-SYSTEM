/**
 * P5/B-34 — the IT Admin and Principal surfaces.
 *
 * What these guard is mostly what a browser measured and a unit test would
 * not have: that a desktop gets a TABLE where it used to get a phone layout,
 * that no uuid reaches the screen, and that a person who may not save is told
 * so rather than handed twelve live fields and a dead button.
 */
import { test, describe, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

import { UsersView } from '../src/users-view.ts';
import { AuditView } from '../src/audit-view.ts';
import { BrandingView } from '../src/branding-view.ts';
import { permissionMessage } from '../src/ui/feedback.ts';

let dom: JSDOM;

before(() => {
  dom = new JSDOM('<!doctype html><html><body><main id="root"></main></body></html>',
                  { url: 'http://localhost/' });
  (globalThis as Record<string, unknown>).HTMLElement = dom.window.HTMLElement;
  // branding-view narrows with , which jsdom does
  // not put on the global. Same reason HTMLElement is planted above.
  (globalThis as Record<string, unknown>).HTMLInputElement = dom.window.HTMLInputElement;
  (globalThis as Record<string, unknown>).HTMLSelectElement = dom.window.HTMLSelectElement;
  (globalThis as Record<string, unknown>).HTMLTextAreaElement = dom.window.HTMLTextAreaElement;
  for (const key of ['localStorage', 'location'] as const) {
    Object.defineProperty(globalThis, key, {
      value: dom.window[key], configurable: true, writable: true,
    });
  }
  Object.defineProperty(globalThis, 'navigator', {
    value: { onLine: true }, configurable: true, writable: true,
  });
});

const root = () => dom.window.document.getElementById('root') as HTMLElement;
const settle = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0)); };
const text = () => root().textContent ?? '';

function auth(body: unknown, status = 200) {
  return {
    tenantId: 't-1',
    authedFetch: async () => ({
      ok: status >= 200 && status < 300, status, json: async () => body,
    } as unknown as Response),
  } as never;
}

const USERS = {
  users: [
    {
      id: '7b06d000-0000-4000-8000-0000000000a1', nameBn: 'রহিম স্যার',
      roles: ['class_teacher'], status: 'active',
      employeeCode: 'T-101', studentCode: null,
    },
    {
      id: '7b06d000-0000-4000-8000-0000000000a2', nameBn: 'করিম স্যার',
      roles: ['subject_teacher'], status: 'left',
      employeeCode: 'T-102', studentCode: null,
    },
  ],
  truncated: false,
};

describe('B-34 — the user list is a table on a desktop', () => {
  beforeEach(async () => {
    root().textContent = '';
    new UsersView({
      root: root(), doc: dom.window.document, auth: auth(USERS), canManage: true,
    } as never);
    await settle();
  });

  test('renders BOTH shapes from one column definition', () => {
    // The CSS decides which is visible; both exist so neither is a
    // reimplementation of the other. Before this the screen had only the
    // phone shape, stretched across a 1440px office monitor.
    assert.ok(root().querySelector('table.ui-table'), 'a real desktop table');
    assert.ok(root().querySelector('.ui-list'), 'and a mobile list');
  });

  test('the columns are the ones an office needs, in order', () => {
    const heads = [...root().querySelectorAll('thead th')].map((h) => h.textContent);
    assert.deepEqual(heads, ['নাম', 'ভূমিকা', 'আইডি', 'অবস্থা', 'ব্যবস্থা']);
  });

  test('the id column is the SCHOOL’s code, never the uuid', () => {
    assert.match(text(), /T-101/);
    assert.doesNotMatch(text(), /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-/,
      'a uuid is a string nobody can read down a phone');
  });

  test('status is a word, not a tint', () => {
    // Somebody who cannot see colour must still be able to tell an active
    // account from a departed one.
    assert.match(text(), /সক্রিয়/);
    const badges = [...root().querySelectorAll('.ui-badge, .status-chip')];
    assert.ok(badges.length >= 2);
    for (const b of badges) assert.ok((b.textContent ?? '').trim().length > 0);
  });

  test('every action names the person it acts on', () => {
    // Forty buttons all called "কোড" are forty identical announcements.
    const labelled = [...root().querySelectorAll('button[aria-label]')]
      .map((b) => b.getAttribute('aria-label') ?? '');
    assert.ok(labelled.some((l) => l.includes('রহিম স্যার')));
    for (const l of labelled) {
      assert.doesNotMatch(l, /undefined|null|[0-9a-f]{8}-[0-9a-f]{4}-/);
    }
  });

  test('a deactivated account is not offered a way back in by an activation code', () => {
    // "করিম স্যার" has left. The code button exists only for accounts that
    // can still sign in.
    // Scoped per SHAPE. `dataTable` renders the desktop table and the mobile
    // list from one definition, so every action cell is built twice and only
    // one shape is ever visible — counting across both is counting the
    // rendering strategy, not the rule.
    for (const scope of ['table.ui-table', '.ui-list']) {
      const host = root().querySelector(scope);
      assert.ok(host, scope);
      const codeButtons = [...host.querySelectorAll('button[data-action="issue-code"]')];
      assert.equal(codeButtons.length, 1, `${scope}: only the active account`);
      assert.match(codeButtons[0].getAttribute('aria-label') ?? '', /রহিম স্যার/);
    }
  });

  test('a reader who may not manage gets no action column at all', async () => {
    root().textContent = '';
    new UsersView({
      root: root(), doc: dom.window.document, auth: auth(USERS), canManage: false,
    } as never);
    await settle();
    const heads = [...root().querySelectorAll('thead th')].map((h) => h.textContent);
    assert.ok(!heads.includes('ব্যবস্থা'));
    assert.equal(root().querySelectorAll('button[data-action="issue-code"]').length, 0);
  });
});

describe('B-34 — the audit viewer', () => {
  const ENTRIES = {
    entries: [{
      id: 'e1', at: '2026-05-02T09:12:00Z',
      actor: { id: '7b06d000-0000-4000-8000-0000000000a1', nameBn: 'প্রধান শিক্ষক', role: 'principal' },
      action: 'ops.guardian.permissions', entityType: 'guardianship',
      entityId: '7b06d000-0000-4000-8000-0000000000e1',
      before: { canPayFees: true, receivesSms: true },
      after: { canPayFees: false, receivesSms: true },
    }],
    hasMore: false, actions: ['ops.guardian.permissions'], actors: [],
  };

  test('THE ONE THAT MATTERS — no uuid reaches the screen', async () => {
    root().textContent = '';
    new AuditView({ root: root(), doc: dom.window.document, auth: auth(ENTRIES) } as never);
    await settle();
    // Open the entry, because the uuid used to live inside the expanded diff.
    const head = root().querySelector('.notice-head') as HTMLElement | null;
    head?.click();
    await settle();
    assert.doesNotMatch(text(), /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-/,
      'the entry used to end with "শনাক্তকারী: <uuid>"');
    for (const el of root().querySelectorAll('[aria-label],[title]')) {
      const s = (el.getAttribute('aria-label') ?? '') + (el.getAttribute('title') ?? '');
      assert.doesNotMatch(s, /[0-9a-f]{8}-[0-9a-f]{4}-/);
    }
  });

  test('the diff shows only what changed, in words', async () => {
    root().textContent = '';
    new AuditView({ root: root(), doc: dom.window.document, auth: auth(ENTRIES) } as never);
    await settle();
    (root().querySelector('.notice-head') as HTMLElement | null)?.click();
    await settle();
    assert.match(text(), /ফি পরিশোধের অনুমতি/, 'the field that changed, named in Bangla');
    assert.doesNotMatch(text(), /এসএমএস\s*:/,
      'receivesSms did not change, so it is not in the diff');
  });

  test('a refusal names the roles that CAN read it, and shows no list', async () => {
    root().textContent = '';
    new AuditView({ root: root(), doc: dom.window.document, auth: auth({}, 403) } as never);
    await settle();
    assert.match(text(), new RegExp(permissionMessage('কার্যবিবরণী')));
    assert.match(text(), /প্রধান শিক্ষক, প্রতিষ্ঠান মালিক ও আইটি অ্যাডমিন/);
    assert.equal(root().querySelectorAll('.notice-card').length, 0,
      'an empty list under a refusal claims "there is nothing here", which is untrue');
    assert.doesNotMatch(text(), /আবার চেষ্টা/, 'no retry can help');
  });
});

describe('B-34 — branding is read-only for a reader who cannot save', () => {
  const BRANDING = { branding: { nameBn: 'শাহজালাল', nameEn: 'Shahjalal' } };

  test('a class teacher gets no live fields, and is told why', async () => {
    // The bug: `readOnly` was set only on a 403, and the branding GET is
    // PUBLIC — it is what the login screen draws before anybody signs in. So a
    // teacher got 200, twelve editable inputs and a save that could only fail.
    root().textContent = '';
    new BrandingView({
      root: root(), doc: dom.window.document, auth: auth(BRANDING),
      tenantKey: 't-1', canManage: false,
    } as never);
    await settle();
    const inputs = [...root().querySelectorAll('input,textarea,select')] as Array<{ disabled: boolean }>;
    assert.ok(inputs.length > 0);
    assert.equal(inputs.filter((i) => !i.disabled).length, 0,
      'a field that accepts text it cannot save is a dead end');
    assert.match(text(), /শুধু দেখতে পারবেন/);
  });

  test('an IT admin gets the form', async () => {
    root().textContent = '';
    new BrandingView({
      root: root(), doc: dom.window.document, auth: auth(BRANDING),
      tenantKey: 't-1', canManage: true,
    } as never);
    await settle();
    const inputs = [...root().querySelectorAll('input,textarea,select')] as Array<{ disabled: boolean }>;
    assert.ok(inputs.filter((i) => !i.disabled).length > 0);
    assert.doesNotMatch(text(), /শুধু দেখতে পারবেন/);
  });
});
