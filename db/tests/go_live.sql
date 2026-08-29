-- =====================================================================
-- db/tests/go_live.sql   (R-8 — the go-live unlocks, migration 046)
--
-- R-8 turns on two things the schema has carried since the beginning and
-- nothing has ever used: the delivery columns on `sms_outbox`, and the AI
-- budget in `ai_budget_periods`. Both are now written by SQL functions, and
-- both functions are reachable by parties we do not fully control — an SMS
-- aggregator on one side, a school's own AI usage on the other.
--
-- So the assertions here are mostly about NARROWNESS:
--
--   1. A DELIVERY REPORT CANNOT REWRITE A MESSAGE. `record_sms_delivery` is
--      SECURITY DEFINER, which means it runs above RLS and an aggregator's
--      webhook reaches it. It must therefore be incapable of changing a
--      message's body, its recipient, or which school it belongs to — and
--      of touching a message we never sent.
--
--   2. A BUDGET IS RESERVED BEFORE THE CALL, NOT AFTER. Anything that only
--      recorded usage afterwards would let a school overshoot by however
--      many requests are in flight. A refused call must also cost nothing.
--
--   3. NULL BUDGET MEANS UNMETERED, NOT ZERO. Reading it the other way would
--      have taken the AI away from every school on the day 046 landed.
--
--   4. THE RUNTIME ROLE CANNOT ESCAPE THROUGH EITHER. `consume_ai_budget` is
--      deliberately INVOKER — a school's own budget is not a cross-tenant
--      concern, and making it DEFINER would have handed one school a lever
--      on another's counter.
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/tests/go_live.sql
-- =====================================================================

\set ON_ERROR_STOP on

GRANT shikhon_app TO CURRENT_USER;

\set A '''8c800000-0000-4000-8000-00000000000a'''
\set B '''8c800000-0000-4000-8000-00000000000b'''

-- Pre-clean, so the suite is re-runnable.
DELETE FROM sms_outbox WHERE tenant_id IN (:A, :B);
DELETE FROM ai_budget_periods WHERE tenant_id IN (:A, :B);
DELETE FROM tenants WHERE id IN (:A, :B);

INSERT INTO tenants (id, slug, name_bn, name_en, stream, level,
                     ai_monthly_token_budget)
VALUES (:A, 'r8-alpha', 'আলফা', 'Alpha', 'bangla_medium', 'secondary', 10000),
       (:B, 'r8-beta',  'বিটা',  'Beta',  'bangla_medium', 'secondary', 10000);

-- Two messages in two different schools, both believed SENT, both carrying a
-- provider message id. This is the state the aggregator reports against.
INSERT INTO sms_outbox (tenant_id, msisdn, template_code, body, dedupe_key,
                        status, provider, provider_msg_id, sent_at, attempts)
VALUES (:A, '8801711000001', 'attendance.absent.v2', 'আলফার বার্তা', 'r8-a-1',
        'sent', 'ssl_wireless', 'r8-msg-alpha', now(), 1),
       (:B, '8801711000002', 'attendance.absent.v2', 'বিটার বার্তা', 'r8-b-1',
        'sent', 'ssl_wireless', 'r8-msg-beta', now(), 1);

-- A third that was never handed to a provider.
INSERT INTO sms_outbox (tenant_id, msisdn, template_code, body, dedupe_key,
                        status, provider_msg_id)
VALUES (:A, '8801711000003', 'attendance.absent.v2', 'অপেক্ষমাণ', 'r8-a-2',
        'queued', 'r8-msg-queued');

-- =====================================================================
-- 1. A DELIVERY REPORT WRITES THE FOUR DELIVERY COLUMNS AND NOTHING ELSE.
--
--    `delivered_at` has been NULL on every row this product has ever sent.
--    This is the assertion that it stops being so.
-- =====================================================================
DO $$
DECLARE
  v_before  record;
  v_after   record;
  v_matched boolean;
