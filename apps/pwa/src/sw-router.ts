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

export const CACHE_SHELL = 'shikhon-shell-v1';
export const CACHE_MEDIA = 'shikhon-media-v1';
export const CACHE_DATA = 'shikhon-data-v1';

const IMMUTABLE = /\/_next\/static\/|\/assets\/|\.(?:woff2|css|js|svg|png|webp|ico)$/;

export function route(request: { url: string; method: string; mode?: string }): RouteDecision {
  const url = new URL(request.url);
  const path = url.pathname;

  // Writes never touch a cache. The outbox owns durability, not the SW.
  if (request.method !== 'GET') {
    return { strategy: 'network-only', reason: 'mutation — the outbox owns durability' };
  }

  // Navigations render the app shell; the page hydrates from IndexedDB, so a
  // cold start with no network still shows a working screen.
  if (request.mode === 'navigate') {
    return { strategy: 'app-shell', cache: CACHE_SHELL, reason: 'navigation' };
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
  '/',
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
