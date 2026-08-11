-- ============================================================================
-- 024 — Nothing AI-generated reaches a student without a named human
--       publishing it  (F-1304)
--
-- This is a stated invariant of the product, and it currently has no
-- enforcement anywhere. Migration 005 gave question_items the right columns
-- — source, ai_session_id, reviewed_by, reviewed_at, is_approved — and, as
-- with the encryption columns in F-101 and row_version in F-103, nothing
-- has ever written or checked them. `is_approved` appears in exactly zero
-- lines of application code.
--
-- Nothing is violated *today*: the AI gateway ships dark, and even with a
-- key set, /api/v1/ai/sikhok returns Markdown to the teacher's screen and
-- persists nothing. The gap is that the moment somebody adds the obvious
-- next feature — "save this generated question to the item bank" — there is
-- nothing to stop it landing approved, and no reason for the author of that
-- feature to know they were supposed to add a gate.
--
-- So the gate goes in first, while the path that would violate it does not
-- exist yet. That is the cheapest this will ever be.
--
-- ── What is enforced ─────────────────────────────────────────────────────
--   1. Approval requires a named human and a timestamp. Not a flag anyone
--      can set alone.
--   2. reviewed_at is set by the database, not accepted from the caller.
--   3. AI-generated items must keep their provenance (ai_session_id), so
--      "which model call produced this question?" is always answerable.
--   4. Editing the content of an approved item REVOKES its approval.
--      This is the one that matters in practice. Review does not get
--      skipped; review goes stale. An item approved in March and reworded
--      in June is a question no human has ever signed off, and without
--      this it would still read is_approved = true.
--
-- Deliberately NOT enforced: that the reviewer be someone other than the
-- author. A subject teacher generating a question with SikhokAI and then
-- reading it properly IS the human review this invariant asks for. Demanding
-- a second person would be a workflow decision nobody asked for, and in a
-- school with one physics teacher it would mean the feature cannot be used
-- at all.
-- ============================================================================
BEGIN;

-- ---------------------------------------------------------------------
-- Content hash: what "the content changed" means, computed rather than
-- trusted. Migration 005 declared content_hash NOT NULL and left it to the
-- caller, which cannot work as a staleness signal — a caller that edits the
-- stem and leaves the hash alone would keep its approval.
--
-- Covers the item's own text and marks. Parts and options are handled
-- separately below, because they live in other tables.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.question_item_content_hash(
  p_type text, p_language text, p_stem text, p_media text,
  p_difficulty text, p_marks numeric
) RETURNS bytea
LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $$
  SELECT sha256(convert_to(
    coalesce(p_type,'') || E'' || coalesce(p_language,'') || E''
    || coalesce(p_stem,'') || E'' || coalesce(p_media,'') || E''
    || coalesce(p_difficulty,'') || E'' || coalesce(p_marks,0)::text,
    'UTF8'))
$$;

COMMENT ON FUNCTION app.question_item_content_hash IS
  'Canonical hash of a question item''s reviewable content. Unit separators '
  'between fields so that moving text across a boundary changes the hash.';

-- ---------------------------------------------------------------------
-- The gate.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.enforce_item_human_review()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE v_hash bytea;
BEGIN
  v_hash := app.question_item_content_hash(
    NEW.type::text, NEW.language, NEW.stem_text, NEW.stem_media_key,
    NEW.difficulty::text, NEW.total_marks);

  -- Computed, never accepted from the caller — see the header.
  NEW.content_hash := v_hash;

  IF TG_OP = 'UPDATE' AND OLD.content_hash IS DISTINCT FROM v_hash AND OLD.is_approved THEN
    -- Review went stale. Revoke rather than refuse the edit: blocking the
    -- edit would push people into deleting and re-creating the item, which
    -- loses its usage history and its provenance.
    NEW.is_approved := false;
    NEW.reviewed_by := NULL;
    NEW.reviewed_at := NULL;
    RAISE NOTICE 'item % was edited after approval; approval revoked and must be re-reviewed', NEW.id;
  END IF;

  IF NEW.is_approved THEN
    IF NEW.reviewed_by IS NULL THEN
      RAISE EXCEPTION
        'a question item cannot be approved without a named reviewer'
        USING ERRCODE = 'check_violation',
              HINT = 'set reviewed_by to the user who actually read it';
    END IF;
    -- Stamped here so "approved at" is the moment the database accepted it,
    -- not a time the caller chose.
    IF NEW.reviewed_at IS NULL
       OR (TG_OP = 'UPDATE' AND NOT OLD.is_approved) THEN
      NEW.reviewed_at := now();
    END IF;
  ELSE
    -- Not approved: no reviewer stamp may linger and imply one.
    NEW.reviewed_at := NULL;
  END IF;

  IF NEW.source = 'sikhok_ai' AND NEW.ai_session_id IS NULL THEN
    RAISE EXCEPTION
      'an AI-generated item must record the ai_session_id that produced it'
      USING ERRCODE = 'check_violation',
            HINT = 'provenance is what makes a bad generated question traceable';
  END IF;

  RETURN NEW;
