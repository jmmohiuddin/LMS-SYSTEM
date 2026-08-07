BEGIN;
-- Drop every policy created by 010, then disable RLS.
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN
    SELECT p.polname, c.oid::regclass AS tbl
    FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public'
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON %s', r.polname, r.tbl);
  END LOOP;

  FOR r IN
    SELECT c.oid::regclass AS tbl FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r','p') AND c.relrowsecurity
  LOOP
    EXECUTE format('ALTER TABLE %s NO FORCE ROW LEVEL SECURITY', r.tbl);
    EXECUTE format('ALTER TABLE %s DISABLE ROW LEVEL SECURITY', r.tbl);
  END LOOP;
END $$;

DROP FUNCTION IF EXISTS app.can_see_student(uuid);
DROP FUNCTION IF EXISTS app.my_ward_ids();
DROP FUNCTION IF EXISTS app.my_section_ids();
DROP FUNCTION IF EXISTS app.is_system_ingest();
DROP FUNCTION IF EXISTS app.is_staff();
COMMIT;
