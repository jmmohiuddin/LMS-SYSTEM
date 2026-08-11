-- ============================================================================
-- 033 — Academic year rollover  (F-1605)
--
-- "Academic year rollover as a guided, reversible-until-committed
-- operation." P0.
--
-- Once a year a school moves every child up one class. It is the single
-- largest write the product will ever make against a tenant — 1,200 new
-- enrolments, 1,200 derived subject sets, and a cohort leaving — and it
-- happens on a day when the office is busy and nobody is watching a
-- screen carefully. Everything below follows from that.
--
-- ── Reversible until committed, and not after ────────────────────────────
-- The preview writes NOTHING. app.rollover_preview() is a pure read that
-- returns one row per student saying what would happen to them and why, so
-- a head teacher can scroll a list of names rather than approve a number.
-- Nothing lands until app.commit_rollover() is called.
--
-- After the commit it is not reversible, and that is the honest shape:
-- undoing a rollover would mean deleting enrolments that attendance,
-- marks and invoices have already been hung off. So the preview carries
-- the whole weight, and the commit refuses to run while any student is
-- blocked — a rollover that silently skipped 30 children would be
-- discovered in March.
--
-- ── The terminal class is derived, never configured ──────────────────────
-- Which class graduates is the highest level_no the school actually
-- teaches. A tenant with classes 1–10 graduates Class 10; one that adds
-- Class 11 next year graduates Class 12 without anybody changing a
-- setting. A configured "terminal class" is a field that goes stale
-- exactly once, in the year it matters most.
--
-- ── Repeating is a decision already made ─────────────────────────────────
-- A student whose enrolment is 'detained' repeats their class. Rollover
-- does not decide that — the exam result did, weeks earlier — so this
-- function reads the decision rather than re-deriving it.
-- ============================================================================
BEGIN;

CREATE TABLE year_rollovers (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  from_year_id  uuid NOT NULL REFERENCES academic_years(id) ON DELETE CASCADE,
  to_year_id    uuid NOT NULL REFERENCES academic_years(id) ON DELETE CASCADE,

  status        text NOT NULL DEFAULT 'planned'
                  CHECK (status IN ('planned', 'committed', 'abandoned')),

  -- What the preview said, frozen at plan time.
  considered    integer NOT NULL DEFAULT 0 CHECK (considered >= 0),
  to_promote    integer NOT NULL DEFAULT 0 CHECK (to_promote >= 0),
  to_repeat     integer NOT NULL DEFAULT 0 CHECK (to_repeat  >= 0),
  to_graduate   integer NOT NULL DEFAULT 0 CHECK (to_graduate >= 0),
  blocked       integer NOT NULL DEFAULT 0 CHECK (blocked    >= 0),

  -- What actually happened. Zero until committed.
  promoted      integer NOT NULL DEFAULT 0 CHECK (promoted  >= 0),
  repeated      integer NOT NULL DEFAULT 0 CHECK (repeated  >= 0),
  graduated     integer NOT NULL DEFAULT 0 CHECK (graduated >= 0),

  planned_by    uuid REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  committed_by  uuid REFERENCES users(id),
  committed_at  timestamptz,

  CHECK (to_promote + to_repeat + to_graduate + blocked = considered),
  CHECK (from_year_id <> to_year_id),
  UNIQUE (tenant_id, from_year_id, to_year_id)
);

COMMENT ON TABLE year_rollovers IS
  'F-1605. One planned or committed rollover between two academic years. '
  'The plan''s counts are frozen at plan time and the actuals recorded at '
  'commit, so a rollover that moved fewer children than it promised is '
  'visible afterwards rather than only at the moment it ran.';

CREATE INDEX ix_year_rollovers_recent ON year_rollovers (tenant_id, created_at DESC);

ALTER TABLE year_rollovers ENABLE ROW LEVEL SECURITY;
ALTER TABLE year_rollovers FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON year_rollovers
  AS PERMISSIVE FOR ALL TO shikhon_app
  USING (app.tenant_guard(tenant_id))
  WITH CHECK (app.tenant_guard(tenant_id));

CREATE TRIGGER trg_year_rollovers_tenant BEFORE INSERT OR UPDATE ON year_rollovers
  FOR EACH ROW EXECUTE FUNCTION app.enforce_tenant();
CREATE TRIGGER trg_year_rollovers_touch BEFORE UPDATE ON year_rollovers
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- Moving every child in the school is an owner-level act.
CREATE POLICY rollover_read_scope ON year_rollovers
  AS RESTRICTIVE FOR SELECT TO shikhon_app
  USING (app.has_role('principal', 'school_owner', 'academic_coordinator'));
