-- Rollback for 022 — prerequisite cycle prevention (F-104).
--
-- Note that rolling back does NOT restore any self-reference the migration
-- cleared. That is intentional: A → A carried no information, and
-- re-creating it would only put a chapter back into the unreachable state.
BEGIN;

DROP INDEX IF EXISTS ix_chapters_prerequisite;

DROP TRIGGER IF EXISTS trg_chapters_no_prerequisite_cycle ON chapters;
DROP FUNCTION IF EXISTS app.prevent_prerequisite_cycle();
DROP FUNCTION IF EXISTS app.chapter_prerequisite_path(uuid);

COMMIT;
