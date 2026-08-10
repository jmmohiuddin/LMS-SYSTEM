-- =====================================================================
-- db/tests/ledger.sql   (F-106)
--
-- The double-entry ledger shipped with no tests. It is the one part of
-- this system where a silent error is a financial one: an unbalanced
-- batch means the school's books do not add up, and nobody notices until
-- an accountant tries to reconcile a month of fee collection.
--
-- The guarantee being asserted is that the database will not hold an
-- unbalanced batch — enforced by a DEFERRABLE constraint trigger, so a
-- batch may be *built* one row at a time and is only checked at COMMIT.
-- That deferral is the whole design: a non-deferred check would reject
-- the first leg of every legitimate two-leg entry.
--
-- Also covers the read side (/api/v1/finance/ledger) and the role gate:
-- balances by account type, and the fact that a teacher cannot read the
-- ledger at all.
--
-- Runs in transactions that are ROLLED BACK; safe against any environment.
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/tests/ledger.sql
-- =====================================================================

\set ON_ERROR_STOP on

GRANT shikhon_app TO CURRENT_USER;
SET ROLE shikhon_app;

\set tL '''9d000000-0000-4000-8000-00000000000d'''

BEGIN;
SET LOCAL app.tenant_id = '9d000000-0000-4000-8000-00000000000d';
SET LOCAL app.role      = 'accountant';
SET LOCAL app.user_id   = '9d000000-0000-4000-8000-0000000000ac';

INSERT INTO tenants (id, slug, name_bn, name_en, stream, level)
VALUES (:tL, 'ledger-check', 'হিসাব বিদ্যালয়', 'Ledger School', 'bangla_medium', 'secondary');

SELECT app.seed_chart_of_accounts(:tL::uuid);

-- ---------------------------------------------------------------------
-- 1. The chart of accounts is seeded, and fee income is an income account.
--    The ledger read path derives balance direction from account type, so
--    a mis-typed account silently inverts a school's reported income.
-- ---------------------------------------------------------------------
DO $$
DECLARE n integer; t text;
BEGIN
  SELECT count(*) INTO n FROM ledger_accounts;
  IF n < 6 THEN RAISE EXCEPTION 'FAIL 1: expected the full chart of accounts, got %', n; END IF;
  SELECT type::text INTO t FROM ledger_accounts WHERE code = 'FEE-INCOME';
  IF t <> 'income' THEN RAISE EXCEPTION 'FAIL 1: FEE-INCOME is typed %, not income', t; END IF;
  SELECT type::text INTO t FROM ledger_accounts WHERE code = 'MFS-BKASH';
  IF t <> 'asset' THEN RAISE EXCEPTION 'FAIL 1: MFS-BKASH is typed %, not asset', t; END IF;
  RAISE NOTICE 'PASS 1 — chart of accounts seeded with the right account types';
END $$;

-- ---------------------------------------------------------------------
-- 2. A balanced two-leg batch commits.
--
--    A ৳500 bKash fee collection: debit the bKash asset, credit fee
--    income. This is the shape every payment produces.
-- ---------------------------------------------------------------------
DO $$
DECLARE v_batch uuid := gen_random_uuid(); n integer;
BEGIN
  INSERT INTO ledger_entries (tenant_id, batch_id, entry_date, account_id, debit, credit, memo)
  SELECT app.current_tenant(), v_batch, CURRENT_DATE, a.id, 500, 0, 'ফি সংগ্রহ'
    FROM ledger_accounts a WHERE a.code = 'MFS-BKASH';
  INSERT INTO ledger_entries (tenant_id, batch_id, entry_date, account_id, debit, credit, memo)
  SELECT app.current_tenant(), v_batch, CURRENT_DATE, a.id, 0, 500, 'ফি সংগ্রহ'
    FROM ledger_accounts a WHERE a.code = 'FEE-INCOME';

  -- Forces the DEFERRED constraint trigger to run now rather than at
  -- COMMIT, which is what lets a single test assert on it.
  SET CONSTRAINTS trg_ledger_balanced IMMEDIATE;
  SET CONSTRAINTS trg_ledger_balanced DEFERRED;

  SELECT count(*) INTO n FROM ledger_entries WHERE batch_id = v_batch;
  IF n <> 2 THEN RAISE EXCEPTION 'FAIL 2: expected 2 legs, got %', n; END IF;
  RAISE NOTICE 'PASS 2 — a balanced debit/credit pair commits';
