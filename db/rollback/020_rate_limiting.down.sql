-- Rollback for 020_rate_limiting.sql (F-102).
BEGIN;

DROP FUNCTION IF EXISTS app.prune_rate_limit_buckets(interval);
DROP FUNCTION IF EXISTS app.rate_limit_consume(jsonb);
DROP TABLE IF EXISTS rate_limit_buckets;

COMMIT;
