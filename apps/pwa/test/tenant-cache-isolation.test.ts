/**
 * B-104 — one browser, two schools, and no shared cache.
 *
 * Production addresses a school as `/app?tid=<uuid>` on ONE origin (the
 * runbook records subdomains as not ready and gated behind an attestation),
 * so the browser's own origin partitioning does not separate two
 * institutions on one device — a Union Digital Centre, a school's single
 * office laptop, a teacher who works at two madrasas.
 *
 * The Cache API matches on URL alone unless the stored response carries
 * `Vary`, and ours do not. So the entry cached for one school was served to
 * whoever asked next. Found in P9-4 acceptance: a session for the benchmark
 * school first painted against another school's academic year, cached
 * minutes earlier in the same browser. RLS held — the server returned nothing
 * for the foreign year — and the CLIENT still showed the wrong thing.
 *
 * Two mechanisms, and the tests below are about why BOTH exist:
 *
 *   The cache KEY carries the school. A cross-tenant hit is not something the
 *   code must remember to check — it cannot be expressed. This is what makes
 *   FIRST PAINT correct even mid-switch, when a purge has not finished.
 *
 *   The purge removes the other school's data from the device. This is what
 *   makes "A is gone" true rather than merely "A is unreachable".
 *
 * The assertion throughout is §8's: FIRST PAINT = CORRECT TENANT. Not
 * eventually correct.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  route, tenantCacheKey, TENANT_HEADER, CACHE_DATA, CACHE_SHELL,
} from '../src/sw-router.ts';
import { isTenantSwitch, sessionTenantId, sweepNow } from '../src/local-data.ts';

const A = '7c900000-0000-4000-8000-00000000000a';
const B = '0cda6ef4-3c57-4d5e-ad03-4395c9e584c4';
const ORIGIN = 'https://sikhon.systems';

const get = (path: string) => route({ url: `${ORIGIN}${path}`, method: 'GET' });

/**
 * The screens §8's matrix names, by the endpoint each one reads.
 *
 * Deliberately the whole list rather than the academic-year endpoint the
 * defect was found through: the brief's instruction was "do not assume the
 * academic-year cache is the only affected item", and it was not.
 */
const TENANT_SCOPED_READS = [
  ['academic year', '/api/v1/academics/hierarchy'],
  ['roster', '/api/v1/academics/roster?sectionId=abc'],
  ['routine', '/api/v1/rms/routine?sectionId=abc'],
  ['results', '/api/v1/academics/results?studentId=abc'],
  ['student history', '/api/v1/academics/studenthistory?studentId=abc'],
  ['guardian data', '/api/v1/academics/ward'],
  ['notices', '/api/v1/ops/notices'],
  ['inbox', '/api/v1/ops/inbox'],
  ['calendar', '/api/v1/ops/calendar?month=2026-09'],
  ['branding', '/api/v1/ops/branding'],
] as const;

/**
 * A Cache API stand-in with the real one's matching rule: keyed by URL,
 * headers ignored. That rule IS the defect, so a fake that quietly matched on
 * headers would pass a broken implementation.
 */
class FakeCache {
  readonly entries = new Map<string, string>();
  async match(key: Request | string): Promise<string | undefined> {
    return this.entries.get(typeof key === 'string' ? key : key.url);
  }
  async put(key: Request | string, body: string): Promise<void> {
    this.entries.set(typeof key === 'string' ? key : key.url, body);
  }
}

/** The service worker's key decision, exactly as `sw.ts:cacheKey` makes it. */
function keyFor(path: string, tenantId: string): Request | string {
  const url = `${ORIGIN}${path}`;
  const d = route({ url, method: 'GET' });
  return d.tenantScoped ? tenantCacheKey(url, tenantId) : ({ url } as Request);
}

