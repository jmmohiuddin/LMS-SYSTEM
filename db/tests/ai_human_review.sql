-- =====================================================================
-- db/tests/ai_human_review.sql   (F-1304)
--
-- "Nothing AI-generated reaches a student without a named human
-- publishing it" is a stated invariant. These assertions are what make it
-- a fact rather than an intention.
--
-- The failure this is really guarding against is not somebody deliberately
-- skipping review. It is review going STALE: an item approved in March,
-- reworded in June, still carrying is_approved = true and a reviewer who
-- never saw the new wording.
--
-- Runs in a transaction that is ROLLED BACK; safe against any environment.
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/tests/ai_human_review.sql
-- =====================================================================

\set ON_ERROR_STOP on

GRANT shikhon_app TO CURRENT_USER;
SET ROLE shikhon_app;

BEGIN;
SET LOCAL app.tenant_id = '9b000000-0000-4000-8000-00000000000b';
SET LOCAL app.role      = 'subject_teacher';
SET LOCAL app.user_id   = '9b000000-0000-4000-8000-0000000000a1';

INSERT INTO tenants (id, slug, name_bn, name_en, stream, level)
VALUES ('9b000000-0000-4000-8000-00000000000b', 'ai-review-check',
        'পর্যালোচনা বিদ্যালয়', 'Review School', 'bangla_medium', 'secondary');

INSERT INTO users (id, tenant_id, full_name_bn, full_name_en, phone_e164)
VALUES ('9b000000-0000-4000-8000-0000000000a1', '9b000000-0000-4000-8000-00000000000b',
        'শিক্ষক', 'Teacher', '+8801796000001');

INSERT INTO classes (id, tenant_id, level_no, name_bn, name_en, stream)
VALUES ('9b000000-0000-4000-8000-0000000000c1', '9b000000-0000-4000-8000-00000000000b',
        9, 'নবম', 'Nine', 'bangla_medium');

INSERT INTO subjects (id, tenant_id, nctb_code, name_bn, name_en)
VALUES ('9b000000-0000-4000-8000-0000000000c2', '9b000000-0000-4000-8000-00000000000b',
        '127', 'পদার্থবিজ্ঞান', 'Physics');

-- content_hash is NOT NULL in migration 005 but is now computed by the
-- trigger, so anything passed here is replaced. Passing junk on purpose:
-- if the trigger ever stops computing it, assertion 6 fails loudly.
INSERT INTO question_items
  (id, tenant_id, subject_id, class_id, type, stem_text, total_marks,
   source, content_hash, created_by)
VALUES ('9b000000-0000-4000-8000-0000000000e1', '9b000000-0000-4000-8000-00000000000b',
        '9b000000-0000-4000-8000-0000000000c2', '9b000000-0000-4000-8000-0000000000c1',
        'mcq', 'গতির একক কী?', 1, 'manual', '\x00'::bytea,
        '9b000000-0000-4000-8000-0000000000a1');

-- ---------------------------------------------------------------------
-- 1. A new item is NOT approved. Nothing arrives student-ready.
-- ---------------------------------------------------------------------
DO $$
DECLARE ok boolean; n integer;
BEGIN
  SELECT is_approved INTO ok FROM question_items
   WHERE id = '9b000000-0000-4000-8000-0000000000e1';
  IF ok THEN RAISE EXCEPTION 'FAIL 1: a freshly created item was already approved'; END IF;

  SELECT count(*) INTO n FROM student_ready_question_items;
  IF n <> 0 THEN RAISE EXCEPTION 'FAIL 1: % unreviewed item(s) are student-ready', n; END IF;
  RAISE NOTICE 'PASS 1 — a new item is unapproved and not student-ready';
END $$;

-- ---------------------------------------------------------------------
-- 2. Approval without a named reviewer is refused. The flag alone is not
--    a review, and this is the whole invariant in one assertion.
-- ---------------------------------------------------------------------
DO $$
BEGIN
  BEGIN
    UPDATE question_items SET is_approved = true
     WHERE id = '9b000000-0000-4000-8000-0000000000e1';
    RAISE EXCEPTION 'FAIL 2: an item was approved with no reviewer';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'PASS 2 — approval without a named reviewer is refused';
  END;
END $$;

