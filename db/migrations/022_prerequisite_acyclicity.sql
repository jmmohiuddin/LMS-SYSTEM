-- ============================================================================
-- 022 — Prerequisite cycle prevention  (F-104, TRD §5.4)
--
-- chapters.prerequisite_chapter_id is a self-reference with no acyclicity
-- guarantee. Nothing stops A → B → C → A, or the degenerate A → A.
--
-- ── Why this is not a cosmetic constraint ────────────────────────────────
-- Two live read paths walk this pointer:
--
--   /academics/next     rule 4 offers "a new chapter whose prerequisite is
--                       complete". In a cycle no chapter in the loop ever
--                       has a complete prerequisite, so every chapter in
--                       the loop becomes permanently unofferable. A student
--                       is silently told there is nothing to study next.
--   /academics/chapters renders "আগে পড়ো: <chapter>". In a cycle this is
--                       an instruction that cannot be followed.
--
-- A cycle is therefore not a data-quality nit — it is a way for a
-- content-editing mistake to quietly remove a subject from a child's
-- learning path with no error anywhere.
--
-- ── Against the flat FK, deliberately ────────────────────────────────────
-- TRD §5.3 sketches a `chapter_prerequisites` junction table for a real
-- DAG. Migration 017 shipped a flat single-parent FK instead, on the
-- reasoning that a knowledge graph needs assessment data to infer edges
-- from and does not exist yet. That flat pointer is what /academics/next
-- and /academics/chapters read today.
--
-- So this constrains what exists rather than introducing the junction
-- table first: swapping the model would mean migrating both live read
-- paths, which is a different piece of work from "prevent cycles" and
-- would bundle two changes into one. The trigger below walks the chain
-- with a recursive CTE — exactly the shape TRD §5.4 specifies — so when
-- the DAG upgrade lands, the walk generalises from one edge per node to
-- many without being rewritten.
-- ============================================================================
BEGIN;

-- ---------------------------------------------------------------------
-- app.chapter_prerequisite_path()
--
-- The ancestor chain above a chapter, nearest first. Exposed as its own
-- function rather than inlined in the trigger because the error message
-- needs it too: telling an editor "that would create a cycle" is much less
-- useful than showing them the loop they are about to close.
--
-- The depth cap is a safety net, not a policy. If a cycle somehow already
-- exists — a row written before this migration, or via a path that
-- bypasses the trigger — an uncapped recursive CTE would spin until the
-- statement timeout. UNION (not UNION ALL) already prunes repeats; the cap
-- is what makes the function safe to call on data this migration has not
-- yet validated.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.chapter_prerequisite_path(p_start uuid)
RETURNS TABLE (chapter_id uuid, depth integer, name_bn text)
LANGUAGE sql
STABLE
AS $$
  WITH RECURSIVE chain AS (
    SELECT c.prerequisite_chapter_id AS id, 1 AS depth
      FROM chapters c
     WHERE c.id = p_start
       AND c.prerequisite_chapter_id IS NOT NULL
    UNION
    SELECT c.prerequisite_chapter_id, ch.depth + 1
      FROM chain ch
      JOIN chapters c ON c.id = ch.id
     WHERE c.prerequisite_chapter_id IS NOT NULL
       AND ch.depth < 64
  )
  SELECT ch.id, ch.depth, c.name_bn
    FROM chain ch
    JOIN chapters c ON c.id = ch.id
   ORDER BY ch.depth
$$;

COMMENT ON FUNCTION app.chapter_prerequisite_path IS
  'Ancestor chain above a chapter, nearest first. Safe to call on data that '
  'may contain a cycle: UNION prunes repeats and the depth cap bounds the walk.';

-- ---------------------------------------------------------------------
-- The trigger.
--
-- Fires only when the pointer actually changes, so ordinary edits to a
-- chapter's name or order pay nothing. Runs BEFORE the write, so a cycle
-- is never briefly visible to a concurrent reader.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.prevent_prerequisite_cycle()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_loop text;
  v_pre_tenant uuid;
  v_pre_name text;
