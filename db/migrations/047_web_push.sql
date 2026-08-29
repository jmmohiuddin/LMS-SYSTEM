-- ============================================================================
-- 047 — Web push subscriptions  (R-9, docs/11-MASTER-PLAN.md §R-9)
--
-- The master plan names web push for one reason: "cuts SMS cost — the biggest
-- infra line". R-8 is what made that line real — there is now an actual
-- provider, an actual per-message cost, and a delivery report that records it —
-- so this is the phase where a cheaper channel can be measured against
-- something rather than asserted.
--
-- ── Why this is not a column on user_sessions ──────────────────────────
-- `user_sessions` is already per (user, device) and looks like the obvious
-- home. It is the wrong one: a session is rotated on every refresh
-- (`superseded_by`), revoked on logout, and expires. A push subscription
-- outlives all of that — the browser keeps it until it rotates the endpoint or
-- the user revokes permission. Hanging it off a session would mean push
-- stopped working at the first token refresh, which is a bug that would take
-- a school a week to describe and a day to reproduce.
--
-- ── The endpoint is globally unique, and that is a SECURITY property ────
-- A push endpoint identifies a BROWSER, not a person. Two users at two
-- different schools sharing one device and one origin — a school office
-- computer, a shared family phone — get the SAME endpoint from the push
-- service.
--
-- If both rows were allowed to exist, school A would go on pushing to a
-- browser now being used by school B's parent, and B's parent would read A's
-- notices on their lock screen. That is a cross-tenant disclosure through a
-- shared device, and no amount of RLS prevents it, because both rows are
-- individually legitimate inside their own tenant.
--
-- So: one row per endpoint, globally. Whoever most recently proved they are
-- signed in on this device owns its subscription, and claiming it deletes the
-- previous owner's row. That deletion necessarily crosses tenants, which the
-- runtime role cannot do — hence `app.claim_push_subscription()` below, which
-- is SECURITY DEFINER for exactly that one delete and takes no tenant or user
-- from its arguments.
--
-- ── What is NOT stored ─────────────────────────────────────────────────
-- No message bodies. A push payload is built at send time from the notice the
-- recipient already holds a receipt for, encrypted per RFC 8291, and kept
-- nowhere. This table holds only what is needed to address a device.
-- ============================================================================

BEGIN;

CREATE TABLE push_subscriptions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id       uuid NOT NULL REFERENCES users(id)   ON DELETE CASCADE,

  -- The push service's URL for this browser. Opaque to us, high-entropy, and
  -- the closest thing to a device identifier the product stores — which is why
  -- Layer 2 below keeps it away from everyone except its owner.
  endpoint      text NOT NULL CHECK (length(endpoint) BETWEEN 16 AND 2048),

  -- RFC 8291 §2: the browser's P-256 public key (65 bytes, base64url) and its
  -- 16-byte auth secret (base64url). Both are the browser's half of the
  -- end-to-end encryption; neither is a credential of ours.
  p256dh        text NOT NULL CHECK (length(p256dh) BETWEEN 16 AND 255),
  auth          text NOT NULL CHECK (length(auth)   BETWEEN 8  AND 64),

  -- "অফিসের কম্পিউটার", "নিজের ফোন". Shown so a person can tell which device
  -- they are revoking. Free text, supplied by the client, never trusted for
  -- anything but display.
  device_label  text CHECK (device_label IS NULL OR length(device_label) <= 80),

  created_at      timestamptz NOT NULL DEFAULT now(),
  -- Delivery health. `last_success_at` is when a push service ACCEPTED a
  -- message, which is not when a person read it — the same distinction R-8
  -- drew for SMS, and it is drawn here in the column name rather than left to
  -- a reader's optimism.
  last_success_at timestamptz,
  last_failure_at timestamptz,
  failure_count   smallint NOT NULL DEFAULT 0
);

-- One row per browser, across every tenant. See the header: this index IS the
-- shared-device protection, not merely a tidiness constraint.
CREATE UNIQUE INDEX uq_push_endpoint ON push_subscriptions (endpoint);

-- The sender's query: every live device for one person in one school.
CREATE INDEX ix_push_user ON push_subscriptions (tenant_id, user_id);

CREATE TRIGGER trg_push_subscriptions_tenant
  BEFORE INSERT OR UPDATE ON push_subscriptions
  FOR EACH ROW EXECUTE FUNCTION app.enforce_tenant();

COMMENT ON TABLE push_subscriptions IS
  'R-9: one web-push subscription per browser. The endpoint is globally unique '
  'because it identifies a device, not a person, and two schools sharing a '
  'device must not both push to it.';

