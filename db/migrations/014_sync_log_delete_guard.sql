-- =====================================================================
-- 014_sync_log_delete_guard.sql
--
-- Regression fix for a defect introduced by 013.
--
-- Adding `sync_change_log_tenant_fk` made tenant deletion FAIL:
--
--   DELETE FROM tenants WHERE id = …
--     → cascades to sections / enrolments / routine_slots
--       → their AFTER DELETE trigger calls app.log_sync_change()
--         → INSERT INTO sync_change_log (tenant_id = the tenant being deleted)
--           → 23503 violates sync_change_log_tenant_fk
--
-- The FK is correct and worth keeping (see 013). What is wrong is emitting a
-- change-feed entry for a tenant that is going away: no client will ever sync
-- it, because no session can adopt a deleted tenant's id.
--
-- Deferring the constraint would not help — the row is still an orphan at
-- COMMIT. The right fix is to not write it.
--
-- Caught by the sync-svc integration suite, which deletes its fixture tenant
-- in teardown. Without that teardown this would have shipped, and the first
-- PDPA erasure request in production would have failed.
-- =====================================================================

BEGIN;

CREATE OR REPLACE FUNCTION app.log_sync_change() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE scope_name text := TG_ARGV[0];
BEGIN
  IF TG_OP = 'DELETE' THEN
    -- Skip when the tenant itself is being removed: the cascade is already
    -- deleting everything the client could sync, and the FK would reject it.
    IF NOT EXISTS (SELECT 1 FROM tenants t WHERE t.id = OLD.tenant_id) THEN
      RETURN OLD;
    END IF;
    INSERT INTO sync_change_log (tenant_id, scope, entity_id, op)
    VALUES (OLD.tenant_id, scope_name, OLD.id, 'D');
    RETURN OLD;
  END IF;

  INSERT INTO sync_change_log (tenant_id, scope, entity_id, op)
  VALUES (NEW.tenant_id, scope_name, NEW.id, 'U');
  RETURN NEW;
END $$;

COMMENT ON FUNCTION app.log_sync_change() IS
  'Feeds the /sync/pull cursor. Skips DELETEs whose tenant is itself being '
  'deleted — otherwise the cascade violates sync_change_log_tenant_fk and '
  'tenant erasure becomes impossible.';

COMMIT;
