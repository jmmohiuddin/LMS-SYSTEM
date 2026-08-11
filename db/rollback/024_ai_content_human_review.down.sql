-- Rollback for 024 — human review of AI-generated content (F-1304).
--
-- Rolling this back removes the only enforcement of a stated product
-- invariant: that nothing AI-generated reaches a student without a named
-- human publishing it. Do it only if 024 itself broke something.
--
-- It does not un-approve anything, and does not clear any reviewer already
-- recorded. Those are true statements about who read what, and a rollback
-- has no business rewriting them.
BEGIN;

DROP INDEX IF EXISTS ix_items_awaiting_review;
DROP VIEW IF EXISTS student_ready_question_items;

DROP TRIGGER IF EXISTS trg_item_options_revoke_approval ON question_item_options;
DROP TRIGGER IF EXISTS trg_item_parts_revoke_approval ON question_item_parts;
DROP FUNCTION IF EXISTS app.revoke_item_approval_on_child_change();

ALTER TABLE question_items
  DROP CONSTRAINT IF EXISTS question_items_approved_needs_reviewer,
  DROP CONSTRAINT IF EXISTS question_items_ai_needs_provenance;

DROP TRIGGER IF EXISTS trg_items_human_review ON question_items;
DROP FUNCTION IF EXISTS app.enforce_item_human_review();
DROP FUNCTION IF EXISTS app.question_item_content_hash(text, text, text, text, text, numeric);

COMMIT;
