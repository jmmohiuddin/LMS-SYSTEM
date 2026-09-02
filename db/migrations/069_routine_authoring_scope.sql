-- 069 — the routine tables get per-command write scopes
--
-- `routines` and `routine_slots` already carried a RESTRICTIVE policy, but it
-- was written `FOR ALL` with `USING (true)`:
--
--   routine_write_scope        USING true  CHECK app.has_role('principal',
--   routine_slots_write_scope              'school_owner','academic_coordinator')
--
-- A RESTRICTIVE `FOR ALL` applies its USING to SELECT **and to DELETE**, and
-- `true` gates neither. The WITH CHECK covers INSERT and the new row of an
-- UPDATE, so authoring was correctly scoped and deletion was not scoped at
-- all. Proved live as `shikhon_app` with `app.role = 'student'`, against a
-- routine and slot inserted moments earlier by a principal:
--
--   INSERT routine_slots -> refused        (the WITH CHECK works)
--   DELETE routine_slots -> 1 row          (nothing stops it)
--   DELETE routines      -> 1 row          (and it cascades to every slot)
--
-- So any account in a school — a student's — could delete that school's
-- entire timetable. This is the same shape migration 066 found on `exams` and
-- 068 found on `exam_marks`: the write half was scoped and the delete half was
-- reached through a policy that was never asked about it.
--
-- `period_templates`, `period_definitions` and `routine_slot_sections` had no
-- write scope of any kind — only the PERMISSIVE `tenant_isolation`, which asks
-- "same school?" and nothing else. Also proved live as `student`:
--
--   INSERT period_definitions -> allowed
--   DELETE period_definitions -> 1 row
--   INSERT period_templates   -> allowed
--
-- The period template is when the school day starts and ends. A routine slot
-- points at a `period_definition_id`, so editing those times moves every
-- lesson in the school.
--
-- ── Why DELETE is granted to the authoring roles rather than refused ──────
-- Unlike `exams`, this domain expresses "do not destroy a live one" in its own
-- data rather than in a policy: `routine_slots.status` is `active | removed`
-- (a soft delete), and `routines.status` carries `superseded` with a
-- `supersedes_id` for versioning. A draft routine created by mistake has to be
-- removable by the people who create routines, and `solve-cross-shift.test.ts`
-- clears slots as `academic_coordinator` in its own `beforeEach`. So DELETE is
-- scoped to the same three roles as INSERT and UPDATE — not banned, and no
-- longer open to everyone.
--
-- ── Two more of the same shape, found while auditing this domain ─────────
--
-- `routine_substitutions` carries the identical `FOR ALL / USING (true)`
-- policy (`substitution_write_scope`, migration 010), so its DELETE is open
-- to everyone too. Its role list is the wider four including dept_head, and
-- that is preserved here.
--
-- And `tenants` had exactly ONE policy — `tenant_self`, PERMISSIVE FOR ALL,
-- `id = app.current_tenant()` — with no role predicate at all. Proved live as
-- `shikhon_app` with `app.role = 'student'`:
--
--   UPDATE tenants SET weekend_days = '{0,1,2,3,4,5,6}'      -> 1 row
--   UPDATE tenants SET plan_code='complete', student_cap=999999 -> 1 row
--
-- The first declares the school has no teaching days, which is the
-- configuration this whole workstream reads. The second is a self-serve
-- upgrade to every paid service: `app.tenant_access()` reads `plan_code`, so
-- the entire D16 commercial layer was bypassable by any account in the school.
--
-- RLS cannot express "these columns, not those", so this is a trigger. It
-- refuses a change to the platform-owned columns when the caller is the
-- application role. It does NOT fire for:
--   * `app.create_tenant` / `set_tenant_status` / `set_student_cap`, which are
--     SECURITY DEFINER and therefore run as the owner;
--   * the platform console, which connects as a different database role;
--   * `ops-svc`'s branding and settings writers, which touch only
--     `tenants.settings` (verified: both are `UPDATE tenants SET settings = …`).
--
-- Rollback: db/rollback/069_routine_authoring_scope.sql. It restores the
-- `FOR ALL / USING (true)` pairs and drops the trigger, which re-opens the
-- delete hole and the plan-code escalation.

