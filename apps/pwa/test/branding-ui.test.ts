/**
 * R-1 white-label tests — the browser half.
 *
 * The requirement is that one deployment serves institutions with
 * completely different identities and never mixes them. These tests hold
 * the parts of that promise that live in the PWA: what the login screen
 * paints, what the shell paints, what the document head carries, and that
 * a second tenant on the same device inherits nothing from the first.
 */
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

import {
  applyBranding,
  cachedBranding,
  cacheBranding,
  clearBrandingCache,
  fetchPublicBranding,
} from '../src/branding.ts';
import { LoginView } from '../src/login-view.ts';
import { Shell, type ShellRoute } from '../src/shell.ts';
import { parseBranding, DEFAULT_BRANDING } from '../../../packages/ui-core/src/branding.ts';

const PNG_A =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const SCHOOL_A = parseBranding({
  nameBn: 'শাহজালাল আদর্শ উচ্চ বিদ্যালয়',
  nameEn: 'Shahjalal Adarsha High School',
  shortName: 'শাহজালাল',
  logoUrl: PNG_A,
  primaryColor: '#156a3f',
  accentColor: '#4e7a94',
});

const COLLEGE_B = parseBranding({
  nameBn: 'নর্থ সিটি মহিলা কলেজ',
  nameEn: 'North City College',
  shortName: 'নর্থ সিটি',
  primaryColor: '#1b3e7a',
  accentColor: '#a76a47',
});

let dom: JSDOM;

/**
 * A fresh DOM and a fresh localStorage for every test. Branding is cached
 * per tenant and applied to a shared document, so a test that inherited
 * either would be testing the previous test's state — which is exactly the
 * cross-tenant leak these tests exist to catch.
 */
beforeEach(() => {
  dom = new JSDOM(
    '<!doctype html><html><head><title>placeholder</title></head>'
    + '<body><main id="root"></main></body></html>',
    { url: 'https://school.example/' },
  );
  const g = globalThis as Record<string, unknown>;
  g.HTMLElement = dom.window.HTMLElement;
  g.HTMLInputElement = dom.window.HTMLInputElement;
  g.HTMLTextAreaElement = dom.window.HTMLTextAreaElement;
  g.KeyboardEvent = dom.window.KeyboardEvent;
  g.location = dom.window.location;
  g.localStorage = dom.window.localStorage;
  g.addEventListener = dom.window.addEventListener.bind(dom.window);
  g.removeEventListener = dom.window.removeEventListener.bind(dom.window);
  // navigator is deliberately NOT overridden: it is a getter-only global in
  // Node, and Shell only reads navigator.onLine, which is harmlessly
  // undefined here (the offline banner starts hidden either way).
  dom.window.localStorage.clear();
});

const doc = () => dom.window.document;
const root = () => doc().getElementById('root')!;

/** A stand-in for Auth; LoginView only reads what the login flow needs. */
function fakeAuth(): Record<string, unknown> {
  return {
    tenantId: '',
    userId: '',
    role: 'class_teacher',
    displayName: 'পরীক্ষা',
    isLoggedIn: () => false,
    requestOtp: async () => {},
    verifyOtp: async () => {},
    redeemActivationCode: async () => {},
    authedFetch: async () => new Response('{}'),
    logout: async () => {},
  };
}

