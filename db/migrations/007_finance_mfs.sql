-- =====================================================================
-- 007_finance_mfs.sql
-- Fee structure, invoices, MFS (bKash / Nagad / Rocket) transactions,
-- webhook inbox, receipts and double-entry ledger.
--
-- Money rules encoded here:
--   * amounts are numeric(12,2) BDT — never float
--   * the gateway transaction id is UNIQUE per provider: replayed webhooks
--     are absorbed, never double-credited
--   * raw webhook bodies are persisted BEFORE processing, so a signature
--     dispute can be reconstructed
-- =====================================================================

BEGIN;

CREATE TYPE mfs_provider    AS ENUM ('bkash','nagad','rocket','upay','bank_transfer','cash','cheque');
CREATE TYPE payment_status  AS ENUM ('initiated','pending','authorised','completed','failed','cancelled','refunded','reversed');
CREATE TYPE invoice_status  AS ENUM ('draft','issued','partly_paid','paid','overdue','waived','cancelled');

-- ---------------------------------------------------------------------
-- Fee catalogue
-- ---------------------------------------------------------------------
CREATE TABLE fee_heads (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  code          text NOT NULL,
  name_bn       text NOT NULL,                    -- 'মাসিক বেতন', 'ভর্তি ফি', 'পরীক্ষার ফি'
  name_en       text NOT NULL,
  frequency     text NOT NULL CHECK (frequency IN ('one_time','monthly','quarterly','half_yearly','annual','exam')),
  is_refundable boolean NOT NULL DEFAULT false,
  gl_account    text,                             -- maps to the ledger chart of accounts
  is_active     boolean NOT NULL DEFAULT true,
  UNIQUE (tenant_id, code)
);
CREATE TRIGGER trg_feehead_tenant BEFORE INSERT OR UPDATE ON fee_heads
  FOR EACH ROW EXECUTE FUNCTION app.enforce_tenant();

-- Amount per class (and optionally per section/quota), per academic year.
CREATE TABLE fee_structures (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  fee_head_id      uuid NOT NULL REFERENCES fee_heads(id) ON DELETE CASCADE,
  academic_year_id uuid NOT NULL REFERENCES academic_years(id) ON DELETE CASCADE,
  class_id         uuid REFERENCES classes(id) ON DELETE CASCADE,
  quota_category   text,                          -- freedom_fighter, disabled, staff_child...
  amount           numeric(12,2) NOT NULL CHECK (amount >= 0),
  late_fee_per_day numeric(10,2) NOT NULL DEFAULT 0,
  late_fee_cap     numeric(12,2),
  due_day_of_month smallint CHECK (due_day_of_month BETWEEN 1 AND 28),
  UNIQUE (tenant_id, fee_head_id, academic_year_id, class_id, quota_category)
);
CREATE TRIGGER trg_feestruct_tenant BEFORE INSERT OR UPDATE ON fee_structures
  FOR EACH ROW EXECUTE FUNCTION app.enforce_tenant();

-- Per-student waivers (scholarship, sibling discount, hardship).
CREATE TABLE fee_waivers (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  student_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  fee_head_id   uuid REFERENCES fee_heads(id) ON DELETE CASCADE,
  academic_year_id uuid NOT NULL REFERENCES academic_years(id) ON DELETE CASCADE,
  percent_off   numeric(5,2) CHECK (percent_off BETWEEN 0 AND 100),
  flat_off      numeric(12,2),
  reason        text NOT NULL,
  approved_by   uuid REFERENCES users(id),
  valid_from    date NOT NULL DEFAULT CURRENT_DATE,
  valid_to      date,
  CHECK (percent_off IS NOT NULL OR flat_off IS NOT NULL)
);
CREATE INDEX ix_waiver_student ON fee_waivers (tenant_id, student_id, academic_year_id);
CREATE TRIGGER trg_waiver_tenant BEFORE INSERT OR UPDATE ON fee_waivers
  FOR EACH ROW EXECUTE FUNCTION app.enforce_tenant();

