-- ============================================================================
-- 016 — Ledger chart-of-accounts seed and auto-posting.
--
-- Closes PRD §4 "automated ledger reconciliation": the finance-svc webhook
-- processor writes payment_receipts and balanced ledger_entries on every
-- completed MFS callback (see services/finance-svc/src/webhook.ts), but a
-- ledger insert needs a chart of accounts. Migration 007 shipped the tables
-- without seed data; this migration seeds every existing tenant AND wires
-- provision_tenant() so future tenants get it too.
--
-- Chart is deliberately minimal — the smallest set that yields correct P&L
-- for the incoming-payment case, and matches fee_heads.gl_account. Deeper
-- accounting (AR-STUDENT per-student subledger, per-fee-head split income,
-- etc.) is out of scope; this is what the PRD asks for.
-- ============================================================================
BEGIN;

CREATE OR REPLACE FUNCTION app.seed_chart_of_accounts(p_tenant uuid)
RETURNS integer
LANGUAGE plpgsql AS $$
DECLARE
  n integer := 0;
BEGIN
  IF app.current_tenant() IS DISTINCT FROM p_tenant THEN
    RAISE EXCEPTION 'seed_chart_of_accounts must run inside the tenant''s own context'
      USING ERRCODE = '42501';
  END IF;

  -- Six accounts is enough to book any completed MFS payment as a balanced
  -- entry. Codes are matched by services/finance-svc/src/webhook.ts.
  INSERT INTO ledger_accounts (tenant_id, code, name_bn, type) VALUES
    (p_tenant, 'MFS-BKASH',  'bKash সংগ্রহ',           'asset'),
    (p_tenant, 'MFS-NAGAD',  'Nagad সংগ্রহ',           'asset'),
    (p_tenant, 'MFS-ROCKET', 'Rocket সংগ্রহ',          'asset'),
    (p_tenant, 'MFS-UPAY',   'Upay সংগ্রহ',            'asset'),
    (p_tenant, 'CASH',       'নগদ',                    'asset'),
    (p_tenant, 'FEE-INCOME', 'বেতন ও ফি আয়',           'income')
  ON CONFLICT (tenant_id, code) DO NOTHING;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;

COMMENT ON FUNCTION app.seed_chart_of_accounts IS
  'Seeds the minimum chart of accounts the auto-posting webhook needs. '
  'Idempotent (ON CONFLICT DO NOTHING); safe to re-run.';

-- ── Extend provision_tenant() so newly-created tenants get the chart too.
-- Non-invasive: only inserts what does not exist; existing provisioning
-- output is unchanged for tenants that already have their chart.
CREATE OR REPLACE FUNCTION app.provision_chart_step(p_tenant uuid)
RETURNS TABLE (created_object text, qty integer)
LANGUAGE plpgsql AS $$
DECLARE
  n integer;
BEGIN
  n := app.seed_chart_of_accounts(p_tenant);
  created_object := 'ledger_accounts';
  qty := n;
  RETURN NEXT;
END $$;

-- Backfill every existing tenant. RLS demands we enter each tenant's own
-- context, so loop with SET LOCAL rather than one blanket INSERT SELECT.
DO $$
DECLARE
  t RECORD;
  seeded integer;
BEGIN
  FOR t IN SELECT id FROM tenants ORDER BY id LOOP
    PERFORM set_config('app.tenant_id', t.id::text, true);
    PERFORM set_config('app.role', 'super_admin', true);
    seeded := app.seed_chart_of_accounts(t.id);
    RAISE NOTICE 'tenant %: seeded % ledger accounts', t.id, seeded;
  END LOOP;
END $$;

COMMIT;