END $$;

-- ---------------------------------------------------------------------
-- 3. THE ONE THAT MATTERS. A batch that does not balance cannot commit.
--
--    ৳500 in, ৳400 out. Under a naive implementation this simply sits in
--    the table and the school's books are ৳100 wrong forever.
-- ---------------------------------------------------------------------
DO $$
DECLARE v_batch uuid := gen_random_uuid();
BEGIN
  BEGIN
    INSERT INTO ledger_entries (tenant_id, batch_id, entry_date, account_id, debit, credit, memo)
    SELECT app.current_tenant(), v_batch, CURRENT_DATE, a.id, 500, 0, 'ভুল'
      FROM ledger_accounts a WHERE a.code = 'MFS-BKASH';
    INSERT INTO ledger_entries (tenant_id, batch_id, entry_date, account_id, debit, credit, memo)
    SELECT app.current_tenant(), v_batch, CURRENT_DATE, a.id, 0, 400, 'ভুল'
      FROM ledger_accounts a WHERE a.code = 'FEE-INCOME';

    SET CONSTRAINTS trg_ledger_balanced IMMEDIATE;
    RAISE EXCEPTION 'FAIL 3: an unbalanced batch was accepted';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'PASS 3 — an unbalanced batch is refused at check time';
  END;
END $$;

ROLLBACK;

-- Assertion 3 aborted the transaction, so the fixture is rebuilt for the
-- remaining checks rather than carried across a failed subtransaction.
BEGIN;
SET LOCAL app.tenant_id = '9d000000-0000-4000-8000-00000000000d';
SET LOCAL app.role      = 'accountant';
SET LOCAL app.user_id   = '9d000000-0000-4000-8000-0000000000ac';

INSERT INTO tenants (id, slug, name_bn, name_en, stream, level)
VALUES (:tL, 'ledger-check', 'হিসাব বিদ্যালয়', 'Ledger School', 'bangla_medium', 'secondary');
SELECT app.seed_chart_of_accounts(:tL::uuid);

-- ---------------------------------------------------------------------
-- 4. A single dangling leg cannot commit either.
--
--    The realistic bug is not a typo in the amount — it is a crash between
--    the two INSERTs. One leg with no counterpart must be as impossible as
--    two legs that disagree.
-- ---------------------------------------------------------------------
DO $$
DECLARE v_batch uuid := gen_random_uuid();
BEGIN
  BEGIN
    INSERT INTO ledger_entries (tenant_id, batch_id, entry_date, account_id, debit, credit, memo)
    SELECT app.current_tenant(), v_batch, CURRENT_DATE, a.id, 250, 0, 'অসম্পূর্ণ'
      FROM ledger_accounts a WHERE a.code = 'CASH';
    SET CONSTRAINTS trg_ledger_balanced IMMEDIATE;
    RAISE EXCEPTION 'FAIL 4: a single dangling leg was accepted';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'PASS 4 — a half-written batch cannot survive';
  END;
END $$;

ROLLBACK;

BEGIN;
SET LOCAL app.tenant_id = '9d000000-0000-4000-8000-00000000000d';
SET LOCAL app.role      = 'accountant';
SET LOCAL app.user_id   = '9d000000-0000-4000-8000-0000000000ac';

INSERT INTO tenants (id, slug, name_bn, name_en, stream, level)
VALUES (:tL, 'ledger-check', 'হিসাব বিদ্যালয়', 'Ledger School', 'bangla_medium', 'secondary');
SELECT app.seed_chart_of_accounts(:tL::uuid);

