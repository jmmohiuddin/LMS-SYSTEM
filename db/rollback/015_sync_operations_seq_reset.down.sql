-- Re-runnable: the table may already be gone from a partial rollback, and
-- ADD CONSTRAINT has no IF NOT EXISTS, so both are guarded on the catalog.
BEGIN;
DROP INDEX IF EXISTS ix_sync_operations_device_seq;
DO $$
BEGIN
  IF to_regclass('public.sync_operations') IS NULL THEN
    RETURN;   -- 001 rollback already dropped the table
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.sync_operations'::regclass
       AND conname  = 'sync_operations_tenant_id_device_id_device_seq_key'
  ) THEN
    ALTER TABLE sync_operations
      ADD CONSTRAINT sync_operations_tenant_id_device_id_device_seq_key
      UNIQUE (tenant_id, device_id, device_seq);
  END IF;
END $$;
COMMIT;
