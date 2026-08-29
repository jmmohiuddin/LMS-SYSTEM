/**
 * GET  /api/v1/ops/branding — the calling tenant's full branding
 * PUT  /api/v1/ops/branding — replace it (IT admin / principal only)
 *
 * R-1 of docs/11-MASTER-PLAN.md.
 *
 * ── What actually enforces isolation ────────────────────────────────────
 * Not this file. Branding lives in tenants.settings, and 010's tenant_self
 * policy is `id = app.current_tenant()`, FORCE'd. Every statement below
 * runs inside db.withTenant(), which SET LOCALs app.tenant_id from the
 * verified JWT claim. So:
 *
 *   - the SELECT can only ever match the caller's own tenant row;
 *   - the UPDATE's WHERE clause is irrelevant to safety, because the
 *     policy's USING clause has already narrowed the table to one row;
 *   - a bug here that passed the wrong id would return zero rows, not
 *     another school's branding.
 *
 * There is deliberately no tenant id in the URL or the body. An endpoint
 * that accepts one invites the exact confused-deputy bug this design
 * removes: the only tenant a caller can name is the one they authenticated
 * as. requireRole() below is a clean 403 in front of the policy, not the
 * boundary.
 *
 * ── Why PUT merges rather than replaces ─────────────────────────────────
 * parseBranding(body, current) falls back to the SAVED value for every
 * field the request omits. The editor sends the whole object today, but a
 * future caller sending only { primaryColor } must not blank the school's
 * address, logo and headmaster as a side effect.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { sharedDb } from '../../../packages/server-core/src/db.ts';
import { corsHeaders, readJson, json, HttpError } from '../../../packages/server-core/src/http.ts';
import { authenticate, requireRole } from '../../../packages/server-core/src/auth.ts';
import {
  parseBranding,
  DEFAULT_BRANDING,
  BrandingError,
  type Branding,
} from '../../../packages/ui-core/src/branding.ts';

/**
 * Who may repaint a school.
 *
 * Branding is what every parent, student and teacher sees on every screen
 * and every receipt — it is an institutional identity decision, not a
 * preference. The same three roles that own the school's other structural
 * settings own this one. Mirrors the allowlists in academics-svc's import
 * and subject-choice endpoints.
 */
const BRANDING_WRITERS = ['principal', 'school_owner', 'it_admin', 'academic_coordinator'];

/** Total serialised cap. Four inline assets plus text must stay sane in one row. */
const MAX_BRANDING_BYTES = 320 * 1024;

async function loadBranding(tenantId: string, userId: string, role: string): Promise<Branding> {
  const db = await sharedDb();
  const raw = await db.withTenant({ tenantId, userId, role }, async (c) => {
    const { rows } = await c.query<{ branding: unknown }>(
      `SELECT COALESCE(settings->'branding', '{}'::jsonb) AS branding
         FROM tenants WHERE id = app.current_tenant()`,
    );
    return rows[0]?.branding ?? {};
  });
  // Stored branding is parsed through the same validator as an incoming
  // write. A row written before a rule tightened must not be able to put a
  // value on screen that the editor would now refuse to save.
  try {
    return parseBranding(raw, DEFAULT_BRANDING);
  } catch {
    return DEFAULT_BRANDING;
  }
}

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const cors = corsHeaders([], 'GET, PUT, OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }

  try {
    const claims = await authenticate(req);

    if (req.method === 'GET') {
      // Every signed-in role reads it: the shell, the login-adjacent
      // surfaces and every printed document need the letterhead. Nothing
      // here is a secret from the school's own users — it is the school's
      // name, address and logo, printed on its own paper.
      const branding = await loadBranding(claims.tid, claims.sub, claims.role);
      json(res, 200, { branding }, cors);
      return;
    }

    if (req.method !== 'PUT') {
      json(res, 405, { error: 'method_not_allowed' }, cors);
      return;
    }

    requireRole(claims, BRANDING_WRITERS);

    const body = await readJson<{ branding?: unknown }>(req);
    const current = await loadBranding(claims.tid, claims.sub, claims.role);

    let next: Branding;
    try {
      next = parseBranding(body.branding, current);
    } catch (err) {
      if (err instanceof BrandingError) {
        // The field name is what lets the editor put the message next to
        // the input that caused it, rather than at the top of the form.
        throw new HttpError(400, err.message, 'invalid_branding', { field: err.field });
      }
      throw err;
    }

    const serialised = JSON.stringify(next);
    if (Buffer.byteLength(serialised, 'utf8') > MAX_BRANDING_BYTES) {
      throw new HttpError(413,
        `branding exceeds ${Math.floor(MAX_BRANDING_BYTES / 1024)} KB — use smaller images`,
        'branding_too_large');
    }

    const db = await sharedDb();
    const saved = await db.withTenant(
      { tenantId: claims.tid, userId: claims.sub, role: claims.role },
      async (c) => {
        const { rows } = await c.query<{ branding: Branding }>(
          `UPDATE tenants
              SET settings = COALESCE(settings, '{}'::jsonb)
                             || jsonb_build_object('branding', $1::jsonb),
                  updated_at = now()
            WHERE id = app.current_tenant()
        RETURNING settings->'branding' AS branding`,
          [serialised],
        );
        return rows[0]?.branding ?? null;
      },
    );

    // Zero rows means the tenant context did not resolve to a visible row —
    // the policy did its job. Never report success for a write that did not
    // land.
    if (!saved) throw new HttpError(404, 'tenant not found', 'tenant_not_found');

    json(res, 200, { branding: saved }, cors);
  } catch (err) {
    if (err instanceof HttpError) {
      json(res, err.status,
        { error: err.code ?? 'error', message: err.message, ...(err.detail ?? {}) }, cors);
      return;
    }
    json(res, 500, { error: 'internal_error' }, cors);
  }
}
