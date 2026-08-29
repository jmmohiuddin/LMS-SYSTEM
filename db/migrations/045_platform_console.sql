-- ============================================================================
-- 045 — The platform can create a school  (R-7, docs/11-MASTER-PLAN.md §R-7)
--
-- Everything R-7 needs already existed except the one thing it is about.
-- `tenants` has carried `plan_code`, `student_cap`, `trial_ends_on`, `status`,
-- `eiin`, `weekend_days`, `dek_wrapped` and `blind_index_pepper` since
-- migration 001. `app.provision_tenant()` has seeded a school's whole academic
-- spine since 012. `audit.platform_access` has been waiting since 001.
--
-- What was missing is a way to INSERT a tenant at all.
--
-- ── Why the runtime role cannot do it, and must not be able to ─────────
-- `tenant_self` on `tenants` is `USING (id = app.current_tenant())`, and with
-- no separate WITH CHECK that expression also governs INSERT. So
-- `shikhon_app` can only ever write a tenant row whose id equals the tenant it
-- is already inside — which is to say, it cannot create a school, and cannot
-- list one either. That is the property the whole product's isolation rests
-- on and R-7 must not spend it.
--
-- The three functions below are therefore SECURITY DEFINER with a pinned
-- `search_path`, granted to `shikhon_platform` and to nobody else — the same
-- shape as `app.public_branding()` in migration 039, for the same reason.
-- `shikhon_app` is not granted EXECUTE, so a fully compromised school
-- application still cannot create, enumerate or suspend a school.
--
-- ── Audit is written by the function, not by the caller ────────────────
-- Every one of these writes `audit.platform_access` in the same transaction
-- as the act. An action that rolls back leaves no misleading audit row, and
-- an audit row that exists means the action committed. Putting the write
-- inside the function rather than in platform-svc means it cannot be
-- forgotten by a new call site.
--
-- ── The onboarding state is DERIVED, never stored ──────────────────────
-- §23 of the R-7 brief wants the operator to see how far a half-finished
-- school got. The obvious implementation is a stage column the wizard
-- updates. It is also the wrong one: a stored stage is exactly what goes
-- stale when provisioning dies between the act and the bookkeeping, which is
-- the failure §22 is about.
--
-- `app.tenant_onboarding_state()` counts the real rows instead — years,
-- grading bands, classes, sections, staff, students, guardians, admins. It
-- cannot disagree with the database because it IS the database, and after a
-- crash it reports what actually landed rather than what someone meant to
-- land.
--
-- ── student_cap becomes real ───────────────────────────────────────────
-- `tenants.student_cap` has existed since 001 with a CHECK that it is
-- positive, and has never been enforced anywhere: not on enrolment, not on
-- import, not at all. A commercial limit that only the price list knows about
-- is not a limit. The statement-level trigger below is the enforcement, and
-- it is statement-level on purpose — a row trigger would count the whole
-- school once per row and turn an 800-student import into 800 counts.
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- 1. The platform role can log in and reach the schema.
--
-- `shikhon_platform` has existed since 001 with BYPASSRLS and no grants and
-- no LOGIN — a role nothing could use. It is the correct identity for this
-- work: platform-svc connects as it, through its own PLATFORM_DATABASE_URL,
-- so the credential that can create a school is a different credential from
-- the one every school's own requests run under.
--
-- No password is set here. A migration that put a password in a file that
-- lives in git would be worse than the problem it solved; deployment sets it
-- (docs/06-DEPLOYMENT.md), and until it does, platform-svc has no connection
-- string and answers 503 rather than falling back to the runtime role.
-- ---------------------------------------------------------------------
ALTER ROLE shikhon_platform WITH LOGIN;
GRANT USAGE ON SCHEMA app, audit, public TO shikhon_platform;