-- ---------------------------------------------------------------------
-- Row-level security
--
-- Layer 1 (tenant_isolation) is generated for pre-010 tables by 010's DO
-- block; a table added afterwards declares it itself.
-- ---------------------------------------------------------------------
ALTER TABLE push_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE push_subscriptions FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON push_subscriptions
  AS PERMISSIVE FOR ALL TO shikhon_app
  USING (app.tenant_guard(tenant_id)) WITH CHECK (app.tenant_guard(tenant_id));

-- ── Layer 2: a subscription belongs to its owner, and to nobody else ──
--
-- Deliberately NOT readable by the principal. Everywhere else in this product
-- management can see what the office has to answer for — who received a
-- notice, who was absent. A push endpoint is different in kind: it is a
-- device identifier that lets its holder send a notification to a specific
-- person's phone, and no question the office has to answer requires it.
--
-- `system_ingest` is admitted because the dispatcher must read endpoints to
-- send to them and must record what happened — the same narrow admission
-- 010 §296 makes for the outbound-delivery worker on sms_outbox.
CREATE POLICY push_read_scope ON push_subscriptions
  AS RESTRICTIVE FOR SELECT TO shikhon_app
  USING (user_id = app.current_user_id() OR app.is_system_ingest());

-- A person subscribes their own device. There is no path by which one user
-- registers a device for another, so no role check widens this.
CREATE POLICY push_insert_scope ON push_subscriptions
  AS RESTRICTIVE FOR INSERT TO shikhon_app
  WITH CHECK (user_id = app.current_user_id());

-- The owner relabels; the dispatcher stamps delivery health.
CREATE POLICY push_update_scope ON push_subscriptions
  AS RESTRICTIVE FOR UPDATE TO shikhon_app
  USING (user_id = app.current_user_id() OR app.is_system_ingest());

-- The owner unsubscribes; the dispatcher removes a subscription the push
-- service has told us is gone (HTTP 404/410). Both are deletions of a row
-- that has stopped being useful, and neither can reach another person's.
CREATE POLICY push_delete_scope ON push_subscriptions
  AS RESTRICTIVE FOR DELETE TO shikhon_app
  USING (user_id = app.current_user_id() OR app.is_system_ingest());

GRANT SELECT, INSERT, UPDATE, DELETE ON push_subscriptions TO shikhon_app;

-- ---------------------------------------------------------------------
-- app.claim_push_subscription — register this browser to the caller.
--
-- SECURITY DEFINER for one reason and one only: the previous owner of this
-- endpoint may be in a different tenant (see the header), and the runtime
-- role cannot see that row to delete it.
--
-- Note what it does NOT take: no tenant id, no user id. Both come from the
-- session context, so there is no argument a caller could supply to write
-- into somebody else's school. The endpoint and keys are the browser's own
-- and are the only thing the caller gets to choose.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.claim_push_subscription(
  p_endpoint     text,
  p_p256dh       text,
  p_auth         text,
  p_device_label text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, app
AS $$
DECLARE
  v_tenant uuid := app.current_tenant();
  v_user   uuid := app.current_user_id();
  v_id     uuid;
BEGIN
  IF v_tenant IS NULL OR v_user IS NULL THEN
    RAISE EXCEPTION 'push subscription requires an authenticated session'
      USING ERRCODE = '42501';
  END IF;

  -- The caller must be a real, active member of the tenant they claim to be
  -- in. DEFINER means RLS is not doing this check for us, so it is done here
  -- explicitly rather than trusted from the session variables alone.
  IF NOT EXISTS (
    SELECT 1 FROM users u
     WHERE u.id = v_user AND u.tenant_id = v_tenant AND u.status = 'active'
  ) THEN
    RAISE EXCEPTION 'no active user % in tenant %', v_user, v_tenant
      USING ERRCODE = '42501';
  END IF;

  -- Whoever is signed in on this browser now owns its subscription. The
  -- previous owner may be in another school; that row goes, because the
  -- alternative is pushing one school's notices to another school's parent.
  DELETE FROM push_subscriptions WHERE endpoint = p_endpoint;

  INSERT INTO push_subscriptions
    (tenant_id, user_id, endpoint, p256dh, auth, device_label)
  VALUES (v_tenant, v_user, p_endpoint, p_p256dh, p_auth,
          nullif(btrim(coalesce(p_device_label, '')), ''))
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

COMMENT ON FUNCTION app.claim_push_subscription(text, text, text, text) IS
  'R-9: registers this browser to the CALLER (tenant and user come from the '
  'session, never from an argument). SECURITY DEFINER solely to delete a '
  'previous owner''s row for the same endpoint, which may be in another tenant.';

REVOKE ALL ON FUNCTION app.claim_push_subscription(text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.claim_push_subscription(text, text, text, text)
  TO shikhon_app;

COMMIT;