CREATE POLICY rollover_insert_scope ON year_rollovers
  AS RESTRICTIVE FOR INSERT TO shikhon_app
  WITH CHECK (app.has_role('principal', 'school_owner'));
CREATE POLICY rollover_update_scope ON year_rollovers
  AS RESTRICTIVE FOR UPDATE TO shikhon_app
  USING (app.has_role('principal', 'school_owner'))
  WITH CHECK (app.has_role('principal', 'school_owner'));

GRANT SELECT, INSERT, UPDATE ON year_rollovers TO shikhon_app;

-- ---------------------------------------------------------------------
-- The preview. Reads only.
--
-- One row per active student, naming them, so the "guided" part of F-1605
-- is a list a head teacher can read down rather than a count they must
-- trust.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.rollover_preview(p_from uuid, p_to uuid)
RETURNS TABLE (
  enrolment_id     uuid,
  student_id       uuid,
  student_name_bn  text,
  from_class_level smallint,
  from_section     text,
  from_roll        smallint,
  action           text,
  to_class_level   smallint,
  to_section_id    uuid,
  to_section       text,
  to_roll          smallint,
  blocker_bn       text
)
LANGUAGE sql
STABLE
SECURITY INVOKER            -- RLS still decides which students are visible
SET search_path = public, app
AS $$
  WITH terminal AS (
    -- The highest class the school actually teaches. Derived, so a school
    -- that opens a Class 11 next year needs no setting changed.
    SELECT max(c.level_no) AS level_no FROM classes c
  ),
  current AS (
    SELECT e.id, e.student_id, e.status, e.roll_no,
           u.full_name_bn, c.level_no, sec.name AS section_name,
           cls.group AS from_group
      FROM enrolments e
      JOIN users    u   ON u.id = e.student_id
      JOIN sections sec ON sec.id = e.section_id
      JOIN classes  c   ON c.id = sec.class_id
      JOIN classes  cls ON cls.id = sec.class_id
     WHERE e.academic_year_id = p_from
       AND e.status IN ('active', 'detained')
  ),
  decided AS (
    SELECT cur.*,
           CASE
             WHEN cur.status = 'detained'                THEN 'repeat'
             WHEN cur.level_no >= (SELECT level_no FROM terminal) THEN 'graduate'
             ELSE 'promote'
           END AS action,
           CASE
             WHEN cur.status = 'detained' THEN cur.level_no
             WHEN cur.level_no >= (SELECT level_no FROM terminal) THEN NULL
             ELSE (cur.level_no + 1)::smallint
           END AS target_level
      FROM current cur
  ),
  -- The section of the same NAME in the target class, in the target year.
  -- Keeping ক with ক is what a school expects; a child who changes section
  -- has been moved by a person, not by a rollover.
  targeted AS (
    SELECT d.*, ts.id AS target_section_id, ts.name AS target_section_name
      FROM decided d
      LEFT JOIN classes  tc  ON tc.level_no = d.target_level
      LEFT JOIN sections ts  ON ts.class_id = tc.id
                            AND ts.academic_year_id = p_to
                            AND ts.name = d.section_name
     WHERE d.target_level IS NOT NULL
     UNION ALL
    SELECT d.*, NULL::uuid, NULL::text FROM decided d WHERE d.target_level IS NULL
  ),
  numbered AS (
    SELECT t.*,
           -- Rolls are reassigned within the destination section, ordered
           -- by where the student came from. Deterministic, so previewing
           -- twice shows the same numbers and a head teacher can print it.
           CASE WHEN t.target_section_id IS NULL THEN NULL
                ELSE row_number() OVER (PARTITION BY t.target_section_id
                                            ORDER BY t.level_no, t.section_name, t.roll_no)
           END AS new_roll
      FROM targeted t
  )
  SELECT n.id, n.student_id, n.full_name_bn, n.level_no, n.section_name, n.roll_no,
         CASE WHEN n.action <> 'graduate' AND n.target_section_id IS NULL
                THEN 'blocked' ELSE n.action END,
         n.target_level, n.target_section_id, n.target_section_name,
         n.new_roll::smallint,
         CASE
           WHEN n.action = 'graduate' THEN NULL
           WHEN n.target_section_id IS NULL THEN
             -- Names what is missing, in the terms the person fixing it
             -- uses. "Section not found" would send them hunting.
             format('%s শ্রেণিতে "%s" শাখা নতুন বছরে তৈরি হয়নি', n.target_level, n.section_name)
           WHEN NOT EXISTS (
             SELECT 1 FROM subject_templates st
               JOIN curriculum_schemes cs ON cs.id = st.curriculum_scheme_id
               JOIN classes tc2 ON tc2.id = st.class_id
              WHERE tc2.level_no = n.target_level AND cs.academic_year_id = p_to
           ) THEN
             -- The same lesson F-1601 learned: derivation raises when there
             -- is no template, and discovering that after the button is
             -- pressed is discovering it too late.
             format('%s শ্রেণির বিষয় তালিকা (টেমপ্লেট) নতুন বছরে তৈরি হয়নি', n.target_level)
           ELSE NULL
         END
    FROM numbered n
   ORDER BY n.level_no, n.section_name, n.roll_no