BEGIN;

-- ── routines ──────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS routine_write_scope ON routines;

CREATE POLICY routines_insert_scope ON routines
  AS RESTRICTIVE FOR INSERT TO shikhon_app
  WITH CHECK (app.has_role('principal', 'school_owner', 'academic_coordinator'));

CREATE POLICY routines_update_scope ON routines
  AS RESTRICTIVE FOR UPDATE TO shikhon_app
  USING (app.has_role('principal', 'school_owner', 'academic_coordinator'))
  WITH CHECK (app.has_role('principal', 'school_owner', 'academic_coordinator'));

CREATE POLICY routines_delete_scope ON routines
  AS RESTRICTIVE FOR DELETE TO shikhon_app
  USING (app.has_role('principal', 'school_owner', 'academic_coordinator'));

-- ── routine_slots ─────────────────────────────────────────────────────────
DROP POLICY IF EXISTS routine_slots_write_scope ON routine_slots;

CREATE POLICY routine_slots_insert_scope ON routine_slots
  AS RESTRICTIVE FOR INSERT TO shikhon_app
  WITH CHECK (app.has_role('principal', 'school_owner', 'academic_coordinator'));

CREATE POLICY routine_slots_update_scope ON routine_slots
  AS RESTRICTIVE FOR UPDATE TO shikhon_app
  USING (app.has_role('principal', 'school_owner', 'academic_coordinator'))
  WITH CHECK (app.has_role('principal', 'school_owner', 'academic_coordinator'));

CREATE POLICY routine_slots_delete_scope ON routine_slots
  AS RESTRICTIVE FOR DELETE TO shikhon_app
  USING (app.has_role('principal', 'school_owner', 'academic_coordinator'));

-- ── routine_slot_sections ─────────────────────────────────────────────────
-- The many-to-many that makes a parallel block one lesson for several
-- sections. It had no write scope at all.
CREATE POLICY routine_slot_sections_insert_scope ON routine_slot_sections
  AS RESTRICTIVE FOR INSERT TO shikhon_app
  WITH CHECK (app.has_role('principal', 'school_owner', 'academic_coordinator'));

CREATE POLICY routine_slot_sections_update_scope ON routine_slot_sections
  AS RESTRICTIVE FOR UPDATE TO shikhon_app
  USING (app.has_role('principal', 'school_owner', 'academic_coordinator'))
  WITH CHECK (app.has_role('principal', 'school_owner', 'academic_coordinator'));

CREATE POLICY routine_slot_sections_delete_scope ON routine_slot_sections
  AS RESTRICTIVE FOR DELETE TO shikhon_app
  USING (app.has_role('principal', 'school_owner', 'academic_coordinator'));

