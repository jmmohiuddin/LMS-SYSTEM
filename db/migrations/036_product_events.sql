-- ============================================================================
-- 036 — Product event instrumentation  (F-1503, TRD §13)
--
-- "Nothing is instrumented today, which means a pilot would produce no
-- data to gate Phase 2 on." P0, and the TRD is specific about the shape:
-- self-hosted event table with periodic rollup — no third-party SDK
-- (payload budget N-03, data residency N-10) — events batch and queue
-- offline like any other mutation, tenant-scoped, and under the same RLS
-- as production data.
--
-- ── PII is refused by construction, not by policy ────────────────────────
-- TRD §12: "scrub personal data from logs, error reports and analytics
-- events by construction rather than by policy." A policy is a sentence in
-- a document; construction is a trigger. Any payload containing a
-- known-personal key (name, phone, nid, brc, guardian…), a Bangladeshi
-- mobile number, or a 13/17-digit identifier-shaped number is REJECTED at
-- insert — not cleaned, rejected, because a scrubber that silently
-- repairs events teaches callers to keep sending PII.
--
-- user_id stays. It is a foreign key under the same RLS as every other
-- row, the learning-signal events (F-1402 attempt sequences) are
-- meaningless without it, and pseudonymising it here while the same uuid
-- sits in twenty other tables would be theatre.
--
-- ── Insert-only ──────────────────────────────────────────────────────────
-- An analytics row that can be edited is a metric that can be negotiated.
-- No UPDATE or DELETE policy exists for anyone; retention is the rollup
-- function's documented pruning, run by the maintenance cron as the
-- table's OWNER — deliberately outside what shikhon_app can do.
-- ============================================================================
BEGIN;

CREATE TABLE product_events (
  -- Client-generated UUID, which is the idempotency key: events queue
  -- offline and replay on reconnect, and a replayed batch must not double
  -- the metric it feeds.
  id           uuid PRIMARY KEY,
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,

  -- 'domain.action', domains fixed by TRD §13.1's table. A CHECK rather
  -- than an enum: actions will grow weekly, domains will not.
  event_type   text NOT NULL CHECK (
    event_type ~ '^(activation|engagement|learning|offline|ai|routine|finance|error)\.[a-z0-9_]{1,64}$'
  ),

  actor_role   text,
  user_id      uuid REFERENCES users(id) ON DELETE SET NULL,
  device_id    text,

  -- The client's clock, because offline events arrive hours late and the
  -- gap between the two IS the offline story F-1503 wants to measure.
  occurred_at  timestamptz NOT NULL,
  received_at  timestamptz NOT NULL DEFAULT now(),

  payload      jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- A payload is context, not a document store.
  CHECK (pg_column_size(payload) <= 4096)
);

CREATE INDEX ix_product_events_rollup
  ON product_events (tenant_id, event_type, occurred_at);
CREATE INDEX ix_product_events_received
  ON product_events (received_at);

COMMENT ON TABLE product_events IS
  'F-1503 / TRD §13. Self-hosted product analytics. Insert-only; PII is '
  'refused at the trigger, not scrubbed; raw rows are pruned by the rollup '
  'after 90 days and the rollup table is what dashboards read.';

-- ---------------------------------------------------------------------
-- The by-construction guard.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.assert_event_payload_clean()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE v_text text;
BEGIN
  -- Keys that mean somebody put a person in an analytics event. Checked
  -- at every depth, because {"meta":{"studentName":…}} is the same leak
  -- one level down.
  IF EXISTS (
    SELECT 1 FROM jsonb_paths(NEW.payload) AS p(key)
     WHERE p.key ~* '(name|phone|mobile|email|nid|brc|birth|guardian|address)'
  ) THEN
    RAISE EXCEPTION 'event payload contains a personal-data key and was refused'
      USING ERRCODE = 'check_violation',
            HINT = 'send ids and counts, never names or contact details';
  END IF;

  v_text := NEW.payload::text;
  -- A Bangladeshi mobile number, or a 13/17-digit identifier-shaped run —
  -- the NID and birth-registration shapes. Values, not just keys, because
  -- the leak that matters is the one under an innocent key.
  IF v_text ~ '\+?8801[3-9][0-9]{8}' OR v_text ~ '[0-9]{13,17}' THEN
    RAISE EXCEPTION 'event payload contains an identifier-shaped value and was refused'
      USING ERRCODE = 'check_violation',
            HINT = 'send ids and counts, never phone numbers or registration numbers';
  END IF;

  RETURN NEW;
END $$;

-- Every key at every depth of a jsonb object tree.
CREATE OR REPLACE FUNCTION jsonb_paths(j jsonb)
RETURNS TABLE (key text)
LANGUAGE sql IMMUTABLE
AS $$
  WITH RECURSIVE walk (node) AS (
    SELECT j
    UNION ALL
    SELECT CASE jsonb_typeof(v.value) WHEN 'object' THEN v.value
                WHEN 'array' THEN v.value ELSE NULL END
      FROM walk, LATERAL (
        SELECT value FROM jsonb_each(walk.node) WHERE jsonb_typeof(walk.node) = 'object'
        UNION ALL
        SELECT value FROM jsonb_array_elements(walk.node) WHERE jsonb_typeof(walk.node) = 'array'
      ) v
     WHERE jsonb_typeof(v.value) IN ('object', 'array')
  )
  SELECT k FROM walk, LATERAL jsonb_object_keys(walk.node) k
   WHERE jsonb_typeof(walk.node) = 'object'
