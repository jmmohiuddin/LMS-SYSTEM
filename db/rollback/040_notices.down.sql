-- Rollback for 040 — notices and in-app notifications (R-2).
--
-- Drops the notices feature entirely. Unlike 039's rollback, this DOES destroy
-- data: notices and their receipts live only in these tables, so there is
-- nothing to preserve them into. That is correct for the current
-- pre-production stage (see db/rollback/README.md) — once real institutions
-- are publishing notices, rolling this back means losing the record of what a
-- school told its guardians, and that would need an export first.
--
-- event_outbox rows of type 'notice.published.v1' are deliberately LEFT: the
-- SMS worker may already have consumed them, and a queued SMS that has been
-- sent must keep its provenance. They become inert once the type has no
-- consumer.
BEGIN;

-- Functions first, and ALL of them. app.emit_auto_notice takes a
-- notice_category parameter, so a DROP TYPE below would be refused while it
-- still exists — the failure mode that made the first up→down→up cycle fail.
DROP FUNCTION IF EXISTS
  app.emit_auto_notice(text, uuid, text, text, notice_category, jsonb, boolean);
DROP FUNCTION IF EXISTS app.publish_due_notices(uuid, integer);
DROP FUNCTION IF EXISTS app.publish_notice(uuid);
DROP FUNCTION IF EXISTS app.resolve_notice_audience(uuid, jsonb);

DROP TABLE IF EXISTS notice_receipts CASCADE;
DROP TABLE IF EXISTS notices CASCADE;

DROP TYPE IF EXISTS notice_status;
DROP TYPE IF EXISTS notice_category;

COMMIT;