-- ── BYPASSRLS comes OFF, deliberately ─────────────────────────────────
-- Migration 001 created this role with BYPASSRLS, back when it was a role
-- nothing could use. Giving it a login and leaving that on would mean the one
-- service that touches every school's data is also the one service where
-- row-level security does not apply — and `assertRlsEnforced` in
-- packages/server-core would refuse to start against it, which is the boot
-- guard doing exactly its job.
--
-- It does not need it. The three cross-tenant operations below are SECURITY
-- DEFINER and run as the owner, so they work regardless. Everything else
-- platform-svc does is tenant-scoped work inside ONE school — provisioning,
-- branding, imports, the first admin — and for that it sets `app.tenant_id`
-- and `app.role` like every other caller and lives under the same policies.
--
-- The result is that a bug in the onboarding wizard cannot write into the
-- wrong school, because RLS is still standing between it and the rows.
ALTER ROLE shikhon_platform WITH NOBYPASSRLS;

-- Table privileges come from membership rather than a second list to keep in
-- sync. Membership is additive, so the platform role inherits what the
-- runtime role may do and keeps the platform-only EXECUTE grants below that
-- the runtime role is explicitly denied.
GRANT shikhon_app TO shikhon_platform;

-- The platform operator reads its OWN audit trail — §25 asks for platform
-- actions to be auditable, and an audit log only the database owner can read
-- is not auditable by the person who needs it. SELECT only: nobody edits an
-- audit row, and INSERT stays with the SECURITY DEFINER functions so an entry
-- cannot be forged from a console session.
GRANT SELECT ON audit.platform_access TO shikhon_platform;

-- ---------------------------------------------------------------------
-- 2. app.create_tenant — the only way a school comes into existence.
--
-- One transaction: the tenant row, its per-tenant PII key material, and the
-- audit row. If any part fails nothing is written, so a slug collision leaves
-- no half-school behind and the wizard can simply offer another slug.
--
-- The per-tenant DEK and blind-index pepper are generated HERE rather than
-- being passed in, because they must never travel through an application
-- process that could log them. `gen_random_bytes` is pgcrypto, already an
-- extension in this database since 001.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.create_tenant(
  p_actor          uuid,
  p_slug           text,
  p_name_bn        text,
  p_name_en        text,
  p_stream         institution_stream,
  p_level          institution_level,
  p_eiin           text    DEFAULT NULL,
  p_mpo_code       text    DEFAULT NULL,
  p_board_code     text    DEFAULT NULL,
  p_district       text    DEFAULT NULL,
  p_upazila        text    DEFAULT NULL,
  p_address_bn     text    DEFAULT NULL,
  p_weekend_days   smallint[] DEFAULT ARRAY[5,6]::smallint[],
  p_shifts         shift_code[] DEFAULT ARRAY['single']::shift_code[],
  p_timezone       text    DEFAULT 'Asia/Dhaka',
  p_locale         text    DEFAULT 'bn',
  p_plan_code      text    DEFAULT 'pilot',
  p_student_cap    integer DEFAULT 500,
  p_trial_ends_on  date    DEFAULT NULL,
  p_status         tenant_status DEFAULT 'trial',
  p_reason         text    DEFAULT 'R-7 onboarding wizard'
)
RETURNS TABLE (id uuid, slug citext, status tenant_status)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, app, audit
AS $$
DECLARE
  v_id uuid := gen_random_uuid();
