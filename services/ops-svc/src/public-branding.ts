/**
 * The pre-auth tenant lookup shared by /ops/brand and /ops/manifest.
 *
 * Both answer the same question — "which school is this, and what does it
 * look like?" — for a caller with no session. They existed briefly as two
 * copies of the same query and the same key regex, which is one edit away
 * from a manifest that accepts a key the login screen rejects, or worse,
 * the reverse.
 *
 * Everything here reads through app.public_branding() (migration 039),
 * whose SQL fixes the seven returnable fields with an explicit allowlist.
 * That function, not this file, is what bounds the exposure.
 */
import type { IncomingMessage } from 'node:http';
import { sharedDb } from '../../../packages/server-core/src/db.ts';
import { query } from '../../../packages/server-core/src/http.ts';
import {
  parseBranding,
  DEFAULT_BRANDING,
  type Branding,
} from '../../../packages/ui-core/src/branding.ts';

/**
 * A tenant key is a slug (the CHECK in migration 001) or a tenant uuid —
 * the install link carries the id, a vanity URL would carry the slug. The
 * slug pattern already accepts the character set a uuid uses, so one
 * expression covers both; the length ceiling is what stops a junk query
 * string from reaching the database at all.
 */
export const TENANT_KEY_RE = /^[a-z0-9][a-z0-9-]{2,62}$/;

/** Accept either ?slug= or ?tid=, since both names are already in use. */
export function tenantKey(req: IncomingMessage): string {
  const q = query(req);
  return (q.get('slug') ?? q.get('tid') ?? '').trim().toLowerCase();
}

export interface ResolvedTenant {
  tenantId: string;
  slug: string;
  branding: Branding;
}

/**
 * Resolve a key to a tenant and its full-shaped branding, or null.
 *
 * Returns null for a malformed key, an unknown school, and an unreachable
 * database alike — the callers all degrade to neutral branding, and none
 * of them should be able to tell those three cases apart. A login screen
 * that renders differently for "no such school" is an existence oracle.
 */
export async function resolvePublicTenant(key: string): Promise<ResolvedTenant | null> {
  if (!TENANT_KEY_RE.test(key)) return null;
  try {
    const db = await sharedDb();
    const row = await db.withSystemRole('anonymous', async (c) => {
      const { rows } = await c.query<{
        tenant_id: string;
        slug: string;
        name_bn: string;
        name_en: string;
        branding: Record<string, unknown>;
      }>(
        `SELECT tenant_id, slug, name_bn, name_en, branding
           FROM app.public_branding($1::text)`,
        [key],
      );
      return rows[0] ?? null;
    });
    if (!row) return null;

    // The tenant's own name columns are the base, so a school that has
    // never opened the branding editor still shows its real name instead
    // of the "শিক্ষা প্রতিষ্ঠান" placeholder.
    const base = parseBranding(
      { nameBn: row.name_bn, nameEn: row.name_en, shortName: row.name_bn.slice(0, 32) },
      DEFAULT_BRANDING,
    );
    return {
      tenantId: row.tenant_id,
      slug: row.slug,
      branding: parseBranding(row.branding, base),
    };
  } catch {
    return null;
  }
}
