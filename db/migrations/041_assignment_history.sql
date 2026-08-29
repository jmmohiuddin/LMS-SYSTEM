-- ============================================================================
-- 041 — Teacher assignment history, the IT admin role, and a readable audit
--       (R-3, docs/11-MASTER-PLAN.md)
--
-- R-3 gives a school's principal and IT admin a control centre. Three things
-- in the existing schema stop that from being buildable honestly, and this
-- migration fixes exactly those three. Everything else R-3 needs is already
-- here and is reused unchanged.
--
-- ── 1. Replacing a teacher currently destroys the record of the first one ──
-- `section_subject_teachers` is UNIQUE (tenant, section, subject, year) with no
-- validity period. There is exactly one row per subject per section per year,
-- so "Rahim Sir taught Physics to 9-F until March, then Karim Sir took over"
-- cannot be represented: the replacement is an UPDATE, and March is gone.
--
-- The master plan's R-3 says the replacement flow must "end old row (ended_on),
-- insert new — never delete". That is not a UI decision, it is a schema
-- capability, and the schema did not have it. It matters beyond tidiness: when
-- a parent asks in November who was teaching their child in March — after a
-- bad result, which is when people ask — the answer has to be a record, not a
-- memory. The same row is what makes `class_delivery_log` and attendance
-- attributable to the person who was actually standing in the room.
--
-- So: validity columns, and the uniqueness moves to a PARTIAL index over the
-- open rows only. Closed rows accumulate; nothing is ever deleted.
--
-- ── 2. The class teacher had no history at all ─────────────────────────────
-- `sections.class_teacher_id` is a single nullable column. Even with the fix
-- above, replacing a class teacher would still be a silent overwrite. Rather
-- than removing that column — it is read all over the codebase and is the
-- right shape for "who is it NOW" — this adds `class_teacher_assignments` as
-- the history, and a trigger keeps the column in sync as a denormalised
-- pointer to the open row. One writer, so the two cannot drift.
--
-- ── 3. `it_admin` is a role the code checks for and no user can hold ───────
-- ops-svc/api/branding.ts has admitted 'it_admin' to BRANDING_WRITERS since
-- R-1, and docs/07 documents it. It is not in the roles table. `user_roles`
-- has an FK to `roles.code`, so the role cannot be granted to anybody, and
-- `app.has_role('it_admin')` can never be true. The allowlist entry has been
-- decorative for two phases. R-3 is the phase that builds the IT admin's
-- screens, so the role has to become real before those screens mean anything.
--
-- Rank 65: below academic_coordinator (70), above dept_head (60). An IT admin
-- runs the system's structure — users, sections, assignments, settings — and
-- does not outrank the person responsible for the academic programme.
--
-- ── And one grant: audit becomes readable ──────────────────────────────────
-- 010 grants shikhon_app INSERT on audit.activity_log and revokes UPDATE and
-- DELETE, which is exactly right for an audit trail. But nothing was granted
-- SELECT, so the log could be written and never read — including by the
-- school it is about. R-3's audit viewer needs to read it, so this adds SELECT
-- under RLS restricted to the tenant's own management. UPDATE and DELETE stay
-- revoked: an audit trail that its subject can edit is not one.
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- 1. The IT admin role
--
-- ON CONFLICT DO NOTHING so this is safe against a database where a later
-- provisioning step has already inserted it.
-- ---------------------------------------------------------------------
INSERT INTO roles (code, name_bn, name_en, scope_level, rank, is_staff) VALUES
  ('it_admin', 'আইটি অ্যাডমিন', 'IT Admin', 'tenant', 65, true)
ON CONFLICT (code) DO NOTHING;

