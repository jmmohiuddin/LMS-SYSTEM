-- ============================================================================
-- 037 — Fallback activation codes  (F-202)
--
-- F-201's OTP login is built and dark, waiting on an SMS aggregator
-- contract — "the single hardest external dependency in the plan". F-202
-- is the P0 that keeps a pilot from being hostage to that negotiation:
-- "school-issued credential with forced first-login change, or
-- teacher-mediated student activation."
--
-- This is the teacher-mediated path. A teacher issues a short code to a
-- student (or the head to a member of staff), face to face — the school
-- itself is the identity authority here, which is the one thing a school
-- is genuinely better at than an SMS gateway. Redeeming the code proves
-- the holder is the person the issuer meant, activates the account, and
-- mints the same session pair OTP verification would have.
--
-- ── The code never exists in this table ──────────────────────────────────
-- Only its keyed hash (HMAC-SHA256 under ACTIVATION_PEPPER, held in the
-- environment). The code space is ~40 bits, which no online guesser will
-- cross under F-102's caps — but which a GPU crosses in hours OFFLINE if
-- a database leak yields unkeyed hashes. The pepper is what makes the
-- table worthless without also owning the runtime.
--
-- Single-use, 72-hour expiry, revocable. An issued-but-unredeemed code is
-- a live credential on a slip of paper somewhere, and 72 hours is as long
-- as that should stay true.
-- ============================================================================
BEGIN;

CREATE TABLE activation_codes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  -- HMAC-SHA256(pepper, code). Deterministic so redemption can look the
  -- row up by equality; keyed so the table alone is not brute-forceable.
  code_hash   bytea NOT NULL UNIQUE CHECK (octet_length(code_hash) = 32),

  issued_by   uuid NOT NULL REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL DEFAULT now() + interval '72 hours',
  used_at     timestamptz,
  revoked_at  timestamptz,

  CHECK (expires_at > created_at)
);

CREATE INDEX ix_activation_codes_user ON activation_codes (tenant_id, user_id);

COMMENT ON TABLE activation_codes IS
  'F-202. Teacher-mediated activation: the fallback first-login path that '
  'keeps a pilot from being hostage to the SMS aggregator negotiation. '
  'Stores only the keyed hash; single-use; 72-hour expiry.';

ALTER TABLE activation_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE activation_codes FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON activation_codes
  AS PERMISSIVE FOR ALL TO shikhon_app
  USING (app.tenant_guard(tenant_id))
  WITH CHECK (app.tenant_guard(tenant_id));

CREATE TRIGGER trg_activation_codes_tenant BEFORE INSERT OR UPDATE ON activation_codes
  FOR EACH ROW EXECUTE FUNCTION app.enforce_tenant();

-- Issuing IS the authorization decision, so the scope lives in the
-- policy, not in an endpoint's memory of it: management may activate
-- anyone in the school; a class teacher may activate exactly the students
-- of their own sections — the "teacher-mediated" of the requirement.
CREATE POLICY activation_issue_scope ON activation_codes
  AS RESTRICTIVE FOR INSERT TO shikhon_app
  WITH CHECK (
    app.has_role('principal', 'school_owner', 'academic_coordinator')
    OR (
      app.has_role('class_teacher')
      AND EXISTS (
        SELECT 1 FROM enrolments e
         WHERE e.student_id = activation_codes.user_id
           AND e.status = 'active'
           AND e.section_id = ANY(app.my_section_ids())
      )
    )
  );

-- Redemption runs pre-authentication as system_ingest (the same posture
-- as OTP verification: the code is the credential being checked, so
-- there is no user yet). Management audits everything outstanding; an
-- issuer sees what THEY issued — which is both reasonable on its own
-- (the row holds a hash and an expiry, never the code) and load-bearing:
-- INSERT ... RETURNING checks the new row against the SELECT policies,
-- so without this clause a class teacher's issue would be refused by the
-- read policy — the same trap ON CONFLICT sprang on the events table.
CREATE POLICY activation_read_scope ON activation_codes
  AS RESTRICTIVE FOR SELECT TO shikhon_app
  USING (
    app.has_role('principal', 'school_owner', 'academic_coordinator')
    OR issued_by = app.current_user_id()
    OR app.is_system_ingest()
  );

-- Marking used (redeem) or revoked (management). Never both paths for
-- both actors — but the column being written cannot be told apart at
-- policy level, so the endpoint owns that distinction and the policy
-- bounds who may write at all.
CREATE POLICY activation_update_scope ON activation_codes
  AS RESTRICTIVE FOR UPDATE TO shikhon_app
  USING (
    app.has_role('principal', 'school_owner', 'academic_coordinator')
    OR app.is_system_ingest()
  );

GRANT SELECT, INSERT, UPDATE ON activation_codes TO shikhon_app;

COMMIT;