$$;

CREATE TRIGGER trg_product_events_clean
  BEFORE INSERT ON product_events
  FOR EACH ROW EXECUTE FUNCTION app.assert_event_payload_clean();

COMMENT ON FUNCTION app.assert_event_payload_clean IS
  'TRD §12: PII is scrubbed from analytics events by CONSTRUCTION. Refuses '
  'rather than cleans — a scrubber that silently repairs events teaches '
  'callers to keep sending PII.';

-- ---------------------------------------------------------------------
-- Rollup: what dashboards actually read.
-- ---------------------------------------------------------------------
CREATE TABLE product_event_rollups (
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  day        date NOT NULL,
  event_type text NOT NULL,
  n          integer NOT NULL,
  distinct_users integer NOT NULL,
  PRIMARY KEY (tenant_id, day, event_type)
);

COMMENT ON TABLE product_event_rollups IS
  'F-1503. Daily counts per tenant per event type. Recomputed for a '
  'sliding window by app.rollup_product_events(), so late offline arrivals '
  'still land in the right day.';

CREATE OR REPLACE FUNCTION app.rollup_product_events()
RETURNS TABLE (days_recomputed integer, raw_pruned integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, app
AS $$
DECLARE v_days integer; v_pruned integer;
BEGIN
  -- A seven-day window, recomputed whole. Offline events arrive days late
  -- (that is the product working, not failing), and recomputing the
  -- window is what puts them in the day they OCCURRED rather than the day
  -- they arrived.
  INSERT INTO product_event_rollups (tenant_id, day, event_type, n, distinct_users)
  SELECT e.tenant_id, e.occurred_at::date, e.event_type,
         count(*), count(DISTINCT e.user_id)
    FROM product_events e
   WHERE e.occurred_at >= CURRENT_DATE - 7
   GROUP BY 1, 2, 3
  ON CONFLICT (tenant_id, day, event_type)
  DO UPDATE SET n = EXCLUDED.n, distinct_users = EXCLUDED.distinct_users;
  GET DIAGNOSTICS v_days = ROW_COUNT;

  -- Retention: raw rows live 90 days, the rollup keeps the history. Stated
  -- here, where it happens, because "no silent truncation" applies to
  -- deletion policies too.
  DELETE FROM product_events WHERE occurred_at < CURRENT_DATE - 90;
  GET DIAGNOSTICS v_pruned = ROW_COUNT;

  RETURN QUERY SELECT v_days, v_pruned;
END $$;

REVOKE ALL ON FUNCTION app.rollup_product_events() FROM PUBLIC;
-- The maintenance cron runs as the owner; shikhon_app cannot prune.

-- ---------------------------------------------------------------------
-- Tenancy and RLS.
-- ---------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['product_events', 'product_event_rollups'] LOOP
    -- ENABLE, deliberately NOT FORCE — the one pair of tables in the
    -- schema where that is right. FORCE binds the OWNER too, and the
    -- rollup runs as the owner from the maintenance cron with no tenant
    -- GUC set: under FORCE it would aggregate zero rows and report
    -- success, in production, forever (the Neon owner is not superuser).
    -- shikhon_app — every request path — remains fully bound by RLS
    -- either way; owner access exists only inside the maintenance
    -- endpoint, which runs exactly the catalog-driven calls listed in
    -- its STEPS table.
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format($f$
      CREATE POLICY tenant_isolation ON %I
        AS PERMISSIVE FOR ALL TO shikhon_app
        USING (app.tenant_guard(tenant_id))
        WITH CHECK (app.tenant_guard(tenant_id))
    $f$, t);
    EXECUTE format('CREATE TRIGGER trg_%s_tenant BEFORE INSERT OR UPDATE ON %I
                    FOR EACH ROW EXECUTE FUNCTION app.enforce_tenant()',
                   left(t, 20), t);
  END LOOP;
END $$;

-- Anyone signed in may record what they did; only leadership reads the
-- aggregate; NOBODY updates or deletes. The absent-permissive-policy
-- route would not work here because tenant_isolation is FOR ALL, so the
-- denials are explicit restrictive policies.
CREATE POLICY events_read_scope ON product_events
  AS RESTRICTIVE FOR SELECT TO shikhon_app
  USING (app.has_role('principal', 'school_owner', 'academic_coordinator'));
CREATE POLICY events_no_update ON product_events
  AS RESTRICTIVE FOR UPDATE TO shikhon_app USING (false);
CREATE POLICY events_no_delete ON product_events
  AS RESTRICTIVE FOR DELETE TO shikhon_app USING (false);

CREATE POLICY rollup_read_scope ON product_event_rollups
  AS RESTRICTIVE FOR SELECT TO shikhon_app
  USING (app.has_role('principal', 'school_owner', 'academic_coordinator'));
CREATE POLICY rollup_no_write ON product_event_rollups
  AS RESTRICTIVE FOR INSERT TO shikhon_app WITH CHECK (false);
CREATE POLICY rollup_no_update ON product_event_rollups
  AS RESTRICTIVE FOR UPDATE TO shikhon_app USING (false);
CREATE POLICY rollup_no_delete ON product_event_rollups
  AS RESTRICTIVE FOR DELETE TO shikhon_app USING (false);

GRANT SELECT, INSERT ON product_events TO shikhon_app;
GRANT SELECT ON product_event_rollups TO shikhon_app;

COMMIT;
