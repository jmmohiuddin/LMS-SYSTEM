-- 070 — a student could forge a receipt, and a real one could vanish
--
-- `invoices` is scoped properly: four per-command RESTRICTIVE policies plus a
-- SELECT scope that lets a guardian see their own child's bill and nobody
-- else's. Whoever wrote it did the whole job.
--
-- The two tables either side of it were left on the PERMISSIVE
-- `tenant_isolation` alone, which asks only "same school?". Proved live as
-- `shikhon_app` with `app.role = 'student'`:
--
--   UPDATE payment_receipts SET amount = 1        -> 1 row
--   DELETE FROM payment_receipts                  -> 1 row
--   INSERT INTO payment_receipts (… 99999, 'cash') -> allowed
--   UPDATE invoice_lines SET amount = 0           -> 2 rows
--   UPDATE invoices SET status='paid'             -> 0 rows   (the control)
--
-- So a student could write themselves a receipt for any sum, delete a real
-- one, and set what they owe to zero — while the invoice header, the one
-- table that WAS scoped, refused them. `payment_receipts` is the proof a
-- parent paid; it is the last row anyone should be able to forge.
--
-- SELECT is scoped here too, and that is a privacy fix rather than an
-- integrity one: with only `tenant_isolation`, every student in a school
-- could read every family's payment history. The predicate mirrors
-- `invoice_scope` on `invoices` exactly — the three money roles, or the people
-- `app.can_see_student` already lets see that child.
--
-- ── Why UPDATE is scoped rather than refused ─────────────────────────────
-- A receipt has no void or reversal column, so it is immutable by design and
-- `USING (false)` would be defensible. But `pdf_object_key`, `signature` and
-- `sms_sent_at` are columns filled AFTER issue, by the document engine and the
-- SMS receipt that R-5 and R-2 plan — nothing writes them today, and banning
-- the UPDATE now would make that a schema change later. Scoping it to the
-- three money roles closes the proven hole without pre-deciding that.
--
-- ── Why DELETE is scoped rather than refused ─────────────────────────────
-- `USING (false)` was the first instinct, matching `exams` and `exam_results`.
-- It is wrong here for two reasons. `payment_receipts` has no void, reversal
-- or status column, so a receipt keyed for the wrong invoice or the wrong
-- amount would be permanently uncorrectable — a hard block would be inventing
-- a policy the domain does not express, which is the same trap migration 069
-- avoided on `routines`. And `payment_receipts_tenant_id_fkey` is already
-- ON DELETE RESTRICT, so receipts cannot vanish as a side effect of removing a
-- school; the only way one goes is a deliberate, audited act by someone who
-- may take money in the first place.
--
-- `invoice_lines` IS refused outright: a line only exists as part of an
-- invoice, `invoices` already refuses DELETE to everyone but the same three
-- roles, and nothing in the product removes one.
--
-- ── And the receipt that was never issued ────────────────────────────────
--
-- The webhook builds its receipt number inline as
-- `1 + COALESCE(max(substring(receipt_no from '\d+$')::int), 0)` over the
-- current month, then writes it `ON CONFLICT (tenant_id, receipt_no) DO
-- NOTHING RETURNING receipt_no`, and reads the result as
-- `rows[0]?.receipt_no ?? null`.
--
-- Its own comment says the number is "generated in SQL so concurrent webhooks
-- don't collide". A `max()+1` subquery does not do that: two concurrent
-- transactions read the same maximum and compute the same next number. One
-- inserts, the other hits the unique index — and `DO NOTHING` turns that into
-- zero rows, which the optional chaining turns into `null`, which nothing
-- checks. Execution continues.
--
-- By then `app.apply_payment_to_invoice` has already run. So the parent's
-- money is applied, the invoice is marked paid, the ledger is posted — and no
-- receipt exists, with no error anywhere. B-48 called this "silently issues no
-- receipt"; the money side of it is worse than the wording suggests.
--
-- `app.next_receipt_no()` takes a transaction-scoped advisory lock on
-- (tenant, month) before reading the maximum, so the second transaction waits
-- rather than duplicating. The caller is then free to insert without
-- ON CONFLICT and let a genuine collision be the error it is.
--
-- Rollback: db/rollback/070_money_write_scope.sql. It restores
-- `tenant_isolation` alone, which is the forgeable state above, and drops the
-- number generator.

