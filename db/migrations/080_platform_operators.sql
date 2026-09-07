-- ---------------------------------------------------------------------
-- 080 — who the operator was.  (P10-5, closes B-39)
--
-- `audit.platform_access.admin_id` is a JWT subject and nothing else. There
-- is no row behind it, so P7's audit tab shows WHAT, WHY and WHEN and
-- deliberately omits WHO — printing the uuid would break "never expose raw
-- UUIDs" and a truncated one would look like an identity while being a
-- fragment. That is honest and it is not accountability: a console built so
-- that every dangerous act carries a reason cannot say whose reason it was.
--
-- ── Why not `users` ──────────────────────────────────────────────────────
-- Checked before building this, because the brief is right that a second
-- identity table is usually a mistake. `users.tenant_id` is
-- `uuid NOT NULL REFERENCES tenants(id)`, and that column is load-bearing:
-- every RLS policy in the schema is written against it and `app.enforce_tenant`
-- fires on every insert. A platform operator belongs to no school. Making
-- `tenant_id` nullable to fit one in would weaken the isolation of all 258
-- schools to record eight names — a far worse trade than a small table.
--
-- Nothing in identity-svc issues a `super_admin` token either, so there is no
-- existing login flow to hang this off. Operator credentials are minted out
-- of band and always were.
--
-- ── What this is, and is not ─────────────────────────────────────────────
-- It is a NAME PER ISSUED CREDENTIAL, plus the ability to revoke one. It
-- holds no password, no hash and no secret: the credential itself still lives
-- wherever it was minted, and this table only says whose it is and whether it
-- is still allowed. Storing anything more would make the console a place
-- worth stealing.
-- ---------------------------------------------------------------------
BEGIN;

