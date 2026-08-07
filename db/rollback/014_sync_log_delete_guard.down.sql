-- Restores the 001 definition (no tenant-deletion guard).
-- Re-runnable: a partial rollback may already have dropped schema `app`.
BEGIN;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'app') THEN
    RETURN;   -- 001 rollback already removed it; nothing to restore
  END IF;

  EXECUTE $fn$
    CREATE OR REPLACE FUNCTION app.log_sync_change() RETURNS trigger
    LANGUAGE plpgsql AS $body$
    DECLARE scope_name text := TG_ARGV[0];
    BEGIN
      IF TG_OP = 'DELETE' THEN
        INSERT INTO sync_change_log (tenant_id, scope, entity_id, op)
        VALUES (OLD.tenant_id, scope_name, OLD.id, 'D');
        RETURN OLD;
      END IF;
      INSERT INTO sync_change_log (tenant_id, scope, entity_id, op)
      VALUES (NEW.tenant_id, scope_name, NEW.id, 'U');
      RETURN NEW;
    END $body$;
  $fn$;
END $$;
COMMIT;