-- ---------------------------------------------------------------------
-- 2. Subject-teacher assignments gain a validity period
--
-- started_on defaults to today for the rows that already exist: they are the
-- current truth, and pretending to know when they began would be inventing
-- data. A school that wants the real date can edit it; a NULL would make every
-- query carry a special case forever.
-- ---------------------------------------------------------------------
ALTER TABLE section_subject_teachers
  ADD COLUMN started_on  date NOT NULL DEFAULT CURRENT_DATE,
  ADD COLUMN ended_on    date,
  ADD COLUMN assigned_by uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN end_reason  text,
  ADD CONSTRAINT sst_period_is_ordered CHECK (ended_on IS NULL OR ended_on >= started_on),
  -- A reason is required to close an assignment and meaningless on an open
  -- one. "Why did the teacher change mid-year" is the question this table
  -- exists to answer, so the answer cannot be optional.
  ADD CONSTRAINT sst_reason_belongs_to_a_closed_row
    CHECK ((ended_on IS NULL) = (end_reason IS NULL));

-- The old constraint permitted exactly one row per (section, subject, year)
-- for all time. It has to go, or history is impossible; uniqueness is
-- preserved over the OPEN rows, which is what "one teacher teaches this now"
-- actually means.
--
-- Found by shape rather than by name: PostgreSQL truncates generated
-- constraint names to 63 characters, and hardcoding the truncation would make
-- this migration fail on nothing more interesting than a rename.
DO $$
DECLARE
  v_name text;
BEGIN
  SELECT con.conname INTO v_name
    FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
   WHERE rel.relname = 'section_subject_teachers'
     AND con.contype = 'u'
     AND (SELECT array_agg(att.attname::text ORDER BY att.attname::text)
            FROM unnest(con.conkey) AS k(attnum)
            JOIN pg_attribute att
              ON att.attrelid = con.conrelid AND att.attnum = k.attnum)
         = ARRAY['academic_year_id','section_id','subject_id','tenant_id'];

  IF v_name IS NULL THEN
    RAISE EXCEPTION
      'expected a UNIQUE constraint over (tenant_id, section_id, subject_id, academic_year_id) on section_subject_teachers, found none';
  END IF;

  EXECUTE format('ALTER TABLE section_subject_teachers DROP CONSTRAINT %I', v_name);
END $$;

CREATE UNIQUE INDEX uq_sst_current
  ON section_subject_teachers (tenant_id, section_id, subject_id, academic_year_id)
  WHERE ended_on IS NULL;

-- Reading one teacher's history, and one section's, are the two queries the
-- assignment screens make.
CREATE INDEX ix_sst_history
  ON section_subject_teachers (tenant_id, section_id, subject_id, started_on DESC);

COMMENT ON COLUMN section_subject_teachers.ended_on IS
  'NULL = this teacher currently teaches this subject to this section. Set, '
  'never deleted, when a replacement takes over: the closed row is the record '
  'of who was responsible for that stretch of the year.';

-- ---------------------------------------------------------------------
-- 3. Class-teacher history
--
-- sections.class_teacher_id stays as the current pointer. This table is the
-- record, and the trigger below is the ONLY writer of that column from here
-- on, so "current" and "the open row" cannot disagree.
-- ---------------------------------------------------------------------
CREATE TABLE class_teacher_assignments (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  section_id       uuid NOT NULL REFERENCES sections(id) ON DELETE CASCADE,
  teacher_id       uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  academic_year_id uuid NOT NULL REFERENCES academic_years(id) ON DELETE CASCADE,
  started_on       date NOT NULL DEFAULT CURRENT_DATE,
  ended_on         date,
  assigned_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  end_reason       text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT cta_period_is_ordered CHECK (ended_on IS NULL OR ended_on >= started_on),
  CONSTRAINT cta_reason_belongs_to_a_closed_row
    CHECK ((ended_on IS NULL) = (end_reason IS NULL))
);

CREATE UNIQUE INDEX uq_cta_current
  ON class_teacher_assignments (tenant_id, section_id, academic_year_id)
  WHERE ended_on IS NULL;

CREATE INDEX ix_cta_history
  ON class_teacher_assignments (tenant_id, section_id, started_on DESC);
