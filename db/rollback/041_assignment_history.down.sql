-- Rollback for 041 — teacher assignment history, it_admin, readable audit (R-3).
--
-- This one destroys history, and the history is the point of the migration:
-- every closed assignment row — who taught which section until when, and why
-- they stopped — exists only in these columns and this table. Restoring the
-- old UNIQUE constraint is impossible while more than one row exists per
-- (section, subject, year), so the closed rows must go first.
--
-- Correct for the current pre-production stage (see db/rollback/README.md).
-- Once a school has replaced a teacher mid-year, rolling this back discards
-- the answer to "who was responsible for my child's class in March", and would
-- need an export first.
--
-- Users holding the it_admin role are NOT deleted here; the role row is
-- removed only if nobody holds it. Dropping a role out from under a live
-- account would silently downgrade a real person's access, and the FK from
-- user_roles would refuse anyway — better to fail loudly than to cascade.

BEGIN;

-- Functions first: they reference the table dropped below.
DROP FUNCTION IF EXISTS app.assign_subject_teacher(uuid, uuid, uuid, date, text);
DROP FUNCTION IF EXISTS app.assign_class_teacher(uuid, uuid, date, text);

-- The audit grant and its policies.
DROP POLICY IF EXISTS activity_read_scope ON audit.activity_log;
DROP POLICY IF EXISTS tenant_isolation    ON audit.activity_log;
ALTER TABLE audit.activity_log NO FORCE ROW LEVEL SECURITY;
ALTER TABLE audit.activity_log DISABLE ROW LEVEL SECURITY;
REVOKE SELECT ON audit.activity_log FROM shikhon_app;

-- Class-teacher history. The trigger goes with the table; sections.class_teacher_id
-- keeps whatever value the last sync left, which is the current teacher — the
-- correct resting state for a column that predates this migration.
DROP TRIGGER  IF EXISTS trg_cta_sync_section ON class_teacher_assignments;
DROP TRIGGER  IF EXISTS trg_cta_tenant       ON class_teacher_assignments;
DROP TABLE    IF EXISTS class_teacher_assignments;
DROP FUNCTION IF EXISTS app.sync_section_class_teacher();

-- Subject-teacher history. Close the door in the reverse order it was opened:
-- drop the partial index, discard the closed rows (they cannot coexist with
-- the constraint being restored), then restore the constraint.
DROP INDEX IF EXISTS ix_sst_history;
DROP INDEX IF EXISTS uq_sst_current;

DELETE FROM section_subject_teachers WHERE ended_on IS NOT NULL;

ALTER TABLE section_subject_teachers
  DROP CONSTRAINT IF EXISTS sst_reason_belongs_to_a_closed_row,
  DROP CONSTRAINT IF EXISTS sst_period_is_ordered,
  DROP COLUMN IF EXISTS end_reason,
  DROP COLUMN IF EXISTS assigned_by,
  DROP COLUMN IF EXISTS ended_on,
  DROP COLUMN IF EXISTS started_on;

ALTER TABLE section_subject_teachers
  ADD CONSTRAINT section_subject_teachers_tenant_id_section_id_subject_id_ac_key
  UNIQUE (tenant_id, section_id, subject_id, academic_year_id);

-- The role, only if it is unheld.
DELETE FROM roles r
 WHERE r.code = 'it_admin'
   AND NOT EXISTS (SELECT 1 FROM user_roles ur WHERE ur.role_code = 'it_admin');

COMMIT;
