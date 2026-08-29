-- ============================================================================
-- 042 — Who may create a class, a section, or a guardian link
--       (R-3 completion pass, docs/11-MASTER-PLAN.md)
--
-- R-3 gave the IT admin screens for assigning teachers and moving students.
-- This pass adds the three things it left out: creating classes and sections,
-- linking guardians, and reading the audit trail. Building those screens
-- exposed a gap underneath them.
--
-- ── The gap ─────────────────────────────────────────────────────────────
-- `classes`, `sections` and `guardianships` carry ONLY the PERMISSIVE
-- `tenant_isolation` policy that migration 010 applies in a loop to every
-- table with a tenant_id, plus a blanket
-- `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES ... TO shikhon_app`.
--
-- That is complete tenant isolation and NO role scope. Any authenticated
-- session in a school — a subject teacher's, a student's — could insert a
-- class, rename a section, or set `can_pay_fees` on somebody else's guardian.
-- Nothing had exercised those paths before, because until now nothing in the
-- product wrote to these tables: sections were created by hand from the pilot
-- runbook, and `guardianships` was populated by the CSV import.
--
-- The moment there is a screen, there is a request; and the rule this
-- codebase holds to is that RLS is the enforcement and the endpoint's
-- requireRole is a clean 403 in front of it. A screen whose only gate is the
-- endpoint would be the frontend-hiding pattern D13 exists to forbid, one
-- layer down.
--
-- ── Why the scopes differ ───────────────────────────────────────────────
-- Structure (classes, sections) is the institution's shape: principal, owner,
-- coordinator, IT admin. A dept_head runs a department, not the timetable's
-- containers.
--
-- Guardianships are narrower still on WRITE. Who may pay a child's fees and
-- who receives the SMS about them is a statement about a family, and getting
-- it wrong sends a fee demand to the wrong parent. Class teachers are
-- deliberately excluded even though they know the families best — the
-- correction belongs with the office that holds the admission form.
--
-- READ stays wide: `guardianships` is read by app.can_see_student(),
-- app.my_ward_ids() and the notice audience resolver, on every request a
-- guardian makes. Narrowing SELECT here would break R-2's fan-out and the
-- guardian's own ward view. This migration adds no SELECT policy at all for
-- that reason — the existing per-table read rules stay exactly as they are.
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- 1. Classes and sections — the institution's shape
--
-- FOR ALL rather than separate INSERT/UPDATE/DELETE policies: a RESTRICTIVE
-- FOR ALL applies its USING to reads too, which would hide classes from
-- students and break every roster screen. So these are written as the three
-- write commands explicitly, leaving SELECT untouched.
-- ---------------------------------------------------------------------
CREATE POLICY classes_insert_scope ON classes
  AS RESTRICTIVE FOR INSERT TO shikhon_app
  WITH CHECK (app.has_role('principal','school_owner','academic_coordinator','it_admin'));

CREATE POLICY classes_update_scope ON classes
  AS RESTRICTIVE FOR UPDATE TO shikhon_app
  USING (app.has_role('principal','school_owner','academic_coordinator','it_admin'))
  WITH CHECK (app.has_role('principal','school_owner','academic_coordinator','it_admin'));

-- Deleting a class would cascade to its sections and orphan enrolment
-- history. No role gets it; a class a school stops using simply stops having
-- sections created for the new year.
CREATE POLICY classes_delete_scope ON classes
  AS RESTRICTIVE FOR DELETE TO shikhon_app
  USING (false);

CREATE POLICY sections_insert_scope ON sections
  AS RESTRICTIVE FOR INSERT TO shikhon_app
  WITH CHECK (app.has_role('principal','school_owner','academic_coordinator','it_admin'));

-- UPDATE stays open to the same four PLUS nothing else — but note that
-- `sections.class_teacher_id` is maintained by 041's trigger, not by a screen.
CREATE POLICY sections_update_scope ON sections
  AS RESTRICTIVE FOR UPDATE TO shikhon_app
  USING (app.has_role('principal','school_owner','academic_coordinator','it_admin'))
  WITH CHECK (app.has_role('principal','school_owner','academic_coordinator','it_admin'));

