-- ============================================================================
-- 031 — Bulk import  (F-1601, wireframe §10.2)
--
-- The PRD calls F-1601 "the practical blocker to any pilot": onboarding a
-- school of 800 has no tooling. Building it turned up two schema facts
-- that make importing a real school's roster impossible, and they are the
-- larger half of this migration.
--
-- ── 1. Two siblings cannot both be imported ──────────────────────────────
-- users carries CHECK (phone_e164 IS NOT NULL OR email IS NOT NULL), and a
-- partial UNIQUE on (tenant_id, phone_e164).
--
-- In a Bangladeshi school the contact number on a Class 3 student's record
-- is their guardian's mobile. The child has no phone and no email. So:
--
--   • leave the student's phone NULL  → the CHECK rejects the row;
--   • copy the guardian's number      → the UNIQUE rejects the SECOND
--                                       sibling.
--
-- Every school with a pair of siblings in it — which is every school —
-- hits this on import. The constraint is not wrong about what it wants:
-- nobody should be unreachable. It is wrong about where reachability
-- lives. For a child it lives on the guardianship, one table over, which
-- is somewhere a CHECK cannot look.
--
-- So the CHECK becomes a DEFERRED constraint trigger: at COMMIT, a user
-- with no contact of their own must have a guardian who has one. Deferred
-- because the import inserts the student, the guardian and the
-- guardianship in one transaction, and no ordering of those three
-- satisfies an immediate check.
--
-- The guarantee is unchanged and slightly stronger: before, a student row
-- could carry a phone nobody answers and pass. Now somebody real must be
-- reachable for every child in the school.
--
-- ── 2. Nothing may stage the file ────────────────────────────────────────
-- The obvious shape for a dry-run is a staging table of parsed rows, kept
-- between validation and commit. It is also forbidden here: an import row
-- may carry a birth registration number, and the rule is that a national
-- identifier is never written in plaintext anywhere, including a debug
-- log. A staging table of raw CSV rows is exactly that, sitting in the
-- database for as long as the operator takes lunch.
--
-- So there is no staging table. Validation is stateless — the file is
-- parsed, checked and thrown away, and the commit step re-sends it. What
-- is persisted here is only what an auditor needs: who imported what,
-- when, how many rows, and how many were skipped.
-- ============================================================================
BEGIN;

-- ---------------------------------------------------------------------
-- 1. Reachability, moved off the row and onto the family.
-- ---------------------------------------------------------------------
ALTER TABLE users DROP CONSTRAINT users_contactable;

CREATE OR REPLACE FUNCTION app.assert_user_reachable()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, app
AS $$
BEGIN
  IF NEW.deleted_at IS NOT NULL THEN RETURN NULL; END IF;
  IF NEW.phone_e164 IS NOT NULL OR NEW.email IS NOT NULL THEN RETURN NULL; END IF;

  IF EXISTS (
    SELECT 1
      FROM guardianships g
      JOIN users gu ON gu.id = g.guardian_id
     WHERE g.student_id = NEW.id
       AND gu.deleted_at IS NULL
       AND (gu.phone_e164 IS NOT NULL OR gu.email IS NOT NULL)
  ) THEN
    RETURN NULL;
  END IF;

  -- Names the person, because this fires at COMMIT on a transaction that
  -- may hold 800 of them and "a user is unreachable" would be useless.
  RAISE EXCEPTION
    '% has no phone, no email and no contactable guardian', NEW.full_name_bn
    USING ERRCODE = 'check_violation',
          HINT = 'give the student a guardian with a phone, or set one on the student';
END $$;

COMMENT ON FUNCTION app.assert_user_reachable IS
  'Replaces the users_contactable CHECK. A child''s contact number is their '
  'guardian''s, which lives one table over — somewhere a CHECK cannot look. '
  'DEFERRED because an import writes student, guardian and guardianship in '
  'one transaction and no ordering satisfies an immediate check.';

CREATE CONSTRAINT TRIGGER trg_users_reachable
  AFTER INSERT OR UPDATE OF phone_e164, email, deleted_at ON users
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION app.assert_user_reachable();

