-- Rollback for 036 — product event instrumentation (F-1503).
--
-- Destroys the pilot's evidence: raw events AND the rollup history. The
-- PRD's words for the state this returns to: "a pilot that produces no
-- data cannot gate Phase 2, and every subsequent decision becomes a
-- guess." Roll back only if 036 itself is broken.
BEGIN;

DROP FUNCTION IF EXISTS app.rollup_product_events();
DROP TABLE IF EXISTS product_event_rollups;
DROP TABLE IF EXISTS product_events;
DROP FUNCTION IF EXISTS app.assert_event_payload_clean();
DROP FUNCTION IF EXISTS jsonb_paths(jsonb);

COMMIT;