END $$;

COMMENT ON FUNCTION app.enforce_item_human_review IS
  'F-1304. Approval requires a named human; reviewed_at is stamped by the '
  'database; editing approved content revokes the approval; AI-generated '
  'items must keep their provenance.';

CREATE TRIGGER trg_items_human_review
  BEFORE INSERT OR UPDATE ON question_items
  FOR EACH ROW EXECUTE FUNCTION app.enforce_item_human_review();

-- Belt as well as braces: the trigger can be disabled by the owner, a
-- CHECK constraint cannot be bypassed by anyone the application can be.
ALTER TABLE question_items
  ADD CONSTRAINT question_items_approved_needs_reviewer
    CHECK (NOT is_approved OR (reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL)),
  ADD CONSTRAINT question_items_ai_needs_provenance
    CHECK (source <> 'sikhok_ai' OR ai_session_id IS NOT NULL);

-- ---------------------------------------------------------------------
-- Parts and options are content too.
--
-- An MCQ whose stem is untouched but whose correct answer has been moved
-- from ক to খ is a different question. Without this, that edit leaves the
-- item approved on the strength of a review that saw the other answer.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.revoke_item_approval_on_child_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE v_item uuid;
BEGIN
  v_item := CASE TG_OP WHEN 'DELETE' THEN OLD.item_id ELSE NEW.item_id END;

  UPDATE question_items
     SET is_approved = false, reviewed_by = NULL, reviewed_at = NULL
   WHERE id = v_item AND is_approved;

  RETURN CASE TG_OP WHEN 'DELETE' THEN OLD ELSE NEW END;
END $$;

COMMENT ON FUNCTION app.revoke_item_approval_on_child_change IS
  'F-1304. Changing an option or a CQ part changes the question, so the '
  'parent item''s approval no longer describes what a human read.';

CREATE TRIGGER trg_item_parts_revoke_approval
  AFTER INSERT OR UPDATE OR DELETE ON question_item_parts
  FOR EACH ROW EXECUTE FUNCTION app.revoke_item_approval_on_child_change();

CREATE TRIGGER trg_item_options_revoke_approval
  AFTER INSERT OR UPDATE OR DELETE ON question_item_options
  FOR EACH ROW EXECUTE FUNCTION app.revoke_item_approval_on_child_change();

-- ---------------------------------------------------------------------
-- The read the rest of the system must use.
--
-- Any future "put questions on a paper" feature should select from here,
-- not from question_items, so that "approved" is the default rather than
-- something each caller has to remember to filter on.
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW student_ready_question_items AS
  SELECT * FROM question_items
   WHERE is_approved
     AND reviewed_by IS NOT NULL
     AND deleted_at IS NULL;

COMMENT ON VIEW student_ready_question_items IS
  'F-1304. The only set of items fit to put in front of a student. Build '
  'paper generation on this, never on question_items directly — a filter '
  'you have to remember is a filter someone will forget.';

GRANT SELECT ON student_ready_question_items TO shikhon_app;

-- Finding unreviewed AI output is the queue a teacher works through.
CREATE INDEX ix_items_awaiting_review ON question_items (tenant_id, created_at DESC)
  WHERE NOT is_approved AND deleted_at IS NULL;

COMMIT;
