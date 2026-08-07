BEGIN;
DROP TABLE IF EXISTS sync_operations  CASCADE;
DROP TABLE IF EXISTS sync_change_log  CASCADE;
DROP TABLE IF EXISTS event_outbox     CASCADE;
DROP TABLE IF EXISTS tenants          CASCADE;
DROP SCHEMA IF EXISTS audit   CASCADE;
DROP SCHEMA IF EXISTS archive CASCADE;
DROP SCHEMA IF EXISTS app     CASCADE;
DROP TYPE IF EXISTS shift_code;
DROP TYPE IF EXISTS tenant_status;
DROP TYPE IF EXISTS institution_level;
DROP TYPE IF EXISTS institution_stream;
COMMIT;

-- Roles are cluster-wide and may be shared with other databases, so they are
-- NOT dropped here. Remove manually only if this is the last LMS database:
--   DROP OWNED BY shikhon_app; DROP ROLE shikhon_app;  (etc.)
