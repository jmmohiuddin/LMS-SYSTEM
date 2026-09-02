-- Rollback for 064 — put app.set_guardian_permissions back as 042 wrote it.
--
-- Read this before running it. The pre-064 function DOES NOT WORK on any
-- database that has migration 050: every call raises
--
--   ERROR: there is no unique or exclusion constraint matching the
--          ON CONFLICT specification
--
-- so rolling 064 back in isolation re-breaks guardian linking. It exists to
-- keep the rollback chain complete — 064 must be undoable before 050 can be,
-- and 050 is the migration that makes the old body wrong. Roll back past 050
-- in the same operation, or do not roll this back at all.
--
-- Body reproduced from the pre-064 definition, byte for byte.

BEGIN;

CREATE OR REPLACE FUNCTION app.set_guardian_permissions(p_student uuid, p_guardian uuid, p_relation text, p_is_primary boolean, p_receives_sms boolean, p_can_pay_fees boolean)
 RETURNS uuid
 LANGUAGE plpgsql
 SET search_path TO 'public', 'app'
AS $function$
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
END $function$;

COMMIT;
