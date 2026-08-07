-- =====================================================================
-- 015_sync_operations_seq_reset.sql
--
-- Removes UNIQUE (tenant_id, device_id, device_seq) from sync_operations.
--
-- THE BUG
-- -------
-- device_seq is a counter held in the DEVICE'S OWN IndexedDB. It restarts at 1
-- whenever that local store is recreated — app reinstall, "clear site data",
-- browser storage eviction under memory pressure (routine on a 2 GB Android
-- Go phone), or simply a second device profile.
--
-- With the UNIQUE constraint in place, the first op after any such reset
-- collides with a historical row and fails with 23505. The client treats it as
-- a conflict, parks the op, and the SAME thing happens to seq 2, 3, 4 … The
-- device is permanently unable to sync, and the only symptom the teacher sees
-- is that attendance silently stops uploading.
--
-- WHY DROPPING IT IS SAFE
-- -----------------------
-- Idempotency never depended on this constraint. It rests on the PRIMARY KEY
-- `op_id`, a client-generated UUIDv7 that is globally unique and stable across
-- retries — a reinstalled device mints fresh op ids, which is exactly right,
-- because those really are new operations.
--
-- device_seq remains useful for diagnostics (gap detection, author ordering
-- within one install), so the column and an ordinary index stay.
--
-- Found by the client↔server integration test: a second SyncEngine on the same
-- deviceId restarted its counter at 1 and every op came back as a duplicate-key
-- conflict — precisely the reinstall scenario.
-- =====================================================================

BEGIN;

ALTER TABLE sync_operations
  DROP CONSTRAINT IF EXISTS sync_operations_tenant_id_device_id_device_seq_key;

-- Non-unique replacement: still answers "did this device skip a seq?" without
-- making a counter reset fatal.
CREATE INDEX IF NOT EXISTS ix_sync_operations_device_seq
  ON sync_operations (tenant_id, device_id, device_seq);

COMMENT ON COLUMN sync_operations.device_seq IS
  'Per-install monotonic counter, for diagnostics and author ordering only. '
  'NOT unique: it restarts at 1 whenever the device''s local store is '
  'recreated (reinstall, storage eviction). Idempotency is op_id alone.';

COMMIT;
