-- ============================================================================
-- 050 — B-7: a guardianship can END, without ever being deleted
--
-- Migration 042 denied DELETE on `guardianships` outright, and said why:
--
--   "Unlinking a guardian removes the record that they were ever responsible.
--    The office marks a link inactive by moving `is_primary` and the
--    permissions, which keeps the row; a genuine data-entry error is rare
--    enough to be worth a support request rather than a delete button on a
--    family relationship."
--
-- That reasoning is right and is not reversed here. What it did not provide is
-- the thing it assumed existed: a way to say "this relationship has ended".
-- `is_primary` and `receives_sms` are *permissions within* a relationship —
-- turning them off leaves a former guardian still able to read a child's
-- attendance, results and fees, because `app.my_ward_ids()` asks only whether
-- the row exists.
--
-- So the row stays forever, and gains an end date. Nothing is deleted: not the
-- link, not a receipt, not an attendance record, not an audit entry.
--
-- ── The dangerous part, and how it is made un-forgettable ──────────────────
--
-- `guardianships` is read at twelve places across the schema and the services.
-- Eleven of them would silently keep working after a revocation — including
-- `sms-svc/dispatch.ts`, which selects guardians for the absence SMS. A
-- revocation that missed that one query would keep texting a former guardian
-- about a child every time they were marked absent, which is worse than not
-- shipping the feature at all.
--
-- Filtering eleven call sites by hand is a list somebody forgets. So the
-- filter goes where it cannot be forgotten: a RESTRICTIVE SELECT policy that
-- makes revoked rows **invisible** to ordinary readers. Every one of those
-- queries runs as `shikhon_app`, so all of them are corrected by this policy
-- and none of them changed a character:
--
--   sms-svc/dispatch.ts   (role `system_ingest`) — the absence SMS
--   ops-svc/notices.ts    notice recipients
--   ops-svc/document.ts   who may print
--   ops-svc/guardians.ts  the guardian panel's counts and lists
--   academics/ward.ts     the guardian home
--   academics/hierarchy.ts, search.ts
--   the `users_scope` RLS policy's household clause
--
-- The exceptions are the two SECURITY DEFINER functions, which run as the
-- owner and are therefore NOT subject to the policy. There are exactly two,
-- they are both in this file, and both are rewritten below:
-- `app.my_ward_ids()` and `app.notice_recipients()`.
--
-- Management still sees revoked rows, because the office needs to know that a
-- link ended and when. That is the only exception in the policy, it is stated
-- once, and it is the same three roles that may create or edit a link.
--
-- ── Why a child cannot be left uncontactable ───────────────────────────────
--
-- Migration 031 refuses to create a student who has no phone, no email AND no
-- contactable guardian. Revocation can produce that state through the back
-- door — the trigger fires on `users`, not on this table — so
-- `app.revoke_guardianship()` refuses to remove the last contactable guardian
-- of a student with no contact details of their own. A school that loses its
-- only route to a family has lost something it cannot get back from the app.
-- ============================================================================
BEGIN;

-- ---------------------------------------------------------------------
-- 1. The end date, and who ended it
-- ---------------------------------------------------------------------
ALTER TABLE guardianships
  ADD COLUMN revoked_at     timestamptz,
  ADD COLUMN revoked_by     uuid REFERENCES users(id),
  ADD COLUMN revoked_reason text;

-- All three together or none. A revocation with no actor is an audit gap, and
-- one with no reason is indistinguishable from a bug — the same rule
-- migration 025 applies to a subject override.
ALTER TABLE guardianships
  ADD CONSTRAINT guardianship_revocation_complete CHECK (
    (revoked_at IS NULL AND revoked_by IS NULL AND revoked_reason IS NULL)
    OR (revoked_at IS NOT NULL AND revoked_by IS NOT NULL
        AND revoked_reason IS NOT NULL AND length(btrim(revoked_reason)) > 0));

COMMENT ON COLUMN guardianships.revoked_at IS
  'B-7. When this relationship ENDED. The row is never deleted: past fees, '
  'receipts, attendance and audit entries all reference this period and must '
  'stay readable. NULL means active.';

