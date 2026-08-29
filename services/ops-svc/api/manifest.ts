/**
 * GET /api/v1/ops/manifest?slug=<slug>|?tid=<tenant-id> — tenant web manifest
 *
 * R-1 of docs/11-MASTER-PLAN.md: "Installing Tenant A must result in Tenant
 * A's identity, not another institution's."
 *
 * The static /manifest.webmanifest cannot do that — it is one file for
 * every school, so whoever installs the PWA gets whatever name and icon
 * that file happens to carry. This serves the same document per tenant.
 * apps/pwa/src/branding.ts repoints <link rel="manifest"> at this URL once
 * the tenant is known, which is the only mechanism available to a static
 * PWA with no server-side rendering.
 *
 * Public for the same reason /ops/brand is: a browser fetches a manifest
 * outside any session, often before login, and it carries only signboard
 * fields.
 *
 * ── start_url carries the tenant ────────────────────────────────────────
 * An installed icon launches at start_url with no query string of its own,
 * so `?tid=` is what tells a freshly-installed app which school it belongs
 * to on first run. Without it, an install performed before first login
 * would open a tenant-less app.
 *
 * ── Icons ───────────────────────────────────────────────────────────────
 * A tenant favicon is used when set. Otherwise the platform's generic
 * icons are referenced — deliberately, because Chrome refuses to offer
 * installation with no usable icon, and a school with a working install
 * and a plain icon is better off than one with neither.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { corsHeaders } from '../../../packages/server-core/src/http.ts';
import {
  brandName,
  DEFAULT_BRANDING,
  type Branding,
} from '../../../packages/ui-core/src/branding.ts';
import { tenantKey, resolvePublicTenant } from '../src/public-branding.ts';

/** Platform fallback icons — these exist in apps/pwa/public/icons/. */
const DEFAULT_ICONS = [
  { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
  { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
];

function mimeOfDataUrl(url: string): string {
  const m = /^data:(image\/[a-z+]+);/.exec(url);
  return m ? m[1] : 'image/png';
}

/**
 * Pure, so the identity rules are testable without a database or a
 * request: this is the function that decides what a school's installed app
 * is called and what colour its splash screen is.
 */
export function buildManifest(
  branding: Branding,
  tenantId: string | null,
  locale = 'bn',
): Record<string, unknown> {
  const name = brandName(branding, locale);
  const icon = branding.faviconUrl || branding.logoUrl;
  return {
    name,
    short_name: branding.shortName || name,
    start_url: tenantId ? `/?tid=${encodeURIComponent(tenantId)}` : '/',
    scope: '/',
    display: 'standalone',
    background_color: '#FFFFFF',
    theme_color: branding.primaryColor,
    lang: locale === 'en' ? 'en' : 'bn',
    dir: 'ltr',
    icons: icon
      ? [
          // A data URL has no intrinsic size to disagree with, and Chrome
          // needs a >=192px candidate to offer installation at all, so the
          // one asset is declared at both sizes. The platform's maskable
          // icon is kept as the last resort for launcher shapes.
          { src: icon, sizes: '192x192', type: mimeOfDataUrl(icon), purpose: 'any' },
          { src: icon, sizes: '512x512', type: mimeOfDataUrl(icon), purpose: 'any' },
          ...DEFAULT_ICONS.slice(1),
        ]
      : DEFAULT_ICONS,
  };
}

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const cors = corsHeaders();
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }
  if (req.method !== 'GET') {
    res.writeHead(405, { ...cors, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'method_not_allowed' }));
    return;
  }

  const resolved = await resolvePublicTenant(tenantKey(req));
  const body = JSON.stringify(
    resolved
      ? buildManifest(resolved.branding, resolved.tenantId)
      // Neutral manifest — an app that installs with a plain identity beats
      // one the browser refuses to install at all.
      : buildManifest(DEFAULT_BRANDING, null),
  );

  res.writeHead(200, {
    ...cors,
    'Content-Type': 'application/manifest+json; charset=utf-8',
    // Short cache: a school that has just changed its logo should see the
    // install identity follow within minutes, not at the next deploy.
    'Cache-Control': 'public, max-age=300',
  });
  res.end(body);
}
