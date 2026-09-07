-- ---------------------------------------------------------------------
-- 079 — a school's own name, correctable.  (P10-6)
--
-- `tenants` carries the identity a school is known by outside this system:
-- name_bn, name_en, eiin, mpo_code, board_code, district, upazila,
-- address_bn. Every one of them is set ONCE, by the onboarding wizard, and
-- until now nothing could change any of them. Confirmed by inspection before
-- building this: the only `UPDATE tenants SET` paths in the product are
-- `settings` (the school's own branding), `plan_code`/`student_cap` and
-- `status` — all platform-owned or school-branding, none of them identity.
--
-- So a school onboarded with a typo in its name, or without its EIIN because
-- the operator did not have it that afternoon, stayed that way. The name is
-- on every document the school prints.
--
-- ── What this deliberately does NOT touch ────────────────────────────────
-- `slug`. It is install-link infrastructure: production addresses schools as
-- `/app?tid=<uuid>` and the slug is how an operator and a school refer to
-- each other, but it is also embedded in what people have already installed.
-- Changing it is a migration of everyone's entry point, not a correction, and
-- the master plan has not moved that ownership. It is not a parameter here.
--
-- ── Absent is not the same as blank ──────────────────────────────────────
-- Every optional parameter distinguishes THREE states, because a partial
-- save must not destroy what it did not mention:
--
--   SQL NULL      the caller did not send this field  → leave it alone
--   empty string  the caller sent it, empty           → clear it
--   a value       set it
--
-- Without that distinction, a screen that saves only the name silently wipes
-- the EIIN, the district and the address. Found exactly that way: a test that
-- re-saved a school's name to check something else cleared its EIIN, and the
-- NEXT test — which expected a duplicate-EIIN refusal — passed a save that
-- should have collided.
--
-- ── Why a function and not an UPDATE in the handler ──────────────────────
-- The same reason `app.set_tenant_status` is one: the audit row and the
-- change are written together, in one transaction, by code that cannot
-- forget. R-7's console rule is that every dangerous act carries a reason,
-- and a handler that writes the row and then writes the audit is a handler
-- where the second write can fail alone.
-- ---------------------------------------------------------------------
BEGIN;

CREATE OR REPLACE FUNCTION app.update_tenant_identity(
  p_actor      uuid,
  p_tenant     uuid,
  p_name_bn    text,
  p_name_en    text,
  p_eiin       text DEFAULT NULL,
  p_mpo_code   text DEFAULT NULL,
  p_board_code text DEFAULT NULL,
  p_district   text DEFAULT NULL,
  p_upazila    text DEFAULT NULL,
  p_address_bn text DEFAULT NULL,
  p_reason     text DEFAULT NULL
)
RETURNS TABLE (
  id         uuid,
  name_bn    text,
  name_en    text,
  eiin       text,
  mpo_code   text,
  board_code text,
  district   text,
  upazila    text,
  address_bn text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, app, audit
AS $$
DECLARE
  v_old  record;
  v_diff text;
BEGIN
  IF p_actor IS NULL THEN
    RAISE EXCEPTION 'update_tenant_identity needs an actor' USING ERRCODE = '22023';
  END IF;

  -- `name_bn` and `name_en` are NOT NULL in the schema and are what every
  -- printed document carries. Blanking one is not an edit, it is a school
  -- with no name on its transfer certificates.
  IF p_name_bn IS NULL OR btrim(p_name_bn) = '' THEN
    RAISE EXCEPTION 'name_bn cannot be blank' USING ERRCODE = '23514';
  END IF;
  IF p_name_en IS NULL OR btrim(p_name_en) = '' THEN
    RAISE EXCEPTION 'name_en cannot be blank' USING ERRCODE = '23514';
  END IF;

  SELECT t.name_bn, t.name_en, t.eiin, t.mpo_code, t.board_code,
         t.district, t.upazila, t.address_bn
    INTO v_old
    FROM tenants t WHERE t.id = p_tenant AND t.deleted_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such tenant' USING ERRCODE = 'P0002';
  END IF;

  -- What actually CHANGED, named field by field. An audit row that says
  -- "identity updated" tells a later reader nothing about which of eight
  -- fields moved, and this console's whole premise is that a dangerous act
  -- leaves a record somebody can read.
  v_diff := concat_ws(', ',
    CASE WHEN v_old.name_bn    IS DISTINCT FROM btrim(p_name_bn)
         THEN format('name_bn %L → %L', v_old.name_bn, btrim(p_name_bn)) END,
    CASE WHEN v_old.name_en    IS DISTINCT FROM btrim(p_name_en)
         THEN format('name_en %L → %L', v_old.name_en, btrim(p_name_en)) END,
    CASE WHEN v_old.eiin       IS DISTINCT FROM COALESCE(nullif(btrim(p_eiin), ''), CASE WHEN p_eiin IS NULL THEN v_old.eiin END)
         THEN format('eiin %s → %s', COALESCE(v_old.eiin, '—'),
                     COALESCE(nullif(btrim(p_eiin), ''), '—')) END,
    CASE WHEN v_old.mpo_code   IS DISTINCT FROM COALESCE(nullif(btrim(p_mpo_code), ''), CASE WHEN p_mpo_code IS NULL THEN v_old.mpo_code END)
         THEN 'mpo_code' END,
    CASE WHEN v_old.board_code IS DISTINCT FROM COALESCE(nullif(btrim(p_board_code), ''), CASE WHEN p_board_code IS NULL THEN v_old.board_code END)
         THEN 'board_code' END,
    CASE WHEN v_old.district   IS DISTINCT FROM COALESCE(nullif(btrim(p_district), ''), CASE WHEN p_district IS NULL THEN v_old.district END)
         THEN format('district %s → %s', COALESCE(v_old.district, '—'),
                     COALESCE(nullif(btrim(p_district), ''), '—')) END,
    CASE WHEN v_old.upazila    IS DISTINCT FROM COALESCE(nullif(btrim(p_upazila), ''), CASE WHEN p_upazila IS NULL THEN v_old.upazila END)
         THEN 'upazila' END,
    CASE WHEN v_old.address_bn IS DISTINCT FROM COALESCE(nullif(btrim(p_address_bn), ''), CASE WHEN p_address_bn IS NULL THEN v_old.address_bn END)
         THEN 'address_bn' END
  );

  IF v_diff IS NULL OR v_diff = '' THEN
    -- Nothing moved. Returning the row without an audit entry is deliberate:
    -- a log full of "changed nothing" is a log nobody reads, and pressing
    -- save twice is not an event.
    RETURN QUERY
      SELECT t.id, t.name_bn, t.name_en, t.eiin::text, t.mpo_code::text,
             t.board_code::text, t.district, t.upazila, t.address_bn
        FROM tenants t WHERE t.id = p_tenant;
    RETURN;
  END IF;

  UPDATE tenants t SET
    name_bn    = btrim(p_name_bn),
    name_en    = btrim(p_name_en),
    eiin       = CASE WHEN p_eiin       IS NULL THEN t.eiin
                      ELSE nullif(btrim(p_eiin), '') END,
    mpo_code   = CASE WHEN p_mpo_code   IS NULL THEN t.mpo_code
                      ELSE nullif(btrim(p_mpo_code), '') END,
    board_code = CASE WHEN p_board_code IS NULL THEN t.board_code
                      ELSE nullif(btrim(p_board_code), '') END,
    district   = CASE WHEN p_district   IS NULL THEN t.district
                      ELSE nullif(btrim(p_district), '') END,
    upazila    = CASE WHEN p_upazila    IS NULL THEN t.upazila
                      ELSE nullif(btrim(p_upazila), '') END,
    address_bn = CASE WHEN p_address_bn IS NULL THEN t.address_bn
                      ELSE nullif(btrim(p_address_bn), '') END,
    updated_at = now()
   WHERE t.id = p_tenant;

  INSERT INTO audit.platform_access (admin_id, tenant_id, reason, statement)
  VALUES (p_actor, p_tenant,
          COALESCE(nullif(btrim(p_reason), ''), 'পরিচিতি সংশোধন'),
          'update_tenant_identity: ' || v_diff);

  RETURN QUERY
    SELECT t.id, t.name_bn, t.name_en, t.eiin::text, t.mpo_code::text,
           t.board_code::text, t.district, t.upazila, t.address_bn
      FROM tenants t WHERE t.id = p_tenant;
END $$;

COMMENT ON FUNCTION app.update_tenant_identity(uuid, uuid, text, text, text, text, text, text, text, text, text) IS
  'Corrects the identity a school is known by outside this system. Writes the '
  'change and its audit row in one transaction, naming the fields that moved. '
  'Deliberately cannot touch `slug`: that is install-link infrastructure and '
  'changing it migrates everyone''s entry point rather than correcting a typo.';

REVOKE EXECUTE ON FUNCTION app.update_tenant_identity(uuid, uuid, text, text, text, text, text, text, text, text, text) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION app.update_tenant_identity(uuid, uuid, text, text, text, text, text, text, text, text, text) TO shikhon_platform;

COMMIT;