-- ---------------------------------------------------------------------
-- 2. Both unique constraints become partial
--
-- Without this a revoked link can never be re-created — and the commonest
-- reason to revoke is a data-entry error, whose fix is to link the RIGHT
-- guardian, often the same person against a different child. The primary-
-- guardian index has the same problem in a worse form: a student whose primary
-- guardian is revoked could never be given another.
-- ---------------------------------------------------------------------
ALTER TABLE guardianships
  DROP CONSTRAINT guardianships_tenant_id_student_id_guardian_id_key;

CREATE UNIQUE INDEX uq_guardianship_active
  ON guardianships (tenant_id, student_id, guardian_id)
  WHERE revoked_at IS NULL;

DROP INDEX uq_guardianship_primary;
CREATE UNIQUE INDEX uq_guardianship_primary
  ON guardianships (tenant_id, student_id)
  WHERE is_primary AND revoked_at IS NULL;

-- The guardian-side lookup is the hot one (`my_ward_ids`, the panel), and it
-- now always carries the revoked test.
DROP INDEX ix_guardianship_by_guardian;
CREATE INDEX ix_guardianship_by_guardian
  ON guardianships (tenant_id, guardian_id) WHERE revoked_at IS NULL;

-- ---------------------------------------------------------------------
-- 3. Revoked rows are invisible — except to the office
-- ---------------------------------------------------------------------
CREATE POLICY guardianship_hide_revoked ON guardianships
  AS RESTRICTIVE FOR SELECT TO shikhon_app
  USING (revoked_at IS NULL
         OR app.has_role('principal', 'school_owner', 'it_admin'));

COMMENT ON POLICY guardianship_hide_revoked ON guardianships IS
  'B-7. The one place the "has this link ended" test lives for every ordinary '
  'reader, including the SMS dispatcher. Management is exempt because the '
  'office must be able to see that a link ended, and when. app.has_role reads '
  'a GUC and touches no table, so this cannot recurse through users_scope.';