BEGIN
  IF NEW.prerequisite_chapter_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- The degenerate case, worth its own message: "a chapter cannot require
  -- itself" is what the editor needs to read, not a path of length one.
  IF NEW.prerequisite_chapter_id = NEW.id THEN
    RAISE EXCEPTION 'a chapter cannot be its own prerequisite'
      USING ERRCODE = 'check_violation', HINT = 'clear the prerequisite, or point it at a different chapter';
  END IF;

  -- A prerequisite must belong to the same institution. The FK in
  -- migration 017 references chapters(id) alone, so nothing else stops one
  -- school's chapter from pointing at another's — which would leak the
  -- other school's chapter name straight into "আগে পড়ো:".
  SELECT tenant_id, name_bn INTO v_pre_tenant, v_pre_name
    FROM chapters WHERE id = NEW.prerequisite_chapter_id;
  IF v_pre_tenant IS NULL THEN
    RAISE EXCEPTION 'prerequisite chapter % does not exist', NEW.prerequisite_chapter_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF v_pre_tenant <> NEW.tenant_id THEN
    RAISE EXCEPTION 'a prerequisite must belong to the same institution'
      USING ERRCODE = 'check_violation';
  END IF;

  -- Walk up from the proposed parent. If this chapter appears anywhere in
  -- its own ancestry, the edge closes a loop.
  --
  -- Evaluated against the row's CURRENT state (the BEFORE trigger has not
  -- written yet), so the walk starts one step up and cannot see the edge
  -- being proposed. That is why the check is `NEW.id IN (path of parent)`
  -- and not `... of NEW.id`.
  IF EXISTS (
    SELECT 1 FROM app.chapter_prerequisite_path(NEW.prerequisite_chapter_id) p
     WHERE p.chapter_id = NEW.id
  ) THEN
    -- chapter_prerequisite_path returns the ancestors OF the parent, so the
    -- parent itself has to be prepended or the printed loop skips the very
    -- chapter the editor just selected — the most confusing gap possible.
    SELECT v_pre_name || COALESCE(' → ' || string_agg(p.name_bn, ' → ' ORDER BY p.depth), '')
      INTO v_loop
      FROM app.chapter_prerequisite_path(NEW.prerequisite_chapter_id) p;

    RAISE EXCEPTION
      'this prerequisite would create a loop: % → %', NEW.name_bn, v_loop
      USING ERRCODE = 'check_violation',
            HINT = 'every chapter in a loop becomes permanently unreachable in "what to study next"';
  END IF;

  RETURN NEW;
END $$;

COMMENT ON FUNCTION app.prevent_prerequisite_cycle IS
  'F-104. Refuses a prerequisite edge that would close a cycle, and names '
  'the loop in the error so a content editor can see what they were about '
  'to do. Also enforces same-tenant, which the plain FK cannot.';

CREATE TRIGGER trg_chapters_no_prerequisite_cycle
  BEFORE INSERT OR UPDATE OF prerequisite_chapter_id ON chapters
  FOR EACH ROW
  WHEN (NEW.prerequisite_chapter_id IS NOT NULL)
  EXECUTE FUNCTION app.prevent_prerequisite_cycle();

-- ---------------------------------------------------------------------
-- Validate what is already stored.
--
-- The trigger only governs writes from here on. If a cycle was written
-- before this migration, every read path stays broken and the trigger will
-- never fire on it. Fail the migration loudly rather than deploy a
-- guarantee that is already false — a silent pre-existing cycle is exactly
-- the bug this is meant to make impossible.
--
-- Self-references are repaired automatically: A → A carries no information
-- that clearing it would lose, and refusing to deploy over one would be
-- pedantry. Longer loops are not touched, because which edge to cut is a
-- content decision.
-- ---------------------------------------------------------------------
DO $$
DECLARE n bigint; bad record; report text := '';
BEGIN
  UPDATE chapters SET prerequisite_chapter_id = NULL
   WHERE prerequisite_chapter_id = id;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN
    RAISE NOTICE 'cleared % self-referencing prerequisite(s)', n;
  END IF;

  FOR bad IN
    SELECT c.id, c.name_bn
      FROM chapters c
     WHERE c.prerequisite_chapter_id IS NOT NULL
       AND EXISTS (
         SELECT 1 FROM app.chapter_prerequisite_path(c.prerequisite_chapter_id) p
          WHERE p.chapter_id = c.id
       )
  LOOP
    report := report || format(E'\n  %s (%s)', bad.name_bn, bad.id);
  END LOOP;

  IF report <> '' THEN
    RAISE EXCEPTION
      'existing prerequisite cycle(s) must be broken before this migration can apply:%', report
      USING HINT = 'clear prerequisite_chapter_id on one chapter in each loop, then re-run';
  END IF;
END $$;

-- Supports the upward walk: the recursive CTE joins on chapters.id (the
-- primary key) but the validation sweep above and any future
-- "what depends on this chapter" query read the other direction.
CREATE INDEX ix_chapters_prerequisite ON chapters (prerequisite_chapter_id)
  WHERE prerequisite_chapter_id IS NOT NULL;

COMMIT;
