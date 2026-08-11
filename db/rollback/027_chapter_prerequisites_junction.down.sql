-- Rollback for 027 — chapter_prerequisites junction.
--
-- LOSSY, and not symmetrically so. The flat column holds ONE prerequisite;
-- the junction holds many. Rolling back keeps the lowest-ordered edge per
-- chapter and DISCARDS the rest. A chapter that needed both vectors and
-- trigonometry comes back needing only one, and nothing records which was
-- dropped. Restore the F-104 guarantee on the column afterwards by
-- re-applying migration 022.
BEGIN;

ALTER TABLE chapters
  ADD COLUMN prerequisite_chapter_id uuid REFERENCES chapters(id) ON DELETE SET NULL;

UPDATE chapters c
   SET prerequisite_chapter_id = (
     SELECT cp.prerequisite_id FROM chapter_prerequisites cp
      WHERE cp.chapter_id = c.id
      ORDER BY cp.display_order, cp.prerequisite_id
      LIMIT 1);

DROP TRIGGER IF EXISTS trg_chapter_prereq_acyclic ON chapter_prerequisites;
DROP TABLE IF EXISTS chapter_prerequisites;
DROP FUNCTION IF EXISTS app.assert_prereq_acyclic();
DROP FUNCTION IF EXISTS app.chapter_prerequisite_path(uuid);

CREATE INDEX ix_chapters_prerequisite ON chapters (prerequisite_chapter_id)
  WHERE prerequisite_chapter_id IS NOT NULL;

COMMIT;
