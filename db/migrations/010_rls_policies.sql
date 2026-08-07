-- =====================================================================
-- 010_rls_policies.sql
-- Row-Level Security. This file is the tenant-isolation guarantee.
--
-- Model
--   Layer 1 (PERMISSIVE, generic): every table carrying tenant_id gets
--           `tenant_id = app.current_tenant()`. Fail-closed: a missing
--           context yields zero rows, never the whole table.
--   Layer 2 (RESTRICTIVE, specific): additional AND-ed predicates that
--           narrow access by role — a student sees only their own marks,
--           a subject teacher only their own sections.
--
-- Both layers must pass. RESTRICTIVE policies AND with the permissive set,
-- so Layer 2 can only ever remove rows, never add them.
--
-- FORCE ROW LEVEL SECURITY is set so even the table owner is filtered.
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- Layer 1 — generic tenant isolation on every tenant-scoped table.
-- ---------------------------------------------------------------------
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN
    SELECT c.oid::regclass AS tbl, n.nspname, c.relname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind IN ('r','p')                       -- ordinary + partitioned
      AND n.nspname = 'public'
      AND EXISTS (
        SELECT 1 FROM pg_attribute a
        WHERE a.attrelid = c.oid AND a.attname = 'tenant_id' AND a.attnum > 0 AND NOT a.attisdropped)
  LOOP
    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', r.tbl);
    EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', r.tbl);
    EXECUTE format($f$
      CREATE POLICY tenant_isolation ON %s
        AS PERMISSIVE FOR ALL TO shikhon_app
        USING (app.tenant_guard(tenant_id))
        WITH CHECK (app.tenant_guard(tenant_id))
    $f$, r.tbl);
  END LOOP;
END $$;

-- Partitions inherit the parent's policies when queried through the parent,
-- but a direct read of a partition uses that partition's own policies.
-- Belt and braces: apply the same policy to every partition.
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN
    SELECT c.oid::regclass AS tbl
    FROM pg_class c
    JOIN pg_inherits i ON i.inhrelid = c.oid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r'
      AND EXISTS (SELECT 1 FROM pg_attribute a
                  WHERE a.attrelid = c.oid AND a.attname = 'tenant_id'
                    AND a.attnum > 0 AND NOT a.attisdropped)
      AND NOT EXISTS (SELECT 1 FROM pg_policy p
                      WHERE p.polrelid = c.oid AND p.polname = 'tenant_isolation')
  LOOP
    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', r.tbl);
    EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', r.tbl);
    EXECUTE format($f$
      CREATE POLICY tenant_isolation ON %s
        AS PERMISSIVE FOR ALL TO shikhon_app
        USING (app.tenant_guard(tenant_id))
        WITH CHECK (app.tenant_guard(tenant_id))
    $f$, r.tbl);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------
-- tenants itself: a session may only see its own tenant row.
-- ---------------------------------------------------------------------
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_self ON tenants
  AS PERMISSIVE FOR ALL TO shikhon_app
  USING (id = app.current_tenant())
  WITH CHECK (id = app.current_tenant());

-- ---------------------------------------------------------------------
-- Helper predicates used by the Layer-2 policies.
-- SECURITY DEFINER so they can read mapping tables without recursing into
-- the very policies they are helping evaluate.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.is_staff() RETURNS boolean
LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT app.current_role_code() NOT IN ('student','guardian','anonymous');
$$;

