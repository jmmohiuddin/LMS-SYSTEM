-- Rollback for 065 — rooms goes back to tenant isolation and nothing else.
--
-- Read what this restores before running it: any role in the school regains
-- the ability to insert and update rooms, including `student`. That is the
-- pre-065 state faithfully, and it is a real widening rather than a no-op.
-- If /api/v1/rms/rooms is still deployed, its `requireRole` becomes the only
-- thing standing between a student's session and the room register.

BEGIN;

DROP POLICY IF EXISTS rooms_insert_scope ON rooms;
DROP POLICY IF EXISTS rooms_update_scope ON rooms;
DROP POLICY IF EXISTS rooms_delete_scope ON rooms;

COMMENT ON TABLE rooms IS NULL;

COMMIT;
