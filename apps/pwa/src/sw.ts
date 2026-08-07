/**
 * Service worker glue.
 *
 * All policy lives in sw-router.ts (pure, unit-tested). This file is only the
 * event wiring, which cannot be meaningfully tested outside a browser.
 *
 * The Background Sync handler is what makes "save attendance with no signal"
 * actually deliver: the OS fires `sync` when connectivity returns, even if
 * the tab was closed hours earlier.
 */
/// <reference lib="webworker" />
import {
  route, stalecaches, PRECACHE, CACHE_SHELL, type RouteDecision,
} from './sw-router.ts';

declare const self: ServiceWorkerGlobalScope;

const OFFLINE_URL = '/offline';

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_SHELL)
      // Per-entry, not addAll: one missing asset must degrade that one
      // asset, never veto the whole install — an uninstalled SW means no
      // offline support at all, which is far worse than one cache miss.
      .then((c) =>
        Promise.allSettled(
          [...PRECACHE].map((url) =>
            c.add(url).catch((err) => {
              console.warn(`[sw] precache skipped ${url}:`, err);
            }),
          ),
        ),
      )
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(stalecaches(keys).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const decision = route({ url: req.url, method: req.method, mode: req.mode });
  if (decision.strategy === 'network-only') return;   // let it go straight through
  event.respondWith(handle(req, decision));
});

async function handle(req: Request, d: RouteDecision): Promise<Response> {
  const cache = d.cache ? await caches.open(d.cache) : null;

  switch (d.strategy) {
    case 'cache-first':
    case 'cache-first-ttl': {
      const hit = await cache!.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok) cache!.put(req, res.clone());
      return res;
    }

    case 'stale-while-revalidate': {
      const hit = await cache!.match(req);
      const network = fetch(req)
        .then((res) => { if (res.ok) cache!.put(req, res.clone()); return res; })
        .catch(() => hit ?? Response.error());
      return hit ?? network;
    }

    case 'app-shell': {
      try {
        return await fetch(req);
      } catch {
        // No network: serve the shell so the app boots and hydrates from
        // IndexedDB. This is the difference between "works offline" and
        // "shows the browser's dinosaur".
        return (await cache!.match('/')) ?? (await cache!.match(OFFLINE_URL)) ?? Response.error();
      }
    }

    default:
      return fetch(req);
  }
}

/**
 * Background Sync. Registered by the app as 'outbox-flush' after every write;
 * the OS fires it when connectivity returns.
 */
self.addEventListener('sync', (event: Event & { tag?: string; waitUntil?(p: Promise<unknown>): void }) => {
  if (event.tag !== 'outbox-flush') return;
  event.waitUntil?.(flushOutbox());
});

/** Periodic Sync, where supported — a safety net if a `sync` event is dropped. */
self.addEventListener('periodicsync', (event: Event & { tag?: string; waitUntil?(p: Promise<unknown>): void }) => {
  if (event.tag !== 'outbox-flush') return;
  event.waitUntil?.(flushOutbox());
});

/**
 * The worker cannot import the SyncEngine directly (it would duplicate the
 * IndexedDB connection), so it asks any live client to flush. With no client
 * open it falls back to posting to a client-less flush endpoint on wake.
 */
async function flushOutbox(): Promise<void> {
  const clients = await self.clients.matchAll({ includeUncontrolled: true, type: 'window' });
  if (clients.length > 0) {
    for (const c of clients) c.postMessage({ type: 'outbox-flush' });
    return;
  }
  // No window open: wake one so the engine can run.
  await self.clients.openWindow?.('/?flush=1').catch(() => undefined);
}

export {};