BEGIN
  SELECT tenant_id, msisdn, body, template_code, recipient_id, dedupe_key, sent_at
    INTO v_before FROM sms_outbox WHERE provider_msg_id = 'r8-msg-alpha';

  SELECT app.record_sms_delivery('r8-msg-alpha', 'delivered', NULL, 0.3500)
    INTO v_matched;
  IF NOT v_matched THEN
    RAISE EXCEPTION 'FAIL: a delivery report for a sent message matched nothing';
  END IF;

  SELECT tenant_id, msisdn, body, template_code, recipient_id, dedupe_key, sent_at,
         status, delivered_at, cost_bdt, error_code
    INTO v_after FROM sms_outbox WHERE provider_msg_id = 'r8-msg-alpha';

  IF v_after.status <> 'delivered' THEN
    RAISE EXCEPTION 'FAIL: status is % after a delivered report', v_after.status;
  END IF;
  IF v_after.delivered_at IS NULL THEN
    RAISE EXCEPTION 'FAIL: delivered_at was not written';
  END IF;
  IF v_after.cost_bdt <> 0.3500 THEN
    RAISE EXCEPTION 'FAIL: cost_bdt is % not 0.3500', v_after.cost_bdt;
  END IF;

  -- The narrowness assertion. An aggregator holding the webhook secret must
  -- not be able to move a message to another school or rewrite what it said.
  IF v_after.tenant_id <> v_before.tenant_id
     OR v_after.msisdn <> v_before.msisdn
     OR v_after.body <> v_before.body
     OR v_after.template_code <> v_before.template_code
     OR v_after.dedupe_key <> v_before.dedupe_key
     OR v_after.sent_at <> v_before.sent_at
     OR v_after.recipient_id IS DISTINCT FROM v_before.recipient_id THEN
    RAISE EXCEPTION 'FAIL: record_sms_delivery changed a column outside the four delivery fields';
  END IF;

  RAISE NOTICE 'PASS a delivery report writes delivered_at and cost, and nothing else';
END $$;

-- =====================================================================
-- 2. A REPORT FOR A MESSAGE WE NEVER SENT IS REFUSED.
--
--    If a report arrives for a row still queued, OUR state is wrong.
--    Accepting it would paper over that instead of leaving it visible.
-- =====================================================================
DO $$
DECLARE v_matched boolean; v_status text;
BEGIN
  SELECT app.record_sms_delivery('r8-msg-queued', 'delivered') INTO v_matched;
  IF v_matched THEN
    RAISE EXCEPTION 'FAIL: a queued message accepted a delivery report';
  END IF;

  SELECT status INTO v_status FROM sms_outbox WHERE provider_msg_id = 'r8-msg-queued';
  IF v_status <> 'queued' THEN
    RAISE EXCEPTION 'FAIL: a queued message became % from a delivery report', v_status;
  END IF;
  RAISE NOTICE 'PASS a message that was never sent cannot be reported delivered';
END $$;

-- =====================================================================
-- 3. AN UNKNOWN MESSAGE ID IS FALSE, NOT AN ERROR.
--
--    The webhook answers 200 either way — a DLR for a row we have purged is
--    nothing the aggregator can fix, and a 4xx would put us in its retry
--    queue forever. So this must return, not raise.
-- =====================================================================
DO $$
DECLARE v_matched boolean;
BEGIN
  SELECT app.record_sms_delivery('r8-msg-does-not-exist', 'delivered') INTO v_matched;
  IF v_matched THEN
    RAISE EXCEPTION 'FAIL: an unknown message id reported a match';
  END IF;
  RAISE NOTICE 'PASS an unknown message id returns false rather than raising';
END $$;

-- =====================================================================
-- 4. ONLY 'delivered' AND 'failed' ARE STATES A PROVIDER MAY SET.
--
--    Not 'queued', not 'suppressed', not 'sending'. The provider reports an
--    outcome; it does not drive our dispatcher.
-- =====================================================================
DO $$
DECLARE s text;
BEGIN
  FOREACH s IN ARRAY ARRAY['queued', 'sending', 'suppressed', 'sent', 'nonsense'] LOOP
    BEGIN
      PERFORM app.record_sms_delivery('r8-msg-beta', s);
      RAISE EXCEPTION 'FAIL: a provider set status to %', s;
    EXCEPTION WHEN invalid_parameter_value THEN
      NULL;  -- expected
    END;
  END LOOP;
  RAISE NOTICE 'PASS a provider may report only delivered or failed';