-- ── period_templates and period_definitions ───────────────────────────────
-- Structural configuration, like the calendar — so the same four roles the
-- calendar already uses (`calendar_insert_scope`, migration 043 — whose own
-- comment states the reason this file exists: "written as the three write
-- commands rather than FOR ALL, because a RESTRICTIVE FOR ALL applies its
-- USING to reads too"), which adds
-- it_admin to the three that author routines.
CREATE POLICY period_templates_insert_scope ON period_templates
  AS RESTRICTIVE FOR INSERT TO shikhon_app
  WITH CHECK (app.has_role('principal', 'school_owner', 'academic_coordinator', 'it_admin'));

CREATE POLICY period_templates_update_scope ON period_templates
  AS RESTRICTIVE FOR UPDATE TO shikhon_app
  USING (app.has_role('principal', 'school_owner', 'academic_coordinator', 'it_admin'))
  WITH CHECK (app.has_role('principal', 'school_owner', 'academic_coordinator', 'it_admin'));

CREATE POLICY period_templates_delete_scope ON period_templates
  AS RESTRICTIVE FOR DELETE TO shikhon_app
  USING (app.has_role('principal', 'school_owner', 'academic_coordinator', 'it_admin'));

CREATE POLICY period_definitions_insert_scope ON period_definitions
  AS RESTRICTIVE FOR INSERT TO shikhon_app
  WITH CHECK (app.has_role('principal', 'school_owner', 'academic_coordinator', 'it_admin'));

CREATE POLICY period_definitions_update_scope ON period_definitions
  AS RESTRICTIVE FOR UPDATE TO shikhon_app
  USING (app.has_role('principal', 'school_owner', 'academic_coordinator', 'it_admin'))
  WITH CHECK (app.has_role('principal', 'school_owner', 'academic_coordinator', 'it_admin'));

CREATE POLICY period_definitions_delete_scope ON period_definitions
  AS RESTRICTIVE FOR DELETE TO shikhon_app
  USING (app.has_role('principal', 'school_owner', 'academic_coordinator', 'it_admin'));

-- ── routine_substitutions ─────────────────────────────────────────────────
DROP POLICY IF EXISTS substitution_write_scope ON routine_substitutions;

CREATE POLICY routine_subs_insert_scope ON routine_substitutions
  AS RESTRICTIVE FOR INSERT TO shikhon_app
  WITH CHECK (app.has_role('principal', 'school_owner', 'academic_coordinator', 'dept_head'));

CREATE POLICY routine_subs_update_scope ON routine_substitutions
  AS RESTRICTIVE FOR UPDATE TO shikhon_app
  USING (app.has_role('principal', 'school_owner', 'academic_coordinator', 'dept_head'))
  WITH CHECK (app.has_role('principal', 'school_owner', 'academic_coordinator', 'dept_head'));

CREATE POLICY routine_subs_delete_scope ON routine_substitutions
  AS RESTRICTIVE FOR DELETE TO shikhon_app
  USING (app.has_role('principal', 'school_owner', 'academic_coordinator', 'dept_head'));

-- ── tenants: the platform owns the commercial and structural columns ──────
CREATE OR REPLACE FUNCTION app.assert_tenant_columns_platform_owned()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  -- Only the application role is constrained. SECURITY DEFINER functions run
  -- as their owner and the platform console connects as its own role, so both
  -- pass through untouched.
  IF current_user <> 'shikhon_app' THEN
    RETURN NEW;
  END IF;

  IF NEW.plan_code      IS DISTINCT FROM OLD.plan_code
     OR NEW.student_cap   IS DISTINCT FROM OLD.student_cap
     OR NEW.trial_ends_on IS DISTINCT FROM OLD.trial_ends_on
     OR NEW.status        IS DISTINCT FROM OLD.status
     OR NEW.slug          IS DISTINCT FROM OLD.slug
     OR NEW.weekend_days  IS DISTINCT FROM OLD.weekend_days
     OR NEW.shifts        IS DISTINCT FROM OLD.shifts
     OR NEW.dek_wrapped   IS DISTINCT FROM OLD.dek_wrapped
     OR NEW.dek_key_version IS DISTINCT FROM OLD.dek_key_version
     OR NEW.blind_index_pepper IS DISTINCT FROM OLD.blind_index_pepper
  THEN
    RAISE EXCEPTION
      'plan, cap, lifecycle, slug, weekend, shifts and key material are set by the platform, not by a school account'
      USING ERRCODE = 'insufficient_privilege',
            HINT = 'use the platform console; a school may change tenants.settings only';
  END IF;
  RETURN NEW;
END $function$;

DROP TRIGGER IF EXISTS trg_tenants_platform_columns ON tenants;
CREATE TRIGGER trg_tenants_platform_columns
  BEFORE UPDATE ON tenants
  FOR EACH ROW EXECUTE FUNCTION app.assert_tenant_columns_platform_owned();

COMMENT ON TABLE routines IS
  'A timetable version for one (academic year, shift). Status is the ROUTINE '
  'lifecycle — draft/review/active/superseded/archived — and is entirely '
  'separate from exams.status, which migration 068 established after '
  'publishing a routine was found to permanently brick the exam.';

COMMIT;
