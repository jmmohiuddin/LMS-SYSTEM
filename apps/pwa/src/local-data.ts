/**
 * What this origin keeps, in four tiers, and what may clear each.  (B-8)
 *
 * The shared device is the whole problem. A staff-room phone, a family tablet,
 * a school's one laptop in the office: the next person to sign in is not the
 * last one. Before this module the app had no opinion about that — a logout
 * dropped the session token and left every screen's cached answer sitting in
 * `localStorage`, so the next person's first paint could be the previous
 * person's roster, under an "offline" banner, before any network call.
 *
 * P4 found this the hard way through the demo's role picker, fixed it there,
 * and deliberately did not touch `doLogout` — because the outbox lives beside
 * those caches and deciding what happens to a teacher's unsent attendance is
 * not something to settle inside a UI phase. This is that decision.
 *
 * ── The four tiers ─────────────────────────────────────────────────────────
 *
 *   1. SESSION      who is signed in. `shikhon_auth`, and the OTP hand-off.
 *                   Cleared on logout — it IS the logout.
 *   2. SCREEN CACHE the read-through copy of a server answer, written so a
 *                   cold start has something to draw. ~20 keys plus the
 *                   service worker's Cache API entries. Cleared on logout:
 *                   this is the tier that leaks.
 *   3. OUTBOX       IndexedDB `shikhon` — attendance and marks authored
 *                   offline and not yet acknowledged. **NEVER cleared, by
 *                   anything, ever.** Losing it is unrecoverable: the register
 *                   exists nowhere else. It is protected instead by the
 *                   engine's owner filter, so a later session cannot post
 *                   somebody else's work under its own token.
 *   4. DEVICE       facts about this hardware, not about a person: the device
 *                   id, which school's door this is, that school's public
 *                   branding, and three display preferences. Kept — clearing
 *                   them would mint a new device id on every logout (churning
 *                   the push and sync registrations keyed to it) and drop a
 *                   school back to the generic login screen, which D12 exists
 *                   to prevent.
 *
 * ── Why a keep-list and not a delete-list ──────────────────────────────────
 * Tier 2 is one key per screen and there are about twenty of them. A
 * delete-list is a list somebody forgets to extend, and the cost of forgetting
 * is a privacy leak that looks like a cache hit. So everything under
 * `shikhon_` is cleared unless it is named here, and a screen that starts
 * caching something next month is covered on the day it ships.
 *
 * ── Two entry points, because of a race a browser found ────────────────────
 * `purgeLocalData()` does the whole job and is async, because the Cache API
 * is. `sweepNow()` is the synchronous localStorage half, for callers to run in
 * the same block as the reload or the login screen — no await in between, so
 * no in-flight screen can resolve and re-cache itself into a store that was
 * just emptied. That is not hypothetical: it is what happened to the fee
 * screen the first time this was tried.
 */

/** Tier 1. Cleared on logout; kept across a demo role switch, which is not one. */
export const SESSION_KEYS = ['shikhon_auth', 'shikhon_otp_login'] as const;

/**
 * Tier 4 — device-durable. Everything else under `shikhon_` is tier 2.
 *
 * `shikhon_branding_*` is matched by prefix rather than listed: it is one key
 * per tenant, it is public data (`app.public_branding()` serves it
 * unauthenticated), and it is what makes a school's own login screen appear
 * before anybody signs in.
 */
export const DEVICE_KEYS = [
  'shikhon_d',                 // deviceId('d') — the DEVICE, not the person
  'shikhon_tid',               // which school's door this device is
  'shikhon_theme',
  'shikhon_sidebar_rail',
  'shikhon_reader_textsize',
] as const;

const BRANDING_PREFIX = 'shikhon_branding_';

/** The demo's own selectors. Meaningless outside `/demo`, harmless inside it. */
export const DEMO_KEYS = ['shikhon_demo_role', 'shikhon_demo_tenant'] as const;

export type PurgeReason = 'logout' | 'role-switch';

/**
 * Which `shikhon_` keys survive a given transition.
 *
 * A demo role switch is not a logout: nobody signed out, and the demo has no
 * session to end, so tier 1 stays. A real logout ends the session, so it does
 * not.
 */
function keepFor(reason: PurgeReason): Set<string> {
  const keep = new Set<string>([...DEVICE_KEYS, ...DEMO_KEYS]);
  if (reason === 'role-switch') for (const k of SESSION_KEYS) keep.add(k);
  return keep;
}

export interface PurgeResult {
  /** Keys actually removed. Returned so a test can assert on the decision. */
  removed: string[];
  /** Cache API entries deleted. */
  caches: number;
  /** Always false. Present so the claim is visible at every call site. */
  outboxTouched: boolean;
}

/**
 * Clear tiers 1 and 2 (or just 2, for a role switch). Never touches tier 3.
 *
 * Every step is individually guarded: private mode, a browser with storage
 * disabled, and a missing Cache API all throw, and none of them may stop a
 * logout from completing. A logout that fails halfway because
 * `localStorage` threw is a logout that did not happen.
 */
export function sweepNow(
  reason: PurgeReason,
  storage?: Storage,
): string[] {
  const ls = storage ?? (globalThis as { localStorage?: Storage }).localStorage;
  const keep = keepFor(reason);
  const removed: string[] = [];
  try {
    if (!ls) return removed;
    const drop: string[] = [];
    for (let i = 0; i < ls.length; i++) {
      const k = ls.key(i);
      if (!k || !k.startsWith('shikhon_')) continue;
      if (keep.has(k) || k.startsWith(BRANDING_PREFIX)) continue;
      drop.push(k);
    }
    for (const k of drop) { ls.removeItem(k); removed.push(k); }
  } catch { /* storage unavailable — the sign-out still has to finish */ }
  return removed;
}

export async function purgeLocalData(
  reason: PurgeReason,
  win: { localStorage?: Storage; caches?: CacheStorage } = globalThis as never,
): Promise<PurgeResult> {
  // Caches FIRST, storage LAST, and the order is the whole point.
  //
  // The first version swept storage first and then awaited the Cache API. That
  // await gives a resolved `authedFetch` a turn, and a screen's entire job on
  // resolving is to write what it received into its cache — so the last screen
  // the previous user had open quietly re-cached itself into an already-swept
  // store. Found by driving guardian → student in a browser: `guardian_home`
  // was gone and `invoices_cache`, whose screen was still mounted, was not.
  //
  // Sweeping last shrinks the window to the microtask between this resolving
  // and the caller's next statement. `sweepNow()` closes even that: callers
  // run it synchronously beside the reload, where nothing can interleave.
  let cacheCount = 0;
  try {
    const c = win.caches;
    if (c) {
      const keys = await c.keys();
      await Promise.all(keys.map((k) => c.delete(k)));
      cacheCount = keys.length;
    }
  } catch { /* no Cache API in this context */ }

  const removed = sweepNow(reason, win.localStorage);

  // Tier 3 is not referenced above, and this is the assertion that it is not.
  // `indexedDB.deleteDatabase('shikhon')` must never appear in this file; the
  // test suite greps for it.
  return { removed, caches: cacheCount, outboxTouched: false };
}