END $$;

-- A failure report records the reason and does NOT stamp delivered_at.
DO $$
DECLARE v_row record;
BEGIN
  PERFORM app.record_sms_delivery('r8-msg-beta', 'failed', 'INVALID_NUMBER');
  SELECT status, error_code, delivered_at INTO v_row
    FROM sms_outbox WHERE provider_msg_id = 'r8-msg-beta';
  IF v_row.status <> 'failed' OR v_row.error_code <> 'INVALID_NUMBER' THEN
    RAISE EXCEPTION 'FAIL: a failure report recorded % / %', v_row.status, v_row.error_code;
  END IF;
  IF v_row.delivered_at IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL: a FAILED message has a delivered_at timestamp';
  END IF;
  RAISE NOTICE 'PASS a failure records its reason and stamps no delivery time';
END $$;

-- =====================================================================
-- 5. THE AI BUDGET IS RESERVED BEFORE THE CALL, AND A REFUSAL COSTS NOTHING.
--
--    Alpha is given a 10,000-token budget above. The sequence below is the
--    one that matters commercially: spend most of it, trip the soft limit,
--    then be refused — and verify the refused call was not charged.
-- =====================================================================
-- SET LOCAL only survives inside a transaction, and psql is in autocommit —
-- outside a BEGIN the tenant context is gone before the DO block reads it.
BEGIN;
SET LOCAL app.tenant_id = '8c800000-0000-4000-8000-00000000000a';
SET LOCAL app.role      = 'principal';
SET ROLE shikhon_app;

DO $$
DECLARE r record; v_soft timestamptz; v_hard timestamptz; v_used bigint;
BEGIN
  -- 8,500 of 10,000 — past the 80% soft limit, inside the hard one.
  SELECT * INTO r FROM app.consume_ai_budget(8500);
  IF NOT r.allowed THEN RAISE EXCEPTION 'FAIL: 8500 of a 10000 budget was refused'; END IF;
  IF r.used <> 8500 OR r.budget <> 10000 OR r.remaining <> 1500 THEN
    RAISE EXCEPTION 'FAIL: reserved %/% leaving %', r.used, r.budget, r.remaining;
  END IF;

  SELECT soft_limit_notified_at INTO v_soft FROM ai_budget_periods
   WHERE tenant_id = app.current_tenant()
     AND period_month = date_trunc('month', CURRENT_DATE)::date;
  IF v_soft IS NULL THEN
    RAISE EXCEPTION 'FAIL: crossing 80%% did not stamp the soft limit';
  END IF;

  -- The next call does not fit. It must be refused AND not charged: a school
  -- that is over its budget should not keep accruing tokens for calls that
  -- never reached a provider.
  SELECT * INTO r FROM app.consume_ai_budget(5000);
  IF r.allowed THEN RAISE EXCEPTION 'FAIL: a call past the budget was allowed'; END IF;

  SELECT tokens_used, hard_limit_hit_at INTO v_used, v_hard FROM ai_budget_periods
   WHERE tenant_id = app.current_tenant()
     AND period_month = date_trunc('month', CURRENT_DATE)::date;
  IF v_used <> 8500 THEN
    RAISE EXCEPTION 'FAIL: a REFUSED call was charged — tokens_used is %', v_used;
  END IF;
  IF v_hard IS NULL THEN
    RAISE EXCEPTION 'FAIL: the hard limit was hit and not stamped';
  END IF;

  RAISE NOTICE 'PASS the budget reserves before the call, trips at 80%%, and refuses without charging';
END $$;