describe('applyBranding', () => {
  test('paints title, theme colour, favicon and manifest for the tenant', () => {
    applyBranding(doc(), SCHOOL_A, { tenantKey: 'tenant-a' });

    assert.equal(doc().title, 'শাহজালাল আদর্শ উচ্চ বিদ্যালয়');
    assert.equal(
      doc().querySelector('meta[name="theme-color"]')?.getAttribute('content'),
      '#156a3f',
    );
    assert.equal(doc().querySelector('link[rel="icon"]')?.getAttribute('href'), PNG_A);
    assert.equal(
      doc().querySelector('link[rel="manifest"]')?.getAttribute('href'),
      '/api/v1/ops/manifest?tid=tenant-a',
    );
  });

  test('drives the semantic tokens the stylesheet reads, in both themes', () => {
    applyBranding(doc(), SCHOOL_A, { tenantKey: 'tenant-a' });
    const css = doc().getElementById('tenant-branding')?.textContent ?? '';

    // app.css writes its rules against --c-primary; setting only
    // --color-primary would leave the app looking exactly as it did.
    assert.match(css, /--c-primary:#156a3f/);
    // The dark block must be emitted at matching specificity, or the
    // design system's default dark steps win over the tenant's.
    assert.match(css, /:root\[data-theme='dark'\]\{/);
  });

  test('replaces rather than accumulates when branding changes', () => {
    applyBranding(doc(), SCHOOL_A, { tenantKey: 'tenant-a' });
    applyBranding(doc(), COLLEGE_B, { tenantKey: 'tenant-b' });

    assert.equal(doc().querySelectorAll('#tenant-branding').length, 1);
    const css = doc().getElementById('tenant-branding')?.textContent ?? '';
    assert.match(css, /#1b3e7a/);
    assert.doesNotMatch(css, /#156a3f/);
    assert.equal(doc().title, 'নর্থ সিটি মহিলা কলেজ');
  });

  test('leaves the favicon alone when a tenant has no image at all', () => {
    applyBranding(doc(), COLLEGE_B, { tenantKey: 'tenant-b' });
    // Nothing to point at is not a reason to point at nothing — the
    // platform default in the HTML stays.
    assert.equal(doc().querySelector('link[rel="icon"]'), null);
  });
});

describe('branding cache', () => {
  test('is keyed per tenant, so one school never paints another', () => {
    cacheBranding('tenant-a', SCHOOL_A);
    cacheBranding('tenant-b', COLLEGE_B);

    assert.equal(cachedBranding('tenant-a').nameBn, SCHOOL_A.nameBn);
    assert.equal(cachedBranding('tenant-b').nameBn, COLLEGE_B.nameBn);
    assert.notEqual(cachedBranding('tenant-a').primaryColor,
      cachedBranding('tenant-b').primaryColor);
  });

  test('an unknown tenant gets the neutral default, not the last one seen', () => {
    cacheBranding('tenant-a', SCHOOL_A);
    assert.deepEqual(cachedBranding('tenant-zzz'), DEFAULT_BRANDING);
  });

  test('re-validates what it reads back, because localStorage is writable', () => {
    // Anything else on this origin can write here, and these values reach
    // a stylesheet and an <img src>.
    dom.window.localStorage.setItem('shikhon_branding_tenant-a', JSON.stringify({
      nameBn: 'ক', primaryColor: 'red; background:url(//evil)', logoUrl: 'javascript:alert(1)',
    }));
    const b = cachedBranding('tenant-a');
    assert.equal(b.primaryColor, DEFAULT_BRANDING.primaryColor);
    assert.equal(b.logoUrl, '');
  });

  test('survives corrupt JSON', () => {
    dom.window.localStorage.setItem('shikhon_branding_tenant-a', '{not json');
    assert.deepEqual(cachedBranding('tenant-a'), DEFAULT_BRANDING);
  });

  test('clearBrandingCache wipes every tenant on a shared device', () => {
    cacheBranding('tenant-a', SCHOOL_A);
    cacheBranding('tenant-b', COLLEGE_B);
    clearBrandingCache();
    assert.deepEqual(cachedBranding('tenant-a'), DEFAULT_BRANDING);
    assert.deepEqual(cachedBranding('tenant-b'), DEFAULT_BRANDING);
  });
});

describe('fetchPublicBranding', () => {
  test('caches what the server returns', async () => {
    const fake = async () => new Response(
      JSON.stringify({ branding: { nameBn: 'ঢাকা কলেজ', primaryColor: '#123456' } }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
    const b = await fetchPublicBranding('tenant-a', fake as unknown as typeof fetch);
    assert.equal(b.nameBn, 'ঢাকা কলেজ');
    assert.equal(cachedBranding('tenant-a').nameBn, 'ঢাকা কলেজ');
  });

  test('falls back to the cache when the network fails', async () => {
    cacheBranding('tenant-a', SCHOOL_A);
    const failing = async () => { throw new Error('offline'); };
    const b = await fetchPublicBranding('tenant-a', failing as unknown as typeof fetch);
    // The login screen must render on a dead link; this is the whole
    // reason branding is cached rather than awaited.
    assert.equal(b.nameBn, SCHOOL_A.nameBn);
  });

  test('a public payload never erases the private fields already cached', async () => {
    cacheBranding('tenant-a', parseBranding({ ...SCHOOL_A, address: 'সিলেট', phone: '+8801711000001' }));
    const fake = async () => new Response(
      JSON.stringify({ branding: { nameBn: SCHOOL_A.nameBn, primaryColor: '#156a3f' } }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
    await fetchPublicBranding('tenant-a', fake as unknown as typeof fetch);
    assert.equal(cachedBranding('tenant-a').address, 'সিলেট');
  });
});

describe('login screen', () => {
  test('shows the institution, and names no platform', () => {
    cacheBranding('tenant-a', SCHOOL_A);
    new LoginView({
      root: root(), doc: doc(), auth: fakeAuth() as never,
      tenantId: 'tenant-a', onLoggedIn: () => {},
    });
    const text = root().textContent ?? '';

    assert.match(text, /শাহজালাল আদর্শ উচ্চ বিদ্যালয়/);
    // The regression this test exists for: login-view.ts hard-coded
    // 'ShikhonBD' and 'শিখন' on every school's login screen.
    assert.doesNotMatch(text, /ShikhonBD/);
    assert.doesNotMatch(text, /শিখন/);
    // The logo replaces the platform's "শি" glyph.
    assert.equal(root().querySelector('.login-brandlogo')?.getAttribute('src'), PNG_A);
  });

  test('falls back to the first letter of the school name, not a platform glyph', () => {
    cacheBranding('tenant-b', COLLEGE_B);
    new LoginView({
      root: root(), doc: doc(), auth: fakeAuth() as never,
      tenantId: 'tenant-b', onLoggedIn: () => {},
    });
    const mark = root().querySelector('.login-brandmark');
    assert.equal(mark?.textContent, 'ন');   // নর্থ সিটি…
    assert.equal(root().querySelector('.login-brandlogo'), null);
  });

  test('two tenants on one device produce two different login screens', () => {
    cacheBranding('tenant-a', SCHOOL_A);
    cacheBranding('tenant-b', COLLEGE_B);

    new LoginView({
      root: root(), doc: doc(), auth: fakeAuth() as never,
      tenantId: 'tenant-a', onLoggedIn: () => {},
    });
    const a = root().textContent ?? '';

    root().textContent = '';
    new LoginView({
      root: root(), doc: doc(), auth: fakeAuth() as never,
      tenantId: 'tenant-b', onLoggedIn: () => {},
    });
    const b = root().textContent ?? '';

    assert.match(a, /শাহজালাল/);
    assert.doesNotMatch(a, /নর্থ সিটি/);
    assert.match(b, /নর্থ সিটি/);
    assert.doesNotMatch(b, /শাহজালাল/);
  });

  test('an unbranded tenant still shows no platform name', () => {
    new LoginView({
      root: root(), doc: doc(), auth: fakeAuth() as never,
      tenantId: '', onLoggedIn: () => {},
    });
    const text = root().textContent ?? '';
    assert.doesNotMatch(text, /ShikhonBD/);
    assert.doesNotMatch(text, /শিখন/);
  });
});

describe('application shell', () => {
  const routes: ShellRoute[] = [
    { path: 'home', labelBn: 'হোম', glyph: 'home', mount: (c) => { c.textContent = 'home'; } },
  ];

  test('carries the institution name and logo in the top bar', () => {
    new Shell({
      root: root(), doc: doc(), routes, defaultPath: 'home',
      displayName: 'রহিম স্যার', onLogout: () => {},
      institution: { name: SCHOOL_A.nameBn, logoUrl: PNG_A },
    });
    assert.equal(root().querySelector('.shell-org-name')?.textContent, SCHOOL_A.nameBn);
    assert.equal(root().querySelector('.shell-org-logo')?.getAttribute('src'), PNG_A);
    // The person is still there — the institution leads, it does not replace.
    assert.equal(root().querySelector('.shell-who')?.textContent, 'রহিম স্যার');
  });

  test('two tenants give two different shells', () => {
    new Shell({
      root: root(), doc: doc(), routes, defaultPath: 'home',
      displayName: 'x', onLogout: () => {},
      institution: { name: SCHOOL_A.nameBn },
    });
    const a = root().querySelector('.shell-org-name')?.textContent;

    root().textContent = '';
    new Shell({
      root: root(), doc: doc(), routes, defaultPath: 'home',
      displayName: 'x', onLogout: () => {},
      institution: { name: COLLEGE_B.nameBn },
    });
    const b = root().querySelector('.shell-org-name')?.textContent;

    assert.notEqual(a, b);
    assert.equal(a, SCHOOL_A.nameBn);
    assert.equal(b, COLLEGE_B.nameBn);
  });

  test('omits the block entirely when no institution is known', () => {
    // A shell with an empty name plate would look broken; absent is right.
    new Shell({
      root: root(), doc: doc(), routes, defaultPath: 'home',
      displayName: 'x', onLogout: () => {},
    });
    assert.equal(root().querySelector('.shell-org'), null);
  });
});
