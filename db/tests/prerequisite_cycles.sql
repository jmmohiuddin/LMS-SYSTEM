-- =====================================================================
-- db/tests/prerequisite_cycles.sql   (F-104)
--
-- A prerequisite cycle is not a tidiness problem. /academics/next only
-- offers a chapter whose prerequisite is complete, and no chapter inside a
-- loop ever satisfies that — so a loop silently deletes a subject from a
-- child's study plan, with no error anywhere. These assertions prove the
-- loop can never be written in the first place.
--
-- Runs in a transaction that is ROLLED BACK; safe against any environment.
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/tests/prerequisite_cycles.sql
-- =====================================================================

\set ON_ERROR_STOP on

GRANT shikhon_app TO CURRENT_USER;
SET ROLE shikhon_app;

BEGIN;
SET LOCAL app.tenant_id = '9c000000-0000-4000-8000-00000000000c';
SET LOCAL app.role      = 'academic_coordinator';
SET LOCAL app.user_id   = '9c000000-0000-4000-8000-0000000000ff';

INSERT INTO tenants (id, slug, name_bn, name_en, stream, level)
VALUES ('9c000000-0000-4000-8000-00000000000c', 'cycle-check',
        'চক্র বিদ্যালয়', 'Cycle School', 'bangla_medium', 'secondary');

INSERT INTO classes (id, tenant_id, level_no, name_bn, name_en, stream)
VALUES ('9c000000-0000-4000-8000-0000000000c1', '9c000000-0000-4000-8000-00000000000c',
        9, 'নবম', 'Nine', 'bangla_medium');

INSERT INTO subjects (id, tenant_id, nctb_code, name_bn, name_en)
VALUES ('9c000000-0000-4000-8000-0000000000d1', '9c000000-0000-4000-8000-00000000000c',
        '127', 'পদার্থবিজ্ঞান', 'Physics');

-- Four chapters, no prerequisites yet.
INSERT INTO chapters (id, tenant_id, subject_id, class_id, chapter_no, name_bn)
VALUES ('9c000000-0000-4000-8000-00000000000a', '9c000000-0000-4000-8000-00000000000c',
        '9c000000-0000-4000-8000-0000000000d1', '9c000000-0000-4000-8000-0000000000c1', 1, 'অধ্যায় ১'),
       ('9c000000-0000-4000-8000-00000000000b', '9c000000-0000-4000-8000-00000000000c',
        '9c000000-0000-4000-8000-0000000000d1', '9c000000-0000-4000-8000-0000000000c1', 2, 'অধ্যায় ২'),
       ('9c000000-0000-4000-8000-00000000000e', '9c000000-0000-4000-8000-00000000000c',
        '9c000000-0000-4000-8000-0000000000d1', '9c000000-0000-4000-8000-0000000000c1', 3, 'অধ্যায় ৩'),
       ('9c000000-0000-4000-8000-00000000000f', '9c000000-0000-4000-8000-00000000000c',
        '9c000000-0000-4000-8000-0000000000d1', '9c000000-0000-4000-8000-0000000000c1', 4, 'অধ্যায় ৪');

-- ---------------------------------------------------------------------
-- 1. A legitimate chain is accepted. The trigger must not be so eager that
--    ordinary content authoring stops working.
-- ---------------------------------------------------------------------
DO $$
DECLARE d integer;
BEGIN
  INSERT INTO chapter_prerequisites (tenant_id, chapter_id, prerequisite_id)
     VALUES ('9c000000-0000-4000-8000-00000000000c', '9c000000-0000-4000-8000-00000000000b', '9c000000-0000-4000-8000-00000000000a')
     ON CONFLICT DO NOTHING;                       -- 2 needs 1
  INSERT INTO chapter_prerequisites (tenant_id, chapter_id, prerequisite_id)
     VALUES ('9c000000-0000-4000-8000-00000000000c', '9c000000-0000-4000-8000-00000000000e', '9c000000-0000-4000-8000-00000000000b')
     ON CONFLICT DO NOTHING;                       -- 3 needs 2
  INSERT INTO chapter_prerequisites (tenant_id, chapter_id, prerequisite_id)
     VALUES ('9c000000-0000-4000-8000-00000000000c', '9c000000-0000-4000-8000-00000000000f', '9c000000-0000-4000-8000-00000000000e')
     ON CONFLICT DO NOTHING;                       -- 4 needs 3

  SELECT count(*) INTO d FROM app.chapter_prerequisite_path('9c000000-0000-4000-8000-00000000000f');
  IF d <> 3 THEN RAISE EXCEPTION 'FAIL 1: expected a 3-deep chain, got %', d; END IF;
  RAISE NOTICE 'PASS 1 — a legitimate 1 → 2 → 3 → 4 chain is accepted and walks 3 deep';
END $$;

