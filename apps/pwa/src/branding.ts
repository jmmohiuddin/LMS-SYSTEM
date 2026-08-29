/**
 * Applying a tenant's identity to the running app.
 *
 * R-1 of docs/11-MASTER-PLAN.md. The rules live in
 * packages/ui-core/src/branding.ts; this is the thin browser layer that
 * fetches them, caches them, and writes them onto the document.
 *
 * ── Why branding is cached in localStorage ──────────────────────────────
 * The login screen is the FIRST thing a teacher sees, often on a 2G link
 * and sometimes with no link at all. Waiting on a network round-trip
 * before painting a school's name would put a blank or platform-branded
 * screen in front of them for as long as the network takes — which on the
 * reference device of docs/04 is exactly the moment the app feels broken.
 *
 * So: apply the cached branding synchronously, then revalidate in the
 * background and repaint if it changed. The same stale-while-revalidate
 * shape the service worker uses for reference data, done in the app
 * because it has to survive a cold start with no service worker yet.
 *
 * The cache is keyed by tenant. A device that signs into School A and
 * later School B must never paint B's login screen with A's logo, and a
 * single shared key would do exactly that.
 */
import {
  type Branding,
  type PublicBranding,
  DEFAULT_BRANDING,
  brandName,
  brandingCssVars,
  parseBranding,
} from '../../../packages/ui-core/src/branding.ts';

export type { Branding, PublicBranding };
export { DEFAULT_BRANDING, brandName };

const CACHE_PREFIX = 'shikhon_branding_';
/** The <style> element holding the tenant's colour overrides. */
const STYLE_ID = 'tenant-branding';

function cacheKey(tenantKey: string): string {
  return `${CACHE_PREFIX}${tenantKey || 'unknown'}`;
}

/** Read a tenant's last-known branding. Never throws; absent = defaults. */
export function cachedBranding(tenantKey: string): Branding {
  try {
    const raw = localStorage.getItem(cacheKey(tenantKey));
    if (!raw) return DEFAULT_BRANDING;
    // Re-validated rather than trusted: localStorage is writable by
    // anything else running on this origin, and these values reach a
    // stylesheet and an <img src>.
    return parseBranding(JSON.parse(raw), DEFAULT_BRANDING);
  } catch {
    return DEFAULT_BRANDING;
  }
}

export function cacheBranding(tenantKey: string, branding: Partial<Branding>): void {
  try {
    // Merge over what is already cached so the public seven-field payload
    // from /ops/brand never erases the full branding a signed-in session
    // fetched from /ops/branding.
    const merged = parseBranding(branding, cachedBranding(tenantKey));
    localStorage.setItem(cacheKey(tenantKey), JSON.stringify(merged));
  } catch {
    /* quota or private mode — branding is a nicety, never block on it */
  }
}

/** Drop every cached branding. Used on logout so a shared device is clean. */
export function clearBrandingCache(): void {
  try {
    for (const k of Object.keys(localStorage)) {
      if (k.startsWith(CACHE_PREFIX)) localStorage.removeItem(k);
    }
  } catch {
    /* ignore */
  }
}

/**
 * Write the tenant's identity onto the document: colour tokens, page
 * title, favicon, theme colour, and the manifest link.
 *
 * Colours go into a <style> element rather than inline styles on <html>
 * so they cascade like the design system's own tokens do — including into
 * the dark-mode block, which redefines a subset of the same custom
 * properties and must still win where it applies.
 */