-- Settling corrects the reservation to what was actually spent.
DO $$
DECLARE v_used bigint; v_cost numeric;
BEGIN
  -- Estimated 8500, actually used 3000. The school gets the difference back.
  PERFORM app.settle_ai_budget(8500, 3000, 0.0420);
  SELECT tokens_used, cost_usd INTO v_used, v_cost FROM ai_budget_periods
   WHERE tenant_id = app.current_tenant()
     AND period_month = date_trunc('month', CURRENT_DATE)::date;
  IF v_used <> 3000 THEN
    RAISE EXCEPTION 'FAIL: settling 8500→3000 left tokens_used at %', v_used;
  END IF;
  IF v_cost IS DISTINCT FROM 0.0420 THEN
    RAISE EXCEPTION 'FAIL: cost_usd is % not 0.0420', v_cost;
  END IF;

  -- And a call that overran its estimate is charged the real figure.
  PERFORM * FROM app.consume_ai_budget(1000);
  PERFORM app.settle_ai_budget(1000, 2500, NULL);
  SELECT tokens_used INTO v_used FROM ai_budget_periods
   WHERE tenant_id = app.current_tenant()
     AND period_month = date_trunc('month', CURRENT_DATE)::date;
  IF v_used <> 5500 THEN
    RAISE EXCEPTION 'FAIL: an over-run settled to % rather than 5500', v_used;
  END IF;
  RAISE NOTICE 'PASS settling corrects the reservation in both directions';
END $$;
RESET ROLE;
COMMIT;

-- =====================================================================
-- 6. WITHOUT TENANT CONTEXT THERE IS NO BUDGET TO SPEND.
--
--    §24 of R-8: never trust a tenant from the caller. This function takes
--    no tenant argument at all — it reads the session's, and refuses without
--    one. Deliberately run with NO transaction context set.
-- =====================================================================
BEGIN;
SET LOCAL app.tenant_id = '';
SET LOCAL app.role      = 'principal';
SET ROLE shikhon_app;
DO $$
BEGIN
  BEGIN
    PERFORM * FROM app.consume_ai_budget(100);
    RAISE EXCEPTION 'FAIL: the AI budget was consumed with no tenant in context';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'PASS no tenant context, no budget';
  END;
END $$;
RESET ROLE;
COMMIT;

-- =====================================================================
-- 7. ONE SCHOOL'S SPENDING DOES NOT TOUCH ANOTHER'S.
--
--    Beta has spent nothing. After everything Alpha did above, Beta's budget
--    must still be whole — and Alpha must not be able to see or move it.
-- =====================================================================
BEGIN;
SET LOCAL app.tenant_id = '8c800000-0000-4000-8000-00000000000b';
SET LOCAL app.role      = 'principal';
SET ROLE shikhon_app;

DO $$
DECLARE r record; n integer;
BEGIN
  SELECT * INTO r FROM app.consume_ai_budget(100);
  IF NOT r.allowed OR r.used <> 100 OR r.remaining <> 9900 THEN
    RAISE EXCEPTION 'FAIL: beta''s first call saw %/% — alpha''s spending leaked',
      r.used, r.budget;
  END IF;

  -- And beta cannot read alpha's period row at all.
  SELECT count(*) INTO n FROM ai_budget_periods
   WHERE tenant_id = '8c800000-0000-4000-8000-00000000000a';
  IF n <> 0 THEN
    RAISE EXCEPTION 'FAIL: beta can see % of alpha''s budget rows', n;
  END IF;
  RAISE NOTICE 'PASS budgets are per-school and invisible across the boundary';
END $$;
RESET ROLE;
COMMIT;