-- ---------------------------------------------------------------------
-- 3. Approval WITH a named reviewer works, and the database stamps the
--    time rather than believing the caller.
-- ---------------------------------------------------------------------
DO $$
DECLARE t timestamptz; n integer;
BEGIN
  UPDATE question_items
     SET is_approved = true,
         reviewed_by = '9b000000-0000-4000-8000-0000000000a1',
         reviewed_at = '1999-01-01'          -- a lie the trigger must overwrite
   WHERE id = '9b000000-0000-4000-8000-0000000000e1';

  SELECT reviewed_at INTO t FROM question_items
   WHERE id = '9b000000-0000-4000-8000-0000000000e1';
  IF t < now() - interval '1 minute' THEN
    RAISE EXCEPTION 'FAIL 3: reviewed_at was taken from the caller (%)', t;
  END IF;

  SELECT count(*) INTO n FROM student_ready_question_items;
  IF n <> 1 THEN RAISE EXCEPTION 'FAIL 3: approved item is not student-ready'; END IF;
  RAISE NOTICE 'PASS 3 — a named reviewer approves it, and the DB stamps the time';
END $$;

-- ---------------------------------------------------------------------
-- 4. THE ONE THAT MATTERS. Editing the stem of an approved item revokes
--    its approval. Review goes stale far more often than it gets skipped.
-- ---------------------------------------------------------------------
DO $$
DECLARE ok boolean; who uuid; n integer;
BEGIN
  UPDATE question_items SET stem_text = 'গতির একক কী? (সংশোধিত)'
   WHERE id = '9b000000-0000-4000-8000-0000000000e1';

  SELECT is_approved, reviewed_by INTO ok, who FROM question_items
   WHERE id = '9b000000-0000-4000-8000-0000000000e1';
  IF ok THEN
    RAISE EXCEPTION 'FAIL 4: an approved item was reworded and stayed approved';
  END IF;
  IF who IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL 4: the stale reviewer is still recorded as having approved it';
  END IF;

  SELECT count(*) INTO n FROM student_ready_question_items;
  IF n <> 0 THEN RAISE EXCEPTION 'FAIL 4: the edited item is still student-ready'; END IF;
  RAISE NOTICE 'PASS 4 — editing approved content revokes the approval and the reviewer';
END $$;

-- ---------------------------------------------------------------------
-- 5. Changing the correct ANSWER revokes approval too, even though the
--    stem is untouched. An MCQ whose right answer moved is a different
--    question, and the approval described the other one.
-- ---------------------------------------------------------------------
DO $$
DECLARE ok boolean;
BEGIN
  UPDATE question_items
     SET is_approved = true, reviewed_by = '9b000000-0000-4000-8000-0000000000a1'
   WHERE id = '9b000000-0000-4000-8000-0000000000e1';

  INSERT INTO question_item_options (tenant_id, item_id, ordinal, label, option_text, is_correct)
  VALUES ('9b000000-0000-4000-8000-00000000000b', '9b000000-0000-4000-8000-0000000000e1',
          1, 'ক', 'মিটার/সেকেন্ড', true);

  SELECT is_approved INTO ok FROM question_items
   WHERE id = '9b000000-0000-4000-8000-0000000000e1';
  IF ok THEN
    RAISE EXCEPTION 'FAIL 5: adding an option left the parent item approved';
  END IF;
  RAISE NOTICE 'PASS 5 — editing an option revokes the parent item''s approval';
END $$;

-- ---------------------------------------------------------------------
-- 6. content_hash is computed, not accepted. Assertion 4 depends on it —
--    a caller that could set the hash could edit content and keep its
--    approval.
-- ---------------------------------------------------------------------
DO $$
DECLARE h bytea; expect bytea;
BEGIN
  SELECT content_hash INTO h FROM question_items
   WHERE id = '9b000000-0000-4000-8000-0000000000e1';
  IF h = '\x00'::bytea THEN
    RAISE EXCEPTION 'FAIL 6: the caller-supplied content_hash survived';
  END IF;

  SELECT app.question_item_content_hash(
           i.type::text, i.language, i.stem_text, i.stem_media_key,
           i.difficulty::text, i.total_marks)
    INTO expect
    FROM question_items i WHERE i.id = '9b000000-0000-4000-8000-0000000000e1';
  IF h <> expect THEN
    RAISE EXCEPTION 'FAIL 6: stored hash does not match the content';
  END IF;
  RAISE NOTICE 'PASS 6 — content_hash is derived from the content, not the caller';
