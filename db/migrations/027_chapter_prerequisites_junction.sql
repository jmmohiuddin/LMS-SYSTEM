-- ============================================================================
-- 027 — chapter_prerequisites as a junction  (TRD §5.3, §5.4; F-104, F-1404)
--
-- Migration 017 modelled a prerequisite as a single self-referencing column,
-- `chapters.prerequisite_chapter_id`. TRD §5.3 specifies a junction table,
-- and F-1404 is explicit about why:
--
--   "V2: flat, human-authored prerequisite tags per chapter … V3: upgrade to
--    a directed graph with prerequisite inference from co-occurring mistakes."
--
-- A single column cannot express "this chapter needs BOTH vectors and
-- trigonometry", which is the ordinary case in physics and higher maths. It
-- is not a graph yet — edges are still human-authored — but the shape now
-- admits more than one parent, so the V3 upgrade is data, not a migration of
-- every read path a second time.
--
-- ── What this replaces ───────────────────────────────────────────────────
-- Migration 022 put the acyclicity guarantee (F-104) on the flat column.
-- That guarantee moves here intact: same recursive-CTE reachability test,
-- same depth cap, same named-loop error message. The flat column is dropped
-- only after its data is copied, and the two live read paths
-- (/academics/next rule 4, /academics/chapters) move in the same commit.
--
-- ── Why the depth cap survives the move ──────────────────────────────────
-- With multiple parents the walk fans out rather than following a chain, so
-- an uncapped CTE on cyclic data is worse here than it was on the column,
-- not better. UNION still prunes repeats; the cap still bounds the rest.
-- ============================================================================
BEGIN;

CREATE TABLE chapter_prerequisites (
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  chapter_id      uuid NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
  prerequisite_id uuid NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
  -- Ordering matters for display: "read A, then B" is advice, and advice
  -- with a stable order is easier to follow.
  display_order   smallint NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, chapter_id, prerequisite_id),
  -- The one-node cycle, caught by a constraint rather than the trigger
  -- because it needs no walk.
  CHECK (chapter_id <> prerequisite_id)
);

CREATE INDEX ix_chapter_prereq_reverse
  ON chapter_prerequisites (tenant_id, prerequisite_id);

COMMENT ON TABLE chapter_prerequisites IS
  'F-1404 V2: flat, human-authored prerequisite edges. A junction rather than '
  'a column because a chapter routinely needs more than one predecessor. '
  'Acyclicity is enforced by trigger — see app.assert_prereq_acyclic.';

-- ---------------------------------------------------------------------
-- Carry the existing edges across before anything reads the new table.
-- ---------------------------------------------------------------------
INSERT INTO chapter_prerequisites (tenant_id, chapter_id, prerequisite_id)
SELECT tenant_id, id, prerequisite_chapter_id
  FROM chapters
 WHERE prerequisite_chapter_id IS NOT NULL
   AND prerequisite_chapter_id <> id;

-- ---------------------------------------------------------------------
-- The ancestor walk, now over edges instead of a chain.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.chapter_prerequisite_path(p_start uuid)
RETURNS TABLE (chapter_id uuid, depth integer, name_bn text)
LANGUAGE sql
STABLE
AS $$
  WITH RECURSIVE reach AS (
    SELECT cp.prerequisite_id AS id, 1 AS depth
      FROM chapter_prerequisites cp
     WHERE cp.chapter_id = p_start
    UNION
    SELECT cp.prerequisite_id, r.depth + 1
      FROM chapter_prerequisites cp
      JOIN reach r ON cp.chapter_id = r.id
     WHERE r.depth < 64
  )
  SELECT r.id, min(r.depth)::integer, c.name_bn
    FROM reach r
    JOIN chapters c ON c.id = r.id
   GROUP BY r.id, c.name_bn
   ORDER BY 2, 3
$$;

-- ---------------------------------------------------------------------
-- Acyclicity (F-104, TRD §5.4). Same guarantee migration 022 gave the flat
-- column, moved to the edge table.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.assert_prereq_acyclic()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_loop      text;
  v_pre_name  text;
  v_pre_tenant uuid;
  v_chapter_name text;
