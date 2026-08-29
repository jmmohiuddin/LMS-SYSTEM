-- Rollback for 046 — the go-live unlocks (R-8).
--
-- Loses no data at all. 046 added three functions and not one column, so
-- everything they wrote stays: a message reported delivered keeps its
-- `delivered_at` and its `cost_bdt`, and every `ai_budget_periods` row keeps
-- its counters. This drops the ability to write more of them.
--
-- What it takes away, and both are worth knowing before running it:
--
--   1. DELIVERY REPORTS STOP BEING RECORDED. `POST /api/v1/sms/dlr` answers
--      500 once the function is gone, so an aggregator's webhook will retry
--      and eventually give up. The product returns to knowing only that it
--      HANDED a message to a provider — the state it was in from migration
--      001 until R-8. Setting `SMS_DLR_SECRET` empty first makes the endpoint
--      answer a clean 503 instead, which is the courteous way to do this.
--
--   2. THE AI BUDGET STOPS BEING ENFORCED. `ai_budget_periods` keeps its
--      rows and nothing reads them, which is exactly the state migration 008
--      left it in. ai-svc's `reserveBudget()` treats a missing function as
--      fatal rather than as permission, so AI requests fail rather than
--      running uncapped — deliberately, because an unmetered AI bill is the
--      one cost in this product that can run away between two cron ticks.
--
-- The go-live switches themselves are environment variables and are not
-- touched by any migration; turning the product back off is done by unsetting
-- them, not by running this file.

DROP FUNCTION IF EXISTS app.settle_ai_budget(bigint, bigint, numeric);
DROP FUNCTION IF EXISTS app.consume_ai_budget(bigint);
DROP FUNCTION IF EXISTS app.record_sms_delivery(text, text, text, numeric);