END $$;

-- ---------------------------------------------------------------------
-- 7. AI-generated items must carry their provenance. A bad generated
--    question you cannot trace back to the call that made it is a bad
--    question you cannot stop making.
-- ---------------------------------------------------------------------
DO $$
BEGIN
  BEGIN
    INSERT INTO question_items
      (tenant_id, subject_id, class_id, type, stem_text, total_marks,
       source, ai_session_id, content_hash, created_by)
    VALUES ('9b000000-0000-4000-8000-00000000000b',
            '9b000000-0000-4000-8000-0000000000c2', '9b000000-0000-4000-8000-0000000000c1',
            'mcq', 'এআই প্রশ্ন', 1, 'sikhok_ai', NULL, '\x00'::bytea,
            '9b000000-0000-4000-8000-0000000000a1');
    RAISE EXCEPTION 'FAIL 7: an AI-generated item was stored with no ai_session_id';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'PASS 7 — AI-generated items must record which session produced them';
  END;
END $$;

-- ---------------------------------------------------------------------
-- 8. An AI-generated item lands UNAPPROVED and stays out of the
--    student-ready set until a human signs it off. This is the invariant
--    stated end to end.
-- ---------------------------------------------------------------------
DO $$
DECLARE ok boolean; n_before integer; n_after integer;
BEGIN
  SELECT count(*) INTO n_before FROM student_ready_question_items;

  INSERT INTO question_items
    (id, tenant_id, subject_id, class_id, type, stem_text, total_marks,
     source, ai_session_id, content_hash, created_by)
  VALUES ('9b000000-0000-4000-8000-0000000000e2', '9b000000-0000-4000-8000-00000000000b',
          '9b000000-0000-4000-8000-0000000000c2', '9b000000-0000-4000-8000-0000000000c1',
          'mcq', 'এআই-তৈরি প্রশ্ন', 1, 'sikhok_ai',
          '9b000000-0000-4000-8000-0000000000d9', '\x00'::bytea,
          '9b000000-0000-4000-8000-0000000000a1');

  SELECT is_approved INTO ok FROM question_items
   WHERE id = '9b000000-0000-4000-8000-0000000000e2';
  IF ok THEN RAISE EXCEPTION 'FAIL 8: AI-generated content arrived pre-approved'; END IF;

  SELECT count(*) INTO n_after FROM student_ready_question_items;
  IF n_after <> n_before THEN
    RAISE EXCEPTION 'FAIL 8: AI-generated content reached the student-ready set unreviewed';
  END IF;

  -- Now a named human signs it off, and only then does it become usable.
  UPDATE question_items
     SET is_approved = true, reviewed_by = '9b000000-0000-4000-8000-0000000000a1'
   WHERE id = '9b000000-0000-4000-8000-0000000000e2';

  SELECT count(*) INTO n_after FROM student_ready_question_items;
  IF n_after <> n_before + 1 THEN
    RAISE EXCEPTION 'FAIL 8: reviewed AI content did not become student-ready';
  END IF;
  RAISE NOTICE 'PASS 8 — AI content is student-ready only after a named human approves it';
END $$;

-- ---------------------------------------------------------------------
-- 9. A soft-deleted item leaves the student-ready set even while approved.
-- ---------------------------------------------------------------------
DO $$
DECLARE n integer;
BEGIN
  UPDATE question_items SET deleted_at = now()
   WHERE id = '9b000000-0000-4000-8000-0000000000e2';
  SELECT count(*) INTO n FROM student_ready_question_items
   WHERE id = '9b000000-0000-4000-8000-0000000000e2';
  IF n <> 0 THEN RAISE EXCEPTION 'FAIL 9: a deleted item is still student-ready'; END IF;
  RAISE NOTICE 'PASS 9 — a withdrawn item stops being student-ready';
END $$;

ROLLBACK;

RESET ROLE;

DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM tenants WHERE id = '9b000000-0000-4000-8000-00000000000b';
  IF n <> 0 THEN RAISE EXCEPTION 'FAIL teardown: the fixture tenant survived'; END IF;
  RAISE NOTICE 'PASS teardown — no fixture rows remain';
END $$;

\echo ''
\echo '================================================'
\echo ' F-1304 human review of AI content passed.'
\echo '================================================'