-- ---------------------------------------------------------------------
-- 5. A multi-leg batch balances in aggregate, not pairwise.
--
--    One ৳1000 payment split across two income lines (tuition + exam fee)
--    is three legs. A pairwise check would reject it; the sum check must
--    not.
-- ---------------------------------------------------------------------
DO $$
DECLARE v_batch uuid := gen_random_uuid(); v_diff numeric;
BEGIN
  INSERT INTO ledger_entries (tenant_id, batch_id, entry_date, account_id, debit, credit, memo)
  SELECT app.current_tenant(), v_batch, CURRENT_DATE, a.id, 1000, 0, 'মিশ্র'
    FROM ledger_accounts a WHERE a.code = 'MFS-NAGAD';
  INSERT INTO ledger_entries (tenant_id, batch_id, entry_date, account_id, debit, credit, memo)
  SELECT app.current_tenant(), v_batch, CURRENT_DATE, a.id, 0, 700, 'বেতন'
    FROM ledger_accounts a WHERE a.code = 'FEE-INCOME';
  INSERT INTO ledger_entries (tenant_id, batch_id, entry_date, account_id, debit, credit, memo)
  SELECT app.current_tenant(), v_batch, CURRENT_DATE, a.id, 0, 300, 'পরীক্ষা ফি'
    FROM ledger_accounts a WHERE a.code = 'FEE-INCOME';

  SET CONSTRAINTS trg_ledger_balanced IMMEDIATE;
  SET CONSTRAINTS trg_ledger_balanced DEFERRED;

  SELECT sum(debit) - sum(credit) INTO v_diff FROM ledger_entries WHERE batch_id = v_batch;
  IF v_diff <> 0 THEN RAISE EXCEPTION 'FAIL 5: three-leg batch is off by %', v_diff; END IF;
  RAISE NOTICE 'PASS 5 — a three-leg batch balances in aggregate';
END $$;

-- ---------------------------------------------------------------------
-- 6. The read side: income nets credit, assets net debit.
--
--    This is the arithmetic /api/v1/finance/ledger performs. Getting the
--    sign wrong on income would show a school its fee revenue as negative.
-- ---------------------------------------------------------------------
DO $$
DECLARE v_income numeric; v_asset numeric;
BEGIN
  SELECT COALESCE(SUM(e.credit - e.debit), 0) INTO v_income
    FROM ledger_accounts a JOIN ledger_entries e ON e.account_id = a.id
   WHERE a.type = 'income';
  SELECT COALESCE(SUM(e.debit - e.credit), 0) INTO v_asset
    FROM ledger_accounts a JOIN ledger_entries e ON e.account_id = a.id
   WHERE a.type = 'asset';

  IF v_income <> 1000 THEN RAISE EXCEPTION 'FAIL 6: income balance is %, expected 1000', v_income; END IF;
  IF v_asset <> 1000 THEN RAISE EXCEPTION 'FAIL 6: asset balance is %, expected 1000', v_asset; END IF;
  RAISE NOTICE 'PASS 6 — income nets credit and assets net debit, both positive';
END $$;

-- ---------------------------------------------------------------------
-- 7. A teacher cannot read the ledger. ledger_scope is RESTRICTIVE FOR
--    ALL and staff-only by design — one of the policies migration 023
--    deliberately did NOT split, because here covering SELECT is the point.
-- ---------------------------------------------------------------------
DO $$
DECLARE n integer;
BEGIN
  PERFORM set_config('app.role', 'class_teacher', true);
  SELECT count(*) INTO n FROM ledger_entries;
  IF n <> 0 THEN RAISE EXCEPTION 'FAIL 7: a class teacher read % ledger entries', n; END IF;
  PERFORM set_config('app.role', 'accountant', true);
  RAISE NOTICE 'PASS 7 — a class teacher sees no ledger entries';
END $$;

-- ---------------------------------------------------------------------
-- 8. Another school's accountant sees none of these entries.
-- ---------------------------------------------------------------------
DO $$
DECLARE n integer;
BEGIN
  PERFORM set_config('app.tenant_id', '9d000000-0000-4000-8000-0000000000ff', true);
  SELECT count(*) INTO n FROM ledger_entries;
  IF n <> 0 THEN RAISE EXCEPTION 'FAIL 8: another tenant read % ledger entries', n; END IF;
  PERFORM set_config('app.tenant_id', '9d000000-0000-4000-8000-00000000000d', true);
  RAISE NOTICE 'PASS 8 — the ledger is tenant-isolated';
END $$;

ROLLBACK;

RESET ROLE;

DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM tenants WHERE id = '9d000000-0000-4000-8000-00000000000d';
  IF n <> 0 THEN RAISE EXCEPTION 'FAIL teardown: the fixture tenant survived'; END IF;
  RAISE NOTICE 'PASS teardown — no fixture rows remain';
END $$;

\echo ''
\echo '================================================'
\echo ' F-106 ledger suite passed.'
\echo '================================================'