-- ---------------------------------------------------------------------
-- Invoices
-- ---------------------------------------------------------------------
CREATE TABLE invoices (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  invoice_no        text NOT NULL,                -- human-facing, per-tenant sequence
  student_id        uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  academic_year_id  uuid NOT NULL REFERENCES academic_years(id) ON DELETE RESTRICT,
  section_id        uuid REFERENCES sections(id),
  billing_period    text,                         -- '2026-08' for monthly fees
  issued_on         date NOT NULL DEFAULT CURRENT_DATE,
  due_on            date NOT NULL,

  subtotal          numeric(12,2) NOT NULL DEFAULT 0,
  waiver_total      numeric(12,2) NOT NULL DEFAULT 0,
  late_fee          numeric(12,2) NOT NULL DEFAULT 0,
  total_amount      numeric(12,2) NOT NULL DEFAULT 0,
  paid_amount       numeric(12,2) NOT NULL DEFAULT 0,
  balance_amount    numeric(12,2) GENERATED ALWAYS AS (total_amount - paid_amount) STORED,

  status            invoice_status NOT NULL DEFAULT 'draft',
  currency          char(3) NOT NULL DEFAULT 'BDT',
  notes             text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, invoice_no),
  CHECK (paid_amount >= 0 AND total_amount >= 0)
);
CREATE INDEX ix_invoice_student ON invoices (tenant_id, student_id, issued_on DESC);
CREATE INDEX ix_invoice_due ON invoices (tenant_id, due_on)
  WHERE status IN ('issued','partly_paid','overdue');
CREATE TRIGGER trg_invoice_tenant BEFORE INSERT OR UPDATE ON invoices
  FOR EACH ROW EXECUTE FUNCTION app.enforce_tenant();
CREATE TRIGGER trg_invoice_touch BEFORE UPDATE ON invoices
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

CREATE TABLE invoice_lines (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  invoice_id   uuid NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  fee_head_id  uuid NOT NULL REFERENCES fee_heads(id) ON DELETE RESTRICT,
  description_bn text NOT NULL,
  amount       numeric(12,2) NOT NULL,
  waiver_amount numeric(12,2) NOT NULL DEFAULT 0,
  net_amount   numeric(12,2) GENERATED ALWAYS AS (amount - waiver_amount) STORED
);
CREATE INDEX ix_invoice_lines ON invoice_lines (tenant_id, invoice_id);
CREATE TRIGGER trg_invline_tenant BEFORE INSERT OR UPDATE ON invoice_lines
  FOR EACH ROW EXECUTE FUNCTION app.enforce_tenant();

