/**
 * Service-worker routing policy.
 *
 * Split out from the worker glue as pure functions so the policy — which is
 * the part that can be wrong in ways users notice — is unit-testable without
 * a browser.
 *
 * Implements the strategy table in docs/01-ARCHITECTURE.md §2.4.
 */

export type Strategy =
  | 'cache-first'          // content-hashed assets: never revalidate on 2G
  | 'app-shell'            // navigations: render the shell, hydrate from IndexedDB
  | 'network-only'         // authoritative reads/writes: never stale-serve
  | 'stale-while-revalidate' // reference data: instant render, silent refresh
  | 'cache-first-ttl';     // large media: cache-first with an expiry

export interface RouteDecision {
  strategy: Strategy;
  /** Cache bucket name; absent for network-only. */
  cache?: string;
  ttlSeconds?: number;
  reason: string;
}

// v2: R-1-A. Bumped so every returning device drops the v1 shell on activate
// (see stalecaches()). v1 cached "/" as the app shell — which is now the
// marketing site — and had cached an unhashed app.js under a cache-first
// policy that never revalidated. Both are wrong to keep.
export const CACHE_SHELL = 'shikhon-shell-v2';
export const CACHE_MEDIA = 'shikhon-media-v1';
export const CACHE_DATA = 'shikhon-data-v1';

/**
 * Where the tenant application lives (R-1-A, master plan §1a).
 *
 * "/" is the shikhonBD marketing site and "/design" is the prototype; only
 * this path is the application. It is the app-shell fallback, the precache
 * entry, and what the worker opens when it wakes with no window.
 */
export const APP_SHELL_URL = '/app';

/** Does this path belong to the tenant application? */
export function isAppPath(path: string): boolean {
  return path === '/app' || path.startsWith('/app/') || path === '/app.html';
}

const IMMUTABLE = /\/_next\/static\/|\/assets\/|\.(?:woff2|css|js|svg|png|webp|ico)$/;

/**
 * Entry assets that are NOT content-hashed, so their URL cannot tell us
 * whether the bytes changed.
 *
 * They used to match IMMUTABLE (both end in .js/.css) and were therefore
 * cached first and never revalidated — a deploy did not reach a returning
 * device until the cache name changed, which is not something a normal
 * release does. Local verification of R-1 was misled by this twice.
 *
 * Stale-while-revalidate is the correct trade for them: the cached copy is
 * served instantly (offline still works, first paint is unchanged) and the
 * network copy replaces it in the background, so the NEXT load is current.
 */
const UNHASHED_ENTRY_ASSETS = new Set(['/app.js', '/app.css', '/manifest.webmanifest']);