$$;

COMMENT ON FUNCTION app.rollover_preview IS
  'F-1605. One row per student saying what rollover would do to them and '
  'why. Writes nothing — this is the reversible half of '
  '"reversible-until-committed".';

REVOKE ALL ON FUNCTION app.rollover_preview(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.rollover_preview(uuid, uuid) TO shikhon_app;

-- ---------------------------------------------------------------------
-- The commit. All of it, or none of it.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.commit_rollover(p_rollover uuid)
RETURNS TABLE (promoted integer, repeated integer, graduated integer)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, app
AS $$
DECLARE
  v_from uuid; v_to uuid; v_status text;
  v_blocked integer; v_sample text;
  v_promoted integer := 0; v_repeated integer := 0; v_graduated integer := 0;
  r record; v_new uuid;
BEGIN
  SELECT from_year_id, to_year_id, status INTO v_from, v_to, v_status
    FROM year_rollovers WHERE id = p_rollover FOR UPDATE;
  IF v_from IS NULL THEN
    RAISE EXCEPTION 'rollover % not found', p_rollover USING ERRCODE = 'no_data_found';
  END IF;
  IF v_status <> 'planned' THEN
    -- Not idempotent by design: running it twice would enrol every child
    -- into the new year a second time.
    RAISE EXCEPTION 'rollover is already %', v_status USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT count(*), min(blocker_bn) INTO v_blocked, v_sample
    FROM app.rollover_preview(v_from, v_to) WHERE action = 'blocked';
  IF v_blocked > 0 THEN
    -- Refusing beats skipping. A rollover that quietly left 30 children
    -- behind is found in March, by a teacher whose register is short.
    RAISE EXCEPTION 'rollover has % blocked student(s); e.g. %', v_blocked, v_sample
      USING ERRCODE = 'check_violation',
            HINT = 'call app.rollover_preview(from, to) for the full list';
  END IF;

  FOR r IN SELECT * FROM app.rollover_preview(v_from, v_to) LOOP
    IF r.action = 'graduate' THEN
      UPDATE enrolments SET status = 'promoted', ended_on = CURRENT_DATE WHERE id = r.enrolment_id;
      -- Fires app.emit_graduation_event (migration 009), which is what
      -- puts the student into the alumni network's outbox.
      UPDATE student_profiles
         SET lifecycle_status = 'graduated', graduated_on = CURRENT_DATE
       WHERE user_id = r.student_id;
      v_graduated := v_graduated + 1;
      CONTINUE;
    END IF;

    INSERT INTO enrolments
      (tenant_id, student_id, section_id, academic_year_id, roll_no, status, enrolled_on)
    VALUES (app.current_tenant(), r.student_id, r.to_section_id, v_to,
            r.to_roll, 'active', CURRENT_DATE)
    RETURNING id INTO v_new;

    -- F-304. The new class has its own template, and a Class 10 subject
    -- set is not a Class 9 one carried forward.
    PERFORM app.derive_student_subjects(v_new, NULL, NULL);

    UPDATE enrolments SET status = 'promoted', ended_on = CURRENT_DATE
     WHERE id = r.enrolment_id;

    IF r.action = 'repeat' THEN v_repeated := v_repeated + 1;
    ELSE v_promoted := v_promoted + 1;
    END IF;
  END LOOP;

  UPDATE year_rollovers
     SET status = 'committed', committed_at = now(), committed_by = app.current_user_id(),
         promoted = v_promoted, repeated = v_repeated, graduated = v_graduated
   WHERE id = p_rollover;

  RETURN QUERY SELECT v_promoted, v_repeated, v_graduated;
END $$;

COMMENT ON FUNCTION app.commit_rollover IS
  'F-1605. Moves every student. Refuses while any is blocked, because a '
  'rollover that skipped children silently is discovered months later.';

REVOKE ALL ON FUNCTION app.commit_rollover(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.commit_rollover(uuid) TO shikhon_app;

COMMIT;