-- ---------------------------------------------------------------------
-- MFS transactions — one row per payment attempt.
--
-- The provider/gateway-id unique index is the idempotency spine: bKash and
-- Nagad both retry callbacks aggressively on poor connectivity, and a
-- guardian on 2G will happily tap "Pay" three times.
-- ---------------------------------------------------------------------
CREATE TABLE mfs_transactions (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  invoice_id          uuid REFERENCES invoices(id) ON DELETE RESTRICT,
  student_id          uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  payer_user_id       uuid REFERENCES users(id),

  provider            mfs_provider NOT NULL,
  -- Our order id, sent to the gateway as merchantInvoiceNumber / orderId.
  merchant_order_id   text NOT NULL,
  -- Their ids
  gateway_payment_id  text,                       -- bKash paymentID / Nagad paymentRefId
  gateway_trx_id      text,                       -- final trxID / issuerPaymentRefNo
  payer_msisdn        varchar(16),

  amount              numeric(12,2) NOT NULL CHECK (amount > 0),
  currency            char(3) NOT NULL DEFAULT 'BDT',
  gateway_fee         numeric(10,2) NOT NULL DEFAULT 0,
  net_amount          numeric(12,2),

  status              payment_status NOT NULL DEFAULT 'initiated',
  status_reason       text,
  intent              text NOT NULL DEFAULT 'sale' CHECK (intent IN ('sale','authorization')),

  initiated_at        timestamptz NOT NULL DEFAULT now(),
  authorised_at       timestamptz,
  completed_at        timestamptz,
  reconciled_at       timestamptz,
  reconciliation_batch text,

  -- Full gateway exchange, retained for dispute handling (7-year statutory)
  request_payload     jsonb,
  response_payload    jsonb,
  idempotency_key     text NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

-- Idempotency: the same gateway transaction can never be recorded twice.
CREATE UNIQUE INDEX uq_mfs_gateway_trx ON mfs_transactions (provider, gateway_trx_id)
  WHERE gateway_trx_id IS NOT NULL;
CREATE UNIQUE INDEX uq_mfs_order ON mfs_transactions (tenant_id, merchant_order_id);
CREATE UNIQUE INDEX uq_mfs_idem ON mfs_transactions (tenant_id, idempotency_key);
CREATE INDEX ix_mfs_invoice ON mfs_transactions (tenant_id, invoice_id, status);
CREATE INDEX ix_mfs_unreconciled ON mfs_transactions (tenant_id, completed_at)
  WHERE status = 'completed' AND reconciled_at IS NULL;
CREATE TRIGGER trg_mfs_tenant BEFORE INSERT OR UPDATE ON mfs_transactions
  FOR EACH ROW EXECUTE FUNCTION app.enforce_tenant();
CREATE TRIGGER trg_mfs_touch BEFORE UPDATE ON mfs_transactions
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

COMMENT ON INDEX uq_mfs_gateway_trx IS
  'The single most important constraint in the finance module. bKash/Nagad retry '
  'callbacks on timeout; without this a flaky 2G connection double-credits a student.';

-- ---------------------------------------------------------------------
-- Webhook inbox — raw body stored BEFORE any parsing or signature check,
-- so a later dispute can be replayed byte-for-byte.
-- ---------------------------------------------------------------------
CREATE TABLE mfs_webhook_events (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid,                         -- resolved from merchant_order_id, may be NULL initially
  provider          mfs_provider NOT NULL,
  event_type        text,
  -- Provider's own event id where available; else sha256 of the raw body.
  provider_event_id text NOT NULL,
  raw_body          text NOT NULL,
  headers           jsonb NOT NULL DEFAULT '{}'::jsonb,
  source_ip         inet,
  signature_valid   boolean,
  signature_algo    text,
  processing_state  text NOT NULL DEFAULT 'received'
                      CHECK (processing_state IN ('received','verified','processed','rejected','duplicate','deferred')),
  reject_reason     text,
  mfs_transaction_id uuid REFERENCES mfs_transactions(id),
  attempts          smallint NOT NULL DEFAULT 0,
  received_at       timestamptz NOT NULL DEFAULT now(),
  processed_at      timestamptz
);
CREATE UNIQUE INDEX uq_webhook_event ON mfs_webhook_events (provider, provider_event_id);
CREATE INDEX ix_webhook_unprocessed ON mfs_webhook_events (received_at)
  WHERE processing_state IN ('received','verified','deferred');
CREATE INDEX ix_webhook_rejected ON mfs_webhook_events (provider, received_at DESC)
  WHERE processing_state = 'rejected';

-- ---------------------------------------------------------------------
-- Receipts
-- ---------------------------------------------------------------------
CREATE TABLE payment_receipts (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  receipt_no         text NOT NULL,
  mfs_transaction_id uuid REFERENCES mfs_transactions(id) ON DELETE RESTRICT,
  invoice_id         uuid NOT NULL REFERENCES invoices(id) ON DELETE RESTRICT,
  student_id         uuid NOT NULL REFERENCES users(id),
  amount             numeric(12,2) NOT NULL,
  method             mfs_provider NOT NULL,
  issued_at          timestamptz NOT NULL DEFAULT now(),
  issued_by          uuid REFERENCES users(id),
  pdf_object_key     text,
  -- Tamper-evidence: signature over (receipt_no, amount, trx, issued_at)
  signature          bytea,
  sms_sent_at        timestamptz,
  UNIQUE (tenant_id, receipt_no)
);
CREATE INDEX ix_receipt_invoice ON payment_receipts (tenant_id, invoice_id);
CREATE TRIGGER trg_receipt_tenant BEFORE INSERT OR UPDATE ON payment_receipts
  FOR EACH ROW EXECUTE FUNCTION app.enforce_tenant();

-- ---------------------------------------------------------------------
-- Double-entry ledger. Every financial event produces balanced entries;
-- an unbalanced batch is rejected by the trigger below.
-- ---------------------------------------------------------------------
CREATE TABLE ledger_accounts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  code        text NOT NULL,
  name_bn     text NOT NULL,
  type        text NOT NULL CHECK (type IN ('asset','liability','equity','income','expense')),
  parent_id   uuid REFERENCES ledger_accounts(id),
  UNIQUE (tenant_id, code)
);
CREATE TRIGGER trg_ledgeracct_tenant BEFORE INSERT OR UPDATE ON ledger_accounts
  FOR EACH ROW EXECUTE FUNCTION app.enforce_tenant();

