-- Re-runnable: ALTER TABLE IF EXISTS + DROP CONSTRAINT IF EXISTS tolerate a
-- partial rollback that already removed the tables.
BEGIN;
ALTER TABLE IF EXISTS mfs_webhook_events DROP CONSTRAINT IF EXISTS mfs_webhook_events_tenant_fk;
ALTER TABLE IF EXISTS sync_change_log    DROP CONSTRAINT IF EXISTS sync_change_log_tenant_fk;
ALTER TABLE IF EXISTS ai_turns           DROP CONSTRAINT IF EXISTS ai_turns_tenant_fk;
ALTER TABLE IF EXISTS ai_sessions        DROP CONSTRAINT IF EXISTS ai_sessions_tenant_fk;
ALTER TABLE IF EXISTS sms_outbox         DROP CONSTRAINT IF EXISTS sms_outbox_tenant_fk;
ALTER TABLE IF EXISTS attendance_records DROP CONSTRAINT IF EXISTS attendance_records_tenant_fk;
COMMIT;
