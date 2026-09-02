-- Rollback for 069 — the routine tables go back to a delete hole.
--
-- Read what this restores before running it. It is a real widening, not a
-- no-op, and it destroys no data:
--
--   * `routines` and `routine_slots` return to one RESTRICTIVE `FOR ALL`
--     policy with `USING (true)`. That gates INSERT and UPDATE through its
--     WITH CHECK and leaves DELETE ungated, so **any account in a school —
--     including a student's — can delete that school's entire timetable**
--     (deleting the `routines` row cascades to every slot). Proved live
--     before 069 was written.
--   * `period_templates`, `period_definitions` and `routine_slot_sections`
--     return to `tenant_isolation` alone, so any role in the school can
--     rewrite when the school day starts and ends — which moves every lesson
--     in the building, because every slot points at a `period_definition_id`.

BEGIN;

DROP POLICY IF EXISTS period_definitions_delete_scope ON period_definitions;
DROP POLICY IF EXISTS period_definitions_update_scope ON period_definitions;
DROP POLICY IF EXISTS period_definitions_insert_scope ON period_definitions;

DROP POLICY IF EXISTS period_templates_delete_scope ON period_templates;
DROP POLICY IF EXISTS period_templates_update_scope ON period_templates;
DROP POLICY IF EXISTS period_templates_insert_scope ON period_templates;

DROP POLICY IF EXISTS routine_slot_sections_delete_scope ON routine_slot_sections;
DROP POLICY IF EXISTS routine_slot_sections_update_scope ON routine_slot_sections;
DROP POLICY IF EXISTS routine_slot_sections_insert_scope ON routine_slot_sections;

DROP POLICY IF EXISTS routine_slots_delete_scope ON routine_slots;
DROP POLICY IF EXISTS routine_slots_update_scope ON routine_slots;
DROP POLICY IF EXISTS routine_slots_insert_scope ON routine_slots;

DROP POLICY IF EXISTS routines_delete_scope ON routines;
DROP POLICY IF EXISTS routines_update_scope ON routines;
DROP POLICY IF EXISTS routines_insert_scope ON routines;

-- Restored exactly as migration 006/0xx had them.
CREATE POLICY routine_write_scope ON routines
  AS RESTRICTIVE FOR ALL TO shikhon_app
  USING (true)
  WITH CHECK (app.has_role('principal', 'school_owner', 'academic_coordinator'));

CREATE POLICY routine_slots_write_scope ON routine_slots
  AS RESTRICTIVE FOR ALL TO shikhon_app
  USING (true)
  WITH CHECK (app.has_role('principal', 'school_owner', 'academic_coordinator'));

COMMENT ON TABLE routines IS NULL;

COMMIT;