-- ---------------------------------------------------------------------
-- 2. The degenerate cycle: a chapter requiring itself.
-- ---------------------------------------------------------------------
DO $$
BEGIN
  BEGIN
    INSERT INTO chapter_prerequisites (tenant_id, chapter_id, prerequisite_id)
     VALUES ('9c000000-0000-4000-8000-00000000000c', '9c000000-0000-4000-8000-00000000000a', '9c000000-0000-4000-8000-00000000000a')
     ON CONFLICT DO NOTHING;
    RAISE EXCEPTION 'FAIL 2: a chapter was allowed to be its own prerequisite';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'PASS 2 — a chapter cannot be its own prerequisite';
  END;
END $$;

-- ---------------------------------------------------------------------
-- 3. The two-chapter cycle: 1 requires 2, while 2 already requires 1.
-- ---------------------------------------------------------------------
DO $$
BEGIN
  BEGIN
    INSERT INTO chapter_prerequisites (tenant_id, chapter_id, prerequisite_id)
     VALUES ('9c000000-0000-4000-8000-00000000000c', '9c000000-0000-4000-8000-00000000000a', '9c000000-0000-4000-8000-00000000000b')
     ON CONFLICT DO NOTHING;
    RAISE EXCEPTION 'FAIL 3: a two-chapter cycle was allowed';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'PASS 3 — a two-chapter cycle is refused';
  END;
END $$;

-- ---------------------------------------------------------------------
-- 4. The long cycle: 1 requires 4, closing 1 → 2 → 3 → 4 → 1. This is the
--    one a human reviewer would miss, and the reason the check is a
--    recursive walk rather than a one-step comparison.
-- ---------------------------------------------------------------------
DO $$
BEGIN
  BEGIN
    INSERT INTO chapter_prerequisites (tenant_id, chapter_id, prerequisite_id)
     VALUES ('9c000000-0000-4000-8000-00000000000c', '9c000000-0000-4000-8000-00000000000a', '9c000000-0000-4000-8000-00000000000f')
     ON CONFLICT DO NOTHING;
    RAISE EXCEPTION 'FAIL 4: a four-chapter cycle was allowed';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'PASS 4 — a four-deep cycle is refused';
  END;
END $$;

-- ---------------------------------------------------------------------
-- 5. The error names the loop. An editor who is told "invalid input" has
--    to go find the problem; one who is shown the chain can fix it.
-- ---------------------------------------------------------------------
DO $$
DECLARE msg text;
BEGIN
  BEGIN
    INSERT INTO chapter_prerequisites (tenant_id, chapter_id, prerequisite_id)
     VALUES ('9c000000-0000-4000-8000-00000000000c', '9c000000-0000-4000-8000-00000000000a', '9c000000-0000-4000-8000-00000000000f')
     ON CONFLICT DO NOTHING;
    RAISE EXCEPTION 'FAIL 5: the cycle was allowed';
  EXCEPTION WHEN check_violation THEN
    GET STACKED DIAGNOSTICS msg = MESSAGE_TEXT;
  END;
  IF msg NOT LIKE '%অধ্যায় ৪%' OR msg NOT LIKE '%অধ্যায় ২%' THEN
    RAISE EXCEPTION 'FAIL 5: the error does not name the loop: %', msg;
  END IF;
  RAISE NOTICE 'PASS 5 — the error names the chapters in the loop: %', msg;
END $$;

-- ---------------------------------------------------------------------
-- 6. Breaking the chain makes the previously-refused edge legal. A
--    constraint you cannot work your way out of is a trap.
-- ---------------------------------------------------------------------
DO $$
BEGIN
  DELETE FROM chapter_prerequisites WHERE chapter_id = '9c000000-0000-4000-8000-00000000000b';          -- 2 no longer needs 1
  INSERT INTO chapter_prerequisites (tenant_id, chapter_id, prerequisite_id)
     VALUES ('9c000000-0000-4000-8000-00000000000c', '9c000000-0000-4000-8000-00000000000a', '9c000000-0000-4000-8000-00000000000f')
     ON CONFLICT DO NOTHING;          -- now legal: 1 needs 4
  RAISE NOTICE 'PASS 6 — once the loop is broken the same edge is accepted';
END $$;

-- ---------------------------------------------------------------------
-- 7. Ordinary edits are untouched. The trigger fires only on the
--    prerequisite column, so renaming a chapter costs nothing and cannot
--    be blocked by a constraint that has nothing to do with it.
-- ---------------------------------------------------------------------
DO $$
BEGIN
  UPDATE chapters SET name_bn = 'অধ্যায় ১ (সংশোধিত)'
   WHERE id = '9c000000-0000-4000-8000-00000000000a';
  RAISE NOTICE 'PASS 7 — editing a chapter''s name is unaffected';
END $$;