BEGIN
  IF p_actor IS NULL THEN
    RAISE EXCEPTION 'create_tenant needs an actor: platform actions are audited'
      USING ERRCODE = '22023';
  END IF;

  INSERT INTO tenants (
    id, slug, name_bn, name_en, eiin, mpo_code, board_code,
    stream, level, district, upazila, address_bn,
    timezone, default_locale, weekend_days, shifts,
    status, plan_code, student_cap, trial_ends_on,
    dek_wrapped, dek_key_version, blind_index_pepper
  ) VALUES (
    v_id, p_slug::citext, p_name_bn, p_name_en,
    NULLIF(p_eiin, ''), NULLIF(p_mpo_code, ''), NULLIF(p_board_code, ''),
    p_stream, p_level,
    NULLIF(p_district, ''), NULLIF(p_upazila, ''), NULLIF(p_address_bn, ''),
    p_timezone, p_locale, p_weekend_days, p_shifts,
    p_status, p_plan_code, p_student_cap, p_trial_ends_on,
    -- Placeholder wrapping until a KMS lands (R-8): the bytes are real
    -- random, the WRAPPING is not yet a KMS envelope. Named here so nobody
    -- mistakes this for key management.
    gen_random_bytes(32), 1, gen_random_bytes(32)
  );

  INSERT INTO audit.platform_access (admin_id, tenant_id, reason, statement)
  VALUES (p_actor, v_id, p_reason,
          format('create_tenant slug=%s status=%s cap=%s', p_slug, p_status, p_student_cap));

  RETURN QUERY SELECT v_id, p_slug::citext, p_status;
END;
$$;

COMMENT ON FUNCTION app.create_tenant IS
  'R-7: the only path by which a tenant comes into existence. SECURITY '
  'DEFINER, granted to shikhon_platform only — the runtime role cannot create '
  'or enumerate tenants and must never be able to. Audits in the same '
  'transaction as the insert.';

-- ---------------------------------------------------------------------
-- 2b. app.log_platform_action — the only way an audit row is written.
--
-- `create_tenant` and `set_tenant_status` write their own rows as the owner,
-- but the console also does work that is not one of those: provisioning,
-- branding, creating the first admin. Those run as `shikhon_platform` in the
-- tenant's own context, and that role has SELECT on `audit.platform_access`
-- and deliberately NOT insert.
--
-- Which is the right way round. If the platform session could INSERT into the
-- audit table directly it could also forge or backdate an entry, and an audit
-- log its subject can write is not an audit log. This function is the one
-- door, it runs as the owner, and it stamps the actor from its argument
-- rather than from anything the session controls.
--
-- Found by running the wizard: the branding step failed with "permission
-- denied for table platform_access" after the tenant had already been
-- created — exactly the half-finished state §22 is about.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.log_platform_action(
  p_actor uuid, p_tenant uuid, p_reason text, p_statement text
)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, app, audit
AS $$
  INSERT INTO audit.platform_access (admin_id, tenant_id, reason, statement)
  VALUES (p_actor, p_tenant, p_reason, p_statement);
$$;