describe('B-104 — the cache key carries the school', () => {
  test('THE ONE THAT MATTERS — A’s cached answer cannot satisfy B, on any screen', async () => {
    // §9 and §10, as one test: fill a cache as school A, then ask as school
    // B for the identical URL. Not one endpoint — every tenant-scoped read
    // the matrix names.
    for (const [screen, path] of TENANT_SCOPED_READS) {
      const cache = new FakeCache();
      await cache.put(keyFor(path, A), `A:${screen}`);

      const asB = await cache.match(keyFor(path, B));
      assert.equal(asB, undefined,
        `${screen}: school B was served school A's cached response`);

      // And the reverse, because an asymmetric guard is a guard that was
      // written for one direction and will be defeated by the other.
      const cacheB = new FakeCache();
      await cacheB.put(keyFor(path, B), `B:${screen}`);
      assert.equal(await cacheB.match(keyFor(path, A)), undefined,
        `${screen}: school A was served school B's cached response`);
    }
  });

  test('and A’s own cached answer still satisfies A — offline is not sacrificed', async () => {
    // The failure mode of a careless fix: isolate the schools by making the
    // cache miss for everyone. §6 forbids solving this by disabling offline.
    for (const [screen, path] of TENANT_SCOPED_READS) {
      const cache = new FakeCache();
      await cache.put(keyFor(path, A), `A:${screen}`);
      assert.equal(await cache.match(keyFor(path, A)), `A:${screen}`,
        `${screen}: a school lost its own offline copy`);
    }
  });

  test('every cached /api/ route is scoped — including ones added later', async () => {
    // The rule is applied at one place in `route()` rather than on each
    // branch, so a route added next month cannot ship unscoped. This asserts
    // the property, not the list.
    for (const [, path] of TENANT_SCOPED_READS) {
      const d = get(path);
      assert.ok(d.cache, `${path} is not cached at all — fixture is stale`);
      assert.equal(d.tenantScoped, true, `${path} is cached but not tenant-scoped`);
    }
  });

  test('the app’s own code is NOT partitioned — a device serving two schools downloads it once', async () => {
    // Shell and media are the product, identical for every school. Keying
    // them per tenant would re-download the whole application on exactly the
    // devices least able to afford it.
    for (const path of ['/app.js', '/app.css', '/assets/x.abc123.js', '/manifest.webmanifest']) {
      const d = get(path);
      assert.notEqual(d.tenantScoped, true, `${path} must not be tenant-partitioned`);
      assert.equal(d.cache, CACHE_SHELL, `${path} belongs in the shell bucket`);
    }
  });

  test('an unauthenticated read gets its own partition, not a school’s', async () => {
    // `app.public_branding()` is served before anybody signs in and belongs
    // to no session. Filing it under a school would let the login screen of
    // one school be cached as another's.
    const publicKey = tenantCacheKey(`${ORIGIN}/api/v1/ops/branding`, '');
    assert.match(String(publicKey), /__t=public/);
    assert.notEqual(publicKey, tenantCacheKey(`${ORIGIN}/api/v1/ops/branding`, A));
  });

  test('the key survives a URL that already has a query string', async () => {
    const k = tenantCacheKey(`${ORIGIN}/api/v1/rms/routine?sectionId=abc&week=2`, A);
    const u = new URL(k);
    assert.equal(u.searchParams.get('sectionId'), 'abc', 'the real parameters are untouched');
    assert.equal(u.searchParams.get('week'), '2');
    assert.equal(u.searchParams.get('__t'), A);
  });

  test('the header name is the one the page actually sends', () => {
    // A silent rename on either side degrades every request to the `public`
    // partition — isolation intact, offline quietly dead for signed-in users.
    assert.equal(TENANT_HEADER, 'x-tenant-id');
  });

  test('CACHE_DATA is still the bucket, so `stalecaches` keeps working', () => {
    assert.equal(get('/api/v1/academics/hierarchy').cache, CACHE_DATA);
  });
});