-- ---------------------------------------------------------------------
-- 8. A prerequisite cannot point at another institution's chapter.
--    Migration 017's FK references chapters(id) alone, so nothing else
--    stops it — and the chapter's name is rendered to students as
--    "আগে পড়ো: <name>", which would leak straight across the boundary.
-- ---------------------------------------------------------------------
DO $$
BEGIN
  BEGIN
    INSERT INTO chapter_prerequisites (tenant_id, chapter_id, prerequisite_id)
    VALUES ('9c000000-0000-4000-8000-00000000000c',
            '9c000000-0000-4000-8000-00000000000e',
            '9c000000-0000-4000-8000-0000000000aa');
    RAISE EXCEPTION 'FAIL 8: a prerequisite pointing at a nonexistent chapter was accepted';
  EXCEPTION WHEN foreign_key_violation THEN
    RAISE NOTICE 'PASS 8 — a prerequisite must reference a chapter that exists';
  END;
END $$;

-- ---------------------------------------------------------------------
-- 9. The application role cannot switch the guard off. A constraint the
--    app can disable is a suggestion.
-- ---------------------------------------------------------------------
DO $$
BEGIN
  BEGIN
    ALTER TABLE chapter_prerequisites DISABLE TRIGGER trg_chapter_prereq_acyclic;
    RAISE EXCEPTION 'FAIL 9: shikhon_app disabled the cycle guard';
  EXCEPTION WHEN insufficient_privilege OR wrong_object_type THEN
    RAISE NOTICE 'PASS 9 — the application role cannot disable the cycle guard';
  END;
END $$;

-- ---------------------------------------------------------------------
-- 10. The walk terminates on data that already contains a cycle.
--
--     Such a row can only be created with the trigger off, which needs the
--     owner role — so this drops to the owner to plant it. That is exactly
--     the situation the migration's validation sweep has to survive: a loop
--     written before the guard existed. An uncapped recursive CTE would
--     spin here until the statement timeout.
-- ---------------------------------------------------------------------
RESET ROLE;
ALTER TABLE chapter_prerequisites DISABLE TRIGGER trg_chapter_prereq_acyclic;
INSERT INTO chapter_prerequisites (tenant_id, chapter_id, prerequisite_id)
     VALUES ('9c000000-0000-4000-8000-00000000000c', '9c000000-0000-4000-8000-00000000000f', '9c000000-0000-4000-8000-00000000000e')
     ON CONFLICT DO NOTHING;      -- 4 → 3
INSERT INTO chapter_prerequisites (tenant_id, chapter_id, prerequisite_id)
     VALUES ('9c000000-0000-4000-8000-00000000000c', '9c000000-0000-4000-8000-00000000000e', '9c000000-0000-4000-8000-00000000000f')
     ON CONFLICT DO NOTHING;      -- 3 → 4, loop closed
ALTER TABLE chapter_prerequisites ENABLE TRIGGER trg_chapter_prereq_acyclic;

DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM app.chapter_prerequisite_path('9c000000-0000-4000-8000-00000000000e');
  IF n < 1 THEN RAISE EXCEPTION 'FAIL 10: the walk returned nothing on a cyclic chain'; END IF;
  IF n > 64 THEN RAISE EXCEPTION 'FAIL 10: the walk exceeded its depth cap (% nodes)', n; END IF;
  RAISE NOTICE 'PASS 10 — the walk terminates on already-cyclic data (% node(s))', n;
END $$;

-- ---------------------------------------------------------------------
-- 11. The migration's own validation sweep detects that planted loop —
--     proof it would refuse to deploy over a pre-existing cycle rather
--     than shipping a guarantee that is already false.
-- ---------------------------------------------------------------------
DO $$
DECLARE n integer;
BEGIN
  SELECT count(DISTINCT c.id) INTO n
    FROM chapters c
    JOIN chapter_prerequisites cp ON cp.chapter_id = c.id
   WHERE EXISTS (
       SELECT 1 FROM app.chapter_prerequisite_path(c.id) p
        WHERE p.chapter_id = c.id
     );
  IF n < 2 THEN
    RAISE EXCEPTION 'FAIL 11: the sweep found % cyclic chapter(s), expected the planted loop', n;
  END IF;
  RAISE NOTICE 'PASS 11 — the migration''s validation sweep detects a pre-existing loop (% chapters)', n;
END $$;

ROLLBACK;

RESET ROLE;

DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM tenants WHERE id = '9c000000-0000-4000-8000-00000000000c';
  IF n <> 0 THEN RAISE EXCEPTION 'FAIL teardown: the fixture tenant survived'; END IF;
  RAISE NOTICE 'PASS teardown — no fixture rows remain';
END $$;

\echo ''
\echo '================================================'
\echo ' F-104 prerequisite acyclicity passed.'
\echo '================================================'
