-- ============================================================================
-- 046 — Go-live unlocks  (R-8, docs/11-MASTER-PLAN.md §R-8)
--
-- R-8 is described in the master plan as "contracts, credentials, and
-- switches — everything here is built and dark". That is true of the schema
-- and less true of the code: two of the things the phase is meant to switch on
-- had nothing behind them to switch.
--
-- ── 1. Delivery reports had a home and no door ─────────────────────────
-- `sms_outbox` has carried `delivered_at`, `error_code` and `cost_bdt` since
-- migration 001. Nothing has ever written them, because nothing has ever
-- received a delivery report. The product knew only that it had HANDED a
-- message to a provider, which is not the same as a parent receiving it — and
-- that difference is precisely what a school rings up to ask about.
--
-- The webhook cannot know which tenant a report belongs to: an aggregator
-- sends a message id and nothing else we can trust. So the row is found BY
-- that id and the tenant comes from the row, which needs a cross-tenant read
-- the runtime role rightly cannot do. `app.record_sms_delivery()` is SECURITY
-- DEFINER for exactly that, and updates only the four delivery columns — a
-- provider cannot change a message's body, its recipient, or which school it
-- belongs to.
--
-- ── 2. The AI budget was a table nobody read ───────────────────────────
-- `ai_budget_periods` has existed with `token_budget`, `tokens_used`,
-- `soft_limit_notified_at` and `hard_limit_hit_at` since migration 008, and
-- `tenants.ai_monthly_token_budget` since 001. Nothing in ai-svc references
-- either: it records `input_tokens`/`output_tokens` on `ai_turns` and never
-- looks at what a school is allowed to spend.
--
-- This is the same shape as `student_cap` in R-7 — a limit only the price list
-- knew about — and the master plan names it as the prerequisite for enabling
-- AI broadly, so R-8 is where it becomes real.
--
-- `app.consume_ai_budget()` reserves BEFORE the call and `app.settle_ai_budget()`
-- records what was actually spent after it. Reserving first is the point: a
-- check-then-call that only recorded usage afterwards would let a school
-- overshoot by however many requests are in flight, and an AI bill is the one
-- cost in this product that can run away between two cron ticks.
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- 1. app.record_sms_delivery — the aggregator's report, narrowly applied.
--
-- Returns true when a row was matched. A DLR for a message we have purged is
-- not an error the aggregator can fix, so the webhook answers 200 either way
-- and this tells it which happened.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.record_sms_delivery(
  p_provider_msg_id text,
  p_state           text,
  p_error_code      text DEFAULT NULL,
  p_cost_bdt        numeric DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, app
AS $$
DECLARE v_found integer;
BEGIN
  IF p_state NOT IN ('delivered', 'failed') THEN
    RAISE EXCEPTION 'state must be delivered or failed, got %', p_state
      USING ERRCODE = '22023';
  END IF;

  UPDATE sms_outbox
     SET status       = p_state,
         delivered_at = CASE WHEN p_state = 'delivered' THEN now() ELSE delivered_at END,
         error_code   = COALESCE(p_error_code, error_code),
         cost_bdt     = COALESCE(p_cost_bdt, cost_bdt)
   WHERE provider_msg_id = p_provider_msg_id
     -- Only a message we believe we SENT can be reported on. A report for a
     -- row still queued would mean our own state is wrong, and overwriting it
     -- would hide that rather than surface it.
     AND status IN ('sent', 'delivered', 'failed');

  GET DIAGNOSTICS v_found = ROW_COUNT;
  RETURN v_found > 0;
END;
$$;

COMMENT ON FUNCTION app.record_sms_delivery(text, text, text, numeric) IS
  'R-8: the SMS delivery-report webhook. SECURITY DEFINER because the caller '
  'is the aggregator and cannot name a tenant — the row is found by provider '
  'message id and the tenant comes from the row. Updates only the four '
  'delivery columns.';

-- The runtime role never calls this; the webhook runs on the shared pool, so
-- it is granted there and explicitly nowhere else.
REVOKE ALL ON FUNCTION app.record_sms_delivery(text, text, text, numeric) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.record_sms_delivery(text, text, text, numeric)
  TO shikhon_app;

-- ---------------------------------------------------------------------
-- 2. The AI budget, reserved before the call and settled after it.
--
-- Both run inside the tenant's own context under ordinary RLS — there is
-- nothing cross-tenant about a school's own budget, so neither is DEFINER.
--
-- The period row is created on first use with the school's configured budget,
-- so a tenant that has never called the AI does not need one seeded and a
-- tenant whose budget changes gets the new number next month rather than
-- retroactively.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.consume_ai_budget(
  p_estimated_tokens bigint DEFAULT 1000
)
RETURNS TABLE (allowed boolean, used bigint, budget bigint, remaining bigint)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, app
AS $$
DECLARE
  v_tenant uuid := app.current_tenant();
  v_month  date := date_trunc('month', CURRENT_DATE)::date;
  v_budget bigint;
  v_used   bigint;
BEGIN
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'tenant context not set (app.tenant_id)' USING ERRCODE = '42501';
  END IF;

  SELECT ai_monthly_token_budget INTO v_budget FROM tenants WHERE id = v_tenant;

  -- A NULL budget is "not configured", which means unmetered rather than
  -- zero. Defaulting an unset budget to zero would take the AI away from
  -- every school the day this migration landed.
  IF v_budget IS NULL THEN
    RETURN QUERY SELECT true, 0::bigint, NULL::bigint, NULL::bigint;
    RETURN;
  END IF;

  INSERT INTO ai_budget_periods (tenant_id, period_month, token_budget, tokens_used)
  VALUES (v_tenant, v_month, v_budget, 0)
  ON CONFLICT (tenant_id, period_month) DO NOTHING;

  SELECT tokens_used, token_budget INTO v_used, v_budget
    FROM ai_budget_periods
   WHERE tenant_id = v_tenant AND period_month = v_month
     FOR UPDATE;

  IF v_used + p_estimated_tokens > v_budget THEN
    UPDATE ai_budget_periods
       SET hard_limit_hit_at = COALESCE(hard_limit_hit_at, now())
     WHERE tenant_id = v_tenant AND period_month = v_month;
    RETURN QUERY SELECT false, v_used, v_budget, GREATEST(v_budget - v_used, 0)::bigint;
    RETURN;
  END IF;

  -- Reserve the estimate now. `settle_ai_budget` corrects it to the real
  -- figure once the provider answers; between the two calls the school is
  -- charged the estimate, which is what stops concurrent requests from each
  -- seeing the same headroom.
  UPDATE ai_budget_periods
     SET tokens_used = tokens_used + p_estimated_tokens,
         soft_limit_notified_at = CASE
           WHEN soft_limit_notified_at IS NULL
            AND tokens_used + p_estimated_tokens > (token_budget * 0.8)::bigint
           THEN now() ELSE soft_limit_notified_at END
   WHERE tenant_id = v_tenant AND period_month = v_month;

  RETURN QUERY SELECT true, v_used + p_estimated_tokens, v_budget,
                      GREATEST(v_budget - v_used - p_estimated_tokens, 0)::bigint;
END;
$$;

CREATE OR REPLACE FUNCTION app.settle_ai_budget(
  p_estimated_tokens bigint,
  p_actual_tokens    bigint,
  p_cost_usd         numeric DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, app
AS $$
DECLARE
  v_tenant uuid := app.current_tenant();
  v_month  date := date_trunc('month', CURRENT_DATE)::date;
BEGIN
  IF v_tenant IS NULL THEN RETURN; END IF;

  -- The delta, which may be negative when the estimate was generous. GREATEST
  -- keeps the counter from going below zero if a call is settled twice.
  UPDATE ai_budget_periods
     SET tokens_used = GREATEST(tokens_used - p_estimated_tokens + p_actual_tokens, 0),
         cost_usd    = COALESCE(cost_usd, 0) + COALESCE(p_cost_usd, 0)
   WHERE tenant_id = v_tenant AND period_month = v_month;
END;
$$;

COMMENT ON FUNCTION app.consume_ai_budget(bigint) IS
  'R-8: reserves tokens BEFORE the provider call. ai_budget_periods has '
  'existed since migration 008 and nothing had ever read it — the same shape '
  'as student_cap before R-7. A NULL tenants.ai_monthly_token_budget means '
  'unmetered, not zero.';

GRANT EXECUTE ON FUNCTION app.consume_ai_budget(bigint) TO shikhon_app;
GRANT EXECUTE ON FUNCTION app.settle_ai_budget(bigint, bigint, numeric) TO shikhon_app;

COMMIT;