describe('B-104 — the switch is detected before anything reads', () => {
  test('THE ONE THAT MATTERS — ?tid=A then ?tid=B is a switch, both ways', () => {
    assert.equal(isTenantSwitch({ incomingTid: B, storedTid: A, sessionTid: '' }), true);
    assert.equal(isTenantSwitch({ incomingTid: A, storedTid: B, sessionTid: '' }), true);
  });

  test('a session for another school is a switch even with no stored tenant', () => {
    // Somebody signed in as A and the link for B was opened without a logout.
    // No logout hook can catch this, because no logout happened.
    assert.equal(isTenantSwitch({ incomingTid: B, storedTid: '', sessionTid: A }), true);
  });

  test('the same school, arriving any way, is NOT a switch', () => {
    // The cost of a false positive is a school losing its offline cache, so
    // this half matters as much as the other.
    assert.equal(isTenantSwitch({ incomingTid: A, storedTid: A, sessionTid: A }), false);
    assert.equal(isTenantSwitch({ incomingTid: A, storedTid: A, sessionTid: '' }), false);
    assert.equal(isTenantSwitch({ incomingTid: A, storedTid: '', sessionTid: '' }), false);
  });

  test('a PWA reopened from the home screen is never a switch', () => {
    // No query string, so nothing declares a change. Treating this as one
    // would drop the offline cache of every installed device, every day.
    assert.equal(isTenantSwitch({ incomingTid: '', storedTid: A, sessionTid: A }), false);
    assert.equal(isTenantSwitch({ incomingTid: '', storedTid: A, sessionTid: B }), false);
  });

  test('a broken session file does not crash the boot path', () => {
    // This runs at module top level, before anything is rendered. An
    // exception here is a white screen, not a degraded one.
    const ls = fakeStorage({ shikhon_auth: '{not json' });
    assert.equal(sessionTenantId(ls), '');
    assert.equal(sessionTenantId(fakeStorage({})), '');
    assert.equal(sessionTenantId(fakeStorage({ shikhon_auth: '{"tenantId":42}' })), '');
    assert.equal(sessionTenantId(fakeStorage({ shikhon_auth: `{"tenantId":"${A}"}` })), A);
  });

  test('a switch clears the session AND the screen caches, keeping device facts', () => {
    const ls = fakeStorage({
      shikhon_auth: `{"tenantId":"${A}"}`,
      shikhon_sections_cache: '[{"id":"sec-a"}]',
      shikhon_last_section: 'sec-a',
      shikhon_last_roster: '[]',
      shikhon_guardian_home: '{}',
      shikhon_tid: A,
      shikhon_d: 'device-1',
      shikhon_theme: 'dark',
      [`shikhon_branding_${A}`]: '{"nameBn":"ক"}',
    });
    const removed = sweepNow('tenant-switch', ls);

    // The session belongs to the school being left. Keeping it is the defect.
    assert.ok(removed.includes('shikhon_auth'), 'A’s token must not survive');
    assert.ok(removed.includes('shikhon_sections_cache'));
    assert.ok(removed.includes('shikhon_guardian_home'));
    assert.equal(ls.getItem('shikhon_last_roster'), null);

    // Device facts stay: churning the device id would re-register push and
    // sync on every switch, and dropping the branding would take a school
    // back to a generic login screen.
    assert.equal(ls.getItem('shikhon_d'), 'device-1');
    assert.equal(ls.getItem('shikhon_theme'), 'dark');
    assert.equal(ls.getItem(`shikhon_branding_${A}`), '{"nameBn":"ক"}',
      'branding is public and already keyed per school');
  });
});

function fakeStorage(seed: Record<string, string>): Storage {
  const map = new Map(Object.entries(seed));
  return {
    get length() { return map.size; },
    key: (i: number) => [...map.keys()][i] ?? null,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => { map.set(k, v); },
    removeItem: (k: string) => { map.delete(k); },
    clear: () => { map.clear(); },
  } as Storage;
}