CREATE INDEX ix_cta_teacher
  ON class_teacher_assignments (tenant_id, teacher_id, academic_year_id);

COMMENT ON TABLE class_teacher_assignments IS
  'R-3. Who was class teacher of a section, and when. sections.class_teacher_id '
  'is the denormalised pointer to the open row here and is maintained by '
  'trg_cta_sync_section — do not write it directly.';

CREATE TRIGGER trg_cta_tenant BEFORE INSERT OR UPDATE ON class_teacher_assignments
  FOR EACH ROW EXECUTE FUNCTION app.enforce_tenant();

-- Keep sections.class_teacher_id pointing at the open row. Runs for every
-- path that touches the table, including the assignment function below, so
-- there is no way to insert history without the pointer following.
CREATE OR REPLACE FUNCTION app.sync_section_class_teacher() RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, app
AS $$
DECLARE
  v_section uuid := COALESCE(NEW.section_id, OLD.section_id);
BEGIN
  UPDATE sections s
     SET class_teacher_id = (
           SELECT cta.teacher_id
             FROM class_teacher_assignments cta
            WHERE cta.section_id = v_section
              AND cta.ended_on IS NULL
            ORDER BY cta.started_on DESC
            LIMIT 1)
   WHERE s.id = v_section;
  RETURN NULL;
END $$;

CREATE TRIGGER trg_cta_sync_section
  AFTER INSERT OR UPDATE OR DELETE ON class_teacher_assignments
  FOR EACH ROW EXECUTE FUNCTION app.sync_section_class_teacher();

ALTER TABLE class_teacher_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE class_teacher_assignments FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON class_teacher_assignments
  AS PERMISSIVE FOR ALL TO shikhon_app
  USING (app.tenant_guard(tenant_id))
  WITH CHECK (app.tenant_guard(tenant_id));

-- Who taught which section is not sensitive within a school — a student knows
-- their own class teacher's name. Staff read it; only management writes it.
CREATE POLICY cta_read_scope ON class_teacher_assignments
  AS RESTRICTIVE FOR SELECT TO shikhon_app
  USING (app.has_role('principal','school_owner','academic_coordinator',
                      'it_admin','dept_head','class_teacher','subject_teacher'));

CREATE POLICY cta_write_scope ON class_teacher_assignments
  AS RESTRICTIVE FOR INSERT TO shikhon_app
  WITH CHECK (app.has_role('principal','school_owner','academic_coordinator','it_admin'));

CREATE POLICY cta_update_scope ON class_teacher_assignments
  AS RESTRICTIVE FOR UPDATE TO shikhon_app
  USING (app.has_role('principal','school_owner','academic_coordinator','it_admin'));

GRANT SELECT, INSERT, UPDATE ON class_teacher_assignments TO shikhon_app;

-- ---------------------------------------------------------------------
-- 4. Assignment as one operation
--
-- Ending the old row and opening the new one must be atomic. Two statements
-- from the API would leave, on a failure between them, either a section with
-- no teacher of record or two teachers of record for the same subject — and
-- the partial unique index turns the second into a raised error at some
-- unrelated later moment.
--
-- SECURITY INVOKER: RLS decides whether this caller may write. A definer
-- function here would be a way to assign teachers in a school you do not
-- belong to.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.assign_class_teacher(
  p_section    uuid,
  p_teacher    uuid,
  p_effective  date,
  p_reason     text            -- why the outgoing teacher stopped; NULL if none
) RETURNS uuid
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, app
AS $$
DECLARE
  v_tenant  uuid := app.current_tenant();
  v_year    uuid;
  v_current uuid;
  v_new     uuid;
