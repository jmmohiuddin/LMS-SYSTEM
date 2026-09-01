-- ---------------------------------------------------------------------------
-- 056 — `portal_of` must not sweep the machinery in with the teachers.
--
-- ── The bug this exists to fix ───────────────────────────────────────────
-- 052's `app.portal_of` named five roles and folded EVERYTHING else into
-- 'teacher', with a comment listing the roles it meant: class teacher,
-- subject teacher, department head, coordinator, accountant. That was right
-- about people and silent about machines.
--
-- `system_ingest` is not a person. It is the role every one of these runs as:
--
--   services/identity-svc/api/otp-request.ts     — asking for a login code
--   services/identity-svc/api/otp-verify.ts      — using it
--   services/identity-svc/api/refresh.ts         — staying signed in
--   services/identity-svc/api/activate.ts        — a school's first admin
--   services/identity-svc/api/logout.ts          — signing out
--   services/sms-svc/src/dispatch.ts             — the SMS run
--
-- Until 054 that did not matter, because nothing read the portal switch. The
-- moment it did, closing the TEACHER portal would have stopped every login in
-- the school — students, guardians and the principal who had to undo it —
-- and killed the SMS pipeline on the way past. The console would have
-- reported it as "teachers cannot sign in".
--
-- ── The rule ────────────────────────────────────────────────────────────
-- Portals are for people. A role that is not a person gets 'system', which is
-- not a key the console can write and therefore not a door it can close. The
-- school-level controls — suspended, maintenance, limited — still apply to
-- these paths, and should: a suspended school should not be issuing logins.
-- ---------------------------------------------------------------------------

BEGIN;

CREATE OR REPLACE FUNCTION app.portal_of(p_role text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE p_role
    WHEN 'student'      THEN 'student'
    WHEN 'guardian'     THEN 'guardian'
    WHEN 'it_admin'     THEN 'it_admin'
    WHEN 'principal'    THEN 'principal'
    WHEN 'school_owner' THEN 'principal'
    -- Not people. Never behind a portal switch — see the header.
    WHEN 'system_ingest' THEN 'system'
    WHEN 'system'        THEN 'system'
    WHEN 'super_admin'   THEN 'system'
    WHEN 'platform_admin' THEN 'system'
    -- Everyone else is staff standing in a school: class teacher, subject
    -- teacher, department head, academic coordinator, accountant.
    ELSE 'teacher'
  END;
$$;

COMMIT;
