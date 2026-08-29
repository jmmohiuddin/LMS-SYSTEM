/**
 * R-1-A — three surfaces, three addresses.
 *
 *   /        the shikhonBD marketing site        index.html
 *   /app     the tenant management application   app.html
 *   /design  the Ata Ekta prototype              design.html
 *
 * Before this, "/" served the prototype and the real application was
 * reachable only by typing /index.legacy.html. These tests hold the split:
 * the routing tables of both hosts, the service worker's idea of which
 * navigation is the app, and the promise that a school's installed PWA
 * opens the application rather than a page selling it.
 *
 * The three HTML files are asserted by their CONTENT, not their names — a
 * rename that swapped two surfaces would keep the names plausible and
 * break everything, which is exactly the failure that produced R-1-A.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { route, PRECACHE, CACHE_SHELL, APP_SHELL_URL, isAppPath } from '../src/sw-router.ts';
import { buildManifest } from '../../../services/ops-svc/api/manifest.ts';
import { parseBranding, DEFAULT_BRANDING } from '../../../packages/ui-core/src/branding.ts';

// fileURLToPath, not URL.pathname: this repo's path contains spaces, which
// pathname returns percent-encoded (the same trap scripts/test-all.mjs hit).
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = join(ROOT, 'public');
const read = (f: string): string => readFileSync(join(PUBLIC, f), 'utf8');
const readRepo = (f: string): string => readFileSync(join(ROOT, '..', '..', f), 'utf8');

describe('the three surfaces exist and are not swapped', () => {
  test('/ is the marketing site: platform-branded, no application', () => {
    const html = read('index.html');
    assert.match(html, /ShikhonBD/, 'the marketing site must carry the platform brand (D11)');
    assert.match(html, /মূল্য|pricing|m-pricing/i, 'marketing content expected');
    // It is a page about the product, not the product.
    assert.doesNotMatch(html, /<script[^>]+src="\/app\.js"/, 'marketing must not boot the app');
    assert.doesNotMatch(html, /id="root"/, 'marketing must not carry the app mount point');
  });

  test('/app is the real application: mounts the PWA, no platform brand', () => {
    const html = read('app.html');
    assert.match(html, /<script type="module" src="\/app\.js"><\/script>/);
    assert.match(html, /id="root"/);
    assert.match(html, /serviceWorker\.register\('\/sw\.js'\)/);
    assert.match(html, /rel="manifest"/);
    // D11: a school's application carries the school's identity.
    assert.doesNotMatch(html.replace(/<!--[\s\S]*?-->/g, ''), /ShikhonBD/);
  });

  test('/design is the prototype: many static screens, no API, no app boot', () => {
    const html = read('design.html');
    assert.ok(html.split('class="screen').length > 20, 'the prototype is the many-screens file');
    assert.doesNotMatch(html, /<script[^>]+src="\/app\.js"/);
    assert.doesNotMatch(html, /id="root"/);
    assert.doesNotMatch(html.replace(/<!--[\s\S]*?-->/g, ''), /ShikhonBD/);
  });

  test('the marketing CTAs point at the application, not at themselves', () => {
    const html = read('index.html');
    // Every "try it" button used to open "/" back when "/" was the app.
    assert.ok(html.includes('href="/app"'), 'marketing must link into the application');
    // The brand mark still goes home; nothing points at the retired names.
    assert.doesNotMatch(html, /href="\/landing\.html"/);
    assert.doesNotMatch(html, /index\.legacy\.html/);
  });

  test('no file still refers to the pre-split names', () => {
    for (const f of ['index.html', 'app.html', 'design.html', 'offline.html']) {
      assert.doesNotMatch(read(f), /index\.legacy\.html/, `${f} references a file that no longer exists`);
    }
  });
});

describe('deployment routing maps the three surfaces (both hosts)', () => {
  test('vercel.json rewrites /app and /design, and leaves / alone', () => {
    const cfg = JSON.parse(readRepo('vercel.json')) as {
      rewrites: { source: string; destination: string }[];
    };
    const find = (src: string) => cfg.rewrites.find((r) => r.source === src);

    assert.equal(find('/app')?.destination, '/app.html');
    assert.equal(find('/app/:path*')?.destination, '/app.html');
    assert.equal(find('/design')?.destination, '/design.html');
    // "/" resolves to index.html by the static filesystem — a rewrite for it
    // would be a second, divergent statement of the same fact.
    assert.equal(find('/'), undefined);
    // The auth rewrite is load-bearing and must survive every edit here.
    assert.equal(find('/api/v1/auth/:path*')?.destination, '/api/v1/auth?path=:path*');
  });

  test('netlify.toml routes /app and /design BEFORE the catch-all', () => {
    const toml = readRepo('netlify.toml');
    const at = (needle: string) => toml.indexOf(needle);

    assert.ok(at('from = "/app"') > -1, '/app redirect missing');
    assert.ok(at('from = "/design"') > -1, '/design redirect missing');
    assert.ok(at('from = "/*"') > -1, 'catch-all missing');

    // First match wins on Netlify: a catch-all above /app would swallow it.
    assert.ok(at('from = "/app"') < at('from = "/*"'),
      '/app must be declared before the catch-all or it never matches');
    assert.ok(at('from = "/design"') < at('from = "/*"'),
      '/design must be declared before the catch-all');

    // The catch-all now lands on marketing, which is the whole point of R-1-A.
    const catchAll = toml.slice(at('from = "/*"'), at('from = "/*"') + 120);
    assert.match(catchAll, /to = "\/index\.html"/);
  });
});

describe('service worker knows which navigation is the app', () => {
  const nav = (url: string) => route({ url, method: 'GET', mode: 'navigate' });

  test('app navigations get the offline shell', () => {
    for (const u of ['https://x.test/app', 'https://x.test/app.html', 'https://x.test/app/anything']) {
      assert.equal(nav(u).strategy, 'app-shell', u);
      assert.equal(nav(u).cache, CACHE_SHELL);
    }
  });

  test('THE ONE THAT MATTERS — marketing and prototype are never app-shelled', () => {
    // The worker is registered from /app.html with scope "/", so it SEES
    // these. Answering them with the app's HTML would put the application
    // back where the marketing site belongs.
    for (const u of ['https://x.test/', 'https://x.test/design', 'https://x.test/pricing']) {
      assert.equal(nav(u).strategy, 'network-only', u);
    }
  });

  test('isAppPath is exact — /application must not count as the app', () => {
    assert.equal(isAppPath('/app'), true);
    assert.equal(isAppPath('/app.html'), true);
    assert.equal(isAppPath('/app/x'), true);
    assert.equal(isAppPath('/'), false);
    assert.equal(isAppPath('/design'), false);
    assert.equal(isAppPath('/application'), false);
    assert.equal(isAppPath('/appointments'), false);
  });

  test('the precached shell is the app, not the marketing page', () => {
    assert.ok(PRECACHE.includes(APP_SHELL_URL));
    assert.equal(APP_SHELL_URL, '/app');
    assert.ok(!PRECACHE.includes('/'),
      'precaching "/" would make the offline fallback show a school a sales page');
  });
});

describe('unhashed entry assets stop being cached forever', () => {
  const get = (url: string) => route({ url, method: 'GET' });

  test('app.js and app.css revalidate instead of pinning a device to one build', () => {
    // The bug: both match the IMMUTABLE extension test, so a deploy did not
    // reach a returning device until the cache name changed.
    for (const p of ['/app.js', '/app.css', '/manifest.webmanifest']) {
      const d = get(`https://x.test${p}`);
      assert.equal(d.strategy, 'stale-while-revalidate', p);
      assert.equal(d.cache, CACHE_SHELL, p);
    }
  });

  test('genuinely content-hashed assets stay cache-first', () => {
    const d = get('https://x.test/assets/main.4f2a9c.js');
    assert.equal(d.strategy, 'cache-first');
  });

  test('the shell cache version was bumped, so v1 is purged on activate', () => {
    // stalecaches() deletes every shikhon-* cache not in the keep set, so a
    // returning device drops the cache that held "/" as the app shell.
    assert.notEqual(CACHE_SHELL, 'shikhon-shell-v1');
    assert.match(CACHE_SHELL, /^shikhon-shell-v\d+$/);
  });
});

describe('an installed PWA opens the application', () => {
  const A = parseBranding({
    nameBn: 'শাহজালাল আদর্শ উচ্চ বিদ্যালয়', shortName: 'শাহজালাল', primaryColor: '#156a3f',
  });

  test('start_url and scope are /app, carrying the tenant', () => {
    const m = buildManifest(A, 'tenant-a') as Record<string, string>;
    assert.equal(m.start_url, '/app?tid=tenant-a');
    assert.equal(m.scope, '/app');
    // Not "/" — that would install the marketing site as the school's app.
    assert.notEqual(m.start_url, '/?tid=tenant-a');
  });

  test('with no tenant it still opens the app, never the marketing page', () => {
    const m = buildManifest(DEFAULT_BRANDING, null) as Record<string, string>;
    assert.equal(m.start_url, '/app');
    assert.equal(m.scope, '/app');
  });

  test('the static fallback manifest agrees with the generated one', () => {
    // A device that installs before the API answers uses this file; if the
    // two disagreed, the install would depend on a race.
    const m = JSON.parse(read('manifest.webmanifest')) as Record<string, string>;
    assert.equal(m.start_url, '/app');
    assert.equal(m.scope, '/app');
    assert.doesNotMatch(JSON.stringify(m), /ShikhonBD|শিখন —/);
  });
});