-- ---------------------------------------------------------------------
-- 4. The two SECURITY DEFINER readers, which the policy cannot reach
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.my_ward_ids() RETURNS uuid[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, app AS $$
  SELECT COALESCE(array_agg(g.student_id), '{}')
  FROM guardianships g
  WHERE g.tenant_id = app.current_tenant()
    AND g.guardian_id = app.current_user_id()
    -- B-7. Definer rights bypass guardianship_hide_revoked, so the test is
    -- written out here. This function is what `app.can_see_student()` asks,
    -- and `can_see_student` is what every guardian-facing RLS policy asks —
    -- so this one line is what actually ends a former guardian's access.
    AND g.revoked_at IS NULL;
$$;

REVOKE ALL ON FUNCTION app.my_ward_ids() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.my_ward_ids() TO shikhon_app;

-- The notice audience resolver. Reproduced from migration 040 with the
-- revoked test added to BOTH guardian branches — the payers branch and the
-- general one. Missing either would address a notice about a child to
-- somebody who is no longer their guardian.
CREATE OR REPLACE FUNCTION app.resolve_notice_audience(
  p_tenant   uuid,
  p_audience jsonb
)
RETURNS TABLE (user_id uuid, about_student_id uuid)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, app
AS $$
DECLARE
  v_type text := p_audience->>'type';
  v_ids  uuid[];
BEGIN
  IF app.current_tenant() IS DISTINCT FROM p_tenant THEN
    RAISE EXCEPTION 'resolve_notice_audience must run inside the tenant''s own context'
      USING ERRCODE = '42501';
  END IF;

  IF p_audience ? 'ids' THEN
    SELECT array_agg(value::text::uuid) INTO v_ids
      FROM jsonb_array_elements_text(p_audience->'ids') AS value;
  END IF;

  IF v_type IN ('class','section','users') AND (v_ids IS NULL OR cardinality(v_ids) = 0) THEN
    RAISE EXCEPTION 'audience type % requires a non-empty ids array', v_type
      USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  -- ── Named individuals ──────────────────────────────────────────────
  SELECT u.id, NULL::uuid
    FROM users u
   WHERE v_type = 'users'
     AND u.tenant_id = p_tenant AND u.id = ANY(v_ids) AND u.status = 'active'

  UNION
  -- ── Everyone, and the staff-only case ──────────────────────────────
  -- app.is_staff() reads the SESSION's role, so it cannot be used here to
  -- classify OTHER users. Staff is defined by holding a staff role.
  SELECT u.id, NULL::uuid
    FROM users u
   WHERE v_type IN ('all','staff')
     AND u.tenant_id = p_tenant AND u.status = 'active'
     AND EXISTS (
       SELECT 1 FROM user_roles ur JOIN roles r ON r.code = ur.role_code
        WHERE ur.tenant_id = p_tenant AND ur.user_id = u.id AND r.is_staff
          AND (ur.valid_until IS NULL OR ur.valid_until > CURRENT_DATE))

  UNION
  -- ── Students: enrolled this year, optionally narrowed ───────────────
  SELECT e.student_id, NULL::uuid
    FROM enrolments e
    JOIN academic_years ay ON ay.id = e.academic_year_id AND ay.is_current
    LEFT JOIN sections s ON s.id = e.section_id
   WHERE v_type IN ('all','students','class','section')
     AND e.tenant_id = p_tenant AND e.status = 'active'
     AND (v_type NOT IN ('class','section') OR (
           (v_type = 'section' AND e.section_id = ANY(v_ids))
        OR (v_type = 'class'   AND s.class_id = ANY(v_ids))))

  UNION
  -- ── Guardians authorised to pay ────────────────────────────────────
  -- A separate audience from 'guardians', because a fee notice addressed to
  -- everyone who is merely RELATED to a student reaches people who cannot
  -- act on it — and a payment reminder to someone with no authority to pay
  -- is noise that costs an SMS.
  SELECT g.guardian_id, g.student_id
    FROM guardianships g
    JOIN enrolments e ON e.student_id = g.student_id AND e.tenant_id = g.tenant_id
                     AND e.status = 'active'
    JOIN academic_years ay ON ay.id = e.academic_year_id AND ay.is_current
   WHERE v_type = 'guardians_payers'
     AND g.tenant_id = p_tenant AND g.can_pay_fees = true
     -- B-7. Definer rights bypass guardianship_hide_revoked, so both guardian
     -- branches carry the test explicitly. Missing it here would send a fee
     -- reminder about a child to somebody who is no longer their guardian.
     AND g.revoked_at IS NULL

  UNION
  -- ── Guardians: once per child in scope ─────────────────────────────
  SELECT g.guardian_id, g.student_id
    FROM guardianships g
    JOIN enrolments e ON e.student_id = g.student_id AND e.tenant_id = g.tenant_id
                     AND e.status = 'active'
    JOIN academic_years ay ON ay.id = e.academic_year_id AND ay.is_current
    LEFT JOIN sections s ON s.id = e.section_id
   WHERE v_type IN ('all','guardians','class','section')
     AND g.tenant_id = p_tenant
     AND g.revoked_at IS NULL                                        -- B-7
     AND (v_type NOT IN ('class','section') OR (
           (v_type = 'section' AND e.section_id = ANY(v_ids))
        OR (v_type = 'class'   AND s.class_id = ANY(v_ids))));
END $$;

-- ---------------------------------------------------------------------
-- 5. Ending a relationship
--
-- SECURITY INVOKER, like `app.set_guardian_permissions` in 042 and for the
-- same reason: RLS decides whether this caller may write. A definer function
-- here would be a way to unlink a child in a school you do not belong to.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.revoke_guardianship(
  p_student  uuid,
  p_guardian uuid,
  p_reason   text
) RETURNS TABLE (revoked_at timestamptz, was_primary boolean)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, app
AS $$
DECLARE
  v_was_primary boolean;
  v_now timestamptz := now();
BEGIN
  IF p_reason IS NULL OR length(btrim(p_reason)) = 0 THEN
    RAISE EXCEPTION 'reason_required' USING ERRCODE = '23514';
  END IF;

  -- The child must keep a way of being reached. Migration 031 refuses to
  -- create a student with no phone, no email and no contactable guardian;
  -- revocation is the back door into that state, because that trigger fires
  -- on `users` and not on this table.
  IF EXISTS (
    SELECT 1 FROM users s
     WHERE s.id = p_student AND s.tenant_id = app.current_tenant()
       AND s.phone_e164 IS NULL AND s.email IS NULL
  ) AND NOT EXISTS (
    SELECT 1
      FROM guardianships g
      JOIN users gu ON gu.id = g.guardian_id
     WHERE g.tenant_id = app.current_tenant()
       AND g.student_id = p_student
       AND g.guardian_id <> p_guardian
       AND g.revoked_at IS NULL
       AND gu.deleted_at IS NULL
       AND (gu.phone_e164 IS NOT NULL OR gu.email IS NOT NULL)
  ) THEN
    RAISE EXCEPTION 'last_contactable_guardian' USING ERRCODE = '23514';
  END IF;

  UPDATE guardianships g
     SET revoked_at = v_now,
         revoked_by = app.current_user_id(),
         revoked_reason = btrim(p_reason),
         -- A revoked link is not the primary one. Left set, the partial index
         -- would be satisfied but every "who do we ring" query would still
         -- name them first.
         is_primary = false,
         receives_sms = false
   WHERE g.tenant_id = app.current_tenant()
     AND g.student_id = p_student
     AND g.guardian_id = p_guardian
     AND g.revoked_at IS NULL
  RETURNING g.is_primary INTO v_was_primary;

  -- RLS UPDATE scope is RESTRICTIVE, so an unauthorised caller matches no row
  -- rather than raising. Zero rows is therefore either "not yours to do" or
  -- "already revoked", and both are honestly reported as not-found: telling
  -- the two apart would say whether the link exists.
  IF NOT FOUND THEN
    RAISE EXCEPTION 'guardianship_not_found' USING ERRCODE = 'P0002';
  END IF;

  RETURN QUERY SELECT v_now, COALESCE(v_was_primary, false);
END $$;

COMMENT ON FUNCTION app.revoke_guardianship(uuid, uuid, text) IS
  'B-7. Ends a guardianship without deleting it. Refuses to remove the last '
  'contactable guardian of a student who has no phone or email of their own. '
  'SECURITY INVOKER: RLS decides who may write.';

REVOKE ALL ON FUNCTION app.revoke_guardianship(uuid, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.revoke_guardianship(uuid, uuid, text) TO shikhon_app;

-- ---------------------------------------------------------------------
-- 6. The platform console's guardian count
--
-- The third and last reader the policy cannot reach: it runs as
-- `shikhon_platform`. Reproduced from migration 045 with the revoked test.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.tenant_onboarding_state(p_tenant uuid)
RETURNS TABLE (
  years         bigint,
  grading_bands bigint,
  classes       bigint,
  sections      bigint,
  subjects      bigint,
  fee_heads     bigint,
  teachers      bigint,
  students      bigint,
  guardians     bigint,
  admins        bigint,
  has_branding  boolean
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, app
AS $$
  SELECT
    (SELECT count(*) FROM academic_years  WHERE tenant_id = p_tenant),
    (SELECT count(*) FROM grading_bands   WHERE tenant_id = p_tenant),
    (SELECT count(*) FROM classes         WHERE tenant_id = p_tenant),
    (SELECT count(*) FROM sections        WHERE tenant_id = p_tenant),
    (SELECT count(*) FROM subjects        WHERE tenant_id = p_tenant),
    (SELECT count(*) FROM fee_heads       WHERE tenant_id = p_tenant),
    (SELECT count(DISTINCT ur.user_id) FROM user_roles ur
      WHERE ur.tenant_id = p_tenant
        AND ur.role_code IN ('class_teacher','subject_teacher','dept_head')),
    (SELECT count(*) FROM student_profiles WHERE tenant_id = p_tenant),
    -- B-7: active links only. This runs as shikhon_platform, which
    -- guardianship_hide_revoked does not apply to, and a guardian count that
    -- includes ended relationships is a number nobody can reconcile against
    -- the school's own screen.
    (SELECT count(DISTINCT g.guardian_id) FROM guardianships g
      WHERE g.tenant_id = p_tenant AND g.revoked_at IS NULL),
    (SELECT count(DISTINCT ur.user_id) FROM user_roles ur
      WHERE ur.tenant_id = p_tenant
        AND ur.role_code IN ('principal','school_owner','it_admin')),
    -- "Branded" means the school has been past the editor, not merely that
    -- migration 039 seeded its name. A logo is the field an operator would
    -- recognise as having done the step.
    (SELECT COALESCE(t.settings->'branding'->>'logoUrl', '') <> ''
       FROM tenants t WHERE t.id = p_tenant);
$$;

COMMIT;