-- ---------------------------------------------------------------------
-- 3. app.platform_tenants — the console's list.
--
-- The one legitimate cross-tenant read in the product, and it is deliberately
-- narrow: identity, commercial state, and COUNTS. No student names, no
-- guardian phones, no addresses. §18 of the brief says not to put student PII
-- on the platform list, and the way to honour that is for the function not to
-- be able to return it.
--
-- This also retires the SMS worker's SMS_WORKER_TENANT_IDS environment
-- variable, which existed only because nothing could legitimately enumerate
-- tenants. That is noted rather than done here: changing the worker is R-8's
-- business and doing it in the same migration would couple them.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.platform_tenants(p_search text DEFAULT NULL)
RETURNS TABLE (
  id            uuid,
  slug          citext,
  name_bn       text,
  name_en       text,
  stream        institution_stream,
  level         institution_level,
  status        tenant_status,
  plan_code     text,
  student_cap   integer,
  student_count bigint,
  trial_ends_on date,
  created_at    timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, app
AS $$
  SELECT t.id, t.slug, t.name_bn, t.name_en, t.stream, t.level,
         t.status, t.plan_code, t.student_cap,
         (SELECT count(*) FROM student_profiles sp WHERE sp.tenant_id = t.id),
         t.trial_ends_on, t.created_at
    FROM tenants t
   WHERE t.deleted_at IS NULL
     AND (p_search IS NULL OR p_search = ''
          OR t.name_bn ILIKE '%' || p_search || '%'
          OR t.name_en ILIKE '%' || p_search || '%'
          OR t.slug::text ILIKE '%' || p_search || '%')
   ORDER BY t.created_at DESC;
$$;

-- ---------------------------------------------------------------------
-- 4. app.set_tenant_status — activate, suspend, restore.
--
-- Suspension is a commercial state and not a data operation (R-7.11): this
-- changes one column and touches nothing else. There is deliberately no
-- delete path — `archived` is how a school leaves, and a school with student
-- rows is never hard-deleted except through the PDPA erasure path.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.set_tenant_status(
  p_actor  uuid,
  p_tenant uuid,
  p_status tenant_status,
  p_reason text DEFAULT NULL
)
RETURNS tenant_status
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, app, audit
AS $$
DECLARE v_old tenant_status;
BEGIN
  IF p_actor IS NULL THEN
    RAISE EXCEPTION 'set_tenant_status needs an actor' USING ERRCODE = '22023';
  END IF;

  SELECT status INTO v_old FROM tenants WHERE id = p_tenant AND deleted_at IS NULL;
  IF v_old IS NULL THEN
    RAISE EXCEPTION 'no such tenant' USING ERRCODE = 'P0002';
  END IF;

  UPDATE tenants SET status = p_status, updated_at = now() WHERE id = p_tenant;

  INSERT INTO audit.platform_access (admin_id, tenant_id, reason, statement)
  VALUES (p_actor, p_tenant,
          COALESCE(p_reason, format('status %s → %s', v_old, p_status)),
          format('set_tenant_status %s → %s', v_old, p_status));

  RETURN v_old;
END;
$$;

-- ---------------------------------------------------------------------
-- 5. app.tenant_onboarding_state — derived, so it cannot lie.
--
-- Counts the rows that decide whether a school is usable. The two that gate
-- activation are `years` and `grading_bands`; the rest are shown so the
-- operator can see where an interrupted setup stopped.
--
-- `grading_bands` is singled out because it is the one failure that HIDES:
-- without bands, app.compute_subject_grade returns NULL and the first result
-- publication of the year fails, months after onboarding, with no obvious
-- cause. Counting it here is what lets the wizard refuse to activate.
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
    (SELECT count(DISTINCT g.guardian_id) FROM guardianships g WHERE g.tenant_id = p_tenant),
    (SELECT count(DISTINCT ur.user_id) FROM user_roles ur
      WHERE ur.tenant_id = p_tenant
        AND ur.role_code IN ('principal','school_owner','it_admin')),
    -- "Branded" means the school has been past the editor, not merely that
    -- migration 039 seeded its name. A logo is the field an operator would
    -- recognise as having done the step.
    (SELECT COALESCE(t.settings->'branding'->>'logoUrl', '') <> ''
       FROM tenants t WHERE t.id = p_tenant);
$$;

GRANT EXECUTE ON FUNCTION
  app.create_tenant(uuid, text, text, text, institution_stream, institution_level,
                    text, text, text, text, text, text, smallint[], shift_code[],
                    text, text, text, integer, date, tenant_status, text),
  app.platform_tenants(text),
  app.set_tenant_status(uuid, uuid, tenant_status, text),
  app.log_platform_action(uuid, uuid, text, text),
  app.tenant_onboarding_state(uuid)
TO shikhon_platform;

-- Belt and braces: the runtime role is explicitly denied, so a later blanket
-- GRANT ON ALL FUNCTIONS cannot quietly hand it the keys to the platform.
REVOKE ALL ON FUNCTION
  app.create_tenant(uuid, text, text, text, institution_stream, institution_level,
                    text, text, text, text, text, text, smallint[], shift_code[],
                    text, text, text, integer, date, tenant_status, text),
  app.platform_tenants(text),
  app.set_tenant_status(uuid, uuid, tenant_status, text),
  app.log_platform_action(uuid, uuid, text, text)
FROM PUBLIC, shikhon_app;

-- The onboarding state is readable by a school's OWN management too: the
-- wizard shows it, and so does the principal's setup checklist. It takes a
-- tenant id and returns only counts, so it leaks nothing an insider does not
-- already know — but it must not become an enumeration oracle, so the
-- application only ever calls it with the session's own tenant.
GRANT EXECUTE ON FUNCTION app.tenant_onboarding_state(uuid) TO shikhon_app;

-- ---------------------------------------------------------------------
-- 5b. app.provision_curriculum — the step `provision_tenant` was missing.
--
-- Found by onboarding a school and then trying to import its students:
--
--     "৯ শ্রেণির বিষয় তালিকা (টেমপ্লেট) তৈরি হয়নি — আগে সেটি তৈরি করুন"
--
-- `app.provision_tenant` seeds the academic year, terms, grading bands, bell
-- schedule, classes, `class_subjects`, fee heads and the chart of accounts —
-- everything a school needs except the one thing the STUDENT IMPORT requires.
-- F-304's `app.derive_student_subjects()` reads `subject_templates` joined to
-- `curriculum_schemes`, and nothing in the product had ever created either.
--
-- So a freshly provisioned school could not accept a single student, and the
-- pilot runbook's step 6 would have hit the same wall. R-7 is the phase that
-- promises "provision, then import", so R-7 is where it gets fixed.
--
-- ── Derived, not invented ──────────────────────────────────────────────
-- The templates are built FROM `class_subjects`, which `provision_tenant`
-- already populated from the NCTB catalogue with mark distributions. This
-- adds no curriculum knowledge of its own; it reshapes what is already there
-- into the form F-304 reads. That is why it is a separate function rather
-- than an edit to `provision_tenant`: that function is exercised by six
-- phases of tests and this can be re-run against a school that already
-- exists, which is what a school provisioned before R-7 needs.
--
-- Idempotent, like `provision_tenant`: ON CONFLICT DO NOTHING throughout, so
-- a retry after a failure is always safe.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.provision_curriculum(
  p_tenant uuid, p_year uuid DEFAULT NULL
)
RETURNS TABLE (object text, seeded integer)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, app
AS $$
DECLARE
  v_year uuid;
  v_bands jsonb;
  v_schemes integer := 0;
  v_templates integer := 0;
  v_items integer := 0;
BEGIN
  IF app.current_tenant() IS DISTINCT FROM p_tenant THEN
    RAISE EXCEPTION
      'provision_curriculum must run inside the tenant''s own context (SET LOCAL app.tenant_id = %)',
      p_tenant USING ERRCODE = '42501';
  END IF;

  SELECT COALESCE(p_year, (SELECT id FROM academic_years WHERE is_current LIMIT 1))
    INTO v_year;
  IF v_year IS NULL THEN
    RAISE EXCEPTION 'no academic year to build a curriculum for' USING ERRCODE = 'P0002';
  END IF;

  -- The scheme's grade rules are the school's OWN bands, so a school that
  -- edits its grading scale does not end up with a curriculum scheme quoting
  -- somebody else's. The CHECK requires a non-empty 'bands' array.
  SELECT jsonb_build_object('bands', COALESCE(jsonb_agg(
           jsonb_build_object('letter', gb.letter, 'gp', gb.grade_point,
                              'min', gb.min_percent, 'max', gb.max_percent)
           ORDER BY gb.min_percent DESC), '[]'::jsonb))
    INTO v_bands
    FROM grading_bands gb WHERE gb.tenant_id = p_tenant;

  IF v_bands->'bands' = '[]'::jsonb THEN
    RAISE EXCEPTION 'no grading bands — run provision_tenant first' USING ERRCODE = 'P0002';
  END IF;

  -- One scheme per stage the school actually has classes in. The stage names
  -- match `institution_level` minus 'combined', which is a tenant-level idea
  -- rather than a curriculum one.
  WITH stages AS (
    SELECT DISTINCT CASE
             WHEN c.level_no <= 5  THEN 'primary'
             WHEN c.level_no <= 8  THEN 'junior_secondary'
             WHEN c.level_no <= 10 THEN 'secondary'
             ELSE 'higher_secondary'
           END AS stage
      FROM classes c WHERE c.tenant_id = p_tenant
  ), ins AS (
    INSERT INTO curriculum_schemes
      (tenant_id, academic_year_id, stage, assessment_model, grade_rule_set, effective_from)
    SELECT p_tenant, v_year, s.stage, 'marks_cq_mcq', v_bands,
           (SELECT starts_on FROM academic_years WHERE id = v_year)
      FROM stages s
    ON CONFLICT (tenant_id, academic_year_id, stage) DO NOTHING
    RETURNING 1
  ) SELECT count(*) INTO v_schemes FROM ins;

  -- One template per class, keyed to that class's own group so a science and
  -- a humanities section of class 9 get different subject sets.
  --
  -- NOT EXISTS rather than ON CONFLICT. The unique index is
  -- (tenant, scheme, class, group_code) and `group_code` is NULL for an
  -- ungrouped class — and PostgreSQL treats NULLs as DISTINCT in a unique
  -- index unless it was declared NULLS NOT DISTINCT. So ON CONFLICT matched
  -- nothing and a second run doubled every ungrouped template: 3 became 6,
  -- caught by the idempotency assertion in db/tests/platform.sql.
  -- `IS NOT DISTINCT FROM` compares NULLs the way the intent requires.
  WITH ins AS (
    INSERT INTO subject_templates (tenant_id, curriculum_scheme_id, class_id, group_code)
    SELECT p_tenant, cs.id, c.id, g.code
      FROM classes c
      JOIN curriculum_schemes cs
        ON cs.tenant_id = p_tenant AND cs.academic_year_id = v_year
       AND cs.stage = CASE
             WHEN c.level_no <= 5  THEN 'primary'
             WHEN c.level_no <= 8  THEN 'junior_secondary'
             WHEN c.level_no <= 10 THEN 'secondary'
             ELSE 'higher_secondary' END
      CROSS JOIN LATERAL (
        SELECT CASE WHEN c."group" = 'none' THEN NULL ELSE c."group" END AS code
      ) g
     WHERE c.tenant_id = p_tenant
       AND NOT EXISTS (
         SELECT 1 FROM subject_templates st
          WHERE st.tenant_id = p_tenant
            AND st.curriculum_scheme_id = cs.id
            AND st.class_id = c.id
            AND st.group_code IS NOT DISTINCT FROM g.code)
    RETURNING 1
  ) SELECT count(*) INTO v_templates FROM ins;

  -- The subjects themselves, straight from what provision_tenant mapped.
  -- Everything is 'compulsory': the fourth-subject and religion-variant
  -- machinery is a curriculum decision a school makes on its own screen, and
  -- guessing it here would put wrong subjects on a child's record.
  -- NOT EXISTS again, and for a blunter reason: there is no unique
  -- constraint on (template, subject) at all, so ON CONFLICT DO NOTHING
  -- prevented nothing whatsoever and a re-run would have duplicated every
  -- subject on every template.
  WITH ins AS (
    INSERT INTO subject_template_items
      (tenant_id, template_id, subject_id, requirement_type, display_order)
    SELECT p_tenant, st.id, cs.subject_id, 'compulsory',
           row_number() OVER (PARTITION BY st.id ORDER BY cs.subject_id)::smallint
      FROM subject_templates st
      JOIN class_subjects cs
        ON cs.tenant_id = p_tenant AND cs.class_id = st.class_id
       AND cs.academic_year_id = v_year
     WHERE st.tenant_id = p_tenant
       AND NOT EXISTS (
         SELECT 1 FROM subject_template_items sti
          WHERE sti.template_id = st.id AND sti.subject_id = cs.subject_id)
    RETURNING 1
  ) SELECT count(*) INTO v_items FROM ins;

  RETURN QUERY
    SELECT 'curriculum_schemes', v_schemes
    UNION ALL SELECT 'subject_templates', v_templates
    UNION ALL SELECT 'subject_template_items', v_items;
END;
$$;

COMMENT ON FUNCTION app.provision_curriculum(uuid, uuid) IS
  'R-7: builds the subject templates app.derive_student_subjects needs, from '
  'the class_subjects provision_tenant already seeded. Without it a freshly '
  'provisioned school cannot import a single student.';

GRANT EXECUTE ON FUNCTION app.provision_curriculum(uuid, uuid)
  TO shikhon_app, shikhon_platform;

-- ---------------------------------------------------------------------
-- 6. student_cap enforcement.
--
-- `tenants.student_cap` was declared in migration 001 and enforced NOWHERE:
-- not on enrolment, not on import, not in any endpoint. A school on a
-- 500-student plan could import 5,000 and nothing would notice. R-7 §20 asks
-- for server-side enforcement, and the only place that catches EVERY path —
-- the import wizard, a later import, a single manual enrolment, a script — is
-- the database.
--
-- STATEMENT level, not row level. An 800-row import is one INSERT; a row
-- trigger would count the school 800 times. Statement level counts once and
-- gives the same answer, because the check is about the total.
--
-- ── On `enrolments`, and why not on `student_profiles` ─────────────────
-- The first version of this trigger was on `student_profiles`, which reads
-- like the obvious home for "how many students does this school have". It
-- would have fired never: NOTHING in the product has ever written a
-- `student_profiles` row — not the student import, not enrolment, not any
-- endpoint. The table has existed since migration 001 holding the permanent
-- `student_code`, and only test fixtures have ever put a row in it. (R-7 also
-- fixes that: the student import now creates the profile and the code, which
-- is what makes R-6's search-by-permanent-ID answer anything at all.)
--
-- `enrolments` is written by every path that adds a child to a school, so it
-- is where the cap can actually be enforced. DISTINCT active students, not
-- rows: a child re-enrolled next year is the same child, and counting rows
-- would bill a school twice for keeping a student.
--
-- The message states both numbers. "Cap exceeded" tells an operator nothing;
-- "cap 500, this would make 540" tells them whether to trim the file or raise
-- the plan.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.enforce_student_cap()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, app
AS $$
DECLARE v_tenant uuid; v_cap integer; v_now bigint;
BEGIN
  -- One statement only ever touches one tenant: `enforce_tenant` already
  -- guarantees the rows carry the session's tenant.
  SELECT tenant_id INTO v_tenant FROM new_rows LIMIT 1;
  IF v_tenant IS NULL THEN RETURN NULL; END IF;

  SELECT student_cap INTO v_cap FROM tenants WHERE id = v_tenant;
  IF v_cap IS NULL THEN RETURN NULL; END IF;

  SELECT count(DISTINCT student_id) INTO v_now
    FROM enrolments WHERE tenant_id = v_tenant AND status = 'active';

  IF v_now > v_cap THEN
    RAISE EXCEPTION
      'student cap reached: this institution is capped at % students and this would make %',
      v_cap, v_now
      USING ERRCODE = 'check_violation',
            HINT = 'Raise student_cap on the plan, or import fewer rows.';
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_student_cap ON enrolments;
CREATE TRIGGER trg_student_cap
  AFTER INSERT ON enrolments
  REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT
  EXECUTE FUNCTION app.enforce_student_cap();

COMMENT ON FUNCTION app.enforce_student_cap() IS
  'R-7 §20: student_cap was declared in migration 001 and enforced nowhere. '
  'On enrolments, because student_profiles was never written by anything. '
  'Statement-level so an 800-row import counts the school once, not 800 times.';

COMMIT;