CREATE TABLE ledger_entries (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  batch_id       uuid NOT NULL,                   -- all entries of one event share this
  account_id     uuid NOT NULL REFERENCES ledger_accounts(id) ON DELETE RESTRICT,
  entry_date     date NOT NULL DEFAULT CURRENT_DATE,
  debit          numeric(12,2) NOT NULL DEFAULT 0 CHECK (debit >= 0),
  credit         numeric(12,2) NOT NULL DEFAULT 0 CHECK (credit >= 0),
  reference_type text,
  reference_id   uuid,
  memo           text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CHECK ((debit > 0) <> (credit > 0))            -- exactly one side per line
);
CREATE INDEX ix_ledger_batch ON ledger_entries (tenant_id, batch_id);
CREATE INDEX ix_ledger_account_date ON ledger_entries (tenant_id, account_id, entry_date);
CREATE TRIGGER trg_ledger_tenant BEFORE INSERT OR UPDATE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION app.enforce_tenant();

-- Balance check runs at COMMIT, so a multi-row batch can be inserted
-- row by row and is still validated as a whole.
CREATE OR REPLACE FUNCTION app.assert_ledger_balanced() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE v_diff numeric;
BEGIN
  SELECT COALESCE(sum(debit) - sum(credit), 0) INTO v_diff
  FROM ledger_entries WHERE batch_id = NEW.batch_id;
  IF v_diff <> 0 THEN
    RAISE EXCEPTION 'ledger batch % unbalanced by %', NEW.batch_id, v_diff
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER trg_ledger_balanced
  AFTER INSERT OR UPDATE ON ledger_entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION app.assert_ledger_balanced();

-- ---------------------------------------------------------------------
-- Applying a completed payment: updates the invoice and closes it out.
-- Called from finance-svc inside the same transaction that marks the
-- mfs_transaction completed.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.apply_payment_to_invoice(
  p_tenant uuid, p_invoice uuid, p_amount numeric
) RETURNS invoice_status
LANGUAGE plpgsql AS $$
DECLARE v_status invoice_status;
BEGIN
  UPDATE invoices
     SET paid_amount = paid_amount + p_amount,
         status = CASE
           WHEN paid_amount + p_amount >= total_amount THEN 'paid'::invoice_status
           WHEN paid_amount + p_amount > 0             THEN 'partly_paid'::invoice_status
           ELSE status END
   WHERE id = p_invoice AND tenant_id = p_tenant
   RETURNING status INTO v_status;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'invoice % not found in tenant %', p_invoice, p_tenant
      USING ERRCODE = 'P0002';
  END IF;
  RETURN v_status;
END $$;

COMMIT;
