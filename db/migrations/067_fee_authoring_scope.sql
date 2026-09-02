-- ---------------------------------------------------------------------------
-- 067 — the fee configuration tables get the write scope they never had, on
--       the day a fee structure can first be created.
--
-- ── What was found ──────────────────────────────────────────────────────
-- `fee_structures` had **zero rows across 126 institutions** and no writer
-- anywhere: not in TypeScript, not in an `app.*` function. The monthly invoice
-- run joins it —
--
--   JOIN fee_structures fs ON fs.academic_year_id = $1
--                         AND (fs.class_id = e.class_id OR fs.class_id IS NULL)
--                         AND fs.quota_category IS NULL
--   JOIN fee_heads fh ON fh.id = fs.fee_head_id
--                    AND fh.is_active AND fh.frequency = 'monthly'
--
-- — so `POST /api/v1/finance/generate` produced zero invoices for every school,
-- every month, and returned success while doing it. A school could not charge
-- a fee.
--
-- ── And they were writable by anybody ───────────────────────────────────
-- `fee_heads`, `fee_structures` and `fee_waivers` have carried
-- `tenant_isolation` and nothing else since migration 007. A session holding
-- `app.role = 'student'` could set its own tuition to zero, or grant itself a
-- 100% waiver. Verified against a live database before this file was written.
--
-- Nothing had exercised it, because nothing in the product wrote these tables
-- at all — the same shape as `rooms` in 065 and `exams` in 066, and the same
-- reason to close it in the commit that makes it reachable.
--
-- `invoices` shows what this should look like: it has had
-- `invoice_write_scope_ins/upd/del` plus a SELECT scope since migration 010.
-- These three were simply missed.
--
-- ── Per-command, never FOR ALL ──────────────────────────────────────────
-- A RESTRICTIVE `FOR ALL` applies its USING to SELECT. A guardian must keep
-- reading the fee heads behind their child's invoice, and a student must keep
-- reading their own waiver. Same reasoning as migrations 042, 065 and 066.
--
-- ── Who may write ───────────────────────────────────────────────────────
-- The four roles `services/finance-svc/api/index.ts` already trusts with the
-- invoice run (`BILLING_ROLES`), plus `it_admin`, who sets a school up before
-- an accountant exists. No new role set is invented here.
--
-- ── Deleting a fee structure does not delete financial history ──────────
-- Deliberate, and checkable rather than assumed: `invoice_lines` stores
-- `fee_head_id`, `description_bn`, `amount`, `waiver_amount` and `net_amount`.
-- It does NOT reference `fee_structures`. An issued invoice therefore carries
-- its own numbers and cannot be altered or orphaned by removing the
-- configuration that produced it. A structure is next month's instruction, not
-- last month's record.
--
-- `fee_waivers` is the exception: a waiver is an approval granted to a named
-- child, with `approved_by` on the row. Those are removed by expiry
-- (`valid_to`), not by deletion.
-- ---------------------------------------------------------------------------

BEGIN;

-- ── fee_heads ───────────────────────────────────────────────────────────

CREATE POLICY fee_heads_insert_scope ON fee_heads
  AS RESTRICTIVE FOR INSERT TO shikhon_app
  WITH CHECK (app.has_role('principal', 'school_owner', 'accountant', 'it_admin'));

CREATE POLICY fee_heads_update_scope ON fee_heads
  AS RESTRICTIVE FOR UPDATE TO shikhon_app
  USING      (app.has_role('principal', 'school_owner', 'accountant', 'it_admin'))
  WITH CHECK (app.has_role('principal', 'school_owner', 'accountant', 'it_admin'));

-- A head is referenced by every invoice line ever raised under it
-- (`invoice_lines.fee_head_id`). Switching `is_active` off is how a school
-- retires one; deleting it would cascade into the ledger.
CREATE POLICY fee_heads_delete_scope ON fee_heads
  AS RESTRICTIVE FOR DELETE TO shikhon_app
  USING (false);

-- ── fee_structures ──────────────────────────────────────────────────────

CREATE POLICY fee_structures_insert_scope ON fee_structures
  AS RESTRICTIVE FOR INSERT TO shikhon_app
  WITH CHECK (app.has_role('principal', 'school_owner', 'accountant', 'it_admin'));

CREATE POLICY fee_structures_update_scope ON fee_structures
  AS RESTRICTIVE FOR UPDATE TO shikhon_app
  USING      (app.has_role('principal', 'school_owner', 'accountant', 'it_admin'))
  WITH CHECK (app.has_role('principal', 'school_owner', 'accountant', 'it_admin'));

-- Configuration, not history — see the header.
CREATE POLICY fee_structures_delete_scope ON fee_structures
  AS RESTRICTIVE FOR DELETE TO shikhon_app
  USING (app.has_role('principal', 'school_owner', 'accountant', 'it_admin'));

-- ── fee_waivers ─────────────────────────────────────────────────────────
-- Narrower on purpose: a waiver is money not collected from a named child.
-- `it_admin` sets a school up; they do not decide who stops paying.

CREATE POLICY fee_waivers_insert_scope ON fee_waivers
  AS RESTRICTIVE FOR INSERT TO shikhon_app
  WITH CHECK (app.has_role('principal', 'school_owner', 'accountant'));

CREATE POLICY fee_waivers_update_scope ON fee_waivers
  AS RESTRICTIVE FOR UPDATE TO shikhon_app
  USING      (app.has_role('principal', 'school_owner', 'accountant'))
  WITH CHECK (app.has_role('principal', 'school_owner', 'accountant'));

-- A granted waiver ends by expiring, not by vanishing: `approved_by` says who
-- granted it, and that record is the answer to "why did this child pay less".
CREATE POLICY fee_waivers_delete_scope ON fee_waivers
  AS RESTRICTIVE FOR DELETE TO shikhon_app
  USING (false);

-- ── The uniqueness that was never enforced ──────────────────────────────
--
-- `fee_structures_tenant_id_fee_head_id_academic_year_id_class_key` is
-- UNIQUE (tenant_id, fee_head_id, academic_year_id, class_id, quota_category),
-- and PostgreSQL treats NULLs as DISTINCT in a unique constraint by default.
--
-- `quota_category` is NULL on every row the invoice engine can use — it joins
-- `AND fs.quota_category IS NULL` — and `class_id` is NULL on every
-- school-wide price. So the constraint never fired for exactly the rows that
-- matter: a school could set two different school-wide tuition prices for the
-- same year, and the run's `DISTINCT ON (student_id, fee_head_id)` would pick
-- one of them by sort order.
--
-- Caught by a test that expected a 409 and got a second row. Migrations 004
-- and 040 already use NULLS NOT DISTINCT for the same reason; the original
-- constraint is left in place because dropping it would be a second, unrelated
-- change and it costs one index.
--
-- Checked against every live row before this was written: 0 duplicate scopes.
CREATE UNIQUE INDEX uq_fee_structure_scope
  ON fee_structures (tenant_id, fee_head_id, academic_year_id, class_id, quota_category)
  NULLS NOT DISTINCT;

COMMENT ON TABLE fee_structures IS
  'What a fee head costs, per academic year, optionally per class. A NULL '
  'class_id is the school-wide default and a class row overrides it '
  '(the invoice run orders class_id NULLS LAST). Only heads with '
  'frequency = ''monthly'' and is_active are picked up by the monthly invoice '
  'run. Written through /api/v1/finance/feestructures — see migration 067.';

COMMIT;