BEGIN
  SELECT tenant_id, name_bn INTO v_pre_tenant, v_pre_name
    FROM chapters WHERE id = NEW.prerequisite_id;
  IF v_pre_tenant IS NULL THEN
    RAISE EXCEPTION 'prerequisite chapter % does not exist', NEW.prerequisite_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  -- The FK references chapters(id) alone, so nothing else stops one school's
  -- chapter pointing at another's — and that chapter's name is rendered to
  -- students as "আগে পড়ো:".
  IF v_pre_tenant <> NEW.tenant_id THEN
    RAISE EXCEPTION 'a prerequisite must belong to the same institution'
      USING ERRCODE = 'check_violation';
  END IF;

  IF EXISTS (
    SELECT 1 FROM app.chapter_prerequisite_path(NEW.prerequisite_id) p
     WHERE p.chapter_id = NEW.chapter_id
  ) THEN
    SELECT name_bn INTO v_chapter_name FROM chapters WHERE id = NEW.chapter_id;
    SELECT v_pre_name || COALESCE(' → ' || string_agg(p.name_bn, ' → ' ORDER BY p.depth), '')
      INTO v_loop
      FROM app.chapter_prerequisite_path(NEW.prerequisite_id) p;

    RAISE EXCEPTION 'this prerequisite would create a loop: % → %', v_chapter_name, v_loop
      USING ERRCODE = 'check_violation',
            HINT = 'every chapter in a loop becomes permanently unreachable in "what to study next"';
  END IF;
  RETURN NEW;
END $$;

COMMENT ON FUNCTION app.assert_prereq_acyclic IS
  'F-104 / TRD §5.4. Reachability test from prerequisite_id back to '
  'chapter_id; names the loop in the error so a content editor can see what '
  'they were about to do. Also enforces same-tenant, which the FK cannot.';

CREATE TRIGGER trg_chapter_prereq_acyclic
  BEFORE INSERT OR UPDATE ON chapter_prerequisites
  FOR EACH ROW EXECUTE FUNCTION app.assert_prereq_acyclic();

-- ---------------------------------------------------------------------
-- Retire the flat column and its trigger.
-- ---------------------------------------------------------------------
DROP TRIGGER IF EXISTS trg_chapters_no_prerequisite_cycle ON chapters;
DROP FUNCTION IF EXISTS app.prevent_prerequisite_cycle();
DROP INDEX IF EXISTS ix_chapters_prerequisite;
ALTER TABLE chapters DROP COLUMN prerequisite_chapter_id;

-- ---------------------------------------------------------------------
-- Tenancy and RLS, matching every other content table. Read is open to the
-- tenant (a prerequisite is advice, not private); writes are staff-only.
-- Split per command, because a FOR ALL restrictive policy silently cancels
-- the read policy beside it — the defect migration 023 exists to fix.
-- ---------------------------------------------------------------------
ALTER TABLE chapter_prerequisites ENABLE ROW LEVEL SECURITY;
ALTER TABLE chapter_prerequisites FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON chapter_prerequisites
  AS PERMISSIVE FOR ALL TO shikhon_app
  USING (app.tenant_guard(tenant_id))
  WITH CHECK (app.tenant_guard(tenant_id));

CREATE POLICY prereq_write_ins ON chapter_prerequisites
  AS RESTRICTIVE FOR INSERT TO shikhon_app
  WITH CHECK (app.has_role('principal','school_owner','academic_coordinator',
                           'dept_head','subject_teacher'));
CREATE POLICY prereq_write_upd ON chapter_prerequisites
  AS RESTRICTIVE FOR UPDATE TO shikhon_app
  USING (app.has_role('principal','school_owner','academic_coordinator',
                      'dept_head','subject_teacher'))
  WITH CHECK (app.has_role('principal','school_owner','academic_coordinator',
                           'dept_head','subject_teacher'));
CREATE POLICY prereq_write_del ON chapter_prerequisites
  AS RESTRICTIVE FOR DELETE TO shikhon_app
  USING (app.has_role('principal','school_owner','academic_coordinator',
                      'dept_head','subject_teacher'));

CREATE TRIGGER trg_chapter_prereq_tenant
  BEFORE INSERT OR UPDATE ON chapter_prerequisites
  FOR EACH ROW EXECUTE FUNCTION app.enforce_tenant();

-- ---------------------------------------------------------------------
-- Validate what was carried across. If the flat column held a loop, it is
-- now an edge loop, and shipping the guarantee while it is already false
-- is worse than not shipping it.
-- ---------------------------------------------------------------------
DO $$
DECLARE report text := '';  bad record;
BEGIN
  FOR bad IN
    SELECT c.id, c.name_bn
      FROM chapters c
     WHERE EXISTS (
       SELECT 1 FROM app.chapter_prerequisite_path(c.id) p WHERE p.chapter_id = c.id)
  LOOP
    report := report || format(E'\n  %s (%s)', bad.name_bn, bad.id);
  END LOOP;
  IF report <> '' THEN
    RAISE EXCEPTION 'prerequisite cycle(s) carried over from the flat column:%', report
      USING HINT = 'delete one edge in each loop from chapter_prerequisites, then re-run';
  END IF;
END $$;

COMMIT;