export function route(request: { url: string; method: string; mode?: string }): RouteDecision {
  const url = new URL(request.url);
  const path = url.pathname;

  // Writes never touch a cache. The outbox owns durability, not the SW.
  if (request.method !== 'GET') {
    return { strategy: 'network-only', reason: 'mutation — the outbox owns durability' };
  }

  // Navigations.
  //
  // The worker is registered from /app.html with the default scope "/", so it
  // sees navigations to the marketing site and the prototype too. Only the
  // application gets the offline app-shell treatment: answering a request for
  // "/" with the app's HTML would put the application where the marketing
  // site belongs, which is the exact confusion R-1-A exists to end.
  if (request.mode === 'navigate') {
    if (isAppPath(path)) {
      return { strategy: 'app-shell', cache: CACHE_SHELL, reason: 'app navigation' };
    }
    return { strategy: 'network-only', reason: 'not the app — marketing and prototype are ordinary pages' };
  }

  // Authoritative data must never be stale-served.
  if (path.startsWith('/api/v1/sync/')) {
    return { strategy: 'network-only', reason: 'sync is authoritative' };
  }
  if (path.startsWith('/api/v1/ai/')) {
    return { strategy: 'network-only', reason: 'never fabricate a tutor response from cache' };
  }
  if (path.startsWith('/api/v1/finance/') || path.startsWith('/api/v1/webhooks/')) {
    return { strategy: 'network-only', reason: 'money is never served from cache' };
  }

  // R-1. The institution's identity is the most cacheable thing in the
  // product — it changes when a school rebrands, which is roughly never —
  // and it is needed at the very first paint, before login, on whatever
  // connection the device has. Stale-while-revalidate is what lets a
  // teacher open the app on a dead link and still see their own school.
  if (path.startsWith('/api/v1/ops/brand')
    || path.startsWith('/api/v1/ops/branding')
    || path.startsWith('/api/v1/ops/manifest')) {
    return {
      strategy: 'stale-while-revalidate',
      cache: CACHE_DATA,
      reason: 'tenant identity — must render before the network answers',
    };
  }

  // Reference reads: render instantly from cache, refresh in the background.
  if (path.startsWith('/api/v1/rms/') || path.startsWith('/api/v1/academics/')) {
    return {
      strategy: 'stale-while-revalidate',
      cache: CACHE_DATA,
      reason: 'reference data — instant render beats freshness here',
    };
  }

  // Answer scripts and photos: large, rarely re-read.
  if (path.startsWith('/media/') || path.startsWith('/scripts/')) {
    return {
      strategy: 'cache-first-ttl',
      cache: CACHE_MEDIA,
      ttlSeconds: 7 * 24 * 3600,
      reason: 'large media, rarely re-read',
    };
  }

  // The entry bundles carry no hash, so cache-first would pin a device to
  // whatever it downloaded first. Checked BEFORE the IMMUTABLE test, which
  // they would otherwise match on their extension alone.
  if (UNHASHED_ENTRY_ASSETS.has(path)) {
    return {
      strategy: 'stale-while-revalidate',
      cache: CACHE_SHELL,
      reason: 'entry asset, not content-hashed — instant from cache, current on the next load',
    };
  }

  // Content-hashed assets are immutable by construction.
  if (IMMUTABLE.test(path)) {
    return { strategy: 'cache-first', cache: CACHE_SHELL, reason: 'content-hashed, immutable' };
  }

  return { strategy: 'network-only', reason: 'unclassified' };
}

/**
 * Assets precached at install. Kept deliberately small — this is what
 * determines time-to-first-paint on a cold 2G start, and the JS budget is
 * 180 KB gzipped on the critical path.
 */
// Every entry here MUST exist in apps/pwa/public/ — a 404 during install
// used to fail cache.addAll and silently leave the app with no service
// worker at all (the font/sprite files this once listed were never built).
// Bangla text renders from the device's system Noto Sans Bengali instead.
export const PRECACHE: readonly string[] = [
  // The APPLICATION, not "/" — "/" is the marketing site since R-1-A, and
  // precaching it would make the offline fallback show a school a sales page.
  APP_SHELL_URL,
  '/offline',
  '/app.css',
  '/app.js',
  '/icons/icon.svg',
  '/manifest.webmanifest',
];

/** Caches from older deploys, to be deleted on activate. */
export function stalecaches(existing: string[]): string[] {
  const keep = new Set([CACHE_SHELL, CACHE_MEDIA, CACHE_DATA]);
  return existing.filter((n) => n.startsWith('shikhon-') && !keep.has(n));
}

/**
 * Data-saver policy (docs/04-UIUX-ACCESSIBILITY.md §6). On a metered or very
 * slow link the app stops fetching avatars, lowers image quality and lengthens
 * the sync interval rather than silently burning a prepaid data balance.
 */
export interface ConnectionLike {
  saveData?: boolean;
  effectiveType?: string;
}

export interface DataSaverPolicy {
  lite: boolean;
  loadAvatars: boolean;
  imageQuality: number;
  syncIntervalMs: number;
  autoCropWasm: boolean;
}

export function dataSaverPolicy(
  conn: ConnectionLike | undefined,
  deviceMemoryGb = 4,
): DataSaverPolicy {
  const slow = conn?.effectiveType === 'slow-2g' || conn?.effectiveType === '2g';
  const lite = Boolean(conn?.saveData) || slow;
  return {
    lite,
    loadAvatars: !lite,
    imageQuality: lite ? 0.45 : 0.55,
    syncIntervalMs: lite ? 5 * 60_000 : 30_000,
    // The WASM auto-cropper is skipped on low-memory devices regardless of link.
    autoCropWasm: !lite && deviceMemoryGb > 2,
  };
}