BEGIN
  SELECT s.academic_year_id INTO v_year FROM sections s WHERE s.id = p_section;
  IF v_year IS NULL THEN
    RAISE EXCEPTION 'section % not found in this institution', p_section
      USING ERRCODE = 'no_data_found';
  END IF;

  SELECT cta.id, cta.teacher_id INTO v_current, v_new
    FROM class_teacher_assignments cta
   WHERE cta.section_id = p_section AND cta.ended_on IS NULL
   ORDER BY cta.started_on DESC LIMIT 1;

  -- Re-assigning the same person is a no-op, not a replacement. Otherwise a
  -- double-submitted form writes a zero-length assignment into the history a
  -- parent will one day read.
  IF v_new = p_teacher THEN
    RETURN v_current;
  END IF;

  IF v_current IS NOT NULL THEN
    UPDATE class_teacher_assignments
       SET ended_on   = p_effective,
           end_reason = COALESCE(p_reason, 'replaced')
     WHERE id = v_current;
  END IF;

  INSERT INTO class_teacher_assignments
    (tenant_id, section_id, teacher_id, academic_year_id, started_on, assigned_by)
  VALUES
    (v_tenant, p_section, p_teacher, v_year, p_effective, app.current_user_id())
  RETURNING id INTO v_new;

  RETURN v_new;
END $$;

CREATE OR REPLACE FUNCTION app.assign_subject_teacher(
  p_section    uuid,
  p_subject    uuid,
  p_teacher    uuid,
  p_effective  date,
  p_reason     text
) RETURNS uuid
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, app
AS $$
DECLARE
  v_tenant  uuid := app.current_tenant();
  v_year    uuid;
  v_current uuid;
  v_holder  uuid;
  v_new     uuid;
BEGIN
  SELECT s.academic_year_id INTO v_year FROM sections s WHERE s.id = p_section;
  IF v_year IS NULL THEN
    RAISE EXCEPTION 'section % not found in this institution', p_section
      USING ERRCODE = 'no_data_found';
  END IF;

  SELECT sst.id, sst.teacher_id INTO v_current, v_holder
    FROM section_subject_teachers sst
   WHERE sst.section_id = p_section
     AND sst.subject_id = p_subject
     AND sst.ended_on IS NULL
   ORDER BY sst.started_on DESC LIMIT 1;

  IF v_holder = p_teacher THEN
    RETURN v_current;
  END IF;

  IF v_current IS NOT NULL THEN
    UPDATE section_subject_teachers
       SET ended_on   = p_effective,
           end_reason = COALESCE(p_reason, 'replaced')
     WHERE id = v_current;
  END IF;

  INSERT INTO section_subject_teachers
    (tenant_id, section_id, subject_id, teacher_id, academic_year_id,
     started_on, assigned_by)
  VALUES
    (v_tenant, p_section, p_subject, p_teacher, v_year, p_effective,
     app.current_user_id())
  RETURNING id INTO v_new;

  RETURN v_new;
END $$;

REVOKE ALL ON FUNCTION app.assign_class_teacher(uuid, uuid, date, text)   FROM PUBLIC;
REVOKE ALL ON FUNCTION app.assign_subject_teacher(uuid, uuid, uuid, date, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assign_class_teacher(uuid, uuid, date, text)   TO shikhon_app;
GRANT EXECUTE ON FUNCTION app.assign_subject_teacher(uuid, uuid, uuid, date, text) TO shikhon_app;

-- ---------------------------------------------------------------------
-- 5. The audit log becomes readable by the school it is about
--
-- INSERT was already granted (010). UPDATE and DELETE stay revoked there and
-- are not restored here: a trail its subject can edit is decoration.
-- ---------------------------------------------------------------------
ALTER TABLE audit.activity_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit.activity_log FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON audit.activity_log
  AS PERMISSIVE FOR ALL TO shikhon_app
  USING (app.tenant_guard(tenant_id))
  WITH CHECK (app.tenant_guard(tenant_id));

-- "Who changed this" is a management question. A subject teacher reading the
-- whole institution's change history is a different product.
CREATE POLICY activity_read_scope ON audit.activity_log
  AS RESTRICTIVE FOR SELECT TO shikhon_app
  USING (app.has_role('principal','school_owner','it_admin'));

GRANT SELECT ON audit.activity_log TO shikhon_app;

COMMIT;
