-- =====================================================================
-- 013_tenant_fk_integrity.sql
--
-- Closes a real gap found by the sync-svc integration tests: six tenant
-- tables carried `tenant_id` with NO foreign key to `tenants`. Deleting a
-- tenant therefore left orphaned rows behind — invisible to RLS forever,
-- but still on disk.
--
-- That is not merely untidy. `attendance_records` is the table a PDPA 2026
-- erasure request has to clear, and it was the worst offender (it is
-- partitioned, and the FK was omitted when the partitions were created).
--
-- Fix: purge existing orphans, then add ON DELETE CASCADE so deletion is
-- complete by construction rather than by remembering to write the DELETE.
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- 1. Purge orphans.
--
-- These rows reference a tenant that no longer exists. RLS filters every
-- query by `tenant_id = app.current_tenant()`, and no session can ever
-- adopt a deleted tenant's id, so they are unreachable by definition.
-- ---------------------------------------------------------------------
DO $$
DECLARE
  t text;
  n bigint;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'attendance_records', 'sms_outbox', 'ai_sessions', 'ai_turns', 'sync_change_log'
  ] LOOP
    EXECUTE format(
      'DELETE FROM %I x WHERE NOT EXISTS (SELECT 1 FROM tenants t WHERE t.id = x.tenant_id)', t);
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n > 0 THEN
      RAISE NOTICE 'purged % orphaned row(s) from %', n, t;
    END IF;
  END LOOP;

  -- Nullable-tenant table: a webhook that was never attributed is legitimate,
  -- so only rows pointing at a *deleted* tenant are orphans.
  DELETE FROM mfs_webhook_events x
   WHERE x.tenant_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM tenants t WHERE t.id = x.tenant_id);
END $$;

-- ---------------------------------------------------------------------
-- 2. Add the missing foreign keys.
--
-- PostgreSQL 12+ supports foreign keys declared ON a partitioned table;
-- the constraint is propagated to every partition, existing and future.
-- ---------------------------------------------------------------------
ALTER TABLE attendance_records
  ADD CONSTRAINT attendance_records_tenant_fk
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;

ALTER TABLE sms_outbox
  ADD CONSTRAINT sms_outbox_tenant_fk
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;

ALTER TABLE ai_sessions
  ADD CONSTRAINT ai_sessions_tenant_fk
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;

ALTER TABLE ai_turns
  ADD CONSTRAINT ai_turns_tenant_fk
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;

ALTER TABLE sync_change_log
  ADD CONSTRAINT sync_change_log_tenant_fk
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;

-- Nullable by design (a callback arrives before its tenant is resolved),
-- but once attributed it must not outlive the tenant.
ALTER TABLE mfs_webhook_events
  ADD CONSTRAINT mfs_webhook_events_tenant_fk
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;

COMMENT ON CONSTRAINT attendance_records_tenant_fk ON attendance_records IS
  'Makes tenant deletion (and PDPA 2026 erasure) complete by construction. '
  'Without it, 196 orphaned records survived a tenant DELETE in testing.';

COMMIT;
