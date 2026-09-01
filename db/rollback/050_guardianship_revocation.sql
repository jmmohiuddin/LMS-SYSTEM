-- Rollback for 050 — guardianship revocation (B-7).
--
-- Restores migration 042's state: no way to end a guardianship, and the
-- DELETE policy still denying every role. Any link that HAS been revoked
-- becomes active again — which is the honest consequence and the reason this
-- rollback is not something to run casually on a school that has used the
-- feature: a former guardian regains access to a child's records.
--
-- Run `SELECT count(*) FROM guardianships WHERE revoked_at IS NOT NULL;` as
-- the owner first. A non-zero answer is a decision, not a migration step.
BEGIN;

DROP FUNCTION IF EXISTS app.revoke_guardianship(uuid, uuid, text);
DROP POLICY IF EXISTS guardianship_hide_revoked ON guardianships;

-- The two definer readers go back to asking only whether the row exists.
CREATE OR REPLACE FUNCTION app.my_ward_ids() RETURNS uuid[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, app AS $$
  SELECT COALESCE(array_agg(g.student_id), '{}')
  FROM guardianships g
  WHERE g.tenant_id = app.current_tenant() AND g.guardian_id = app.current_user_id();
$$;
REVOKE ALL ON FUNCTION app.my_ward_ids() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.my_ward_ids() TO shikhon_app;

-- Indexes and constraints back to their total forms. The unique constraint
-- can only be restored if no student has both an active and a revoked link to
-- the same guardian; that is why the columns are dropped first.
ALTER TABLE guardianships
  DROP CONSTRAINT IF EXISTS guardianship_revocation_complete;
ALTER TABLE guardianships
  DROP COLUMN IF EXISTS revoked_reason,
  DROP COLUMN IF EXISTS revoked_by,
  DROP COLUMN IF EXISTS revoked_at;

DROP INDEX IF EXISTS uq_guardianship_active;
ALTER TABLE guardianships
  ADD CONSTRAINT guardianships_tenant_id_student_id_guardian_id_key
  UNIQUE (tenant_id, student_id, guardian_id);

DROP INDEX IF EXISTS uq_guardianship_primary;
CREATE UNIQUE INDEX uq_guardianship_primary
  ON guardianships (tenant_id, student_id) WHERE is_primary;

DROP INDEX IF EXISTS ix_guardianship_by_guardian;
CREATE INDEX ix_guardianship_by_guardian ON guardianships (tenant_id, guardian_id);

-- app.resolve_notice_audience and app.tenant_onboarding_state keep their
-- `revoked_at IS NULL` tests: with the column gone they would not compile, so
-- 040's and 045's originals must be re-run if this rollback is used. Named
-- here rather than silently reproduced, because reproducing two large
-- functions in a rollback file is how they drift.
