-- Rollback for 070 — the receipt becomes forgeable again.
--
-- Read what this restores before running it. It destroys no data and it is a
-- real widening: `payment_receipts` and `invoice_lines` go back to the
-- PERMISSIVE `tenant_isolation` alone, so any account in a school — a
-- student's — regains the ability to
--
--   * INSERT a payment receipt for any amount, against any invoice;
--   * UPDATE an existing receipt's amount;
--   * DELETE a receipt outright;
--   * UPDATE invoice_lines, i.e. set what they owe to zero;
--   * SELECT every family's payment history in the school.
--
-- All five were proved live before 070 was written.
--
-- It also drops `app.next_receipt_no()`. Any caller must be reverted with it,
-- or receipt numbering returns to the inline `max()+1` whose losing
-- transaction applied the payment and issued no receipt.

BEGIN;

DROP POLICY IF EXISTS invoice_lines_select_scope ON invoice_lines;
DROP POLICY IF EXISTS invoice_lines_delete_scope ON invoice_lines;
DROP POLICY IF EXISTS invoice_lines_update_scope ON invoice_lines;
DROP POLICY IF EXISTS invoice_lines_insert_scope ON invoice_lines;

DROP POLICY IF EXISTS receipts_delete_scope ON payment_receipts;
DROP POLICY IF EXISTS receipts_update_scope ON payment_receipts;
DROP POLICY IF EXISTS receipts_insert_scope ON payment_receipts;
DROP POLICY IF EXISTS receipts_select_scope ON payment_receipts;

DROP FUNCTION IF EXISTS app.next_receipt_no();

COMMENT ON TABLE payment_receipts IS NULL;

COMMIT;
