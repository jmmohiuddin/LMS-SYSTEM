-- Rollback for 067 — the fee configuration tables go back to tenant isolation
-- and nothing else.
--
-- Read what this restores before running it: any role in the school regains
-- the ability to write fee_heads, fee_structures and fee_waivers — including
-- `student`, who could then set their own tuition to zero or grant themselves
-- a full waiver. That is the pre-067 state faithfully, and it is a real
-- widening rather than a no-op. It destroys no data.

BEGIN;

DROP INDEX IF EXISTS uq_fee_structure_scope;

DROP POLICY IF EXISTS fee_waivers_delete_scope ON fee_waivers;
DROP POLICY IF EXISTS fee_waivers_update_scope ON fee_waivers;
DROP POLICY IF EXISTS fee_waivers_insert_scope ON fee_waivers;

DROP POLICY IF EXISTS fee_structures_delete_scope ON fee_structures;
DROP POLICY IF EXISTS fee_structures_update_scope ON fee_structures;
DROP POLICY IF EXISTS fee_structures_insert_scope ON fee_structures;

DROP POLICY IF EXISTS fee_heads_delete_scope ON fee_heads;
DROP POLICY IF EXISTS fee_heads_update_scope ON fee_heads;
DROP POLICY IF EXISTS fee_heads_insert_scope ON fee_heads;

COMMENT ON TABLE fee_structures IS NULL;

COMMIT;