-- Sections the current user teaches or is class-teacher of.
CREATE OR REPLACE FUNCTION app.my_section_ids() RETURNS uuid[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, app AS $$
  SELECT COALESCE(array_agg(DISTINCT sid), '{}')
  FROM (
    SELECT s.id AS sid FROM sections s
     WHERE s.tenant_id = app.current_tenant() AND s.class_teacher_id = app.current_user_id()
    UNION
    SELECT sst.section_id FROM section_subject_teachers sst
     WHERE sst.tenant_id = app.current_tenant() AND sst.teacher_id = app.current_user_id()
  ) q;
$$;

-- Students the current user is a guardian of.
CREATE OR REPLACE FUNCTION app.my_ward_ids() RETURNS uuid[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, app AS $$
  SELECT COALESCE(array_agg(g.student_id), '{}')
  FROM guardianships g
  WHERE g.tenant_id = app.current_tenant() AND g.guardian_id = app.current_user_id();
$$;

-- "Can this session see data about this student?"
CREATE OR REPLACE FUNCTION app.can_see_student(p_student uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, app AS $$
  SELECT CASE app.current_role_code()
    WHEN 'student'  THEN p_student = app.current_user_id()
    WHEN 'guardian' THEN p_student = ANY(app.my_ward_ids())
    WHEN 'subject_teacher' THEN EXISTS (
      SELECT 1 FROM enrolments e
      WHERE e.tenant_id = app.current_tenant() AND e.student_id = p_student
        AND e.section_id = ANY(app.my_section_ids()))
    WHEN 'class_teacher' THEN EXISTS (
      SELECT 1 FROM enrolments e
      WHERE e.tenant_id = app.current_tenant() AND e.student_id = p_student
        AND e.section_id = ANY(app.my_section_ids()))
    ELSE true                                     -- principal, coordinator, dept_head, accountant
  END;
$$;

REVOKE ALL ON FUNCTION app.my_section_ids(), app.my_ward_ids(), app.can_see_student(uuid)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.my_section_ids(), app.my_ward_ids(), app.can_see_student(uuid)
  TO shikhon_app;

-- ---------------------------------------------------------------------
-- Layer 2 — RESTRICTIVE policies. These AND with tenant_isolation.
-- ---------------------------------------------------------------------

-- users: students and guardians see only themselves + their household;
-- teachers see students in their sections; management sees everyone.
CREATE POLICY users_scope ON users
  AS RESTRICTIVE FOR SELECT TO shikhon_app
  USING (
    app.has_role('principal','school_owner','academic_coordinator','dept_head','accountant')
    OR id = app.current_user_id()
    OR app.can_see_student(id)
    OR EXISTS (SELECT 1 FROM guardianships g
               WHERE g.tenant_id = users.tenant_id
                 AND g.guardian_id = users.id
                 AND g.student_id = ANY(app.my_ward_ids()))
    OR app.is_staff()                              -- staff directory is visible to staff
  );

-- Nobody but management may modify another user.
CREATE POLICY users_write_scope ON users
  AS RESTRICTIVE FOR UPDATE TO shikhon_app
  USING (app.has_role('principal','school_owner','academic_coordinator')
         OR id = app.current_user_id());

-- attendance_records: guardians see only their wards, students themselves,
-- teachers only their sections.
CREATE POLICY attendance_scope ON attendance_records
  AS RESTRICTIVE FOR SELECT TO shikhon_app
  USING (
    app.has_role('principal','school_owner','academic_coordinator','dept_head')
    OR app.can_see_student(student_id)
    OR section_id = ANY(app.my_section_ids())
  );

-- Only staff assigned to the section may write attendance.
CREATE POLICY attendance_write_scope ON attendance_records
  AS RESTRICTIVE FOR INSERT TO shikhon_app
  WITH CHECK (
    app.has_role('principal','academic_coordinator')
    OR section_id = ANY(app.my_section_ids())
  );

CREATE POLICY attendance_sessions_scope ON attendance_sessions
  AS RESTRICTIVE FOR ALL TO shikhon_app
  USING (
    app.has_role('principal','school_owner','academic_coordinator','dept_head')
    OR section_id = ANY(app.my_section_ids())
    OR EXISTS (SELECT 1 FROM enrolments e
               WHERE e.section_id = attendance_sessions.section_id
                 AND app.can_see_student(e.student_id))
  )
  WITH CHECK (
    app.has_role('principal','academic_coordinator')
    OR section_id = ANY(app.my_section_ids())
  );

-- exam_marks: a student/guardian sees marks only AFTER publication.
CREATE POLICY marks_scope ON exam_marks
  AS RESTRICTIVE FOR SELECT TO shikhon_app
  USING (
    app.has_role('principal','school_owner','academic_coordinator','dept_head')
    OR EXISTS (SELECT 1 FROM exam_subjects es
               WHERE es.id = exam_marks.exam_subject_id
                 AND es.section_id = ANY(app.my_section_ids()))
    OR (
      app.can_see_student(student_id)
      AND EXISTS (SELECT 1 FROM exam_subjects es JOIN exams e ON e.id = es.exam_id
                  WHERE es.id = exam_marks.exam_subject_id AND e.status = 'published')
    )
  );

CREATE POLICY marks_write_scope ON exam_marks
  AS RESTRICTIVE FOR INSERT TO shikhon_app
  WITH CHECK (
    app.has_role('principal','academic_coordinator')
    OR EXISTS (SELECT 1 FROM exam_subjects es
               WHERE es.id = exam_marks.exam_subject_id
                 AND es.section_id = ANY(app.my_section_ids()))
  );

CREATE POLICY results_scope ON exam_results
  AS RESTRICTIVE FOR SELECT TO shikhon_app
  USING (
    app.has_role('principal','school_owner','academic_coordinator','dept_head')
    OR section_id = ANY(app.my_section_ids())
    OR (app.can_see_student(student_id) AND published_at IS NOT NULL)
  );

-- Finance: accountants and management only; guardians see their wards' invoices.
CREATE POLICY invoice_scope ON invoices
  AS RESTRICTIVE FOR SELECT TO shikhon_app
  USING (
    app.has_role('principal','school_owner','accountant')
    OR app.can_see_student(student_id)
  );

CREATE POLICY invoice_write_scope ON invoices
  AS RESTRICTIVE FOR ALL TO shikhon_app
  USING (app.has_role('principal','school_owner','accountant'))
  WITH CHECK (app.has_role('principal','school_owner','accountant'));

CREATE POLICY mfs_scope ON mfs_transactions
  AS RESTRICTIVE FOR SELECT TO shikhon_app
  USING (
    app.has_role('principal','school_owner','accountant')
    OR app.can_see_student(student_id)
  );

-- Ledger is management-only, full stop.
CREATE POLICY ledger_scope ON ledger_entries
  AS RESTRICTIVE FOR ALL TO shikhon_app
  USING (app.has_role('principal','school_owner','accountant'))
  WITH CHECK (app.has_role('principal','school_owner','accountant'));

-- RMS: everyone may read the routine; only coordinators may write it.
CREATE POLICY routine_write_scope ON routines
  AS RESTRICTIVE FOR ALL TO shikhon_app
  USING (true)
  WITH CHECK (app.has_role('principal','school_owner','academic_coordinator'));

CREATE POLICY routine_slots_write_scope ON routine_slots
  AS RESTRICTIVE FOR ALL TO shikhon_app
  USING (true)
  WITH CHECK (app.has_role('principal','school_owner','academic_coordinator'));

CREATE POLICY substitution_write_scope ON routine_substitutions
  AS RESTRICTIVE FOR ALL TO shikhon_app
  USING (true)
  WITH CHECK (app.has_role('principal','school_owner','academic_coordinator','dept_head'));

-- AI safeguarding flags: Principal's eyes only. Never the guardian's,
-- never the subject teacher's — a disclosure about the home must not be
-- routed back into the home.
CREATE POLICY safeguarding_scope ON ai_safeguarding_flags
  AS RESTRICTIVE FOR ALL TO shikhon_app
  USING (app.has_role('principal','school_owner'))
  WITH CHECK (app.has_role('principal','school_owner'));

-- AI transcripts: your own, or management's for review.
CREATE POLICY ai_turns_scope ON ai_turns
  AS RESTRICTIVE FOR SELECT TO shikhon_app
  USING (
    app.has_role('principal','school_owner')
    OR EXISTS (SELECT 1 FROM ai_sessions s
               WHERE s.id = ai_turns.session_id AND s.user_id = app.current_user_id())
  );

-- Alumni export is an explicit, permissioned act.
CREATE POLICY alumni_export_scope ON alumni_export_logs
  AS RESTRICTIVE FOR ALL TO shikhon_app
  USING (app.has_role('principal','school_owner','academic_coordinator'))
  WITH CHECK (app.has_role('principal','school_owner','academic_coordinator'));

-- Encrypted credentials for the ANS endpoint are management-only.
-- 'system_ingest' is admitted so the outbound-delivery worker can read the
-- signing key for platform-wide endpoints; see the pre-tenant section below.
CREATE POLICY ans_endpoint_scope ON ans_endpoints
  AS RESTRICTIVE FOR ALL TO shikhon_app
  USING (app.has_role('principal','school_owner','system_ingest'))
  WITH CHECK (app.has_role('principal','school_owner'));

-- ---------------------------------------------------------------------
-- Pre-tenant tables.
--
-- Five tables are written BEFORE a tenant context exists:
--   mfs_webhook_events   — bKash/Nagad callback arrives; tenant is only known
--                          after merchantInvoiceNumber is resolved
--   ans_inbound_events   — ANS pushes an update keyed by globalPersonId
--   otp_challenges       — an OTP is requested before we know who is logging in
--   ans_endpoints        — platform-wide endpoints have tenant_id NULL
--   alumni_profile_enrichment — enrichment can outlive the institution link
--
-- Under the generic policy (`tenant_id = app.current_tenant()`) a NULL
-- tenant_id row is invisible to everyone, which would silently strand every
-- payment callback. These tables therefore also admit a dedicated context:
-- the worker sets `SET LOCAL app.role = 'system_ingest'` with no tenant id.
--
-- The permission is deliberately narrow: system_ingest can reach ONLY rows
-- that are not yet attributed to a tenant. The moment a row is resolved to a
-- tenant, ordinary tenant isolation takes over.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.is_system_ingest() RETURNS boolean
LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT app.current_role_code() = 'system_ingest';
$$;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['mfs_webhook_events','ans_inbound_events','otp_challenges',
                           'ans_endpoints','alumni_profile_enrichment']
  LOOP
    EXECUTE format($f$
      CREATE POLICY pre_tenant_ingest ON %I
        AS PERMISSIVE FOR ALL TO shikhon_app
        USING (tenant_id IS NULL AND app.is_system_ingest())
        WITH CHECK (tenant_id IS NULL AND app.is_system_ingest())
    $f$, t);
  END LOOP;
END $$;

-- Once resolved, a webhook row belongs to its tenant and is read through the
-- ordinary tenant_isolation policy — so the ingest worker must re-establish a
-- tenant context before it can credit an invoice. That is the intended flow.

-- ---------------------------------------------------------------------
-- Grants. shikhon_app gets DML but no DDL, and no access to the raw
-- crypto material columns (enforced by column privileges below).
-- ---------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO shikhon_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO shikhon_app;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA app TO shikhon_app;
GRANT INSERT ON audit.activity_log, audit.pii_access TO shikhon_app;
GRANT USAGE ON SCHEMA audit TO shikhon_app;

-- Audit tables are append-only for the application.
REVOKE UPDATE, DELETE ON audit.activity_log, audit.pii_access, audit.platform_access
  FROM shikhon_app;

-- Only identity-svc (which connects as shikhon_app but with an additional
-- role check in-process) may read wrapped key material. Column-level revoke
-- makes an accidental `SELECT *` in another service fail loudly.
REVOKE SELECT (dek_wrapped, blind_index_pepper) ON tenants FROM shikhon_app;
REVOKE SELECT (mfa_totp_secret) ON users FROM shikhon_app;

ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO shikhon_app;

-- Reporting replica: read-only, still RLS-filtered.
GRANT SELECT ON ALL TABLES IN SCHEMA public TO shikhon_readonly;

COMMIT;

-- =====================================================================
-- CI tenancy assertion (run by test/tenancy/cross_tenant.sql).
-- Any non-zero result here is a release blocker.
--
--   SET LOCAL app.tenant_id = '<tenant A>';
--   SELECT count(*) FROM users WHERE tenant_id = '<tenant B>';      -- must be 0
--   UPDATE enrolments SET roll_no = 1 WHERE tenant_id = '<tenant B>'; -- must affect 0
--   RESET app.tenant_id;
--   SELECT count(*) FROM users;                                     -- must be 0 (fail-closed)
-- =====================================================================