CREATE TABLE IF NOT EXISTS platform_operators (
  -- The JWT `sub` of an issued operator credential. NOT generated here: the
  -- credential exists first and this table names it, which is why the id is
  -- supplied rather than defaulted.
  id            uuid PRIMARY KEY,
  full_name     text NOT NULL CHECK (btrim(full_name) <> ''),
  email         citext,
  -- 'active' | 'revoked'. A revoked operator is kept, not deleted: the audit
  -- rows they wrote must stay resolvable to a name for as long as the rows
  -- do, and deleting the row is how an audit trail loses its actor again.
  status        text NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active', 'revoked')),
  note          text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    uuid,
  revoked_at    timestamptz,
  revoked_by    uuid,
  -- Written by the authorize() path on every console request, so "when did
  -- this credential last act" is a fact rather than a memory.
  last_seen_at  timestamptz,
  CHECK ((status = 'revoked') = (revoked_at IS NOT NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_platform_operator_email
  ON platform_operators (email) WHERE email IS NOT NULL;

COMMENT ON TABLE platform_operators IS
  'A name per issued platform credential, so audit.platform_access.admin_id '
  'resolves to a person. Holds no secret: the credential lives where it was '
  'minted. Revoked rows are kept so old audit entries stay resolvable.';

-- ── Locking it away from the tenant role ────────────────────────────────
--
-- This table is NOT tenant-scoped and must never be reachable from a school:
-- it is the list of people who can suspend any institution in the country.
--
-- REVOKE FROM PUBLIC is not enough, and a test caught that. Migration 010
-- runs `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public
-- TO shikhon_app` — the schema's model is that `shikhon_app` may touch the
-- tables and RLS decides which ROWS. A new table with no RLS inherits the
-- grant and none of the protection, so this one was readable by the role
-- that serves every tenant request until the assertion below failed.
--
-- Both halves, because either alone is one migration away from being undone:
-- the grant is revoked, AND row-level security denies by default so a future
-- blanket GRANT cannot silently reopen it.
REVOKE ALL ON platform_operators FROM PUBLIC;
REVOKE ALL ON platform_operators FROM shikhon_app;
REVOKE ALL ON platform_operators FROM shikhon_readonly;
GRANT SELECT, INSERT, UPDATE ON platform_operators TO shikhon_platform;

ALTER TABLE platform_operators ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_operators FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS platform_operators_console ON platform_operators;
-- One policy, one role. Everything else — including a tenant request that
-- somehow reached this far — matches nothing and sees nothing.
CREATE POLICY platform_operators_console ON platform_operators
  FOR ALL TO shikhon_platform USING (true) WITH CHECK (true);

-- ---------------------------------------------------------------------
-- app.platform_operators — the directory, with what each one has done.
--
-- The action count comes from the audit trail rather than a counter column,
-- so it cannot drift from the rows it describes.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.platform_operators()
RETURNS TABLE (
  id           uuid,
  full_name    text,
  email        citext,
  status       text,
  note         text,
  created_at   timestamptz,
  last_seen_at timestamptz,
  revoked_at   timestamptz,
  actions      bigint,
  last_action  timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, app, audit
AS $$
  SELECT o.id, o.full_name, o.email, o.status, o.note,
         o.created_at, o.last_seen_at, o.revoked_at,
         COALESCE(a.n, 0), a.last_at
    FROM platform_operators o
    LEFT JOIN (
      SELECT admin_id, count(*) AS n, max(created_at) AS last_at
        FROM audit.platform_access GROUP BY admin_id
    ) a ON a.admin_id = o.id
   ORDER BY (o.status = 'revoked'), lower(o.full_name);
$$;

-- ---------------------------------------------------------------------
-- app.record_operator_seen — last activity, cheaply.
--
-- Called on every authorized console request. It is deliberately a no-op for
-- a credential that is not in the directory: the console must keep working
-- for an operator nobody has named yet, or adding this table would lock out
-- whoever is holding the only credential today.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.record_operator_seen(p_id uuid)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, app
AS $$
  UPDATE platform_operators SET last_seen_at = now() WHERE id = p_id;
$$;

-- ---------------------------------------------------------------------
-- app.operator_is_revoked — the gate.
--
-- FALSE for an unknown credential, on purpose and for the same reason: this
-- table names credentials, it does not authorise them. Revocation is a
-- statement about a credential somebody has recorded; it cannot be a
-- statement about every credential that exists.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.operator_is_revoked(p_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, app
AS $$
  SELECT EXISTS (
    SELECT 1 FROM platform_operators
     WHERE id = p_id AND status = 'revoked');
$$;

-- ---------------------------------------------------------------------
-- app.upsert_platform_operator — name a credential, or revoke one.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.upsert_platform_operator(
  p_actor  uuid,
  p_id     uuid,
  p_name   text,
  p_email  text DEFAULT NULL,
  p_note   text DEFAULT NULL,
  p_status text DEFAULT 'active'
)
RETURNS TABLE (
  id uuid, full_name text, email citext, status text,
  note text, created_at timestamptz, revoked_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, app, audit
AS $$
-- The RETURNS TABLE above declares an OUT parameter called `id`, which
-- PL/pgSQL then treats as a variable — and `ON CONFLICT (id)` becomes
-- ambiguous between that variable and the column. This tells PL/pgSQL to
-- read a bare name as the COLUMN, which is what every reference in this
-- body means.
#variable_conflict use_column
BEGIN
  IF p_actor IS NULL THEN
    RAISE EXCEPTION 'upsert_platform_operator needs an actor' USING ERRCODE = '22023';
  END IF;
  IF p_status NOT IN ('active', 'revoked') THEN
    RAISE EXCEPTION 'status must be active or revoked' USING ERRCODE = '22023';
  END IF;
  -- An operator revoking themselves locks the console for the person holding
  -- it, in the middle of whatever they were doing. Refused; another operator
  -- can do it, which is also what makes it a two-person act.
  IF p_status = 'revoked' AND p_actor = p_id THEN
    RAISE EXCEPTION 'an operator cannot revoke their own credential'
      USING ERRCODE = '22023';
  END IF;

  INSERT INTO platform_operators AS o
    (id, full_name, email, note, status, created_by,
     revoked_at, revoked_by)
  VALUES (p_id, btrim(p_name), nullif(btrim(p_email), ''),
          nullif(btrim(p_note), ''), p_status, p_actor,
          CASE WHEN p_status = 'revoked' THEN now() END,
          CASE WHEN p_status = 'revoked' THEN p_actor END)
  ON CONFLICT (id) DO UPDATE SET
    full_name  = btrim(p_name),
    email      = nullif(btrim(p_email), ''),
    note       = COALESCE(nullif(btrim(p_note), ''), o.note),
    status     = p_status,
    revoked_at = CASE WHEN p_status = 'revoked'
                      THEN COALESCE(o.revoked_at, now()) END,
    revoked_by = CASE WHEN p_status = 'revoked'
                      THEN COALESCE(o.revoked_by, p_actor) END;

  -- Recorded with a NULL tenant: this is an act on the platform, not on any
  -- school, and hanging it off an arbitrary tenant would put it in that
  -- school's history where it does not belong.
  INSERT INTO audit.platform_access (admin_id, tenant_id, reason, statement)
  VALUES (p_actor, NULL,
          CASE WHEN p_status = 'revoked' THEN 'অপারেটর প্রত্যাহার'
               ELSE 'অপারেটর যুক্ত/সংশোধন' END,
          format('upsert_platform_operator %s → %s', btrim(p_name), p_status));

  RETURN QUERY
    SELECT o2.id, o2.full_name, o2.email, o2.status, o2.note,
           o2.created_at, o2.revoked_at
      FROM platform_operators o2 WHERE o2.id = p_id;
END $$;

REVOKE EXECUTE ON FUNCTION app.platform_operators() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.record_operator_seen(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.operator_is_revoked(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.upsert_platform_operator(uuid, uuid, text, text, text, text) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION app.platform_operators() TO shikhon_platform;
GRANT  EXECUTE ON FUNCTION app.record_operator_seen(uuid) TO shikhon_platform;
GRANT  EXECUTE ON FUNCTION app.operator_is_revoked(uuid) TO shikhon_platform;
GRANT  EXECUTE ON FUNCTION app.upsert_platform_operator(uuid, uuid, text, text, text, text) TO shikhon_platform;

COMMIT;
