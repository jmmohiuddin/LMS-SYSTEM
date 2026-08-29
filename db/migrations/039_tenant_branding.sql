-- ============================================================================
-- 039 — Tenant branding  (R-1, docs/11-MASTER-PLAN.md)
--
-- One deployment, many institutions, and each must see only its own
-- identity. The academic and financial halves of that promise were already
-- kept — tenant_id on ~95 tables, RLS on every one of them. The visible
-- half was not: every school saw "ShikhonBD" on its own login screen.
--
-- ── Why no new table ────────────────────────────────────────────────────
-- Branding is exactly one row per tenant, always read whole, never joined,
-- never queried by any of its fields. That is a column, not a table. It
-- goes in tenants.settings->'branding', which already exists, is already
-- covered by the tenant_self RLS policy in 010, and already carries the
-- app.enforce_tenant() immutability guarantee by virtue of being a column
-- of the tenant row itself.
--
-- A separate organization_branding table would have needed its own policy,
-- its own grants, its own FK, and a join on every read — to hold one row.
--
-- ── Why the shape is not a CHECK constraint ─────────────────────────────
-- The field rules (hex colours, a raster-only asset allowlist, per-field
-- size caps, WCAG contrast) live in packages/ui-core/src/branding.ts, so
-- that the editor and the API validate identically instead of drifting.
-- Re-encoding them in SQL would be a second implementation of the same
-- schema, and the two would diverge in the usual direction: the database
-- accepting something the editor refuses.
--
-- What SQL DOES enforce is the part it is uniquely good at — that the key
-- is an object at all, so no read path has to defend against
-- settings->'branding' being a string or an array.
--
-- ── Why a SECURITY DEFINER read ─────────────────────────────────────────
-- The login screen must show the school's name and logo BEFORE anyone has
-- logged in, and a pre-auth request has no tenant context, so
-- app.current_tenant() is NULL and tenant_self correctly returns nothing.
--
-- app.public_branding() is the one deliberate, audited hole in that: it
-- returns SEVEN fields — the ones on the institution's signboard — for one
-- tenant looked up by an exact key. Not the settings blob, not the row.
-- Address, phone, email, headmaster and the document assets are absent by
-- construction, because a directory of every school's contact details is a
-- scrape rather than a feature. It cannot enumerate: no key, no row.
--
-- The key is a slug OR a tenant id, because both are in circulation: the
-- install link a school hands out carries the id (apps/pwa reads it from
-- ?tid=), while a vanity URL would carry the slug. Accepting the id costs
-- nothing in exposure — a v4 uuid is 122 bits of entropy, strictly harder
-- to guess than a slug someone chose to be memorable.
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- 1. Shape guard. Not a schema — see the header. Just "it is an object".
-- ---------------------------------------------------------------------
ALTER TABLE tenants
  ADD CONSTRAINT tenants_branding_is_object
  CHECK (
    settings->'branding' IS NULL
    OR jsonb_typeof(settings->'branding') = 'object'
  );

-- ---------------------------------------------------------------------
-- 2. Seed every existing tenant from what it already knows about itself.
--
-- A school that has never opened the branding editor should still see its
-- own name — not the platform's, and not a placeholder. name_bn, name_en
-- and address_bn have been on the tenant row since 001; this simply makes
-- them visible. Colours are left to the ui-core defaults by omission
-- rather than written here, so a later change to the design system's
-- default palette reaches unconfigured tenants instead of being frozen
-- into their rows on the day they were migrated.
--
-- COALESCE on settings, and the ||-merge, mean this is re-runnable and
-- never clobbers a branding that already exists.
-- ---------------------------------------------------------------------
UPDATE tenants
SET settings = COALESCE(settings, '{}'::jsonb) || jsonb_build_object(
      'branding',
      jsonb_strip_nulls(jsonb_build_object(
        'nameBn',    name_bn,
        'nameEn',    name_en,
        'shortName', left(name_bn, 32),
        'address',   address_bn
      ))
    )
WHERE settings->'branding' IS NULL;

-- ---------------------------------------------------------------------
-- 3. Pre-auth branding read.
--
-- STABLE, not VOLATILE: it reads and never writes.
-- SECURITY DEFINER with an explicit search_path — without the SET, a
-- caller controlling search_path could shadow `tenants` and make a
-- definer-rights function read a table of their choosing.
--
-- Returns at most one row. Soft-deleted and archived tenants return
-- nothing: a school that has left should stop appearing anywhere, and the
-- login screen is somewhere.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.public_branding(p_key text)
RETURNS TABLE (
  tenant_id      uuid,
  slug           citext,
  name_bn        text,
  name_en        text,
  branding       jsonb
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, app
AS $$
  SELECT
    t.id,
    t.slug,
    t.name_bn,
    t.name_en,
    -- Explicit key list. A future field added to the branding object is
    -- private until someone deliberately adds it here, which is the
    -- correct default for a function that answers unauthenticated callers.
    COALESCE(
      (SELECT jsonb_object_agg(k, v)
         FROM jsonb_each(COALESCE(t.settings->'branding', '{}'::jsonb)) AS e(k, v)
        WHERE k IN ('nameBn','nameEn','shortName','logoUrl','faviconUrl',
                    'primaryColor','accentColor')),
      '{}'::jsonb
    )
  FROM tenants t
  -- Exact match on either key. `t.id::text = lower(p_key)` rather than
  -- `t.id = p_key::uuid`: a cast of a non-uuid key would raise 22P02 and
  -- turn "unknown school" into a 500, which is both a worse login screen
  -- and a free existence oracle.
  WHERE (t.slug = p_key::citext OR t.id::text = lower(p_key))
    AND t.deleted_at IS NULL
    AND t.status <> 'archived'
  LIMIT 1;
$$;

COMMENT ON FUNCTION app.public_branding(text) IS
  'R-1: pre-auth login-screen identity for one tenant, keyed by slug or id. '
  'Returns only signboard fields (name, short name, logo, favicon, colours) — '
  'never the settings blob, contact details, or document assets. Cannot enumerate.';

-- shikhon_app is the runtime role; it calls this before any session exists.
GRANT EXECUTE ON FUNCTION app.public_branding(text) TO shikhon_app;

-- Authenticated branding reads and writes need no new grant: 010 already
-- grants SELECT/UPDATE on every table in public to shikhon_app, and the
-- tenant_self policy (`id = app.current_tenant()`) is what confines both
-- to the caller's own row. That policy is the enforcement for R-1's
-- isolation requirement; the endpoint's requireRole() is a courtesy 403 in
-- front of it, not the boundary.

COMMIT;