BEGIN;

-- ── payment_receipts ─────────────────────────────────────────────────────
CREATE POLICY receipts_select_scope ON payment_receipts
  AS RESTRICTIVE FOR SELECT TO shikhon_app
  USING (
    app.has_role('principal', 'school_owner', 'accountant')
    OR app.can_see_student(student_id)
  );

CREATE POLICY receipts_insert_scope ON payment_receipts
  AS RESTRICTIVE FOR INSERT TO shikhon_app
  WITH CHECK (app.has_role('principal', 'school_owner', 'accountant'));

CREATE POLICY receipts_update_scope ON payment_receipts
  AS RESTRICTIVE FOR UPDATE TO shikhon_app
  USING (app.has_role('principal', 'school_owner', 'accountant'))
  WITH CHECK (app.has_role('principal', 'school_owner', 'accountant'));

CREATE POLICY receipts_delete_scope ON payment_receipts
  AS RESTRICTIVE FOR DELETE TO shikhon_app
  USING (app.has_role('principal', 'school_owner', 'accountant'));

-- ── invoice_lines ────────────────────────────────────────────────────────
-- Written only by the monthly run (finance-svc/api/index.ts). A line is what
-- the bill says is owed, so it takes the same three roles as its header.
CREATE POLICY invoice_lines_insert_scope ON invoice_lines
  AS RESTRICTIVE FOR INSERT TO shikhon_app
  WITH CHECK (app.has_role('principal', 'school_owner', 'accountant'));

CREATE POLICY invoice_lines_update_scope ON invoice_lines
  AS RESTRICTIVE FOR UPDATE TO shikhon_app
  USING (app.has_role('principal', 'school_owner', 'accountant'))
  WITH CHECK (app.has_role('principal', 'school_owner', 'accountant'));

CREATE POLICY invoice_lines_delete_scope ON invoice_lines
  AS RESTRICTIVE FOR DELETE TO shikhon_app
  USING (false);

-- Reading a line follows reading its invoice. Without this a student who
-- cannot open another child's invoice could still read its lines directly.
CREATE POLICY invoice_lines_select_scope ON invoice_lines
  AS RESTRICTIVE FOR SELECT TO shikhon_app
  USING (
    app.has_role('principal', 'school_owner', 'accountant')
    OR EXISTS (
      SELECT 1 FROM invoices i
       WHERE i.id = invoice_lines.invoice_id
         AND app.can_see_student(i.student_id)
    )
  );

-- ── The receipt number, generated safely ─────────────────────────────────
CREATE OR REPLACE FUNCTION app.next_receipt_no()
 RETURNS text
 LANGUAGE plpgsql
AS $function$
DECLARE v_month text; v_next int;
BEGIN
  v_month := to_char(now() AT TIME ZONE 'Asia/Dhaka', 'YYYY-MM');

  -- Serialise number allocation within (tenant, month). Transaction-scoped, so
  -- it is released at COMMIT or ROLLBACK and cannot be stranded by a crash.
  -- Two concurrent payments now queue instead of computing the same number.
  PERFORM pg_advisory_xact_lock(
    hashtext('receipt_no'), hashtext(app.current_tenant()::text || v_month));

  SELECT 1 + COALESCE(max(substring(receipt_no from '\d+$')::int), 0)
    INTO v_next
    FROM payment_receipts
   WHERE receipt_no LIKE 'RCP-' || v_month || '-%';

  RETURN 'RCP-' || v_month || '-' || lpad(v_next::text, 5, '0');
END $function$;

COMMENT ON FUNCTION app.next_receipt_no() IS
  'Allocates the next RCP-YYYY-MM-NNNNN for the current tenant under an '
  'advisory lock. The inline max()+1 it replaces let two concurrent webhooks '
  'compute the same number; the loser was swallowed by ON CONFLICT DO NOTHING '
  'and the payment was applied with no receipt. See migration 070.';

COMMENT ON TABLE payment_receipts IS
  'Proof that a payment was taken. Immutable in practice: there is no void or '
  'reversal column, DELETE is limited to the three roles that may take money, '
  'and the receipt number is '
  'UNIQUE per tenant. See migration 070 and app.next_receipt_no().';

COMMIT;
