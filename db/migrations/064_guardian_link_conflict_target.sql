-- ---------------------------------------------------------------------------
-- 064 — linking a guardian to a student has been raising an error since 050.
--
-- ── What was found ──────────────────────────────────────────────────────
-- Migration 050 gave guardianships a `revoked_at` column and made both
-- unique constraints partial, so that a link revoked by mistake could be
-- created again:
--
--   ALTER TABLE guardianships DROP CONSTRAINT
--     guardianships_tenant_id_student_id_guardian_id_key;
--   CREATE UNIQUE INDEX uq_guardianship_active
--     ON guardianships (tenant_id, student_id, guardian_id)
--     WHERE revoked_at IS NULL;
--
-- `app.set_guardian_permissions`, written in 042, upserts through that
-- constraint:
--
--   ON CONFLICT (tenant_id, student_id, guardian_id) DO UPDATE
--
-- Postgres will not infer a PARTIAL index from a bare column list — the
-- statement has to repeat the predicate. 050 replaced the index and left the
-- function alone, so since 050 every call has failed outright with
--
--   ERROR: there is no unique or exclusion constraint matching the
--          ON CONFLICT specification
--
-- That is the whole guardian-linking path: adding a guardian to a student,
-- changing a relation, moving `is_primary`, and setting the `receives_sms` /
-- `can_pay_fees` permissions that decide who gets the absence SMS and who may
-- pay a fee.
--
-- ── How it survived four phases and a full audit ────────────────────────
-- Three CI suites cover this and all three have been failing:
-- `guardian_links.sql`, `documents.sql`, `student_search.sql`. They run only
-- in .github/workflows/database.yml. `npm test` — the command every phase
-- used to declare itself green — runs the Node suites and has never run the
-- 26 SQL files in db/tests. So the tests were right, and nobody local ever
-- heard them. P-pilot-hardening adds them to `npm test`.
--
-- ── Not yet in production ───────────────────────────────────────────────
-- Production is on migration 048 and still has the full unique constraint,
-- so guardian linking works there today. It would have broken the moment the
-- M2 catch-up applied 049–062. That is the argument for M2's staging rehearsal
-- rather than a straight production run.
--
-- ── The second fix ──────────────────────────────────────────────────────
-- The demotion above the INSERT clears `is_primary` on every row for the
-- student, revoked rows included, which rewrites a historical record 050 said
-- explicitly must stay readable. It is now scoped to live links. Nobody has
-- hit this, because the statement after it always threw.
--
-- Body from `pg_get_functiondef`; two substitutions, asserted at generation,
-- and the reverse-substitution compared byte-for-byte against the original.
-- ---------------------------------------------------------------------------

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
       AND guardian_id <> p_guardian
       AND revoked_at IS NULL;
  END IF;

  INSERT INTO guardianships
    (tenant_id, student_id, guardian_id, relation, is_primary, receives_sms, can_pay_fees)
  VALUES
    (v_tenant, p_student, p_guardian, p_relation, p_is_primary, p_receives_sms, p_can_pay_fees)
  ON CONFLICT (tenant_id, student_id, guardian_id) WHERE revoked_at IS NULL DO UPDATE
    SET relation     = EXCLUDED.relation,
        is_primary   = EXCLUDED.is_primary,
        receives_sms = EXCLUDED.receives_sms,
        can_pay_fees = EXCLUDED.can_pay_fees
  RETURNING id INTO v_id;

  RETURN v_id;
END $function$;

COMMENT ON FUNCTION app.set_guardian_permissions(uuid, uuid, text, boolean, boolean, boolean) IS
  'R-3 completion. Link a guardian to a student, or change the permissions of '
  'an existing link. Demoting the previous primary and promoting the new one '
  'happen in one statement pair inside one transaction, because a failure '
  'between them leaves a child with no primary guardian. '
  'The conflict target must repeat uq_guardianship_active''s predicate — see '
  'migration 064.';

COMMIT;