-- =====================================================================
-- 8. NO SCHOOL CAN END UP METERED AT ZERO BY ACCIDENT.
--
--    `consume_ai_budget` treats a NULL budget as unmetered rather than as a
--    budget of zero, because reading it the other way would have taken the
--    AI away from every school the moment 046 was applied.
--
--    That branch is defence in depth and not currently reachable: the column
--    is NOT NULL with a real default. THAT is the property worth pinning,
--    because it is the one that could actually change — a migration that
--    made the column nullable, or dropped the default, would silently start
--    creating schools with no AI at all. If this assertion ever fails, the
--    NULL branch in the function is what keeps the failure benign.
-- =====================================================================
RESET ROLE;
DO $$
DECLARE v_notnull boolean; v_default text; v_fresh bigint;
BEGIN
  SELECT a.attnotnull, pg_get_expr(d.adbin, d.adrelid)
    INTO v_notnull, v_default
    FROM pg_attribute a
    LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
   WHERE a.attrelid = 'tenants'::regclass AND a.attname = 'ai_monthly_token_budget';

  IF NOT v_notnull THEN
    RAISE WARNING 'ai_monthly_token_budget is now nullable — the unmetered '
                  'branch of consume_ai_budget is live and should be tested directly';
  END IF;
  IF v_default IS NULL OR v_default = '0' THEN
    RAISE EXCEPTION 'FAIL: a newly created school would have no AI budget (default %)',
      coalesce(v_default, 'none');
  END IF;

  -- And confirm it end to end: a school created without naming a budget gets
  -- a usable one, not zero.
  INSERT INTO tenants (id, slug, name_bn, name_en, stream, level)
  VALUES ('8c800000-0000-4000-8000-00000000000c', 'r8-fresh', 'নতুন', 'Fresh',
          'bangla_medium', 'secondary');
  SELECT ai_monthly_token_budget INTO v_fresh FROM tenants
   WHERE id = '8c800000-0000-4000-8000-00000000000c';
  IF v_fresh IS NULL OR v_fresh <= 0 THEN
    RAISE EXCEPTION 'FAIL: a fresh school''s AI budget is %', v_fresh;
  END IF;
  DELETE FROM tenants WHERE id = '8c800000-0000-4000-8000-00000000000c';

  RAISE NOTICE 'PASS a school is never created metered at zero (default %)', v_default;
END $$;

-- =====================================================================
-- 9. THE FUNCTIONS ARE GRANTED WHERE THEY MUST BE, AND NOT TO PUBLIC.
-- =====================================================================
RESET ROLE;
DO $$
DECLARE v_public boolean; v_app boolean; v_definer text;
BEGIN
  SELECT has_function_privilege('public', 'app.record_sms_delivery(text,text,text,numeric)', 'EXECUTE')
    INTO v_public;
  IF v_public THEN
    RAISE EXCEPTION 'FAIL: record_sms_delivery is executable by PUBLIC';
  END IF;

  SELECT has_function_privilege('shikhon_app', 'app.record_sms_delivery(text,text,text,numeric)', 'EXECUTE')
    INTO v_app;
  IF NOT v_app THEN
    RAISE EXCEPTION 'FAIL: the runtime role cannot run the DLR function, so the webhook is dead';
  END IF;

  -- consume_ai_budget must stay INVOKER. As DEFINER it would run above RLS
  -- and a bug in ai-svc could spend another school's budget.
  SELECT CASE WHEN p.prosecdef THEN 'definer' ELSE 'invoker' END INTO v_definer
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'app' AND p.proname = 'consume_ai_budget';
  IF v_definer <> 'invoker' THEN
    RAISE EXCEPTION 'FAIL: consume_ai_budget is SECURITY DEFINER — it would run above RLS';
  END IF;
  RAISE NOTICE 'PASS grants are narrow and the budget function is still INVOKER';
END $$;

-- ---------------------------------------------------------------------
-- Teardown — re-runnable, leaving nothing.
-- ---------------------------------------------------------------------
RESET ROLE;
DELETE FROM sms_outbox WHERE tenant_id IN (:A, :B);
DELETE FROM ai_budget_periods WHERE tenant_id IN (:A, :B);
DELETE FROM tenants WHERE id IN (:A, :B);

DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM tenants
   WHERE slug IN ('r8-alpha', 'r8-beta');
  IF n <> 0 THEN RAISE EXCEPTION 'FAIL: teardown left % tenant row(s)', n; END IF;
  RAISE NOTICE 'PASS teardown — no fixture rows remain';
END $$;

SELECT 'R-8: delivery reports are narrow, and the AI budget is reserved before it is spent.' AS result;