-- ---------------------------------------------------------------------
-- 2. The batch record.
--
-- Counts and provenance only. No file content, no row content — see the
-- header. rows_rejected exists so that §10.2's "the skipped count is
-- stated explicitly and logged (no silent truncation)" is a stored fact
-- rather than a number that appeared once on a screen.
-- ---------------------------------------------------------------------
CREATE TYPE import_kind AS ENUM ('student', 'staff');

CREATE TABLE import_batches (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  kind             import_kind NOT NULL,
  academic_year_id uuid REFERENCES academic_years(id) ON DELETE SET NULL,

  -- The file's NAME is operator-supplied and harmless. The digest is over
  -- the parsed rows, and it is what stops a dry-run of one file being
  -- committed as another: the commit must present the digest validation
  -- returned, or it is refused.
  file_name        text,
  file_digest      text NOT NULL CHECK (file_digest ~ '^[0-9a-f]{64}$'),

  rows_read        integer NOT NULL DEFAULT 0 CHECK (rows_read     >= 0),
  rows_valid       integer NOT NULL DEFAULT 0 CHECK (rows_valid    >= 0),
  rows_rejected    integer NOT NULL DEFAULT 0 CHECK (rows_rejected >= 0),
  rows_imported    integer NOT NULL DEFAULT 0 CHECK (rows_imported >= 0),

  status           text NOT NULL DEFAULT 'validated'
                     CHECK (status IN ('validated', 'imported', 'failed')),
  started_by       uuid REFERENCES users(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  completed_at     timestamptz,

  -- Arithmetic the screen depends on. §10.2 shows "৭৬৮টি ঠিক সারি আমদানি
  -- করুন, ১৬টি বাদ" — 768 + 16 = 784, and a batch where that does not add
  -- up is a batch that lost rows without saying so.
  CHECK (rows_valid + rows_rejected = rows_read),
  CHECK (rows_imported <= rows_valid)
);

CREATE INDEX ix_import_batches_recent
  ON import_batches (tenant_id, created_at DESC);

COMMENT ON TABLE import_batches IS
  'F-1601. Counts and provenance for a bulk import. Deliberately holds NO '
  'file or row content: an import row may carry a birth registration '
  'number, and staging one would be a plaintext national identifier '
  'sitting in the database.';

COMMENT ON COLUMN import_batches.file_digest IS
  'sha256 over the parsed rows. The commit must present the digest the '
  'dry-run returned, so a validated file cannot be swapped for another '
  'between step 2 and step 4.';

ALTER TABLE import_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE import_batches FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON import_batches
  AS PERMISSIVE FOR ALL TO shikhon_app
  USING (app.tenant_guard(tenant_id))
  WITH CHECK (app.tenant_guard(tenant_id));

CREATE TRIGGER trg_import_batches_tenant BEFORE INSERT OR UPDATE ON import_batches
  FOR EACH ROW EXECUTE FUNCTION app.enforce_tenant();
CREATE TRIGGER trg_import_batches_touch BEFORE UPDATE ON import_batches
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- Importing a roster creates users, enrolments and guardianships wholesale.
-- That is an owner-level act, not something a class teacher does.
CREATE POLICY import_read_scope ON import_batches
  AS RESTRICTIVE FOR SELECT TO shikhon_app
  USING (app.has_role('principal', 'school_owner', 'academic_coordinator'));

CREATE POLICY import_insert_scope ON import_batches
  AS RESTRICTIVE FOR INSERT TO shikhon_app
  WITH CHECK (app.has_role('principal', 'school_owner', 'academic_coordinator'));

CREATE POLICY import_update_scope ON import_batches
  AS RESTRICTIVE FOR UPDATE TO shikhon_app
  USING (app.has_role('principal', 'school_owner', 'academic_coordinator'))
  WITH CHECK (app.has_role('principal', 'school_owner', 'academic_coordinator'));

GRANT SELECT, INSERT, UPDATE ON import_batches TO shikhon_app;

COMMIT;