export function applyBranding(
  doc: Document,
  branding: Branding,
  opts: { tenantKey?: string; locale?: string } = {},
): void {
  const locale = opts.locale ?? 'bn';
  const name = brandName(branding, locale);

  // ── Colours ──────────────────────────────────────────────────────────
  // Two blocks. The dark selector must repeat app.css's own
  // `:root[data-theme='dark']` specificity, or the design system's default
  // dark steps would win over the tenant's — this <style> sits after
  // app.css in the head, so at equal specificity the tenant's block wins.
  const vars = brandingCssVars(branding);
  const decls = (m: Record<string, string>): string =>
    Object.entries(m).map(([k, v]) => `${k}:${v}`).join(';');
  const css =
    `:root{${decls(vars.light)}}`
    + `:root[data-theme='dark']{${decls(vars.dark)}}`;
  let style = doc.getElementById(STYLE_ID) as HTMLStyleElement | null;
  if (!style) {
    style = doc.createElement('style');
    style.id = STYLE_ID;
    doc.head?.appendChild(style);
  }
  style.textContent = css;

  // ── Title ────────────────────────────────────────────────────────────
  if (name) doc.title = name;

  // ── Theme colour (address bar, splash screen) ────────────────────────
  let themeMeta = doc.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (!themeMeta) {
    themeMeta = doc.createElement('meta');
    themeMeta.name = 'theme-color';
    doc.head?.appendChild(themeMeta);
  }
  themeMeta.content = branding.primaryColor;

  // ── Favicon ──────────────────────────────────────────────────────────
  const icon = branding.faviconUrl || branding.logoUrl;
  if (icon) {
    let link = doc.querySelector<HTMLLinkElement>('link[rel="icon"]');
    if (!link) {
      link = doc.createElement('link');
      link.rel = 'icon';
      doc.head?.appendChild(link);
    }
    link.href = icon;
  }

  // ── Manifest ─────────────────────────────────────────────────────────
  // Repointing this is what makes an install carry the school's identity
  // rather than the platform's. Chrome re-reads the manifest when the
  // install prompt is raised, so a link swapped after load still governs
  // what gets installed.
  const key = opts.tenantKey ?? '';
  if (key) {
    let manifest = doc.querySelector<HTMLLinkElement>('link[rel="manifest"]');
    if (!manifest) {
      manifest = doc.createElement('link');
      manifest.rel = 'manifest';
      doc.head?.appendChild(manifest);
    }
    manifest.href = `/api/v1/ops/manifest?tid=${encodeURIComponent(key)}`;
  }
}

/**
 * Fetch the signed-out identity for a tenant: name, short name, logo,
 * favicon, colours. Used by the login screen, which by definition has no
 * session to authenticate with.
 */
export async function fetchPublicBranding(
  tenantKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Branding> {
  const base = cachedBranding(tenantKey);
  if (!tenantKey) return base;
  try {
    const res = await fetchImpl(
      `/api/v1/ops/brand?tid=${encodeURIComponent(tenantKey)}`,
      { headers: { accept: 'application/json' } },
    );
    if (!res.ok) return base;
    const body = (await res.json()) as { branding?: unknown };
    const merged = parseBranding(body.branding, base);
    cacheBranding(tenantKey, merged);
    return merged;
  } catch {
    // Offline, or the endpoint is unreachable. The cached identity is
    // exactly what this fallback is for.
    return base;
  }
}

/**
 * Fetch the FULL branding for a signed-in session — the seven public
 * fields plus address, contact, watermark, headmaster and signature, which
 * only the letterhead needs and only members of the institution may read.
 */
export async function fetchFullBranding(
  authedFetch: (path: string, init?: RequestInit) => Promise<Response>,
  tenantKey: string,
): Promise<Branding> {
  const base = cachedBranding(tenantKey);
  try {
    const res = await authedFetch('/api/v1/ops/branding');
    if (!res.ok) return base;
    const body = (await res.json()) as { branding?: unknown };
    const merged = parseBranding(body.branding, base);
    cacheBranding(tenantKey, merged);
    return merged;
  } catch {
    return base;
  }
}

/**
 * Paint the cached identity now, refresh it from the network after.
 *
 * Returns the branding that was applied synchronously; the async refresh
 * repaints in place if the server disagrees. Callers that need the fresh
 * value await the returned promise's `refreshed`.
 */
export function applyCachedThenRefresh(
  doc: Document,
  tenantKey: string,
  refresh: () => Promise<Branding>,
  locale = 'bn',
): { applied: Branding; refreshed: Promise<Branding> } {
  const applied = cachedBranding(tenantKey);
  applyBranding(doc, applied, { tenantKey, locale });
  const refreshed = refresh().then((next) => {
    applyBranding(doc, next, { tenantKey, locale });
    return next;
  }).catch(() => applied);
  return { applied, refreshed };
}
