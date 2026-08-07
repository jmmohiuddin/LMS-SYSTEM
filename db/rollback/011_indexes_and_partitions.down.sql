BEGIN;
DROP FUNCTION IF EXISTS app.refresh_dashboards();
DROP FUNCTION IF EXISTS app.purge_expired_data(date);
DROP FUNCTION IF EXISTS app.maintain_partitions(date);
DROP MATERIALIZED VIEW IF EXISTS mv_syllabus_progress  CASCADE;
DROP MATERIALIZED VIEW IF EXISTS mv_fee_collection     CASCADE;
DROP MATERIALIZED VIEW IF EXISTS mv_teacher_load       CASCADE;
DROP MATERIALIZED VIEW IF EXISTS mv_attendance_daily   CASCADE;
DROP VIEW IF EXISTS v_default_partition_leakage;
DROP TABLE IF EXISTS partition_config CASCADE;
DROP INDEX IF EXISTS ix_slots_teacher_day, ix_slots_section_day, ix_slots_room_day,
                     ix_subs_open, ix_invoice_balance, ix_items_vector, ix_users_name_en_trgm;
COMMIT;
