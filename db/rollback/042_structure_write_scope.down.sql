-- Rollback for 042 — structure and guardianship write scope (R-3 completion).
--
-- This one loses SAFETY, not data. Dropping these policies returns
-- `classes`, `sections` and `guardianships` to tenant-isolated-but-not-
-- role-scoped: any authenticated session in a school could insert a class or
-- change who may pay a child's fees.
--
-- That is the state the schema was in from migration 010 until 042, and it
-- was harmless only because nothing in the product wrote to those tables.
-- After the R-3 completion pass there are screens that do. So rolling this
-- back is safe ONLY if the matching endpoints are rolled back with it —
-- ops-svc's structure.ts and guardians.ts — which a code deploy does, and a
-- database-only rollback does not.
--
-- Stated here rather than discovered: a rollback that quietly widens who may
-- write is the kind that looks like it worked.

BEGIN;

DROP FUNCTION IF EXISTS
  app.set_guardian_permissions(uuid, uuid, text, boolean, boolean, boolean);

DROP POLICY IF EXISTS guardianship_delete_scope ON guardianships;
DROP POLICY IF EXISTS guardianship_update_scope ON guardianships;
DROP POLICY IF EXISTS guardianship_insert_scope ON guardianships;

DROP POLICY IF EXISTS sections_delete_scope ON sections;
DROP POLICY IF EXISTS sections_update_scope ON sections;
DROP POLICY IF EXISTS sections_insert_scope ON sections;

DROP POLICY IF EXISTS classes_delete_scope ON classes;
DROP POLICY IF EXISTS classes_update_scope ON classes;
DROP POLICY IF EXISTS classes_insert_scope ON classes;

COMMIT;
