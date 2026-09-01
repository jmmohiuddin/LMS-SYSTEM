-- Rollback for 056 — restores 052's portal_of.
--
-- WARNING: with 054 in place, this makes the TEACHER portal switch stop every
-- login in the school (identity-svc runs as `system_ingest`, which 052 folded
-- into 'teacher') and stop the SMS run. Roll back 054 first, or not at all.
BEGIN;
CREATE OR REPLACE FUNCTION app.portal_of(p_role text)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE p_role
    WHEN 'student'   THEN 'student'
    WHEN 'guardian'  THEN 'guardian'
    WHEN 'it_admin'  THEN 'it_admin'
    WHEN 'principal' THEN 'principal'
    WHEN 'school_owner' THEN 'principal'
    ELSE 'teacher'
  END;
$$;
COMMIT;