-- Same reasoning as classes: a section with enrolment history is a record.
CREATE POLICY sections_delete_scope ON sections
  AS RESTRICTIVE FOR DELETE TO shikhon_app
  USING (false);

-- ---------------------------------------------------------------------
-- 2. Guardianships — who may say who pays
--
-- SELECT is deliberately NOT restricted here; see the header.
-- ---------------------------------------------------------------------
CREATE POLICY guardianship_insert_scope ON guardianships
  AS RESTRICTIVE FOR INSERT TO shikhon_app
  WITH CHECK (app.has_role('principal','school_owner','it_admin'));

CREATE POLICY guardianship_update_scope ON guardianships
  AS RESTRICTIVE FOR UPDATE TO shikhon_app
  USING (app.has_role('principal','school_owner','it_admin'))
  WITH CHECK (app.has_role('principal','school_owner','it_admin'));

-- Unlinking a guardian removes the record that they were ever responsible.
-- The office marks a link inactive by moving `is_primary` and the permissions,
-- which keeps the row; a genuine data-entry error is rare enough to be worth
-- a support request rather than a delete button on a family relationship.
CREATE POLICY guardianship_delete_scope ON guardianships
  AS RESTRICTIVE FOR DELETE TO shikhon_app
  USING (false);

-- ---------------------------------------------------------------------
-- 3. Exactly one primary guardian, atomically
--
-- `uq_guardianship_primary` (002) is a partial unique index over
-- (tenant, student) WHERE is_primary. Promoting a new primary therefore has
-- to demote the old one FIRST, and doing that as two statements from the API
-- means a failure between them leaves a child with no primary guardian — the
-- person the school rings when something happens.
--
-- SECURITY INVOKER: RLS decides whether this caller may write, exactly as in
-- 041's assignment functions. A definer function here would be a way to
-- re-parent a child in a school you do not belong to.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.set_guardian_permissions(
  p_student      uuid,
  p_guardian     uuid,
  p_relation     text,
  p_is_primary   boolean,
  p_receives_sms boolean,
  p_can_pay_fees boolean
) RETURNS uuid
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, app
AS $$
DECLARE
  v_tenant uuid := app.current_tenant();
  v_id     uuid;
BEGIN
  IF p_is_primary THEN
    -- Demote first. Restricted to this student, so another child's primary
    -- guardian is untouched.
    UPDATE guardianships
       SET is_primary = false
     WHERE student_id = p_student
       AND is_primary
       AND guardian_id <> p_guardian;
  END IF;

  INSERT INTO guardianships
    (tenant_id, student_id, guardian_id, relation, is_primary, receives_sms, can_pay_fees)
  VALUES
    (v_tenant, p_student, p_guardian, p_relation, p_is_primary, p_receives_sms, p_can_pay_fees)
  ON CONFLICT (tenant_id, student_id, guardian_id) DO UPDATE
    SET relation     = EXCLUDED.relation,
        is_primary   = EXCLUDED.is_primary,
        receives_sms = EXCLUDED.receives_sms,
        can_pay_fees = EXCLUDED.can_pay_fees
  RETURNING id INTO v_id;

  RETURN v_id;
END $$;

COMMENT ON FUNCTION app.set_guardian_permissions IS
  'R-3 completion. Link a guardian to a student, or change the permissions of '
  'an existing link. Demoting the previous primary and promoting the new one '
  'happen in one statement pair inside one transaction, because a failure '
  'between them leaves a child with no primary guardian.';

REVOKE ALL ON FUNCTION app.set_guardian_permissions(uuid, uuid, text, boolean, boolean, boolean)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.set_guardian_permissions(uuid, uuid, text, boolean, boolean, boolean)
  TO shikhon_app;

COMMIT;
