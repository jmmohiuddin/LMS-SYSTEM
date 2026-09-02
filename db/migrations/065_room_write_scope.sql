-- ---------------------------------------------------------------------------
-- 065 — rooms stops being writable by anyone in the school, on the day it
--       becomes writable at all.
--
-- ── What was found ──────────────────────────────────────────────────────
-- `rooms` has carried exactly one policy since migration 003: `tenant_isolation`,
-- PERMISSIVE, FOR ALL. Migration 042 gave `classes` and `sections` the
-- RESTRICTIVE write scopes they had been missing — "a subject teacher's session
-- could create a class or decide who pays a child's fees" — and did not touch
-- `rooms`.
--
-- So a session holding `app.role = 'student'` can INSERT a room today. Verified
-- against a live database inside a rolled-back transaction before this file was
-- written.
--
-- Nothing has ever exercised it, because nothing in the product wrote rooms at
-- all: 112 tenants, zero rows, no writer in TypeScript and none in any `app.*`
-- function. That is precisely the shape of hole worth closing BEFORE a writer
-- makes it reachable — the P0 endpoint `/api/v1/rms/rooms` lands in the same
-- commit as this migration, and `requireRole` there is only the clean 403 in
-- front of what this file enforces.
--
-- ── Per-command, not FOR ALL ────────────────────────────────────────────
-- A RESTRICTIVE `FOR ALL` applies its USING clause to SELECT as well, and rooms
-- must stay readable by every role: the routine grid, the student's day view,
-- the admit card and the solver all join it. Same reasoning and the same shape
-- as migration 042's header.
--
-- ── Nobody gets DELETE ──────────────────────────────────────────────────
-- `exam_halls.room_id` is ON DELETE RESTRICT, while `sections.home_room_id` and
-- `routine_slots.room_id` are ON DELETE SET NULL. So a delete either fails on a
-- hall or silently strips the room out of every timetable row that ever named
-- it — a past routine would quietly forget where a class was held. A room a
-- school stops using is marked unbookable; the history keeps pointing at it.
-- Identical rule to `classes` and `sections` in 042.
-- ---------------------------------------------------------------------------

BEGIN;

CREATE POLICY rooms_insert_scope ON rooms
  AS RESTRICTIVE FOR INSERT TO shikhon_app
  WITH CHECK (app.has_role('principal', 'school_owner', 'academic_coordinator', 'it_admin'));

CREATE POLICY rooms_update_scope ON rooms
  AS RESTRICTIVE FOR UPDATE TO shikhon_app
  USING      (app.has_role('principal', 'school_owner', 'academic_coordinator', 'it_admin'))
  WITH CHECK (app.has_role('principal', 'school_owner', 'academic_coordinator', 'it_admin'));

CREATE POLICY rooms_delete_scope ON rooms
  AS RESTRICTIVE FOR DELETE TO shikhon_app
  USING (false);

COMMENT ON TABLE rooms IS
  'Physical rooms. `capabilities` is matched against subjects.requires_capability '
  'by the RMS solver. `is_bookable = false` removes a room from the solver''s '
  'spare and capable pools; it does NOT remove it from a section''s home_room_id. '
  'Written only through /api/v1/rms/rooms — see migration 065.';

COMMIT;
