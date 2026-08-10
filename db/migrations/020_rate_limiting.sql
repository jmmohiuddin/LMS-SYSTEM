-- ============================================================================
-- 020 — Rate limiting  (F-102, TRD §11.2)
--
-- Token-bucket throughput limiting in Postgres. No new stateful service, per
-- TRD §3.2 — Redis was deliberately excluded from this stack and adding it
-- for rate limiting alone would reverse that decision for one feature.
--
-- ── Why this table is not tenant-scoped ──────────────────────────────────
-- Invariant: every *tenant-scoped* table carries tenant_id and an RLS policy.
-- This table is not tenant data — it is platform infrastructure keyed by IP
-- and by identity, and the most important buckets are consumed BEFORE any
-- tenant context exists (an unauthenticated OTP request is exactly the thing
-- being protected). It therefore cannot use SET LOCAL app.tenant_id.
--
-- Rather than weaken isolation, access is inverted: RLS is enabled with NO
-- policy for shikhon_app, so the application role can read exactly zero rows
-- directly. The only access path is app.rate_limit_consume(), a SECURITY
-- DEFINER function that can consume a token but cannot be used to enumerate
-- buckets. The app can spend, never read. Same technique migration 010
-- already uses for app.can_see_student().
-- ============================================================================
BEGIN;

CREATE TABLE rate_limit_buckets (
  bucket_key  text PRIMARY KEY,
  tokens      numeric(12,4) NOT NULL,
  updated_at  timestamptz   NOT NULL DEFAULT now()
);

-- Supports the pruning sweep only; the hot path is a PK lookup.
CREATE INDEX ix_rate_limit_stale ON rate_limit_buckets (updated_at);

-- Enabled, deliberately NOT forced: a forced policy would also apply to the
-- table owner and lock out the SECURITY DEFINER function below. With RLS
-- enabled and no policy, shikhon_app sees nothing; the owner-executed
-- function still works.
ALTER TABLE rate_limit_buckets ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE rate_limit_buckets IS
  'Platform infrastructure, not tenant data. Deliberately has no tenant_id and '
  'no RLS policy — shikhon_app cannot read it at all. Consumption goes through '
  'app.rate_limit_consume() only. See migration header for the reasoning.';

-- ---------------------------------------------------------------------
-- app.rate_limit_consume()
--
-- Takes a set of buckets, each with its own capacity and refill rate, and
-- consumes one token from EVERY bucket — but only if every bucket has one
-- to give. Two passes matter here: a request blocked by its IP bucket must
-- not also burn the caller's identity token, or a user behind a noisy NAT
-- gets punished twice for someone else's traffic.
--
-- p_buckets: [{"key": "...", "capacity": 300, "refill": 0.0833}, ...]
--   refill is tokens per second.
--
-- Returns one row: whether the request may proceed, how long to wait, and
-- which bucket refused (for logging — never returned to the client, since
-- it would reveal whether an identity exists).
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.rate_limit_consume(p_buckets jsonb)
RETURNS TABLE (allowed boolean, retry_after_sec integer, blocked_key text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, app
AS $$
DECLARE
  b            jsonb;
  v_key        text;
  v_capacity   numeric;
  v_refill     numeric;
  v_tokens     numeric;
  v_worst_wait numeric := 0;
  v_blocked    text := NULL;
BEGIN
  -- Pass 1 — refill every bucket to its current entitlement and check whether
  -- each could afford a token. Nothing is spent yet.
  FOR b IN SELECT * FROM jsonb_array_elements(p_buckets) LOOP
    v_key      := b->>'key';
    v_capacity := (b->>'capacity')::numeric;
    v_refill   := (b->>'refill')::numeric;

    INSERT INTO rate_limit_buckets (bucket_key, tokens, updated_at)
    VALUES (v_key, v_capacity, now())
    ON CONFLICT (bucket_key) DO UPDATE
      SET tokens = LEAST(
            v_capacity,
            rate_limit_buckets.tokens
              + EXTRACT(EPOCH FROM (now() - rate_limit_buckets.updated_at)) * v_refill
          ),
          updated_at = now()
    RETURNING rate_limit_buckets.tokens INTO v_tokens;

    IF v_tokens < 1 THEN
      -- Time until this bucket can afford one token.
      IF (1 - v_tokens) / NULLIF(v_refill, 0) > v_worst_wait THEN
        v_worst_wait := (1 - v_tokens) / NULLIF(v_refill, 0);
        v_blocked    := v_key;
      END IF;
    END IF;
  END LOOP;

  IF v_blocked IS NOT NULL THEN
    RETURN QUERY SELECT false, GREATEST(1, CEIL(v_worst_wait))::integer, v_blocked;
    RETURN;
  END IF;

  -- Pass 2 — every bucket can pay, so charge them all.
  FOR b IN SELECT * FROM jsonb_array_elements(p_buckets) LOOP
    UPDATE rate_limit_buckets
       SET tokens = tokens - 1
     WHERE bucket_key = b->>'key';
  END LOOP;

  RETURN QUERY SELECT true, 0, NULL::text;
END $$;

COMMENT ON FUNCTION app.rate_limit_consume IS
  'Two-pass token bucket: checks every bucket before spending from any, so a '
  'request blocked on one dimension does not burn quota on the others.';

REVOKE ALL ON FUNCTION app.rate_limit_consume(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.rate_limit_consume(jsonb) TO shikhon_app;

-- ---------------------------------------------------------------------
-- Pruning. A bucket that has sat untouched for longer than any refill
-- window is indistinguishable from a fresh one, so it can be dropped. Not
-- doing this would leave an unbounded table keyed by every IP ever seen.
-- Wired into the nightly maintenance run (ops-svc).
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.prune_rate_limit_buckets(p_older_than interval DEFAULT interval '2 days')
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, app
AS $$
DECLARE n integer;
BEGIN
  DELETE FROM rate_limit_buckets WHERE updated_at < now() - p_older_than;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;

REVOKE ALL ON FUNCTION app.prune_rate_limit_buckets(interval) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.prune_rate_limit_buckets(interval) TO shikhon_app;

COMMIT;
