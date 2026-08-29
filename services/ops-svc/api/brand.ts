/**
 * GET /api/v1/ops/brand?slug=<slug>|?tid=<tenant-id> — pre-auth identity
 *
 * R-1 of docs/11-MASTER-PLAN.md. The login screen has to show the school's
 * name and logo BEFORE anyone has signed in — that is the whole point of
 * white-labelling — and a request with no session has no tenant context, so
 * the tenant_self RLS policy correctly matches nothing.
 *
 * This is the one deliberate way around that, and it is narrow on purpose:
 *
 *   - It answers by exact key and never without one. There is no list
 *     endpoint and no wildcard, so it cannot enumerate tenants; a caller
 *     must already know which school they are looking for, which is the
 *     same thing the install link tells the device.
 *   - It returns SEVEN fields, fixed in SQL by an explicit key allowlist in
 *     app.public_branding() (migration 039). Address, phone, email,
 *     headmaster, watermark and signature are absent by construction, not
 *     by this file remembering to strip them.
 *   - Everything it does return is on the institution's signboard.
 *
 * Unauthenticated means rate-limited: the dispatcher puts the read bucket
 * in front of it, because an endpoint anyone can call is an endpoint
 * anyone can call in a loop.
 *
 * An unknown key returns the neutral default branding with 200, not 404. A
 * 404 here would turn this into a tenant-existence oracle for anyone with a
 * wordlist, and the login screen's behaviour should not differ between
 * "wrong key" and "school not configured yet" anyway.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { corsHeaders, json } from '../../../packages/server-core/src/http.ts';
import { publicBranding, DEFAULT_BRANDING } from '../../../packages/ui-core/src/branding.ts';
import { tenantKey, resolvePublicTenant } from '../src/public-branding.ts';

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const cors = corsHeaders();
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }
  if (req.method !== 'GET') { json(res, 405, { error: 'method_not_allowed' }, cors); return; }

  const resolved = await resolvePublicTenant(tenantKey(req));

  json(res, 200, resolved
    ? {
        tenantId: resolved.tenantId,
        slug: resolved.slug,
        branding: publicBranding(resolved.branding),
      }
    : {
        // Neutral fallback — see the header on why this is not a 404.
        tenantId: null,
        slug: '',
        branding: publicBranding(DEFAULT_BRANDING),
      }, cors);
}
